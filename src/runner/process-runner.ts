import { spawn } from 'node:child_process';
import { promises as fs } from 'node:fs';
import path from 'node:path';

import type { Logger } from '../log/logger.js';
import { errors } from '../errors/devpilot-error.js';
import { ensureDir } from '../storage/paths.js';
import { containsShellMetacharacters } from '../security/command-policy.js';

/**
 * THE single gate to the operating system (docs/ARCHITECTURE.md §4.5).
 *
 * No other module may import `node:child_process`. Every invocation:
 *  - runs with an explicit cwd,
 *  - has a mandatory timeout and stdout/stderr caps,
 *  - never passes through a shell unless the caller explicitly asks and policy allowed it,
 *  - can tee raw output into a workspace log file for artifact pointers.
 */

export interface ProcessRunOptions {
  command: string;
  args?: readonly string[];
  cwd: string;
  /** Hard ceiling; the child tree is killed when it elapses. */
  timeoutMs?: number;
  maxStdoutBytes?: number;
  maxStderrBytes?: number;
  env?: Record<string, string | undefined>;
  shell?: boolean;
  /**
   * Hand the argument string to CreateProcess verbatim (no Node-side quoting). Required
   * when wrapping a Windows batch shim: cmd.exe does not understand the `\"` escaping Node
   * applies to arguments that contain quotes.
   */
  windowsVerbatimArguments?: boolean;
  logger?: Logger;
  /** Tee the captured output into this file (becomes `artifacts.log`). */
  logFile?: string;
}

export interface ProcessRunResult {
  command: string;
  args: string[];
  cwd: string;
  exitCode: number | null;
  signal: string | null;
  timedOut: boolean;
  durationMs: number;
  stdout: string;
  stderr: string;
  stdoutBytes: number;
  stderrBytes: number;
  stdoutTruncated: boolean;
  stderrTruncated: boolean;
  /** Populated when the process could not be started at all. */
  spawnError?: string;
}

export function formatCommandLine(command: string, args: readonly string[] = []): string {
  const quote = (value: string): string => (/[\s"]/.test(value) ? `"${value}"` : value);
  return [quote(command), ...args.map(quote)].join(' ');
}

/**
 * Deterministic split of a rule-inferred command line ("python train.py", "mvn -q test").
 * Honours double quotes; no shell expansion ever happens.
 */
export function splitCommandLine(line: string): { command: string; args: string[] } {
  const parts: string[] = [];
  let current = '';
  let quoted = false;
  for (const char of line.trim()) {
    if (char === '"') {
      quoted = !quoted;
      continue;
    }
    if (!quoted && /\s/.test(char)) {
      if (current !== '') {
        parts.push(current);
        current = '';
      }
      continue;
    }
    current += char;
  }
  if (current !== '') parts.push(current);
  const [command = '', ...args] = parts;
  return { command, args };
}

function buildEnv(extra?: Record<string, string | undefined>): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env };
  for (const [key, value] of Object.entries(extra ?? {})) {
    if (value === undefined) delete env[key];
    else env[key] = value;
  }
  // Keep child output stable and parseable regardless of the caller's locale.
  env['NO_COLOR'] = '1';
  env['CI'] = env['CI'] ?? '1';
  return env;
}

/** Kill an entire process tree; Windows needs taskkill for the `/T` semantics. */
export async function killTree(pid: number | undefined): Promise<void> {
  if (pid === undefined) return;
  if (process.platform === 'win32') {
    await new Promise<void>((resolve) => {
      const killer = spawn('taskkill', ['/pid', String(pid), '/T', '/F'], {
        windowsHide: true,
        stdio: 'ignore',
      });
      killer.on('error', () => resolve());
      killer.on('close', () => resolve());
      setTimeout(resolve, 5000);
    });
    return;
  }
  try {
    process.kill(pid, 'SIGKILL');
  } catch {
    /* already gone */
  }
}

export async function runProcess(options: ProcessRunOptions): Promise<ProcessRunResult> {
  const args = [...(options.args ?? [])];
  const maxStdout = options.maxStdoutBytes ?? 262_144;
  const maxStderr = options.maxStderrBytes ?? 262_144;
  const startedAt = Date.now();

  const stdoutChunks: Buffer[] = [];
  const stderrChunks: Buffer[] = [];
  let stdoutBytes = 0;
  let stderrBytes = 0;

  let child;
  try {
    child = spawn(options.command, args, {
      cwd: options.cwd,
      env: buildEnv(options.env),
      shell: options.shell ?? false,
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe'],
      ...(options.windowsVerbatimArguments === true ? { windowsVerbatimArguments: true } : {}),
    });
  } catch (error) {
    return {
      command: options.command,
      args,
      cwd: options.cwd,
      exitCode: null,
      signal: null,
      timedOut: false,
      durationMs: Date.now() - startedAt,
      stdout: '',
      stderr: '',
      stdoutBytes: 0,
      stderrBytes: 0,
      stdoutTruncated: false,
      stderrTruncated: false,
      spawnError: error instanceof Error ? error.message : String(error),
    };
  }

  let timedOut = false;
  const timer =
    options.timeoutMs && options.timeoutMs > 0
      ? setTimeout(() => {
          timedOut = true;
          void killTree(child.pid);
        }, options.timeoutMs)
      : undefined;

  child.stdout?.on('data', (chunk: Buffer) => {
    stdoutBytes += chunk.length;
    if (stdoutBytes <= maxStdout) stdoutChunks.push(chunk);
    else if (stdoutChunks.reduce((sum, part) => sum + part.length, 0) < maxStdout) {
      const remaining = maxStdout - stdoutChunks.reduce((sum, part) => sum + part.length, 0);
      if (remaining > 0) stdoutChunks.push(chunk.subarray(0, remaining));
    }
  });
  child.stderr?.on('data', (chunk: Buffer) => {
    stderrBytes += chunk.length;
    if (stderrBytes <= maxStderr) stderrChunks.push(chunk);
    else if (stderrChunks.reduce((sum, part) => sum + part.length, 0) < maxStderr) {
      const remaining = maxStderr - stderrChunks.reduce((sum, part) => sum + part.length, 0);
      if (remaining > 0) stderrChunks.push(chunk.subarray(0, remaining));
    }
  });

  const result = await new Promise<ProcessRunResult>((resolve) => {
    let settled = false;
    const finish = (exitCode: number | null, signal: string | null, spawnError?: string): void => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      resolve({
        command: options.command,
        args,
        cwd: options.cwd,
        exitCode,
        signal,
        timedOut,
        durationMs: Date.now() - startedAt,
        stdout: Buffer.concat(stdoutChunks).toString('utf8'),
        stderr: Buffer.concat(stderrChunks).toString('utf8'),
        stdoutBytes,
        stderrBytes,
        stdoutTruncated: stdoutBytes > maxStdout,
        stderrTruncated: stderrBytes > maxStderr,
        ...(spawnError === undefined ? {} : { spawnError }),
      });
    };

    child.on('error', (error: Error) => finish(null, null, error.message));
    child.on('close', (code: number | null, signal: NodeJS.Signals | null) =>
      finish(code, signal ?? null),
    );
  });

  options.logger?.debug('process finished', {
    command: formatCommandLine(options.command, args),
    exitCode: result.exitCode,
    timedOut: result.timedOut,
    durationMs: result.durationMs,
  });

  if (options.logFile) {
    await ensureDir(path.dirname(options.logFile));
    const header = [
      `# command : ${formatCommandLine(options.command, args)}`,
      `# cwd     : ${options.cwd}`,
      `# started : ${new Date(startedAt).toISOString()}`,
      `# exit    : ${result.exitCode ?? 'null'}${result.signal ? ` (signal ${result.signal})` : ''}`,
      `# timeout : ${result.timedOut}`,
      `# bytes   : stdout=${result.stdoutBytes} stderr=${result.stderrBytes}`,
      '',
    ].join('\n');
    await fs.writeFile(
      options.logFile,
      `${header}--- stdout ---\n${result.stdout}\n--- stderr ---\n${result.stderr}\n`,
      'utf8',
    );
  }

  return result;
}

const WINDOWS_EXTENSIONS = ['.exe', '.cmd', '.bat', '.com'];

/**
 * Locate an executable without invoking a shell. `.cmd`/`.bat` shims (npm, mvn, gradlew)
 * are resolved to their real path and run through cmd.exe by {@link runProcess}.
 */
export async function resolveExecutable(
  command: string,
  env: NodeJS.ProcessEnv = process.env,
): Promise<string | undefined> {
  const candidates: string[] = [];
  const hasExtension = path.extname(command) !== '';

  if (path.isAbsolute(command)) {
    candidates.push(command);
  } else if (command.includes('/') || command.includes('\\')) {
    candidates.push(path.resolve(command));
  } else {
    const pathValue = env['PATH'] ?? env['Path'] ?? '';
    const dirs = pathValue.split(path.delimiter).filter((dir) => dir.trim() !== '');
    const extensions =
      process.platform === 'win32'
        ? hasExtension
          ? ['']
          : [...WINDOWS_EXTENSIONS, '']
        : [''];
    for (const dir of dirs) {
      for (const extension of extensions) candidates.push(path.join(dir, `${command}${extension}`));
    }
  }

  for (const candidate of candidates) {
    try {
      const stat = await fs.stat(candidate);
      if (stat.isFile()) return candidate;
    } catch {
      /* keep looking */
    }
  }
  return undefined;
}

export function isWindowsScript(file: string): boolean {
  const extension = path.extname(file).toLowerCase();
  return process.platform === 'win32' && (extension === '.cmd' || extension === '.bat');
}

/** Quote one token for a cmd.exe command line (only when it needs it). */
function quoteWindowsArg(value: string): string {
  return /[\s&^|<>]/.test(value) ? `"${value}"` : value;
}

/**
 * Run an executable that may be a Windows batch shim. Arguments are already validated by
 * the command policy, and this function refuses anything that still looks like shell
 * syntax, so wrapping in cmd.exe cannot become a shell injection vector.
 */
export async function runExecutable(
  options: ProcessRunOptions & { resolved?: string },
): Promise<ProcessRunResult> {
  const resolved = options.resolved ?? (await resolveExecutable(options.command));
  if (!resolved) {
    return {
      command: options.command,
      args: [...(options.args ?? [])],
      cwd: options.cwd,
      exitCode: null,
      signal: null,
      timedOut: false,
      durationMs: 0,
      stdout: '',
      stderr: '',
      stdoutBytes: 0,
      stderrBytes: 0,
      stdoutTruncated: false,
      stderrTruncated: false,
      spawnError: `executable not found on PATH: ${options.command}`,
    };
  }

  const args = [...(options.args ?? [])];
  if (!isWindowsScript(resolved)) return runProcess({ ...options, command: resolved, args });

  for (const arg of args) {
    if (containsShellMetacharacters(arg)) {
      throw errors.commandNotAllowed(
        `refusing to pass ${JSON.stringify(arg)} to a Windows command shim`,
        { resolved, args },
      );
    }
  }

  const comSpec = process.env['ComSpec'] ?? process.env['comspec'] ?? 'cmd.exe';
  // The whole line is assembled here and passed verbatim: Node would otherwise escape the
  // quotes around the shim path as \" — which cmd.exe does not understand — and every
  // npm/mvn/gradlew invocation would fail with "is not recognized as an internal command".
  // `cmd /s /c "…"` strips this outer pair again, leaving `"<shim>" <args>`.
  const inner = [quoteWindowsArg(resolved), ...args.map(quoteWindowsArg)].join(' ');
  return runProcess({
    ...options,
    command: comSpec,
    args: ['/d', '/s', '/c', `"${inner}"`],
    windowsVerbatimArguments: true,
  });
}
