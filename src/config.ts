import { readFileSync } from "node:fs";
import { rankTargetsByBenchmark } from "./benchmarks.js";
import { resolveAuthEnv, credentialState } from "./authEnv.js";

export type Mode = "detect" | "repair" | "strict";

export type AuthHeader = "x-api-key" | "authorization";

export type Kind = "anthropic" | "openai";

export type ProviderTierType = "free" | "mixed" | "subscription";

export interface ReshaperConfig {
  base: string;
  model: string;
  /** "anthropic": call /v1/messages. "openai": call /chat/completions (NIM/vLLM). */
  kind: Kind;
  authEnv?: string;
  authHeader: AuthHeader;
  timeoutMs: number;
}

/** One HTTP backend provider in the registry (NIM, OpenRouter, Gemini API, …). */
export interface ProviderConfig {
  base: string;
  /**
   * "anthropic": provider speaks Anthropic Messages; forward as-is.
   * "openai": provider is OpenAI-compatible (NIM/vLLM/OpenRouter/Gemini-openai);
   * the proxy translates request+response via llm-bridge.
   */
  kind: Kind;
  authEnv?: string;
  /** Which header to inject the provider key into. Default: authorization (openai) / x-api-key (anthropic). */
  authHeader: AuthHeader;
  /** Backend request deadline in ms. Default 120000. */
  timeoutMs: number;
  /** "free": wholly free/free-tier catalog. "mixed": catalog contains free and paid models. */
  tierType?: ProviderTierType;
  /** Web URL where users can sign up or obtain API keys. */
  signupUrl?: string;
}

/**
 * How an inbound request's `model` maps to a provider + backend model.
 *  - `default`: fallback "provider/model" spec (string or array of target specs) when nothing else matches.
 *  - `tiers`: Claude tier name ("opus"/"sonnet"/"haiku"/"fable") → "provider/model" spec or array.
 *  - `pools`: named candidate list addressed as "pool/<name>" — the ranked, discovery-friendly
 *    alternative to pinning one model. A pool resolves to ALL its specs, so `benchmarkSort` ranks
 *    them and the existing failover walks them in order. This is the only routing form that lets a
 *    caller say "the best available coding model" instead of naming one; a bare namespaced spec is
 *    deliberately verbatim and never ranked.
 * A request may also address a provider directly with a namespaced model id
 * ("nim/z-ai/glm-5.2") — the prefix picks the provider, the rest is the model.
 */
export interface Routing {
  default: string | string[];
  tiers: Record<string, string | string[]>;
  pools?: Record<string, string[]>;
  /** Dynamic pool policies are normalized separately from their materialized target arrays. */
  poolPolicies?: Record<string, PoolPolicy>;
  /**
   * Tier → spec for SUBAGENT requests only (`cc_is_subagent=true`). Lets the dispatcher pick a
   * destination with the one per-call knob it actually has — the Agent tool's `model` enum
   * (sonnet|opus|haiku|fable) — without writing an agent file. `default` catches anything that
   * matches no tier. Main-conversation requests never consult this, which is what keeps
   * `routing.tiers` free to stay on an Anthropic passthrough.
   */
  subagents?: Record<string, string>;
  /**
   * Master switch for subagent offload. **Default false** — subagents route exactly like the
   * human's own conversation (i.e. straight to the Anthropic passthrough) until offload is
   * deliberately turned on. Offloading every subagent by default is a surprising, invisible
   * change of who is answering; it has to be a decision.
   *
   * Gates `subagents` ONLY. An explicit `@relay:` directive in a subagent prompt is a per-call
   * opt-in and is honoured whether or not this is on.
   */
  offload?: boolean;
  benchmarkSort?: boolean;
  /**
   * Ordered dispatch ladder consulted by `/dispatch` — which LANE a host agent should hand a
   * whole delegated task to, and in what order to fall back. Distinct from `subagents`, which
   * routes one HTTP turn: a ladder rung may be an agent CLI that never traverses this proxy,
   * because its quota is client-bound and only the vendor's own binary can spend it.
   *
   * Absent means the relay expresses no opinion and dispatch order stays the host's to choose.
   */
  ladder?: LadderRung[];
  /** Tier-specific dispatch ladders. `dispatch --tier <name>` selects one. */
  ladders?: Record<string, LadderRung[]>;
}

/** A fixed preferred prefix followed by automatically discovered free models. */
export interface PoolPolicy {
  preferred: string[];
  include: "free";
}

/**
 * One rung of `routing.ladder`.
 *
 * `cli` rungs are executed by the HOST (the relay never spawns a process — it is a proxy, not a
 * process supervisor); `relay` rungs are addressed through this proxy in the ordinary way.
 * `quota` names the balance a rung draws on so that rungs sharing one are cooled down together
 * and rungs that merely share a binary are not: one CLI can meter two model families against
 * two independent balances, and treating those as one bucket would skip a live lane.
 */
export interface LadderRung {
  id: string;
  kind: "cli" | "relay";
  /** Parked rungs stay visible in the ladder but are never auto-selected. Default true. */
  enabled: boolean;
  quota?: string;
  note?: string;
  /** cli rungs: the binary to run, and its args — one of which must contain the task placeholder. */
  command?: string;
  args?: string[];
  /** relay rungs: the spec to address (`pool/<name>`, `<provider>/<model>`, a provider name). */
  spec?: string;
}

/** Reserved provider-namespace prefix for `pool/<name>` routing. */
export const POOL_PREFIX = "pool";

/**
 * Marker Claude Code stamps into the `system` block of SUBAGENT requests only (verified on wire,
 * Claude Code 2.1.220): `x-anthropic-billing-header: …; cc_entrypoint=…; cc_is_subagent=true;`.
 * Built-in subagents (Explore, general-purpose) carry it too, not just custom `.md` agents.
 *
 * This is what makes tier-based subagent routing safe. Without it, a subagent declaring
 * `model: haiku` and a HUMAN picking Haiku for their own conversation are byte-identical, so any
 * tier→provider mapping silently drops the human's own conversation onto a weak model.
 */
const SUBAGENT_MARKER = "cc_is_subagent=true";

/** Routing directive the dispatcher may put on its own line in a subagent prompt. */
const RELAY_DIRECTIVE = /^[ \t]*@relay:[ \t]*(\S+)[ \t]*$/m;

/** Flatten an Anthropic `system` field (string or content-block array) to plain text. */
function systemText(system: unknown): string {
  if (typeof system === "string") return system;
  if (!Array.isArray(system)) return "";
  return system.map((b) => (typeof b === "string" ? b : ((b as { text?: unknown }).text ?? ""))).join("\n");
}

/** True when this request is a Claude Code SUBAGENT rather than a main conversation. */
export function isSubagentRequest(reqJson: unknown): boolean {
  if (typeof reqJson !== "object" || reqJson === null) return false;
  return systemText((reqJson as { system?: unknown }).system).includes(SUBAGENT_MARKER);
}

/**
 * Read (and optionally strip) an `@relay: <spec>` directive from the dispatcher's prompt.
 *
 * ⚠ Only the LAST text block of `messages[0]` is inspected — that is the dispatcher-authored
 * prompt. Block 0 is Claude Code's injected `<system-reminder>` (CLAUDE.md, date, …) and later
 * messages carry tool results, i.e. file contents. Reading those would let any file the subagent
 * happens to read redirect its own routing.
 */
export function readRelayDirective(reqJson: unknown, strip = false): string | null {
  if (typeof reqJson !== "object" || reqJson === null) return null;
  const messages = (reqJson as { messages?: unknown }).messages;
  if (!Array.isArray(messages) || messages.length === 0) return null;
  const firstMsg = messages[0] as { content?: unknown } | undefined;
  if (!firstMsg) return null;
  const content = firstMsg.content;

  if (typeof content === "string") {
    const m = RELAY_DIRECTIVE.exec(content);
    if (!m) return null;
    if (strip) {
      firstMsg.content = content.replace(RELAY_DIRECTIVE, "").replace(/^\n+/, "");
    }
    return m[1]!;
  }
  if (!Array.isArray(content)) return null;

  // Locate the prompt text block — the last text block in messages[0] that is not a system-reminder.
  let promptBlock: { type?: unknown; text?: unknown } | null = null;
  for (let i = content.length - 1; i >= 0; i--) {
    const block = content[i] as { type?: unknown; text?: unknown };
    if (block?.type !== "text" || typeof block.text !== "string") continue;
    if (block.text.trim().startsWith("<system-reminder>")) continue;
    promptBlock = block;
    break;
  }

  if (!promptBlock || typeof promptBlock.text !== "string") return null;

  const m = RELAY_DIRECTIVE.exec(promptBlock.text);
  if (!m) return null;
  if (strip) {
    promptBlock.text = promptBlock.text.replace(RELAY_DIRECTIVE, "").replace(/^\n+/, "");
  }
  return m[1]!;
}

/**
 * Why routing could not reach this spec, or null when it can.
 *
 * Mirrors what `pickSpecs` + `resolveSingleSpec` will do with it: `pool/<name>` needs a configured
 * pool, anything else needs a declared provider (plus a model id when that provider is openai-kind).
 * Deliberately does NOT accept "detectTier thinks this looks like a Claude id" as resolvable — that
 * route ends at the passthrough, which for a directive means a typo like `opus-coder` is answered
 * by primary quota instead of failing.
 */
function directiveUnresolvableReason(spec: string, cfg: Config): string | null {
  const names = (o: object | undefined) => Object.keys(o ?? {}).join(", ") || "none";
  const { provider, model } = splitSpec(spec);
  if (provider === POOL_PREFIX) {
    if (model && cfg.routing.pools?.[model]) return null;
    return `names unknown pool "${model ?? ""}" (available: ${names(cfg.routing.pools)})`;
  }
  const p = cfg.providers[provider];
  if (!p) {
    const isDisabled = cfg.warnings?.some((w) => w.includes(`provider "${provider}" DISABLED`));
    if (isDisabled) {
      return `names disabled provider "${provider}" (disabled due to unset environment variable)`;
    }
    return `names unknown provider "${provider}" (available: ${names(cfg.providers)})`;
  }
  if (p.kind === "openai" && !model) return `names openai provider "${provider}" but carries no model id`;
  return null;
}

/**
 * The spec a subagent request should route to, or null to leave routing unchanged.
 *
 * Precedence: an explicit `@relay:` directive (per-call opt-in, works even with offload off) >
 * `routing.subagents[<tier>]` > `routing.subagents.default` — the last two only when
 * `routing.offload` is on. Offload off is the default, so a subagent behaves like any other
 * request until someone turns it on.
 *
 * ⚠ An unresolvable directive is a loud `RoutingError`, never a quiet fall-through. The map forms
 * are validated at config load (`assertSpecResolvable`), but a directive arrives per request and
 * had no check at all: a typo'd provider or pool name matched nothing in `pickSpecs`, so it landed
 * on `routing.default` — the Anthropic passthrough. That spends PRIMARY quota while the dispatcher
 * believes it offloaded, and nothing in the response says otherwise. Same rule as an unknown pool:
 * fail and name what IS configured.
 */
export function subagentSpec(reqJson: unknown, model: string | null, cfg: Config): string | null {
  if (!isSubagentRequest(reqJson)) return null;
  const directive = readRelayDirective(reqJson, true);
  if (directive) {
    const why = directiveUnresolvableReason(directive, cfg);
    if (why !== null) {
      throw new RoutingError(
        `@relay: "${directive}" ${why} — refusing to fall back to routing.default, ` +
          `which would spend primary quota while looking like a successful offload`,
      );
    }
    return directive;
  }
  if (!cfg.routing.offload) return null;
  const map = cfg.routing.subagents;
  if (!map) return null;
  const tier = model ? detectTier(model) : null;
  return (tier ? map[tier] : undefined) ?? map["default"] ?? null;
}

/** A request routed to a concrete provider + backend model. */
export interface ResolvedTarget {
  provider: string;
  base: string;
  kind: Kind;
  /** Real backend model id (required for openai; absent = anthropic passthrough). */
  model?: string;
  authEnv?: string;
  authHeader: AuthHeader;
  timeoutMs: number;
}

export interface Config {
  host: string;
  port: number;
  providers: Record<string, ProviderConfig>;
  routing: Routing;
  mode: Mode;
  /** Explicit global reshaper override; otherwise repair reshapes on the resolved target itself. */
  reshaper?: ReshaperConfig;
  /**
   * Ranked reshaper candidates, from `reshaper: { pool: "<name>" }`. Tried in order, so a single
   * de-listed model cannot take repair down with it — the whole point of not pinning one model.
   * `reshaper` is candidates[0] so every existing single-reshaper path keeps working unchanged.
   */
  reshaperCandidates?: ReshaperConfig[];
  repair: { maxAttempts: number; destructiveTools: string[] };
  log: { level: "metadata" | "silent"; file: string | null };
  /**
   * Providers the onboarding nudge must stop asking about (`leave_me_alone` in config.json).
   *
   * Scope is deliberately narrow: it silences the "❌ Missing Key / 👉 get one here" prompt in
   * `llm-relay onboard`, and nothing else. Suppressed providers still appear in `llm-relay keys`,
   * in `/registry` and in every status surface — silencing a nudge is not hiding state, and a
   * provider that vanished from the status commands would be undebuggable later.
   *
   * Names that match no known provider are legal (see `parseLeaveMeAlone`).
   */
  leaveMeAlone?: string[];
  /** Path this config was loaded from. Set by `loadConfig`; absent for hand-built test configs.
   *  Only consumer is the runtime offload toggle, which persists back to the same file. */
  sourcePath?: string;
  /**
   * Non-fatal load-time problems (a provider disabled for an unset `${ENV}`, a pool member
   * dropped with it). Present so startup can print them — a degraded config that boots
   * silently is how you end up running on one provider without noticing.
   */
  warnings?: string[];
}

/**
 * Tools a repaired call is never allowed to name. THE single definition — the
 * shipped config template, config.example.json and the README all derive from or
 * are asserted equal to this list, because they previously disagreed: this array
 * had 8 entries including "remove" while the other three had 7, so a config that
 * omitted repair.destructiveTools got different coverage than a generated one.
 *
 * Matching is exact (see destructiveMatcher), so these are real tool names, not
 * fragments. The harness's own destructive tools are listed first — they are the
 * ones that can actually destroy something, and the previous fragment list
 * ("rm", "delete", …) matched none of them.
 */
export const DEFAULT_DESTRUCTIVE = [
  // Claude Code / harness tools that write, delete, or execute.
  "Bash",
  "BashOutput",
  "Write",
  "Edit",
  "MultiEdit",
  "NotebookEdit",
  // Conventional names an MCP server or custom tool may use.
  "rm",
  "delete",
  "delete_file",
  "remove",
  "overwrite",
  "drop",
  "reset",
  "force_push",
];

const DEFAULT_ANTHROPIC_VERSION = "2023-06-01";
export { DEFAULT_ANTHROPIC_VERSION };

/** Claude tier names, longest-first so "haiku"/"sonnet" match before generic bits. */
const TIER_NAMES = ["opus", "sonnet", "haiku", "fable"] as const;

/** A routing failure — surfaced to the client as a clean 400, never a crash. */
export class RoutingError extends Error {}

/** Detect the Claude tier a model id belongs to, or null. */
function detectTier(model: string): string | null {
  const m = model.toLowerCase();
  for (const t of TIER_NAMES) if (m.includes(t)) return t;
  return null;
}

/**
 * Pick the "provider/model" spec(s) for an inbound model id:
 *  1. `pool/<name>` → that pool's full candidate list (ranked + failed over downstream);
 *  2. namespaced (`known-provider/…`) → use verbatim;
 *  3. a Claude tier with a configured mapping → that tier's spec(s);
 *  4. otherwise the routing default.
 *
 * Pools are checked FIRST so the reserved `pool/` prefix can never be shadowed by a provider that
 * happens to be named "pool" (config load also rejects that name outright).
 */
function pickSpecs(model: string | null, cfg: Config): string[] {
  if (model) {
    const slash = model.indexOf("/");
    // Pools are checked before providers so the reserved `pool/` prefix can never be
    // shadowed (config load also rejects a provider named "pool"). Expansion — and the
    // loud unknown-pool error — happens in expandPoolSpecs.
    if (slash !== -1) {
      const prefix = model.slice(0, slash);
      if (prefix === POOL_PREFIX || cfg.providers[prefix]) return [model];
      return Array.isArray(cfg.routing.default) ? cfg.routing.default : [cfg.routing.default];
    }
    const tier = detectTier(model);
    if (tier && cfg.routing.tiers[tier]) {
      const val = cfg.routing.tiers[tier]!;
      return Array.isArray(val) ? val : [val];
    }
  }
  return Array.isArray(cfg.routing.default) ? cfg.routing.default : [cfg.routing.default];
}

/**
 * Expand any `pool/<name>` spec into that pool's candidate list. Applied to whatever
 * pickSpecs chose, so pools work uniformly whether addressed directly by the request,
 * from routing.tiers/default, or via routing.subagents. Pool members themselves are
 * provider specs only (config load rejects pool-in-pool), so no recursion.
 *
 * An unknown pool must NOT silently fall through to routing.default — that is exactly the
 * "succeeded against a much weaker model than you asked for" failure. Fail loudly instead.
 */
function expandPoolSpecs(specs: string[], cfg: Config): string[] {
  const out: string[] = [];
  for (const s of specs) {
    const slash = s.indexOf("/");
    if (slash === -1 || s.slice(0, slash) !== POOL_PREFIX) {
      out.push(s);
      continue;
    }
    const name = s.slice(slash + 1);
    const pool = cfg.routing.pools?.[name];
    if (!pool) {
      throw new RoutingError(
        `no pool "${name}" configured (available: ${Object.keys(cfg.routing.pools ?? {}).join(", ") || "none"})`,
      );
    }
    out.push(...pool);
  }
  return out;
}

/** Split a "provider/model" spec into its parts (model may contain further slashes). */
export function splitSpec(spec: string): { provider: string; model?: string } {
  const slash = spec.indexOf("/");
  if (slash === -1) return { provider: spec };
  return { provider: spec.slice(0, slash), model: spec.slice(slash + 1) };
}

/** Resolve a single spec string to a ResolvedTarget. */
function resolveSingleSpec(spec: string, cfg: Config, modelForError: string | null): ResolvedTarget {
  const { provider, model: realModel } = splitSpec(spec);
  const p = cfg.providers[provider];
  if (!p) {
    throw new RoutingError(`no provider "${provider}" configured (routed from model "${modelForError ?? "<none>"}" → "${spec}")`);
  }
  if (p.kind === "openai" && !realModel) {
    throw new RoutingError(`provider "${provider}" is openai and needs a model id (spec "${spec}")`);
  }
  return {
    provider,
    base: p.base,
    kind: p.kind,
    authHeader: p.authHeader,
    timeoutMs: p.timeoutMs,
    ...(realModel !== undefined ? { model: realModel } : {}),
    ...(p.authEnv ? { authEnv: p.authEnv } : {}),
  };
}

/**
 * Resolve an inbound `model` to an array of concrete targets (primary + fallbacks).
 */
export function resolveTargets(model: string | null, cfg: Config): ResolvedTarget[] {
  const picked = pickSpecs(model, cfg);
  const specs = expandPoolSpecs(picked, cfg);
  let targets = specs.map((spec) => resolveSingleSpec(spec, cfg, model));

  // Prioritize targets whose credential is usable: no authEnv declared (a real passthrough or a
  // keyless local provider) or a declared authEnv that is actually present.
  //
  // ⚠ Presence is decided by `credentialState`, the SAME predicate `server.ts`'s
  // `buildForwardHeaders` uses — not an open-coded `Boolean(process.env[...])`. This site used to
  // test truthiness without trimming while header construction trimmed, so a whitespace-only key
  // read PRESENT here and ABSENT there: the blank-key target survived the filter, the
  // keep-everything fallback below never ran, and the request went to a provider the proxy could
  // not authenticate to. Any drift between the two answers reopens that gap, so both must keep
  // calling the one predicate.
  const activeTargets = targets.filter((t) => credentialState(t.authEnv) !== "declared-missing");
  if (activeTargets.length > 0) {
    targets = activeTargets;
  }

  // Dynamic pools are already materialized as an invariant fixed prefix followed by a ranked
  // discovery tail. Sorting the entire result again would destroy the user's preferred order.
  const pickedPool = picked.length === 1 && picked[0]?.startsWith(`${POOL_PREFIX}/`) ? picked[0] : undefined;
  const dynamicPool =
    pickedPool !== undefined && cfg.routing.poolPolicies?.[pickedPool.slice(POOL_PREFIX.length + 1)] !== undefined;
  if (!dynamicPool && cfg.routing.benchmarkSort !== false && targets.length > 1) {
    targets = rankTargetsByBenchmark(targets);
  }
  return targets;
}

/**
 * Resolve an inbound `model` to the primary concrete target.
 */
export function resolveTarget(model: string | null, cfg: Config): ResolvedTarget {
  const targets = resolveTargets(model, cfg);
  if (targets.length === 0) {
    throw new RoutingError(`could not resolve any target for model "${model ?? "<none>"}"`);
  }
  return targets[0]!;
}

/** The reshaper for a resolved target when no explicit global reshaper is set. */
export function reshaperForTarget(target: ResolvedTarget): ReshaperConfig | undefined {
  if (target.kind === "openai" && target.model !== undefined) {
    return {
      base: target.base,
      model: target.model,
      kind: "openai",
      authHeader: target.authHeader,
      timeoutMs: Math.min(target.timeoutMs, 60000),
      ...(target.authEnv ? { authEnv: target.authEnv } : {}),
    };
  }
  return undefined;
}

/** CLI overrides, applied over the file so routing can be repointed without editing it. */
export interface ConfigOverrides {
  listen?: string | undefined;
  /** Override routing.default with a "provider/model" spec. */
  routeDefault?: string | undefined;
  mode?: string | undefined;
}

/**
 * Expand `${ENV}` references in a config string against process.env, failing
 * loudly if a referenced variable is unset — so a missing provider URL/key is a
 * clear startup error, never a silent empty value.
 */
function expandEnv(value: string, where: string): string {
  return value.replace(/\$\{([A-Za-z_][A-Za-z0-9_]*)\}/g, (_m, name: string) => {
    const v = process.env[name];
    if (v === undefined) throw new Error(`config.${where} references unset env var \${${name}}`);
    return v;
  });
}

/**
 * Like `expandEnv`, but reports the missing variable names instead of throwing.
 *
 * Used ONLY for a provider's `base`. An unset `${ENV}` there used to be fatal, which meant
 * one optional provider (e.g. Cloudflare, whose URL embeds an account id) could stop the
 * whole proxy from starting — and since the proxy fronts every client session, that is a
 * total outage caused by a provider nobody was using. Disabling that one provider with a
 * loud warning is proportionate; refusing to boot is not.
 */
function expandEnvSoft(value: string): { value: string; missing: string[] } {
  const missing: string[] = [];
  const out = value.replace(/\$\{([A-Za-z_][A-Za-z0-9_]*)\}/g, (_m, name: string) => {
    const v = process.env[name];
    if (v === undefined) {
      missing.push(name);
      return "";
    }
    return v;
  });
  return { value: out, missing };
}

function parseAuthHeader(raw: unknown, dflt: AuthHeader): AuthHeader {
  return raw === "authorization" ? "authorization" : raw === "x-api-key" ? "x-api-key" : dflt;
}

/** Load + validate a config file, failing loudly on anything unusable. */
export function loadConfig(path: string, overrides: ConfigOverrides = {}): Config {
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(path, "utf8"));
  } catch (e) {
    throw new Error(`could not read/parse config at ${path}: ${(e as Error).message}`);
  }
  if (typeof parsed !== "object" || parsed === null) {
    throw new Error(`config at ${path} is not a JSON object`);
  }
  const c = parsed as Record<string, unknown>;

  if (overrides.listen !== undefined) c.listen = overrides.listen;
  if (overrides.mode !== undefined) c.mode = overrides.mode;

  const listen = typeof c.listen === "string" ? expandEnv(c.listen, "listen") : "127.0.0.1:8791";
  const [host, portStr] = splitHostPort(listen);
  const port = Number(portStr);
  if (!Number.isInteger(port) || port <= 0 || port > 65535) {
    throw new Error(`config.listen has invalid port: "${listen}"`);
  }
  // This tool holds provider keys and does no auth of its own — loopback only.
  if (host !== "127.0.0.1" && host !== "localhost" && host !== "::1") {
    throw new Error(
      `config.listen must bind loopback (127.0.0.1/localhost/::1), got "${host}". ` +
        `Refusing to expose a keyed, unauthenticated proxy on a non-loopback address.`,
    );
  }

  const warnings: string[] = [];
  const disabledProviders = new Set<string>();
  const providers = parseProviders(c.providers, warnings, disabledProviders);
  const routing = parseRouting(c.routing, providers, overrides.routeDefault, warnings, disabledProviders);

  const mode = normalizeMode(c.mode);

  // A repair-mode target reshapes on itself (openai) or via the explicit global
  // reshaper. An anthropic provider has no fixed model id, so if any provider is
  // anthropic and no explicit reshaper is set, repair can't reshape it — reject.
  // `reshaper: { pool: "<name>" }` is the resilient form: it expands to the pool's ranked
  // candidates, so repair survives one model being de-listed. Pinning a single {base, model} still
  // works but is fragile — the provider dropping that id silently disables repair.
  const reshaperCandidates = resolveReshaperPool(c.reshaper, routing, providers);
  const reshaper = reshaperCandidates?.[0] ?? parseReshaper(c.reshaper);
  if (mode === "repair" && !reshaper) {
    const anthropicProvider = Object.entries(providers).find(([, p]) => p.kind === "anthropic");
    if (anthropicProvider) {
      throw new Error(
        `mode "repair" requires a config.reshaper — either { pool: "<name>" } (preferred: ranked ` +
          `candidates, survives a de-listed model) or { base, model, authEnv } — because provider ` +
          `"${anthropicProvider[0]}" is anthropic (no fixed model to reshape on)`,
      );
    }
  }

  const repairRaw = (c.repair ?? {}) as { maxAttempts?: unknown; destructiveTools?: unknown };
  const maxAttempts =
    typeof repairRaw.maxAttempts === "number" && Number.isFinite(repairRaw.maxAttempts) && repairRaw.maxAttempts > 0
      ? Math.floor(repairRaw.maxAttempts)
      : 2;
  const destructiveTools = Array.isArray(repairRaw.destructiveTools)
    ? repairRaw.destructiveTools.filter((s): s is string => typeof s === "string")
    : DEFAULT_DESTRUCTIVE;

  const logRaw = (c.log ?? {}) as { level?: unknown; file?: unknown };
  const level = logRaw.level === "silent" ? "silent" : "metadata";
  const file = typeof logRaw.file === "string" ? logRaw.file : null;

  const leaveMeAlone = parseLeaveMeAlone(c["leave_me_alone"]);

  return {
    host,
    port,
    providers,
    routing,
    mode,
    ...(reshaper ? { reshaper } : {}),
    ...(reshaperCandidates && reshaperCandidates.length > 1 ? { reshaperCandidates } : {}),
    repair: { maxAttempts, destructiveTools },
    log: { level, file },
    ...(leaveMeAlone.length > 0 ? { leaveMeAlone } : {}),
    sourcePath: path,
    ...(warnings.length > 0 ? { warnings } : {}),
  };
}

/**
 * Parse `leave_me_alone` — the provider suppression list.
 *
 * ⚠ A name matching NO known provider is deliberately legal and produces neither an error nor a
 * warning. Storing only the negative space is the whole point: you suppress the nudge for a
 * provider you have chosen not to configure, which by definition is not in `config.providers`,
 * and most of them are only ever preset names. Validating against the known set would reject
 * exactly the entries the feature exists for.
 *
 * The VALUE's shape is still checked loudly — a string where a list belongs, or a number in the
 * list, is a mistake with no plausible reading, and silently ignoring it would leave the user
 * being nagged with no idea why.
 */
function parseLeaveMeAlone(raw: unknown): string[] {
  if (raw === undefined || raw === null) return [];
  if (!Array.isArray(raw)) {
    throw new Error(`config.leave_me_alone must be an array of provider names (got ${typeof raw})`);
  }
  const bad = raw.find((v) => typeof v !== "string" || v.trim().length === 0);
  if (bad !== undefined) {
    throw new Error(
      `config.leave_me_alone entries must be non-empty provider-name strings (got ${JSON.stringify(bad)})`,
    );
  }
  return (raw as string[]).map((s) => s.trim());
}

function parseProviders(
  raw: unknown,
  warnings: string[] = [],
  disabled: Set<string> = new Set(),
): Record<string, ProviderConfig> {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    throw new Error(`config.providers (object of named providers) is required`);
  }
  const out: Record<string, ProviderConfig> = {};
  for (const [name, v] of Object.entries(raw as Record<string, unknown>)) {
    if (typeof v !== "object" || v === null) {
      throw new Error(`config.providers.${name} must be an object`);
    }
    const p = v as {
      base?: unknown;
      kind?: unknown;
      authEnv?: unknown;
      authHeader?: unknown;
      timeoutMs?: unknown;
      tierType?: unknown;
      signupUrl?: unknown;
    };
    if (typeof p.base !== "string") {
      throw new Error(`config.providers.${name}.base (string URL) is required`);
    }
    // An unset ${ENV} in `base` disables just this provider — see expandEnvSoft.
    const expanded = expandEnvSoft(p.base);
    if (expanded.missing.length > 0) {
      warnings.push(
        `provider "${name}" DISABLED — base references unset env var ` +
          `${expanded.missing.map((n) => `\${${n}}`).join(", ")}. ` +
          `Set it and restart, or remove the provider. Everything else still works.`,
      );
      disabled.add(name);
      continue;
    }
    const kind: Kind = p.kind === "openai" ? "openai" : "anthropic";
    const defaultAuthHeader: AuthHeader = kind === "openai" ? "authorization" : "x-api-key";
    out[name] = {
      base: expanded.value.trim().replace(/\/+$/, ""),
      kind,
      authHeader: parseAuthHeader(p.authHeader, defaultAuthHeader),
      timeoutMs: typeof p.timeoutMs === "number" && Number.isFinite(p.timeoutMs) && p.timeoutMs > 0 ? p.timeoutMs : 120000,
      // The declared name is a default, not a requirement: if the key is present under
      // a known alias instead, use that so an already-working env var doesn't have to
      // be renamed. Resolved here so routing, key checks and the backend all agree.
      ...(typeof p.authEnv === "string"
        ? { authEnv: resolveAuthEnv(name, p.authEnv).name ?? p.authEnv }
        : {}),
      ...(p.tierType === "free" || p.tierType === "mixed" || p.tierType === "subscription"
        ? { tierType: p.tierType }
        : {}),
      ...(typeof p.signupUrl === "string" && p.signupUrl.length > 0 ? { signupUrl: p.signupUrl } : {}),
    };
  }
  if (Object.keys(out).length === 0) {
    throw new Error(`config.providers must define at least one provider`);
  }
  return out;
}

function parseRouting(
  raw: unknown,
  providers: Record<string, ProviderConfig>,
  overrideDefault: string | undefined,
  warnings: string[] = [],
  disabledProviders: Set<string> = new Set(),
): Routing {
  const r = (typeof raw === "object" && raw !== null ? raw : {}) as {
    default?: unknown;
    tiers?: unknown;
    pools?: unknown;
    offload?: unknown;
    subagents?: unknown;
    benchmarkSort?: unknown;
    ladder?: unknown;
    ladders?: unknown;
  };
  // "pool" as a provider name would make `pool/<name>` ambiguous. Reject at load, not at request.
  if (providers[POOL_PREFIX]) {
    throw new Error(`config.providers."${POOL_PREFIX}" is reserved — it would shadow "pool/<name>" routing`);
  }
  const dfltRaw = overrideDefault !== undefined ? overrideDefault : r.default;
  let dflt: string | string[];

  if (Array.isArray(dfltRaw)) {
    dflt = dfltRaw.filter((s): s is string => typeof s === "string" && s.length > 0);
    if (dflt.length === 0) {
      throw new Error(`config.routing.default array must contain at least one valid spec string`);
    }
  } else if (typeof dfltRaw === "string" && dfltRaw.length > 0) {
    dflt = dfltRaw;
  } else {
    throw new Error(`config.routing.default ("provider/model") is required`);
  }

  const tiers: Record<string, string | string[]> = {};
  if (typeof r.tiers === "object" && r.tiers !== null) {
    for (const [k, v] of Object.entries(r.tiers as Record<string, unknown>)) {
      if (Array.isArray(v)) {
        const arr = v.filter((s): s is string => typeof s === "string" && s.length > 0);
        if (arr.length > 0) tiers[k] = arr;
      } else if (typeof v === "string" && v.length > 0) {
        tiers[k] = v;
      }
    }
  }

  const pools: Record<string, string[]> = {};
  const poolPolicies: Record<string, PoolPolicy> = {};
  if (typeof r.pools === "object" && r.pools !== null) {
    for (const [k, v] of Object.entries(r.pools as Record<string, unknown>)) {
      let declared: string[];
      if (Array.isArray(v)) {
        declared = v.filter((s): s is string => typeof s === "string" && s.length > 0);
      } else if (typeof v === "object" && v !== null) {
        const policy = v as { preferred?: unknown; include?: unknown };
        if (!Array.isArray(policy.preferred) || policy.preferred.some((s) => typeof s !== "string" || s.length === 0)) {
          throw new Error(`config.routing.pools.${k}.preferred must be an array of non-empty "provider/model" specs`);
        }
        if (policy.include !== "free") {
          throw new Error(`config.routing.pools.${k}.include must be "free"`);
        }
        declared = [...(policy.preferred as string[])];
        poolPolicies[k] = { preferred: declared, include: "free" };
      } else {
        throw new Error(
          `config.routing.pools.${k} must be an array of specs or {"preferred":[...],"include":"free"}`,
        );
      }
      // Members of a DISABLED provider are dropped, not fatal — the pool's whole purpose is
      // surviving the loss of one candidate. A member naming a provider that simply doesn't
      // exist is still an error below: that's a typo, and silently dropping it would spend
      // primary quota via the passthrough instead of failing loudly.
      const arr = declared.filter((s) => {
        const { provider } = splitSpec(s);
        if (!disabledProviders.has(provider)) return true;
        warnings.push(`routing.pools.${k}: dropped "${s}" — provider "${provider}" is disabled`);
        return false;
      });
      if (arr.length === 0 && !poolPolicies[k]) {
        throw new Error(`config.routing.pools.${k} must contain at least one valid spec string`);
      }
      // Members are provider specs only — pool-in-pool would make expansion recursive.
      const nested = arr.find((s) => s.startsWith(`${POOL_PREFIX}/`));
      if (nested) {
        throw new Error(`config.routing.pools.${k} member "${nested}" — a pool cannot reference another pool`);
      }
      pools[k] = arr;
      if (poolPolicies[k]) poolPolicies[k] = { preferred: arr, include: "free" };
    }
  }

  const subagents: Record<string, string> = {};
  if (typeof r.subagents === "object" && r.subagents !== null) {
    for (const [k, v] of Object.entries(r.subagents as Record<string, unknown>)) {
      if (typeof v === "string" && v.length > 0) subagents[k] = v;
    }
  }

  const benchmarkSort = typeof r.benchmarkSort === "boolean" ? r.benchmarkSort : true;
  // Absent => false. Offload is opt-in: a missing key must never mean "send every subagent
  // to another provider", which is what an implicit-on default would do to an existing config.
  const offload = r.offload === true;
  const routing: Routing = { default: dflt, tiers, benchmarkSort, offload };
  if (Object.keys(pools).length > 0) routing.pools = pools;
  if (Object.keys(poolPolicies).length > 0) routing.poolPolicies = poolPolicies;
  if (Object.keys(subagents).length > 0) routing.subagents = subagents;
  const ladder = parseLadder(r.ladder, "config.routing.ladder");
  if (ladder.length > 0) routing.ladder = ladder;
  if (r.ladders !== undefined && (typeof r.ladders !== "object" || r.ladders === null || Array.isArray(r.ladders))) {
    throw new Error(`config.routing.ladders must be an object of named ladder arrays`);
  }
  const ladders: Record<string, LadderRung[]> = {};
  for (const [tier, rawLadder] of Object.entries((r.ladders ?? {}) as Record<string, unknown>)) {
    const parsed = parseLadder(rawLadder, `config.routing.ladders.${tier}`);
    if (parsed.length === 0) throw new Error(`config.routing.ladders.${tier} must contain at least one rung`);
    ladders[tier] = parsed;
  }
  if (Object.keys(ladders).length > 0) routing.ladders = ladders;

  // A spec naming a DISABLED provider is dropped with a warning, exactly like a pool member;
  // a spec naming a provider that was never declared is still fatal below. Doing this before
  // the assertions is what keeps "one optional provider lost its ${ENV}" from being a total
  // outage: assertSpecResolvable sees the post-disabling provider map, so it cannot tell the
  // two apart and used to abort startup for the degraded case too.
  for (const [tier, spec] of Object.entries(tiers)) {
    const kept = dropDisabledSpecs(spec, disabledProviders, warnings, `routing.tiers.${tier}`);
    if (kept === null) delete tiers[tier];
    else tiers[tier] = kept;
  }
  for (const [tier, spec] of Object.entries(subagents)) {
    // A subagent entry is a single spec, so the result is a string or nothing.
    const kept = dropDisabledSpecs(spec, disabledProviders, warnings, `routing.subagents.${tier}`) as
      | string
      | null;
    if (kept === null) delete subagents[tier];
    else subagents[tier] = kept;
  }
  if (Array.isArray(routing.default)) {
    // Only an ARRAY default can degrade — the survivors still answer. A single-spec default
    // has nothing left to fall back to, so it stays fatal below.
    const kept = dropDisabledSpecs(routing.default, disabledProviders, warnings, "routing.default");
    if (kept !== null) routing.default = kept;
  }
  routing.ladder = ladder.filter((rung) => {
    if (rung.kind !== "relay" || !rung.spec) return true;
    return dropDisabledSpecs(rung.spec, disabledProviders, warnings, `routing.ladder[${rung.id}].spec`) !== null;
  });
  if (routing.ladder.length === 0) delete routing.ladder;
  for (const [tier, tierLadder] of Object.entries(routing.ladders ?? {})) {
    const kept = tierLadder.filter((rung) => {
      if (rung.kind !== "relay" || !rung.spec) return true;
      return dropDisabledSpecs(rung.spec, disabledProviders, warnings, `routing.ladders.${tier}[${rung.id}].spec`) !== null;
    });
    if (kept.length === 0) delete routing.ladders![tier];
    else routing.ladders![tier] = kept;
  }
  if (routing.ladders && Object.keys(routing.ladders).length === 0) delete routing.ladders;

  // Fail loudly at load time if any spec names an unknown provider or pool. Only
  // `routing.default` can still trip on a DISABLED provider — everything else degraded
  // above — and it is fatal on purpose: it is the fall-through for everything, so there
  // is nowhere left to fall through to.
  assertSpecResolvable(routing.default, providers, pools, "routing.default", disabledProviders);
  for (const [tier, spec] of Object.entries(tiers)) {
    assertSpecResolvable(spec, providers, pools, `routing.tiers.${tier}`);
  }
  for (const [pool, specs] of Object.entries(pools)) {
    assertSpecResolvable(specs, providers, {}, `routing.pools.${pool}`);
  }
  for (const [tier, spec] of Object.entries(subagents)) {
    assertSpecResolvable(spec, providers, pools, `routing.subagents.${tier}`);
  }
  for (const rung of routing.ladder ?? []) {
    if (rung.kind === "relay" && rung.spec) {
      assertSpecResolvable(rung.spec, providers, pools, `routing.ladder[${rung.id}].spec`);
    }
  }
  for (const [tier, tierLadder] of Object.entries(routing.ladders ?? {})) {
    for (const rung of tierLadder) {
      if (rung.kind === "relay" && rung.spec) {
        assertSpecResolvable(rung.spec, providers, pools, `routing.ladders.${tier}[${rung.id}].spec`);
      }
    }
  }
  return routing;
}

/**
 * Drop the members of a spec (or spec list) whose provider was disabled by an unset `${ENV}`,
 * warning for each. Returns the survivors, or `null` when nothing survives.
 *
 * ⚠ The warning states the CONSEQUENCE, not just the fact. When a `routing.subagents` entry
 * disappears, that traffic falls through to `routing.default` — the Anthropic passthrough — so
 * the dispatcher believes it offloaded while spending primary quota, and nothing in the
 * response says otherwise. That is the same hazard an unresolvable `@relay:` directive is a
 * hard error for; the difference is that this one is visible once, at startup, where the
 * operator can act on it, and the alternative (aborting) takes down every client session for
 * a provider that may not even be in use.
 */
function dropDisabledSpecs(
  spec: string | string[],
  disabled: Set<string>,
  warnings: string[],
  where: string,
): string | string[] | null {
  if (disabled.size === 0) return spec;
  const specs = Array.isArray(spec) ? spec : [spec];
  const kept = specs.filter((s) => {
    const { provider } = splitSpec(s);
    if (provider === POOL_PREFIX || !disabled.has(provider)) return true;
    warnings.push(
      `config.${where}: dropped "${s}" — provider "${provider}" is disabled. ` +
        `That routing now falls through to routing.default, which for a passthrough default ` +
        `means primary quota.`,
    );
    return false;
  });
  if (kept.length === 0) return null;
  return Array.isArray(spec) ? kept : kept[0]!;
}

/** Placeholder a cli rung's args must contain. Duplicated from dispatch.ts as a literal rather
 *  than imported, to keep config.ts free of dependencies on modules that import it. */
const LADDER_TASK_TOKEN = "{task}";

/**
 * Validate `routing.ladder` at load, not at request time — a ladder whose rung cannot be invoked
 * is a configuration mistake, and discovering it only when the host is mid-fallback is exactly
 * when it is least useful. Absent/empty is legal and simply means "no opinion".
 */
function parseLadder(raw: unknown, root: string): LadderRung[] {
  if (raw === undefined || raw === null) return [];
  if (!Array.isArray(raw)) throw new Error(`${root} must be an array of rungs`);

  const out: LadderRung[] = [];
  const seen = new Set<string>();
  for (const [i, entry] of raw.entries()) {
    const where = `${root}[${i}]`;
    if (typeof entry !== "object" || entry === null) throw new Error(`${where} must be an object`);
    const e = entry as Record<string, unknown>;

    const id = e.id;
    if (typeof id !== "string" || id.length === 0) throw new Error(`${where}.id must be a non-empty string`);
    // Ids address rungs in /dispatch overrides and exhaustion reports; a duplicate would make
    // "use lane X" ambiguous, and silently picking the first is not a decision to make for the user.
    if (seen.has(id)) throw new Error(`${where}.id "${id}" is already used by an earlier rung`);
    seen.add(id);

    const kind = e.kind;
    if (kind !== "cli" && kind !== "relay") throw new Error(`${where}.kind must be "cli" or "relay" (got ${JSON.stringify(kind)})`);

    const rung: LadderRung = { id, kind, enabled: e.enabled !== false };
    if (typeof e.quota === "string" && e.quota.length > 0) rung.quota = e.quota;
    if (typeof e.note === "string" && e.note.length > 0) rung.note = e.note;

    if (kind === "cli") {
      if (typeof e.command !== "string" || e.command.length === 0) {
        throw new Error(`${where}.command must be a non-empty string for a "cli" rung`);
      }
      if (!Array.isArray(e.args) || e.args.some((a) => typeof a !== "string")) {
        throw new Error(`${where}.args must be an array of strings for a "cli" rung`);
      }
      const args = e.args as string[];
      // Without the placeholder the task text has nowhere to go and the rung would invoke the
      // agent with an empty prompt — a failure that looks like the model ignoring the request.
      if (!args.some((a) => a.includes(LADDER_TASK_TOKEN))) {
        throw new Error(`${where}.args must contain "${LADDER_TASK_TOKEN}" in one argument — otherwise the task is never passed to ${e.command}`);
      }
      rung.command = e.command;
      rung.args = args;
    } else {
      if (typeof e.spec !== "string" || e.spec.length === 0) {
        throw new Error(`${where}.spec must be a non-empty string for a "relay" rung`);
      }
      rung.spec = e.spec;
    }
    out.push(rung);
  }
  return out;
}

function assertSpecResolvable(
  spec: string | string[],
  providers: Record<string, ProviderConfig>,
  pools: Record<string, string[]>,
  where: string,
  disabled: Set<string> = new Set(),
): void {
  const specs = Array.isArray(spec) ? spec : [spec];
  for (const s of specs) {
    const { provider, model } = splitSpec(s);
    if (provider === POOL_PREFIX) {
      if (!model || !pools[model]) {
        throw new Error(
          `config.${where} "${s}" names unknown pool "${model ?? ""}" (available: ${Object.keys(pools).join(", ") || "none"})`,
        );
      }
      continue;
    }
    const p = providers[provider];
    // A disabled provider is absent from `providers`, so without this it is reported as a
    // typo — sending the operator to look for a misspelling that isn't there instead of at
    // the unset environment variable that actually caused it.
    if (!p && disabled.has(provider)) {
      throw new Error(
        `config.${where} "${s}" names provider "${provider}", which is DISABLED because its ` +
          `base references an unset \${ENV} (see the warning above). Set the variable, or point ` +
          `${where} somewhere else.`,
      );
    }
    if (!p) throw new Error(`config.${where} "${s}" names unknown provider "${provider}"`);
    if (p.kind === "openai" && !model) throw new Error(`config.${where} "${s}" needs a model id for openai provider "${provider}"`);
  }
}

/**
 * Expand `reshaper: { pool: "<name>" }` into ranked reshaper candidates.
 *
 * Only openai-kind targets can reshape (an anthropic passthrough has no fixed model id to send),
 * so anthropic entries in the pool are skipped rather than failing the whole pool. A pool naming
 * no usable target IS an error — silently ending up with no reshaper would disable repair without
 * saying so, which is the failure this whole form exists to prevent.
 */
function resolveReshaperPool(
  raw: unknown,
  routing: Routing,
  providers: Record<string, ProviderConfig>,
): ReshaperConfig[] | undefined {
  if (typeof raw !== "object" || raw === null) return undefined;
  const poolName = (raw as Record<string, unknown>).pool;
  if (typeof poolName !== "string" || poolName.length === 0) return undefined;

  const specs = routing.pools?.[poolName];
  if (!specs) {
    throw new Error(
      `config.reshaper.pool "${poolName}" is not defined in routing.pools (available: ${Object.keys(routing.pools ?? {}).join(", ") || "none"})`,
    );
  }

  const timeoutOverride = (raw as Record<string, unknown>).timeoutMs;
  const out: ReshaperConfig[] = [];
  for (const spec of specs) {
    const { provider, model } = splitSpec(spec);
    const p = providers[provider];
    if (!p || p.kind !== "openai" || !model) continue;
    out.push({
      base: p.base,
      model,
      kind: "openai",
      authHeader: p.authHeader,
      timeoutMs:
        typeof timeoutOverride === "number" && Number.isFinite(timeoutOverride) && timeoutOverride > 0
          ? timeoutOverride
          : Math.min(p.timeoutMs, 60000),
      ...(p.authEnv ? { authEnv: p.authEnv } : {}),
    });
  }
  if (out.length === 0) {
    throw new Error(`config.reshaper.pool "${poolName}" contains no openai-kind target that can reshape`);
  }
  return out;
}

function parseReshaper(raw: unknown): ReshaperConfig | undefined {
  if (typeof raw !== "object" || raw === null) return undefined;
  const r = raw as Record<string, unknown>;
  if (typeof r.base !== "string" || typeof r.model !== "string") return undefined;
  const kind: Kind = r.kind === "openai" ? "openai" : "anthropic";
  const defaultAuthHeader: AuthHeader = kind === "openai" ? "authorization" : "x-api-key";
  return {
    base: expandEnv(r.base, "reshaper.base").trim().replace(/\/+$/, ""),
    model: expandEnv(r.model, "reshaper.model"),
    kind,
    authHeader: parseAuthHeader(r.authHeader, defaultAuthHeader),
    timeoutMs: typeof r.timeoutMs === "number" && Number.isFinite(r.timeoutMs) && r.timeoutMs > 0 ? r.timeoutMs : 60000,
    ...(typeof r.authEnv === "string" ? { authEnv: r.authEnv } : {}),
  };
}

function splitHostPort(listen: string): [string, string] {
  const bracket = /^\[(.+)\]:(\d+)$/.exec(listen);
  if (bracket) return [bracket[1]!, bracket[2]!];
  const idx = listen.lastIndexOf(":");
  if (idx === -1) return ["127.0.0.1", listen];
  return [listen.slice(0, idx) || "127.0.0.1", listen.slice(idx + 1)];
}

function normalizeMode(v: unknown): Mode {
  if (v === "detect" || v === "repair" || v === "strict") return v;
  return "detect";
}
