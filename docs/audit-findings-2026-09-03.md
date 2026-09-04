# llm-relay — audit findings ready for remediation

Generated 2026-09-03T15:06:22.584Z from audit run 2 (all lanes on Opus 5).
Artifacts: `.audit-tools/audit/` (run 2) and `.audit-tools/audit-run1-weakcharters/` (run 1).

**Scope of this file:** llm-relay code findings only. Defects in the AUDIT TOOL itself are filed
separately in `C:/Code/audit-tools/docs/backlog/open-bugs.md`; the lane-selection issue is filed
machine-wide in `C:/Code/docs/backlog.md`.

**Totals:** 27 merged conceptual findings, 8 contract findings, 6 process findings.

Note (2026-09-03, lap orchestrator): this file holds the 27 merged conceptual findings and the 8 contract findings, 35 in total. The 6 process findings the totals line names are not present in this file; they were never written into it. Treat the count above as 35.
The audit was stopped deliberately before task planning and execution.

---

## Verified by the orchestrator against source

These five were checked directly during the run, not accepted on a lane's report. Treat them as
established fact and start here.

1. **`checkCwd` permits path traversal** — `src/mcp/lane-runner.ts:464-484`. `normalizePath`
   (`:494`) unifies separators, trims trailing slashes and lowercases, but never calls
   `path.resolve()`, so `..` segments survive into the `startsWith` comparison while
   `existsSync`/`statSync` validate the real escaped directory. Reproduced against built `dist/`:
   `C:\Windows` is refused; `C:\Code\llm-relay\..\..\Windows` is PERMITTED and resolves to
   `C:\Windows`. That path is then handed to a spawned lane as its cwd.
   ⚠ Bound the severity honestly: `allowedRoots` is opt-in and CLAUDE.md documents existence-only
   as deliberate when it is absent. This breaks the guarantee only for an operator who asked for
   containment. The correct helper already exists in-repo (`inside()` in `accounting-store-io.ts`).
   The five existing `checkCwd` tests cover sibling prefixes and trailing separators, not `..`.

2. **Hedging's primary rung is unreachable while the feature is default-ON** —
   `src/hedge-trigger.ts:224` passes a literal `0` for `tokensSeen`; `:161` gates the per-token
   rung on `tokensSeen > 0`. The live call site is `src/server.ts:763`, which passes only
   (pings, isFree, settings). `shouldHedge`, `hedgeLabel` and `hedgeDelayMs` have zero `src/`
   callers. Effective policy is the 20 s floor, which the source itself labels an uncalibrated
   placeholder. CLAUDE.md describes the ladder as "per-token → absolute → floor" with per-token
   PRIMARY; per-token can never fire.

3. **`src/config-types.ts` duplicates `src/config.ts`** — 385 lines; `config.ts` never imports it.
   `EFFORT_LEVELS` is declared at `config.ts:46` AND `config-types.ts:15`, both live at runtime
   (`cli.ts` imports config.js's, `dynamic-pools.ts` imports config-types.js's). ⚠ Both copies
   carry the SAME doc comment asserting "one declaration, and the type is derived from it rather
   than the other way round" — the invariant comment was duplicated along with the violation.

4. **`ProxyAccountingFailureKind` is exported twice under one name**, identical members, at
   `src/accounting-state.ts:48` and `src/candidate-runner.ts:1491`. TypeScript reports nothing;
   two identical structural unions are compatible.

5. **jscpd already detected finding 3, and the summary reported it clean** — `analysis-reports/`
   holds 5 clone blocks covering `config-types.ts` lines 1-375 against `config.ts`, inside a run
   reporting 572 clones / 5,405 duplicated lines (4.64%). `run-summary.txt` records `jscpd: 0` and
   `Failures: none`, because `scripts/analysis-run.mjs` prints `res.status` — the process EXIT
   CODE — under each tool's name. ⚠ Fair framing: CLAUDE.md states static analysis is deliberately
   advisory and outside the gate, so not failing CI is by design. The defect is that the summary
   misreports an exit code as a finding count, in a gitignored directory nobody reads. Also
   `jscpd.json` contains ANSI console text, not JSON.

---

## ⚠ Read this before trusting the coverage of this audit

**Seven of nine selected lenses produced zero findings.** The intent checkpoint selected
`architecture, maintainability, performance, tests, operability, config_deployment, observability,
provenance_labelling, concurrency_races`. Measured across the artifacts:

| Artifact | Lens distribution |
|---|---|
| `design_assessment.json` | architecture 97, maintainability 511 |
| `charter_register.json` | architecture 16 |
| merged conceptual findings | architecture 27 |

`performance`, `tests`, `operability`, `config_deployment`, `observability`,
`provenance_labelling` and `concurrency_races` produced **nothing**, and no artifact records the
gap. So this is a two-lens audit carrying a nine-lens label.

**What that means for remediation:** the findings below are sound, but they are not a survey.
Concurrency and provenance are this repository's own most-recorded failure classes and were not
reviewed as such. Anyone acting on this file should treat absence of a finding as absence of
evidence, never as evidence of absence.

**Other stated limits of this run:**
- Charter extraction covered 8 of 20 subsystems and 0 of 12 CONTESTED ones — the class where
  says-vs-does drift is likeliest. The register still prints `deltas_pending: false`.
- Adjudication has no rejection outcome: 50 merged + 10 retained = 60 of 60 candidates survived,
  so the run publishes no false-positive rate. One candidate whose defects the judge verified as
  already fixed at HEAD was merged at 70% rather than rejected.
- The html/css analyzers failed to install; 3 dashboard files used a regex floor while
  `analyzer_capability.json` records `"status": "applied"`.
- The knowledge-graph MCP server was unavailable to every lane in this run.
- Tree was pinned throughout: `git_history_baseline.head` matched HEAD, clean working tree, no
  `src/` mtime change during the 83-minute run.

---

## Merged conceptual findings (27)

### DR-001 — config-types.ts is a second live declaration of the entire configuration surface, and config.ts never imports it

**HIGH** · confidence high · design_simplification · systemic

All seven perspectives raised this independently; I re-verified it mechanically. A whole-tree scan for exported names declared in two src modules returns 36 names, and 31 of them are the config-types.ts / config.ts pair: Config, Routing, ResolvedTarget, ProviderConfig, OffloadRule, OffloadConfig, ReshaperConfig, PoolPolicy, LadderRung, HedgeConfig, McpSettings, LaneProbeSettings, LatencyDemotionConfig, QuotaEnforcementConfig, StickyConfig, StickyRoutingConfig, CliLaneTemplate, ProviderCompatConfig, Mode, Kind, AuthHeader, CredentialMode, ToolCallIdMode, ThoughtSignatureMode, RequestHeaders, ProviderTierType, OffloadScope, ClaudeTierName, EffortLevel, CLAUDE_TIER_NAMES and EFFORT_LEVELS. `grep -c config-types src/config.ts` returns 0.

TWO OF THEM ARE RUNTIME VALUES, so this is not an erasable-type question. EFFORT_LEVELS is declared at src/config-types.ts:15 and src/config.ts:46; src/cli.ts:16 imports one array and validates the --effort flag against it at cli.ts:3607, while src/dynamic-pools.ts:23 imports the other and derives EFFORT_ORDER from it at line 87. Two frozen arrays exist in one process, linked only by structural coincidence. CLAUDE_TIER_NAMES is duplicated the same way (config-types.ts:21, config.ts:51).

THE FAILURE IS SILENT AND ASYMMETRIC IN THE WRONG DIRECTION. Add an optional key to config.ts's Config -- the natural place, since the loader and validator live there -- and the object stays assignable to the config-types.ts Config, so the eight src modules and two test helpers typed against the copy simply cannot see it. No compile error, no failing test; the symptom is an operator-set knob some subsystem silently ignores, in routing. The reverse direction does error, so the compiler protects only the harmless case.

THE COPY IS ALSO ABRIDGED, which matters in a repository whose specification is its prose. config.ts:999-1003 explains reshaperCandidates ordering; config-types.ts:350 says only `Ranked reshaper candidates.` config.ts:1018-1027 spends ten lines on leaveMeAlone; config-types.ts:364-366 keeps one. The modules that most need the reasoning read the copy with the reasoning removed. And both copies carry the same doc comment asserting `one declaration, and the type is derived from it rather than the other way round` -- the warning was duplicated along with the thing it warns about.

THERE WAS NO CYCLE TO BREAK: madge --circular over src test scripts returns [], and the file already demonstrates the correct pattern for its seven non-duplicated symbols -- src/configured-limits.ts:27-34 and src/credential-fleet.ts:12 import from config-types.ts and re-export.

RECOMMENDATION (mechanical, no runtime effect): make config-types.ts the sole declaration, have config.ts import and re-export so no existing importer moves, and delete the 31 duplicates. Collapse ProxyAccountingFailureKind to one home in the same pass. Deleting config-types.ts and repointing its ten importers at config.ts is equally defensible; keeping both is the only end state that is not.

**Grounding.** [object Object]

**Files.** `src/config-types.ts`, `src/config.ts`, `src/dynamic-pools.ts`, `src/cli.ts`, `src/configured-limits.ts`, `src/accounting-state.ts`, `src/candidate-runner.ts`, `CLAUDE.md`

### DR-002 — Hedging is on by default, duplicates the one scarce resource, and its adaptive rung is unreachable from production

**HIGH** · confidence high · core_assumption · systemic

The project exists because free-tier allowances are scarce. Hedging is the one behaviour that spends two of them for one request, it is ON by default, and the number that decides when to spend the second is declared in its own source as an uncalibrated placeholder.

VERIFIED IN SOURCE. resolveHedgeSettings defaults enabled to true (src/hedge-trigger.ts:81) and createProxy sets hedgeMaxInFlight to 2 when enabled (src/server.ts:876), so a stock install duplicates. The only production entry point is hedgeDelayDecision (src/hedge-trigger.ts:218), which calls hedgeThreshold with tokensSeen hardcoded to 0 at line 224; hedgeThreshold gates its per-token rung on `tokensSeen > 0` at line 161. The rung the module documents as primary and self-correcting therefore cannot fire on the wired path. shouldHedge, hedgeDelayMs and hedgeLabel have zero src callers outside the module -- and candidate-runner.ts:688 carries its own hedgedLabel for the header that actually ships, so the module duplicates even its own label concept.

WHAT ACTUALLY RUNS is rung 3 and the floor: `max(floorMs, probe_p90 * margin)` over PROBE samples only. Probes are sent at max_tokens 1, so for a healthy free deployment p90*2 sits far below DEFAULT_HEDGE_FLOOR_MS = 20000 and the floor decides. The entire observable feature is: if nothing has resolved in 20 seconds, start the next free candidate too. margin and minSamples have almost no effect.

THE CONSTANTS SAY THEY ARE NOT READY. src/hedge-trigger.ts:48-55 states they are PLACEHOLDERS, that DEFAULT_LATENCY_MS_PER_TOKEN earned its 250 from 68 real requests and these have no such backing, and to `calibrate them against real traffic before the walk integration ships`. The walk integration shipped on both fronts.

EXPECTED COST, stated as an estimate rather than a measurement: the module's own evidence records successful nim requests running 559 ms to 96959 ms and that a 25000 ms cap would have cut 22.5 percent of real successes. A flat 20000 ms hedge floor therefore fires on a similar share of healthy long generations -- the ones that consume the most allowance. Aborting the loser saves tokens but not the request itself against RPM/RPD allowances, and an aborted loser teaches the breaker nothing (src/hedge-race.ts), so the relay cannot see the load it adds to itself.

GRADUATED REMEDIES, in the order they buy the most safety per edit. (1) Default routing.hedge OFF until the floor is calibrated -- the source disclaims the number, and false is documented as a byte-for-byte revert. (2) Keep it on but make the fallback evidence-gated: do not hedge a deployment with no measured probe evidence, mirroring what latency-demotion.ts already does for the opposite reason, and let the v0.65.3 elapsed-time cooldown handle the 43-timeout hang case. (3) If the ladder is to stay, thread a real streaming token count so the per-token rung engages; otherwise delete shouldHedge, hedgeDelayMs, hedgeLabel and the per-token rung and ship the honest one-comparison rule the code already implements. A module that reads as adaptive while behaving as a flat timer will be mis-tuned by whoever inherits it.

**Grounding.** [object Object]

**Files.** `src/hedge-trigger.ts`, `src/server.ts`, `src/hedge-race.ts`, `src/candidate-runner.ts`, `docs/hedged-attempts-design-2026-08-30.md`

### DR-003 — (judge-added) Hedging duplicates third-party free-tier traffic, and the project's only terms review predates it and covers a different vendor

**HIGH** · confidence medium · core_assumption · systemic

No perspective asked what the providers think. All seven examined hedging as an engineering trade -- duplicated requests against a scarce allowance, an uncalibrated constant, a dead rung -- and none asked whether deliberately sending two requests where one was asked for is compatible with the terms of the free tiers the whole system depends on.

WHY THIS IS THE ONE RISK WITH A WHOLE-POOL BLAST RADIUS. Every other finding here costs correctness, clarity or install size. Free-tier account suspension is the failure that takes the pool down at once and cannot be fixed by a code change: docs/pool-eligibility.md already records that a 15-member pool resolved to only four independent quota domains, so a single provider decision removes a quarter of the fleet. The relay's entire value proposition rests on accounts it does not control, on tiers whose terms typically speak to automated or abusive usage patterns, and hedging is by construction a pattern that inflates request counts against those accounts without inflating the work asked for.

WHAT EXISTS AND WHY IT DOES NOT COVER THIS. docs/codex-review-2026-08-05.md is the repository's terms record. It is dated 2026-08-05, twenty-five days before hedging landed, and its operative sentences are entirely about Anthropic: routing Claude Code through a gateway, and the prohibition on offering Claude.ai login or routing Free/Pro/Max credentials on behalf of other users. Its standing invariant -- credentials stay user-operated, no hosted relay, no pooled consumer accounts -- is about distribution, not about request volume, and it says nothing about the third-party free tiers hedging actually duplicates against. That invariant is reproduced verbatim in CLAUDE.md, so the repository reads as having a settled terms position while the behaviour that most plausibly disturbs it was never assessed.

THE HEDGE CONTAINMENT MAKES IT WORSE, NOT BETTER, ON THIS AXIS. The D1 bound confines duplication to deployments assessCost calls FREE. That is exactly right for protecting the operator's money and exactly backwards for protecting the operator's accounts: the relay duplicates only where the account is the free one, i.e. the account most likely to be terminated rather than billed, and (see DR-010) the classifier that decides FREE can be satisfied by a substring of a vendor-chosen model id.

RECOMMENDATION -- cheap, and it is a decision rather than an implementation. (1) Extend the terms record to the third-party providers actually in the default template, naming for each whether its terms speak to request volume or automated duplication, and state the verdict. (2) Until that exists, treat the DR-002 default-OFF option as the conservative reading rather than merely the calibration-driven one. (3) Whichever way it lands, record it beside the D1 containment in docs/hedged-attempts-design-2026-08-30.md, so the next reviewer finds an answer rather than an absence. This does not require legal certainty -- it requires the question to have been asked once, in writing, by the same project that wrote a whole document to ask it about Anthropic.

**Grounding.** [object Object]

**Files.** `docs/codex-review-2026-08-05.md`, `src/hedge-trigger.ts`, `docs/hedged-attempts-design-2026-08-30.md`, `docs/project-goals.md`, `docs/pool-eligibility.md`

### DR-004 — Defect prevention is per-instance and hand-maintained, so instance N+1 of the codebase's own most-repeated defect class is always free to land

**HIGH** · confidence high · fundamental_approach · systemic

Four perspectives converged on this and it is the finding that generates several of the others. The project has correctly identified its most repeated defect -- a closed vocabulary restated instead of derived, where copies drift with no compile error possible -- and CLAUDE.md records eight historical instances in eight modules. The guards built in response, test/closed-vocabulary-coverage.test.ts (121 lines) and test/closed-vocabulary-routing.test.ts (175), enumerate already-fixed vocabularies one describe block at a time. They are a regression suite for instances already found and are structurally incapable of detecting the next one.

I RAN THE GENERAL CHECK THE PROJECT DOES NOT HAVE. About twenty lines walking src/, extracting `^export (const|let|function|type|interface|class|enum) <name>`, and reporting names declared in two modules returns 36 hits in seconds. Beyond the 31 config pairs of DR-001 it finds, all live at HEAD: ProxyAccountingFailureKind (a seven-member closed union, src/accounting-state.ts:48 and src/candidate-runner.ts:1491); AccountingSpendCoverage (src/accounting.ts:21 and src/accounting-store-schema.ts:145 -- the event vocabulary and the persisted schema each holding their own copy of the set that must agree for a shard to load); and QuotaAxis and QuotaPeriod, hand-written unions at src/quota-observation.ts:2 and :4 and independently derived from frozen arrays at src/dashboard-contract.ts:77 and :80, which is precisely the mixed form CLAUDE.md warns about.

TWO REFINEMENTS THE PERSPECTIVES DID NOT MAKE, both of which the check must carry to be adoptable. First, an allow-list is required and is not a weakening: src/openai-request.ts:83-84 deliberately restates ToolCallIdMode and ThoughtSignatureMode with the stated reason `restated so this module imports no config surface`, and Verdict legitimately means different things in src/delegate-gate/types.ts and src/ping/metrics.ts. A duplicate with a written justification at the declaration is a different object from a copy-paste. Second, the check should fail with the two names and both paths, so the allow-list entry a maintainer adds is a deliberate sentence rather than a suppression.

THE ALTERNATIVE THE PERSPECTIVES OFFERED, weighed. One reviewer proposed schema-first derivation (ajv standalone codegen or TypeBox) to make the whole class impossible by construction, noting ajv is already a runtime dependency used in exactly one file and that 231 type-predicate functions across 36 src files are hand-maintained. That is a real long-term answer and dashboard-contract.ts's browser-bundle constraint does not rule it out, but it is a large migration measured against a project rubric that presumes structure-first changes wrong. The graduated reading: ship the twenty-line duplicate-export check now, and if a schema-first proof is wanted, convert exactly one boundary -- accounting-store-schema.ts, where forgetting half an additive change already fails silently by halting persistence while the relay keeps serving -- and measure whether its closed-vocabulary tables can then be deleted.

The general point stands regardless of which is chosen: prose should carry WHY a rule exists and the compiler should carry WHETHER it holds. Today the second job is done by one person's memory of past incidents.

**Grounding.** [object Object]

**Files.** `test/closed-vocabulary-coverage.test.ts`, `test/closed-vocabulary-routing.test.ts`, `src/accounting-state.ts`, `src/candidate-runner.ts`, `src/accounting.ts`, `src/accounting-store-schema.ts`, `src/quota-observation.ts`, `src/dashboard-contract.ts`, `src/openai-request.ts`, `CLAUDE.md`

### DR-005 — The decomposed request path has file boundaries but no test boundaries, and the canonical proof of a load-bearing invariant runs code production never calls

**HIGH** · confidence high · structural_risk · systemic

The decomposition moved the request path into candidate-runner.ts (1,674 lines), routes/messages.ts (1,135), routes/openai-front.ts (689) and accounting-state.ts (376). It did not move the test seam. Verified: zero test files import candidate-runner.ts, routes/messages.ts, routes/openai-front.ts or accounting-state.ts -- candidate-runner appears in test/ exactly once, at test/fact-cost-class.test.ts:215, opened with readFileSync to grep its source text. Meanwhile 33 test files import src/server.js to call createProxy. The hottest ~3,900 lines are reachable only by assembling a full Config, a breaker, a catalog and mock backends and driving HTTP through the composition root.

THE SHARPEST CONSEQUENCE, which one perspective found and I confirmed: test/pool-failover.test.ts:559 declares the suite `orderByUsability -- demotes, never drops` and exercises orderByUsability (candidate-runner.ts:966), which has no src caller and is re-exported from server.ts:104 purely so tests resolve. It delegates to orderByUsabilityTracked (line 975), which returns quotaDemotedFirst and latencyDemotedFirst hardcoded to null (line 1002) despite its name. The live ordering is orderDeploymentGroupsByUsability (line 443), called at server.ts:548, and it is a near-verbatim copy with the identical seven-line cooling comparator. test/hard-cap.test.ts:973 and test/quota-demotion.test.ts:329 hit the same dead path. So the canonical proof of `health demotes, never drops` runs a parallel implementation the proxy does not call, and specifically the copy that cannot produce the demotion announcements.

SECOND CONSEQUENCE: the parseAssistant / frameOpensToolUse gap. Both were repaired -- at HEAD parseAssistant no longer demands a `role` field AssistantMessage does not declare, and frameOpensToolUse now collects and joins data lines. I checked, and I am correcting one perspective's framing accordingly: these are not live defects. What is live is that a grep of test/ for parseAssistant and frameOpensToolUse returns nothing, against this repository's own standing rule that a pinning test lands in the same commit as the source fix. Both gate tool-call validation and repair on the buffered Anthropic path (routes/messages.ts:203 and :494 treat a null parse as skip validation, skip repair, forward as-is). The related fixture problem is real and separate: 27 mock backend responses across test/server.test.ts and test/helpers/mock-upstream.ts supply `role: "assistant"`, so the suite describes an idealised backend while the relay exists because real free backends are not idealised.

THIRD: what green does not mean is not written down anywhere. process.env.VITEST appears 33 times across 22 src files, four of them inside createProxy itself (server.ts:702, 707, 708, 710): the lane cadence is never constructed, breaker persistence and dispatch-exhaustion persistence are never installed, and the model-call recorder is undefined. Two of those four exist solely to survive a restart, and they are absent from every one of the 33 proxy tests. Most of the 33 guards are well-reasoned (a suite must not spend lane quota or import live credentials) and CLAUDE.md records a deliberate decision against a shared test-mode helper; the gap is the missing inventory, and CLAUDE.md itself concedes the pinning test covers nine of thirteen paths and is not the whole set.

FOURTH, from the project's own record: docs/refactor-consistency-audit-2026-09-01.md:217-224 states that a control-flow verification over four regions completed only one, that nine of ten agents died on a spend limit, and that anthropic-walk, openai-front and headers-accounting `have had no control-flow review at all`. Three of the four regions of the restructured request path are simultaneously unreviewed by hand and unreachable by unit test.

RECOMMENDATION. (1) Delete orderByUsability and orderByUsabilityTracked, keep orderDeploymentGroupsByUsability as the sole ordering, and repoint the pool-failover, hard-cap and quota-demotion suites at it -- a strict deletion that raises the proven fraction of the invariant. (2) Give the candidate walk and the accounting lifecycle direct tests; src/hedge-race.ts and test/stream-pipeline.test.ts already demonstrate the pattern in-house. (3) Add direct tests for parseAssistant and frameOpensToolUse, and strip `role` from a share of the mock fixtures so the end-to-end tests exercise the declared contract. (4) Publish one enumerated inventory of what is suppressed under vitest, asserted against a grep of src/.

**Grounding.** [object Object]

**Files.** `src/candidate-runner.ts`, `src/routes/messages.ts`, `src/routes/openai-front.ts`, `src/accounting-state.ts`, `src/server.ts`, `src/stream-pipeline.ts`, `test/pool-failover.test.ts`, `test/hard-cap.test.ts`, `test/helpers/mock-upstream.ts`, `docs/refactor-consistency-audit-2026-09-01.md`

### DR-006 — The metering subsystem has no channel to report that it stopped metering, and the one mechanism allowed to refuse can go silently inert

**HIGH** · confidence high · missing_capability · systemic

Two perspectives found the two halves of one failure, and merged they are the sharpest inversion of this project's own principle in the system: everywhere else an unknown stays null with provenance attached, and here an unknown-because-broken is presented as a confident zero-state.

HALF ONE -- THE LEDGER CANNOT SAY IT IS DEAD. AccountingStore exposes writerStatus and lastWrite (src/accounting-store.ts:967-968) and a repository-wide grep finds ZERO consumers of either outside that file. On a refused writer lease the constructor completes, marks a global loss and keeps accepting every event (lines 958-963); scheduleFlush discards the SnapshotMutationResult (line 2034) and scheduleRetry retries on a capped backoff forever, also discarding it. A loss marker is in-memory state whose only route to the operator is the persistence that just failed. The read side then renders absence as `empty` -- documented as no accounting data yet -- which is the same rendering a genuinely new install gets. A ledger dead for three days displays as a clean, plausible, empty report, and the operator's provider-retention and cost decisions are made on exactly this data.

HALF TWO -- THE HARD CAP CAN BE UNENFORCEABLE AND NOTHING SAYS SO. The design deliberately gives exactly one feature the power to refuse a request; everything else may only reorder. evaluateHardCap reads usage only from the relay's own ledger and does `if (reading.value === null) continue; // unknown usage => no refusal, ever` (src/hard-cap.ts:183). That fail-safe is correct in isolation. But for the two token axes the reading is null in ORDINARY operation, not in an edge case: usageReading returns `tokens: null, basis: "mixed"` whenever a window holds both reported-token and estimated-only requests (src/accounting-store.ts:577), because the provenance rule forbids blending bases -- and the relay's traffic is a heterogeneous free pool where usage reporting is inconsistent by provider. One unreported request silences a token cap for the rest of that window. evaluateHardCap then returns null for three situations the operator must distinguish -- no cap declared, cap not reached, cap unevaluable -- and src/candidates.ts:636 renders an empty column for all three, as does the dashboard producer. There is no header, no config-load warning and no row anywhere. The only evidence would be an exhausted allowance.

RECOMMENDATION, and it does not relax the provenance rule anywhere. (1) Make the inert state a first-class verdict rather than a null: distinguish `no cap declared` (still null) from `cap declared, usage unreadable` by returning a verdict carrying capped false plus the reason, axis, period and declared cap, and render it in llm-relay candidates as something like `CAP INERT tpd 5000 (usage unreadable: mixed bases)`. Optionally warn once at config load when a token-axis cap is declared, since that is the axis most likely to be unreadable. (2) Promote persistence health to a projected field: carry writerStatus and the last write outcome into dashboard.snapshot.v1 and into the llm-relay cost footer beside the existing lag note, and emit one log line on each transition into and out of a failing writer state -- a fault that persists for days currently produces zero bytes of evidence. No refusal semantics change and no estimate is promoted to a measurement; the operator simply finds out.

**Grounding.** [object Object]

**Files.** `src/accounting-store.ts`, `src/hard-cap.ts`, `src/candidates.ts`, `src/availability-snapshot.ts`, `src/dashboard-snapshot.ts`, `src/dashboard-contract.ts`, `src/cli.ts`

### DR-007 — No Demotion value type: four demotion sources collapse to one string, the reason is re-derived, and the cooling comparator ranges over a different set than the classifier

**HIGH** · confidence high · architecture_pattern · systemic

This is the single change that would most improve the design, and it comes with a live ordering bug as proof. The routing domain has one obvious algebra -- a demotion is a value (reason, provenance, liftsAt or null, announcement) and the candidate order is the join over the active demotions for a cell -- and the code expresses it as N unrelated things without ever naming the value.

VERIFIED. targetUsability (src/candidate-runner.ts:363) takes four demotion inputs of four different shapes: breaker.isHealthy returns a boolean, cooledByAllowance returns a boolean sourced from the fact store, cooledByQuota returns a boolean but MUTATES breaker state (it calls breaker.recordQuotaCooldown from inside an ordering loop, src/candidate-runner.ts:350-360), and latencyDemotion returns a truthy object. All four collapse to the string `cooling`, discarding which fired.

THREE COSTS FOLLOW, all confirmed in source. (1) The reason must be re-derived: orderDeploymentGroupsByUsability re-invokes both demotion functions afterwards in two near-identical blocks (lines 473-495), and calls quotaDemotion(preferred, now) twice in a row -- once to test it, once with a non-null assertion to use it. (2) THE ORDERING IS WRONG FOR ONE TERM. coolingLiftTime (line 421) consults exactly two of the four sources: breaker cooldown and fact cooldown. latency-demotion.ts registers no breaker cooldown by design, so a latency-demoted candidate is placed in the cooling band by the classifier, returns null from the comparator, and the comparator sorts null LAST (`if (liftA === null) return 1`). A latency demotion lifts as soon as the rolling window recovers -- possibly immediately -- so it is ranked behind a candidate whose quota does not lift for an hour. The soonest-lift-first rule is inverted for it, and nothing can notice because neither function takes a Demotion. (3) Adding a term is O(call sites): quotaDemotion and latencyDemotion each appear as a separate optional positional on four functions, as separate fields on Handlers (server.ts:355-356), as separate keys on the return type and as separate label functions. src/spend-headroom.ts and src/network-block.ts are both display-only today, i.e. candidates for exactly this.

THE ANNOUNCEMENT SIDE IS THE SAME MISSING TYPE. Nineteen x-llm-relay-* header names exist, fifteen of them declared inside src/backend.ts (a transport module with no business owning the observability vocabulary), emitted by three partially-overlapping assemblers: responseHeadersForTarget (candidate-runner.ts:219) for the served response, walkExitHeaders (766) for transport exits, and respondAllCapped (847) for the local 429. ServedAnnouncementContext fixed the two-fronts half by growing one optional field per decision, which responseHeadersForTarget then emits through seven consecutive identical if-lines. A new announcement costs at least five coordinated edits and nothing detects a missed assembler -- which is how CLAUDE.md's two recorded drifts happened.

ONE PERSPECTIVE ARGUED THE OPPOSITE READING and it is worth stating: five independently engineered terms converging on one boolean suggests some of them should not exist, latency demotion most of all given its two same-day regressions. I keep both positions because they are compatible: the honest counter-argument -- the evidence differs even though the verdict does not, and transparency requires the reasons stay distinguishable -- argues for ONE list of typed demotion reasons attached to a candidate and rendered once, which is exactly the recommendation, not for five parallel pipelines each with a config key, a module, a header and a dataset dependency.

RECOMMENDATION. Introduce one Demotion record { reason, provenance, liftsAt, announce } and one DemotionSource = (attempt, now) => Demotion | null. targetUsability takes readonly DemotionSource[] and returns the winning Demotion; the cooling comparator sorts on the returned liftsAt so it cannot see a different set than the classifier; the announcement is read off the returned value. That deletes the duplicated blocks, fixes the latency inversion structurally rather than with a fifth special case, makes a new term a one-line registration, and makes it mechanically checkable that every declared header has an emitter.

**Grounding.** [object Object]

**Files.** `src/candidate-runner.ts`, `src/latency-demotion.ts`, `src/quota-demotion.ts`, `src/hard-cap.ts`, `src/server.ts`, `src/backend.ts`, `src/circuit-breaker.ts`

### DR-008 — The MCP lane runner's directory containment is a lexical prefix test that never resolves .. , so the one guard offered can be walked out of

**HIGH** · confidence high · structural_risk

Raised by one perspective; I reproduced it. checkCwd is the only containment on where a delegated lane subprocess is spawned. It takes the caller-supplied cwd verbatim (src/mcp/server.ts:472) and tests containment lexically: normalizePath (src/mcp/lane-runner.ts:490-500) unifies separators, trims trailing slashes in a loop and lowercases on win32. It does not call resolve(), does not collapse `..` and does not resolve symlinks. The test is then `normalized === r || normalized.startsWith(r + '/')` (lines 474-478).

DEMONSTRATED. With an allowed root of C:/Code/llm-relay and a candidate of C:/Code/llm-relay/../../Windows, normalizePath yields c:/code/llm-relay/../../windows, startsWith is satisfied, and the check returns permitted -- while the existsSync and statSync calls on the preceding lines resolve `..` at the OS level and happily validate the real escaped directory. The correct helper for this exact question already exists in the repository: inside() at src/accounting-store-io.ts:288 uses relative() plus isAbsolute() and returns false for the same input. A symlinked child of an allowed root escapes the same way.

TWO THINGS SHARPEN IT. Containment is opt-in and defaults open (`if (!allowedRoots || allowedRoots.length === 0) return { ok: true }`), so allowedRoots is the operator's only means of narrowing lane execution and it is the part that does not hold. And test/mcp-server.test.ts:531-593 shows how close the author got -- it covers a sibling directory rejected as a prefix match, with a comment reasoning explicitly about a bare startsWith, and covers trailing separators -- but has no traversal case and no symlink case, so the suite pins the half that was thought about.

CALIBRATING THE IMPACT HONESTLY, because the perspective did not bound it. This is not remote code execution: the caller is a delegating agent already running locally with the operator's own privileges, and the escape changes only the working directory of a lane subprocess. It is nonetheless a real containment failure rather than a theoretical one, for the reason the module's own header gives -- a caller-supplied filesystem path is a larger version of the hazard dispatch.ts already refuses, and this project's threat model already treats agent input and third-party lane output as untrusted. A guard that is advertised in config, documented as the bound the operator may set, and defeated by three characters is worse than no guard, because it is relied upon.

RECOMMENDATION. resolve() both the candidate and each allowed root, then delegate to the existing inside() helper rather than re-implementing it; optionally realpathSync the candidate to close the symlink case. Add traversal and symlink cases beside the existing sibling test. This is a few lines against a solved problem already in the tree.

**Grounding.** [object Object]

**Files.** `src/mcp/lane-runner.ts`, `src/mcp/server.ts`, `src/accounting-store-io.ts`, `test/mcp-server.test.ts`

### DR-009 — The ledger's writer lease is process-local while its stated threat model is a second process, and the writable store is constructed before the listener binds

**HIGH** · confidence high · structural_risk · systemic

Raised by one perspective; every element verified. The accounting store's durability design is crash-safe and has no cross-process mutual exclusion, and the code shows it knows this and defended only one instance of it.

acquireWriter consults exactly one thing: rootWriterLeases, a module-level Map declared at src/accounting-store-io.ts:234 and read at 476-478. Any second OS process therefore acquires the lease unconditionally, because its own map is empty. There is no lock file, no O_EXCL sentinel and no pid file -- even though the correct pattern exists in this repository: publishCapability in src/control-authorization.ts arbitrates between concurrent local starters with O_CREAT|O_EXCL plus a hard link.

ACQUIRING IS NOT PASSIVE. A writable store performs journal replay and quarantine renames at construction (src/accounting-store.ts:958-959: acquireWriter, then recoverAndLoad on success). The comment fifteen lines above states the hazard in as many words -- replay and quarantine are writes against a directory a live relay may be committing to -- and the mitigation applied was readOnly: true on the single CLI command someone thought of, llm-relay cost. The boundary itself was left unguarded.

THERE IS AN ORDINARY PATH INTO THE BAD STATE, and I confirmed both halves. In runProxy the writable store is created at src/cli.ts:919 (createAccountingStore with retentionDays 30), BEFORE server.listen at line 929; and there is no server.on("error") handler anywhere in src/ -- src/server.ts registers only "listening" (886) and "close" (890). So an operator who is unsure whether the relay is already running and simply starts it again gets: a second writable store constructed against the live daemon's usage/ directory, journal recovery and quarantine renames performed there, and only then an unhandled EADDRINUSE. The side effects happen first and the check that would have prevented them happens last.

RECOMMENDATION, cheapest first. (1) Bind the listener before constructing any writable state, and add a server.on("error") that exits without touching disk -- this alone removes the ordinary path. (2) Replace the in-process lease with a real filesystem lease on the root directory using the O_EXCL pattern already in control-authorization.ts, so a second process is refused rather than admitted. (3) Make a refused lease loud, which DR-006 covers.

**Grounding.** [object Object]

**Files.** `src/accounting-store-io.ts`, `src/accounting-store.ts`, `src/cli.ts`, `src/server.ts`, `src/control-authorization.ts`

### DR-010 — The never-spend-money guard resolves through a regex over a provider-chosen model id, and degrades to exactly that whenever the price cache is cold

**HIGH** · confidence high · core_assumption · systemic

Raised by one perspective and verified in full. assessCost (src/metadata.ts:121-138) is the single definition of free versus paid, and three guarantees are built on it: the freeOnly refusal that enforces the operator's standing instruction that a lane never spends money (src/server.ts:493-527), admission to the dynamically materialized free pools, and the hedge containment that decides which deployments may be DUPLICATED (server.ts:748-763).

THE LADDER, verbatim: a known positive price means paid; both prices exactly 0 means free; then, before any provider-tier reasoning, `if (typeof model === "string" && /(?:^|[/:_-])free(?:$|[/:_-])/i.test(model)) return { costClass: "free", basis: "free-labelled" }`; then providerTierType === "free"; then unknown, which callers treat as paid.

TWO PROPERTIES MAKE THAT THIRD RUNG LOAD-BEARING RATHER THAN DECORATIVE. First, the model id is chosen by the provider -- a third party whose output this codebase otherwise treats as untrusted throughout, with closed-vocabulary handling for refusal prose, headers and rosters precisely because it is not ours. Here a substring of a vendor-chosen name is admitted directly as a cost fact. Second, the rung fires for any provider tier, including mixed, so it is not bounded to rosters that are free by declaration.

WORSE, ITS REACHABILITY IS A FUNCTION OF CACHE WARMTH. The price argument comes from catalog.cachedLimits, which is synchronous and cache-only and returns null when nothing is cached (src/catalog.ts:476-480). After a restart, or whenever models-cache.json lacks an entry, both price rungs are skipped and the decision falls straight to the id regex. The money-safety boundary is therefore strongest when the relay is warm and weakest immediately after it restarts -- which is also when it is most likely to be walking unfamiliar candidates. The guard is asymmetric in the wrong direction for its purpose: freeOnly exists to refuse, and a refusal guard satisfiable by naming is not a guard.

ONE ADDITIONAL SEAM I FOUND WHILE VERIFYING, worth closing in the same change: costClassOf in src/server.ts wraps assessCost in try/catch and returns undefined on throw. undefined is not `unknown` -- it means the caller supplied no class, and CLAUDE.md records that a cost-filtered fact then matches NOTHING. So a throw inside assessCost silently un-demotes every cost-filtered allowance-exhausted fact rather than failing safe. Low likelihood, wrong direction.

RECOMMENDATION: split the classifier by consequence. Keep free-labelled for ordering and display, where a wrong answer costs a position. For the two decisions that spend or duplicate -- the freeOnly refusal and hedge containment -- require positive evidence: a published zero price, or an operator declaration in config. Concretely, have those two paths treat a null cachedLimits result as unknown (hence paid) rather than consulting the id, so a cold cache fails safe instead of falling through to the vendor's naming convention. Note the interaction with DR-003: the same rung decides which accounts get duplicated traffic.

**Grounding.** [object Object]

**Files.** `src/metadata.ts`, `src/server.ts`, `src/catalog.ts`, `src/dynamic-pools.ts`, `src/hedge-trigger.ts`

### DR-011 — Consolidation modules land but adoption is never finished, so the repository accumulates N+1 copies instead of one

**HIGH** · confidence high · structural_risk · systemic

Four perspectives found instances of this; one named the mechanism, and it is the finding that stops the next one rather than fixing the last. The habit is landing the shared module without removing the copies it was created to replace: the shared module then reads as authoritative while the old copies keep running, and the count of implementations goes from N to N+1.

THE INSTANCES, all verified at HEAD.
(a) SSE framing. src/sse-frames.ts was written to be the one boundary rule and field extractor and succeeded for five adopters. Outside it, seven data-line extractors remain: THREE byte-for-byte identical five-line pipelines inside src/backend.ts alone (lines 569-574, 588-593, 1189-1194 -- all `split(/\r?\n/).filter(startsWith data:).map(slice 5, trimStart).join`), plus src/sse.ts:169, src/stream-pipeline.ts:243 and src/tool-use-ids.ts:156, the last in a file that already imports BufferedSseFrames. There are also TWO byte-level framers now -- stream-pipeline.ts:221 exports frameEnd(Buffer) and backend.ts:1174 defines a private frameEnd(Uint8Array) -- and both test only LF-LF and CRLF-CRLF, while the canonical findSseBoundary uses /\r?\n\r?\n/ and matches four forms. CLAUDE.md documents ONE deliberate byte-level exception; there are two, and nothing marks which. This class of bug is proven live here: the 2026-09-01 audit's defect 4 was a fourth private copy getting the multi-line join wrong, so frameOpensToolUse answered null and the tool_use withholding trigger never fired.
(b) JsonStore. src/storage/json-store.ts:98 exports a complete, tested JsonStore<T> with memoised reads, validated loads, atomic writes and a debounced WriteBehindTimer -- and it has ZERO production consumers; every reference outside its declaration is test/storage/json-store.test.ts. Meanwhile nine stores hand-roll it in three incompatible idioms, and because idiom one has no registry, durability depends on two hand-maintained flush lists at src/cli.ts:909-913 and 952-956. That list has already produced a dead export: src/rate-limits.ts:302 declares flushObservedRateLimits under the comment `Called on shutdown, like the other write-behind stores`, and it has no src caller at all.
(c) SHARE_CELL_KEYS. src/dashboard-contract.ts:816 declares the canonical four spend-cell names with a satisfies clause and a comment saying it exists `so a renderer walks these rather than hand-listing them a fifth time`. Five copies exist: the canonical one, SPEND_CELL_KEYS at src/accounting-store-schema.ts:748 (a plain Object.freeze with NO satisfies, so no compiler link to the type it validates), SPEND_CELLS at src/dashboard-snapshot.ts:524, and the four names written out inline at dashboard/src/pages/AnalyticsDashboard.tsx:122 and dashboard/src/components/ProjectionMetadata.tsx:25-30 -- the two sites the comment forbids, in files that already import from dashboard-contract.js. src/cli.ts DID adopt it, so the CLI renderer and the SPA renderer are maintained by different mechanisms over one ledger.
(d) config-types.ts is the same move at the largest scale (DR-001).

THE REMEDY IS ALREADY INVENTED IN-HOUSE, and one perspective established the correlation: the consolidations that held are exactly the ones shipped with a source-grep guard. src/state-paths.ts replaced thirteen resolvers and has fifteen importers, with test/state-paths.test.ts saying in as many words that a source grep is what stops a fourteenth; src/json-shape.ts retired about twenty predicates and has eighteen importers with one straggler at src/mcp/lane-runner.ts:149; src/write-behind.ts holds with no guard because its shape forced adoption. The four that did not hold shipped no guard. test/architecture-map.test.ts does not close the gap -- its whole check is a substring presence test (line 36).

RECOMMENDATION. (1) State the policy: a consolidation is not done until the superseded copies are gone; a change that adds a shared module without deleting them is incomplete, not incremental. (2) Make a grep guard the standing cost of any consolidation, in the shape the repo already uses. (3) Immediately: replace the three backend.ts extractors with sseEventFields (literal duplicates, a pure deletion of ~15 lines), import SHARE_CELL_KEYS in both SPA components and add satisfies to SPEND_CELL_KEYS, and either adopt JsonStore at the five idiom-one call sites behind one flushAll registry or delete it -- the same disposition the 2026-09-01 audit applied to kernel/protocol-ir.ts. Shipping a tested abstraction nobody uses beside nine hand-rolled copies is strictly worse than either end state.

**Grounding.** [object Object]

**Files.** `src/sse-frames.ts`, `src/backend.ts`, `src/sse.ts`, `src/stream-pipeline.ts`, `src/tool-use-ids.ts`, `src/storage/json-store.ts`, `src/rate-limits.ts`, `src/dashboard-contract.ts`, `src/accounting-store-schema.ts`, `dashboard/src/pages/AnalyticsDashboard.tsx`, `test/state-paths.test.ts`

### DR-012 — The decomposition multiplied the public surface roughly twelvefold and produced a namespace, not modules: 87 exports, 37 unconsumed, and the plainest name orders nothing

**HIGH** · confidence high · architecture_pattern · systemic

Two perspectives measured this from different angles and they agree. Before the decomposition the request path was one file: src/server.ts, 5,799 lines, 14 top-level exports. After it the same code is seven files totalling about 5,400 lines with roughly 174 exports -- 6.5 percent less code for about twelve times the public surface. Symbols that were file-private detail are now a bindable API: candidate-runner.ts alone exports Pool429Tracker, CredentialAttemptTrace, RequestAttemptTrace, beginAttemptRun, releaseAttemptRun, retireHedgeLoser, walkExitHeaders, coolingLiftTime and ~80 more, of which 37 have no consumer anywhere else in src/ (observeContextLimit, completeAttemptAbandoned, filterResponseHeaders, midStreamMessage, walkWouldFailOver, refusalBodyCandidates, accountingFailureForAttempt among them). None was narrowed on the way out, and the old import surface was preserved anyway -- src/server.ts:104 re-exports orderByUsability, classifyStatus, buildForwardHeaders and CredentialConfigError purely so existing imports resolve. No consumer got a cleaner boundary.

candidate-runner.ts (1,674 lines) has no cohesion to hold onto: HTTP header filtering, a Pool429Tracker class, hedge racing, sticky-session ordering, walk-exit response construction, four provider-response observers, attempt-lifecycle completion in six variants, and accounting failure classification. `What is candidate-runner for` has no answer shorter than a list.

THE NAMING IS THE SHARPEST SYMPTOM, and it is load-bearing. Four symbols share the orderByUsability stem: orderDeploymentGroupsByUsability (line 443, the live one), orderByUsability (966, no src caller), orderByUsabilityTracked (975, called only by the above, and named for a capability it does not have -- line 1002 returns quotaDemotedFirst and latencyDemotedFirst as literal nulls), and CircuitBreaker.orderByUsability (circuit-breaker.ts:903, which CLAUDE.md records has zero src callers). The function with the plainest name orders nothing in production, and src/circuit-breaker.ts:768 and src/dynamic-pools.ts:106 both cite `orderByUsability` as the authority on ordering policy, pointing future readers at the dead one. A prose warning is what you write when the names cannot be trusted; renaming is what you do so no warning is needed.

THE COUPLING DID NOT MOVE EITHER. Following one POST /v1/messages means holding Handlers (server.ts:336, 24 fields), CandidateRunnerHandlers (candidate-runner.ts:175, 6), MessagesHandlers (routes/messages.ts:83, +9), MessagesContext (95, 18), AnthropicCtx (126, 21) and RepairCtx (151, +4) -- about 80 fields describing one in-flight request across three files, with no statement of which layer owns what. Handlers is the whole application passed by value (validator, logger, catalog, ping loop, breaker, an LRU, three recorders, three dashboard subsystems, the HTTP Server, five injected policy functions), threaded under the identifier `h` and accessed 39 times in server.ts alone. Splitting function-soup into six files reduces scroll distance; if every piece still needs the whole application handed to it, the coupling is unchanged and has only become invisible, because a 24-field parameter reads as one word.

RECOMMENDATION. (1) Give candidate-runner.ts a deliberate interface of roughly a dozen exports and make the rest module-private, routing what the fronts need through the MessagesHandlers / OpenAiFrontHandlers interfaces that exist for exactly that. (2) Delete server.ts's compatibility re-exports and the dead ordering pair (see DR-005), and let the live ordering own the plain name. (3) Split Handlers along the boundary already visible in its field list -- the routing and health policy functions are what the walk needs; the dashboard trio and the HTTP Server are not -- and rename `h` to something decodable in place. (4) Judge any future split by public-surface delta, not line count: line count is what was optimised here and it is the metric that hid the regressions.

**Grounding.** [object Object]

**Files.** `src/candidate-runner.ts`, `src/server.ts`, `src/routes/messages.ts`, `src/routes/openai-front.ts`, `src/stream-pipeline.ts`, `src/accounting-state.ts`, `src/circuit-breaker.ts`

### DR-013 — One unsupervised process fronts every session, with no back-pressure, whole-catalog work on the request path, and no supported supervision story

**HIGH** · confidence medium · structural_risk · systemic

Raised by one perspective; the three concrete elements verified. The relay is a single-threaded Node process that, by its own charter, sits in front of every client session, so its availability is the operator's availability.

NO BACK-PRESSURE. A grep of src/ finds no maxConnections, no requestTimeout, no headersTimeout, no keepAliveTimeout and no concurrency limiter. Per-request memory is large by design: readBody buffers up to DEFAULT_MAX_BODY_BYTES = 36 MiB (src/stream-pipeline.ts:8), which is converted to a string and JSON.parsed, re-serialized in full on a subagent reroute (server.ts:482), mapped into a fresh outbound body per candidate, and -- with hedging on by default -- held against two live upstream responses at once. The client is an agent harness that fires many subagent requests in parallel. There is no arrival rate the process refuses, so the first sign of overload is the event loop stalling or the heap dying.

EXPENSIVE WORK ON THE WRONG PATH. materializeDynamicPools(cfg, h.catalog) is called inside handle, at src/server.ts:480, for every request. It is memoized on a signature including an epoch of Math.floor(now / 30000) (src/dynamic-pools.ts:233), so once every 30 seconds one arbitrary request pays for loadRuntimeTelemetry(), loadProbeCache() -- both synchronous disk reads -- plus discovery of every catalog target and a full re-rank, while every concurrent request waits behind it on the single event loop. The natural owner already exists and already calls it: src/ping/cadence.ts:436 and :459 materialize on the tick.

NO RECOVERY MODEL. process-safety-net deliberately preserves fail-fast outside its transport allow-list, so an unhandled error in a timer, a res close handler, a write-behind flush or a background loop exits the process -- and docs/QUICKSTART.md places autostart scripts, launchd and systemd explicitly outside the standard setup, with the guidance being to run it in a terminal. The end state of one unhandled error is a permanently dead relay, no restart, no notification, and every client failing to connect for reasons that point at the client. This compounds with DR-009, where the missing server error handler turns a duplicate start into disk mutation.

CONFIDENCE NOTE: medium rather than high, because the load profile is one person's laptop and no measurement of concurrent-request overload exists here -- the absence of the knobs is verified, the harm is inferred.

RECOMMENDATION, cheapest first. (1) Set server.requestTimeout, server.headersTimeout and a maxConnections ceiling -- three lines that convert an unbounded overload into bounded, visible refusals. (2) Move materializeDynamicPools off the request path and let handle read the last materialization; the ping tick already does the work. (3) Give the fatal exit a durable trace (a marker file or an exit reason in the log) so a dead relay can be diagnosed after the fact, and document a supervised launch as the supported way to run it rather than as machine-specific extra.

**Grounding.** [object Object]

**Files.** `src/server.ts`, `src/stream-pipeline.ts`, `src/dynamic-pools.ts`, `src/ping/cadence.ts`, `src/process-safety-net.ts`, `docs/QUICKSTART.md`

### DR-014 — The decomposition's seams are declared in prose and enforced nowhere, and the prose has already rotted at the most dangerous module

**MEDIUM** · confidence high · structural_risk · systemic

Raised by one perspective; all three instances verified. This repository treats its comments as operating instructions for the agents that maintain it, and gates that prose only for link validity. Nothing gates its claims.

(1) src/hedge-trigger.ts opens with two load-bearing warnings that are now false. Lines 4-9 state that nothing in src/ calls the module yet and that this is a deliberate intermediate state declared so it is not read later as dead code. Lines 11-12 state that stage 2 is blocked on CredentialWalk and instruct the reader to read this before attempting the wiring. The wiring shipped: server.ts:70 imports hedgeDelayDecision and resolveHedgeSettings, server.ts:757-764 builds the closure, and candidate-runner.ts runs it on both fronts. The next maintainer to open this file is told the feature is unwired and blocked, at the exact module where being wrong about concurrency is most expensive -- and the same header still says to calibrate the constants BEFORE the integration ships (DR-002).

(2) A LIVE BEHAVIOURAL DEFECT, not merely stale prose. src/stream-pipeline.ts:78-81 tags the oversized-body rejection with a declared code specifically so callers stop inferring intent from prose, and asserts in its own comment that the other caller ignores it. The other caller does not ignore it: src/server.ts:427 computes `const status = msg.includes("too large") ? 413 : 400` -- exactly the message regex the code change was made to eliminate. Rewording that message silently downgrades a 413 to a 400 on the data plane.

(3) A LAYERING INVERSION with nothing to notice it. src/stream-pipeline.ts:3 imports BODY_TOO_LARGE_CODE from ./dashboard-routes.js, so the shared request-path I/O primitive used by both fronts depends on the dashboard route module, and the data plane tags its own body-size error with a constant whose value is named for the dashboard.

The structural point is not any one of these: it is that the decomposition split a 5,799-line file into modules whose boundaries exist only as prose, in a project whose maintainers read prose as instruction.

RECOMMENDATION. (1) Fix the two concrete defects now: move BODY_TOO_LARGE_CODE to the module that owns the primitive and have server.ts read the code rather than the message; correct the hedge-trigger header. (2) Convert the two highest-value claims into cheap mechanical gates -- fail when a module whose header declares itself unwired has any src importer, and when an exported symbol a doc block calls shipped has zero src callers. (3) Promote one dependency-direction rule into the gate; dependency-cruiser already runs advisorily, and one layering rule would have caught the inversion at the moment it was written.

**Grounding.** [object Object]

**Files.** `src/hedge-trigger.ts`, `src/stream-pipeline.ts`, `src/server.ts`, `src/dashboard-routes.ts`, `src/candidate-runner.ts`

### DR-015 — The dashboard and its versioned wire contract are a large tier serving one local reader, and its version negotiation only ever rejects legitimate requests

**MEDIUM** · confidence high · design_simplification

Two perspectives argued this at different scales; a third proposed a third road. All three are worth having, because the disagreement is about remedy, not about the measurement.

THE MEASUREMENT. src/dashboard-contract.ts (1,221 lines) defines a vendor media type, four schema identifiers, explicit request and response bounds, a frozen query vocabulary and runtime assertion validators. Behind the SPA sit dashboard-snapshot.ts (1,888), dashboard-routes.ts (816), dashboard-auth.ts (323) and dashboard-static.ts (366) -- 4,614 server lines -- plus React 19, Tailwind, Vite, lucide-react, jsdom, axe-core and the testing-library set; a separate tsconfig and vitest config; two of the five stages of npm run check; and two generated baselines shipped in the npm files list. The SPA itself is 782 lines including tests, and AnalyticsDashboard.tsx is 133 lines rendering four charts and six tables.

THERE IS NO INDEPENDENT CLIENT. One producer and two consumers -- dashboard-routes.ts, dashboard/src/api.ts and src/cli.ts for llm-relay cost -- all ship in the same tarball at the same version, over loopback, replaced atomically on every upgrade. Version skew is not a scenario the deployment model permits. And the negotiation is a liability rather than a safeguard: src/dashboard-routes.ts:651 answers 406 unsupported_version unless exactly one Accept value is present and matches, so a request adding */* -- which any ordinary browser or curl invocation does -- is rejected. The guard cannot catch the failure it was built for and can produce one that would not otherwise exist. docs/project-goals.md rubric item 5 names versioned contract envelopes, explicitly, among the structure-first proposals that are presumptively wrong here. src/dashboard-auth.ts is a second authentication system on a loopback listener that already carries the per-install capability token, and whose bootstrap can only be minted by a caller already holding that token.

ONE HALF DOES NOT ANSWER ITS OWN QUESTION. assessCost classifies free deployments via published price 0 or via free-labelling with no published price, so the traffic this relay exists to carry lands in cells that are either exactly 0 or Unpriced -- and the four-cell provenance matrix, the partiallyPricedRequests lower-bound marker and the abandonedSpend column all render over a figure free traffic structurally cannot populate. The counting half (requests, tokens, latency, per-credential windows) is what answers the founding question for free tiers, and it works.

GRADUATED OPTIONS, smallest first. (A) Keep everything, drop the ceremony: serve application/json and delete the 406 branch (the schema field inside every body is already self-describing), shrink the assertion validators to what llm-relay cost needs against a corrupt local shard, and state plainly that free deployments have no priced spend rather than rendering a provenance matrix over structural zeroes. Removes a rejection path that only fires on legitimate requests and removes no figure. (B) Retire the browser tier: keep dashboard-snapshot.ts as the read model the CLI already uses, drop the SPA, the envelope, the second auth system, the static server, the two gate stages, the two shipped baselines and about fourteen devDependencies; if the chart is wanted, one self-contained HTML file behind the existing control token costs a fraction. (C) Instead of owning the UI, own only the ledger and export it: a grep of src/, docs/ and README.md for opentelemetry, otlp, prometheus and gen_ai returns zero hits, while OpenTelemetry's GenAI semantic conventions now define exactly this domain and every peer emits them. An OTLP/HTTP exporter over the existing accounting events is on the order of a hundred lines and would let Grafana or Langfuse render the data correlated with everything else the operator runs. The provenance discipline is the genuinely novel thing here and is an argument for owning the ledger -- not for owning the transport, the aggregation, the UI and the auth. (C) is additive and does not oblige removing anything, which makes it the safest first move if the browser tier is wanted for its own sake.

**Grounding.** [object Object]

**Files.** `src/dashboard-contract.ts`, `src/dashboard-routes.ts`, `src/dashboard-auth.ts`, `src/dashboard-static.ts`, `src/dashboard-snapshot.ts`, `dashboard/src/api.ts`, `dashboard/src/pages/AnalyticsDashboard.tsx`, `src/metadata.ts`, `docs/project-goals.md`

### DR-016 — typescript is a 23 MB runtime dependency serving 600 lines of a host-side code-review CLI that never proxies anything

**MEDIUM** · confidence high · design_simplification

Two perspectives found this independently and the measurement is unambiguous. package.json lists three runtime dependencies; measured in this checkout, node_modules holds typescript at 23 MB, ajv at 2 MB and llm-bridge at 1 MB. The TypeScript compiler is roughly 88 percent of the installed dependency weight of an LLM proxy, and it is imported by exactly three files -- src/delegate-gate/cast-necessity.ts:1, shared-state.ts:1 and test-assertions.ts:1 -- about 600 lines inside a 1,175-line directory.

WHAT IT SERVES. delegate-gate parses a unified diff, reconstructs each changed file's post-patch image from a repo checkout, and runs four detectors over the added lines: indentation churn, tautological test assertions, unnecessary casts and module-scope mutation. It is a host-side quality gate an operator runs over a diff a delegated agent lane returned. It never participates in serving a request, resolving a target or steering traffic. A stranger who runs npm install -g llm-relay to start a proxy will never invoke it and downloads the compiler anyway.

THE DISPROPORTION IS WHAT MAKES IT DECISIVE. The same project spent a formal owner decision and a permanent second tsc invocation in build:server to strip comments from dist, buying a 251 KB tarball reduction documented at length in docs/package-size-2026-08-30.md with a warning not to simplify it away. The metric optimised was packBytes; the number the user experiences is install size, and 23 MB of compiler arrived for a side feature in the same package. CLAUDE.md names it as the one exception to the two-runtime-dependency rule -- recorded rather than justified.

Three of the four detectors also duplicate rules the project already owns in dev: @typescript-eslint/eslint-plugin and eslint-plugin-sonarjs are both devDependencies, and @typescript-eslint/no-unnecessary-type-assertion is the canonical implementation of the cast check.

THE SEAM IS ALREADY CUT: src/cli.ts:4148 loads delegate-gate through a dynamic await import, so nothing loads TypeScript at proxy startup. Only the manifest entry forces the download.

GRADUATED REMEDIES. (A) Move typescript to optionalDependencies (or peerDependenciesMeta.optional) and have gate.ts degrade the three AST detectors to unavailable-with-a-reason when the import fails, keeping minimality.ts and diff-parser.ts working. (B) Publish delegate-gate as its own package, or move it to scripts/ as a development-only tool invoked through the repo rather than the published bin -- it is a separate tool with a separate audience, and this restores the stated dependency budget outright. Either way, state the install-size figure alongside packBytes in the size doc so the two are not confused again.

**Grounding.** [object Object]

**Files.** `package.json`, `src/delegate-gate/cast-necessity.ts`, `src/delegate-gate/shared-state.ts`, `src/delegate-gate/test-assertions.ts`, `src/delegate-gate/gate.ts`, `src/cli.ts`, `docs/package-size-2026-08-30.md`

### DR-017 — The whole contributor map is one 231 KB file mixing three lifetimes, guarded only for presence, beside 58 unindexed documents

**MEDIUM** · confidence high · structural_risk · systemic

Three perspectives approached this from different directions; merged, the measurements are consistent. README.md sends every contributor to one destination and there is no CONTRIBUTING file, no architecture document and no onboarding doc; docs/reference.md is user-facing config and CLI reference. So the entire entry point for a new maintainer is CLAUDE.md: 1,304 lines, 231,641 bytes, about 32,000 words, with 256 warning markers. The file-to-responsibility table is 109 rows and roughly 55 percent of the document, averaging about 1,160 characters per row; the largest cells (latency-demotion.ts, circuit-breaker.ts) are single unwrapped markdown lines of roughly a thousand words each -- unscannable, undiffable in review, and unrenderable.

THREE KINDS OF KNOWLEDGE WITH THREE LIFETIMES SHARE THOSE CELLS: timeless invariants (logs are metadata only; health demotes, never drops), a map that must track the code, and dated incident narrative -- with explicit RETRACTED, SUPERSEDED, AMENDED and REVERSED passages. A reader cannot tell from the form of a sentence whether it is a rule to obey, a description to verify, or an account of something that stopped being true. When a warning marker appears roughly every five lines, the marker no longer carries priority.

THE GUARD IS WEAKER THAN IT LOOKS. test/architecture-map.test.ts is 49 lines and its whole check (line 36) is that CLAUDE.md contains the backticked filename or its containing directory. It proves a filename appears somewhere in a 231 KB string -- not that a row exists, not that it is in the table, not that it is true. That gap has already produced a documented failure (kernel/protocol-ir.ts satisfied it while contradicting the sentence the guard pointed at) and is live now: CLAUDE.md:139 describes config-types.ts as configuration types decoupled from runtime loaders, which is materially false (DR-001) and perfectly satisfies the guard.

TWO NEIGHBOURING SYMPTOMS. docs/ holds 58 markdown files, 43 date-stamped, with no index, README or contents file -- verified -- and CLAUDE.md links only about half, so the rest are reachable only by listing the directory and guessing. Date-stamping does not separate live from dead: docs/hedged-attempts-design-2026-08-30.md still binds the code while docs/audit-2026-08-09.md is explicitly described as advisory output not to be acted on, and from the filenames they are the same kind of object. Separately, twenty src files reason in comments about codes with no local definition (G2 19 times, C1 14, plus D1/D3/D4/M2/M4 and Gap N), and C1 carries two unrelated meanings: a spec item at src/cli.ts:1772 (the only site naming its document), src/accounting.ts:875 and src/accounting-store.ts:1448, and the Unicode control-character block at src/accounting-store-schema.ts:510.

ONE PERSPECTIVE'S REMEDY, CORRECTED. It measured that request-path comment density fell to 3.9 percent (openai-front 1.0, messages 1.3, server 2.7, candidate-runner 3.9) against 20-62 percent in peripheral modules and a pre-decomposition ~23 percent, and proposed gating comment density. The measurement is right and worth acting on; the gate is not -- a density floor invites padding and measures the wrong thing. The actionable core is that the invariants did not disappear, they RELOCATED, so the distance between a rule and the code it governs went from the line above to somewhere in 32,000 words. Fix that by moving specific invariants back beside their code, not by counting lines.

RECOMMENDATION. Split by lifetime rather than shorten: invariants that must never drift belong next to the code or in tests that fail (src/kernel/contracts.ts and test/kernel-architecture.test.ts already do this well); incident narrative belongs in the dated docs, where the project already puts it; what remains in CLAUDE.md is a short scannable map plus a pointer per subsystem. Tighten the guard to require a row inside the table. Add docs/README.md with two lists -- live reference versus history -- or better, move history into docs/history/ so the distinction is a directory rather than a convention. And expand each spec code to its meaning and its document on first use in a file.

**Grounding.** [object Object]

**Files.** `CLAUDE.md`, `test/architecture-map.test.ts`, `README.md`, `docs/reference.md`, `src/routes/openai-front.ts`, `src/routes/messages.ts`, `src/hard-cap.ts`, `src/accounting-store-schema.ts`, `docs/audit-2026-08-09.md`

### DR-018 — The analysis channel that already detected the headline defect grades tool exit codes as findings, reports a clean run, and is gitignored

**MEDIUM** · confidence high · tool_opportunity · systemic

Raised by one perspective and independently confirmed by the orchestrator. The duplication in DR-001 was mechanically detected on the day it was introduced, by tooling this repository already owns, and the detection went nowhere.

analysis-reports/jscpd.txt contains five clone blocks pairing config-types.ts against config.ts and covering config-types.ts lines 1-375 of its 385 -- effectively the whole module reported as a clone -- inside a run reporting 572 clone blocks and 5,405 duplicated lines (4.64 percent). analysis-reports/ts-prune.txt independently lists 24 entries for config-types.ts, 22 marked used-in-module. analysis-reports/run-summary.txt, the one file a maintainer would actually read, says `jscpd: 0` and `Failures: none`. The cause is scripts/analysis-run.mjs lines 130-137: a step counts as a failure only when the spawned process exit status is non-zero, and the summary line renders that verdict under each tool's name. jscpd exits 0 when it finds clones because no failure threshold is configured, so a wholly duplicated module renders as a clean run. The summary reports whether the tools RAN, not what they FOUND, and its wording asserts the stronger claim. A file named jscpd.json in the same directory contains ANSI console text, not JSON.

STATED FAIRLY: CLAUDE.md declares static analysis deliberately advisory and outside the gate, and gives reasons (several default rules contradict documented invariants here). Not failing CI is therefore by design and is not the defect. The defect is that the summary misreports a finding count as an exit code, and that analysis-reports/ is gitignored, so no finding ever reaches review or history -- only the local operator sees it, and only by opening the raw report rather than the summary that says everything is fine.

JUDGE NOTE ON SEQUENCING, because it changes the order of this whole review. Across seven submissions the reviewers proposed roughly a dozen new mechanical gates, each sound in isolation. Meanwhile the detector that already found the largest finding in the set produced its evidence, on time, into a directory nobody reads. Adding a twelfth guard beside eleven unread reports is not obviously the cheapest next move. Sequence it: make the existing channel legible first (report finding COUNTS beside exit codes -- clone blocks, unused exports, cycles -- and give jscpd a threshold so a genuinely new clone is distinguishable from the inherited 572), then add the DR-004 duplicate-export check, which is the one general rule that would have caught the defect the other guards were written after. As it stands the project pays the full cost of running six analyzers and discards the result through a summary that actively misinforms.

**Grounding.** [object Object]

**Files.** `scripts/analysis-run.mjs`, `analysis-reports/run-summary.txt`, `analysis-reports/jscpd.txt`, `.gitignore`, `src/config-types.ts`, `package.json`

### DR-019 — Two persisted per-deployment performance stores yield two 0-100 scores that are then averaged into one term

**MEDIUM** · confidence high · design_simplification

Raised by one perspective and verified end to end. Every served request is measured twice, into two independent on-disk stores, and the two resulting quality scores are averaged.

Path one: src/server.ts:460 hands the completed attempt to PingLoop.recordRequestLatency, which persists a {ms, tokens} sample through recordRequestSample (src/ping/probe-cache.ts:185) into probe-cache.json. Path two: the same attempt reaches recordCall in src/candidate-runner.ts, which calls recordModelCall and appends an {ok, latencyMs, completionTokens} sample into runtime-telemetry.json. Each store grows its own composite -- getStabilityScore (src/ping/metrics.ts:211) over probe samples, getRealWorldScore (src/ping/runtime-telemetry.ts:209) over telemetry samples. deploymentRankingSignals (src/dynamic-pools.ts:50) reads both (stabilityScore line 70, runtimeScore line 72) and deploymentFitness (src/benchmarks.ts:196-208) averages them into a single `operational` term, weighted 0.2 of the final score at line 221.

So the project maintains a second file format, a second normalizer with its own migration, a second write-behind timer, a second vitest temp-path guard, a second XDG cache path and a second scoring formula, in order to average the result with the first. The two measure the same events from the same request path; neither can know something the other cannot. The marginal effect is smaller still than 0.2 suggests, because interleaveByProvider (src/dynamic-pools.ts:112) then round-robins the ranked order across providers, so a second opinion on operational health can move a candidate only within its own provider's queue or flip which provider leads.

RECOMMENDATION: retire runtime-telemetry.ts. probe-cache.json already carries request latency and output-token counts, is the dataset llm-relay candidates renders, and is the dataset both latency-demotion.ts and hedge-trigger.ts were deliberately pointed at after the v0.65.1 incident in which two latency opinions on two datasets disagreed -- an incident this repository has already paid for once. Its one genuinely non-duplicated consumer, getLastSuccessfulCallAt used by ping/cadence.ts to avoid probing what traffic just proved, can read the same probe-cache window. Deleting it removes a module, a state artifact, a scoring formula and -- more valuable than any of those -- one of two possible answers to how healthy a deployment is.

**Grounding.** [object Object]

**Files.** `src/ping/runtime-telemetry.ts`, `src/ping/probe-cache.ts`, `src/ping/metrics.ts`, `src/dynamic-pools.ts`, `src/benchmarks.ts`, `src/candidate-runner.ts`, `src/ping/cadence.ts`

### DR-020 — A hand-built write-ahead log and crash-recovery engine guards a personal token counter, and the decision that chose it was taken against an option that no longer applies

**MEDIUM** · confidence medium · tool_opportunity

Two perspectives reached opposite conclusions from the same measurement, and both remedies are worth putting to the owner because the disagreement is genuine.

THE MEASUREMENT. src/accounting-store-io.ts is 1,247 lines implementing write-ahead journaling, adjacent nonced temp writes, file and directory fsync, atomic rename, crash replay via recoverPendingJournal, quarantine of corrupt files, three hard byte ceilings, a path-containment check, an in-process single-writer mutex and nine injectable crash-injection step hooks. accounting-store.ts (2,070) adds day sharding, minute cells, dedup, retention, rollups and a read-only mode; accounting-store-schema.ts (1,475) hand-writes the persisted schemas. Roughly 4,800 lines re-implementing WAL, ACID and crash recovery. What that durability budget protects is agreement between usage/YYYY-MM-DD.json and usage/lifetime.json -- a count of tokens the operator spent on their own free-tier keys, on their own laptop, in the last few minutes, which the goals document classifies as accounting rather than custody and on which acting is optional and may only reorder.

OPTION A -- SHRINK IT. The project already owns the smaller answer: atomicWriteJsonSync in src/storage/json-store.ts is about 25 lines, and breaker-persistence.ts, dispatch-exhaustion-persistence.ts, ping/probe-cache.ts, ping/runtime-telemetry.ts and target-facts.ts all share it for state that matters at least as much -- live cooldowns that decide routing, learned facts that demote candidates. accounting-store-io.ts imports none of it. Replacing the journal with the shared writer, accepting that a hard crash may cost the newest minute cell (which the store's own coverage and loss markers already have vocabulary to report), would delete over a thousand lines, one state artifact and an entire class of recovery-path test surface.

OPTION B -- REPLACE IT. docs/accounting-persistence-evaluation.md section 4.1 rejects an embedded database in one sentence: a native SQLite dependency would violate the minimal-runtime-dependency constraint and degrade cross-platform installation. That reasoning was correct when written and its only stated objection has expired -- Node 22.5 ships node:sqlite inside the binary (no npm dependency, no node-gyp, no prebuild), and package.json already declares engines.node >=22. A grep of src/, docs/ and README.md for node:sqlite and DatabaseSync returns zero hits, so the decision was never re-taken against the option that removes its objection. Three live costs would go with it: the cross-process writer problem (DR-009) becomes WAL-mode readers against one writer; the dashboard projection's row caps and partial-coverage promotion, which exist because aggregation means walking JSON shards in memory, become an indexed GROUP BY; and retention becomes DELETE.

JUDGE VIEW. Option A is smaller, needs no new mechanism, is reversible, and matches the project's stated lightweight criterion; Option B is more capable and reopens a decision on its merits but is a migration with a new failure surface, and node:sqlite is still marked experimental in some Node lines -- which is why confidence here is medium. Either is defensible; what is not defensible is carrying a hand-built journal engine forward on a rationale that names a dependency nobody would choose today. Whichever is taken, keep the JSON shards as an export format if human inspectability is the real requirement -- that is a one-command dump, not an argument for owning a journal.

**Grounding.** [object Object]

**Files.** `src/accounting-store-io.ts`, `src/accounting-store.ts`, `src/accounting-store-schema.ts`, `src/storage/json-store.ts`, `src/dashboard-snapshot.ts`, `docs/accounting-persistence-evaluation.md`, `package.json`

### DR-021 — cli.ts is the second entry point, left un-decomposed at 4,312 lines, with a hand-rolled argv parser whose one failure mode has bitten twice

**MEDIUM** · confidence high · design_simplification

Two perspectives found the two halves of the same module. The repository has two externally reachable entry points a maintainer will actually touch; the decomposition addressed one. src/cli.ts is now the largest file in the repository at 4,312 lines -- 1.7 times config.ts and nearly five times the post-decomposition server.ts -- holding about 108 top-level functions and a command switch dispatching roughly thirty commands. Three responsibilities with no reason to share a module live inside it: argument parsing and arity validation, command policy (what keys rotate may do, when cost reads a store read-only, when cooldowns clear must reach a live relay), and terminal rendering. src/keys-cli.ts (878 lines) already demonstrates the alternative for one command family, so the pattern is established and simply was not extended.

THE PARSER HALF IS THE SHARPER ONE. parseCliArgs walks process.argv and decides whether a flag consumes the next token by consulting VALUE_FLAGS, a hand-maintained Set of 33 spellings declared at src/cli.ts:95. There is no parseArgs or node:util import anywhere in src/. The structural failure mode is that a value-taking flag omitted from VALUE_FLAGS does not error -- its value silently becomes a positional. The constant's own comment records the real case (--host routed parsed as the positional lane id routed); CLAUDE.md records a second, the argValue() confusion fixed in 961a750. The response was compensating guards -- CLI_COMMAND_NAMES to refuse an unknown command instead of starting the proxy, and a COMMAND_ARITY table plus commandArityError to refuse extra positionals, which CLAUDE.md explicitly frames as what makes the VALUE_FLAGS hazard fail loudly. That is three hand-maintained tables and a guard layer built to contain one parser's design.

util.parseArgs has been stable since Node 20 and this package requires >=22. Its options table declares type: "string" for value-taking flags, so the value-flag list is not a separate artifact that can fall out of sync -- it is the same declaration that names the flag. With strict: true an undeclared option errors rather than being silently reinterpreted, allowPositionals bounds positionals, short handles aliases, both = and space forms are handled, and tokens covers anything bespoke. The class of bug cannot occur. A smaller related issue: parseCliArgs memoises into module-level cachedArgv/cachedParsedArgs and argValue()/hasFlag() read process.argv directly, so in a codebase that injects every other environment dependency the CLI's own input is a global with a cross-invocation cache.

RECOMMENDATION. Convert command dispatch to parseArgs with a per-command options table, keep CLI_COMMAND_NAMES as the command vocabulary, delete VALUE_FLAGS, and thread argv as a parameter. Then extract per-command-family modules (cost, pools/routing, eligibility, dispatch, offload, config) behind the existing dispatcher, leaving cli.ts as parser plus command table. This is lower risk than the server decomposition was, because the command boundary is already explicit in CLI_COMMAND_NAMES and COMMAND_ARITY rather than having to be discovered -- and it creates the seam that would let command policy be tested without spawning a process.

**Grounding.** [object Object]

**Files.** `src/cli.ts`, `src/keys-cli.ts`

### DR-022 — The dispatch and lane subsystem is a second product inside the proxy, exposed through four front doors, and its MCP door holds a cold copy of live state

**MEDIUM** · confidence high · architecture_pattern

Two perspectives approached the same subsystem from different ends. dispatch.ts (924 lines), lane-manifest.ts, lane-probe.ts, lane-quota-probe.ts, lane-cadence.ts, dispatch-exhaustion-persistence.ts, installed-hosts.ts, executable-lookup.ts, host-routing.ts, claude-hook.ts, setup-claude.ts and mcp/ total about 3,900 source lines with a further ~3,100 lines of tests -- roughly seven thousand lines, comparable to the entire accounting subsystem.

None of it participates in serving an HTTP request, and that is an explicit invariant rather than an omission: the request path never spawns a lane, because a lane's quota is client-bound, it runs its own tool loop, and it can only return final text. The subsystem answers a categorically different question -- which peer agent CLI should a host hand a whole task to -- and owns three of the on-disk state artifacts.

IT IS EXPOSED FOUR TIMES. llm-relay dispatch on the CLI, GET/POST /dispatch on the proxy (src/routes/admin.ts), a dispatch tool in a stdio MCP server (src/mcp/server.ts), and a PreToolUse hook in claude-hook.ts that denies an Agent call to hand back a transposed command. All resolve through the same buildDispatch. Four ways to reach one decision function is the surface cost of not choosing.

AND THE MCP DOOR HOLDS COLD STATE. src/cli.ts:2367 wires the MCP server's buildView to resolveDispatchView, which at src/cli.ts:2314 resolves entirely locally -- loadOrExit(), a fresh ModelCatalog, pools materialised from disk, and host hardcoded to bypassed at line 2327. It never contacts the running relay, so every MCP host gets a cold second copy of dispatch state while the daemon holds the live breaker cooldowns, the live exhaustion map and the warm health data; CLAUDE.md already records that the CLI's cold fallback narrows rather than closes that gap. LaneJobStore is deliberately in memory because a stdio child dies with its host, so a lane outliving waitMs cannot be recovered from another host or after a restart.

GRADUATED OPTIONS. (A) Cheapest: keep the stdio server and add MCP's standardised Streamable HTTP binding on the listener the relay already runs, behind the existing control token and the existing Host/Origin admission -- the tool surface, LaneJobStore and lane-runner.ts are transport-agnostic already, so this is a second binding of the same handlers, not a rewrite. It gives one long-lived process holding live state, jobs that survive the calling host, no per-host subprocess, and the recursion bound enforced against server state rather than an inherited environment variable. (Do not undo the hand-rolled JSON-RPC itself; for four methods it is small, documented and honest about its cost.) (B) Collapse three front doors to one; the HTTP route earns the least of the three. (C) Extract the subsystem as a standalone tool -- it would be coherent alone, and removing it would take agent-CLI detection, PATH probing and subprocess spawning out of a package whose other job is holding provider credentials, dissolving the exceptions its presence forces elsewhere (the lane cadence riding PingLoop.tickOnce with an in-flight latch, the vitest spawn guards, the depth cap).

**Grounding.** [object Object]

**Files.** `src/dispatch.ts`, `src/mcp/server.ts`, `src/mcp/protocol.ts`, `src/mcp/lane-runner.ts`, `src/lane-cadence.ts`, `src/claude-hook.ts`, `src/routes/admin.ts`, `src/cli.ts`

### DR-023 — Three credential sources, with the 4,400-line encrypted one ranked last and inert on the supported install path

**MEDIUM** · confidence medium · core_assumption

Raised by one perspective, and it is the clearest example in the repository of a large subsystem whose cost is paid on a path its benefit never reaches. resolveCredential (src/authEnv.ts:185) resolves a provider key in a fixed order: the process environment first, then -- because dotenv.ts loads ~/.llm-relay/.env into process.env at startup -- the plaintext env file, and only if both miss, the encrypted keystore.

Behind that last rung sit keystore.ts (1,431 lines), os-keyring.ts (572), keys-cli.ts (878), key-import.ts (255), secret-file-acl.ts (254) and the credential-identity modules -- roughly 4,400 lines implementing AES-256-GCM rows bound to version, provider, id and env name; KEK custody through DPAPI, Keychain, libsecret or a scrypt passphrase; salted keyed fingerprints; unlock cooldown epochs keyed by store path and KEK descriptor; encrypted export, decrypt and restore; and a revoke/remove/disable/enable lifecycle that stays byte-preserving while locked.

But src/onboarding.ts writes keys to the plaintext .env -- and docs/project-goals.md names README plus llm-relay onboard as the supported install path for a stranger. On that exact path the .env shadows the keystore entirely, so the custody program is inert and the real protection for the file that does get written is the best-effort ACL hardener. keys rotate even refuses byte-preservingly when it detects the shadow, because changing unused ciphertext would change nothing on the wire -- the code knows.

THE ASSUMPTION WORTH SURFACING is that a personal loopback relay needs three credential sources at all. One would do, and the choice is between two coherent designs: either onboarding writes to the keystore and .env support is dropped, in which case the custody code is on the default path and earns its size; or the keystore is dropped and env plus .env plus ACL hardening is the whole answer, deleting several thousand lines and one state artifact. Keeping three with the strongest ranked last pays the full cost of custody while the default install receives none of its benefit -- and it means a reader of llm-relay keys sees a store the running relay may never consult. Confidence is medium because the precedence order is deliberate and defensible on its own terms (the more explicit signal wins); what is not established anywhere is why the supported wizard writes to the weakest rung.

**Grounding.** [object Object]

**Files.** `src/authEnv.ts`, `src/onboarding.ts`, `src/keystore.ts`, `src/os-keyring.ts`, `src/keys-cli.ts`, `src/dotenv.ts`, `src/secret-file-acl.ts`, `docs/project-goals.md`

### DR-024 — routing carries sixteen keys with inconsistent defaults, three of which spend or duplicate on a fresh install, behind a parser too complex to extend

**MEDIUM** · confidence high · structural_risk · systemic

One perspective measured the parser; I extended it to the defaults, which is where the operator consequence is.

THE PARSER. src/config.ts:1782 declares parseRouting and the next top-level function begins at line 2025, so it is roughly 243 lines. Its complexity is measured, recorded and accepted -- src/config.ts:520-521 states in a code comment that it is at cognitive complexity 124 against a limit of 15 and that CLAUDE.md records the decision not to restructure it. Declining a refactor is a legitimate call. What is not visible from that decision is that the complexity has become a DESIGN CONSTRAINT ON NEW WORK: parseLatencyDemotion returns {} rather than undefined so `the caller [can] assign unconditionally ... which keeps parseRouting free of another branch`, and parseHedge at lines 598-600 cites parseLatencyDemotion as precedent for the same reason. The convention itself is good and worth keeping -- but it should be adopted because it is right, not because a function is too expensive to add a line to, and by the third feature the reason will read as a design principle rather than as debt avoidance.

THE DEFAULTS. routing now carries sixteen top-level keys (default, tiers, pools, poolPolicies, poolDegraded, subagents, offload, benchmarkSort, sticky, quota, latency, hedge, laneProbe, mcp, ladder/ladders, cliLane), several nested, with defaults that split with no stated rule: latency, hedge, laneProbe and quota.hardCaps default ON while sticky and offload default OFF. Three of the ON set change behaviour a stranger would not predict from the install instructions -- hedge duplicates requests against free tiers (DR-002, DR-003), latency silently demotes on measured p95, and laneProbe spawns lane subprocesses on a background cadence. I checked the two documents docs/project-goals.md names as the supported install path: README.md and docs/QUICKSTART.md mention none of hedge, duplication, latency demotion or lane probing. docs/reference.md:741 documents routing.hedge well, including On by default and the duplication warning -- so the disclosure exists, on the surface a stranger reaches last.

RECOMMENDATION. (1) Publish one table of every routing key with its default and a one-line consequence, in README or QUICKSTART rather than only in reference.md, and lead with the three that spend or spawn. (2) State the rule for which way a new key defaults -- the defensible one is that anything which spends, duplicates or spawns defaults OFF until calibrated. (3) Rather than restructuring parseRouting wholesale, extract the per-key parsers into a table keyed by config key (most already exist as standalone functions) so parseRouting becomes a loop over it: mechanical, preserves every error message, and turns the next feature from adding a branch into adding a row.

**Grounding.** [object Object]

**Files.** `src/config.ts`, `src/hedge-trigger.ts`, `src/latency-demotion.ts`, `README.md`, `docs/QUICKSTART.md`, `docs/reference.md`

### DR-025 — Five of eleven learned fact kinds are parsed, scoped, expired and migrated but change no decision

**LOW** · confidence high · design_simplification

Raised by one perspective. FactKind in src/target-facts.ts has eleven members. Five -- max-output, rate-limit-rpm, rate-limit-rpd, rate-limit-tpm, rate-limit-tpd -- are recorded, scope-resolved, TTL-ed, key-migrated and rendered, and route nothing. src/cli.ts labels each in as many words: a ceiling this deployment stated about itself, a measurement, never a demotion.

src/rate-limits.ts is 309 lines of vendor-prose parsing -- axis and period vocabularies, confidence gates, scope-from-evidence rules, a body that may state several ceilings at once -- whose entire product is four numbers in a CLI table. src/context-limits.ts records max-output facts that nothing clamps, refuses or routes on, by explicit owner decision. src/network-block.ts is a 92-line module whose output is one advisory line, pinned by a test asserting it imports nothing so it can never grow into a recorder.

Each costs its share of the fact store's scope-precedence resolution, expiry, cost-class filtering, kind-plus-scope keying and load-time migration -- and each widens a union the codebase must keep exhaustively handled everywhere, which is the union whose incomplete handling CLAUDE.md documents as its most repeated defect (DR-004). That is an ongoing tax on every future change to the fact vocabulary.

STATED FAIRLY, and this is where I would not go as far as the perspective did: the display-only status of max-output and network-block is an explicit owner decision with a recorded rationale, and network-block in particular is deliberately tiny and structurally prevented from growing. The clean candidate is the four rate-limit-* kinds and rate-limits.ts, built to feed an opt-in enforcement (spec decision M2) that was never wanted. Reintroducing a parser is cheap; a parser with no consumer is what is expensive. Keep max-output and network-block on evidence that the operator consults them, and revisit if the fact vocabulary is ever the site of another exhaustiveness defect.

**Grounding.** [object Object]

**Files.** `src/rate-limits.ts`, `src/network-block.ts`, `src/context-limits.ts`, `src/target-facts.ts`, `src/cli.ts`

### DR-026 — llm-bridge is trusted for half its job and silently overridden for the other half, with no stated boundary

**LOW** · confidence medium · fundamental_approach

Raised by one perspective. llm-bridge is one of three runtime dependencies and is imported in exactly one file -- src/backend.ts:11 -- for two functions used at four call sites. Everywhere else the name appears in src/ it is commentary about what it got wrong.

Both REQUEST directions have been taken back in-house after data-corruption incidents. src/openai-request.ts exists because universalToOpenAI has no case for a tool_call or tool_result block and stringified its own IR envelope into the outbound prompt -- models read the notation and echoed it back as their answer, prompts inflated roughly 3.1x, tool results triplicated, and no role:"tool" message was produced. src/responses-request.ts exists because openaiResponsesToUniversal dropped the assistant function_call entirely, stringified output_text, turned a reasoning item into a bogus user turn and invented a thinking budget figure -- breaking every Responses tool conversation past the first call on both backend kinds.

So the position today is a dependency reduced to two functions, retained for the response and stream directions, by a project that has documented three separate data-corruption defects in its request directions and re-implemented both. The response direction is not obviously safer than the request direction was; it simply has not been audited as hard, and the same class of silent loss is what docs/tool-call-dialect-leak.md describes.

I am not recommending absorption: docs/project-goals.md:67 rejects completing the canonical-IR migration on the grounds that it means absorbing a translation layer the project deliberately outsources, and that entry still binds. The recommendation is to finish the DECISION rather than the migration -- write down the current trust boundary explicitly (which directions are llm-bridge's, what evidence backs them, and what would trigger absorbing them), and add cross-front convergence tests for the response and stream directions equivalent to what the request mappers now have. A dependency trusted for half its job and silently overridden for the other half is a position nobody has taken, and it will be re-litigated by whoever hits the next defect.

**Grounding.** [object Object]

**Files.** `src/backend.ts`, `src/openai-request.ts`, `src/responses-request.ts`, `package.json`, `docs/project-goals.md`

### DR-027 — What is genuinely sound here, and why the fundamental approach should not be redesigned

**INFO** · confidence high · fundamental_approach · systemic

Four perspectives wrote a positive finding independently, and merged they calibrate everything above. The fundamental approach is right and a clean-sheet redesign would arrive at the same shape: a single loopback process that resolves a requested model name to a ranked candidate list, walks it on failure, and speaks both wire dialects in both directions is the smallest arrangement that keeps an agent harness running on a dozen unrelated free tiers. Every finding above is about implementation, surface or enforcement -- none argues the shape is wrong.

SPECIFIC THINGS THAT SHOULD NOT BE REBUILT. (1) The repair boundary -- the relay fixes protocol form, never judgment, and no LLM opinion enters the request path -- is load-bearing and drawn consistently everywhere I followed it. (2) The provenance discipline is real and pervasive rather than aspirational: unknown stays null, a total mixing bases reports its split, metadata.ts resolves per field with a provider or reference label and no invented rung. It is the property that makes the metering usable for a decision rather than merely readable, and DR-006 asks for a consequence to be surfaced, never for the rule to relax. (3) The nineteen x-llm-relay-* headers are the right answer to the hardest problem here: a substitution you cannot see is indistinguishable from getting what you asked for, and encoding it in response headers means the explanation arrives with the thing it explains -- the one property 32,000 words of CLAUDE.md do not have. (4) The changes that stuck are the ones derived from a measured failure: the tool-call id mint, the mistral 9-character rewrite, the gemini thought-signature sentinel, the dialect rescue with its destructive refusal, the elapsed-time cooldown floor. Each closed an observed failure, each is bounded, each is announced. (5) src/hedge-race.ts is a model of isolating risky concurrency -- timers injected, semantics proven in unit tests, mutation-checked, ignorant of HTTP -- and small pure modules like tool-use-ids.ts, think-tags.ts and executable-lookup.ts show the project already knows how to draw a good boundary. (6) The dependency graph is structurally healthy: madge --circular over src test scripts returns [] and dependency-cruiser reports no violations across 293 modules. (7) The kernel is deliberately small and its smallness is enforced by test/kernel-architecture.test.ts, and a larger aspirational surface was deleted rather than accumulated. (8) README.md is 74 lines and communicates what the project is inside a minute -- the project can write for a reader with no context; it does it for users and not yet for maintainers. (9) The first-run default is correct: DEFAULT_CONFIG_TEMPLATE points routing.default and all four tiers at the real Anthropic passthrough and leaves every offload rule disabled, so a fresh install changes nothing about existing traffic until asked -- which is what makes the README-plus-onboard install standard achievable (DR-024 is about three later keys that broke that pattern, not about the template).

THE PATTERN THE FINDINGS SHARE, and the one durable rule worth taking from them: the consolidations that HELD are exactly the ones shipped with a source-grep guard (state-paths.ts with fifteen importers, json-shape.ts with eighteen), and the ones that did not hold shipped none. Meanwhile the work that produced the largest findings here -- the decomposition, the duplicated type surface, the unreachable hedge ladder, the versioned local wire contract -- shares one signature: it was justified by tidiness, symmetry, completeness or future-proofing rather than an observed failure, and measured by nothing a user could see. The single highest-leverage change this project could make is to require, before any non-behavioural change to src/, a named observed failure it closes -- and to make a grep guard the standing cost of any new consolidation module.

**Grounding.** [object Object]

**Files.** `src/state-paths.ts`, `test/state-paths.test.ts`, `src/json-shape.ts`, `src/hedge-race.ts`, `src/metadata.ts`, `src/tool-use-ids.ts`, `test/kernel-architecture.test.ts`, `README.md`, `docs/project-goals.md`

---

## Contract review findings (8)

### DR-001 — The config vocabulary now has two live definitions: config-types.ts duplicates config.ts and EFFORT_LEVELS exists twice at runtime, with each consumer bound to a different copy

**HIGH** · confidence high · critical_invariant_coverage_gap · systemic

src/config-types.ts (385 lines) declares 31 names that src/config.ts also declares, and src/config.ts never imports it (verified: zero occurrences of config-types in src/config.ts). Every one of the 31 shared declarations is byte-identical today after comment stripping, so nothing fails to compile and nothing fails at runtime -- which is precisely the silent-drift shape this repository documents as its most repeated defect class. The sharp counterexample is EFFORT_LEVELS, a runtime array, not merely a type. It is declared twice as an independent `as const` tuple: src/config-types.ts:15 and src/config.ts:46. Three consumers are now split across the two copies. src/config.ts:54 builds EFFORT_LEVEL_SET from its own copy and validates a pool policy against it at src/config.ts:1863; src/cli.ts imports EFFORT_LEVELS from ./config.js (src/cli.ts:16) and validates the --effort flag against it at src/cli.ts:3607; src/dynamic-pools.ts:23 imports it from ./config-types.js and at src/dynamic-pools.ts:87 assigns it to EFFORT_ORDER, which is the index basis for the banded degrade tail (lowerBands). Concrete counterexample: add a fifth band to src/config.ts only. Config load and the CLI accept it; dynamic-pools never bands it, so an exhausted pool of that band silently gets an empty degrade tail. Add it to src/config-types.ts only and the mirror happens: dynamic-pools bands it while config load and the CLI reject it as unknown. Neither direction produces a compile error, because the two arrays are structurally identical tuples with no cross-reference, no `satisfies`, and no test asserting identity (grep of test/ finds zero references to EFFORT_LEVELS, and only two test files touch config-types at all). This directly defeats a remedy the code itself narrates: the doc comment at src/config.ts:30-44 states `one declaration`, warns that `Order is load-bearing: dynamic-pools.ts derives the degrade tail from this array index`, and explains that the member list previously `stood restated in four places across three modules` and was consolidated for exactly this reason. src/dynamic-pools.ts:86 then asserts `the ONE ordering, imported so a new band cannot miss the degrade tail` -- while importing the second copy. Recommended change: make src/config.ts import every shared declaration from src/config-types.ts and re-export for compatibility, deleting its private copies, so there is one runtime array and one type; or, if the split must remain for module-cycle reasons, add a source-level guard test in the style of test/closed-vocabulary-coverage.ts that fails when the two files declare the same exported name.

**Grounding.** [object Object]

**Files.** `src/config-types.ts`, `src/config.ts`, `src/dynamic-pools.ts`, `src/cli.ts`, `src/benchmarks.ts`, `src/candidates.ts`, `src/dispatch.ts`, `src/configured-limits.ts`

### DR-002 — routing.mcp.allowedRoots containment is bypassed by a parent-directory segment: checkCwd normalizes separators but never resolves the path

**HIGH** · confidence high · trust_boundary_gap

src/mcp/server.ts:472 reads the working directory straight out of the MCP tool-call arguments (`readString(args, 'cwd')`), passes it to checkCwd at src/mcp/server.ts:473, and on success hands it to the lane subprocess at src/mcp/server.ts:504. checkCwd (src/mcp/lane-runner.ts:464-484) is therefore the only containment between a caller-supplied string and a spawned agent CLI. It calls existsSync and statSync -- both of which resolve `..` against the real filesystem -- and then compares the RAW string against the declared roots using normalizePath (src/mcp/lane-runner.ts:494-500), which only unifies separators, trims trailing slashes and lowercases on win32. It never calls path.resolve, path.normalize or realpathSync (grep of src/mcp/lane-runner.ts and src/mcp/server.ts confirms none of the three appears). The containment test at src/mcp/lane-runner.ts:477 is a prefix comparison on an unresolved string, so a `..` segment satisfies the prefix while the OS resolves elsewhere. Verified empirically on this machine: with allowedRoots = ['C:\Code\llm-relay'] and cwd = 'C:\Code\llm-relay\..\..\Windows', normalizePath yields 'c:/code/llm-relay/../../windows', which startsWith('c:/code/llm-relay/') is true, existsSync is true, statSync().isDirectory() is true, realpathSync resolves to 'C:\Windows', and the verdict is PERMITTED. The same class of bypass applies to a symlink inside an allowed root that points outside it, since realpathSync is never consulted. Existing coverage does not reach this: the checkCwd suite at test/mcp-server.test.ts:531-594 has exactly five cases -- no allowedRoots declared (:532), a path that is not a directory (:537), an unrelated absolute path denied (:546), a sibling that must not pass as a prefix match with a real child as the control (:560), and trailing-separator handling (:585) -- but no case containing a `..` segment, so the full gate passes with the bypass present. Recommended change: resolve the candidate with path.resolve (and preferably realpathSync when the directory exists) and resolve each declared root the same way BEFORE the prefix comparison, then add a `..`-traversal case and a symlink case to the checkCwd suite.

**Grounding.** [object Object]

**Files.** `src/mcp/lane-runner.ts`, `src/mcp/server.ts`, `test/mcp-server.test.ts`

### DR-003 — The accounting ledger blames the provider for the relay's own refusals: accountingFailureForAttempt falls through to provider_error for relay-mapper-defect outcomes the breaker deliberately does not charge

**MEDIUM** · confidence high · invariant_counterexample · systemic

One AttemptFailed outcome object is consumed by two subsystems, and they now disagree about whose fault it was. completeAttemptFailure (src/candidate-runner.ts:1548-1588) forwards the same options record to the circuit breaker and to the accounting ledger. On the breaker side the provenance is routed through a total table: PROVENANCE_REACHES_HEALTH_PATH at src/circuit-breaker.ts:165-171 maps 'relay-mapper-defect' to false (src/circuit-breaker.ts:170), and test/closed-vocabulary-routing.test.ts:61-67 pins it with the assertion that `a relay-local fault must not create provider health state`. On the ledger side the same record goes to accountingFailureForAttempt (src/candidate-runner.ts:1493-1503), whose provenance argument is only ever consulted in one branch -- `options.failure === 'transport' && options.provenance === 'deadline'` -- and which then falls through to an unconditional `return 'provider_error'` at src/candidate-runner.ts:1502. Concrete counterexample, reachable on BOTH fronts: a dialect-rescue destructive refusal is relay-authored and carries errorOrigin local, so src/routes/messages.ts:890-895 and src/routes/openai-front.ts:463-468 both call completeAttemptFailure with `failure: 'http'` and `provenance: 'relay-mapper-defect'`. failure 'http' matches none of the three guarded branches, so the ledger records failureKind 'provider_error' for a refusal that came out of the operator's own repair.destructiveTools list, while the breaker correctly records nothing against that deployment. ProxyAccountingFailureKind already declares 'unknown' and 'protocol', so the fall-through picks the STRONGER and wrong-blame claim over two available weaker ones -- the exact shape CLAUDE.md documents eight prior instances of and that test/closed-vocabulary-coverage.test.ts:7-25 describes as the recurring bug class. There is no test coverage at all: grep of test/ finds zero references to accountingFailureForAttempt or ProxyAccountingFailureKind. Recommended change: give accountingFailureForAttempt a total mapping over (failure, provenance) closed with `satisfies`, route relay-owned provenances to a non-provider kind, and add the case to the existing closed-vocabulary guard suite alongside its breaker sibling.

**Grounding.** [object Object]

**Files.** `src/candidate-runner.ts`, `src/routes/messages.ts`, `src/routes/openai-front.ts`, `src/circuit-breaker.ts`, `src/accounting-state.ts`

### DR-004 — GET /v1/models advertises an invented 272000-token context window whenever a spec does not resolve, contradicting the provenance rule that an unknown limit must stay unknown

**MEDIUM** · confidence high · invariant_counterexample

src/routes/admin.ts:41 declares `const CODEX_DEFAULT_CONTEXT_WINDOW = 272000` and src/routes/admin.ts:65-66 seeds both contextWindow and maxContextWindow with it for every advertised id; the resolved value only replaces it when specContextWindow (pool) or publishedContextWindow (concrete spec) returns a finite positive number. So when nothing resolves -- the documented common case for the free providers this relay fronts, where CLAUDE.md records that the published rung covered 0 of 29 pool/high members -- the relay tells the client, as a first-party statement of the model catalogue, that it may send 272000 tokens. Three project rules point the other way at once. resolveMetadata deleted its hardcoded 128k/4096 rung in 0.7.0 precisely because a caller cannot tell a guess from a measurement; the context guardrail (contextCeilingFor, src/server.ts) is documented as deliberately having no invented third rung because `a 400 built from a number nobody stated is worse than a true upstream error`; and the {contextWindow} placeholder rule states in as many words that an unknown must never be filled with a large speculative value, citing measured pool minimums of 131,072-163,840. 272000 is roughly 1.7x-2.1x those measured minimums, so the in-file justification at src/routes/admin.ts:38 (`Under-promising is safe; over-promising causes the defect this fixes`) does not hold for the value chosen. The consequence compounds with the guardrail: exactly when the window is unresolvable, the relay also has no published ceiling, so contextCeilingFor returns null, no local 400 fires, and the over-length request is discovered only by the backend. The same object also emits invented effective_context_window_percent 95 and truncation_policy limit 10000. Recommended change: omit context_window / max_context_window from an entry the resolver cannot answer for, or emit the lowest measured pool minimum rather than a Codex-shaped constant, and state the provenance of whichever number is emitted.

**Grounding.** [object Object]

**Files.** `src/routes/admin.ts`, `src/metadata.ts`, `src/server.ts`

### DR-005 — The declared BODY_TOO_LARGE_CODE tag is honoured by the dashboard route and ignored by the data plane, which still infers 413-vs-400 from the relay's own prose

**MEDIUM** · confidence high · inferred_contract_gap

readBody rejects an oversized body with a tagged error: src/stream-pipeline.ts:81 attaches `code: BODY_TOO_LARGE_CODE`, and its own comment states the tag exists because the classifier `used to regex-match this very message string, i.e. the relay inferring its own intent from prose it wrote itself`. Only one of the two consumers adopted the tag. src/dashboard-routes.ts:592-594 reads it (`bodyReadErrorCode`), and CLAUDE.md records that as a completed fix. The data plane did not: src/server.ts:426-427 still does `const msg = (e as Error).message; const status = msg.includes('too large') ? 413 : 400;`. The stream-pipeline comment even records the asymmetry as known (`Harmless for the other caller, which ignores it`). Two consequences follow from one rejection having two classification policies. First, the message text in src/stream-pipeline.ts:81 is now load-bearing prose for the data plane: renaming it -- a change no type or test links to the 413 behaviour -- silently regresses every oversized /v1/messages and /v1/chat/completions request from 413 to 400, while the dashboard stays correct, so the regression is invisible to anyone testing the dashboard path. Second, the test is a substring match on an arbitrary error message, so any other rejection reaching this catch whose message happens to contain the phrase is reported as 413. The same line also echoes the raw internal message to the client via failClosed(res, status, msg). Recommended change: have src/server.ts read the declared code exactly as src/dashboard-routes.ts does, ideally through one exported helper both call, and drop the substring test.

**Grounding.** [object Object]

**Files.** `src/server.ts`, `src/stream-pipeline.ts`, `src/dashboard-routes.ts`

### DR-006 — Credential containment on the forward path is a two-entry deny list, not an allow list, so any other credential-bearing inbound header is forwarded to a third-party provider

**MEDIUM** · confidence medium · trust_boundary_gap

buildForwardHeaders (src/candidate-runner.ts:138-155) copies EVERY inbound header to the upstream request except three sets: HOP_BY_HOP (src/stream-pipeline.ts:10-13), INTERNAL_REQUEST_HEADERS (src/candidate-runner.ts:105-110, four relay-owned names), and -- only when stripAuth is true -- INBOUND_AUTH, which is exactly `['authorization', 'x-api-key']` (src/candidate-runner.ts:111). stripAuth is computed from the config DECLARATION, which is the documented and correct half of the invariant; the gap is the enumeration of WHAT gets stripped. The stated contract is that a declared-present or explicitly contained target must never receive the caller's own credential, but enforcement is a deny list over a header namespace the client fully controls. Concrete counterexamples: a client sending `api-key` (the Azure OpenAI spelling) or `x-goog-api-key` (the Google spelling) has that credential forwarded verbatim to whatever third-party base the operator configured, alongside the relay's own key, even on a fully contained provider; `cookie` is likewise forwarded to every provider host. This is the one credential-adjacent egress surface in the repository still using a deny list. Its siblings all use the opposite discipline and say so: log.ts enforces metadata-only at the sink through the LOG_FIELDS allow list rather than by removing known-bad fields, and buildAuthHeaders writes through a total `satisfies Record<AuthHeaderName, ...>` table specifically so a new header name cannot send the credential somewhere unintended. Recommended change: forward through an allow list of the headers the backends actually need (content-type, accept, anthropic-version, anthropic-beta, user-agent and the like) with an explicit escape hatch, or at minimum extend the strip to a documented set of credential-shaped header names and pin it with a test that fails when a new one is added to a fixture.

**Grounding.** [object Object]

**Files.** `src/candidate-runner.ts`, `src/stream-pipeline.ts`, `src/authEnv.ts`

### DR-008 — The closed-vocabulary guard suites cover three unions and are structurally blind to the duplicate vocabularies the decomposition introduced

**MEDIUM** · confidence high · critical_invariant_coverage_gap · systemic

This repository treats one bug class as its signature defect and built two guard suites for it. test/closed-vocabulary-coverage.test.ts:7-25 states the shape and covers exactly three vocabularies -- AuthHeaderName (:30), FilterState (:59), ContextWindowSource (:93) -- and test/closed-vocabulary-routing.test.ts covers four more plus the dashboard wire unions (:42, :76, :101, :132, :144). Several of those cases work by grepping the source for a required `satisfies Record<Union, ...>` and for the absence of the old hand-written test, which is the right mechanism. The gap is that both suites enumerate their subjects by hand, so they can only ever cover vocabularies someone remembered to add, and the v0.68.x decomposition added new duplicates none of them see. Two are verifiable now. ProxyAccountingFailureKind is declared twice under one name, at src/accounting-state.ts:48 and src/candidate-runner.ts:1491, with identical members; grep of test/ finds zero references to the type or to its only classifier, accountingFailureForAttempt, so nothing would notice the two copies diverging, and nothing pins the classifier examined in DR-003. EFFORT_LEVELS is declared twice as a runtime array with consumers split across the copies (DR-001) and has zero test references. A mechanical scan of src/ finds 36 exported names declared in more than one module, 31 of them the config-types.ts / config.ts pair, plus ToolCallIdMode and ThoughtSignatureMode in three modules each, QuotaAxis and QuotaPeriod in both src/dashboard-contract.ts (:76-80) and src/quota-observation.ts (:2-4), AccountingSpendCoverage in two, and Verdict meaning two unrelated things in src/delegate-gate/types.ts and src/ping/metrics.ts. The existing enforcement layer already assumes one declaration per name -- test/architecture-map.test.ts:42 requires a CLAUDE.md row per src/ MODULE, which says nothing about a name declared in two of them. Recommended change: add a generic, non-enumerated guard that scans src/ for an exported name declared in more than one module and fails on any pair not on an explicit allow list, so a future decomposition cannot re-create a duplicate closed vocabulary without a red gate; then add ProxyAccountingFailureKind to the hand-written suite alongside its OutcomeProvenance sibling.

**Grounding.** [object Object]

**Files.** `test/closed-vocabulary-coverage.test.ts`, `test/closed-vocabulary-routing.test.ts`, `test/architecture-map.test.ts`, `src/accounting-state.ts`, `src/candidate-runner.ts`, `src/config-types.ts`, `src/config.ts`, `src/quota-observation.ts`, `src/dashboard-contract.ts`

### DR-007 — The decomposition published server.ts internals as candidate-runner.ts public API: 36 of 87 exports have no consumer in src/ or test/, multiplying the test-only-seam hazard the repo already documents

**LOW** · confidence high · inferred_contract_gap · systemic

src/candidate-runner.ts carries 87 exported names across 1,674 lines while only three files in src/ import from it. A mechanical scan shows 36 of those exports are referenced nowhere outside the module itself, in neither src/ nor test/: MID_STREAM_ERROR_KIND, TargetUsability, CredentialAttemptLabel, OutcomeClass, ServedAnnouncementContext, filterResponseHeaders, endMidStreamFailure, midStreamMessage, cooledByAllowance, cooledByQuota, coolingLiftTime, credentialAttemptLabel, StartedAttempt, HedgedAttemptDeps, HedgedAttemptResult, settleResponse, walkWouldFailOver, hedgedLabel, WalkExitKind, WalkExitData, stickyHeaderValue, orderByUsabilityTracked, recordCall, abortOnClientClose, observeContextLimit, observeMaxOutput, observeStatedRateLimits, observeRateLimit, EligibilityObservation, refusalBodyCandidates, carriesEligibilityFact, InspectedCandidateResponse, accountingFailureForAttempt, completeAttemptAbandoned, completeCancellation and PostHeaderBodyDisposition. Spot-checked examples confirm the pattern -- orderByUsabilityTracked is called only at src/candidate-runner.ts:971 and defined at :975; filterResponseHeaders only at :223 and :199; completeCancellation only at :1595 and :1608. Two contract consequences. First, this repository ships .d.ts files deliberately (build:server runs tsc twice specifically to keep declaration doc comments), so every one of these is now a published surface of the package that a consumer may bind to and that a future refactor must treat as breaking. Second, CLAUDE.md already flags a concrete instance of the resulting hazard -- CircuitBreaker.orderByUsability has ZERO src/ callers and is described as a test-only seam that drifted from the live ordering path with `nothing in production to notice` -- and src/server.ts:104 re-exports four more names purely for tests. The decomposition thus reproduced the hub problem rather than dissolving it: src/server.ts fell to 894 lines, but the module that absorbed it is described in CLAUDE.md only as candidate walk, hedging, ranking, retry classification and attempt lifecycle, while it in fact also owns credential containment, response-header policy, SSE mid-stream error handling, eligibility and refusal observation, rate-limit and context-limit learning, sticky ordering and accounting failure classification. Note also that src/storage/json-store.ts exports a JsonStore class that no src/ module constructs. Recommended change: reduce the export surface to the names the three importers and the tests actually bind, and split the module along the responsibilities CLAUDE.md's own row does not cover.

**Grounding.** [object Object]

**Files.** `src/candidate-runner.ts`, `src/server.ts`, `src/storage/json-store.ts`, `CLAUDE.md`

