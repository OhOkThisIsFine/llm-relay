#!/usr/bin/env node
import { loadConfig, type ConfigOverrides } from "./config.js";
import { createProxy } from "./server.js";

function argValue(flag: string): string | undefined {
  const i = process.argv.indexOf(flag);
  return i !== -1 ? process.argv[i + 1] : undefined;
}

const HELP = `repair-proxy — loopback Anthropic-Messages proxy that validates/repairs tool calls.

Usage: repair-proxy [--config <path>] [overrides]

  --config <path>        Config file (default: config.json)

Overrides (win over the config file, so a provider can be repointed without editing it):
  --backend-base <url>   backend.base
  --model <id>           backend.model (target model id)
  --mode <detect|repair> mode
  --listen <host:port>   listen address (loopback only)

Config string values may reference environment variables as \${NAME}
(e.g. "base": "\${LLM_BACKEND_BASE_URL}"); an unset var is a startup error.
`;

function main(): void {
  if (process.argv.includes("--help") || process.argv.includes("-h")) {
    process.stdout.write(HELP);
    process.exit(0);
    return;
  }

  const configPath = argValue("--config") ?? "config.json";
  const overrides: ConfigOverrides = {
    backendBase: argValue("--backend-base"),
    model: argValue("--model"),
    mode: argValue("--mode"),
    listen: argValue("--listen"),
  };

  let cfg;
  try {
    cfg = loadConfig(configPath, overrides);
  } catch (e) {
    process.stderr.write(`repair-proxy: ${(e as Error).message}\n`);
    process.exit(1);
    return;
  }

  const server = createProxy(cfg);
  server.listen(cfg.port, cfg.host, () => {
    process.stderr.write(
      `repair-proxy listening on http://${cfg.host}:${cfg.port} ` +
        `(mode=${cfg.mode}, backend=${cfg.backend.base})\n`,
    );
  });

  for (const sig of ["SIGINT", "SIGTERM"] as const) {
    process.on(sig, () => server.close(() => process.exit(0)));
  }
}

main();
