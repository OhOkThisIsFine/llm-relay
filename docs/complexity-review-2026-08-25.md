# Complexity and elegance review — 2026-08-25

## What this is

A sweep of `src/` (~46k lines, 60 modules) for code that is more complicated than the problem it
solves, and for places where a smaller shape would do the same work.

Method, in order:

1. Structural query of the codebase knowledge graph for complexity hotspots, duplication candidates
   (`SIMILAR_TO`), call cycles, dead code, and parameter-count outliers.
2. Eight parallel reviewers reading source, one per area, each briefed with this repository's
   invariants and with the pre-rejected refactors from
   [docs/suggestion-review-2026-08-04.md](suggestion-review-2026-08-04.md).
3. Adversarial verification of each finding against the source.

**Read this before acting on it.** Step 3 did not complete — the review run stopped on an account
spend limit after the reviewers finished and before the verifiers did. Seven findings were then
verified by hand and are marked VERIFIED below. Eighteen more are recorded in
[§5](#5-recorded-but-not-verified) exactly as reported, **unverified**. Do not treat that section as
a to-do list. This repository has been burned before by a 676-finding report where only six items
were checked against source ([CLAUDE.md](../CLAUDE.md), "Status & open work").

Headline: one reproducible correctness defect, five confirmed duplications, and no dead code
anywhere else in `src/`.

## 1. Summary

| # | Finding | Site | Kind | Delta | Risk |
|---|---|---|---|---|---|
| 1 | Dialect rescue emits two `finish_reason`s, dropping the rescued tool call — **FIXED 2026-08-25** | `src/openai-dialect.ts` | correctness | +16 (landed) | low |
| 2 | Seven walk-exhaustion exits hand-copied across the two fronts — **FIXED 2026-08-25** | `src/server.ts` (6 sites) | duplication | +160 (landed; forecast ~-150 — one owner for the five never-diverge behaviors, not lines) | medium |
| 3 | Four SSE boundary detectors, two of which disagree — **FIXED 2026-08-25** | 4 modules | duplication + drift | -33 (landed; five detectors, three semantics — see the section) | low |
| 4 | 35 exported bindings with zero callers — **FIXED 2026-08-25** | `src/accounting-store-schema.ts` | dead code | ~-75 (landed) | low |
| 5 | `isRecord` defined 12 times; exact-keys helper 8 times, 3 signatures — **FIXED 2026-08-25** | 20 sites | duplication | ~-60 (landed) | low |
| 6 | Quota-bucket gathering written three times — **FIXED 2026-08-26** | 3 modules | duplication | -11 (landed; forecast ~-45) | medium |
| 7 | The `/cooldowns/clear` wire shape validated twice by hand — **FIXED 2026-08-25** | `src/cli.ts`, `src/keys-cli.ts` | duplication | -8 (landed; forecast ~-75 — the narrowed path needed its own branches, so the win is one owner, not lines) | low |

Nothing here proposes splitting `server.ts` or `config.ts` into modules. That refactor is already
rejected, and none of these findings need it.

## 2. The one defect

### 1. Dialect rescue emits `finish_reason` twice, and the client keeps the first — VERIFIED; FIXED 2026-08-25

**Site:** `src/openai-dialect.ts`, inside `recoverDialectInOpenAiChatStream`'s `processEvent`.
Supporting shapes: `withoutContent` and `recoveredEvents`. (All line references in this section are
to the PRE-FIX source at `05e2408`; the defect description below is kept as the record of what was
wrong.)

**What happens now.** When a chunk closes a choice, the code removes that choice from the outgoing
chunk so the recovered `tool_calls` can carry the terminal `finish_reason` instead:

```ts
const outputIndex = outputChoices.indexOf(rawChoice);
if (outputIndex >= 0) outputChoices.splice(outputIndex, 1);
```

`outputChoices` does not hold `rawChoice`. Whenever the chunk carried content, the code pushed a
**derived** object — `withContent(rawChoice, safe)` or `withoutContent(rawChoice)` — so
`indexOf(rawChoice)` returns `-1` and the splice is a no-op. `withoutContent` deliberately preserves
`finish_reason` (`hasFinish` keeps the choice alive), so the upstream `finish_reason` is emitted, and
then `recoveredEvents` emits a second one.

**Precondition.** The tool-call envelope must span at least two content deltas, and the last of those
deltas must carry `finish_reason` in the same chunk. That is an ordinary provider streaming shape.

**Reproduced.** Feeding `role` chunk, `content: head`, then `content: tail` with `finish_reason:
"stop"` in one chunk produces this wire output:

```
data: {... "delta":{},"finish_reason":"stop"}
data: {... "delta":{"tool_calls":[{"index":0,...,"function":{"name":"write_note",...}}]},"finish_reason":null}
data: {... "delta":{},"finish_reason":"tool_calls"}
```

An OpenAI Chat client closes the choice at the first `finish_reason` and discards what follows. The
rescued tool call is dropped and the turn reads as an empty assistant message — precisely the failure
mode dialect rescue exists to prevent.

**Why the suite misses it.** Every fixture in
[test/openai-dialect-passthrough.test.ts](../test/openai-dialect-passthrough.test.ts) terminates with
`const STOP = chatChunk({}, "stop")` — a **content-free** stop chunk (line 85). In that shape the
`else if (!state.finished)` branch pushes `rawChoice` itself, so `indexOf` succeeds and the splice
works. The suite only ever exercises the branch that happens to be correct.

**Proposed shape.** Stop identifying the choice by object identity. Track the output slot, or mark
the settled choice and filter afterwards:

```ts
const slot = outputChoices.length - 1;          // recorded when the choice was pushed
if (wasCapturing && slot >= 0) outputChoices.splice(slot, 1);
```

A positional slot cannot be defeated by rebuilding the object, which is exactly what the surrounding
code does on every content path. Roughly +3 lines, plus a pinning test that combines content with
`finish_reason` in one chunk.

**Invariants checked.** No change to what is recovered or refused; the destructive-refusal path
(`settleChoice` → `recoverToolCalls` → `refused-destructive`) is untouched, and the relay still
never invents a tool call. Byte-exactness does not apply — this lane is already rewriting the stream.

A runnable reproduction is saved outside the repository at
`…/scratchpad/finishreason-repro.test.ts`; it belongs in `test/` as a pinning test if this is fixed.
(Superseded: the fix landed with pinning tests — see the Resolution below.)

**Resolution, 2026-08-25.** `processEvent` now records the output slot for each choice on every push
and resets it for every `rawChoice`. When settlement supersedes an upstream finish, the slot is
rewritten with `finish_reason: null` if its delta still carries content or another key; only an
empty-delta shell is removed. This preserves the safe prefix when a marker and finish land together,
while the existing content-free `STOP` shape keeps its prior wire output. The recovered `tool_calls`
delta is followed by exactly one terminal `finish_reason: "tool_calls"`.

The two adjacent hazards were both reachable and are fixed in the same change:

- A finish-bearing settle with trailing prose produces non-empty `recovered.text` after
  `stripEnvelopes`; `recoveredEvents` used to copy the upstream `"stop"` onto that prose event.
  Recovered prose now explicitly carries `finish_reason: null`.
- A final suffix such as `｜DSML` is a proper prefix of a marker, so `scanForMarker` withholds it
  (`safeLen < text.length`) without entering capture. The safe-text choice used to retain the
  finish, while `settleChoice` generated the tail before it with a second finish. The outgoing slot
  now has its finish stripped and the generated tail is emitted after the safe text, retaining the
  choice's sole `"stop"` on the last event.

`test/openai-dialect-passthrough.test.ts` pins all three shapes, including tool-call-before-terminal
ordering and prefix-before-tail order, plus (added in adversarial review) the non-capturing splice
of an empty finish shell and per-choice slot independence in a two-choice chunk. No existing assertion pinned the broken shape.
`src/dialect-stream.ts` needed no change: it does not search an output array by identity; capture
suppresses upstream `message_delta` / `message_stop`, `finish()` emits one relay-authored tail, and
its `finished` guard prevents the `message_stop` plus end-of-stream paths from emitting that tail
twice.

Final gate:

```text
Test Files 108 passed (108)
Tests 2281 passed | 5 skipped (2286)
Test Files 5 passed (5)
Tests 32 passed (32)
{"assets":2,"dashboardFiles":5,"dashboardRawBytes":254345,"jsBytes":240447,"cssBytes":12674,"htmlBytes":383,"manifestBytes":185,"packBytes":1000759,"unpackedBytes":4844747,"packageEntries":284}
packed dashboard smoke passed: llm-relay-0.47.0.tgz
```

Deliberately not done: no `dialect-stream.ts` edit — it does not share the defect class (no
identity lookup; capture suppresses the upstream terminal events; a `finished` guard covers the
double-settle paths). Reviewed adversarially (fresh-context native Opus, verdict MERGE): the
reviewer reconstructed the pre-fix code and measured all three pinned shapes failing on it.

## 3. Confirmed duplication

### 2. Seven walk-exhaustion exits, hand-copied across the two fronts — VERIFIED; FIXED 2026-08-25

**Sites:** [src/server.ts](../src/server.ts) — `handle` at lines 1476-1500, 1512-1546, 1600-1651,
1714-1750; `openAiFrontPath` at 3526-3563, 3579-3607, 3677-3713.

Each site does the same four things in the same order: try the next uncapped attempt and `continue`
on success; call `pool429.recordFinal(status)`; assemble announcement headers (sticky provenance,
credential trace, pool-attempts summary); log with the same eight arguments. The first twelve lines
of the 1476 and 3526 sites are byte-identical.

The only genuine difference is the error body. `handle` calls `failClosed(...)` with the Anthropic
shape; `openAiFrontPath` writes an OpenAI-shaped body itself and adds `content-type` and
`SERVED_BY_HEADER`. That difference is the front's identity — everything around it is not.

Measured repetition: `nextUncappedAttempt(h, credentialWalk, attemptTrace, pool429)` appears at 11
call sites; `pool429.recordFinal(...)` at 10; and this exact pair

```ts
const summary = pool429.summary();
if (summary) headers[POOL_ATTEMPTS_HEADER] = summary;
```

appears six times — lines 1487, 1523, 1626, 3539, 3591, 3695.

**Proposed shape.** One `endWalk(...)` helper taking the front's error emitter as a callback. The
seam already exists and already works: line 2175 performs this same header assembly inside a factored
helper. Six sites would adopt what one site already proves.

**Why this matters beyond line count.** [CLAUDE.md](../CLAUDE.md) records the pool-failover incident
in exactly this shape: two paths, two policies, one of them empty. Hand-copied exhaustion handling is
how the next divergence gets in. Roughly -150 lines.

**Invariants checked.** This removes duplicated logic, which is the one kind of `server.ts` change the
pre-rejected refactor does not cover. Header content, log fields, and the rule that the served body
stays the last candidate's real upstream error are all preserved, because the callback keeps each
front's body shape verbatim.

**Resolution, 2026-08-25.** The six regular exits now pass exit data to `endWalk`, which owns walk
advancement, unconditional final recording, native-front error emission, and the shared
`walkExitHeaders` policy. The seventh repair-failure holdout uses `walkExitHeaders` without entering
`endWalk`, because its dead-turn accounting intentionally differs.

**Recorded residue:** `handle`'s transport-failure exit still emits no `SERVED_BY_HEADER`, while the
OpenAI front's twin does; this predates the refactor and is now a one-line `servedBy` follow-up. The
dead-stream exits also preserve their prior liveness spellings: `handle` uses `!res.destroyed`, while
the OpenAI front uses `!res.writableEnded && !res.destroyed`. One deliberate hardening beyond
parity, from the delta re-check: the OpenAI dead-stream emission now sits behind a
`!res.headersSent` guard the old inline site lacked (unreachable pre-commit; matches the sibling
OpenAI exits), and the helper forces the finalize path when the response died mid-walk even with a
next candidate in hand — the pre-refactor shape, kept explicit so a relaxed caller guard cannot
turn it into a silent walk-on.

### 3. Four SSE boundary detectors, and two of them disagree — VERIFIED; FIXED 2026-08-25

**Sites:** `firstBoundary` at [src/openai-dialect.ts:153](../src/openai-dialect.ts#L153) and
[src/stream-commit.ts:301](../src/stream-commit.ts#L301); `eventSeparator` at
[src/think-tags.ts:136](../src/think-tags.ts#L136) and
[src/tool-use-ids.ts:153](../src/tool-use-ids.ts#L153). Three modules additionally define their own
`parseEvent` — `dialect-stream.ts:30`, `openai-dialect.ts:158`, `think-tags.ts:120`.

The two `firstBoundary` copies are byte-identical to each other; so are the two `eventSeparator`
copies. But the two families do not implement the same rule. `firstBoundary` matches the regular
expression for an optional carriage return before each newline, so it accepts a mixed terminator and
reports its true length. `eventSeparator` runs two separate `indexOf` scans and recognises only a
pure two-character or pure four-character boundary.

On a mixed boundary — carriage return, newline, newline — `firstBoundary` reports a three-character
separator, while `eventSeparator` reports position 1 with length 2 and leaves a stray carriage return
at the head of the next frame. Four definitions, two semantics, already divergent. The practical blast
radius is small, because providers are consistent about line endings. But this is the drift pattern
[CLAUDE.md](../CLAUDE.md) names for `factResetInputs`: two implementations is how one cell comes to
read one provenance on one surface and another on the other.

**Implemented shape.** One small `sse-frames.ts` exports the boundary rule and a buffered frame
iterator. Each of the five stream modules keeps only its own policy: `think-tags` keeps its rollback
buffer, `stream-commit` its commit classification, `tool-use-ids` its id minting, and the two dialect
modules their envelope capture. No new dependency, and one definition of where an SSE event ends.

**Invariants checked.** Byte-exactness obligations are per-module and unaffected — the shared
primitive reports offsets, it does not rewrite bytes.

`findSseBoundary` now reports the exact separator string, `BufferedSseFrames` owns chunk-spanning
iteration, and `sseEventFields` extracts raw field values for caller-owned parsing policy. A
`\r\n\n` regression in `test/sse-frames.test.ts` pins clean frame strings with no leaked carriage
return; `test/tool-use-ids.test.ts` additionally pins the former divergent path while it rewrites an
event.

**Corrections from the adversarial review of the fix (2026-08-25).** The finding undercounted:
there were FIVE detectors carrying THREE semantics, not four carrying two. `dialect-stream.ts`'s
inline `indexOf("\n\n")` was a third rule — pure LF only — and, combined with never flushing its
leftover buffer at end of stream, it swallowed a CRLF-terminated upstream WHOLE: measured against
the pre-fix source, a `\r\n\r\n` stream produced an EMPTY output stream. Unreachable today
(llm-bridge's Anthropic emitter hardcodes `\n\n`), so latent, not shipped — but one dependency bump
from live; the adoption fixes it and `test/dialect-stream.test.ts` now pins CRLF passthrough.
The differential harness measured ~31,000 old-vs-new comparisons across the five modules with
zero unintended byte differences. **Residue, stated:** `server.ts` `frameEnd` keeps its own
byte-level `Buffer` scan on purpose (multibyte UTF-8 must never split mid-frame) and still carries
the pure-terminator semantics; `sse.ts` and `usage-observer.ts` keep internal field parsers; both
join `backend.ts`'s parsers under finding 13's deferral.

### 4. Thirty-five exported bindings with no callers — VERIFIED

**Site:** [src/accounting-store-schema.ts](../src/accounting-store-schema.ts) — the export tail at
lines 1482-1491 and the block at 1242-1315.

All 22 short aliases are unused. The comment above them says short aliases make the codec convenient
in the store; the store never imports one. Zero references in `src/` and zero in `test/`:
`isAggregateTokenTotals`, `isMetricCell`, `isAccountingAggregate`, `isAccountingAggregateRow`,
`isAccountingCoverage`, `isAccountingDay`, `isAccountingLifetime`, `isAccountingRecent`,
`isAccountingDetailPacket`, and all 13 `parseAccounting*` short forms.

A further 13 version-suffixed exports also have zero external references:
`isAccountingCoverageV1`, `isAccountingEstimatedTokenCellV1`, `isAccountingMinuteShardV1`,
`isAccountingMonthAggregateV1`, `parseAccountingAggregateTokenTotalsV1`, `parseAccountingAggregateV1`,
`parseAccountingCompletedRequestDedupV1`, `parseAccountingCoverageV1`,
`parseAccountingDimensionRowV1`, `parseAccountingEstimatedTokenCellV1`,
`parseAccountingMetricCellV1`, `parseAccountingMinuteShardV1`, `parseAccountingMonthAggregateV1`.

`package.json` declares no `main`, no `types` and no `exports` map — only `bin`. There is no library
surface, so no external consumer can depend on these. They are dead, not public.

**Caution.** Delete the exported bindings, not the internal guards they delegate to. The
`parseAccounting*V1` wrappers call internal predicates such as `isDay` and `isRecent` that remain
load-bearing. Roughly -75 lines.

### 5. `isRecord` twelve times, exact-keys eight times, three signatures — VERIFIED

`isRecord` is defined independently in twelve modules: `accounting-store-io.ts:227`, `backend.ts:351`,
`cli.ts:876`, `dashboard-contract.ts:653`, `dashboard-routes.ts:187`, `dashboard-static.ts:110`,
`keys-cli.ts:573`, `openai-dialect.ts:25`, `openai-request.ts:238`, `responses-request.ts:82`,
`stream-commit.ts:55`, `tool-use-ids.ts:35`.

The exact-keys predicate is defined eight times, and unlike `isRecord` the copies are not equivalent.
Three different contracts share two names:

| Sites | Parameter | Returns |
|---|---|---|
| `accounting-store-schema.ts:429`, `dashboard-routes.ts:191` | `unknown` | type guard |
| `accounting-store-io.ts:231` (`isExactRecord`) | `unknown` | type guard |
| `cli.ts:880`, `keys-cli.ts:577`, `refusal-interpretation.ts:562`, `target-facts.ts:151` | already-narrowed record | plain boolean |
| `keystore.ts:300` | record, plus required and optional key lists | plain boolean |

A reader who learns `hasExactKeys` in one module and meets it in another is reading a different
function under the same name. That is the real cost, more than the roughly 60 duplicated lines.

**Proposed shape.** One small `json-shape.ts` exporting `isRecord`, `hasExactKeys` in guard form, and
`hasExactKeysWithOptional`. Mechanical, no behaviour change, and it retires a naming trap.

### 6. Quota-bucket gathering written three times — VERIFIED; FIXED 2026-08-26

**Sites:** [src/availability-snapshot.ts:106](../src/availability-snapshot.ts#L106),
[src/candidates.ts:390](../src/candidates.ts#L390) and
[src/quota-demotion.ts:95](../src/quota-demotion.ts#L95) — three private `bucketFor` closures, each
followed by its own copy of the same three population loops: provider-stated observations, learned
ceilings, then configured ceilings through `CONFIGURED_LIMIT_AXES` and `configuredLimitQuotaShape`.

The population loops are near-identical. The differences that exist are real and must be preserved:

1. `quota-demotion` gates learned ceilings behind `routing.quota.enforceLearned`; the two display
   surfaces do not. Correct — learned limits are display-only under M2.
2. `quota-demotion` sorts buckets by `bucketRank`; the other two iterate in insertion order.
3. `candidates` passes a null `localUsed` because `/candidates` may be served by the CLI against a
   remote proxy with no ledger handle. This is documented at
   [candidates.ts:365-372](../src/candidates.ts#L365-L372) and is not drift.

So the shared part is the bucket map builder, not the resolution that follows it. Extract that — a
pure `collectQuotaBuckets(...)` in `availability.ts`, beside the ladders it feeds — and leave each
caller's gating, ordering and ledger policy where it is. Roughly -45 lines.

**A stale comment found while checking this.** The doc block at `candidates.ts:365-372` states that
rung 2 fires only when the caller passes `localUsed` in, naming tests and an in-process server. The
`buildCandidateAvailability` signature is `(cfg, provider, credentialId, model, quota, nowMs)`. There
is no `localUsed` parameter and no way to pass one. The comment describes an escape hatch that does
not exist. (Rewritten with findings 4/5; it now also names the deliberate non-threading of the
ledger reader.)

**Resolution, 2026-08-26.** Landed exactly as proposed: `collectQuotaBuckets` in `availability.ts`
(net -11 across the four files), with each caller's gating, ordering and ledger policy preserved
verbatim at the caller — the `enforceLearned` gate, `bucketRank` sorting (which makes the builder's
population order unobservable at quota-demotion), and all three ledger policies. Learned and
configured are disjoint assignment sites in the builder, so a display-only learned ceiling cannot
be relabeled an operator declaration. Verified by a loop-by-loop first-hand read plus an
independent relay free-pool lane's differential pass (PARITY-CONFIRMED; the usual fresh-context
reviewer lane was unavailable on a spend cap). The lane's coverage probe found month-period
observations pinned nowhere in the consumer suites, so `test/availability.test.ts` now pins the
month bucket, the unknown-period drop, and the learned/configured split directly on the builder.

### 7. The cooldown-clear wire shape validated twice — VERIFIED; FIXED 2026-08-25

**Pre-fix sites:** `src/cli.ts` (`isCooldownClearResult`) and `src/keys-cli.ts`
(`validNarrowedClearResponse`), each carrying its own `isRecord` and `hasExactKeys` pair and its own
cleared-group validator.

Both check the same envelope: a `target` plus a `cleared` object holding exactly `breakerCells`,
`credentialFaults` and `facts`, with items shaped as provider, model and credential. The type that
owns that shape already exists in `src/cooldown-clear.ts`. The two validators differ only in which
`target` keys they accept.

**Fixed shape.** `isCooldownClearResult(value, expectedTarget, acceptedTargetKeys)` is now exported
beside `CooldownClearResult` in `src/cooldown-clear.ts`. `cli.ts` supplies the exact dynamic key set
for its provider/model/credential selector; `keys-cli.ts` supplies the exact static
`["provider", "credential", "kinds"]` rotation policy. The envelope, cleared-group, cell, fact and
scope validation now have one owner, while each caller retains its prior acceptance contract. A
shared-envelope test pins the target-key split, and a second test pins the two rules where the
policies genuinely diverge beyond target keys: the narrowed (rotation) policy also refuses a
cleared response carrying breaker cells or any cooling fact other than `credential-invalid`.

## 4. What came back clean

**No dead code outside finding 4.** A graph sweep for zero-degree functions in `src/`, excluding entry
points, returned five candidates. All five are false positives, checked by hand: `dotenv.defaultEnvPath`
is imported by `key-import.ts` and `keys-cli.ts`; `server.disarm` is assigned to a `flush` field;
`server.isRequestClosed` implements a declared `reshaper.ts` hook; `server.onResClose` is registered
and removed on the response; `openai-request.sha256Digest` is the default injected digest seam.

**No harmful call cycles.** Five circular `CALLS` groups exist and all five are legitimate: the
accounting store's eleven-method flush and retry state machine, the usage observer's six-method SSE
parser, `responses-request` push and flush, `server.RequestAccountingState` complete and finalize, and
one eleven-member group that is an artifact of the two request fronts calling into `backend.ts`.

**Parameter-count outliers are real but were not verified as fixable.**
`dashboard-snapshot.processRows` takes 11 parameters, `routes/admin.handleAdminRoutes` takes 8, and
`dispatch.toLane` takes 9. The counts come from the graph and are accurate; whether a named context
object improves them was not checked.

**One incidental cleanup already applied.** The review run left two empty files in the repository root
(`Date.now())` and `target.kind`) from a subagent shell redirect. Both were zero bytes and untracked.
They have been deleted; the working tree is clean.

## 5. Recorded but not verified

Nineteen further findings were produced by the area reviewers and **not** checked against source,
because the verification stage did not run. They are listed so the work is not lost. Each needs the
same treatment the seven above received before anyone acts on it.

**Second verification pass, 2026-08-25 (later the same day).** The lost verification stage was
re-run by three read-only lanes: two relay free-pool `pool/high` sessions covering items 15-26, and
a third covering 8-14 after two AGY attempts lost their reports to a reproducible print-mode
failure (full narration, no final answer — even with subagents and timers prohibited). Every item
below now carries a verdict against `main` at `05e2408`. Lane output is advisory; nothing from this
table was implemented in this sprint — it stands as owner-decision material with the churn priced.

**Implemented 2026-08-26 (v0.48.0), on the owner's "pick up the open work":** the lane-ranked
queue below, in full — items 10 (`23a87c5`), 14 (`3561bb4`), 8 (`0cdf45c`), 21 (`c9430bb`),
25+26 (`caa762c`), 16+18 (`3598885`), 15 (`915c983`), 20 (`b9409e3`). Every packet was
Codex-implemented, gate-verified twice, and independently reviewed (relay free-pool lane, every
verdict MERGE). Still open by the same verdicts: 9, 11, 12, 13 (not worth the churn), 17 and 23
(only in their corrected shapes), 19's remainder (polish), and unranked 22 and 24.

| # | Verdict | Corrections / conditions |
|---|---|---|
| 8 | CONFIRMED | ~-25 real, not -60 (`projectedSpendCell` is already factored); keep the `seen` guard verbatim |
| 9 | PARTIAL | a row's dimension values already have ONE definition at HEAD; only the row-to-stats accumulator duplicates (~-20); not worth doing alone |
| 10 | CONFIRMED | the policy table must stay ordered (the module's stated testability); ~-35 |
| 11 | PARTIAL | share the traversal + the cell-coverage projection only; the per-row bodies deliberately differ (~-15) |
| 12 | PARTIAL | counts wrong: 5 sites in the cited range (4 collapsible `generated`-ternary + 1 structurally different), 15 `openaiError(` calls file-wide — not 14/16; ~-10 |
| 13 | PARTIAL | five parsers, not three: 2 boundary copies + 3 data-line copies (collapsible) + 1 deliberately byte-level (`suppressRelayAddedOpenAiUsageFrames`); do after finding 3's `sse-frames.ts` lands |
| 14 | CONFIRMED | ~-8 |
| 15 | CONFIRMED | three copies, not four (`quota-demotion`'s `localUsedFor` is adjacent but a different shape); keep the credential-wide cell's no-narrowing comment at its call site; ~-20 |
| 16+18 | CONFIRMED | one observation reported twice; ~-45 |
| 17 | PARTIAL | do NOT reuse as proposed — the private copy is freshest-`observedAt`-wins, the exported helper is last-set-wins; add a strategy variant, and switch the private key derivation to `bucketKey()` |
| 19 | PARTIAL | half delivered by v0.47.0's `COMMAND_ARITY`; the remaining dispatch-table fold (~-100) is polish — defer; carve-outs needed for `keys`, `cooldowns`, and the `ping`/`--ping` OR-dispatch |
| 20 | CONFIRMED | ~-30; the table needs a no-pad trailing column and one content-bearing width |
| 21 | CONFIRMED | ~-15; the two tail behaviours after the scans genuinely differ and stay |
| 22 | PARTIAL | real, but a naive `responseHeadersForTarget` call from the OpenAI front loses the per-attempt credential attribution on success; needs a ctx adapter; belongs beside finding 2 |
| 23 | PARTIAL | direction right, but `CredentialWalk` exposes neither `wasStarted` nor `wasSettled`; one local flag (health-attempt lifetime) survives regardless; ~25 lines + two walk accessors + a both-fronts pinning test — defer |
| 24 | PARTIAL | the key table needs per-key validator association — `isAggregateTokenCell` vs `isEstimatedTokenCell` must stay distinct (`method` rule); ~-20 |
| 25 | CONFIRMED | overcounted: the validator already walks `SPEND_CELL_KEYS`; only the empty-factory ladder remains (~-8); keep the hand-written type declaration |
| 26 | CONFIRMED | ~-12; each validator keeps its own key set and loss formula, only the state machine is shared |

Lane-ranked recommendation: 10 and 14 first, then 8, 21, 25, 26, 16+18, 15, 20; items 9, 11, 12,
13 are not worth the churn yet; 17 and 23 only in their corrected shapes; 19's remainder is polish.

| # | Reported finding | Primary site | Claimed delta |
|---|---|---|---|
| 8 | Collapse the four spend cells into one table instead of five hand-expansions | `dashboard-snapshot.ts:584-635` | -60 |
| 9 | Give `processRows` one projection accumulator and one definition of a row's dimension values | `dashboard-snapshot.ts:1461-1568` | -35 |
| 10 | Replace the dashboard route ladder's derived booleans with a per-route policy table, order unchanged | `dashboard-routes.ts:661-829` | -55 |
| 11 | One shared walk of a window's minute cells instead of two copies | `dashboard-snapshot.ts:1478-1500`, `1669-1700` | -30 |
| 12 | Collapse 14 hand-written envelope-error sites into one fault table | `backend.ts:1592-1668` | -30 |
| 13 | One SSE frame and data parser instead of three inside `backend.ts` | `backend.ts:466-476`, `516-547`, `572-585` | -28 |
| 14 | Anthropic stream-event validation as a table row rather than a switch arm | `backend.ts:416-433` | -14 |
| 15 | One factory for the hard-cap ledger reader instead of four hand-copies | `server.ts:352-390`, `candidates.ts:628-646`, `availability-snapshot.ts:336-357` | -35 |
| 16 | Write the four-rung limits ladder once instead of twice per axis | `configured-limits.ts:267-309` | -45 |
| 17 | Make `mergeQuotaObservations` total so the private copy in `candidates` can go | `quota-observation.ts:285-294` | -12 |
| 18 | Collapse the twin ladders and twin axis parsers in configured-limits | `configured-limits.ts:56-202`, `246-319` | -60 |
| 19 | Fold `main()`'s command ladder into the `COMMAND_ARITY` table so the command set has one home | `cli.ts:3390-3564` | -70 |
| 20 | Declare the candidates table's 17 columns once instead of header-and-row | `cli.ts:2674-2745` | -40 |
| 21 | Collapse the twin line-terminator scans in the usage observer's drain | `usage-observer.ts:680-748` | -25 |
| 22 | Define the served-response announcement set once, not once per front | `server.ts:3738-3775`, `3908-3924` | -25 |
| 23 | Delete the `credentialRecorded` flag — `CredentialWalk` already holds that fact | `server.ts:1398`, `1779-1805` | -55 |
| 24 | Walk the seven token cells from one key table instead of six longhand copies | `accounting-store-schema.ts:659-701` | -35 |
| 25 | Give the four spend cells one table instead of four routing ladders | `accounting-store-schema.ts:742`, `1348-1360` | -40 |
| 26 | Define the coverage state machine once, not twice | `accounting-store-schema.ts:871-916` | -30 |

Two notes on that table. Items 16 and 18 are the same observation reported independently by two
reviewers, so treat them as one. Item 23 is the most interesting of the unverified set and also the
riskiest: `credentialRecorded` is a hand-maintained boolean with roughly 13 assignment sites in
`handle` and a further set in `openAiFrontPath`, which is a strong signal the state belongs elsewhere
— but proving `CredentialWalk` already holds it requires reading `credential-select.ts` closely, and
that was not done.

## 6. Coverage and gaps

**Not covered at all.** The cross-cutting reviewer — the one assigned to JSON-store persistence,
auth-header construction, the vitest temp-dir guards, spec parsing, and fetch retry wrappers — failed
before returning. Finding 5 above was produced by hand afterwards and is the only cross-cutting result
in this document. That area is otherwise unexamined.

**Not verified.** ~~Section 5, all nineteen items.~~ Closed by the second pass of 2026-08-25 —
every §5 item now carries a source-checked verdict (see the table in §5).

**Index gaps.** Three files are only partially parsed in the knowledge graph and were reviewed by text
search where they mattered: `dashboard/src/styles.css`, `scripts/claude-proxied.ps1`, and
`test/cli-update-gate.test.ts`. None is in `src/`.

**Deliberately out of scope.** `dashboard/` (the React SPA), `test/`, and `scripts/` were not
reviewed. The brief was `src/`.

**A class nobody proposed.** No reviewer proposed type-level simplifications — exhaustive switches over
a closed union, or reshaping a type so an invalid state cannot be constructed. Given how much of this
codebase is closed enums with hand-written guards (`accounting-store-schema.ts` alone is 1,491 lines of
them), that is likely the richest unexplored seam.

## 7. How to use this

These are proposals, not a work queue, and the owner decides which are worth the churn. Finding 1 is
the only one that changes behaviour a user would notice; the rest are structural and safe to defer
indefinitely. Findings 4 and 5 are mechanical and could land in one sitting.

Anything acted on needs `npm run build && npm run check` green before and after, on a clean tree — and
per this repository's own history, expect at least one test to have been written to pin the shape you
are changing. Read a failing test's stated reasoning before assuming your change is wrong.
