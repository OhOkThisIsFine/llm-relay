/**
 * Version currency: nobody should unknowingly run a stale llm-relay.
 *
 * Every start compares the running version against the registry (cached, short
 * timeout, fail-open). If a newer version exists:
 *   - a globally-installed copy updates itself and re-execs into the new build;
 *   - any other copy (dev checkout, npx, local dependency) is told, with the
 *     exact command, and continues on the old version.
 *
 * The update is a clean replace: npm installs the new version, then any bin
 * shim that belonged to the OLD package but is not a bin of the new one is
 * deleted, so a renamed/dropped bin never leaves a dangling `.cmd`/`.ps1`
 * behind on the PATH.
 */
import { existsSync, mkdirSync, readFileSync, rmSync, readdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { homedir } from "node:os";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";

export const PACKAGE_NAME = "llm-relay";
/** Re-exec marker: set on the child so an update can never recurse. */
export const SUPPRESS_ENV = "LLM_RELAY_NO_SELF_UPDATE";
const REGISTRY = "https://registry.npmjs.org";
const CHECK_TIMEOUT_MS = 2500;
/** How long a registry answer is reused before we ask again. */
export const CHECK_INTERVAL_MS = 6 * 60 * 60 * 1000;

export type InstallKind = "global" | "dev" | "managed";

export interface UpdateCache {
  checkedAt: number;
  latest: string;
}

// ---------------------------------------------------------------- pure logic

interface Parsed {
  release: number[];
  prerelease: string | null;
}

/**
 * Strict, END-ANCHORED semver. The anchor is load-bearing, not cosmetic: this
 * value arrives from an HTTPS response to the npm registry and from a
 * user-writable cache file, and it is passed to a subprocess. An unanchored
 * pattern accepts `9.9.9 & calc.exe` as a clean parse of `9.9.9`, and the
 * trailing shell metacharacters then travel with it.
 */
function parseVersion(v: string): Parsed | null {
  const m = /^v?(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?(?:\+[0-9A-Za-z.-]+)?$/.exec(v.trim());
  if (!m) return null;
  return { release: [Number(m[1]), Number(m[2]), Number(m[3])], prerelease: m[4] ?? null };
}

/** True only for a full-string semver — the gate every registry- or cache-supplied version must clear. */
export function isValidVersion(v: unknown): v is string {
  return typeof v === "string" && parseVersion(v) !== null;
}

/**
 * Semver prerelease ordering: dot-separated identifiers left to right, numeric
 * identifiers compared numerically, a numeric identifier ranking below an
 * alphanumeric one, and a shorter run of otherwise-equal identifiers ranking
 * lower. Plain string comparison gets this wrong — it sorts `rc.9` above `rc.10`.
 */
function comparePrerelease(a: string, b: string): number {
  const pa = a.split(".");
  const pb = b.split(".");
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const x = pa[i];
    const y = pb[i];
    if (x === undefined) return -1;
    if (y === undefined) return 1;
    const nx = /^\d+$/.test(x);
    const ny = /^\d+$/.test(y);
    if (nx && ny) {
      const d = Number(x) - Number(y);
      if (d !== 0) return d < 0 ? -1 : 1;
    } else if (nx !== ny) {
      return nx ? -1 : 1;
    } else if (x !== y) {
      return x < y ? -1 : 1;
    }
  }
  return 0;
}

/** -1 / 0 / 1, semver-ordered for the subset we publish. Unparseable sorts equal. */
export function compareVersions(a: string, b: string): number {
  const pa = parseVersion(a);
  const pb = parseVersion(b);
  if (!pa || !pb) return 0;
  for (let i = 0; i < 3; i++) {
    const d = (pa.release[i] ?? 0) - (pb.release[i] ?? 0);
    if (d !== 0) return d < 0 ? -1 : 1;
  }
  if (pa.prerelease === pb.prerelease) return 0;
  if (pa.prerelease === null) return 1;
  if (pb.prerelease === null) return -1;
  return comparePrerelease(pa.prerelease, pb.prerelease);
}

export function isOutdated(current: string, latest: string): boolean {
  return compareVersions(current, latest) < 0;
}

/**
 * A global install is one whose package root sits under the npm global root.
 * A checkout with a `.git` dir is a dev tree (never npm-managed). Anything else
 * — npx cache, a project-local dependency — is `managed`: notify, don't touch.
 */
export function classifyInstall(packageRoot: string, globalRoot: string | null): InstallKind {
  const norm = (p: string) => p.replace(/\\/g, "/").replace(/\/+$/, "").toLowerCase();
  if (globalRoot && norm(packageRoot).startsWith(norm(globalRoot) + "/")) return "global";
  if (existsSync(join(packageRoot, ".git"))) return "dev";
  return "managed";
}

/** Bin *names* declared by a package.json `bin` field (string or map form). */
export function binNames(pkg: { name?: string; bin?: string | Record<string, string> }): string[] {
  if (!pkg.bin) return [];
  if (typeof pkg.bin === "string") return pkg.name ? [pkg.name] : [];
  return Object.keys(pkg.bin);
}

/**
 * Shim files to delete after an update: every bin the OLD version installed but
 * the NEW one no longer declares, in each of npm's shim spellings.
 */
export function staleShimFiles(binDir: string, previous: string[], current: string[], present: string[]): string[] {
  const keep = new Set(current);
  const dropped = previous.filter((n) => !keep.has(n));
  const wanted = new Set<string>();
  for (const name of dropped) {
    for (const suffix of ["", ".cmd", ".ps1", ".bat"]) wanted.add(name + suffix);
  }
  return present.filter((f) => wanted.has(f)).map((f) => join(binDir, f));
}

// ------------------------------------------------------------------- runtime

function packageRoot(): string {
  return dirname(dirname(fileURLToPath(import.meta.url)));
}

export function readPackageJson(root: string): { name?: string; version?: string; bin?: string | Record<string, string> } {
  try {
    return JSON.parse(readFileSync(join(root, "package.json"), "utf8")) as Record<string, never>;
  } catch {
    return {};
  }
}

export function currentVersion(): string {
  return readPackageJson(packageRoot()).version ?? "0.0.0";
}

const cacheFile = () => join(homedir(), ".llm-relay", "update-check.json");

export function readCache(now: number): string | null {
  try {
    const c = JSON.parse(readFileSync(cacheFile(), "utf8")) as UpdateCache;
    if (typeof c.checkedAt !== "number") return null;
    // Re-validate on READ, not only on fetch. This is a user-writable file on
    // the path to a subprocess argument, so a value that never cleared the
    // semver gate must not be able to replay out of it for the cache lifetime.
    if (!isValidVersion(c.latest)) return null;
    return now - c.checkedAt < CHECK_INTERVAL_MS ? c.latest : null;
  } catch {
    return null;
  }
}

function writeCache(latest: string, now: number): void {
  try {
    mkdirSync(dirname(cacheFile()), { recursive: true });
    writeFileSync(cacheFile(), JSON.stringify({ checkedAt: now, latest } satisfies UpdateCache), "utf8");
  } catch {
    /* cache is an optimization; never fatal */
  }
}

/** Latest published version, or null on any network/parse failure (fail-open). */
export async function fetchLatestVersion(): Promise<string | null> {
  try {
    // The `/latest` document is plain JSON; asking for npm's abbreviated
    // packument media type here is a 406.
    const res = await fetch(`${REGISTRY}/${PACKAGE_NAME}/latest`, {
      headers: { accept: "application/json" },
      signal: AbortSignal.timeout(CHECK_TIMEOUT_MS),
    });
    if (!res.ok) return null;
    const body = (await res.json()) as { version?: string };
    // Network-controlled input: reject anything that is not a full-string semver
    // at the boundary, so nothing downstream has to be careful about it.
    return isValidVersion(body.version) ? body.version : null;
  } catch {
    return null;
  }
}

/**
 * Windows resolves `npm` to a `.cmd` shim. An earlier revision launched it by
 * joining the argv into a single `cmd.exe /c` STRING and asserted here that
 * "every argument is ours, never user input" — which was false: the version
 * comes from an HTTPS registry response and from a user-writable cache, so
 * `cmd` metacharacters in it became live shell syntax.
 *
 * The interpreter must still be named explicitly (spawning a `.cmd` with
 * `shell: true` is deprecated, DEP0190), but arguments are now passed as a real
 * ARGV ARRAY, so nothing inside an argument can introduce a new command.
 * Callers must still only pass values that cleared `isValidVersion`.
 */
function npm(args: string[]): { ok: boolean; stdout: string; stderr: string } {
  const win = process.platform === "win32";
  const res = win
    ? spawnSync("cmd.exe", ["/d", "/s", "/c", "npm", ...args], {
        encoding: "utf8",
        windowsHide: true,
        shell: false,
      })
    : spawnSync("npm", args, { encoding: "utf8", shell: false });
  return {
    ok: res.status === 0,
    stdout: (res.stdout ?? "").trim(),
    stderr: (res.stderr ?? "").trim(),
  };
}

function globalRoot(): string | null {
  const r = npm(["root", "-g"]);
  return r.ok && r.stdout ? r.stdout : null;
}

function globalBinDir(): string | null {
  const r = npm(["prefix", "-g"]);
  if (!r.ok || !r.stdout) return null;
  return process.platform === "win32" ? r.stdout : join(r.stdout, "bin");
}

/** Delete shims left over from bins the new version no longer declares. */
export function pruneStaleShims(binDir: string | null, previous: string[], current: string[]): string[] {
  if (!binDir || !existsSync(binDir)) return [];
  let present: string[] = [];
  try {
    present = readdirSync(binDir);
  } catch {
    return [];
  }
  const removed: string[] = [];
  for (const file of staleShimFiles(binDir, previous, current, present)) {
    try {
      rmSync(file, { force: true });
      removed.push(file);
    } catch {
      /* a shim we cannot remove is reported by npm's own doctor, not fatal here */
    }
  }
  return removed;
}

const notify = (msg: string) => process.stderr.write(`llm-relay: ${msg}\n`);

/** True when this invocation should consult the registry at all. */
export function shouldCheckUpdates(argv: string[], env: NodeJS.ProcessEnv): boolean {
  if (env[SUPPRESS_ENV]) return false;
  const arg = argv[2];
  if (arg === "version" || arg === "help") return false;
  return !argv.slice(1).some((a) => /^--?(version|v|help|h)(=|$)/.test(a));
}

/**
 * Compare against the registry and, for a global install, replace it in place
 * and re-exec. Returns only when the process should continue on this version.
 */
export async function ensureUpToDate(now = Date.now()): Promise<void> {
  const root = packageRoot();
  const current = readPackageJson(root).version ?? "0.0.0";

  let latest = readCache(now);
  if (!latest) {
    latest = await fetchLatestVersion();
    if (latest) writeCache(latest, now);
  }
  if (!latest || !isOutdated(current, latest)) return;

  const kind = classifyInstall(root, globalRoot());
  if (kind !== "global") {
    notify(
      `update available — ${current} → ${latest} (this copy is ${kind === "dev" ? "a source checkout" : "not globally installed"}; ` +
        `run "npm install -g ${PACKAGE_NAME}@latest" to update the global CLI)`,
    );
    return;
  }

  notify(`update available — ${current} → ${latest}; updating this global install…`);
  const previousBins = binNames(readPackageJson(root));
  let install = npm(["install", "-g", `${PACKAGE_NAME}@${latest}`]);
  if (!install.ok && /EEXIST/i.test(install.stderr)) {
    // A shim npm does not consider its own (left by a link, a rename, or a
    // half-finished install) blocks the overwrite. Clear the install out and
    // lay it down fresh rather than leaving the user pinned to an old build.
    notify("existing bin shims block the overwrite; reinstalling clean");
    npm(["uninstall", "-g", PACKAGE_NAME]);
    pruneStaleShims(globalBinDir(), previousBins, []);
    install = npm(["install", "-g", `${PACKAGE_NAME}@${latest}`]);
  }
  if (!install.ok) {
    notify(`self-update failed (${install.stderr.split("\n")[0] ?? "npm error"}); continuing on ${current}`);
    return;
  }

  const newRoot = join(globalRoot() ?? dirname(root), PACKAGE_NAME);
  const installed = readPackageJson(newRoot);
  if (installed.version !== latest) {
    notify(`self-update did not take effect (still ${installed.version ?? "unknown"}); continuing on ${current}`);
    return;
  }

  const removed = pruneStaleShims(globalBinDir(), previousBins, binNames(installed));
  if (removed.length > 0) notify(`removed ${removed.length} stale shim(s): ${removed.join(", ")}`);

  const entry = join(newRoot, "dist", "cli.js");
  if (!existsSync(entry)) {
    notify(`updated to ${latest}, but ${entry} is missing; continuing on ${current}`);
    return;
  }

  notify(`updated to ${latest}; restarting`);
  const child = spawnSync(process.execPath, [entry, ...process.argv.slice(2)], {
    stdio: "inherit",
    env: { ...process.env, [SUPPRESS_ENV]: "1" },
    windowsHide: true,
  });
  process.exit(child.status ?? 0);
}
