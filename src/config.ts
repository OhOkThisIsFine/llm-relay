import { readFileSync } from "node:fs";
import { rankTargetsByBenchmark } from "./benchmarks.js";
import { resolveAuthEnv } from "./authEnv.js";

export type Mode = "detect" | "repair" | "strict";

export type AuthHeader = "x-api-key" | "authorization";

export type Kind = "anthropic" | "openai";

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
  /** "free": 100% free model endpoint. "subscription": user paid subscription quota endpoint. */
  tierType?: "free" | "subscription";
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
  const content = (messages[0] as { content?: unknown })?.content;
  if (!Array.isArray(content)) return null;

  for (let i = content.length - 1; i >= 0; i--) {
    const block = content[i] as { type?: unknown; text?: unknown };
    if (block?.type !== "text" || typeof block.text !== "string") continue;
    const m = RELAY_DIRECTIVE.exec(block.text);
    if (!m) return null; // last text block only — do not keep scanning earlier blocks
    if (strip) block.text = block.text.replace(RELAY_DIRECTIVE, "").replace(/^\n+/, "");
    return m[1]!;
  }
  return null;
}

/**
 * The spec a subagent request should route to, or null to leave routing unchanged.
 *
 * Precedence: an explicit `@relay:` directive (per-call opt-in, works even with offload off) >
 * `routing.subagents[<tier>]` > `routing.subagents.default` — the last two only when
 * `routing.offload` is on. Offload off is the default, so a subagent behaves like any other
 * request until someone turns it on.
 */
export function subagentSpec(reqJson: unknown, model: string | null, cfg: Config): string | null {
  if (!isSubagentRequest(reqJson)) return null;
  const directive = readRelayDirective(reqJson, true);
  if (directive) return directive;
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
  /** Path this config was loaded from. Set by `loadConfig`; absent for hand-built test configs.
   *  Only consumer is the runtime offload toggle, which persists back to the same file. */
  sourcePath?: string;
}

const DEFAULT_DESTRUCTIVE = ["rm", "delete", "remove", "push", "force", "overwrite", "drop", "reset"];

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
    if (slash !== -1 && model.slice(0, slash) === POOL_PREFIX) {
      const pool = cfg.routing.pools?.[model.slice(slash + 1)];
      // An unknown pool must NOT silently fall through to routing.default — that is exactly the
      // "succeeded against a much weaker model than you asked for" failure. Fail loudly instead.
      if (!pool) {
        throw new RoutingError(
          `no pool "${model.slice(slash + 1)}" configured (available: ${Object.keys(cfg.routing.pools ?? {}).join(", ") || "none"})`,
        );
      }
      return pool;
    }
    if (slash !== -1 && cfg.providers[model.slice(0, slash)]) return [model];
    const tier = detectTier(model);
    if (tier && cfg.routing.tiers[tier]) {
      const val = cfg.routing.tiers[tier]!;
      return Array.isArray(val) ? val : [val];
    }
  }
  return Array.isArray(cfg.routing.default) ? cfg.routing.default : [cfg.routing.default];
}

/** Split a "provider/model" spec into its parts (model may contain further slashes). */
function splitSpec(spec: string): { provider: string; model?: string } {
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
  const specs = pickSpecs(model, cfg);
  let targets = specs.map((spec) => resolveSingleSpec(spec, cfg, model));

  // Prioritize targets with active keys or keyless local providers
  const activeTargets = targets.filter((t) => !t.authEnv || Boolean(process.env[t.authEnv]));
  if (activeTargets.length > 0) {
    targets = activeTargets;
  }

  if (cfg.routing.benchmarkSort !== false && targets.length > 1) {
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

  const providers = parseProviders(c.providers);
  const routing = parseRouting(c.routing, providers, overrides.routeDefault);

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
    sourcePath: path,
  };
}

function parseProviders(raw: unknown): Record<string, ProviderConfig> {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    throw new Error(`config.providers (object of named providers) is required`);
  }
  const out: Record<string, ProviderConfig> = {};
  for (const [name, v] of Object.entries(raw as Record<string, unknown>)) {
    if (typeof v !== "object" || v === null) {
      throw new Error(`config.providers.${name} must be an object`);
    }
    const p = v as { base?: unknown; kind?: unknown; authEnv?: unknown; authHeader?: unknown; timeoutMs?: unknown };
    if (typeof p.base !== "string") {
      throw new Error(`config.providers.${name}.base (string URL) is required`);
    }
    const kind: Kind = p.kind === "openai" ? "openai" : "anthropic";
    const defaultAuthHeader: AuthHeader = kind === "openai" ? "authorization" : "x-api-key";
    out[name] = {
      base: expandEnv(p.base, `providers.${name}.base`).trim().replace(/\/+$/, ""),
      kind,
      authHeader: parseAuthHeader(p.authHeader, defaultAuthHeader),
      timeoutMs: typeof p.timeoutMs === "number" && Number.isFinite(p.timeoutMs) && p.timeoutMs > 0 ? p.timeoutMs : 120000,
      // The declared name is a default, not a requirement: if the key is present under
      // a known alias instead, use that so an already-working env var doesn't have to
      // be renamed. Resolved here so routing, key checks and the backend all agree.
      ...(typeof p.authEnv === "string"
        ? { authEnv: resolveAuthEnv(name, p.authEnv).name ?? p.authEnv }
        : {}),
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
): Routing {
  const r = (typeof raw === "object" && raw !== null ? raw : {}) as {
    default?: unknown;
    tiers?: unknown;
    pools?: unknown;
    offload?: unknown;
    subagents?: unknown;
    benchmarkSort?: unknown;
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
  if (typeof r.pools === "object" && r.pools !== null) {
    for (const [k, v] of Object.entries(r.pools as Record<string, unknown>)) {
      if (!Array.isArray(v)) {
        throw new Error(`config.routing.pools.${k} must be an array of "provider/model" specs`);
      }
      const arr = v.filter((s): s is string => typeof s === "string" && s.length > 0);
      if (arr.length === 0) {
        throw new Error(`config.routing.pools.${k} must contain at least one valid spec string`);
      }
      pools[k] = arr;
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
  if (Object.keys(subagents).length > 0) routing.subagents = subagents;

  // Fail loudly at load time if any spec names an unknown provider.
  assertSpecResolvable(routing.default, providers, "routing.default");
  for (const [tier, spec] of Object.entries(tiers)) {
    assertSpecResolvable(spec, providers, `routing.tiers.${tier}`);
  }
  for (const [pool, specs] of Object.entries(pools)) {
    assertSpecResolvable(specs, providers, `routing.pools.${pool}`);
  }
  return routing;
}

function assertSpecResolvable(spec: string | string[], providers: Record<string, ProviderConfig>, where: string): void {
  const specs = Array.isArray(spec) ? spec : [spec];
  for (const s of specs) {
    const { provider, model } = splitSpec(s);
    const p = providers[provider];
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
