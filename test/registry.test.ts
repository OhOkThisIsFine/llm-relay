import { describe, it, expect, beforeEach, afterEach, afterAll } from "vitest";
import { type Server } from "node:http";
import { AddressInfo } from "node:net";
import { buildRegistry, loadTierData, joinCapability } from "../src/registry.js";
import { createProxy } from "../src/server.js";
import type { Config, ProviderConfig } from "../src/config.js";
import type { ModelCatalog } from "../src/catalog.js";
import { CONTROL_AUTHORIZATION_HEADER } from "../src/control-authorization.js";
import { candidateEnvNames } from "../src/authEnv.js";

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
const openrouterFixtureKeys = [...new Set([
  ...candidateEnvNames("openrouter", "RP_MISSING_KEY_XYZ"),
  ...candidateEnvNames("nim", "RP_REG_KEY"),
])];
const restoreOpenRouterEnv = () => {
  const saved: Record<string, string | undefined> = {};
  for (const key of openrouterFixtureKeys) {
    saved[key] = process.env[key];
    delete process.env[key];
  }
  return saved;
};
const restoreOpenRouterEnvValues = (saved: Record<string, string | undefined>) => {
  for (const [key, value] of Object.entries(saved)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
};

describe("buildRegistry", () => {
  let openRouterEnvSaved: Record<string, string | undefined> | null = null;

  beforeEach(() => {
    openRouterEnvSaved = restoreOpenRouterEnv();
  });

  afterEach(() => {
    if (openRouterEnvSaved) {
      restoreOpenRouterEnvValues(openRouterEnvSaved);
      openRouterEnvSaved = null;
    }
  });

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
    expect(JSON.stringify(view)).not.toContain("quota");
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

  it("reports nested credential slots without values and keeps aggregate has_key compatible", async () => {
    process.env.REG_FLEET_PRESENT = "registry-secret-present";
    process.env.REG_FLEET_DISABLED = "registry-secret-disabled";
    delete process.env.REG_FLEET_MISSING;
    try {
      const fleet: ProviderConfig = {
        base: "https://fleet.test/v1", kind: "openai", authHeader: "authorization", timeoutMs: 5000,
        credentials: [
          { label: "personal", authEnv: "REG_FLEET_PRESENT" },
          { label: "work", authEnv: "REG_FLEET_MISSING", models: ["m"] },
          { label: "spare", authEnv: "REG_FLEET_DISABLED", enabled: false, models: [] },
        ],
      };
      const empty: ProviderConfig = {
        base: "https://empty.test/v1", kind: "openai", authHeader: "authorization", timeoutMs: 5000,
        credentials: [],
      };
      const view = await buildRegistry(
        cfg({ fleet, empty }, { default: "fleet/m", tiers: {} }),
        stubCatalog({ fleet: ["m"], empty: [] }),
      );
      expect(view.providers.fleet!.has_key).toBe(true);
      expect(view.providers.empty!.has_key).toBe(false);
      expect(view.providers.fleet!.credentials).toEqual([
        {
          credentialId: "fleet#personal", label: "personal", authEnv: "REG_FLEET_PRESENT",
          enabled: true, models: null, state: "declared-present", has_key: true,
        },
        {
          credentialId: "fleet#work", label: "work", authEnv: "REG_FLEET_MISSING",
          enabled: true, models: ["m"], state: "declared-missing", has_key: false,
        },
        {
          credentialId: "fleet#spare", label: "spare", authEnv: "REG_FLEET_DISABLED",
          enabled: false, models: [], state: "declared-present", has_key: true,
        },
      ]);
      expect(JSON.stringify(view)).not.toContain("registry-secret-");
    } finally {
      delete process.env.REG_FLEET_PRESENT;
      delete process.env.REG_FLEET_DISABLED;
    }
  });

  it("never serializes provider or model quota scalars", async () => {
    const view = await buildRegistry(
      cfg({ nim }, { default: "nim/z-ai/glm-5.2", tiers: {} }),
      stubCatalog({ nim: ["z-ai/glm-5.2"] }),
    );
    expect(JSON.stringify(view)).not.toMatch(/quota/i);
    expect(view.providers.nim).not.toHaveProperty("quota_percent");
  });
});

describe("tier-data caching + join provenance", () => {
  it("memoizes the leaderboard file instead of re-reading it per request", () => {
    const a = loadTierData();
    const b = loadTierData();
    // Same object identity: /registry, /health and /candidates all hit this on every call, so a
    // fresh read + re-index per request is pure waste.
    expect(a).toBe(b);
    if (a) expect(a.byNorm.length).toBeGreaterThan(0);
  });

  it("distinguishes an exact leaderboard match from a borrowed one", () => {
    const byNorm = [
      { norm: "glm-5.2-max", rec: { norm: "glm-5.2-max", arena_rating: 1469 } },
      { norm: "deepseek-v4-pro", rec: { norm: "deepseek-v4-pro", arena_rating: 1457 } },
    ];
    const exact = joinCapability("deepseek-ai/deepseek-v4-pro", byNorm)!;
    expect(exact.match).toBe("exact");
    expect(exact.matched_name).toBe("deepseek-v4-pro");

    // glm-5.2 has no row of its own; the scores come from a DIFFERENT, stronger model.
    // Without provenance that substitution is invisible in the output.
    const fuzzy = joinCapability("z-ai/glm-5.2", byNorm)!;
    expect(fuzzy.match).toBe("fuzzy");
    expect(fuzzy.matched_name).toBe("glm-5.2-max");

    expect(joinCapability("nothing/at-all-here", byNorm)).toBeNull();
  });

  it("keeps an EXACT match on a short model id, while still refusing a short fuzzy one", () => {
    // The length floor exists to stop a short fragment matching promiscuously down the containment
    // path. It used to be applied before the exact check too, which threw away measurements we
    // hold: `o3` and `o1` are real snapshot rows with real published signals, so every spec ending
    // in one resolved to "nothing known" — a synced score silently downgraded to no capability.
    const byNorm = [
      { norm: "o3", rec: { norm: "o3", arena_rating: 1440 } },
      { norm: "gpt-4o-mini", rec: { norm: "gpt-4o-mini", arena_rating: 1300 } },
    ];
    const exact = joinCapability("openai/o3", byNorm)!;
    expect(exact.match).toBe("exact");
    expect(exact.matched_name).toBe("o3");
    expect(exact.arena_rating).toBe(1440);

    // No exact row for `gpt`, and it is below the floor — a miss beats borrowing gpt-4o-mini's row.
    expect(joinCapability("openai/gpt", byNorm)).toBeNull();
  });
});

describe("GET /registry endpoint", () => {
  let proxy: Server;
  afterAll(() => proxy?.close());

  it("serves the registry view as JSON", async () => {
    const controlToken = "registry-test-control-token";
    const c = cfg({ nim }, { default: "nim/z-ai/glm-5.2", tiers: {} });
    proxy = createProxy(c, {
      catalog: stubCatalog({ nim: ["z-ai/glm-5.2"] }),
      controlAuthorization: { validate: (candidate) => candidate === controlToken },
    });
    const p: number = await new Promise((resolve) => proxy.listen(0, "127.0.0.1", () => resolve((proxy.address() as AddressInfo).port)));
    const resp = await fetch(`http://127.0.0.1:${p}/registry`, {
      headers: { [CONTROL_AUTHORIZATION_HEADER]: controlToken },
    });
    expect(resp.status).toBe(200);
    const view = (await resp.json()) as { providers: Record<string, { models: unknown[] }>; routing: unknown };
    expect(view.providers.nim!.models.length).toBe(1);
    expect(view.routing).toEqual({ default: "nim/z-ai/glm-5.2", tiers: {} });

    const healthResp = await fetch(`http://127.0.0.1:${p}/health`, {
      headers: { [CONTROL_AUTHORIZATION_HEADER]: controlToken },
    });
    expect(healthResp.status).toBe(200);
    const health = (await healthResp.json()) as { providers: Record<string, Record<string, unknown>> };
    expect(health.providers.nim).not.toHaveProperty("credentials");
    expect(JSON.stringify(health)).not.toContain("credentialId");
  });
});
