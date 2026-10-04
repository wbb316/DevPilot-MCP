import { z } from 'zod';

import type { RollbackCheckpointData } from '../types/git.js';
import { defineTool } from '../server/tool-registry.js';
import { errors } from '../errors/devpilot-error.js';
import { ok } from '../errors/envelope.js';
import { GitManager } from '../git/git-manager.js';
import { rollbackCheckpoint } from '../git/rollback.js';
import { requireWorkspaceContext } from './scan-project.js';
import { workspacePathSchema } from './shared.js';

/**
 * `rollback_checkpoint` — docs/TOOLS.md Phase 7.
 * Restores only what the checkpoint covers, never touches the index, and reports anything it
 * refused to touch. `dryRun` shows the same three lists without writing.
 */

const inputSchema = {
  path: workspacePathSchema,
  checkpointId: z.string().min(1).describe('Checkpoint id, e.g. ck-20250101-120000-abcd'),
  dryRun: z.boolean().optional().describe('Report what would be restored without changing files'),
};

export const rollbackCheckpointTool = defineTool({
  name: 'rollback_checkpoint',
  title: 'Rollback to checkpoint',
  description:
    'Restore the working tree to a checkpoint taken earlier. Files changed after the checkpoint are reported in protectedUserChanges and left untouched; untracked files are never deleted; the git index is not modified. Use dryRun first to see the effect.',
  permission: 'SAFE_WRITE',
  requiresWorkspace: true,
  inputSchema,
  handler: async (args, context) => {
    const workspace = context.workspace;
    if (workspace === undefined) throw errors.workspaceNotOpen();
    const { paths, logger } = requireWorkspaceContext(context.ctx, workspace);
    const entry = await context.ctx.workspaces.resolveEntry(workspace.id);

    const git = new GitManager({ cwd: entry.state.root, timeoutMs: 30_000 });
    const outcome = await rollbackCheckpoint({
      paths,
      git,
      checkpointId: args.checkpointId,
      dryRun: args.dryRun === true,
      ...(logger === undefined ? {} : { logger }),
    });

    const data: RollbackCheckpointData = {
      restored: outcome.restored,
      skipped: outcome.skipped,
      protectedUserChanges: outcome.protectedUserChanges,
      dryRun: outcome.dryRun,
      notes: outcome.notes,
    };

    const verb = outcome.dryRun ? 'would restore' : 'restored';
    const summary = `${verb} ${outcome.restored.length} file(s) from ${outcome.checkpoint.id}` +
      `${outcome.protectedUserChanges.length === 0 ? '' : `; ${outcome.protectedUserChanges.length} file(s) protected (edited after the checkpoint)`}` +
      `${outcome.skipped.length === 0 ? '' : `; ${outcome.skipped.length} file(s) skipped`}`;

    return ok(summary, data, { warnings: outcome.notes });
  },
});
