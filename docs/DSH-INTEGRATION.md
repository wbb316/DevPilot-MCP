# Wiring DevPilot MCP into DeepSeek Harness

Phase 10 deliverable, and the first item of the V1 acceptance list.

The contract below is **not guesswork**: it was read out of the DSH build that is installed on this
machine (`D:\dsh\dsh-desktop\resources\app.asar`), from DSH's own MCP client package
`@deepseek-ai/dsh-mcp-client@0.2.0-rc.2` (`dsh/node_modules/@deepseek-ai/dsh-mcp-client/`), whose
`README.zh.md` is the maintainer-facing reference for exactly this task. `tools/asar-inspect.mjs`
reads files out of that archive without unpacking 121 MB, so the mapping can be re-verified whenever
DSH is upgraded.

## What DSH expects

DSH does not read a `mcpServers` block. Each MCP server is one **plugin entry** in a profile, using
DSH's own MCP client bridge:

```yaml
- id: mcp-devpilot
  name: '@deepseek-ai/dsh-mcp-client'
  config:
    serverName: devpilot
    transport: stdio
    command: node
    args: ['D:\tools\DevPilot-MCP\dist\index.js', 'serve']
    cwd: 'D:\tools\DevPilot-MCP'
    toolCallTimeoutMs: 300000
```

| Field | Meaning | DevPilot value |
| --- | --- | --- |
| `transport` | `stdio` or `streamable-http` | `stdio` — DevPilot is a local process |
| `serverName` | namespace of the tool names, `[A-Za-z0-9_-]{1,32}`, unique per scope | `devpilot` |
| `command` / `args` / `cwd` / `env` | stdio executable, argv, working directory, extra env merged over a scrubbed environment | `node`, `dist\index.js serve`, the DevPilot checkout |
| `toolCallTimeoutMs` | per `tools/call` timeout | raise it: `doctor` legitimately takes tens of seconds and `run_tests` runs a real suite, so the default 60 s is too tight |
| `failOnStartupError` | fail plugin activation if the first connect/tool sync fails | `true` while wiring (a silent half-broken server is worse than a loud one) |
| `reconnect.*` | exponential backoff, 10 attempts by default | leave default |

Consequences to remember:

- Tool names reach the model namespaced: `mcp__devpilot__open_workspace`,
  `mcp__devpilot__scan_project`, … Any instruction or preset that refers to DevPilot tools must use
  those names.
- DSH performs a **temporary probe process** before starting the real server, so `serve` must exit
  cleanly and quickly when its stdin closes. DevPilot's stdio server already terminates on stdin
  EOF; this is a property the gate must keep exercising.
- stdout is the JSON-RPC channel. DevPilot writes logs and warnings to stderr only, which is why
  `src/log/logger.ts` mirrors to stderr and never to stdout.
- Server instructions are injected as literal text into the recorded system prompt, and MCP prompt
  templates are not supported — DevPilot relies on tool descriptions and envelopes instead.

## Steps

1. Build: `npm run build` (already the `pretest` step) → `dist/index.js`.
2. Smoke the exact command DSH will run, from an empty stdin:
   `node dist\index.js serve` must answer an `initialize` + `tools/list` handshake and exit on EOF.
   Covered by `tests/integration/mcp-stdio.test.ts` (it drives a real SDK client over stdio).
3. Add the plugin entry above to the DSH profile that should own DevPilot, then restart / reload
   that profile and confirm the tools appear in the model's tool list.
4. Run the V1 acceptance script (docs/ROADMAP.md Phase 10) against a real project.

## V1 acceptance script → who answers it

| # | Step | DevPilot answer |
| --- | --- | --- |
| 1 | connected to DSH | `tools/list` returns the 18 tools under `mcp__devpilot__*` |
| 2 | pick a real Git project | `open_workspace` |
| 3 | scan it | `scan_project` |
| 4 | "how do I run this project?" | `scan_project` → `profile.candidates.run` / `get_project_map` entrypoints |
| 5 | "where is LoginService used?" | `find_symbol` + `find_references` |
| 6 | fix a real bug | `impact_analysis` → `create_checkpoint` (content snapshot) → edit |
| 7 | run tests | `run_tests` |
| 8 | structured failures | `diagnose_failure` |
| 9-10 | repair, re-run | `run_tests` again |
| 11-12 | which files changed, auditable diff | `review_diff` (`preExistingChanges`, `highRisk`, `patch` artifact) |
| 13 | the user's own uncommitted work survives | baseline captured at first `open_workspace`; `rollback_checkpoint` never touches the index and never deletes files that appeared after the checkpoint |

## Provenance / re-verification

```powershell
cd D:\tools\DevPilot-MCP
node tools\asar-inspect.mjs list 'D:\dsh\dsh-desktop\resources\app.asar' 'dsh-mcp-client'
node tools\asar-inspect.mjs read 'D:\dsh\dsh-desktop\resources\app.asar' 'dsh/node_modules/@deepseek-ai/dsh-mcp-client/README.zh.md' --head=140
```

The reader locates the directory header instead of assuming a fixed offset — during Phase 10 the
first version assumed one and silently returned content from the *wrong file*, which is exactly the
class of bug that makes a provenance tool worse than no tool.
