#!/usr/bin/env node
import { loadConfig, type Config, type ConfigOverrides } from "./config.js";
import { createProxy } from "./server.js";
import { ModelCatalog } from "./catalog.js";

function argValue(flag: string): string | undefined {
  const i = process.argv.indexOf(flag);
  return i !== -1 ? process.argv[i + 1] : undefined;
}

const HELP = `repair-proxy — loopback Anthropic-Messages proxy that validates/repairs tool calls.

Multi-provider: config declares a providers{} registry; a request's model routes
to one provider by namespace ("nim/z-ai/glm-5.2") or by Claude tier (routing.tiers).

Usage:
  repair-proxy [--config <path>] [overrides]     start the proxy
  repair-proxy models [--provider <name>] [--refresh]   list live models per provider

  --config <path>        Config file (default: config.json)

Overrides (win over the config file, so routing can be repointed without editing it):
  --default <prov/model> routing.default (fallback provider/model)
  --mode <detect|repair> mode
  --listen <host:port>   listen address (loopback only)

Model ids are discovered dynamically from each provider's /models endpoint and
cached (~/.repair-proxy/models-cache.json, 10-min TTL). "repair-proxy models" lists
them; --refresh forces a re-fetch. On startup the proxy warms the cache and warns
about any routing target its provider does not serve.

Config string values may reference environment variables as \${NAME}
(e.g. "base": "\${LLM_BACKEND_BASE_URL}"); an unset var is a startup error.
`;

/** Split a "provider/model" spec on the first slash. */
function splitSpec(spec: string): { provider: string; model?: string } {
  const i = spec.indexOf("/");
  return i === -1 ? { provider: spec } : { provider: spec.slice(0, i), model: spec.slice(i + 1) };
}

function loadOrExit(): Config {
  const configPath = argValue("--config") ?? "config.json";
  const overrides: ConfigOverrides = {
    routeDefault: argValue("--default"),
    mode: argValue("--mode"),
    listen: argValue("--listen"),
  };
  try {
    return loadConfig(configPath, overrides);
  } catch (e) {
    process.stderr.write(`repair-proxy: ${(e as Error).message}\n`);
    process.exit(1);
  }
}

/** `repair-proxy models` — dynamic, cached model discovery per provider. */
async function runModels(): Promise<void> {
  const cfg = loadOrExit();
  const only = argValue("--provider");
  const force = process.argv.includes("--refresh");
  const catalog = new ModelCatalog();
  const names = Object.keys(cfg.providers).filter((n) => !only || n === only);
  if (names.length === 0) {
    process.stderr.write(`repair-proxy: no provider named "${only}"\n`);
    process.exit(1);
  }
  for (const name of names) {
    const p = cfg.providers[name]!;
    if (p.kind !== "openai") {
      process.stdout.write(`\n${name} (${p.kind}) — no /models endpoint consumed\n`);
      continue;
    }
    let models: string[] = [];
    try {
      models = await catalog.list(name, p, { force });
    } catch {
      /* fail-open */
    }
    if (models.length === 0) {
      process.stdout.write(`\n${name} — (no models: unreachable, unauthorized, or empty catalog)\n`);
      continue;
    }
    process.stdout.write(`\n${name} — ${models.length} models:\n`);
    for (const m of models) process.stdout.write(`  ${m}\n`);
  }
}

/**
 * Warm every provider's catalog and warn about any routing target the provider
 * does not serve — non-blocking (fire-and-forget) so it never delays listen().
 */
async function warmAndValidate(cfg: Config, catalog: ModelCatalog): Promise<void> {
  const specs = [cfg.routing.default, ...Object.values(cfg.routing.tiers)];
  const seen = new Set<string>();
  for (const spec of specs) {
    if (seen.has(spec)) continue;
    seen.add(spec);
    const { provider, model } = splitSpec(spec);
    const p = cfg.providers[provider];
    if (!p || p.kind !== "openai" || !model) continue;
    const known = await catalog.has(provider, p, model);
    if (known === false) {
      process.stderr.write(
        `repair-proxy: routing target "${spec}" — provider "${provider}" does not list model "${model}". ` +
          `Requests routed here will fail; run "repair-proxy models --provider ${provider}" to see valid ids.\n`,
      );
    }
  }
}

function runProxy(): void {
  const cfg = loadOrExit();
  const catalog = new ModelCatalog();
  const server = createProxy(cfg, { catalog });
  server.listen(cfg.port, cfg.host, () => {
    const providers = Object.keys(cfg.providers).join(",");
    process.stderr.write(
      `repair-proxy listening on http://${cfg.host}:${cfg.port} ` +
        `(mode=${cfg.mode}, providers=[${providers}], default=${cfg.routing.default})\n`,
    );
    void warmAndValidate(cfg, catalog);
  });

  for (const sig of ["SIGINT", "SIGTERM"] as const) {
    process.on(sig, () => server.close(() => process.exit(0)));
  }
}

function main(): void {
  if (process.argv.includes("--help") || process.argv.includes("-h")) {
    process.stdout.write(HELP);
    process.exit(0);
  }
  if (process.argv[2] === "models") {
    runModels().catch((e) => {
      process.stderr.write(`repair-proxy: ${(e as Error).message}\n`);
      process.exit(1);
    });
    return;
  }
  runProxy();
}

main();
