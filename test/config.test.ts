import { describe, it, expect, afterAll } from "vitest";
import { writeFileSync, mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { loadConfig } from "../src/config.js";

// Eager (not in beforeAll) so describe-body loadConfig(write(...)) calls work at collection.
const dir = mkdtempSync(join(tmpdir(), "rp-cfg-"));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

function write(name: string, obj: unknown): string {
  const p = join(dir, name);
  writeFileSync(p, JSON.stringify(obj));
  return p;
}

// A minimal valid config: one Anthropic-format backend (e.g. a LiteLLM proxy).
function base(extra: Record<string, unknown> = {}) {
  return {
    listen: "127.0.0.1:8791",
    backend: { base: "http://127.0.0.1:4000", authEnv: "LITELLM_KEY" },
    ...extra,
  };
}

describe("loadConfig — listen + backend", () => {
  it("accepts 127.0.0.1 and defaults backend authHeader/timeout", () => {
    const c = loadConfig(write("a.json", base()));
    expect(c.host).toBe("127.0.0.1");
    expect(c.port).toBe(8791);
    expect(c.backend.authHeader).toBe("x-api-key");
    expect(c.backend.timeoutMs).toBe(120000);
    expect(c.backend.authEnv).toBe("LITELLM_KEY");
    expect(c.backend.model).toBeUndefined();
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

  it("requires backend.base", () => {
    expect(() => loadConfig(write("e.json", { listen: "127.0.0.1:8791" }))).toThrow(/backend\.base/);
  });

  it("strips trailing slashes from backend.base and honors authHeader override", () => {
    const c = loadConfig(write("f.json", {
      listen: "127.0.0.1:8791",
      backend: { base: "http://127.0.0.1:4000/", authHeader: "authorization" },
    }));
    expect(c.backend.base).toBe("http://127.0.0.1:4000");
    expect(c.backend.authHeader).toBe("authorization");
  });

  it("keeps an optional fixed backend.model", () => {
    const c = loadConfig(write("g.json", base({ backend: { base: "http://127.0.0.1:4000", model: "loop-model" } })));
    expect(c.backend.model).toBe("loop-model");
  });
});

describe("ergonomics: env expansion, overrides, reshaper", () => {
  it("expands ${ENV} in backend.base and throws on an unset var", () => {
    process.env.RP_TEST_BASE = "http://127.0.0.1:4000";
    const c = loadConfig(write("env.json", base({ backend: { base: "${RP_TEST_BASE}" } })));
    expect(c.backend.base).toBe("http://127.0.0.1:4000");
    delete process.env.RP_TEST_BASE;

    expect(() => loadConfig(write("env2.json", base({ backend: { base: "${RP_MISSING_VAR}" } }))))
      .toThrow(/unset env var \$\{RP_MISSING_VAR\}/);
  });

  it("applies CLI overrides (backend-base/model/mode/listen) over the file", () => {
    const p = write("ovr.json", base({ mode: "detect" }));
    const c = loadConfig(p, {
      backendBase: "http://127.0.0.1:5000",
      model: "override-model",
      mode: "strict",
      listen: "127.0.0.1:9000",
    });
    expect(c.backend.base).toBe("http://127.0.0.1:5000");
    expect(c.backend.model).toBe("override-model");
    expect(c.port).toBe(9000);
    expect(c.mode).toBe("strict");
  });

  it("repair mode requires an explicit reshaper", () => {
    expect(() => loadConfig(write("noreshape.json", base({ mode: "repair" }))))
      .toThrow(/requires a config\.reshaper/);
  });

  it("parses an explicit reshaper block (openai kind defaults authorization header)", () => {
    const c = loadConfig(write("explicit.json", base({
      mode: "repair",
      reshaper: { base: "https://cheap.test/v1", kind: "openai", model: "cheap-model" },
    })));
    expect(c.reshaper?.base).toBe("https://cheap.test/v1");
    expect(c.reshaper?.model).toBe("cheap-model");
    expect(c.reshaper?.kind).toBe("openai");
    expect(c.reshaper?.authHeader).toBe("authorization");
  });

  it("reshaper kind defaults to anthropic with x-api-key header", () => {
    const c = loadConfig(write("anthres.json", base({
      mode: "repair",
      reshaper: { base: "http://127.0.0.1:4000", model: "cheap-model" },
    })));
    expect(c.reshaper?.kind).toBe("anthropic");
    expect(c.reshaper?.authHeader).toBe("x-api-key");
  });
});
