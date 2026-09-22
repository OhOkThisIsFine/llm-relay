import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

/**
 * Shared state-path policy. Operator-authored data and credentials use the config base;
 * rebuildable data uses the cache base.
 *
 * Prefer XDG, but retain an existing legacy artifact when its XDG counterpart is absent.
 * An existing XDG artifact wins even if a legacy copy remains. Resolution never moves,
 * copies or deletes state, so enabling XDG does not hide existing credentials.
 *
 * This module does not isolate tests. Callers must guard real state access under vitest;
 * the injectable seams let path-policy tests run without touching real state or environment.
 */

/** Which XDG base directory an artifact belongs under. */
export type RelayStateKind = "config" | "cache";

const XDG_VARIABLE: Readonly<Record<RelayStateKind, string>> = {
  config: "XDG_CONFIG_HOME",
  cache: "XDG_CACHE_HOME",
};

export interface RelayStateSeams {
  /** Defaults to `process.env`. */
  readonly env?: NodeJS.ProcessEnv;
  /** Defaults to `os.homedir()`. */
  readonly home?: string;
  /** Defaults to `fs.existsSync`. */
  readonly exists?: (path: string) => boolean;
}

/** The pre-XDG base directory, used by the per-artifact legacy fallback. */
export function legacyRelayDir(seams: RelayStateSeams = {}): string {
  return join(seams.home ?? homedir(), ".llm-relay");
}

/** Resolve a base without checking artifacts; unset or blank XDG variables use the legacy base. */
export function relayBaseDir(kind: RelayStateKind, seams: RelayStateSeams = {}): string {
  const env = seams.env ?? process.env;
  const xdg = env[XDG_VARIABLE[kind]];
  return xdg !== undefined && xdg.trim() !== ""
    ? join(xdg, "llm-relay")
    : legacyRelayDir(seams);
}

/**
 * Resolve an artifact, retaining its legacy path only when the preferred path is absent.
 * `segments` is relative to the base; an empty list resolves the base directory itself.
 */
export function relayStatePath(
  kind: RelayStateKind,
  segments: readonly string[] = [],
  seams: RelayStateSeams = {},
): string {
  const base = relayBaseDir(kind, seams);
  const legacyBase = legacyRelayDir(seams);
  const preferred = segments.length === 0 ? base : join(base, ...segments);
  if (base === legacyBase) return preferred;

  const legacy = segments.length === 0 ? legacyBase : join(legacyBase, ...segments);
  const exists = seams.exists ?? existsSync;
  // Keep using an existing XDG artifact even when a legacy copy remains.
  return exists(preferred) || !exists(legacy) ? preferred : legacy;
}
