import { describe, expect, it } from 'vitest';

import { parseTestOutput } from '../../src/test/parse/index';
import { parseJunit } from '../../src/test/parse/java-tests';
import { parseJest, parseNodeTest, parseVitest } from '../../src/test/parse/js-tests';
import { parsePytest, parseUnittest } from '../../src/test/parse/python-tests';

/**
 * Every parser is pinned against captured output from the real runner. The point of the suite
 * is the boring failure mode: silently reporting zero failures when the summary moved.
 */

const PYTEST_FAIL = [
  '...F                                                                     [100%]',
  '=================================== FAILURES ===================================',
  '_____________________________ test_add ______________________________________',
  '',
  '    def test_add():',
  '>       assert add(1, 1) == 3',
  'E       assert 2 == 3',
  '',
  'tests/test_math.py:5: AssertionError',
  '=========================== short test summary info ===========================',
  'FAILED tests/test_math.py::test_add - assert 2 == 3',
  '========================= 1 failed, 2 passed in 0.05s =========================',
  '',
].join('\n');

describe('parsePytest', () => {
  it('reads counts and the failing test with its location', () => {
    const parsed = parsePytest(PYTEST_FAIL, '');
    expect(parsed.parsed).toBe(true);
    expect(parsed.total).toBe(3);
    expect(parsed.passed).toBe(2);
    expect(parsed.failed).toBe(1);
    expect(parsed.failures).toHaveLength(1);
    expect(parsed.failures[0]?.name).toBe('test_add');
    expect(parsed.failures[0]?.path).toBe('tests/test_math.py');
    expect(parsed.failures[0]?.line).toBe(5);
    expect(parsed.failures[0]?.message).toContain('assert 2 == 3');
  });

  it('reports no_tests for an empty collection', () => {
    const parsed = parsePytest('no tests ran in 0.01s\n', '');
    expect(parsed.noTestsDetected).toBe(true);
    expect(parsed.failed).toBe(0);
  });

  it('leaves parsed=false when the summary is missing (the -qq trap)', () => {
    const parsed = parsePytest('...                                                                      [100%]\n', '');
    expect(parsed.parsed).toBe(false);
    expect(parsed.failures).toHaveLength(0);
  });

  it('keeps an error entry from the short summary', () => {
    const text = [
      'ERROR tests/test_x.py::test_b - RuntimeError: boom',
      '1 error in 0.02s',
    ].join('\n');
    const parsed = parsePytest(text, '');
    expect(parsed.errors).toBe(1);
    expect(parsed.failures[0]?.name).toBe('test_b');
  });
});

describe('parseUnittest', () => {
  it('reads Ran/FAILED lines', () => {
    const text = [
      'FAIL: test_b (tests.test_x.TestX)',
      '----------------------------------------------------------------------',
      'Traceback (most recent call last):',
      '  File "D:\\proj\\tests\\test_x.py", line 12, in test_b',
      '    self.assertEqual(1, 2)',
      'AssertionError: 1 != 2',
      '',
      '----------------------------------------------------------------------',
      'Ran 3 tests in 0.01s',
      '',
      'FAILED (failures=1, errors=0, skipped=1)',
      '',
    ].join('\n');
    const parsed = parseUnittest(text, '');
    expect(parsed.parsed).toBe(true);
    expect(parsed.total).toBe(3);
    expect(parsed.failed).toBe(1);
    expect(parsed.skipped).toBe(1);
    expect(parsed.passed).toBe(1);
    expect(parsed.failures[0]?.name).toBe('test_b');
    expect(parsed.failures[0]?.suite).toBe('tests.test_x.TestX');
    expect(parsed.failures[0]?.line).toBe(12);
  });

  it('reads an OK run', () => {
    const text = ['Ran 2 tests in 0.00s', '', 'OK', ''].join('\n');
    const parsed = parseUnittest(text, '');
    expect(parsed.passed).toBe(2);
    expect(parsed.failed).toBe(0);
  });
});

describe('parseJunit', () => {
  it('merges the Surefire header, detail line and stack frame into one failure', () => {
    const text = [
      '[INFO] Running com.example.UserServiceTest',
      '[ERROR] Tests run: 3, Failures: 1, Errors: 0, Skipped: 1, Time elapsed: 0.05 s <<< FAILURE! -- in com.example.UserServiceTest',
      '[ERROR] com.example.UserServiceTest.lengthOfTitle -- Time elapsed: 0.01 s <<< FAILURE!',
      'java.lang.AssertionError: expected:<2> but was:<1>',
      '\tat com.example.UserService.lengthOfTitle(UserService.java:12)',
      '[ERROR]   UserServiceTest.lengthOfTitle:12 expected:<2> but was:<1>',
      '[ERROR] Tests run: 3, Failures: 1, Errors: 0, Skipped: 1',
    ].join('\n');
    const parsed = parseJunit(text, '');
    expect(parsed.parsed).toBe(true);
    expect(parsed.total).toBe(3);
    expect(parsed.failed).toBe(1);
    expect(parsed.skipped).toBe(1);
    expect(parsed.passed).toBe(1);
    expect(parsed.failures).toHaveLength(1);
    expect(parsed.failures[0]?.name).toBe('lengthOfTitle');
    expect(parsed.failures[0]?.suite).toBe('com.example.UserServiceTest');
    expect(parsed.failures[0]?.path).toBe('UserService.java');
    expect(parsed.failures[0]?.line).toBe(12);
  });

  it('locates the failure in the test class, not in JUnit internals (Phase 10 real output)', () => {
    const text = [
      '[ERROR] Tests run: 1, Failures: 1, Errors: 0, Skipped: 0, Time elapsed: 0.047 s <<< FAILURE! -- in com.example.TitleLengthTest',
      '[ERROR] com.example.TitleLengthTest.lengthOfTitleRejectsNullInput -- Time elapsed: 0.023 s <<< FAILURE!',
      'org.opentest4j.AssertionFailedError: Unexpected exception type thrown, expected: <java.lang.IllegalArgumentException> but was: <java.lang.NullPointerException>',
      '\tat org.junit.jupiter.api.AssertionFailureBuilder.build(AssertionFailureBuilder.java:151)',
      '\tat org.junit.jupiter.api.AssertThrows.assertThrows(AssertThrows.java:67)',
      '\tat com.example.TitleLengthTest.lengthOfTitleRejectsNullInput(TitleLengthTest.java:13)',
      '\tat com.example.UserService.lengthOfTitle(UserService.java:13)',
      '[ERROR] Tests run: 1, Failures: 1, Errors: 0, Skipped: 0',
    ].join('\n');
    const parsed = parseJunit(text, '');
    expect(parsed.parsed).toBe(true);
    expect(parsed.failed).toBe(1);
    expect(parsed.failures[0]?.path).toBe('TitleLengthTest.java');
    expect(parsed.failures[0]?.line).toBe(13);
    expect(parsed.failures[0]?.stackHead?.[0]).toContain('AssertionFailureBuilder');
  });

  it('reads Gradle output', () => {
    const text = [
      '> Task :test FAILED',
      'UserServiceTest > lengthOfTitle FAILED',
      '3 tests completed, 1 failed',
    ].join('\n');
    const parsed = parseJunit(text, '');
    expect(parsed.parsed).toBe(true);
    expect(parsed.total).toBe(3);
    expect(parsed.failed).toBe(1);
    expect(parsed.failures[0]?.name).toBe('lengthOfTitle');
    expect(parsed.failures[0]?.suite).toBe('UserServiceTest');
  });
});

describe('parseJest', () => {
  it('reads the Tests: summary and the failing test', () => {
    const text = [
      'FAIL test/math.test.js',
      '  ● math › add works',
      '',
      '    expect(received).toBe(expected)',
      '',
      '    Expected: 3',
      '    Received: 2',
      '',
      '      5 |   expect(add(1, 1)).toBe(3)',
      '        |                     ^',
      '',
      '      at Object.<anonymous> (test/math.test.js:5:22)',
      '',
      'Tests:       1 failed, 2 passed, 3 total',
      'Test Suites: 1 failed, 1 total',
    ].join('\n');
    const parsed = parseJest(text, '');
    expect(parsed.parsed).toBe(true);
    expect(parsed.total).toBe(3);
    expect(parsed.passed).toBe(2);
    expect(parsed.failed).toBe(1);
    expect(parsed.failures[0]?.name).toBe('add works');
    expect(parsed.failures[0]?.suite).toBe('math');
    expect(parsed.failures[0]?.path).toBe('test/math.test.js');
    expect(parsed.failures[0]?.line).toBe(5);
  });
});

describe('parseVitest', () => {
  it('reads the Tests line and the × entries with reasons', () => {
    const text = [
      ' ❯ tests/unit/math.test.ts (3 tests | 1 failed) 12ms',
      '   × add works 5ms',
      '     → expected 2 to be 3',
      '   ✓ sub works',
      '',
      ' Test Files  1 failed (1)',
      '      Tests  1 failed | 2 passed (3)',
    ].join('\n');
    const parsed = parseVitest(text, '');
    expect(parsed.parsed).toBe(true);
    expect(parsed.total).toBe(3);
    expect(parsed.passed).toBe(2);
    expect(parsed.failed).toBe(1);
    expect(parsed.failures[0]?.name).toBe('add works');
    expect(parsed.failures[0]?.path).toBe('tests/unit/math.test.ts');
    expect(parsed.failures[0]?.message).toContain('expected 2 to be 3');
    expect(parsed.failures[0]?.durationMs).toBe(5);
    expect(parsed.slowest[0]?.durationMs).toBe(12);
  });
});

describe('parseNodeTest', () => {
  it('reads the TAP counters and the failing test', () => {
    const text = [
      'TAP version 13',
      'ok 1 - add',
      'not ok 2 - subtract',
      '  ---',
      '  Error: expected 1 to equal 2',
      '      at TestContext.<anonymous> (file:///D:/x/test/math.test.js:7:5)',
      '  ...',
      '1..2',
      '# tests 2',
      '# suites 0',
      '# pass 1',
      '# fail 1',
      '# cancelled 0',
      '# skipped 0',
    ].join('\n');
    const parsed = parseNodeTest(text, '');
    expect(parsed.parsed).toBe(true);
    expect(parsed.total).toBe(2);
    expect(parsed.passed).toBe(1);
    expect(parsed.failed).toBe(1);
    expect(parsed.failures[0]?.name).toBe('subtract');
    expect(parsed.failures[0]?.message).toContain('expected 1 to equal 2');
  });

  it('reads the spec reporter output', () => {
    const text = ['✔ add (0.5ms)', '✖ subtract (1.2ms)', '  Error: nope', '# tests 2', '# pass 1', '# fail 1'].join(
      '\n',
    );
    const parsed = parseNodeTest(text, '');
    expect(parsed.total).toBe(2);
    expect(parsed.failures[0]?.name).toBe('subtract');
  });
});

describe('parseTestOutput', () => {
  it('uses the planned framework when it parses', () => {
    const outcome = parseTestOutput('pytest', PYTEST_FAIL, '');
    expect(outcome.parser).toBe('pytest');
    expect(outcome.failed).toBe(1);
  });

  it('falls back to whichever parser understands the output', () => {
    const jestOutput = 'Tests:       1 failed, 1 total\n';
    const outcome = parseTestOutput('node-test', jestOutput, '');
    expect(outcome.parser).toBe('jest');
    expect(outcome.failed).toBe(1);
  });

  it('reports parser=unknown instead of inventing counts', () => {
    const outcome = parseTestOutput('pytest', 'something went wrong\n', '');
    expect(outcome.parser).toBe('unknown');
    expect(outcome.parsed).toBe(false);
    expect(outcome.failed).toBe(0);
  });
});
