import { loadTierData, findTierModel } from "./tier-data.js";

export { loadTierData };
import type { Config, ProviderConfig } from "./config.js";
import type { ModelCatalog } from "./catalog.js";
import { keyIsPresent } from "./authEnv.js";

import type { PingLoop, ModelHealthSummary } from "./ping/cadence.js";

// Raw leaderboard scores per model — kept verbatim (never collapsed to tiers) so a
// consumer (an external dispatcher) can weigh them against its own quota/rate/token
// state to pick a provider+model.
export interface CapabilityScore {
  bfcl_overall: number | null;
  bfcl_multi_turn: number | null;
  bfcl_irrelevance: number | null;
  arena_rating: number | null;
  arena_rank: number | null;
  composite_rank: number | null;
  /** Leaderboard row these scores came from, and how confidently. A `fuzzy` match is a DIFFERENT
   *  model whose name contains this one's (glm-5.2 → glm-5.2-max), so the scores are indicative,
   *  not this model's. Without this the substitution is invisible. */
  matched_name: string | null;
  match: "exact" | "fuzzy" | null;
}

interface RegistryModel {
  id: string;
  /** Best-effort leaderboard match (null when no confident match — matching is fuzzy). */
  capability: CapabilityScore | null;
  health?: ModelHealthSummary;
}

interface RegistryProvider {
  base: string;
  kind: "openai" | "anthropic";
  authEnv?: string;
  /** Whether the provider's auth env var is set (a provider can be configured but keyless). */
  has_key: boolean;
  /** openai providers only: did the live /models catalog return anything (reachable + authorized)? */
  reachable: boolean | null;
  quota_percent?: number | null;
  models: RegistryModel[];
}

export interface RegistryView {
  generated_at: string;
  /** How to address a backend: namespace a request model "provider/model" (a dispatcher names the
   *  exact model), or let routing map by Claude tier / default (dumb-client convenience). */
  routing: { default: string | string[]; tiers: Record<string, string | string[]> };
  providers: Record<string, RegistryProvider>;
  capability_source: {
    present: boolean;
    synced_at?: string;
    note: string;
    /** Full raw leaderboard dataset, so a consumer can run a finer join than the best-effort one above. */
    models?: Array<Record<string, unknown>>;
  };
}

export { type TierData } from "./tier-data.js";

function toScore(r: Record<string, unknown>, match: "exact" | "fuzzy"): CapabilityScore {
  const n = (k: string) => (typeof r[k] === "number" ? (r[k] as number) : null);
  return {
    bfcl_overall: n("bfcl_overall"),
    bfcl_multi_turn: n("bfcl_multi_turn"),
    bfcl_irrelevance: n("bfcl_irrelevance"),
    arena_rating: n("arena_rating"),
    arena_rank: n("arena_rank"),
    composite_rank: n("composite_rank"),
    matched_name: typeof r.norm === "string" ? r.norm : null,
    match,
  };
}

/**
 * Fuzzy, conservative join of a backend model id to a leaderboard record. Leaderboard
 * names ("GLM-4.6 (FC)") and API ids ("z-ai/glm-5.2") don't share a key, so this matches
 * the API id's last path segment against a normalized leaderboard name — preferring a
 * miss (null capability) over a wrong score. Consumers wanting a better join use the full
 * dataset in capability_source.models.
 */
export function joinCapability(
  modelId: string,
  byNorm: Array<{ norm: string; rec: Record<string, unknown> }>,
): CapabilityScore | null {
  const m = findTierModel(modelId, byNorm);
  return m ? toScore(m.rec, m.match) : null;
}

/** Build the discovery view: providers × live models (best-effort capability) + routing + raw scores. */
export async function buildRegistry(
  cfg: Config,
  catalog: ModelCatalog,
  opts: { now?: string; pingLoop?: PingLoop } = {},
): Promise<RegistryView> {
  const tierData = loadTierData();
  const byNorm = tierData?.byNorm ?? [];

  const providers: Record<string, RegistryProvider> = {};
  for (const [name, p] of Object.entries(cfg.providers) as Array<[string, ProviderConfig]>) {
    // The shared presence predicate, not an open-coded `?.trim()` — call sites that each decided
    // for themselves whether a whitespace-only key counts as present is exactly how a blank
    // credential once read "present" here and "absent" to header construction.
    const has_key = p.authEnv ? keyIsPresent(process.env[p.authEnv]) : true;
    let models: RegistryModel[] = [];
    let reachable: boolean | null = p.kind === "openai" ? false : null;
    if (p.kind === "openai") {
      const ids = await catalog.list(name, p);
      reachable = ids.length > 0;
      models = ids.map((id) => {
        const capability = joinCapability(id, byNorm);
        const health = opts.pingLoop ? opts.pingLoop.getModelSummary(name, id) : undefined;
        return { id, capability, ...(health ? { health } : {}) };
      });
    }

    const quota_percent = opts.pingLoop ? opts.pingLoop.getProviderQuota(name) : undefined;

    providers[name] = {
      base: p.base,
      kind: p.kind,
      ...(p.authEnv ? { authEnv: p.authEnv } : {}),
      has_key,
      reachable,
      ...(quota_percent !== undefined ? { quota_percent } : {}),
      models,
    };
  }

  return {
    generated_at: opts.now ?? new Date().toISOString(),
    routing: { default: cfg.routing.default, tiers: cfg.routing.tiers },
    providers,
    capability_source: {
      present: !!tierData,
      ...(tierData?.synced_at ? { synced_at: tierData.synced_at } : {}),
      note: tierData
        ? "Raw BFCL + LMArena scores, never collapsed. Per-model `capability` is a best-effort id→leaderboard match; use `models` for a finer join."
        : "No docs/tier-data.json — run `npm run sync:tiers`. Providers/models still returned.",
      ...(tierData ? { models: tierData.models } : {}),
    },
  };
}

