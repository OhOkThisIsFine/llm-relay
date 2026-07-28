import { describe, it, expect } from "vitest";
import { validateProviderKeys } from "../src/key-checker.js";
import type { Config } from "../src/config.js";

describe("key-checker", () => {
  const baseConfig: Config = {
    host: "127.0.0.1",
    port: 8791,
    providers: {
      mockProv: {
        base: "http://mock.provider",
        kind: "openai",
        authEnv: "MOCK_PROV_KEY",
        authHeader: "authorization",
        timeoutMs: 1000,
      },
    },
    routing: { default: "mockProv/model-x", tiers: {} },
    mode: "detect",
    repair: { maxAttempts: 2, destructiveTools: [] },
    log: { level: "silent", file: null },
  };

  it("reports missing environment variable when unset", async () => {
    delete process.env.MOCK_PROV_KEY;
    const results = await validateProviderKeys(baseConfig);
    expect(results).toHaveLength(1);
    expect(results[0]?.status).toBe("missing_env");
    expect(results[0]?.hasEnvKey).toBe(false);
  });

  it("verifies provider key when present and endpoint responds 200", async () => {
    process.env.MOCK_PROV_KEY = "test-key-123";
    const mockFetch = (async () => {
      return new Response(JSON.stringify({ data: [{ id: "model-x" }] }), { status: 200 });
    }) as unknown as typeof fetch;

    const results = await validateProviderKeys(baseConfig, mockFetch);
    expect(results).toHaveLength(1);
    expect(results[0]?.status).toBe("valid");
    expect(results[0]?.modelsFound).toBe(1);
  });
});
