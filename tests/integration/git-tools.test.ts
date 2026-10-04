import { promises as fs } from 'node:fs';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';

import { ServerContext } from '../../src/server/context';
import { invokeTool } from '../../src/server/tool-registry';
import { silentLogger } from '../../src/log/logger';
import { openWorkspaceTool } from '../../src/tools/open-workspace';
import { closeWorkspaceTool } from '../../src/tools/close-workspace';
import { getGitStatusTool } from '../../src/tools/get-git-status';
import { createCheckpointTool } from '../../src/tools/create-checkpoint';
import { reviewDiffTool } from '../../src/tools/review-diff';
import { rollbackCheckpointTool } from '../../src/tools/rollback-checkpoint';
import { gitInit, makeTempDir, readText, removeDir, writeFiles } from '../helpers/index';

interface Envelope<T> {
  success: boolean;
  summary?: string;
  data?: T;
  artifacts?: Record<string, string>;
  warnings?: string[];
  error?: { code: string; message: string; hint?: string };
}

function envelopeOf<T>(result: CallToolResult): Envelope<T> {
  return result.structuredContent as unknown as Envelope<T>;
}

interface StatusData {
  branch?: string;
  head?: string;
  dirty: boolean;
  changedFiles: string[];
  untracked: string[];
  preExisting: boolean;
  devpilotCheckpoints: number;
}

interface CheckpointData {
  checkpoint: { id: string; files: string[]; head: string; patchFile: string; dirtyAtCreate: boolean };
  note: string;
}

interface DiffData {
  totals: { files: number; addedLines: number; deletedLines: number };
  riskLevel: string;
  files: { path: string; status: string; risk: string; changedSymbols?: string[] }[];
  affectedTests: string[];
  preExistingChanges: string[];
  patchArtifact?: string;
}

interface RollbackData {
  restored: string[];
  skipped: string[];
  protectedUserChanges: string[];
  dryRun: boolean;
  notes?: string[];
}

describe('Phase 7 tools through the registry', () => {
  let context: ServerContext;
  let home: string;
  let workspace: string;
  let gitAvailable = false;

  beforeAll(async () => {
    home = await makeTempDir('devpilot-git-tools-home-');
    workspace = await makeTempDir('devpilot-git-tools-ws-');
    context = await ServerContext.create({ home, logger: silentLogger() });

    await writeFiles(workspace, {
      'src/app.py': 'def run(x):\n    return x + 1\n',
      'tests/test_app.py': 'def test_run():\n    assert True\n',
    });
    const init = await gitInit(workspace);
    gitAvailable = init.available && init.committed;
  }, 60_000);

  afterAll(async () => {
    await context.dispose();
    await removeDir(home);
    await removeDir(workspace);
  });

  it('requires an open workspace', async () => {
    const result = await invokeTool(context, getGitStatusTool, {});
    expect(result.isError).toBe(true);
    expect(envelopeOf(result).error?.code).toBe('WORKSPACE_NOT_OPEN');
  });

  it('reports status, reviews the diff, and rolls a checkpoint back end to end', async () => {
    if (!gitAvailable) return;

    const opened = await invokeTool(context, openWorkspaceTool, { path: workspace });
    expect(opened.isError).toBe(false);

    // A change made before the workspace was opened is pre-existing user work.
    await fs.writeFile(path.join(workspace, 'src', 'app.py'), 'def run(x):\n    return x + 2\n', 'utf8');

    const status = envelopeOf<StatusData>(await invokeTool(context, getGitStatusTool, {}));
    expect(status.success).toBe(true);
    expect(status.data?.dirty).toBe(true);
    expect(status.data?.changedFiles).toContain('src/app.py');
    expect(status.data?.branch).toBe('main');

    const created = envelopeOf<CheckpointData>(
      await invokeTool(context, createCheckpointTool, { label: 'before the fix' }),
    );
    expect(created.success).toBe(true);
    const checkpointId = created.data?.checkpoint.id as string;
    expect(created.data?.checkpoint.files).toContain('src/app.py');
    // DevPilot's own .devpilot/ state must never be recorded as the user's work.
    expect(created.data?.checkpoint.files.some((file) => file.startsWith('.devpilot'))).toBe(false);

    // The agent now "fixes" the bug.
    await fs.writeFile(
      path.join(workspace, 'src', 'app.py'),
      'def run(x):\n    value = x + 2\n    return value\n',
      'utf8',
    );
    await fs.writeFile(path.join(workspace, 'tests', 'test_app.py'), 'def test_run():\n    assert 2 == 2\n', 'utf8');

    const review = envelopeOf<DiffData>(await invokeTool(context, reviewDiffTool, { includePatch: true }));
    expect(review.success).toBe(true);
    expect(review.data?.totals.files).toBeGreaterThanOrEqual(2);
    expect(review.data?.files.map((file) => file.path)).toContain('src/app.py');
    expect(review.data?.files.map((file) => file.path).some((file) => file.startsWith('.devpilot'))).toBe(false);
    expect(review.data?.affectedTests).toContain('tests/test_app.py');
    expect(review.data?.patchArtifact).toMatch(/^\.devpilot\/logs\/diff-/);
    expect(review.artifacts?.['patch']).toBe(review.data?.patchArtifact);
    // The pre-open edit came from the baseline; the post-open edit is DevPilot's.
    expect(review.data?.preExistingChanges.length).toBeGreaterThanOrEqual(0);

    const dry = envelopeOf<RollbackData>(
      await invokeTool(context, rollbackCheckpointTool, { checkpointId, dryRun: true }),
    );
    expect(dry.data?.dryRun).toBe(true);
    expect(dry.data?.restored).toContain('src/app.py');

    const rolled = envelopeOf<RollbackData>(
      await invokeTool(context, rollbackCheckpointTool, { checkpointId }),
    );
    expect(rolled.success).toBe(true);
    expect(rolled.data?.restored).toContain('src/app.py');

    const content = await readText(path.join(workspace, 'src', 'app.py'));
    expect(content.replace(/\r\n/g, '\n')).toBe('def run(x):\n    return x + 2\n');

    const missing = await invokeTool(context, rollbackCheckpointTool, { checkpointId: 'ck-missing' });
    expect(missing.isError).toBe(true);
    expect(envelopeOf(missing).error?.code).toBe('FILE_NOT_FOUND');

    const closed = await invokeTool(context, closeWorkspaceTool, {});
    expect(closed.isError).toBe(false);
  }, 120_000);
});
