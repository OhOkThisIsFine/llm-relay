import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { homedir, platform } from "node:os";

export interface SetupOptions {
  proxyUrl?: string;
  /** The CLAUDE_CONFIG_DIR *value* written into the config. Not where the config itself goes. */
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

/** Configures Claude Desktop to route through llm-relay loopback proxy. */
export function setupClaudeDesktop(opts: SetupOptions = {}): { success: boolean; path: string; message: string } {
  const targetPath = opts.targetPath ?? getClaudeDesktopConfigPath();
  const proxyUrl = opts.proxyUrl ?? "http://127.0.0.1:8791";
  const proxyConfigDir = opts.configDir ?? join(homedir(), ".llm-relay-claude");

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

    const envObj = (existingConfig.env as Record<string, string>) ?? {};
    envObj.ANTHROPIC_BASE_URL = proxyUrl;
    envObj.ANTHROPIC_AUTH_TOKEN = "dummy";
    envObj.CLAUDE_CONFIG_DIR = proxyConfigDir;
    envObj.CLAUDE_CODE_DISABLE_ADAPTIVE_THINKING = "1";
    envObj.CLAUDE_CODE_DISABLE_EXPERIMENTAL_BETAS = "1";
    envObj.CLAUDE_CODE_ATTRIBUTION_HEADER = "0";

    existingConfig.env = envObj;

    writeFileSync(targetPath, JSON.stringify(existingConfig, null, 2) + "\n");
    return {
      success: true,
      path: targetPath,
      message: `Successfully configured Claude Desktop at ${targetPath} (pointing to ${proxyUrl})`,
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
