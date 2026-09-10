/**
 * MODULE CHARTER: Candidate Walk & Hedged Execution Engine (candidate-runner.ts)
 *
 * 1. Domain Boundary & Responsibilities:
 *    - Executes failover candidate walks across prioritized models, provider deployments, and credential slots.
 *    - Manages speculative hedging races to minimize tail latency across unreliable or slow free upstream tiers.
 *    - Enforces protocol dialect translation, response streaming, and error classification across heterogeneous endpoints.
 *
 * 2. Candidate Walk Semantics & Ranking Order:
 *    - Invariant ordering: Preserves dynamic pool benchmark rank and operator-configured primary/fallback lists.
 *    - Runtime filters: Excludes circuit-broken deployments, cooling credentials, and cost-blocked candidates.
 *    - Failover: Progresses sequentially across candidates upon 429 rate limits, 5xx server errors, or auth failures,
 *      terminating early on non-retryable client errors (e.g., 400 Bad Request with invalid schema).
 *
 * 3. Hedging Race Semantics:
 *    - Speculatively launches a secondary attempt if the primary attempt exceeds the configured hedge latency delay.
 *    - The first attempt to return valid response headers wins the race and streams its body directly to the client.
 *    - The losing or trailing attempt is promptly aborted via `AbortController` to conserve upstream bandwidth and quota.
 *
 * 4. Attribution & Transparency Invariants:
 *    - Emits rich observability headers (`x-llm-relay-credential`, `x-llm-relay-pool-attempts`, `x-llm-relay-hedged`).
 *    - Accurately classifies failure origins (`errorOrigin`) and distinguishes pre-header vs post-header body truncation.
 */
import type { IncomingMessage, ServerResponse } from "node:http";
import type { Config, ResolvedTarget } from "./config.js";
import type { ProbationConfig } from "./config-types.js";
import type { ModelLimits } from "./catalog.js";
import { specOfTarget } from "./benchmarks.js";
import {
  CREDENTIAL_HEADER,
  CREDENTIAL_ATTEMPTS_HEADER,
  POOL_ATTEMPTS_HEADER,
  HARD_CAP_HEADER,
  ERROR_ORIGIN_HEADER,
  SERVED_BY_HEADER,
  TOOL_DIALECT_HEADER,
  UNKNOWN_REFUSAL_HEADER,
  DEGRADED_HEADER,
  PAID_HEADER,
  QUOTA_DEMOTED_HEADER,
  LATENCY_DEMOTED_HEADER,
  PROBATION_HEADER,
  HEDGED_HEADER,
  dialectRefusalSignalOf,
  errorOrigin,
  postHeaderBodyFailure,
  toolUseIdRewrites,
  toolCallIdRewrites,
  thoughtSignatureSentinels,
  upstreamReportedModel,
  type ErrorOrigin,
  type PostHeaderBodyFailure,
} from "./backend.js";
import { STICKY_PROVENANCE_HEADER, type StickySessionManager } from "./session-pin.js";
import { probeStreamForCommit, type StreamCommitProbe, type StreamCommitProtocol } from "./stream-commit.js";
import { DIALECT_REFUSED_DESTRUCTIVE_CODE } from "./tool-dialects.js";
import { MAX_LOG_ATTEMPTS, type MetadataLogger, type RequestAttemptLog, type RequestAttemptStatus, type RequestLog } from "./log.js";
import type { ModelCallRecorder, ProxyAccountingFailureKind, RequestAccountingState } from "./accounting-state.js";
import { CircuitBreaker, globalCircuitBreaker } from "./circuit-breaker.js";
import { parseCredentialId } from "./credential-id.js";
import { resolveAttempt, type ResolvedAttempt } from "./resolved-attempt.js";
import { resolveAttemptForSlot } from "./credential-fleet.js";
import {
  CredentialWalk,
  groupCredentialAttempts,
  type CredentialWalkOutcome,
} from "./credential-select.js";
import { createUsageAccumulator, type UsageAccumulator } from "./usage-observer.js";
import type { AccountingAttempt } from "./accounting.js";
import { assessCost, type CostClass } from "./metadata.js";
import { extractQuotaObservations, type QuotaObservation } from "./quota-observation.js";
import { baseLog } from "./request-log.js";
import {
  looksLikeContextLengthError,
  looksLikeMaxOutputError,
  parseStatedContextLimit,
  parseStatedMaxOutput,
  recordObservedContextLimit,
  recordObservedMaxOutput,
} from "./context-limits.js";
import { looksLikeRateLimitError, parseStatedRateLimit, recordObservedRateLimit } from "./rate-limits.js";
import { clearFacts, cooldownUntil, factsFor, recordFact, type FactResetBasis } from "./target-facts.js";
import { quotaDemotionLabel, type QuotaDemotionFn } from "./quota-demotion.js";
import { latencyDemotionLabel, type LatencyDemotionFn } from "./latency-demotion.js";
import type { HedgeDelayDecision } from "./hedge-trigger.js";
import { raceWithHedge, type HedgeRaceResult, type RaceEntrant, type Settled } from "./hedge-race.js";
import { hardCapLabel, type HardCapVerdict } from "./hard-cap.js";
import {
  applyResetRule,
  interpretRefusal,
  materializeScope,
  parseStatedResetMs,
  recordUnknownRefusal,
  type Interpretation,
} from "./refusal-interpretation.js";
import type {
  AttemptCancellationCause,
  AttemptFailed,
  AttemptHandle,
  OutcomeProvenance,
  ProviderTargetIdentity,
} from "./kernel/contracts.js";
import { DEFAULT_ANTHROPIC_VERSION } from "./config.js";
import { buildAuthHeaders } from "./authEnv.js";
import { CONTROL_AUTHORIZATION_HEADER } from "./control-authorization.js";
import { STICKY_SESSION_HEADER } from "./session-pin.js";
import { failClosed, HOP_BY_HOP } from "./stream-pipeline.js";

const INTERNAL_REQUEST_HEADERS = new Set([
  "x-codex-turn-metadata",
  "x-llm-relay-dashboard-session",
  STICKY_SESSION_HEADER,
  CONTROL_AUTHORIZATION_HEADER,
]);

/** Inbound header names a CONTAINED target is allowed to receive (allow-list).
 * Everything else inbound is dropped. `authorization`/`x-api-key` are deliberately absent:
 * the inbound client's own auth must not reach a third-party base — the relay's backend
 * credential is injected after this loop by `buildAuthHeaders`. Passthrough targets
 * (not-declared) keep the old behaviour.
 */
const ALLOWED_FORWARD_HEADERS = new Set([
  "content-type",
  "accept",
  "anthropic-version",
  "anthropic-beta",
]);

const MID_STREAM_ERROR_KIND = "backend_stream_failed";

export function toolUseIdRewriteField(source: Response): {
  toolUseIdRewrites?: number;
  toolCallIdRewrites?: number;
  thoughtSignatureSentinels?: number;
} {
  const rewrites = toolUseIdRewrites(source);
  const outbound = toolCallIdRewrites(source);
  const sentinels = thoughtSignatureSentinels(source);
  return {
    ...(rewrites === undefined ? {} : { toolUseIdRewrites: rewrites }),
    ...(outbound === undefined ? {} : { toolCallIdRewrites: outbound }),
    ...(sentinels === undefined ? {} : { thoughtSignatureSentinels: sentinels }),
  };
}

/** A provider declared an authEnv whose variable is unset — a configuration error, not a passthrough. */
export class CredentialConfigError extends Error {
  constructor(provider: string, authEnv: string) {
    super(`provider "${provider}" declares authEnv ${authEnv} but it is unset or blank`);
    this.name = "CredentialConfigError";
  }
}

export function buildForwardHeaders(inbound: IncomingMessage["headers"], attempt: ResolvedAttempt): Record<string, string> {
  const { target, credential } = attempt;
  const isContained = credential.state !== "not-declared" || target.credentialMode === "contained";
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(inbound)) {
    const key = k.toLowerCase();
    if (HOP_BY_HOP.has(key)) continue;
    if (INTERNAL_REQUEST_HEADERS.has(key)) continue;
    if (isContained && !ALLOWED_FORWARD_HEADERS.has(key)) continue;
    if (v === undefined) continue;
    out[key] = Array.isArray(v) ? v.join(", ") : v;
  }
  if (!out["anthropic-version"]) out["anthropic-version"] = DEFAULT_ANTHROPIC_VERSION;
  if (credential.state === "declared-missing") {
    throw new CredentialConfigError(target.provider, target.authEnv!);
  }
  Object.assign(out, buildAuthHeaders(credential.value, target.authHeader));
  return out;
}

export type CostClassFn = (attempt: ResolvedAttempt) => CostClass | undefined;

export interface StickyRequestContext {
  key: string;
  multiCandidateRoute: boolean;
  /** The previously stored pin's routing evaluation; null means a new pin may be created. */
  provenance: string | null;
}

export type TargetUsability = "live" | "slow" | "credential-fault" | "cooling" | "probation";
type CredentialAttemptLabel = number | "transport" | "timeout" | "protocol" | "local" | "client" | "cancelled";
type OutcomeClass = "ok" | "retriable" | "credential" | "client";

export const DEFAULT_WALK_BUDGET_MS = 45_000;
export const DEFAULT_STALL_TIMEOUT_MS = 90_000;
const MAX_CAPPED_HEADER_CELLS = 5;

export interface CandidateRunnerHandlers {
  breaker: CircuitBreaker;
  logger: MetadataLogger;
  hardCap: (attempt: ResolvedAttempt, now: number) => HardCapVerdict | null;
  hedgeDelay: (attempt: ResolvedAttempt, estimatedInputTokens: number) => HedgeDelayDecision | null;
  modelCallRecorder?: ModelCallRecorder;
  stickySessions?: StickySessionManager;
  /**
   * Untested-free-members-first probation (`routing.probation`, default ON). Optional so
   * hand-built handler literals in tests keep compiling — absent reads as "band unreachable",
   * the pre-probation behaviour. The request path always sets it (see `createProxy`); a call
   * site that omits it silently disables the band there.
   */
  probation?: ProbationFn | null;
}

interface ServedAnnouncementContext {
  readonly target: ResolvedTarget;
  readonly retryAfterOverrideMs?: number | null | undefined;
  readonly poolSummary?: string | null | undefined;
  readonly tried?: readonly string[] | undefined;
  readonly poolUnknownRefusals?: number | null | undefined;
  readonly credentialHeaders?: Record<string, string> | undefined;
  readonly degraded?: string | null | undefined;
  readonly quotaDemoted?: string | null | undefined;
  readonly latencyDemoted?: string | null | undefined;
  readonly probation?: string | null | undefined;
  readonly hedged?: string | null | undefined;
  readonly paid?: string | null | undefined;
  readonly sticky?: StickyRequestContext | null | undefined;
}

function filterResponseHeaders(hh: Headers): Record<string, string | string[]> {
  const out: Record<string, string | string[]> = {};
  for (const [k, v] of hh.entries()) {
    const lower = k.toLowerCase();
    if (HOP_BY_HOP.has(lower)) continue;
    if (lower === "set-cookie") continue;
    out[k] = v;
  }
  if (typeof hh.getSetCookie === "function") {
    const cookies = hh.getSetCookie();
    if (cookies.length > 0) {
      out["set-cookie"] = cookies;
    }
  } else {
    const cookie = hh.get("set-cookie");
    if (cookie) out["set-cookie"] = cookie;
  }
  return out;
}

export function responseHeadersForTarget(
  backendRes: Response,
  ctx: ServedAnnouncementContext,
): Record<string, string | string[]> {
  const responseHeaders: Record<string, string | string[]> = filterResponseHeaders(backendRes.headers);
  // The winner below 400, every deployment tried at or above it. The header's own declaration is
  // the contract — "when every candidate fails it carries the list that was tried instead, so an
  // exhausted pool is self-describing" — and `docs/reference.md` states it to users. The Anthropic
  // front used to omit it entirely on a terminal error while the OpenAI front supplied it, so the
  // same documented behaviour was delivered by one path and not the other.
  // ⚠ Not the transport-exit omission at the `handle` catch, which is a RECORDED deliberate
  // residue: a transport exhaustion has no HTTP response to describe.
  responseHeaders[SERVED_BY_HEADER] = backendRes.status < 400 || !ctx.tried?.length
    ? specOfTarget(ctx.target)
    : ctx.tried.join(", ");
  if (typeof ctx.retryAfterOverrideMs === "number" && Number.isFinite(ctx.retryAfterOverrideMs)) {
    responseHeaders["retry-after"] = String(Math.max(1, Math.ceil(ctx.retryAfterOverrideMs / 1000)));
  }
  if (ctx.poolSummary) responseHeaders[POOL_ATTEMPTS_HEADER] = ctx.poolSummary;
  if (ctx.poolUnknownRefusals) responseHeaders[UNKNOWN_REFUSAL_HEADER] = String(ctx.poolUnknownRefusals);
  if (ctx.degraded) responseHeaders[DEGRADED_HEADER] = ctx.degraded;
  if (ctx.quotaDemoted) responseHeaders[QUOTA_DEMOTED_HEADER] = ctx.quotaDemoted;
  if (ctx.latencyDemoted) responseHeaders[LATENCY_DEMOTED_HEADER] = ctx.latencyDemoted;
  if (ctx.probation) responseHeaders[PROBATION_HEADER] = ctx.probation;
  if (ctx.hedged) responseHeaders[HEDGED_HEADER] = ctx.hedged;
  if (ctx.paid) responseHeaders[PAID_HEADER] = ctx.paid;
  if (ctx.credentialHeaders) {
    Object.assign(responseHeaders, ctx.credentialHeaders);
  }
  const stickyValue = stickyHeaderValue(ctx.sticky, ctx.target, backendRes.status);
  if (stickyValue) {
    responseHeaders[STICKY_PROVENANCE_HEADER] = stickyValue;
  }
  return responseHeaders;
}

function endMidStreamFailure(
  res: ServerResponse,
  errorFrame: string | null,
  message: string,
): void {
  if (res.writableEnded || res.destroyed) return;
  if (res.headersSent) {
    if (errorFrame) res.write(errorFrame);
    res.end();
  } else {
    failClosed(res, 502, message);
  }
}

function midStreamMessage(e: unknown): string {
  const errStr =
    e && typeof e === "object" && "message" in e && typeof (e as { message: unknown }).message === "string"
      ? (e as { message: string }).message
      : String(e);
  return `llm-relay: backend stream failed mid-response: ${errStr}`;
}

export function handleMidStreamError(
  res: ServerResponse,
  e: unknown,
  started: number,
  path: string,
  hadTools: boolean,
  streamed: boolean,
  backendStatus: number,
  target: ResolvedTarget,
  attempt: HealthAttempt | undefined,
  h: { logger: MetadataLogger; breaker: CircuitBreaker },
  errorFrameBuilder: (msg: string) => string | null,
  reportedModelSource?: Response,
  deadlineAborted = false,
  committed = false,
): void {
  const message = midStreamMessage(e);
  const errorFrame = errorFrameBuilder(message);
  endMidStreamFailure(res, errorFrame, message);
  if (attempt) {
    if (res.destroyed) {
      completeAttemptCancelled(h, attempt, "client disconnected");
    } else {
      completeAttemptFailure(h, attempt, {
        failure: deadlineAborted ? "transport" : "protocol",
        provenance: deadlineAborted ? "deadline" : "upstream",
        status: deadlineAborted ? 504 : 502,
        ...(committed ? { logStatus: "committed" as const } : {}),
      });
    }
  }
  h.logger.write({
    ...baseLog(
      started,
      path,
      hadTools,
      streamed,
      backendStatus,
      "skipped",
      target,
      attempt?.trace.snapshot(),
      reportedModelSource ? upstreamReportedModel(reportedModelSource) : undefined,
    ),
    errorKinds: [MID_STREAM_ERROR_KIND],
    ...(reportedModelSource ? toolUseIdRewriteField(reportedModelSource) : {}),
  });
}

export function paidLabel(cfg: Config, h: { catalog: { cachedLimits: (p: string, m: string) => ModelLimits | null | undefined } }, target: ResolvedTarget): string | null {
  if (target.kind !== "openai" || !target.model) return null;
  const assessment = assessCost(target.model, h.catalog.cachedLimits(target.provider, target.model) ?? null, cfg.providers[target.provider]?.tierType);
  if (assessment.costClass === "free") return null;
  return `${specOfTarget(target)} (${assessment.costClass}, ${assessment.basis})`;
}

export function degradedLabel(pool: string | null, degraded: Set<string> | null, target: ResolvedTarget): string | null {
  if (pool === null || degraded === null) return null;
  const spec = specOfTarget(target);
  return degraded.has(spec) ? `${spec} (below ${pool})` : null;
}

/**
 * Minimum SERVED-REQUEST samples before a free deployment counts as measured.
 *
 * Five is the smallest count for which a sample window is not simply "the last couple of
 * requests" — the same standing rule that keeps `latency-demotion.ts` from acting on one
 * request's latency.
 */
export const DEFAULT_PROBATION_MIN_SAMPLES = 5;

/** One probation verdict — the smallest honest statement of "why this cell leads the walk". */
export interface ProbationVerdict {
  /** Served-request samples behind the verdict. Always below `minSamples`. */
  readonly samples: number;
  /** The floor it has not reached yet. */
  readonly minSamples: number;
}

export type ProbationFn = (attempt: ResolvedAttempt, now: number) => ProbationVerdict | null;

/**
 * How the probation check reads its two facts.
 *
 * ⚠ A plain reader, NOT the probe cache. Keeping the seam narrow is what lets this check stay
 * pure and testable — the server passes `countRequestSamples` from `ping/probe-cache.ts`, the
 * suite passes a stub. Probe samples never reach the reader's answer: the count is
 * served-request samples only, which is what distinguishes "this deployment served traffic"
 * from "a probe found it alive".
 */
export interface ProbationDeps {
  readonly readRequestSamples: (provider: string, model: string) => number;
  /**
   * ⚠ The SHAPE is owned by `config-types.ts` (`ProbationConfig`) and imported, never
   * re-declared here — the same rule `latency-demotion.ts` follows for its own settings.
   * `config/routing-parser.ts` normalizes the boolean shorthand away, so this check never has
   * to decide what `false` means.
   */
  readonly settings?: ProbationConfig | undefined;
  /** Free-ness comes from the caller's cost assessment (`assessCost`), never a second opinion. */
  readonly costClassOf?: CostClassFn | null | undefined;
}

/** Resolve the knobs once. Absent, or an empty object, means every default — which is ON. */
export function resolveProbationSettings(settings: ProbationConfig | undefined): {
  enabled: boolean;
  minSamples: number;
} {
  return {
    enabled: settings?.enabled ?? true,
    minSamples: settings?.minSamples ?? DEFAULT_PROBATION_MIN_SAMPLES,
  };
}

export function resolveProbation(deps: ProbationDeps, attempt: ResolvedAttempt): ProbationVerdict | null {
  const { enabled, minSamples } = resolveProbationSettings(deps.settings);
  if (!enabled) return null;

  // No model means no deployment key, so there are no samples to count and no opinion to give.
  const model = attempt.target.model;
  if (typeof model !== "string" || model.length === 0) return null;
  // Only FREE deployments are ever probationed. `unknown` counts as paid on purpose — a guess
  // must not reorder paid traffic — which is the same fail-safe `hedge-trigger.ts` applies.
  let cost: CostClass | undefined;
  try {
    cost = deps.costClassOf?.(attempt);
  } catch {
    return null;
  }
  if (cost !== "free") return null;
  let samples: number;
  try {
    samples = deps.readRequestSamples(attempt.target.provider, model);
  } catch {
    return null;
  }
  if (!Number.isFinite(samples) || samples >= minSamples) return null;
  return { samples: Math.max(0, Math.floor(samples)), minSamples };
}

/**
 * Build the request-path evaluator. The wrapper is the safety seam: NOTHING inside may throw
 * into the request path, and a failure degrades to "no opinion" — the pre-probation behaviour
 * — rather than to a refused request. Deliberately silent: routing hints are not log-worthy
 * events.
 */
export function createProbationFn(deps: ProbationDeps): ProbationFn {
  return (attempt) => {
    try {
      return resolveProbation(deps, attempt);
    } catch {
      return null;
    }
  };
}

/**
 * `"<spec> (0 of 5 request samples)"` — bounded, metadata only: a spec and a count, never a
 * prompt, a credential or an id.
 */
export function probationLabel(spec: string, verdict: ProbationVerdict): string {
  return `${spec} (${verdict.samples} of ${verdict.minSamples} request samples)`;
}

/**
 * The probation announcement for the candidate that actually SERVED the response, or null.
 *
 * ⚠ Evaluated against the SERVING attempt at response time, not against the walk leader at
 * routing time: a probation leader that 429s fails over to a live member, and that response
 * must NOT carry the header — its serving candidate was never placed by the band. Both fronts
 * call this with their serving attempt and hand the string to `ServedAnnouncementContext`;
 * the header itself is written only by `responseHeadersForTarget`, the one owner.
 */
export function probationLabelForAttempt(
  h: { probation?: ProbationFn | null },
  attempt: ResolvedAttempt,
  now: number,
): string | null {
  const verdict = h.probation?.(attempt, now) ?? null;
  return verdict ? probationLabel(specOfTarget(attempt.target), verdict) : null;
}

function cooledByAllowance(attempt: ResolvedAttempt, now: number, costClass: CostClass | undefined): boolean {
  try {
    const { target } = attempt;
    const until = cooldownUntil(target.provider, attempt.credentialId, target.model ?? null, {
      now,
      ...(costClass === undefined ? {} : { costClass }),
    });
    return until !== null && now < until;
  } catch {
    return false;
  }
}

function cooledByQuota(
  attempt: ResolvedAttempt,
  breaker: CircuitBreaker,
  quotaDemotion: QuotaDemotionFn | null | undefined,
  now: number,
): boolean {
  if (!quotaDemotion) return false;
  const spent = quotaDemotion(attempt, now);
  if (spent === null) return false;
  breaker.recordQuotaCooldown(targetIdentity(attempt), spent.resetsAt, now);
  return true;
}

export function targetUsability(
  attempt: ResolvedAttempt,
  breaker: CircuitBreaker,
  now: number,
  quotaDemotion?: QuotaDemotionFn | null,
  costClassOf?: CostClassFn | null,
  latencyDemotion?: LatencyDemotionFn | null,
  probation?: ProbationFn | null,
): TargetUsability {
  const identity = targetIdentity(attempt);
  if (!breaker.isHealthy(identity, now)) return "cooling";
  if (cooledByAllowance(attempt, now, costClassOf?.(attempt))) return "cooling";
  if (cooledByQuota(attempt, breaker, quotaDemotion, now)) return "cooling";
  if (breaker.hasCredentialFault(identity, now)) return "credential-fault";
  if (latencyDemotion?.(attempt, now)) return "slow";
  // Probation is checked LAST: every stronger band outranks it, so a cooling probation member
  // goes to `cooling` and a slow one to `slow`. What remains is free, healthy, fast — and
  // unmeasured, which is exactly the member the relay wants data on.
  if (probation?.(attempt, now)) return "probation";
  return "live";
}

export function expandCredentialAttempts(targets: readonly ResolvedTarget[]): ResolvedAttempt[] {
  const expanded: ResolvedAttempt[] = [];
  for (const target of targets) {
    const slots = target.credentialSlots;
    if (slots === undefined) {
      expanded.push(resolveAttempt(target));
      continue;
    }
    for (const slot of slots) {
      const attempt = resolveAttemptForSlot(target, slot);
      if (attempt) expanded.push(attempt);
    }
  }
  return expanded;
}

export function credentialEvidence(
  attempt: ResolvedAttempt,
  cfg: Config,
  breaker: CircuitBreaker,
  now: number,
) {
  const identity = targetIdentity(attempt);
  const provider = cfg.providers[attempt.target.provider];
  const state = breaker.getState(identity);
  let facts: ReturnType<typeof factsFor> = [];
  try { facts = factsFor(attempt.target.provider, attempt.credentialId, attempt.target.model ?? null, { now }); } catch { /* persistent evidence is best effort */ }
  const cost = attempt.target.kind === "openai" && attempt.target.model
    ? assessCost(attempt.target.model, null, provider?.tierType).costClass
    : "paid";
  return {
    facts,
    health: breaker.isHealthy(identity, now) ? "unknown" as const : "unhealthy" as const,
    credentialFault: breaker.hasCredentialFault(identity, now),
    cooling: cooledByAllowance(attempt, now, undefined),
    saturated: provider?.maxConcurrent != null && breaker.inFlightCredential(attempt.credentialId) >= provider.maxConcurrent,
    quota: state?.quotaObservations ?? [],
    cost,
  };
}

function coolingLiftTime(
  attempt: ResolvedAttempt,
  breaker: CircuitBreaker,
  now: number,
  costClassOf?: CostClassFn | null,
): number | null {
  const identity = targetIdentity(attempt);
  const breakerState = breaker.getState(identity);
  if (breakerState && breakerState.cooldownUntil > now) {
    return breakerState.cooldownUntil;
  }
  const costClass = costClassOf?.(attempt);
  const factCooldown = cooldownUntil(attempt.target.provider, attempt.credentialId, attempt.target.model ?? null, {
    now,
    ...(costClass === undefined ? {} : { costClass }),
  });
  if (factCooldown !== null && factCooldown > now) {
    return factCooldown;
  }
  return null;
}

export function orderDeploymentGroupsByUsability(
  attempts: readonly ResolvedAttempt[],
  breaker: CircuitBreaker,
  now: number,
  quotaDemotion?: QuotaDemotionFn | null,
  costClassOf?: CostClassFn | null,
  latencyDemotion?: LatencyDemotionFn | null,
  probation?: ProbationFn | null,
): {
  ordered: ResolvedAttempt[];
  quotaDemotedFirst: string | null;
  latencyDemotedFirst: string | null;
} {
  type Group = ReturnType<typeof groupCredentialAttempts>[number];
  const preferred = groupCredentialAttempts(attempts)[0]?.attempts[0];
  const probationGroups: Group[] = [];
  const live: Group[] = [];
  const slow: Group[] = [];
  const faulted: Group[] = [];
  const cooling: Group[] = [];
  for (const group of groupCredentialAttempts(attempts)) {
    const usability = targetUsability(group.attempts[0]!, breaker, now, quotaDemotion, costClassOf, latencyDemotion, probation);
    switch (usability) {
      case "probation":
        probationGroups.push(group);
        break;
      case "live":
        live.push(group);
        break;
      case "slow":
        slow.push(group);
        break;
      case "credential-fault":
        faulted.push(group);
        break;
      case "cooling":
        cooling.push(group);
        break;
      default: {
        const _never: never = usability;
        throw new Error(`unhandled TargetUsability: ${_never}`);
      }
    }
  }

  cooling.sort((a, b) => {
    const liftA = coolingLiftTime(a.attempts[0]!, breaker, now, costClassOf);
    const liftB = coolingLiftTime(b.attempts[0]!, breaker, now, costClassOf);
    if (liftA === null && liftB === null) return 0;
    if (liftA === null) return 1;
    if (liftB === null) return -1;
    return liftA - liftB;
  });

  const ordered = [...probationGroups, ...live, ...slow, ...faulted, ...cooling].flatMap((group) => group.attempts);
  let latencyDemotedFirst: string | null = null;
  if (
    preferred !== undefined &&
    latencyDemotion !== undefined &&
    latencyDemotion !== null &&
    ordered[0] !== undefined &&
    ordered[0] !== preferred
  ) {
    const slowDemoted = latencyDemotion(preferred, now);
    if (slowDemoted) latencyDemotedFirst = latencyDemotionLabel(specOfTarget(preferred.target), slowDemoted);
  }
  let quotaDemotedFirst: string | null = null;
  if (
    preferred !== undefined &&
    quotaDemotion !== undefined &&
    quotaDemotion !== null &&
    ordered[0] !== undefined &&
    ordered[0] !== preferred &&
    quotaDemotion(preferred, now) !== null
  ) {
    quotaDemotedFirst = quotaDemotionLabel(specOfTarget(preferred.target), quotaDemotion(preferred, now)!);
  }
  return { ordered, quotaDemotedFirst, latencyDemotedFirst };
}

export class CredentialAttemptTrace {
  private readonly entries: Array<{
    provider: string;
    deployment: string;
    credentialId: ResolvedAttempt["credentialId"];
    multiSlot: boolean;
    outcome?: CredentialWalkOutcome;
  }> = [];

  constructor(private readonly cfg: Config) {}

  recordStarted(attempt: ResolvedAttempt): void {
    const configured = this.cfg.providers[attempt.target.provider]?.credentials;
    const multiSlot = configured !== undefined && configured.filter((slot) => slot.enabled !== false).length >= 2;
    this.entries.push({
      provider: attempt.target.provider,
      deployment: specOfTarget(attempt.target),
      credentialId: attempt.credentialId,
      multiSlot,
    });
  }

  record(attempt: ResolvedAttempt, outcome: CredentialWalkOutcome): void {
    const deployment = specOfTarget(attempt.target);
    const pending = [...this.entries].reverse().find((entry) =>
      entry.outcome === undefined &&
      entry.provider === attempt.target.provider &&
      entry.deployment === deployment &&
      entry.credentialId === attempt.credentialId,
    );
    if (!pending) {
      throw new Error("credential attempt trace outcome does not match a started attempt");
    }
    pending.outcome = Object.freeze({ ...outcome });
  }

  headers(servedAttempt?: ResolvedAttempt): Record<string, string> {
    if (!this.entries.some((entry) => entry.multiSlot)) return {};
    const previewServed = servedAttempt
      ? [...this.entries].reverse().find((entry) =>
          entry.outcome === undefined &&
          entry.provider === servedAttempt.target.provider &&
          entry.deployment === specOfTarget(servedAttempt.target) &&
          entry.credentialId === servedAttempt.credentialId,
        )
      : undefined;
    const served = this.entries.find((entry) => entry.outcome?.kind === "success") ?? previewServed;
    const headers: Record<string, string> = {};
    if (served?.multiSlot) headers[CREDENTIAL_HEADER] = served.credentialId;

    const failures = this.entries.filter(
      (entry) => entry !== served && entry.outcome?.kind !== "success",
    );
    if (this.entries.length >= 2 || served === undefined) {
      const tallies: Array<{ label: CredentialAttemptLabel; count: number }> = [];
      for (const entry of failures) {
        const label = credentialAttemptLabel(entry.outcome);
        const existing = tallies.find((candidate) => candidate.label === label);
        if (existing) existing.count += 1;
        else tallies.push({ label, count: 1 });
      }
      const summary = tallies.map(({ label, count }) => `${count}x${label}`).join(", ");
      headers[CREDENTIAL_ATTEMPTS_HEADER] =
        `${this.entries.length} tried, ${served ? 1 : 0} served${summary ? `: ${summary}` : ""}`;
    }
    return headers;
  }
}

function credentialAttemptLabel(outcome: CredentialWalkOutcome | undefined): CredentialAttemptLabel {
  if (outcome?.status !== undefined) return outcome.status;
  if (outcome?.kind === "provider-transport") return "transport";
  if (outcome?.kind === "timeout") return "timeout";
  if (outcome?.kind === "protocol") return "protocol";
  if (outcome?.kind === "client") return "client";
  if (outcome?.kind === "cancelled") return "cancelled";
  return "local";
}

export function recordCredentialStarted(
  walk: CredentialWalk,
  trace: CredentialAttemptTrace,
  attempt: ResolvedAttempt,
): void {
  walk.recordStarted(attempt);
  trace.recordStarted(attempt);
}

export function recordCredentialOutcome(
  walk: CredentialWalk,
  trace: CredentialAttemptTrace,
  attempt: ResolvedAttempt,
  outcome: CredentialWalkOutcome,
): void {
  walk.record(attempt, outcome);
  trace.record(attempt, outcome);
}

export function nextUncappedAttempt(
  h: { hardCap: (attempt: ResolvedAttempt, now: number) => HardCapVerdict | null },
  walk: CredentialWalk,
  attemptTrace: RequestAttemptTrace,
  tracker: Pool429Tracker,
): ResolvedAttempt | undefined {
  const now = Date.now();
  for (;;) {
    const candidate = walk.next();
    if (!candidate) return undefined;
    const verdict = h.hardCap(candidate, now);
    if (verdict === null) {
      tracker.noteOffered();
      return candidate;
    }
    tracker.recordCapped(
      hardCapLabel(parseCredentialId(candidate.credentialId)?.label ?? null, specOfTarget(candidate.target), verdict),
      verdict.resetsAt,
    );
    attemptTrace.recordCapped(candidate.target, now);
    walk.recordRejected(candidate);
  }
}

export interface AttemptRun {
  readonly resolvedAttempt: ResolvedAttempt;
  readonly target: ResolvedTarget;
  readonly controller: AbortController;
  readonly callerController: AbortController;
  readonly timer: ReturnType<typeof setTimeout>;
  readonly onResClose: () => void;
  readonly usage: UsageAccumulator;
  attempt: HealthAttempt | undefined;
  egressCallbackCalled: boolean;
  /**
   * The `fetch` this attempt's egress MUST use — both fronts' `startAttempt` pass this as
   * `fetchBackend`'s / `fetchOpenAiFront`'s third argument. Plain `fetch` unless a first-byte
   * deadline is armed below, in which case it wraps `fetch` to clear `firstByteTimer` the instant
   * the underlying HTTP call resolves — headers arrived — which is BEFORE `fetchBackend()` /
   * `fetchOpenAiFront()` finish reading a buffered body or preflighting a stream. That earlier
   * moment is the only place "first byte" can be observed; the OUTER promise those two functions
   * return already reflects the full non-streamed body read.
   */
  fetchFn: typeof fetch;
  /**
   * Armed only for a non-streamed attempt whose target resolved a `firstByteTimeoutMs`
   * (`ResolvedTarget.firstByteTimeoutMs`) — never for a streamed one, which already has
   * `stallTimeoutMs`'s inter-byte watchdog once its own head is being served. Cleared by
   * `fetchFn` above the moment the raw `fetch()` resolves; the total `timer` above then governs
   * the body read exactly as before this existed. `undefined` when no first-byte deadline applies.
   */
  firstByteTimer?: ReturnType<typeof setTimeout> | undefined;
  /**
   * Set by the first-byte timer's own callback, before it aborts `controller` — the SAME
   * controller the total-deadline `timer` above aborts, so a caller reading
   * `controller.signal.aborted` alone cannot tell which deadline fired. The metadata-only log
   * distinction (`first-byte deadline <n>ms`, never a new outcome kind) reads this flag.
   */
  firstByteTimedOut?: boolean;
  /** The first-byte deadline that fired, carried only for the log's reason string above. */
  firstByteTimeoutMs?: number;
}

/**
 * Wrap `fetchFn` so the FIRST underlying call's settlement (success OR failure) notifies
 * `onFirstByte` exactly once, then never again. A non-streamed `openai`-kind attempt may retry the
 * raw fetch once (dropping an unsupported `stream_options` hint), but that retry is gated on
 * `args.wantsStream`, which a first-byte-armed attempt never sets — so one notification is correct
 * for every case this wrapper is used for, and a stray second settlement is a no-op.
 */
function firstByteFetch(fetchFn: typeof fetch, onFirstByte: () => void): typeof fetch {
  let notified = false;
  return (input, init) => {
    const p = fetchFn(input, init);
    if (!notified) {
      notified = true;
      void p.then(onFirstByte, onFirstByte);
    }
    return p;
  };
}

export function beginAttemptRun(res: ServerResponse, offer: ResolvedAttempt, wantsStream: boolean): AttemptRun {
  const target = offer.target;
  const controller = new AbortController();
  const callerController = new AbortController();
  const run: AttemptRun = {
    resolvedAttempt: offer,
    target,
    controller,
    callerController,
    timer: setTimeout(() => controller.abort(), target.timeoutMs),
    onResClose: abortOnClientClose(res, callerController, controller),
    usage: createUsageAccumulator(),
    attempt: undefined,
    egressCallbackCalled: false,
    fetchFn: fetch,
  };
  // "First byte" for a non-streamed attempt is the moment fetch() resolves — response HEADERS
  // have arrived (design: docs/backlog.md item 1). Never armed on a streamed attempt: that path
  // already has `withStallWatchdog`'s inter-byte watchdog once its own head is being served, and
  // its pre-head wait is governed by `timer` plus the commit probe exactly as before this existed.
  const firstByteTimeoutMs = wantsStream ? undefined : target.firstByteTimeoutMs;
  if (firstByteTimeoutMs !== undefined) {
    run.firstByteTimeoutMs = firstByteTimeoutMs;
    run.firstByteTimer = setTimeout(() => {
      run.firstByteTimedOut = true;
      controller.abort();
    }, firstByteTimeoutMs);
    run.fetchFn = firstByteFetch(fetch, () => {
      if (run.firstByteTimer !== undefined) {
        clearTimeout(run.firstByteTimer);
        run.firstByteTimer = undefined;
      }
    });
  }
  res.on("close", run.onResClose);
  return run;
}

export function releaseAttemptRun(res: ServerResponse, run: AttemptRun): void {
  clearTimeout(run.timer);
  if (run.firstByteTimer !== undefined) clearTimeout(run.firstByteTimer);
  res.off("close", run.onResClose);
}

interface StartedAttempt {
  readonly run: AttemptRun;
  readonly promise: Promise<Response>;
}

interface HedgedAttemptDeps {
  readonly h: CandidateRunnerHandlers;
  readonly res: ServerResponse;
  readonly walk: CredentialWalk;
  readonly credentialTrace: CredentialAttemptTrace;
  readonly attemptTrace: RequestAttemptTrace;
  readonly tracker: Pool429Tracker;
  /** The relay's own chars/4 estimate of THIS request's input size — see `hedge-trigger.ts`. */
  readonly estimatedInputTokens: number;
  startRun(offer: ResolvedAttempt): StartedAttempt | undefined;
}

interface HedgedAttemptResult {
  readonly run: AttemptRun;
  readonly settled: Settled<Response>;
  readonly hedged: string | null;
}

function settleResponse(promise: Promise<Response>): Promise<Settled<Response>> {
  return promise.then(
    (value) => ({ ok: true, value }) as Settled<Response>,
    (error: unknown) => ({ ok: false, error }) as Settled<Response>,
  );
}

function walkWouldFailOver(response: Response): boolean {
  return errorOrigin(response) !== "local" && shouldTryNext(classifyStatus(response.status));
}

/**
 * The commit-probe verdict `withCommitProbe` attached to a streamed 2xx response, keyed by the
 * Response object itself so no signature on the walk changes. Consumed exactly once through
 * `takeCommitProbe`.
 */
const COMMIT_PROBES = new WeakMap<Response, StreamCommitProbe>();

interface CommitProbeOptions {
  readonly protocol: StreamCommitProtocol;
  /** Client cancellation wins races with EOF/read failures and must never start another target. */
  readonly isCancelled: () => boolean;
  /** Malformed final wire produced by a response mapper is a local defect, not target health. */
  readonly malformedProvenance: "upstream" | "local";
}

/**
 * Run the stream-commit probe INSIDE the attempt's own promise, so the hedge race settles at
 * COMMIT — the first meaningful content — rather than at header arrival (2026-09-04, owner
 * direction: the hedge exists for wedged requests, and a provider that answers 200 + headers at
 * once and then produces nothing is the common wedge; a race decided at RESPONSE RESOLUTION had
 * already called that primary the winner, and `hedge-race.ts` recorded the gap in as many words).
 * A non-streamed or non-2xx response passes through untouched — the walk's own status
 * classification decides those. The verdict rides beside the response for the route to consume
 * through `takeCommitProbe`; the route keeps its inline probe only as the fallback for a response
 * that did not come through this wrapper.
 *
 * ⚠ The probe reads the body up to the first meaningful event and the `ready` verdict replays
 * every byte it consumed, so a committed winner is served byte-exact as before. A LOSER's probe is
 * left to settle on its own after `retireHedgeLoser` aborts its run — the race ignores a late
 * settlement — and that abort is what cancels its body.
 */
export async function withCommitProbe(promise: Promise<Response>, options: CommitProbeOptions): Promise<Response> {
  const response = await promise;
  if (response.status >= 400) return response;
  if (!(response.headers.get("content-type") ?? "").includes("text/event-stream")) return response;
  const relayRefusal = dialectRefusalSignalOf(response);
  const probe: StreamCommitProbe = response.body
    ? await probeStreamForCommit(response.body, options.protocol, {
        isCancelled: options.isCancelled,
        malformedProvenance: options.malformedProvenance,
        ...(relayRefusal ? { relayRefusal } : {}),
      })
    : { kind: "dead", reason: "stream has no body", provenance: "upstream" };
  COMMIT_PROBES.set(response, probe);
  return response;
}

/** The verdict `withCommitProbe` attached, removed on read so it is consumed exactly once. */
export function takeCommitProbe(response: Response): StreamCommitProbe | undefined {
  const probe = COMMIT_PROBES.get(response);
  if (probe) COMMIT_PROBES.delete(response);
  return probe;
}

/**
 * Has this settlement WON the race? Two questions, one policy. The walk would not fail over from
 * the status — a 429 has not won, it was going to be walked past anyway — AND a streamed response
 * has COMMITTED: a probe that found the stream dead, or the client gone, has not won either, and
 * the walk moves on from it exactly as it does from a failing status. A response the probe never
 * touched — buffered, or not a stream — is judged on its status alone, as before.
 */
export function attemptWon(settled: Settled<Response>): boolean {
  if (!settled.ok || walkWouldFailOver(settled.value)) return false;
  const probe = COMMIT_PROBES.get(settled.value);
  return probe === undefined || probe.kind === "ready";
}

/**
 * ⚠ **Carries the input-token count only when `basis` is `"input-size"`** — the case the flat
 * `floor` label used to cover alone. A `per-token`/`absolute` decision keeps its bare basis: the
 * DEPLOYMENT's own evidence set that bar, not the request's size, and stating a token count beside
 * it would claim size decided a number the deployment actually did.
 */
export function hedgedLabel(
  primary: AttemptRun,
  hedge: AttemptRun,
  winner: "primary" | "hedge",
  decision: HedgeDelayDecision,
): string {
  const side = winner === "hedge" ? "hedge won" : "primary won";
  const basis =
    decision.basis === "input-size" && decision.estimatedInputTokens !== undefined
      ? `input-size ${decision.estimatedInputTokens} tokens`
      : decision.basis;
  return `${specOfTarget(primary.target)} -> ${specOfTarget(hedge.target)} (${side} after ${decision.delayMs}ms, ${basis})`;
}

export function retireHedgeLoser(deps: HedgedAttemptDeps, loser: AttemptRun): void {
  releaseAttemptRun(deps.res, loser);
  try {
    loser.controller.abort();
  } catch {
    // best effort
  }
  if (loser.attempt) {
    completeAttemptAbandoned(deps.h, loser.attempt, "hedge loser aborted");
    deps.credentialTrace.record(loser.resolvedAttempt, { kind: "cancelled" });
    deps.walk.recordAbandoned(loser.resolvedAttempt);
  } else if (deps.walk.isPending(loser.resolvedAttempt)) {
    deps.walk.recordRejected(loser.resolvedAttempt);
  }
}

export async function runAttemptWithHedge(
  primary: StartedAttempt,
  deps: HedgedAttemptDeps,
): Promise<HedgedAttemptResult> {
  const decision = deps.h.hedgeDelay(primary.run.resolvedAttempt, deps.estimatedInputTokens);
  if (decision === null) {
    return { run: primary.run, settled: await settleResponse(primary.promise), hedged: null };
  }

  let hedge: StartedAttempt | undefined;
  let raced: HedgeRaceResult<Response>;
  try {
    raced = await raceWithHedge<Response>({
      primary: { promise: primary.promise, abort: () => primary.run.controller.abort() },
      delayMs: decision.delayMs,
      startHedge: (): RaceEntrant<Response> | undefined => {
        if (deps.res.destroyed) return undefined;
        const offer = nextUncappedAttempt(deps.h, deps.walk, deps.attemptTrace, deps.tracker);
        if (!offer) return undefined;
        if (offer === primary.run.resolvedAttempt) return undefined;
        const started = deps.startRun(offer);
        if (!started) return undefined;
        hedge = started;
        return { promise: started.promise, abort: () => started.run.controller.abort() };
      },
      isWin: attemptWon,
    });
  } catch (e) {
    if (hedge) retireHedgeLoser(deps, hedge.run);
    throw e;
  }

  if (!raced.hedgeStarted || !hedge) {
    return { run: primary.run, settled: raced.settled, hedged: null };
  }
  const winner = raced.winner === "hedge" ? hedge.run : primary.run;
  const loser = raced.winner === "hedge" ? primary.run : hedge.run;
  retireHedgeLoser(deps, loser);
  return { run: winner, settled: raced.settled, hedged: hedgedLabel(primary.run, hedge.run, raced.winner, decision) };
}

type WalkExitKind = "transport" | "post-header-body-failure" | "dead-stream";

interface WalkExitData {
  kind: WalkExitKind;
  message: string;
  errorType?: string | undefined;
  errorOrigin?: ErrorOrigin;
  servedBy?: string;
  shouldTryNext?: boolean;
}

export function walkExitHeaders(
  tracker: Pool429Tracker,
  sticky: StickyRequestContext | null | undefined,
  credentialTrace: CredentialAttemptTrace,
  {
    errorOrigin,
    errorType,
    servedBy,
  }: Pick<WalkExitData, "errorOrigin" | "errorType" | "servedBy"> = {},
): Record<string, string> {
  const before: Record<string, string> = {};
  if (servedBy !== undefined) before[SERVED_BY_HEADER] = servedBy;
  if (errorOrigin !== undefined) before[ERROR_ORIGIN_HEADER] = errorOrigin;

  const after = errorType === DIALECT_REFUSED_DESTRUCTIVE_CODE
    ? { [TOOL_DIALECT_HEADER]: "refused-destructive" }
    : {};
  const headers: Record<string, string> = {
    ...before,
    ...(stickyProvenanceHeaders(sticky) ?? {}),
    ...credentialTrace.headers(),
    ...after,
  };
  const summary = tracker.summary();
  if (summary) headers[POOL_ATTEMPTS_HEADER] = summary;
  return headers;
}

export function endWalk(
  h: { hardCap: (attempt: ResolvedAttempt, now: number) => HardCapVerdict | null; logger: MetadataLogger },
  res: ServerResponse,
  front: "anthropic" | "openai",
  walk: CredentialWalk,
  attemptTrace: RequestAttemptTrace,
  tracker: Pool429Tracker,
  status: number,
  sticky: StickyRequestContext | null | undefined,
  credentialTrace: CredentialAttemptTrace,
  log: () => RequestLog,
  exit: WalkExitData,
): boolean {
  const shouldTryNext = exit.shouldTryNext ?? true;
  let next: ResolvedAttempt | undefined;

  if (exit.kind === "dead-stream") {
    const canContinue = front === "anthropic"
      ? !res.destroyed
      : !res.writableEnded && !res.destroyed;
    next = shouldTryNext && canContinue
      ? nextUncappedAttempt(h, walk, attemptTrace, tracker)
      : undefined;
  } else {
    next = shouldTryNext ? nextUncappedAttempt(h, walk, attemptTrace, tracker) : undefined;
    if (res.writableEnded || res.destroyed) next = undefined;
  }

  if (next) {
    tracker.recordFailover(status, null);
    return true;
  }

  tracker.recordFinal(status);
  const headers = walkExitHeaders(tracker, sticky, credentialTrace, exit);
  if (front === "anthropic") {
    failClosed(
      res,
      status,
      exit.message,
      Object.keys(headers).length > 0 ? headers : undefined,
      exit.errorType,
    );
  } else if (!res.headersSent) {
    res.writeHead(status, { "content-type": "application/json", ...headers });
    res.end(JSON.stringify({
      error: { message: exit.message, type: exit.errorType ?? "api_error" },
    }));
  }
  h.logger.write(log());
  return false;
}

export function respondAllCapped(
  res: ServerResponse,
  h: { logger: MetadataLogger },
  ctx: { started: number; path: string; hadTools: boolean; streamed: boolean },
  front: "anthropic" | "openai",
  tracker: Pool429Tracker,
  attempts: readonly RequestAttemptLog[],
): void {
  if (res.headersSent) return;
  const summary = tracker.summary();
  const capped = tracker.cappedSummary();
  const labels = capped ?? "every candidate";
  const resetAt = tracker.cappedResetAt();
  const message =
    `llm-relay: request refused by operator-declared hard cap(s): ${labels}. ` +
    `No provider was contacted.` +
    (resetAt !== null
      ? ` The earliest cap lifts at ${new Date(resetAt).toISOString()} (its UTC period boundary).`
      : ` No reset boundary could be derived, so no retry-after is offered.`);
  const headers: Record<string, string> = {};
  if (summary) headers[POOL_ATTEMPTS_HEADER] = summary;
  if (capped !== null) headers[HARD_CAP_HEADER] = capped;
  if (resetAt !== null && resetAt > Date.now()) {
    headers["retry-after"] = String(Math.max(1, Math.ceil((resetAt - Date.now()) / 1000)));
  }
  const body = front === "openai"
    ? { error: { message, type: "rate_limit_error", code: "llm_relay_capped" } }
    : { type: "error" as const, error: { type: "rate_limit_error", message } };
  res.writeHead(429, { ...headers, "content-type": "application/json" });
  res.end(JSON.stringify(body));
  h.logger.write(baseLog(ctx.started, ctx.path, ctx.hadTools, ctx.streamed, 429, "skipped", null, attempts));
}

export function applyStickyOrdering(
  ordered: ResolvedAttempt[],
  pinnedSpec: string,
  breaker: CircuitBreaker,
  degraded: Set<string> | null,
  now: number,
  quotaDemotion?: QuotaDemotionFn | null,
  costClassOf?: CostClassFn | null,
  latencyDemotion?: LatencyDemotionFn | null,
  // ⚠ Threaded so a pinned candidate the probation band would place is judged by the SAME
  // closed union as every other caller of `targetUsability` — a call site that omits it would
  // silently read such a candidate as "live" and pin it, defeating "a pin may promote only a
  // live member" (see the gotcha in CLAUDE.md). `latencyDemotion` above is left exactly as this
  // call site already had it (undefined at the one production call site in `server.ts`); fixing
  // that pre-existing gap is out of this packet's scope.
  probation?: ProbationFn | null,
): { targets: ResolvedAttempt[]; status: string } {
  const groups = groupCredentialAttempts(ordered);
  const pinnedIndex = groups.findIndex((group) => specOfTarget(group.attempts[0]!.target) === pinnedSpec);
  const pinnedGroup = pinnedIndex < 0 ? undefined : groups[pinnedIndex];
  const pinned = pinnedGroup?.attempts[0];
  if (!pinned || !pinnedGroup) return { targets: ordered, status: "bypassed: not-in-pool" };

  const usability = targetUsability(pinned, breaker, now, quotaDemotion, costClassOf, latencyDemotion, probation);
  if (usability !== "live") return { targets: ordered, status: `bypassed: ${usability}` };

  if (degraded?.has(pinnedSpec)) {
    const hasLiveInBand = groups.some(
      (group) => {
        const candidate = group.attempts[0]!;
        return !degraded.has(specOfTarget(candidate.target)) &&
          targetUsability(candidate, breaker, now, quotaDemotion, costClassOf, latencyDemotion, probation) === "live";
      },
    );
    if (hasLiveInBand) return { targets: ordered, status: "bypassed: degraded" };
  }

  if (pinnedIndex === 0) return { targets: ordered, status: "pinned, natural" };
  const reordered = [pinnedGroup, ...groups.filter((_, index) => index !== pinnedIndex)]
    .flatMap((group) => group.attempts);
  return { targets: reordered, status: "pinned, reordered" };
}

function stickyHeaderValue(
  sticky: StickyRequestContext | null | undefined,
  target: ResolvedTarget,
  status: number,
): string | null {
  if (!sticky) return null;
  if (sticky.provenance) return sticky.provenance;
  if (status < 400 && sticky.multiCandidateRoute) return `${specOfTarget(target)} (new)`;
  return null;
}

export function stickyProvenanceHeaders(
  sticky: StickyRequestContext | null | undefined,
): Record<string, string> | undefined {
  return sticky?.provenance ? { [STICKY_PROVENANCE_HEADER]: sticky.provenance } : undefined;
}

export function recordStickySuccess(
  h: { stickySessions?: StickySessionManager },
  sticky: StickyRequestContext | null | undefined,
  target: ResolvedTarget,
  status: number,
): void {
  if (status >= 400 || !sticky?.multiCandidateRoute) return;
  h.stickySessions?.setPin(sticky.key, specOfTarget(target));
}

/**
 * Demote unusable candidates — and do NOTHING else to the order.
 *
 * ⚠ Deliberately NOT `getHealthyTargets()`: that filters AND re-sorts by measured stability, which
 * is a second ranking pass competing with the deployment-fitness ranking `resolveTargets` already
 * applied. Two ranking passes means neither decides the order, and live health then PROMOTES on
 * evidence that is often a single request's latency. Health is used here only to demote, never to
 * promote: a target the breaker is cooling steps aside, everything else keeps its fitness order.
 * (The re-sort was invisible for as long as an untracked target scored a flat 100 and
 * `Array.prototype.sort` is stable — INV-TS-7.)
 *
 * ⚠⚠ **AMENDED BY OWNER DECISION 2026-08-30, and this is NOT drift — do not "restore" it.**
 * Latency now DOES demote, via `latency-demotion.ts` folded into `targetUsability` beside the quota
 * term. The paragraph above stays because every word of it is still the constraint: what was
 * rejected is a second ranking PASS that re-sorts and can PROMOTE on one request's latency, and
 * that remains rejected. A one-way demotion term is a different thing — it never re-sorts, never
 * promotes, and cannot fire on a single sample (p95 over a minimum count of MEASURABLE samples,
 * unmeasured having no effect at all).
 *
 * What forced the amendment: measured 2026-08-30, banding on breaker state ALONE walked a
 * breaker-CLOSED member with a p95 of 70364 ms ahead of every cooling one, and single requests cost
 * 120-123 s across 2-6 attempts.
 *
 * ⚠⚠ **AMENDED AGAIN BY OWNER DIRECTION 2026-09-09, same standing — do not "restore" it.** A
 * free deployment with fewer than `minSamples` served-request samples now LEADS, in a
 * `probation` band AHEAD of `live` (config order within the band), so one untested member at a
 * time gathers data and leaves the band by itself as its request samples accumulate. Like the
 * 2026-08-30 term this is a one-way placement, not a second ranking pass: fitness still decides
 * the order everywhere else, nothing is dropped, and an unmeasured free primary is already
 * hedged (`hedge-trigger.ts`: unmeasured IS hedged), so a probation member that hangs costs one
 * hedge, not a timeout — no second mechanism is added here.
 */
export function orderByUsability(
  attempts: ResolvedAttempt[],
  breaker = globalCircuitBreaker,
  now = Date.now(),
  quotaDemotion?: QuotaDemotionFn | null,
  costClassOf?: CostClassFn | null,
  latencyDemotion?: LatencyDemotionFn | null,
  probation?: ProbationFn | null,
): ResolvedAttempt[] {
  const { ordered } = orderByUsabilityTracked(attempts, breaker, now, quotaDemotion, costClassOf, latencyDemotion, probation);
  return ordered;
}

export function orderByUsabilityTracked(
  attempts: ResolvedAttempt[],
  breaker: CircuitBreaker,
  now: number,
  quotaDemotion?: QuotaDemotionFn | null,
  costClassOf?: CostClassFn | null,
  latencyDemotion?: LatencyDemotionFn | null,
  probation?: ProbationFn | null,
): {
  ordered: ResolvedAttempt[];
  quotaDemotedFirst: string | null;
  latencyDemotedFirst: string | null;
} {
  const probationMembers: ResolvedAttempt[] = [];
  const live: ResolvedAttempt[] = [];
  const slow: ResolvedAttempt[] = [];
  const faulted: ResolvedAttempt[] = [];
  const cooling: ResolvedAttempt[] = [];
  for (const attempt of attempts) {
    const usability = targetUsability(attempt, breaker, now, quotaDemotion, costClassOf, latencyDemotion, probation);
    switch (usability) {
      case "probation":
        probationMembers.push(attempt);
        break;
      case "live":
        live.push(attempt);
        break;
      case "slow":
        slow.push(attempt);
        break;
      case "credential-fault":
        faulted.push(attempt);
        break;
      case "cooling":
        cooling.push(attempt);
        break;
      default: {
        const _never: never = usability;
        throw new Error(`unhandled TargetUsability: ${_never}`);
      }
    }
  }

  cooling.sort((a, b) => {
    const liftA = coolingLiftTime(a, breaker, now, costClassOf);
    const liftB = coolingLiftTime(b, breaker, now, costClassOf);
    if (liftA === null && liftB === null) return 0;
    if (liftA === null) return 1;
    if (liftB === null) return -1;
    return liftA - liftB;
  });

  const ordered = [...probationMembers, ...live, ...slow, ...faulted, ...cooling];
  return { ordered, quotaDemotedFirst: null, latencyDemotedFirst: null };
}

/** What one HTTP status means to the walk: how to classify the outcome, and whether the body may
 * carry an eligibility fact worth interpreting. */
interface StatusVerdict {
  readonly outcome: OutcomeClass;
  readonly carriesEligibilityFact: boolean;
}

/**
 * The statuses this relay has a specific opinion about — SEM-04 in the 2026-09-05 duplication
 * catalog, REFINE ("outcome-class table only") in the adversarial verification.
 *
 * `classifyStatus` and `carriesEligibilityFact` each carried their own membership list, and the
 * two lists were the same seven statuses written twice. They read this table now, so a status
 * cannot be retriable in one and eligibility-bearing in neither.
 *
 * ⚠ It is deliberately NOT the whole classification. HTTP status is an unbounded integer domain,
 * not a closed union, so the two RANGE rules — under 400, and 500 and above — stay in
 * `statusVerdict` below where a table cannot express them.
 *
 * ⚠ Membership here is policy. Do not add or move a row as part of a mechanical change; every
 * entry is a decision about failover, and `CLAUDE.md` records why 402 sits with the retriable
 * statuses rather than the client ones (on the free providers this proxy fronts it means
 * depleted credits, not a malformed request).
 */
export const STATUS_VERDICT_TABLE: Readonly<Record<number, StatusVerdict>> = Object.freeze({
  400: { outcome: "retriable", carriesEligibilityFact: true },
  401: { outcome: "credential", carriesEligibilityFact: true },
  402: { outcome: "retriable", carriesEligibilityFact: true },
  403: { outcome: "credential", carriesEligibilityFact: true },
  404: { outcome: "retriable", carriesEligibilityFact: true },
  410: { outcome: "retriable", carriesEligibilityFact: true },
  429: { outcome: "retriable", carriesEligibilityFact: true },
});

const UNLISTED_BELOW_400: StatusVerdict = Object.freeze({ outcome: "ok", carriesEligibilityFact: false });
const UNLISTED_SERVER_ERROR: StatusVerdict = Object.freeze({ outcome: "retriable", carriesEligibilityFact: false });
const UNLISTED_CLIENT_ERROR: StatusVerdict = Object.freeze({ outcome: "client", carriesEligibilityFact: false });

/**
 * The one reading of an HTTP status both classifiers now share.
 *
 * ⚠ An unlisted 4xx falls to `client` — the WEAKER claim, meaning the walk does NOT fail over.
 * That direction is the safe one for a status nobody has reasoned about, and it is what both
 * hand-written chains already did.
 */
export function statusVerdict(status: number): StatusVerdict {
  const listed = STATUS_VERDICT_TABLE[status];
  if (listed !== undefined) return listed;
  if (status < 400) return UNLISTED_BELOW_400;
  if (status >= 500) return UNLISTED_SERVER_ERROR;
  return UNLISTED_CLIENT_ERROR;
}

export function classifyStatus(status: number): OutcomeClass {
  return statusVerdict(status).outcome;
}

export function shouldTryNext(cls: OutcomeClass): boolean {
  return cls === "retriable" || cls === "credential";
}

export class Pool429Tracker {
  private minRetryAfterMs: number | null = null;
  private only429 = true;
  private readonly counts = new Map<number | "dead-turn", number>();
  private readonly firstSeenAt = new Map<number | "dead-turn" | "capped", number>();
  private order = 0;
  private inFlight = false;
  private deferredCapped = false;
  private readonly cappedLabels: string[] = [];
  private soonestCapResetAt: number | null = null;
  private egressed = false;

  noteEgress(): void {
    this.egressed = true;
  }

  noteOffered(): void {
    this.inFlight = true;
  }

  private stamp(key: number | "dead-turn" | "capped"): void {
    if (!this.firstSeenAt.has(key)) this.firstSeenAt.set(key, ++this.order);
  }

  private stampCapped(): void {
    if (!this.deferredCapped) return;
    this.deferredCapped = false;
    this.stamp("capped");
  }

  recordFailover(status: number, retryAfterMs: number | null): void {
    this.count(status);
    if (status === 429) {
      if (retryAfterMs !== null) {
        this.minRetryAfterMs = this.minRetryAfterMs === null ? retryAfterMs : Math.min(this.minRetryAfterMs, retryAfterMs);
      }
    } else {
      this.only429 = false;
    }
  }

  recordFinal(status: number): void {
    this.count(status);
  }

  recordCapped(label: string, resetsAt: number): void {
    if (this.inFlight) this.deferredCapped = true;
    else this.stamp("capped");
    this.cappedLabels.push(label);
    this.soonestCapResetAt =
      this.soonestCapResetAt === null ? resetsAt : Math.min(this.soonestCapResetAt, resetsAt);
  }

  cappedResetAt(): number | null {
    return this.soonestCapResetAt;
  }

  allCapped(): boolean {
    return this.cappedLabels.length > 0 && this.counts.size === 0 && !this.egressed;
  }

  cappedSummary(): string | null {
    if (this.cappedLabels.length === 0) return null;
    if (this.cappedLabels.length <= MAX_CAPPED_HEADER_CELLS) return this.cappedLabels.join("; ");
    const shown = this.cappedLabels.slice(0, MAX_CAPPED_HEADER_CELLS).join("; ");
    return `${shown}; +${this.cappedLabels.length - MAX_CAPPED_HEADER_CELLS} more`;
  }

  recordDeadTurn(): void {
    this.only429 = false;
    this.count("dead-turn");
  }

  private unknownRefusals = 0;
  noteUnknownRefusal(): void {
    this.unknownRefusals += 1;
  }

  unknownCount(): number | null {
    return this.unknownRefusals > 0 ? this.unknownRefusals : null;
  }

  private count(status: number | "dead-turn"): void {
    this.counts.set(status, (this.counts.get(status) ?? 0) + 1);
    this.stamp(status);
    this.inFlight = false;
    this.stampCapped();
  }

  summary(): string | null {
    let tried = 0;
    let served = 0;
    for (const [status, n] of this.counts) {
      tried += n;
      if (typeof status === "number" && status < 400) served += n;
    }
    tried += this.cappedLabels.length;
    if (tried < 2) return null;
    this.stampCapped();
    const parts = [...this.firstSeenAt.entries()]
      .sort((a, b) => a[1] - b[1])
      .map(([key]) => (key === "capped" ? `${this.cappedLabels.length}xcapped` : `${this.counts.get(key) ?? 0}x${key}`));
    return `${tried} tried, ${served} served: ${parts.join(", ")}`;
  }

  overrideMs(finalStatus: number, finalRetryAfterMs: number | null): number | undefined {
    if (finalStatus !== 429 || !this.only429 || this.minRetryAfterMs === null) return undefined;
    return Math.min(this.minRetryAfterMs, finalRetryAfterMs ?? Infinity);
  }
}

function recordCall(
  h: { modelCallRecorder?: ModelCallRecorder },
  attempt: HealthAttempt,
  ok: boolean,
  completedAt: number,
): void {
  const { target, usage } = attempt;
  if (!target.model || !h.modelCallRecorder) return;
  try {
    h.modelCallRecorder(target.provider, target.model, {
      ok,
      latencyMs: completedAt - attempt.started,
      ...(usage.completionTokens !== undefined ? { completionTokens: usage.completionTokens } : {}),
    });
  } catch {
    // best-effort
  }
}

export class RequestAttemptTrace {
  private readonly entries: RequestAttemptLog[] = [];

  record(target: ResolvedTarget, status: RequestAttemptStatus, started: number, completedAt: number): void {
    if (this.entries.length >= MAX_LOG_ATTEMPTS) return;
    this.entries.push({
      provider: target.provider,
      model: target.model ?? null,
      status,
      ms: Math.max(0, completedAt - started),
    });
  }

  recordCapped(target: ResolvedTarget, at: number): void {
    this.record(target, "capped", at, at);
  }

  snapshot(): RequestAttemptLog[] {
    return this.entries.map((entry) => ({ ...entry }));
  }
}

export interface HealthAttempt {
  readonly handle: AttemptHandle;
  readonly identity: ProviderTargetIdentity;
  readonly resolvedAttempt: ResolvedAttempt;
  readonly target: ResolvedTarget;
  readonly started: number;
  readonly trace: RequestAttemptTrace;
  readonly usage: UsageAccumulator;
  readonly accounting: RequestAccountingState | null;
  accountingAttempt: AccountingAttempt | null;
  completed: boolean;
  committed: boolean;
  terminal?: "succeeded" | "failed" | "cancelled";
}

export function targetIdentity(attempt: ResolvedAttempt): ProviderTargetIdentity {
  const { target } = attempt;
  return Object.freeze({
    provider: target.provider,
    model: target.model ?? null,
    kind: target.kind,
    credentialId: attempt.credentialId,
    base: target.base,
  });
}

export function beginHealthAttempt(
  h: { breaker: CircuitBreaker },
  resolvedAttempt: ResolvedAttempt,
  started: number,
  trace: RequestAttemptTrace,
  usage: UsageAccumulator,
  accounting: RequestAccountingState | null,
): HealthAttempt | null {
  const identity = targetIdentity(resolvedAttempt);
  const begun = h.breaker.beginAttempt(identity);
  if (!begun.ok) return null;
  return {
    committed: false,
    handle: begun.value,
    identity,
    resolvedAttempt,
    target: resolvedAttempt.target,
    started,
    trace,
    usage,
    accounting,
    accountingAttempt: null,
    completed: false,
  };
}

function abortOnClientClose(
  res: ServerResponse,
  callerController: AbortController,
  controller: AbortController,
): () => void {
  return () => {
    if (!res.writableEnded) {
      callerController.abort();
      controller.abort();
    }
  };
}

function observeContextLimit(status: number, target: ResolvedTarget, body: string): void {
  if (status !== 400 && status !== 413) return;
  if (target.model === undefined) return;
  try {
    if (!looksLikeContextLengthError(body)) return;
    const stated = parseStatedContextLimit(body);
    if (stated === null) return;
    recordObservedContextLimit(target.provider, target.model, stated);
  } catch {
    // best-effort
  }
}

function observeMaxOutput(status: number, target: ResolvedTarget, body: string): void {
  if (status !== 400 && status !== 413) return;
  if (target.model === undefined) return;
  try {
    if (!looksLikeMaxOutputError(body)) return;
    const stated = parseStatedMaxOutput(body);
    if (stated === null) return;
    recordObservedMaxOutput(target.provider, target.model, stated);
  } catch {
    // best-effort
  }
}

function observeStatedRateLimits(attempt: HealthAttempt, observations: QuotaObservation[]): void {
  if (observations.length === 0) return;
  const { target } = attempt;
  if (target.model === undefined) return;
  try {
    for (const o of observations) {
      if (!Number.isFinite(o.limit) || o.limit <= 0) continue;
      if (o.period !== "minute" && o.period !== "day") continue;
      recordObservedRateLimit(target.provider, attempt.resolvedAttempt.credentialId, target.model, [
        { axis: o.axis, period: o.period, limit: Math.floor(o.limit) },
      ]);
    }
  } catch {
    // best-effort
  }
}

function observeRateLimit(attempt: ResolvedAttempt, status: number, body: string): void {
  if (status !== 429) return;
  if (attempt.target.model === undefined) return;
  try {
    if (!looksLikeRateLimitError(body)) return;
    const stated = parseStatedRateLimit(body);
    if (stated === null) return;
    recordObservedRateLimit(attempt.target.provider, attempt.credentialId, attempt.target.model, stated);
  } catch {
    // best-effort
  }
}

type EligibilityObservation = { readonly unknown: boolean; readonly scope?: ReturnType<typeof materializeScope> };

function refusalBodyCandidates(body: string): string[] {
  const candidates: string[] = [];
  const queued: string[] = [body];
  const seen = new Set<string>();
  while (queued.length > 0 && candidates.length < 24) {
    const text = queued.shift()!;
    if (!text || seen.has(text)) continue;
    seen.add(text);
    candidates.push(text);

    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch {
      for (let index = 0; index < text.length; index++) {
        if (text[index] !== "{" && text[index] !== "[") continue;
        const nested = text.slice(index);
        try {
          JSON.parse(nested);
          queued.push(nested);
          break;
        } catch {
          // continue search
        }
      }
      continue;
    }

    const visit = (value: unknown, depth: number): void => {
      if (depth > 6 || candidates.length + queued.length >= 24) return;
      if (typeof value === "string") {
        if (!seen.has(value)) queued.push(value);
        return;
      }
      if (Array.isArray(value)) {
        for (const item of value) visit(item, depth + 1);
        return;
      }
      if (typeof value === "object" && value !== null) {
        for (const item of Object.values(value as Record<string, unknown>)) {
          visit(item, depth + 1);
        }
      }
    };
    visit(parsed, 0);
  }
  return candidates;
}

export function observeEligibility(attempt: ResolvedAttempt, status: number, retryAfterMs: number | null, body: string): EligibilityObservation {
  const { target } = attempt;
  if (target.model === undefined) return { unknown: false };
  try {
    let matchedBody = body;
    let verdict: ReturnType<typeof interpretRefusal> = null;
    for (const candidate of refusalBodyCandidates(body)) {
      verdict = interpretRefusal(target.provider, target.model, status, candidate);
      if (verdict !== null) {
        matchedBody = candidate;
        break;
      }
    }
    if (verdict === null) {
      recordUnknownRefusal(target.provider, target.model, status, body);
      return { unknown: true };
    }
    const scope = materializeScope(
      verdict.scope,
      target.provider,
      attempt.credentialId,
      target.model,
    );
    const reset = resolveReset(verdict, retryAfterMs, matchedBody);
    recordFact(verdict.class, scope, {
      retryAfterMs: reset?.ms ?? null,
      ...(reset === null ? {} : { untilBasis: reset.basis }),
      ...(verdict.costClasses === undefined ? {} : { costClasses: verdict.costClasses }),
    });
    return { unknown: false, scope };
  } catch {
    // best-effort
  }
  return { unknown: false };
}

export function freeOnlyApplies(rule: { freeOnly?: boolean }, rerouted: boolean): boolean {
  return rule.freeOnly ?? rerouted;
}

export function resolveReset(
  interpretation: Interpretation,
  headerMs: number | null,
  body: string,
): { ms: number; basis: FactResetBasis } | null {
  if (headerMs !== null) return { ms: headerMs, basis: "retry-after" };
  if (interpretation.reset?.kind === "field") {
    const fromField = applyResetRule(interpretation.reset, body);
    if (fromField !== null) return { ms: fromField, basis: "reviewed-field" };
  }
  const generic = parseStatedResetMs(body);
  if (generic !== null) return { ms: generic, basis: "stated-body" };
  if (interpretation.reset?.kind === "fixed") {
    const fixed = applyResetRule(interpretation.reset, body);
    if (fixed !== null) return { ms: fixed, basis: "reviewed-fixed" };
  }
  return null;
}

export function carriesEligibilityFact(status: number): boolean {
  return statusVerdict(status).carriesEligibilityFact;
}

type InspectedCandidateResponse =
  | {
      kind: "response";
      response: Response;
      eligibility: EligibilityObservation;
    }
  | PostHeaderBodyFailure;

export async function inspectCandidateResponse(
  res: Response,
  attempt: ResolvedAttempt,
  retryAfterMs: number | null,
): Promise<InspectedCandidateResponse> {
  const propagatedFailure = postHeaderBodyFailure(res);
  if (propagatedFailure) return propagatedFailure;
  const status = res.status;
  if (status < 400) {
    return { kind: "response", response: res, eligibility: { unknown: false } };
  }
  let bytes: Buffer;
  try {
    bytes = Buffer.from(await res.arrayBuffer());
  } catch (cause) {
    return { kind: "post-header-body-failure", cause };
  }
  const body = bytes.toString("utf8");
  observeContextLimit(status, attempt.target, body);
  observeMaxOutput(status, attempt.target, body);
  observeRateLimit(attempt, status, body);
  const eligibility = carriesEligibilityFact(status) && body
    ? observeEligibility(attempt, status, retryAfterMs, body)
    : { unknown: false };
  return {
    kind: "response",
    response: new Response(bytes, {
      status,
      statusText: res.statusText,
      headers: res.headers,
    }),
    eligibility,
  };
}

export function walkOutcomeForResponse(
  status: number,
  localFailure: boolean,
  scope?: EligibilityObservation["scope"],
): CredentialWalkOutcome {
  if (localFailure) return { kind: "local", status, ...(scope ? { scope } : {}) };
  const cls = classifyStatus(status);
  if (cls === "client") return { kind: "client", status, ...(scope ? { scope } : {}) };
  if (status === 401 || status === 403 || status === 402 || status === 429) {
    return { kind: "credential", status, ...(scope ? { scope } : {}) };
  }
  return { kind: "deployment", status, ...(scope ? { scope } : {}) };
}

export function observeAttemptHeaders(
  h: { breaker: CircuitBreaker },
  attempt: HealthAttempt,
  status: number,
  retryAfterMs: number | null,
  headers?: Headers,
): void {
  const observedAt = Date.now();
  const quotaObservations = headers
    ? extractQuotaObservations(headers, { observedAt })
    : [];
  observeStatedRateLimits(attempt, quotaObservations);
  const result = h.breaker.observeHeaders(attempt.handle, {
    target: attempt.identity,
    status,
    observedAt,
    elapsedMs: observedAt - attempt.started,
    ...(quotaObservations.length > 0 ? { quotaObservations } : {}),
    ...(retryAfterMs !== null ? { retryAfterMs } : {}),
  });
  if (!result.ok) throw new Error(`attempt header observation rejected: ${result.error.kind}`);
}

/**
 * Which provenances name a failure the RELAY authored — a mapping refusal, a dialect-rescue
 * destructive refusal, a malformed final wire the relay's own mapper produced. The breaker's
 * `PROVENANCE_REACHES_HEALTH_PATH` declines to charge exactly these, and the ledger must not blame
 * the provider for them either (contract review DR-003, 2026-09-04): until then a relay-authored
 * refusal carrying `failure: "http"` fell through an unconditional `return "provider_error"`.
 * A total table, never an `else` — a new provenance is a compile error here, not a silent
 * `provider_error`. `ProxyAccountingFailureKind` itself is declared ONCE, in `accounting-state.ts`;
 * this file used to carry a second identical declaration.
 */
const RELAY_AUTHORED_PROVENANCE = {
  "upstream": false,
  "invalid-upstream-envelope": false,
  "deadline": false,
  "client-cancellation": false,
  "relay-mapper-defect": true,
} as const satisfies Record<OutcomeProvenance, boolean>;

export function accountingFailureForAttempt(options: {
  readonly failure: AttemptFailed["failure"];
  readonly provenance: OutcomeProvenance;
  readonly status: number | null;
}): ProxyAccountingFailureKind {
  // The relay's own decision is classified FIRST: a status the relay synthesized (a local 502, a
  // refusal's 4xx) must never read as the provider's auth wall or back-pressure.
  if (RELAY_AUTHORED_PROVENANCE[options.provenance]) return "protocol";
  if (options.status === 401 || options.status === 403) return "auth_error";
  if (options.status === 429) return "rate_limit";
  switch (options.failure) {
    case "protocol":
    case "mapping":
    case "invalid-response":
      return "protocol";
    case "transport":
      return options.provenance === "deadline" ? "timeout" : "provider_error";
    case "http":
      return "provider_error";
    default: {
      const _never: never = options.failure;
      return _never;
    }
  }
}

export function markAttemptCommitted(attempt: HealthAttempt | undefined): void {
  if (!attempt) return;
  // Recorded on the attempt itself, not only through the optional accounting recorder: the
  // cancellation classifier must answer the same way on a relay running with no accounting.
  attempt.committed = true;
  attempt.accounting?.markCommitted(attempt.accountingAttempt, Date.now());
}

export function completeAttemptSuccess(
  h: { breaker: CircuitBreaker; modelCallRecorder?: ModelCallRecorder; costClassOf?: CostClassFn | null },
  attempt: HealthAttempt,
  status: number,
): void {
  if (attempt.completed) return;
  // A success retracts the CONDITIONS on this cell — but a fact filtered to a cost class is
  // retracted only by a success INSIDE that class. Measured 2026-09-04: a success on a FREE Zen
  // deployment retracted the accepted `subscription-required` fact filtered to `paid`, 837 min
  // early, and re-admitted the paid SKUs it excluded. The class comes from the SAME resolver the
  // walk orders by (`h.costClassOf`), so cost has one definition here rather than a fifth one
  // re-derived per route; a caller with no resolver passes `undefined`, and a filtered fact then
  // survives (a success of unknown class disproves nothing about a subset).
  const costClass = h.costClassOf?.(attempt.resolvedAttempt);
  const completedAt = Date.now();
  const result = h.breaker.completeAttempt(attempt.handle, {
    terminal: "succeeded",
    target: attempt.identity,
    provenance: "upstream",
    completedAt,
    elapsedMs: completedAt - attempt.started,
    status,
  });
  if (!result.ok) throw new Error(`attempt completion rejected: ${result.error.kind}`);
  attempt.completed = true;
  attempt.terminal = "succeeded";
  attempt.trace.record(attempt.target, status, attempt.started, completedAt);
  recordCall(h, attempt, true, completedAt);
  attempt.accounting?.complete(attempt.accountingAttempt, "success", null, attempt.usage, completedAt);
  try {
    const cleared = clearFacts(
      attempt.target.provider,
      attempt.resolvedAttempt.credentialId,
      attempt.target.model ?? null,
      { costClass },
    );
    if (cleared.includes("credential-invalid")) {
      h.breaker.clearCredentialFaults(attempt.resolvedAttempt.credentialId);
    }
  } catch {
    // best-effort
  }
}

export function completeAttemptFailure(
  h: { breaker: CircuitBreaker; modelCallRecorder?: ModelCallRecorder },
  attempt: HealthAttempt,
  options: {
    failure: AttemptFailed["failure"];
    provenance: OutcomeProvenance;
    status: number | null;
    retryAfterMs?: number | null;
    logStatus?: RequestAttemptStatus;
  },
): void {
  if (attempt.completed) return;
  const completedAt = Date.now();
  const result = h.breaker.completeAttempt(attempt.handle, {
    terminal: "failed",
    target: attempt.identity,
    provenance: options.provenance,
    completedAt,
    elapsedMs: completedAt - attempt.started,
    failure: options.failure,
    status: options.status,
    retryAfterMs: options.retryAfterMs ?? null,
  });
  if (!result.ok) throw new Error(`attempt completion rejected: ${result.error.kind}`);
  attempt.completed = true;
  attempt.terminal = "failed";
  attempt.trace.record(
    attempt.target,
    options.logStatus ?? options.status ?? "failed",
    attempt.started,
    completedAt,
  );
  recordCall(h, attempt, false, completedAt);
  attempt.accounting?.complete(
    attempt.accountingAttempt,
    "error",
    accountingFailureForAttempt(options),
    attempt.usage,
    completedAt,
  );
}

export function completeAttemptCancelled(
  h: { breaker: CircuitBreaker; modelCallRecorder?: ModelCallRecorder },
  attempt: HealthAttempt,
  reason: string | null,
): void {
  completeCancellation(
    h,
    attempt,
    reason,
    attempt.committed ? "client-gone-mid-response" : "client-gone-before-response",
  );
}

function completeAttemptAbandoned(
  h: { breaker: CircuitBreaker; modelCallRecorder?: ModelCallRecorder },
  attempt: HealthAttempt,
  reason: string | null,
): void {
  completeCancellation(h, attempt, reason, "relay-abandoned");
}

function completeCancellation(
  h: { breaker: CircuitBreaker; modelCallRecorder?: ModelCallRecorder },
  attempt: HealthAttempt,
  reason: string | null,
  cause: AttemptCancellationCause,
): void {
  if (attempt.completed) return;
  const completedAt = Date.now();
  const result = h.breaker.completeAttempt(attempt.handle, {
    terminal: "cancelled",
    target: attempt.identity,
    provenance: "client-cancellation",
    completedAt,
    elapsedMs: completedAt - attempt.started,
    cause,
    reason,
  });
  if (!result.ok) throw new Error(`attempt completion rejected: ${result.error.kind}`);
  attempt.completed = true;
  attempt.terminal = "cancelled";
  attempt.trace.record(attempt.target, "cancelled", attempt.started, completedAt);
  attempt.accounting?.complete(
    attempt.accountingAttempt,
    "cancelled",
    "aborted",
    attempt.usage,
    completedAt,
    cause === "relay-abandoned",
  );
}

type PostHeaderBodyDisposition = "cancelled" | "timeout" | "protocol";

export function completePostHeaderBodyFailure(
  h: { breaker: CircuitBreaker; modelCallRecorder?: ModelCallRecorder },
  downstream: ServerResponse,
  signal: AbortSignal,
  attempt: HealthAttempt,
  credentialWalk: CredentialWalk,
  credentialTrace: CredentialAttemptTrace,
  resolvedAttempt: ResolvedAttempt,
): PostHeaderBodyDisposition {
  if (downstream.destroyed) {
    completeAttemptCancelled(h, attempt, "client disconnected while reading provider response body");
    recordCredentialOutcome(credentialWalk, credentialTrace, resolvedAttempt, { kind: "cancelled" });
    return "cancelled";
  }
  if (signal.aborted) {
    completeAttemptFailure(h, attempt, {
      failure: "transport",
      provenance: "deadline",
      status: 504,
    });
    recordCredentialOutcome(credentialWalk, credentialTrace, resolvedAttempt, { kind: "timeout" });
    return "timeout";
  }
  completeAttemptFailure(h, attempt, {
    failure: "protocol",
    provenance: "invalid-upstream-envelope",
    status: 502,
  });
  recordCredentialOutcome(credentialWalk, credentialTrace, resolvedAttempt, { kind: "protocol" });
  return "protocol";
}
