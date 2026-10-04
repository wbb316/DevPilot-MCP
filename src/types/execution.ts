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

/**
 * Phase 5 (docs/DATA-MODEL.md §5). A test run is judged by the parsed summary, never by the
 * agent reading the log: `parsed` says whether a machine-readable summary was actually found,
 * so a silent parse failure cannot be mistaken for "all tests passed".
 */
export type TestStatus = 'passed' | 'failed' | 'error' | 'timeout' | 'no_tests';

export interface TestFailure {
  name: string;
  suite?: string;
  path?: string;
  line?: number;
  message: string;
  stackHead?: string[];
  durationMs?: number;
}

export interface TestDuration {
  name: string;
  durationMs: number;
}

export interface TestResult {
  status: TestStatus;
  framework: string;
  command: string;
  durationMs: number;
  total: number;
  passed: number;
  failed: number;
  skipped: number;
  errors: number;
  failures: TestFailure[];
  durations?: { slowest: TestDuration[] };
  job: JobRecord;
  /** True only when the output contained a summary this module could actually parse. */
  parsed: boolean;
}
