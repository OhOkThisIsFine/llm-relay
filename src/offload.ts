import { readFileSync, writeFileSync } from "node:fs";
import type { Config } from "./config.js";

/**
 * Runtime state of the subagent-offload switch.
 *
 * `enabled` is authoritative for routing decisions and lives on the in-memory Config, so a
 * toggle takes effect on the very next request without restarting the proxy. `persisted` says
 * whether that decision also reached disk — an in-memory-only flip is legitimate (a test config,
 * a read-only file) but silently forgetting it on restart would be a nasty surprise, so the
 * caller is told and can say so.
 */
export interface OffloadState {
  enabled: boolean;
  /** Tier → spec map consulted while enabled. Empty means offload is on but routes nowhere. */
  subagents: Record<string, string>;
  persisted: boolean;
  configPath?: string;
  /** Why persistence failed, when it did. */
  persistError?: string;
}

export function offloadState(cfg: Config): OffloadState {
  return {
    enabled: cfg.routing.offload === true,
    subagents: cfg.routing.subagents ?? {},
    persisted: true,
    ...(cfg.sourcePath ? { configPath: cfg.sourcePath } : {}),
  };
}

/**
 * Flip the switch on a live Config and write it back to the file it came from.
 *
 * Rewrites only `routing.offload`, by parsing the on-disk JSON and re-serializing it — the file
 * is the user's, and this must not reformat or drop anything it doesn't understand. Never throws:
 * routing is already updated in memory by the time persistence is attempted, and failing the
 * whole call because the file is read-only would leave the caller unsure which half applied.
 */
export function setOffload(cfg: Config, enabled: boolean): OffloadState {
  cfg.routing.offload = enabled;
  const state = offloadState(cfg);

  if (!cfg.sourcePath) {
    return { ...state, persisted: false, persistError: "config was not loaded from a file" };
  }
  try {
    const raw = JSON.parse(readFileSync(cfg.sourcePath, "utf8")) as Record<string, unknown>;
    const routing = (typeof raw.routing === "object" && raw.routing !== null ? raw.routing : {}) as Record<
      string,
      unknown
    >;
    routing.offload = enabled;
    raw.routing = routing;
    writeFileSync(cfg.sourcePath, JSON.stringify(raw, null, 2) + "\n", "utf8");
    return state;
  } catch (e) {
    return { ...state, persisted: false, persistError: (e as Error).message };
  }
}
