import type { TestFailure } from '../../types/execution.js';
import type { ParsedTests } from './shared.js';
import { combineOutput, emptyParsed, splitLines, stackHeadOf } from './shared.js';

/**
 * Jest, Vitest and `node --test` output. Every parser leans on the runner's own summary
 * (`Tests: 1 failed, 2 passed, 3 total` / `Tests  1 failed | 2 passed (3)` / `# fail 1`) and
 * keeps only the first lines of each stack, because an agent never needs the whole dump.
 */

const JEST_COUNT = /(\d+)\s+(failed|passed|skipped|todo|pending|total)/g;
const JEST_FILE = /^(PASS|FAIL)\s+(\S+)/;
const JEST_FAILURE_HEADER = /^\s*●\s+(.*)$/;
const JEST_LOCATION = /^\s*at\s+.*?\(?([^()\s]+):(\d+):(\d+)\)?$/;

export function parseJest(stdout: string, stderr: string): ParsedTests {
  const parsed = emptyParsed();
  const text = combineOutput(stdout, stderr);
  const lines = splitLines(text);

  if (/No tests found/.test(text)) parsed.noTestsDetected = true;

  // Totals: `Tests:       1 failed, 2 passed, 3 total`.
  for (let index = lines.length - 1; index >= 0; index -= 1) {
    const line = lines[index] ?? '';
    if (!line.trim().startsWith('Tests:')) continue;
    const counts: Record<string, number> = {};
    for (const match of line.matchAll(JEST_COUNT)) {
      counts[match[2] ?? ''] = Number(match[1]);
    }
    parsed.parsed = true;
    parsed.total = counts['total'] ?? 0;
    parsed.failed = (counts['failed'] ?? 0) + (counts['pending'] ?? 0);
    parsed.skipped = counts['skipped'] ?? 0;
    parsed.passed = counts['passed'] ?? Math.max(0, parsed.total - parsed.failed - parsed.skipped);
    break;
  }

  const failures: TestFailure[] = [];
  let currentFile: string | undefined;
  let current: TestFailure | undefined;
  let buffer: string[] = [];

  const flush = (): void => {
    if (current === undefined) return;
    const body = buffer.map((line) => line.trim()).filter((line) => line !== '');
    const message = body.find((line) => !line.startsWith('at ')) ?? current.message;
    current.message = message === '' ? current.message : message;
    current.stackHead = stackHeadOf(body, 3);
    for (const rawLine of buffer) {
      const location = JEST_LOCATION.exec(rawLine);
      if (location === null) continue;
      current.path = current.path ?? location[1] ?? undefined;
      current.line = current.line ?? Number(location[2]);
      break;
    }
    failures.push(current);
    current = undefined;
    buffer = [];
  };

  for (const line of lines) {
    const file = JEST_FILE.exec(line.trim());
    if (file !== null) {
      flush();
      currentFile = file[2];
      continue;
    }
    const header = JEST_FAILURE_HEADER.exec(line);
    if (header !== null) {
      const name = (header[1] ?? '').trim();
      if (/^(Console|Deprecation|Snapshot)/i.test(name)) continue;
      flush();
      const parts = name.split('›').map((part) => part.trim());
      current = { name: parts.length > 1 ? (parts[parts.length - 1] ?? name) : name, message: '' };
      if (parts.length > 1) current.suite = parts.slice(0, -1).join(' › ');
      if (currentFile !== undefined) current.path = currentFile;
      continue;
    }
    if (current !== undefined) buffer.push(line);
  }
  flush();

  parsed.failures = failures.slice(0, 25);
  return parsed;
}

const VITEST_TESTS_LINE = /^\s*Tests\s+(.*)$/;
const VITEST_COUNT = /(\d+)\s+(failed|passed|skipped|todo)\b/g;
const VITEST_TOTAL = /\((\d+)\)\s*$/;
const VITEST_FILE_LINE = /^\s*[❯✓×✗]\s+(\S+\.(?:test|spec)\.[cm]?[jt]sx?)\s*(?:\(|$)/;
const VITEST_FAILURE_LINE = /^\s*(?:×|✗)\s+(.*?)(?:\s+\d+(?:\.\d+)?ms)?$/;
const VITEST_REASON = /^\s*→\s+(.*)$/;
/** Vitest prints `(12ms)` on file lines and a bare `5ms` on test lines: accept both. */
function vitestDuration(line: string): number | undefined {
  const paren = /\((\d+(?:\.\d+)?)ms\)/.exec(line);
  if (paren !== null) return Number(paren[1]);
  const bare = /(\d+(?:\.\d+)?)ms\b/.exec(line);
  return bare === null ? undefined : Number(bare[1]);
}

export function parseVitest(stdout: string, stderr: string): ParsedTests {
  const parsed = emptyParsed();
  const text = combineOutput(stdout, stderr);
  const lines = splitLines(text);

  if (/No test files found/.test(text) || /Tests\s+no tests/.test(text)) parsed.noTestsDetected = true;

  for (let index = lines.length - 1; index >= 0; index -= 1) {
    const line = lines[index] ?? '';
    const summary = VITEST_TESTS_LINE.exec(line);
    if (summary === null) continue;
    const counts: Record<string, number> = {};
    for (const match of summary[1]!.matchAll(VITEST_COUNT)) counts[match[2] ?? ''] = Number(match[1]);
    const total = VITEST_TOTAL.exec(summary[1]!);
    parsed.parsed = true;
    parsed.failed = counts['failed'] ?? 0;
    parsed.passed = counts['passed'] ?? 0;
    parsed.skipped = (counts['skipped'] ?? 0) + (counts['todo'] ?? 0);
    parsed.total = total === null ? parsed.failed + parsed.passed + parsed.skipped : Number(total[1]);
    break;
  }

  const failures: TestFailure[] = [];
  let currentFile: string | undefined;
  let current: TestFailure | undefined;

  const flush = (): void => {
    if (current === undefined) return;
    failures.push(current);
    current = undefined;
  };

  for (const line of lines) {
    const file = VITEST_FILE_LINE.exec(line);
    if (file !== null) {
      flush();
      const filePath = file[1] ?? line.trim();
      currentFile = filePath;
      const duration = vitestDuration(line);
      if (duration !== undefined) {
        parsed.slowest.push({ name: filePath, durationMs: duration });
      }
      continue;
    }
    const failure = VITEST_FAILURE_LINE.exec(line);
    if (failure !== null && !/^\s*×\s*\d+/.test(line)) {
      flush();
      const raw = (failure[1] ?? '').trim();
      if (raw === '' || raw.startsWith('Test Files') || raw.startsWith('Tests')) continue;
      const parts = raw.split('>').map((part) => part.trim());
      current = { name: parts[parts.length - 1] ?? raw, message: '' };
      if (parts.length > 1) current.suite = parts.slice(0, -1).join(' > ');
      if (currentFile !== undefined) current.path = currentFile;
      const duration = vitestDuration(line);
      if (duration !== undefined) current.durationMs = duration;
      continue;
    }
    const reason = VITEST_REASON.exec(line);
    if (reason !== null && current !== undefined) {
      const message = (reason[1] ?? '').trim();
      current.message = current.message === '' ? message : `${current.message}; ${message}`;
      const head = current.stackHead ?? [];
      if (head.length < 3) head.push(message);
      current.stackHead = head;
    }
  }
  flush();

  parsed.failures = failures.slice(0, 25);
  parsed.slowest = parsed.slowest.sort((a, b) => b.durationMs - a.durationMs).slice(0, 5);
  return parsed;
}

const NODE_TEST_SUMMARY = /^#\s+(tests|pass|fail|skipped|todo|cancelled)\s+(\d+)/;
const NODE_TEST_FAILURE = /^\s*(?:✖|not ok \d+ -)\s*(.*?)(?:\s+\((\d+(?:\.\d+)?)ms\))?$/;
const NODE_TEST_TAP_FAILURE = /^not ok \d+ - (.*)$/;

export function parseNodeTest(stdout: string, stderr: string): ParsedTests {
  const parsed = emptyParsed();
  const text = combineOutput(stdout, stderr);
  const lines = splitLines(text);

  if (/# tests 0/.test(text)) parsed.noTestsDetected = true;

  const counts: Record<string, number> = {};
  let sawSummary = false;
  for (const line of lines) {
    const match = NODE_TEST_SUMMARY.exec(line.trim());
    if (match === null) continue;
    sawSummary = true;
    counts[match[1] ?? ''] = Number(match[2]);
  }
  if (sawSummary) {
    parsed.parsed = true;
    parsed.total = counts['tests'] ?? 0;
    parsed.passed = counts['pass'] ?? 0;
    parsed.failed = counts['fail'] ?? 0;
    parsed.skipped = (counts['skipped'] ?? 0) + (counts['todo'] ?? 0);
    parsed.errors = counts['cancelled'] ?? 0;
  }

  const failures: TestFailure[] = [];
  let current: TestFailure | undefined;
  let buffer: string[] = [];
  const flush = (): void => {
    if (current === undefined) return;
    const body = buffer
      .map((line) => line.trim())
      .filter((line) => line !== '' && line !== '---' && line !== '...');

    // node --test emits TAP diagnostic YAML: `error: |-` followed by the indented real text.
    // Taking the key line itself would make every failure read "error: |-".
    let message: string | undefined;
    for (let index = 0; index < buffer.length; index += 1) {
      const rawLine = buffer[index] ?? '';
      const key = /^(\s*)error:\s*(.*)$/.exec(rawLine);
      if (key === null) continue;
      const inline = (key[2] ?? '').trim();
      if (inline !== '' && inline !== '|-' && inline !== '|') {
        message = inline;
        break;
      }
      const indent = (key[1] ?? '').length;
      const collected: string[] = [];
      for (let next = index + 1; next < buffer.length; next += 1) {
        const candidate = buffer[next] ?? '';
        if (candidate.trim() === '') continue;
        const candidateIndent = candidate.length - candidate.trimStart().length;
        if (candidateIndent <= indent) break;
        collected.push(candidate.trim());
        if (collected.length >= 2) break;
      }
      if (collected.length > 0) message = collected.join(' ');
      break;
    }
    if (message === undefined) {
      message = body.find((line) => /AssertionError|Error:|expected|actual/i.test(line));
    }
    current.message = message ?? body[0] ?? 'test failed';

    for (const rawLine of buffer) {
      const location = /location:\s*'?"?(?:file:\/\/\/)?([^'"\s]+?):(\d+):(\d+)'?"?/.exec(rawLine);
      if (location === null) continue;
      current.path = location[1];
      current.line = Number(location[2]);
      break;
    }

    current.stackHead = stackHeadOf(
      body.filter(
        (line) =>
          !/^(duration_ms|type|location|failureType|code|name|stack|error|compare|operator|expected|actual):/.test(
            line,
          ),
      ),
      3,
    );
    failures.push(current);
    current = undefined;
    buffer = [];
  };

  for (const line of lines) {
    const tap = NODE_TEST_TAP_FAILURE.exec(line.trim());
    if (tap !== null) {
      flush();
      current = { name: (tap[1] ?? '').trim(), message: '' };
      continue;
    }
    const header = NODE_TEST_FAILURE.exec(line);
    if (header !== null) {
      flush();
      current = { name: (header[1] ?? '').trim(), message: '' };
      if (header[2] !== undefined) current.durationMs = Number(header[2]);
      continue;
    }
    if (current !== undefined) {
      if (/^#/.test(line.trim())) {
        flush();
        continue;
      }
      buffer.push(line);
    }
  }
  flush();

  const durations = lines
    .map((line) => NODE_TEST_FAILURE.exec(line))
    .filter((match): match is RegExpExecArray => match !== null && match[2] !== undefined)
    .map((match) => ({ name: (match[1] ?? '').trim(), durationMs: Number(match[2]) }))
    .sort((a, b) => b.durationMs - a.durationMs)
    .slice(0, 5);

  parsed.failures = failures.slice(0, 25);
  parsed.slowest = durations;
  return parsed;
}
