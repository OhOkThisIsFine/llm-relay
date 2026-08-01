import { describe, expect, it } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { loadConfig, resolveTargets } from "../src/config.js";
import { ModelCatalog } from "../src/catalog.js";
import { materializeDynamicPools } from "../src/dynamic-pools.js";

describe("dynamic free-model pools", () => {
  it("keeps the preferred prefix and appends every discovered free target without known-paid models", async () => {
    const dir = mkdtempSync(join(tmpdir(), "rp-dynamic-pool-"));
    try {
      const path = join(dir, "config.json");
      writeFileSync(path, JSON.stringify({
        listen: "127.0.0.1:8791",
        providers: {
          free: { base: "https://free.test/v1", kind: "openai", tierType: "free" },
          mixed: { base: "https://mixed.test/v1", kind: "openai", tierType: "mixed" },
          paid: { base: "https://paid.test/v1", kind: "openai", tierType: "subscription" },
        },
        routing: {
          default: "free/manual-first",
          pools: { coding: { preferred: ["free/manual-first"], include: "free" } },
        },
      }));
      const cfg = loadConfig(path);
      const catalog = new ModelCatalog({ cachePath: null });
      const feed = (rows: unknown[]) =>
        (async () => new Response(JSON.stringify({ data: rows }), { status: 200 })) as unknown as typeof fetch;

      await catalog.list("free", cfg.providers.free!, {
        fetchFn: feed([{ id: "manual-first" }, { id: "catalog-free-unknown-price" }]),
      });
      await catalog.list("mixed", cfg.providers.mixed!, {
        fetchFn: feed([
          { id: "zero-priced", pricing: { prompt: "0", completion: "0" } },
          { id: "community-model:free" },
          { id: "premium-unknown-price" },
          { id: "known-paid", pricing: { prompt: "0.001", completion: "0.002" } },
        ]),
      });
      await catalog.list("paid", cfg.providers.paid!, { fetchFn: feed([{ id: "unknown-price" }]) });

      materializeDynamicPools(cfg, catalog);
      const specs = cfg.routing.pools!.coding!;
      expect(specs[0]).toBe("free/manual-first");
      expect(specs).toContain("free/catalog-free-unknown-price");
      expect(specs).toContain("mixed/zero-priced");
      expect(specs).toContain("mixed/community-model:free");
      expect(specs).not.toContain("mixed/premium-unknown-price");
      expect(specs).not.toContain("mixed/known-paid");
      expect(specs).not.toContain("paid/unknown-price");
      expect(new Set(specs).size).toBe(specs.length);
      // Dynamic pools preserve the preferred prefix instead of benchmark-sorting it away.
      expect(resolveTargets("pool/coding", cfg)[0]?.model).toBe("manual-first");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
