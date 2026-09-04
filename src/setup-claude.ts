import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { homedir, platform } from "node:os";

export interface SetupFs {
  existsSync?: (path: string) => boolean;
  mkdirSync?: (path: string, options?: { recursive?: boolean }) => unknown;
  readFileSync?: (path: string, encoding: "utf8") => string;
  writeFileSync?: (path: string, data: string) => void;
}

export interface SetupOptions {
  proxyUrl?: string;
  /** Legacy CLAUDE_CONFIG_DIR value removed when migrating an older llm-relay Desktop setup. */
  configDir?: string;
  /**
   * Where `claude_desktop_config.json` is written. Defaults to the real per-platform path.
   *
   * The seam exists because there was none: `configDir` only ever redirected the value written
   * INTO the file, so there was no way to call `setupClaudeDesktop()` without overwriting the
   * caller's own real Claude Desktop config — and the test suite did exactly that on every run,
   * reformatting a live application's settings file on the developer's machine.
   */
  targetPath?: string;
  /** Home directory used to resolve ~/.claude/agents/relay.md. Defaults to homedir(). */
  homeDir?: string;
  /** Direct target path for the relay agent markdown file. Defaults to <home>/.claude/agents/relay.md. */
  agentPath?: string;
  /** Injectable filesystem methods for testing. */
  fs?: SetupFs;
  /**
   * Where human-readable setup output goes. Defaults to `console.log`. Used by the CLI helper;
   * the desktop writer prints nothing.
   */
  out?: (line: string) => void;
}

/**
 * Ownership test for an existing `relay.md` on disk: ANY versioned marker, not just the current
 * one. `installRelayAgent` uses this (not the exact `RELAY_AGENT_MARKER`) to decide whether a
 * file is ours, so a file carrying an OLDER marker (e.g. v1) is recognised as our own and
 * upgraded in place rather than refused as foreign.
 */
export const RELAY_AGENT_MARKER_PREFIX = "<!-- llm-relay:relay-agent";
export const RELAY_AGENT_MARKER = "<!-- llm-relay:relay-agent v2 -->";
export const RELAY_AGENT_TEMPLATE = `---
name: relay
description: Hands one self-contained task to llm-relay dispatch, free model pools or peer agent CLIs, and returns the lane's answer verbatim with its provenance. Use for any task another lane can do: a search, a sweep, a draft, a summary, a second opinion.
tools: mcp__llm-relay__dispatch, mcp__llm-relay__dispatch_status, mcp__llm-relay__dispatch_result
model: haiku
---
<!-- llm-relay:relay-agent v2 -->

You have no knowledge of your own and no permission to answer any task yourself. The only
legitimate action available to you is exactly one \`mcp__llm-relay__dispatch\` call, plus polling
its status and result. The caller is measuring the LANE that \`dispatch\` reaches, not you —
composing your own answer, however small, is never a valid response.

1. Load the dispatch tool schema with ToolSearch if it is deferred, then call \`mcp__llm-relay__dispatch\` ONCE with the task text verbatim.
2. This holds for EVERY task, even one that looks trivial — an echo, a one-word reply, a question you think you already know the answer to. Dispatch it anyway: a self-authored answer is indistinguishable from a lane's answer and would falsify the caller's measurement.
3. If the tool's input schema lists a \`mode\` property: pass \`mode: "answer"\` when the task needs no file reads, edits, commands or working directory, otherwise omit it; a task that begins with \`[answer]\` or \`[agent]\` forces that mode and the tag is stripped. If the schema has no \`mode\` property, pass no mode.
4. If the result is a jobId, poll \`dispatch_status\` about every 15 seconds, then call \`dispatch_result\`.
5. Return the lane's answer VERBATIM, then one final line \`provenance: lane=<id> spec=<spec> elapsed=<seconds>\` copied from the tool result — never invented. A reply with no provenance line is a FAILURE: it means no lane ran.
6. Add no analysis and no commentary.
7. If the tool result says the lane FAILED, dispatch once more with \`tier: "high"\`; if that fails too, return exactly \`RELAY_DISPATCH_FAILED: <reason>\`.
`;

export function getRelayAgentPath(opts: SetupOptions = {}): string {
  if (opts.agentPath) return opts.agentPath;
  const home = opts.homeDir ?? homedir();
  return join(home, ".claude", "agents", "relay.md");
}

export function installRelayAgent(opts: SetupOptions = {}): { success: boolean; path: string; message: string } {
  const agentPath = getRelayAgentPath(opts);
  const exists = opts.fs?.existsSync ?? existsSync;
  const mkdir = opts.fs?.mkdirSync ?? mkdirSync;
  const read = opts.fs?.readFileSync ?? readFileSync;
  const write = opts.fs?.writeFileSync ?? writeFileSync;

  try {
    if (exists(agentPath)) {
      const existing = read(agentPath, "utf8");
      // A prefix test, not an exact match against the CURRENT marker: a file carrying an OLDER
      // versioned marker (e.g. v1) is still ours and gets upgraded in place, not refused as
      // foreign. An exact-match test here would have refused every pre-v2 install on this file's
      // own version bump.
      if (!existing.includes(RELAY_AGENT_MARKER_PREFIX)) {
        return {
          success: false,
          path: agentPath,
          message: `Refusing to overwrite foreign agent file at ${agentPath}`,
        };
      }
    } else {
      mkdir(dirname(agentPath), { recursive: true });
    }

    write(agentPath, RELAY_AGENT_TEMPLATE);
    return {
      success: true,
      path: agentPath,
      message: `Installed relay agent at ${agentPath}`,
    };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return {
      success: false,
      path: agentPath,
      message: `Failed to install relay agent at ${agentPath}: ${msg}`,
    };
  }
}

export function getClaudeDesktopConfigPath(): string {
  const os = platform();
  if (os === "win32") {
    const appData = process.env.APPDATA ?? join(homedir(), "AppData", "Roaming");
    return join(appData, "Claude", "claude_desktop_config.json");
  } else if (os === "darwin") {
    return join(homedir(), "Library", "Application Support", "Claude", "claude_desktop_config.json");
  } else {
    return join(homedir(), ".config", "Claude", "claude_desktop_config.json");
  }
}

/** Configures Claude Desktop with the host-independent llm-relay MCP dispatch server. */
export function setupClaudeDesktop(opts: SetupOptions = {}): { success: boolean; path: string; message: string } {
  const targetPath = opts.targetPath ?? getClaudeDesktopConfigPath();
  const legacyProxyUrl = opts.proxyUrl ?? "http://127.0.0.1:8791";
  const legacyConfigDir = opts.configDir ?? join(homedir(), ".llm-relay-claude");

  const exists = opts.fs?.existsSync ?? existsSync;
  const mkdir = opts.fs?.mkdirSync ?? mkdirSync;
  const read = opts.fs?.readFileSync ?? readFileSync;
  const write = opts.fs?.writeFileSync ?? writeFileSync;

  try {
    mkdir(dirname(targetPath), { recursive: true });
    let existingConfig: Record<string, unknown> = {};

    if (exists(targetPath)) {
      try {
        existingConfig = JSON.parse(read(targetPath, "utf8")) as Record<string, unknown>;
      } catch {
        /* parse fallback */
      }
    }

    const currentServers =
      existingConfig.mcpServers && typeof existingConfig.mcpServers === "object"
        ? (existingConfig.mcpServers as Record<string, unknown>)
        : {};
    existingConfig.mcpServers = {
      ...currentServers,
      "llm-relay": { command: "llm-relay", args: ["mcp"] },
    };

    // Releases through v0.68.4 wrote these exact values even though Desktop overrides the base
    // URL before a session starts. Remove only values this setup command can prove it authored;
    // unrelated environment settings and user-chosen alternatives survive.
    const currentEnv =
      existingConfig.env && typeof existingConfig.env === "object"
        ? { ...(existingConfig.env as Record<string, string>) }
        : {};
    const legacyEnv: Record<string, string> = {
      ANTHROPIC_BASE_URL: legacyProxyUrl,
      ANTHROPIC_AUTH_TOKEN: "dummy",
      CLAUDE_CONFIG_DIR: legacyConfigDir,
      CLAUDE_CODE_DISABLE_ADAPTIVE_THINKING: "1",
      CLAUDE_CODE_DISABLE_EXPERIMENTAL_BETAS: "1",
      CLAUDE_CODE_ATTRIBUTION_HEADER: "0",
    };
    for (const [name, value] of Object.entries(legacyEnv)) {
      if (currentEnv[name] === value) delete currentEnv[name];
    }
    if (Object.keys(currentEnv).length === 0) delete existingConfig.env;
    else existingConfig.env = currentEnv;

    write(targetPath, JSON.stringify(existingConfig, null, 2) + "\n");

    const agentRes = installRelayAgent(opts);
    const lines = [
      `Successfully configured Claude Desktop MCP dispatch at ${targetPath}`,
    ];
    if (agentRes.success) {
      lines.push(`Installed relay agent at ${agentRes.path}`);
      lines.push('agent(task, {agentType: "relay"})');
    } else {
      lines.push(agentRes.message);
    }

    if (opts.out) {
      for (const line of lines) opts.out(line);
    }

    return {
      success: true,
      path: targetPath,
      message: lines.join("\n"),
    };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return {
      success: false,
      path: targetPath,
      message: `Failed to configure Claude Desktop: ${msg}`,
    };
  }
}

/**
 * Print/verify instructions and wrapper script setup for Claude CLI.
 *
 * The lines are BUILT, then written through `opts.out` (default `console.log`) and also
 * returned. A caller that only wants to check what this says — a test, or anything embedding
 * the helper — can read `lines` and pass a silent sink instead of scraping stdout.
 */
export function setupClaudeCli(opts: SetupOptions = {}): { success: boolean; message: string; lines: string[] } {
  const proxyUrl = opts.proxyUrl ?? "http://127.0.0.1:8791";
  const scriptDir = join(process.cwd(), "scripts");
  const ps1Path = join(scriptDir, "claude-proxied.ps1");
  const shPath = join(scriptDir, "claude-proxied.sh");

  const lines = [
    "\n=== Claude CLI (claude) Setup ===",
    `Proxy URL: ${proxyUrl}`,
    `Config Dir: ~/.llm-relay-claude\n`,
    "Use the included wrapper scripts from any directory:",
    `  PowerShell: ${ps1Path} -p "your prompt"`,
    `  Bash:       ${shPath} -p "your prompt"\n`,
    "Or set environment variables inline in your shell:",
    '  export ANTHROPIC_BASE_URL="http://127.0.0.1:8791"',
    '  export ANTHROPIC_AUTH_TOKEN="dummy"',
    '  export CLAUDE_CONFIG_DIR="$HOME/.llm-relay-claude"\n',
  ];

  const agentRes = installRelayAgent(opts);
  const out = opts.out ?? ((line: string) => console.log(line));

  if (agentRes.success) {
    lines.push(`Installed relay agent at ${agentRes.path}`);
    lines.push('agent(task, {agentType: "relay"})');
  } else {
    lines.push(agentRes.message);
  }
  lines.push("");
  for (const line of lines) out(line);

  return {
    success: true,
    message: "Claude CLI configuration helper output delivered successfully.",
    lines,
  };
}
