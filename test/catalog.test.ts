import { describe, it, expect, afterAll } from "vitest";
import { mkdtempSync, rmSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { ModelCatalog } from "../src/catalog.js";
import type { ProviderConfig } from "../src/config.js";
import { candidateEnvNames } from "../src/authEnv.js";

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
  it("uses a provider alias and emits exactly one Bearer prefix", async () => {
    const declared = "CATALOG_ALIAS_DECLARED_KEY";
    const envKeys = candidateEnvNames("gemini", declared);
    const saved = Object.fromEntries(envKeys.map((key) => [key, process.env[key]]));
    try {
      for (const key of envKeys) delete process.env[key];
      process.env.GOOGLEAI_API_KEY = "Bearer catalog-alias";
      let seen: Headers | undefined;
      const fetchFn = (async (_url: string, init?: RequestInit) => {
        seen = new Headers(init?.headers);
        return new Response(JSON.stringify({ data: [{ id: "alias-model" }] }), { status: 200 });
      }) as unknown as typeof fetch;
      const c = new ModelCatalog({ cachePath: null });
      const models = await c.list("gemini", {
        base: "https://prov.test/v1", kind: "openai", authEnv: declared,
        authHeader: "authorization", timeoutMs: 5000,
      }, { fetchFn });
      expect(models).toEqual(["alias-model"]);
      expect(seen?.get("authorization")).toBe("Bearer catalog-alias");
    } finally {
      for (const [key, value] of Object.entries(saved)) {
        if (value === undefined) delete process.env[key]; else process.env[key] = value;
      }
    }
  });

  it("walks explicit credential slots only on credential-attributable roster failures", async () => {
    const saved = { CATALOG_ONE: process.env.CATALOG_ONE, CATALOG_TWO: process.env.CATALOG_TWO, GOOGLEAI_API_KEY: process.env.GOOGLEAI_API_KEY };
    try {
      process.env.CATALOG_ONE = "one";
      process.env.CATALOG_TWO = "two";
      delete process.env.GOOGLEAI_API_KEY;
      const seen: string[] = [];
      const fetchFn = (async (_url: string, init?: RequestInit) => {
        const auth = new Headers(init?.headers).get("authorization") ?? "";
        seen.push(auth);
        return auth === "Bearer one"
          ? new Response("no", { status: 403 })
          : new Response(JSON.stringify({ data: [{ id: "first-only" }, { id: "other-model" }] }), { status: 200 });
      }) as unknown as typeof fetch;
      const c = new ModelCatalog({ cachePath: null });
      const models = await c.list("fleet", {
        base: "https://prov.test/v1", kind: "openai", authHeader: "authorization", timeoutMs: 5000,
        credentials: [
          { label: "one", authEnv: "CATALOG_ONE", models: ["first-only"] },
          { label: "two", authEnv: "CATALOG_TWO", models: ["second-only"] },
        ],
      }, { fetchFn });
      expect(models).toEqual(["first-only", "other-model"]);
      expect(seen).toEqual(["Bearer one", "Bearer two"]);
    } finally {
      for (const [key, value] of Object.entries(saved)) {
        if (value === undefined) delete process.env[key]; else process.env[key] = value;
      }
    }
  });

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
          models: ["good", "bad", "hollow", "junky", "older", "preRate"],
          limits: {
            good: { contextLength: 131072, maxOutputTokens: 4096, pricePromptPerToken: 0, priceCompletionPerToken: 0, rateLimits: { rpm: 30, rpd: null, tpm: null, tpd: null } },
            // A string ceiling would sail straight into the guardrail's `>` comparison.
            bad: { contextLength: "lots", maxOutputTokens: null, pricePromptPerToken: null, priceCompletionPerToken: null, rateLimits: null },
            // Nothing usable at all → not a "publishes limits" entry.
            hollow: { contextLength: null, maxOutputTokens: null, pricePromptPerToken: null, priceCompletionPerToken: null, rateLimits: null },
            // A garbage rate-limit block degrades per-axis to null; an all-null block is no block.
            junky: {
              contextLength: null, maxOutputTokens: null, pricePromptPerToken: null, priceCompletionPerToken: null,
              rateLimits: { rpm: "many", rpd: -5, tpm: 0, tpd: Number.NaN },
            },
            // Written by a version before pricing existed: the newer keys are absent, not null.
            older: { contextLength: 32768, maxOutputTokens: 8192 },
            // Written by a version before rate-limit harvesting existed.
            preRate: { contextLength: null, maxOutputTokens: null, pricePromptPerToken: 0, priceCompletionPerToken: 0 },
          },
        },
      }) + "\n",
    );

    const c = new ModelCatalog({ cachePath, ttlMs: 10_000 });
    expect(c.cachedLimits("p", "good")).toEqual({
      contextLength: 131072, maxOutputTokens: 4096, pricePromptPerToken: 0, priceCompletionPerToken: 0,
      rateLimits: { rpm: 30, rpd: null, tpm: null, tpd: null },
    });
    expect(c.cachedLimits("p", "bad")).toBeNull();
    expect(c.cachedLimits("p", "hollow")).toBeNull();
    // Every axis of the junk block is non-numeric/negative/zero → no block at all, and nothing
    // else was published either → not a "publishes limits" entry.
    expect(c.cachedLimits("p", "junky")).toBeNull();
    expect(c.publishedRateLimits("p", "junky")).toBeNull();
    // An older-schema row keeps what it really had and reports the rest as unknown — explicit
    // nulls, so `resolveMetadata()` sees "unpublished" rather than a hollow object of undefineds.
    expect(c.cachedLimits("p", "older")).toEqual({
      contextLength: 32768, maxOutputTokens: 8192, pricePromptPerToken: null, priceCompletionPerToken: null,
      rateLimits: null,
    });
    // A row from before rate-limit harvesting existed keeps its pricing and reads no block at all.
    expect(c.publishedRateLimits("p", "preRate")).toBeNull();
    expect(c.cachedLimits("p", "preRate")).toEqual({
      contextLength: null, maxOutputTokens: null, pricePromptPerToken: 0, priceCompletionPerToken: 0,
      rateLimits: null,
    });
    // The models list still loads warm — sanitizing limits must not cost the cache its purpose.
    expect(await c.list("p", provider, { now: 2000, fetchFn: throwFetch() }))
      .toEqual(["good", "bad", "hollow", "junky", "older", "preRate"]);
  });

  it("harvests published rate limits through the generic alias lists (spec §4 rung 2)", async () => {
    const fetchFn = (async () =>
      new Response(
        JSON.stringify({
          data: [
            // Long-form names at the top level.
            { id: "long/one", requests_per_minute: 60, requests_per_day: 1000, tokens_per_minute: 90000, tokens_per_day: 200000 },
            // Short forms, mixed with an untouched context figure.
            { id: "short/one", rpm: 30, rpd: 500, tpm: 50000, tpd: 150000, context_window: 131072 },
            // One level of nesting under each wrapper spelling providers actually use.
            { id: "nested/rate_limit", rate_limit: { requests_per_minute: 10, tokens_per_minute: 40000 } },
            { id: "nested/rate_limits", rate_limits: { rpm: 20, rpd: 800 } },
            { id: "nested/limits", limits: { tpm: 60000 } },
          ],
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      )) as unknown as typeof fetch;
    const catalog = new ModelCatalog({ cachePath: null });
    await catalog.list("rl", provider, { fetchFn });

    expect(catalog.publishedRateLimits("rl", "long/one")).toEqual({ rpm: 60, rpd: 1000, tpm: 90000, tpd: 200000 });
    expect(catalog.publishedRateLimits("rl", "short/one")).toEqual({ rpm: 30, rpd: 500, tpm: 50000, tpd: 150000 });
    expect(catalog.publishedRateLimits("rl", "nested/rate_limit")).toEqual({ rpm: 10, rpd: null, tpm: 40000, tpd: null });
    expect(catalog.publishedRateLimits("rl", "nested/rate_limits")).toEqual({ rpm: 20, rpd: 800, tpm: null, tpd: null });
    expect(catalog.publishedRateLimits("rl", "nested/limits")).toEqual({ rpm: null, rpd: null, tpm: 60000, tpd: null });
    // The context figure on the same record still harvests beside them.
    expect(catalog.cachedLimits("rl", "short/one")?.contextLength).toBe(131072);
  });

  it("declines to guess a rate limit the record did not clearly publish", async () => {
    const fetchFn = (async () =>
      new Response(
        JSON.stringify({
          data: [
            // A bare "limit" has no stated period; binding it would fabricate a ceiling.
            { id: "bare/limit", limit: 60, requests: 60 },
            // Zero / negative / non-numeric are not ceilings.
            { id: "junk/values", rpm: 0, rpd: -5, tpm: "many" },
            // A same-named leaf under an UNRELATED parent must not bind via deep matching.
            { id: "deep/mismatch", nested: { nested: { rpm: 99 } }, wrapper: { rpm: 77 } },
            // Publishes nothing rate-limit-shaped at all (NIM's shape).
            { id: "plain/model", object: "model", owned_by: "x" },
          ],
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      )) as unknown as typeof fetch;
    const catalog = new ModelCatalog({ cachePath: null });
    await catalog.list("ng", provider, { fetchFn });

    for (const model of ["bare/limit", "junk/values", "deep/mismatch", "plain/model"]) {
      expect(catalog.publishedRateLimits("ng", model), model).toBeNull();
    }
    // Unknown provider/model → null too; the accessor reads only the cache.
    expect(catalog.publishedRateLimits("nope", "nope")).toBeNull();
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

describe("disk loader validation (Change 3)", () => {
  it("rejects a non-finite fetchedAt and does NOT serve it as permanently fresh", async () => {
    const cachePath = join(dir, "infinity-fetchedAt.json");
    // ⚠ The fixture MUST be raw JSON text. `JSON.stringify({ fetchedAt: 1e309 })` emits
    // `{"fetchedAt":null}` — the spec has no Infinity literal — so a stringify-built fixture
    // never contains the value under test, and the test passes before AND after the fix while
    // appearing to pin it. `JSON.parse` does read `1e309` back as Infinity, which is exactly how
    // a corrupt cache acquires one.
    writeFileSync(cachePath, '{"p":{"fetchedAt":1e309,"models":["should-not-appear"]}}\n');

    const c = new ModelCatalog({ cachePath, ttlMs: 10_000 });
    // Pre-fix: `typeof Infinity === "number"` admits the entry, and `now - Infinity` is -Infinity,
    // which is < ttlMs — so the stale entry reads as fresh forever and the cached list is served.
    const models = await c.list("p", provider, { now: 2000, fetchFn: okFetch(["fresh-model"]) });
    expect(models).toEqual(["fresh-model"]);
    expect(models).not.toContain("should-not-appear");
  });

  it("still serves a finite in-TTL cache from disk without refetching", async () => {
    // The control for the guard above: `Number.isFinite` must not reject a good timestamp.
    const cachePath = join(dir, "finite-fetchedAt.json");
    writeFileSync(cachePath, '{"p":{"fetchedAt":1000,"models":["cached-model"]}}\n');

    const c = new ModelCatalog({ cachePath, ttlMs: 10_000 });
    const models = await c.list("p", provider, {
      now: 2000,
      fetchFn: () => { throw new Error("must not refetch an in-TTL cache"); },
    });
    expect(models).toEqual(["cached-model"]);
  });

  it("bounds model id length on disk path (MAX_MODEL_ID_CHARS)", async () => {
    const cachePath = join(dir, "long-ids.json");
    const longId = "m".repeat(300);
    writeFileSync(cachePath, JSON.stringify({
      p: {
        fetchedAt: 1000,
        models: ["good-model", longId],
      },
    }) + "\n");

    const c = new ModelCatalog({ cachePath, ttlMs: 10_000 });
    const models = await c.list("p", provider, { now: 2000, fetchFn: throwFetch() });
    // Only good-model should load; longId is filtered out
    expect(models).toEqual(["good-model"]);
  });

  it("bounds model count on disk path (MAX_CATALOG_MODELS)", async () => {
    const cachePath = join(dir, "too-many-models.json");
    const tooMany = Array.from({ length: 6000 }, (_, i) => `model-${i}`);
    writeFileSync(cachePath, JSON.stringify({
      p: {
        fetchedAt: 1000,
        models: tooMany,
      },
    }) + "\n");

    const c = new ModelCatalog({ cachePath, ttlMs: 10_000 });
    const models = await c.list("p", provider, { now: 2000, fetchFn: throwFetch() });
    expect(models.length).toBe(5000); // capped at MAX_CATALOG_MODELS
  });
});
