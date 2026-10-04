import { z } from 'zod';

import type { CreateCheckpointData } from '../types/git.js';
import { defineTool } from '../server/tool-registry.js';
import { errors } from '../errors/devpilot-error.js';
import { ok } from '../errors/envelope.js';
import { GitManager } from '../git/git-manager.js';
import { createCheckpoint } from '../git/checkpoint.js';
import { requireWorkspaceContext } from './scan-project.js';
import { workspacePathSchema } from './shared.js';

/**
 * `create_checkpoint` — docs/TOOLS.md Phase 7. Call it before a batch of edits.
 * A dirty tree is recorded, never stashed away; only a genuinely ambiguous git state
 * (merge/rebase in progress) is refused.
 */

const inputSchema = {
  path: workspacePathSchema,
  label: z.string().max(200).optional().describe('Human-readable label for this checkpoint'),
  kind: z
    .enum(['manual', 'pre_write', 'pre_command'])
    .optional()
    .describe('Why the checkpoint was taken (default manual)'),
};

export const createCheckpointTool = defineTool({
  name: 'create_checkpoint',
  title: 'Create checkpoint',
  description:
    'Record a restorable checkpoint of the working tree before making risky edits: HEAD, branch, changed paths and a binary patch in .devpilot/checkpoints/. Nothing is stashed, moved or committed. Restore later with rollback_checkpoint.',
  permission: 'SAFE_WRITE',
  requiresWorkspace: true,
  inputSchema,
  handler: async (args, context) => {
    const workspace = context.workspace;
    if (workspace === undefined) throw errors.workspaceNotOpen();
    const { paths, logger } = requireWorkspaceContext(context.ctx, workspace);
    const entry = await context.ctx.workspaces.resolveEntry(workspace.id);

    const git = new GitManager({ cwd: entry.state.root, timeoutMs: 30_000 });
    const outcome = await createCheckpoint({
      paths,
      git,
      kind: args.kind ?? 'manual',
      ...(args.label === undefined ? {} : { label: args.label }),
      ...(logger === undefined ? {} : { logger }),
    });

    const warnings: string[] = [];
    if (outcome.repoRootMismatch) {
      warnings.push(
        'the workspace root is a subdirectory of its git repository: recorded paths come from git and may point outside the workspace',
      );
    }

    const data: CreateCheckpointData = { checkpoint: outcome.checkpoint, note: outcome.note };
    const summary = `checkpoint ${outcome.checkpoint.id} created (${outcome.checkpoint.files.length} changed file(s), head ${outcome.checkpoint.head === '' ? 'unborn' : outcome.checkpoint.head.slice(0, 7)})`;

    return ok(summary, data, { warnings });
  },
});
