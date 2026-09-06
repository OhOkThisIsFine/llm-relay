# HOTSPOT-10 — Backend Envelope-Validation Extraction (`src/backend.ts`, function `invalidEnvelopeReason`)

Scope: extract envelope inspection, provider-specific reason classification,
and stream health validation out of `src/backend.ts` (churn 48; max cognitive
89 in `invalidEnvelopeReason`; max cyclomatic 44-plus in the same function —
the sharpest single-function status-mapping spike behind SEM-04) into two
focused modules, leaving `src/backend.ts` as the fetch/translate orchestrator.
Adversarial verdict: ACCEPT per `docs/reviews/adversarial-verification-2026-09-05.md`
(table lookups; numbers provisional — confirm from `complexity-report.json`
before sizing).

Target modules:

- `src/backend/envelope-validator.ts` — `invalidEnvelopeReason`, the
  `ANTHROPIC_STREAM_EVENT_FIELDS` table, and the `ResponseProtocol` type
  (new home)
- `src/backend/health-prober.ts` — `preflightResponseStream`,
  `StreamPreflight`, `captureReportedModel`, `UpstreamResponseMetadata`
  (new home)
- `src/backend.ts` — keeps `fetchBackend`, `fetchOpenAiFront`, the OpenAI↔
  Anthropic translators, and all header/error- origin helpers; imports both
  new modules

## Architectural rationale and layering

Envelope validation is already a pure leaf: `invalidEnvelopeReason` reads an
unknown JSON value plus a protocol tag and returns a reason string or `null`,
depending only on the `isRecord` guard from `src/json-shape.ts` and the
stream-event table. Stream health probing (`preflightResponseStream`) is the
only I/O-bearing member, and it depends on the validator plus the
`STREAM_PREFLIGHT_LIMIT` constant that already lives in `src/stream-commit.ts`
— the probe does not belong to the commit module, and the limit does not move.

Layering, stated as import rules:

- `envelope-validator.ts` imports only `isRecord` (leaf) and declares the
  `ResponseProtocol` union plus the event-field table. It imports nothing
  from `backend.js` — today `ResponseProtocol` is a private type inside
  `backend.ts`, so the type declaration moves with the validator and
  `backend.ts` imports it back (type-only edge, no runtime cycle).
- `health-prober.ts` imports the validator, `STREAM_PREFLIGHT_LIMIT` from
  `stream-commit.js`, `captureReportedModel`-adjacent metadata types it
  declares itself, and `node:` stream/text types. It never imports fetch,
  translation, or credential logic.
- `backend.ts` imports both. No other module imports the private validator
  today, so the move has no fan-out — the four preflight call sites and four
  buffered-validation call sites below are all inside `backend.ts` itself.

This split is the precondition for the SEM-04/P2-4 status-verdict unification:
once the envelope classifier has a single home with a table-driven shape, the
status→verdict table can reference it instead of re-reading status codes at
each fetch site. The translators (`openAiResponseToAnthropic`,
`anthropicMessageToOpenAi`, `normalizeOpenAiErrorBody`) stay in `backend.ts` —
they are mapping policy, not validation, and moving them would widen this plan
into P2-4.

## Complete blast radius

Seed symbols (verified by direct source inspection):

- Function `invalidEnvelopeReason` in `src/backend.ts` — private envelope
  classifier. Its arms, each located by semantic anchor:
  - *Record guard*: non-record input yields the expected-object reason.
  - *Streamed in-band error*: a streamed payload carrying an `error` record is
    a dead turn, with the upstream message excerpt bounded (the adoption-review
    rationale quoted at the branch stays with the code).
  - *`openai-chat` arm*: choices-array presence, streamed empty-choices with
    usage tolerance, per-choice delta-versus-message selection, tool-call
    function name/arguments validation, and the neither-content-nor-tool-calls
    rejection for buffered messages.
  - *Anthropic buffered arm*: content-array presence with per-block
    text/tool_use shape checks.
  - *Anthropic streamed arm*: the `ANTHROPIC_STREAM_EVENT_FIELDS` table lookup
    (terminal events mapping to null-field, start/delta events to their
    payload field, error events to the error field) with the missing-field
    reason.
- Table `ANTHROPIC_STREAM_EVENT_FIELDS` — the terminal/start/delta/error
  event-to-payload-field map consumed only by the streamed arm.
- Type `ResponseProtocol` — private union consumed by the validator, the
  prober, and the fetch sites; moves to the validator module.
- Function `captureReportedModel` — provenance observer (message_start
  unwrapping for streamed Anthropic envelopes, `model`-string capture);
  consumed by the prober's inspect and capture paths. Moves with the prober.
- Function `preflightResponseStream` with nested `captureCompleteEvents`,
  `replay`, `fail`, `inspectEvent`, `captureEventModel` — first-event
  inspection with chunk replay, the `[DONE]`/invalid-JSON reasons, the
  buffered-completion tolerance for providers ignoring `stream: true`, and
  the preflight-limit failure. Moves verbatim.
- Type `StreamPreflight` and interface `UpstreamResponseMetadata` — move with
  the prober (re-export the interface from `backend.ts` if any external
  importer exists; verify by text search first).
- Function `nativeResponseIsStreamed` — stays in `backend.ts` (it answers a
  fetch-site question about the native response versus `wantsStream`, not an
  envelope question).
- Function `suppressRelayAddedOpenAiUsageFrames` — stays (stream transform,
  SEM-02/P2-3 material, not validation).
- Call sites, all inside `src/backend.ts` (behavior must be identical):
  - The Anthropic fetch path: `nativeResponseIsStreamed` check, then the
    `preflightResponseStream` call tagged `"anthropic-messages"`, then the
    buffered `invalidEnvelopeReason` call tagged `"anthropic-messages"`.
  - The OpenAI-chat fetch path: same shape tagged `"openai-chat"`, including
    the usage-frame suppression branch selecting the response body.
  - The `fetchOpenAiFront` path: preflight plus buffered validation tagged
    `"openai-chat"`.
  - The translated-Anthropic fetch path (`fetchTranslatedOpenAiFront`
    family): preflight of the backend body tagged `"anthropic-messages"`
    plus buffered validation of the translated body.

Callers outside `backend.ts` are unaffected (they call `fetchBackend` /
`fetchOpenAiFront`, whose signatures do not change), but these suites pin the
reasons end to end and must stay green.

Affected test suites: `test/backend.test.ts`, `test/mid-stream-failure.test.ts`,
`test/dialect-stream.test.ts`, `test/stream-commit.test.ts` (limit constant
home), `test/attempt-lifecycle.test.ts`, `test/cancellation-evidence.test.ts`.

Imports and exports: the validator module exports `invalidEnvelopeReason`
plus the `ResponseProtocol` type; the prober module exports
`preflightResponseStream`, the `StreamPreflight` type, `captureReportedModel`,
and the `UpstreamResponseMetadata` type. `src/backend.ts` re-exports the
type(s) only if external importers exist.

## Specific code modifications with contracts

New contract in `src/backend/envelope-validator.ts`:

```typescript
import { isRecord } from "../json-shape.js";

export type ResponseProtocol = "openai-chat" | "anthropic-messages";

export function invalidEnvelopeReason(
  value: unknown,
  protocol: ResponseProtocol,
  streamed: boolean,
): string | null;
```

Contract:

- Returns `null` iff the payload is a usable envelope for the given protocol
  and stream mode; otherwise returns a stable, assertion-safe reason string.
  Reason strings are byte-identical to today's (fetch-path tests and
  candidate-walk logging match on several: the missing-choices, empty-choices,
  in-band-error, unknown-event, and neither-content-nor-tool-calls texts).
- Pure and total: no I/O, no clock, no allocation beyond the reason string;
  safe to call on every candidate response, as the four buffered call sites
  do today.

New contract in `src/backend/health-prober.ts`:

```typescript
import type { ResponseProtocol } from "./envelope-validator.js";

export interface UpstreamResponseMetadata {
  reportedModel?: string | undefined;
  // …remaining fields unchanged from today's interface…
}

export type StreamPreflight =
  | { ok: true; body: ReadableStream<Uint8Array>; metadata: UpstreamResponseMetadata }
  | { ok: false; reason: string };

export function captureReportedModel(
  metadata: UpstreamResponseMetadata,
  value: unknown,
  protocol: ResponseProtocol,
  streamed: boolean,
): void;

export function preflightResponseStream(
  body: ReadableStream<Uint8Array>,
  protocol: ResponseProtocol,
): Promise<StreamPreflight>;
```

Contract: `preflightResponseStream` resolves `ok: true` with a replayable body
and observed metadata exactly when the first data event validates (or a
genuine buffered envelope validates under the ignore-stream tolerance);
otherwise cancels the reader and resolves `ok: false` with today's reason
strings (`stream failed during preflight`, `stream ended before a response
event`, `data event is not valid JSON`, `no response event within preflight
limit`, and whatever `invalidEnvelopeReason` returns for the first event).

Before (representative — inside the Anthropic fetch path in `src/backend.ts`,
at the stream-intake site following the `nativeResponseIsStreamed` check):

```typescript
const nativeStreamed = nativeResponseIsStreamed(native, args.wantsStream);
// …later, at the body-intake anchor:
const preflight = await preflightResponseStream(res.body, "anthropic-messages");
// …and at the buffered-validation anchor:
const invalidReason = invalidEnvelopeReason(body, "anthropic-messages", false);
```

After (same anchors — only the imports change; call shapes are identical):

```typescript
import { invalidEnvelopeReason, type ResponseProtocol } from "./backend/envelope-validator.js";
import { preflightResponseStream } from "./backend/health-prober.js";

// …at the same intake anchors, unchanged bodies:
const preflight = await preflightResponseStream(res.body, "anthropic-messages");
const invalidReason = invalidEnvelopeReason(body, "anthropic-messages", false);
```

The private `type ResponseProtocol` declaration and the
`ANTHROPIC_STREAM_EVENT_FIELDS` table are deleted from `src/backend.ts`
(their single new home is the validator module); `captureReportedModel`,
`preflightResponseStream`, `StreamPreflight`, and `UpstreamResponseMetadata`
are deleted from `src/backend.ts` (new home: the prober module).

## Step-by-step implementation sequence

1. Create `src/backend/envelope-validator.ts` by moving the
   `ResponseProtocol` type, the `ANTHROPIC_STREAM_EVENT_FIELDS` table, and
   `invalidEnvelopeReason` verbatim; rewire the four buffered-validation call
   sites to import it; run the backend suites to pin the seam.
2. Create `src/backend/health-prober.ts` by moving
   `UpstreamResponseMetadata`, `StreamPreflight`, `captureReportedModel`, and
   `preflightResponseStream` (with all five nested closures) verbatim;
   rewire the four preflight call sites; keep the `STREAM_PREFLIGHT_LIMIT`
   import pointing at `stream-commit.js` (the constant does not move).
3. Delete the moved declarations from `src/backend.ts`; confirm
   `nativeResponseIsStreamed` and `suppressRelayAddedOpenAiUsageFrames` remain
   (they are fetch/transform policy, explicitly out of scope).
4. Run the verification plan below; delete no old code until all backend,
   stream, and lifecycle suites pass.

## Verification and regression test plan

Exact commands, run from the repository root:

```powershell
npm test -- test/backend.test.ts
npm test -- test/mid-stream-failure.test.ts
npm test -- test/dialect-stream.test.ts
npm test -- test/stream-commit.test.ts
npm test -- test/attempt-lifecycle.test.ts
npm test -- test/cancellation-evidence.test.ts
npx tsc --noEmit
```

Automated checks and invariant assertions:

- All listed suites pass with zero reason-string changes (the move is
  behavior-preserving by construction; several suites assert on the reason
  texts and on preflight-limit behavior).
- A targeted table test asserts `invalidEnvelopeReason` over a matrix of
  (protocol × streamed × envelope shape): empty object rejected, valid
  buffered `openai-chat` and `anthropic-messages` envelopes accepted,
  streamed in-band error rejected, unknown Anthropic event rejected, empty
  streamed choices without usage rejected and with usage accepted.
- Confirm by text search that `src/backend.ts` no longer defines the moved
  symbols, that each has exactly one definition, and that the prober imports
  nothing from `backend.js` (acyclicity).
- Confirm zero line-number references were introduced by this change (symbol
  anchors only, per this plan's mandatory constraint).
