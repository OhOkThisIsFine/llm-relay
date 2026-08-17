import type { Config, ProviderConfig } from "../config.js";
import type { ModelCatalog } from "../catalog.js";
import { pingProviderModel, type PingResult } from "./ping.js";
import { type PingRecord, getAvg, getP95, getJitter, getStabilityScore, getVerdict, getUptime } from "./metrics.js";
import {
  recordProbeResult,
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

export type PingMode = "speed" | "normal" | "slow" | "forced";

export const PING_MODE_INTERVALS: Record<PingMode, number> = {
  speed: 2000,
  normal: 10000,
  slow: 30000,
  forced: 4000,
};

export const SPEED_MODE_DURATION_MS = 60000; // 60s
export const IDLE_SLOW_AFTER_MS = 300000; // 5 min

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

  constructor(
    private cfg: Config,
    private catalog: ModelCatalog,
    private opts: { fetchFn?: typeof fetch; autoStart?: boolean; probeCachePath?: string } = {},
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
  }

  /**
   * Recent probes for a model — from memory, falling back to what previous runs persisted.
   *
   * ⚠ The fallback is the whole point. This used to read `pingHistory` alone, a Map built only
   * during the current process's life, while `recordProbeResult` wrote every probe to
   * `probe-cache.json` and nothing ever read it back. Every restart therefore reset every model
   * to `Pending` with `p95: -1`, so a proxy that restarts at all — a laptop that slept, an
   * upgrade, a crash — never accumulated latency history for anything. The disk is the long-term
   * record this is supposed to be keeping; memory is just the hot copy.
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

  public async tickOnce(scope: "catalog" | "routable" = "catalog"): Promise<void> {
    this.refreshAutoPingMode();
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

    for (const [providerName, pCfg] of providers) {
      const modelIds = scope === "catalog"
        ? listedByProvider.get(providerName) ?? []
        : routable?.get(providerName) ?? [];

      if (modelIds.length === 0) continue;

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
        const res = await pingProviderModel(providerName, mId, pCfg, selected.value, {
          ...optsObj(this.opts.fetchFn),
          timeoutMs: pCfg.timeoutMs,
        });
        this.recordPing(providerName, mId, res, Date.now(), selectedSlot.credentialId);
      }
    }
  }

  public start(): void {
    if (this.running) return;
    this.running = true;

    const loop = async () => {
      if (!this.running) return;
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
