/**
 * Per-lane execution stats for the dispatch ladder.
 *
 * `dispatch.ts` holds host-reported cooldowns in a per-config in-memory map; this module holds
 * the OTHER half of what a lane run teaches the relay — how often each rung was taken and how
 * long it took — in the same per-Config shape, mirrored to `dispatch-lane-stats.json` through
 * the shared `WriteBehindTimer` (the `dispatch-exhaustion-persistence.ts` contract, read that
 * module's header for the reasoning this one inherits).
 *
 * ⚠ These stats are ADVISORY and never reorder the ladder. ⚠ They never touch
 * `runtime-telemetry.json`: a CLI lane's wall-clock includes process launch, harness start-up
 * and tool execution (10 s–60 s+), which would poison the HTTP pool scoring
 * (`speedScore = 100 * (1 - avgLatency / 5000)`) that file feeds. ⚠ Restore never overwrites
 * what the live process already learned. ⚠ Corrupt or unreadable ⇒ restore NOTHING; every row
 * is validated field by field and one bad row is dropped without taking the file down — the
 * `lane-manifest.ts` shallow-validation regression is the standing warning.
 */
import { join } from "node:path";
import { tmpdir } from "node:os";
import { relayStatePath } from "./state-paths.js";
import { WriteBehindRegistry, WriteBehindTimer } from "./write-behind.js";
import { atomicWriteJsonSync, safeReadJsonSync } from "./storage/json-store.js";
import { isDashboardSafeId } from "./dashboard-contract.js";
import type { Config } from "./config.js";
import type { LadderRung } from "./config-types.js";

/**
 * The lane KIND travels as data, never as two hand-copies: the `as const` array is the ONE
 * declaration — the type is indexed from it and the parser validates against it, so a new kind
 * is a compile error at the classifier rather than a silent fall-through (the closed-union
 * gotcha in CLAUDE.md).
 */
export const DISPATCH_LANE_KINDS = Object.freeze(["cli", "relay"] as const);
export type DispatchLaneKind = (typeof DISPATCH_LANE_KINDS)[number];

/**
 * Terminal lane states worth recording. A job the OPERATOR cancelled is discarded, never reported:
 * a caller changing its mind is not evidence about the lane.
 *
 * ⚠ `abandoned` is the fourth member and is the OPPOSITE case, which is why it had to be told
 * apart from `cancelled` rather than folded into it (`docs/backlog.md`: *"an operator cancellation
 * is distinguishable in the record from a lane that was never asked"*). The relay's own walk
 * stopped this lane because it did not answer inside the budget it was given. That IS evidence
 * about the lane, so it is recorded — and it is distinct from `timed_out`, which means the lane
 * exceeded its OWN configured ceiling (35 minutes on this machine's slowest rung, against a walk
 * budget measured in seconds). Conflating the two would report a 90-second miss as a 35-minute one.
 */
export const DISPATCH_LANE_STATUSES = Object.freeze(["completed", "failed", "timed_out", "abandoned"] as const);
export type DispatchLaneStatus = (typeof DISPATCH_LANE_STATUSES)[number];

/**
 * How a dispatch ran the lane: `answer` is one HTTP call to the relay's own `/v1/messages` (a relay
 * lane in answer mode); `agent` is a spawned harness running a tool loop (every other case).
 *
 * ⚠ It keys the lane-stats window since 2026-09-10, because the two are different populations: a
 * burst of short answer-mode calls set `free-pool`'s p80 to 39.5 s, and that one shared window then
 * cut every agent-mode task on the same lane at the 90 s floor
 * (`docs/history/dispatch-giveup-diagnosis-2026-09-10.md` §3). One `as const` array, the type indexed from
 * it and the parser validating against it — the closed-union rule.
 */
export const DISPATCH_MODES = Object.freeze(["agent", "answer"] as const);
export type DispatchMode = (typeof DISPATCH_MODES)[number];

/**
 * What `llm-relay mcp` reports to the daemon when an agent-mode lane run settles. Counts and
 * lengths only — never the task text, never the lane's output (logs-are-metadata-only).
 *
 * ⚠ No `providerKey`/`modelId`: an agent-mode lane's serving member is unknowable to the
 * reporter (a `cli` lane runs its own tool loop against its own credentials; a `relay` lane's
 * HTTP traffic is already metered by the daemon's own pipeline), so carrying them would label
 * a guess as a measurement.
 */
export interface DispatchedTelemetryReport {
  jobId: string;
  laneId: string;
  kind: DispatchLaneKind;
  spec?: string;
  /**
   * Ladder tier the lane was taken from, when the dispatch selected one. Absent for the legacy
   * single ladder.
   *
   * ⚠ It is here because the daemon's routing MEMORY is keyed by tier: each tier is its own
   * ladder with its own rungs, so a lane that answered a `low` task says nothing about the
   * `xhigh` ladder, and a pin recorded without the tier would let one cheap success steer every
   * reasoning level. Metadata like every other field — a configured ladder name, never task text.
   */
  tier?: string;
  /**
   * How the lane ran (`DispatchMode`). Absent from an older MCP child, whose report then lands in
   * the mode-less legacy window rather than being guessed into one.
   */
  mode?: DispatchMode;
  wallClockMs: number;
  exitCode: number | null;
  status: DispatchLaneStatus;
  estimatedInputTokens: number;
  estimatedOutputTokens: number;
}

/**
 * The report's exact key set, bound to the interface TWICE (the `SHARE_CELL_KEYS` precedent
 * in `dashboard-contract.ts`): `satisfies` rejects a listed key the interface does not declare,
 * and `_REPORT_KEYS_COMPLETE` rejects an interface key nobody listed — a new field is a
 * compile error here rather than a silent 400 for every report that carries it (the
 * closed-union gotcha in CLAUDE.md). `spec` is optional on the interface but still a
 * permitted key, so it is listed like the rest; the parser below accepts its absence.
 */
const REPORT_KEYS = Object.freeze([
  "jobId",
  "laneId",
  "kind",
  "spec",
  "tier",
  "mode",
  "wallClockMs",
  "exitCode",
  "status",
  "estimatedInputTokens",
  "estimatedOutputTokens",
] as const satisfies readonly (keyof DispatchedTelemetryReport)[]);
type _UnlistedReportKeys = Exclude<keyof DispatchedTelemetryReport, (typeof REPORT_KEYS)[number]>;
const _REPORT_KEYS_COMPLETE: _UnlistedReportKeys extends never ? true : false = true;
const REPORT_KEY_SET = new Set<string>(REPORT_KEYS);

const MAX_JOB_ID_CHARS = 64;
const MAX_LANE_ID_CHARS = 200;
const MAX_SPEC_CHARS = 200;
const MAX_TIER_CHARS = 64;

function isBoundedId(value: unknown, maxChars: number): value is string {
  return typeof value === "string"
    && value.length >= 1
    && value.length <= maxChars
    && isDashboardSafeId(value);
}

function isTokenCount(value: unknown): value is number {
  return typeof value === "number" && Number.isInteger(value) && value >= 0;
}

/**
 * Fail-closed validation of one report body. Anything unexpected — unknown keys, a missing
 * field, a bad kind/status, a negative or fractional token count, an over-long id — yields
 * null rather than a guess. The 400 reason never echoes the body.
 */
export function parseTelemetryReport(value: unknown): DispatchedTelemetryReport | null {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return null;
  const body = value as Record<string, unknown>;
  for (const key of Object.keys(body)) {
    if (!REPORT_KEY_SET.has(key)) return null;
  }
  const { jobId, laneId, kind, spec, tier, mode, wallClockMs, exitCode, status, estimatedInputTokens, estimatedOutputTokens } = body;
  if (!isBoundedId(jobId, MAX_JOB_ID_CHARS)) return null;
  if (!isBoundedId(laneId, MAX_LANE_ID_CHARS)) return null;
  if (spec !== undefined && !isBoundedId(spec, MAX_SPEC_CHARS)) return null;
  if (tier !== undefined && !isBoundedId(tier, MAX_TIER_CHARS)) return null;
  if (mode !== undefined && !DISPATCH_MODES.includes(mode as DispatchMode)) return null;
  if (!DISPATCH_LANE_KINDS.includes(kind as DispatchLaneKind)) return null;
  if (!DISPATCH_LANE_STATUSES.includes(status as DispatchLaneStatus)) return null;
  if (typeof wallClockMs !== "number" || !Number.isFinite(wallClockMs) || wallClockMs < 0) return null;
  if (exitCode !== null && (typeof exitCode !== "number" || !Number.isInteger(exitCode))) return null;
  if (!isTokenCount(estimatedInputTokens) || !isTokenCount(estimatedOutputTokens)) return null;
  return {
    jobId,
    laneId,
    kind: kind as DispatchLaneKind,
    ...(spec === undefined ? {} : { spec }),
    ...(tier === undefined ? {} : { tier }),
    ...(mode === undefined ? {} : { mode: mode as DispatchMode }),
    wallClockMs,
    exitCode,
    status: status as DispatchLaneStatus,
    estimatedInputTokens,
    estimatedOutputTokens,
  };
}

export interface LaneStats {
  /** Lane this window belongs to (the map key is composite, so the entry carries its parts). */
  laneId: string;
  /** Ladder tier this window belongs to, or null for the legacy single ladder. */
  tier: string | null;
  /**
   * Dispatch mode this window belongs to, or null for a legacy window recorded before modes were
   * reported. A legacy window mixes both populations, so it is read only as a fallback.
   */
  mode: DispatchMode | null;
  calls: number;
  successes: number;
  failures: number;
  timeouts: number;
  /**
   * Runs that FAILED on their own (`failed` or `timed_out`) since the last `completed` one. A walk
   * abandonment is not counted: that is the relay's decision, not the lane's failure. A success
   * resets it to 0. The walk reads it (a later lane on a streak cannot be relied on to answer), and
   * so does the failing-lane demotion in `dispatch.ts`.
   */
  consecutiveFailures: number;
  /** When this window last recorded a `completed` run, or null. */
  lastSuccessAt: number | null;
  /**
   * Bounded wall-clock sample window, oldest dropped. Since 2026-09-10 ONLY a `completed` run adds a
   * sample: a failure's or timeout's wall clock is time to FAILURE, not time to answer, so it must
   * never enter a statistic labelled as the lane's time to answer.
   */
  wallClockMs: number[];
  /**
   * Per-sample ISO timestamps, parallel to `wallClockMs` — entry `i` is when sample `i` ran.
   * `null` on a sample recorded before timestamps existed. The parallelism is the invariant:
   * both windows trim together, so position `i` always means the same run in both.
   */
  wallClockAt: (string | null)[];
  lastAt: number | null;
}

/**
 * Rolling wall-clock window per lane; the bound keeps one chatty lane from growing the file.
 *
 * Raised 25 -> 100 on 2026-09-08 when this history began driving dispatch decisions. The old
 * attempt-budget consumer was removed after stopping became idle-only; the same bounded window is
 * still used for time-to-answer reporting and recent-vs-history outlier demotion.
 *
 * ⚠ Raising it is backward compatible in the direction that matters: `isLaneStatsRow` rejects a
 * window LONGER than this bound, so a file written under the old 25 still loads. Lowering it
 * later would drop every existing row instead, which is why this constant only ever grows.
 */
export const MAX_LANE_STAT_SAMPLES = 100;

/**
 * Median of one lane's rolling wall-clock window, in milliseconds. Null when the window is
 * empty — unknown stays null, never 0, so a surface cannot print a measured-looking figure for
 * a lane that never ran here. Pure: `buildDispatch` (`dispatch.ts`) calls this rather than
 * re-implementing the percentile, so the view and the tests share the one definition.
 */
export function medianWallClockMs(samples: readonly number[]): number | null {
  if (samples.length === 0) return null;
  const sorted = [...samples].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  if (sorted.length % 2 === 1) return sorted[mid] ?? null;
  const lo = sorted[mid - 1] ?? null;
  const hi = sorted[mid] ?? null;
  if (lo === null || hi === null) return null;
  return (lo + hi) / 2;
}

/**
 * 95th percentile of one lane's rolling wall-clock window, in milliseconds. Null when the window
 * is empty, the same unknown-stays-null rule as the median beside it.
 *
 * ⚠ It exists because the MEDIAN HIDES THE TAIL, and the tail is what an operator giving up on a
 * lane is actually looking at. Measured on the live store 2026-09-05: median 111.5 s, p95 900 s,
 * max 1500 s — three figures that support three different conclusions, of which the ladder printed
 * only the smallest. `latency-demotion.ts` uses p95 on the HTTP path for exactly this reason, and
 * `docs/backlog.md` names the mismatch as a defect.
 *
 * ⚠ It is REPORTED, never acted on. Nothing here demotes a lane on a wall-clock threshold: the
 * recorded window mixes several sessions' traffic, so no threshold drawn from it means anything
 * yet, and borrowing the HTTP path's numbers would demote every healthy lane at once. The
 * demotion that DOES happen is first-party evidence from the walk (`lane-affinity.ts`).
 *
 * Nearest-rank, so the answer is always an OBSERVED sample rather than an interpolation between
 * two: a percentile that reports a duration nothing ever took is a fabricated measurement.
 */
export function p95WallClockMs(samples: readonly number[]): number | null {
  return quantileWallClockMs(samples, 0.95);
}

/**
 * Nearest-rank quantile over one lane's rolling window, in milliseconds. Null for an empty window
 * — unknown stays null, never 0.
 *
 * ⚠ Nearest-rank, so the answer is always an OBSERVED sample rather than an interpolation between
 * two: a duration nothing ever took, used as a budget, would be a fabricated measurement.
 *
 * ⚠ The quantile is bounded to (0, 1] here, and the OPERATOR's guard is elsewhere: `parseRouting`
 * rejects an `attemptQuantile` outside (0, 1) as a hard load error, so a config typo never reaches
 * this function at all. What is left here is a defence for a direct caller.
 *
 * ⚠⚠ **Do not read the `Math.max(Number.EPSILON, …)` as protection against a quantile of 0 — it
 * changes no answer, and the comment here claimed the opposite until 2026-09-08.** With `q` at
 * EPSILON, `Math.ceil(q * n)` is 1; with `q` at 0 it is 0, which `Math.max(1, rank)` below then
 * lifts to 1. Both paths return `sorted[0]`, the fastest sample — which is precisely the outcome
 * the old comment said the clamp prevented. The clamp survives as a statement of the intended
 * domain; the `Math.max(1, rank)` floor is what actually holds the bottom, and a non-finite
 * quantile falling to 1 is what actually holds the top.
 */
export function quantileWallClockMs(samples: readonly number[], quantile: number): number | null {
  if (samples.length === 0) return null;
  const q = Number.isFinite(quantile) ? Math.min(1, Math.max(Number.EPSILON, quantile)) : 1;
  const sorted = [...samples].sort((a, b) => a - b);
  const rank = Math.ceil(q * sorted.length);
  return sorted[Math.min(sorted.length, Math.max(1, rank)) - 1] ?? null;
}

function freshLaneStats(laneId: string, tier: string | null, mode: DispatchMode | null): LaneStats {
  return {
    laneId,
    tier,
    mode,
    calls: 0,
    successes: 0,
    failures: 0,
    timeouts: 0,
    consecutiveFailures: 0,
    lastSuccessAt: null,
    wallClockMs: [],
    wallClockAt: [],
    lastAt: null,
  };
}

/**
 * In-memory key for one (lane, tier) window. The same spelling as `memoryKey` in
 * `lane-affinity.ts` minus the memory kind (this store holds one window per key, not one row
 * per kind): the tier is part of it because each tier is its OWN ladder with its own rungs, so
 * a lane that answered a `low` task says nothing about the `xhigh` ladder — and since
 * 2026-09-08 this window sets each lane's walk budget, so sharing it across tiers would let one
 * tier's history must not be reported or judged as another tier's history.
 *
 * Since 2026-09-10 the dispatch MODE is part of the key too, for the same reason one level down:
 * an answer-mode call and an agent-mode run are two populations (`DispatchMode`). A legacy window
 * has mode `null`. The key is in memory only — a persisted row carries each part as its own field.
 */
function statsKey(tier: string | null, laneId: string, mode: DispatchMode | null = null): string {
  return `${tier ?? ""}|${mode ?? ""}|${laneId}`;
}

/**
 * The CLOSED list of env names that can route a lane's harness traffic back through this
 * relay. Any other name — however credential-shaped — never counts: an open list would let
 * a future env var silently reclassify a lane's accounting.
 */
export const RELAY_ROUTED_ENV_NAMES = ["ANTHROPIC_BASE_URL", "OPENAI_BASE_URL"] as const;

/**
 * Whether this rung's declared env routes its harness traffic back through the relay
 * listener at `listener` — i.e. the daemon's own HTTP pipeline already meters the run, so
 * a telemetry accounting row would double count it (finding C1).
 *
 * A labelled fact about the lane's own wiring, config-derived, never guessed: true only
 * when a closed-list env name holds a parseable URL whose origin (scheme://host:port,
 * IPv6-bracket-aware, default ports applied) equals the listener's own origin, built with
 * the same IPv6 bracketing rule `proxyUrl` applies. A `null` env value (unset), an absent
 * name, an unparseable URL, or any other name ⇒ false. Pure, so the daemon route and the
 * suite share the one definition.
 */
export function laneRoutesThroughRelay(
  rung: Pick<LadderRung, "env">,
  listener: { host: string; port: number },
): boolean {
  const env = rung.env;
  if (env === undefined) return false;
  let listenerOrigin: string;
  try {
    const host = listener.host.includes(":") ? `[${listener.host}]` : listener.host;
    listenerOrigin = new URL(`http://${host}:${listener.port}`).origin;
  } catch {
    return false;
  }
  for (const name of RELAY_ROUTED_ENV_NAMES) {
    const value = env[name];
    if (typeof value !== "string") continue;
    let origin: string;
    try {
      origin = new URL(value).origin;
    } catch {
      continue;
    }
    if (origin === listenerOrigin) return true;
  }
  return false;
}

/**
 * Per-Config lane stats, beside the exhaustion state's own `WeakMap` in `dispatch.ts`.
 *
 * A `WeakMap` because the state's whole lifetime is the config's: when the config is gone
 * there is no ladder left to describe, and nothing should keep the entry alive.
 */
const laneStats = new WeakMap<Config, Map<string, LaneStats>>();

function laneStatsForWrite(cfg: Config): Map<string, LaneStats> {
  let m = laneStats.get(cfg);
  if (!m) {
    m = new Map<string, LaneStats>();
    laneStats.set(cfg, m);
  }
  return m;
}

function copyStats(stats: LaneStats): LaneStats {
  return { ...stats, wallClockMs: [...stats.wallClockMs], wallClockAt: [...stats.wallClockAt] };
}

/**
 * Record one settled lane run. `completed` counts a success; `failed` a failure; `timed_out`
 * a timeout AND a failure (a timeout did not succeed). Stats never reorder the ladder.
 *
 * The run lands in the (lane, tier) window named by the report's own `tier` (null when the
 * report names none — the legacy single ladder). The `POST /dispatch/telemetry` route passes
 * nothing extra: the report already carries `tier`, so tiering flows through this one argument.
 */
export function recordLaneRun(cfg: Config, report: DispatchedTelemetryReport, now: number = Date.now()): void {
  const map = laneStatsForWrite(cfg);
  const tier = report.tier ?? null;
  const mode = report.mode ?? null;
  const key = statsKey(tier, report.laneId, mode);
  let entry = map.get(key);
  if (!entry) {
    entry = freshLaneStats(report.laneId, tier, mode);
    map.set(key, entry);
  }
  entry.calls += 1;
  switch (report.status) {
    case "completed":
      entry.successes += 1;
      entry.consecutiveFailures = 0;
      entry.lastSuccessAt = now;
      break;
    case "failed":
      entry.failures += 1;
      entry.consecutiveFailures += 1;
      break;
    case "timed_out":
      entry.timeouts += 1;
      entry.failures += 1;
      entry.consecutiveFailures += 1;
      break;
    case "abandoned":
      // A failure, but NOT a timeout: the relay stopped this attempt after observing the lane idle.
      // Nor is it one of the lane's OWN failures (`consecutiveFailures` is untouched).
      entry.failures += 1;
      break;
    default: {
      const _never: never = report.status;
      throw new Error(`unhandled dispatch lane status: ${String(_never)}`);
    }
  }
  // Only a COMPLETED run contributes a duration sample. An abandoned wall clock is the relay's
  // own idle-stop decision, while failed/timed-out wall clocks are times to FAILURE. None of those
  // is evidence for a statistic labelled "time to answer". Counts above still record the outcome.
  // The timestamp window moves with the duration window, sample for sample.
  if (report.status === "completed") {
    entry.wallClockMs.push(report.wallClockMs);
    entry.wallClockAt.push(new Date(now).toISOString());
  }
  if (entry.wallClockMs.length > MAX_LANE_STAT_SAMPLES) {
    const drop = entry.wallClockMs.length - MAX_LANE_STAT_SAMPLES;
    entry.wallClockMs.splice(0, drop);
    entry.wallClockAt.splice(0, drop);
  }
  entry.lastAt = now;
  notifyLaneStats(cfg);
}

/**
 * One (lane, tier, mode) window for this config, or undefined when that lane never ran there. A
 * copy. A null `mode` is the legacy mode-less window.
 */
export function laneStatsFor(
  cfg: Config,
  laneId: string,
  tier: string | null = null,
  mode: DispatchMode | null = null,
): LaneStats | undefined {
  const entry = laneStats.get(cfg)?.get(statsKey(tier, laneId, mode));
  return entry ? copyStats(entry) : undefined;
}

/**
 * Every (lane, tier, mode) window for this config, sorted by lane id, then tier (tier-less first),
 * then mode (mode-less first) so surfaces render stably. Copies.
 */
export function allLaneStats(cfg: Config): Array<{ laneId: string } & LaneStats> {
  const compareRows = (a: LaneStats, b: LaneStats): number => {
    if (a.laneId !== b.laneId) return a.laneId < b.laneId ? -1 : 1;
    // Tier-less (legacy) rows sort first — the same nulls-first shape `statsKey` gives.
    const ta = a.tier ?? "";
    const tb = b.tier ?? "";
    if (ta !== tb) return ta < tb ? -1 : 1;
    const ma = a.mode ?? "";
    const mb = b.mode ?? "";
    if (ma !== mb) return ma < mb ? -1 : 1;
    return 0;
  };
  return [...(laneStats.get(cfg) ?? new Map<string, LaneStats>()).values()]
    .sort(compareRows)
    .map((stats) => ({ ...copyStats(stats) }));
}

/**
 * Change listeners for this config's lane stats, so persistence can mirror them to disk the
 * way `dispatch-exhaustion-persistence.ts` mirrors cooldowns. A listener throw is contained:
 * mirroring is best-effort and must never fail a telemetry report.
 */
const laneStatsListeners = new WeakMap<Config, Set<() => void>>();

export function onLaneStatsChanged(cfg: Config, listener: () => void): void {
  let set = laneStatsListeners.get(cfg);
  if (!set) {
    set = new Set();
    laneStatsListeners.set(cfg, set);
  }
  set.add(listener);
}

function notifyLaneStats(cfg: Config): void {
  for (const listener of laneStatsListeners.get(cfg) ?? []) {
    try {
      listener();
    } catch {
      /* best-effort mirror — never fail the mutation */
    }
  }
}

/**
 * One exported/persisted lane row: the (lane, tier) key plus its counters and sample window.
 *
 * ⚠ `tier` and `wallClockAt` are OPTIONAL on the wire, and that is the whole backward-compat
 * story: a row written before tiering (no `tier` key, bare-number samples) loads here with
 * `tier: null` and all-null timestamps — nothing is rewritten or copied — and a row written
 * here loads on the previous release, whose validator reads the fields it knows (`laneId`,
 * the counters, the numeric `wallClockMs`, `lastAt`) and ignores the two keys it does not.
 * No existing field changed meaning, so the schema version does NOT bump (the
 * `breaker-persistence.ts` rule: bump only when the MEANING of an existing field changes).
 *
 * Since 2026-09-10 `mode`, `consecutiveFailures`, `abandonedSinceSuccess` and `lastSuccessAt` are
 * optional on the wire. `abandonedSinceSuccess` is retained only as a compatibility field for
 * files written by the retired attempt-budget mechanism; new rows omit it and restore ignores it. The
 * sample window NARROWED that day — only a completed run adds a sample — and the version still does
 * not bump: a bump would drop every lane's history, while an older row's mixed samples simply age
 * out of the bounded window as new runs arrive.
 */
export interface LaneStatsRow {
  laneId: string;
  tier?: string | null;
  mode?: DispatchMode | null;
  calls: number;
  successes: number;
  failures: number;
  timeouts: number;
  consecutiveFailures?: number;
  abandonedSinceSuccess?: number;
  lastSuccessAt?: number | null;
  wallClockMs: number[];
  wallClockAt?: (string | null)[];
  lastAt: number | null;
}

/** Still-live rows for persistence and ladder surfaces. */
export function exportLaneStatsRows(cfg: Config): LaneStatsRow[] {
  return allLaneStats(cfg).map((s) => ({
    laneId: s.laneId,
    tier: s.tier,
    mode: s.mode,
    calls: s.calls,
    successes: s.successes,
    failures: s.failures,
    timeouts: s.timeouts,
    consecutiveFailures: s.consecutiveFailures,
    lastSuccessAt: s.lastSuccessAt,
    wallClockMs: [...s.wallClockMs],
    wallClockAt: [...s.wallClockAt],
    lastAt: s.lastAt,
  }));
}

function isLaneTier(value: unknown): value is string | null {
  if (value === undefined || value === null) return true;
  return isBoundedId(value, MAX_TIER_CHARS);
}

function isLaneMode(value: unknown): value is DispatchMode | null {
  if (value === undefined || value === null) return true;
  return DISPATCH_MODES.includes(value as DispatchMode);
}

function isWallClockAt(value: unknown, samples: number): value is (string | null)[] {
  // Absent on a legacy row — every sample then reads as unattributed in time (`null`).
  if (value === undefined) return true;
  if (!Array.isArray(value)) return false;
  // The relay always writes the two windows in step, so a ragged pair is corruption, not
  // history — drop the row alone rather than guessing which timestamp belongs to which run.
  if (value.length !== samples) return false;
  for (const stamp of value) {
    if (stamp === null) continue;
    if (typeof stamp !== "string" || Number.isNaN(Date.parse(stamp))) return false;
  }
  return true;
}

/** Compatibility counters: each absent or a whole count; `lastSuccessAt` is a time or null. */
function hasValidStreakFields(row: Record<string, unknown>): boolean {
  for (const key of ["consecutiveFailures", "abandonedSinceSuccess"] as const) {
    if (row[key] !== undefined && !isTokenCount(row[key])) return false;
  }
  const at = row["lastSuccessAt"];
  return at === undefined || at === null || (typeof at === "number" && Number.isFinite(at) && at >= 0);
}

/** Validate ONE row completely; anything unexpected drops this row and only this row. */
function isLaneStatsRow(value: unknown): value is LaneStatsRow {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  const row = value as Record<string, unknown>;
  if (!isBoundedId(row["laneId"], MAX_LANE_ID_CHARS)) return false;
  // A numeric tier is not a tier that failed to parse — it is a shape this file never wrote,
  // so the row alone goes rather than the file. The same holds for a mode outside the closed list.
  if (!isLaneTier(row["tier"])) return false;
  if (!isLaneMode(row["mode"])) return false;
  for (const key of ["calls", "successes", "failures", "timeouts"] as const) {
    if (!isTokenCount(row[key])) return false;
  }
  if (!hasValidStreakFields(row)) return false;
  if (!hasValidSamples(row)) return false;
  const lastAt = row["lastAt"];
  if (lastAt !== null && (typeof lastAt !== "number" || !Number.isFinite(lastAt) || lastAt < 0)) return false;
  return true;
}

/** The sample window and its timestamps, validated together (`isLaneStatsRow`). */
function hasValidSamples(row: Record<string, unknown>): boolean {
  const wallClockMs = row["wallClockMs"];
  if (!Array.isArray(wallClockMs)) return false;
  // The relay never writes more than MAX_LANE_STAT_SAMPLES, so a longer window is corruption,
  // not history — drop the row alone rather than transiently allocating through a trusted loader.
  if (wallClockMs.length > MAX_LANE_STAT_SAMPLES) return false;
  for (const sample of wallClockMs) {
    if (typeof sample !== "number" || !Number.isFinite(sample) || sample < 0) return false;
  }
  return isWallClockAt(row["wallClockAt"], wallClockMs.length);
}

/**
 * The duration window a persisted row restores with.
 *
 * ⚠ A row written before 2026-09-10 (it carries no `consecutiveFailures`) was fed by failed and
 * timed-out runs as well as completed ones, so its durations are not all times to ANSWER. When it
 * holds MORE samples than it has successes, at least one sample is provably not an answer and
 * nothing says which, so the window restores EMPTY rather than let a timeout read as a time to
 * answer — measured on the live store, `anthropic` read "usually answers in 0s" at 0 of 24
 * answered. A window that could hold only answers is kept: its counts cannot prove it clean, and
 * dropping it would throw away real history. The counts themselves are evidence and are kept whole.
 */
function restoredWindow(row: LaneStatsRow): { wallClockMs: number[]; wallClockAt: (string | null)[] } {
  if (row.consecutiveFailures === undefined && row.wallClockMs.length > row.successes) {
    return { wallClockMs: [], wallClockAt: [] };
  }
  return {
    wallClockMs: row.wallClockMs.slice(-MAX_LANE_STAT_SAMPLES),
    wallClockAt: (row.wallClockAt ?? new Array<string | null>(row.wallClockMs.length).fill(null)).slice(-MAX_LANE_STAT_SAMPLES),
  };
}

/**
 * Restore persisted rows into this config's live map. It NEVER overwrites stats the live
 * process already learned — the `restoreExhaustedRows` contract. Returns the count restored.
 */
export function restoreLaneStatsRows(cfg: Config, rows: readonly LaneStatsRow[]): number {
  const map = laneStatsForWrite(cfg);
  let restored = 0;
  for (const row of rows) {
    const tier = row.tier ?? null;
    const mode = row.mode ?? null;
    const key = statsKey(tier, row.laneId, mode);
    if (map.has(key)) continue;
    map.set(key, {
      laneId: row.laneId,
      tier,
      mode,
      calls: row.calls,
      successes: row.successes,
      failures: row.failures,
      timeouts: row.timeouts,
      // ⚠ An older row carries no streak. It is DERIVED where the counters make it exact — a row
      // with no success at all has failed every run it has (walk abandonments included, which an
      // older row cannot tell apart), so its streak is its failure count — and set to 0 otherwise,
      // the weaker claim: an unknown streak must never mark a lane as unable to answer.
      consecutiveFailures: row.consecutiveFailures ?? (row.successes === 0 ? row.failures : 0),
      lastSuccessAt: row.lastSuccessAt ?? null,
      ...restoredWindow(row),
      lastAt: row.lastAt,
    });
    restored++;
  }
  if (restored > 0) notifyLaneStats(cfg);
  return restored;
}

/** Bumped when the row shape changes; a mismatch restores nothing rather than guessing. */
export const CURRENT_DISPATCH_LANE_STATS_VERSION = 1;

export interface DispatchLaneStatsFile {
  version: number;
  rows: LaneStatsRow[];
}

export function getDispatchLaneStatsPath(): string {
  // ⚠ Under vitest, never touch the operator's real ladder state — a suite that records lane
  // runs would otherwise pollute the live ladder's stats. Guarded AT THE RESOLVER, per CLAUDE.md.
  if (process.env.VITEST) return join(tmpdir(), "llm-relay-vitest", "dispatch-lane-stats.json");
  // Cache-kind: every row is re-learnable from the next host report. Neither operator-authored
  // nor credential-bearing.
  return join(relayStatePath("cache"), "dispatch-lane-stats.json");
}

/**
 * Read the persisted rows. Absent file, unreadable file, wrong version, or an unrecognized
 * envelope all yield an empty list — never a throw, never a partial row from a shape we did
 * not recognize. One malformed row is dropped alone.
 */
export function loadLaneStatsRows(opts: { path?: string } = {}): LaneStatsRow[] {
  const target = opts.path ?? getDispatchLaneStatsPath();
  const parsed = safeReadJsonSync<Record<string, unknown>>(target);
  if (parsed === null || typeof parsed !== "object") return [];
  if (parsed["version"] !== CURRENT_DISPATCH_LANE_STATS_VERSION) return [];
  const rows = parsed["rows"];
  if (!Array.isArray(rows)) return [];
  return rows.filter((row): row is LaneStatsRow => isLaneStatsRow(row));
}

export function saveLaneStatsRows(rows: readonly LaneStatsRow[], opts: { path?: string } = {}): void {
  const target = opts.path ?? getDispatchLaneStatsPath();
  const file: DispatchLaneStatsFile = { version: CURRENT_DISPATCH_LANE_STATS_VERSION, rows: [...rows] };
  atomicWriteJsonSync(target, file, { space: 2 });
}

/**
 * Wire a config's lane stats to the file: restore what was recorded, then flush on every
 * change, debounced through the shared `WriteBehindTimer`. Returns the number restored.
 */
export function installDispatchLaneStatsPersistence(
  cfg: Config,
  opts: { path?: string } = {},
): number {
  const path = opts.path ?? getDispatchLaneStatsPath();
  const restored = restoreLaneStatsRows(cfg, loadLaneStatsRows({ path }));
  const timer = installed.register(new WriteBehindTimer());
  onLaneStatsChanged(cfg, () => {
    timer.touch(() => saveLaneStatsRows(exportLaneStatsRows(cfg), { path }));
  });
  return restored;
}

/** Every timer an install armed, so the shutdown flush needs no handle from the installer. */
const installed = new WriteBehindRegistry();

/**
 * The shutdown seam: write every dirty window NOW. Until 2026-09-08 nothing could — the timer
 * lived in a closure only the change listener held, so a lane run recorded in the last two
 * seconds before a graceful stop never reached the file. Returns how many files were written.
 */
export function flushDispatchLaneStatsPersistence(): number {
  return installed.flushAll();
}
