# Changelog

All notable changes to DevPilot MCP. Versions follow [SemVer](https://semver.org/);
this project is pre-1.0, so a minor version may change tool output shapes when a defect
requires it — such a change is called out below.

## v0.1.1 — 2026-10-05

Fixes found by running DevPilot read-only against the first target that was *not* built
for it (`D:\WBB_Python\pytorch`, a MiniGPT training repo: 316 files walked, 200 pytest
cases). Full before/after evidence is in [docs/GATES.md](docs/GATES.md), section
"Post-V1 — hardening on a real project".

### Fixed

* **Non-ASCII paths were silently excluded from rollback coverage** (`D5`). `git status`
  quotes and C-style-escapes such names; the old parser stripped the quotes but left the
  octal escapes, so `fs.stat()` failed, the file was recorded patch-only, and a rollback
  would have skipped it without saying so. Paths are now decoded byte-wise to UTF-8
  (`src/git/git-path.ts`) and read from `status --porcelain=v1 -z`, where git never
  escapes a path. On the reporting project, checkpoint coverage went 48/71 → 61/71, and
  48 + 13 = 61 exactly — the 13 recovered files are the 13 whose names carry CJK.
* **The change budget charged pre-existing work to the agent** (`D6`, `D6b`). A one-line
  agent change on a dirty tree reported "72 file(s) changed, +10143 −180, risk HIGH,
  budget exceeded (72 > 20; 5195 > 3000)" — the user's own uncommitted paths were blamed
  on the agent, which trains an agent to ignore the budget. The budget now counts the
  agent's change set only: `changeLimits.counted` says what was counted,
  `changeLimits.excludedPreExisting` how many paths were left out, and a warning says so.
  A stale baseline written by the pre-fix parser is recovered at read time. Trade-off
  kept explicit: an agent edit to an already-dirty file is not counted either.
* **Detection on a real repo** (`D1`–`D4`, shipped in v0.1.0 below): entrypoint picking
  chose `scratch/main.py` over the training entry, vendored `echarts.min.js` consumed the
  entire per-file reference budget (800 refs), a file-level impact target counted
  `super().__init__()` as a reference to the target class, and `open_workspace` built its
  profile from a `.gitignore`-blind walk that disagreed with `scan_project`.

### Added

* [docs/VERIFY.md](docs/VERIFY.md) — how to verify DevPilot yourself, split into four
  channels that cannot substitute for one another (repo gate, self-contained loop
  acceptance, live DSH session, CLI), with every expected value measured rather than
  remembered.
* [docs/DSH-INTEGRATION.md](docs/DSH-INTEGRATION.md) — wiring DevPilot into DeepSeek
  Harness, including the rebuild/reload procedure needed because the stdio server is a
  child process spawned at plugin-activation time.
* [CHANGELOG.md](CHANGELOG.md) — this file.

### Gate

`tsc --noEmit` → 0 errors, `vitest run` → **50 files / 388 tests pass** (46 / 370 before
this round; every defect class above has a regression test, and the CJK one has a
red/green pair against the old implementation).

## v0.1.0 — 2026-10-05

First public release: a local software engineering runtime for AI coding agents, over
MCP on stdio. Nineteen tools, all returning the same envelope
(`{success, summary, data, artifacts?, warnings?}` or a typed error envelope).

* **Workspace lifecycle** — `open_workspace`, `get_workspace_status`, `close_workspace`;
  per-workspace `.devpilot/` (config, cache, logs, checkpoints, SQLite index).
* **Understanding** — `scan_project`, `get_project_map`, `find_symbol`, `find_references`,
  `impact_analysis`.
* **Execution & verification** — `build_project`, `run_project`, `run_tests`, `run_test`,
  `diagnose_failure`.
* **Version control** — `create_checkpoint`, `rollback_checkpoint`, `review_diff`,
  `get_git_status`; rollback restores content snapshots and never runs
  `git reset --hard`, `checkout -f` or `clean` over user work.
* **Environment** — `doctor`, `dependency_audit` (offline by default).
* Languages: Python, Java (Maven; Gradle rules only), TypeScript/JavaScript, plus Node
  package managers. Build/test/runtime detection is rule-based, never LLM-guessed.
* Safety: workspace-confined paths, command allow/deny policy, per-process timeouts and
  output caps, file-change budgets, secret redaction at the result envelope.
* Verified end to end on three language stacks (Python 22/22, Maven 13/13, Node 13/13
  checks) and against the real project named above. See
  [docs/GATES.md](docs/GATES.md) for the per-phase evidence.

### Known limitations

* Gradle has rule-level support only; no real-project acceptance run exists for it.
* No benchmark tool; `dependency_audit`'s outdated/vulnerable checks need network access
  and stay empty (with an explicit note) when offline.
* No parser for languages other than Python, Java, TypeScript and JavaScript — such files
  are skipped with a `no parser in this build` warning rather than silently ignored.
* Acceptance has only been done on Windows 11 + PowerShell.
