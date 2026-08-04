import type { Config, ResolvedTarget } from "./config.js";
import type { ModelCatalog } from "./catalog.js";
import { rankTargetsWithProvenance, specOfTarget, strengthAllowedForEffort } from "./benchmarks.js";
import type { DeploymentRankingSignals } from "./benchmarks.js";
import { loadTierData, findTierModel, type TierData } from "./tier-data.js";
import { getRealWorldScore, loadRuntimeTelemetry, type TelemetryData } from "./ping/runtime-telemetry.js";
import { loadPersistedSamples, loadProbeCache, type ProbeCacheData } from "./ping/probe-cache.js";
import { getStabilityScore } from "./ping/metrics.js";
import { assessCost } from "./metadata.js";

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
  opts: { now?: number; force?: boolean } = {},
): boolean {
  if (!cfg.routing.poolPolicies || !cfg.routing.pools) return false;

  const now = opts.now ?? Date.now();
  const tierData = loadTierData({ now });
  const catalogRevision = typeof catalog.getRevision === "function" ? catalog.getRevision() : 0;
  const signature = JSON.stringify({
    catalogRevision,
    tierRevision: tierData?.revision ?? tierData?.synced_at ?? null,
    epoch: Math.floor(now / DYNAMIC_POOL_RANKING_EPOCH_MS),
    policies: cfg.routing.poolPolicies,
  });
  if (!opts.force && materializationCache.get(cfg)?.signature === signature) return false;

  // One immutable view per epoch: every deployment reads the same tier, telemetry, and probe
  // evidence, and every effort pool is a filter over the same ranked roster.
  const snapshot: RankingDataSnapshot = {
    tierData,
    telemetry: loadRuntimeTelemetry(),
    probes: loadProbeCache(),
    now,
  };
  const discovered: ResolvedTarget[] = [];
  const discoveredSpecs = new Set<string>();

  for (const [provider, p] of Object.entries(cfg.providers)) {
    if (p.kind !== "openai") continue;
    for (const model of catalog.cachedModels(provider)) {
      const spec = `${provider}/${model}`;
      if (discoveredSpecs.has(spec)) continue;

      // Admission is `assessCost` — the same definition the freeOnly offload guard enforces.
      // Mixed catalogs (OpenRouter/OpenCode/Kilo) contribute only zero-priced or explicitly
      // `free`-named models; genuinely free-tier providers (`tierType: "free"`) may contribute
      // unknown-priced models because many publish no prices at all — assessCost folds that
      // rule in via the provider-tier basis.
      if (assessCost(model, catalog.cachedLimits(provider, model), p.tierType).costClass !== "free") continue;

      discovered.push({
        provider,
        model,
        base: p.base,
        kind: p.kind,
        authHeader: p.authHeader,
        timeoutMs: p.timeoutMs,
        ...(p.authEnv ? { authEnv: p.authEnv } : {}),
      });
      discoveredSpecs.add(spec);
    }
  }

  const ranked = rankTargetsWithProvenance(discovered, {
    tierData,
    signalsForTarget: (target) => deploymentRankingSignals(target, catalog, snapshot),
  });

  for (const [pool, policy] of Object.entries(cfg.routing.poolPolicies)) {
    const preferred = new Set(policy.preferred);
    const rankedTail = (policy.effort
      ? ranked.filter((entry) =>
          strengthAllowedForEffort(entry.strength, policy.effort!) &&
          entry.fitness.signals.supportsTools !== false
        )
      : ranked
    ).map((entry) => specOfTarget(entry.target)).filter((spec) => !preferred.has(spec));
    cfg.routing.pools[pool] = [...policy.preferred, ...rankedTail];
  }
  materializationCache.set(cfg, { signature });
  return true;
}
