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
