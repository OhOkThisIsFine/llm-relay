import type { Config, LadderRung } from "./config.js";

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

export type LaneState = "ready" | "exhausted" | "disabled";

export interface DispatchLane {
  id: string;
  kind: "cli" | "relay";
  /** 1-based position in the configured ladder — stable regardless of availability. */
  position: number;
  state: LaneState;
  /** Shared quota bucket, when the rung declares one. Rungs sharing a bucket go down together. */
  quota?: string;
  note?: string;
  /** When an exhausted rung becomes eligible again (ISO 8601). */
  readyAt?: string;
  /** cli rungs: exactly what to run. `args` already has the task substituted when one was given. */
  invoke?: { command: string; args: string[] };
  /** relay rungs: the spec to address (`pool/<name>`, `<provider>/<model>`, …). */
  spec?: string;
  /**
   * relay rungs only: with subagent offload OFF, a bare subagent will NOT route to this spec —
   * the host must put `@relay: <spec>` in the subagent's prompt (the per-call opt-in) or turn
   * the switch on. Surfaced so a host never silently spends primary quota believing it offloaded.
   */
  requiresDirective?: boolean;
}

export interface DispatchView {
  /** State of the subagent-offload switch, which governs relay rungs. */
  offload: boolean;
  ladder: DispatchLane[];
  /** The lane the host should use now, or null when every rung is spent or none configured. */
  next: DispatchLane | null;
  /** Why `next` is what it is — including why it is null. */
  reason: string;
}

export interface DispatchOptions {
  /** Substituted for the `{task}` placeholder in a cli rung's args. */
  task?: string;
  /** Host override: return THIS lane as `next`, whatever the order says. */
  lane?: string;
  /** Walk the ladder: pick the first ready rung strictly after this one. */
  after?: string;
}

/** rung id or quota bucket → epoch ms at which it is eligible again. */
const exhausted = new Map<string, number>();

function cooldownKey(rung: LadderRung): string {
  return rung.quota ? `quota:${rung.quota}` : `rung:${rung.id}`;
}

function cooldownUntil(rung: LadderRung, now: number): number | null {
  const until = exhausted.get(cooldownKey(rung));
  if (until === undefined) return null;
  if (until <= now) {
    exhausted.delete(cooldownKey(rung));
    return null;
  }
  return until;
}

/**
 * Report a rung spent (quota gone, rate-limited, CLI missing). Rungs sharing a `quota` bucket
 * are cooled down together — that is the whole point of the bucket, since one CLI can meter two
 * model families against two independent balances and only one of them may be gone.
 *
 * Unknown id is not an error: a host walking a ladder it half-remembers should not get a 500.
 */
export function markExhausted(cfg: Config, id: string, ttlMs = DEFAULT_EXHAUSTED_MS): boolean {
  const rung = (cfg.routing.ladder ?? []).find((r) => r.id === id);
  if (!rung) return false;
  exhausted.set(cooldownKey(rung), Date.now() + Math.max(0, ttlMs));
  return true;
}

/** Clear one rung's cooldown, or every cooldown when no id is given. */
export function clearExhausted(cfg: Config, id?: string): void {
  if (id === undefined) {
    exhausted.clear();
    return;
  }
  const rung = (cfg.routing.ladder ?? []).find((r) => r.id === id);
  if (rung) exhausted.delete(cooldownKey(rung));
}

/** The placeholder a cli rung's args must contain; substituted with the task text. */
export const TASK_TOKEN = "{task}";

function toLane(rung: LadderRung, position: number, cfg: Config, opts: DispatchOptions, now: number): DispatchLane {
  const until = cooldownUntil(rung, now);
  const state: LaneState = !rung.enabled ? "disabled" : until !== null ? "exhausted" : "ready";

  const lane: DispatchLane = { id: rung.id, kind: rung.kind, position, state };
  if (rung.quota) lane.quota = rung.quota;
  if (rung.note) lane.note = rung.note;
  if (until !== null) lane.readyAt = new Date(until).toISOString();

  if (rung.kind === "cli" && rung.command && rung.args) {
    lane.invoke = {
      command: rung.command,
      // No task given => leave the placeholder visible, so the caller can see where it goes
      // rather than receiving a command that silently asks the agent to do nothing.
      args: opts.task === undefined ? [...rung.args] : rung.args.map((a) => a.split(TASK_TOKEN).join(opts.task!)),
    };
  }
  if (rung.kind === "relay" && rung.spec) {
    lane.spec = rung.spec;
    lane.requiresDirective = cfg.routing.offload !== true;
  }
  return lane;
}

export function buildDispatch(cfg: Config, opts: DispatchOptions = {}): DispatchView {
  const now = Date.now();
  const rungs = cfg.routing.ladder ?? [];
  const ladder = rungs.map((r, i) => toLane(r, i + 1, cfg, opts, now));
  const offload = cfg.routing.offload === true;

  if (ladder.length === 0) {
    return {
      offload,
      ladder,
      next: null,
      reason: "no routing.ladder configured — dispatch order is the host's to choose",
    };
  }

  if (opts.lane !== undefined) {
    const forced = ladder.find((l) => l.id === opts.lane);
    if (!forced) {
      return {
        offload,
        ladder,
        next: null,
        reason: `no lane "${opts.lane}" in the ladder (have: ${ladder.map((l) => l.id).join(", ")})`,
      };
    }
    // An explicit override is honoured even when the rung is cooling down or parked: the host
    // asked for THIS target, and second-guessing it would defeat the point of an override.
    return {
      offload,
      ladder,
      next: forced,
      reason:
        forced.state === "ready"
          ? `lane "${forced.id}" selected by host override`
          : `lane "${forced.id}" selected by host override (currently ${forced.state})`,
    };
  }

  let pool = ladder;
  if (opts.after !== undefined) {
    const idx = ladder.findIndex((l) => l.id === opts.after);
    if (idx < 0) {
      return {
        offload,
        ladder,
        next: null,
        reason: `no lane "${opts.after}" in the ladder (have: ${ladder.map((l) => l.id).join(", ")})`,
      };
    }
    pool = ladder.slice(idx + 1);
  }

  const next = pool.find((l) => l.state === "ready") ?? null;
  if (!next) {
    return {
      offload,
      ladder,
      next: null,
      reason:
        opts.after !== undefined
          ? `no ready lane after "${opts.after}" — the ladder is exhausted`
          : "every lane is exhausted or disabled",
    };
  }

  const why =
    opts.after !== undefined
      ? `first ready lane after "${opts.after}"`
      : next.position === 1
        ? "first lane in the ladder"
        : `first ready lane (${next.position - 1} ahead of it unavailable)`;
  return { offload, ladder, next, reason: why };
}
