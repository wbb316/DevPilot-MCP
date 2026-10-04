import path from 'node:path';

import { readJson, writeJsonAtomic, writeTextAtomic } from '../storage/json-store.js';
import type { Checkpoint, CheckpointIndexFile } from '../types/git.js';
import type { WorkspacePaths } from '../types/workspace.js';

/**
 * Checkpoint metadata lives beside the patches under `.devpilot/checkpoints/`
 * (docs/WORKSPACE-LIFECYCLE.md §3). The patch artifact is the source of truth for a restore;
 * the index only records what exists.
 *
 * `MAX_CHECKPOINTS` bounds disk growth: patches are kept for the newest N checkpoints and
 * older ones are pruned with their patch files.
 */

export const MAX_CHECKPOINTS = 50;

export function checkpointsIndexFile(paths: WorkspacePaths): string {
  return path.join(paths.checkpointsDir, 'checkpoints.json');
}

export function checkpointPatchFile(paths: WorkspacePaths, id: string): string {
  return path.join(paths.checkpointsDir, `${id}.patch`);
}

/** Workspace-relative POSIX path, as reported to the agent. */
export function checkpointPatchRel(id: string): string {
  return `.devpilot/checkpoints/${id}.patch`;
}

/** Absolute directory holding the content snapshot of one checkpoint. */
export function checkpointSnapshotDir(paths: WorkspacePaths, id: string): string {
  return path.join(paths.checkpointsDir, id);
}

/** Workspace-relative POSIX path of that snapshot directory. */
export function checkpointSnapshotRel(id: string): string {
  return `.devpilot/checkpoints/${id}`;
}

export function newCheckpointId(now: Date = new Date()): string {
  const stamp = now.toISOString().replace(/[-:]/g, '').replace(/\..+$/, '').replace('T', '-');
  const random = Math.random().toString(36).slice(2, 6);
  return `ck-${stamp}-${random}`;
}

export class CheckpointStore {
  constructor(private readonly paths: WorkspacePaths) {}

  async list(): Promise<Checkpoint[]> {
    const file = checkpointsIndexFile(this.paths);
    const result = await readJson<CheckpointIndexFile | undefined>(file, undefined);
    const value = result.value;
    if (value === undefined || !Array.isArray(value.checkpoints)) return [];
    return value.checkpoints.filter((entry) => typeof entry?.id === 'string');
  }

  async count(): Promise<number> {
    return (await this.list()).length;
  }

  /** Newest first, capped at `MAX_CHECKPOINTS`; pruned patch files are removed. */
  async add(checkpoint: Checkpoint): Promise<void> {
    const existing = await this.list();
    const kept = [checkpoint, ...existing.filter((entry) => entry.id !== checkpoint.id)];
    const dropped = kept.slice(MAX_CHECKPOINTS);
    const value: CheckpointIndexFile = { version: 1, checkpoints: kept.slice(0, MAX_CHECKPOINTS) };
    await writeJsonAtomic(checkpointsIndexFile(this.paths), value);
    if (dropped.length > 0) {
      const { promises: fs } = await import('node:fs');
      for (const entry of dropped) {
        try {
          await fs.rm(checkpointPatchFile(this.paths, entry.id), { force: true });
          await fs.rm(checkpointSnapshotDir(this.paths, entry.id), { recursive: true, force: true });
        } catch {
          /* best effort: an orphan artifact is harmless */
        }
      }
    }
  }

  async get(id: string): Promise<Checkpoint | undefined> {
    return (await this.list()).find((entry) => entry.id === id);
  }

  /** Absolute path of the patch artifact, or undefined when it is missing on disk. */
  async patchPath(checkpoint: Checkpoint): Promise<string | undefined> {
    const { promises: fs } = await import('node:fs');
    const file = checkpointPatchFile(this.paths, checkpoint.id);
    try {
      await fs.access(file);
      return file;
    } catch {
      return undefined;
    }
  }

  async writePatch(id: string, text: string): Promise<string> {
    const file = checkpointPatchFile(this.paths, id);
    await writeTextAtomic(file, text);
    return checkpointPatchRel(id);
  }
}
