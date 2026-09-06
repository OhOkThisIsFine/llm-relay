# P1-05 — Protocol-Aware Error Envelope Normalization (SEM-01)

Scope: reconcile the admin `failClosed` shadow with the shared `failClosed` in
`src/stream-pipeline.ts` without changing any wire shape until envelope parity is
proven. Adversarial verdict: REFINE per
`docs/reviews/adversarial-verification-2026-09-05.md` — contract test plus consumer
check first, then replace.

## Architectural rationale and layering

Target location: keep the canonical implementation in `src/stream-pipeline.ts`
(function `failClosed`) and reduce function `failClosed` in `src/routes/admin.ts` to
a constrained caller of it. Rationale:

- The shared implementation is the lower-layer primitive (HTTP terminal-error
  writer with `headersSent` guard, `extraHeaders`, and `errorType` parameters). The
  admin route is the higher-layer consumer. Making the route depend on the pipeline
  module follows the existing direction (routes already import pipeline helpers) and
  introduces no cycle.
- The reverse (moving envelope logic into the admin route) would force every other
  `failClosed` consumer onto an admin-route import, inverting the layer.
- The `headersSent` guard, `extraHeaders`, and `errorType` parameters are load-bearing
  pipeline semantics; the admin copy has none of them. Unification must add
  capability to the admin path, never remove it from the shared path.

## Complete blast radius

Divergent definitions:

- Function `failClosed` in `src/stream-pipeline.ts` — the shared writer emitting the
  `{ type: error, error: { type: errorType, message } }` envelope with the
  `headersSent` guard and optional `extraHeaders` / `errorType` parameters.
- Function `failClosed` in `src/routes/admin.ts` — the shadow emitting the
  `{ error: { type: error, message } }` envelope with no `headersSent` guard and no
  extra parameters. The gaps verified as understated by the catalog: the top-level
  `type` member, the inner-type default (`api_error` versus `error`), the guard, and
  the parameters.

Callers of the shared writer (behavior must not change):

- All call sites resolving to `failClosed` in `src/stream-pipeline.ts` observed in
  the graph, including the settlement exit inside function `endWalk` in
  `src/candidate-runner.ts` (the Anthropic branch passes headers and error type
  through to the shared writer).

Callers of the shadow (behavior must be proven equivalent before rewiring):

- The management-surface handlers inside `src/routes/admin.ts` that close over the
  module-local `failClosed` — enumerate by searching for the bare `failClosed(`
  call shape inside that module; every match is in scope.

Envelope consumers (the parity surface):

- Every client parsing admin error bodies for the `{ error: { type, message } }`
  shape versus the `{ type, error: { type, message } }` shape — dashboard code,
  CLI admin-view code, and any test helper asserting on admin error JSON.
- Sibling envelope builders that must stay consistent: function `sseError` and
  function `openAiSseError` in `src/stream-pipeline.ts`, function `emitSse` and
  function `emitSseTail` in `src/emitSse.ts`.

Suites: admin-route suites, `test/stream-pipeline.test.ts`, dashboard suites, and any
contract suite asserting on admin error JSON.

## Specific code modifications with contracts

Canonical contract (already exists in `src/stream-pipeline.ts`, restated as the
invariant):

```typescript
export function failClosed(
  res: ServerResponse,
  status: number,
  message: string,
  extraHeaders?: Record<string, string | string[]>,
  errorType?: string,
): void;
```

- Emits `{ type: "error", error: { type: errorType, message } }` with a JSON
  content type, unless the headers are already sent (then it ends the response
  without writing a head).
- `errorType` defaults to the pipeline default; callers that need the admin legacy
  inner type pass it explicitly during the migration window (see below).

Before (inside `src/routes/admin.ts`, at the anchor of the module-local definition
neighboring the admin request handlers):

```typescript
function failClosed(res: ServerResponse, status: number, message: string): void {
  res.writeHead(status, { "content-type": "application/json" });
  res.end(JSON.stringify({ error: { type: "error", message } }));
}
```

After (same anchor — the definition is deleted and replaced by a constrained import
plus a compat alias that preserves the legacy wire shape until parity is proven):

```typescript
import { failClosed as pipelineFailClosed } from "../stream-pipeline.js";

function failClosed(res: ServerResponse, status: number, message: string): void {
  pipelineFailClosed(res, status, message, undefined, "error");
}
```

Follow-up (only after the parity test and consumer check pass): delete the alias and
call `pipelineFailClosed` directly at each admin call site, letting the inner type
and the top-level `type` member converge on the shared contract. That follow-up is a
separate commit gated on the verification below — this plan does not authorize a
same-day wire-shape change.

Parity test contract (new test, admin envelope suite):

```typescript
// For each admin failure fixture: assert the response body parses, carries the
// documented envelope members, and is accepted by every known admin error consumer.
```

## Step-by-step implementation sequence

1. Add an envelope-parity test that captures the current admin wire shape (legacy
   `{ error: { type, message } }`) for every admin failure fixture and asserts each
   known consumer accepts it. This test must pass before any production change.
2. In `src/routes/admin.ts`, replace the body of the module-local `failClosed` with
   a delegation to `pipelineFailClosed` passing the legacy inner type explicitly
   (per the after-block above). No call site changes in this step.
3. Run the parity test plus the admin and pipeline suites; the wire shape must be
   byte-identical to step one.
4. Audit every admin error consumer for top-level-`type` tolerance; record the
   result in the commit message.
5. Only when step four shows all consumers accept the shared envelope, delete the
   alias and rewire each admin call site to `pipelineFailClosed` with the shared
   defaults. Ship that as its own commit with the consumer evidence attached.

## Verification and regression test plan

```powershell
npm test -- test/admin.test.ts
npm test -- test/stream-pipeline.test.ts
npm test -- test/dashboard.test.ts
npm test -- test/server.test.ts
npx tsc --noEmit
```

(If the admin suite lives under a routes or dashboard directory name in the working
tree, run that directory suite in place of the first command and note the
substitution.)

Invariant assertions:

- Pre-migration: byte-identical admin error bodies before and after step two
  (the alias preserves the legacy inner type and the no-guard call sites gain only
  the `headersSent` guard, which is a no-op when headers are unsent).
- Post-migration (step five only): every admin error consumer accepts the shared
  envelope, proven by the parity test updated to the shared shape.
- Text search confirms exactly one `failClosed` definition remains (in
  `src/stream-pipeline.ts`) after step five, and none in `src/routes/admin.ts`.
- No line-number references introduced.
