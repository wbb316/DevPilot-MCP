import { promises as fs } from 'node:fs';
import path from 'node:path';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';

import { ServerContext } from '../../src/server/context';
import { invokeTool } from '../../src/server/tool-registry';
import { silentLogger } from '../../src/log/logger';
import { defaultConfig } from '../../src/config/config-schema';
import { openWorkspaceTool } from '../../src/tools/open-workspace';
import { closeWorkspaceTool } from '../../src/tools/close-workspace';
import { reviewDiffTool } from '../../src/tools/review-diff';
import { gitInit, makeTempDir, removeDir, writeFiles } from '../helpers/index';

/**
 * Post-V1 gate: the change budget must govern the agent's change set, not the user's working tree.
 *
 * Found on a real project: a one-line edit in a repository that already had 72 uncommitted paths was
 * reported as `risk HIGH` with "change budget exceeded (72 > 20; 5195 > 3000)" — the agent is blamed
 * for work that existed before it opened the workspace, which cheapens the warning into noise.
 */

interface Envelope<T> {
  success: boolean;
  summary?: string;
  data?: T;
  warnings?: string[];
  error?: { code: string; message: string };
}

function envelopeOf<T>(result: CallToolResult): Envelope<T> {
  return result.structuredContent as unknown as Envelope<T>;
}

interface DiffData {
  totals: { files: number; addedLines: number; deletedLines: number };
  preExistingChanges: string[];
  changeLimits: {
    exceeded: boolean;
    counted: { files: number; addedLines: number; deletedLines: number };
    excludedPreExisting: number;
    violations: { limit: string }[];
    advice?: string;
  };
}

describe('change budget scope through the registry', () => {
  let context: ServerContext;
  let home: string;
  let workspace: string;
  let gitAvailable = false;

  beforeAll(async () => {
    home = await makeTempDir('devpilot-budget-home-');
    workspace = await makeTempDir('devpilot-budget-ws-');
    context = await ServerContext.create({ home, logger: silentLogger() });

    // A tiny budget so the scenario fits in a handful of files.
    const config = defaultConfig();
    config.security.max_files_changed = 2;
    config.security.max_lines_changed = 10_000;

    await writeFiles(workspace, {
      '.gitignore': '.devpilot/\n',
      '.devpilot/config.yml': `${JSON.stringify(config, null, 2)}\n`,
      'src/app.py': 'def run(x):\n    return x + 1\n',
      'a.txt': 'a\n',
      'b.txt': 'b\n',
      'c.txt': 'c\n',
      'd.txt': 'd\n',
      'e.txt': 'e\n',
      'f.txt': 'f\n',
    });
    const init = await gitInit(workspace);
    gitAvailable = init.available && init.committed;
  }, 60_000);

  afterAll(async () => {
    await context.dispose();
    await removeDir(home);
    await removeDir(workspace);
  });

  it('charges only the agent change set, and still bites when the agent over-changes', async () => {
    if (!gitAvailable) return;

    // Three files are dirty *before* the workspace is opened: the user's own work.
    for (const name of ['a.txt', 'b.txt', 'c.txt']) {
      await fs.writeFile(path.join(workspace, name), `${name} changed before open\n`, 'utf8');
    }
    const opened = await invokeTool(context, openWorkspaceTool, { path: workspace });
    expect(opened.isError).toBe(false);

    const clean = envelopeOf<DiffData>(await invokeTool(context, reviewDiffTool, {}));
    expect(clean.success).toBe(true);
    expect(clean.data?.totals.files).toBe(3);
    expect([...(clean.data?.preExistingChanges ?? [])].sort()).toEqual(['a.txt', 'b.txt', 'c.txt']);
    expect(clean.data?.changeLimits.counted.files).toBe(0);
    expect(clean.data?.changeLimits.excludedPreExisting).toBe(3);
    expect(clean.data?.changeLimits.exceeded).toBe(false);
    expect(clean.data?.changeLimits.advice).toBeUndefined();
    expect(clean.summary ?? '').toContain('3 pre-existing path(s) not counted');
    expect((clean.warnings ?? []).join(' ')).toContain('pre-date this session');

    // The agent edits one clean file: one file against a budget of two.
    await fs.writeFile(path.join(workspace, 'd.txt'), 'd changed by the agent\n', 'utf8');
    const one = envelopeOf<DiffData>(await invokeTool(context, reviewDiffTool, {}));
    expect(one.data?.changeLimits.counted.files).toBe(1);
    expect(one.data?.changeLimits.excludedPreExisting).toBe(3);
    expect(one.data?.changeLimits.exceeded).toBe(false);

    // Now the agent really over-changes: four of its own files (d.txt from the step above, plus
    // e.txt, f.txt and src/app.py) against a budget of two — and still only the agent's four count.
    await fs.writeFile(path.join(workspace, 'e.txt'), 'e changed by the agent\n', 'utf8');
    await fs.writeFile(path.join(workspace, 'f.txt'), 'f changed by the agent\n', 'utf8');
    await fs.writeFile(path.join(workspace, 'src', 'app.py'), 'def run(x):\n    return x + 2\n', 'utf8');
    const many = envelopeOf<DiffData>(await invokeTool(context, reviewDiffTool, {}));
    expect(many.data?.changeLimits.counted.files).toBe(4);
    expect(many.data?.changeLimits.excludedPreExisting).toBe(3);
    expect(many.data?.changeLimits.exceeded).toBe(true);
    expect(many.data?.changeLimits.violations.map((violation) => violation.limit)).toContain(
      'max_files_changed',
    );
    expect((many.warnings ?? []).join(' ')).toContain('stage the work');
  }, 60_000);
});
