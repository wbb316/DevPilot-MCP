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
# `insert:` is required. A bare `- id: ...` row only patches a row that an already-loaded
# bundle inserted, so a new plugin declared that way is a silent no-op — the first attempt
# on this machine looked like "the profile needs a restart" for exactly that reason.
- insert:
    - id: mcp-devpilot
      name: '@deepseek-ai/dsh-mcp-client'
      config:
        serverName: devpilot
        transport: stdio
        command: node
        args: ['D:\tools\DevPilot-MCP\dist\index.js', 'serve']
        cwd: 'D:\tools\DevPilot-MCP'
        toolCallTimeoutMs: 300000
        failOnStartupError: true
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
3. Add the plugin entry above to the DSH profile that should own DevPilot, as an `insert:` row.
   DSH's `@deepseek-ai/dsh-hmr` row reloads profile config, so no restart was needed on this
   machine: the entry, the spawned server process and the model-facing tools all appeared in the
   running session (verified 2026-10-05). Confirm with the three signals in "Live wiring" below.
4. Run the V1 acceptance script (docs/ROADMAP.md Phase 10) against a real project — and also run
   the loop by hand through the bridge, because that is the path the agent actually takes.

## V1 acceptance script → who answers it

| # | Step | DevPilot answer |
| --- | --- | --- |
| 1 | connected to DSH | `tools/list` returns the 19 tools under `mcp__devpilot__*` |
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

## Acceptance run (2026-10-04)

`tools/v1-acceptance.mjs` drives the real server over stdio in four stages against
`D:\Projects\devpilot-demo` (src-layout Python project, pytest suite, one deliberate bug, one
uncommitted user edit):

| Stage | Items | Result |
| --- | --- | --- |
| `recon` | 1–6 | 8/8 — 19 tools, workspace opened, scan answers "how do I run this", symbols/references/impact found, checkpoint created |
| `verify` | 7–8 | 2/2 — failing suite as structured counts, then category + location + evidence |
| `post` | 9–12 | 5/5 — suite passes, `run_project` really starts the project, diff reviewed with risk and patch artifact, the user's own edit listed separately |
| `rollback` | 13 | 7/7 — the fix was undone for real (suite fails again), the user's note survived, the index was never modified |

Raw envelopes: `docs/evidence/recon.json`, `verify.json`, `post.json`, `rollback.json`.

## Live wiring (2026-10-05)

Item 1 of the table above used to be verified only indirectly (the exact `command` / `args` / `cwd`,
handshake, `tools/list`, clean exit on EOF, plus the entry parsing as YAML). It is now verified
against the running harness at three levels of increasing strength:

| Signal | How it was read | Observed |
| --- | --- | --- |
| loader entry | host Config inspect, filtered by plugin package name | `include:mcp-devpilot`, patchId `mcp-devpilot`, status `schema` |
| server process | `Win32_Process` filtered to `*DevPilot-MCP*` | `pid=1672 node D:\tools\DevPilot-MCP\dist\index.js serve` |
| model tool surface | this agent's own callable tool list | 19 `mcp__devpilot__*` tools + the `devpilot` MCP resource server |

Two corrections came out of that session and are reflected above: the entry must be an `insert:`
row, and no DSH restart is needed (HMR reloads the profile config).

The acceptance loop then ran **through the bridge** rather than through `tools/v1-acceptance.mjs`:
`scan_project` → `find_symbol`/`find_references` → failing suite as structured counts → `diagnose_failure`
(category, location, evidence) → `create_checkpoint` → fix → `run_tests` green 5/5 → `review_diff`.
That run also exposed the `path`-filter defect fixed in the same commit: passing the workspace root
to `find_symbol`/`find_references` matched no file and answered "no definition found" for a symbol
that existed. See the Phase 3 notes in docs/TOOLS.md.

Where the entry lives on this machine: `C:\Users\王贝波\.dsh\profiles\desktop\cordis.patch.yml`
(backed up next to it as `cordis.patch.yml.bak-devpilot-*` before the edit). The block sits before
the `managed - do not edit` webserver section so that section stays byte-identical.

## Reloading the entry after a rebuild (2026-10-05)

The stdio server is a **child process spawned at entry activation**, so `dist/index.js` is read once,
at spawn. Rebuilding `dist` therefore does *not* reach a live session: after the `path`-filter fix
landed and `dist` was rebuilt, the running session kept serving the old build — the exact call the
fix repairs still answered `total: 0` / `confidence: low`, and the warning the fix adds was absent.

DSH's `@deepseek-ai/dsh-hmr` watches the profile config, so the entry can be recycled without
restarting the desktop app. Detaching the row and writing it back **verbatim** (two writes, zero
semantic change, config ends byte-identical) forces a dispose + respawn:

1. Replace the `- insert:` block with a comment. Confirm *both* effects before continuing:
   `cordis_inspect_query host Config listConfigs {name:'@deepseek-ai/dsh-mcp-client'}` → `entries: []`,
   and no `node ... \DevPilot-MCP\dist\index.js serve` process left in `Win32_Process`.
2. Put the byte-identical block back. Confirm `total: 1` again and a **new** pid. On 2026-10-05:
   `pid=1672` (old build) → `pid=28732` started 00:19:44, after which the previously failing call
   returned `1 definition(s) … src/catalog/service.py:9 (class)` and the outside-workspace case
   answered `WORKSPACE_NOT_FOUND`.

Keep the two writes in separate steps: coalesced into one edit window, the loader sees the original
tree and nothing reloads. A fresh child has no workspace open, so re-run `open_workspace` before the
next call. Changing any real config value also reloads, but this procedure keeps the pinned config
exactly as reviewed.
