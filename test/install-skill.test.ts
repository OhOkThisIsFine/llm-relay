import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * `scripts/install-skill.mjs` is the npm `postinstall` hook, so its contract is not "does it copy
 * a file" but "can it ever hurt the install". Two halves, both pinned here:
 *   - it must NEVER exit non-zero, whatever goes wrong (that guarantee used to live in
 *     package.json as `|| exit 0`, which also swallowed the reason);
 *   - it must never be silent about a failure, and must never touch ~/.claude or ~/.codex on a
 *     local install;
 *   - Claude and Codex must receive byte-for-byte identical descriptions from the shipped source.
 *
 * HOME and USERPROFILE are both redirected at a temp dir so the real developer machine is never
 * written to — `os.homedir()` reads USERPROFILE on Windows and HOME elsewhere.
 */
const repoRoot = fileURLToPath(new URL("..", import.meta.url));
const script = join(repoRoot, "scripts", "install-skill.mjs");
const skillSrc = join(repoRoot, "skills", "llm-relay", "SKILL.md");

function run(args: string[], home: string, extraEnv: Record<string, string> = {}) {
  const env: Record<string, string> = { ...(process.env as Record<string, string>) };
  delete env.npm_config_global;
  const res = spawnSync(process.execPath, [script, ...args], {
    cwd: repoRoot,
    encoding: "utf8",
    env: { ...env, HOME: home, USERPROFILE: home, ...extraEnv },
  });
  return { status: res.status, stderr: res.stderr ?? "", stdout: res.stdout ?? "" };
}

const installedPaths = (home: string) => ({
  claude: join(home, ".claude", "skills", "llm-relay", "SKILL.md"),
  codex: join(home, ".codex", "skills", "llm-relay", "SKILL.md"),
});

describe("install-skill postinstall hook", () => {
  let home: string;

  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), "llm-relay-skill-"));
  });
  afterEach(() => {
    rmSync(home, { recursive: true, force: true });
  });

  it("does nothing on a local install — never touches host skill directories", () => {
    const r = run([], home);
    expect(r.status).toBe(0);
    expect(existsSync(join(home, ".claude"))).toBe(false);
    expect(existsSync(join(home, ".codex"))).toBe(false);
    // The designed no-op stays quiet; only failures are allowed to print.
    expect(r.stderr).toBe("");
  });

  it("installs the same shipped skill for Claude Code and Codex on a global install", () => {
    const r = run([], home, { npm_config_global: "true" });
    const paths = installedPaths(home);
    const source = readFileSync(skillSrc, "utf8");
    expect(r.status).toBe(0);
    expect(readFileSync(paths.claude, "utf8")).toBe(source);
    expect(readFileSync(paths.codex, "utf8")).toBe(source);
    expect(readFileSync(paths.claude, "utf8")).toBe(readFileSync(paths.codex, "utf8"));
    expect(r.stderr).toContain("installed Claude Code skill");
    expect(r.stderr).toContain("installed Codex skill");
  });

  it("--force installs regardless of install context", () => {
    const r = run(["--force"], home);
    const paths = installedPaths(home);
    expect(r.status).toBe(0);
    expect(existsSync(paths.claude)).toBe(true);
    expect(existsSync(paths.codex)).toBe(true);
  });

  it("exits 0 AND explains itself when the copy cannot happen", () => {
    // A home path that is a FILE makes mkdir of ~/.claude/... fail (ENOTDIR) on every platform.
    const notADir = join(home, "home-is-a-file");
    writeFileSync(notADir, "");
    const r = run(["--force"], notADir);
    // The whole point: an install must not fail because of the skill...
    expect(r.status).toBe(0);
    // ...but it must not be silent about it either.
    expect(r.stderr).toContain("Claude Code skill not installed");
    expect(r.stderr).toContain("Codex skill not installed");
  });

  it("installs one host's skill when the other host directory is broken", () => {
    writeFileSync(join(home, ".claude"), "");
    const r = run(["--force"], home);
    const paths = installedPaths(home);

    expect(r.status).toBe(0);
    expect(r.stderr).toContain("Claude Code skill not installed");
    expect(readFileSync(paths.codex, "utf8")).toBe(readFileSync(skillSrc, "utf8"));
    expect(r.stderr).toContain("installed Codex skill");
  });
});
