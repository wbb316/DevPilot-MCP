import { z } from 'zod';

import type { DiffReview } from '../types/git.js';
import { defineTool } from '../server/tool-registry.js';
import { errors } from '../errors/devpilot-error.js';
import { ok } from '../errors/envelope.js';
import { GitManager } from '../git/git-manager.js';
import { analyzeDiff } from '../git/diff-analyzer.js';
import { resolveLimits } from '../config/config-schema.js';
import { checkChangeLimits } from '../security/change-limits.js';
import { requireWorkspaceContext } from './scan-project.js';
import { workspacePathSchema } from './shared.js';

/**
 * `review_diff` — docs/TOOLS.md Phase 7. Structured diff review: what changed, how risky it is,
 * which tests are affected, and which changes predate the agent. The full patch is an artifact,
 * never inlined into the response.
 */

const inputSchema = {
  path: workspacePathSchema,
  staged: z.boolean().optional().describe('Review staged changes (index) instead of the working tree'),
  base: z
    .string()
    .optional()
    .describe('Commit/ref to diff against — defaults to HEAD, or the empty tree on an unborn branch'),
  includePatch: z.boolean().optional().describe('Write the full patch to .devpilot/ and return its path'),
  maxFiles: z.number().int().min(1).max(2000).optional().describe('Cap on files analysed (default 200)'),
};

export const reviewDiffTool = defineTool({
  name: 'review_diff',
  title: 'Review diff',
  description:
    'Review the current diff: per-file status, added/deleted lines, changed symbols, risk level with explicit reasons, affected tests, and which changes existed before DevPilot ran. Use it to audit edits before reporting. Set includePatch to keep the full patch as an artifact.',
  permission: 'READ_ONLY',
  requiresWorkspace: true,
  inputSchema,
  handler: async (args, context) => {
    const workspace = context.workspace;
    if (workspace === undefined) throw errors.workspaceNotOpen();
    const { config, paths } = requireWorkspaceContext(context.ctx, workspace);
    const entry = await context.ctx.workspaces.resolveEntry(workspace.id);

    const git = new GitManager({ cwd: entry.state.root, timeoutMs: 30_000 });
    if (!(await git.isAvailable())) throw errors.gitNotAvailable('git binary not found on PATH');

    const result = await analyzeDiff({
      root: entry.state.root,
      paths,
      git,
      ...(args.staged === undefined ? {} : { staged: args.staged }),
      ...(args.base === undefined ? {} : { base: args.base }),
      includePatch: args.includePatch === true,
      ...(args.maxFiles === undefined ? {} : { maxFiles: args.maxFiles }),
      logger: context.ctx.logger,
    });

    const review: DiffReview = result.review;
    // The budget governs what the agent changed. Pre-existing user work stays visible in
    // files/totals/preExistingChanges but must never be counted against the agent's budget.
    const preExisting = new Set(review.preExistingChanges);
    const agentFiles = review.files.filter((file) => !preExisting.has(file.path));
    const agentTotals = {
      files: agentFiles.length,
      addedLines: agentFiles.reduce((sum, file) => sum + file.addedLines, 0),
      deletedLines: agentFiles.reduce((sum, file) => sum + file.deletedLines, 0),
    };
    const excludedPreExisting = review.files.length - agentFiles.length;
    const changeLimits = checkChangeLimits(agentTotals, resolveLimits(config), excludedPreExisting);
    const summary =
      review.totals.files === 0
        ? 'no changes against the base'
        : `${review.totals.files} file(s) changed, +${review.totals.addedLines} -${review.totals.deletedLines}, risk ${review.riskLevel}` +
          `${review.highRisk.length === 0 ? '' : `, ${review.highRisk.length} high-risk file(s)`}` +
          `${review.affectedTests.length === 0 ? '' : `, ${review.affectedTests.length} test file(s) touched`}` +
          `${excludedPreExisting === 0 ? '' : `, ${excludedPreExisting} pre-existing path(s) not counted`}` +
          `${changeLimits.exceeded ? ', change budget exceeded (agent changes)' : ''}`;

    const artifacts: Record<string, string> = {};
    if (review.patchArtifact !== undefined) artifacts['patch'] = review.patchArtifact;

    const warnings = [...(review.notes ?? [])];
    if (excludedPreExisting > 0) {
      warnings.push(
        `${excludedPreExisting} changed path(s) pre-date this session (preExistingChanges): they stay ` +
          'in files/totals but are excluded from the change budget',
      );
    }
    if (changeLimits.advice !== undefined) warnings.push(changeLimits.advice);

    return ok(summary, { ...review, changeLimits }, {
      artifacts,
      warnings,
    });
  },
});
