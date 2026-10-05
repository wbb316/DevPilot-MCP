import { describe, expect, it } from 'vitest';

import { checkChangeLimits } from '../../src/security/change-limits';
import { DEFAULT_LIMITS } from '../../src/security/limits';

describe('change budget enforcement', () => {
  it('accepts a change set inside the budget', () => {
    const verdict = checkChangeLimits({ files: 3, addedLines: 40, deletedLines: 10 }, DEFAULT_LIMITS);
    expect(verdict.exceeded).toBe(false);
    expect(verdict.violations).toEqual([]);
    expect(verdict.advice).toBeUndefined();
    expect(verdict.changedLines).toBe(50);
  });

  it('reports the file-count violation with staging advice', () => {
    const verdict = checkChangeLimits(
      { files: DEFAULT_LIMITS.maxFilesChanged + 4, addedLines: 10, deletedLines: 5 },
      DEFAULT_LIMITS,
    );
    expect(verdict.exceeded).toBe(true);
    expect(verdict.violations).toEqual([
      { limit: 'max_files_changed', allowed: DEFAULT_LIMITS.maxFilesChanged, actual: DEFAULT_LIMITS.maxFilesChanged + 4 },
    ]);
    expect(verdict.advice).toContain('stage the work');
    expect(verdict.advice).toContain('create_checkpoint');
  });

  it('counts added and deleted lines together', () => {
    const verdict = checkChangeLimits(
      { files: 1, addedLines: DEFAULT_LIMITS.maxLinesChanged, deletedLines: 1 },
      DEFAULT_LIMITS,
    );
    expect(verdict.exceeded).toBe(true);
    expect(verdict.violations[0]?.limit).toBe('max_lines_changed');
    expect(verdict.changedLines).toBe(DEFAULT_LIMITS.maxLinesChanged + 1);
  });

  it('treats a zero limit as unlimited', () => {
    const verdict = checkChangeLimits(
      { files: 5_000, addedLines: 100_000, deletedLines: 100_000 },
      { ...DEFAULT_LIMITS, maxFilesChanged: 0, maxLinesChanged: 0 },
    );
    expect(verdict.exceeded).toBe(false);
  });

  it('echoes what it really counted and how much pre-existing work it left out', () => {
    const verdict = checkChangeLimits({ files: 2, addedLines: 10, deletedLines: 4 }, DEFAULT_LIMITS, 72);
    expect(verdict.exceeded).toBe(false);
    expect(verdict.counted).toEqual({ files: 2, addedLines: 10, deletedLines: 4 });
    expect(verdict.excludedPreExisting).toBe(72);
    expect(verdict.changedLines).toBe(14);
  });

  it('says in the staging advice that an excluded path is not counted', () => {
    const verdict = checkChangeLimits(
      { files: DEFAULT_LIMITS.maxFilesChanged + 1, addedLines: 1, deletedLines: 0 },
      DEFAULT_LIMITS,
      30,
    );
    expect(verdict.exceeded).toBe(true);
    expect(verdict.advice).toContain('stage the work');
    expect(verdict.advice).toContain('30 pre-existing path(s) were excluded');
  });
});
