# P1-04 — SSE Scaffold and Streaming Pump Unification (CLONE-20 + SEM-02)

Scope: unify SSE chunk framing, error-trailer injection, and stream lifecycle pumps
across streaming handlers into `src/sse.ts`, plus adopt the existing
`iterateDataPayloads` helper at the remaining `data:` sites (CLONE-11).
Adversarial verdicts: ACCEPT for CLONE-20, CLONE-11, and SEM-02 (phased) per
`docs/reviews/adversarial-verification-2026-09-05.md`.

## Architectural rationale and layering

Target location: `src/sse.ts` (with `src/sse-frames.ts` as the framing primitive
layer beneath it). Rationale:

- `src/sse.ts` already owns the shared SSE vocabulary: function
  `reconstructFromSse` consumes function `iterateDataPayloads`, and the
  `BufferedSseFrames` class in `src/sse-frames.ts` already frames byte streams for
  four of the six SEM-02 sites. The codebase is halfway centralized; this item
  finishes the move rather than inventing a new home.
- Dependency direction stays leaf-ward: stream wrappers (`think-tags.ts`,
  `tool-use-ids.ts`, `backend.ts`, `dialect-stream.ts`, `openai-dialect.ts`) depend
  on `src/sse.ts`; `src/sse.ts` depends only on `src/sse-frames.ts` and the
  Anthropic message types. No wrapper ever becomes a dependency of the scaffold.
- The boundary-split loop pair verified as CLONE-11 stays inline per the benign
  ruling (BENIGN-02); only the `data:`-line triple (split, filter, map, join, trim)
  adopts `iterateDataPayloads`. This keeps byte-level framing performance where it
  matters and shares only the semantic extraction.

## Complete blast radius

Scaffold family (CLONE-20 + SEM-02 phase two):

- The stream pump pair: the `reader.read` plus `frames.append` plus `processFrames`
  pump in `src/think-tags.ts` (the `ThinkTagStripFilter.push` transform side) and the
  mirror pump in `src/tool-use-ids.ts` (the `rewriteOne` transform side, inside the
  closure neighboring function `rewriteOne` and function `processFrames`).
- The shared tails: `flushHeld` plus `takeRemainder` plus the identical `event: error`
  frame plus `controller.close()` sequence in both modules.
- The six SEM-02 pump sites: function `reconstructFromSse` in `src/sse.ts`, the
  header-preflight path in `src/backend.ts` neighboring `invalidEnvelopeReason`, the
  byte-level `frameEnd` site in `src/backend.ts`, function `sseEvent` / function
  `sseDelta` in `src/dialect-stream.ts`, the usage-frame site in
  `src/openai-dialect.ts` neighboring the `takeRemainder` call, and the CLONE-20 pair
  above.
- Framing primitives: class `BufferedSseFrames` with methods `append`, `next`,
  `takeRemainder`, and the iterator protocol in `src/sse-frames.ts`; functions
  `findSseBoundary`, `parseSseEvent`, and `sseEventFields` in the same module.
- Error-frame builders: function `sseError` and function `openAiSseError` in
  `src/stream-pipeline.ts`, plus function `emitSse` and function `emitSseTail` in
  `src/emitSse.ts` — contract consumers of the scaffold's error trailer, not move
  sources.
- Observer: function `makeSseObserver` with siblings `inspectSseFrame`,
  `processSseLine`, `newSseState`, and `resetSse` in `src/usage-observer.ts` — read
  the scaffold contract before changing any pump signature.

Data-line adoption family (CLONE-11):

- The boundary-split loop verbatim pair: inside function `captureCompleteEvents` in
  the backend capture path and the inline loop neighboring it (both stay inline).
- The `data:`-line triple sites: inside function `inspectEvent`, inside function
  `captureEventModel`, inside function `suppressRelayAddedOpenAiUsageFrames`, each
  differing only in its tail (`[DONE]` guard, bare return versus false return,
  usage-shape check). All three adopt `iterateDataPayloads`.
- Existing adopter: function `reconstructFromSse` in `src/sse.ts` — the reference
  implementation.

Suites: `test/sse.test.ts`, `test/stream-pipeline.test.ts`,
`test/mid-stream-failure.test.ts`, `test/accounting-lifecycle.test.ts` (exercises the
truncating-SSE backend helper), plus think-tags and tool-use-ids suites.

## Specific code modifications with contracts

New scaffold contract in `src/sse.ts`:

```typescript
export interface SseTransformHooks {
  processFrames: () => void;
  flushHeld: () => void;
  takeRemainder: () => string;
  buildErrorFrame?: (message: string) => string;
}

export function createSseTransformStream(hooks: SseTransformHooks): TransformStream<Uint8Array, Uint8Array>;
```

Contract:

- The scaffold owns the read pump (`reader.read` loop), the `frames.append` /
  `processFrames` interleaving, the `flushHeld` plus `takeRemainder` tail, the
  identical `event: error` frame emission, and `controller.close()`.
- Callers supply only the transform (`processFrames` plus `flushHeld`); the two
  current transforms (`ThinkTagStripFilter.push` semantics versus `rewriteOne`
  semantics, including the separator-preserving push) stay in their modules.
- Error contract preserved verbatim: release-held-before-report, with the
  tool-use-ids module's documented guarantee as the authoritative wording.

Before (inside the streaming wrapper in `src/think-tags.ts`, at the anchor where the
read pump opens — the block neighboring the `processFrames` and `flushHeld`
definitions):

```typescript
// pump: reader.read → frames.append → processFrames → flushHeld/takeRemainder tail
// transform above: ThinkTagStripFilter.push (separator-preserving)
```

Before (inside the streaming wrapper in `src/tool-use-ids.ts`, at the anchor where
the read pump opens — the block neighboring function `rewriteOne` and function
`processFrames`):

```typescript
// pump: reader.read → frames.append → processFrames → flushHeld/takeRemainder tail
// transform above: rewriteOne
```

After (both anchors):

```typescript
const stream = createSseTransformStream({ processFrames, flushHeld, takeRemainder: () => frames.takeRemainder() });
```

Data-line adoption contract: `iterateDataPayloads` is made public (it is currently
module-private in `src/sse.ts`) with its existing semantics (blank-line frame split,
per-frame `data:` collection, newline join).

Before (inside function `inspectEvent`, at the anchor where the `data:`-line
split-filter-map-join-trim sequence begins):

```typescript
// inline data:-line split / filter / map / join / trim, then the [DONE]-guard tail
```

After (same anchor, and identically inside function `captureEventModel` and inside
function `suppressRelayAddedOpenAiUsageFrames` with their respective tails kept):

```typescript
for (const data of iterateDataPayloads(raw)) {
  // ... existing tail ([DONE] guard / return-shape / usage-shape check) ...
}
```

## Step-by-step implementation sequence

1. Make `iterateDataPayloads` public in `src/sse.ts` without changing its semantics;
   rewire function `inspectEvent` first, verify, then function `captureEventModel`,
   then function `suppressRelayAddedOpenAiUsageFrames`. Leave both boundary-split
   loops inline.
2. Add `createSseTransformStream` to `src/sse.ts` built on `BufferedSseFrames`,
   implementing the verified pump plus the shared tail (error frame plus close).
3. Rewire the `think-tags.ts` wrapper to the scaffold, keeping its
   `ThinkTagStripFilter` transform inline; verify with the think-tags suites.
4. Rewire the `tool-use-ids.ts` wrapper to the scaffold, keeping `rewriteOne`
   inline; verify with the tool-use-ids suites.
5. Phase the remaining SEM-02 sites (backend `data:` sites, dialect-stream,
   openai-dialect) onto `iterateDataPayloads` plus frame visitors without changing
   their visitor semantics.
6. Run the verification plan below after each rewire.

## Verification and regression test plan

```powershell
npm test -- test/sse.test.ts
npm test -- test/stream-pipeline.test.ts
npm test -- test/mid-stream-failure.test.ts
npm test -- test/accounting-lifecycle.test.ts
npm test -- test/think-tags.test.ts
npm test -- test/tool-use-ids.test.ts
npx tsc --noEmit
```

(If the last two suite files live under different names in the working tree, run the
closest think-tags and tool-use-ids suites plus the owning directory suite.)

Invariant assertions:

- SSE byte-equivalence: the scaffold emits byte-identical streams for the
  think-tags and tool-use-ids fixtures, including the `event: error` trailer and
  close semantics.
- `iterateDataPayloads` parity: each adopted site yields the same payload sequence
  as its inline triple on a corpus containing multi-`data:` frames, CRLF line
  endings, `[DONE]` sentinels, and usage frames.
- No wrapper imports another wrapper; all wrapper-to-SSE edges point at
  `src/sse.ts` or `src/sse-frames.ts`.
- No line-number references introduced.
