import { z } from 'zod';

import { resolveLimits } from '../config/config-schema.js';
import { ok } from '../errors/envelope.js';
import { errors } from '../errors/devpilot-error.js';
import { runTests } from '../test/test-runner.js';
import { defineTool } from '../server/tool-registry.js';
import { formatDuration } from '../util/format.js';
import { requireWorkspaceContext } from './scan-project.js';
import { workspacePathSchema } from './shared.js';

/**
 * `run_tests` — docs/TOOLS.md Phase 5. Runs the detected test framework and returns the parsed
 * summary (counts + failing tests with locations). A failing run is an error envelope carrying
 * the same structured data, so the agent never has to read the log to find out what broke.
 */

const inputSchema = {
  path: workspacePathSchema,
  filter: z
    .string()
    .min(1)
    .optional()
    .describe('Framework-level filter: pytest -k, Maven -Dtest, Gradle --tests, jest/vitest -t'),
  file: z.string().min(1).optional().describe('Run a single test file (workspace-relative path)'),
  timeoutSeconds: z.number().int().positive().max(3600).optional().describe('Default 120, capped by config'),
  extraArgs: z.array(z.string()).optional().describe('Extra arguments appended to the planned command'),
  failFast: z.boolean().optional().describe('Stop at the first failure when the runner supports it'),
};

export const runTestsTool = defineTool({
  name: 'run_tests',
  title: 'Run tests',
  description:
    'Run the project test suite with a hard timeout and return a parsed result: status, framework, total/passed/failed/skipped/errors, each failure with file/line/message, and a job record pointing at the full log. Never returns raw logs.',
  permission: 'EXECUTE',
  requiresWorkspace: true,
  inputSchema,
  handler: async (args, context) => {
    const workspace = context.workspace;
    if (workspace === undefined) throw errors.workspaceNotOpen();
    const { config, paths, logger } = requireWorkspaceContext(context.ctx, workspace);
    const entry = await context.ctx.workspaces.resolveEntry(workspace.id);

    const output = await runTests({
      root: entry.state.root,
      paths,
      config,
      profile: entry.state.profile,
      ...(args.filter === undefined ? {} : { filter: args.filter }),
      ...(args.file === undefined ? {} : { file: args.file }),
      ...(args.failFast === undefined ? {} : { failFast: args.failFast }),
      ...(args.extraArgs === undefined ? {} : { extraArgs: args.extraArgs }),
      ...(args.timeoutSeconds === undefined ? {} : { timeoutSeconds: args.timeoutSeconds }),
      logger,
      limits: resolveLimits(config),
    });

    const data = {
      ...output.result,
      parser: output.parser,
      commandLine: output.commandLine,
      logFile: output.logFile,
      notes: output.notes,
    };

    if (output.result.status === 'timeout') {
      throw errors.commandTimeout(output.commandLine, output.timeoutSeconds, data);
    }
    if (output.result.status === 'failed' || output.result.status === 'error') {
      throw errors.testFailed(output.commandLine, output.result.job.exitCode ?? null, data);
    }
    if (output.result.status === 'unknown') {
      return ok(
        `${output.commandLine} exited 0 but printed no machine-readable test summary — the result is UNVERIFIED (${formatDuration(output.result.durationMs)})`,
        data,
        {
          warnings: [
            ...output.notes,
            'the suite may have run, but no counts could be read: declare project.test_command in .devpilot/config.yml, or use a runner that prints a summary',
          ],
        },
      );
    }
    if (output.result.status === 'no_tests') {
      return ok(
        `${output.commandLine} collected no tests (${formatDuration(output.result.durationMs)})`,
        data,
        {
          warnings: [
            ...output.notes,
            'no tests were collected: check the filter/file, the test directories, or declare project.test_command in .devpilot/config.yml',
          ],
        },
      );
    }

    const summary = [
      `${output.result.framework}: ${output.result.passed}/${output.result.total} passed`,
      output.result.skipped > 0 ? `${output.result.skipped} skipped` : undefined,
      `${formatDuration(output.result.durationMs)}`,
      `log: ${output.logFile}`,
    ]
      .filter((part): part is string => part !== undefined)
      .join('; ');

    return ok(summary, data, { warnings: output.notes });
  },
});
