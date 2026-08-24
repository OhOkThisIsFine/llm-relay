import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadEnvFile, parseDotEnv, wasEnvNameLoadedFromFile } from "../src/dotenv.js";

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
  afterEach(() => {
    loadEnvFile(join(dir, "provenance-reset-missing.env"), {});
    rmSync(dir, { recursive: true, force: true });
  });

  it("loads variables that are not already set", () => {
    writeFileSync(file, "NEW_KEY=fromfile\n");
    const env: NodeJS.ProcessEnv = {};
    const res = loadEnvFile(file, env);
    expect(env.NEW_KEY).toBe("fromfile");
    expect(res.loaded).toEqual(["NEW_KEY"]);
    expect(wasEnvNameLoadedFromFile("NEW_KEY")).toBe(false);
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

  // Presence has ONE definition (`keyIsPresent`), so a whitespace-only exported
  // variable is absent here too and must not shadow a real key in the file.
  it("treats a whitespace-only existing value as unset", () => {
    writeFileSync(file, "SPACES=fromfile\n");
    const env: NodeJS.ProcessEnv = { SPACES: "   " };
    const res = loadEnvFile(file, env);
    expect(env.SPACES).toBe("fromfile");
    expect(res.loaded).toEqual(["SPACES"]);
    expect(res.skipped).toEqual([]);
  });

  it("is a no-op when the file does not exist", () => {
    const env: NodeJS.ProcessEnv = {};
    const res = loadEnvFile(join(dir, "nope.env"), env);
    expect(res.loaded).toEqual([]);
    expect(env).toEqual({});
  });

  it("records only names populated into the actual process.env, while a preexisting winenv-like name remains env", () => {
    const names = ["DOTENV_PROVENANCE_LOADED", "DOTENV_PROVENANCE_PREEXISTING"];
    const saved = Object.fromEntries(names.map((name) => [name, process.env[name]]));
    for (const name of names) delete process.env[name];
    try {
      process.env.DOTENV_PROVENANCE_PREEXISTING = "recovered-before-dotenv";
      writeFileSync(file, [
        "DOTENV_PROVENANCE_LOADED=from-file",
        "DOTENV_PROVENANCE_PREEXISTING=file-must-not-win",
      ].join("\n"));

      const result = loadEnvFile(file);
      expect(result.loaded).toEqual(["DOTENV_PROVENANCE_LOADED"]);
      expect(result.skipped).toEqual(["DOTENV_PROVENANCE_PREEXISTING"]);
      expect(wasEnvNameLoadedFromFile("DOTENV_PROVENANCE_LOADED")).toBe(true);
      expect(wasEnvNameLoadedFromFile("DOTENV_PROVENANCE_PREEXISTING")).toBe(false);
    } finally {
      for (const name of names) {
        const value = saved[name];
        if (value === undefined) delete process.env[name];
        else process.env[name] = value;
      }
    }
  });

  it("clears recorded provenance on every reload, including absent and unreadable files", () => {
    const name = "DOTENV_PROVENANCE_RESET";
    const saved = process.env[name];
    delete process.env[name];
    try {
      writeFileSync(file, `${name}=from-file\n`);
      loadEnvFile(file);
      expect(wasEnvNameLoadedFromFile(name)).toBe(true);

      loadEnvFile(join(dir, "absent.env"));
      expect(wasEnvNameLoadedFromFile(name)).toBe(false);

      delete process.env[name];
      loadEnvFile(file);
      expect(wasEnvNameLoadedFromFile(name)).toBe(true);
      loadEnvFile(dir);
      expect(wasEnvNameLoadedFromFile(name)).toBe(false);
    } finally {
      if (saved === undefined) delete process.env[name];
      else process.env[name] = saved;
    }
  });
});
