import { z } from 'zod';

import { defineTool } from '../server/tool-registry.js';
import { ok } from '../errors/envelope.js';
import { errors } from '../errors/devpilot-error.js';
import { DEFAULT_MAX_EVIDENCE } from '../diagnose/diagnose.js';
import { describeDiagnosis, diagnoseJob } from '../diagnose/diagnose-job.js';
import { requireWorkspaceContext } from './scan-project.js';
import { workspacePathSchema } from './shared.js';

/**
 * `diagnose_failure` — docs/TOOLS.md Phase 6.
 *
 * The difference between this and a shell MCP: the agent never reads the log. DevPilot reads it,
 * classifies the failure, locates it, keeps only the lines that carry information, and names the
 * files worth looking at first. The full transcript stays on disk at `logFile`.
 */

const inputSchema = {
  path: workspacePathSchema,
  jobId: z
    .string()
    .optional()
    .describe('Job id from this workspace ledger (default: the most recent failed job)'),
  command: z
    .string()
    .optional()
    .describe('Match the most recent job whose command contains this text'),
  logFile: z
    .string()
    .optional()
    .describe('Workspace-relative log file to analyse instead of a ledger entry'),
  maxEvidence: z
    .number()
    .int()
    .min(1)
    .max(50)
    .optional()
    .describe(`How many key lines to return (default ${DEFAULT_MAX_EVIDENCE})`),
};

export const diagnoseFailureTool = defineTool({
  name: 'diagnose_failure',
  title: 'Diagnose failure',
  description:
    'Classify the last (or a named) failed job into a category, locate the failing source line, and return only the evidence lines that matter plus the suspect files — instead of a raw log. Use it after build_project, run_project, run_tests or run_test fails, then read the located file at the reported line.',
  permission: 'READ_ONLY',
  requiresWorkspace: true,
  inputSchema,
  handler: async (args, context) => {
    const workspace = context.workspace;
    if (workspace === undefined) throw errors.workspaceNotOpen();
    const { paths, logger } = requireWorkspaceContext(context.ctx, workspace);
    const entry = await context.ctx.workspaces.resolveEntry(workspace.id);

    const result = await diagnoseJob({
      workspaceId: workspace.id,
      root: entry.state.root,
      paths,
      ...(logger === undefined ? {} : { logger }),
      ...(args.jobId === undefined ? {} : { jobId: args.jobId }),
      ...(args.command === undefined ? {} : { command: args.command }),
      ...(args.logFile === undefined ? {} : { logFile: args.logFile }),
      ...(args.maxEvidence === undefined ? {} : { maxEvidence: args.maxEvidence }),
    });

    return ok(describeDiagnosis(result), result, { warnings: result.notes ?? [] });
  },
});
