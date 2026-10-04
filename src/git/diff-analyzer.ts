import { promises as fs } from 'node:fs';
import path from 'node:path';

import { extractFile } from '../code/extract.js';
import { languageOf } from '../workspace/file-walker.js';
import { toPosix } from '../security/path-policy.js';
import { writeTextAtomic } from '../storage/json-store.js';
import { EMPTY_TREE_SHA } from '../types/git.js';
import type { ChangedFile, ChangedFileStatus, DiffReview, RiskLevel } from '../types/git.js';
import type { WorkspacePaths } from '../types/workspace.js';
import type { Logger } from '../log/logger.js';
import { assessRisk, isTestPath, maxRisk, RISK_ORDER } from './risk.js';
import { readBaseline } from './baseline.js';
import type { GitManager } from './git-manager.js';

/**
 * `review_diff`'s engine (docs/TOOLS.md Phase 7).
 *
 * Four git reads feed one structured review: `--name-status` (what happened to each path),
 * `--numstat` (how much, and whether the file is binary), `--unified=0` (which line ranges
 * changed, used to name the symbols a change actually touches) and `status --porcelain`
 * (untracked files, which no diff against HEAD shows).
 *
 * Anything the review cannot know is stated in `notes` rather than guessed.
 */

export interface AnalyzeDiffInput {
  root: string;
  paths: WorkspacePaths;
  git: GitManager;
  staged?: boolean;
  base?: string;
  includePatch?: boolean;
  maxFiles?: number;
  logger?: Logger;
}

export interface AnalyzeDiffOutcome {
  review: DiffReview;
  repoRootMismatch: boolean;
}

const DEFAULT_MAX_FILES = 200;
const MAX_SYMBOL_FILE_BYTES = 2_097_152;
const MAX_CHANGED_SYMBOLS_PER_FILE = 50;

/** git quotes paths containing controls/whitespace and escapes them C-style. */
export function unquoteGitPath(raw: string): string {
  const trimmed = raw.trim();
  if (!trimmed.startsWith('"') || !trimmed.endsWith('"')) return trimmed;
  const body = trimmed.slice(1, -1);
  let out = '';
  for (let i = 0; i < body.length; i += 1) {
    const ch = body[i] as string;
    if (ch !== '\\') {
      out += ch;
      continue;
    }
    const next = body[i + 1];
    if (next === undefined) break;
    if (/[0-7]/.test(next)) {
      const octal = body.slice(i + 1, i + 4);
      out += String.fromCharCode(Number.parseInt(octal, 8));
      i += 3;
      continue;
    }
    const escapes: Record<string, string> = { n: '\n', t: '\t', r: '\r', '"': '"', '\\': '\\' };
    out += escapes[next] ?? next;
    i += 1;
  }
  return out;
}

/** `-M` renders renames as `old => new` or `{old => new}` inside a shared prefix. */
export function resolveRenameSpec(spec: string): string {
  if (!spec.includes(' => ')) return spec;
  const braced = /\{(.*?) => (.*?)\}/.exec(spec);
  if (braced !== null) {
    return spec.replace(braced[0], braced[2] as string);
  }
  const parts = spec.split(' => ');
  return parts[parts.length - 1] as string;
}

export interface NumstatEntry {
  addedLines: number;
  deletedLines: number;
  binary: boolean;
}

export function parseNumstat(text: string): Map<string, NumstatEntry> {
  const map = new Map<string, NumstatEntry>();
  for (const line of text.split(/\r?\n/)) {
    if (line.trim() === '') continue;
    const parts = line.split('\t');
    if (parts.length < 3) continue;
    const addedRaw = parts[0] as string;
    const deletedRaw = parts[1] as string;
    const pathRaw = unquoteGitPath(parts.slice(2).join('\t'));
    const resolved = resolveRenameSpec(pathRaw).split(path.sep).join('/');
    const binary = addedRaw === '-' || deletedRaw === '-';
    map.set(resolved, {
      addedLines: binary ? 0 : Number.parseInt(addedRaw, 10) || 0,
      deletedLines: binary ? 0 : Number.parseInt(deletedRaw, 10) || 0,
      binary,
    });
  }
  return map;
}

const STATUS_LETTERS: Record<string, ChangedFileStatus> = {
  A: 'added',
  M: 'modified',
  D: 'deleted',
  R: 'renamed',
  C: 'modified',
  T: 'modified',
};

export function parseNameStatus(text: string): Map<string, ChangedFileStatus> {
  const map = new Map<string, ChangedFileStatus>();
  for (const line of text.split(/\r?\n/)) {
    if (line.trim() === '') continue;
    const parts = line.split('\t');
    const letter = (parts[0] as string).slice(0, 1);
    const status = STATUS_LETTERS[letter];
    if (status === undefined) continue;
    // A rename/copy line is `R100\told\tnew`; every other line is `<status>\tpath`.
    const rawPath = parts.length >= 3 && (letter === 'R' || letter === 'C') ? (parts[2] as string) : (parts[1] as string);
    if (rawPath === undefined) continue;
    map.set(unquoteGitPath(rawPath).split(path.sep).join('/'), status);
  }
  return map;
}

/** New-side line ranges per path, from a `--unified=0` diff. */
export function parseHunkRanges(text: string): Map<string, [number, number][]> {
  const map = new Map<string, [number, number][]>();
  let current: string | undefined;
  for (const line of text.split(/\r?\n/)) {
    if (line.startsWith('+++ ')) {
      const raw = line.slice(4).trim();
      current = raw === '/dev/null' ? undefined : unquoteGitPath(raw.replace(/^b\//, '')).split(path.sep).join('/');
      continue;
    }
    if (current === undefined || !line.startsWith('@@')) continue;
    const match = /^@@ -\d+(?:,\d+)? \+(\d+)(?:,(\d+))? @@/.exec(line);
    if (match === null) continue;
    const start = Number.parseInt(match[1] as string, 10);
    const count = match[2] === undefined ? 1 : Number.parseInt(match[2], 10);
    if (count === 0) continue;
    const ranges = map.get(current) ?? [];
    ranges.push([start, start + count - 1]);
    map.set(current, ranges);
  }
  return map;
}

function linesOverlap(ranges: readonly [number, number][], startLine: number, endLine: number): boolean {
  return ranges.some(([start, end]) => startLine <= end && endLine >= start);
}

/** Symbols whose span intersects the changed line ranges of one file. */
async function changedSymbolsFor(
  root: string,
  relativePath: string,
  ranges: readonly [number, number][],
): Promise<string[]> {
  if (ranges.length === 0) return [];
  const absolute = path.join(root, relativePath.split('/').join(path.sep));
  let text: string;
  try {
    const stat = await fs.stat(absolute);
    if (stat.size > MAX_SYMBOL_FILE_BYTES) return [];
    text = await fs.readFile(absolute, 'utf8');
  } catch {
    return [];
  }

  const language = languageOf(path.extname(relativePath).toLowerCase());
  const parsed = extractFile(language, text, { path: relativePath });
  if (parsed === undefined) return [];

  const names: string[] = [];
  for (const symbol of parsed.symbols) {
    if (!linesOverlap(ranges, symbol.startLine, symbol.endLine)) continue;
    const label = symbol.parentName === undefined ? symbol.name : `${symbol.parentName}.${symbol.name}`;
    if (!names.includes(label)) names.push(label);
    if (names.length >= MAX_CHANGED_SYMBOLS_PER_FILE) break;
  }
  return names;
}

function stampFor(now: Date): string {
  return now.toISOString().replace(/[-:]/g, '').replace(/\..+$/, '').replace('T', '-');
}

export async function analyzeDiff(input: AnalyzeDiffInput): Promise<AnalyzeDiffOutcome> {
  const { git, root, paths } = input;
  const staged = input.staged === true;
  const maxFiles = input.maxFiles ?? DEFAULT_MAX_FILES;
  const notes: string[] = [];

  const base = input.base ?? ((await git.hasCommit()) ? 'HEAD' : EMPTY_TREE_SHA);
  if (base === EMPTY_TREE_SHA) {
    notes.push('the repository has no commit yet: every tracked file is compared against the empty tree');
  }

  const [nameStatusText, numstatText, hunkText, statuses, repoRoot] = await Promise.all([
    git.diffNameStatus(base, staged),
    git.diffNumstat(base, staged),
    git.diffUnifiedZero(base, staged),
    git.pathStatuses(),
    git.repositoryRoot(),
  ]);

  const repoRootMismatch = repoRoot !== undefined && repoRoot !== root;
  if (repoRootMismatch) {
    notes.push(`paths are relative to the repository root ${repoRoot}, not to the workspace root`);
  }

  const nameStatus = parseNameStatus(nameStatusText);
  const numstat = parseNumstat(numstatText);
  const hunks = parseHunkRanges(hunkText);

  const paths0 = new Set<string>([...nameStatus.keys(), ...numstat.keys()]);
  if (!staged) {
    for (const [file, xy] of statuses) {
      if (xy === '??') paths0.add(file);
    }
  }

  // DevPilot's own state directory is not part of the agent's change set.
  const devpilotPaths = [...paths0].filter((file) => file.startsWith('.devpilot'));
  for (const file of devpilotPaths) paths0.delete(file);
  if (devpilotPaths.length > 0) {
    notes.push(`${devpilotPaths.length} .devpilot path(s) excluded (DevPilot's own state, not your change)`);
  }

  const all = [...paths0].sort();
  const truncated = all.length > maxFiles;
  const selected = truncated ? all.slice(0, maxFiles) : all;
  if (truncated) {
    notes.push(`${all.length - maxFiles} changed file(s) were not analysed (maxFiles=${maxFiles})`);
  }

  const files: ChangedFile[] = [];
  for (const file of selected) {
    const status: ChangedFileStatus = nameStatus.get(file) ?? (statuses.get(file) === '??' ? 'untracked' : 'modified');
    let addedLines = numstat.get(file)?.addedLines ?? 0;
    let deletedLines = numstat.get(file)?.deletedLines ?? 0;
    const binary = numstat.get(file)?.binary ?? false;

    if (status === 'untracked') {
      try {
        const text = await fs.readFile(path.join(root, file.split('/').join(path.sep)), 'utf8');
        addedLines = text.split('\n').length - (text.endsWith('\n') ? 1 : 0);
      } catch {
        addedLines = 0;
      }
    }

    const changedSymbols =
      status === 'deleted' || binary
        ? []
        : await changedSymbolsFor(root, file, hunks.get(file) ?? []);

    const assessed = assessRisk({
      path: file,
      status,
      addedLines,
      deletedLines,
      binary,
      changedSymbols,
    });

    const entry: ChangedFile = {
      path: file,
      status,
      addedLines,
      deletedLines,
      risk: assessed.risk,
      reasons: assessed.reasons,
    };
    if (binary) entry.binary = true;
    if (changedSymbols.length > 0) entry.changedSymbols = changedSymbols;
    files.push(entry);
  }

  files.sort((a, b) => RISK_ORDER[b.risk] - RISK_ORDER[a.risk] || a.path.localeCompare(b.path));

  const totals = {
    files: files.length,
    addedLines: files.reduce((sum, file) => sum + file.addedLines, 0),
    deletedLines: files.reduce((sum, file) => sum + file.deletedLines, 0),
  };

  let riskLevel: RiskLevel = 'LOW';
  for (const file of files) riskLevel = maxRisk(riskLevel, file.risk);

  const baseline = await readBaseline(paths);
  const preExistingChanges =
    baseline === undefined
      ? []
      : [...baseline.changed, ...baseline.untracked].filter((file) => paths0.has(file)).sort();
  if (baseline === undefined && files.length > 0) {
    notes.push('no baseline was captured when this workspace was opened: preExistingChanges is empty');
  }

  const review: DiffReview = {
    files,
    totals,
    riskLevel,
    affectedTests: files.filter((file) => isTestPath(file.path)).map((file) => file.path),
    unrelatedFiles: [],
    highRisk: files.filter((file) => file.risk === 'HIGH').map((file) => file.path),
    preExistingChanges,
  };

  if (review.unrelatedFiles.length === 0 && files.length > 0) {
    notes.push('unrelatedFiles is empty: no declared intent/impact set was supplied for this review');
  }
  if (truncated) review.truncated = true;

  if (input.includePatch === true) {
    const patch = await git.diffPatchText(base, staged);
    const relative = `.devpilot/logs/diff-${stampFor(new Date())}.patch`;
    const absolute = path.join(paths.logsDir, path.basename(relative));
    await writeTextAtomic(absolute, patch);
    review.patchArtifact = toPosix(relative);
  }

  if (notes.length > 0) review.notes = notes;

  input.logger?.debug('diff analysed', {
    base,
    staged,
    files: files.length,
    risk: riskLevel,
  });

  return { review, repoRootMismatch };
}
