import type { TestFailure } from '../../types/execution.js';

/**
 * Shared shape for every test-output parser. `parsed` is the honesty flag: a parser that finds
 * no recognisable summary must leave it false so the caller can say "I could not read the
 * result" instead of reporting zero failures.
 */
export interface ParsedTests {
  parsed: boolean;
  total: number;
  passed: number;
  failed: number;
  skipped: number;
  errors: number;
  failures: TestFailure[];
  noTestsDetected: boolean;
  slowest: { name: string; durationMs: number }[];
}

export function emptyParsed(): ParsedTests {
  return {
    parsed: false,
    total: 0,
    passed: 0,
    failed: 0,
    skipped: 0,
    errors: 0,
    failures: [],
    noTestsDetected: false,
    slowest: [],
  };
}

export function combineOutput(stdout: string, stderr: string): string {
  return `${stdout}\n${stderr}`;
}

export function splitLines(text: string): string[] {
  return text.split(/\r?\n/);
}

/** Key used to merge a summary line with the detail block for the same test. */
export function failureKey(name: string): string {
  const withoutPrefix = name
    .replace(/^ERROR at (?:setup|teardown) of\s+/i, '')
    .replace(/^FAILED\s+/i, '')
    .trim();
  const afterSeparator = withoutPrefix.includes('::')
    ? withoutPrefix.slice(withoutPrefix.lastIndexOf('::') + 2)
    : withoutPrefix;
  return afterSeparator.trim().toLowerCase();
}

export function mergeFailure(target: TestFailure, source: TestFailure): TestFailure {
  const merged: TestFailure = {
    name: target.name === '' ? source.name : target.name,
    message: target.message !== '' ? target.message : source.message,
  };
  const suite = target.suite ?? source.suite;
  const path = target.path ?? source.path;
  const line = target.line ?? source.line;
  const durationMs = target.durationMs ?? source.durationMs;
  const stackHead = target.stackHead ?? source.stackHead;
  if (suite !== undefined) merged.suite = suite;
  if (path !== undefined) merged.path = path;
  if (line !== undefined) merged.line = line;
  if (durationMs !== undefined) merged.durationMs = durationMs;
  if (stackHead !== undefined) merged.stackHead = stackHead;
  return merged;
}

/** Collect detail blocks keyed by test name so summary lines can be enriched. */
export function mergeFailures(summary: TestFailure[], details: TestFailure[]): TestFailure[] {
  const detailByKey = new Map<string, TestFailure>();
  for (const detail of details) detailByKey.set(failureKey(detail.name), detail);

  const used = new Set<string>();
  const merged: TestFailure[] = [];
  for (const entry of summary) {
    const key = failureKey(entry.name);
    const detail = detailByKey.get(key);
    if (detail === undefined) {
      merged.push(entry);
      continue;
    }
    used.add(key);
    merged.push(mergeFailure(entry, detail));
  }
  for (const detail of details) {
    if (used.has(failureKey(detail.name))) continue;
    merged.push(detail);
  }
  return merged;
}

export function stackHeadOf(lines: readonly string[], limit = 3): string[] {
  const head: string[] = [];
  for (const line of lines) {
    const trimmed = line.trim();
    if (trimmed === '') continue;
    head.push(trimmed);
    if (head.length >= limit) break;
  }
  return head;
}
