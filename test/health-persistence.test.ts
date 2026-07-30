import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, existsSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  recordProbeResult,
  loadPersistedSamples,
  loadTotals,
  persistedModels,
  getModelsDueForProbe,
  loadProbeCache,
  getProbeCachePath,
  MAX_SAMPLES,
  CURRENT_PROBE_VERSION,
} from "../src/ping/probe-cache.js";
import { getVerdict, isPersistentlyDown, trailingFailures, getP95, type PingRecord } from "../src/ping/metrics.js";
import { PingLoop } from "../src/ping/cadence.js";
import { ModelCatalog } from "../src/catalog.js";
import type { Config } from "../src/config.js";

/**
 * Long-term health metadata, and not disqualifying a model over a bad moment.
 *
 * Two defects these pin, both found by asking why a live relay reported `verdict: Pending` and
 * `p95: -` for every model it had been probing for days:
 *
 *  1. `PingLoop` kept ping history in an in-memory Map and read ONLY that, while
 *     `recordProbeResult` wrote every probe to disk and nothing ever read it back. Every restart
 *     reset every model to zero samples — so a proxy that restarts at all (a laptop that slept,
 *     an upgrade, a crash) accumulated nothing, ever.
 *  2. A `ProbeEntry` held ONE sample (`ms`, `code`). p95, jitter and spike rate are distribution
 *     statistics, so with a single point every one of them was a restatement of the most recent
 *     request — "single probe samples of anything".
 */

let dir: string;
let cachePath: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "llm-relay-probe-"));
  cachePath = join(dir, "probe-cache.json");
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

describe("probe cache keeps a HISTORY, not one sample", () => {
  it("accumulates samples across probes", () => {
    for (const ms of [100, 200, 300]) {
      recordProbeResult("p", "m", { code: "200", ms, quotaPercent: null }, { path: cachePath });
    }
    const samples = loadPersistedSamples("p", "m", { path: cachePath });
    expect(samples.map((s) => s.ms)).toEqual([100, 200, 300]);
    // With a distribution, p95 is a real statistic rather than "the last request".
    expect(getP95(samples)).toBe(300);
  });

  it("bounds the window, dropping oldest first", () => {
    for (let i = 0; i < MAX_SAMPLES + 10; i++) {
      recordProbeResult("p", "m", { code: "200", ms: i, quotaPercent: null }, { path: cachePath });
    }
    const samples = loadPersistedSamples("p", "m", { path: cachePath });
    expect(samples).toHaveLength(MAX_SAMPLES);
    expect(samples[0]!.ms).toBe(10); // 0..9 aged out
    expect(samples[samples.length - 1]!.ms).toBe(MAX_SAMPLES + 9);
  });

  it("keeps lifetime totals that OUTLIVE the window", () => {
    // The window says "lately"; totals say "ever". Without them, one bad afternoon inside the
    // window erases a model's whole record.
    for (let i = 0; i < MAX_SAMPLES + 5; i++) {
      recordProbeResult("p", "m", { code: i < 2 ? "500" : "200", ms: 10, quotaPercent: null }, { path: cachePath });
    }
    const t = loadTotals("p", "m", { path: cachePath })!;
    expect(t.probes).toBe(MAX_SAMPLES + 5);
    expect(t.ok).toBe(MAX_SAMPLES + 3);
    // The two failures have aged out of the window but are still counted.
    expect(loadPersistedSamples("p", "m", { path: cachePath }).every((s) => s.code === "200")).toBe(true);
  });

  it("enumerates every persisted model, which is what a restarting loop rehydrates", () => {
    recordProbeResult("a", "m1", { code: "200", ms: 1, quotaPercent: null }, { path: cachePath });
    recordProbeResult("b", "m2", { code: "200", ms: 1, quotaPercent: null }, { path: cachePath });
    expect(persistedModels({ path: cachePath })).toEqual(
      expect.arrayContaining([{ provider: "a", model: "m1" }, { provider: "b", model: "m2" }]),
    );
  });

  it("marks a v1 single-sample entry as due, so old caches refill instead of needing migration", () => {
    recordProbeResult("p", "m", { code: "200", ms: 5, quotaPercent: null }, { path: cachePath, probeVersion: 1 });
    expect(getModelsDueForProbe("p", ["m"], { path: cachePath, probeVersion: CURRENT_PROBE_VERSION })).toContain("m");
  });
});

describe("PingLoop rehydrates from disk", () => {
  const cfg = { providers: {}, routing: { default: "x", tiers: {} } } as unknown as Config;

  it("a fresh process sees the history previous runs recorded", () => {
    for (const ms of [50, 60, 70]) {
      recordProbeResult("p", "m", { code: "200", ms, quotaPercent: null }, { path: cachePath });
    }
    // A brand-new loop, as after a restart — nothing in memory.
    const loop = new PingLoop(cfg, new ModelCatalog({ cachePath: null }), { probeCachePath: cachePath });
    const pings = loop.getModelPings("p", "m");
    expect(pings.map((p) => p.ms)).toEqual([50, 60, 70]);

    // And the summary is real rather than `Pending` with p95 -1.
    const s = loop.getModelSummary("p", "m");
    expect(s.verdict).not.toBe("Pending");
    expect(s.p95Ms).toBeGreaterThan(0);
    expect(s.uptimePct).toBe(100);
  });

  it("appends to the persisted history rather than starting a second one beside it", () => {
    recordProbeResult("p", "m", { code: "200", ms: 10, quotaPercent: null }, { path: cachePath });
    const loop = new PingLoop(cfg, new ModelCatalog({ cachePath: null }), { probeCachePath: cachePath });
    loop.recordPing("p", "m", { ms: 20, code: "200", quotaPercent: null } as never);
    expect(loop.getModelPings("p", "m").map((p) => p.ms)).toEqual([10, 20]);
  });

  it("reports lifetime uptime across every probe ever recorded", () => {
    recordProbeResult("p", "m", { code: "500", ms: 10, quotaPercent: null }, { path: cachePath });
    for (let i = 0; i < 3; i++) {
      recordProbeResult("p", "m", { code: "200", ms: 10, quotaPercent: null }, { path: cachePath });
    }
    const loop = new PingLoop(cfg, new ModelCatalog({ cachePath: null }), { probeCachePath: cachePath });
    expect(loop.getLifetimeUptimePct("p", "m")).toBe(75);
    expect(loop.getLifetimeUptimePct("p", "never-probed")).toBeNull(); // null = unknown, not 0
  });
});

describe("transient failures do not disqualify a model", () => {
  const ok = (n: number): PingRecord[] =>
    Array.from({ length: n }, (_, i) => ({ ms: 100, code: "200", timestamp: i }));

  it("one blip among a good record is not down", () => {
    // A VPN the provider blocks, a resumed laptop, one rate-limited probe. The old logic read
    // `isDown: lastPing.code !== "200"` and reported this model as Unstable.
    const pings = [...ok(20), { ms: 0, code: "503", timestamp: 99 }];
    expect(isPersistentlyDown(pings)).toBe(false);
    expect(getVerdict(pings)).not.toBe("Not Active");
    expect(getVerdict(pings)).not.toBe("Unstable");
  });

  it("even three consecutive blips do not disqualify a model with a strong record", () => {
    const pings = [...ok(30), ...[1, 2, 3].map((i) => ({ ms: 0, code: "503", timestamp: 100 + i }))];
    expect(trailingFailures(pings)).toBe(3);
    expect(isPersistentlyDown(pings)).toBe(false); // uptime still ~91%
  });

  it("a genuinely revoked key IS caught — it never answers 200, so the run never breaks", () => {
    const pings: PingRecord[] = Array.from({ length: 6 }, (_, i) => ({ ms: 120, code: "401", timestamp: i }));
    expect(isPersistentlyDown(pings)).toBe(true);
    expect(getVerdict(pings)).toBe("Not Active");
  });

  it("a model that was healthy and has now genuinely failed reads Unstable, not Not Active", () => {
    const pings = [...ok(3), ...Array.from({ length: 8 }, (_, i) => ({ ms: 0, code: "500", timestamp: 50 + i }))];
    expect(isPersistentlyDown(pings)).toBe(true);
    expect(getVerdict(pings)).toBe("Unstable");
  });

  it("a single 429 does not brand a healthy model Overloaded", () => {
    expect(getVerdict(ok(10), { httpCode: "429" })).not.toBe("Overloaded");
    const rateLimited = [...ok(5), { ms: 50, code: "429", timestamp: 90 }];
    expect(getVerdict(rateLimited, { httpCode: "429" })).toBe("Overloaded");
  });
});

describe("the suite never writes the developer's real probe cache", () => {
  it("resolves to a temp path under vitest", () => {
    // The user's real cache was found holding `openai_mock` / `mock-model-a` entries written by
    // this suite — test fixtures polluting live health data the router then ranks on.
    const p = getProbeCachePath();
    expect(p.startsWith(tmpdir())).toBe(true);
    expect(p).not.toContain(".llm-relay");
  });

  it("a default-path write lands in temp, not the home directory", () => {
    // Point the module's cached path back at the default before writing — earlier tests in this
    // file pass an explicit `path`, and that is remembered process-wide.
    loadProbeCache({ path: getProbeCachePath() });
    recordProbeResult("vitest_probe", "m", { code: "200", ms: 1, quotaPercent: null });

    expect(loadProbeCache({ path: getProbeCachePath() }).providers.vitest_probe).toBeDefined();

    const real = join(process.env.USERPROFILE ?? process.env.HOME ?? "", ".llm-relay", "probe-cache.json");
    if (existsSync(real)) {
      expect(readFileSync(real, "utf8")).not.toContain("vitest_probe");
    }
  });
});
