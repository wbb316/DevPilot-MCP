# Gate log

Every phase must end with a green gate before the next one starts (working agreement:
"每完成一个阶段必须运行、测试、确认，再进入下一个阶段"). This file records the *actual*
commands and results, including the failures a gate caught — a phase is not "done" because
the code exists, only because the gate passed.

Commands used (PowerShell, `D:\tools\DevPilot-MCP`):

```powershell
& node .\node_modules\typescript\bin\tsc -p tsconfig.json          # build  (writes dist/)
& node .\node_modules\typescript\bin\tsc -p tsconfig.json --noEmit  # typecheck (src only)
& node .\node_modules\vitest\vitest.mjs run                         # tests
# `npm test` is equivalent, and its `pretest` script builds dist/ first.
```

> The stdio integration test launches `dist/index.js`. Running vitest directly *without*
> building first exercises a stale `dist/` — that mistake cost one debugging round in Phase 4,
> so the gate order is always: build → tests.

## Phase 1 — init, MCP server, workspace (commit `6c7612c`)

```text
tsc --noEmit  → 0 errors
npm test      → 10 files / 83 tests pass (incl. real MCP client over stdio:
                tools/list → open_workspace → get_workspace_status → close_workspace)
CLI smoke     → version 0.1.0; init detects "Python / PyTorch", entrypoint train.py;
                missing path → one-line FILE_NOT_FOUND, exit code 2, no stack trace
```

## Phase 2 — scanner + project map (commit `a77f251`)

```text
tsc --noEmit  → 0 errors
vitest run    → 15 files / 120 tests pass
Real repo     → scanning DevPilot itself: 70 modules in the project map; second scan
                38 ms → 2 ms (cache hit, no walk)
```

Three defects that only a real repository exposed (all fixed + regression-tested):

1. DevPilot itself was detected as Java/Maven because of `fixtures/**/pom.xml` → primary
   ecosystem scoring instead of first-marker-wins.
2. The cache invalidated itself: the scanner writes `.devpilot/cache/project.json` and
   reading git touches `.git/index`, both of which changed the cache key → `.devpilot` and
   `.git` are excluded from top-level observation.
3. `export class UserService` gave a TypeScript project Java layers → layers only for
   java/kotlin.

## Phase 3 — symbol & reference index (commit `33c90a7`)

```text
tsc --noEmit  → 0 errors
vitest run    → green at the time of the phase (21 files / 158 tests)
```

**Honest correction:** the Phase 4 gate re-run showed that the stdio test's `tools/list`
assertion had not been updated when Phase 3 registered `find_symbol`/`find_references`, so the
Phase 3 evidence above was not reproducible afterwards. Phase 3 is therefore marked
"re-verified in the Phase 4 run": the 23 files / 179 tests reported for Phase 4 cover Phases
1–3 as well, and the assertion is now updated with them.

## Phase 4 — build & run (commit `2e008da`)

```text
tsc -p tsconfig.json  → 0 errors (build, dist/ refreshed)
vitest run            → 23 files / 179 tests pass
Smoke (built dist/)   → open fixtures/node-project → build_project {target: package}
                        → npm run build succeeded; run_project node src/index.js
                        → exit 0, stdout tail captured
```

Defects the gate caught:

1. **`python` was passed twice** (`python python -m compileall -q .`) — the plan built the
   interpreter into both `command` and `args`; poetry's `run python` prefix was leaking into
   the non-poetry path. Caught by the integration test (exit code 2, empty `errors[]`).
2. **Stale `dist/`** — the stdio test asserted the Phase 3 tool list because the gate ran
   vitest without building first. Fixed by ordering build → tests and by updating the
   assertion.
3. **Windows `.cmd` shim wrapping was broken** (only found by smoke-testing the *npm* path —
   the integration tests used python, which is a real `.exe`): Node escapes the quotes around
   the shim path as `\"`, cmd.exe does not understand `\"`, so every `npm`/`mvn`/`gradlew`
   invocation died with *"is not recognized as an internal or external command"*.
   Fixed by assembling the command line by hand and spawning with
   `windowsVerbatimArguments: true`; a regression test now runs a real `.cmd` shim whose path
   and arguments contain spaces.
4. Timeout output was lost for buffered children → children now run with
   `PYTHONUNBUFFERED=1` (plus `NO_COLOR=1`, `CI=1`), so a killed service still yields the
   output the agent needs.

## Phase 5 — test runner (commit recorded below this phase)

```text
tsc -p tsconfig.json  → 0 errors (build, dist/ refreshed)
vitest run            → 26 files / 209 tests pass  (vitest exit code 0)
CLI smoke (dist/)     → devpilot test <copy of fixtures/python-project>
                        pass  → Status: passed, 3/3 passed, exit 0
                        +1 failing test → Status: failed, 3/4 passed, 1 failed,
                                          Failure: test_deliberate_failure (tests/test_model.py:34)
                                          — assert 1 == 2, exit 1
                        --filter=… → 1/1 passed, exit 0
```

Defects the gate caught:

1. **`-q` stacks into `-qq` and swallows the summary.** The planner initially added `-q` to
   its own pytest arguments; the Python fixture's `pyproject.toml` already carries
   `addopts = "-q"`, so pytest ran at `-qq` and printed only progress dots — no
   `3 passed in 0.05s` line to parse. A parser that "found nothing" would have reported
   `total: 0, failed: 0` for a green suite and, worse, could have hidden failures. Fixed by
   planning pytest with no quiet flag at all (plus `-p no:cacheprovider` so `.pytest_cache`
   never appears in the user's tree), and by pinning the `-qq` output in a unit test that
   asserts `parsed === false` rather than a silent zero.
2. **node:test TAP failures read as `error: |-`.** The diagnostic block's first line is the
   YAML key, not the message; the real text is indented underneath. Fixed by walking the
   indented continuation of `error:` (and by reading the `location:` field, which gives the
   failing file and line for free).
3. **Test-side contract misses** (caught by the gate, not shipped): `run_tests` returns its
   structured result inside `error.details` — matching the Phase 4 rule "a failed run is an
   error envelope whose `error.details` carries the whole structured result" — not in `data`;
   and the unit suite had a shadowing helper (`const { plan } = await plan(...)`), which is a
   TDZ error rather than a slow test.
4. **vitest durations are bare, not parenthesised.** File lines print `12ms` while the parser
   only accepted `(12ms)`, so `durations.slowest` came back empty; both forms are accepted now.

Behaviour pinned at this gate:

- `TestResult.parsed` distinguishes "green" from "I could not read the summary": counts are
  never invented, and `parser` reports which framework's parser actually understood the
  output (a package.json test script can hide a different runner).
- `status: 'no_tests'` is a first-class outcome (exit 0 with an empty collection), surfaced to
  the agent as a warning and to the CLI as exit code 1 — never as "passed".

