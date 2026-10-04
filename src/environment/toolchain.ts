import { promises as fs } from 'node:fs';

import type { Logger } from '../log/logger.js';
import { runExecutable, runProcess } from '../runner/process-runner.js';

/**
 * Toolchain probing for `doctor` (docs/ROADMAP.md Phase 9).
 *
 * Two rules shape this module:
 *  - probes go through `process-runner` (the single OS gate), always with a timeout, and never
 *    through a shell — a missing tool must come back as "absent", not as a stack trace;
 *  - a version is only reported when it was actually parsed out of the tool's own output. A probe
 *    that timed out or printed something unrecognised reports `found: true` with no version, so the
 *    report never invents one.
 */

export interface ProbeOutcome {
  name: string;
  found: boolean;
  version?: string;
  detail?: string;
  /** Raw combined output, truncated — kept for the verbose report and conflict messages. */
  output: string;
  exitCode: number | null;
  timedOut: boolean;
  spawnError?: string;
}

export interface ToolSpec {
  name: string;
  command: string;
  args: readonly string[];
  /** Applied to stdout+stderr; the first capture group is the version. */
  versionPattern?: RegExp;
  /** Extra facts parsed from the same output (GPU name, driver, ...). */
  detail?: (text: string) => string | undefined;
  /** Tools that only exist on some platforms; absent elsewhere is not a problem. */
  platforms?: readonly NodeJS.Platform[];
  /** Reported as WARNING instead of ERROR when missing. */
  optional?: boolean;
  fix: string;
}

const firstLine = (text: string): string | undefined => {
  const line = text.split(/\r?\n/).find((candidate) => candidate.trim() !== '');
  return line?.trim();
};

/** Toolchain probes, in the order the roadmap lists them. */
export const TOOLS: readonly ToolSpec[] = [
  { name: 'git', command: 'git', args: ['--version'], versionPattern: /(\d+\.\d+\.\d+)/, fix: 'install Git and put it on PATH' },
  { name: 'node', command: 'node', args: ['--version'], versionPattern: /v?(\d+\.\d+\.\d+)/, fix: 'install Node.js 20.11+' },
  { name: 'npm', command: 'npm', args: ['--version'], versionPattern: /(\d+\.\d+\.\d+)/, optional: true, fix: 'ships with Node.js' },
  { name: 'pnpm', command: 'pnpm', args: ['--version'], versionPattern: /(\d+\.\d+\.\d+)/, optional: true, fix: 'npm i -g pnpm' },
  { name: 'yarn', command: 'yarn', args: ['--version'], versionPattern: /(\d+\.\d+\.\d+)/, optional: true, fix: 'npm i -g yarn' },
  { name: 'python', command: 'python', args: ['--version'], versionPattern: /Python (\d+\.\d+\.\d+)/, fix: 'install Python and put it on PATH' },
  { name: 'python3', command: 'python3', args: ['--version'], versionPattern: /Python (\d+\.\d+\.\d+)/, optional: true, fix: 'only needed on systems where python3 is the real interpreter' },
  { name: 'pip', command: 'pip', args: ['--version'], versionPattern: /pip (\d+\.\d+(?:\.\d+)?)/, optional: true, fix: 'python -m ensurepip --upgrade' },
  { name: 'conda', command: 'conda', args: ['--version'], versionPattern: /conda (\d+\.\d+\.\d+)/, optional: true, fix: 'install Miniconda if you use conda environments' },
  { name: 'java', command: 'java', args: ['-version'], versionPattern: /version "?(\d+[0-9._]*)"/, fix: 'install a JDK and set JAVA_HOME' },
  { name: 'javac', command: 'javac', args: ['-version'], versionPattern: /javac (\d+[0-9._]*)/, optional: true, fix: 'install a JDK (not just a JRE)' },
  { name: 'mvn', command: 'mvn', args: ['-version'], versionPattern: /Apache Maven (\d+\.\d+\.\d+)/, optional: true, fix: 'install Maven or use the ./mvnw wrapper' },
  { name: 'gradle', command: 'gradle', args: ['--version'], versionPattern: /Gradle (\d+\.\d+(?:\.\d+)?)/, optional: true, fix: 'install Gradle or use the ./gradlew wrapper' },
  { name: 'docker', command: 'docker', args: ['--version'], versionPattern: /Docker version (\d+\.\d+\.\d+)/, optional: true, fix: 'install Docker Desktop' },
  { name: 'wsl', command: 'wsl', args: ['--status'], platforms: ['win32'], optional: true, fix: 'wsl --install (only needed for Linux-based projects)' },
  { name: 'nvcc', command: 'nvcc', args: ['--version'], versionPattern: /release (\d+\.\d+)/, optional: true, fix: 'install the CUDA toolkit (only needed to build CUDA kernels)' },
  {
    name: 'gpu',
    command: 'nvidia-smi',
    args: ['--query-gpu=name,memory.total,driver_version', '--format=csv,noheader'],
    detail: firstLine,
    optional: true,
    fix: 'install an NVIDIA driver (only needed for GPU work)',
  },
];

/** Parse a version out of a tool's output, or report that nothing recognisable was printed. */
export function parseToolVersion(text: string, pattern: RegExp): string | undefined {
  const match = pattern.exec(text);
  return match?.[1];
}

export async function probeTool(
  spec: ToolSpec,
  cwd: string,
  timeoutMs: number,
  logger?: Logger,
): Promise<ProbeOutcome> {
  if (spec.platforms !== undefined && !spec.platforms.includes(process.platform)) {
    return { name: spec.name, found: false, output: '', exitCode: null, timedOut: false };
  }

  const result = await runExecutable({
    command: spec.command,
    args: spec.args,
    cwd,
    timeoutMs,
    maxStdoutBytes: 32 * 1024,
    maxStderrBytes: 32 * 1024,
    ...(logger === undefined ? {} : { logger }),
  });

  const combined = `${result.stdout}\n${result.stderr}`.trim();
  const version =
    result.exitCode === 0 || combined !== ''
      ? (spec.versionPattern === undefined ? undefined : parseToolVersion(combined, spec.versionPattern))
      : undefined;

  const outcome: ProbeOutcome = {
    name: spec.name,
    // A tool that ran and printed something is present even if Node could not spawn it cleanly.
    found: result.spawnError === undefined && !result.timedOut && (result.exitCode === 0 || combined !== ''),
    output: combined.slice(0, 2_000),
    exitCode: result.exitCode,
    timedOut: result.timedOut,
  };
  if (version !== undefined) outcome.version = version;
  const detail = spec.detail?.(combined);
  if (detail !== undefined) outcome.detail = detail;
  if (result.spawnError !== undefined) outcome.spawnError = result.spawnError;
  return outcome;
}

/**
 * Every path a command resolves to, in PATH order. `where`/`which` list all of them, which is the
 * only reliable way to see a second Python or a second JDK that will win for some invocations and
 * lose for others.
 */
export async function resolvePaths(
  command: string,
  cwd: string,
  timeoutMs: number,
): Promise<string[]> {
  const windows = process.platform === 'win32';
  const result = await runProcess({
    command: windows ? 'where' : 'which',
    args: windows ? [command] : ['-a', command],
    cwd,
    timeoutMs,
    maxStdoutBytes: 16 * 1024,
    maxStderrBytes: 8 * 1024,
  });
  if (result.exitCode !== 0) return [];
  return result.stdout
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line !== '' && /[\\/]/.test(line));
}

/** Read a torch install's versions without importing the project (short-lived interpreter probe). */
export async function probeTorch(
  pythonCommand: string,
  cwd: string,
  timeoutMs: number,
): Promise<{ version: string; cuda?: string; available: boolean } | undefined> {
  const result = await runProcess({
    command: pythonCommand,
    args: [
      '-c',
      'import torch;print(torch.__version__, torch.version.cuda, torch.cuda.is_available())',
    ],
    cwd,
    timeoutMs,
    maxStdoutBytes: 8 * 1024,
    maxStderrBytes: 8 * 1024,
  });
  if (result.exitCode !== 0) return undefined;
  const [version, cuda, available] = result.stdout.trim().split(/\s+/);
  if (version === undefined) return undefined;
  return {
    version,
    ...(cuda === undefined || cuda === 'None' ? {} : { cuda }),
    available: available === 'True',
  };
}

export async function pathExists(target: string): Promise<boolean> {
  try {
    await fs.access(target);
    return true;
  } catch {
    return false;
  }
}

export async function readTextIfExists(target: string): Promise<string | undefined> {
  try {
    return await fs.readFile(target, 'utf8');
  } catch {
    return undefined;
  }
}
