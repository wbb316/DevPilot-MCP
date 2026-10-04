# DevPilot MCP — Tool Schemas

Every tool returns the envelope from [DATA-MODEL.md](DATA-MODEL.md) §1. Arguments are
validated with zod; unknown properties are rejected. Paths are workspace-relative unless
documented as absolute; every path is re-validated by `security/path-policy`.

A `path` argument that selects a workspace accepts any of: a workspace id, an absolute
path (the root itself or anything inside it), or a path relative to the active workspace.
Omit it to use the active workspace.

Legend — permission required: `RO` = READ_ONLY, `SW` = SAFE_WRITE, `EX` = EXECUTE,
`FULL` = FULL. Default session permission is `SAFE_WRITE + limited EXECUTE`.

Argument shapes are published as JSON Schema, so a *schema* violation (missing or
wrong-typed field) is rejected by the MCP layer as a protocol error (`-32602`) before the
tool runs. `INVALID_ARGUMENT` is reserved for domain-level argument problems detected
inside a tool; it always carries the zod issue list in `details`.

---

## Phase 1 (workspace lifecycle)

### `open_workspace` — RO
Opens (and registers) a workspace; creates `.devpilot/` if missing; snapshots git state.

```ts
{ path: string,                 // absolute path to the project root (required)
  name?: string,
  createConfig?: boolean,       // default true
  permission?: PermissionLevel  // default from config, else SAFE_WRITE+EXECUTE
}
```
`data`: `{ workspace: WorkspaceState, createdDevpilotDir: boolean, configPath: string, gitNotice?: string }`
Errors: `INVALID_ARGUMENT`, `FILE_NOT_FOUND`, `CONFIG_INVALID`, `GIT_NOT_AVAILABLE`, `INTERNAL_ERROR`.

### `get_workspace_status` — RO
```ts
{ path?: string }               // default: the active workspace
```
`data`: `{ workspace: WorkspaceState, git: GitState, index: { state: IndexState, fileCount?: number },
            devpilotHome: string, registry: { known: number } }`
Errors: `WORKSPACE_NOT_OPEN`, `WORKSPACE_NOT_FOUND`.

### `close_workspace` — RO
```ts
{ path?: string }               // default: the active workspace
```
`data`: `{ closed: string, remainingOpen: number }`; registry entry is kept (for reopening),
never deletes the user's `.devpilot/` data.

---

## Phase 2

### `scan_project` — RO
```ts
{ path?: string, force?: boolean,   // force = ignore cache, full rescan
  include?: string[], exclude?: string[] }
```
`data`: `{ profile: ProjectProfile, stats: { files, dirs, bytes, durationMs, fromCache },
           topLevel: { name, type, files, hint }[], indexState: IndexState }`
Errors: `UNSUPPORTED_PROJECT` (no marker found and no source files), `LIMIT_EXCEEDED`.

### `get_project_map` — RO
```ts
{ path?: string, depth?: number /* default 3 */, focus?: string /* module or file */,
  includeTests?: boolean }
```
`data`: `{ entrypoints: { path, imports: number, summary }[], modules: { path, role, symbols,
            dependsOn, usedBy }[], layers?: string[], notes: string[] }`
Java projects additionally return a `layers` hint (`Controller → Service → Repository → DB`).

Additions shipped with the implementation (additions are allowed, renames are not):

* `scan_project` `data` also carries `languages` (files/bytes per language), `notes` and a
  workspace-relative `cacheFile`. `stats` carries `fromCache`, `truncated`, `maxDepthReached`
  and `skipped { oversized, symlinks, unreadable, excluded }`.
* Cache semantics: the profile lives in `.devpilot/cache/project.json`. The cheap cache key
  covers the workspace config, the tool arguments, the git HEAD and the **top level** of the
  tree (names, sizes, mtimes — `.devpilot`, `.git` and `node_modules` excluded so that writing
  the cache cannot invalidate it). A deep edit inside `src/` therefore needs `force: true`, or
  Phase 3's per-file `mtime+size` index; every cache-hit response says so in `notes`.
* Hitting `workspace.max_files` does **not** fail the call: `stats.truncated` is set, a warning
  is attached and the profile covers what was walked. `LIMIT_EXCEEDED` stays reserved for
  limits that make the requested operation impossible.
* `get_project_map` `data` also carries `engine: 'heuristic-regex'` and `truncated`. `symbols`
  holds names only (`Class.method` for methods); `depth` is the number of dependency-graph hops
  explored around `focus`, and without a `focus` the whole (capped) module list is returned.
  `layers` is emitted only for Java/Kotlin modules — a TypeScript file named `UserService` is
  not a Spring service.

---

## Phase 3

### `find_symbol` — RO
```ts
{ name: string, kind?: SymbolRecord['kind'][], path?: string, caseSensitive?: boolean,
  limit?: number /* default 50, max 200 */ }
```
`data`: `{ query, engine, confidence, truncated, total, definitions: SymbolHit[],
           references: ReferenceHit[] }`
Errors: `INDEX_FAILED`, `WORKSPACE_NOT_OPEN`.

### `find_references` — RO
```ts
{ name: string, path?: string, includeText?: boolean /* default false */, limit?: number }
```
`data`: `{ query, engine, confidence, truncated, total, references: ReferenceHit[],
           definition?: SymbolHit, grouped: { path, count, lines: number[] }[] }`

---

## Phase 4

### `build_project` — EX
```ts
{ path?: string, target?: 'compile' | 'test-compile' | 'package' /* default compile */,
  clean?: boolean, timeoutSeconds?: number, extraArgs?: string[] }
```
`data`: `BuildResult` (status, system, command, durationMs, errors[], warnings[], job)
Errors: `BUILD_FAILED`, `COMMAND_NOT_ALLOWED`, `COMMAND_TIMEOUT`, `UNSUPPORTED_PROJECT`.

### `run_project` — EX
```ts
{ path?: string, command?: string /* explicit override */, args?: string[],
  timeoutSeconds?: number /* default 120 */, env?: Record<string,string>,
  cwd?: string, maxOutputBytes?: number }
```
`data`: `RunResult` + `data.stdoutTail`/`data.stderrTail` (last N lines only)
Errors: `COMMAND_NOT_ALLOWED`, `COMMAND_TIMEOUT`, `COMMAND_FAILED`.

---

## Phase 5

### `run_tests` — EX
```ts
{ path?: string, filter?: string, file?: string, timeoutSeconds?: number,
  extraArgs?: string[], failFast?: boolean }
```
`data`: `TestResult` — always `{ status, framework, total, passed, failed, skipped, errors,
failures[], durations, job }`, never raw logs (log path in `artifacts.log`).
Errors: `TEST_FAILED` (with structured failures), `COMMAND_TIMEOUT`, `UNSUPPORTED_PROJECT`.

### `run_test` — EX
Single target convenience wrapper: `{ target: string }` → one test case's result.

---

## Phase 6

### `diagnose_failure` — RO
```ts
{ jobId?: string,          // default: the last failed job
  command?: string,        // or diagnose an ad-hoc command result
  logFile?: string, path?: string, maxEvidence?: number /* default 8 */ }
```
`data`: `DiagnosisResult` (category, confidence, location, evidence, suspectFiles, relatedJob, hint)
Errors: `FILE_NOT_FOUND`, `WORKSPACE_NOT_OPEN`.

---

## Phase 7

### `review_diff` — RO
```ts
{ path?: string, staged?: boolean, base?: string /* default HEAD */,
  includePatch?: boolean, maxFiles?: number }
```
`data`: `DiffReview`; `artifacts.patch` when `includePatch`.
Errors: `GIT_NOT_AVAILABLE`, `GIT_FAILED`.

### `get_git_status` — RO
`data`: `{ branch, head, upstream?, ahead, behind, dirty, changedFiles[], untracked[],
preExisting: boolean, devpilotCheckpoints: number }`

### `create_checkpoint` — SW
```ts
{ path?: string, label?: string, kind?: CheckpointKind }
```
`data`: `{ checkpoint: Checkpoint, note: string }`. Refuses (`GIT_DIRTY`) only when the
operation would endanger user work; a dirty tree is recorded, never stashed away.

### `rollback_checkpoint` — SW (FULL for cross-file restores outside the checkpoint)
```ts
{ checkpointId: string, path?: string, dryRun?: boolean }
```
`data`: `{ restored: string[], skipped: string[], protectedUserChanges: string[], dryRun }`
Guarantee: only files tracked by that checkpoint are touched; user edits made after the
checkpoint are reported and left alone unless `force` (FULL) is explicitly requested.

---

## Phase 8

### `impact_analysis` — RO
```ts
{ target: string,          // symbol, file or directory
  kind?: 'symbol' | 'file' | 'auto', depth?: number /* default 2 */,
  includeTests?: boolean /* default true */, limit?: number }
```
`data`: `{ target, method: 'ast' | 'heuristic', confidence, affectedFiles[], affectedSymbols[],
           relatedTests[], risks[], riskLevel: 'HIGH'|'MEDIUM'|'LOW', notes[] }`

---

## Phase 9

### `doctor` — RO
```ts
{ verbose?: boolean }
```
`data`: `EnvironmentReport` (tools[], conflicts[], overall) — diagnosis only, never auto-fix.

### `dependency_audit` — RO
`data`: `{ ecosystems[], direct, transitive, outdated[], vulnerable[]?, lockIssues[] }` (network optional).

---

## Error code reference

| Code | Meaning / agent action |
| --- | --- |
| `WORKSPACE_NOT_OPEN` | call `open_workspace` first |
| `WORKSPACE_NOT_FOUND` | path does not exist or is not a directory |
| `INVALID_ARGUMENT` | fix the call; `details` lists zod issues |
| `PERMISSION_DENIED` | the session permission level is too low for this tool; reopen with a higher level |
| `PATH_OUTSIDE_WORKSPACE` | request a path inside the workspace or ask the human |
| `SECRET_PROTECTED` | file exists, contents withheld by policy |
| `FILE_NOT_FOUND` | wrong path |
| `CONFIG_INVALID` | `.devpilot/config.yml` failed validation; `hint` shows the field |
| `LIMIT_EXCEEDED` | split the work into stages (`max_files_changed`) |
| `COMMAND_NOT_ALLOWED` | command rejected by policy; use a supported build/test entrypoint |
| `COMMAND_TIMEOUT` | raise `timeoutSeconds` (bounded) or make the command bounded |
| `COMMAND_FAILED` | non-zero exit; next step is `diagnose_failure` |
| `BUILD_FAILED` | structured `errors[]` returned |
| `TEST_FAILED` | structured `failures[]` returned |
| `INDEX_FAILED` | index build failed; retry `scan_project { force: true }` |
| `UNSUPPORTED_PROJECT` | no known build/test system; pass explicit commands in config |
| `GIT_NOT_AVAILABLE` | install git or work without git features |
| `GIT_DIRTY` | operation refused to protect uncommitted user work |
| `GIT_FAILED` | git returned an error; `details.stderr` has it |
| `NOT_IMPLEMENTED` | tool exists but its phase is not finished yet |
| `INTERNAL_ERROR` | bug; `details` has a correlation id matching the log |

Stability contract: tool names, argument names, `data` shapes and error codes are frozen
once shipped in V1; additions are allowed, silent renames are not.
