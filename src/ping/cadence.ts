import type { Config, ProviderConfig } from "../config.js";
import type { ModelCatalog } from "../catalog.js";
import { pingProviderModel, type PingResult } from "./ping.js";
import { type PingRecord, getAvg, getP95, getJitter, getStabilityScore, getVerdict, getUptime } from "./metrics.js";
import {
  recordProbeResult,
  recordRequestSample,
  getModelsDueForProbe,
  loadPersistedSamples,
  loadPersistedQuotaObservations,
  loadTotals,
} from "./probe-cache.js";
import { providerCredentialSlots, resolveCredentialSlot, slotAllowsModel } from "../credential-fleet.js";
import { getLastSuccessfulCallAt, loadRuntimeTelemetry } from "./runtime-telemetry.js";
import { materializeDynamicPools } from "../dynamic-pools.js";
import { makeCredentialId, parseCredentialId, type CredentialId } from "../credential-id.js";
import { mergeQuotaObservations, type QuotaObservation } from "../quota-observation.js";
import { fetchProviderQuota } from "./quota.js";
import { applySpendHeadroom, classifySpendHeadroom } from "../spend-headroom.js";
import { assessCost, type CostClass } from "../metadata.js";
import { clearFacts } from "../target-facts.js";

export type PingMode = "speed" | "normal" | "slow" | "forced";

export const PING_MODE_INTERVALS: Record<PingMode, number> = {
  speed: 2000,
  normal: 10000,
  slow: 30000,
  forced: 4000,
};

export const SPEED_MODE_DURATION_MS = 60000; // 60s
export const IDLE_SLOW_AFTER_MS = 300000; // 5 min
/**
 * How often one credential's provider-stated spend headroom is re-asked (`spend-headroom.ts`).
 * Slow on purpose: the figure moves with the account's own spend, and the `allowance-exhausted`
 * fact it feeds carries a 1h TTL — a 15-minute cadence keeps the fact alive while a condition
 * holds and notices bought credits within one interval, at four requests per credential per hour.
 */
export const SPEND_POLL_INTERVAL_MS = 15 * 60 * 1000;

/**
 * How often ONE cell cooling on a guessed 429 rung is re-probed (`reprobeRateLimited`). A minute
 * bounds the spend to one request per cooling cell per minute — against a cell the walk is not
 * serving anyway — while cutting a 2 m / 10 m / 1 h / 24 h guess down to at most a minute past
 * the moment the deployment actually recovers. A stated `Retry-After` is never re-probed early
 * (`REPROBE_TARGETS_COOLDOWN` in `circuit-breaker.ts`), so this cadence only ever shortens the
 * relay's OWN guesses.
 */
export const RATE_LIMIT_REPROBE_INTERVAL_MS = 60_000;
/** Re-probes spent per tick, soonest-lifting cells first — the same flooding bound as the catalog probe. */
export const MAX_RATE_LIMIT_REPROBES_PER_TICK = 3;

/**
 * The ONE thing the ping loop may do to the breaker (2026-09-15): end a 429-sourced cooldown when
 * a probe answers 200, and ask which cells are worth probing for that. A narrow structural port,
 * not a `CircuitBreaker` import — the loop must not be able to reach outcome recording, and
 * `CircuitBreaker` satisfies it directly so `server.ts` passes the breaker itself.
 */
export interface RateLimitRecoveryPort {
  rateLimitCoolingCells(now: number): ReadonlyArray<{
    readonly provider: string;
    readonly model: string | null;
    readonly credentialId: string;
    readonly cooldownUntil: number;
  }>;
  endRateLimitCooldown(cell: { credentialId: string; model: string | null }, at: number): boolean;
}

export interface ModelHealthSummary {
  providerKey: string;
  modelId: string;
  avgMs: number;
  p95Ms: number;
  jitterMs: number;
  stabilityScore: number;
  uptimePct: number;
  verdict: string;
  lastPingCode: string | null;
  lastPingMs: number | null;
}

function values(value: string | string[] | undefined): string[] {
  return Array.isArray(value) ? value : typeof value === "string" ? [value] : [];
}

/**
 * Concrete deployments that routing can currently select, ordered for useful early coverage.
 * Pool leaders come first, then pinned routes/subagent choices, then the remaining pool members.
 */
export function collectRoutableModels(cfg: Config): Map<string, string[]> {
  const ordered: string[] = [];
  const seen = new Set<string>();
  const touchConcrete = (spec: string) => {
    if (spec.startsWith("pool/")) {
      for (const member of cfg.routing.pools?.[spec.slice("pool/".length)] ?? []) touchConcrete(member);
      return;
    }
    const slash = spec.indexOf("/");
    if (slash <= 0 || slash === spec.length - 1 || seen.has(spec)) return;
    seen.add(spec);
    ordered.push(spec);
  };

  // Cover the head of every failover lane before spending probes on deep fallbacks.
  for (const members of Object.values(cfg.routing.pools ?? {})) {
    if (members[0]) touchConcrete(members[0]);
  }
  for (const spec of [
    ...values(cfg.routing.default),
    ...Object.values(cfg.routing.tiers).flatMap(values),
    ...Object.values(cfg.routing.subagents ?? {}),
  ]) touchConcrete(spec);
  for (const members of Object.values(cfg.routing.pools ?? {})) {
    for (const member of members) touchConcrete(member);
  }

  const byProvider = new Map<string, string[]>();
  for (const spec of ordered) {
    const slash = spec.indexOf("/");
    const provider = spec.slice(0, slash);
    const model = spec.slice(slash + 1);
    if (cfg.providers[provider]?.kind !== "openai") continue;
    const bucket = byProvider.get(provider) ?? [];
    bucket.push(model);
    byProvider.set(provider, bucket);
  }
  return byProvider;
}

export class PingLoop {
  private mode: PingMode = "speed";
  private modeSource = "startup";
  private intervalMs = PING_MODE_INTERVALS.speed;
  private speedUntil: number | null = Date.now() + SPEED_MODE_DURATION_MS;
  private lastActivityAt = Date.now();
  private resumeSpeedOnActivity = false;
  private timerObj: NodeJS.Timeout | null = null;
  private running = false;

  private pingHistory = new Map<string, PingRecord[]>();
  /** Quota is credential and model scoped; provider-wide percentages were always ambiguous. */
  private latestQuota = new Map<string, QuotaObservation[]>();
  /** Request-local fleet cursor persisted between ticks so one-due-model ticks still rotate. */
  private credentialCursors = new Map<string, number>();
  /** When each credential's spend headroom was last asked for — the SPEND_POLL_INTERVAL_MS gate. */
  private spendPolledAt = new Map<CredentialId, number>();
  /** When each cooling cell was last re-probed — the RATE_LIMIT_REPROBE_INTERVAL_MS gate, keyed `credentialId/model`. */
  private rateLimitReprobedAt = new Map<string, number>();

  constructor(
    private cfg: Config,
    private catalog: ModelCatalog,
    private opts: {
      fetchFn?: typeof fetch;
      autoStart?: boolean;
      probeCachePath?: string;
      /**
       * Called once per SELF-SCHEDULED loop iteration, contained — the lane cadence's entry
       * point (`lane-cadence.ts`). A hook, not an await: lane work runs detached, so a
       * minutes-long lane command can never delay an HTTP probe tick. ⚠ Deliberately NOT fired
       * from `tickOnce` itself: the admitted `GET /ping` route calls `tickOnce` directly, and
       * the request path must not be able to initiate lane work (the closeout audit of
       * 2026-08-30 caught exactly that leak) — only the timer loop advances the lane cadence.
       */
      onTick?: ((now: number) => void) | undefined;
      /**
       * The breaker, through `RateLimitRecoveryPort` (2026-09-15). Absent ⇒ a probe success
       * still retracts cooling FACTS as before and touches no breaker cooldown, and no cell is
       * re-probed for recovery — the pre-2026-09-15 behaviour exactly.
       */
      rateLimitRecovery?: RateLimitRecoveryPort | undefined;
    } = {},
  ) {}

  public getMode(): PingMode {
    return this.mode;
  }

  public getIntervalMs(): number {
    return this.intervalMs;
  }

  public setPingMode(nextMode: PingMode, source = "manual"): void {
    this.mode = nextMode;
    this.modeSource = source;
    this.intervalMs = PING_MODE_INTERVALS[nextMode];
    this.speedUntil = nextMode === "speed" ? Date.now() + SPEED_MODE_DURATION_MS : null;
    this.resumeSpeedOnActivity = source === "idle";
    if (this.timerObj) {
      clearTimeout(this.timerObj);
      this.timerObj = null;
    }
  }

  public noteUserActivity(): void {
    this.lastActivityAt = Date.now();
    if (this.mode === "forced") return;
    if (this.resumeSpeedOnActivity || this.mode === "slow") {
      this.setPingMode("speed", "activity");
    }
  }

  public refreshAutoPingMode(): void {
    const now = Date.now();
    if (this.mode === "forced") return;

    if (this.speedUntil && now >= this.speedUntil) {
      this.setPingMode("normal", "auto");
      return;
    }

    if (now - this.lastActivityAt >= IDLE_SLOW_AFTER_MS) {
      if (this.mode !== "slow") {
        this.setPingMode("slow", "idle");
      } else {
        this.resumeSpeedOnActivity = true;
      }
    }
  }

  public recordPing(
    providerKey: string,
    modelId: string,
    res: PingResult,
    timestamp = Date.now(),
    credentialId: CredentialId = makeCredentialId(providerKey),
  ): void {
    const key = `${providerKey}/${modelId}`;
    // Through the hydrating getter, so a fresh process appends to the history previous runs
    // built instead of starting a second, shorter one beside it.
    if (!this.pingHistory.has(key)) this.getModelPings(providerKey, modelId);
    let history = this.pingHistory.get(key);
    if (!history) {
      history = [];
      this.pingHistory.set(key, history);
    }
    history.push({ ms: res.ms, code: res.code, timestamp });
    if (history.length > 50) history.shift();

    const quotaKey = this.quotaKey(credentialId, modelId);
    this.latestQuota.set(
      quotaKey,
      mergeQuotaObservations(this.getQuotaObservations(credentialId, modelId), res.quotaObservations),
    );

    const parsedCredential = parseCredentialId(credentialId);
    const isDefaultProbe = parsedCredential?.provider === providerKey && parsedCredential.label === "default";
    // Probe cache has a deployment key, so only its real default-credential producer may attach
    // quota to it. Health samples are still shared deployment evidence for every call.
    recordProbeResult(providerKey, modelId, {
      ...res,
      quotaObservations: isDefaultProbe ? res.quotaObservations : [],
    }, this.probeCacheOpts());

    // A successful probe is a REAL completion — `ping.ts` posts one user message at
    // `max_tokens: 1` — sent with THIS credential slot, so it is the same first-party proof a
    // served request is: the deployment exists and the credential has allowance RIGHT NOW.
    // `server.ts` has always cleared cooling conditions on that evidence; until 2026-08-30 this
    // path did not, so `clearFacts` had exactly ONE caller and a long-window
    // `allowance-exhausted` fact survived its whole window unless real traffic happened to reach
    // the demoted candidate. Since the relay probes every deployment on a cadence anyway, that
    // made background recovery undetectable — the owner's stated expectation, and the reason a
    // week-long operator-asserted reset is safe to record at all.
    // ⚠ Measurements are never touched: `clearFacts` excludes them, because a success disproves
    // a condition and never a measurement.
    // ⚠ Unlike the served path this does NOT also clear the breaker's credential faults — those
    // carry their own 5-minute TTL, and the only breaker reach this loop has is the narrow
    // `rateLimitRecovery` port below.
    // ⚠ Contained: the fact store must never be able to break the probe loop.
    if (res.code === "200") {
      try {
        let costClass: CostClass | undefined;
        try {
          costClass = assessCost(modelId, this.catalog.cachedLimits?.(providerKey, modelId), this.cfg.providers[providerKey]?.tierType).costClass;
        } catch {
          costClass = undefined;
        }
        clearFacts(providerKey, credentialId, modelId, { costClass });
      } catch {
        /* best-effort */
      }
      // The same first-party proof, applied to the BREAKER's 429 cooldown (2026-09-15): a
      // deployment that just answered this credential is not rate-limiting it, whatever rung
      // the relay guessed. Exact cell only — `endRateLimitCooldown` keys by credential × model,
      // so a sibling credential's cooldown is untouched, and the port itself declines every
      // cooldown that did not come from a 429 (quota, elapsed, credential faults).
      try {
        this.opts.rateLimitRecovery?.endRateLimitCooldown({ credentialId, model: modelId }, timestamp);
      } catch {
        /* best-effort: a persistence failure inside the breaker must never break the probe loop */
      }
    }
  }

  /**
   * Re-probe cells cooling on a 429 rung the relay GUESSED, so a recovered deployment is not
   * parked for the rest of its escalation step (owner, 2026-09-10: *"The relay should be polling
   * to see if things start working again anyway."*). Without this the catalog cadence would reach
   * such a cell only at its 24 h TTL, which is longer than three of the four rungs.
   *
   * Bounded twice: one probe per cell per `RATE_LIMIT_REPROBE_INTERVAL_MS`, and at most
   * `MAX_RATE_LIMIT_REPROBES_PER_TICK` per tick, soonest-lifting cells first. The probe goes
   * through `recordPing`, so a 200 ends the cooldown through the port and a 429 records an
   * ordinary failed probe — it never reaches the breaker's escalation ladder, which counts what
   * REAL traffic saw. Only openai-kind deployments are probed, as the catalog cadence does; a
   * model-less cell (a passthrough) has nothing to probe. Contained per cell.
   */
  public async reprobeRateLimited(now = Date.now()): Promise<void> {
    const port = this.opts.rateLimitRecovery;
    if (!port) return;
    let cells: ReturnType<RateLimitRecoveryPort["rateLimitCoolingCells"]>;
    try {
      cells = port.rateLimitCoolingCells(now);
    } catch {
      return;
    }
    let spent = 0;
    for (const cell of cells) {
      if (spent >= MAX_RATE_LIMIT_REPROBES_PER_TICK) return;
      const due = this.reprobeTarget(cell, now);
      if (due === null) continue;
      // Stamped BEFORE the probe, so a hanging or failing probe is not re-asked every tick.
      this.rateLimitReprobedAt.set(due.key, now);
      spent += 1;
      try {
        const res = await pingProviderModel(cell.provider, due.model, due.pCfg, due.apiKey, {
          ...optsObj(this.opts.fetchFn),
          timeoutMs: due.pCfg.timeoutMs,
        });
        this.recordPing(cell.provider, due.model, res, Date.now(), due.credentialId);
      } catch {
        // Probe failure contained per cell.
      }
    }
  }

  /**
   * What `reprobeRateLimited` needs to probe one cooling cell, or null when the cell is not due
   * (probed within the interval), has no model, is not an openai-kind provider, or names no
   * enabled credential slot that allows the model and resolves to a key.
   */
  private reprobeTarget(
    cell: { provider: string; model: string | null; credentialId: string },
    now: number,
  ): { key: string; model: string; pCfg: ProviderConfig; apiKey: string | undefined; credentialId: CredentialId } | null {
    if (cell.model === null) return null;
    const model = cell.model;
    const pCfg = this.cfg.providers[cell.provider];
    if (!pCfg || pCfg.kind !== "openai") return null;
    const key = `${cell.credentialId}/${model}`;
    if (now - (this.rateLimitReprobedAt.get(key) ?? 0) < RATE_LIMIT_REPROBE_INTERVAL_MS) return null;
    const slot = providerCredentialSlots(cell.provider, pCfg).find(
      (s) => s.enabled && s.credentialId === cell.credentialId && slotAllowsModel(s, model),
    );
    if (!slot) return null;
    const resolution = resolveCredentialSlot(slot);
    if (resolution.state === "declared-missing") return null;
    return { key, model, pCfg, apiKey: resolution.value, credentialId: slot.credentialId };
  }

  /**
   * Record a REAL SERVED REQUEST's latency against a deployment, with the output-token count when
   * the provider reported one.
   *
   * Owner decision 2026-08-30: the latency signal reads the PROBE dataset, and the probe dataset
   * carries request samples too, so a per-token rate can come from actual traffic rather than from
   * a one-token probe.
   *
   * WARNING: this must never look like a probe. `recordRequestSample` leaves every
   * probe-scheduling field alone, and this method deliberately does NOT touch `latestQuota` or
   * the entry status either. A served request already reported its quota headers through the
   * request path's own observer; re-recording them here would double-count one observation.
   *
   * WARNING: tokens ABSENT means unknown, never zero. A sample with no token count still measures
   * absolute latency; it simply cannot contribute to the per-token statistic.
   */
  public recordRequestLatency(
    providerKey: string,
    modelId: string,
    sample: { ms: number; tokens?: number },
  ): void {
    if (typeof sample.ms !== "number" || !Number.isFinite(sample.ms) || sample.ms < 0) return;
    const key = providerKey + "/" + modelId;
    // Through the hydrating getter, so this process appends to the history previous runs built
    // instead of starting a second, shorter one beside it.
    if (!this.pingHistory.has(key)) this.getModelPings(providerKey, modelId);
    let history = this.pingHistory.get(key);
    if (!history) {
      history = [];
      this.pingHistory.set(key, history);
    }
    const record: PingRecord = { ms: sample.ms, code: "200", timestamp: Date.now(), source: "request" };
    if (typeof sample.tokens === "number" && Number.isFinite(sample.tokens) && sample.tokens > 0) {
      record.tokens = sample.tokens;
    }
    history.push(record);
    if (history.length > 50) history.shift();
    try {
      recordRequestSample(providerKey, modelId, sample, this.probeCacheOpts());
    } catch {
      // Persistence is best effort. A corrupt or unwritable cache must never affect a served
      // request, and the in-memory window above already carries the sample for this process.
    }
  }

  /**
   * Recent samples for a model — from memory, falling back to what previous runs persisted.
   *
   * ⚠ The fallback is the whole point. This used to read `pingHistory` alone, a Map built only
   * during the current process's life, while `recordProbeResult` wrote every probe to
   * `probe-cache.json` and nothing ever read it back. Every restart therefore reset every model
   * to `Pending` with `p95: -1`, so a proxy that restarts at all — a laptop that slept, an
   * upgrade, a crash — never accumulated latency history for anything. The disk is the long-term
   * record this is supposed to be keeping; memory is just the hot copy.
   *
   * ⚠ Since 2026-08-30 the window carries REQUEST samples beside probes (`source: "request"`, with
   * a token count). This is the seam `latency-demotion.ts` reads, which is exactly why the
   * fallback matters there too: without it the latency term would go inert after every restart.
   */
  public getModelPings(providerKey: string, modelId: string): PingRecord[] {
    const key = `${providerKey}/${modelId}`;
    const live = this.pingHistory.get(key);
    if (live && live.length > 0) return live;
    const persisted = this.readPersisted(providerKey, modelId);
    // Seed memory so the next call is hot and later probes append to the real history rather
    // than starting a second, shorter one beside it.
    if (persisted.length > 0) this.pingHistory.set(key, [...persisted]);
    return persisted;
  }

  private readPersisted(providerKey: string, modelId: string): PingRecord[] {
    try {
      return loadPersistedSamples(providerKey, modelId, this.probeCacheOpts());
    } catch {
      return []; // a corrupt or unreadable cache must never break the health surface
    }
  }

  private probeCacheOpts(): { path?: string } {
    return this.opts.probeCachePath ? { path: this.opts.probeCachePath } : {};
  }

  /**
   * Long-run uptime for a model across every probe ever recorded, or null if never probed.
   *
   * The rolling window answers "lately"; this answers "ever", and it is what keeps a model's
   * record from being erased by one bad afternoon inside the window.
   */
  public getLifetimeUptimePct(providerKey: string, modelId: string): number | null {
    try {
      const t = loadTotals(providerKey, modelId, this.probeCacheOpts());
      if (!t || t.probes === 0) return null;
      return Math.round((t.ok / t.probes) * 100);
    } catch {
      return null;
    }
  }

  /**
   * Returns quota only for its exact credential/model cell. A cold default cell may rehydrate
   * synthetic-probe observations from disk; another credential must never inherit that balance.
   */
  public getQuotaObservations(credentialId: CredentialId, modelId: string): QuotaObservation[] {
    const key = this.quotaKey(credentialId, modelId);
    const live = this.latestQuota.get(key);
    if (live) return [...live];

    const parsed = parseCredentialId(credentialId);
    if (!parsed || parsed.label !== "default") return [];
    try {
      const persisted = loadPersistedQuotaObservations(parsed.provider, modelId, this.probeCacheOpts());
      if (persisted.length > 0) this.latestQuota.set(key, persisted);
      return [...persisted];
    } catch {
      return [];
    }
  }

  private quotaKey(credentialId: CredentialId, modelId: string): string {
    return `${credentialId}/${modelId}`;
  }

  public getModelSummary(providerKey: string, modelId: string): ModelHealthSummary {
    const pings = this.getModelPings(providerKey, modelId);
    const avgMs = getAvg(pings);
    const p95Ms = getP95(pings);
    const jitterMs = getJitter(pings);
    const stabilityScore = getStabilityScore(pings);
    const uptimePct = getUptime(pings);
    const lastPing = pings[pings.length - 1];
    // ⚠ `isDown` is deliberately NOT passed. It used to be `lastPing.code !== "200"`, which made
    // the verdict a function of one sample: a single transient failure — a VPN the provider
    // blocks, a resumed laptop, one rate-limited probe — reported a model with fifty good samples
    // as `Not Active`/`Unstable`. `getVerdict` now derives down-ness from the accumulated record
    // (a RUN of failures AND poor uptime), which still catches a genuinely revoked key: that
    // answers 401 every time, so the run never breaks and uptime stays at 0.
    const verdict = getVerdict(pings, { httpCode: lastPing?.code ?? null });

    return {
      providerKey,
      modelId,
      avgMs: avgMs === Infinity ? -1 : avgMs,
      p95Ms: p95Ms === Infinity ? -1 : p95Ms,
      jitterMs,
      stabilityScore,
      uptimePct,
      verdict,
      lastPingCode: lastPing?.code ?? null,
      lastPingMs: lastPing?.ms ?? null,
    };
  }

  /**
   * Ask each provider for its stated spend headroom and feed the answer to `spend-headroom.ts`.
   *
   * Egress happens only where a provider actually publishes the figure — `fetchProviderQuota`
   * fetches for an OpenRouter base and no-ops for everyone else — so this walk costs nothing for
   * a config with no such provider. One ask per credential slot per SPEND_POLL_INTERVAL_MS; the
   * gate is stamped before the fetch so a failing endpoint is not re-asked every tick. A failed
   * or unparseable answer applies nothing in either direction (`unknown` has no effect), and any
   * throw is contained: a health poll must never break the ping loop.
   */
  public async pollSpendHeadroom(now = Date.now()): Promise<void> {
    for (const [providerName, pCfg] of Object.entries(this.cfg.providers) as Array<[string, ProviderConfig]>) {
      for (const slot of providerCredentialSlots(providerName, pCfg)) {
        if (!slot.enabled) continue;
        const last = this.spendPolledAt.get(slot.credentialId) ?? 0;
        if (now - last < SPEND_POLL_INTERVAL_MS) continue;
        this.spendPolledAt.set(slot.credentialId, now);
        await this.pollSlotSpendHeadroom(providerName, pCfg, slot, now);
      }
    }
  }

  private async pollSlotSpendHeadroom(
    providerName: string,
    pCfg: ProviderConfig,
    slot: ReturnType<typeof providerCredentialSlots>[number],
    now: number,
  ): Promise<void> {
    try {
      const resolution = resolveCredentialSlot(slot);
      if (resolution.state === "declared-missing") return;
      const info = await fetchProviderQuota(providerName, pCfg, resolution.value, this.opts.fetchFn ?? fetch);
      if (!info.ok) return;
      applySpendHeadroom(providerName, slot.credentialId, classifySpendHeadroom(info), { now });
    } catch {
      // Best effort: the statement is re-asked on the next due tick.
    }
  }

  public async tickOnce(scope: "catalog" | "routable" = "catalog"): Promise<void> {
    this.refreshAutoPingMode();
    await this.pollSpendHeadroom().catch(() => {});
    // HTTP probe work, so it belongs in `tickOnce` beside the spend poll (unlike the lane hook,
    // which only the self-scheduled loop may fire): a GET /ping that re-tests a cooling cell
    // spends one bounded probe, never a lane.
    await this.reprobeRateLimited().catch(() => {});
    if (scope === "routable") materializeDynamicPools(this.cfg, this.catalog);
    const providers = Object.entries(this.cfg.providers) as Array<[string, ProviderConfig]>;
    const beforeRefresh = scope === "routable" ? collectRoutableModels(this.cfg) : null;
    const hasDynamicPools = Object.keys(this.cfg.routing.poolPolicies ?? {}).length > 0;
    const listedByProvider = new Map<string, string[]>();

    // Refresh each relevant provider once and in parallel. Dynamic contributors still need their
    // catalog refreshed when a cold cache has no routable members yet; only the resulting
    // materialized members are probed.
    await Promise.all(providers.map(async ([providerName, pCfg]) => {
      const contributesDynamic = hasDynamicPools &&
        (pCfg.tierType === "free" || pCfg.tierType === "mixed");
      if (scope === "routable" && !beforeRefresh?.has(providerName) && !contributesDynamic) return;
      try {
        listedByProvider.set(
          providerName,
          await this.catalog.list(providerName, pCfg, optsObj(this.opts.fetchFn)),
        );
      } catch {
        listedByProvider.set(providerName, []);
      }
    }));

    if (scope === "routable") materializeDynamicPools(this.cfg, this.catalog);
    const routable = scope === "routable" ? collectRoutableModels(this.cfg) : null;
    const telemetry = loadRuntimeTelemetry();

    await Promise.allSettled(providers.map(async ([providerName, pCfg]) => {
      const modelIds = scope === "catalog"
        ? listedByProvider.get(providerName) ?? []
        : routable?.get(providerName) ?? [];

      if (modelIds.length === 0) return;

      // Same cache the results are written to and hydrated from. `probe-cache.ts` keeps a
      // module-level cache keyed by the last path it was given, so a call that omits the path
      // reads whatever another caller last loaded — here that meant asking a different cache
      // whether a model was due, concluding it was not, and probing nothing at all.
      const dueIds = getModelsDueForProbe(providerName, modelIds, {
        ...this.probeCacheOpts(),
        lastSuccessfulCallAt: (modelId) => getLastSuccessfulCallAt(providerName, modelId, { telemetry }),
      });
      // Probe up to 3 due models per provider per tick to avoid flooding
      const toProbe = dueIds.slice(0, 3);
      const slots = providerCredentialSlots(providerName, pCfg).filter((slot) => slot.enabled);
      let slotCursor = this.credentialCursors.get(providerName) ?? 0;

      for (const mId of toProbe) {
        // Credential rotation is inside the existing model probe budget: a provider with three
        // due deployments still spends at most three requests, while successive deployments use
        // successive serviceable slots. Health remains keyed to provider/model; quota evidence is
        // recorded against the exact credential that made this request.
        let selected: ReturnType<typeof resolveCredentialSlot> | undefined;
        let selectedSlot: (typeof slots)[number] | undefined;
        for (let i = 0; i < slots.length; i++) {
          const slotIndex = (slotCursor + i) % slots.length;
          const slot = slots[slotIndex];
          if (!slot || !slotAllowsModel(slot, mId)) continue;
          const resolution = resolveCredentialSlot(slot);
          if (resolution.state === "declared-missing") continue;
          selected = resolution;
          selectedSlot = slot;
          slotCursor = (slotIndex + 1) % Math.max(1, slots.length);
          break;
        }
        if (!selected || !selectedSlot) continue;
        this.credentialCursors.set(providerName, slotCursor);
        try {
          const res = await pingProviderModel(providerName, mId, pCfg, selected.value, {
            ...optsObj(this.opts.fetchFn),
            timeoutMs: pCfg.timeoutMs,
          });
          this.recordPing(providerName, mId, res, Date.now(), selectedSlot.credentialId);
        } catch {
          // Probe failure contained per model
        }
      }
    }));
  }

  public start(): void {
    if (this.running) return;
    this.running = true;

    const loop = async () => {
      if (!this.running) return;
      // The lane-cadence hook fires HERE and only here — see the `onTick` option doc: a direct
      // `tickOnce` caller (the admitted GET /ping) must never be able to initiate lane work.
      try {
        this.opts.onTick?.(Date.now());
      } catch {
        // Contained: a tick hook must never break the ping loop.
      }
      await this.tickOnce("routable").catch(() => {});
      if (this.running) {
        this.timerObj = setTimeout(loop, this.intervalMs);
      }
    };

    void loop();
  }

  public stop(): void {
    this.running = false;
    if (this.timerObj) {
      clearTimeout(this.timerObj);
      this.timerObj = null;
    }
  }
}

function optsObj(fetchFn?: typeof fetch): { fetchFn?: typeof fetch } {
  return fetchFn ? { fetchFn } : {};
}
