import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { type Server } from "node:http";
import { AddressInfo } from "node:net";
import { createProxy } from "../src/server.js";
import type { Config } from "../src/config.js";
import { resetFacts } from "../src/target-facts.js";
import { recordObservedContextLimit, resetObservedContextLimits } from "../src/context-limits.js";

const CONTROL_TOKEN = "test-control-capability";

function baseConfig(): Config {
  return {
    listen: "127.0.0.1:0",
    mode: "detect",
    providers: {
      anthropic: { base: "https://api.anthropic.com", kind: "anthropic", authHeader: "x-api-key" },
      nim: { base: "https://api.nim.ai", kind: "openai", authHeader: "authorization" },
      huggingface: { base: "https://api-inference.huggingface.com", kind: "openai", authHeader: "authorization" },
    },
    routing: {
      default: "anthropic",
      tiers: {},
      pools: {
        coding: ["nim/z-ai/glm-5.2", "huggingface/Qwen/Qwen3-235B-A22B-Instruct-2507"],
      },
      offload: false,
    },
    repair: { maxAttempts: 2, destructiveTools: ["rm", "delete"] },
    log: {},
  } as unknown as Config;
}

let server: Server | undefined;

beforeEach(() => {
  resetFacts();
  resetObservedContextLimits();
});

afterEach(async () => {
  if (server) await new Promise<void>((r) => server!.close(() => r()));
  server = undefined;
});

async function boot(): Promise<string> {
  server = createProxy(baseConfig(), {
    controlAuthorization: { validate: (candidate) => candidate === CONTROL_TOKEN },
  });
  await new Promise<void>((r) => server!.listen(0, "127.0.0.1", () => r()));
  const { port } = server!.address() as AddressInfo;
  return `http://127.0.0.1:${port}`;
}

describe("GET /v1/models context window resolution", () => {
  it("reports the pool MINIMUM from injected observed ceilings, not the Codex default", async () => {
    // Inject the top resolver rung (observed ceilings) so the expectation depends on nothing
    // live: the real snapshot is NEVER asserted against (a sync:tiers run must not move this
    // test), and the fallback constant cannot satisfy an exact 131072. On the un-fixed tree
    // every id reported 272000, so this is the assertion that observes the fix.
    recordObservedContextLimit("nim", "z-ai/glm-5.2", 131072);
    recordObservedContextLimit("huggingface", "Qwen/Qwen3-235B-A22B-Instruct-2507", 163840);
    const url = await boot();
    const res = await fetch(`${url}/v1/models`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { data: Array<{ id: string; context_window: number; max_context_window: number }> };

    const poolEntry = body.data.find((d) => d.id === "pool/coding");
    expect(poolEntry).toBeDefined();
    expect(poolEntry!.context_window).toBe(131072);
    expect(poolEntry!.max_context_window).toBe(131072);
  });

  it("reports the Codex default (272000) for completely unresolvable ids", async () => {
    // Create a config with a pool that has a member that won't resolve
    const cfg: Config = {
      listen: "127.0.0.1:0",
      mode: "detect",
      providers: {
        anthropic: { base: "https://api.anthropic.com", kind: "anthropic", authHeader: "x-api-key" },
        unknownprovider: { base: "https://unknown.example.com", kind: "openai", authHeader: "authorization" },
      },
      routing: {
        default: "anthropic",
        tiers: {},
        pools: {
          // A pool with a model that won't be in any catalog
          unresolvable: ["unknownprovider/nonexistent-model-xyz"],
        },
        offload: false,
      },
      repair: { maxAttempts: 2, destructiveTools: ["rm", "delete"] },
      log: {},
    } as unknown as Config;

    const testServer = createProxy(cfg, {
      controlAuthorization: { validate: (candidate) => candidate === CONTROL_TOKEN },
    });
    await new Promise<void>((r) => testServer.listen(0, "127.0.0.1", () => r()));
    const { port } = testServer.address() as AddressInfo;
    const testUrl = `http://127.0.0.1:${port}`;

    try {
      const res = await fetch(`${testUrl}/v1/models`);
      expect(res.status).toBe(200);
      const body = (await res.json()) as { data: Array<{ id: string; context_window: number; max_context_window: number }> };

      // Find the pool/unresolvable entry
      const poolEntry = body.data.find((d) => d.id === "pool/unresolvable");
      expect(poolEntry).toBeDefined();
      // With no resolvable data, it should fall back to the default
      expect(poolEntry!.context_window).toBe(272000);
      expect(poolEntry!.max_context_window).toBe(272000);
    } finally {
      await new Promise<void>((r) => testServer.close(() => r()));
    }
  });

  it("reports the Codex default (272000) for an unresolvable provider spec", async () => {
    const url = await boot();
    const res = await fetch(`${url}/v1/models`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { data: Array<{ id: string; context_window: number; max_context_window: number }> };

    // Find the anthropic entry (no model specified, so it won't resolve)
    const anthropicEntry = body.data.find((d) => d.id === "anthropic");
    expect(anthropicEntry).toBeDefined();
    expect(anthropicEntry!.context_window).toBe(272000);
    expect(anthropicEntry!.max_context_window).toBe(272000);
  });

  it("returns both /v1/models and /models paths", async () => {
    const url = await boot();

    const resV1 = await fetch(`${url}/v1/models`);
    expect(resV1.status).toBe(200);
    const bodyV1 = (await resV1.json()) as { data: unknown[]; models: unknown[] };

    const resRoot = await fetch(`${url}/models`);
    expect(resRoot.status).toBe(200);
    const bodyRoot = (await resRoot.json()) as { data: unknown[]; models: unknown[] };

    // Both should return the same data
    expect(bodyV1).toEqual(bodyRoot);
  });

  it("includes all configured models and pools", async () => {
    const url = await boot();
    const res = await fetch(`${url}/v1/models`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { data: Array<{ id: string }> };

    const ids = body.data.map((d) => d.id);
    // Should include the default, pool/coding, and any tier entries
    expect(ids).toContain("anthropic");
    expect(ids).toContain("pool/coding");
  });
});
