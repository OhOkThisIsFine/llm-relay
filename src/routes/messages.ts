import type { IncomingMessage, ServerResponse } from "node:http";
import type { Config, ResolvedTarget } from "../config.js";
import { specOfTarget } from "../benchmarks.js";
import {
  errorOrigin,
  fetchBackend,
  parseRetryAfterMs,
  upstreamReportedModel,
  dialectRefusalSignalOf,
  POOL_ATTEMPTS_HEADER,
} from "../backend.js";
import { probeStreamForCommit, relayAuthoredResponse, stopCauseToken } from "../stream-commit.js";
import { reconstructFromSse } from "../sse.js";
import { emitSse, emitSseTail, syntheticMessageId } from "../emitSse.js";
import { repair, type RepairOutcome } from "../repair.js";
import type { ToolUseValidator } from "../validator.js";
import type { Reshaper } from "../reshaper.js";
import type { MetadataLogger, RequestLog } from "../log.js";
import type { CircuitBreaker } from "../circuit-breaker.js";
import { CredentialLru, CredentialWalk } from "../credential-select.js";
import type { ModelLimits } from "../catalog.js";
import { baseLog } from "../request-log.js";
import type { JsonSchema, AssistantMessage } from "../anthropic.js";
import type { ResolvedAttempt } from "../resolved-attempt.js";
import type { RequestAccountingState } from "../accounting-state.js";
import {
  beginAttemptRun,
  buildForwardHeaders,
  classifyStatus,
  completeAttemptCancelled,
  completeAttemptFailure,
  completeAttemptSuccess,
  completePostHeaderBodyFailure,
  CredentialAttemptTrace,
  CredentialConfigError,
  credentialEvidence,
  degradedLabel,
  DEFAULT_STALL_TIMEOUT_MS,
  DEFAULT_WALK_BUDGET_MS,
  endWalk,
  handleMidStreamError,
  inspectCandidateResponse,
  markAttemptCommitted,
  nextUncappedAttempt,
  observeAttemptHeaders,
  paidLabel,
  Pool429Tracker,
  probationLabelForAttempt,
  recordCredentialOutcome,
  recordCredentialStarted,
  recordStickySuccess,
  releaseAttemptRun,
  RequestAttemptTrace,
  respondAllCapped,
  responseHeadersForTarget,
  runAttemptWithHedge,
  takeCommitProbe,
  withCommitProbe,
  shouldTryNext,
  stickyProvenanceHeaders,
  toolUseIdRewriteField,
  walkExitHeaders,
  walkOutcomeForResponse,
  type AttemptRun,
  type CandidateRunnerHandlers,
  type HealthAttempt,
  type StickyRequestContext,
  beginHealthAttempt,
} from "../candidate-runner.js";
import {
  failClosed,
  forwardLocalResponse,
  MAX_VALIDATE_BYTES,
  parseAssistant,
  frameEnd,
  frameOpensToolUse,
  resolveCrawlSettings,
  sseError,
  withCrawlWatchdog,
  withStallWatchdog,
  writeChunk,
} from "../stream-pipeline.js";

function dedupe(xs: string[]): string[] {
  return [...new Set(xs)];
}

export interface MessagesHandlers extends CandidateRunnerHandlers {
  validator: ToolUseValidator;
  logger: MetadataLogger;
  breaker: CircuitBreaker;
  credentialLru: CredentialLru;
  hedgeMaxInFlight: number;
  isDestructive: (name: string) => boolean;
  resolveReshaper: (attempt: ResolvedAttempt) => Reshaper | undefined;
  withRepairAccounting: (reshaper: Reshaper, accounting: RequestAccountingState | null) => Reshaper;
  catalog: { cachedLimits: (provider: string, model: string) => ModelLimits | null | undefined };
}

export interface MessagesContext {
  req: IncomingMessage;
  reqBuf: Buffer;
  reqJson: unknown;
  path: string;
  pathname: string;
  started: number;
  hadTools: boolean;
  tools: Map<string, JsonSchema | null>;
  wantsStream: boolean;
  walkAttempts: ResolvedAttempt[];
  addressedPool: string | null;
  degradedSpecs: Set<string> | null;
  sticky: StickyRequestContext | null;
  quotaDemotedFirst: string | null;
  latencyDemotedFirst: string | null;
  pacedFirst: string | null;
  accounting: RequestAccountingState | null;
  cfg: Config;
  /**
   * The relay's own chars/4 estimate of this request's INPUT size (`estimateRequestTokens` in
   * `metadata.ts`), captured once in `handle()` alongside `routingNow` — the same value the context
   * guardrail already computed, threaded rather than re-estimated so a hedge decision and the
   * guardrail can never disagree about how big this request is.
   */
  estimatedInputTokens: number;
  /**
   * The ONE routing instant, captured in `handle` after route-level pruning.
   *
   * ⚠ It is threaded in rather than re-read here, and that is load-bearing. The same instant drives
   * `orderDeploymentGroupsByUsability`, `rankCredentialAttempts` and this walk, so the ordering and
   * the walk cannot disagree about whether a cell is cooling. Calling `Date.now()` here instead
   * re-reads the clock per candidate, so a cooldown lapsing mid-walk changes the answer part-way
   * through and the walk stops being deterministic — and the OpenAI front, which still passes
   * `routingNow`, would then run a different policy from this one.
   */
  routingNow: number;
}

export interface AnthropicCtx {
  tools: Map<string, JsonSchema | null>;
  streamed: boolean;
  started: number;
  path: string;
  hadTools: boolean;
  req?: IncomingMessage;
  retryAfterOverrideMs?: number | undefined;
  poolSummary?: string | null;
  poolUnknownRefusals?: number | null;
  tried?: readonly string[];
  credentialHeaders?: Record<string, string>;
  degraded?: string | null;
  quotaDemoted?: string | null;
  latencyDemoted?: string | null;
  paced?: string | null;
  probation?: string | null;
  hedged?: string | null;
  paid?: string | null;
  sticky?: StickyRequestContext | null;
  target: ResolvedTarget;
  attempt: HealthAttempt;
  signal: AbortSignal;
  callerSignal: AbortSignal;
  reportedModelSource: Response;
}

export type RepairCtx = AnthropicCtx & {
  wantsStream: boolean;
  reshaper: Reshaper;
  maxAttempts: number;
  pool429: Pool429Tracker;
};

export interface BufferedRepairDeadTurn {
  validated: RequestLog["validated"];
  toolUseCount: number;
  uncheckableCount: number;
  errorKinds: string[];
}

export async function transparentPath(
  res: ServerResponse,
  backendRes: Response,
  timer: NodeJS.Timeout,
  ctx: AnthropicCtx & { willValidate: boolean },
  h: MessagesHandlers,
): Promise<void> {
  if (!res.headersSent) res.writeHead(backendRes.status, responseHeadersForTarget(backendRes, ctx));
  let assistant: AssistantMessage | null = null;
  let responseBytesWritten = false;
  try {
    if (!backendRes.body) {
      if (!res.writableEnded) res.end();
    } else if (ctx.streamed) {
      const decoder = new TextDecoder();
      let acc = "";
      let overflow = false;
      for await (const chunk of backendRes.body as unknown as AsyncIterable<Uint8Array>) {
        const bytes = Buffer.from(chunk);
        if (!await writeChunk(
          res,
          bytes,
          backendRes.status < 400 ? () => markAttemptCommitted(ctx.attempt) : undefined,
        )) break;
        if (bytes.length > 0) responseBytesWritten = true;
        if (ctx.willValidate && !overflow) {
          acc += decoder.decode(chunk, { stream: true });
          if (acc.length > MAX_VALIDATE_BYTES) overflow = true;
        }
      }
      if (!res.writableEnded) res.end();
      if (ctx.willValidate && !overflow) assistant = reconstructFromSse(acc + decoder.decode());
    } else {
      const bytes = Buffer.from(await backendRes.arrayBuffer());
      if (!res.writableEnded) {
        if (backendRes.status < 400 && bytes.length > 0) markAttemptCommitted(ctx.attempt);
        res.end(bytes);
      }
      if (ctx.willValidate && bytes.length <= MAX_VALIDATE_BYTES) assistant = parseAssistant(bytes.toString("utf8"));
    }
  } catch (e) {
    handleMidStreamError(
      res, e, ctx.started, ctx.path, ctx.hadTools, ctx.streamed, backendRes.status,
      ctx.target, ctx.attempt, h,
      (msg) => ctx.streamed ? sseError(msg) : null,
      ctx.reportedModelSource,
      ctx.signal.aborted,
      responseBytesWritten,
      ctx.signal,
    );
    return;
  } finally {
    clearTimeout(timer);
  }

  if (res.destroyed) return;

  let validated: RequestLog["validated"] = "skipped";
  let toolUseCount = 0;
  let uncheckableCount = 0;
  let errorKinds: string[] = [];
  if (ctx.willValidate && assistant) {
    const r = h.validator.validate(assistant, ctx.tools);
    validated = r.errors.length > 0 ? "fail" : r.uncheckableCount > 0 ? "uncheckable" : "pass";
    toolUseCount = r.toolUseCount;
    uncheckableCount = r.uncheckableCount;
    errorKinds = dedupe(r.errors.map((e) => e.kind));
  }
  if (backendRes.status >= 400) {
    completeAttemptFailure(h, ctx.attempt, {
      failure: "http",
      provenance: errorOrigin(backendRes) === "local" ? "relay-mapper-defect" : "upstream",
      status: backendRes.status,
      retryAfterMs: parseRetryAfterMs(backendRes.headers.get("retry-after")),
    });
  } else if (ctx.willValidate && (!assistant || validated !== "pass")) {
    completeAttemptFailure(h, ctx.attempt, {
      failure: "protocol",
      provenance: "invalid-upstream-envelope",
      status: 502,
      ...(ctx.streamed && res.headersSent ? { logStatus: "committed" as const } : {}),
    });
  } else {
    completeAttemptSuccess(h, ctx.attempt, backendRes.status);
    recordStickySuccess(h, ctx.sticky, ctx.target, backendRes.status);
  }
  h.logger.write({
    ...baseLog(
      ctx.started,
      ctx.path,
      ctx.hadTools,
      ctx.streamed,
      backendRes.status,
      validated,
      ctx.target,
      ctx.attempt.trace.snapshot(),
      upstreamReportedModel(ctx.reportedModelSource),
      ctx.attempt.resolvedAttempt.credentialId,
    ),
    toolUseCount, uncheckableCount, errorKinds,
    ...toolUseIdRewriteField(ctx.reportedModelSource),
  });
}

export async function repairPath(
  res: ServerResponse,
  backendRes: Response,
  timer: NodeJS.Timeout,
  ctx: RepairCtx,
  h: MessagesHandlers,
): Promise<BufferedRepairDeadTurn | null> {
  if (ctx.streamed) {
    await repairStreamingPath(res, backendRes, timer, ctx, h);
    return null;
  } else {
    return repairBufferedPath(res, backendRes, timer, ctx, h);
  }
}

export async function repairStreamingPath(
  res: ServerResponse,
  backendRes: Response,
  timer: NodeJS.Timeout,
  ctx: RepairCtx,
  h: MessagesHandlers,
): Promise<void> {
  const filtered = responseHeadersForTarget(backendRes, ctx);
  let acc = "";
  let overflow = false;
  let work = Buffer.alloc(0);
  const held: Buffer[] = [];
  let buffering = false;
  let firstToolUseIndex = -1;
  let headWritten = res.headersSent;
  let responseBytesWritten = false;

  const ensureHead = () => {
    if (!headWritten && !res.headersSent) {
      res.writeHead(backendRes.status, filtered);
      headWritten = true;
    }
  };
  const forward = async (frame: Buffer) => {
    ensureHead();
    if (await writeChunk(res, frame, () => markAttemptCommitted(ctx.attempt)) && frame.length > 0) responseBytesWritten = true;
  };
  const flushHeld = async () => {
    for (const f of held) {
      if (res.destroyed) break;
      await forward(f);
    }
    held.length = 0;
  };

  const processFrame = async (frame: Buffer): Promise<void> => {
    if (!overflow) {
      acc += frame.toString("utf8");
      if (acc.length > MAX_VALIDATE_BYTES) {
        overflow = true;
        if (buffering) {
          await flushHeld();
          buffering = false;
        }
      }
    }
    if (buffering) {
      held.push(frame);
      return;
    }
    const toolUseIdx = overflow ? null : frameOpensToolUse(frame);
    if (toolUseIdx !== null) {
      buffering = true;
      firstToolUseIndex = toolUseIdx;
      held.push(frame);
      return;
    }
    await forward(frame);
  };

  try {
    if (backendRes.body) {
      for await (const chunk of backendRes.body as unknown as AsyncIterable<Uint8Array>) {
        if (res.destroyed) break;
        work = work.length ? Buffer.concat([work, Buffer.from(chunk)]) : Buffer.from(chunk);
        let end: number;
        while ((end = frameEnd(work)) !== -1) {
          const frame = work.subarray(0, end);
          work = Buffer.from(work.subarray(end));
          await processFrame(frame);
        }
      }
    }
    if (work.length) await processFrame(work);
  } catch (e) {
    held.length = 0;
    handleMidStreamError(
      res,
      e,
      ctx.started,
      ctx.path,
      ctx.hadTools,
      true,
      backendRes.status,
      ctx.target,
      ctx.attempt,
      h,
      sseError,
      ctx.reportedModelSource,
      ctx.signal.aborted,
      responseBytesWritten,
      ctx.signal,
    );
    return;
  } finally {
    clearTimeout(timer);
  }

  if (res.destroyed) return;

  let validated: RequestLog["validated"] = "skipped";
  let toolUseCount = 0;
  let uncheckableCount = 0;
  let errorKinds: string[] = [];
  let repairOutcome: RepairOutcome | "none" = "none";

  if (overflow || !buffering) {
    if (!buffering) {
      const assistant = overflow ? null : reconstructFromSse(acc);
      if (assistant) {
        const r = h.validator.validate(assistant, ctx.tools);
        validated = r.errors.length > 0 ? "fail" : r.uncheckableCount > 0 ? "uncheckable" : "pass";
        toolUseCount = r.toolUseCount;
        uncheckableCount = r.uncheckableCount;
        errorKinds = dedupe(r.errors.map((e) => e.kind));
      }
    }
    ensureHead();
    if (!res.writableEnded) res.end();
  } else {
    const assistant = reconstructFromSse(acc);
    const r = h.validator.validate(assistant, ctx.tools);
    toolUseCount = r.toolUseCount;
    uncheckableCount = r.uncheckableCount;
    if (r.valid) {
      validated = r.uncheckableCount > 0 ? "uncheckable" : "pass";
      await flushHeld();
      ensureHead();
      if (!res.writableEnded) res.end();
    } else {
      validated = "fail";
      errorKinds = dedupe(r.errors.map((e) => e.kind));
      const decision = await repair(assistant, ctx.tools, {
        validator: h.validator,
        reshaper: ctx.reshaper,
        maxAttempts: ctx.maxAttempts,
        isDestructive: h.isDestructive,
        backendModel: ctx.target.model ?? null,
        signal: ctx.callerSignal,
      });
      repairOutcome = decision.outcome;
      ensureHead();
      if (decision.outcome === "fixed" && decision.message) {
        if (!res.writableEnded) {
          const tail = emitSseTail(decision.message, firstToolUseIndex);
          if (tail.length > 0) markAttemptCommitted(ctx.attempt);
          res.end(tail);
        }
      } else {
        if (!res.writableEnded) res.end(sseError(`llm-relay: tool call could not be repaired (${decision.outcome})`));
      }
    }
  }

  if (backendRes.status >= 400) {
    completeAttemptFailure(h, ctx.attempt, {
      failure: "http",
      provenance: errorOrigin(backendRes) === "local" ? "relay-mapper-defect" : "upstream",
      status: backendRes.status,
      retryAfterMs: parseRetryAfterMs(backendRes.headers.get("retry-after")),
    });
  } else if (
    (validated === "fail" && repairOutcome !== "fixed") ||
    (repairOutcome !== "none" && repairOutcome !== "fixed")
  ) {
    completeAttemptFailure(h, ctx.attempt, {
      failure: "protocol",
      provenance: "invalid-upstream-envelope",
      status: 502,
      logStatus: "committed",
    });
  } else {
    completeAttemptSuccess(h, ctx.attempt, backendRes.status);
    recordStickySuccess(h, ctx.sticky, ctx.target, backendRes.status);
  }
  h.logger.write({
    ...baseLog(
      ctx.started,
      ctx.path,
      ctx.hadTools,
      true,
      backendRes.status,
      validated,
      ctx.target,
      ctx.attempt.trace.snapshot(),
      upstreamReportedModel(ctx.reportedModelSource),
      ctx.attempt.resolvedAttempt.credentialId,
    ),
    toolUseCount, uncheckableCount, errorKinds, repair: repairOutcome,
    ...toolUseIdRewriteField(ctx.reportedModelSource),
  });
}

export async function repairBufferedPath(
  res: ServerResponse,
  backendRes: Response,
  timer: NodeJS.Timeout,
  ctx: RepairCtx,
  h: MessagesHandlers,
): Promise<BufferedRepairDeadTurn | null> {
  let bytes: Buffer;
  try {
    bytes = Buffer.from(await backendRes.arrayBuffer());
  } catch (e) {
    handleMidStreamError(res, e, ctx.started, ctx.path, ctx.hadTools, ctx.streamed, backendRes.status, ctx.target, ctx.attempt, h, () => null, ctx.reportedModelSource, ctx.signal.aborted, false, ctx.signal);
    return null;
  } finally {
    clearTimeout(timer);
  }
  if (res.destroyed) return null;
  const assistant = ctx.streamed
    ? reconstructFromSse(bytes.toString("utf8"))
    : parseAssistant(bytes.toString("utf8"));

  const filtered = responseHeadersForTarget(backendRes, ctx);
  let repairOutcome: RepairOutcome | "none" = "none";
  let validated: RequestLog["validated"] = "skipped";
  let toolUseCount = 0;
  let uncheckableCount = 0;
  let errorKinds: string[] = [];

  const recordFinalWalk = (
    status: number,
    headers?: Record<string, string | string[]>,
  ): Record<string, string | string[]> | undefined => {
    ctx.pool429.recordFinal(status);
    const summary = ctx.pool429.summary();
    if (!summary) return headers;
    if (headers) headers[POOL_ATTEMPTS_HEADER] = summary;
    return headers ?? { [POOL_ATTEMPTS_HEADER]: summary };
  };

  if (!assistant) {
    if (backendRes.status < 400) {
      validated = "fail";
      errorKinds = ["invalid_upstream_envelope"];
      failClosed(
        res,
        502,
        "llm-relay: invalid Anthropic upstream envelope",
        recordFinalWalk(502, stickyProvenanceHeaders(ctx.sticky)),
      );
    } else {
      recordFinalWalk(backendRes.status, filtered);
      res.writeHead(backendRes.status, filtered);
      if (!res.writableEnded) {
        if (backendRes.status < 400 && bytes.length > 0) markAttemptCommitted(ctx.attempt);
        res.end(bytes);
      }
    }
  } else {
    const r = h.validator.validate(assistant, ctx.tools);
    toolUseCount = r.toolUseCount;
    uncheckableCount = r.uncheckableCount;
    if (r.valid) {
      validated = r.uncheckableCount > 0 ? "uncheckable" : "pass";
      recordFinalWalk(backendRes.status, filtered);
      res.writeHead(backendRes.status, filtered);
      if (!res.writableEnded) {
        if (backendRes.status < 400 && bytes.length > 0) markAttemptCommitted(ctx.attempt);
        res.end(bytes);
      }
    } else {
      validated = "fail";
      errorKinds = dedupe(r.errors.map((e) => e.kind));
      const decision = await repair(assistant, ctx.tools, {
        validator: h.validator,
        reshaper: ctx.reshaper,
        maxAttempts: ctx.maxAttempts,
        isDestructive: h.isDestructive,
        backendModel: ctx.target.model ?? null,
        signal: ctx.callerSignal,
      });
      repairOutcome = decision.outcome;
      if (decision.outcome === "fixed" && decision.message) {
        recordFinalWalk(backendRes.status, filtered);
        emitFixed(res, backendRes.status, filtered, decision.message, ctx.wantsStream, () => markAttemptCommitted(ctx.attempt));
      } else if (decision.outcome === "failed") {
        // outer loop decides
      } else {
        failClosed(
          res,
          502,
          `llm-relay: tool call could not be repaired (${decision.outcome})`,
          recordFinalWalk(502, stickyProvenanceHeaders(ctx.sticky)),
        );
      }
    }
  }

  if (backendRes.status >= 400) {
    completeAttemptFailure(h, ctx.attempt, {
      failure: "http",
      provenance: errorOrigin(backendRes) === "local" ? "relay-mapper-defect" : "upstream",
      status: backendRes.status,
      retryAfterMs: parseRetryAfterMs(backendRes.headers.get("retry-after")),
    });
  } else if (
    (validated === "fail" && repairOutcome !== "fixed") ||
    (repairOutcome !== "none" && repairOutcome !== "fixed")
  ) {
    completeAttemptFailure(h, ctx.attempt, {
      failure: "protocol",
      provenance: "invalid-upstream-envelope",
      status: 502,
      ...(repairOutcome === "failed" ? { logStatus: "dead-turn" as const } : {}),
    });
  } else {
    completeAttemptSuccess(h, ctx.attempt, backendRes.status);
    recordStickySuccess(h, ctx.sticky, ctx.target, backendRes.status);
  }
  if (repairOutcome === "failed") {
    return { validated, toolUseCount, uncheckableCount, errorKinds };
  }

  h.logger.write({
    ...baseLog(
      ctx.started,
      ctx.path,
      ctx.hadTools,
      ctx.streamed,
      backendRes.status,
      validated,
      ctx.target,
      ctx.attempt.trace.snapshot(),
      upstreamReportedModel(ctx.reportedModelSource),
      ctx.attempt.terminal === "succeeded" ? ctx.attempt.resolvedAttempt.credentialId : null,
    ),
    toolUseCount, uncheckableCount, errorKinds, repair: repairOutcome,
    ...toolUseIdRewriteField(ctx.reportedModelSource),
  });
  return null;
}

export function emitFixed(
  res: ServerResponse,
  status: number,
  filtered: Record<string, string | string[]>,
  message: AssistantMessage,
  wantsStream: boolean,
  beforeBody?: () => void,
): void {
  if (wantsStream) {
    res.writeHead(status, { ...filtered, "content-type": "text/event-stream" });
    if (!res.writableEnded) {
      const body = emitSse(message);
      if (body.length > 0) beforeBody?.();
      res.end(body);
    }
  } else {
    res.writeHead(status, { ...filtered, "content-type": "application/json" });
    if (!res.writableEnded) {
      const body = JSON.stringify(toAnthropicMessage(message));
      if (body.length > 0) beforeBody?.();
      res.end(body);
    }
  }
}

export function toAnthropicMessage(msg: AssistantMessage): object {
  return {
    id: msg.id ?? syntheticMessageId(),
    type: "message",
    role: "assistant",
    model: msg.model ?? "",
    content: msg.content,
    stop_reason: msg.stop_reason ?? "end_turn",
    stop_sequence: msg.stop_sequence ?? null,
    ...(msg.usage ? { usage: msg.usage } : {}),
  };
}

export async function anthropicMessagesPath(
  res: ServerResponse,
  ctx: MessagesContext,
  h: MessagesHandlers,
): Promise<void> {
  const isMessages = ctx.req.method === "POST" && ctx.pathname === "/v1/messages";
  const credentialWalk = new CredentialWalk(ctx.walkAttempts, {
    lru: h.credentialLru,
    walkBudgetMs: ctx.cfg.walkBudgetMs ?? DEFAULT_WALK_BUDGET_MS,
    selectionNow: ctx.routingNow,
    evidenceFor: (attempt: ResolvedAttempt) => credentialEvidence(attempt, ctx.cfg, h.breaker, ctx.routingNow),
    maxInFlight: h.hedgeMaxInFlight,
  });
  const credentialTrace = new CredentialAttemptTrace(ctx.cfg);
  const attemptTrace = new RequestAttemptTrace();
  const pool429 = new Pool429Tracker();
  const tried: string[] = [];

  while (!res.destroyed) {
    const primaryOffer = nextUncappedAttempt(h, credentialWalk, attemptTrace, pool429);
    if (!primaryOffer) break;

    const startAttempt = (run: AttemptRun, forwardHeaders: Record<string, string>): Promise<Response> =>
      withCommitProbe(fetchBackend(run.resolvedAttempt, {
        path: ctx.path,
        method: ctx.req.method ?? "POST",
        reqBuf: ctx.reqBuf,
        reqJson: ctx.reqJson,
        anthropicHeaders: forwardHeaders,
        wantsStream: ctx.wantsStream,
        isDestructive: h.isDestructive,
        usage: run.usage,
        signal: run.controller.signal,
        onEgress: () => {
          run.egressCallbackCalled = true;
          pool429.noteEgress();
          const egressAt = Date.now();
          // ⚠ `beginHealthAttempt`, never a hand-built identity — see the same note on the OpenAI
          // front. Rebuilding `ProviderTargetIdentity` field by field makes a private copy of
          // target-identity construction, the drift `kernel/contracts.ts` records having already
          // closed once, and it drops `targetIdentity`'s `Object.freeze`.
          run.attempt =
            beginHealthAttempt(h, run.resolvedAttempt, egressAt, attemptTrace, run.usage, ctx.accounting, ctx.estimatedInputTokens) ??
            undefined;
          if (!run.attempt) throw new Error("llm-relay: could not begin provider attempt");
          run.attempt.accountingAttempt = ctx.accounting?.startServe(run.resolvedAttempt, egressAt) ?? null;
          recordCredentialStarted(credentialWalk, credentialTrace, run.resolvedAttempt);
          tried.push(specOfTarget(run.target));
        },
        // ⚠ NOT the global `fetch` — `run.fetchFn` is what actually clears the first-byte deadline
        // (`candidate-runner.ts` `beginAttemptRun`) the instant the raw HTTP call resolves. Passing
        // the default here would arm the timer and never clear it before the total deadline does.
      }, run.fetchFn), {
        // The commit probe runs inside the attempt so the hedge race settles at first content.
        protocol: "anthropic-messages",
        isCancelled: () => res.destroyed,
        malformedProvenance: relayAuthoredResponse(run.target.kind, "anthropic-messages"),
      });

    const primaryRun = beginAttemptRun(res, primaryOffer, ctx.wantsStream);
    let resolvedAttempt = primaryRun.resolvedAttempt;
    let target = primaryRun.target;
    let timer = primaryRun.timer;
    let onResClose = primaryRun.onResClose;
    let controller: AbortController;
    let callerController: AbortController;
    let egressCallbackCalled: boolean;
    let hedged: string | null;
    let attempt: HealthAttempt | undefined;
    let credentialRecorded = false;

    try {
      let forwardHeaders: Record<string, string>;
      try {
        forwardHeaders = buildForwardHeaders(ctx.req.headers, resolvedAttempt);
      } catch (e) {
        credentialWalk.recordRejected(resolvedAttempt);
        if (e instanceof CredentialConfigError) {
          failClosed(res, 502, `llm-relay configuration: ${e.message}`);
          h.logger.write(baseLog(ctx.started, ctx.path, ctx.hadTools, false, 502, "skipped", null, attemptTrace.snapshot()));
          return;
        }
        throw e;
      }

      let backendRes: Response;
      {
        const raced = await runAttemptWithHedge(
          { run: primaryRun, promise: startAttempt(primaryRun, forwardHeaders) },
          {
            h,
            res,
            walk: credentialWalk,
            credentialTrace,
            attemptTrace,
            estimatedInputTokens: ctx.estimatedInputTokens,
            tracker: pool429,
            startRun: (offer) => {
              const hedgeRun = beginAttemptRun(res, offer, ctx.wantsStream);
              try {
                return { run: hedgeRun, promise: startAttempt(hedgeRun, buildForwardHeaders(ctx.req.headers, offer)) };
              } catch {
                releaseAttemptRun(res, hedgeRun);
                credentialWalk.recordRejected(offer);
                return undefined;
              }
            },
          },
        );
        resolvedAttempt = raced.run.resolvedAttempt;
        target = raced.run.target;
        controller = raced.run.controller;
        callerController = raced.run.callerController;
        timer = raced.run.timer;
        onResClose = raced.run.onResClose;
        attempt = raced.run.attempt;
        egressCallbackCalled = raced.run.egressCallbackCalled;
        hedged = raced.hedged;

        const settled = raced.settled;
        if (!settled.ok) {
          const e = settled.error;
          if (!attempt) {
            if (credentialWalk.isPending(resolvedAttempt)) {
              credentialWalk.recordRejected(resolvedAttempt);
            }
            if (res.destroyed) return;
            const status = controller.signal.aborted ? 504 : 502;
            failClosed(res, status, egressCallbackCalled
              ? "llm-relay: could not begin provider attempt"
              : "llm-relay: backend preparation failed");
            h.logger.write(baseLog(ctx.started, ctx.path, ctx.hadTools, false, status, "skipped", null, attemptTrace.snapshot()));
            return;
          }
          const aborted = controller.signal.aborted;
          const status = aborted ? 504 : 502;
          if (res.destroyed) {
            completeAttemptCancelled(h, attempt, "client disconnected");
            recordCredentialOutcome(credentialWalk, credentialTrace, resolvedAttempt, { kind: "cancelled" });
            credentialRecorded = true;
            return;
          }

          completeAttemptFailure(h, attempt, {
            failure: "transport",
            provenance: aborted ? "deadline" : "upstream",
            status,
          });
          recordCredentialOutcome(
            credentialWalk,
            credentialTrace,
            resolvedAttempt,
            aborted ? { kind: "timeout" } : { kind: "provider-transport" },
          );
          credentialRecorded = true;
          const walkEnd = endWalk(
            h,
            res,
            "anthropic",
            credentialWalk,
            attemptTrace,
            pool429,
            status,
            ctx.sticky,
            credentialTrace,
            () => baseLog(ctx.started, ctx.path, ctx.hadTools, false, status, "skipped", target, attemptTrace.snapshot()),
            {
              kind: "transport",
              message: aborted ? "backend timed out" : `backend unreachable: ${(e as Error).message}`,
            },
          );
          if (walkEnd) continue;
          return;
        }
        backendRes = settled.value;
      }

      if (!attempt) {
        credentialWalk.recordRejected(resolvedAttempt);
        if (errorOrigin(backendRes) === "local") {
          await forwardLocalResponse(res, backendRes);
          h.logger.write(baseLog(ctx.started, ctx.path, ctx.hadTools, false, backendRes.status, "skipped", null, attemptTrace.snapshot()));
        } else {
          await backendRes.body?.cancel().catch(() => {});
          failClosed(res, 502, "llm-relay: backend returned before provider egress");
          h.logger.write(baseLog(ctx.started, ctx.path, ctx.hadTools, false, 502, "skipped", null, attemptTrace.snapshot()));
        }
        return;
      }

      const reportedModelSource = backendRes;
      const cls = classifyStatus(backendRes.status);
      const retryAfterMs = parseRetryAfterMs(backendRes.headers.get("retry-after"));
      observeAttemptHeaders(h, attempt, backendRes.status, retryAfterMs, backendRes.headers);

      const inspected = await inspectCandidateResponse(backendRes, resolvedAttempt, retryAfterMs);
      if (inspected.kind === "post-header-body-failure") {
        const disposition = completePostHeaderBodyFailure(
          h, res, controller.signal, attempt, credentialWalk, credentialTrace, resolvedAttempt,
        );
        credentialRecorded = true;
        if (disposition === "cancelled") return;
        const status = disposition === "timeout" ? 504 : 502;
        const walkEnd = endWalk(
          h,
          res,
          "anthropic",
          credentialWalk,
          attemptTrace,
          pool429,
          status,
          ctx.sticky,
          credentialTrace,
          () => baseLog(
            ctx.started, ctx.path, ctx.hadTools, false, status, "skipped", target, attemptTrace.snapshot(),
          ),
          {
            kind: "post-header-body-failure",
            message: disposition === "timeout"
              ? "backend timed out while reading response body"
              : "llm-relay: provider response body failed after headers",
            servedBy: tried.join(", "),
          },
        );
        if (walkEnd) continue;
        return;
      }
      backendRes = inspected.response;
      if (inspected.eligibility.unknown) pool429.noteUnknownRefusal();

      const localFailure = errorOrigin(backendRes) === "local";
      const tryNext = !localFailure && shouldTryNext(cls);
      if (backendRes.status >= 400) {
        recordCredentialOutcome(
          credentialWalk,
          credentialTrace,
          resolvedAttempt,
          walkOutcomeForResponse(backendRes.status, localFailure, inspected.eligibility.scope),
        );
        credentialRecorded = true;

        const next = tryNext && !res.destroyed ? nextUncappedAttempt(h, credentialWalk, attemptTrace, pool429) : undefined;
        if (next) {
          await backendRes.body?.cancel().catch(() => {});
          pool429.recordFailover(backendRes.status, retryAfterMs);
          completeAttemptFailure(h, attempt, {
            failure: "http",
            provenance: localFailure ? "relay-mapper-defect" : "upstream",
            status: backendRes.status,
            retryAfterMs,
          });
          continue;
        }
      }

      const streamed = (backendRes.headers.get("content-type") ?? "").includes("text/event-stream");
      if (streamed && backendRes.status < 400) {
        // The probe already ran inside `startAttempt` (`withCommitProbe`), which is what lets the
        // hedge race settle at commit; the inline probe is only the fallback for a response that
        // did not come through that wrapper.
        const probe = takeCommitProbe(backendRes) ?? (backendRes.body
          ? await probeStreamForCommit(backendRes.body, "anthropic-messages", {
              isCancelled: () => res.destroyed,
              malformedProvenance: relayAuthoredResponse(target.kind, "anthropic-messages"),
              ...(dialectRefusalSignalOf(backendRes) ? { relayRefusal: dialectRefusalSignalOf(backendRes)! } : {}),
            })
          : { kind: "dead" as const, reason: "stream has no body", provenance: "upstream" as const });

        if (probe.kind === "cancelled") {
          completeAttemptCancelled(h, attempt, "client disconnected before stream commit");
          recordCredentialOutcome(credentialWalk, credentialTrace, resolvedAttempt, { kind: "cancelled" });
          credentialRecorded = true;
          return;
        }
        if (probe.kind === "dead") {
          const deadline = controller.signal.aborted;
          completeAttemptFailure(h, attempt, deadline
            ? { failure: "transport", provenance: "deadline", status: 504 }
            : {
                failure: "protocol",
                provenance: probe.provenance === "local"
                  ? "relay-mapper-defect"
                  : "invalid-upstream-envelope",
                status: 502,
              });
          recordCredentialOutcome(
            credentialWalk,
            credentialTrace,
            resolvedAttempt,
            deadline
              ? { kind: "timeout" }
              : probe.provenance === "local" ? { kind: "local" } : { kind: "protocol" },
          );
          credentialRecorded = true;
          const walkEnd = endWalk(
            h,
            res,
            "anthropic",
            credentialWalk,
            attemptTrace,
            pool429,
            502,
            ctx.sticky,
            credentialTrace,
            () => baseLog(
              ctx.started,
              ctx.path,
              ctx.hadTools,
              true,
              502,
              "skipped",
              target,
              attemptTrace.snapshot(),
              upstreamReportedModel(reportedModelSource),
            ),
            {
              kind: "dead-stream",
              message: `llm-relay: ${probe.reason}`,
              errorType: probe.errorType,
              errorOrigin: probe.provenance,
              servedBy: tried.join(", "),
              shouldTryNext: probe.provenance === "upstream",
              // Only when the backend stated a cause. Absent leaves the log exactly as it was,
              // so a stream that died for an unknown reason is recorded as it always has been.
              ...(probe.classification
                ? { streamStopCause: stopCauseToken(probe.classification) }
                : {}),
            },
          );
          if (walkEnd) continue;
          return;
        }

        backendRes = new Response(probe.body, {
          status: backendRes.status,
          headers: backendRes.headers,
        });
      }

      const stallMs = target.stallTimeoutMs ?? DEFAULT_STALL_TIMEOUT_MS;
      if (streamed && backendRes.status < 400 && stallMs > 0) {
        clearTimeout(timer);
        backendRes = withStallWatchdog(backendRes, controller, stallMs);
      }

      const crawlSettings = resolveCrawlSettings(ctx.cfg.routing.crawl);
      if (streamed && backendRes.status < 400 && crawlSettings.enabled) {
        backendRes = withCrawlWatchdog(backendRes, controller, "anthropic-messages", crawlSettings);
      }

      const willValidate = isMessages && ctx.hadTools && backendRes.status < 400;
      const rawReshaper = ctx.cfg.mode === "repair" && willValidate
        ? h.resolveReshaper(resolvedAttempt)
        : undefined;
      const reshaper = rawReshaper ? h.withRepairAccounting(rawReshaper, ctx.accounting) : undefined;
      const doRepair = reshaper !== undefined;
      const streamCommitted = streamed && backendRes.status < 400;
      const responseCtx: AnthropicCtx = {
        tools: ctx.tools,
        streamed,
        started: ctx.started,
        path: ctx.path,
        hadTools: ctx.hadTools,
        req: ctx.req,
        target,
        attempt,
        signal: controller.signal,
        callerSignal: callerController.signal,
        reportedModelSource,
        retryAfterOverrideMs: pool429.overrideMs(backendRes.status, retryAfterMs),
        poolSummary: null,
        poolUnknownRefusals: pool429.unknownCount(),
        tried,
        degraded: degradedLabel(ctx.addressedPool, ctx.degradedSpecs, target),
        quotaDemoted: ctx.quotaDemotedFirst,
        latencyDemoted: ctx.latencyDemotedFirst,
        paced: ctx.pacedFirst,
        // Per SERVING candidate, evaluated here — not the walk leader at routing time. A
        // probation leader that fails over to a live member serves WITHOUT this header.
        probation: probationLabelForAttempt(h, resolvedAttempt, ctx.routingNow),
        hedged,
        paid: paidLabel(ctx.cfg, h, target),
        credentialHeaders: backendRes.status < 400
          ? credentialTrace.headers(resolvedAttempt)
          : credentialTrace.headers(),
        sticky: ctx.sticky,
      };

      if (streamCommitted) {
        recordCredentialOutcome(
          credentialWalk,
          credentialTrace,
          resolvedAttempt,
          { kind: "success", status: backendRes.status },
        );
        credentialRecorded = true;
        responseCtx.credentialHeaders = credentialTrace.headers();
        pool429.recordFinal(backendRes.status);
        responseCtx.poolSummary = pool429.summary();
        res.writeHead(backendRes.status, responseHeadersForTarget(backendRes, responseCtx));
      }

      if (doRepair) {
        const repairResult = await repairPath(
          res,
          backendRes,
          timer,
          {
            ...responseCtx,
            wantsStream: ctx.wantsStream,
            reshaper: reshaper!,
            maxAttempts: ctx.cfg.repair.maxAttempts,
            pool429,
          },
          h,
        );
        if (repairResult !== null) {
          recordCredentialOutcome(credentialWalk, credentialTrace, resolvedAttempt, { kind: "protocol" });
          credentialRecorded = true;
          pool429.recordDeadTurn();
          const next = !res.destroyed ? nextUncappedAttempt(h, credentialWalk, attemptTrace, pool429) : undefined;
          if (next) continue;

          const headers = walkExitHeaders(pool429, ctx.sticky, credentialTrace);
          failClosed(
            res,
            502,
            "llm-relay: tool call could not be repaired (failed)",
            Object.keys(headers).length > 0 ? headers : undefined,
          );
          h.logger.write({
            ...baseLog(
              ctx.started,
              ctx.path,
              ctx.hadTools,
              false,
              backendRes.status,
              repairResult.validated,
              target,
              attemptTrace.snapshot(),
              upstreamReportedModel(reportedModelSource),
            ),
            toolUseCount: repairResult.toolUseCount,
            uncheckableCount: repairResult.uncheckableCount,
            errorKinds: repairResult.errorKinds,
            repair: "failed",
          });
          return;
        }

        if (!credentialRecorded) {
          const outcome = attempt.terminal === "succeeded"
            ? { kind: "success" as const, status: backendRes.status }
            : attempt.terminal === "cancelled" || res.destroyed
              ? { kind: "cancelled" as const }
              : { kind: "local" as const };
          recordCredentialOutcome(credentialWalk, credentialTrace, resolvedAttempt, outcome);
          credentialRecorded = true;
        }
        return;
      }

      if (!streamCommitted) {
        if (backendRes.status < 400) {
          recordCredentialOutcome(
            credentialWalk,
            credentialTrace,
            resolvedAttempt,
            { kind: "success", status: backendRes.status },
          );
          credentialRecorded = true;
          responseCtx.credentialHeaders = credentialTrace.headers();
        }
        pool429.recordFinal(backendRes.status);
        responseCtx.poolSummary = pool429.summary();
      }
      await transparentPath(res, backendRes, timer, { ...responseCtx, willValidate }, h);
      return;
    } finally {
      if (!credentialRecorded && attempt) {
        recordCredentialOutcome(
          credentialWalk,
          credentialTrace,
          resolvedAttempt,
          res.destroyed ? { kind: "cancelled" } : { kind: "local" },
        );
      } else if (!credentialRecorded && credentialWalk.isPending(resolvedAttempt)) {
        credentialWalk.recordRejected(resolvedAttempt);
      }
      if (attempt && !attempt.completed) {
        if (res.destroyed) completeAttemptCancelled(h, attempt, "client disconnected");
        else {
          completeAttemptFailure(h, attempt, {
            failure: "mapping",
            provenance: "relay-mapper-defect",
            status: 502,
          });
        }
      }
      clearTimeout(timer);
      res.off("close", onResClose);
    }
  }

  if (!res.headersSent && !res.destroyed && pool429.allCapped()) {
    respondAllCapped(res, h, { started: ctx.started, path: ctx.path, hadTools: ctx.hadTools, streamed: ctx.wantsStream }, "anthropic", pool429, attemptTrace.snapshot());
  }
}
