import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseDotEnv, loadEnvFile } from "../src/dotenv.js";

describe("parseDotEnv", () => {
  it("parses KEY=value, ignoring blanks and comments", () => {
    const out = parseDotEnv(["# a comment", "", "FOO=bar", "  BAZ = qux  "].join("\n"));
    expect(out).toEqual({ FOO: "bar", BAZ: "qux" });
  });

  it("strips one layer of surrounding quotes", () => {
    expect(parseDotEnv(`A="quoted"\nB='single'`)).toEqual({ A: "quoted", B: "single" });
  });

  it("keeps '=' appearing inside the value", () => {
    expect(parseDotEnv("TOKEN=abc=def==")).toEqual({ TOKEN: "abc=def==" });
  });

  it("skips lines with no key or an invalid key", () => {
    expect(parseDotEnv("=novalue\n1BAD=x\nnotanassignment")).toEqual({});
  });
});

describe("loadEnvFile", () => {
  let dir: string;
  let file: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "relay-env-"));
    file = join(dir, ".env");
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it("loads variables that are not already set", () => {
    writeFileSync(file, "NEW_KEY=fromfile\n");
    const env: NodeJS.ProcessEnv = {};
    const res = loadEnvFile(file, env);
    expect(env.NEW_KEY).toBe("fromfile");
    expect(res.loaded).toEqual(["NEW_KEY"]);
  });

  // The real environment is the more explicit signal; a stale file silently overriding it
  // would be a nastier bug than the one this feature fixes.
  it("never overwrites a variable already set in the environment", () => {
    writeFileSync(file, "EXISTING=fromfile\n");
    const env: NodeJS.ProcessEnv = { EXISTING: "fromenv" };
    const res = loadEnvFile(file, env);
    expect(env.EXISTING).toBe("fromenv");
    expect(res.skipped).toEqual(["EXISTING"]);
    expect(res.loaded).toEqual([]);
  });

  it("treats an empty existing value as unset", () => {
    writeFileSync(file, "BLANK=fromfile\n");
    const env: NodeJS.ProcessEnv = { BLANK: "" };
    loadEnvFile(file, env);
    expect(env.BLANK).toBe("fromfile");
  });

  it("is a no-op when the file does not exist", () => {
    const env: NodeJS.ProcessEnv = {};
    const res = loadEnvFile(join(dir, "nope.env"), env);
    expect(res.loaded).toEqual([]);
    expect(env).toEqual({});
  });
});
