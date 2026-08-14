import { describe, it, expect, afterAll } from "vitest";
import { mkdtempSync, rmSync, existsSync, readFileSync, writeFileSync } from "node:fs";
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

  it("can defer and coalesce persistence while still supporting an explicit shutdown flush", async () => {
    const cachePath = join(dir, "models-cache-write-behind.json");
    const c = new ModelCatalog({ cachePath, writeBehind: true });
    await c.list("p", provider, { fetchFn: okFetch(["lazy-write"]) });
    expect(existsSync(cachePath)).toBe(false);
    c.flushPersistence();
    expect(existsSync(cachePath)).toBe(true);
    const persisted = JSON.parse(readFileSync(cachePath, "utf8")) as Record<string, { models: string[] }>;
    expect(persisted.p?.models).toEqual(["lazy-write"]);
  });

  it("returns [] for an anthropic provider (no /models consumed)", async () => {
    const c = new ModelCatalog({ cachePath: null });
    const anth: ProviderConfig = { base: "https://a.test", kind: "anthropic", authHeader: "x-api-key", timeoutMs: 5000 };
    expect(await c.list("a", anth, { fetchFn: throwFetch() })).toEqual([]);
  });

  it("deduplicates concurrent cold-start requests and clears pending cache on completion/failure", async () => {
    const c = new ModelCatalog({ cachePath: null });
    let fetchCount = 0;
    const delayedFetch: typeof fetch = (async () => {
      fetchCount++;
      await new Promise((r) => setTimeout(r, 20));
      return new Response(JSON.stringify({ data: [{ id: "m1" }] }), { status: 200 });
    }) as unknown as typeof fetch;

    // Concurrent cold-start calls pick up the same in-flight fetch
    const [r1, r2, r3] = await Promise.all([
      c.list("p", provider, { fetchFn: delayedFetch }),
      c.list("p", provider, { fetchFn: delayedFetch }),
      c.list("p", provider, { fetchFn: delayedFetch }),
    ]);

    expect(fetchCount).toBe(1);
    expect(r1).toEqual(["m1"]);
    expect(r2).toEqual(["m1"]);
    expect(r3).toEqual(["m1"]);

    // After completion, pending map is cleared, so a forced refresh triggers a new fetch
    await c.list("p", provider, { force: true, fetchFn: delayedFetch });
    expect(fetchCount).toBe(2);
  });

  it("clears pending cache on reject/failure so subsequent attempts retry", async () => {
    const c = new ModelCatalog({ cachePath: null });
    const res1 = await c.list("p", provider, { fetchFn: failFetch });
    expect(res1).toEqual([]);

    // The failed attempt should clear pending map, allowing second attempt to succeed
    const res2 = await c.list("p", provider, { fetchFn: okFetch(["retry-ok"]) });
    expect(res2).toEqual(["retry-ok"]);
  });

  it("never presents a non-numeric disk value as a published limit", async () => {
    // The cache is a FILE: it can be stale from an older schema, half-written or hand-edited, and
    // `cachedLimits()` feeds the request-path context guardrail. Anything that is not a finite
    // number is "unknown", never a ceiling the proxy reports or enforces.
    const cachePath = join(dir, "junk-limits-cache.json");
    writeFileSync(
      cachePath,
      JSON.stringify({
        p: {
          fetchedAt: 1000,
          models: ["good", "bad", "hollow", "older"],
          limits: {
            good: { contextLength: 131072, maxOutputTokens: 4096, pricePromptPerToken: 0, priceCompletionPerToken: 0 },
            // A string ceiling would sail straight into the guardrail's `>` comparison.
            bad: { contextLength: "lots", maxOutputTokens: null, pricePromptPerToken: null, priceCompletionPerToken: null },
            // Nothing usable at all → not a "publishes limits" entry.
            hollow: { contextLength: null, maxOutputTokens: null, pricePromptPerToken: null, priceCompletionPerToken: null },
            // Written by a version before pricing existed: the newer keys are absent, not null.
            older: { contextLength: 32768, maxOutputTokens: 8192 },
          },
        },
      }) + "\n",
    );

    const c = new ModelCatalog({ cachePath, ttlMs: 10_000 });
    expect(c.cachedLimits("p", "good")).toEqual({
      contextLength: 131072, maxOutputTokens: 4096, pricePromptPerToken: 0, priceCompletionPerToken: 0,
    });
    expect(c.cachedLimits("p", "bad")).toBeNull();
    expect(c.cachedLimits("p", "hollow")).toBeNull();
    // An older-schema row keeps what it really had and reports the rest as unknown — explicit
    // nulls, so `resolveMetadata()` sees "unpublished" rather than a hollow object of undefineds.
    expect(c.cachedLimits("p", "older")).toEqual({
      contextLength: 32768, maxOutputTokens: 8192, pricePromptPerToken: null, priceCompletionPerToken: null,
    });
    // The models list still loads warm — sanitizing limits must not cost the cache its purpose.
    expect(await c.list("p", provider, { now: 2000, fetchFn: throwFetch() })).toEqual(["good", "bad", "hollow", "older"]);
  });

  it("enforces provider fetch timeout via signal", async () => {
    const c = new ModelCatalog({ cachePath: null });
    let receivedSignal: AbortSignal | undefined;
    const inspectFetch: typeof fetch = (async (_url: string, opts?: { signal?: AbortSignal }) => {
      receivedSignal = opts?.signal;
      return new Response(JSON.stringify({ data: [{ id: "m1" }] }), { status: 200 });
    }) as unknown as typeof fetch;

    await c.list("p", { ...provider, timeoutMs: 3000 }, { fetchFn: inspectFetch });
    expect(receivedSignal).toBeDefined();
    expect(receivedSignal?.aborted).toBe(false);
  });
});

describe("bounded catalog fetch (adoption review §1.11)", () => {
  // A /models response is semi-trusted external content served to the one process fronting every
  // session. Time bounds are not size bounds: res.json() buffered unboundedly within the timeout.
  it("refuses a body over the byte cap and degrades like any fetch failure", async () => {
    const huge = JSON.stringify({ data: [{ id: "x".repeat(3 * 1024 * 1024) }] });
    const bigFetch = (async () => new Response(huge, { status: 200 })) as unknown as typeof fetch;
    const c = new ModelCatalog({ cachePath: null });
    expect(await c.list("p", provider, { fetchFn: bigFetch })).toEqual([]);
  });

  it("refuses a STATED oversize up front — the content-length check precedes any read", async () => {
    const lyingFetch = (async () => {
      const res = new Response(new ReadableStream({}), { status: 200 });
      Object.defineProperty(res, "headers", {
        value: new Headers({ "content-length": String(50 * 1024 * 1024) }),
      });
      return res;
    }) as unknown as typeof fetch;
    const c = new ModelCatalog({ cachePath: null });
    expect(await c.list("p", provider, { fetchFn: lyingFetch })).toEqual([]);
  });

  it("drops an id longer than the cap and keeps its siblings", async () => {
    const c = new ModelCatalog({ cachePath: null });
    const models = await c.list("p", provider, { fetchFn: okFetch(["good-model", "m".repeat(300)]) });
    expect(models).toEqual(["good-model"]);
  });

  it("caps a pathological model count, keeping the first N", async () => {
    const ids = Array.from({ length: 5010 }, (_, i) => `m${String(i).padStart(5, "0")}`);
    const c = new ModelCatalog({ cachePath: null });
    const models = await c.list("p", provider, { fetchFn: okFetch(ids) });
    expect(models.length).toBe(5000);
  });
});
