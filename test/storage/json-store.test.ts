import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, writeFileSync, readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  atomicWriteJsonSync,
  safeReadJsonSync,
} from "../../src/storage/json-store.js";

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "llm-relay-json-store-test-"));
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe("atomicWriteJsonSync", () => {
  it("writes valid JSON atomically and creates parent directories", () => {
    const target = join(dir, "nested", "dir", "test.json");
    const ok = atomicWriteJsonSync(target, { hello: "world", count: 42 });
    expect(ok).toBe(true);
    expect(existsSync(target)).toBe(true);

    const content = JSON.parse(readFileSync(target, "utf8"));
    expect(content).toEqual({ hello: "world", count: 42 });
  });

  it("handles un-serializable data gracefully when not strict", () => {
    const circular: any = {};
    circular.self = circular;
    const target = join(dir, "fail.json");
    const ok = atomicWriteJsonSync(target, circular);
    expect(ok).toBe(false);
    expect(existsSync(target)).toBe(false);
  });

  it("throws on error when strict: true", () => {
    const circular: any = {};
    circular.self = circular;
    const target = join(dir, "strict-fail.json");
    expect(() => atomicWriteJsonSync(target, circular, { strict: true })).toThrow();
  });
});

describe("safeReadJsonSync", () => {
  it("returns fallback for missing files", () => {
    const target = join(dir, "missing.json");
    const result = safeReadJsonSync(target, { fallback: { default: true } });
    expect(result).toEqual({ default: true });
  });

  it("returns fallback for corrupt JSON", () => {
    const target = join(dir, "corrupt.json");
    writeFileSync(target, "{ corrupt json syntax ...", "utf8");
    const result = safeReadJsonSync(target, { fallback: null });
    expect(result).toBeNull();
  });

  it("validates data schema using the provided validator guard", () => {
    interface Sample {
      version: number;
      name: string;
    }
    const validator = (d: unknown): d is Sample => {
      return typeof d === "object" && d !== null && "version" in d && typeof (d as any).version === "number";
    };

    const validPath = join(dir, "valid.json");
    writeFileSync(validPath, JSON.stringify({ version: 1, name: "test" }), "utf8");
    expect(safeReadJsonSync(validPath, { validator })).toEqual({ version: 1, name: "test" });

    const invalidPath = join(dir, "invalid.json");
    writeFileSync(invalidPath, JSON.stringify({ invalid: true }), "utf8");
    expect(safeReadJsonSync(invalidPath, { validator })).toBeNull();
  });
});

