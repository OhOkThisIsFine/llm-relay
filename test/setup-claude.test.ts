import { describe, it, expect, afterAll } from "vitest";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { getClaudeDesktopConfigPath, setupClaudeDesktop, setupClaudeCli, installRelayAgent, RELAY_AGENT_MARKER } from "../src/setup-claude.js";
import { dirname } from "node:path";
import { homedir } from "node:os";

const dir = mkdtempSync(join(tmpdir(), "rp-setup-"));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

/**
 * The developer's REAL Claude Desktop config, as it stood before this file ran.
 *
 * This suite used to call `setupClaudeDesktop()` with no arguments, and `SetupOptions` had no
 * way to redirect the write — `configDir` only ever changed the CLAUDE_CONFIG_DIR *value*
 * written into the file. So `npm test` reformatted a live application's settings file on
 * whatever machine it ran on. `targetPath` is the seam that fixes it; this is the guard that
 * keeps it fixed, because the failure is invisible from inside a passing test.
 */
const realPath = getClaudeDesktopConfigPath();
const realBefore = existsSync(realPath) ? statSync(realPath).mtimeMs : null;

const realAgentPath = join(homedir(), ".claude", "agents", "relay.md");
const realAgentBefore = existsSync(realAgentPath) ? statSync(realAgentPath).mtimeMs : null;

afterAll(() => {
  const realAfter = existsSync(realPath) ? statSync(realPath).mtimeMs : null;
  expect(realAfter).toBe(realBefore);

  const realAgentAfter = existsSync(realAgentPath) ? statSync(realAgentPath).mtimeMs : null;
  expect(realAgentAfter).toBe(realAgentBefore);
  expect(existsSync(realAgentPath)).toBe(false);
});

describe("setup-claude", () => {
  it("getClaudeDesktopConfigPath returns platform path", () => {
    const p = getClaudeDesktopConfigPath();
    expect(p).toContain("Claude");
    expect(p.endsWith("claude_desktop_config.json")).toBe(true);
  });

  it("setupClaudeCli returns its lines and writes them through the injected sink", () => {
    const seen: string[] = [];
    const res = setupClaudeCli({ out: (l) => seen.push(l), homeDir: dir });
    expect(res.success).toBe(true);
    expect(res.message).toBeDefined();
    // The sink got exactly what the caller was handed back — nothing went to stdout behind it.
    expect(seen).toEqual(res.lines);
    expect(res.lines.join("\n")).toContain("claude-proxied.ps1");
  });

  it("setupClaudeDesktop registers MCP dispatch at the injected targetPath, not the real config", () => {
    const target = join(dir, "claude_desktop_config.json");
    const res = setupClaudeDesktop({ targetPath: target, proxyUrl: "http://127.0.0.1:9999", homeDir: dir });

    expect(res.success).toBe(true);
    expect(res.path).toBe(target);
    expect(res.path).not.toBe(realPath);

    const written = JSON.parse(readFileSync(target, "utf8")) as {
      mcpServers: Record<string, { command: string; args: string[] }>;
      env?: Record<string, string>;
    };
    expect(written.mcpServers["llm-relay"]).toEqual({ command: "llm-relay", args: ["mcp"] });
    expect(written.env).toBeUndefined();
  });

  it("patches an existing config in place instead of replacing it", () => {
    const target = join(dir, "existing.json");
    writeFileSync(target, JSON.stringify({ mcpServers: { keepme: {} }, env: { KEEP: "yes" } }, null, 2));

    const res = setupClaudeDesktop({ targetPath: target, homeDir: dir });
    expect(res.success).toBe(true);

    const written = JSON.parse(readFileSync(target, "utf8")) as {
      mcpServers: Record<string, unknown>;
      env: Record<string, string>;
    };
    // Unrelated settings survive, and so does an unrelated env var — this function edits a
    // file that belongs to another application, so anything it does not own must be left alone.
    expect(written.mcpServers.keepme).toBeDefined();
    expect(written.mcpServers["llm-relay"]).toEqual({ command: "llm-relay", args: ["mcp"] });
    expect(written.env.KEEP).toBe("yes");
  });

  it("removes only the exact stale environment written by the legacy Desktop setup", () => {
    const target = join(dir, "legacy.json");
    const legacyConfigDir = join(dir, "legacy-claude-config");
    writeFileSync(
      target,
      JSON.stringify({
        env: {
          KEEP: "yes",
          ANTHROPIC_BASE_URL: "http://127.0.0.1:9999",
          ANTHROPIC_AUTH_TOKEN: "dummy",
          CLAUDE_CONFIG_DIR: legacyConfigDir,
          CLAUDE_CODE_DISABLE_ADAPTIVE_THINKING: "1",
          CLAUDE_CODE_DISABLE_EXPERIMENTAL_BETAS: "1",
          CLAUDE_CODE_ATTRIBUTION_HEADER: "0",
        },
      }),
    );

    const res = setupClaudeDesktop({
      targetPath: target,
      proxyUrl: "http://127.0.0.1:9999",
      configDir: legacyConfigDir,
      homeDir: dir,
    });
    expect(res.success).toBe(true);

    const written = JSON.parse(readFileSync(target, "utf8")) as {
      mcpServers: Record<string, unknown>;
      env: Record<string, string>;
    };
    expect(written.mcpServers["llm-relay"]).toBeDefined();
    expect(written.env).toEqual({ KEEP: "yes" });
  });

  it("reports failure instead of throwing when the target cannot be written", () => {
    // Parent path is an existing FILE, so creating the directory fails. The caller gets a
    // result, not an exception — `llm-relay setup` prints `res.message` and must not stack-trace.
    const blocker = join(dir, "not-a-directory");
    writeFileSync(blocker, "x");
    const res = setupClaudeDesktop({ targetPath: join(blocker, "claude_desktop_config.json"), homeDir: dir });
    expect(res.success).toBe(false);
    expect(res.message).toContain("Failed to configure Claude Desktop");
  });

  it("(a) installs the agent file under an injected home", () => {
    const injectedHome = join(dir, "injected-home-a");
    const res = installRelayAgent({ homeDir: injectedHome });
    expect(res.success).toBe(true);
    const agentPath = join(injectedHome, ".claude", "agents", "relay.md");
    expect(res.path).toBe(agentPath);
    expect(existsSync(agentPath)).toBe(true);
  });

  it("(b) the content contains name: relay, the three tool names and the marker", () => {
    const injectedHome = join(dir, "injected-home-b");
    installRelayAgent({ homeDir: injectedHome });
    const agentPath = join(injectedHome, ".claude", "agents", "relay.md");
    const content = readFileSync(agentPath, "utf8");
    expect(content).toContain("name: relay");
    expect(content).toContain("mcp__llm-relay__dispatch");
    expect(content).toContain("mcp__llm-relay__dispatch_status");
    expect(content).toContain("mcp__llm-relay__dispatch_result");
    expect(content).toContain(RELAY_AGENT_MARKER);
  });

  it("(c) a second run is idempotent, byte-identical", () => {
    const injectedHome = join(dir, "injected-home-c");
    const firstRes = installRelayAgent({ homeDir: injectedHome });
    expect(firstRes.success).toBe(true);
    const agentPath = join(injectedHome, ".claude", "agents", "relay.md");
    const firstContent = readFileSync(agentPath, "utf8");

    const secondRes = installRelayAgent({ homeDir: injectedHome });
    expect(secondRes.success).toBe(true);
    const secondContent = readFileSync(agentPath, "utf8");
    expect(secondContent).toBe(firstContent);
  });

  it("(d) a foreign file without the marker is refused and stays byte-identical", () => {
    const injectedHome = join(dir, "injected-home-d");
    const agentPath = join(injectedHome, ".claude", "agents", "relay.md");
    mkdirSync(dirname(agentPath), { recursive: true });
    const foreignContent = "--- \nname: foreign\n---\nCustom agent without marker\n";
    writeFileSync(agentPath, foreignContent);

    const res = installRelayAgent({ homeDir: injectedHome });
    expect(res.success).toBe(false);
    expect(res.message).toContain(agentPath);

    const afterContent = readFileSync(agentPath, "utf8");
    expect(afterContent).toBe(foreignContent);
  });

  it("setupClaudeDesktop installs the relay agent and reports usage", () => {
    const testHome = join(dir, "desktop-home");
    const target = join(testHome, "claude_desktop_config.json");
    const res = setupClaudeDesktop({ targetPath: target, homeDir: testHome });
    expect(res.success).toBe(true);
    expect(existsSync(join(testHome, ".claude", "agents", "relay.md"))).toBe(true);
    expect(res.message).toContain(join(testHome, ".claude", "agents", "relay.md"));
    expect(res.message).toContain('agent(task, {agentType: "relay"})');
  });

  it("setupClaudeCli installs the relay agent and reports usage", () => {
    const testHome = join(dir, "cli-home");
    const seen: string[] = [];
    const res = setupClaudeCli({ homeDir: testHome, out: (l) => seen.push(l) });
    expect(res.success).toBe(true);
    expect(existsSync(join(testHome, ".claude", "agents", "relay.md"))).toBe(true);
    const allOut = seen.join("\n");
    expect(allOut).toContain(join(testHome, ".claude", "agents", "relay.md"));
    expect(allOut).toContain('agent(task, {agentType: "relay"})');
  });
});
