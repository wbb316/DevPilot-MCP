import { promises as fs } from 'node:fs';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

import { GitManager } from '../../src/git/git-manager';
import { runProcess } from '../../src/runner/process-runner';
import { gitInit, makeTempDir, removeDir, writeFiles } from '../helpers/index';

const IDENTITY = ['-c', 'user.email=devpilot-test@example.invalid', '-c', 'user.name=DevPilot Test'];

/**
 * `pathStatuses` is the key set everything git-related is keyed by: checkpoint file lists and
 * snapshots, diff review lookups, pre-existing-change classification. It must produce the path that
 * exists on disk — including when git would quote it in the line-based format.
 */
describe('pathStatuses reads real paths', () => {
  it('keys status by the on-disk path for CJK names, spaces, renames and untracked files', async () => {
    const root = await makeTempDir('devpilot-status-');
    try {
      await writeFiles(root, {
        'docs/文档 说明.md': 'origin\n',
        'src/移动前.md': 'move me\n',
      });
      const init = await gitInit(root);
      if (!init.available || !init.committed) return;

      const git = new GitManager({ cwd: root });
      await fs.writeFile(path.join(root, 'docs', '文档 说明.md'), 'origin changed\n', 'utf8');
      await writeFiles(root, { 'docs/新增文件.md': 'new\n' });
      const moved = await runProcess({
        command: 'git',
        args: [...IDENTITY, 'mv', 'src/移动前.md', 'src/移动后.md'],
        cwd: root,
        timeoutMs: 20_000,
      });
      expect(moved.exitCode).toBe(0);

      const statuses = await git.pathStatuses();
      expect(statuses.get('docs/文档 说明.md')).toBe(' M');
      expect(statuses.get('docs/新增文件.md')).toBe('??');
      // A rename carries its original name as a second NUL field, which must not leak into the map.
      expect(statuses.get('src/移动后.md')?.startsWith('R')).toBe(true);
      expect(statuses.has('src/移动前.md')).toBe(false);
      for (const key of statuses.keys()) {
        expect(key).not.toContain('\\3');
        expect(key).not.toContain(' -> ');
      }
      expect(statuses.size).toBe(3);
    } finally {
      await removeDir(root);
    }
  }, 60_000);

  it('returns an empty map outside a repository instead of throwing', async () => {
    const root = await makeTempDir('devpilot-status-norepo-');
    try {
      const statuses = await new GitManager({ cwd: root }).pathStatuses();
      expect(statuses.size).toBe(0);
    } finally {
      await removeDir(root);
    }
  }, 60_000);
});
