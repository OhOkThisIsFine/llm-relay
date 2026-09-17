/**
 * What a dispatched lane changed in its working tree — REPORTED, never reverted (2026-09-17).
 *
 * A lane that writes outside its task is found today only by the caller's own `git status` after the
 * lane returns, and a caller that forgets to look commits the stray edit. So the relay records
 * `git status` when an agent-mode walk starts and again when the job ends, and the answer carries
 * the difference. The relay never refuses and never reverts on it: the caller's own gates decide.
 *
 * The comparison is by STATUS (`git status --porcelain=v1 -z --untracked-files=all`): a path that
 * appeared, changed status, or became clean. A file that was already modified and that the lane
 * modified again keeps its status and is not reported — the stated limit of a status comparison.
 */
import { execFile } from "node:child_process";
import { statSync } from "node:fs";
import { join as joinPath, resolve as resolvePath } from "node:path";

/** At most this many dirty paths are stat-ed when the walk asks whether a lane still writes. */
export const MAX_ACTIVITY_STAT_PATHS = 500;

/** Do two readings hold the same dirty paths with the same status? */
export function sameTree(a: TreeSnapshot, b: TreeSnapshot): boolean {
  if (a.entries.size !== b.entries.size) return false;
  for (const [path, status] of a.entries) {
    if (b.entries.get(path) !== status) return false;
  }
  return true;
}

/**
 * The newest modification time among a reading's dirty paths, or null when none can be read. This
 * catches a lane that keeps editing a file whose STATUS does not change (`M` stays `M`). A deleted
 * path cannot be read and is skipped; `sameTree` catches a deletion.
 */
export function newestChangeMs(
  cwd: string,
  snapshot: TreeSnapshot,
  stat: (path: string) => { mtimeMs: number } = statSync,
): number | null {
  const up = snapshot.prefix.split("/").filter((s) => s !== "").map(() => "..");
  const root = resolvePath(cwd, ...up);
  let newest: number | null = null;
  let seen = 0;
  for (const path of snapshot.entries.keys()) {
    if (++seen > MAX_ACTIVITY_STAT_PATHS) break;
    try {
      const mtime = stat(joinPath(root, path)).mtimeMs;
      if (newest === null || mtime > newest) newest = mtime;
    } catch {
      // Gone or unreadable: no evidence either way.
    }
  }
  return newest;
}

/** One `git status` reading: the cwd's path inside the repository, and each dirty path's status. */
export interface TreeSnapshot {
  /** `git rev-parse --show-prefix`: "" at the repository root, else `sub/dir/`. */
  prefix: string;
  /** Repository-relative path → the two-letter porcelain status. */
  entries: Map<string, string>;
}

/** Null when `cwd` is not inside a git work tree, or git failed. */
export type TreeSnapshotReader = (cwd: string) => Promise<TreeSnapshot | null>;

/** At most this many delta lines are rendered; the rest are counted. */
export const MAX_TREE_DELTA_LINES = 50;

const GIT_TIMEOUT_MS = 15_000;
const GIT_MAX_BUFFER = 16 * 1024 * 1024;

/**
 * Parse `git status --porcelain=v1 -z` output. A rename or copy entry carries its ORIGINAL path in
 * the next NUL-separated field, which is consumed here and not reported as a path of its own.
 */
export function parsePorcelainZ(text: string): Map<string, string> {
  const entries = new Map<string, string>();
  const fields = text.split("\0");
  for (let i = 0; i < fields.length; i++) {
    const field = fields[i] ?? "";
    if (field.length < 4) continue;
    const status = field.slice(0, 2);
    entries.set(field.slice(3), status);
    if (status[0] === "R" || status[0] === "C") i++;
  }
  return entries;
}

function runGit(cwd: string, args: string[]): Promise<string | null> {
  return new Promise((resolve) => {
    execFile(
      "git",
      ["-C", cwd, ...args],
      { windowsHide: true, timeout: GIT_TIMEOUT_MS, maxBuffer: GIT_MAX_BUFFER, encoding: "utf8" },
      (err, stdout) => resolve(err ? null : stdout),
    );
  });
}

/**
 * The real reader. ⚠ Under vitest it reads nothing — returns null — unless a test injects its own
 * reader: a suite run inside a real checkout would otherwise append that checkout's live status to
 * every dispatch answer it asserts on. The `winenv.ts` guard, applied to a read.
 */
export const defaultTreeSnapshot: TreeSnapshotReader = async (cwd) => {
  if (process.env["VITEST"]) return null;
  const prefix = await runGit(cwd, ["rev-parse", "--show-prefix"]);
  if (prefix === null) return null;
  const status = await runGit(cwd, ["status", "--porcelain=v1", "-z", "--untracked-files=all"]);
  if (status === null) return null;
  return { prefix: prefix.trim(), entries: parsePorcelainZ(status) };
};

/** A caller's `scope` entry as a matcher over cwd-relative paths. */
function scopeMatcher(pattern: string): (path: string) => boolean {
  let clean = pattern.replace(/\\/g, "/").replace(/^\.\//, "");
  // A loop, not `/\/+$/`: that pattern backtracks super-linearly on a caller-supplied string.
  while (clean.endsWith("/")) clean = clean.slice(0, -1);
  if (clean === "" || clean === ".") return () => true;
  if (!/[*?]/.test(clean)) return (path) => path === clean || path.startsWith(`${clean}/`);
  let source = "";
  for (let i = 0; i < clean.length; i++) {
    const ch = clean[i] as string;
    if (ch === "*" && clean[i + 1] === "*") {
      source += ".*";
      i++;
    } else if (ch === "*") source += "[^/]*";
    else if (ch === "?") source += "[^/]";
    else source += ch.replace(/[.+^${}()|[\]\\]/g, "\\$&");
  }
  const re = new RegExp(`^${source}(?:/.*)?$`);
  return (path) => re.test(path);
}

/**
 * Render the difference between two readings as the block `jobAnswer` appends. `scope` (paths or
 * globs relative to `cwd`) marks every path outside it `OUT OF SCOPE`; a path outside `cwd` itself is
 * always outside a declared scope. Without a scope nothing is marked.
 */
export function renderTreeDelta(
  cwd: string,
  before: TreeSnapshot,
  after: TreeSnapshot | null,
  scope: readonly string[] | undefined,
): string {
  if (after === null) return `tree delta (${cwd}): unknown — git status failed when the job ended`;
  const matchers = scope?.map(scopeMatcher);
  const outOfScope = (path: string): boolean => {
    if (matchers === undefined) return false;
    if (!path.startsWith(after.prefix)) return true;
    const local = path.slice(after.prefix.length);
    return !matchers.some((m) => m(local));
  };
  const paths = [...new Set([...before.entries.keys(), ...after.entries.keys()])].sort();
  const lines: string[] = [];
  for (const path of paths) {
    const was = before.entries.get(path);
    const now = after.entries.get(path);
    if (was === now) continue;
    const change =
      was === undefined ? `+ ${path} [${now}]` : now === undefined ? `- ${path} [was ${was}; now clean]` : `~ ${path} [${was} -> ${now}]`;
    lines.push(outOfScope(path) ? `${change}  OUT OF SCOPE` : change);
  }
  if (lines.length === 0) return "tree delta: none";
  const shown = lines.slice(0, MAX_TREE_DELTA_LINES);
  const more = lines.length - shown.length;
  const flagged = lines.filter((l) => l.endsWith("OUT OF SCOPE")).length;
  const header = `tree delta (${cwd}): ${lines.length} path${lines.length === 1 ? "" : "s"}` +
    (matchers === undefined ? "" : `, ${flagged} out of scope`);
  return [header, ...shown.map((l) => `  ${l}`), ...(more > 0 ? [`  … ${more} more`] : [])].join("\n");
}
