import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { writeFileSync, mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { loadConfig } from "../src/config.js";

let dir: string;
beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), "rp-cfg-"));
});
afterAll(() => rmSync(dir, { recursive: true, force: true }));

function write(name: string, obj: unknown): string {
  const p = join(dir, name);
  writeFileSync(p, JSON.stringify(obj));
  return p;
}

const BACKEND = { base: "https://example.test/anthropic" };

describe("loadConfig", () => {
  it("accepts 127.0.0.1", () => {
    const c = loadConfig(write("a.json", { listen: "127.0.0.1:8791", backend: BACKEND }));
    expect(c.host).toBe("127.0.0.1");
    expect(c.port).toBe(8791);
    expect(c.backend.authHeader).toBe("x-api-key"); // default
    expect(c.backend.timeoutMs).toBe(120000); // default
  });

  it("accepts bracketed IPv6 loopback [::1]", () => {
    const c = loadConfig(write("b.json", { listen: "[::1]:8791", backend: BACKEND }));
    expect(c.host).toBe("::1");
    expect(c.port).toBe(8791);
  });

  it("rejects a non-loopback bind", () => {
    expect(() => loadConfig(write("c.json", { listen: "0.0.0.0:8791", backend: BACKEND }))).toThrow(/loopback/);
  });

  it("rejects an out-of-range port", () => {
    expect(() => loadConfig(write("d.json", { listen: "127.0.0.1:99999", backend: BACKEND }))).toThrow(/port/);
  });

  it("requires backend.base", () => {
    expect(() => loadConfig(write("e.json", { listen: "127.0.0.1:8791" }))).toThrow(/backend\.base/);
  });

  it("honors authHeader=authorization when set", () => {
    const c = loadConfig(write("f.json", { listen: "127.0.0.1:8791", backend: { ...BACKEND, authHeader: "authorization" } }));
    expect(c.backend.authHeader).toBe("authorization");
  });
});

describe("ergonomics: env expansion, overrides, reshaper synthesis", () => {
  it("expands ${ENV} in base/model and throws on an unset var", () => {
    process.env.RP_TEST_BASE = "https://nim.test/v1";
    const c = loadConfig(write("env.json", {
      listen: "127.0.0.1:8791",
      backend: { base: "${RP_TEST_BASE}", kind: "openai", model: "meta/llama-3.1-70b-instruct" },
    }));
    expect(c.backend.base).toBe("https://nim.test/v1");
    delete process.env.RP_TEST_BASE;

    expect(() => loadConfig(write("env2.json", {
      backend: { base: "${RP_MISSING_VAR}" },
    }))).toThrow(/unset env var \$\{RP_MISSING_VAR\}/);
  });

  it("applies CLI overrides over the file (base/model/mode/listen)", () => {
    const p = write("ovr.json", {
      listen: "127.0.0.1:8791",
      backend: { base: "https://old.test/v1", kind: "openai", model: "old-model" },
      mode: "detect",
    });
    const c = loadConfig(p, { backendBase: "https://new.test/v1", model: "new-model", mode: "repair", listen: "127.0.0.1:9000" });
    expect(c.backend.base).toBe("https://new.test/v1");
    expect(c.backend.model).toBe("new-model");
    expect(c.port).toBe(9000);
    expect(c.mode).toBe("repair");
  });

  it("synthesizes a reshaper from an OpenAI backend in repair mode (no reshaper block)", () => {
    const c = loadConfig(write("syn.json", {
      listen: "127.0.0.1:8791",
      backend: { base: "https://nim.test/v1", kind: "openai", model: "meta/llama-3.1-70b-instruct", authEnv: "NVIDIA_API_KEY" },
      mode: "repair",
    }));
    expect(c.reshaper).toBeDefined();
    expect(c.reshaper?.kind).toBe("openai");
    expect(c.reshaper?.base).toBe("https://nim.test/v1");
    expect(c.reshaper?.model).toBe("meta/llama-3.1-70b-instruct");
    expect(c.reshaper?.authEnv).toBe("NVIDIA_API_KEY");
  });

  it("still requires an explicit reshaper for an Anthropic backend in repair mode", () => {
    expect(() => loadConfig(write("noreshape.json", {
      listen: "127.0.0.1:8791",
      backend: { base: "https://api.anthropic.test", kind: "anthropic" },
      mode: "repair",
    }))).toThrow(/requires a config\.reshaper/);
  });

  it("an explicit reshaper block still wins over synthesis", () => {
    const c = loadConfig(write("explicit.json", {
      listen: "127.0.0.1:8791",
      backend: { base: "https://nim.test/v1", kind: "openai", model: "big-model" },
      mode: "repair",
      reshaper: { base: "https://cheap.test/v1", kind: "openai", model: "cheap-model" },
    }));
    expect(c.reshaper?.base).toBe("https://cheap.test/v1");
    expect(c.reshaper?.model).toBe("cheap-model");
  });
});
