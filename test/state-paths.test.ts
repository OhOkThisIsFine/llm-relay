import { readdirSync, readFileSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { legacyRelayDir, relayBaseDir, relayStatePath } from "../src/state-paths.js";

/**
 * The state-directory policy, pinned — including the legacy fallback, which is the only thing
 * standing between "honour XDG everywhere" and an operator's keystore reading as empty.
 *
 * The seams (`env`, `home`, `exists`) are injected throughout: this test must never consult the
 * real environment or the real filesystem, for the same reason every resolver carries a VITEST
 * guard.
 */

const HOME = join("/fake", "home");
const LEGACY = join(HOME, ".llm-relay");
const noneExist = () => false;

describe("relayBaseDir", () => {
  it("uses XDG_CONFIG_HOME for config and XDG_CACHE_HOME for cache", () => {
    const env = { XDG_CONFIG_HOME: join("/x", "cfg"), XDG_CACHE_HOME: join("/x", "cache") };
    expect(relayBaseDir("config", { env, home: HOME })).toBe(join("/x", "cfg", "llm-relay"));
    expect(relayBaseDir("cache", { env, home: HOME })).toBe(join("/x", "cache", "llm-relay"));
  });

  it("never crosses the two variables", () => {
    // A cache artifact must not follow XDG_CONFIG_HOME, or setting one variable would move the
    // other kind too — the split this module exists to end, reintroduced by a typo.
    const env = { XDG_CONFIG_HOME: join("/x", "cfg") };
    expect(relayBaseDir("cache", { env, home: HOME })).toBe(LEGACY);
    expect(relayBaseDir("config", { env, home: HOME })).toBe(join("/x", "cfg", "llm-relay"));
  });

  it.each([
    ["unset", {}],
    ["empty", { XDG_CONFIG_HOME: "" }],
    ["whitespace only", { XDG_CONFIG_HOME: "   " }],
  ])("falls back to ~/.llm-relay when the variable is %s", (_label, env) => {
    expect(relayBaseDir("config", { env, home: HOME })).toBe(LEGACY);
  });
});

describe("relayStatePath legacy fallback", () => {
  const env = { XDG_CONFIG_HOME: join("/x", "cfg") };
  const xdgKeystore = join("/x", "cfg", "llm-relay", "keystore.json");
  const legacyKeystore = join(LEGACY, "keystore.json");

  it("returns the XDG path on a fresh install where neither exists", () => {
    expect(relayStatePath("config", ["keystore.json"], { env, home: HOME, exists: noneExist }))
      .toBe(xdgKeystore);
  });

  it("returns the LEGACY path when only the legacy file exists", () => {
    // The whole safety story: an install whose credentials live at the old location keeps finding
    // them, so honouring XDG can never turn a working store into an empty one.
    const exists = (path: string) => path === legacyKeystore;
    expect(relayStatePath("config", ["keystore.json"], { env, home: HOME, exists }))
      .toBe(legacyKeystore);
  });

  it("returns the XDG path once it exists, even with a legacy file still beside it", () => {
    const exists = () => true;
    expect(relayStatePath("config", ["keystore.json"], { env, home: HOME, exists }))
      .toBe(xdgKeystore);
  });

  it("never consults the filesystem when XDG is unset", () => {
    // With no variable set the two bases are identical, so there is nothing to fall back to and a
    // stat would be pure cost on a path every CLI start touches.
    let calls = 0;
    const exists = () => { calls += 1; return true; };
    expect(relayStatePath("config", ["keystore.json"], { env: {}, home: HOME, exists }))
      .toBe(legacyKeystore);
    expect(calls).toBe(0);
  });

  it("addresses the base directory itself when given no segments", () => {
    expect(relayStatePath("config", [], { env, home: HOME, exists: noneExist }))
      .toBe(join("/x", "cfg", "llm-relay"));
  });

  it("joins nested segments", () => {
    expect(relayStatePath("config", ["hooks", "x.mjs"], { env, home: HOME, exists: noneExist }))
      .toBe(join("/x", "cfg", "llm-relay", "hooks", "x.mjs"));
  });

  it("defaults home to the real homedir without touching env or fs", () => {
    expect(legacyRelayDir()).toBe(join(homedir(), ".llm-relay"));
  });
});

/**
 * The mechanical half: `state-paths.ts` must stay the ONLY place in `src/` that names the XDG
 * variables or the literal `~/.llm-relay` base. Thirteen resolvers each hand-rolling this is
 * exactly how three incompatible policies came to coexist, and a source grep is what stops a
 * fourteenth quietly appearing — the `dashboard-routes.ts` error-code precedent.
 */
const srcRoot = fileURLToPath(new URL("../src/", import.meta.url));

function walk(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) out.push(...walk(full));
    else if (entry.endsWith(".ts")) out.push(full);
  }
  return out;
}

const sources = walk(srcRoot)
  .map((full) => [full.slice(srcRoot.length).split(sep).join("/"), readFileSync(full, "utf8")] as const)
  .filter(([name]) => name !== "state-paths.ts");

describe("one owner for the state directory", () => {
  it("no other src/ module reads an XDG variable", () => {
    const offenders = sources
      .filter(([, text]) => /XDG_(CONFIG|CACHE|DATA)_HOME/.test(text))
      .map(([name]) => name);
    expect(
      offenders,
      `These modules read an XDG variable directly; use relayStatePath() instead:\n  ${offenders.join("\n  ")}`,
    ).toEqual([]);
  });

  it("no other src/ module joins homedir() with the literal .llm-relay", () => {
    const offenders = sources
      .filter(([, text]) => /homedir\(\)\s*,\s*["']\.llm-relay["']/.test(text))
      .map(([name]) => name);
    expect(
      offenders,
      `These modules hardcode the legacy state directory; use relayStatePath() instead:\n  ${offenders.join("\n  ")}`,
    ).toEqual([]);
  });
});
