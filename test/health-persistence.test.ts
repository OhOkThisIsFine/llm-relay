import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  recordProbeResult,
  loadPersistedSamples,
  loadTotals,
  loadPersistedQuotaObservations,
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
import { makeCredentialId } from "../src/credential-id.js";

const noQuota = { quotaObservations: [] };
const emptyConfig = { providers: {}, routing: { default: "x", tiers: {} } } as unknown as Config;

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
      recordProbeResult("p", "m", { code: "200", ms, ...noQuota }, { path: cachePath });
    }
    const samples = loadPersistedSamples("p", "m", { path: cachePath });
    expect(samples.map((s) => s.ms)).toEqual([100, 200, 300]);
    // With a distribution, p95 is a real statistic rather than "the last request".
    expect(getP95(samples)).toBe(300);
  });

  it("bounds the window, dropping oldest first", () => {
    for (let i = 0; i < MAX_SAMPLES + 10; i++) {
      recordProbeResult("p", "m", { code: "200", ms: i, ...noQuota }, { path: cachePath });
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
      recordProbeResult("p", "m", { code: i < 2 ? "500" : "200", ms: 10, ...noQuota }, { path: cachePath });
    }
    const t = loadTotals("p", "m", { path: cachePath })!;
    expect(t.probes).toBe(MAX_SAMPLES + 5);
    expect(t.ok).toBe(MAX_SAMPLES + 3);
    // The two failures have aged out of the window but are still counted.
    expect(loadPersistedSamples("p", "m", { path: cachePath }).every((s) => s.code === "200")).toBe(true);
  });

  it("enumerates every persisted model, which is what a restarting loop rehydrates", () => {
    recordProbeResult("a", "m1", { code: "200", ms: 1, ...noQuota }, { path: cachePath });
    recordProbeResult("b", "m2", { code: "200", ms: 1, ...noQuota }, { path: cachePath });
    expect(persistedModels({ path: cachePath })).toEqual(
      expect.arrayContaining([{ provider: "a", model: "m1" }, { provider: "b", model: "m2" }]),
    );
  });

  it("marks a v1 single-sample entry as due, so old caches refill instead of needing migration", () => {
    recordProbeResult("p", "m", { code: "200", ms: 5, ...noQuota }, { path: cachePath, probeVersion: 1 });
    expect(getModelsDueForProbe("p", ["m"], { path: cachePath, probeVersion: CURRENT_PROBE_VERSION })).toContain("m");
  });

  it("ignores v2 scalar quota and makes the old entry due", () => {
    writeFileSync(cachePath, JSON.stringify({
      version: 2,
      providers: {
        p: {
          models: {
            m: {
              modelId: "m",
              status: "ok",
              lastProbedAt: Date.now(),
              probeVersion: 2,
              ms: 5,
              code: "200",
              quotaPercent: 73,
            },
          },
        },
      },
    }), "utf8");
    loadProbeCache({ path: cachePath, reload: true });

    expect(loadPersistedQuotaObservations("p", "m", { path: cachePath })).toEqual([]);
    expect(getModelsDueForProbe("p", ["m"], { path: cachePath })).toEqual(["m"]);
  });

  it("persists and merges typed quota axes without a scalar", () => {
    const requestsDay = [{
      axis: "requests" as const,
      period: "day" as const,
      limit: 100,
      remaining: 25,
      resetsAt: null,
      observedAt: 1,
      basis: "provider-stated" as const,
    }];
    const tokensMinute = [{
      axis: "tokens" as const,
      period: "minute" as const,
      limit: 1000,
      remaining: 800,
      resetsAt: null,
      observedAt: 2,
      basis: "provider-stated" as const,
    }];
    const now = Date.now();
    recordProbeResult("p", "m", { code: "200", ms: 5, quotaObservations: requestsDay }, { path: cachePath, now });
    recordProbeResult("p", "m", { code: "200", ms: 6, quotaObservations: tokensMinute }, { path: cachePath, now: now + 1 });

    const persisted = loadPersistedQuotaObservations("p", "m", { path: cachePath });
    expect(persisted).toEqual([...requestsDay, ...tokensMinute]);
    expect(readFileSync(cachePath, "utf8")).not.toContain("quotaPercent");
    // A current v3 record is still fresh for probe scheduling, but a restarted surface must be
    // able to read its quota immediately rather than losing it until the 24h TTL expires.
    expect(getModelsDueForProbe("p", ["m"], { path: cachePath, now: now + 1 })).toEqual([]);
    const loop = new PingLoop(emptyConfig, new ModelCatalog({ cachePath: null }), { probeCachePath: cachePath });
    expect(loop.getQuotaObservations(makeCredentialId("p"), "m")).toEqual(persisted);
    expect(loop.getQuotaObservations(makeCredentialId("p", "work"), "m")).toEqual([]);
  });
});

describe("PingLoop rehydrates from disk", () => {
  const cfg = { providers: {}, routing: { default: "x", tiers: {} } } as unknown as Config;

  it("a fresh process sees the history previous runs recorded", () => {
    for (const ms of [50, 60, 70]) {
      recordProbeResult("p", "m", { code: "200", ms, ...noQuota }, { path: cachePath });
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
    recordProbeResult("p", "m", { code: "200", ms: 10, ...noQuota }, { path: cachePath });
    const loop = new PingLoop(cfg, new ModelCatalog({ cachePath: null }), { probeCachePath: cachePath });
    loop.recordPing("p", "m", { ms: 20, code: "200", quotaObservations: [] });
    expect(loop.getModelPings("p", "m").map((p) => p.ms)).toEqual([10, 20]);
  });

  it("reports lifetime uptime across every probe ever recorded", () => {
    recordProbeResult("p", "m", { code: "500", ms: 10, ...noQuota }, { path: cachePath });
    for (let i = 0; i < 3; i++) {
      recordProbeResult("p", "m", { code: "200", ms: 10, ...noQuota }, { path: cachePath });
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
    recordProbeResult("vitest_probe", "m", { code: "200", ms: 1, ...noQuota });

    expect(loadProbeCache({ path: getProbeCachePath() }).providers.vitest_probe).toBeDefined();

    const real = join(process.env.USERPROFILE ?? process.env.HOME ?? "", ".llm-relay", "probe-cache.json");
    if (existsSync(real)) {
      expect(readFileSync(real, "utf8")).not.toContain("vitest_probe");
    }
  });
});

describe("probe cache degrades corrupt entries to empty/unknown", () => {
  it("loadPersistedSamples returns [] for corrupt samples (string, number, null)", () => {
    // Write a corrupt cache with non-array samples
    const corruptPath = join(dir, "corrupt-samples.json");
    writeFileSync(corruptPath, JSON.stringify({
      version: CURRENT_PROBE_VERSION,
      providers: {
        p: {
          models: {
            m1: { modelId: "m1", status: "ok", lastProbedAt: Date.now(), probeVersion: CURRENT_PROBE_VERSION, ms: 10, code: "200", quotaObservations: [], samples: "not an array" },
            m2: { modelId: "m2", status: "ok", lastProbedAt: Date.now(), probeVersion: CURRENT_PROBE_VERSION, ms: 10, code: "200", quotaObservations: [], samples: 123 },
            m3: { modelId: "m3", status: "ok", lastProbedAt: Date.now(), probeVersion: CURRENT_PROBE_VERSION, ms: 10, code: "200", quotaObservations: [], samples: null },
            m4: { modelId: "m4", status: "ok", lastProbedAt: Date.now(), probeVersion: CURRENT_PROBE_VERSION, ms: 10, code: "200", quotaObservations: [], samples: [{ ms: 50, code: "200", timestamp: Date.now() }] }, // valid
          },
        },
      },
    }));
    loadProbeCache({ path: corruptPath, reload: true });

    expect(loadPersistedSamples("p", "m1", { path: corruptPath })).toEqual([]);
    expect(loadPersistedSamples("p", "m2", { path: corruptPath })).toEqual([]);
    expect(loadPersistedSamples("p", "m3", { path: corruptPath })).toEqual([]);
    expect(loadPersistedSamples("p", "m4", { path: corruptPath })).toHaveLength(1); // valid entry still works
  });

  it("loadTotals returns null for corrupt totals (string, number, array)", () => {
    const corruptPath = join(dir, "corrupt-totals.json");
    writeFileSync(corruptPath, JSON.stringify({
      version: CURRENT_PROBE_VERSION,
      providers: {
        p: {
          models: {
            m1: { modelId: "m1", status: "ok", lastProbedAt: Date.now(), probeVersion: CURRENT_PROBE_VERSION, ms: 10, code: "200", quotaObservations: [], totals: "not an object" },
            m2: { modelId: "m2", status: "ok", lastProbedAt: Date.now(), probeVersion: CURRENT_PROBE_VERSION, ms: 10, code: "200", quotaObservations: [], totals: 42 },
            m3: { modelId: "m3", status: "ok", lastProbedAt: Date.now(), probeVersion: CURRENT_PROBE_VERSION, ms: 10, code: "200", quotaObservations: [], totals: [] },
            m4: { modelId: "m4", status: "ok", lastProbedAt: Date.now(), probeVersion: CURRENT_PROBE_VERSION, ms: 10, code: "200", quotaObservations: [], totals: { probes: 5, ok: 5, sumMs: 250, firstProbedAt: 1000 } }, // valid
          },
        },
      },
    }));
    loadProbeCache({ path: corruptPath, reload: true });

    expect(loadTotals("p", "m1", { path: corruptPath })).toBeNull();
    expect(loadTotals("p", "m2", { path: corruptPath })).toBeNull();
    expect(loadTotals("p", "m3", { path: corruptPath })).toBeNull();
    expect(loadTotals("p", "m4", { path: corruptPath })).toEqual({ probes: 5, ok: 5, sumMs: 250, firstProbedAt: 1000 });
  });
});

describe("a corrupt probe cache is not LAUNDERED into a measurement on write", () => {
  it("recordProbeResult refuses to spread a non-array samples field", () => {
    // The read guards in loadPersistedSamples/loadTotals cannot save this case. If the WRITE path
    // spreads a corrupt `samples: "abc"`, it becomes `["a","b","c"]` — a real array — and is
    // written back to disk. From then on the read guard passes it through happily, and
    // dynamic-pools feeds those characters to getStabilityScore and samples.length/5, which decide
    // pool ORDER. Corruption would have been converted into evidence.
    const p = join(dir, "launder.json");
    writeFileSync(p, JSON.stringify({
      version: CURRENT_PROBE_VERSION,
      providers: {
        prov: {
          models: {
            m: {
              modelId: "m", status: "ok", lastProbedAt: 1000, probeVersion: CURRENT_PROBE_VERSION,
              ms: 10, code: "200", quotaObservations: [], samples: "abc",
            },
          },
        },
      },
    }));
    loadProbeCache({ path: p, reload: true });

    const entry = recordProbeResult("prov", "m", { code: "200", ms: 42, quotaObservations: [] }, { path: p, now: 2000 });

    // Exactly one sample — this probe. The three characters must NOT have become three samples.
    expect(entry.samples).toHaveLength(1);
    expect(entry.samples?.[0]).toMatchObject({ ms: 42, code: "200" });
    // And nothing character-shaped survived into the persisted window.
    expect(loadPersistedSamples("prov", "m", { path: p })).toHaveLength(1);
  });

  it("still appends normally to a valid samples window", () => {
    // The control: the guard must not empty a healthy window.
    const p = join(dir, "healthy.json");
    writeFileSync(p, JSON.stringify({
      version: CURRENT_PROBE_VERSION,
      providers: {
        prov: {
          models: {
            m: {
              modelId: "m", status: "ok", lastProbedAt: 1000, probeVersion: CURRENT_PROBE_VERSION,
              ms: 10, code: "200", quotaObservations: [],
              samples: [{ ms: 11, code: "200", timestamp: 900 }],
            },
          },
        },
      },
    }));
    loadProbeCache({ path: p, reload: true });

    const entry = recordProbeResult("prov", "m", { code: "200", ms: 42, quotaObservations: [] }, { path: p, now: 2000 });
    expect(entry.samples).toHaveLength(2);
  });
});
