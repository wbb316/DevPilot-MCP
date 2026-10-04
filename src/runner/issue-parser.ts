import type { IssueEntry } from '../types/execution.js';

/**
 * Issue extraction from build/test output (docs/ROADMAP.md Phase 4/6).
 *
 * Phase 4 deliberately does *not* diagnose: it pulls the first meaningful compiler/test
 * errors out of several thousand lines and hands the agent a bounded, structured list plus
 * a log file pointer. Phase 6 adds classification and suspect-file correlation on top.
 */

const MAX_ISSUES = 40;

const JAVAC_RE = /^(.*\.(?:java|kt)):(\d+):\s*(error|warning):\s*(.*)$/;
const MAVEN_LOCATION_RE = /^\[(ERROR|WARNING)\]\s*(\S+?):\[(\d+),(\d+)\]\s*(.*)$/;
const MAVEN_RE = /^\[(ERROR|WARNING)\]\s*(.*)$/;
const TSC_PAREN_RE = /^(.*?)\((\d+),(\d+)\):\s*(error|warning)\s+([A-Z]+\d+):\s*(.*)$/;
const TSC_DASH_RE = /^(.*?):(\d+):(\d+)\s*-\s*(error|warning)\s+([A-Z]+\d+):\s*(.*)$/;
const PYTHON_FILE_RE = /^\s*File "(.*)", line (\d+)/;
const PYTHON_ERROR_RE = /^([A-Za-z_][\w.]*(?:Error|Exception|Warning|Exit))\b:?\s*(.*)$/;
const GENERIC_RE = /^(.*?):(\d+):(\d+):\s*(error|warning):\s*(.*)$/;

function normalizePath(value: string): string {
  return value.replace(/\\/g, '/').replace(/^\.\//, '');
}

export interface ParsedIssues {
  errors: IssueEntry[];
  warnings: IssueEntry[];
  /** true when the cap cut the list short. */
  truncated: boolean;
}

export function parseIssues(
  stdout: string,
  stderr: string,
  options: { maxIssues?: number } = {},
): ParsedIssues {
  const maxIssues = options.maxIssues ?? MAX_ISSUES;
  const errors: IssueEntry[] = [];
  const warnings: IssueEntry[] = [];
  const seen = new Set<string>();

  const lines = `${stdout}\n${stderr}`.split(/\r?\n/);
  let lastPythonFile: { path: string; line: number } | undefined;

  const push = (entry: IssueEntry): void => {
    const bucket = entry.severity === 'error' ? errors : warnings;
    if (bucket.length >= maxIssues) return;
    const key = `${entry.severity}|${entry.path ?? ''}|${entry.line ?? ''}|${entry.message}`;
    if (seen.has(key)) return;
    seen.add(key);
    bucket.push(entry);
  };

  for (const line of lines) {
    const trimmed = line.trim();
    if (trimmed === '') continue;

    const pythonFile = PYTHON_FILE_RE.exec(line);
    if (pythonFile !== null) {
      lastPythonFile = { path: normalizePath(pythonFile[1] as string), line: Number(pythonFile[2]) };
      continue;
    }

    const pythonError = PYTHON_ERROR_RE.exec(trimmed);
    if (pythonError !== null && !trimmed.startsWith('File "')) {
      push({
        ...(lastPythonFile === undefined
          ? {}
          : { path: lastPythonFile.path, line: lastPythonFile.line }),
        severity: 'error',
        message: trimmed.slice(0, 400),
        code: pythonError[1] as string,
      });
      continue;
    }

    const javac = JAVAC_RE.exec(trimmed);
    if (javac !== null) {
      push({
        path: normalizePath(javac[1] as string),
        line: Number(javac[2]),
        severity: javac[3] as 'error' | 'warning',
        message: (javac[4] ?? '').slice(0, 400),
      });
      continue;
    }

    const mavenLocation = MAVEN_LOCATION_RE.exec(trimmed);
    if (mavenLocation !== null) {
      push({
        path: normalizePath(mavenLocation[2] as string),
        line: Number(mavenLocation[3]),
        column: Number(mavenLocation[4]),
        severity: mavenLocation[1] === 'ERROR' ? 'error' : 'warning',
        message: (mavenLocation[5] ?? '').slice(0, 400),
        code: 'maven',
      });
      continue;
    }

    const maven = MAVEN_RE.exec(trimmed);
    if (maven !== null) {
      push({
        severity: maven[1] === 'ERROR' ? 'error' : 'warning',
        message: (maven[2] ?? '').slice(0, 400),
        code: 'maven',
      });
      continue;
    }

    const tscParen = TSC_PAREN_RE.exec(trimmed);
    if (tscParen !== null) {
      push({
        path: normalizePath(tscParen[1] as string),
        line: Number(tscParen[2]),
        column: Number(tscParen[3]),
        severity: tscParen[4] as 'error' | 'warning',
        code: tscParen[5] as string,
        message: (tscParen[6] ?? '').slice(0, 400),
      });
      continue;
    }

    const tscDash = TSC_DASH_RE.exec(trimmed);
    if (tscDash !== null) {
      push({
        path: normalizePath(tscDash[1] as string),
        line: Number(tscDash[2]),
        column: Number(tscDash[3]),
        severity: tscDash[4] as 'error' | 'warning',
        code: tscDash[5] as string,
        message: (tscDash[6] ?? '').slice(0, 400),
      });
      continue;
    }

    const generic = GENERIC_RE.exec(trimmed);
    if (generic !== null) {
      push({
        path: normalizePath(generic[1] as string),
        line: Number(generic[2]),
        column: Number(generic[3]),
        severity: generic[4] as 'error' | 'warning',
        message: (generic[5] ?? '').slice(0, 400),
      });
      continue;
    }

    if (/^(?:error|fatal|ERROR|FATAL)\b[: ]/.test(trimmed) || trimmed.startsWith('error TS')) {
      push({ severity: 'error', message: trimmed.slice(0, 400) });
      continue;
    }
    if (/^(?:warning|WARNING)\b[: ]/.test(trimmed)) {
      push({ severity: 'warning', message: trimmed.slice(0, 400) });
    }
  }

  return {
    errors,
    warnings,
    truncated: errors.length >= maxIssues || warnings.length >= maxIssues,
  };
}

/** Last `count` non-empty lines of a stream, for the `stdoutTail`/`stderrTail` contract. */
export function tailLines(text: string, count = 40): string[] {
  if (text.trim() === '') return [];
  const lines = text.split(/\r?\n/);
  const nonEmpty = lines.filter((line) => line.trim() !== '');
  return nonEmpty.slice(-count);
}
