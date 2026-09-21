# Config reload design — 2026-09-20

## Goal

Add an admitted `POST /reload` that re-runs the same config load policy the daemon started with and applies only changes that can take effect without replacing startup-owned state. A failed load or a restart-only change applies **nothing**.

This is D2 from `stabilization-plan-2026-09-17.md`.

## Required properties

1. `POST /reload` is a control route: exact listener Host, exact Origin when present, `content-type: application/json`, and the existing control capability are required.
2. Reload uses the daemon's original config path **and original CLI overrides**. A daemon started with `--listen`, `--mode`, or `--default` must not lose those overrides on reload.
3. `loadConfig` validates the complete candidate before any live state changes.
4. Restart-only differences refuse the reload as one transaction. No reload-safe subset is applied beside a refused field.
5. Commit mutates the existing `Config` object in place. Startup objects that intentionally retain the `Config` identity therefore see the new values without being reconstructed.
6. Existing in-flight requests keep the targets/options they already resolved. New requests see the committed config.
7. A successful reload replaces the recorded source mtime and warnings, so `configStaleness()` immediately returns current and a later edit can be reported once again.
8. Dynamic pools are materialized on the candidate before commit and warmed again after commit. A reload never exposes the unmaterialized intermediate routing state.
9. The response and logs contain paths/status only, never credential values, task text, or config contents.

## Ownership model

The important distinction is **Config identity** versus **derived startup state**.

These startup objects already retain the same `cfg` object and read through it later, so an in-place commit is safe for fields they consult dynamically:

- `PingLoop`
- `LaneCadence`
- dashboard availability producer
- quota demotion and hard-cap evaluators
- accounting price resolver
- dispatch/lane-affinity persistence
- D1's configured daemon lane launcher, except for `routing.mcp.allowedRoots` (captured at launcher construction)

Other objects snapshot config during `createProxy` and therefore make their inputs restart-only unless D2 explicitly converts them to live reads:

- `MetadataLogger` snapshots `log`.
- `destructiveMatcher` snapshots `repair.destructiveTools`.
- `StickySessionManager` snapshots sticky enablement/TTL/capacity and owns live pin state.
- hedge settings and max-in-flight are resolved once.
- latency/probation/pacing currently receive settings snapshots; D2 must change those server-side dependencies to read the current `cfg.routing.*` value on each evaluation before those fields are declared reloadable.

The listener socket itself owns `host`/`port`.

## Top-level Config matrix

| Config field | Reload policy | Runtime owner / reason |
|---|---|---|
| `host` | restart-only | HTTP listener is already bound; admission also derives expected authority from the bound listener. |
| `port` | restart-only | HTTP listener is already bound. |
| `providers` | constrained deep reload | See provider matrix below. Provider membership/identity stays restart-only; timeout/cap/limit policy can swap. |
| `routing` | constrained deep reload | See routing matrix below. Most routing is read through live `cfg`; process-local/stateful policy is excluded. |
| `mode` | reloadable | Request handling reads `cfg.mode`; candidate load already validates repair prerequisites. |
| `reshaper` | reloadable | `resolveReshaper` reads current `cfg` for every repair. |
| `reshaperCandidates` | reloadable | Rehydrated against current `cfg` for every repair. |
| `reshaperPool` | reloadable | Resolved against current materialized pools for every repair. |
| `repair.maxAttempts` | reloadable | Read by request-time repair. |
| `repair.destructiveTools` | restart-only in D2 | `destructiveMatcher` is built once. A later packet may make the matcher live. |
| `walkBudgetMs` | reloadable | New credential walks read current `cfg.walkBudgetMs`. |
| `maxBodyBytes` | reloadable | `handle` reads it before every request body. |
| `log` | restart-only | `MetadataLogger` owns the open logging policy/file from startup. |
| `leaveMeAlone` | reloadable | Daemon behavior does not depend on it; keeping the in-memory config current is harmless. |
| `sourcePath` | immutable | Reload source is fixed to the daemon's startup config path. |
| `sourceMtimeMs` | derived on success | Replace with the candidate's non-enumerable mtime. |
| `warnings` | derived on success | Replace with candidate load warnings and return them in the reload response. |

## Provider matrix

Provider names are an identity boundary for catalog, breaker, probe, and accounting state. D2 therefore requires the provider key set to stay identical and allows only fields whose semantics are evaluated per new request.

| Provider field | Reload policy | Reason |
|---|---|---|
| `timeoutMs` | reloadable | copied into newly resolved targets |
| `stallTimeoutMs` | reloadable | copied into newly resolved targets |
| `firstByteTimeoutMs` | reloadable | copied into newly resolved targets |
| `maxConcurrent` | reloadable | request admission/evidence reads current provider config |
| `limits` (including credential/model hard limits) | reloadable | quota/pacing/hard-cap evaluators read current `cfg` |
| `base` | restart-only | changing provider identity under the same cache/breaker/catalog key can attach old evidence to a different backend |
| `kind` | restart-only | changes protocol and catalog semantics under existing provider-keyed state |
| `authEnv` | restart-only in D2 | credential identity/config is shared with catalog/probe state; reload support can be designed separately |
| `credentials` | restart-only in D2 | same reason as `authEnv` |
| `credentialMode` | restart-only in D2 | part of provider/credential identity policy |
| `authHeader` | restart-only in D2 | part of provider authentication shape |
| `tierType` | restart-only in D2 | affects cost classification and dynamic discovery membership; changing it requires a catalog/state reconciliation design |
| `compat` | restart-only in D2 | changes wire validation/translation identity; keep coupled to provider identity for the first reload implementation |
| `wire` | restart-only in D2 | changes upstream protocol endpoint under provider-keyed state |
| `signupUrl` | restart-only in D2 | no daemon need; avoid widening the transaction for a display-only field |

A changed provider key set is restart-only.

## Routing matrix

`poolDegraded` is derived runtime state and is never taken directly from the file. Dynamic pools are materialized on the candidate before commit.

| Routing field | Reload policy | Runtime owner / required work |
|---|---|---|
| `default` | reloadable | request-time resolution |
| `tiers` | reloadable | request-time resolution |
| `pools` | reloadable | request-time resolution; candidate is materialized before commit |
| `poolPolicies` | reloadable | materialize dynamic pools before commit, then warm asynchronously |
| `poolDegraded` | derived | regenerated by materialization |
| `subagents` | reloadable | request-time resolution |
| `offload` | reloadable | request-time rule lookup; `setOffload` already proves this state is mutable live |
| `benchmarkSort` | reloadable | request-time candidate ordering |
| `quota` | reloadable | quota evaluator retains `cfg` identity and reads current settings |
| `latency` | reloadable after D2 live-settings seam | server must stop passing a startup snapshot and expose current settings to each evaluation |
| `probation` | reloadable after D2 live-settings seam | same |
| `pacing` | reloadable after D2 live-settings seam | same |
| `crawl` | reloadable | stream watchdog settings are resolved from request config, not a startup object |
| `laneProbe` | reloadable | `LaneCadence` retains `cfg` and resolves settings when poked |
| `ladder` | reloadable | daemon dispatch view and D1 launcher build from current `cfg` at lane start |
| `ladders` | reloadable | same |
| `cliLane` | reloadable | daemon dispatch view resolves current template |
| `sticky` | restart-only in D2 | `StickySessionManager` owns live pins and immutable TTL/capacity |
| `hedge` | restart-only in D2 | hedge settings and max-in-flight are captured in `createProxy` |
| `dispatchWalk` | restart-only in D2 | policy is also owned by already-running MCP processes; daemon-only reload would claim a consistency it cannot provide |
| `mcp` | restart-only in D2 | already-running MCP servers hold their own config; D1's daemon launcher additionally captures `allowedRoots` |

## Transaction

Introduce a small `config-reload.ts` module with no HTTP concerns.

### 1. Load

The daemon receives an injected reload loader:

```ts
type ReloadConfigLoader = () => Config;
```

The CLI constructs it from the same config path and the same `ConfigOverrides` used at startup. Programmatic embeds that do not inject a loader answer 503 on `POST /reload`.

### 2. Validate restart-only equality

Compare candidate and live config only on explicitly restart-only paths. Return a bounded sorted list such as:

```
["host", "providers.deepseek.base", "routing.sticky"]
```

The comparison is structural and secret-blind: only path names are returned.

If the list is non-empty, answer 409 and apply nothing.

### 3. Prepare

Before touching live config:

- materialize candidate dynamic pools with the existing `ModelCatalog`;
- construct any D2 live-settings adapters needed by the server;
- copy/normalize the reloadable slices into a prepared value.

No preparation step mutates live `cfg`.

### 4. Commit

Commit is synchronous and has no `await`:

- replace reloadable top-level fields;
- replace the permitted provider policy fields while preserving provider identity objects/fields;
- replace permitted routing fields plus derived `poolDegraded`;
- replace candidate warnings;
- redefine non-enumerable `sourceMtimeMs`;
- reset the one-shot config-staleness log latch.

Mutating the existing `Config` identity is load-bearing.

### 5. Post-commit

Kick off catalog warming/validation in the background. A warm failure does not roll back an already valid config; the request path already has the persisted catalog and the materialized candidate.

## HTTP contract

`POST /reload` accepts only an empty JSON object (or an empty body parsed as no arguments). Unknown properties are refused with 400.

Success:

```json
{
  "reloaded": true,
  "changed": ["providers.deepseek.timeoutMs", "routing.default"],
  "warnings": []
}
```

No-op success returns `changed: []`.

Failure classes:

- **400**: candidate cannot be read/parsed/validated; live config untouched.
- **409**: candidate is valid but changes restart-only fields; response includes `requiresRestart: ["..."]`; live config untouched.
- **503**: this proxy has no reload loader (programmatic embed/fail-closed setup).
- admission failures remain 403 before the route runs.

Error messages are bounded and must not serialize candidate config values.

## CLI surface

Add `llm-relay reload` as a thin control client over `POST /reload`, using the same installed control capability as `stop`. It prints changed paths and warnings. This makes the staleness notice actionable.

After D2, replace the old `CONFIG_STALENESS_NOTICE` text ("restart required") with:

```
config changed on disk since the relay loaded it — run "llm-relay reload"; a restart is required if the changed fields are not reloadable
```

## Tests

### Pure reload module

- invalid candidate never mutates live config;
- every restart-only top-level field produces its path;
- provider membership/identity changes refuse;
- timeout/limit/maxConcurrent changes apply;
- permitted routing changes apply;
- sticky/hedge/dispatchWalk/mcp changes refuse;
- candidate source mtime replaces the old non-enumerable value;
- no-op reload is stable.

### Server route

- `POST /reload` joins the existing control admission boundary;
- missing/wrong token is rejected before loader invocation;
- malformed config returns 400 and preserves old routing;
- restart-only change returns 409 and preserves old routing;
- reloadable change affects the next `/dispatch` and the next model request without restarting;
- dynamic pool policy reload exposes a materialized pool, never an empty/intermediate one;
- telemetry reports `changedOnDisk: false` after success and logs a later change once again.

### Process-level proof

Start the real daemon on an isolated config and control token:

1. route a request/dispatch against value A;
2. edit only reloadable fields to value B;
3. call `llm-relay reload`;
4. prove the same daemon PID serves value B;
5. edit a restart-only field and prove reload returns 409 while value B remains live.

## Implementation packets

### D2-a — reload transaction module

Add the reload matrix, diff, prepare/apply helpers, and unit tests. No route yet.

### D2-b — live routing settings

Make latency/probation/pacing read their settings from current `cfg` rather than startup snapshots. Pin with focused tests. Hedge/sticky remain restart-only.

### D2-c — admitted route

Add `POST /reload` to `CONTROL_ROUTES`, inject the loader and catalog-backed prepare step, reset staleness state, and add route/integration tests.

### D2-d — CLI and docs

Add `llm-relay reload`, update the staleness notice/reference/help/HANDOFF/backlog, and run the process-level proof plus full gate.

## Non-goals

- rebinding host/port;
- replacing logger files or log policy;
- changing provider identity under existing provider-keyed evidence;
- restarting or rewriting already-running MCP processes;
- replacing the D1 broker (which would orphan its in-memory executions);
- retroactively changing an already-started request or lane attempt.
