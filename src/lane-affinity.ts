/**
 * Per-lane ROUTING MEMORY for the dispatch ladder: which lane last answered (a PIN, promote it),
 * and which lane just failed to answer inside its budget (a DEMOTION, order it behind the rest).
 *
 * This is the third per-Config lane store, beside `dispatch.ts`'s host-reported cooldowns and
 * `dispatch-lane-stats.ts`'s advisory counters, and it follows the latter's shape exactly: a
 * per-`Config` `WeakMap`, change listeners, and a mirror to disk through the shared
 * `WriteBehindTimer`. Read that module's header for the reasoning this one inherits.
 *
 * WHY IT EXISTS. Before this, `dispatch` ran one lane and the caller decided by hand what to do
 * when that lane was slow. The owner's instruction (2026-09-06) is that the relay should decide:
 * *"Callers shouldn't have to specifically pick models… the default should just be to call the
 * relay with a reasoning level and have the relay do the rest."* A walk over the ladder needs two
 * memories to be worth anything — otherwise every call re-discovers the same slow first lane, and
 * every call re-forgets the lane that worked.
 *
 * ⚠ **A PIN PROMOTES; IT NEVER RESURRECTS.** A pinned lane that is exhausted, disabled,
 * unreachable or not servable is still not selected. The pin reorders lanes that are ALREADY
 * selectable and nothing more. That is the mirror of the standing rule that health demotes and
 * never drops: a memory of past success must not outrank present evidence of unavailability.
 *
 * ⚠ **A DEMOTION IS EVIDENCE, NOT A STATISTIC.** `docs/backlog.md` asks for a slow-lane threshold
 * calibrated from the recorded wall-clock window, and warns — correctly, and in bold — never to
 * borrow the HTTP path's numbers, because a lane legitimately runs an agent loop for minutes. This
 * module needs no threshold at all: "this lane did not answer inside the budget the walk gave it,
 * one moment ago" is a first-party measurement of this lane, taken by this relay. No population,
 * no calibration, nothing borrowed. The calibrated statistic remains open work; it is not what
 * makes the walk correct.
 *
 * ⚠ **A DEMOTION IS NOT A `LaneState`.** `LaneState`'s `ready` member is what the selection filter
 * in `buildDispatch` tests, so a `slow` member would REMOVE a slow lane rather than demote it —
 * breaking "health demotes, never drops" in the very change that exists to honour it. Demotion is
 * therefore its own field on the lane, exactly as quota demotion is a TERM inside `targetUsability`
 * on the HTTP path rather than a state.
 *
 * ⚠ **The relay never invents a window.** Both memories carry an explicit expiry, supplied by the
 * caller from config. Neither survives it, and a lapsed row is deleted on read rather than
 * lingering as a stale preference.
 */
import { join } from "node:path";
import { tmpdir } from "node:os";
import { relayStatePath } from "./state-paths.js";
import { WriteBehindRegistry, WriteBehindTimer } from "./write-behind.js";
import { atomicWriteJsonSync, safeReadJsonSync } from "./storage/json-store.js";
import { isDashboardSafeId } from "./dashboard-contract.js";
import { medianWallClockMs, quantileWallClockMs } from "./dispatch-lane-stats.js";
import type { Config } from "./config-types.js";

/**
 * Longest window either memory is held for, whatever a caller asks. The ceiling is not cosmetic:
 * a pin is a preference recorded from ONE success, and a demotion from ONE missed budget. Neither
 * observation supports parking the ladder in a shape for a day. `dispatch.ts`'s `MAX_EXHAUSTED_MS`
 * is 30 days because a vendor STATES a quota window; nothing states one here.
 */
export const MAX_AFFINITY_MS = 6 * 60 * 60 * 1000;

/** Pin window when config names none: long enough to cover a burst of related tasks. */
export const DEFAULT_PIN_MS = 15 * 60 * 1000;

/** Demotion window when config names none. Same default as the pin — one missed budget, one turn. */
export const DEFAULT_DEMOTE_MS = 15 * 60 * 1000;

/** Longest reason string retained. Bounded because it is rendered on the ladder view. */
const MAX_REASON_CHARS = 200;

const MAX_LANE_ID_CHARS = 200;
const MAX_TIER_CHARS = 64;

/** One live memory: the lane it names, when it lapses, and the evidence that created it. */
export interface LaneAffinityRow {
  /** Ladder tier this memory belongs to, or null for the legacy single ladder. */
  tier: string | null;
  laneId: string;
  /** `pin` promotes this lane; `demote` orders it behind lanes carrying no demotion. */
  kind: LaneAffinityKind;
  /** Epoch ms at which the memory lapses. */
  until: number;
  /** Why this memory exists, in words a ladder reader can act on. */
  reason: string;
}

/**
 * The two memories, as a closed set derived from ONE `as const` array. A hand-copied second list
 * is the most-repeated defect in this repository's history; deriving the type from the list means
 * a third memory is a compile error at `LANE_AFFINITY_DEFAULT_TTL_MS` below rather than a silent
 * drop at a loader.
 */
export const LANE_AFFINITY_KINDS = Object.freeze(["pin", "demote"] as const);
export type LaneAffinityKind = (typeof LANE_AFFINITY_KINDS)[number];

/**
 * Default window per memory kind — the ONE place that chooses a number per kind, as a total
 * table closed with `satisfies` (the `buildAuthHeaders` precedent in `src/authEnv.ts`). A third
 * memory kind is a compile error HERE, at the table, rather than a silent drop wherever the new
 * kind's default was forgotten. `pinLane`/`demoteLane` read their fallback through
 * `defaultWindowFor` so no second per-kind branch can drift out of step with this one.
 */
export const LANE_AFFINITY_DEFAULT_TTL_MS = {
  pin: DEFAULT_PIN_MS,
  demote: DEFAULT_DEMOTE_MS,
} satisfies Record<LaneAffinityKind, number>;

/** Default window for one memory kind, read off the total table above. */
function defaultWindowFor(kind: LaneAffinityKind): number {
  return LANE_AFFINITY_DEFAULT_TTL_MS[kind];
}

/** tier key → lane id → row. One map per `Config`, alive exactly as long as that config is. */
const affinity = new WeakMap<Config, Map<string, LaneAffinityRow>>();

/**
 * Memory key. The tier is part of it because each tier is its OWN ladder with its own rungs: a
 * lane that answered a `low` task says nothing about the `xhigh` ladder, and pinning across tiers
 * would let one cheap success steer every reasoning level.
 */
function memoryKey(tier: string | null, laneId: string, kind: LaneAffinityKind): string {
  return `${kind}:${tier ?? ""}:${laneId}`;
}

function mapFor(cfg: Config): Map<string, LaneAffinityRow> {
  let m = affinity.get(cfg);
  if (!m) {
    m = new Map<string, LaneAffinityRow>();
    affinity.set(cfg, m);
  }
  return m;
}

/**
 * Clamp a caller-supplied expiry into the window this relay will hold a memory for. A memory is
 * advisory, so a nonsense value is CORRECTED rather than rejected — the `normalizeTtl` reasoning
 * in `dispatch.ts`, where dropping the report would discard a real signal over a bad number.
 * A non-finite duration falls to the default rather than to the ceiling: the fallback must
 * resolve to the WEAKER claim.
 */
function clampWindow(ttlMs: unknown, fallback: number): number {
  const raw = typeof ttlMs === "number" && Number.isFinite(ttlMs) ? ttlMs : fallback;
  return Math.min(MAX_AFFINITY_MS, Math.max(0, raw));
}

function boundedReason(reason: string): string {
  return reason.slice(0, MAX_REASON_CHARS);
}

/**
 * Record one memory. A later write for the same (tier, lane, kind) REPLACES the earlier one:
 * the newest evidence about a lane is the truest, and extending an old window from a fresh
 * observation would let one success accumulate into an unbounded preference.
 */
function remember(
  cfg: Config,
  kind: LaneAffinityKind,
  tier: string | null,
  laneId: string,
  reason: string,
  ttlMs: number,
  now: number,
): void {
  if (typeof laneId !== "string" || laneId.length === 0) return;
  const until = now + ttlMs;
  mapFor(cfg).set(memoryKey(tier, laneId, kind), {
    tier,
    laneId,
    kind,
    until,
    reason: boundedReason(reason),
  });
  notify(cfg);
}

/**
 * Read one memory, deleting it when it has lapsed. Deleting on read is what keeps a lapsed
 * preference from being mirrored back to disk and read again next restart — the same
 * self-clearing shape `cooldownUntil` uses in `dispatch.ts`.
 */
function recall(
  cfg: Config,
  kind: LaneAffinityKind,
  tier: string | null,
  laneId: string,
  now: number,
): LaneAffinityRow | null {
  const map = mapFor(cfg);
  const key = memoryKey(tier, laneId, kind);
  const row = map.get(key);
  if (row === undefined) return null;
  if (row.until <= now) {
    map.delete(key);
    notify(cfg);
    return null;
  }
  return row;
}

/** Pin a lane that answered, so the next dispatch on this tier takes it first. */
export function pinLane(
  cfg: Config,
  tier: string | null,
  laneId: string,
  reason: string,
  ttlMs: number = defaultWindowFor("pin"),
  now: number = Date.now(),
): void {
  remember(cfg, "pin", tier, laneId, reason, clampWindow(ttlMs, defaultWindowFor("pin")), now);
}

/** Demote a lane on fresh negative evidence (including an idle-stop), so ready lanes lead it. */
export function demoteLane(
  cfg: Config,
  tier: string | null,
  laneId: string,
  reason: string,
  ttlMs: number = defaultWindowFor("demote"),
  now: number = Date.now(),
): void {
  remember(cfg, "demote", tier, laneId, reason, clampWindow(ttlMs, defaultWindowFor("demote")), now);
}

/** This lane's live pin on this tier, or null. */
export function lanePin(
  cfg: Config,
  tier: string | null,
  laneId: string,
  now: number = Date.now(),
): LaneAffinityRow | null {
  return recall(cfg, "pin", tier, laneId, now);
}

/** This lane's live demotion on this tier, or null. */
export function laneDemotion(
  cfg: Config,
  tier: string | null,
  laneId: string,
  now: number = Date.now(),
): LaneAffinityRow | null {
  return recall(cfg, "demote", tier, laneId, now);
}

/**
 * Tunables for the recent-versus-earlier outlier demotion (backlog item 9, owner question
 * 2026-09-05: demote a lane whose RECENT distribution is an outlier against its OWN earlier
 * history, on a threshold calibrated from that history).
 *
 * `DEFAULT_OUTLIER_FACTOR` (7.6) is the CALIBRATED default — `scripts/calibrate-lane-outlier.mjs`,
 * run 2026-09-09 21:37Z against this machine's `~/.llm-relay/dispatch-lane-stats.json`: 3 (lane,
 * tier) windows with enough history (agy-gemini 25 samples, free-pool 100, opencode-muse-spark
 * 57), 155 sliding recent-median / history-p80 ratios, pooled p50 0.62, p90 2.03, p95 7.57,
 * max 33.32. The method is the pooled p95 — the point above which a lane is more extreme than
 * 95% of its own-history comparisons — ACCEPTED inside the script's [1.5, 10.0] band and rounded
 * to one decimal.
 *
 * ⚠ **A first draft of this comment reported a run that never happened** (p95 1.44, rejected as
 * too LOW, default 2.5): the script did not exist in the tree when it was written. The real run
 * says the opposite. Per lane, free-pool's HEALTHY ratio reaches 4.18 at p95 (max 33.32) and
 * opencode-muse-spark's 12.54 (max 13.65) — a lane here legitimately runs an agent loop whose
 * wall clock swings several-fold — so a factor of 2.5 would have demoted both on ordinary wobble,
 * the exact harm this rule must not do, and the band's upper edge moved from 5.0 to 10.0 on that
 * evidence. 7.6 still fires on the real 13x and 33x events in the same window.
 *
 * ⚠ Figures are PERISHABLE — they describe one machine's traffic on one date. Re-run the script
 * as lane history accumulates and move this constant with it; never quote these as measurements
 * of anything but that window. The parser mirrors the three defaults in
 * `DEFAULT_DISPATCH_WALK_OUTLIER` (`config/routing-parser.ts`), pinned equal by a test.
 */
export const DEFAULT_OUTLIER_RECENT_COUNT = 5;
export const DEFAULT_OUTLIER_HISTORY_QUANTILE = 0.8;
export const DEFAULT_OUTLIER_FACTOR = 7.6;

/** Resolved outlier settings: the operator's overrides with the defaults above filled in. */
export interface LaneOutlierSettings {
  recentCount: number;
  historyQuantile: number;
  outlierFactor: number;
  minSamples: number;
}

/** What the rule found, carrying the evidence that produced it so the reason can state it. */
export interface LaneOutlierEvidence {
  recentMedianMs: number;
  historyMs: number;
}

/**
 * Recent-versus-earlier outlier test on ONE lane's OWN (lane, tier) window, oldest first.
 *
 * The window splits into the most recent `recentCount` samples and the rest; the lane is an
 * outlier when the recent MEDIAN exceeds the earlier window's `historyQuantile` by more than
 * `outlierFactor`. Both halves need at least `minSamples` samples or the rule is silent —
 * unmeasured is no opinion, never "slow" (the `latency-demotion.ts` rule). Nearest-rank
 * quantiles only, reused from `dispatch-lane-stats.ts`, never re-implemented: a percentile
 * reporting a duration nothing ever took would be a fabricated measurement.
 *
 * ⚠ The statistic is meaningful only because each sample is attributable in TIME
 * (`wallClockAt` in `dispatch-lane-stats.ts`): "recent" is the tail of the window, not a
 * subsample. And no HTTP-path number is borrowed here — a lane legitimately runs an agent
 * loop for minutes, so pointing 250 ms/token or a 30 s ceiling at it would demote every
 * healthy lane at once.
 */
export function checkLaneOutlier(
  samples: readonly number[],
  settings: LaneOutlierSettings,
): LaneOutlierEvidence | null {
  const { recentCount, historyQuantile, outlierFactor, minSamples } = settings;
  if (!Number.isInteger(recentCount) || recentCount < 1) return null;
  if (samples.length < recentCount + minSamples) return null;
  const recent = samples.slice(-recentCount);
  const earlier = samples.slice(0, samples.length - recentCount);
  // Both halves need a distribution, not a anecdote: the recent half is exactly `recentCount`
  // long, so it clears the floor only when the operator sized it at or above `minSamples`.
  if (recent.length < minSamples || earlier.length < minSamples) return null;
  const recentMedian = medianWallClockMs(recent);
  const history = quantileWallClockMs(earlier, historyQuantile);
  if (recentMedian === null || history === null || history <= 0) return null;
  if (recentMedian <= history * outlierFactor) return null;
  return { recentMedianMs: recentMedian, historyMs: history };
}

/**
 * The demotion reason for an outlier hit. It names BOTH figures and the factor — a reason
 * string is a claim about the ordering code, printed on the ladder view, so an operator
 * reading it can see the measurement rather than taking the demotion on faith.
 */
export function outlierDemotionReason(
  evidence: LaneOutlierEvidence,
  opts: { historyQuantile: number; outlierFactor: number },
): string {
  const seconds = (ms: number): number => Math.round(ms / 1000);
  const point = Math.round(opts.historyQuantile * 100);
  return `recent median ${seconds(evidence.recentMedianMs)} s vs history p${point} ${seconds(evidence.historyMs)} s ×${opts.outlierFactor}`;
}

/**
 * Evaluate the outlier rule for one (lane, tier) window and, on a hit, demote through the
 * SHARED entry: retract first (`clearLaneAffinity`), then `demoteLane` — the same
 * retract-then-record sequence `recordLaneAffinity` uses for a walk demotion, so an outlier
 * demotion retracts an existing pin rather than sitting beside it. It never touches the pin
 * directly; the shared entry already handles that.
 *
 * Returns the reason recorded, or null when the rule is inert (`false`), silent (too little
 * history), or the window is steady. Pure evaluation, one write on a hit.
 */
export function recordLaneOutlier(
  cfg: Config,
  tier: string | null,
  laneId: string,
  samples: readonly number[],
  outlier: false | Omit<LaneOutlierSettings, "minSamples">,
  opts: { minSamples: number; demoteMs: number },
  now: number = Date.now(),
): string | null {
  if (outlier === false) return null;
  const hit = checkLaneOutlier(samples, { ...outlier, minSamples: opts.minSamples });
  if (!hit) return null;
  const reason = outlierDemotionReason(hit, {
    historyQuantile: outlier.historyQuantile,
    outlierFactor: outlier.outlierFactor,
  });
  clearLaneAffinity(cfg, tier, laneId);
  demoteLane(cfg, tier, laneId, reason, opts.demoteMs, now);
  return reason;
}

/**
 * Retract every memory for one lane on one tier. Called when a lane SUCCEEDS: the success
 * disproves the demotion that a previous missed budget recorded, exactly as a served 200 clears
 * a cooling condition in `target-facts.ts`. It does not touch other lanes or other tiers, because
 * one lane's success says nothing about theirs.
 */
export function clearLaneAffinity(cfg: Config, tier: string | null, laneId: string): void {
  const map = mapFor(cfg);
  let changed = false;
  for (const kind of LANE_AFFINITY_KINDS) {
    if (map.delete(memoryKey(tier, laneId, kind))) changed = true;
  }
  if (changed) notify(cfg);
}

/**
 * Retract ONE memory kind for one lane on one tier — the operator's `unpin` (`POST /dispatch
 * {"unpin": …}`). Narrower than `clearLaneAffinity` on purpose: an operator withdrawing a pin
 * they placed has said nothing about a demotion the walk recorded from its own measurement, so
 * that evidence stands. Returns whether a live memory of that kind existed; a lapsed row counts
 * as absent, because `recall` would have deleted it on the next read anyway.
 */
export function forgetLaneMemory(
  cfg: Config,
  kind: LaneAffinityKind,
  tier: string | null,
  laneId: string,
  now: number = Date.now(),
): boolean {
  const map = mapFor(cfg);
  const key = memoryKey(tier, laneId, kind);
  const row = map.get(key);
  if (row === undefined) return false;
  map.delete(key);
  notify(cfg);
  return row.until > now;
}

/** Every live memory for this config, lapsed rows dropped. Copies, sorted for stable rendering. */
export function exportLaneAffinityRows(cfg: Config, now: number = Date.now()): LaneAffinityRow[] {
  const map = mapFor(cfg);
  const live: LaneAffinityRow[] = [];
  let dropped = false;
  for (const [key, row] of [...map.entries()]) {
    if (row.until <= now) {
      map.delete(key);
      dropped = true;
      continue;
    }
    live.push({ ...row });
  }
  if (dropped) notify(cfg);
  return live.sort((a, b) => {
    const ka = memoryKey(a.tier, a.laneId, a.kind);
    const kb = memoryKey(b.tier, b.laneId, b.kind);
    return ka < kb ? -1 : ka > kb ? 1 : 0;
  });
}

/**
 * Restore persisted rows. FUTURE-ONLY, and it never overwrites a memory the live process already
 * learned — both are the `restoreExhaustedRows` contract. A lapsed row is not restored at all: a
 * preference recorded before a restart, whose window has since passed, is history rather than
 * routing state. Returns the count restored.
 */
export function restoreLaneAffinityRows(
  cfg: Config,
  rows: readonly LaneAffinityRow[],
  now: number = Date.now(),
): number {
  const map = mapFor(cfg);
  let restored = 0;
  for (const row of rows) {
    if (row.until <= now) continue;
    const key = memoryKey(row.tier, row.laneId, row.kind);
    if (map.has(key)) continue;
    // ⚠ The CEILING is enforced on this path too, not only on the write path (2026-09-08). Until
    // then `clampWindow` bounded what this process recorded while the restore admitted whatever the
    // file said, so a hand-edited or corrupt `lane-affinity.json` could park a lane pinned or
    // demoted for years — past the six-hour ceiling this module states as its own rule, and with no
    // way to notice, because a memory is silent by design. A row is not rejected for it: the clamp
    // CORRECTS, the same direction `clampWindow` takes for a nonsense duration on the write side.
    map.set(key, { ...row, until: Math.min(row.until, now + MAX_AFFINITY_MS) });
    restored++;
  }
  if (restored > 0) notify(cfg);
  return restored;
}

/**
 * Change listeners, so persistence can mirror the memories to disk. A listener throw is
 * contained: mirroring is best-effort and must never fail the walk that recorded the memory.
 */
const listeners = new WeakMap<Config, Set<() => void>>();

export function onLaneAffinityChanged(cfg: Config, listener: () => void): void {
  let set = listeners.get(cfg);
  if (!set) {
    set = new Set();
    listeners.set(cfg, set);
  }
  set.add(listener);
}

function notify(cfg: Config): void {
  for (const listener of listeners.get(cfg) ?? []) {
    try {
      listener();
    } catch {
      /* best-effort mirror — never fail the mutation */
    }
  }
}

/** Bumped when the row shape changes; a mismatch restores nothing rather than guessing. */
export const CURRENT_LANE_AFFINITY_VERSION = 1;

export interface LaneAffinityFile {
  version: number;
  rows: LaneAffinityRow[];
}

export function getLaneAffinityPath(): string {
  // ⚠ Under vitest, never touch the operator's real ladder state. Guarded AT THE RESOLVER,
  // per CLAUDE.md — a call-site guard is how the control-token one came to be half-covered.
  if (process.env.VITEST) return join(tmpdir(), "llm-relay-vitest", "lane-affinity.json");
  // Cache-kind: every memory is re-learnable from the next walk. Neither operator-authored nor
  // credential-bearing.
  return join(relayStatePath("cache"), "lane-affinity.json");
}

/** Validate ONE row completely; anything unexpected drops this row and only this row. */
function isLaneAffinityRow(value: unknown): value is LaneAffinityRow {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  const row = value as Record<string, unknown>;
  const tier = row["tier"];
  if (tier !== null && !(typeof tier === "string" && tier.length >= 1 && tier.length <= MAX_TIER_CHARS && isDashboardSafeId(tier))) {
    return false;
  }
  const laneId = row["laneId"];
  if (typeof laneId !== "string" || laneId.length < 1 || laneId.length > MAX_LANE_ID_CHARS || !isDashboardSafeId(laneId)) {
    return false;
  }
  if (!(LANE_AFFINITY_KINDS as readonly string[]).includes(row["kind"] as string)) return false;
  const until = row["until"];
  if (typeof until !== "number" || !Number.isFinite(until) || until < 0) return false;
  const reason = row["reason"];
  if (typeof reason !== "string" || reason.length > MAX_REASON_CHARS) return false;
  return true;
}

/**
 * Read the persisted rows. Absent file, unreadable file, wrong version, or an unrecognized
 * envelope all yield an empty list — never a throw, never a partial row from a shape we did not
 * recognize. One malformed row is dropped alone: the `lane-manifest.ts` shallow-validation
 * regression, where a corrupt file EVICTED a healthy lane, is the standing warning.
 */
export function loadLaneAffinityRows(opts: { path?: string } = {}): LaneAffinityRow[] {
  const target = opts.path ?? getLaneAffinityPath();
  const parsed = safeReadJsonSync<Record<string, unknown>>(target);
  if (parsed === null || typeof parsed !== "object") return [];
  if (parsed["version"] !== CURRENT_LANE_AFFINITY_VERSION) return [];
  const rows = parsed["rows"];
  if (!Array.isArray(rows)) return [];
  return rows.filter((row): row is LaneAffinityRow => isLaneAffinityRow(row));
}

export function saveLaneAffinityRows(rows: readonly LaneAffinityRow[], opts: { path?: string } = {}): void {
  const target = opts.path ?? getLaneAffinityPath();
  const file: LaneAffinityFile = { version: CURRENT_LANE_AFFINITY_VERSION, rows: [...rows] };
  atomicWriteJsonSync(target, file, { space: 2 });
}

/**
 * Wire a config's lane memories to the file: restore what is still live, then flush on every
 * change, debounced through the shared `WriteBehindTimer`. Returns the number restored.
 */
export function installLaneAffinityPersistence(cfg: Config, opts: { path?: string } = {}): number {
  const path = opts.path ?? getLaneAffinityPath();
  const restored = restoreLaneAffinityRows(cfg, loadLaneAffinityRows({ path }));
  const timer = installed.register(new WriteBehindTimer());
  onLaneAffinityChanged(cfg, () => {
    timer.touch(() => saveLaneAffinityRows(exportLaneAffinityRows(cfg), { path }));
  });
  return restored;
}

/** Every timer an install armed, so the shutdown flush needs no handle from the installer. */
const installed = new WriteBehindRegistry();

/**
 * The shutdown seam: write every dirty memory NOW. Until 2026-09-08 nothing could — `runProxy`
 * flushed six sibling stores at shutdown and this one held its timer in a closure nobody could
 * reach, so a pin or demotion learned in the last two seconds died with the process.
 * Returns how many files were written.
 */
export function flushLaneAffinityPersistence(): number {
  return installed.flushAll();
}

/** Test seam: forget every memory for this config. Never called from `src/`. */
export function resetLaneAffinity(cfg: Config): void {
  affinity.delete(cfg);
}
