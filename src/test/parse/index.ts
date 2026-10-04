import type { TestFramework } from '../test-system.js';
import type { ParsedTests } from './shared.js';
import { parseJunit } from './java-tests.js';
import { parseJest, parseNodeTest, parseVitest } from './js-tests.js';
import { parsePytest, parseUnittest } from './python-tests.js';

export type { ParsedTests } from './shared.js';

/**
 * Framework → parser dispatch, with a deliberate fallback chain: if the runner we planned does
 * not produce a summary the parser understands (wrapper scripts lie about their runner), the
 * other parsers get a chance. Whichever parser reports `parsed: true` wins, and the envelope
 * says which one it was.
 */

const FALLBACK_ORDER: readonly TestFramework[] = ['vitest', 'jest', 'node-test', 'pytest', 'unittest', 'junit'];

function parseWith(framework: TestFramework, stdout: string, stderr: string): ParsedTests {
  switch (framework) {
    case 'pytest':
      return parsePytest(stdout, stderr);
    case 'unittest':
      return parseUnittest(stdout, stderr);
    case 'junit':
      return parseJunit(stdout, stderr);
    case 'jest':
      return parseJest(stdout, stderr);
    case 'vitest':
      return parseVitest(stdout, stderr);
    case 'node-test':
      return parseNodeTest(stdout, stderr);
    default:
      return parseJest(stdout, stderr);
  }
}

export interface TestParseOutcome extends ParsedTests {
  /** Parser that actually produced the numbers (may differ from the planned framework). */
  parser: TestFramework | 'unknown';
}

export function parseTestOutput(
  framework: TestFramework,
  stdout: string,
  stderr: string,
): TestParseOutcome {
  const primary = parseWith(framework, stdout, stderr);
  if (primary.parsed || primary.failures.length > 0) {
    return { ...primary, parser: framework };
  }

  for (const candidate of FALLBACK_ORDER) {
    if (candidate === framework) continue;
    const attempt = parseWith(candidate, stdout, stderr);
    if (attempt.parsed || attempt.failures.length > 0) {
      return { ...attempt, parser: candidate };
    }
  }

  return { ...primary, parser: 'unknown' };
}
