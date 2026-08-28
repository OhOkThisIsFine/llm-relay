/**
 * Durable COOLING state for the circuit breaker.
 *
 * `circuit-breaker.ts` holds everything in a `Map` and performs no IO, so a relay restart used to
 * discard every cooldown and the whole unexplained-429 escalation ladder. Measured on this
 * operator's relay: `nim/moonshotai/kimi-k3` carried a 19.9-hour cooldown learned from 7
 * consecutive unexplained 429s, and `gemini/models/gemini-3.6-flash` one learned from 26. A
 * restart threw both away and the relay walked straight back into the same walls, paying one real
 * request per wall to relearn what it already knew. Ping health has survived a restart since
 * `probe-cache.json`; this closes the other half, so `CLAUDE.md`'s "health that survives restarts"
 * is true of the breaker too.
 *
 * SCOPE — deliberately narrow, and the omissions are the design:
 * - **Cooldowns and the escalation counter only.** That is what is expensive to relearn.
 * - **No `pings`.** `probe-cache.json` is their one home; a second copy is a second home.
 * - **No `quotaObservations`.** Those are timestamped point-in-time state that the §5.1 staleness
 *   ladder already handles, and persisting them would put a second writer on data
 *   `probe-cache.json` also carries.
 * - **No credential faults.** They expire in 5 minutes and exist to be disproved by a rotated key;
 *   carrying one across a restart would make a fixed credential look broken for no benefit.
 *
 * ⚠ A row is restored ONLY while its cooldown is still in the future. Once it has lapsed the
 * evidence has done its job, and resurrecting a stale `unexplained429s` would send the next single
 * 429 straight to the top of the ladder — a 24-hour penalty invented from a counter nobody
 * re-measured. Same fail-safe direction as everywhere else here: no invented duration.
 *
 * ⚠ Corrupt or unreadable ⇒ restore NOTHING, never a partial or bogus cooldown. `lane-manifest.ts`
 * learned this the hard way: shallow validation let `"x".id === undefined` evict a healthy lane.
 * Every row is validated field by field, and one bad row is dropped without taking the file down.
 */
import { readFileSync, writeFileSync, renameSync, mkdirSync, unlinkSync } from "node:fs";
import { join, dirname } from "node:path";
import { tmpdir } from "node:os";
import { relayStatePath } from "./state-paths.js";
import { WriteBehindTimer } from "./write-behind.js";
import type { BreakerCooldownRow, CooldownSource } from "./circuit-breaker.js";

export type { BreakerCooldownRow } from "./circuit-breaker.js";

/** Bumped when the row shape changes; a mismatch restores nothing rather than guessing. */
export const CURRENT_BREAKER_STATE_VERSION = 1;

export interface BreakerStateFile {
  version: number;
  rows: BreakerCooldownRow[];
}

export function getBreakerStatePath(): string {
  // ⚠ Under vitest, never touch the developer's real cooling state — a suite that trips breakers
  // would otherwise cool the operator's live deployments. Tests pass an explicit `path`.
  // Guarded AT THE RESOLVER, per CLAUDE.md: a call-site guard is how the control-token one came
  // to be half-covered.
  if (process.env.VITEST) return join(tmpdir(), "llm-relay-vitest", "breaker-state.json");
  // Cache-kind: every row is re-learnable by walking into the same wall again. It is neither
  // operator-authored nor credential-bearing.
  return join(relayStatePath("cache"), "breaker-state.json");
}

function isCooldownSource(value: unknown): value is CooldownSource {
  return (
    value === "retry-after" ||
    value === "escalation" ||
    value === "default" ||
    value === "loopback" ||
    value === "quota"
  );
}

/**
 * Validate ONE row completely. Deep, not shallow: the `lane-manifest.ts` regression came from a
 * loader that checked the envelope and let a malformed entry reach logic that read `undefined`
 * off it. Anything unexpected drops this row and only this row.
 */
function isBreakerCooldownRow(value: unknown): value is BreakerCooldownRow {
  if (value === null || typeof value !== "object") return false;
  const row = value as Record<string, unknown>;
  if (typeof row["provider"] !== "string" || row["provider"] === "") return false;
  if (row["model"] !== null && typeof row["model"] !== "string") return false;
  if (typeof row["kind"] !== "string" || row["kind"] === "") return false;
  if (typeof row["credentialId"] !== "string" || row["credentialId"] === "") return false;
  if (row["base"] !== undefined && typeof row["base"] !== "string") return false;
  if (typeof row["cooldownUntil"] !== "number" || !Number.isFinite(row["cooldownUntil"])) return false;
  if (row["cooldownSource"] !== null && !isCooldownSource(row["cooldownSource"])) return false;
  const escalations = row["unexplained429s"];
  if (typeof escalations !== "number" || !Number.isInteger(escalations) || escalations < 0) return false;
  if (row["lastStatus"] !== undefined && typeof row["lastStatus"] !== "number") return false;
  return true;
}

/**
 * Read the still-live cooling rows. Absent file, unreadable file, wrong version, or an envelope
 * that is not `{version, rows: []}` all yield an empty list — never a throw, and never a partial
 * cooldown built from a shape we did not recognize.
 */
export function loadBreakerCooldowns(opts: { path?: string; now?: number } = {}): BreakerCooldownRow[] {
  const target = opts.path ?? getBreakerStatePath();
  const now = opts.now ?? Date.now();
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(target, "utf8"));
  } catch {
    return [];
  }
  if (parsed === null || typeof parsed !== "object") return [];
  const file = parsed as Record<string, unknown>;
  if (file["version"] !== CURRENT_BREAKER_STATE_VERSION) return [];
  const rows = file["rows"];
  if (!Array.isArray(rows)) return [];
  // Expired rows are dropped HERE rather than by the caller, so every consumer of this function
  // sees the same rule and a lapsed escalation counter can never be resurrected.
  return rows.filter((row): row is BreakerCooldownRow => isBreakerCooldownRow(row) && row.cooldownUntil > now);
}

export function saveBreakerCooldowns(rows: readonly BreakerCooldownRow[], opts: { path?: string } = {}): void {
  const target = opts.path ?? getBreakerStatePath();
  const file: BreakerStateFile = { version: CURRENT_BREAKER_STATE_VERSION, rows: [...rows] };
  let tmpPath: string | null = null;
  try {
    mkdirSync(dirname(target), { recursive: true });
    tmpPath = `${target}.${process.pid}.tmp`;
    writeFileSync(tmpPath, JSON.stringify(file, null, 2) + "\n", "utf8");
    renameSync(tmpPath, target);
    tmpPath = null;
  } catch {
    // Best-effort persistence, like every other cache here: failing to save a routing hint must
    // never fail a request or bring the relay down.
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
 * Wire a breaker to the file: restore what is still cooling, then flush on every change.
 *
 * Returns the number of rows restored so a caller can report it. Writes are debounced through the
 * shared `WriteBehindTimer` — the same scheduler the catalog, probe cache and runtime telemetry
 * use — so a burst of failures costs one write, not one per outcome.
 */
export function installBreakerPersistence(
  breaker: {
    restoreCooldowns(rows: readonly BreakerCooldownRow[], now: number): number;
    exportCooldowns(now: number): BreakerCooldownRow[];
    onCoolingChanged(listener: () => void): void;
  },
  opts: { path?: string; now?: () => number } = {},
): number {
  const path = opts.path ?? getBreakerStatePath();
  const clock = opts.now ?? Date.now;
  const restored = breaker.restoreCooldowns(loadBreakerCooldowns({ path, now: clock() }), clock());
  const timer = new WriteBehindTimer();
  breaker.onCoolingChanged(() => {
    timer.touch(() => saveBreakerCooldowns(breaker.exportCooldowns(clock()), { path }));
  });
  return restored;
}
