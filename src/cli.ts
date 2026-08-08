#!/usr/bin/env node
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import {
  loadConfig,
  splitSpec,
  unroutableOffloadClient,
  type Config,
  type ConfigOverrides,
  DEFAULT_DESTRUCTIVE,
  FRONT_DOOR_CLIENTS,
  CLAUDE_CLIENT,
} from "./config.js";
import { loadEnvFile } from "./dotenv.js";
import { recoverWindowsEnv } from "./winenv.js";
import { offloadState, setOffload, type OffloadState } from "./offload.js";
import { buildCandidates, type CandidatesView, type Candidate } from "./candidates.js";
import { buildDispatch, normalizeCliCommand, specContextWindow, CONTEXT_TOKEN, type DispatchLane, type DispatchView } from "./dispatch.js";
import { detectHostRouting, parseHostRoutingState, type HostRoutingState } from "./host-routing.js";
import { contextWindowResolver } from "./metadata.js";
import { snapshotContextWindow } from "./tier-data.js";
import { installAgentHook, removeAgentHook, agentHookInstalled } from "./claude-hook.js";
import { createProxy } from "./server.js";
import { ModelCatalog } from "./catalog.js";
import { materializeDynamicPools } from "./dynamic-pools.js";
import { currentVersion, ensureUpToDate, shouldCheckUpdates, type CommandEffect } from "./self-update.js";
import {
  deleteConfigPath,
  parseConfigValue,
  readConfigDocument,
  readConfigPath,
  updateConfigDocument,
  writeConfigPath,
} from "./config-edit.js";
import { createControlAuthorization, resolveControlAuthorizationConfigDir } from "./control-authorization.js";
import { flushRuntimeTelemetry } from "./ping/runtime-telemetry.js";
import { flushProbeCache } from "./ping/probe-cache.js";

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

const VALUE_FLAGS = new Set<string>([
  '--config', '-config', '-c',
  '--provider', '-provider', '-p',
  '--default', '-default', '-d',
  '--mode', '-mode', '-m',
  '--listen', '-listen', '-l',
  '--task', '-task', '-t',
  '--exhausted', '-exhausted', '-x',
  '--outcome', '-outcome',
  '--retry-after-ms', '-retry-after-ms',
  '--after', '-after',
  '--lane', '-lane',
  '--tier', '-tier',
  // ⚠ A value-taking flag MUST be listed here or its value is read as a positional. `--host
  // routed` was parsed as the positional lane id "routed" and reported as a missing lane.
  '--host', '-host',
  '--client', '-client',
  '--scope', '-scope',
  '--include', '-include',
  '--effort', '-effort',
  '--shell', '-shell',
]);

/** Extract non-flag positional arguments from an argv array, skipping flags and their values. */
export function getPositionalArgs(argv: string[] = process.argv): string[] {
  const positionals: string[] = [];
  let i = 2;
  while (i < argv.length) {
    const arg = argv[i];
    if (!arg) {
      i++;
      continue;
    }
    if (arg.startsWith('-')) {
      if (arg.includes('=')) {
        i += 1;
      } else if (VALUE_FLAGS.has(arg)) {
        i += 2;
      } else {
        i += 1;
      }
    } else {
      positionals.push(arg);
      i += 1;
    }
  }
  return positionals;
}

type TableCell = string | readonly string[];
type TableRow = readonly TableCell[];

/** Keep a long provider/model name from pushing the rest of a terminal row sideways. */
function fitCell(value: string, width: number): string {
  if (value.length <= width) return value.padEnd(width);
  if (width <= 1) return value.slice(0, width);
  return `${value.slice(0, width - 1)}…`;
}

function formatTextTable(rows: readonly TableRow[], indent = ""): string {
  if (rows.length === 0) return "";
  const columnCount = Math.max(...rows.map((row) => row.length));
  const linesFor = (cell: TableCell | undefined): readonly string[] =>
    cell === undefined ? [""] : typeof cell === "string" ? [cell] : cell;
  const widths = Array.from({ length: columnCount }, (_, column) =>
    Math.max(...rows.map((row) => Math.max(...linesFor(row[column]).map((line) => line.length), 0))),
  );

  return rows
    .flatMap((row) => {
      const cells = Array.from({ length: columnCount }, (_, column) => linesFor(row[column]));
      const lineCount = Math.max(...cells.map((cell) => cell.length));
      return Array.from({ length: lineCount }, (_, line) =>
        `${indent}${cells
          .map((cell, column) => {
            const value = cell[line] ?? "";
            return column === columnCount - 1 ? value : value.padEnd(widths[column]!);
          })
          .join("  ")
          .trimEnd()}`,
      );
    })
    .join("\n");
}

const HELP = `llm-relay — loopback Anthropic/OpenAI proxy: routes models across providers, repairs tool calls.

Usage:
${formatTextTable([
  ["llm-relay [options]", "Start proxy."],
  ["llm-relay onboard", "Set up provider keys."],
  ["llm-relay setup [target]", "target: claude-cli | claude-desktop."],
  ["llm-relay keys | check-keys", "Check provider keys."],
  ["llm-relay pools [--probe]", "List pool members; --probe tests each."],
  ["llm-relay pools <action> <name> [<spec>...]", "action: set|add|remove|delete."],
  ["llm-relay routing <action> ...", "action: show|get|default|tier|subagent|sort|benchmark|set|unset."],
  ["llm-relay config <action> [<path>] [<value>]", "action: show|get|set|unset."],
  ["llm-relay models [-p <name>] [-r]", "List provider models."],
  ["llm-relay ping [-p <name>]", "Probe providers."],
  ["llm-relay telemetry", "Print telemetry/quota JSON."],
  ["llm-relay offload [status]", "Show current offload rules."],
  ["llm-relay offload <harness> <on|off> [--scope <scope>]", "Toggle one harness (claude | codex); scope: subagents | all."],
  ["llm-relay candidates [-p <name>]", "Compare offload targets."],
  ["llm-relay dispatch [lane] [options]", "Choose next dispatch lane; adapts to the calling host."],
  ["llm-relay dispatch --next-command -t <task>", "Print only the runnable command for the next lane."],
  ["llm-relay help | --help | -h", "Show help."],
  ["llm-relay version | --version | -v", "Print version."],
], "  ")}

Model routing (first match wins):
${formatTextTable([
  ["pool/<name>", "Ranked pool with failover."],
  ["provider/model", "Exact target; never reranked."],
  ["Claude model id", "Matches opus|sonnet|haiku|fable tiers."],
  ["anything else", "Uses routing.default."],
], "  ")}
  An anthropic provider without authEnv forwards the caller's own credentials — use it to keep
  Claude traffic on real Anthropic while pool/* requests use other providers.

Offload is off by default. To route one subagent call without turning it on, put
"@relay: <spec>" on its own line at the start of the subagent prompt (the relay strips it).

If this host's traffic does not reach the relay (Claude Desktop pins its own base URL), no
subagent can be rerouted and "@relay:" is inert. "llm-relay dispatch" detects that and hands
back runnable commands instead; "offload claude on" there also installs a PreToolUse(Agent)
hook that redirects Agent() calls to the same lane. "offload claude off" removes it.

Setup checks: "llm-relay keys" verifies credentials; "llm-relay pools --probe" sends a real
completion to every pool model. Environment variables override ~/.llm-relay/.env.

Dispatch options:
${formatTextTable([
  ["--client <name>", "Offload client for routing hints."],
  ["--tier <name>", "Ladder: low|medium|high|xhigh."],
  ["-t, --task <task>", "Task text for the selected lane."],
  ["--after <lane>", "Skip past this lane."],
  ["-x, --exhausted <lane>", "Mark this lane spent."],
  ["--outcome <kind>", "With -x: rate_limited (15m) or quota_exhausted (1h)."],
  ["--retry-after-ms <n>", "With -x: vendor-stated reset; beats the outcome default."],
  ["--shell sh|pwsh", "Quote for sh or PowerShell."],
  ["--host <state>", "Override host detection: routed|bypassed|unknown."],
  ["--next-command", "Print only the runnable command for the next lane."],
  ["--json", "Print JSON."],
], "  ")}

General options:
${formatTextTable([
  ["-c, --config <path>", "Config path."],
  ["-p, --provider <name>", "Filter provider."],
  ["-r, --refresh", "Refresh catalog."],
  ["--json", "Print JSON where supported."],
], "  ")}

Pool options:
${formatTextTable([
  ["--probe", "Test each pool member."],
  ["--free | --include free", "Append discovered free models."],
  ["--effort <level>", "Floor: low|medium|high|xhigh."],
], "  ")}

Routing options:
${formatTextTable([
  ["--clear", "Remove a tier or subagent."],
], "  ")}

Startup overrides:
${formatTextTable([
  ["-d, --default <provider/model>", "Override routing.default."],
  ["-m, --mode <detect|repair|strict>", "Validation mode."],
  ["-l, --listen <host:port>", "Loopback address."],
], "  ")}

Self-update: npm check except help/version; cached 6h, timeout 2.5s. Set
LLM_RELAY_NO_SELF_UPDATE=1 to disable.

Claude Code: custom ANTHROPIC_BASE_URL disables the 1M beta header and Remote Control. For 1M:
  ANTHROPIC_MODEL='claude-opus-5[1m]' claude

Proxy server endpoints:
${formatTextTable([
  ["POST /v1/messages", "Anthropic API; validates/repairs tool calls."],
  ["POST /v1/messages/count_tokens", "Local token count."],
  ["POST /v1/chat/completions", "OpenAI Chat API."],
  ["POST /v1/responses", "OpenAI Responses API."],
  ["GET /registry", "Provider/routing metadata."],
  ["GET /candidates", "Offload target data."],
  ["GET|POST /offload", "Read/set rules; accepts ?client=<name>."],
  ["GET|POST /dispatch", "Read/set next lane; POST {\"exhausted\":\"<lane>\"}."],
  ["GET /telemetry", "Telemetry and quota."],
  ["GET /ping", "Run health probe."],
  ["GET /health", "Provider health."],
], "  ")}
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
      default: "pool/medium",
      tiers: {
        opus: "pool/xhigh",
        fable: "pool/xhigh",
        sonnet: "pool/high",
        haiku: "pool/medium",
      },
      // Addressable as `model: pool/<name>` — including from subagent frontmatter, which only
      // accepts a single string and so cannot express a candidate list on its own.
      pools: {
        low: { preferred: [], include: "free", effort: "low" },
        medium: { preferred: [], include: "free", effort: "medium" },
        high: { preferred: [], include: "free", effort: "high" },
        xhigh: { preferred: [], include: "free", effort: "xhigh" },
      },
      // Where marked subagents (and, with scope "all", conversations) go when offload is on.
      subagents: {
        opus: "pool/xhigh",
        fable: "pool/xhigh",
        sonnet: "pool/high",
        haiku: "pool/medium",
        default: "pool/medium",
      },
      // Per-originating-harness switches, all off by default. `scope: "all"` also reroutes the
      // main conversation; omit it or use "subagents" to preserve the current topology.
      offload: {
        claude: { enabled: false, scope: "subagents" },
        codex: { enabled: false, scope: "subagents" },
      },
    },
    mode: "repair",
    repair: {
      maxAttempts: 2,
      destructiveTools: [...DEFAULT_DESTRUCTIVE],
    },
    log: { level: "metadata", file: null },
  },
  null,
  2,
);

export { splitSpec };

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

let envFileLoaded = false;

/**
 * Merge every credential source into the environment, once per process, before anything reads a
 * key or expands a `${ENV}` in the config. Already-set variables always win, at every layer.
 *
 * Order is least-explicit first, and both layers only ever FILL GAPS:
 *   1. Windows User/Machine registry scopes — recovers variables the OS could not deliver to an
 *      already-running process. A long-lived relay launched at logon otherwise never sees a key
 *      added afterwards, while every shell the user opens does; that mismatch made six working
 *      credentials look like `401 Wrong API Key`.
 *   2. `~/.llm-relay/.env` — what the onboarding wizard writes.
 */
export function ensureEnvFileLoaded(): void {
  if (envFileLoaded) return;
  envFileLoaded = true;
  recoverWindowsEnv();
  loadEnvFile();
}

export function loadOrExit(): Config {
  ensureEnvFileLoaded();
  const configPath = resolveConfigPath();
  const overrides: ConfigOverrides = {
    routeDefault: argValue("--default", "-d"),
    mode: argValue("--mode", "-m"),
    listen: argValue("--listen", "-l"),
  };
  try {
    const cfg = loadConfig(configPath, overrides);
    for (const w of cfg.warnings ?? []) {
      process.stderr.write(`llm-relay: ⚠ ${w}\n`);
    }
    return cfg;
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
      const s = getStrength(`${name}/${m}`);
      // Only say something when there is evidence; a neutral placeholder is not information.
      const str = s.basis === "snapshot"
        ? ` capability ${s.score.toFixed(1)} (raw ${s.rawScore.toFixed(1)}, ${s.signalCount} signals)`
        : "";
      const lim = await catalog.limits(name, p, m).catch(() => null);
      const ctx = lim?.contextLength ? `  ctx ${Math.round(lim.contextLength / 1000)}k` : "";
      const out = lim?.maxOutputTokens ? `  max_out ${lim.maxOutputTokens}` : "";
      process.stdout.write(`  ${fitCell(m, 50)}${str}${ctx}${out}\n`);
    }
  }
}

/**
 * Warm every provider's catalog and warn about any routing target the provider
 * does not serve — non-blocking (fire-and-forget) so it never delays listen().
 */
export async function warmAndValidate(cfg: Config, catalog: ModelCatalog): Promise<void> {
  // Start from the persisted catalog so routing/probing has a concrete roster immediately.
  materializeDynamicPools(cfg, catalog);

  const warm = new Set<string>();
  const addSpec = (spec: string) => {
    if (spec.startsWith("pool/")) {
      for (const member of cfg.routing.pools?.[spec.slice("pool/".length)] ?? []) addSpec(member);
      return;
    }
    const { provider } = splitSpec(spec);
    if (cfg.providers[provider]?.kind === "openai") warm.add(provider);
  };
  for (const value of [
    cfg.routing.default,
    ...Object.values(cfg.routing.tiers),
    ...Object.values(cfg.routing.pools ?? {}),
    ...Object.values(cfg.routing.subagents ?? {}),
  ]) {
    for (const spec of Array.isArray(value) ? value : [value]) addSpec(spec);
  }
  // Only free/mixed catalogs can contribute a dynamic tail without already being explicitly
  // routed. Subscription providers are warmed when a static target actually references them.
  if (Object.keys(cfg.routing.poolPolicies ?? {}).length > 0) {
    for (const [name, p] of Object.entries(cfg.providers)) {
      if (p.kind === "openai" && (p.tierType === "free" || p.tierType === "mixed")) warm.add(name);
    }
  }

  await Promise.all(
    [...warm].map(async (name) => {
      const p = cfg.providers[name]!;
      await catalog.list(name, p);
    }),
  );
  materializeDynamicPools(cfg, catalog);

  // Pools and subagent targets are the offload path — they need this warning at least as
  // much as tiers do. `pool/<name>` refs skip harmlessly below (no provider named "pool");
  // their members are covered via routing.pools.
  const rawSpecs = [
    cfg.routing.default,
    ...Object.values(cfg.routing.tiers),
    ...Object.values(cfg.routing.pools ?? {}),
    ...Object.values(cfg.routing.subagents ?? {}),
  ];
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
    server.close(() => {
      // Write-behind caches trade a bounded crash window for a quiet request path. Graceful
      // shutdown closes that window explicitly.
      catalog.flushPersistence();
      flushRuntimeTelemetry();
      flushProbeCache();
      process.exit(0);
    });
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
      } catch (error) {
        void error;
      }
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
        `  ${fitCell(mId, 45)} | verdict: ${fitCell(summary.verdict, 10)} | avg: ${fitCell(avgStr, 8)} | p95: ${fitCell(p95Str, 8)} | stability: ${scoreStr}\n`,
      );
    }
  }
}

import { validateProviderKeys } from "./key-checker.js";
import { getStrength } from "./benchmarks.js";

/** `llm-relay check-keys` — pre-flight verification of provider environment keys. */
export async function runCheckKeys(): Promise<void> {
  const cfg = loadOrExit();
  process.stdout.write("🔑 Validating configured provider API keys...\n\n");
  const results = await validateProviderKeys(cfg);

  const rows = [
    ["Provider", "Env var", "Status", "Details"],
    ...results.map((r) => {
      const envStr = r.authEnv ?? "(none)";
      const quotaStr = r.quotaPercent !== undefined && r.quotaPercent !== null ? ` | Quota: ${r.quotaPercent}%` : "";
      const modelsStr = r.modelsFound !== undefined ? ` | Models: ${r.modelsFound}` : "";
      return [r.provider, envStr, r.status.toUpperCase(), `${r.message}${quotaStr}${modelsStr}`];
    }),
  ];
  process.stdout.write(formatTextTable(rows) + "\n");
}

/**
 * Talk to a RUNNING proxy if there is one. The offload switch has to reach the live process to
 * take effect without a restart, and `candidates` gets better data from it (warm ping history,
 * real breaker state) than a cold CLI process can compute. null = no proxy listening.
 */
async function tryServer(cfg: Config, path: string, init?: RequestInit): Promise<unknown | null> {
  try {
    const headers = new Headers(init?.headers);
    try {
      const authorization = createControlAuthorization(resolveControlAuthorizationConfigDir(cfg.sourcePath));
      const attached = authorization.attach(Object.fromEntries(headers.entries()));
      for (const [name, value] of Object.entries(attached)) headers.set(name, value);
    } catch {
      // Tokenless status routes remain reachable. Protected routes fail closed at
      // the server, and the caller's existing no-live-proxy fallback remains intact.
    }
    const res = await fetch(proxyUrl(cfg, path), {
      ...init,
      headers,
      signal: AbortSignal.timeout(5000),
    });
    if (!res.ok) return null;
    return await res.json();
  } catch {
    return null;
  }
}

/** Render a normalized listener address as an HTTP URL, including required IPv6 brackets. */
export function proxyUrl(cfg: Pick<Config, "host" | "port">, path: string): string {
  const host = cfg.host.includes(":") ? `[${cfg.host}]` : cfg.host;
  return `http://${host}:${cfg.port}${path}`;
}

/**
 * What actually comes back from `GET /dispatch` — which is NOT necessarily a `DispatchView`.
 * The proxy answering may be an older build than this CLI (they are separate processes with
 * separate lifetimes; the relay runs for days). Fields this CLI requires can therefore be absent
 * on the wire, and typing the response as the current shape would assert a guarantee the other
 * process never made.
 */
export type WireDispatchView = Omit<DispatchView, "host"> & { host?: DispatchView["host"] };

/** Normalize structured output from an older live proxy before exposing it to this host. */
export function normalizeDispatchCommands(
  view: WireDispatchView,
  platform: NodeJS.Platform = process.platform,
): DispatchView {
  const normalizeLane = (lane: DispatchLane): DispatchLane =>
    lane.invoke
      ? { ...lane, invoke: { ...lane.invoke, command: normalizeCliCommand(lane.invoke.command, platform) } }
      : { ...lane };
  return {
    ...view,
    // An older proxy said nothing about the calling host, which is exactly "unknown" — the state
    // whose behaviour predates this field. Never inferred from the caller's own verdict here:
    // that would label the answer with a question the answerer was never asked.
    host: view.host ?? "unknown",
    ladder: view.ladder.map(normalizeLane),
    next: view.next ? normalizeLane(view.next) : null,
  };
}

/** Which shell's literal-quoting rules a rendered command line is written for. */
export type RenderShell = "sh" | "pwsh";

/** Human name for the shell a line was quoted for. Precise on purpose — see `quoteArg`. */
export const SHELL_LABEL: Record<RenderShell, string> = {
  sh: "sh/bash",
  pwsh: "PowerShell 7+ (pwsh)",
};

/**
 * The shell a host on `platform` is going to paste a rendered command into.
 *
 * A guess, and it can be wrong in a way that matters: Git Bash on Windows is `sh`, not
 * PowerShell. `--shell` overrides it, which is why `parseRenderShell` exists.
 */
export function shellFor(platform: NodeJS.Platform = process.platform): RenderShell {
  return platform === "win32" ? "pwsh" : "sh";
}

/** `--shell sh|pwsh`. An unrecognised value is a loud error, never a silent default. */
export function parseRenderShell(value: string | undefined): RenderShell | null {
  if (value === undefined) return null;
  const v = value.trim().toLowerCase();
  if (v === "sh" || v === "bash" || v === "posix") return "sh";
  if (v === "pwsh" || v === "powershell") return "pwsh";
  process.stderr.write(`llm-relay dispatch: --shell expects "sh" or "pwsh" (got "${value}")\n`);
  process.exit(1);
}

/**
 * Characters that need no quoting in EITHER shell rendered for. An ALLOW-list, so a character
 * nobody thought about is quoted rather than passed through. `@` and `%` are deliberately
 * absent even though `sh` treats them as ordinary: `@` leads PowerShell splatting and `%` is
 * cmd.exe variable expansion, and this line gets pasted into whatever the operator is running.
 */
const SHELL_SAFE_PWSH = /^[A-Za-z0-9_+=:,./\\-]+$/;
const SHELL_SAFE_SH = /^[A-Za-z0-9_+=:,./-]+$/;

/** C0 + C1 control characters except tab and newline. ESC — the ANSI carrier — is among them. */
function sanitizeRenderedArgument(value: string): string {
  let out = "";
  for (let i = 0; i < value.length; i++) {
    const code = value.charCodeAt(i);
    out += (code >= 0 && code <= 0x1f && code !== 0x09 && code !== 0x0a && code !== 0x0d) || (code >= 0x7f && code <= 0x9f)
      ? "\uFFFD"
      : value[i]!;
  }
  return out;
}

/**
 * Quote ONE argv element so it stays exactly one argv element.
 *
 * `llm-relay dispatch` prints a command line the host is told to run verbatim, and the task
 * text inside it is caller-supplied (`--task`, or `?task=` on a proxy that answered). This used
 * to render `args.join(" ")`, so a task containing a space, a quote or a `&` broke out into
 * extra shell words and `-t "fix the bug & rm -rf /"` printed a line with a second command in
 * it. `dispatch.ts` deliberately hands over `{ command, args }` and never a pre-joined string —
 * quoting is this renderer's job, and it is the only place that can know which shell.
 *
 * Both forms below are LITERAL: `sh` performs no expansion of any kind inside single quotes,
 * and neither does PowerShell, so the content cannot be re-parsed whatever it contains.
 *  - `sh`   — `'…'`; an embedded `'` closes, escapes, reopens: `'\''`.
 *  - `pwsh` — `'…'`; an embedded `'` is doubled: `''`.
 *
 * ⚠ `pwsh` means **PowerShell 7+**, and the version is load-bearing, not pedantry. Measured on
 * this platform: Windows PowerShell 5.1 does not escape an embedded `"` when it builds the
 * command line for a native executable, so `'a " b " c'` — correctly single-quoted, one PS
 * string — reaches the program as THREE argv elements (`a `, `b`, ` c`). pwsh 7.6 passes it as
 * one. No single-quoting can fix 5.1: the split happens after PowerShell is done parsing, and
 * the 5.1 workaround (writing `\"` inside the string) is itself wrong under 7.x. The two are
 * irreconcilable in one rendering, so this targets 7+, `SHELL_LABEL` names the version out
 * loud, and `--shell sh` is the way out for anyone pasting somewhere else (Git Bash included).
 */
export function quoteArg(arg: string, shell: RenderShell = shellFor()): string {
  // This is printed to a terminal before it is run, so an ESC sequence in the task could
  // otherwise rewrite what the operator sees they are about to execute — the same reason
  // `dispatch.ts` scrubs an echoed lane id. Tab and newline survive: both are legal inside
  // either literal form and a multi-line task is a real thing, not an attack.
  const clean = sanitizeRenderedArgument(arg);
  const safeRegex = shell === "pwsh" ? SHELL_SAFE_PWSH : SHELL_SAFE_SH;
  if (clean.length > 0 && safeRegex.test(clean)) return clean;
  return shell === "pwsh" ? `'${clean.replace(/'/g, "''")}'` : `'${clean.replace(/'/g, "'\\''")}'`;
}

/**
 * A PowerShell single-quoted literal, ALWAYS quoted. `quoteArg` leaves shell-safe strings bare,
 * which is right for argv elements and wrong in expression position: `$env:X = abc` is not an
 * assignment of the string "abc", it is a parse error. Same literal form, same control scrub.
 */
function pwshLiteral(value: string): string {
  return `'${sanitizeRenderedArgument(value).replace(/'/g, "''")}'`;
}

/**
 * Render a cli rung's `{ command, args }` as a runnable line. Every element is quoted FIRST and
 * only the quoted forms are joined — never `args.join(" ")`, which is the defect this replaces.
 *
 * A quoted command NAME is not a command in PowerShell (`'agy' -p x` evaluates a string and
 * throws the rest away), so a command that needed quoting gets the call operator in front of it.
 *
 * A rung's `env` renders as part of the same line: `env -u UNSET NAME=value cmd …` for `sh`,
 * and `Remove-Item Env:UNSET …; $env:NAME = 'value'; cmd …` for PowerShell. The PowerShell form
 * mutates the calling session's environment rather than scoping to the child — PowerShell has no
 * `env(1)` equivalent, and the wrapper scripts this replaces (`scripts/claude-proxied.ps1`) have
 * always done the same. Variable NAMES are interpolated bare in both forms; they are safe because
 * config load rejects names containing `=`, whitespace or control characters, and they read
 * better than a quoted form that suggests they might be data.
 */
export function renderCommand(
  invoke: { command: string; args: string[]; env?: Record<string, string | null> } | undefined,
  shell: RenderShell = shellFor(),
): string {
  if (!invoke) return "";
  // A live proxy may be older than this CLI and still return bare `agy` in structured output.
  // Normalize for the target shell as a second line of defence; dispatch.ts owns the primary
  // platform-aware normalization so JSON consumers receive the safe executable name too.
  const command = normalizeCliCommand(invoke.command, shell === "pwsh" ? "win32" : "linux");
  const cmd = quoteArg(command, shell);
  const head = cmd === command || shell === "sh" ? cmd : `& ${cmd}`;
  const line = [head, ...invoke.args.map((a) => quoteArg(a, shell))].join(" ");

  const env = invoke.env ?? {};
  const unsets = Object.keys(env).filter((name) => env[name] === null);
  const sets = Object.entries(env).filter((entry): entry is [string, string] => entry[1] !== null);
  if (unsets.length === 0 && sets.length === 0) return line;

  if (shell === "sh") {
    return ["env", ...unsets.map((name) => `-u ${name}`), ...sets.map(([name, value]) => quoteArg(`${name}=${value}`, shell)), line].join(" ");
  }
  return [
    ...unsets.map((name) => `Remove-Item Env:${name} -ErrorAction SilentlyContinue`),
    ...sets.map(([name, value]) => `$env:${name} = ${pwshLiteral(value)}`),
    line,
  ].join("; ");
}

/**
 * `llm-relay dispatch [lane]` — which lane to hand a delegated task to next.
 *
 * Prefers a running proxy so the answer reflects live exhaustion state reported by whichever
 * host last walked the ladder; falls back to a cold local read, which is still correct about
 * order and configuration but knows nothing about what is currently spent.
 */
export async function runDispatch(arg: string | undefined): Promise<void> {
  const cfg = loadOrExit();
  const task = argValue("--task", "-t");
  const spent = argValue("--exhausted", "-x");
  const after = argValue("--after");
  const lane = arg && !arg.startsWith("-") ? arg : argValue("--lane");
  const tier = argValue("--tier");
  const client = argValue("--client");
  const outcome = argValue("--outcome");
  const retryAfterRaw = argValue("--retry-after-ms");

  // Whether the CALLING session's traffic reaches this relay. Detected from this process's
  // environment — the CLI is a child of that session and inherits it — and then FORWARDED to the
  // proxy, which cannot work it out for itself. `--host` overrides for testing and for a host
  // whose wiring this cannot see.
  const hostOverrideRaw = argValue("--host");
  const hostOverride = hostOverrideRaw === undefined ? null : parseHostRoutingState(hostOverrideRaw);
  if (hostOverrideRaw !== undefined && hostOverride === null) {
    process.stderr.write(`llm-relay dispatch: --host expects "routed", "bypassed" or "unknown" (got "${hostOverrideRaw}")\n`);
    process.exit(1);
  }
  const detected = detectHostRouting();
  const hostRouting = hostOverride
    ? { state: hostOverride, entrypoint: detected.entrypoint, reason: `--host ${hostOverride} (host override)` }
    : detected;

  if (outcome !== undefined && outcome !== "rate_limited" && outcome !== "quota_exhausted") {
    process.stderr.write(`llm-relay dispatch: --outcome must be rate_limited or quota_exhausted (got "${outcome}")\n`);
    process.exit(1);
  }
  const retryAfterMs = retryAfterRaw !== undefined ? Number(retryAfterRaw) : undefined;

  if (spent) {
    const live = await tryServer(cfg, "/dispatch", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        exhausted: spent,
        ...(tier ? { tier } : {}),
        ...(client ? { client } : {}),
        ...(outcome ? { outcome } : {}),
        ...(retryAfterMs !== undefined && Number.isFinite(retryAfterMs) ? { retryAfterMs } : {}),
      }),
    });
    // Cooldowns are runtime state held by the proxy; with nothing listening there is no
    // process to remember it, and pretending otherwise would silently lose the report.
    if (!live) {
      process.stderr.write(`llm-relay dispatch: no proxy running — "${spent}" not recorded as spent\n`);
      process.exit(1);
    }
  }

  const qs = new URLSearchParams();
  if (task) qs.set("task", task);
  if (lane) qs.set("lane", lane);
  if (after) qs.set("after", after);
  if (tier) qs.set("tier", tier);
  if (client) qs.set("client", client);
  qs.set("host", hostRouting.state);
  if (hostRouting.entrypoint) qs.set("entrypoint", hostRouting.entrypoint);
  const path = `/dispatch${qs.toString() ? `?${qs}` : ""}`;

  // One catalog for the whole render — it reads from disk, so building it per lane lookup would
  // re-read the cache once per pool member. Same on-disk data the proxy uses, so a cold-read
  // answer matches a live one; `cachedLimits` never fetches, so an unwarmed cache simply means no
  // lane carries a window.
  const catalog = new ModelCatalog();
  // ⚠ Dynamic pools (`{ include: "free" }`) are EMPTY until materialized, and the server does this
  // at startup while this path never did — so a `pool/*` rung resolved to zero members here and
  // therefore to no context window, while the same query against the running proxy resolved one.
  // The local fallback is allowed to know less about live state (exhaustion); it must not disagree
  // about configuration. Synchronous and catalog-cache-only, so it costs no round-trip.
  try {
    materializeDynamicPools(cfg, catalog);
  } catch {
    // A pool we cannot materialize simply stays empty — the same degradation as a cold cache.
  }
  const cachedContextWindow = contextWindowResolver(
    (provider, model) => catalog.cachedLimits(provider, model)?.contextLength ?? null,
    snapshotContextWindow,
  );

  const liveRaw = (await tryServer(cfg, path)) as WireDispatchView | null;
  // A proxy predating host-adaptive dispatch ignores `?host=` and answers as though every relay
  // rung were reachable. Its ladder would then quietly advise the subagent path this host cannot
  // use — the exact failure being fixed — so the stale answer is discarded rather than rendered.
  // The cost is live exhaustion state, which the existing "no proxy running" line already covers;
  // trusting the reply would cost correctness, which it does not.
  //
  // A SECOND staleness shape, found the moment this was built: a proxy that understands `?host=`
  // but predates context-window substitution answers the host check correctly and still returns
  // lanes with the variable missing. From the rendered output that is indistinguishable from "the
  // provider published nothing" — the failure would read as a correct result. The discriminator is
  // cheap and exact: both sides resolve the window from the SAME on-disk cache, so if this process
  // can resolve one for a transposed lane and the live answer carries none, the difference is the
  // proxy's code, not the data.
  const hostStale = liveRaw !== null && hostRouting.state !== "unknown" && liveRaw.host !== hostRouting.state;
  const windowStale =
    liveRaw !== null &&
    !hostStale &&
    liveRaw.ladder.some(
      (l) =>
        l.transposed === true &&
        l.contextWindow === undefined &&
        l.spec !== undefined &&
        specContextWindow(l.spec, cfg, cachedContextWindow) !== null,
    );
  const staleProxy = hostStale || windowStale;
  const live = staleProxy ? null : liveRaw;
  const view = normalizeDispatchCommands(
    live ??
      buildDispatch(cfg, {
      ...(task ? { task } : {}),
      ...(lane ? { lane } : {}),
      ...(after ? { after } : {}),
      ...(tier ? { tier } : {}),
      ...(client ? { client } : {}),
      host: hostRouting.state,
      ...(hostRouting.entrypoint ? { entrypoint: hostRouting.entrypoint } : {}),
      publishedContextWindow: cachedContextWindow,
      }),
  );

  if (hasFlag("--json")) {
    process.stdout.write(JSON.stringify(view, null, 2) + "\n");
    return;
  }

  // `--next-command`: the rendered command line for `next`, and nothing else. Exists so a caller
  // that needs something RUNNABLE (the Agent hook, a script) gets exactly that without parsing the
  // human ladder — and, more importantly, without a second copy of the shell-quoting rules, which
  // is the one part of this that is unsafe to reimplement.
  if (hasFlag("--next-command")) {
    const shellOnly = parseRenderShell(argValue("--shell")) ?? shellFor();
    if (!view.next) {
      process.stderr.write(`llm-relay dispatch: ${view.reason}\n`);
      process.exit(1);
    }
    if (!view.next.invoke) {
      // A relay lane is addressed through the proxy, not spawned; there is no command to print
      // and inventing one would be a lie about the mechanism.
      process.stderr.write(`llm-relay dispatch: lane "${view.next.id}" is a relay target (${view.next.spec ?? "?"}), not a command\n`);
      process.exit(2);
    }
    process.stdout.write(renderCommand(view.next.invoke, shellOnly) + "\n");
    return;
  }

  const clientLabel = view.client ?? "default";
  process.stdout.write(`${clientLabel === "default" ? "subagent" : clientLabel} offload: ${view.offload ? "ON" : "OFF"}\n`);
  if (view.tier) process.stdout.write(`dispatch tier: ${view.tier}\n`);
  // State the verdict whenever it changed the answer. Silence here would leave the reader unable
  // to tell a transposed ladder from a hand-written one — and unable to see that "offload: ON"
  // above does not apply to the session they are sitting in.
  if (hostRouting.state === "bypassed") {
    process.stdout.write(`host: ${hostRouting.reason}\n`);
    if (view.offload) {
      process.stdout.write(`      ⚠ subagent offload cannot apply to this session — lanes below are shell-outs\n`);
    }
  }
  if (!live) {
    process.stdout.write(
      staleProxy
        ? `(running proxy is older than this CLI${hostStale ? "" : " (no context-window substitution)"} — restart it; live exhaustion state unknown)\n`
        : `(no proxy running — live exhaustion state unknown)\n`,
    );
  }
  process.stdout.write("\n");

  const shell = parseRenderShell(argValue("--shell")) ?? shellFor();
  // Only report the context window when the template actually asks for one — otherwise every
  // transposed lane would carry a line about a feature this config does not use.
  const laneTemplate = cfg.routing.cliLane;
  const wantsContextWindow =
    laneTemplate !== undefined &&
    [...laneTemplate.args, ...Object.values(laneTemplate.env ?? {})].some(
      (v) => typeof v === "string" && v.includes(CONTEXT_TOKEN),
    );
  let renderedCli = false;
  for (const l of view.ladder) {
    const mark = view.next && l.id === view.next.id ? "->" : "  ";
    const state = l.state === "ready" ? "" : ` [${l.state}${l.readyAt ? ` until ${l.readyAt}` : ""}]`;
    // Quoted per element. The task text is caller-supplied and this line is meant to be run
    // verbatim, so joining the raw argv would hand the host extra shell words.
    // A transposed rung is a relay rung the host must SPAWN, so it renders as a command like any
    // other cli lane — that is the whole point of the transposition, and printing its spec instead
    // would hand back something this host cannot act on.
    const spawnable = l.kind === "cli" || l.transposed === true;
    let target: string;
    if (spawnable && l.invoke) {
      target = renderCommand(l.invoke, shell);
      renderedCli = true;
    } else {
      target = l.spec ?? "";
    }
    const blocked = l.unreachable !== undefined && l.state === "ready" ? " [unreachable]" : "";
    process.stdout.write(`${mark} ${l.position}. ${l.id}${state}${blocked}\n`);
    if (target) process.stdout.write(`   ${spawnable ? "run" : "target"}: ${target}\n`);
    // Keep the spec visible on a transposed lane: the mechanism changed, the target did not, and
    // a reader comparing this against the config needs to see which rung this is.
    if (l.transposed && l.spec) process.stdout.write(`   via: routing.cliLane → ${l.spec} (this host cannot reach it as a subagent)\n`);
    // Say which way it went. A silently-absent window looks identical to one that was applied,
    // and the consequence differs a lot: the child falls back to its own assumed window, which on
    // a large-context model throws most of it away.
    if (l.transposed && wantsContextWindow) {
      // Provenance travels with the number, same rule as `strengthBasis` on a candidate row: a
      // first-party figure and a same-model figure taken from another host are different claims.
      process.stdout.write(
        l.contextWindow === undefined
          ? `   context: not published anywhere for this spec — the variable is omitted and the CLI uses its own default\n`
          : `   context: ${l.contextWindow.toLocaleString("en-US")} tokens (${
              l.contextWindowSource === "snapshot"
                ? "synced snapshot, same model id on another host"
                : "published by the serving provider"
            })\n`,
      );
    }
    if (l.unreachable) process.stdout.write(`   ⚠ ${l.unreachable}\n`);
    if (l.requiresDirective) {
      process.stdout.write(`   hint: add "@relay: ${l.spec}" to the subagent prompt (offload is off)\n`);
    }
    if (l.note) process.stdout.write(`   note: ${l.note}\n`);
  }

  // Say which shell the quoting is for. A command line that is safe in one shell and not in
  // another is worth nothing if the reader has to guess which one it was written for — and on
  // Windows the right answer depends on where the host pastes it (pwsh vs Git Bash).
  if (renderedCli) {
    process.stdout.write(
      `\ncli lines are quoted for ${SHELL_LABEL[shell]} — the task is a single argument (--shell to change)\n`,
    );
  }

  process.stdout.write(`\n${view.next ? `use: ${view.next.id}` : "no lane available"} — ${view.reason}\n`);
}

/**
 * Keep the `PreToolUse(Agent)` hook in step with the claude offload rule.
 *
 * The hook is not a separate feature to opt into — it is how "offload subagents" is DELIVERED on a
 * host whose traffic never reaches the relay. Where the HTTP path works (a terminal session,
 * Codex), the rule alone does the job and no hook is installed. So the two must move together, and
 * in particular `offload claude off` must remove it: a forcing function that outlived the setting
 * that justified it would deny subagents nobody asked to redirect.
 *
 * Never fatal. Failing to write the harness's settings file must not fail the toggle — the routing
 * rule itself is already applied and persisted by then, and reporting the toggle as failed would
 * misdescribe what happened.
 */
function syncAgentHook(enabled: boolean, host: HostRoutingState): void {
  try {
    if (enabled && host === "bypassed") {
      // `process.execPath` + this CLI's own entry script: never the installed launcher, which on
      // Windows is a `.cmd` the hook could not exec. See `renderAgentHookScript`.
      const change = installAgentHook(process.execPath, process.argv[1] ?? "");
      process.stdout.write(
        change.changed
          ? `  installed PreToolUse(Agent) hook → ${change.settingsPath}\n    Agent() calls now return a relay-routed command instead of silently spending primary quota\n`
          : `  PreToolUse(Agent) hook already installed (${change.settingsPath})\n`,
      );
    } else {
      const change = removeAgentHook();
      if (change.changed) process.stdout.write(`  removed PreToolUse(Agent) hook from ${change.settingsPath}\n`);
    }
  } catch (e) {
    process.stdout.write(`  ⚠ offload rule applied, but the Agent hook could not be updated: ${(e as Error).message}\n`);
  }
}

/** `llm-relay offload [status]` or `llm-relay offload <client> [on|off|status]`. */
export async function runOffload(arg: string | undefined, nextArg?: string): Promise<void> {
  const cfg = loadOrExit();
  const actions = new Set(["on", "enable", "off", "disable", "status"]);
  if (arg !== undefined && arg !== "status" && actions.has(arg)) {
    process.stderr.write("llm-relay offload: expected [status] or <client> on|off|status\n");
    process.exit(1);
  }
  if (arg === "status" && nextArg !== undefined) {
    process.stderr.write("llm-relay offload: status does not accept a client action\n");
    process.exit(1);
  }
  const client = arg === undefined || arg === "status" ? undefined : arg;
  const action = client === undefined ? "status" : (nextArg ?? "status");
  const want = action === "on" || action === "enable" ? true : action === "off" || action === "disable" ? false : null;
  const scopeArg = argValue("--scope", "-scope");
  const scope = scopeArg === "all" || scopeArg === "subagents" ? scopeArg : undefined;

  if (client !== undefined && !/^[A-Za-z0-9_.-]+$/.test(client)) {
    process.stderr.write(`llm-relay offload: client must be a simple name such as "claude" or "codex"\n`);
    process.exit(1);
  }
  if (!["on", "enable", "off", "disable", "status"].includes(action)) {
    process.stderr.write(`llm-relay offload: expected [client] on|off|status (got "${action}")\n`);
    process.exit(1);
  }
  if (scopeArg !== undefined && scope === undefined) {
    process.stderr.write(`llm-relay offload: --scope expects "subagents" or "all"\n`);
    process.exit(1);
  }
  if (scope !== undefined && client === undefined) {
    process.stderr.write(`llm-relay offload: --scope requires a client name (claude, codex, or another configured client)\n`);
    process.exit(1);
  }
  if (scope !== undefined && want === null) {
    process.stderr.write(`llm-relay offload: --scope may be used when enabling/disabling a client\n`);
    process.exit(1);
  }
  // Refuse to CREATE a rule under a name no front door produces — the toggle would succeed,
  // status would show it ON, and no request would ever consult it ("claude-desktop" was the real
  // case). This must happen here, not only server-side: tryServer treats the proxy's 400 as "no
  // proxy" and falls back to writing the file. An already-configured key stays togglable (turning
  // a dead rule OFF must work) and gets the warning from the returned state instead.
  if (client !== undefined && want !== null) {
    const unroutable = unroutableOffloadClient(client, cfg);
    if (unroutable?.fatal) {
      process.stderr.write(`llm-relay offload: ${unroutable.message}\n`);
      process.exit(1);
    }
  }

  const query = client ? `?client=${encodeURIComponent(client)}` : "";
  const live = (await tryServer(
    cfg,
    `/offload${query}`,
    want === null
      ? undefined
      : {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ enabled: want, ...(client ? { client } : {}), ...(scope ? { scope } : {}) }),
        },
  )) as OffloadState | null;

  // No proxy listening: still honour the change by writing the file, but say plainly that
  // nothing is running to apply it.
  const state = live ?? (want === null ? offloadState(cfg, client) : setOffload(cfg, want, client, scope));
  const label = client ?? "all";
  const configuredClients = state.clients ?? {};
  const effectiveScope = state.scope ?? "subagents";
  process.stdout.write(`${label} offload: ${state.enabled ? "ON" : "OFF"}${client ? ` (${effectiveScope})` : ""}\n`);

  // The toggle is real and it persists — it governs every host whose traffic DOES reach the relay,
  // and the relay-routed CLI children this ladder spawns. What it cannot do is affect the session
  // running this command, when that session's traffic never arrives. Saying so here is the point:
  // the switch reporting ON while nothing changes is precisely how the no-op went unnoticed.
  const hostRouting = detectHostRouting();
  if (hostRouting.state === "bypassed" && state.enabled) {
    process.stdout.write(`  ⚠ ${hostRouting.reason}\n`);
    process.stdout.write(`    subagents in THIS session are unaffected — use \`llm-relay dispatch -t "<task>"\` to reach a pool from here\n`);
  }
  if (client === CLAUDE_CLIENT && want !== null) {
    syncAgentHook(want, hostRouting.state);
  } else if (client === CLAUDE_CLIENT && agentHookInstalled()) {
    // Report it on a plain status read too. A hook that denies Agent() calls is a visible change
    // in how the harness behaves; leaving its state discoverable only by reading settings.json
    // would recreate the "something is silently intercepting this" problem in the other direction.
    process.stdout.write(`  PreToolUse(Agent) hook: installed — Agent() calls return a relay-routed command\n`);
  }
  if (want !== null) {
    process.stdout.write(
      live ? "  applied to the running proxy (effective now)\n" : "  no proxy listening — config file only\n",
    );
    if (!state.persisted) {
      process.stdout.write(`  ⚠ NOT persisted${state.persistError ? ` (${state.persistError})` : ""} — reverts on restart\n`);
    } else if (state.configPath) {
      process.stdout.write(`  persisted to ${state.configPath}\n`);
    }
  } else {
    process.stdout.write(`  source: ${live ? "running proxy" : `${state.configPath ?? "config"} (no proxy listening)`}\n`);
  }

  if (client) {
    // A live proxy's state carries the dead-rule warning itself; an older proxy's won't, so
    // fall back to the same local check rather than letting the gap read as "all fine".
    const deadRule = state.warning ?? unroutableOffloadClient(client, cfg)?.message;
    if (deadRule) process.stdout.write(`  ⚠ ${deadRule}\n`);
    if (state.enabled && Object.keys(state.subagents).length === 0) {
      process.stdout.write("  ⚠ routing.subagents is empty — offload is on but routes nowhere\n");
    }
    process.stdout.write(
      effectiveScope === "all"
        ? `  scope: all (the full ${client} conversation, including subagents)\n`
        : "  scope: subagents (marked child requests only)\n",
    );
  } else if (Object.keys(configuredClients).length > 0) {
    process.stdout.write(
      "\n" +
        formatTextTable(
          [
            ["client", "enabled", "scope"],
            ...Object.entries(configuredClients).map(([name, rule]) => [
              FRONT_DOOR_CLIENTS.includes(name) ? name : `${name} ⚠`,
              rule.enabled ? "ON" : "OFF",
              rule.scope,
            ]),
          ],
          "  ",
        ) +
        "\n",
    );
    for (const name of Object.keys(configuredClients)) {
      if (!FRONT_DOOR_CLIENTS.includes(name)) {
        process.stdout.write(
          `  ⚠ "${name}": no front door produces this client name — the rule is never consulted ` +
            `(front doors: ${FRONT_DOOR_CLIENTS.join(", ")})\n`,
        );
      }
    }
  } else if (state.enabled) {
    process.stdout.write("  offload is enabled for marked subagents across all front doors\n");
  } else {
    process.stdout.write("  offload is disabled; an `@relay: <spec>` line still offloads one marked subagent call\n");
  }
}

function fmt(v: number | null | undefined, suffix = ""): string {
  return v === null || v === undefined ? "-" : `${v}${suffix}`;
}

/**
 * Mean latency of this proxy's OWN traffic to a target, with the call count that backs it.
 *
 * Deliberately not merged into the `p95` column: that one is the synthetic probe loop's measured
 * p95, and an average over real requests is a different statistic from a different sample. Shown
 * in seconds past 10s because "62605" reads as noise where "62.6s" reads as a decision.
 */
function obsLatency(o: Candidate["observed"]): string {
  if (!o || o.avgLatencyMs === null || o.totalCalls === 0) return "-";
  const ms = o.avgLatencyMs;
  return ms >= 10000 ? `${(ms / 1000).toFixed(1)}s` : `${ms}ms`;
}

/**
 * How much to trust the strength number. A score from 5 leaderboards and a score from "nothing is
 * known, assume neutral" must never render identically.
 */
function strengthTag(c: Candidate): string {
  switch (c.sortInputs.strengthBasis) {
    case "snapshot":
      return `/${c.sortInputs.strengthSignals.length}c${c.sortInputs.publishedSignalCount}p`;
    default:
      return " neut";
  }
}

/** `llm-relay candidates` — every dimension of every offload target, side by side, unranked. */
export async function runCandidates(): Promise<void> {
  const cfg = loadOrExit();
  const only = argValue("--provider", "-p");
  const q = only ? `?provider=${encodeURIComponent(only)}` : "";

  let view = (await tryServer(cfg, `/candidates${q}`)) as CandidatesView | null;
  if (!view) {
    view = await buildCandidates(cfg, { catalog: new ModelCatalog(), ...(only ? { provider: only } : {}) });
  }

  if (view.candidates.length === 0) {
    process.stdout.write("No offload targets configured (routing.pools / routing.subagents are empty).\n");
    return;
  }

  const clientState = Object.entries(view.offload_clients ?? {})
    .map(([name, rule]) => `${name}:${rule.enabled ? "on" : "off"}/${rule.scope}`)
    .join(", ");
  process.stdout.write(`Offload targets — ${clientState || `legacy/global: ${view.offload_enabled ? "on" : "off"}`}\n`);
  process.stdout.write(`${view.note}\n\n`);

  const head =
    "target".padEnd(32) +
    "pools / tiers".padEnd(24) +
    "fit".padEnd(7) +
    "raw".padEnd(7) +
    "cap".padEnd(11) +
    "agentic".padEnd(9) +
    "coding".padEnd(8) +
    "BFCL".padEnd(7) +
    "aider".padEnd(7) +
    "arena".padEnd(7) +
    "$/Mout".padEnd(8) +
    "verdict".padEnd(10) +
    "p95".padEnd(8) +
    // Latency actually observed on this proxy's own traffic. The synthetic-probe p95 beside it is
    // routinely blank, so the table could show the first pool member with NO latency signal at all
    // while the proxy had already measured it at 60+ seconds per call — which is the difference
    // between a pool that suits mechanical batch work and one that does not.
    "obs".padEnd(8) +
    "quota".padEnd(7) +
    "breaker".padEnd(9) +
    "ctx";
  process.stdout.write(head + "\n" + "-".repeat(head.length) + "\n");

  for (const c of view.candidates) {
    const tags = [...c.pools, ...c.subagentTiers.map((t) => `@${t}`)].join(",") || "-";
    const live = c.listed === null ? "?" : c.listed ? "yes" : "NO";
    const ctx = c.contextLength ? `${Math.round(c.contextLength / 1000)}k` : "-";
    // A member that answers 401 on every call read "closed" here — the same as a healthy one —
    // because a credential fault is deliberately not health data and so never reached the
    // breaker's failure fields. It has its own axis now, and it is shown: the reason half a
    // pool can be unusable while every row looks fine is precisely this cell.
    const breaker = c.breaker.open
      ? `OPEN ${Math.round(c.breaker.cooldownRemainingMs / 1000)}s`
      : c.breaker.credentialFault
        ? `AUTH ${c.breaker.lastCredentialStatus ?? ""}`.trim()
        : "closed";
    process.stdout.write(
      c.spec.slice(0, 31).padEnd(32) +
        tags.slice(0, 23).padEnd(24) +
        c.sortInputs.fitness.toFixed(1).padEnd(7) +
        c.sortInputs.rawStrength.toFixed(1).padEnd(7) +
        // Capability plus how well-evidenced it is: "76.6/4" = 4 published signals behind it,
        // "50.0 neut" = nothing known. Never show the number alone.
        `${c.sortInputs.strength.toFixed(1)}${strengthTag(c)}`.padEnd(11) +
        fmt(c.scores.aaAgentic).padEnd(9) +
        fmt(c.scores.aaCoding).padEnd(8) +
        fmt(c.scores.bfclOverall).padEnd(7) +
        fmt(c.scores.aiderPassRate).padEnd(7) +
        (c.scores.arenaRating ? String(Math.round(c.scores.arenaRating)) : "-").padEnd(7) +
        (c.pricePerMTokOut !== null
          ? `$${c.pricePerMTokOut}${c.priceSource === "reference" ? "~" : ""}`
          : "-"
        ).padEnd(8) +
        (c.health?.verdict ?? "-").padEnd(10) +
        fmt(c.health?.p95Ms ?? null, "ms").padEnd(8) +
        obsLatency(c.observed).padEnd(8) +
        fmt(c.quotaPercent, "%").padEnd(7) +
        breaker.padEnd(9) +
        // Provenance inline: "~" = another provider's figure for this model id. A NIM row must
        // never present OpenRouter's ceiling as its own.
        ctx +
        (c.contextLengthSource === "reference" ? "~" : "") +
        (live === "NO" ? "  ⚠UNLISTED" : "") +
        "\n",
    );
  }

  const fuzzy = view.candidates.filter((c) => c.capabilityMatch?.match === "fuzzy");
  const srcs = [...new Set(view.candidates.flatMap((c) => c.capabilitySources))].sort();

  // Say out loud how much of the roster is currently unusable. A row-by-row table makes
  // "5 of 14 members can actually serve" something the reader has to notice; a pool that is
  // half dead is worth stating.
  const noKey = view.candidates.filter((c) => !c.hasKey);
  const authFault = view.candidates.filter((c) => c.breaker.credentialFault);
  const cooling = view.candidates.filter((c) => c.breaker.open);
  if (noKey.length || authFault.length || cooling.length) {
    process.stdout.write(
      `\nNot first choice right now (of ${view.candidates.length} targets):\n` +
        `  ${authFault.length} auth-faulted, ${cooling.length} cooling — DEMOTED: still tried, but only\n` +
        "    after every other candidate has failed on that request.\n" +
        `  ${noKey.length} with no key set — DROPPED from a pool entirely (resolveTargets removes a\n` +
        "    declared-but-unset credential), so a pool's real size is smaller than its member count.\n" +
        "    ⚠ That includes free providers that would serve WITHOUT a key: declaring an authEnv and\n" +
        "    leaving it unset excludes them from every pool they belong to.\n" +
        "  `llm-relay keys` says whether a credential is good; `llm-relay pools --probe` is the\n" +
        "  only check that proves a member can actually serve.\n",
    );
  }

  process.stdout.write(
    "\nColumns are independent — weigh them yourself. agentic/coding/BFCL/aider/arena are\n" +
      "capability from DIFFERENT leaderboards and they disagree; verdict/p95 are live behaviour;\n" +
      "quota/breaker/$ are what it costs to use right now. A blank cell means NOT MEASURED.\n" +
      `  p95 = synthetic probe loop; obs = mean of this proxy's OWN requests. Different samples,\n` +
      `        so they are not merged — and a high "obs" on a top-ranked member is worth seeing\n` +
      `        before pointing bulk work at that pool.\n` +
      `  breaker: "OPEN 42s" = cooling after failures/429; "AUTH 401" = credential fault, demoted\n` +
      `           until it is retried (expires, so a rotated key recovers with no restart).\n` +
      `  fit = pool order: 75% capability + 20% measured operations + 5% task-fit metadata.\n` +
      `        Unknown operations/metadata are neutral, never zero; hard faults are demoted.\n` +
      `  raw = fixed 40% agentic + 35% coding + 25% general capability. Missing dimensions\n` +
      `        are overlap-estimated instead of dropped; confidence affects ordering only.\n` +
      `        Floors use whole points, retain members through a 2-point exit band, and require\n` +
      `        an exact SKU match plus at least 3 published capability/task-fit signals.\n` +
      `  cap = confidence-adjusted capability used in fit ordering. "/4c5p" = four direct\n` +
      `        capability signals, five total publications; "neut" = no capability evidence.\n` +
      `  "~" on ctx/$ = another provider's figure for the same model id (this one publishes none);\n` +
      `                 unmarked = the serving provider published it; blank = nobody publishes it.\n` +
      (srcs.length ? `Sources contributing: ${srcs.join(", ")} (refresh: npm run sync:tiers)\n` : ""),
  );
  if (fuzzy.length > 0) {
    process.stdout.write(
      `~ = scores borrowed from a similarly-named model, not this one: ` +
        fuzzy.map((c) => `${c.model ?? c.spec} -> ${c.capabilityMatch!.name}`).join(", ") +
        "\n",
    );
  }
  process.stdout.write(
    `Full detail (every source's raw score, jitter, observed traffic): curl 127.0.0.1:${cfg.port}/candidates\n`,
  );
}

function configSourcePath(cfg: Config): string {
  if (!cfg.sourcePath) throw new Error("loaded config has no source path");
  return cfg.sourcePath;
}

function routingDocument(document: Record<string, unknown>): Record<string, unknown> {
  const current = document.routing;
  if (typeof current === "object" && current !== null && !Array.isArray(current)) {
    return current as Record<string, unknown>;
  }
  const routing: Record<string, unknown> = {};
  document.routing = routing;
  return routing;
}

function outputJson(value: unknown): void {
  process.stdout.write(JSON.stringify(value, null, 2) + "\n");
}

function changedConfig(path: string): void {
  process.stdout.write(`Updated ${path}\n`);
  process.stdout.write("Restart the running proxy for routing changes to take effect.\n");
}

function configCommandError(message: string): never {
  throw new Error(message);
}

const UNSAFE_CONFIG_NAMES = new Set(["__proto__", "prototype", "constructor"]);

function requireSimpleConfigName(name: string | undefined, command: string): string {
  if (!name || !/^[A-Za-z0-9_-]+$/.test(name) || UNSAFE_CONFIG_NAMES.has(name)) {
    configCommandError(`${command}: expected a simple name`);
  }
  return name;
}

function requireSpecs(command: string, specs: string[]): string[] {
  if (specs.length === 0 || specs.some((spec) => spec.length === 0)) {
    configCommandError(`${command}: expected at least one provider/model or pool/<name> spec`);
  }
  return specs;
}

function scalarOrArray(values: string[]): string | string[] {
  return values.length === 1 ? values[0]! : values;
}

/** `llm-relay config show|get|set|unset` — generic, scriptable JSON configuration editing. */
export function runConfigCommand(): void {
  const cfg = loadOrExit();
  const path = configSourcePath(cfg);
  const positionals = getPositionalArgs(process.argv);
  const action = positionals[1] ?? "show";
  const target = positionals[2];

  if (action === "show" || action === "get") {
    const document = readConfigDocument(path);
    const value = target ? readConfigPath(document, target) : document;
    if (target && value === undefined) configCommandError(`config ${action}: no value at "${target}"`);
    outputJson(value);
    return;
  }

  if (action === "set") {
    const valueArg = positionals[3];
    if (!target || valueArg === undefined || positionals.length > 4) {
      configCommandError("config set: expected exactly <path> <value>; values may be JSON");
    }
    updateConfigDocument(path, (document) => writeConfigPath(document, target, parseConfigValue(valueArg)));
    changedConfig(path);
    return;
  }

  if (action === "unset") {
    if (!target || positionals.length > 3) configCommandError("config unset: expected exactly <path>");
    const before = readConfigDocument(path);
    if (readConfigPath(before, target) === undefined) configCommandError(`config unset: no value at "${target}"`);
    let removed = false;
    updateConfigDocument(path, (document) => {
      removed = deleteConfigPath(document, target);
    });
    if (!removed) configCommandError(`config unset: no value at "${target}"`);
    changedConfig(path);
    return;
  }

  configCommandError(`config: expected show|get|set|unset (got "${action}")`);
}

/** `llm-relay routing ...` — convenient typed commands for the fields operators edit most. */
export function runRoutingCommand(): void {
  const cfg = loadOrExit();
  const path = configSourcePath(cfg);
  const positionals = getPositionalArgs(process.argv);
  const action = positionals[1] ?? "show";

  if (action === "show" || action === "get") {
    outputJson(cfg.routing);
    return;
  }

  if (action === "default") {
    const specs = requireSpecs("routing default", positionals.slice(2));
    updateConfigDocument(path, (document) => {
      routingDocument(document).default = scalarOrArray(specs);
    });
    changedConfig(path);
    return;
  }

  if (action === "tier" || action === "subagent") {
    const name = requireSimpleConfigName(positionals[2], `routing ${action}`);
    const clear = hasFlag("--clear");
    const specs = positionals.slice(3);
    if (action === "subagent" && specs.length > 1) configCommandError("routing subagent: expected exactly one target spec");
    if (!clear) requireSpecs(`routing ${action}`, specs);
    if (clear && specs.length > 0) configCommandError(`routing ${action}: --clear cannot be combined with a spec`);
    updateConfigDocument(path, (document) => {
      const routing = routingDocument(document);
      const field = action === "tier" ? "tiers" : "subagents";
      const current = routing[field];
      const map: Record<string, unknown> =
        typeof current === "object" && current !== null && !Array.isArray(current)
          ? (current as Record<string, unknown>)
          : {};
      if (clear) delete map[name];
      else map[name] = action === "subagent" ? specs[0]! : scalarOrArray(specs);
      routing[field] = map;
    });
    changedConfig(path);
    return;
  }

  if (action === "sort" || action === "benchmark") {
    const value = positionals[2]?.toLowerCase();
    if (value !== "on" && value !== "off") configCommandError(`routing ${action}: expected on or off`);
    updateConfigDocument(path, (document) => {
      routingDocument(document).benchmarkSort = value === "on";
    });
    changedConfig(path);
    return;
  }

  if (action === "set" || action === "unset") {
    const key = positionals[2];
    if (!key || key.startsWith("routing.")) configCommandError(`routing ${action}: expected a path relative to routing`);
    if (action === "set") {
      const valueArg = positionals[3];
      if (valueArg === undefined || positionals.length > 4) configCommandError("routing set: expected <path> <value>");
      updateConfigDocument(path, (document) => writeConfigPath(document, `routing.${key}`, parseConfigValue(valueArg)));
    } else {
      if (positionals.length > 3) configCommandError("routing unset: expected exactly <path>");
      updateConfigDocument(path, (document) => {
        if (!deleteConfigPath(document, `routing.${key}`)) configCommandError(`routing unset: no value at "${key}"`);
      });
    }
    changedConfig(path);
    return;
  }

  configCommandError(`routing: unknown action "${action}"`);
}

/**
 * `llm-relay pools` — list pool members; `--probe` sends a real completion to each.
 *
 * The listing is cheap and offline. The probe is the only thing that can actually catch a
 * member that is configured, catalogued, and nonetheless dead — see pool-health.ts.
 */
export async function runPools(
  deps: {
    catalog?: ModelCatalog;
    probeAll?: typeof probeAllPools;
  } = {},
): Promise<void> {
  const cfg = loadOrExit();
  const path = configSourcePath(cfg);
  const positionals = getPositionalArgs(process.argv);
  const action = positionals[1];

  if (action === "set" || action === "add" || action === "remove" || action === "delete" || action === "rm") {
    const name = requireSimpleConfigName(positionals[2], `pools ${action}`);
    const specs = positionals.slice(3);
    const include = argValue("--include") ?? (hasFlag("--free") ? "free" : undefined);
    const effort = argValue("--effort");
    if (include !== undefined && include !== "free") configCommandError('pools: --include expects "free"');
    if (effort !== undefined && !["low", "medium", "high", "xhigh"].includes(effort)) {
      configCommandError("pools: --effort expects low, medium, high, or xhigh");
    }
    if (effort !== undefined && include !== "free") {
      configCommandError("pools: --effort requires --free or --include free");
    }

    if (action === "delete" || action === "rm") {
      if (specs.length > 0 || include !== undefined || effort !== undefined) configCommandError(`pools ${action}: expected only <name>`);
      updateConfigDocument(path, (document) => {
        const routing = routingDocument(document);
        const pools = routing.pools;
        if (typeof pools !== "object" || pools === null || Array.isArray(pools) || !(name in pools)) {
          configCommandError(`pools ${action}: no pool named "${name}"`);
        }
        delete (pools as Record<string, unknown>)[name];
      });
      changedConfig(path);
      return;
    }

    if (specs.length === 0 && !(action === "set" && include === "free")) {
      configCommandError(`pools ${action}: expected at least one member spec`);
    }
    updateConfigDocument(path, (document) => {
      const routing = routingDocument(document);
      const pools =
        typeof routing.pools === "object" && routing.pools !== null && !Array.isArray(routing.pools)
          ? (routing.pools as Record<string, unknown>)
          : {};
      routing.pools = pools;
      const existing = pools[name];
      const dynamic = typeof existing === "object" && existing !== null && !Array.isArray(existing)
        ? existing as Record<string, unknown>
        : null;
      const oldMembers = dynamic
        ? Array.isArray(dynamic.preferred) ? dynamic.preferred.filter((v): v is string => typeof v === "string") : []
        : Array.isArray(existing) ? existing.filter((v): v is string => typeof v === "string") : [];
      const oldEffort = dynamic && typeof dynamic.effort === "string" ? dynamic.effort : undefined;
      let next: string[];
      if (action === "set") next = [...new Set(specs)];
      else if (action === "add") next = [...new Set([...oldMembers, ...specs])];
      else next = oldMembers.filter((member) => !specs.includes(member));

      if (next.length === 0 && include !== "free" && dynamic === null) {
        configCommandError("pools remove: the pool would be empty; use pools delete instead");
      }
      if (include === "free" || (dynamic !== null && action !== "set")) {
        pools[name] = {
          preferred: next,
          include: "free",
          ...(effort ?? (action !== "set" ? oldEffort : undefined)
            ? { effort: effort ?? oldEffort }
            : {}),
        };
      } else {
        pools[name] = next;
      }
    });
    changedConfig(path);
    return;
  }

  // Read-only pool commands must inspect the same effective membership used by live routing:
  // the configured prefix followed by the discovered free-model tail. ModelCatalog reads the
  // on-disk cache synchronously here, so ordinary listing stays offline and cheap. Previously
  // only the server request path materialized this tail, which made `pools` and `pools --probe`
  // report and test only the configured prefixes while claiming to cover every pool member.
  materializeDynamicPools(cfg, deps.catalog ?? new ModelCatalog());

  if (action === "show") {
    const name = requireSimpleConfigName(positionals[2], "pools show");
    const pool = cfg.routing.pools?.[name];
    if (!pool) configCommandError(`pools show: no pool named "${name}"`);
    if (hasFlag("--json")) outputJson(pool);
    else {
      process.stdout.write(`pool/${name} — ${pool.length} members\n`);
      for (const spec of pool) process.stdout.write(`  ${spec}\n`);
    }
    return;
  }

  if (action && action !== "list") {
    // `pools <name>` is a useful shorthand for showing one pool; everything else is a typo.
    const pool = cfg.routing.pools?.[action];
    if (!pool) configCommandError(`pools: unknown action or pool "${action}"`);
    if (hasFlag("--json")) outputJson(pool);
    else {
      process.stdout.write(`pool/${action} — ${pool.length} members\n`);
      for (const spec of pool) process.stdout.write(`  ${spec}\n`);
    }
    return;
  }

  const pools = cfg.routing.pools ?? {};
  const names = Object.keys(pools);
  if (names.length === 0) {
    process.stdout.write("No pools configured (routing.pools).\n");
    return;
  }

  if (!hasFlag("--probe")) {
    if (hasFlag("--json")) {
      outputJson(pools);
      return;
    }
    for (const name of names) {
      process.stdout.write(`\npool/${name} — ${pools[name]!.length} members\n`);
      for (const spec of pools[name]!) process.stdout.write(`  ${spec}\n`);
    }
    process.stdout.write(`\nMembership only — no liveness checked. Run "llm-relay pools --probe" to test each for real.\n`);
    return;
  }

  process.stdout.write("Probing every pool member with a real completion...\n\n");
  const results = await (deps.probeAll ?? probeAllPools)(cfg);
  const icon: Record<MemberVerdict, string> = {
    live: "LIVE",
    empty: "EMPTY",
    auth: "AUTH",
    rate_limited: "429",
    missing: "DEAD",
    error: "ERR",
  };
  let dead = 0;
  for (const name of names) {
    process.stdout.write(`pool/${name}\n`);
    for (const r of results.filter((x) => x.pool === name)) {
      if (DEAD_VERDICTS.has(r.verdict)) dead++;
      const lat = r.latencyMs !== undefined ? `${r.latencyMs}ms` : "";
      process.stdout.write(
        `  ${fitCell(icon[r.verdict], 6)} ${fitCell(r.spec, 50)} ${fitCell(lat, 8)} ${r.detail ?? ""}\n`,
      );
    }
    process.stdout.write("\n");
  }

  const live = results.filter((r) => r.verdict === "live").length;
  process.stdout.write(`${live}/${results.length} live.\n`);
  if (dead > 0) {
    process.stdout.write(
      `⚠ ${dead} member(s) will never answer (DEAD/AUTH). Remove them from routing.pools — a pool\n` +
        `  ranked by fitness can otherwise put a dead model first and burn a failover hop on every call.\n`,
    );
  }
}

import { probeAllPools, DEAD_VERDICTS, type MemberVerdict } from "./pool-health.js";
import { runInteractiveOnboarding } from "./onboarding.js";
import { setupClaudeCli, setupClaudeDesktop } from "./setup-claude.js";
import { getTelemetryReport } from "./telemetry.js";
import { globalCircuitBreaker } from "./circuit-breaker.js";

export function main(): void {
  const positionals = getPositionalArgs(process.argv);
  const arg2 = positionals[0];
  const arg3 = positionals[1];
  const arg4 = positionals[2];

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
  if (arg2 === "offload") {
    runOffload(arg3, arg4).catch((e) => {
      process.stderr.write(`llm-relay offload: ${(e as Error).message}\n`);
      process.exit(1);
    });
    return;
  }
  if (arg2 === "dispatch") {
    runDispatch(arg3).catch((e) => {
      process.stderr.write(`llm-relay dispatch: ${(e as Error).message}\n`);
      process.exit(1);
    });
    return;
  }
  if (arg2 === "candidates") {
    runCandidates().catch((e) => {
      process.stderr.write(`llm-relay candidates: ${(e as Error).message}\n`);
      process.exit(1);
    });
    return;
  }
  if (arg2 === "pools") {
    runPools().catch((e) => {
      process.stderr.write(`llm-relay pools: ${(e as Error).message}\n`);
      process.exit(1);
    });
    return;
  }
  if (arg2 === "routing" || arg2 === "route") {
    try {
      runRoutingCommand();
    } catch (e) {
      process.stderr.write(`llm-relay routing: ${(e as Error).message}\n`);
      process.exit(1);
    }
    return;
  }
  if (arg2 === "config") {
    try {
      runConfigCommand();
    } catch (e) {
      process.stderr.write(`llm-relay config: ${(e as Error).message}\n`);
      process.exit(1);
    }
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
 * Does THIS invocation already change durable state on this machine?
 *
 * Only such an invocation may be the moment the global install is replaced and the process
 * re-execed. `llm-relay keys` is a status query: reinstalling the user's global package
 * underneath a question about their credentials is a side effect nobody asked for, and it used
 * to happen on every read-only subcommand.
 *
 * Read-only is the DEFAULT and the fall-through, so a subcommand added later is safe until
 * someone deliberately classifies it — the failure mode of an unlisted command is "no update
 * check", never "surprise reinstall".
 *
 * This is passed to `shouldCheckUpdates()` as a RUNTIME PARAMETER. `self-update.ts` cannot
 * import this table: `cli.ts` already imports that module, so the reverse import would be a
 * cycle. The classification travels as an argument precisely to keep the dependency one-way.
 */
export function classifyCommand(argv: string[]): CommandEffect {
  // `main()` routes `--ping` to the ping command wherever it appears, so match it the same
  // way — otherwise `llm-relay --ping` looks like a bare proxy start and gets classified as one.
  const isPing = argv
    .slice(1)
    .some((a) => a === "--ping" || a === "-ping" || a.startsWith("--ping=") || a.startsWith("-ping="));
  if (isPing) return "read-only";

  const positionals = getPositionalArgs(argv);
  const sub = positionals[0];
  // No subcommand (or flags only) starts the proxy. That start already writes this machine's
  // config when none exists (`resolveConfigPath`), it is the long-lived process, and it is the
  // one moment a re-exec costs nothing because nothing has been served yet.
  if (sub === undefined) return "mutating";

  const arg3 = positionals[1];
  const arg4 = positionals[2];
  switch (sub) {
    // Writes ~/.llm-relay/.env.
    case "onboard":
      return "mutating";
    // `setup claude-desktop` writes claude_desktop_config.json; bare `setup` only prints.
    case "setup":
      return arg3 === "claude-desktop" || arg3 === "desktop" ? "mutating" : "read-only";
    // Only client-scoped `offload <client> on|off` rewrites config.json; status forms only report.
    case "offload":
      return arg4 === "on" || arg4 === "enable" || arg4 === "off" || arg4 === "disable"
        ? "mutating"
        : "read-only";
    case "config":
      return arg3 === "set" || arg3 === "unset" ? "mutating" : "read-only";
    case "routing":
    case "route":
      return arg3 === "set" || arg3 === "unset" || arg3 === "default" || arg3 === "tier" ||
        arg3 === "subagent" || arg3 === "sort" || arg3 === "benchmark"
        ? "mutating"
        : "read-only";
    case "pools":
      return arg3 === "set" || arg3 === "add" || arg3 === "remove" || arg3 === "delete" || arg3 === "rm"
        ? "mutating"
        : "read-only";
    // keys, check-keys, models, telemetry, dispatch, candidates, pools, ping, help, version —
    // and anything not yet listed. `dispatch -x` is included on purpose: it reports spend to a
    // running proxy's in-memory cooldowns and changes nothing on this machine.
    default:
      return "read-only";
  }
}

/**
 * Entrypoint: currency gate first (may replace this install and re-exec), then
 * the command itself. `main` stays synchronous so its exit paths are direct.
 */
export async function run(): Promise<void> {
  if (shouldCheckUpdates(process.argv, process.env, classifyCommand(process.argv))) {
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
