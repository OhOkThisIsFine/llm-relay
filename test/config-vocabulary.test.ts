import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { describe, expect, it } from "vitest";
import { EFFORT_LEVELS as effortLevelsViaConfig } from "../src/config.js";
import { EFFORT_LEVELS as effortLevelsViaTypes } from "../src/config-types.js";

/**
 * Pins DR-001 (audit 2026-09-03): the configuration vocabulary has ONE declaration.
 *
 * `src/config-types.ts` used to duplicate 31 exported names from `src/config.ts` — including the
 * RUNTIME array `EFFORT_LEVELS`, declared twice and imported by different consumers — and the two
 * copies had already drifted when this landed: `HedgeConfig` gained `minFloorMs` and
 * `msPerInputToken` in config.ts only (`cc4da1b`), so a module bound to the other copy compiled
 * clean against a stale shape. That is the closed-vocabulary defect class `CLAUDE.md` tracks, at
 * module scope instead of union-member scope. Since 2026-09-04 `config-types.ts` is the one
 * declaration and `config.ts` re-exports it.
 */
const SRC = join(__dirname, "..", "src");
const EXPORT_DECLARATION = /^export (?:const|type|interface|function|class) ([A-Za-z0-9_]+)/gm;

function declaredNames(text: string): string[] {
  return [...text.matchAll(EXPORT_DECLARATION)].map((m) => m[1]!);
}

function sourceFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    const path = join(dir, entry);
    if (statSync(path).isDirectory()) out.push(...sourceFiles(path));
    else if (entry.endsWith(".ts")) out.push(path);
  }
  return out;
}

describe("the configuration vocabulary has one declaration (DR-001)", () => {
  const vocabulary = declaredNames(readFileSync(join(SRC, "config-types.ts"), "utf8"));

  it("config-types.ts declares the vocabulary, runtime constants included", () => {
    for (const name of ["Config", "Routing", "ProviderConfig", "HedgeConfig", "EFFORT_LEVELS", "CLAUDE_TIER_NAMES"]) {
      expect(vocabulary).toContain(name);
    }
  });

  it("no other src module declares a name config-types.ts declares", () => {
    const offenders: string[] = [];
    for (const file of sourceFiles(SRC)) {
      if (file.endsWith("config-types.ts")) continue;
      for (const name of declaredNames(readFileSync(file, "utf8"))) {
        if (vocabulary.includes(name)) offenders.push(`${relative(SRC, file)}: ${name}`);
      }
    }
    expect(offenders).toEqual([]);
  });

  it("config.ts re-exports the same runtime binding rather than a second array", () => {
    expect(effortLevelsViaConfig).toBe(effortLevelsViaTypes);
  });

  it("the shape that drifted carries both lap-2 keys in the one declaration", () => {
    const text = readFileSync(join(SRC, "config-types.ts"), "utf8");
    const hedge = text.slice(text.indexOf("export interface HedgeConfig"));
    const body = hedge.slice(0, hedge.indexOf("\n}"));
    expect(body).toContain("minFloorMs?: number;");
    expect(body).toContain("msPerInputToken?: number;");
  });
});
