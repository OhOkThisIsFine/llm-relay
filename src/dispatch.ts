import { expandPoolSpecs, offloadRule, splitSpec, POOL_PREFIX, type Config, type LadderRung } from "./config.js";
import type { HostRoutingState } from "./host-routing.js";
import type { ContextWindowSource, ResolvedContextWindow } from "./metadata.js";
import { unsupportedArgValues, verifyModel, type LaneManifest } from "./lane-manifest.js";

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
 * it NEVER overwrites a cooldown this process already learned — the `restoreCooldowns` contract.
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
    map.set(row.key, Math.min(row.until, now + MAX_EXHAUSTED_MS));
    restored++;
  }
  if (restored > 0) notifyExhaustion(cfg);
  return restored;
}

/** Mark one raw bucket key exhausted until an absolute time — the probe path's write. */
export function markExhaustedKey(cfg: Config, key: string, untilMs: number, now: number = Date.now()): void {
  if (typeof key !== "string" || key.length === 0) return;
  if (typeof untilMs !== "number" || !Number.isFinite(untilMs)) return;
  cooldownsFor(cfg).set(key, Math.min(Math.max(now, untilMs), now + MAX_EXHAUSTED_MS));
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

function toLane(
  rung: LadderRung,
  position: number,
  cfg: Config,
  opts: DispatchOptions,
  now: number,
  client: string,
  platform: NodeJS.Platform,
  host: HostRoutingState,
  entrypoint: string | undefined,
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
    const bypassed = host === "bypassed";
    if (!bypassed) {
      lane.requiresDirective = !offloadRule(cfg, client).enabled;
    } else if (!reachableWithoutRelay(rung.spec, cfg)) {
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
        lane.unreachable =
          `${who} does not route its traffic through this relay, so a subagent cannot reach ` +
          `"${rung.spec}" — configure routing.cliLane to reach it by shelling out`;
      }
    }
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
): DispatchView {
  const opts = normalizeOptions(rawOpts ?? {});
  const client = opts.client ?? "default";
  const host = opts.host ?? "unknown";
  const now = Date.now();
  const selected = selectLadder(cfg, opts.tier);
  const rungs = selected.rungs;
  const ladder = rungs.map((r, i) => toLane(r, i + 1, cfg, opts, now, client, platform, host, opts.entrypoint));
  const offload = offloadRule(cfg, client).enabled;
  const base = { tier: selected.tier, offload, client, host, ladder };

  if (selected.missing) {
    return {
      ...base,
      next: null,
      reason: `no dispatch tier "${describeId(selected.missing)}" configured (have: ${Object.keys(cfg.routing.ladders ?? {}).join(", ")})`,
    };
  }

  if (ladder.length === 0) {
    return { ...base, next: null, reason: "no routing.ladder configured — dispatch order is the host's to choose" };
  }

  if (opts.lane !== undefined) {
    const forced = ladder.find((l) => l.id === opts.lane);
    if (!forced) {
      return {
        ...base,
        next: null,
        reason: `no lane "${describeId(opts.lane)}" in the ladder (have: ${ladder.map((l) => l.id).join(", ")})`,
      };
    }
    // An explicit override is honoured even when the rung is cooling down, parked, or unreachable
    // from this host: the host asked for THIS target, and second-guessing it would defeat the
    // point of an override. The `unreachable` field still travels on the lane, so the caller can
    // see what it overrode rather than discovering it at spawn time.
    return {
      ...base,
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
  const next = usable[0] ?? null;
  if (!next) {
    const blocked = pool.filter((l) => l.unreachable !== undefined).length;
    const why =
      opts.after !== undefined
        ? `no ready lane after "${describeId(opts.after)}" — the ladder is exhausted`
        : "every lane is exhausted or disabled";
    return {
      ...base,
      next: null,
      reason: blocked > 0 ? `${why} (${blocked} unreachable from this host)` : why,
    };
  }

  const why =
    opts.after !== undefined
      ? `first ready lane after "${describeId(opts.after)}"`
      : next.position === 1
        ? "first lane in the ladder"
        : `first ready lane (${next.position - 1} ahead of it unavailable)`;
  return { ...base, next, reason: why };
}
