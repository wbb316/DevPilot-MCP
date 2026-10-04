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
 *
 * Two rules were added after real-runner acceptance (Phase 10) because guessed ordering was
 * actively misleading:
 *
 * - A frame that could be verified is reported before one that could not. JVM traces print only
 *   a file name, so `AssertionFailureBuilder.java:151` (JUnit internals) used to outrank the
 *   test's own file; the caller now supplies the workspace to resolve bare names against, and
 *   unresolvable frames move to the back instead of becoming the primary location.
 * - Paths are matched with a non-ASCII-tolerant character class. A Windows profile can live under
 *   `C:\Users\王贝波\…`, and an ASCII-only class split such a path after the CJK characters —
 *   worse, inside a percent-encoded `file:///` URL it bit off `A2/AppData/…` from `%E6%B3%A2`.
 */

const FILE_EXTENSIONS =
  'py|pyi|java|kt|kts|ts|tsx|js|jsx|mjs|cjs|c|cc|cpp|cxx|h|hpp|go|rs|rb|php|cs|swift|scala|sh|ps1|sql|vue|svelte';

const FRAME_PATTERNS: readonly RegExp[] = [
  // node:test prints the frame as a percent-encoded URL: file:///C:/Users/%E7%8E%8B…/x.test.js:7:10
  new RegExp(
    `file:\\/\\/\\/?(?<url>[^\\s'")]+?\\.(?:${FILE_EXTENSIONS})):(?<line>\\d+)(?::(?<column>\\d+))?`,
    'g',
  ),
  // Python: File "C:\proj\train.py", line 214, in forward
  /File "(?<file>[^"\n]+)", line (?<line>\d+)/g,
  // JVM: at com.demo.UserService.lengthOfTitle(UserService.java:12)
  /at\s+[\w$.<>]+\((?<file>[^()\s]+\.(?:java|kt|kts)):(?<line>\d+)\)/g,
  // JS/TS: at forward (C:\proj\src\model.ts:118:17)  /  at C:\proj\src\model.ts:118:17
  /at\s+(?:[^\n()]*?\()?(?<file>(?:[A-Za-z]:)?[^\s()]+\.(?:ts|tsx|js|jsx|mjs|cjs)):(?<line>\d+):(?<column>\d+)\)?/g,
  // Generic: tests/test_model.py:41  /  src/model.ts:118  /  location: 'C:\Users\王贝波\p\x.test.js:6:1'
  // The lookbehind stops a match from starting inside a longer token (a percent-encoded URL).
  new RegExp(
    `(?<![\\w%.@/\\\\-])(?<file>(?:[A-Za-z]:)?[^\\s'"()<>|:*?]+?\\.(?:${FILE_EXTENSIONS})):(?<line>\\d+)(?::(?<column>\\d+))?`,
    'g',
  ),
];

export interface LocationScanOptions {
  /** Maps a bare file name (`UserService.java`, as JVM frames print it) to a workspace path. */
  resolveBareName?: (fileName: string) => string | undefined;
  /** Reports whether a workspace-relative path exists. Omitted → every relative frame counts as verified. */
  fileExists?: (relativePath: string) => boolean;
}

export interface LocationScan {
  locations: DiagnosisLocation[];
  /** Stack frames that resolved outside the workspace (dependencies, runtime, JDK). */
  externalFrames: number;
  /** Frames naming a file that exists nowhere in the workspace (dependency or JDK code). */
  unresolvedFrames: number;
}

type FrameResolution = { path: string; verified: boolean } | 'external' | undefined;

/** Dependency/runtime trees: a frame there is real, but it is not where the agent should edit. */
const LIBRARY_MARKERS =
  /(?:^|\/)(?:site-packages|dist-packages|node_modules|\.venv|venv|\.git|\.tox)(?:\/|$)/i;

function decodeSafe(value: string): string {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

function resolveFrame(root: string, rawInput: string, options: LocationScanOptions): FrameResolution {
  let raw = rawInput.trim().replace(/^["']|["']$/g, '');
  if (raw === '') return undefined;
  // Runtime-internal or bundler-virtual paths are never workspace files.
  if (/^(?:node:|internal\/|webpack:|vite:|data:)/i.test(raw)) return undefined;

  if (/^file:\/\//i.test(raw)) {
    raw = raw.replace(/^file:\/\//i, '');
    // file:///C:/x → /C:/x → C:/x
    while (raw.startsWith('/') && /^\/[A-Za-z]:/.test(raw)) raw = raw.slice(1);
  }
  // node:test prints its frames percent-encoded (`%E7%8E%8B…`); decode before resolving. A path
  // with a literal `%` that is not valid encoding is left untouched.
  raw = decodeSafe(raw);
  if (raw === '') return undefined;

  const driveRelative = /^[A-Za-z]:/.test(raw);
  const hasSeparator = /[\\/]/.test(raw);

  // A JVM frame carries only the file name: resolve it against the workspace when we can, and
  // otherwise keep it but mark it unverified so it cannot outrank a real project file.
  if (!hasSeparator && !driveRelative) {
    const resolved = options.resolveBareName?.(raw);
    if (resolved !== undefined) return { path: resolved, verified: true };
    return { path: raw, verified: false };
  }

  // A leading separator means "absolute" even when the host is Windows and the log came from
  // a Linux runtime (WSL, Docker, CI): such a frame is outside the workspace either way.
  const absolute = path.isAbsolute(raw) || /^[\\/]/.test(raw);
  if (absolute) {
    if (LIBRARY_MARKERS.test(toPosix(raw))) return 'external';
    if (!isInside(root, raw)) return 'external';
    return { path: toPosix(path.relative(root, raw)), verified: true };
  }

  const normalized = path.posix.normalize(toPosix(raw)).replace(/^\.\//, '');
  if (normalized === '' || normalized === '.' || normalized.startsWith('..')) return undefined;
  if (LIBRARY_MARKERS.test(normalized)) return 'external';
  const verified = options.fileExists === undefined ? true : options.fileExists(normalized);
  return { path: normalized, verified };
}

/**
 * Locations deduplicated and capped at `limit`, verified ones first (each group keeps the order
 * in which the frames appeared).
 */
export function extractLocations(
  text: string,
  root: string,
  limit = 8,
  options: LocationScanOptions = {},
): LocationScan {
  const verified: DiagnosisLocation[] = [];
  const unverified: DiagnosisLocation[] = [];
  const seen = new Set<string>();
  let externalFrames = 0;
  let unresolvedFrames = 0;
  // Scanning stops once enough candidates are collected; a log can be 2 MiB of frames.
  const softCap = Math.max(limit * 4, 16);

  outer: for (const pattern of FRAME_PATTERNS) {
    pattern.lastIndex = 0;
    for (const match of text.matchAll(pattern)) {
      const groups = match.groups;
      if (groups === undefined) continue;
      const raw = groups['url'] ?? groups['file'];
      if (raw === undefined) continue;

      const resolved = resolveFrame(root, raw, options);
      if (resolved === 'external') {
        externalFrames += 1;
        continue;
      }
      if (resolved === undefined) continue;

      const line = numberOrUndefined(groups['line']);
      const column = numberOrUndefined(groups['column']);
      const key = `${resolved.path}:${line ?? 0}`;
      if (seen.has(key)) continue;
      seen.add(key);

      const location: DiagnosisLocation = { path: resolved.path };
      if (line !== undefined) location.line = line;
      if (column !== undefined) location.column = column;
      if (resolved.verified) {
        verified.push(location);
      } else {
        unverified.push(location);
        unresolvedFrames += 1;
      }
      if (verified.length + unverified.length >= softCap) break outer;
    }
  }

  return { locations: [...verified, ...unverified].slice(0, limit), externalFrames, unresolvedFrames };
}

function numberOrUndefined(value: string | undefined): number | undefined {
  if (value === undefined) return undefined;
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : undefined;
}
