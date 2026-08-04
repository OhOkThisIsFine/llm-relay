import type { EffortLevel, ResolvedTarget } from "./config.js";
import { loadTierData, findTierModel, type TierData } from "./tier-data.js";
import { getRealWorldScore } from "./ping/runtime-telemetry.js";

/** Where a strength score came from. Ranking is only as trustworthy as its basis. */
export type StrengthBasis = "snapshot" | "neutral";

export interface Strength {
  /** 0-100 confidence-adjusted routing score. Higher is better. */
  score: number;
  /** Unadjusted snapshot capability composite, kept visible for diagnosis. */
  rawScore: number;
  /** 0-1: how strongly rawScore is allowed to move routing away from neutral. */
  confidence: number;
  basis: StrengthBasis;
  /** Snapshot only: direct capability signals. Task-fit publications are counted separately. */
  signals?: string[];
  signalCount?: number;
  /** Capability + behavioural publications. Pool admission requires at least three. */
  publishedSignalCount?: number;
  /** Fixed 0-100 agentic/coding/general estimates; imputed dimensions are named separately. */
  dimensions?: Partial<Record<"agentic" | "coding" | "general", number>>;
  directDimensions?: string[];
  imputedDimensions?: string[];
  /** Capability-only pool bands computed with coarse admission and persisted hysteresis. */
  effortEligibility?: EffortLevel[];
  /** snapshot only: `fuzzy` means the row belongs to a similarly-named, DIFFERENT model. */
  match?: "exact" | "fuzzy";
  /** snapshot only: the row actually used. */
  matchedName?: string;
}

/** Deployment-local evidence used after capability eligibility has been decided. */
export interface DeploymentRankingSignals {
  /** Synthetic-probe stability (0-100). Null/undefined means unmeasured. */
  stabilityScore?: number | null;
  /** 0-1 confidence in stabilityScore, normally based on probe sample count. */
  stabilityConfidence?: number;
  /** Success/speed/recency score from at least five real relay calls. */
  runtimeScore?: number | null;
  /** Whether the exact model SKU advertises tool calling. False is incompatible with agent pools. */
  supportsTools?: boolean | null;
  /** Best known context window for this deployment/SKU. */
  contextLength?: number | null;
  /** 0-1 confidence in contextLength (provider-published=1, cross-host reference<1). */
  contextConfidence?: number;
  /** Best known output ceiling for this deployment/SKU. */
  maxOutputTokens?: number | null;
  /** 0-1 confidence in maxOutputTokens. */
  maxOutputConfidence?: number;
  /** Specialized design/protocol task fit kept outside general capability, 0-100. */
  benchmarkTaskFitScore?: number | null;
  /** 0-1 confidence in benchmarkTaskFitScore, based on task-fit source coverage. */
  benchmarkTaskFitConfidence?: number;
}

/** Transparent breakdown of the one scalar required to order a deployment pool. */
export interface DeploymentFitness {
  /** 0-100 weighted score: 75% capability, 20% operations, 5% task-fit metadata. */
  score: number;
  capability: number;
  operational: number;
  metadata: number;
  signals: DeploymentRankingSignals;
}

const NEUTRAL = 50;
const STATIC_RANKING_EPOCH_MS = 30_000;
const staticRankingCache = new Map<string, string[]>();

/**
 * Evidence confidence used to shrink unlike measurements toward neutral before comparing them.
 *
 * Snapshot composites may contain up to five core independent signal families in ordinary use;
 * additional columns can exist, but five is already full confidence. A fuzzy name match describes
 * a different SKU and therefore gets half weight. Runtime telemetry is handled separately as an
 * operational deployment signal and never enters this capability-confidence calculation.
 */
export function evidenceConfidence(
  basis: StrengthBasis,
  signalCount = 0,
  match: "exact" | "fuzzy" = "exact",
): number {
  if (basis === "neutral") return 0;
  const signalConfidence = Math.min(1, Math.max(0, signalCount) / 5);
  return signalConfidence * (match === "fuzzy" ? 0.5 : 1);
}

/** Pull an uncertain score toward neutral instead of letting a one-source outlier win outright. */
export function confidenceAdjustedScore(rawScore: number, confidence: number): number {
  return Math.round((NEUTRAL + (rawScore - NEUTRAL) * confidence) * 10) / 10;
}

/**
 * Strength of one target, from the best evidence available, in this order:
 *
 *  1. the synced multi-source snapshot — real published capability, refreshed by `sync:tiers`;
 *  2. neutral — nothing is known, so claim nothing.
 *
 * Runtime telemetry deliberately does NOT appear here. It measures whether this deployment
 * answers reliably and quickly, not whether the model can reason. `deploymentFitness()` consumes
 * it on the operational axis after capability-floor eligibility has been decided.
 *
 * There is deliberately no hardcoded-table rung. `BENCHMARK_DB` used to sit here; every pattern it
 * carried is present in the snapshot, so it contributed nothing but a stale, provenance-free number
 * that outranked the synced data for any model it happened to substring-match.
 */
export function getStrength(spec: string, tierData: TierData | null = loadTierData()): Strength {
  const hit = findTierModel(spec, tierData?.byNorm ?? [], tierData?.exactByNorm);
  if (hit && typeof hit.rec.strength === "number") {
    const rawScore = Math.round(hit.rec.strength * 1000) / 10; // 0-1 → 0-100
    const signalCount = hit.rec.signal_count ?? 0;
    const snapshotConfidence = typeof hit.rec.capability_confidence === "number"
      ? Math.max(0, Math.min(1, hit.rec.capability_confidence))
      : evidenceConfidence("snapshot", signalCount, "exact");
    const confidence = snapshotConfidence * (hit.match === "fuzzy" ? 0.5 : 1);
    const dimensions = hit.rec.dimensions && typeof hit.rec.dimensions === "object"
      ? Object.fromEntries(Object.entries(hit.rec.dimensions).map(([name, value]) => [
          name,
          typeof value === "number" ? Math.round(value * 1000) / 10 : value,
        ])) as Strength["dimensions"]
      : undefined;
    const effortEligibility = Array.isArray(hit.rec.effort_eligibility)
      ? hit.rec.effort_eligibility.filter((effort): effort is EffortLevel =>
          effort === "low" || effort === "medium" || effort === "high" || effort === "xhigh"
        )
      : undefined;
    return {
      score: confidenceAdjustedScore(rawScore, confidence),
      rawScore,
      confidence,
      basis: "snapshot",
      signals: hit.rec.signals ?? [],
      signalCount,
      publishedSignalCount: hit.rec.published_signal_count ?? signalCount,
      ...(dimensions ? { dimensions } : {}),
      directDimensions: hit.rec.direct_dimensions ?? [],
      imputedDimensions: hit.rec.imputed_dimensions ?? [],
      ...(effortEligibility ? { effortEligibility } : {}),
      match: hit.match,
      matchedName: hit.rec.norm,
    };
  }

  return { score: NEUTRAL, rawScore: NEUTRAL, confidence: 0, basis: "neutral" };
}

/** Minimum raw multi-source capability required by each cumulative effort pool. */
export const EFFORT_FLOORS: Record<EffortLevel, number> = {
  low: 50,
  medium: 60,
  high: 70,
  xhigh: 80,
};

/**
 * Whether an automatically discovered target belongs in an effort pool.
 *
 * These are raw capability FLOORS, not ceilings. Automatic eligibility additionally requires an
 * exact model-SKU match and at least three independent published signals. Evidence confidence,
 * stability, and deployment metadata affect ordering after eligibility; they do not move a strong
 * model below a floor. Higher effort narrows upward: xhigh ⊆ high ⊆ medium ⊆ low.
 */
export function strengthAllowedForEffort(strength: Strength, effort: EffortLevel): boolean {
  const clearsFloor = strength.effortEligibility
    ? strength.effortEligibility.includes(effort)
    : Math.round(strength.rawScore) >= EFFORT_FLOORS[effort];
  return strength.basis === "snapshot" &&
    strength.match === "exact" &&
    (strength.publishedSignalCount ?? strength.signalCount ?? 0) >= 3 &&
    clearsFloor;
}

function clampScore(value: number): number {
  return Math.max(0, Math.min(100, value));
}

function confidenceAdjustedSignal(value: number | null | undefined, confidence = 1): number | null {
  if (typeof value !== "number" || !Number.isFinite(value)) return null;
  return confidenceAdjustedScore(clampScore(value), clampScore(confidence * 100) / 100);
}

function logScale(value: number | null | undefined, low: number, high: number): number | null {
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) return null;
  const position = (Math.log(value) - Math.log(low)) / (Math.log(high) - Math.log(low));
  return clampScore(position * 100);
}

/**
 * Build deployment fitness without confusing deployment health with model capability.
 *
 * Capability remains dominant and is the only input to effort eligibility. Operations can move
 * close models based on measured stability and real traffic; useful task-fit metadata makes only
 * a small final distinction. Every missing operational/metadata signal is neutral (50), never 0.
 */
export function deploymentFitness(
  strength: Strength,
  signals: DeploymentRankingSignals = {},
): DeploymentFitness {
  const capability = strength.basis === "snapshot" ? strength.score : NEUTRAL;

  const operationalSignals = [
    confidenceAdjustedSignal(signals.stabilityScore, signals.stabilityConfidence ?? 1),
    confidenceAdjustedSignal(signals.runtimeScore),
  ].filter((value): value is number => value !== null);
  const operational = operationalSignals.length > 0
    ? operationalSignals.reduce((sum, value) => sum + value, 0) / operationalSignals.length
    : NEUTRAL;

  const toolFit = signals.supportsTools === true ? 100 : signals.supportsTools === false ? 0 : NEUTRAL;
  const contextRaw = logScale(signals.contextLength, 8_192, 1_048_576);
  const outputRaw = logScale(signals.maxOutputTokens, 2_048, 65_536);
  const contextFit = confidenceAdjustedSignal(contextRaw, signals.contextConfidence ?? 1) ?? NEUTRAL;
  const outputFit = confidenceAdjustedSignal(outputRaw, signals.maxOutputConfidence ?? 1) ?? NEUTRAL;
  const benchmarkTaskFit = confidenceAdjustedSignal(
    signals.benchmarkTaskFitScore,
    signals.benchmarkTaskFitConfidence ?? 1,
  ) ?? NEUTRAL;
  const metadata = 0.45 * toolFit + 0.35 * benchmarkTaskFit + 0.15 * contextFit + 0.05 * outputFit;

  const score = 0.75 * capability + 0.2 * operational + 0.05 * metadata;
  return {
    score: Math.round(score * 10) / 10,
    capability: Math.round(capability * 10) / 10,
    operational: Math.round(operational * 10) / 10,
    metadata: Math.round(metadata * 10) / 10,
    signals,
  };
}

/** How much a basis is worth as a TIE-BREAK only. Never mixed into the score itself. */
const BASIS_CONFIDENCE: Record<StrengthBasis, number> = { snapshot: 1, neutral: 0 };

/** One target with the strength that ranked it, and the provenance of that strength. */
export interface RankedTarget {
  target: ResolvedTarget;
  spec: string;
  strength: Strength;
  fitness: DeploymentFitness;
}

export function specOfTarget(t: ResolvedTarget): string {
  return t.model ? `${t.provider}/${t.model}` : t.provider;
}

/**
 * Rank targets strongest-first, KEEPING the provenance that produced each position.
 *
 * ⚠ The comparator used to read `getStrength(spec).score` and throw the rest away, which made a
 * `neutral` 50 — "nobody publishes anything about this model" — indistinguishable from a `snapshot`
 * 50 measured across five leaderboards (`ARC-31833353`). A provenance-free number was deciding
 * which backend serves a request, the one thing this module exists to prevent.
 *
 * Resolution order:
 *  1. deployment fitness, highest first — capability dominates, then operations and metadata;
 *  2. on an exact fitness tie, confidence-adjusted capability;
 *  3. then the better-evidenced basis and larger signal count;
 *  4. still tied, config order (`sort` is stable), so a pool's declared order is the last word.
 *
 * Operational unknowns are neutral, so a cold deployment keeps capability order rather than
 * being treated as broken. Hard availability/credential faults are demoted later by the breaker.
 */
export function rankTargetsWithProvenance(
  targets: ResolvedTarget[],
  opts: {
    signalsForTarget?: (target: ResolvedTarget, spec: string) => DeploymentRankingSignals;
    telemetryPath?: string;
    tierData?: TierData | null;
  } = {},
): RankedTarget[] {
  const cache = new Map<string, Strength>();
  const ranked: RankedTarget[] = targets.map((target) => {
    const spec = specOfTarget(target);
    let strength = cache.get(spec);
    if (strength === undefined) {
      strength = getStrength(spec, opts.tierData === undefined ? loadTierData() : opts.tierData);
      cache.set(spec, strength);
    }
    // The custom callback already owns operational telemetry. Constructing the default first made
    // dynamic pools read and score the same telemetry twice for every deployment.
    const signals = opts.signalsForTarget
      ? opts.signalsForTarget(target, spec)
      : (() => {
          const slash = spec.indexOf("/");
          return slash === -1
            ? {}
            : {
                runtimeScore: getRealWorldScore(
                  spec.slice(0, slash),
                  spec.slice(slash + 1),
                  opts.telemetryPath ? { path: opts.telemetryPath } : {},
                ),
              };
        })();
    return { target, spec, strength, fitness: deploymentFitness(strength, signals) };
  });

  if (ranked.length <= 1) return ranked;

  return ranked.sort((a, b) => {
    if (b.fitness.score !== a.fitness.score) return b.fitness.score - a.fitness.score;
    if (b.strength.score !== a.strength.score) return b.strength.score - a.strength.score;
    const cb = BASIS_CONFIDENCE[b.strength.basis];
    const ca = BASIS_CONFIDENCE[a.strength.basis];
    if (cb !== ca) return cb - ca;
    return (b.strength.signalCount ?? 0) - (a.strength.signalCount ?? 0);
  });
}

/** Ranked targets only. Use `rankTargetsWithProvenance` when the caller can report WHY. */
export function rankTargetsByBenchmark(targets: ResolvedTarget[]): ResolvedTarget[] {
  if (targets.length <= 1) return [...targets];
  const specs = targets.map(specOfTarget);
  const key = `${Math.floor(Date.now() / STATIC_RANKING_EPOCH_MS)}\n${specs.join("\n")}`;
  const cached = staticRankingCache.get(key);
  if (cached) {
    const bySpec = new Map<string, ResolvedTarget[]>();
    for (const target of targets) {
      const spec = specOfTarget(target);
      const bucket = bySpec.get(spec) ?? [];
      bucket.push(target);
      bySpec.set(spec, bucket);
    }
    const restored = cached
      .map((spec) => bySpec.get(spec)?.shift())
      .filter((target): target is ResolvedTarget => !!target);
    if (restored.length === targets.length) return restored;
  }

  const ranked = rankTargetsWithProvenance(targets).map((r) => r.target);
  staticRankingCache.set(key, ranked.map(specOfTarget));
  // Configuration normally has only a handful of arrays. Still cap this process-global cache so
  // a client sending many distinct static lists through tests/embedders cannot grow it forever.
  if (staticRankingCache.size > 256) staticRankingCache.delete(staticRankingCache.keys().next().value!);
  return ranked;
}
