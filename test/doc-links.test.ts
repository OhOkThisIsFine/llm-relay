import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative, resolve, dirname, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

/**
 * Pins that every relative link in this repository's own documentation set resolves to a file that
 * exists — the third mechanical doc guard, beside `test/architecture-map.test.ts` (every `src/`
 * module has a table row) and `test/scripts-inventory.test.ts`.
 *
 * It exists because 106 links across two design docs were written repo-root-relative
 * (`](src/server.ts#L1487)`) from inside `docs/`, so every one of them 404'd from the day it was
 * written; nothing could notice, because a broken link fails silently in a reader's browser rather
 * than in a gate.
 *
 * ⚠ SCOPE is the documentation set this repository authors and ships: `README.md`, `CLAUDE.md`,
 * `HANDOFF.md`, `scripts/CLAUDE.md` and `docs/**`. `AGENTS.md` and `.claude/` are deliberately
 * OUT — their content is written into marker regions by external installers (`sync.mjs`, the
 * `/audit-code` installer), some of which legitimately point at gitignored, locally-installed
 * paths. Pinning those would fail a fresh clone for a link this repository does not own.
 *
 * ⚠ A `#Lnn` fragment on a SOURCE file is a GitHub blob anchor and is allowed; the same fragment
 * on a `.md` target is not, because a rendered markdown page has no line anchors — it would look
 * like a precise pointer and land nowhere.
 */

const repoRoot = fileURLToPath(new URL("../", import.meta.url));

function walkMarkdown(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) out.push(...walkMarkdown(full));
    else if (entry.endsWith(".md")) out.push(full);
  }
  return out;
}

const docFiles = [
  join(repoRoot, "README.md"),
  join(repoRoot, "CLAUDE.md"),
  join(repoRoot, "HANDOFF.md"),
  join(repoRoot, "scripts", "CLAUDE.md"),
  ...walkMarkdown(join(repoRoot, "docs")),
].sort();

interface Link {
  readonly from: string;
  readonly target: string;
  readonly fragment: string | null;
}

function linksIn(file: string): Link[] {
  const out: Link[] = [];
  for (const match of readFileSync(file, "utf8").matchAll(/\]\(([^)\s]+)\)/g)) {
    const raw = match[1]!;
    if (/^(https?:|mailto:|#)/.test(raw)) continue;
    const hash = raw.indexOf("#");
    const target = hash === -1 ? raw : raw.slice(0, hash);
    if (!target) continue;
    out.push({
      from: relative(repoRoot, file).split(sep).join("/"),
      target,
      fragment: hash === -1 ? null : raw.slice(hash + 1),
    });
  }
  return out;
}

const allLinks = docFiles.flatMap(linksIn);

describe("documentation links", () => {
  it("finds links to check", () => {
    expect(allLinks.length).toBeGreaterThan(50);
  });

  it("every relative link resolves to a file that exists", () => {
    const broken = allLinks
      // A `path.ts:120` suffix is this repo's own file:line notation, not part of the filename.
      .filter(({ from, target }) => !existsSync(resolve(dirname(join(repoRoot, from)), target.replace(/:\d+(-\d+)?$/, ""))))
      .map(({ from, target }) => `${from}  ->  ${target}`);
    expect(
      [...new Set(broken)].sort(),
      `These documentation links do not resolve:\n  ${[...new Set(broken)].sort().join("\n  ")}`,
    ).toEqual([]);
  });

  it("no markdown target carries a line-number fragment", () => {
    const bogus = allLinks
      .filter(({ target, fragment }) => target.endsWith(".md") && fragment !== null && /^L\d+/.test(fragment))
      .map(({ from, target, fragment }) => `${from}  ->  ${target}#${fragment}`);
    expect(
      [...new Set(bogus)].sort(),
      `A rendered .md page has no line anchors, so these point nowhere:\n  ${[...new Set(bogus)].sort().join("\n  ")}`,
    ).toEqual([]);
  });
});
