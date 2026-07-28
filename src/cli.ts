#!/usr/bin/env node
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import { loadConfig, type Config, type ConfigOverrides } from "./config.js";
import { createProxy } from "./server.js";
import { ModelCatalog } from "./catalog.js";
import { currentVersion, ensureUpToDate, shouldCheckUpdates } from "./self-update.js";

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
  llm-relay [options]                              Start the proxy server (default)
  llm-relay onboard                                Guided setup for 100%-free providers & subscriptions
  llm-relay setup [claude-cli|claude-desktop]     Configure Claude CLI wrappers or Claude Desktop
  llm-relay keys | check-keys                      Check status of all free & subscription keys
  llm-relay telemetry                              Programmatic JSON metrics and quota report
  llm-relay models [-p <name>] [-r]               List live models per provider
  llm-relay ping [-p <name>]                       Probe model latency, stability & quota across providers
  llm-relay help | --help | -h                     Show this help documentation
  llm-relay version | --version | -v               Show version number

Commands:
  (default)                                        Start loopback HTTP proxy server
  onboard                                          Run 100%-free provider onboarding wizard
  setup claude-cli                                 Verify & configure Claude CLI wrapper scripts
  setup claude-desktop | setup desktop             Auto-patch Claude Desktop config (claude_desktop_config.json)
  keys | check-keys                                Validate provider API keys & display signup links
  telemetry                                        Output JSON telemetry & quota report
  models                                           Query live /models catalog across providers
  ping                                             Probe model latency, stability & quota metrics
  help                                             Show help documentation
  version                                          Print package version

Options:
  -c, --config <path>                              Config file (default: ~/.llm-relay/config.json)
  -p, --provider <name>                            Filter models/ping command to a specific provider
  -r, --refresh                                    Force cache refresh when querying provider models

Version currency:
  Every run (except help/version) checks the npm registry — cached 6h, 2.5s timeout, fail-open.
  A globally-installed copy updates itself, prunes stale bin shims, and restarts on the new
  version; any other copy just prints the upgrade command. Set LLM_RELAY_NO_SELF_UPDATE=1 to
  skip the check entirely.

Proxy Startup Overrides (win over config file values):
  -d, --default <provider/model>                   Override routing.default fallback spec
  -m, --mode <detect|repair|strict>                Override mode (detect | repair | strict)
  -l, --listen <host:port>                         Override listen address (loopback only)

Proxy Server Endpoints:
  POST /v1/messages                                Anthropic Messages proxy with tool repair
  POST /v1/messages/count_tokens                   Local token estimation for OpenAI backends
  POST /v1/chat/completions                        OpenAI-compatible front (OpenAI in, OpenAI out)
  GET /registry                                    Full JSON view of providers, routing & capabilities
  GET /telemetry                                   Live JSON telemetry, quota & stability scores for Claude
  GET /ping                                        Trigger health probe pass & query ping mode summary
  GET /health                                      Diagnostic JSON summary of provider availability & health
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
    for (const m of models) {
      const scores = getBenchmarkScores(m);
      const quality = calculateQualityScore(scores);
      const benchStr = scores.sweBench ? ` (SWE-bench: ${scores.sweBench}%, quality: ${quality})` : "";
      process.stdout.write(`  ${m.padEnd(50)}${benchStr}\n`);
    }
  }
}

/**
 * Warm every provider's catalog and warn about any routing target the provider
 * does not serve — non-blocking (fire-and-forget) so it never delays listen().
 */
export async function warmAndValidate(cfg: Config, catalog: ModelCatalog): Promise<void> {
  const rawSpecs = [cfg.routing.default, ...Object.values(cfg.routing.tiers)];
  const specs: string[] = [];
  for (const s of rawSpecs) {
    if (Array.isArray(s)) specs.push(...s);
    else if (typeof s === "string") specs.push(s);
  }

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
    const addr = server.address();
    const boundPort = typeof addr === "object" && addr !== null ? addr.port : cfg.port;
    process.stderr.write(
      `llm-relay listening on http://${cfg.host}:${boundPort} ` +
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

import { PingLoop } from "./ping/cadence.js";

/** `llm-relay ping` — probe and output model stability, latency, and quota across providers. */
export async function runPingCommand(): Promise<void> {
  const cfg = loadOrExit();
  const catalog = new ModelCatalog();
  const pingLoop = new PingLoop(cfg, catalog);
  const only = argValue("--provider", "-p");

  process.stdout.write("⚡ Probing models across providers for latency and stability...\n");
  await pingLoop.tickOnce();

  const names = Object.keys(cfg.providers).filter((n) => !only || n === only);
  for (const name of names) {
    const p = cfg.providers[name]!;
    let models: string[] = [];
    if (p.kind === "openai") {
      try {
        models = await catalog.list(name, p);
      } catch {}
    }

    const quota = pingLoop.getProviderQuota(name);
    const quotaStr = quota !== null ? `${quota}% remaining` : "N/A";
    process.stdout.write(`\nProvider: ${name} (quota: ${quotaStr})\n`);
    if (models.length === 0) {
      process.stdout.write("  (no models listed or reachable)\n");
      continue;
    }

    for (const mId of models.slice(0, 10)) {
      const summary = pingLoop.getModelSummary(name, mId);
      const avgStr = summary.avgMs >= 0 ? `${summary.avgMs}ms` : "pending";
      const p95Str = summary.p95Ms >= 0 ? `${summary.p95Ms}ms` : "pending";
      const scoreStr = summary.stabilityScore >= 0 ? `${summary.stabilityScore}/100` : "N/A";
      process.stdout.write(
        `  ${mId.padEnd(45)} | verdict: ${summary.verdict.padEnd(10)} | avg: ${avgStr.padEnd(8)} | p95: ${p95Str.padEnd(8)} | stability: ${scoreStr}\n`,
      );
    }
  }
}

import { validateProviderKeys } from "./key-checker.js";
import { getBenchmarkScores, calculateQualityScore } from "./benchmarks.js";

/** `llm-relay check-keys` — pre-flight verification of provider environment keys. */
export async function runCheckKeys(): Promise<void> {
  const cfg = loadOrExit();
  process.stdout.write("🔑 Validating configured provider API keys...\n\n");
  const results = await validateProviderKeys(cfg);

  process.stdout.write(
    `Provider`.padEnd(16) +
      `Env Var`.padEnd(24) +
      `Status`.padEnd(16) +
      `Details\n`,
  );
  process.stdout.write("-".repeat(80) + "\n");

  for (const r of results) {
    const envStr = r.authEnv ?? "(none)";
    const quotaStr = r.quotaPercent !== undefined && r.quotaPercent !== null ? ` | Quota: ${r.quotaPercent}%` : "";
    const modelsStr = r.modelsFound !== undefined ? ` | Models: ${r.modelsFound}` : "";

    process.stdout.write(
      `${r.provider.padEnd(16)}${envStr.padEnd(24)}${r.status.toUpperCase().padEnd(16)}${r.message}${quotaStr}${modelsStr}\n`,
    );
  }
}

import { runInteractiveOnboarding, printOnboardingGuide } from "./onboarding.js";
import { setupClaudeCli, setupClaudeDesktop } from "./setup-claude.js";
import { getTelemetryReport } from "./telemetry.js";
import { globalCircuitBreaker } from "./circuit-breaker.js";

export function main(): void {
  const arg2 = process.argv[2];
  const arg3 = process.argv[3];

  if (hasFlag("--help", "-h") || arg2 === "help") {
    process.stdout.write(HELP);
    process.exit(0);
  }
  if (hasFlag("--version", "-v") || arg2 === "version") {
    process.stdout.write(`${currentVersion()}\n`);
    process.exit(0);
  }
  if (arg2 === "onboard") {
    const cfg = loadOrExit();
    runInteractiveOnboarding(cfg).catch((e) => {
      process.stderr.write(`llm-relay onboard: ${(e as Error).message}\n`);
      process.exit(1);
    });
    return;
  }
  if (arg2 === "setup") {
    if (arg3 === "claude-desktop" || arg3 === "desktop") {
      const res = setupClaudeDesktop();
      process.stdout.write(`${res.message}\n`);
    } else {
      setupClaudeCli();
    }
    return;
  }
  if (arg2 === "telemetry") {
    const cfg = loadOrExit();
    const report = getTelemetryReport(cfg, globalCircuitBreaker);
    process.stdout.write(JSON.stringify(report, null, 2) + "\n");
    return;
  }
  if (arg2 === "keys" || arg2 === "check-keys") {
    runCheckKeys().catch((e) => {
      process.stderr.write(`llm-relay check-keys: ${(e as Error).message}\n`);
      process.exit(1);
    });
    return;
  }
  if (arg2 === "models") {
    runModels().catch((e) => {
      process.stderr.write(`llm-relay: ${(e as Error).message}\n`);
      process.exit(1);
    });
    return;
  }
  if (arg2 === "ping" || hasFlag("--ping")) {
    runPingCommand().catch((e) => {
      process.stderr.write(`llm-relay ping: ${(e as Error).message}\n`);
      process.exit(1);
    });
    return;
  }
  runProxy();
}

/**
 * Entrypoint: currency gate first (may replace this install and re-exec), then
 * the command itself. `main` stays synchronous so its exit paths are direct.
 */
export async function run(): Promise<void> {
  if (shouldCheckUpdates(process.argv, process.env)) {
    try {
      await ensureUpToDate();
    } catch (e) {
      process.stderr.write(`llm-relay: update check skipped (${(e as Error).message})\n`);
    }
  }
  main();
}

if (process.argv[1] && (process.argv[1].endsWith("cli.js") || process.argv[1].endsWith("cli.ts"))) {
  void run();
}
