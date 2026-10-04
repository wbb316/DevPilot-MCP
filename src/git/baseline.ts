import path from 'node:path';

import { readJson, writeJsonAtomic } from '../storage/json-store.js';
import type { GitBaseline } from '../types/git.js';
import type { WorkspacePaths } from '../types/workspace.js';

/**
 * The baseline separates "the user was already editing this" from "the agent changed this"
 * (docs/TOOLS.md Phase 7). It is written once by `open_workspace`, before any agent edit,
 * and read by `review_diff` / `get_git_status` / `rollback_checkpoint`.
 *
 * Missing or stale baselines degrade to an empty list and a note — never to a guess.
 */

export function baselineFile(paths: WorkspacePaths): string {
  return path.join(paths.cacheDir, 'git-baseline.json');
}

export async function readBaseline(paths: WorkspacePaths): Promise<GitBaseline | undefined> {
  const result = await readJson<GitBaseline | undefined>(baselineFile(paths), undefined);
  const value = result.value;
  if (value === undefined) return undefined;
  if (value.version !== 1) return undefined;
  return {
    version: 1,
    capturedAt: typeof value.capturedAt === 'string' ? value.capturedAt : new Date(0).toISOString(),
    ...(typeof value.head === 'string' ? { head: value.head } : {}),
    ...(typeof value.branch === 'string' ? { branch: value.branch } : {}),
    changed: Array.isArray(value.changed) ? value.changed.filter((p) => typeof p === 'string') : [],
    untracked: Array.isArray(value.untracked) ? value.untracked.filter((p) => typeof p === 'string') : [],
  };
}

export async function writeBaseline(
  paths: WorkspacePaths,
  baseline: Omit<GitBaseline, 'version'>,
): Promise<GitBaseline> {
  const value: GitBaseline = { version: 1, ...baseline };
  await writeJsonAtomic(baselineFile(paths), value);
  return value;
}

export function emptyBaseline(): GitBaseline {
  return { version: 1, capturedAt: new Date().toISOString(), changed: [], untracked: [] };
}
