import { readFileSync } from "node:fs";

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
}

/**
 * How an inbound request's `model` maps to a provider + backend model.
 *  - `default`: fallback "provider/model" spec when nothing else matches.
 *  - `tiers`: Claude tier name ("opus"/"sonnet"/"haiku"/"fable") → "provider/model".
 * A request may also address a provider directly with a namespaced model id
 * ("nim/z-ai/glm-5.2") — the prefix picks the provider, the rest is the model.
 */
export interface Routing {
  default: string;
  tiers: Record<string, string>;
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
  repair: { maxAttempts: number; destructiveTools: string[] };
  log: { level: "metadata" | "silent"; file: string | null };
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
 * Pick the "provider/model" spec for an inbound model id:
 *  1. namespaced (`known-provider/…`) → use verbatim;
 *  2. a Claude tier with a configured mapping → that tier's spec;
 *  3. otherwise the routing default.
 */
function pickSpec(model: string | null, cfg: Config): string {
  if (model) {
    const slash = model.indexOf("/");
    if (slash !== -1 && cfg.providers[model.slice(0, slash)]) return model;
    const tier = detectTier(model);
    if (tier && cfg.routing.tiers[tier]) return cfg.routing.tiers[tier]!;
  }
  return cfg.routing.default;
}

/** Split a "provider/model" spec into its parts (model may contain further slashes). */
function splitSpec(spec: string): { provider: string; model?: string } {
  const slash = spec.indexOf("/");
  if (slash === -1) return { provider: spec };
  return { provider: spec.slice(0, slash), model: spec.slice(slash + 1) };
}

/**
 * Resolve an inbound `model` to a concrete provider + backend model. Throws
 * RoutingError if the spec names an unknown provider or omits a model an
 * openai provider requires.
 */
export function resolveTarget(model: string | null, cfg: Config): ResolvedTarget {
  const spec = pickSpec(model, cfg);
  const { provider, model: realModel } = splitSpec(spec);
  const p = cfg.providers[provider];
  if (!p) {
    throw new RoutingError(`no provider "${provider}" configured (routed from model "${model ?? "<none>"}" → "${spec}")`);
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
  const reshaper = parseReshaper(c.reshaper);
  if (mode === "repair" && !reshaper) {
    const anthropicProvider = Object.entries(providers).find(([, p]) => p.kind === "anthropic");
    if (anthropicProvider) {
      throw new Error(
        `mode "repair" requires a config.reshaper { base, model, authEnv } because ` +
          `provider "${anthropicProvider[0]}" is anthropic (no fixed model to reshape on)`,
      );
    }
  }

  const repairRaw = (c.repair ?? {}) as { maxAttempts?: unknown; destructiveTools?: unknown };
  const maxAttempts =
    typeof repairRaw.maxAttempts === "number" && repairRaw.maxAttempts > 0
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
    repair: { maxAttempts, destructiveTools },
    log: { level, file },
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
      timeoutMs: typeof p.timeoutMs === "number" && p.timeoutMs > 0 ? p.timeoutMs : 120000,
      ...(typeof p.authEnv === "string" ? { authEnv: p.authEnv } : {}),
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
  const r = (typeof raw === "object" && raw !== null ? raw : {}) as { default?: unknown; tiers?: unknown };
  const dflt = overrideDefault !== undefined ? overrideDefault : r.default;
  if (typeof dflt !== "string" || dflt.length === 0) {
    throw new Error(`config.routing.default ("provider/model") is required`);
  }
  const tiers: Record<string, string> = {};
  if (typeof r.tiers === "object" && r.tiers !== null) {
    for (const [k, v] of Object.entries(r.tiers as Record<string, unknown>)) {
      if (typeof v === "string" && v.length > 0) tiers[k] = v;
    }
  }
  const routing: Routing = { default: dflt, tiers };
  // Fail loudly at load time if any spec names an unknown provider.
  assertSpecResolvable(routing.default, providers, "routing.default");
  for (const [tier, spec] of Object.entries(tiers)) {
    assertSpecResolvable(spec, providers, `routing.tiers.${tier}`);
  }
  return routing;
}

function assertSpecResolvable(spec: string, providers: Record<string, ProviderConfig>, where: string): void {
  const { provider, model } = splitSpec(spec);
  const p = providers[provider];
  if (!p) throw new Error(`config.${where} "${spec}" names unknown provider "${provider}"`);
  if (p.kind === "openai" && !model) throw new Error(`config.${where} "${spec}" needs a model id for openai provider "${provider}"`);
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
    timeoutMs: typeof r.timeoutMs === "number" && r.timeoutMs > 0 ? r.timeoutMs : 60000,
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
