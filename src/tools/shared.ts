import path from 'node:path';

import { z } from 'zod';

/** Argument pieces shared by several tools. Literals are frozen (docs/TOOLS.md). */
export const permissionLevelSchema = z.enum(['READ_ONLY', 'SAFE_WRITE', 'EXECUTE', 'FULL']);

export const workspacePathSchema = z
  .string()
  .min(1)
  .optional()
  .describe('Workspace root (or a path inside it). Defaults to the active workspace.');

/**
 * The `path` argument of the code-intelligence tools is a *filter*, not a workspace
 * selector: it restricts results to files under a workspace-relative prefix. Documented in
 * docs/TOOLS.md (Phase 3) so an agent never confuses the two meanings.
 */
export const pathFilterSchema = z
  .string()
  .min(1)
  .optional()
  .describe('Restrict results to files under this workspace-relative path (default: whole workspace).');

/** Normalise a path filter to workspace-relative POSIX form (`src/`, `.\\src` → `src`). */
export function normalizePathFilter(value: string | undefined): string | undefined {
  if (value === undefined) return undefined;
  const cleaned = value.replace(/\\/g, '/').replace(/^\.\//, '').replace(/^\/+/, '').replace(/\/+$/, '');
  return cleaned === '' ? undefined : cleaned;
}

export interface ResolvedPathFilter {
  /** Workspace-relative prefix to filter by; absent means "the whole workspace". */
  filter?: string;
  /** The caller named a path outside the workspace: an error, never an empty result. */
  outside?: string;
}

/**
 * Resolve the code-intelligence `path` filter against the workspace root.
 *
 * Agents reach for these tools the way they reach for every other DevPilot tool and pass the
 * workspace root as `path`. Read literally as a *prefix*, `D:/Projects/demo` matches no
 * indexed file, so the tool used to answer "no such symbol" for a symbol that exists — a
 * silent, confidently wrong answer. Treating the workspace root (absolute, drive-qualified,
 * or `.`) as "no filter" keeps that mistake harmless; a path genuinely outside the workspace
 * is reported as `PATH_OUTSIDE_WORKSPACE` instead of being swallowed.
 */
export function resolvePathFilter(value: string | undefined, root: string): ResolvedPathFilter {
  if (value === undefined) return {};
  const raw = value.trim();
  if (raw === '' || raw === '.' || raw === './' || raw === '.\\') return {};

  const slashed = raw.replace(/\\/g, '/');
  const absolute = /^[A-Za-z]:\//.test(slashed) || slashed.startsWith('/') || slashed.startsWith('//');
  if (!absolute) {
    const cleaned = normalizePathFilter(raw);
    return cleaned === undefined ? {} : { filter: cleaned };
  }

  const rootPosix = root.replace(/\\/g, '/').replace(/\/+$/, '');
  const target = path.posix.normalize(slashed).replace(/\/+$/, '');
  // Windows paths are case-insensitive: compare folded so `d:\projects\demo` still means the root.
  const relative = path.posix.relative(rootPosix.toLowerCase(), target.toLowerCase());
  if (relative === '' || relative === '.') return {};
  if (relative.startsWith('..')) return { outside: target };
  return { filter: relative };
}
