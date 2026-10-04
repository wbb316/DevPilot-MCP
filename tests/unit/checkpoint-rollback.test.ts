import { promises as fs } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

import { GitManager } from '../../src/git/git-manager';
import { createCheckpoint } from '../../src/git/checkpoint';
import { rollbackCheckpoint } from '../../src/git/rollback';
import { ensureWorkspaceLayout, workspacePaths } from '../../src/storage/paths';
import { gitInit, makeTempDir, readText, removeDir, writeFiles } from '../helpers/index';

const ORIGINAL = Array.from({ length: 25 }, (_, index) => `line ${index + 1}`).join('\n') + '\n';

/**
 * A restore copies the snapshot bytes back, but git's working tree may use CRLF
 * (`core.autocrlf`). Assertions therefore compare line content, not raw bytes.
 */
function normalize(text: string): string {
  return text.replace(/\r\n/g, '\n');
}

async function repository(): Promise<
  { root: string; paths: ReturnType<typeof workspacePaths>; git: GitManager } | undefined
> {
  const root = await makeTempDir('devpilot-ck-');
  await writeFiles(root, { 'a.txt': ORIGINAL });
  const init = await gitInit(root);
  if (!init.available) {
    await removeDir(root);
    return undefined;
  }
  const paths = workspacePaths(root);
  await ensureWorkspaceLayout(paths);
  return { root, paths, git: new GitManager({ cwd: root }) };
}

async function edit(root: string, from: string, to: string): Promise<void> {
  const file = path.join(root, 'a.txt');
  const current = await fs.readFile(file, 'utf8');
  await fs.writeFile(file, current.replace(from, to), 'utf8');
}

describe('checkpoints and rollback against a real repository', () => {
  it('restores the checkpointed content after the same file was edited again', async () => {
    const repo = await repository();
    if (repo === undefined) return;
    const { root, paths, git } = repo;
    try {
      await edit(root, 'line 2', 'line 2 CHECKPOINTED');
      const atCheckpoint = normalize(await readText(path.join(root, 'a.txt')));

      const created = await createCheckpoint({ paths, git, kind: 'manual', label: 'before edit' });
      expect(created.checkpoint.files).toContain('a.txt');
      expect(created.checkpoint.dirtyAtCreate).toBe(true);
      expect(created.snapshotted).toBe(1);
      expect(created.note).toContain('snapshotted 1 of 1');

      const patchOnDisk = await readFileIfExists(path.join(paths.checkpointsDir, `${created.checkpoint.id}.patch`));
      expect(patchOnDisk).toContain('a.txt');
      const snapshotOnDisk = await readText(
        path.join(paths.checkpointsDir, created.checkpoint.id, 'files', 'a.txt'),
      );
      expect(normalize(snapshotOnDisk)).toContain('line 2 CHECKPOINTED');

      // The agent now edits the very same region — the case a patch-based restore cannot undo.
      await edit(root, 'line 2 CHECKPOINTED', 'line 2 EDITED-AFTER');
      await edit(root, 'line 20', 'line 20 LATER');
      const beforeDryRun = normalize(await readText(path.join(root, 'a.txt')));

      const dry = await rollbackCheckpoint({ paths, git, checkpointId: created.checkpoint.id, dryRun: true });
      expect(dry.dryRun).toBe(true);
      expect(dry.restored).toContain('a.txt');
      expect(normalize(await readText(path.join(root, 'a.txt')))).toBe(beforeDryRun);

      const real = await rollbackCheckpoint({ paths, git, checkpointId: created.checkpoint.id });
      expect(real.restored).toContain('a.txt');
      expect(real.protectedUserChanges).toEqual([]);

      // Back to the exact checkpoint content: the later edit to the same file is reverted with it.
      expect(normalize(await readText(path.join(root, 'a.txt')))).toBe(atCheckpoint);
      expect(real.notes?.some((note) => note.includes('index was left untouched'))).toBe(true);
    } finally {
      await removeDir(root);
    }
  }, 60_000);

  it('records a clean tree as a checkpoint with nothing to restore', async () => {
    const repo = await repository();
    if (repo === undefined) return;
    const { root, paths, git } = repo;
    try {
      const created = await createCheckpoint({ paths, git, kind: 'pre_command' });
      expect(created.checkpoint.dirtyAtCreate).toBe(false);
      expect(created.checkpoint.files).toEqual([]);
      expect(created.note).toContain('working tree was clean');

      const result = await rollbackCheckpoint({ paths, git, checkpointId: created.checkpoint.id });
      expect(result.restored).toEqual([]);
      expect(result.skipped).toEqual([]);
    } finally {
      await removeDir(root);
    }
  }, 60_000);

  it('never deletes files that appeared after the checkpoint and says so', async () => {
    const repo = await repository();
    if (repo === undefined) return;
    const { root, paths, git } = repo;
    try {
      const created = await createCheckpoint({ paths, git, kind: 'pre_command' });
      await fs.writeFile(path.join(root, 'agent-new.txt'), 'created by the agent\n', 'utf8');

      const result = await rollbackCheckpoint({ paths, git, checkpointId: created.checkpoint.id });
      expect(result.restored).toEqual([]);
      expect(normalize(await readText(path.join(root, 'agent-new.txt')))).toBe('created by the agent\n');
      expect(result.notes?.some((note) => note.includes('untracked file(s) appeared'))).toBe(true);
    } finally {
      await removeDir(root);
    }
  }, 60_000);

  it('also restores a file that was untracked when the checkpoint was taken', async () => {
    const repo = await repository();
    if (repo === undefined) return;
    const { root, paths, git } = repo;
    try {
      await fs.writeFile(path.join(root, 'notes.txt'), 'untracked at checkpoint\n', 'utf8');
      const created = await createCheckpoint({ paths, git, kind: 'manual' });
      expect(created.checkpoint.files).toContain('notes.txt');

      await fs.writeFile(path.join(root, 'notes.txt'), 'changed afterwards\n', 'utf8');
      const result = await rollbackCheckpoint({ paths, git, checkpointId: created.checkpoint.id });
      expect(result.restored).toContain('notes.txt');
      expect(normalize(await readText(path.join(root, 'notes.txt')))).toBe('untracked at checkpoint\n');
    } finally {
      await removeDir(root);
    }
  }, 60_000);

  it('skips a file with no snapshot instead of pretending it was restored', async () => {
    const repo = await repository();
    if (repo === undefined) return;
    const { root, paths, git } = repo;
    try {
      await fs.writeFile(path.join(root, 'notes.txt'), 'untracked at checkpoint\n', 'utf8');
      const created = await createCheckpoint({ paths, git, kind: 'manual' });

      // An untracked file is only in the snapshot, never in the patch: losing the snapshot must
      // be reported, not counted as a restore.
      await fs.rm(path.join(paths.checkpointsDir, created.checkpoint.id, 'files', 'notes.txt'), { force: true });

      const result = await rollbackCheckpoint({ paths, git, checkpointId: created.checkpoint.id });
      expect(result.restored).not.toContain('notes.txt');
      expect(result.skipped).toContain('notes.txt');
      expect(result.notes?.some((note) => note.includes('not covered by the patch') || note.includes('no snapshot'))).toBe(
        true,
      );
    } finally {
      await removeDir(root);
    }
  }, 60_000);

  it("never records DevPilot's own state directory as user work", async () => {
    const repo = await repository();
    if (repo === undefined) return;
    const { root, paths, git } = repo;
    try {
      // open_workspace writes a real file into .devpilot/, which git then sees as untracked.
      await writeFiles(paths.devpilotDir, { 'config.yml': 'security:\n  execute: true\n' });
      await edit(root, 'line 4', 'line 4 CHECKPOINTED');

      const created = await createCheckpoint({ paths, git, kind: 'manual' });
      expect(created.checkpoint.files).toEqual(['a.txt']);
      expect(created.note).toContain('.devpilot path(s) ignored');

      const result = await rollbackCheckpoint({ paths, git, checkpointId: created.checkpoint.id });
      expect(result.restored).toEqual(['a.txt']);
      expect(result.skipped).toEqual([]);
      // DevPilot's own config is still there: it is not part of anyone's rollback.
      expect(normalize(await readText(path.join(paths.devpilotDir, 'config.yml')))).toContain('execute: true');
    } finally {
      await removeDir(root);
    }
  }, 60_000);

  it('reports FILE_NOT_FOUND for an unknown checkpoint id', async () => {
    const repo = await repository();
    if (repo === undefined) return;
    const { root, paths, git } = repo;
    try {
      await expect(rollbackCheckpoint({ paths, git, checkpointId: 'ck-nope' })).rejects.toMatchObject({
        code: 'FILE_NOT_FOUND',
      });
    } finally {
      await removeDir(root);
    }
  }, 60_000);
});

async function readFileIfExists(file: string): Promise<string> {
  try {
    return await fs.readFile(file, 'utf8');
  } catch {
    return '';
  }
}
