import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { homedir, platform } from "node:os";

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
  /**
   * Where human-readable setup output goes. Defaults to `console.log`. Used by the CLI helper;
   * the desktop writer prints nothing.
   */
  out?: (line: string) => void;
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

  try {
    mkdirSync(dirname(targetPath), { recursive: true });
    let existingConfig: Record<string, unknown> = {};

    if (existsSync(targetPath)) {
      try {
        existingConfig = JSON.parse(readFileSync(targetPath, "utf8")) as Record<string, unknown>;
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

    writeFileSync(targetPath, JSON.stringify(existingConfig, null, 2) + "\n");
    return {
      success: true,
      path: targetPath,
      message: `Successfully configured Claude Desktop MCP dispatch at ${targetPath}`,
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

  const out = opts.out ?? ((line: string) => console.log(line));
  for (const line of lines) out(line);

  return {
    success: true,
    message: "Claude CLI configuration helper output delivered successfully.",
    lines,
  };
}
