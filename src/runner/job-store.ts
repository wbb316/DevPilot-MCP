import { promises as fs } from 'node:fs';
import path from 'node:path';

import { appendJsonLine, writeTextAtomic } from '../storage/json-store.js';
import type { WorkspacePaths } from '../types/workspace.js';
import type { JobKind, JobRecord } from '../types/execution.js';

/**
 * Job ledger (docs/DATA-MODEL.md §5, §9). Append-only JSON Lines under
 * `.devpilot/logs/jobs.jsonl`, compacted once it grows past twice the retention cap.
 *
 * The frozen SQLite schema also has a `jobs` table; it is populated once a phase needs
 * indexed job queries (Phase 6 diagnosis history). Until then a JSONL ledger keeps the
 * write path trivial and crash-safe, and it is what phase 6 reads.
 */

export const DEFAULT_JOB_RETENTION = 200;

export function newJobId(kind: JobKind, now: Date = new Date()): string {
  const stamp = now.toISOString().replace(/[-:]/g, '').replace(/\..+$/, '').replace('T', '-');
  const random = Math.random().toString(36).slice(2, 6);
  return `${kind}-${stamp}-${random}`;
}

export function jobLogFile(paths: WorkspacePaths, jobId: string): string {
  return path.join(paths.logsDir, `${jobId}.log`);
}

function parseJobLine(line: string): JobRecord | undefined {
  const trimmed = line.trim();
  if (trimmed === '') return undefined;
  try {
    const value = JSON.parse(trimmed) as JobRecord;
    if (typeof value?.jobId === 'string' && typeof value.command === 'string') return value;
    return undefined;
  } catch {
    return undefined;
  }
}

export class JobStore {
  private readonly file: string;
  private count: number | undefined;

  constructor(
    paths: WorkspacePaths,
    private readonly retention: number = DEFAULT_JOB_RETENTION,
  ) {
    this.file = path.join(paths.logsDir, 'jobs.jsonl');
  }

  async record(job: JobRecord): Promise<void> {
    await appendJsonLine(this.file, job);
    if (this.count === undefined) this.count = await this.countLines();
    else this.count += 1;
    if (this.count > this.retention * 2) await this.compact();
  }

  /** Newest first. */
  async recent(options: { limit?: number; kind?: JobKind } = {}): Promise<JobRecord[]> {
    const limit = options.limit ?? 10;
    const all = await this.readAll();
    const filtered = options.kind === undefined ? all : all.filter((job) => job.kind === options.kind);
    return filtered.slice(-limit).reverse();
  }

  async lastFailed(kind?: JobKind): Promise<JobRecord | undefined> {
    const all = await this.readAll();
    for (let i = all.length - 1; i >= 0; i -= 1) {
      const job = all[i] as JobRecord;
      if (kind !== undefined && job.kind !== kind) continue;
      if (job.exitCode !== 0 || job.timedOut) return job;
    }
    return undefined;
  }

  private async readAll(): Promise<JobRecord[]> {
    let raw: string;
    try {
      raw = await fs.readFile(this.file, 'utf8');
    } catch {
      return [];
    }
    const jobs: JobRecord[] = [];
    for (const line of raw.split('\n')) {
      const job = parseJobLine(line);
      if (job !== undefined) jobs.push(job);
    }
    return jobs;
  }

  private async countLines(): Promise<number> {
    return (await this.readAll()).length;
  }

  private async compact(): Promise<void> {
    const jobs = await this.readAll();
    const kept = jobs.slice(-this.retention);
    await writeTextAtomic(this.file, kept.map((job) => JSON.stringify(job)).join('\n') + '\n');
    this.count = kept.length;
  }
}
