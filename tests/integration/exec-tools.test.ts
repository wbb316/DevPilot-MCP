import { promises as fs } from 'node:fs';
import path from 'node:path';

import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { silentLogger } from '../../src/log/logger.js';
import { runProcess } from '../../src/runner/process-runner.js';
import { ServerContext } from '../../src/server/context.js';
import { invokeTool } from '../../src/server/tool-registry.js';
import { buildProjectTool } from '../../src/tools/build-project.js';
import { openWorkspaceTool } from '../../src/tools/open-workspace.js';
import { runProjectTool } from '../../src/tools/run-project.js';
import type { ToolEnvelope } from '../../src/types/errors.js';
import { makeTempDir, removeDir, writeFiles } from '../helpers/index.js';

/**
 * Phase 4 gate: the build/run tools must work against a real project on this machine —
 * through the MCP tool path, with the command policy and the job ledger in the loop.
 * Everything happens in throwaway temp workspaces; python is probed first and the exec
 * cases skip (not fail) when it is missing.
 */

function envelopeOf<T>(result: CallToolResult): ToolEnvelope<T> {
  return result.structuredContent as unknown as ToolEnvelope<T>;
}

interface ExecData {
  status: string;
  command: string;
  durationMs: number;
  errors: { path?: string; line?: number; message: string }[];
  warnings: { message: string }[];
  job: { jobId: string; exitCode: number | null; logFile: string; timedOut: boolean };
  stdoutTail?: string[];
  stderrTail?: string[];
  logFile?: string;
}

let home: string;
let context: ServerContext;
let pythonAvailable = false;
const workspaces: string[] = [];

async function newWorkspace(files: Record<string, string>, options: { permission?: string } = {}): Promise<string> {
  const dir = await makeTempDir('devpilot-exec-');
  workspaces.push(dir);
  await writeFiles(dir, files);
  const result = await invokeTool(context, openWorkspaceTool, {
    path: dir,
    ...(options.permission === undefined ? {} : { permission: options.permission }),
  });
  const envelope = envelopeOf(result);
  expect(envelope.success, JSON.stringify(envelope)).toBe(true);
  return dir;
}

beforeAll(async () => {
  home = await makeTempDir('devpilot-exec-home-');
  context = await ServerContext.create({ home, logger: silentLogger() });
  const probe = await runProcess({ command: 'python', args: ['--version'], cwd: home, timeoutMs: 30_000 });
  pythonAvailable = probe.exitCode === 0;
});

afterAll(async () => {
  await context.dispose();
  for (const dir of workspaces) await removeDir(dir);
  await removeDir(home);
});

describe('build_project', () => {
  it('builds a clean python workspace and writes a job log', async () => {
    if (!pythonAvailable) return;
    const dir = await newWorkspace({ 'hello.py': 'print("hello-from-devpilot")\n' });

    const result = await invokeTool(context, buildProjectTool, { path: dir, target: 'compile' });
    const envelope = envelopeOf<ExecData>(result);

    expect(envelope.success, JSON.stringify(envelope)).toBe(true);
    const data = envelope.data as ExecData;
    expect(data.status).toBe('success');
    expect(data.job.exitCode).toBe(0);
    const log = await fs.readFile(data.job.logFile, 'utf8');
    expect(log).toContain('compileall');
    expect(log).toContain('--- stdout ---');
  });

  it('reports BUILD_FAILED with structured errors instead of raw logs', async () => {
    if (!pythonAvailable) return;
    const dir = await newWorkspace({ 'broken.py': 'def broken(:\n    pass\n' });

    const result = await invokeTool(context, buildProjectTool, { path: dir, target: 'compile' });
    const envelope = envelopeOf<ExecData>(result);

    expect(envelope.success).toBe(false);
    if (envelope.success) return;
    expect(envelope.error.code).toBe('BUILD_FAILED');
    const details = envelope.error.details as ExecData;
    expect(details.status).toBe('failed');
    expect(details.errors.length).toBeGreaterThan(0);
    expect(details.errors.some((issue) => (issue.path ?? '').includes('broken.py'))).toBe(true);
    expect(details.errors.some((issue) => issue.message.includes('SyntaxError'))).toBe(true);
    await expect(fs.access(details.job.logFile)).resolves.toBeUndefined();
  });

  it('refuses EXECUTE tools when the session is read-only', async () => {
    const dir = await newWorkspace({ 'hello.py': 'print("hi")\n' }, { permission: 'READ_ONLY' });

    const result = await invokeTool(context, buildProjectTool, { path: dir, target: 'compile' });
    const envelope = envelopeOf(result);

    expect(envelope.success).toBe(false);
    if (envelope.success) return;
    expect(envelope.error.code).toBe('PERMISSION_DENIED');
  });
});

describe('run_project', () => {
  it('runs an explicit command and returns the tail of stdout', async () => {
    if (!pythonAvailable) return;
    const dir = await newWorkspace({ 'hello.py': 'print("hello-from-devpilot")\n' });

    const result = await invokeTool(context, runProjectTool, {
      path: dir,
      command: 'python',
      args: ['hello.py'],
    });
    const envelope = envelopeOf<ExecData>(result);

    expect(envelope.success, JSON.stringify(envelope)).toBe(true);
    const data = envelope.data as ExecData;
    expect(data.status).toBe('success');
    expect(data.stdoutTail?.join('\n')).toContain('hello-from-devpilot');
    expect(data.logFile).toBeDefined();
  });

  it('terminates a long-running command with COMMAND_TIMEOUT and keeps the output', async () => {
    if (!pythonAvailable) return;
    const dir = await newWorkspace({ 'sleeper.py': 'import time\nprint("starting")\ntime.sleep(30)\n' });

    const started = Date.now();
    const result = await invokeTool(context, runProjectTool, {
      path: dir,
      command: 'python',
      args: ['sleeper.py'],
      timeoutSeconds: 1,
    });
    const envelope = envelopeOf<ExecData>(result);

    expect(Date.now() - started).toBeLessThan(20_000);
    expect(envelope.success).toBe(false);
    if (envelope.success) return;
    expect(envelope.error.code).toBe('COMMAND_TIMEOUT');
    const details = envelope.error.details as { result: ExecData };
    expect(details.result.status).toBe('timeout');
    expect(details.result.stdoutTail?.join('\n')).toContain('starting');
  });

  it('rejects a command the policy forbids', async () => {
    const dir = await newWorkspace({ 'hello.py': 'print("hi")\n' });

    const result = await invokeTool(context, runProjectTool, {
      path: dir,
      command: 'shutdown',
      args: ['/s'],
    });
    const envelope = envelopeOf(result);

    expect(envelope.success).toBe(false);
    if (envelope.success) return;
    expect(envelope.error.code).toBe('COMMAND_NOT_ALLOWED');
  });

  it('keeps the job ledger readable for later phases', async () => {
    if (!pythonAvailable) return;
    const dir = await newWorkspace({ 'hello.py': 'print("ledger")\n' });
    await invokeTool(context, runProjectTool, { path: dir, command: 'python', args: ['hello.py'] });

    const ledger = path.join(dir, '.devpilot', 'logs', 'jobs.jsonl');
    const text = await fs.readFile(ledger, 'utf8');
    const jobs = text
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line) as { jobId: string; kind: string });
    expect(jobs.some((job) => job.kind === 'run')).toBe(true);
  });
});
