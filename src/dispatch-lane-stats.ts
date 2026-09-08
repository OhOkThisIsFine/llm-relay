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
import { WriteBehindTimer } from "./write-behind.js";
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
  const { jobId, laneId, kind, spec, tier, wallClockMs, exitCode, status, estimatedInputTokens, estimatedOutputTokens } = body;
  if (!isBoundedId(jobId, MAX_JOB_ID_CHARS)) return null;
  if (!isBoundedId(laneId, MAX_LANE_ID_CHARS)) return null;
  if (spec !== undefined && !isBoundedId(spec, MAX_SPEC_CHARS)) return null;
  if (tier !== undefined && !isBoundedId(tier, MAX_TIER_CHARS)) return null;
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
    wallClockMs,
    exitCode,
    status: status as DispatchLaneStatus,
    estimatedInputTokens,
    estimatedOutputTokens,
  };
}

export interface LaneStats {
  calls: number;
  successes: number;
  failures: number;
  timeouts: number;
  /** Bounded wall-clock sample window, oldest dropped — advisory percentiles, not scoring. */
  wallClockMs: number[];
  lastAt: number | null;
}

/**
 * Rolling wall-clock window per lane; the bound keeps one chatty lane from growing the file.
 *
 * Raised 25 -> 100 on 2026-09-08 (owner direction) when the walk began deriving each lane's
 * ATTEMPT BUDGET from this window. At 25 samples a p80 rests on the 20th value, so one unusual
 * run moves the budget a long way; at 100 it rests on the 80th. The cost is four numbers a run
 * instead of one — a few kilobytes across the whole ladder.
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
 * ⚠ The quantile is CLAMPED to (0, 1]. A caller asking for 0 would otherwise take rank 0, and the
 * floor below turns that into the fastest sample ever seen — a budget nothing could meet. Clamping
 * to the nearest usable value is the fail-safe direction here, because a config typo must not make
 * every lane look instantly slow.
 */
export function quantileWallClockMs(samples: readonly number[], quantile: number): number | null {
  if (samples.length === 0) return null;
  const q = Number.isFinite(quantile) ? Math.min(1, Math.max(Number.EPSILON, quantile)) : 1;
  const sorted = [...samples].sort((a, b) => a - b);
  const rank = Math.ceil(q * sorted.length);
  return sorted[Math.min(sorted.length, Math.max(1, rank)) - 1] ?? null;
}

function freshLaneStats(): LaneStats {
  return { calls: 0, successes: 0, failures: 0, timeouts: 0, wallClockMs: [], lastAt: null };
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
  return { ...stats, wallClockMs: [...stats.wallClockMs] };
}

/**
 * Record one settled lane run. `completed` counts a success; `failed` a failure; `timed_out`
 * a timeout AND a failure (a timeout did not succeed). Stats never reorder the ladder.
 */
export function recordLaneRun(cfg: Config, report: DispatchedTelemetryReport, now: number = Date.now()): void {
  const map = laneStatsForWrite(cfg);
  let entry = map.get(report.laneId);
  if (!entry) {
    entry = freshLaneStats();
    map.set(report.laneId, entry);
  }
  entry.calls += 1;
  switch (report.status) {
    case "completed":
      entry.successes += 1;
      break;
    case "failed":
      entry.failures += 1;
      break;
    case "timed_out":
      entry.timeouts += 1;
      entry.failures += 1;
      break;
    case "abandoned":
      // ⚠ A failure, but NOT a timeout. The lane did not answer inside the walk's budget, which
      // is a failure of this attempt; it never reached its own configured ceiling, so counting it
      // in `timeouts` would inflate a figure that means something narrower.
      entry.failures += 1;
      break;
    default: {
      const _never: never = report.status;
      throw new Error(`unhandled dispatch lane status: ${String(_never)}`);
    }
  }
  entry.wallClockMs.push(report.wallClockMs);
  if (entry.wallClockMs.length > MAX_LANE_STAT_SAMPLES) {
    entry.wallClockMs.splice(0, entry.wallClockMs.length - MAX_LANE_STAT_SAMPLES);
  }
  entry.lastAt = now;
  notifyLaneStats(cfg);
}

/** One lane's stats for this config, or undefined when the lane never ran here. A copy. */
export function laneStatsFor(cfg: Config, laneId: string): LaneStats | undefined {
  const entry = laneStats.get(cfg)?.get(laneId);
  return entry ? copyStats(entry) : undefined;
}

/** Every lane with stats for this config, sorted by lane id so surfaces render stably. Copies. */
export function allLaneStats(cfg: Config): Array<{ laneId: string } & LaneStats> {
  return [...(laneStats.get(cfg) ?? new Map<string, LaneStats>()).entries()]
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([laneId, stats]) => ({ laneId, ...copyStats(stats) }));
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

/** One exported/persisted lane row: the lane id plus its counters and sample window. */
export interface LaneStatsRow {
  laneId: string;
  calls: number;
  successes: number;
  failures: number;
  timeouts: number;
  wallClockMs: number[];
  lastAt: number | null;
}

/** Still-live rows for persistence and ladder surfaces. */
export function exportLaneStatsRows(cfg: Config): LaneStatsRow[] {
  return allLaneStats(cfg).map(({ laneId, calls, successes, failures, timeouts, wallClockMs, lastAt }) => ({
    laneId,
    calls,
    successes,
    failures,
    timeouts,
    wallClockMs: [...wallClockMs],
    lastAt,
  }));
}

/** Validate ONE row completely; anything unexpected drops this row and only this row. */
function isLaneStatsRow(value: unknown): value is LaneStatsRow {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  const row = value as Record<string, unknown>;
  if (!isBoundedId(row["laneId"], MAX_LANE_ID_CHARS)) return false;
  for (const key of ["calls", "successes", "failures", "timeouts"] as const) {
    if (!isTokenCount(row[key])) return false;
  }
  const wallClockMs = row["wallClockMs"];
  if (!Array.isArray(wallClockMs)) return false;
  // The relay never writes more than MAX_LANE_STAT_SAMPLES, so a longer window is corruption,
  // not history — drop the row alone rather than transiently allocating through a trusted loader.
  if (wallClockMs.length > MAX_LANE_STAT_SAMPLES) return false;
  for (const sample of wallClockMs) {
    if (typeof sample !== "number" || !Number.isFinite(sample) || sample < 0) return false;
  }
  const lastAt = row["lastAt"];
  if (lastAt !== null && (typeof lastAt !== "number" || !Number.isFinite(lastAt) || lastAt < 0)) return false;
  return true;
}

/**
 * Restore persisted rows into this config's live map. It NEVER overwrites stats the live
 * process already learned — the `restoreExhaustedRows` contract. Returns the count restored.
 */
export function restoreLaneStatsRows(cfg: Config, rows: readonly LaneStatsRow[]): number {
  const map = laneStatsForWrite(cfg);
  let restored = 0;
  for (const row of rows) {
    if (map.has(row.laneId)) continue;
    map.set(row.laneId, {
      calls: row.calls,
      successes: row.successes,
      failures: row.failures,
      timeouts: row.timeouts,
      wallClockMs: row.wallClockMs.slice(-MAX_LANE_STAT_SAMPLES),
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
  const timer = new WriteBehindTimer();
  onLaneStatsChanged(cfg, () => {
    timer.touch(() => saveLaneStatsRows(exportLaneStatsRows(cfg), { path }));
  });
  return restored;
}
