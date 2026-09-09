# HANDOFF

Entry point for any agent picking up llm-relay, on any provider. Read this before `CLAUDE.md`.

## 0. State as of 2026-09-09 (the breaker-persistence lap, v0.77.0)

**The owner's premise — "circuit breaker state lives only in memory and disappears on restart" —
was partly true, and the part that was true is closed.** Cooldowns had survived a restart since
2026-08-30; the failure counters, the credential fault, the served-request ping window (which
`GET /telemetry` scores stability from) and the quota observations had not, and nothing flushed
the file at shutdown. Owner decision 2026-09-08: persist the WHOLE cell, credential faults
included. Evidence, method and the before/after tables:
[docs/breaker-persistence-audit-2026-09-08.md](docs/breaker-persistence-audit-2026-09-08.md).

- ✅ **`breaker-state.json` now carries every field of every cell**, restored faithfully at start
  (`exportState` / `restoreState` / `onStateChanged` in `src/circuit-breaker.ts`;
  `loadBreakerState` / `saveBreakerState` / `installBreakerPersistence` in
  `src/breaker-persistence.ts`). Measured on an isolated relay against a mock upstream: on v0.76.0
  a hard kill and restart turned `AUTH 401` into `closed` and telemetry into
  `stabilityScore null, observedTargets 0`; on this binary every surface reads after the restart
  exactly as before the kill, with zero requests re-learned from the upstream.
- ✅ **Every write-behind store flushes at a graceful shutdown.** `WriteBehindTimer.flushNow()` and
  `WriteBehindRegistry` (`src/write-behind.ts`) give `breaker-persistence.ts`,
  `dispatch-exhaustion-persistence.ts`, `dispatch-lane-stats.ts` and `lane-affinity.ts` a
  `flush<Store>Persistence()` each; `runProxy` calls all four beside the six older flushes in both
  shutdown sites. Until now those four armed timers inside closures nothing could reach.
- ✅ Version stays 1: every added field is optional on the wire, so a v0.76.0 file loads with
  fresh-cell defaults and a file written now still loads on v0.76.0. **Verified on the production
  daemon's first restart onto v0.77.0:** the 41-row cooling-only file written by v0.76.0 restored
  (the four still-active cooldowns read `OPEN` in `candidates` before any traffic), and one warm
  request later the daemon rewrote it with 42 rows in the new format.
- ✅ **The path-sensitive keyring test is fixed.** `test/os-keyring.test.ts` "sanitizes a thrown
  child error" checked every 4-character window of English-shaped needles against an error whose
  stack carries the checkout's absolute path, so `stdout-super-secret`'s `er-s` matched a worktree
  named `…circuit-breaker-state…` and failed the gate for no reason of the sanitizer's. The needles
  are high-entropy now, as the sibling test's already were.
- ✅ **The dashboard bundle graph is junction-aware.** A lap worktree's `node_modules` is a junction
  to the main checkout, and Vite hands the graph plugin the resolved path, so `check:package`
  refused `../../../Code/llm-relay/node_modules/react` as non-portable. `packageRelativePath` in
  `dashboard/vite.config.ts` maps a directory under the junction's real target back to
  `node_modules/…`; a directory under neither root still fails, which is the case the check exists
  for. The package ceilings moved to round numbers with headroom (1100000 / 5500000) after this
  lap's validators and doc comments crossed 5,000,000 unpacked bytes.

⚠ **Three deliberate behaviour changes, stated rather than left to be discovered.**

1. **Restore is faithful, not future-only.** A lapsed cooldown restores as lapsed (the cell reads
   ready) and KEEPS its `unexplained429s`. The old loader dropped the row, arguing a resurrected
   counter would "send the next single 429 to the top of the ladder" — but the running process does
   exactly that in memory, the counter alone demotes nothing, and only a fresh 429 applies it. A
   restart is not a success. Live consequence: `gemini/models/gemini-3.1-pro-preview` sits at
   `unexplained429s: 78`; a restart after its 24 h cooldown lapses no longer costs four real 429s
   to climb back to that rung.
2. **A credential fault survives a restart while its five-minute window is open.** Stated cost,
   accepted by the owner: a key rotated during a restart reads as faulted for at most that long,
   cleared by the first success or by `llm-relay cooldowns clear`.
3. **Every outcome now dirties the file.** The old "notify only on a cooling change" saving is gone
   because the ping window moves on every request; `WriteBehindTimer` bounds it to one write per
   250 ms of quiet and one per 2 s under load, and the file is one row per credential×model cell
   with a ten-sample window.

⚠ **Residue, filed not hidden.** The logon-started daemon on this machine is stopped by
`TerminateProcess`, which runs no handler, so the graceful flush never runs there and a hard kill
still loses the last two seconds (measured: a kill 50 ms after a request lost that outcome on both
binaries). `docs/backlog.md` carries the property a fix must meet.

⚠ **Offload record.** The implementation packet went to the free pool through MCP `dispatch`
(`job-0001`, `pool/high`). The lane wrote the whole SOURCE half faithfully to the brief and then hit
its 1800 s ceiling before touching the test file — the walk did not move on, because a timeout is
the lane's own ceiling, not the walk budget. The test file was then written by a Sonnet subagent,
the fallback the owner named; the source cleanup (no `now` parameters, one flush mechanism) and
every verification were done here. Nothing the lane wrote was taken on trust: the diff was read,
typechecked, linted, and proven live.

Immediate next is UNCHANGED from the previous lap: **decompose `parseRouting`** (ruled and
scheduled; the risk is validation ORDER, not size — pin the order before splitting). Then the
eligibility queue triage.

### 0.1 The previous lap (v0.74.0–v0.76.0, the dispatch lane walk and its safety review)

`dispatch` walks the ladder for the caller, pins the lane that answered, demotes the one that did
not, and gives each lane a budget derived from its own recorded runs (the 80th percentile of its
window, floored at the flat `attemptMs`). The full mechanism, every invariant and every measured
number lives in the `dispatch.ts`, `lane-affinity.ts`, `dispatch-lane-stats.ts` and
`mcp/server.ts` rows of `CLAUDE.md`, and the review record is
[docs/lane-walk-safety-review-2026-09-08.md](docs/lane-walk-safety-review-2026-09-08.md). Three
things worth carrying in your head:

1. **A demotion did not retract the pin** until v0.76.0, so the walk re-tried the lane it had just
   abandoned, first, for the rest of its pin window. Fixed; the symmetry is now real.
2. **The budget measured itself**: an abandoned lane's wall clock was fed back into the window the
   next budget derives from. Fixed; an `abandoned` run contributes no duration sample.
3. **A clamped budget was labelled `history`.** Fixed; `basis` has three members.

⚠ **Review coverage was PARTIAL.** 24 of 33 findings from the second pass and most of the first
pass's non-concurrency lenses were never verified — their refuters died on the monthly spend limit.
They are UNVERIFIED, not refuted; two are filed in `docs/backlog.md`. ⚠ **The demotion is EVIDENCE,
not a calibrated statistic** — do not point the HTTP path's numbers (250 ms/token, a 30 s ceiling)
at a lane. ⚠ The per-lane stats window is keyed by lane id alone and ignores `tier`; open in the
backlog because it changes the persisted key space.

### 0.2 Carried, untouched by this lap

Each is an Open entry in [docs/backlog.md](docs/backlog.md); that file, not this one, is the queue.

- The logon-started daemon is stopped by `TerminateProcess`, so the shutdown flush that every
  write-behind store now has never runs on this machine; a hard kill loses at most the last two
  seconds (filed 2026-09-08, with the property a fix must meet).
- Triage the eligibility queue (10 unrecognized refusals; the dispatcher proposes by digest, only
  the owner accepts).
- Owner: verify the Codex `relay` agent from Codex Desktop.
- Post-commit stalls (owner decision 2026-09-04: measure first, build only if clients retry).
- Audit residue with properties: the metering silence channel, listener-before-store, the
  forward-path header allow-list, `candidate-runner.ts` export pruning.
- Contributor SKUs route B; route A is live.
- The `dispatch` `waitMs` trap: a job can vanish with `unknown jobId` when the MCP child restarts.
  ⚠ The walk does not close this — it makes ONE dispatch cover more lanes, so a lost handle now
  costs more work, not less. The server half is still an Open entry.

⚠ **On offload, with the measurement from three laps.** Free lanes CANNOT do open-ended
reconnaissance here — 7 of 7 packets failed adversarial verification on 2026-09-05, fabricating
symbol names and line ranges with total confidence. They ARE useful for reviewing a CONCRETE diff
against a STATED claim: a `free-pool` lane checked the CLONE-07 change in 208 s, rebuilt its truth
table from source and correctly found no differences. The distinction that predicts which way it
goes is whether the output can be checked by running or reading something specific. ⚠ Do not key a
fallback on a `null` result — a lane that fabricates returns something. ⚠ And never make a lane the
only check: one review job vanished mid-run when the MCP child restarted.

⚠ **`opencode-muse-spark` is congested, not broken** (owner, 2026-09-05: other agents dispatch to it
concurrently). Prefer `free-pool` or `agy-gemini` while that lasts. ⚠ The lane walk now routes
around this automatically rather than requiring the operator to notice it, which is what the lap
above was for — but congestion itself is unchanged.


## 0.3 Earlier releases

Deliberately NOT restated here. This file holds current state plus the immediate next; a
release-by-release narration is a changelog, and git already has it. `git log --oneline` and the
tags are the trail. What survived each sprint lives in its own home:

- **v0.73.1, the owner rulings (2026-09-06)** — the dialect-rescue destructive check now runs
  BEFORE the argument check (`057fca7`): each parser returns a `DialectScan` carrying every name it
  RECOGNISED, so a malformed payload under a destructive name refuses instead of falling through to
  a retryable `detected`. One clamp for both absolute-deadline write sites in `dispatch.ts`
  (`449bf9d`); the general SEM-06 extraction was declined. The lesson that generalises — a check
  that reads what an earlier stage COMMITTED inherits that stage's discard policy as its own
  trigger — lives in the `CLAUDE.md` gotcha and Status sections. `parseRouting` decomposition was
  scheduled, not done.
- **v0.72.1, the concurrent-ingest lap (2026-09-05)** — `llm-relay mcp` reads and dispatches each
  stdin request the moment it arrives. `McpDispatchServer.serve` replaced the per-chunk
  `await server.ingest(chunk)`, and `ingest` splits synchronously so message order stays write
  order whatever the caller awaits. Measured live against the released v0.72.0 binary on an
  isolated daemon: a status probe answered in under 1 ms instead of after 6.6 s. Stated trades —
  responses may leave out of request order, and there is no concurrency cap; ⚠ a host keeps the OLD
  behaviour until it restarts its `llm-relay mcp` child:
  [docs/mcp-concurrent-ingest-2026-09-05.md](docs/mcp-concurrent-ingest-2026-09-05.md).
- **v0.72.0, the dispatch-telemetry lap (2026-09-04)** — "MCP reports, daemon records": the MCP
  server forwards one metadata-only report per settled agent-mode job to
  `POST /dispatch/telemetry`; the daemon records per-lane stats (`dispatch-lane-stats.ts`, the
  advisory `stats:` column) and one estimated-envelope ledger row for `cli`-kind lanes only
  (owner decisions D1/D2); every packet ran on the free `opencode-muse-spark` lane and a live
  proof on an isolated daemon preceded the release:
  [docs/dispatch-telemetry-design-2026-09-04.md](docs/dispatch-telemetry-design-2026-09-04.md).
- **v0.71.1, the audit-triage lap (2026-09-04)** — every finding in
  [docs/audit-findings-2026-09-03.md](docs/audit-findings-2026-09-03.md) has a verdict in
  [docs/audit-triage-2026-09-04.md](docs/audit-triage-2026-09-04.md) and each verified defect is
  fixed with a pinning test: one declaration for the config vocabulary (`config-types.ts`,
  guarded by `test/one-declaration.test.ts`), the ledger no longer blames the provider for a
  relay-authored refusal, `GET /v1/models` omits an unresolved context window and resolves
  `auto` through the ladder, 413 is classified by the body reader's code, the hedge race settles
  at COMMIT (post-commit remedy: owner decision 2026-09-04, measure first), DR-020 residue and
  `JsonStore` removed. v0.71.0's publish died on a doc link to a concurrent session's untracked
  file; both traps are recorded.
- **v0.69.0–v0.70.0, the dispatch fast-path and token-scaled-hedge laps (2026-09-04)** — the
  `slow` usability band, the `auto` model, MCP `dispatch` answer mode, the `relay` agent for Claude
  and Codex with no pinned model, the input-size-scaled hedge floor, and the DR-020 shrink of the
  accounting writer:
  [docs/dispatch-fast-path-lap-2026-09-04.md](docs/dispatch-fast-path-lap-2026-09-04.md),
  [docs/token-scaled-hedge-lap-2026-09-04.md](docs/token-scaled-hedge-lap-2026-09-04.md).
- **v0.68.7–v0.68.8, the `server.ts` decomposition audit** — a handed-over refactor arrived green
  with four defects the suite could not see (a lost second `tsc` pass, a downgraded HTTP status, a
  validator field `AssistantMessage` never declared, a broken multi-line SSE parse) plus three
  control-flow changes a function-body diff couldn't see either; repaired, remediated and every
  region reviewed: [docs/refactor-consistency-audit-2026-09-01.md](docs/refactor-consistency-audit-2026-09-01.md).
- **v0.58.0, the max-output-caps lap** — the display-only `max-output` measurement fact (parser
  beside the context parser, observer on both fronts, live-verified on groq), and the stale-digest
  lesson (recorded signature digests go stale across a normalizer migration — list before
  addressing): [docs/max-output-caps-design-2026-08-29.md](docs/max-output-caps-design-2026-08-29.md).
- **v0.57.0, the eligibility triage lap** — queue 199 → 4 with owner-approved family verdicts,
  the lane-split signature fix and its load-time store migration, the Tailwind scan leak:
  [docs/eligibility-triage-2026-08-29.md](docs/eligibility-triage-2026-08-29.md).
- **v0.56.0, digest-keyed `eligibility accept` + provider-stated spend headroom** — the
  eligibility gotchas and the `spend-headroom.ts` row in `CLAUDE.md`.
- **v0.53.0–v0.54.0, the three-axis assessment and its follow-ups** — the report, every verified
  and refuted claim, the retracted finding, and the closed "Remaining open items" ledger:
  [docs/three-axis-assessment-2026-08-28.md](docs/three-axis-assessment-2026-08-28.md).
- **v0.52.0, the advisory-findings verification** — the closed-vocabulary bug class (also a
  `CLAUDE.md` gotcha) and the full verdict ledger:
  [docs/advisory-findings-verification-2026-08-28.md](docs/advisory-findings-verification-2026-08-28.md).
- **v0.50.0–v0.51.0, the documentation pass and the XDG unification** —
  [docs/documentation-pass-2026-08-27.md](docs/documentation-pass-2026-08-27.md), and the
  `state-paths.ts` row in `CLAUDE.md`.
- **v0.49.0, the uncovered-areas sprint** —
  [docs/uncovered-areas-review-2026-08-26.md](docs/uncovered-areas-review-2026-08-26.md).
- **v0.47.x–v0.48.0, the complexity review and its §5 implementation** —
  [docs/complexity-review-2026-08-25.md](docs/complexity-review-2026-08-25.md).
- **v0.46.0, the dialect-rescue destructive filter** — the last safety-shaped code gap. Its rule
  is a `CLAUDE.md` gotcha, and its design is
  [docs/dialect-rescue-destructive-refusal-2026-08-24.md](docs/dialect-rescue-destructive-refusal-2026-08-24.md).
- **v0.45.0, the custody program** — plan, recon corrections and the seven build decisions:
  [docs/custody-sprint-plan-2026-08-24.md](docs/custody-sprint-plan-2026-08-24.md). Residuals: §6.
- **v0.40.0–v0.44.0, the metering program** — closeout ledger and every gap/stage/decision table:
  [docs/metering-reconciliation-2026-08-22.md](docs/metering-reconciliation-2026-08-22.md) §7.
- **Every standing trade and open question** those sprints produced: §6 below, which is the one
  place they are tracked.
- **Process lessons that generalize** (run the pre-fix control yourself; lane discipline; the
  evidence-only closeout auditor) live in agent memory (`llm-relay-revival`,
  `free-lane-playbook`).

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
[docs/rubric-recalibration-2026-08-16.md](docs/rubric-recalibration-2026-08-16.md) §2 and in git
history - do not reintroduce them.

## 2. Where to read

| Document | For |
|---|---|
| `CLAUDE.md` | Architecture map, file-to-responsibility table, gotchas. Invariants are authoritative there. |
| `docs/metering-reconciliation-2026-08-22.md` | Implemented vs open against the quota-metering spec: gap/stage/decision tables, both-fronts and provenance checks, remaining-items list. |
| `docs/rubric-recalibration-2026-08-16.md` | What went wrong, the revised invariants (copy-ready), 55 re-adjudicated rejections |
| `docs/credential-fleet-design-2026-08-16.md` | Custody, pooling, cost accounting - components, staged build order |
| `docs/quota-metering-spec-2026-08-16.md` | The metering pipeline - metrics, collection sites, storage, stages |
| `docs/spa-dashboard-design-2026-08-20.md` | Read-only Analytics SPA implementation design, protocol, contract, staged gates |
| `docs/rejection-ledger-2026-08-16.md` | Every past rejection and its reason, grouped by reason-kind |
| `docs/reference.md` | Full user-facing reference, including provider credential fleets and protected diagnostic surfaces. |
| `docs/three-axis-assessment-2026-08-28.md` | The owner's three-axis capability assessment: verdicts per axis, the live-signal finding, the closed follow-up ledger. |
| `docs/advisory-findings-verification-2026-08-28.md` | The pass over the 32 advisory findings the 2026-08-26 review left unverified: the closed-vocabulary bug class and all eight instances, Class A vs Class B, the verdict ledger. |
| `docs/documentation-pass-2026-08-27.md` | The doc-vs-source pass: what was wrong and in what classes, what was deliberately left, and the friction. |
| `docs/dispatch-integration-review-2026-08-27.md` | Historical cross-CLI dispatch review: execution model, AGY permissions, ACP transport, and the original immediate-child window fix. Its AGY focus-safety conclusion is superseded by the 2026-08-31 report below. |
| `docs/dispatch-smoothness-2026-08-31.md` | Current per-agent routing matrix, MCP spawn guarantees, PowerShell/OpenCode repairs, completed AGY focus-safety revalidation, and the deferred Claude host boundary. |

## 3. Verification — the one gate

```bash
npm run build && npm run check
```

`npm run check` = both typechecks (`src/` and `test/`) + the server vitest suite + the dashboard
checks (`tsc -p dashboard/tsconfig.json --noEmit` and the dashboard suite) + the package checks
(bundle-inventory equality, size ratchets, packed smoke). **CI runs exactly this and nothing
else.**

- Bundle sizes live in `docs/dashboard-package-baseline.json` and are ratcheted: regenerate the
  baseline in the SAME change that adds or removes bundle weight, or `check:package` goes red.
- Tests read `src/` directly; `scripts/*.mjs` read `dist/` - rebuild before running any script.
- Some tests are POSIX-only (`skipIf(process.platform === "win32")`) and skip on Windows; CI's
  ubuntu leg is the only place they run, so a green local Windows run is not full coverage of
  secret-file permissions. A store path nested
  under a regular file reads as `ENOENT` on Windows but `ENOTDIR` on Linux, so fixtures that
  require an absent load must inject the stat/read seam rather than relying on that filesystem shape.
- A failing test may be pinning a defect it should have caught. Read its stated reasoning before
  assuming your change is wrong, and fix test and source in the same commit.
- **A test that does real machine work has the machine's worst case in its 5 s budget.** A spawn
  measured at ~50 ms idle took 2.8–4 s under full-suite process contention and flaked for weeks.
  Fix at the root with an injected seam, never by raising one test's timeout — the flake just
  moves to the next test on the same path. The worked example is the `winenv.ts` row in
  `CLAUDE.md`.
- Static analysis (`npm run analysis:run`) is advisory and deliberately outside the gate.

## 4. Things that will bite you

- **Do not trust this repo's documentation without checking source.** Drift here has been
  recurrent. THREE mechanical axes are guarded now — `test/architecture-map.test.ts` (every
  non-index `src/` file has a `CLAUDE.md` table row), `test/scripts-inventory.test.ts` (every
  `scripts/*.mjs` is named in `scripts/CLAUDE.md`, and no name there is dead), and
  `test/doc-links.test.ts` (every relative link in the shipped doc set resolves, and no `.md`
  target wears a line-number fragment). ⚠ Everything a doc SAYS is still unguarded: what a module
  does, what a default is, which release shipped what. Verify before inheriting such claims.
- **A recorded "open gap" is a claim like any other — verify its MECHANISM before working it.**
  A §6 entry once cited a mechanism (backslash paths failing `check:package` on Windows) that had
  never existed on this tree; ten minutes of reproduction beat an afternoon of fixing a defect
  that did not exist.
- **A CLI process's environment is not the running relay's environment.** On Windows a User-scope var
  enters a process only at start, and the relay launches at logon. `llm-relay keys` reports *its own*
  env; `GET /registry` is authoritative. A whole "half the pool is dead" finding was once this.
- **Worktrees.** If work happens in a git worktree, edit and run tests *in that path*. `vitest.config.ts`
  scopes the suite to this checkout's `test/` on purpose — do not widen it.
- **Liveness checks.** llm-relay's `/health` and `/ping` return **403 by design** (they are control
  routes); use `/telemetry`. freellmapi's `/health` returns **200 unconditionally** from an SPA
  catch-all — its real route is `/api/health`.
- **Never put `--permission-mode plan` in a `cliLane` template.** Headless `claude -p` has no
  `ExitPlanMode`, so the lane can never leave plan mode and looks healthy while completing nothing.
- **Headless offload lanes must be told not to stop and ask.** A lane that ends its turn with a
  clarifying question reads as a completed task that did nothing. Instruct it to decide and
  proceed on its own judgement, and to report rather than await approval.
- **Keep `{task}` BEFORE any variadic flag in a `cli` rung template.** Some shells let a variadic
  option swallow what follows it, and the owner's template once lost the whole prompt to
  `--allowedTools`. Confirm a template with one real headless run before trusting a lane built
  from it.
- **Claude Code has THREE client-side idle timers that abort a long silent generation at ~300 s
  on a custom base URL** — event-level + byte-level streaming watchdogs, and the body idle
  timeout. The relay's commit probe (`src/stream-commit.ts`) holds bytes until meaningful
  content, so a long think looks idle to all three. Set
  `CLAUDE_STREAM_IDLE_TIMEOUT_MS=1800000`, `CLAUDE_BYTE_STREAM_IDLE_TIMEOUT_MS=1800000` and
  `API_FORCE_IDLE_TIMEOUT=0` in any hand-written CLI rung's `env`; the owner's
  `routing.cliLane.env` already carries all three.
- **A spent pool member stays walkable by design** (health demotes, never drops), so a headless
  session can die on a member with a standing 402/403 when the preferred member is rate-limited.
  Addressing a healthy member directly (`--model <provider>/<model>`) avoids the fall-through;
  the durable fix direction is eligibility facts and the G2 cap, never dropping.
- **A multi-lane burst degrades the free pool it runs on.** Lanes sharing one quota domain die
  together (a weekly spend-limit 403 ends a headless `claude -p` lane outright). Relaunch each
  dead lane pinned to a DIFFERENT healthy member from `/candidates`, so lanes sit in separate
  quota domains.
- **`gh run watch` on a PASSING publish run shows an `X tier-data.json missing or empty`
  annotation.** It comes from the smoke step's DELIBERATE negative test (publish.yml deletes the
  file and requires exactly that error — "PASS-AS-EXPECTED"), and GitHub renders the `::error::`
  as a failure annotation anyway. Judge a run by `conclusion`, never by its annotations.
- **Refusal signatures converge across lanes since the 2026-08-29 fix, with one stated residual.**
  A provider message CUT by the wrapper's 300-char body cap converges only when both lanes'
  extractions share the same 240-char signature prefix; otherwise each lane keeps its own
  signature and each binds for the lane it was learned on. An accepted verdict therefore covers
  the lane whose traffic produced it — which is the walk lane for everything pool-routed. An
  EMPTY wrapped body teaches and queues nothing, by design. Diagnosis and resolution:
  [docs/eligibility-triage-2026-08-29.md](docs/eligibility-triage-2026-08-29.md).
- **The vitest interpretations/fact stores are per-PROCESS files, so entries leak between tests
  in one file.** `resetInterpretations()` drops the memo, not the file — a later test's
  `pendingRefusals()` sees every entry earlier tests flushed. Assert entry-specific facts
  ("this signature is still pending"), never queue lengths.

## 5. Definition of done

- `npm run build && npm run check` green on a clean, committed tree.
- Both request paths covered by any new policy.
- New behaviour pinned by a test. Failover tests use **≥2 candidates** — with one candidate,
  "fails over correctly" and "cannot fail over" are the same observation.
- Commit trailer names the model that authored the change:
  `Co-Authored-By: <model> <noreply@anthropic.com>`.
- No half-done state. Deliberate intermediate states must be called out explicitly so they are not
  mistaken for bugs.

## 6. Outstanding, unclaimed

⚠ What follows is **recorded trades, deferrals and settled decisions kept for their reasons**, not
a work queue. The queue is [docs/backlog.md](docs/backlog.md). Nothing here currently awaits the
owner.

**From the 2026-08-29 triage
([docs/eligibility-triage-2026-08-29.md](docs/eligibility-triage-2026-08-29.md)):**

- **EXECUTED: the lane-split refusal-signature fix** (owner decision 2026-08-29: fix and
  re-migrate). Shipped in v0.57.0 with the load-time store migration; residuals recorded in §4
  and in the `refusal-interpretation.ts` row of `CLAUDE.md`.
- **EXECUTED: the max-output-caps design (accepted 2026-08-29, implemented the same day in
  v0.58.0).** Display-only learning of stated output ceilings, shipped exactly as scoped
  ([docs/max-output-caps-design-2026-08-29.md](docs/max-output-caps-design-2026-08-29.md));
  the carrier groq signature was rejected from the queue on landing.

**Owner decisions on record:**

- **DECIDED 2026-09-04: `freeOnly` stays `false` on all three offload rules.** Since the
  admission reversal (`28efb91`) an `include: "free"` pool lists paid and unknown-cost deployments
  strictly behind every free member; the owner chose to keep them reachable as the last resort
  rather than answer 503 when the free lane is spent. The accepted cost: a paid balance that is
  topped up (OpenRouter, Kilo) is spent by the first walk whose free members all fail. Re-raise only
  if a balance is funded. Contract stated in the `dynamic-pools.ts` row of `CLAUDE.md`; evidence in
  [docs/muse-spark-1.3-opencode-zen-2026-09-04.md](docs/muse-spark-1.3-opencode-zen-2026-09-04.md) §4.
- **DECIDED 2026-09-04: Meta contributor SKUs may be routed automatically (option A).** Prompts
  and completions sent to `opencode/muse-spark-1.3-contributor-free` become Meta training data, and
  the owner accepted that for offloaded traffic. Route A (the OpenCode-CLI `opencode-muse-spark`
  rungs) is live; route B (a Responses-API upstream) is a backlog lap.
- **WITHDRAWN: the currency-per-week spend ceiling.** The owner never asked for it; it was an
  agent-recorded candidate. Do not re-raise it as an open item.
- **EXECUTED: the OpenRouter weekly-limit interpretation is accepted**
  (`allowance-exhausted`, scope credential, `--cost-class paid`) — paid OpenRouter deployments
  demote while the condition cools and free ones stay walkable. Self-healing on both sides: any
  paid success, or the spend-headroom poll, clears it.
- **Type-level 7 stays as recorded** (a hard cap's `used` carries no basis provenance) — owner
  chose keep-as-is. A transparency gap, not a wrong refusal.
- **ACCEPTED AS-IS (owner decision 2026-08-23):** streaming cross-protocol usage parity in
  llm-bridge — the ledger observes the BACKEND stream, so accounting is correct; only the
  client-facing translated SSE loses cache fields.
- **DROPPED (owner decision 2026-08-23), not deferred — Gaps 15/16, P4.** Removed from the
  program of record entirely: Gap 15 (single-file HTML dashboard) was superseded by the shipped
  SPA, Gap 16 (in-flight quota leases) had spec §5.4 arguing against it with no measured
  overshoot, P4 (server-enforced system prompts) never acquired a purpose.

**Deferred hardening (2026-08-28 verification sprint)** — every reason in
[docs/advisory-findings-verification-2026-08-28.md](docs/advisory-findings-verification-2026-08-28.md)
"Still open, with its home". In short: four **Class B** findings (a type wider than its producers,
which no producer can reach) are hardening and deferred — type-level 2, 8, 14, 15; type-level 12
is deferred until someone can show acceptance-equivalence by differential fuzzing, because it
governs what LOADS and a quarantined shard is a lost day of ledger. Response-SIZE bounds on the
probe paths and the `withBudget` non-cancelling race are named as out of scope in `cd6e5f8`.

**Standing trades, each judged in its packet review — do not re-litigate them as discoveries:**

- Orphan `tmp-*` journal files are never swept. Crash-only residue (at most one per hard kill,
  bounded by the file caps), unreadable by anything, and a sweeper cannot distinguish an orphan
  from another process's in-flight temp. If ever built: gate on prefix + inside-root + age > 24h,
  and leave `.corrupt-*` alone — that is deliberate evidence.
- `methodSnapshot` accepts bounded arbitrary JSON as an estimation "method" — deliberate and
  pinned (it snapshots a structured descriptor away from later caller mutation).
- The dashboard session token rides `sessionStorage`; the mitigation is the strict CSP.
- Misleading error codes for body problems (N8): fixing it is a versioned WIRE change for a code
  no consumer reads. SPA/test nits standing: flat 30 s poll with no failure backoff (mitigated by
  abort-on-hide/offline), CSS-structure test mirroring styles.css, a few wall-clock-sleep tests,
  dashboard fixtures cast via `as unknown as`, `aria-description` support patchier than
  described-by, theme preference not persisted, SIGKILL leaking the test interpretations file.
- Unverified residual (metering reconciliation §5): rotation-triggered fact clearing is verified
  only in adjacent machinery, not the rotation path itself. (The ≥2-candidate accounting walk IS
  pinned on both fronts in `test/accounting-lifecycle.test.ts`.)
- Custody residuals (v0.45.0): `keys rotate` mints the control token when no relay runs — same
  side effect as `cooldowns clear`, noted, not a defect; the keystore read surface is deliberately
  wider than the strict `keys add`/`import` write gate (documented in `docs/reference.md`); macOS
  `security` and Linux `secret-tool` lanes have injected-double coverage only — no CI leg runs
  them, so any "CI-verified" claim about them would be false; the server-side integration tests
  share the worker-default keystore path; `keystoreStatus` retains the KEK after a successful
  read (deliberate, serves the spawn-once discipline).
- From the 2026-08-27 uncovered-areas sprint
  ([docs/uncovered-areas-review-2026-08-26.md](docs/uncovered-areas-review-2026-08-26.md)
  "Not fixed, and why"): §5 item 24 REJECTED on a measured line delta; items 9, 11, 12, 13,
  19-remainder and 23 keep their verdicts; two behaviours recorded rather than changed
  (`key-checker`'s initial-probe 401/403, and an anthropic-kind provider only ever reporting
  `unverified`); the pre-existing mis-indentation in `src/key-checker.ts` stands so a reformat
  cannot obscure a real diff.
- **`delegate-gate` findings WAIVED across this lap's lane diffs** (2026-09-04): the module-level
  `servers` test-fixture pattern and `as unknown as typeof fetch` casts, both flagged repeatedly
  across this lap's AGY-lane packets, were judged pre-existing repository convention rather than
  new defects and let through — the same shape as the dashboard-fixture `as unknown as` entry
  above, now also seen on the server side.
