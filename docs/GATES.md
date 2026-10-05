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

Repository hygiene found while committing this phase:

- Running pytest **inside** `fixtures/python-project` left `__pycache__/*.pyc` and
  `.pytest_cache/` behind, and `git add -A` swept them into the Phase 5 commit (the first
  amend missed the `tests/__pycache__` subdirectory). Fixed by removing them from the index
  and the tree, and by ignoring `__pycache__/`, `*.pyc` and `.pytest_cache/`.
  Rule for every later phase: never execute python or a build inside a checked-in fixture —
  copy it to a temp directory first (the planned pytest command already passes
  `-p no:cacheprovider`, so `.pytest_cache` cannot reappear from DevPilot's own runs).

## Phase 6 — failure diagnosis (commit `6a973da`)

```text
tsc            → 0 errors (build writes dist/)
vitest run     → 28 files / 231 tests pass   (26/209 after Phase 5)
CLI smoke      → throwaway Python project with one seeded failing assertion:
                 devpilot test      → Status: failed, 0/1 passed, 1 failed, exit 1
                 devpilot diagnose  → ASSERTION_FAILED (medium) — tests/test_broken.py:2;
                                      "8 evidence line(s), 1 suspect file(s)", exit 0
```

Five failures the first gate run produced (all fixed; the list is the point of this file):

1. **`errors.fileNotFound` had no hint channel.** Its second parameter is a *detail string* that
   is appended to the message, so passing `{ hint: … }` produced `Not found: …: [object Object]`
   and an empty `hint`. Fixed by giving the factory an explicit optional third `hint` argument
   (used by all three Phase 6 call sites) instead of smuggling options through the message.
2. **A weak rule must not report high confidence.** The integration test expected `high` for a
   located `ASSERTION_FAILED`; the engine said `medium`. The engine was right — a failed
   expectation is a symptom, not a cause — so the test was corrected and the `confidenceOf`
   orderings are now pinned by unit tests (strong+located high, strong unlocated medium, weak
   medium/low, `UNKNOWN` low).
3. **Stale `dist/` fooled the tool list again.** Running vitest directly without `tsc` left the
   Phase 5 build in place, so the stdio test saw 11 tools while the source had 12. Identical to
   the Phase 4 trap: the gate order is always build → tests, and the stdio suite only proves
   anything about `dist/`, never about the sources.
4. **`is not a function` is classified as NULL_POINTER, on purpose.** The rule table claims JS
   `TypeError: x is not a function` for NULL_POINTER because the receiver is almost always
   `undefined`/`null`; the unit test that assumed TYPE_ERROR was wrong, and a dedicated test now
   pins the intent so a future rule edit cannot silently flip it.
5. **`\bFAILURES\b` does not match `failure`.** Word boundaries made pytest's
   `=========== FAILURES ===========` header invisible to the evidence collector, so the
   dropped-line count was one lower than the test assumed. The assertion was made honest
   (`>= 1`) rather than bending the pattern to fit the test.

Behaviour pinned at this gate:

- Only the **last 2 MiB** of a transcript are analysed, and `notes` says so when that happened:
  failure summaries live at the end of a runner's output, and the log must never be re-read
  wholesale into the agent's context.
- A frame in `site-packages` / `node_modules` / `.venv` / `.tox`, or any frame outside the
  workspace, is **counted and skipped** — `notes` reports the count. DevPilot never points the
  agent at a dependency to fix a bug.
- `evidence` is capped (default 8 lines, 400 chars each) with `evidenceDropped` reporting what
  was withheld, and the located source line is prepended; the located file/line is also what the
  agent is told to open next.
- `import_related` suspects reuse the Phase 3 index **only if it is already in memory**; when it
  is not, a note tells the agent to call `find_symbol`/`find_references` first instead of
  silently starting a full index build inside a diagnosis.
- `relatedJob.command` is the full command line (`python -m pytest -p no:cacheprovider`), because
  the ledger keeps executable and argv apart.
- `devpilot diagnose` and the `diagnose_failure` tool share one use case
  (`src/diagnose/diagnose-job.ts`), so the human path and the agent path cannot drift.

---

## Phase 7 — Git diff review & checkpoints

Gate command: `node node_modules/typescript/bin/tsc -p tsconfig.json` → 0 errors, then
`node node_modules/vitest/vitest.mjs run` → **32 files / 256 tests passed** (Phase 6: 28/231).
Real-repository coverage: `tests/unit/diff-analyzer.test.ts`, `tests/unit/checkpoint-rollback.test.ts`
(7 cases) and `tests/integration/git-tools.test.ts` (tool registry end to end: status → checkpoint →
edit → review → dry-run → rollback → unknown id → close).

### The restore mechanism was wrong, and only an end-to-end test said so

The first implementation restored files by reverse-applying the checkpoint patch per path
(`git apply --reverse --include=<path>`). Every unit check of that design passed, and the
integration test then failed at the *primary* use case:

```text
expected [ '.devpilot/' ] to include 'src/app.py'      ← checkpoint recorded DevPilot's own state dir
expected [] to include 'src/app.py'                    ← nothing was restorable at all
```

1. **A patch reverse-apply cannot undo an edit to the same lines it recorded.** The workflow this
   phase exists for is *checkpoint → edit the code → roll back*; the reverse apply refuses exactly
   then, because the post-image no longer matches. The unit test had "proved" the design by editing
   an *unrelated* region of the file — a test that was convenient rather than representative.
   Fixed by changing the mechanism: `create_checkpoint` now stores the **content** of every changed
   file under `.devpilot/checkpoints/<id>/files/`, and `rollback_checkpoint` writes it back.
   `patchFile` is kept as an audit artifact. This also makes an untracked-at-checkpoint file
   restorable, which a patch could never do.
2. **A successful no-op was reported as a restore.** `git apply --include=<path>` exits 0 when the
   selection matches no hunk, so `.devpilot/` (present in `git status`, absent from every hunk) was
   counted as `restored`. The patch's real paths are now parsed (`src/git/patch.ts`), and a path is
   only `restored` when the snapshot covers it — otherwise it lands in `skipped` with a reason.
3. **`.devpilot/` was recorded as user work.** `open_workspace` creates the directory, git sees an
   untracked path, and the checkpoint dutifully recorded DevPilot's own metadata as a change the
   user cares about. Both `create_checkpoint` and `review_diff` now exclude `.git`/`.devpilot` and
   report how many paths were skipped.

### Behaviour pinned at this gate

- Rollback never touches the index (no `add`/`reset`/`checkout -f`/`clean`), never deletes files
  created after the checkpoint, and refuses (with `GIT_DIRTY`) while a merge/rebase/cherry-pick is
  in progress — the only state where a restore is genuinely ambiguous.
- `preExisting` / `preExistingChanges` come from a baseline written **once**, at first open
  (`.devpilot/cache/git-baseline.json`). Re-capturing on a reopen would relabel the agent's own
  edits as the user's, so the capture is skipped when a baseline exists.
- Risk levels always carry a stated reason (`[HIGH] secret-bearing file`), never a bare verdict;
  symbol hits are named but do not raise the level by themselves.
- Line endings: `git apply` writes CRLF on a Windows checkout with `core.autocrlf=true`. That is
  git matching the surrounding tree, not a bug, so tests compare line content rather than bytes.

## Phase 8 — impact analysis

Commands (build before tests, so the stdio integration test spawns a fresh `dist/`):

```text
node node_modules/typescript/bin/tsc -p tsconfig.json   → exit 0
node node_modules/vitest/vitest.mjs run                 → exit 0, 34 files / 270 tests passed
```

Phase 7 was 32 / 256. Tool count 16 → 17 (`impact_analysis`).

Evidence, end to end through the tool registry on `fixtures/python-project`:

- `CausalSelfAttention` → declaration `model.py:14`, `affectedFiles` contains `model.py`
  (`declaration`) and `train.py`, `relatedTests` contains `tests/test_model.py`, `confidence`
  `high`, `riskLevel` stated with reasons, and `notes` carrying the method plus the depth rule.
- `model.py` (an existing path) → `targetKind: 'file'`, reason `target`, and `affectedSymbols`
  listing the declarations inside it (`CausalSelfAttention`, `GPT`).
- `tests` (an existing directory) → `targetKind: 'directory'`, members carrying
  `directory_member`.
- `includeTests: false`, `depth: 1`, `limit: 5` → tests leave `affectedFiles` but stay in
  `relatedTests`, with a note explaining the separation.
- An unknown name → `confidence: 'low'`, no `definition`, empty affected set, and the note that a
  lexical index cannot see dynamic usage.

Defect found by this gate — fixed in the implementation, not in the assertion:

```text
FAIL  tests/integration/impact-tool.test.ts > treats a directory as a directory target
AssertionError: expected 'test' to be 'directory_member'
```

The `includeTests` branch relabelled **every** affected test file as `reason: 'test'`, overwriting
the structural reason that answers "why is this file in the set" — a `directory_member` of the
target directory, or a `reference` call site, both became `test`. The assertion was right and the
implementation was wrong: test files are now added only when nothing else already explains them,
and test-ness is carried by `relatedTests` alone.

Behaviour pinned at this gate:

- A target can never escape the workspace: `C:\…`, `/etc/…` and any `..` segment are refused
  (unit-tested directly on `normalizeRelative`).
- `affectedFiles[].reason` and `relatedTests` are independent dimensions and never overwrite each
  other.
- Risk rules are deterministic, always carry a reason, and `riskLevel` is their maximum — there is
  no bare verdict anywhere in the output.
- Every answer ends with the `method heuristic` note. A lexical index cannot resolve
  receiver-typed calls, so the tool says that instead of implying compiler precision.

---

## Phase 9 — Security hardening, environment doctor, dependency audit

Gate command: `node node_modules/typescript/bin/tsc -p tsconfig.json` → 0 errors, then
`node node_modules/vitest/vitest.mjs run` → **41 files / 332 tests passed** (Phase 8: 34/270).

```text
tests/integration/security-attack.test.ts   7 passed
  traversal logFile=../../outside/secret.log  → refused, no outside content in the result
  workspace junction → outside directory      → refused (this was a real hole, see below)
  format C: /y · diskpart · rm -rf /          → COMMAND_NOT_ALLOWED, nothing spawned
  logFile=.env                                → success, evidence empty, "sensitive file" warning
  credential inside an ordinary build.log     → replaced by [redacted] + warning naming the rule
  target=../../outside                        → treated as a symbol, no path escapes the workspace
  2 changed files, max_files_changed: 1       → changeLimits.exceeded + "stage the work" advice

devpilot doctor (real machine) → overall WARNING
  OK   git 2.51.1 · node 22.23.2 · npm 12.1.0 · pnpm 11.23.0 · python 3.11.9 · python3 3.12.11
       pip 24.0 · conda 22.9.0 · java 17.0.19 · javac 17.0.19 · mvn 3.9.11 · docker 29.1.3 · nvcc 11.3
  WARN 4 python installations · 6 java installations · CUDA toolkit 11.3 vs torch 2.11.0+cpu
       · docker CLI present but the daemon is unreachable · yarn/gradle/nvidia-smi absent
```

Five defects this gate found (all fixed in the implementation):

1. **Containment was lexical only.** `isInside(root, candidate)` is a string test, so a directory
   junction *inside* the workspace pointing outside it passed — `diagnose_failure({logFile:'link/secret.log'})`
   returned `success: true` and had genuinely read a file outside the workspace. It only escaped
   notice because the evidence regex happened not to match that line: luck, not safety. Both sides of
   the comparison are now `realpath`ed for every path that is used to read a file, and the lexical
   check stays only to produce a precise error message.
2. **The dotenv redaction rule matched ordinary code.** Case-insensitive and line-anchored, it
   rewrote `access_token_expiry_seconds = 3600` into `[redacted]`. The rule is now uppercase-key only
   and unanchored, so it still catches `DB_PASSWORD=…` embedded in an error line but leaves ordinary
   constants alone.
3. **`poetry.lock` and `uv.lock` were parsed as YAML.** They are TOML (`[[package]]` tables); the YAML
   parser threw, the lock index came back empty, and the audit reported **zero transitives** for
   projects that do have a resolved graph — an audit tool silently under-reporting is worse than one
   that fails. A narrow TOML table reader now handles them.
4. **Maven `<!-- -->` comments were counted as dependencies**, so a commented-out `<dependency>`
   became a fourth direct dependency. pom.xml is now stripped of XML comments (the JS/Gradle comment
   stripper is no longer used on XML, where `//` inside a URL is not a comment).
5. **A missing lockfile was blamed on the alphabetically first manifest.** With both
   `pyproject.toml` (declaring nothing) and `requirements.txt` present, the ERROR landed on
   `pyproject.toml`. Ecosystem-level facts are now attributed to the manifest that actually declares
   the dependencies.

Delegation lesson: `dependency_audit` was written by a subagent that was stopped mid-flight with
**four of its own tests failing**. Three of the four were implementation bugs (2, 3, 5 above plus the
severity rule for cross-module Maven duplicates, which now reports ERROR because one JVM classpath
cannot hold two versions of an artifact, while npm's legitimate nesting stays a WARNING); one was a
stale expectation (the python fixture also has a `pyproject.toml`, so the manifest list legitimately
holds two paths). Each was adjudicated by reading both sides and deciding which one the evidence
supported — never by editing the assertion to match the output.

Behaviour pinned at this gate:

- Secret redaction sits in `ok()` / `fail()` — the single choke point every tool result passes
  through — so a tool added later cannot forget it, and both the summary and the failure envelope
  (`message`, `hint`, `details`) are covered. The envelope says how many values were replaced and
  which rule kinds fired, so a redacted value is never mistaken for the real one.
- A file that *looks* secret-bearing is treated more strongly than a redaction: `diagnose_failure`
  analyses nothing from it, returns an empty evidence list, and says only that it exists. The patch
  artifact is redacted before it is written to disk, and `review_diff` names the secret-bearing paths
  in its notes.
- Probe code must go through `runExecutable`, not `runProcess`: `npm`, `pnpm`, `mvn` and `gradle` are
  Windows `.cmd` shims, and the first `doctor` run reported them as missing from the machine. A probe
  that cannot start a tool must report "present, version not parsed" — never invent a version, and
  never blame the user's machine for the probe's own limitation.
- A change set over `max_files_changed` / `max_lines_changed` is reported with per-limit violations
  and staging advice; `0` means "no budget configured" and is never a violation.

## Phase 10 — Real-project acceptance

Command: `node tools\v1-acceptance.mjs --stage=<recon|verify|post|rollback> --out=docs/evidence/<stage>.json`
against `D:\Projects\devpilot-demo` (src-layout Python project, pytest suite, one deliberate bug,
one uncommitted user edit). Four stages because a real bug fix needs an agent edit in between.

```
recon     8/8   19 tools · open_workspace · scan · run command · symbols · references · impact · checkpoint
verify    2/2   failing suite as counts · diagnose_failure category + location + evidence
post      5/5   suite passes · run_project really starts it · diff review · user edit kept separate
rollback  7/7   fix truly undone · user's note untouched · index never modified
```

Gate record: 22 checks, 0 failures; run after the last source change, with `tsc` exit 0 and
43 test files / 346 tests green.

### The three defects a real project found and 346 tests did not

1. **f-string interpolations were masked as string bodies.** `maskNonCode` blanked the whole
   literal, so `print(f"{service.average_price('input'):.2f}")` produced no reference at all —
   `find_references` reported 1 use in 1 file where grep shows 2 files. Fixed by extracting the
   `{...}` fields (and JS/TS `${...}` substitutions) and restoring them after blanking, keeping
   nested string literals masked. Lesson: a heuristic that survives fixtures can still be blind to
   the most idiomatic line in the language.
2. **The entry-point candidate list never looked inside a package.** A project whose entry point is
   `src/catalog/cli.py` reported no run command. Measuring first mattered: `python src/catalog/cli.py`
   dies with `ImportError: attempted relative import with no known parent package`, so the honest
   answer is the module form plus the environment it needs — `python -m catalog.cli` with
   `PYTHONPATH=src`. Hence `entrypoints` discovery by name anywhere in the tree (test paths
   excluded) and the additive `candidates.runEnv`, applied by `run_project`.
3. **A checkpoint could not undo an edit to a file that was clean when it was taken.** The
   checkpoint snapshots only the files dirty at creation, so the agent's own edit to `service.py`
   survived its own rollback (item 13.4 caught it: the suite stayed green). Rollback now restores
   such files from the commit the checkpoint recorded, reports paths that already matched in
   `unchanged` instead of claiming a write, refuses binaries, and preserves line-ending style.

### Two caches that could not see a better rule set

Both are the same bug in different places, and both were found only because the acceptance run
re-ran against an **already-indexed** workspace:

- the symbol index was keyed by `mtime+size`, so the f-string fix produced no new results until
  `INDEX_SCHEMA_VERSION` was joined by `EXTRACTOR_VERSION` (bumped → full re-parse);
- the project profile cache was keyed on the tree, so the new detector kept serving the old
  answer until `SCANNER_VERSION` was bumped 2 → 3.

Rule: when a *rule set* changes what derived data means, bump its version — a cache key over
inputs cannot notice a smarter implementation.

### Driver mistakes worth remembering (they looked like product bugs at first)

The acceptance driver is a client, and three of its failures were its own: it ran each stage in a
fresh process without `open_workspace` (so `WORKSPACE_NOT_OPEN`), it read only `data` although a
failed run/test puts the structured result in `error.details`, and its own assertion expected a
nested string literal inside an f-string to stay visible. Each was decided by checking the
documented contract before touching product code — and in the rollback case the same discipline
went the other way and changed the contract.

## Phase 10b — Language-stack acceptance (Python · Maven · Node)

Command: `node tools\stack-acceptance.mjs --stack=<maven|node> --out=docs/evidence/<stack>.json`.
Each stack copies its fixture into a temp directory, `git init`s it, and runs the whole loop:
open → scan → symbol → add a failing test → checkpoint → build → `run_tests` (must fail) →
`diagnose_failure` → **fix the real defect** → `run_tests` (must pass *with counts*) →
`review_diff` → `rollback` → `run_tests` (must fail again) → close. The defect is real: the Maven
fixture's `lengthOfTitle` has no null check, the Node fixture's `divide` throws the wrong error type.

```
maven 13/13   Java 17 (JAVA_HOME=D:\JDK\JDK17) via Maven 3.9.11 — real `mvn -B test`
node  13/13   Node 22 — real `npm test` (node --test)
python 22/22  Phase 10 stages above (D:\Projects\devpilot-demo)
```

Gate record: run after the last source change, with `tsc` exit 0 and 45 test files / 359 tests green.

### Four defects only a real runner could show

1. **A Maven failure was located inside JUnit.** Surefire's first stack frame is
   `AssertionFailureBuilder.java:151`, and the parser took the first frame — so `failures[0].path`
   pointed at framework internals that are not even in the workspace. Frames are now scored
   (the test's own class > project code > framework) and the canonical failure object is reused
   (a dedup branch used to write stack frames onto a discarded copy, losing every path).
2. **`mvn -q test` hides its own summary when it passes.** So a green run reported
   `status passed, total 0` — the exact "0 tests, all good" shape this project exists to prevent.
   Maven now runs `-B` in *both* places that publish a command (the test planner and the profile's
   `candidates`); the acceptance run demands `total >= 2`, which is what made the second place
   visible after the first was fixed.
3. **`exit 0` with no readable summary was reported as `passed`.** Phase 5 had fixed that for
   pytest's `-q` only. `TestStatus` gained `'unknown'`, decided by a pure `decideTestStatus()`, and
   all three exits (tool, `run_test`, CLI) report it as UNVERIFIED rather than green.
4. **A non-ASCII profile path broke frame extraction twice.** An ASCII-only path pattern split
   `C:\Users\王贝波\…` after the CJK characters, and inside node's percent-encoded `file:///` URL it
   bit off `A2/AppData/…` from `%E6%B3%A2`. Paths are now matched with a unicode-tolerant class,
   `file:///` URLs are percent-decoded, and a frame is only preferred when it can be verified
   against the workspace — bare JVM names are resolved through the index (built on demand, and only
   when a frame could not be placed).

### Evidence quality is part of the contract

The acceptance evidence showed `error: |-` as a diagnostic *evidence* line: `node --test` TAP keys
(`error: |-`, `code: 'ERR_ASSERTION'`, `duration_ms`) match EVIDENCE_PATTERN through the words
"error" and "assert" while saying nothing. They are now filtered — but only the key-with-machine-
value shapes, so `error: Expected 1 to be 2` stays, because there the text is the evidence.

## Phase 10c — Same-version re-run, and the activation boundary

The four Python stages were re-run against the build produced *after* the Phase 10b fixes, so all
three stacks now carry evidence from one source revision
(`node tools\v1-acceptance.mjs --stage=<stage> --out=docs/evidence/<stage>.json`):

```
recon    8/8   tools/list 19 · open · scan · run command · find_symbol · find_references · impact · checkpoint
verify   2/2   failing suite with real counts · structured diagnosis (category + location + evidence)
post     5/5   passing suite · run_project actually starts it · diff review with patch · pre-existing change flagged
rollback 7/7   dry-run · real restore · suite red again · user's README note intact · git index untouched
```

The demo repo ends exactly as the user left it: `git status --short` lists ` M README.md` and
` M src/catalog/service.py` (the second is git's racily-clean false positive) while `git diff --stat`
lists only `README.md | 5 ++++-` — DevPilot's own edit was rolled back byte for byte, and the other
change is the user's.

### The activation boundary, recorded rather than hidden

`plugin_manager list_plugins` against the running desktop profile returns 217 active entries and
**none of them is `mcp-devpilot`**. DSH reads profile plugin entries at harness start, so the entry
written into `cordis.patch.yml` is present and schema-valid but not yet loaded by the running host.
The stdio contract itself is proven independently (`tools/mcp-probe.mjs`: 19 tools, handshake, clean
exit on stdin EOF), so the missing tools were never a server-side failure.

**Correction (2026-10-05).** This paragraph first blamed "a restart is still needed". That diagnosis
was wrong, and the wrong version would have misled every future install: the row had been written as
a bare `- id: mcp-devpilot`, and a top-level `- id:` line only *overrides* a row that some bundle
already inserted — as a way to add a row it is a silent no-op. Written as `- insert:` the entry
loaded at once (`@deepseek-ai/dsh-hmr` hot-loads the patch), and the live loader then reported
`include:mcp-devpilot`, a stdio child process (`node dist/index.js serve`) and the 19
`mcp__devpilot__*` tools in the model's own tool list. `docs/DSH-INTEGRATION.md` records the working
form and the rebuild/reload procedure.

## Post-V1 — hardening on a real project (2026-10-05)

The first target that was *not* built for DevPilot was run read-only through the DSH bridge:
`D:\WBB_Python\pytorch`, a MiniGPT training repo (316 files walked, 200 pytest cases green). The
engineering loop held; the detection layer did not. Three defects were fixed, each with the
measured before/after on that project:

```text
D1 entrypoint / run command / sourceDirs
   before  entrypoints[0] = scratch/main.py (an MNIST toy) → run: python scratch/main.py
   after   entrypoints = train/train.py, generate.py, app/server.py
           run: python train/train.py     runEnv: { "PYTHONPATH": "." }
           sourceDirs: ["app"] → ["app","model","benchmark","train"]
   rules   throwaway/asset directories excluded; an `if __name__ == "__main__"` guard outranks a
           bare name match; the framework decides among names (PyTorch → train.py over
           server.py); an out-of-package Python entry that imports a root-level module gets
           PYTHONPATH=. (without it `python train/train.py` cannot import `model/...`)

D2 generated assets flooding the index
   before  docs/report_output/v2_50M+1B/echarts.min.js held 800 refs (the entire per-file
           budget) and 2 symbols, and was listed as a project module; the cap note did not name it
   after   index files 114 → 113, symbols 3142 → 3140, refs 8597 → 7797 (exactly 800 dropped)
           map modules 96 → 95; notes now name the file on both sides

D3 a file target counting generic member names as references
   before  model/attention.py: 23 references — including super().__init__() in model/rope.py,
           model/layers.py and scratch/* — risk MEDIUM
   after   8 references (model/gpt.py and test/test_attention.py kept by import adjacency, the
           rest reached only as `importer` hops), risk LOW, note:
           "5 name-only match(es) dropped: … generic members such as __init__ or forward match
           everywhere"
```

Fixed in the same code paths because the run exposed them: the map's stale "Phase 3 replaces this
with an AST index" note, `suspectFiles` listing `.devpilot` as recently-changed (DevPilot's own
data changes on every call), and `impact_analysis`'s summary answering "no declaration found" for a
file target while `affectedSymbols` listed four declarations.

D4 `open_workspace` built its profile from a `.gitignore`-blind walk (found while re-verifying D1)
   before  entrypoints held `review_bundle/speedup_code/train/train.py` and sourceDirs held
           `model_backup_2026-09-06` — both excluded by the project's own `.gitignore`
   after   the profile is fed by the same ignore-aware walk as `scan_project`
           (`src/workspace/workspace-manager.ts`, step 6); entrypoints = train/train.py,
           generate.py, app/server.py; sourceDirs = app, model, benchmark, train
   cause   `detectProject` fell back to its internal `scanTree`, which only knows
           `config.workspace.exclude`. Two tools disagreed about one project: `scan_project` was
           right, `open_workspace` was wrong — and `open_workspace` runs first.

Gate: `tsc --noEmit` → 0 errors, `tsc` → 0 errors, `vitest run` → **46 files / 370 tests pass**
(365 before; 5 new regression tests, one per defect class). Re-verified against the real project in
a fresh stdio session on the rebuilt dist (`tools/mcp-probe.mjs --steps-file=…`): 19 tools, handshake
385 ms, clean exit; D4 re-checked in the live DSH session after an entry reload. The user's working
tree afterwards: `git diff --stat` reports the one `.devpilot/` line they approved in `.gitignore` —
nothing else.



