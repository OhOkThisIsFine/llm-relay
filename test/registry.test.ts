import { describe, it, expect, afterAll } from "vitest";
import { createServer, type Server } from "node:http";
import { AddressInfo } from "node:net";
import { buildRegistry } from "../src/registry.js";
import { createProxy } from "../src/server.js";
import type { Config, ProviderConfig } from "../src/config.js";
import type { ModelCatalog } from "../src/catalog.js";

/** Stub catalog: returns canned model ids per provider, no network. */
function stubCatalog(byProvider: Record<string, string[]>): ModelCatalog {
  return { list: async (name: string) => byProvider[name] ?? [] } as unknown as ModelCatalog;
}

function cfg(providers: Record<string, ProviderConfig>, routing: Config["routing"]): Config {
  return {
    host: "127.0.0.1", port: 0,
    providers, routing,
    mode: "detect",
    repair: { maxAttempts: 2, destructiveTools: [] },
    log: { level: "silent", file: null },
  };
}

const nim: ProviderConfig = { base: "https://nim.test/v1", kind: "openai", authHeader: "authorization", timeoutMs: 5000, authEnv: "RP_REG_KEY" };
const anth: ProviderConfig = { base: "https://a.test", kind: "anthropic", authHeader: "x-api-key", timeoutMs: 5000 };

describe("buildRegistry", () => {
  it("returns providers × live models + routing, with raw (uncollapsed) capability", async () => {
    process.env.RP_REG_KEY = "sk-x";
    const c = cfg(
      { nim, openrouter: { ...nim, authEnv: "RP_MISSING_KEY_XYZ" } },
      { default: "nim/z-ai/glm-5.2", tiers: { haiku: "nim/openai/gpt-oss-20b" } },
    );
    const view = await buildRegistry(c, stubCatalog({ nim: ["z-ai/glm-5.2", "openai/gpt-oss-120b"], openrouter: ["x/y"] }), { now: "2026-01-01T00:00:00Z" });

    expect(view.generated_at).toBe("2026-01-01T00:00:00Z");
    expect(view.routing).toEqual({ default: "nim/z-ai/glm-5.2", tiers: { haiku: "nim/openai/gpt-oss-20b" } });

    // provider view
    expect(view.providers.nim!.has_key).toBe(true);        // RP_REG_KEY set
    expect(view.providers.nim!.reachable).toBe(true);      // catalog returned ids
    expect(view.providers.nim!.models.map((m) => m.id)).toEqual(["z-ai/glm-5.2", "openai/gpt-oss-120b"]);
    expect(view.providers.openrouter!.has_key).toBe(false); // RP_MISSING_KEY_XYZ unset

    // capability is a raw score object or null — never a high/med/low bucket
    for (const m of view.providers.nim!.models) {
      expect(m.capability === null || typeof m.capability === "object").toBe(true);
      if (m.capability) {
        expect(m.capability).toHaveProperty("bfcl_overall");
        expect(m.capability).toHaveProperty("arena_rating");
      }
    }
    expect(typeof view.capability_source.present).toBe("boolean");
    delete process.env.RP_REG_KEY;
  });

  it("marks an anthropic provider reachable=null (no /models consumed)", async () => {
    const c = cfg({ claude: anth }, { default: "claude", tiers: {} });
    const view = await buildRegistry(c, stubCatalog({}), { now: "t" });
    expect(view.providers.claude!.kind).toBe("anthropic");
    expect(view.providers.claude!.reachable).toBeNull();
    expect(view.providers.claude!.models).toEqual([]);
    expect(view.providers.claude!.has_key).toBe(true); // no authEnv → configured
  });
});

describe("GET /registry endpoint", () => {
  let proxy: Server;
  afterAll(() => proxy?.close());

  it("serves the registry view as JSON", async () => {
    const c = cfg({ nim }, { default: "nim/z-ai/glm-5.2", tiers: {} });
    proxy = createProxy(c, { catalog: stubCatalog({ nim: ["z-ai/glm-5.2"] }) });
    const p: number = await new Promise((resolve) => proxy.listen(0, "127.0.0.1", () => resolve((proxy.address() as AddressInfo).port)));
    const resp = await fetch(`http://127.0.0.1:${p}/registry`);
    expect(resp.status).toBe(200);
    const view = (await resp.json()) as { providers: Record<string, { models: unknown[] }>; routing: unknown };
    expect(view.providers.nim!.models.length).toBe(1);
    expect(view.routing).toEqual({ default: "nim/z-ai/glm-5.2", tiers: {} });
  });
});
