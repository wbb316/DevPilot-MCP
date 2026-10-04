# DevPilot MCP — Technical Architecture

> A local software engineering runtime for AI coding agents.

## 1. Position in the system

```text
        DeepSeek Harness / Codex / any MCP client
                        │  MCP (stdio, JSON-RPC 2.0)
                        ▼
        ┌───────────────────────────────────────────┐
        │              DevPilot MCP                 │
        │   tools · policies · parsers · evidence   │
        └───────────────────────────────────────────┘
             │              │               │
        Workspace       Code Intel        Runner
        Manager                          build/test/run
             │              │               │
        Filesystem      AST+search       Processes
        Git             imports/refs     benchmarks
             └──────────────┼───────────────┘
                            ▼
                 Workspace-local cache
              <workspace>\.devpilot\ (db/cache/logs)
```

DevPilot owns **no** model and calls **no** LLM. It is deterministic infrastructure:
given the same repository state it must return the same structured facts.

## 2. Layering

| Layer | Modules | Responsibility | Must not |
| --- | --- | --- | --- |
| L0 Transport | `server/stdio`, `server/mcp-server` | MCP handshake, tool registration, JSON-RPC transports | contain domain logic |
| L1 Tool | `server/tool-registry`, `tools/*` | validate args (zod), enforce permission, call services, wrap result envelope | touch `fs`/`child_process` directly |
| L2 Domain | `workspace/`, `code/`, `runner/`, `diagnose/`, `git/` | the actual engineering capabilities | know about MCP types |
| L3 Adapter | `runner/*-adapter`, `code/lang/*`, `diagnose/*-parser` | wrap external tools (maven, pytest, node, tree-sitter, rg) | leak raw output upward |
| L4 Infrastructure | `storage/`, `config/`, `security/`, `errors/`, `log/` | cache, config, policy, error model, logging | depend on L1/L2 |

Dependency direction is strictly downward: L1 → L2 → L3 → L4. Adapters are resolved
through small interfaces so a new language/build system is a new adapter, not an edit
to the runner core.

## 3. Module map (final shape)

```text
src/
├── index.ts                     # bin entry: devpilot <command>
├── cli/                         # human-facing CLI (init/scan/status/doctor/serve)
├── server/
│   ├── mcp-server.ts            # McpServer assembly, capability wiring
│   ├── stdio.ts                 # stdio transport bootstrap
│   ├── tool-registry.ts         # ToolDefinition registry + registration
│   └── context.ts               # ServerContext (DI root: services, session state)
├── tools/                       # one file per MCP tool (thin, schema + policy + service call)
├── workspace/
│   ├── workspace-manager.ts     # lifecycle, registry, active workspace
│   ├── project-detector.ts      # markers → languages / build / test / framework
│   ├── project-scanner.ts       # walk + detect + profile (Phase 2)
│   ├── project-map.ts           # module/entrypoint graph view (Phase 2)
│   └── file-walker.ts           # ignore-aware walker (no external glob dep)
├── code/
│   ├── symbol-index.ts          # per-language symbol extraction + store
│   ├── references.ts            # reference search (AST-first, text fallback)
│   ├── dependency-graph.ts      # import/require edges
│   ├── impact-analysis.ts       # heuristic impact + confidence
│   └── lang/{typescript,python,java,generic}.ts
├── runner/
│   ├── process-runner.ts        # spawn/timeout/capture/limit (single gate to processes)
│   ├── build-runner.ts
│   ├── test-runner.ts
│   ├── benchmark-runner.ts
│   └── adapters/{maven,gradle,python,node}.ts
├── diagnose/
│   ├── error-parser.ts          # dispatcher
│   ├── java-parser.ts
│   ├── python-parser.ts
│   ├── node-parser.ts
│   └── catalog.ts               # categories + signatures (OOM, NPE, import, ...)
├── git/
│   ├── git-manager.ts           # read-only-ish git operations
│   ├── diff-analyzer.ts         # structured diff + risk heuristics
│   └── checkpoint.ts            # create/restore checkpoints safely
├── environment/doctor.ts        # toolchain + conflict detection
├── security/
│   ├── path-policy.ts           # workspace confinement, sensitive files
│   ├── command-policy.ts        # allow/deny, dangerous command detection
│   ├── permission.ts            # READ_ONLY / SAFE_WRITE / EXECUTE / FULL
│   └── limits.ts                # default limits + per-call overrides
├── storage/
│   ├── sqlite.ts                # workspace DB (Phase 3+)
│   ├── json-store.ts            # atomic JSON state (no DB needed yet)
│   ├── paths.ts                 # devpilot home + <workspace>\.devpilot layout
│   └── migrations.ts
├── config/{config-schema.ts,config-loader.ts}
├── errors/{error-codes.ts,devpilot-error.ts,envelope.ts}
├── log/logger.ts
└── types/                       # shared domain types (see DATA-MODEL.md)
```

## 4. Key design decisions

### 4.1 TypeScript + Node.js
DevPilot is agent tooling: MCP, subprocess orchestration, JSON Schema, cross-platform
CLI. Java/C++ projects are *targets*, not the implementation language.

### 4.2 Structured envelope, never raw logs
Every tool returns `{success, summary, data, artifacts?, warnings?}`. Full output goes
to `.devpilot/logs/*.log`; the agent gets parsed facts plus an artifact pointer.
Adapters must shorten before returning: the runner stores `maxStdout/maxStderr` bytes,
parsers extract counts/locations/stack frames.

### 4.3 Evidence over opinion
Tools never claim "the fix works". They report exit codes, test counts, timings,
memory, diff risk and let the calling agent conclude.

### 4.4 Search backends with graceful degradation
`find_symbol` prefers AST (Tree-sitter grammars available for Python/Java/TS/JS).
When a grammar or the native module is unavailable, DevPilot degrades to a
word-boundary text index built in-process and marks `confidence: "low"` plus
`engine: "text"` in the result — accuracy is never faked.

### 4.5 Processes have exactly one gate
All command execution flows through `runner/process-runner.ts`:
`cwd` must be inside the workspace, the command must pass `command-policy`,
timeout/output caps are mandatory, and every invocation is logged with a job id.
No other module may import `child_process`.

### 4.6 Cache is workspace-local and incremental
`<workspace>\.devpilot\` holds the index DB. Incremental rule: `mtime + size` unchanged
⇒ skip; changed ⇒ re-parse only that file (and re-link its edges). A full scan of a
5k-file repo is the worst case, not the common case. Vector databases are explicitly
out of scope for V1 (AST + symbols + references + ripgrep-style search first).

### 4.7 Git is read-mostly and never destructive
`git status/diff/log/branch/rev-parse` are safe. Checkpoints are implemented as
patch/ref bookkeeping under `.devpilot/checkpoints` plus an internal ref, so user
working-tree state is never stashed away behind their back and `reset --hard` is never
issued.

### 4.8 Deterministic command inference, no LLM
Build/test/run commands come from a rule table keyed on detected markers
(`pom.xml` → Maven, `package.json` → npm script sniffing, `pyproject.toml`/`tests/` →
pytest, `train.py` → python entrypoint). Config can override via `.devpilot/config.yml`.

## 5. Request flow (one tool call)

```text
MCP tools/call
  → tool-registry: lookup definition
  → permission check (server permission level vs tool requirement)
  → zod arg validation → typed input
  → policy: path confinement / command policy / limits merged with workspace config
  → domain service (may consult cache or spawn via process-runner)
  → adapter parse → domain result
  → envelope.ok(...) / envelope.fail(DevPilotError)
  → MCP result: content[text=JSON] + structuredContent (+ isError)
```

Every step can raise a typed `DevPilotError` with a stable code; unexpected throws are
normalised to `INTERNAL_ERROR` with the stack only in the log file, never in the reply.

## 6. Workspace as the security boundary

Everything the agent can touch is derived from a workspace root resolved once at
`open_workspace`. Tools never accept an absolute path that is not re-validated through
`path-policy.resolveInsideWorkspace()`. Symlink escapes are resolved with `realpath`
before the containment check. See [WORKSPACE-LIFECYCLE.md](WORKSPACE-LIFECYCLE.md).

## 7. Extension points

| Extension | Contract |
| --- | --- |
| New language | implement `LanguageAdapter` (`detect`, `extractSymbols`, `extractImports`, `parseFailure`) and register it |
| New build system | implement `BuildAdapter` (`detect`, `buildCommand`, `parseBuildOutput`) |
| New test framework | implement `TestAdapter` (`detect`, `testCommand`, `parseOutput`) |
| New diagnosis rule | add an entry in `diagnose/catalog.ts` (pattern → category → extraction) |
| New MCP tool | add `src/tools/<name>.ts` exporting a `ToolDefinition`; server registers it automatically |

## 8. Non-goals (V1)

Cloud accounts, team collaboration, web UI, vector DB, bundled model, plugin
marketplace, remote runners, "all languages", becoming an editor.
