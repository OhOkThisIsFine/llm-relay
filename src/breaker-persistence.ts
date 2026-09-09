/**
 * Durable state for the circuit breaker — the WHOLE cell survives a relay restart.
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
 * Owner decision 2026-09-08: the WHOLE cell must survive — failure counters, credential fault,
 * the served-request ping window, and quota observations — with the same semantics the running
 * process has.
 *
 * SCOPE — widened from the cooling half only (owner decision 2026-09-08):
 * - **Every field of the cell:** cooldownUntil, cooldownSource, unexplained429s, lastStatus,
 *   consecutiveFailures, lastFailureTime, credentialFailures, lastCredentialStatus,
 *   credentialFaultUntil, pings, quotaObservations.
 * - **Pings:** this is the served-request window that `GET /telemetry` (`src/telemetry.ts`) scores
 *   stability from, which went blank after every restart; `probe-cache.json` holds the PROBE
 *   dataset, a different dataset, so this is not a second home for the same data.
 * - **Quota observations:** the read-time staleness ladder in `src/availability.ts` already discards
 *   an observation outside its current period, so persisting one is safe.
 * - **Credential faults:** a fault is active only while `credentialFaultUntil` is in the future
 *   (5 minutes). Stated cost, accepted by the owner: a key rotated during a restart reads as
 *   faulted for at most that long, cleared by the first success or by `llm-relay cooldowns clear`.
 *
 * ⚠ Corrupt or unreadable ⇒ restore NOTHING, never a partial or bogus cooldown. `lane-manifest.ts`
 * learned this the hard way: shallow validation let `"x".id === undefined` evict a healthy lane.
 * Every row is validated field by field, and one bad row is dropped without taking the file down.
 *
 * ⚠ A row is restored even when its cooldown has lapsed. The old rule — restore only while the
 * cooldown is still in the future — reset the escalation ladder on every restart, a behaviour the
 * running process does not have. In memory a lapsed cooldown keeps its `unexplained429s`; the
 * counter alone demotes nothing, only a FRESH 429 applies it, and that 429 is a fresh measurement
 * of the same condition. A restart is not a success.
 *
 * ⚠ Write frequency: every outcome now dirties the file, and the `WriteBehindTimer` bounds writes
 * to one per 250 ms of quiet and one per 2 s under sustained load.
 */
import { join } from "node:path";
import { tmpdir } from "node:os";
import { relayStatePath } from "./state-paths.js";
import { WriteBehindRegistry, WriteBehindTimer } from "./write-behind.js";
import { atomicWriteJsonSync, safeReadJsonSync } from "./storage/json-store.js";
import { COOLDOWN_SOURCES } from "./circuit-breaker.js";
import type { BreakerCellRow, CooldownSource } from "./circuit-breaker.js";
import type { PingRecord } from "./ping/metrics.js";
import type { QuotaObservation } from "./quota-observation.js";
import { QUOTA_AXES, QUOTA_PERIODS } from "./dashboard-contract.js";

export type { BreakerCellRow } from "./circuit-breaker.js";

/** Bumped when the MEANING of an existing field changes, never when an optional field is added. */
export const CURRENT_BREAKER_STATE_VERSION = 1;

export interface BreakerStateFile {
  version: number;
  rows: BreakerCellRow[];
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

/**
 * ⚠ DERIVED from `COOLDOWN_SOURCES`, never hand-listed.
 *
 * This function used to re-state all five members literally, which is the "runtime list
 * hand-copied from the type" defect `CLAUDE.md` records against `UNTIL_BASES` and nine
 * `dashboard-contract.ts` unions: the compiler cannot connect a literal chain to the union, so
 * adding a member type-checks clean while every persisted row carrying it fails validation and is
 * dropped at load — silently, since one bad row is discarded alone by design. Adding `elapsed`
 * (2026-08-30) would have done exactly that.
 */
const COOLDOWN_SOURCE_SET: ReadonlySet<string> = new Set(COOLDOWN_SOURCES);

function isCooldownSource(value: unknown): value is CooldownSource {
  return typeof value === "string" && COOLDOWN_SOURCE_SET.has(value);
}

function isValidPingRecord(value: unknown): value is PingRecord {
  if (value === null || typeof value !== "object") return false;
  const row = value as Record<string, unknown>;
  if (typeof row["ms"] !== "number" || !Number.isFinite(row["ms"])) return false;
  if (typeof row["code"] !== "string" || row["code"] === "") return false;
  if (typeof row["timestamp"] !== "number" || !Number.isFinite(row["timestamp"])) return false;
  if (row["tokens"] !== undefined && (typeof row["tokens"] !== "number" || !Number.isFinite(row["tokens"]))) return false;
  if (row["source"] !== undefined && row["source"] !== "probe" && row["source"] !== "request") return false;
  return true;
}

function isValidQuotaObservation(value: unknown): value is QuotaObservation {
  if (value === null || typeof value !== "object") return false;
  const row = value as Record<string, unknown>;
  if (!QUOTA_AXES.includes(row["axis"] as QuotaObservation["axis"])) return false;
  if (!QUOTA_PERIODS.includes(row["period"] as QuotaObservation["period"])) return false;
  if (typeof row["limit"] !== "number" || !Number.isFinite(row["limit"])) return false;
  if (typeof row["remaining"] !== "number" || !Number.isFinite(row["remaining"])) return false;
  if (row["resetsAt"] !== null && (typeof row["resetsAt"] !== "number" || !Number.isFinite(row["resetsAt"]))) return false;
  if (typeof row["observedAt"] !== "number" || !Number.isFinite(row["observedAt"])) return false;
  if (row["basis"] !== "provider-stated") return false;
  return true;
}

/**
 * Validate ONE row completely. Deep, not shallow: the `lane-manifest.ts` regression came from a
 * loader that checked the envelope and let a malformed entry reach logic that read `undefined`
 * off it. Anything unexpected drops this row and only this row.
 */
function isBreakerCellRow(value: unknown): value is BreakerCellRow {
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
  // New fields — each accepted when undefined OR valid
  if (row["consecutiveFailures"] !== undefined &&
      (typeof row["consecutiveFailures"] !== "number" || !Number.isInteger(row["consecutiveFailures"]) || row["consecutiveFailures"] < 0)) return false;
  if (row["lastFailureTime"] !== undefined &&
      (typeof row["lastFailureTime"] !== "number" || !Number.isFinite(row["lastFailureTime"]) || row["lastFailureTime"] < 0)) return false;
  if (row["credentialFailures"] !== undefined &&
      (typeof row["credentialFailures"] !== "number" || !Number.isInteger(row["credentialFailures"]) || row["credentialFailures"] < 0)) return false;
  if (row["lastCredentialStatus"] !== undefined && typeof row["lastCredentialStatus"] !== "number") return false;
  if (row["credentialFaultUntil"] !== undefined &&
      (typeof row["credentialFaultUntil"] !== "number" || !Number.isFinite(row["credentialFaultUntil"]) || row["credentialFaultUntil"] < 0)) return false;
  if (row["pings"] !== undefined) {
    if (!Array.isArray(row["pings"])) return false;
    for (const ping of row["pings"]) {
      if (!isValidPingRecord(ping)) return false;
    }
  }
  if (row["quotaObservations"] !== undefined) {
    if (!Array.isArray(row["quotaObservations"])) return false;
    for (const obs of row["quotaObservations"]) {
      if (!isValidQuotaObservation(obs)) return false;
    }
  }
  return true;
}

/**
 * Read all valid rows. Absent file, unreadable file, wrong version, or an envelope
 * that is not `{version, rows: []}` all yield an empty list — never a throw, and never a partial
 * cooldown built from a shape we did not recognize.
 *
 * Expired rows are KEPT — a lapsed cooldown restores as lapsed, and its escalation counter
 * stays with it. The running process does not discard a lapsed cooldown's counter.
 */
export function loadBreakerState(opts: { path?: string } = {}): BreakerCellRow[] {
  const target = opts.path ?? getBreakerStatePath();
  const parsed = safeReadJsonSync<Record<string, unknown>>(target);
  if (parsed === null || typeof parsed !== "object") return [];
  if (parsed["version"] !== CURRENT_BREAKER_STATE_VERSION) return [];
  const rows = parsed["rows"];
  if (!Array.isArray(rows)) return [];
  return rows.filter((row): row is BreakerCellRow => isBreakerCellRow(row));
}

export function saveBreakerState(rows: readonly BreakerCellRow[], opts: { path?: string } = {}): void {
  const target = opts.path ?? getBreakerStatePath();
  const file: BreakerStateFile = { version: CURRENT_BREAKER_STATE_VERSION, rows: [...rows] };
  atomicWriteJsonSync(target, file, { space: 2 });
}

export interface BreakerPersistenceHandle {
  /** Rows applied at install — the count a caller can report, as before. */
  readonly restored: number;
  /** Write NOW when a change is still unflushed; a clean timer writes nothing. True when it wrote. */
  flush(): boolean;
}

/** Every timer an install armed, so the shutdown flush needs no handle from the installer. */
const installed = new WriteBehindRegistry();

/**
 * Wire a breaker to the file: restore every cell, then flush on every change.
 *
 * Writes are debounced through the shared `WriteBehindTimer` — the same scheduler the catalog,
 * probe cache and runtime telemetry use — so a burst of outcomes costs one write, not one per
 * outcome. The handle's `flush()` and the module-level `flushBreakerPersistence()` are the same
 * mechanism (`WriteBehindTimer.flushNow`), so a test and a shutdown cannot disagree about what a
 * flush does.
 */
export function installBreakerPersistence(
  breaker: {
    restoreState(rows: readonly BreakerCellRow[]): number;
    exportState(): BreakerCellRow[];
    onStateChanged(listener: () => void): void;
  },
  opts: { path?: string } = {},
): BreakerPersistenceHandle {
  const path = opts.path ?? getBreakerStatePath();
  const restored = breaker.restoreState(loadBreakerState({ path }));
  const timer = installed.register(new WriteBehindTimer());
  breaker.onStateChanged(() => {
    timer.touch(() => saveBreakerState(breaker.exportState(), { path }));
  });
  return {
    restored,
    flush: () => {
      try {
        return timer.flushNow();
      } catch {
        /* best-effort persistence */
        return false;
      }
    },
  };
}

/**
 * The shutdown seam: write every dirty breaker file NOW. `runProxy` calls it beside the sibling
 * flushes in both shutdown sites. Returns how many files were written.
 */
export function flushBreakerPersistence(): number {
  return installed.flushAll();
}