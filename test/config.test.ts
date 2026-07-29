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
} from "../src/config.js";

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

describe("loadConfig — authEnv alias resolution", () => {
  it("keeps the declared authEnv when that variable is the one set", () => {
    process.env.GEMINI_API_KEY = "declared";
    const c = loadConfig(write("env-declared.json", base({
      providers: { gemini: { base: "https://g.test/v1", kind: "openai", authEnv: "GEMINI_API_KEY" } },
      routing: { default: "gemini/gemini-2.5-flash" },
    })));
    expect(c.providers.gemini!.authEnv).toBe("GEMINI_API_KEY");
    delete process.env.GEMINI_API_KEY;
  });

  it("adopts an alias env var when the declared one is unset", () => {
    delete process.env.GEMINI_API_KEY;
    process.env.GOOGLEAI_API_KEY = "alias";
    const c = loadConfig(write("env-alias.json", base({
      providers: { gemini: { base: "https://g.test/v1", kind: "openai", authEnv: "GEMINI_API_KEY" } },
      routing: { default: "gemini/gemini-2.5-flash" },
    })));
    expect(c.providers.gemini!.authEnv).toBe("GOOGLEAI_API_KEY");
    delete process.env.GOOGLEAI_API_KEY;
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
  it("expands ${ENV} in provider.base and throws on an unset var", () => {
    process.env.RP_TEST_BASE = "https://nim.test/v1";
    const c = loadConfig(write("env.json", {
      listen: "127.0.0.1:8791",
      providers: { nim: { base: "${RP_TEST_BASE}", kind: "openai" } },
      routing: { default: "nim/m" },
    }));
    expect(c.providers.nim!.base).toBe("https://nim.test/v1");
    delete process.env.RP_TEST_BASE;

    expect(() => loadConfig(write("env2.json", {
      providers: { nim: { base: "${RP_MISSING_VAR}", kind: "openai" } },
      routing: { default: "nim/m" },
    }))).toThrow(/unset env var \$\{RP_MISSING_VAR\}/);
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
});
