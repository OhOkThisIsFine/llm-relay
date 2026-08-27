import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

/**
 * Pins `scripts/CLAUDE.md` to the actual `scripts/` directory, both ways: every `.mjs` present
 * must be named in the inventory, and every `.mjs` the inventory names must exist.
 *
 * This is the `test/architecture-map.test.ts` guard applied to the second doc that claims to be an
 * inventory. It exists because the omission was invisible exactly where it cost most: the five
 * scripts missing on 2026-08-27 were `clean-dist`, `dashboard-package-check`,
 * `packed-dashboard-smoke`, `tier-scoring` and `analysis-run` — four of them on the build or gate
 * path, and one of them SHIPPED in the package. The probe and demo scripts, which nothing runs
 * automatically, were all documented.
 */

const repoRoot = fileURLToPath(new URL("../", import.meta.url));
const scriptsDir = join(repoRoot, "scripts");
const inventory = readFileSync(join(scriptsDir, "CLAUDE.md"), "utf8");

const present = readdirSync(scriptsDir)
  .filter((name) => name.endsWith(".mjs"))
  .sort();

/** Names in the inventory are written inside backticks, e.g. `sync-tiers.mjs`. */
const named = [...new Set([...inventory.matchAll(/`([A-Za-z0-9._-]+\.mjs)`/g)].map((m) => m[1]!))].sort();

describe("scripts/CLAUDE.md inventory", () => {
  it("names every .mjs in scripts/", () => {
    const missing = present.filter((name) => !named.includes(name));
    expect(
      missing,
      `scripts/CLAUDE.md does not document:\n  ${missing.join("\n  ")}`,
    ).toEqual([]);
  });

  it("names no .mjs that has been deleted", () => {
    const orphaned = named.filter((name) => !present.includes(name));
    expect(
      orphaned,
      `scripts/CLAUDE.md names scripts that no longer exist:\n  ${orphaned.join("\n  ")}`,
    ).toEqual([]);
  });
});
