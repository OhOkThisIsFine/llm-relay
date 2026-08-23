/**
 * The availability producer the dashboard snapshot was missing.
 *
 * `dashboard-snapshot.ts` has accepted a `DashboardAvailabilityPort` since the SPA landed and
 * renders both panels, but nothing constructed one from live state, so Quota headroom and
 * Cooldowns were always empty. This module is that producer: it walks breaker cell state,
 * configured/learned limits, target-fact cooling conditions and the local ledger IN MEMORY and
 * emits contract rows. It performs no provider egress, no probes, and no disk reads — everything
 * it touches is already resident — and it never throws: a failing dependency yields empty panels
 * rather than failing a dashboard read.
 *
 * Rows are NOT truncated here on purpose: `availabilityRows()` in dashboard-snapshot.ts already
 * caps both panels at DASHBOARD_MAX_DIMENSION_ROWS and marks the cut PARTIAL in panel coverage.
 * Truncating here first would silently drop rows AND lose that partial flag, so the one bound
 * lives where the flag can be raised.
 */
import {
  type CooldownReason,
  type CooldownRowV1,
  type QuotaPeriod,
  type QuotaRowV1,
} from "./dashboard-contract.js";
import type { CircuitBreaker } from "./circuit-breaker.js";
import type { CredentialId } from "./credential-id.js";
import { parseCredentialId } from "./credential-id.js";
import { CONFIGURED_LIMIT_AXES, configuredLimitQuotaShape, resolveConfiguredLimits } from "./configured-limits.js";
import { providerCredentialSlots } from "./credential-fleet.js";
import { observedRateLimits } from "./rate-limits.js";
import {
  mapLimitBasis,
  mapRemainingBasis,
  resolveRemaining,
  resolveResetsAt,
  type LimitInputs,
  type LocalUsedReading,
} from "./availability.js";
import type { AccountingStore } from "./accounting-store.js";
import { evaluateHardCap } from "./hard-cap.js";
import { POOL_PREFIX, splitSpec, type Config } from "./config.js";
import type { QuotaAxis, QuotaObservation } from "./quota-observation.js";
import { factsFor } from "./target-facts.js";

/**
 * Dependencies, all optional except the config: quotas come from whatever evidence exists (the
 * bare in-memory proxy has a breaker but no store, so localUsed stays null there), and cooldowns
 * degrade to whichever sources were supplied.
 */
export interface AvailabilityProducerOptions {
  readonly breaker?: CircuitBreaker;
  readonly config: Config;
  /** The production store exposes `usedInWindow`; anything narrower still satisfies this seam. */
  readonly accounting?: Pick<AccountingStore, "usedInWindow"> | null;
  /** Injected for deterministic tests; defaults to Date.now(). */
  readonly now?: () => number;
}

/** Shape-compatible with `DashboardAvailabilityPort`; typed locally so server.ts stays decoupled. */
export interface AvailabilitySnapshot {
  snapshot(): { quotas: QuotaRowV1[]; cooldowns: CooldownRowV1[] };
}

interface Bucket {
  observations: QuotaObservation[];
  limits: LimitInputs;
}

/**
 * One quota row per (credential × deployment × axis × period) with ANY evidence: a
 * provider-stated observation, a learned limit, or a configured limit. Rows whose resolution
 * leaves figures null are still emitted — a known-limit/unknown-used row is exactly the
 * "limit known, usage unmeasured" state §5.3 wants rendered as `-`, not hidden.
 */
function buildQuotas(
  cfg: Config,
  breaker: CircuitBreaker | undefined,
  accounting: AvailabilityProducerOptions["accounting"],
  now: number,
): QuotaRowV1[] {
  const rows: QuotaRowV1[] = [];
  if (breaker === undefined) return rows;

  for (const state of breaker.getAllStates().values()) {
    const parsed = parseCredentialId(state.target.credentialId);
    // An unparseable cell id cannot be labelled or narrowed; skip it rather than guess.
    if (parsed === null) continue;
    const provider = parsed.provider;
    const model = state.target.model;
    const credentialId = state.target.credentialId;

    const buckets = new Map<string, Bucket>();
    const bucketFor = (axis: QuotaAxis, period: Exclude<QuotaPeriod, "unknown">): Bucket => {
      const key = `${axis}:${period}`;
      let bucket = buckets.get(key);
      if (bucket === undefined) {
        bucket = { observations: [], limits: {} };
        buckets.set(key, bucket);
      }
      return bucket;
    };

    for (const observation of state.quotaObservations) {
      if (observation.period === "unknown") continue;
      bucketFor(observation.axis, observation.period).observations.push(observation);
    }

    // Learned ceilings (packet C's store) cover this attempt/credential/deployment by scope.
    if (model !== null) {
      for (const entry of observedRateLimits(provider, credentialId as CredentialId, model, { now })) {
        bucketFor(entry.axis, entry.period).limits.learned = entry.limit;
      }
    }

    // Operator-declared ceilings resolve per axis through packet B's ladder.
    const configured = resolveConfiguredLimits(cfg, provider, parsed.label, model);
    if (configured !== null) {
      for (const axis of CONFIGURED_LIMIT_AXES) {
        const value = configured[axis];
        if (value === undefined) continue;
        const shape = configuredLimitQuotaShape(axis);
        bucketFor(shape.axis, shape.period).limits.configured = value;
      }
    }

    for (const [key, bucket] of buckets) {
      const [axisPart, periodPart] = key.split(":") as [QuotaAxis, Exclude<QuotaPeriod, "unknown">];
      // The ledger reports {requests, tokens}; the ladder consumes one figure — tokens for the
      // token axes (what a TPM/TPD ceiling bounds) and the request count otherwise.
      const windowReading =
        accounting === undefined || accounting === null
          ? null
          : accounting.usedInWindow({ credentialId, ...(model !== null ? { model } : {}), period: periodPart, now });
      const localUsed: LocalUsedReading = windowReading === null
        ? { value: null, basis: null }
        : { value: axisPart === "tokens" ? windowReading.tokens : windowReading.requests, basis: windowReading.basis };
      const resolution = resolveRemaining({
        observations: bucket.observations,
        axis: axisPart,
        period: periodPart,
        ...(bucket.limits.configured !== undefined ||
          bucket.limits.learned !== undefined ||
          bucket.limits.published !== undefined
          ? { limits: bucket.limits }
          : {}),
        localUsed,
        now,
      });
      const resets = resolveResetsAt({
        providerStated: resolution.eligibleObservation?.resetsAt ?? null,
        reviewedRule: null,
        period: periodPart,
        now,
      });
      rows.push({
        credentialId,
        label: parsed.label,
        provider,
        deployment: model,
        axis: axisPart,
        period: periodPart,
        limit: resolution.limit,
        remaining: resolution.remaining,
        localUsed: resolution.localUsed,
        resetsAt: resets.resetsAt === null ? null : new Date(resets.resetsAt).toISOString(),
        observedAt:
          resolution.eligibleObservation === null
            ? null
            : new Date(resolution.eligibleObservation.observedAt).toISOString(),
        limitBasis: mapLimitBasis(resolution.limitBasis),
        remainingBasis: mapRemainingBasis(resolution.basis),
        localUsedBasis: resolution.localUsedBasis,
      });
    }
  }

  return rows;
}

/** Models any relay-routed traffic can reach: pool members plus subagent/tier/default targets. */
function routableModels(cfg: Config): Map<string, Set<string>> {
  const byProvider = new Map<string, Set<string>>();
  const addSpec = (spec: string): void => {
    // A pool ref expands to its member specs; anything else splits directly.
    for (const member of spec.startsWith(`${POOL_PREFIX}/`)
      ? cfg.routing.pools?.[spec.slice(POOL_PREFIX.length + 1)] ?? []
      : [spec]) {
      const { provider, model } = splitSpec(member);
      if (!model) continue;
      let models = byProvider.get(provider);
      if (models === undefined) {
        models = new Set();
        byProvider.set(provider, models);
      }
      models.add(model);
    }
  };
  for (const specs of Object.values(cfg.routing.pools ?? {})) for (const spec of specs) addSpec(spec);
  for (const spec of Object.values(cfg.routing.subagents ?? {})) addSpec(spec);
  // The default/tier routes are relay-routed traffic too, and often the ONLY place a
  // single-provider install names a model.
  const fallback = cfg.routing.default;
  if (typeof fallback === "string") addSpec(fallback);
  else if (Array.isArray(fallback)) for (const spec of fallback) addSpec(spec);
  for (const tierSpec of Object.values(cfg.routing.tiers ?? {})) {
    for (const spec of Array.isArray(tierSpec) ? tierSpec : [tierSpec]) addSpec(spec);
  }
  return byProvider;
}

/**
 * Cooldown rows from four sources, deduped per cell/reason keeping the LONGEST window:
 * breaker cooldowns (reason from the cooldown source / last status), credential faults
 * (auth_error), the COOLING half of target-facts, and REACHED operator-set hard caps
 * (`manual` — G2). Fact mapping is documented at use site.
 */
function buildCooldowns(
  cfg: Config,
  breaker: CircuitBreaker | undefined,
  accounting: AvailabilityProducerOptions["accounting"],
  now: number,
): CooldownRowV1[] {
  const rows = new Map<string, CooldownRowV1>();
  const push = (
    source: { credentialId: string; provider: string; model: string | null },
    reason: CooldownReason,
    until: number,
    observedAt: number | null,
  ): void => {
    const key = `${source.provider} ${source.credentialId} ${source.model ?? ""} ${reason}`;
    const existing = rows.get(key);
    // Keep the LONGEST window per cell/reason. Never fabricate an observation time — an absent
    // one stays null rather than becoming "now" disguised as an observation.
    if (existing !== undefined && existing.until !== null && Date.parse(existing.until) >= until) return;
    rows.set(key, {
      credentialId: source.credentialId,
      provider: source.provider,
      deployment: source.model,
      reason,
      until: new Date(until).toISOString(),
      observedAt: observedAt === null ? null : new Date(observedAt).toISOString(),
    });
  };

  if (breaker !== undefined) {
    for (const state of breaker.getAllStates().values()) {
      if (parseCredentialId(state.target.credentialId) === null) continue;
      const source = {
        credentialId: state.target.credentialId,
        provider: state.target.provider,
        model: state.target.model,
      };
      const failureObservedAt = state.lastFailureTime > 0 ? state.lastFailureTime : null;
      if (state.cooldownUntil > now) {
        // "quota" joins rate_limit: Gap 12's demotion IS a spent-quota cooldown, which is what
        // this panel exists to show — labelling it provider_error would hide the one fact the
        // operator needs (the quota resets on its own; nothing is sick).
        const rateLimited =
          state.cooldownSource === "retry-after" ||
          state.cooldownSource === "escalation" ||
          state.cooldownSource === "quota" ||
          state.lastStatus === 429 ||
          state.lastStatus === 402;
        push(source, rateLimited ? "rate_limit" : "provider_error", state.cooldownUntil, failureObservedAt);
      }
      if (state.credentialFaultUntil > now) {
        push(source, "auth_error", state.credentialFaultUntil, failureObservedAt);
      }
    }
  }

  // What deployments STATED about themselves, through the COOLING half of target-facts:
  // allowance-exhausted → rate_limit (a spent free allowance is the free lane's normal state;
  //   the contract has no cost class and inventing one would mislabel it),
  // credential-invalid → auth_error, rate-limited → rate_limit.
  // One lookup per known cell: `factsFor` already resolves scope most-specific-first. The fact
  // reader does not expose `at`, so these rows carry observedAt null rather than a stand-in.
  const seen = new Set<string>();
  const consult = (cell: { credentialId: CredentialId | string; provider: string; model: string | null }): void => {
    const key = `${cell.provider} ${cell.credentialId} ${cell.model ?? ""}`;
    if (seen.has(key)) return;
    seen.add(key);
    for (const fact of factsFor(cell.provider, cell.credentialId as CredentialId, cell.model, { now })) {
      let reason: CooldownReason | null = null;
      if (fact.kind === "allowance-exhausted" || fact.kind === "rate-limited") reason = "rate_limit";
      else if (fact.kind === "credential-invalid") reason = "auth_error";
      if (reason === null || fact.until <= now) continue;
      push(cell, reason, fact.until, null);
    }
  };

  if (breaker !== undefined) {
    for (const state of breaker.getAllStates().values()) consult(state.target);
  }
  const models = routableModels(cfg);
  for (const [name, p] of Object.entries(cfg.providers)) {
    for (const slot of providerCredentialSlots(name, p)) {
      // The credential-wide cell (model null) catches account/key-scoped facts; per-model cells
      // catch attempt/deployment-scoped ones for traffic this config can actually route.
      consult({ credentialId: slot.credentialId, provider: name, model: null });
      for (const model of models.get(name) ?? []) {
        consult({ credentialId: slot.credentialId, provider: name, model });
      }

      // G2: a REACHED operator-set hard cap is a self-lifting refusal condition too — the panel's
      // reason vocabulary has `manual` precisely for "the operator stopped this, nothing is sick".
      // The SAME evaluator the request path refuses on decides reachment, so panel and enforcement
      // cannot disagree; no store ⇒ usage unknown ⇒ no row. observedAt stays null: config load is
      // not an observation.
      //
      // This is the CREDENTIAL-WIDE cell (`model: null`): no `models.<id>` entry can win an axis
      // without a model to key it, so the scope the evaluator asks for here is always
      // `credential` and the read is deliberately un-narrowed. Narrowing to a model nobody named
      // would be a fabricated read; the per-deployment cells belong to `/candidates`, which does
      // carry a model and does honour the scope argument.
      const verdict = evaluateHardCap({
        cfg,
        provider: name,
        credentialLabel: slot.label,
        model: null,
        usedInWindow:
          accounting === undefined || accounting === null
            ? () => ({ value: null, basis: null })
            : (axis, period) => {
                const window = accounting.usedInWindow({
                  credentialId: slot.credentialId,
                  period,
                  now,
                });
                return { value: axis === "requests" ? window.requests : window.tokens, basis: window.basis };
              },
        now,
      });
      if (verdict !== null) push(
        { credentialId: slot.credentialId, provider: name, model: null },
        "manual",
        verdict.resetsAt,
        null,
      );
    }
  }

  return [...rows.values()];
}

/**
 * Build the port handed to `createDashboardSnapshotReadPort`. One instance per proxy; each
 * `snapshot()` call re-reads live state, so restart-clearable breaker data recovers on its own.
 */
export function createAvailabilityProducer(options: AvailabilityProducerOptions): AvailabilitySnapshot {
  const { breaker, config, accounting } = options;
  const clock = options.now ?? (() => Date.now());
  return {
    snapshot() {
      try {
        const now = clock();
        return {
          quotas: buildQuotas(config, breaker, accounting ?? null, now),
          cooldowns: buildCooldowns(config, breaker, accounting ?? null, now),
        };
      } catch {
        // A diagnostic producer must never fail a dashboard read; an empty result surfaces as
        // the panels' own coverage state instead.
        return { quotas: [], cooldowns: [] };
      }
    },
  };
}
