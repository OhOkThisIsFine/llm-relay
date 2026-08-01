import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { getTelemetryReport } from "../src/telemetry.js";
import { CircuitBreaker, UNMEASURED_STABILITY } from "../src/circuit-breaker.js";
import type { Config, ProviderTierType, ResolvedTarget } from "../src/config.js";

const NOW = 100000;

/** Every env var any provider in these fixtures declares. */
const ENV_KEYS = ["NVIDIA_API_KEY", "OPENAI_API_KEY", "OPEN_API_KEY"] as const;

const provider = (authEnv: string, tierType: ProviderTierType, signupUrl?: string) => ({
  base: "https://example.invalid/v1",
  kind: "openai" as const,
  authEnv,
  authHeader: "authorization" as const,
  timeoutMs: 120000,
  tierType,
  ...(signupUrl ? { signupUrl } : {}),
});

const cfgWith = (providers: Config["providers"]): Config =>
  ({
    host: "127.0.0.1",
    port: 8791,
    mode: "repair",
    log: { level: "metadata", file: null },
    repair: { maxAttempts: 2, destructiveTools: [] },
    providers,
    routing: {
      default: "nim/z-ai/glm-5.2",
      tiers: { opus: "openai/gpt-4o", sonnet: "nim/z-ai/glm-5.2" },
    },
  }) as Config;

const twoProviderCfg = (): Config =>
  cfgWith({
    nim: provider("NVIDIA_API_KEY", "free", "https://build.nvidia.com"),
    openai: provider("OPENAI_API_KEY", "subscription"),
  });

/**
 * The key shape the breaker ACTUALLY writes. `CircuitBreaker.getKey()` produces
 * `${provider}/${model}` for a resolved target, so a fixture that records under a
 * bare provider name exercises a key that no real request ever creates — which is
 * precisely how the bare-name lookups in `/telemetry` passed their test while
 * missing every state in production (OBS-dc5f56e7).
 */
const target = (providerName: string, model: string): ResolvedTarget =>
  ({
    provider: providerName,
    model,
    base: "https://example.invalid/v1",
    kind: "openai",
    authHeader: "authorization",
    timeoutMs: 120000,
  }) as ResolvedTarget;

const saved: Record<string, string | undefined> = {};

beforeEach(() => {
  for (const k of ENV_KEYS) {
    saved[k] = process.env[k];
    process.env[k] = "test-key";
  }
});

afterEach(() => {
  for (const k of ENV_KEYS) {
    const v = saved[k];
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
});

describe("telemetry", () => {
  it("getTelemetryReport generates valid metrics report", () => {
    const cb = new CircuitBreaker();
    cb.recordOutcome(target("nim", "z-ai/glm-5.2"), { ok: true, elapsedMs: 350, quotaPercent: 95, at: NOW });
    cb.recordOutcome(target("openai", "gpt-4o"), { ok: false, status: 429, elapsedMs: 350, at: NOW });

    const report = getTelemetryReport(twoProviderCfg(), cb, NOW);
    expect(report.timestamp).toBeDefined();
    expect(report.providers.length).toBe(2);

    const nimTele = report.providers.find((p) => p.provider === "nim");
    expect(nimTele).toBeDefined();
    expect(nimTele?.tierType).toBe("free");
    expect(nimTele?.quotaPercent).toBe(95);
    expect(nimTele?.signupUrl).toBe("https://build.nvidia.com");

    const openaiTele = report.providers.find((p) => p.provider === "openai");
    expect(openaiTele).toBeDefined();
    expect(openaiTele?.tierType).toBe("subscription");
    expect(openaiTele?.lastStatus).toBe(429);
    expect(openaiTele?.cooldownRemainingMs).toBeGreaterThan(0);
  });

  /**
   * OBS-dc5f56e7. `/telemetry` looked breaker state up by BARE provider name while
   * the breaker keys by `provider/model`, so every lookup missed — and the legacy
   * `isHealthy()`/`getStabilityScore()` returned `true`/`100` on a miss. A provider
   * whose only deployment was rate-limited into a cooldown still read as healthy
   * with a perfect score. These inputs are the ones a real request produces.
   */
  it("a provider whose every deployment is cooling down does not read as healthy", () => {
    const cb = new CircuitBreaker();
    cb.recordOutcome(target("nim", "z-ai/glm-5.2"), { ok: true, elapsedMs: 350, at: NOW });
    cb.recordOutcome(target("openai", "gpt-4o"), { ok: false, status: 429, elapsedMs: 350, at: NOW });

    const report = getTelemetryReport(twoProviderCfg(), cb, NOW + 1000);
    const openaiTele = report.providers.find((p) => p.provider === "openai")!;
    const nimTele = report.providers.find((p) => p.provider === "nim")!;

    expect(openaiTele.isHealthy).toBe(false);
    expect(openaiTele.observedTargets).toBe(1);
    // Observed, and observed unusable: 0 is a measurement, not the unknown band —
    // and emphatically not the 100 the missed lookup used to hand back.
    expect(openaiTele.stabilityScore).toBe(0);
    expect(openaiTele.stabilityScore).toBeLessThan(UNMEASURED_STABILITY);

    expect(nimTele.isHealthy).toBe(true);
    expect(nimTele.stabilityScore!).toBeGreaterThan(UNMEASURED_STABILITY);

    expect(report.healthyProvidersCount).toBe(1);
    expect(report.unmeasuredProvidersCount).toBe(0);
  });

  it("a provider nothing has been observed about reports unknown, never healthy", () => {
    const report = getTelemetryReport(twoProviderCfg(), new CircuitBreaker(), NOW);

    for (const p of report.providers) {
      expect(p.hasKey).toBe(true);
      expect(p.isHealthy).toBeNull();
      expect(p.stabilityScore).toBeNull();
      expect(p.observedTargets).toBe(0);
      expect(p.quotaPercent).toBeNull();
      expect(p.cooldownRemainingMs).toBe(0);
    }
    // Unknown is counted as unknown. It is neither healthy nor unhealthy, and a
    // caller must not be able to infer "2 of 2 up" from a cold breaker.
    expect(report.healthyProvidersCount).toBe(0);
    expect(report.unmeasuredProvidersCount).toBe(2);
    expect(report.activeProvidersCount).toBe(2);
  });

  it("a provider with no credential is known-unhealthy, not unknown", () => {
    delete process.env["NVIDIA_API_KEY"];
    const report = getTelemetryReport(twoProviderCfg(), new CircuitBreaker(), NOW);

    const nimTele = report.providers.find((p) => p.provider === "nim")!;
    expect(nimTele.hasKey).toBe(false);
    expect(nimTele.isHealthy).toBe(false);
    expect(report.activeProvidersCount).toBe(1);
    expect(report.unmeasuredProvidersCount).toBe(1);
  });

  it("reports the BEST measured deployment, and aggregates across a provider's models", () => {
    const cb = new CircuitBreaker();
    const fast = target("nim", "z-ai/glm-5.2");
    const erratic = target("nim", "llama-3.1-8b");
    for (let i = 0; i < 3; i++) cb.recordOutcome(fast, { ok: true, elapsedMs: 120, status: 200, at: NOW });
    cb.recordOutcome(erratic, { ok: true, elapsedMs: 100, status: 200, at: NOW });
    cb.recordOutcome(erratic, { ok: true, elapsedMs: 9000, status: 200, at: NOW });

    const nimTele = getTelemetryReport(twoProviderCfg(), cb, NOW).providers.find((p) => p.provider === "nim")!;
    expect(nimTele.observedTargets).toBe(2);
    expect(nimTele.stabilityScore).toBe(cb.getMeasuredStability(fast));
    expect(nimTele.stabilityScore!).toBeGreaterThan(cb.getMeasuredStability(erratic)!);
    // One erratic SKU in a roster is not evidence against the provider: routing
    // would send the request to the best live deployment.
    expect(nimTele.isHealthy).toBe(true);
  });

  it("a provider whose name prefixes another's does not borrow its observations", () => {
    const cb = new CircuitBreaker();
    cb.recordOutcome(target("openai", "gpt-4o"), { ok: true, elapsedMs: 200, status: 200, at: NOW });

    const cfg = cfgWith({
      open: provider("OPEN_API_KEY", "free"),
      openai: provider("OPENAI_API_KEY", "subscription"),
    });
    const report = getTelemetryReport(cfg, cb, NOW);

    // `openai/gpt-4o` must not match a provider literally named `open`.
    const open = report.providers.find((p) => p.provider === "open")!;
    expect(open.observedTargets).toBe(0);
    expect(open.isHealthy).toBeNull();
    expect(report.providers.find((p) => p.provider === "openai")!.isHealthy).toBe(true);
  });
});
