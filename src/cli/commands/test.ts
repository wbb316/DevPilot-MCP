import path from 'node:path';

import type { CliIo } from '../cli.js';
import { errors } from '../../errors/devpilot-error.js';
import { resolveLimits } from '../../config/config-schema.js';
import { WorkspaceManager } from '../../workspace/workspace-manager.js';
import { runTests } from '../../test/test-runner.js';
import { formatDuration } from '../../util/format.js';

export interface TestCommandOptions {
  target: string;
  filter?: string;
  file?: string;
  failFast: boolean;
  json: boolean;
}

/**
 * `devpilot test [path]` — the same work as the `run_tests` tool, for a human.
 * Exit codes follow the usual convention: 0 passed, 1 tests failed or none were collected,
 * 2 a DevPilot error (thrown and mapped by the CLI entry point).
 */
export async function testCommand(io: CliIo, options: TestCommandOptions): Promise<number> {
  const manager = new WorkspaceManager({ env: io.env });
  const opened = await manager.openWorkspace({
    path: path.resolve(options.target),
    createConfig: false,
  });
  const id = opened.workspace.id;
  const config = manager.configOf(id);
  const paths = manager.pathsOf(id);
  if (config === undefined || paths === undefined) {
    throw errors.internal('workspace configuration is not loaded after a successful open');
  }

  const output = await runTests({
    root: opened.workspace.root,
    paths,
    config,
    profile: opened.workspace.profile,
    ...(options.filter === undefined ? {} : { filter: options.filter }),
    ...(options.file === undefined ? {} : { file: options.file }),
    failFast: options.failFast,
    logger: manager.loggerOf(id),
    limits: resolveLimits(config),
  });

  const { result } = output;

  if (options.json) {
    io.stdout(`${JSON.stringify({ ...result, parser: output.parser, logFile: output.logFile }, null, 2)}\n`);
  } else {
    const lines = [
      `Framework   : ${result.framework} (parsed as ${output.parser})`,
      `Command     : ${output.commandLine}`,
      `Status      : ${result.status}`,
      `Tests       : ${result.passed}/${result.total} passed, ${result.failed} failed, ${result.errors} errors, ${result.skipped} skipped`,
      `Duration    : ${formatDuration(result.durationMs)}`,
      `Log         : ${output.logFile}`,
    ];
    for (const failure of result.failures.slice(0, 10)) {
      const location = `${failure.path ?? failure.suite ?? '?'}${failure.line === undefined ? '' : `:${failure.line}`}`;
      lines.push(`Failure     : ${failure.name} (${location}) — ${failure.message}`);
    }
    if (result.failures.length > 10) lines.push(`Failure     : … ${result.failures.length - 10} more in the log`);
    for (const note of output.notes) lines.push(`Note        : ${note}`);
    io.stdout(`${lines.join('\n')}\n`);
  }

  if (result.status === 'passed') return 0;
  if (result.status === 'unknown') {
    io.stderr('devpilot: the runner printed no machine-readable summary — the run is unverified\n');
    return 1;
  }
  if (result.status === 'no_tests') {
    io.stderr('devpilot: no tests were collected (check the filter/file or project.test_command)\n');
    return 1;
  }
  if (result.status === 'timeout') {
    io.stderr('devpilot: the test command exceeded its timeout and was terminated\n');
    return 1;
  }
  return 1;
}
