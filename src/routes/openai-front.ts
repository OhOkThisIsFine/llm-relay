import type { IncomingMessage, ServerResponse } from "node:http";
import type { Config } from "../config.js";
import { specOfTarget } from "../benchmarks.js";
import {
  dialectRefusalSignalOf,
  errorOrigin,
  fetchOpenAiFront,
  normalizeOpenAiErrorBody,
  parseRetryAfterMs,
  upstreamReportedModel,
  type OpenAiFrontProtocol,
} from "../backend.js";
import { probeStreamForCommit, relayAuthoredResponse, type StreamCommitProtocol } from "../stream-commit.js";
import { toolSchemaMap, type AssistantMessage } from "../anthropic.js";
import type { RecoveredOpenAiChat, RecoveredOpenAiChatProcessor } from "../openai-dialect.js";
import { repair, type RepairOutcome } from "../repair.js";
import type { ToolUseValidator } from "../validator.js";
import type { Reshaper } from "../reshaper.js";
import type { MetadataLogger, RequestLog } from "../log.js";
import type { CircuitBreaker } from "../circuit-breaker.js";
import { CredentialWalk } from "../credential-select.js";
import { baseLog } from "../request-log.js";
import type { RequestAccountingState } from "../accounting-state.js";
import type { ResolvedAttempt } from "../resolved-attempt.js";
import type { ModelLimits } from "../catalog.js";
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
  degradedLabel,
  DEFAULT_STALL_TIMEOUT_MS,
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
  toolUseIdRewriteField,
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
  openAiSseError,
  withStallWatchdog,
  writeChunk,
} from "../stream-pipeline.js";

function dedupe(xs: string[]): string[] {
  return [...new Set(xs)];
}

export function detectOpenAiFrontProtocol(method: string | undefined, pathname: string): OpenAiFrontProtocol | null {
  if (method !== "POST") return null;
  if (pathname === "/v1/chat/completions" || pathname === "/chat/completions") return "chat";
  if (pathname === "/v1/responses" || pathname === "/responses") return "responses";
  return null;
}

export interface OpenAiFrontHandlers extends CandidateRunnerHandlers {
  validator: ToolUseValidator;
  logger: MetadataLogger;
  breaker: CircuitBreaker;
  isDestructive: (name: string) => boolean;
  resolveReshaper: (attempt: ResolvedAttempt) => Reshaper | undefined;
  withRepairAccounting: (reshaper: Reshaper, accounting: RequestAccountingState | null) => Reshaper;
  catalog: { cachedLimits: (provider: string, model: string) => ModelLimits | null | undefined };
}

export interface OpenAiFrontContext {
  reqJson: unknown;
  wantsStream: boolean;
  protocol: OpenAiFrontProtocol;
  inboundHeaders: IncomingMessage["headers"];
  started: number;
  path: string;
  hadTools: boolean;
  req?: IncomingMessage;
  addressedPool?: string | null;
  degradedSpecs?: Set<string> | null;
  sticky?: StickyRequestContext | null;
  cfg?: Config;
  accounting: RequestAccountingState | null;
  quotaDemotedFirst?: string | null;
  latencyDemotedFirst?: string | null;
  /**
   * The relay's own chars/4 estimate of this request's INPUT size (`estimateRequestTokens` in
   * `metadata.ts`) — the sibling of `AnthropicCtx`'s field in `routes/messages.ts`, threaded rather
   * than re-estimated so the hedge floor and the context guardrail read the same number.
   */
  estimatedInputTokens: number;
}

export async function openAiFrontPath(
  res: ServerResponse,
  credentialWalk: CredentialWalk,
  credentialTrace: CredentialAttemptTrace,
  ctx: OpenAiFrontContext,
  h: OpenAiFrontHandlers,
): Promise<void> {
  const tried: string[] = [];
  const attemptTrace = new RequestAttemptTrace();
  const directTools = toolSchemaMap(ctx.reqJson);
  const pool429 = new Pool429Tracker();

  while (!res.destroyed) {
    const primaryOffer = nextUncappedAttempt(h, credentialWalk, attemptTrace, pool429);
    if (!primaryOffer) break;

    type RecoveryAudit = { value: {
      validated: RequestLog["validated"];
      toolUseCount: number;
      uncheckableCount: number;
      errorKinds: string[];
      repair: RepairOutcome | "none";
    } | null };
    const audits = new Map<AttemptRun, RecoveryAudit>();

    const startAttempt = (run: AttemptRun, forwardHeaders: Record<string, string>): Promise<Response> => {
      const recoveryAudit: RecoveryAudit = { value: null };
      audits.set(run, recoveryAudit);
      const processRecoveredChat: RecoveredOpenAiChatProcessor = async (recovered) => {
        const assistant: AssistantMessage = {
          content: [
            ...(recovered.text ? [{ type: "text", text: recovered.text } as const] : []),
            ...recovered.calls.map((call) => ({
              type: "tool_use" as const,
              id: call.id,
              name: call.name,
              input: call.input,
            })),
          ],
          stop_reason: "tool_use",
        };
        const validation = h.validator.validate(assistant, directTools);
        recoveryAudit.value = {
          validated: validation.errors.length > 0
            ? "fail"
            : validation.uncheckableCount > 0 ? "uncheckable" : "pass",
          toolUseCount: validation.toolUseCount,
          uncheckableCount: validation.uncheckableCount,
          errorKinds: dedupe(validation.errors.map((error) => error.kind)),
          repair: "none",
        };
        if (validation.valid || ctx.cfg?.mode !== "repair") return recovered;

        const rawReshaper = h.resolveReshaper(run.resolvedAttempt);
        const reshaper = rawReshaper ? h.withRepairAccounting(rawReshaper, ctx.accounting) : undefined;
        if (!reshaper) return recovered;
        const decision = await repair(assistant, directTools, {
          validator: h.validator,
          reshaper,
          maxAttempts: ctx.cfg.repair.maxAttempts,
          isDestructive: h.isDestructive,
          backendModel: run.target.model ?? null,
          signal: run.callerController.signal,
        });
        recoveryAudit.value.repair = decision.outcome;
        if (decision.outcome !== "fixed" || !decision.message) {
          throw new Error(`tool call could not be repaired (${decision.outcome})`);
        }

        const fixed: RecoveredOpenAiChat = { text: "", calls: [] };
        for (const block of decision.message.content) {
          if (block.type === "text" && typeof block.text === "string") fixed.text += block.text;
          if (
            block.type === "tool_use" &&
            typeof block.id === "string" &&
            typeof block.name === "string" &&
            typeof block.input === "object" &&
            block.input !== null &&
            !Array.isArray(block.input)
          ) {
            fixed.calls.push({
              id: block.id,
              name: block.name,
              input: block.input as Record<string, unknown>,
            });
          }
        }
        return fixed;
      };

      return withCommitProbe(fetchOpenAiFront(run.resolvedAttempt, {
        reqJson: ctx.reqJson,
        wantsStream: ctx.wantsStream,
        protocol: ctx.protocol,
        anthropicHeaders: forwardHeaders,
        signal: run.controller.signal,
        isDestructive: h.isDestructive,
        processRecoveredChat,
        usage: run.usage,
        onEgress: () => {
          run.egressCallbackCalled = true;
          pool429.noteEgress();
          const egressAt = Date.now();
          // ⚠ `beginHealthAttempt`, never a hand-built identity. The decomposition inlined this and
          // rebuilt `ProviderTargetIdentity` field by field, which made a THIRD private copy of
          // target-identity construction — the exact drift `kernel/contracts.ts` records having
          // already closed once between `circuit-breaker.ts` and `kernel/request-lifecycle.ts`,
          // where "nothing in the type system would have caught the two drifting". The copy also
          // dropped `targetIdentity`'s `Object.freeze`, so the identity a completed attempt carries
          // was mutable here and frozen on the other front.
          run.attempt =
            beginHealthAttempt(h, run.resolvedAttempt, egressAt, attemptTrace, run.usage, ctx.accounting) ??
            undefined;
          if (!run.attempt) throw new Error("llm-relay: could not begin provider attempt");
          run.attempt.accountingAttempt = ctx.accounting?.startServe(run.resolvedAttempt, egressAt) ?? null;
          recordCredentialStarted(credentialWalk, credentialTrace, run.resolvedAttempt);
          tried.push(specOfTarget(run.target));
        },
      }), {
        // The commit probe runs inside the attempt so the hedge race settles at first content.
        protocol: ctx.protocol === "responses" ? "openai-responses" : "openai-chat",
        isCancelled: () => res.destroyed,
        malformedProvenance: relayAuthoredResponse(run.target.kind, ctx.protocol),
      });
    };

    const primaryRun = beginAttemptRun(res, primaryOffer);
    let resolvedAttempt = primaryRun.resolvedAttempt;
    let target = primaryRun.target;
    let timer = primaryRun.timer;
    let onResClose = primaryRun.onResClose;
    let controller: AbortController;
    let egressCallbackCalled: boolean;
    let hedged: string | null;
    let recoveryAudit: RecoveryAudit;
    let attempt: HealthAttempt | undefined;
    let credentialRecorded = false;

    try {
      let forwardHeaders: Record<string, string>;
      try {
        forwardHeaders = buildForwardHeaders(ctx.inboundHeaders, resolvedAttempt);
      } catch (e) {
        credentialWalk.recordRejected(resolvedAttempt);
        if (e instanceof CredentialConfigError) {
          failClosed(res, 502, `llm-relay configuration: ${e.message}`);
          h.logger.write(baseLog(
            ctx.started,
            ctx.path,
            ctx.hadTools,
            false,
            502,
            "skipped",
            null,
            attemptTrace.snapshot(),
          ));
          return;
        }
        throw e;
      }

      let upstream: Response;
      {
        const raced = await runAttemptWithHedge(
          { run: primaryRun, promise: startAttempt(primaryRun, forwardHeaders) },
          {
            h,
            res,
            walk: credentialWalk,
            credentialTrace,
            estimatedInputTokens: ctx.estimatedInputTokens,
            attemptTrace,
            tracker: pool429,
            startRun: (offer) => {
              const hedgeRun = beginAttemptRun(res, offer);
              try {
                return { run: hedgeRun, promise: startAttempt(hedgeRun, buildForwardHeaders(ctx.inboundHeaders, offer)) };
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
        timer = raced.run.timer;
        onResClose = raced.run.onResClose;
        attempt = raced.run.attempt;
        egressCallbackCalled = raced.run.egressCallbackCalled;
        hedged = raced.hedged;
        recoveryAudit = audits.get(raced.run) ?? { value: null };

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
            h.logger.write(baseLog(
              ctx.started,
              ctx.path,
              ctx.hadTools,
              false,
              status,
              "skipped",
              null,
              attemptTrace.snapshot(),
            ));
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
            "openai",
            credentialWalk,
            attemptTrace,
            pool429,
            status,
            ctx.sticky,
            credentialTrace,
            () => baseLog(
              ctx.started,
              ctx.path,
              ctx.hadTools,
              false,
              status,
              "skipped",
              target,
              attemptTrace.snapshot(),
            ),
            {
              kind: "transport",
              message: aborted ? "backend timed out" : `backend unreachable: ${(e as Error).message}`,
              servedBy: tried.join(", "),
            },
          );
          if (walkEnd) continue;
          return;
        }
        upstream = settled.value;
      }

      if (!attempt) {
        credentialWalk.recordRejected(resolvedAttempt);
        if (errorOrigin(upstream) === "local") {
          await forwardLocalResponse(res, upstream);
          h.logger.write(baseLog(
            ctx.started,
            ctx.path,
            ctx.hadTools,
            false,
            upstream.status,
            "skipped",
            null,
            attemptTrace.snapshot(),
          ));
        } else {
          await upstream.body?.cancel().catch(() => {});
          failClosed(res, 502, "llm-relay: backend returned before provider egress");
          h.logger.write(baseLog(
            ctx.started,
            ctx.path,
            ctx.hadTools,
            false,
            502,
            "skipped",
            null,
            attemptTrace.snapshot(),
          ));
        }
        return;
      }

      const reportedModelSource = upstream;
      const localFailure = errorOrigin(upstream) === "local";
      const cls = classifyStatus(upstream.status);
      const retryAfterMs = parseRetryAfterMs(upstream.headers.get("retry-after"));
      observeAttemptHeaders(h, attempt, upstream.status, retryAfterMs, upstream.headers);

      const inspected = await inspectCandidateResponse(upstream, resolvedAttempt, retryAfterMs);
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
          "openai",
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
      upstream = inspected.response;
      if (inspected.eligibility.unknown) pool429.noteUnknownRefusal();

      const tryNext = !localFailure && shouldTryNext(cls);
      if (upstream.status >= 400) {
        recordCredentialOutcome(
          credentialWalk,
          credentialTrace,
          resolvedAttempt,
          walkOutcomeForResponse(upstream.status, localFailure, inspected.eligibility.scope),
        );
        credentialRecorded = true;
        const next = tryNext && !res.writableEnded && !res.destroyed
          ? nextUncappedAttempt(h, credentialWalk, attemptTrace, pool429)
          : undefined;
        if (next) {
          await upstream.body?.cancel().catch(() => {});
          pool429.recordFailover(upstream.status, retryAfterMs);
          completeAttemptFailure(h, attempt, {
            failure: "http",
            provenance: localFailure ? "relay-mapper-defect" : "upstream",
            status: upstream.status,
            retryAfterMs,
          });
          continue;
        }
      }

      const streamed = (upstream.headers.get("content-type") ?? "").includes("text/event-stream");
      if (streamed && upstream.status < 400) {
        const protocol: StreamCommitProtocol =
          ctx.protocol === "responses" ? "openai-responses" : "openai-chat";
        // The probe already ran inside `startAttempt` (`withCommitProbe`), which is what lets the
        // hedge race settle at commit; the inline probe is only the fallback for a response that
        // did not come through that wrapper.
        const probe = takeCommitProbe(upstream) ?? (upstream.body
          ? await probeStreamForCommit(upstream.body, protocol, {
              isCancelled: () => res.destroyed,
              malformedProvenance: relayAuthoredResponse(target.kind, ctx.protocol),
              ...(dialectRefusalSignalOf(upstream) ? { relayRefusal: dialectRefusalSignalOf(upstream)! } : {}),
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
            "openai",
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
            },
          );
          if (walkEnd) continue;
          return;
        }

        upstream = new Response(probe.body, {
          status: upstream.status,
          headers: upstream.headers,
        });
      }

      const stallMs = target.stallTimeoutMs ?? DEFAULT_STALL_TIMEOUT_MS;
      if (streamed && upstream.status < 400 && stallMs > 0) {
        clearTimeout(timer);
        upstream = withStallWatchdog(upstream, controller, stallMs);
      }

      if (upstream.status < 400) {
        recordCredentialOutcome(
          credentialWalk,
          credentialTrace,
          resolvedAttempt,
          { kind: "success", status: upstream.status },
        );
        credentialRecorded = true;
      }
      pool429.recordFinal(upstream.status);

      let responseBytesWritten = false;
      try {
        const headers: Record<string, string | string[]> = responseHeadersForTarget(upstream, {
          target,
          tried,
          retryAfterOverrideMs: pool429.overrideMs(upstream.status, retryAfterMs),
          poolSummary: pool429.summary(),
          poolUnknownRefusals: pool429.unknownCount(),
          credentialHeaders: credentialTrace.headers(),
          degraded: degradedLabel(ctx.addressedPool ?? null, ctx.degradedSpecs ?? null, target),
          quotaDemoted: ctx.quotaDemotedFirst,
          latencyDemoted: ctx.latencyDemotedFirst,
          // Per SERVING candidate, evaluated here — not the walk leader at routing time. A
          // probation leader that fails over to a live member serves WITHOUT this header.
          // (`Date.now()` is threaded only for the shared evaluator shape; the verdict itself
          // is clock-free — served-request counts, never a deadline.)
          probation: probationLabelForAttempt(h, resolvedAttempt, Date.now()),
          hedged,
          paid: ctx.cfg ? paidLabel(ctx.cfg, h, target) : null,
          sticky: ctx.sticky,
        });

        if (upstream.status >= 400) {
          const raw = await upstream.text();
          const normalized = normalizeOpenAiErrorBody(raw, upstream.status);
          const out = Buffer.from(normalized ?? raw, "utf8");
          res.writeHead(upstream.status, { ...headers, "content-type": "application/json" });
          res.end(out);
          completeAttemptFailure(h, attempt, {
            failure: "http",
            provenance: localFailure ? "relay-mapper-defect" : "upstream",
            status: upstream.status,
            retryAfterMs,
          });
        } else {
          res.writeHead(upstream.status, headers);
          if (upstream.body) {
            for await (const chunk of upstream.body as unknown as AsyncIterable<Uint8Array>) {
              const bytes = Buffer.from(chunk);
              if (!await writeChunk(res, bytes, () => {
                if (attempt) markAttemptCommitted(attempt);
              })) break;
              if (bytes.length > 0) responseBytesWritten = true;
            }
          }
          if (!res.writableEnded) res.end();
          if (res.destroyed) completeAttemptCancelled(h, attempt, "client disconnected");
          else {
            completeAttemptSuccess(h, attempt, upstream.status);
            recordStickySuccess(h, ctx.sticky, target, upstream.status);
          }
        }
      } catch (e) {
        handleMidStreamError(
          res,
          e,
          ctx.started,
          ctx.path,
          ctx.hadTools,
          streamed,
          upstream.status,
          target,
          attempt,
          h,
          (msg) => streamed ? openAiSseError(msg) : null,
          reportedModelSource,
          controller.signal.aborted,
          responseBytesWritten,
        );
        return;
      }

      const audit = recoveryAudit.value;
      const log = {
        ...baseLog(
          ctx.started,
          ctx.path,
          ctx.hadTools,
          streamed,
          upstream.status,
          audit?.validated ?? "skipped",
          target,
          attemptTrace.snapshot(),
          upstreamReportedModel(reportedModelSource),
          resolvedAttempt.credentialId,
        ),
        ...toolUseIdRewriteField(reportedModelSource),
      };
      h.logger.write(audit ? {
        ...log,
        toolUseCount: audit.toolUseCount,
        uncheckableCount: audit.uncheckableCount,
        errorKinds: audit.errorKinds,
        repair: audit.repair,
      } : log);
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
    respondAllCapped(res, h, { started: ctx.started, path: ctx.path, hadTools: ctx.hadTools, streamed: ctx.wantsStream }, "openai", pool429, attemptTrace.snapshot());
  }
}
