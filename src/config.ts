import { readFileSync } from "node:fs";

export type Mode = "detect" | "repair" | "strict";

export type AuthHeader = "x-api-key" | "authorization";

export interface ReshaperConfig {
  base: string;
  model: string;
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

/** Load + validate a config file, failing loudly on anything unusable. */
export function loadConfig(path: string): Config {
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

  const listen = typeof c.listen === "string" ? c.listen : "127.0.0.1:8791";
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
  const base = backend.base.trim().replace(/\/+$/, "");
  const kind: "anthropic" | "openai" = backend.kind === "openai" ? "openai" : "anthropic";
  if (kind === "openai" && typeof backend.model !== "string") {
    throw new Error(`config.backend.kind "openai" requires config.backend.model (the target model id)`);
  }
  const defaultAuthHeader: AuthHeader = kind === "openai" ? "authorization" : "x-api-key";
  const authHeader: AuthHeader =
    backend.authHeader === "authorization" ? "authorization" : backend.authHeader === "x-api-key" ? "x-api-key" : defaultAuthHeader;
  const timeoutMs =
    typeof backend.timeoutMs === "number" && backend.timeoutMs > 0 ? backend.timeoutMs : 120000;

  const mode = normalizeMode(c.mode);

  const reshaper = parseReshaper(c.reshaper);
  if (mode === "repair" && !reshaper) {
    throw new Error(`mode "repair" requires a config.reshaper { base, model, authEnv }`);
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
      ...(kind === "openai" ? { model: backend.model as string } : {}),
      ...(typeof backend.authEnv === "string" ? { authEnv: backend.authEnv } : {}),
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
  return {
    base: r.base.trim().replace(/\/+$/, ""),
    model: r.model,
    authHeader: r.authHeader === "authorization" ? "authorization" : "x-api-key",
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
  // M1 only implements detect; repair/strict are accepted but behave as detect
  // until M2/M3 land (documented in the spec).
  return "detect";
}
