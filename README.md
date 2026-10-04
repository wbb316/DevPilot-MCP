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

CLI:

```text
devpilot init [dir]     initialize .devpilot/ in a workspace (config.yml, cache, logs, checkpoints)
devpilot status [dir]   workspace status: type, languages, git state, index state
devpilot scan [dir]     scan + index the project (Phase 2+)
devpilot doctor         environment diagnosis (Phase 9)
devpilot serve          run the MCP server (stdio)
devpilot version        print version
```

## V1 tool set

```text
open_workspace   get_workspace_status   close_workspace
scan_project     get_project_map
find_symbol      find_references
run_project      run_tests
diagnose_failure review_diff
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
with codes an agent can branch on (`WORKSPACE_NOT_OPEN`, `COMMAND_TIMEOUT`, `PATH_OUTSIDE_WORKSPACE`, ...).

## Design principles

1. **Agent oriented** — optimize for an agent calling the tool correctly, not for human CLI comfort.
2. **Local first** — no cloud, no account, code/Git/environment data never uploaded.
3. **Safe by default** — workspace-restricted paths, command allow/deny policy, timeouts, output limits, file-change limits.
4. **Reversible** — checkpoints, diffs, guarded rollback; never `git reset --hard` over user work.
5. **Evidence based** — build output, tests, benchmark, diff and logs instead of "should work".
6. **No wheel reinvention** — Git, Tree-sitter, ripgrep, Maven, Gradle, pytest, npm are used as backends.

## Documentation

| Doc | Content |
| --- | --- |
| [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) | layering, modules, adapters, extension points, key decisions |
| [docs/DATA-MODEL.md](docs/DATA-MODEL.md) | core entities, TypeScript types, SQLite schema, incremental indexing |
| [docs/TOOLS.md](docs/TOOLS.md) | MCP tool schemas, envelopes, error codes, permission levels |
| [docs/WORKSPACE-LIFECYCLE.md](docs/WORKSPACE-LIFECYCLE.md) | workspace state machine, `.devpilot` layout, concurrency, Git safety |
| [docs/ROADMAP.md](docs/ROADMAP.md) | Phase 1–10 plan, per-phase gates, V1 acceptance criteria |

## Status

**Phase 1 — project skeleton, MCP server, workspace lifecycle: gate passed.**

```text
npm run build   clean (TypeScript strict)
npm test        10 test files / 83 tests green, incl. a real MCP stdio integration test
devpilot serve  an MCP client initializes, lists 3 tools, opens/closes a workspace
```

Implemented so far: strict TS project · typed error model + result envelope · DevPilot
home + per-workspace `.devpilot\` layout with atomic JSON state · zod-validated
`config.yml` · path confinement, sensitive-file classification, limits, permission levels ·
workspace manager (open / status / close, registry, project detection, git snapshot) ·
MCP server with tool registry (`open_workspace`, `get_workspace_status`,
`close_workspace`) · CLI (`init`, `status`, `serve`, `version`) · three fixture projects.

Next: Phase 2 (`scan_project`, `get_project_map`). See
[docs/ROADMAP.md](docs/ROADMAP.md) for per-phase gates.

## License

MIT — see [LICENSE](LICENSE).
