import { describe, it, expect, afterAll } from "vitest";
import { writeFileSync, mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  loadConfig,
  resolveTarget,
  resolveTargets,
  reshaperForTarget,
  isSubagentRequest,
  subagentSpec,
  offloadRule,
  clientForPath,
} from "../src/config.js";
import { candidateEnvNames } from "../src/authEnv.js";

// Eager (not in beforeAll) so describe-body loadConfig(write(...)) calls work at collection.
const dir = mkdtempSync(join(tmpdir(), "rp-cfg-"));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

function write(name: string, obj: unknown): string {
  const p = join(dir, name);
  writeFileSync(p, JSON.stringify(obj));
  return p;
}

// A minimal valid multi-provider config: one openai provider + a default route.
function base(extra: Record<string, unknown> = {}) {
  return {
    listen: "127.0.0.1:8791",
    providers: { nim: { base: "https://nim.test/v1", kind: "openai", authEnv: "NVIDIA_API_KEY" } },
    routing: { default: "nim/z-ai/glm-5.2" },
    ...extra,
  };
}

function saveAndClearEnv(names: string[]): Record<string, string | undefined> {
  const saved: Record<string, string | undefined> = {};
  for (const name of names) {
    saved[name] = process.env[name];
    delete process.env[name];
  }
  return saved;
}

function restoreEnv(saved: Record<string, string | undefined>): void {
  for (const [name, value] of Object.entries(saved)) {
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
  }
}

const geminiEnvSaved = saveAndClearEnv(candidateEnvNames("gemini", "GEMINI_API_KEY"));

describe("loadConfig — sticky session affinity", () => {
  it("is off by default and normalizes boolean shorthand", () => {
    expect(loadConfig(write("sticky-absent.json", base())).routing.sticky).toBeUndefined();
    expect(loadConfig(write("sticky-on.json", base({
      routing: { default: "nim/z-ai/glm-5.2", sticky: true },
    }))).routing.sticky).toEqual({ enabled: true, ttlMs: 1_800_000, maxSessions: 1000 });
    expect(loadConfig(write("sticky-off.json", base({
      routing: { default: "nim/z-ai/glm-5.2", sticky: false },
    }))).routing.sticky).toEqual({ enabled: false, ttlMs: 1_800_000, maxSessions: 1000 });
  });

  it("validates and normalizes the bounded object form", () => {
    expect(loadConfig(write("sticky-object.json", base({
      routing: {
        default: "nim/z-ai/glm-5.2",
        sticky: { enabled: true, ttlMs: 2500.9, maxSessions: 20.9 },
      },
    }))).routing.sticky).toEqual({ enabled: true, ttlMs: 2500, maxSessions: 20 });

    const invalid = [
      ["sticky-kind.json", "yes", /boolean or an object/],
      ["sticky-enabled.json", {}, /sticky.enabled must be a boolean/],
      ["sticky-ttl-low.json", { enabled: true, ttlMs: 999 }, /ttlMs must be between/],
      ["sticky-ttl-high.json", { enabled: true, ttlMs: 86_400_001 }, /ttlMs must be between/],
      ["sticky-cap-low.json", { enabled: true, maxSessions: 9 }, /maxSessions must be an integer/],
      ["sticky-cap-high.json", { enabled: true, maxSessions: 100_001 }, /maxSessions must be an integer/],
    ] as const;
    for (const [name, sticky, message] of invalid) {
      expect(() => loadConfig(write(name, base({
        routing: { default: "nim/z-ai/glm-5.2", sticky },
      })))).toThrow(message);
    }
  });
});

describe("loadConfig — credentialMode (declared vs inferred passthrough)", () => {
  const withProviders = (name: string, providers: Record<string, unknown>) =>
    loadConfig(write(name, base({ providers, routing: { default: "anthropic" } })));

  it("warns when an anthropic-kind provider forwards the caller's credential by omission", () => {
    const c = withProviders("cred-inferred.json", {
      anthropic: { base: "https://api.anthropic.com", kind: "anthropic" },
    });
    // Warn, never fail: this proxy fronts every client session, so a hardening step that
    // refuses to start would be an outage.
    expect(c.warnings?.some((w) => /forwards the CALLER's own credential/.test(w))).toBe(true);
    expect(c.providers.anthropic!.credentialMode).toBeUndefined();
  });

  it("stays silent once the intent is declared, either way", () => {
    const pass = withProviders("cred-declared.json", {
      anthropic: { base: "https://api.anthropic.com", kind: "anthropic", credentialMode: "passthrough" },
    });
    expect(pass.warnings?.some((w) => /forwards the CALLER/.test(w)) ?? false).toBe(false);
    expect(pass.providers.anthropic!.credentialMode).toBe("passthrough");

    const contained = loadConfig(write("cred-contained.json", base({
      providers: { peer: { base: "https://peer.test", kind: "anthropic", credentialMode: "contained" } },
      routing: { default: "peer" },
    })));
    expect(contained.warnings?.some((w) => /forwards the CALLER/.test(w)) ?? false).toBe(false);
    expect(contained.providers.peer!.credentialMode).toBe("contained");
  });

  it("never warns for an openai-kind keyless provider — it cannot receive inbound credentials", () => {
    // `fetchBackend`'s openai path builds a fresh header map (`buildTargetHeaders`), so nothing
    // inbound reaches it. Warning about `ollama` would be a false alarm, and a false alarm here
    // teaches the operator to ignore the true one above.
    const c = loadConfig(write("cred-ollama.json", base({
      providers: { ollama: { base: "http://localhost:11434/v1", kind: "openai" } },
      routing: { default: "ollama/qwen2.5-coder:32b" },
    })));
    expect(c.warnings?.some((w) => /forwards the CALLER/.test(w)) ?? false).toBe(false);
  });

  it("rejects a provider that claims both credentialMode passthrough and its own authEnv", () => {
    expect(() => withProviders("cred-conflict.json", {
      anthropic: { base: "https://api.anthropic.com", kind: "anthropic", credentialMode: "passthrough", authEnv: "X_KEY" },
    })).toThrow(/declare exactly one/);
  });

  it("rejects an unrecognized credentialMode instead of silently ignoring it", () => {
    expect(() => withProviders("cred-typo.json", {
      anthropic: { base: "https://api.anthropic.com", kind: "anthropic", credentialMode: "contain" },
    })).toThrow(/credentialMode must be/);
  });

  it("carries the mode onto the resolved target", () => {
    const c = withProviders("cred-resolved.json", {
      anthropic: { base: "https://api.anthropic.com", kind: "anthropic", credentialMode: "passthrough" },
    });
    expect(resolveTarget("claude-opus-5", c).credentialMode).toBe("passthrough");
  });
});

describe("loadConfig — authEnv alias resolution", () => {
  it("keeps the declared authEnv when that variable is the one set", () => {
    process.env.GEMINI_API_KEY = "declared";
    const c = loadConfig(write("env-declared.json", base({
      providers: { gemini: { base: "https://g.test/v1", kind: "openai", authEnv: "GEMINI_API_KEY" } },
      routing: { default: "gemini/gemini-2.5-flash" },
    })));
    expect(c.providers.gemini!.authEnv).toBe("GEMINI_API_KEY");
    restoreEnv(geminiEnvSaved);
  });

  it("retains the declared authEnv when an alias supplies the credential", () => {
    delete process.env.GEMINI_API_KEY;
    process.env.GOOGLEAI_API_KEY = "alias";
    const c = loadConfig(write("env-alias.json", base({
      providers: { gemini: { base: "https://g.test/v1", kind: "openai", authEnv: "GEMINI_API_KEY" } },
      routing: { default: "gemini/gemini-2.5-flash" },
    })));
    expect(c.providers.gemini!.authEnv).toBe("GEMINI_API_KEY");
    restoreEnv(geminiEnvSaved);
  });
});

describe("loadConfig — blank authEnv", () => {
  it("omits blank and whitespace authEnv while preserving passthrough", () => {
    for (const authEnv of ["", "   "]) {
      const c = loadConfig(write(`blank-auth-${authEnv.length}.json`, base({
        providers: { peer: { base: "https://peer.test", kind: "anthropic", authEnv, credentialMode: "passthrough" } },
        routing: { default: "peer" },
      })));
      expect(c.providers.peer!.authEnv).toBeUndefined();
      expect(c.providers.peer!.credentialMode).toBe("passthrough");
    }
  });
});

describe("loadConfig — listen + providers", () => {
  it("accepts 127.0.0.1 and defaults provider authHeader/timeout", () => {
    const c = loadConfig(write("a.json", base()));
    expect(c.host).toBe("127.0.0.1");
    expect(c.port).toBe(8791);
    expect(c.providers.nim!.authHeader).toBe("authorization"); // openai default
    expect(c.providers.nim!.timeoutMs).toBe(120000);
  });

  it("preserves provider tier metadata used by automatic free-model pools", () => {
    const c = loadConfig(write("provider-tier.json", base({
      providers: {
        nim: {
          base: "https://nim.test/v1",
          kind: "openai",
          tierType: "free",
          signupUrl: "https://build.nvidia.com",
        },
        openrouter: {
          base: "https://openrouter.test/v1",
          kind: "openai",
          tierType: "mixed",
        },
      },
    })));
    expect(c.providers.nim?.tierType).toBe("free");
    expect(c.providers.nim?.signupUrl).toBe("https://build.nvidia.com");
    expect(c.providers.openrouter?.tierType).toBe("mixed");
  });

  it("defaults an anthropic provider's authHeader to x-api-key", () => {
    const c = loadConfig(write("anth.json", {
      listen: "127.0.0.1:8791",
      providers: { claude: { base: "https://api.anthropic.test", kind: "anthropic" } },
      routing: { default: "claude" },
    }));
    expect(c.providers.claude!.authHeader).toBe("x-api-key");
  });

  it("accepts bracketed IPv6 loopback [::1]", () => {
    const c = loadConfig(write("b.json", base({ listen: "[::1]:8791" })));
    expect(c.host).toBe("::1");
  });

  it("rejects a non-loopback bind", () => {
    expect(() => loadConfig(write("c.json", base({ listen: "0.0.0.0:8791" })))).toThrow(/loopback/);
  });

  it("rejects an out-of-range port", () => {
    expect(() => loadConfig(write("d.json", base({ listen: "127.0.0.1:99999" })))).toThrow(/port/);
  });

  it("requires at least one provider", () => {
    expect(() => loadConfig(write("e.json", { listen: "127.0.0.1:8791", routing: { default: "x/y" } }))).toThrow(/providers/);
  });

  it("requires routing.default", () => {
    expect(() => loadConfig(write("f.json", {
      listen: "127.0.0.1:8791",
      providers: { nim: { base: "https://nim.test/v1", kind: "openai" } },
    }))).toThrow(/routing\.default/);
  });

  it("rejects a default that names an unknown provider", () => {
    expect(() => loadConfig(write("g.json", base({ routing: { default: "ghost/model" } })))).toThrow(/unknown provider "ghost"/);
  });

  it("rejects a tier that names an unknown provider", () => {
    expect(() => loadConfig(write("h.json", base({ routing: { default: "nim/m", tiers: { opus: "ghost/m" } } })))).toThrow(/unknown provider "ghost"/);
  });

  it("honors authHeader override on a provider", () => {
    const c = loadConfig(write("i.json", {
      listen: "127.0.0.1:8791",
      providers: { nim: { base: "https://nim.test/v1", kind: "openai", authHeader: "x-api-key" } },
      routing: { default: "nim/m" },
    }));
    expect(c.providers.nim!.authHeader).toBe("x-api-key");
  });

  it("rejects Infinity maxAttempts and falls back to default 2", () => {
    const c = loadConfig(write("infinity.json", base({ repair: { maxAttempts: Infinity } })));
    expect(c.repair.maxAttempts).toBe(2);
  });
});

describe("resolveTarget — namespace, tier, default routing", () => {
  const cfg = loadConfig(write("route.json", {
    listen: "127.0.0.1:8791",
    providers: {
      nim: { base: "https://nim.test/v1", kind: "openai", authEnv: "NVIDIA_API_KEY" },
      openrouter: { base: "https://or.test/api/v1", kind: "openai", authEnv: "OPENROUTER_API_KEY" },
    },
    routing: {
      default: "nim/z-ai/glm-5.2",
      tiers: { opus: "openrouter/openai/gpt-5.2-codex", haiku: "nim/openai/gpt-oss-20b" },
    },
  }));

  it("routes a namespaced model to its provider, model tail kept verbatim (nested slashes)", () => {
    const t = resolveTarget("nim/z-ai/glm-5.2", cfg);
    expect(t.provider).toBe("nim");
    expect(t.model).toBe("z-ai/glm-5.2");
    expect(t.base).toBe("https://nim.test/v1");
    expect(t.authEnv).toBe("NVIDIA_API_KEY");
  });

  it("routes a Claude tier via substring match", () => {
    const t = resolveTarget("claude-opus-4-6-thinking", cfg);
    expect(t.provider).toBe("openrouter");
    expect(t.model).toBe("openai/gpt-5.2-codex");
  });

  it("maps a haiku side-call to the configured cheap model (fixes the warmup 404)", () => {
    const t = resolveTarget("claude-3-5-haiku-20241022", cfg);
    expect(t.provider).toBe("nim");
    expect(t.model).toBe("openai/gpt-oss-20b");
  });

  it("falls back to routing.default for an unrecognized model", () => {
    const t = resolveTarget("some-random-model", cfg);
    expect(t.provider).toBe("nim");
    expect(t.model).toBe("z-ai/glm-5.2");
  });

  it("treats a non-provider namespace as unrecognized → default", () => {
    // "meta" is not a configured provider and no tier matches → default.
    const t = resolveTarget("meta/llama-3.1-70b", cfg);
    expect(t.provider).toBe("nim");
    expect(t.model).toBe("z-ai/glm-5.2");
  });

  it("treats a non-provider namespace with a tier substring as unrecognized → default", () => {
    // "unknown-provider" is not configured; even if the model contains "haiku", it falls back to default.
    const t = resolveTarget("unknown-provider/llama-haiku-70b", cfg);
    expect(t.provider).toBe("nim");
    expect(t.model).toBe("z-ai/glm-5.2");
  });

  it("routes a bare provider name (no slash) as unrecognized → default", () => {
    // "nim" has no "/", so it isn't a namespace pin — it falls through to default.
    const t = resolveTarget("nim", cfg);
    expect(t.model).toBe("z-ai/glm-5.2");
  });

  it("throws RoutingError when a namespace pins an openai provider with an empty model", () => {
    expect(() => resolveTarget("nim/", cfg)).toThrow(/needs a model/);
  });
});

describe("resolveTargets — pool/<name> ranked routing", () => {
  const poolCfg = loadConfig(write("pools.json", {
    listen: "127.0.0.1:8791",
    providers: {
      nim: { base: "https://nim.test/v1", kind: "openai", authEnv: "NVIDIA_API_KEY" },
      openrouter: { base: "https://or.test/api/v1", kind: "openai", authEnv: "OPENROUTER_API_KEY" },
      anthropic: { base: "https://api.anthropic.com", kind: "anthropic" },
    },
    routing: {
      default: "anthropic",
      tiers: { opus: "anthropic", sonnet: "anthropic", haiku: "anthropic", fable: "anthropic" },
      pools: {
        coding: ["nim/z-ai/glm-5.2", "openrouter/openai/gpt-5.2-codex", "nim/deepseek-ai/deepseek-v4-pro"],
        cheap: ["nim/openai/gpt-oss-20b"],
      },
      // Ranking is orthogonal to pool expansion; pin it off so the assertions below are about
      // membership, not about today's benchmark table.
      benchmarkSort: false,
    },
  }));

  it("expands a pool to ALL its candidates (so ranking + failover have something to walk)", () => {
    const ts = resolveTargets("pool/coding", poolCfg);
    expect(ts).toHaveLength(3);
    expect(ts.map((t) => `${t.provider}/${t.model}`)).toEqual([
      "nim/z-ai/glm-5.2",
      "openrouter/openai/gpt-5.2-codex",
      "nim/deepseek-ai/deepseek-v4-pro",
    ]);
  });

  it("supports a single-candidate pool", () => {
    const ts = resolveTargets("pool/cheap", poolCfg);
    expect(ts).toHaveLength(1);
    expect(ts[0]!.model).toBe("openai/gpt-oss-20b");
  });

  it("preserves valid dynamic-pool effort policies and rejects unknown levels", () => {
    const valid = loadConfig(write("effort-pool.json", base({
      routing: {
        default: "nim/m",
        pools: { medium: { preferred: [], include: "free", effort: "medium" } },
      },
    })));
    expect(valid.routing.poolPolicies?.medium).toEqual({
      preferred: [], include: "free", effort: "medium",
    });

    expect(() => loadConfig(write("bad-effort-pool.json", base({
      routing: {
        default: "nim/m",
        pools: { medium: { preferred: [], include: "free", effort: "turbo" } },
      },
    })))).toThrow(/effort must be low, medium, high, or xhigh/);
  });

  it("validates dynamic-pool exclude tombstones without resolving their providers", () => {
    const valid = loadConfig(write("exclude-pool.json", base({
      routing: {
        default: "nim/m",
        pools: {
          medium: {
            preferred: ["nim/keep", "gone/old-model"],
            include: "free",
            exclude: ["gone/old-model", "retired/unknown-model"],
          },
        },
      },
    })));
    expect(valid.routing.poolPolicies?.medium).toEqual({
      preferred: ["nim/keep"],
      include: "free",
      exclude: ["gone/old-model", "retired/unknown-model"],
    });
    expect(valid.routing.pools?.medium).toEqual(["nim/keep"]);

    for (const [index, exclude] of ["nim", "pool/other", ["nim/good", 42]].entries()) {
      expect(() => loadConfig(write(`bad-exclude-${index}.json`, base({
        routing: {
          default: "nim/m",
          pools: { medium: { preferred: [], include: "free", exclude } },
        },
      })))).toThrow(/exclude must be an array of "provider\/model" specs/);
    }
  });

  it("FAILS LOUDLY on an unknown pool instead of silently using routing.default", () => {
    // The whole point: a typo'd pool must not quietly succeed against a different model.
    expect(() => resolveTargets("pool/nope", poolCfg)).toThrow(/no pool "nope" configured/);
  });

  it("does not treat a tier or namespaced spec as a pool", () => {
    expect(resolveTarget("claude-opus-5", poolCfg).provider).toBe("anthropic");
    expect(resolveTarget("nim/z-ai/glm-5.2", poolCfg).model).toBe("z-ai/glm-5.2");
  });

  it("routes every Claude tier to the anthropic passthrough with no model id", () => {
    // Passthrough targets carry no model — the client's own model id is forwarded upstream.
    for (const m of ["claude-opus-5", "claude-sonnet-4-5", "claude-haiku-4-5", "claude-fable-5"]) {
      const t = resolveTarget(m, poolCfg);
      expect(t.provider).toBe("anthropic");
      expect(t.kind).toBe("anthropic");
      expect(t.model).toBeUndefined();
    }
  });

  it("rejects a pool naming an unknown provider at load time", () => {
    expect(() => loadConfig(write("badpool.json", base({
      routing: { default: "nim/m", pools: { x: ["ghost/m"] } },
    })))).toThrow(/unknown provider "ghost"/);
  });

  it("rejects an empty pool at load time", () => {
    expect(() => loadConfig(write("emptypool.json", base({
      routing: { default: "nim/m", pools: { x: [] } },
    })))).toThrow(/at least one valid spec/);
  });

  it("rejects a provider literally named \"pool\" (it would shadow pool/<name>)", () => {
    expect(() => loadConfig(write("poolprovider.json", {
      listen: "127.0.0.1:8791",
      providers: { pool: { base: "https://x.test/v1", kind: "openai", authEnv: "NVIDIA_API_KEY" } },
      routing: { default: "pool/m" },
    }))).toThrow(/reserved/);
  });

  it("expands a pool referenced from routing.tiers (pools work uniformly, not just as inbound models)", () => {
    const c = loadConfig(write("tierpool.json", {
      listen: "127.0.0.1:8791",
      providers: {
        nim: { base: "https://nim.test/v1", kind: "openai", authEnv: "NVIDIA_API_KEY" },
        anthropic: { base: "https://api.anthropic.com", kind: "anthropic" },
      },
      routing: {
        default: "anthropic",
        tiers: { haiku: "pool/cheap" },
        pools: { cheap: ["nim/openai/gpt-oss-20b"] },
        benchmarkSort: false,
      },
    }));
    const ts = resolveTargets("claude-haiku-4-5", c);
    expect(ts.map((t) => `${t.provider}/${t.model}`)).toEqual(["nim/openai/gpt-oss-20b"]);
  });

  it("rejects a tier naming an unknown pool at load time", () => {
    expect(() => loadConfig(write("tierbadpool.json", base({
      routing: { default: "nim/m", tiers: { haiku: "pool/nope" } },
    })))).toThrow(/unknown pool "nope"/);
  });

  it("rejects a subagent target naming an unknown pool at load time (not first request)", () => {
    expect(() => loadConfig(write("subbadpool.json", base({
      routing: { default: "nim/m", subagents: { opus: "pool/nope" } },
    })))).toThrow(/unknown pool "nope"/);
  });

  it("rejects a subagent target naming an unknown provider at load time", () => {
    expect(() => loadConfig(write("subbadprov.json", base({
      routing: { default: "nim/m", subagents: { opus: "ghost/m" } },
    })))).toThrow(/unknown provider "ghost"/);
  });

  it("rejects a pool member that references another pool (no recursion)", () => {
    expect(() => loadConfig(write("poolinpool.json", base({
      routing: { default: "nim/m", pools: { a: ["nim/m"], b: ["pool/a"] } },
    })))).toThrow(/cannot reference another pool/);
  });
});

describe("subagent-aware routing", () => {
  const SUB = "x-anthropic-billing-header: cc_version=2.1.220.e23; cc_entrypoint=sdk-cli; cc_is_subagent=true;\nYou are a Claude agent.";
  const MAIN = "x-anthropic-billing-header: cc_version=2.1.220.337; cc_entrypoint=sdk-cli;\nYou are a Claude agent.";

  const cfg = loadConfig(write("subagents.json", {
    listen: "127.0.0.1:8791",
    providers: {
      anthropic: { base: "https://api.anthropic.com", kind: "anthropic" },
      nim: { base: "https://nim.test/v1", kind: "openai", authEnv: "NVIDIA_API_KEY" },
    },
    routing: {
      default: "anthropic",
      tiers: { opus: "anthropic", sonnet: "anthropic", haiku: "anthropic", fable: "anthropic" },
      pools: { coding: ["nim/z-ai/glm-5.2"], fast: ["nim/openai/gpt-oss-20b"] },
      subagents: { opus: "pool/coding", haiku: "pool/fast", default: "pool/coding" },
      offload: true,
      benchmarkSort: false,
    },
  }));

  // Same routing, offload switch OFF — the shipped default.
  const cfgOff = loadConfig(write("subagents-off.json", {
    listen: "127.0.0.1:8791",
    providers: {
      anthropic: { base: "https://api.anthropic.com", kind: "anthropic" },
      nim: { base: "https://nim.test/v1", kind: "openai", authEnv: "NVIDIA_API_KEY" },
    },
    routing: {
      default: "anthropic",
      tiers: { opus: "anthropic", sonnet: "anthropic", haiku: "anthropic", fable: "anthropic" },
      pools: { coding: ["nim/z-ai/glm-5.2"], fast: ["nim/openai/gpt-oss-20b"] },
      subagents: { opus: "pool/coding", haiku: "pool/fast", default: "pool/coding" },
      benchmarkSort: false,
    },
  }));

  const msg = (...texts: string[]) => ({
    system: SUB,
    messages: [{ role: "user", content: texts.map((t) => ({ type: "text", text: t })) }],
  });

  it("detects a subagent request only when the marker is present", () => {
    expect(isSubagentRequest({ system: SUB })).toBe(true);
    expect(isSubagentRequest({ system: MAIN })).toBe(false);
    expect(isSubagentRequest({ system: [{ type: "text", text: SUB }] })).toBe(true);
    expect(isSubagentRequest({})).toBe(false);
  });

  it("detects a Claude subagent from the documented agent-id header, with no marker present", () => {
    // Two independent signals, either sufficient. The header survives
    // CLAUDE_CODE_ATTRIBUTION_HEADER=0 (which removes the marker); the marker survives middleware
    // that filters unknown request headers (which removes the header). Neither alone is safe, and
    // the shared failure mode is silent: an undetected subagent spends primary quota.
    expect(isSubagentRequest({ system: MAIN }, { "x-claude-code-agent-id": "agent_01ABC" })).toBe(true);
    expect(isSubagentRequest({}, { "X-Claude-Code-Agent-Id": "agent_01ABC" })).toBe(true);
    expect(isSubagentRequest({ system: SUB }, {})).toBe(true);
    // Presence is the signal, so an empty value is not one.
    expect(isSubagentRequest({ system: MAIN }, { "x-claude-code-agent-id": "  " })).toBe(false);
    // The parent header travels only WITH an agent id; on its own it says nothing.
    expect(isSubagentRequest({ system: MAIN }, { "x-claude-code-parent-agent-id": "agent_01ABC" })).toBe(false);
  });

  it("detects Codex child turns from explicit request metadata only", () => {
    const childHeaders = { "x-codex-turn-metadata": JSON.stringify({ request_kind: "subagent" }) };
    const mainHeaders = { "x-codex-turn-metadata": JSON.stringify({ request_kind: "turn" }) };
    expect(isSubagentRequest({}, childHeaders)).toBe(true);
    expect(isSubagentRequest({}, mainHeaders)).toBe(false);
    expect(isSubagentRequest({}, { "x-codex-turn-metadata": "not-json" })).toBe(false);
    expect(isSubagentRequest({}, { "x-codex-turn-metadata": JSON.stringify({ request_kind: "other" }) })).toBe(false);
  });

  it("routes a Codex child turn through the same subagent map", () => {
    const childHeaders = { "x-codex-turn-metadata": JSON.stringify({ request_kind: "subagent" }) };
    const mainHeaders = { "x-codex-turn-metadata": JSON.stringify({ request_kind: "turn" }) };
    expect(subagentSpec({ model: "pool/reasoning" }, "pool/reasoning", cfg, childHeaders)).toBe("pool/coding");
    expect(subagentSpec({ model: "pool/reasoning" }, "pool/reasoning", cfg, mainHeaders)).toBeNull();
  });

  it("leaves MAIN-conversation requests entirely alone (tiers stay on passthrough)", () => {
    const main = { system: MAIN, messages: [{ role: "user", content: [{ type: "text", text: "@relay: pool/coding" }] }] };
    // Even a literal directive must not reroute a human's own conversation.
    expect(subagentSpec(main, "claude-opus-5", cfg)).toBeNull();
    expect(resolveTarget("claude-opus-5", cfg).provider).toBe("anthropic");
  });

  it("offload defaults to OFF — routing.offload absent means the map is inert", () => {
    expect(cfgOff.routing.offload).toBe(false);
    // Same request that lands on pool/coding with offload on must pass straight through.
    expect(subagentSpec(msg("find the bug"), "claude-opus-5", cfgOff)).toBeNull();
    expect(subagentSpec(msg("list files"), "claude-haiku-4-5", cfgOff)).toBeNull();
    expect(subagentSpec(msg("do a thing"), "some-unknown-model", cfgOff)).toBeNull();
    expect(resolveTarget("claude-opus-5", cfgOff).provider).toBe("anthropic");
  });

  it("honours an explicit @relay directive even while offload is OFF (per-call opt-in)", () => {
    expect(subagentSpec(msg("@relay: pool/fast\nlist files"), "claude-opus-5", cfgOff)).toBe("pool/fast");
    // …and still strips it, so the off path can't leak the directive to the model either.
    const body = msg("@relay: nim/z-ai/glm-5.2\nsummarise this");
    subagentSpec(body, "claude-opus-5", cfgOff);
    expect(body.messages[0]!.content[0]!.text).toBe("summarise this");
  });

  it("maps a subagent tier to its pool", () => {
    expect(subagentSpec(msg("find the bug"), "claude-opus-5", cfg)).toBe("pool/coding");
    expect(subagentSpec(msg("list files"), "claude-haiku-4-5", cfg)).toBe("pool/fast");
  });

  it("falls back to subagents.default when no tier matches", () => {
    expect(subagentSpec(msg("do a thing"), "some-unknown-model", cfg)).toBe("pool/coding");
  });

  it("lets an explicit @relay directive beat the tier map", () => {
    expect(subagentSpec(msg("@relay: nim/z-ai/glm-5.2\nfind the bug"), "claude-haiku-4-5", cfg))
      .toBe("nim/z-ai/glm-5.2");
  });

  it("STRIPS the directive so the model never sees it", () => {
    const body = msg("@relay: pool/fast\nsummarise this");
    subagentSpec(body, "claude-opus-5", cfg);
    expect(body.messages[0]!.content[0]!.text).toBe("summarise this");
  });

  it("reads the directive ONLY from the dispatcher's prompt (last block), not injected context", () => {
    // Block 0 is Claude Code's <system-reminder> (CLAUDE.md etc). A directive there is NOT the
    // dispatcher speaking, so it must be ignored — otherwise any CLAUDE.md could reroute agents.
    const body = msg("<system-reminder>@relay: nim/z-ai/glm-5.2</system-reminder>", "do the task");
    expect(subagentSpec(body, "claude-opus-5", cfg)).toBe("pool/coding");
  });

  it("ignores a directive arriving in a later message (i.e. in a tool result / file content)", () => {
    // A file the subagent reads must never be able to redirect its own routing.
    const body = {
      system: SUB,
      messages: [
        { role: "user", content: [{ type: "text", text: "do the task" }] },
        { role: "user", content: [{ type: "text", text: "@relay: nim/z-ai/glm-5.2" }] },
      ],
    };
    expect(subagentSpec(body, "claude-opus-5", cfg)).toBe("pool/coding");
  });

  it("does nothing when routing.subagents is absent and no directive is given", () => {
    const plain = loadConfig(write("nosub.json", base({ routing: { default: "nim/m" } })));
    expect(subagentSpec(msg("hi"), "claude-opus-5", plain)).toBeNull();
  });

  it("still honours a directive when routing.subagents is absent", () => {
    const plain = loadConfig(write("nosub2.json", base({ routing: { default: "nim/m" } })));
    expect(subagentSpec(msg("@relay: nim/other\ngo"), "claude-opus-5", plain)).toBe("nim/other");
  });

  // A directive is checked per REQUEST, so it gets none of the load-time validation the
  // routing.subagents map gets. Unchecked, a typo matched no provider and no pool, fell through
  // pickSpecs to routing.default (the Anthropic passthrough) and was answered by PRIMARY quota —
  // while the dispatcher, and the response, both looked like a successful offload.
  it("FAILS LOUDLY on an @relay directive naming an unknown provider", () => {
    expect(() => subagentSpec(msg("@relay: nimm/z-ai/glm-5.2\ngo"), "claude-opus-5", cfg))
      .toThrow(/names unknown provider "nimm"/);
    // …with the switch off too: the directive is the per-call opt-in either way.
    expect(() => subagentSpec(msg("@relay: nimm/z-ai/glm-5.2\ngo"), "claude-opus-5", cfgOff))
      .toThrow(/names unknown provider "nimm"/);
  });

  it("FAILS LOUDLY on an @relay directive naming an unknown pool", () => {
    expect(() => subagentSpec(msg("@relay: pool/codeing\ngo"), "claude-opus-5", cfg))
      .toThrow(/names unknown pool "codeing"/);
  });

  it("FAILS LOUDLY on an @relay directive that omits the model id an openai provider needs", () => {
    expect(() => subagentSpec(msg("@relay: nim\ngo"), "claude-opus-5", cfg))
      .toThrow(/carries no model id/);
  });

  it("does not accept a tier-shaped @relay directive as resolvable (it would mean the passthrough)", () => {
    // `opus-coder` is a typo, not a destination — detectTier would match "opus" and land it on
    // routing.tiers.opus, i.e. primary quota. Refuse instead of quietly billing the human.
    expect(() => subagentSpec(msg("@relay: opus-coder\ngo"), "claude-haiku-4-5", cfg))
      .toThrow(/names unknown provider "opus-coder"/);
  });

  it("never resolves a bad directive to routing.default", () => {
    // The failure mode stated positively: whatever happens, it is not a silent passthrough hit.
    let spec: string | null = "unset";
    try {
      spec = subagentSpec(msg("@relay: ghost/model\ngo"), "claude-opus-5", cfg);
    } catch {
      spec = null;
    }
    expect(spec).toBeNull();
    expect(cfg.routing.default).toBe("anthropic"); // what the silent fall-through used to reach
  });

  it("still accepts a directive naming an anthropic provider with no model id (passthrough is a real target)", () => {
    expect(subagentSpec(msg("@relay: anthropic\ngo"), "claude-opus-5", cfg)).toBe("anthropic");
  });

  it("parses and strips @relay directive when message content is a plain string", () => {
    const strMsg = {
      system: SUB,
      messages: [{ role: "user", content: "@relay: pool/fast\nsummarise this" }],
    };
    expect(subagentSpec(strMsg, "claude-opus-5", cfg)).toBe("pool/fast");
    expect(strMsg.messages[0]!.content).toBe("summarise this");
  });

  it("restricts @relay directive parsing strictly to the prompt text block (last block)", () => {
    const multiMsgIgnored = {
      system: SUB,
      messages: [
        {
          role: "user",
          content: [
            { type: "text", text: "<system-reminder>injected context</system-reminder>" },
            { type: "text", text: "@relay: pool/fast" },
            { type: "text", text: "second block context without directive" },
          ],
        },
      ],
    };
    // The directive in the middle text block must be ignored because the prompt text block is the last one.
    expect(subagentSpec(multiMsgIgnored, "claude-opus-5", cfg)).toBe("pool/coding");

    const multiMsgValid = {
      system: SUB,
      messages: [
        {
          role: "user",
          content: [
            { type: "text", text: "<system-reminder>injected context</system-reminder>" },
            { type: "text", text: "earlier context" },
            { type: "text", text: "@relay: pool/fast\nfinal prompt block" },
          ],
        },
      ],
    };
    expect(subagentSpec(multiMsgValid, "claude-opus-5", cfg)).toBe("pool/fast");
  });
});

describe("client-specific offload routing", () => {
  const SUB = "x-anthropic-billing-header: cc_is_subagent=true;";
  const MAIN = "x-anthropic-billing-header: cc_entrypoint=sdk-cli;";
  const request = (system: string) => ({
    system,
    messages: [{ role: "user", content: [{ type: "text", text: "do the task" }] }],
  });

  it("parses independent client rules and identifies built-in front doors", () => {
    const cfg = loadConfig(write("client-offload.json", base({
      routing: {
        default: "nim/model",
        tiers: { opus: "nim/model" },
        pools: { coding: ["nim/model"] },
        subagents: { default: "pool/coding" },
        offload: {
          claude: { enabled: true, scope: "all" },
          codex: { enabled: false, scope: "subagents" },
        },
      },
    })));

    // ⚠ `freeOnly` stays ABSENT when unset — "unset" and "explicitly false" must remain
    // distinguishable, because unset defaults ON for offload-rerouted traffic and OFF for a
    // directly addressed pool. Materializing a value here would collapse that into one answer.
    expect(cfg.routing.offload).toEqual({
      claude: { enabled: true, scope: "all" },
      codex: { enabled: false, scope: "subagents" },
    });
    expect(offloadRule(cfg, "claude")).toEqual({ enabled: true, scope: "all" });
    expect(offloadRule(cfg, "codex")).toEqual({ enabled: false, scope: "subagents" });
    expect(clientForPath("/v1/messages")).toBe("claude");
    expect(clientForPath("/v1/responses")).toBe("codex");
    expect(clientForPath("/v1/chat/completions")).toBe("openai");
  });

  it("can reroute a Claude main conversation while leaving Codex disabled", () => {
    const cfg = loadConfig(write("client-scope.json", base({
      routing: {
        default: "nim/model",
        tiers: { opus: "nim/model" },
        pools: { coding: ["nim/model"] },
        subagents: { default: "pool/coding" },
        offload: {
          claude: { enabled: true, scope: "all" },
          codex: { enabled: false, scope: "all" },
        },
      },
    })));

    expect(subagentSpec(request(MAIN), "claude-opus-5", cfg, undefined, "claude")).toBe("pool/coding");
    expect(subagentSpec(request(SUB), "codex-model", cfg, undefined, "codex")).toBeNull();
    // A subagents-only rule leaves a main conversation on its normal route.
    cfg.routing.offload = { claude: { enabled: true, scope: "subagents" } };
    expect(subagentSpec(request(MAIN), "claude-opus-5", cfg, undefined, "claude")).toBeNull();
    expect(subagentSpec(request(SUB), "claude-opus-5", cfg, undefined, "claude")).toBe("pool/coding");
  });

  it("accepts an explicit default rule for future front doors", () => {
    const cfg = loadConfig(write("client-default.json", base({
      routing: {
        default: "nim/model",
        pools: { coding: ["nim/model"] },
        subagents: { default: "pool/coding" },
        offload: { default: { enabled: true, scope: "all" } },
      },
    })));
    expect(subagentSpec(request(MAIN), "future-model", cfg, undefined, "future-client")).toBe("pool/coding");
  });

  it("parses freeOnly on a client rule and rejects a non-boolean one", () => {
    const cfg = loadConfig(write("client-offload-freeonly.json", base({
      routing: {
        default: "nim/model",
        pools: { coding: ["nim/model"] },
        subagents: { default: "pool/coding" },
        offload: { claude: { enabled: true, scope: "subagents", freeOnly: true } },
      },
    })));
    expect(offloadRule(cfg, "claude")).toEqual({ enabled: true, scope: "subagents", freeOnly: true });
    // Absent stays absent — the guard is opt-in like offload itself.
    // Absent, not false — the default is applied at the guard (`freeOnlyApplies`), where it can
    // differ between offload-rerouted traffic (ON) and a directly addressed pool (OFF).
    expect(offloadRule(cfg, "codex").freeOnly).toBeUndefined();
    expect(() => loadConfig(write("client-offload-freeonly-bad.json", base({
      routing: { default: "nim/model", offload: { claude: { enabled: true, freeOnly: "yes" } } },
    })))).toThrow(/freeOnly must be true or false/);
  });

  it("rejects an invalid client offload scope", () => {
    expect(() => loadConfig(write("client-offload-invalid.json", base({
      routing: { default: "nim/model", offload: { claude: { enabled: true, scope: "conversation" } } },
    })))).toThrow(/scope must be "subagents" or "all"/);
  });
});

describe("reshaper: { pool } — no single pinned model", () => {
  const poolReshaperCfg = {
    listen: "127.0.0.1:8791",
    providers: {
      anthropic: { base: "https://api.anthropic.com", kind: "anthropic" },
      nim: { base: "https://nim.test/v1", kind: "openai", authEnv: "NVIDIA_API_KEY" },
    },
    routing: {
      default: "anthropic",
      tiers: { opus: "anthropic" },
      pools: { coding: ["nim/z-ai/glm-5.2", "nim/deepseek-ai/deepseek-v4-pro"], none: ["anthropic"] },
    },
    mode: "repair",
    reshaper: { pool: "coding" },
  };

  it("expands the pool into ranked reshaper candidates (so a de-listed model can't kill repair)", () => {
    const c = loadConfig(write("resh-pool.json", poolReshaperCfg));
    expect(c.reshaperCandidates).toHaveLength(2);
    expect(c.reshaperCandidates!.map((r) => r.model)).toEqual(["z-ai/glm-5.2", "deepseek-ai/deepseek-v4-pro"]);
    expect(c.reshaperCandidates![0]!.authEnv).toBe("NVIDIA_API_KEY");
    // candidates[0] is mirrored onto .reshaper so every existing single-reshaper path still works.
    expect(c.reshaper?.model).toBe("z-ai/glm-5.2");
  });

  it("satisfies repair-mode validation against an anthropic passthrough provider", () => {
    // The pinned-model form is what used to be required here; the pool form must also satisfy it.
    expect(() => loadConfig(write("resh-pool-ok.json", poolReshaperCfg))).not.toThrow();
  });

  it("defers an empty catalog-backed reshaper pool until its free tail is materialized", () => {
    const c = loadConfig(write("resh-dynamic-pool.json", {
      ...poolReshaperCfg,
      providers: {
        ...poolReshaperCfg.providers,
        nim: { ...poolReshaperCfg.providers.nim, tierType: "free" },
      },
      routing: {
        ...poolReshaperCfg.routing,
        pools: { medium: { preferred: [], include: "free", effort: "medium" } },
      },
      reshaper: { pool: "medium", timeoutMs: 45_000 },
    }));

    expect(c.reshaper).toBeUndefined();
    expect(c.reshaperCandidates).toBeUndefined();
    expect(c.reshaperPool).toEqual({ name: "medium", timeoutMs: 45_000 });
  });

  it("throws on an undefined pool name rather than silently having no reshaper", () => {
    expect(() => loadConfig(write("resh-pool-missing.json", {
      ...poolReshaperCfg, reshaper: { pool: "ghost" },
    }))).toThrow(/not defined in routing.pools/);
  });

  it("throws when the pool has no openai-kind target able to reshape", () => {
    // An anthropic passthrough has no fixed model id to send, so it cannot be a reshaper.
    expect(() => loadConfig(write("resh-pool-anth.json", {
      ...poolReshaperCfg, reshaper: { pool: "none" },
    }))).toThrow(/no openai-kind target that can reshape/);
  });

  it("still rejects repair mode + anthropic provider when no reshaper is given at all", () => {
    const { reshaper, ...noReshaper } = poolReshaperCfg;
    expect(() => loadConfig(write("resh-none.json", noReshaper))).toThrow(/requires a config.reshaper/);
  });
});

describe("ergonomics: env expansion, overrides, reshaper", () => {
  it("expands ${ENV} in provider.base", () => {
    process.env.RP_TEST_BASE = "https://nim.test/v1";
    const c = loadConfig(write("env.json", {
      listen: "127.0.0.1:8791",
      providers: { nim: { base: "${RP_TEST_BASE}", kind: "openai" } },
      routing: { default: "nim/m" },
    }));
    expect(c.providers.nim!.base).toBe("https://nim.test/v1");
    delete process.env.RP_TEST_BASE;
  });

  // An unset ${ENV} in a provider base disables THAT provider rather than aborting startup —
  // the proxy fronts every client session, so one optional provider must not be able to take
  // it down. Losing every provider is still fatal. See test/degraded-config.test.ts.
  it("disables a provider whose base references an unset var, but still refuses an empty registry", () => {
    delete process.env.RP_MISSING_VAR;
    expect(() => loadConfig(write("env2.json", {
      providers: { nim: { base: "${RP_MISSING_VAR}", kind: "openai" } },
      routing: { default: "nim/m" },
    }))).toThrow(/at least one provider/);

    const c = loadConfig(write("env3.json", {
      providers: {
        good: { base: "https://good.test/v1", kind: "openai" },
        broken: { base: "${RP_MISSING_VAR}", kind: "openai" },
      },
      routing: { default: "good/m" },
    }));
    expect(Object.keys(c.providers)).toEqual(["good"]);
    expect((c.warnings ?? []).join("\n")).toMatch(/RP_MISSING_VAR/);
  });

  it("applies CLI overrides (default/mode/listen) over the file", () => {
    const p = write("ovr.json", base({ mode: "detect" }));
    const c = loadConfig(p, { routeDefault: "nim/new-model", mode: "repair", listen: "127.0.0.1:9000" });
    expect(c.routing.default).toBe("nim/new-model");
    expect(c.port).toBe(9000);
    expect(c.mode).toBe("repair");
  });

  it("repair mode with all-openai providers needs no explicit reshaper; target reshapes on itself", () => {
    const c = loadConfig(write("syn.json", base({ mode: "repair" })));
    expect(c.reshaper).toBeUndefined();
    const rs = reshaperForTarget(resolveTarget("nim/z-ai/glm-5.2", c));
    expect(rs?.kind).toBe("openai");
    expect(rs?.base).toBe("https://nim.test/v1");
    expect(rs?.model).toBe("z-ai/glm-5.2");
    expect(rs?.authEnv).toBe("NVIDIA_API_KEY");
  });

  it("repair mode with an anthropic provider requires an explicit reshaper", () => {
    expect(() => loadConfig(write("noreshape.json", {
      listen: "127.0.0.1:8791",
      providers: { claude: { base: "https://api.anthropic.test", kind: "anthropic" } },
      routing: { default: "claude" },
      mode: "repair",
    }))).toThrow(/requires a config\.reshaper/);
  });

  it("an explicit reshaper block wins over per-target synthesis", () => {
    const c = loadConfig(write("explicit.json", base({
      mode: "repair",
      reshaper: { base: "https://cheap.test/v1", kind: "openai", model: "cheap-model" },
    })));
    expect(c.reshaper?.base).toBe("https://cheap.test/v1");
    expect(c.reshaper?.model).toBe("cheap-model");
  });

  it("resolveTargets filters active keys and sorts candidates by benchmark quality", async () => {
    const { resolveTargets } = await import("../src/config.js");
    process.env.TEST_KEY_A = "secret_a";
    delete process.env.TEST_KEY_B; // Unset key

    const c = loadConfig(write("dynroute.json", {
      listen: "127.0.0.1:8791",
      providers: {
        provA: { base: "https://a.test/v1", kind: "openai", authEnv: "TEST_KEY_A" },
        provB: { base: "https://b.test/v1", kind: "openai", authEnv: "TEST_KEY_B" },
        localOllama: { base: "http://localhost:11434/v1", kind: "openai" },
      },
      routing: {
        default: ["provB/llama-3.1-8b", "provA/qwen-2.5-coder-32b", "localOllama/qwen-2.5-coder-32b"],
      },
    }));

    const targets = resolveTargets(null, c);
    // Unset provB should be filtered out because provA and localOllama have active keys
    expect(targets.some((t) => t.provider === "provB")).toBe(false);
    expect(targets.length).toBe(2);

    delete process.env.TEST_KEY_A;
  });

  // A whitespace-only key used to be PRESENT here (`Boolean(process.env[x])`, no trim) and ABSENT
  // to server.ts's header builder (which trims). The blank-key target therefore survived the
  // active-key filter, the keep-everything fallback never ran, and the request went to a provider
  // the proxy had no usable credential for. Both sites must give the same answer.
  it("treats a whitespace-only key as ABSENT, same as the header builder does", () => {
    process.env.TEST_KEY_BLANK = "   \n";
    process.env.TEST_KEY_REAL = "secret_real";

    const c = loadConfig(write("blankkey.json", {
      listen: "127.0.0.1:8791",
      providers: {
        blankProv: { base: "https://blank.test/v1", kind: "openai", authEnv: "TEST_KEY_BLANK" },
        realProv: { base: "https://real.test/v1", kind: "openai", authEnv: "TEST_KEY_REAL" },
      },
      routing: {
        default: ["blankProv/some-model", "realProv/some-model"],
        benchmarkSort: false,
      },
    }));

    const targets = resolveTargets(null, c);
    expect(targets.map((t) => t.provider)).toEqual(["realProv"]);

    delete process.env.TEST_KEY_BLANK;
    delete process.env.TEST_KEY_REAL;
  });

  it("keeps the whole candidate list when NO candidate has a usable key (the unfiltered fallback)", () => {
    process.env.TEST_KEY_BLANK = " ";
    delete process.env.TEST_KEY_MISSING;

    const c = loadConfig(write("allblank.json", {
      listen: "127.0.0.1:8791",
      providers: {
        blankProv: { base: "https://blank.test/v1", kind: "openai", authEnv: "TEST_KEY_BLANK" },
        goneProv: { base: "https://gone.test/v1", kind: "openai", authEnv: "TEST_KEY_MISSING" },
      },
      routing: {
        default: ["blankProv/some-model", "goneProv/some-model"],
        benchmarkSort: false,
      },
    }));

    // The blank one is no longer privileged over the unset one: the filter empties, so the
    // fallback returns both in config order and the caller fails on a real credential error
    // rather than on whichever provider happened to hold a blank variable.
    expect(resolveTargets(null, c).map((t) => t.provider)).toEqual(["blankProv", "goneProv"]);

    delete process.env.TEST_KEY_BLANK;
  });
});

describe("loadConfig — walkBudgetMs", () => {
  it("accepts a non-negative number, floors it, and preserves 0 (disabled)", () => {
    expect(loadConfig(write("wb-ok.json", base({ walkBudgetMs: 30000.9 }))).walkBudgetMs).toBe(30000);
    expect(loadConfig(write("wb-zero.json", base({ walkBudgetMs: 0 }))).walkBudgetMs).toBe(0);
  });

  it("is absent when not configured — the server applies its own default", () => {
    expect(loadConfig(write("wb-absent.json", base())).walkBudgetMs).toBeUndefined();
  });

  it("rejects a negative or non-numeric value loudly", () => {
    expect(() => loadConfig(write("wb-neg.json", base({ walkBudgetMs: -1 })))).toThrow(/walkBudgetMs/);
    expect(() => loadConfig(write("wb-str.json", base({ walkBudgetMs: "45s" })))).toThrow(/walkBudgetMs/);
  });
});

describe("loadConfig — maxBodyBytes", () => {
  it("accepts a positive integer within the configured bound", () => {
    expect(loadConfig(write("body-ok.json", base({ maxBodyBytes: 36 * 1024 * 1024 }))).maxBodyBytes)
      .toBe(36 * 1024 * 1024);
  });

  it("is absent when not configured — the server applies its 36 MiB default", () => {
    expect(loadConfig(write("body-absent.json", base())).maxBodyBytes).toBeUndefined();
  });

  it.each([0, -1, 1.5, 256 * 1024 * 1024 + 1, "36MB"])(
    "rejects invalid maxBodyBytes value %j and names the field",
    (maxBodyBytes) => {
      expect(() => loadConfig(write("body-invalid.json", base({ maxBodyBytes })))).toThrow(/maxBodyBytes/);
    },
  );
});

describe("loadConfig — log.maxBytes", () => {
  it("accepts a positive integer within the configured bound", () => {
    const c = loadConfig(write("log-max-ok.json", base({
      log: { level: "metadata", file: "proxy.jsonl", maxBytes: 50 * 1024 * 1024 },
    })));
    expect(c.log.maxBytes).toBe(50 * 1024 * 1024);
  });

  it("is absent when not configured — the logger applies its 50 MiB default", () => {
    expect(loadConfig(write("log-max-absent.json", base())).log.maxBytes).toBeUndefined();
  });

  it.each([0, -1, 1.5, 1024 * 1024 * 1024 + 1, "50MB"])(
    "rejects invalid log.maxBytes value %j and names the field",
    (maxBytes) => {
      expect(() => loadConfig(write("log-max-invalid.json", base({ log: { maxBytes } }))))
        .toThrow(/log\.maxBytes/);
    },
  );
});
