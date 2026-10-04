import path from 'node:path';

import type { DevPilotConfig } from '../config/config-schema.js';
import type { Logger } from '../log/logger.js';
import type { JobRecord, RunResult } from '../types/execution.js';
import type { Limits, ProjectProfile, WorkspacePaths } from '../types/workspace.js';
import { errors } from '../errors/devpilot-error.js';
import { evaluateCommand } from '../security/command-policy.js';
import { isInside } from '../security/path-policy.js';
import { clampOutputBytes, clampTimeoutSeconds } from '../security/limits.js';
import { tailLines } from './issue-parser.js';
import { JobStore, jobLogFile, newJobId } from './job-store.js';
import { formatCommandLine, runExecutable, splitCommandLine } from './process-runner.js';

/**
 * `run_project` (docs/TOOLS.md Phase 4). Resolution order: explicit `command` → the
 * project's own candidate (config / package.json / detector) → a rule-based inference from
 * the detected entrypoints. A command that never exits is *expected* for a service, so a
 * timeout is reported as COMMAND_TIMEOUT with the output captured so far.
 */

export interface RunRunnerInput {
  root: string;
  paths: WorkspacePaths;
  config: DevPilotConfig;
  profile: ProjectProfile;
  command?: string;
  args?: string[];
  env?: Record<string, string>;
  cwd?: string;
  timeoutSeconds?: number;
  maxOutputBytes?: number;
  logger?: Logger;
  limits: Limits;
  /** Lines kept in stdoutTail/stderrTail (default 40). */
  tailCount?: number;
}

export interface RunRunnerOutput {
  result: RunResult;
  commandLine: string;
  logFile: string;
  stdoutTail: string[];
  stderrTail: string[];
  timeoutSeconds: number;
  notes: string[];
}

interface ResolvedRunCommand {
  command: string;
  args: string[];
  source: 'explicit' | 'project' | 'inferred' | 'config';
  notes: string[];
  /** Environment the command needs (Phase 10: `PYTHONPATH=src` for a src-layout package). */
  env?: Record<string, string>;
}

function inferRunCommand(profile: ProjectProfile): ResolvedRunCommand | undefined {
  const entry = profile.entrypoints[0];
  const buildSystem = profile.buildSystem ?? '';

  if (buildSystem === 'maven' && profile.framework === 'Spring Boot') {
    return {
      command: 'mvn',
      args: ['-q', 'spring-boot:run'],
      source: 'inferred',
      notes: ['Spring Boot dev server: it does not exit, so a timeout is the normal outcome'],
    };
  }
  if (buildSystem === 'gradle' && profile.framework === 'Spring Boot') {
    return {
      command: process.platform === 'win32' ? 'gradlew.bat' : 'gradlew',
      args: ['bootRun', '--no-daemon'],
      source: 'inferred',
      notes: ['Spring Boot dev server via the Gradle wrapper: it does not exit'],
    };
  }
  if (buildSystem === 'pip' || buildSystem === 'poetry' || profile.projectType === 'PyTorch') {
    if (entry === undefined) return undefined;
    const prefix = buildSystem === 'poetry' ? ['run', 'python'] : ['python'];
    return {
      command: buildSystem === 'poetry' ? 'poetry' : 'python',
      args: [...prefix, entry],
      source: 'inferred',
      notes: [`started the detected entrypoint ${entry}`],
    };
  }
  if (buildSystem === 'npm' || buildSystem === 'pnpm' || buildSystem === 'yarn') {
    return undefined; // handled through profile.candidates.run when a start script exists
  }
  if (entry !== undefined && /\.(mjs|cjs|js)$/.test(entry)) {
    return { command: 'node', args: [entry], source: 'inferred', notes: [] };
  }
  return undefined;
}

export function resolveRunCommand(
  input: Pick<RunRunnerInput, 'config' | 'profile' | 'command' | 'args'>,
): ResolvedRunCommand {
  const extraArgs = input.args ?? [];
  const override = input.command?.trim();
  if (override !== undefined && override !== '') {
    const split = splitCommandLine(override);
    return {
      command: split.command,
      args: [...split.args, ...extraArgs],
      source: 'explicit',
      notes: ['command supplied by the caller'],
    };
  }

  const candidates = input.profile.candidates.run;
  if (candidates !== undefined && candidates.trim() !== '') {
    const split = splitCommandLine(candidates);
    const env = input.profile.candidates.runEnv;
    const notes = ['command taken from the project profile / config'];
    if (env !== undefined && Object.keys(env).length > 0) {
      notes.push(
        `the project needs ${Object.entries(env)
          .map(([key, value]) => `${key}=${value}`)
          .join(', ')} to start this way`,
      );
    }
    return {
      command: split.command,
      args: [...split.args, ...extraArgs],
      source: input.config.project.run_command === null ? 'project' : 'config',
      notes,
      ...(env === undefined ? {} : { env }),
    };
  }

  const inferred = inferRunCommand(input.profile);
  if (inferred === undefined) {
    throw errors.unsupportedProject(
      `no run command could be inferred for ${input.profile.projectType} (entrypoints: ${input.profile.entrypoints.join(', ') || 'none detected'})`,
    );
  }
  return { ...inferred, args: [...inferred.args, ...extraArgs] };
}

export async function runProject(input: RunRunnerInput): Promise<RunRunnerOutput> {
  const { config, profile, paths } = input;
  const resolved = resolveRunCommand(input);

  const decision = evaluateCommand(resolved.command, resolved.args, {
    allowShell: config.security.allow_shell,
  });
  if (!decision.allowed) {
    throw errors.commandNotAllowed(decision.reason ?? 'command rejected by policy', {
      rule: decision.rule,
      command: resolved.command,
      args: resolved.args,
    });
  }

  let cwd = input.root;
  if (input.cwd !== undefined && input.cwd.trim() !== '') {
    const resolvedCwd = path.resolve(input.root, input.cwd);
    if (!isInside(input.root, resolvedCwd)) {
      throw errors.pathOutsideWorkspace(resolvedCwd, input.root);
    }
    cwd = resolvedCwd;
  }

  const timeoutSeconds = clampTimeoutSeconds(input.timeoutSeconds, input.limits.maxCommandSeconds);
  const maxBytes = clampOutputBytes(input.maxOutputBytes, input.limits.maxOutputBytes);
  const jobId = newJobId('run');
  const logFile = jobLogFile(paths, jobId);
  const startedAt = new Date();
  const commandLine = formatCommandLine(resolved.command, resolved.args);

  const run = await runExecutable({
    command: resolved.command,
    args: resolved.args,
    cwd,
    timeoutMs: timeoutSeconds * 1000,
    maxStdoutBytes: maxBytes,
    maxStderrBytes: maxBytes,
    ...(input.logger === undefined ? {} : { logger: input.logger }),
    // Unbuffered python: a killed service must still have produced its output.
    env: { PYTHONUNBUFFERED: '1', ...(resolved.env ?? {}), ...(input.env ?? {}) },
    logFile,
  });

  const job: JobRecord = {
    jobId,
    kind: 'run',
    command: resolved.command,
    args: resolved.args,
    cwd,
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

  const status: RunResult['status'] = run.timedOut
    ? 'timeout'
    : run.exitCode === 0
      ? 'success'
      : 'failed';

  const notes = [...resolved.notes];
  if (resolved.source === 'inferred') notes.push(`run command was inferred, not declared`);
  if (profile.framework === 'Spring Boot' || profile.framework === 'FastAPI' || profile.framework === 'Flask') {
    notes.push('this project looks like a server: a timeout means it started and kept running');
  }
  if (timeoutSeconds === input.limits.maxCommandSeconds && input.timeoutSeconds !== undefined) {
    notes.push(`timeoutSeconds was capped at the configured ceiling ${input.limits.maxCommandSeconds}s`);
  }

  const result: RunResult = {
    status,
    command: commandLine,
    durationMs: run.durationMs,
    exitCode: run.exitCode,
    signal: run.signal,
    crashed: run.spawnError !== undefined,
    job,
  };

  if (run.spawnError !== undefined) notes.push(run.spawnError);

  return {
    result,
    commandLine,
    logFile,
    stdoutTail: tailLines(run.stdout, input.tailCount ?? 40),
    stderrTail: tailLines(run.stderr, input.tailCount ?? 40),
    timeoutSeconds,
    notes,
  };
}
