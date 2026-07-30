import { describe, it, expect } from "vitest";
import { validateProviderKeys } from "../src/key-checker.js";
import type { Config } from "../src/config.js";

describe("key-checker", () => {
  const baseConfig: Config = {
    host: "127.0.0.1",
    port: 8791,
    providers: {
      mockProv: {
        base: "http://mock.provider",
        kind: "openai",
        authEnv: "MOCK_PROV_KEY",
        authHeader: "authorization",
        timeoutMs: 1000,
      },
    },
    routing: { default: "mockProv/model-x", tiers: {} },
    mode: "detect",
    repair: { maxAttempts: 2, destructiveTools: [] },
    log: { level: "silent", file: null },
  };

  /**
   * The bug this guards: several providers (OpenRouter among them) serve /models WITHOUT
   * auth, so a revoked key still returned the full catalogue and the check reported VALID
   * while every real request 401'd. A public /models is not evidence about a key.
   */
  describe("when /models is served publicly", () => {
    it("does not trust a 200 from /models — escalates and catches a revoked key", async () => {
      process.env.MOCK_PROV_KEY = "revoked";
      const seen: string[] = [];
      const mockFetch = (async (url: string, init?: RequestInit) => {
        seen.push(`${init?.method ?? "GET"} ${url}`);
        if (url.endsWith("/models")) {
          // 200 with or without credentials — the endpoint is public.
          return new Response(JSON.stringify({ data: [{ id: "m" }] }), { status: 200 });
        }
        return new Response(JSON.stringify({ error: "User not found." }), { status: 401 });
      }) as unknown as typeof fetch;

      const results = await validateProviderKeys(baseConfig, mockFetch);
      // Anonymous gets the same 401, so "revoked key" and "model not on this plan" are
      // indistinguishable here — report that honestly rather than accusing the key.
      expect(results[0]?.status).toBe("unverified");
      expect(seen.some((s) => s.startsWith("POST"))).toBe(true);
    });

    it("confirms a good key via the authenticated probe", async () => {
      process.env.MOCK_PROV_KEY = "good";
      const mockFetch = (async (url: string) => {
        if (url.endsWith("/models")) return new Response(JSON.stringify({ data: [{ id: "m" }] }), { status: 200 });
        return new Response(JSON.stringify({ choices: [] }), { status: 200 });
      }) as unknown as typeof fetch;

      const results = await validateProviderKeys(baseConfig, mockFetch);
      expect(results[0]?.status).toBe("valid");
      expect(results[0]?.message).toContain("authenticated probe");
    });

    // A 400/404 from the completion endpoint means the throwaway model id was rejected —
    // which can only happen after the request authenticated. That is a pass, not a failure.
    it("treats a rejected request as proof the key authenticated", async () => {
      process.env.MOCK_PROV_KEY = "good";
      const mockFetch = (async (url: string) => {
        if (url.endsWith("/models")) return new Response(JSON.stringify({ data: [{ id: "m" }] }), { status: 200 });
        return new Response(JSON.stringify({ error: "bad request" }), { status: 400 });
      }) as unknown as typeof fetch;

      expect((await validateProviderKeys(baseConfig, mockFetch))[0]?.status).toBe("valid");
    });
    // Prefers a model the config actually routes to this provider (see routedModelsByProvider);
    // falls back to the catalogue's first entry.
    it("prefers a model this config routes to the provider", async () => {
      process.env.MOCK_PROV_KEY = "good";
      let probedModel: string | undefined;
      const mockFetch = (async (url: string, init?: RequestInit) => {
        if (url.endsWith("/models")) {
          return new Response(JSON.stringify({ data: [{ id: "premium-first" }] }), { status: 200 });
        }
        probedModel = JSON.parse(String(init?.body)).model;
        return new Response("{}", { status: 200 });
      }) as unknown as typeof fetch;

      await validateProviderKeys(
        { ...baseConfig, routing: { default: "mockProv/model-x", tiers: {} } } as Config,
        mockFetch,
      );
      expect(probedModel).toBe("model-x");
    });

    // Escalation probes with a REAL id from the catalogue: a made-up one makes some
    // providers 401 (false bad-key) and others hang until timeout (false unreachable).
    it("probes using a real model id from the provider's own catalogue", async () => {
      process.env.MOCK_PROV_KEY = "good";
      let probedModel: string | undefined;
      const mockFetch = (async (url: string, init?: RequestInit) => {
        if (url.endsWith("/models")) {
          return new Response(JSON.stringify({ data: [{ id: "real-model-1" }, { id: "b" }] }), { status: 200 });
        }
        probedModel = JSON.parse(String(init?.body)).model;
        return new Response("{}", { status: 200 });
      }) as unknown as typeof fetch;

      await validateProviderKeys(
        { ...baseConfig, routing: { default: "other/x", tiers: {} } } as unknown as Config,
        mockFetch,
      );
      expect(probedModel).toBe("real-model-1");
    });

    /**
     * A 401/403 on the probe is ambiguous: free-tier rosters list premium models the key
     * legitimately cannot touch. Observed live — ollama-cloud answered 403 keyed vs 401
     * anonymous (key worked, model gated), while opencode answered 401 both ways.
     */
    it("treats a changed status vs anonymous as proof the key authenticated", async () => {
      process.env.MOCK_PROV_KEY = "good";
      const mockFetch = (async (url: string, init?: RequestInit) => {
        if (url.endsWith("/models")) {
          return new Response(JSON.stringify({ data: [{ id: "premium" }] }), { status: 200 });
        }
        const hasAuth = Boolean((init?.headers as Record<string, string> | undefined)?.["authorization"]);
        return new Response("no", { status: hasAuth ? 403 : 401 });
      }) as unknown as typeof fetch;

      const results = await validateProviderKeys(baseConfig, mockFetch);
      expect(results[0]?.status).toBe("valid");
      expect(results[0]?.message).toMatch(/not being available on this plan/);
    });

    // Identical answers with and without the key teach us nothing — say so rather than
    // accuse a key that may well be fine.
    it("reports unverified when the key changes nothing, instead of calling it invalid", async () => {
      process.env.MOCK_PROV_KEY = "unknown";
      const mockFetch = (async (url: string) => {
        if (url.endsWith("/models")) {
          return new Response(JSON.stringify({ data: [{ id: "premium" }] }), { status: 200 });
        }
        return new Response("no", { status: 401 });
      }) as unknown as typeof fetch;

      const results = await validateProviderKeys(baseConfig, mockFetch);
      expect(results[0]?.status).toBe("unverified");
    });

    it("still reports rate limiting as its own state", async () => {
      process.env.MOCK_PROV_KEY = "good";
      const mockFetch = (async (url: string) => {
        if (url.endsWith("/models")) {
          return new Response(JSON.stringify({ data: [{ id: "m" }] }), { status: 200 });
        }
        return new Response("slow down", { status: 429 });
      }) as unknown as typeof fetch;

      expect((await validateProviderKeys(baseConfig, mockFetch))[0]?.status).toBe("rate_limited");
    });

    // Without a usable id, the listing verdict is the better evidence available.
    it("does not escalate when the catalogue lists no usable model id", async () => {
      process.env.MOCK_PROV_KEY = "good";
      let posts = 0;
      const mockFetch = (async (url: string, init?: RequestInit) => {
        if (init?.method === "POST") posts++;
        if (url.endsWith("/models")) return new Response(JSON.stringify({ data: [] }), { status: 200 });
        return new Response("{}", { status: 200 });
      }) as unknown as typeof fetch;

      const results = await validateProviderKeys(
        { ...baseConfig, routing: { default: "other/x", tiers: {} } } as unknown as Config,
        mockFetch,
      );
      expect(posts).toBe(0);
      expect(results[0]?.status).toBe("valid");
    });
  });

  it("trusts a 200 from /models when that endpoint IS auth-gated", async () => {
    process.env.MOCK_PROV_KEY = "good";
    let posts = 0;
    const mockFetch = (async (url: string, init?: RequestInit) => {
      if (init?.method === "POST") posts++;
      const hasAuth = Boolean((init?.headers as Record<string, string> | undefined)?.["authorization"]);
      if (url.endsWith("/models")) {
        return hasAuth
          ? new Response(JSON.stringify({ data: [{ id: "m" }] }), { status: 200 })
          : new Response("no", { status: 401 });
      }
      return new Response("{}", { status: 200 });
    }) as unknown as typeof fetch;

    const results = await validateProviderKeys(baseConfig, mockFetch);
    expect(results[0]?.status).toBe("valid");
    // No completion spent: the gated 200 already proved the key.
    expect(posts).toBe(0);
  });

  it("reports missing environment variable when unset", async () => {
    delete process.env.MOCK_PROV_KEY;
    const results = await validateProviderKeys(baseConfig);
    expect(results).toHaveLength(1);
    expect(results[0]?.status).toBe("missing_env");
    expect(results[0]?.hasEnvKey).toBe(false);
  });

  it("verifies provider key when present and endpoint responds 200", async () => {
    process.env.MOCK_PROV_KEY = "test-key-123";
    const mockFetch = (async () => {
      return new Response(JSON.stringify({ data: [{ id: "model-x" }] }), { status: 200 });
    }) as unknown as typeof fetch;

    const results = await validateProviderKeys(baseConfig, mockFetch);
    expect(results).toHaveLength(1);
    expect(results[0]?.status).toBe("valid");
    expect(results[0]?.modelsFound).toBe(1);
  });

  /**
   * The `missing_env` branch used to read the env var RAW (`process.env[name]`), and a
   * whitespace-only value is truthy — so a key pasted as a blank line slipped past the
   * check and went to the wire as an empty `x-api-key` / a bare `Bearer`, coming back as
   * "your key is broken" when the key was simply never set.
   */
  it("treats a whitespace-only env value as missing, not as a key", async () => {
    process.env.MOCK_PROV_KEY = "   \n";
    let calls = 0;
    const mockFetch = (async () => {
      calls++;
      return new Response("{}", { status: 200 });
    }) as unknown as typeof fetch;

    const results = await validateProviderKeys(baseConfig, mockFetch);
    expect(results[0]?.status).toBe("missing_env");
    expect(results[0]?.hasEnvKey).toBe(false);
    // and nothing blank was ever sent
    expect(calls).toBe(0);
  });

  describe("credential headers come from the shared builder", () => {
    const anthropicKind: Config = {
      ...baseConfig,
      providers: {
        mockProv: {
          base: "http://mock.provider",
          kind: "anthropic",
          authEnv: "MOCK_PROV_KEY",
          // Explicitly declared — config.ts defaults anthropic-kind to x-api-key, so this
          // is a deliberate override and the checker must honour it.
          authHeader: "authorization",
          timeoutMs: 1000,
        },
      },
    };

    it("honours an explicit authHeader instead of forcing x-api-key on anthropic-kind", async () => {
      process.env.MOCK_PROV_KEY = "sk-live";
      let seen: Record<string, string> = {};
      const mockFetch = (async (_url: string, init?: RequestInit) => {
        seen = (init?.headers ?? {}) as Record<string, string>;
        return new Response("{}", { status: 200 });
      }) as unknown as typeof fetch;

      await validateProviderKeys(anthropicKind, mockFetch);
      expect(seen["authorization"]).toBe("Bearer sk-live");
      expect(seen["x-api-key"]).toBeUndefined();
      // `anthropic-version` is a protocol header, not a credential — it stays keyed off kind.
      expect(seen["anthropic-version"]).toBe("2023-06-01");
    });

    it("trims the credential, so a key pasted with a trailing newline still authenticates", async () => {
      process.env.MOCK_PROV_KEY = "  sk-live \n";
      let seen: Record<string, string> = {};
      const mockFetch = (async (_url: string, init?: RequestInit) => {
        seen = (init?.headers ?? {}) as Record<string, string>;
        return new Response("{}", { status: 200 });
      }) as unknown as typeof fetch;

      await validateProviderKeys(anthropicKind, mockFetch);
      expect(seen["authorization"]).toBe("Bearer sk-live");
    });
  });

  /**
   * The check owns its own wall clock. The per-request AbortSignal is only a hint to
   * whatever `fetchFn` was injected, the quota fetch takes none at all, and one provider
   * chains up to five requests — so without this a black-holing host stalls the command.
   */
  it("bounds a provider that never answers, and calls it unreachable — not invalid", async () => {
    process.env.MOCK_PROV_KEY = "good";
    const hang = (() => new Promise<Response>(() => {})) as unknown as typeof fetch;

    const results = await validateProviderKeys(baseConfig, hang, { budgetMs: 20 });
    expect(results[0]?.status).toBe("unreachable");
    // Silence is not evidence about a credential.
    expect(results[0]?.status).not.toBe("invalid_key");
  });

  it("does not let one hanging provider hold up the others", async () => {
    process.env.MOCK_PROV_KEY = "good";
    process.env.OTHER_PROV_KEY = "good";
    const twoProviders: Config = {
      ...baseConfig,
      providers: {
        ...baseConfig.providers,
        deadDaemon: {
          base: "http://127.0.0.1:1",
          kind: "openai",
          authEnv: "OTHER_PROV_KEY",
          authHeader: "authorization",
          timeoutMs: 1000,
        },
      },
    };
    const mockFetch = (async (url: string) => {
      if (url.startsWith("http://127.0.0.1:1")) return new Promise<Response>(() => {});
      return new Response(JSON.stringify({ data: [{ id: "model-x" }] }), { status: 200 });
    }) as unknown as typeof fetch;

    const results = await validateProviderKeys(twoProviders, mockFetch, { budgetMs: 20 });
    // Result order still follows config order.
    expect(results.map((r) => r.provider)).toEqual(["mockProv", "deadDaemon"]);
    expect(results[0]?.status).toBe("valid");
    expect(results[1]?.status).toBe("unreachable");
    delete process.env.OTHER_PROV_KEY;
  });

  /**
   * `message` is what `llm-relay keys` prints. It describes outcomes — an env-var NAME, an
   * HTTP status, a quota percent — and must never carry the credential. Interpolating a
   * raw `(e as Error).message` broke that: error text is uncontrolled and routinely echoes
   * the request (a key in a query string, a proxy quoting the failing URL, an injected
   * fetchFn stringifying its own init).
   */
  describe("diagnostics never carry the credential", () => {
    const KEY = "sk-verysecretkeyvalue";
    /** No 4-character window of the key may appear anywhere in the text. */
    const leaks = (text: string): boolean => {
      for (let i = 0; i + 4 <= KEY.length; i++) {
        if (text.includes(KEY.slice(i, i + 4))) return true;
      }
      return false;
    };

    it("scrubs a thrown error that quotes the key", async () => {
      process.env.MOCK_PROV_KEY = KEY;
      const mockFetch = (async (url: string) => {
        throw new Error(`request to ${url}?api_key=${KEY} failed, reason: getaddrinfo ENOTFOUND`);
      }) as unknown as typeof fetch;

      const results = await validateProviderKeys(baseConfig, mockFetch);
      expect(results[0]?.status).toBe("unreachable");
      expect(leaks(results[0]?.message ?? "")).toBe(false);
      // Still says something useful about WHY.
      expect(results[0]?.message).toMatch(/network error/i);
    });

    it("keeps the error CLASS when it is a bare identifier", async () => {
      process.env.MOCK_PROV_KEY = KEY;
      const mockFetch = (async () => {
        const e = new TypeError("fetch failed");
        (e as unknown as { cause: { code: string } }).cause = { code: "ECONNREFUSED" };
        throw e;
      }) as unknown as typeof fetch;

      const results = await validateProviderKeys(baseConfig, mockFetch);
      expect(results[0]?.message).toContain("ECONNREFUSED");
      expect(leaks(results[0]?.message ?? "")).toBe(false);
    });

    it("keeps no key in the message on any verdict, including unverified", async () => {
      process.env.MOCK_PROV_KEY = KEY;
      const mockFetch = (async (url: string) => {
        if (url.endsWith("/models")) {
          return new Response(JSON.stringify({ data: [{ id: "premium" }] }), { status: 200 });
        }
        return new Response(`no such key ${KEY}`, { status: 401 });
      }) as unknown as typeof fetch;

      const results = await validateProviderKeys(baseConfig, mockFetch);
      // `unverified` is still reachable: identical answers with and without the key.
      expect(results[0]?.status).toBe("unverified");
      expect(results[0]?.message).toContain("401");
      expect(leaks(results[0]?.message ?? "")).toBe(false);
    });
  });
});
