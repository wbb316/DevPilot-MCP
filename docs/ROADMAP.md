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

## Phase 2 — Project scanner + project map

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

## Phase 3 — Symbol & reference index

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

## Phase 4 — Runner (build / run)

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

## Phase 5 — Test runner

* Test adapters: pytest, unittest, Maven Surefire, Gradle test, Jest, Vitest.
* Parsed results: total/passed/failed/skipped/errors + per-failure
  (name, file, line, message excerpt, stack head).
* Tools: `run_tests` (all or filtered), `run_test` (single target).
* Fixtures ship with intentionally failing tests.

Gate: pytest/maven/node fixture failures are parsed into the exact JSON shape
(`total/passed/failed/skipped` + failure list) with the raw log referenced as an artifact.

## Phase 6 — Failure diagnosis

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

## Phase 7 — Git diff review & checkpoints

* `git-manager` hardening: detect pre-existing user modifications before anything runs;
  refuse destructive flows when the tree is dirty (`GIT_DIRTY`).
* `diff-analyzer`: per-file added/deleted counts, changed symbols via AST diff-fallback,
  risk heuristics (gradient accumulation / tensor layout / schema / public API /
  config → HIGH/MEDIUM/LOW), affected tests, unrelated-file detection.
* Checkpoints: create (internal ref + patch stored under `.devpilot/checkpoints/`),
  list, rollback **only** DevPilot-tracked changes, protecting user edits.
* Tools: `review_diff`, `get_git_status`, `create_checkpoint`, `rollback_checkpoint`.

Gate: a dirty working tree survives create → agent edit → rollback unchanged; review_diff
flags an intentionally sneaky unrelated-file edit.

## Phase 8 — Impact analysis

* Combine definition/reference index, import graph, config references, test association.
* Output: target(s), affected files, affected symbols, related tests, risk level,
  `confidence` + `method` (AST vs heuristic).
* Optional architecture/dependency graph view.
* Tool: `impact_analysis`.

Gate: modifying a class in the Maven fixture lists its callers and tests; a PyTorch
fixture lists model/train/test blast radius with honest confidence labels.

## Phase 9 — Security hardening + environment doctor

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

## Phase 10 — Real-project validation

* Wire DevPilot into DeepSeek Harness as an MCP server and run the V1 acceptance script
  below on real projects (e.g. `D:\Projects\minigpt-chinese`, a Spring Boot project).

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
