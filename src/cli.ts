#!/usr/bin/env node
import { loadConfig } from "./config.js";
import { createProxy } from "./server.js";

function argValue(flag: string): string | undefined {
  const i = process.argv.indexOf(flag);
  return i !== -1 ? process.argv[i + 1] : undefined;
}

function main(): void {
  const configPath = argValue("--config") ?? "config.json";
  let cfg;
  try {
    cfg = loadConfig(configPath);
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
