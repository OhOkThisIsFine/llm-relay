# Stabilization plan — 2026-09-17 (v0.84.0 baseline, commit `bd3d512`)

**Purpose.** One work queue that gets llm-relay to stable, smooth operation and clears the backlog
and the open bugs. Each item is a PACKET: small, self-contained, and checkable by running
something. A cheap model implements a packet; the orchestrating session verifies and commits it.
This document plans; it changes no source.

**Sources.** `docs/backlog.md` (six entries), `HANDOFF.md`, the residues stated in `CLAUDE.md`, the
llm-relay entries in `C:\Code\docs\backlog.md`, and a read-only survey of the live relay on
2026-09-17 (telemetry, candidates, ladder, refusal queue, lane statistics, breaker state, MCP job
archive, accounting store). Every figure below is a snapshot of one machine on one day. Measure
again before you quote one.

**Owner decisions that shape this plan (AskUserQuestion, 2026-09-17).**
1. Scope: all filed items plus a live-state survey.
2. Machine-wide llm-relay product items are included, EXCEPT "a lane that ended without an answer
   is returned as an answer" (declined 2026-09-10 and 2026-09-16; it stays out).
3. ~~The plan proposes a `capability` value per lane~~ — REVERSED at the closeout the same day:
   a lane's capability must come from the synced capability data (leaderboards, OpenRouter), never
   from a hand-set value. See D6.

**Owner decisions at the closeout (AskUserQuestion, 2026-09-17).**
- D2 hot reload: APPROVED — design `POST /reload`.
- D3 growing cooldowns for repeated 5xx and 402: APPROVED — packet S5.
- D4 operator-declared prices: DECLINED — DeepSeek stays "Unpriced".
- Capability: derive it from data — design item D6 replaces operator task O1.

---

## 1. How to run a packet (rules for the orchestrator)

1. One packet, one lane, one worktree under `C:/Code-worktrees/llm-relay/`. Never dispatch a
   write-capable lane into the main checkout.
2. Put the packet text in a file and cite the path in the dispatch task. Keep the task under
   4,096 characters for `opencode-muse-spark`.
3. Run at most three lanes at one time. Run `opencode-muse-spark` alone (`maxConcurrent: 1`).
4. A packet marked **[cheap]** fits a free lane or Haiku. A packet marked **[mid]** needs Sonnet
   class: it crosses more than three files or needs a design choice inside the packet.
5. Where a packet has an `a` (source) and a `b` (tests) half, dispatch them as two packets. A free
   lane wrote the source half and then timed out on the tests (2026-09-08).
6. After a lane returns: read `git status --porcelain` and `git diff`. Run
   `llm-relay delegate-gate <diff> --repo <root>`. Run the packet's proof command. INVERT the fix
   and confirm the new test goes red. Then run `npm run gate`.
7. A lane never commits. The orchestrator commits with the co-author trailer of the model that
   wrote the change.
8. Every packet inherits the repository rules: both request fronts, at least two candidates in a
   failover test, a closed union gets a total `Record` closed with `satisfies`, unknown stays
   `null`, and the `CLAUDE.md` row of each changed module changes in the same commit.
9. Measure the package size LAST. Packet W0-1 gives headroom first.

**Proof command shorthand.** `T(<file>)` means `npx vitest run <file>`. `GATE` means
`node ~/.agent-config/verify-green.mjs record -- npm run gate`.

---

## 2. Order of work

| Wave | Packets | Why this order |
|---|---|---|
| 0 | W0-1, W0-2, W0-3 | Headroom and hygiene. W0-1 unblocks every packet that adds a file. |
| 1 | B1a, B1b, B1c, B4a, B4b, S2, S3, R1 | Small, independent, low risk. Any order, three at a time. |
| 2 | B2a, B2b, M1a, M1b, S4, S5 | Dispatch quality and pool health. B2 and M1 both touch `src/mcp/server.ts`: run them in sequence, not in parallel. S5 is in section 8 under D3. |
| 3 | B3a, B3b, B3c | The dashboard ladder panel. In sequence. |
| 4 | O2 to O5 | Operator tasks. No code. The owner or an operator session does them. O1 is withdrawn. |
| 5 | D1, D2, D5, D6 | Each needs a strong-model design (or, for D1, the S4 measurement) BEFORE a packet exists. D3 became packet S5; D4 is declined. |

One release after each wave is sufficient. Use the `/release` skill.

---

## 3. Wave 0 — headroom and hygiene

### W0-1 [cheap] Raise the package ceilings
- **Fact.** The gate on 2026-09-17 measured `packageEntries` 428 against a ceiling of 430, and
  `packBytes` 1124988 against 1150000. One new `src/` file adds three or four entries. The next
  packet that adds a file turns the gate red.
- **Edit.** `docs/dashboard-package-baseline.json`, block `ceilings`: `packageEntries` 430 → 480,
  `packBytes` 1150000 → 1300000, `unpackedBytes` 5800000 → 6500000. Update the `observed` block
  and `observedAt` from the gate output. Edit by hand; `scripts/dashboard-package-check.mjs` has no
  update flag.
- **Doc.** `CLAUDE.md` still states the ceiling as "1100000 / 5500000 since 2026-09-08". Replace
  the figures with the new ones and the date. Keep the rule "a round number well clear of the
  observation".
- **Proof.** `npm run gate` passes. No source file changes.

### W0-2 [cheap] Clear the `fast-uri` audit finding
- **Fact.** `npm audit` reports one HIGH finding: `fast-uri`, transitive through `ajv` (a runtime
  dependency).
- **Edit.** Run `npm audit fix` WITHOUT `--force`. Only `package-lock.json` may change. If the fix
  needs a major bump of `ajv`, stop and report; do not force.
- **Proof.** `npm audit --json` shows zero high findings. `GATE` passes. `T(test/validator.test.ts)`
  passes.
- **Not in scope.** The eight major-version lags in development dependencies (`typescript` 5 → 7,
  `vite` 6 → 8, `vitest` 4 → 5, `tailwindcss` 3 → 4 and others). See D5.

### W0-3 [cheap] Prune lapsed rows from `dispatch-exhaustion.json`
- **Fact.** The file holds four rows whose `until` is in the past. Restore ignores them, so there
  is no routing effect; the file misleads a reader.
- **Edit.** In `src/dispatch-exhaustion-persistence.ts`, the write path must drop a row whose
  `until` is not in the future. `exportExhaustedRows` in `src/dispatch.ts` takes `now`; confirm it
  filters, and fix the side that does not.
- **Test.** `test/dispatch-exhaustion-persistence.test.ts` (or the file that holds those tests):
  seed one live row and one lapsed row, flush, read the file, assert one row.
- **Proof.** The new test fails with the filter removed.

---

## 4. Wave 1 — small independent packets

### B1 The dispatch walk carries budget code that stops no lane (`docs/backlog.md` entry 1)
**Property.** No code computes a figure nothing reads. A config that sets `attemptMs`,
`agentAttemptMs` or `attemptQuantile` loads with a warning that names the key and says it has no
effect. Never a hard error.

**Verified facts.** `formatAttemptBudget` (`src/dispatch.ts`) has no caller in `src/`.
`DispatchLane.attemptBudget` is written by `annotateLaneHistory` and read nowhere in `src/`.
`laneHistoryFacts` also computes `timeToAnswer`, `recentFailures` and `failing`; those three HAVE
readers (`src/mcp/server.ts` renders them; `rankSelectable` orders on `failing`). Keep them.

- **B1a [cheap] source, `src/dispatch.ts`.** Delete `formatAttemptBudget`, `MAX_ATTEMPT_BUDGET_MS`,
  the `attemptBudget` field of `DispatchLane`, the `budget` member of the facts type, the budget
  half of `budgetFromSamples` / `laneHistoryFacts`, and the write in `annotateLaneHistory`. Keep
  `quantileWallClockMs` use for `timeToAnswer`. Then Grep `src/` for `raisedBy`,
  `abandonedSinceSuccess` and `attemptMinSamples`: for each, state in the report whether a reader
  remains. Delete only what has no reader. Do not change `dispatch-lane-stats.ts` row shape (an
  older file must still load).
- **B1b [cheap] config warning, `src/config/routing-parser.ts`.** `parseDispatchWalk` must take the
  `warnings: string[]` array (the `parseMcpSettings(raw, warnings)` pattern). For each of
  `attemptMs`, `agentAttemptMs`, `attemptQuantile` (and `attemptMinSamples` when B1a found no
  reader) that the operator SET, push one warning:
  `config.routing.dispatchWalk.<key> has no effect since v0.84.0: the walk stops a lane only when it is idle (idleMs).`
  Keep the existing validation throws unchanged, so `test/config/routing-parser-order.test.ts`
  needs no new row. `parseOptionalBlocks` passes `warnings` through. Keep the keys in
  `DispatchWalkSettings` (`src/config-types.ts`) so old configs load.
- **B1c [cheap] tests and docs.** Delete or rewrite the assertions on removed symbols in
  `test/dispatch-attempt-budget.test.ts` and `test/dispatch-history-facts.test.ts`; keep every
  `timeToAnswer` / `recentFailures` / `failing` assertion. Add to `test/config.test.ts`: a config
  that sets all three keys loads, and `cfg.warnings` holds three entries that name the keys. Trim
  the `dispatch.ts`, `config-types.ts` and `mcp/server.ts` rows of `CLAUDE.md` and the
  `attemptBudget` doc comments. Update `docs/reference.md` where it documents the three keys.
- **Proof.** `npm run typecheck && npm run typecheck:test`; `T(test/config.test.ts)`;
  `T(test/config/routing-parser-order.test.ts)`; Grep `src/` for `attemptBudget` returns nothing.
- **Close.** Delete backlog entry 1.

### B4 A job killed by an MCP server restart carries no tree delta (`docs/backlog.md` entry 6)
**Property.** The running-job journal keeps a bounded copy of the starting status. Orphan adoption
renders the delta for the killed job.

- **B4a [cheap] journal, `src/mcp/job-journal.ts`.** Add optional
  `JournalRow.startingTree?: { prefix: string; entries: [string, string][]; scope?: string[] }`.
  Bound `entries` to `MAX_ACTIVITY_STAT_PATHS` (import it from `src/mcp/tree-delta.ts`); when the
  snapshot is larger, store nothing (unknown stays absent; never a truncated snapshot, because a
  truncated start would report false additions). Extend `isJournalRow` field by field; a row with
  a malformed `startingTree` loads WITHOUT that field, the row itself survives. Add
  `noteStartingTree(jobId, tree)`. In `src/mcp/server.ts` `startTreeDelta`, call it after the
  first successful read.
- **B4b [mid] adoption, `src/mcp/server.ts` and `src/mcp/lane-runner.ts`.** `adoptOrphans` runs
  synchronously in the `LaneJobStore` constructor and has no git reader. After construction,
  `McpDispatchServer` starts one asynchronous pass: for each adopted `killed` job whose journal row
  carried `startingTree`, read the current tree through the existing `treeSnapshot` seam, render
  with `renderTreeDelta`, and store through `LaneJobStore.noteTreeDelta` (it already re-archives a
  terminal job). The block must say the delta is measured at adoption time, not at the time of
  death. A failed read records nothing. `adoptOrphans` must carry `startingTree` onto the adopted
  job (or return it) before the journal drops the row.
- **Tests.** Extend `test/mcp-tree-delta.test.ts` and `test/mcp-restart-report.test.ts`: journal a
  job with a starting tree, build a second server on the same journal path with an injected
  `treeSnapshot`, assert the `killed` job's answer holds the `tree delta` block and the paths. Add
  the negative control: no `startingTree` ⇒ no block. Under vitest `defaultTreeSnapshot` returns
  null, so inject the seam.
- **Proof.** Both tests fail when `noteStartingTree` is not called.
- **Close.** Delete backlog entry 6. Update the `mcp/tree-delta.ts` and `mcp/job-journal.ts` rows.

### S2 [cheap] `GET /telemetry` states the daemon version
- **Fact.** `/telemetry` has no version field. A daemon started before a release keeps old code,
  and nothing on the wire says so. The MCP server has this notice already (`withVersionNotice`);
  the daemon does not.
- **Edit.** `src/telemetry.ts`: add `version: string` to the report. `src/server.ts` / `runProxy`
  supplies the running package version through the same injection the MCP server uses (never
  `npm_package_version`: a host that starts the binary directly does not set it). `src/cli.ts`:
  the commands that already read the running relay's telemetry for the config staleness notice
  (`routing show|get`, `config show|get`, `offload status`) also print one stderr line when the
  daemon version differs from the installed version:
  `the running relay is v<x>; the installed package is v<y> — restart the relay to load it`.
- **Test.** `test/telemetry.test.ts`: the report carries the injected version. A CLI test: a
  mismatch prints the line on stderr and leaves stdout JSON unchanged.
- **Proof.** The test fails with the field removed.

### S3 [cheap] A first-byte deadline fire is logged as what it is
- **Fact (`CLAUDE.md` `candidate-runner.ts` row, stated residue).** `AttemptRun.firstByteTimedOut`
  is set in `src/candidate-runner.ts` and never read, so a first-byte fire logs like a
  total-deadline fire.
- **Edit.** Add `FIRST_BYTE_ERROR_KIND = "backend_first_byte_timeout"` beside `CRAWL_ERROR_KIND`.
  Where the attempt's failure record builds `errorKinds`, push it when `run.firstByteTimedOut`.
  Provenance stays `deadline`, so `failureCooldown` is unchanged.
- **Test.** Extend the existing first-byte cases in `test/pool-failover.test.ts` (Grep for
  `firstByteTimeoutMs`): on BOTH fronts, with two candidates, the log record of the
  failed attempt holds the new kind, and the second candidate serves.
- **Proof.** The assertions fail with the push removed.

### R1 [cheap] Remove stale documentation claims
- `CLAUDE.md` `hedge-race.ts` row says the post-commit stall or crawl policy "needs an owner
  decision (`docs/backlog.md`)". The crawl watchdog shipped 2026-09-09 (`withCrawlWatchdog`) and
  `docs/backlog.md` holds no such entry. Rewrite the sentence: the post-commit policy exists (stall
  and crawl watchdogs abort and let the client retry); no hedge replaces a committed stream.
- `HANDOFF.md` §0.4 says 24 of 33 lane-walk review findings are unverified. The review document
  (`docs/history/lane-walk-safety-review-2026-09-08.md`) does not list them by id, and v0.84.0 removed the
  budget stop that most of them concerned. Add one sentence that says so. Do not claim they are
  verified.
- **Proof.** `T(test/doc-links.test.ts)` and `T(test/architecture-map.test.ts)` pass.

---

## 5. Wave 2 — dispatch quality

### B2 An idle AGY, Codex or OpenCode lane is judged on output and file changes only (`docs/backlog.md` entry 2)
**Property.** Either such a lane gives the walk a live signal, or a measurement shows no such lane
was stopped while it still worked. This plan takes the first branch: process-tree CPU time.

- **B2a [mid] reader, new file `src/mcp/process-cpu.ts`.** Export
  `type ProcessCpuReader = (rootPids: number[]) => Promise<number | null>` and
  `defaultProcessCpuReader`. The result is the summed CPU milliseconds of each root pid and all of
  its descendants, or `null` when the read fails or finds no process.
  - Windows: one `execFile` of `powershell.exe -NoProfile -NonInteractive -Command` with
    `Get-CimInstance Win32_Process | Select-Object ProcessId,ParentProcessId,KernelModeTime,UserModeTime | ConvertTo-Json -Compress`,
    `windowsHide: true`, timeout 10 s. `wmic` is absent on this machine; do not use it. Build the
    tree from `ParentProcessId` in Node. The two time fields are in 100 ns units.
  - POSIX: `ps -A -o pid=,ppid=,time=`; parse `[[dd-]hh:]mm:ss`.
  - Under vitest the default reader returns `null` without a spawn (the `winenv.ts` guard).
  - Pure helpers (`descendantsOf`, `parsePsTime`, `sumCpuMs`) are exported for unit tests.
  - Spawn through the same pattern `killTree` uses in `src/mcp/lane-runner.ts`. No new dependency.
- **B2b [mid] wiring, `src/mcp/server.ts`.** Add `readProcessCpu?: ProcessCpuReader` to
  `McpServerDeps`. `runMcp` in `src/cli.ts` injects the default. In `latestActivity`, read CPU time
  ONLY when no other signal is newer than one `IDLE_POLL_MS` (the rule the tree read already
  follows), and only for a lane with registered pids. Keep the last reading per job. An INCREASE
  of at least 1,000 ms since the last reading counts as activity now, source `process CPU time`.
  `null` is no signal, never idle. The first reading sets the baseline and proves nothing.
  `LaneJob.lastActive` then shows the source, so `dispatch_status` prints it.
- **Tests.** Unit tests for the three pure helpers, with a Windows JSON fixture and a `ps`
  fixture. In `test/mcp-walk-extension.test.ts`: a lane with no output, no relay traffic and no
  tree change, whose injected CPU reader rises on each poll, is NOT stopped after `idleMs`; with a
  flat reader it IS stopped; with a `null` reader behaviour equals today.
- **Proof.** The first walk test fails with the CPU branch removed.
- **Stated cost.** One PowerShell start per idle poll, about 0.3 to 1 s of CPU, only while a lane
  is otherwise silent.
- **Close.** Delete backlog entry 2. Update the `mcp/server.ts` row (the sentence "A lane that does
  not talk to this relay … has only the output and tree signs").

### M1 The answer of an AGY lane is wrapped in AGY's own JSON record (`C:\Code\docs\backlog.md`, "A `dispatch` reply's body is NOT the lane's answer for a CLI rung")
**Fact.** `jobAnswerBody` in `src/mcp/server.ts` returns `job.stdout.trim()` verbatim. An AGY rung
prints `{"conversation_id":…,"status":"SUCCESS","response":"<answer>","duration_seconds":…,"usage":{…}}`.
The audit-tools project lost 19 of 62 calls to this envelope. This is protocol FORM, a closed
envelope from a known binary; to unwrap it is inside the repair boundary.

- **M1a [cheap] module, new file `src/mcp/lane-envelope.ts`.** First step: read ONE archived
  `agy-gemini` job from `~/.llm-relay/mcp-job-archive.json` and confirm the exact key set. If the
  shape differs from the fact above, STOP and report. Then export
  `unwrapLaneEnvelope(lane: LaneId | null, stdout: string): { body: string; unwrapped: "agy" | null }`.
  Rules: only when `lane === "agy"`; the WHOLE trimmed stdout must parse as one JSON object;
  `response` must be a string and `conversation_id` must be present; anything else returns the
  input unchanged with `unwrapped: null`. No heuristic, no partial parse, no other lane. The lane
  table is a total `Record` over the lane-binary union from `src/lane-manifest.ts`, closed with
  `satisfies`, so a new lane binary is a compile error there.
- **M1b [cheap] wiring, `src/mcp/server.ts`.** Apply it in `jobAnswerBody` and BEFORE the
  `isContentEmpty` check (an envelope around an empty `response` is an empty answer). Identify the
  lane with `laneOfRung`, which sees through the `lane-launch.ps1` wrapper. Announce it: the
  provenance block gains one line `unwrapped: agy response envelope`. The archived stdout stays
  the raw record.
- **Tests.** Unit table for the module (valid, not JSON, JSON array, missing `response`, non-string
  `response`, trailing text, a non-AGY lane with the same stdout). In `test/mcp-server.test.ts`: an
  AGY-shaped stdout renders the inner answer plus the announcement line; an empty inner `response`
  is a failure with `EMPTY_OUTPUT_REASON`.
- **Proof.** Both server tests fail with the wiring removed.
- **Follow-up outside this repository.** The standing trap in `C:\Code\docs\backlog.md` becomes
  untrue after the release. See O5.

### S4 [mid] A lane in flight survives a statement of intent to restart — MEASUREMENT packet
- **Fact.** 14 of 83 archived MCP jobs are `killed` by an MCP server restart; 11 of them were
  `agy-gemini` runs. The restart comes from the host (a Desktop restart, a package reinstall), not
  from a lane fault. This is the largest measured loss of dispatch work.
- **This packet measures; it does not fix.** Write `scripts/measure-lane-orphan.mjs` (reads
  `dist/`; rebuild first). It starts an `llm-relay mcp` child on an isolated config and port, starts
  one long fake lane (a Node script that writes a line each second for 60 s to a file), kills the
  MCP child with `taskkill /F` WITHOUT `/T`, and then reports: is the lane process alive, did it
  finish, does its output file hold 60 lines. Run it on Windows. Record the result in
  `docs/lane-orphan-measurement-<date>.md`.
- **Why.** The result decides D1. If the lane survives, D1 can re-adopt it. If it dies with the
  parent, D1 needs a detached start.
- **Measured 2026-09-19 (S4 complete).** Windows `taskkill /F` of the MCP PID WITHOUT `/T`
  killed the in-flight fake lane too: it was not alive 500 ms later and produced 1 of 60 expected
  lines. Evidence: `docs/lane-orphan-measurement-2026-09-19.md`. D1 therefore needs detachment
  (or an equivalent independent process lifetime) before re-adoption can preserve running work.

---

## 6. Wave 3 — the dashboard ladder panel (`docs/backlog.md` entry 5)

**Property.** A ladder panel in the SPA reads `GET /dispatch` (tokenless, same origin), offers
pin and unpin per selectable lane on the shown tier, sends the operator-entered control token on
`POST /dispatch`, and reads the ladder again after the response. The page never persists the token,
and the token never appears in the snapshot.

**Verified facts.** `DASHBOARD_STATIC_CSP` has `connect-src 'self'`, and `/dispatch` is on the same
origin: no CSP change. `GET /dispatch` is in `TOKENLESS_CONTROL_READ_PATHS` (`src/server.ts`). The
token header is `x-llm-relay-control-token` (`CONTROL_AUTHORIZATION_HEADER`,
`src/control-authorization.ts`). The body keys are closed: `PIN_BODY_KEYS` in `src/routes/admin.ts`
(`pin`, `unpin`, `tier`, `ttlMs`, `client`). The response announces `x-llm-relay-lane-pin`.

- **B3a [cheap] API layer, `dashboard/src/api.ts`.** Add `fetchLadder(tier?: string)` →
  `GET /dispatch?tier=<tier>` and `setLanePin(args: { laneId; tier?; action: "pin" | "unpin"; token })`
  → `POST /dispatch` with `content-type: application/json` and the token header. Read the exact
  body shape from `test/admin-dispatch-pin.test.ts`; do not guess it. Use the existing
  `readOrThrow` / `DashboardApiError` pattern WITHOUT the dashboard session header. Declare a local
  `LadderViewV1` type with only the fields the panel reads: `tier`, `order`, and per lane `id`,
  `kind`, `spec`, `state`, `position`, `pinned`, `demoted`, `failing`. Do NOT import
  `src/dispatch.ts` into the bundle: `dashboard-contract.ts` is platform-free by rule and
  `dispatch.ts` is not. Tests: fetch mocks assert the URL, the method, both headers, the body, and
  that the token goes nowhere except that header.
- **B3b [mid] component, new file `dashboard/src/components/LadderPanel.tsx`.** A tier selector
  (`low`, `medium`, `high`, `xhigh`; hide it when the view reports the legacy single ladder), a
  table of lanes in `order` with state badges, and a Pin or Unpin button on each lane whose
  `state` is `ready`. A password-type input holds the token in component state ONLY: no
  `localStorage`, no `sessionStorage`, no URL, no log. After a POST the panel calls `fetchLadder`
  again. A refusal renders the server's own error message. Tests with Testing Library
  (`dashboard/src/components/dashboard.test.tsx` conventions): render from a fixture, pin sends
  the right call, the ladder is read again, a 401 shows the message, and after unmount and remount
  the token input is empty.
- **B3c [cheap] page wiring.** Add the panel to `dashboard/src/pages/AnalyticsDashboard.tsx` as a
  collapsible `<details className="panel">` section with an `<h2 id>` and a `PANEL_LINKS` entry.
  Add styles to `dashboard/src/styles.css`; the CSS-structure test mirrors that file, so update it
  in the same packet. Regenerate the `observed` block of `docs/dashboard-package-baseline.json`
  LAST. Update `docs/reference.md` "Pinning a lane by hand" and the `CLAUDE.md` dashboard rows.
- **Proof.** `npm run check:dashboard` and `GATE`. Then a live check by the orchestrator: start the
  relay from the worktree build, open `llm-relay dashboard`, pin a lane, and confirm with
  `curl -s "http://127.0.0.1:<port>/dispatch?tier=<tier>"` that the lane leads `order`.
- **Close.** Delete backlog entry 5.

---

## 7. Wave 4 — operator tasks (no code)

### O1 WITHDRAWN — do not hand-set `capability` values
The owner rejected hand-set values (2026-09-17): a lane's capability comes from the synced
capability data. The lane statistics table this item carried measured whether a lane ANSWERS, not
what its model can DO, which is the axis confusion `benchmarks.ts` already forbids ("telemetry
measures whether a deployment answers, not whether the model can reason"). Do not set
`capability` in `~/.llm-relay/config.json`. See D6.

### O2 Verify the v0.84.0 walk through a restarted MCP process (`HANDOFF.md` "Not verified yet")
The owner restarts Claude Desktop. Then, from the Code tab: dispatch a pool task that takes more
than 60 s. Pass: one call returns the answer, and `dispatch_status` shows
`last activity: … (relay traffic)`. Record the result in `HANDOFF.md`.

### O3 Decide the fate of lanes that never answered
`agy-claude-opus` answered 0 of 36 calls and `agy-claude-sonnet` 2 of 14. The global instruction
says all 12 AGY rungs stay enabled (owner decision), and the walk already orders a lane with five
own failures last (`FAILING_LANE_STREAK`). So the cost today is small. Present the numbers to the
owner once; do not disable a rung without the owner.

### O4 Clear the refusal queue (nine items need a verdict; one stays pending)
A dispatcher may `llm-relay eligibility propose`; only the owner may `accept`. Use the `--sig`
digest that the listing prints, never a bare index.

| Item | Count | Proposed verdict |
|---|---|---|
| `groq/qwen/qwen3.6-27b` 403 | 300 | LEAVE PENDING. It is the client network block (`network-block.ts`). Never `reject`. |
| `deepseek/deepseek-v4-pro` 402, `deepseek/deepseek-flash` 402 | 5 + 5 | Read the message. If it states insufficient balance: `allowance-exhausted`, scope `credential`, `--cost-class paid`. |
| `deepseek/*` 400 (three items) | 23 | Read each message. If it is a request-shape refusal that v0.81.0 fixed (F10, F11), `reject` it as a relay defect already closed, and confirm no new occurrence after 2026-09-10. |
| `opencode/muse-spark-1.3-contributor-free` 400 and 403 | 44 + 8 | The 400 is `MissingSessionID` (route B block). Propose `not-servable`, scope `deployment`. It evicts the deployment from pools until the fact expires, which stops 58 wasted attempts in a row. |
| `nim/moonshotai/kimi-k3` 400, `nim/deepseek-ai/deepseek-v4-flash-0731` 400 | 48 + 2 | "degraded function cannot be invoked". Owner decision 2026-09-10: stays pending, cost one attempt per walk. Ask again only if the count keeps rising. |

Also remove `opencode/muse-spark-1.3-contributor-free` from `routing.pools.medium.preferred` in
`~/.llm-relay/config.json` (it was pinned first on 2026-09-10 for route B; it now only fails).

### O5 DONE (2026-09-17) — the llm-relay notes left the machine-wide backlog
The owner ruled the same day that nothing llm-relay-specific belongs in `C:\Code\docs\backlog.md`:
such instructions live with the llm-relay skill. Twenty-nine entries moved into
`skills/llm-relay/references/lane-field-notes.md`, which the installer now ships to all three
hosts, and each was refreshed against v0.84.0 first. The table below records what was corrected,
because a later reader may meet the old wording in git history.

| Entry | Verdict |
|---|---|
| "The `llm-relay` MCP server can RESTART mid-run and lose EVERY job id" | Untrue since v0.80.0 / v0.82.0: `job-journal.ts` reports `killed`, `job-archive.ts` keeps finished jobs. Rewrite it as: a restart still KILLS running lanes (see D1). |
| "Relay dispatch job IDs are scoped to the MCP client/server instance" | Untrue since v0.83.x: shared journal and archive, `lookup(id)` reads the disk. |
| "The `llm-relay` MCP `dispatch` tool times out at the CLIENT before a large `waitMs`" | Untrue: `resolveWaitMs` clamps; Claude Code gets the blocking wait. |
| "A direct DeepSeek response can exhaust its token budget without an answer" | Its three causes are closed: thinking control is forwarded (v0.79.0), `dispatch` takes `model` (v0.81.0), a capped Responses answer is announced `incomplete`. Delete after one confirming request. |
| "A relay provider timeout turns a slow model into a fake not servable" | Keep the advice. Add: `/telemetry` `config.changedOnDisk` now reports an unloaded edit, and `firstByteTimeoutMs` exists. |
| "The llm-relay proxy daemon (v0.68.8) loads `config.json` ONCE" | Still true. Its claim that `docs/history/mcp-dispatch-prior-art-2026-08-30.md` is wrong is FALSE: that sentence describes the third-party `agent-dispatch` tool, not llm-relay. Correct the entry. See D2 for hot reload. |
| "A `dispatch` reply's body is NOT the lane's answer for a CLI rung" | Becomes untrue for AGY after M1 ships. Keep the `waitMs` half. |

---

## 8. Wave 5 — needs a decision or a design before a packet exists

Each item states what is true, why it matters, and a recommendation. The closeout of this lap asks
the owner these questions.

### D1 A host restart kills every running lane (17% of archived jobs)
- **True now.** The `llm-relay mcp` process owns its lane children. When the host restarts that
  process, the journal reports the jobs `killed`, and the work is lost.
- **Options.** (a) Accept: the loss is reported, and the caller dispatches again. (b) Detach: start
  a lane with its output redirected to files under the cache directory, record pid and paths in the
  journal, and let the next MCP process re-adopt a live lane or read a finished lane's output.
- **Trade.** (b) removes the largest measured loss. It also weakens the rule "the store reaps what
  it started" (`LaneJobStore.reap`), needs a pid-reuse defence, and is a strong-model design, not
  a cheap packet. S4 measured on 2026-09-19 that the lane dies with its MCP parent on Windows.
- **Recommendation.** Design (b) in its own lap; S4 proves re-adoption without detachment is
  insufficient.

### D2 The daemon does not reload `config.json`
- **True now.** An edit takes effect at the next restart. `/telemetry` and three CLI commands
  report the staleness. Measured cost: a provider timeout edit and a rung edit each served the old
  value without notice (2026-09-03, 2026-09-09).
- **Options.** (a) Keep the report only. (b) `POST /reload` (control token) that re-runs
  `loadConfig` and swaps the parts that are safe to swap: `routing`, provider timeouts, `limits`.
  Objects built at startup (breaker, catalog, ping loop, stores) stay.
- **Recommendation.** (b), designed by a strong model: the hard part is the list of what is safe to
  swap. `setOffload` already mutates the live `Config`, which is the precedent.
- **DECISION (owner, 2026-09-17): (b) APPROVED.** Next step: a strong model writes
  `docs/config-reload-design-<date>.md` that names, for every field of `Config`, whether a reload
  may swap it and which startup object reads it. The design then splits into cheap packets. Until
  then no cheap model starts this item. Two binding points for the design: `/reload` joins
  `CONTROL_ROUTES` (the same admission as `POST /stop`), and a config that fails `loadConfig` is
  refused whole, with the live config untouched.

### D3 A deployment that fails without end is tried on every walk
- **True now.** `opencode/mimo-v2.5-free` has 1,221 failures in a row (HTTP 500);
  `huggingface/moonshotai/Kimi-K3` has 78 (402). A generic failure cools for 60 s or for the time
  it wasted. "Health demotes, never drops" holds, so each walk that reaches the cooling band can
  spend one attempt there.
- **Options.** (a) Keep. (b) Extend the fixed escalation ladder that an unexplained 429 already
  uses (`RATE_LIMIT_ESCALATION_MS`) to consecutive 5xx and 402 failures. The member still only
  demotes; a probe success already ends such a cooldown early.
- **Trade.** (b) is a duration the relay chooses, not one a provider stated. The 429 ladder is the
  existing precedent, and the 402 rung already cools for a fixed hour.
- **Recommendation.** (b). After the decision it is one cheap packet in `src/circuit-breaker.ts`
  with total tables over `CooldownSource`.
- **DECISION (owner, 2026-09-17): (b) APPROVED, including "a successful health probe ends the
  cooldown early".** The packet is S5.

#### S5 [mid] Repeated 5xx and 402 failures get growing cooldowns
- **Verified facts (`src/circuit-breaker.ts` `applyHealthOutcome`).** A 402 without `Retry-After`
  cools a flat `QUOTA_EXHAUSTED_COOLDOWN_MS` (1 h), source `default`. Another failure without
  `Retry-After` cools `failureCooldown(elapsedMs)` once `consecutiveFailures` reaches
  `MAX_FAILURES_BEFORE_TRIP` (2). Any success sets `consecutiveFailures` to 0.
  `endRateLimitCooldown` ends a cooldown early only when `PROBE_SUCCESS_ENDS_COOLDOWN` allows the
  source AND `lastStatus` is 429. `rateLimitCoolingCells` selects cells only through
  `REPROBE_TARGETS_COOLDOWN` and `lastStatus` 429.
- **Edit.**
  1. Add `FAILURE_ESCALATION_MS = [10 min, 1 h, 6 h, 24 h]` beside `RATE_LIMIT_ESCALATION_MS`.
     The step index is `consecutiveFailures - (MAX_FAILURES_BEFORE_TRIP + 1)`, clamped to the last
     step. An index below 0 means "no ladder step". So failures 1 and 2 behave as today, and
     failures 3, 4, 5 and 6 get 10 min, 1 h, 6 h and 24 h. Use the existing counter, which
     `breaker-persistence.ts` already carries; add no new counter.
  2. Generic failure branch: cooldown = the LONGER of `failureCooldown(elapsedMs).ms` and the
     ladder step (when there is one). Source `failure-escalation` when the ladder step wins,
     otherwise the source `failureCooldown` returned. State the indexing in a comment.
  3. 402 branch without `Retry-After`: cooldown = the LONGER of 1 h and the ladder step, source
     `failure-escalation` when the ladder wins.
  4. Add `failure-escalation` to `COOLDOWN_SOURCES`. The two total tables then fail `tsc` until
     both have a row: `PROBE_SUCCESS_ENDS_COOLDOWN` true, `REPROBE_TARGETS_COOLDOWN` true.
  5. `endRateLimitCooldown` and `rateLimitCoolingCells`: for source `failure-escalation`, accept a
     `lastStatus` of 402 or 500–599 instead of 429. Rename neither function (the rename is a
     separate cleanup). Update their doc comments.
  6. `src/availability-snapshot.ts` maps cooldown reasons: a `failure-escalation` row with
     `lastStatus` 402 maps to `rate_limit`, any other to `provider_error`. Find the mapping by Grep
     for `cooldownSource`; if it is a total table, the compiler names the row.
- **Tests (`test/circuit-breaker.test.ts`, `test/rate-limit-recovery.test.ts`,
  `test/breaker-persistence.test.ts`).** Failures 1–2 behave as today; failures 3, 4, 5, 6 cool
  10 min, 1 h, 6 h, 24 h; a success resets the ladder; a 402 series cools 1 h, then 1 h, then 6 h;
  a 200 probe ends a `failure-escalation` cooldown whose last status is 500, and does NOT end one
  whose last status is 401; `rateLimitCoolingCells` lists the escalated cell; a persisted row with
  source `failure-escalation` restores. One failover test with two candidates on each front proves
  the escalated member stays in the walk, behind the others.
- **Proof.** Mutation check: add a seventh `CooldownSource` member and confirm `tsc` fails at both
  tables; remove it. Remove step 2 and confirm the ladder tests fail.
- **Docs.** The `circuit-breaker.ts` and `breaker-persistence.ts` rows of `CLAUDE.md`, and
  `docs/reference.md` where it lists cooldown sources.

### D4 Paid DeepSeek traffic is 99.9% unpriced (23,217 requests in 7 days, 30 priced)
- **True now.** DeepSeek publishes no machine-readable price, and the relay never invents one, so
  `llm-relay cost` cannot state the spend of the provider that leads every pool.
- **Options.** (a) Keep "Unpriced". (b) Add operator-declared prices
  (`providers.<name>.prices`), labelled with a third price source `operator_declared` beside
  `provider_published` and `reference`.
- **Trade.** (b) widens the persisted accounting schema (`accounting-store-schema.ts` is strict:
  a mistake stops persistence silently) and the dashboard contract. Strong-model work with reload
  tests.
- **Recommendation.** (b), in its own lap. It serves the founding metering goal.
- **DECISION (owner, 2026-09-17): (a) — keep "Unpriced". No work.** Do not propose
  operator-declared prices again unless the owner raises it.

### D5 Major development-dependency upgrades
`typescript` 5.9 → 7.0 (also a RUNTIME dependency for `delegate-gate`), `vite` 6 → 8, `vitest`
4 → 5, `tailwindcss` 3 → 4, `jsdom` 26 → 30, and three more. None is a defect today.
Recommendation: one upgrade per lap, `vitest` first, each with the full gate and the package
baseline measured again. Not cheap-model work: a major bump fails in ways a brief cannot predict.

### D6 A lane's capability must come from the synced capability data (owner correction, 2026-09-17)
- **Owner statement.** "The capability value is supposed to be set by data scraped from
  leaderboards, openrouter, etc." The hand-set design is therefore a defect, not a feature to fill
  in.
- **True now.** Commit `42b2745` (2026-09-17, an agent's design) added `LadderRung.capability` as a
  hand-set config value: `applyRungCapability` in `src/config/routing-parser.ts` reads it,
  `rungCapability` in `src/dispatch.ts` copies it to `DispatchLane.capability`, and
  `skipIfBelowTier` in `src/mcp/server.ts` skips a rung below the dispatch tier. No rung on this
  machine sets it, so the skip never fires.
- **What already exists to derive it.** `getStrength()` (`src/benchmarks.ts`) resolves a model's
  capability from `docs/tier-data.json` with its basis. `strengthAllowedForEffort(strength,
  effort)` decides whether a model clears an effort tier (`EFFORT_FLOORS`, an exact SKU match and at
  least three published signals). The effort pools already use exactly this rule. `rungModel` in
  `src/dispatch.ts` reads a CLI rung's `--model` argument.
- **Design (a strong model writes the details; then cheap packets).**
  1. A pure function `derivedCapability(rung, cfg)` in `src/dispatch.ts` (or a new small module)
     returns `{ tier: EffortLevel | null; basis; model }`:
     - a `relay` rung whose spec is `pool/<band>`: the pool's own band (the pool already contains
       only members that clear it);
     - a `relay` rung whose spec is `provider/model`, and a `cli` rung with a `--model`: the
       HIGHEST tier for which `strengthAllowedForEffort(getStrength(model), tier)` is true;
     - anything else (no model, a model the snapshot does not match exactly, fewer than three
       signals): `null` — unknown, which means NO limit. Unknown is never "weak".
  2. `buildDispatch` sets `DispatchLane.capability` from that function, and a new
     `capabilityBasis` field states the source (`snapshot`, `pool-band`, `unknown`), so
     `dispatch_lanes` can print where the figure came from.
  3. The hand-set key: owner to decide in the design review whether to REMOVE it (a config that
     sets it loads with a "no effect" warning, the B1b pattern) or keep it only as an explicit
     override that the output labels `operator-declared`. The plan recommends removal: the owner
     said the value is "supposed to be set by data".
  4. Model-id matching for CLI lanes is the hard part: AGY and OpenCode spell model ids their own
     way (`gemini-3.6-flash`, `muse-spark-1.3-contributor-free`). `findTierModel` already strips a
     price suffix and matches the last path segment; the design must list, per lane binary, which
     ids match exactly today and which need a labelled alias. Measure it: run the function over the
     live ladder and record the result in the design document before any packet starts.
- **Packets after the design.** D6-a pure function plus unit table (inject `tierData`, never pin a
  real model's band — `CLAUDE.md` gotcha); D6-b wiring in `buildDispatch` plus the rendered basis;
  D6-c the config key's fate plus docs.
- **Doc to correct in the same work.** `HANDOFF.md` §0 "Immediate next" tells the owner to set
  `capability` by hand; that sentence is now wrong. (Corrected in this lap's closeout.)

---

## 9. Not work — recorded so that nobody files it again

- **Blocked outside this repository.** Route B's served request (`docs/backlog.md` entry 3): the
  vendor answers `HTTP 400 MissingSessionID` and asks the caller to prove it is the OpenCode CLI.
  The terms position rules that out. The Codex Desktop `relay` agent check (entry 4) needs the
  owner at the keyboard. AGY's stream drop on long outputs is AGY's defect.
- **Declined by the owner.** A lane that ended without a real answer is returned as an answer
  (2026-09-10, 2026-09-16).
- **Accepted trades.** `observeContextLimit` uses `res.clone()` (confined to 400 and 413);
  `lease_refused` has no producer; `parseOffload` and `parseLadder` complexity; the `sse-frames.ts`
  non-adopters; the hedge `margin` and `minSamples` placeholders (the population they need is not
  recorded); the gemini `thoughtSignature` host-scoped default (config can override it); the
  custody residuals and SPA nits in `HANDOFF.md` §6; `usage/recent.json` reports `partial` because
  its detail cap is a design bound, and the day shards are the reliable source.
- **Found clean.** No `TODO`, `FIXME`, `XXX` or `HACK` in `src/`, `scripts/` or `dashboard/src/`.
  All five skipped tests are Windows platform skips. Accounting writer state is `writing`. No
  credential fault is active. The config is not stale.

---

## 10. Exit condition for the whole plan

1. `docs/backlog.md` holds only entries 3 and 4 (both blocked outside the repository) plus any
   design item from Wave 5 that the owner approved.
2. `npm audit` shows no high finding.
3. The refusal queue holds only items that are pending on purpose.
4. `/telemetry` states the daemon version, and it equals the installed version.
5. One Code tab dispatch longer than 60 s answers in one call (O2).
6. `GATE` is green on `main`, CI is green, the release is live, the global bin is reinstalled, and
   the daemon is restarted onto it.
