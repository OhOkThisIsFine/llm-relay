# Backlog — llm-relay

> The work queue. A living to-do list, not a status log.
>
> Distinct from [`../HANDOFF.md`](../HANDOFF.md) §6, which holds recorded trades, deferrals and
> settled decisions for their REASONS and is explicitly not a queue. Remove an entry here once it
> ships; route what survives to its one home (invariants and rationale → `CLAUDE.md`, current
> state → `HANDOFF.md` §0, durable machine facts → project memory).

## Open

- **Triage the eligibility queue — 10 unrecognized refusals await interpretation** (owner
  decision 2026-09-05: a separate lap, not folded into the MCP-concurrency lap). `llm-relay
  eligibility` lists them: [1] groq `access denied. please check your network settings.` (×116)
  is the client-side VPN block and stays PENDING by rule (`network-block.ts`: never `reject`);
  [2] nim `moonshotai/kimi-k3` HTTP 400 `degraded function cannot be invoked` (×48, the
  most-repeated live refusal); four gemini 429 `resource has been exhausted (e.g. check quota)`
  rows across four models; two groq JSON-mode 400s (`failed to validate/generate json`); one
  huggingface `max_completion_tokens is limited to <n>` 400; one openrouter
  `free-models-per-min` 429. The dispatcher may `propose`; only the owner may `accept`.
  **Property:** every queued item carries an accepted verdict, a `reject`, or a stated reason to
  stay pending, each addressed by digest (`--sig`), so the listing shows no item without one.

- **A `cli` dispatch lane has ordering but no health-based reordering: it can be arbitrarily slow
  and stay `next` forever.** Owner question, 2026-09-05, after a lane produced nothing across three
  packets while the ladder went on recommending it. Everything below is verified, not inferred.

  - **The existing machinery cannot reach it.** `latency-demotion.ts` and `hedge-trigger.ts` are
    imported only by `backend.ts`, `candidate-runner.ts`, `circuit-breaker.ts`, `config-types.ts`,
    `ping/cadence.ts`, `server.ts` and each other — `dispatch.ts` is absent. Demotion feeds
    `targetUsability` inside a candidate WALK, and a lane never enters a walk; hedging duplicates one
    HTTP attempt, and `dispatch` runs a single rung, so there is no second entrant to race.
  - **The only lane demotion vocabulary is exhaustion** (`rate_limited` / `quota_exhausted`, from an
    explicit host report or a quota probe finding a STATED rate/quota message). "Ran a long time and
    returned nothing" cannot be expressed, so it cannot be recorded.
  - **The one lane observation that exists is display-only and uses the wrong statistic.**
    `medianWallClockMs` has three consumers — two print sites and the view field — and nothing
    orders by it. Measured on the live store the same day: median **111.5 s**, p95 **900 s**, max
    **1500 s**. `latency-demotion.ts` uses p95 precisely because a median hides a fat tail; the lane
    view uses the median.
  - **Cancellation teaches it nothing**, deliberately: `forwardTelemetry` narrows to
    `REPORTABLE_JOB_STATUSES`, every terminal status but `cancelled`. An operator who gives up on a
    slow lane leaves no trace, which is the case most likely to matter.
  - ⚠ **Nothing was late by the lane's own contract** — the rung carries `--timeout 2100`, 35
    minutes, and the longest observed wait was 680 s. The relay behaved exactly as configured.

  ⚠ **Do NOT fix this by pointing the HTTP terms at the ladder.** 250 ms/token and the 30 s absolute
  ceiling are calibrated for single completions; a lane legitimately runs an agent loop for minutes,
  and 900 s is not self-evidently unhealthy for one. Reusing those numbers would demote every
  healthy lane at once — the same mistake `latency-demotion.ts` records having made when an
  absolute ceiling calibrated on probes was pointed at generation traffic.

  **Property:** a lane whose recent wall-clock distribution is an outlier against ITS OWN history is
  demoted below a comparable lane, on a threshold calibrated from `dispatch-lane-stats.json` rather
  than borrowed from the HTTP path; the ladder view reports the statistic the decision actually uses;
  and an operator cancellation is distinguishable in the record from a lane that was never asked.
  ⚠ Calibrate before building: the current window mixes several sessions' traffic, so per-lane
  history has to be attributable before any threshold drawn from it means anything.

- **`parseRouting` is still cognitive complexity 125 — HOTSPOT-03 moved it, it did not shrink it**
  (measured 2026-09-06, after the extraction). This also settles the discrepancy the item flagged:
  the catalog said 137, the in-source comment said 124, and the real figure at
  `src/config/routing-parser.ts:173` is **125**. The comment was right; the catalog was not.

  ⚠ This is not a regression and the extraction was not mis-scoped. HOTSPOT-03's stated property was
  about the MOVE — that `config.ts` declares no moved symbol, that the new module is a leaf, and
  that the parser is pure — and all three hold and are pinned. But a reader who expects "the hotspot
  is dealt with" should know the function itself is unchanged; what changed is that it no longer
  sits in the middle of a 2,000-line file. Two smaller functions in the same module measure 32 and
  36.

  ⚠ Before splitting it, read the standing invariant: `CLAUDE.md` records that restructuring
  `server.ts`/`config.ts` to satisfy `sonarjs/cognitive-complexity` is the enterprise-shaped
  refactor [`suggestion-review-2026-08-04.md`](suggestion-review-2026-08-04.md) already rejected
  against the project's own rubric, and the rule is a WARNING for exactly that reason. So this entry
  is a decision to take deliberately or not at all.

  **Property:** either `parseRouting` is decomposed with each part's validation order preserved and
  the config suite green, or a line in `CLAUDE.md` records that its complexity is accepted and why.


- **Owner decision: P1-06 / SEM-06 — recommend DECLINE, and record it.** The item says "explicit
  beats default" is re-implemented across six modules. Read at HEAD on 2026-09-05, there is no one
  rule to extract, and the full site-by-site table is in
  [`phase-1b-recon-2026-09-05.md`](phase-1b-recon-2026-09-05.md). In short: four genuinely different
  clamps (floors 0 against `MIN_RETRY_AFTER_MS`, ceilings 30 days against 15 minutes, absent-handling
  a default against `null`, two of them on an ABSOLUTE time rather than a duration) plus three sites
  whose entire contribution is the `??` operator.

  ⚠ `failureCooldown` is the case that settles it: its floor does not raise the value, it changes the
  RUNG — a measurement that fails to beat the default is reported `source: "default"`, and that
  source is persisted breaker state. One shared evaluator would need a mode flag to express it, which
  is the two-policies-under-one-name shape this repository already warns against. Wrapping `a ?? b`
  in a function call makes the code worse.

  This reverses an ACCEPT verdict from the adversarial verification, so it is the owner's call and
  nothing was built. What survives, and it is small, is the intra-`dispatch.ts` pair at `:373` and
  `:384`, which really do clamp an absolute time the same way.

  **Property:** the two documents agree — either the plan records that SEM-06 was declined and why,
  or an owner instruction says to build it anyway and the mode flag is designed deliberately.

- **Owner decision: CLONE-26 moved a second thing its ruling did not name.** Shipped 2026-09-05
  (`f9006e7`) as ruled, option A, with five pinning cases and a mutation check. The ruling covered
  the scalar and array payloads; it did not cover what happens when such a payload carries a name in
  `repair.destructiveTools`. Before: the parser committed a call, so the destructive filter saw it
  and returned `refused-destructive` — HTTP 502, `origin: "local"`, code
  `tool_dialect_refused_destructive`, the `x-llm-relay-tool-dialect` header, no failover, no breaker
  charge. After: the payload is discarded before the filter sees it, so the same input returns
  `detected` — HTTP 502, `origin: "upstream"`, no header, a full pool reroll and a breaker charge.

  No destructive call is fabricated on either path, so the safety invariant is unharmed. What moved
  is the error code, the header, the failover and the health accounting.

  **Property:** the owner either accepts the new behaviour and it is recorded in `CLAUDE.md` beside
  the dialect-rescue gotcha, or the destructive check is moved ahead of the payload validity check so
  the refusal still fires.

- **Owner decision, DEFERRED 2026-09-05: whether to adopt the runbook's Tier 1 duplication CI
  gate.** [`reviews/duplication-and-complexity-runbook-2026-09-05.md`](reviews/duplication-and-complexity-runbook-2026-09-05.md)
  proposes a blocking CI check on jscpd clone counts. `CLAUDE.md` states the opposite invariant —
  static analysis is advisory, CI does not run it, and the gate is the two typechecks, the server
  suite, the dashboard checks and the package checks. The owner deferred the choice until after one
  full green release cycle, which is what the runbook itself proposes for its own Tiers 2 and 3.
  **Property:** the two documents agree — either `CLAUDE.md` records the amendment and CI carries
  the gate, or the runbook records that Tier 1 was declined, and why.

- **`dispatch` loses the job when `waitMs` exceeds the host's tool-call timeout — the SERVER half.**
  ⚠ The item itself is MACHINE-WIDE and already filed as the first entry of `C:\Code\docs\backlog.md`
  (opened 2026-09-05 at the tutor-sync lap, corroborated three more times the same evening at this
  repository's Phase 1a lap: `waitMs` of 100000 and 240000 both returned `Error: Request timed out`
  with no job id, a concurrent pair returned `Error: Connection closed`, the job counter restarted
  at `job-0001` every time, and one packet lost 100 seconds of lane work). It is recorded here as
  well only because the fix is partly ours: `src/mcp/server.ts` decides what `dispatch` returns and
  what the `waitMs` ceiling is. **Property (this repository's half):** the server either returns a
  pollable job id whatever `waitMs` says, or refuses a `waitMs` it cannot honour and states the
  ceiling it accepts. Do not restate the host half here; keep it in the machine backlog, which is
  where every other host that hits it will look.

- **Muse Spark 1.3 — and every Responses-only OpenCode Zen SKU — is unreachable through the
  relay, because no upstream speaks the OpenAI Responses API.** Zen serves
  `muse-spark-1.3-contributor-free` and `muse-spark-1.2-contributor-free` on `/zen/v1/responses`
  only; `/chat/completions` and `/messages` answer HTTP 500 for them (measured 2026-09-04, with and
  without a key, at budgets 64–1024, while a sibling free SKU answers 200 on chat). `Kind` is
  `"anthropic" | "openai"` (`src/config-types.ts:7`) and the upstream paths are `/chat/completions`
  and `/v1/messages` (`src/backend.ts:799`, `:1586`, `:1723`); `src/responses-request.ts` is the
  Codex FRONT direction. Owner decision on the *contributor* data-use terms comes first
  ([`muse-spark-1.3-opencode-zen-2026-09-04.md`](muse-spark-1.3-opencode-zen-2026-09-04.md) §5).
  **Property:** a provider whose models are served only on `/v1/responses` is addressable as
  `provider/model` on both fronts with tools, streaming and usage (`reasoning_tokens`,
  `cached_tokens`) intact. Prefer a `wire: "responses"` option on `kind: "openai"` over a third
  `Kind` — the latter touches about 55 `kind ===` sites in 19 files. Rows 10–13 of the doc are the
  request, response and stream shapes to speak; the doc's §3 route B lists the field mapping.

  **Owner decision 2026-09-04 (option A):** contributor SKUs may be routed automatically. The
  terms question is settled; this entry is now engineering only. After route B lands, pin both
  contributor ids as `preferred` in the effort pools (finding 6: no tier-data row, so no automatic
  admission), and the property above gains: `opencode/muse-spark-1.3-contributor-free` answers a
  real request through `pool/*` on both fronts. Route A (four `opencode-muse-spark` OpenCode-CLI
  rungs, one per ladder) went live the same day and is verified through MCP `dispatch`
  (HANDOFF §0), so this entry is route B only.

- **`include: "free"` pools carry paid and unknown-cost deployments, and on this machine no guard
  stops a walk from reaching them.** Deliberate since the admission reversal
  (`test/dynamic-pools.test.ts`: "Reversed deliberately… the `freeOnly` guard (default ON for
  offload) is what keeps a pool free-only"), but the live config has `freeOnly: false` on all three
  offload rules, so `pool/medium` today lists `openrouter/anthropic/claude-opus-5`,
  `kilo/anthropic/claude-fable-5` and 27 unknown-cost `opencode/*` paid SKUs behind the free
  members (Zen's `/models` carries no prices). Nothing is spent today only because every paid
  credential is dry (OpenRouter 402 at 0 % credit, Kilo 402, Zen `401 no payment method`); a
  topped-up balance is spent by the first walk whose free members all fail. Side effect: each Zen
  401 re-confirms the accepted `subscription-required` fact (scope `credential`,
  `costClasses: ["paid","unknown"]`) for 24 h, it lapses, and the 27 members return —
  `runtime-telemetry.json` counts 45 failed calls across five of them — and on 2026-09-04 the fact
  vanished (837 min early) right after a success on a FREE Zen deployment the fact never covered.
  The `dynamic-pools.ts` row of `CLAUDE.md` described the pre-reversal rule until 2026-09-04.
  **Owner decision 2026-09-04: `freeOnly` stays off** — paid capacity strictly behind every free
  member is the deliberate last resort (HANDOFF §6; the contract is now stated in the
  `dynamic-pools.ts` row of `CLAUDE.md`). **Property (what remains):** a cost-class-filtered fact
  is retracted only by evidence inside its own cost classes, so a success on a FREE deployment can
  no longer re-admit the paid SKUs the fact excluded; and the pool section of `docs/reference.md`
  is checked for the pre-reversal "free-only" wording and restated if it carries it.

- **A zero-priced deployment with no exact tier-data row can never enter any effort pool, and a
  `-free` / `-contributor-free` suffix defeats the match against its base SKU's row.**
  `strengthAllowedForEffort` (`src/benchmarks.ts:164`) requires `basis: "snapshot"`,
  `match: "exact"` and ≥3 published signals; `muse-spark-1.2-contributor-free` finds nothing although
  `muse-spark-1.2` has a row, and every Zen `-free` SKU (`nemotron-3.5-lightning-free`,
  `mimo-v2.5-free`, `nemotron-3-ultra-free`, `ling-3.0-flash-fin-free`, `big-pickle`) is absent
  from all four pools while the paid Zen SKUs above are members. "A model clearing NO band is
  admitted nowhere" is a stated rule (CLAUDE.md), so this is a cost, not a defect — but the cost now
  falls on exactly the free capacity the pools exist to spend. **Property:** a free-class,
  tool-capable deployment that no benchmark source has scored yet has some deliberate route into a
  pool short of `preferred` — e.g. treating `-free`/`-contributor-free` as a PRICE suffix that
  resolves to the base SKU's row (same weights, different price; unlike an effort suffix, which
  `normName()` rightly never strips), or a bounded probation band — and the choice is recorded.

- **`llm-relay keys` cannot verify a mixed provider whose completion probe model is paid.**
  `opencode#default` reports `UNVERIFIED — /models is public and the probe model answers HTTP 401
  with or without the key`; one completion on `opencode/nemotron-3.5-lightning-free` through the
  relay answered 200 in 2.3 s and verified the key (2026-09-04). **Property:** the escalation probe
  picks a free-class model of the provider when the catalog has one (`assessCost` over
  `cachedModels`), so a valid key on a billing-gated account reports `valid`, not `unverified`.

- **Raise `publish.yml`'s `timeout-minutes: 15` — the v0.69.0 publish exhausted it on the first
  attempt.** `npm ci` took 5 min 2 s against a 10 s baseline on the v0.68.8 run, and the smoke
  test's two `npm install` calls cost about 5 min each; ordinary npm-registry slowness, with no
  code or CI defect, ran the job past 15 minutes and GitHub Actions cancelled it before it reached
  the publish step. A `gh run rerun` of the exact same run then published cleanly (`npm ci` still
  4 min 17 s the second time), so this is a live-fire risk on every future release rather than a
  one-off.

  **Property:** a publish run has enough timeout headroom to absorb ordinary npm-registry slowness
  without a human having to notice the cancellation and manually re-run it.

- **Verify the Codex `relay` agent end to end in Codex Desktop** (owner-driven, 2026-09-04, lap 2).
  Commit `e73d113` added `~/.codex/agents/relay.toml` via `scripts/install-skill.mjs` (marker
  `# llm-relay:codex-relay-agent v1`, read-only sandbox, dispatch tools enabled, no model pinned so
  Codex Desktop's account check never sees a `pool/*` child model). Whether a spawned Codex subagent can
  reach the MCP `dispatch` tool across every Codex surface remains unverified: standalone `codex exec`
  exposes no MCP tools at all, so this requires a live Codex Desktop session driven by the owner.

  **Property:** one Codex Desktop `relay` subagent reply carries a `provenance:` line (e.g.
  spawning `relay` with "read C:\Code\llm-relay\package.json and reply version=<field>" returns
  the version and provenance from a dispatch lane).

- **Make `test/os-keyring.test.ts` "sanitizes a thrown child error" path-agnostic** (2026-09-04, lap 2, low).
  The test passes cleanly in the main repository checkout, but fails inside a lane git worktree where
  `node_modules` is a junction due to a path-sensitive error assertion.

  **Property:** the test passes in any checkout location, including worktrees with junctioned `node_modules`.

- **Decide the post-commit remedy for a stream that stalls or crawls after first content**
  (owner decision, 2026-09-04, from the audit-triage lap's hedge work). The hedge race now settles
  at first content, so a primary that returns headers plus a metadata event and then nothing is
  hedged. A stream that COMMITS and then stalls or crawls cannot be hedged: the client already
  holds its bytes. The per-token rule (`hedge-trigger.ts` rule 1) has evidence only there, and its
  only honest remedy is an ABORT that hands the failure to the client to retry — which turns a
  slow-but-correct answer into a failed turn for a harness that does not retry a mid-stream error.
  Options were (A) build the abort on a measured per-token stall threshold, or (B) leave in-flight
  streams alone and rely on latency demotion plus the `slow` band for the NEXT request.

  **Owner decision 2026-09-04: measure first, then build only if clients retry.** Recorded beside
  §12 of [`hedged-attempts-design-2026-08-30.md`](hedged-attempts-design-2026-08-30.md).

  **Property:** a dated doc records what Claude Code and Codex do when a stream carries an SSE
  `error` after content has arrived — retry the request, or fail the turn — measured against a
  scratch relay on both fronts. If a retry reaches another candidate, the abort on a per-token
  stall threshold is built with an announced reason and a pinning test; if not, option B stands and
  this entry closes on the measurement alone.

- **Give the metering subsystem a channel to say it stopped metering** (audit DR-006, verified
  2026-09-04). `writerStatus` and `lastWrite` on the accounting store have zero consumers outside
  the store; the store keeps accepting events after a refused writer lease, and a null
  `snapshots()` silently stops persistence while the relay keeps serving.

  **Property:** `llm-relay cost` and `/telemetry` state when the store's last flush failed or the
  writer lease was refused, so "no spend since noon" cannot be mistaken for "no traffic since
  noon".

- **Bind the listener before opening the writable accounting store, and handle the listener's
  `error` event** (audit DR-009, verified 2026-09-04). `cli.ts` constructs the store before
  `server.listen`, and `server.ts` registers no `error` handler, so a second relay process opens
  the same directory with an in-process writer lease and then dies on `EADDRINUSE` with an
  uncaught exception.

  **Property:** a second `llm-relay` start against a bound port exits with a clear message and
  touches no file under `usage/`.

- **Make credential containment on the forward path an allow-list** (contract review DR-006,
  verified 2026-09-04). `buildForwardHeaders` strips exactly `authorization` and `x-api-key` when
  a target is contained; any other credential-bearing inbound header (`cookie`, `x-goog-api-key`,
  `api-key`) is forwarded verbatim to a third-party anthropic-kind base. `log.ts` already uses the
  allow-list shape for the same reason.

  **Property:** a contained anthropic-kind target receives only headers from a declared
  allow-list, and a test sends a `cookie` and asserts it does not egress.

- **Prune `candidate-runner.ts` exports nothing consumes** (audit DR-012 / contract review
  DR-007; 90 exports at HEAD, roughly a third with no consumer in `src/` or `test/`). The
  decomposition published `server.ts` internals as public API; the test-only seams
  `orderByUsability` and `classifyStatus` are recorded, the rest are not. Related, low:
  `SPEND_CELL_KEYS` (`accounting-store-schema.ts`) and `SHARE_CELL_KEYS` (`dashboard-contract.ts`)
  are two lists of one four-name set, and the schema module already imports the contract.

  **Property:** every export of `candidate-runner.ts` has a consumer in `src/` or a test that names
  it as a seam, and the four spend-cell names have one list.

- **`test/doc-links.test.ts` resolves links against the working tree, so an untracked file makes a
  local green that CI cannot reproduce** (2026-09-04, found by the v0.71.0 publish failure). The
  backlog linked `muse-spark-1.3-opencode-zen-2026-09-04.md` while that document was still
  untracked in this checkout; the test passed locally and failed in CI, and the release had to be
  re-cut as v0.71.1.

  **Property:** the test resolves a relative link only against files git tracks (`git ls-files`),
  so the local and the CI verdict agree.

- **State the default-ON routing terms in the user docs** (audit DR-024 residual, 2026-09-04).
  `routing.hedge`, `routing.latency` and `routing.laneProbe` default ON by owner decision;
  `docs/reference.md` should list each with its default and the one-line revert.

  **Property:** each default-ON routing key appears in `docs/reference.md` with its default and
  its `false` form.

## Closed

- ✅ **`llm-relay mcp` reads and dispatches each request the moment it arrives** (filed
  2026-09-04, closed 2026-09-05, v0.72.1). `McpDispatchServer.serve` replaced the per-chunk
  `await server.ingest(chunk)` in `runMcp`; `ingest` splits synchronously and is no longer
  `async`. Five pinning tests (`test/mcp-server.test.ts`, "stdio serve loop") and a mutation
  check (the restored await turned exactly the two concurrency tests red). Measured live against
  the released v0.72.0 binary on an isolated daemon: a `dispatch_status` written 400 ms after a
  blocking `dispatch` was answered after 6621 ms on v0.72.0 (only once the dispatch returned) and
  in under 1 ms on the fix; a second `dispatch` written 150 ms after a first finished 12 s after
  its own write while the first still ran for 63 s. Numbers, method and the stated trades (no
  concurrency cap; out-of-order responses are JSON-RPC-legal):
  [`mcp-concurrent-ingest-2026-09-05.md`](mcp-concurrent-ingest-2026-09-05.md). audit-tools'
  per-call child pool (`scripts/shared/mcp-dispatch-lane.mjs`) is a workaround it can now retire.

- ✅ **Owner question: does hedging need a terms review?** (audit DR-003; closed 2026-09-04 by
  owner decision: no review needed). Duplicate free-tier requests are within the relay's use as the
  owner runs it; recorded beside D1 in §12 of
  [`hedged-attempts-design-2026-08-30.md`](hedged-attempts-design-2026-08-30.md). The finding
  closes on the decision, not on a review.

- ✅ **Remediate, or explicitly accept with reasons, the four verified audit findings**
  (2026-09-04, audit-triage lap). DR-001 FIXED: the configuration vocabulary has one declaration in
  `config-types.ts`, `config.ts` re-exports it, the drifted `HedgeConfig` keys are folded in, and
  `test/config-vocabulary.test.ts` plus the general `test/one-declaration.test.ts` pin it (the
  general guard found and closed two more pairs, `QuotaAxis`/`QuotaPeriod` and
  `AccountingSpendCoverage`, and a third copy of two compat unions in `openai-request.ts`).
  DR-002 BUILT as race-to-commit (`withCommitProbe`/`attemptWon`, both fronts, mutation-checked
  both ways) after the owner said the hedge exists for wedged requests; per-token is documented
  as inert on the hedge path by construction, and the post-commit remedy is the owner decision
  above. Contract DR-003 FIXED: `RELAY_AUTHORED_PROVENANCE` total table,
  `test/accounting-failure-kind.test.ts`. Contract DR-004 FIXED: `GET /v1/models` omits an
  unresolved context window and resolves `auto` through the ladder; Codex v0.153.2 measured
  tolerating the omission. Verdicts for all 35 findings:
  [`audit-triage-2026-09-04.md`](audit-triage-2026-09-04.md).

- ✅ **Clean up the DR-020 residue in the accounting store's public types** (2026-09-04,
  audit-triage lap). `SnapshotMutationResult` lost `recovered`/`recovery-loss`, `transactionId`
  and `quarantinedPath`; `SnapshotJournalHooks` became `AccountingReadHooks` with `beforeRead`
  only. The unused `JsonStore` class went with it (audit DR-011).

- ✅ **Calibrate `routing.hedge`'s floor from data, and token-scale the floor delay** (2026-09-04,
  lap 2, `cc4da1b`). Commit `cc4da1b` resolved the flat floor: the hedge floor now scales with the
  request's estimated input tokens (`floorMs(request) = max(minFloorMs, msPerInputToken × estimatedInputTokens)`),
  with the estimate threaded from both fronts into the decision. The flat `floor` basis is replaced by
  `input-size` (announced in `x-llm-relay-hedged` alongside token count), operating beside `per-token`
  and `absolute`. A new calibration script `scripts/calibrate-hedge-floor.mjs` fits `msPerInputToken`
  from `~/.llm-relay/usage/recent.json`. Ran on 2026-09-04 against 100 successful requests (55 with
  ≥10,000 input tokens), it fitted 0.036 ms/token (p25 of latency÷inputTokens among large-prompt
  requests), below the accepted [0.05, 0.5] band, so the default stays 0.15 until traffic fits inside
  the band. Analysis of recent requests also clarified why a floor rather than an expectation is used:
  requests under 2,000 input tokens had a median latency of 30.1 s (served by slower members) while
  requests of 10,000+ tokens had 10.9 s (served by kilo/nemotron), so deployment identity dominates
  latency over prompt size and an "expected time × margin" rule would hedge slow members late. Design
  amendment recorded in [`hedged-attempts-design-2026-08-30.md`](hedged-attempts-design-2026-08-30.md).

- ✅ **The `relay` agent on `model: haiku` answers trivial pure-text tasks itself instead of
  dispatching — superseded** (2026-09-04, lap 2, `e73d113`). The owner directed: "I don't want to
  hard code a model name." Commit `e73d113` updated the Claude `relay` agent template to `model: inherit`
  (template v4; the official docs state an omitted model can fall through to `CLAUDE_CODE_SUBAGENT_MODEL`,
  so `inherit` is the explicit spelling), and callers can still pass `model` on the `agent()` or
  `Agent` call. No model is pinned by default. The residual behaviour (that smaller models may answer
  trivial pure-text echoes directly without dispatching) is documented in the skill reference
  [`../skills/llm-relay/SKILL.md`](../skills/llm-relay/SKILL.md) alongside the rule that callers requiring
  lane execution should verify the `provenance:` line.

- ✅ **Verify the `relay` custom agent type end to end in a fresh Claude Code session — verified**
  (2026-09-04). An agent tool probe — `[agent] Read C:\Code\llm-relay\package.json and reply
  version=<field>` — returned `version=0.69.0` plus a `provenance: lane=claude-free-pool
  spec=pool/medium elapsed=6s` line, 2 tool calls (ToolSearch, dispatch), 17 s wall. A three-call
  Workflow, `agent(task, {agentType: "relay", model: "haiku"})` against two `package.json` fields
  and one `vitest.config.ts` option, went 3/3 correct with 3/3 provenance lines, lane elapsed
  35 s / 16 s / 16 s, 6 tool calls, 60 s wall. Not merely the file existing on disk with the right
  marker — a real dispatch through the installed agent, completing correctly.

  Verification found two defects, both fixed and shipped in v0.69.1: (a) the v1 template's
  `tools:` list omitted `ToolSearch`, and the dispatch MCP tools are DEFERRED in Claude Code, so
  the wrapper could never load their schemas and silently answered every task itself with zero
  tool calls (`b8a90ae`, template v2: no own knowledge, dispatch every task, provenance line or
  failure); (b) Claude Code loads a custom agent definition ONCE per session, so after `setup`
  rewrote `relay.md` mid-session the running session kept reporting the stale v1 marker and tools
  until the file was deleted (noticed only minutes later as "no longer available") and recreated
  (`d9fd32a`, template v3: `tools:` now leads with ToolSearch).

  ⚠ Residual: on `model: "haiku"` a trivial pure-text task is still answered by the wrapper itself
  rather than dispatched, even under template v3 — tracked as its own Open entry, above.

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

