import type { Limits } from '../types/workspace.js';

/**
 * Change-budget enforcement (docs/ROADMAP.md Phase 9: `max_files_changed` / `max_lines_changed`).
 *
 * The point is not to forbid large work, it is to stop an agent from presenting a 40-file,
 * 4000-line diff as one finished change: that change set cannot be reviewed, tested or rolled back
 * coherently. When the budget is exceeded the caller reports it and the agent must stage the work.
 *
 * The budget governs the change set the **agent** produced. On a dirty working tree the review's
 * totals also contain work that was already there when the workspace was opened; those paths are
 * listed in `preExistingChanges`, and the caller passes their count as `excludedPreExisting` so a
 * user's own uncommitted work can never be reported as the agent overrunning its budget (post-V1
 * fix: on a real project 72 pre-existing paths turned a one-line change into `risk HIGH` plus a
 * "change budget exceeded" warning). Excluding a path also means that an agent edit to an
 * already-dirty file is not counted; the verdict says so rather than pretending the count is exact.
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
  /** The totals the budget was applied to (agent-attributable changes only). */
  counted: ChangeTotals;
  /** Changed paths left out of the budget because they pre-date this session. */
  excludedPreExisting: number;
  advice?: string;
}

/**
 * A limit of 0 (or negative) means "no budget configured" and is never a violation — config.yml can
 * deliberately raise the ceiling, and 0 is the documented way to say "unlimited".
 */
export function checkChangeLimits(
  totals: ChangeTotals,
  limits: Limits,
  excludedPreExisting = 0,
): ChangeLimitVerdict {
  const changedLines = totals.addedLines + totals.deletedLines;
  const violations: ChangeLimitViolation[] = [];

  if (limits.maxFilesChanged > 0 && totals.files > limits.maxFilesChanged) {
    violations.push({ limit: 'max_files_changed', allowed: limits.maxFilesChanged, actual: totals.files });
  }
  if (limits.maxLinesChanged > 0 && changedLines > limits.maxLinesChanged) {
    violations.push({ limit: 'max_lines_changed', allowed: limits.maxLinesChanged, actual: changedLines });
  }

  const verdict: ChangeLimitVerdict = {
    exceeded: violations.length > 0,
    changedLines,
    violations,
    counted: totals,
    excludedPreExisting,
  };
  if (verdict.exceeded) {
    const detail = violations
      .map((violation) => `${violation.limit} ${violation.actual} > ${violation.allowed}`)
      .join('; ');
    verdict.advice =
      `change budget exceeded (${detail}): stage the work instead of finishing it in one pass — ` +
      'create_checkpoint, change one coherent unit, run_tests, review_diff, report, then continue. ' +
      'Raise security.max_files_changed / security.max_lines_changed in .devpilot/config.yml only ' +
      'when one coherent change genuinely needs it.' +
      (excludedPreExisting === 0
        ? ''
        : ` (${excludedPreExisting} pre-existing path(s) were excluded from this budget, so an edit ` +
          'you also made to one of them is not counted here)');
  }
  return verdict;
}
