import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, writeFileSync, readFileSync, existsSync, renameSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  atomicWriteJsonSync,
  replaceFileWithRetrySync,
  safeReadJsonSync,
  transactionalUpdateJsonSync,
} from "../../src/storage/json-store.js";

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "llm-relay-json-store-test-"));
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe("replaceFileWithRetrySync", () => {
  it("retries transient Windows replacement failures and keeps the same source/destination", () => {
    for (const code of ["EPERM", "EACCES", "EBUSY"]) {
      const calls: Array<[string, string]> = [];
      const delays: number[] = [];
      let failuresLeft = 2;
      const rename: typeof renameSync = (source, target): void => {
        calls.push([String(source), String(target)]);
        if (failuresLeft > 0) {
          failuresLeft -= 1;
          throw Object.assign(new Error(`transient ${code}`), { code });
        }
      };

      expect(() =>
        replaceFileWithRetrySync("state.tmp", "state.json", {
          platform: "win32",
          rename,
          sleep: (ms) => delays.push(ms),
        }),
      ).not.toThrow();
      expect(calls).toEqual([
        ["state.tmp", "state.json"],
        ["state.tmp", "state.json"],
        ["state.tmp", "state.json"],
      ]);
      expect(delays).toEqual([10, 20]);
    }
  });

  it("gives up after the bounded Windows retry schedule", () => {
    let calls = 0;
    const delays: number[] = [];
    const rename: typeof renameSync = (_source, _target): never => {
      calls += 1;
      throw Object.assign(new Error("still locked"), { code: "EPERM" });
    };

    expect(() =>
      replaceFileWithRetrySync("state.tmp", "state.json", {
        platform: "win32",
        rename,
        sleep: (ms) => delays.push(ms),
      }),
    ).toThrow("still locked");
    expect(calls).toBe(9);
    expect(delays).toEqual([10, 20, 40, 80, 160, 250, 250, 250]);
  });

  it("does not retry a non-Windows or non-transient rename failure", () => {
    for (const [platform, code] of [["linux", "EPERM"], ["win32", "ENOENT"]] as const) {
      let calls = 0;
      let sleeps = 0;
      const rename: typeof renameSync = (_source, _target): never => {
        calls += 1;
        throw Object.assign(new Error(`${platform} ${code}`), { code });
      };

      expect(() =>
        replaceFileWithRetrySync("state.tmp", "state.json", {
          platform,
          rename,
          sleep: () => { sleeps += 1; },
        }),
      ).toThrow(code);
      expect(calls).toBe(1);
      expect(sleeps).toBe(0);
    }
  });
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



describe("transactionalUpdateJsonSync", () => {
  interface RowsFile {
    version: 1;
    rows: string[];
  }

  const validator = (value: unknown): value is RowsFile =>
    typeof value === "object" &&
    value !== null &&
    (value as { version?: unknown }).version === 1 &&
    Array.isArray((value as { rows?: unknown }).rows) &&
    (value as { rows: unknown[] }).rows.every((row) => typeof row === "string");

  it("creates an absent file from a null starting state", () => {
    const target = join(dir, "transaction-new.json");
    expect(
      transactionalUpdateJsonSync<RowsFile>(
        target,
        (current) => ({ version: 1, rows: [...(current?.rows ?? []), "a"] }),
        { validator, strict: true },
      ),
    ).toBe(true);
    expect(JSON.parse(readFileSync(target, "utf8"))).toEqual({ version: 1, rows: ["a"] });
  });

  it("fails closed instead of treating corrupt existing JSON as empty", () => {
    const target = join(dir, "transaction-corrupt.json");
    writeFileSync(target, "{ definitely not valid json", "utf8");

    expect(() =>
      transactionalUpdateJsonSync<RowsFile>(
        target,
        (current) => ({ version: 1, rows: [...(current?.rows ?? []), "replacement"] }),
        { validator, strict: true },
      ),
    ).toThrow();

    expect(readFileSync(target, "utf8")).toBe("{ definitely not valid json");
  });

  it("fails closed instead of replacing an existing file that fails validation", () => {
    const target = join(dir, "transaction-invalid-shape.json");
    const original = JSON.stringify({ version: 1, rows: [42] });
    writeFileSync(target, original, "utf8");

    expect(
      transactionalUpdateJsonSync<RowsFile>(
        target,
        () => ({ version: 1, rows: ["replacement"] }),
        { validator },
      ),
    ).toBe(false);

    expect(readFileSync(target, "utf8")).toBe(original);
  });
});
