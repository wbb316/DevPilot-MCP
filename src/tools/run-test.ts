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
 * `run_test` — docs/TOOLS.md Phase 5. A convenience wrapper around the same runner for one
 * target. Target syntax is accepted in the shapes agents actually produce:
 *   `tests/test_model.py::test_shape` (file + test), `tests/test_model.py` (file),
 *   `UserServiceTest#lengthOfTitle` (class#method), `test_shape` (name filter).
 */

export interface TestTarget {
  target: string;
  file?: string;
  filter?: string;
}

const SOURCE_FILE = /\.(py|java|kt|kts|ts|tsx|js|jsx|mjs|cjs)$/i;

export function parseTestTarget(target: string): TestTarget {
  const trimmed = target.trim();
  if (trimmed === '') throw errors.invalidArgument('target must not be empty');

  if (trimmed.includes('::')) {
    const [file, ...rest] = trimmed.split('::');
    const parsed: TestTarget = { target: trimmed };
    if (file !== undefined && file !== '') parsed.file = file;
    const filter = rest.join('::').trim();
    if (filter !== '') parsed.filter = filter;
    return parsed;
  }

  if (trimmed.includes('#')) {
    return { target: trimmed, filter: trimmed };
  }

  if (SOURCE_FILE.test(trimmed) || /[\\/]/.test(trimmed)) {
    return { target: trimmed, file: trimmed };
  }

  return { target: trimmed, filter: trimmed };
}

const inputSchema = {
  path: workspacePathSchema,
  target: z
    .string()
    .min(1)
    .describe('One test target: file, file::test, Class#method, or a bare test name'),
  timeoutSeconds: z.number().int().positive().max(3600).optional(),
  extraArgs: z.array(z.string()).optional(),
};

export const runTestTool = defineTool({
  name: 'run_test',
  title: 'Run one test',
  description:
    'Run a single test target (file, file::test, Class#method or name filter) and return the same structured result as run_tests, with the failures that match the target listed first.',
  permission: 'EXECUTE',
  requiresWorkspace: true,
  inputSchema,
  handler: async (args, context) => {
    const workspace = context.workspace;
    if (workspace === undefined) throw errors.workspaceNotOpen();
    const { config, paths, logger } = requireWorkspaceContext(context.ctx, workspace);
    const entry = await context.ctx.workspaces.resolveEntry(workspace.id);

    const selection = parseTestTarget(args.target);

    const output = await runTests({
      root: entry.state.root,
      paths,
      config,
      profile: entry.state.profile,
      ...(selection.filter === undefined ? {} : { filter: selection.filter }),
      ...(selection.file === undefined ? {} : { file: selection.file }),
      ...(args.extraArgs === undefined ? {} : { extraArgs: args.extraArgs }),
      ...(args.timeoutSeconds === undefined ? {} : { timeoutSeconds: args.timeoutSeconds }),
      logger,
      limits: resolveLimits(config),
    });

    const needle = (selection.filter ?? selection.file ?? args.target).toLowerCase();
    const matching = output.result.failures.filter(
      (failure) =>
        failure.name.toLowerCase().includes(needle) ||
        (failure.path ?? '').toLowerCase().includes(needle),
    );
    const failures = [...matching, ...output.result.failures.filter((failure) => !matching.includes(failure))];

    const data = {
      ...output.result,
      failures,
      selection,
      matchedFailures: matching.length,
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
        `${output.commandLine} exited 0 but printed no machine-readable test summary — the result is UNVERIFIED`,
        data,
        {
          warnings: [
            ...output.notes,
            `the run for ${args.target} could not be verified from the output: check the log or project.test_command`,
          ],
        },
      );
    }
    if (output.result.status === 'no_tests') {
      return ok(`${output.commandLine} collected no tests for ${args.target}`, data, {
        warnings: [
          ...output.notes,
          `the target ${args.target} did not select any test: check the spelling or run run_tests to see the suite`,
        ],
      });
    }

    const summary = [
      `target ${args.target} selected ${output.result.total} test(s)`,
      `${output.result.passed} passed`,
      output.result.skipped > 0 ? `${output.result.skipped} skipped` : undefined,
      formatDuration(output.result.durationMs),
      `log: ${output.logFile}`,
    ]
      .filter((part): part is string => part !== undefined)
      .join('; ');

    return ok(summary, data, { warnings: output.notes });
  },
});
