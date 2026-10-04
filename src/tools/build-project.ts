import { z } from 'zod';

import { resolveLimits } from '../config/config-schema.js';
import { ok } from '../errors/envelope.js';
import { errors } from '../errors/devpilot-error.js';
import { runBuild } from '../runner/build-runner.js';
import type { BuildTarget } from '../runner/build-system.js';
import { BUILD_TARGETS } from '../runner/build-system.js';
import { defineTool } from '../server/tool-registry.js';
import { formatDuration } from '../util/format.js';
import { requireWorkspaceContext } from './scan-project.js';
import { workspacePathSchema } from './shared.js';

/**
 * `build_project` — docs/TOOLS.md Phase 4. EXECUTE-gated; the build command is chosen by the
 * rule table in runner/build-system.ts and validated by the command policy before anything
 * is spawned.
 */

const inputSchema = {
  path: workspacePathSchema,
  target: z
    .enum(['compile', 'test-compile', 'package'])
    .optional()
    .describe(`Build target (default compile). One of: ${BUILD_TARGETS.join(', ')}`),
  clean: z.boolean().optional().describe('Run the system clean step first'),
  timeoutSeconds: z.number().int().positive().max(3600).optional(),
  extraArgs: z.array(z.string()).optional().describe('Extra arguments appended to the build command'),
};

export const buildProjectTool = defineTool({
  name: 'build_project',
  title: 'Build project',
  description:
    'Build the opened workspace with the detected build system (Maven, Gradle, npm/pnpm/yarn, Python syntax check). Returns a structured result: status, system, command, duration, extracted errors with file:line, and a job record pointing at the full log. A failed build is reported as BUILD_FAILED with details.errors — never as raw log text.',
  permission: 'EXECUTE',
  requiresWorkspace: true,
  inputSchema,
  handler: async (args, context) => {
    const workspace = context.workspace;
    if (workspace === undefined) throw errors.workspaceNotOpen();
    const { config, paths, logger } = requireWorkspaceContext(context.ctx, workspace);
    const entry = await context.ctx.workspaces.resolveEntry(workspace.id);
    const target: BuildTarget = args.target ?? 'compile';

    const { result, plan, commandLine, timeoutSeconds } = await runBuild({
      root: entry.state.root,
      paths,
      config,
      profile: entry.state.profile,
      target,
      clean: args.clean === true,
      ...(args.timeoutSeconds === undefined ? {} : { timeoutSeconds: args.timeoutSeconds }),
      ...(args.extraArgs === undefined ? {} : { extraArgs: args.extraArgs }),
      logger,
      limits: resolveLimits(config),
    });

    const details = { ...result, system: plan.system, notes: plan.notes, logFile: result.job.logFile };

    if (result.status === 'timeout') {
      throw errors.commandTimeout(commandLine, timeoutSeconds, details);
    }
    if (result.status === 'failed') {
      throw errors.buildFailed(commandLine, result.job.exitCode ?? null, details);
    }

    const warnings = [
      ...result.warnings.map(
        (warning) =>
          `${warning.path ?? ''}${warning.line === undefined ? '' : `:${warning.line}`} ${warning.message}`.trim(),
      ),
      ...plan.notes,
    ];
    const summary = [
      `${plan.system} ${target} succeeded in ${formatDuration(result.durationMs)}`,
      result.errors.length > 0 ? `${result.errors.length} error(s) reported` : 'no errors',
      result.artifacts === undefined || result.artifacts.length === 0
        ? undefined
        : `artifacts: ${result.artifacts.join(', ')}`,
      `log: ${result.job.logFile}`,
    ]
      .filter((part): part is string => part !== undefined)
      .join('; ');

    return ok(summary, details, { warnings });
  },
});
