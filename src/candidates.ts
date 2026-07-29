import type { Config, ProviderConfig } from "./config.js";
import { POOL_PREFIX } from "./config.js";
import type { ModelCatalog } from "./catalog.js";
import type { PingLoop } from "./ping/cadence.js";
import { getBenchmarkScores, getStrength, type BenchmarkScores, type StrengthBasis } from "./benchmarks.js";
import { findTierModel } from "./tier-data.js";
import { getModelMetadata } from "./metadata.js";
import { globalCircuitBreaker, type CircuitBreaker } from "./circuit-breaker.js";
import { loadRuntimeTelemetry } from "./ping/runtime-telemetry.js";
import { loadTierData, joinCapability, type CapabilityScore } from "./registry.js";

/**
 * Everything known about one offload destination, kept as SEPARATE raw dimensions.
 *
 * Deliberately un-blended: benchmark quality, live stability, quota and observed traffic measure
 * different things and trade off against each other differently per task ("cheapest that can do
 * it" vs "best available"). Averaging them into one number would bury exactly the judgement the
 * reader is here to make. The two composites that already exist in the product are reported under
 * `sortInputs`, labelled as what they drive — not as a recommendation.
 */
export interface Candidate {
  spec: string;
  provider: string;
  model?: string;
  /** Pools this spec belongs to, and subagent tiers currently pointing at it. */
  pools: string[];
  subagentTiers: string[];
  /** Provider auth env var is populated. */
  hasKey: boolean;
  /** In the provider's live /models catalog. null = not checkable (anthropic kind, or catalog down). */
  listed: boolean | null;
  benchmarks: BenchmarkScores;
  /** BFCL tool-use + LMArena scores, best-effort id→leaderboard match (null when no confident match). */
  capability: CapabilityScore | null;
  health: {
    verdict: string;
    avgMs: number | null;
    p95Ms: number | null;
    jitterMs: number | null;
    uptimePct: number | null;
    lastPingCode: string | null;
    lastPingMs: number | null;
  } | null;
  quotaPercent: number | null;
  breaker: {
    open: boolean;
    consecutiveFailures: number;
    lastStatus: number | null;
    cooldownRemainingMs: number;
  };
  /** Observed real traffic through this proxy (not synthetic probes). */
  observed: {
    totalCalls: number;
    successCalls: number;
    avgLatencyMs: number | null;
    lastCalledAt: string | null;
  } | null;
  contextLength: number | null;
  /** Where contextLength came from — the synced snapshot is authoritative, the static table lags. */
  contextLengthSource: "snapshot" | "static-table" | null;
  maxOutputTokens: number | null;
  pricePerMTokIn: number | null;
  pricePerMTokOut: number | null;
  supportsTools: boolean | null;
  /** Which leaderboards published anything about this model. */
  capabilitySources: string[];
  /** Raw per-source capability values — kept separate, never collapsed into one another. */
  scores: {
    /** Berkeley Function-Calling: tool-call accuracy, multi-turn, irrelevance detection. */
    bfclOverall: number | null;
    bfclMultiTurn: number | null;
    bfclIrrelevance: number | null;
    /** Artificial Analysis indices, via OpenRouter. */
    aaIntelligence: number | null;
    aaCoding: number | null;
    aaAgentic: number | null;
    /** Aider polyglot edit benchmark + edit-format compliance. */
    aiderPassRate: number | null;
    aiderWellFormed: number | null;
    /** Design Arena Elo, averaged per arena (means, not measurements — see the `_mean` naming). */
    designArenaAgentsEloMean: number | null;
    designArenaModelsEloMean: number | null;
    /** LMArena. */
    arenaRating: number | null;
    arenaRank: number | null;
  };
  /** What the proxy itself sorts by — the ONE place a scalar exists, with its provenance. */
  sortInputs: {
    /** Drives `routing.benchmarkSort` ordering within a pool. */
    strength: number;
    /** snapshot | static-table | telemetry | neutral. A telemetry score is not a benchmark score. */
    strengthBasis: StrengthBasis;
    /** How many published signals backed it. 1 is a guess; 5 is a consensus. */
    strengthSignals: string[];
    /** Drives circuit-breaker candidate ordering. 100 when untracked. */
    breakerStability: number;
  };
}

export interface CandidatesView {
  generated_at: string;
  offload_enabled: boolean;
  note: string;
  candidates: Candidate[];
}

const NOTE =
  "Raw per-dimension data for choosing an offload target. Nothing here is ranked or averaged — " +
  "order is config order (pools, then subagent targets), and every source's score is kept " +
  "separately under `scores`. `sortInputs` reports the ONE scalar the proxy needs for pool " +
  "ordering, with the basis and signal list that produced it; it is not a recommendation.";

/** Expand a spec that may itself be `pool/<name>` into concrete "provider/model" specs. */
function expandSpec(spec: string, cfg: Config): string[] {
  const i = spec.indexOf("/");
  const head = i === -1 ? spec : spec.slice(0, i);
  if (head !== POOL_PREFIX) return [spec];
  const name = i === -1 ? "" : spec.slice(i + 1);
  return cfg.routing.pools?.[name] ?? [];
}

/**
 * The set of specs a subagent could actually be sent to: every pool member plus anything
 * `routing.subagents` points at. That is the real choice set — listing all ~470 live models
 * would bury it.
 */
function collectSpecs(cfg: Config): Map<string, { pools: string[]; subagentTiers: string[] }> {
  const out = new Map<string, { pools: string[]; subagentTiers: string[] }>();
  const touch = (spec: string) => {
    let e = out.get(spec);
    if (!e) {
      e = { pools: [], subagentTiers: [] };
      out.set(spec, e);
    }
    return e;
  };

  for (const [pool, specs] of Object.entries(cfg.routing.pools ?? {})) {
    for (const s of specs) touch(s).pools.push(pool);
  }
  for (const [tier, spec] of Object.entries(cfg.routing.subagents ?? {})) {
    for (const s of expandSpec(spec, cfg)) touch(s).subagentTiers.push(tier);
  }
  return out;
}

function splitSpec(spec: string): { provider: string; model?: string } {
  const i = spec.indexOf("/");
  return i === -1 ? { provider: spec } : { provider: spec.slice(0, i), model: spec.slice(i + 1) };
}

/** Build the un-blended decision table for offload targets. */
export async function buildCandidates(
  cfg: Config,
  opts: {
    catalog?: ModelCatalog;
    pingLoop?: PingLoop;
    breaker?: CircuitBreaker;
    provider?: string;
    now?: string;
    nowMs?: number;
  } = {},
): Promise<CandidatesView> {
  const breaker = opts.breaker ?? globalCircuitBreaker;
  const nowMs = opts.nowMs ?? Date.now();
  const byNorm = loadTierData()?.byNorm ?? [];
  const telemetry = loadRuntimeTelemetry();

  const candidates: Candidate[] = [];
  for (const [spec, membership] of collectSpecs(cfg)) {
    const { provider, model } = splitSpec(spec);
    if (opts.provider && provider !== opts.provider) continue;
    const p: ProviderConfig | undefined = cfg.providers[provider];

    let listed: boolean | null = null;
    if (p && p.kind === "openai" && model && opts.catalog) {
      try {
        listed = await opts.catalog.has(provider, p, model);
      } catch {
        listed = null;
      }
    }

    const summary = opts.pingLoop && model ? opts.pingLoop.getModelSummary(provider, model) : null;
    const state = breaker.getState(spec);
    const obs = telemetry.models[`${provider}/${model}`];
    const meta = getModelMetadata(model ?? provider);
    const benchmarks = getBenchmarkScores(spec);
    const strength = getStrength(spec);
    const tier = findTierModel(model ?? spec, byNorm)?.rec;
    const num = (k: string) => (typeof tier?.[k] === "number" ? (tier[k] as number) : null);
    // The snapshot is fetched from the provider itself, so it beats the hand-typed metadata table
    // — which had glm-5.2 at 128k when it actually serves 1M.
    const snapshotCtx = num("context_length");

    candidates.push({
      spec,
      provider,
      ...(model ? { model } : {}),
      pools: membership.pools,
      subagentTiers: membership.subagentTiers,
      hasKey: p?.authEnv ? !!process.env[p.authEnv]?.trim() : true,
      listed,
      benchmarks,
      capability: model ? joinCapability(model, byNorm) : null,
      health: summary
        ? {
            verdict: summary.verdict,
            avgMs: summary.avgMs >= 0 ? summary.avgMs : null,
            p95Ms: summary.p95Ms >= 0 ? summary.p95Ms : null,
            jitterMs: summary.jitterMs,
            uptimePct: summary.uptimePct,
            lastPingCode: summary.lastPingCode,
            lastPingMs: summary.lastPingMs,
          }
        : null,
      quotaPercent: opts.pingLoop ? opts.pingLoop.getProviderQuota(provider) : null,
      breaker: {
        open: !breaker.isHealthy(spec, nowMs),
        consecutiveFailures: state?.consecutiveFailures ?? 0,
        lastStatus: state?.lastStatus ?? null,
        cooldownRemainingMs: Math.max(0, (state?.cooldownUntil ?? 0) - nowMs),
      },
      observed: obs
        ? {
            totalCalls: obs.totalCalls,
            successCalls: obs.successCalls,
            avgLatencyMs: obs.totalCalls > 0 ? Math.round(obs.totalLatencyMs / obs.totalCalls) : null,
            lastCalledAt: obs.lastCalledAt ? new Date(obs.lastCalledAt).toISOString() : null,
          }
        : null,
      contextLength: snapshotCtx ?? meta.contextLength ?? null,
      contextLengthSource: snapshotCtx ? "snapshot" : meta.contextLength ? "static-table" : null,
      maxOutputTokens: meta.maxOutputTokens ?? null,
      // OpenRouter quotes per-token; per-million is the unit humans compare in.
      pricePerMTokIn: num("price_prompt") !== null ? Math.round(num("price_prompt")! * 1e6 * 1000) / 1000 : null,
      pricePerMTokOut: num("price_completion") !== null ? Math.round(num("price_completion")! * 1e6 * 1000) / 1000 : null,
      supportsTools: typeof tier?.supports_tools === "boolean" ? tier.supports_tools : null,
      capabilitySources: Array.isArray(tier?.sources) ? (tier.sources as string[]) : [],
      scores: {
        bfclOverall: num("bfcl_overall"),
        bfclMultiTurn: num("bfcl_multi_turn"),
        bfclIrrelevance: num("bfcl_irrelevance"),
        aaIntelligence: num("aa_intelligence"),
        aaCoding: num("aa_coding"),
        aaAgentic: num("aa_agentic"),
        aiderPassRate: num("aider_pass_rate"),
        aiderWellFormed: num("aider_well_formed"),
        designArenaAgentsEloMean: num("design_arena_agents_elo_mean"),
        designArenaModelsEloMean: num("design_arena_models_elo_mean"),
        arenaRating: num("arena_rating"),
        arenaRank: num("arena_rank"),
      },
      sortInputs: {
        strength: strength.score,
        strengthBasis: strength.basis,
        strengthSignals: strength.signals ?? [],
        breakerStability: breaker.getStabilityScore(spec),
      },
    });
  }

  return {
    generated_at: opts.now ?? new Date(nowMs).toISOString(),
    offload_enabled: cfg.routing.offload === true,
    note: NOTE,
    candidates,
  };
}
