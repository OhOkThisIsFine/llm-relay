#!/usr/bin/env node
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import { spawn } from "node:child_process";
import {
  loadConfig,
  splitSpec,
  offloadRule,
  unroutableOffloadClient,
  type Config,
  type ConfigOverrides,
  DEFAULT_DESTRUCTIVE,
  FRONT_DOOR_CLIENTS,
  CLAUDE_CLIENT,
  type OffloadRule,
} from "./config.js";
import { loadEnvFile } from "./dotenv.js";
import { recoverWindowsEnv } from "./winenv.js";
import { offloadState, setOffload, type OffloadState } from "./offload.js";
import { buildCandidates, type CandidatesView, type Candidate, type CandidateAvailability } from "./candidates.js";
import { CREDENTIAL_LABEL_PATTERN, makeCredentialId, parseCredentialId } from "./credential-id.js";
import { providerCredentialSlots, slotAllowsModel } from "./credential-fleet.js";
import { loadLaneManifest, verifyModel } from "./lane-manifest.js";
import { probeLanes } from "./lane-probe.js";
import { buildDispatch, normalizeCliCommand, specContextWindow, CONTEXT_TOKEN, type DispatchLane, type DispatchView } from "./dispatch.js";
import { detectHostRouting, parseHostRoutingState, type HostRoutingState } from "./host-routing.js";
import { contextWindowResolver } from "./metadata.js";
import { snapshotContextWindow } from "./tier-data.js";
import { observedContextLimit, flushObservedContextLimits } from "./context-limits.js";
import { allFacts, describeScope, flushFacts, FACT_KINDS, type FactKind } from "./target-facts.js";
import {
  acceptInterpretation,
  flushInterpretations,
  pendingRefusals,
  proposeInterpretation,
  rejectInterpretation,
  type ResetRule,
  type ScopeTemplate,
} from "./refusal-interpretation.js";
import { installAgentHook, removeAgentHook, agentHookInstalled } from "./claude-hook.js";
import { installProcessSafetyNet } from "./process-safety-net.js";
import { createProxy } from "./server.js";
import { createAccountingStore, type AccountingStore } from "./accounting-store.js";
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
import type { CooldownClearResult } from "./cooldown-clear.js";
import { createDashboardSnapshotReadPort, type CostReportQuery } from "./dashboard-snapshot.js";
import { DASHBOARD_MEDIA_TYPE, isDashboardUtcTimestamp } from "./dashboard-contract.js";
import { DASHBOARD_BOOTSTRAP_SCHEMA, DASHBOARD_BOOTSTRAP_REQUEST_SCHEMA } from "./dashboard-routes.js";
import { flushRuntimeTelemetry } from "./ping/runtime-telemetry.js";
import { flushProbeCache } from "./ping/probe-cache.js";

const VALUE_FLAGS = new Set<string>([
  "--config", "-config", "-c",
  "--provider", "-provider", "-p",
  "--default", "-default", "-d",
  "--mode", "-mode", "-m",
  "--listen", "-listen", "-l",
  "--task", "-task", "-t",
  "--exhausted", "-exhausted", "-x",
  "--outcome", "-outcome",
  "--retry-after-ms", "-retry-after-ms",
  "--after", "-after",
  "--lane", "-lane",
  "--tier", "-tier",
  // ⚠ A value-taking flag MUST be listed here or its value is read as a positional. `--host
  // routed` was parsed as the positional lane id "routed" and reported as a missing lane.
  "--host", "-host",
  "--client", "-client",
  "--scope", "-scope",
  "--credential", "-credential",
  "--include", "-include",
  "--window", "-window",
  "--by", "-by",
  "--effort", "-effort",
  "--shell", "-shell",
  "--class", "-class",
  "--members", "-members",
  "--rationale", "-rationale",
  "--reset-field", "-reset-field",
  "--reset-ms", "-reset-ms",
  "--import", "-import",
]);

interface ParsedCliArgs {
  flags: string[];
  values: Array<{ flag: string; value: string | undefined }>;
  positionals: string[];
}

let cachedArgv: string[] | undefined;
let cachedParsedArgs: ParsedCliArgs | undefined;

function parseCliArgs(argv: string[]): ParsedCliArgs {
  if (cachedArgv && cachedParsedArgs
      && argv.length === cachedArgv.length
      && argv.every((value, index) => value === cachedArgv![index])) {
    return cachedParsedArgs;
  }

  const flags: string[] = [];
  const values: ParsedCliArgs["values"] = [];
  const positionals: string[] = [];
  let i = 2;
  while (i < argv.length) {
    const arg = argv[i];
    if (!arg) {
      i++;
      continue;
    }
    if (!arg.startsWith("-")) {
      positionals.push(arg);
      i += 1;
      continue;
    }

    const equalsAt = arg.indexOf("=");
    const flag = equalsAt === -1 ? arg : arg.slice(0, equalsAt);
    flags.push(flag);
    if (!VALUE_FLAGS.has(flag)) {
      i += 1;
      continue;
    }

    const value = equalsAt === -1 ? argv[i + 1] : arg.slice(equalsAt + 1);
    values.push({ flag, value });
    i += equalsAt === -1 ? 2 : 1;
  }

  cachedArgv = [...argv];
  cachedParsedArgs = { flags, values, positionals };
  return cachedParsedArgs;
}

function expandFlagAliases(flags: string[]): Set<string> {
  const aliases = new Set<string>();
  for (const flag of flags) {
    aliases.add(flag);
    if (flag.startsWith("--")) aliases.add(flag.slice(1));
  }
  return aliases;
}

export function argValue(...flags: string[]): string | undefined {
  const aliases = expandFlagAliases(flags);
  return parseCliArgs(process.argv).values.find(({ flag }) => aliases.has(flag))?.value;
}

export function hasFlag(...flags: string[]): boolean {
  const aliases = expandFlagAliases(flags);
  return parseCliArgs(process.argv).flags.some((flag) => aliases.has(flag));
}

/** Extract non-flag positional arguments from an argv array, skipping flags and their values. */
export function getPositionalArgs(argv: string[] = process.argv): string[] {
  return [...parseCliArgs(argv).positionals];
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
  ["llm-relay onboard [--import <file>] [--force]", "Set up or import provider keys."],
  ["llm-relay setup [target]", "target: claude-cli | claude-desktop."],
  ["llm-relay keys | check-keys", "Check every configured credential slot."],
  ["llm-relay pools [--probe]", "List members; --probe tests each deployment once."],
  ["llm-relay pools <action> <name> [<spec>...]", "action: set|add|remove|delete."],
  ["llm-relay routing <action> ...", "action: show|get|default|tier|subagent|sort|benchmark|set|unset."],
  ["llm-relay config <action> [<path>] [<value>]", "action: show|get|set|unset."],
  ["llm-relay models [-p <name>] [-r]", "List provider models."],
  ["llm-relay ping [-p <name>]", "Probe providers."],
  ["llm-relay dashboard", "Open the read-only local analytics dashboard."],
  ["llm-relay telemetry", "Print telemetry JSON."],
  ["llm-relay offload [status]", "Show current offload rules."],
  ["llm-relay offload <harness> <on|off> [--scope <scope>]", "Toggle one harness (claude | codex); scope: subagents | all."],
  ["llm-relay cooldowns clear <provider>[/<model>] [--credential <label>]", "Clear live cooling state; requires the running relay."],
  ["llm-relay candidates [-p <name>]", "Compare deployment x credential-slot targets."],
  ["llm-relay cost [--window <w>] [--by <d>] [--include-repair]", "Summarise spend from the local accounting ledger."],
  ["llm-relay eligibility", "What backends said about themselves; refusals awaiting interpretation."],
  ["llm-relay eligibility <propose|accept> <n> --class <kind> --scope <scope>", "Scopes: attempt | group | deployment | credential | provider | model."],
  ["llm-relay eligibility ... --scope group --members <id,id,...> [--all-credentials]", "Groups default to the current credential slot; the flag explicitly widens them."],
  ["eligibility scope breadth", "credential = current credential slot; provider = all credentials for that provider."],
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
  An anthropic provider with no provider-owned auth and mode not contained forwards the caller's
  credentials. Prefer explicit credentialMode: "passthrough" for real Anthropic. Contained
  Anthropic-format backends strip caller auth. A provider uses legacy authEnv or credentials[],
  never both; fleet authEnv names are exact and any explicit fleet is contained.

Offload is off by default. To route one subagent call without turning it on, put
"@relay: <spec>" on its own line at the start of the subagent prompt (the relay strips it).

If this host's traffic does not reach the relay (Claude Desktop pins its own base URL), no
subagent can be rerouted and "@relay:" is inert. "llm-relay dispatch" detects that and hands
back runnable commands instead; "offload claude on" there also installs a PreToolUse(Agent)
hook that redirects Agent() calls to the same lane. "offload claude off" removes it.

Setup checks: "llm-relay keys" checks every credential slot; "llm-relay pools --probe" spends one
real completion per unique pool deployment through one serviceable slot, not every credential.
Environment variables override ~/.llm-relay/.env.

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
  ["--probe", "Test each unique deployment through one serviceable credential."],
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
  ["GET /registry", "Provider/routing plus nested non-secret credential metadata."],
  ["GET /candidates", "Deployment x credential policy/state/quota/breaker cells."],
  ["GET|POST /offload", "Read/set rules; accepts ?client=<name>."],
  ["GET|POST /dispatch", "Read/set next lane; POST {\"exhausted\":\"<lane>\"}."],
  ["POST /cooldowns/clear", "Clear scoped live cooling state."],
  ["GET /telemetry", "Provider telemetry."],
  ["GET /ping", "Run health probe."],
  ["GET /health", "Provider health."],
], "  ")}
Control reads (/registry, /candidates, /ping, /health) and control writes require the per-install
capability token; the CLI attaches it automatically. /telemetry stays provider-aggregate, and
/health strips nested credential details.
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
  let accountingStore: AccountingStore | undefined;
  let accountingStoreClosed = false;
  const closeAccountingStore = () => {
    if (accountingStoreClosed) return;
    if (accountingStore === undefined) {
      accountingStoreClosed = true;
      return;
    }
    try {
      const result = accountingStore.close();
      // A retryable flush failure deliberately leaves the store open and its
      // writer lease intact. The server close callback / beforeExit hook gets
      // another bounded shutdown opportunity instead of discarding dirty facts.
      accountingStoreClosed = accountingStore.closed || !result.retryable;
    } catch {
      // Accounting is observational; a store close failure must not prevent
      // the remaining shutdown flushes or process exit. Leave the latch open
      // so a later shutdown boundary may retry.
    }
  };
  // A late socket reset from a discarded failover body must not kill the process that fronts
  // every session; genuine bugs still exit 1. See src/process-safety-net.ts.
  installProcessSafetyNet({
    beforeExit: () => {
      closeAccountingStore();
      catalog.flushPersistence();
      flushRuntimeTelemetry();
      flushProbeCache();
      flushObservedContextLimits();
      flushFacts();
      flushInterpretations();
    },
  });
  // M5 (open-decisions-2026-08-16.md row M5, approved 2026-08-21): prune usage day shards
  // after 30 days. A tunable default, not a measurement — the store itself keeps retention
  // off (null) for library callers.
  accountingStore = createAccountingStore({ retentionDays: 30 });
  const server = createProxy(cfg, {
    catalog,
    accountingRecorder: accountingStore,
    accountingReader: accountingStore,
    dashboardRelayVersion: currentVersion(),
    // The projector aggregates every labeled attribution by default; query filters narrow it.
    dashboardAttributionPolicy: "include_all_labeled",
  });
  server.once("close", closeAccountingStore);
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

  let shutdownStarted = false;
  const shutdown = () => {
    if (shutdownStarted) return;
    shutdownStarted = true;
    if (typeof server.closeIdleConnections === "function") {
      server.closeIdleConnections();
    }
    server.close(() => {
      closeAccountingStore();
      // Write-behind caches trade a bounded crash window for a quiet request path. Graceful
      // shutdown closes that window explicitly.
      catalog.flushPersistence();
      flushRuntimeTelemetry();
      flushProbeCache();
      flushObservedContextLimits();
      flushFacts();
      flushInterpretations();
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

  process.stdout.write(`\nProvider: ${name}\n`);
    if (models.length === 0) {
      process.stdout.write("  (no models listed or reachable)\n");
      continue;
    }

    for (const mId of models.slice(0, 10)) {
      const slots = providerCredentialSlots(name, p).filter((slot) => slotAllowsModel(slot, mId));
      for (const slot of slots.length > 0 ? slots : [undefined]) {
        const summary = pingLoop.getModelSummary(name, mId);
        const avgStr = summary.avgMs >= 0 ? `${summary.avgMs}ms` : "pending";
        const p95Str = summary.p95Ms >= 0 ? `${summary.p95Ms}ms` : "pending";
        const scoreStr = summary.stabilityScore >= 0 ? `${summary.stabilityScore}/100` : "N/A";
        const quota = formatCandidateQuota(
          pingLoop.getQuotaObservations(slot?.credentialId ?? makeCredentialId(name), mId),
          Date.now(),
        );
        process.stdout.write(
          `  ${slot ? `${slot.label} (${slot.credentialId})` : "no matching credential"} | model: ${mId} | verdict: ${fitCell(summary.verdict, 10)} | avg: ${fitCell(avgStr, 8)} | p95: ${fitCell(p95Str, 8)} | stability: ${scoreStr} | quota: ${quota}\n`,
        );
      }
    }
  }
}

import { validateProviderKeys } from "./key-checker.js";
import { getStrength } from "./benchmarks.js";

/**
 * Render the key checker's quota percent WITH its basis and limit/usage figures — never alone.
 * The percent is the relay's own arithmetic over figures the provider stated
 * (`fetchProviderQuota`: OpenRouter's credit `limit` and `usage`), not a typed observation,
 * but the axis IS known because that endpoint is the only producer.
 * Spec §6.1: every reported number carries its basis.
 */
export function formatKeyQuota(quotaPercent: number | null | undefined): string {
  if (quotaPercent === undefined || quotaPercent === null) return "";
  return ` | Quota: ${quotaPercent}% of credit limit left (relay-derived from provider-stated limit/usage)`;
}

/** `llm-relay check-keys` — pre-flight verification of provider environment keys. */
export async function runCheckKeys(): Promise<void> {
  const cfg = loadOrExit();
  process.stdout.write("🔑 Validating configured provider API keys...\n\n");
  const results = await validateProviderKeys(cfg);

  const rows = [
    ["Provider", "Credential ID", "Label", "Env var", "Status", "Details"],
    ...results.map((r) => {
      const envStr = r.authEnv ?? "(none)";
      const quotaStr = formatKeyQuota(r.quotaPercent);
      const modelsStr = r.modelsFound !== undefined ? ` | Models: ${r.modelsFound}` : "";
      const status = r.status === "no_models" ? "NO MODELS" : r.status.toUpperCase();
      return [r.provider, r.credentialId, r.label, envStr, status, `${r.message}${quotaStr}${modelsStr}`];
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

function cooldownCommandFailure(message: string): never {
  process.stderr.write(`llm-relay cooldowns: ${message}\n`);
  process.exit(1);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function hasExactKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  const actual = Object.keys(value);
  return actual.length === keys.length && actual.every((key) => keys.includes(key));
}

function nonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.length > 0;
}

type CooldownClearCell = CooldownClearResult["cleared"]["breakerCells"]["items"][number];
type CooldownClearFact = CooldownClearResult["cleared"]["facts"]["items"][number];
type CooldownFactScope = CooldownClearFact["scope"];

const COOLING_FACT_KINDS: ReadonlySet<FactKind> = new Set([
  "allowance-exhausted",
  "rate-limited",
  "credential-invalid",
]);

function credentialIdBelongsTo(provider: string, value: unknown): value is string {
  if (typeof value !== "string") return false;
  return parseCredentialId(value)?.provider === provider;
}

function isCooldownFactScope(value: unknown): value is CooldownFactScope {
  if (!isRecord(value)) return false;
  switch (value.kind) {
    case "attempt":
      return hasExactKeys(value, ["kind", "provider", "credentialId", "model"]) &&
        nonEmptyString(value.provider) &&
        credentialIdBelongsTo(value.provider, value.credentialId) &&
        nonEmptyString(value.model);
    case "group": {
      const keys = Object.hasOwn(value, "credentialId")
        ? ["kind", "provider", "credentialId", "members"]
        : ["kind", "provider", "members"];
      return hasExactKeys(value, keys) &&
        nonEmptyString(value.provider) &&
        Array.isArray(value.members) &&
        value.members.length > 0 &&
        value.members.every(nonEmptyString) &&
        (!Object.hasOwn(value, "credentialId") || credentialIdBelongsTo(value.provider, value.credentialId));
    }
    case "deployment":
      return hasExactKeys(value, ["kind", "provider", "model"]) &&
        nonEmptyString(value.provider) && nonEmptyString(value.model);
    case "credential":
      return hasExactKeys(value, ["kind", "provider", "credentialId"]) &&
        nonEmptyString(value.provider) && credentialIdBelongsTo(value.provider, value.credentialId);
    case "provider":
      return hasExactKeys(value, ["kind", "provider"]) && nonEmptyString(value.provider);
    case "model":
      return hasExactKeys(value, ["kind", "model"]) && nonEmptyString(value.model);
    default:
      return false;
  }
}

function scopeIsContainedByTarget(
  scope: CooldownFactScope,
  target: CooldownClearResult["target"],
): boolean {
  const credentialId = target.credential === undefined
    ? undefined
    : makeCredentialId(target.provider, target.credential);
  switch (scope.kind) {
    case "attempt":
      return scope.provider === target.provider &&
        (target.model === undefined || scope.model === target.model) &&
        (credentialId === undefined || scope.credentialId === credentialId);
    case "group":
      return scope.provider === target.provider &&
        (target.model === undefined || scope.members.every((member) => member === target.model)) &&
        (credentialId === undefined || scope.credentialId === credentialId);
    case "deployment":
      return scope.provider === target.provider && credentialId === undefined &&
        (target.model === undefined || scope.model === target.model);
    case "credential":
      return scope.provider === target.provider && target.model === undefined &&
        (credentialId === undefined || scope.credentialId === credentialId);
    case "provider":
      return scope.provider === target.provider && target.model === undefined && credentialId === undefined;
    case "model":
      return false;
  }
}

function isCooldownCell(
  value: unknown,
  target: CooldownClearResult["target"],
): value is CooldownClearCell {
  if (!isRecord(value) || !hasExactKeys(value, ["provider", "model", "credential"])) return false;
  if (!nonEmptyString(value.provider) || value.provider !== target.provider) return false;
  if (!(value.model === null || nonEmptyString(value.model))) return false;
  if (!nonEmptyString(value.credential) || !CREDENTIAL_LABEL_PATTERN.test(value.credential)) return false;
  return (target.model === undefined || value.model === target.model) &&
    (target.credential === undefined || value.credential === target.credential);
}

function isCooldownFact(
  value: unknown,
  target: CooldownClearResult["target"],
): value is CooldownClearFact {
  return isRecord(value) &&
    hasExactKeys(value, ["kind", "scope"]) &&
    typeof value.kind === "string" &&
    COOLING_FACT_KINDS.has(value.kind as FactKind) &&
    isCooldownFactScope(value.scope) &&
    scopeIsContainedByTarget(value.scope, target);
}

function isClearedGroup<T>(
  value: unknown,
  isItem: (item: unknown) => item is T,
): value is { count: number; items: T[] } {
  if (!isRecord(value) || !hasExactKeys(value, ["count", "items"]) ||
      typeof value.count !== "number" || !Number.isSafeInteger(value.count) ||
      value.count < 0 || !Array.isArray(value.items)) {
    return false;
  }
  return value.count === value.items.length && value.items.every(isItem);
}

function isExactCooldownTarget(
  value: unknown,
  expected: CooldownClearResult["target"],
): value is CooldownClearResult["target"] {
  if (!isRecord(value)) return false;
  const keys = [
    "provider",
    ...(expected.model === undefined ? [] : ["model"]),
    ...(expected.credential === undefined ? [] : ["credential"]),
  ];
  return hasExactKeys(value, keys) &&
    value.provider === expected.provider &&
    (expected.model === undefined || value.model === expected.model) &&
    (expected.credential === undefined || value.credential === expected.credential);
}

function isCooldownClearResult(
  value: unknown,
  target: CooldownClearResult["target"],
): value is CooldownClearResult {
  if (!isRecord(value) || !hasExactKeys(value, ["target", "cleared"]) ||
      !isExactCooldownTarget(value.target, target) || !isRecord(value.cleared) ||
      !hasExactKeys(value.cleared, ["breakerCells", "credentialFaults", "facts"])) {
    return false;
  }
  return isClearedGroup(value.cleared.breakerCells, (item): item is CooldownClearCell =>
    isCooldownCell(item, target)) &&
    isClearedGroup(value.cleared.credentialFaults, (item): item is CooldownClearCell =>
      isCooldownCell(item, target)) &&
    isClearedGroup(value.cleared.facts, (item): item is CooldownClearFact =>
      isCooldownFact(item, target));
}

type CooldownClearOption =
  | { readonly semantic: "credential" | "config" | "provider"; readonly takesValue: true }
  | { readonly semantic: "json" | "refresh"; readonly takesValue: false };

const COOLDOWN_CLEAR_OPTIONS: ReadonlyMap<string, CooldownClearOption> = new Map([
  ["--credential", { semantic: "credential", takesValue: true }],
  ["--json", { semantic: "json", takesValue: false }],
  ["--config", { semantic: "config", takesValue: true }],
  ["-c", { semantic: "config", takesValue: true }],
  ["--provider", { semantic: "provider", takesValue: true }],
  ["-p", { semantic: "provider", takesValue: true }],
  ["--refresh", { semantic: "refresh", takesValue: false }],
  ["-r", { semantic: "refresh", takesValue: false }],
]);

const CLI_COMMAND_NAMES: ReadonlySet<string> = new Set([
  "onboard", "setup", "keys", "check-keys", "models", "ping", "dashboard", "telemetry",
  "offload", "lanes", "dispatch", "cooldowns", "eligibility", "candidates", "cost", "pools",
  "routing", "route", "config", "help", "version",
]);

/** Find a real command token without letting a typoed option/value pair hide a later mutation. */
function rawCliCommand(argv: readonly string[]): string | undefined {
  for (let index = 2; index < argv.length; index++) {
    const arg = argv[index]!;
    if (!arg.startsWith("-")) {
      if (CLI_COMMAND_NAMES.has(arg)) return arg;
      continue;
    }
    const equalsAt = arg.indexOf("=");
    const flag = equalsAt === -1 ? arg : arg.slice(0, equalsAt);
    if (equalsAt === -1 && VALUE_FLAGS.has(flag)) {
      // A missing value before the mutation must reach the strict parser, where it exits 1.
      if (argv[index + 1] === "cooldowns" && argv[index + 2] === "clear") return "cooldowns";
      index += 1;
    }
  }
  return undefined;
}

interface ParsedCooldownClearArgs {
  readonly spec: string;
  readonly credential?: string;
  readonly json: boolean;
}

function parseCooldownClearArgs(argv: readonly string[]): ParsedCooldownClearArgs {
  const positionals: string[] = [];
  const seen = new Set<CooldownClearOption["semantic"]>();
  let credential: string | undefined;
  let json = false;

  for (let index = 2; index < argv.length; index++) {
    const arg = argv[index]!;
    if (!arg.startsWith("-")) {
      positionals.push(arg);
      continue;
    }

    const equalsAt = arg.indexOf("=");
    const flag = equalsAt === -1 ? arg : arg.slice(0, equalsAt);
    const option = COOLDOWN_CLEAR_OPTIONS.get(flag);
    if (option === undefined) cooldownCommandFailure(`unknown option "${flag}"`);
    if (seen.has(option.semantic)) cooldownCommandFailure(`duplicate option "${flag}"`);
    seen.add(option.semantic);

    if (!option.takesValue) {
      if (equalsAt !== -1) cooldownCommandFailure(`${flag} does not take a value`);
      if (option.semantic === "json") json = true;
      continue;
    }

    const value = equalsAt === -1 ? argv[index + 1] : arg.slice(equalsAt + 1);
    if (value === undefined || value.length === 0 || (equalsAt === -1 && value.startsWith("-"))) {
      cooldownCommandFailure(`${flag} requires a value`);
    }
    if (equalsAt === -1) index += 1;
    if (option.semantic === "credential") credential = value;
  }

  if (positionals.length !== 3 || positionals[0] !== "cooldowns" || positionals[1] !== "clear") {
    cooldownCommandFailure("usage: llm-relay cooldowns clear <provider>[/<model>] [--credential <label>] [--json]");
  }
  return {
    spec: positionals[2]!,
    ...(credential === undefined ? {} : { credential }),
    json,
  };
}

function controlErrorMessage(value: unknown): string | null {
  if (!isRecord(value) || !isRecord(value.error) || typeof value.error.message !== "string") return null;
  return value.error.message;
}

/** Clear process-local routing cooldowns through the protected live control plane only. */
export async function runCooldowns(_action: string | undefined, _spec: string | undefined): Promise<void> {
  const parsed = parseCooldownClearArgs(process.argv);
  const { spec, credential } = parsed;
  const { provider, model } = splitSpec(spec);
  if (provider.length === 0 || model === "") {
    cooldownCommandFailure("target must be <provider> or <provider>/<model>");
  }
  if (credential !== undefined && !CREDENTIAL_LABEL_PATTERN.test(credential)) {
    cooldownCommandFailure("--credential must match [A-Za-z0-9_.-]{1,32}");
  }
  const target = {
    provider,
    ...(model === undefined ? {} : { model }),
    ...(credential === undefined ? {} : { credential }),
  };

  const cfg = loadOrExit();
  if (!Object.hasOwn(cfg.providers, provider)) {
    cooldownCommandFailure(`no provider "${provider}" configured`);
  }

  let authorization;
  try {
    authorization = createControlAuthorization(resolveControlAuthorizationConfigDir(cfg.sourcePath));
  } catch {
    cooldownCommandFailure("control authorization is unavailable; the relay must be running with this config");
  }

  let response: Response | null = null;
  try {
    response = await fetch(proxyUrl(cfg, "/cooldowns/clear"), {
      method: "POST",
      headers: authorization.attach({ "content-type": "application/json" }),
      body: JSON.stringify(target),
      signal: AbortSignal.timeout(5000),
    });
  } catch {
    // Report below with the same explicit no-file-fallback outcome for every transport failure.
  }
  if (response === null) {
    cooldownCommandFailure("the relay must be running to clear cooldowns");
  }

  let payload: unknown;
  try {
    payload = await response.json();
  } catch {
    cooldownCommandFailure("the running relay returned an invalid cooldown-clear response");
  }
  if (!response.ok) {
    const detail = controlErrorMessage(payload);
    cooldownCommandFailure(`the running relay rejected the clear${detail === null ? "" : `: ${detail}`}`);
  }
  if (!isCooldownClearResult(payload, target)) {
    cooldownCommandFailure("the running relay returned an invalid cooldown-clear response");
  }

  if (parsed.json) {
    process.stdout.write(JSON.stringify(payload, null, 2) + "\n");
    return;
  }

  const targetLabel = `${provider}${model === undefined ? "" : `/${model}`}${credential === undefined ? "" : ` [credential ${credential}]`}`;
  process.stdout.write(`Cleared cooldown state for ${targetLabel}\n`);
  const groups = [
    ["breaker cells", payload.cleared.breakerCells] as const,
    ["credential faults", payload.cleared.credentialFaults] as const,
  ];
  for (const [label, group] of groups) {
    process.stdout.write(`  ${label}: ${group.count}\n`);
    for (const cell of group.items) {
      process.stdout.write(`    ${cell.provider}/${cell.model ?? "*"} [credential ${cell.credential}]\n`);
    }
  }
  process.stdout.write(`  cooling facts: ${payload.cleared.facts.count}\n`);
  for (const fact of payload.cleared.facts.items) {
    process.stdout.write(`    ${fact.kind} ${describeScope(fact.scope)}\n`);
  }
}

export type DashboardBrowserOpener = (url: string) => Promise<void> | void;

export interface DashboardBrowserProcess {
  once(event: "error", listener: () => void): DashboardBrowserProcess;
  once(event: "close", listener: (code: number | null, signal: NodeJS.Signals | null) => void): DashboardBrowserProcess;
  /** Best-effort termination for a hung native helper; callers still settle independently. */
  kill(signal?: NodeJS.Signals): boolean;
}

export type DashboardProcessSpawner = (
  command: string,
  args: string[],
  options: { readonly detached: boolean; readonly shell: false; readonly stdio: "ignore"; readonly windowsHide: boolean },
) => DashboardBrowserProcess;

export const DASHBOARD_BROWSER_OPEN_TIMEOUT_MS = 5_000;

export interface DashboardCommandDependencies {
  readonly fetch?: typeof fetch;
  readonly openBrowser?: DashboardBrowserOpener;
  readonly now?: () => number;
  readonly write?: (message: string) => void;
}

interface DashboardBootstrapWire {
  readonly schema: typeof DASHBOARD_BOOTSTRAP_SCHEMA;
  readonly bootstrap: string;
  readonly expiresAt: string;
}

function isDashboardBootstrapWire(value: unknown, now: number): value is DashboardBootstrapWire {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const record = value as Record<string, unknown>;
  const keys = Object.keys(record);
  if (keys.length !== 3 || !keys.every((key) => key === "schema" || key === "bootstrap" || key === "expiresAt")) return false;
  if (record.schema !== DASHBOARD_BOOTSTRAP_SCHEMA || typeof record.bootstrap !== "string") return false;
  // This is a capability, not merely opaque text: accept only a canonical 32-byte base64url
  // encoding so alternate spellings cannot reach the dashboard fragment or session exchange.
  if (!/^[A-Za-z0-9_-]{43}$/.test(record.bootstrap)) return false;
  let decoded: Buffer;
  try {
    decoded = Buffer.from(record.bootstrap, "base64url");
  } catch {
    return false;
  }
  if (decoded.byteLength !== 32 || decoded.toString("base64url") !== record.bootstrap) return false;
  if (!isDashboardUtcTimestamp(record.expiresAt)) return false;
  const expiresAt = Date.parse(record.expiresAt);
  return Number.isFinite(expiresAt) && expiresAt > now;
}

/** Open a URL through the platform's native launcher without shell interpolation. */
export function openDashboardInBrowser(
  url: string,
  platform: NodeJS.Platform = process.platform,
  spawnProcess: DashboardProcessSpawner = spawn,
  timeoutMs = DASHBOARD_BROWSER_OPEN_TIMEOUT_MS,
): Promise<void> {
  let command: string;
  let args: string[];
  if (platform === "win32") {
    command = "rundll32.exe";
    args = ["url.dll,FileProtocolHandler", url];
  } else if (platform === "darwin") {
    command = "open";
    args = [url];
  } else if (platform === "linux") {
    command = "xdg-open";
    args = [url];
  } else {
    return Promise.reject(new Error("no supported browser launcher"));
  }
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs <= 0) return Promise.reject(new Error("invalid browser launcher timeout"));

  return new Promise((resolve, reject) => {
    let child: DashboardBrowserProcess;
    try {
      child = spawnProcess(command, args, {
        detached: false,
        shell: false,
        stdio: "ignore",
        windowsHide: true,
      });
    } catch {
      reject(new Error("browser launcher unavailable"));
      return;
    }
    let settled = false;
    let timer: NodeJS.Timeout | undefined;
    const settle = (error?: Error) => {
      if (settled) return;
      settled = true;
      if (timer !== undefined) clearTimeout(timer);
      if (error) reject(error);
      else resolve();
    };
    timer = setTimeout(() => {
      try {
        child.kill("SIGTERM");
      } catch {
        // A launcher that already exited or cannot be signalled still gets the fallback below.
      }
      settle(new Error("browser launcher timed out"));
    }, timeoutMs);
    child.once("error", () => settle(new Error("browser launcher unavailable")));
    child.once("close", (code, signal) => {
      if (code === 0 && signal === null) settle();
      else settle(new Error("browser launcher failed"));
    });
  });
}

/**
 * Get one opaque bootstrap from an already-running relay and launch its read-only dashboard.
 * The persistent control capability stays exclusively in this request header; only the one-use
 * bootstrap may appear in the fallback link when no browser can be opened.
 */
export async function runDashboardCommand(
  cfg: Config,
  dependencies: DashboardCommandDependencies = {},
): Promise<void> {
  const request = dependencies.fetch ?? fetch;
  const now = dependencies.now ?? Date.now;
  const write = dependencies.write ?? ((message: string) => process.stdout.write(message));
  const openBrowser = dependencies.openBrowser ?? openDashboardInBrowser;
  let authorization;
  try {
    // Unlike tokenless status helpers, dashboard bootstrap must fail closed if this cannot load.
    authorization = createControlAuthorization(resolveControlAuthorizationConfigDir(cfg.sourcePath));
  } catch {
    throw new Error("dashboard control authorization is unavailable");
  }

  let response: Response;
  try {
    response = await request(proxyUrl(cfg, "/dashboard/api/v1/bootstrap"), {
      method: "POST",
      headers: authorization.attach({
        Accept: DASHBOARD_MEDIA_TYPE,
        "Content-Type": "application/json",
      }),
      body: JSON.stringify({ schema: DASHBOARD_BOOTSTRAP_REQUEST_SCHEMA }),
      signal: AbortSignal.timeout(5000),
    });
  } catch {
    throw new Error("could not contact the running relay dashboard");
  }

  if (response.status !== 200 || response.headers.get("content-type") !== DASHBOARD_MEDIA_TYPE) {
    throw new Error("running relay rejected the dashboard bootstrap request");
  }
  let payload: unknown;
  try {
    payload = await response.json();
  } catch {
    throw new Error("running relay returned an invalid dashboard bootstrap response");
  }
  if (!isDashboardBootstrapWire(payload, now())) {
    throw new Error("running relay returned an invalid dashboard bootstrap response");
  }

  const url = `${proxyUrl(cfg, "/dashboard/")}#bootstrap=${encodeURIComponent(payload.bootstrap)}`;
  try {
    await openBrowser(url);
  } catch {
    write(`llm-relay dashboard: browser unavailable. Open this one-use link before it expires:\n${url}\n`);
  }
}

export type CostWindow = "1h" | "24h" | "7d" | "30d" | "all";

/** The cost roll-up's dependencies; every default is overridable for tests. */
export interface CostCommandDependencies {
  readonly now?: () => number | Date | string;
  readonly write?: (message: string) => void;
  readonly exit?: (code: number) => never;
  /** Overrides the store directory; defaults to the production `~/.llm-relay/usage/`. */
  readonly usageDir?: string;
}

/** `--window` spelling → the projector's WindowId. `all` is the CLI's lifetime alias. */
const COST_WINDOWS: Readonly<Record<CostWindow, "1h" | "24h" | "7d" | "30d" | "today" | "month" | "lifetime">> = {
  "1h": "1h",
  "24h": "24h",
  "7d": "7d",
  "30d": "30d",
  all: "lifetime",
};

/**
 * Render one spend cell as USD WITH its basis. Null stays "-" — an unpriced figure is
 * unknown, never $0.00 (the provenance invariant: a guess must not look like a measurement).
 */
function costCell(cell: { amountMicrousd: number | null }): string {
  return cell.amountMicrousd === null ? "-" : `$${(cell.amountMicrousd / 1_000_000).toFixed(4)}`;
}

function costCellBasis(cell: { priceSource: string; tokenBasis: string }): string {
  const price = cell.priceSource === "provider_published" ? "published" : "reference";
  return `${price}, ${cell.tokenBasis}`;
}

/**
 * `llm-relay cost` — the C1 roll-up (open-decisions-2026-08-16.md C1): what did this
 * relay's traffic cost me, in the four provenance-labelled spend cells, optionally with
 * tool-call repair shown as its own share.
 *
 * Reads the LOCAL accounting store files directly (Gap 7 resolution: no HTTP endpoint),
 * so it answers whether or not the proxy is running — but a running proxy holds unflushed
 * in-memory deltas, so recent minutes can lag until its write-behind flush lands.
 */
export async function runCostCommand(dependencies: CostCommandDependencies = {}): Promise<void> {
  const write = dependencies.write ?? ((message: string) => process.stdout.write(message));
  const fail = dependencies.exit ?? ((code: number): never => process.exit(code));
  const windowValue = argValue("--window");
  const byValue = argValue("--by");

  let windowId: CostReportQuery["window"];
  if (windowValue === undefined) windowId = "24h";
  // Object.hasOwn, not `in`: `in` also matches Object.prototype members ("toString",
  // "constructor", …), which would assign an inherited function to windowId and die later
  // inside assertCostReportV1 with an internal message instead of this usage line.
  else if (Object.hasOwn(COST_WINDOWS, windowValue)) windowId = COST_WINDOWS[windowValue as CostWindow];
  else {
    write(`llm-relay cost: --window expects 1h|24h|7d|30d|all (got "${windowValue}")\n`);
    write("Usage: llm-relay cost [--window 1h|24h|7d|30d|all] [--by provider|model|client|credential] [--include-repair] [--json]\n");
    fail(1);
    return;
  }

  let by: CostReportQuery["by"];
  if (byValue === undefined) by = "provider";
  else if (byValue === "provider" || byValue === "model" || byValue === "client" || byValue === "credential") by = byValue;
  else {
    write(`llm-relay cost: --by expects provider|model|client|credential (got "${byValue}")\n`);
    write("Usage: llm-relay cost [--window 1h|24h|7d|30d|all] [--by provider|model|client|credential] [--include-repair] [--json]\n");
    fail(1);
    return;
  }

  // Read-only on purpose: constructing a normal store here would take the writer lease,
  // replay journals and quarantine corrupt shards — all writes against a directory a live
  // relay may be committing to. This reader observes committed snapshots only.
  const store = createAccountingStore({
    ...(dependencies.usageDir !== undefined ? { rootDir: dependencies.usageDir } : {}),
    readOnly: true,
  });
  const port = createDashboardSnapshotReadPort({ accounting: store, relayVersion: currentVersion(), ...(dependencies.now !== undefined ? { now: dependencies.now } : {}) });
  try {
    const report = await port.readCostReport({ window: windowId, includeRepair: hasFlag("--include-repair"), ...(by !== undefined ? { by } : {}) });
    if (hasFlag("--json")) {
      write(JSON.stringify(report, null, 2) + "\n");
      return;
    }
    renderCostReport(report, write);
  } finally {
    store.close();
  }
}

/** Human rendering of one cost report: cells side by side, never blended into one total. */
function renderCostReport(
  report: Awaited<ReturnType<ReturnType<typeof createDashboardSnapshotReadPort>["readCostReport"]>>,
  write: (message: string) => void,
): void {
  if (report.coverage === "empty") {
    write("No accounting data yet.\n\nThe relay records per-request usage under ~/.llm-relay/usage/ once it serves\ntraffic through configured providers. Run the proxy, send a request, then retry.\n");
    return;
  }
  if (report.coverage === "unavailable") {
    write(`llm-relay cost: the local accounting store could not be read${report.coverageReason ? ` (${report.coverageReason})` : ""}.\n`);
    return;
  }

  const rows: TableRow[] = [
    [
      report.by === "credential" ? "Credential" : report.by === "model" ? "Provider/model" : report.by === "client" ? "Client" : "Provider",
      "Requests",
      "Priced",
      "Published/reported",
      "Published/estimated",
      "Reference/reported",
      "Reference/estimated",
      "Unpriced",
      "Partial",
    ],
    ...report.rows.map((row): TableRow => [
      row.key,
      String(row.requests),
      String(row.pricedRequests),
      `${costCell(row.spend.providerPublishedReported)} (${costCellBasis(row.spend.providerPublishedReported)})`,
      `${costCell(row.spend.providerPublishedEstimated)} (${costCellBasis(row.spend.providerPublishedEstimated)})`,
      `${costCell(row.spend.referenceReported)} (${costCellBasis(row.spend.referenceReported)})`,
      `${costCell(row.spend.referenceEstimated)} (${costCellBasis(row.spend.referenceEstimated)})`,
      String(row.spend.unpricedRequests),
      String(row.spend.partiallyPricedRequests),
    ]),
    [
      "TOTAL",
      String(report.total.requests),
      String(report.total.pricedRequests),
      `${costCell(report.total.spend.providerPublishedReported)} (${costCellBasis(report.total.spend.providerPublishedReported)})`,
      `${costCell(report.total.spend.providerPublishedEstimated)} (${costCellBasis(report.total.spend.providerPublishedEstimated)})`,
      `${costCell(report.total.spend.referenceReported)} (${costCellBasis(report.total.spend.referenceReported)})`,
      `${costCell(report.total.spend.referenceEstimated)} (${costCellBasis(report.total.spend.referenceEstimated)})`,
      String(report.total.spend.unpricedRequests),
      String(report.total.spend.partiallyPricedRequests),
    ],
  ];
  // The lifetime window declines the serve/repair split (month rollups mix both roles in
  // one figure), so "--include-repair" cannot be honoured there: announcing "repair
  // included" while printing no share table would claim an answer the report does not have.
  const repairDeclinedByWindow = report.includeRepair && report.repair === null && report.window === "lifetime";
  write(`llm-relay cost — ${report.window}${report.includeRepair && !repairDeclinedByWindow ? ", repair included" : ""}\n`);
  if (repairDeclinedByWindow) {
    write("The lifetime window cannot prove the serve/repair split; use a day-bounded window (--window 1h|24h|7d|30d) for the repair share.\n");
  }
  write(`${formatTextTable(rows)}\n`);

  if (report.repair !== null) {
    const share = report.repair;
    const repairRows: TableRow[] = [
      ["Repair attempts", "Priced", "Published/reported", "Published/estimated", "Reference/reported", "Reference/estimated", "Unpriced"],
      [
        String(share.attempts),
        String(Math.max(0, share.attempts - share.unpricedAttempts)),
        `${costCell(share.spend.providerPublishedReported)} (${costCellBasis(share.spend.providerPublishedReported)})`,
        `${costCell(share.spend.providerPublishedEstimated)} (${costCellBasis(share.spend.providerPublishedEstimated)})`,
        `${costCell(share.spend.referenceReported)} (${costCellBasis(share.spend.referenceReported)})`,
        `${costCell(share.spend.referenceEstimated)} (${costCellBasis(share.spend.referenceEstimated)})`,
        String(share.unpricedAttempts),
      ],
    ];
    write(`\nTool-call repair share (role:"repair" attempts only):\n${formatTextTable(repairRows)}\n`);
  }

  if (report.coverage === "partial") {
    // "partial" means the store held (or should have held) data this report could not
    // include — a dropped row, an overflowed counter, a capped read, an unreadable
    // shard. A request that simply carried no token kind (e.g. no cache tokens
    // reported) is NOT this: it shows as "-" on its own cell with provenance
    // "unknown", and the report around it still reads "complete".
    write(`Coverage: partial${report.coverageReason ? ` (${report.coverageReason})` : ""}.\nSome data the store held is not reflected in this report; the roll-up is a lower bound on real spend.\n`);
  }
  write(
    "\nPrices are each deployment's published per-(provider, model) figures, or another provider's\n" +
    "figure for the same model id (labelled reference); there is no fallback price. Cache token kinds\n" +
    "are NOT priced (no published factor), so requests carrying them count under Partial and every\n" +
    "amount is a LOWER BOUND while Partial > 0. Cells are never blended: the only single-figure total\n" +
    "is Published/reported, printed above with its basis. Repair attempts are excluded unless\n" +
    "--include-repair was given." +
    (report.recentMinutesMayLag ? "\nA running relay flushes its ledger to disk shortly after each request; the most recent\nminutes may lag until then." : "") +
    "\n",
  );
}

export interface DashboardCommandRouteDependencies {
  readonly loadConfig: () => Config;
  readonly runDashboard: (cfg: Config) => Promise<void>;
  readonly reportError: (error: unknown) => void;
  readonly runProxy: () => unknown;
}

/** The real final command dispatch: dashboard returns before any proxy/store/signal lifecycle. */
export function dispatchDashboardOrProxy(
  positional: string | undefined,
  dependencies: DashboardCommandRouteDependencies,
): unknown {
  if (positional === "dashboard") {
    const cfg = dependencies.loadConfig();
    void dependencies.runDashboard(cfg).catch(dependencies.reportError);
    return undefined;
  }
  return dependencies.runProxy();
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
 * `llm-relay lanes [--probe]` — what each cli lane's own tool says it serves.
 *
 * ⚠ `--probe` is the ONE place the relay runs a lane's command, and only as an explicit operator
 * action — same precedent as `pools --probe` sending real completions. The request path reads the
 * cached manifest and never spawns anything. Without `--probe` this just prints the cache.
 */
export function runLanes(): void {
  const cfg = loadOrExit();
  if (hasFlag("--probe")) {
    for (const r of probeLanes(cfg)) {
      process.stdout.write(
        r.ok
          ? `  ✓ ${r.lane.padEnd(8)} ${String(r.modelCount).padStart(3)} models via \`${r.via}\`
`
          : `  ✗ ${r.lane.padEnd(8)} ${r.error}
`,
      );
    }
  }

  const manifest = loadLaneManifest();
  if (!manifest || Object.keys(manifest.lanes).length === 0) {
    // Never phrased as "no models" — an unprobed lane is UNKNOWN, and nothing is evicted on it.
    process.stdout.write("\nNo lane manifest yet. Run `llm-relay lanes --probe`.\n");
    process.stdout.write("Until then every cli rung is treated as unknown and nothing is evicted.\n");
    return;
  }

  for (const [lane, entry] of Object.entries(manifest.lanes)) {
    process.stdout.write(`
${lane} — ${entry.models.length} models, probed ${entry.probedAt} via \`${entry.via}\`
`);
    for (const m of entry.models) {
      const supports = m.supports
        ? Object.entries(m.supports).map(([k, v]) => `${k}=${v.join("|")}`).join("  ")
        : "";
      process.stdout.write(`  ${m.id.padEnd(28)} ${supports}
`);
    }
    for (const [model, args] of Object.entries(entry.rejectedArgs ?? {})) {
      process.stdout.write(`  ⚠ ${model} rejects: ${args.join(", ")} (observed)
`);
    }
  }

  // What the CONFIG names that the manifest contradicts — the reason this command exists.
  const bad: string[] = [];
  const ladders = cfg.routing.ladders ?? {};
  for (const rung of [...Object.values(ladders).flat(), ...(cfg.routing.ladder ?? [])]) {
    if (rung?.kind !== "cli" || !rung.command || !rung.args) continue;
    const i = rung.args.indexOf("--model");
    const model = i >= 0 ? rung.args[i + 1] : undefined;
    if (!model) continue;
    const v = verifyModel(manifest, rung.command, model);
    if (v.status === "not-servable" && !bad.includes(v.reason)) bad.push(v.reason);
  }
  if (bad.length > 0) {
    process.stdout.write(`
⚠ ${bad.length} configured rung(s) name a model their lane does not serve:
`);
    for (const b of bad) process.stdout.write(`  ${b}
`);
    process.stdout.write("These are removed from the ladder and their command is withheld.\n");
  }
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
    observedContextLimit,
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
      manifest: loadLaneManifest(),
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
      const basis =
        l.contextWindowSource === "observed"
          ? "learned from what this deployment stated when it refused an over-length request"
          : l.contextWindowSource === "snapshot"
            ? "synced snapshot, same model id on another host"
            : "published by the serving provider";
      // Say how much of a pool the reported minimum actually covers. Without it, a floor drawn
      // from 28 of 29 members reads identically to one drawn from all of them.
      const coverage =
        l.contextWindowUnknownMembers !== undefined
          ? `; ${l.contextWindowUnknownMembers} pool member${l.contextWindowUnknownMembers === 1 ? "" : "s"} unmeasured`
          : "";
      process.stdout.write(
        l.contextWindow === undefined
          ? `   context: nothing known for this spec — the variable is omitted and the CLI uses its own default\n`
          : `   context: ${l.contextWindow.toLocaleString("en-US")} tokens (${basis}${coverage})\n`,
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

/**
 * The EFFECTIVE freeOnly of one rule, rendered for `offload status`.
 *
 * ⚠ Never print the bare optional. An UNSET flag is not one answer: `freeOnlyApplies` in
 * server.ts is `rule.freeOnly ?? rerouted`, so unset means ON for offload-rerouted traffic
 * (including an `@relay:` directive) and OFF for a directly addressed `pool/<name>` spec.
 * Collapsing either way misdescribes half the traffic — printing "OFF" invites a spend the
 * owner believes guarded; printing "ON" promises a refusal that never comes for a direct pool.
 */
function formatFreeOnly(declared: boolean | undefined): string {
  return declared === undefined ? "ON (default)" : declared ? "ON (explicit)" : "OFF (explicit)";
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
    // A live proxy predating the field omits it — same gap as a missing dead-rule warning, so fall
    // back to the local config rather than labelling an explicitly-false rule "ON (default)".
    const declared = state.freeOnlyDeclared ?? offloadRule(cfg, client).freeOnly;
    process.stdout.write(`  freeOnly: ${formatFreeOnly(declared)}\n`);
  } else if (Object.keys(configuredClients).length > 0) {
    process.stdout.write(
      "\n" +
        formatTextTable(
          [
            ["client", "enabled", "scope", "freeOnly"],
            ...Object.entries(configuredClients).map(([name, rule]: [string, OffloadRule]) => [
              FRONT_DOOR_CLIENTS.includes(name) ? name : `${name} ⚠`,
              rule.enabled ? "ON" : "OFF",
              rule.scope,
              formatFreeOnly(rule.freeOnly),
            ]),
          ],
          "  ",
        ) +
        "\n",
    );
    // The legend is part of the table's contract: without it "ON (default)" reads as a bare ON
    // and the two-sided unset default is exactly the transparency gap this column exists to close.
    process.stdout.write(
      `  freeOnly is the money guard. Unset defaults ON for offload-rerouted traffic\n` +
        `  (subagent reroutes and \`@relay:\` directives) and OFF for a directly addressed \`pool/<name>\`.\n`,
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

/**
 * `llm-relay eligibility` — what backends have said about themselves, and what has not been
 * understood yet.
 *
 * This is the review gate of the two-tier design in `refusal-interpretation.ts`. The request path
 * applies only CONFIRMED interpretations; anything unrecognized lands in `pending` having changed
 * nothing, and reaches routing only once accepted here. That ordering is what keeps a researched
 * verdict — a model's opinion about what a vendor's error message means — out of the live request
 * path, in line with the repair boundary that governs the rest of this project.
 *
 * The research tier writes through `propose` and a human (or an agent explicitly acting for one)
 * commits with `accept`. `reject` is the equally valid answer "this message means nothing durable"
 * — a policy refusal or a transient fault should teach the router nothing at all.
 */
function eligibilityScopeArgs(scope: ScopeTemplate): string {
  if (scope.kind !== "group") return scope.kind;
  return `group --members ${quoteArg(scope.members.join(","))}${scope.credential === "all" ? " --all-credentials" : ""}`;
}

function eligibilityResetArgs(reset: ResetRule | undefined): string {
  if (!reset) return "";
  return reset.kind === "field"
    ? ` --reset-field ${quoteArg(reset.field)}`
    : ` --reset-ms ${reset.ms}`;
}

function eligibilityAcceptCommand(
  index: number,
  cls: FactKind,
  scope: ScopeTemplate,
  reset: ResetRule | undefined,
): string {
  return `llm-relay eligibility accept ${index} --class ${cls} --scope ${eligibilityScopeArgs(scope)}${eligibilityResetArgs(reset)}`;
}

export function runEligibility(sub: string | undefined, arg: string | undefined): void {
  const pending = pendingRefusals();
  const action = sub ?? "status";

  if (action === "accept" || action === "reject" || action === "propose") {
    // Addressed by list POSITION, not by signature: a signature is a whole normalized error
    // message and nobody is retyping one at a shell.
    const idx = Number(arg);
    const entry = Number.isInteger(idx) && idx >= 1 && idx <= pending.length ? pending[idx - 1] : undefined;
    if (!entry) {
      process.stderr.write(`llm-relay eligibility: ${action} expects a pending item number 1..${pending.length}\n`);
      process.exit(1);
      return;
    }
    if (action === "reject") {
      rejectInterpretation(entry.signature);
      flushInterpretations();
      process.stdout.write(`rejected — "${entry.normalized}" will keep teaching the router nothing.\n`);
      return;
    }
    const cls = argValue("--class") as FactKind | undefined;
    const rationale = argValue("--rationale") ?? "";
    // Derived from the store, never hand-listed: a kind it accepts but this rejects is invisible
    // until somebody tries to use it, and `rate-limited` shipped exactly that way.
    const classes = FACT_KINDS;
    if (!cls || !classes.includes(cls)) {
      process.stderr.write(`llm-relay eligibility: --class expects one of ${classes.join(" | ")}\n`);
      process.exit(1);
      return;
    }
    // ⚠ A group needs its MEMBERS named, here and at review time. There is no group registry and
    // no prefix inference, so the only way a verdict covers a family is by listing the family —
    // which means whoever accepts it sees exactly what it will cover.
    const scopeName = argValue("--scope") ?? "deployment";
    const members = (argValue("--members") ?? "").split(",").map((s) => s.trim()).filter(Boolean);
    if (scopeName === "group" && members.length === 0) {
      process.stderr.write(`llm-relay eligibility: --scope group requires --members <id,id,...>\n`);
      process.exit(1);
      return;
    }
    const allCredentials = hasFlag("--all-credentials");
    if (!["attempt", "deployment", "credential", "provider", "group", "model"].includes(scopeName)) {
      process.stderr.write(`llm-relay eligibility: --scope expects attempt | group | deployment | credential | provider | model\n`);
      process.exit(1);
      return;
    }
    if (allCredentials && scopeName !== "group") {
      process.stderr.write("llm-relay eligibility: --all-credentials is valid only with --scope group\n");
      process.exit(1);
      return;
    }
    const scope: ScopeTemplate = scopeName === "group"
      ? { kind: "group", members, credential: allCredentials ? "all" : "attempt" }
      : { kind: scopeName as "attempt" | "deployment" | "credential" | "provider" | "model" };
    // WHEN it clears, which is the third thing a reviewer knows. `--reset-field` names a JSON key
    // in the message itself (Google's RetryInfo uses `retryDelay`) and is preferred, because it is
    // read from the real response every time; `--reset-ms` is the reviewer asserting a window the
    // provider never states, and is used only when the response says nothing.
    const resetField = argValue("--reset-field");
    const resetMsRaw = argValue("--reset-ms");
    let reset: ResetRule | undefined;
    if (resetField) reset = { kind: "field", field: resetField };
    else if (resetMsRaw !== undefined) {
      const ms = Number(resetMsRaw);
      if (!Number.isFinite(ms) || ms <= 0) {
        process.stderr.write(`llm-relay eligibility: --reset-ms expects a positive number of milliseconds\n`);
        process.exit(1);
        return;
      }
      reset = { kind: "fixed", ms };
    }
    const shown = scopeName === "group"
      ? `group of ${members.length} (${allCredentials ? "all credentials" : "current credential slot"})`
      : scopeName;
    if (action === "propose") {
      proposeInterpretation(entry.signature, { class: cls, scope, rationale, ...(reset ? { reset } : {}) });
      flushInterpretations();
      process.stdout.write(
        `proposed ${cls} (${shown}) — not yet binding. Commit with: ${eligibilityAcceptCommand(idx, cls, scope, reset)}\n`,
      );
      return;
    }
    acceptInterpretation(entry.signature, { override: { class: cls, scope, ...(reset ? { reset } : {}) } });
    flushInterpretations();
    process.stdout.write(`accepted ${cls} (${shown}) — now applied to ${entry.provider}/${entry.model ?? "-"} refusals matching this message.\n`);
    return;
  }

  const observations = allFacts();
  process.stdout.write(`\nLearned target facts — ${observations.length} live\n`);
  if (observations.length === 0) {
    process.stdout.write("  (nothing; every deployment is presumed servable until it says otherwise)\n");
  }
  for (const o of observations) {
    const mins = Math.max(0, Math.round((o.until - Date.now()) / 60000));
    // Spelled out because the classes are NOT interchangeable and a bare label invites the
    // reading this whole design exists to prevent — that a spent allowance means "paid".
    const meaning = o.kind === "allowance-exhausted"
      ? "free, but spent until it refreshes — demoted, never evicted"
      : o.kind === "subscription-required"
        ? "not covered by our plan — excluded from free pools"
        : o.kind === "credential-invalid"
          ? "the provider says this key is bad — every deployment behind it demoted"
          : "gone from the provider — excluded from pools";
    process.stdout.write(`  ${describeScope(o.scope).padEnd(46)} ${o.kind.padEnd(22)} ${meaning}; expires in ${mins}m\n`);
    if (o.scope.kind === "group") {
      // The membership is the whole reason a group verdict is reviewable — show it, always.
      process.stdout.write(`      covers: ${o.scope.members.join(", ")}\n`);
      process.stdout.write(`      credentials: ${o.scope.credentialId ? "current credential slot" : "all credentials for this provider"}\n`);
    }
  }

  process.stdout.write(`\nUnrecognized refusals — ${pending.length} awaiting interpretation\n`);
  if (pending.length === 0) {
    process.stdout.write("  (none; every refusal seen so far was understood)\n");
  }
  pending.forEach((p, i) => {
    process.stdout.write(`\n  [${i + 1}] ${p.provider}/${p.model ?? "-"}  HTTP ${p.status}  ×${p.count}\n`);
    process.stdout.write(`      ${p.normalized}\n`);
    if (p.proposed) {
      // ⚠ The scope is a STRUCTURE now, not a word — interpolating it printed "[object Object]"
      // and produced an accept command that could not run. A review UI that emits an invalid
      // command is worse than none: it teaches the reviewer the tool is broken.
      const sc = p.proposed.scope;
      const scopeLabel = sc.kind === "group"
        ? `group of ${sc.members.length} (${sc.credential === "all" ? "all credentials" : "current credential slot"})`
        : sc.kind;
      process.stdout.write(`      proposed: ${p.proposed.class} [${scopeLabel}] — ${p.proposed.rationale}\n`);
      if (sc.kind === "group") {
        process.stdout.write(`      covers: ${sc.members.join(", ")}\n`);
      }
      process.stdout.write(
        `      accept with: ${eligibilityAcceptCommand(i + 1, p.proposed.class, sc, p.proposed.reset)}\n`,
      );
    }
  });
  if (pending.length > 0) {
    process.stdout.write(
      `\n  These change NOTHING until accepted. To resolve one, research what that message means for\n` +
      `  that provider and model on this account, then:\n` +
      `    llm-relay eligibility propose <n> --class <not-servable|subscription-required|allowance-exhausted|credential-invalid|rate-limited> \\\n` +
      `        --scope <attempt|group|deployment|credential|provider|model> [--members id1,id2] [--all-credentials] --rationale "..."\n` +
      `    llm-relay eligibility accept <n> --class <...> --scope <...>\n` +
      `    llm-relay eligibility reject <n>       # means nothing durable, and is remembered\n` +
      `\n  Scope by what the message STATES, not by a pattern of failures: "credential" means the\n` +
      `  current credential slot; "provider" means all credentials for that provider. Groups stay\n` +
      `  on the current credential slot unless --all-credentials is stated explicitly.\n`,
    );
  }
  process.stdout.write("\n");
}

/** `llm-relay candidates` — every dimension of every offload target, side by side, unranked. */
function candidateCredential(c: Candidate): Candidate["credential"] {
  // A live relay can be one release behind the CLI. Preserve the legacy default-cell view
  // until that process restarts onto the nested diagnostic shape.
  return c.credential ?? {
    label: c.credentialId?.split("#", 2)[1] ?? "default",
    authEnv: null,
    enabled: true,
    models: null,
    state: c.hasKey ? "not-declared" : "declared-missing",
    modelAllowed: true,
  };
}

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
    "credential".padEnd(40) +
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
    "breaker".padEnd(9) +
    "ctx";
  process.stdout.write(head + "\n" + "-".repeat(head.length) + "\n");

  for (const c of view.candidates) {
    const credential = candidateCredential(c);
    const tags = [...c.pools, ...c.subagentTiers.map((t) => `@${t}`)].join(",") || "-";
    const live = c.listed === null ? "?" : c.listed ? "yes" : "NO";
    const ctx = c.contextLength ? `${Math.round(c.contextLength / 1000)}k` : "-";
    // A member that answers 401 on every call read "closed" here — the same as a healthy one —
    // because a credential fault is deliberately not health data and so never reached the
    // breaker's failure fields. It has its own axis now, and it is shown: the reason half a
    // pool can be unusable while every row looks fine is precisely this cell.
    const quota = quotaBreakerLabel(c);
    const breaker = quota
      ? quota
      : c.breaker.open
        ? `OPEN ${Math.round(c.breaker.cooldownRemainingMs / 1000)}s`
        : c.breaker.credentialFault
          ? `AUTH ${c.breaker.lastCredentialStatus ?? ""}`.trim()
          : "closed";
    process.stdout.write(
      c.spec.slice(0, 31).padEnd(32) +
        `${credential.label} (${c.credentialId})`.padEnd(40) +
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
        breaker.padEnd(9) +
        // Provenance inline: "~" = another provider's figure for this model id. A NIM row must
        // never present OpenRouter's ceiling as its own.
        ctx +
        (c.contextLengthSource === "reference" ? "~" : "") +
        (live === "NO" ? "  ⚠UNLISTED" : "") +
        "\n",
    );
    // The resolved ladders print on their own line: raw observations first (what providers
    // said), then the derived view with its basis, so a computed figure never appears without
    // its provenance. Spec §5: unknown stays "-", and a negative remaining prints as-is.
    process.stdout.write(`  quota: ${formatCandidateQuota(c.quota, Date.now())}\n`);
    if (c.availability.length > 0) {
      process.stdout.write(`  availability: ${formatCandidateAvailability(c.availability)}\n`);
    }
    // G2's operator-set refusal ceiling, only when it is REACHED right now — a cap that has not
    // fired is config detail, not routing state, and this table is routing state.
    const capped = formatCandidateHardCap(c.hardCap, Date.now());
    if (capped !== null) process.stdout.write(`  ${capped}\n`);
  }

  const fuzzy = view.candidates.filter((c) => c.capabilityMatch?.match === "fuzzy");
  const srcs = [...new Set(view.candidates.flatMap((c) => c.capabilitySources))].sort();

  // Say out loud how much of the roster is currently unusable. A row-by-row table makes
  // "5 of 14 members can actually serve" something the reader has to notice; a pool that is
  // half dead is worth stating.
  const noKey = view.candidates.filter((c) => candidateCredential(c).state === "declared-missing");
  const disabled = view.candidates.filter((c) => !candidateCredential(c).enabled);
  const modelScopedOut = view.candidates.filter((c) => !candidateCredential(c).modelAllowed);
  const authFault = view.candidates.filter((c) => c.breaker.credentialFault);
  const cooling = view.candidates.filter((c) => c.breaker.open);
  if (noKey.length || disabled.length || modelScopedOut.length || authFault.length || cooling.length) {
    process.stdout.write(
      `\nNot first choice right now (of ${view.candidates.length} credential cells):\n` +
        `  ${authFault.length} auth-faulted, ${cooling.length} cooling — DEMOTED: still tried, but only\n` +
        "    after every other candidate has failed on that request.\n" +
        `  ${noKey.length} missing-key, ${disabled.length} disabled, ${modelScopedOut.length} model-scoped-out\n` +
        "    credential cells cannot start an attempt. Sibling slots for the same target remain eligible.\n" +
        "  `llm-relay keys` says whether a credential is good; `llm-relay pools --probe` is the\n" +
        "  only check that proves a member can actually serve.\n",
    );
  }

  process.stdout.write(
    "\nColumns are independent — weigh them yourself. agentic/coding/BFCL/aider/arena are\n" +
      "capability from DIFFERENT leaderboards and they disagree; verdict/p95 are live behaviour;\n" +
      "quota/breaker/$ are independent availability/cost signals. A blank cell means NOT MEASURED.\n" +
      `  p95 = synthetic probe loop; obs = mean of this proxy's OWN requests. Different samples,\n` +
      `        so they are not merged — and a high "obs" on a top-ranked member is worth seeing\n` +
      `        before pointing bulk work at that pool.\n` +
      `  breaker: "OPEN 42s" = cooling after failures/429; "AUTH 401" = credential fault, demoted\n` +
      `           until it is retried (expires, so a rotated key recovers with no restart).\n` +
      `           "QUOTA 30s (requests/minute, provider-stated)" = the stated/declared allowance is\n` +
      `           SPENT, not sick — demoted behind live members and lifting on its own at the reset.\n` +
      `  CAPPED <axis>/<period> <used>/<cap> = YOUR OWN operator-set hard cap (limits.hard) is\n` +
      `           reached: this cell is refused before any egress and lifts at the UTC boundary.\n` +
      `           "credential-scope" counts every model that key served this period;\n` +
      `           "deployment-scope" counts only this model — whichever the cap was declared at.\n` +
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

/** Render observations without collapsing their axes into a misleading percentage. */
export function formatCandidateQuota(quota: readonly Candidate["quota"][number][], now: number): string {
  if (quota.length === 0) return "-";
  return quota.map((observation) => {
    const ageMs = Math.max(0, now - observation.observedAt);
    const age = ageMs < 1_000 ? "0s" : `${Math.floor(ageMs / 1_000)}s`;
    const period = observation.period === "unknown" ? "-" : observation.period;
    return `${observation.axis}/${period} ${observation.remaining}/${observation.limit} ${observation.basis} age ${age}`;
  }).join("; ");
}

/**
 * Render a REACHED operator-set hard cap (G2), or null when this row has none.
 *
 * The provenance labels are read off the wire object rather than re-typed here: `basis` says the
 * ceiling is the operator's own assertion (not a measurement), and `scope` says whose usage
 * `used` counts — the credential as a whole, or this one deployment — which is exactly where the
 * cap was declared. A reader who cannot tell a declared ceiling from a measured one, or a
 * credential-wide count from a per-model one, cannot act on either.
 */
export function formatCandidateHardCap(hardCap: Candidate["hardCap"], now: number): string | null {
  if (hardCap === null) return null;
  const resets = Math.max(0, Math.round((Date.parse(hardCap.resetsAt) - now) / 1000));
  return (
    `CAPPED ${hardCap.axis}/${hardCap.period} ${hardCap.used}/${hardCap.cap} ` +
    `(${hardCap.basis}, ${hardCap.scope}-scope, resets in ${resets}s)`
  );
}

/**
 * A `quota` cooldown source reads differently from OPEN because it IS different: nothing failed,
 * a stated/declared allowance is merely spent until a known reset. The axis/period/basis detail
 * comes ONLY from this row's own availability ladder saying spent-and-gateable — when the ladder
 * cannot confirm (its localUsed view differs from the router's), the label still renders, without
 * inventing detail. Un-blended, no score: same contract as every column in this table.
 */
function quotaBreakerLabel(c: Candidate): string | null {
  if (c.breaker.cooldownSource !== "quota") return null;
  const seconds = Math.max(0, Math.round(c.breaker.cooldownRemainingMs / 1000));
  const spent = c.availability
    .filter((row) => row.remaining !== null && row.remaining <= 0 && row.routingEligible && row.resetsAt !== null)
    .sort((a, b) => (a.resetsAt ?? 0) - (b.resetsAt ?? 0))[0];
  return spent
    ? `QUOTA ${seconds}s (${spent.axis}/${spent.period}, ${spent.remainingBasis ?? "unknown"})`
    : `QUOTA ${seconds}s`;
}

/**
 * Render the resolved availability ladders WITH every basis. Unknown stays "-" (never 0), a
 * negative remaining prints as-is — overshoot is information — and a learned basis is labelled
 * display-only so nobody reads it as something routing acts on.
 */
export function formatCandidateAvailability(availability: readonly CandidateAvailability[]): string {
  if (availability.length === 0) return "-";
  // One clock for the whole render so rows in a single line cannot disagree by milliseconds.
  const now = Date.now();
  return availability.map((row) => {
    const remaining = row.remaining === null ? "-" : String(row.remaining);
    const limit = row.limit === null ? "-" : String(row.limit);
    const resets =
      row.resetsAt === null
        ? "-"
        : `${Math.max(0, Math.round((row.resetsAt - now) / 1000))}s (${row.resetsAtBasis})`;
    const stale = row.staleObservations > 0 ? ` ${row.staleObservations} stale` : "";
    return `${row.axis}/${row.period} ${remaining} of ${limit} ${row.remainingBasis ?? "unknown"}${stale} resets ${resets}${row.routingEligible ? "" : " display-only"}`;
  }).join("; ");
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
      const oldExclude = dynamic && Array.isArray(dynamic.exclude)
        ? dynamic.exclude.filter((v): v is string => typeof v === "string")
        : [];
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
          ...(action !== "set" && oldExclude.length > 0 ? { exclude: oldExclude } : {}),
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
  let missing = 0;
  let auth = 0;
  for (const name of names) {
    process.stdout.write(`pool/${name}\n`);
    for (const r of results.filter((x) => x.pool === name)) {
      if (r.verdict === "missing") missing++;
      if (r.verdict === "auth") auth++;
      const lat = r.latencyMs !== undefined ? `${r.latencyMs}ms` : "";
      const diagnostic = [
        r.credentialId !== undefined ? `credential=${r.credentialId}` : undefined,
        r.detail,
      ].filter((value): value is string => value !== undefined && value.length > 0).join(" ");
      process.stdout.write(
        `  ${fitCell(icon[r.verdict], 6)} ${fitCell(r.spec, 50)} ${fitCell(lat, 8)} ${diagnostic}\n`,
      );
    }
    process.stdout.write("\n");
  }

  const live = results.filter((r) => r.verdict === "live").length;
  process.stdout.write(`${live}/${results.length} live.\n`);
  if (missing > 0) {
    process.stdout.write(
      `⚠ ${missing} DEAD/missing pool member(s). Remove or replace those deployments in routing.pools — a pool\n` +
        `  ranked by fitness can otherwise put a dead model first and burn a failover hop on every call.\n`,
    );
  }
  if (auth > 0) {
    const credentialIds = [...new Set(results.flatMap((r) =>
      r.verdict === "auth" && r.credentialId !== undefined ? [r.credentialId] : [],
    ))];
    const credentialGuidance = credentialIds.length === 0
      ? "Fix the provider credential configuration"
      : `Fix or disable credential slot${credentialIds.length === 1 ? "" : "s"} ${credentialIds.join(", ")}`;
    process.stdout.write(
      `⚠ ${auth} AUTH result(s). ${credentialGuidance};\n` +
        `  sibling slots and the deployment were not proven dead by this one-slot probe.\n`,
    );
  }
}

import { probeAllPools, type MemberVerdict } from "./pool-health.js";
import { runInteractiveOnboarding } from "./onboarding.js";
import { importKeysFromFile } from "./key-import.js";
import { setupClaudeCli, setupClaudeDesktop } from "./setup-claude.js";
import { getTelemetryReport } from "./telemetry.js";
import { globalCircuitBreaker } from "./circuit-breaker.js";

export function main(): void {
  const rawCommand = rawCliCommand(process.argv);
  const positionals = getPositionalArgs(process.argv);
  const arg2 = positionals[0];
  const arg3 = positionals[1];
  const arg4 = positionals[2];

  // Mutation parsing owns its raw argv so help/version-shaped typos cannot bypass fail-closed
  // validation and turn a scoped clear into a wider request.
  if (rawCommand === "cooldowns" || arg2 === "cooldowns") {
    // Keep validation synchronous at the entrypoint; `runCooldowns` is async, and otherwise a
    // parser failure would become an unobserved rejected promise after main returned.
    parseCooldownClearArgs(process.argv);
    void runCooldowns(arg3, arg4);
    return;
  }

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
    if (hasFlag("--import", "-import")) {
      const importPath = argValue("--import", "-import");
      if (!importPath) {
        process.stderr.write("llm-relay onboard: --import requires a file path\n");
        process.exit(1);
        return;
      }
      try {
        importKeysFromFile(importPath, cfg, { force: hasFlag("--force", "-force") });
      } catch (e) {
        process.stderr.write(`llm-relay onboard: ${(e as Error).message}\n`);
        process.exit(1);
      }
      return;
    }
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
  if (arg2 === "lanes") {
    try {
      runLanes();
    } catch (e) {
      process.stderr.write(`llm-relay lanes: ${(e as Error).message}
`);
      process.exit(1);
    }
    return;
  }
  if (arg2 === "dispatch") {
    runDispatch(arg3).catch((e) => {
      process.stderr.write(`llm-relay dispatch: ${(e as Error).message}\n`);
      process.exit(1);
    });
    return;
  }
  if (arg2 === "eligibility") {
    try {
      runEligibility(arg3, arg4);
    } catch (e) {
      process.stderr.write(`llm-relay eligibility: ${(e as Error).message}\n`);
      process.exit(1);
    }
    return;
  }
  if (arg2 === "candidates") {
    runCandidates().catch((e) => {
      process.stderr.write(`llm-relay candidates: ${(e as Error).message}\n`);
      process.exit(1);
    });
    return;
  }
  if (arg2 === "cost") {
    runCostCommand().catch((e) => {
      process.stderr.write(`llm-relay cost: ${(e as Error).message}\n`);
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
  dispatchDashboardOrProxy(arg2, {
    loadConfig: loadOrExit,
    runDashboard: runDashboardCommand,
    reportError: (e) => {
      process.stderr.write(`llm-relay dashboard: ${(e as Error).message}\n`);
      process.exit(1);
    },
    runProxy,
  });
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
    // Clears process-local relay state through the authenticated mutation plane.
    case "cooldowns":
      return arg3 === "clear" ? "mutating" : "read-only";
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
    // Accepting an interpretation is what makes it bind on the request path, so the three review
    // verbs write; the bare listing only reports.
    case "eligibility":
      return arg3 === "accept" || arg3 === "reject" || arg3 === "propose" ? "mutating" : "read-only";
    case "dashboard":
      return "read-only";
    // keys, check-keys, models, telemetry, dispatch, candidates, pools, ping, help, version —
    // and anything not yet listed. `dispatch -x` is included on purpose: it reports spend to a
    // running proxy's in-memory cooldowns and changes nothing on this machine.
    default:
      return "read-only";
  }
}

/**
 * Entrypoint: fail-closed mutation syntax, then the currency gate (which may replace this install
 * and re-exec), then the command itself. `main` stays synchronous so its exit paths are direct.
 */
export async function run(): Promise<void> {
  // Reject malformed mutation argv before the self-update gate can perform any network request.
  if (rawCliCommand(process.argv) === "cooldowns") parseCooldownClearArgs(process.argv);
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
