import type { Config, ProviderConfig } from "./config.js";
import { POOL_PREFIX } from "./config.js";
import type { ModelCatalog } from "./catalog.js";
import type { PingLoop } from "./ping/cadence.js";
import { getStrength, type StrengthBasis } from "./benchmarks.js";
import { findTierModel } from "./tier-data.js";
import { keyIsPresent } from "./authEnv.js";
import { resolveMetadata, type MetadataSource } from "./metadata.js";
import { globalCircuitBreaker, type CircuitBreaker } from "./circuit-breaker.js";
import { loadRuntimeTelemetry } from "./ping/runtime-telemetry.js";
import { loadTierData } from "./registry.js";

/**
 * Everything known about one offload destination, kept as SEPARATE raw dimensions.
 *
 * Deliberately un-blended: each leaderboard, live stability, cost, quota and observed traffic
 * measure different things and trade off against each other differently per task ("cheapest that
 * can do it" vs "best available"). Averaging them into one number would bury exactly the judgement
 * the reader is here to make. The one scalar that does exist lives under `sortInputs` with the
 * basis and signals that produced it — because ordering a pool requires an order, not because it
 * is a recommendation.
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
  /** Which snapshot row `scores` came from, and how confidently. `fuzzy` = a similarly-named but
   *  DIFFERENT model's row, so those numbers are indicative. Null = no row matched. */
  capabilityMatch: { name: string; match: "exact" | "fuzzy" } | null;
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
  /**
   * Limits, each with its own provenance. `provider` = this provider published it about its own
   * deployment; `reference` = borrowed from another provider serving the same model id (different
   * deployment, so indicative only — `metadataReferenceFrom` names it). Null = nobody publishes it.
   */
  contextLength: number | null;
  contextLengthSource: MetadataSource | null;
  maxOutputTokens: number | null;
  maxOutputTokensSource: MetadataSource | null;
  metadataReferenceFrom?: string;
  /** Per-million-token price, with the same provenance rules — a model free on one host and
   *  metered on another must not report the other's rate. */
  pricePerMTokIn: number | null;
  pricePerMTokOut: number | null;
  priceSource: MetadataSource | null;
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
    /** snapshot | telemetry | neutral. A telemetry score is not a capability score. */
    strengthBasis: StrengthBasis;
    /** How many published signals backed it. 1 is a guess; 5 is a consensus. */
    strengthSignals: string[];
    /**
     * Drives circuit-breaker candidate ordering. **null when nothing has been measured** —
     * it used to report 100 for an untracked target, which made "never probed" and "proven
     * fast" the same number and the same sort position (INV-TS-7).
     */
    breakerStability: number | null;
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
    const obs = model ? telemetry.models[`${provider}/${model}`] : undefined;
    const strength = getStrength(spec);
    const matched = findTierModel(model ?? spec, byNorm);
    const tier = matched?.rec;
    const num = (k: string) => (typeof tier?.[k] === "number" ? (tier[k] as number) : null);

    // Limits THIS provider publishes about its own deployment, if any. NIM publishes none;
    // Groq and Mistral publish real ones. The snapshot's numbers come from OpenRouter, so for a
    // NIM target they are a different deployment's figures and are labelled `reference`, never
    // presented as this provider's own.
    const providerLimits = p && p.kind === "openai" && model && opts.catalog
      ? await opts.catalog.limits(provider, p, model).catch(() => null)
      : null;
    const meta = resolveMetadata(model ?? provider, {
      providerLimits,
      reference: {
        contextLength: num("context_length"),
        pricePromptPerToken: num("price_prompt"),
        priceCompletionPerToken: num("price_completion"),
        from: "openrouter",
      },
    });

    candidates.push({
      spec,
      provider,
      ...(model ? { model } : {}),
      pools: membership.pools,
      subagentTiers: membership.subagentTiers,
      // The shared presence predicate, not an open-coded `?.trim()`. Three sites disagreed
      // about whether a whitespace-only key counts as present; this is the single answer.
      hasKey: p?.authEnv ? keyIsPresent(process.env[p.authEnv]) : true,
      listed,
      capabilityMatch: matched ? { name: matched.rec.norm, match: matched.match } : null,
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
      contextLength: meta.contextLength,
      contextLengthSource: meta.contextLengthSource,
      maxOutputTokens: meta.maxOutputTokens,
      maxOutputTokensSource: meta.maxOutputTokensSource,
      ...(meta.referenceFrom ? { metadataReferenceFrom: meta.referenceFrom } : {}),
      pricePerMTokIn: meta.pricePerMTokIn,
      pricePerMTokOut: meta.pricePerMTokOut,
      priceSource: meta.priceSource,
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
        breakerStability: breaker.getMeasuredStability(spec),
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
