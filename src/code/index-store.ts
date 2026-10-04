import { promises as fs } from 'node:fs';
import path from 'node:path';

import { ensureDir } from '../storage/paths.js';
import { readJson, writeJsonAtomic } from '../storage/json-store.js';
import type { WorkspacePaths } from '../types/workspace.js';
import type {
  FileRecord,
  ImportEdge,
  IndexMeta,
  ReferenceRecord,
  SymbolRecord,
} from '../types/code.js';

/**
 * Index persistence (docs/DATA-MODEL.md §8). SQLite (`node:sqlite`, Node >= 22.5) is the
 * primary store so `.devpilot/devpilot.db` is inspectable with any SQLite client; when the
 * runtime lacks it the same snapshot is written as JSON under `.devpilot/cache/index.json`,
 * so the index never becomes the reason a tool fails.
 *
 * Save granularity is a whole snapshot inside one transaction: simple and crash-safe. The
 * *parsing* work is per-file incremental (see symbol-index.ts).
 */

export const INDEX_SCHEMA_VERSION = 1;

export interface IndexSnapshot {
  meta: IndexMeta;
  files: FileRecord[];
  symbols: SymbolRecord[];
  refs: ReferenceRecord[];
  imports: ImportEdge[];
}

export interface IndexPersistence {
  readonly kind: 'sqlite' | 'json';
  /** Absolute path of the store, for reporting (`artifacts` in the tool envelope). */
  readonly location: string;
  /** undefined when nothing (valid) is stored yet. */
  load(): Promise<IndexSnapshot | undefined>;
  save(snapshot: IndexSnapshot): Promise<void>;
  close(): void;
}

/* ------------------------------------------------------------------ SQLite */

interface SqliteStatementLike {
  run(...params: unknown[]): unknown;
  all(...params: unknown[]): unknown[];
}

interface SqliteDatabaseLike {
  exec(sql: string): void;
  prepare(sql: string): SqliteStatementLike;
  close(): void;
}

interface SqliteModuleLike {
  DatabaseSync: new (file: string) => SqliteDatabaseLike;
}

const DDL = `
CREATE TABLE IF NOT EXISTS meta        (key TEXT PRIMARY KEY, value TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS files       (id INTEGER PRIMARY KEY, path TEXT UNIQUE NOT NULL, language TEXT NOT NULL,
                                       size_bytes INTEGER NOT NULL, mtime_ms INTEGER NOT NULL,
                                       hash TEXT NOT NULL, parsed_at TEXT NOT NULL, parse_error TEXT);
CREATE TABLE IF NOT EXISTS symbols     (id INTEGER PRIMARY KEY, file_id INTEGER NOT NULL, name TEXT NOT NULL,
                                       kind TEXT NOT NULL, start_line INTEGER NOT NULL, end_line INTEGER NOT NULL,
                                       signature TEXT, doc TEXT, visibility TEXT, parent_name TEXT);
CREATE TABLE IF NOT EXISTS refs        (id INTEGER PRIMARY KEY, symbol_name TEXT NOT NULL, file_id INTEGER NOT NULL,
                                       line INTEGER NOT NULL, col INTEGER NOT NULL, kind TEXT NOT NULL,
                                       container_name TEXT);
CREATE TABLE IF NOT EXISTS imports     (id INTEGER PRIMARY KEY, file_id INTEGER NOT NULL, raw TEXT NOT NULL,
                                       to_path TEXT, line INTEGER NOT NULL);
CREATE INDEX IF NOT EXISTS idx_symbols_name ON symbols(name);
CREATE INDEX IF NOT EXISTS idx_symbols_file ON symbols(file_id);
CREATE INDEX IF NOT EXISTS idx_refs_name    ON refs(symbol_name);
CREATE INDEX IF NOT EXISTS idx_refs_file    ON refs(file_id);
CREATE INDEX IF NOT EXISTS idx_imports_to   ON imports(to_path);
`;

function asNumber(value: unknown, fallback = 0): number {
  if (typeof value === 'number') return value;
  if (typeof value === 'bigint') return Number(value);
  if (typeof value === 'string') {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : fallback;
  }
  return fallback;
}

function asString(value: unknown, fallback = ''): string {
  return typeof value === 'string' ? value : fallback;
}

function asOptionalString(value: unknown): string | undefined {
  return typeof value === 'string' && value !== '' ? value : undefined;
}

class SqlitePersistence implements IndexPersistence {
  readonly kind = 'sqlite' as const;

  constructor(
    private readonly db: SqliteDatabaseLike,
    readonly location: string,
  ) {
    this.db.exec('PRAGMA journal_mode=WAL;');
    this.db.exec(DDL);
  }

  async load(): Promise<IndexSnapshot | undefined> {
    try {
      const metaRows = this.db.prepare('SELECT key, value FROM meta').all() as Record<string, unknown>[];
      const metaRaw = metaRows.find((row) => asString(row['key']) === 'snapshot');
      if (metaRaw === undefined) return undefined;
      const meta = JSON.parse(asString(metaRaw['value'])) as IndexMeta;
      if (meta.schemaVersion !== INDEX_SCHEMA_VERSION) return undefined;

      const files: FileRecord[] = (
        this.db
          .prepare('SELECT id, path, language, size_bytes, mtime_ms, hash, parsed_at, parse_error FROM files')
          .all() as Record<string, unknown>[]
      ).map((row) => {
        const record: FileRecord = {
          id: asNumber(row['id']),
          path: asString(row['path']),
          language: asString(row['language']),
          sizeBytes: asNumber(row['size_bytes']),
          mtimeMs: asNumber(row['mtime_ms']),
          hash: asString(row['hash']),
          parsedAt: asString(row['parsed_at']),
        };
        const parseError = asOptionalString(row['parse_error']);
        if (parseError !== undefined) record.parseError = parseError;
        return record;
      });

      const byFileId = new Map<number, string>();
      for (const file of files) byFileId.set(file.id, file.path);

      const symbols: SymbolRecord[] = (
        this.db
          .prepare(
            'SELECT id, file_id, name, kind, start_line, end_line, signature, doc, visibility, parent_name FROM symbols',
          )
          .all() as Record<string, unknown>[]
      ).map((row) => {
        const record: SymbolRecord = {
          id: asNumber(row['id']),
          fileId: asNumber(row['file_id']),
          path: byFileId.get(asNumber(row['file_id'])) ?? '',
          name: asString(row['name']),
          kind: asString(row['kind']) as SymbolRecord['kind'],
          startLine: asNumber(row['start_line']),
          endLine: asNumber(row['end_line']),
        };
        const signature = asOptionalString(row['signature']);
        if (signature !== undefined) record.signature = signature;
        const doc = asOptionalString(row['doc']);
        if (doc !== undefined) record.doc = doc;
        const visibility = asOptionalString(row['visibility']);
        if (visibility !== undefined) record.visibility = visibility as SymbolRecord['visibility'];
        const parentName = asOptionalString(row['parent_name']);
        if (parentName !== undefined) record.parentName = parentName;
        return record;
      });

      const refs: ReferenceRecord[] = (
        this.db
          .prepare('SELECT id, symbol_name, file_id, line, col, kind, container_name FROM refs')
          .all() as Record<string, unknown>[]
      ).map((row) => {
        const record: ReferenceRecord = {
          id: asNumber(row['id']),
          symbolName: asString(row['symbol_name']),
          path: byFileId.get(asNumber(row['file_id'])) ?? '',
          line: asNumber(row['line']),
          column: asNumber(row['col']),
          kind: asString(row['kind']) as ReferenceRecord['kind'],
        };
        const containerName = asOptionalString(row['container_name']);
        if (containerName !== undefined) record.containerName = containerName;
        return record;
      });

      const imports: ImportEdge[] = (
        this.db
          .prepare('SELECT file_id, raw, to_path, line FROM imports')
          .all() as Record<string, unknown>[]
      ).map((row) => {
        const edge: ImportEdge = {
          fromPath: byFileId.get(asNumber(row['file_id'])) ?? '',
          raw: asString(row['raw']),
          line: asNumber(row['line']),
        };
        const toPath = asOptionalString(row['to_path']);
        if (toPath !== undefined) edge.toPath = toPath;
        return edge;
      });

      return { meta, files, symbols, refs, imports };
    } catch {
      return undefined;
    }
  }

  async save(snapshot: IndexSnapshot): Promise<void> {
    const db = this.db;
    // ReferenceRecord/ImportEdge carry a path (docs/DATA-MODEL.md §4); the schema stores
    // file ids, so the mapping is resolved here, at the storage boundary only.
    const fileIdByPath = new Map<string, number>();
    for (const file of snapshot.files) fileIdByPath.set(file.path, file.id);

    db.exec('BEGIN');
    try {
      db.exec('DELETE FROM refs');
      db.exec('DELETE FROM symbols');
      db.exec('DELETE FROM imports');
      db.exec('DELETE FROM files');

      const insertFile = db.prepare(
        'INSERT INTO files (id, path, language, size_bytes, mtime_ms, hash, parsed_at, parse_error) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
      );
      for (const file of snapshot.files) {
        insertFile.run(
          file.id,
          file.path,
          file.language,
          file.sizeBytes,
          file.mtimeMs,
          file.hash,
          file.parsedAt,
          file.parseError ?? null,
        );
      }

      const insertSymbol = db.prepare(
        'INSERT INTO symbols (id, file_id, name, kind, start_line, end_line, signature, doc, visibility, parent_name) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
      );
      for (const symbol of snapshot.symbols) {
        insertSymbol.run(
          symbol.id,
          symbol.fileId,
          symbol.name,
          symbol.kind,
          symbol.startLine,
          symbol.endLine,
          symbol.signature ?? null,
          symbol.doc ?? null,
          symbol.visibility ?? null,
          symbol.parentName ?? null,
        );
      }

      const insertRef = db.prepare(
        'INSERT INTO refs (id, symbol_name, file_id, line, col, kind, container_name) VALUES (?, ?, ?, ?, ?, ?, ?)',
      );
      for (const ref of snapshot.refs) {
        insertRef.run(
          ref.id,
          ref.symbolName,
          fileIdByPath.get(ref.path) ?? 0,
          ref.line,
          ref.column,
          ref.kind,
          ref.containerName ?? null,
        );
      }

      const insertImport = db.prepare(
        'INSERT INTO imports (id, file_id, raw, to_path, line) VALUES (?, ?, ?, ?, ?)',
      );
      snapshot.imports.forEach((edge, index) => {
        insertImport.run(index + 1, fileIdByPath.get(edge.fromPath) ?? 0, edge.raw, edge.toPath ?? null, edge.line);
      });

      const setMeta = db.prepare(
        'INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value',
      );
      setMeta.run('schema_version', String(INDEX_SCHEMA_VERSION));
      setMeta.run('snapshot', JSON.stringify(snapshot.meta));

      db.exec('COMMIT');
    } catch (error) {
      try {
        db.exec('ROLLBACK');
      } catch {
        /* the transaction is already gone */
      }
      throw error;
    }
  }

  close(): void {
    try {
      this.db.close();
    } catch {
      /* already closed */
    }
  }
}

/* -------------------------------------------------------------------- JSON */

export class JsonPersistence implements IndexPersistence {
  readonly kind = 'json' as const;

  constructor(readonly location: string) {}

  async load(): Promise<IndexSnapshot | undefined> {
    const result = await readJson<IndexSnapshot | undefined>(this.location, undefined);
    const snapshot = result.value;
    if (snapshot === undefined || snapshot === null) return undefined;
    if (snapshot.meta?.schemaVersion !== INDEX_SCHEMA_VERSION) return undefined;
    return snapshot;
  }

  async save(snapshot: IndexSnapshot): Promise<void> {
    await writeJsonAtomic(this.location, snapshot);
  }

  close(): void {
    /* nothing to release */
  }
}

/* ------------------------------------------------------------------- open */

export interface OpenPersistenceResult {
  persistence: IndexPersistence;
  /** Populated when SQLite was unavailable, so callers can report the fallback. */
  fallbackReason?: string;
}

/**
 * Prefer SQLite; fall back to JSON. Never throws: an index store problem must not take the
 * server down (docs/ARCHITECTURE.md §4.8).
 */
export async function openPersistence(paths: WorkspacePaths): Promise<OpenPersistenceResult> {
  const jsonFile = path.join(paths.cacheDir, 'index.json');
  try {
    await ensureDir(path.dirname(paths.databaseFile));
    const module = (await import('node:sqlite')) as unknown as SqliteModuleLike;
    if (typeof module.DatabaseSync !== 'function') {
      return { persistence: new JsonPersistence(jsonFile), fallbackReason: 'node:sqlite is not available' };
    }
    const db = new module.DatabaseSync(paths.databaseFile);
    return { persistence: new SqlitePersistence(db, paths.databaseFile) };
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    return { persistence: new JsonPersistence(jsonFile), fallbackReason: `sqlite unavailable: ${reason}` };
  }
}

/** File hash used for change detection (mtime+size is the fast path, hash the tie-break). */
export function hashContent(text: string): string {
  // Cheap FNV-1a: the hash only needs to distinguish revisions, not resist collisions.
  let hash = 0x811c9dc5;
  for (let i = 0; i < text.length; i += 1) {
    hash ^= text.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash.toString(16).padStart(8, '0');
}

/** Read a file as UTF-8, tolerating a UTF-8 BOM. */
export async function readSourceText(file: string): Promise<string> {
  const text = await fs.readFile(file, 'utf8');
  return text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
}
