import { describe, expect, it } from "vitest";
import { warmAndValidate } from "../src/cli.js";
import type { Config } from "../src/config.js";
import type { ModelCatalog } from "../src/catalog.js";

describe("startup catalog warming", () => {
  it("warms routed providers plus dynamic free/mixed contributors, not unrelated subscriptions", async () => {
    const provider = (tierType: "free" | "mixed" | "subscription") => ({
      base: "https://example.test/v1",
      kind: "openai" as const,
      authHeader: "authorization" as const,
      timeoutMs: 1000,
      tierType,
    });
    const cfg = {
      host: "127.0.0.1",
      port: 0,
      providers: {
        routed: provider("subscription"),
        free: provider("free"),
        mixed: provider("mixed"),
        unused: provider("subscription"),
      },
      routing: {
        default: "routed/model",
        tiers: {},
        pools: { low: [] },
        poolPolicies: { low: { preferred: [], include: "free" as const, effort: "low" as const } },
      },
      mode: "detect",
      repair: { maxAttempts: 2, destructiveTools: [] },
      log: { level: "silent", file: null },
    } satisfies Config;
    const warmed: string[] = [];
    const catalog = {
      getRevision: () => 0,
      cachedModels: () => [],
      list: async (name: string) => {
        warmed.push(name);
        return name === "routed" ? ["model"] : [];
      },
      has: async () => true,
    } as unknown as ModelCatalog;

    await warmAndValidate(cfg, catalog);
    expect(warmed.sort()).toEqual(["free", "mixed", "routed"]);
  });
});
