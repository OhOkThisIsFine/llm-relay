# P1-03 — Front-Walk Candidate-Runner Extraction (CLONE-01, CLONE-03, CLONE-05, CLONE-06, CLONE-08, CLONE-22)

Scope: extract the common attempt-walk choreography from `src/routes/messages.ts`
and `src/routes/openai-front.ts` into `src/candidate-runner.ts`.
Respect the adversarial constraints: the `servedBy` opt-in from CLONE-04 and fully
separate protocol transforms. CLONE-02, CLONE-04, and CLONE-07 are REFINE and are
NOT in scope — only the ACCEPT members listed above.
Adversarial source: `docs/reviews/adversarial-verification-2026-09-05.md`,
front-pair cluster section.

## Architectural rationale and layering

Target location: `src/candidate-runner.ts`, which already owns settlement
infrastructure (`endWalk`, `walkExitHeaders`, `inspectCandidateResponse`,
`classifyStatus`). Rationale:

- Dependency direction is already front → `candidate-runner.ts` (both fronts import
  `classifyStatus` and walk helpers from it). Moving more leaf choreography along the
  same edge adds no new direction and cannot create a cycle.
- The cross-cutting constraint from the verification report applies: never merge
  front control flow. Only leaf choreography (egress bookkeeping, pre-egress failure
  mapping, post-header disposition, walk continuations, dead-stream settlement, the
  `finally` plus all-capped tail) moves. Handler assembly, protocol literals,
  normalization (`normalizeOpenAiErrorBody` and the OpenAI-only repair-audit path in
  `openAiFrontPath`), and the per-front fetch calls stay in their fronts.
- The intra-front helper for the openai-front endWalk variants (CLONE-23) stays local
  to `src/routes/openai-front.ts` parameterized by status, kind, and message — it is
  referenced here as a boundary so nobody folds it into the shared module by mistake.

## Complete blast radius

Already-centralized anchors in `src/candidate-runner.ts` (consumers, not move sources):

- Function `endWalk` — the settlement exit both fronts already call.
- Function `walkExitHeaders`, function `inspectCandidateResponse`, function
  `classifyStatus` — imported by both fronts today.

Move sources (each a verified ACCEPT window between the two fronts):

- Egress attempt-begin (CLONE-01): the `onEgress` callback body inside function
  `startAttempt` in `src/routes/openai-front.ts` and the corresponding `onEgress`
  closure inside function `anthropicMessagesPath` in `src/routes/messages.ts` —
  specifically the `pool429.noteEgress()` plus `recordCredentialStarted` sequence
  bracketed by the `beginHealthAttempt` call. The surrounding fetch calls
  (`fetchBackend` with path, method, and request buffer versus `fetchOpenAiFront`
  with request JSON, stream flag, and protocol) and the trailing protocol literal
  stay per-front.
- Pre-egress failure (CLONE-03): the `!settled.ok` branch in both fronts — the
  `recordRejected` → destroyed-guard → abort-aware status selection → terminal
  message → `baseLog` → return sequence. No protocol or response handle appears in
  this window.
- Post-header disposition plus endWalk continuations (CLONE-05 folded into CLONE-06):
  the `inspectCandidateResponse` call with the per-front response binding
  (`backendRes` versus `upstream`), the `completePostHeaderBodyFailure` mapping, the
  `credentialRecorded` flag assignment, the cancelled-return, the timeout-to-status
  mapping, and the `walkEnd` continuation guard (`if (walkEnd) continue; return;`).
- Dead-stream settlement (CLONE-08): the dead-stream `endWalk` arms in both fronts
  carrying `upstreamReportedModel`, error type, error origin, and the failover
  predicate — parameterized by the protocol literal only.
- Finally plus all-capped tail (CLONE-22): the `finally` bodies in function
  `anthropicMessagesPath` and function `openAiFrontPath` through the
  `respondAllCapped` call with the walk-started timestamp, the front literal, and
  the `pool429` tracker. The `finally` heads (transparent dispatch versus audit-log
  plus return) stay per-front; only the settlement tail moves.

Explicitly out of scope (REFINE, do not touch in this item):

- Credential-reject (CLONE-02) — window needs re-scoping first.
- Transport failure plus endWalk (CLONE-04) — `servedBy` stays opt-in; unifying it
  unconditionally changes the Anthropic-adjacent wire surface.
- Probe cancelled/dead (CLONE-07) — the `malformedProvenance` predicates disagree
  for chat plus OpenAI; needs an owner ruling before unification.

Callers and suites: function `anthropicMessagesPath` in `src/routes/messages.ts`,
function `openAiFrontPath` in `src/routes/openai-front.ts`, and the walk helpers they
close over (`startAttempt`, `startRun`, `processRecoveredChat` in the OpenAI front).
Suites: `test/openai-front.test.ts`, the messages-route suites, hedge-wiring suites,
and any walk-level regression suite (refusal-signature, mid-stream-failure).

## Specific code modifications with contracts

New contracts in `src/candidate-runner.ts` (names match the verified mechanisms):

```typescript
export function noteEgressAndBegin(tracker: Pool429Tracker, attempt: unknown): void;
export function handlePreEgressFailure(ctx: WalkContext, settled: SettledOutcome): WalkAction;
export function handlePostHeaderBodyFailure(ctx: WalkContext, outcome: PostHeaderOutcome): WalkAction;
export function settleWalkFinally(ctx: WalkContext, walk: CredentialWalk): void;
```

- `noteEgressAndBegin` owns exactly the `onEgress` body (egress note plus credential
  bookkeeping). It takes no fetch function and no protocol literal.
- `handlePreEgressFailure` owns the `!settled.ok` mapping and returns either
  `continue` or `return` semantics to the caller — it never touches the response.
- `handlePostHeaderBodyFailure` owns the CLONE-05 plus CLONE-06 family as one helper,
  taking the inspected response as a parameter so the `backendRes` versus `upstream`
  rename disappears.
- `settleWalkFinally` owns the CLONE-22 `finally` tail through `respondAllCapped`,
  parameterized by the front literal (`anthropic` versus `openai`).

Before (inside the `onEgress` closure in function `anthropicMessagesPath` in
`src/routes/messages.ts`, immediately following the opening of the closure):

```typescript
pool429.noteEgress();
// ... beginHealthAttempt bookkeeping ...
recordCredentialStarted(/* ... */);
```

Before (inside the `onEgress` closure in function `startAttempt` in
`src/routes/openai-front.ts`, immediately following the opening of the closure):

```typescript
pool429.noteEgress();
// ... beginHealthAttempt bookkeeping ...
recordCredentialStarted(/* ... */);
```

After (both anchors):

```typescript
noteEgressAndBegin(pool429, attempt);
```

Before (inside function `anthropicMessagesPath`, at the anchor guarding the
pre-egress outcome — the `!settled.ok` branch):

```typescript
if (!settled.ok) {
  recordRejected(/* ... */);
  // ... destroyed-guard, abort-aware status, terminal message, baseLog ...
  return /* ... */;
}
```

After (same anchor, and the mirror anchor in function `openAiFrontPath`):

```typescript
if (!settled.ok) {
  return handlePreEgressFailure(ctx, settled);
}
```

Before (inside function `anthropicMessagesPath`, at the anchor following the
`inspectCandidateResponse` call):

```typescript
const inspected = await inspectCandidateResponse(backendRes, /* ... */);
// ... completePostHeaderBodyFailure mapping, credentialRecorded flag,
//     cancelled-return, timeout-to-status mapping, walkEnd continuation ...
```

After (same anchor; the OpenAI-front mirror passes its `upstream` binding):

```typescript
const walkAction = await handlePostHeaderBodyFailure(ctx, await inspectCandidateResponse(backendRes, /* ... */));
if (walkAction === "continue") continue;
return walkAction;
```

Before (inside the `finally` block of function `anthropicMessagesPath`, at the anchor
where settlement begins):

```typescript
// ... finally body ...
respondAllCapped(res, h, { started: ctx.started, /* ... */ }, "anthropic", pool429, /* ... */);
```

After (same anchor; the OpenAI-front mirror passes its front literal):

```typescript
settleWalkFinally(ctx, walk);
```

with `settleWalkFinally` selecting the front literal internally from the walk context.

## Step-by-step implementation sequence

1. Add `noteEgressAndBegin` to `src/candidate-runner.ts`; rewire the
   `anthropicMessagesPath` egress anchor first, verify, then the `startAttempt`
   egress anchor in the OpenAI front.
2. Add `handlePreEgressFailure`; rewire the pre-egress anchor in both fronts.
3. Add `handlePostHeaderBodyFailure` covering the post-header plus continuation
   family; rewire the post-header anchor in both fronts.
4. Add the dead-stream arm parameterization to the existing `endWalk` helper path;
   rewire the dead-stream anchors.
5. Add `settleWalkFinally`; rewire both `finally` tails.
6. Leave CLONE-02, CLONE-04, and CLONE-07 call sites exactly as they are; file no
   cleanup that touches those windows.

## Verification and regression test plan

```powershell
npm test -- test/openai-front.test.ts
npm test -- test/messages.test.ts
npm test -- test/hedge-wiring.test.ts
npm test -- test/mid-stream-failure.test.ts
npm test -- test/refusal-signature-normalization.test.ts
npx tsc --noEmit
```

(When a suite file name differs in the working tree, run the owning directory
instead — for example `npm test -- test/routes` — and note the substitution in the
commit message.)

Invariant assertions:

- Byte-identical wire behavior on both fronts for the moved windows (egress notes,
  pre-egress statuses, post-header dispositions, finally settlement) — covered by the
  existing front suites without snapshot updates.
- The Anthropic-adjacent error surface carries no `servedBy` member after the move
  (the CLONE-04 opt-in is untouched by this item).
- Protocol transforms remain per-front: text search confirms no
  `normalizeOpenAiErrorBody`, repair-audit, or `fetchOpenAiFront` reference inside
  `src/candidate-runner.ts`.
- No line-number references introduced.
