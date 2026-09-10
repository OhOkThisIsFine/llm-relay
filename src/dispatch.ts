import { existsSync } from "node:fs";
import { expandPoolSpecs, offloadRule, splitSpec, POOL_PREFIX } from "./config.js";
import type { Config, LadderRung } from "./config-types.js";
import type { HostRoutingState } from "./host-routing.js";
import type { ContextWindowSource, ResolvedContextWindow } from "./metadata.js";
import { unsupportedArgValues, verifyModel, type LaneManifest } from "./lane-manifest.js";
import { allLaneStats, laneStatsFor, medianWallClockMs, p95WallClockMs, quantileWallClockMs } from "./dispatch-lane-stats.js";
import { laneDemotion, lanePin, type LaneAffinityRow } from "./lane-affinity.js";
import { relayStatePath } from "./state-paths.js";

/**
 * The dispatch ladder: which LANE a host agent should hand a delegated task to, in what order,
 * and what to do when one is spent.
 *
 * Why this lives here and not in the routing path: `routing.subagents` decides which provider
 * serves ONE HTTP turn, and the proxy applies it itself. A ladder rung is a different unit of
 * work — a whole delegated task — and some rungs are agent CLIs that never traverse this proxy
 * at all (their quota is client-bound; only the vendor's own binary can spend it). So the relay
 * owns the ORDER and the live state, and the host executes what it is told. That keeps the proxy
 * a proxy: it never spawns a process, and it never pretends a CLI answered an HTTP turn.
 *
 * Exhaustion is host-reported for every rung kind, deliberately. The relay cannot see an AGY
 * credit balance or a ChatGPT rate limit, and inventing an availability signal it does not have
 * would be worse than admitting it: a rung is ready until someone who actually tried it says
 * otherwise.
 */

/** Default cooldown for a rung reported spent. Quotas reset on their own schedules; this is
 *  a "try again soon", not a claim about the vendor's reset window. */
export const DEFAULT_EXHAUSTED_MS = 15 * 60 * 1000;

/**
 * Ceiling on a host-reported cooldown (30 days). Not a policy about vendors — a bound that keeps
 * `readyAt` a representable date. `Math.max(0, ttlMs)` alone let a caller-supplied `Infinity`
 * (a legal JSON number: `1e999` parses to it, and `typeof Infinity === "number"` passes every
 * numeric type guard upstream) reach `new Date(Infinity).toISOString()`, which throws
 * `RangeError: Invalid time value`. That poisoned the cooldown map permanently: every later
 * `buildDispatch` threw while rendering the same lane, so one bad exhaustion report took the whole
 * ladder down until the process restarted. A cooldown is advisory, so clamping is the right
 * response — refusing the report would lose a real "this lane is spent" signal.
 */
export const MAX_EXHAUSTED_MS = 30 * 24 * 60 * 60 * 1000;

/**
 * Host-reported WHY behind an exhaustion report. Two kinds because they call for different
 * waits: a rate limit resets on a clock measured in minutes, a spent quota on one measured in
 * hours (or the vendor's reset boundary). The relay still never invents the signal — the host
 * says which happened, and an explicit `ttlMs`/`retryAfterMs` always beats the outcome default.
 */
export type DispatchOutcome = "rate_limited" | "quota_exhausted";
export const OUTCOME_DEFAULT_MS: Record<DispatchOutcome, number> = {
  rate_limited: DEFAULT_EXHAUSTED_MS,
  quota_exhausted: 60 * 60 * 1000,
};

/** Longest caller-supplied id echoed back in a `reason`. See `describeId`. */
const MAX_ECHOED_ID = 120;

export type LaneState = "ready" | "exhausted" | "disabled" | "not-servable";

/**
 * Advisory per-lane execution stats for one ladder rung: how often this config took the lane
 * and how long it took. The median is over the rolling wall-clock window held by
 * `dispatch-lane-stats.ts` (null when the window is empty — unknown, never 0) and `lastAt`
 * is epoch ms of the last recorded run (null when the lane never ran here). Present only
 * when the rung HAS a stats entry; omitted otherwise. Advisory columns only: stats never
 * change a lane's `state`, never change `next`, and never reorder the ladder.
 */
export interface DispatchLaneStats {
  calls: number;
  successes: number;
  failures: number;
  timeouts: number;
  medianWallClockMs: number | null;
  /**
   * 95th percentile of the same window. Reported BESIDE the median rather than instead of it,
   * because the two answer different questions and the median alone hid the answer an operator
   * giving up on a lane was actually looking for (median 111.5 s against p95 900 s on the live
   * store, 2026-09-05). Null when the window is empty — unknown stays null, never 0.
   */
  p95WallClockMs: number | null;
  lastAt: number | null;
}

/**
 * One-line advisory rendering of a lane's stats, shared by `dispatch_lanes` and
 * `llm-relay dispatch` so the wording cannot drift between the two surfaces:
 * `stats: 4 calls, 3 ok, 1 failed, 0 timed out, median 24s, p95 91s` (`n/a` when unknown).
 * Seconds are rounded to one decimal.
 */
export function formatLaneStats(stats: DispatchLaneStats): string {
  const seconds = (ms: number | null): string => (ms === null ? "n/a" : `${Math.round(ms / 100) / 10}s`);
  return (
    `stats: ${stats.calls} calls, ${stats.successes} ok, ${stats.failures} failed, ` +
    `${stats.timeouts} timed out, median ${seconds(stats.medianWallClockMs)}, p95 ${seconds(stats.p95WallClockMs)}`
  );
}

/**
 * One-line rendering of a lane's walk budget, shared by `dispatch_lanes` and `llm-relay dispatch`
 * so the wording cannot drift between the two surfaces — the `formatLaneStats` precedent.
 *
 * It names the BASIS as well as the number, because the three mean different things: one is derived
 * from this lane's own history and moves as the lane does, one is the operator's flat default
 * standing in until there is history to read, and one is that same flat default winning over a
 * history that IS present and faster than it.
 *
 * ⚠ The `clamped` wording states BOTH facts — the floor applied, AND what the lane's own quantile
 * actually was — because the second is the number the operator came to the ladder to see, and the
 * two-member version of this function hid it behind the word "recorded". See the `basis` doc on
 * `DispatchLane.attemptBudget` for what that cost.
 */
export function formatAttemptBudget(budget: {
  ms: number;
  basis: "history" | "floor" | "clamped";
  samples: number;
  quantileMs?: number;
}): string {
  const render = (ms: number): string => `${Math.round(ms / 100) / 10}s`;
  const seconds = render(budget.ms);
  switch (budget.basis) {
    case "history":
      return `budget: ${seconds} (from ${budget.samples} recorded runs)`;
    case "clamped":
      return budget.quantileMs === undefined
        ? `budget: ${seconds} (flat floor — this lane's ${budget.samples} runs are faster)`
        : `budget: ${seconds} (flat floor — this lane's ${budget.samples} runs put it at ${render(budget.quantileMs)})`;
    case "floor":
      return `budget: ${seconds} (flat — too few recorded runs, ${budget.samples})`;
    default: {
      const _never: never = budget.basis;
      return _never;
    }
  }
}

export interface DispatchLane {
  id: string;
  kind: "cli" | "relay";
  /** 1-based position in the configured ladder — stable regardless of availability. */
  position: number;
  state: LaneState;
  /** Shared quota bucket, when the rung declares one. Rungs sharing a bucket go down together. */
  quota?: string;
  note?: string;
  /**
   * cli rungs: the configured per-MCP-server-process concurrency cap, or `null` when unbounded.
   * Set on every `cli` lane (never on a `relay` lane, which has no such config field) so a reader
   * of the ladder can always see whether one is in force, even before any job has run against it —
   * the live IN-FLIGHT count is a different question this module cannot answer (only the MCP server
   * process that would spawn a job knows what it is currently running), so `mcp/server.ts` renders
   * that count itself alongside this figure rather than this module inventing one.
   */
  maxConcurrent?: number | null;
  /** When an exhausted rung becomes eligible again (ISO 8601). */
  readyAt?: string;
  /**
   * The lane's own tool states it does not serve this rung's model. An EXISTENCE fact, so the rung
   * is removed from selection and its `invoke` is withheld — a command that cannot work must not be
   * renderable. It stays LISTED with this reason: silently vanishing is its own debugging problem.
   */
  notServable?: string;
  /** Arguments removed because the lane states (or was observed to state) it rejects them. */
  droppedArgs?: string[];
  /**
   * cli rungs: exactly what to run. `args` already has the task substituted when one was given.
   * `env` is applied by the HOST when spawning: a string value sets the variable, `null` unsets
   * an inherited one (see `LadderRung.env` for why both directions matter). The task placeholder
   * is never substituted into env values — they are operator-authored routing, not task content.
   */
  invoke?: { command: string; args: string[]; env?: Record<string, string | null> };
  /** relay rungs: the spec to address (`pool/<name>`, `<provider>/<model>`, …). */
  spec?: string;
  /**
   * relay rungs only: with this client's subagent offload OFF, a bare subagent will NOT route to
   * this spec — the host must put `@relay: <spec>` in the prompt or turn the client rule on.
   * Surfaced so a host never silently spends primary quota believing it offloaded.
   *
   * ⚠ Never set for a bypassed host. There, the directive is not merely insufficient — it is
   * inert, and reaches the model as literal prompt text. A hint that cannot work is worse than
   * no hint, because the host acts on it and believes it offloaded.
   */
  requiresDirective?: boolean;
  /**
   * This rung was a `relay` rung rendered as a CLI invoke, because the calling host's traffic
   * does not reach this relay. `spec` is retained alongside `invoke` so the reader can still see
   * what is being addressed — the transposition is a change of MECHANISM, not of target.
   */
  transposed?: boolean;
  /**
   * Context window in tokens that the serving provider PUBLISHES for this lane's spec, when it
   * published one and (for a pool) every member did. Absent means nobody stated it — never that
   * it is small. Surfaced so a reader can see whether the rendered command carries a window or
   * left the child on its own default.
   */
  contextWindow?: number;
  /**
   * Where `contextWindow` came from: `provider` (the serving deployment published it) or
   * `snapshot` (a published figure for the same model id from the synced capability data). Travels
   * with the number for the same reason `strengthBasis` travels with `strength` — a reader must be
   * able to tell a first-party measurement from a same-model figure taken elsewhere.
   *
   * For a pool this describes the MEMBER that set the minimum, which is the binding constraint.
   */
  contextWindowSource?: ContextWindowSource;
  /**
   * How many members of a POOL had no resolvable window. The reported number is the minimum over
   * the members that DID resolve, so this says how much of the pool that minimum actually covers.
   * Absent or 0 means every member resolved.
   */
  contextWindowUnknownMembers?: number;
  /**
   * Why this rung cannot be used by the calling host as configured. Set when a `relay` rung needs
   * transposing and no `routing.cliLane` template exists to transpose it with. Such a rung is
   * never auto-selected as `next` — offering a lane known not to work is the defect being fixed.
   */
  unreachable?: string;
  /**
   * Advisory execution stats for this rung (`DispatchLaneStats`), filled from
   * `dispatch-lane-stats.ts` for every rung that ran under this config and OMITTED otherwise.
   * Never changes `state`, `next`, or the ladder order — a column, not an input.
   */
  stats?: DispatchLaneStats;
  /**
   * This lane answered recently, so it is preferred over its ladder position for a window
   * (`lane-affinity.ts`). Present only while the pin is live.
   *
   * ⚠ **A pin PROMOTES; it never RESURRECTS.** It reorders lanes that are already selectable and
   * nothing more — a pinned lane that is exhausted, disabled, unreachable or not servable is still
   * not selected, and this field never appears on one. That is the mirror of "health demotes,
   * never drops": a memory of past success must not outrank present evidence of unavailability.
   */
  pinned?: { until: string; reason: string };
  /**
   * How long a dispatch WALK gives this lane to answer before it stops it and starts the next —
   * derived from THIS lane's own recorded wall-clock history when it has enough of one.
   *
   * ⚠ It is computed HERE, in the daemon, because this is where the history lives: the walk runs in
   * the `llm-relay mcp` child, which holds no stats. Carrying the resolved number on the lane keeps
   * one definition of the budget and lets an operator read it off the ladder, rather than the child
   * re-deriving a figure from data it does not have.
   *
   * ⚠ `basis` names WHERE THE NUMBER CAME FROM, and there are THREE real cases, not two:
   * `history` — the lane cleared `attemptMinSamples` and the number IS its own quantile;
   * `floor` — it did not clear the floor, so the flat `attemptMs` applies, because unmeasured is
   * "no opinion", never "slow";
   * `clamped` — it DID clear the floor, its quantile was read, and that quantile came out BELOW
   * `attemptMs`, so the operator's flat figure won the `Math.max`. There is history, and the
   * number is not from it.
   * Absent entirely when the walk is off or unconfigured.
   *
   * ⚠⚠ `clamped` exists because it was `history` until 2026-09-08, which reported the operator's
   * own configured default as a measurement of this lane's runs — the provenance invariant's
   * exact prohibition, reached by the closed-union collapse this repository records more than any
   * other defect: three real cases mapped onto a two-member union, with the fall-through resolving
   * to the STRONGER claim. Measured at the time on a fast answer-mode relay lane (5.7–10.8 s runs
   * against a 90 s floor), `llm-relay dispatch` printed `budget: 90s (from 25 recorded runs)` when
   * no run had ever taken anywhere near 90 s. It also hid the very signal the budget exists to
   * expose: that this lane's real p80 is nine seconds. Found by an adversarial review, and pinned
   * by `test/dispatch-attempt-budget.test.ts`.
   */
  attemptBudget?: {
    ms: number;
    basis: "history" | "floor" | "clamped";
    samples: number;
    /**
     * The lane's OWN quantile, present only on `clamped` — where it is the figure the operator
     * came to read and `ms` is not it. Never a guess: absent unless a quantile was computed.
     */
    quantileMs?: number;
  };
  /**
   * This lane recently failed to answer inside the budget a dispatch walk gave it, so ready lanes
   * carrying no demotion are tried ahead of it for a window (`lane-affinity.ts`).
   *
   * ⚠ **It is a FIELD, not a `LaneState` member, and that is load-bearing.** `buildDispatch`
   * selects on `state === "ready"`, so a `slow` member of that union would REMOVE a slow lane
   * rather than demote it — breaking "health demotes, never drops" inside the very change that
   * exists to honour it. Demotion is a TERM in the ordering, exactly as quota demotion is a term
   * inside `targetUsability` on the HTTP path rather than a state.
   *
   * ⚠ **The evidence is first-party and needs no threshold.** `docs/backlog.md` asks for a
   * calibrated wall-clock statistic and warns, correctly, never to borrow the HTTP path's numbers
   * — a lane legitimately runs an agent loop for minutes. This carries no statistic at all: "the
   * walk gave this lane its budget and it did not answer" is a measurement of this lane, by this
   * relay, moments ago.
   */
  demoted?: { until: string; reason: string };
}

export interface DispatchView {
  /** Selected tier-specific ladder, or null when using the legacy single ladder. */
  tier: string | null;
  /** State of the selected client's offload rule, which governs relay-rung hints. */
  offload: boolean;
  /** Originating harness whose rule controls relay-rung directive hints. */
  client: string;
  /**
   * Whether the CALLING host's traffic reaches this relay, as reported by the caller — the
   * server cannot observe it (a bypassing host sends nothing here) and must not guess from its
   * own environment. Governs whether relay rungs are usable as written or transposed.
   */
  host: HostRoutingState;
  ladder: DispatchLane[];
  /**
   * Lane ids that MAY be selected, best first — the ONE definition of selection order.
   * `next` is `order[0]` resolved against `ladder`; a dispatch WALK iterates the same list.
   *
   * ⚠ It exists so the order has one owner. The alternative — a walking caller re-deriving the
   * order from `ladder` — puts two definitions of one rule in two files, which is the shape this
   * repository's history warns about more often than any other (`orderByUsability` versus
   * `targetUsability`, the pool-failover incident, the two hand-assembled announcement sets).
   *
   * ⚠ `ladder` itself stays in CONFIG order, because `position` is documented as stable and a
   * reader needs to see the configured ladder rather than a re-sorted one. Unselectable rungs
   * (exhausted, disabled, unreachable, not servable) are absent from `order` entirely — this is
   * the order of what may be TRIED, not a ranking of everything.
   */
  order: string[];
  /** The lane the host should use now, or null when every rung is spent or none configured. */
  next: DispatchLane | null;
  /** Why `next` is what it is — including why it is null. */
  reason: string;
  /** Dispatched task text when one was given. */
  task?: string;
  /** Source of this dispatch view: live daemon, or local fallback when daemon is unreachable. */
  source?: "daemon" | "local-fallback";
}

export interface DispatchOptions {
  /** Originating harness (`claude`, `codex`, or a future configured client). */
  client?: string;
  /** Select a named tier-specific ladder (for example low, medium, high, or xhigh). */
  tier?: string;
  /** Substituted for the `{task}` placeholder in a cli rung's args. */
  task?: string;
  /**
   * Cached lane manifest (`llm-relay lanes --probe`). Passed in rather than loaded here so the
   * request path never touches the filesystem on our behalf and tests can pin it. Absent ⇒ every
   * rung is UNKNOWN and nothing is evicted.
   */
  manifest?: LaneManifest | null;
  /** Host override: return THIS lane as `next`, whatever the order says. */
  lane?: string;
  /** Walk the ladder: pick the first ready rung strictly after this one. */
  after?: string;
  /**
   * Whether the CALLER's traffic reaches this relay (`src/host-routing.ts`). Supplied by the
   * caller, never sniffed here: `buildDispatch` runs inside the server as often as not, and the
   * server's own environment describes the process launched at logon, not the session asking.
   * Absent means `unknown` — behave exactly as before this existed.
   */
  host?: HostRoutingState;
  /** Harness name, for messages only (`claude-desktop`). Never used to decide anything. */
  entrypoint?: string;
  /**
   * Context window a provider PUBLISHES for one of its models, in tokens, or null when it
   * publishes none. Injected rather than read here so this module keeps no catalog dependency and
   * stays synchronous — the server backs it with `catalog.cachedLimits()` (which never fetches, so
   * this cannot become a blocking round-trip), and the CLI with the same on-disk cache.
   *
   * Absent means no window is resolved for any lane, which is exactly the behaviour before this
   * existed. Never guess a number here: see `specContextWindow`.
   */
  publishedContextWindow?: (spec: string) => ResolvedContextWindow | null;
}

/**
 * Cooldown state, scoped to the `Config` it was reported against.
 *
 * It used to be one module-level `Map` shared by the whole process, keyed by `rung:<id>` /
 * `quota:<name>`. Those keys are namespaced by nothing: two `Config`s live in one process (a test
 * file, a future reload, any library caller holding more than one) collided whenever they happened
 * to name a rung or a quota bucket the same, so exhausting a lane in one silently parked an
 * unrelated lane in the other — and `clearExhausted(cfg)` with no id wiped every config's state,
 * not the caller's. Cooldowns describe *this* ladder, so they belong to it.
 *
 * A `WeakMap` because the state's whole lifetime is the config's: when the config is gone there is
 * no ladder left to cool down, and nothing should keep the entry alive.
 */
const cooldowns = new WeakMap<Config, Map<string, number>>();

/** rung id or quota bucket → epoch ms at which it is eligible again, for THIS config. */
function cooldownsFor(cfg: Config): Map<string, number> {
  let m = cooldowns.get(cfg);
  if (!m) {
    m = new Map<string, number>();
    cooldowns.set(cfg, m);
  }
  return m;
}

function cooldownKey(rung: LadderRung): string {
  return rung.quota ? `quota:${rung.quota}` : `rung:${rung.id}`;
}

function cooldownUntil(cfg: Config, rung: LadderRung, now: number): number | null {
  const map = cooldownsFor(cfg);
  const until = map.get(cooldownKey(rung));
  if (until === undefined) return null;
  if (until <= now) {
    map.delete(cooldownKey(rung));
    return null;
  }
  return until;
}

/**
 * Clamp a host-reported TTL to a finite, representable window. A cooldown is advisory, so a
 * nonsense value is corrected rather than rejected — dropping the report would discard a real
 * "this lane is spent" signal over a bad number. See `MAX_EXHAUSTED_MS` for what an unclamped
 * `Infinity`/`NaN` did to the ladder.
 */
function normalizeTtl(ttlMs: unknown): number {
  if (typeof ttlMs !== "number" || !Number.isFinite(ttlMs)) return DEFAULT_EXHAUSTED_MS;
  return Math.min(MAX_EXHAUSTED_MS, Math.max(0, ttlMs));
}

/**
 * Clamp an ABSOLUTE cooldown deadline into the window this relay is willing to hold one for —
 * the sibling of `normalizeTtl` above, which does the same for a DURATION.
 *
 * Both write sites had their own copy: the persistence restore and the quota probe's
 * `markExhaustedKey`. They differed only in that the restore path had already rejected a past
 * deadline one line earlier, so its copy omitted the floor — which makes the floor a no-op there
 * and the two expressions the same rule (owner ruling 2026-09-06, the surviving half of SEM-06).
 *
 * ⚠ The ceiling is not cosmetic. The report route accepts a vendor-stated cooldown, and an
 * unclamped one parks a lane for longer than this relay will ever admit is reasonable; the floor
 * stops a deadline already in the past from being stored as a live cooldown.
 */
function clampExhaustedDeadline(untilMs: number, now: number): number {
  return Math.min(Math.max(now, untilMs), now + MAX_EXHAUSTED_MS);
}

/**
 * Report a rung spent (quota gone, rate-limited, CLI missing). Rungs sharing a `quota` bucket
 * are cooled down together — that is the whole point of the bucket, since one CLI can meter two
 * model families against two independent balances and only one of them may be gone.
 *
 * Unknown id is not an error: a host walking a ladder it half-remembers should not get a 500.
 */
export function markExhausted(
  cfg: Config,
  id: string,
  ttlMs: number = DEFAULT_EXHAUSTED_MS,
  tier?: string,
): boolean {
  if (typeof id !== "string" || id.length === 0) return false;
  const rung = selectLadder(cfg, tier).rungs.find((r) => r.id === id);
  if (!rung) return false;
  markExhaustedKey(cfg, cooldownKey(rung), Date.now() + normalizeTtl(ttlMs));
  return true;
}

/** Clear one rung's cooldown, or every cooldown for this config when no id is given. */
export function clearExhausted(cfg: Config, id?: string, tier?: string): void {
  if (id === undefined) {
    const map = cooldownsFor(cfg);
    if (map.size > 0) {
      map.clear();
      notifyExhaustion(cfg);
    }
    return;
  }
  if (typeof id !== "string") return;
  const rung = selectLadder(cfg, tier).rungs.find((r) => r.id === id);
  if (rung) clearExhaustedKey(cfg, cooldownKey(rung));
}

/**
 * One exported/persisted cooldown row: the raw map key (`rung:<id>` / `quota:<name>`) and its
 * absolute expiry in epoch ms. The KEY travels, not the rung, because a bucket outlives any one
 * ladder rendering — the same `quota:<name>` may appear in several tiers.
 */
export interface ExhaustedRow {
  key: string;
  until: number;
}

/**
 * Change listeners for this config's exhaustion state, so persistence can mirror it to disk the
 * way `breaker-persistence.ts` mirrors the breaker. A listener throw is contained: mirroring is
 * best-effort and must never fail a dispatch mutation.
 */
const exhaustionListeners = new WeakMap<Config, Set<() => void>>();

export function onExhaustionChanged(cfg: Config, listener: () => void): void {
  let set = exhaustionListeners.get(cfg);
  if (!set) {
    set = new Set();
    exhaustionListeners.set(cfg, set);
  }
  set.add(listener);
}

function notifyExhaustion(cfg: Config): void {
  for (const listener of exhaustionListeners.get(cfg) ?? []) {
    try {
      listener();
    } catch {
      /* best-effort mirror — never fail the mutation */
    }
  }
}

/** Still-future cooldown rows, for persistence and for probe-target selection. */
export function exportExhaustedRows(cfg: Config, now: number = Date.now()): ExhaustedRow[] {
  const out: ExhaustedRow[] = [];
  for (const [key, until] of cooldownsFor(cfg)) {
    if (until > now) out.push({ key, until });
  }
  return out;
}

/**
 * Restore persisted rows into this config's live map. Field-validated per row, future-only, and
 * it NEVER overwrites a cooldown this process already learned — the `restoreState` contract.
 * An `until` beyond `MAX_EXHAUSTED_MS` from now is clamped, mirroring `normalizeTtl` at write.
 */
export function restoreExhaustedRows(cfg: Config, rows: readonly ExhaustedRow[], now: number = Date.now()): number {
  const map = cooldownsFor(cfg);
  let restored = 0;
  for (const row of rows) {
    // Shape validation lives in the persistence LOADER (the breaker split); these are the
    // semantic guards a validated row still needs: a live expiry, and no overwrite.
    if (row.key.length === 0) continue;
    if (!Number.isFinite(row.until) || row.until <= now) continue;
    if (map.has(row.key)) continue;
    map.set(row.key, clampExhaustedDeadline(row.until, now));
    restored++;
  }
  if (restored > 0) notifyExhaustion(cfg);
  return restored;
}

/** Mark one raw bucket key exhausted until an absolute time — the probe path's write. */
export function markExhaustedKey(cfg: Config, key: string, untilMs: number, now: number = Date.now()): void {
  if (typeof key !== "string" || key.length === 0) return;
  if (typeof untilMs !== "number" || !Number.isFinite(untilMs)) return;
  cooldownsFor(cfg).set(key, clampExhaustedDeadline(untilMs, now));
  notifyExhaustion(cfg);
}

/** Clear one raw bucket key — the probe path's retraction. */
export function clearExhaustedKey(cfg: Config, key: string): void {
  if (cooldownsFor(cfg).delete(key)) notifyExhaustion(cfg);
}

/** The placeholder a cli rung's args must contain; substituted with the task text. */
export const TASK_TOKEN = "{task}";

/** The placeholder a `routing.cliLane` template's args must contain; substituted with the spec. */
export const SPEC_TOKEN = "{spec}";

/**
 * Optional placeholder for the spec's context window, in tokens. Usable in a `cliLane` template's
 * args AND env values — unlike `{task}`, which is never substituted into env.
 *
 * The distinction is not arbitrary. `{task}` carries text a model or a user wrote, so putting it
 * in the environment of a spawned process would let request content become process configuration.
 * `{contextWindow}` is a number this relay resolved from the serving provider's own published
 * metadata; it IS configuration. That is what makes it safe here and `{task}` not.
 *
 * Exists because a client cannot be expected to know the window of a model it does not recognise —
 * the `claude` CLI assumes 200k for an unknown `--model` and compacts against that, so a lane
 * pointed at a 1M-context model silently throws away four fifths of it.
 */
export const CONTEXT_TOKEN = "{contextWindow}";

/**
 * Published context window for a spec, in tokens, or null when it cannot be stated.
 *
 * ⚠ Null is the common answer and must stay honest. Free providers largely publish no metadata at
 * all (NIM publishes none), so a pool's members are mostly unknown — measured on this machine, 0
 * of 29 members of `pool/high` publish a context length. Guessing a window is strictly worse than
 * omitting it: the client already has a conservative default, and a number we invented would
 * override that default with fiction and overflow the real backend.
 *
 * For a POOL the MINIMUM across members that resolve is used: failover can land the request on any
 * member, so the pool's usable window is the smallest one known.
 *
 * ⚠ **An unresolvable member does NOT veto the pool.** That was the original rule and it was
 * wrong twice over. Practically, a single model with no published figure anywhere blanked three of
 * four pools on the owner's machine — `huggingface/Qwen/Qwen3-235B-A22B-Instruct-2507` alone
 * blocked `low`, `medium` and `high` while 44 of 49, 38 of 41 and 28 of 29 members resolved fine.
 * Conceptually, a pool is a ROUTING construct — a ranked candidate list — and membership of one
 * says nothing about any member's context window; treating "we have no data on one model" as "we
 * know nothing about this pool" confuses an absent measurement with a measured absence.
 *
 * The residual risk — an unmeasured member whose real ceiling is below the reported minimum — is
 * exactly what the observed rung exists to close: the first over-length rejection from that
 * deployment states its ceiling, `context-limits.ts` records it, and the next dispatch reports the
 * corrected floor. `contextWindowUnknownMembers` carries how much of the pool the number covers,
 * so the gap is visible rather than implied.
 */
export function specContextWindow(
  spec: string,
  cfg: Config,
  published: (spec: string) => ResolvedContextWindow | null,
): (ResolvedContextWindow & { unknownMembers: number }) | null {
  let specs: string[];
  try {
    specs = expandPoolSpecs([spec], cfg);
  } catch {
    return null;
  }
  if (specs.length === 0) return null;

  // ⚠ The DEGRADE TAIL is excluded from the floor.
  //
  // A pool does not have a context window; a CLI launched against one has to be told a single
  // number up front (`CLAUDE_CODE_MAX_CONTEXT_TOKENS`) before any request exists, and cannot
  // renegotiate per turn. Since failover can land on any member, that number has to be a floor.
  //
  // Taking it over EVERY member made the floor hostage to the weakest thing the pool can fall back
  // to — and once pools began admitting paid and lower-band members, that went from ~44 members to
  // 200, so one small model capped a lane whose in-band members are all large. The band is what
  // the caller asked for; the tail is an announced last resort (`x-llm-relay-degraded`), and
  // landing there already means accepting something weaker. It is safe because the context
  // guardrail prunes any member that cannot take the prompt, so an over-length request skips the
  // small ones instead of failing on them.
  const tail = new Set(cfg.routing.poolDegraded?.[spec.startsWith(POOL_PREFIX + "/") ? spec.slice(POOL_PREFIX.length + 1) : ""] ?? []);
  if (tail.size > 0) {
    const inBand = specs.filter((s) => !tail.has(s));
    if (inBand.length > 0) specs = inBand;
  }

  let best: ResolvedContextWindow | null = null;
  let unknown = 0;
  for (const s of specs) {
    const window = published(s);
    if (window === null || !Number.isFinite(window.tokens) || window.tokens <= 0) {
      unknown++;
      continue;
    }
    // The MEMBER that sets the minimum is the binding constraint, so its provenance is the one
    // that describes the number being reported — not the first member's, and not a blend.
    if (best === null || window.tokens < best.tokens) best = window;
  }
  // Nothing resolved at all is still null: a floor over an empty set is not a floor.
  return best === null ? null : { ...best, unknownMembers: unknown };
}

/**
 * Can a bypassed host reach this spec with a plain subagent, no relay involvement?
 *
 * Only when every provider it resolves to is the caller's OWN vendor passthrough — an
 * `anthropic`-kind provider declaring no top-level `authEnv` whose normalized credential policy
 * is not `contained`. This admits both explicit passthrough and the legacy omitted-mode form,
 * while rejecting provider-owned single-key and fleet credentials. A fleet also has no top-level
 * `authEnv`, so that field alone is not a passthrough signal. Such a rung means "give up and spend
 * primary quota", and an ordinary `Agent(...)` call does exactly that from any host. It needs no
 * directive, no offload rule and no shell-out, so transposing it would replace a working lane with
 * a needlessly heavier one.
 *
 * Everything else — pools, pinned third-party models — needs the subagent-reroute machinery,
 * which is precisely what a bypassed host does not have.
 *
 * An unresolvable spec counts as NOT reachable. Config load already rejects those, so this is a
 * narrow edge; when it does happen, declining to claim the dead subagent path works is the
 * conservative direction.
 */
function reachableWithoutRelay(spec: string, cfg: Config): boolean {
  let specs: string[];
  try {
    specs = expandPoolSpecs([spec], cfg);
  } catch {
    return false;
  }
  if (specs.length === 0) return false;
  return specs.every((s) => {
    const provider = cfg.providers[splitSpec(s).provider];
    return (
      provider !== undefined &&
      provider.kind === "anthropic" &&
      provider.authEnv === undefined &&
      provider.credentialMode !== "contained"
    );
  });
}

/**
 * Render a `relay` rung's spec as a CLI invocation via the operator's `routing.cliLane` template.
 *
 * `{task}` is substituted only into ARGS, never into env values: env is operator-authored routing,
 * and request content must not become process configuration. `{spec}` and `{contextWindow}` are
 * relay-resolved configuration, so they are substituted in both places. Each substitution stays
 * inside a single argv element, so no amount of shell metacharacter in a task can become a second
 * word.
 *
 * ⚠ An env entry asking for `{contextWindow}` is DROPPED when the window is unknown, rather than
 * being set to an empty string or a guess. An empty value would be read by the child as a limit of
 * zero or as garbage; omitting the variable leaves the client on its own conservative default,
 * which is the correct behaviour when nobody published a number.
 */
function transposeToCli(
  spec: string,
  lane: NonNullable<Config["routing"]["cliLane"]>,
  task: string | undefined,
  platform: NodeJS.Platform,
  contextWindow: number | null,
): NonNullable<DispatchLane["invoke"]> {
  const fillShared = (value: string): string => {
    const withSpec = value.split(SPEC_TOKEN).join(spec);
    return contextWindow === null ? withSpec : withSpec.split(CONTEXT_TOKEN).join(String(contextWindow));
  };
  const invoke: NonNullable<DispatchLane["invoke"]> = {
    command: normalizeCliCommand(lane.command, platform),
    args: lane.args.map((a) => {
      const shared = fillShared(a);
      // No task given => leave the placeholder visible, exactly as a cli rung does, so the caller
      // can see where it goes rather than receiving a command that asks the agent to do nothing.
      return task === undefined ? shared : shared.split(TASK_TOKEN).join(task);
    }),
  };
  if (lane.env) {
    const env: Record<string, string | null> = {};
    for (const [name, value] of Object.entries(lane.env)) {
      if (value === null) {
        env[name] = null;
        continue;
      }
      if (contextWindow === null && value.includes(CONTEXT_TOKEN)) continue;
      env[name] = fillShared(value);
    }
    if (Object.keys(env).length > 0) invoke.env = env;
  }
  return invoke;
}

/**
 * Resolve command names whose Windows shell semantics differ from their POSIX spelling.
 *
 * PowerShell resolves functions and aliases before external applications. Antigravity commonly
 * installs a PowerShell function named `agy` for opening the IDE alongside the headless
 * `agy.exe` CLI, so handing a Windows host the bare name can launch the GUI instead of running
 * the delegated task. Naming the executable extension bypasses that shadowing. Keep the rule
 * deliberately narrow: explicit paths and every other configured command remain authoritative.
 */
export function normalizeCliCommand(command: string, platform: NodeJS.Platform = process.platform): string {
  return platform === "win32" && /^agy$/i.test(command) ? `${command}.exe` : command;
}

/**
 * Where the windowless-console launcher lives, if the operator has installed one.
 *
 * Not shipped by this package or by any of its installers (verified: no `lane-launch.ps1` exists
 * anywhere under this repository) — it is a hand-maintained artifact documented in CLAUDE.md's AGY
 * lane notes and `docs/agy-popup-fix-2026-09-07.md`. So absence is the ORDINARY case on a fresh
 * machine and on every non-Windows host, not a misconfiguration to warn about. Resolved through the
 * same config-kind XDG base every other operator-authored artifact under this directory uses
 * (`state-paths.ts`), so an XDG override on the config side moves this alongside `config.json`
 * itself — matching where every hand-authored `cli` ladder rung already points its own `-File`
 * argument. (`state-paths.ts` stays the one module naming the XDG variables directly, per
 * `test/state-paths.test.ts` — this reaches them only through `relayStatePath`.)
 *
 * Deliberately the ONE impure seam in this module (the `buildDispatch`/`platform` precedent): every
 * function below it stays pure over a caller-resolved `launcherPath: string | null`. ⚠ Guarded like
 * `winenv.ts`/`os-keyring.ts`/`lane-runner.ts`'s default spawner: under vitest, a caller that omits
 * `exists` gets `null` unconditionally rather than the real filesystem — a suite must never depend
 * on whether THIS machine happens to have the launcher installed (it does), which is exactly what
 * broke `routes/admin.ts` and `cli.ts`'s own call sites (neither injects a seam) before this guard
 * existed. A test that wants the real check injects `exists` itself, same as every seam above it.
 */
export function resolveLaneLauncherPath(
  platform: NodeJS.Platform = process.platform,
  exists?: (path: string) => boolean,
): string | null {
  if (platform !== "win32") return null;
  if (exists === undefined && process.env["VITEST"]) return null;
  const path = relayStatePath("config", ["bin", "lane-launch.ps1"]);
  return (exists ?? existsSync)(path) ? path : null;
}

/**
 * Does this invocation already run through the windowless-console launcher? A config that has
 * already adopted the convention by hand — every ladder `cli` rung addressing agy/opencode does —
 * must not be wrapped a second time, which would nest one windowless console session inside another
 * for no benefit and double the `-File` indirection in every rendered command.
 */
function isAlreadyLaneLaunched(command: string, args: readonly string[]): boolean {
  if (!/^(pwsh|powershell)(\.exe)?$/i.test(command)) return false;
  const fileIdx = args.findIndex((a) => a === "-File" || a === "/File");
  if (fileIdx === -1) return false;
  const target = args[fileIdx + 1];
  if (!target) return false;
  const basename = target.split(/[\\/]/).pop() ?? "";
  return /^lane-launch\.ps1$/i.test(basename);
}

/**
 * Wrap a lane invocation through the windowless-console launcher, so the console-subsystem process
 * this relay spawns — and every descendant IT spawns after it starts — cannot allocate a visible
 * console and steal the desktop's foreground the way `docs/agy-popup-fix-2026-09-07.md` measured.
 *
 * ⚠ The `execFile` call in `mcp/lane-runner.ts` — `windowsHide: true` — covers only the IMMEDIATE child;
 * that document's own finding is that a console-subsystem descendant spawned later — a detached
 * updater probe, an IDE-detection helper, a nested nested MCP client — is unaffected by a flag the
 * relay set on a process two generations up, and allocates its own new, VISIBLE console. That is
 * exactly the shape `routing.cliLane`'s transposition left open: every hand-authored `cli` ladder
 * rung already wraps itself with `pwsh -File lane-launch.ps1` in its own configured `command`/`args`,
 * but the SEPARATE `routing.cliLane` template — the fallback this module itself synthesizes when a
 * relay-kind rung must be reached by shelling out (see `transposeToCli`) — has no per-rung config
 * entry an operator would think to wrap the same way, so it never was. Applying the wrap HERE, once,
 * to whatever `toLane` ends up with covers both shapes uniformly: a ladder rung a future config adds
 * without remembering the convention, and every `routing.cliLane` transposition alike.
 *
 * `launcherPath` is null on every non-Windows host and on a Windows host with nothing installed
 * (`resolveLaneLauncherPath`), in which case this returns `invoke` UNCHANGED — byte-identical to
 * this fix's absence, so an operator who has not installed the launcher sees no behaviour change.
 */
function wrapForWindowsConsoleSafety(
  invoke: { command: string; args: string[] },
  launcherPath: string | null,
  platform: NodeJS.Platform,
): { command: string; args: string[] } {
  if (platform !== "win32" || launcherPath === null) return invoke;
  if (isAlreadyLaneLaunched(invoke.command, invoke.args)) return invoke;
  return {
    command: "pwsh",
    args: ["-NoProfile", "-ExecutionPolicy", "Bypass", "-File", launcherPath, invoke.command, ...invoke.args],
  };
}

/**
 * Normalize the caller's options. `DispatchOptions` is typed, but nothing type-checks the values
 * that actually arrive: they come off a raw query string (`GET /dispatch?task=…&lane=…`) or a
 * JSON body, so at runtime any field can be a number, an array, an object or null. TypeScript
 * cannot catch that at the boundary, so this does.
 *
 * Deliberately narrow. It normalizes what this module OWNS — the shape of its own inputs — and
 * nothing else:
 *  - a non-string field is treated as absent, because a caller who sent one cannot have meant a
 *    lane id or a task, and coercing it would invent an intent;
 *  - a blank `task` is treated as absent, so the `{task}` placeholder stays visible instead of
 *    rendering an argv element that asks the agent to do nothing — that is exactly the case the
 *    substitution site already documents;
 *  - a blank `lane`/`after` is treated as absent, because an empty override is not an override,
 *    and reporting it as a missed lookup would blame the host for a parameter it never set.
 *
 * It does NOT length-bound or sanitize the task text. Bounding request input belongs to whoever
 * accepts the request (`server.ts` already rejects an oversized `?task=`), and a second limit here
 * would be a duplicate that can silently drift out of step with it. Shell-quoting the rendered
 * command is the renderer's job. This module's guarantee about `task` remains the one it has
 * always had: the substitution stays inside a single argv element.
 */
function normalizeOptions(opts: DispatchOptions): DispatchOptions {
  const str = (v: unknown): string | undefined => (typeof v === "string" && v.length > 0 ? v : undefined);
  const out: DispatchOptions = {};
  const task = str(opts.task);
  if (task !== undefined && task.trim().length > 0) out.task = task;
  const lane = str(opts.lane);
  if (lane !== undefined) out.lane = lane;
  const after = str(opts.after);
  if (after !== undefined) out.after = after;
  const tier = str(opts.tier);
  if (tier !== undefined) out.tier = tier;
  const client = str(opts.client);
  if (client !== undefined) out.client = client;
  // An unrecognised host verdict is treated as absent rather than corrected: the caller is
  // asserting something only it can know, and inventing "bypassed" from a typo would transpose
  // lanes that did not need it, while inventing "routed" would re-offer the dead subagent path.
  // "unknown" — behave as before this existed — is the only safe reading of a value we cannot parse.
  const host = str(opts.host);
  if (host === "routed" || host === "bypassed" || host === "unknown") out.host = host;
  const entrypoint = str(opts.entrypoint);
  if (entrypoint !== undefined) out.entrypoint = describeId(entrypoint);
  // Not a wire field — an in-process callback supplied by the server or the CLI. Type-guarded for
  // the same reason as everything else here: this object can arrive from a JSON body, where the
  // key could be any shape, and calling a non-function would throw mid-render.
  if (typeof opts.publishedContextWindow === "function") out.publishedContextWindow = opts.publishedContextWindow;
  // Not a wire field either — supplied in-process by the server/CLI from the cached manifest. Shape
  // is guarded for the same reason as the rest: a malformed value must read as "no manifest"
  // (⇒ nothing evicted), never throw mid-render or evict on garbage.
  const manifest = opts.manifest;
  if (manifest && typeof manifest === "object" && manifest.version === 1 && typeof manifest.lanes === "object" && manifest.lanes !== null) {
    out.manifest = manifest;
  }
  return out;
}

function inferredTier(cfg: Config): string | undefined {
  const ladders = cfg.routing.ladders;
  if (!ladders) return undefined;
  const dflt = cfg.routing.subagents?.default;
  if (dflt?.startsWith("pool/") && ladders[dflt.slice("pool/".length)]) return dflt.slice("pool/".length);
  if (ladders.medium) return "medium";
  // Backwards compatibility for configurations created before effort-named ladders.
  if (ladders.coding) return "coding";
  return Object.keys(ladders)[0];
}

function selectLadder(cfg: Config, requested?: string): { tier: string | null; rungs: LadderRung[]; missing?: string } {
  if (!cfg.routing.ladders) return { tier: null, rungs: cfg.routing.ladder ?? [] };
  const tier = requested ?? inferredTier(cfg);
  if (!tier || !cfg.routing.ladders[tier]) return { tier: tier ?? null, rungs: [], ...(tier ? { missing: tier } : {}) };
  return { tier, rungs: cfg.routing.ladders[tier] };
}

/**
 * Every rung across EVERY ladder the config declares — each tiered ladder, then the legacy
 * single ladder. The ONE ladder walk: `POST /dispatch/telemetry` (unknown-lane 400) and the
 * CLI's `--by model` lane-id check both read through here or through `findLadderRung`, so a
 * new ladder shape is fixed once. (`markExhausted` stays tier-scoped via `selectLadder` — an
 * exhaustion report arrives on a tier's dispatch view.)
 */
export function allLadderRungs(cfg: Config): LadderRung[] {
  const ladders = cfg.routing.ladders;
  const tiered = ladders ? Object.values(ladders).flat() : [];
  return [...tiered, ...(cfg.routing.ladder ?? [])];
}

/**
 * Find one rung by id across every ladder the config declares, whatever tier holds it.
 * Tier-agnostic on purpose: a telemetry report names a lane, not a tier. `markExhausted`
 * stays tier-scoped (an exhaustion report arrives on a tier's dispatch view); this is the
 * shared lookup both branches mean — one walk, not two.
 */
export function findLadderRung(cfg: Config, laneId: string): LadderRung | undefined {
  if (typeof laneId !== "string" || laneId.length === 0) return undefined;
  return allLadderRungs(cfg).find((rung) => rung.id === laneId);
}

/** C0 + C1 control characters, including ESC — never legal in a rung id, and the ANSI carrier. */
function stripControlCharacters(value: string): string {
  let out = "";
  for (let i = 0; i < value.length; i++) {
    const code = value.charCodeAt(i);
    out += (code >= 0 && code <= 0x1f) || (code >= 0x7f && code <= 0x9f) ? "\uFFFD" : value[i]!;
  }
  return out;
}

/**
 * Render a caller-supplied id for a `reason` string. The reason is reflected back verbatim in the
 * JSON response AND printed to a terminal by `llm-relay dispatch`, so echoing raw caller input let
 * a `?lane=` carrying ESC sequences rewrite the operator's terminal, and an arbitrarily long one
 * bloat a response about a lane that does not exist. Control characters go, and the echo is capped
 * — enough to recognise your own typo, not a channel.
 */
function describeId(id: string): string {
  const clean = stripControlCharacters(id);
  return clean.length > MAX_ECHOED_ID ? `${clean.slice(0, MAX_ECHOED_ID)}\u2026` : clean;
}

/**
 * Can THIS host address a relay spec as a subagent at all?
 *
 * `routed` can — its traffic reaches the relay, so `routing.subagents` reroutes an `Agent(...)`
 * call in place. An ABSENT verdict keeps that same pre-existing path: the caller stated nothing,
 * and second-guessing silence would change behaviour for a caller that never asked.
 *
 * `bypassed` and `unknown` cannot, for different reasons — see `mustTransposeEveryRung`.
 */
function canAddressAsSubagent(host: HostRoutingState | undefined): boolean {
  return host === "routed" || host === undefined;
}

/**
 * Must EVERY relay rung be transposed for this host, whatever the spec says?
 *
 * Only for a STATED `unknown`. `host-routing.ts` defines that state as "not running inside a
 * Claude Code session — no subagent routing to adapt to", so such a caller has no subagent
 * mechanism of any kind and `reachableWithoutRelay` has nothing to decide: even the plain
 * Anthropic passthrough, which any Claude harness reaches with a bare `Agent(...)`, is
 * unreachable here. A `bypassed` host still HAS the tool, so it keeps the per-spec test.
 */
function mustTransposeEveryRung(host: HostRoutingState | undefined): boolean {
  return host === "unknown";
}

/** Why a relay rung cannot be reached, in terms true for THIS host's actual condition. */
function unreachableReason(host: HostRoutingState | undefined, who: string): string {
  return mustTransposeEveryRung(host)
    ? `${who} is not running inside a Claude Code session, so it has no subagent mechanism to reach`
    : `${who} does not route its traffic through this relay, so a subagent cannot reach`;
}

function toLane(
  rung: LadderRung,
  position: number,
  cfg: Config,
  opts: DispatchOptions,
  now: number,
  client: string,
  platform: NodeJS.Platform,
  host: HostRoutingState | undefined,
  entrypoint: string | undefined,
  launcherPath: string | null,
): DispatchLane {
  const until = cooldownUntil(cfg, rung, now);
  const state: LaneState = !rung.enabled ? "disabled" : until !== null ? "exhausted" : "ready";

  const lane: DispatchLane = { id: rung.id, kind: rung.kind, position, state };
  if (rung.quota) lane.quota = rung.quota;
  if (rung.note) lane.note = rung.note;
  if (until !== null) lane.readyAt = new Date(until).toISOString();
  // Rendered even when absent (`null`), so a reader never has to infer "unbounded" from a missing
  // key. No `rung.kind` branch needed: only a `cli` rung's parser ever sets `rung.maxConcurrent`
  // (`applyCliMaxConcurrent` in `config/routing-parser.ts`), so it is already `undefined` — and
  // therefore `null` here — on every `relay` rung.
  lane.maxConcurrent = rung.maxConcurrent ?? null;

  if (rung.kind === "cli" && rung.command && rung.args) {
    lane.invoke = {
      command: normalizeCliCommand(rung.command, platform),
      // No task given => leave the placeholder visible, so the caller can see where it goes
      // rather than receiving a command that silently asks the agent to do nothing.
      args: opts.task === undefined ? [...rung.args] : rung.args.map((a) => a.split(TASK_TOKEN).join(opts.task!)),
    };
    if (rung.env) lane.invoke.env = { ...rung.env };

    // Validate the rung against what the lane's own tool says it serves. Reads the CACHED manifest
    // only — nothing here spawns anything. ⚠ Absent/unprobed/unknown ⇒ no change at all, so a stale
    // manifest can never empty the ladder (see lane-manifest.ts).
    const dropped = unsupportedRungArgs(rung, opts.manifest ?? null);
    if (dropped.length > 0) {
      lane.invoke.args = stripArgs(lane.invoke.args, dropped.map((d) => d.arg));
      lane.droppedArgs = dropped.map((d) => d.reason);
    }
    const verdict = verifyRungModel(rung, opts.manifest ?? null);
    if (verdict?.status === "not-servable") {
      lane.notServable = verdict.reason;
      lane.state = "not-servable";
      // Withhold the command entirely. A rung whose model does not exist must not be renderable —
      // handing back a command known to fail is the whole defect being fixed here.
      delete lane.invoke;
    }
  }
  if (rung.kind === "relay" && rung.spec) {
    lane.spec = rung.spec;
    // ⚠ This used to ask only `host === "bypassed"`, so a STATED `unknown` fell through with
    // `routed` and a headless caller — a cron job, a CI step, `run-headless.ps1` — was handed a
    // `target:` spec to address as a subagent it does not have; `--next-command` then refused
    // with exit 2 and left it nothing to run. That is the closed-vocabulary defect class
    // CLAUDE.md documents: an unhandled member falling through to the STRONGER claim.
    if (canAddressAsSubagent(host)) {
      lane.requiresDirective = !offloadRule(cfg, client).enabled;
    } else if (mustTransposeEveryRung(host) || !reachableWithoutRelay(rung.spec, cfg)) {
      // The host cannot address this spec as a subagent at all, so the rung is offered as the
      // shell-out that CAN reach it — a change of mechanism, not of target. `requiresDirective`
      // is deliberately left unset: see its doc comment.
      const who = entrypoint ? `this host (${entrypoint})` : "this host";
      if (cfg.routing.cliLane) {
        const window = opts.publishedContextWindow
          ? specContextWindow(rung.spec, cfg, opts.publishedContextWindow)
          : null;
        lane.invoke = transposeToCli(rung.spec, cfg.routing.cliLane, opts.task, platform, window?.tokens ?? null);
        lane.transposed = true;
        if (window !== null) {
          lane.contextWindow = window.tokens;
          lane.contextWindowSource = window.source;
          if (window.unknownMembers > 0) lane.contextWindowUnknownMembers = window.unknownMembers;
        }
      } else {
        // Name the REAL reason, which differs by state. Telling a cron job that it "does not
        // route its traffic through this relay" describes a Claude-harness condition it does
        // not have, and points at a fix that would not help it.
        lane.unreachable =
          `${unreachableReason(host, who)} "${rung.spec}" — ` +
          `configure routing.cliLane to reach it by shelling out`;
      }
    }
  }
  // Applied LAST, to whatever `lane.invoke` ended up as above — a ladder `cli` rung's own command,
  // or a `routing.cliLane` transposition — so one wrap step covers both shapes uniformly rather than
  // each branch needing to remember it. A rung the not-servable check above already deleted `invoke`
  // from has nothing to wrap.
  if (lane.invoke) {
    const wrapped = wrapForWindowsConsoleSafety(lane.invoke, launcherPath, platform);
    lane.invoke = { ...lane.invoke, command: wrapped.command, args: wrapped.args };
  }
  return lane;
}


/** The `--model` / `--config model_reasoning_effort=` value a cli rung actually passes. */
function rungModel(rung: LadderRung): string | null {
  const args = rung.args ?? [];
  const i = args.indexOf("--model");
  if (i >= 0 && i + 1 < args.length) return args[i + 1] ?? null;
  const m = args.find((a) => a.startsWith("--model="));
  return m ? m.slice("--model=".length) : null;
}

function verifyRungModel(rung: LadderRung, manifest: LaneManifest | null) {
  if (!rung.command) return null;
  const model = rungModel(rung);
  if (!model) return null;
  // Args ride along so a lane behind a wrapper command (`pwsh … lane-launch.ps1 … agy.exe`)
  // still resolves to its lane — see `laneOfRung`.
  return verifyModel(manifest, rung.command, model, { args: rung.args });
}

/** Argument name/value pairs a cli rung passes, in both `--flag value` and `key=value` forms. */
function rungArgValues(rung: LadderRung): Array<{ arg: string; value: string }> {
  const args = rung.args ?? [];
  const out: Array<{ arg: string; value: string }> = [];
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === undefined) continue;
    if (a.startsWith("--") && !a.includes("=")) {
      const v = args[i + 1];
      if (v !== undefined && !v.startsWith("--")) out.push({ arg: a, value: v });
    } else if (a.includes("=") && !a.startsWith("--")) {
      const [k, ...rest] = a.split("=");
      if (k) out.push({ arg: k, value: rest.join("=") });
    }
  }
  return out;
}

function unsupportedRungArgs(rung: LadderRung, manifest: LaneManifest | null): Array<{ arg: string; reason: string }> {
  if (!rung.command) return [];
  const model = rungModel(rung);
  if (!model) return [];
  const dropped: Array<{ arg: string; reason: string }> = [];
  for (const { arg, value } of rungArgValues(rung)) {
    if (arg === "--model") continue;
    const v = unsupportedArgValues(manifest, rung.command, model, arg, value, { args: rung.args });
    if (v.unsupported && v.reason) dropped.push({ arg, reason: v.reason });
  }
  return dropped;
}

/** Remove `--flag value` pairs and `key=value` tokens (including a `--config key=value` pair). */
function stripArgs(args: string[], drop: string[]): string[] {
  const out: string[] = [];
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === undefined) continue;
    if (drop.includes(a)) { i++; continue; }
    const key = a.includes("=") ? a.split("=")[0] : null;
    if (key && drop.includes(key)) {
      // `--config key=value`: the preceding flag goes with it.
      if (out[out.length - 1] === "--config") out.pop();
      continue;
    }
    out.push(a);
  }
  return out;
}

export function buildDispatch(
  cfg: Config,
  rawOpts: DispatchOptions = {},
  platform: NodeJS.Platform = process.platform,
  // ⚠ Defaults to `null` — OFF — rather than auto-resolving via `resolveLaneLauncherPath(platform)`.
  // This keeps `buildDispatch` byte-identical for every existing caller and every existing test: a
  // default that read the real filesystem would change the rendered `invoke` for every test on a
  // machine that happens to have the launcher installed (this one does), including tests that pass
  // `platform: "win32"` to exercise unrelated Windows-only behaviour. A real caller opts in
  // explicitly by resolving the path itself and passing it — see `cli.ts` and `routes/admin.ts`.
  launcherPath: string | null = null,
): DispatchView {
  const opts = normalizeOptions(rawOpts ?? {});
  const client = opts.client ?? "default";
  const host = opts.host ?? "unknown";
  const now = Date.now();
  const selected = selectLadder(cfg, opts.tier);
  const rungs = selected.rungs;
  // ⚠ `opts.host`, NOT the `host` above. `host` collapses an ABSENT verdict into "unknown" for
  // the rendered view, and the lane builder must tell those two apart: an absent verdict keeps
  // the pre-existing subagent path, a STATED "unknown" has no subagent mechanism to keep.
  const ladder = rungs.map((r, i) =>
    toLane(r, i + 1, cfg, opts, now, client, platform, opts.host, opts.entrypoint, launcherPath),
  );
  // Advisory lane-execution stats, filled for every rung that ran under this config and omitted
  // otherwise. This mutates only the `stats` column: `state`, `next` and the ladder order were
  // decided above from cooldowns and availability, and nothing here revisits them.
  // Advisory `stats` column: a PER-LANE aggregate across tiers. One lane's runs under two
  // tiers count once, in one column — the column answers "how often was this lane taken", and
  // splitting it per tier would halve every figure the moment a second ladder is configured.
  const statsByLane = new Map<string, { calls: number; successes: number; failures: number; timeouts: number; wallClockMs: number[]; lastAt: number | null }>();
  for (const row of allLaneStats(cfg)) {
    const agg = statsByLane.get(row.laneId);
    if (!agg) {
      statsByLane.set(row.laneId, {
        calls: row.calls,
        successes: row.successes,
        failures: row.failures,
        timeouts: row.timeouts,
        wallClockMs: [...row.wallClockMs],
        lastAt: row.lastAt,
      });
      continue;
    }
    agg.calls += row.calls;
    agg.successes += row.successes;
    agg.failures += row.failures;
    agg.timeouts += row.timeouts;
    agg.wallClockMs.push(...row.wallClockMs);
    agg.lastAt = agg.lastAt === null ? row.lastAt : row.lastAt === null ? agg.lastAt : Math.max(agg.lastAt, row.lastAt);
  }
  for (const lane of ladder) {
    const row = statsByLane.get(lane.id);
    if (row === undefined) continue;
    lane.stats = {
      calls: row.calls,
      successes: row.successes,
      failures: row.failures,
      timeouts: row.timeouts,
      medianWallClockMs: medianWallClockMs(row.wallClockMs),
      p95WallClockMs: p95WallClockMs(row.wallClockMs),
      lastAt: row.lastAt,
    };
  }
  // Every lane gets a budget, whether or not it has ever run: a lane with no history takes the flat
  // figure at `floor` basis. Written in one pass over the whole ladder rather than only over rungs
  // that carry stats, so a never-run lane still shows the operator what it will be given.
  // ⚠ The budget reads the (lane, tier) window for THIS ladder — never the aggregate above.
  for (const lane of ladder) {
    const budget = attemptBudget(cfg, lane.id, selected.tier);
    if (budget !== undefined) lane.attemptBudget = budget;
  }
  // Routing memory from previous walks (`lane-affinity.ts`): which lane answered, and which lane
  // failed to answer inside the budget it was given. Like the stats above these are COLUMNS — they
  // never change a lane's `state`, and an unavailable lane carries neither. Only the ordering of
  // already-selectable lanes reads them, below.
  annotateAffinity(cfg, ladder, selected.tier, now);
  const offload = offloadRule(cfg, client).enabled;
  const base = { tier: selected.tier, offload, client, host, ladder };

  if (selected.missing) {
    return {
      ...base,
      order: [],
      next: null,
      reason: `no dispatch tier "${describeId(selected.missing)}" configured (have: ${Object.keys(cfg.routing.ladders ?? {}).join(", ")})`,
    };
  }

  if (ladder.length === 0) {
    return {
      ...base,
      order: [],
      next: null,
      reason: "no routing.ladder configured — dispatch order is the host's to choose",
    };
  }

  if (opts.lane !== undefined) {
    const forced = ladder.find((l) => l.id === opts.lane);
    if (!forced) {
      return {
        ...base,
        order: [],
        next: null,
        reason: `no lane "${describeId(opts.lane)}" in the ladder (have: ${ladder.map((l) => l.id).join(", ")})`,
      };
    }
    // An explicit override is honoured even when the rung is cooling down, parked, or unreachable
    // from this host: the host asked for THIS target, and second-guessing it would defeat the
    // point of an override. The `unreachable` field still travels on the lane, so the caller can
    // see what it overrode rather than discovering it at spawn time.
    //
    // ⚠ `order` is that ONE lane, so a walking caller honours the override too: an override means
    // "use this target", and walking past it to a lane the caller did not ask for would defeat the
    // override just as silently as ignoring it.
    return {
      ...base,
      order: [forced.id],
      next: forced,
      reason:
        forced.unreachable !== undefined
          ? `lane "${forced.id}" selected by host override (${forced.unreachable})`
          : forced.state === "ready"
            ? `lane "${forced.id}" selected by host override`
            : `lane "${forced.id}" selected by host override (currently ${forced.state})`,
    };
  }

  let pool = ladder;
  if (opts.after !== undefined) {
    const idx = ladder.findIndex((l) => l.id === opts.after);
    if (idx < 0) {
      return {
        ...base,
        order: [],
        next: null,
        reason: `no lane "${describeId(opts.after)}" in the ladder (have: ${ladder.map((l) => l.id).join(", ")})`,
      };
    }
    pool = ladder.slice(idx + 1);
  }

  // An unreachable rung is skipped like an exhausted one. Auto-selecting a lane already known not
  // to work for this host is the exact defect this is here to fix — the host would spend a turn
  // discovering it, and in the Desktop case would discover it as a silent no-op rather than an
  // error. An explicit `?lane=` override above still reaches it.
  const usable = pool.filter((l) => l.state === "ready" && l.unreachable === undefined && l.notServable === undefined);
  const ranked = rankSelectable(usable);
  const next = ranked[0] ?? null;
  if (!next) {
    const blocked = pool.filter((l) => l.unreachable !== undefined).length;
    const why =
      opts.after !== undefined
        ? `no ready lane after "${describeId(opts.after)}" — the ladder is exhausted`
        : "every lane is exhausted or disabled";
    return {
      ...base,
      order: [],
      next: null,
      reason: blocked > 0 ? `${why} (${blocked} unreachable from this host)` : why,
    };
  }

  const why = selectionReason(next, opts.after, usable);
  return { ...base, order: ranked.map((l) => l.id), next, reason: why };
}

/**
 * How long a dispatch walk gives ONE lane to answer, derived from that lane's own recorded runs
 * on THIS tier's ladder.
 *
 * ⚠ Tier-keyed since 2026-09-09 (backlog item 4): the stats window beside it is keyed by
 * (lane, tier), and the budget reads that window — one tier's runs never set another tier's
 * kill budget. See the fallback comment in the body for how legacy tier-less rows are honoured.
 *
 * ⚠ This is the owner's request-path mechanism — a threshold read off what THIS endpoint has
 * actually done — applied to lanes (owner direction 2026-09-08). The METHOD carries over; none of
 * the request path's NUMBERS do, and must not: `latency-demotion.ts`'s 250 ms/token and 30 s
 * ceiling are calibrated for single completions, and a lane legitimately runs an agent loop for
 * minutes. Measured on this machine the same day, a flat 90 s budget sat BELOW the median run of
 * two of the three working lanes and below the free pool's median by a factor of six.
 *
 * ⚠ The quantile defaults to 0.8, not the 0.95 the request path uses, and the data says why: at
 * p90 and p95 the slowest lane's figure IS its own configured timeout, so a budget there could
 * never fire for the lane that most needs bounding. p80 is the highest point still carrying
 * information for every lane measured (165 s, 224 s, 1383 s against timeouts of 1800 s).
 *
 * ⚠ Too little history means the FLAT budget, never a quantile over two samples. Unmeasured is "no
 * opinion", never "slow" — the same asymmetry `latency-demotion.ts` states, and for the same
 * reason: a brand-new lane must not inherit a ceiling drawn from its single unluckiest run.
 *
 * ⚠ The TOKEN-normalised half of the request-path ladder is deliberately absent. A walk budget must
 * fire BEFORE any answer arrives, so there is no output token to normalise by — which is also why
 * `hedge-trigger.ts`'s own per-token rung is documented inert on the hedge path. Token
 * normalisation only has a home in a post-commit policy, which does not exist here.
 */
function attemptBudget(
  cfg: Config,
  laneId: string,
  tier: string | null,
): DispatchLane["attemptBudget"] {
  const walk = cfg.routing.dispatchWalk;
  if (!walk || !walk.enabled) return undefined;
  // ⚠ The budget is derived ONLY from runs on the ladder it will be used on. When the tier's
  // own window holds fewer than `attemptMinSamples` samples it FALLS BACK to the tier-less
  // window — the legacy rows, which predate tiering and belong to no ladder — and reports the
  // basis from whichever window it used. It never merges the two windows into one quantile:
  // that would attribute one tier's runs to another, the defect this closes. The fallback is
  // the legacy file's whole purpose, and it expires on its own as tier-keyed samples
  // accumulate past the floor.
  const tiered = laneStatsFor(cfg, laneId, tier)?.wallClockMs ?? [];
  if (tiered.length >= walk.attemptMinSamples) {
    return budgetFromSamples(tiered, walk);
  }
  if (tier === null) {
    return budgetFromSamples(tiered, walk);
  }
  const legacy = laneStatsFor(cfg, laneId, null)?.wallClockMs ?? [];
  return budgetFromSamples(legacy, walk);
}

function budgetFromSamples(
  samples: readonly number[],
  walk: { attemptMs: number; attemptMinSamples: number; attemptQuantile: number },
): DispatchLane["attemptBudget"] {
  if (samples.length < walk.attemptMinSamples) {
    return { ms: walk.attemptMs, basis: "floor", samples: samples.length };
  }
  const quantile = quantileWallClockMs(samples, walk.attemptQuantile);
  // A window that cleared the sample floor cannot yield null, but a null here must never become a
  // zero budget — that would abandon every lane instantly. Fall to the flat figure, the weaker claim.
  if (quantile === null) return { ms: walk.attemptMs, basis: "floor", samples: samples.length };
  const own = Math.round(quantile);
  // ⚠ Never BELOW the flat budget. The floor is what the operator declared a lane is always worth
  // waiting for; a lane whose history happens to be fast must not be given less than that, or a
  // single quick run would make the relay impatient with it forever.
  // ⚠⚠ But the LABEL must follow the number, not the clamp. When the floor wins, the figure served
  // is the operator's configured default and calling it `history` reports a configuration value as
  // a measurement of this lane — which is what it did until 2026-09-08. The lane's own quantile
  // travels beside it, because that is the figure the operator actually wants.
  if (own < walk.attemptMs) {
    return { ms: walk.attemptMs, basis: "clamped", samples: samples.length, quantileMs: own };
  }
  return { ms: own, basis: "history", samples: samples.length };
}

/**
 * Attach each lane's live pin and demotion, when it has one and is selectable.
 *
 * ⚠ The `state === "ready"` guard is the "a pin promotes, never resurrects" rule made mechanical.
 * A pin rendered on an exhausted lane would read as a recommendation to use it, on the one surface
 * a host reads to decide; and a demotion on a lane nothing can select says nothing at all. Neither
 * memory is DELETED by the guard — both stay in the store and reappear the moment the lane is
 * selectable again, because unavailability disproves neither.
 *
 * ⚠⚠ **It reads nothing at all when the walk is OFF**, and that gate was MISSING until 2026-09-08.
 * `DispatchWalkSettings`'s own field doc promises that `dispatchWalk: false` "restores the pre-walk
 * behaviour exactly: one lane per call, no memory" — and `recordLaneAffinity` does honour it, so no
 * NEW memory is written. But rows written while the walk was ON are still restored from
 * `lane-affinity.json` at startup, and this function annotated them regardless, so `rankSelectable`
 * kept reordering the ladder and `next` kept naming a pinned lane. An operator who turned the walk
 * off to revert got the old behaviour only once every surviving memory had lapsed — up to the
 * six-hour `MAX_AFFINITY_MS` ceiling. Gating HERE rather than at the call site makes
 * `rankSelectable` a no-op by construction: with no lane carrying either field, every lane ranks 1
 * and the sort is stable, so the configured order is returned unchanged. Found by an adversarial
 * review; pinned in `test/dispatch-lane-walk.test.ts`.
 */
function annotateAffinity(cfg: Config, ladder: DispatchLane[], tier: string | null, now: number): void {
  const walk = cfg.routing.dispatchWalk;
  if (!walk || !walk.enabled) return;
  const render = (row: LaneAffinityRow): { until: string; reason: string } => ({
    until: new Date(row.until).toISOString(),
    reason: row.reason,
  });
  for (const lane of ladder) {
    if (lane.state !== "ready" || lane.unreachable !== undefined || lane.notServable !== undefined) continue;
    const pin = lanePin(cfg, tier, lane.id, now);
    if (pin) lane.pinned = render(pin);
    const demotion = laneDemotion(cfg, tier, lane.id, now);
    if (demotion) lane.demoted = render(demotion);
  }
}

/**
 * Order the selectable lanes: pinned first, then undemoted, then demoted. Within a band the
 * configured ladder order is preserved, because `Array.prototype.sort` is stable and the input is
 * already in that order — the operator's own ordering remains the tie-break, exactly as pool
 * ranking keeps config order on a tie.
 *
 * ⚠ A lane carrying BOTH memories ranks as PINNED. That state is reachable — a lane can answer,
 * be pinned, then miss a budget on a later walk — and the pin is the more recent evidence in the
 * only case that matters, because a demotion RETRACTS the pin when it is recorded and a success
 * retracts the demotion (`clearLaneAffinity`). Ranking it as demoted instead would let one missed
 * budget outrank a fresh success.
 */
function rankSelectable(usable: readonly DispatchLane[]): DispatchLane[] {
  const rank = (lane: DispatchLane): number => (lane.pinned ? 0 : lane.demoted ? 2 : 1);
  return [...usable].sort((a, b) => rank(a) - rank(b));
}

/**
 * Why `next` is what it is, in one line the ladder view and the CLI both print.
 *
 * ⚠⚠ **A reason string is a CLAIM about the ordering code, and two of these were false until
 * 2026-09-08** — found by an adversarial review, reproduced against the built binary, and pinned
 * in `test/dispatch-lane-walk.test.ts`. Both said something `rankSelectable` does not do:
 *
 * 1. `"the least recently demoted"` — `rankSelectable` consults NO timestamp. Its comparator is a
 *    stable sort on a three-valued band rank, so the lane named is simply the FIRST IN LADDER ORDER
 *    among the demoted ones. Demoting `beta` and then `alpha` named `alpha`, i.e. the MOST recently
 *    demoted, while claiming the opposite.
 * 2. `"N ahead of it unavailable"` — with demotion reordering, a lane ahead in ladder order can be
 *    perfectly READY and merely demoted. It reported available lanes as unavailable.
 *
 * The counts are therefore taken from the selectable set rather than from `position` arithmetic,
 * and the two populations are named separately, because they call for opposite responses: an
 * unavailable lane needs attention, a demoted one is the walk working as intended.
 */
function selectionReason(next: DispatchLane, after: string | undefined, usable: readonly DispatchLane[]): string {
  if (next.pinned) return `lane "${next.id}" is pinned (${next.pinned.reason})`;
  if (after !== undefined) return `first ready lane after "${describeId(after)}"`;
  if (next.demoted) return `every ready lane is demoted; "${next.id}" is first among them in the ladder`;
  if (next.position === 1) return "first lane in the ladder";
  // Ahead of `next` in LADDER order, split by why they did not lead. `next` is undemoted and
  // unpinned here, so any selectable lane ahead of it must be demoted — a pinned one would be
  // `next` itself.
  const aheadDemoted = usable.filter((l) => l.position < next.position).length;
  const aheadUnavailable = next.position - 1 - aheadDemoted;
  const parts: string[] = [];
  if (aheadUnavailable > 0) parts.push(`${aheadUnavailable} ahead of it unavailable`);
  if (aheadDemoted > 0) parts.push(`${aheadDemoted} ahead of it ready but demoted`);
  return parts.length === 0 ? "first lane in the ladder" : `first undemoted lane (${parts.join(", ")})`;
}

export const AUTO_TIERS = ["low", "medium", "high", "xhigh"] as const;
export type AutoTier = (typeof AUTO_TIERS)[number];

export function normalizeAutoTier(tier?: string | null): string {
  if (typeof tier !== "string") return "medium";
  const lower = tier.trim().toLowerCase();
  return (AUTO_TIERS as readonly string[]).includes(lower) ? lower : "medium";
}

export interface AutoSpecResolution {
  spec: string;
  tier: string;
}

/**
 * Resolves the `auto` model name to a concrete spec and tier:
 * The spec of the first READY rung of kind `relay` in the dispatch ladder for the given tier.
 * The tier comes from the `x-llm-relay-tier` request header (low | medium | high | xhigh), else `medium`.
 * If the ladder for that tier has no ready relay rung, or no ladder is configured,
 * `auto` falls back to `routing.default`.
 */
export function resolveAutoSpec(
  cfg: Config,
  rawTier?: string | null,
  now: number = Date.now(),
): AutoSpecResolution {
  const tier = normalizeAutoTier(rawTier);
  const selected = selectLadder(cfg, tier);
  for (const rung of selected.rungs) {
    if (rung.kind === "relay" && rung.spec && rung.enabled !== false && cooldownUntil(cfg, rung, now) === null) {
      return { spec: rung.spec, tier };
    }
  }
  const defaultSpec = Array.isArray(cfg.routing.default)
    ? cfg.routing.default[0]!
    : cfg.routing.default;
  return { spec: defaultSpec, tier };
}

