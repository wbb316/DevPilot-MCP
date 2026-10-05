import { describe, expect, it } from 'vitest';

import { legacyPathCandidate, unquoteGitPath } from '../../src/git/git-path';

/**
 * Regression coverage for a defect found on a real project: `create_checkpoint` recorded 23 files as
 * patch-only because their CJK names were decoded byte-by-byte into mojibake, so `fs.stat` on the
 * decoded name always failed. A rollback would then have skipped every one of them.
 */
describe('git path unquoting', () => {
  it('passes an unquoted path through, trimming surrounding whitespace', () => {
    expect(unquoteGitPath('src/plain.ts')).toBe('src/plain.ts');
    expect(unquoteGitPath('  src/padded.ts  ')).toBe('src/padded.ts');
  });

  it('decodes ASCII escapes', () => {
    expect(unquoteGitPath('"src/a\\tb.ts"')).toBe('src/a\tb.ts');
    expect(unquoteGitPath('"quote\\"inside.txt"')).toBe('quote"inside.txt');
    expect(unquoteGitPath('"back\\\\slash.txt"')).toBe('back\\slash.txt');
  });

  it('decodes octal escapes as UTF-8 bytes, never as individual characters', () => {
    expect(unquoteGitPath('"docs/\\346\\226\\207\\346\\241\\243.md"')).toBe('docs/文档.md');
    // The previous implementation produced Latin-1 mojibake here (`\u00e6\u0096\u0087…`).
    expect(unquoteGitPath('"docs/\\346\\226\\207\\346\\241\\243.md"')).not.toContain('\u00e6');
  });

  it('decodes four-byte sequences and mixed ASCII/non-ASCII paths', () => {
    expect(unquoteGitPath('"docs/\\360\\237\\230\\200 ok.md"')).toBe('docs/😀 ok.md');
    expect(unquoteGitPath('"\\344\\270\\255\\346\\226\\207 and ascii.txt"')).toBe('中文 and ascii.txt');
  });

  it('keeps literal non-ASCII inside quotes (core.quotepath=false output)', () => {
    expect(unquoteGitPath('"docs/文档.md"')).toBe('docs/文档.md');
  });

  it('never throws on malformed input', () => {
    expect(unquoteGitPath('"abc\\"')).toBe('abc');
    expect(unquoteGitPath('"')).toBe('');
    // A truncated octal escape decodes to whatever bytes git actually wrote (possibly invalid
    // UTF-8) — the contract is only that it returns a string instead of throwing.
    expect(typeof unquoteGitPath('"\\346\\22"')).toBe('string');
  });
});

/** The transformation the pre-fix `pathStatuses()` performed, so the recovery can be round-tripped. */
function legacyForm(relative: string, separator: string): string {
  let out = '';
  for (const byte of Buffer.from(relative, 'utf8')) {
    out += byte < 0x80 ? String.fromCharCode(byte) : `${separator}${byte.toString(8).padStart(3, '0')}`;
  }
  return out;
}

/**
 * Baselines written before the decoding fix persisted that escaped form, so the names they recorded
 * stopped matching the files on disk: on a real project 13 CJK paths were charged to the agent's
 * change budget. Recovery is exact, but it is only *offered* — the caller confirms the candidate
 * against a path that really exists, which is what makes it safe despite ambiguous numeric segments.
 */
describe('recovery of pre-fix baseline paths', () => {
  // Verbatim from a real .devpilot/cache/git-baseline.json (Windows: `\` had become `/`).
  const OBSERVED =
    'docs/report_output/v2_35M+1B//344/272/214/351/230/266/346/256/265/build_35m_dashboard.py';
  const REAL = 'docs/report_output/v2_35M+1B/二阶段/build_35m_dashboard.py';

  it('recovers the escaped form a real baseline contained', () => {
    expect(legacyPathCandidate(OBSERVED)).toBe(REAL);
  });

  it('recovers the backslash spelling a POSIX host would have kept', () => {
    expect(legacyPathCandidate(legacyForm(REAL, '\\'))).toBe(REAL);
  });

  it('round-trips CJK, spaces and four-byte characters', () => {
    for (const relative of [
      'docs/文档 说明.md',
      'scratch/接管续接点.md',
      'docs/😀 ok.md',
      'docs/report_output/v2_35M+1B/二阶段/chart_data_35m.json',
    ]) {
      expect(legacyPathCandidate(legacyForm(relative, '/'))).toBe(relative);
      expect(legacyPathCandidate(legacyForm(relative, '\\'))).toBe(relative);
    }
  });

  it('offers no candidate for a plain path', () => {
    expect(legacyPathCandidate('src/app.py')).toBeUndefined();
    // `/150` is 0o150 = `h`, but the low byte means it is not a plausible UTF-8 escape, so the
    // slash form is rejected and the path is left alone.
    expect(legacyPathCandidate('docs/report/150/notes.md')).toBeUndefined();
  });

  it('trusts a backslash group even for a low byte', () => {
    // git escapes a control character as `\011`; on POSIX the backslash survives, so it cannot be
    // confused with a path separator. The Windows slash form can, so only it is gated on the byte.
    expect(legacyPathCandidate('docs/a\\011b.md')).toBe('docs/a\tb.md');
    expect(legacyPathCandidate('docs/a/011b.md')).toBeUndefined();
  });
});
