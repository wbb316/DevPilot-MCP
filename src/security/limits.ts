import type { Limits } from '../types/workspace.js';

/**
 * Hard ceilings. Values are frozen in docs/DATA-MODEL.md §2 / docs/WORKSPACE-LIFECYCLE.md §4.
 * A per-call argument may only lower these unless the config explicitly raises them.
 */
export const DEFAULT_LIMITS: Limits = {
  maxCommandSeconds: 120,
  maxOutputBytes: 262_144,
  maxFilesChanged: 20,
  maxLinesChanged: 3000,
  maxFilesIndexed: 20_000,
  maxFileSizeBytes: 2_097_152,
  walkMaxDepth: 32,
};

/** Merge limits, letting explicit overrides win. Unknown/undefined overrides are ignored. */
export function mergeLimits(base: Limits, override: Partial<Limits> = {}): Limits {
  const merged: Limits = { ...base };
  for (const key of Object.keys(base) as (keyof Limits)[]) {
    const value = override[key];
    if (typeof value === 'number' && Number.isFinite(value) && value > 0) {
      merged[key] = Math.floor(value);
    }
  }
  return merged;
}

/** Clamp a requested timeout into (0, ceiling]. Returns the ceiling for undefined input. */
export function clampTimeoutSeconds(requested: number | undefined, ceiling: number): number {
  if (requested === undefined || !Number.isFinite(requested) || requested <= 0) return ceiling;
  return Math.min(Math.floor(requested), ceiling);
}

/** Clamp a requested output cap into (0, ceiling]. */
export function clampOutputBytes(requested: number | undefined, ceiling: number): number {
  if (requested === undefined || !Number.isFinite(requested) || requested <= 0) return ceiling;
  return Math.min(Math.floor(requested), ceiling);
}
