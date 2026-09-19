import type { IncomingMessage, ServerResponse } from "node:http";
import { AUTO_MODEL, CONFIG_STALENESS_NOTICE, unroutableOffloadClient, type Config, type OffloadScope } from "../config.js";
import type { ModelCatalog } from "../catalog.js";
import type { PingLoop } from "../ping/cadence.js";
import type { MetadataLogger } from "../log.js";
import { buildRegistry } from "../registry.js";
import { buildCandidates } from "../candidates.js";
import { offloadState, setOffload } from "../offload.js";
import { loadLaneManifest } from "../lane-manifest.js";
import { buildDispatch, describeId, findLadderRung, lookupLadderRung, markExhausted, clearExhausted, OUTCOME_DEFAULT_MS, resolveAutoSpec, resolveLaneLauncherPath, specContextWindow, type DispatchOptions, type DispatchOutcome } from "../dispatch.js";
import { parseHostRoutingState } from "../host-routing.js";
import { contextWindowResolver, type ContextWindowSource } from "../metadata.js";
import { snapshotContextWindow } from "../tier-data.js";
import { observedContextLimit } from "../context-limits.js";
import { getTelemetryReport } from "../telemetry.js";
import type { CircuitBreaker } from "../circuit-breaker.js";
import { clearCooldowns } from "../cooldown-clear.js";
import { baseLog } from "../request-log.js";
import { createAccountingRequest, type AccountingRecorder } from "../accounting.js";
import type { FailureKind } from "../dashboard-contract.js";
import {
  laneRoutesThroughRelay,
  laneStatsFor,
  parseTelemetryReport,
  recordLaneRun,
  type DispatchedTelemetryReport,
  type DispatchLaneStatus,
} from "../dispatch-lane-stats.js";
import { laneActivityTag, readLaneActivity } from "../lane-activity.js";
import { clearLaneAffinity, demoteLane, forgetLaneMemory, lanePin, MAX_AFFINITY_MS, pinLane, recordLaneOutlier } from "../lane-affinity.js";

const MAX_TASK_LEN = 4096;

function collectModelAliases(value: unknown, out: Set<string>): void {
  if (typeof value === "string" && value.length > 0) {
    out.add(value);
    return;
  }
  if (Array.isArray(value)) {
    for (const item of value) collectModelAliases(item, out);
    return;
  }
  if (typeof value === "object" && value !== null) {
    for (const item of Object.values(value)) collectModelAliases(item, out);
  }
}

/**
 * How a resolved context window is described to the client, per resolver rung — a total table,
 * so a new `ContextWindowSource` is a compile error here rather than an unlabelled figure.
 */
const CONTEXT_SOURCE_LABEL = {
  observed: "stated by this deployment when it refused an over-length request",
  provider: "published by the serving provider",
  snapshot: "from the synced capability snapshot for this model id",
} as const satisfies Record<ContextWindowSource, string>;

/** OpenAI-compatible model discovery for clients such as local Codex. */
function relayModels(
  cfg: Config,
  h: Pick<AdminHandlers, "catalog">,
): Array<Record<string, unknown>> {
  const ids = new Set<string>();
  collectModelAliases(cfg.routing.default, ids);
  collectModelAliases(cfg.routing.tiers, ids);
  collectModelAliases(cfg.routing.subagents, ids);
  for (const name of Object.keys(cfg.routing.pools ?? {})) ids.add(`pool/${name}`);
  ids.add(AUTO_MODEL);

  // Build the context window resolver once, reusing the same machinery as dispatch.ts
  // `catalog.cachedLimits` never fetches — a cold cache degrades to "no window stated" rather than
  // turning this catalog read into a blocking upstream round-trip.
  const publishedContextWindow = contextWindowResolver(
    (provider, model) => h.catalog.cachedLimits(provider, model)?.contextLength ?? null,
    snapshotContextWindow,
    observedContextLimit,
  );

  return [...ids].sort().map((id) => {
    // Resolve per id: pool/<name> -> the minimum over its resolving members; a provider spec -> the
    // deployment's own three-rung resolution. NOTHING resolves -> the two fields are OMITTED
    // (contract review DR-004, 2026-09-04). Until then an unresolvable id advertised a flat 272000,
    // roughly 1.7-2.1x this machine's measured pool minimums: an invented ceiling on the surface
    // Codex budgets compaction against, contradicting the rule every other limit surface here
    // keeps — an unknown ceiling stays unknown, never a large guess. The description states what
    // was resolved and how, because the wire schema has no provenance field of its own.
    // `auto` is a relay-reserved name, resolved through the ladder at request time; resolving it
    // as a MODEL id would borrow whatever the snapshot holds under that last segment — it did:
    // `openrouter/auto`'s 2,000,000 tokens, measured 2026-09-04 on this machine.
    const isAuto = id === AUTO_MODEL;
    const spec = isAuto ? resolveAutoSpec(cfg).spec : id;
    const isPool = spec.startsWith("pool/");
    const poolResolved = isPool ? specContextWindow(spec, cfg, publishedContextWindow) : null;
    const resolved = isPool ? poolResolved : publishedContextWindow(spec);
    const tokens = resolved !== null && Number.isFinite(resolved.tokens) && resolved.tokens > 0 ? resolved.tokens : null;
    const autoNote = isAuto ? `auto currently resolves to ${spec}; ` : "";
    let contextNote: string;
    if (resolved === null || tokens === null) {
      contextNote = "context window unknown, so it is not advertised";
    } else if (isPool) {
      const unresolved = poolResolved !== null && poolResolved.unknownMembers > 0
        ? ` (${poolResolved.unknownMembers} ${poolResolved.unknownMembers === 1 ? "member" : "members"} unresolved)`
        : "";
      contextNote = `context window ${tokens} tokens, the minimum over the pool's resolving members${unresolved}`;
    } else {
      contextNote = `context window ${tokens} tokens, ${CONTEXT_SOURCE_LABEL[resolved.source]}`;
    }

    return {
      id,
      slug: id,
      display_name: id,
      description: `Model routed through llm-relay; ${autoNote}${contextNote}.`,
      default_reasoning_level: "medium",
      supported_reasoning_levels: [
        { effort: "minimal", description: "Fast responses with minimal reasoning" },
        { effort: "low", description: "Fast responses with lighter reasoning" },
        { effort: "medium", description: "Balances speed and reasoning depth for everyday tasks" },
        { effort: "high", description: "Greater reasoning depth for complex problems" },
        { effort: "xhigh", description: "Extra high reasoning depth for complex problems" },
      ],
      shell_type: "shell_command",
      visibility: "list",
      supported_in_api: true,
      priority: 0,
      additional_speed_tiers: ["fast"],
      service_tiers: [],
      availability_nux: null,
      upgrade: null,
      base_instructions: "",
      model_messages: { instructions_template: "", instructions_variables: null },
      include_skills_usage_instructions: false,
      default_reasoning_summary: "none",
      support_verbosity: true,
      default_verbosity: "medium",
      apply_patch_tool_type: "freeform",
      web_search_tool_type: "text_and_image",
      truncation_policy: { mode: "tokens", limit: 10000 },
      supports_parallel_tool_calls: true,
      supports_image_detail_original: true,
      ...(tokens === null ? {} : { context_window: tokens, max_context_window: tokens }),
      comp_hash: "llm-relay",
      effective_context_window_percent: 95,
      experimental_supported_tools: [],
      input_modalities: ["text", "image"],
      supports_search_tool: true,
      use_responses_lite: false,
      tool_mode: "code_mode_only",
      multi_agent_version: "v2",
      object: "model",
      created: 0,
      owned_by: "llm-relay",
    };
  });
}

export interface AdminHandlers {
  catalog: ModelCatalog;
  pingLoop?: PingLoop;
  logger: MetadataLogger;
  breaker: CircuitBreaker;
  /**
   * The server's accounting ledger when it has one, narrowed to the same in-memory window read
   * the availability producer and G2's cap evaluator take. Optional because a bare programmatic
   * proxy has no store; its `/candidates` then reports no reached caps (unknown ⇒ no refusal).
   * The writer-health half is optional for the same reason: `/telemetry` reports
   * `accounting: null` without a ledger rather than a fabricated state.
   */
  accountingReader?: Pick<import("../accounting-store.js").AccountingStore, "usedInWindow"> &
    Partial<Pick<import("../accounting-store.js").AccountingStore, "writerHealth">>;
  /**
   * The server's accounting ledger writer, narrowed to the recorder the request path writes
   * through. Required (unlike the reader): `POST /dispatch/telemetry` records the estimated
   * dispatch envelope for `cli` lanes, and a bare programmatic proxy without a store passes
   * the shared no-op recorder — the same default `createProxy` uses.
   */
  accountingRecorder: AccountingRecorder;
  /** Optional shutdown callback — called by POST /stop after responding 202. A bare programmatic proxy with no onStop answers 503. */
  onStop?: () => void;
  /** True the first time GET /telemetry observes the loaded config changed on disk, false on
   *  every call after — so the daemon logs the fact exactly once (see config.ts `configStaleness`). */
  claimConfigStalenessLogOnce: () => boolean;
}

function failClosed(res: ServerResponse, status: number, message: string): void {
  res.writeHead(status, { "content-type": "application/json" });
  res.end(JSON.stringify({ error: { type: "error", message } }));
}

/**
 * `GET /dispatch/activity?tag=` — a dispatch lane's live traffic (`lane-activity.ts`). The MCP
 * server asks it to decide whether a lane is idle. No record is `activity: null`, which the MCP
 * server reads as no signal, never as idle.
 */
function answerDispatchActivity(
  method: string | undefined,
  path: string,
  ok: (body: unknown) => true,
  bad: (status: number, message: string) => true,
): true {
  if (method !== "GET") return bad(404, `${method} /dispatch/activity is not a route — GET it with ?tag=`);
  const tag = laneActivityTag(pickQuery(path, "tag"));
  if (tag === null) return bad(400, `GET /dispatch/activity needs a valid tag`);
  const activity = readLaneActivity(tag);
  return ok({
    tag,
    activity:
      activity === null
        ? null
        : {
            inFlight: activity.inFlight,
            requests: activity.requests,
            lastActivityAt: new Date(activity.lastActivityAt).toISOString(),
          },
  });
}

function pickQuery(url: string, param: string): string | undefined {
  const qIdx = url.indexOf("?");
  if (qIdx === -1) return undefined;
  const search = new URLSearchParams(url.slice(qIdx + 1));
  return search.get(param) ?? undefined;
}

/**
 * The failure kind a lane's terminal status completes as in the accounting ledger — a total
 * table, so a new `DispatchLaneStatus` is a compile error here rather than a silent guess
 * (the closed-union gotcha in CLAUDE.md). `completed` carries none (a success cannot carry a
 * failure kind); `timed_out` is the vocabulary's own `timeout` member; `failed` is `unknown`
 * because the daemon sees only an exit code — claiming `auth_error`, `rate_limit`,
 * `provider_error`, `aborted` or `protocol` for a subprocess it never observes would label a
 * guess as a measurement, and the fallback must resolve to the WEAKER claim.
 */
const TELEMETRY_FAILURE_KIND = {
  completed: null,
  failed: "unknown",
  timed_out: "timeout",
  // ⚠ `aborted`, NOT `timeout`. The lane did not exceed its own ceiling — the relay's dispatch
  // walk stopped it because it had not answered inside the budget the walk gave it, and started
  // the next lane instead. `aborted` is the vocabulary's word for "the relay ended this attempt",
  // and it is the honest one: reporting a 90-second walk budget as the lane's own 35-minute
  // timeout would label a routing decision as a lane failure.
  abandoned: "aborted",
} as const satisfies Record<DispatchLaneStatus, FailureKind | null>;

/**
 * Whether one settled lane attempt PINS its lane or DEMOTES it — a total table, so a new
 * `DispatchLaneStatus` is a compile error here rather than a silent guess (the closed-union
 * gotcha in CLAUDE.md).
 *
 * ⚠ One rule, deliberately: **an attempt that produced an answer pins the lane; any attempt that
 * did not, demotes it.** The narrower alternative — demote only on `abandoned` and `timed_out`,
 * because a `failed` lane at least produced something — was considered and rejected. It reads well
 * until you meet the measured case: a lane that returns a lone `#` is `failed` (empty output), and
 * that is exactly a lane not answering. Splitting the rule would also put the reason for a failure
 * on the wire, widening a channel that carries counts and lengths only.
 *
 * The cost of the simple rule is stated rather than hidden: a lane that fails for reasons specific
 * to ONE task is ordered behind its peers for the demotion window. That cost is bounded three ways
 * — it only reorders, it lapses on its own, and the lane's next success retracts it.
 */
const LANE_AFFINITY_EFFECT = {
  completed: "pin",
  failed: "demote",
  timed_out: "demote",
  abandoned: "demote",
} as const satisfies Record<DispatchLaneStatus, "pin" | "demote">;

/**
 * Update the daemon's routing memory from one lane report — "the MCP child reports, the daemon
 * records", the same split the telemetry lap already established.
 *
 * ⚠ The DAEMON owns this memory, and it is the only writer. The MCP child could keep its own copy,
 * but the child restarts often (a filed machine-wide defect records one restart destroying five
 * lanes at once) and it is not the process that builds the ladder view. One writer, one owner.
 *
 * ⚠ RECORDING EITHER MEMORY RETRACTS THE OTHER, in BOTH directions. A success retracts the
 * demotion before recording the pin, and a failure retracts the pin before recording the demotion.
 * That mirrors `target-facts.ts`, where a success clears a cooling condition rather than merely
 * being recorded beside it.
 *
 * ⚠⚠ The second direction was MISSING until 2026-09-08, and its absence defeated the demotion half
 * of the walk in exactly the case the feature exists for. `remember` writes one key per KIND
 * (`${kind}:${tier}:${laneId}`), so `demoteLane` could never touch the pin row on its own; only
 * this call site can. Without it a lane that answered, was pinned, and then hung on a later walk
 * carried BOTH memories — and `rankSelectable` ranks a lane holding both as PINNED, i.e. FIRST. So
 * the lane the walk had just abandoned was tried first again on the very next dispatch, and kept
 * that position for the rest of its pin window (15 minutes by default). Found by an adversarial
 * review, confirmed by reading, and pinned by `test/lane-affinity-retraction.test.ts`.
 *
 * ⚠ `rankSelectable`'s own doc rests on this being true — it ranks a both-memories lane as pinned
 * BECAUSE "the pin is the more recent evidence", which only holds while recording one retracts the
 * other. Its handling of that state stays as a defence for a row restored from an older file.
 */
function recordLaneAffinity(cfg: Config, report: DispatchedTelemetryReport): void {
  const walk = cfg.routing.dispatchWalk;
  // Absent settings mean the walk was never parsed into this config (a hand-built `Config` in a
  // test, a programmatic caller). Record nothing rather than inventing a window: this relay never
  // invents a duration, and a memory with a made-up expiry is exactly that.
  if (!walk || !walk.enabled) return;
  const tier = report.tier ?? null;
  const seconds = Math.round(report.wallClockMs / 1000);
  // Retract first, whichever way this report points: the memory being written is the newer
  // evidence, and leaving the older one beside it is what let an abandoned lane keep a stale pin.
  clearLaneAffinity(cfg, tier, report.laneId);
  if (LANE_AFFINITY_EFFECT[report.status] === "pin") {
    pinLane(cfg, tier, report.laneId, `answered in ${seconds}s`, walk.pinMs);
  } else {
    demoteLane(cfg, tier, report.laneId, `${report.status.replace("_", " ")} after ${seconds}s`, walk.demoteMs);
  }
  // Recent-versus-earlier outlier demotion (backlog item 9), evaluated AFTER the sample lands
  // AND after the pin/demotion above — in that order deliberately. The sample must be in the
  // window before the rule can read it, and the rule must run after the pin: a lane that
  // answered and THEN slowed keeps no stale pin, because the outlier demotion goes through the
  // same retract-then-record entry and the pin it just earned is retracted with it. `false`
  // makes the rule inert; rows still carry their timestamps either way.
  if (walk.outlier !== false) {
    const window = laneStatsFor(cfg, report.laneId, tier)?.wallClockMs ?? [];
    recordLaneOutlier(cfg, tier, report.laneId, window, walk.outlier, {
      minSamples: walk.attemptMinSamples,
      demoteMs: walk.demoteMs,
    });
  }
}

/**
 * Record one `cli`-kind lane run as a single estimated-envelope request: role `serve`,
 * client `mcp-dispatch`, attribution `unknown` (the lane ran on credentials the relay never
 * held), no provider, no credential id, model = the lane's spec (what it claimed to serve)
 * falling back to the lane id. Tokens are the dispatch envelope (`chars/4` estimates), never
 * the lane's provider consumption, which the relay cannot see — so `method: "relay_estimate"`
 * for both. No price port ⇒ spend null (unpriced, never $0).
 */
function recordDispatchLaneAccounting(recorder: AccountingRecorder, report: DispatchedTelemetryReport): void {
  const model = report.spec ?? report.laneId;
  const tokens = {
    estimated: {
      inputTokens: report.estimatedInputTokens,
      outputTokens: report.estimatedOutputTokens,
      inputMethod: "relay_estimate",
      outputMethod: "relay_estimate",
    },
  };
  const req = createAccountingRequest({
    recorder,
    client: "mcp-dispatch",
    attribution: "unknown",
    provider: null,
    model,
    credentialId: null,
  });
  const attempt = req.startAttempt({
    role: "serve",
    attribution: "unknown",
    provider: null,
    model,
    credentialId: null,
  });
  if (report.status === "completed") {
    attempt.complete({ outcome: "success", tokens });
    req.complete({});
    return;
  }
  if (report.status === "failed" || report.status === "timed_out" || report.status === "abandoned") {
    const failureKind = TELEMETRY_FAILURE_KIND[report.status];
    attempt.complete({ outcome: "error", failureKind, tokens });
    req.complete({ outcome: "error", failureKind });
    return;
  }
  const _never: never = report.status;
  throw new Error(`unhandled dispatch lane status: ${String(_never)}`);
}

/** The reason an operator pin carries onto the ladder view. Fixed text, never caller prose. */
export const OPERATOR_PIN_REASON = "pinned by the operator";

/** Longest lane id or tier name `POST /dispatch` will even look up — bounded like every other echo. */
const MAX_PIN_ID_CHARS = 200;

/** The closed set of body keys a `{"pin"|"unpin"}` request may carry (the `/cooldowns/clear` precedent). */
const PIN_BODY_KEYS = new Set(["pin", "unpin", "tier", "ttlMs", "client"]);

type OperatorPinOutcome =
  | { ok: true; tier: string | null; action: "pinned" | "unpinned"; laneId: string; hadPin: boolean }
  | { ok: false; message: string };

/**
 * `POST /dispatch {"pin": "<lane>"}` / `{"unpin": "<lane>"}` — the operator's own hand on the
 * dispatch order, and the dashboard's FIRST write (backlog 2026-09-16). It REUSES the walk's
 * routing memory (`lane-affinity.ts`): a pin promotes the lane to the front of its tier's ladder
 * for `routing.dispatchWalk.pinMs` (or the body's `ttlMs`), exactly as a lane that just answered
 * is promoted, and the next `GET /dispatch` reads it with no restart — the same live-state
 * mutation `POST /dispatch {"exhausted"}` already performs on the same route, behind the same
 * admission (`CONTROL_ROUTES` in `server.ts`: exact `Host`, exact `Origin` when present,
 * `content-type: application/json`, the control token).
 *
 * ⚠ It is NOT a config rewrite. `routing.ladder` on disk is untouched, so the order the operator
 * chose lapses with the pin (six hours at most, `MAX_AFFINITY_MS`) and a restart restores it only
 * through the persisted `lane-affinity.json` while the pin is still live. That is the design: a
 * pin reorders lanes that are ALREADY selectable and never resurrects one (`DispatchLane.pinned`),
 * so this write can neither break "health demotes, never drops" nor promote a lane the config,
 * a cooldown, the manifest or the host says is unavailable. A persistent reorder is
 * `llm-relay config set routing.ladder …`, a validated config edit, and deliberately not this.
 *
 * ⚠ Everything below REFUSES rather than silently doing nothing, because the memory is silent by
 * design and an inert pin would read as a pin that took effect: the walk must be ON (with it off
 * `annotateAffinity` reads no memory at all — the documented byte-for-byte revert); the tier must
 * name a ladder this config declares, and must be absent on a legacy single-ladder config (where
 * `selectLadder` would ignore it); the lane must be a rung ON THAT LADDER — `lookupLadderRung`,
 * the same tier-scoped lookup `markExhausted` uses; the rung must be enabled (a pin cannot
 * resurrect a parked one); and an explicit `ttlMs` must be inside the window this relay will hold
 * a memory for — refused, never clamped, since a silently lowered figure would read as the
 * operator's own number taking effect.
 *
 * ⚠ A pin RETRACTS a live demotion first (`clearLaneAffinity` then `pinLane`) — the walk's own
 * retract-then-record rule in `recordLaneAffinity` — and the walk's next missed budget on that
 * lane retracts the pin in turn: an operator pin is a memory like any other, and the newest
 * evidence wins. `unpin` retracts ONLY the pin (`forgetLaneMemory`), leaving a demotion the walk
 * measured; it is idempotent, reporting whether a live pin existed.
 */
function operatorLanePin(cfg: Config, body: Record<string, unknown>): OperatorPinOutcome {
  const refuse = (message: string): OperatorPinOutcome => ({ ok: false, message: `POST /dispatch: ${message}` });
  const unknownKey = Object.keys(body).find((key) => !PIN_BODY_KEYS.has(key));
  if (unknownKey !== undefined) {
    return refuse(`a pin/unpin request does not accept property "${describeId(unknownKey)}"`);
  }
  if (body.pin !== undefined && body.unpin !== undefined) {
    return refuse(`"pin" and "unpin" are exclusive — send one`);
  }
  const action = body.pin !== undefined ? "pin" : "unpin";
  const rawId = body[action];
  if (typeof rawId !== "string" || rawId.length === 0 || rawId.length > MAX_PIN_ID_CHARS) {
    return refuse(`"${action}" must be a lane id (a non-empty string of at most ${MAX_PIN_ID_CHARS} characters)`);
  }
  const walk = cfg.routing.dispatchWalk;
  if (!walk || !walk.enabled) {
    return refuse(
      `routing.dispatchWalk is off, so a pin would reorder nothing — enable it, or reorder routing.ladder in config.json`,
    );
  }
  if (body.tier !== undefined) {
    if (typeof body.tier !== "string" || body.tier.length === 0 || body.tier.length > MAX_PIN_ID_CHARS) {
      return refuse(`tier must be a non-empty string when provided`);
    }
    if (!cfg.routing.ladders) {
      return refuse(`this config declares a single routing.ladder and no routing.ladders — omit tier`);
    }
  }
  const tier = typeof body.tier === "string" ? body.tier : undefined;
  const lookup = lookupLadderRung(cfg, rawId, tier);
  if (lookup.missingTier !== undefined) {
    return refuse(`no ladder tier "${describeId(lookup.missingTier)}" in routing.ladders`);
  }
  if (!lookup.rung) {
    const where = lookup.tier === null ? "routing.ladder" : `routing.ladders.${describeId(lookup.tier)}`;
    return refuse(`no lane "${describeId(rawId)}" in ${where}`);
  }
  if (!lookup.rung.enabled) {
    return refuse(`lane "${describeId(rawId)}" is disabled in config — a pin promotes only a selectable lane, it never resurrects one`);
  }
  if (action === "unpin") {
    if (body.ttlMs !== undefined) return refuse(`ttlMs applies to "pin" only`);
    const hadPin = forgetLaneMemory(cfg, "pin", lookup.tier, lookup.rung.id);
    return { ok: true, tier: lookup.tier, action: "unpinned", laneId: lookup.rung.id, hadPin };
  }
  let ttlMs = walk.pinMs;
  if (body.ttlMs !== undefined) {
    if (typeof body.ttlMs !== "number" || !Number.isFinite(body.ttlMs) || body.ttlMs <= 0 || body.ttlMs > MAX_AFFINITY_MS) {
      return refuse(`ttlMs must be a number of milliseconds greater than 0 and at most ${MAX_AFFINITY_MS}`);
    }
    ttlMs = Math.floor(body.ttlMs);
  }
  const hadPin = lanePin(cfg, lookup.tier, lookup.rung.id) !== null;
  clearLaneAffinity(cfg, lookup.tier, lookup.rung.id);
  pinLane(cfg, lookup.tier, lookup.rung.id, OPERATOR_PIN_REASON, ttlMs);
  return { ok: true, tier: lookup.tier, action: "pinned", laneId: lookup.rung.id, hadPin };
}

/**
 * Announces what an operator pin/unpin did, on the `POST /dispatch` response that carries the
 * resulting ladder view: `pinned <lane>` / `unpinned <lane>`, plus `(replaced a live pin)` when
 * one existed. A lane id from config, never caller prose.
 */
export const LANE_PIN_HEADER = "x-llm-relay-lane-pin";

type DispatchMutationOutcome =
  | { ok: true; tier: string | undefined; client: string | undefined; pin: string | undefined }
  | { ok: false; message: string };

/**
 * Apply one `POST /dispatch` body to the live config — exhaustion (`exhausted`/`clear`), or the
 * operator pin (`pin`/`unpin`) — and say which tier and client the view should then be built for.
 * The pin shape is decided FIRST, so a body carrying both shapes is refused by the pin's closed
 * key set rather than half-applied.
 */
function applyDispatchMutation(cfg: Config, reqJson: unknown): DispatchMutationOutcome {
  const body = (reqJson ?? {}) as { exhausted?: unknown; clear?: unknown; ttlMs?: unknown; tier?: unknown; client?: unknown; outcome?: unknown; retryAfterMs?: unknown; pin?: unknown; unpin?: unknown };
  if (body.pin !== undefined || body.unpin !== undefined) {
    const pinned = operatorLanePin(cfg, body as Record<string, unknown>);
    if (!pinned.ok) return pinned;
    return {
      ok: true,
      // The view is built for the tier the pin landed on, so the response itself shows it.
      tier: pinned.tier ?? undefined,
      client: typeof body.client === "string" && body.client.length > 0 ? body.client : undefined,
      pin: `${pinned.action} ${pinned.laneId}${pinned.hadPin ? " (replaced a live pin)" : ""}`,
    };
  }
  let outcome: DispatchOutcome | undefined;
  if (body.outcome !== undefined) {
    if (body.outcome !== "rate_limited" && body.outcome !== "quota_exhausted") {
      return { ok: false, message: `POST /dispatch outcome must be "rate_limited" or "quota_exhausted"` };
    }
    outcome = body.outcome;
  }
  // Explicit wins over vendor-reported wins over the outcome's default; markExhausted's own
  // default covers the plain {"exhausted"} report. normalizeTtl clamps whatever arrives.
  const retryAfterMs = typeof body.retryAfterMs === "number" ? body.retryAfterMs : undefined;
  const ttlMs =
    (typeof body.ttlMs === "number" ? body.ttlMs : undefined) ??
    retryAfterMs ??
    (outcome !== undefined ? OUTCOME_DEFAULT_MS[outcome] : undefined);
  const tier = typeof body.tier === "string" ? body.tier : undefined;
  if (body.client !== undefined && (typeof body.client !== "string" || body.client.length === 0)) {
    return { ok: false, message: `POST /dispatch client must be a non-empty string` };
  }
  const client = typeof body.client === "string" ? body.client : undefined;
  if (typeof body.clear === "string") {
    clearExhausted(cfg, body.clear, tier);
  } else if (body.clear === true) {
    clearExhausted(cfg);
  } else if (typeof body.exhausted === "string") {
    if (!markExhausted(cfg, body.exhausted, ttlMs, tier)) {
      return { ok: false, message: `POST /dispatch: no lane "${describeId(body.exhausted)}" in routing.ladder` };
    }
  } else {
    return {
      ok: false,
      message: `POST /dispatch needs {"exhausted":"<lane>"}, {"clear":"<lane>"|true}, {"pin":"<lane>"} or {"unpin":"<lane>"}`,
    };
  }
  return { ok: true, tier, client, pin: undefined };
}

/**
 * Handles control-plane administrative endpoints.
 * Returns true if the request was an admin route and has been handled, false otherwise.
 */
export async function handleAdminRoutes(
  req: IncomingMessage,
  res: ServerResponse,
  pathname: string,
  path: string,
  started: number,
  reqJson: unknown,
  cfg: Config,
  h: AdminHandlers,
): Promise<boolean> {
  const ok = (body: unknown, pretty = false): true => {
    res.writeHead(200, { "content-type": "application/json" });
    res.end(pretty ? JSON.stringify(body, null, 2) : JSON.stringify(body));
    h.logger.write(baseLog(started, path, false, false, 200, "skipped", null));
    return true;
  };
  const bad = (status: number, message: string): true => {
    failClosed(res, status, message);
    h.logger.write(baseLog(started, path, false, false, status, "skipped", null));
    return true;
  };

  if (req.method === "GET" && (pathname === "/v1/models" || pathname === "/models")) {
    const models = relayModels(cfg, { catalog: h.catalog });
    // `data` is the standard OpenAI shape; Codex's custom-provider catalog reader also accepts
    // the same entries under `models`. Returning both keeps the endpoint useful to both clients.
    return ok({ object: "list", data: models, models });
  }

  // Discovery endpoint for an external dispatcher
  if (req.method === "GET" && pathname === "/registry") {
    const view = await buildRegistry(cfg, h.catalog, h.pingLoop ? { pingLoop: h.pingLoop } : {});
    return ok(view);
  }

  if (req.method === "GET" && pathname === "/ping") {
    if (h.pingLoop) {
      await h.pingLoop.tickOnce();
    }
    return ok({ ok: true, pingMode: h.pingLoop?.getMode(), intervalMs: h.pingLoop?.getIntervalMs() });
  }

  if (req.method === "GET" && (pathname === "/health/stats" || pathname === "/health")) {
    const view = await buildRegistry(cfg, h.catalog, h.pingLoop ? { pingLoop: h.pingLoop } : {});
    // `/health` is a coarse liveness read. Keep it provider-oriented even though
    // `/registry` now carries nested credential diagnostics.
    const healthProviders = Object.fromEntries(
      Object.entries(view.providers).map(([name, provider]) => {
        const { credentials: _credentials, ...coarse } = provider;
        return [name, coarse];
      }),
    );
    const stats: Record<string, unknown> = {
      generated_at: view.generated_at,
      ping_mode: h.pingLoop?.getMode(),
      providers: healthProviders,
    };
    return ok(stats);
  }

  if (req.method === "GET" && pathname === "/candidates") {
    const providerFilter = pickQuery(path, "provider");
    const view = await buildCandidates(cfg, {
      catalog: h.catalog,
      breaker: h.breaker,
      ...(h.pingLoop ? { pingLoop: h.pingLoop } : {}),
      ...(providerFilter ? { provider: providerFilter } : {}),
      // The server's own ledger, when it has one — G2's cap verdicts read the SAME in-memory
      // window the request path refuses on. A CLI caller without a store sees no cap rows.
      ...(h.accountingReader ? { accounting: h.accountingReader } : {}),
    });
    return ok(view, true);
  }

  if (req.method === "POST" && pathname === "/cooldowns/clear") {
    if (typeof reqJson !== "object" || reqJson === null || Array.isArray(reqJson)) {
      return bad(400, `POST /cooldowns/clear body must be a JSON object`);
    }
    const body = reqJson as {
      provider?: unknown;
      model?: unknown;
      credential?: unknown;
      kinds?: unknown;
    };
    const allowedKeys = new Set(["provider", "model", "credential", "kinds"]);
    const unknownKey = Object.keys(body).find((key) => !allowedKeys.has(key));
    if (unknownKey !== undefined) {
      return bad(400, `POST /cooldowns/clear does not accept property "${unknownKey}"`);
    }
    if (typeof body.provider !== "string" || body.provider.length === 0) {
      return bad(400, `POST /cooldowns/clear provider must be a non-empty string`);
    }
    if (body.model !== undefined && (typeof body.model !== "string" || body.model.length === 0)) {
      return bad(400, `POST /cooldowns/clear model must be a non-empty string when provided`);
    }
    if (body.credential !== undefined && (typeof body.credential !== "string" || body.credential.length === 0)) {
      return bad(400, `POST /cooldowns/clear credential must be a non-empty string when provided`);
    }
    if (
      body.kinds !== undefined &&
      (!Array.isArray(body.kinds) ||
        body.kinds.length !== 1 ||
        body.kinds[0] !== "credential-fault")
    ) {
      return bad(400, `POST /cooldowns/clear kinds must be exactly ["credential-fault"] when provided`);
    }
    if (!Object.hasOwn(cfg.providers, body.provider)) {
      return bad(400, `POST /cooldowns/clear: no provider "${body.provider}" configured`);
    }
    try {
      return ok(clearCooldowns(h.breaker, {
        provider: body.provider,
        ...(body.model === undefined ? {} : { model: body.model }),
        ...(body.credential === undefined ? {} : { credential: body.credential }),
        ...(body.kinds === undefined ? {} : { kinds: ["credential-fault"] as const }),
      }), true);
    } catch (error) {
      return bad(400, `POST /cooldowns/clear: ${(error as Error).message}`);
    }
  }

  if ((req.method === "GET" || req.method === "POST") && pathname === "/offload") {
    const queryClient = pickQuery(path, "client");
    let state = offloadState(cfg, queryClient);
    if (req.method === "POST") {
      const body = (reqJson ?? {}) as { enabled?: unknown; client?: unknown; scope?: unknown };
      const client = typeof body.client === "string" && body.client.length > 0 ? body.client : queryClient;
      const scope = body.scope === undefined ? undefined : body.scope;
      if (body.client !== undefined && (typeof body.client !== "string" || body.client.length === 0)) {
        return bad(400, `POST /offload client must be a non-empty string`);
      }
      if (scope !== undefined && scope !== "subagents" && scope !== "all") {
        return bad(400, `POST /offload scope must be "subagents" or "all"`);
      }
      if (scope !== undefined && client === undefined) {
        return bad(400, `POST /offload scope requires a client`);
      }
      const want = body.enabled;
      if (typeof want !== "boolean") {
        return bad(400, `POST /offload needs {"enabled": true|false, "client"?: string, "scope"?: "subagents"|"all"}`);
      }
      // A toggle keyed to a name no front door produces would be dead config that silently does
      // nothing — refuse it like an unknown pool. An already-configured key stays togglable (an
      // operator must be able to turn a dead rule OFF); offloadState carries the warning for it.
      if (client !== undefined) {
        const unroutable = unroutableOffloadClient(client, cfg);
        if (unroutable?.fatal) {
          return bad(400, `POST /offload: ${unroutable.message}`);
        }
      }
      state = setOffload(cfg, want, client, scope as OffloadScope | undefined);
    }
    return ok(state, true);
  }

  if ((req.method === "GET" || req.method === "POST") && pathname === "/dispatch") {
    let bodyTier: string | undefined;
    let bodyClient: string | undefined = pickQuery(path, "client");
    if (req.method === "POST") {
      const applied = applyDispatchMutation(cfg, reqJson);
      if (!applied.ok) return bad(400, applied.message);
      bodyTier = applied.tier;
      if (applied.client !== undefined) bodyClient = applied.client;
      if (applied.pin) res.setHeader(LANE_PIN_HEADER, applied.pin);
    }
    const rawTask = pickQuery(path, "task");
    if (typeof rawTask === "string" && rawTask.length > MAX_TASK_LEN) {
      return bad(400, `?task= exceeds ${MAX_TASK_LEN} characters`);
    }
    const taskParam = typeof rawTask === "string" && rawTask.length > 0 ? rawTask : undefined;
    // ⚠ `host` is REPORTED by the caller, never derived here. Whether a session's traffic reaches
    // this relay is a fact about the caller's process environment; this process was launched at
    // logon and its own environment describes nothing about whoever is asking. A bypassing host
    // is by definition one that sends no traffic here, so there is no request to infer it from —
    // only the CLI, running as a child of that session, can see it. `buildDispatch` validates the
    // value and falls back to "unknown" (pre-existing behaviour) for anything it cannot parse.
    const hostParam = parseHostRoutingState(pickQuery(path, "host"));
    const entrypointParam = pickQuery(path, "entrypoint");
    const view = buildDispatch(
      cfg,
      {
        // Cached manifest only — the request path never probes. Absent ⇒ nothing is evicted.
        manifest: loadLaneManifest(),
        ...(taskParam ? { task: taskParam } : {}),
        ...(pickQuery(path, "lane") ? { lane: pickQuery(path, "lane") as string } : {}),
        ...(pickQuery(path, "after") ? { after: pickQuery(path, "after") as string } : {}),
        ...((pickQuery(path, "tier") ?? bodyTier) ? { tier: (pickQuery(path, "tier") ?? bodyTier) as string } : {}),
        ...(bodyClient ? { client: bodyClient } : {}),
        ...(hostParam ? { host: hostParam } : {}),
        ...(entrypointParam ? { entrypoint: entrypointParam } : {}),
        // Passed through raw and validated by `buildDispatch` (`normalizeOptions`): an unknown
        // requester or mode reads as ABSENT — the behaviour before these existed — and an unknown
        // model spec yields no lane and a reason, never a guess.
        ...(pickQuery(path, "requester") ? { requester: pickQuery(path, "requester") as NonNullable<DispatchOptions["requester"]> } : {}),
        ...(pickQuery(path, "mode") ? { mode: pickQuery(path, "mode") as NonNullable<DispatchOptions["mode"]> } : {}),
        ...(pickQuery(path, "model") ? { model: pickQuery(path, "model") as string } : {}),
        // `cachedLimits` never fetches, so a cold cache degrades to "no window stated" rather than
        // turning a dispatch query into a blocking upstream round-trip — same rule as the request
        // -path context guardrail this reads the numbers from.
        publishedContextWindow: contextWindowResolver(
          (provider, model) => h.catalog.cachedLimits(provider, model)?.contextLength ?? null,
          snapshotContextWindow,
          observedContextLimit,
        ),
      },
      process.platform,
      // The DAEMON'S own `/dispatch` view — the surface `mcp/server.ts` actually reaches over HTTP
      // for a running relay (CLAUDE.md: "buildView reaches the daemon over HTTP"). Resolving the
      // launcher path here is what makes a `routing.cliLane` transposition, and any future `cli`
      // ladder rung an operator forgets to wrap by hand, inherit the same windowless-console
      // protection every hand-authored agy/opencode rung already has.
      resolveLaneLauncherPath(),
    );
    view.source = "daemon";
    return ok(view, true);
  }

  if (pathname === "/dispatch/activity") return answerDispatchActivity(req.method, path, ok, bad);

  if ((req.method === "GET" || req.method === "HEAD") && pathname === "/dispatch/telemetry") {
    // POST-only, like `/cooldowns/clear`: an explicit 404 rather than the model-path
    // fall-through, so a mistyped read can never walk candidates or egress upstream.
    // HEAD is matched beside GET — an authenticated HEAD would otherwise skip this guard
    // into model routing (finding N6); nothing is reachable off the exact POST either way.
    return bad(404, `${req.method} /dispatch/telemetry is not a route — POST a telemetry report`);
  }

  if (req.method === "POST" && pathname === "/dispatch/telemetry") {
    const report = parseTelemetryReport(reqJson);
    if (!report) {
      // The reason never echoes the body: a report carries job ids and token counts.
      return bad(400, `POST /dispatch/telemetry body must be a telemetry report`);
    }
    // P1: ladder membership, mirroring the `POST /dispatch` exhaustion branch — any holder
    // of the control token could otherwise mint unlimited distinct lane ids (one bad row is
    // dropped alone, but nothing would bound the NUMBER of lanes). `findLadderRung` is the
    // shared lookup in `dispatch.ts`, not a second copy; the 400 echoes only the bounded,
    // dashboard-safe lane id the parser already validated, like the exhaustion branch.
    const rung = findLadderRung(cfg, report.laneId);
    if (!rung) {
      return bad(400, `POST /dispatch/telemetry: no lane "${report.laneId}" in routing.ladder`);
    }
    recordLaneRun(cfg, report);
    recordLaneAffinity(cfg, report);
    // Owner decision D1: `cli` lanes are metered here because nothing else sees them; a
    // `relay` lane's harness traffic already flows through the daemon's own HTTP pipeline,
    // so a second row would double count. Lane stats record BOTH kinds. "Metered by the
    // relay" is decided by the DAEMON from the rung's declared env (finding C1): a `cli`
    // rung whose env routes its harness back through this listener is already metered by
    // the HTTP pipeline, and the report's own `kind` is never trusted — the rung's kind is
    // the authority, so a stale MCP snapshot (renamed rung, daemon not yet restarted) can
    // never mint a ledger row.
    if (report.kind !== rung.kind) {
      return ok({ recorded: true, accounting: "skipped", reason: "kind-mismatch" }, true);
    }
    if (rung.kind === "relay") {
      return ok({ recorded: true, accounting: "skipped", reason: "relay-kind" }, true);
    }
    if (laneRoutesThroughRelay(rung, cfg)) {
      return ok({ recorded: true, accounting: "skipped", reason: "relay-routed" }, true);
    }
    recordDispatchLaneAccounting(h.accountingRecorder, report);
    return ok({ recorded: true, accounting: "recorded" }, true);
  }

  if (req.method === "GET" && pathname === "/telemetry") {
    const accounting =
      typeof h.accountingReader?.writerHealth === "function" ? h.accountingReader.writerHealth() : null;
    const report = getTelemetryReport(cfg, h.breaker, Date.now(), accounting);
    // Log the fact exactly once per process — see the doc comment on
    // AdminHandlers.claimConfigStalenessLogOnce and config.ts `configStaleness`.
    if (report.config.changedOnDisk && h.claimConfigStalenessLogOnce()) {
      process.stderr.write(`llm-relay: ${CONFIG_STALENESS_NOTICE}\n`);
    }
    return ok(report, true);
  }

  // POST /stop — admitted by the same control-token boundary as /cooldowns/clear.
  // Responds 202 {"stopping":true} FIRST, then shuts down on the next tick so the
  // response leaves before the listener closes. GET /stop is an explicit 404
  // (never the model-path fall-through — /dispatch/telemetry precedent).
  if (req.method === "GET" && pathname === "/stop") {
    return bad(404, `GET /stop is not a route — POST to stop the relay`);
  }
  if (req.method === "POST" && pathname === "/stop") {
    if (typeof reqJson !== "object" || reqJson === null || Array.isArray(reqJson)) {
      return bad(400, `POST /stop body must be a JSON object`);
    }
    // Reject unknown body keys (cooldowns/clear precedent).
    const body = reqJson as Record<string, unknown>;
    if (Object.keys(body).length > 0) {
      return bad(400, `POST /stop does not accept any properties`);
    }
    // Admission boundary is checked by the caller (handleAdminRoutes is only
    // reached after admissionFailure passes — /stop is in server.ts's
    // CONTROL_ROUTES, so a mutating request needs the control token).
    // Check onStop BEFORE writing any response: a bare programmatic proxy
    // with no shutdown handler must never answer 202 for a stop that will
    // not happen.
    const onStop = h.onStop;
    if (typeof onStop !== "function") {
      return bad(503, `the relay has no stop handler`);
    }
    // Respond 202 FIRST, then call onStop on the next tick so the response
    // leaves before the listener closes.
    res.writeHead(202, { "content-type": "application/json" });
    res.end(JSON.stringify({ stopping: true }));
    h.logger.write(baseLog(started, path, false, false, 202, "skipped", null));
    setImmediate(() => {
      onStop();
    });
    return true;
  }

  return false;
}
