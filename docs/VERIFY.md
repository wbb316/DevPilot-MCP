# Verifying DevPilot MCP

DevPilot's product claim is *evidence instead of assurance* ("it should work" is not a result).
The same standard applies to DevPilot itself, so this file is how you reproduce the evidence
yourself instead of trusting a report.

Four independent channels, cheapest first. Each answers a different question, and a green
Channel 1 does **not** imply Channel 3 — that distinction is the whole point of the list.

| Channel | Question it answers | Cost |
| --- | --- | --- |
| 1 — repo gate | is the code in this checkout sound? | ~1 min |
| 2 — loop acceptance | does the engineering loop really work end to end? | ~3 min |
| 3 — inside DeepSeek Harness | can an agent actually use it through the tool bridge? | a few turns |
| 4 — CLI | is the fault in DevPilot, or in the MCP/DSH layer? | seconds |

V1 acceptance is defined in [ROADMAP.md](ROADMAP.md) as 13 frozen items. §5 maps each item to
the channel that covers it.

---

## 0. Prerequisite: what this machine actually has

```powershell
cd D:\tools\DevPilot-MCP
npm run build            # dist/index.js must exist; every other command runs it
node dist\index.js doctor
```

`doctor` only **reports**; it never installs or reconfigures anything. Each finding is
`OK` / `WARNING` / `ERROR`, and an `ERROR` names the stack it blocks.

Verified on the development machine (2026-10-05): Git 2.51.1 · Node 22.23.2 · Python 3.11.9 with
pytest 9.1.1 · Temurin JDK 17.0.19 (`D:\JDK\JDK17`, also on `PATH`) · Maven 3.9.11. CUDA / GPU /
Docker / WSL lines depend on the machine and are reported as absent rather than guessed.

---

## 1. Channel 1 — the repo gate

```powershell
cd D:\tools\DevPilot-MCP
npm run build      # tsc -p tsconfig.json            (must exit 0)
npm run typecheck  # tsc -p tsconfig.json --noEmit   (must exit 0)
npm test           # pretest builds, then vitest run
npm run smoke      # self-hosting: index this repo and query it back
```

Expected, verified 2026-10-05:

```text
tsc (build)      exit 0
tsc (noEmit)     exit 0        strict; src and tests are both typechecked
vitest run       46 test files / 365 tests passed, ~26 s

node scripts\smoke.mjs   -> SMOKE PASS (exit 0); self-hosting on this checkout:
                 scan 201 files; find_symbol engine=text extractor=heuristic-regex
                 confidence=high store=sqlite files=172 symbols=3945 refs=13312;
                 the repeated call must report `incremental: parsed=0 reused=172`
                 — if it re-parses, the incremental path is broken
```

PowerShell trap that has bitten this repo before: run `tsc` directly
(`node .\node_modules\typescript\bin\tsc -p tsconfig.json`) and read `$LASTEXITCODE`.
Piping compiler output through `Select-Object` masks the real exit code as `1`, and
`npm run build` prints only npm noise while swallowing the compiler verdict.

A green here proves the code is sound. It proves nothing about the MCP bridge.

---

## 2. Channel 2 — the whole loop, one command, nothing of yours touched

`tools/stack-acceptance.mjs` is deliberately self-contained. Per stack it: copies a fixture
into `%TEMP%`, `git init`s it, injects a defect that fails for a *real* reason, then drives a
real `node dist/index.js serve` over stdio through

```text
open -> scan -> symbol -> checkpoint -> build -> run_tests(must fail) -> diagnose_failure
     -> fix the source -> run_tests(must pass) -> review_diff -> rollback
     -> run_tests(must fail again) -> close
```

```powershell
node tools\stack-acceptance.mjs --stack=node            # no extra toolchain needed
node tools\stack-acceptance.mjs --stack=maven           # needs JDK 17 + Maven on PATH
node tools\stack-acceptance.mjs --stack=node --keep     # keep the temp workspace to inspect
node tools\stack-acceptance.mjs --stack=node --out=docs/evidence/node.json
```

Verified 2026-10-05, both exit code 0:

```text
node:  13 passed, 0 failed
maven: 13 passed, 0 failed
```

The 13 checks per stack, in order: `open`, `scan`, `symbol`, `checkpoint`, `build`,
`tests-fail`, `diagnose`, `diagnose-locate`, `tests-pass`, `review`, `rollback`,
`rollback-real`, `close`.

Two of them are worth watching, because they are the ones a half-working implementation
cannot fake:

* `diagnose-locate` — the extracted location must be a real workspace file, not a class inside
  the test framework (this failed for real on Maven and was fixed).
* `rollback-real` — after `rollback_checkpoint`, the suite must fail again with the same
  failure. A rollback that silently did nothing cannot pass this. It exists because the first
  restore implementation (reverse-applying a patch) passed its unit tests and failed here.

### The Python stack is a staged driver

`tools/v1-acceptance.mjs` runs the same kind of loop against a **real** project
(default `D:\Projects\devpilot-demo`, override with `DEVPILOT_ACCEPTANCE_TARGET=<dir>`), but it
is staged on purpose, because acceptance items 6–13 include an edit by a human/agent in the
middle and the driver must not invent one:

```powershell
node tools\v1-acceptance.mjs --stage=recon      # items 1-6    handshake, open, scan, run command, symbols, impact, checkpoint
#   -> now inject a defect in the target project (or use the one already there)
node tools\v1-acceptance.mjs --stage=verify     # items 7-8    the failing suite + structured diagnosis
#   -> now fix the defect for real
node tools\v1-acceptance.mjs --stage=post       # items 9-12   passing suite, run_project, diff review, pre-existing changes
node tools\v1-acceptance.mjs --stage=rollback   # item 13      real rollback; your own uncommitted work survives
```

Each stage is a fresh server process and re-opens the workspace first (`WORKSPACE_NOT_OPEN` is
the session-level prerequisite of every tool, and it is not inherited across processes).
The driver expects the target to be a real Git repository with a **pre-existing uncommitted
change** (the demo carries one on `README.md`) — items 12, 13.5 and 13.6 exist to prove DevPilot
never absorbs or destroys it. Reports land in `docs/evidence/*.json` when `--out` is given.

---

## 3. Channel 3 — the real channel: inside DeepSeek Harness

This is the only channel that proves the product as the user experiences it. The 19 tools appear
as `mcp__devpilot__*`; you drive them in natural language. Wiring is described in
[DSH-INTEGRATION.md](DSH-INTEGRATION.md).

```text
1.  "用 devpilot 打开 D:\Projects\<你的项目>"
    expect: workspace id, detected profile (languages / projectType / entrypoints / markers),
            git branch@head + dirty flag, index state, and a gitNotice if the tree is dirty.

2.  "扫描它，告诉我怎么运行、怎么测试"
    expect: languages, top-level layout, candidates.test and candidates.run as concrete
            command lines, buildSystem, testFramework. This answers "how does this project run"
            from the scan alone — acceptance item 4.

3.  "给我这个项目的地图"
    expect: entrypoints -> modules -> notable symbols, with dependsOn/usedBy edges.

4.  "X 定义在哪？谁在用 X？"
    expect: path:line, kind, and reference sites; the payload carries engine / extractor /
            confidence — heuristic results are labelled, never dressed up as a compiler.

5.  "我要改 X，会影响什么？"
    expect: affectedFiles each with a reason, relatedTests, riskLevel, and a confidence.

6.  "跑测试"
    expect: structured counts (total/passed/failed/skipped) + failure list with file:line.
    A failing suite returns success:false, code TEST_FAILED, and the numbers live in
    error.details — see §6.

7.  "诊断一下这个失败"
    expect: category, confidence, location, a few evidence lines, suspect files, and a hint.
            UNKNOWN is a legal answer; invented certainty is not.

8.  "我改了哪些文件？风险如何？"
    expect: per-file add/delete counts and a risk level with reasons, patch artifact path,
            and pre-existing user changes listed separately from DevPilot's own edits.
```

Red flags — do not accept these as success:

* a passing status with `total: 0` (the runner's summary was not understood → `status: unknown`
  must never be reported as passed);
* a diagnosis whose `location` points inside the test framework rather than the workspace;
* `review_diff` listing a file you did not touch and did not expect;
* any tool result that silently returns 0 rows instead of an explicit error.

### After you rebuild, reload the entry

The stdio server is **spawned when the plugin entry is activated**, so `npm run build` alone does
not reach a live DSH session — the running child keeps the build it started with. Rebuilding `dist`
is therefore not enough; the entry has to be disposed and respawned (detach the `- insert:` row,
confirm the child is gone, put it back verbatim). The exact two-step procedure, with the observed
`pid` transition and the reason the two writes must be separate, is in
[DSH-INTEGRATION.md](DSH-INTEGRATION.md) § *Reloading the entry after a rebuild*. A fresh
child also has **no workspace in memory** — run `open_workspace` again before any other call.

---

## 4. Channel 4 — the CLI, with no MCP in the path

Use this to decide whether a fault is DevPilot's or the bridge's: the CLI calls the same
`WorkspaceManager` / `runTests` / `diagnoseJob` code, without stdio, MCP or DSH.

```powershell
cd D:\tools\DevPilot-MCP
node dist\index.js status   D:\Projects\devpilot-demo            # profile + git snapshot
node dist\index.js scan     D:\Projects\devpilot-demo --force     # rebuild .devpilot/cache/project.json
node dist\index.js test     D:\Projects\devpilot-demo             # same work as run_tests
node dist\index.js test     D:\Projects\devpilot-demo --file=tests/test_service.py --json
node dist\index.js diagnose D:\Projects\devpilot-demo             # classify the last failed job
node dist\index.js diagnose D:\Projects\devpilot-demo --log=test-20261005-000000-abcd.log
node dist\index.js doctor   --verbose
node dist\index.js init     D:\Projects\new-project --write-gitignore
node dist\index.js serve                                          # exactly what DSH spawns
node dist\index.js version
```

Exit codes: `0` success, `1` tests failed / no tests collected / run unverified, `2` a typed
DevPilot error printed as `devpilot <CODE>: message` with a hint — never a stack trace.

If the CLI is green and the `mcp__devpilot__*` call is not, the problem is in the bridge
(reload the entry, §3). If both fail the same way, it is a product bug: capture the command,
the envelope and the log file under `<workspace>\.devpilot\logs\`.

---

## 5. The 13 acceptance items, and where each is verified

| # | Acceptance item | Channel |
| --- | --- | --- |
| 1 | connect DevPilot to DeepSeek Harness | 3 (19 `mcp__devpilot__*` tools + resources) |
| 2 | pick a Git project | 2 / 3 (`open_workspace`) |
| 3 | the agent scans the project itself | 2 / 3 (`scan_project`) |
| 4 | "how do I run this project?" answered | 2 / 3 (`candidates.run`, plus a real `run_project`) |
| 5 | "where is X used?" answered | 2 / 3 (`find_symbol`, `find_references`) |
| 6 | the agent fixes a bug | 3 (agent edit) + 2 (injected defect) |
| 7 | the agent runs the tests | 2 / 3 (`run_tests`) |
| 8 | structured diagnosis of a failure | 2 / 3 (`diagnose_failure`) |
| 9 | the agent fixes it | 3 (agent edit) |
| 10 | tests pass | 2 / 3 (`run_tests`) |
| 11 | "which files changed?" answered | 2 / 3 (`review_diff`) |
| 12 | the diff is auditable | 2 / 3 (`review_diff` risk + patch artifact) |
| 13 | nothing destroys your Git state | 2 (`rollback-real`, pre-existing change survives) / 3 |

---

## 6. Reading a failure

A failed run or a failed test is an **error envelope**, and the structured payload lives in
`error.details`, not in `data`. Reading only `data` makes a well-parsed failure look like
"the parser is broken".

```json
{ "success": false,
  "error": { "code": "TEST_FAILED", "message": "2 of 5 tests failed",
             "details": { "status": "failed", "total": 5, "passed": 3, "failed": 2,
                          "failures": [ { "name": "...", "path": "tests/test_service.py", "line": 13 } ] },
             "hint": "..." } }
```

Codes an agent can branch on:

```text
WORKSPACE_NOT_OPEN      no workspace in this server process — call open_workspace first
WORKSPACE_NOT_FOUND     the path is not an existing project directory (resolution layer)
FILE_NOT_FOUND          a referenced file or log does not exist
COMMAND_NOT_ALLOWED     the command policy denied it (deny-list / not allow-listed)
COMMAND_TIMEOUT         the process hit max_command_seconds and was terminated
BUILD_FAILED            the build tool returned non-zero
TEST_FAILED             tests ran and some failed (details carries the list)
INDEX_FAILED            the language index could not be built
GIT_DIRTY               the requested git operation refuses to run on a dirty tree
UNSUPPORTED_PROJECT     no rule matched this project layout
PATH_OUTSIDE_WORKSPACE  a path argument escapes the workspace root
```

Known traps, each of which produced a wrong conclusion at least once:

* `mvn -q` prints no `Tests run:` line on success, which once produced `total: 0` reported as
  *passed*. DevPilot runs Maven with `-B`; if you see `total: 0` with `status: passed`, treat it
  as a bug report, not a green run.
* `git status --short` can report a file as modified when its content equals `HEAD`
  (racily-clean false positive). Confirm with `git diff --stat`.
* The `path` argument is overloaded: most tools declare it as the workspace selector
  (`workspacePathSchema`), while `find_symbol` / `find_references` declare it as a result filter
  (`pathFilterSchema`). Passing an outside path to a *selector* tool therefore fails at the
  resolution layer with `WORKSPACE_NOT_FOUND` before that tool's own
  `PATH_OUTSIDE_WORKSPACE` check could fire — the error code tells you which layer answered.

---

## 7. What V1 does **not** claim

Stated here so that a green run is not read as more than it is:

* **Gradle** — rule-level support only; no real-machine acceptance evidence was collected
  (the Java acceptance ran on Maven + JDK 17). Treat Gradle as unverified.
* **benchmark / performance_compare** — not part of V1 and not among the 19 tools. There is no
  before/after benchmark tool yet.
* **dependency_audit** — the `outdated` / `vulnerable` sections need network access and are
  offline by default; offline they return empty **and say so** rather than implying a clean bill.
* **Languages beyond Python / Java / TypeScript / JavaScript** — files with no parser are skipped
  and reported in `warnings` (`no parser in this build`). A symbol search that finds nothing in
  C++, Go or Rust is expected, not a defect.
* **Windows-first** — everything here was verified on Windows 11 + PowerShell. Linux/macOS paths
  are written cross-platform but were not acceptance-tested.
* **Security model is defence in depth, not a sandbox** — workspace confinement, a command
  deny-list, change budgets, secret redaction at the envelope boundary and protected files. It
  is not an OS-level jail.

## 8. One rule for working on this repo itself

Never run a language toolchain **inside** `fixtures/` (pytest, npm, maven): it drops
`__pycache__/`, `.pytest_cache/`, `node_modules/` and `target/` into a version-controlled tree, and
`git rm --cached` does not clean up nested variants. Copy the fixture to a temp directory first —
which is exactly what `tools/stack-acceptance.mjs` does.
