# Stage 0 credential fleet — Spark implementation plan (2026-08-16)

This plan implements the immediate work in [`HANDOFF.md`](../HANDOFF.md). It is intentionally
specific enough for a weak implementation agent to execute without making design decisions.

Baseline when this plan was written: clean worktree at `1751f1c`.

## Current worktree status — Packet 1 complete

Packet 1 was completed on 2026-08-17. Provider-aware credential resolution now searches the
declared environment family and configured-provider-derived aliases, public fronts strip inbound
caller credentials when a provider key is declared, and catalog-backed dynamic reshapers retain
the resolved candidate provider. The focused resolver, public-front, and dynamic-reshaper
regressions are covered by Vitest. Stage 1 (multi-key pooling) may begin after this Stage-0
implementation is landed separately.

The following historical review notes are resolved by the completed implementation:

1. `src/authEnv.ts:114-125`: an explicit configured provider name suppresses the curated alias
   family inferred from the declared environment name. For example,
   `resolveCredential("ANTHROPIC_API_KEY", { ANTHROPIC_AUTH_TOKEN: "sk" }, "claude")`
   returns `declared-missing`. Search both families, with the declared name first:
   - curated aliases inferred from `declaredAuthEnv`;
   - aliases derived from the explicit configured provider name.
   The current `/v1/messages` integration test returns 502 because of this defect.
2. `src/server.ts:264-270`: the catalog-backed dynamic reshaper-pool constructor omits
   `provider: candidate.provider` when it creates `HttpReshaper`. A repair attempt can therefore
   lose a provider-derived credential even though fixed-pool and per-target reshapers carry it.

Historical gate notes (resolved):

1. `npm run build && npm run check` is red. `typecheck:test` reports six errors:
   - `test/credential-containment.test.ts:65,92` assign explicit `undefined` to an exact-optional
     `auth` property;
   - `test/credential-containment.test.ts:286,326` omit required `routing.tiers`;
   - `test/registry.test.ts:47,51` call `beforeEach` and `afterEach` without importing them.
2. Scoped Vitest execution has two failing credential tests and one collection failure:
   - `test/credential-containment.test.ts:189` expects `GOOGLEAI_API_KEY` for a blank alias, but a
     missing credential must retain the declared diagnostic name `GEMINI_API_KEY`;
   - the `/v1/messages` test at line 301 returns 502 because of the resolver defect above;
   - `test/registry.test.ts` fails collection because its hooks are not imported.
3. `git diff --check` fails because `test/credential-containment.test.ts` has a new blank line at
   EOF.
4. The new environment fixtures restore saved values and then delete them at
   `test/credential-containment.test.ts:305-306,343-344`. Restore alone; do not destroy a value
   that existed before the test. The Anthropic fixture also clears candidates for provider
   `anthropic` while the configured provider is `claude`, leaving `CLAUDE_*` derived aliases
   ambient.

Required Packet 1 coverage still missing or ineffective:

- The atomic `resolveCredential()` matrix lacks undeclared ambient, missing, blank, whitespace in
  the declared variable, trimmed direct value, and a true provider-derived alias case.
- The two tests named "provider-derived" use curated aliases (`ANTHROPIC_AUTH_TOKEN` and
  `GOOGLEAI_API_KEY`). Add a custom/configured-provider-derived case such as
  `<PROVIDER>_API_KEY`; it must fail if `providerName` is not threaded.
- Add `loadConfig()` tests proving `authEnv: ""` and whitespace plus
  `credentialMode: "passthrough"` create no credential declaration.
- The Anthropic public-front mock records only `x-api-key`; also capture and assert that the
  caller's inbound `authorization` header is absent at the backend.
- Add the planned catalog and reshaper single-`Bearer` integration tests.
- Add telemetry tests proving whitespace is absent and aliases are present.
- Make `test/config.test.ts:132-150` save, clear, and restore every credential candidate instead
  of deleting the developer's ambient values. Its "adopts an alias" title is now stale because
  config intentionally retains the declared name.

Stage-0 closeout verification:

```powershell
npm run build && npm run check
git diff --check
```

Packet 1 is complete; the full gate and focused regressions are the acceptance evidence for this
stage. Stage 1 must begin from a separately landed Stage-0 commit.

## Scope decisions

Implement only:

- normalized credential resolution;
- stable credential-slot identity;
- credential-keyed breaker health and target facts;
- safe target-facts and refusal-interpretation migrations;
- typed quota observations;
- provider-reported completion-token capture on both request fronts.

Do not add multi-key configuration or selection, custody, keystores, usage ledgers, currency
costs, limits enforcement, leases, credential response headers, dashboards, or new HTTP control
surfaces.

Important corrections to preserve:

- Keep `keyIsPresent(value)` as the trimmed raw-value predicate.
- OpenAI traffic already records calls, successes, and latency. Only reported token usage is
  missing, for both streaming and buffered responses.
- Runtime performance telemetry remains deployment-keyed. Future credential accounting belongs
  in the usage ledger.
- Detailed quota stays on token-gated `/candidates`; `/telemetry` remains provider-level and
  exposes no credential labels or balances.

## Core contracts

Add these exact concepts:

```ts
// src/credential-id.ts
declare const credentialIdBrand: unique symbol;

export type CredentialId =
  string & { readonly [credentialIdBrand]: true };

export const DEFAULT_CREDENTIAL_LABEL = "default";
export const CREDENTIAL_LABEL_PATTERN = /^[A-Za-z0-9_.-]{1,32}$/;

export function makeCredentialId(
  provider: string,
  label?: string,
): CredentialId;

export function parseCredentialId(
  value: string,
): { provider: string; label: string } | null;
```

The ID is exactly `<provider>#<label>`. It identifies the configured slot, never the key,
environment variable, digest, or storage location.

```ts
// src/authEnv.ts
export interface CredentialResolution {
  state: CredentialState;
  value: string | undefined;
  envName: string | undefined;
}

export function resolveCredential(
  declaredAuthEnv: string | undefined,
  env?: NodeJS.ProcessEnv,
  providerName?: string,
): CredentialResolution;
```

`credentialState()` and `readCredential()` become wrappers over this result. Undeclared
providers must never acquire an ambient credential.

```ts
// Application layer, not kernel.
export interface ResolvedAttempt {
  target: ResolvedTarget;
  credentialId: CredentialId;
  credential: CredentialResolution;
}
```

For this implementation every target receives `<provider>#default`. There is still no
`credentials[]` configuration.

At the kernel boundary, add required opaque `credentialId: string` to
`ProviderTargetIdentity`. The kernel cannot import `credential-id.ts` because its architecture
test permits sibling imports only.

## Ordered implementation packets

### 1. Credential resolution normalization

Files:

- `src/authEnv.ts`
- `src/config.ts`
- `src/server.ts`
- `src/catalog.ts`
- `src/reshaper.ts`
- `src/telemetry.ts`
- `src/candidates.ts`
- `src/registry.ts`
- `src/onboarding.ts`

Required behavior:

1. Add `resolveCredential()` and delegate `credentialState()` and `readCredential()` to it.
2. Preserve all three states exactly.
3. Trim a present value once.
4. Missing declarations retain their declared environment name for diagnostics.
5. Keep `keyIsPresent()` unchanged and use it inside the resolver.
6. In config parsing, compute one normalized `declaredAuthEnv` and use it for both validation and
   output. Empty or whitespace `authEnv` must not survive as a declared credential.
7. Pass provider names into resolver calls so provider-derived aliases work.
8. Preserve `resolveTargets()`' survivor rule: remove missing-key targets only when another target
   survives.
9. In `buildForwardHeaders()`, resolve state and value once. Continue stripping caller credentials
   for declared or contained targets, throwing before provider egress when declared-missing.
10. Use `buildAuthHeaders()` rather than hand-building bearer headers.
11. Migrate catalog, reshaper, telemetry, candidate, registry, and onboarding presence reads away
    from direct `process.env[...]` access.

Tests:

- Resolver matrix: undeclared ambient, missing, blank, whitespace, direct, curated alias, and
  provider-derived alias.
- `authEnv: ""` and whitespace with passthrough do not create an auth declaration.
- Alias-only authentication succeeds through both `/v1/messages` and OpenAI Chat.
- Client authorization never leaks to the backend.
- Catalog and reshaper preserve a single `Bearer` prefix.
- Telemetry treats whitespace as absent and aliases as present.

### 2. Attempt identity and circuit-breaker keying

Files:

- new `src/credential-id.ts`
- new `src/resolved-attempt.ts`
- `src/kernel/contracts.ts`
- `src/kernel/request-lifecycle.ts`
- `src/circuit-breaker.ts`
- `src/server.ts`
- `src/backend.ts`
- `src/candidates.ts`
- `src/telemetry.ts`

Required behavior:

1. Convert resolved targets to `ResolvedAttempt` records before usability ordering.
2. Pass `ResolvedAttempt` through both candidate loops and backend adapters.
3. Use the attempt's single credential resolution for containment and backend authentication; do
   not re-read the environment inside the same attempt.
4. Add credential identity to both lifecycle equality checks. Completing a handle under another
   credential must return `cross-target`.
5. Breaker keys become:
   - `provider#label/model`
   - `provider#label` for modelless targets
6. Remove ambiguous raw `provider/model` strings from cell-level breaker APIs. Do not add a hidden
   legacy/default fallback.
7. Cell-only operations are `isHealthy`, `hasCredentialFault`, `getState`, credential-fault
   writes, header observations, and terminal completion.
8. Deployment-level stability operations aggregate every credential cell for the same
   provider/model:
   - merge ping samples;
   - sort merged samples by timestamp;
   - base confidence on the minimum sample count per contributing cell, not the total merged
     count.
9. Store identity alongside each breaker state. Do not reverse-parse provider/model from the
   serialized key.
10. Replace `clearProviderCredentialFaults(provider)` with
    `clearCredentialFaults(credentialId)`.
11. A success clears only its own cell. Credential-wide clearing happens only when a stated
    `credential-invalid` fact is disproved.
12. Usability ordering must partition and concatenate attempts; it must never shorten the
    candidate list.
13. Provider telemetry aggregates cells, counts unique deployments, and reveals no credential
    IDs.

Tests:

- Credential ID grammar and implicit default.
- Modelless key is `provider#default`.
- Same provider/model under two IDs remains isolated for 401, 402, 429, cooldown, and success.
- Cross-credential lifecycle completion is rejected.
- `clearCredentialFaults()` affects only one ID.
- Merged samples are timestamp-sorted.
- Five one-sample cells produce one-sample confidence, not five-sample confidence.
- Telemetry deduplicates deployments and contains no credential label.

### 3. Target-facts v2 and refusal migration

Files:

- `src/target-facts.ts`
- `src/refusal-interpretation.ts`
- `src/context-limits.ts`
- `src/dynamic-pools.ts`
- `src/server.ts`
- `src/candidates.ts`
- `src/cli.ts`

Use these six scopes and this exact precedence:

```ts
type FactScope =
  | { kind: "attempt"; provider: string; credentialId: CredentialId; model: string }
  | { kind: "group"; provider: string; credentialId?: CredentialId; members: string[] }
  | { kind: "deployment"; provider: string; model: string }
  | { kind: "credential"; provider: string; credentialId: CredentialId }
  | { kind: "provider"; provider: string }
  | { kind: "model"; model: string };

const SCOPE_PRECEDENCE = [
  "attempt",
  "group",
  "deployment",
  "credential",
  "provider",
  "model",
] as const;
```

All fact-query APIs require `credentialId: CredentialId | null`:

```ts
factsFor(provider, credentialId, model, opts?)
isCostBlocked(provider, credentialId, model, opts?)
cooldownUntil(provider, credentialId, model, opts?)
clearFacts(provider, credentialId, model, opts?)
```

`null` must never match attempt, credential, or credential-bound group facts. It may still match
deployment, provider, model, or all-credential group facts.

Canonical keys:

```text
a:<credentialId>/<model>
g:c:<credentialId>/<sorted-members>
g:p:<provider>/<sorted-members>
d:<provider>/<model>
c:<credentialId>
p:<provider>
m:<model>
```

Store rules:

- Bump to version 2.
- A v1 file immediately behaves as an empty v2 store.
- Do not migrate even apparently safe v1 facts.
- Validate every v2 entry: fact kind, scope fields, finite timestamps/value,
  credential/provider agreement, and canonical storage key.
- Drop malformed entries individually.
- Learned-store errors remain best-effort and never block startup or requests.
- `clearFacts()` continues clearing conditions only, never measurements such as `context-limit`.
- Success clears only facts covering its exact credential/model cell.

Refusal templates gain `attempt` and `credential`. Represent group widening explicitly:

```ts
{ kind: "group"; members: string[]; credential: "attempt" | "all" }
```

Change materialization to:

```ts
materializeScope(template, provider, credentialId, model)
```

Interpretation-store migration:

- Bump it to version 2.
- Accepted v1 `{kind:"provider"}` interpretations stop binding and return to the pending queue.
- Do not rewrite them automatically as `credential` or new `provider`.
- Strip unaccepted legacy provider proposals so an ordinary accept cannot widen them accidentally.
- Preserve ignored entries and unambiguous templates where safe.
- Legacy groups migrate to credential-bound groups.
- If a signature cannot be reconstructed safely, drop it; the refusal will queue again.

Re-triage shipped interpretations:

- "not found for account" -> `attempt`
- model subscription/plan entitlement -> `attempt`
- generic missing or retired model -> `deployment`
- quota/credits/balance -> `credential`
- invalid or revoked key -> `credential`
- account/project/key rate limiting -> `credential`
- structured project+model quota -> `attempt`
- unrecognized structured dimensions -> `attempt`

CLI behavior:

- Accept and display all six scopes.
- A group defaults to the current credential.
- Widening a group across credentials requires an explicit `--all-credentials`-style option.
- Never infer widening from omitted input.

### 4. Typed quota observations

Add `src/quota-observation.ts`:

```ts
export type QuotaAxis = "requests" | "tokens";
export type QuotaPeriod = "minute" | "day" | "month" | "unknown";

export interface QuotaObservation {
  axis: QuotaAxis;
  period: QuotaPeriod;
  limit: number;
  remaining: number;
  resetsAt: number | null;
  observedAt: number;
  basis: "provider-stated";
}
```

Also provide:

```ts
extractQuotaObservations(headers, options): QuotaObservation[]
mergeQuotaObservations(...sets): QuotaObservation[]
headroomPercent(observation): number
```

Parser rules:

- Return every valid explicit pair, not the first pair.
- Requests/day and tokens/minute in one response remain two observations.
- Strict numeric parsing only; reject partial `parseFloat` values.
- Require finite `remaining >= 0` and `limit > 0`.
- Unsuffixed explicit request/token headers use period `unknown`.
- Ignore truly generic `remaining/limit` headers whose axis is unstated.
- Parse a paired reset header only when its format is unambiguous.
- A valid `Retry-After` may provide `resetsAt` only for a zero-remaining observation; it must not
  invent an axis.
- Percent is render-time derivation only and is never persisted.

Integration:

- Replace `CircuitState.quotaPercent` with `quotaObservations`.
- Header observations commit typed quota to the exact credential/model cell.
- Preserve separate axes when new headers mention only one.
- Commit valid quota metadata on upstream success or failure, including credential failures; it
  is independent of health classification.
- Replace `PingLoop.latestQuota: Map<provider,...>` with a map keyed by credential ID and model.
- Current synthetic probes use the implicit default ID.
- Remove `ProbeEntry.quotaPercent`, bump probe version once, and do not reinterpret old scalar
  data.
- Probe health remains deployment-level.
- Merge fresh live breaker observations and synthetic-probe observations for candidate output.
- Retain `extractQuotaPercent()` only as a deprecated compatibility wrapper returning a value
  when exactly one unambiguous typed observation exists. No production caller may use it.
- Leave `src/ping/quota.ts` alone; its explicit credit-balance percentage is a different
  measurement.

Surfaces:

- Add `credentialId` and `quota: QuotaObservation[]` to token-gated candidate rows.
- Remove provider-level `quota_percent` from registry output.
- Remove quota from `/telemetry`; no honest provider-wide scalar can be derived from
  credential/model observations.
- CLI quota rendering must print axis, period, raw remaining/limit, basis, and age. Unknown
  renders `-`.
- Do not route, filter, or score candidates using quota in this implementation.

### 5. Reported completion-token capture

Add `src/usage-observer.ts` with:

- protocols `anthropic-messages`, `openai-chat`, and `openai-responses`;
- a per-attempt accumulator whose completion token value starts `undefined`;
- a synchronous pass-through stream observer;
- a bounded SSE pending-frame buffer, about 16 KiB;
- a bounded buffered-JSON parser, about 1 MiB; overflow becomes unknown;
- no `Response.clone()`;
- no throwing, awaiting, byte withholding, or byte modification;
- finite, nonnegative safe-integer validation;
- last-valid-cumulative-value semantics, never frame summing;
- preservation of a genuinely reported zero.

Protocol extraction:

- Anthropic JSON: `usage.output_tokens`
- Anthropic SSE: terminal `message_delta.usage.output_tokens`; ignore `message_start`'s seed zero
- Chat JSON/SSE: `usage.completion_tokens`
- Responses JSON: `usage.output_tokens`
- Responses SSE: `response.completed.response.usage.output_tokens`

Attach the observer to provider-native responses inside backend adapters:

- Anthropic backend response -> Anthropic observer.
- OpenAI Chat backend response -> Chat observer.
- Do this before translation, preflight, validation, repair, or public-front conversion.
- This avoids recording mapper-manufactured zeros.
- Pass one accumulator from `HealthAttempt` through both public request fronts.

Direct OpenAI streaming:

- If the caller did not request usage, add `stream_options.include_usage: true` internally.
- Observe the provider's usage-only frame.
- Suppress only the relay-added usage frame before returning bytes to a caller who did not
  request it.
- Keep suppression separate from the no-delay observer.
- If the provider rejects the added option with 400/422, retry once with the original request
  and leave usage unknown.
- If the caller requested usage, preserve the frame.

Truth correction:

- `openAiResponseToAnthropic()` must omit `usage` when the provider omitted it. Never manufacture
  `{input_tokens:0, output_tokens:0}`.

Recorder wiring:

- Add an injectable `ModelCallRecorder` to `ProxyDeps`/`Handlers`.
- The default recorder may continue skipping filesystem writes under Vitest.
- An injected recorder must run during tests.
- Centralize recording in existing success/failure completion helpers.
- Pass `completionTokens` only when the accumulator contains a reported value.
- Do not add another record call in the OpenAI loop; that would double-count calls already
  recorded.
- Cancellation accounting and per-egress retry accounting remain later usage-ledger work.

Runtime telemetry:

- Bump its schema to v2.
- Add `completionTokenCalls`.
- Missing usage increments neither token total nor coverage.
- Reported zero increments coverage.
- Migrate v1 call/latency data, but reset the unwired token total and coverage to zero.
- Validate finite counters instead of casting arbitrary JSON.
- In candidate output expose:

```ts
completionTokens: {
  reported: number | null;
  reportedCalls: number;
  totalCalls: number;
}
```

When coverage is zero, `reported` is `null`, not `0`.

## Required test matrix

Spark is not done without all of these:

1. Credential resolver and ID tests described above.
2. Target-facts v2 tests:
   - v1 yields zero facts and no demotion;
   - malformed v2 rows drop;
   - all six scopes and precedence;
   - personal/work isolation;
   - `credentialId=null` fail-closed behavior;
   - credential-bound versus all-credential groups;
   - conditions clear while measurements remain;
   - persisted provider interpretation becomes pending.
3. Breaker/lifecycle tests:
   - cross-credential completion rejection;
   - per-cell 401/402/429 isolation;
   - credential-specific clearing;
   - timestamp-sorted aggregate samples;
   - minimum-per-cell confidence.
4. Quota parser tests:
   - one response carrying requests/day 25/100 and tokens/minute 800/1000 produces two
     observations;
   - invalid, incomplete, zero-limit, and generic-axis pairs are ignored;
   - merge replaces only the matching axis/period tuple;
   - serialized observations contain no percentage.
5. Pure usage-observer tests:
   - byte-by-byte and awkward chunk boundaries;
   - LF and CRLF SSE;
   - Anthropic, Chat, and Responses formats;
   - terminal value wins without summing;
   - malformed, negative, and unsafe values stay unknown;
   - oversized frames recover for a later terminal frame;
   - output bytes exactly match input;
   - observer callbacks never throw into the stream.
6. Both-front integration tests, always with at least two candidates:
   - first candidate returns a retriable failure with unknown usage;
   - winner reports an exact completion count;
   - buffered and streamed `/v1/messages`;
   - buffered and streamed OpenAI Chat, plus a Responses case;
   - one recorder event per attempted candidate and no duplicate OpenAI event;
   - a repair path proving observation survives validation/repair;
   - include-usage rejection/retry leaves usage absent, not zero.
7. Surface tests:
   - candidate quota is tied to the exact credential/model;
   - two models do not overwrite each other's quota;
   - runtime token total and coverage survive reload;
   - `/telemetry` has no credential or quota fields;
   - registry has no provider scalar quota;
   - CLI identifies quota axis, period, and basis.

## Explicit non-goals

- `credentials[]` configuration or multi-key selection
- credential-round expansion or same-provider retry policy
- custody, keyrings, keystores, encryption, or import flows
- concurrency leases
- usage ledger, sliding windows, cost arithmetic, or currency totals
- input/cached/estimated token accounting
- quota-based routing, filtering, scoring, or enforcement
- credential response headers or log fields
- dashboard or new `/usage`/`quota` endpoints
- complete per-egress accounting for `stream_options` retries, disabled-thinking retries, or
  reshaper calls

Health and quota evidence may demote, never drop. Repair continues to fix protocol form, never
judgment. Logs remain metadata-only.

## Completion gate

Run exactly:

```powershell
npm run build
npm run check
```

Then run `git diff --check` and inspect the full diff for:

- accidental credential values;
- direct credential environment reads;
- old breaker key shapes;
- production `quotaPercent` consumers;
- fabricated token zeros;
- behavior wired to only one public request front.
