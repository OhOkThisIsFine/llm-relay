import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

/**
 * Pins the CLAUDE.md Architecture table to the actual src/ tree: every non-declaration
 * .ts file must have a row. The table cites directories collectively where that is the
 * honest shape (e.g. `kernel/`), so a row naming the file itself OR its containing
 * directory (with trailing slash) both count as coverage.
 *
 * This is the guard §6 rec 7 of the 2026-08-22 drift audit asked for: 15 of the 19 gaps
 * found that day were modules that landed with no propagation into the map.
 */

const repoRoot = fileURLToPath(new URL("../", import.meta.url));
const srcRoot = join(repoRoot, "src");
const claudeMd = readFileSync(join(repoRoot, "CLAUDE.md"), "utf8");

function walk(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) out.push(...walk(full));
    else if (entry.endsWith(".ts") && !entry.endsWith(".d.ts")) out.push(full);
  }
  return out;
}

const srcFiles = walk(srcRoot)
  .map((full) => relative(srcRoot, full).split(sep).join("/"))
  .sort();

/** A file counts as covered when CLAUDE.md names it, or its containing directory (`dir/`). */
function coveredByTable(file: string): boolean {
  if (claudeMd.includes(`\`${file}\``)) return true;
  const dir = file.slice(0, file.lastIndexOf("/") + 1);
  return dir.length > 0 && claudeMd.includes(`\`${dir}\``);
}

describe("CLAUDE.md architecture map", () => {
  it("has a table row (or directory row) for every src/ module", () => {
    const missing = srcFiles.filter((file) => !coveredByTable(file));
    expect(
      missing,
      `CLAUDE.md's Architecture table is missing rows for:\n  ${missing.join("\n  ")}`,
    ).toEqual([]);
  });
});
