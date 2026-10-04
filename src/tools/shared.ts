import { z } from 'zod';

/** Argument pieces shared by several tools. Literals are frozen (docs/TOOLS.md). */
export const permissionLevelSchema = z.enum(['READ_ONLY', 'SAFE_WRITE', 'EXECUTE', 'FULL']);

export const workspacePathSchema = z
  .string()
  .min(1)
  .optional()
  .describe('Workspace root (or a path inside it). Defaults to the active workspace.');
