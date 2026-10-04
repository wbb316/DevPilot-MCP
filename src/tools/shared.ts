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
