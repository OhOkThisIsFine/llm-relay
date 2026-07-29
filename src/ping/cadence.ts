import type { Config, ProviderConfig } from "../config.js";
import type { ModelCatalog } from "../catalog.js";
import { pingProviderModel, type PingResult } from "./ping.js";
import { type PingRecord, getAvg, getP95, getJitter, getStabilityScore, getVerdict, getUptime } from "./metrics.js";
import { recordProbeResult, getModelsDueForProbe } from "./probe-cache.js";
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
    private opts: { fetchFn?: typeof fetch; autoStart?: boolean } = {},
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

    recordProbeResult(providerKey, modelId, res);
  }

  public getModelPings(providerKey: string, modelId: string): PingRecord[] {
    return this.pingHistory.get(`${providerKey}/${modelId}`) ?? [];
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
    // A 401 is DOWN. It was excluded here alongside 200 on the theory that the endpoint
    // answered, but this flag is the availability verdict: a provider with a revoked key
    // reported "Perfect" and could be preferred over a working one. `getUptime()` already
    // counts only "200" — this is the signal that disagreed with it.
    const verdict = getVerdict(pings, {
      httpCode: lastPing?.code ?? null,
      isDown: lastPing ? lastPing.code !== "200" : false,
    });

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

      const dueIds = getModelsDueForProbe(providerName, modelIds);
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

