import { describe, it, expect, afterAll, beforeEach } from "vitest";
import { mkdtempSync, rmSync, readFileSync, writeFileSync, mkdirSync, existsSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  claudeHookPaths,
  installAgentHook,
  removeAgentHook,
  agentHookInstalled,
  renderAgentHookScript,
  AGENT_HOOK_FILENAME,
} from "../src/claude-hook.js";

const home = mkdtempSync(join(tmpdir(), "rp-hook-"));
afterAll(() => rmSync(home, { recursive: true, force: true }));

const paths = claudeHookPaths(home);
const read = (): Record<string, unknown> => JSON.parse(readFileSync(paths.settings, "utf8"));

/** A settings file shaped like the real one: the user's own Agent hook, plus unrelated keys. */
const USER_SETTINGS = {
  env: { ENABLE_TOOL_SEARCH: "true" },
  permissions: { defaultMode: "bypassPermissions" },
  hooks: {
    PreToolUse: [
      { matcher: "^Agent$", hooks: [{ type: "command", command: "node /home/me/require-subagent-model.mjs" }] },
    ],
    Stop: [{ hooks: [{ type: "command", command: "notify" }] }],
  },
  effortLevel: "medium",
};

function seed(settings: unknown): void {
  mkdirSync(join(home, ".claude"), { recursive: true });
  writeFileSync(paths.settings, JSON.stringify(settings, null, 2));
}

beforeEach(() => rmSync(join(home, ".claude"), { recursive: true, force: true }));

describe("installing the Agent hook", () => {
  it("appends alongside the user's own ^Agent$ hook rather than replacing it", () => {
    // The real machine runs a hook enforcing an explicit subagent model. Claude Code runs every
    // matching entry, so coexistence is correct — and clobbering it would delete a user policy to
    // install a convenience.
    seed(USER_SETTINGS);
    installAgentHook("node", "/opt/llm-relay/cli.js", paths);

    const entries = (read().hooks as { PreToolUse: Array<{ hooks: Array<{ command: string }> }> }).PreToolUse;
    expect(entries).toHaveLength(2);
    expect(entries[0]!.hooks[0]!.command).toContain("require-subagent-model.mjs");
    expect(entries[1]!.hooks[0]!.command).toContain(AGENT_HOOK_FILENAME);
  });

  it("preserves every unrelated settings key and hook event", () => {
    seed(USER_SETTINGS);
    installAgentHook("node", "/opt/llm-relay/cli.js", paths);

    const after = read();
    expect(after.env).toEqual({ ENABLE_TOOL_SEARCH: "true" });
    expect(after.permissions).toEqual({ defaultMode: "bypassPermissions" });
    expect(after.effortLevel).toBe("medium");
    expect((after.hooks as Record<string, unknown>).Stop).toEqual(USER_SETTINGS.hooks.Stop);
  });

  it("creates the settings file when none exists", () => {
    installAgentHook("node", "/opt/llm-relay/cli.js", paths);
    expect(agentHookInstalled(paths)).toBe(true);
  });

  it("is idempotent — installing twice wires it once", () => {
    seed(USER_SETTINGS);
    expect(installAgentHook("node", "/opt/llm-relay/cli.js", paths).changed).toBe(true);
    expect(installAgentHook("node", "/opt/llm-relay/cli.js", paths).changed).toBe(false);
    const entries = (read().hooks as { PreToolUse: unknown[] }).PreToolUse;
    expect(entries).toHaveLength(2);
  });

  it("writes the hook script under the relay's own directory, not the harness's", () => {
    installAgentHook("node", "/opt/llm-relay/cli.js", paths);
    expect(existsSync(paths.script)).toBe(true);
    expect(paths.script).toContain(".llm-relay");
    expect(paths.settings).toContain(".claude");
  });

  it("refuses to touch an unparseable settings file instead of replacing it", () => {
    // This file holds the operator's permissions, env and hooks. Overwriting a broken one would
    // destroy all of it to install a convenience.
    mkdirSync(join(home, ".claude"), { recursive: true });
    writeFileSync(paths.settings, "{ this is not json");
    expect(() => installAgentHook("node", "/opt/llm-relay/cli.js", paths)).toThrow(/not valid JSON/);
    expect(readFileSync(paths.settings, "utf8")).toBe("{ this is not json");
  });
});

describe("removing the Agent hook", () => {
  it("removes only our entry and leaves the user's intact", () => {
    seed(USER_SETTINGS);
    installAgentHook("node", "/opt/llm-relay/cli.js", paths);
    expect(removeAgentHook(paths).changed).toBe(true);

    const entries = (read().hooks as { PreToolUse: Array<{ hooks: Array<{ command: string }> }> }).PreToolUse;
    expect(entries).toHaveLength(1);
    expect(entries[0]!.hooks[0]!.command).toContain("require-subagent-model.mjs");
    expect(agentHookInstalled(paths)).toBe(false);
  });

  it("restores a settings file that had no hooks at all to exactly that", () => {
    seed({ env: { A: "1" } });
    installAgentHook("node", "/opt/llm-relay/cli.js", paths);
    removeAgentHook(paths);
    expect(read()).toEqual({ env: { A: "1" } });
  });

  it("is a no-op when the hook was never installed", () => {
    seed(USER_SETTINGS);
    expect(removeAgentHook(paths).changed).toBe(false);
    expect(read()).toEqual(USER_SETTINGS);
  });

  it("leaves the generated script on disk — it is inert without the wiring", () => {
    installAgentHook("node", "/opt/llm-relay/cli.js", paths);
    removeAgentHook(paths);
    expect(existsSync(paths.script)).toBe(true);
  });
});

describe("the generated hook script", () => {
  const NODE = "C:\\Program Files\\nodejs\\node.exe";
  const CLI = "C:\\tools\\llm-relay\\dist\\cli.js";
  const script = renderAgentHookScript(NODE, CLI);

  it("is syntactically valid JavaScript", () => {
    const p = join(home, "generated-check.mjs");
    writeFileSync(p, script);
    expect(() => execFileSync(process.execPath, ["--check", p], { stdio: "pipe" })).not.toThrow();
  });

  it("embeds both paths as JSON literals, so a Windows path cannot break out", () => {
    expect(script).toContain(JSON.stringify(NODE));
    expect(script).toContain(JSON.stringify(CLI));
    expect(script).not.toContain(`${NODE}"`);
  });

  it("spawns the interpreter with the CLI script, never a launcher shim", () => {
    // execFileSync cannot run a `.cmd`/`.bat` without a shell (blocked since CVE-2024-27980), and
    // an npm global install's `llm-relay` on Windows IS a `.cmd`. A bare `.js` path is not
    // executable either. Both fail into the fail-open catch, so the hook would look installed and
    // silently allow every call — the exact shape of "the feature does nothing".
    expect(script).toMatch(new RegExp(`execFileSync\\(${JSON.stringify(NODE).replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}`));
    expect(script).not.toMatch(/execFileSync\([^,]*\.(cmd|bat)"/i);
    expect(script).not.toMatch(/shell:\s*true/);
  });

  it("passes the task as one argv element, never through a shell", () => {
    expect(script).toContain(`"-t", task`);
  });

  it("fails OPEN — every error path allows the call", () => {
    // A hook that denied subagents because the proxy was down would turn one unavailable optional
    // lane into "no subagent works at all".
    expect(script).toMatch(/catch \(e\) \{\s*allow\(\);/);
    expect(script).toContain(`permissionDecision: "allow"`);
  });

  it("stands down when the session's traffic already reaches the relay", () => {
    expect(script).toContain("ANTHROPIC_BASE_URL");
    expect(script).toMatch(/if \(routed\) allow\(\);/);
  });

  it("denies with a runnable command, not with an @relay directive", () => {
    // The directive is inert on a bypassed host — it reaches the model as literal prompt text.
    expect(script).toContain(`permissionDecision: "deny"`);
    expect(script).toContain("--next-command");
    expect(script).not.toMatch(/permissionDecisionReason:[^;]*@relay:/);
  });
});
