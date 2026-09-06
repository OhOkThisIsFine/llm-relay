# Adversarial Ground-Truth Verification — 2026-09-05

Phase 3 of the Duplication, Complexity, and Refactoring Audit for llm-relay.
Catalog under audit: `docs/reviews/duplication-and-complexity-catalog-2026-09-05.md`.
Method: direct inspection of live `src/` files for every catalog item
(27 clone entries, 7 semantic findings, 5 benign acceptances, 15 hotspots).
Front-pair cluster (`CLONE-01`–`09`, `CLONE-22`–`24`, `HOTSPOT-08/11`) verified
by full end-to-end read of `src/routes/messages.ts` (1153 lines) and
`src/routes/openai-front.ts` (706 lines); all other items by targeted window
reads quoted below. Complexity/cognitive/churn numbers are taken on trust
from `complexity-report.json` / `hotspots.json` unless noted — they were not
re-derived; structural claims were all checked. Line drift ≤ 3 is accepted
silently; anything structural is flagged.

Verdict meanings: **ACCEPT** = safe extraction/consolidation, destination
named. **REFINE** = valid opportunity but scope/signature/contract must change
as stated. **REJECT** = keep separate (benign, decoupled, or distinct
semantics). **CONFIRM** (benign ledger only) = keep, adjudication stands.

## 1. Executive Verification Summary

| ID | Source valid? | Mechanism valid? | Layering | Verdict → destination |
|---|---|---|---|---|
| CLONE-01 egress-begin | ✅ exact | ✅ (+omitted fetch-fn delta) | safe | **ACCEPT** → `candidate-runner.ts` (`onEgress` body only) |
| CLONE-02 reject+failClosed | ⚠ oai end truncated (`:272`→`~277`) | ✅ | safe | **REFINE** (re-scope, then extract) → `candidate-runner.ts` / `routes/front-walk-shared.ts` |
| CLONE-03 pre-egress failure | ✅ (±2 drift) | ✅ | safe | **ACCEPT** → `candidate-runner.ts` |
| CLONE-04 transport+endWalk | ⚠ ranges overlap CLONE-03 / cut mid-call | ❌ "verbatim" false (`servedBy` gap) | safe w/ param | **REFINE** (parameterize `protocol` + optional `servedBy`) → `candidate-runner.ts` |
| CLONE-05 post-header disposition | ✅ | ✅ | safe | **ACCEPT** (fold into CLONE-06 helper) → `candidate-runner.ts` |
| CLONE-06 endWalk continuations | ⚠ heads start mid-call | ✅ | safe | **ACCEPT** (one helper w/ CLONE-05) → `candidate-runner.ts` |
| CLONE-07 probe cancelled/dead | ✅ (~4 head drift) | ⚠ omitted `malformedProvenance` predicate divergence | extract w/ injected policy | **REFINE** (parameterize `protocol` + provenance; owner decision) → `stream-commit.ts` |
| CLONE-08 dead-stream endWalk | ✅ | ✅ (protocol literal only) | safe | **ACCEPT** → `stream-commit.ts` / candidate-runner helper |
| CLONE-09 shared ctx fields | ❌ parents misnamed (Handlers, not Contexts) | ✅ (4-field subset) | safe (type-level) | **REFINE** (re-scope to `MessagesHandlers`↔`OpenAiFrontHandlers`) → `kernel/contracts.ts` |
| CLONE-10 path skeleton | ✅ | ✅ bodies; ⚠ heads/guards differ | bodies safe, guards stay | **REFINE** (extract tails/bodies only) → `routes/` shared module |
| CLONE-11 SSE extraction | ✅ | ✅ | safe | **ACCEPT** (data-line triple → existing `iterateDataPayloads` in `sse.ts`; loop pair stays per BENIGN-02) |
| CLONE-12 keystore prologue | ✅ | ✅ (preconditions differ, prologue identical) | safe | **ACCEPT** → local `openStoreForMutation` in `keystore.ts` |
| CLONE-13 limit observers | ✅ | ✅ | safe | **ACCEPT** → `context-limits.ts` (`scanStatedLimit` + `recordDeploymentCeiling`) |
| CLONE-14 dashboard branches | ✅ | ✅ (+`parseDetailQuery` extra arg) | safe | **ACCEPT** → local helpers in `dashboard-routes.ts` |
| CLONE-15 snapshot pairs | ✅ | ✅ (merge-tail last line differs) | comparator/scan safe; merge tails per-type | **REFINE** (extract comparator + minute-scan; boundedAdd triple only for merges) → `dashboard-snapshot.ts` |
| CLONE-16 gate driver | ✅ | ✅ | safe | **ACCEPT** → `delegate-gate/` shared driver (`{tsx}` flag) |
| CLONE-17 dispatch-view setup | ✅ | ✅ | safe | **ACCEPT** → local `setupDispatchCatalog` in `cli.ts` |
| CLONE-18 completion guard | ✅ | ✅ | safe | **ACCEPT** → local `assertNotCompleted` in `circuit-breaker.ts` |
| CLONE-19 print loop | ✅ (actually a triple) | ✅ | keep decoupled | **REJECT** (CONFIRM benign, see BENIGN-03) |
| CLONE-20 stream pump+tails | ✅ | ✅ (transforms differ) | safe | **ACCEPT** → `createSseTransformStream` in `sse.ts` |
| CLONE-21 guard tails | ✅ | ✅ | safe | **ACCEPT** → `validateCommonEnvelopeTail` in `accounting-store-schema.ts` |
| CLONE-22 finally+all-capped | ✅ (off-by-one tail) | ✅ | safe | **ACCEPT** → `candidate-runner.ts` |
| CLONE-23 intra-front endWalk | ⚠ both ends truncated | ✅ | safe (intra-file) | **ACCEPT** → local helper in `openai-front.ts` |
| CLONE-24a validator guard | ✅ | ⚠ "hoisted" gloss unverified | guards stay per-path | **REFINE** (extract pure body only) |
| CLONE-24b completion/logging | ✅ | ⚠ heads differ (validation- vs repair-gated) | tails safe | **REFINE** (extract success/logging tail only) |
| CLONE-25 entry validators | ✅ | ✅ (field universes differ) | prefix safe, lists stay | **REFINE** (extract shared prefix only) → `keystore.ts` |
| CLONE-26 dialect catch arms | ✅ | ❌ divergent policy (`return []` vs `continue`; kimi sides with abort 2v1) | do not merge | **REFINE** (owner-gated: parameterize policy + `detected` contract) |
| CLONE-27 ScriptKind flag | ✅ (variation is test-assertions vs other two) | ✅ | safe | **ACCEPT** (fold into P1-1) |
| SEM-01 admin failClosed | ✅ | ❌ envelopes differ (`{error:{type,message}}` vs `{type,error:{type,message}}` + guard/params) | contract risk | **REFINE** (envelope-parity test + consumer check first) |
| SEM-02 SSE pump family | ✅ all six sites | ✅ (same pump, different visitors; `iterateDataPayloads`+`BufferedSseFrames` already exist) | safe | **ACCEPT** (phased) → `sse.ts` |
| SEM-03 retry parsers | ✅ | ✅ (different domains, same output vocab) | parsers stay, consumers unify | **REFINE** (unify consumer policy via P2-5; never merge parsers) |
| SEM-04 status verdicts | ✅ all five | ⚠ different jobs; `carriesEligibilityFact` (:1515) overlaps `classifyStatus` | partial | **REFINE** (one table for status→outcome-class readers; leave event-verdict + envelope checks) |
| SEM-05 auth scatter | ✅ | ✅ (distinct surfaces, no clone) | n/a | **REJECT** (watch item, as catalogued) |
| SEM-06 cooldown arithmetic | ✅ (cap attribution: `dispatch.ts`, not exhaustion-persistence) | ✅ explicit-beats-default everywhere | safe | **ACCEPT** → `resolveCooldownMs` (floor+ceiling) in `dispatch.ts`/kernel |
| SEM-07 guard cluster | ✅ | ✅ (migrateV1 is migration, not validation) | partial | **REFINE** (combinators for validators; keep migration separate) |
| BENIGN-01 barrel | ✅ | n/a structural | n/a | **CONFIRM** |
| BENIGN-02 loop idiom | ✅ | n/a | n/a | **CONFIRM** (no third use: `:1186` site is byte-level, not the regex loop) |
| BENIGN-03 copy divergence | ✅ (triple, not pair) | n/a | keep decoupled | **CONFIRM** |
| BENIGN-04 tables | ✅ all named tables | n/a | n/a | **CONFIRM** as class |
| BENIGN-05 test policy | ✅ (`test/` holds 100+ `.test.ts`; jscpd excluded them) | n/a | n/a | **CONFIRM** |
| HOTSPOT-01 `server.ts handle` | ✅ `:412` | n/a | split admission/routing/serve | **ACCEPT** |
| HOTSPOT-02 `cli.ts` | ✅ (4483 lines vs 4484 claimed) | n/a | move, don't rewrite | **ACCEPT** |
| HOTSPOT-03 `config.ts` | ⚠ comment at `:232` says cog 124, catalog says 137 | n/a | combinators | **ACCEPT** (verify number from report) |
| HOTSPOT-04 `backend.ts` | ✅ `:442` envelope fn; `:523` preflight | n/a | table lookups | **ACCEPT** (numbers provisional) |
| HOTSPOT-05 `admin.ts` | ✅ `:253` | n/a | split switch | **ACCEPT** |
| HOTSPOT-06 `candidates.ts` | ✅ `:519` | n/a | decompose construction | **ACCEPT** (numbers provisional) |
| HOTSPOT-07 `dispatch.ts toLane` | ✅ `:742` | n/a | narrow | **REFINE** (split invoke-building vs state; verifiers already separate) |
| HOTSPOT-08 `messages.ts` | ✅ `:663`, 491 lines exact | n/a | walk phases after P1-3 | **ACCEPT** (cog provisional) |
| HOTSPOT-09 `migrateV1` | ✅ `:751` | n/a | table-driven entries | **REFINE** (keep scope-migration policy explicit) |
| HOTSPOT-10 `dashboard-snapshot.ts` | ✅ `:1454`, `:1627` (`:1751` unverified) | n/a | shared minute-scan first | **ACCEPT** |
| HOTSPOT-11 `openai-front.ts` | ✅ `:118`, 589 lines exact | n/a | walk phases after P1-3; never merge handlers | **ACCEPT** (cog provisional) |
| HOTSPOT-12 schema guards | ✅ | n/a | tail extraction first | **ACCEPT** |
| HOTSPOT-13 `accounting-store.ts` | ✅ `:1194`, `:1658` (private) | n/a | split retention from reads | **ACCEPT** (numbers provisional) |
| HOTSPOT-14 dashboard routes | ✅ `:634`, `:360` scanner | n/a | extract scanner + branch split | **ACCEPT** |
| HOTSPOT-15 circuit-breaker | ✅ (931 lines, low cog plausible) | n/a | none | **REJECT** (churn-only rank; keep small and reviewed) |

Scorecard: **ACCEPT 31** (17 clones + 2 SEM + 12 hotspots), **REFINE 15**
(9 clones + 4 SEM + 2 hotspots), **REJECT 8** (CLONE-19, SEM-05, 5 benign
CONFIRMs, HOTSPOT-15). No fabricated item; catalog errors are bounded:
misnamed parents (CLONE-09), truncated windows (CLONE-02/04/06/23), one false
"verbatim" (CLONE-04 `servedBy`), two omitted deltas (CLONE-01 fetch fn,
CLONE-07 provenance predicate), two overstated "identical" heads (CLONE-24),
one understated triple (CLONE-19/BENIGN-03), one wrong cog gloss
(HOTSPOT-03: 124 per source comment vs 137 claimed), one misattributed cap
(SEM-06: `dispatch.ts`, not exhaustion-persistence).

## 2. Detailed Adversarial Audits per Item

### Front-pair cluster (`messages.ts` ↔ `openai-front.ts`)

**CLONE-01 — Egress attempt-begin.** Ground truth: exact, drift 0
(`messages.ts:696` `onEgress: () => {` … `:710` ≡ `openai-front.ts:217`…`:234`;
`pool429.noteEgress()` :698/:219, `recordCredentialStarted` :708/:233
identical; ⚠ `beginHealthAttempt` comment :700/:221). Mechanism: the five
`onEgress` lines are verbatim, but the catalog understates the delta — the
fetch call differs (`fetchBackend({path, method, reqBuf, …})` vs
`fetchOpenAiFront({reqJson, wantsStream, protocol, …})`) plus the trailing
`protocol:` literal (`"anthropic-messages"` :714 vs conditional
`"openai-responses"/"openai-chat"` :238). Layering: body touches only generic
walk state — safe. **ACCEPT** → `candidate-runner.ts`
(`noteEgressAndBegin(...)`); scope to the `onEgress` body, not the window.

**CLONE-02 — Credential-reject.** Ground truth: core confirmed; openai end
stale — `baseLog` runs multiline `:264-:273` (`snapshot(),` :272, `));` :273),
correct end **~277**, catalog `:272` cuts mid-call. Mechanism: valid
(`recordRejected` → `CredentialConfigError` → 502 `failClosed` → 8-arg
`baseLog` → return/rethrow); deltas exactly as claimed
(`ctx.req.headers` ↔ `ctx.inboundHeaders`, packing only). Layering: pure
admission, takes headers as param — safe. **REFINE** (re-scope window) →
`candidate-runner.ts` or `routes/front-walk-shared.ts`.

**CLONE-03 — Pre-egress failure.** Ground truth: confirmed (±2 drift;
`messages.ts:779-792` ↔ `openai-front.ts:313-335`;
`controller.signal.aborted ? 504 : 502` :787/:321 verbatim). Mechanism: valid
(`!settled.ok` → `recordRejected` → destroyed-guard → abort-aware 504/502 →
ternary message → `baseLog` → return). Layering: no protocol/response handle
in window — safe. **ACCEPT** → `candidate-runner.ts` (one family with
CLONE-02).

**CLONE-04 — Transport failure + endWalk.** Ground truth: ranges overlap
CLONE-03's tail / cut mid-call (`:791` is CLONE-03's `logger.write`; oai call
runs `:358-383`, catalog ends `:360` on `h,`). Correct: `msg:794-832`,
`oai:337-385`. Mechanism: catalog's "Verbatim" is **false** — (a) protocol
literal `"anthropic"` :818 ↔ `"openai"` :361; (b) payload gap the catalog
misses — openai adds `servedBy: tried.join(", ")` (:381), messages has only
`{kind, message}`. Layering: extractable parameterized by
`(protocol, servedBy?)`; unifying `servedBy` unconditionally changes the
Anthropic-adjacent surface — keep it opt-in. **REFINE** →
`candidate-runner.ts`.

**CLONE-05 — Post-header disposition.** Ground truth: confirmed
(`inspectCandidateResponse(backendRes…)` :855 ↔ `(upstream…)` :427;
`completePostHeaderBodyFailure` :857-859/:429-431;
`credentialRecorded = true`, cancelled-return, timeout→504/502 identical).
Mechanism: `backendRes`↔`upstream` pure rename. Layering: contiguous with
CLONE-06 — one helper, not two. **ACCEPT** → `candidate-runner.ts`
(`handlePostHeaderBodyFailure`).

**CLONE-06 — endWalk continuations.** Ground truth: confirmed; heads start
mid-call (true open `messages.ts:863` / `openai-front.ts:435`;
`if (walkEnd) continue; return;` :884-885/:456-457 correct). Mechanism: valid
— protocol literal + `baseLog` packing only;
`{kind: "post-header-body-failure", …, servedBy: tried.join(", ")}` identical
*including* `servedBy` (unlike CLONE-04). **ACCEPT** → `candidate-runner.ts`
(one helper with CLONE-05).

**CLONE-07 — Probe cancelled/dead.** Ground truth: confirmed (~4 head drift;
construction `:920`/`:494`, cancelled `:928-933`/`:503-508`,
dead `:934-953`/`:509-528`). Mechanism: **partially misdescribed** — beyond
`dialectRefusalSignalOf(backendRes)`↔`(upstream)` (:924/:499): (a) probe
protocol fixed `"anthropic-messages"` (:921) vs conditional
(`:489-490`); (b) **`malformedProvenance` predicates disagree for
chat+OpenAI**: messages `:923` (`openai`→`"local"`) vs openai-front `:497-498`
(`openai`+chat→`"upstream"`). A mechanical merge silently changes
mapper-defect attribution on one front. Layering: extract only with policy
injected. **REFINE** (parameterize `protocol` + provenance; owner decision on
the predicate) → `stream-commit.ts`.

**CLONE-08 — Dead-stream endWalk.** Ground truth: confirmed (drift ≤2;
`llm-relay: ${probe.reason}` :977/:552 verbatim). Mechanism: valid —
"protocol literal only" survives (`:957`/`:532`); both carry
`upstreamReportedModel(reportedModelSource)` and
`errorType/errorOrigin/servedBy/shouldTryNext`. **ACCEPT** (parameterize
protocol) → `stream-commit.ts`/candidate-runner helper.

**CLONE-09 — Shared context fields.** Ground truth: lines touch the right
code but **both parents misnamed** — `:90-97`/`:87-94` span the **Handlers**
interfaces (`MessagesHandlers` :85, `OpenAiFrontHandlers` :84); Contexts open
at `:97`/`:94`. The 4 fields are verbatim (`isDestructive` :91/:88,
`resolveReshaper` :92/:89, `withRepairAccounting` :93/:90,
`catalog: { cachedLimits… }` :94/:91); `MessagesHandlers` has extras
(`credentialLru`, `hedgeMaxInFlight`) — shared subset is 4 fields, not the
whole interface. Mechanism: textbook superinterface case regardless.
Layering: type-level, toward `kernel/contracts.ts` — no wire edge. **REFINE**
(re-scope to Handlers) → P1-2 as catalogued.

**CLONE-22 — finally + all-capped.** Ground truth: confirmed (off-by-one;
through `msg:1152`/`oai:705`;
`respondAllCapped(res, h, { started: ctx.started, … }, "anthropic"|"openai",
pool429, …` :1151/:704). Mechanism: valid — `finally` bodies verbatim
(:1125-1146/:678-699), heads differ as claimed (transparent dispatch :1122 vs
audit-log + return :653-676). Layering: settlement infra already centralized
in `candidate-runner.ts` — extract `settleWalkFinally`, not the heads.
**ACCEPT** → `candidate-runner.ts`.

**CLONE-23 — Intra-front endWalk variants.** Ground truth: call-shape clone
confirmed; both ends truncated (calls `:358-383` and `:435-455`; catalog
`:379`/`:449` cut inside payloads). Mechanism: valid — same
`endWalk(h, res, "openai", …, () => baseLog(8 args), {kind, message,
servedBy})`; deltas exactly as claimed (kind + multiline vs single-line
packing; status derivation upstream of window, correctly out of scope).
Layering: within-file, single protocol — safest in catalog. **ACCEPT** →
local helper in `openai-front.ts` parameterized by `(status, kind, message)`.

**CLONE-24a/b — Guard + packing variants.** (a) Confirmed
(`ctx.willValidate && assistant` :234 vs `overflow/buffering` + nested
`assistant` :397-400) but the "willValidate hoisted to caller" gloss is
**unverified/misleading** — repair paths never mention `willValidate`; they
validate unconditionally-when-buffered. Preconditions differ semantically.
**REFINE**: extract pure `validateAssistant` body only. (b) `logStatus`
delta real (conditional spread :253 vs literal :460) but **heads differ
materially** (validation-gated :248 vs repair-outcome-gated :452-455); only
success + `logger.write` tails shared. **REFINE**: extract tail only. Guards
stay per-path (transparent-vs-repair policy).

**HOTSPOT-08/11 — The front pair.** Structurally exact:
`anthropicMessagesPath` :663 → end :1153 = 491 lines;
`openAiFrontPath` :118 → end :706 = 589 lines; companions
`transparentPath` :174 / `repairStreamingPath` :292 / `repairBufferedPath`
:484 present. Walk body `:681-1148` is one resolve→race→commit→settle loop;
OpenAI-only code (`:603-614` normalization, `normalizeOpenAiErrorBody`,
`:146-206` repair-audit path) has no Anthropic counterpart — never merge
handlers. **ACCEPT** both (cog 197/196 provisional).

### Within-file Type 2 families

**CLONE-10 — Path skeleton.** Confirmed: `finally{clearTimeout}` +
destroyed-guard + validated-init (:224-240 ↔ :385-394); http-failure block
(:241-247 ↔ :445-451); `repair(assistant, ctx.tools, {validator, reshaper,
maxAttempts, isDestructive, backendModel, signal})` verbatim (:423-430 ↔
:556-563); success + `baseLog` tails match. But heads/guards diverge per
CLONE-24, and `repairBufferedPath`'s failure tail adds a `logStatus:
"dead-turn"` conditional (:596) vs literal `"committed"` (:460).
**REFINE**: extract finally/init, http-failure, `repair()` call, and
success tails; heads, guards, and failure-status mapping stay per-path →
`routes/` shared module.

**CLONE-11 — SSE extraction.** Confirmed: boundary-split loop verbatim
(`:534-544` in `captureCompleteEvents` ↔ `:643-654` inline); `data:`-line
split/filter/map/join/trim at `:585-590` (`inspectEvent`), `:604-610`
(`captureEventModel`), `:1209-1215` (`suppressRelayAddedOpenAiUsageFrames`),
differing only in tails (`[DONE]` guard, bare `return` vs `return false` vs
usage-shape check). **ACCEPT**: loop pair stays inline per BENIGN-02; the
data-line triple adopts the **already-existing** `iterateDataPayloads` in
`sse.ts` (used by `reconstructFromSse` :55).

**CLONE-12 — Keystore prologue.** Confirmed verbatim modulo formatting
(`:1070-1081` ↔ `:1391-1400`: `resolveKeystorePath → loadStore →
refuseMutation → cloneStoreForMutation → duplicate guard →
createStore/unlockStoreForWrite`). Preconditions differ (identity/value/expiry
validation vs `validExportEntry` first) — correctly outside the window.
**ACCEPT** → local `openStoreForMutation(opts)` in `keystore.ts`.

**CLONE-13 — Limit observers.** Confirmed: scan loops verbatim modulo table
(`:83-89` ↔ `:175-181`, incl. 8192 bound); `recordFact` writes verbatim
modulo fact name (`:109-113` ↔ `:201-205`). Cleanest in catalog.
**ACCEPT** → `scanStatedLimit(text, patterns)` + `recordDeploymentCeiling`
in `context-limits.ts`.

**CLONE-14 — Dashboard branches.** Confirmed: snapshot/detail dispatch
(`:683-688` ↔ `:705-710`) modulo `parseDetailQuery`'s extra `requestId` arg;
`isAuthFailure` → 409/401 → 500 + catch tails verbatim (`:743-750` ↔
`:793-800`). **ACCEPT** → local parse-dispatch wrapper + `authFailure()`
mapper in `dashboard-routes.ts`.

**CLONE-15 — Snapshot pairs.** Confirmed: comparator verbatim (`:916-921` ↔
`:1179-1184`); minute-scan + `noteAccountingCoverage` payload verbatim modulo
nesting (`:1474-1499` ↔ `:1667-1682`); merge heads match through the
`boundedAdd` triple (`:385-389` ↔ `:444-448`) but **last lines differ by
schema** (`overflow` :390 vs `samplesDropped` :449). **REFINE**: extract
comparator + minute-scan/coverage; for merges extract only the
seen/boundedAdd triple, keep type tails.

**CLONE-21 — Guard tails.** Confirmed: shared tail `isNullableCounter`×2 +
`isNullableId`×3 + `isAggregateTokens` + spend check (`:1091-1097` ↔
`:1162-1168`); heads (`attribution` vs `commitAttemptId` + request extras)
differ. **ACCEPT** → `validateCommonEnvelopeTail` in
`accounting-store-schema.ts`.

### Gate / CLI / stream clones

**CLONE-16 — Gate driver.** Confirmed: prelude
`readOriginal → reconstructPostImage → addedLines → join → createSourceFile`
identical in `cast-necessity.ts:80-88` (`findingsForFile`),
`:125-133` (`castEditsForFile`), `shared-state.ts:119-127`, and
`test-assertions.ts:252-258` modulo the ScriptKind expr; file-loop drivers
(`:104-112` ↔ `:159-167`) differ by function name only.
**ACCEPT** → shared `findingPreamble(file, path, readOriginal, {tsx})` +
`runFileAnalyzer` in `delegate-gate/` (with CLONE-27's flag).

**CLONE-27 — ScriptKind flag.** Confirmed: `path.endsWith(".tsx") ?
TSX : TS` (`cast-necessity.ts:86`, `shared-state.ts:125`) vs plain `TS`
(`test-assertions.ts:258`). The variation is test-assertions-vs-other-two, as
implied. **ACCEPT** (fold into P1-1).

**CLONE-17 — Dispatch-view setup.** Confirmed: `ModelCatalog` + try/catch
`materializeDynamicPools` + `contextWindowResolver` at `:2486-2496` ↔
`:2653-2663`; comments reworded, `qs` construction differs (task-in-query ban
:2477-2480 vs host-routing params :2644-2651). **ACCEPT** → local
`setupDispatchCatalog(cfg)` in `cli.ts`.

**CLONE-18 — Completion guard.** Confirmed verbatim modulo target
(`getAttemptRecord → completedId duplicate-completion` :377-383 ↔ :416-422;
`observation.target` ↔ `outcome.target` downstream). **ACCEPT** → local
`assertNotCompleted` in `circuit-breaker.ts`.

**CLONE-19 / BENIGN-03 — Print loop.** Confirmed, and it is a **triple**:
free `:81-88` ↔ mixed `:91-98` ↔ subscription `:101-108`; bodies identical
except CTA copy (plus `Pooled`/`Not Configured` tags in the third). Keeps its
benign status — copy stays independently editable — but the record should say
triple. **REJECT** extraction; **CONFIRM** benign.

**CLONE-20 — Stream pump + tails.** Confirmed: pump
(`reader.read/frames.append/processFrames` :192-199 ↔ :228-233) and tails
(`flushHeld/takeRemainder` + identical `event: error` frame +
`controller.close()` :200-214 ↔ :234-248); transforms above differ
(`ThinkTagStripFilter.push` vs `rewriteOne`, incl. separator-preserving push
:221-225). Error contracts match (release-held-before-report; tool-use-ids
names the contract explicitly at :239-240). **ACCEPT** →
`createSseTransformStream({processFrames,…})` in `sse.ts`; the two functions
supply transforms only.

### Type 3 gapped clones

**CLONE-25 — Entry validators.** Confirmed: same
`parseCredentialId` + provider/envName/ciphertext shape; field universes
differ — stored key list ends `"revokedAt","disabled"` (:345-358) with
ct/iv/tag/fingerprint + timestamp tails, export list ends
`"revokedAt","disabled","value"` (:1245-1248) with
`disabled:boolean` + `value` tails. **REFINE**: extract the shared
id/provider/envName prefix only; key lists and tails stay per-validator →
`keystore.ts`.

**CLONE-26 — Dialect catch arms.** Confirmed: guard chains match modulo
regex; catch arms diverge — `fromDeepSeekForm` :274 `{ return []; }` (abort)
vs `fromTaggedJsonForms` :321 `{ continue; }` (skip); `fromKimiTokenForm`
(:293, :298-299) sides with abort, 2v1. The catalog's `continue` +
`detected`-to-caller recommendation is a product call, explicitly not
proposed. **REFINE** (owner-gated: parameterize the policy, then unify) —
not a Phase 4 candidate until decided.

### Semantic findings

**SEM-01 — Admin `failClosed` shadow.** Confirmed, and the catalog
understates the gap: admin `:174-177` emits `{ error: { type: "error",
message } }` with no headersSent guard; shared `stream-pipeline.ts:162-181`
emits `{ type: "error", error: { type: errorType, message } }` (top-level
`type` extra, inner default `"api_error"` vs `"error"`), plus headersSent
guard and `extraHeaders`/`errorType` params. Swapping changes the admin wire
shape. **REFINE**: contract test + consumer check for envelope parity first,
then replace (catalog P1-5's own precondition).

**SEM-02 — SSE pump family.** All six sites confirmed (`sse.ts:47`,
`backend.ts:523`, `backend.ts:1186`, `dialect-stream.ts:35`,
`openai-dialect.ts:246`, CLONE-20 pair); `iterateDataPayloads` and
`BufferedSseFrames` already exist and are already shared by four of the six
— the codebase is halfway there. **ACCEPT** phased: (1) backend `data:` sites
adopt `iterateDataPayloads` (CLONE-11); (2) one transform scaffold for the
stream wrappers → `sse.ts`. The three cog-75+ members get frame visitors per
P2-3.

**SEM-03 — Retry parsers.** Confirmed: `parseRetryAfterMs` :317 parses RFC
9110 headers (delta-seconds/HTTP-date, past/unparseable → null, never 0);
`statedRetryAfterMs` :130 parses prose with closed `RETRY_UNIT_MS` :122-127,
capped by `MAX_EXHAUSTED_MS` (imported from `dispatch.ts` :24). Same `ms |
null` output into `retryAfterMs` verdicts. **REFINE**: keep both parsers
(reject any parser merge); unify the consumer ceiling/type via P2-5.

**SEM-04 — Status verdicts.** All five confirmed, but they do different jobs:
`classifyStatus` :1121 (outcome class), `resolveReset` :1496
(header→field→generic→fixed precedence), `openAiResponsesVerdict` :217
(stream-event verdicts), `statusForQueryError` :575 (400/413→query code,
trivial), `invalidEnvelopeReason` :442 (envelope *shape* validation, cyclo
44). Plus a sixth the catalog missed: `carriesEligibilityFact` :1515
(400/401/402/403/404/410/429) overlaps `classifyStatus`'s retriable set with
different membership. **REFINE**: one status→outcome-class table for
`classifyStatus` + `carriesEligibilityFact` + `resolveReset`'s status arm;
leave event verdicts and envelope validation alone.

**SEM-05 — Auth scatter.** Confirmed: `parseAuthHeader` :847 is a one-line
strict matcher with two call sites (:1281, :1988, provider auth-header
resolution); `validateSession` (`dashboard-routes.ts:606`) is session/token
validation; `control-authorization.ts` + `dashboard-auth.ts` (exists; TTL
logic :248/:307) serve other surfaces. No verbatim clone, distinct jobs.
**REJECT** (watch item, as catalogued).

**SEM-06 — Cooldown arithmetic.** Confirmed at all sites: doc + defaults
(`dispatch.ts:45-51`), `lane-cadence.ts:192` (`?? OUTCOME_DEFAULT_MS`),
`circuit-breaker.ts:607-613` (MIN/MAX clamp),
`target-facts.ts:401-407` (stated>0 gate + basis binding),
`normalizeTtl` :274-276 + restore clamp :373 + write clamp :384, probe cap
(`lane-quota-probe.ts:137`), `IGNORED_TTL_MS` (`refusal-interpretation.ts:186`),
30d FACT_TTL (`target-facts.ts:157-162`). Attribution fix: the 30-day cap
lives in `dispatch.ts` `MAX_EXHAUSTED_MS` (:39); the grep shows no own cap in
`dispatch-exhaustion-persistence.ts` (load/save/install only) — it inherits
via `normalizeTtl`/restore clamps. **ACCEPT** → `resolveCooldownMs(explicit,
outcome, caps)` carrying floor *and* ceiling, in `dispatch.ts` or kernel.

**SEM-07 — Guard cluster.** Confirmed: `isRequestPacket` :1125,
`isAggregateFields` :779 (with growth-checklist comment :842), `migrateV1`
:751 (v1→v2 scope requeue, provider→pending/group→credential:"attempt").
`migrateV1` is versioned-shape *migration*, not validation — out of scope for
guard combinators. **REFINE**: combinator field validators for the next packet
type (with CLONE-21's tail as first combinator); keep migration logic
explicit per HOTSPOT-09.

### Benign ledger + hotspots

BENIGN-01 **CONFIRM** (`:22-54` ↔ `:58-90` mirrored barrel, language-structural).
BENIGN-02 **CONFIRM** (loop twice in one function; no third use — `:1186`
is byte-level `frameEnd`, not the regex loop).
BENIGN-03 **CONFIRM** (triple; copy decoupled deliberately).
BENIGN-04 **CONFIRM** as class (all tables greppable single-homes).
BENIGN-05 **CONFIRM** (`test/` holds 100+ `.test.ts`; exclusion real).

HOTSPOT-01 **ACCEPT** (`handle` :412; split admission/routing/serve).
HOTSPOT-02 **ACCEPT** (4483 lines on disk vs 4484 claimed — immaterial;
move per-command modules, don't rewrite). HOTSPOT-03 **ACCEPT** with erratum:
source comment `:232` says cog 124, catalog says 137 — re-read from
`complexity-report.json` before sizing. HOTSPOT-04 **ACCEPT** (numbers
provisional; `invalidEnvelopeReason` visibly the status-mapping spike).
HOTSPOT-05 **ACCEPT** (`:253`, 530-line file → 278-line fn plausible; split
switch). HOTSPOT-06 **ACCEPT** (`:519` confirmed; numbers provisional).
HOTSPOT-07 **REFINE** (`toLane` :742 confirmed; verifiers already separate —
split invoke-building vs state only). HOTSPOT-09 **REFINE** (table-driven
entry validators; scope-migration policy stays explicit). HOTSPOT-10
**ACCEPT** (`:1454`, `:1627` confirmed; `:1751` readSnapshot unverified —
check before sizing). HOTSPOT-12 **ACCEPT** (via CLONE-21 first). HOTSPOT-13
**ACCEPT** (`usedInWindow` :1194, private `commitRetention` :1658 confirmed;
numbers provisional). HOTSPOT-14 **ACCEPT** (extract `scanJsonValue` :360 to a
shared JSON util — it is not route logic — then branch-split per CLONE-14).
HOTSPOT-15 **REJECT** (churn-only; process risk, keep small and reviewed).

## 3. Final Filtered Candidate Roster for Phase 4

Advancing: all ACCEPT + all REFINE except owner-gated CLONE-26 (34 entries).
Priority follows the catalog's P1/P2 with layering corrections from §2.

**Tier 1 — standalone specs, no owner decision needed (ACCEPT):**
P1-1 gate driver (CLONE-16 + CLONE-27) → `delegate-gate/`; P1-2
superinterface (CLONE-09 re-scoped to Handlers) → `kernel/contracts.ts`; P1-3
front-walk helpers (CLONE-01/03/05/06/08/22 + CLONE-23 local) →
`candidate-runner.ts` (+ `stream-commit.ts` for probe tails, local helper in
`openai-front.ts`); P1-4 SSE scaffold (CLONE-20 + SEM-02 phase 2) → `sse.ts`;
P1-6 limit observers (CLONE-13) → `context-limits.ts`; P1-7 envelope tail
(CLONE-21 + SEM-07 validators) → `accounting-store-schema.ts`; keystore
prologue (CLONE-12) → `keystore.ts`; dispatch-view setup (CLONE-17) →
`cli.ts`; completion guard (CLONE-18) → `circuit-breaker.ts`; SSE data-line
adoption (CLONE-11) → `sse.ts iterateDataPayloads`; dashboard branches
(CLONE-14) → `dashboard-routes.ts`; cooldown policy (SEM-06) →
`resolveCooldownMs`; hotspot decompositions HOTSPOT-01/02/04/05/06/10/12/13/14
(each referencing its clone extraction as step 1).

**Tier 2 — specs with re-scoping constraints (REFINE):** CLONE-02 (re-scope
window), CLONE-04 (`servedBy` opt-in), CLONE-07 (provenance predicate —
needs owner ruling before unification), CLONE-10 (tails/bodies only),
CLONE-15 (comparator/scan now, merge tails per-type), CLONE-24a/b (bodies
only), CLONE-25 (prefix only), SEM-01 (envelope-parity test first), SEM-03
(consumers only), SEM-04 (outcome-class table only + reconcile
`carriesEligibilityFact`), HOTSPOT-03 (confirm cog 124 vs 137 first),
HOTSPOT-07/09 (narrow splits).

**Gated — do not spec until decided:** CLONE-26 (abort-vs-skip product call;
2v1 for abort today).

**Dropped:** CLONE-19, SEM-05, BENIGN-01–05, HOTSPOT-15.

Cross-cutting constraints for Phase 4: (1) never merge front control flow —
wire-compat isolation is load-bearing (CLONE-07 proves the surfaces already
diverge); share leaf choreography only; (2) P2-3/P2-4 shared modules land in
`kernel/` or beside `stream-pipeline.ts`, never in either front; (3) every
REFINE extraction keeps the divergent head/guard/policy in place and takes
only the verified-shared subset.

*Phase 3 generated 2026-09-05 by direct source inspection. Scorecard:
ACCEPT 31 / REFINE 15 / REJECT 8 (of 54 adjudicated entries, CLONE-19
dual-listed). Catalog errata filed in §1 scorecard paragraph and per-item
notes above.*
