# P1-07 — Status Verdict Classifier Centralization (SEM-04, `classifyStatus` + `carriesEligibilityFact`)

Scope: centralize HTTP status classification and provider quota-exhaustion
interpretation into one authoritative evaluator, reconciling function
`classifyStatus` with function `carriesEligibilityFact` and the status arm of
function `resolveReset`.
Adversarial verdict: REFINE per `docs/history/reviews/adversarial-verification-2026-09-05.md`
— one status-to-outcome-class table for the outcome-class readers; event verdicts
and envelope validation stay separate.

## Architectural rationale and layering

Target location: `src/candidate-runner.ts` beside the existing function
`classifyStatus` (or the kernel if the kernel owns shared dispatch vocabulary at
implementation time — either way, exactly one module owns the table). Rationale:

- Both reconciled functions already live in `src/candidate-runner.ts`, and every
  consumer already imports from there (both fronts, the eligibility observation
  path, the server re-export). Centralizing in place adds no new edge.
- The status arm of function `resolveReset` (also in `src/candidate-runner.ts`)
  becomes a reader of the same table rather than a third membership list, which is
  what removes the drift without moving any dependency.
- Event verdicts (function `openAiResponsesVerdict` and siblings in
  `src/stream-commit.ts`) and envelope validation (function `invalidEnvelopeReason`
  in `src/backend.ts`) stay separate by design: they classify stream events and body
  shapes, not HTTP statuses. Folding them in would mix layers (transport outcome
  versus content validation).

## Complete blast radius

Reconciled symbols (all in `src/candidate-runner.ts`):

- Function `classifyStatus` — the outcome-class mapper with the documented status
  sets (credential versus retriable versus client versus ok).
- Function `carriesEligibilityFact` — the eligibility predicate whose membership
  overlaps the retriable set with different membership (the sixth reader the catalog
  missed).
- Function `resolveReset` — the header-first, field-second, generic-third,
  fixed-last precedence chain; only its status arm is in scope.
- Function `inspectCandidateResponse` — the observation path that calls both
  `carriesEligibilityFact` (gating `observeEligibility`) and `classifyStatus` (via
  `walkOutcomeForResponse` and the failover predicate neighboring
  `walkWouldFailOver`).
- Function `walkOutcomeForResponse`, function `walkWouldFailOver`, and the failover
  predicate inside function `endWalk` — downstream readers of the classification.

Consumers outside the module:

- Function `anthropicMessagesPath` in `src/routes/messages.ts` (the `classifyStatus`
  call neighboring the post-header disposition) and function `openAiFrontPath` in
  `src/routes/openai-front.ts` (the mirror call) — behavior must be identical.
- The server re-export of `classifyStatus` in `src/server.ts` — the public alias,
  unchanged.

Explicitly out of scope (do not touch):

- Function `openAiResponsesVerdict` and siblings (`openAiChatVerdict`,
  `anthropicVerdict`, block-delta verdicts) in `src/stream-commit.ts` — stream-event
  verdicts, different job.
- Function `invalidEnvelopeReason` in `src/backend.ts` — envelope shape validation,
  different job (and the visible complexity spike, not a status table).
- Function `statusForQueryError` in `src/dashboard-routes.ts` — the trivial
  query-error mapper, different job.

Suites: candidate-runner suites, both front suites, stream-commit suites (as
no-change witnesses), backend envelope suites (as no-change witnesses), and server
re-export suites.

## Specific code modifications with contracts

New contract in `src/candidate-runner.ts`:

```typescript
export type OutcomeClass = "ok" | "credential" | "retriable" | "client";

export interface StatusVerdict {
  readonly outcome: OutcomeClass;
  readonly carriesEligibilityFact: boolean;
}

export const STATUS_VERDICT_TABLE: Readonly<Record<number, StatusVerdict>>;

export function statusVerdict(status: number): StatusVerdict;
```

Contract:

- Exactly one table lists every classified status; `classifyStatus` and
  `carriesEligibilityFact` become thin readers over it, so the two can never drift
  again.
- Unknown statuses map to the current fallthrough behavior of `classifyStatus`
  (client for unlisted error statuses, ok below the error range) — no behavior
  change at any unlisted status.
- The eligibility membership is recorded per-status in the table, preserving the
  current union semantics while making the overlap explicit and reviewable.

Before (the two definitions in `src/candidate-runner.ts`, at the anchors of function
`classifyStatus` and function `carriesEligibilityFact`):

```typescript
export function classifyStatus(status: number): OutcomeClass {
  if (status < 400) return "ok";
  if (status === 401 || status === 403) return "credential";
  if (status === 400 || status === 402 || status === 404 || status === 410 || status === 429 || status >= 500) return "retriable";
  return "client";
}
```

```typescript
export function carriesEligibilityFact(status: number): boolean {
  return (
    status === 400 ||
    status === 401 ||
    status === 402 ||
    status === 403 ||
    status === 404 ||
    status === 410 ||
    status === 429
  );
}
```

After (same anchors — the table is added above them, the functions become readers):

```typescript
export const STATUS_VERDICT_TABLE = {
  400: { outcome: "retriable", carriesEligibilityFact: true },
  401: { outcome: "credential", carriesEligibilityFact: true },
  402: { outcome: "retriable", carriesEligibilityFact: true },
  403: { outcome: "credential", carriesEligibilityFact: true },
  404: { outcome: "retriable", carriesEligibilityFact: true },
  410: { outcome: "retriable", carriesEligibilityFact: true },
  429: { outcome: "retriable", carriesEligibilityFact: true },
} as const;

export function statusVerdict(status: number): StatusVerdict {
  const known = (STATUS_VERDICT_TABLE as Readonly<Record<number, StatusVerdict>>)[status];
  if (known !== undefined) return known;
  if (status < 400) return { outcome: "ok", carriesEligibilityFact: false };
  if (status >= 500) return { outcome: "retriable", carriesEligibilityFact: false };
  return { outcome: "client", carriesEligibilityFact: false };
}

export function classifyStatus(status: number): OutcomeClass {
  return statusVerdict(status).outcome;
}

export function carriesEligibilityFact(status: number): boolean {
  return statusVerdict(status).carriesEligibilityFact;
}
```

The status arm of function `resolveReset` is rewired to read the table instead of
re-listing statuses, keeping its header-first precedence untouched. The table above
reproduces the current memberships exactly — reconciliation review happens against
this table in the open, not inside two separate predicate bodies.

## Step-by-step implementation sequence

1. Add `STATUS_VERDICT_TABLE` plus `statusVerdict` to `src/candidate-runner.ts`
   reproducing current memberships exactly; add a cross-product unit test asserting
   `classifyStatus` and `carriesEligibilityFact` agree with the table on every
   status in the documented range plus boundary probes.
2. Rewire function `classifyStatus` and function `carriesEligibilityFact` as thin
   readers (per the after-block); run the candidate-runner suites.
3. Rewire the status arm of function `resolveReset` to the table; run the reset
   suites.
4. Verify both fronts plus the server re-export with no snapshot updates.
5. Hold a review pass on the table itself (the one place where credential versus
   retriable versus eligibility membership is now visible) and record any
   deliberate membership decision in the commit message — do not smuggle a policy
   change into the mechanical rewire.

## Verification and regression test plan

```powershell
npm test -- test/candidate-runner.test.ts
npm test -- test/openai-front.test.ts
npm test -- test/messages.test.ts
npm test -- test/stream-commit.test.ts
npm test -- test/server.test.ts
npx tsc --noEmit
```

(Substitute the owning directory suite where a file name differs in the working
tree.)

Invariant assertions:

- Cross-product parity: for every status in the table plus boundary probes below,
  inside, and above the error range, the rewired readers return exactly what the
  pre-change implementations returned (pin with a characterization test before the
  rewire, keep it green after).
- Eligibility gating unchanged: function `inspectCandidateResponse` observes
  eligibility for exactly the same status set as before.
- No-change witnesses green without updates: stream-commit event-verdict suites and
  backend envelope suites pass untouched, proving the out-of-scope classifiers were
  not disturbed.
- Exactly one status-membership table exists in the module; text search confirms no
  second inline status list for outcome-class readers.
- No line-number references introduced.
