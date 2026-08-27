import { describe, expect, it } from "vitest";
import { fetchProviderQuota } from "../src/ping/quota.js";
import type { ProviderConfig } from "../src/config.js";

/**
 * A minimal ProviderConfig; only `base` matters to the gating under test.
 *
 * Deliberately NOT cast. `tsconfig.test.json` type-checks this file, and a cast here would
 * re-open exactly the hole that check exists to close: a hand-built provider literal asserting
 * against a shape the source no longer has.
 */
function provider(base: string): ProviderConfig {
  return {
    base,
    kind: "openai",
    authEnv: "TEST_KEY",
    authHeader: "authorization",
    timeoutMs: 0,
  };
}

/** A fetchFn that must never be called — the credential must not egress. */
function mustNotFetch(): typeof fetch {
  return (() => {
    throw new Error("fetchFn was called; the credential must NOT egress");
  }) as unknown as typeof fetch;
}

describe("ping/quota host gating (Defect A)", () => {
  it("does NOT send a credential to openrouter.ai when the name contains 'openrouter' but the base is a different host", async () => {
    // providerName includes "openrouter" but base points at another host entirely.
    // Old substring test on `providerName` would have matched — credential egress.
    const info = await fetchProviderQuota(
      "openrouter-proxy",
      provider("https://api.otherrouter.example.test/api/v1"),
      "sk-test-secret",
      mustNotFetch(),
    );
    // Falls through to the generic branch (ok, no quota fields) — no fetch happened.
    expect(info.ok).toBe(true);
    expect(info.quotaPercent).toBeUndefined();
    expect(info.limitUsd).toBeUndefined();
  });

  it("does NOT send a credential when the base is a substring-mimic (openrouter.ai.example.test)", async () => {
    // cfg.base.includes("openrouter.ai") is true for openrouter.ai.example.test.
    // Old substring test on `cfg.base` would have matched — credential egress.
    const info = await fetchProviderQuota(
      "whatever",
      provider("https://openrouter.ai.example.test/api/v1"),
      "sk-test-secret",
      mustNotFetch(),
    );
    expect(info.ok).toBe(true);
    expect(info.quotaPercent).toBeUndefined();
    expect(info.limitUsd).toBeUndefined();
  });

  it("a genuine openrouter.ai base still uses the OpenRouter auth-key API with the caller's origin", async () => {
    let seenUrl: string | undefined;
    let seenAuth: string | undefined;
    const fetchFn = (async (url: string | URL | Request, init?: RequestInit) => {
      seenUrl = String(url);
      seenAuth = (init?.headers as Record<string, string>)?.Authorization;
      return new Response(
        JSON.stringify({ data: { limit: 10, usage: 2.5 } }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      );
    }) as unknown as typeof fetch;

    const info = await fetchProviderQuota(
      "openrouter",
      provider("https://openrouter.ai/api/v1"),
      "sk-test-secret",
      fetchFn,
    );
    expect(info.ok).toBe(true);
    expect(seenUrl).toBe("https://openrouter.ai/api/v1/auth/key");
    expect(seenAuth).toBe("Bearer sk-test-secret");
    expect(info.quotaPercent).not.toBeNull();
  });

  it("rejects a base that is not a URL at all (fail closed, no egress)", async () => {
    const info = await fetchProviderQuota(
      "openrouter",
      provider("not-a-url"),
      "sk-test-secret",
      mustNotFetch(),
    );
    expect(info.ok).toBe(true);
    expect(info.quotaPercent).toBeUndefined();
  });
});
