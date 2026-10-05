# DevPilot MCP

A local software engineering runtime for AI coding agents.

DevPilot gives AI agents the ability to understand, run, test, diagnose, review, and
validate real software projects through the Model Context Protocol.

```text
Understand → Analyze → Modify → Build → Run → Test → Diagnose → Review → Benchmark → Commit / Rollback
```

**Keywords:** MCP · AI Coding Agent · Software Engineering · Local Development · Code Intelligence · Testing · Git · Benchmark

---

## What DevPilot is

DevPilot is the **execution and verification layer** an agent calls between "I think this
fix is right" and "here is the evidence". It provides:

| Capability | Meaning |
| --- | --- |
| Accurate engineering context | project type, entrypoints, symbols, references, dependency/impact graph |
| Safe execution environment | workspace-scoped paths, command policy, timeouts, output caps |
| Reliable verification | build, test, run, failure diagnosis, benchmark, structured evidence |
| Version control | checkpoints, diff review, guarded rollback that never destroys user work |

## What DevPilot is not

Not an IDE, not a VS Code/Cursor clone, not a chat UI, not a Copilot clone, not a
code generator, not a cloud service, not "another filesystem MCP".

```text
Filesystem MCP : read file / write file / list directory
GitHub MCP     : remote repo / issue / PR / Actions / remote metadata
DevPilot MCP   : understand project / analyze impact / run / test / diagnose / review / rollback   (local)
```

DevPilot is an **agent backend**, never an agent frontend. It does not replace the LLM's
reasoning: it supplies context, safety and evidence, and it returns *structured* results
instead of dumping 10,000 log lines on the agent.

---

## Path boundaries (hard rule)

```text
DevPilot itself          D:\tools\DevPilot-MCP          ← source, tests, docs, this Git repo
managed target project   D:\Projects\<project>          ← opened as a Workspace only
per-workspace data       <workspace>\.devpilot\         ← config / cache / logs / checkpoints / db
```

The three are never mixed:

* DevPilot source code is **never** copied into a target project.
* `src/server`, `src/workspace`, `src/runner` are **never** created inside a target project.
* `.devpilot/` holds only that workspace's metadata, cache, index, logs and checkpoints.

---

## Requirements

* Node.js >= 20 (developed on 22.x)
* Git on `PATH` (required for checkpoint / diff / rollback)
* Optional per language: Python + pytest, Maven/Gradle + JDK, npm/pnpm

## Quick start

```powershell
cd D:\tools\DevPilot-MCP
npm install
npm run build
npm test
npm run dev -- serve        # start the MCP server on stdio
```

CLI (the MCP server is the product; the CLI is for humans, and for isolating a fault from the bridge):

```text
devpilot init [dir]        create <dir>\.devpilot\ (--write-gitignore to also edit .gitignore)
devpilot status [dir]      profile + git snapshot (--json)
devpilot scan [dir]        scan into .devpilot/cache/project.json (--force, --json)
devpilot test [dir]        run the detected suite, printed as parsed counts
                           (--filter=<expr>, --file=<path>, --fail-fast, --json)
devpilot diagnose [dir]    classify the last failed job (--job=<id>, --log=<file>, --max-evidence=<n>)
devpilot doctor [dir]      report the local toolchain; never installs anything (--verbose, --json)
devpilot serve             run the MCP server on stdio (what DeepSeek Harness spawns)
devpilot version | help
```

Exit codes: `0` success · `1` tests failed / none collected / run unverified · `2` a typed
DevPilot error (`devpilot <CODE>: message`, never a stack trace).

## Tool set

19 tools, each returning the same envelope:

```text
workspace   open_workspace   get_workspace_status   close_workspace
understand  scan_project     get_project_map        find_symbol        find_references
analyze     impact_analysis  dependency_audit       doctor
execute     build_project    run_project            run_tests          run_test
diagnose    diagnose_failure
git         get_git_status   create_checkpoint      rollback_checkpoint  review_diff
```

10 reliable tools beat 40 half-finished ones. Gradle support is secondary; Python,
Maven, Node come first. Everything returns one stable envelope:

```json
{
  "success": true,
  "summary": "2 test failures found",
  "data": { "total": 42, "passed": 40, "failed": 2 },
  "artifacts": { "log": ".devpilot/logs/test-20250101-120000.log" },
  "warnings": []
}
```

Failures return `{ "success": false, "error": { "code": "TEST_FAILED", "message": "...", "details": {}, "hint": "..." } }`
with codes an agent can branch on (`WORKSPACE_NOT_OPEN`, `COMMAND_TIMEOUT`, `BUILD_FAILED`, ...).

## Design principles

1. **Agent oriented** — optimize for an agent calling the tool correctly, not for human CLI comfort.
2. **Local first** — no cloud, no account, code/Git/environment data never uploaded.
3. **Safe by default** — workspace-restricted paths, command allow/deny policy, timeouts, output limits, file-change limits.
4. **Reversible** — checkpoints, diffs, guarded rollback; never `git reset --hard` over user work.
5. **Evidence based** — build output, tests, diff and logs instead of "should work".
6. **No wheel reinvention** — Git, Maven, Gradle, pytest, npm are driven as backends. The language
   parsers sit behind a `LanguageParser` seam, so Tree-sitter or ripgrep can replace today's
   lexical extractors without changing a single tool contract.

## Documentation

| Doc | Content |
| --- | --- |
| [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) | layering, modules, adapters, extension points, key decisions |
| [docs/DATA-MODEL.md](docs/DATA-MODEL.md) | core entities, TypeScript types, SQLite schema, incremental indexing |
| [docs/TOOLS.md](docs/TOOLS.md) | MCP tool schemas, envelopes, error codes, permission levels |
| [docs/WORKSPACE-LIFECYCLE.md](docs/WORKSPACE-LIFECYCLE.md) | workspace state machine, `.devpilot` layout, concurrency, Git safety |
| [docs/ROADMAP.md](docs/ROADMAP.md) | Phase 1–10 plan, per-phase gates, V1 acceptance criteria |
| [docs/GATES.md](docs/GATES.md) | the gate log: real commands, real output, and the mistakes that were corrected |
| [docs/DSH-INTEGRATION.md](docs/DSH-INTEGRATION.md) | wiring into DeepSeek Harness, and how to reload the entry after a rebuild |
| [docs/VERIFY.md](docs/VERIFY.md) | how to verify DevPilot yourself: four channels, expected output, failure codes, boundaries |

## Status

**All ten phases are implemented and gated; V1 is usable, not just startable.** Each phase was
closed only after a real build and test run passed — [docs/GATES.md](docs/GATES.md) records the
commands, the observed output and the corrections, including one restore mechanism that unit tests
blessed and an end-to-end run proved wrong.

```text
tsc -p tsconfig.json --noEmit   clean (strict); src and tests are both typechecked
vitest run                      46 test files / 365 tests green (~26 s)      (2026-10-05)
npm run smoke                   SMOKE PASS, self-hosting: 201 files scanned, 3,945 symbols,
                                13,312 refs; repeated call parsed=0 reused=172
stack acceptance                node 13/13 and maven 13/13, exit 0 each; the Python loop was also
                                run on a real Git project through the DeepSeek Harness bridge
doctor                          Git, Node, Python+pytest, JDK 17 + Maven all detected on this machine
```

Implemented: strict TS project · typed error model + result envelope · DevPilot home and
per-workspace `.devpilot\` layout · zod-validated `config.yml` · security layer (workspace
confinement, command policy, change budgets, secret redaction, protected files) · workspace manager
(open / status / close, registry, project detection, git snapshot) · ignore-aware file walker
(own `.gitignore` engine) · project scanner + project map · symbol index (Python / Java / TS / JS
lexical extractors behind a `LanguageParser` seam, per-file `mtime+size` incrementality, SQLite
store with a JSON fallback) · process runner with timeouts and output caps · build runner · run
runner · test runner (pytest, unittest, Surefire/Gradle, jest, vitest, node:test) with structured
parsing · failure diagnosis · git diff review with risk classification · checkpoints and guarded
rollback · impact analysis · environment doctor · dependency audit · MCP server with 19 tools ·
CLI · fixtures and acceptance drivers under `tools/`.

Not in V1: benchmark, semantic/embedding search, Gradle real-machine acceptance, non-Windows
acceptance. [docs/VERIFY.md](docs/VERIFY.md) §7 lists the boundaries explicitly, so a green run is
never read as more than it is.

## License

MIT — see [LICENSE](LICENSE).
