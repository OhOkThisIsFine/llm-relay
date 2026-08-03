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

  it("materializes cumulative evidence-aware effort bands", async () => {
    const dir = mkdtempSync(join(tmpdir(), "rp-effort-pool-"));
    try {
      const path = join(dir, "config.json");
      writeFileSync(path, JSON.stringify({
        listen: "127.0.0.1:8791",
        providers: { free: { base: "https://free.test/v1", kind: "openai", tierType: "free" } },
        routing: {
          default: "free/deepseek-ai/deepseek-v4-pro",
          pools: {
            low: { preferred: [], include: "free", effort: "low" },
            medium: { preferred: [], include: "free", effort: "medium" },
            high: { preferred: [], include: "free", effort: "high" },
            xhigh: { preferred: [], include: "free", effort: "xhigh" },
          },
        },
      }));
      const cfg = loadConfig(path);
      const catalog = new ModelCatalog({ cachePath: null });
      await catalog.list("free", cfg.providers.free!, {
        fetchFn: (async () => new Response(JSON.stringify({ data: [
          { id: "deepseek-ai/deepseek-v4-pro" },
          { id: "z-ai/glm-5.2" },
          { id: "moonshotai/kimi-k3" },
          { id: "unknown-unscored-model" },
        ] }), { status: 200 })) as unknown as typeof fetch,
      });

      materializeDynamicPools(cfg, catalog);

      const allKnown = [
        "free/moonshotai/kimi-k3",
        "free/z-ai/glm-5.2",
        "free/deepseek-ai/deepseek-v4-pro",
      ];
      expect(cfg.routing.pools!.low).toEqual(allKnown);
      expect(cfg.routing.pools!.medium).toEqual(allKnown);
      expect(cfg.routing.pools!.high).toEqual([
        "free/moonshotai/kimi-k3",
        "free/z-ai/glm-5.2",
        "free/deepseek-ai/deepseek-v4-pro",
      ]);
      expect(cfg.routing.pools!.xhigh).toEqual([
        "free/moonshotai/kimi-k3",
        "free/z-ai/glm-5.2",
        "free/deepseek-ai/deepseek-v4-pro",
      ]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("reuses one materialization within an epoch and invalidates on catalog revision", async () => {
    const dir = mkdtempSync(join(tmpdir(), "rp-pool-cache-"));
    try {
      const path = join(dir, "config.json");
      writeFileSync(path, JSON.stringify({
        listen: "127.0.0.1:8791",
        providers: { free: { base: "https://free.test/v1", kind: "openai", tierType: "free" } },
        routing: {
          default: "pool/lazy",
          pools: { lazy: { preferred: [], include: "free" } },
        },
      }));
      const cfg = loadConfig(path);
      const catalog = new ModelCatalog({ cachePath: null });
      const feed = (ids: string[]) => (async () => new Response(JSON.stringify({
        data: ids.map((id) => ({ id })),
      }), { status: 200 })) as unknown as typeof fetch;
      const now = 1_800_000_000_000;
      await catalog.list("free", cfg.providers.free!, { now, fetchFn: feed(["first"]) });

      expect(materializeDynamicPools(cfg, catalog, { now })).toBe(true);
      expect(materializeDynamicPools(cfg, catalog, { now: now + 1_000 })).toBe(false);
      expect(cfg.routing.pools!.lazy).toContain("free/first");

      await catalog.list("free", cfg.providers.free!, {
        now: now + 2_000,
        force: true,
        fetchFn: feed(["first", "second"]),
      });
      expect(materializeDynamicPools(cfg, catalog, { now: now + 2_000 })).toBe(true);
      expect(cfg.routing.pools!.lazy).toEqual(expect.arrayContaining(["free/first", "free/second"]));
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
