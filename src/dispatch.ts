import { offloadRule, type Config, type LadderRung } from "./config.js";

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
   */
  requiresDirective?: boolean;
}

export interface DispatchView {
  /** Selected tier-specific ladder, or null when using the legacy single ladder. */
  tier: string | null;
  /** State of the selected client's offload rule, which governs relay-rung hints. */
  offload: boolean;
  /** Originating harness whose rule controls relay-rung directive hints. */
  client: string;
  ladder: DispatchLane[];
  /** The lane the host should use now, or null when every rung is spent or none configured. */
  next: DispatchLane | null;
  /** Why `next` is what it is — including why it is null. */
  reason: string;
}

export interface DispatchOptions {
  /** Originating harness (`claude`, `codex`, or a future configured client). */
  client?: string;
  /** Select a named tier-specific ladder (for example low, medium, high, or xhigh). */
  tier?: string;
  /** Substituted for the `{task}` placeholder in a cli rung's args. */
  task?: string;
  /** Host override: return THIS lane as `next`, whatever the order says. */
  lane?: string;
  /** Walk the ladder: pick the first ready rung strictly after this one. */
  after?: string;
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
  cooldownsFor(cfg).set(cooldownKey(rung), Date.now() + normalizeTtl(ttlMs));
  return true;
}

/** Clear one rung's cooldown, or every cooldown for this config when no id is given. */
export function clearExhausted(cfg: Config, id?: string, tier?: string): void {
  if (id === undefined) {
    cooldownsFor(cfg).clear();
    return;
  }
  if (typeof id !== "string") return;
  const rung = selectLadder(cfg, tier).rungs.find((r) => r.id === id);
  if (rung) cooldownsFor(cfg).delete(cooldownKey(rung));
}

/** The placeholder a cli rung's args must contain; substituted with the task text. */
export const TASK_TOKEN = "{task}";

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

/** C0 + C1 control characters, including ESC — never legal in a rung id, and the ANSI carrier. */
const CONTROL_CHARS = /[\u0000-\u001f\u007f-\u009f]/g;

/**
 * Render a caller-supplied id for a `reason` string. The reason is reflected back verbatim in the
 * JSON response AND printed to a terminal by `llm-relay dispatch`, so echoing raw caller input let
 * a `?lane=` carrying ESC sequences rewrite the operator's terminal, and an arbitrarily long one
 * bloat a response about a lane that does not exist. Control characters go, and the echo is capped
 * — enough to recognise your own typo, not a channel.
 */
function describeId(id: string): string {
  const clean = id.replace(CONTROL_CHARS, "\uFFFD");
  return clean.length > MAX_ECHOED_ID ? `${clean.slice(0, MAX_ECHOED_ID)}\u2026` : clean;
}

function toLane(
  rung: LadderRung,
  position: number,
  cfg: Config,
  opts: DispatchOptions,
  now: number,
  client: string,
  platform: NodeJS.Platform,
): DispatchLane {
  const until = cooldownUntil(cfg, rung, now);
  const state: LaneState = !rung.enabled ? "disabled" : until !== null ? "exhausted" : "ready";

  const lane: DispatchLane = { id: rung.id, kind: rung.kind, position, state };
  if (rung.quota) lane.quota = rung.quota;
  if (rung.note) lane.note = rung.note;
  if (until !== null) lane.readyAt = new Date(until).toISOString();

  if (rung.kind === "cli" && rung.command && rung.args) {
    lane.invoke = {
      command: normalizeCliCommand(rung.command, platform),
      // No task given => leave the placeholder visible, so the caller can see where it goes
      // rather than receiving a command that silently asks the agent to do nothing.
      args: opts.task === undefined ? [...rung.args] : rung.args.map((a) => a.split(TASK_TOKEN).join(opts.task!)),
    };
    if (rung.env) lane.invoke.env = { ...rung.env };
  }
  if (rung.kind === "relay" && rung.spec) {
    lane.spec = rung.spec;
    lane.requiresDirective = !offloadRule(cfg, client).enabled;
  }
  return lane;
}

export function buildDispatch(
  cfg: Config,
  rawOpts: DispatchOptions = {},
  platform: NodeJS.Platform = process.platform,
): DispatchView {
  const opts = normalizeOptions(rawOpts ?? {});
  const client = opts.client ?? "default";
  const now = Date.now();
  const selected = selectLadder(cfg, opts.tier);
  const rungs = selected.rungs;
  const ladder = rungs.map((r, i) => toLane(r, i + 1, cfg, opts, now, client, platform));
  const offload = offloadRule(cfg, client).enabled;

  if (selected.missing) {
    return {
      tier: selected.tier,
      offload,
      client,
      ladder,
      next: null,
      reason: `no dispatch tier "${describeId(selected.missing)}" configured (have: ${Object.keys(cfg.routing.ladders ?? {}).join(", ")})`,
    };
  }

  if (ladder.length === 0) {
    return {
      tier: selected.tier,
      offload,
      client,
      ladder,
      next: null,
      reason: "no routing.ladder configured — dispatch order is the host's to choose",
    };
  }

  if (opts.lane !== undefined) {
    const forced = ladder.find((l) => l.id === opts.lane);
    if (!forced) {
      return {
        tier: selected.tier,
        offload,
        client,
        ladder,
        next: null,
        reason: `no lane "${describeId(opts.lane)}" in the ladder (have: ${ladder.map((l) => l.id).join(", ")})`,
      };
    }
    // An explicit override is honoured even when the rung is cooling down or parked: the host
    // asked for THIS target, and second-guessing it would defeat the point of an override.
    return {
      tier: selected.tier,
      offload,
      client,
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
        tier: selected.tier,
        offload,
        client,
        ladder,
        next: null,
        reason: `no lane "${describeId(opts.after)}" in the ladder (have: ${ladder.map((l) => l.id).join(", ")})`,
      };
    }
    pool = ladder.slice(idx + 1);
  }

  const next = pool.find((l) => l.state === "ready") ?? null;
  if (!next) {
    return {
      tier: selected.tier,
      offload,
      client,
      ladder,
      next: null,
      reason:
        opts.after !== undefined
          ? `no ready lane after "${describeId(opts.after)}" — the ladder is exhausted`
          : "every lane is exhausted or disabled",
    };
  }

  const why =
    opts.after !== undefined
      ? `first ready lane after "${describeId(opts.after)}"`
      : next.position === 1
        ? "first lane in the ladder"
        : `first ready lane (${next.position - 1} ahead of it unavailable)`;
  return { tier: selected.tier, offload, client, ladder, next, reason: why };
}
