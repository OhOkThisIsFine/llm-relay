import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { withFileLockSync } from "../src/storage/file-lock.js";
import { exerciseReclamationRace } from "./helpers/file-lock-race.js";

let dir: string;
let target: string;
let lockPath: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "relay-lock-test-"));
  target = join(dir, "state.json");
  lockPath = `${target}.lock`;
});
afterEach(() => {
  vi.restoreAllMocks();
  rmSync(dir, { recursive: true, force: true });
});

const bounded = { retryMs: 1, timeoutMs: 50 };
function seedOwner(instance = randomUUID()): string {
  mkdirSync(lockPath);
  const marker = join(lockPath, `owner-${instance}.json`);
  writeFileSync(marker, JSON.stringify({ version: 2, pid: process.pid, instance, acquiredAt: 1 }));
  return marker;
}

describe("file lock ownership", () => {
  it("publishes a complete unique generation and releases it even when work throws", () => {
    const instances: string[] = [];
    for (let i = 0; i < 2; i += 1) {
      expect(() => withFileLockSync(target, () => {
        const files = readdirSync(lockPath);
        expect(files).toHaveLength(1);
        const owner = JSON.parse(readFileSync(join(lockPath, files[0]!), "utf8")) as { version: number; instance: string };
        expect(owner.version).toBe(2);
        expect(files[0]).toBe(`owner-${owner.instance}.json`);
        instances.push(owner.instance);
        throw new Error("work failed");
      })).toThrow("work failed");
      expect(existsSync(lockPath)).toBe(false);
    }
    expect(new Set(instances).size).toBe(2);
    expect(readdirSync(dir)).toEqual([]);
  });

  it("does not steal a live generation, including a reused live PID", () => {
    const marker = seedOwner();
    const before = readFileSync(marker, "utf8");
    const work = vi.fn();
    expect(() => withFileLockSync(target, work, { ...bounded, isAlive: () => true })).toThrow(/Timed out/);
    expect(work).not.toHaveBeenCalled();
    expect(readFileSync(marker, "utf8")).toBe(before);
    expect(readdirSync(dir)).toEqual(["state.json.lock"]);
  });

  it.each(["EPERM", "EACCES", "EIO"])("treats a %s liveness error as unknown, not proof of death", (code) => {
    const marker = seedOwner();
    vi.spyOn(process, "kill").mockImplementation(() => { throw Object.assign(new Error(code), { code }); });
    expect(() => withFileLockSync(target, () => { throw new Error("entered"); }, bounded)).toThrow(/Timed out/);
    expect(existsSync(marker)).toBe(true);
  });

  it("recovers an empty directory left after a retired owner marker", () => {
    mkdirSync(lockPath);
    expect(withFileLockSync(target, () => 42, bounded)).toBe(42);
    expect(existsSync(lockPath)).toBe(false);
  });

  it.each(["legacy", "malformed", "mismatched", "extra-file"])("preserves a %s lock instead of guessing ownership", (kind) => {
    if (kind === "legacy") {
      mkdirSync(lockPath);
      writeFileSync(join(lockPath, "owner.json"), JSON.stringify({ version: 1, pid: process.pid, instance: "old", acquiredAt: 1 }));
    } else if (kind === "malformed") {
      mkdirSync(lockPath);
      writeFileSync(join(lockPath, "unknown.json"), "{ broken");
    } else if (kind === "mismatched") {
      const marker = seedOwner();
      const owner = JSON.parse(readFileSync(marker, "utf8")) as { instance: string };
      owner.instance = randomUUID();
      writeFileSync(marker, JSON.stringify(owner));
    } else {
      seedOwner();
      writeFileSync(join(lockPath, "unexpected"), "preserve me");
    }
    const snapshot = () => readdirSync(lockPath).sort().map((file) => [file, readFileSync(join(lockPath, file), "utf8")]);
    const before = snapshot();
    const work = vi.fn();
    expect(() => withFileLockSync(target, work, { ...bounded, isAlive: () => false })).toThrow(
      kind === "legacy" ? /legacy lock present.*Stop all relay\/MCP writers/ : /Timed out/,
    );
    expect(work).not.toHaveBeenCalled();
    expect(snapshot()).toEqual(before);
  });

  it.each(["owner-read", "retired-marker"] as const)("preserves mutual exclusion and both rows when a reclaimer pauses at %s", async (pauseAt) => {
    const result = await exerciseReclamationRace({ pauseAt });
    expect(result.enteredWhileReplacementHeld, result.stderr.join("\n")).toBe(false);
    expect(result.exits, result.stderr.join("\n")).toEqual([
      { code: 0, signal: null },
      { code: 0, signal: null },
    ]);
    expect(result.rows).toEqual(["replacement", "late"]);
  }, 60_000);
});
