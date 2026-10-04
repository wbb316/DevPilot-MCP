import type { TestFailure } from '../../types/execution.js';
import type { ParsedTests } from './shared.js';
import { combineOutput, emptyParsed, splitLines } from './shared.js';

/**
 * Maven Surefire and Gradle test output (JUnit under the hood). Counts come from the
 * `Tests run: N, Failures: N, Errors: N, Skipped: N` summary (Surefire) or
 * `N tests completed, M failed` (Gradle); failures carry the test class and, when a stack
 * frame is present, the source file and line of the assertion.
 *
 * Entries are keyed by *short* class name + method, because Surefire prints the same test as
 * `com.example.UserServiceTest.lengthOfTitle` in one line and `UserServiceTest.lengthOfTitle`
 * in another; keying on the full name would duplicate every failure.
 */

const SUREFIRE_SUMMARY =
  /Tests run:\s*(\d+),\s*Failures:\s*(\d+),\s*Errors:\s*(\d+),\s*Skipped:\s*(\d+)/;
const GRADLE_SUMMARY = /(\d+) tests? completed(?:,\s*(\d+) failed)?/;
const GRADLE_FAILURE = /^(\S+) > (\S+) FAILED$/;
const SUREFIRE_DETAILED = /^\[ERROR\]\s+([\w.$]+)\.([\w$]+):(\d+)\s*(.*)$/;
const SUREFIRE_HEADER = /^\[ERROR\]\s+([\w.$]+)\s+--\s+Time elapsed:.*<<<\s+(FAILURE|ERROR)!/;
const JAVA_STACK_FRAME = /^\s+at\s+([\w.$]+)\.([\w$<>]+)\(([\w$]+\.(?:java|kt)):(\d+)\)/;
const SUREFIRE_TEXT = /^\[ERROR\]\s{2,}(.*)$/;

function shortName(fqcn: string): string {
  const dot = fqcn.lastIndexOf('.');
  return dot > 0 ? fqcn.slice(dot + 1) : fqcn;
}

/** Frames that belong to the tooling itself, never to the project under test. */
const FRAMEWORK_CLASS =
  /^(?:java|javax|jdk|sun|com\.sun|junit|org\.junit|org\.opentest4j|org\.apiguardian|org\.gradle|org\.apache\.maven|org\.mockito|org\.assertj|org\.hamcrest|kotlin|kotlinx)\./;

/**
 * How good a stack frame is as the *location* of a failure: the failing test's own class beats
 * project code, which beats framework internals. Phase 10 acceptance showed that Surefire's
 * first frame is JUnit's own `AssertionFailureBuilder.java`, so the naive "first frame wins"
 * rule pointed the agent at JUnit instead of at the test that failed.
 */
function scoreFrame(className: string, suite: string | undefined): number {
  if (suite !== undefined && suite !== '' && (className === suite || shortName(className) === shortName(suite))) {
    return 2;
  }
  return FRAMEWORK_CLASS.test(className) ? 0 : 1;
}

function keyOf(failure: TestFailure): string {
  return `${shortName(failure.suite ?? '')}#${failure.name}`;
}

export function parseJunit(stdout: string, stderr: string): ParsedTests {
  const parsed = emptyParsed();
  const text = combineOutput(stdout, stderr);
  const lines = splitLines(text);

  for (let index = lines.length - 1; index >= 0; index -= 1) {
    const line = lines[index] ?? '';
    const surefire = SUREFIRE_SUMMARY.exec(line);
    if (surefire !== null) {
      parsed.parsed = true;
      parsed.total = Number(surefire[1]);
      parsed.failed = Number(surefire[2]);
      parsed.errors = Number(surefire[3]);
      parsed.skipped = Number(surefire[4]);
      parsed.passed = Math.max(0, parsed.total - parsed.failed - parsed.errors - parsed.skipped);
      break;
    }
    const gradle = GRADLE_SUMMARY.exec(line);
    if (gradle !== null) {
      parsed.parsed = true;
      parsed.total = Number(gradle[1]);
      parsed.failed = gradle[2] === undefined ? 0 : Number(gradle[2]);
      parsed.passed = Math.max(0, parsed.total - parsed.failed);
      break;
    }
  }

  if (/No tests to run|No tests found|There are no tests to run/.test(text)) {
    parsed.noTestsDetected = true;
  }

  const failures: TestFailure[] = [];
  const byKey = new Map<string, TestFailure>();
  const push = (failure: TestFailure): TestFailure => {
    const key = keyOf(failure);
    const existing = byKey.get(key);
    if (existing === undefined) {
      byKey.set(key, failure);
      failures.push(failure);
      return failure;
    }
    if (existing.message.startsWith('FAILURE') || existing.message.startsWith('ERROR')) {
      existing.message = failure.message;
    }
    if (existing.suite === undefined || existing.suite.length < (failure.suite?.length ?? 0)) {
      existing.suite = failure.suite;
    }
    existing.path = existing.path ?? failure.path;
    existing.line = existing.line ?? failure.line;
    existing.stackHead = existing.stackHead ?? failure.stackHead;
    return existing;
  };

  let pending: TestFailure | undefined;
  let pendingScore = -1;

  for (const rawLine of lines) {
    const line = rawLine.trim();

    const gradleFailure = GRADLE_FAILURE.exec(line);
    if (gradleFailure !== null) {
      pending = undefined;
      push({
        name: gradleFailure[2] ?? '',
        suite: gradleFailure[1] ?? '',
        message: `FAILED (${gradleFailure[1] ?? ''})`,
      });
      continue;
    }

    const header = SUREFIRE_HEADER.exec(line);
    if (header !== null) {
      const token = header[1] ?? '';
      const dot = token.lastIndexOf('.');
      pending = push({
        name: dot > 0 ? token.slice(dot + 1) : token,
        suite: dot > 0 ? token.slice(0, dot) : '',
        message: header[2] ?? 'FAILURE',
      });
      pendingScore = -1;
      continue;
    }

    const detailed = SUREFIRE_DETAILED.exec(line);
    if (detailed !== null && /^\[ERROR\]\s+[\w.$]+\.\w+:\d+/.test(line)) {
      // Keep the canonical object: a following stack frame must improve the *stored* failure,
      // not a copy that never reaches the result.
      pending = push({
        name: detailed[2] ?? '',
        suite: detailed[1] ?? '',
        line: Number(detailed[3]),
        message: (detailed[4] ?? '').trim() || 'assertion failed',
      });
      pendingScore = -1;
      continue;
    }

    const frame = JAVA_STACK_FRAME.exec(rawLine);
    if (frame !== null && pending !== undefined) {
      // Fill the location from the first frame, then upgrade it when a better frame shows up.
      const score = scoreFrame(frame[1] ?? '', pending.suite);
      if (pending.path === undefined || score > pendingScore) {
        pending.path = frame[3];
        pending.line = Number(frame[4]);
        pendingScore = score;
      }
      const head = pending.stackHead ?? [];
      if (head.length < 3) head.push(line);
      pending.stackHead = head;
      continue;
    }

    const textLine = SUREFIRE_TEXT.exec(line);
    if (textLine !== null && pending !== undefined && !SUREFIRE_DETAILED.test(line)) {
      const message = (textLine[1] ?? '').trim();
      if (message !== '' && !message.startsWith('at ') && pending.message.length < 200) {
        pending.message = pending.message === '' ? message : `${pending.message}; ${message}`;
      }
      continue;
    }

    if (line === '') pending = undefined;
  }

  parsed.failures = failures.slice(0, 25);
  if (!parsed.parsed && failures.length > 0) {
    // A failure list without a summary still proves the run failed; counts stay honest (0).
    parsed.parsed = true;
    parsed.failed = failures.length;
    parsed.total = failures.length;
  }
  return parsed;
}
