import { describe, expect, it } from 'vitest';

import { parseIssues, tailLines } from '../../src/runner/issue-parser.js';

describe('parseIssues', () => {
  it('extracts javac errors with file and line', () => {
    const output = [
      'src/main/java/com/example/UserService.java:42: error: cannot find symbol',
      '  symbol:   variable missing',
      'src/main/java/com/example/UserService.java:10: warning: [deprecation] old() is deprecated',
    ].join('\n');
    const result = parseIssues(output, '');
    expect(result.errors[0]).toMatchObject({
      path: 'src/main/java/com/example/UserService.java',
      line: 42,
      severity: 'error',
      message: 'cannot find symbol',
    });
    expect(result.warnings[0]).toMatchObject({ line: 10, severity: 'warning' });
  });

  it('extracts maven errors with location and de-duplicates them', () => {
    const output = [
      '[ERROR] /proj/src/main/java/A.java:[12,5] cannot find symbol',
      '[ERROR] /proj/src/main/java/A.java:[12,5] cannot find symbol',
      '[ERROR] Failed to execute goal',
      '[WARNING] Using platform encoding',
    ].join('\n');
    const result = parseIssues('', output);
    expect(result.errors).toHaveLength(2);
    expect(result.errors[0]).toMatchObject({
      path: 'proj/src/main/java/A.java'.replace('proj/', '/proj/'),
      line: 12,
      column: 5,
    });
    expect(result.warnings[0]?.message).toContain('platform encoding');
  });

  it('extracts tsc diagnostics', () => {
    const output = [
      "src/util.ts(12,34): error TS2304: Cannot find name 'foo'.",
      'src/other.ts:7:9 - warning TS6133: value is declared but never read.',
    ].join('\n');
    const result = parseIssues(output, '');
    expect(result.errors[0]).toMatchObject({ path: 'src/util.ts', line: 12, column: 34, code: 'TS2304' });
    expect(result.warnings[0]).toMatchObject({ path: 'src/other.ts', code: 'TS6133' });
  });

  it('attributes a python traceback to the last file/line', () => {
    const output = [
      'Traceback (most recent call last):',
      '  File "/proj/train.py", line 214, in <module>',
      '    main()',
      'RuntimeError: CUDA out of memory',
    ].join('\n');
    const result = parseIssues('', output);
    expect(result.errors[0]).toMatchObject({
      path: '/proj/train.py',
      line: 214,
      code: 'RuntimeError',
      message: 'RuntimeError: CUDA out of memory',
    });
  });

  it('caps the list and says so', () => {
    const output = Array.from({ length: 60 }, (_, i) => `[ERROR] failure ${i}`).join('\n');
    const result = parseIssues(output, '', { maxIssues: 5 });
    expect(result.errors).toHaveLength(5);
    expect(result.truncated).toBe(true);
  });

  it('returns nothing for a clean build', () => {
    const result = parseIssues('BUILD SUCCESS\nAll good', '');
    expect(result.errors).toEqual([]);
    expect(result.warnings).toEqual([]);
    expect(result.truncated).toBe(false);
  });
});

describe('tailLines', () => {
  it('keeps the last non-empty lines', () => {
    expect(tailLines('a\n\nb\nc\n', 2)).toEqual(['b', 'c']);
    expect(tailLines('   \n', 5)).toEqual([]);
  });
});
