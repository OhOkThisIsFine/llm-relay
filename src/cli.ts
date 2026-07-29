#!/usr/bin/env node
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import { loadConfig, type Config, type ConfigOverrides, DEFAULT_DESTRUCTIVE } from "./config.js";
import { loadEnvFile } from "./dotenv.js";
import { offloadState, setOffload, type OffloadState } from "./offload.js";
import { buildCandidates, type CandidatesView, type Candidate } from "./candidates.js";
import { buildDispatch, type DispatchView } from "./dispatch.js";
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

Multi-provider: config declares a providers{} registry; a request's model picks the
route, in this order:
  pool/<name>          routing.pools[<name>] — ALL its candidates, benchmark-ranked
                       with failover. Use to ask for the best available model rather
                       than naming one. An unknown pool is a 400, never a fallback.
  provider/model       verbatim, e.g. "nim/z-ai/glm-5.2". Never re-ranked.
  a Claude model id    substring-matched against routing.tiers (opus|sonnet|haiku|fable).
  anything else        routing.default.

A provider with kind:"anthropic" and NO authEnv is a passthrough: the caller's own
credentials are forwarded untouched. Point the tiers at one to keep real Claude
traffic on real Anthropic while pool/* requests go to other providers.

Claude Code SUBAGENTS (flagged cc_is_subagent=true on the wire) may be OFFLOADED to
other providers while the human's own conversation stays on passthrough. This is OFF
by default and is a deliberate choice, not a background behaviour:

  llm-relay offload on         routing.subagents{} (a tier -> spec map) starts applying
  llm-relay offload off        subagents route like any other request (the default)
  llm-relay offload status     current switch state and where each tier goes
  llm-relay candidates         every dimension of every target, side by side, unranked

The toggle reaches a running proxy over loopback, so it takes effect on the next
request without a restart, and is persisted to the config file.

Independently of the switch, a dispatcher may offload ONE call by putting
"@relay: <spec>" on its own line in that subagent's prompt; the line is stripped
before forwarding, so the model never sees it.

VERIFYING A SETUP — the two checks answer different questions, and the cheap one
can be confidently wrong:
  llm-relay keys           are the CREDENTIALS good? Where a provider serves its
                           /models list publicly, this escalates to an authenticated
                           probe, because a public 200 says nothing about the key.
  llm-relay pools --probe  will each configured MODEL actually answer? The only way
                           to catch a member that is listed and still dead. Run it
                           after editing routing.pools — nothing else detects this.

Keys are read from the environment, and from ~/.llm-relay/.env if present. A variable
already set in the environment always wins over the file.

Usage:
  llm-relay [options]                              Start the proxy server (default)
  llm-relay onboard                                Guided setup for 100%-free providers & subscriptions
  llm-relay setup [claude-cli|claude-desktop]     Configure Claude CLI wrappers or Claude Desktop
  llm-relay keys | check-keys                      Check status of all free & subscription keys
  llm-relay telemetry                              Programmatic JSON metrics and quota report
  llm-relay models [-p <name>] [-r]               List live models per provider
  llm-relay pools [--probe]                        List pool members; --probe tests each for real
  llm-relay ping [-p <name>]                       Probe model latency, stability & quota across providers
  llm-relay offload [on|off|status]                Turn subagent offload on/off (default: off)
  llm-relay dispatch [lane] [-t <task>]            Which lane to hand a delegated task to next
  llm-relay candidates [-p <name>]                 Un-blended decision table for offload targets
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
  offload on | off | status                        Master switch for subagent offload (off by default)
  dispatch [lane]                                  Next lane from routing.ladder; -t/--task to render
                                                   the command, --after <lane> to walk past a spent
                                                   rung, -x/--exhausted <lane> to report one spent,
                                                   --json for the raw view
  candidates                                       Benchmarks, health, quota & breaker state per target
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

Behind a custom ANTHROPIC_BASE_URL, Claude Code drops the 1M-context beta header and
disables Remote Control. Neither is caused by this proxy and neither can be fixed here.
For 1M, launch with a [1m] model suffix:  ANTHROPIC_MODEL='claude-opus-5[1m]' claude

Proxy Server Endpoints:
  POST /v1/messages                                Anthropic Messages proxy with tool repair
  POST /v1/messages/count_tokens                   Local token estimation for OpenAI backends
  POST /v1/chat/completions                        OpenAI-compatible front (OpenAI in, OpenAI out)
  GET /registry                                    Full JSON view of providers, routing & capabilities
  GET /candidates [?provider=]                     Per-target raw benchmarks, health, quota, breaker state
  GET|POST /offload                                Read or set the subagent-offload switch {"enabled":bool}
  GET|POST /dispatch [?lane=&after=&task=]         Next dispatch lane; POST {"exhausted":"<lane>"} to walk on
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
      // Candidate ARRAYS, never a single pinned model. A one-element spec silently disables both
      // benchmarkSort (it only ranks when >1 candidate) and failover — and on NIM "listed" does not
      // mean "servable", so a lone pinned model turns one dead backend into a dead relay.
      default: ["nim/z-ai/glm-5.2", "nim/deepseek-ai/deepseek-v4-pro", "nim/moonshotai/kimi-k2.6"],
      tiers: {
        opus: ["nim/z-ai/glm-5.2", "nim/deepseek-ai/deepseek-v4-pro"],
        sonnet: ["nim/z-ai/glm-5.2", "nim/moonshotai/kimi-k2.6"],
        haiku: ["nim/meta/llama-3.1-8b-instruct", "nim/openai/gpt-oss-20b"],
      },
      // Addressable as `model: pool/<name>` — including from subagent frontmatter, which only
      // accepts a single string and so cannot express a candidate list on its own.
      pools: {
        coding: ["nim/z-ai/glm-5.2", "nim/deepseek-ai/deepseek-v4-pro", "nim/moonshotai/kimi-k2.6"],
        fast: ["nim/meta/llama-3.1-8b-instruct", "nim/openai/gpt-oss-20b"],
      },
      // Where subagents go WHEN offload is on. Inert while `offload` is false.
      subagents: { opus: "pool/coding", sonnet: "pool/coding", haiku: "pool/fast", default: "pool/coding" },
      // Master switch, off by default: subagents route like everything else until you run
      // `llm-relay offload on`. Silently answering as a different vendor's model has to be chosen.
      offload: false,
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

let envFileLoaded = false;

/**
 * Merge `~/.llm-relay/.env` into the environment, once per process, before anything reads
 * a key or expands a `${ENV}` in the config. Already-set variables win.
 */
export function ensureEnvFileLoaded(): void {
  if (envFileLoaded) return;
  envFileLoaded = true;
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
      const str = s.basis === "snapshot" ? ` str ${s.score.toFixed(1)} (${s.signalCount} signals)` : "";
      const lim = await catalog.limits(name, p, m).catch(() => null);
      const ctx = lim?.contextLength ? `  ctx ${Math.round(lim.contextLength / 1000)}k` : "";
      const out = lim?.maxOutputTokens ? `  max_out ${lim.maxOutputTokens}` : "";
      process.stdout.write(`  ${m.padEnd(50)}${str}${ctx}${out}\n`);
    }
  }
}

/**
 * Warm every provider's catalog and warn about any routing target the provider
 * does not serve — non-blocking (fire-and-forget) so it never delays listen().
 */
export async function warmAndValidate(cfg: Config, catalog: ModelCatalog): Promise<void> {
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
import { getStrength } from "./benchmarks.js";

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

/**
 * Talk to a RUNNING proxy if there is one. The offload switch has to reach the live process to
 * take effect without a restart, and `candidates` gets better data from it (warm ping history,
 * real breaker state) than a cold CLI process can compute. null = no proxy listening.
 */
async function tryServer(cfg: Config, path: string, init?: RequestInit): Promise<unknown | null> {
  try {
    const res = await fetch(`http://${cfg.host}:${cfg.port}${path}`, {
      ...init,
      signal: AbortSignal.timeout(5000),
    });
    if (!res.ok) return null;
    return await res.json();
  } catch {
    return null;
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

  if (spent) {
    const live = await tryServer(cfg, "/dispatch", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ exhausted: spent }),
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
  const path = `/dispatch${qs.toString() ? `?${qs}` : ""}`;

  const live = (await tryServer(cfg, path)) as DispatchView | null;
  const view =
    live ??
    buildDispatch(cfg, {
      ...(task ? { task } : {}),
      ...(lane ? { lane } : {}),
      ...(after ? { after } : {}),
    });

  if (hasFlag("--json")) {
    process.stdout.write(JSON.stringify(view, null, 2) + "\n");
    return;
  }

  process.stdout.write(`subagent offload: ${view.offload ? "ON" : "OFF"}\n`);
  if (!live) process.stdout.write(`(no proxy running — live exhaustion state unknown)\n`);
  process.stdout.write("\n");

  for (const l of view.ladder) {
    const mark = view.next && l.id === view.next.id ? "->" : "  ";
    const state = l.state === "ready" ? "" : ` [${l.state}${l.readyAt ? ` until ${l.readyAt}` : ""}]`;
    const target = l.kind === "cli" ? `${l.invoke?.command ?? ""} ${(l.invoke?.args ?? []).join(" ")}` : (l.spec ?? "");
    process.stdout.write(`${mark} ${l.position}. ${l.id}${state}\n     ${target}\n`);
    if (l.requiresDirective) {
      process.stdout.write(`     needs "@relay: ${l.spec}" in the subagent prompt (offload is off)\n`);
    }
    if (l.note) process.stdout.write(`     ${l.note}\n`);
  }

  process.stdout.write(`\n${view.next ? `use: ${view.next.id}` : "no lane available"} — ${view.reason}\n`);
}

/** `llm-relay offload [on|off|status]` — the subagent-offload master switch. */
export async function runOffload(arg: string | undefined): Promise<void> {
  const cfg = loadOrExit();
  const want = arg === "on" || arg === "enable" ? true : arg === "off" || arg === "disable" ? false : null;

  if (want === null && arg !== undefined && arg !== "status") {
    process.stderr.write(`llm-relay offload: expected "on", "off" or "status" (got "${arg}")\n`);
    process.exit(1);
  }

  const live = (await tryServer(
    cfg,
    "/offload",
    want === null
      ? undefined
      : { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ enabled: want }) },
  )) as OffloadState | null;

  // No proxy listening: still honour the change by writing the file, but say plainly that
  // nothing is running to apply it to.
  const state = live ?? (want === null ? offloadState(cfg) : setOffload(cfg, want));

  process.stdout.write(`subagent offload: ${state.enabled ? "ON" : "OFF"}\n`);
  // Only a real change reports where it went; a status read must not imply it wrote anything.
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

  if (state.enabled) {
    const entries = Object.entries(state.subagents);
    if (entries.length === 0) {
      process.stdout.write("  ⚠ routing.subagents is empty — offload is on but routes nowhere\n");
    } else {
      process.stdout.write("\n  tier      -> target\n");
      for (const [tier, spec] of entries) process.stdout.write(`  ${tier.padEnd(9)} -> ${spec}\n`);
    }
  } else {
    process.stdout.write("\n  Subagents route like any other request (Anthropic passthrough).\n");
    process.stdout.write("  An `@relay: <spec>` line in a subagent prompt still offloads that one call.\n");
  }
}

function fmt(v: number | null | undefined, suffix = ""): string {
  return v === null || v === undefined ? "-" : `${v}${suffix}`;
}

/**
 * How much to trust the strength number. A score from 5 leaderboards and a score from "nothing is
 * known, assume neutral" must never render identically.
 */
function strengthTag(c: Candidate): string {
  switch (c.sortInputs.strengthBasis) {
    case "snapshot":
      return `/${c.sortInputs.strengthSignals.length}`;
    case "telemetry":
      return " obs";
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

  process.stdout.write(`Offload targets — offload is ${view.offload_enabled ? "ON" : "OFF"}\n`);
  process.stdout.write(`${view.note}\n\n`);

  const head =
    "target".padEnd(32) +
    "pools / tiers".padEnd(24) +
    "str".padEnd(11) +
    "agentic".padEnd(9) +
    "coding".padEnd(8) +
    "BFCL".padEnd(7) +
    "aider".padEnd(7) +
    "arena".padEnd(7) +
    "$/Mout".padEnd(8) +
    "verdict".padEnd(10) +
    "p95".padEnd(8) +
    "quota".padEnd(7) +
    "breaker".padEnd(9) +
    "ctx";
  process.stdout.write(head + "\n" + "-".repeat(head.length) + "\n");

  for (const c of view.candidates) {
    const tags = [...c.pools, ...c.subagentTiers.map((t) => `@${t}`)].join(",") || "-";
    const live = c.listed === null ? "?" : c.listed ? "yes" : "NO";
    const ctx = c.contextLength ? `${Math.round(c.contextLength / 1000)}k` : "-";
    const breaker = c.breaker.open ? `OPEN ${Math.round(c.breaker.cooldownRemainingMs / 1000)}s` : "closed";
    process.stdout.write(
      c.spec.slice(0, 31).padEnd(32) +
        tags.slice(0, 23).padEnd(24) +
        // The scalar plus how well-evidenced it is: "83.3/4" = 4 published signals behind it,
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
  process.stdout.write(
    "\nColumns are independent — weigh them yourself. agentic/coding/BFCL/aider/arena are\n" +
      "capability from DIFFERENT leaderboards and they disagree; verdict/p95 are live behaviour;\n" +
      "quota/breaker/$ are what it costs to use right now. A blank cell means NOT MEASURED.\n" +
      `  str = the one scalar pool ordering needs. "83.3/4" = 4 published signals behind it;\n` +
      `        "obs" = ranked on this proxy's own traffic, "neut" = nothing known.\n` +
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

/**
 * `llm-relay pools` — list pool members; `--probe` sends a real completion to each.
 *
 * The listing is cheap and offline. The probe is the only thing that can actually catch a
 * member that is configured, catalogued, and nonetheless dead — see pool-health.ts.
 */
export async function runPools(): Promise<void> {
  const cfg = loadOrExit();
  const pools = cfg.routing.pools ?? {};
  const names = Object.keys(pools);
  if (names.length === 0) {
    process.stdout.write("No pools configured (routing.pools).\n");
    return;
  }

  if (!hasFlag("--probe")) {
    for (const name of names) {
      process.stdout.write(`\npool/${name} — ${pools[name]!.length} members\n`);
      for (const spec of pools[name]!) process.stdout.write(`  ${spec}\n`);
    }
    process.stdout.write(`\nMembership only — no liveness checked. Run "llm-relay pools --probe" to test each for real.\n`);
    return;
  }

  process.stdout.write("Probing every pool member with a real completion...\n\n");
  const results = await probeAllPools(cfg);
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
        `  ${icon[r.verdict].padEnd(6)} ${r.spec.padEnd(50)} ${lat.padEnd(8)} ${r.detail ?? ""}\n`,
      );
    }
    process.stdout.write("\n");
  }

  const live = results.filter((r) => r.verdict === "live").length;
  process.stdout.write(`${live}/${results.length} live.\n`);
  if (dead > 0) {
    process.stdout.write(
      `⚠ ${dead} member(s) will never answer (DEAD/AUTH). Remove them from routing.pools — a pool\n` +
        `  ranked by strength can otherwise put a dead model first and burn a failover hop on every call.\n`,
    );
  }
}

import { probeAllPools, DEAD_VERDICTS, type MemberVerdict } from "./pool-health.js";
import { runInteractiveOnboarding } from "./onboarding.js";
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
  if (arg2 === "offload") {
    runOffload(arg3).catch((e) => {
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
