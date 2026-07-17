import { describe, it, expect, afterAll } from "vitest";
import { mkdtempSync, rmSync, existsSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { ModelCatalog } from "../src/catalog.js";
import type { ProviderConfig } from "../src/config.js";

const dir = mkdtempSync(join(tmpdir(), "rp-cat-"));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

const provider: ProviderConfig = { base: "https://prov.test/v1", kind: "openai", authHeader: "authorization", timeoutMs: 5000 };

function okFetch(ids: string[]): typeof fetch {
  return (async () => new Response(JSON.stringify({ data: ids.map((id) => ({ id })) }), { status: 200 })) as unknown as typeof fetch;
}
const failFetch: typeof fetch = (async () => new Response("nope", { status: 403 })) as unknown as typeof fetch;
function throwFetch(): typeof fetch {
  return (async () => { throw new Error("must not be called"); }) as unknown as typeof fetch;
}

describe("ModelCatalog", () => {
  it("fetches, parses {data:[{id}]}, and sorts", async () => {
    const c = new ModelCatalog({ cachePath: null });
    const models = await c.list("p", provider, { fetchFn: okFetch(["z-model", "a-model"]) });
    expect(models).toEqual(["a-model", "z-model"]);
  });

  it("serves the cache within TTL without re-fetching", async () => {
    const c = new ModelCatalog({ cachePath: null, ttlMs: 10_000 });
    await c.list("p", provider, { now: 1000, fetchFn: okFetch(["m1"]) });
    // second call inside TTL must NOT hit the network
    const models = await c.list("p", provider, { now: 5000, fetchFn: throwFetch() });
    expect(models).toEqual(["m1"]);
  });

  it("stale-while-revalidate: past TTL serves the stale list immediately, refreshes in the background", async () => {
    const c = new ModelCatalog({ cachePath: null, ttlMs: 1000 });
    await c.list("p", provider, { now: 0, fetchFn: okFetch(["old"]) });
    // Past TTL: MUST NOT block on the refetch — a discovery/liveness probe returns
    // the stale list at once while a background refresh runs.
    const immediate = await c.list("p", provider, { now: 2000, fetchFn: okFetch(["new"]) });
    expect(immediate).toEqual(["old"]);
    // Let the fire-and-forget refresh settle (macrotask after the fetch microtasks);
    // the cache now reflects the refreshed list without any further network call.
    await new Promise((r) => setTimeout(r, 0));
    const afterRefresh = await c.list("p", provider, { now: 3000, fetchFn: throwFetch() });
    expect(afterRefresh).toEqual(["new"]);
    // force still bypasses the cache and awaits a fresh fetch synchronously.
    const forced = await c.list("p", provider, { now: 3000, force: true, fetchFn: okFetch(["forced"]) });
    expect(forced).toEqual(["forced"]);
  });

  it("serves a stale cache when a refresh fails (fail-open)", async () => {
    const c = new ModelCatalog({ cachePath: null, ttlMs: 1000 });
    await c.list("p", provider, { now: 0, fetchFn: okFetch(["cached"]) });
    const stale = await c.list("p", provider, { now: 5000, fetchFn: failFetch }); // past TTL, fetch 403s
    expect(stale).toEqual(["cached"]);
  });

  it("has(): true/false against the catalog, null when unavailable", async () => {
    const c = new ModelCatalog({ cachePath: null });
    expect(await c.has("p", provider, "m1", { fetchFn: okFetch(["m1", "m2"]) })).toBe(true);
    expect(await c.has("p", provider, "ghost", { fetchFn: okFetch(["m1", "m2"]) })).toBe(false);
    // no cache + fetch fails → unknown (null), so routing never hard-fails on a catalog miss
    const empty = new ModelCatalog({ cachePath: null });
    expect(await empty.has("q", provider, "x", { fetchFn: failFetch })).toBeNull();
  });

  it("persists to disk and reloads warm in a fresh instance", async () => {
    const cachePath = join(dir, "models-cache.json");
    const c1 = new ModelCatalog({ cachePath, ttlMs: 10_000 });
    await c1.list("p", provider, { now: 1000, fetchFn: okFetch(["disk-model"]) });
    expect(existsSync(cachePath)).toBe(true);

    const c2 = new ModelCatalog({ cachePath, ttlMs: 10_000 });
    // fresh instance, within TTL → served from disk, no network
    const models = await c2.list("p", provider, { now: 2000, fetchFn: throwFetch() });
    expect(models).toEqual(["disk-model"]);
  });

  it("returns [] for an anthropic provider (no /models consumed)", async () => {
    const c = new ModelCatalog({ cachePath: null });
    const anth: ProviderConfig = { base: "https://a.test", kind: "anthropic", authHeader: "x-api-key", timeoutMs: 5000 };
    expect(await c.list("a", anth, { fetchFn: throwFetch() })).toEqual([]);
  });
});
