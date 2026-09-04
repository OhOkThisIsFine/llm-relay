# Backlog — llm-relay

> The work queue. A living to-do list, not a status log.
>
> Distinct from [`../HANDOFF.md`](../HANDOFF.md) §6, which holds recorded trades, deferrals and
> settled decisions for their REASONS and is explicitly not a queue. Remove an entry here once it
> ships; route what survives to its one home (invariants and rationale → `CLAUDE.md`, current
> state → `HANDOFF.md` §0, durable machine facts → project memory).

## Open

- **Decide what to do with the 63 advisory errors the eslint revert surfaced.** The
  `server.ts` decomposition had switched off 15 rules; the owner reverted that on 2026-09-01
  (`cde5d1c`). ⚠ The CODE producing the findings is **pre-existing**: curated parser regexes in
  `refusal-interpretation.ts`, `rate-limits.ts` and `quota-observation.ts`; keystore-test fixture
  passphrases; `no-control-regex` in `dashboard-static.ts`. The tree scored **155 errors at
  `ec5c16f` under that commit's own config against 63 at HEAD**, so the refactor left it cleaner by
  this measure.

  ⚠ Do NOT restate this as "in files the refactor never touched" — an auditor falsified that
  phrasing on 2026-09-01. Twelve of the sixteen error-bearing files WERE modified, and
  `candidate-runner.ts` was created by the refactor; its one error sits on `credentialAttemptLabel`,
  a body moved byte-for-byte from `server.ts`. The claim is about moved code, not untouched files.

  Analysis is advisory and deliberately outside the gate, so nothing is broken. The unmet property
  is that `eslint.config.mjs`'s convention — one **named invariant** beside each disabled rule — is
  currently satisfied by neither state: the rules are on and noisy, or off and unlabelled. Resolve
  by disabling each with its invariant named, or by fixing the findings. Evidence:
  [`refactor-consistency-audit-2026-09-01.md`](refactor-consistency-audit-2026-09-01.md).

- **Verify the `relay` custom agent type end to end in a fresh Claude Code session.**
  `llm-relay setup claude-cli|claude-desktop` now installs `~/.claude/agents/relay.md` (model
  haiku; tools = the three dispatch MCP tools) so a Claude Workflow script can call
  `agent(task, {agentType: "relay"})` instead of building its own dispatch call. The file is on
  disk with the marker the installer checks for, but the session that ran `llm-relay setup` does
  not reload its own agent registry mid-session, so `agentType: "relay"` has never actually been
  invoked.

  **Property:** a Workflow script naming `agentType: "relay"` resolves to the installed agent and
  completes a real dispatch through it — not merely that the file exists on disk with the right
  marker.

- **Raise `publish.yml`'s `timeout-minutes: 15` — the v0.69.0 publish exhausted it on the first
  attempt.** `npm ci` took 5 min 2 s against a 10 s baseline on the v0.68.8 run, and the smoke
  test's two `npm install` calls cost about 5 min each; ordinary npm-registry slowness, with no
  code or CI defect, ran the job past 15 minutes and GitHub Actions cancelled it before it reached
  the publish step. A `gh run rerun` of the exact same run then published cleanly (`npm ci` still
  4 min 17 s the second time), so this is a live-fire risk on every future release rather than a
  one-off.

  **Property:** a publish run has enough timeout headroom to absorb ordinary npm-registry slowness
  without a human having to notice the cancellation and manually re-run it.

- **Calibrate `routing.hedge`'s floor from data, and find why its per-token and absolute rungs
  never fire.** Every hedge observed this lap reported basis `floor` — none reported `per-token` or
  `absolute` — across `pool/medium` traffic where the slow primary answered in 9–38 s.
  [`audit-findings-2026-09-03.md`](audit-findings-2026-09-03.md) DR-002 (merged conceptual
  findings) already names a candidate cause verified against source: `hedgeDelayDecision` calls
  `hedgeThreshold` with `tokensSeen` hardcoded to `0`, and the per-token rung is gated on
  `tokensSeen > 0`, so it may be structurally unreachable on the wired path rather than merely
  unexercised by this lap's traffic. The operator's `routing.hedge.floorMs: 8000` is a hand-set
  number chosen after watching four requests, not a calibrated one the way
  `DEFAULT_LATENCY_MS_PER_TOKEN`'s 250 was measured from `usage/recent.json`.

  **Property:** the hedge ladder's rungs fire in the order the source and `CLAUDE.md` claim
  (`per-token → absolute → floor`, first rung with evidence final) — or the code and the
  documentation describing it agree that the floor is the only rung that ever runs.

- **Remediate, or explicitly accept with reasons, the four `docs/audit-findings-2026-09-03.md`
  findings verified against source this lap but left unfixed.** All four were checked directly by
  the lap orchestrator, distinct from the file's own 35-of-41-present bookkeeping note
  (`5c6c60f`):
  - **DR-001** (merged conceptual) — `src/config-types.ts` duplicates 31 exported names from
    `src/config.ts`, including the RUNTIME array `EFFORT_LEVELS`, declared twice and imported by
    different consumers (`cli.ts` from `config.ts`, `dynamic-pools.ts` from `config-types.ts`).
    Adding a config key to one copy compiles clean and silently does nothing in every module bound
    to the other — the closed-vocabulary defect class `CLAUDE.md` already tracks, at module scope
    instead of union-member scope.
  - **DR-002** (merged conceptual) — the hedge ladder's documented "per-token → absolute → floor"
    order only ever runs the floor rung in production, because the one production call site passes
    a literal `0` for `tokensSeen` and the per-token rung is gated on `tokensSeen > 0`. This lap's
    own measurement (the hedge-calibration entry, above) reproduces the symptom the audit predicted
    from source alone.
  - **DR-003** (contract review) — `accountingFailureForAttempt` falls through to `provider_error`
    for a relay-authored refusal (e.g. a dialect-rescue destructive refusal, `errorOrigin: "local"`),
    so the ledger blames the provider for a decision the breaker correctly declines to charge
    against it. No test references the function or the failure-kind type it classifies.
  - **DR-004** (contract review) — `GET /v1/models` seeds every advertised entry's
    `context_window`/`max_context_window` with a hardcoded `272000` (`CODEX_DEFAULT_CONTEXT_WINDOW`)
    whenever the real resolvers return nothing, contradicting the provenance rule that an unknown
    limit stays unknown and overshooting this repo's own measured pool minimums (131,072–163,840)
    by roughly 1.7–2.1x.

  **Property:** each finding is either fixed, or explicitly accepted with a named reason the way
  [`advisory-findings-verification-2026-08-28.md`](advisory-findings-verification-2026-08-28.md)'s
  Class B deferrals are — not merely present in an audit file nobody has acted on.

- **Clean up the DR-020 residue in the accounting store's public types.**
  `SnapshotMutationResult` still declares the `"recovered"`/`"recovery-loss"` members of a recovery
  mechanism `751fb52` deleted, and `ioHooks` remains a seam with nothing left to inject behind it.
  Neither is wrong today — a member of a closed union no code path returns is inert, not
  incorrect — but it is exactly the "type wider than its producers" shape `CLAUDE.md`'s
  closed-vocabulary gotcha distinguishes from the dangerous silent-fallback case, and it will read
  as live behaviour to the next person who greps for it without reading the DR-020 history.

  **Property:** `SnapshotMutationResult` and the accounting store's exported seams name only
  mechanisms that exist after DR-020, so a reader does not have to check git history to learn which
  members are real.

## Closed

- ✅ **Re-check long `pool/medium` MCP dispatch after v0.68.4 — root-caused and fixed** (2026-09-04).
  Not a stall and not the MCP mechanics: `targetUsability` was collapsing a LATENCY demotion into
  the same `cooling` band as an outright failure, and unknown-lift candidates sort last within that
  band — so the pool's one fast-answering member, a latency-demoted `nim/moonshotai/kimi-k3`
  (p95 385–875 ms/token), was walked AFTER every 401/402/403/404/502 member instead of ahead of
  them. Measured before the fix, one-line prompts on `pool/medium`: direct HTTP 5.7 / 8.5 / 10.8 /
  6.6 s with 6–9 failing members walked per request (one probe:
  `9 tried, 1 served: 1x404, 1x401, 3x402, 1x403, 2x502, 1x200`); MCP dispatch to `claude-free-pool`
  through the `claude -p` harness 22 s, of which the harness's own overhead beyond API time measured
  0.06–0.26 s plus about 2 s of process start.

  Fixed by `bbe1d20` (owner-approved 2026-09-03): `TargetUsability` gained a fourth band, `slow`,
  ordered live → slow → credential-fault → cooling, so a latency-demoted member is walked ahead of
  anything actually broken instead of behind it. That alone produced `2 tried, 1 served` walks, but
  the DEFAULT hedge floor then dominated the total — one-liners still took 21–38 s after the
  restart, because the hedge fired only at the built-in 20 s floor and its member answered about a
  second later. With the operator's `routing.hedge.floorMs` set to 8000, the same one-liners against
  the restarted v0.69.0 daemon completed in 3.0–17.3 s. Hedge-floor calibration is tracked as its
  own Open entry above, not folded into this close.

  The entry's second symptom — `job-0002` exiting 0 with only the fragment `Based on the evidence`
  — is reclassified rather than separately root-caused: `cadefcc` gave the MCP dispatch server a
  structural `isContentEmpty` check, so output that is only whitespace, punctuation or Markdown
  scaffolding is now reported as its own `empty-output` failure instead of returned as a truncated
  success. Whether that particular truncation came from the serving model or from lane-output
  capture was never re-derived; what changed is that the class it falls into no longer reads as a
  completed answer.

- ✅ **Control-flow review of the three unexamined request-path regions** (2026-09-01). The
  `server.ts` decomposition was first audited by comparing function BODIES, which cannot see a
  reordered guard; a control-flow pass over ONE region then found three real changes the body pass
  had missed, all already shipped in v0.68.7 and fixed in v0.68.8 (`fb61c61`). The owner directed a
  hand review of the rest rather than a re-run of the multi-agent workflow that had lost nine of ten
  agents to a spend limit.

  **Result:** `headers-accounting` clean. `openai-front` and `anthropic-walk` each carried ONE
  defect, the same one — both fronts hand-built `ProviderTargetIdentity` field by field instead of
  calling `targetIdentity` through `beginHealthAttempt`. That is a THIRD private copy of a
  construction `kernel/contracts.ts` records having already closed once between
  `circuit-breaker.ts` and `kernel/request-lifecycle.ts`, and both copies dropped its
  `Object.freeze`. ⚠ The values were identical, so no behaviour changed and no user was affected —
  the drift hazard was caught before it cost anything. Both fronts call `beginHealthAttempt` again
  and now diff clean against the original.

  ⚠ **Method note worth keeping.** A textual function-body extractor mis-identifies a body whenever
  the signature spans lines, because it takes the first `{` — which is then a parameter's inline
  type. It produced a false "openAiFrontPath grew 17 → 561 lines" (the real figures are 630 → 590,
  i.e. the front largely MOVED) and three false "CHANGED" verdicts. Diff a LINE RANGE, or read the
  body, before believing such a tool.

  ⚠ Do NOT judge any of this by the suite. Every defect this audit found passed 2,860 tests.
  Evidence: [`refactor-consistency-audit-2026-09-01.md`](refactor-consistency-audit-2026-09-01.md)
  §"Round three".


- ✅ **Give the 4,096-mutation accounting cap test a contention-aware timeout.** The full suite
  timed out `test/accounting-store.test.ts` at Vitest's 5-second default while 2,845 other server
  tests passed; the required isolated rerun passed in 1.20 seconds. The case intentionally performs
  all 4,096 serial mutations, so it now has a local 15-second ceiling instead of making concurrent
  Windows worker I/O look like a product regression.

- ✅ **Keep the primary relay skill within one tool response.** Tutor-sync paused because the
  mandatory read of the 46.9 KB / 724-line `SKILL.md` was truncated. The entry point is now 7.7 KB /
  128 lines, with advanced guidance preserved in three focused references (8.0 KB, 19.4 KB, and
  14.0 KB). Postinstall ships the complete bundle to all three hosts, and a test pins the primary
  guide at no more than 12 KB and every reference at no more than 24 KB.

- ✅ **`llm-relay cost` states the period it covers** (owner decision 2026-08-31, option A —
  RENDER the bounds, do not move them). `rollingPlan` floors `to` by the window's bucket, so the
  newest partial bucket sits outside every rolling window: 15 min for `24h`, an hour for `7d`,
  **6 h for `30d`**. The table printed only the window NAME, so the shortfall was invisible on a
  spend surface — measured against a live store, one request at `06:23Z` reported under `1h` and
  reported as ZERO under `24h`, `7d` and `30d`.

  `writeCoveredPeriod` in `src/cli.ts` now prints `from`/`to` — both already in
  `CostReportV1` and already in `--json` — plus the count of whole excluded minutes.

  ⚠ **The count FLOORS, and that is the decision the tests pin.** The sentence claims how much is
  missing, so it must not claim more than the two timestamps prove; and a gap under a whole minute
  prints NOTHING, because "0 minutes" reads as a defect where the window genuinely reaches the
  clock. The first version rounded, which turned a 56-second gap on the `1h` window into a
  warning — the `1h` test caught it before commit.

  ⚠ **Moving the boundary was REJECTED, and why matters more than the choice.** Ending the cost
  window at `now` would make the report and the dashboard chart compute different windows out of
  one `windowPlan` — one figure with two definitions, which is the split this repo keeps closing —
  and it would leave the final bucket partial, which is what the flooring exists to prevent.

  Mutation-checked both ways: dropping the call kills 2 tests, `round` in place of `floor` kills 1.

- ✅ **D3 — a losing hedge's spend is counted, and `llm-relay cost` shows it** (owner decision
  2026-08-30, surface chosen the same day). Shipped in three parts:
  `RequestCompletedEvent.abandonedSpend` (a LIST, never merged into one `AccountingSpend`), the
  store fold into its own cells touching no counter, the persisted `abandonedSpend` optional key,
  and `CostReportV1.abandoned` rendered by `llm-relay cost` as its own table.

  **Surface chosen: `llm-relay cost` only.** The SPA reads `dashboard.snapshot.v1`, not
  `dashboard.cost.v1`, so it is untouched. A dashboard panel remains available later and is not
  needed by any measured case.

  ⚠ **The table prints only when something was abandoned**, and the presence test is EVIDENCE in a
  cell rather than a count: the wire cells carry no contribution count, and `observedAt` is tested
  beside the amount because an overflowed running sum reports a null amount while still having had
  contributions — reading that as "nothing happened" would hide exactly the busiest case.

  ⚠ **One part of D3's literal wording did NOT hold, and this is the record of why.** D3 said
  `requestSpend` "becomes what this request actually cost". It does not, and three measurements say
  it must not:
  - an abandoned attempt is estimated-basis with coverage `input_only`, so folding it into
    `requestSpend` flips `partiallyPricedRequests` — the wire contract's LOWER-BOUND marker — on for
    essentially every hedged request, without one amount changing;
  - winner and loser are priced from the SAME request-level estimated input count, so a merged
    figure double-counts one measurement;
  - the property below is JOINT over spend and tokens, and folding tokens to match would reach
    `usedInWindow`, which hard caps and quota demotion read — turning an accounting change into a
    routing one.

  So `requestSpend` keeps meaning "what the answer you received cost", and "what this request cost"
  is `requestSpend + abandonedSpend`. The shipped table says exactly that in prose, so the two
  figures cannot be read as one number.

  ⚠ One premise in the original handback is DISPROVED and should not be repeated: "an aborted loser
  has no observed tokens and therefore no spend at all". An aborted serve attempt always carries the
  request-level ESTIMATED INPUT count, so it reaches the estimated pricing branch and produces a
  non-null figure whenever the price port resolves a price. D3 has real, non-zero content.

  **Property:** either `requestSpend` means "what this request cost" for every request, or it means
  "what the answer you received cost" — and whichever it means, the token totals beside it mean the
  same thing. Both still follow the winner-only rule, and they still agree.

- ✅ **The breaker learns nothing when the CLIENT gives up first — SHIPPED** (found and closed
  2026-08-30). A client disconnect recorded the attempt as `cancelled`, and cancelled returned
  BEFORE `PROVENANCE_REACHES_HEALTH_PATH`, so a deployment that out-waited the caller was never
  charged. Measured: a 65-second probe against the hanging member taught the breaker nothing at all.

  **Property met:** a deployment that outlasts the caller's patience is now distinguishable from a
  caller who simply changed their mind. The entry's own constraint was honoured — the two cases are
  SEPARATED, and the early return was not deleted.

  ⚠ **The constraint was load-bearing, and the measurement behind it is worth keeping.** That one
  line carried THREE events, so deleting it would have made three routing changes at once:
  `PROVENANCE_REACHES_HEALTH_PATH["client-cancellation"]` is already `true`, so every ordinary
  client disconnect would have charged provider health; every hedge loser would have been charged,
  repealing a documented hedging invariant that has its own tests; and cancelled attempts' quota
  headers would have begun merging into routing state.

  Delivered as a REQUIRED closed `cause` on `AttemptCancelled` routed by a second total table
  (`CANCELLATION_REACHES_HEALTH_PATH`), with the cause DERIVED from `HealthAttempt.committed`
  rather than from the `reason` prose — because when a client disconnects during a live hedge race
  the relay still retires the hedge with the fixed string "hedge loser aborted" whatever the true
  cause. 11 tests; five mutation checks, each killed by exactly one test.

  ⚠ Two accepted consequences, stated so they are not later read as bugs: an admitted cancellation
  CREATES a `CircuitState` row where none existed, surfacing that deployment on four operator-facing
  surfaces; and `MAX_FAILURES_BEFORE_TRIP` is 2, so one long cancellation records a failure and a
  ping but sets no cooldown — deliberate, and the repo's standing rule against acting on one
  request's latency.

  ⚠ NOT extended to the latency datasets. `onServedLatency` stays gated to serve+success, so a
  cancelled attempt reaches neither `probe-cache.json` nor the `routing.latency`/`hedge-trigger`
  terms. That is correct rather than unfinished: a cancellation carries no token count, and a
  request sample with no token count already reaches NEITHER latency statistic by design.


- ✅ **Hedged attempts — SHIPPED and wired on both fronts** (owner proposal 2026-08-30; the four
  decisions are in [hedged-attempts-design-2026-08-30.md](hedged-attempts-design-2026-08-30.md) §7).
  In the owner's words: *"maybe if an attempt is taking longer than p90 for that endpoint
  (normalized by number of tokens), we pass the task off to the next source, but still allow for the
  possibility of the first source returning a useful result."*

  **Property met:** a request's latency is bounded by the FASTEST candidate that answers, not by the
  first one that was tried. Every fix before this left the walk SERIAL, so a request still paid the
  full cost of each slow candidate it met; v0.65.3 made the relay *meet* one less often, hedging
  makes *meeting* one cheap.

  Delivered as `routing.hedge` (ON by default, free deployments only), `server.ts`
  `runAttemptWithHedge` shared by both fronts, and `x-llm-relay-hedged` on every hedge — won or
  lost, because the duplication happened either way. `routing.hedge: false` is a byte-for-byte
  revert, including the walk's in-flight cap.

  ⚠ **The engaged invariant was settled, not assumed.** `CLAUDE.md` said acting on counts *"may only
  reorder"*; the owner amended it for hedging on 2026-08-30, and the amendment is written into
  `CLAUDE.md` and `docs/project-goals.md` as an amendment rather than a repeal — nothing else here
  may duplicate, and a later term that wants to must be argued on its own.

  ⚠ **Two structural findings, both from ATTEMPTING the wiring rather than reading it, and both
  would have shipped broken requests.** They are recorded in `CLAUDE.md` because they are the
  durable half:
  - `CredentialAttemptTrace.record` matched the LAST open entry and only then checked identity, so a
    PRIMARY that won against an egressed hedge threw on a perfectly good 200.
  - `CredentialWalk.next()` had to start re-offering a pending-but-UNSTARTED attempt. Both fronts'
    failover look-ahead depended on the single-slot saturation branch BY ACCIDENT, so raising the cap
    to 2 made the walk hand out a third candidate while the second stayed pending forever. Measured:
    40 multi-candidate failover tests, and they HUNG rather than failed.

  ⚠ **The cheap thing was already tried and is unchanged:** `providers.nim` carries
  `timeoutMs: 100000`, measured rather than chosen.

  ⚠ D3 is the one part not delivered — see the Open half.

- ✅ **The package ceiling raised twice in one lap — the exception was ACCEPTED** (owner decision,
  2026-08-30). The growth had been root-caused to the byte with no residue, and the alternative was
  deleting documentation to fit a number, which package-size variant C ships deliberately.

  **The standing rule is unchanged:** a lap's own work moves a ratchet at most once, or the
  exception is recorded with its decomposition and its reasoning. The hedge-wiring lap moved it
  ONCE — `unpackedBytes` 4722843 -> 4745634 (+22791), decomposed with no residue and **no new
  entries** (365 unchanged), measured against a build of the baseline commit rather than a guess:
  `server` 14779 + `config` 5086 + `backend` 1638 + `hedge-trigger` 1059 + `credential-select` 229.
  ⚠ Stated on `unpackedBytes` deliberately — `packBytes` is gzip output, so it is neither additive
  across files nor byte-reproducible. ⚠ The `.d.ts` outgrowing the `.js` on `config` and `backend` is
  the two-pass build working as designed: doc comments survive in the declarations and are stripped
  from the JavaScript.

- ✅ **Which latency dataset `routing.latency` measures — DECIDED and SHIPPED** (owner,
  2026-08-30). *"Switch to the probe dataset, and expand that dataset to include request latency …
  where we can get latency per token from actual requests."* Delivered:

  1. **Reads the PROBE dataset** (`probe-cache.json`, via an injected `readPings` seam). It
     persists across restarts and is what `llm-relay candidates` displays, so the two surfaces
     agree and the term is no longer inert after a restart.
  2. **That dataset now carries REQUEST latency too.** `probe-cache.ts` `recordRequestSample`, fed
     from `RequestAccountingState.complete()` for SERVED + SUCCESS attempts only, with the reported
     output-token count. ⚠ It touches nothing that schedules probing — `lastProbedAt`, `status`,
     `probeVersion`, the scalar `ms`/`code`, `quotaObservations` and `totals` are all left alone,
     because refreshing `lastProbedAt` would silently stop probing the deployments carrying real
     traffic. An unknown deployment is skipped, never created with invented probe fields.
  3. **Latency PER TOKEN is the primary signal** (`getP95MsPerToken`), because absolute latency
     cannot compare a `max_tokens: 1` probe with a 500-token generation. Probes are excluded from
     it by construction; absolute p95 remains the fallback when per-token has too little evidence.

  ⚠ **Per-token is FINAL when it has evidence, and a test forced that.** The first implementation
  fell through to the absolute ceiling after a healthy per-token verdict, so a member answering in
  40 s with 1000 tokens — 40 ms/token, squarely healthy — was demoted anyway by the 30000 ms
  ceiling. That would make "primary signal" meaningless and punish exactly the fast deployment that
  merely produced a long answer.

  **The default is measured, not invented.** 250 ms/token, from 68 real requests in
  `usage/recent.json` on 2026-08-30: population p50 40.4, p75 70.5, p90 292.0, p95 967.1; per
  deployment a healthy `nemotron-3-ultra` at a median 36.3 and `minimax-m3` at 57.3 against
  `gemini-3.6-flash` at **687.8**. 250 sits about 3.5x above the healthy band and well below the
  bad one. `docs/reference.md` carries the one-liner to re-run that calibration.

  ⚠⚠ **THE PACKAGE CEILING WAS RAISED A SECOND TIME IN ONE LAP, against the standing rule.** That
  rule reads "never raise a ratchet twice in one lap for that lap's own work", and it is recorded
  here as a knowing exception rather than quietly taken. Reasoning, for the owner to overrule: this
  was a SEPARATE owner decision taken mid-lap and shipped as its own release, not the same change
  creeping; the growth was root-caused to the byte first; and the alternatives were deleting
  documentation to fit a number, or leaving correct, released work red. Growth since the published
  v0.64.2, decomposed with **no residue** and **no new entries** (359 unchanged):
  `unpackedBytes` 4673004 -> 4690084 (**+17080**) = 4522 `ping/metrics` + 3790 `ping/probe-cache`
  + 3170 `ping/cadence` + 2772 `latency-demotion` + 2364 `server` + 462 `config`. Ceilings keep the
  same ~0.5% headroom the baseline has always carried.

- **(superseded, kept for its reasoning) Decide which latency dataset `routing.latency` should
  measure** (found 2026-08-30, immediately after shipping it).

  `src/latency-demotion.ts` reads `breaker.getDeploymentMeasurement().pings` — **real
  served-request** latency, written only by `applyHealthOutcome` on the request path, held in
  memory. `PingLoop` never writes it and `breaker-persistence.ts` deliberately does not persist it.
  Two consequences, both now documented in place rather than discovered later:

  1. **The term is inert after every relay restart** until `minSamples` real requests per
     deployment.
  2. **The default ceiling was calibrated on the WRONG dataset.** The 23478 / 70364 ms figures came
     from `llm-relay candidates`, whose p95 is `PingLoop.getModelSummary()` — the PROBE dataset in
     `probe-cache.json`. A probe sends `max_tokens: 1`; a real request generates. So request
     latency runs systematically higher and 30000 ms will demote more readily than those two
     numbers imply.

  Options: (a) keep request latency and re-calibrate the default against real request-path figures
  — measures what callers actually waited for, but stays restart-inert; (b) switch to the probe
  dataset — survives restarts, matches what `candidates` displays, but measures a one-token
  round-trip rather than an answer; (c) read both, and require both to agree before demoting.

  ⚠ Nothing here is unsafe: the term still only reorders, still needs 5 samples, and still does
  nothing when unmeasured. The live check after the restart returned
  `4 tried, 0 served: 1x429, 2x402, 1x504` with no latency header — consistent with a freshly
  restarted breaker holding no samples yet, and with the pool genuinely being sick. That live check
  is what surfaced the dataset question, one request after the restart, when neither the tests nor
  an independent auditor had.

- ✅ **The offload lane "stall" — root-caused, then FIXED** (owner-directed, 2026-08-30).
  Filed as *"investigate why the llm-relay offload lane STALLS and returns nothing"*; it turned out
  not to be a stall at all, and the fix the owner chose ships as `src/latency-demotion.ts`
  (`routing.latency`, default ON, announced by `x-llm-relay-latency-demoted`). The original entry
  and its evidence follow, because the measurements are the reason the fix looks the way it does.

  Measured at filing: a `dispatch --next-command` lane on `pool/medium` ran for about
  17 minutes, spawned roughly 19 `node` children that all sat at near-zero CPU, and produced no
  output at all beyond one line —

  ```
  [claude-code:unrecognized_model] {"model":"pool/medium","query_source":"generate_session_title"}
  ```

  The relay itself was healthy throughout (`GET /telemetry` 200) and had served traffic in the
  window, so the request reached the pool. The task was a small read-only git verification, which
  should take a few turns rather than minutes.

  ⚠ **Start with that one diagnostic line**, because it is the only one the lane emitted: the
  session-title query path reports `pool/medium` as an unrecognized model. That is a SIDE query,
  not the main turn, so it may be harmless — but it is evidence that something on the client side
  does not resolve a `pool/` spec, and it is the only thread available.

  ⚠ The free-lane playbook already records "a lane returning two words and exit 0 is a failure,
  retry". This is the stronger form — no output and no exit — so establish first whether it is a
  lane stall, a relay stall, or a client-side hang, and do not assume which.

  ✅ **Reproduced through a SECOND, independent path (2026-08-30, v0.63.0 release verification),
  which narrows it usefully.** The same `pool/medium` lane stalled when spawned by the new
  `llm-relay mcp` server rather than by a shell running `dispatch --next-command`. That rules out
  one whole class of cause: the MCP server closes stdin, lifts all three idle timeouts from the
  rung's own `env`, sets `windowsHide`, and quotes the `.cmd` fallback per token — so the stall is
  NOT caused by any of the four known command-execution mistakes. It survives a correct invocation.

  ⚠ It is intermittent, not constant, and that matters for whoever investigates: the SAME code and
  the SAME lane answered in 33 s and (via agy) in 7 s earlier the same day, then stalled past 100 s
  and past 420 s within the hour. Treat it as a load- or time-dependent condition, not a broken
  path.

  ✅ **ROOT-CAUSED 2026-08-30. It is not a stall at all — it is cumulative pool-walk latency.**
  A `pool/medium` lane dispatched through the MCP tool completed normally with **exit 0 after
  333 s** and returned a complete, correct answer. So the lane does not hang, the child is not
  wedged, and none of the four known command-execution mistakes is involved. What takes the time
  is the relay's own candidate walk. Measured in that lane's window, from `usage/recent.json`:

  | started | latency | outcome | attempts | served |
  |---|---|---|---|---|
  | 19:34:08 | 120222 ms | `provider_error` | 2 | — |
  | 19:34:08 | 120280 ms | `provider_error` | 2 | — |
  | 19:36:08 | 5321 ms | success | 1 | `nim/nvidia/nemotron-3-ultra-550b-a55b` |
  | 19:36:08 | 15457 ms | success | 1 | `nim/nvidia/nemotron-3-ultra-550b-a55b` |
  | 19:36:24 | 123343 ms | **`timeout`** | **6** | — |
  | 19:38:28 | 70750 ms | success | 2 | `nim/nvidia/nemotron-3-ultra-550b-a55b` |

  A single agent turn costing 120 s, times the several turns a `claude -p` run makes, is the
  whole reported duration. The `~19 idle node children` are those turns waiting on the relay, and
  the absent output is just `claude -p` buffering its answer until exit — a fact `CLAUDE.md`
  already records as meaning nothing.

  ⚠ **Why the walk is that expensive: latency is not part of health banding, deliberately.**
  `llm-relay candidates --tier medium`, same window — five of the top-ranked members carry an
  OPEN breaker (`nim/moonshotai/kimi-k3` for 72838 s, `huggingface/moonshotai/Kimi-K3` 927 s,
  `ollama-cloud/minimax-m3` 928 s, `nim/minimaxai/minimax-m3` 649 s), and
  `nim/deepseek-ai/deepseek-v4-flash` is **breaker-CLOSED with a p95 of 70364 ms**. `server.ts`
  ordering demotes on breaker state and nothing else (`src/server.ts:1257-1265`, with the reason
  stated: a second ranking pass on stability "means neither decides the order"). So a healthy-but-
  glacial member is walked AHEAD of a cooling one, and each such candidate can cost 60–70 s before
  the walk moves on. Even the member that finally served has p95 23478 ms and answered one
  request in 70750 ms.

  ⚠ **Two recorded threads are now disproved; do not re-pull them.**
  - *"`usage/recent.json` held no rows for the stalled attempts, so the request may not be reaching
    the accounting store."* **False.** The rows are there. `recent.json` `rows` is **not sorted by
    time**, so reading its tail shows an hour-old row while `max(startedAt)` is current. I made
    exactly that mistake twice before sorting. Sort before concluding anything from this file.
  - *"the `[claude-code:unrecognized_model]` line on the session-title path is the only thread."*
    It remains a harmless side query. `CLAUDE.md` already records that warning as carrying no
    information.

  **DECIDED by the owner, 2026-08-30, and SHIPPED the same day: let sustained latency DEMOTE into
  the cooling band.** Two other options were offered and declined — bounding the per-candidate
  attempt, and accepting the behaviour with the MCP job handle as the mitigation.

  Delivered as `src/latency-demotion.ts`, folded into `targetUsability` beside the quota term:
  `routing.latency` (default ON, `p95Ms` 30000, `minSamples` 5), announced by
  `x-llm-relay-latency-demoted`. 17 tests, of which 6 drive a real two-candidate walk on BOTH
  fronts; mutation-checked. Details in `CLAUDE.md`'s `latency-demotion.ts` row and
  `docs/reference.md`.

  Size cost, root-caused BEFORE the ceiling moved, measured against the PUBLISHED v0.63.1 tarball
  rather than a local guess: `unpackedBytes` 4654284 → 4670709 (**+16425**), `packageEntries`
  356 → 359, `packBytes` 881636 → 886142 (+4506). ⚠ The decomposition is stated on
  **unpackedBytes**, deliberately: `packBytes` is gzip output, so it is neither additive across
  files nor byte-reproducible (an independent rebuild measured 886146 against the same tree). Treat
  it as a ceiling only, never as an equality. The delta decomposes with **no residue** —
  9257 B of new `dist/latency-demotion.*` (3 files, matching the +3 entries exactly) + 4010 B
  `config` + 2081 B `server` + 1077 B `backend` = 16425. ⚠ `dist/backend.d.ts` grew 962 B while
  `dist/backend.js` grew 69 B, which is the two-pass build doing its job: the header constant's doc
  comment survives in the declaration and is stripped from the JavaScript. ⚠ `docs/reference.md` and
  `CLAUDE.md` are NOT packed, so documentation growth costs the tarball nothing. Ceilings were
  raised ONCE, keeping the ~0.5% headroom the previous baseline carried.

  ⚠ **This deliberately reverses a rationale recorded in place.** `src/server.ts:1257-1265` argues
  against exactly this, in these words: a second ranking pass on stability "means neither decides
  the order", and "live health then PROMOTES on evidence that is often a single request's latency".
  The owner was shown that cost in the question and chose this option anyway, so it is an
  **owner override of a recorded agent decision, not drift** — say so wherever the comment is
  edited, and do not let a later reader "restore" the old behaviour as a regression fix.

  The recorded objection also bounds the design, and every bound below is a direct answer to it:
  - **Demote only. Never promote, never drop, never re-sort.** The objection is about a competing
    ranking PASS; a one-way demotion term is not one. Same shape as the existing quota demotion.
  - **Never act on a single request's latency** — that is the objection's own worst case. Require a
    sustained, measured statistic.
  - **Unmeasured has NO effect whatsoever**, matching `getDeploymentMeasurement`'s null contract
    and the relay's standing "unknown stays null, never 0" invariant.
  - **Announce it**, like every other automatic reorder here.

  ⚠ The MCP server does not fix this and does not claim to. What it changes is the SYMPTOM: the
  caller receives a `jobId` after `waitMs` and can poll or `dispatch_cancel` it, instead of a shell
  that blocks with no output and no exit.

- ✅ **Offload announces itself — the operator no longer has to ask for it** (2026-08-30).
  The owner's report was blunt: *"the llm-relay skill or MCP or whatever should obviate me
  explicitly saying 'use llm-relay for offload' … it should make itself known to the agent without
  me having to say so."* Three measured causes, all closed in the repo so every host and every
  stranger gets the fix:
  1. **The MCP `initialize` instructions stated only WHAT the tool is.** A host puts that text in
     the model's system prompt unconditionally, so it is the one channel that cannot be deferred
     or missed — and it never said WHEN to delegate. It does now (`MCP_INSTRUCTIONS`, exported
     from `src/mcp/server.ts`).
  2. **The `dispatch` tool is a DEFERRED tool on a real host**, so only its bare name loads and its
     description is invisible until a tool search. The trigger sentence now rides the description
     as well, for a host that ignores `instructions`.
  3. **The skill description triggered on the DECISION, not the situation** — "use when offloading
     bulk work" only fires once the model has already chosen to offload. It now names the
     situations (a broad search, a file-by-file sweep, a survey, a draft, a second opinion) and
     says outright that nobody has to ask first. A new skill section carries the policy.

  ⚠ **The lesson worth keeping: prose the model must go and find is not a trigger.** This machine's
  global `CLAUDE.md` already said *"PREFER THE MCP TOOL"* in bold, and the owner still had to say
  it out loud. That is the machine's own "rules become tooling, not prose" policy failing in the
  one place nobody had applied it.

  Pinned by three tests in `test/mcp-server.test.ts` — the served instructions must equal the
  exported constant, and both the constant and the `dispatch` description must carry the trigger.
  ⚠ Commit `61b4ec6`'s message claims "four tests". It is three; the independent closeout auditor
  caught the miscount after the push, and this is the corrected record.
  Mutation-checked both ways: removing the trigger from the constant fails exactly one test, and
  removing it from the tool description fails exactly the other, so neither assertion is carrying
  the other.

- ✅ **Package-size variant C adopted and shipped** (owner decision, 2026-08-30).
  `build:server` runs `tsc` twice: pass 1 emits `.d.ts` WITH docs, pass 2 re-emits only the
  JavaScript with `--removeComments`. Consumers keep their IntelliSense text.
  **`packBytes` 1113288 → 861516, a 251772 (22.6%) reduction**, `packageEntries` unchanged at 347,
  and `dist/*.d.ts` bytes unchanged. Ceilings ratcheted DOWN with it (`packBytes` → 866000,
  `unpackedBytes` → 4602000), each keeping the ~0.5% headroom the baseline carried before — a
  ceiling left at the old figure after a 22.6% drop would be decoration.
  Evidence and the rejected variants: [package-size-2026-08-30.md](package-size-2026-08-30.md) §3.1.
  ⚠ This also retires the "1712 bytes of headroom" warning: the next change no longer trips the
  ceiling by design. The standing rule is unchanged — root-cause growth before regenerating, and
  never raise a ratchet twice in one lap for that lap's own work.
- ✅ **`llm-relay mcp` — the MCP dispatch server, SHIPPED** (2026-08-30). One verb (`dispatch`)
  plus job control and one ladder read, served over JSON-RPC on stdio by a HOST-launched process.
  Any MCP host — Claude Code, Codex, agy, OpenCode — now delegates a whole task with one call that
  returns an ANSWER, not a command it must then execute correctly itself. Prior-art survey and the
  design it mimics: [mcp-dispatch-prior-art-2026-08-30.md](mcp-dispatch-prior-art-2026-08-30.md).

  ⚠ **Why it was built after this entry said "confirm before building".** The entry was right that
  D4's stated premise had expired — agy has a shell again, so MCP is no longer its ONLY delegation
  route. The owner then gave a direct, newer instruction: *"Just figure out the best way to get
  dispatch working and capable, and do it."* And the case for MCP never depended on agy's shell.
  It rests on two things a shell-out cannot fix: the answer's SHAPE stops depending on the host,
  and lane EXECUTION stops being the caller's problem. That second one is the substance — five
  distinct measured ways to run a lane command wrongly (three idle watchdogs, the open-stdin stall,
  `.cmd` shell quoting, console focus theft) are now handled once, in `src/mcp/lane-runner.ts`.

  How the four recorded constraints resolved:
  - *Inert for a stranger* — **not an objection.** Owner decision D2 settled that dispatch is
    deliberately per-machine, and directed that dispatch work stop being measured against rubric
    test 1. The tool ships inert for a stranger exactly as `llm-relay dispatch` already does, and
    `dispatch_lanes` says so plainly.
  - *A tool that RETURNS a command duplicates `/dispatch`* — **correct, and it argued FOR the
    executing design.** No prior-art server returns a command; every one of them executes.
  - *Needs a caller-supplied `cwd`* — **solved.** The caller names a LANE, never a path. The
    directory is the server's own unless the caller overrides it, bounded by the new optional
    `routing.mcp.allowedRoots`. Request content never becomes process configuration.
  - *No representation for a 30-minute lane* — **solved.** Start, poll, fetch, cancel as four
    ordinary tools. The MCP Tasks extension standardises this shape, but the official client matrix
    does not list Tasks and no client ships it — measured, not assumed.
  - *Escapes the harness permission gate* — **the one real residue.** Bounded by a recursion cap of
    3 (`LLM_RELAY_DISPATCH_DEPTH`, refused BEFORE the spawn so the bound costs no lane run) and by
    per-lane config. A host that wants an approval prompt can annotate the tool with
    `anthropic/requiresUserInteraction`; that is not wired by default.

  ⚠ **The "agy has NO shell" premise stays rejected**, and agy's `command(*)` is restored and
  verified live. Nothing in this design is gated on it.

  Verified: 37 unit tests, four mutation checks, and live end to end — a real `pool/medium` lane
  answered through the tool in 33 s, and the handle/poll/result/cancel path was driven over real
  stdio. One mutation check found a test that proved nothing on a single mutation; it is now
  recorded as redundantly guarded rather than quietly left green.

  Size cost, root-caused exactly BEFORE any ceiling moved, and measured on top of variant C:
  `packBytes` 861516 -> 879010 (+17494), `unpackedBytes` +68973, `packageEntries` +9. The +9 is
  exactly the nine new `dist/mcp/` files. The byte delta decomposes with no residue - 58351 B of
  `dist/mcp/` plus 10622 B of `cli`/`config` growth, the second measured against an `origin/main`
  rebuild, and 58351 + 10622 = 68973. Ceilings were re-ratcheted keeping variant C's ~0.5%
  headroom. This is the lap's own work, so the ratchet moved ONCE.


- ✅ **`check:package` now names the build instead of throwing a raw ENOENT** (2026-08-30).
  `scripts/dashboard-package-check.mjs` reads two BUILD OUTPUTS through `readBuiltJson`, which
  reports *"… is missing. It is a BUILD OUTPUT, and `npm run check` does not build. Run
  `npm run build` first…"*. Mutation-checked: the guard fires with the file absent and the check
  passes with it present. Cost one verify-green cycle at the v0.61.0 lap start before this existed.

- ✅ **The 9 unexplained package entries are root-caused** (2026-08-30), with no residue:
  three modules added by `ba3bd2a` (v0.59.0, the quota re-probe) × three `tsc` outputs each. The
  arithmetic closes exactly — 329 + 9 + 3 = 341. Evidence and the independent decomposition:
  [package-size-2026-08-30.md](package-size-2026-08-30.md) §1. A stale `observed.unpackedBytes`
  found during that work was corrected to the measured figure; see §2 — it is the same defect class,
  because a CEILING metric's `observed` value is never compared for equality and so cannot be caught.

(The quota-source re-probe shipped 2026-08-29; design and verification record:
[quota-reprobe-design-2026-08-29.md](quota-reprobe-design-2026-08-29.md). The eligibility-and-probe
lap shipped 2026-08-30 as v0.60.0:
[eligibility-and-probe-lap-2026-08-30.md](eligibility-and-probe-lap-2026-08-30.md).)
