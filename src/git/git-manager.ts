import { promises as fs } from 'node:fs';
import path from 'node:path';

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
  maxStdoutBytes?: number;
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
      maxStdoutBytes: options.maxStdoutBytes ?? 1_048_576,
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

  // ---- Phase 7: read-only diff/graph helpers -------------------------------------------

  async revParse(ref: string): Promise<string | undefined> {
    const result = await this.run(['rev-parse', '--verify', '--quiet', ref], { allowFailure: true });
    if (result.exitCode !== 0) return undefined;
    const value = result.stdout.trim();
    return value === '' ? undefined : value;
  }

  /** False on an unborn branch (fresh `git init` with no commit yet). */
  async hasCommit(): Promise<boolean> {
    return (await this.revParse('HEAD')) !== undefined;
  }

  async currentBranch(): Promise<string | undefined> {
    const result = await this.run(['rev-parse', '--abbrev-ref', 'HEAD'], { allowFailure: true });
    if (result.exitCode !== 0) return undefined;
    const value = result.stdout.trim();
    return value === '' ? undefined : value;
  }

  async upstream(): Promise<{ name: string; ahead: number; behind: number } | undefined> {
    const nameResult = await this.run(['rev-parse', '--abbrev-ref', '--symbolic-full-name', '@{u}'], {
      allowFailure: true,
    });
    if (nameResult.exitCode !== 0) return undefined;
    const name = nameResult.stdout.trim();
    if (name === '') return undefined;
    const counts = await this.run(['rev-list', '--left-right', '--count', '@{u}...HEAD'], {
      allowFailure: true,
    });
    if (counts.exitCode !== 0) return { name, ahead: 0, behind: 0 };
    const [left, right] = counts.stdout.trim().split(/\s+/);
    const behind = Number.parseInt(left ?? '0', 10);
    const ahead = Number.parseInt(right ?? '0', 10);
    return {
      name,
      ahead: Number.isFinite(ahead) ? ahead : 0,
      behind: Number.isFinite(behind) ? behind : 0,
    };
  }

  /** `git diff <base>` for tracked files; `staged` compares index against base instead. */
  private diffArgs(base: string, staged: boolean, extra: readonly string[] = []): string[] {
    return staged
      ? ['diff', '--cached', base, ...extra]
      : ['diff', base, ...extra];
  }

  async diffNumstat(base: string, staged = false, maxBytes = 4_194_304): Promise<string> {
    const result = await this.run(this.diffArgs(base, staged, ['--numstat', '-M']), {
      allowFailure: true,
      maxStdoutBytes: maxBytes,
    });
    return result.exitCode === 0 ? result.stdout : '';
  }

  async diffNameStatus(base: string, staged = false, maxBytes = 4_194_304): Promise<string> {
    const result = await this.run(this.diffArgs(base, staged, ['--name-status', '-M']), {
      allowFailure: true,
      maxStdoutBytes: maxBytes,
    });
    return result.exitCode === 0 ? result.stdout : '';
  }

  /** Unified diff with zero context: the cheapest accurate source of changed line ranges. */
  async diffUnifiedZero(base: string, staged = false, maxBytes = 8_388_608): Promise<string> {
    const result = await this.run(this.diffArgs(base, staged, ['--unified=0', '-M']), {
      allowFailure: true,
      maxStdoutBytes: maxBytes,
    });
    return result.exitCode === 0 ? result.stdout : '';
  }

  async diffPatchText(base: string, staged = false, maxBytes = 8_388_608): Promise<string> {
    const result = await this.run(this.diffArgs(base, staged, ['--binary', '--patch', '-M']), {
      allowFailure: true,
      maxStdoutBytes: maxBytes,
    });
    return result.exitCode === 0 ? result.stdout : '';
  }

  /** porcelain status keyed by workspace-relative POSIX path. */
  async pathStatuses(): Promise<Map<string, string>> {
    const map = new Map<string, string>();
    for (const line of await this.statusPorcelain()) {
      const xy = line.slice(0, 2);
      const raw = line.slice(3).trim();
      if (raw === '') continue;
      const renamed = raw.includes(' -> ') ? raw.split(' -> ')[1] : raw;
      const normalized = (renamed ?? raw).replace(/^"|"$/g, '').split(path.sep).join('/');
      map.set(normalized, xy);
    }
    return map;
  }

  /** An in-progress merge/rebase/cherry-pick makes every write unsafe. */
  async midOperation(): Promise<string | undefined> {
    const dirResult = await this.run(['rev-parse', '--git-dir'], { allowFailure: true });
    if (dirResult.exitCode !== 0) return undefined;
    const gitDir = path.resolve(this.cwd, dirResult.stdout.trim());
    const markers: [string, string][] = [
      ['MERGE_HEAD', 'merge'],
      ['rebase-merge', 'rebase'],
      ['rebase-apply', 'rebase'],
      ['CHERRY_PICK_HEAD', 'cherry-pick'],
      ['REVERT_HEAD', 'revert'],
      ['BISECT_LOG', 'bisect'],
    ];
    for (const [name, label] of markers) {
      try {
        await fs.access(path.join(gitDir, name));
        return label;
      } catch {
        /* marker absent */
      }
    }
    return undefined;
  }

  /** True when `filePath` exists in the tree of `ref` — the checkpoint baseline probe. */
  async pathExistsAtRef(ref: string, filePath: string): Promise<boolean> {
    const result = await this.run(['cat-file', '-e', `${ref}:${filePath}`], { allowFailure: true });
    return result.exitCode === 0;
  }

  /**
   * Content of `filePath` as of `ref`, or undefined when that tree has no such path.
   * Rollback needs this for files that were *clean* when the checkpoint was taken: their
   * pre-edit content is the recorded commit, not a snapshot. Reading a blob never touches
   * the index, and `git show` does not apply smudge filters, so extraction is lossless.
   */
  async contentAtRef(ref: string, filePath: string, maxBytes = 8_388_608): Promise<string | undefined> {
    if (!(await this.pathExistsAtRef(ref, filePath))) return undefined;
    const result = await this.run(['show', `${ref}:${filePath}`], {
      allowFailure: true,
      maxStdoutBytes: maxBytes,
    });
    if (result.exitCode !== 0) return undefined;
    return result.stdout;
  }

  /**
   * Reverse-applies a checkpoint patch, optionally limited to specific paths.
   * `checkOnly` probes without touching the working tree — the safe way to find out
   * whether a file can be restored without clobbering later user edits.
   */
  async applyReversePatch(
    patchFile: string,
    options: { include?: readonly string[]; checkOnly?: boolean } = {},
  ): Promise<ProcessRunResult> {
    const args = ['apply', '--reverse', '--binary', '--whitespace=nowarn'];
    if (options.checkOnly === true) args.push('--check');
    for (const include of options.include ?? []) args.push(`--include=${include}`);
    args.push(patchFile);
    return await this.run(args, { allowFailure: true });
  }
}
