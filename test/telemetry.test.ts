import { describe, it, expect } from "vitest";
import { getTelemetryReport } from "../src/telemetry.js";
import { CircuitBreaker } from "../src/circuit-breaker.js";
import type { Config } from "../src/config.js";

describe("telemetry", () => {
  it("getTelemetryReport generates valid metrics report", () => {
    const dummyCfg: Config = {
      host: "127.0.0.1",
      port: 8791,
      mode: "repair",
      log: { level: "metadata", file: null },
      repair: { maxAttempts: 2, destructiveTools: [] },
      providers: {
        nim: {
          base: "https://integrate.api.nvidia.com/v1",
          kind: "openai",
          authEnv: "NVIDIA_API_KEY",
          authHeader: "authorization",
          timeoutMs: 120000,
          tierType: "free",
          signupUrl: "https://build.nvidia.com",
        },
        openai: {
          base: "https://api.openai.com/v1",
          kind: "openai",
          authEnv: "OPENAI_API_KEY",
          authHeader: "authorization",
          timeoutMs: 120000,
          tierType: "subscription",
        },
      },
      routing: {
        default: "nim/z-ai/glm-5.2",
        tiers: {
          opus: "openai/gpt-4o",
          sonnet: "nim/z-ai/glm-5.2",
        },
      },
    };

    const cb = new CircuitBreaker();
    cb.recordSuccess("nim", 350, 95);
    cb.recordFailure("openai", 429, 100000);

    const report = getTelemetryReport(dummyCfg, cb, 100000);
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
});
