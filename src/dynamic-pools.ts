/**
 * MODULE CHARTER: Dynamic Pool Synthesis & Tier Discovery (dynamic-pools.ts)
 *
 * 1. Domain Boundary & Responsibilities:
 *    - Synthesizes dynamic, benchmark-ranked model pools (`pool/low`, `pool/medium`, `pool/high`, `pool/xhigh`).
 *    - Dynamically discovers candidates by evaluating active provider catalogs against known tier benchmarks.
 *    - Materializes candidate lists combining invariant fixed targets with fitness-ranked discovery tails.
 *
 * 2. Tier Discovery & Ranking Invariants:
 *    - Matches candidate models against curated benchmark data (`tier-data.js`) using strict normalized SKU matching.
 *    - Weighs capability scores alongside runtime stability metrics (`runtime-telemetry.js`, `probe-cache.js`).
 *    - Caches materialized pool signatures per configuration epoch (`DYNAMIC_POOL_RANKING_EPOCH_MS`) to bound CPU overhead.
 *
 * 3. Degradation Tail & Fallback Rules:
 *    - Implements monotonic effort-level degradation: `xhigh` degrades to `high`, `medium`, and `low` successively.
 *    - Higher tiers incorporate lower tier candidates in their fallback tail to survive total tier exhaustion.
 *    - Fixed targets specified in configuration take strict precedence over dynamically discovered tail candidates.
 *
 * 4. Cost-Based Band Ordering & Guardrails:
 *    - Prioritizes 100% free model providers and subscription pools over metered paid endpoints.
 *    - Enforces operator cost blocks (`isCostBlocked()`) to guarantee zero unintended spend on offload lanes.
 */
import { EFFORT_LEVELS, type Config, type EffortLevel, type ResolvedTarget } from "./config-types.js";
import type { ModelCatalog } from "./catalog.js";
import { rankTargetsWithProvenance, specOfTarget, strengthAllowedForEffort, type Strength } from "./benchmarks.js";
import type { DeploymentRankingSignals } from "./benchmarks.js";
import { loadTierData, findTierModel, type TierData } from "./tier-data.js";
import { getRealWorldScore, loadRuntimeTelemetry, type TelemetryData } from "./ping/runtime-telemetry.js";
import { loadPersistedSamples, loadProbeCache, type ProbeCacheData } from "./ping/probe-cache.js";
import { getStabilityScore } from "./ping/metrics.js";
import { assessCost, type CostClass } from "./metadata.js";
import { isCostBlocked } from "./target-facts.js";

export const DYNAMIC_POOL_RANKING_EPOCH_MS = 30_000;

interface RankingDataSnapshot {
  tierData: TierData | null;
  telemetry: TelemetryData;
  probes: ProbeCacheData;
  now: number;
}

interface MaterializationCache {
  signature: string;
}

const materializationCache = new WeakMap<Config, MaterializationCache>();

/** Operational and task-fit signals for one concrete provider deployment. */
export function deploymentRankingSignals(
  target: ResolvedTarget,
  catalog: ModelCatalog,
  snapshot?: RankingDataSnapshot,
): DeploymentRankingSignals {
  if (!target.model) return {};

  const tierData = snapshot?.tierData ?? loadTierData();
  const hit = findTierModel(target.model, tierData?.byNorm ?? [], tierData?.exactByNorm);
  // Fuzzy rows belong to a different SKU. They may be displayed as references, but must not
  // decide tool compatibility or silently lend their context window to pool ordering.
  const tier = hit?.match === "exact" ? hit.rec : undefined;
  const providerLimits = catalog.cachedLimits(target.provider, target.model);
  const referenceContext = typeof tier?.context_length === "number" ? tier.context_length : null;
  const samples = snapshot
    ? snapshot.probes.providers[target.provider]?.models[target.model]?.samples ?? []
    : loadPersistedSamples(target.provider, target.model);
  const measuredStability = getStabilityScore(samples);

  return {
    stabilityScore: measuredStability >= 0 ? measuredStability : null,
    stabilityConfidence: Math.min(1, samples.length / 5),
    runtimeScore: getRealWorldScore(target.provider, target.model, snapshot
      ? { telemetry: snapshot.telemetry, now: snapshot.now }
      : {}),
    supportsTools: typeof tier?.supports_tools === "boolean" ? tier.supports_tools : null,
    contextLength: providerLimits?.contextLength ?? referenceContext,
    contextConfidence: providerLimits?.contextLength ? 1 : referenceContext ? 0.5 : 0,
    maxOutputTokens: providerLimits?.maxOutputTokens ?? null,
    maxOutputConfidence: providerLimits?.maxOutputTokens ? 1 : 0,
    benchmarkTaskFitScore: typeof tier?.task_fit_score === "number" ? tier.task_fit_score * 100 : null,
    benchmarkTaskFitConfidence: Math.min(1, (tier?.task_fit_signal_count ?? 0) / 3),
  };
}

/** Effort bands weakest-first — the one ordering, so "lower band" means the same thing everywhere. */
/** Weakest first — the ONE ordering, imported so a new band cannot miss the degrade tail. */
const EFFORT_ORDER: readonly EffortLevel[] = EFFORT_LEVELS;

/** Bands strictly below `effort`, strongest first: `xhigh` → high, medium, low. Empty for `low`. */
function lowerBands(effort: EffortLevel): EffortLevel[] {
  const at = EFFORT_ORDER.indexOf(effort);
  return at <= 0 ? [] : EFFORT_ORDER.slice(0, at).reverse();
}

/**
 * Round-robin a ranked list across PROVIDERS, keeping each provider's own rank order intact.
 *
 * Failover's job is to reach working capacity, and members sharing a credential share their
 * failure: a 402 stating an account balance, one subscription, one account rate limit. Ranking by
 * fitness alone clusters them — `pool/xhigh`'s first four candidates were huggingface, gemini,
 * huggingface, huggingface, so three of four attempts sat behind ONE credit balance and four
 * attempts covered only two quota domains. Interleaved, the first N attempts cover N domains.
 * Measured cost of not doing this: a `pool/low` walk spent 7 of 10 attempts before reaching a live
 * domain.
 *
 * ⚠ This is NOT the "two ranking passes" mistake `orderByUsability` warns about. That warning is
 * about re-sorting at REQUEST time on live health, where a second pass competes with deployment
 * fitness and promotes on a single request's latency. This runs once at materialization, is
 * deterministic, and never reorders within a provider — the best candidate overall is still tried
 * first, so a healthy pool behaves identically. It only decides who is tried SECOND.
 */
function interleaveByProvider<T extends { target: ResolvedTarget }>(entries: T[]): T[] {
  const queues = new Map<string, T[]>();
  for (const entry of entries) {
    const q = queues.get(entry.target.provider);
    if (q) q.push(entry);
    else queues.set(entry.target.provider, [entry]);
  }
  // Provider order follows each provider's BEST member, so the overall top-ranked candidate stays
  // first and the strongest providers keep their precedence within each round.
  const order = [...queues.keys()];
  const out: T[] = [];
  let drained = false;
  while (!drained) {
    drained = true;
    for (const provider of order) {
      const next = queues.get(provider)!.shift();
      if (next === undefined) continue;
      out.push(next);
      drained = false;
    }
  }
  return out;
}

/**
 * Materialize every dynamic pool as:
 *
 *   fixed configured prefix -> every eligible free target in deployment-fitness order
 *
 * Catalog discovery is deliberately synchronous here: startup warms catalogs in the background,
 * while the on-disk cache makes restarts immediately useful. Re-materializing after a refresh
 * replaces the tail rather than accumulating stale models.
 */
function discoverDynamicTargets(
  cfg: Config,
  catalog: ModelCatalog,
): {
  discovered: ResolvedTarget[];
  costBySpec: Map<string, CostClass>;
} {
  const discovered: ResolvedTarget[] = [];
  const discoveredSpecs = new Set<string>();
  const costBySpec = new Map<string, CostClass>();

  for (const [provider, p] of Object.entries(cfg.providers)) {
    if (p.kind !== "openai") continue;
    for (const model of catalog.cachedModels(provider)) {
      const spec = `${provider}/${model}`;
      if (discoveredSpecs.has(spec)) continue;

      const cost = assessCost(model, catalog.cachedLimits(provider, model), p.tierType);
      if (isCostBlocked(provider, null, model, { costClass: cost.costClass })) continue;

      discovered.push({
        provider,
        model,
        base: p.base,
        kind: p.kind,
        authHeader: p.authHeader,
        timeoutMs: p.timeoutMs,
        ...(p.authEnv ? { authEnv: p.authEnv } : {}),
      });
      costBySpec.set(spec, cost.costClass);
      discoveredSpecs.add(spec);
    }
  }

  return { discovered, costBySpec };
}

function computeDegradeTail<T extends { target: ResolvedTarget; strength: Strength }>(
  usable: T[],
  effort: EffortLevel | undefined,
  inBandSpecs: Set<string>,
): T[] {
  const tail: T[] = [];
  if (!effort) return tail;

  const seen = new Set(inBandSpecs);
  for (const band of lowerBands(effort)) {
    for (const entry of usable) {
      const spec = specOfTarget(entry.target);
      if (seen.has(spec) || !strengthAllowedForEffort(entry.strength, band)) continue;
      seen.add(spec);
      tail.push(entry);
    }
  }
  return tail;
}

function orderBandByCost<T extends { target: ResolvedTarget }>(
  entries: T[],
  costBySpec: Map<string, CostClass>,
): T[] {
  const free = entries.filter((e) => costBySpec.get(specOfTarget(e.target)) === "free");
  const rest = entries.filter((e) => costBySpec.get(specOfTarget(e.target)) !== "free");
  return [...interleaveByProvider(free), ...interleaveByProvider(rest)];
}

/**
 * Materialize every dynamic pool as:
 *
 *   fixed configured prefix -> every eligible free target in deployment-fitness order
 *
 * Catalog discovery is deliberately synchronous here: startup warms catalogs in the background,
 * while the on-disk cache makes restarts immediately useful. Re-materializing after a refresh
 * replaces the tail rather than accumulating stale models.
 */
export function materializeDynamicPools(
  cfg: Config,
  catalog: ModelCatalog,
  opts: { now?: number; force?: boolean; tierData?: TierData | null } = {},
): boolean {
  if (!cfg.routing.poolPolicies || !cfg.routing.pools) return false;

  const now = opts.now ?? Date.now();
  const tierData = opts.tierData !== undefined ? opts.tierData : loadTierData({ now });
  const catalogRevision = typeof catalog.getRevision === "function" ? catalog.getRevision() : 0;
  const signature = JSON.stringify({
    catalogRevision,
    tierRevision: tierData?.revision ?? tierData?.synced_at ?? null,
    epoch: Math.floor(now / DYNAMIC_POOL_RANKING_EPOCH_MS),
    policies: cfg.routing.poolPolicies,
  });
  if (!opts.force && materializationCache.get(cfg)?.signature === signature) return false;

  const snapshot: RankingDataSnapshot = {
    tierData,
    telemetry: loadRuntimeTelemetry(),
    probes: loadProbeCache(),
    now,
  };

  const { discovered, costBySpec } = discoverDynamicTargets(cfg, catalog);

  const ranked = rankTargetsWithProvenance(discovered, {
    tierData,
    signalsForTarget: (target) => deploymentRankingSignals(target, catalog, snapshot),
  });

  const degraded: Record<string, string[]> = {};
  for (const [pool, policy] of Object.entries(cfg.routing.poolPolicies)) {
    const excluded = new Set(policy.exclude ?? []);
    const preferredPrefix = policy.preferred.filter((spec) => !excluded.has(spec));
    const preferred = new Set(preferredPrefix);
    const usable = ranked.filter(
      (entry) =>
        !excluded.has(specOfTarget(entry.target)) && entry.fitness.signals.supportsTools !== false,
    );
    const inBand = policy.effort
      ? usable.filter((entry) => strengthAllowedForEffort(entry.strength, policy.effort!))
      : usable;

    const inBandSpecs = new Set(inBand.map((entry) => specOfTarget(entry.target)));
    const tail = computeDegradeTail(usable, policy.effort, inBandSpecs);

    const bandOrder = orderBandByCost(inBand, costBySpec)
      .map((e) => specOfTarget(e.target))
      .filter((s) => !preferred.has(s));
    const tailOrder = orderBandByCost(tail, costBySpec)
      .map((e) => specOfTarget(e.target))
      .filter((s) => !preferred.has(s) && !inBandSpecs.has(s));

    cfg.routing.pools[pool] = [...preferredPrefix, ...bandOrder, ...tailOrder];
    if (tailOrder.length > 0) degraded[pool] = tailOrder;
  }
  cfg.routing.poolDegraded = degraded;
  materializationCache.set(cfg, { signature });
  return true;
}
