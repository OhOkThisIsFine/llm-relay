/**
 * The background lane cadence — the relay's own re-probe loop for `cli` lanes.
 *
 * Owner decision 2026-08-29 (docs/quota-reprobe-design-2026-08-29.md): keeping lane metadata
 * fresh is the relay's job, the way `PingLoop` already keeps HTTP health fresh — not a host
 * scheduled task's, and never the nightly maintenance run's (that belongs to another repo).
 * This closes the property the backlog demanded: a recorded quota death either expires on a
 * clock the relay enforces, or the probe that disproves it retracts it. No lane stays parked
 * on a stale record.
 *
 * Two kinds of work, both gated, both cheap to SKIP (the common case is two map reads):
 * - CATALOG re-probes (`probeLanes`) refresh rosters so `verifyModel`'s eviction evidence stays
 *   fresh. Metadata commands — no quota spent — on a long per-run gate.
 * - QUOTA probes (`lane-quota-probe.ts`) re-test ONLY buckets carrying an ACTIVE recorded death.
 *   An alive lane is re-tested by real use for free, so probing it would spend quota for
 *   nothing; a dead bucket is probed once per `quotaIntervalMs` until a real answer retracts
 *   the death or the death expires. A bucket first seen dead is STAMPED, not probed — the
 *   reporter just proved it dead seconds ago, and an immediate re-probe would re-spend quota on
 *   the freshest evidence in the system.
 *
 * Discipline inherited from the modules around it:
 * - `poke()` is fire-and-forget and re-entrant-safe: the ping tick must never wait on a lane
 *   command (a probe can take minutes), so work runs behind an in-flight latch and every error
 *   is contained (`pollSpendHeadroom`'s rule: a health poll must never break the loop).
 * - Probes run SEQUENTIALLY — one lane command at a time, predictable load.
 * - Under vitest nothing spawns unless BOTH seams are injected (the `winenv.ts` guard).
 * - The request path never spawns a lane; this loop and the operator CLI probe are the only two
 *   spawn sites (`lane-probe.ts` header).
 */
import { DEFAULT_LANE_PROBE, type Config, type LaneProbeSettings } from "./config.js";
import {
  clearExhaustedKey,
  exportExhaustedRows,
  markExhaustedKey,
  OUTCOME_DEFAULT_MS,
} from "./dispatch.js";
import { loadLaneManifest, DEFAULT_MANIFEST_PATH } from "./lane-manifest.js";
import { laneCommands, probeLanes, type LaneProbeResult } from "./lane-probe.js";
import {
  defaultLaneProbeSpawner,
  laneQuotaTargets,
  runLaneQuotaProbe,
  type LaneProbeSpawner,
  type LaneQuotaVerdict,
} from "./lane-quota-probe.js";

export interface LaneCadenceOptions {
  /** Injected under test; the real spawner refuses to run under vitest. */
  spawn?: LaneProbeSpawner | undefined;
  /** Injected under test so no real lane tool runs for catalog refreshes. */
  probeLanesFn?: ((cfg: Config, path: string) => Promise<LaneProbeResult[]>) | undefined;
  manifestPath?: string | undefined;
  /** Injected clock for tests; production reads Date.now. */
  now?: (() => number) | undefined;
}

/** One quota-probe outcome, kept only for `llm-relay`-side reporting/tests — never logged with content. */
export interface LaneQuotaProbeRecord {
  key: string;
  lane: string;
  verdict: LaneQuotaVerdict;
  at: number;
}

export class LaneCadence {
  private inFlight: Promise<void> | null = null;
  private lastCatalogRunAt = 0;
  private quotaAttemptAt = new Map<string, number>();
  private lastQuotaRecords: LaneQuotaProbeRecord[] = [];

  constructor(
    private cfg: Config,
    private opts: LaneCadenceOptions = {},
  ) {}

  private settings(): LaneProbeSettings {
    return this.cfg.routing.laneProbe ?? DEFAULT_LANE_PROBE;
  }

  private clock(): number {
    return (this.opts.now ?? Date.now)();
  }

  /** The last completed quota-probe batch, newest run only. */
  public lastQuotaProbes(): readonly LaneQuotaProbeRecord[] {
    return this.lastQuotaRecords;
  }

  /** Awaits the in-flight run, if any — a test seam; production never waits on lane work. */
  public async settle(): Promise<void> {
    while (this.inFlight) await this.inFlight;
  }

  /**
   * Called from the ping tick. Never throws, never blocks: decides cheaply whether anything is
   * due and runs the due work detached behind the in-flight latch.
   */
  public poke(now: number = this.clock()): void {
    try {
      if (!this.settings().enabled) return;
      if (this.inFlight) return;
      // ⚠ Under vitest, never reach the real spawner/prober by default — a suite must not spend
      // real lane quota. Tests inject both seams.
      if (process.env.VITEST && (!this.opts.spawn || !this.opts.probeLanesFn)) return;
      const catalogDue = this.catalogDue(now);
      const quotaDue = this.quotaDue(now);
      if (!catalogDue && quotaDue.length === 0) return;
      const run = this.run(catalogDue, quotaDue, now)
        .catch(() => {
          /* contained: a probe failure must never break the ping loop */
        })
        .finally(() => {
          this.inFlight = null;
        });
      this.inFlight = run;
    } catch {
      /* contained */
    }
  }

  private catalogDue(now: number): boolean {
    const settings = this.settings();
    if (now - this.lastCatalogRunAt < settings.catalogIntervalMs) return false;
    const lanes = laneCommands(this.cfg);
    if (lanes.size === 0) return false;
    const manifest = loadLaneManifest(this.manifestPath());
    for (const lane of lanes.keys()) {
      const entry = manifest?.lanes[lane];
      if (!entry) return true;
      const probed = Date.parse(entry.probedAt);
      if (!Number.isFinite(probed) || now - probed >= settings.catalogIntervalMs) return true;
    }
    return false;
  }

  /**
   * Dead buckets whose probe gate has lapsed. A bucket seen dead for the FIRST time is stamped
   * and skipped — its death was just reported, and the report IS fresh evidence.
   */
  private quotaDue(now: number): string[] {
    const settings = this.settings();
    const dead = new Set(exportExhaustedRows(this.cfg, now).map((row) => row.key));
    // Forget stamps for buckets no longer dead, so a lane that dies again later defers again.
    for (const key of this.quotaAttemptAt.keys()) {
      if (!dead.has(key)) this.quotaAttemptAt.delete(key);
    }
    const due: string[] = [];
    for (const key of dead) {
      const stamp = this.quotaAttemptAt.get(key);
      if (stamp === undefined) {
        this.quotaAttemptAt.set(key, now);
        continue;
      }
      if (now - stamp >= settings.quotaIntervalMs) due.push(key);
    }
    return due;
  }

  private manifestPath(): string {
    return this.opts.manifestPath ?? DEFAULT_MANIFEST_PATH;
  }

  private async run(catalogDue: boolean, quotaDueKeys: string[], startedAt: number): Promise<void> {
    if (catalogDue) {
      this.lastCatalogRunAt = startedAt;
      const probe = this.opts.probeLanesFn ?? probeLanes;
      try {
        await probe(this.cfg, this.manifestPath());
      } catch {
        /* a failed catalog probe retries after the next full interval; the old roster stands */
      }
    }
    if (quotaDueKeys.length === 0) return;
    const spawn = this.opts.spawn ?? defaultLaneProbeSpawner;
    const targets = new Map(laneQuotaTargets(this.cfg).map((t) => [t.key, t] as const));
    const records: LaneQuotaProbeRecord[] = [];
    for (const key of quotaDueKeys) {
      const target = targets.get(key);
      if (!target) continue; // the config no longer names this bucket — its row expires on its own
      const now = this.clock();
      // Stamp BEFORE the spawn (`pollSpendHeadroom`'s rule) so a hanging tool is not re-asked
      // every tick.
      this.quotaAttemptAt.set(key, now);
      try {
        const { verdict } = await runLaneQuotaProbe(target, { spawn });
        records.push({ key, lane: target.lane, verdict, at: now });
        if (verdict.kind === "alive") {
          // A real answer disproves the recorded death — the whole point of the cadence.
          clearExhaustedKey(this.cfg, key);
          this.quotaAttemptAt.delete(key);
        } else if (verdict.kind === "exhausted") {
          const ttl = verdict.retryAfterMs ?? OUTCOME_DEFAULT_MS[verdict.outcome];
          markExhaustedKey(this.cfg, key, now + ttl, now);
        }
        // inconclusive: change NOTHING — the recorded death stands until its own expiry.
      } catch {
        /* contained per probe; the next gate retries */
      }
    }
    if (records.length > 0) this.lastQuotaRecords = records;
  }
}
