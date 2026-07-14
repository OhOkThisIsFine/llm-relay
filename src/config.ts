import { readFileSync } from "node:fs";

export type Mode = "detect" | "repair" | "strict";

export type AuthHeader = "x-api-key" | "authorization";

export interface Config {
  host: string;
  port: number;
  backend: {
    base: string;
    authEnv?: string;
    /** Which header to inject the backend key into. Default "x-api-key". */
    authHeader: AuthHeader;
    /** Backend request deadline in ms. Default 120000. */
    timeoutMs: number;
  };
  mode: Mode;
  log: { level: "metadata" | "silent"; file: string | null };
}

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
    authEnv?: unknown;
    authHeader?: unknown;
    timeoutMs?: unknown;
  };
  const base = backend.base.trim().replace(/\/+$/, "");
  const authHeader: AuthHeader = backend.authHeader === "authorization" ? "authorization" : "x-api-key";
  const timeoutMs =
    typeof backend.timeoutMs === "number" && backend.timeoutMs > 0 ? backend.timeoutMs : 120000;

  const mode = normalizeMode(c.mode);

  const logRaw = (c.log ?? {}) as { level?: unknown; file?: unknown };
  const level = logRaw.level === "silent" ? "silent" : "metadata";
  const file = typeof logRaw.file === "string" ? logRaw.file : null;

  return {
    host,
    port,
    backend: {
      base,
      authHeader,
      timeoutMs,
      ...(typeof backend.authEnv === "string" ? { authEnv: backend.authEnv } : {}),
    },
    mode,
    log: { level, file },
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
