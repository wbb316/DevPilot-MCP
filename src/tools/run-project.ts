import { z } from 'zod';

import { resolveLimits } from '../config/config-schema.js';
import { ok } from '../errors/envelope.js';
import { errors } from '../errors/devpilot-error.js';
import { runProject } from '../runner/run-runner.js';
import { defineTool } from '../server/tool-registry.js';
import { formatDuration } from '../util/format.js';
import { requireWorkspaceContext } from './scan-project.js';
import { workspacePathSchema } from './shared.js';

/**
 * `run_project` — docs/TOOLS.md Phase 4. Runs a bounded command inside the workspace.
 * The caller can pass an explicit `command`; otherwise the project's own run command
 * (config → package.json → entrypoint inference) is used.
 */

const inputSchema = {
  path: workspacePathSchema,
  command: z
    .string()
    .min(1)
    .optional()
    .describe('Explicit command to run (executable name only; pass its arguments in `args`)'),
  args: z.array(z.string()).optional(),
  timeoutSeconds: z.number().int().positive().max(3600).optional().describe('Default 120, capped by config'),
  env: z.record(z.string()).optional().describe('Extra environment variables for the child process'),
  cwd: z.string().optional().describe('Working directory inside the workspace (default: workspace root)'),
  maxOutputBytes: z.number().int().positive().optional(),
};

export const runProjectTool = defineTool({
  name: 'run_project',
  title: 'Run project',
  description:
    'Run the opened project (or an explicit command) with a hard timeout and output caps. Returns status, exit code, duration, the last lines of stdout/stderr and a job record with the full log path. A long-running server is expected to end as COMMAND_TIMEOUT; its captured output is still returned.',
  permission: 'EXECUTE',
  requiresWorkspace: true,
  inputSchema,
  handler: async (args, context) => {
    const workspace = context.workspace;
    if (workspace === undefined) throw errors.workspaceNotOpen();
    const { config, paths, logger } = requireWorkspaceContext(context.ctx, workspace);
    const entry = await context.ctx.workspaces.resolveEntry(workspace.id);

    const output = await runProject({
      root: entry.state.root,
      paths,
      config,
      profile: entry.state.profile,
      ...(args.command === undefined ? {} : { command: args.command }),
      ...(args.args === undefined ? {} : { args: args.args }),
      ...(args.env === undefined ? {} : { env: args.env }),
      ...(args.cwd === undefined ? {} : { cwd: args.cwd }),
      ...(args.timeoutSeconds === undefined ? {} : { timeoutSeconds: args.timeoutSeconds }),
      ...(args.maxOutputBytes === undefined ? {} : { maxOutputBytes: args.maxOutputBytes }),
      logger,
      limits: resolveLimits(config),
    });

    const data = {
      ...output.result,
      stdoutTail: output.stdoutTail,
      stderrTail: output.stderrTail,
      logFile: output.logFile,
      notes: output.notes,
    };

    if (output.result.status === 'timeout') {
      throw errors.commandTimeout(output.commandLine, output.timeoutSeconds, data);
    }
    if (output.result.status === 'failed') {
      throw errors.commandFailed(output.commandLine, output.result.exitCode, data);
    }

    const summary = [
      `${output.commandLine} exited 0 in ${formatDuration(output.result.durationMs)}`,
      output.stdoutTail.length === 0 ? 'no stdout' : `last stdout: ${output.stdoutTail[output.stdoutTail.length - 1] ?? ''}`,
      `log: ${output.logFile}`,
    ].join('; ');

    return ok(summary, data, { warnings: output.notes });
  },
});
