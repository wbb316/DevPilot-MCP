import type { GitState } from '../types/workspace.js';
import type { Logger } from '../log/logger.js';
import { errors } from '../errors/devpilot-error.js';
import { formatCommandLine, runProcess, type ProcessRunResult } from '../runner/process-runner.js';

/**
 * Git access is read-mostly. Destructive commands are never issued from here
 * (docs/WORKSPACE-LIFECYCLE.md §6): no `reset --hard`, no `checkout -f`, no `clean -fd`.
 *
 * Phase 1 implements the snapshot used by `open_workspace`; Phase 7 adds diff analysis
 * and checkpoints on top of this class.
 */

export interface GitRunOptions {
  allowFailure?: boolean;
  timeoutMs?: number;
}

export interface GitManagerOptions {
  cwd: string;
  logger?: Logger;
  timeoutMs?: number;
}

export function parseStatusPorcelain(lines: readonly string[]): {
  changed: number;
  untracked: number;
} {
  let changed = 0;
  let untracked = 0;
  for (const line of lines) {
    if (line.trim() === '') continue;
    if (line.startsWith('??')) untracked += 1;
    else changed += 1;
  }
  return { changed, untracked };
}

export class GitManager {
  readonly cwd: string;
  private readonly logger?: Logger;
  private readonly timeoutMs: number;
  private availability?: boolean;

  constructor(options: GitManagerOptions) {
    this.cwd = options.cwd;
    this.logger = options.logger;
    this.timeoutMs = options.timeoutMs ?? 15_000;
  }

  async run(args: readonly string[], options: GitRunOptions = {}): Promise<ProcessRunResult> {
    const result = await runProcess({
      command: 'git',
      args: [...args],
      cwd: this.cwd,
      timeoutMs: options.timeoutMs ?? this.timeoutMs,
      maxStdoutBytes: 1_048_576,
      maxStderrBytes: 65_536,
      logger: this.logger,
    });
    if (result.spawnError) {
      if (options.allowFailure) return result;
      throw errors.gitNotAvailable(result.spawnError);
    }
    if (result.exitCode !== 0 && !options.allowFailure) {
      throw errors.gitFailed(args, result.stderr.trim() || `exit code ${result.exitCode}`);
    }
    return result;
  }

  async isAvailable(): Promise<boolean> {
    if (this.availability !== undefined) return this.availability;
    const result = await runProcess({
      command: 'git',
      args: ['--version'],
      cwd: this.cwd,
      timeoutMs: 10_000,
      maxStdoutBytes: 4096,
      maxStderrBytes: 4096,
    });
    this.availability = result.spawnError === undefined && result.exitCode === 0;
    return this.availability;
  }

  /** The repository that owns `cwd` — `cwd` itself may be a subdirectory. */
  async repositoryRoot(): Promise<string | undefined> {
    const result = await this.run(['rev-parse', '--show-toplevel'], { allowFailure: true });
    if (result.exitCode !== 0) return undefined;
    const value = result.stdout.trim();
    return value === '' ? undefined : value;
  }

  async isRepo(): Promise<boolean> {
    return (await this.repositoryRoot()) !== undefined;
  }

  async statusPorcelain(): Promise<string[]> {
    const result = await this.run(['status', '--porcelain=v1', '--untracked-files=normal'], {
      allowFailure: true,
    });
    if (result.exitCode !== 0) return [];
    return result.stdout.split(/\r?\n/).filter((line) => line.trim() !== '');
  }

  /** Full snapshot used by `open_workspace` and `get_workspace_status`. */
  async probe(): Promise<GitState> {
    if (!(await this.isAvailable())) {
      return { available: false, isRepo: false, error: 'git binary not found on PATH' };
    }
    const repoRoot = await this.repositoryRoot();
    if (!repoRoot) {
      return { available: true, isRepo: false };
    }

    const branchResult = await this.run(['rev-parse', '--abbrev-ref', 'HEAD'], { allowFailure: true });
    const headResult = await this.run(['rev-parse', '--short', 'HEAD'], { allowFailure: true });
    const branchRaw = branchResult.stdout.trim();
    const branch = branchResult.exitCode === 0 && branchRaw !== '' ? branchRaw : undefined;
    const head = headResult.exitCode === 0 ? headResult.stdout.trim() || undefined : undefined;

    const lines = await this.statusPorcelain();
    const { changed, untracked } = parseStatusPorcelain(lines);

    const state: GitState = {
      available: true,
      isRepo: true,
      dirty: changed > 0,
      changedFiles: changed,
      untrackedFiles: untracked,
    };
    if (branch !== undefined) state.branch = branch;
    if (head !== undefined) state.head = head;
    return state;
  }

  /** Correlation-friendly description of a command for logs and error messages. */
  describe(args: readonly string[]): string {
    return formatCommandLine('git', args);
  }
}
