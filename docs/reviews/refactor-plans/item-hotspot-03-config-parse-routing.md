# HOTSPOT-03 — Routing-Schema Parser Extraction (`src/config.ts`, function `parseRouting`)

Scope: extract routing-schema parsing and normalization out of `src/config.ts`
(hotspot score 9,590; churn 70; catalog max cognitive 137 in `parseRouting`)
into `src/config/routing-parser.ts`, keeping `src/config.ts` as the root
config loader and typed export barrel.
Adversarial verdict: ACCEPT per `docs/reviews/adversarial-verification-2026-09-05.md`
(rule-parser combinators), with the catalogued erratum: the in-source comment
near `parseRouting` reports cognitive 124 while the catalog claims 137 —
confirm the governing number from `complexity-report.json` before sizing the
combinator split.

Target modules:

- `src/config/routing-parser.ts` — `parseRouting` plus its routing-only
  callees (new home)
- `src/config.ts` — keeps `loadConfig`, provider parsing, env expansion, and
  the public barrel; imports `parseRouting` instead of defining it

Two adjudicated corrections to the brief, both verified by direct source
inspection — the plan proceeds on the corrected symbol set:

- There is no `parseSubagents` function in `src/config.ts`. Subagent routing
  is the inline subagents-record assembly inside `parseRouting` plus the
  request-path reader `subagentSpec`. The inline assembly moves with
  `parseRouting`; `subagentSpec` stays in `src/config.ts` (its consumers are
  request-path, not load-path).
- There is no `parseLaneManifest` function in `src/config.ts`. Lane-manifest
  loading is `loadLaneManifest` in `src/lane-manifest.ts`, already its own
  home. `parseLadder` and `parseCliLane` — the ladder/lane-schema parsers
  `parseRouting` actually calls — move into `routing-parser.ts`.

## Architectural rationale and layering

`parseRouting` is a load-path pure function: raw unknown JSON plus already
parsed providers in, a validated `Routing` object out, with load-time throws
for unknown providers/pools and warnings for disabled-provider degradation.
Its callees split cleanly into routing-owned versus shared:

- Routing-owned (move): `parseLadder`, `parseCliLane`, `parseSticky`,
  `parseMcpSettings`, `parseLaneProbe`, `parseQuotaEnforcement`,
  `parseLatencyDemotion`, `parseHedge`, `parseOffload` (exported — re-exported
  from `config.ts`), `dropDisabledSpecs`, `assertSpecResolvable`.
- Shared with provider parsing and the request path (stay in `config.ts`,
  imported by the new module): `splitSpec`, `resolveReshaperPool`-adjacent
  pool helpers only if shared (verify importer lists first),
  `EFFORT_LEVEL_SET` / `POOL_PREFIX` / `AUTO_MODEL` constants, and all
  `config-types.js` types.
- `subagentSpec`, `resolveTargets`, `resolveTarget`, `expandPoolSpecs`,
  `clientForPath`, `offloadRule`, `anyOffloadEnabled` stay: they read a loaded
  `Config` at request time and are imported across `src/server.ts`,
  `src/cli.ts`, and the routes. Moving request-path readers into a load-path
  parser module would invert the layer.

The edge direction after the move is `config.ts` → `config/routing-parser.ts`
→ `config-types.js`, with shared constants/types imported upward from
`config.js`. `routing-parser.ts` never imports `loadConfig`, provider parsing,
or any request-path module — load order stays acyclic and `parseRouting`
remains synchronously callable from `loadConfig` with no I/O added.

Combinator follow-up (explicitly second sub-phase, not this move): once the
parser has a single home, the repeated per-section shapes inside `parseRouting`
— the reserved-name guards, the default/tiers single-or-array spec
normalization, the pools policy-vs-array branch with disabled-member dropping
and pool-in-pool rejection, the disabled-spec degradation loop, and the final
`assertSpecResolvable` sweep — become small section parsers behind one
`parseRoutingSection(raw, ctx)` shape. The move must land first so the
combinator diff is reviewable against one file.

## Complete blast radius

Seed symbol (verified by direct source inspection):

- Function `parseRouting` in `src/config.ts` — private (not exported); sole
  caller is `loadConfig` in the same file. Its ordered phases, each located by
  semantic anchor:
  - *Reserved-name guards*: rejection when a provider is named with the pool
    prefix or the auto-model literal (ambiguity with `pool/<name>` routing).
  - *Default*: single-or-array spec normalization with the required-default
    throw.
  - *Tiers*: per-entry string-or-array filtering.
  - *Pools*: array-vs-policy-object branch, preferred/include/exclude/effort
    validation, disabled-provider member dropping with warnings, the
    pool-in-pool rejection.
  - *Subagents*: inline string-valued record assembly (the `parseSubagents`
    equivalent — no such function exists; this record is the material).
  - *Section assembly*: `benchmarkSort`, `parseOffload`, `parseSticky`,
    `parseQuotaEnforcement`, `parseLatencyDemotion`, `parseHedge`,
    `parseLaneProbe`, `parseMcpSettings`, `parseLadder` (singular plus the
    named-`ladders` map with per-tier non-empty enforcement), `parseCliLane`.
  - *Disabled-spec degradation*: the tiers/subagents/array-default/ladder
    sweep via `dropDisabledSpecs` with the single-spec-default fatality rule
    documented at the sweep.
  - *Resolution assertions*: the `assertSpecResolvable` sweep over default,
    tiers, pools, subagents, and ladder rungs.

Symbols moving to `src/config/routing-parser.ts`: `parseRouting`,
`parseLadder`, `parseCliLane`, `parseSticky`, `parseMcpSettings`,
`parseLaneProbe`, `parseQuotaEnforcement`, `parseLatencyDemotion`,
`parseHedge`, `parseOffload` (re-exported from `config.ts`),
`dropDisabledSpecs`, `assertSpecResolvable`.

Symbols staying in `src/config.ts`: `loadConfig`, `parseProviders`,
`parseSingleProvider`, `validateProviderCredentialMode`,
`validateProviderConcurrency`, `parseCredentialDeclarations`,
`parseLeaveMeAlone`, `expandEnv`, `expandEnvSoft`, `parseAuthHeader`,
`appendKeystoreDegradationWarnings`, `subagentSpec`, `resolveTargets` family,
`splitSpec`, `clientForPath`, `offloadRule`, `anyOffloadEnabled`,
`detectTier`, `pickSpecs`, and the barrel re-exports.

Callers and importers:

- `loadConfig` — the sole caller of `parseRouting`; its call site becomes an
  import. Behavior (throw strings, warning strings, degradation outcomes) is
  byte-identical — config tests match on several of these messages.
- Importers of `parseOffload` (exported): keep the `config.js` specifier
  working via re-export.
- No request-path importer touches `parseRouting` (private) — confirmed by
  the absence of cross-module references.

Affected test suites: `test/config.test.ts`, `test/config-vocabulary.test.ts`,
`test/closed-vocabulary-routing.test.ts`, `test/degraded-config.test.ts`,
`test/configured-limits.test.ts`, `test/presets.test.ts` (if present),
plus consumer suites that load routing fixtures (`test/dispatch.test.ts`).

## Specific code modifications with contracts

No signature changes: `parseRouting` keeps its exact parameter list and return
type. The contract below is the invariant the move preserves:

```typescript
import type { ProviderConfig, Routing } from "../config-types.js";

export function parseRouting(
  raw: unknown,
  providers: Record<string, ProviderConfig>,
  overrideDefault: string | undefined,
  warnings?: string[],
  disabledProviders?: Set<string>,
): Routing;
```

Contract:

- Pure and synchronous: no filesystem, network, or clock reads. (The current
  body already satisfies this; the plan asserts it so the combinator phase
  can rely on it.)
- Throws with byte-identical messages for reserved names, malformed defaults,
  malformed pools, pool-in-pool members, malformed ladders, and unresolvable
  specs; pushes byte-identical disabled-provider warnings.
- Returns the identical `Routing` shape, including conditional key presence
  (`pools`, `poolPolicies`, `subagents`, `ladder`, `ladders`, `cliLane`,
  `sticky`, `quota`, `mcp` set only when non-empty/defined).

Before (representative — inside function `loadConfig` in `src/config.ts`, at
the routing-assembly site where the raw routing section is handed off):

```typescript
const routing = parseRouting(rawRouting, providers, overrideDefault, warnings, disabledProviders);
```

After (same anchor — the call site is unchanged except for the import at the
top of `src/config.ts`):

```typescript
import { parseRouting } from "./config/routing-parser.js";

// …at the same assembly site, unchanged body:
const routing = parseRouting(rawRouting, providers, overrideDefault, warnings, disabledProviders);
```

And the single compatibility re-export kept in `src/config.ts`:

```typescript
export { parseOffload } from "./config/routing-parser.js";
```

(If `parseOffload` has no external importers, drop the re-export instead —
verify by text search before deciding; the default is to keep it.)

## Step-by-step implementation sequence

1. Confirm the governing `parseRouting` complexity number from
   `complexity-report.json` (catalog 137 versus in-source 124) and record it
   in the module header comment of the new file, replacing the stale gloss.
2. Create `src/config/routing-parser.ts` by moving `parseRouting` and the ten
   routing-owned callees verbatim; import shared constants/types/helpers from
   the parent `config.js` and `config-types.js`.
3. Rewire `loadConfig` to import `parseRouting`; add the `parseOffload`
   re-export decision per the importer search.
4. Run the verification plan below; delete no old code until all config
   suites pass.
5. Follow-up (separate change, same module): fold the repeated section shapes
   into `parseRoutingSection` combinators, one section per commit, with the
   config suites green between each.

## Verification and regression test plan

Exact commands, run from the repository root:

```powershell
npm test -- test/config.test.ts
npm test -- test/config-vocabulary.test.ts
npm test -- test/closed-vocabulary-routing.test.ts
npm test -- test/degraded-config.test.ts
npm test -- test/configured-limits.test.ts
npm test -- test/dispatch.test.ts
npx tsc --noEmit
```

Automated checks and invariant assertions:

- All listed suites pass with zero throw-message or warning-text changes
  (the move is behavior-preserving by construction; several suites assert on
  these strings).
- A targeted invariant test asserts `parseRouting` purity: two calls over
  the same inputs return deep-equal `Routing` objects, and a fixture ladder
  with a disabled provider degrades with warnings rather than throwing while
  an unknown provider still throws.
- Confirm by text search that `src/config.ts` no longer defines any moved
  symbol and that `routing-parser.ts` imports nothing from request-path
  modules (`server.js`, route handlers, `cli.js`).
- Confirm zero line-number references were introduced by this change (symbol
  anchors only, per this plan's mandatory constraint).
