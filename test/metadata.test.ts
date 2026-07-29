import { describe, it, expect } from "vitest";
import { getModelMetadata, estimateRequestTokens, resolveMetadata } from "../src/metadata.js";
import { limitsFromRecord, ModelCatalog } from "../src/catalog.js";
import type { ProviderConfig } from "../src/config.js";

describe("metadata", () => {
  it("looks up context window limits for models", () => {
    const meta = getModelMetadata("claude-3-7-sonnet");
    expect(meta.contextLength).toBe(200000);
    expect(meta.supportsThinking).toBe(true);
  });

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

  it("falls back to the hardcoded table last, and says so", () => {
    const m = resolveMetadata("totally-unknown-model-xyz", { providerLimits: null, reference: null });
    expect(m.contextLengthSource).toBe("static-table"); // the blanket 128k guess — labelled, not hidden
    expect(m.contextLength).toBe(128000);
  });
});
