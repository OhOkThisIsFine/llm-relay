import type { Config, ResolvedTarget } from "./config.js";
import type { ModelCatalog } from "./catalog.js";
import { rankTargetsByBenchmark, specOfTarget } from "./benchmarks.js";

/**
 * Materialize every dynamic pool as:
 *
 *   fixed preferred prefix -> every discovered free target in benchmark order
 *
 * Catalog discovery is deliberately synchronous here: startup warms catalogs in the background,
 * while the on-disk cache makes restarts immediately useful. Re-materializing after a refresh
 * replaces the tail rather than accumulating stale models.
 */
export function materializeDynamicPools(cfg: Config, catalog: ModelCatalog): void {
  if (!cfg.routing.poolPolicies || !cfg.routing.pools) return;

  for (const [pool, policy] of Object.entries(cfg.routing.poolPolicies)) {
    const seen = new Set(policy.preferred);
    const discovered: ResolvedTarget[] = [];

    for (const [provider, p] of Object.entries(cfg.providers)) {
      if (p.kind !== "openai") continue;
      for (const model of catalog.cachedModels(provider)) {
        const spec = `${provider}/${model}`;
        if (seen.has(spec)) continue;

        const limits = catalog.cachedLimits(provider, model);
        const inPrice = limits?.pricePromptPerToken;
        const outPrice = limits?.priceCompletionPerToken;
        const explicitlyZeroPriced = inPrice === 0 && outPrice === 0;
        const explicitlyFreeNamed = /(?:^|[/:_-])free(?:$|[/:_-])/i.test(model);
        const knownPaid = (typeof inPrice === "number" && inPrice > 0) || (typeof outPrice === "number" && outPrice > 0);

        // A known positive price always wins. Mixed catalogs (OpenRouter/OpenCode/Kilo) otherwise
        // contribute only zero-priced or explicitly `free`-named models; genuinely free-tier
        // providers may contribute unknown-priced models because many publish no prices at all.
        if (knownPaid) continue;
        if (!explicitlyZeroPriced && !explicitlyFreeNamed && p.tierType !== "free") continue;

        discovered.push({
          provider,
          model,
          base: p.base,
          kind: p.kind,
          authHeader: p.authHeader,
          timeoutMs: p.timeoutMs,
          ...(p.authEnv ? { authEnv: p.authEnv } : {}),
        });
        seen.add(spec);
      }
    }

    const rankedTail = rankTargetsByBenchmark(discovered).map(specOfTarget);
    cfg.routing.pools[pool] = [...policy.preferred, ...rankedTail];
  }
}
