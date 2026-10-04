import { promises as fs } from 'node:fs';
import path from 'node:path';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';

import { ServerContext } from '../../src/server/context';
import { invokeTool } from '../../src/server/tool-registry';
import { silentLogger } from '../../src/log/logger';
import { defaultConfig } from '../../src/config/config-schema';
import { REDACTED } from '../../src/security/redact';
import { closeWorkspaceTool } from '../../src/tools/close-workspace';
import { diagnoseFailureTool } from '../../src/tools/diagnose-failure';
import { impactAnalysisTool } from '../../src/tools/impact-analysis';
import { openWorkspaceTool } from '../../src/tools/open-workspace';
import { reviewDiffTool } from '../../src/tools/review-diff';
import { runProjectTool } from '../../src/tools/run-project';
import { gitInit, makeTempDir, removeDir, writeFiles } from '../helpers/index';

/**
 * Phase 9 gate: the attack fixtures. Each of these is an attempt an agent (or a prompt injection in
 * a repository) could make; each one must be refused or sanitised, and the assertion is always about
 * the observable outcome, never about which internal function was called.
 */

interface Envelope<T> {
  success: boolean;
  summary?: string;
  data?: T;
  error?: { code: string; message: string; details?: unknown; hint?: string };
  warnings?: string[];
}

function envelopeOf<T>(result: CallToolResult): Envelope<T> {
  return result.structuredContent as unknown as Envelope<T>;
}

function asText(result: CallToolResult): string {
  return JSON.stringify(result);
}

const TRAVERSAL_SECRET = 'traversal-secret-8f2a1c';
const ENV_SECRET = 'env-only-secret-4d7b9e';
const LOG_SECRET = 'log-secret-1a2b3c4d';

describe('Phase 9 attack fixtures', () => {
  let context: ServerContext;
  let home: string;
  let workspace: string;
  let outside: string;
  let linked = false;

  beforeAll(async () => {
    home = await makeTempDir('devpilot-attack-home-');
    workspace = await makeTempDir('devpilot-attack-ws-');
    outside = await makeTempDir('devpilot-attack-outside-');
    await fs.writeFile(path.join(outside, 'secret.log'), `TRAVERSAL ${TRAVERSAL_SECRET}\n`, 'utf8');

    const config = defaultConfig();
    config.security.max_files_changed = 1;

    await writeFiles(workspace, {
      '.gitignore': '.devpilot/\n.env\nlink/\n',
      '.devpilot/config.yml': `${JSON.stringify(config, null, 2)}\n`,
      'src/app.py': 'def greet(name):\n    return f"hello {name}"\n',
      'notes.txt': 'line one\n',
      'build.log': `Traceback (most recent call last): DB_PASSWORD=${LOG_SECRET}\n  File "src/app.py", line 2\nValueError: boom\n`,
      '.env': `DB_PASSWORD=${ENV_SECRET}\n`,
    });
    await gitInit(workspace);

    // A directory junction is the portable Windows way to make a path inside the workspace resolve
    // to a directory outside it. Junctions do not need the symlink privilege.
    try {
      await fs.symlink(outside, path.join(workspace, 'link'), 'junction');
      linked = true;
    } catch {
      linked = false;
    }

    context = await ServerContext.create({ home, logger: silentLogger() });
    const opened = await invokeTool(context, openWorkspaceTool, { path: workspace });
    expect(envelopeOf(opened).success, asText(opened)).toBe(true);
  }, 60_000);

  afterAll(async () => {
    await invokeTool(context, closeWorkspaceTool, {});
    await removeDir(home);
    await removeDir(workspace);
    await removeDir(outside);
  });

  it('refuses to read a log outside the workspace (path traversal)', async () => {
    const result = await invokeTool(context, diagnoseFailureTool, { logFile: '../../outside/secret.log' });
    const envelope = envelopeOf<{ logFile?: string }>(result);
    expect(asText(result)).not.toContain(TRAVERSAL_SECRET);
    if (envelope.success) {
      expect(envelope.data?.logFile ?? '').not.toContain('..');
    } else {
      expect(['PATH_OUTSIDE_WORKSPACE', 'FILE_NOT_FOUND', 'INVALID_ARGUMENT']).toContain(envelope.error?.code);
    }
  });

  it('refuses to follow a junction that escapes the workspace', async () => {
    if (!linked) return; // no junction support: the traversal case above still covers the policy
    const result = await invokeTool(context, diagnoseFailureTool, { logFile: 'link/secret.log' });
    expect(asText(result)).not.toContain(TRAVERSAL_SECRET);
    const envelope = envelopeOf(result);
    if (envelope.success) {
      expect(envelopeOf<{ logFile?: string }>(result).data?.logFile ?? '').not.toContain('link/');
    }
  });

  it('rejects dangerous commands instead of running them', async () => {
    for (const command of ['format C: /y', 'diskpart', 'rm -rf /']) {
      const result = await invokeTool(context, runProjectTool, { command });
      const envelope = envelopeOf(result);
      expect(envelope.success, `${command} was allowed`).toBe(false);
      expect(envelope.error?.code, command).toBe('COMMAND_NOT_ALLOWED');
    }
  });

  it('never returns the contents of a secret-bearing file, only that it exists', async () => {
    const result = await invokeTool(context, diagnoseFailureTool, { logFile: '.env' });
    const envelope = envelopeOf<{ evidence: string[] }>(result);
    expect(envelope.success, asText(result)).toBe(true);
    expect(asText(result)).not.toContain(ENV_SECRET);
    expect(envelope.warnings?.join(' ') ?? '').toContain('sensitive file');
    expect(envelope.data?.evidence ?? []).toEqual([]);
  });

  it('redacts secrets that appear inside an ordinary log', async () => {
    const result = await invokeTool(context, diagnoseFailureTool, { logFile: 'build.log' });
    const envelope = envelopeOf<{ evidence: string[] }>(result);
    expect(envelope.success, asText(result)).toBe(true);
    expect(asText(result)).not.toContain(LOG_SECRET);
    expect(envelope.warnings?.join(' ') ?? '').toContain('redacted');
    // The line did reach the output — that is exactly why it had to be sanitised.
    expect((envelope.data?.evidence ?? []).join('\n')).toContain(REDACTED);
  });

  it('keeps a traversal-looking symbol target inside the workspace', async () => {
    const result = await invokeTool(context, impactAnalysisTool, { target: '../../outside' });
    const envelope = envelopeOf<{ affectedFiles: { path: string }[] }>(result);
    expect(envelope.success).toBe(true);
    for (const file of envelope.data?.affectedFiles ?? []) {
      expect(file.path.includes('..')).toBe(false);
      expect(path.isAbsolute(file.path)).toBe(false);
    }
    expect(asText(result)).not.toContain(TRAVERSAL_SECRET);
  });

  it('flags a change set that exceeds the configured budget', async () => {
    await writeFiles(workspace, {
      'src/app.py': 'def greet(name):\n    return f"hello {name}!"\n',
      'notes.txt': 'line one\nline two\n',
    });
    const result = await invokeTool(context, reviewDiffTool, {});
    const envelope = envelopeOf<{
      changeLimits: { exceeded: boolean; violations: { limit: string }[]; advice?: string };
    }>(result);
    expect(envelope.success, asText(result)).toBe(true);
    expect(envelope.data?.changeLimits.exceeded).toBe(true);
    expect(envelope.data?.changeLimits.violations.map((violation) => violation.limit)).toContain(
      'max_files_changed',
    );
    expect(envelope.warnings?.join(' ') ?? '').toContain('stage the work');
  });
});
