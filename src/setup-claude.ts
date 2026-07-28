import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { homedir, platform } from "node:os";

export interface SetupOptions {
  proxyUrl?: string;
  configDir?: string;
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
  const targetPath = getClaudeDesktopConfigPath();
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

/** Print/verify instructions and wrapper script setup for Claude CLI. */
export function setupClaudeCli(opts: SetupOptions = {}): { success: boolean; message: string } {
  const proxyUrl = opts.proxyUrl ?? "http://127.0.0.1:8791";
  const scriptDir = join(process.cwd(), "scripts");
  const ps1Path = join(scriptDir, "claude-proxied.ps1");
  const shPath = join(scriptDir, "claude-proxied.sh");

  console.log("\n=== Claude CLI (claude) Setup ===");
  console.log(`Proxy URL: ${proxyUrl}`);
  console.log(`Config Dir: ~/.llm-relay-claude\n`);

  console.log("Use the included wrapper scripts from any directory:");
  console.log(`  PowerShell: ${ps1Path} -p "your prompt"`);
  console.log(`  Bash:       ${shPath} -p "your prompt"\n`);

  console.log("Or set environment variables inline in your shell:");
  console.log("  export ANTHROPIC_BASE_URL=\"http://127.0.0.1:8791\"");
  console.log("  export ANTHROPIC_AUTH_TOKEN=\"dummy\"");
  console.log("  export CLAUDE_CONFIG_DIR=\"$HOME/.llm-relay-claude\"\n");

  return {
    success: true,
    message: "Claude CLI configuration helper output delivered successfully.",
  };
}
