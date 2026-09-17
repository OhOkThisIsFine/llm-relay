# Duplication & Complexity Evidence Catalog — 2026-09-05

Phase 2 of the Duplication, Complexity, and Refactoring Audit for llm-relay.
Source data: `analysis-reports/duplication-audit-2026-09-05/` (`jscpd-report.json`,
`jscpd-calibration.json`, `complexity-report.json`, `hotspots.json`) plus targeted
source inspection of every clone window. Method scripts:
`analysis-reports/duplication-audit-2026-09-05/measure-complexity.mjs`,
`measure-churn.mjs`.

Every finding carries a unique ID, exact `src/` paths with line ranges, enclosing
symbol names, and token/line sizes from jscpd. jscpd IDs (`#0`–`#40`) reference the
pair index in `jscpd-report.json` `duplicates[]`.

---

## 1. Executive Summary & Metric Summary

| Metric | Value |
|---|---|
| Files analyzed (TS, `src/`, tests/dist/dashboard excluded) | 123 |
| Lines analyzed | 55,410 |
| Tokens analyzed | 317,668 |
| Exact clones found (jscpd, min-tokens 60 / min-lines 5) | 41 |
| Duplicated lines | 519 (0.94%) |
| Duplicated tokens | 3,520 (1.11%) |
| Functions analyzed | 2,937 |
| Max cognitive complexity | 197 (`anthropicMessagesPath`) |
| Max cyclomatic complexity | 104 (`handleAdminRoutes`) |
| Functions with cognitive ≥ 15 | 201 |
| Functions with cognitive ≥ 10 | 361 |
| Functions with cyclomatic ≥ 10 | 303 |
| Files with churn in 90d window | 128 |
| Hotspots ranked below | 15 |

**Calibration** (`jscpd-calibration.json`): min-tokens 50 → 63 clones / 697 lines
(1.26%); min-tokens 60 → 41 / 519 (0.94%, operating point); min-tokens 70 → 26 /
381 (0.69%). The 50–59-token band is idiom noise (JSON-RPC guards, SSE parse
chains, push closures, print loops); 60/5 retains every ≥20-line substantive
clone and the within-file guard-chain repetitions. 70/5 is the high-signal subset
for CI gating.

**Distribution of findings in this catalog:**

| Category | Entries | jscpd pairs covered |
|---|---|---|
| Type 2 parameterized / renamed clones (`CLONE-01`–`CLONE-21`) | 21 | 33 pairs |
| Type 3 structural / near-miss / gapped clones (`CLONE-22`–`CLONE-27`) | 6 | 7 pairs |
| Type 4 semantic clones & shared-helper debt (`SEM-01`–`SEM-07`) | 7 | n/a (inspection) |
| Verified benign duplication (`BENIGN-01`–`BENIGN-05`) | 5 | 3 pairs accepted, rest policy |
| Technical-debt hotspots (`HOTSPOT-01`–`HOTSPOT-15`) | 15 | n/a |

Cross-file clones: 15 pairs (10× `routes/messages.ts` ↔ `routes/openai-front.ts`,
3× `delegate-gate/`, 2× `think-tags.ts` ↔ `tool-use-ids.ts`). The remaining 26
pairs are within-file repetitions. No test files were in scope (excluded by
design); there are therefore zero test-fixture clones to adjudicate — see
`BENIGN-05`.

Headline: absolute duplication is low (0.94%), but it concentrates exactly where
it hurts — the two wire-compat front handlers (`anthropicMessagesPath` /
`openAiFrontPath`, also the two most cognitively complex functions in the repo at
197/196) share ~200 lines of attempt-walk logic, and the four `delegate-gate`
analyzers share their whole driver scaffold. Complexity risk dominates clone
risk: 201 functions sit at cognitive ≥ 15.

---

## 2. Type 2 Parameterized / Renamed Clones

Statement sequences identical modulo renamed identifiers, constants, string
literals, or formatting.

### Front-pair cluster: `routes/messages.ts` ↔ `routes/openai-front.ts`

The Anthropic-messages front and the OpenAI front each run the same
credential-walk / hedge-race / attempt-lifecycle / stream-commit protocol, already
factored through shared helpers (`beginHealthAttempt`, `endWalk`, `baseLog`,
`completeAttempt*`, `recordCredentialOutcome`, `inspectCandidateResponse`,
`respondAllCapped`). What remains duplicated is the call-site choreography,
parameterized by the response handle (`backendRes` ↔ `upstream`), the inbound
headers (`ctx.req.headers` ↔ `ctx.inboundHeaders`), and the protocol literal
(`"anthropic"` ↔ `"openai"`).

- **CLONE-01 — Egress attempt-begin block.** `src/routes/messages.ts:695-714`
  (`anthropicMessagesPath`) ↔ `src/routes/openai-front.ts:216-238`
  (`openAiFrontPath`). 20 lines, 121 tokens (jscpd #28). `onEgress` closure:
  `pool429.noteEgress()`, `beginHealthAttempt(...)`, `startServe(...)`,
  `recordCredentialStarted`, `tried.push(...)`. Parameter differences: leading
  context lines and the trailing `protocol:` literal (`"anthropic-messages"` vs
  `ctx.protocol === "responses" ? "openai-responses" : "openai-chat"`). Both sides
  carry the ⚠ comment warning against hand-rebuilding `ProviderTargetIdentity` —
  the shared-helper discipline is already the norm here; the block is the next
  extraction.
- **CLONE-02 — Credential-reject + failClosed + request log.**
  `src/routes/messages.ts:734-739` ↔ `src/routes/openai-front.ts:259-272`. 6–14
  lines, 70 tokens (jscpd #29). `credentialWalk.recordRejected`, `failClosed(res,
  502, ...)`, `baseLog(...)` write. Parameter differences: headers source only;
  the openai-front side additionally wraps `baseLog` arguments multiline
  (formatter noise, same tokens).
- **CLONE-03 — Pre-egress failure branch.** `src/routes/messages.ts:777-791` ↔
  `src/routes/openai-front.ts:311-333`. 15 lines, 114 tokens (jscpd #30).
  `settled.ok` check → `recordRejected` → `res.destroyed` guard → 504/502
  `failClosed` → `baseLog` write. Identical modulo `baseLog` argument packing
  (single-line vs multiline).
- **CLONE-04 — Transport-failure completion + credential outcome + `endWalk`.**
  `src/routes/messages.ts:791-817` ↔ `src/routes/openai-front.ts:334-360`. 27
  lines, 123 tokens (jscpd #31). `completeAttemptFailure({failure:"transport"})`,
  `recordCredentialOutcome(timeout vs provider-transport)`, `endWalk(h, res, …)`.
  Verbatim.
- **CLONE-05 — Post-header body-failure inspect/disposition.**
  `src/routes/messages.ts:855-865` ↔ `src/routes/openai-front.ts:427-437`. 11
  lines, 70 tokens (jscpd #32). `inspectCandidateResponse(...)`,
  `completePostHeaderBodyFailure(...)`, `credentialRecorded = true`,
  timeout→504/502 mapping, `endWalk`. Parameter difference: `backendRes` ↔
  `upstream`.
- **CLONE-06 — `endWalk` transport/post-header continuations.**
  `src/routes/messages.ts:866-886` ↔ `src/routes/openai-front.ts:438-458`. 21
  lines, 85 tokens (jscpd #33). `endWalk` argument lists identical except the
  protocol literal (`"anthropic"` ↔ `"openai"`) and the `() => baseLog(...)`
  closure; `walkEnd` → `continue`/`return` tails verbatim.
- **CLONE-07 — Stream-commit probe cancelled/dead branches (largest cross-file
  clone).** `src/routes/messages.ts:924-956` ↔
  `src/routes/openai-front.ts:499-531`. 33 lines, 183 tokens (jscpd #34).
  `probe.kind === "cancelled"` → `completeAttemptCancelled` +
  `recordCredentialOutcome(cancelled)`; `"dead"` → deadline-aware
  transport/protocol failure + outcome mapping + `endWalk`. Parameter difference:
  `dialectRefusalSignalOf(backendRes)` ↔ `dialectRefusalSignalOf(upstream)`.
- **CLONE-08 — Dead-stream `endWalk` 502 block.**
  `src/routes/messages.ts:957-986` ↔ `src/routes/openai-front.ts:532-561`. 30
  lines, 108 tokens (jscpd #35). `endWalk` with `kind: "dead-stream"`, `llm-relay:
  ${probe.reason}` message, `errorType`/`errorOrigin`/`servedBy`/`shouldTryNext`
  payload. Parameter difference: protocol literal only.
- **CLONE-09 — Shared route-context interface fields.**
  `src/routes/messages.ts:90-97` (`MessagesContext`) ↔
  `src/routes/openai-front.ts:87-94` (`OpenAiFrontContext`). 8 lines, 64 tokens
  (jscpd #21). Shared fields: `isDestructive`, `resolveReshaper`,
  `withRepairAccounting`, `catalog.cachedLimits`. Textbook extract-superinterface
  case (see P1-2).

### Within-file Type 2 families

- **CLONE-10 — Transparent/repair path skeleton, `src/routes/messages.ts`.**
  Six pairs inside `transparentPath` (:174), `repairStreamingPath` (:292),
  `repairBufferedPath` (:484): #22 (218-233 ↔ 379-394, 16 lines: `finally
  {clearTimeout}` + `res.destroyed` guard + `validated`/`toolUseCount` init);
  #24 (240-248 ↔ 443-452, 9 lines: `completeAttemptFailure` http/provenance
  block); #25 (253-263 ↔ 460-470, 11 lines: success/completion + `baseLog`
  write); #26 (420-431 ↔ 553-564, 12 lines: `repair(assistant, ctx.tools, …)`
  invocation, verbatim); #27 (440-459 ↔ 576-595, 20 lines: protocol-failure
  completion, verbatim). The three path functions are one skeleton with repair
  stages inserted — the family straddles Type 2/3; the five verbatim pairs are
  catalogued here, the two gapped variants under CLONE-24.
- **CLONE-11 — SSE frame extraction, `src/backend.ts`.** #1 (535-540 ↔ 643-648,
  6 lines, 66 tokens): `\r?\n\r?\n` boundary-split loop repeated inside
  `preflightResponseStream` (:523, incl. nested `captureReportedModel` region);
  #2 (604-610 ↔ 1209-1215, 7 lines, 61 tokens): `data:`-line
  split/filter/map/join/trim + `[DONE]` guard, shared between the preflight
  region and `suppressRelayAddedOpenAiUsageFrames` (:1186). #2 differs by one
  token: bare `return` vs `return false`.
- **CLONE-12 — Keystore load-guard-mutate prologue, `src/keystore.ts`.** #19
  (1070-1080 in `addEntry` :1066 ↔ 1390-1400 in `restoreEntryFromExport` :1386).
  11 lines, 123 tokens: `resolveKeystorePath` → `loadStore` →
  `refuseMutation` on unreadable/degraded → `cloneStoreForMutation` →
  duplicate-id guard → `createStore`/`unlockStoreForWrite`. Verbatim modulo
  formatting.
- **CLONE-13 — Context-limit / max-output symmetric pairs,
  `src/context-limits.ts`.** #6 (83-93 ↔ 175-185, 11 lines): stated-limit
  pattern-scan loop, parameterized by table (`STATED_LIMIT_PATTERNS` ↔
  `STATED_MAX_OUTPUT_PATTERNS`); #7 (109-117 ↔ 201-209, 9 lines): `recordFact`
  write, parameterized by fact name (`"context-limit"` ↔ `"max-output"`) with
  matching doc comments. Cleanest table-driven dedup in the catalog (see P1-6).
- **CLONE-14 — Dashboard route branches, `src/dashboard-routes.ts`
  (`handleDashboardRoute` :634).** #8 (683-688 ↔ 705-710, 6 lines):
  parse→`errorResponse`→`validateSession`→read dispatch, parameterized by
  `parseSnapshotQuery`/`readSnapshot` ↔ `parseDetailQuery`/`readDetail`; #9
  (743-750 ↔ 793-800, 8 lines): `isAuthFailure` → 409/401 mapping → 500
  `internal` + catch-all tails, verbatim.
- **CLONE-15 — Dashboard snapshot pairs, `src/dashboard-snapshot.ts`.** #10
  (385-390 `mergeTokenCell` :378 ↔ 444-449 `mergeMetric` :442, 6 lines):
  seen/boundedAdd accumulation, last-line field differs (`overflow` ↔
  `samplesDropped`); #11 (914-921 `materializeDimensions` :911 ↔ 1177-1184
  `materializeCostRows`, 8 lines): requests→attempts→key comparator, verbatim;
  #12/#13 (1474-1499 `processRows` :1454 ↔ 1667-1682 `readCostReport` :1627,
  6+12 lines): minute-cell scan + `noteAccountingCoverage` payload, verbatim
  modulo nesting depth (the `readCostReport` side nests one level deeper).
- **CLONE-16 — Delegate-gate analyzer driver family.** #14
  (`cast-necessity.ts:68-88` doc-comment + `findingsForFile` prelude ↔
  `shared-state.ts:116-126`, 21 lines, 120 tokens); #16
  (`cast-necessity.ts:80-88` `findingsForFile` ↔ `cast-necessity.ts:125-133`
  `castEditsForFile`, 9 lines: same post-image prelude, different result
  accumulator); #17 (`cast-necessity.ts:104-112` `analyzeCastNecessity` ↔
  `shared-state.ts:159-167` `analyzeSharedStateMutation`, 9 lines: file-loop
  driver, function name only). Plus the `test-assertions.ts:252-258` side of #15
  (same prelude). Highest-value Phase 1 target (see P1-1); the single
  parameterization snag (`ScriptKind.TSX`-conditional vs plain `.TS`) is
  CLONE-27.
- **CLONE-17 — Dispatch-view setup, `src/cli.ts`.** #4 (2484-2498
  `resolveDispatchView` :2468 ↔ 2651-2665 `runDispatch` :2612). 15 lines, 61
  tokens: `ModelCatalog` + `materializeDynamicPools` try/catch +
  `contextWindowResolver` + `tryServer` live-fetch. Near-verbatim; comment
  reworded ("stays empty" vs "simply stays empty") and `qs` path construction
  differs (see CLONE-28-adjacent note).
- **CLONE-18 — Duplicate-completion guard, `src/circuit-breaker.ts`.** #3
  (376-384 `observeHeaders` :373 ↔ 415-423 `completeAttempt` :412). 9 lines, 67
  tokens: `getAttemptRecord` → `completedId` duplicate-completion error.
  Parameter difference: `observation.target` ↔ `outcome.target`.
- **CLONE-19 — Provider print loop, `src/onboarding.ts`
  (`printOnboardingGuide` :72).** #20 (81-86 `freeProviders` loop ↔ 91-96
  `mixedProviders` loop). 6 lines, 61 tokens; body identical except the CTA
  string. Accepted as benign copy divergence — see BENIGN-03 (kept decoupled
  deliberately; listed here so the adjudication is on record).
- **CLONE-20 — SSE transform-stream pump + tails, `src/think-tags.ts`
  (`stripThinkTagsInStream` :142) ↔ `src/tool-use-ids.ts`
  (`rewriteToolUseIdsInStream` :181).** #38 (187-199 ↔ 223-235, 13 lines:
  `reader.read`/`frames.append`/`processFrames` pump) and #39 (208-217 ↔
  242-251, 10 lines: `flushHeld`/`takeRemainder` + identical `event: error` SSE
  frame + `controller.close()`). Exact Type 1 pairs; the transform above the
  window differs, so the family is Type 2 overall — one shared
  stream-transform scaffold (see P1-4).
- **CLONE-21 — Schema guard-chain tails, `src/accounting-store-schema.ts`.**
  #0 (1090-1097 `isAttemptPacket` :1062 ↔ 1161-1168 `isRequestPacket` :1125). 8
  lines, 65 tokens: `isNullableCounter`/`isNullableId`/`isAggregateTokens`/
  `isSpend` tail chain shared; heads differ (`attribution` vs
  `commitAttemptId`). Extract-shared-tail case (see P1-7).

---

## 3. Type 3 Structural / Near-Miss / Gapped Clones

Blocks with identical operations but inserted, deleted, reordered, or repacked
statements — including behavior-divergent near-misses that a mechanical merge
must not flatten.

- **CLONE-22 — Attempt-settlement `finally` + all-capped tail with differing
  heads.** `src/routes/messages.ts:1122-1151` ↔
  `src/routes/openai-front.ts:675-704` (jscpd #36). 30 lines, 182 tokens. The
  `finally` settlement (`recordCredentialOutcome` cancelled/local,
  `recordRejected` fallback, incomplete-attempt mapping failure, timer/close
  cleanup) and the `pool429.allCapped()` → `respondAllCapped` tail are verbatim;
  the heads differ (transparent-path dispatch vs log-expression close) and the
  protocol literal differs. Gapped head, shared tail.
- **CLONE-23 — `endWalk` transport vs post-header variants inside
  `openAiFrontPath`.** `src/routes/openai-front.ts:357-379` ↔ `:434-449`
  (jscpd #37). 23 lines, 62 tokens. Same `endWalk(h, res, "openai", …)` shape
  with `() => baseLog(...)` closure, but the failure `kind` (`"transport"` +
  status/message payload vs `"post-header-body-failure"`) and the `baseLog`
  packing (multiline vs single-line) differ — call-shape clone with argument
  gaps.
- **CLONE-24 — Guard + packing variants in the messages skeleton family.**
  (a) `src/routes/messages.ts:234-240` (`transparentPath`) ↔ `:400-406`
  (`repairStreamingPath`, jscpd #23): the validator block is identical except
  the guard — `if (ctx.willValidate && assistant)` vs nested `if (assistant)`
  (the `willValidate` check hoisted to the caller in the repair path). (b)
  `:253-263` ↔ `:460-470` (jscpd #25): identical completion/logging except
  `logStatus: "committed"` passed via conditional spread vs literal. Reordered /
  repacked twins of CLONE-10 pairs.
- **CLONE-25 — Keystore entry validators with field-list gap.**
  `src/keystore.ts:357-366` (`validStoredEntry` :344) ↔ `:1247-1253`
  (`validExportEntry` :1244) (jscpd #18). 10 lines, 71 tokens. Same
  `parseCredentialId` + provider/envName/ciphertext checks modulo statement
  wrapping, with a field-list gap (`"disabled"`-terminated vs
  `"revokedAt", "disabled", "value"`-terminated exclusion lists). Merge must
  keep the two exclusion sets distinct.
- **CLONE-26 — Dialect-parser near-miss with catch-policy divergence.**
  `src/tool-dialects.ts:266-274` (`fromDeepSeekForm` :263) ↔ `:313-321`
  (`fromTaggedJsonForms` :306) (jscpd #40). 9 lines, 86 tokens. The
  `matchAll`→name/payload→`JSON.parse` guard chain matches modulo the regex
  literal — but the `catch` arms diverge: `{ return []; }` (abort whole parse)
  vs `{ continue; }` (skip one match). ⚠ Do not mechanically unify without
  deciding the error policy; the catalog recommends `continue` + a
  `detected`-to-caller contract (the `fromDeepSeekForm` comment already assigns
  that responsibility to the caller).
- **CLONE-27 — Single-point `ScriptKind` variation in the delegate-gate
  prelude.** `src/delegate-gate/cast-necessity.ts:68-86` ↔
  `src/delegate-gate/test-assertions.ts:249-258` (jscpd #15). 19 lines, 99
  tokens; the only material difference is `path.endsWith(".tsx") ?
  ts.ScriptKind.TSX : ts.ScriptKind.TS` vs `ts.ScriptKind.TS`. Parameterize with
  a `tsx: boolean` (or accept-`.tsx`) flag when extracting the shared prelude
  (P1-1).

---

## 4. Type 4 Semantic Clones & Shared Helper Debt

Identical algorithmic intent in different syntax, or scattered logic that wants
one home. Verified by inspection (no jscpd pair — that is the point).

- **SEM-01 — Local `failClosed` shadow in `routes/admin.ts`.**
  `src/routes/admin.ts:174-177` defines a 4-line local `failClosed(res, status,
  message)` (writeHead + JSON error envelope), while `src/stream-pipeline.ts:162`
  exports the shared `failClosed` used by `server.ts`, `candidate-runner.ts`,
  both front handlers. Same intent, narrower arity (no headers/options). Debt:
  two JSON-error envelopes to keep in sync. Opportunity: reuse the shared
  helper (P1-5; verify envelope-shape parity first).
- **SEM-02 — SSE frame-pump / stream-transform family.** Six sites implement
  the same read-frames → transform → push loop with different bodies:
  `reconstructFromSse` (`src/sse.ts:47`, cognitive 75),
  `preflightResponseStream` (`src/backend.ts:523`, incl. nested
  `captureReportedModel`),
  `suppressRelayAddedOpenAiUsageFrames` (`src/backend.ts:1186`),
  `recoverDialectInStream` (`src/dialect-stream.ts:35`, `start` cognitive 76),
  `recoverDialectInOpenAiChatStream` (`src/openai-dialect.ts:246`,
  `processEvent` cognitive 78), plus the CLONE-20 pump wrappers
  (`stripThinkTagsInStream`, `rewriteToolUseIdsInStream`). The boundary-split
  (`\r?\n\r?\n`) and `data:`-line extraction are already verbatim clones
  (CLONE-11) — the rest is the same pump with different visitors. Opportunity:
  one SSE splitter + one transform-stream scaffold parameterized by
  per-frame/per-event callbacks (P2-3; the three cognitive-75+ members make this
  the complexity play, not just the clone play).
- **SEM-03 — Retry-window parsing in two input domains.** `parseRetryAfterMs`
  (`src/backend.ts:317`) parses RFC 9110 `Retry-After` headers (delta-seconds /
  HTTP-date); `statedRetryAfterMs` (`src/lane-quota-probe.ts:130`) parses
  natural-language bodies ("try again in 30 seconds", closed unit vocabulary
  `RETRY_UNIT_MS`, capped by `MAX_EXHAUSTED_MS`). Same output vocabulary
  (`ms | null`), same downstream (`retryAfterMs` verdicts via
  `observeEligibility`/`resolveReset`/`recordFailover`/lane-cadence defaults).
  Opportunity: shared ceiling/clamp policy and a single `retryAfterMs` value
  type; keep the two parsers (different domains) but unify what consumes them.
- **SEM-04 — Scattered status→verdict interpretation.** `classifyStatus`
  (`src/candidate-runner.ts:1121`), `resolveReset`
  (`src/candidate-runner.ts:1496`), `openAiResponsesVerdict`
  (`src/stream-commit.ts:217`, cognitive 37), `statusForQueryError`
  (`src/dashboard-routes.ts:575`), and `invalidEnvelopeReason`
  (`src/backend.ts:442-501` — cyclomatic 44, cognitive 89, the sharpest
  single-function status-mapping hotspot). Five status-code readers, five
  verdict vocabularies. Opportunity: one status-interpretation table feeding all
  five (P2-4).
- **SEM-05 — Session/auth-check scatter (mostly healthy).**
  `parseAuthHeader` (`src/config.ts:847`) is centralized with two call sites
  (:1281, :1988) — the good example. Against it: `validateSession` in
  `dashboard-routes.ts`, `control-authorization.ts` (cognitive 10),
  `dashboard-auth.ts` each re-derive "is this request authorized" for their own
  surface. No verbatim clone; the debt is conceptual drift risk across three
  small checkers. Low priority; watch item.
- **SEM-06 — Cooldown/quota-lease expiry arithmetic.** The same "explicit beats
  default" policy (`src/dispatch.ts:45` documents it) is re-implemented at
  `lane-cadence.ts:192` (`verdict.retryAfterMs ?? OUTCOME_DEFAULT_MS[outcome]`),
  `circuit-breaker.ts:608-612` (`MIN_RETRY_AFTER_MS` clamp),
  `target-facts.ts:395-403` (stated-`retryAfterMs` acceptance gate),
  `dispatch-exhaustion-persistence.ts` (30-day vendor-stated cap). Opportunity:
  one TTL-resolution policy object (`resolveCooldownMs(explicit, outcome,
  caps)`) — P2-5.
- **SEM-07 — Schema-guard complexity cluster.** `isRequestPacket`
  (`src/accounting-store-schema.ts:1125`, cognitive 62) and
  `isAggregateFields` (:779, cognitive 51) are the two most complex validators;
  `migrateV1` (`src/refusal-interpretation.ts:751`, cognitive 41) does
  versioned-shape migration by hand. Related to CLONE-21 (shared guard tails).
  Opportunity: combinator-based field validators so the next packet type adds a
  declaration, not a 100-line guard.

Already-centralized helpers (evidence the codebase pays this debt down — do not
re-flag): `errorOrigin` (`backend.ts:88`, single validator, both fronts +
`candidate-runner:705` consume it), `parseRetryAfterMs` (4+ consumers),
`beginHealthAttempt`/`endWalk`/`baseLog` (both fronts), `respondAllCapped`
(`candidate-runner:944`, both fronts).

---

## 5. Top Technical Debt Hotspots (Churn × Max Cognitive, 90d)

Ranked by hotspot score = 90-day commit-touch count × file-max cognitive
complexity. Cyclomatic maxima and top functions from `complexity-report.json`.

| ID | File | Churn | Max Cog | Max Cyclo | Score | Top complex functions |
|---|---|---|---|---|---|---|
| HOTSPOT-01 | `src/server.ts` | 109 | 108 | 63 | 11772 | `handle` :412 (303 lines, cog 108, cyclo 63) |
| HOTSPOT-02 | `src/cli.ts` | 109 | 95 | 69 | 10355 | `runDispatch` :2612 (cog 95, cyclo 69), `runPools` :3759 (cog 87), `runOffload` :2849 (cog 80), `runEligibility` :3158 (cog 71), `main` :4062 (293 lines, cog 36) |
| HOTSPOT-03 | `src/config.ts` | 70 | 137 | 83 | 9590 | `parseRouting` :1320 (228 lines, cog 137, cyclo 83), `loadConfig` :928 (cog 50), `parseLadder` :1835 (cog 42) |
| HOTSPOT-04 | `src/backend.ts` | 48 | 89 | 46 | 4272 | `invalidEnvelopeReason` :442 (cog 89, cyclo 44), `fetchTranslatedOpenAiFront` :1692 (cog 74), `fetchOpenAiBackend` :746 (cog 50), `preflightResponseStream` :523 |
| HOTSPOT-05 | `src/routes/admin.ts` | 23 | 180 | 104 | 4140 | `handleAdminRoutes` :253 (278 lines, cog 180, cyclo 104 — highest cyclomatic in repo) |
| HOTSPOT-06 | `src/candidates.ts` | 32 | 64 | 61 | 2048 | `buildSingleCandidate` :519 (203 lines, cog 64, cyclo 61) |
| HOTSPOT-07 | `src/dispatch.ts` | 22 | 46 | 25 | 1012 | `toLane` :742 (cog 46) |
| HOTSPOT-08 | `src/routes/messages.ts` | 5 | 197 | 78 | 985 | `anthropicMessagesPath` :663 (491 lines, cog 197, cyclo 78 — highest cognitive in repo), `repairStreamingPath` :292 (cog 73), `transparentPath` :174 (cog 58), `repairBufferedPath` :484 (cog 51) |
| HOTSPOT-09 | `src/refusal-interpretation.ts` | 22 | 41 | 19 | 902 | `migrateV1` :751 (cog 41) |
| HOTSPOT-10 | `src/dashboard-snapshot.ts` | 8 | 98 | 38 | 784 | `processRows` :1454 (cog 98, cyclo 38), `readCostReport` :1627 (cog 68), `readSnapshot` :1751 (cog 36) |
| HOTSPOT-11 | `src/routes/openai-front.ts` | 4 | 196 | 77 | 784 | `openAiFrontPath` :118 (589 lines, cog 196, cyclo 77), cf. HOTSPOT-08 — the pair dominates CLONE-01–08/22–23 |
| HOTSPOT-12 | `src/accounting-store-schema.ts` | 11 | 62 | 48 | 682 | `isRequestPacket` :1125 (cog 62, cyclo 48), `isAggregateFields` :779 (cog 51) |
| HOTSPOT-13 | `src/accounting-store.ts` | 14 | 47 | 28 | 658 | `AccountingStoreImpl.usedInWindow` :1194 (cog 47), `.flush` :986 / `.commitRetention` :1658 (cog 35 each) |
| HOTSPOT-14 | `src/dashboard-routes.ts` | 7 | 90 | 58 | 630 | `handleDashboardRoute` :634 (cog 90, cyclo 58), `scanJsonValue` :360 (cog 82) |
| HOTSPOT-15 | `src/circuit-breaker.ts` | 24 | 23 | 17 | 552 | max cog only 23 — ranked by churn (24 touches); steady-state evolution risk, not complexity risk |

Why this is debt, per tier:

- **HOTSPOT-01–03 (score > 9000): churn × complexity collision.** `server.ts`,
  `cli.ts`, `config.ts` change in nearly every commit batch (109/109/70 touches)
  while housing 100+-cog functions. Every edit pays the comprehension cost of
  `handle`/`runDispatch`/`parseRouting`. `cli.ts` (4,484 lines, 244 functions,
  total cognitive 1,190 — highest aggregate in repo) is the decomposition
  priority by volume; `config.ts` (total cyclomatic 635) by density.
- **HOTSPOT-04/05 (score ~4200): complexity outliers with real churn.**
  `handleAdminRoutes` has the repo's highest cyclomatic complexity (104 — a
  route switch that never got split); `invalidEnvelopeReason` (cyclo 44) is the
  status-mapping hotspot behind SEM-04.
- **HOTSPOT-06–09: domain-logic concentration.** `buildSingleCandidate`,
  `toLane`, the messages repair-path trio, `migrateV1` — each is the single
  home of a subtle policy (candidate construction, lane mapping, envelope
  repair, v1 migration). Correct today; fragile under the next policy change.
- **HOTSPOT-08/11: the pair to watch.** `anthropicMessagesPath` (cog 197) and
  `openAiFrontPath` (cog 196) are the #1 and #2 most complex functions *and*
  share ~200 duplicated lines (CLONE-01–08, CLONE-22–23). Low churn (5/4) keeps
  them out of the top ranks, but any wire-compat change touches both —
  complexity × duplication × protocol-criticality is the repo's sharpest
  latent risk.
- **HOTSPOT-10–15: single-function spikes in mid-churn files.**
  `processRows`/`readCostReport` (near-duplicate minute-scans, CLONE-15),
  `isRequestPacket`/`isAggregateFields` (SEM-07), `handleDashboardRoute` +
  `scanJsonValue` (a hand-rolled JSON scanner at cog 82 inside a route file —
  extraction candidate), `circuit-breaker.ts` (churn without complexity:
  process risk, keepchn small and reviewed).

Notable non-hotspots (deliberately excluded): `dialect-stream.ts` (`start` cog
76) and `sse.ts` (`reconstructFromSse` cog 75) have high max-cognitive but
churn ≤ 4 and low scores (304/150) — they matter as SEM-02 members, not as
churn risks. `openai-dialect.ts` (`processEvent` cog 78, churn 5, score 390)
likewise.

---

## 6. Verified Benign Duplication (Explicit Ledger)

Accepted duplication. Each entry was inspected and is kept decoupled on purpose.

- **BENIGN-01 — Config barrel re-export.** `src/config.ts:22-54` (import) ↔
  `:58-90` (export), jscpd #5, 33 lines, 96 tokens. A TypeScript barrel
  re-exporting `config-types.js` names. The duplication is structural to the
  language pattern (import list must mirror export list); no abstraction removes
  it. Keep.
- **BENIGN-02 — Within-function loop idiom.** `src/backend.ts:535-540` ↔
  `:643-648`, jscpd #1, 6 lines. Two iterations of the SSE boundary-split loop
  inside `preflightResponseStream`. Extracting a 6-line loop used twice in one
  function adds indirection without reuse. Keep; revisit only if a third use
  appears (then fold into SEM-02's shared splitter).
- **BENIGN-03 — Intentional product-copy divergence.** `src/onboarding.ts:81-86`
  ↔ `:91-96`, jscpd #20 (CLONE-19). The free-tier CTA ("Get your 100% FREE key
  here") vs mixed-tier CTA ("Get a key for the provider's free models") differ
  by marketing intent; parameterizing the loop is possible but the copy must
  stay independently editable per tier. Keep decoupled; the shared loop body is
  5 lines and stable.
- **BENIGN-04 — Security / lookup / constant tables.** Single-home tables that
  must stay literal and greppable, explicitly accepted as a class:
  `PROVIDER_PATTERN` / `ENV_NAME_PATTERN` (`keystore.ts`), `RETRY_UNIT_MS`
  (`lane-quota-probe.ts:122-127`), `EFFORT_LEVELS` / `CLAUDE_TIER_NAMES`
  (config surface), `OUTCOME_DEFAULT_MS` (lane-cadence), `STATED_LIMIT_PATTERNS`
  / `STATED_MAX_OUTPUT_PATTERNS` (context-limits — note these two tables are
  what make CLONE-13 a clean table-parameterization rather than a merge). No
  jscpd pairs; listed so future audits do not re-litigate them.
- **BENIGN-05 — Decoupled test fixtures (policy, zero instances).** jscpd scope
  excludes `**/*.test.ts`, `**/*.spec.ts`, `test/**`; no test files were
  analyzed and no fixture clones are reported. Standing policy: isolated test
  oracles and mock setups stay decoupled even when they resemble each other —
  shared fixtures couple tests to each other. Revisit if a future run includes
  test scope.

---

## 7. Actionable Refactoring Roadmap

### Phase 1 — Immediate Deduplications (low risk, high reuse, clear boundaries)

| Priority | Item | Clones | Change | Blast radius |
|---|---|---|---|---|
| P1-1 | Delegate-gate shared driver | CLONE-16, CLONE-27 | Extract the post-image prelude (`readOriginal` → `reconstructPostImage` → `createSourceFile`) into `findingPreamble(file, path, readOriginal, {tsx: boolean})` and the `analyze*` file loop into one `runFileAnalyzer(files, readOriginal, analyzeOne)` driver | 4 files in `delegate-gate/` (`cast-necessity`, `shared-state`, `test-assertions`, + `castEditsForFile`); no callers outside the gate |
| P1-2 | Shared route-context base | CLONE-09 | `interface RouteHandlerSharedContext { isDestructive; resolveReshaper; withRepairAccounting; catalog }` in `kernel/contracts.ts`; both contexts extend it | 2 interface declarations; mechanical |
| P1-3 | Front-pair walk helpers | CLONE-01–08 | Extract per-branch helpers parameterized by `(response, headersSource, protocol: "anthropic" \| "openai")`: egress-begin, pre-egress-failure, transport-failure+endWalk, post-header disposition, probe-result handling, dead-stream endWalk. ~200 lines → one home. Keep the two handlers decoupled (wire compat) — share helpers, not control flow | `routes/messages.ts` + `routes/openai-front.ts` (both hotspots — HOTSPOT-08/11); mechanical but wide; needs the fronts' test coverage green before/after |
| P1-4 | SSE transform-stream scaffold | CLONE-20 (+SEM-02 subset) | One `createSseTransformStream({ processFrames, … })` builder owning the reader pump, error-frame push, and `controller.close()` tails; `stripThinkTagsInStream` / `rewriteToolUseIdsInStream` supply only their transforms | 2 files; narrow |
| P1-5 | Reuse shared `failClosed` in admin | SEM-01 | Replace `routes/admin.ts:174` local with `stream-pipeline.ts:162` export after verifying envelope-shape parity (`{error:{type,message}}` both sides) | 1 file, ~4 lines |
| P1-6 | Table-driven limit observers | CLONE-13 | Single `scanStatedLimit(text, patterns)` + single `recordDeploymentCeiling(factName, …)` backing both the context-limit and max-output pairs | `context-limits.ts` only |
| P1-7 | Shared envelope-guard tail | CLONE-21 (+SEM-07) | `validateCommonEnvelopeTail(value)` covering the nullable-counter/id + tokens + spend chain; `isAttemptPacket`/`isRequestPacket` keep only their heads | `accounting-store-schema.ts` only |

Estimated combined effect: eliminates ~30 of 41 jscpd pairs outright (P1-3
alone removes 10 cross-file pairs) and both exact Type 1 stream pairs.

### Phase 2 — Hotspot Decompositions (architectural risk, multi-stage)

| Priority | Item | Hotspots/clones | Shape of work |
|---|---|---|---|
| P2-1 | Break up the two front handlers | HOTSPOT-08/11, CLONE-10/22–24 | After P1-3, split `anthropicMessagesPath` (491 lines) / `openAiFrontPath` (589 lines) into walk phases (resolve → race → commit → settle), and `transparentPath`/`repairStreamingPath`/`repairBufferedPath` into shared pipeline stages with repair strategies injected |
| P2-2 | CLI + server + config decomposition | HOTSPOT-01/02/03 | `cli.ts`: extract per-command modules (`runDispatch`/`runPools`/`runOffload`/`runEligibility`/`runCandidates` already top-level — move, don't rewrite). `server.ts handle`: split admission / routing / serve phases. `config.ts parseRouting` (cog 137): rule-parser combinators |
| P2-3 | SSE/dialect pipeline consolidation | SEM-02, CLONE-11 | One SSE splitter + transform scaffold for all six pump sites; the three cog-75+ members (`reconstructFromSse`, `start`, `processEvent`) get unit-testable frame visitors |
| P2-4 | Status-verdict unification | SEM-04, HOTSPOT-04 | One status-interpretation table; `invalidEnvelopeReason` (cyclo 44) becomes table lookups + a few predicates |
| P2-5 | Cooldown/TTL policy object | SEM-06 | `resolveCooldownMs(explicitMs, outcome, caps)` single home for the explicit-beats-default policy; adopt in lane-cadence, circuit-breaker, target-facts, dispatch-exhaustion |

Layer note: P1 items stay inside their current modules (no new architectural
edges) except P1-2, which intentionally points both fronts at
`kernel/contracts.ts` — consistent with the existing `beginHealthAttempt` /
`targetIdentity` direction of travel. P2-3/P2-4 create shared pipeline/policy
modules; they should land in `kernel/` or alongside `stream-pipeline.ts`, not in
either front, to avoid re-coupling what P1-3 decoupled.

### Explicitly not proposed

- Merging the two front handlers into one parameterized handler (wire-compat
  surfaces must evolve independently; share helpers per P1-3 instead).
- Unifying `parseRetryAfterMs` with `statedRetryAfterMs` into one parser
  (different input domains — header vs body prose; unify the consumer policy
  per SEM-03/P2-5, not the parsers).
- Flattening CLONE-26's catch arms without a product decision (abort vs skip
  needs an owner call).
- Touching BENIGN-01–05.

---

*Generated 2026-09-05 from `analysis-reports/duplication-audit-2026-09-05/`
(canonical jscpd operating point: min-tokens 60 / min-lines 5) with full
per-clone source verification. Counts: 41 jscpd pairs adjudicated — 33 Type 2
(§2), 7 Type 3 (§3), 1 pair dual-listed as benign-with-record (CLONE-19 /
BENIGN-03); 7 semantic findings (§4); 15 ranked hotspots (§5); 5 benign
acceptances (§6).*
