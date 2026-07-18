import { readFileSync } from "node:fs";

export type Mode = "detect" | "repair" | "strict";

export type AuthHeader = "x-api-key" | "authorization";

export type Kind = "anthropic" | "openai";

export interface ReshaperConfig {
  base: string;
  model: string;
  /** "anthropic": call /v1/messages. "openai": call /chat/completions. */
  kind: Kind;
  authEnv?: string;
  authHeader: AuthHeader;
  timeoutMs: number;
}

/**
 * The single upstream backend. It must speak Anthropic Messages (`/v1/messages`)
 * natively — typically a LiteLLM proxy, which serves the Anthropic format for any
 * provider model and owns all provider translation, routing, and fallback. This
 * proxy does no format translation of its own.
 */
export interface BackendConfig {
  base: string;
  /**
   * Optional fixed model id: when set, every request's `model` is rewritten to it
   * before forwarding. When absent, the client's model name passes through — with
   * LiteLLM behind, `model_name` aliases in its config resolve it.
   */
  model?: string;
  authEnv?: string;
  /** Which header to inject the backend key into. Default: x-api-key. */
  authHeader: AuthHeader;
  /** Backend request deadline in ms. Default 120000. */
  timeoutMs: number;
}

export interface Config {
  host: string;
  port: number;
  backend: BackendConfig;
  mode: Mode;
  reshaper?: ReshaperConfig;
  repair: { maxAttempts: number; destructiveTools: string[] };
  log: { level: "metadata" | "silent"; file: string | null };
}

const DEFAULT_DESTRUCTIVE = ["rm", "delete", "remove", "push", "force", "overwrite", "drop", "reset"];

const DEFAULT_ANTHROPIC_VERSION = "2023-06-01";
export { DEFAULT_ANTHROPIC_VERSION };

/** CLI overrides, applied over the file so the backend can be repointed without editing it. */
export interface ConfigOverrides {
  listen?: string | undefined;
  backendBase?: string | undefined;
  model?: string | undefined;
  mode?: string | undefined;
}

/**
 * Expand `${ENV}` references in a config string against process.env, failing
 * loudly if a referenced variable is unset — so a missing backend URL/key is a
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
  // This tool holds a backend key and does no auth of its own — loopback only.
  if (host !== "127.0.0.1" && host !== "localhost" && host !== "::1") {
    throw new Error(
      `config.listen must bind loopback (127.0.0.1/localhost/::1), got "${host}". ` +
        `Refusing to expose a keyed, unauthenticated proxy on a non-loopback address.`,
    );
  }

  const backend = parseBackend(c.backend, overrides);

  const mode = normalizeMode(c.mode);

  // The backend has no per-request model knowledge here (translation and routing
  // live behind it), so repair mode always needs an explicit reshaper endpoint.
  const reshaper = parseReshaper(c.reshaper);
  if (mode === "repair" && !reshaper) {
    throw new Error(`mode "repair" requires a config.reshaper { base, model, kind?, authEnv? }`);
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
    backend,
    mode,
    ...(reshaper ? { reshaper } : {}),
    repair: { maxAttempts, destructiveTools },
    log: { level, file },
  };
}

function parseBackend(raw: unknown, overrides: ConfigOverrides): BackendConfig {
  const b = (typeof raw === "object" && raw !== null ? raw : {}) as {
    base?: unknown; model?: unknown; authEnv?: unknown; authHeader?: unknown; timeoutMs?: unknown;
  };
  const base = overrides.backendBase ?? b.base;
  if (typeof base !== "string" || base.length === 0) {
    throw new Error(`config.backend.base (string URL) is required`);
  }
  const model = overrides.model ?? b.model;
  return {
    base: expandEnv(base, "backend.base").trim().replace(/\/+$/, ""),
    authHeader: parseAuthHeader(b.authHeader, "x-api-key"),
    timeoutMs: typeof b.timeoutMs === "number" && b.timeoutMs > 0 ? b.timeoutMs : 120000,
    ...(typeof model === "string" && model.length > 0 ? { model: expandEnv(model, "backend.model") } : {}),
    ...(typeof b.authEnv === "string" ? { authEnv: b.authEnv } : {}),
  };
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
