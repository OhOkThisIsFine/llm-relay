import { describe, it, expect, afterAll } from "vitest";
import { writeFileSync, mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { loadConfig, resolveTarget, reshaperForTarget } from "../src/config.js";

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
});
