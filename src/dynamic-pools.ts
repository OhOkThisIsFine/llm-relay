import type { Config, EffortLevel, ResolvedTarget } from "./config.js";
import type { ModelCatalog } from "./catalog.js";
import { rankTargetsWithProvenance, specOfTarget, strengthAllowedForEffort } from "./benchmarks.js";
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
const EFFORT_ORDER: EffortLevel[] = ["low", "medium", "high", "xhigh"];

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
  /** spec -> what serving one request costs. Decides ORDER within a band, never admission. */
  const costBySpec = new Map<string, CostClass>();

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
      // Cost no longer gates ADMISSION — it decides ORDER (see `costRank` and the band assembly
      // below). A pool that admits only free deployments is free by construction, which sounds
      // safe until the free lane is spent and the pool has nothing left; the owner's call is that
      // paid capacity should be reachable, always behind every free option, and never silently.
      // The `freeOnly` guard (default ON) is what still makes a pool free-only for anyone who has
      // not opted into spending.
      const cost = assessCost(model, catalog.cachedLimits(provider, model), p.tierType);

      // What the deployment itself said, which outranks what the roster implies about it.
      //
      // `assessCost`'s `provider-tier` basis admits any unpriced model from a `tierType: "free"`
      // provider — the right default, since most free providers publish no prices at all, but it
      // is an assumption about a ROSTER and a roster contains subscription-gated SKUs and models
      // that were de-listed behind the scenes. Both were measured here: five `ollama-cloud/*`
      // members answering 403 "requires a subscription", and `nim/moonshotai/kimi-k2.6` answering
      // 404 "not found for account", all of them still holding pool slots and burning one failover
      // round-trip per request.
      //
      // ⚠ Only proven-unfit deployments are dropped. `isCostBlocked` deliberately excludes
      // `allowance-exhausted`: a spent free allowance is the normal state of a working free lane,
      // not a discovery about price, and evicting on it would outlive the exhaustion that caused
      // it. That case cools in `orderByUsability` and returns on its own.
      if (isCostBlocked(provider, model)) continue;

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

  const ranked = rankTargetsWithProvenance(discovered, {
    tierData,
    signalsForTarget: (target) => deploymentRankingSignals(target, catalog, snapshot),
  });

  const degraded: Record<string, string[]> = {};
  for (const [pool, policy] of Object.entries(cfg.routing.poolPolicies)) {
    const preferred = new Set(policy.preferred);
    const usable = ranked.filter((entry) => entry.fitness.signals.supportsTools !== false);
    const inBand = policy.effort
      ? usable.filter((entry) => strengthAllowedForEffort(entry.strength, policy.effort!))
      : usable;

    // Everything live that did NOT clear the band, in rank order — the degrade tail. An effort
    // band selects on CAPABILITY, and capability correlates with the providers that meter hardest,
    // so the top band is both the narrowest and the first to run dry: measured 2026-08-08,
    // `pool/xhigh` had 12 members across 4 quota domains and returned 0 served while `pool/low`
    // answered from 46 at the same moment with the same credentials. A band with nothing behind it
    // turns "the strongest models are busy" into "no answer at all".
    //
    // ⚠ Appended, never merged: the band still decides who is tried FIRST, so a healthy pool is
    // completely unaffected and the tail is reached only after every in-band member has actually
    // failed on this request. And it is never silent — `poolDegraded` is what lets the response
    // say the answer came from below the band.
    const inBandSpecs = new Set(inBand.map((entry) => specOfTarget(entry.target)));

    // ⚠ The tail holds members that clear a LOWER band — never members that clear no band at all.
    // A model with no snapshot evidence is not "weaker", it is UNASSESSED, and admitting it here
    // would quietly reverse the evidence-aware admission rule that keeps unmeasured models out of
    // every pool. Degrading to a measured weaker model is a considered trade; degrading to one
    // nothing is known about is a guess wearing the same clothes. Walked strongest-first, so an
    // exhausted `xhigh` reaches `high` before `medium` before `low`.
    const tail: typeof usable = [];
    if (policy.effort) {
      const seen = new Set(inBandSpecs);
      for (const band of lowerBands(policy.effort)) {
        for (const entry of usable) {
          const spec = specOfTarget(entry.target);
          if (seen.has(spec) || !strengthAllowedForEffort(entry.strength, band)) continue;
          seen.add(spec);
          tail.push(entry);
        }
      }
    }

    // FREE FIRST, within every band. Cost decides order, not admission: paid capacity is reachable
    // so a spent free lane is not a dead end, but it is only ever reached after every free member
    // of the same band has failed. `unknown` cost sits with paid — a guess must not spend money,
    // the same rule `assessCost` applies for the `freeOnly` guard.
    const byCost = (entries: typeof inBand) => {
      const free = entries.filter((e) => costBySpec.get(specOfTarget(e.target)) === "free");
      const rest = entries.filter((e) => costBySpec.get(specOfTarget(e.target)) !== "free");
      return [...interleaveByProvider(free), ...interleaveByProvider(rest)];
    };
    const bandOrder = byCost(inBand).map((e) => specOfTarget(e.target)).filter((s) => !preferred.has(s));
    const tailOrder = byCost(tail).map((e) => specOfTarget(e.target)).filter((s) => !preferred.has(s) && !inBandSpecs.has(s));
    cfg.routing.pools[pool] = [...policy.preferred, ...bandOrder, ...tailOrder];
    if (tailOrder.length > 0) degraded[pool] = tailOrder;
  }
  cfg.routing.poolDegraded = degraded;
  materializationCache.set(cfg, { signature });
  return true;
}
