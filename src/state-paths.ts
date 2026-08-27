import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

/**
 * Where llm-relay's state lives — the ONE definition, and the reason this module exists.
 *
 * Before 0.51.0 the answer was hand-rolled in THIRTEEN resolvers running THREE different policies:
 * `usage/`, `probe-cache.json` and `runtime-telemetry.json` honoured `XDG_CACHE_HOME`;
 * `target-facts.json` and `refusal-interpretations.json` honoured `XDG_CONFIG_HOME`; and the other
 * eight — including `config.json`, `.env`, `keystore.json` and the control token — honoured
 * neither. Nothing was broken (each resolver was internally consistent), but with either variable
 * set the state directory SPLIT IN TWO, so "back up `~/.llm-relay/`" silently stopped being a
 * complete backup. Owner decision 2026-08-27: honour XDG everywhere.
 *
 * ⚠ **The legacy fallback is the whole safety story, and it is not optional.** Making a resolver
 * honour XDG MOVES where it looks. For `keystore.json` that is the difference between finding an
 * operator's encrypted credentials and reporting an empty store — i.e. "my keys are gone" on an
 * install that was working a minute earlier. So `relayStatePath` never returns an XDG path when
 * the XDG one is ABSENT and the legacy `~/.llm-relay/` one EXISTS: an existing install keeps
 * reading, and writing, exactly where it already does. A fresh install with XDG set is fully XDG.
 * That is why there is no migration step and nothing is ever copied or deleted — the safest
 * migration is the one that does not run.
 *
 * ⚠ The classification is per ARTIFACT and follows the XDG spec's own distinction, not
 * convenience: anything the operator authored or that holds a credential is `config`; anything the
 * relay can rebuild by asking a provider again is `cache`. Do not reclassify an artifact to move
 * it — that is the split this module was created to end.
 *
 * ⚠ This module is NOT a vitest guard. Every caller keeps its own `process.env.VITEST` check
 * ABOVE the call, because a call-site guard is exactly how the control-token one came to be
 * half-covered (see the persistent-storage invariant in CLAUDE.md). The seams below exist so
 * `test/state-paths.test.ts` can exercise the policy without touching real state or real env.
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

/** The pre-XDG location, still authoritative for any install that already has state there. */
export function legacyRelayDir(seams: RelayStateSeams = {}): string {
  return join(seams.home ?? homedir(), ".llm-relay");
}

/**
 * The XDG base for one kind, ignoring the legacy fallback.
 *
 * A variable that is unset, empty, or whitespace-only is treated as absent — the same rule the
 * two pre-existing XDG resolvers already used, kept so this change moves nothing for anyone whose
 * variable was blank.
 */
export function relayBaseDir(kind: RelayStateKind, seams: RelayStateSeams = {}): string {
  const env = seams.env ?? process.env;
  const xdg = env[XDG_VARIABLE[kind]];
  return xdg !== undefined && xdg.trim() !== ""
    ? join(xdg, "llm-relay")
    : legacyRelayDir(seams);
}

/**
 * Resolve one artifact's path: XDG when it applies, legacy when legacy already holds it.
 *
 * `segments` is the path BELOW the base — `["keystore.json"]`, `["usage"]`, `["hooks", "x.js"]`.
 * Pass none to address the base directory itself.
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
  // Only the ABSENCE of the new location may hand control back to the old one. An install that
  // has already written to the XDG path stays there even if a legacy file lingers beside it.
  return exists(preferred) || !exists(legacy) ? preferred : legacy;
}
