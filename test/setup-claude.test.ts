import { describe, it, expect, afterAll } from "vitest";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { getClaudeDesktopConfigPath, setupClaudeDesktop, setupClaudeCli, installRelayAgent, RELAY_AGENT_MARKER, RELAY_AGENT_TEMPLATE, type SetupFs } from "../src/setup-claude.js";
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
// Snapshot by BYTE CONTENT, not just absence: on a machine where
// `llm-relay setup claude-cli`/`claude-desktop` has already installed the agent, this file
// legitimately exists before the suite runs. An installed file is allowed; the guard below only
// fails if the suite itself created, modified or deleted it.
const realAgentBefore = existsSync(realAgentPath) ? readFileSync(realAgentPath) : null;

afterAll(() => {
  const realAfter = existsSync(realPath) ? statSync(realPath).mtimeMs : null;
  expect(realAfter).toBe(realBefore);

  const realAgentExists = existsSync(realAgentPath);
  if (realAgentBefore === null) {
    expect(realAgentExists).toBe(false);
  } else {
    expect(realAgentExists).toBe(true);
    const realAgentAfter = readFileSync(realAgentPath);
    expect(Buffer.compare(realAgentAfter, realAgentBefore)).toBe(0);
  }
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

  it("(b) the content contains name: relay, ToolSearch leading the tools: line, all five dispatch tool names and the marker", () => {
    const injectedHome = join(dir, "injected-home-b");
    installRelayAgent({ homeDir: injectedHome });
    const agentPath = join(injectedHome, ".claude", "agents", "relay.md");
    const content = readFileSync(agentPath, "utf8");
    expect(content).toContain("name: relay");
    // The five mcp__llm-relay__dispatch* tools are DEFERRED in Claude Code: a subagent must
    // call ToolSearch to load their schemas before it can call them. Without ToolSearch in the
    // agent's own allowed-tools list, that load is impossible and the agent falls back to
    // answering the task itself. ToolSearch must therefore lead the tools: line.
    const toolsLine = content.split("\n").find((line) => line.startsWith("tools:"));
    expect(toolsLine).toBeDefined();
    expect(toolsLine).toMatch(/^tools: ToolSearch, /);
    // The `tools:` frontmatter line is what GRANTS a tool. Every name also appears in rule 1's
    // ToolSearch preload, so a whole-file `toContain` passed with a tool missing from the line
    // that matters (found by inverting the fix, 2026-09-09): assert against the line itself.
    for (const tool of [
      "mcp__llm-relay__dispatch",
      "mcp__llm-relay__dispatch_status",
      "mcp__llm-relay__dispatch_result",
      "mcp__llm-relay__dispatch_cancel",
      "mcp__llm-relay__dispatch_lanes",
    ]) {
      expect(toolsLine, tool).toContain(tool);
    }
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

  it("(e) setupClaudeDesktop with an injected fs where relay.md exists WITHOUT the marker returns success: true, its message contains the refusal line, and the Desktop config file was still written", () => {
    const testHome = join(dir, "desktop-e");
    const target = join(testHome, "claude_desktop_config.json");
    const agentPath = join(testHome, ".claude", "agents", "relay.md");
    const injectedFs: SetupFs = {
      existsSync: (p: string) => (p === agentPath ? true : existsSync(p)),
      readFileSync: (p: string, enc: "utf8") => (p === agentPath ? "custom foreign agent without marker" : readFileSync(p, enc)),
    };

    const res = setupClaudeDesktop({ targetPath: target, homeDir: testHome, fs: injectedFs });
    expect(res.success).toBe(true);
    expect(res.message).toContain(`Refusing to overwrite foreign agent file at ${agentPath}`);
    expect(existsSync(target)).toBe(true);
    const written = JSON.parse(readFileSync(target, "utf8")) as {
      mcpServers: Record<string, { command: string; args: string[] }>;
    };
    expect(written.mcpServers["llm-relay"]).toEqual({ command: "llm-relay", args: ["mcp"] });
  });

  it("(f) setupClaudeCli with an injected fs where relay.md exists WITHOUT the marker returns success: true, refusal line among the output lines", () => {
    const testHome = join(dir, "cli-f");
    const agentPath = join(testHome, ".claude", "agents", "relay.md");
    const seen: string[] = [];
    const injectedFs: SetupFs = {
      existsSync: (p: string) => (p === agentPath ? true : existsSync(p)),
      readFileSync: (p: string, enc: "utf8") => (p === agentPath ? "custom foreign agent without marker" : readFileSync(p, enc)),
    };

    const res = setupClaudeCli({ homeDir: testHome, fs: injectedFs, out: (l) => seen.push(l) });
    expect(res.success).toBe(true);
    const refusalLine = `Refusing to overwrite foreign agent file at ${agentPath}`;
    expect(res.lines).toContain(refusalLine);
    expect(seen).toContain(refusalLine);
  });

  // --- Defect fix, 2026-09-04: the wrapper answered a trivial probe task itself instead of
  // dispatching (measured live: an `[answer]`-tagged echo returned in 4s with zero tool uses and
  // no provenance line). The rules below pin the CLAIMS the strengthened template body must make,
  // not their exact wording, so the prose can be revised without re-deriving the requirement.

  it("(g) the content states the wrapper has no knowledge of its own, no permission to answer, and that the caller is measuring the lane, not the wrapper", () => {
    const injectedHome = join(dir, "injected-home-g");
    installRelayAgent({ homeDir: injectedHome });
    const agentPath = join(injectedHome, ".claude", "agents", "relay.md");
    const content = readFileSync(agentPath, "utf8");
    expect(content).toMatch(/no knowledge of (its|your) own/i);
    expect(content).toMatch(/no permission to answer/i);
    expect(content).toMatch(/measuring the lane/i);
  });

  it("(h) the content states this holds for every task, even one that looks trivial, and that answering it directly would falsify the caller's measurement", () => {
    const injectedHome = join(dir, "injected-home-h");
    installRelayAgent({ homeDir: injectedHome });
    const agentPath = join(injectedHome, ".claude", "agents", "relay.md");
    const content = readFileSync(agentPath, "utf8");
    expect(content).toMatch(/every task/i);
    expect(content).toMatch(/trivial/i);
    expect(content).toMatch(/falsify/i);
  });

  it("(i) the content states a reply with no provenance line is a failure, and that provenance values are copied from the tool result, never invented", () => {
    const injectedHome = join(dir, "injected-home-i");
    installRelayAgent({ homeDir: injectedHome });
    const agentPath = join(injectedHome, ".claude", "agents", "relay.md");
    const content = readFileSync(agentPath, "utf8");
    expect(content).toMatch(/no provenance line[\s\S]{0,40}failure/i);
    expect(content).toMatch(/never invented/i);
  });

  // ⚠ Bumped v5 → v6 in the dispatch-lifecycle lap (2026-09-10). The version moved because the
  // template's provenance CONTRACT changed — `provenance: job=…` is now required evidence from a
  // completed dispatch, and `RELAY_DISPATCH_UNAVAILABLE` was added for the case where no lane was
  // ever reached. Flipped here in the same commit as the source, per the standing protocol.
  it("(j) the marker is bumped to v6", () => {
    expect(RELAY_AGENT_MARKER).toContain("v6");
    expect(RELAY_AGENT_MARKER).not.toContain("v5");
    const injectedHome = join(dir, "injected-home-j");
    installRelayAgent({ homeDir: injectedHome });
    const agentPath = join(injectedHome, ".claude", "agents", "relay.md");
    const content = readFileSync(agentPath, "utf8");
    expect(content).toContain("<!-- llm-relay:relay-agent v6 -->");
  });

  it("(k) a file carrying the OLD v1 marker is recognised as our own and upgraded to v6, not refused as foreign", () => {
    const injectedHome = join(dir, "injected-home-k");
    const agentPath = join(injectedHome, ".claude", "agents", "relay.md");
    mkdirSync(dirname(agentPath), { recursive: true });
    const oldContent = "---\nname: relay\n---\n<!-- llm-relay:relay-agent v1 -->\n\n1. Old rule text.\n";
    writeFileSync(agentPath, oldContent);

    const res = installRelayAgent({ homeDir: injectedHome });
    expect(res.success).toBe(true);

    const afterContent = readFileSync(agentPath, "utf8");
    expect(afterContent).toBe(RELAY_AGENT_TEMPLATE);
    expect(afterContent).toContain(RELAY_AGENT_MARKER);
    expect(afterContent).not.toContain("relay-agent v1 -->");
  });

  it("(l) a file carrying the previous v2 marker is recognised as our own and upgraded to v5, not refused as foreign", () => {
    const injectedHome = join(dir, "injected-home-l");
    const agentPath = join(injectedHome, ".claude", "agents", "relay.md");
    mkdirSync(dirname(agentPath), { recursive: true });
    const oldContent =
      "---\nname: relay\ntools: mcp__llm-relay__dispatch, mcp__llm-relay__dispatch_status, mcp__llm-relay__dispatch_result\nmodel: haiku\n---\n<!-- llm-relay:relay-agent v2 -->\n\n1. Old rule text.\n";
    writeFileSync(agentPath, oldContent);

    const res = installRelayAgent({ homeDir: injectedHome });
    expect(res.success).toBe(true);

    const afterContent = readFileSync(agentPath, "utf8");
    expect(afterContent).toBe(RELAY_AGENT_TEMPLATE);
    expect(afterContent).toContain(RELAY_AGENT_MARKER);
    expect(afterContent).not.toContain("relay-agent v2 -->");
  });

  // --- Defect fix, 2026-09-04 (same day, found after the ToolSearch fix above): `model: haiku`
  // answered a trivial echo task ITSELF (4s, 0 tool calls, no provenance) while a realistic task
  // correctly dispatched (17s, 2 tool calls, provenance) — haiku was too weak to reliably obey its
  // own rule 2. The owner's direction was not to hard-code a model name at all (the template must
  // also work from Codex, which has no haiku/sonnet/opus alias vocabulary), so v4 removes the pin
  // in favor of `model: inherit` rather than an omitted `model:` line — confirmed against
  // https://code.claude.com/docs/en/sub-agents.md that an omitted field can fall through to the
  // `CLAUDE_CODE_SUBAGENT_MODEL` environment variable before ever reaching the calling session's
  // model, while `inherit` selects the calling session's model directly.

  it("(m) a file carrying the previous v3 marker is recognised as our own and upgraded to v4, not refused as foreign", () => {
    const injectedHome = join(dir, "injected-home-m");
    const agentPath = join(injectedHome, ".claude", "agents", "relay.md");
    mkdirSync(dirname(agentPath), { recursive: true });
    const oldContent =
      "---\nname: relay\ntools: ToolSearch, mcp__llm-relay__dispatch, mcp__llm-relay__dispatch_status, mcp__llm-relay__dispatch_result\nmodel: haiku\n---\n<!-- llm-relay:relay-agent v3 -->\n\n1. Old rule text.\n";
    writeFileSync(agentPath, oldContent);

    const res = installRelayAgent({ homeDir: injectedHome });
    expect(res.success).toBe(true);

    const afterContent = readFileSync(agentPath, "utf8");
    expect(afterContent).toBe(RELAY_AGENT_TEMPLATE);
    expect(afterContent).toContain(RELAY_AGENT_MARKER);
    expect(afterContent).not.toContain("relay-agent v3 -->");
  });

  it("(o) a file carrying the previous v4 marker is recognised as our own and upgraded to v5, not refused as foreign", () => {
    const injectedHome = join(dir, "injected-home-o");
    const agentPath = join(injectedHome, ".claude", "agents", "relay.md");
    mkdirSync(dirname(agentPath), { recursive: true });
    const oldContent =
      "---\nname: relay\ntools: ToolSearch, mcp__llm-relay__dispatch, mcp__llm-relay__dispatch_status, mcp__llm-relay__dispatch_result\nmodel: inherit\n---\n<!-- llm-relay:relay-agent v4 -->\n\n1. Old rule text.\n";
    writeFileSync(agentPath, oldContent);

    const res = installRelayAgent({ homeDir: injectedHome });
    expect(res.success).toBe(true);

    const afterContent = readFileSync(agentPath, "utf8");
    expect(afterContent).toBe(RELAY_AGENT_TEMPLATE);
    expect(afterContent).toContain(RELAY_AGENT_MARKER);
    expect(afterContent).not.toContain("relay-agent v4 -->");
  });

  it("(p) the content pins no model alias — model: inherit selects the calling session's model, never a hardcoded model: haiku or model: sonnet", () => {
    const injectedHome = join(dir, "injected-home-p");
    installRelayAgent({ homeDir: injectedHome });
    const agentPath = join(injectedHome, ".claude", "agents", "relay.md");
    const content = readFileSync(agentPath, "utf8");
    const modelLine = content.split("\n").find((line) => line.startsWith("model:"));
    expect(modelLine).toBe("model: inherit");
    expect(content).not.toContain("model: haiku");
    expect(content).not.toContain("model: sonnet");
    expect(content).not.toContain("model: opus");
  });
});

