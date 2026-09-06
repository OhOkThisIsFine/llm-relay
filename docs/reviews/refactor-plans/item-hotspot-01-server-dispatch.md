# HOTSPOT-01 — Server Request-Pipeline Decomposition (`src/server.ts`, function `handle`)

Scope: decompose the monolithic request handler `handle` in `src/server.ts`
(hotspot score 11,772; churn 109; max cognitive 108 in `handle`; max cyclomatic 63)
into dedicated request-pipeline modules, leaving `server.ts` as a thin HTTP
server-lifecycle orchestrator (`createProxy`, `listen`/`close` wiring, signal handling).
Adversarial verdict: ACCEPT per `docs/reviews/adversarial-verification-2026-09-05.md`
(split admission / routing / serve).

Target modules:

- `src/server/middleware.ts` — admission and request-intake policy
- `src/server/router.ts` — route matching and front-door method dispatch
- `src/server.ts` — thin orchestrator: `createProxy`, `Handlers`, `ProxyDeps`,
  lifecycle only

## Architectural rationale and layering

`handle` currently performs five jobs in one function body, in this order:
admission gate, dashboard adapter, body intake and JSON shaping, admin-route
delegation, and serve-path routing plus resolution. The new modules follow the
existing dependency direction and introduce no new edges:

- `middleware.ts` depends only on `node:http` types, the `Config` type, and the
  already-extracted control-authorization port
  (`validateControlAuthorization`, `CONTROL_ROUTES`, `TOKENLESS_CONTROL_READ_PATHS`).
  It owns the pure admission verdict plus the dashboard-origin helpers that
  admission already implies. It never imports route handlers, the credential
  walk, or accounting — admission stays above serving.
- `router.ts` depends on `middleware.ts` (admission verdict type only), the
  dashboard/admin/front-door route entry points it already calls today
  (`handleDashboardRoute`, `handleAdminRoutes`, `detectOpenAiFrontProtocol`,
  `anthropicMessagesPath`, `openAiFrontPath`), and shared response helpers.
  It owns *decisions* (which route handles this request) while the path
  functions keep owning *behavior*. Routing therefore points downward at
  handlers, never sideways between fronts — the wire-compat isolation the
  front-pair work (P1-3 / HOTSPOT-08/11) depends on is preserved.
- `server.ts` keeps `createProxy` (which constructs `Handlers`, the catalog,
  breaker, ping loop, and accounting ports), the `Handlers` and `ProxyDeps`
  interfaces, and lifecycle. It imports both new modules; neither imports it.
  No cycle is possible: the edge direction is strictly
  `server.ts` → `router.ts` → `middleware.ts`.

Placement alternatives rejected: putting admission inside `control-authorization.ts`
would drag HTTP listener-authority parsing (`normalizeHostname`,
`parseAuthority`, `parseOrigin`, `listenerAuthority`) into an authz module whose
contract is bearer/control-token validation — a layering inversion. Putting route
matching inside either front handler would re-couple the two fronts through a
shared dispatcher, which the audit explicitly forbids.

Compatibility: `dashboardExpectedOriginForAuthority`, `contextCeilingFor`, and
`TOKENLESS_CONTROL_READ_PATHS` are imported by test suites from the `server.js`
module path today. They keep working by re-export: the implementations move, and
`src/server.ts` re-exports the same names from the new modules, so no importer
changes its specifier.

## Complete blast radius

Seed symbol (verified by direct source inspection):

- Function `handle` in `src/server.ts` — the monolith. Its ordered phases,
  each located by semantic anchor:
  - *Admission*: the `admissionFailure` call at the top of `handle`, whose
    failure branch chooses `failDashboardClosed` inside the dashboard namespace
    versus `failClosed` elsewhere, then writes a `baseLog` skipped record.
  - *Dashboard*: the `handleDashboardAdapter` await immediately after admission,
    covering the static-asset fast path, the listener-authority origin check,
    and the `handleDashboardRoute` delegation with `dashboardHeaders` shaping.
  - *Intake*: the `readBody` try/catch classified by `bodyReadStatus` (never by
    message text, per the DR-005 contract noted at the catch site), the
    early-terminal accounting record for caller-visible paths, the
    `JSON.parse` fallback to `undefined`, and the `toolSchemaMap` /
    `pickString(reqJson, "model")` / `pickBool(reqJson, "stream")` shaping.
  - *Admin*: the `handleAdminRoutes` await over the shaped request, returning
    early when handled.
  - *Serve routing*: `RequestAccountingState` construction for
    caller-visible paths, `subagentSpec` resolution with `materializeDynamicPools`
    and request-buffer rebuild, the `AUTO_MODEL` tier-header branch, the
    `resolveTargets` call with the `pool/` degraded-set and free-only filter,
    the `RoutingError` catch, attempt expansion/ranking
    (`expandCredentialAttempts`, `rankCredentialAttempts`,
    `orderDeploymentGroupsByUsability`), sticky-session pinning, the
    `contextCeilingFor` guardrail, and the final three-way serve dispatch
    (`openAiFrontPath` when `detectOpenAiFrontProtocol` matches,
    `count_tokens` short-circuit and openai-backend path guard otherwise,
    `anthropicMessagesPath` as the default).

Symbols moving to `src/server/middleware.ts`:

- `admissionFailure`, `normalizeHostname`, `parseAuthority`, `parseOrigin`,
  `listenerAuthority`
- `dashboardExpectedOriginForAuthority` (re-exported from `server.ts`),
  `dashboardExpectedOrigin`, `dashboardNamespaceTarget`

Symbols moving to `src/server/router.ts`:

- `handleDashboardAdapter`, `dashboardHeaders`, `writeDashboardResponse`,
  `failDashboardClosed`
- New pure deciders (contracts below): `admitRequest`, `decideServeRoute`
- `contextCeilingFor` moves to `router.ts` beside its single consumer site
  (re-exported from `server.ts`)

Symbols staying in `src/server.ts`:

- `createProxy`, `Handlers`, `ProxyDeps`, `TOKENLESS_CONTROL_READ_PATHS`
  (re-exported from `middleware.ts` if the constant moves; simplest is to leave
  the frozen constant where it is), `pickString`, `pickBool`,
  `admissionFailure`-adjacent imports unchanged, lifecycle wiring.

Callers and importers (behavior must be identical after the move):

- `runProxy` in `src/cli.ts` — the sole production caller of `createProxy`.
- `test/helpers/test-server.ts` — test harness constructing the proxy.
- Importers of the re-exported names: `test/context-ceiling.test.ts`,
  `test/dashboard-server-integration.test.ts`, `test/loopback-admission.test.ts`.
- Downstream route handlers keep their signatures: `handleAdminRoutes` in
  `src/routes/admin.ts`, `anthropicMessagesPath` in `src/routes/messages.ts`,
  `openAiFrontPath` in `src/routes/openai-front.ts` — untouched by this plan.

Affected test suites: `test/server.test.ts`, `test/server-safety.test.ts`,
`test/loopback-admission.test.ts`, `test/dashboard-server-integration.test.ts`,
`test/context-ceiling.test.ts`, `test/control-authorization.test.ts`,
plus the admin/front suites that pin `handle` behavior end to end
(`test/admin-dispatch-telemetry.test.ts`, `test/mid-stream-failure.test.ts`).

## Specific code modifications with contracts

New contract in `src/server/middleware.ts`:

```typescript
import type { IncomingMessage, Server, ServerResponse } from "node:http";
import type { Config } from "../config.js";
import type { ControlAuthorizationPort } from "../control-authorization.js";

export interface AdmissionVerdict {
  readonly allowed: true;
}

export function admitRequest(
  req: IncomingMessage,
  pathname: string,
  server: Server,
  cfg: Config,
  authorization: ControlAuthorizationPort | undefined,
): string | null;
```

Contract:

- Returns `null` exactly when the request passes admission (today's
  `admissionFailure` returning `null`); otherwise returns the refusal reason
  string, byte-identical to today's messages (consumers match on text in
  `test/loopback-admission.test.ts`).
- Pure with respect to serving: performs no I/O, writes no response, records
  nothing. The caller chooses `failDashboardClosed` versus `failClosed`.

New contracts in `src/server/router.ts`:

```typescript
import type { IncomingMessage, ServerResponse } from "node:http";
import type { Config } from "../config.js";
import type { Handlers } from "../server.js";

export type ServeRoute =
  | { readonly kind: "openai-front"; readonly protocol: "chat" | "responses" }
  | { readonly kind: "anthropic-messages" }
  | { readonly kind: "count-tokens" }
  | { readonly kind: "unsupported-openai-path" };

export function decideServeRoute(
  method: string | undefined,
  pathname: string,
  targetKind: "anthropic" | "openai",
): ServeRoute;

export function tryWriteAdmissionRefusal(
  res: ServerResponse,
  path: string,
  pathname: string,
  reason: string,
): void;
```

Contract for `decideServeRoute`:

- Encodes exactly today's dispatch table inside `handle`: the
  `detectOpenAiFrontProtocol` match wins first; then, for openai-kind targets,
  the `count_tokens` short-circuit, then the non-messages 404; otherwise the
  Anthropic messages path. No path string changes; the 404 message template
  (`path not supported for an openai backend`) is preserved verbatim.

Before (representative — inside function `handle` in `src/server.ts`,
immediately after the `started` / `path` / `pathname` / `requestClient`
preamble):

```typescript
const admissionErr = admissionFailure(req, pathname, h.server, cfg, h.controlAuthorization);
if (admissionErr) {
  if (dashboardNamespaceTarget(path)) failDashboardClosed(res, 403, admissionErr);
  else failClosed(res, 403, admissionErr);
  h.logger.write(baseLog(started, path, false, false, 403, "skipped", null));
  return;
}

if (await handleDashboardAdapter(req, res, path, started, cfg, h)) return;
```

After (same anchor):

```typescript
const admissionErr = admitRequest(req, pathname, h.server, cfg, h.controlAuthorization);
if (admissionErr) {
  tryWriteAdmissionRefusal(res, path, pathname, admissionErr);
  h.logger.write(baseLog(started, path, false, false, 403, "skipped", null));
  return;
}

if (await handleDashboardAdapter(req, res, path, started, cfg, h)) return;
```

`tryWriteAdmissionRefusal` owns the dashboard-namespace branch
(`dashboardNamespaceTarget` → `failDashboardClosed`, else `failClosed`).

Before (inside function `handle`, at the front-door dispatch following the
context-ceiling guardrail, where `openAiFrontProtocol` is matched):

```typescript
if (openAiFrontProtocol) {
  const credentialWalk = new CredentialWalk(walkAttempts, { /* … */ });
  await openAiFrontPath(res, credentialWalk, credentialTrace, { /* … */ }, { ...h, withRepairAccounting });
  return;
}

const target = walkAttempts[0]!.target;
if (target.kind === "openai") {
  if (isCountTokens) { /* …count_tokens short-circuit… */ return; }
  if (!isMessages) {
    failClosed(res, 404, `llm-relay: path not supported for an openai backend: ${pathname}`);
    h.logger.write(baseLog(started, path, hadTools, false, 404, "skipped", null));
    return;
  }
}

await anthropicMessagesPath(res, { /* … */ }, { ...h, withRepairAccounting });
```

After (same anchor — resolution, ranking, sticky, and ceiling code above this
anchor stay in `handle` untouched; only the dispatch reads the decider):

```typescript
const route = decideServeRoute(req.method, pathname, walkAttempts[0]!.target.kind);
if (route.kind === "openai-front") {
  const credentialWalk = new CredentialWalk(walkAttempts, { /* …unchanged… */ });
  await openAiFrontPath(res, credentialWalk, credentialTrace, { /* …unchanged… */ }, { ...h, withRepairAccounting });
  return;
}

if (route.kind === "count-tokens") { /* …unchanged short-circuit… */ return; }
if (route.kind === "unsupported-openai-path") {
  failClosed(res, 404, `llm-relay: path not supported for an openai backend: ${pathname}`);
  h.logger.write(baseLog(started, path, hadTools, false, 404, "skipped", null));
  return;
}

await anthropicMessagesPath(res, { /* …unchanged… */ }, { ...h, withRepairAccounting });
```

`server.ts` compatibility shims (kept indefinitely; they are three lines each):

```typescript
export { admitRequest, dashboardExpectedOriginForAuthority } from "./server/middleware.js";
export { contextCeilingFor } from "./server/router.js";
```

(Adjusted to whichever module actually hosts each symbol; the invariant is that
the `server.js` specifier keeps exporting all three names.)

## Step-by-step implementation sequence

1. Create `src/server/middleware.ts` by moving `normalizeHostname`,
   `parseAuthority`, `parseOrigin`, `listenerAuthority`, and `admissionFailure`
   (renamed to the `admitRequest` contract, same message strings) verbatim out
   of `src/server.ts`; move the dashboard-origin helpers with them.
2. Create `src/server/router.ts` by moving `dashboardHeaders`,
   `writeDashboardResponse`, `failDashboardClosed`, `handleDashboardAdapter`,
   and `contextCeilingFor` verbatim; add `tryWriteAdmissionRefusal` and
   `decideServeRoute` as thin wrappers over the moved logic.
3. Rewire function `handle` to the two call-site edits shown above; change
   nothing else in its body in this step (resolution, ranking, sticky, ceiling,
   and serve-call arguments stay byte-identical).
4. Add the `server.ts` re-export shims; confirm by text search that no other
   module imports the moved private names directly.
5. Run the verification plan below; delete no old code until the server,
   admission, dashboard-integration, and ceiling suites pass.

## Verification and regression test plan

Exact commands, run from the repository root:

```powershell
npm test -- test/server.test.ts
npm test -- test/server-safety.test.ts
npm test -- test/loopback-admission.test.ts
npm test -- test/dashboard-server-integration.test.ts
npm test -- test/context-ceiling.test.ts
npm test -- test/control-authorization.test.ts
npm test -- test/admin-dispatch-telemetry.test.ts
npx tsc --noEmit
```

Automated checks and invariant assertions:

- All listed suites pass with zero response-body changes (the move is
  behavior-preserving by construction; admission refusal strings are asserted
  verbatim by `test/loopback-admission.test.ts`).
- A targeted invariant test asserts `decideServeRoute` returns
  `openai-front` for every method/path pair where `detectOpenAiFrontProtocol`
  matches, `count-tokens` only for the messages count-tokens POST against an
  openai-kind target, and `unsupported-openai-path` for the remaining
  non-messages openai-backend paths.
- Confirm by text search that `src/server.ts` no longer defines `handle`'s
  former admission/dashboard helper bodies and that every moved symbol has
  exactly one definition.
- Confirm zero line-number references were introduced by this change (symbol
  anchors only, per this plan's mandatory constraint).
