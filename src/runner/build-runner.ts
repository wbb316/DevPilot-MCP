import { promises as fs } from 'node:fs';
import path from 'node:path';

import type { DevPilotConfig } from '../config/config-schema.js';
import type { Logger } from '../log/logger.js';
import type { BuildResult, JobRecord } from '../types/execution.js';
import type { Limits, ProjectProfile, WorkspacePaths } from '../types/workspace.js';
import { errors } from '../errors/devpilot-error.js';
import { evaluateCommand } from '../security/command-policy.js';
import { clampOutputBytes, clampTimeoutSeconds } from '../security/limits.js';
import { findBuildArtifacts, planBuild } from './build-system.js';
import type { BuildPlan, BuildTarget } from './build-system.js';
import { parseIssues } from './issue-parser.js';
import { JobStore, jobLogFile, newJobId } from './job-store.js';
import { formatCommandLine, runExecutable } from './process-runner.js';

/**
 * `build_project` (docs/TOOLS.md Phase 4). Everything runs through process-runner — the one
 * gate to the OS — after the plan has been accepted by the command policy, and every
 * invocation is recorded in the job ledger with a raw log artifact.
 */

export interface BuildRunnerInput {
  root: string;
  paths: WorkspacePaths;
  config: DevPilotConfig;
  profile: ProjectProfile;
  target: BuildTarget;
  clean: boolean;
  timeoutSeconds?: number;
  extraArgs?: string[];
  logger?: Logger;
  limits: Limits;
}

export interface BuildRunnerOutput {
  result: BuildResult;
  plan: BuildPlan;
  commandLine: string;
  timeoutSeconds: number;
}

/** package.json scripts, read at run time (ProjectProfile deliberately does not carry them). */
async function readNodeScripts(root: string): Promise<Record<string, string>> {
  try {
    const raw = await fs.readFile(path.join(root, 'package.json'), 'utf8');
    const parsed = JSON.parse(raw) as { scripts?: Record<string, string> };
    return parsed.scripts ?? {};
  } catch {
    return {};
  }
}

export async function runBuild(input: BuildRunnerInput): Promise<BuildRunnerOutput> {
  const { config, profile, paths } = input;
  const plan = planBuild(
    {
      root: input.root,
      ...(profile.buildSystem === undefined ? {} : { buildSystem: profile.buildSystem }),
      projectType: profile.projectType,
      ...(profile.framework === undefined ? {} : { framework: profile.framework }),
      markers: profile.markers,
      scripts: await readNodeScripts(input.root),
      sourceDirs: profile.sourceDirs,
      override: config.project.build_command,
    },
    input.target,
    input.clean,
  );

  if (!plan.supported) {
    throw errors.unsupportedProject(
      `cannot build target "${input.target}": ${plan.reason ?? 'unsupported project'} (project type: ${profile.projectType})`,
    );
  }

  const args = [...plan.args, ...(input.extraArgs ?? [])];
  const decision = evaluateCommand(plan.command, args, { allowShell: config.security.allow_shell });
  if (!decision.allowed) {
    throw errors.commandNotAllowed(decision.reason ?? 'command rejected by policy', {
      rule: decision.rule,
      command: plan.command,
      args,
    });
  }

  const timeoutSeconds = clampTimeoutSeconds(input.timeoutSeconds, input.limits.maxCommandSeconds);
  const maxBytes = clampOutputBytes(undefined, input.limits.maxOutputBytes);
  const jobId = newJobId('build');
  const logFile = jobLogFile(paths, jobId);
  const startedAt = new Date();
  const commandLine = formatCommandLine(plan.command, args);

  const run = await runExecutable({
    command: plan.command,
    args,
    cwd: input.root,
    timeoutMs: timeoutSeconds * 1000,
    maxStdoutBytes: maxBytes,
    maxStderrBytes: maxBytes,
    ...(plan.resolvedPath === undefined ? {} : { resolved: plan.resolvedPath }),
    ...(input.logger === undefined ? {} : { logger: input.logger }),
    logFile,
    env: { DEVPILOT_JOB_ID: jobId, PYTHONUNBUFFERED: '1' },
  });

  const job: JobRecord = {
    jobId,
    kind: 'build',
    command: plan.command,
    args,
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

  const issues = parseIssues(run.stdout, run.stderr);
  const status: BuildResult['status'] = run.timedOut
    ? 'timeout'
    : run.exitCode === 0
      ? 'success'
      : 'failed';

  const result: BuildResult = {
    status,
    system: plan.system,
    command: commandLine,
    durationMs: run.durationMs,
    errors: issues.errors,
    warnings: issues.warnings,
    job,
  };

  if (run.spawnError !== undefined) {
    result.errors.unshift({ severity: 'error', message: run.spawnError });
  }
  if (status === 'success' && input.target === 'package') {
    const artifacts = await findBuildArtifacts(input.root, plan.system);
    if (artifacts.length > 0) result.artifacts = artifacts;
  }

  return { result, plan, commandLine, timeoutSeconds };
}
