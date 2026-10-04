import { promises as fs } from 'node:fs';
import path from 'node:path';

import { IgnoreMatcher, globToRegExpSource } from './gitignore.js';
import { toPosix } from '../security/path-policy.js';

/**
 * Ignore-aware file walk (docs/ROADMAP.md Phase 2). One walk feeds the scanner, the
 * project map and — from Phase 3 on — the symbol index, so the ignore rules and the caps
 * live here and nowhere else.
 *
 * Guarantees
 *  - never follows symlinks (a link cannot be used to escape the workspace, nor to loop)
 *  - never enters `.git`, `.devpilot` or an excluded directory
 *  - deterministic order (entries sorted; breadth-first, shallow before deep)
 *  - bounded: file count, depth, and per-file size are all capped
 */

export type FileLanguage =
  | 'python'
  | 'java'
  | 'kotlin'
  | 'typescript'
  | 'javascript'
  | 'c'
  | 'cpp'
  | 'go'
  | 'rust'
  | 'csharp'
  | 'ruby'
  | 'php'
  | 'sql'
  | 'shell'
  | 'json'
  | 'yaml'
  | 'toml'
  | 'xml'
  | 'markdown'
  | 'text'
  | 'binary'
  | 'other';

export interface WalkedFile {
  /** workspace-relative, POSIX separators */
  path: string;
  /** absolute, native separators */
  absolute: string;
  name: string;
  /** lowercase, with the dot ('' when absent) */
  ext: string;
  size: number;
  mtimeMs: number;
  language: FileLanguage;
}

export interface WalkOptions {
  root: string;
  /** `config.workspace.exclude`: plain names or relative paths, applied at any depth. */
  exclude?: readonly string[];
  /** Tool-level extra excludes (same syntax as `exclude`). */
  extraExclude?: readonly string[];
  /** Tool-level include filter: globs resolved like gitignore patterns. */
  include?: readonly string[];
  maxFiles?: number;
  maxDepth?: number;
  maxFileSizeBytes?: number;
  respectGitignore?: boolean;
  /** Called for progress/logging; never throws into the walk. */
  onSkip?: (info: { path: string; reason: 'oversized' | 'symlink' | 'unreadable' | 'excluded' }) => void;
}

export interface WalkResult {
  files: WalkedFile[];
  /** Directories below the root, POSIX relative, in visit order. */
  dirs: string[];
  /** Total size of the returned files. */
  bytes: number;
  truncated: boolean;
  skipped: { oversized: number; symlinks: number; unreadable: number; excluded: number };
  /** files and bytes per language, for the scanner's summary. */
  languages: Record<string, { files: number; bytes: number }>;
  gitignoreLayers: number;
  durationMs: number;
  maxDepthReached: number;
}

/** Never project source, whatever the config says. */
const ALWAYS_SKIP = new Set(['.git', '.devpilot', 'node_modules', 'lost+found']);

const LANGUAGE_BY_EXT: Record<string, FileLanguage> = {
  '.py': 'python',
  '.pyi': 'python',
  '.java': 'java',
  '.kt': 'kotlin',
  '.kts': 'kotlin',
  '.ts': 'typescript',
  '.tsx': 'typescript',
  '.mts': 'typescript',
  '.cts': 'typescript',
  '.js': 'javascript',
  '.jsx': 'javascript',
  '.mjs': 'javascript',
  '.cjs': 'javascript',
  '.c': 'c',
  '.h': 'c',
  '.cc': 'cpp',
  '.cpp': 'cpp',
  '.cxx': 'cpp',
  '.hpp': 'cpp',
  '.go': 'go',
  '.rs': 'rust',
  '.cs': 'csharp',
  '.rb': 'ruby',
  '.php': 'php',
  '.sql': 'sql',
  '.sh': 'shell',
  '.bash': 'shell',
  '.ps1': 'shell',
  '.bat': 'shell',
  '.cmd': 'shell',
  '.json': 'json',
  '.jsonc': 'json',
  '.yml': 'yaml',
  '.yaml': 'yaml',
  '.toml': 'toml',
  '.xml': 'xml',
  '.md': 'markdown',
  '.markdown': 'markdown',
  '.txt': 'text',
  '.rst': 'text',
  '.cfg': 'text',
  '.ini': 'text',
  '.properties': 'text',
  '.env': 'text',
};

const BINARY_EXT = new Set([
  '.png', '.jpg', '.jpeg', '.gif', '.bmp', '.ico', '.webp', '.svgz', '.pdf', '.zip',
  '.gz', '.tar', '.tgz', '.bz2', '.xz', '.7z', '.rar', '.jar', '.war', '.class',
  '.so', '.dll', '.dylib', '.exe', '.bin', '.dat', '.pyc', '.pyo', '.pdb', '.onnx',
  '.pt', '.pth', '.ckpt', '.safetensors', '.h5', '.pb', '.parquet', '.db', '.sqlite',
  '.woff', '.woff2', '.ttf', '.otf', '.mp3', '.mp4', '.mov', '.avi', '.wav', '.npy',
  '.npz', '.pkl', '.pickle', '.lock',
]);

export function languageOf(ext: string): FileLanguage {
  if (BINARY_EXT.has(ext)) return 'binary';
  return LANGUAGE_BY_EXT[ext] ?? (ext === '' ? 'text' : 'other');
}

/** Extensions whose contents are worth parsing as code (Phase 3 and the project map). */
export const SOURCE_LANGUAGES: readonly FileLanguage[] = [
  'python',
  'java',
  'kotlin',
  'typescript',
  'javascript',
];

/** Config/tool excludes: a plain name matches any path segment, a path matches a prefix. */
export function matchesExclude(relativePath: string, exclude: readonly string[]): boolean {
  const segments = relativePath.split('/');
  for (const raw of exclude) {
    const entry = raw.replace(/\\/g, '/').replace(/^\.\//, '').replace(/\/+$/, '');
    if (entry === '') continue;
    if (entry.includes('/')) {
      if (relativePath === entry || relativePath.startsWith(`${entry}/`)) return true;
      continue;
    }
    if (segments.includes(entry)) return true;
  }
  return false;
}

/** Include filter: gitignore-style globs (a bare name matches at any depth). */
export function matchesInclude(relativePath: string, include: readonly string[]): boolean {
  const test = (pattern: string): boolean => {
    const body = pattern.replace(/\\/g, '/').replace(/^\.\//, '');
    const anchored = body.includes('/');
    const source = globToRegExpSource(anchored ? body.replace(/^\//, '') : body);
    return new RegExp(anchored ? `^${source}$` : `(?:^|/)${source}$`).test(relativePath);
  };
  return include.some(test);
}

const DEFAULT_MAX_FILES = 20_000;
const DEFAULT_MAX_DEPTH = 32;
const DEFAULT_MAX_FILE_SIZE = 2_097_152;

export async function walkWorkspace(options: WalkOptions): Promise<WalkResult> {
  const started = Date.now();
  const root = path.resolve(options.root);
  const maxFiles = options.maxFiles ?? DEFAULT_MAX_FILES;
  const maxDepth = options.maxDepth ?? DEFAULT_MAX_DEPTH;
  const maxFileSize = options.maxFileSizeBytes ?? DEFAULT_MAX_FILE_SIZE;
  const respectGitignore = options.respectGitignore ?? true;
  const exclude = [...(options.exclude ?? []), ...(options.extraExclude ?? [])];
  const include = options.include ?? [];

  const matcher = new IgnoreMatcher();
  const files: WalkedFile[] = [];
  const dirs: string[] = [];
  const languages: Record<string, { files: number; bytes: number }> = {};
  const skipped = { oversized: 0, symlinks: 0, unreadable: 0, excluded: 0 };
  let bytes = 0;
  let truncated = false;
  let maxDepthReached = 0;

  const queue: { absolute: string; relative: string; depth: number }[] = [
    { absolute: root, relative: '', depth: 0 },
  ];

  while (queue.length > 0) {
    const current = queue.shift();
    if (!current) break;
    maxDepthReached = Math.max(maxDepthReached, current.depth);

    let entries;
    try {
      entries = await fs.readdir(current.absolute, { withFileTypes: true });
    } catch {
      skipped.unreadable += 1;
      continue;
    }
    entries.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));

    if (respectGitignore) {
      try {
        const ignoreFile = path.join(current.absolute, '.gitignore');
        const text = await fs.readFile(ignoreFile, 'utf8');
        matcher.addLayer(current.relative, text);
      } catch {
        // no .gitignore here — the inherited layers still apply
      }
    }

    for (const entry of entries) {
      const absolute = path.join(current.absolute, entry.name);
      const relative = current.relative === '' ? entry.name : `${current.relative}/${entry.name}`;

      if (entry.isSymbolicLink()) {
        skipped.symlinks += 1;
        options.onSkip?.({ path: relative, reason: 'symlink' });
        continue;
      }

      const always = ALWAYS_SKIP.has(entry.name);
      const excluded =
        always ||
        matchesExclude(relative, exclude) ||
        (respectGitignore && matcher.isIgnored(relative, entry.isDirectory()));
      if (excluded) {
        skipped.excluded += 1;
        options.onSkip?.({ path: relative, reason: 'excluded' });
        continue;
      }

      if (entry.isDirectory()) {
        if (current.depth + 1 > maxDepth) continue;
        dirs.push(relative);
        queue.push({ absolute, relative, depth: current.depth + 1 });
        continue;
      }

      if (!entry.isFile()) continue;
      if (include.length > 0 && !matchesInclude(relative, include)) {
        skipped.excluded += 1;
        continue;
      }

      let stats;
      try {
        stats = await fs.stat(absolute);
      } catch {
        skipped.unreadable += 1;
        options.onSkip?.({ path: relative, reason: 'unreadable' });
        continue;
      }

      if (stats.size > maxFileSize) {
        skipped.oversized += 1;
        options.onSkip?.({ path: relative, reason: 'oversized' });
        continue;
      }

      if (files.length >= maxFiles) {
        truncated = true;
        break;
      }

      const ext = path.extname(entry.name).toLowerCase();
      const language = languageOf(ext);
      files.push({
        path: relative,
        absolute,
        name: entry.name,
        ext,
        size: stats.size,
        mtimeMs: stats.mtimeMs,
        language,
      });
      bytes += stats.size;
      const bucket = languages[language] ?? { files: 0, bytes: 0 };
      bucket.files += 1;
      bucket.bytes += stats.size;
      languages[language] = bucket;
    }

    if (truncated) break;
  }

  return {
    files,
    dirs,
    bytes,
    truncated,
    skipped,
    languages,
    gitignoreLayers: matcher.layerCount,
    durationMs: Date.now() - started,
    maxDepthReached,
  };
}

/** POSIX-relative path of `absolute` inside `root` (helper for callers holding files). */
export function relativeTo(root: string, absolute: string): string {
  return toPosix(path.relative(root, absolute));
}
