/**
 * Execution types — docs/DATA-MODEL.md §5 (frozen field names, see docs/TOOLS.md Phase 4/5).
 */

export type JobKind = 'build' | 'test' | 'run' | 'benchmark';

export interface JobRecord {
  jobId: string;
  kind: JobKind;
  command: string;
  args: string[];
  cwd: string;
  startedAt: string;
  finishedAt?: string;
  exitCode?: number | null;
  signal?: string | null;
  durationMs?: number;
  timedOut: boolean;
  stdoutBytes: number;
  stderrBytes: number;
  stdoutTruncated: boolean;
  stderrTruncated: boolean;
  logFile: string;
}

export type IssueSeverity = 'error' | 'warning';

export interface IssueEntry {
  path?: string;
  line?: number;
  column?: number;
  severity: IssueSeverity;
  message: string;
  code?: string;
}

export type ExecutionStatus = 'success' | 'failed' | 'timeout';

export interface BuildResult {
  status: ExecutionStatus;
  system: string;
  command: string;
  durationMs: number;
  errors: IssueEntry[];
  warnings: IssueEntry[];
  artifacts?: string[];
  job: JobRecord;
}

export interface RunResult {
  status: ExecutionStatus;
  command: string;
  durationMs: number;
  exitCode: number | null;
  signal: string | null;
  crashed: boolean;
  job: JobRecord;
}
