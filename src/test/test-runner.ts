import type { DevPilotConfig } from '../config/config-schema.js';
import type { Logger } from '../log/logger.js';
import type { JobRecord, TestResult, TestStatus } from '../types/execution.js';
import type { Limits, ProjectProfile, WorkspacePaths } from '../types/workspace.js';
import { errors } from '../errors/devpilot-error.js';
import { evaluateCommand } from '../security/command-policy.js';
import { clampOutputBytes, clampTimeoutSeconds } from '../security/limits.js';
import { JobStore, jobLogFile, newJobId } from '../runner/job-store.js';
import { formatCommandLine, runExecutable } from '../runner/process-runner.js';
import { parseTestOutput } from './parse/index.js';
import { planTests, readNodeTestManifest } from './test-system.js';
import type { TestFramework } from './test-system.js';

/**
 * `run_tests` / `run_test` (docs/TOOLS.md Phase 5). The planner picks a deterministic command,
 * the command policy accepts it, process-runner executes it with a hard timeout, and the
 * framework's own summary is parsed into counts and failures. The raw output only ever lands
 * in the job log — the agent gets structure, not a log to read.
 */

export interface TestRunnerInput {
  root: string;
  paths: WorkspacePaths;
  config: DevPilotConfig;
  profile: ProjectProfile;
  filter?: string;
  file?: string;
  failFast?: boolean;
  extraArgs?: string[];
  timeoutSeconds?: number;
  logger?: Logger;
  limits: Limits;
}

export interface TestRunnerOutput {
  result: TestResult;
  framework: TestFramework;
  /** Framework whose summary produced the numbers (may differ when the script hides its runner). */
  parser: TestFramework | 'unknown';
  commandLine: string;
  logFile: string;
  timeoutSeconds: number;
  notes: string[];
}

export async function runTests(input: TestRunnerInput): Promise<TestRunnerOutput> {
  const { config, profile, paths } = input;
  const manifest = await readNodeTestManifest(input.root);
  const plan = planTests(
    { root: input.root, profile, config, manifest },
    {
      ...(input.filter === undefined ? {} : { filter: input.filter }),
      ...(input.file === undefined ? {} : { file: input.file }),
      ...(input.failFast === undefined ? {} : { failFast: input.failFast }),
      ...(input.extraArgs === undefined ? {} : { extraArgs: input.extraArgs }),
    },
  );

  if (!plan.supported) {
    throw errors.unsupportedProject(plan.reason ?? 'no test runner could be detected for this project');
  }

  const decision = evaluateCommand(plan.command, plan.args, { allowShell: config.security.allow_shell });
  if (!decision.allowed) {
    throw errors.commandNotAllowed(decision.reason ?? 'command rejected by policy', {
      rule: decision.rule,
      command: plan.command,
      args: plan.args,
    });
  }

  const timeoutSeconds = clampTimeoutSeconds(input.timeoutSeconds, input.limits.maxCommandSeconds);
  const maxBytes = clampOutputBytes(undefined, input.limits.maxOutputBytes);
  const jobId = newJobId('test');
  const logFile = jobLogFile(paths, jobId);
  const startedAt = new Date();
  const commandLine = formatCommandLine(plan.command, plan.args);

  const run = await runExecutable({
    command: plan.command,
    args: plan.args,
    cwd: input.root,
    timeoutMs: timeoutSeconds * 1000,
    maxStdoutBytes: maxBytes,
    maxStderrBytes: maxBytes,
    ...(input.logger === undefined ? {} : { logger: input.logger }),
    logFile,
    env: { DEVPILOT_JOB_ID: jobId, PYTHONUNBUFFERED: '1' },
  });

  const job: JobRecord = {
    jobId,
    kind: 'test',
    command: plan.command,
    args: plan.args,
    cwd: input.root,
    startedAt: startedAt.toISOString(),
    finishedAt: new Date().toISOString(),
    exitCode: run.exitCode,
    signal: run.signal,
    durationMs: run.durationMs,
    timedOut: run.timedOut,
    stdoutBytes: run.stdoutBytes,
    stderrBytes: run.stderrBytes,
    stdoutTruncated: run.stdoutTruncated,
    stderrTruncated: run.stderrTruncated,
    logFile,
  };
  await new JobStore(paths).record(job);

  const parsed = parseTestOutput(plan.framework, run.stdout, run.stderr);

  let status: TestStatus;
  if (run.timedOut) status = 'timeout';
  else if (run.exitCode === 0) {
    status = parsed.noTestsDetected || (parsed.parsed && parsed.total === 0) ? 'no_tests' : 'passed';
  } else if (parsed.failed > 0 || parsed.errors > 0) status = 'failed';
  else status = 'error';

  const notes = [...plan.notes];
  if (!parsed.parsed) {
    notes.push(
      `no machine-readable test summary was found in the output; read ${logFile} (counts are not reliable)`,
    );
  }
  if (parsed.parser !== plan.framework && parsed.parser !== 'unknown') {
    notes.push(`output was parsed as ${parsed.parser} although ${plan.framework} was planned`);
  }
  if (run.spawnError !== undefined) notes.push(run.spawnError);
  if (timeoutSeconds === input.limits.maxCommandSeconds && input.timeoutSeconds !== undefined) {
    notes.push(`timeoutSeconds was capped at the configured ceiling ${input.limits.maxCommandSeconds}s`);
  }
  if (input.file !== undefined && input.filter !== undefined && plan.framework === 'junit') {
    notes.push('this runner accepts either a file or a filter, not both: the file selector won');
  }

  const result: TestResult = {
    status,
    framework: plan.framework,
    command: commandLine,
    durationMs: run.durationMs,
    total: parsed.total,
    passed: parsed.passed,
    failed: parsed.failed,
    skipped: parsed.skipped,
    errors: parsed.errors,
    failures: parsed.failures,
    job,
    parsed: parsed.parsed,
  };
  if (parsed.slowest.length > 0) result.durations = { slowest: parsed.slowest };

  return {
    result,
    framework: plan.framework,
    parser: parsed.parser,
    commandLine,
    logFile,
    timeoutSeconds,
    notes,
  };
}
