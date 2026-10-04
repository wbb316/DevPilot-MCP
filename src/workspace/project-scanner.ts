import { createHash } from 'node:crypto';
import { promises as fs } from 'node:fs';
import path from 'node:path';

import type { DevPilotConfig } from '../config/config-schema.js';
import type { Logger } from '../log/logger.js';
import type { GitState, IndexState, ProjectProfile, WorkspacePaths } from '../types/workspace.js';
import { resolveLimits } from '../config/config-schema.js';
import { readJson, writeJsonAtomic } from '../storage/json-store.js';
import { walkWorkspace, SOURCE_LANGUAGES, type FileLanguage } from './file-walker.js';
import { detectProject } from './project-detector.js';

/**
 * Project scanner (docs/ROADMAP.md Phase 2, docs/TOOLS.md `scan_project`).
 *
 * The scan answers, in one call: what is this project, how big is it, what is at the top
 * level, and how would one build/test/run it. Results are cached in
 * `<workspace>/.devpilot/cache/project.json` so `get_workspace_status` and repeated
 * `scan_project` calls do not re-walk a 5000-file repository.
 *
 * Cache honesty (documented, not hidden): the cheap cache key covers the workspace config,
 * the tool arguments, the git HEAD and the *top level* of the tree (names, sizes, mtimes).
 * A deep edit inside `src/` does not change the top level, so it is only noticed by
 * `force: true` or by Phase 3's per-file `mtime+size` index — every response that came from
 * the cache says so in `notes`. The cache is never used when `force` is set.
 */

/**
 * Bump when detection/walk semantics change: the cache key covers the *tree*, not this code,
 * so without a version a smarter detector would keep serving profiles built by the old rules.
 */
export const SCANNER_VERSION = 3;

export interface ScanStats {  files: number;
  dirs: number;
  bytes: number;
  durationMs: number;
  fromCache: boolean;
  truncated: boolean;
  skipped: { oversized: number; symlinks: number; unreadable: number; excluded: number };
  maxDepthReached: number;
}

export interface LanguageStats {
  files: number;
  bytes: number;
}

export type TopLevelHint =
  | 'source'
  | 'tests'
  | 'config'
  | 'docs'
  | 'data'
  | 'scripts'
  | 'ci'
  | 'manifest'
  | 'infra'
  | 'other';

export interface TopLevelEntry {
  name: string;
  type: 'file' | 'dir';
  files: number;
  bytes: number;
  hint: TopLevelHint;
}

/** Shape of `<workspace>/.devpilot/cache/project.json`. */
export interface ProjectCacheFile {
  version: 1;
  scannerVersion: number;
  cacheScope: 'top-level';
  root: string;
  scannedAt: string;
  cacheKey: string;
  stats: ScanStats;
  profile: ProjectProfile;
  languages: Record<string, LanguageStats>;
  topLevel: TopLevelEntry[];
  notes: string[];
}

export interface ScanResult extends ProjectCacheFile {
  indexState: IndexState;
  cacheFile: string;
  cacheHit: boolean;
}

export interface ScanProjectOptions {
  root: string;
  paths: WorkspacePaths;
  config: DevPilotConfig;
  name?: string;
  force?: boolean;
  include?: readonly string[];
  exclude?: readonly string[];
  /** Session git snapshot — lets a clean repository prove the tree is unchanged. */
  git?: GitState;
  logger?: Logger;
}

const HINT_RULES: readonly { hint: TopLevelHint; names: readonly string[] }[] = [
  { hint: 'tests', names: ['test', 'tests', 'spec', 'specs', '__tests__', 'e2e', 'integration-tests'] },
  { hint: 'source', names: ['src', 'app', 'lib', 'libs', 'pkg', 'packages', 'source', 'core', 'internal', 'cmd', 'java', 'python'] },
  { hint: 'config', names: ['config', 'configs', 'conf', 'settings', 'resources', 'env'] },
  { hint: 'docs', names: ['docs', 'doc', 'documentation', 'examples', 'notebooks'] },
  { hint: 'data', names: ['data', 'dataset', 'datasets', 'checkpoints', 'models', 'weights', 'artifacts', 'outputs', 'runs'] },
  { hint: 'scripts', names: ['scripts', 'script', 'tools', 'bin', 'hack', 'make'] },
  { hint: 'ci', names: ['.github', '.gitlab', '.circleci', '.azure'] },
  { hint: 'infra', names: ['deploy', 'deployment', 'docker', 'k8s', 'kubernetes', 'helm', 'terraform', 'ansible', 'infra'] },
];

const MANIFEST_FILES = new Set([
  'package.json',
  'pom.xml',
  'build.gradle',
  'build.gradle.kts',
  'settings.gradle',
  'pyproject.toml',
  'requirements.txt',
  'setup.py',
  'setup.cfg',
  'Cargo.toml',
  'go.mod',
  'CMakeLists.txt',
  'Dockerfile',
  'docker-compose.yml',
  'docker-compose.yaml',
  'tsconfig.json',
  'Makefile',
  'justfile',
]);

export function hintFor(name: string, type: 'file' | 'dir'): TopLevelHint {
  if (type === 'file') {
    if (MANIFEST_FILES.has(name)) return 'manifest';
    if (/^(readme|license|licence|changelog|contributing|authors|notice)/i.test(name)) return 'docs';
    if (name.endsWith('.sln') || name.endsWith('.csproj')) return 'manifest';
    return 'other';
  }
  const lowered = name.toLowerCase();
  for (const rule of HINT_RULES) {
    if (rule.names.includes(lowered)) return rule.hint;
  }
  return 'other';
}

interface TopLevelObservation {
  name: string;
  type: 'file' | 'dir';
  mtimeMs: number;
  size: number;
}

/** Never part of the cache key: our own state, git internals, and vendored dependencies. */
const SKIP_IN_OBSERVATION = new Set(['.devpilot', '.git', 'node_modules']);

/**
 * Cheap observation of the tree's top level — the basis of the cache key. DevPilot's own
 * directory and the git internals are skipped on purpose: writing the cache must not
 * invalidate the cache, and `git status` rewrites `.git/index` on nearly every call.
 */
async function observeTopLevel(root: string): Promise<TopLevelObservation[]> {
  let entries;
  try {
    entries = await fs.readdir(root, { withFileTypes: true });
  } catch {
    return [];
  }
  const observations: TopLevelObservation[] = [];
  for (const entry of entries) {
    if (entry.isSymbolicLink()) continue;
    if (SKIP_IN_OBSERVATION.has(entry.name)) continue;
    let stats;
    try {
      stats = await fs.stat(path.join(root, entry.name));
    } catch {
      continue;
    }
    observations.push({
      name: entry.name,
      type: entry.isDirectory() ? 'dir' : 'file',
      mtimeMs: Math.floor(stats.mtimeMs),
      size: stats.size,
    });
  }
  observations.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
  return observations;
}

async function mtimeOf(target: string): Promise<number> {
  try {
    const stats = await fs.stat(target);
    return Math.floor(stats.mtimeMs);
  } catch {
    return 0;
  }
}

export interface CacheKeyInputs {
  root: string;
  config: DevPilotConfig;
  include?: readonly string[];
  exclude?: readonly string[];
  git?: GitState;
}

export async function computeCacheKey(inputs: CacheKeyInputs): Promise<string> {
  const limited = {
    excludes: [...inputs.config.workspace.exclude].sort(),
    maxFiles: inputs.config.workspace.max_files,
    maxFileSize: inputs.config.workspace.max_file_size_bytes,
    indexLanguages: [...inputs.config.index.languages].sort(),
    include: [...(inputs.include ?? [])].sort(),
    exclude: [...(inputs.exclude ?? [])].sort(),
  };
  const payload = {
    scope: 'top-level',
    v: 1,
    scanner: SCANNER_VERSION,
    limited,
    configMtime: await mtimeOf(path.join(inputs.root, '.devpilot', 'config.yml')),
    top: await observeTopLevel(inputs.root),
    gitHead: inputs.git?.isRepo === true ? (inputs.git.head ?? '') : '',
  };
  return createHash('sha1').update(JSON.stringify(payload)).digest('hex').slice(0, 16);
}

export function projectCacheFile(paths: WorkspacePaths): string {
  return path.join(paths.cacheDir, 'project.json');
}

export async function readProjectCache(paths: WorkspacePaths): Promise<ProjectCacheFile | undefined> {
  try {
    const result = await readJson<ProjectCacheFile | undefined>(projectCacheFile(paths), undefined);
    const value = result.value;
    if (value === undefined || value === null) return undefined;
    if (value.version !== 1 || value.scannerVersion !== SCANNER_VERSION || typeof value.cacheKey !== 'string') {
      return undefined;
    }
    return value;
  } catch {
    return undefined;
  }
}

function summarizeTopLevel(files: readonly { path: string; size: number }[], dirs: readonly string[]): TopLevelEntry[] {
  const buckets = new Map<string, TopLevelEntry>();
  const ensure = (name: string, type: 'file' | 'dir'): TopLevelEntry => {
    const existing = buckets.get(name);
    if (existing) return existing;
    const entry: TopLevelEntry = { name, type, files: 0, bytes: 0, hint: hintFor(name, type) };
    buckets.set(name, entry);
    return entry;
  };

  for (const dir of dirs) {
    const first = dir.split('/')[0] as string;
    if (first !== '') ensure(first, 'dir');
  }
  for (const file of files) {
    const segments = file.path.split('/');
    const first = segments[0] as string;
    const isRootFile = segments.length === 1;
    const entry = ensure(first, isRootFile ? 'file' : 'dir');
    entry.files += 1;
    entry.bytes += file.size;
  }

  return [...buckets.values()].sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
}

function sourceFileCount(languages: Record<string, LanguageStats>): number {
  let total = 0;
  for (const language of SOURCE_LANGUAGES) {
    total += languages[language]?.files ?? 0;
  }
  return total;
}

/**
 * Scan a workspace: walk (or reuse the cache), detect the project, persist the profile.
 * Pure read-only with respect to the user's files — the only write is under `.devpilot/cache/`.
 */
export async function scanProject(options: ScanProjectOptions): Promise<ScanResult> {
  const started = Date.now();
  const root = path.resolve(options.root);
  const cacheFile = projectCacheFile(options.paths);
  const notes: string[] = [];
  const limits = resolveLimits(options.config);

  const cacheKey = await computeCacheKey({
    root,
    config: options.config,
    include: options.include,
    exclude: options.exclude,
    git: options.git,
  });

  const bypass = options.force === true;
  const dirtyNote =
    'working tree is dirty: the cache key covers the top level and HEAD only — pass force: true to re-walk after deep edits';
  const isDirty = options.git?.isRepo === true && options.git.dirty === true;
  if (bypass) notes.push('cache bypassed: force = true');
  else if (isDirty) notes.push(dirtyNote);

  if (!bypass) {
    const cached = await readProjectCache(options.paths);
    if (cached !== undefined && cached.cacheKey === cacheKey) {
      const hitNotes = [...cached.notes];
      if (isDirty && !hitNotes.includes(dirtyNote)) hitNotes.push(dirtyNote);
      options.logger?.debug('scan cache hit', { root, files: cached.stats.files });
      return {
        ...cached,
        notes: hitNotes,
        stats: { ...cached.stats, fromCache: true, durationMs: Date.now() - started },
        indexState: 'ready',
        cacheFile,
        cacheHit: true,
      };
    }
  }

  const walk = await walkWorkspace({
    root,
    exclude: options.config.workspace.exclude,
    extraExclude: options.exclude,
    include: options.include,
    maxFiles: limits.maxFilesIndexed,
    maxDepth: limits.walkMaxDepth,
    maxFileSizeBytes: limits.maxFileSizeBytes,
  });

  if (walk.truncated) {
    notes.push(
      `file cap reached (workspace.max_files = ${limits.maxFilesIndexed}); the profile covers the first ${walk.files.length} files`,
    );
  }
  if (walk.skipped.oversized > 0) {
    notes.push(`${walk.skipped.oversized} file(s) skipped as larger than ${limits.maxFileSizeBytes} bytes`);
  }
  if (walk.skipped.symlinks > 0) {
    notes.push(`${walk.skipped.symlinks} symlink(s) skipped (never followed)`);
  }

  const profile = await detectProject(root, {
    name: options.name ?? path.basename(root),
    config: options.config,
    files: walk.files.map((file) => file.path),
    truncated: walk.truncated,
  });

  const topLevel = summarizeTopLevel(walk.files, walk.dirs);
  const stats: ScanStats = {
    files: walk.files.length,
    dirs: walk.dirs.length,
    bytes: walk.bytes,
    durationMs: Date.now() - started,
    fromCache: false,
    truncated: walk.truncated,
    skipped: walk.skipped,
    maxDepthReached: walk.maxDepthReached,
  };

  const cache: ProjectCacheFile = {
    version: 1,
    scannerVersion: SCANNER_VERSION,
    cacheScope: 'top-level',
    root,
    scannedAt: new Date().toISOString(),
    cacheKey,
    stats,
    profile,
    languages: walk.languages,
    topLevel,
    notes,
  };

  await writeJsonAtomic(cacheFile, cache);
  options.logger?.info('project scanned', {
    root,
    files: stats.files,
    bytes: stats.bytes,
    durationMs: stats.durationMs,
    language: profile.languages.join('/'),
    projectType: profile.projectType,
  });

  return { ...cache, indexState: 'ready', cacheFile, cacheHit: false };
}

/** Used by the tool layer: a project is unsupported when nothing recognizable was found. */
export function isUnsupported(profile: ProjectProfile, languages: Record<string, LanguageStats>): boolean {
  return profile.markers.length === 0 && sourceFileCount(languages) === 0;
}

export type { FileLanguage };
