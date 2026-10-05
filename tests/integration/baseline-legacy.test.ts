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
import { getGitStatusTool } from '../../src/tools/get-git-status';
import { reviewDiffTool } from '../../src/tools/review-diff';
import { gitInit, makeTempDir, removeDir, writeFiles } from '../helpers/index';

/**
 * Post-V1 gate: a baseline written by the pre-fix status parser must not poison later reviews.
 *
 * The old parser left git's C-style octal escapes in place and then mapped `\` to `/` on Windows, so
 * a CJK path was persisted as `docs//344/272/214/...`. Those names match nothing on disk, so
 * `preExistingChanges` missed them and the change budget charged the user's own work to the agent —
 * observed on a real project: 13 of 71 paths, "change budget exceeded (max_lines_changed 5145 > 3000)".
 */

const CJK_FILE = 'docs/二阶段/x.txt';
/** The same path as a pre-fix baseline stored it (二 = E4 BA 8C, 阶 = E9 98 B6, 段 = E6 AE B5). */
const LEGACY_CJK_FILE = 'docs//344/272/214/351/230/266/346/256/265/x.txt';

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
  files: { path: string }[];
  preExistingChanges: string[];
  changeLimits: { exceeded: boolean; counted: { files: number }; excludedPreExisting: number };
}

interface StatusData {
  changedFiles: string[];
  untracked: string[];
  preExisting: boolean;
}

describe('pre-fix baseline paths through the registry', () => {
  let context: ServerContext;
  let home: string;
  let workspace: string;
  let gitAvailable = false;

  beforeAll(async () => {
    home = await makeTempDir('devpilot-legacy-home-');
    workspace = await makeTempDir('devpilot-legacy-ws-');
    context = await ServerContext.create({ home, logger: silentLogger() });

    const config = defaultConfig();
    config.security.max_files_changed = 2;
    config.security.max_lines_changed = 10_000;

    await writeFiles(workspace, {
      '.gitignore': '.devpilot/\n',
      '.devpilot/config.yml': `${JSON.stringify(config, null, 2)}\n`,
      'src/app.py': 'def run(x):\n    return x + 1\n',
      [CJK_FILE]: 'committed line\n',
    });
    const init = await gitInit(workspace);
    gitAvailable = init.available && init.committed;
  }, 60_000);

  afterAll(async () => {
    await context.dispose();
    await removeDir(home);
    await removeDir(workspace);
  });

  it('recovers the recorded name and stops charging the user work to the agent', async () => {
    if (!gitAvailable) return;

    // Dirty the CJK file *before* the workspace is opened: this is the user's own work.
    await fs.writeFile(path.join(workspace, ...CJK_FILE.split('/')), 'edited before open\n', 'utf8');
    const opened = await invokeTool(context, openWorkspaceTool, { path: workspace });
    expect(opened.isError).toBe(false);

    // Replace the freshly written baseline with the shape the pre-fix parser produced.
    const baselineFile = path.join(workspace, '.devpilot', 'cache', 'git-baseline.json');
    const baseline = JSON.parse(await fs.readFile(baselineFile, 'utf8')) as {
      changed: string[];
      untracked: string[];
    };
    expect(baseline.changed).toContain(CJK_FILE);
    await fs.writeFile(
      baselineFile,
      `${JSON.stringify({ ...baseline, changed: [LEGACY_CJK_FILE], untracked: [] }, null, 2)}\n`,
      'utf8',
    );

    const review = envelopeOf<DiffData>(await invokeTool(context, reviewDiffTool, {}));
    expect(review.success, JSON.stringify(review.error)).toBe(true);
    // The change set itself is reported with the real on-disk name.
    expect(review.data?.files.map((file) => file.path)).toEqual([CJK_FILE]);
    // The legacy baseline entry is recovered, so the path counts as pre-existing, not as agent work.
    expect(review.data?.preExistingChanges).toEqual([CJK_FILE]);
    expect(review.data?.changeLimits.counted.files).toBe(0);
    expect(review.data?.changeLimits.excludedPreExisting).toBe(1);
    expect(review.data?.changeLimits.exceeded).toBe(false);
    expect((review.warnings ?? []).join(' ')).toContain('pre-fix escaped form');

    const status = envelopeOf<StatusData>(await invokeTool(context, getGitStatusTool, {}));
    expect(status.success).toBe(true);
    expect(status.data?.changedFiles).toEqual([CJK_FILE]);
    expect(status.data?.preExisting).toBe(true);
  }, 60_000);
});
