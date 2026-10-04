import path from 'node:path';

import { isInside, toPosix } from '../security/path-policy.js';
import type { DiagnosisLocation } from '../types/diagnosis.js';

/**
 * Source-location extraction from failure output (docs/DATA-MODEL.md §6 `location`).
 *
 * Four families of frames are understood — Python tracebacks, JVM stack traces, JS/TS stack
 * traces and a generic `file.ext:line:col` form. A path is only reported when it resolves
 * inside the workspace; frames pointing at site-packages / node_modules / an installed JDK are
 * counted (so the agent can be told they were skipped) but never returned, because a library
 * frame is not where the agent should edit.
 */

const FRAME_PATTERNS: readonly RegExp[] = [
  // Python: File "C:\proj\train.py", line 214, in forward
  /File "(?<file>[^"\n]+)", line (?<line>\d+)/g,
  // JVM: at com.demo.UserService.lengthOfTitle(UserService.java:12)
  /at\s+[\w$.<>]+\((?<file>[^()\s]+\.(?:java|kt|kts)):(?<line>\d+)\)/g,
  // JS/TS: at forward (C:\proj\src\model.ts:118:17)  /  at C:\proj\src\model.ts:118:17
  /at\s+(?:[^\n()]*?\()?(?<file>(?:[A-Za-z]:)?[^\s()]+\.(?:ts|tsx|js|jsx|mjs|cjs)):(?<line>\d+):(?<column>\d+)\)?/g,
  // Generic: tests/test_model.py:41: AssertionError  /  src/model.ts:118
  /(?<file>(?:[A-Za-z]:)?[A-Za-z0-9_@./\\-]+\.(?:py|java|kt|ts|tsx|js|jsx|mjs|cjs|c|cc|cpp|h|hpp|go|rs)):(?<line>\d+)(?::(?<column>\d+))?/g,
];

export interface LocationScan {
  locations: DiagnosisLocation[];
  /** Stack frames that resolved outside the workspace (dependencies, runtime, JDK). */
  externalFrames: number;
}

type PathResolution = string | 'external' | undefined;

/** Dependency/runtime trees: a frame there is real, but it is not where the agent should edit. */
const LIBRARY_MARKERS =
  /(?:^|\/)(?:site-packages|dist-packages|node_modules|\.venv|venv|\.git|\.tox)(?:\/|$)/i;

function resolveWithin(root: string, rawInput: string): PathResolution {
  let raw = rawInput.trim();
  if (raw === '') return undefined;
  if (/^file:\/\//i.test(raw)) raw = raw.replace(/^file:\/\//i, '');
  raw = raw.replace(/^["']|["']$/g, '');
  if (raw === '') return undefined;
  // Runtime-internal or bundler-virtual paths are never workspace files.
  if (/^(?:node:|internal\/|webpack:|vite:|data:)/i.test(raw)) return undefined;

  // A leading separator means "absolute" even when the host is Windows and the log came from
  // a Linux runtime (WSL, Docker, CI): such a frame is outside the workspace either way.
  const absolute = path.isAbsolute(raw) || /^[\\/]/.test(raw);
  if (absolute) {
    if (LIBRARY_MARKERS.test(toPosix(raw))) return 'external';
    return isInside(root, raw) ? toPosix(path.relative(root, raw)) : 'external';
  }

  const normalized = path.posix.normalize(toPosix(raw)).replace(/^\.\//, '');
  if (normalized === '' || normalized === '.' || normalized.startsWith('..')) return undefined;
  if (LIBRARY_MARKERS.test(normalized)) return 'external';
  return normalized;
}

/** Locations in the order they appear, deduplicated, capped at `limit`. */
export function extractLocations(text: string, root: string, limit = 8): LocationScan {
  const locations: DiagnosisLocation[] = [];
  const seen = new Set<string>();
  let externalFrames = 0;

  for (const pattern of FRAME_PATTERNS) {
    pattern.lastIndex = 0;
    for (const match of text.matchAll(pattern)) {
      const groups = match.groups;
      if (groups === undefined) continue;
      const raw = groups['file'];
      if (raw === undefined) continue;
      const resolved = resolveWithin(root, raw);
      if (resolved === 'external') {
        externalFrames += 1;
        continue;
      }
      if (resolved === undefined) continue;

      const line = numberOrUndefined(groups['line']);
      const column = numberOrUndefined(groups['column']);
      const key = `${resolved}:${line ?? 0}`;
      if (seen.has(key)) continue;
      seen.add(key);

      const location: DiagnosisLocation = { path: resolved };
      if (line !== undefined) location.line = line;
      if (column !== undefined) location.column = column;
      locations.push(location);
      if (locations.length >= limit) return { locations, externalFrames };
    }
  }

  return { locations, externalFrames };
}

function numberOrUndefined(value: string | undefined): number | undefined {
  if (value === undefined) return undefined;
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : undefined;
}
