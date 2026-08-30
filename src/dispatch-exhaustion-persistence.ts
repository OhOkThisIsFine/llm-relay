/**
 * Durable exhaustion state for the dispatch ladder.
 *
 * `dispatch.ts` holds host-reported cooldowns in a per-config in-memory map and performs no IO,
 * so a relay restart forgot every one of them. For the 15-minute defaults that loss is almost
 * free, but the report route accepts a vendor-stated `retryAfterMs` up to 30 days — exactly the
 * rows worth keeping: a "Codex weekly allowance spent until <date>" report is expensive evidence,
 * and forgetting it sends hosts back into a wall the relay had already been told about. This is
 * the `breaker-persistence.ts` contract applied to the ladder; read that module's header for the
 * reasoning this one inherits.
 *
 * ⚠ A row is restored ONLY while its expiry is still in the future (`loadExhaustedRows` filters,
 * and `restoreExhaustedRows` filters again). ⚠ Corrupt or unreadable ⇒ restore NOTHING; every row
 * is validated field by field and one bad row is dropped without taking the file down — the
 * `lane-manifest.ts` shallow-validation regression is the standing warning. ⚠ Restore never
 * overwrites a cooldown the live process already learned.
 */
import { readFileSync, writeFileSync, renameSync, mkdirSync, unlinkSync } from "node:fs";
import { join, dirname } from "node:path";
import { tmpdir } from "node:os";
import { relayStatePath } from "./state-paths.js";
import { WriteBehindTimer } from "./write-behind.js";
import {
  exportExhaustedRows,
  onExhaustionChanged,
  restoreExhaustedRows,
  type ExhaustedRow,
} from "./dispatch.js";
import type { Config } from "./config.js";

/** Bumped when the row shape changes; a mismatch restores nothing rather than guessing. */
export const CURRENT_DISPATCH_EXHAUSTION_VERSION = 1;

export interface DispatchExhaustionFile {
  version: number;
  rows: ExhaustedRow[];
}

export function getDispatchExhaustionPath(): string {
  // ⚠ Under vitest, never touch the operator's real ladder state — a suite that marks lanes
  // exhausted would otherwise park the live ladder. Guarded AT THE RESOLVER, per CLAUDE.md.
  if (process.env.VITEST) return join(tmpdir(), "llm-relay-vitest", "dispatch-exhaustion.json");
  // Cache-kind: every row is re-learnable from the next host report. Neither operator-authored
  // nor credential-bearing.
  return join(relayStatePath("cache"), "dispatch-exhaustion.json");
}

/** Validate ONE row completely; anything unexpected drops this row and only this row. */
function isExhaustedRow(value: unknown): value is ExhaustedRow {
  if (value === null || typeof value !== "object") return false;
  const row = value as Record<string, unknown>;
  if (typeof row["key"] !== "string" || row["key"] === "") return false;
  if (typeof row["until"] !== "number" || !Number.isFinite(row["until"])) return false;
  return true;
}

/**
 * Read the still-live rows. Absent file, unreadable file, wrong version, or an unrecognized
 * envelope all yield an empty list — never a throw, never a partial cooldown from a shape we
 * did not recognize.
 */
export function loadExhaustedRows(opts: { path?: string; now?: number } = {}): ExhaustedRow[] {
  const target = opts.path ?? getDispatchExhaustionPath();
  const now = opts.now ?? Date.now();
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(target, "utf8"));
  } catch {
    return [];
  }
  if (parsed === null || typeof parsed !== "object") return [];
  const file = parsed as Record<string, unknown>;
  if (file["version"] !== CURRENT_DISPATCH_EXHAUSTION_VERSION) return [];
  const rows = file["rows"];
  if (!Array.isArray(rows)) return [];
  // Expired rows are dropped HERE so every consumer sees the same rule.
  return rows.filter((row): row is ExhaustedRow => isExhaustedRow(row) && row.until > now);
}

export function saveExhaustedRows(rows: readonly ExhaustedRow[], opts: { path?: string } = {}): void {
  const target = opts.path ?? getDispatchExhaustionPath();
  const file: DispatchExhaustionFile = { version: CURRENT_DISPATCH_EXHAUSTION_VERSION, rows: [...rows] };
  let tmpPath: string | null = null;
  try {
    mkdirSync(dirname(target), { recursive: true });
    tmpPath = `${target}.${process.pid}.tmp`;
    writeFileSync(tmpPath, JSON.stringify(file, null, 2) + "\n", "utf8");
    renameSync(tmpPath, target);
    tmpPath = null;
  } catch {
    // Best-effort persistence: failing to save a routing hint must never fail a request.
  } finally {
    if (tmpPath !== null) {
      try {
        unlinkSync(tmpPath);
      } catch {
        /* best effort cleanup */
      }
    }
  }
}

/**
 * Wire a config's ladder state to the file: restore what is still cooling, then flush on every
 * change, debounced through the shared `WriteBehindTimer`. Returns the number restored.
 */
export function installDispatchExhaustionPersistence(
  cfg: Config,
  opts: { path?: string; now?: () => number } = {},
): number {
  const path = opts.path ?? getDispatchExhaustionPath();
  const clock = opts.now ?? Date.now;
  const restored = restoreExhaustedRows(cfg, loadExhaustedRows({ path, now: clock() }), clock());
  const timer = new WriteBehindTimer();
  onExhaustionChanged(cfg, () => {
    timer.touch(() => saveExhaustedRows(exportExhaustedRows(cfg, clock()), { path }));
  });
  return restored;
}
