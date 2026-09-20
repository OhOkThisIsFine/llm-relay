/**
 * Parsing and validating the `routing` block of a config document (HOTSPOT-03).
 *
 * `parseRouting` plus the thirty-six declarations only it reaches: the nine sub-block parsers
 * (`parseQuotaEnforcement`, `parseLatencyDemotion`, `parseHedge`, `parseProbation`, `parseCrawl`,
 * `parseMcpSettings`, `parseLaneProbe`, `parseDispatchWalk`, `parseSticky`) assembled by `parseOptionalBlocks`,
 * `parseOffload`, the top-level field parsers `assertNoReservedProviderNames`, `parseDefault`,
 * `parseTiers` and `parseSubagents`, the pool trio `parsePoolPolicy`/`parsePoolEntry`/`parsePools`,
 * the ladder family (`parseLadder`, `parseLadders`, `parseCliLane`, `parseSpawnEnv` and its three
 * placeholder tokens), the disabled-provider degradation family (`dropDisabledSpecs`,
 * `dropDisabledRungs`, `pruneDisabledSpecEntries`, `degradeDisabledRouting`), the resolvability
 * trio `assertSpecResolvable`/`assertRungsResolvable`/`assertRoutingResolvable`,
 * `hasAsciiControl`, `DEFAULT_LANE_PROBE`, `DEFAULT_DISPATCH_WALK` and `EFFORT_LEVEL_SET`.
 * Roughly 700 lines out of a 2,000-line `config.ts`.
 *
 * ⚠ **It imports `config-types.js` and `spec.js`, and NOTHING else.** That is the property the item
 * asks for, and it is why `spec.ts` had to exist first: this parser needs `POOL_PREFIX`,
 * `AUTO_MODEL` and `splitSpec`, and reaching into `config.js` for them would be a cycle straight
 * back into the file it was extracted from. The dependency runs one way — `config.ts` imports this
 * module and re-exports its three publicly-consumed names, so no other importer changed.
 *
 * ⚠ Everything here is PURE over its inputs: no IO, no clock, no randomness, no `await`. A config
 * document goes in and either a validated `Routing` comes out or a `ConfigError` is thrown. Keep it
 * that way — the request path must never be reachable from a parser, and a parser that read the
 * filesystem could not be tested by handing it a literal.
 *
 * ⚠ A parse failure here is LOUD by design. An unknown key in a `compat`, `limits`, `hedge`,
 * `latency` or `laneProbe` block is a hard load error naming the key, because an ignored typo reads
 * as a declaration that took effect while the wire was unchanged. The one deliberate exception is
 * an unset `${ENV}`, which DISABLES one provider rather than aborting startup: this proxy fronts
 * every client session, so refusing to start would turn one unused optional provider into a total
 * outage. See the degradation rules in `CLAUDE.md`.
 */

import {
  DEFAULT_MCP_BLOCKING_WAIT_MS,
  DEFAULT_MCP_MAX_WAIT_MS,
  EFFORT_LEVELS,
  type CliLaneTemplate,
  type DispatchWalkOutlierSettings,
  type CrawlWatchdogConfig,
  type DispatchWalkSettings,
  type EffortLevel,
  type HedgeConfig,
  type LadderRung,
  type LaneProbeSettings,
  type LatencyDemotionConfig,
  type McpSettings,
  type OffloadConfig,
  type OffloadRule,
  type PacingConfig,
  type PoolPolicy,
  type ProbationConfig,
  type ProviderConfig,
  type QuotaEnforcementConfig,
  type Routing,
  type StickyRoutingConfig,
} from "../config-types.js";
import { AUTO_MODEL, POOL_PREFIX, splitSpec } from "../spec.js";

const EFFORT_LEVEL_SET: ReadonlySet<string> = new Set(EFFORT_LEVELS);

/**
 * Validate `routing.quota`. A malformed block is a hard error rather than silently ignored:
 * an operator who wrote `"enforceLearned": "yes"` believes they opted into gating on learned
 * limits when they have not, which is precisely the silent-divergence shape this file's other
 * parsers reject by name.
 */
function parseQuotaEnforcement(raw: unknown): QuotaEnforcementConfig | undefined {
  if (raw === undefined || raw === null) return undefined;
  if (typeof raw !== "object" || Array.isArray(raw)) {
    throw new Error("config.routing.quota must be an object");
  }
  const value = raw as Record<string, unknown>;
  const out: QuotaEnforcementConfig = {};
  if (value.enforce !== undefined) {
    if (typeof value.enforce !== "boolean") throw new Error("config.routing.quota.enforce must be a boolean");
    out.enforce = value.enforce;
  }
  if (value.enforceLearned !== undefined) {
    if (typeof value.enforceLearned !== "boolean") {
      throw new Error("config.routing.quota.enforceLearned must be a boolean");
    }
    out.enforceLearned = value.enforceLearned;
  }
  if (value.hardCaps !== undefined) {
    if (typeof value.hardCaps !== "boolean") {
      throw new Error("config.routing.quota.hardCaps must be a boolean");
    }
    out.hardCaps = value.hardCaps;
  }
  return out;
}

/**
 * Validate `routing.latency`. Malformed is a hard error, and an UNKNOWN KEY is a hard error too —
 * the `compat`/`configured-limits` precedent rather than the looser `routing.quota` one. An
 * operator who wrote `"p95ms": 5000` (wrong case) believes they lowered the ceiling; silently
 * ignoring the key would leave the default in force while looking like it had been changed.
 *
 * ⚠ Both numbers must be finite and positive. `0` would demote every measured deployment at once
 * and a negative or `NaN` ceiling bounds nothing while looking like it does.
 */
function parseLatencyDemotion(raw: unknown): LatencyDemotionConfig {
  // ABSENT returns `{}`, not `undefined`, and the two are the same thing here: every key is
  // optional and the module resolves its own defaults, so "{}" IS "all defaults". Returning a
  // total value lets the caller assign unconditionally — the `laneProbe` precedent — which keeps
  // `parseOptionalBlocks` and `parseRouting` free of another branch. (`parseRouting` was split
  // into per-sub-block helpers on 2026-09-09, 125 → 12; the total return is what keeps the copy
  // onto `Routing` a plain assignment rather than a fifth conditional.)
  if (raw === undefined || raw === null) return {};
  // The boolean shorthand is NORMALIZED here rather than carried through the type. One shape
  // downstream means the demotion module never re-implements "what does `false` mean".
  if (typeof raw === "boolean") return { enabled: raw };
  if (typeof raw !== "object" || Array.isArray(raw)) {
    throw new Error("config.routing.latency must be an object or a boolean");
  }
  const value = raw as Record<string, unknown>;
  const known = new Set(["enabled", "p95Ms", "msPerToken", "minSamples"]);
  for (const key of Object.keys(value)) {
    if (!known.has(key)) {
      throw new Error(`config.routing.latency has an unknown key "${key}"`);
    }
  }
  const out: LatencyDemotionConfig = {};
  if (value.enabled !== undefined) {
    if (typeof value.enabled !== "boolean") throw new Error("config.routing.latency.enabled must be a boolean");
    out.enabled = value.enabled;
  }
  for (const key of ["p95Ms", "msPerToken", "minSamples"] as const) {
    const n = value[key];
    if (n === undefined) continue;
    if (typeof n !== "number" || !Number.isFinite(n) || n <= 0) {
      throw new Error(`config.routing.latency.${key} must be a positive finite number`);
    }
    out[key] = n;
  }
  return out;
}

/**
 * Validate `routing.hedge`. Malformed is a hard error, and an UNKNOWN KEY is a hard error too —
 * the `routing.latency` precedent, for the same reason: an operator who wrote `"floorms": 40000`
 * believes they raised the floor, and a silently ignored key leaves the default in force while
 * looking like it was changed.
 *
 * ⚠ Every number must be finite and positive. A `0` floor removes the one bound that stops a fast
 * pool duplicating almost every request, and a negative or `NaN` value bounds nothing while looking
 * like it does. `floorMs` and `minFloorMs` are both accepted and both validated the same way here —
 * this function only checks shape; `resolveHedgeSettings` decides which one wins when both are set.
 */
function parseHedge(raw: unknown): HedgeConfig {
  // ABSENT returns `{}`, not `undefined` — the `parseLatencyDemotion` precedent. Every key is
  // optional and `resolveHedgeSettings` owns the defaults, so `{}` IS "all defaults", and a total
  // return lets the caller assign unconditionally without another branch in `parseOptionalBlocks`.
  if (raw === undefined || raw === null) return {};
  // The boolean shorthand is NORMALIZED here rather than carried through the type, so the trigger
  // module never re-implements "what does `false` mean".
  if (typeof raw === "boolean") return { enabled: raw };
  if (typeof raw !== "object" || Array.isArray(raw)) {
    throw new Error("config.routing.hedge must be an object or a boolean");
  }
  const value = raw as Record<string, unknown>;
  const known = new Set(["enabled", "floorMs", "minFloorMs", "msPerInputToken", "margin", "minSamples"]);
  for (const key of Object.keys(value)) {
    if (!known.has(key)) {
      throw new Error(`config.routing.hedge has an unknown key "${key}"`);
    }
  }
  const out: HedgeConfig = {};
  if (value.enabled !== undefined) {
    if (typeof value.enabled !== "boolean") throw new Error("config.routing.hedge.enabled must be a boolean");
    out.enabled = value.enabled;
  }
  for (const key of ["floorMs", "minFloorMs", "msPerInputToken", "margin", "minSamples"] as const) {
    const n = value[key];
    if (n === undefined) continue;
    if (typeof n !== "number" || !Number.isFinite(n) || n <= 0) {
      throw new Error(`config.routing.hedge.${key} must be a positive finite number`);
    }
    out[key] = n;
  }
  return out;
}

/**
 * Validate `routing.probation`. Malformed is a hard error, and an UNKNOWN KEY is a hard error
 * too — the `routing.latency`/`routing.hedge` precedent: an operator who wrote `"min-samples"`
 * believes they lowered the floor, and a silently ignored key leaves the default in force while
 * looking like it was changed.
 *
 * ⚠ `minSamples` must be a POSITIVE INTEGER, not merely a positive number. A fractional sample
 * count bounds nothing while looking like it does, and 0 would admit every free deployment to
 * the band at once — the point of the floor is that members leave it one at a time.
 */
function parseProbation(raw: unknown): ProbationConfig {
  // ABSENT returns `{}`, not `undefined` — the `parseLatencyDemotion` precedent. Every key is
  // optional and the consumer resolves its own defaults (`{}` IS "all defaults", i.e. ON with
  // `minSamples: 5`), so a total return keeps `parseOptionalBlocks` branch-free.
  if (raw === undefined || raw === null) return {};
  // The boolean shorthand is NORMALIZED here rather than carried through the type, so the
  // probation check never re-implements "what does `false` mean".
  if (typeof raw === "boolean") return { enabled: raw };
  if (typeof raw !== "object" || Array.isArray(raw)) {
    throw new Error("config.routing.probation must be an object or a boolean");
  }
  const value = raw as Record<string, unknown>;
  const known = new Set(["enabled", "minSamples"]);
  for (const key of Object.keys(value)) {
    if (!known.has(key)) {
      throw new Error(`config.routing.probation has an unknown key "${key}"`);
    }
  }
  const out: ProbationConfig = {};
  if (value.enabled !== undefined) {
    if (typeof value.enabled !== "boolean") throw new Error("config.routing.probation.enabled must be a boolean");
    out.enabled = value.enabled;
  }
  if (value.minSamples !== undefined) {
    const n = value.minSamples;
    if (typeof n !== "number" || !Number.isInteger(n) || n <= 0) {
      throw new Error("config.routing.probation.minSamples must be a positive integer");
    }
    out.minSamples = n;
  }
  return out;
}

/**
 * Validate `routing.pacing`. Malformed is a hard error, and an UNKNOWN KEY is a hard error too —
 * the `routing.probation` precedent: an operator who wrote `"enable": false` believes they turned
 * the band off, and a silently ignored key leaves it in force while looking like it was changed.
 * The block carries no numbers on purpose: every ceiling pacing holds a cell to is STATED by the
 * provider, the operator's `limits` block or a learned fact — a tunable here would be an invented
 * one.
 */
function parsePacing(raw: unknown): PacingConfig {
  // ABSENT returns `{}`, not `undefined` — the `parseProbation` precedent: `{}` IS "all defaults"
  // (ON), so a total return keeps `parseOptionalBlocks` branch-free.
  if (raw === undefined || raw === null) return {};
  // The boolean shorthand is NORMALIZED here, so `pacing.ts` never decides what `false` means.
  if (typeof raw === "boolean") return { enabled: raw };
  if (typeof raw !== "object" || Array.isArray(raw)) {
    throw new Error("config.routing.pacing must be an object or a boolean");
  }
  const value = raw as Record<string, unknown>;
  for (const key of Object.keys(value)) {
    if (key !== "enabled") throw new Error(`config.routing.pacing has an unknown key "${key}"`);
  }
  const out: PacingConfig = {};
  if (value.enabled !== undefined) {
    if (typeof value.enabled !== "boolean") throw new Error("config.routing.pacing.enabled must be a boolean");
    out.enabled = value.enabled;
  }
  return out;
}

/**
 * Validate `routing.crawl`. Malformed is a hard error, and an UNKNOWN KEY is a hard error too —
 * the `routing.latency`/`routing.hedge` precedent: an operator who wrote `"msPerToken": 500`
 * believes they lowered the bar, and a silently ignored key leaves the default in force while
 * looking like it was changed.
 *
 * ⚠ Every number must be finite and positive. A `0` `msPerToken` would abort every committed
 * stream on its first measured window, a `0` `windowMs`/`minTokens` bounds nothing while looking
 * like it does, and a negative or `NaN` value is the same defect in different clothes.
 */
function parseCrawl(raw: unknown): CrawlWatchdogConfig {
  // ABSENT returns `{}`, not `undefined` — the `parseLatencyDemotion`/`parseHedge` precedent.
  // Every key is optional and `resolveCrawlSettings` owns the defaults, so `{}` IS "all
  // defaults", and a total return lets the caller assign unconditionally without another branch
  // in `parseOptionalBlocks`.
  if (raw === undefined || raw === null) return {};
  // The boolean shorthand is NORMALIZED here rather than carried through the type, so the
  // watchdog module never re-implements "what does `false` mean".
  if (typeof raw === "boolean") return { enabled: raw };
  if (typeof raw !== "object" || Array.isArray(raw)) {
    throw new Error("config.routing.crawl must be an object or a boolean");
  }
  const value = raw as Record<string, unknown>;
  const known = new Set(["enabled", "msPerToken", "windowMs", "minTokens"]);
  for (const key of Object.keys(value)) {
    if (!known.has(key)) {
      throw new Error(`config.routing.crawl has an unknown key "${key}"`);
    }
  }
  const out: CrawlWatchdogConfig = {};
  if (value.enabled !== undefined) {
    if (typeof value.enabled !== "boolean") throw new Error("config.routing.crawl.enabled must be a boolean");
    out.enabled = value.enabled;
  }
  for (const key of ["msPerToken", "windowMs", "minTokens"] as const) {
    const n = value[key];
    if (n === undefined) continue;
    if (typeof n !== "number" || !Number.isFinite(n) || n <= 0) {
      throw new Error(`config.routing.crawl.${key} must be a positive finite number`);
    }
    out[key] = n;
  }
  return out;
}

export function parseRouting(
  raw: unknown,
  providers: Record<string, ProviderConfig>,
  overrideDefault: string | undefined,
  warnings: string[] = [],
  disabledProviders: Set<string> = new Set(),
): Routing {
  const r = (typeof raw === "object" && raw !== null ? raw : {}) as {
    default?: unknown;
    tiers?: unknown;
    pools?: unknown;
    offload?: unknown;
    subagents?: unknown;
    benchmarkSort?: unknown;
    sticky?: unknown;
    quota?: unknown;
    latency?: unknown;
    hedge?: unknown;
    probation?: unknown;
    pacing?: unknown;
    crawl?: unknown;
    laneProbe?: unknown;
    dispatchWalk?: unknown;
    mcp?: unknown;
    ladder?: unknown;
    ladders?: unknown;
    cliLane?: unknown;
  };
  // Reject reserved provider names that would shadow routing syntax.
  assertNoReservedProviderNames(providers);
  const dflt = parseDefault(r.default, overrideDefault);
  const tiers = parseTiers(r.tiers);

  const { pools, poolPolicies } = parsePools(r.pools, disabledProviders, warnings);

  const subagents = parseSubagents(r.subagents);

  const benchmarkSort = typeof r.benchmarkSort === "boolean" ? r.benchmarkSort : true;
  const offload = parseOffload(r.offload);
  const routing: Routing = { default: dflt, tiers, benchmarkSort, offload };
  const optionalBlocks = parseOptionalBlocks(r, warnings);
  if (optionalBlocks.sticky) routing.sticky = optionalBlocks.sticky;
  if (optionalBlocks.quota) routing.quota = optionalBlocks.quota;
  routing.latency = optionalBlocks.latency;
  routing.hedge = optionalBlocks.hedge;
  routing.probation = optionalBlocks.probation;
  routing.pacing = optionalBlocks.pacing;
  routing.crawl = optionalBlocks.crawl;
  routing.laneProbe = optionalBlocks.laneProbe;
  routing.dispatchWalk = optionalBlocks.dispatchWalk;
  if (optionalBlocks.mcp) routing.mcp = optionalBlocks.mcp;
  if (Object.keys(pools).length > 0) routing.pools = pools;
  if (Object.keys(poolPolicies).length > 0) routing.poolPolicies = poolPolicies;
  if (Object.keys(subagents).length > 0) routing.subagents = subagents;
  const ladder = parseLadder(r.ladder, "config.routing.ladder", warnings);
  if (ladder.length > 0) routing.ladder = ladder;
  const ladders = parseLadders(r.ladders, warnings);
  if (Object.keys(ladders).length > 0) routing.ladders = ladders;
  const cliLane = parseCliLane(r.cliLane, "config.routing.cliLane");
  if (cliLane) routing.cliLane = cliLane;

  // A spec naming a DISABLED provider is dropped with a warning, exactly like a pool member;
  // a spec naming a provider that was never declared is still fatal below. Doing this before
  // the assertions is what keeps "one optional provider lost its ${ENV}" from being a total
  // outage: assertSpecResolvable sees the post-disabling provider map, so it cannot tell the
  // two apart and used to abort startup for the degraded case too.
  degradeDisabledRouting(routing, tiers, subagents, ladder, disabledProviders, warnings);

  // Fail loudly at load time if any spec names an unknown provider or pool. Only
  // `routing.default` can still trip on a DISABLED provider — everything else degraded
  // above — and it is fatal on purpose: it is the fall-through for everything, so there
  // is nowhere left to fall through to.
  assertRoutingResolvable(routing, tiers, pools, subagents, providers, disabledProviders);
  return routing;
}

/**
 * Absent ⇒ every default. An unknown key is a hard error naming it (the `laneProbe` and `compat`
 * precedent: an ignored typo reads as a setting that took effect while bounding nothing).
 *
 * `maxWaitMs` is the ceiling on one `dispatch` tool call's blocking wait. It must be a positive
 * INTEGER: 0 or a negative bounds nothing, a fraction is not a whole millisecond, and a string
 * is never a duration even when it spells one. Absent fills the default rather than staying
 * absent, so a present-but-silent block still declares the ceiling the server enforces.
 */
const MCP_SETTINGS_KEYS: readonly string[] = ["allowedRoots", "maxWaitMs", "blockingWaitMs"] satisfies (keyof McpSettings)[];

function parseMcpSettings(raw: unknown, warnings: string[] = []): McpSettings | undefined {
  if (raw === undefined || raw === null) return undefined;
  if (typeof raw !== "object" || Array.isArray(raw)) {
    throw new Error(`config.routing.mcp must be an object`);
  }
  const o = raw as Record<string, unknown>;
  for (const key of Object.keys(o)) {
    if (!MCP_SETTINGS_KEYS.includes(key)) {
      throw new Error(`config.routing.mcp.${key} is not a recognized key (${MCP_SETTINGS_KEYS.join(", ")})`);
    }
  }
  const out: McpSettings = {};
  if (o.allowedRoots !== undefined) {
    if (!Array.isArray(o.allowedRoots) || o.allowedRoots.some((r) => typeof r !== "string" || r.length === 0)) {
      throw new Error(`config.routing.mcp.allowedRoots must be an array of non-empty strings`);
    }
    out.allowedRoots = [...(o.allowedRoots as string[])];
  }
  if (o.maxWaitMs === undefined) {
    out.maxWaitMs = DEFAULT_MCP_MAX_WAIT_MS;
  } else if (typeof o.maxWaitMs !== "number" || !Number.isInteger(o.maxWaitMs) || o.maxWaitMs <= 0) {
    throw new Error(`config.routing.mcp.maxWaitMs must be a positive integer (milliseconds)`);
  } else if (o.maxWaitMs > DEFAULT_MCP_MAX_WAIT_MS) {
    // ⚠ CLAMPED to the default, not refused and not honoured. The measured defect: calls with
    // `waitMs` of 100000 to 240000 returned `Error: Request timed out` with NO job id at all,
    // because above the host's own tool-call ceiling the call fails AND destroys the job handle —
    // the lane's work is spent and nothing is pollable. The property is "`dispatch` returns a jobId
    // before any client-side request timeout, regardless of waitMs", and a CONFIGURED wait is still
    // a waitMs: the relay cannot honour one the host will not survive, so accepting it here would
    // configure exactly the failure the ceiling exists to prevent.
    //
    // Clamped rather than refused so an existing config keeps loading (the `winenv.ts`/`dotenv.ts`
    // fail-safe direction) — the alternative turns a tuning mistake into a relay that will not
    // start. The clamp is ANNOUNCED on `warnings`, never silent: a ceiling lowered without a word
    // would read as the operator's own number taking effect while it did not, which is the
    // ignored-typo class this parser's own header warns about.
    //
    // And it agrees with the per-call path by construction: `resolveWaitMs` clamps a CALLER's
    // oversized `waitMs` to this same ceiling, so the two halves cannot disagree about what the
    // server will honour.
    out.maxWaitMs = DEFAULT_MCP_MAX_WAIT_MS;
    warnings.push(
      `config.routing.mcp.maxWaitMs ${o.maxWaitMs} exceeds the ${DEFAULT_MCP_MAX_WAIT_MS} ms ceiling — ` +
        `using ${DEFAULT_MCP_MAX_WAIT_MS}. An MCP host fails a tool call answered later than that and ` +
        `DESTROYS the job handle, so a longer blocking wait would lose the lane's work rather than ` +
        `wait longer for it; poll dispatch_status instead.`,
    );
  } else {
    out.maxWaitMs = o.maxWaitMs;
  }
  out.blockingWaitMs = parseBlockingWaitMs(o.blockingWaitMs);
  return out;
}

/**
 * `blockingWaitMs` applies only to a host that tolerates a long call (see `McpSettings`), so it is
 * NOT clamped to `maxWaitMs`. `0` is legal and means "never block past maxWaitMs".
 */
function parseBlockingWaitMs(raw: unknown): number {
  if (raw === undefined) return DEFAULT_MCP_BLOCKING_WAIT_MS;
  if (typeof raw !== "number" || !Number.isInteger(raw) || raw < 0) {
    throw new Error(`config.routing.mcp.blockingWaitMs must be a non-negative integer (milliseconds; 0 turns it off)`);
  }
  return raw;
}

export const DEFAULT_LANE_PROBE: LaneProbeSettings = {
  enabled: true,
  quotaIntervalMs: 6 * 60 * 60 * 1000,
  catalogIntervalMs: 24 * 60 * 60 * 1000,
};

/**
 * Absent ⇒ the defaults (ON — the owner's 2026-08-29 decision that background metadata polling
 * is the relay's job). Boolean toggles `enabled`. An unknown key is a hard error naming it (the
 * `compat` precedent: an ignored typo would read as a setting that took effect while changing
 * nothing).
 */
function parseLaneProbe(raw: unknown): LaneProbeSettings {
  if (raw === undefined || raw === null) return { ...DEFAULT_LANE_PROBE };
  if (typeof raw === "boolean") return { ...DEFAULT_LANE_PROBE, enabled: raw };
  if (typeof raw !== "object" || Array.isArray(raw)) {
    throw new Error(`config.routing.laneProbe must be a boolean or an object`);
  }
  const o = raw as Record<string, unknown>;
  for (const key of Object.keys(o)) {
    if (key !== "enabled" && key !== "quotaIntervalMs" && key !== "catalogIntervalMs") {
      throw new Error(`config.routing.laneProbe.${key} is not a recognized key (enabled, quotaIntervalMs, catalogIntervalMs)`);
    }
  }
  if (typeof o.enabled !== "boolean") {
    throw new Error(`config.routing.laneProbe.enabled must be a boolean`);
  }
  const interval = (name: string, value: unknown, fallback: number): number => {
    if (value === undefined) return fallback;
    if (typeof value !== "number" || !Number.isFinite(value) || value < 60_000 || value > 2_592_000_000) {
      throw new Error(`config.routing.laneProbe.${name} must be between 60000 (1m) and 2592000000 ms (30d)`);
    }
    return Math.floor(value);
  };
  return {
    enabled: o.enabled,
    quotaIntervalMs: interval("quotaIntervalMs", o.quotaIntervalMs, DEFAULT_LANE_PROBE.quotaIntervalMs),
    catalogIntervalMs: interval("catalogIntervalMs", o.catalogIntervalMs, DEFAULT_LANE_PROBE.catalogIntervalMs),
  };
}

/**
 * Defaults for the automatic lane walk. **ON**. The three attempt-budget values remain in this
 * object only for backward-compatible config parsing since v0.84; `idleMs` is the sole walk
 * stopping policy. `attemptMinSamples` remains live for history fallback and outlier demotion.
 */
// ⚠ Literals mirroring `DEFAULT_OUTLIER_RECENT_COUNT` / `DEFAULT_OUTLIER_HISTORY_QUANTILE` /
// `DEFAULT_OUTLIER_FACTOR` in `lane-affinity.ts` (5 / 0.8 / 7.6 — the factor calibrated by
// `scripts/calibrate-lane-outlier.mjs` on 2026-09-09, pooled p95 7.57 over 155 ratios; the
// figures and the band are recorded beside that constant). This module imports
// `config-types.js` and `spec.js` and NOTHING else (the leaf rule, pinned by a test), so the
// numbers are hand-copied here rather than imported; `test/lane-affinity.test.ts` pins the two
// sides together, so drift fails loudly instead of silently moving the demotion threshold.
export const DEFAULT_DISPATCH_WALK_OUTLIER: DispatchWalkOutlierSettings = {
  recentCount: 5,
  historyQuantile: 0.8,
  outlierFactor: 7.6,
};

export const DEFAULT_DISPATCH_WALK: DispatchWalkSettings = {
  enabled: true,
  idleMs: 300_000,
  attemptMs: 90_000,
  // Historical default retained so old configs deserialize to the same compatibility value.
  agentAttemptMs: 600_000,
  attemptQuantile: 0.8,
  attemptMinSamples: 5,
  maxLanes: 4,
  pinMs: 15 * 60 * 1000,
  demoteMs: 15 * 60 * 1000,
  outlier: { ...DEFAULT_DISPATCH_WALK_OUTLIER },
};

/**
 * Absent ⇒ the defaults (ON). Boolean toggles `enabled`. An unknown key is a hard error naming it
 * — the `compat`/`laneProbe` precedent, because an ignored typo would read as a setting that took
 * effect while changing nothing.
 */
function parseDispatchWalk(raw: unknown, warnings: string[] = []): DispatchWalkSettings {
  if (raw === undefined || raw === null) return { ...DEFAULT_DISPATCH_WALK };
  if (typeof raw === "boolean") return { ...DEFAULT_DISPATCH_WALK, enabled: raw };
  if (typeof raw !== "object" || Array.isArray(raw)) {
    throw new Error(`config.routing.dispatchWalk must be a boolean or an object`);
  }
  const o = raw as Record<string, unknown>;
  const keys = ["enabled", "idleMs", "attemptMs", "agentAttemptMs", "attemptQuantile", "attemptMinSamples", "maxLanes", "pinMs", "demoteMs", "outlier"] as const;
  for (const key of Object.keys(o)) {
    if (!(keys as readonly string[]).includes(key)) {
      throw new Error(`config.routing.dispatchWalk.${key} is not a recognized key (${keys.join(", ")})`);
    }
  }
  if (o.enabled !== undefined && typeof o.enabled !== "boolean") {
    throw new Error(`config.routing.dispatchWalk.enabled must be a boolean`);
  }
  // These legacy budget knobs are still parsed so existing configs keep loading, but since
  // v0.84.0 the walk stops a lane only on observable idleness (`idleMs`). Announce an explicit
  // setting rather than letting an operator believe it changed the stopping policy.
  for (const key of ["attemptMs", "agentAttemptMs", "attemptQuantile"] as const) {
    if (o[key] !== undefined) {
      warnings.push(
        `config.routing.dispatchWalk.${key} has no effect on when a lane is stopped since v0.84.0: ` +
          `the walk stops a lane only when it is idle (idleMs).`,
      );
    }
  }
  const bounded = (name: string, value: unknown, fallback: number, min: number, max: number): number => {
    if (value === undefined) return fallback;
    if (typeof value !== "number" || !Number.isFinite(value) || value < min || value > max) {
      throw new Error(`config.routing.dispatchWalk.${name} must be a number between ${min} and ${max}`);
    }
    return Math.floor(value);
  };
  return {
    enabled: o.enabled ?? DEFAULT_DISPATCH_WALK.enabled,
    // Floor 30 s: two activity checks (15 s apart) must fit inside it. Ceiling 1 h, as below.
    idleMs: bounded("idleMs", o.idleMs, DEFAULT_DISPATCH_WALK.idleMs, 30_000, 3_600_000),
    // Legacy compatibility validation. Keep the historical accepted range so an old config does
    // not change from valid to invalid merely because the setting became inert.
    attemptMs: bounded("attemptMs", o.attemptMs, DEFAULT_DISPATCH_WALK.attemptMs, 1_000, 3_600_000),
    agentAttemptMs: bounded("agentAttemptMs", o.agentAttemptMs, DEFAULT_DISPATCH_WALK.agentAttemptMs, 1_000, 3_600_000),
    // Legacy compatibility validation; the value remains a fraction strictly inside (0, 1).
    attemptQuantile: (() => {
      const v = o.attemptQuantile;
      if (v === undefined) return DEFAULT_DISPATCH_WALK.attemptQuantile;
      if (typeof v !== "number" || !Number.isFinite(v) || v <= 0 || v >= 1) {
        throw new Error(`config.routing.dispatchWalk.attemptQuantile must be a number greater than 0 and less than 1`);
      }
      return v;
    })(),
    // Live sample floor for history fallback and outlier demotion. Bounded independently of the
    // rolling-window constant because this parser is an import leaf; asking for more than the
    // window holds safely makes the rule silent.
    attemptMinSamples: bounded("attemptMinSamples", o.attemptMinSamples, DEFAULT_DISPATCH_WALK.attemptMinSamples, 1, 1000),
    maxLanes: bounded("maxLanes", o.maxLanes, DEFAULT_DISPATCH_WALK.maxLanes, 1, 20),
    pinMs: bounded("pinMs", o.pinMs, DEFAULT_DISPATCH_WALK.pinMs, 0, 6 * 60 * 60 * 1000),
    demoteMs: bounded("demoteMs", o.demoteMs, DEFAULT_DISPATCH_WALK.demoteMs, 0, 6 * 60 * 60 * 1000),
    outlier: parseDispatchWalkOutlier(o.outlier),
  };
}

/**
 * Absent ⇒ the defaults (ON). `false` makes the rule inert. An object overrides per key.
 * Anything else — including `true`, which is neither `false` nor an object — is a hard error
 * naming the key: the declared type is `false | {...}`, and silently reading `true` as
 * "defaults" would invent a third member (the closed-union gotcha in CLAUDE.md). Unknown
 * keys and out-of-range values are hard errors for the same reason an ignored typo here
 * would read as a setting that took effect while changing nothing.
 */
/**
 * `false` is the operator's own spelling for "off" and stays `false` on the settings (the
 * `recordLaneOutlier` caller reads it as inert); everything else is the object form parsed below.
 * One typed return, so the union is stated once rather than assembled from two return sites.
 */
function parseDispatchWalkOutlier(raw: unknown): DispatchWalkSettings["outlier"] {
  const parsed: DispatchWalkSettings["outlier"] = raw === false ? false : parseDispatchWalkOutlierObject(raw);
  return parsed;
}

function parseDispatchWalkOutlierObject(raw: unknown): DispatchWalkOutlierSettings {
  if (raw === undefined) return { ...DEFAULT_DISPATCH_WALK_OUTLIER };
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    throw new Error(`config.routing.dispatchWalk.outlier must be false or an object`);
  }
  const o = raw as Record<string, unknown>;
  const keys = ["recentCount", "historyQuantile", "outlierFactor"] as const;
  for (const key of Object.keys(o)) {
    if (!(keys as readonly string[]).includes(key)) {
      throw new Error(`config.routing.dispatchWalk.outlier.${key} is not a recognized key (${keys.join(", ")})`);
    }
  }
  const d = DEFAULT_DISPATCH_WALK_OUTLIER;
  const recentCount = o.recentCount;
  if (recentCount !== undefined && (typeof recentCount !== "number" || !Number.isInteger(recentCount) || recentCount < 1 || recentCount > 100)) {
    throw new Error(`config.routing.dispatchWalk.outlier.recentCount must be an integer between 1 and 100`);
  }
  const historyQuantile = o.historyQuantile;
  if (historyQuantile !== undefined && (typeof historyQuantile !== "number" || !Number.isFinite(historyQuantile) || historyQuantile <= 0 || historyQuantile >= 1)) {
    throw new Error(`config.routing.dispatchWalk.outlier.historyQuantile must be a number greater than 0 and less than 1`);
  }
  const outlierFactor = o.outlierFactor;
  if (outlierFactor !== undefined && (typeof outlierFactor !== "number" || !Number.isFinite(outlierFactor) || outlierFactor <= 1 || outlierFactor > 100)) {
    throw new Error(`config.routing.dispatchWalk.outlier.outlierFactor must be a number greater than 1 and at most 100`);
  }
  // Annotated, so a new key on `DispatchWalkOutlierSettings` is a compile error HERE —
  // the parser must decide how it loads, not silently drop it.
  const parsed: DispatchWalkOutlierSettings = {
    recentCount: recentCount ?? d.recentCount,
    historyQuantile: historyQuantile ?? d.historyQuantile,
    outlierFactor: outlierFactor ?? d.outlierFactor,
  };
  return parsed;
}

function parseSticky(raw: unknown): StickyRoutingConfig | undefined {
  if (raw === undefined || raw === null) return undefined;
  if (typeof raw === "boolean") {
    return { enabled: raw, ttlMs: 1_800_000, maxSessions: 1000 };
  }
  if (typeof raw !== "object" || Array.isArray(raw)) {
    throw new Error(`config.routing.sticky must be a boolean or an object`);
  }

  const sticky = raw as Record<string, unknown>;
  if (typeof sticky.enabled !== "boolean") {
    throw new Error(`config.routing.sticky.enabled must be a boolean`);
  }

  let ttlMs = 1_800_000;
  if (sticky.ttlMs !== undefined) {
    if (
      typeof sticky.ttlMs !== "number" ||
      !Number.isFinite(sticky.ttlMs) ||
      sticky.ttlMs < 1000 ||
      sticky.ttlMs > 86_400_000
    ) {
      throw new Error(`config.routing.sticky.ttlMs must be between 1000 and 86400000 ms (1s to 24h)`);
    }
    ttlMs = Math.floor(sticky.ttlMs);
  }

  let maxSessions = 1000;
  if (sticky.maxSessions !== undefined) {
    if (
      typeof sticky.maxSessions !== "number" ||
      !Number.isFinite(sticky.maxSessions) ||
      sticky.maxSessions < 10 ||
      sticky.maxSessions > 100_000
    ) {
      throw new Error(`config.routing.sticky.maxSessions must be an integer between 10 and 100000`);
    }
    maxSessions = Math.floor(sticky.maxSessions);
  }

  return { enabled: sticky.enabled, ttlMs, maxSessions };
}

// "pool" as a provider name would make `pool/<name>` ambiguous. Reject at load, not at request.
function assertNoReservedProviderNames(providers: Record<string, ProviderConfig>): void {
  if (providers[POOL_PREFIX]) {
    throw new Error(`config.providers."${POOL_PREFIX}" is reserved — it would shadow "pool/<name>" routing`);
  }
  if (providers[AUTO_MODEL]) {
    throw new Error(`config.providers."${AUTO_MODEL}" is reserved — it would shadow "${AUTO_MODEL}" routing`);
  }
}

/**
 * Parse `routing.default` — supports array of specs, single spec string, or throws if missing.
 * `overrideDefault` takes precedence when provided (used by CLI --default).
 */
function parseDefault(
  dfltRaw: unknown,
  overrideDefault: string | undefined,
): string | string[] {
  const raw = overrideDefault !== undefined ? overrideDefault : dfltRaw;

  let result: string | string[];
  if (Array.isArray(raw)) {
    const filtered = raw.filter((s): s is string => typeof s === "string" && s.length > 0);
    if (filtered.length === 0) {
      throw new Error(`config.routing.default array must contain at least one valid spec string`);
    }
    result = filtered;
  } else if (typeof raw === "string" && raw.length > 0) {
    result = raw;
  } else {
    throw new Error(`config.routing.default ("provider/model") is required`);
  }
  return result;
}

/**
 * Parse `routing.tiers` — supports array of specs or single spec string per tier.
 * Empty arrays and empty strings are dropped (tier not added).
 */
function parseTiers(
  raw: unknown,
): Record<string, string | string[]> {
  const tiers: Record<string, string | string[]> = {};
  if (typeof raw === "object" && raw !== null) {
    for (const [k, v] of Object.entries(raw as Record<string, unknown>)) {
      if (Array.isArray(v)) {
        const arr = v.filter((s): s is string => typeof s === "string" && s.length > 0);
        if (arr.length > 0) tiers[k] = arr;
      } else if (typeof v === "string" && v.length > 0) {
        tiers[k] = v;
      }
    }
  }
  return tiers;
}

/**
 * Validate the object-policy form of a pool entry (`{preferred, include, exclude, effort}`) —
 * shape checks in that order — and build the filtered member list plus the policy object.
 */
function parsePoolPolicy(
  k: string,
  policy: { preferred?: unknown; include?: unknown; exclude?: unknown; effort?: unknown },
): { declared: string[]; poolPolicy: PoolPolicy } {
  if (!Array.isArray(policy.preferred) || policy.preferred.some((s) => typeof s !== "string" || s.length === 0)) {
    throw new Error(`config.routing.pools.${k}.preferred must be an array of non-empty "provider/model" specs`);
  }
  if (policy.include !== "free") {
    throw new Error(`config.routing.pools.${k}.include must be "free"`);
  }
  if (
    policy.exclude !== undefined &&
    (!Array.isArray(policy.exclude) ||
      policy.exclude.some(
        (s) =>
          typeof s !== "string" ||
          !/^\S+\/\S+$/.test(s) ||
          s.startsWith(`${POOL_PREFIX}/`),
      ))
  ) {
    throw new Error(`config.routing.pools.${k}.exclude must be an array of "provider/model" specs`);
  }
  if (policy.effort !== undefined && !EFFORT_LEVEL_SET.has(policy.effort as string)) {
    throw new Error(`config.routing.pools.${k}.effort must be low, medium, high, or xhigh`);
  }
  const exclude = [...((policy.exclude as string[] | undefined) ?? [])];
  const excluded = new Set(exclude);
  const declared = (policy.preferred as string[]).filter((spec) => !excluded.has(spec));
  const poolPolicy: PoolPolicy = {
    preferred: declared,
    include: "free",
    ...(exclude.length > 0 ? { exclude } : {}),
    ...(policy.effort ? { effort: policy.effort as EffortLevel } : {}),
  };
  return { declared, poolPolicy };
}

/**
 * Parse a single pool entry — validates shape, applies disabled-member filtering,
 * detects nested pools, and builds the pool policy object.
 * Returns { members, poolPolicy } where poolPolicy is undefined for array-form pools.
 */
function parsePoolEntry(
  k: string,
  v: unknown,
  disabledProviders: Set<string>,
  warnings: string[],
): { members: string[]; poolPolicy: PoolPolicy | undefined } {
  let declared: string[];
  let poolPolicy: PoolPolicy | undefined;

  if (Array.isArray(v)) {
    declared = v.filter((s): s is string => typeof s === "string" && s.length > 0);
  } else if (typeof v === "object" && v !== null) {
    const parsed = parsePoolPolicy(k, v as { preferred?: unknown; include?: unknown; exclude?: unknown; effort?: unknown });
    declared = parsed.declared;
    poolPolicy = parsed.poolPolicy;
  } else {
    throw new Error(
      `config.routing.pools.${k} must be an array of specs or {"preferred":[...],"include":"free"}`,
    );
  }

  // Members of a DISABLED provider are dropped, not fatal — the pool's whole purpose is
  // surviving the loss of one candidate. A member naming a provider that simply doesn't
  // exist is still an error below: that's a typo, and silently dropping it would spend
  // primary quota via the passthrough instead of failing loudly.
  const arr = declared.filter((s) => {
    const { provider } = splitSpec(s);
    if (!disabledProviders.has(provider)) return true;
    warnings.push(`routing.pools.${k}: dropped "${s}" — provider "${provider}" is disabled`);
    return false;
  });
  if (arr.length === 0 && !poolPolicy) {
    throw new Error(`config.routing.pools.${k} must contain at least one valid spec string`);
  }
  // Members are provider specs only — pool-in-pool would make expansion recursive.
  const nested = arr.find((s) => s.startsWith(`${POOL_PREFIX}/`));
  if (nested) {
    throw new Error(`config.routing.pools.${k} member "${nested}" — a pool cannot reference another pool`);
  }
  if (poolPolicy) {
    poolPolicy = { ...poolPolicy, preferred: arr, include: "free" };
  }
  return { members: arr, poolPolicy };
}

/**
 * Parse `routing.pools` — iterates keys IN INSERTION ORDER and delegates to parsePoolEntry.
 * Returns { pools, poolPolicies }.
 */
function parsePools(
  raw: unknown,
  disabledProviders: Set<string>,
  warnings: string[],
): { pools: Record<string, string[]>; poolPolicies: Record<string, PoolPolicy> } {
  const pools: Record<string, string[]> = {};
  const poolPolicies: Record<string, PoolPolicy> = {};
  if (typeof raw === "object" && raw !== null) {
    for (const [k, v] of Object.entries(raw as Record<string, unknown>)) {
      const { members, poolPolicy } = parsePoolEntry(k, v, disabledProviders, warnings);
      pools[k] = members;
      if (poolPolicy) poolPolicies[k] = poolPolicy;
    }
  }
  return { pools, poolPolicies };
}

/**
 * The ten optional sub-blocks as `parseRouting` copies them onto the result. `latency`,
 * `hedge`, `probation`, `pacing`, `crawl`, `laneProbe` and `dispatchWalk` are REQUIRED here
 * because their parsers return a total value for an absent block (the `parseLatencyDemotion`
 * precedent); the other three stay absent when absent.
 */
type OptionalRoutingBlocks = Pick<Routing, "sticky" | "quota" | "mcp"> &
  Required<Pick<Routing, "latency" | "hedge" | "probation" | "pacing" | "crawl" | "laneProbe" | "dispatchWalk">>;

/**
 * Parse the ten optional sub-blocks (sticky, quota, latency, hedge, probation, pacing, crawl,
 * laneProbe, dispatchWalk, mcp) in their current validation order. `parseRouting` copies the
 * result key by key in that same order, so the returned object's own key order is not what
 * decides `Routing`'s.
 */
function parseOptionalBlocks(
  r: {
    sticky?: unknown;
    quota?: unknown;
    latency?: unknown;
    hedge?: unknown;
    probation?: unknown;
    pacing?: unknown;
    crawl?: unknown;
    laneProbe?: unknown;
    dispatchWalk?: unknown;
    mcp?: unknown;
  },
  warnings: string[] = [],
): OptionalRoutingBlocks {
  const sticky = parseSticky(r.sticky);
  const quota = parseQuotaEnforcement(r.quota);
  const latency = parseLatencyDemotion(r.latency);
  const hedge = parseHedge(r.hedge);
  const probation = parseProbation(r.probation);
  const pacing = parsePacing(r.pacing);
  const crawl = parseCrawl(r.crawl);
  const laneProbe = parseLaneProbe(r.laneProbe);
  const dispatchWalk = parseDispatchWalk(r.dispatchWalk, warnings);
  const mcp = parseMcpSettings(r.mcp, warnings);
  return {
    ...(sticky ? { sticky } : {}),
    ...(quota ? { quota } : {}),
    latency,
    hedge,
    probation,
    pacing,
    crawl,
    laneProbe,
    dispatchWalk,
    ...(mcp ? { mcp } : {}),
  };
}

/**
 * Parse `routing.subagents` — single spec string per subagent key.
 * Empty strings are dropped (key not added).
 */
function parseSubagents(
  raw: unknown,
): Record<string, string> {
  const subagents: Record<string, string> = {};
  if (typeof raw === "object" && raw !== null) {
    for (const [k, v] of Object.entries(raw as Record<string, unknown>)) {
      if (typeof v === "string" && v.length > 0) subagents[k] = v;
    }
  }
  return subagents;
}

/** Parse the legacy global switch or the independently keyed client-rule form. */
export function parseOffload(raw: unknown): OffloadConfig {
  // Absent => false. Offload is opt-in: a missing key must never mean "send every request to
  // another provider, which is what an implicit-on default would do to an existing config.
  let out: OffloadConfig = false;

  if (typeof raw === "boolean") {
    out = raw;
  } else if (raw !== undefined) {
    if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
      throw new Error(`config.routing.offload must be a boolean or an object keyed by client`);
    }

    const parsed: Record<string, OffloadRule> = {};
    for (const [client, value] of Object.entries(raw as Record<string, unknown>)) {
      if (client.length === 0) throw new Error(`config.routing.offload client name must not be empty`);
      if (typeof value === "boolean") {
        parsed[client] = { enabled: value, scope: "subagents" };
        continue;
      }
      if (typeof value !== "object" || value === null || Array.isArray(value)) {
        throw new Error(`config.routing.offload.${client} must be a boolean or {"enabled":bool,"scope":...}`);
      }
      const rule = value as { enabled?: unknown; scope?: unknown; freeOnly?: unknown };
      if (typeof rule.enabled !== "boolean") {
        throw new Error(`config.routing.offload.${client}.enabled must be true or false`);
      }
      const scope = rule.scope === undefined ? "subagents" : rule.scope;
      if (scope !== "subagents" && scope !== "all") {
        throw new Error(`config.routing.offload.${client}.scope must be "subagents" or "all"`);
      }
      if (rule.freeOnly !== undefined && typeof rule.freeOnly !== "boolean") {
        throw new Error(`config.routing.offload.${client}.freeOnly must be true or false`);
      }
      // ⚠ Stored EXACTLY as configured — absent stays absent. The default is applied where the
      // rule is consulted (`freeOnlyApplies` in server.ts), not baked in here, because "unset"
      // and "explicitly false" have to stay distinguishable: an unset flag defaults ON for
      // offload-rerouted traffic and OFF for a directly addressed pool, and materializing a value
      // here would collapse that into one answer. It also keeps `setOffload` from inventing a
      // field the operator never wrote.
      parsed[client] = { enabled: rule.enabled, scope, ...(rule.freeOnly !== undefined ? { freeOnly: rule.freeOnly } : {}) };
    }
    out = parsed;
  }

  return out;
}

/** ASCII control characters are never valid in environment variable names. */
function hasAsciiControl(value: string): boolean {
  for (let i = 0; i < value.length; i++) {
    const code = value.charCodeAt(i);
    if (code <= 0x1f || (code >= 0x7f && code <= 0x9f)) return true;
  }
  return false;
}

/**
 * Drop the members of a spec (or spec list) whose provider was disabled by an unset `${ENV}`,
 * warning for each. Returns the survivors, or `null` when nothing survives.
 *
 * ⚠ The warning states the CONSEQUENCE, not just the fact. When a `routing.subagents` entry
 * disappears, that traffic falls through to `routing.default` — the Anthropic passthrough — so
 * the dispatcher believes it offloaded while spending primary quota, and nothing in the
 * response says otherwise. That is the same hazard an unresolvable `@relay:` directive is a
 * hard error for; the difference is that this one is visible once, at startup, where the
 * operator can act on it, and the alternative (aborting) takes down every client session for
 * a provider that may not even be in use.
 */
function dropDisabledSpecs(
  spec: string | string[],
  disabled: Set<string>,
  warnings: string[],
  where: string,
): string | string[] | null {
  if (disabled.size === 0) return spec;
  const specs = Array.isArray(spec) ? spec : [spec];
  const kept = specs.filter((s) => {
    const { provider } = splitSpec(s);
    if (provider === POOL_PREFIX || !disabled.has(provider)) return true;
    warnings.push(
      `config.${where}: dropped "${s}" — provider "${provider}" is disabled. ` +
        `That routing now falls through to routing.default, which for a passthrough default ` +
        `means primary quota.`,
    );
    return false;
  });
  if (kept.length === 0) return null;
  return Array.isArray(spec) ? kept : kept[0]!;
}

/** Placeholder a cli rung's args must contain. Duplicated from dispatch.ts as a literal rather
 *  than imported, to keep config.ts free of dependencies on modules that import it. */
const LADDER_TASK_TOKEN = "{task}";

/** Placeholder a cliLane template's args must contain, replaced by the rung's routing spec. */
const LADDER_SPEC_TOKEN = "{spec}";

/** Optional cliLane placeholder for the spec's published context window. Legal in args AND env. */
const LADDER_CONTEXT_TOKEN = "{contextWindow}";

/**
 * Environment a HOST applies when spawning a rendered command — shared by `cli` rungs and the
 * `cliLane` template, because a divergence between the two would be a silent one: both are
 * handed to the same spawn site, and the stricter of two copies is whichever was edited last.
 */
function parseSpawnEnv(raw: unknown, where: string): Record<string, string | null> | undefined {
  if (raw === undefined) return undefined;
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    throw new Error(`${where}.env must be an object mapping variable names to a string (set) or null (unset)`);
  }
  const env: Record<string, string | null> = {};
  for (const [name, value] of Object.entries(raw as Record<string, unknown>)) {
    // "=", whitespace and control characters cannot appear in an environment variable NAME on any
    // platform this runs on; accepting one would render a command that silently sets a different
    // variable than the config names.
    if (name.length === 0 || name.includes("=") || /\s/.test(name) || hasAsciiControl(name)) {
      throw new Error(`${where}.env has an invalid variable name ${JSON.stringify(name)}`);
    }
    if (typeof value !== "string" && value !== null) {
      throw new Error(`${where}.env.${name} must be a string (set) or null (unset)`);
    }
    env[name] = value;
  }
  return Object.keys(env).length > 0 ? env : undefined;
}

/**
 * Validate `routing.cliLane` at load. A template missing `{spec}` cannot address a target: every
 * rung it rendered would invoke the same default model, so the ladder would appear to fail over
 * while sending every lane to one place. That is worse than having no template at all, which is
 * why it is a hard error rather than a warning.
 */
function parseCliLane(raw: unknown, root: string): CliLaneTemplate | undefined {
  if (raw === undefined || raw === null) return undefined;
  if (typeof raw !== "object" || Array.isArray(raw)) throw new Error(`${root} must be an object`);
  const e = raw as Record<string, unknown>;

  if (typeof e.command !== "string" || e.command.length === 0) {
    throw new Error(`${root}.command must be a non-empty string`);
  }
  if (!Array.isArray(e.args) || e.args.some((a) => typeof a !== "string")) {
    throw new Error(`${root}.args must be an array of strings`);
  }
  const args = e.args as string[];
  if (!args.some((a) => a.includes(LADDER_SPEC_TOKEN))) {
    throw new Error(
      `${root}.args must contain "${LADDER_SPEC_TOKEN}" in one argument — otherwise every transposed rung ` +
        `invokes ${e.command} with the same model and the ladder only appears to fail over`,
    );
  }
  if (!args.some((a) => a.includes(LADDER_TASK_TOKEN))) {
    throw new Error(`${root}.args must contain "${LADDER_TASK_TOKEN}" in one argument — otherwise the task is never passed to ${e.command}`);
  }

  const lane: CliLaneTemplate = { command: e.command, args };
  const env = parseSpawnEnv(e.env, root);
  if (env) {
    // `{task}` in an env value would put text a model or user wrote into a spawned process's
    // environment. It is never substituted, so leaving it legal would silently pass the literal
    // string `{task}` to the child — the operator would believe it worked. Reject it by name.
    // `{contextWindow}` IS substituted here, deliberately: it is a number this relay resolved from
    // published provider metadata, i.e. configuration rather than request content.
    for (const [name, value] of Object.entries(env)) {
      if (typeof value === "string" && value.includes(LADDER_TASK_TOKEN)) {
        throw new Error(
          `${root}.env.${name} must not contain "${LADDER_TASK_TOKEN}" — task text is never placed in a spawned ` +
            `process's environment (use args for the task; "${LADDER_CONTEXT_TOKEN}" is available here)`,
        );
      }
    }
    lane.env = env;
  }
  return lane;
}

/**
 * Validate and apply a `cli` rung's `maxConcurrent` — the most jobs one MCP server process will
 * run against this rung at once (`mcp/lane-runner.ts` `LaneJobStore.inFlight`; backlog item "a
 * per-lane CONCURRENCY cap on cli dispatch rungs"). Absent leaves `rung.maxConcurrent` unset,
 * meaning unbounded — the byte-for-byte pre-existing behaviour. A positive integer is the only
 * other legal shape: the `compat`/`configured-limits` precedent — an ignored typo (`0`, a negative
 * number, a fraction, a quoted `"2"`) would read as a cap while bounding nothing, so it is a hard
 * load error naming both the key and the rung id rather than a silent no-op.
 *
 * Extracted from `parseLadder` — and MUTATING rather than returning, so the call site is one bare
 * statement with no conditional of its own — because that function already carries the sonarjs
 * cognitive-complexity warning CLAUDE.md records as accepted and out of scope for this repository's
 * one approved refactor (parseOffload/parseLadder were explicitly left untouched); a returned value
 * would need an `if` at the call site to decide whether to assign it, raising the very score this
 * shape exists to leave alone.
 */
function applyCliMaxConcurrent(rung: LadderRung, raw: unknown, where: string, id: string): void {
  if (raw === undefined) return;
  if (typeof raw !== "number" || !Number.isInteger(raw) || raw <= 0) {
    throw new Error(`${where}.maxConcurrent must be a positive integer (rung "${id}")`);
  }
  rung.maxConcurrent = raw;
}

/**
 * Accept the legacy rung `capability` key only for compatibility, but give it no routing effect.
 *
 * Capability is derived from the synced model snapshot in dispatch.ts. Silently accepting the old
 * key would make an operator believe it still controls routing, so a valid legacy value warns; a
 * typo remains a hard load error just as before.
 */
function ignoreRungCapability(raw: unknown, where: string, id: string, warnings: string[]): void {
  if (raw === undefined) return;
  if (typeof raw !== "string" || !EFFORT_LEVEL_SET.has(raw)) {
    throw new Error(`${where}.capability must be one of ${EFFORT_LEVELS.join(", ")} (rung "${id}")`);
  }
  warnings.push(
    `${where}.capability "${raw}" has no effect — lane capability is derived from synced capability data`,
  );
}

/**
 * Validate `routing.ladder` at load, not at request time — a ladder whose rung cannot be invoked
 * is a configuration mistake, and discovering it only when the host is mid-fallback is exactly
 * when it is least useful. Absent/empty is legal and simply means "no opinion".
 */
function parseLadder(raw: unknown, root: string, warnings: string[] = []): LadderRung[] {
  if (raw === undefined || raw === null) return [];
  if (!Array.isArray(raw)) throw new Error(`${root} must be an array of rungs`);

  const out: LadderRung[] = [];
  const seen = new Set<string>();
  for (const [i, entry] of raw.entries()) {
    const where = `${root}[${i}]`;
    if (typeof entry !== "object" || entry === null) throw new Error(`${where} must be an object`);
    const e = entry as Record<string, unknown>;

    const id = e.id;
    if (typeof id !== "string" || id.length === 0) throw new Error(`${where}.id must be a non-empty string`);
    // Ids address rungs in /dispatch overrides and exhaustion reports; a duplicate would make
    // "use lane X" ambiguous, and silently picking the first is not a decision to make for the user.
    if (seen.has(id)) throw new Error(`${where}.id "${id}" is already used by an earlier rung`);
    seen.add(id);

    const kind = e.kind;
    if (kind !== "cli" && kind !== "relay") throw new Error(`${where}.kind must be "cli" or "relay" (got ${JSON.stringify(kind)})`);

    const rung: LadderRung = { id, kind, enabled: e.enabled !== false };
    if (typeof e.quota === "string" && e.quota.length > 0) rung.quota = e.quota;
    if (typeof e.note === "string" && e.note.length > 0) rung.note = e.note;
    ignoreRungCapability(e.capability, where, id, warnings);

    if (kind === "cli") {
      if (typeof e.command !== "string" || e.command.length === 0) {
        throw new Error(`${where}.command must be a non-empty string for a "cli" rung`);
      }
      if (!Array.isArray(e.args) || e.args.some((a) => typeof a !== "string")) {
        throw new Error(`${where}.args must be an array of strings for a "cli" rung`);
      }
      const args = e.args as string[];
      // Without the placeholder the task text has nowhere to go and the rung would invoke the
      // agent with an empty prompt — a failure that looks like the model ignoring the request.
      if (!args.some((a) => a.includes(LADDER_TASK_TOKEN))) {
        throw new Error(`${where}.args must contain "${LADDER_TASK_TOKEN}" in one argument — otherwise the task is never passed to ${e.command}`);
      }
      rung.command = e.command;
      rung.args = args;
      const env = parseSpawnEnv(e.env, where);
      if (env) rung.env = env;
      applyCliMaxConcurrent(rung, e.maxConcurrent, where, id);
    } else {
      if (typeof e.spec !== "string" || e.spec.length === 0) {
        throw new Error(`${where}.spec must be a non-empty string for a "relay" rung`);
      }
      rung.spec = e.spec;
    }
    out.push(rung);
  }
  return out;
}

/**
 * Validate `routing.ladders` at load — an object of named ladder arrays, each parsed the same
 * way as `routing.ladder`. Absent is legal and simply means "no opinion"; a named ladder that
 * parses to zero rungs is a hard error, because a key that resolves to nothing was clearly meant
 * to name something.
 */
function parseLadders(raw: unknown, warnings: string[] = []): Record<string, LadderRung[]> {
  if (raw !== undefined && (typeof raw !== "object" || raw === null || Array.isArray(raw))) {
    throw new Error(`config.routing.ladders must be an object of named ladder arrays`);
  }
  const ladders: Record<string, LadderRung[]> = {};
  for (const [tier, rawLadder] of Object.entries((raw ?? {}) as Record<string, unknown>)) {
    const parsed = parseLadder(rawLadder, `config.routing.ladders.${tier}`, warnings);
    if (parsed.length === 0) throw new Error(`config.routing.ladders.${tier} must contain at least one rung`);
    ladders[tier] = parsed;
  }
  return ladders;
}

/**
 * Drop the rungs of a ladder whose `relay` spec names a DISABLED provider, warning for each —
 * the `dropDisabledSpecs` rule applied per rung. Shared by `routing.ladder` and each tier of
 * `routing.ladders`; `prefix` is `routing.ladder` or `routing.ladders.<tier>` so the `where`
 * string built here matches what each call site produced inline.
 */
function dropDisabledRungs(
  rungs: LadderRung[],
  disabledProviders: Set<string>,
  warnings: string[],
  prefix: string,
): LadderRung[] {
  return rungs.filter((rung) => {
    if (rung.kind !== "relay" || !rung.spec) return true;
    return dropDisabledSpecs(rung.spec, disabledProviders, warnings, `${prefix}[${rung.id}].spec`) !== null;
  });
}

/**
 * Drop the disabled-provider entries of a `routing.tiers`- or `routing.subagents`-shaped map,
 * mutating it in place. `prefix` is `routing.tiers` or `routing.subagents`, matching the `where`
 * string each call site built inline.
 */
function pruneDisabledSpecEntries(
  map: Record<string, string | string[]>,
  disabledProviders: Set<string>,
  warnings: string[],
  prefix: string,
): void {
  for (const [tier, spec] of Object.entries(map)) {
    const kept = dropDisabledSpecs(spec, disabledProviders, warnings, `${prefix}.${tier}`);
    if (kept === null) delete map[tier];
    else map[tier] = kept;
  }
}

/**
 * A spec naming a DISABLED provider is dropped with a warning, exactly like a pool member; a spec
 * naming a provider that was never declared is still fatal below. Doing this before the
 * assertions is what keeps "one optional provider lost its ${ENV}" from being a total outage:
 * `assertSpecResolvable` sees the post-disabling provider map, so it cannot tell the two apart
 * and used to abort startup for the degraded case too.
 *
 * Mutates `tiers` and `subagents` in place — they are the SAME objects `routing.tiers` and
 * `routing.subagents` reference — and mutates `routing.default`, `routing.ladder` and
 * `routing.ladders` directly.
 */
function degradeDisabledRouting(
  routing: Routing,
  tiers: Record<string, string | string[]>,
  subagents: Record<string, string>,
  ladder: LadderRung[],
  disabledProviders: Set<string>,
  warnings: string[],
): void {
  pruneDisabledSpecEntries(tiers, disabledProviders, warnings, "routing.tiers");
  pruneDisabledSpecEntries(subagents, disabledProviders, warnings, "routing.subagents");
  if (Array.isArray(routing.default)) {
    // Only an ARRAY default can degrade — the survivors still answer. A single-spec default
    // has nothing left to fall back to, so it stays fatal below.
    const kept = dropDisabledSpecs(routing.default, disabledProviders, warnings, "routing.default");
    if (kept !== null) routing.default = kept;
  }
  routing.ladder = dropDisabledRungs(ladder, disabledProviders, warnings, "routing.ladder");
  if (routing.ladder.length === 0) delete routing.ladder;
  for (const [tier, tierLadder] of Object.entries(routing.ladders ?? {})) {
    const kept = dropDisabledRungs(tierLadder, disabledProviders, warnings, `routing.ladders.${tier}`);
    if (kept.length === 0) delete routing.ladders![tier];
    else routing.ladders![tier] = kept;
  }
  if (routing.ladders && Object.keys(routing.ladders).length === 0) delete routing.ladders;
}

function assertSpecResolvable(
  spec: string | string[],
  providers: Record<string, ProviderConfig>,
  pools: Record<string, string[]>,
  where: string,
  disabled: Set<string> = new Set(),
): void {
  const specs = Array.isArray(spec) ? spec : [spec];
  for (const s of specs) {
    const { provider, model } = splitSpec(s);
    if (provider === POOL_PREFIX) {
      if (!model || !pools[model]) {
        throw new Error(
          `config.${where} "${s}" names unknown pool "${model ?? ""}" (available: ${Object.keys(pools).join(", ") || "none"})`,
        );
      }
      continue;
    }
    const p = providers[provider];
    // A disabled provider is absent from `providers`, so without this it is reported as a
    // typo — sending the operator to look for a misspelling that isn't there instead of at
    // the unset environment variable that actually caused it.
    if (!p && disabled.has(provider)) {
      throw new Error(
        `config.${where} "${s}" names provider "${provider}", which is DISABLED because its ` +
          `base references an unset \${ENV} (see the warning above). Set the variable, or point ` +
          `${where} somewhere else.`,
      );
    }
    if (!p) throw new Error(`config.${where} "${s}" names unknown provider "${provider}"`);
    if (p.kind === "openai" && !model) throw new Error(`config.${where} "${s}" needs a model id for openai provider "${provider}"`);
  }
}

/** Assert every `relay`-kind rung's spec is resolvable, sharing one `where`-string shape between
 *  `routing.ladder` and each tier of `routing.ladders`. */
function assertRungsResolvable(
  rungs: LadderRung[],
  providers: Record<string, ProviderConfig>,
  pools: Record<string, string[]>,
  prefix: string,
): void {
  for (const rung of rungs) {
    if (rung.kind === "relay" && rung.spec) {
      assertSpecResolvable(rung.spec, providers, pools, `${prefix}[${rung.id}].spec`);
    }
  }
}

/**
 * Fail loudly at load time if any spec names an unknown provider or pool. Only `routing.default`
 * can still trip on a DISABLED provider — everything else degraded above — and it is fatal on
 * purpose: it is the fall-through for everything, so there is nowhere left to fall through to.
 */
function assertRoutingResolvable(
  routing: Routing,
  tiers: Record<string, string | string[]>,
  pools: Record<string, string[]>,
  subagents: Record<string, string>,
  providers: Record<string, ProviderConfig>,
  disabledProviders: Set<string>,
): void {
  assertSpecResolvable(routing.default, providers, pools, "routing.default", disabledProviders);
  for (const [tier, spec] of Object.entries(tiers)) {
    assertSpecResolvable(spec, providers, pools, `routing.tiers.${tier}`);
  }
  for (const [pool, specs] of Object.entries(pools)) {
    assertSpecResolvable(specs, providers, {}, `routing.pools.${pool}`);
  }
  for (const [tier, spec] of Object.entries(subagents)) {
    assertSpecResolvable(spec, providers, pools, `routing.subagents.${tier}`);
  }
  assertRungsResolvable(routing.ladder ?? [], providers, pools, "routing.ladder");
  for (const [tier, tierLadder] of Object.entries(routing.ladders ?? {})) {
    assertRungsResolvable(tierLadder, providers, pools, `routing.ladders.${tier}`);
  }
}
