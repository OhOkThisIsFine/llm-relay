import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { spawnSync } from "node:child_process";
import { chmodSync, mkdtempSync, rmSync, existsSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
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
 *   - Claude and Codex must receive byte-for-byte identical descriptions from the shipped source;
 *     global installs also provision Codex's provider and MCP dispatch server, while retiring
 *     only the exact legacy child-agent files llm-relay itself generated.
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
  // ⚠ The OpenCode target honours XDG_CONFIG_HOME, so a developer who has it set would otherwise
  // have the suite write outside the temp HOME — the same non-hermeticity these tests redirect
  // HOME/USERPROFILE to avoid. Clear it here; the one test that exercises XDG sets it explicitly.
  delete env.XDG_CONFIG_HOME;
  // ⚠ PATH is blanked because Codex provisioning is now DETECTED, not unconditional, and the
  // detector walks PATH. Inheriting the real one makes the suite pass on a developer machine that
  // has Codex and fail in CI that does not — the same non-hermeticity as HOME. A test that WANTS
  // Codex detected calls `codexOnPath()`, which puts a real fixture binary on a controlled PATH;
  // creating `~/.codex/config.toml` does NOT work and must not be used, because that file is
  // llm-relay's own footprint rather than evidence of Codex.
  // The child is spawned via process.execPath, so it needs no PATH to start.
  env.PATH = "";
  const res = spawnSync(process.execPath, [script, ...args], {
    cwd: repoRoot,
    encoding: "utf8",
    env: { ...env, HOME: home, USERPROFILE: home, ...extraEnv },
  });
  return { status: res.status, stderr: res.stderr ?? "", stdout: res.stdout ?? "" };
}

/**
 * Make Codex genuinely DETECTABLE, by putting a real `codex` executable on a controlled PATH.
 *
 * ⚠ This is how a Codex-provisioning test must set itself up since v0.62.0. The gate reads
 * `onPath` — a binary — because llm-relay wrote `~/.codex/config.toml` unconditionally before that
 * version, so a config file proves only that llm-relay ran, never that Codex is present. Creating
 * the config file would therefore NOT satisfy the gate, and a test that did so would be asserting
 * the footprint bug rather than the fix.
 *
 * On Windows a bare name resolves only through PATHEXT, so the fixture carries `.cmd` — which is
 * exactly the npm global-install shim shape the lookup was written to find.
 */
function codexOnPath(): { dir: string; env: Record<string, string> } {
  const dir = mkdtempSync(join(tmpdir(), "llm-relay-codexbin-"));
  const isWindows = process.platform === "win32";
  const file = join(dir, isWindows ? "codex.cmd" : "codex");
  writeFileSync(file, isWindows ? "@echo off\r\n" : "#!/bin/sh\nexit 0\n");
  if (!isWindows) chmodSync(file, 0o755);
  return { dir, env: { PATH: dir, PATHEXT: ".COM;.EXE;.BAT;.CMD" } };
}

const installedPaths = (home: string) => ({
  claude: join(home, ".claude", "skills", "llm-relay", "SKILL.md"),
  codex: join(home, ".codex", "skills", "llm-relay", "SKILL.md"),
  opencode: join(home, ".config", "opencode", "skills", "llm-relay", "SKILL.md"),
  codexConfig: join(home, ".codex", "config.toml"),
  defaultAgent: join(home, ".codex", "agents", "default.toml"),
  codingAgent: join(home, ".codex", "agents", "relay_coding.toml"),
});

const legacyDefaultAgent = `name = "default"\ndescription = "General-purpose read-only child routed through llm-relay."\ndeveloper_instructions = "Work read-only. Return a concise result to the parent and do not modify files."\n\nmodel_provider = "llm-relay"\nmodel = "pool/medium"\nmodel_reasoning_effort = "medium"\n`;
const legacyCodingAgent = `name = "relay_coding"\ndescription = "Read-only medium-effort child routed through llm-relay to the configured non-OpenAI pool."\ndeveloper_instructions = "Work read-only. Return a concise result to the parent and do not modify files."\n\nmodel_provider = "llm-relay"\nmodel = "pool/medium"\nmodel_reasoning_effort = "medium"\n`;

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
    expect(existsSync(join(home, ".config"))).toBe(false);
    // The designed no-op stays quiet; only failures are allowed to print.
    expect(r.stderr).toBe("");
  });

  it("installs the same shipped skill for Claude Code, Codex and OpenCode on a global install", () => {
    const r = run([], home, { npm_config_global: "true" });
    const paths = installedPaths(home);
    const source = readFileSync(skillSrc, "utf8");
    expect(r.status).toBe(0);
    expect(readFileSync(paths.claude, "utf8")).toBe(source);
    expect(readFileSync(paths.codex, "utf8")).toBe(source);
    expect(readFileSync(paths.opencode, "utf8")).toBe(source);
    expect(readFileSync(paths.claude, "utf8")).toBe(readFileSync(paths.codex, "utf8"));
    expect(readFileSync(paths.claude, "utf8")).toBe(readFileSync(paths.opencode, "utf8"));
    expect(r.stderr).toContain("installed Claude Code skill");
    expect(r.stderr).toContain("installed Codex skill");
    expect(r.stderr).toContain("installed OpenCode skill");
  });

  /**
   * ⚠ Codex PROVISIONING (the provider and MCP blocks) is gated on Codex actually
   * being present, since 2026-08-30. It used to run on every global install, so a machine with no
   * Codex got `~/.codex/config.toml` and two agent files written for a tool it did not have.
   *
   * ⚠ The SKILL COPY is deliberately NOT gated — see the last test in this block. Copying a
   * markdown file into a directory is cheap and self-correcting; writing a provider block that
   * changes how another tool routes its traffic is not.
   */
  describe("Codex provisioning is gated on Codex being detected", () => {
    /**
     * ⚠ PRECONDITION, stated as its own assertion on purpose. The gate imports the detector from
     * `dist/`, so these tests need a BUILT tree — a dependency the rest of the suite does not have
     * (`CLAUDE.md`: "vitest reads `src/` directly; scripts read `dist/`"). Without this check a
     * missing `dist/` surfaces as three unrelated-looking failures about Codex provisioning, and
     * the reader has to work backwards to the real cause. Here it fails once, saying what to run.
     */
    it("PRECONDITION: dist/ is built, because the gate imports the detector from it", () => {
      const detector = join(repoRoot, "dist", "installed-hosts.js");
      expect(
        existsSync(detector),
        `${detector} is missing — run \`npm run build\` first. These gate tests exercise ` +
          "scripts/install-skill.mjs, which imports the detector from dist/, not from src/.",
      ).toBe(true);
    });

    it("skips the provider block, and says why, when no Codex is present", () => {
      const r = run([], home, { npm_config_global: "true" });
      const paths = installedPaths(home);
      expect(r.status).toBe(0);
      expect(existsSync(paths.codexConfig)).toBe(false);
      expect(existsSync(paths.defaultAgent)).toBe(false);
      expect(existsSync(paths.codingAgent)).toBe(false);
      expect(r.stderr).toContain("Codex not detected");
      // Never silent, and it must say how to get it later — a detection miss is recoverable.
      expect(r.stderr).toContain("--force");
    });

    /**
     * ⚠ Detection is by BINARY, not by config file. An earlier draft of this test created
     * `~/.codex/config.toml` to make Codex "detected" — but llm-relay wrote that file
     * unconditionally before v0.62.0, so it proves llm-relay ran, not that Codex exists. A test
     * built on it would have pinned the footprint bug instead of the fix.
     */
    it("provisions when the codex binary is on PATH", () => {
      const codex = codexOnPath();
      mkdirSync(join(home, ".codex"), { recursive: true });
      writeFileSync(installedPaths(home).codexConfig, "# pre-existing codex config\n");
      const r = run([], home, { npm_config_global: "true", ...codex.env });
      const paths = installedPaths(home);
      rmSync(codex.dir, { recursive: true, force: true });
      expect(r.status).toBe(0);
      expect(readFileSync(paths.codexConfig, "utf8")).toContain("[model_providers.llm-relay]");
      expect(readFileSync(paths.codexConfig, "utf8")).toContain('base_url = "http://127.0.0.1:8791/v1"');
      expect(readFileSync(paths.codexConfig, "utf8")).toContain("[mcp_servers.llm-relay]");
      expect(readFileSync(paths.codexConfig, "utf8")).toContain('args = ["mcp"]');
      expect(existsSync(paths.defaultAgent)).toBe(false);
      expect(existsSync(paths.codingAgent)).toBe(false);
      expect(r.stderr).toContain("Codex provider configured");
      expect(r.stderr).toContain("Codex MCP server configured");
      // The operator's own bytes survive — the gate must not turn provisioning into a rewrite.
      expect(readFileSync(paths.codexConfig, "utf8")).toContain("# pre-existing codex config");
    });

    it("still copies the SKILL to every host even when Codex is not detected", () => {
      const r = run([], home, { npm_config_global: "true" });
      const paths = installedPaths(home);
      const source = readFileSync(skillSrc, "utf8");
      expect(readFileSync(paths.codex, "utf8")).toBe(source);
      expect(readFileSync(paths.claude, "utf8")).toBe(source);
      expect(readFileSync(paths.opencode, "utf8")).toBe(source);
      expect(r.stderr).toContain("Codex not detected");
    });
  });

  /**
   * ⚠ `--force` overrides the INSTALL CONTEXT (global vs local), and nothing else. It is not a
   * blanket "do everything" switch: Codex provisioning is gated on Codex being detected, and that
   * gate is about whether the operator HAS Codex, which forcing an install context cannot answer.
   * This test asserted unconditional Codex provisioning until 2026-08-30 — it was pinning the
   * behaviour the detection gate exists to remove, so it changed with the source.
   *
   * The escape the stderr message advertises still works: install Codex, re-run with `--force`,
   * and the detector now finds it. That path is covered by the detection describe-block below.
   */
  it("--force installs the skills regardless of install context", () => {
    const r = run(["--force"], home);
    const paths = installedPaths(home);
    expect(r.status).toBe(0);
    expect(existsSync(paths.claude)).toBe(true);
    expect(existsSync(paths.codex)).toBe(true);
    expect(existsSync(paths.opencode)).toBe(true);
    // ...but forcing the context does not conjure a Codex install.
    expect(existsSync(paths.codexConfig)).toBe(false);
    expect(r.stderr).toContain("Codex not detected");
  });

  it("preserves user-authored Codex agent files and stays idempotent", () => {
    const codex = codexOnPath();
    const paths = installedPaths(home);
    mkdirSync(join(home, ".codex", "agents"), { recursive: true });
    const existingConfig = "model = \"gpt-5\"\n\n[model_providers.openai]\nname = \"openai\"\n";
    const existingDefault = "name = \"default\"\ndescription = \"user choice\"\n";
    const existingCoding = "name = \"relay_coding\"\ndescription = \"user choice too\"\n";
    writeFileSync(paths.codexConfig, existingConfig);
    writeFileSync(paths.defaultAgent, existingDefault);
    writeFileSync(paths.codingAgent, existingCoding);

    const first = run([], home, { npm_config_global: "true", ...codex.env });
    const afterFirstConfig = readFileSync(paths.codexConfig, "utf8");
    const afterFirstDefault = readFileSync(paths.defaultAgent, "utf8");
    const second = run([], home, { npm_config_global: "true", ...codex.env });
    const afterSecondConfig = readFileSync(paths.codexConfig, "utf8");

    expect(first.status).toBe(0);
    expect(second.status).toBe(0);
    expect(afterFirstConfig).toContain(existingConfig);
    expect(afterFirstConfig.match(/\[model_providers\.llm-relay\]/g)).toHaveLength(1);
    expect(afterSecondConfig).toBe(afterFirstConfig);
    expect(afterFirstDefault).toBe(existingDefault);
    expect(readFileSync(paths.codingAgent, "utf8")).toBe(existingCoding);
    expect(afterFirstConfig).toContain("[mcp_servers.llm-relay]");
    expect(second.stderr).toContain("Codex provider already configured");
    expect(second.stderr).toContain("Codex MCP server already configured");
    expect(second.stderr).toContain("Codex agent preserved");
  });

  it("retires only the exact legacy Codex child agents generated by llm-relay", () => {
    const codex = codexOnPath();
    const paths = installedPaths(home);
    mkdirSync(join(home, ".codex", "agents"), { recursive: true });
    writeFileSync(paths.defaultAgent, legacyDefaultAgent);
    writeFileSync(paths.codingAgent, legacyCodingAgent);

    const r = run([], home, { npm_config_global: "true", ...codex.env });
    rmSync(codex.dir, { recursive: true, force: true });

    expect(r.status).toBe(0);
    expect(existsSync(paths.defaultAgent)).toBe(false);
    expect(existsSync(paths.codingAgent)).toBe(false);
    expect(r.stderr.match(/Codex agent retired/g)).toHaveLength(2);
  });

  it.each([
    ["inner whitespace", '[ model_providers.llm-relay ]\nname = "llm-relay"\n'],
    ["quoted key", '[model_providers."llm-relay"]\nname = "llm-relay"\n'],
    ["quoted key with whitespace", '[ model_providers."llm-relay" ]\nname = "llm-relay"\n'],
    ["leading indent", '  [model_providers.llm-relay]\nname = "llm-relay"\n'],
  ])("recognizes an already-configured Codex provider written with %s", (_label, existing) => {
    // TOML treats all of these as the SAME table. Matching only the exact literal spelling makes
    // postinstall append a SECOND provider block to the user's config.toml on every install —
    // a duplicate table in a file this tool edits in the user's home directory.
    const codex = codexOnPath();
    const paths = installedPaths(home);
    mkdirSync(join(home, ".codex", "agents"), { recursive: true });
    writeFileSync(paths.codexConfig, existing);

    const r = run([], home, { npm_config_global: "true", ...codex.env });
    const after = readFileSync(paths.codexConfig, "utf8");

    expect(r.status).toBe(0);
    // The existing provider bytes survive, while the independent MCP entry is appended.
    expect(after.startsWith(existing)).toBe(true);
    expect(after.match(/model_providers/g)).toHaveLength(1);
    expect(after).toContain("[mcp_servers.llm-relay]");
    expect(r.stderr).toContain("Codex provider already configured");
  });

  it.each([
    ["inner whitespace", '[ mcp_servers.llm-relay ]\ncommand = "llm-relay"\n'],
    ["quoted key", '[mcp_servers."llm-relay"]\ncommand = "llm-relay"\n'],
  ])("recognizes an already-configured Codex MCP server written with %s", (_label, existing) => {
    const codex = codexOnPath();
    const paths = installedPaths(home);
    mkdirSync(join(home, ".codex"), { recursive: true });
    writeFileSync(paths.codexConfig, existing);

    const r = run([], home, { npm_config_global: "true", ...codex.env });
    const after = readFileSync(paths.codexConfig, "utf8");
    rmSync(codex.dir, { recursive: true, force: true });

    expect(r.status).toBe(0);
    expect(after.match(/mcp_servers/g)).toHaveLength(1);
    expect(r.stderr).toContain("Codex MCP server already configured");
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
    // The third host is independent too — a broken ~/.claude must not cost OpenCode its copy.
    expect(readFileSync(paths.opencode, "utf8")).toBe(readFileSync(skillSrc, "utf8"));
    expect(r.stderr).toContain("installed OpenCode skill");
  });

  /**
   * OpenCode is the only target that is not a fixed dotfolder in HOME: it lives under the XDG
   * config dir. Added 2026-08-30 — before that the installer wrote two hosts, so an OpenCode copy
   * put there by any other means went stale with nothing on the machine to refresh it (measured
   * 1875 bytes behind). These pin the path policy, since getting it wrong writes a real file to
   * the wrong place rather than failing loudly.
   */
  describe("the OpenCode target's XDG path policy", () => {
    it("honours XDG_CONFIG_HOME when it is set", () => {
      const xdg = mkdtempSync(join(tmpdir(), "llm-relay-xdg-"));
      try {
        const r = run(["--force"], home, { XDG_CONFIG_HOME: xdg });
        const dest = join(xdg, "opencode", "skills", "llm-relay", "SKILL.md");
        expect(r.status).toBe(0);
        expect(readFileSync(dest, "utf8")).toBe(readFileSync(skillSrc, "utf8"));
        // ...and does NOT also write the ~/.config fallback, which would leave two copies to drift.
        expect(existsSync(installedPaths(home).opencode)).toBe(false);
      } finally {
        rmSync(xdg, { recursive: true, force: true });
      }
    });

    it("falls back to ~/.config when XDG_CONFIG_HOME is blank rather than writing to a bare path", () => {
      // A blank value is set-but-meaningless. Treating it as a directory would resolve the skill
      // to a relative path outside HOME — the same rule `state-paths.ts` applies to its own dirs.
      const r = run(["--force"], home, { XDG_CONFIG_HOME: "   " });
      expect(r.status).toBe(0);
      expect(readFileSync(installedPaths(home).opencode, "utf8")).toBe(readFileSync(skillSrc, "utf8"));
    });
  });
});
