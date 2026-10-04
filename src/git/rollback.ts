import { promises as fs } from 'node:fs';
import path from 'node:path';

import type { Checkpoint } from '../types/git.js';
import type { WorkspacePaths } from '../types/workspace.js';
import type { Logger } from '../log/logger.js';
import { errors } from '../errors/devpilot-error.js';
import type { GitManager } from './git-manager.js';
import { CheckpointStore, checkpointSnapshotDir } from './checkpoint-store.js';
import { parsePatchPaths } from './patch.js';

/**
 * `rollback_checkpoint` (docs/TOOLS.md Phase 7).
 *
 * The restore writes the checkpoint's recorded content back, file by file. Consequences, all
 * intentional:
 *
 *  - it works after the normal workflow (checkpoint → edit the same lines → roll back), which a
 *    patch reverse-apply cannot do;
 *  - the user's pre-existing uncommitted work is *preserved*, because the snapshot was taken
 *    before any change of this session and contains that work;
 *  - files that appeared **after** the checkpoint are never deleted — a patch cannot know whether
 *    they are the user's, so they are reported instead;
 *  - the git index is never touched (no `git add`, no `reset`, no `checkout -f`);
 *  - `dryRun` reports the same three lists without writing anything.
 */

export interface RollbackInput {
  paths: WorkspacePaths;
  git: GitManager;
  checkpointId: string;
  dryRun?: boolean;
  logger?: Logger;
}

export interface RollbackOutcome {
  checkpoint: Checkpoint;
  restored: string[];
  skipped: string[];
  protectedUserChanges: string[];
  dryRun: boolean;
  notes: string[];
}

/** Paths DevPilot refuses to write: the repository metadata and anything outside the tree. */
export function isProtectedPath(relativePath: string): boolean {
  if (relativePath === '' || relativePath.includes('\0')) return true;
  if (relativePath.startsWith('.git/') || relativePath === '.git') return true;
  if (path.isAbsolute(relativePath)) return true;
  if (/^[A-Za-z]:/.test(relativePath)) return true;
  const segments = relativePath.split('/');
  return segments.includes('..');
}

async function exists(file: string): Promise<boolean> {
  try {
    await fs.access(file);
    return true;
  } catch {
    return false;
  }
}

export async function rollbackCheckpoint(input: RollbackInput): Promise<RollbackOutcome> {
  const { paths, git } = input;
  const dryRun = input.dryRun === true;
  const store = new CheckpointStore(paths);

  const checkpoint = await store.get(input.checkpointId);
  if (checkpoint === undefined) {
    throw errors.fileNotFound(
      input.checkpointId,
      'no checkpoint with this id exists in this workspace',
      'checkpoints are listed in .devpilot/checkpoints/checkpoints.json; create one with create_checkpoint',
    );
  }

  if (!(await git.isAvailable())) throw errors.gitNotAvailable('git binary not found on PATH');
  const mid = await git.midOperation();
  if (mid !== undefined) {
    throw errors.gitDirty(
      `a git ${mid} is in progress`,
      'finish or abort it before rolling back: a restore would be ambiguous',
    );
  }

  const notes: string[] = [];
  const statuses = await git.pathStatuses();
  const restored: string[] = [];
  const skipped: string[] = [];
  const protectedUserChanges: string[] = [];

  const snapshotRoot = checkpointSnapshotDir(paths, checkpoint.id);
  const patchPath = await store.patchPath(checkpoint);
  const covered = patchPath === undefined ? new Set<string>() : parsePatchPaths(await fs.readFile(patchPath, 'utf8'));
  if (patchPath === undefined) {
    notes.push(`patch artifact ${checkpoint.patchFile} is missing; only the content snapshot can restore`);
  }

  for (const file of checkpoint.files) {
    if (isProtectedPath(file)) {
      protectedUserChanges.push(file);
      notes.push(`${file} is repository metadata or outside the workspace — refused`);
      continue;
    }

    const target = path.join(paths.root, file.split('/').join(path.sep));
    const snapshot = path.join(snapshotRoot, 'files', file.split('/').join(path.sep));

    if (await exists(snapshot)) {
      if (dryRun) {
        restored.push(file);
        continue;
      }
      try {
        await fs.mkdir(path.dirname(target), { recursive: true });
        await fs.copyFile(snapshot, target);
        restored.push(file);
      } catch (error) {
        skipped.push(file);
        notes.push(`${file} could not be written: ${error instanceof Error ? error.message : String(error)}`);
      }
      continue;
    }

    // No snapshot (too large or unreadable at checkpoint time): fall back to the patch, and
    // refuse rather than clobber when the file has moved on since.
    if (covered.has(file)) {
      const check = await git.applyReversePatch(patchPath as string, { include: [file], checkOnly: true });
      if (check.exitCode !== 0) {
        protectedUserChanges.push(file);
        notes.push(`${file} has no snapshot and changed after the checkpoint — left untouched`);
        continue;
      }
      if (dryRun) {
        restored.push(file);
        continue;
      }
      const apply = await git.applyReversePatch(patchPath as string, { include: [file] });
      if (apply.exitCode === 0) restored.push(file);
      else {
        skipped.push(file);
        notes.push(`${file} failed to restore: ${apply.stderr.trim() || `exit code ${apply.exitCode}`}`);
      }
      continue;
    }

    skipped.push(file);
    notes.push(`${file} has no snapshot and is not covered by the patch — nothing to restore`);
  }

  const appeared = [...statuses.keys()].filter(
    (entry) => statuses.get(entry) === '??' && !checkpoint.files.includes(entry) && !entry.startsWith('.devpilot'),
  );
  if (appeared.length > 0) {
    notes.push(
      `${appeared.length} untracked file(s) appeared after this checkpoint (${appeared.slice(0, 5).join(', ')}${appeared.length > 5 ? ', …' : ''}) — left in place; DevPilot never deletes files it did not create`,
    );
  }
  if (restored.length > 0) {
    notes.push('the git index was left untouched: restored files are unstaged working-tree content');
  }
  if (checkpoint.snapshotSkipped !== undefined && checkpoint.snapshotSkipped.length > 0) {
    notes.push(
      `${checkpoint.snapshotSkipped.length} file(s) had no snapshot (too large or unreadable at checkpoint time): ${checkpoint.snapshotSkipped.slice(0, 5).join(', ')}`,
    );
  }

  input.logger?.debug('rollback executed', {
    checkpoint: checkpoint.id,
    dryRun,
    restored: restored.length,
    protected: protectedUserChanges.length,
  });

  return { checkpoint, restored, skipped, protectedUserChanges, dryRun, notes };
}
