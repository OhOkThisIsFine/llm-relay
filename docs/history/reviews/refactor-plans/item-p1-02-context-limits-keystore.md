# P1-02 — Context-Limits and Keystore Shared Lookup and Bounds Helpers (CLONE-13, CLONE-21, CLONE-12, CLONE-17)

Scope: extract the duplicated scan-and-record bodies in `context-limits.ts`,
the shared envelope tail in `accounting-store-schema.ts`, the mutation prologue in
`keystore.ts`, and the dispatch-view setup in `cli.ts`.
Adversarial verdicts: ACCEPT for all four per
`docs/history/reviews/adversarial-verification-2026-09-05.md`.

## Architectural rationale and layering

Each extraction stays inside its owning module — no cross-layer move — because each
family is already in the right layer:

- `scanStatedLimit` plus `recordDeploymentCeiling` belong in `src/context-limits.ts`
  because both halves (context ceilings and max-output ceilings) already live there
  and both write through `recordFact` in `src/target-facts.ts`. Callers
  (`observeContextLimit` path in `src/candidate-runner.ts` via `parseStatedContextLimit`
  and `recordObservedContextLimit`) keep depending downward on `context-limits.ts`.
- `validateCommonEnvelopeTail` belongs in `src/accounting-store-schema.ts` because the
  tail predicates (`isNullableCounter`, `isNullableId`, `isAggregateTokens`) are
  private to that module; hoisting the tail anywhere else would export the predicates
  or duplicate them.
- `openStoreForMutation` belongs in `src/keystore.ts` as a module-local helper because
  its callees (`resolveKeystorePath`, `loadStore`, `refuseMutation`,
  `cloneStoreForMutation`) are all keystore internals with keystore error types.
- `setupDispatchCatalog` belongs in `src/cli.ts` as a module-local helper because its
  body (`ModelCatalog` construction, `materializeDynamicPools` try/catch,
  `contextWindowResolver` wiring) is CLI-view assembly, not reusable domain logic.

No new inter-module edge is introduced by any of the four; each change only adds an
intra-module edge from existing callers to a new local helper.

## Complete blast radius

Family A — limit observers in `src/context-limits.ts`:

- Function `parseStatedContextLimit` — scan loop over `STATED_LIMIT_PATTERNS` with the
  bounded-prefix slice and the numeric-credibility guard.
- Function `parseStatedMaxOutput` — identical scan shape over
  `STATED_MAX_OUTPUT_PATTERNS` with the same slice and guard.
- Function `recordObservedContextLimit` — credibility guard plus `recordFact` write
  under the `context-limit` fact name.
- Function `recordObservedMaxOutput` — identical guard plus `recordFact` write under
  the `max-output` fact name.
- Reader functions `observedContextLimit`, `observedMaxOutput`, plus lifecycle helpers
  `flushObservedContextLimits` and `resetObservedContextLimits` — unchanged but covered
  by the same suites.
- Callers: function `inspectCandidateResponse` in `src/candidate-runner.ts` (via the
  `observeContextLimit` and `observeMaxOutput` observation path) and any test helper
  importing the four functions.
- Suites: `test/context-limits.test.ts` and `test/context-ceiling.test.ts`.

Family B — guard tails in `src/accounting-store-schema.ts`:

- The shared tail sequence `isNullableCounter` twice plus `isNullableId` three times
  plus `isAggregateTokens` plus the spend check, appearing once inside the validator
  governing the `attribution`-headed envelope and once inside the validator governing
  the `commitAttemptId`-headed envelope (the pair verified as CLONE-21). Heads stay
  per-validator.
- Consumers: every validator in the schema module and, transitively, `src/accounting.ts`,
  `src/accounting-store.ts`, and `src/dashboard-snapshot.ts` which import the schema.
- Suites: accounting schema and accounting lifecycle suites.

Family C — keystore prologue in `src/keystore.ts`:

- The prologue chain `resolveKeystorePath` → `loadStore` → `refuseMutation` →
  `cloneStoreForMutation` plus the duplicate guard and the `createStore` /
  `unlockStoreForWrite` tail, appearing in the two mutation entry points verified as
  CLONE-12. Preconditions (identity/value/expiry validation versus `validExportEntry`)
  stay outside the extracted window.
- Related helper `requireStoreForMutation` (sitting beside `refuseMutation` and
  `cloneStoreForMutation`) is a consumer candidate, not a duplicate source.
- Suites: keystore suites.

Family D — dispatch-view setup in `src/cli.ts`:

- The `ModelCatalog` plus `materializeDynamicPools` try/catch plus
  `contextWindowResolver` assembly appearing in the two dispatch-view builders verified
  as CLONE-17. The divergent `qs` construction (task-in-query ban versus host-routing
  params) stays at each call site.
- Suites: CLI dispatch-view suites.

## Specific code modifications with contracts

Family A contract (in `src/context-limits.ts`):

```typescript
export function scanStatedLimit(text: string, patterns: readonly RegExp[]): number | null;
export function recordDeploymentCeiling(
  factName: "context-limit" | "max-output",
  provider: string,
  model: string,
  tokens: number,
  opts?: { path?: string; now?: number },
): void;
```

- `scanStatedLimit` owns the bounded-prefix slice, the per-pattern exec loop, and the
  numeric-credibility guard; it never records anything.
- `recordDeploymentCeiling` owns the credibility guard plus the `recordFact` write;
  a fresh observation replaces the older one per the module charter.

Before (inside function `parseStatedContextLimit` in `src/context-limits.ts`,
immediately following the empty-body guard):

```typescript
const text = body.length > 8192 ? body.slice(0, 8192) : body;
for (const re of STATED_LIMIT_PATTERNS) {
  const m = re.exec(text);
  if (!m?.[1]) continue;
  const n = Number(m[1].replace(/[,_]/g, ""));
  if (Number.isFinite(n) && n > 0 && n <= MAX_CREDIBLE_TOKENS) return Math.floor(n);
}
return null;
```

After (same anchor):

```typescript
return scanStatedLimit(body, STATED_LIMIT_PATTERNS);
```

Function `parseStatedMaxOutput` changes identically with `STATED_MAX_OUTPUT_PATTERNS`.
Both `recordObserved*` functions delegate their guard-plus-write bodies to
`recordDeploymentCeiling` with their respective fact names.

Family B contract (in `src/accounting-store-schema.ts`):

```typescript
function validateCommonEnvelopeTail(value: Record<string, unknown>): boolean;
```

- Returns true exactly when the shared tail (nullable counters, nullable ids,
  aggregate tokens, spend coherence) holds; never inspects the divergent head fields.

Before (inside each of the two envelope validators, at the anchor where the tail
sequence begins — the first `isNullableCounter` check of the shared tail):

```typescript
if (!isNullableCounter(value.latencyMs)) return false;
if (!isNullableCounter(value.commitMs)) return false;
if (!isNullableId(value.provider)) return false;
// ... remaining shared tail checks ...
if (!isAggregateTokens(value.tokens)) return false;
// ... spend check ...
```

After (same anchor in both validators):

```typescript
if (!validateCommonEnvelopeTail(value)) return false;
```

Heads (`attribution` versus `commitAttemptId` plus request extras) stay inline above
the anchor.

Family C contract (in `src/keystore.ts`):

```typescript
function openStoreForMutation(opts: { path?: string } & KeystoreOptions): StoredKeystore;
```

Before (inside each of the two mutation entry points verified as CLONE-12, at the
anchor immediately following precondition validation):

```typescript
const path = resolveKeystorePath(opts);
const loaded = loadStore(path, opts);
if (loaded.status === "unreadable" || loaded.status === "degraded") refuseMutation(loaded);
// ... duplicate guard, clone-or-create tail ...
```

After (same anchor):

```typescript
const { path, store } = openStoreForMutation(opts);
// ... precondition-specific logic continues on `store` ...
```

Family D contract (in `src/cli.ts`):

```typescript
function setupDispatchCatalog(cfg: DispatchViewConfig): { catalog: ModelCatalog; contextWindowResolver: ContextWindowResolver };
```

Before (inside each of the two dispatch-view builders, at the anchor where
`ModelCatalog` construction begins):

```typescript
const catalog = new ModelCatalog(/* ... */);
try { materializeDynamicPools(catalog, cfg); } catch { /* ... */ }
const contextWindowResolver = /* ... */;
// ... divergent `qs` construction follows ...
```

After (same anchor):

```typescript
const { catalog, contextWindowResolver } = setupDispatchCatalog(cfg);
// ... divergent `qs` construction follows, unchanged ...
```

## Step-by-step implementation sequence

1. In `src/context-limits.ts`, add `scanStatedLimit` and `recordDeploymentCeiling`
   beside the pattern tables; rewire `parseStatedContextLimit` first, keeping
   `parseStatedMaxOutput` untouched until its suite passes.
2. Rewire `parseStatedMaxOutput`, then both `recordObserved*` functions.
3. In `src/accounting-store-schema.ts`, add `validateCommonEnvelopeTail` directly
   above the first envelope validator; rewire the `attribution`-headed validator
   first, then the `commitAttemptId`-headed one.
4. In `src/keystore.ts`, add module-local `openStoreForMutation` beside
   `requireStoreForMutation`; rewire the first CLONE-12 mutation entry point, verify,
   then the second.
5. In `src/cli.ts`, add module-local `setupDispatchCatalog`; rewire the first
   dispatch-view builder, verify, then the second.
6. Run the verification plan below after each family, not just at the end.

## Verification and regression test plan

```powershell
npm test -- test/context-limits.test.ts
npm test -- test/context-ceiling.test.ts
npm test -- test/accounting-schema.test.ts
npm test -- test/accounting-lifecycle.test.ts
npm test -- test/keystore.test.ts
npm test -- test/cli-dispatch.test.ts
npx tsc --noEmit
```

(If any suite file name differs in the working tree, run the closest match plus the
owning directory suite — for example `npm test -- test/accounting` when the schema
suite lives under a directory name.)

Invariant assertions:

- `scanStatedLimit` returns `null` for bodies that state only the requested count and
  for bodies exceeding the credibility bound; property parity with both current parsers.
- `recordDeploymentCeiling` refuses non-finite, non-positive, and over-bound tokens
  without touching the fact store.
- `validateCommonEnvelopeTail` accepts and rejects exactly the same envelope corpus as
  the two current inline tails.
- `openStoreForMutation` throws `KeystoreMutationRefusedError` on `unreadable` and
  `degraded` loads and returns a cloned (not aliased) store otherwise.
- No line-number references introduced; all anchors are symbol names.
