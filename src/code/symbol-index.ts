import path from 'node:path';

import type { DevPilotConfig } from '../config/config-schema.js';
import type { Logger } from '../log/logger.js';
import type { WalkedFile } from '../workspace/file-walker.js';
import { walkWorkspace } from '../workspace/file-walker.js';
import type { IndexState, WorkspacePaths } from '../types/workspace.js';
import type {
  FileRecord,
  ImportEdge,
  IndexMeta,
  ReferenceHit,
  ReferenceRecord,
  SearchConfidence,
  SearchResult,
  SymbolHit,
  SymbolKind,
  SymbolRecord,
} from '../types/code.js';
import { EXTRACTOR_VERSION, extractFile, supportsLanguage } from './extract.js';
import type { IndexPersistence, IndexSnapshot } from './index-store.js';
import {
  INDEX_SCHEMA_VERSION,
  hashContent,
  openPersistence,
  readSourceText,
} from './index-store.js';

/**
 * Symbol index service (docs/ROADMAP.md Phase 3, docs/DATA-MODEL.md §4/§8).
 *
 * Incremental by construction: a refresh walks the tree (stat only) and re-parses exactly
 * the files whose `mtimeMs + size` changed; unchanged files keep their rows. Queries run
 * against the in-memory snapshot, which is saved back in one transaction only when
 * something actually changed.
 *
 * Honesty rules (docs/ARCHITECTURE.md §4.8):
 *  - `engine` is reported as `text`: the extractors are lexical/heuristic, not a compiler.
 *  - `confidence` is derived from what was actually found, never asserted.
 *  - everything skipped (unsupported language, oversized file, parse error, ref cap) is
 *    reported in `notes`, never silently dropped.
 */

export const DEFAULT_SYMBOL_LIMIT = 50;
export const MAX_SYMBOL_LIMIT = 200;
export const DEFAULT_REFERENCE_LIMIT = 100;
export const MAX_REFERENCE_LIMIT = 500;

const SOURCE_EXTENSIONS: readonly string[] = [
  '.ts',
  '.tsx',
  '.mts',
  '.cts',
  '.js',
  '.jsx',
  '.mjs',
  '.cjs',
  '.py',
  '.java',
];

export interface SymbolIndexOptions {
  root: string;
  paths: WorkspacePaths;
  config: DevPilotConfig;
  logger?: Logger;
}

export interface RefreshOptions {
  force?: boolean;
  include?: readonly string[];
  exclude?: readonly string[];
  maxFiles?: number;
}

export interface RefreshReport {
  indexState: IndexState;
  files: number;
  parsed: number;
  reused: number;
  removed: number;
  symbols: number;
  refs: number;
  imports: number;
  parseErrors: number;
  refsTruncated: number;
  durationMs: number;
  /** The walk hit its file cap: the index is partial. */
  truncatedWalk: boolean;
  store: 'sqlite' | 'json';
  notes: string[];
}

export interface SymbolQuery {
  kinds?: readonly SymbolKind[];
  /** Only symbols whose workspace-relative path starts with this prefix. */
  pathFilter?: string;
  caseSensitive?: boolean;
  limit?: number;
}

export interface ReferenceQuery {
  pathFilter?: string;
  caseSensitive?: boolean;
  /** Include `kind: 'text'` references (decorators/annotations). Default false. */
  includeText?: boolean;
  limit?: number;
}

export interface ReferenceGroup {
  path: string;
  count: number;
  lines: number[];
}

export interface ReferenceAnswer {
  result: SearchResult<ReferenceHit>;
  definition?: SymbolHit;
  definitions: SymbolHit[];
  grouped: ReferenceGroup[];
}

interface ScoredSymbol {
  record: SymbolRecord;
  score: number;
}

/** Lazily reads source lines so reference snippets cost one read per file per query. */
class SourceCache {
  private readonly lines = new Map<string, string[] | undefined>();

  constructor(private readonly root: string) {}

  async snippet(relativePath: string, line: number): Promise<string> {
    let cached = this.lines.get(relativePath);
    if (cached === undefined) {
      try {
        const text = await readSourceText(path.join(this.root, relativePath));
        cached = text.split(/\r?\n/);
      } catch {
        cached = undefined;
      }
      this.lines.set(relativePath, cached);
    }
    if (cached === undefined) return '';
    const raw = cached[line - 1] ?? '';
    const trimmed = raw.trim();
    return trimmed.length > 200 ? `${trimmed.slice(0, 200)}…` : trimmed;
  }
}

export class SymbolIndex {
  private readonly filesByPath = new Map<string, FileRecord>();
  private readonly symbolsByFile = new Map<number, SymbolRecord[]>();
  private readonly refsByPath = new Map<string, ReferenceRecord[]>();
  private readonly importsByFile = new Map<number, ImportEdge[]>();
  private nextFileId = 1;
  private nextSymbolId = 1;
  private nextRefId = 1;
  private dirty = false;

  private readonly source: SourceCache;
  private state: IndexState = 'none';
  private lastReport: RefreshReport | undefined;
  private readonly notes: string[] = [];

  private constructor(
    private readonly options: SymbolIndexOptions,
    private readonly persistence: IndexPersistence,
    fallbackReason?: string,
  ) {
    this.source = new SourceCache(options.root);
    if (fallbackReason !== undefined) this.notes.push(fallbackReason);
  }

  /** Open the persisted index for a workspace (does not walk yet). */
  static async open(options: SymbolIndexOptions): Promise<SymbolIndex> {
    const { persistence, fallbackReason } = await openPersistence(options.paths);
    const index = new SymbolIndex(options, persistence, fallbackReason);
    const snapshot = await persistence.load();
    if (snapshot !== undefined) index.load(snapshot);
    else index.state = 'none';
    return index;
  }

  get persistenceKind(): 'sqlite' | 'json' {
    return this.persistence.kind;
  }

  get location(): string {
    return this.persistence.location;
  }

  get indexState(): IndexState {
    return this.state;
  }

  get report(): RefreshReport | undefined {
    return this.lastReport;
  }

  counts(): { files: number; symbols: number; refs: number; imports: number } {
    let symbols = 0;
    for (const list of this.symbolsByFile.values()) symbols += list.length;
    let refs = 0;
    for (const list of this.refsByPath.values()) refs += list.length;
    let imports = 0;
    for (const list of this.importsByFile.values()) imports += list.length;
    return { files: this.filesByPath.size, symbols, refs, imports };
  }

  private load(snapshot: IndexSnapshot): void {
    for (const file of snapshot.files) {
      if (file.path === '') continue;
      this.filesByPath.set(file.path, file);
      this.nextFileId = Math.max(this.nextFileId, file.id + 1);
    }
    for (const symbol of snapshot.symbols) {
      const list = this.symbolsByFile.get(symbol.fileId) ?? [];
      list.push(symbol);
      this.symbolsByFile.set(symbol.fileId, list);
      this.nextSymbolId = Math.max(this.nextSymbolId, symbol.id + 1);
    }
    for (const ref of snapshot.refs) {
      const list = this.refsByPath.get(ref.path) ?? [];
      list.push(ref);
      this.refsByPath.set(ref.path, list);
      this.nextRefId = Math.max(this.nextRefId, ref.id + 1);
    }
    for (const edge of snapshot.imports) {
      const file = this.filesByPath.get(edge.fromPath);
      if (file === undefined) continue;
      const list = this.importsByFile.get(file.id) ?? [];
      list.push(edge);
      this.importsByFile.set(file.id, list);
    }
    this.state = this.filesByPath.size > 0 ? 'ready' : 'none';
  }

  private replaceFile(record: FileRecord, parsed: {
    symbols: readonly { name: string; kind: SymbolKind; startLine: number; endLine: number; signature?: string; doc?: string; visibility?: string; parentName?: string }[];
    refs: readonly { name: string; line: number; column: number; kind: ReferenceRecord['kind']; containerName?: string }[];
    imports: readonly { raw: string; toPath?: string; line: number }[];
  }): void {
    this.filesByPath.set(record.path, record);

    const symbols: SymbolRecord[] = parsed.symbols.map((symbol) => {
      const entry: SymbolRecord = {
        id: this.nextSymbolId++,
        fileId: record.id,
        path: record.path,
        name: symbol.name,
        kind: symbol.kind,
        startLine: symbol.startLine,
        endLine: symbol.endLine,
      };
      if (symbol.signature !== undefined) entry.signature = symbol.signature;
      if (symbol.doc !== undefined) entry.doc = symbol.doc;
      if (symbol.visibility !== undefined) entry.visibility = symbol.visibility as SymbolRecord['visibility'];
      if (symbol.parentName !== undefined) entry.parentName = symbol.parentName;
      return entry;
    });
    this.symbolsByFile.set(record.id, symbols);

    const refs: ReferenceRecord[] = parsed.refs.map((ref) => {
      const entry: ReferenceRecord = {
        id: this.nextRefId++,
        symbolName: ref.name,
        path: record.path,
        line: ref.line,
        column: ref.column,
        kind: ref.kind,
      };
      if (ref.containerName !== undefined) entry.containerName = ref.containerName;
      return entry;
    });
    this.refsByPath.set(record.path, refs);

    const imports: ImportEdge[] = parsed.imports.map((edge) => {
      const entry: ImportEdge = { fromPath: record.path, raw: edge.raw, line: edge.line };
      if (edge.toPath !== undefined) entry.toPath = edge.toPath;
      return entry;
    });
    this.importsByFile.set(record.id, imports);

    this.dirty = true;
  }

  private removeFile(path_: string): void {
    const record = this.filesByPath.get(path_);
    if (record === undefined) return;
    this.filesByPath.delete(path_);
    this.symbolsByFile.delete(record.id);
    this.refsByPath.delete(path_);
    this.importsByFile.delete(record.id);
    this.dirty = true;
  }

  private isIndexableLanguage(file: WalkedFile, config: DevPilotConfig): boolean {
    return supportsLanguage(file.language) && config.index.languages.includes(file.language);
  }

  /** Bring the index up to date. Cheap when nothing changed (one stat per file); `force`
   * re-parses everything.
   */
  async refresh(options: RefreshOptions = {}): Promise<RefreshReport> {
    const started = Date.now();
    const { config, root } = this.options;
    const notes: string[] = [];
    notes.push(...this.notes);

    if (!config.index.enabled) {
      notes.push('index.enabled is false in .devpilot/config.yml — no symbols are indexed');
      this.state = 'none';
      this.lastReport = emptyReport('none', this.persistence.kind, notes, Date.now() - started, false);
      return this.lastReport;
    }

    const walk = await walkWorkspace({
      root,
      exclude: config.workspace.exclude,
      ...(options.exclude === undefined ? {} : { extraExclude: options.exclude }),
      ...(options.include === undefined ? {} : { include: options.include }),
      maxFiles: options.maxFiles ?? config.workspace.max_files,
      maxFileSizeBytes: config.workspace.max_file_size_bytes,
    });

    const seen = new Set<string>();
    let parsedCount = 0;
    let reused = 0;
    let parseErrors = 0;
    let refsTruncated = 0;
    const unsupported = new Map<string, number>();

    for (const file of walk.files) {
      if (!supportsLanguage(file.language)) {
        unsupported.set(file.language, (unsupported.get(file.language) ?? 0) + 1);
        continue;
      }
      if (!this.isIndexableLanguage(file, config)) continue;
      seen.add(file.path);

      const stored = this.filesByPath.get(file.path);
      if (
        options.force !== true &&
        stored !== undefined &&
        stored.mtimeMs === file.mtimeMs &&
        stored.sizeBytes === file.size
      ) {
        reused += 1;
        continue;
      }

      let text: string;
      try {
        text = await readSourceText(file.absolute);
      } catch (error) {
        notes.push(`unreadable: ${file.path} (${error instanceof Error ? error.message : String(error)})`);
        continue;
      }

      const result = extractFile(file.language, text, { path: file.path });
      if (result === undefined) continue;

      const record: FileRecord = {
        id: stored?.id ?? this.nextFileId++,
        path: file.path,
        language: file.language,
        sizeBytes: file.size,
        mtimeMs: file.mtimeMs,
        hash: hashContent(text),
        parsedAt: new Date().toISOString(),
      };
      if (result.parseError !== undefined) {
        record.parseError = result.parseError;
        parseErrors += 1;
      }
      if (result.refsTruncated) refsTruncated += 1;
      this.replaceFile(record, result);
      parsedCount += 1;
    }

    let removed = 0;
    if (options.include === undefined) {
      for (const storedPath of [...this.filesByPath.keys()]) {
        if (!seen.has(storedPath)) {
          this.removeFile(storedPath);
          removed += 1;
        }
      }
    } else {
      notes.push('include filter active: files outside it keep their previous index rows');
    }

    this.resolveImports(seen);

    if (walk.truncated) {
      notes.push(
        `file cap reached (${walk.files.length} files): the index covers only part of the tree — raise workspace.max_files or narrow with include/exclude`,
      );
    }
    if (walk.skipped.oversized > 0) {
      notes.push(`${walk.skipped.oversized} oversized file(s) skipped (workspace.max_file_size_bytes)`);
    }
    if (parseErrors > 0) notes.push(`${parseErrors} file(s) failed to parse (see parseError on the file record)`);
    if (refsTruncated > 0) {
      notes.push(
        `${refsTruncated} file(s) hit the per-file reference cap: references there are incomplete`,
      );
    }
    for (const [language, count] of unsupported) {
      notes.push(`${count} ${language} file(s) skipped: no parser in this build`);
    }

    this.nextFileId = Math.max(this.nextFileId, ...this.idList());
    this.state = 'ready';
    this.lastReport = {      ...emptyReport('ready', this.persistence.kind, notes, Date.now() - started, walk.truncated),
      files: this.filesByPath.size,
      parsed: parsedCount,
      reused,
      removed,
      symbols: this.counts().symbols,
      refs: this.counts().refs,
      imports: this.counts().imports,
      parseErrors,
      refsTruncated,
    };
    if (this.dirty) await this.save();
    return this.lastReport;
  }

  private idList(): number[] {
    return [...this.filesByPath.values()].map((file) => file.id);
  }

  /** Resolve relative import specifiers against the real file list (extensions, index). */
  private resolveImports(seen: Set<string>): void {
    for (const record of this.filesByPath.values()) {
      const edges = this.importsByFile.get(record.id);
      if (edges === undefined) continue;
      for (const edge of edges) {
        if (edge.toPath === undefined) continue;
        const target = resolveImportPath(record.path, edge.toPath, seen);
        if (target !== undefined && target !== edge.toPath) {
          edge.toPath = target;
          this.dirty = true;
        }
      }
    }
  }

  private buildSnapshot(): IndexSnapshot {
    const symbols: SymbolRecord[] = [];
    for (const list of this.symbolsByFile.values()) symbols.push(...list);
    const refs: ReferenceRecord[] = [];
    for (const list of this.refsByPath.values()) refs.push(...list);
    const imports: ImportEdge[] = [];
    for (const list of this.importsByFile.values()) imports.push(...list);
    const meta: IndexMeta = {
      schemaVersion: INDEX_SCHEMA_VERSION,
      extractorVersion: EXTRACTOR_VERSION,
      rootHash: hashContent(
        `${this.options.root}|${this.options.config.index.languages.join(',')}|${this.filesByPath.size}`,
      ),
      indexedAt: new Date().toISOString(),
      fileCount: this.filesByPath.size,
    };
    return { meta, files: [...this.filesByPath.values()], symbols, refs, imports };
  }

  async save(): Promise<void> {
    if (!this.dirty) return;
    await this.persistence.save(this.buildSnapshot());
    this.dirty = false;
  }

  close(): void {
    this.persistence.close();
  }

  /* ------------------------------------------------------------- queries */

  findSymbols(query: string, options: SymbolQuery = {}): SearchResult<SymbolHit> {
    const caseSensitive = options.caseSensitive ?? false;
    const limit = clampLimit(options.limit, DEFAULT_SYMBOL_LIMIT, MAX_SYMBOL_LIMIT);
    const needle = caseSensitive ? query : query.toLowerCase();
    const dot = needle.lastIndexOf('.');
    const qualifier = dot > 0 ? needle.slice(0, dot) : undefined;
    const member = dot > 0 ? needle.slice(dot + 1) : needle;
    const matches: ScoredSymbol[] = [];

    for (const list of this.symbolsByFile.values()) {
      for (const record of list) {
        if (options.kinds !== undefined && !options.kinds.includes(record.kind)) continue;
        if (options.pathFilter !== undefined && !record.path.startsWith(options.pathFilter)) continue;
        const name = caseSensitive ? record.name : record.name.toLowerCase();
        const parent = record.parentName === undefined ? undefined : caseSensitive ? record.parentName : record.parentName.toLowerCase();
        let score = -1;
        if (qualifier !== undefined) {
          if (name === member && parent !== undefined && (parent === qualifier || parent.endsWith(`.${qualifier}`))) score = 0;
          else if (name === needle) score = 1;
        } else if (name === needle) score = 0;
        else if (name.startsWith(needle)) score = 1;
        else if (name.includes(needle)) score = 2;
        if (score >= 0) matches.push({ record, score });
      }
    }

    matches.sort((a, b) => {
      if (a.score !== b.score) return a.score - b.score;
      if (a.record.path !== b.record.path) return a.record.path < b.record.path ? -1 : 1;
      return a.record.startLine - b.record.startLine;
    });

    const page = matches.slice(0, limit).map((match) => toSymbolHit(match.record));
    return {
      engine: 'text',
      confidence: confidenceFor(matches.length, page.length, matches[0]?.score),
      truncated: matches.length > page.length,
      total: matches.length,
      results: page,
    };
  }

  async findReferences(name: string, options: ReferenceQuery = {}): Promise<ReferenceAnswer> {
    const caseSensitive = options.caseSensitive ?? false;
    const limit = clampLimit(options.limit, DEFAULT_REFERENCE_LIMIT, MAX_REFERENCE_LIMIT);
    const needle = caseSensitive ? name : name.toLowerCase();
    const dot = needle.lastIndexOf('.');
    const qualifier = dot > 0 ? needle.slice(0, dot) : undefined;
    const member = dot > 0 ? needle.slice(dot + 1) : needle;

    const definitions: SymbolRecord[] = [];
    for (const list of this.symbolsByFile.values()) {
      for (const record of list) {
        const symbolName = caseSensitive ? record.name : record.name.toLowerCase();
        if (symbolName !== member) continue;
        if (qualifier !== undefined) {
          const parent = record.parentName === undefined ? undefined : caseSensitive ? record.parentName : record.parentName.toLowerCase();
          if (parent === undefined || !(parent === qualifier || parent.endsWith(`.${qualifier}`))) continue;
        }
        if (options.pathFilter !== undefined && !record.path.startsWith(options.pathFilter)) continue;
        definitions.push(record);
      }
    }
    definitions.sort((a, b) => (a.path === b.path ? a.startLine - b.startLine : a.path < b.path ? -1 : 1));

    const matches: ReferenceRecord[] = [];
    for (const list of this.refsByPath.values()) {
      for (const record of list) {
        if (!options.includeText && record.kind === 'text') continue;
        const symbolName = caseSensitive ? record.symbolName : record.symbolName.toLowerCase();
        if (symbolName !== member) continue;
        if (options.pathFilter !== undefined && !record.path.startsWith(options.pathFilter)) continue;
        matches.push(record);
      }
    }
    matches.sort((a, b) => (a.path === b.path ? a.line - b.line || a.column - b.column : a.path < b.path ? -1 : 1));

    const page = matches.slice(0, limit);
    const results: ReferenceHit[] = [];
    for (const record of page) {
      const hit: ReferenceHit = {
        path: record.path,
        line: record.line,
        column: record.column,
        kind: record.kind,
        snippet: await this.source.snippet(record.path, record.line),
      };
      if (record.containerName !== undefined) hit.containerName = record.containerName;
      results.push(hit);
    }

    const groupedCounts = new Map<string, { count: number; lines: number[] }>();
    for (const record of matches) {
      const bucket = groupedCounts.get(record.path) ?? { count: 0, lines: [] };
      bucket.count += 1;
      if (bucket.lines.length < 20) bucket.lines.push(record.line);
      groupedCounts.set(record.path, bucket);
    }
    const grouped: ReferenceGroup[] = [...groupedCounts.entries()]
      .map(([groupPath, bucket]) => ({ path: groupPath, count: bucket.count, lines: bucket.lines }))
      .sort((a, b) => (b.count === a.count ? (a.path < b.path ? -1 : 1) : b.count - a.count));

    const answer: ReferenceAnswer = {
      result: {
        engine: 'text',
        confidence: referenceConfidence(definitions.length, matches.length),
        truncated: matches.length > results.length,
        total: matches.length,
        results,
      },
      definitions: definitions.map((record) => toSymbolHit(record)),
      grouped,
    };
    const first = definitions[0];
    if (first !== undefined) answer.definition = toSymbolHit(first);
    return answer;
  }

  /** Symbols declared in one file (used by the project map and by impact analysis later). */
  symbolsInFile(relativePath: string): SymbolRecord[] {
    const record = this.filesByPath.get(relativePath);
    if (record === undefined) return [];
    return this.symbolsByFile.get(record.id) ?? [];
  }

  /** Workspace-relative path of every indexed file (impact analysis, directory targets). */
  filePaths(): string[] {
    return [...this.filesByPath.keys()];
  }

  hasFile(relativePath: string): boolean {
    return this.filesByPath.has(relativePath);
  }

  /** Resolved import edges, for the dependency view. */
  importEdges(): ImportEdge[] {
    const edges: ImportEdge[] = [];
    for (const list of this.importsByFile.values()) edges.push(...list);
    return edges;
  }
}

function emptyReport(
  indexState: IndexState,
  store: 'sqlite' | 'json',
  notes: string[],
  durationMs: number,
  truncatedWalk: boolean,
): RefreshReport {
  return {
    indexState,
    files: 0,
    parsed: 0,
    reused: 0,
    removed: 0,
    symbols: 0,
    refs: 0,
    imports: 0,
    parseErrors: 0,
    refsTruncated: 0,
    durationMs,
    truncatedWalk,
    store,
    notes,
  };
}

function clampLimit(value: number | undefined, fallback: number, max: number): number {
  if (value === undefined || !Number.isFinite(value) || value <= 0) return fallback;
  return Math.min(Math.floor(value), max);
}

function toSymbolHit(record: SymbolRecord): SymbolHit {
  const hit: SymbolHit = {
    name: record.name,
    kind: record.kind,
    path: record.path,
    startLine: record.startLine,
    endLine: record.endLine,
  };
  if (record.signature !== undefined) hit.signature = record.signature;
  if (record.doc !== undefined) hit.doc = record.doc;
  return hit;
}

function confidenceFor(total: number, shown: number, bestScore: number | undefined): SearchConfidence {
  if (total === 0) return 'low';
  if (bestScore === 0 && total === shown) return 'high';
  if (bestScore !== undefined && bestScore <= 1) return 'medium';
  return total > shown ? 'medium' : 'low';
}

/**
 * Reference confidence: a known definition plus call sites is as good as a lexical index
 * gets; without a definition the hits are just textual usage and we say so.
 */
function referenceConfidence(definitions: number, references: number): SearchConfidence {
  if (definitions > 0 && references > 0) return 'high';
  if (definitions > 0 || references > 0) return 'medium';
  return 'low';
}

/** `toPath` is workspace-relative for absolute imports, or relative to `fromPath`. */
export function resolveImportPath(
  fromPath: string,
  toPath: string,
  known: ReadonlySet<string>,
): string | undefined {
  let base = toPath;
  if (base.startsWith('.')) {
    const dir = path.posix.dirname(fromPath);
    base = path.posix.normalize(path.posix.join(dir === '.' ? '' : dir, base));
  }
  const candidates = [
    base,
    ...SOURCE_EXTENSIONS.map((ext) => `${base}${ext}`),
    ...SOURCE_EXTENSIONS.map((ext) => `${base}/index${ext}`),
    `${base}.py`,
  ];
  for (const candidate of candidates) {
    if (known.has(candidate)) return candidate;
  }
  return undefined;
}
