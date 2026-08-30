/**
 * The background lane cadence: dead-buckets-only quota probing behind gates, catalog refresh on
 * its own long gate, everything contained, and NOTHING spawned under vitest without both seams.
 */
import { describe, expect, it } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { LaneCadence } from "../src/lane-cadence.js";
import { exportExhaustedRows, markExhaustedKey } from "../src/dispatch.js";
import { DEFAULT_LANE_PROBE, loadConfig, type Config } from "../src/config.js";
import type { LaneProbeSpawnResult, LaneProbeSpawner } from "../src/lane-quota-probe.js";

const HOUR = 3_600_000;

function cadenceConfig(laneProbe?: unknown): Config {
  const dir = mkdtempSync(join(tmpdir(), "llm-relay-cadence-"));
  const path = join(dir, "config.json");
  writeFileSync(
    path,
    JSON.stringify({
      listen: "127.0.0.1:8791",
      providers: { anthropic: { base: "https://api.anthropic.com", kind: "anthropic", credentialMode: "passthrough" } },
      routing: {
        default: "anthropic",
        ...(laneProbe !== undefined ? { laneProbe } : {}),
        ladder: [
          { id: "codex-sol", kind: "cli", quota: "codex-sol", command: "codex", args: ["exec", "{task}"] },
          { id: "anthropic", kind: "relay", spec: "anthropic" },
        ],
      },
    }),
  );
  const cfg = loadConfig(path);
  rmSync(dir, { recursive: true, force: true });
  return cfg;
}

function spawnerReturning(results: LaneProbeSpawnResult[]): { spawner: LaneProbeSpawner; calls: string[][] } {
  const calls: string[][] = [];
  const spawner: LaneProbeSpawner = (command, args) => {
    calls.push([command, ...args]);
    const next = results.shift();
    if (!next) throw new Error("unexpected extra spawn");
    return Promise.resolve(next);
  };
  return { spawner, calls };
}

const noCatalog = () => Promise.resolve([]);

describe("lane cadence", () => {
  it("⚠ no-ops under vitest without BOTH injected seams — never a real spawn from the suite", async () => {
    const cfg = cadenceConfig();
    const t0 = Date.now();
    markExhaustedKey(cfg, "quota:codex-sol", t0 + HOUR, t0);
    const cadence = new LaneCadence(cfg, { now: () => t0 + DEFAULT_LANE_PROBE.quotaIntervalMs * 3 });
    cadence.poke();
    await cadence.settle();
    // The death stands untouched; nothing ran.
    expect(exportExhaustedRows(cfg, t0).map((r) => r.key)).toEqual(["quota:codex-sol"]);
  });

  it("does nothing when disabled, dead buckets or not", async () => {
    const cfg = cadenceConfig(false);
    const t0 = Date.now();
    markExhaustedKey(cfg, "quota:codex-sol", t0 + HOUR, t0);
    const { spawner, calls } = spawnerReturning([]);
    const cadence = new LaneCadence(cfg, { spawn: spawner, probeLanesFn: noCatalog, now: () => t0 + 10 * HOUR });
    cadence.poke();
    await cadence.settle();
    expect(calls).toEqual([]);
  });

  it("⚠ probes only DEAD buckets, and defers the first probe by one interval", async () => {
    const cfg = cadenceConfig({ enabled: true, quotaIntervalMs: 60_000, catalogIntervalMs: 30 * 24 * HOUR });
    let t = Date.now();
    const clock = () => t;
    const { spawner, calls } = spawnerReturning([{ code: 0, stdout: "OK", stderr: "", timedOut: false }]);
    const cadence = new LaneCadence(cfg, { spawn: spawner, probeLanesFn: noCatalog, now: clock, manifestPath: join(tmpdir(), "llm-relay-vitest", "absent-manifest.json") });

    // No dead buckets: nothing to do (catalog is gated far away by config).
    cadence.poke();
    await cadence.settle();
    expect(calls).toEqual([]);

    // A death is recorded. First sighting STAMPS, never probes — the report is fresh evidence.
    markExhaustedKey(cfg, "quota:codex-sol", t + 10 * HOUR, t);
    cadence.poke();
    await cadence.settle();
    expect(calls).toEqual([]);

    // Before the gate lapses: still nothing.
    t += 30_000;
    cadence.poke();
    await cadence.settle();
    expect(calls).toEqual([]);

    // Past the gate: exactly one probe, and the ALIVE answer retracts the death.
    t += 40_000;
    cadence.poke();
    await cadence.settle();
    expect(calls).toHaveLength(1);
    expect(exportExhaustedRows(cfg, t)).toEqual([]);
    expect(cadence.lastQuotaProbes()[0]!.verdict.kind).toBe("alive");
  });

  it("an EXHAUSTED verdict re-marks the bucket: vendor window when stated, outcome default otherwise", async () => {
    const cfg = cadenceConfig({ enabled: true, quotaIntervalMs: 60_000, catalogIntervalMs: 30 * 24 * HOUR });
    let t = Date.now();
    const { spawner } = spawnerReturning([
      { code: 1, stdout: "", stderr: "usage limit reached — try again in 2 hours", timedOut: false },
    ]);
    const cadence = new LaneCadence(cfg, { spawn: spawner, probeLanesFn: noCatalog, now: () => t });

    markExhaustedKey(cfg, "quota:codex-sol", t + 30 * 24 * HOUR, t); // vendor said "dead for a month"
    cadence.poke();
    await cadence.settle();
    t += 61_000;
    cadence.poke();
    await cadence.settle();

    const rows = exportExhaustedRows(cfg, t);
    expect(rows).toHaveLength(1);
    // The stated 2h window REPLACED the month-long record — the probe's fresher evidence wins.
    expect(rows[0]!.until).toBe(t + 2 * HOUR);
  });

  it("⚠ an INCONCLUSIVE probe changes nothing — the recorded death stands", async () => {
    const cfg = cadenceConfig({ enabled: true, quotaIntervalMs: 60_000, catalogIntervalMs: 30 * 24 * HOUR });
    let t = Date.now();
    const until = t + 10 * HOUR;
    const { spawner } = spawnerReturning([{ code: null, stdout: "", stderr: "spawn ENOENT", timedOut: false }]);
    const cadence = new LaneCadence(cfg, { spawn: spawner, probeLanesFn: noCatalog, now: () => t });

    markExhaustedKey(cfg, "quota:codex-sol", until, t);
    cadence.poke();
    await cadence.settle();
    t += 61_000;
    cadence.poke();
    await cadence.settle();

    expect(exportExhaustedRows(cfg, t)).toEqual([{ key: "quota:codex-sol", until }]);
  });

  it("runs the catalog probe when a lane was never probed, once per catalog interval", async () => {
    const cfg = cadenceConfig({ enabled: true, quotaIntervalMs: 24 * HOUR, catalogIntervalMs: 60_000 });
    let t = Date.now();
    let catalogRuns = 0;
    const cadence = new LaneCadence(cfg, {
      spawn: () => Promise.reject(new Error("no quota probe expected")),
      probeLanesFn: () => {
        catalogRuns++;
        return Promise.resolve([]);
      },
      now: () => t,
      manifestPath: join(tmpdir(), "llm-relay-vitest", `absent-${Math.random().toString(36).slice(2)}.json`),
    });

    cadence.poke();
    await cadence.settle();
    expect(catalogRuns).toBe(1);

    // Inside the gate: no second run, even though the manifest is still absent.
    t += 30_000;
    cadence.poke();
    await cadence.settle();
    expect(catalogRuns).toBe(1);

    // Past the gate: due again.
    t += 40_000;
    cadence.poke();
    await cadence.settle();
    expect(catalogRuns).toBe(2);
  });
});
