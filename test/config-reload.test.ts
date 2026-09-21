import { describe, expect, it } from "vitest";
import type { Config, ProviderConfig } from "../src/config-types.js";
import {
  applyConfigReload,
  configReloadChangedPaths,
  configReloadRestartPaths,
} from "../src/config-reload.js";

function provider(overrides: Partial<ProviderConfig> = {}): ProviderConfig {
  return {
    base: "https://provider.test/v1",
    kind: "openai",
    authEnv: "TEST_KEY",
    authHeader: "authorization",
    timeoutMs: 120_000,
    ...overrides,
  };
}

function config(overrides: Partial<Config> = {}): Config {
  const cfg: Config = {
    host: "127.0.0.1",
    port: 8791,
    providers: {
      test: provider({
        credentials: [{
          label: "primary",
          authEnv: "TEST_KEY",
          enabled: true,
          models: ["model"],
          limits: { rpm: 10 },
        }],
        limits: { rpm: 20 },
      }),
    },
    routing: {
      default: "test/model",
      tiers: {},
      latency: { enabled: true, p95Ms: 30_000, msPerToken: 250, minSamples: 5 },
      probation: { enabled: true, minSamples: 5 },
      pacing: { enabled: true },
      dispatchWalk: {
        enabled: true,
        idleMs: 300_000,
        attemptMs: 0,
        agentAttemptMs: 0,
        attemptQuantile: 0.9,
        attemptMinSamples: 5,
        maxLanes: 4,
        pinMs: 900_000,
        demoteMs: 900_000,
        outlier: false,
      },
      mcp: { maxWaitMs: 25_000 },
    },
    mode: "detect",
    repair: { maxAttempts: 2, destructiveTools: ["delete"] },
    log: { level: "silent", file: null },
    sourcePath: "/tmp/config.json",
    ...overrides,
  };
  return cfg;
}

function withMtime(cfg: Config, mtime: number): Config {
  Object.defineProperty(cfg, "sourceMtimeMs", {
    value: mtime,
    enumerable: false,
    writable: false,
    configurable: true,
  });
  return cfg;
}

describe("config reload transaction", () => {
  it("reports restart-only changes without mutating the live config", () => {
    const live = config();
    const candidate = config({
      host: "localhost",
      log: { level: "metadata", file: "relay.log" },
      repair: { maxAttempts: 9, destructiveTools: ["delete", "shell"] },
      routing: {
        ...config().routing,
        default: "test/other",
        sticky: { enabled: true, ttlMs: 5000, maxSessions: 20 },
      },
    });
    candidate.providers.test = provider({
      ...candidate.providers.test,
      base: "https://other-provider.test/v1",
    });

    const before = structuredClone(live);
    const result = applyConfigReload(live, candidate);

    expect(result).toEqual({
      ok: false,
      requiresRestart: [
        "host",
        "log",
        "providers.test.base",
        "providers.test.credentials",
        "repair.destructiveTools",
        "routing.sticky",
      ],
    });
    expect(live).toEqual(before);
  });

  it("applies request-time provider and routing policy to the existing config identity", () => {
    const live = withMtime(config(), 100);
    const identity = live;
    const providerIdentity = live.providers.test;
    const routingIdentity = live.routing;
    const candidate = withMtime(config({
      mode: "repair",
      repair: { maxAttempts: 4, destructiveTools: ["delete"] },
      walkBudgetMs: 12_000,
      maxBodyBytes: 4096,
      leaveMeAlone: ["test"],
      warnings: ["candidate warning"],
      routing: {
        ...config().routing,
        default: "test/model-v2",
        benchmarkSort: false,
        offload: true,
        latency: { enabled: false, p95Ms: 30_000, msPerToken: 250, minSamples: 5 },
        probation: { enabled: true, minSamples: 9 },
        pacing: { enabled: false },
        crawl: { enabled: false },
        laneProbe: { enabled: false, quotaIntervalMs: 1000, catalogIntervalMs: 2000 },
        ladder: [{ id: "lane", kind: "relay", enabled: true, spec: "test/model-v2" }],
      },
    }), 200);
    candidate.providers.test!.timeoutMs = 30_000;
    candidate.providers.test!.stallTimeoutMs = 12_000;
    candidate.providers.test!.firstByteTimeoutMs = 8_000;
    candidate.providers.test!.maxConcurrent = 3;
    candidate.providers.test!.limits = { rpm: 99, models: { model: { tpm: 1000 } } };
    candidate.providers.test!.credentials![0]!.limits = { rpd: 77 };

    const result = applyConfigReload(live, candidate);

    expect(result.ok).toBe(true);
    expect(live).toBe(identity);
    expect(live.providers.test).toBe(providerIdentity);
    expect(live.routing).toBe(routingIdentity);
    expect(live.mode).toBe("repair");
    expect(live.repair.maxAttempts).toBe(4);
    expect(live.providers.test!.timeoutMs).toBe(30_000);
    expect(live.providers.test!.limits).toEqual({ rpm: 99, models: { model: { tpm: 1000 } } });
    expect(live.providers.test!.credentials![0]!.limits).toEqual({ rpd: 77 });
    expect(live.routing.default).toBe("test/model-v2");
    expect(live.routing.probation?.minSamples).toBe(9);
    expect(live.warnings).toEqual(["candidate warning"]);
    expect(live.sourceMtimeMs).toBe(200);
    expect(Object.keys(live)).not.toContain("sourceMtimeMs");
  });

  it("allows credential limit changes but requires restart for credential identity changes", () => {
    const live = config();
    const limitsOnly = config();
    limitsOnly.providers.test!.credentials![0]!.limits = { rpm: 44 };

    expect(configReloadRestartPaths(live, limitsOnly)).toEqual([]);
    expect(configReloadChangedPaths(live, limitsOnly)).toEqual([
      "providers.test.credentials[0].limits",
    ]);

    const identityChange = config();
    identityChange.providers.test!.credentials![0]!.models = ["different-model"];
    expect(configReloadRestartPaths(live, identityChange)).toEqual([
      "providers.test.credentials",
    ]);
  });

  it("requires restart when provider membership changes", () => {
    const live = config();
    const candidate = config();
    candidate.providers.second = provider({ authEnv: "SECOND_KEY" });
    expect(configReloadRestartPaths(live, candidate)).toEqual(["providers"]);
  });

  it("deletes optional reloadable properties that disappeared from the candidate", () => {
    const live = config({
      walkBudgetMs: 1000,
      maxBodyBytes: 2048,
      leaveMeAlone: ["test"],
      warnings: ["old"],
    });
    live.providers.test!.stallTimeoutMs = 5000;
    live.routing.offload = true;

    const candidate = config();
    const result = applyConfigReload(live, candidate);
    expect(result.ok).toBe(true);
    expect(live.walkBudgetMs).toBeUndefined();
    expect(live.maxBodyBytes).toBeUndefined();
    expect(live.leaveMeAlone).toBeUndefined();
    expect(live.warnings).toBeUndefined();
    expect(live.providers.test!.stallTimeoutMs).toBeUndefined();
    expect(live.routing.offload).toBeUndefined();
  });

  it("reports a stable empty diff for an identical normalized candidate", () => {
    const live = config();
    const candidate = config();
    expect(configReloadRestartPaths(live, candidate)).toEqual([]);
    expect(configReloadChangedPaths(live, candidate)).toEqual([]);
    expect(applyConfigReload(live, candidate)).toEqual({ ok: true, changed: [] });
  });
});
