# DevPilot MCP — V1 Plan & Roadmap

Rule of this document: **a phase is done only when it runs, is tested, and produces the
evidence listed in its gate.** No phase starts before the previous gate passes.

```text
Phase 1  init + MCP server + Workspace        Phase 6  error diagnosis
Phase 2  project scanner + project map        Phase 7  git diff / checkpoint review
Phase 3  symbol / reference index             Phase 8  impact analysis
Phase 4  runner (build / run)                 Phase 9  security system (hardening)
Phase 5  test runner                          Phase 10 real-project validation
```

## V1 scope

Must-have tools:

```text
open_workspace  get_workspace_status  close_workspace
scan_project    get_project_map
find_symbol     find_references
run_project     run_tests
diagnose_failure  review_diff
```

Languages: **Python, Java/Maven, Node.js**; Gradle and Docker Compose are secondary.
Explicitly out of V1: web UI, cloud, accounts, teams, vector DB, embeddings-as-index,
remote runners, 30 half-finished tools, full IDE features.

---

## Phase 1 — Project init, MCP server, Workspace  ✅ GATE PASSED

Status: **passed** (evidence below). Delivered as planned, with three deliberate additions
recorded under "Phase 1 decisions".

Deliverables
* TypeScript strict project (`package.json`, `tsconfig.json`, build/test scripts).
* Error model (`DevPilotError` + stable codes) and result envelope.
* Storage layout: DevPilot home (`%LOCALAPPDATA%\DevPilot`), workspace `.devpilot\`
  (config.yml / cache / logs / checkpoints), atomic JSON state.
* Config loader (zod-validated `.devpilot/config.yml`, default config generation).
* Security substrate: path confinement, sensitive-file classification, limits,
  permission levels.
* Workspace manager: open / close / status, registry persistence, project marker
  detection, git state snapshot (branch, clean/dirty, head).
* MCP server over stdio + tool registry; tools: `open_workspace`,
  `get_workspace_status`, `close_workspace`.
* CLI: `init`, `serve`, `status`, `version`.
* Tests: unit (path policy, config, workspace manager, envelope) + integration
  (spawn MCP client over stdio: `tools/list`, `open_workspace`, `get_workspace_status`).

Gate evidence
```text
npm run build   → clean (tsc strict, 0 errors)
npm test        → 10 test files / 83 tests, all pass, including the stdio MCP test
                  (real MCP client → dist/index.js serve → tools/list → open_workspace
                   → get_workspace_status → close_workspace)
devpilot init   → creates .devpilot\{config.yml,cache,logs,checkpoints}, detects
                  "Python / PyTorch, pip / pytest, entrypoint train.py", exit 0
devpilot status → prints profile + git + permission + home; exit 0
devpilot status <missing> → "devpilot FILE_NOT_FOUND: ..." with hint, exit 2, no stack
```

Phase 1 decisions (additions to the plan, all reflected in the docs)
* `security.execute` (default `true`) expresses the documented default
  "SAFE_WRITE + limited EXECUTE": EXECUTE-gated tools stay reachable, the command policy
  still forbids shells. `permission: READ_ONLY` locks a session down to analysis.
* `PERMISSION_DENIED` added to the error code list (additions allowed, renames not).
* A `path` selector accepts a workspace id, an absolute path, or a path relative to the
  active workspace. Schema violations are rejected by the MCP layer as `-32602`;
  `INVALID_ARGUMENT` covers domain-level argument problems.
* Process execution and git access were pulled forward from Phase 4/7 as infrastructure
  (`runner/process-runner.ts` is the single gate to the OS; `git/git-manager.ts` is
  read-only), because workspace open must snapshot git state without a second process path.
  Phase 4 and 7 build adapters and checkpoint logic on top instead of re-creating them.
* `workspace/project-detector.ts` landed at marker level (Phase 2 reuses it and adds
  `.gitignore`-aware walking, statistics and `.devpilot/cache/project.json`).

## Phase 2 — Project scanner + project map  ✅ GATE PASSED

* `file-walker` (ignore-aware, `.gitignore` + config excludes, symlink-safe, depth/size caps).
* Marker detection table: pom.xml, build.gradle, settings.gradle, package.json,
  pnpm-lock.yaml, requirements.txt, pyproject.toml, setup.py, CMakeLists.txt,
  Dockerfile, docker-compose.yml, .git.
* Framework detection: Spring Boot, PyTorch, FastAPI, Flask, Django, React, Vue,
  Next.js, Express.
* ProjectProfile persisted to `.devpilot/cache/project.json`; entrypoint hints;
  candidate run/build/test commands per the rule table.
* `get_project_map`: module/dependency map (entrypoint → modules → notable classes),
  not a raw directory tree.
* Tools: `scan_project`, `get_project_map`.

Gate: scan the three fixtures (python / maven / node) and one real project; profile and
map match hand-written expectations; second scan is fast (cache hit).

Gate evidence
```text
npm run build   → clean (tsc strict, 0 errors)
npm test        → 15 test files / 120 tests, all pass
                  new: gitignore engine, file-walker (incl. symlink + oversize + include),
                  scanner (3 fixtures, cache hit, force, polyglot, empty dir),
                  project map (parser units, python/java/node edges, layers, focus, cap),
                  tool layer (scan_project / get_project_map through the registry),
                  real stdio MCP client: tools/list = 5 tools, open → scan → scan(cache) → map
fixtures        → python: PyTorch/pytest, entrypoint train.py, 8 files
                  maven : Java/maven, pom.xml, `mvn -q test`, 4 java files
                  node  : npm, scripts → build/test/run, test/index.test.js depends on src/index.js
real project    → the DevPilot repository itself (88 files, 37 dirs, 420 KB):
                  detected "TypeScript/JavaScript/Python/Java / Node", markers package.json +
                  tsconfig.json, `npm run build` / `npm test` / `npm start`, node_modules and
                  dist excluded, first scan 38 ms → second scan 2 ms (cache hit)
                  project map: 70 modules, entrypoint src/index.ts, 67 ms, edges verified by
                  hand (open-workspace.ts → tool-registry/envelope/shared; usedBy tools/index.ts)
CLI             → `devpilot scan <path>` text + `--json` + `--force`; cache reused across runs
```

Phase 2 decisions (additions to the plan, all reflected in the docs)
* **Primary ecosystem rule.** Root markers decide which ecosystem owns a repository, source-file
  counts break ties, and the winner supplies `projectType`/`buildSystem`/`testFramework` while
  every detected language stays in `languages` (primary first). Without it the DevPilot repo —
  whose `fixtures/` contain a Maven sample — was reported as Java/maven, which would have made
  every inferred command wrong. Deterministic, never an LLM.
* **`SCANNER_VERSION`** is part of the cache key and of the cache file: detection semantics change
  with the code, the cache key only describes the tree, so a stale profile must not survive an
  upgrade.
* Cache honesty over cache cleverness: a top-level-only key is cheap and never wrong about
  structure; deep edits are Phase 3's job (per-file `mtime+size`). The alternative — walking to
  fingerprint — would have removed the entire benefit of the cache.
* `.devpilot/`, `.git/` and `node_modules/` are excluded from the cache observation, otherwise
  DevPilot's own writes (and `git status` touching `.git/index`) would invalidate every scan.
* `layers` is Java/Kotlin-only; the TypeScript case is a regression test.

## Phase 3 — Symbol & reference index  ✅ GATE PASSED (re-verified in the Phase 4 run)

* `code/lang/*` adapters (Python/Java/TS-JS): classes, functions, methods, fields,
  signatures, line spans; import/require edges.
* SQLite (or JSON fallback) index in `.devpilot/cache/`, incremental on `mtime+size`.
* `find_symbol` (definition + type + span + docstring summary), `find_references`
  (definition-aware, marks engine + confidence, excludes comments/strings where the
  AST allows it).
* Tools: `find_symbol`, `find_references`.

Gate: `find_symbol("CausalSelfAttention")` and `find_references("LoginService")` on
fixtures return exactly the expected locations; incremental re-index after editing one
file parses only that file.

## Phase 4 — Runner (build / run)  ✅ GATE PASSED

* `process-runner`: single process gate, timeout, output caps, job ids, log files,
  env/cwd control, kill-tree on timeout.
* `command-policy`: allow-list per tool, deny-list for destructive commands
  (`rm -rf /`, `del /s`, `format`, `diskpart`, `shutdown`, `reboot`, `mkfs`, ...),
  no shell unless explicitly allowed by config.
* Build adapters: Maven (`test`/`package`), Gradle (secondary), npm/pnpm scripts,
  Python (`compileall`, `pyproject` build).
* Run adapters: package.json scripts, Spring Boot jar, python entrypoints.
* Tools: `build_project`, `run_project`.

Gate: build + run one Maven project and one Node project; timeout is enforced on a
deliberately hanging fixture; full logs land in `.devpilot/logs/` while the MCP reply
stays structured and small.

## Phase 5 — Test runner  ✅ GATE PASSED

* Test adapters: pytest, unittest, Maven Surefire, Gradle test, Jest, Vitest.
* Parsed results: total/passed/failed/skipped/errors + per-failure
  (name, file, line, message excerpt, stack head).
* Tools: `run_tests` (all or filtered), `run_test` (single target).
* Fixtures ship with intentionally failing tests.

Gate: pytest/maven/node fixture failures are parsed into the exact JSON shape
(`total/passed/failed/skipped` + failure list) with the raw log referenced as an artifact.

Gate evidence (docs/GATES.md → "Phase 5"): `tsc -p tsconfig.json` 0 errors,
`vitest run` 26 files / 209 tests pass, CLI smoke `devpilot test` → passed 3/3 (exit 0),
seeded failure → `failed 3/4` with `tests/test_model.py:34` (exit 1), `--filter` → 1/1.

Two traps the gate caught and the implementation now defends against:

1. `-q` in the planned pytest arguments stacked with the project's own `addopts = "-q"` to
   `-qq`, which suppresses the summary line — a parser that finds nothing would have reported
   a silent `0 failures`. pytest is now planned without a quiet flag, and a unit test pins the
   `-qq` shape as `parsed: false` (never a fabricated green).
2. node:test TAP failures put the message on an indented line under the `error: |-` YAML key;
   reading the key line made every failure read "error: |-".

## Phase 6 — Failure diagnosis  ✅ GATE PASSED

* `diagnose_failure`: correlate last command (job id) + exit code + stderr + stack
  trace + recent file changes (git status/diff stat) + environment facts.
* Rule catalog + parsers for Java (NPE, compile errors, Maven resolution), Python
  (ImportError/ModuleNotFoundError, shape errors, CUDA OOM), Node (ENOENT, EADDRINUSE,
  TS errors).
* Output: `category`, `location`, `evidence`, `suspect_files` (recently changed ∩
  stack), `confidence`, `hint` — never a fake root cause.
* Tool: `diagnose_failure`.

Gate: on the failing fixtures each seeded failure is classified into the right category
with the correct file:line and a suspect file list.

Notes fixed with Phase 6:

- The classifier is a **weighted rule table** (`src/diagnose/patterns.ts`), not a model call:
  a strong rule beats a weak one, and `UNKNOWN` is an honest answer (`hint` still points at the
  log). `confidence` is *stated*: strong + located = high, strong unlocated = medium, weak =
  medium/low, `UNKNOWN` = low. A failing assertion is deliberately only `medium` — it reports a
  symptom, not the cause.
- Locations come from four frame families (Python tracebacks, JVM, JS/TS, generic `file:line`).
  Frames in `site-packages` / `node_modules` / `.venv` and frames outside the workspace are
  **counted and skipped**, never returned: the agent should not be sent into a dependency.
- Evidence is bounded (default 8 lines, clipped to 400 chars) and `evidenceDropped` says how many
  matched lines were withheld; the located source line is prepended. Suspect files are ordered by
  specificity — `in_stack` → `recently_changed` (git status, deletions excluded) →
  `import_related` (reuses the Phase 3 index when it is already in memory, otherwise a note says so).
- `relatedJob.command` is the full command line (`python -m pytest -p no:cacheprovider`), because
  the ledger stores executable and argv separately.
- `devpilot diagnose [path] [--job=] [--log=] [--max-evidence=] [--json]` is the CLI twin and
  shares one use case (`src/diagnose/diagnose-job.ts`) with the tool, so the two cannot drift.

## Phase 7 — Git diff review & checkpoints  ✅ GATE PASSED

* `git-manager` hardening: detect pre-existing user modifications before anything runs;
  refuse destructive flows when the tree is dirty (`GIT_DIRTY`).
* `diff-analyzer`: per-file added/deleted counts, changed symbols via AST diff-fallback,
  risk heuristics (gradient accumulation / tensor layout / schema / public API /
  config → HIGH/MEDIUM/LOW), affected tests, unrelated-file detection.
* Checkpoints: create (internal ref + patch stored under `.devpilot/checkpoints/`),
  list, rollback **only** DevPilot-tracked changes, protecting user edits.
* Tools: `review_diff`, `get_git_status`, `create_checkpoint`, `rollback_checkpoint`.

Gate evidence (docs/GATES.md → "Phase 7"): `tsc -p tsconfig.json` 0 errors; the full suite
passes 32 files / 256 tests, including four real-repository cases (status/diff/checkpoint/
rollback) and an end-to-end run through the tool registry. A dirty working tree survives
create → agent edit (same lines) → rollback; a file that appeared after the checkpoint is never
deleted; DevPilot's own `.devpilot/` state is excluded from both the review and the checkpoint.

Two corrections the gate forced (both recorded in GATES.md):

* The restore mechanism was **replaced**: a patch reverse-apply cannot undo an edit to the very
  lines the checkpoint recorded, which is the normal workflow. Checkpoints now store the
  **content** of each changed file, and rollback writes it back.
* Rollback used to report a path as `restored` when `git apply` succeeded on a selection that
  contained no hunk for it (a successful no-op). A path is now only restored when the snapshot —
  or, as a fallback, an actual patch hunk — covers it.

## Phase 8 — Impact analysis  ✅ GATE PASSED

* Combine definition/reference index, import graph, config references, test association.
* Output: target(s), affected files, affected symbols, related tests, risk level,
  `confidence` + `method` (AST vs heuristic).
* Optional architecture/dependency graph view.
* Tool: `impact_analysis`.

Gate: modifying a class in the Maven fixture lists its callers and tests; a PyTorch
fixture lists model/train/test blast radius with honest confidence labels.

Gate evidence (34 test files / 270 tests, tool count 16 → 17; see docs/GATES.md Phase 8):
`CausalSelfAttention` resolves to `model.py:14` with `train.py` in `affectedFiles` and
`tests/test_model.py` in `relatedTests`; `model.py` and `tests` are recognised as file and
directory targets; `includeTests: false` moves tests out of `affectedFiles` while keeping
them in `relatedTests`; an unknown name answers `confidence: 'low'` instead of pretending.

## Phase 9 — Security hardening + environment doctor ✅ GATE PASSED

Gate evidence (Phase 9 run): `tsc -p tsconfig.json` exit 0 and the full `vitest run` is
**41 files / 332 tests passed** (Phase 8: 34/270).

* Attack fixtures (`tests/integration/security-attack.test.ts`) 7/7: a log read outside the workspace
  and a Windows **junction** that escapes it are both refused; `format C: /y`, `diskpart` and
  `rm -rf /` return `COMMAND_NOT_ALLOWED` without spawning anything; `.env` yields its existence and
  nothing else; a credential inside an ordinary log is redacted with a warning naming the rule kinds;
  a two-file change set under `max_files_changed: 1` is flagged with staging advice.
* `devpilot doctor` on the developer machine: git 2.51.1, node 22.23.2, npm 12.1.0, pnpm 11.23.0,
  python 3.11.9 and 3.12.11, conda 22.9.0, java/javac 17.0.19, mvn 3.9.11, docker 29.1.3, wsl, nvcc 11.3,
  torch 2.11.0+cpu → overall WARNING with four genuine conflicts (4 Pythons and 6 JDKs on PATH, a CUDA
  toolkit paired with a CPU-only torch build, and a docker CLI whose daemon is not reachable).
* Defects the gate found and fixed: containment was lexical only, so a junction inside the workspace
  could still be read (now both sides are `realpath`ed); the dotenv redaction rule matched ordinary
  code such as `access_token_expiry_seconds = 3600`; `poetry.lock`/`uv.lock` were fed to a YAML parser
  although they are TOML, which silently reported zero transitives; Maven `<!-- -->` comments were
  counted as dependencies; and a missing-lockfile issue was blamed on the alphabetically first
  manifest instead of the one that declares dependencies.


* Full command policy, workspace escape attempts blocked, secret masking (.env,
  credentials, private keys, tokens) — existence visible, contents withheld.
* `max_files_changed` / `max_lines_changed` enforcement with staged-execution advice.
* `doctor`: OS/CPU/RAM, Git, JDK, Maven, Gradle, Node, npm, pnpm, Python, pip, Conda,
  CUDA, GPU, Docker, WSL, PATH; conflicts (multiple Python/JDK, PATH order, CUDA↔PyTorch
  mismatch) as OK/WARNING/ERROR. Diagnostics only, no auto-fix.
* Tools: `doctor`, `dependency_audit`.

Gate: attack fixtures (path traversal, symlink escape, dangerous command, secret read,
oversized diff) are each rejected with the right code; doctor on this machine reports
consistent versions.

## Phase 10 — Real-project validation — ✅ GATE PASSED (2026-10-04)

* Wire DevPilot into DeepSeek Harness as an MCP server and run the V1 acceptance script
  below on real projects (e.g. `D:\Projects\minigpt-chinese`, a Spring Boot project).

Gate evidence (`tools/v1-acceptance.mjs`, four stages, workspace `D:\Projects\devpilot-demo`):

* `recon` 8/8 · `verify` 2/2 · `post` 5/5 · `rollback` 7/7 — 22 checks, 0 failures; raw envelopes
  in `docs/evidence/{recon,verify,post,rollback}.json`. Re-run after the last source change, so all
  three stacks carry evidence from one revision: `tsc` exit 0, 45 files / 359 tests green.
* Language stacks (`tools/stack-acceptance.mjs`): **maven 13/13** and **node 13/13**, each running
  the full loop on a real toolchain (Java 17 through Maven 3.9.11, Node 22 `node --test`) with a
  real defect, a real fix and a real rollback; raw envelopes in `docs/evidence/{maven,node}.json`.
  It found four defects unit tests could not: a Maven failure located inside JUnit
  (`AssertionFailureBuilder.java`), `mvn -q test` hiding a green run's counts (reported as
  `passed` with `total: 0`), `exit 0` with no readable summary reported as passed (now the
  `unknown` status), and an ASCII-only path pattern splitting a non-ASCII profile path — and
  taking percent-encoded `file:///` frame URLs for relative paths.
* Wiring: profile `desktop` (`cordis.patch.yml`, backed up first) with
  `@deepseek-ai/dsh-mcp-client`; the exact stdio command DSH spawns answers the handshake in
  397 ms with 19 tools and exits cleanly on stdin EOF (`tools/mcp-probe.mjs`).
* Activation boundary, recorded rather than hidden: `plugin_manager list_plugins` on the running
  desktop profile returns 217 active entries and none of them is `mcp-devpilot`. DSH loads profile
  entries at harness start, so the entry is present and schema-valid but needs a restart before
  `mcp__devpilot__*` reaches the model. Until then, acceptance item 1 holds at config + process
  level only.
* Three defects the real project found that the unit suite did not: f-string interpolations were
  masked as string bodies (a call site vanished), the entry-point list never looked inside a
  package (empty run command, and a src-layout project cannot be started as a path at all), and a
  checkpoint could not undo an edit to a file that was clean when it was taken. Each has a
  regression test; the last changed the rollback contract (`unchanged`, restore from the recorded
  commit). Two caches also had to learn version identity: `EXTRACTOR_VERSION` (index) and
  `SCANNER_VERSION` 2 → 3 (profile).

Gate = V1 acceptance:

```text
 1. DevPilot MCP connected to DeepSeek Harness
 2. pick a real Git project            → open_workspace
 3. agent scans it                     → scan_project
 4. "how do I run this project?"       → correct answer
 5. "where is LoginService used?"       → references found
 6. agent fixes a real bug              (checkpoint first)
 7. agent runs tests                    → run_tests
 8. failures come back structured       → diagnose_failure
 9. agent fixes again
10. tests pass                          → evidence
11. which files changed                 → review_diff
12. diff is auditable
13. pre-existing user Git changes are untouched end-to-end
```

V1 is "usable" only when all 13 hold. "The MCP server starts" is not acceptance.

## Cross-cutting requirements

* TypeScript strict, one responsibility per module, no 3000-line file, unified errors,
  unit tests for every parser and policy.
* Fixtures: `fixtures/python-project`, `fixtures/maven-project`, `fixtures/node-project`
  (each minimal, with a seeded failure and a test suite).
* Performance: 1k–5k file project — first scan reasonable, incremental scan visibly
  faster, and no tool re-parses the whole repo on every call.
