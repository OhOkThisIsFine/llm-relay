# Read-only Analytics dashboard SPA design (2026-08-20)

## Status and scope

**Design complete only.** This document fills the quota-metering specification §6.3 / G3
full-SPA design gap. It claims no implementation, measurements, artifact sizes, passing tests,
or green gates. The metering, security, and accounting specifications remain authoritative.

The owner resolved G3: build a full SPA. This design recommends a clean-room adaptation of
freellmapi Analytics' information architecture and responsive light/dark character while
preserving relay invariants. Stage-1 credential fleet
implementation is unchanged. The dashboard consumes opaque credential IDs only; it has no
custody, keystore, import, or rotation work.

Pinned clean-room evidence:

- [tree](https://github.com/tashfeenahmed/freellmapi/tree/51f888c65383cc733731604a7274b99ea852f16a)
- [client AnalyticsPage](https://github.com/tashfeenahmed/freellmapi/blob/51f888c65383cc733731604a7274b99ea852f16a/client/src/pages/AnalyticsPage.tsx)
- [server analytics route](https://github.com/tashfeenahmed/freellmapi/blob/51f888c65383cc733731604a7274b99ea852f16a/server/src/routes/analytics.ts)
- local checkout root: `C:\Users\ethan\freellmapi\app`

Current evidence is real but not complete. `src/usage-observer.ts:34-69` captures
provider-reported completion/output without breaking traffic. Both request fronts carry that
observation: `src/backend.ts:466-480,1083-1121` and
`src/server.ts:692-726,1593-1607,2210-2322`. Canonical meter/read work remains for input, cached input,
window aggregates, cost/provenance, client attribution, and per-credential dimensions. See
`docs/quota-metering-spec-2026-08-16.md` §§2, 4, 6.3,
`docs/credential-fleet-design-2026-08-16.md` §§4-5, and
`docs/open-decisions-2026-08-16.md` M4-M6/C1-C4. No value is permanently presumed zero.

## Information boundary

Adapt visible structure, not upstream branding or code. The view is metadata-only: no IP/full UA,
headers/body/prompt/tool args, URL values, raw provider errors, environment names, key material,
key location, or key ordinals. Credential fields are safe opaque `provider#label` IDs; clients
are safe classifications; outcomes and failures are deterministic normalized enums.

Null and unknown never mean zero or unlimited. A request is the caller-visible operation; an
attempt is one serving or repair dispatch. Success excludes cancelled. `commitMs` is
meaningful-content commit, never TTFT. Caller-operated labeled traffic is excluded from
relay-held caps. Credential usage is never inferred from provider/model aggregates. The UI never
estimates tokens, spend, quota, coverage, or availability.

## Static shell and session protocol

### Tokenless static routes

| Methods | Route | Required behavior |
| --- | --- | --- |
| GET | `/dashboard` | canonical 308 to `/dashboard/` |
| GET, HEAD | `/dashboard/` | SPA shell |
| GET, HEAD | `/dashboard/assets/<manifest-known-file>` | one manifest-listed asset |

Use narrow Node-core lookup before JSON body buffering. Reject encoded traversal; require manifest
membership; use explicit MIME, HEAD, and 404 behavior. There is no catch-all. `/`, `/v1`,
control, and liveness routes retain their semantics.

### Bootstrap then read-only session

The exact control-authorized bootstrap endpoint is:

```json
POST /dashboard/api/v1/bootstrap
Content-Type: application/json
Accept: application/vnd.llm-relay.dashboard+json; version=1

{"schema":"dashboard.bootstrap.request.v1"}

{"schema":"dashboard.bootstrap.v1","bootstrap":"<opaque>","expiresAt":"2026-08-20T00:00:00Z"}
```

It uses existing control capability/admission. Persistent control capability stays CLI-side and
is never exposed to JS. Server state is atomic, single-use, in-memory, and 60 seconds. The CLI
launches `/dashboard/#bootstrap=<opaque>`. The fragment is absent from HTTP request, referrer,
query, HTML, and logs and is immediately cleared via `history.replaceState`. It can be briefly
present in OS launcher/browser argv and history; this design does not claim otherwise.

```json
POST /dashboard/api/v1/session
Content-Type: application/json
Accept: application/vnd.llm-relay.dashboard+json; version=1

{"schema":"dashboard.session.request.v1","bootstrap":"<opaque>"}

{"schema":"dashboard.session.v1","session":"<opaque>","scope":"dashboard:read","idleExpiresAt":"2026-08-20T00:30:00Z","absoluteExpiresAt":"2026-08-20T08:00:00Z"}
```

Bootstrap and session values are each 32 CSPRNG random bytes encoded base64url. The server stores
SHA-256 digests, compares digest bytes constant-time, and atomically consumes bootstrap.
Admission-checked exchange rejects replay. A distinct
`X-LLM-Relay-Dashboard-Session` carries a read-only session. Server records are in memory;
browser keeps the short token in memory plus `sessionStorage` for reload, never
`localStorage`/cookie. Defaults: 30-minute idle, 8-hour absolute; restart revokes.

| Admission | Method and route | Semantics |
| --- | --- | --- |
| authenticated | GET, HEAD /dashboard/api/v1/snapshot?window=<WindowId>&includeRepair=<0-or-1>&... | bounded server-side snapshot |
| authenticated | GET, HEAD /dashboard/api/v1/requests/:requestId?includeRepair=<0-or-1> | bounded request/detail attempts |
| authenticated | POST /dashboard/api/v1/logout | {"schema":"dashboard.logout.request.v1"}; revoke self-session and return 204 with no body |

All other mutation, control, and data-plane routes are forbidden.

### Admission, cookie, and browser defenses

- Exact expected loopback Host is mandatory.
- Bootstrap CLI may omit Origin under current control admission.
- Session POST and logout POST require exact same-origin Origin and, when present,
  Sec-Fetch-Site: same-origin.
- Authenticated same-origin browser GET/HEAD may omit Origin but require exact Host and session
  header; if Origin/Sec-Fetch-Site are present they must be same-origin/allowed (same-origin or
  none).
- Body-bearing POSTs require JSON Content-Type; APIs require exact versioned Accept.
- Reject before buffering. No CORS or preflight.
- Never log secrets, headers, bodies, fragments, or URL values.
- Auth never reads/sets cookies; fetch uses `credentials: 'omit'`; dashboard responses have no
  Set-Cookie; incidental provider cookies are not credentials/admission input.

Index/API/bootstrap responses are `no-store`; hashed manifest assets use
`max-age=31536000, immutable`. Set Referrer-Policy `no-referrer`,
X-Content-Type-Options `nosniff`, and CORP `same-origin`. Set the required
Content-Security-Policy header exactly:

```text
default-src 'none'; script-src 'self'; style-src 'self'; connect-src 'self'; img-src 'self' data:; font-src 'self'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'; form-action 'none'
```

No CDN, eval, inline JS/CSS, service worker, or remote telemetry.

## API and canonical types

Media type is `application/vnd.llm-relay.dashboard+json; version=1`. Snapshot query requires
`window=1h|24h|7d|30d|today|month|lifetime` and `includeRepair=0|1`; optional URL-encoded
server filters are `attribution=relay-held|caller-operated|all`,
`provider=<safe-id>`, `model=<safe-id>`, `client=<safe-id>`,
`credentialId=<safe-provider%23label>`, `outcome=<Outcome>`, and
`failureKind=<FailureKind>`. Percent-decode provider/model/client/credential values exactly once;
require valid UTF-8 and at most 256 bytes; reject NUL, controls, and unpaired scalar issues; then
resolve exact match against canonical IDs already in the read model. Enums must match exactly;
each appears once; the full query fits the body-independent 16 KiB request cap; and request IDs
alone use `[A-Za-z0-9_-]{16,128}`. URL values remain excluded from logs.
Detail query repeats `includeRepair=0|1`, making repair visibility explicit.
Server generates UTC `from`, `to`, `asOf`, and half-open `[from,to)` buckets; today/month
are UTC boundaries. No other windows exist. C4 UTC mapping is a reversible recommended default:
1h is 60 one-minute buckets; 24h is 96 fifteen-minute; 7d is 168 hourly; 30d is 120 six-hour;
today is UTC-aligned fifteen-minute capped at 96; month is 28-31 UTC calendar-day; lifetime is
UTC calendar-month rollups capped at 720, with older overflow partial/retention coverage.

Requests include all caller-visible terminal outcomes; attempts include serve/repair dispatches
subject to includeRepair; served is success; errored is error; cancelled is cancelled. Success rate
is served/(served+errored), null on zero denominator; cancelled/unknown are excluded. Average/P95
latency covers non-cancelled terminal requests with known latency; average commit covers successful
requests with known commitMs. Commit is never TTFT.

```ts
type WindowId = '1h' | '24h' | '7d' | '30d' | 'today' | 'month' | 'lifetime';
type QuotaAxis = 'requests' | 'tokens';
type QuotaPeriod = 'minute' | 'day' | 'month' | 'unknown';
type Coverage = 'complete' | 'partial' | 'unavailable' | 'stale' | 'empty';
type PanelId = 'summary' | 'request_timeline' | 'token_timeline' | 'spend' | 'provider' | 'model' | 'client' | 'credential' | 'latency' | 'commit' | 'errors' | 'recent' | 'quotas' | 'cooldowns';
type Outcome = 'success' | 'error' | 'cancelled' | 'unknown';
type FailureKind = 'timeout' | 'provider_error' | 'auth_error' | 'rate_limit' | 'aborted' | 'protocol' | 'unknown';
type Attribution = 'relay_held' | 'caller_operated' | 'unknown';
type AttributionPolicy = 'exclude_caller_operated_from_relay_held_caps' | 'include_all_labeled' | 'unknown';
type CooldownReason = 'rate_limit' | 'auth_error' | 'provider_error' | 'manual' | 'unknown';
type CoverageReason = 'meter_not_implemented' | 'retention_pruned' | 'upstream_unavailable' | 'projection_lag' | 'no_matching_rows' | 'unknown';
interface PanelCoverageV1 { panel: PanelId; state: Coverage; reason: CoverageReason | null; provenance: ('provider_reported' | 'relay_observed' | 'relay_estimated' | 'unknown' | 'mixed')[]; observedAt: string | null; }
interface ReportedTokenCell { value: number | null; source: 'provider_reported'; observedAt: string | null; }
interface EstimatedTokenCell { value: number | null; source: 'relay_estimated'; observedAt: string | null; method: string | null; }
interface ReportedTokenTotals { reportedInput: ReportedTokenCell; reportedOutput: ReportedTokenCell; reportedCachedInput: ReportedTokenCell; }
interface EstimatedTokenTotals { estimatedInput: EstimatedTokenCell; estimatedOutput: EstimatedTokenCell; }
interface TokenTotalsV1 { reported: ReportedTokenTotals; estimated: EstimatedTokenTotals; }
interface ProviderPublishedReported { amountMicrousd: number | null; priceSource: 'provider_published'; tokenBasis: 'reported'; source: 'provider_reported' | 'unknown'; observedAt: string | null; }
interface ProviderPublishedEstimated { amountMicrousd: number | null; priceSource: 'provider_published'; tokenBasis: 'estimated'; source: 'relay_estimated' | 'unknown'; observedAt: string | null; }
interface ReferenceReported { amountMicrousd: number | null; priceSource: 'reference'; tokenBasis: 'reported'; source: 'provider_reported' | 'unknown'; observedAt: string | null; }
interface ReferenceEstimated { amountMicrousd: number | null; priceSource: 'reference'; tokenBasis: 'estimated'; source: 'relay_estimated' | 'unknown'; observedAt: string | null; }
interface SpendTotalsV1 { providerPublishedReported: ProviderPublishedReported; providerPublishedEstimated: ProviderPublishedEstimated; referenceReported: ReferenceReported; referenceEstimated: ReferenceEstimated; unpricedRequests: number; }
interface SummaryV1 { requests: number; attempts: number; served: number; errored: number; cancelled: number; successRate: number | null; tokens: TokenTotalsV1; spend: SpendTotalsV1; avgLatencyMs: number | null; p95LatencyMs: number | null; avgCommitMs: number | null; }
interface BucketV1 { from: string; to: string; requests: number; attempts: number; served: number; errored: number; cancelled: number; successRate: number | null; tokens: TokenTotalsV1; spend: SpendTotalsV1; avgLatencyMs: number | null; p95LatencyMs: number | null; avgCommitMs: number | null; }
interface DimensionSummaryV1 { requests: number; attempts: number; served: number; errored: number; cancelled: number; successRate: number | null; tokens: TokenTotalsV1; spend: SpendTotalsV1; avgLatencyMs: number | null; avgCommitMs: number | null; coverage: Coverage; }
interface ProviderDimensionRowV1 extends DimensionSummaryV1 { dimension: 'provider'; provider: string; }
interface ModelDimensionRowV1 extends DimensionSummaryV1 { dimension: 'model'; provider: string; model: string; }
interface ClientDimensionRowV1 extends DimensionSummaryV1 { dimension: 'client'; client: string; }
interface CredentialDimensionRowV1 extends DimensionSummaryV1 { dimension: 'credential'; provider: string; credentialId: string; label: string; }
type DimensionRowV1 = ProviderDimensionRowV1 | ModelDimensionRowV1 | ClientDimensionRowV1 | CredentialDimensionRowV1;
interface ErrorDistributionRowV1 { failureKind: FailureKind; outcome: Outcome; requests: number; }
interface RequestRowV1 { requestId: string; occurredAt: string; client: string | null; attribution: Attribution; outcome: Outcome; failureKind: FailureKind | null; attemptCount: number; latencyMs: number | null; commitMs: number | null; provider: string | null; model: string | null; credentialId: string | null; tokens: TokenTotalsV1; spend: SpendTotalsV1; repairIncluded: boolean; }
interface AttemptRowV1 { attemptId: string; role: 'serve' | 'repair'; startedAt: string; endedAt: string | null; status: Outcome; latencyMs: number | null; commitMs: number | null; provider: string | null; model: string | null; credentialId: string | null; failureKind: FailureKind | null; tokens: TokenTotalsV1 | null; spend: SpendTotalsV1 | null; }
interface QuotaRowV1 { credentialId: string; label: string; provider: string; deployment: string | null; axis: QuotaAxis; period: QuotaPeriod; limit: number | null; remaining: number | null; localUsed: number | null; resetsAt: string | null; observedAt: string | null; limitBasis: 'provider_stated' | 'configured' | 'learned' | null; remainingBasis: 'provider_stated' | 'derived_configured' | 'derived_learned' | null; localUsedBasis: 'reported' | 'estimated' | 'mixed' | null; }
interface CooldownRowV1 { credentialId: string; provider: string; deployment: string | null; reason: CooldownReason; until: string | null; observedAt: string | null; }
interface SnapshotV1 { schema: 'dashboard.snapshot.v1'; relayVersion: string; window: WindowId; includeRepair: boolean; attribution: Attribution | 'all'; attributionPolicy: AttributionPolicy; generatedAt: string; asOf: string; from: string | null; to: string; retentionFrom: string | null; retentionTo: string | null; panelCoverage: PanelCoverageV1[]; summary: SummaryV1; buckets: BucketV1[]; providers: ProviderDimensionRowV1[]; models: ModelDimensionRowV1[]; clients: ClientDimensionRowV1[]; credentials: CredentialDimensionRowV1[]; errors: ErrorDistributionRowV1[]; quotas: QuotaRowV1[]; cooldowns: CooldownRowV1[]; recentRequests: RequestRowV1[]; }
interface DetailV1 { schema: 'dashboard.detail.v1'; request: RequestRowV1; attempts: AttemptRowV1[]; panelCoverage: PanelCoverageV1[]; }
interface DashboardErrorV1 { schema: 'dashboard.error.v1'; code: 'malformed_query' | 'invalid_auth' | 'forbidden' | 'not_found' | 'method_not_allowed' | 'unsupported_version' | 'replay' | 'oversized' | 'unsupported_content_type' | 'internal'; message: 'Request could not be completed.' | 'Dashboard session is unavailable.' | 'Requested dashboard data was not found.'; requestId: string | null; }
```

RFC3339 UTC timestamps and all counts/ms/micro-USD are nonnegative integers. Null is
known-not-available; omitted is only for absent optional query input. Required missing fields are
invalid. There is no estimated cached input until backend contract supports it; no
`operatorConfigured`, blended spend, generic metadata, or raw provider cooldown string.
Learned quota limits and remaining values remain display-only unless the owner explicitly opts
into their use for routing or enforcement.

Use a precomputed bounded read model: no provider egress/probes, browser log/storage parsing,
browser estimation, or unbounded request-time scans. Recommended owner-changeable caps: 16 KiB
body, 720 buckets, 100 dimension rows/panel, 40 error rows, 100 recent rows, 32 detail attempts,
and request ID `[A-Za-z0-9_-]{16,128}`. No pagination because output is bounded.

Errors: 400 malformed/query; 401 invalid/expired auth; 403 Host/Origin/scope; 404 route/request;
405 plus Allow; 406 unsupported Accept/media version; 409 replay; 413 oversized; 415
Content-Type; 500 internal. A response schema mismatch is client stale/error hard failure, not
magical HTTP 406. API errors differ from normalized provider failure kinds.

## Parity and UX

Exactly eight cards: Requests; Success rate; Input tokens; Output tokens; Avg latency; P95 latency;
Avg commitMs; Spend with adjacent unpriced count. Attempts/served remain contract metrics.

| Adapted upstream feature | Relay behavior/provenance |
| --- | --- |
| Range / overview | Seven UTC windows and coverage-labeled server summary. |
| Request timeline | UTC buckets show requests and attempts as separate series; includeRepair applies to attempts. |
| Token timeline | Separate reported input/output/cached-input and estimated input/output series; no estimated cached-input. |
| Provider chart | Provider dimension; no credential inference. |
| Client chart | Safe classification only; no IP/full UA. |
| Latency chart | Server-observed latency, null when unavailable. |
| Commit chart | Meaningful-content commit, explicitly never TTFT. |
| Error distribution | Normalized failures, no raw error text. |
| Recent failures | Bounded filtered request rows. |
| Recent requests/detail dialog | Request and bounded serving/repair attempts. |
| Provider/model/credential breakdowns | Separate dimensions and opaque labels. |
| Spend / savings | Actual window-scoped spend in four provider-published/reference × reported/estimated micro-USD cells plus adjacent unpricedRequests; omit upstream monthly savings, counterfactual, and fallback pricing projection. |
| Quota/headroom | Headroom is view-model derived only from limit/remaining, null if unavailable, never stored/estimated; cooldown remains separate. |
| Cooldown | Separate normalized reason and expiry. |
| Filters | Server-side exact filters below. |

Filters: range, provider, model, client, credential, normalized outcome/failure, attribution, and
include-repair where applicable. Upstream 90-day is omitted because recommended raw/detail
retention is 30 days until owner chooses otherwise.

Show loading, error, unavailable, partial, stale, and empty states. Retain last-good plus
timestamp; manual refresh; 30-second polling only visible+online; AbortController on hide/offline/
new request. Nonsecret range/filter preferences may persist; session token only sessionStorage.
The short-lived token is held in memory; sessionStorage is its only persistent browser storage;
never localStorage/cookie. No WebSocket. Dialog focus returns safely. Provide table/text chart equivalents, non-color signals, reduced
motion, light/dark, and 320/768/1280 layouts without critical horizontal loss.

## Files, build, and package

| File/module | Responsibility |
| --- | --- |
| `src/dashboard-contract.ts` | Server-safe shared contract; no DOM imports. |
| `src/dashboard-static.ts` | Manifest/MIME/CSP/static/HEAD behavior. |
| `src/dashboard-auth.ts` | Bootstrap/session/admission/replay/logout. |
| `src/dashboard-routes.ts` | Narrow routes, media validation, errors. |
| `src/dashboard-snapshot.ts` | Bounded projection and UTC bucket mapping. |
| `dashboard/src/main.tsx` | React bootstrap and fragment scrub. |
| `dashboard/src/api.ts` | Header auth, omit credentials, aborts. |
| `dashboard/src/pages/AnalyticsDashboard.tsx` | Panels/cards/dialog/accessibility. |
| `dashboard/vite.config.ts` | Dedicated staged hashed build. |
| `dashboard/vitest.config.ts` | Separate dashboard test config. |
| `dashboard/index.html` | Static Vite entry shell. |
| `dashboard/tsconfig.json` | Dashboard TypeScript compiler boundary. |
| `dashboard/src/view-model.ts` | Derived display values, including nullable headroom. |
| `dashboard/src/formatters.ts` | Safe timestamp, number, and provenance formatting. |
| `dashboard/src/styles.css` | Self-hosted light/dark and responsive styles. |
| `dashboard/src/components/` | Accessible reusable controls and tables. |
| `dashboard/src/charts/` | Chart adapters with text/table equivalents. |
| `test/dashboard/auth.test.ts` | Bootstrap/session/admission/replay tests. |
| `test/dashboard/routes.test.ts` | Static and protected route tests. |
| `test/dashboard/contract.test.ts` | Contract/media/provenance fixtures. |
| `dashboard/src/components/dashboard.test.tsx` | Component, filters, polling, and dialog tests. |
| `dashboard/src/a11y.test.tsx` | Keyboard, focus, contrast, and reduced-motion tests. |
| `test/dashboard/packed-smoke.test.ts` | Packed-install static serving smoke test. |

Stack: React+TS, Vite, Recharts, Tailwind, Lucide, TanStack Query as build/dev dependencies;
no Express/SQLite/router/CDN. Assets are self-hosted. `build:server` runs current
`tsc -p tsconfig.json`; `build:dashboard` runs Vite and emits only dedicated
`dist/dashboard`; `check:dashboard` runs dashboard `tsc --noEmit` plus its separate Vitest
config. Root `build` runs build:server then build:dashboard; root `check` retains the existing
typecheck/test chain then check:dashboard without widening main Vitest.

`package.json files`/tarball include dashboard dist, manifest, assets, notices/licenses; packed
install serves them. Clean-room is preferred. If substantial upstream code/style is copied, add
freellmapi MIT notice (`v0.8.3, Copyright (c) 2026 Tashfeen Ahmed`) to THIRD_PARTY_NOTICES and
include dependency/asset licenses, including Lucide ISC and Geist/Mono OFL if used. No logo/
branding. Measure first bundle/tarball sizes during implementation only; label future and ratchet
the observed baseline.

## Packets and gates

| Packet | Deliverables | Required tests | Green means |
| --- | --- | --- | --- |
| P0 canonical meter/read + contract | Ledger projection, contract, fixtures | types/schema/media/provenance/null/caps | Minimum truthful data exists. |
| P1 auth/static | Shell, manifest, bootstrap/session/logout | replay/admission/cache/traversal/routes | Tokenless surface narrow. |
| P2 snapshot/detail projection | UTC snapshot, attempts, quota/cooldown | bucket/repair/attribution/caps | No egress or scan. |
| P3 SPA parity/UX | Charts, filters, cards, dialog, responsive states | component/polling/detail/a11y | P0-P3 are green; then the dashboard may be linked. |
| P4 hardening/packaging | CSP, notices, package serving | packed install/assets/licenses | Artifact complete. |

Design complete now means this plan is ready. Implementation done later requires packets and
evidence. P0, P1, P2, and P3 must all be green before dashboard is linked; every packet preserves
`npm run build && npm run check`; P4 must be green before release/package completion.

| Gate | Required evidence |
| --- | --- |
| Auth | Replay, expiry, idle/absolute, restart, Host, Origin, Sec-Fetch-Site, Content-Type, cookies/CORS, logs. |
| Static | Manifest, traversal, MIME, CSP/cache, HEAD, 404, no shadow, liveness unchanged. |
| Schema | Fixtures/types/media version, provenance/null, caps. |
| Component | States, filters, polling, detail, formatting. |
| Accessibility | axe/equivalent, keyboard/focus, tables, widths, light/dark/reduced motion. |
| Packed artifact | npm pack/install serve, hashed assets, notices/licenses, first size measurement. |

Authoritative implementation gate: `npm run build && npm run check`.

## Risks and decisions

| Risk | Mitigation |
| --- | --- |
| Insufficient meters | Unavailable/partial coverage; unlinked before P0. |
| Credential leakage | Opaque IDs, allow-list, metadata logs, no raw errors. |
| Auth/replay | Atomic in-memory expiry, strict admission, no cookies. |
| Dependency/license | Self-hosted lock and notices/tarball test. |
| Asset/API skew | Manifest, shared contract, versioned media, hard failure. |
| UTC/DST | Server UTC boundaries and explicit labels. |
| Catch-all liveness masking | Narrow routes and liveness regression tests. |
| Package growth | Measure then ratchet observed baseline. |
| Polling/read cost | Poll only visible+online at 30 seconds; cancel superseded reads and cap projections. |
| Sensitive recent-request metadata exposure | Return only allow-listed opaque IDs, safe client classes, and normalized failures. |
| CSP/license drift | CSP and third-party notices are checked in static/packed-artifact gates. |
| Route regression | Allow/no-shadow tests across existing families. |

| Status | Decision |
| --- | --- |
| Owner-resolved | G3: full SPA. |
| Project binding constraints | Read-only bounded metadata access, loopback and security invariants; these are not an owner choice. |
| Open/reversible | Retention; recommended 30 days, owner-changeable. |
| Open/reversible | Repair inclusion default and caller-attribution display policy. |
| Open/reversible | Price source and basis display. |
| Open/reversible | Learned quota display-only behavior. |
| Open/reversible | 90-day window after retention choice. |
| Open/reversible | C4 UTC boundaries and bucket mapping. |

Recommendations are not resolutions. No open item is silently settled.
