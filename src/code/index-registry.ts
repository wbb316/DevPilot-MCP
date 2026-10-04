import type { DevPilotConfig } from '../config/config-schema.js';
import type { Logger } from '../log/logger.js';
import type { WorkspacePaths } from '../types/workspace.js';
import { SymbolIndex } from './symbol-index.js';

/**
 * Process-wide index cache. One MCP server session usually talks to one workspace, but the
 * lifecycle is per workspace id, and closing a workspace releases its index (and flushes it
 * to `.devpilot/devpilot.db`).
 */

export interface SymbolIndexRequest {
  id: string;
  root: string;
  paths: WorkspacePaths;
  config: DevPilotConfig;
  logger?: Logger;
}

const open = new Map<string, SymbolIndex>();
const opening = new Map<string, Promise<SymbolIndex>>();

export async function acquireSymbolIndex(request: SymbolIndexRequest): Promise<SymbolIndex> {
  const existing = open.get(request.id);
  if (existing !== undefined) return existing;

  const pending = opening.get(request.id);
  if (pending !== undefined) return pending;

  const promise = SymbolIndex.open({
    root: request.root,
    paths: request.paths,
    config: request.config,
    ...(request.logger === undefined ? {} : { logger: request.logger }),
  })
    .then((index) => {
      open.set(request.id, index);
      opening.delete(request.id);
      return index;
    })
    .catch((error: unknown) => {
      opening.delete(request.id);
      throw error;
    });

  opening.set(request.id, promise);
  return promise;
}

export function cachedSymbolIndex(workspaceId: string): SymbolIndex | undefined {
  return open.get(workspaceId);
}

/** Flush and release one workspace's index. Safe to call when nothing is open. */
export async function closeSymbolIndex(workspaceId: string): Promise<void> {
  const index = open.get(workspaceId);
  if (index === undefined) return;
  open.delete(workspaceId);
  try {
    await index.save();
  } catch {
    /* a failed flush must not block closing the workspace */
  } finally {
    index.close();
  }
}

export async function closeAllSymbolIndexes(): Promise<void> {
  for (const id of [...open.keys()]) await closeSymbolIndex(id);
}
