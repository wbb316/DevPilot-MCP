import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

import {
  analyzeFailure,
  buildDiagnosis,
  collectEvidence,
  collectSuspects,
  confidenceOf,
} from '../../src/diagnose/diagnose';
import { extractLocations } from '../../src/diagnose/location';
import { classifyFailure, hintFor } from '../../src/diagnose/patterns';
import { DIAGNOSIS_CATEGORIES, type DiagnosisCategory } from '../../src/types/diagnosis';
import type { JobRecord } from '../../src/types/execution';

/** A workspace root outside the repository: nothing here touches the user's files. */
const root = path.resolve(os.tmpdir(), 'devpilot-diagnose-proj');

function job(overrides: Partial<JobRecord> = {}): JobRecord {
  return {
    jobId: 'test-20250101-000000-abcd',
    kind: 'test',
    command: 'python',
    args: ['-m', 'pytest', '-p', 'no:cacheprovider'],
    cwd: root,
    startedAt: '2025-01-01T00:00:00.000Z',
    timedOut: false,
    stdoutBytes: 100,
    stderrBytes: 20,
    stdoutTruncated: false,
    stderrTruncated: false,
    exitCode: 1,
    logFile: path.join(root, '.devpilot', 'logs', 'test-20250101-000000-abcd.log'),
    ...overrides,
  };
}

describe('classifyFailure', () => {
  it('recognizes the failure families the fixtures and real projects produce', () => {
    const cases: [string, DiagnosisCategory][] = [
      ['RuntimeError: CUDA out of memory. Tried to allocate 2.00 GiB', 'CUDA_OUT_OF_MEMORY'],
      ['java.lang.NullPointerException: Cannot invoke method', 'NULL_POINTER'],
      ["AttributeError: 'NoneType' object has no attribute 'shape'", 'NULL_POINTER'],
      ['ModuleNotFoundError: No module named torch', 'IMPORT_ERROR'],
      ['Cannot find module "./model"', 'IMPORT_ERROR'],
      ['IndentationError: unexpected indent', 'SYNTAX_ERROR'],
      ['TypeError: unsupported operand type(s) for +', 'TYPE_ERROR'],
      ['AssertionError: one plus one is not three', 'ASSERTION_FAILED'],
      ['E       assert 1 == 2', 'ASSERTION_FAILED'],
      ['[ERROR] BUILD FAILURE', 'COMPILE_ERROR'],
      ['Could not resolve dependencies for project demo:artifact', 'DEPENDENCY_ERROR'],
      ['EADDRINUSE: address already in use :::3000', 'PORT_IN_USE'],
      ["UnicodeDecodeError: 'gbk' codec can't decode byte 0x80", 'ENCODING_ERROR'],
      ['fatal: not a git repository (or any of the parent directories)', 'GIT_ERROR'],
    ];
    for (const [text, expected] of cases) {
      expect(classifyFailure(text).category, text).toBe(expected);
    }
  });

  it('prefers a strong rule over a weaker one in the same log', () => {
    const text =
      'TypeError: unsupported operand type(s) for +: int and str\nModuleNotFoundError: No module named foo';
    expect(classifyFailure(text)).toEqual({ category: 'IMPORT_ERROR', weight: 'strong' });
  });

  it('treats a JS "is not a function" call as the null/undefined it usually is', () => {
    expect(classifyFailure('TypeError: ctx.attention is not a function').category).toBe('NULL_POINTER');
  });

  it('returns UNKNOWN with a hint when nothing matches', () => {
    expect(classifyFailure('everything went fine').category).toBe('UNKNOWN');
    expect(hintFor('UNKNOWN')).toMatch(/no rule matched/i);
  });

  it('has a hint for every declared category', () => {
    for (const category of DIAGNOSIS_CATEGORIES) {
      expect(hintFor(category).length, category).toBeGreaterThan(20);
    }
  });
});

describe('extractLocations', () => {
  it('reads a Python traceback frame that points into the workspace', () => {
    const file = path.join(root, 'train.py');
    const scan = extractLocations(`Traceback (most recent call last):\n  File "${file}", line 214, in forward\nRuntimeError: boom`, root);
    expect(scan.locations).toEqual([{ path: 'train.py', line: 214 }]);
    expect(scan.externalFrames).toBe(0);
  });

  it('ignores frames from dependencies and counts them instead', () => {
    const scan = extractLocations(
      'File "/usr/lib/python3.11/site-packages/torch/nn/modules/module.py", line 1501, in _call_impl',
      root,
    );
    expect(scan.locations).toEqual([]);
    expect(scan.externalFrames).toBe(1);
  });

  it('reads JVM, JS/TS and plain file:line frames', () => {
    const js = path.join(root, 'src', 'model.ts');
    expect(
      extractLocations('at com.demo.UserService.lengthOfTitle(UserService.java:12)', root).locations,
    ).toEqual([{ path: 'UserService.java', line: 12 }]);
    expect(extractLocations(`    at forward (${js}:118:17)`, root).locations).toEqual([
      { path: 'src/model.ts', line: 118, column: 17 },
    ]);
    expect(
      extractLocations('tests/test_model.py:41: AssertionError', root).locations,
    ).toEqual([{ path: 'tests/test_model.py', line: 41 }]);
  });

  it('deduplicates repeated frames and honours the limit', () => {
    const repeated = Array.from({ length: 5 }, () => 'tests/test_model.py:41: AssertionError').join('\n');
    expect(extractLocations(repeated, root).locations).toHaveLength(1);

    const many = Array.from({ length: 4 }, (_, index) => `src/f${index}.py:${index + 1}`).join('\n');
    expect(extractLocations(many, root, 2).locations).toHaveLength(2);
  });

  it('never reports a path that escapes the workspace', () => {
    const outside = path.resolve(root, '..', 'somewhere-else', 'app.py');
    expect(extractLocations(`File "${outside}", line 3, in main`, root).locations).toEqual([]);
  });
});

describe('collectEvidence', () => {
  it('keeps informative lines, skips noise, and reports what it dropped', () => {
    const text = [
      'collected 3 items',
      'DeprecationWarning: use of deprecated call',
      '',
      '=========================== FAILURES ============================',
      "E       AssertionError: one plus one is not three",
      'tests/test_zz_failing.py:3: AssertionError',
      '========================= short test summary info =========================',
      'FAILED tests/test_zz_failing.py::test_deliberate_failure - AssertionError',
      '1 failed, 2 passed in 0.05s',
    ].join('\n');

    const { evidence, dropped } = collectEvidence(text, 3);
    expect(evidence).toHaveLength(3);
    expect(evidence.join('\n')).not.toContain('DeprecationWarning');
    expect(dropped).toBeGreaterThanOrEqual(1);
    expect(text).toContain('1 failed'); // the summary line exists; the cap is what hides it
  });

  it('clips very long evidence lines', () => {
    const long = `assert something == ${'x'.repeat(600)}`;
    const { evidence } = collectEvidence(`AssertionError: ${long}`, 5);
    expect(evidence[0]?.length).toBeLessThan(420);
    expect(evidence[0]?.endsWith('…')).toBe(true);
  });
});

describe('collectSuspects', () => {
  it('orders by specificity and keeps the strongest reason per file', () => {
    const suspects = collectSuspects({
      locations: [{ path: 'train.py', line: 214 }, { path: 'model.py', line: 55 }],
      changedFiles: ['model.py', 'config/default.yaml'],
      importersOf: (relative) => (relative === 'model.py' ? ['train.py', 'sample.py'] : []),
    });
    expect(suspects).toEqual([
      { path: 'train.py', reason: 'in_stack' },
      { path: 'model.py', reason: 'in_stack' },
      { path: 'config/default.yaml', reason: 'recently_changed' },
      { path: 'sample.py', reason: 'import_related' },
    ]);
  });
});

describe('confidenceOf', () => {
  it('states confidence instead of implying certainty', () => {
    expect(confidenceOf('IMPORT_ERROR', 'strong', true)).toBe('high');
    expect(confidenceOf('IMPORT_ERROR', 'strong', false)).toBe('medium');
    expect(confidenceOf('TYPE_ERROR', 'weak', true)).toBe('medium');
    expect(confidenceOf('TYPE_ERROR', 'weak', false)).toBe('low');
    expect(confidenceOf('UNKNOWN', 'weak', true)).toBe('low');
  });
});

describe('analyzeFailure / buildDiagnosis', () => {
  it('produces the documented DiagnosisResult shape', () => {
    const text = [
      'Traceback (most recent call last):',
      `  File "${path.join(root, 'train.py')}", line 214, in forward`,
      'RuntimeError: CUDA out of memory. Tried to allocate 2.00 GiB',
    ].join('\n');
    const analysis = analyzeFailure(text, root);
    const result = buildDiagnosis({
      analysis,
      text,
      job: job(),
      logFile: '.devpilot/logs/test.log',
      changedFiles: ['train.py'],
      extraEvidence: ['train.py:214 | out = self.attn(x)'],
    });

    expect(result.category).toBe('CUDA_OUT_OF_MEMORY');
    expect(result.confidence).toBe('high');
    expect(result.location).toEqual({ path: 'train.py', line: 214 });
    expect(result.evidence[0]).toBe('train.py:214 | out = self.attn(x)');
    expect(result.suspectFiles).toEqual([{ path: 'train.py', reason: 'in_stack' }]);
    expect(result.relatedJob).toEqual({
      jobId: 'test-20250101-000000-abcd',
      command: 'python -m pytest -p no:cacheprovider',
      exitCode: 1,
    });
    expect(result.logFile).toBe('.devpilot/logs/test.log');
    expect(result.hint ?? '').toMatch(/batch size/i);
  });

  it('says so when there was nothing to read', () => {
    const result = buildDiagnosis({ analysis: analyzeFailure('', root), text: '' });
    expect(result.category).toBe('UNKNOWN');
    expect(result.notes?.join(' ')).toMatch(/empty/i);
    expect(result.location).toBeUndefined();
    expect(result.relatedJob).toBeUndefined();
  });

  it('notes an ignored dependency frame and a missing workspace location', () => {
    const text = [
      'File "/usr/lib/python3.11/site-packages/torch/nn/modules/module.py", line 1501, in _call_impl',
      'ModuleNotFoundError: No module named torch',
    ].join('\n');
    const result = buildDiagnosis({ analysis: analyzeFailure(text, root), text });
    expect(result.category).toBe('IMPORT_ERROR');
    expect(result.location).toBeUndefined();
    expect(result.notes?.join(' ')).toMatch(/outside the workspace/i);
    expect(result.notes?.join(' ')).toMatch(/no workspace-relative source location/i);
  });
});

describe('evidence noise', () => {
  it('drops TAP diagnostic keys but keeps a key whose value carries information', () => {
    const text = [
      '  error: |-',
      "  code: 'ERR_ASSERTION'",
      "  location: 'C:\\proj\\demo\\test\\x.test.js:7:10'",
      '  duration_ms: 5.238',
      '  error: Expected 1 to be 2',
      'Error: real evidence line',
    ].join('\n');
    const { evidence } = collectEvidence(text, 8);
    expect(evidence).toEqual(['error: Expected 1 to be 2', 'Error: real evidence line']);
  });
});
