# DevPilot MCP — Workspace Lifecycle

The workspace is DevPilot's unit of context **and** its security boundary. Every path an
agent can reach, every command that may run, and every cache DevPilot writes traces back
to exactly one workspace root.

## 1. State machine

```text
            open_workspace(path)
  (none) ─────────────────────────► OPENING
                                      │ create/verify .devpilot\ · load config
                                      │ realpath(root) · detect project markers
                                      │ snapshot git state (branch/head/dirty)
                                      ▼
                                   OPEN ────────────── scan_project (Phase 2) ──────────► INDEXED
                                    │  ▲                                                  │
                     close_workspace│  │open_workspace(same path → idempotent reopen)      │ files changed
                                    ▼  │                                                  ▼
                                 CLOSED (registry entry retained)                       STALE ──scan──► INDEXED
```

| State | Meaning | Allowed tools |
| --- | --- | --- |
| none | no workspace in this session | `open_workspace`, `doctor` |
| OPEN | root + config + git snapshot known; no index | workspace tools, `scan_project`, `get_project_map`, `run_*`, `diagnose_failure`, `review_diff` |
| INDEXED | symbol/reference index usable | + `find_symbol`, `find_references`, `impact_analysis` |
| STALE | files changed since the index was built | index tools answer with `engine`/`confidence` downgraded and `notes: ["index stale"]` |
| CLOSED | session released it | like `none`; `.devpilot\` untouched |

Multiple workspaces may be open in one server process (one is *active*); every tool
resolves its workspace as `path ? registry[path] : activeWorkspace`. Tools that need a
workspace and get none fail with `WORKSPACE_NOT_OPEN` and `hint: "call open_workspace"`.

## 2. `open_workspace` sequence (exact order)

```text
1. normalize + assert the path exists and is a directory      → FILE_NOT_FOUND
2. realpath() resolve (kills symlink escapes)                 → PATH_OUTSIDE_WORKSPACE if it leaves an already-open root
3. workspace id = sha1(realpath).slice(0,12)
4. ensure <root>\.devpilot\ {cache,logs,checkpoints}          createdDevpilotDir flag
5. load <root>\.devpilot\config.yml  (create default if absent and createConfig)
   – validation failure → CONFIG_INVALID (workspace is NOT opened)
6. detect project markers / languages / build+test systems    (Phase 1: marker level)
7. git snapshot: rev-parse --abbrev-ref/--short HEAD, status --porcelain
   – git missing → git.available=false + warning, never fatal
8. register in DevPilot home registry.json (create or update lastOpenedAt)
9. create workspace log <root>\.devpilot\logs\devpilot-YYYYMMDD.log
10. return WorkspaceState + notices (dirty tree, missing .gitignore entry, missing toolchain)
```

Idempotent: opening the same root twice returns the same workspace id and does not
re-create anything. Opening a *different* root while another is active just adds another
entry and switches the active workspace.

## 3. Directory layout written by DevPilot

```text
<workspace>\
├── <user project files — DevPilot never restructures them>
└── .devpilot\
    ├── config.yml            # user-editable, zod-validated
    ├── devpilot.db           # index/jobs/checkpoints (Phase 3+; absent in Phase 1)
    ├── cache\
    │   ├── project.json      # ProjectProfile + scan stats
    │   └── files.json        # walker manifest (path/mtime/size/hash)
    ├── logs\
    │   ├── devpilot-YYYYMMDD.log
    │   ├── build-<ts>.log    # full raw output of build/run/test jobs
    │   └── test-<ts>.log
    └── checkpoints\
        ├── index.json
        └── <checkpointId>.patch
```

DevPilot home (machine level, **not** in any project):

```text
%DEVPILOT_HOME%                (default %LOCALAPPDATA%\DevPilot)
├── registry.json              # known workspaces {id,name,root,lastOpenedAt}
├── logs\devpilot.log          # server-level log
└── config.json                # global defaults (permission, limits)
```

`.devpilot/` never contains DevPilot's own source code, and DevPilot source is never
copied into a target project. `init` prints the exact `.gitignore` line to add and only
edits `.gitignore` when explicitly asked (`devpilot init --write-gitignore`).

## 4. Config precedence

```text
tool-call argument  >  <workspace>\.devpilot\config.yml  >  %DEVPILOT_HOME%\config.json  >  built-in defaults
```

`.devpilot/config.yml` (zod schema, defaults shown):

```yaml
workspace:
  exclude: [node_modules, .git, dist, build, target, out, .venv, venv, checkpoints, data]
  max_files: 20000
  max_file_size_bytes: 2097152
security:
  permission: SAFE_WRITE          # READ_ONLY | SAFE_WRITE | EXECUTE | FULL
  execute: true                   # limited EXECUTE: EXECUTE-gated tools stay reachable, bounded by the command policy
  allow_shell: false              # never pass commands through a shell by default
  allow_outside_workspace: false
  max_files_changed: 20
  max_lines_changed: 3000
  max_command_seconds: 120
  max_output_bytes: 262144
project:
  type: null                      # override auto-detection
  run_command: null
  build_command: null
  test_command: null
index:
  enabled: true
  languages: [python, java, typescript, javascript]
git:
  checkpoint_on_write: false
  protect_user_changes: true      # refuses destructive flows on a dirty tree
benchmark:
  enabled: false
```

An unknown key or a bad type fails the open with `CONFIG_INVALID` plus the zod path —
config errors are never silently swallowed.

## 5. Concurrency & locking

* One server process = one MCP session. Workspace state lives in process memory;
  `registry.json` is machine-global.
* Registry writes are atomic (temp file + rename) and retried once on a transient
  rename error; a corrupt registry is backed up to `registry.json.bak` and rebuilt.
* Command jobs are tracked by `jobId` in `.devpilot/logs/`; the log file name is the
  correlation id surfaced in `artifacts.log` and in `diagnose_failure`.
* Long jobs are never orphaned: `process-runner` kills the process tree on timeout.

## 6. Git safety rules (binding for all phases)

```text
ALWAYS safe      : status, rev-parse, log, diff, show, ls-files, stash list, rev-list
ALLOWED with care: add/commit only inside a DevPilot-created branch or over explicit user request
NEVER            : git reset --hard, git checkout -f, git clean -fd, deleting user branches,
                   amending or rewriting user history, force-push
```

Before any operation that writes files, DevPilot records what was **already** dirty
(`preExistingChanges`) so that later `review_diff` can separate "the agent changed this"
from "the human had this uncommitted". Rollback restores only files listed in that
checkpoint; anything modified afterwards is reported, not clobbered.

## 7. Failure & recovery

| Situation | Behaviour |
| --- | --- |
| root deleted while open | tools fail `WORKSPACE_NOT_FOUND`; entry stays in registry for the human |
| `.devpilot/config.yml` invalid | open fails `CONFIG_INVALID`; file left untouched for the user to fix |
| index DB corrupt | `INDEX_FAILED`; `scan_project { force: true }` rebuilds |
| git not installed | git features degrade to `GIT_NOT_AVAILABLE`, everything else works |
| command timeout | job marked `timedOut`, process tree killed, log keeps the partial output |
| server crash | next `open_workspace` rebuilds in-memory state from registry + cache; `.devpilot/` is the durable record |
