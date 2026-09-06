import { execFileSync } from "node:child_process";
import { readdirSync, readFileSync, statSync } from "node:fs";
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
 *
 * ⚠⚠ A link TARGET resolves against the files git TRACKS, never against the working tree. An
 * `existsSync` check passed for a file that existed only in one checkout, so a link written beside
 * an uncommitted document was green locally and red in CI — the v0.71.0 publish died exactly that
 * way, on a backlog link to a design doc a concurrent session had not committed. The INDEX is the
 * right granularity rather than HEAD: `git add` is enough, so a document and the link to it still
 * pass together before either is committed.
 *
 * ⚠ Link SOURCES stay the working tree on purpose. A doc you have just written is checked
 * immediately, which is the early warning this guard is for; only what it POINTS AT has to be
 * staged.
 */

const repoRoot = fileURLToPath(new URL("../", import.meta.url));

/**
 * Every path git has in its index, repo-relative with `/` separators — `ls-files` emits exactly
 * that shape on every platform, so no separator translation is needed here.
 */
const trackedFiles = new Set(
  execFileSync("git", ["ls-files", "-z"], {
    cwd: repoRoot,
    encoding: "utf8",
    maxBuffer: 64 * 1024 * 1024,
  })
    .split("\0")
    .filter((entry) => entry.length > 0),
);

/**
 * Every directory holding a tracked file. `ls-files` lists files only, and a link may legitimately
 * point at a directory (`](docs/)`), which would otherwise read as broken.
 */
const trackedDirs = new Set<string>();
for (const file of trackedFiles) {
  for (let cut = file.lastIndexOf("/"); cut !== -1; cut = file.lastIndexOf("/", cut - 1)) {
    trackedDirs.add(file.slice(0, cut));
  }
}

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

/**
 * Resolve one link the way a reader on github.com would, then ask the index — not the disk —
 * whether the answer exists. A target outside the repository can never be tracked, so it is
 * reported broken rather than silently passed.
 */
function resolvesInIndex(from: string, target: string): boolean {
  // A `path.ts:120` suffix is this repo's own file:line notation, not part of the filename.
  const abs = resolve(dirname(join(repoRoot, from)), target.replace(/:\d+(-\d+)?$/, ""));
  const rel = relative(repoRoot, abs).split(sep).join("/");
  if (rel === "") return true;
  if (rel === ".." || rel.startsWith("../")) return false;
  return trackedFiles.has(rel) || trackedDirs.has(rel);
}

const allLinks = docFiles.flatMap(linksIn);

describe("documentation links", () => {
  it("reads the tracked-file set from git", () => {
    // A silent empty set would pass every other case here by reporting nothing broken.
    expect(trackedFiles.size).toBeGreaterThan(100);
  });

  it("finds links to check", () => {
    expect(allLinks.length).toBeGreaterThan(50);
  });

  it("every relative link resolves to a file git tracks", () => {
    const broken = allLinks
      .filter(({ from, target }) => !resolvesInIndex(from, target))
      .map(({ from, target }) => `${from}  ->  ${target}`);
    expect(
      [...new Set(broken)].sort(),
      `These documentation links do not resolve against the git index:\n  ${[...new Set(broken)].sort().join("\n  ")}`,
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
