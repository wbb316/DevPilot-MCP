# DevPilot MCP — Core Data Model

All types below are the single source of truth; they live in `src/types/` and are
mirrored by the SQLite schema in §4. Field names are stable API surface for agents.

## 1. Result envelope

```ts
type ErrorCode =
  | 'INVALID_ARGUMENT' | 'PERMISSION_DENIED'
  | 'WORKSPACE_NOT_OPEN' | 'WORKSPACE_NOT_FOUND'
  | 'FILE_NOT_FOUND'   | 'PATH_OUTSIDE_WORKSPACE' | 'SECRET_PROTECTED'
  | 'CONFIG_INVALID'   | 'LIMIT_EXCEEDED' | 'NOT_IMPLEMENTED'
  | 'UNSUPPORTED_PROJECT' | 'INDEX_FAILED'
  | 'COMMAND_NOT_ALLOWED' | 'COMMAND_TIMEOUT' | 'COMMAND_FAILED'
  | 'BUILD_FAILED' | 'TEST_FAILED'
  | 'GIT_NOT_AVAILABLE' | 'GIT_DIRTY' | 'GIT_FAILED'
  | 'INTERNAL_ERROR';

interface OkEnvelope<T>  { success: true;  summary: string; data: T;
                           artifacts?: Record<string, string>; warnings?: string[] }
interface ErrEnvelope    { success: false; error: { code: ErrorCode; message: string;
                           details?: unknown; hint?: string; retryable?: boolean } }
type ToolEnvelope<T> = OkEnvelope<T> | ErrEnvelope;
```

`summary` is one sentence an agent can print to a human. `artifacts` maps a logical
name (`log`, `diff_patch`, `report`) to a path **relative to the workspace root**.

## 2. Security types

```ts
type PermissionLevel = 'READ_ONLY' | 'SAFE_WRITE' | 'EXECUTE' | 'FULL';

interface Limits {                       // security/limits.ts defaults
  maxCommandSeconds: number;             // 120
  maxOutputBytes: number;                // 262144 stdout, 262144 stderr
  maxFilesChanged: number;               // 20
  maxLinesChanged: number;               // 3000
  maxFilesIndexed: number;               // 20000
  maxFileSizeBytes: number;              // 2_097_152
  walkMaxDepth: number;                  // 32
}

interface CommandPolicyDecision {
  allowed: boolean;
  reason?: string;                       // e.g. 'dangerous command: diskpart'
  rule?: string;                         // 'deny-list' | 'allow-list' | 'no-shell' | 'not-in-allow-list'
}
```

## 3. Workspace types

```ts
interface GitState {
  available: boolean;      // git binary found
  isRepo: boolean;
  branch?: string;
  head?: string;           // short sha
  dirty?: boolean;         // tracked modifications present
  changedFiles?: number;
  untrackedFiles?: number;
  error?: string;
}

interface WorkspacePaths {                 // resolved once, never re-derived ad hoc
  root: string;                            // realpath'd
  devpilotDir: string;                     // <root>/.devpilot
  configFile: string;                      // <root>/.devpilot/config.yml
  cacheDir: string;
  logsDir: string;
  checkpointsDir: string;
  databaseFile: string;                    // <root>/.devpilot/devpilot.db
}

type IndexState = 'none' | 'stale' | 'ready' | 'failed';

interface ProjectProfile {
  name: string;
  root: string;
  languages: string[];                     // ['Python'] | ['Java','Kotlin'] | ['TypeScript','JavaScript']
  projectType: string;                     // 'PyTorch' | 'SpringBoot' | 'Node' | 'Unknown'
  framework?: string;
  buildSystem?: string;                    // 'maven' | 'gradle' | 'npm' | 'pnpm' | 'pip' | 'poetry' | 'none'
  testFramework?: string;                  // 'pytest' | 'jest' | 'vitest' | 'junit' | 'none'
  packageManager?: string;
  entrypoints: string[];                   // relative paths
  markers: string[];                       // detected marker files
  sourceDirs: string[];
  testDirs: string[];
  configDirs: string[];
  candidates: { build?: string; test?: string; run?: string };   // rule-inferred commands
  detectedAt: string;                      // ISO
}

interface WorkspaceState {
  id: string;                              // stable hash of realpath
  name: string;                            // folder name
  root: string;                            // realpath, always absolute, native separators
  paths: WorkspacePaths;
  permission: PermissionLevel;             // effective for the session
  profile: ProjectProfile;                 // Phase 1: marker-level; Phase 2: full scan
  git: GitState;
  indexState: IndexState;
  openedAt: string;
  lastUsedAt: string;
}

interface WorkspaceRegistryEntry { id: string; name: string; root: string; lastOpenedAt: string }
interface WorkspaceRegistry { version: 1; workspaces: WorkspaceRegistryEntry[] }
```

## 4. Code intelligence types (Phase 3+, schema fixed now)

```ts
interface FileRecord {
  id: number; path: string; language: string; sizeBytes: number;
  mtimeMs: number; hash: string; parsedAt: string; parseError?: string;
}

interface SymbolRecord {
  id: number; fileId: number; path: string; name: string;
  kind: 'class' | 'interface' | 'enum' | 'function' | 'method' | 'constructor'
      | 'field' | 'variable' | 'module' | 'decorator';
  startLine: number; endLine: number; signature?: string; doc?: string;
  visibility?: 'public' | 'protected' | 'private' | 'package';
  parentName?: string;
}

interface ReferenceRecord {
  id: number; symbolName: string; path: string; line: number; column: number;
  kind: 'call' | 'type' | 'import' | 'extends' | 'implements' | 'field' | 'text';
  containerName?: string;
}

interface ImportEdge { fromPath: string; toPath?: string; raw: string; line: number }

interface IndexMeta { schemaVersion: number; rootHash: string; indexedAt: string; fileCount: number }

interface SymbolHit { name: string; kind: SymbolRecord['kind']; path: string;
                      startLine: number; endLine: number; signature?: string; doc?: string }

interface ReferenceHit { path: string; line: number; column: number; kind: ReferenceRecord['kind'];
                         snippet: string; containerName?: string }

interface SearchResult<T> { engine: 'ast' | 'text'; confidence: 'high' | 'medium' | 'low';
                            truncated: boolean; total: number; results: T[] }
```

Two clarifications fixed with Phase 3:

- `containerName` names the enclosing scope of a reference: the enclosing **type** for the
  Java and TypeScript/JavaScript extractors, the enclosing **block** (function or class) for
  Python.
- `ReferenceRecord` and `ImportEdge` carry a `path`. `file_id` exists only in the SQLite
  schema and is resolved at the storage boundary, so the in-memory model has no id coupling.

## 5. Execution types

```ts
interface JobRecord {
  jobId: string; kind: 'build' | 'test' | 'run' | 'benchmark';
  command: string; args: string[]; cwd: string; startedAt: string; finishedAt?: string;
  exitCode?: number | null; signal?: string | null; durationMs?: number;
  timedOut: boolean; stdoutBytes: number; stderrBytes: number;
  stdoutTruncated: boolean; stderrTruncated: boolean; logFile: string;
}

interface BuildResult {
  status: 'success' | 'failed' | 'timeout';
  system: string; command: string; durationMs: number;
  errors: IssueEntry[]; warnings: IssueEntry[]; artifacts?: string[]; job: JobRecord;
}

interface IssueEntry { path?: string; line?: number; column?: number;
                       severity: 'error' | 'warning'; message: string; code?: string }

interface TestFailure { name: string; suite?: string; path?: string; line?: number;
                        message: string; stackHead?: string[]; durationMs?: number }

interface TestDuration { name: string; durationMs: number }

interface TestResult {
  status: 'passed' | 'failed' | 'error' | 'timeout' | 'no_tests';
  framework: string; command: string; durationMs: number;
  total: number; passed: number; failed: number; skipped: number; errors: number;
  failures: TestFailure[]; job: JobRecord;
  // Phase 5 additions: `parsed` is the honesty flag (false ⇒ the counts are not trustworthy
  // and the envelope points at the log); `durations` is present only when the runner printed
  // timings.
  parsed: boolean; durations?: { slowest: TestDuration[] };
}

interface RunResult { status: 'success' | 'failed' | 'timeout'; command: string;
                      durationMs: number; exitCode: number | null; signal: string | null;
                      crashed: boolean; job: JobRecord; },
```

## 6. Diagnosis / review / git types
```ts
interface DiagnosisResult {
  category: string;                      // CUDA_OUT_OF_MEMORY | NULL_POINTER | IMPORT_ERROR | ...
  confidence: 'high' | 'medium' | 'low';
  location?: { path: string; line?: number; column?: number };
  evidence: string[];                    // key lines only, never the full log
  suspectFiles: { path: string; reason: 'recently_changed' | 'in_stack' | 'import_related' }[];
  relatedJob?: { jobId: string; command: string; exitCode: number | null };
  hint?: string;
  logFile?: string;
}

interface ChangedFile { path: string; status: 'added' | 'modified' | 'deleted' | 'renamed' | 'untracked';
                        addedLines: number; deletedLines: number; binary?: boolean;
                        changedSymbols?: string[]; risk: 'HIGH' | 'MEDIUM' | 'LOW'; reasons: string[] }

interface DiffReview {
  files: ChangedFile[];
  totals: { files: number; addedLines: number; deletedLines: number };
  riskLevel: 'HIGH' | 'MEDIUM' | 'LOW';
  affectedTests: string[];
  unrelatedFiles: string[];              // changed but outside the declared intent/impact set
  highRisk: string[];
  preExistingChanges: string[];          // user edits that existed before DevPilot ran
  patchArtifact?: string;
}

type CheckpointKind = 'manual' | 'pre_write' | 'pre_command';
interface Checkpoint { id: string; kind: CheckpointKind; createdAt: string; branch: string;
                       head: string; label?: string; files: string[];
                       patchFile: string;        // audit artifact of the created diff
                       snapshotDir: string;      // content of `files` — what a restore writes back
                       baseRef: string; dirtyAtCreate: boolean;
                       snapshotSkipped?: string[] }  // too large/unreadable: patch-only fallback
```

A checkpoint's `snapshotDir` (`.devpilot/checkpoints/<id>/files/<path>`) is the restore source:
recording bytes rather than a reverse-applicable diff is what makes `rollback_checkpoint` work
after the same lines were edited again, and it is what lets an untracked file be recorded at all.

## 7. Environment types (Phase 9)

```ts
type CheckStatus = 'OK' | 'WARNING' | 'ERROR';
interface ToolchainCheck { name: string; status: CheckStatus; version?: string; path?: string;
                           expected?: string; message?: string; fix?: string }
interface EnvironmentReport { generatedAt: string; os: {...}; tools: ToolchainCheck[];
                              conflicts: ToolchainCheck[]; overall: CheckStatus }
```

## 8. SQLite schema (per workspace: `.devpilot/devpilot.db`)

```sql
PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON;

CREATE TABLE meta        (key TEXT PRIMARY KEY, value TEXT NOT NULL);
CREATE TABLE files       (id INTEGER PRIMARY KEY, path TEXT UNIQUE NOT NULL, language TEXT NOT NULL,
                          size_bytes INTEGER NOT NULL, mtime_ms INTEGER NOT NULL,
                          hash TEXT NOT NULL, parsed_at TEXT NOT NULL, parse_error TEXT);
CREATE TABLE symbols     (id INTEGER PRIMARY KEY, file_id INTEGER NOT NULL REFERENCES files(id) ON DELETE CASCADE,
                          name TEXT NOT NULL, kind TEXT NOT NULL, start_line INTEGER NOT NULL,
                          end_line INTEGER NOT NULL, signature TEXT, doc TEXT, visibility TEXT, parent_name TEXT);
CREATE TABLE refs        (id INTEGER PRIMARY KEY, symbol_name TEXT NOT NULL, file_id INTEGER NOT NULL
                          REFERENCES files(id) ON DELETE CASCADE, line INTEGER NOT NULL, col INTEGER NOT NULL,
                          kind TEXT NOT NULL, container_name TEXT);
CREATE TABLE imports     (id INTEGER PRIMARY KEY, file_id INTEGER NOT NULL REFERENCES files(id) ON DELETE CASCADE,
                          raw TEXT NOT NULL, to_path TEXT, line INTEGER NOT NULL);
CREATE TABLE jobs        (job_id TEXT PRIMARY KEY, kind TEXT NOT NULL, command TEXT NOT NULL, cwd TEXT NOT NULL,
                          started_at TEXT NOT NULL, finished_at TEXT, exit_code INTEGER, duration_ms INTEGER,
                          timed_out INTEGER NOT NULL DEFAULT 0, log_file TEXT NOT NULL);
CREATE TABLE checkpoints (id TEXT PRIMARY KEY, kind TEXT NOT NULL, created_at TEXT NOT NULL, branch TEXT NOT NULL,
                          head TEXT NOT NULL, label TEXT, patch_file TEXT NOT NULL, base_ref TEXT NOT NULL,
                          dirty_at_create INTEGER NOT NULL, files TEXT NOT NULL);

CREATE INDEX idx_symbols_name ON symbols(name);
CREATE INDEX idx_symbols_file ON symbols(file_id);
CREATE INDEX idx_refs_name    ON refs(symbol_name);
CREATE INDEX idx_refs_file    ON refs(file_id);
CREATE INDEX idx_imports_to   ON imports(to_path);
```

Phase 1 needs no DB: workspace state/registry use `storage/json-store.ts`
(atomic write: temp file + `fs.rename`). Phase 3 introduces the DB with
`storage/migrations.ts` keyed on `meta.schema_version`.

### Incremental rule

```text
stat(path) → (mtimeMs, size)
  unchanged mtime+size  → reuse cached parse
  changed / new         → re-parse file, replace its symbols/refs/imports rows
  deleted (not in walk) → delete file row (CASCADE removes children)
full scan only when: index missing, schemaVersion bumped, or explicit `scan_project { force: true }`
```

## 9. Storage locations

| Data | Location | Lifetime |
| --- | --- | --- |
| Workspace registry, DevPilot-level logs | `%DEVPILOT_HOME%` else `%LOCALAPPDATA%\DevPilot` | machine |
| Per-workspace config | `<workspace>\.devpilot\config.yml` | project |
| Index DB | `<workspace>\.devpilot\devpilot.db` | project, regenerable |
| Command logs | `<workspace>\.devpilot\logs\` | project, prunable |
| Checkpoints | `<workspace>\.devpilot\checkpoints\` | project, user-managed |
| Scan/profile cache | `<workspace>\.devpilot\cache\` | project, regenerable |

`.devpilot/` is offered to `.gitignore` at `init` time; DevPilot never edits
`.gitignore` without being asked.
