import { contextWindowResolver } from "../src/metadata.js";
import { describe, it, expect } from "vitest";
import { assessCost, estimateRequestTokens, resolveMetadata } from "../src/metadata.js";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { limitsFromRecord, ModelCatalog } from "../src/catalog.js";
import { createProxy } from "../src/server.js";
import type { ProviderConfig } from "../src/config.js";

describe("metadata", () => {
  it("estimates request token count accurately", () => {
    const req = {
      system: "You are a helpful coding assistant.",
      messages: [
        { role: "user", content: "Hello, world!" },
        { role: "assistant", content: "Hi there! How can I help you write code today?" },
      ],
    };
    const tokens = estimateRequestTokens(req);
    expect(tokens).toBeGreaterThan(15);
    expect(tokens).toBeLessThan(50);
  });

  it("counts tool schemas and tool_use inputs — they consume real upstream context", () => {
    // Before unification the guardrail's estimator ignored `tools` entirely, so a
    // Claude-Code-sized tool roster (tens of kilotokens) was invisible to pruning.
    const bare = { messages: [{ role: "user", content: "hi" }] };
    const withTools = {
      ...bare,
      tools: [{ name: "search", description: "d".repeat(4000), input_schema: { type: "object" } }],
    };
    expect(estimateRequestTokens(withTools)).toBeGreaterThan(estimateRequestTokens(bare) + 900);

    const withToolUse = {
      messages: [
        { role: "assistant", content: [{ type: "tool_use", id: "t1", name: "search", input: { q: "x".repeat(2000) } }] },
      ],
    };
    expect(estimateRequestTokens(withToolUse)).toBeGreaterThan(400);
  });

  it("excludes base64 payloads — a blob's byte length says nothing about its token cost", () => {
    // The old count_tokens-side walker counted image data as text, so a 1MB image
    // read as ~350k "tokens" and would have pruned every candidate had the
    // guardrail used it. The `data` field is skipped; surrounding text still counts.
    const text = "Describe this image for me please.";
    const withImage = {
      messages: [
        {
          role: "user",
          content: [
            { type: "image", source: { type: "base64", media_type: "image/png", data: "A".repeat(100_000) } },
            { type: "text", text },
          ],
        },
      ],
    };
    const est = estimateRequestTokens(withImage);
    expect(est).toBeLessThan(100); // nowhere near 25k — the blob did not count
    expect(est).toBeGreaterThan(Math.floor(text.length / 4) - 1); // the text did
  });

  it("counts OpenAI Responses `instructions` and `input` — the front's other wire shape", () => {
    // The guardrail runs on the OpenAI front too (0.17.0). Chat shares `messages`+`tools`
    // with the Anthropic shape, but a Responses body carries its prompt here instead — an
    // estimator blind to these fields would report ~0 and never prune on that path.
    const responses = {
      instructions: "s".repeat(2000),
      input: [{ role: "user", content: [{ type: "input_text", text: "x".repeat(2000) }] }],
    };
    expect(estimateRequestTokens(responses)).toBeGreaterThan(900);
    expect(estimateRequestTokens({ input: "just a plain string input" })).toBeGreaterThan(4);
  });

  it("excludes base64 data: URLs — the OpenAI shapes inline media there, not in a `data` field", () => {
    // Same blob, different envelope: OpenAI Chat/Responses put base64 images in a
    // `url`/`image_url` STRING, so the Anthropic-side `data`-key skip never fires. A 1MB
    // image counted as text would prune every candidate the moment the guardrail covered
    // the front.
    const text = "Describe this image for me please.";
    const withImage = {
      messages: [
        {
          role: "user",
          content: [
            { type: "image_url", image_url: { url: "data:image/png;base64," + "A".repeat(100_000) } },
            { type: "text", text },
          ],
        },
      ],
    };
    const est = estimateRequestTokens(withImage);
    expect(est).toBeLessThan(100); // the data URL did not count
    expect(est).toBeGreaterThan(Math.floor(text.length / 4) - 1); // the text did
  });
});

describe("assessCost — the one definition of free", () => {
  it("a published positive price is paid, and beats a free-sounding name", () => {
    expect(assessCost("some/model:free", { pricePromptPerToken: 1e-7, priceCompletionPerToken: null }))
      .toEqual({ costClass: "paid", basis: "published-price" });
  });

  it("a published zero/zero price is free", () => {
    expect(assessCost("m", { pricePromptPerToken: 0, priceCompletionPerToken: 0 }))
      .toEqual({ costClass: "free", basis: "published-price" });
  });

  it("a free-labelled id is free when nothing priced contradicts it", () => {
    expect(assessCost("deepseek/deepseek-r1:free", null))
      .toEqual({ costClass: "free", basis: "free-labelled" });
    // "free" must be a separated token, not a substring — "freeform" is not a price claim.
    expect(assessCost("freeform-model", null).costClass).toBe("unknown");
  });

  it("a free-tier provider vouches for its unpriced models", () => {
    expect(assessCost("anything", null, "free")).toEqual({ costClass: "free", basis: "provider-tier" });
  });

  it("no evidence is UNKNOWN — its own class, never silently free", () => {
    expect(assessCost("m", { pricePromptPerToken: null, priceCompletionPerToken: null }))
      .toEqual({ costClass: "unknown", basis: "unpublished" });
  });
});

describe("per-provider limits", () => {
  it("reads limits out of the field names different providers actually use", () => {
    // Groq
    expect(limitsFromRecord({ id: "x", context_window: 131072, max_completion_tokens: 32768, pricing: { prompt: "0.00000015", completion: "0.0000006" } }))
      .toEqual({ contextLength: 131072, maxOutputTokens: 32768, pricePromptPerToken: 1.5e-7, priceCompletionPerToken: 6e-7 });
    // Mistral — publishes context only
    expect(limitsFromRecord({ id: "x", max_context_length: 32768 }))
      .toEqual({ contextLength: 32768, maxOutputTokens: null, pricePromptPerToken: null, priceCompletionPerToken: null });
    // OpenRouter — top-level context, per-deployment ceiling nested under top_provider
    expect(limitsFromRecord({ id: "x", context_length: 1048576, top_provider: { max_completion_tokens: 65536 } }))
      .toEqual({ contextLength: 1048576, maxOutputTokens: 65536, pricePromptPerToken: null, priceCompletionPerToken: null });
    // A free tier publishes 0 — a real price, not "unpublished".
    expect(limitsFromRecord({ id: "x", pricing: { prompt: "0", completion: "0" } }).pricePromptPerToken).toBe(0);
    // NIM — publishes nothing but id/object/created/owned_by
    expect(limitsFromRecord({ id: "z-ai/glm-5.2", object: "model", owned_by: "z-ai" }))
      .toEqual({ contextLength: null, maxOutputTokens: null, pricePromptPerToken: null, priceCompletionPerToken: null });
  });

  it("treats a BLANK published price as unpublished, not as free", () => {
    // `Number("")` and `Number("   ")` are both 0, and 0 is a legitimate price (free tiers), so a
    // provider that emits the key with an empty value used to be reported as costing ZERO —
    // a fabricated measurement a caller cannot tell from a real free tier.
    const blank = limitsFromRecord({ id: "x", pricing: { prompt: "", completion: "   " } });
    expect(blank.pricePromptPerToken).toBeNull();
    expect(blank.priceCompletionPerToken).toBeNull();
    // A genuinely published 0 is still 0 — the distinction is the whole point.
    expect(limitsFromRecord({ id: "x", pricing: { prompt: "0", completion: 0 } }))
      .toMatchObject({ pricePromptPerToken: 0, priceCompletionPerToken: 0 });
    // And a record whose ONLY "figures" were blank publishes nothing at all, so the catalog
    // reports null rather than caching a hollow entry that reads as "this provider publishes limits".
    expect(blank).toEqual({ contextLength: null, maxOutputTokens: null, pricePromptPerToken: null, priceCompletionPerToken: null });
  });

  it("reports null — not a hollow object — when a blank-priced record is all a provider publishes", async () => {
    const catalog = new ModelCatalog({ cachePath: null });
    const fetchFn = (async () =>
      new Response(JSON.stringify({ data: [{ id: "shared/model-a", object: "model", pricing: { prompt: "", completion: "" } }] }), {
        status: 200,
        headers: { "content-type": "application/json" },
      })) as unknown as typeof fetch;
    const cfg: ProviderConfig = { base: "http://blank.test/v1", kind: "openai", authHeader: "authorization", timeoutMs: 5000 };
    expect(await catalog.limits("blank", cfg, "shared/model-a", { fetchFn })).toBeNull();
  });

  it("keeps limits per (provider, model) — the same id on two providers is two deployments", async () => {
    const cfg = (base: string): ProviderConfig => ({
      base, kind: "openai", authHeader: "authorization", timeoutMs: 5000,
    });
    const catalog = new ModelCatalog({ cachePath: null });
    const fetchFn = (async (url: string | URL) => {
      const isGroqish = String(url).includes("rich");
      return new Response(
        JSON.stringify({
          data: isGroqish
            ? [{ id: "shared/model-a", context_window: 131072, max_completion_tokens: 32768 }]
            : [{ id: "shared/model-a", object: "model" }], // publishes nothing
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    }) as unknown as typeof fetch;

    const rich = await catalog.limits("rich", cfg("http://rich.test/v1"), "shared/model-a", { fetchFn });
    const bare = await catalog.limits("bare", cfg("http://bare.test/v1"), "shared/model-a", { fetchFn });

    expect(rich).toEqual({ contextLength: 131072, maxOutputTokens: 32768, pricePromptPerToken: null, priceCompletionPerToken: null });
    // null, NOT the other provider's numbers — that conflation is the bug this guards.
    expect(bare).toBeNull();
  });
});

describe("context guardrail", () => {
  const cfgFor = (base: string) => ({
    host: "127.0.0.1", port: 0,
    providers: { nim: { base, kind: "openai" as const, authHeader: "authorization" as const, timeoutMs: 5000 } },
    routing: { default: "nim/small/model", tiers: {}, benchmarkSort: false },
    mode: "detect" as const,
    repair: { maxAttempts: 2, destructiveTools: [] },
    log: { level: "silent" as const, file: null },
  });

  const listen = async (s: Server): Promise<number> =>
    new Promise((r) => s.listen(0, "127.0.0.1", () => r((s.address() as AddressInfo).port)));

  const send = (port: number, words: number) =>
    fetch(`http://127.0.0.1:${port}/v1/messages`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        model: "nim/small/model",
        max_tokens: 16,
        messages: [{ role: "user", content: "lorem ipsum ".repeat(words) }],
      }),
    });

  it("enforces only the limit the SERVING provider published, and passes through when unknown", async () => {
    const servers: Server[] = [];
    try {
      // Upstream doubles as the provider's own /models endpoint.
      let publishLimits = true;
      const upstream = createServer((req, res) => {
        res.writeHead(200, { "content-type": "application/json" });
        if ((req.url ?? "").includes("/models")) {
          res.end(JSON.stringify({
            data: [{ id: "small/model", ...(publishLimits ? { context_window: 50 } : {}) }],
          }));
        } else {
          res.end(JSON.stringify({
            id: "m",
            object: "chat.completion",
            model: "small/model",
            choices: [{ index: 0, message: { role: "assistant", content: "ok" }, finish_reason: "stop" }],
            usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
          }));
        }
      });
      servers.push(upstream);
      const upPort = await listen(upstream);

      const catalog = new ModelCatalog({ cachePath: null });
      const cfg = cfgFor(`http://127.0.0.1:${upPort}/v1`);
      const proxy = createProxy(cfg as never, { catalog });
      servers.push(proxy);
      const port = await listen(proxy);

      // Warm the catalog so cachedLimits() has something (it never fetches on the hot path).
      await catalog.list("nim", cfg.providers.nim);

      // Comfortably over the published 50-token ceiling → rejected, naming the provider.
      const over = await send(port, 400);
      expect(over.status).toBe(400);
      const body = (await over.json()) as { error: { message: string } };
      // The message names the provider AND the model: an unqualified "context limit" would
      // re-introduce exactly the ambiguity this change removes.
      expect(body.error.message).toContain('context limit "nim" publishes for "small/model" (50)');

      // Same oversized request against a provider that publishes NO limit: no local guardrail,
      // the request goes upstream and the backend gets to answer for itself.
      publishLimits = false;
      const bare = new ModelCatalog({ cachePath: null });
      const cfg2 = cfgFor(`http://127.0.0.1:${upPort}/v1`);
      const proxy2 = createProxy(cfg2 as never, { catalog: bare });
      servers.push(proxy2);
      const port2 = await listen(proxy2);
      await bare.list("nim", cfg2.providers.nim);

      expect((await send(port2, 400)).status).toBe(200);
    } finally {
      servers.forEach((s) => s.close());
    }
  });

  it("prunes candidates whose context length limit is exceeded while keeping eligible candidates", async () => {
    const servers: Server[] = [];
    try {
      const upstream1 = createServer((req, res) => {
        res.writeHead(200, { "content-type": "application/json" });
        if ((req.url ?? "").includes("/models")) {
          res.end(JSON.stringify({ data: [{ id: "model1", context_window: 50 }] }));
        } else {
          res.end(JSON.stringify({ id: "m1", model: "model1", choices: [{ message: { role: "assistant", content: "hi" }, finish_reason: "stop" }] }));
        }
      });
      const upstream2 = createServer((req, res) => {
        res.writeHead(200, { "content-type": "application/json" });
        if ((req.url ?? "").includes("/models")) {
          res.end(JSON.stringify({ data: [{ id: "model2", context_window: 1000 }] }));
        } else {
          res.end(JSON.stringify({ id: "m2", model: "model2", choices: [{ message: { role: "assistant", content: "hi" }, finish_reason: "stop" }] }));
        }
      });
      servers.push(upstream1, upstream2);
      const upPort1 = await listen(upstream1);
      const upPort2 = await listen(upstream2);

      const catalog = new ModelCatalog({ cachePath: null });
      const cfg = {
        host: "127.0.0.1", port: 0,
        providers: {
          p1: { base: `http://127.0.0.1:${upPort1}/v1`, kind: "openai" as const, authHeader: "authorization" as const, timeoutMs: 5000 },
          p2: { base: `http://127.0.0.1:${upPort2}/v1`, kind: "openai" as const, authHeader: "authorization" as const, timeoutMs: 5000 },
        },
        routing: { default: "pool/pool", pools: { pool: ["p1/model1", "p2/model2"] }, tiers: {}, benchmarkSort: false },
        mode: "detect" as const,
        repair: { maxAttempts: 2, destructiveTools: [] },
        log: { level: "silent" as const, file: null },
      };

      const proxy = createProxy(cfg as never, { catalog });
      servers.push(proxy);
      const port = await listen(proxy);

      await catalog.list("p1", cfg.providers.p1);
      await catalog.list("p2", cfg.providers.p2);

      // 400 words ~ 100+ tokens. Exceeds p1 (50), but fits p2 (1000).
      // Should prune p1 and succeed on p2.
      const res = await fetch(`http://127.0.0.1:${port}/v1/messages`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          model: "pool/pool",
          max_tokens: 16,
          messages: [{ role: "user", content: "lorem ipsum ".repeat(40) }],
        }),
      });
      expect(res.status).toBe(200);
      const body = (await res.json()) as { model?: string };
      expect(body.model).toBe("model2");
    } finally {
      servers.forEach((s) => s.close());
    }
  });
});

describe("resolveMetadata provenance", () => {
  it("prefers the provider's own published limits", () => {
    const m = resolveMetadata("z-ai/glm-5.2", {
      providerLimits: { contextLength: 200000, maxOutputTokens: 16384 },
      reference: { contextLength: 1048576, from: "openrouter" },
    });
    expect(m.contextLength).toBe(200000);
    expect(m.contextLengthSource).toBe("provider");
    expect(m.referenceFrom).toBeUndefined();
  });

  it("labels a borrowed figure as reference and names who it came from", () => {
    // NIM publishes nothing, so the only number available belongs to a DIFFERENT deployment.
    const m = resolveMetadata("z-ai/glm-5.2", {
      providerLimits: null,
      reference: { contextLength: 1048576, from: "openrouter" },
    });
    expect(m.contextLength).toBe(1048576);
    expect(m.contextLengthSource).toBe("reference");
    expect(m.referenceFrom).toBe("openrouter");
  });

  it("resolves each field independently — coverage is ragged", () => {
    // Mistral-shaped: real context, no output ceiling. The output figure must fall through
    // and be labelled separately rather than inheriting the context field's provenance.
    const m = resolveMetadata("some/model", {
      providerLimits: { contextLength: 32768, maxOutputTokens: null },
      reference: { maxOutputTokens: 8192, from: "openrouter" },
    });
    expect([m.contextLength, m.contextLengthSource]).toEqual([32768, "provider"]);
    expect([m.maxOutputTokens, m.maxOutputTokensSource]).toEqual([8192, "reference"]);
  });

  it("never reports another host's price as this one's, and invents none", () => {
    // Free on this provider, metered on the reference one. Reporting the reference price here
    // would be a straight factual error about what a call costs.
    const free = resolveMetadata("shared/model", {
      providerLimits: { contextLength: null, maxOutputTokens: null, pricePromptPerToken: 0, priceCompletionPerToken: 0 },
      reference: { pricePromptPerToken: 0.0000007, priceCompletionPerToken: 0.0000024, from: "openrouter" },
    });
    expect(free.pricePerMTokOut).toBe(0);
    expect(free.priceSource).toBe("provider");

    const borrowed = resolveMetadata("shared/model", {
      providerLimits: null,
      reference: { pricePromptPerToken: 0.0000007, priceCompletionPerToken: 0.0000024, from: "openrouter" },
    });
    expect(borrowed.pricePerMTokOut).toBeCloseTo(2.4); // per-token → per-million
    expect(borrowed.priceSource).toBe("reference");
    expect(borrowed.referenceFrom).toBe("openrouter");

    // No hardcoded price rung: unknown cost stays unknown rather than becoming a guess.
    const unknown = resolveMetadata("shared/model", { providerLimits: null, reference: null });
    expect(unknown.pricePerMTokOut).toBeNull();
    expect(unknown.priceSource).toBeNull();
  });

  it("reports UNKNOWN rather than guessing when nobody publishes a limit", () => {
    // There used to be a hardcoded table handing out a blanket 128k/4096 here. A guess that a
    // caller cannot distinguish from a measurement is worse than a null — and the context
    // guardrail in server.ts would reject real requests against an invented ceiling.
    const m = resolveMetadata("totally-unknown-model-xyz", { providerLimits: null, reference: null });
    expect(m.contextLength).toBeNull();
    expect(m.contextLengthSource).toBeNull();
    expect(m.maxOutputTokens).toBeNull();
    expect(m.maxOutputTokensSource).toBeNull();
  });
});

describe("contextWindowResolver — two rungs, both real publications", () => {
  const noSnapshot = () => null;

  it("prefers the SERVING provider's own published window", () => {
    const r = contextWindowResolver(
      (p, m) => (p === "nim" && m === "z-ai/glm-5.2" ? 131072 : null),
      () => ({ tokens: 1_000_000, match: "exact" as const }),
    );
    expect(r("nim/z-ai/glm-5.2")).toEqual({ tokens: 131072, source: "provider" });
  });

  it("falls back to the synced snapshot when the provider publishes nothing", () => {
    // This rung is what makes the feature usable at all: free providers publish little metadata
    // and NIM publishes none, so nearly every pool member would otherwise resolve to null.
    const r = contextWindowResolver(() => null, () => ({ tokens: 262144, match: "exact" as const }));
    expect(r("nim/z-ai/glm-5.2")).toEqual({ tokens: 262144, source: "snapshot" });
  });

  it("REJECTS a fuzzy snapshot match — a borrowed SKU's window is not this model's", () => {
    // `glm-5.2` containment-matching `glm-5.2-max` mis-ranks a pool when it is a capability score;
    // as a context window it tells a client it may send tokens the backend will reject.
    const r = contextWindowResolver(() => null, () => ({ tokens: 1_000_000, match: "fuzzy" as const }));
    expect(r("nim/z-ai/glm-5.2")).toBeNull();
  });

  it("has no guessed rung — unknown stays null", () => {
    expect(contextWindowResolver(() => null, noSnapshot)("nim/whatever")).toBeNull();
  });

  it("rejects non-positive and non-finite published values from either rung", () => {
    for (const bad of [0, -1, Number.NaN, Number.POSITIVE_INFINITY]) {
      expect(contextWindowResolver(() => bad, noSnapshot)("nim/m")).toBeNull();
      expect(
        contextWindowResolver(() => null, () => ({ tokens: bad, match: "exact" as const }))("nim/m"),
      ).toBeNull();
    }
  });

  it("still consults the snapshot for a bare provider spec with no model part", () => {
    const r = contextWindowResolver(() => 999, () => ({ tokens: 4096, match: "exact" as const }));
    expect(r("anthropic")).toEqual({ tokens: 4096, source: "snapshot" });
  });
});
