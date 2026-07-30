import type { Config, ProviderConfig } from "../config.js";
import type { ModelCatalog } from "../catalog.js";
import { pingProviderModel, type PingResult } from "./ping.js";
import { type PingRecord, getAvg, getP95, getJitter, getStabilityScore, getVerdict, getUptime } from "./metrics.js";
import { recordProbeResult, getModelsDueForProbe, loadPersistedSamples, loadTotals } from "./probe-cache.js";
import { readCredential } from "../authEnv.js";

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
  quotaPercent: number | null;
  lastPingCode: string | null;
  lastPingMs: number | null;
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
  private latestQuota = new Map<string, number | null>();

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

  public recordPing(providerKey: string, modelId: string, res: PingResult, timestamp = Date.now()): void {
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

    if (res.quotaPercent !== null) {
      this.latestQuota.set(providerKey, res.quotaPercent);
    }

    recordProbeResult(providerKey, modelId, res, this.probeCacheOpts());
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

  public getProviderQuota(providerKey: string): number | null {
    return this.latestQuota.get(providerKey) ?? null;
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
      quotaPercent: this.getProviderQuota(providerKey),
      lastPingCode: lastPing?.code ?? null,
      lastPingMs: lastPing?.ms ?? null,
    };
  }

  public async tickOnce(): Promise<void> {
    this.refreshAutoPingMode();

    for (const [providerName, pCfg] of Object.entries(this.cfg.providers) as Array<[string, ProviderConfig]>) {
      // Via the shared reader, not `process.env[...]` — a whitespace-only value is absent,
      // and open-coding the presence test is what let three call sites drift apart.
      const apiKey = readCredential(pCfg.authEnv);
      let modelIds: string[] = [];

      try {
        modelIds = await this.catalog.list(providerName, pCfg, optsObj(this.opts.fetchFn));
      } catch {}

      if (modelIds.length === 0) continue;

      // Same cache the results are written to and hydrated from. `probe-cache.ts` keeps a
      // module-level cache keyed by the last path it was given, so a call that omits the path
      // reads whatever another caller last loaded — here that meant asking a different cache
      // whether a model was due, concluding it was not, and probing nothing at all.
      const dueIds = getModelsDueForProbe(providerName, modelIds, this.probeCacheOpts());
      // Probe up to 3 due models per provider per tick to avoid flooding
      const toProbe = dueIds.slice(0, 3);

      for (const mId of toProbe) {
        const res = await pingProviderModel(providerName, mId, pCfg, apiKey, {
          ...optsObj(this.opts.fetchFn),
          ...(pCfg.timeoutMs !== undefined ? { timeoutMs: pCfg.timeoutMs } : {}),
        });
        this.recordPing(providerName, mId, res);
      }
    }
  }

  public start(): void {
    if (this.running) return;
    this.running = true;

    const loop = async () => {
      if (!this.running) return;
      await this.tickOnce().catch(() => {});
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

