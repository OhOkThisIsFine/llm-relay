# HOTSPOT-05 — Admin Route Handler Split (`src/routes/admin.ts`, function `handleAdminRoutes`)

Scope: split the monolithic `handleAdminRoutes` switch in `src/routes/admin.ts`
(churn 23; max cognitive 180; max cyclomatic 104 — highest cyclomatic in the
repo) into modular sub-route handlers, leaving `src/routes/admin.ts` as the
method-plus-path dispatcher that returns `true` when handled and `false`
otherwise.
Adversarial verdict: ACCEPT per `docs/history/reviews/adversarial-verification-2026-09-05.md`
(split switch).

Target modules:

- `src/routes/admin/status.ts` — read-only status and discovery reads
- `src/routes/admin/exhaustion.ts` — cooldown/exhaustion mutation
- `src/routes/admin/dispatch.ts` — dispatch ladder reads/mutations and
  telemetry ingest
- `src/routes/admin/offload.ts` — offload state reads/toggles
- `src/routes/admin/response.ts` — shared `ok` / `bad` / `failClosed` /
  `pickQuery` response helpers (new, leaf)
- `src/routes/admin.ts` — keeps `AdminHandlers`, `handleAdminRoutes` as the
  dispatcher, and re-exports for specifier stability

One adjudicated correction to the brief, verified by direct source inspection:
no keys branch exists anywhere in `handleAdminRoutes` — key management lives
in the CLI (`runKeysSubcommand` in `src/cli.ts` delegating to the `runKeys*`
verbs in `src/keys-cli.ts`) and has no admin HTTP surface. The brief's
`keys.ts` therefore has no source material; creating it would ship an empty
module. The fourth module is `offload.ts` instead, which is the actual fourth
branch family. The required filename set is otherwise honored exactly
(`telemetry` material lands in `dispatch.ts`, which owns the telemetry ingest
endpoints that share its ladder-membership logic).

## Architectural rationale and layering

Each branch family already depends only on the shared `AdminHandlers` port
(`catalog`, `pingLoop`, `logger`, `breaker`, `accountingReader`,
`accountingRecorder`) plus its own domain module — no branch reads another
branch's state, so the split follows existing seams instead of cutting new ones:

- `status.ts` → `relayModels`, `buildRegistry`, `buildCandidates`
  (pure reads over `cfg` plus the catalog/ping/breaker ports).
- `exhaustion.ts` → `clearCooldowns` over the breaker port.
- `dispatch.ts` → `buildDispatch`, `findLadderRung`, `markExhausted`,
  `clearExhausted`, `recordLaneRun`, `loadLaneManifest`,
  `contextWindowResolver` inputs, `getTelemetryReport`, plus the accounting
  write through `recordDispatchLaneAccounting` and the closed-union
  `TELEMETRY_FAILURE_KIND` table (which moves with its sole consumer).
- `offload.ts` → `offloadState`, `setOffload`, `unroutableOffloadClient`.
- `response.ts` ← imported by all four; imports only `node:http` types and
  `baseLog`. It owns the `ok`/`bad` closures' logic parameterized by
  `(res, logger, started, path)`, the local `failClosed` envelope, and
  `pickQuery`. Nothing imports `response.ts` except the admin family.

Layering rules: sub-route modules never import from the parent `admin.js`
(except the `AdminHandlers` type — type-only, erased at runtime — or, cleaner,
a `src/routes/admin/contracts.ts` holding the interface if the type-only edge
is deemed a smell); the parent imports all four. Sibling submodules never
import each other: the dispatch-telemetry POST branch's ladder-membership
check uses `findLadderRung` from `dispatch.js` directly, not a shared copy —
the comment at that branch already names the shared lookup as the authority.

SEM-01 interaction (explicitly staged, not folded in): the local `failClosed`
shadow moves verbatim into `response.ts`. Replacing it with the shared
`stream-pipeline.ts` export is P1-5's job and stays gated on its
envelope-parity precondition (the envelopes differ: local emits
`{ error: { type: "error", message } }`, shared emits a top-level `type`
plus headersSent guard). This plan moves the shadow without changing the wire
shape.

## Complete blast radius

Seed symbol (verified by direct source inspection):

- Function `handleAdminRoutes` in `src/routes/admin.ts` — the dispatcher,
  returning `true` when a branch handles the request and `false` on fallthrough.
  Its branches, each located by method-plus-path anchor:
  - *Models discovery*: GET on the models paths — `relayModels` shaped as the
    dual `data`/`models` list envelope.
  - *Registry*: GET on the registry path — `buildRegistry` with the optional
    ping-loop descriptor.
  - *Ping*: GET on the ping path — optional `tickOnce` then the mode/interval
    read.
  - *Health*: GET on the health paths — `buildRegistry` coerced to the
    provider-coarse view (credentials stripped) plus ping mode.
  - *Candidates*: GET on the candidates path — optional provider query filter
    via `pickQuery`, `buildCandidates` with catalog/breaker/ping ports plus
    the optional accounting reader.
  - *Cooldowns clear*: POST on the cooldowns-clear path — object-body guard,
    closed key set, per-field string validation, kinds-vocabulary check,
    unknown-provider check, then `clearCooldowns` over the breaker with a
    throw-to-400 mapping.
  - *Offload*: GET-or-POST on the offload path — query-client read,
    POST body validation (client non-empty, scope vocabulary, scope-requires-
    client, boolean enabled, unroutable-client fatality), then `setOffload`.
  - *Dispatch*: GET-or-POST on the dispatch path — POST outcome vocabulary
    and ttl/read-after/default precedence via `normalizeTtl` semantics,
    `clearExhausted`/`markExhausted` with ladder-membership 400s, task-length
    cap, host/entrypoint/tier/lane/after/client query shaping into
    `buildDispatch` with the cached manifest and cache-only context-window
    resolver, `source = "daemon"` stamp.
  - *Telemetry method guard*: GET-or-HEAD on the dispatch-telemetry path —
    explicit 404 so mistyped reads can never walk candidates or egress.
  - *Telemetry ingest*: POST on the dispatch-telemetry path —
    `parseTelemetryReport` shape guard, `findLadderRung` membership 400,
    `recordLaneRun`, then the kind-mismatch / relay-kind / relay-routed skip
    ladder, else `recordDispatchLaneAccounting`.
  - *Telemetry read*: GET on the telemetry path — `getTelemetryReport`.

Helpers moving to `src/routes/admin/response.ts`: the `ok` closure factory,
the `bad` closure factory, `failClosed`, `pickQuery`.

Helpers moving with their consumer: `TELEMETRY_FAILURE_KIND` and
`recordDispatchLaneAccounting` → `dispatch.ts`; `collectModelAliases` and
`relayModels` → `status.ts` (verify no other importer first; if shared,
leave in `admin.ts` and import).

Symbols staying in `src/routes/admin.ts`: `AdminHandlers`,
`handleAdminRoutes` (as dispatcher), and re-exports.

Callers and importers: `handle` in `src/server.ts` — the sole production
caller, awaiting `handleAdminRoutes` with the shaped request; signature and
`boolean` contract unchanged. `getTelemetryReport`, `recordLaneRun`,
`buildDispatch` and friends keep their home modules — this plan adds no new
exports to them.

Affected test suites: `test/admin-dispatch-telemetry.test.ts`,
`test/cooldown-clear.test.ts`, `test/telemetry.test.ts`,
`test/dispatch.test.ts`, `test/dispatch-exhaustion-persistence.test.ts`,
`test/mcp-telemetry-forwarding.test.ts`, `test/lane-manifest.test.ts`,
`test/server.test.ts`, `test/dispatch-lane-stats.test.ts`.

## Specific code modifications with contracts

Dispatcher contract (unchanged — restated as the invariant):

```typescript
export async function handleAdminRoutes(
  req: IncomingMessage,
  res: ServerResponse,
  pathname: string,
  path: string,
  started: number,
  reqJson: unknown,
  cfg: Config,
  h: AdminHandlers,
): Promise<boolean>;
```

- Returns `true` iff the method-plus-path matched a branch (handled, response
  already ended); `false` iff the request is not an admin route (caller falls
  through to serve routing). Branch order in the dispatcher is preserved
  exactly — several paths overlap in method but no two branches share a
  method-plus-path, so order is currently load-bearing only for readability;
  keep it anyway.
- Each sub-handler takes the same eight parameters and returns
  `Promise<boolean>`; the dispatcher awaits them in today's branch order and
  returns the first `true`.

Shared response contract in `src/routes/admin/response.ts`:

```typescript
import type { ServerResponse } from "node:http";
import type { MetadataLogger } from "../../log.js";

export interface AdminResponder {
  ok(body: unknown, pretty?: boolean): true;
  bad(status: number, message: string): true;
}

export function adminResponder(
  res: ServerResponse,
  logger: MetadataLogger,
  started: number,
  path: string,
): AdminResponder;

export function pickQuery(url: string, param: string): string | undefined;
```

Contract: `ok` writes the JSON envelope with the optional pretty flag and the
`baseLog` skipped record at status 200; `bad` writes the local `failClosed`
envelope (byte-identical shape) plus the `baseLog` record at the given status.
Both return `true` so branch bodies keep their `return ok(...)` /
`return bad(...)` shape.

Before (representative — inside function `handleAdminRoutes`, at the models
discovery branch with the `ok`/`bad` closures defined above it):

```typescript
const ok = (body: unknown, pretty = false): true => { /* …writeHead + end + baseLog… */ };
const bad = (status: number, message: string): true => { /* …failClosed + baseLog… */ };

if (req.method === "GET" && (pathname === "/v1/models" || pathname === "/models")) {
  const models = relayModels(cfg, { catalog: h.catalog });
  return ok({ object: "list", data: models, models });
}
```

After (same anchor — closures replaced by the responder, branch delegated):

```typescript
import { handleStatusRoutes } from "./admin/status.js";

// …at the top of handleAdminRoutes, replacing the closure definitions:
const { ok, bad } = adminResponder(res, h.logger, started, path);
void ok; void bad; // (only until every branch below is delegated; then removed)

if (await handleStatusRoutes(req, res, pathname, path, started, reqJson, cfg, h, { ok, bad })) return true;
if (await handleExhaustionRoutes(req, res, pathname, path, started, reqJson, cfg, h, { ok, bad })) return true;
if (await handleOffloadRoutes(req, res, pathname, path, started, reqJson, cfg, h, { ok, bad })) return true;
if (await handleDispatchRoutes(req, res, pathname, path, started, reqJson, cfg, h, { ok, bad })) return true;
return false;
```

Each sub-handler owns its method-plus-path guards internally and returns
`false` when none matches, so the dispatcher is order-preserving but
branch-free. The `ok`/`bad` pair is threaded as a parameter (not re-closed
per module) so the `baseLog` skipped-record shape has exactly one definition.

## Step-by-step implementation sequence

1. Create `src/routes/admin/response.ts` (`adminResponder`, `pickQuery`,
   verbatim `failClosed` envelope); rewire the `ok`/`bad` closures in
   `handleAdminRoutes` to it with all branches still inline; run the admin
   suites to pin the seam.
2. Extract `src/routes/admin/status.ts` (models, registry, ping, health,
   candidates branches with `collectModelAliases`/`relayModels` if
   single-homed); delegate first in the dispatcher.
3. Extract `src/routes/admin/exhaustion.ts` (cooldowns-clear branch).
4. Extract `src/routes/admin/offload.ts` (offload branch).
5. Extract `src/routes/admin/dispatch.ts` (dispatch, telemetry guard, telemetry
   ingest, telemetry read, with `TELEMETRY_FAILURE_KIND` and
   `recordDispatchLaneAccounting`).
6. Remove the now-unused `ok`/`bad` threading leftovers; confirm
   `handleAdminRoutes` is branch-free ordering plus fallthrough `false`.
7. Run the verification plan below; delete no old code until all admin,
   dispatch, telemetry, and server suites pass.

## Verification and regression test plan

Exact commands, run from the repository root:

```powershell
npm test -- test/admin-dispatch-telemetry.test.ts
npm test -- test/cooldown-clear.test.ts
npm test -- test/telemetry.test.ts
npm test -- test/dispatch.test.ts
npm test -- test/dispatch-exhaustion-persistence.test.ts
npm test -- test/mcp-telemetry-forwarding.test.ts
npm test -- test/server.test.ts
npx tsc --noEmit
```

Automated checks and invariant assertions:

- All listed suites pass with zero status-code or envelope changes (the
  split is behavior-preserving; cooldown/telemetry suites assert on both).
- A targeted route-table test asserts every method-plus-path the dispatcher
  handles today still returns `true` (including the GET-or-HEAD telemetry
  guard) and that an unknown admin-namespaced path still returns `false`
  for serve fallthrough.
- Confirm by text search that `handleAdminRoutes` contains no path literals
  anymore (all live in the four submodules) and that no submodule imports
  from a sibling.
- Confirm zero line-number references were introduced by this change (symbol
  anchors only, per this plan's mandatory constraint).
