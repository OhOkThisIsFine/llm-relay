#!/usr/bin/env node
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import { loadConfig, type Config, type ConfigOverrides } from "./config.js";
import { createProxy } from "./server.js";
import { ModelCatalog } from "./catalog.js";

export function argValue(...flags: string[]): string | undefined {
  const allFlags = new Set<string>();
  for (const flag of flags) {
    allFlags.add(flag);
    if (flag.startsWith("--")) {
      allFlags.add(flag.slice(1));
    }
  }

  for (let i = 1; i < process.argv.length; i++) {
    const arg = process.argv[i];
    if (!arg) continue;

    for (const f of allFlags) {
      if (arg === f) {
        return process.argv[i + 1];
      }
      if (arg.startsWith(f + "=")) {
        return arg.slice(f.length + 1);
      }
    }
  }
  return undefined;
}

export function hasFlag(...flags: string[]): boolean {
  const allFlags = new Set<string>();
  for (const flag of flags) {
    allFlags.add(flag);
    if (flag.startsWith("--")) {
      allFlags.add(flag.slice(1));
    }
  }

  for (let i = 1; i < process.argv.length; i++) {
    const arg = process.argv[i];
    if (!arg) continue;

    for (const f of allFlags) {
      if (arg === f || arg.startsWith(f + "=")) {
        return true;
      }
    }
  }
  return false;
}

const HELP = `llm-relay — loopback Anthropic-Messages proxy that validates/repairs tool calls.

Multi-provider: config declares a providers{} registry; a request's model routes
to one provider by namespace ("nim/z-ai/glm-5.2") or by Claude tier (routing.tiers).

Usage:
  llm-relay [--config <path>] [overrides]     start the proxy
  llm-relay models [--provider <name>] [--refresh]   list live models per provider

  --config <path>        Config file (default: ~/.llm-relay/config.json)

Overrides (win over the config file, so routing can be repointed without editing it):
  --default <prov/model> routing.default (fallback provider/model)
  --mode <detect|repair> mode
  --listen <host:port>   listen address (loopback only)

Model ids are discovered dynamically from each provider's /models endpoint and
cached (~/.llm-relay/models-cache.json, 10-min TTL). "llm-relay models" lists
them; --refresh forces a re-fetch. On startup the proxy warms the cache and warns
about any routing target its provider does not serve.

Config string values may reference environment variables as \${NAME}
(e.g. "base": "\${LLM_BACKEND_BASE_URL}"); an unset var is a startup error.
`;

const DEFAULT_CONFIG_TEMPLATE = JSON.stringify(
  {
    listen: "127.0.0.1:8791",
    providers: {
      nim: {
        base: "https://integrate.api.nvidia.com/v1",
        kind: "openai",
        authEnv: "NVIDIA_API_KEY",
      },
      openrouter: {
        base: "https://openrouter.ai/api/v1",
        kind: "openai",
        authEnv: "OPENROUTER_API_KEY",
      },
      gemini: {
        base: "https://generativelanguage.googleapis.com/v1beta/openai",
        kind: "openai",
        authEnv: "GEMINI_API_KEY",
      },
      groq: {
        base: "https://api.groq.com/openai/v1",
        kind: "openai",
        authEnv: "GROQ_API_KEY",
      },
      mistral: {
        base: "https://api.mistral.ai/v1",
        kind: "openai",
        authEnv: "MISTRAL_API_KEY",
      },
    },
    routing: {
      default: "nim/meta/llama-3.1-70b-instruct",
      tiers: {
        opus: "nim/nvidia/nemotron-3-super-120b-a12b",
        sonnet: "nim/meta/llama-3.1-70b-instruct",
        haiku: "nim/meta/llama-3.1-8b-instruct",
      },
    },
    mode: "repair",
    repair: {
      maxAttempts: 2,
      destructiveTools: ["rm", "delete", "push", "force", "overwrite", "drop", "reset"],
    },
    log: { level: "metadata", file: null },
  },
  null,
  2,
);

/** Split a "provider/model" spec on the first slash. */
export function splitSpec(spec: string): { provider: string; model?: string } {
  const i = spec.indexOf("/");
  return i === -1 ? { provider: spec } : { provider: spec.slice(0, i), model: spec.slice(i + 1) };
}

export function resolveConfigPath(): string {
  const explicit = argValue("--config", "-c");
  if (explicit) return explicit;

  const userConfigDir = join(homedir(), ".llm-relay");
  const userConfig = join(userConfigDir, "config.json");

  if (existsSync(userConfig)) return userConfig;
  if (existsSync("config.json")) return "config.json";

  try {
    mkdirSync(userConfigDir, { recursive: true });
    writeFileSync(userConfig, DEFAULT_CONFIG_TEMPLATE, "utf8");
    process.stderr.write(`llm-relay: initialized global config at ${userConfig}\n`);
    return userConfig;
  } catch {
    return "config.json";
  }
}

export function loadOrExit(): Config {
  const configPath = resolveConfigPath();
  const overrides: ConfigOverrides = {
    routeDefault: argValue("--default", "-d"),
    mode: argValue("--mode", "-m"),
    listen: argValue("--listen", "-l"),
  };
  try {
    return loadConfig(configPath, overrides);
  } catch (e) {
    process.stderr.write(`llm-relay: ${(e as Error).message}\n`);
    process.exit(1);
  }
}

/** `llm-relay models` — dynamic, cached model discovery per provider. */
export async function runModels(): Promise<void> {
  const cfg = loadOrExit();
  const only = argValue("--provider", "-p");
  const force = hasFlag("--refresh", "-r");
  const catalog = new ModelCatalog();
  const names = Object.keys(cfg.providers).filter((n) => !only || n === only);
  if (names.length === 0) {
    process.stderr.write(`llm-relay: no provider named "${only}"\n`);
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
export async function warmAndValidate(cfg: Config, catalog: ModelCatalog): Promise<void> {
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
        `llm-relay: routing target "${spec}" — provider "${provider}" does not list model "${model}". ` +
          `Requests routed here will fail; run "llm-relay models --provider ${provider}" to see valid ids.\n`,
      );
    }
  }
}

export function runProxy() {
  const cfg = loadOrExit();
  const catalog = new ModelCatalog();
  const server = createProxy(cfg, { catalog });
  server.listen(cfg.port, cfg.host, () => {
    const providers = Object.keys(cfg.providers).join(",");
    process.stderr.write(
      `llm-relay listening on http://${cfg.host}:${cfg.port} ` +
        `(mode=${cfg.mode}, providers=[${providers}], default=${cfg.routing.default})\n`,
    );
    void warmAndValidate(cfg, catalog);
  });

  const shutdown = () => {
    if (typeof server.closeIdleConnections === "function") {
      server.closeIdleConnections();
    }
    server.close(() => process.exit(0));
  };

  for (const sig of ["SIGINT", "SIGTERM"] as const) {
    process.on(sig, shutdown);
  }

  return server;
}

export function main(): void {
  if (hasFlag("--help", "-h")) {
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

if (process.argv[1] && (process.argv[1].endsWith("cli.js") || process.argv[1].endsWith("cli.ts"))) {
  main();
}
