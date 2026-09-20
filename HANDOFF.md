# HANDOFF

Entry point for any agent picking up llm-relay, on any provider. Read this before `CLAUDE.md`.

## 0. State as of 2026-09-17 (v0.84.0)

- **The documentation is now usable by a third party (2026-09-17, lap `ca8814f5`, commit
  `cfb5420`, no source change).** Owner instruction: third-party contributors and testers are
  coming, so everything must be clear, succinct and free of personal information.
  - `docs/` top level holds LIVE documents only. The 73 dated records moved to `docs/history/`,
    whose README states they are evidence and points at the live document for each subject. Six
    undated records of the same kind and the two existing evidence subdirectories (`reviews/`,
    `evidence-2026-08-16/`) moved with them, so the move is 99 files and `docs/history/` holds 100.
    The rule is now in `CLAUDE.md`: a dated file is WRITTEN into `docs/history/`, never moved later.
  - Machine paths and personal identifiers are scrubbed from every tracked text file.
  - New: `CONTRIBUTING.md` (set up, the gate, the seven invariants, four test conventions, and the
    tester section naming the three files that hold credentials), `docs/architecture.md` (a source
    map for a person), `docs/README.md` (the index).
  - `docs/reference.md` gained a 48-entry table of contents. No heading TEXT changed, so every
    existing deep link still resolves.
  - Verified: gate green on tree `fa86cf9813ea` for `cfb5420` and on tree `55531b8b1d60` for
    `6ca62d0`; CI green on `main` for both (runs 35266840782 and 35268109263). A link check over
    all 130 tracked documents, using the resolution rules of `test/doc-links.test.ts`, found 408
    relative links and 4 broken. Inside that test's own scope there are 378 links and 0 broken. The
    4 sit in `AGENTS.md` and `.github/copilot-instructions.md`, inside generated installer marker
    blocks, and are logged in `C:\Code\docs\backlog.md`, not here.
  - **Released as v0.84.1** (commit `f9fff49`, publish run 35270604176, owner decision). The
    release carries NO source change — the built output differs from v0.84.0 only in the version
    string — and exists so the npm page points at `CONTRIBUTING.md` and `docs/architecture.md`.
    The global binary is reinstalled at 0.84.1. ⚠ The running daemon and every `llm-relay mcp`
    process still hold v0.84.0 code, which is behaviourally identical, so `withVersionNotice`
    appends a version notice to MCP replies until those processes restart.
- **Later the same day (v0.83.2, v0.84.0).**
  - The desktop Code tab did not get the long wait: Desktop gave the session its own server copy,
    named `llm-relay`, which hid the Code tab's own server, and Desktop calls as `claude-ai` with a
    60 s limit on that path. v0.83.2 gives `claude-ai` a 50 s wait and renames the Desktop entry to
    `llm-relay-desktop` (setup was re-run on this machine). Evidence:
    `docs/history/mcp-host-timeouts-2026-09-17.md`.
  - v0.84.0 (owner decision): the walk stops a lane only when it is IDLE for
    `routing.dispatchWalk.idleMs` (300 s): no tagged relay traffic, no output, no file change. New
    `src/lane-activity.ts` and `GET /dispatch/activity`. Verified live on the restarted daemon: a
    headless `claude -p` with `ANTHROPIC_CUSTOM_HEADERS` sent its tag, and the route reported it.
  - **Not verified yet:** a walk through a restarted MCP process. The Desktop and Code tab MCP
    processes still run v0.83.2 until Claude Desktop restarts.

- **What the dispatch-fidelity lap shipped (2026-09-17, lap `f8d56109`).** Goal: dispatch from
  Claude Desktop, Codex Desktop and other hosts works as closely as possible to each host's
  native subagent dispatch. Seven commits, `85a7ba2..42b2745`:
  - Several `llm-relay mcp` processes share the job files, and a terminal `dispatch_status`
    returns the full answer (`85a7ba2`).
  - Claude Code gets the answer in ONE call: for `clientInfo.name` `claude-code` the server waits
    until the job ends and sends `notifications/progress`. Other hosts keep the 25 s ceiling. A
    1,500 s call passed. Evidence: `docs/history/mcp-host-timeouts-2026-09-17.md` (`62c7dbf`, `9f341da`).
  - The lane launcher expands `%VAR%` environment values (or removes one that does not resolve),
    and an AGY lane gets `--add-dir <cwd>`. The job shows both on a `launch:` line (`9f341da`).
  - An agent-mode answer ends with a `tree delta` block: what the lane changed in `git status`,
    with an optional `scope` that marks paths OUT OF SCOPE. Report only (`4e1899e`).
  - The walk skips a rung whose new `capability` is below the dispatch tier (`42b2745`). Its
    budget extension was replaced by the idle-only stop in v0.84.0.
  - The Codex `relay` agent template writes provenance only from a real dispatch result
    (`05db5b8`), and a test replays a lane that outlives `waitMs` (`d984b87`).
- **The work queue is planned (2026-09-17, planning lap, no source change).**
  [docs/history/stabilization-plan-2026-09-17.md](docs/history/stabilization-plan-2026-09-17.md) splits every open
  backlog entry, the stated residues and the findings of a live survey into packets for cheap
  models, in waves. Start with packet W0-1: the package ceiling has room for two more entries.
- **Owner correction (2026-09-17 closeout): do NOT hand-set a rung's `capability`.** The value
  must come from the synced capability data (`docs/tier-data.json`), which the v0.84.0 design
  does not do. Design item D6 of the plan above replaces it. Also decided: `POST /reload` is
  approved for design (D2), growing cooldowns for repeated 5xx and 402 are approved (packet S5),
  and operator-declared prices are declined (D4).
- **Immediate next.** After the owner restarts Claude Desktop: run a Code tab
  dispatch of a pool task that takes more than 60 s, and confirm it answers in one call and that a
  running status reports `walk-verdict: keep-running` with relay activity as its basis rather than
  requiring elapsed-time/output inference. Open backlog: route B, the Codex Desktop check, the
  dashboard pin control, the tree delta for a `killed` job, and the unused budget code.

### 0.1 Prior lap (2026-09-17, v0.82.2)

- **What that lap shipped — the relay agent's model line (v8).** Owner direction
  2026-09-16: the generated `~/.claude/agents/relay.md` must never run on the calling session's
  model ("there is absolutely no reason for Fable to be running a dispatch like that"). `llm-relay
  setup` now writes `model: haiku` (`DEFAULT_RELAY_AGENT_MODEL`), accepts `--relay-model <alias>`,
  and refuses `inherit` by name at the CLI and in `installRelayAgent` (`relayAgentModelRefusal`).
  This reverses the v4 (2026-09-04) direction "do not hard-code a model name"; both measurements
  are recorded above `DEFAULT_RELAY_AGENT_MODEL` in `src/setup-claude.ts` — `haiku` failed the
  echo test on the v1 template and passed it on v7 (2026-09-16, two tool calls, verbatim answer,
  real provenance line). The Codex agent file has no model key and is untouched. **Immediate
  next:** none from this lap. ⚠ An installed `relay.md` is read by Claude Code once per session:
  after `llm-relay setup` regenerates it, a new session is needed before the v8 marker shows.

### 0.2 Prior lap (2026-09-16, v0.82.0 and v0.82.1)

- **What that lap shipped — the backlog-clearing lap.** Owner instruction: clear up everything from
  the backlog and open bugs, orchestrated through parallel relay-agent dispatches. Eight pieces
  landed, each independently gate-verified (typecheck, full suite, dashboard checks, package
  checks) after merge, not just trusted from the dispatching agent's own report:
  - **Self-pacing from observed throttling** (`src/pacing.ts`, new) — the relay now holds its own
    attempt rate under a stated or learned rate limit, across every client, via a third demotion
    term beside `quota-demotion.ts`/`latency-demotion.ts`. A learned `rate-limit-*` fact paces
    live without the `routing.quota.enforceLearned` opt-in. `ping/cadence.ts` gained a narrow
    `RateLimitRecoveryPort` so a 200 probe ends a 429-sourced breaker cooldown early, with bounded
    re-probing of cooling cells. `routing.pacing: false` reverts byte-for-byte.
  - **Model catalog refreshes on evidence** (`src/catalog.ts` `noteProviderStale`) — a 404 stating
    a currently-listed model does not exist now triggers one bounded per-provider re-fetch, wired
    through `candidate-runner.ts`/`server.ts`.
  - **MCP dispatch subsystem** (`src/mcp/lane-runner.ts`, `src/mcp/server.ts`,
    `src/mcp/job-archive.ts` new, `src/mcp/readonly-boundary.ts`) — a silent, stalled lane is now
    reported (not silently left `running`); finished dispatch jobs survive
    an MCP-server restart via the archive; job handles are now process-unique rather than a shared counter; `dispatch(readOnly: true)` now binds the lane's own
    read-only tool flags (`claude`/`codex`), not only its cwd (`opencode`/`agy` refused by name,
    the gap stated rather than claimed).
  - **Dashboard's first write** (`routes/admin.ts` `operatorLanePin`) — `POST /dispatch
    {"pin"|"unpin"}` reuses the existing `lane-affinity.ts` pin, on the same admission boundary as
    every other `POST /dispatch` (Host, Origin, content-type, control token). The SPA control for
    it is NOT built yet — left open, see below.
  - **Dashboard usability pass** — Quota panel grouped by provider with basis badges and relative
    reset times, dark mode as the default theme (persisted, try/catch-wrapped), a collapsible-panel
    pass, empty-state styling, hover/focus states.
  - **Three smaller fixes**, each closing its own backlog item: `config set` can address a numbered
    ladder-rung array segment; a pre-commit stream failure names its upstream stop reason
    (`stream-commit.ts`); a DeepSeek response's `reasoning_content` now reaches the caller on both
    fronts, closing the loop `openai-request.ts` opened.
- **Verification note.** One dispatched agent's own report claimed a green gate that a second,
  independent run in a properly-wired worktree contradicted (a double-count failure in the
  catalog-staleness change, found and fixed as a test-hermeticity bug, not a source bug — see git
  log `ad6f4e9`). Full suite at this lap's HEAD: 191 test files, 4280 tests on CI's Linux leg
  (GitHub Actions run 35076653338); a local Windows run reports 4275, the documented gap
  ("Some tests are POSIX-only and skip on Windows" — §3) — CI is the authoritative count.
- **What remains open, all three deliberately left, not overlooked** (see `docs/backlog.md`):
  Route B's live served request (blocked on a NEW vendor session-identity check, not the rate
  limit the item was written against — not fixable by a stronger request); the Codex Desktop
  `relay`-agent live verification (needs the owner at the keyboard); the dashboard SPA control for
  the operator pin (the endpoint half landed this lap, the UI half did not).
- **Pipeline carried through to release.** Landed on `main`, released as v0.82.0 (npm Trusted
  Publishing, run 35093394265), global bin reinstalled, and the daemon restarted via its own
  `Startup\llm-relay.vbs` launcher — confirmed live (`/telemetry`, `/dispatch` both answering on
  the fresh process). **Immediate next:** none from this lap; the three open items above are each
  blocked on something outside this repo (a vendor, the owner's own keyboard, or a follow-up SPA
  change nobody has started).

### 0.3 Prior lap (2026-09-10, v0.81.0)

- **What that lap shipped — the dispatch give-up fixes.** Diagnosis:
  [docs/history/dispatch-giveup-diagnosis-2026-09-10.md](docs/history/dispatch-giveup-diagnosis-2026-09-10.md).
  Agents gave up on `dispatch` because the walk stopped the one working lane (`free-pool`) at a
  90 s budget that its own window could never raise, walked on through lanes that could not
  answer, ended on the `anthropic` pass-through that the MCP server cannot run, and then told the
  agent to stop delegating. All nine planned fixes landed (F1–F9), with DeepSeek's two
  request-shape 400s (F10/F11, written by a Sonnet lane and verified here) and the windowless-console
  wrap for `routing.cliLane` (the popup fix). The owning symbols are in the `CLAUDE.md` rows for
  `dispatch.ts`, `dispatch-lane-stats.ts`, `mcp/server.ts`, `mcp/agy-quota-log.ts` and
  `openai-request.ts`.
- **What an operator will notice.** `dispatch` takes `model`; the default blocking wait is 25 s
  (it was 40 s, past Codex's 31 s limit); a reply with no answer names a lane the walk stopped and
  the call that lets it finish; `dispatch_status` states the running lane's usual time to answer;
  `dispatch_lanes` shows each lane's time to answer and failure streak; a lane with five own
  failures in a row is ordered last until it answers; `/telemetry` shows `tierType: null` for an
  undeclared tier; and an `llm-relay mcp` process older than the installed package says so in
  every reply. The `relay` agent description (Claude v7, Codex v2), the skill and the MCP
  instructions no longer call the pools free, because paid DeepSeek leads them.
- **Verified live on an isolated relay** (port 8792, this lap's build, a copy of the operator's
  config and lane history). `dispatch_lanes` showed `anthropic` unreachable for the MCP server and
  `opencode-muse-spark` failing at 12 own failures; `model: "deepseek/deepseek-flash"` answered in
  1.8 s; an agent-mode dispatch handed back its job at 25.0 s; and with the agent floor set to 60 s,
  `free-pool` ran a 100 s command to its answer in 107 s — the walk withheld the budget because
  every later lane was failing, exhausted or unreachable. The transposed lane ran through
  `lane-launch.ps1`, and a window watcher saw no new window and no focus change from it. The first
  run also found old lane history reading as a time to answer (`anthropic` "0s" at 0 of 24),
  fixed in `3a798ca`.
- **Operator config, this lap (backups taken).** `providers.deepseek.stallTimeoutMs: 120000` (F7)
  and the four free-pool rung notes, which say that paid DeepSeek leads the pool, are LOADED: the
  daemon was restarted at 13:55 (PID 20364) onto the global v0.80.0, after the last config write
  (13:15). The stopgap `routing.dispatchWalk: false` (owner decision "walk off, no restart now")
  was loaded then too. The closeout REMOVED it again (owner decision 2026-09-10: turn the walk
  back on; backup `config.json.bak-2026-09-11-pre-walk-on`), so the default walk returns at the
  next restart.
- **Immediate next:** the owner restarts the daemon onto v0.81.0; the global package is already
  reinstalled (owner decision 2026-09-10: "reinstall now, I'll restart"). The restart loads this
  lap's daemon-side code (`requester=mcp`, mode-keyed windows, `model`, `tierType: null`, the
  launcher wrap in `GET /dispatch`) and the walk. After it, `GET /dispatch` should show walk
  budgets, and a view built with `requester=mcp` should show `anthropic` unreachable. The next lap
  is decided (owner, same day): pacing from observed throttling, then a catalog refresh on a stale
  hint — the two owner-direction entries in `docs/backlog.md`.
- **Refusal queue (owner decision 2026-09-10).** The two OpenCode Zen 429s
  (`muse-spark-1.3-contributor-free`, `mimo-v2.5-free`) are no longer in the queue, so there is
  nothing to accept: the circuit breaker cools a model that answers 429, and a served success
  clears it. `nim/deepseek-ai/deepseek-v4-flash-0731`'s "degraded function cannot be invoked"
  stays pending, as kimi-k3's does; the stated cost of both is one attempt per walk on each of those
  NIM deployments. The groq network-block refusal also stays pending on purpose (`network-block.ts`
  says never to reject it). The three DeepSeek request-shape refusals in the queue are the
  F10/F11 defects this lap fixed; they should stop once the daemon runs v0.81.0.

### 0.4 Previous laps

- **v0.78.0–v0.80.0 (2026-09-09/10).** The 27-items lap closed every backlog entry open at
  `3abbafd` (route B `wire: "responses"`, the probation band, the first-byte deadline, the crawl
  abort, `POST /stop`, the `maxConcurrent` cap and more); v0.79.0 carried DeepSeek's thinking
  control and pool effort; v0.80.0 made the MCP server reap lane process trees, journal running
  jobs, and refuse a read-only dispatch in the caller's own tree.
- **v0.77.1, the `parseRouting` split (2026-09-09, morning).** Validation order pinned FIRST
  (`test/config/routing-parser-order.test.ts`; cognitive complexity 125 → 12; `parseOffload` and
  `parseLadder` untouched by design). Two pre-existing quirks pinned as behaviour: the
  pool-member warning lacks the `config.` prefix and the consequence sentence, and
  `routing.subagents` stays attached as `{}` when its only entry is dropped.
- **v0.77.0, breaker persistence (2026-09-08/09).** The WHOLE circuit-breaker cell survives a
  restart (failure counters, the credential fault, the served-request ping window
  `GET /telemetry` scores from, quota observations), and every write-behind store flushes at a
  graceful shutdown. Three stated behaviour changes: restore is faithful, not future-only; a
  credential fault survives for its five-minute window (owner-accepted); every outcome dirties
  the file, bounded by `WriteBehindTimer`. Residue: the logon-started daemon dies by
  `TerminateProcess`, so the flush never runs there (backlog). Evidence:
  [docs/history/breaker-persistence-audit-2026-09-08.md](docs/history/breaker-persistence-audit-2026-09-08.md).
- **v0.74.0–v0.76.0, the dispatch lane walk and its safety review.** `dispatch` walks the
  ladder, pins the lane that answered, demotes the one that did not, and budgets each lane from
  its own p80. Three defects fixed in review: a demotion did not retract the pin; the budget
  measured itself; a clamped budget was labelled `history`. ⚠ Review coverage was PARTIAL — 24 of
  33 second-pass findings are UNVERIFIED, two filed in the backlog. ⚠ The demotion is EVIDENCE,
  not a calibrated statistic; never point the HTTP path's numbers at a lane. Full record:
  [docs/history/lane-walk-safety-review-2026-09-08.md](docs/history/lane-walk-safety-review-2026-09-08.md).

### 0.5 Offload, measured

Free lanes CANNOT do open-ended reconnaissance here — 7 of 7 packets fabricated on 2026-09-05.
They CAN review a concrete diff against a stated claim, and they carry a mechanical rewrite with
a stated rule. The test is whether the output can be checked by running or reading something
specific. Never key a fallback on a `null` result; never make a lane the only check.

The 27-items lap (2026-09-09) added the numbers. `opencode-muse-spark` carried six whole
implementation packets ALONE (101–998 s each, clean at `delegate-gate`) and starved every packet
handed to it as a second or third concurrent lane (2100 s, nothing written) — `maxConcurrent: 1`
on its rung is the fix, shipped this lap and owed to the operator config. The free pool hit its
1800 s ceiling on every implementation packet and left a partial tree worth taking. Codex Spark
spent two whole usage windows reading (193k and 477k tokens) and wrote nothing, twice. DeepSeek
on the Codex harness died five of five times on the relay's own 1024 cap. Nine Sonnet lanes
carried the rest at 25–41 minutes each with honest red-then-green evidence. Verify every lane by
running and reading: one lane's test passed with its fix removed, one lane's six-step fallback
silently changed a legacy rule, one lane's threshold triple could never fire, and one lane wrote
the DeepSeek key literal into a scratch launcher despite a brief that forbade it.

### 0.6 Earlier releases

Earlier releases are deliberately not restated here. `git log --oneline`, the tags, and the dated
documents under `docs/` are the trail; what survived each release lives in the `CLAUDE.md` rows
and gotchas.

## 1. What still binds

These were **not** removed and are load-bearing. Do not relax them:

- **Loopback only.** Startup refuses a non-loopback bind. But loopback is not authorization —
  mutating endpoints carry admission checks plus a capability token.
- **Logs are metadata only**, enforced at the sink by an allow-list in `src/log.ts`. Never headers,
  never bodies, never URL parameter *values*.
- **The repair boundary.** The proxy fixes protocol *form* (malformed tool calls), never *judgment*.
  No LLM opinion may enter the request path. Routing comes from config and deterministic
  classification.
- **Destructive tool calls are refused, never fabricated.**
- **Health demotes, never drops.** Learned from a real outage where filtering unhealthy candidates
  narrowed a pool to nothing.

The invariant recalibration is applied and authoritative in `CLAUDE.md` §Invariants and
`docs/project-goals.md`; the retired rules and their replacements are recorded in
[docs/history/rubric-recalibration-2026-08-16.md](docs/history/rubric-recalibration-2026-08-16.md) §2 and in git
history - do not reintroduce them.

## 2. Where to read

| Document | For |
|---|---|
| `CLAUDE.md` | Architecture map, file-to-responsibility table, gotchas. Invariants are authoritative there. |
| `docs/history/metering-reconciliation-2026-08-22.md` | Implemented vs open against the quota-metering spec: gap/stage/decision tables. |
| `docs/history/rubric-recalibration-2026-08-16.md` | What went wrong, the revised invariants (copy-ready), 55 re-adjudicated rejections. |
| `docs/history/credential-fleet-design-2026-08-16.md` | Custody, pooling, cost accounting: components, staged build order. |
| `docs/history/quota-metering-spec-2026-08-16.md` | The metering pipeline: metrics, collection sites, storage, stages. |
| `docs/history/spa-dashboard-design-2026-08-20.md` | Read-only Analytics SPA design, protocol, contract, staged gates. |
| `docs/history/rejection-ledger-2026-08-16.md` | Every past rejection and its reason, grouped by reason-kind. |
| `docs/reference.md` | Full user-facing reference: credential fleets, protected diagnostic surfaces. |
| `docs/history/three-axis-assessment-2026-08-28.md` | The owner's three-axis capability assessment: verdicts per axis, the live-signal finding. |
| `docs/history/advisory-findings-verification-2026-08-28.md` | The 32 advisory findings: the closed-vocabulary bug class and all eight instances. |
| `docs/history/documentation-pass-2026-08-27.md` | The doc-vs-source pass: what was wrong, in what classes, what was deliberately left. |
| `docs/history/dispatch-integration-review-2026-08-27.md` | Historical cross-CLI dispatch review; its AGY focus-safety conclusion is superseded by the next row. |
| `docs/history/dispatch-smoothness-2026-08-31.md` | Current per-agent routing matrix, MCP spawn guarantees, PowerShell/OpenCode repairs. |

## 3. Verification — the one gate

```bash
npm run gate
```

- `npm run gate` = `npm run build && npm run check`. It is ONE script because
  `verify-green.mjs record -- <cmd>` takes one command, and a fresh lap worktree has no `dist/`
  (gitignored), so `check:package` fails unless the build ran first. Record the ledger with
  `node ~/.agent-config/verify-green.mjs record -- npm run gate`.
- `npm run check` = both typechecks (`src/` and `test/`) + the server vitest suite + the dashboard
  checks (`tsc -p dashboard/tsconfig.json --noEmit` and the dashboard suite) + the package checks
  (bundle-inventory equality, size ratchets, packed smoke). **CI runs exactly this and nothing
  else.**
- Bundle sizes live in `docs/dashboard-package-baseline.json` and are ratcheted: regenerate the
  baseline in the SAME change that adds or removes bundle weight, or `check:package` goes red.
- Tests read `src/` directly; `scripts/*.mjs` read `dist/` - rebuild before running any script.
- Some tests are POSIX-only and skip on Windows; CI's ubuntu leg is the only place they run. A
  store path nested under a regular file reads `ENOENT` on Windows but `ENOTDIR` on Linux, so
  fixtures inject the stat/read seam.
- A failing test may pin a defect it should have caught; fix test and source in one commit.
- A test doing real machine work has the machine's worst case in its 5 s budget: a spawn measured
  at ~50 ms idle took 2.8–4 s under full-suite contention and flaked two CLI tests for weeks. Fix
  at the root with an injected seam, never by raising one test's timeout.
- Static analysis (`npm run analysis:run`) is advisory and deliberately outside the gate.

## 4. Things that will bite you

1. Do not trust this repo's documentation without checking source; three mechanical guards exist
   (`test/architecture-map.test.ts`, `test/scripts-inventory.test.ts`, `test/doc-links.test.ts`)
   and everything a doc SAYS is still unguarded.
2. A recorded "open gap" is a claim; verify its mechanism before working it.
3. A CLI process's environment is not the running relay's environment; `GET /registry` is
   authoritative for `has_key`.
4. `/health` and `/ping` return 403 by design; use `/telemetry`.
5. Headless offload lanes must be told not to stop and ask.
6. A spent pool member stays walkable by design; address a healthy member directly with
   `--model <provider>/<model>`.
7. A multi-lane burst degrades the free pool it runs on; relaunch each dead lane pinned to a
   different healthy member from `/candidates`.
8. The vitest interpretations/fact stores are per-PROCESS files; assert entry-specific facts,
   never queue lengths.
9. Worktrees: edit and run tests in that path; `vitest.config.ts` scopes the suite on purpose.

## 5. Definition of done

- `npm run gate` green on a clean, committed tree.
- Both request paths covered by any new policy.
- New behaviour pinned by a test. Failover tests use **≥2 candidates** — with one candidate,
  "fails over correctly" and "cannot fail over" are the same observation.
- Commit trailer names the model that authored the change:
  `Co-Authored-By: <model> <noreply@anthropic.com>`.
- No half-done state. Deliberate intermediate states must be called out explicitly so they are not
  mistaken for bugs.

## 6. Recorded trades with no other home

Everything here is a settled trade kept for its reason, not work; the queue is `docs/backlog.md`.

1. **Custody residuals (v0.45.0):** `keys rotate` mints the control token when no relay runs (same
   side effect as `cooldowns clear`); the macOS `security` and Linux `secret-tool` lanes have
   injected-double coverage only, no CI leg runs them. (The keystore flake of 2026-09-09 is
   closed: its mechanism was a four-character leak-check needle colliding with base64 ciphertext,
   and the shared worker-default path only made the haystack longer; both halves fixed in
   `test/keystore.test.ts`.) Plan:
   [docs/history/custody-sprint-plan-2026-08-24.md](docs/history/custody-sprint-plan-2026-08-24.md).
2. **SPA and test nits standing:** the flat 30 s poll with no failure backoff (mitigated by
   abort-on-hide/offline), the CSS-structure test mirroring styles.css, a few wall-clock-sleep
   tests, dashboard fixtures cast via `as unknown as`, `aria-description` support patchier than
   described-by, SIGKILL leaking the test interpretations file; and the misleading body-problem
   error codes (N8), a versioned wire change no consumer reads. (Theme preference now defaults to
   dark and persists via `localStorage`, closed 2026-09-16.)
3. **`delegate-gate` findings waived (2026-09-04, extended 2026-09-09):** the module-level
   `servers` test-fixture pattern and `as unknown as typeof fetch` casts are pre-existing
   repository convention, not new defects. Added 2026-09-09, each with its reason in the commit
   that carries it: a partial-`Config` fixture cast `as unknown as Config` where the file's own
   `Harness` already casts a partial literal (P8); the tautological-assertion detector's
   local-helper false positive (`provider()`, `budgetOf()`); a double cast through the accounting
   store's returned `writerStatus` reference to reach a `lease_refused` state that has no
   single-process producer (P11-b); a `WeakMap` set on the Responses path that the Chat path
   in the same file already performs (P7); and, for the probation band (P13), the same
   local-helper false positive (`attempt()`) plus an `as unknown as typeof fetch` cast that is
   `test/dynamic-pools.test.ts`'s existing fixture convention.
4. **Where every other settled decision lives:** the owner decisions of 2026-09-04 (`freeOnly`
   stays `false`; contributor SKUs route automatically) in the `dynamic-pools.ts` row of
   `CLAUDE.md` and `docs/history/muse-spark-1.3-opencode-zen-2026-09-04.md`; the Class B deferrals, the
   type-level 7 keep and the WITHDRAWN currency-per-week spend ceiling in
   `docs/history/advisory-findings-verification-2026-08-28.md`; the dropped Gaps 15/16/P4 and the accepted
   streaming usage parity in `docs/history/metering-reconciliation-2026-08-22.md` §7; the uncovered-areas
   verdicts in `docs/history/uncovered-areas-review-2026-08-26.md`.
