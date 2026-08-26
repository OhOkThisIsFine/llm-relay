import { anyOffloadEnabled, splitSpec, type Config, type OffloadRule, type ProviderConfig } from "./config.js";
import { POOL_PREFIX } from "./config.js";
import type { CredentialSource } from "./authEnv.js";
import type { ModelCatalog } from "./catalog.js";
import type { PingLoop } from "./ping/cadence.js";
import { deploymentFitness, getStrength, type StrengthBasis } from "./benchmarks.js";
import { findTierModel, type TierData } from "./tier-data.js";
import {
  implicitCredentialSlot,
  providerCredentialSlots,
  resolveCredentialSlot,
  slotAllowsModel,
  type CredentialSlot,
} from "./credential-fleet.js";
import { resolveMetadata, type MetadataSource } from "./metadata.js";
import {
  globalCircuitBreaker,
  type CircuitBreaker,
  type CooldownSource,
} from "./circuit-breaker.js";
import type { ProviderTargetIdentity } from "./kernel/contracts.js";
import { describeScope, factsFor } from "./target-facts.js";
import { getRealWorldScore, loadRuntimeTelemetry, type TelemetryData } from "./ping/runtime-telemetry.js";
import { loadTierData } from "./registry.js";
import { materializeDynamicPools } from "./dynamic-pools.js";
import { type QuotaObservation } from "./quota-observation.js";
import { observedRateLimits } from "./rate-limits.js";
import { resolveConfiguredLimits } from "./configured-limits.js";
import { createHardCapLedgerReader, evaluateHardCap } from "./hard-cap.js";
import { parseCredentialId, type CredentialId } from "./credential-id.js";
import {
  collectQuotaBuckets,
  factResetInputs,
  resolveRemaining,
  resolveResetsAt,
  type LocalUsedReading,
  type RemainingResolution,
  type ResetsAtResolution,
} from "./availability.js";

/**
 * The §5.1/§5.2 ladders resolved for ONE (axis, period) bucket of one credential cell.
 *
 * Kept raw and un-blended like every other Candidate dimension: remaining, limit and localUsed
 * each travel with their own basis so a reader can tell a provider's stated figure from this
 * relay's own arithmetic. `routingEligible` reports whether the figure MAY gate routing under
 * spec M2 — it does not mean anything gates today.
 */
export interface CandidateAvailability {
  axis: "requests" | "tokens";
  period: "minute" | "day" | "month";
  limit: number | null;
  limitBasis: RemainingResolution["limitBasis"];
  remaining: number | null;
  remainingBasis: RemainingResolution["basis"];
  localUsed: number | null;
  localUsedBasis: LocalUsedReading["basis"];
  resetsAt: number | null;
  resetsAtBasis: ResetsAtResolution["basis"];
  /** True when the observation rung 1 used is still inside the CURRENT period. */
  observedInCurrentPeriod: boolean;
  staleObservations: number;
  routingEligible: boolean;
}

/**
 * Everything known about one offload destination, kept as SEPARATE raw dimensions.
 *
 * Every raw dimension remains visible. Pool ordering additionally exposes one transparent
 * deployment-fitness scalar and its capability/operations/metadata components; it is necessary
 * to order candidates, not a claim that the underlying measurements are interchangeable.
 */
export interface Candidate {
  spec: string;
  provider: string;
  model?: string;
  /** The credential cell this row describes. */
  credentialId: string;
  /** Non-secret credential-slot diagnostics; key material is never included. */
  credential: {
    label: string;
    authEnv: string | null;
    enabled: boolean;
    models: readonly string[] | null;
    state: "not-declared" | "declared-present" | "declared-missing";
    source: CredentialSource | null;
    /** Whether this slot's optional model allow-list includes the row's deployment. */
    modelAllowed: boolean;
  };
  /** Pools this spec belongs to, and subagent tiers currently pointing at it. */
  pools: string[];
  subagentTiers: string[];
  /** This slot's auth env var is populated; intentional passthrough/keyless slots are usable. */
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
  /** Typed observations for this credential/model cell. Empty means not measured. */
  quota: QuotaObservation[];
  /**
   * The spec §5 ladders applied to this cell, one entry per (axis, period) bucket with any
   * evidence. Beside `quota`, never blended into it: `quota` is what providers SAID,
   * `availability` is what that leaves OVER after staleness and this proxy's own usage.
   * Display-only; nothing here reorders a candidate (Gap 12 owns any routing use).
   */
  availability: CandidateAvailability[];
  breaker: {
    open: boolean;
    consecutiveFailures: number;
    lastStatus: number | null;
    cooldownRemainingMs: number;
    cooldownSource: CooldownSource | null;
    unexplained429s: number;
    /**
     * Credential faults observed on real traffic, on their own axis.
     *
     * A member answering 401 on every call used to be indistinguishable here from a healthy
     * one — verdict `Pending`, breaker `closed`, no failure count — because a 401 is
     * deliberately not health data and so reached none of the fields above. It is still not
     * health data; it is reported as what it is. `credentialFault` true means the router is
     * currently DEMOTING this member (it is tried only after every other candidate fails),
     * and it expires, so a rotated key recovers without a restart.
     */
    credentialFailures: number;
    lastCredentialStatus: number | null;
    credentialFault: boolean;
  };
  /**
   * What this deployment (or its provider, or its group) has STATED about itself — the learned
   * facts from `target-facts.ts`, each with the scope it applies at.
   *
   * Separate from `breaker` on purpose, and for the same reason credential faults are: these are
   * not health measurements, they are things a backend said. The breaker fields describe how a
   * deployment has been behaving; these describe what it is entitled to. A member cooling on an
   * account-wide credit balance and one cooling on its own repeated timeouts look identical in
   * `breaker` alone, and they call for completely different responses — one is "wait or switch
   * provider", the other is "this deployment is sick".
   */
  /**
   * What this deployment (or its provider, or its group) has STATED about itself — the learned
   * facts from `target-facts.ts`, each with the scope it applies at. The measurement kinds
   * (`context-limit`, `rate-limit-rpm|rpd|tpm|tpd`) also carry `value`: the ceiling itself, as
   * stated. Display-only — nothing here reorders or gates a candidate.
   */
  facts: Array<{ kind: string; scope: string; expiresInMs: number; value?: number }>;
  /**
   * G2's operator-set hard cap for this cell, as `evaluateHardCap` sees it RIGHT NOW — the same
   * resolver the request path refuses on, so this view can never disagree with enforcement.
   * Null when nothing is declared, the switch is off, or usage is unmeasured (unknown ⇒ no
   * refusal ⇒ no row). Beside `availability` rather than inside it, because a cap is an
   * OPERATOR instruction, not an observation about the deployment.
   */
  hardCap: {
    axis: "requests" | "tokens";
    period: "minute" | "day";
    cap: number;
    used: number;
    /** The cap is an operator ASSERTION — labelled, so a machine consumer never reads it as measured. */
    basis: "operator-declared";
    /** Which declaration site supplied it, and so whose usage `used` counts (see `hard-cap.ts`). */
    source: "provider" | "credential" | "provider-model" | "credential-model";
    scope: "credential" | "deployment";
    resetsAt: string;
    /** The reset is a UTC period boundary this relay derived, never a figure anyone published. */
    resetsAtBasis: "derived-boundary";
  } | null;
  /** Observed real traffic through this proxy (not synthetic probes). */
  observed: {
    totalCalls: number;
    successCalls: number;
    avgLatencyMs: number | null;
    lastCalledAt: string | null;
  } | null;
  /** Provider-reported completion-token coverage; null means no usage was reported. */
  completionTokens: {
    reported: number | null;
    reportedCalls: number;
    totalCalls: number;
  };
  /**
   * Limits, each with its own provenance. `provider` = this provider published it about its own
   * deployment; `reference` = borrowed from another provider serving the same model id (different
   * deployment, so indicative only — `metadataReferenceFrom` names it). Null = nobody publishes it.
   *
   * `metadataReferenceFrom` is `openrouter` when the borrowed row is that exact model id, and
   * `openrouter:<matched-name>` when the snapshot row was only a FUZZY name match — i.e. the
   * number belongs to a different SKU. Read it before quoting a reference figure.
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
  /** What the proxy itself sorts by, with the component scores and provenance beside it. */
  sortInputs: {
    /** Drives pool ordering: 75% capability, 20% operations, 5% task-fit metadata. */
    fitness: number;
    capability: number;
    operational: number;
    metadata: number;
    /** Confidence-adjusted capability used in deployment-fitness ordering. */
    strength: number;
    /** Raw dimension-balanced capability used for effort floors. */
    rawStrength: number;
    /** 0-1 evidence confidence applied to rawStrength. */
    strengthConfidence: number;
    /** snapshot | neutral. Operational telemetry never stands in for capability. */
    strengthBasis: StrengthBasis;
    /** Direct capability signals behind the estimate. */
    strengthSignals: string[];
    /** Capability plus separate task-fit publications used by the admission evidence gate. */
    publishedSignalCount: number;
    capabilityDimensions: Partial<Record<"agentic" | "coding" | "general", number>>;
    directDimensions: string[];
    imputedDimensions: string[];
    /** Specialized benchmark fit input, kept separate from raw capability. */
    benchmarkTaskFit: number | null;
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
  /** True when at least one client-specific rule is enabled. */
  offload_enabled: boolean;
  /** The per-originating-client rules; empty for the legacy boolean form. */
  offload_clients: Record<string, OffloadRule>;
  note: string;
  candidates: Candidate[];
}

const NOTE =
  "Raw per-dimension data for choosing an offload target. Leaderboards remain separate — " +
  "order is the materialized pool order (fixed preferences, then discovered free models), and every source's score is kept " +
  "under `scores`. `sortInputs` shows the capability-led deployment fitness used for pool " +
  "ordering and its full breakdown; it is not a universal recommendation.";

/** Expand a spec that may itself be `pool/<name>` into concrete "provider/model" specs. */
function expandSpec(spec: string, cfg: Config): string[] {
  const i = spec.indexOf("/");
  const head = i === -1 ? spec : spec.slice(0, i);
  if (head !== POOL_PREFIX) return [spec];
  const name = i === -1 ? "" : spec.slice(i + 1);
  return cfg.routing.pools?.[name] ?? [];
}

/**
 * The set of specs a subagent could actually be sent to: every materialized pool member plus
 * anything `routing.subagents` points at. Dynamic pools intentionally make the free catalog part
 * of that real choice set rather than hiding it behind a hand-maintained shortlist.
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

/**
 * Confidence in a resolved limit for fitness scoring: the serving provider's own published
 * figure is authoritative; another provider's `reference` figure counts half, and only when
 * the tier join was exact (a fuzzy join may describe a different SKU); otherwise nothing.
 */
function metadataConfidence(source: MetadataSource | null, exactMatch: boolean): number {
  if (source === "provider") return 1;
  return source === "reference" && exactMatch ? 0.5 : 0;
}

/**
 * The breaker owns credential cells, while this view describes deployments. Its deployment
 * measurement merges stored cell samples in timestamp order and derives confidence from the
 * least-observed contributing cell. Cell-only fields below still use the exact requested identity.
 */
function deploymentBreakerStats(
  breaker: CircuitBreaker,
  target: ProviderTargetIdentity,
): { stability: number | null; confidenceSamples: number } {
  const measurement = breaker.getDeploymentMeasurement({
    provider: target.provider,
    model: target.model,
  });
  return {
    stability: measurement.stabilityScore,
    confidenceSamples: measurement.minSamples,
  };
}

/**
 * Probe and live response observations describe the same typed tuple but arrive through
 * independent paths. Keep every axis/period and let the newer measurement win each tuple;
 * source order must never make an older probe look fresher than real traffic.
 */
function mergeCandidateQuota(
  probe: readonly QuotaObservation[],
  breaker: readonly QuotaObservation[],
): QuotaObservation[] {
  const merged = new Map<string, QuotaObservation>();
  for (const observation of [...probe, ...breaker]) {
    const key = `${observation.axis}:${observation.period}`;
    const existing = merged.get(key);
    if (!existing || observation.observedAt >= existing.observedAt) merged.set(key, observation);
  }
  return [...merged.values()];
}

/**
 * Apply the §5 ladders to one credential cell. Buckets come from the SAME merged observations
 * the `quota` field shows; limits join from configured/learned sources. These rows always carry
 * a null `localUsed`: `buildCandidateAvailability` takes no ledger input, so the local-arithmetic
 * rung does not run — the `opts.accounting` reader that G2's hard cap uses elsewhere in this file
 * is deliberately not threaded here. The ladder still resolves provider-stated remaining (rung 1)
 * and reports the applicable limit.
 *
 * §5.2's fact-fed rungs go through `factResetInputs` — the SAME helper the dashboard's producer
 * calls. Two implementations of "may this fact answer this bucket" is how one cell comes to read
 * `reviewed-rule` in the dashboard and `derived-boundary` in `llm-relay candidates`.
 */
function buildCandidateAvailability(
  cfg: Config,
  provider: string,
  credentialId: string,
  model: string | undefined,
  quota: readonly QuotaObservation[],
  nowMs: number,
): CandidateAvailability[] {
  const parsed = parseCredentialId(credentialId);
  if (parsed === null) return [];
  const configured = resolveConfiguredLimits(cfg, provider, parsed.label, model ?? null);
  const learned = model === undefined ? [] : observedRateLimits(provider, credentialId as CredentialId, model, { now: nowMs });
  // One read per cell; the order (most-specific scope first) is load-bearing input below.
  const cellFacts = factsFor(provider, credentialId as CredentialId, model ?? null, { now: nowMs });

  const buckets = collectQuotaBuckets({ observations: quota, learned, configured });

  const rows: CandidateAvailability[] = [];
  for (const bucket of buckets.values()) {
    const { axis: axisPart, period: periodPart } = bucket;
    const hasLimits = bucket.limits.configured !== undefined || bucket.limits.learned !== undefined;
    if (bucket.observations.length === 0 && !hasLimits) continue;
    const resolution = resolveRemaining({
      observations: bucket.observations,
      axis: axisPart,
      period: periodPart,
      ...(hasLimits ? { limits: bucket.limits } : {}),
      localUsed: { value: null, basis: null },
      now: nowMs,
    });
    const resets = resolveResetsAt({
      ...factResetInputs({
        facts: cellFacts,
        observationReset: resolution.eligibleObservation?.resetsAt ?? null,
        remaining: resolution.remaining,
        now: nowMs,
      }),
      period: periodPart,
      now: nowMs,
    });
    rows.push({
      axis: axisPart,
      period: periodPart,
      limit: resolution.limit,
      limitBasis: resolution.limitBasis,
      remaining: resolution.remaining,
      remainingBasis: resolution.basis,
      localUsed: null,
      localUsedBasis: null,
      resetsAt: resets.resetsAt,
      resetsAtBasis: resets.basis,
      // Rung 1's own eligibility verdict — do not re-derive the staleness rule here; a second
      // implementation is how the two drift.
      observedInCurrentPeriod: resolution.eligibleObservation !== null,
      staleObservations: resolution.staleObservations,
      routingEligible: resolution.routingEligible,
    });
  }
  return rows;
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
    /** Capability snapshot override. Injected the same way `breaker`/`nowMs` are, so the
     *  match-quality behaviour can be exercised against a fixed row set instead of whatever
     *  `npm run sync:tiers` last wrote. Omitted ⇒ the real snapshot. */
    tierData?: TierData | null;
    /** Runtime telemetry override for deterministic views/tests. Omitted ⇒ the live store. */
    telemetry?: TelemetryData;
    /**
     * The accounting store's in-memory window read (G2). Absent — the CLI against a remote
     * proxy, or a bare programmatic proxy — means no cell can show a reached cap, because
     * usage is unmeasured and unknown refuses nothing.
     */
    accounting?: Pick<import("./accounting-store.js").AccountingStore, "usedInWindow"> | null;
  } = {},
): Promise<CandidatesView> {
  if (opts.catalog) materializeDynamicPools(cfg, opts.catalog);
  const breaker = opts.breaker ?? globalCircuitBreaker;
  const nowMs = opts.nowMs ?? Date.now();
  const tierData = opts.tierData === undefined ? loadTierData() : opts.tierData;
  const byNorm = tierData?.byNorm ?? [];
  const telemetry = opts.telemetry ?? loadRuntimeTelemetry();
  const memberships = collectSpecs(cfg);

  // Hydrate each provider once. `has()` + `limits()` per row both call `list()`, which turned a
  // candidates view into 2N sequential catalog operations even though every row shares a small
  // provider-level snapshot.
  const listedByProvider = new Map<string, Set<string> | null>();
  if (opts.catalog) {
    const providers = new Set<string>();
    for (const spec of memberships.keys()) {
      const { provider } = splitSpec(spec);
      if (!opts.provider || provider === opts.provider) providers.add(provider);
    }
    await Promise.all([...providers].map(async (provider) => {
      const p = cfg.providers[provider];
      if (!p || p.kind !== "openai") {
        listedByProvider.set(provider, null);
        return;
      }
      try {
        const models = await opts.catalog!.list(provider, p);
        listedByProvider.set(
          provider,
          models.length > 0 || opts.catalog!.hasCachedCatalog(provider) ? new Set(models) : null,
        );
      } catch {
        listedByProvider.set(provider, null);
      }
    }));
  }

  const credentialCells: Array<{
    spec: string;
    membership: { pools: string[]; subagentTiers: string[] };
    provider: string;
    model: string | undefined;
    providerConfig: ProviderConfig | undefined;
    slot: CredentialSlot;
  }> = [];
  for (const [spec, membership] of memberships) {
    const { provider, model } = splitSpec(spec);
    if (opts.provider && provider !== opts.provider) continue;
    const providerConfig: ProviderConfig | undefined = cfg.providers[provider];
    const slots: readonly CredentialSlot[] = providerConfig
      ? providerCredentialSlots(provider, providerConfig)
      : [implicitCredentialSlot(provider)];
    for (const slot of slots) {
      credentialCells.push({ spec, membership, provider, model, providerConfig, slot });
    }
  }

  const candidates: Candidate[] = [];
  for (const { spec, membership, provider, model, providerConfig: p, slot } of credentialCells) {
    const credentialId = slot.credentialId;
    const credentialResolution = p
      ? resolveCredentialSlot(slot)
      : { state: "not-declared" as const, value: undefined, envName: undefined, source: undefined };
    const modelAllowed = slotAllowsModel(slot, model);
    // This is the exact credential-cell identity. Cell-only breaker operations below
    // must receive the identity, never the display spec or a serialized provider/model key.
    const cellTarget: ProviderTargetIdentity = {
      provider,
      model: model ?? null,
      kind: p?.kind ?? "openai",
      credentialId,
      ...(p?.base ? { base: p.base } : {}),
    };

    const providerModels = listedByProvider.get(provider) ?? null;
    const listed = p && p.kind === "openai" && model && opts.catalog
      ? providerModels?.has(model) ?? null
      : null;

    const summary = opts.pingLoop && model ? opts.pingLoop.getModelSummary(provider, model) : null;
    const state = breaker.getState(cellTarget);
    const obs = model ? telemetry.models[`${provider}/${model}`] : undefined;
    const strength = getStrength(spec, tierData);
    const matched = findTierModel(model ?? spec, byNorm, tierData?.exactByNorm);
    const tier = matched?.rec;
    const num = (k: string) => (typeof tier?.[k] === "number" ? (tier[k] as number) : null);

    // Limits THIS provider publishes about its own deployment, if any. NIM publishes none;
    // Groq and Mistral publish real ones. The snapshot's numbers come from OpenRouter, so for a
    // NIM target they are a different deployment's figures and are labelled `reference`, never
    // presented as this provider's own.
    const providerLimits = p && p.kind === "openai" && model && opts.catalog
      ? opts.catalog.cachedLimits(provider, model)
      : null;
    // ⚠ On a FUZZY snapshot match these figures describe a similarly-named but different
    // SKU (`glm-5.2` → `glm-5.2-max`), and `from` named only the host — so a borrowed
    // ceiling or price was indistinguishable from one published for this very model id
    // unless the reader separately correlated `capabilityMatch`. The matched name travels
    // with the attribution instead, so `metadataReferenceFrom` states both WHOSE figure it
    // is and WHICH model's.
    const referenceFrom =
      matched && matched.match === "fuzzy" ? `openrouter:${matched.rec.norm}` : "openrouter";
    const meta = resolveMetadata(model ?? provider, {
      providerLimits,
      reference: {
        contextLength: num("context_length"),
        pricePromptPerToken: num("price_prompt"),
        priceCompletionPerToken: num("price_completion"),
        from: referenceFrom,
      },
    });
    const exactTier = matched?.match === "exact" ? tier : undefined;
    const supportsTools = typeof exactTier?.supports_tools === "boolean" ? exactTier.supports_tools : null;
    const deploymentStats = deploymentBreakerStats(breaker, cellTarget);
    const breakerStability = deploymentStats.stability;
    // Preserve the existing evidence order: the purpose-built probe summary wins when present;
    // live breaker observations are the fallback. Packet 2 changes the breaker's fallback from
    // one credential cell to the deployment aggregate, not which measurement source outranks it.
    const stabilityScore = summary && summary.stabilityScore >= 0
      ? summary.stabilityScore
      : breakerStability;
    const stabilitySamples = summary && opts.pingLoop && model
      ? opts.pingLoop.getModelPings(provider, model).length
      : deploymentStats.confidenceSamples;
    const fitness = deploymentFitness(strength, {
      stabilityScore,
      stabilityConfidence: Math.min(1, stabilitySamples / 5),
      runtimeScore: model ? getRealWorldScore(provider, model, { telemetry, now: nowMs }) : null,
      supportsTools,
      contextLength: meta.contextLength,
      contextConfidence: metadataConfidence(meta.contextLengthSource, matched?.match === "exact"),
      maxOutputTokens: meta.maxOutputTokens,
      maxOutputConfidence: metadataConfidence(meta.maxOutputTokensSource, matched?.match === "exact"),
      benchmarkTaskFitScore: typeof exactTier?.task_fit_score === "number" ? exactTier.task_fit_score * 100 : null,
      benchmarkTaskFitConfidence: Math.min(1, (exactTier?.task_fit_signal_count ?? 0) / 3),
    });

    // One merge for BOTH the raw `quota` field and the resolved `availability` ladders, so the
    // two views can never disagree about which observation is newest.
    const cellQuota = mergeCandidateQuota(
      opts.pingLoop && model ? opts.pingLoop.getQuotaObservations(credentialId, model) : [],
      state?.quotaObservations ?? [],
    );
    // G2's refusal ceiling for this cell — resolved through the SAME evaluator the request path
    // refuses on, AND narrowed by the same rule: a `models.<id>.hard` ceiling reads that
    // deployment's usage, a flat one reads the credential's usage across every model. Sharing the
    // evaluator is not enough on its own — display and enforcement drifted apart precisely by
    // asking the ledger two different questions through it.
    const verdict = evaluateHardCap({
      cfg,
      provider,
      credentialLabel: slot.label,
      model: model ?? null,
      usedInWindow: createHardCapLedgerReader(opts.accounting, credentialId, model, nowMs),
      now: nowMs,
    });

    candidates.push({
      spec,
      provider,
      ...(model ? { model } : {}),
      credentialId,
      pools: membership.pools,
      subagentTiers: membership.subagentTiers,
      // The shared presence predicate, not an open-coded `?.trim()`. Three sites disagreed
      // about whether a whitespace-only key counts as present; this is the single answer.
      hasKey: credentialResolution.state !== "declared-missing",
      credential: {
        label: slot.label,
        authEnv: slot.authEnv ?? null,
        enabled: slot.enabled,
        models: slot.models,
        state: credentialResolution.state,
        source: credentialResolution.source ?? null,
        modelAllowed,
      },
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
      quota: cellQuota,
      availability: buildCandidateAvailability(cfg, provider, credentialId, model, cellQuota, nowMs),
      hardCap:
        verdict === null
          ? null
          : {
              axis: verdict.axis,
              period: verdict.period,
              cap: verdict.cap,
              used: verdict.used,
              basis: verdict.basis,
              source: verdict.source,
              scope: verdict.scope,
              resetsAt: new Date(verdict.resetsAt).toISOString(),
              resetsAtBasis: verdict.resetsAtBasis,
            },
      breaker: {
        open: !breaker.isHealthy(cellTarget, nowMs),
        consecutiveFailures: state?.consecutiveFailures ?? 0,
        lastStatus: state?.lastStatus ?? null,
        cooldownRemainingMs: Math.max(0, (state?.cooldownUntil ?? 0) - nowMs),
        cooldownSource: state?.cooldownSource ?? null,
        unexplained429s: state?.unexplained429s ?? 0,
        credentialFailures: state?.credentialFailures ?? 0,
        lastCredentialStatus: state?.lastCredentialStatus ?? null,
        credentialFault: breaker.hasCredentialFault(cellTarget, nowMs),
      },
      facts: factsFor(provider, credentialId, model, { now: nowMs }).map((f) => ({
        kind: f.kind,
        scope: describeScope(f.scope),
        expiresInMs: Math.max(0, f.until - nowMs),
        ...(f.value === undefined ? {} : { value: f.value }),
      })),
      observed: obs
        ? {
            totalCalls: obs.totalCalls,
            successCalls: obs.successCalls,
            avgLatencyMs: obs.totalCalls > 0 ? Math.round(obs.totalLatencyMs / obs.totalCalls) : null,
            lastCalledAt: obs.lastCalledAt ? new Date(obs.lastCalledAt).toISOString() : null,
          }
        : null,
      completionTokens: {
        reported: obs && obs.completionTokenCalls > 0 ? obs.totalCompletionTokens : null,
        reportedCalls: obs?.completionTokenCalls ?? 0,
        totalCalls: obs?.totalCalls ?? 0,
      },
      contextLength: meta.contextLength,
      contextLengthSource: meta.contextLengthSource,
      maxOutputTokens: meta.maxOutputTokens,
      maxOutputTokensSource: meta.maxOutputTokensSource,
      ...(meta.referenceFrom ? { metadataReferenceFrom: meta.referenceFrom } : {}),
      pricePerMTokIn: meta.pricePerMTokIn,
      pricePerMTokOut: meta.pricePerMTokOut,
      priceSource: meta.priceSource,
      supportsTools,
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
        fitness: fitness.score,
        capability: fitness.capability,
        operational: fitness.operational,
        metadata: fitness.metadata,
        strength: strength.score,
        rawStrength: strength.rawScore,
        strengthConfidence: strength.confidence,
        strengthBasis: strength.basis,
        strengthSignals: strength.signals ?? [],
        publishedSignalCount: strength.publishedSignalCount ?? strength.signalCount ?? 0,
        capabilityDimensions: strength.dimensions ?? {},
        directDimensions: strength.directDimensions ?? [],
        imputedDimensions: strength.imputedDimensions ?? [],
        benchmarkTaskFit: typeof exactTier?.task_fit_score === "number" ? exactTier.task_fit_score * 100 : null,
        breakerStability,
      },
    });
  }

  return {
    generated_at: opts.now ?? new Date(nowMs).toISOString(),
    offload_enabled: anyOffloadEnabled(cfg),
    offload_clients: typeof cfg.routing.offload === "object" ? cfg.routing.offload : {},
    note: NOTE,
    candidates,
  };
}
