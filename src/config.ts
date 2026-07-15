import { readFileSync } from "node:fs";

export type Mode = "detect" | "repair" | "strict";

export type AuthHeader = "x-api-key" | "authorization";

export interface ReshaperConfig {
  base: string;
  model: string;
  /** "anthropic": call /v1/messages. "openai": call /chat/completions (NIM/vLLM). */
  kind: "anthropic" | "openai";
  authEnv?: string;
  authHeader: AuthHeader;
  timeoutMs: number;
}

export interface Config {
  host: string;
  port: number;
  backend: {
    base: string;
    /**
     * "anthropic" (default): backend speaks Anthropic Messages; forward as-is.
     * "openai": backend is OpenAI-compatible (NIM/vLLM/OpenRouter); the proxy
     * translates request+response via llm-bridge. Requires `model`.
     */
    kind: "anthropic" | "openai";
    /** Target model id for kind="openai" (e.g. "meta/llama-3.1-70b-instruct"). */
    model?: string;
    authEnv?: string;
    /** Which header to inject the backend key into. Default: x-api-key (anthropic) / authorization (openai). */
    authHeader: AuthHeader;
    /** Backend request deadline in ms. Default 120000. */
    timeoutMs: number;
  };
  mode: Mode;
  /** Required when mode === "repair". */
  reshaper?: ReshaperConfig;
  repair: { maxAttempts: number; destructiveTools: string[] };
  log: { level: "metadata" | "silent"; file: string | null };
}

const DEFAULT_DESTRUCTIVE = ["rm", "delete", "remove", "push", "force", "overwrite", "drop", "reset"];

const DEFAULT_ANTHROPIC_VERSION = "2023-06-01";
export { DEFAULT_ANTHROPIC_VERSION };

/** CLI overrides, applied over the file so a provider can be repointed without editing it. */
export interface ConfigOverrides {
  listen?: string | undefined;
  backendBase?: string | undefined;
  model?: string | undefined;
  mode?: string | undefined;
}

/**
 * Expand `${ENV}` references in a config string against process.env, failing
 * loudly if a referenced variable is unset — so a missing provider URL/key is a
 * clear startup error, never a silent empty value. `$${` is a literal `${`.
 */
function expandEnv(value: string, where: string): string {
  return value.replace(/\$\{([A-Za-z_][A-Za-z0-9_]*)\}/g, (_m, name: string) => {
    const v = process.env[name];
    if (v === undefined) throw new Error(`config.${where} references unset env var \${${name}}`);
    return v;
  });
}

function expandField(raw: unknown, where: string): unknown {
  return typeof raw === "string" && raw.includes("${") ? expandEnv(raw, where) : raw;
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

  // Merge CLI overrides over the file before validation, so every check (loopback,
  // port range, openai-needs-model) runs on the effective config.
  if (overrides.listen !== undefined) c.listen = overrides.listen;
  if (overrides.mode !== undefined) c.mode = overrides.mode;
  if (overrides.backendBase !== undefined || overrides.model !== undefined) {
    const b = (typeof c.backend === "object" && c.backend !== null ? c.backend : {}) as Record<string, unknown>;
    if (overrides.backendBase !== undefined) b.base = overrides.backendBase;
    if (overrides.model !== undefined) b.model = overrides.model;
    c.backend = b;
  }

  const listen = typeof c.listen === "string" ? expandEnv(c.listen, "listen") : "127.0.0.1:8791";
  const [host, portStr] = splitHostPort(listen);
  const port = Number(portStr);
  if (!Number.isInteger(port) || port <= 0 || port > 65535) {
    throw new Error(`config.listen has invalid port: "${listen}"`);
  }
  // This tool holds a provider key and does no auth of its own — loopback only.
  if (host !== "127.0.0.1" && host !== "localhost" && host !== "::1") {
    throw new Error(
      `config.listen must bind loopback (127.0.0.1/localhost/::1), got "${host}". ` +
        `Refusing to expose a keyed, unauthenticated proxy on a non-loopback address.`,
    );
  }

  const backendRaw = c.backend;
  if (
    typeof backendRaw !== "object" ||
    backendRaw === null ||
    typeof (backendRaw as { base?: unknown }).base !== "string"
  ) {
    throw new Error(`config.backend.base (string URL) is required`);
  }
  const backend = backendRaw as {
    base: string;
    kind?: unknown;
    model?: unknown;
    authEnv?: unknown;
    authHeader?: unknown;
    timeoutMs?: unknown;
  };
  const base = expandEnv(backend.base, "backend.base").trim().replace(/\/+$/, "");
  const kind: "anthropic" | "openai" = backend.kind === "openai" ? "openai" : "anthropic";
  const model = typeof backend.model === "string" ? expandEnv(backend.model, "backend.model") : undefined;
  if (kind === "openai" && model === undefined) {
    throw new Error(`config.backend.kind "openai" requires config.backend.model (the target model id)`);
  }
  const defaultAuthHeader: AuthHeader = kind === "openai" ? "authorization" : "x-api-key";
  const authHeader: AuthHeader =
    backend.authHeader === "authorization" ? "authorization" : backend.authHeader === "x-api-key" ? "x-api-key" : defaultAuthHeader;
  const timeoutMs =
    typeof backend.timeoutMs === "number" && backend.timeoutMs > 0 ? backend.timeoutMs : 120000;
  const backendAuthEnv = typeof backend.authEnv === "string" ? backend.authEnv : undefined;

  const mode = normalizeMode(c.mode);

  // Reshaper: an explicit block wins; otherwise, for a repair-mode OpenAI backend,
  // synthesize one that reuses the SAME provider (base/model/kind/key) — so repair
  // runs on the backend with no second block to edit. An Anthropic backend has no
  // fixed model id (it's per-request passthrough), so it still needs an explicit
  // reshaper naming a cheap model.
  let reshaper = parseReshaper(c.reshaper);
  if (!reshaper && mode === "repair" && kind === "openai" && model !== undefined) {
    reshaper = {
      base,
      model,
      kind,
      authHeader,
      timeoutMs: Math.min(timeoutMs, 60000),
      ...(backendAuthEnv ? { authEnv: backendAuthEnv } : {}),
    };
  }
  if (mode === "repair" && !reshaper) {
    throw new Error(
      `mode "repair" requires a config.reshaper { base, model, authEnv } ` +
        `(auto-synthesized only for an OpenAI backend, which this is not)`,
    );
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
    backend: {
      base,
      kind,
      authHeader,
      timeoutMs,
      ...(model !== undefined ? { model } : {}),
      ...(backendAuthEnv ? { authEnv: backendAuthEnv } : {}),
    },
    mode,
    ...(reshaper ? { reshaper } : {}),
    repair: { maxAttempts, destructiveTools },
    log: { level, file },
  };
}

function parseReshaper(raw: unknown): ReshaperConfig | undefined {
  if (typeof raw !== "object" || raw === null) return undefined;
  const r = raw as Record<string, unknown>;
  if (typeof r.base !== "string" || typeof r.model !== "string") return undefined;
  const kind: "anthropic" | "openai" = r.kind === "openai" ? "openai" : "anthropic";
  const defaultAuthHeader: AuthHeader = kind === "openai" ? "authorization" : "x-api-key";
  const authHeader: AuthHeader =
    r.authHeader === "authorization" ? "authorization" : r.authHeader === "x-api-key" ? "x-api-key" : defaultAuthHeader;
  return {
    base: expandEnv(r.base, "reshaper.base").trim().replace(/\/+$/, ""),
    model: expandEnv(r.model, "reshaper.model"),
    kind,
    authHeader,
    timeoutMs: typeof r.timeoutMs === "number" && r.timeoutMs > 0 ? r.timeoutMs : 60000,
    ...(typeof r.authEnv === "string" ? { authEnv: r.authEnv } : {}),
  };
}

function splitHostPort(listen: string): [string, string] {
  // Bracketed IPv6, e.g. "[::1]:8791".
  const bracket = /^\[(.+)\]:(\d+)$/.exec(listen);
  if (bracket) return [bracket[1]!, bracket[2]!];
  const idx = listen.lastIndexOf(":");
  if (idx === -1) return ["127.0.0.1", listen];
  return [listen.slice(0, idx) || "127.0.0.1", listen.slice(idx + 1)];
}

function normalizeMode(v: unknown): Mode {
  if (v === "detect" || v === "repair" || v === "strict") return v;
  // Unknown values fall back to detect. Note: "strict" is accepted but currently
  // behaves like "detect" (validate + observe); only "repair" acts on failures.
  return "detect";
}
