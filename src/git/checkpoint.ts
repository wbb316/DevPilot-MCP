import { promises as fs } from 'node:fs';
import path from 'node:path';

import type { Checkpoint, CheckpointKind } from '../types/git.js';
import type { WorkspacePaths } from '../types/workspace.js';
import type { Logger } from '../log/logger.js';
import { EMPTY_TREE_SHA } from '../types/git.js';
import { errors } from '../errors/devpilot-error.js';
import type { GitManager } from './git-manager.js';
import {
  CheckpointStore,
  checkpointSnapshotDir,
  checkpointSnapshotRel,
  newCheckpointId,
} from './checkpoint-store.js';

/**
 * `create_checkpoint` (docs/TOOLS.md Phase 7).
 *
 * A checkpoint never moves user work out of the way: no stash, no index rewrite, no branch
 * switching. It records where HEAD was, which files were already dirty, a binary patch (audit
 * trail) and — the part a restore actually uses — **the content of every changed file**.
 *
 * The content snapshot is why a rollback survives the normal workflow: checkpoint, edit the very
 * same lines, roll back. A patch-based reverse apply cannot do that, and it also cannot bring
 * back a file that was untracked when the checkpoint was taken.
 */

export const MAX_SNAPSHOT_BYTES = 2_097_152;
/** DevPilot's own state is never part of a checkpoint. */
export const EXCLUDED_PREFIXES: readonly string[] = ['.devpilot'];

export interface CreateCheckpointInput {
  paths: WorkspacePaths;
  git: GitManager;
  kind: CheckpointKind;
  label?: string;
  logger?: Logger;
}

export interface CreateCheckpointOutcome {
  checkpoint: Checkpoint;
  note: string;
  /** True when the workspace root is a subdirectory of the repository it belongs to. */
  repoRootMismatch: boolean;
  untrackedAtCreate: number;
  snapshotted: number;
}

function isExcluded(relativePath: string): boolean {
  if (relativePath.startsWith('.git/') || relativePath === '.git') return true;
  return EXCLUDED_PREFIXES.some((prefix) => relativePath.startsWith(prefix));
}

export async function createCheckpoint(input: CreateCheckpointInput): Promise<CreateCheckpointOutcome> {
  const { paths, git } = input;

  if (!(await git.isAvailable())) throw errors.gitNotAvailable('git binary not found on PATH');
  const repoRoot = await git.repositoryRoot();
  if (repoRoot === undefined) {
    throw errors.gitNotAvailable(`${paths.root} is not inside a git repository`);
  }

  const mid = await git.midOperation();
  if (mid !== undefined) {
    throw errors.gitDirty(
      `a git ${mid} is in progress in ${repoRoot}`,
      'finish or abort it before creating a checkpoint: a restore would be ambiguous',
    );
  }

  const head = (await git.revParse('HEAD')) ?? '';
  const branch = (await git.currentBranch()) ?? 'DETACHED';
  const statuses = await git.pathStatuses();

  // DevPilot's own state directory is never user work and never restorable: `.devpilot/` is
  // created by open_workspace itself, so recording it would pollute every checkpoint.
  const excluded = [...statuses.keys()].filter(isExcluded);
  for (const file of excluded) statuses.delete(file);
  const files = [...statuses.keys()].sort();
  const untrackedAtCreate = [...statuses.values()].filter((xy) => xy === '??').length;

  // On an unborn branch there is no HEAD to diff against; the empty tree is the documented base.
  const baseRef = head === '' ? EMPTY_TREE_SHA : 'HEAD';
  const patch = await git.diffPatchText(baseRef);

  const store = new CheckpointStore(paths);
  const id = newCheckpointId();
  const patchFile = await store.writePatch(id, patch);

  const snapshotRoot = checkpointSnapshotDir(paths, id);
  const snapshotSkipped: string[] = [];
  let snapshotted = 0;
  for (const file of files) {
    const source = path.join(paths.root, file.split('/').join(path.sep));
    const target = path.join(snapshotRoot, 'files', file.split('/').join(path.sep));
    try {
      const stat = await fs.stat(source);
      if (!stat.isFile() || stat.size > MAX_SNAPSHOT_BYTES) {
        snapshotSkipped.push(file);
        continue;
      }
      await fs.mkdir(path.dirname(target), { recursive: true });
      await fs.copyFile(source, target);
      snapshotted += 1;
    } catch {
      // Deleted working-tree file, or a path outside this workspace when the workspace is a
      // subdirectory of its repository. Recorded, and reported as skipped on rollback.
      snapshotSkipped.push(file);
    }
  }

  const checkpoint: Checkpoint = {
    id,
    kind: input.kind,
    createdAt: new Date().toISOString(),
    branch,
    head,
    files,
    patchFile,
    snapshotDir: checkpointSnapshotRel(id),
    baseRef,
    dirtyAtCreate: files.length > 0,
    ...(input.label === undefined ? {} : { label: input.label }),
    ...(snapshotSkipped.length === 0 ? {} : { snapshotSkipped }),
  };
  await store.add(checkpoint);

  const headLabel = head === '' ? 'the unborn branch' : `commit ${head.slice(0, 7)}`;
  const note =
    files.length === 0
      ? `working tree was clean; ${id} pins ${headLabel} (nothing to restore yet)`
      : `snapshotted ${snapshotted} of ${files.length} changed file(s) at ${headLabel}; rollback writes this content back and never deletes files created afterwards` +
        `${untrackedAtCreate === 0 ? '' : ` (${untrackedAtCreate} were untracked)`}` +
        `${snapshotSkipped.length === 0 ? '' : `; ${snapshotSkipped.length} file(s) could not be snapshotted and are patch-only`}` +
        `${excluded.length === 0 ? '' : `; ${excluded.length} .devpilot path(s) ignored (DevPilot's own state)`}`;

  input.logger?.debug('checkpoint created', {
    checkpoint: id,
    files: files.length,
    snapshotted,
    kind: input.kind,
  });

  return {
    checkpoint,
    note,
    repoRootMismatch: repoRoot !== paths.root,
    untrackedAtCreate,
    snapshotted,
  };
}
