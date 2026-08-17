import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { getTelemetryReport } from "../src/telemetry.js";
import { candidateEnvNames } from "../src/authEnv.js";
import { CircuitBreaker, UNMEASURED_STABILITY } from "../src/circuit-breaker.js";
import { makeCredentialId } from "../src/credential-id.js";
import type { Config, ProviderTierType } from "../src/config.js";
import type { ProviderTargetIdentity } from "../src/kernel/contracts.js";

const NOW = 100000;

/** Every env var any provider in these fixtures declares. */
const ENV_KEYS = [...new Set([
  ...candidateEnvNames("nim", "NVIDIA_API_KEY"),
  ...candidateEnvNames("openai", "OPENAI_API_KEY"),
  ...candidateEnvNames("open", "OPEN_API_KEY"),
  ...candidateEnvNames("gemini", "GEMINI_DECLARED_KEY"),
  ...candidateEnvNames("my-provider", "MY_DECLARED_KEY"),
])];

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
 * Breaker fixtures use the same explicit identity as request attempts. A raw provider/model
 * string is not a valid cell identity: the implicit single slot is `<provider>#default`.
 */
const target = (providerName: string, model: string): ProviderTargetIdentity =>
  ({
    provider: providerName,
    model,
    base: "https://example.invalid/v1",
    kind: "openai",
    credentialId: makeCredentialId(providerName),
    authHeader: "authorization",
    timeoutMs: 120000,
  }) as ProviderTargetIdentity;

const credentialTarget = (providerName: string, model: string, label: string): ProviderTargetIdentity => ({
  ...target(providerName, model),
  credentialId: makeCredentialId(providerName, label),
});

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
    cb.recordOutcome(target("nim", "z-ai/glm-5.2"), {
      ok: true,
      elapsedMs: 350,
      quotaObservations: [{
        axis: "requests", period: "day", remaining: 95, limit: 100,
        resetsAt: null, observedAt: NOW, basis: "provider-stated",
      }],
      at: NOW,
    });
    cb.recordOutcome(target("openai", "gpt-4o"), { ok: false, status: 429, elapsedMs: 350, at: NOW });

    const report = getTelemetryReport(twoProviderCfg(), cb, NOW);
    expect(report.timestamp).toBeDefined();
    expect(report.providers.length).toBe(2);

    const nimTele = report.providers.find((p) => p.provider === "nim");
    expect(nimTele).toBeDefined();
    expect(nimTele?.tierType).toBe("free");
    expect(nimTele).not.toHaveProperty("quotaPercent");
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
      expect(p).not.toHaveProperty("quotaPercent");
      expect(p.cooldownRemainingMs).toBe(0);
    }
    // Unknown is counted as unknown. It is neither healthy nor unhealthy, and a
    // caller must not be able to infer "2 of 2 up" from a cold breaker.
    expect(report.healthyProvidersCount).toBe(0);
    expect(report.unmeasuredProvidersCount).toBe(2);
    expect(report.activeProvidersCount).toBe(2);
  });

  it("a provider with no credential is known-unhealthy, not unknown", () => {
    for (const key of candidateEnvNames("nim", "NVIDIA_API_KEY")) delete process.env[key];
    const report = getTelemetryReport(twoProviderCfg(), new CircuitBreaker(), NOW);

    const nimTele = report.providers.find((p) => p.provider === "nim")!;
    expect(nimTele.hasKey).toBe(false);
    expect(nimTele.isHealthy).toBe(false);
    expect(report.activeProvidersCount).toBe(1);
    expect(report.unmeasuredProvidersCount).toBe(1);
  });

  it("treats a whitespace-only declared credential as absent", () => {
    for (const key of candidateEnvNames("nim", "NVIDIA_API_KEY")) delete process.env[key];
    process.env.NVIDIA_API_KEY = "   \t";
    const report = getTelemetryReport(twoProviderCfg(), new CircuitBreaker(), NOW);
    expect(report.providers.find((p) => p.provider === "nim")?.hasKey).toBe(false);
  });

  it("recognizes a credential under a curated provider alias", () => {
    const cfg = cfgWith({
      gemini: provider("GEMINI_DECLARED_KEY", "free"),
    });
    process.env.GOOGLEAI_API_KEY = "gemini-alias";
    const report = getTelemetryReport(cfg, new CircuitBreaker(), NOW);
    expect(report.providers[0]?.hasKey).toBe(true);
  });

  it("recognizes a credential under a provider-derived alias", () => {
    const cfg = cfgWith({
      "my-provider": provider("MY_DECLARED_KEY", "free"),
    });
    process.env.MY_PROVIDER_API_KEY = "derived-alias";
    const report = getTelemetryReport(cfg, new CircuitBreaker(), NOW);
    expect(report.providers[0]?.hasKey).toBe(true);
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
    expect(nimTele.stabilityScore).toBe(
      cb.getDeploymentMeasurement({ provider: "nim", model: "z-ai/glm-5.2" }).stabilityScore,
    );
    expect(nimTele.stabilityScore!).toBeGreaterThan(
      cb.getDeploymentMeasurement({ provider: "nim", model: "llama-3.1-8b" }).stabilityScore!,
    );
    // One erratic SKU in a roster is not evidence against the provider: routing
    // would send the request to the best live deployment.
    expect(nimTele.isHealthy).toBe(true);
  });

  it("deduplicates credential cells and never exposes credential labels", () => {
    const cb = new CircuitBreaker();
    cb.recordOutcome(credentialTarget("nim", "z-ai/glm-5.2", "personal"), {
      ok: true,
      elapsedMs: 120,
      status: 200,
      at: NOW,
    });
    cb.recordOutcome(credentialTarget("nim", "z-ai/glm-5.2", "work"), {
      ok: true,
      elapsedMs: 130,
      status: 200,
      at: NOW + 1,
    });

    const report = getTelemetryReport(twoProviderCfg(), cb, NOW + 2);
    const nim = report.providers.find((p) => p.provider === "nim")!;
    expect(nim.observedTargets).toBe(1);
    const serialized = JSON.stringify(report);
    expect(serialized).not.toContain("personal");
    expect(serialized).not.toContain("work");
  });

  it("does not expose quota observations on provider-level telemetry", () => {
    const cb = new CircuitBreaker();
    cb.recordOutcome(target("nim", "z-ai/glm-5.2"), {
      ok: true,
      elapsedMs: 120,
      quotaObservations: [{
        axis: "tokens", period: "minute", remaining: 800, limit: 1_000,
        resetsAt: null, observedAt: NOW, basis: "provider-stated",
      }],
      at: NOW,
    });

    const serialized = JSON.stringify(getTelemetryReport(twoProviderCfg(), cb, NOW));
    expect(serialized).not.toContain("quota");
    expect(serialized).not.toContain("tokens");
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
