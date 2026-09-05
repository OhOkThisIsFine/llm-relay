# HANDOFF

Entry point for any agent picking up llm-relay, on any provider. Read this before `CLAUDE.md`.

## 0. State as of 2026-09-04 (v0.72.0, the dispatch-telemetry lap)

**v0.72.0** carries the dispatch-telemetry lap: "MCP reports, daemon records". Design, adversarial
review findings and the three owner decisions are in
[docs/dispatch-telemetry-design-2026-09-04.md](docs/dispatch-telemetry-design-2026-09-04.md);
§6 there holds the result, the review verdicts and the stated trades. In one line each:

- **`llm-relay mcp` forwards one metadata-only report per settled agent-mode job** (lane id and
  kind, wall-clock, exit code, terminal status, chars/4 of the task and of the output) to the
  daemon's new `POST /dispatch/telemetry` — fire-and-forget after the job is terminal, never a
  cancelled job, never a relay-kind answer-mode job (the HTTP pipeline already accounts it). A
  `cli`-kind rung in answer mode spawns like agent mode and IS forwarded.
- **The daemon records lane stats for every rung kind** (`dispatch-lane-stats.ts`: calls,
  successes, failures, timeouts, a 25-sample wall-clock window; `dispatch-lane-stats.json`,
  cache-kind, restore never overwrites live state) and renders them as an advisory `stats:`
  column on `dispatch_lanes`, `llm-relay dispatch`, `GET /dispatch` and `--json`. Stats never
  reorder the ladder and never reach `runtime-telemetry.json` or pool scoring.
- **Owner decision D1 — accounting for `cli`-kind lanes only, decided by the DAEMON from its own
  ladder:** a rung is metered here when its kind is `cli` AND its declared env does not point
  `ANTHROPIC_BASE_URL`/`OPENAI_BASE_URL` at this listener (`laneRoutesThroughRelay`; the review's
  C1 finding — a relay-routed `claude` rung's harness traffic already flows through the daemon,
  so a second row would double count). Unknown lane ids are 400, like the exhaustion report, and
  the report's own `kind` is never trusted over the rung's.
- **Owner decision D2 — the ledger row is the ESTIMATED ENVELOPE:** client `mcp-dispatch`,
  attribution `unknown`, `tokenBasis: "estimated"` / `method: "relay_estimate"`, no credential,
  unpriced; `failed` completes as failure kind `unknown` (the weaker claim), `timed_out` as
  `timeout`. `llm-relay cost --by client` (and `--by model` for a cli lane id) prints the caveat:
  the figure is the dispatch envelope, not the lane's provider consumption, which the relay
  cannot see.
- **Live proof before release:** an isolated daemon (port 8792, HOME overridden) plus a real
  `llm-relay mcp` child driven over JSON-RPC dispatched one `opencode-muse-spark` task — one
  `mcp-dispatch` request (tokens 14/1 estimated, spend null), one stats row (5882 ms), no runtime
  telemetry, real state untouched; 11 of 11 assertions.

**Owner decisions this lap (2026-09-04):** lap approved as stated with the cli-only accounting
refinement; ledger tokens are the estimated envelope (declined: null tokens with request
counting; no ledger row); MINOR release; a dedicated OpenCode agent `relay-lane` (machine-wide,
`~/.config/opencode/opencode.json`, backed up) so a headless Muse Spark lane may edit and run the
suite.

**Lanes.** Every packet went to the free `opencode-muse-spark` lane (Meta Muse Spark 1.3 through
OpenCode, `--variant xhigh` for code): three read-only recon lanes, four implementation packets,
one scripted live proof and one adversarial review — every packet verified here by `git diff`,
`llm-relay delegate-gate` and the full suite before its commit, and two mutation checks run
after the review fix. Two traps cost a lane run each and are recorded: a task over 4096
characters makes the MCP server fall back to its start-time config snapshot
([docs/backlog.md](docs/backlog.md)), and headless OpenCode auto-rejects every `ask` permission
(machine backlog, global `CLAUDE.md`).

Immediate next — each is a [docs/backlog.md](docs/backlog.md) Open entry with its property:

- Post-commit stalls (owner decision 2026-09-04: measure first, build only if clients retry): a
  bounded lap measures what Claude Code and Codex do on a mid-stream SSE `error` after content;
  the per-token abort is built only if a retry reaches another candidate. The terms review for
  hedging is closed by owner decision: no review needed, recorded beside D1 in the hedge design.
- Owner: verify the Codex `relay` agent from Codex Desktop.
- The 63 eslint errors: switch off per file with the invariant named.
- `publish.yml` `timeout-minutes` 15 → 30.
- Audit residue with properties: the metering silence channel (DR-006), listener-before-store
  (DR-009), the forward-path header allow-list (contract DR-006), `candidate-runner.ts` export
  pruning (DR-012), the default-ON routing keys in `docs/reference.md` (DR-024).
- Contributor SKUs (owner decisions 2026-09-04: option A — allow in automatic routing; route A
  now, route B as a lap): Meta's `opencode/muse-spark-1.3-contributor-free` may be routed
  automatically although its prompts and completions become Meta training data —
  [docs/muse-spark-1.3-opencode-zen-2026-09-04.md](docs/muse-spark-1.3-opencode-zen-2026-09-04.md)
  §5. **Route A is live:** four `opencode-muse-spark` cli rungs (one per ladder,
  `--variant <tier>`) sit right after `free-pool` in the live config (revert file
  `config.json.bak-2026-09-04-pre-opencode-muse`); the v0.71.1 daemon loaded them, and MCP
  `dispatch` with `lane: "opencode-muse-spark"` answered `OK` in 6 s (`job-0001`). Route B — a
  Responses upstream (`wire: "responses"` on `kind: "openai"`), then pinning both contributor ids
  as `preferred` — is the backlog lap. `freeOnly`: owner decision 2026-09-04, stays `false` on all
  three rules (§6); the backlog entry is narrowed to the cost-class-aware retraction rule.


## 0.1 Earlier releases

Deliberately NOT restated here. This file holds current state plus the immediate next; a
release-by-release narration is a changelog, and git already has it. `git log --oneline` and the
tags are the trail. What survived each sprint lives in its own home:

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
