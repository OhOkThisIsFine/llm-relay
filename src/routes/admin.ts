import type { IncomingMessage, ServerResponse } from "node:http";
import type { ConfigReloadAttemptResult } from "../config-reload.js";
import { AUTO_MODEL, CONFIG_STALENESS_NOTICE, unroutableOffloadClient, type Config, type OffloadScope } from "../config.js";
import type { ModelCatalog } from "../catalog.js";
import type { PingLoop } from "../ping/cadence.js";
import type { MetadataLogger } from "../log.js";
import { buildRegistry } from "../registry.js";
import { buildCandidates } from "../candidates.js";
import { offloadState, setOffload } from "../offload.js";
import { describeId, findLadderRung, lookupLadderRung, markExhausted, clearExhausted, OUTCOME_DEFAULT_MS, resolveAutoSpec, specContextWindow, type DispatchOutcome } from "../dispatch.js";
import { parseHostRoutingState } from "../host-routing.js";
import {
  buildDaemonDispatchView,
  type DaemonDispatchOptions,
} from "../daemon-dispatch-view.js";
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
import {
  parseLaneExecutionBrokerRequest,
  type LaneExecutionBrokerPort,
} from "../lane-execution-broker.js";

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
    // Resolve each advertised id from actual context evidence. Unknown ceilings are omitted.
    // `auto` is relay-reserved and must resolve through the current ladder, not as a model id.
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
  /** Package version loaded by this daemon process; absent only for an unversioned embed. */
  relayVersion?: string;
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
  /** D1 Phase 1: injected execution broker; absent means the route fails closed with 503. */
  laneExecutionBroker?: LaneExecutionBrokerPort;
  /** D2 atomic config transaction; absent means this embed cannot reload and answers 503. */
  reloadConfig?: () => ConfigReloadAttemptResult;
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
  // Walk abandonment is relay-initiated, not the lane's own timeout.
  abandoned: "aborted",
} as const satisfies Record<DispatchLaneStatus, FailureKind | null>;

/**
 * Routing-memory effect for a settled lane attempt. An answer pins; every non-answer demotes.
 * The table is exhaustive over `DispatchLaneStatus`.
 */
const LANE_AFFINITY_EFFECT = {
  completed: "pin",
  failed: "demote",
  timed_out: "demote",
  abandoned: "demote",
} as const satisfies Record<DispatchLaneStatus, "pin" | "demote">;

/**
 * Update daemon-owned lane routing memory from one settled attempt. Recording either outcome first
 * clears the previous memory so the newest evidence wins. No memory is written when walking is off.
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
  // Evaluate outlier demotion after recording this sample and its immediate pin/demotion so a
  // newly detected slowdown can retract a pin from the same attempt.
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
 * Apply an operator pin/unpin to the walk's routing memory. Pins are temporary live-state
 * preferences, never config rewrites, and can reorder only enabled/selectable ladder rungs.
 * Invalid or inert requests are refused rather than silently ignored.
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
    // Host routing state is caller-reported; the daemon's own environment cannot describe the
    // session making this request.
    const hostParam = parseHostRoutingState(pickQuery(path, "host"));
    const entrypointParam = pickQuery(path, "entrypoint");
    const view = buildDaemonDispatchView(
      cfg,
      {
        ...(taskParam ? { task: taskParam } : {}),
        ...(pickQuery(path, "lane") ? { lane: pickQuery(path, "lane") as string } : {}),
        ...(pickQuery(path, "after") ? { after: pickQuery(path, "after") as string } : {}),
        ...((pickQuery(path, "tier") ?? bodyTier) ? { tier: (pickQuery(path, "tier") ?? bodyTier) as string } : {}),
        ...(bodyClient ? { client: bodyClient } : {}),
        ...(hostParam ? { host: hostParam } : {}),
        ...(entrypointParam ? { entrypoint: entrypointParam } : {}),
        // `buildDispatch` validates requester/mode/model and fails safe on unknown values.
        ...(pickQuery(path, "requester") ? { requester: pickQuery(path, "requester") as NonNullable<DaemonDispatchOptions["requester"]> } : {}),
        ...(pickQuery(path, "mode") ? { mode: pickQuery(path, "mode") as NonNullable<DaemonDispatchOptions["mode"]> } : {}),
        ...(pickQuery(path, "model") ? { model: pickQuery(path, "model") as string } : {}),
      },
      { catalog: h.catalog },
    );
    return ok(view, true);
  }

  if (pathname === "/dispatch/activity") return answerDispatchActivity(req.method, path, ok, bad);

  if (pathname === "/mcp/lane-execution") {
    if (req.method !== "POST") {
      return bad(404, `${req.method} /mcp/lane-execution is not a route — POST a broker action`);
    }
    const request = parseLaneExecutionBrokerRequest(reqJson);
    if (request === null) {
      return bad(400, "POST /mcp/lane-execution body is not a valid broker action");
    }
    if (h.laneExecutionBroker === undefined) {
      return bad(503, "lane execution broker is unavailable");
    }
    const result = await h.laneExecutionBroker.handle(request);
    return result.ok ? ok({ execution: result.execution }, true) : bad(result.status, result.message);
  }

  if ((req.method === "GET" || req.method === "HEAD") && pathname === "/dispatch/telemetry") {
    // Explicitly reject reads so this control path can never fall through into model routing.
    return bad(404, `${req.method} /dispatch/telemetry is not a route — POST a telemetry report`);
  }

  if (req.method === "POST" && pathname === "/dispatch/telemetry") {
    const report = parseTelemetryReport(reqJson);
    if (!report) {
      // The reason never echoes the body: a report carries job ids and token counts.
      return bad(400, `POST /dispatch/telemetry body must be a telemetry report`);
    }
    // Reports are accepted only for configured ladder lanes; the shared lookup also bounds the
    // set of persisted lane-stat/affinity keys.
    const rung = findLadderRung(cfg, report.laneId);
    if (!rung) {
      return bad(400, `POST /dispatch/telemetry: no lane "${report.laneId}" in routing.ladder`);
    }
    recordLaneRun(cfg, report);
    recordLaneAffinity(cfg, report);
    // Account only work not already metered by the HTTP pipeline. The daemon's configured rung is
    // authoritative; never trust the report's lane kind for accounting.
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
    const report = getTelemetryReport(cfg, h.breaker, Date.now(), accounting, h.relayVersion ?? "unknown");
    // Log the fact exactly once per process — see the doc comment on
    // AdminHandlers.claimConfigStalenessLogOnce and config.ts `configStaleness`.
    if (report.config.changedOnDisk && h.claimConfigStalenessLogOnce()) {
      process.stderr.write(`llm-relay: ${CONFIG_STALENESS_NOTICE}\n`);
    }
    return ok(report, true);
  }

  // POST /reload — same admitted control boundary as /stop. The transaction itself is
  // injected by createProxy so this adapter never reads a config file or decides reload policy.
  if (req.method === "GET" && pathname === "/reload") {
    return bad(404, `GET /reload is not a route — POST to reload the relay config`);
  }
  if (req.method === "POST" && pathname === "/reload") {
    if (
      reqJson !== undefined &&
      (typeof reqJson !== "object" || reqJson === null || Array.isArray(reqJson))
    ) {
      return bad(400, `POST /reload body must be an empty JSON object`);
    }
    const body = (reqJson ?? {}) as Record<string, unknown>;
    if (Object.keys(body).length > 0) {
      return bad(400, `POST /reload does not accept any properties`);
    }
    const reload = h.reloadConfig;
    if (typeof reload !== "function") {
      return bad(503, `the relay has no config reload handler`);
    }

    const result = reload();
    if (result.ok) {
      return ok({
        reloaded: true,
        changed: result.changed,
        warnings: result.warnings,
      }, true);
    }
    if (result.status === 400) return bad(400, result.message);

    // 409 is actionable: expose only the bounded config PATHS that require a restart, never values.
    res.writeHead(409, { "content-type": "application/json" });
    res.end(JSON.stringify({
      error: { type: "error", message: result.message },
      requiresRestart: result.requiresRestart,
    }));
    h.logger.write(baseLog(started, path, false, false, 409, "skipped", null));
    return true;
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
