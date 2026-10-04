import type { TestFailure } from '../../types/execution.js';
import type { ParsedTests } from './shared.js';
import { combineOutput, emptyParsed, mergeFailures, splitLines, stackHeadOf } from './shared.js';

/**
 * pytest and unittest output. Both are parsed from the machine-readable summary they print
 * (`1 failed, 3 passed in 0.12s`, `Ran 3 tests`, `FAILED (failures=1)`), never from the
 * verbose progress output.
 */

const PYTEST_COUNT = /(\d+)\s+(passed|failed|errors?|skipped|xfailed|xpassed|deselected|warnings?)/g;
const IGNORED_PYTEST_KEYS = new Set(['xfailed', 'xpassed', 'deselected', 'warnings', 'warning']);

function pytestCounts(line: string): Record<string, number> | undefined {
  const counts: Record<string, number> = {};
  let found = false;
  for (const match of line.matchAll(PYTEST_COUNT)) {
    const raw = match[2] ?? '';
    const key = raw === 'error' ? 'errors' : raw;
    if (IGNORED_PYTEST_KEYS.has(key)) continue;
    const value = Number(match[1]);
    if (!Number.isFinite(value)) continue;
    found = true;
    counts[key] = (counts[key] ?? 0) + value;
  }
  return found ? counts : undefined;
}

const PYTEST_SECTION = /^_{3,}\s+(.*?)\s+_{3,}$/;
const PYTEST_LOCATION = /^([\w./\\-]+\.py):(\d+)(?::\s*(.*))?$/;
const PYTEST_ERROR_LINE = /^E\s+(.*)$/;

export function parsePytest(stdout: string, stderr: string): ParsedTests {
  const parsed = emptyParsed();
  const text = combineOutput(stdout, stderr);
  const lines = splitLines(text);

  if (/no tests ran|collected 0 items/.test(text)) parsed.noTestsDetected = true;

  // 1. Counts: the last line within the tail that yields a count map wins.
  const tailStart = Math.max(0, lines.length - 80);
  for (let index = lines.length - 1; index >= tailStart; index -= 1) {
    const line = lines[index] ?? '';
    if (!/(passed|failed|errors?|skipped)/.test(line)) continue;
    const counts = pytestCounts(line);
    if (counts === undefined) continue;
    parsed.parsed = true;
    parsed.passed = counts['passed'] ?? 0;
    parsed.failed = counts['failed'] ?? 0;
    parsed.skipped = counts['skipped'] ?? 0;
    parsed.errors = counts['errors'] ?? 0;
    break;
  }
  if (parsed.parsed) {
    const collected = /collected (\d+) items?/.exec(text);
    parsed.total =
      collected !== null
        ? Number(collected[1])
        : parsed.passed + parsed.failed + parsed.skipped + parsed.errors;
  }

  // 2. Short summary lines: `FAILED tests/test_x.py::test_y - assert 1 == 2`.
  const summary: TestFailure[] = [];
  for (const line of lines) {
    const match = /^(FAILED|ERROR)\s+(\S+?)(?:\s+-\s+(.*))?$/.exec(line.trim());
    if (match === null) continue;
    const kind = match[1] ?? 'FAILED';
    const target = match[2] ?? '';
    const message = (match[3] ?? '').trim();
    const [file, ...rest] = target.split('::');
    const name = rest.length > 0 ? rest.join('::') : target;
    const failure: TestFailure = {
      name,
      message: message === '' ? `${kind} ${target}` : message,
    };
    if (file !== undefined && file !== '') failure.path = file;
    summary.push(failure);
  }

  // 3. Detail blocks: `____ test_name ____` … `E   assert ...` / `tests/test_x.py:12: AssertionError`.
  const details: TestFailure[] = [];
  let current: TestFailure | undefined;
  let buffer: string[] = [];
  const flush = (): void => {
    if (current === undefined) return;
    const errorLines: string[] = [];
    let location: { path: string; line: number } | undefined;
    for (const rawLine of buffer) {
      const errorMatch = PYTEST_ERROR_LINE.exec(rawLine);
      if (errorMatch !== null && errorMatch[1] !== undefined) errorLines.push(errorMatch[1]);
      const locationMatch = PYTEST_LOCATION.exec(rawLine.trim());
      if (locationMatch !== null) {
        location = { path: locationMatch[1] ?? '', line: Number(locationMatch[2]) };
      }
    }
    current.message = errorLines[0] ?? current.message;
    if (errorLines.length > 0) current.stackHead = stackHeadOf(errorLines);
    if (location !== undefined) {
      current.path = location.path;
      if (Number.isFinite(location.line)) current.line = location.line;
    }
    details.push(current);
    current = undefined;
    buffer = [];
  };

  for (const line of lines) {
    const header = PYTEST_SECTION.exec(line.trim());
    if (header !== null) {
      flush();
      const rawName = (header[1] ?? '').trim();
      const shortName = rawName.includes('::')
        ? rawName.slice(rawName.lastIndexOf('::') + 2)
        : rawName.replace(/^ERROR at (?:setup|teardown) of\s+/i, '');
      current = { name: shortName, message: '' };
      continue;
    }
    if (current !== undefined) buffer.push(line);
  }
  flush();

  parsed.failures = mergeFailures(summary, details).slice(0, 25);
  return parsed;
}

const UNITTEST_RAN = /^Ran (\d+) tests? in [\d.]+s/m;
const UNITTEST_RESULT = /^(OK|FAILED)\s*(?:\(([^)]*)\))?/m;
const UNITTEST_HEADER = /^(FAIL|ERROR):\s+(\S+)\s+\(([^)]+)\)/;

export function parseUnittest(stdout: string, stderr: string): ParsedTests {
  const parsed = emptyParsed();
  const text = combineOutput(stdout, stderr);
  const lines = splitLines(text);

  const ran = UNITTEST_RAN.exec(text);
  if (ran !== null) {
    parsed.parsed = true;
    parsed.total = Number(ran[1]);
  }
  if (/Ran 0 tests/.test(text)) parsed.noTestsDetected = true;

  const result = UNITTEST_RESULT.exec(text);
  if (result !== null && parsed.parsed) {
    const kind = result[1] ?? '';
    const detail = result[2] ?? '';
    if (kind === 'OK') {
      const skippedMatch = /skipped=(\d+)/.exec(detail);
      parsed.skipped = skippedMatch === null ? 0 : Number(skippedMatch[1]);
      parsed.passed = Math.max(0, parsed.total - parsed.skipped);
    } else {
      const failures = /failures=(\d+)/.exec(detail);
      const errors = /errors=(\d+)/.exec(detail);
      const skipped = /skipped=(\d+)/.exec(detail);
      parsed.failed = failures === null ? 0 : Number(failures[1]);
      parsed.errors = errors === null ? 0 : Number(errors[1]);
      parsed.skipped = skipped === null ? 0 : Number(skipped[1]);
      parsed.passed = Math.max(0, parsed.total - parsed.failed - parsed.errors - parsed.skipped);
    }
  }

  // Detail blocks: `FAIL: test_y (tests.test_x.TestX)` followed by a traceback.
  const failures: TestFailure[] = [];
  let current: TestFailure | undefined;
  let buffer: string[] = [];
  const flush = (): void => {
    if (current === undefined) return;
    const traceback = buffer.filter((line) => line.trim() !== '');
    const message = [...traceback].reverse().find((line) => /^\w*Error|assert|Exception/.test(line.trim()));
    const location = [...traceback]
      .reverse()
      .map((line) => /File "([^"]+)", line (\d+)/.exec(line))
      .find((match) => match !== null);
    if (message !== undefined) current.message = message.trim();
    current.stackHead = stackHeadOf(traceback.slice(0, 3));
    if (location !== null && location !== undefined) {
      current.path = location[1] ?? undefined;
      current.line = Number(location[2]);
    }
    failures.push(current);
    current = undefined;
    buffer = [];
  };

  for (const line of lines) {
    const header = UNITTEST_HEADER.exec(line.trim());
    if (header !== null) {
      flush();
      current = {
        name: header[2] ?? '',
        suite: header[3],
        message: `${header[1]} ${header[2] ?? ''}`.trim(),
      };
      continue;
    }
    if (current !== undefined) buffer.push(line);
  }
  flush();

  parsed.failures = failures.slice(0, 25);
  return parsed;
}
