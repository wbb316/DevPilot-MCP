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

Notes that apply to both Phase 3 tools:

- `path` is a **filter**, not a workspace selector: it restricts results to files under a
  workspace-relative prefix. The workspace itself comes from `open_workspace`.
- Matching tiers for `find_symbol`: exact name → `Container.member` (parent-qualified) →
  name prefix → name substring. Default is case-insensitive; `caseSensitive: true` opts out.
- Both return `engine: "text"` and `extractor: "heuristic-regex"` (lexical, not a compiler)
  plus an `index` block (`state`, `store: "sqlite" | "json"`, `files`, `symbols`, `refs`,
  `parsed`, `reused`) so the caller can judge how much to trust a negative answer.
- The index refreshes incrementally on every call (mtime+size); `parsed: 0` means the tree
  was unchanged. `scan_project { force: true }` is the full-rebuild escape hatch.
- Everything skipped is reported in `warnings` (unsupported language, oversized file, parse
  error, per-file reference cap) — never dropped silently.

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

Notes fixed with Phase 4:

- `path` here selects the **workspace** (id, absolute path, or a path inside it) — unlike the
  Phase 3 tools, where `path` filters results.
- A failed build/run is an error envelope whose `error.details` carries the whole structured
  result (`status`, `errors[]`, `stdoutTail`/`stderrTail`, `job`). The agent never parses a
  raw log to find out what broke; `job.logFile` is the full transcript.
- Commands come from a rule table (`src/runner/build-system.ts`), never from an LLM, and are
  validated by the command policy before `process-runner` spawns anything.
  Target mapping — Maven: `compile` / `test-compile` / `-DskipTests package` (+`clean`);
  Gradle: `compileJava` / `testClasses` / `build -x test` (+`clean`, wrapper when present);
  npm/pnpm/yarn: `run build`, and `run typecheck` for `test-compile` when it exists;
  Python: `-m compileall -q <sourceDirs>` and `-m build` for `package` (needs pyproject.toml).
  `config.project.build_command` overrides every rule; a target the rules cannot map is
  refused as `UNSUPPORTED_PROJECT` instead of guessed.
- `run_project` resolution order: explicit `command` → the project's own run command
  (config.yml / package.json / detector candidate) → inference from detected entrypoints
  (Python entrypoint, Spring Boot dev server, `node <entry>`). A server that never exits ends
  as `COMMAND_TIMEOUT` with its output preserved — the expected shape for a service.
- Every invocation is appended to `.devpilot/logs/jobs.jsonl` (last 200 kept) with a raw
  transcript at `.devpilot/logs/<jobId>.log`; Phase 6 reads that ledger for diagnosis.
- Children run with `NO_COLOR=1`, `CI=1` and `PYTHONUNBUFFERED=1` so that a service killed by
  the timeout still has emitted the output the agent needs to see.

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

Target forms accepted (docs the agent can rely on): `path/to/test_x.py::test_name`,
`path/to/test_x.ts`, `UserServiceTest#method`, or a bare `test_name` (a name filter).

Notes fixed with Phase 5:

- `data.parsed` is the honesty flag: `true` only when a machine-readable summary was actually
  parsed. When it is `false` the counts must not be trusted, and `data.notes` says so and
  points at `artifacts.log`. Counts are never invented to fill the shape.
- `data.parser` names the parser that produced the numbers. It can differ from
  `data.framework` when a package.json test script hides a different runner; the fallback
  chain is vitest → jest → node --test → pytest → unittest → JUnit.
- `data.status` adds `no_tests` (exit code 0, nothing collected) and `unknown` (exit code 0 but
  no machine-readable summary was found): both are returned as successful envelopes with a
  warning, never as "passed".
- pytest is planned **without** a quiet flag: a project whose own `addopts` already contains
  `-q` would otherwise reach `-qq`, which suppresses the summary line. `-p no:cacheprovider`
  keeps `.pytest_cache` out of the user's working tree. Maven is planned with `-B` for the same
  reason (Phase 10): `mvn -q test` hides Surefire's `Tests run:` line on success, so a green
  suite was reported as `passed` with `total: 0`.
- Java failures report `suite` (test class) and, when a stack frame is available, `path`
  (source file name) + `line`. The frame is chosen by quality — the failing test's own class
  first, then project code, then framework internals — because Surefire's *first* frame is
  JUnit's own `AssertionFailureBuilder.java` (Phase 10). The log artifact holds the full trace.
- A failing run is an `TEST_FAILED` error envelope whose `error.details` carries the whole
  structured result — the agent still reads structure, not the log.
- `devpilot test [path] [--filter=…] [--file=…] [--fail-fast] [--json]` is the CLI twin:
  exit 0 passed, 1 failed / no tests / unverified, 2 a DevPilot error.

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

Notes fixed with Phase 6:

- `command` matches the most recent job whose command line *contains* the text; it does not run
  anything. With no arguments at all the most recent failed job is diagnosed (the newest job if
  nothing has failed), and an empty ledger is `FILE_NOT_FOUND` with a hint to run something first.
- `category` is one of `CUDA_OUT_OF_MEMORY`, `SYSTEM_OUT_OF_MEMORY`, `NULL_POINTER`,
  `IMPORT_ERROR`, `SYNTAX_ERROR`, `TYPE_ERROR`, `NAME_ERROR`, `KEY_ERROR`, `ASSERTION_FAILED`,
  `TEST_FAILED`, `COMPILE_ERROR`, `DEPENDENCY_ERROR`, `PORT_IN_USE`, `PERMISSION_DENIED`,
  `FILE_NOT_FOUND`, `ENCODING_ERROR`, `NETWORK_ERROR`, `TIMEOUT`, `CONFIG_ERROR`, `GIT_ERROR`,
  `UNKNOWN`. A strong rule wins over a weak one; `UNKNOWN` means no rule matched.
- `confidence` is stated, never implied: strong+located `high`, strong unlocated `medium`,
  weak `medium`/`low`, `UNKNOWN` `low`.
- `evidence` is capped (`maxEvidence`, default 8, lines clipped to 400 chars) and starts with the
  source line at `location` when it could be read. `evidenceDropped` reports withheld matches;
  `notes` reports an empty log, frames skipped as dependency code, and a truncated log tail
  (only the last 2 MiB are analysed). The full transcript is `logFile`.
- Only the last 2 MiB of a log are read: failure summaries live at the end of the output.
- `relatedJob.command` is the complete command line, executable plus argv.
- `devpilot diagnose` is the CLI twin of this tool and shares its implementation.
- `location` is ordered by what can be verified: frames that resolve to a file this workspace
  actually contains come first, then frames naming a file it does not contain (dependencies, the
  JDK, JUnit). A JVM trace prints bare file names, so they are resolved against the symbol index —
  built on demand, and only when a frame could not otherwise be placed — which keeps the answer on
  the project's own file instead of `AssertionFailureBuilder.java`. How many frames could not be
  placed is stated in `notes`.
- Percent-encoded `file:///` URLs (how `node --test` prints frames) are decoded, and paths are
  matched with a non-ASCII-tolerant pattern, so a workspace under `C:\Users\王贝波\…` is not split
  mid-path. TAP diagnostic keys (`error: |-`, `code: 'ERR_ASSERTION'`) are not returned as evidence.

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
`data`: `{ restored: string[], skipped: string[], protectedUserChanges: string[], dryRun, notes[] }`
Guarantee: only the files recorded by that checkpoint are touched, and the git index is never
modified (no `add`, `reset`, `checkout -f`, `clean`).

Notes fixed with Phase 7:

- A checkpoint stores the **content** of every changed file under `.devpilot/checkpoints/<id>/`,
  plus a patch of the created diff as an audit artifact. Rollback writes the content back, so it
  works after the normal workflow (checkpoint → edit the same lines → roll back); a patch
  reverse-apply cannot do that, and it cannot restore a file that was untracked at checkpoint time.
- Because the snapshot is taken before this session changes anything, the user's pre-existing
  uncommitted work is preserved by the restore rather than being refused.
- Files that appear **after** the checkpoint are never deleted: a patch cannot know whether they
  are the user's. They are listed in `notes` instead, and a path with no snapshot and no patch
  hunk is reported in `skipped` — never counted as restored.
- `protectedUserChanges` holds paths DevPilot refuses to write: `.git/` metadata, anything
  absolute, anything escaping the workspace, and snapshot-less files that moved on since.
- `.git` and `.devpilot` paths are excluded from checkpoints and from `review_diff`; a note states
  how many were skipped, so a clean-looking review is never silently hiding files.
- `preExistingChanges` comes from the baseline `open_workspace` writes once
  (`.devpilot/cache/git-baseline.json`). It is captured on first open only, so a reopen cannot
  reclassify the agent's own edits as the user's. Without a baseline the field is empty and
  `review_diff` says so.
- A restore writes the platform's line endings (`core.autocrlf`), matching the rest of the
  checkout; that is git behaviour, not an artefact of DevPilot.

Notes fixed with Phase 10 (real-project acceptance):

- `rollback_checkpoint` also undoes edits to files that were **clean** when the checkpoint was
  taken, using the commit the checkpoint recorded as their baseline. A pre-write checkpoint has no
  snapshot for such files, so without this an agent's edit survived its own rollback.
- `data.unchanged[]` lists paths that already matched the checkpoint or the recorded commit, so
  `restored` never claims a write that did not happen — a user's pre-existing edit is reported as
  left alone, not as "restored".
- A rollback never writes a file it cannot reconstruct, never rewrites a binary file, and keeps the
  file's own line-ending convention (a restore must not become a whole-file CRLF diff).
- `project.candidates.runEnv` (additive) carries environment the run command needs: a src-layout
  Python project is only importable as `python -m pkg.mod` with `PYTHONPATH=<src>`. `run_project`
  applies it and says so in its notes; without it the inferred command fails like a user bug.

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

Notes fixed with Phase 8:

- `method` is `'heuristic'` in this build (`extractor: 'heuristic-regex'`): declarations, references
  and import edges come from lexical extractors, so receiver-typed call resolution is out of scope.
  Every answer ends with a note saying so — read it before treating the result as a call graph.
- `targetKind` is resolved deterministically: an indexed file or an existing path/file wins, an
  existing directory or an index prefix wins next, everything else is a symbol. A target that is
  absolute or contains `..` is never treated as a path (it cannot leave the workspace).
- The tool takes **no** `path` argument: it analyses the open workspace (the Phase 3 tools' `path`
  means "filter results", Phase 4's means "select workspace" — this one has neither, so there is no
  ambiguity to inherit).
- `affectedFiles[].reason` answers *why the file is in the set*: `declaration`, `target`,
  `reference`, `importer` (distance ≥ 1, `detail` names the imported file), `dependency`, `test`,
  `directory_member`. Test-ness is a separate dimension carried by `relatedTests`; a test file that
  references the target keeps `reference` rather than being relabelled.
- `distance` counts import hops from the direct files (`depth`, default 2). `lines` lists up to 20
  reference lines per file.
- `affectedSymbols` holds the declarations involved: `reason: 'definition'` for the target's own
  declarations, `'reference'` for the innermost scope enclosing each use.
- Risks are a deterministic rule set and always carry a reason: ≥30 references HIGH, ≥10 MEDIUM;
  a type declaration; same-name declarations; fan-in ≥ 10 importers HIGH; circular imports; a
  build/config manifest HIGH; and "no test references this" MEDIUM. `riskLevel` is the maximum.
- `confidence` is derived, never asserted: one exact declaration `high`, several or a fuzzy name
  match `medium`, nothing found `low`; file targets are `high` when indexed, directory targets
  `medium`.
- Truncation is explicit: `truncated` plus a note (`limit` files listed, 200 directory members,
  25 symbols per file target).

---

## Phase 9

### `doctor` — RO
```ts
{ verbose?: boolean }
```
`data`: `EnvironmentReport` (tools[], conflicts[], overall) — diagnosis only, never auto-fix.

### `dependency_audit` — RO
`data`: `{ ecosystems[], direct, transitive, outdated[], vulnerable[]?, lockIssues[] }` (network optional).

Notes fixed with Phase 9:

- `doctor` is machine-scoped: it takes no `path`. When a workspace is open, its root is the
  directory the project-aware checks use; otherwise the server's working directory is. It is
  read-only by construction — nothing in it installs, upgrades or reconfigures a toolchain.
- A version is reported only when it was parsed out of the tool's own output. A probe that timed out
  reports the tool as present with `message` explaining the timeout, and the timeout is listed in
  `notes`; `doctor` never invents a version.
- Probes go through `runExecutable`, so Windows `.cmd` shims (`npm.cmd`, `mvn.cmd`) are resolved
  rather than reported missing — that distinction is the difference between a useful report and a
  misleading one.
- Conflicts are the point of the tool: several pythons / JDKs / node installs on PATH (with the
  resolution order), `JAVA_HOME` disagreeing with the first `java` on PATH, a CUDA toolkit against a
  CPU-only PyTorch wheel, a GPU present while `torch.cuda.is_available()` is false, a project marker
  whose toolchain is missing, a Node version below the project's `engines.node`, and a docker CLI
  whose daemon is unreachable.
- Secret redaction is applied at the envelope boundary (`ok`/`fail` in `src/errors/envelope.ts`), so
  every tool result is sanitised and a warning states how many values were replaced. A
  secret-bearing file is a second, stronger rule: `diagnose_failure` will not analyse `.env`-like
  logs or read the source line at a location inside one — it reports that the file exists and says
  why the content was withheld.
- `review_diff` enforces `security.max_files_changed` / `security.max_lines_changed` and returns the
  verdict as `data.changeLimits` plus staging advice in `warnings`. `0` means "no budget". A patch
  artifact is redacted before it is written, so the file on disk is as safe as the response.

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
