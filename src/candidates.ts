import type { Config, ProviderConfig } from "./config.js";
import { POOL_PREFIX } from "./config.js";
import type { ModelCatalog } from "./catalog.js";
import type { PingLoop } from "./ping/cadence.js";
import { getBenchmarkScores, calculateQualityScore, type BenchmarkScores } from "./benchmarks.js";
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
  maxOutputTokens: number | null;
  /** Existing composites, reported for transparency about what the proxy itself sorts by. */
  sortInputs: {
    /** Drives `routing.benchmarkSort` ordering within a pool. */
    benchmarkQuality: number;
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
  "order is config order (pools, then subagent targets). `sortInputs` reports the composites the " +
  "proxy already sorts by; they are not a recommendation.";

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
  const tierData = loadTierData();
  const byNorm = (tierData?.models ?? [])
    .filter((r) => typeof r.norm === "string")
    .map((r) => ({ norm: (r.norm as string).toLowerCase(), rec: r }));
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
      contextLength: meta.contextLength ?? null,
      maxOutputTokens: meta.maxOutputTokens ?? null,
      sortInputs: {
        benchmarkQuality: calculateQualityScore(benchmarks),
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
