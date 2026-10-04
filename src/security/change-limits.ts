import type { Limits } from '../types/workspace.js';

/**
 * Change-budget enforcement (docs/ROADMAP.md Phase 9: `max_files_changed` / `max_lines_changed`).
 *
 * The point is not to forbid large work, it is to stop an agent from presenting a 40-file,
 * 4000-line diff as one finished change: that change set cannot be reviewed, tested or rolled back
 * coherently. When the budget is exceeded the caller reports it and the agent must stage the work.
 */

export interface ChangeTotals {
  files: number;
  addedLines: number;
  deletedLines: number;
}

export type ChangeLimitName = 'max_files_changed' | 'max_lines_changed';

export interface ChangeLimitViolation {
  limit: ChangeLimitName;
  allowed: number;
  actual: number;
}

export interface ChangeLimitVerdict {
  exceeded: boolean;
  changedLines: number;
  violations: ChangeLimitViolation[];
  advice?: string;
}

/**
 * A limit of 0 (or negative) means "no budget configured" and is never a violation — config.yml can
 * deliberately raise the ceiling, and 0 is the documented way to say "unlimited".
 */
export function checkChangeLimits(totals: ChangeTotals, limits: Limits): ChangeLimitVerdict {
  const changedLines = totals.addedLines + totals.deletedLines;
  const violations: ChangeLimitViolation[] = [];

  if (limits.maxFilesChanged > 0 && totals.files > limits.maxFilesChanged) {
    violations.push({ limit: 'max_files_changed', allowed: limits.maxFilesChanged, actual: totals.files });
  }
  if (limits.maxLinesChanged > 0 && changedLines > limits.maxLinesChanged) {
    violations.push({ limit: 'max_lines_changed', allowed: limits.maxLinesChanged, actual: changedLines });
  }

  const verdict: ChangeLimitVerdict = { exceeded: violations.length > 0, changedLines, violations };
  if (verdict.exceeded) {
    const detail = violations
      .map((violation) => `${violation.limit} ${violation.actual} > ${violation.allowed}`)
      .join('; ');
    verdict.advice =
      `change budget exceeded (${detail}): stage the work instead of finishing it in one pass — ` +
      'create_checkpoint, change one coherent unit, run_tests, review_diff, report, then continue. ' +
      'Raise security.max_files_changed / security.max_lines_changed in .devpilot/config.yml only ' +
      'when one coherent change genuinely needs it.';
  }
  return verdict;
}
