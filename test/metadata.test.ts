import { describe, it, expect } from "vitest";
import { estimateRequestTokens, resolveMetadata } from "../src/metadata.js";
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
          res.end(JSON.stringify({ id: "m", type: "message", role: "assistant", content: [], model: "small/model" }));
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
    expect(borrowed.pricePerMTokOut).toBe(2.4); // per-token → per-million
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
