/**
 * Backend protocol execution and response transformation pipeline.
 *
 * Charter & Invariants:
 *  - Translates requests and responses across Anthropic, OpenAI, and Responses protocols.
 *  - Handles streaming SSE transformations, tool-call dialect recovery, think-tag stripping, and usage accumulation.
 *  - Classifies downstream HTTP and dialect errors into retriable failovers vs terminal refusals.
 *  - Logs remain strictly metadata-only (no payload bodies or headers).
 */

import { translateBetweenProviders, handleUniversalStreamRequest } from "llm-bridge";
import { buildAuthHeaders } from "./authEnv.js";
import { isRecord } from "./json-shape.js";
import type { ResolvedAttempt } from "./resolved-attempt.js";
import { DocumentError, transcodeDocuments } from "./documents.js";
import { anthropicRequestToOpenAi, RequestMappingError, ToolCallIds, ThoughtSignatures } from "./openai-request.js";
import { openaiResponsesRequestToAnthropic, DEFAULT_RESPONSES_MAX_TOKENS } from "./responses-request.js";
import { observedMaxOutput } from "./context-limits.js";
import { DIALECT_REFUSED_DESTRUCTIVE_CODE, describeRefused, dialectRefusalSignal, recoverToolCalls, type DialectRefusalSignal, type DialectToolCall } from "./tool-dialects.js";
import { recoverDialectInStream } from "./dialect-stream.js";
import { toolSchemaMap } from "./anthropic.js";
import { stripOpeningThinkTag, stripThinkTagsInStream } from "./think-tags.js";
import { knownToolUseIds, rewriteToolUseIds, rewriteToolUseIdsInStream } from "./tool-use-ids.js";
import { invalidEnvelopeReason } from "./backend/envelope-validator.js";
import { captureReportedModel, preflightResponseStream, type UpstreamResponseMetadata } from "./backend/health-prober.js";
import {
  inspectDialectInOpenAiChat,
  recoverDialectInOpenAiChatStream,
  type RecoveredOpenAiChatProcessor,
} from "./openai-dialect.js";
import { observeUsage, type UsageAccumulator } from "./usage-observer.js";
import { createSseTransformStream, parseSseEvent, BufferedSseFrames } from "./sse-frames.js";
import { syntheticMessageId } from "./emitSse.js";
import type { ReasoningMode, ThoughtSignatureMode, ToolCallIdMode } from "./config-types.js";

/**
 * A tool-call envelope was present in the response text but could not be parsed — truncated, or a
 * dialect variant we do not model. Distinct from a mapper defect: the relay's translation is fine,
 * the SERVING HOST returned an unusable body. Carried as a retriable failure so the pool fails over
 * to a host that parses its models' dialect.
 */
export class DialectUnparseableError extends Error {
  constructor(public readonly dialect: string) {
    super(`backend returned an unparseable ${dialect} tool-call envelope as text`);
    this.name = "DialectUnparseableError";
  }
}

/**
 * A tool call recovered from assistant TEXT names a tool on the operator's destructive list.
 *
 * Unlike `DialectUnparseableError` this is NOT a statement about the host: the envelope parsed
 * fine. It is a config decision, so it is carried as a LOCAL failure — the walk must not fail over
 * (re-asking N models to produce the same refused action) and the deployment must not be charged,
 * the same rule under which a hard cap "never registers on the breaker — it is config, not
 * health". See docs/dialect-rescue-destructive-refusal-2026-08-24.md.
 */
export class DialectDestructiveError extends Error {
  constructor(public readonly dialect: string, public readonly refused: string[]) {
    super(
      `refused a ${dialect} tool call recovered from text because it names a destructive tool: ${describeRefused(refused)}`,
    );
    this.name = "DialectDestructiveError";
  }
}

/**
 * Response header stating who produced an error status: the provider, or this proxy.
 *
 * Every failure out of `fetchBackend` is a synthesized `Response` — a refused document, a
 * translation bug and a genuinely dead provider all arrived as a bare status code, so a
 * caller counting backend failures (the circuit breaker) charged our own local bugs to the
 * provider and failed over to a second provider that would have failed identically. The
 * marker is what makes them separable; `fetchBackend` states it, the caller decides.
 */
export const ERROR_ORIGIN_HEADER = "x-llm-relay-error-origin";

/** `upstream` = the provider answered with this status. `local` = the proxy produced it without asking. */
export type ErrorOrigin = "upstream" | "local";

/** Read the origin marker off a Response, when it carries one. */
/**
 * The declared origins, as a runtime set derived from the type rather than hand-listed beside it.
 *
 * `errorOrigin` is the ONE validator for this header, and its two-literal test was the drift seam:
 * a third `ErrorOrigin` member would have been silently rejected here and defaulted to `"upstream"`
 * by every caller — an unknown origin reported as the provider's fault, and `upstream` also means
 * RETRIABLE, so the walk would reroll other pool members for a fault that may be the relay's own.
 * Deriving the set makes a new member a compile error at the table instead.
 */
const ERROR_ORIGINS = { upstream: true, local: true } as const satisfies Record<ErrorOrigin, true>;

export function errorOrigin(res: Response): ErrorOrigin | null {
  const v = res.headers.get(ERROR_ORIGIN_HEADER);
  return v !== null && Object.hasOwn(ERROR_ORIGINS, v) ? (v as ErrorOrigin) : null;
}

/**
 * Response header naming the deployment that actually answered — the (provider, model) left
 * standing after pool expansion, benchmark ranking, breaker demotion and failover.
 *
 * A pool request's most basic debugging question is "who served this?", and until now the only
 * way to answer it was to correlate timestamps against the proxy's own log. When every candidate
 * fails it carries the list that was tried instead, so an exhausted pool is self-describing.
 */
export const SERVED_BY_HEADER = "x-llm-relay-served-by";

/**
 * What the `auto` model name resolved to for this turn — `<spec> (<tier>)`.
 * Announces both the concrete spec that served the turn and the ladder tier
 * that selected it.
 */
export const AUTO_HEADER = "x-llm-relay-auto";

/**
 * Request header specifying the dispatch ladder tier for `auto` model resolution
 * (`low` | `medium` | `high` | `xhigh`). Defaults to `medium` when omitted.
 */
export const AUTO_TIER_HEADER = "x-llm-relay-tier";

/**
 * WHY each of those candidates dropped out — `"13 tried, 0 served: 4x402, 5x429, 3x403, 1x400"`.
 *
 * `SERVED_BY_HEADER` answers "who was tried"; this answers "what happened to them", which is the
 * half that turns a pool exhaustion into a diagnosis. Without it a client holds one member's
 * error — a HuggingFace 402 pointing at a billing page — while the other twelve failed for three
 * unrelated reasons, and the correct action ("use another pool") is invisible.
 *
 * A header rather than a rewritten body, deliberately: the served body stays the last candidate's
 * real upstream error, because a true upstream error beats a synthesized one.
 */
export const POOL_ATTEMPTS_HEADER = "x-llm-relay-pool-attempts";
/** Response metadata headers for credential-aware pool diagnostics. */
export const CREDENTIAL_HEADER = "x-llm-relay-credential";
export const CREDENTIAL_ATTEMPTS_HEADER = "x-llm-relay-credential-attempts";

/**
 * How many refusals in this walk said something the relay could not interpret.
 *
 * The learned-eligibility store converges only as fast as somebody explains the messages it does
 * not recognise, and a pull-only queue is a backlog nobody works. This is the push half: the
 * caller — which is usually an agent that is about to report a pool failure to a human anyway —
 * finds out at the moment it matters that a NEW kind of refusal just appeared, and can run
 * `llm-relay eligibility` while the context is still in hand.
 *
 * ⚠ It is a COUNT, never the message. The message is untrusted text from an external service, and
 * putting it in a response header would be the relay handing an agent attacker-controlled prose in
 * a field agents tend to trust. The count says "go look"; `llm-relay eligibility` shows the text
 * with its provenance and the enum-constrained verdicts it may receive.
 */
export const UNKNOWN_REFUSAL_HEADER = "x-llm-relay-unknown-refusal";

type OnEgress = () => void;

function oneShotFetch(
  fetchFn: typeof fetch,
  signal: AbortSignal,
  onEgress?: OnEgress,
): typeof fetch {
  let invoked = false;
  return (input, init) => {
    if (!invoked && !signal.aborted) {
      invoked = true;
      onEgress?.();
    }
    return fetchFn(input, init);
  };
}

/**
 * This answer came from BELOW the effort band that was asked for.
 *
 * An effort pool falls back to lower-banded live members once its own band is exhausted, because a
 * band with nothing behind it turns "the strongest models are busy" into "no answer at all". That
 * fallback is automatic — but it must never be silent. A capability downgrade that reads as an
 * ordinary 200 is indistinguishable from having got what you asked for, which is the failure mode
 * that lets a caller build on a weaker answer without knowing it did.
 *
 * Names the deployment and the band it fell out of, e.g. `groq/llama-3.3-70b (below xhigh)`.
 */
export const DEGRADED_HEADER = "x-llm-relay-degraded";

/**
 * The walk's FIRST choice was demoted for a spent quota and the answer came from further down.
 *
 * Same maxim as `DEGRADED_HEADER` — automatic degradation is acceptable only because it is
 * announced — but a different fact: capability fell below the requested band there, while here a
 * quota figure said the first choice was spent until a known reset. Value is one bounded line,
 * e.g. `groq/llama-3.3-70b (requests/minute remaining 0, provider-stated)` — axis/period/remaining
 * plus the basis, no credential values, nothing secret.
 */
export const QUOTA_DEMOTED_HEADER = "x-llm-relay-quota-demoted";

/**
 * The walk's FIRST choice was demoted for SUSTAINED MEASURED LATENCY and the answer came from
 * further down. Third member of the same family as `DEGRADED_HEADER` and `QUOTA_DEMOTED_HEADER`,
 * and it exists for the same reason: an automatic reorder is acceptable only because it is
 * announced.
 *
 * ⚠ It is also the ONLY surface this demotion has. Quota demotion registers a breaker cooldown, so
 * `/candidates` and the dashboard Cooldowns panel can see it; latency states no reset, and this
 * relay never invents a cooldown duration, so no cooldown is registered and those panels show
 * nothing. See `src/latency-demotion.ts`.
 *
 * Value is one bounded line, e.g. `nim/deepseek-ai/deepseek-v4-flash (p95 70364ms > 30000ms over
 * 12 samples)` — the measured figure, the ceiling it crossed and the sample count behind it.
 * Nothing secret, no credential values.
 */
export const LATENCY_DEMOTED_HEADER = "x-llm-relay-latency-demoted";

/**
 * The serving candidate was placed by the PROBATION band: a free deployment with fewer than
 * `minSamples` served-request samples that the relay deliberately put first to gather data on
 * it (`routing.probation`, default ON).
 *
 * Fourth member of the `DEGRADED_HEADER` family, and it exists for the same reason: an
 * automatic reorder is acceptable only because it is announced. Unlike its three siblings it
 * does not state that the first choice was displaced — the probation member usually IS the
 * first choice — but that the answer came from a deployment with almost no served-traffic
 * evidence behind it.
 *
 * Value is one bounded line, e.g. `opencode/muse-spark-1.3-contributor-free (0 of 5 request
 * samples)` — the spec and the sample count behind the banding. Nothing secret.
 */
export const PROBATION_HEADER = "x-llm-relay-probation";

/**
 * The walk's FIRST choice was PACED: this relay's own attempts against it in the trailing window
 * had reached a ceiling the deployment stated (a quota header's `limit`, an operator `limits`
 * figure, or a `rate-limit-*` fact learned from a 429 body), so it stepped behind the live and
 * slow bands and another candidate led (`routing.pacing`, default ON, `src/pacing.ts`).
 *
 * Fifth member of the `DEGRADED_HEADER` family, and it exists for the same reason: an automatic
 * reorder is acceptable only because it is announced. Like `LATENCY_DEMOTED_HEADER` it is the
 * term's ONLY surface — pacing registers no breaker cooldown (it re-resolves from the start log
 * on every request and lifts by itself as the window drains), so `/candidates` and the dashboard
 * Cooldowns panel show nothing for it.
 *
 * Value is one bounded line, e.g. `groq/llama-3.3-70b (requests/minute 30 of 30 in the trailing
 * minute, learned)` — the spec, the count, the ceiling and who stated it. Nothing secret.
 */
export const PACED_HEADER = "x-llm-relay-paced";

/**
 * A HEDGE ran: a slow in-flight attempt had the next candidate started beside it, rather than
 * after it. Fourth member of the `DEGRADED_HEADER` family, and the announcement half of the
 * duplication bound.
 *
 * ⚠⚠ **This one announces something stronger than its three siblings, and the difference matters.**
 * They each state that the relay REORDERED the walk. This states that the relay sent the SAME
 * request to a SECOND deployment — the first behaviour here that does not merely reorder. The
 * `CLAUDE.md` invariant reads "Acting on counts is optional, always announced, and may only
 * reorder"; the owner amended it for hedging on 2026-08-30, and this header is one of the three
 * bounds that amendment rests on. The other two are `assessCost()`-free deployments only, and the
 * loser aborted the moment a winner commits.
 *
 * Value is one bounded line naming BOTH deployments and which one answered, e.g.
 * `nim/deepseek-ai/deepseek-v4-flash -> nim/nvidia/nemotron-3-ultra-550b-a55b (hedge won after
 * 3210ms, input-size 1180 tokens)` — the two specs, the winner, the delay that started the hedge
 * and the rung of evidence that set it. `input-size` (owner direction 2026-09-04) additionally
 * carries the estimated input-token count that decided the size-scaled floor, because a
 * `per-token`/`absolute` rung's own bare name is unaffected — it is a statement about the
 * DEPLOYMENT, not the request. Metadata only: no credential values, no content, no token text.
 *
 * ⚠ A hedge that starts and LOSES is announced too. The duplication happened either way, and a
 * header that appeared only when the hedge won would under-report exactly the case an operator
 * needs to see — a pool duplicating requests for no benefit.
 */
export const HEDGED_HEADER = "x-llm-relay-hedged";

/**
 * This request was refused by an OPERATOR-SET HARD CAP (G2) — not by a provider.
 *
 * Value is one line per capped credential cell, e.g.
 * `a/nim/z-ai/glm-5.2 requests/day 450/450` — label/deployment, axis/period, the inclusive
 * used/cap pair. Present only when EVERY walked candidate was capped: a partial walk serves
 * from whoever remained, and the pool-attempts header carries the `Nxcapped` tally beside the
 * other outcomes instead. Nothing secret: the label is the config slot name, the figures are
 * the operator's own declaration and this relay's own ledger reading.
 *
 * BOUNDED by cell count, not just by cell width: at most `MAX_CAPPED_HEADER_CELLS` (5) cells are
 * named and the rest are counted as `+K more`. A capped attempt costs no walk start budget, so a
 * fully capped 30-member dynamic pool reaches every one of them and an unbounded join would be a
 * ~1.2 KB header. The header says what stopped the request; it is not a roster.
 */
export const HARD_CAP_HEADER = "x-llm-relay-capped";

/**
 * This answer came from a deployment that is NOT free.
 *
 * Pools rank free capacity first but no longer exclude paid capacity, so a spent free lane is not
 * a dead end. That is only acceptable if spending is announced: an unflagged paid response is
 * indistinguishable from a free one, and the difference is money. Same reasoning as
 * `DEGRADED_HEADER` — automatic fallback is fine, silent fallback is not.
 *
 * Carries the deployment and how its cost was assessed, e.g.
 * `openrouter/anthropic/claude-sonnet-5 (paid, published-price)`.
 */
export const PAID_HEADER = "x-llm-relay-paid";

/** This response contains a tool call reconstructed from a recognized text dialect envelope. */
export const TOOL_DIALECT_HEADER = "x-llm-relay-tool-dialect";

/**
 * Per-response proof that a streamed dialect refusal was the RELAY's, not the upstream's.
 *
 * A WeakMap rather than a header or a body field, for the reason the signal exists at all: anything
 * on the wire can be echoed by a counterparty. The server hands this to `probeStreamForCommit`, and
 * a lane the relay never wrapped simply has no entry — so its bytes can never earn `local`
 * provenance. Same shape as `attachUpstreamMetadata`, and deliberately not merged into it: that
 * carries log METADATA about a finished response, this is live state for one in-flight stream.
 */
const dialectRefusalSignals = new WeakMap<Response, DialectRefusalSignal>();

export function dialectRefusalSignalOf(response: Response): DialectRefusalSignal | undefined {
  return dialectRefusalSignals.get(response);
}

/**
 * `tool_use` ids in this response were MINTED by the relay because the host reused ones the
 * conversation already carried — value `"<n> rewritten"`.
 *
 * Same maxim as `DEGRADED_HEADER`: an automatic fix is acceptable only because it is announced.
 * A count, never an id: the ids themselves are in the body the caller already has, and a header
 * is not the place to restate content.
 *
 * ⚠ Buffered responses only. On a stream the headers are written before the first
 * `content_block_start` exists, so a count there could only be a guess; the streaming pass
 * reports through `toolUseIdRewrites()` instead, which the server reads for its log record after
 * the stream drains. See `src/tool-use-ids.ts`.
 */
export const TOOL_USE_IDS_HEADER = "x-llm-relay-tool-use-ids";

/**
 * OUTBOUND tool-call ids were rewritten to this provider's stated id shape — value
 * `"<n> rewritten"`. Today that is only mistral's `^[a-zA-Z0-9]{9}$` (`compat.toolCallIds:
 * "strict9"`; see `src/openai-request.ts` for the 400 that states the rule).
 *
 * The request-direction sibling of `TOOL_USE_IDS_HEADER`, and the same maxim: an automatic fix is
 * acceptable only because it is announced, a count and never an id. Unlike the response-direction
 * mint the figure is final BEFORE the request is even sent, so it rides a streamed response's
 * headers too.
 */
export const TOOL_CALL_IDS_HEADER = "x-llm-relay-tool-call-ids";

/**
 * The relay overrode a `"deepseek"` target's own natural thinking decision to OFF for this
 * request — value `"disabled: tool_choice or missing reasoning replay"` (F10/F11, 2026-09-10; see
 * `openai-request.ts` `deepSeekThinkingSpec`). Either a forced tool choice (DeepSeek accepts only
 * one of "forced tool" and "thinking") or a replayed assistant tool-call turn with no
 * `reasoning_content` this relay could carry forward.
 *
 * Announced like `TOOL_CALL_IDS_HEADER`, not silent like `thoughtSignatureSentinels`: unlike that
 * sentinel — vendor-protocol padding that alters nothing about the caller's data — this changes
 * real behaviour the caller (or the routed pool's effort band) asked for, so it is closer to a
 * tool-call-id rewrite than to padding. A count, from `onDeepSeekThinkingOverridden`, decides
 * whether the header is present at all; the reason text is fixed rather than threaded through the
 * callback, because the callback exists to COUNT (the `onThoughtSignatureSentinels` idiom), not to
 * explain.
 */
export const DEEPSEEK_THINKING_HEADER = "x-llm-relay-thinking-disabled";

/**
 * ============================================================================================
 * The RESPONSE-direction half of `compat.reasoning: "deepseek"` (F11's missing other end).
 * ============================================================================================
 *
 * `openai-request.ts` carries a REPLAYED `thinking` block onto DeepSeek's outbound
 * `reasoning_content`, and turns thinking off for a replay that has none — that closes the HTTP
 * 400. But llm-bridge's response translation never reads the field in the other direction: its
 * `openaiToUniversal` (buffered) and `parseOpenAIStream` (streamed) consult only `content` and
 * `tool_calls` on a message/delta, and a grep for `reasoning_content` across the published bundle
 * returns nothing at all. So a caller never received DeepSeek's own reasoning, had nothing to
 * replay on the next turn, and `openai-request.ts`'s F11 override turned thinking OFF for every
 * tool-call turn after the first — a multi-turn DeepSeek lane silently ran without reasoning.
 *
 * The fix is the established one for an llm-bridge gap (the `openai-request.ts` precedent): the
 * RELAY injects the field at a named seam and never modifies the dependency. Each direction has
 * its own native block to build —
 *
 *   - Anthropic front (`/v1/messages`): a `thinking` content block. The whole downstream pipeline
 *     already models these (`stream-commit.ts` counts a `thinking` block's text as READY,
 *     `emitSse.ts` echoes the whole block opaquely, `sse.ts` rebuilds it, `openai-request.ts`
 *     replays it), so nothing downstream needed changing.
 *   - OpenAI Responses front (`/v1/responses`): a `reasoning` output item, which is what
 *     `responses-request.ts` reads back on the next turn (its `summary_text` parts become a
 *     leading `thinking` block, F11).
 *
 * ⚠ Gated on the RESOLVED `ReasoningMode` and nothing else. Every other target's response bytes —
 * buffered and streamed, both fronts — are the pre-2026-09-15 document exactly. That is the same
 * "handed a mode, never a provider identity to sniff" rule the request direction states.
 *
 * ⚠ A `signature` is deliberately NOT invented. Anthropic's own thinking blocks carry one, and
 * `emitSse.ts` preserves it when a backend supplied it, but DeepSeek states no signature and
 * fabricating one would be the invented measurement this repo's provenance invariant forbids. The
 * block is replayed to DeepSeek as `reasoning_content` — text only — so nothing needs it.
 */
function deepSeekReasoningText(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}

/**
 * The Anthropic `thinking` block for a DeepSeek answer's `reasoning_content`, or null when there
 * is nothing to carry (a non-`"deepseek"` target, an absent field, or an empty string — never a
 * fabricated empty block).
 */
function deepSeekThinkingBlock(
  reasoningContent: unknown,
  mode: ReasoningMode | undefined,
): { type: "thinking"; thinking: string } | null {
  if (mode !== "deepseek") return null;
  const text = deepSeekReasoningText(reasoningContent);
  return text === null ? null : { type: "thinking", thinking: text };
}

/**
 * The marker a DeepSeek reasoning delta is rewritten to carry, so the field survives llm-bridge's
 * parser and can be turned back into a `thinking` delta one layer later.
 *
 * ⚠ A NUL byte, deliberately: it cannot appear in model-authored text, and a provider that emitted
 * one at all would have to escape it in the JSON — which `JSON.stringify` re-emits verbatim on the
 * way back out, so this rewrite cannot manufacture a false positive out of ordinary prose. A
 * printable marker would be a string a model could legitimately emit and have silently
 * reinterpreted as its own reasoning.
 */
const DEEPSEEK_REASONING_SENTINEL = " llm-relay-reasoning ";

/**
 * Rewrite one RAW Chat SSE frame so DeepSeek's `reasoning_content` survives llm-bridge's parser.
 *
 * llm-bridge's `parseOpenAIStream` reads only `delta.content` and `delta.tool_calls`, so a
 * reasoning delta becomes NOTHING and there is no later layer to recover it from — the `transform`
 * hook `handleUniversalStreamRequest` accepts is downstream of the drop. This rewrite moves the
 * field to where the parser DOES look: the reasoning text is prepended to `delta.content` behind
 * the sentinel, and `reasoning_content` itself is left in place (untouched and therefore still
 * honest on the wire this frame describes — only the parser's view of `content` is redirected).
 *
 * ⚠ Content that is not a string (null is what DeepSeek sends alongside reasoning, and an array is
 * legal for some hosts) is REPLACED, not merged: there is no text to prepend to, and dropping a
 * structured content array into a string would corrupt it. Such a frame carries no answer text by
 * construction — the reasoning and the answer never share a frame — so nothing is lost.
 *
 * Every other frame is returned byte-for-byte unchanged, and the caller only invokes this at all
 * under a RESOLVED `"deepseek"` mode.
 */
function rewriteChatFrameForReasoning(frame: string): string {
  const event = parseSseEvent(frame);
  const data = event?.data;
  if (!data) return frame;
  const choice = Array.isArray(data.choices) ? data.choices[0] : undefined;
  if (!isRecord(choice) || !isRecord(choice.delta)) return frame;
  const reasoning = deepSeekReasoningText(choice.delta.reasoning_content);
  if (reasoning === null) return frame;
  const text = typeof choice.delta.content === "string" ? choice.delta.content : "";
  const rewritten = {
    ...data,
    choices: [
      { ...choice, delta: { ...choice.delta, content: `${DEEPSEEK_REASONING_SENTINEL}${reasoning}${text}` } },
      ...(data.choices as unknown[]).slice(1),
    ],
  };
  // Re-emitted on the SAME `data:` line shape the parser reads. Only the fields this rewrite
  // touched are rebuilt; the rest of the frame's JSON is carried through by the spread.
  return frame.replace(/^(data:\s*)[\s\S]*$/m, `$1${JSON.stringify(rewritten)}`);
}

/**
 * Turn the sentinel-prefixed `content_delta` back into a `thinking` delta, passing everything else
 * through untouched.
 *
 * This is the `transform` `handleUniversalStreamRequest` accepts, and it is what makes the ordering
 * exact: llm-bridge preserves event order, so a reasoning delta lands in the Anthropic stream at
 * the position its frame occupied — including a reasoning frame that arrives BETWEEN answer
 * chunks, which DeepSeek's own captures show it can. llm-bridge's own `emitAnthropicStream` then
 * does the block bookkeeping (opening a `thinking` block, closing the text block before it,
 * emitting `thinking_delta` frames), so no Anthropic SSE is hand-built here.
 */
async function* deepSeekReasoningTransform(
  events: AsyncIterable<{ type: string; delta?: Record<string, unknown>; [k: string]: unknown }>,
): AsyncGenerator<{ type: string; delta?: Record<string, unknown>; [k: string]: unknown }> {
  for await (const event of events) {
    const text = event.type === "content_delta" ? event.delta?.text : undefined;
    if (typeof text === "string" && text.startsWith(DEEPSEEK_REASONING_SENTINEL)) {
      yield { type: "content_delta", delta: { thinking: text.slice(DEEPSEEK_REASONING_SENTINEL.length) } };
    } else {
      yield event;
    }
  }
}

/**
 * The RAW Chat SSE of a `"deepseek"` target, with every reasoning frame rewritten through
 * `rewriteChatFrameForReasoning` and every other frame passed through byte-for-byte.
 *
 * Frame-framed rather than string-replaced on purpose: a `data:` payload is JSON that may legally
 * contain the substring `reasoning_content` inside a model's own answer text, and only a parsed
 * frame can tell the field from the prose. The rewrite is a no-op — and this stream a pass-through
 * that touches no bytes — when the target sent no reasoning at all.
 */
function deepSeekReasoningFrames(
  upstream: ReadableStream<Uint8Array>,
): ReadableStream<Uint8Array> {
  return createSseTransformStream(upstream, ({ push, frames }) => ({
    processFrames: () => {
      for (const { frame, raw, separator } of frames) {
        const rewritten = rewriteChatFrameForReasoning(frame);
        push(rewritten === frame ? raw : `${rewritten}${separator}`);
      }
    },
  }));
}

/**
 * The provider's `Retry-After` in milliseconds, or null.
 *
 * Accepts both RFC 9110 forms — delta-seconds and an HTTP-date — because providers use both
 * (groq sends seconds, some CDNs in front of a provider send a date). A date in the past, a
 * negative delta or an unparseable value yields null rather than 0: "the provider said nothing
 * usable" and "the provider said retry immediately" call for different cooldowns, and treating
 * garbage as 0 would silently disable the backoff this exists to honour.
 */
export function parseRetryAfterMs(value: string | null | undefined, now = Date.now()): number | null {
  if (typeof value !== "string") return null;
  const raw = value.trim();
  if (raw.length === 0) return null;

  // delta-seconds — integer per the RFC, but providers do emit fractions ("20.45").
  if (/^\d+(\.\d+)?$/.test(raw)) {
    const ms = Math.round(Number(raw) * 1000);
    return Number.isFinite(ms) && ms >= 0 ? ms : null;
  }

  const at = Date.parse(raw);
  if (Number.isNaN(at)) return null;
  const delta = at - now;
  return delta > 0 ? delta : null;
}

// Response provenance is private process state, not a wire header: callers can
// read it for logging without accidentally forwarding it to the client.
const upstreamResponseMetadata = new WeakMap<Response, UpstreamResponseMetadata>();

/**
 * A fetch completed far enough to yield provider headers, but consuming its body failed.
 *
 * This is process-local metadata rather than a wire marker. Adapters sometimes have to consume
 * and rebuild an error response before the routing loop sees it; retaining this discriminant on
 * the original Response prevents that failure from being rewritten as an empty credential error.
 */
export interface PostHeaderBodyFailure {
  readonly kind: "post-header-body-failure";
  readonly cause: unknown;
}

const postHeaderBodyFailures = new WeakMap<Response, PostHeaderBodyFailure>();

function attachPostHeaderBodyFailure(response: Response, cause: unknown): Response {
  postHeaderBodyFailures.set(response, { kind: "post-header-body-failure", cause });
  return response;
}

/** Read adapter-private post-header body failure metadata. */
export function postHeaderBodyFailure(response: Response): PostHeaderBodyFailure | undefined {
  return postHeaderBodyFailures.get(response);
}

/** Raw model id stated by the upstream response, before any relay translation. */
export function upstreamReportedModel(response: Response): string | undefined {
  return upstreamResponseMetadata.get(response)?.reportedModel;
}

/**
 * How many `tool_use` ids this response had minted, or `undefined` when none were.
 *
 * On a streamed response the figure is final only once the body has drained — read it where the
 * server reports end-of-stream facts, not before it writes headers.
 */
export function toolUseIdRewrites(response: Response): number | undefined {
  const n = upstreamResponseMetadata.get(response)?.toolUseIdRewrites;
  return n !== undefined && n > 0 ? n : undefined;
}

/**
 * How many OUTBOUND tool-call ids this request had rewritten to the provider's stated shape, or
 * `undefined` when none were. Final at request-mapping time, so it is readable as soon as the
 * Response exists.
 */
export function toolCallIdRewrites(response: Response): number | undefined {
  const n = upstreamResponseMetadata.get(response)?.toolCallIdRewrites;
  return n !== undefined && n > 0 ? n : undefined;
}

/**
 * How many replayed tool calls this request carried gemini's thought-signature sentinel on, or
 * `undefined` when none did. Final at request-mapping time, like `toolCallIdRewrites`.
 */
export function thoughtSignatureSentinels(response: Response): number | undefined {
  const n = upstreamResponseMetadata.get(response)?.thoughtSignatureSentinels;
  return n !== undefined && n > 0 ? n : undefined;
}

function attachUpstreamMetadata(response: Response, metadata: UpstreamResponseMetadata): Response {
  upstreamResponseMetadata.set(response, metadata);
  return response;
}

/**
 * Fetch the resolved provider target and return an ANTHROPIC-shaped `Response`,
 * regardless of the backend's native wire format. For kind="anthropic" this is a
 * passthrough. For kind="openai" (NIM/vLLM/OpenRouter/Gemini) the request is
 * translated Anthropic→OpenAI and the response translated back (streaming via
 * llm-bridge's SSE re-encoder, non-streaming via a direct mapper) — so the rest
 * of the proxy (validate/repair) always sees Anthropic Messages.
 */
export interface FetchBackendArgs {
  path: string;
  method: string;
  reqBuf: Buffer;
  reqJson: unknown;
  anthropicHeaders: Record<string, string>;
  wantsStream: boolean;
  /**
   * The operator's configured destructive-tool set (`destructiveMatcher`). REQUIRED, not
   * optional: it reaches the four dialect-rescue commit points, and an optional field here would
   * let a caller silently disable the refusal — the failure mode that gap existed as.
   */
  isDestructive: (name: string) => boolean;
  usage?: UsageAccumulator;
  signal: AbortSignal;
  onEgress?: OnEgress;
}

async function fetchAnthropicBackend(
  attempt: ResolvedAttempt,
  args: FetchBackendArgs,
  invokeFetch: typeof fetch,
): Promise<Response> {
  const target = attempt.target;
  const init: RequestInit = { method: args.method, headers: args.anthropicHeaders, signal: args.signal };
  if (target.model && args.reqJson && typeof args.reqJson === "object" && (args.reqJson as Record<string, unknown>).model !== target.model) {
    init.body = JSON.stringify({ ...(args.reqJson as Record<string, unknown>), model: target.model });
  } else if (args.reqBuf.length) {
    init.body = args.reqBuf;
  }
  const native = await invokeFetch(target.base + args.path, init);
  const nativeStreamed = nativeResponseIsStreamed(native, args.wantsStream);
  const res = args.usage
    ? observeUsage(native, "anthropic-messages", args.usage, { streamed: nativeStreamed })
    : native;
  // Preserve passthrough bytes, but do not preserve a successful status for a malformed
  // Messages envelope. Inspecting a clone leaves the original buffered body byte-exact.
  const messagesPath = args.path.split("?", 1)[0] === "/v1/messages";
  if (!res.ok || !messagesPath) return res;
  const streamed = args.wantsStream || (res.headers.get("content-type") ?? "").includes("text/event-stream");
  if (streamed) {
    if (!res.body) {
      return anthropicError(502, "llm-relay: invalid Anthropic upstream envelope: empty stream", "upstream", {
        ...retryAfterHeader(res.headers),
      }, "invalid_upstream_envelope");
    }
    const preflight = await preflightResponseStream(res.body, "anthropic-messages");
    if (!preflight.ok) {
      return anthropicError(502, `llm-relay: invalid Anthropic upstream envelope: ${preflight.reason}`, "upstream", {
        ...retryAfterHeader(res.headers),
      }, "invalid_upstream_envelope");
    }
    return attachUpstreamMetadata(
      new Response(preflight.body, { status: res.status, headers: res.headers }),
      preflight.metadata,
    );
  }

  let body: unknown;
  try {
    body = await res.clone().json();
  } catch (cause) {
    if (!(cause instanceof SyntaxError)) return attachPostHeaderBodyFailure(res, cause);
    return anthropicError(502, "llm-relay: invalid Anthropic upstream envelope: body is not valid JSON", "upstream", {
      ...retryAfterHeader(res.headers),
    }, "invalid_upstream_envelope");
  }
  const invalidReason = invalidEnvelopeReason(body, "anthropic-messages", false);
  if (invalidReason) {
    return anthropicError(502, `llm-relay: invalid Anthropic upstream envelope: ${invalidReason}`, "upstream", {
      ...retryAfterHeader(res.headers),
    }, "invalid_upstream_envelope");
  }
  const metadata: UpstreamResponseMetadata = {};
  captureReportedModel(metadata, body, "anthropic-messages", false);
  return attachUpstreamMetadata(res, metadata);
}

async function fetchOpenAiBackend(
  attempt: ResolvedAttempt,
  args: FetchBackendArgs,
  invokeFetch: typeof fetch,
): Promise<Response> {
  // A `wire: "responses"` target (OpenCode Zen's contributor SKUs; see
  // docs/muse-spark-1.3-opencode-zen-2026-09-04.md) speaks the OpenAI Responses API, not Chat
  // Completions, so it needs its own request/response mapping and its own upstream path. Kept as
  // an early dispatch rather than threading `wire` through every branch below, so the existing
  // (far more common) Chat Completions path is untouched byte for byte.
  if (attempt.target.wire === "responses") {
    return fetchOpenAiResponsesBackend(attempt, args, invokeFetch);
  }
  const target = attempt.target;
  // Documents are transcoded to markdown BEFORE the request mapper, or refused: a `document`
  // block has no OpenAI representation, and the pre-mapper behaviour put its whole base64
  // payload into the prompt. The pre-pass walks the top level of each turn AND the content of
  // each `tool_result`, so a document a tool returned is converted rather than refused.
  let reqJson = args.reqJson;
  try {
    reqJson = await transcodeDocuments(reqJson);
  } catch (e) {
    // Local, both of them: the provider was never asked. Charging these to the provider's
    // failure budget fails over to a second provider that would refuse the same document.
    if (e instanceof DocumentError) return anthropicError(400, `llm-relay: ${e.message}`, "local");
    return anthropicError(502, `document conversion failed: ${(e as Error).message}`, "local");
  }

  let openaiBody: Record<string, unknown>;
  // Outbound id rewrites, from the RESOLVED compat mode on the target — the mapper is handed a
  // decision, never a provider name to re-derive one from. `preserve` (everyone but mistral)
  // leaves this 0 and the outbound bytes untouched.
  let toolCallIdsRewritten = 0;
  // The sibling pass, resolved the same way: `none` (everyone but Google's Generative Language
  // API) leaves this 0 and adds nothing to the body.
  let sentinelsStamped = 0;
  // F10/F11: 1 when a "deepseek" target's natural thinking decision was overridden to disabled
  // (forced tool choice, or a replay with no reasoning to carry forward); 0 on every other
  // provider and 0 here too when nothing needed overriding. See `DEEPSEEK_THINKING_HEADER`.
  let thinkingOverridden = 0;
  try {
    // The REQUEST direction is relay-owned (`openai-request.ts`); only the RESPONSE direction is
    // still llm-bridge's. llm-bridge's `universalToOpenAI` has no case for a tool_call/tool_result
    // block, so it stringified its own IR envelope into the outbound prompt — see
    // docs/tool-call-dialect-leak.md §"Second mechanism".
    openaiBody = anthropicRequestToOpenAi(reqJson, {
      model: target.model,
      stream: args.wantsStream,
      ...(target.toolCallIds !== undefined ? { toolCallIds: target.toolCallIds } : {}),
      onToolCallIdsRewritten: (n) => { toolCallIdsRewritten = n; },
      ...(target.thoughtSignature !== undefined ? { thoughtSignature: target.thoughtSignature } : {}),
      onThoughtSignatureSentinels: (n) => { sentinelsStamped = n; },
      ...(target.reasoning !== undefined ? { reasoning: target.reasoning } : {}),
      ...(target.effort !== undefined ? { effort: target.effort } : {}),
      onDeepSeekThinkingOverridden: (n) => { thinkingOverridden = n; },
    });
  } catch (e) {
    // A block we will not put on the wire is the caller's request being unrepresentable, not a
    // provider failure — same clean local 400 as an unconvertible document.
    if (e instanceof RequestMappingError) return anthropicError(400, `llm-relay: ${e.message}`, "local");
    return anthropicError(502, `request translation failed: ${(e as Error).message}`, "local");
  }
  // OpenAI-compatible backends omit usage from streamed responses unless asked. Without
  // this the translated `message_delta` reports output_tokens: 0 and anything metering
  // off the stream undercounts. Not universally supported — see the 400 retry below.
  if (args.wantsStream) openaiBody.stream_options = { include_usage: true };

  const post = (body: Record<string, unknown>) =>
    invokeFetch(target.base + "/chat/completions", {
      method: "POST",
      headers: buildTargetHeaders(attempt),
      body: JSON.stringify(body),
      signal: args.signal,
    });

  let res = await post(openaiBody);

  // A backend that doesn't know `stream_options` rejects the whole request (400/422).
  // Drop the hint and retry once rather than failing a request over telemetry.
  if (!res.ok && openaiBody.stream_options && (res.status === 400 || res.status === 422)) {
    await res.body?.cancel().catch(() => {});
    const { stream_options: _omit, ...withoutUsage } = openaiBody;
    res = await post(withoutUsage);
  }

  if (args.usage) {
    const nativeStreamed = nativeResponseIsStreamed(res, args.wantsStream);
    res = observeUsage(res, "openai-chat", args.usage, { streamed: nativeStreamed });
  }

  if (!res.ok) {
    let body: string;
    try {
      body = await res.text();
    } catch (cause) {
      return attachPostHeaderBodyFailure(res, cause);
    }
    // A 404 here is nearly always the model id, not the route — and a provider's
    // /models catalog is not proof: several ids NIM lists return 404 from
    // /chat/completions. Say so, or this reads as a proxy bug.
    const hint =
      res.status === 404
        ? ` — model "${target.model}" is not served by provider "${target.provider}" (a model can be listed in /models and still 404 here)`
        : "";
    // The provider really answered with this status — the body is reworded, the origin is not.
    // `Retry-After` is carried onto the synthesized error: this response is a NEW Response, so
    // without this the one header stating when the provider will serve again was destroyed here,
    // and neither the breaker's cooldown nor the client's backoff could ever honour it.
    return anthropicError(res.status, `openai backend HTTP ${res.status}${hint}: ${body.slice(0, 300)}`, "upstream", {
      ...retryAfterHeader(res.headers),
    });
  }

  if (args.wantsStream) {
    if (!res.body) {
      return anthropicError(502, "llm-relay: invalid OpenAI upstream envelope: empty stream", "upstream", {
        ...retryAfterHeader(res.headers),
      }, "invalid_upstream_envelope");
    }
    const preflight = await preflightResponseStream(res.body, "openai-chat");
    if (!preflight.ok) {
      return anthropicError(502, `llm-relay: invalid OpenAI upstream envelope: ${preflight.reason}`, "upstream", {
        ...retryAfterHeader(res.headers),
      }, "invalid_upstream_envelope");
    }
    try {
      // A "deepseek" target gets its reasoning carried through: llm-bridge's parser reads only
      // `content`/`tool_calls` and would drop `reasoning_content` outright, so the relay rewrites
      // the RAW frames to smuggle it past the parser and turns it back into `thinking` deltas one
      // layer up — see `deepSeekReasoningFrames`. Every other target takes the plain call below,
      // byte for byte, with no extra stream in the path.
      const anthStream = target.reasoning === "deepseek"
        ? handleUniversalStreamRequest(
          deepSeekReasoningFrames(preflight.body),
          "openai",
          "anthropic",
          deepSeekReasoningTransform as never,
        )
        : handleUniversalStreamRequest(preflight.body, "openai", "anthropic");
      // Strip a complete message-opening think block BEFORE dialect scanning. Otherwise the
      // preamble can hide a tool envelope from recovery. Native Anthropic streams never enter
      // this branch, and direct OpenAI Chat passthrough is handled on the other front.
      const strippedStream = stripThinkTagsInStream(anthStream);
      // Recover a tool call this host returned as raw dialect TEXT. Gated on the request actually
      // declaring tools: with none declared there is no call to recover, and wrapping the stream
      // would add holdback latency for nothing.
      const schemas = toolSchemaMap(args.reqJson) as Map<string, { type?: unknown; properties?: Record<string, { type?: unknown }> }>;
      const refusalSignal = dialectRefusalSignal();
      const recovered = schemas.size > 0
        ? recoverDialectInStream(strippedStream, schemas, args.isDestructive, refusalSignal)
        : strippedStream;
      // AFTER recovery, so a call the relay reconstructed is covered too, and BEFORE anything that
      // watches for the first `tool_use` — validation and repair must see the ids the client will.
      // The taken-set is a thunk: a response with no tool call never walks the conversation.
      // ⚠ Deliberately NOT gated on `schemas.size > 0` like the line above, and the asymmetry is
      // the point: recovery needs a schema to parse a call out of text, uniqueness needs only an
      // id to exist. A host may emit `tool_calls` a request never declared — Claude Code's compact
      // turn declares none while the conversation it summarizes is full of tool_use ids — and that
      // is exactly the turn the normalizer would empty to `[Tool use interrupted]`. The framing
      // holdback is already paid by `stripThinkTagsInStream` above, and an event with no
      // `tool_use` substring costs one scan, so the gate would buy little and lose that case.
      const metadata = preflight.metadata;
      if (toolCallIdsRewritten > 0) metadata.toolCallIdRewrites = toolCallIdsRewritten;
      if (sentinelsStamped > 0) metadata.thoughtSignatureSentinels = sentinelsStamped;
      const body = rewriteToolUseIdsInStream(
        recovered,
        () => knownToolUseIds(args.reqJson),
        (count) => { metadata.toolUseIdRewrites = count; },
      );
      const streamResponse = attachUpstreamMetadata(
        new Response(body, {
          status: res.status,
          headers: {
            "content-type": "text/event-stream",
            // Unlike the response-direction mint, this count is a REQUEST fact and was final
            // before a byte was sent — so a stream can announce it honestly.
            ...(toolCallIdsRewritten > 0 ? { [TOOL_CALL_IDS_HEADER]: `${toolCallIdsRewritten} rewritten` } : {}),
            // Same rule: final before egress, so a streamed response can announce it too.
            ...(thinkingOverridden > 0
              ? { [DEEPSEEK_THINKING_HEADER]: "disabled: tool_choice or missing reasoning replay" }
              : {}),
          },
        }),
        metadata,
      );
      dialectRefusalSignals.set(streamResponse, refusalSignal);
      return streamResponse;
    } catch (e) {
      return anthropicError(502, `llm-relay: response translation failed: ${(e as Error).message}`, "local", {}, "relay_mapper_defect");
    }
  }

  let upstreamJson: unknown;
  try {
    upstreamJson = await res.json();
  } catch (cause) {
    if (!(cause instanceof SyntaxError)) return attachPostHeaderBodyFailure(res, cause);
    return anthropicError(502, "llm-relay: invalid OpenAI upstream envelope: body is not valid JSON", "upstream", {
      ...retryAfterHeader(res.headers),
    }, "invalid_upstream_envelope");
  }
  const invalidReason = invalidEnvelopeReason(upstreamJson, "openai-chat", false);
  if (invalidReason) {
    return anthropicError(502, `llm-relay: invalid OpenAI upstream envelope: ${invalidReason}`, "upstream", {
      ...retryAfterHeader(res.headers),
    }, "invalid_upstream_envelope");
  }

  let anthropicJson: object;
  try {
    const schemas = toolSchemaMap(args.reqJson) as Map<string, { type?: unknown; properties?: Record<string, { type?: unknown }> }>;
    anthropicJson = openAiResponseToAnthropic(
      upstreamJson as Record<string, unknown>,
      target.model ?? "",
      schemas,
      args.isDestructive,
      target.reasoning,
    );
  } catch (e) {
    if (e instanceof DialectUnparseableError) {
      // NOT a mapper defect — the translation is fine and the HOST returned an unusable body. It
      // counts against this deployment so the breaker sees it and the pool fails over to a host
      // that parses its models' dialect. 502 is retriable, which is what drives the walk.
      return anthropicError(502, `llm-relay: ${e.message}`, "upstream", {}, "tool_dialect_unparseable");
    }
    if (e instanceof DialectDestructiveError) {
      // "local" is the load-bearing part: it makes `localFailure` true in the walk, so the request
      // is NOT rerolled onto another candidate and the deployment is not blamed. A refusal is a
      // config decision, not a health signal — the same line the hard cap draws.
      return anthropicError(
        502,
        `llm-relay: ${e.message}`,
        "local",
        { [TOOL_DIALECT_HEADER]: "refused-destructive" },
        DIALECT_REFUSED_DESTRUCTIVE_CODE,
      );
    }
    // The provider returned a valid source envelope, so a failure after this point belongs to
    // the relay mapper rather than the provider or its failure budget.
    return anthropicError(502, `llm-relay: response translation failed: ${(e as Error).message}`, "local", {}, "relay_mapper_defect");
  }
  // A host that reuses a tool-call id across turns makes Claude Code drop the call while building
  // its next request; mint a fresh one where it collides. The pass runs on the TRANSLATED message,
  // so a dialect-recovered call is covered too and keeps its `tu_recovered_*` id unless that id is
  // itself already in the conversation. See `src/tool-use-ids.ts`.
  const mintedIds = mintUniqueToolUseIds(anthropicJson, args.reqJson);
  if (mintedIds.message) anthropicJson = mintedIds.message;
  // Announce a recovered call for the same reason `x-llm-relay-degraded` is announced: a response
  // whose tool call the RELAY reconstructed is not the same as one that arrived correct, and an
  // unflagged reconstruction is indistinguishable from a host that worked.
  const recoveredDialect = recoveredDialectOf(anthropicJson);
  const response = new Response(JSON.stringify(anthropicJson), {
    status: 200,
    headers: {
      "content-type": "application/json",
      ...(recoveredDialect ? { [TOOL_DIALECT_HEADER]: recoveredDialect } : {}),
      ...(mintedIds.rewritten > 0
        ? { [TOOL_USE_IDS_HEADER]: `${mintedIds.rewritten} rewritten` }
        : {}),
      ...(toolCallIdsRewritten > 0
        ? { [TOOL_CALL_IDS_HEADER]: `${toolCallIdsRewritten} rewritten` }
        : {}),
      ...(thinkingOverridden > 0
        ? { [DEEPSEEK_THINKING_HEADER]: "disabled: tool_choice or missing reasoning replay" }
        : {}),
    },
  });
  const metadata: UpstreamResponseMetadata = {};
  captureReportedModel(metadata, upstreamJson, "openai-chat", false);
  if (mintedIds.rewritten > 0) metadata.toolUseIdRewrites = mintedIds.rewritten;
  if (toolCallIdsRewritten > 0) metadata.toolCallIdRewrites = toolCallIdsRewritten;
  // No header for this one — see `UpstreamResponseMetadata.thoughtSignatureSentinels`.
  if (sentinelsStamped > 0) metadata.thoughtSignatureSentinels = sentinelsStamped;
  return attachUpstreamMetadata(response, metadata);
}

/**
 * ============================================================================================
 * OpenAI RESPONSES wire (`wire: "responses"`) — the UPSTREAM speaker.
 * ============================================================================================
 *
 * OpenCode Zen serves its contributor SKUs (Meta Muse Spark 1.3 included) on `POST /responses`
 * only — `/chat/completions` and Zen's Anthropic-shaped `/messages` both answer HTTP 500 for them
 * (measured 2026-08-04, `docs/muse-spark-1.3-opencode-zen-2026-09-04.md` rows 3, 6-8). Until this
 * section, `Kind` was `"anthropic" | "openai"` and every `openai`-kind target spoke Chat
 * Completions; a `wire: "responses"` target instead speaks the OpenAI Responses API, and this is
 * the mirror of the existing `openai`-kind (Chat) machinery above: a request mapper
 * (`anthropicRequestToOpenAiResponses`, the inverse of `src/responses-request.ts`'s Responses→
 * Anthropic FRONT mapper), a buffered response mapper (`openAiResponsesToAnthropicMessage`, the
 * sibling of `openAiResponseToAnthropic` above), and a streaming translator
 * (`translateResponsesStreamToAnthropic`) that turns the Responses typed SSE event stream into
 * Anthropic SSE — llm-bridge has no Responses-as-a-backend translation to reuse, only the Chat one
 * this file already calls via `handleUniversalStreamRequest(..., "openai", "anthropic")`.
 *
 * Kept in THIS file rather than a new `src/responses-upstream.ts` (which the packet brief for this
 * work offered as a normal split, conditioned on "if backend.ts would otherwise grow past
 * readability"): `test/architecture-map.test.ts` pins every `src/*.ts` file to a CLAUDE.md
 * Architecture-table row, and the row would have to be CLAUDE.md's — which this change is
 * forbidden from touching. Folding the mapping into `backend.ts`, which already has a row, avoids
 * that conflict entirely; nothing else motivated the choice.
 *
 * The dialect-rescue orchestration (`recoverOpenAiTextDialect`, `DialectUnparseableError`,
 * `DialectDestructiveError`) stays exactly where it already lives, a few hundred lines below —
 * `openAiResponsesToAnthropicMessage` calls it directly rather than re-declaring a second set of
 * error classes, the same reuse `ToolCallIds`/`ThoughtSignatures` get from `openai-request.ts`.
 */

type ResponsesRec = Record<string, unknown>;

/** Name an unexpected block/item type without echoing an arbitrary payload back at the caller. */
function describeResponsesType(t: unknown): string {
  return typeof t === "string" && t.length > 0 ? `"${t.slice(0, 40)}"` : "(missing type)";
}

// ---------------------------------------------------------------------------------------------
// Request direction: Anthropic Messages -> OpenAI Responses.
//
// The inverse of `src/responses-request.ts` (`openaiResponsesRequestToAnthropic`) — read that
// file's header first; the per-field decisions below mirror its reasoning in the opposite
// direction, and diverge only where the two wire shapes are not symmetric (noted inline).
// ---------------------------------------------------------------------------------------------

export interface AnthropicToOpenAiResponsesOptions {
  /** The resolved deployment's model id. Absent => no `model` key, same convention as `openai-request.ts`. */
  model?: string | undefined;
  /** Whether THIS hop streams — a relay decision, not the caller's. Falls back to the body. */
  stream?: boolean | undefined;
  /** Same resolved mode `anthropicRequestToOpenAi` receives; see that module for the provenance. */
  toolCallIds?: ToolCallIdMode | undefined;
  onToolCallIdsRewritten?: ((count: number) => void) | undefined;
  thoughtSignature?: ThoughtSignatureMode | undefined;
  onThoughtSignatureSentinels?: ((count: number) => void) | undefined;
}

/**
 * `system` (string or text blocks) -> the `instructions` string. Joined with a blank line, the
 * same convention `openai-request.ts`'s `systemText` uses for Chat's `system` message — these are
 * independent documents (harness preamble, project instructions, …), not one continuous sentence.
 */
function responsesSystemText(system: unknown): string {
  if (typeof system === "string") return system;
  if (!Array.isArray(system)) return "";
  const parts: string[] = [];
  for (const block of system) {
    if (isRecord(block) && block.type === "text" && typeof block.text === "string") parts.push(block.text);
  }
  return parts.join("\n\n");
}

/**
 * One Anthropic `image` block -> a Responses `input_image` part. Unlike Chat's `image_url`, the
 * Responses shape carries the URL as a plain STRING field, not a nested `{url}` object.
 */
function responsesInputImagePart(block: ResponsesRec): ResponsesRec {
  const source = isRecord(block.source) ? block.source : {};
  if (source.type === "url" && typeof source.url === "string") return { type: "input_image", image_url: source.url };
  if (source.type === "base64" && typeof source.data === "string" && typeof source.media_type === "string") {
    return { type: "input_image", image_url: `data:${source.media_type};base64,${source.data}` };
  }
  throw new RequestMappingError("image block needs a base64 or url source");
}

/**
 * Split one Anthropic `tool_result` into a Responses `function_call_output.output` string and
 * its image parts — the SAME lossless-carry decision `openai-request.ts`'s `toolResultParts`
 * makes for Chat: a `function_call_output.output` is a plain string, so an image has nowhere to
 * go there and is instead carried on the trailing user item (see `responsesUserItems`). Refusing
 * it would kill the whole request on every Responses-wire lane over one screenshot; the relay
 * chose losslessness there and the same reasoning applies here unchanged.
 */
function responsesToolResultParts(content: unknown): { text: string; images: ResponsesRec[] } {
  if (content === undefined || content === null) return { text: "", images: [] };
  if (typeof content === "string") return { text: content, images: [] };
  if (!Array.isArray(content)) {
    throw new RequestMappingError("tool_result content must be text or a list of blocks");
  }
  const texts: string[] = [];
  const images: ResponsesRec[] = [];
  for (const raw of content) {
    if (!isRecord(raw)) throw new RequestMappingError("tool_result content block is not an object");
    switch (raw.type) {
      case "text":
        texts.push(typeof raw.text === "string" ? raw.text : "");
        break;
      case "image":
        images.push(responsesInputImagePart(raw));
        break;
      default:
        throw new RequestMappingError(
          `tool_result carries an unsupported ${describeResponsesType(raw.type)} block; a Responses function_call_output carries text and images only`,
        );
    }
  }
  return { text: texts.join("\n"), images };
}

/** One Anthropic `tool_result` block -> a Responses `function_call_output` item, plus its images. */
function responsesToolResultItem(
  block: ResponsesRec,
  ids: ToolCallIds | null,
): { item: ResponsesRec; images: ResponsesRec[] } {
  if (typeof block.tool_use_id !== "string" || block.tool_use_id.length === 0) {
    throw new RequestMappingError("tool_result block without a tool_use_id");
  }
  const callId = ids === null ? block.tool_use_id : ids.map(block.tool_use_id);
  const { text, images } = responsesToolResultParts(block.content);
  return { item: { type: "function_call_output", call_id: callId, output: text }, images };
}

/**
 * One Anthropic `tool_use` block -> a Responses `function_call` item (no `role`, unlike a
 * `message` item). `ids`/`sigs` are the SAME per-run passes `anthropicRequestToOpenAi` runs for
 * Chat — reused via `ToolCallIds`/`ThoughtSignatures` from `openai-request.ts` rather than
 * hand-copied, so a `strict9`/`sentinel` provider fact applies identically regardless of wire.
 */
function responsesFunctionCallItem(
  block: ResponsesRec,
  ids: ToolCallIds | null,
  sigs: ThoughtSignatures | null,
): ResponsesRec {
  if (typeof block.id !== "string" || block.id.length === 0) {
    throw new RequestMappingError("tool_use block without an id");
  }
  if (typeof block.name !== "string" || block.name.length === 0) {
    throw new RequestMappingError("tool_use block without a name");
  }
  const input = block.input ?? {};
  const item: ResponsesRec = {
    type: "function_call",
    call_id: ids === null ? block.id : ids.map(block.id),
    name: block.name,
    arguments: typeof input === "string" ? input : JSON.stringify(input),
  };
  return sigs === null ? item : sigs.stamp(item);
}

/**
 * An Anthropic assistant turn -> zero or more Responses input items: one `{role:"assistant"}`
 * message item per non-empty text block, one `function_call` item per `tool_use` block, in the
 * turn's original order. Unlike the Chat mapper this does NOT merge consecutive text blocks into
 * one item — Responses' `input` is a flat item array with no Chat-style "one message per role run"
 * constraint, so one item per block is simplest and equally correct. `thinking`/`redacted_thinking`
 * are DROPPED — no representation, and a guessed `reasoning.effort` would be an invention (the rule
 * `openai-request.ts` already states for the Chat direction).
 */
function responsesAssistantItems(
  turn: ResponsesRec,
  ids: ToolCallIds | null,
  sigs: ThoughtSignatures | null,
): ResponsesRec[] {
  const content = turn.content;
  if (typeof content === "string") {
    return content.length > 0 ? [{ role: "assistant", content: [{ type: "output_text", text: content }] }] : [];
  }
  const out: ResponsesRec[] = [];
  for (const raw of Array.isArray(content) ? content : []) {
    if (!isRecord(raw)) throw new RequestMappingError("assistant content block is not an object");
    switch (raw.type) {
      case "text": {
        const text = typeof raw.text === "string" ? raw.text : "";
        if (text.length > 0) out.push({ role: "assistant", content: [{ type: "output_text", text }] });
        break;
      }
      case "tool_use":
        out.push(responsesFunctionCallItem(raw, ids, sigs));
        break;
      case "thinking":
      case "redacted_thinking":
        break;
      default:
        throw new RequestMappingError(`unsupported assistant content block ${describeResponsesType(raw.type)}`);
    }
  }
  return out;
}

/**
 * An Anthropic user turn -> Responses input items: every `function_call_output` FIRST (mirroring
 * `openai-request.ts`'s "tool messages lead" rule for Chat — the assistant's `function_call` a
 * result answers was already emitted, and a provider's own linkage check is at least as strict as
 * Chat's), then one `{role:"user"}` item carrying any images those results carried (the same
 * trailing placement `toolResultParts`/`userMessages` use for Chat), then one `{role:"user"}` item
 * for the turn's own text/image content, in original order. A wholly empty turn (no tool results,
 * no content) emits nothing — Anthropic itself rejects an empty turn, so this is never reached in
 * practice; inventing an empty `input_text` part risks a Responses-side rejection for no benefit.
 */
function responsesUserItems(turn: ResponsesRec, ids: ToolCallIds | null): ResponsesRec[] {
  const content = turn.content;
  if (typeof content === "string") {
    return content.length > 0 ? [{ role: "user", content: [{ type: "input_text", text: content }] }] : [];
  }
  const toolResultItems: ResponsesRec[] = [];
  const trailingImages: ResponsesRec[] = [];
  const contentParts: ResponsesRec[] = [];
  for (const raw of Array.isArray(content) ? content : []) {
    if (!isRecord(raw)) throw new RequestMappingError("user content block is not an object");
    switch (raw.type) {
      case "text": {
        const text = typeof raw.text === "string" ? raw.text : "";
        if (text.length > 0) contentParts.push({ type: "input_text", text });
        break;
      }
      case "image":
        contentParts.push(responsesInputImagePart(raw));
        break;
      case "tool_result": {
        const { item, images } = responsesToolResultItem(raw, ids);
        toolResultItems.push(item);
        trailingImages.push(...images);
        break;
      }
      case "thinking":
      case "redacted_thinking":
        break;
      default:
        throw new RequestMappingError(`unsupported user content block ${describeResponsesType(raw.type)}`);
    }
  }
  const out: ResponsesRec[] = [...toolResultItems];
  if (trailingImages.length > 0) out.push({ role: "user", content: trailingImages });
  if (contentParts.length > 0) out.push({ role: "user", content: contentParts });
  return out;
}

/**
 * `tools[]` -> Responses' FLAT function declarations (`{type:"function", name, description,
 * parameters}` — no nested `function` envelope, unlike Chat). Anthropic's built-in typed tools
 * declare no schema, so the empty object schema is used, matching `openai-request.ts`'s Chat
 * mapper exactly.
 */
function mapAnthropicToolsToResponses(tools: unknown): ResponsesRec[] | null {
  if (!Array.isArray(tools) || tools.length === 0) return null;
  const out: ResponsesRec[] = [];
  for (const raw of tools) {
    if (!isRecord(raw)) throw new RequestMappingError("tool declaration is not an object");
    if (typeof raw.name !== "string" || raw.name.length === 0) {
      throw new RequestMappingError("tool declaration without a name");
    }
    const fn: ResponsesRec = { type: "function", name: raw.name };
    if (typeof raw.description === "string" && raw.description.length > 0) fn.description = raw.description;
    fn.parameters = isRecord(raw.input_schema) ? raw.input_schema : { type: "object", properties: {} };
    out.push(fn);
  }
  return out;
}

/**
 * `tool_choice` -> the Responses spelling: `any` -> `required`, a named tool -> `{type:"function",
 * name}` (flat, unlike Chat's nested form), `disable_parallel_tool_use` -> the top-level
 * `parallel_tool_calls: false` (only when the choice can still call a tool — `none` calling no
 * tool makes the flag meaningless there, the same guard `responses-request.ts` keeps for the
 * inverse direction). An unrecognised shape is dropped rather than guessed at, same as Chat.
 */
function mapAnthropicToolChoiceToResponses(choice: unknown): { toolChoice?: unknown; parallelToolCalls?: boolean } {
  if (!isRecord(choice)) return {};
  let toolChoice: unknown;
  switch (choice.type) {
    case "auto": toolChoice = "auto"; break;
    case "any": toolChoice = "required"; break;
    case "none": toolChoice = "none"; break;
    case "tool":
      toolChoice = typeof choice.name === "string" && choice.name.length > 0
        ? { type: "function", name: choice.name }
        : undefined;
      break;
    default:
      toolChoice = undefined;
  }
  if (toolChoice === undefined) return {};
  const parallelToolCalls = choice.disable_parallel_tool_use === true && choice.type !== "none" ? false : undefined;
  return parallelToolCalls === undefined ? { toolChoice } : { toolChoice, parallelToolCalls };
}

/** The non-`input` options half of an OpenAI Responses request body — split out of the exported
 * mapper purely to keep ITS cognitive complexity under the repo's linted ceiling. */
function responsesRequestOptions(
  body: ResponsesRec,
  opts: AnthropicToOpenAiResponsesOptions,
  out: ResponsesRec,
): void {
  if (opts.model !== undefined) out.model = opts.model;
  const stream = opts.stream ?? (typeof body.stream === "boolean" ? body.stream : undefined);
  if (stream !== undefined) out.stream = stream;
  const instructions = responsesSystemText(body.system);
  if (instructions.length > 0) out.instructions = instructions;
  if (typeof body.max_tokens === "number") out.max_output_tokens = body.max_tokens;
  if (typeof body.temperature === "number") out.temperature = body.temperature;
  if (typeof body.top_p === "number") out.top_p = body.top_p;
  const tools = mapAnthropicToolsToResponses(body.tools);
  if (!tools) return;
  out.tools = tools;
  // `tool_choice` without `tools` means nothing anyway.
  const { toolChoice, parallelToolCalls } = mapAnthropicToolChoiceToResponses(body.tool_choice);
  if (toolChoice !== undefined) out.tool_choice = toolChoice;
  if (parallelToolCalls !== undefined) out.parallel_tool_calls = parallelToolCalls;
}

/**
 * Translate one Anthropic Messages request body into an OpenAI Responses request body.
 *
 * Item order is preserved exactly. Unknown top-level fields are not forwarded — a translation
 * between two contracts, not a passthrough, the same rule `anthropicRequestToOpenAi` states.
 *
 * @throws {RequestMappingError} for a block or declaration that cannot be represented.
 */
export function anthropicRequestToOpenAiResponses(
  reqJson: unknown,
  opts: AnthropicToOpenAiResponsesOptions = {},
): Record<string, unknown> {
  const body = isRecord(reqJson) ? reqJson : {};
  const input: ResponsesRec[] = [];
  const ids = opts.toolCallIds === "strict9" ? new ToolCallIds() : null;
  const sigs = opts.thoughtSignature === "sentinel" ? new ThoughtSignatures() : null;

  for (const raw of Array.isArray(body.messages) ? body.messages : []) {
    if (!isRecord(raw)) throw new RequestMappingError("message is not an object");
    if (raw.role === "assistant") input.push(...responsesAssistantItems(raw, ids, sigs));
    else input.push(...responsesUserItems(raw, ids));
  }
  if (ids !== null) opts.onToolCallIdsRewritten?.(ids.count());
  if (sigs !== null) opts.onThoughtSignatureSentinels?.(sigs.count());

  const out: ResponsesRec = { input };
  responsesRequestOptions(body, opts, out);
  return out;
}

// ---------------------------------------------------------------------------------------------
// Response direction, BUFFERED: OpenAI Responses -> Anthropic Messages.
// ---------------------------------------------------------------------------------------------

interface ParsedResponsesOutput {
  /** `message`/`refusal` output text, concatenated in order. */
  text: string;
  /** Native `function_call` output items, in order. */
  functionCalls: Array<{ id: string; name: string; input: unknown }>;
  /** `reasoning` items' `summary_text` parts, joined; empty when the response carried none. */
  reasoning: string;
}

/** One `function_call` output item -> its id/name/parsed-arguments triple. */
function parseResponsesFunctionCallOutputItem(
  raw: Record<string, unknown>,
  ordinal: number,
): { id: string; name: string; input: unknown } {
  const id = typeof raw.call_id === "string" ? raw.call_id
    : typeof raw.id === "string" ? raw.id : `tu_${ordinal}`;
  const name = typeof raw.name === "string" ? raw.name : "";
  const rawArgs = typeof raw.arguments === "string" ? raw.arguments : "";
  let input: unknown;
  try {
    input = rawArgs.length > 0 ? JSON.parse(rawArgs) : {};
  } catch {
    input = rawArgs;
  }
  return { id, name, input };
}

/** One `message` output item's `content[]` -> its `output_text`/`refusal` text parts, in order. */
function parseResponsesMessageOutputItem(raw: Record<string, unknown>): string[] {
  const textParts: string[] = [];
  if (!Array.isArray(raw.content)) return textParts;
  for (const part of raw.content) {
    if (!isRecord(part)) continue;
    if (part.type === "output_text" && typeof part.text === "string" && part.text.length > 0) {
      textParts.push(part.text);
    } else if (part.type === "refusal" && typeof part.refusal === "string" && part.refusal.length > 0) {
      textParts.push(part.refusal);
    }
  }
  return textParts;
}

/**
 * Walk a Responses `output[]` array into text + native tool calls. Any item kind this relay does
 * not model is DROPPED — the same rule the request-direction mapper applies to
 * `thinking`/`redacted_thinking`: no representation, no invented one.
 *
 * ⚠ A `reasoning` item is no longer dropped: its `summary_text` parts are collected so
 * `openAiResponsesToAnthropicMessage` can hand them to the caller as a `thinking` block, which is
 * the response-direction end of the `"deepseek"` seam (see the module note above). It is a
 * MEASUREMENT carried through, never an inference — an item with no summary text contributes an
 * empty string and the caller emits no block at all, which is the request direction's rule facing
 * the other way (`openaiResponsesRequestToAnthropic` fabricates nothing either).
 */
function parseOpenAiResponsesOutput(j: Record<string, unknown>): ParsedResponsesOutput {
  const outputs = Array.isArray(j.output) ? j.output : [];
  const textParts: string[] = [];
  const functionCalls: Array<{ id: string; name: string; input: unknown }> = [];
  const reasoningParts: string[] = [];
  for (const raw of outputs) {
    if (!isRecord(raw)) continue;
    const type = typeof raw.type === "string" ? raw.type : "";
    if (type === "function_call") {
      functionCalls.push(parseResponsesFunctionCallOutputItem(raw, functionCalls.length));
    } else if (type === "message") {
      textParts.push(...parseResponsesMessageOutputItem(raw));
    } else if (type === "reasoning") {
      reasoningParts.push(...parseResponsesReasoningSummary(raw));
    }
  }
  return { text: textParts.join(""), functionCalls, reasoning: reasoningParts.join("\n\n") };
}

/**
 * The `summary_text` parts of one Responses `reasoning` item, in order.
 *
 * ⚠ `summary` ONLY — `content` and `encrypted_content` are deliberately absent. The
 * request-direction inverse (`responses-request.ts`) reads `summary_text` for the same reason and
 * refuses the encrypted blob there; a caller's opaque ciphertext is not this relay's to re-emit as
 * readable reasoning, and DeepSeek states its reasoning as plain text on the Chat wire anyway.
 */
function parseResponsesReasoningSummary(raw: Record<string, unknown>): string[] {
  if (!Array.isArray(raw.summary)) return [];
  return raw.summary
    .filter((part): part is Record<string, unknown> => isRecord(part))
    .filter((part) => part.type === "summary_text" && typeof part.text === "string" && part.text.length > 0)
    .map((part) => part.text as string);
}

/**
 * `status`/`incomplete_details` -> the Anthropic `stop_reason`. `hasToolCalls` is the caller's to
 * decide (it may include dialect-RECOVERED calls found after this function's own native-call
 * count), so it is a parameter rather than re-derived here — the same split
 * `mapOpenAiFinishToAnthropicStopReason` keeps for the Chat direction.
 */
function mapResponsesStopReason(j: Record<string, unknown>, hasToolCalls: boolean): string {
  if (hasToolCalls) return "tool_use";
  const status = typeof j.status === "string" ? j.status : undefined;
  const incompleteReason = isRecord(j.incomplete_details) && typeof j.incomplete_details.reason === "string"
    ? j.incomplete_details.reason
    : undefined;
  if (status === "incomplete" && incompleteReason === "max_output_tokens") return "max_tokens";
  return "end_turn";
}

/**
 * A cache figure this relay is willing to repeat downstream: a finite, non-negative number. The
 * SAME check `measuredCacheTokens` performs for the Chat direction a few hundred lines below —
 * duplicated here as a one-line pure predicate rather than imported, because importing it would
 * require exporting it FROM this file and this file already imports the request/response mappers
 * of the module it would be exported to reuse it in — there is no such module here to create a
 * cycle with, but the duplication is kept deliberately trivial (one line) rather than threading a
 * new cross-file dependency for a three-token check.
 */
function measuredResponsesCacheTokens(v: unknown): number | undefined {
  return typeof v === "number" && Number.isFinite(v) && v >= 0 ? v : undefined;
}

/**
 * OpenAI Responses `usage` -> Anthropic's `usage` shape.
 *
 * ⚠ Inclusion semantics, verified from the doc rather than guessed: Responses' `input_tokens` is
 * documented (row 12 of `docs/muse-spark-1.3-opencode-zen-2026-09-04.md`) alongside
 * `input_tokens_details.cached_tokens` using the SAME `<total>_details.<subset>_tokens` naming
 * convention Chat Completions uses for `prompt_tokens`/`prompt_tokens_details.cached_tokens` — a
 * convention `src/backend.ts`'s own `openAiUsage`/`openAiPromptUsageToAnthropic` pair already
 * documents as INCLUSIVE for Chat (`prompt_tokens` INCLUDES the cached subset). Responses is the
 * same vendor's sibling API reusing the identical sub-object name, so `input_tokens` is treated as
 * inclusive here too and the cached count is split back OUT to build Anthropic's EXCLUSIVE
 * `input_tokens` + separate `cache_read_input_tokens` — the same split `openAiPromptUsageToAnthropic`
 * performs for Chat, field names renamed for the Responses wire.
 *
 * `output_tokens_details.reasoning_tokens` is the OUTPUT-side sibling of that same convention: a
 * SUBSET already counted inside `output_tokens` (exactly like a Chat `completion_tokens_details.
 * reasoning_tokens`, which this relay's Chat-direction usage mapping also does not split out —
 * neither Anthropic's wire `usage` nor `src/usage-observer.ts`'s `UsageAccumulator` has a field
 * for a reasoning-token subset today). So it needs no separate handling: it reaches the caller
 * already folded into `output_tokens`, carried through the SAME accumulator path
 * (`applyResponsesUsage`, below) that every other reported figure takes — "the observer path" the
 * Chat direction already uses, not a second one.
 */
function extractAnthropicUsageFromResponses(
  rawUsage: unknown,
): { input_tokens?: number; output_tokens?: number; cache_read_input_tokens?: number } | null {
  if (!isRecord(rawUsage)) return null;
  if (typeof rawUsage.input_tokens !== "number" && typeof rawUsage.output_tokens !== "number") return null;
  const out: { input_tokens?: number; output_tokens?: number; cache_read_input_tokens?: number } = {};
  if (typeof rawUsage.input_tokens === "number") {
    const details = isRecord(rawUsage.input_tokens_details) ? rawUsage.input_tokens_details : undefined;
    const cached = details ? measuredResponsesCacheTokens(details.cached_tokens) : undefined;
    if (cached !== undefined && cached <= rawUsage.input_tokens) {
      out.input_tokens = rawUsage.input_tokens - cached;
      out.cache_read_input_tokens = cached;
    } else {
      out.input_tokens = rawUsage.input_tokens;
    }
  }
  if (typeof rawUsage.output_tokens === "number") out.output_tokens = rawUsage.output_tokens;
  return Object.keys(out).length > 0 ? out : null;
}

/**
 * Write a parsed Responses usage object into the request's `UsageAccumulator` — the SAME field
 * semantics `usage-observer.ts`'s `inspectUsageRecord` applies for an `anthropic-messages` body
 * (`inputTokens`/`outputTokens`+`completionTokens` alias/`cacheReadInputTokens`), applied directly
 * rather than through that module's byte-level SSE/JSON parsers.
 *
 * `src/usage-observer.ts` is deliberately unmodified by this packet: its `UsageProtocol` union is
 * `"anthropic-messages" | "openai-chat"` ONLY, and its own header states why — "no call site
 * observes a native OpenAI Responses body… so there is no `"openai-responses"` member to re-add
 * if one ever appears". That was true until this section existed; rather than widen a module
 * outside this packet's scope, the BUFFERED response mapper (which has already parsed the JSON)
 * writes the accumulator directly, and the STREAMED path (`fetchOpenAiResponsesBackend`, below)
 * observes `"anthropic-messages"` on this relay's OWN translated output instead of the raw
 * Responses bytes — reusing the SAME existing machinery rather than bypassing it a second way.
 */
function applyResponsesUsage(
  accumulator: UsageAccumulator,
  usage: ReturnType<typeof extractAnthropicUsageFromResponses>,
): void {
  if (!usage) return;
  if (typeof usage.input_tokens === "number") accumulator.inputTokens = usage.input_tokens;
  if (typeof usage.output_tokens === "number") {
    accumulator.outputTokens = usage.output_tokens;
    accumulator.completionTokens = usage.output_tokens;
  }
  if (typeof usage.cache_read_input_tokens === "number") accumulator.cacheReadInputTokens = usage.cache_read_input_tokens;
}

/**
 * Map a non-streaming OpenAI Responses body into an Anthropic message — the Responses sibling of
 * `openAiResponseToAnthropic` above, including the SAME text-dialect rescue for a host that
 * returns its tool call as plain output text instead of a native `function_call` item.
 * `recoverOpenAiTextDialect` and the two error classes it throws (`DialectUnparseableError`,
 * `DialectDestructiveError`) are the EXISTING Chat-direction ones a few hundred lines below —
 * reused rather than re-declared, so a caller catching them (`fetchOpenAiResponsesBackend`) needs
 * no second set of `instanceof` checks.
 */
function openAiResponsesToAnthropicMessage(
  j: Record<string, unknown>,
  model: string,
  schemas: Map<string, { type?: unknown; properties?: Record<string, { type?: unknown }> }> | undefined,
  isDestructive: (name: string) => boolean,
  reasoning?: ReasoningMode | undefined,
): object {
  const parsed = parseOpenAiResponsesOutput(j);
  const content: object[] = [];
  let functionCalls = parsed.functionCalls;

  // FIRST, ahead of the answer text and its tool calls: Anthropic's `thinking` blocks lead the
  // turn they explain. Gated on the RESOLVED mode like every other half of this seam.
  const reasoningBlock = deepSeekThinkingBlock(parsed.reasoning, reasoning);
  if (reasoningBlock) content.push(reasoningBlock);

  if (functionCalls.length === 0 && parsed.text.length > 0) {
    const { recoveredCalls, textParts } = recoverOpenAiTextDialect(parsed.text, schemas, isDestructive);
    content.push(...textParts);
    if (recoveredCalls.length > 0) {
      functionCalls = recoveredCalls.map((c, i) => ({ id: `tu_recovered_${i}`, name: c.name, input: c.input }));
    }
  } else if (parsed.text.length > 0) {
    content.push({ type: "text", text: parsed.text });
  }

  for (const fc of functionCalls) {
    content.push({ type: "tool_use", id: fc.id, name: fc.name, input: fc.input });
  }

  return {
    id: typeof j.id === "string" ? j.id : "msg_translated",
    type: "message",
    role: "assistant",
    model: model || (typeof j.model === "string" ? j.model : ""),
    content,
    stop_reason: mapResponsesStopReason(j, functionCalls.length > 0),
    stop_sequence: null,
    ...(extractAnthropicUsageFromResponses(j.usage) ? { usage: extractAnthropicUsageFromResponses(j.usage) } : {}),
  };
}

// ---------------------------------------------------------------------------------------------
// Response direction, STREAMED: OpenAI Responses SSE -> Anthropic SSE.
//
// llm-bridge has no Responses-as-a-backend translator to reuse (its Responses support is the
// FRONT direction only — Anthropic -> Responses, `handleUniversalStreamRequest(…, "anthropic",
// "openai-responses")`, already used elsewhere in this file for the Responses FRONT). This is the
// missing mirror, hand-rolled on `src/sse-frames.ts`'s shared framing primitives per the packet
// brief ("do NOT write a fifth SSE parser").
// ---------------------------------------------------------------------------------------------

/** One Anthropic SSE frame: `event: <type>\ndata: {"type":<type>,...}\n\n`. */
function anthropicSseEvent(type: string, data: Record<string, unknown>): string {
  return `event: ${type}\ndata: ${JSON.stringify({ type, ...data })}\n\n`;
}

function anthropicSseError(message: string): string {
  return `event: error\ndata: ${JSON.stringify({ type: "error", error: { type: "api_error", message: `llm-relay: ${message}` } })}\n\n`;
}

/**
 * Incremental per-stream state: which Responses `output_index` (and, for a message item's text
 * parts, `content_index`) has already been assigned an Anthropic content-block index, so deltas
 * can be routed to the right block and `output_item.done` can close every block an item opened.
 */
interface ResponsesStreamState {
  messageStarted: boolean;
  messageStopped: boolean;
  nextBlockIndex: number;
  /** `${output_index}:${content_index}` -> Anthropic block index, for message/refusal text parts. */
  textBlocks: Map<string, number>;
  /** `output_index` -> Anthropic block index, for `function_call` items (exactly one block each). */
  toolBlocks: Map<number, number>;
  /** `output_index` -> Anthropic block indices opened for it, closed together on `output_item.done`. */
  openBlocksByItem: Map<number, number[]>;
  /**
   * `output_index` -> Anthropic block index, for a `reasoning` item's thinking block. Keyed like
   * `toolBlocks` because a Responses reasoning item has exactly one summary stream, and closed
   * through the same `openBlocksByItem` bookkeeping every other block uses.
   */
  reasoningBlocks: Map<number, number>;
  /**
   * The RESOLVED `compat.reasoning` mode, handed in from the target exactly as the request mapper
   * receives it — never sniffed from a provider identity. Only `"deepseek"` opens a thinking block
   * for a reasoning item; every other target's Anthropic stream is the pre-2026-09-15 bytes.
   */
  reasoning: ReasoningMode | undefined;
}

function newResponsesStreamState(reasoning?: ReasoningMode | undefined): ResponsesStreamState {
  return {
    messageStarted: false,
    messageStopped: false,
    nextBlockIndex: 0,
    textBlocks: new Map(),
    toolBlocks: new Map(),
    openBlocksByItem: new Map(),
    reasoningBlocks: new Map(),
    reasoning,
  };
}

function ensureResponsesMessageStarted(
  state: ResponsesStreamState,
  push: (text: string) => void,
  response: Record<string, unknown> | undefined,
): void {
  if (state.messageStarted) return;
  state.messageStarted = true;
  push(anthropicSseEvent("message_start", {
    message: {
      id: typeof response?.id === "string" ? response.id : syntheticMessageId(),
      type: "message",
      role: "assistant",
      model: typeof response?.model === "string" ? response.model : "",
      content: [],
      stop_reason: null,
      stop_sequence: null,
      // Unknown at message_start (Responses' usage arrives only once the response settles) —
      // never guessed. The full figure rides on `message_delta` instead; see `finishResponsesStream`.
      usage: {},
    },
  }));
}

function openResponsesTextBlock(
  state: ResponsesStreamState,
  push: (text: string) => void,
  outputIndex: number,
  contentIndex: number,
): number {
  const key = `${outputIndex}:${contentIndex}`;
  const existing = state.textBlocks.get(key);
  if (existing !== undefined) return existing;
  const index = state.nextBlockIndex++;
  state.textBlocks.set(key, index);
  const opened = state.openBlocksByItem.get(outputIndex) ?? [];
  opened.push(index);
  state.openBlocksByItem.set(outputIndex, opened);
  push(anthropicSseEvent("content_block_start", { index, content_block: { type: "text", text: "" } }));
  return index;
}

function openResponsesToolBlock(
  state: ResponsesStreamState,
  push: (text: string) => void,
  outputIndex: number,
  callId: string,
  name: string,
): number {
  const existing = state.toolBlocks.get(outputIndex);
  if (existing !== undefined) return existing;
  const index = state.nextBlockIndex++;
  state.toolBlocks.set(outputIndex, index);
  state.openBlocksByItem.set(outputIndex, [index]);
  push(anthropicSseEvent("content_block_start", {
    index, content_block: { type: "tool_use", id: callId, name, input: {} },
  }));
  return index;
}

/**
 * Open the Anthropic `thinking` block for a Responses `reasoning` item — the streamed sibling of
 * `openAiResponsesToAnthropicMessage`'s leading thinking block, and the reason
 * `deepSeekThinkingBlock` has a shared home rather than two copies.
 *
 * Nothing is pushed for an empty text: an item that states no summary opens no block, so a caller
 * never receives an empty `thinking` block (the request direction's "never fabricate" rule).
 */
function openResponsesThinkingBlock(
  state: ResponsesStreamState,
  push: (text: string) => void,
  outputIndex: number,
  text: string,
): number {
  if (state.reasoning !== "deepseek") return -1;
  const existing = state.reasoningBlocks.get(outputIndex);
  if (existing !== undefined) return existing;
  const index = state.nextBlockIndex++;
  state.reasoningBlocks.set(outputIndex, index);
  state.openBlocksByItem.set(outputIndex, [index]);
  push(anthropicSseEvent("content_block_start", { index, content_block: { type: "thinking", thinking: "" } }));
  if (text.length > 0) {
    push(anthropicSseEvent("content_block_delta", { index, delta: { type: "thinking_delta", thinking: text } }));
  }
  return index;
}

function closeResponsesItemBlocks(
  state: ResponsesStreamState,
  push: (text: string) => void,
  outputIndex: number,
): void {
  const opened = state.openBlocksByItem.get(outputIndex);
  if (!opened) return;
  for (const index of opened) push(anthropicSseEvent("content_block_stop", { index }));
  state.openBlocksByItem.delete(outputIndex);
}

/**
 * A `function_call` output item this translator never saw `output_item.added` for — synthesize
 * its block from the COMPLETED item's own final `call_id`/`name`/`arguments` at `response.completed`
 * time.
 */
function synthesizeResponsesFunctionCallBlock(
  state: ResponsesStreamState,
  push: (text: string) => void,
  outputIndex: number,
  item: Record<string, unknown>,
): void {
  if (state.toolBlocks.has(outputIndex)) return;
  const callId = typeof item.call_id === "string" ? item.call_id
    : typeof item.id === "string" ? item.id : `tu_${outputIndex}`;
  const index = openResponsesToolBlock(state, push, outputIndex, callId, typeof item.name === "string" ? item.name : "");
  const args = typeof item.arguments === "string" ? item.arguments : "";
  if (args.length > 0) {
    push(anthropicSseEvent("content_block_delta", { index, delta: { type: "input_json_delta", partial_json: args } }));
  }
}

/**
 * A `message` output item's text/refusal parts this translator never saw `content_part.added`
 * for — synthesized the same way as `synthesizeResponsesFunctionCallBlock`, one block per part.
 */
function synthesizeResponsesMessageBlocks(
  state: ResponsesStreamState,
  push: (text: string) => void,
  outputIndex: number,
  item: Record<string, unknown>,
): void {
  if (!Array.isArray(item.content)) return;
  item.content.forEach((part, contentIndex) => {
    if (!isRecord(part) || (part.type !== "output_text" && part.type !== "refusal")) return;
    if (state.textBlocks.has(`${outputIndex}:${contentIndex}`)) return;
    const text = typeof part.text === "string" ? part.text : typeof part.refusal === "string" ? part.refusal : "";
    const index = openResponsesTextBlock(state, push, outputIndex, contentIndex);
    if (text.length > 0) {
      push(anthropicSseEvent("content_block_delta", { index, delta: { type: "text_delta", text } }));
    }
  });
}

/**
 * A provider may answer `response.completed` with output the incremental events never announced
 * (a short response that skips streaming altogether, or an event this translator dropped) —
 * `state` alone would then describe an EMPTY message even though `response.output[]` carries the
 * whole answer. Walk it once more here and synthesize whatever block the incremental path missed,
 * keyed by each item's array position (which is what a real `output_index` names). Already-tracked
 * items are left untouched, so a fully-streamed response synthesizes nothing.
 */
function synthesizeMissingResponsesBlocks(
  state: ResponsesStreamState,
  push: (text: string) => void,
  response: Record<string, unknown>,
): void {
  if (!Array.isArray(response.output)) return;
  response.output.forEach((raw, outputIndex) => {
    if (!isRecord(raw)) return;
    if (raw.type === "function_call") synthesizeResponsesFunctionCallBlock(state, push, outputIndex, raw);
    else if (raw.type === "message") synthesizeResponsesMessageBlocks(state, push, outputIndex, raw);
    else if (raw.type === "reasoning") synthesizeResponsesReasoningBlock(state, push, outputIndex, raw);
    // Any other item kind: dropped, same rule as everywhere else in this module.
  });
}

/**
 * A `reasoning` output item whose summary the incremental events never announced — synthesized the
 * same way `synthesizeResponsesMessageBlocks` is, from the item's own `summary_text` parts.
 * Already-opened blocks are left untouched, so a fully-streamed reasoning item synthesizes nothing.
 */
function synthesizeResponsesReasoningBlock(
  state: ResponsesStreamState,
  push: (text: string) => void,
  outputIndex: number,
  item: Record<string, unknown>,
): void {
  if (state.reasoning !== "deepseek" || state.reasoningBlocks.has(outputIndex)) return;
  const parts = Array.isArray(item.summary)
    ? item.summary
      .filter((part): part is Record<string, unknown> => isRecord(part))
      .filter((part) => part.type === "summary_text" && typeof part.text === "string" && part.text.length > 0)
      .map((part) => part.text as string)
    : [];
  if (parts.length === 0) return;
  openResponsesThinkingBlock(state, push, outputIndex, parts.join("\n\n"));
}

function finishResponsesStream(
  state: ResponsesStreamState,
  push: (text: string) => void,
  response: Record<string, unknown> | undefined,
): void {
  if (state.messageStopped) return;
  state.messageStopped = true;
  ensureResponsesMessageStarted(state, push, response);
  if (response) synthesizeMissingResponsesBlocks(state, push, response);
  // Close anything still open — an abrupt/incomplete stream must not leave a dangling block.
  for (const outputIndex of [...state.openBlocksByItem.keys()]) closeResponsesItemBlocks(state, push, outputIndex);
  const hasToolCalls = state.toolBlocks.size > 0;
  const stopReason = response ? mapResponsesStopReason(response, hasToolCalls) : (hasToolCalls ? "tool_use" : "end_turn");
  const usage = response ? extractAnthropicUsageFromResponses(response.usage) : null;
  push(anthropicSseEvent("message_delta", {
    delta: { stop_reason: stopReason, stop_sequence: null },
    ...(usage ? { usage } : {}),
  }));
  push(anthropicSseEvent("message_stop", {}));
}

function handleResponsesOutputItemAdded(state: ResponsesStreamState, push: (text: string) => void, data: Record<string, unknown>): void {
  ensureResponsesMessageStarted(state, push, undefined);
  const item = isRecord(data.item) ? data.item : undefined;
  const outputIndex = typeof data.output_index === "number" ? data.output_index : -1;
  if (item?.type === "function_call" && outputIndex >= 0) {
    const callId = typeof item.call_id === "string" ? item.call_id
      : typeof item.id === "string" ? item.id : `tu_${outputIndex}`;
    openResponsesToolBlock(state, push, outputIndex, callId, typeof item.name === "string" ? item.name : "");
  }
  // "message" waits for `content_part.added` to learn output_text vs. refusal; "reasoning" is
  // dropped entirely — no block is ever opened for it.
}

function handleResponsesContentPartAdded(state: ResponsesStreamState, push: (text: string) => void, data: Record<string, unknown>): void {
  const outputIndex = typeof data.output_index === "number" ? data.output_index : -1;
  const contentIndex = typeof data.content_index === "number" ? data.content_index : 0;
  const part = isRecord(data.part) ? data.part : undefined;
  if (outputIndex >= 0 && (part?.type === "output_text" || part?.type === "refusal")) {
    ensureResponsesMessageStarted(state, push, undefined);
    openResponsesTextBlock(state, push, outputIndex, contentIndex);
  }
}

function handleResponsesTextDelta(state: ResponsesStreamState, push: (text: string) => void, data: Record<string, unknown>): void {
  const outputIndex = typeof data.output_index === "number" ? data.output_index : -1;
  const contentIndex = typeof data.content_index === "number" ? data.content_index : 0;
  const delta = typeof data.delta === "string" ? data.delta : "";
  const index = state.textBlocks.get(`${outputIndex}:${contentIndex}`);
  if (index !== undefined && delta.length > 0) {
    push(anthropicSseEvent("content_block_delta", { index, delta: { type: "text_delta", text: delta } }));
  }
}

function handleResponsesToolArgumentsDelta(state: ResponsesStreamState, push: (text: string) => void, data: Record<string, unknown>): void {
  const outputIndex = typeof data.output_index === "number" ? data.output_index : -1;
  const delta = typeof data.delta === "string" ? data.delta : "";
  const index = state.toolBlocks.get(outputIndex);
  if (index !== undefined && delta.length > 0) {
    push(anthropicSseEvent("content_block_delta", { index, delta: { type: "input_json_delta", partial_json: delta } }));
  }
}

/**
 * `response.reasoning_summary_text.delta` — the incremental form of a reasoning item's summary.
 *
 * A `reasoning` item is dropped by llm-bridge and by the relay's own Responses translator alike, so
 * this handler is the streamed half of the DeepSeek seam. It routes through the SAME
 * `openResponsesThinkingBlock` the completion-time synthesis uses, so a provider that streams its
 * summary and one that only states it at `response.completed` produce one identical block.
 */
function handleResponsesReasoningDelta(state: ResponsesStreamState, push: (text: string) => void, data: Record<string, unknown>): void {
  const outputIndex = typeof data.output_index === "number" ? data.output_index : -1;
  const delta = typeof data.delta === "string" ? data.delta : "";
  if (outputIndex < 0 || delta.length === 0) return;
  // Checked BEFORE `ensureResponsesMessageStarted`: for every target but a `"deepseek"` one this
  // event must leave zero bytes behind — not even an early `message_start` — so the stream stays
  // the pre-2026-09-15 document.
  if (state.reasoning !== "deepseek") return;
  ensureResponsesMessageStarted(state, push, undefined);
  const index = openResponsesThinkingBlock(state, push, outputIndex, "");
  if (index < 0) return;
  push(anthropicSseEvent("content_block_delta", { index, delta: { type: "thinking_delta", thinking: delta } }));
}

function handleResponsesOutputItemDone(state: ResponsesStreamState, push: (text: string) => void, data: Record<string, unknown>): void {
  const outputIndex = typeof data.output_index === "number" ? data.output_index : -1;
  if (outputIndex >= 0) closeResponsesItemBlocks(state, push, outputIndex);
}

/**
 * A post-commit in-band failure — a pre-commit one already failed `stream-commit.ts`'s probe and
 * never reaches here. Forwarded as an Anthropic error event, same as `dialect-stream.ts` does for
 * its own mid-stream refusals; honesty beats replay once the client holds bytes.
 */
function handleResponsesFailure(state: ResponsesStreamState, push: (text: string) => void, type: string, data: Record<string, unknown>): void {
  const response = isRecord(data.response) ? data.response : undefined;
  ensureResponsesMessageStarted(state, push, response);
  const message = isRecord(response?.error) && typeof response.error.message === "string"
    ? response.error.message
    : typeof data.message === "string" ? data.message
      : isRecord(data.error) && typeof data.error.message === "string" ? data.error.message
        : `stream ended: ${type}`;
  push(anthropicSseError(message));
  state.messageStopped = true; // an error event terminates the stream; no message_stop follows
}

/**
 * Every Responses event name this translator acts on, mapped to its handler — a total-in-spirit
 * lookup rather than a long if/else chain, so `processResponsesStreamEvent`'s own cognitive
 * complexity stays a flat dispatch. Any event NOT in this map (a reasoning delta/done,
 * `output_text.done`, `content_part.done`, `function_call_arguments.done`, a future event type,
 * …) is DROPPED, not an error — a redundant boundary already covered by `output_item.done`, or
 * content this relay drops by rule (the doc's row 13, plus `function_call_arguments.delta/done`
 * from §3 route B, is the authority for what is handled at all).
 */
const RESPONSES_STREAM_HANDLERS: Record<string, (state: ResponsesStreamState, push: (text: string) => void, data: Record<string, unknown>) => void> = {
  "response.created": (state, push, data) => ensureResponsesMessageStarted(state, push, isRecord(data.response) ? data.response : undefined),
  "response.in_progress": (state, push, data) => ensureResponsesMessageStarted(state, push, isRecord(data.response) ? data.response : undefined),
  "response.output_item.added": handleResponsesOutputItemAdded,
  "response.content_part.added": handleResponsesContentPartAdded,
  "response.output_text.delta": handleResponsesTextDelta,
  "response.refusal.delta": handleResponsesTextDelta,
  "response.function_call_arguments.delta": handleResponsesToolArgumentsDelta,
  "response.reasoning_summary_text.delta": handleResponsesReasoningDelta,
  "response.output_item.done": handleResponsesOutputItemDone,
  "response.completed": (state, push, data) => finishResponsesStream(state, push, isRecord(data.response) ? data.response : undefined),
  "response.incomplete": (state, push, data) => finishResponsesStream(state, push, isRecord(data.response) ? data.response : undefined),
  "response.failed": (state, push, data) => handleResponsesFailure(state, push, "response.failed", data),
  "response.cancelled": (state, push, data) => handleResponsesFailure(state, push, "response.cancelled", data),
  error: (state, push, data) => handleResponsesFailure(state, push, "error", data),
  ping: (_state, push) => push(`event: ping\ndata: {"type":"ping"}\n\n`),
};

/** Handle one parsed Responses SSE event, pushing zero or more Anthropic SSE frames. */
function processResponsesStreamEvent(
  state: ResponsesStreamState,
  push: (text: string) => void,
  type: string,
  data: Record<string, unknown>,
): void {
  RESPONSES_STREAM_HANDLERS[type]?.(state, push, data);
}

/**
 * Translate an upstream OpenAI Responses SSE byte stream into Anthropic SSE.
 *
 * Reuses `src/sse-frames.ts`'s `createSseTransformStream` scaffold (the read loop, decoder/
 * encoder, error tail and lifecycle) rather than writing a fifth SSE parser — only the frame
 * policy below is this translator's own, the same division `stripThinkTagsInStream` and
 * `rewriteToolUseIdsInStream` already keep.
 */
function translateResponsesStreamToAnthropic(
  upstream: ReadableStream<Uint8Array>,
  reasoning?: ReasoningMode | undefined,
): ReadableStream<Uint8Array> {
  return createSseTransformStream(upstream, ({ push, frames }) => {
    const state = newResponsesStreamState(reasoning);
    return {
      flushHeld: () => finishResponsesStream(state, push, undefined),
      processFrames: () => {
        for (const { frame } of frames) {
          const ev = parseSseEvent(frame);
          if (!ev || !ev.data) continue;
          const type = typeof ev.data.type === "string" ? ev.data.type : ev.type;
          processResponsesStreamEvent(state, push, type, ev.data);
        }
      },
    };
  });
}

// ---------------------------------------------------------------------------------------------
// Wiring: the Responses-wire upstream speaker `fetchOpenAiBackend` dispatches to.
// ---------------------------------------------------------------------------------------------

/**
 * Map the Responses-wire request, POST it, and translate a non-ok status into the same
 * `openai backend HTTP <n>…` error shape the Chat path returns — split out of
 * `fetchOpenAiResponsesBackend` purely for that function's cognitive complexity.
 */
async function postResponsesRequest(
  attempt: ResolvedAttempt,
  args: FetchBackendArgs,
  reqJson: unknown,
  invokeFetch: typeof fetch,
): Promise<{ ok: true; res: Response; toolCallIdsRewritten: number; sentinelsStamped: number } | { ok: false; response: Response }> {
  const target = attempt.target;
  let responsesBody: Record<string, unknown>;
  let toolCallIdsRewritten = 0;
  let sentinelsStamped = 0;
  try {
    responsesBody = anthropicRequestToOpenAiResponses(reqJson, {
      model: target.model,
      stream: args.wantsStream,
      ...(target.toolCallIds !== undefined ? { toolCallIds: target.toolCallIds } : {}),
      onToolCallIdsRewritten: (n) => { toolCallIdsRewritten = n; },
      ...(target.thoughtSignature !== undefined ? { thoughtSignature: target.thoughtSignature } : {}),
      onThoughtSignatureSentinels: (n) => { sentinelsStamped = n; },
    });
  } catch (e) {
    if (e instanceof RequestMappingError) {
      return { ok: false, response: anthropicError(400, `llm-relay: ${e.message}`, "local") };
    }
    return { ok: false, response: anthropicError(502, `request translation failed: ${(e as Error).message}`, "local") };
  }

  const res = await invokeFetch(target.base + "/responses", {
    method: "POST",
    headers: buildTargetHeaders(attempt),
    body: JSON.stringify(responsesBody),
    signal: args.signal,
  });

  if (!res.ok) {
    let body: string;
    try {
      body = await res.text();
    } catch (cause) {
      return { ok: false, response: attachPostHeaderBodyFailure(res, cause) };
    }
    const hint =
      res.status === 404
        ? ` — model "${target.model}" is not served by provider "${target.provider}" (a model can be listed in /models and still 404 here)`
        : "";
    return {
      ok: false,
      response: anthropicError(res.status, `openai backend HTTP ${res.status}${hint}: ${body.slice(0, 300)}`, "upstream", {
        ...retryAfterHeader(res.headers),
      }),
    };
  }
  return { ok: true, res, toolCallIdsRewritten, sentinelsStamped };
}

/**
 * The streamed half of `fetchOpenAiResponsesBackend` — mirrors the Chat path's own streamed
 * branch exactly: preflight, translate, strip think tags, dialect-rescue, mint tool-use ids,
 * announce. The ONLY difference from Chat is the first two steps (`"openai-responses"` preflight
 * protocol and `translateResponsesStreamToAnthropic` instead of llm-bridge's
 * `handleUniversalStreamRequest(…, "openai", "anthropic")`) and the usage tee, which observes
 * THIS relay's own translated Anthropic-shaped output rather than the raw Responses bytes (see
 * `applyResponsesUsage`'s header comment for why).
 */
async function fetchResponsesStreamed(
  args: FetchBackendArgs,
  target: ResolvedAttempt["target"],
  res: Response,
  toolCallIdsRewritten: number,
  sentinelsStamped: number,
): Promise<Response> {
  if (!res.body) {
    return anthropicError(502, "llm-relay: invalid OpenAI upstream envelope: empty stream", "upstream", {
      ...retryAfterHeader(res.headers),
    }, "invalid_upstream_envelope");
  }
  const preflight = await preflightResponseStream(res.body, "openai-responses");
  if (!preflight.ok) {
    return anthropicError(502, `llm-relay: invalid OpenAI upstream envelope: ${preflight.reason}`, "upstream", {
      ...retryAfterHeader(res.headers),
    }, "invalid_upstream_envelope");
  }
  try {
    const anthStream = translateResponsesStreamToAnthropic(preflight.body, target.reasoning);
    // Tee usage off THIS relay's own translated Anthropic-shaped bytes (protocol
    // "anthropic-messages", which `usage-observer.ts` already fully supports) rather than the raw
    // Responses bytes (no `"openai-responses"` `UsageProtocol` member exists, deliberately, per
    // that module's own header — out of this packet's Scope to widen).
    const observedStream = args.usage
      ? observeUsage(new Response(anthStream), "anthropic-messages", args.usage, { streamed: true }).body ?? anthStream
      : anthStream;
    const strippedStream = stripThinkTagsInStream(observedStream);
    const schemas = toolSchemaMap(args.reqJson) as Map<string, { type?: unknown; properties?: Record<string, { type?: unknown }> }>;
    const refusalSignal = dialectRefusalSignal();
    const recovered = schemas.size > 0
      ? recoverDialectInStream(strippedStream, schemas, args.isDestructive, refusalSignal)
      : strippedStream;
    const metadata = preflight.metadata;
    if (toolCallIdsRewritten > 0) metadata.toolCallIdRewrites = toolCallIdsRewritten;
    if (sentinelsStamped > 0) metadata.thoughtSignatureSentinels = sentinelsStamped;
    const body = rewriteToolUseIdsInStream(
      recovered,
      () => knownToolUseIds(args.reqJson),
      (count) => { metadata.toolUseIdRewrites = count; },
    );
    const streamResponse = attachUpstreamMetadata(
      new Response(body, {
        status: res.status,
        headers: {
          "content-type": "text/event-stream",
          ...(toolCallIdsRewritten > 0 ? { [TOOL_CALL_IDS_HEADER]: `${toolCallIdsRewritten} rewritten` } : {}),
        },
      }),
      metadata,
    );
    dialectRefusalSignals.set(streamResponse, refusalSignal);
    return streamResponse;
  } catch (e) {
    return anthropicError(502, `llm-relay: response translation failed: ${(e as Error).message}`, "local", {}, "relay_mapper_defect");
  }
}

/**
 * The buffered half of `fetchOpenAiResponsesBackend` — mirrors the Chat path's own buffered
 * branch: parse, validate the envelope, map to Anthropic (with dialect rescue), mint tool-use
 * ids, announce, and populate `args.usage` directly (see `applyResponsesUsage`).
 */
/** `openAiResponsesToAnthropicMessage`, with its three thrown outcomes mapped to a Response. */
function mapResponsesJsonToAnthropicOrError(
  upstreamJson: Record<string, unknown>,
  target: ResolvedAttempt["target"],
  args: FetchBackendArgs,
): { ok: true; message: object } | { ok: false; response: Response } {
  try {
    const schemas = toolSchemaMap(args.reqJson) as Map<string, { type?: unknown; properties?: Record<string, { type?: unknown }> }>;
    const message = openAiResponsesToAnthropicMessage(upstreamJson, target.model ?? "", schemas, args.isDestructive, target.reasoning);
    return { ok: true, message };
  } catch (e) {
    if (e instanceof DialectUnparseableError) {
      return { ok: false, response: anthropicError(502, `llm-relay: ${e.message}`, "upstream", {}, "tool_dialect_unparseable") };
    }
    if (e instanceof DialectDestructiveError) {
      return {
        ok: false,
        response: anthropicError(
          502,
          `llm-relay: ${e.message}`,
          "local",
          { [TOOL_DIALECT_HEADER]: "refused-destructive" },
          DIALECT_REFUSED_DESTRUCTIVE_CODE,
        ),
      };
    }
    return { ok: false, response: anthropicError(502, `llm-relay: response translation failed: ${(e as Error).message}`, "local", {}, "relay_mapper_defect") };
  }
}

async function fetchResponsesBuffered(
  args: FetchBackendArgs,
  target: ResolvedAttempt["target"],
  res: Response,
  toolCallIdsRewritten: number,
  sentinelsStamped: number,
): Promise<Response> {
  let upstreamJson: unknown;
  try {
    upstreamJson = await res.json();
  } catch (cause) {
    if (!(cause instanceof SyntaxError)) return attachPostHeaderBodyFailure(res, cause);
    return anthropicError(502, "llm-relay: invalid OpenAI upstream envelope: body is not valid JSON", "upstream", {
      ...retryAfterHeader(res.headers),
    }, "invalid_upstream_envelope");
  }
  const invalidReason = invalidEnvelopeReason(upstreamJson, "openai-responses", false);
  if (invalidReason) {
    return anthropicError(502, `llm-relay: invalid OpenAI upstream envelope: ${invalidReason}`, "upstream", {
      ...retryAfterHeader(res.headers),
    }, "invalid_upstream_envelope");
  }

  const mapped = mapResponsesJsonToAnthropicOrError(upstreamJson as Record<string, unknown>, target, args);
  if (!mapped.ok) return mapped.response;
  let anthropicJson: object = mapped.message;
  const mintedIds = mintUniqueToolUseIds(anthropicJson, args.reqJson);
  if (mintedIds.message) anthropicJson = mintedIds.message;
  const recoveredDialect = recoveredDialectOf(anthropicJson);
  if (args.usage) {
    applyResponsesUsage(args.usage, extractAnthropicUsageFromResponses((upstreamJson as Record<string, unknown>).usage));
  }
  const response = new Response(JSON.stringify(anthropicJson), {
    status: 200,
    headers: {
      "content-type": "application/json",
      ...(recoveredDialect ? { [TOOL_DIALECT_HEADER]: recoveredDialect } : {}),
      ...(mintedIds.rewritten > 0 ? { [TOOL_USE_IDS_HEADER]: `${mintedIds.rewritten} rewritten` } : {}),
      ...(toolCallIdsRewritten > 0 ? { [TOOL_CALL_IDS_HEADER]: `${toolCallIdsRewritten} rewritten` } : {}),
    },
  });
  const metadata: UpstreamResponseMetadata = {};
  captureReportedModel(metadata, upstreamJson, "openai-responses", false);
  if (mintedIds.rewritten > 0) metadata.toolUseIdRewrites = mintedIds.rewritten;
  if (toolCallIdsRewritten > 0) metadata.toolCallIdRewrites = toolCallIdsRewritten;
  if (sentinelsStamped > 0) metadata.thoughtSignatureSentinels = sentinelsStamped;
  return attachUpstreamMetadata(response, metadata);
}

/**
 * The `wire: "responses"` upstream speaker `fetchOpenAiBackend` dispatches to. Documents are
 * transcoded exactly as the Chat path does (a `document` block has no Responses representation
 * either); everything else forks into `postResponsesRequest` + `fetchResponsesStreamed` /
 * `fetchResponsesBuffered`, above.
 */
async function fetchOpenAiResponsesBackend(
  attempt: ResolvedAttempt,
  args: FetchBackendArgs,
  invokeFetch: typeof fetch,
): Promise<Response> {
  let reqJson = args.reqJson;
  try {
    reqJson = await transcodeDocuments(reqJson);
  } catch (e) {
    if (e instanceof DocumentError) return anthropicError(400, `llm-relay: ${e.message}`, "local");
    return anthropicError(502, `document conversion failed: ${(e as Error).message}`, "local");
  }

  const posted = await postResponsesRequest(attempt, args, reqJson, invokeFetch);
  if (!posted.ok) return posted.response;

  if (args.wantsStream) {
    return fetchResponsesStreamed(args, attempt.target, posted.res, posted.toolCallIdsRewritten, posted.sentinelsStamped);
  }
  return fetchResponsesBuffered(args, attempt.target, posted.res, posted.toolCallIdsRewritten, posted.sentinelsStamped);
}

/**
 * Perform one upstream inference call against the resolved attempt.
 *
 * For an `anthropic`-kind target this forwards native Messages request bytes and parses native
 * Messages response bytes. For an `openai`-kind target it transcodes documents, maps the request to
 * Chat Completions (`openai-request.ts`), parses the completion and translates it back to Anthropic
 * Messages (`openAiResponseToAnthropic`). In both directions the rest of the proxy (validate/repair)
 * always sees Anthropic Messages.
 */
export async function fetchBackend(
  attempt: ResolvedAttempt,
  args: FetchBackendArgs,
  fetchFn: typeof fetch = fetch,
): Promise<Response> {
  const invokeFetch = oneShotFetch(fetchFn, args.signal, args.onEgress);
  if (attempt.target.kind === "anthropic") {
    return fetchAnthropicBackend(attempt, args, invokeFetch);
  }
  return fetchOpenAiBackend(attempt, args, invokeFetch);
}

/**
 * Give a translated message's `tool_use` blocks ids the conversation has not already used.
 *
 * Lazy on purpose: a response with no `tool_use` block never walks the request's messages, so the
 * ordinary text completion — the overwhelming majority of traffic — pays one array scan. `message`
 * is null when nothing changed, so an untouched response is never re-built.
 */
function mintUniqueToolUseIds(
  message: object,
  reqJson: unknown,
): { message: object | null; rewritten: number } {
  const content = (message as { content?: unknown }).content;
  if (!Array.isArray(content) || !content.some((b) => isRecord(b) && b.type === "tool_use")) {
    return { message: null, rewritten: 0 };
  }
  const out = rewriteToolUseIds(content, knownToolUseIds(reqJson));
  if (out.rewritten === 0) return { message: null, rewritten: 0 };
  return { message: { ...message, content: out.content }, rewritten: out.rewritten };
}

/** Did this translated message carry a tool call the relay reconstructed from text? */
function recoveredDialectOf(message: object): string | null {
  const content = (message as { content?: Array<Record<string, unknown>> }).content ?? [];
  return content.some((b) => b.type === "tool_use" && typeof b.id === "string" && b.id.startsWith("tu_recovered_"))
    ? "recovered"
    : null;
}

interface OpenAiTextDialectResult {
  recoveredCalls: DialectToolCall[];
  textParts: object[];
}

function recoverOpenAiTextDialect(
  messageText: string,
  schemas: Map<string, { type?: unknown; properties?: Record<string, { type?: unknown }> }> | undefined,
  isDestructive: (name: string) => boolean,
): OpenAiTextDialectResult {
  const out = recoverToolCalls(messageText, schemas ?? new Map(), isDestructive);
  if (out.status === "parsed") {
    const textParts: object[] = [];
    if (out.text.length > 0) textParts.push({ type: "text", text: out.text });
    return { recoveredCalls: out.calls, textParts };
  }
  if (out.status === "refused-destructive") {
    throw new DialectDestructiveError(out.dialect, out.refused);
  }
  if (out.status === "detected") {
    throw new DialectUnparseableError(out.dialect);
  }
  return { recoveredCalls: [], textParts: [{ type: "text", text: messageText }] };
}

function convertOpenAiToolCallsToAnthropic(
  toolCalls: Array<Record<string, unknown>>,
): Array<{ type: "tool_use"; id: string; name: string; input: unknown }> {
  const result: Array<{ type: "tool_use"; id: string; name: string; input: unknown }> = [];
  for (const tc of toolCalls) {
    const fn = (tc.function as Record<string, unknown> | undefined) ?? {};
    let input: unknown;
    try {
      input = JSON.parse((fn.arguments as string) ?? "{}");
    } catch {
      input = fn.arguments ?? {};
    }
    result.push({
      type: "tool_use",
      id: (tc.id as string) ?? "tu",
      name: (fn.name as string) ?? "",
      input,
    });
  }
  return result;
}

function mapOpenAiFinishToAnthropicStopReason(finish: string | undefined, hasToolCalls: boolean): string {
  if (hasToolCalls) return "tool_use";
  if (finish === "length") return "max_tokens";
  if (finish === "stop") return "end_turn";
  return finish ?? "end_turn";
}

function extractAnthropicUsageFromOpenAi(rawUsage: unknown): Record<string, unknown> | null {
  if (!isRecord(rawUsage)) return null;
  if (typeof rawUsage.prompt_tokens !== "number" && typeof rawUsage.completion_tokens !== "number") return null;
  return {
    ...openAiPromptUsageToAnthropic(rawUsage),
    ...(typeof rawUsage.completion_tokens === "number" ? { output_tokens: rawUsage.completion_tokens } : {}),
  };
}

/**
 * Map a non-streaming OpenAI chat completion into an Anthropic message.
 *
 * `schemas` enables recovery of a tool call the HOST failed to parse: some free hosts return the
 * model's native tool-call dialect as assistant TEXT instead of populating `tool_calls`, which
 * without this reaches the client as markup it treats as a final answer (see
 * docs/tool-call-dialect-leak.md). Omitting it keeps the pure translation behaviour.
 */
export function openAiResponseToAnthropic(
  j: Record<string, unknown>,
  model: string,
  schemas: Map<string, { type?: unknown; properties?: Record<string, { type?: unknown }> }> | undefined,
  isDestructive: (name: string) => boolean,
  reasoning?: ReasoningMode | undefined,
): object {
  const choice = (j.choices as Array<Record<string, unknown>> | undefined)?.[0] ?? {};
  const msg = (choice.message as Record<string, unknown> | undefined) ?? {};
  const content: object[] = [];
  let toolCalls = (msg.tool_calls as Array<Record<string, unknown>> | undefined) ?? [];
  // This mapper is the translated OpenAI→Anthropic seam. Strip first so an opening think block
  // cannot conceal a following dialect envelope from the recovery pass below.
  const messageText = typeof msg.content === "string" ? stripOpeningThinkTag(msg.content) : null;

  // FIRST, ahead of the answer text and any `tool_use`: Anthropic's `thinking` blocks lead the
  // assistant turn they explain, and the request-direction inverse (`openai-request.ts`
  // `assistantMessage`) reads them back from wherever they appear. Dropped unchanged for every
  // target but a `"deepseek"` one — see `deepSeekThinkingBlock`.
  const reasoningBlock = deepSeekThinkingBlock(msg.reasoning_content, reasoning);
  if (reasoningBlock) content.push(reasoningBlock);

  // Recover ONLY when the host parsed nothing. A host that populated `tool_calls` has already
  // spoken; second-guessing it here would be inference, not translation.
  if (toolCalls.length === 0 && messageText !== null && messageText.length > 0) {
    const { recoveredCalls, textParts } = recoverOpenAiTextDialect(messageText, schemas, isDestructive);
    content.push(...textParts);
    if (recoveredCalls.length > 0) {
      toolCalls = recoveredCalls.map((c, i) => ({
        id: `tu_recovered_${i}`,
        function: { name: c.name, arguments: JSON.stringify(c.input) },
      }));
    }
  } else if (messageText !== null && messageText.length > 0) {
    content.push({ type: "text", text: messageText });
  }

  content.push(...convertOpenAiToolCallsToAnthropic(toolCalls));
  const stopReason = mapOpenAiFinishToAnthropicStopReason(choice.finish_reason as string | undefined, toolCalls.length > 0);
  const usage = extractAnthropicUsageFromOpenAi(j.usage);

  return {
    id: (j.id as string) ?? "msg_translated",
    type: "message",
    role: "assistant",
    model: model || ((j.model as string) ?? ""),
    content,
    stop_reason: stopReason,
    stop_sequence: null,
    ...(usage ? { usage } : {}),
  };
}

/** The upstream's `Retry-After`, as a header object to spread, or `{}` when it sent none. */
function retryAfterHeader(hh: Headers): Record<string, string> {
  const v = hh.get("retry-after");
  return v ? { "retry-after": v } : {};
}

function anthropicError(
  status: number,
  message: string,
  origin: ErrorOrigin,
  extra: Record<string, string> = {},
  type = "api_error",
): Response {
  return new Response(JSON.stringify({ type: "error", error: { type, message } }), {
    status,
    headers: { "content-type": "application/json", [ERROR_ORIGIN_HEADER]: origin, ...extra },
  });
}

function openaiError(
  status: number,
  message: string,
  origin: ErrorOrigin,
  type = "invalid_request_error",
  extra: Record<string, string> = {},
): Response {
  return new Response(JSON.stringify({ error: { message, type } }), {
    status,
    headers: { "content-type": "application/json", [ERROR_ORIGIN_HEADER]: origin, ...extra },
  });
}

export type OpenAiFrontProtocol = "chat" | "responses";

/**
 * Remove the usage-only Chat SSE event we requested on the caller's behalf.  This sits after
 * the observer: accounting sees the native bytes immediately, while the client sees its
 * original stream contract.  It deliberately matches only an empty-choices event with usage.
 */
function suppressRelayAddedOpenAiUsageFrames(body: ReadableStream<Uint8Array>): ReadableStream<Uint8Array> {
  let pending: Uint8Array<ArrayBufferLike> = new Uint8Array(0);
  const append = (left: Uint8Array<ArrayBufferLike>, right: Uint8Array<ArrayBufferLike>): Uint8Array<ArrayBufferLike> => {
    const out = new Uint8Array(left.byteLength + right.byteLength);
    out.set(left);
    out.set(right, left.byteLength);
    return out;
  };
  const frameEnd = (bytes: Uint8Array): number | null => {
    for (let i = 0; i + 1 < bytes.byteLength; i += 1) {
      if (bytes[i] === 10 && bytes[i + 1] === 10) return i + 2;
      if (i + 3 < bytes.byteLength && bytes[i] === 13 && bytes[i + 1] === 10 && bytes[i + 2] === 13 && bytes[i + 3] === 10) return i + 4;
    }
    return null;
  };
  const isUsageOnly = (frame: Uint8Array): boolean => {
    let event: string;
    try {
      // Fatal decoding means opaque/noncanonical bytes pass through untouched.
      event = new TextDecoder("utf-8", { fatal: true }).decode(frame);
    } catch {
      return false;
    }
    const data = event
      .split(/\r?\n/)
      .filter((line) => line.startsWith("data:"))
      .map((line) => line.slice(5).trimStart())
      .join("\n")
      .trim();
    if (!data || data === "[DONE]") return false;
    try {
      const parsed = JSON.parse(data) as unknown;
      return isRecord(parsed) && Array.isArray(parsed.choices) && parsed.choices.length === 0 && isRecord(parsed.usage);
    } catch {
      return false;
    }
  };
  const drain = (controller: TransformStreamDefaultController<Uint8Array>, final = false): void => {
    while (true) {
      const end = frameEnd(pending);
      if (end === null) break;
      const frame = pending.slice(0, end);
      pending = pending.slice(end);
      if (!isUsageOnly(frame)) controller.enqueue(frame);
    }
    // Do not let a malformed provider frame become unbounded buffering. Retained bytes are
    // always original slices, never decoder/re-encoder output.
    if ((final || pending.byteLength > 16 * 1024) && pending.byteLength > 0) {
      controller.enqueue(pending);
      pending = new Uint8Array(0);
    }
  };
  return body.pipeThrough(new TransformStream<Uint8Array, Uint8Array>({
    transform(chunk, controller) {
      pending = append(pending, chunk);
      drain(controller);
    },
    flush(controller) {
      drain(controller, true);
    },
  }));
}

function nativeResponseIsStreamed(response: Response, wantsStream: boolean): boolean {
  const type = response.headers.get("content-type")?.toLowerCase() ?? "";
  if (type.includes("text/event-stream")) return true;
  if (type.includes("application/json") || /\+json(?:;|$)/.test(type)) return false;
  return wantsStream;
}

interface ExtractedAnthropicBlocks {
  text: string;
  toolCalls: Array<Record<string, unknown>>;
  /**
   * Every `thinking` block's own text, joined — the response-direction sibling of
   * `openai-request.ts` `assistantMessage`'s `thinkingParts`, read by `formatOpenAiResponses` to
   * rebuild a `reasoning` item for a Responses caller (see the DeepSeek response seam note above).
   * A `redacted_thinking` block contributes nothing: its `data` is Anthropic's own encrypted blob,
   * meaningless to another vendor, exactly as the request direction states.
   */
  thinking: string;
}

function extractAnthropicMessageBlocks(content: unknown): ExtractedAnthropicBlocks {
  const contentArray = Array.isArray(content) ? content : [];
  const textParts: string[] = [];
  const toolCalls: Array<Record<string, unknown>> = [];
  const thinkingParts: string[] = [];

  for (const raw of contentArray) {
    if (!isRecord(raw)) continue;
    if (raw.type === "text" && typeof raw.text === "string") {
      textParts.push(raw.text);
    } else if (raw.type === "tool_use") {
      const input = raw.input ?? {};
      toolCalls.push({
        id: typeof raw.id === "string" ? raw.id : `tool_call_${toolCalls.length}`,
        type: "function",
        function: {
          name: typeof raw.name === "string" ? raw.name : "",
          arguments: typeof input === "string" ? input : JSON.stringify(input),
        },
      });
    } else if (raw.type === "thinking" && typeof raw.thinking === "string" && raw.thinking.length > 0) {
      thinkingParts.push(raw.thinking);
    }
  }

  return { text: textParts.join(""), toolCalls, thinking: thinkingParts.join("\n\n") };
}

function formatOpenAiChatCompletion(
  body: Record<string, unknown>,
  text: string,
  toolCalls: Array<Record<string, unknown>>,
  model: string,
  usage: ReturnType<typeof openAiUsage>,
): Record<string, unknown> {
  const message: Record<string, unknown> = {
    role: "assistant",
    content: text || null,
  };
  if (toolCalls.length > 0) message.tool_calls = toolCalls;
  const out: Record<string, unknown> = {
    id: typeof body.id === "string" ? body.id : "chatcmpl_relay",
    object: "chat.completion",
    created: Math.floor(Date.now() / 1000),
    model,
    choices: [{
      index: 0,
      message,
      finish_reason: openAiFinishReason(body.stop_reason, toolCalls.length > 0),
    }],
  };
  if (usage) out.usage = withOpenAiTotal(usage);
  return out;
}

/**
 * `stop_reason: "max_tokens"` → the OpenAI Responses spelling for a token-capped answer, the same
 * one `mapResponsesStopReason` already READS in the other direction
 * (`incompleteReason === "max_output_tokens"`). Until 2026-09-09 this builder hardcoded
 * `status: "completed"` regardless, so a cap landing mid tool-call-argument JSON reached the
 * caller labelled as a finished answer — the mechanism behind
 * docs/deepseek-responses-truncation-2026-09-09.md's Codex replay loop. Every other stop reason
 * is unchanged.
 */
function formatOpenAiResponses(
  body: Record<string, unknown>,
  text: string,
  toolCalls: Array<Record<string, unknown>>,
  model: string,
  usage: ReturnType<typeof openAiUsage>,
  thinking = "",
): Record<string, unknown> {
  const capped = body.stop_reason === "max_tokens";
  const itemStatus = capped ? "incomplete" : "completed";
  const output: Array<Record<string, unknown>> = [];
  // FIRST, ahead of the message and its function calls: a Responses `reasoning` item describes the
  // turn that follows it, and `responses-request.ts` reads it back that way (a `summary_text` part
  // becomes a LEADING `thinking` block). Dropped entirely when empty, never emitted as an empty
  // item — the same "never fabricate" rule the request direction states for a missing summary.
  if (thinking.length > 0) {
    output.push({
      type: "reasoning",
      id: `rs_${typeof body.id === "string" ? body.id : "relay"}`,
      status: itemStatus,
      summary: [{ type: "summary_text", text: thinking }],
    });
  }
  if (text) {
    output.push({
      type: "message",
      id: `msg_${typeof body.id === "string" ? body.id : "relay"}`,
      status: itemStatus,
      role: "assistant",
      content: [{ type: "output_text", text, annotations: [] }],
    });
  }
  for (const call of toolCalls) {
    const fn = call.function as Record<string, unknown>;
    output.push({
      type: "function_call",
      id: `fc_${call.id}`,
      call_id: call.id,
      name: fn.name,
      arguments: fn.arguments,
      status: itemStatus,
    });
  }
  const out: Record<string, unknown> = {
    id: typeof body.id === "string" ? body.id : "resp_relay",
    object: "response",
    created_at: Math.floor(Date.now() / 1000),
    status: capped ? "incomplete" : "completed",
    model,
    output,
    output_text: text,
  };
  if (capped) out.incomplete_details = { reason: "max_output_tokens" };
  if (usage) out.usage = withOpenAiTotal(usage);
  return out;
}

/**
 * Translate an Anthropic non-streaming message into an OpenAI response.
 *
 * `protocol` selects the outer envelope: Chat Completions (`chat.completion`) vs Responses
 * (`response`). Used by the OpenAI front (`fetchOpenAiFront`) when an `anthropic`-kind target
 * answers a Codex or OpenAI-native request: llm-bridge models only Chat Completions, and its IR
 * loses tool calls, stop reasons and usage on the way back to the caller.
 */
export function anthropicMessageToOpenAi(
  body: Record<string, unknown>,
  protocol: OpenAiFrontProtocol,
  fallbackModel = "",
  /**
   * The RESOLVED `compat.reasoning` mode of the target that answered, handed in exactly as the
   * request mapper receives it — never sniffed from a provider identity. ONLY `"deepseek"` lets a
   * `thinking` block ride the Responses envelope as a `reasoning` item (the response-direction end
   * of that seam); every other target's bytes are the pre-2026-09-15 document, thinking dropped as
   * before. Absent ⇒ `"none"` ⇒ dropped, so the existing three-argument callers are unchanged.
   */
  reasoning?: ReasoningMode | undefined,
): Record<string, unknown> {
  const { text, toolCalls, thinking } = extractAnthropicMessageBlocks(body.content);
  const model = typeof body.model === "string" && body.model ? body.model : fallbackModel;
  const usage = openAiUsage(body.usage);

  // `thinking` rides ONLY the Responses envelope. Chat Completions has no reasoning field this
  // relay may write (DeepSeek's `reasoning_content` is the vendor's own extension and a caller's
  // own body is never rewritten — see `compat`'s authored-bodies SCOPE note), so a Chat caller
  // gets exactly the pre-existing bytes.
  if (protocol === "chat") {
    return formatOpenAiChatCompletion(body, text, toolCalls, model, usage);
  }
  return formatOpenAiResponses(body, text, toolCalls, model, usage, reasoning === "deepseek" ? thinking : "");
}

/**
 * A cache figure this relay is willing to repeat downstream: a finite, non-negative number.
 * Negative or non-finite is malformed host output, not a measurement, so it is treated exactly
 * like an absent field — propagating it would shrink a prompt total or publish a negative
 * `cached_tokens`, i.e. manufacture a figure nobody stated.
 */
function measuredCacheTokens(v: unknown): number | undefined {
  return typeof v === "number" && Number.isFinite(v) && v >= 0 ? v : undefined;
}

/**
 * Anthropic→OpenAI prompt-side mapping (used when an anthropic-kind backend answers a
 * Chat/Responses front-door request).
 *
 * The two protocols disagree on what "prompt tokens" means: OpenAI's `prompt_tokens` INCLUDES
 * the cached subset; Anthropic's `input_tokens` EXCLUDES cache reads and cache writes, which
 * ride in their own fields. Mapping input_tokens straight across therefore UNDER-STATES the
 * prompt by exactly the cache traffic, so it is summed back here. `cache_read_input_tokens`
 * additionally becomes `prompt_tokens_details.cached_tokens` — the field an OpenAI client
 * reads to know how much of the prompt was served from cache — and each output field is
 * emitted only when its source was actually reported, never zero-filled.
 */
function openAiUsage(raw: unknown): { prompt_tokens?: number; completion_tokens?: number; prompt_tokens_details?: { cached_tokens?: number } } | null {
  if (typeof raw !== "object" || raw === null) return null;
  const usage = raw as Record<string, unknown>;
  const cacheRead = measuredCacheTokens(usage.cache_read_input_tokens);
  const cacheCreation = measuredCacheTokens(usage.cache_creation_input_tokens);
  const cacheSum = (cacheRead ?? 0) + (cacheCreation ?? 0);
  const input = typeof usage.input_tokens === "number" ? usage.input_tokens : undefined;
  // A usage object with no numeric fields is not a measurement. Keep the relay's unknown-vs-zero
  // convention instead of manufacturing a cost report for an upstream that omitted usage.
  if (input === undefined && typeof usage.output_tokens !== "number") return null;
  const out: { prompt_tokens?: number; completion_tokens?: number; prompt_tokens_details?: { cached_tokens?: number } } = {
    ...(input !== undefined ? { prompt_tokens: input + cacheSum } : {}),
    ...(typeof usage.output_tokens === "number" ? { completion_tokens: usage.output_tokens } : {}),
  };
  // The details object only when a cache read was actually reported — `{cached_tokens: 0}`
  // would claim the backend stated something about caching that it did not.
  if (cacheRead !== undefined) {
    out.prompt_tokens_details = { cached_tokens: cacheRead };
  }
  return out;
}

/**
 * OpenAI→Anthropic prompt-side mapping (the translated seam of `openAiResponseToAnthropic`).
 *
 * Mirror of `openAiUsage`: subtract the cached subset back OUT of `prompt_tokens`, because
 * Anthropic's `input_tokens` must exclude it or every downstream reader of the Anthropic shape
 * (validator, repair envelope re-attachment, SSE re-emission) sees a double-counted figure.
 * Only mapped when the host actually reported `prompt_tokens_details.cached_tokens`, as a
 * finite non-negative number; anything else (`cached_tokens > prompt_tokens`, negative,
 * non-finite) is malformed host output rather than evidence, so the prompt figure passes
 * through unchanged and the cache field is dropped — an unmeasurable split is not evidence
 * either way, and inventing one would be worse than none.
 */
function openAiPromptUsageToAnthropic(
  rawUsage: Record<string, unknown>,
): { input_tokens?: number; cache_read_input_tokens?: number } {
  if (typeof rawUsage.prompt_tokens !== "number") return {};
  // Same trust rule as `measuredCacheTokens`, applied to the split direction: a negative or
  // non-finite `cached_tokens` would make `input_tokens` EXCEED the prompt the host stated, so
  // it is malformed exactly like `cached > prompt_tokens`.
  const cached = (() => {
    const details = rawUsage.prompt_tokens_details;
    if (typeof details !== "object" || details === null) return undefined;
    return measuredCacheTokens((details as Record<string, unknown>).cached_tokens);
  })();
  if (cached === undefined || cached > rawUsage.prompt_tokens) {
    return { input_tokens: rawUsage.prompt_tokens };
  }
  return {
    input_tokens: rawUsage.prompt_tokens - cached,
    cache_read_input_tokens: cached,
  };
}

function withOpenAiTotal(usage: { prompt_tokens?: number; completion_tokens?: number }): Record<string, unknown> {
  if (typeof usage.prompt_tokens === "number" && typeof usage.completion_tokens === "number") {
    return { ...usage, total_tokens: usage.prompt_tokens + usage.completion_tokens };
  }
  return { ...usage };
}

function openAiFinishReason(stopReason: unknown, hasToolCalls: boolean): string {
  if (hasToolCalls || stopReason === "tool_use") return "tool_calls";
  if (stopReason === "max_tokens") return "length";
  if (stopReason === "content_filter") return "content_filter";
  return "stop";
}

/** Map an Anthropic error envelope to a client-readable OpenAI error envelope. */
function anthropicErrorToOpenAi(body: string, status: number): string {
  try {
    const parsed = JSON.parse(body) as unknown;
    if (typeof parsed === "object" && parsed !== null) {
      const top = parsed as Record<string, unknown>;
      const nested = typeof top.error === "object" && top.error !== null ? top.error as Record<string, unknown> : null;
      if (nested && typeof nested.message === "string") {
        return JSON.stringify({ error: {
          message: nested.message,
          type: typeof nested.type === "string" ? nested.type : "upstream_error",
          ...(nested.code !== undefined ? { code: nested.code } : {}),
        } });
      }
    }
  } catch {
    // Fall through to the normalizer, which preserves a useful bounded text message.
  }
  return normalizeOpenAiErrorBody(body, status) ?? body;
}

/**
 * Coerce an upstream error body into the OpenAI error envelope — WITHOUT rewriting one that
 * already conforms.
 *
 * The OpenAI front promises "OpenAI in, OpenAI out", but on the error path it returned whatever
 * shape the provider chose. Gemini wraps its error in a JSON ARRAY (`[{"error":{…}}]`); a client
 * reading `response.choices[0]` gets `undefined` from that and reports a malformed completion,
 * so a plain 429 surfaces as "the model returned garbage" — which is exactly how a rate limit
 * cost two days of debugging on the caller's side.
 *
 * Rules, in order:
 *   - already `{error:{…}}`     → returned BYTE-EXACT. A conforming provider's message, code and
 *                                 type are its own to state, and rewriting them would lose detail.
 *   - `[{error:{…}}, …]`        → unwrapped to the element. Same fields, now at the top level.
 *   - anything else (HTML, text,
 *     a bare string, empty)     → wrapped, with the original preserved as the message.
 *
 * Returns null when the body is already conforming, so the caller can stream the original bytes
 * rather than re-serialize them.
 */
export function normalizeOpenAiErrorBody(body: string, status: number): string | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(body);
  } catch {
    const message = body.trim().slice(0, 2000) || `upstream returned HTTP ${status} with an empty body`;
    return JSON.stringify({ error: { message, type: "upstream_error", code: status } });
  }

  const hasError = (v: unknown): v is { error: Record<string, unknown> } =>
    typeof v === "object" && v !== null && typeof (v as { error?: unknown }).error === "object" && (v as { error?: unknown }).error !== null;

  if (hasError(parsed)) return null; // conforms — do not touch it

  if (Array.isArray(parsed)) {
    const wrapped = parsed.find(hasError);
    if (wrapped) return JSON.stringify(wrapped);
  }

  return JSON.stringify({
    error: {
      message: body.trim().slice(0, 2000) || `upstream returned HTTP ${status} with an empty body`,
      type: "upstream_error",
      code: status,
    },
  });
}

function buildTargetHeaders(attempt: ResolvedAttempt): Record<string, string> {
  const { target, credential } = attempt;
  return {
    "content-type": "application/json",
    ...buildAuthHeaders(credential.value, target.authHeader),
  };
}

/**
 * OpenAI-compatible FRONT: an OpenAI Chat Completions or Responses request comes in, its
 * `model` has already been resolved to a provider target by namespace/tier routing.
 *
 * The common case remains a byte-transparent OpenAI→OpenAI Chat Completions proxy. The other
 * combinations use the same Anthropic-shaped internal seam as the Messages front:
 * OpenAI request → Anthropic request → resolved backend → Anthropic response → OpenAI response.
 * That makes an Anthropic passthrough usable from Codex and OpenAI-native IDEs without changing
 * the existing Claude client path.
 */
export interface FetchOpenAiFrontArgs {
  reqJson: unknown;
  wantsStream: boolean;
  signal: AbortSignal;
  protocol?: OpenAiFrontProtocol;
  anthropicHeaders?: Record<string, string>;
  /** See `fetchBackend`'s field of the same name: required so no caller can silently opt out. */
  isDestructive: (name: string) => boolean;
  processRecoveredChat?: RecoveredOpenAiChatProcessor;
  usage?: UsageAccumulator;
  onEgress?: OnEgress;
  /**
   * Catalog max-output lookup for the Responses front's `anthropic`-kind fallback (2026-09-09).
   * Anthropic's Messages API REQUIRES `max_tokens`, and `openaiResponsesRequestToAnthropic` no
   * longer invents a value when the caller stated none (see that module's header) — so a
   * passthrough target still needs one resolved, and the catalog's published figure is the
   * second-strongest evidence after the deployment's own learned `max-output` fact. Optional:
   * absent (or a provider/model the catalog holds nothing for) falls straight through to
   * `DEFAULT_RESPONSES_MAX_TOKENS`.
   */
  catalogLimits?: (provider: string, model: string) => { maxOutputTokens: number | null } | null | undefined;
}

/**
 * The Responses front's `max_tokens` for an `anthropic`-kind target when the caller's own
 * `max_output_tokens` was absent — Anthropic's Messages API requires the field, so ONE of these
 * three rungs must fill it, most-authoritative first: the deployment's own learned `max-output`
 * fact (`context-limits.ts` — first-party, this exact deployment stated its ceiling while
 * refusing an over-sized request), the catalog's published figure for it, then the named tunable
 * default `DEFAULT_RESPONSES_MAX_TOKENS`. No model on the target (a bare passthrough entry with
 * no `model` field) skips straight to the default — there is nothing to key a lookup on.
 */
function resolveAnthropicResponsesMaxTokens(
  target: { provider: string; model?: string },
  catalogLimits?: (provider: string, model: string) => { maxOutputTokens: number | null } | null | undefined,
): number {
  if (target.model) {
    const learned = observedMaxOutput(target.provider, target.model);
    if (typeof learned === "number" && learned > 0) return learned;
    const published = catalogLimits?.(target.provider, target.model)?.maxOutputTokens;
    if (typeof published === "number" && published > 0) return published;
  }
  return DEFAULT_RESPONSES_MAX_TOKENS;
}

async function fetchDirectOpenAiChat(
  attempt: ResolvedAttempt,
  args: FetchOpenAiFrontArgs,
  invokeFetch: typeof fetch,
): Promise<Response> {
  const target = attempt.target;
  const base = (args.reqJson ?? {}) as Record<string, unknown>;
  const schemas = toolSchemaMap(base);
  const callerRequestedUsage = isRecord(base.stream_options) && base.stream_options.include_usage === true;
  const relayAddedUsage = args.wantsStream && !callerRequestedUsage;
  const body: Record<string, unknown> = { ...base, model: target.model, stream: args.wantsStream };
  const originalBody = { ...body };
  if (relayAddedUsage) {
    body.stream_options = {
      ...(isRecord(base.stream_options) ? base.stream_options : {}),
      include_usage: true,
    };
  }
  const post = (requestBody: Record<string, unknown>) => invokeFetch(target.base + "/chat/completions", {
    method: "POST",
    headers: buildTargetHeaders(attempt),
    body: JSON.stringify(requestBody),
    signal: args.signal,
  });
  let res = await post(body);
  // Only a relay-added compatibility hint is safe to remove. A caller-provided option is
  // their request, not relay policy.
  if (!res.ok && relayAddedUsage && (res.status === 400 || res.status === 422)) {
    await res.body?.cancel().catch(() => {});
    res = await post(originalBody);
  }
  if (args.usage) {
    const nativeStreamed = nativeResponseIsStreamed(res, args.wantsStream);
    res = observeUsage(res, "openai-chat", args.usage, { streamed: nativeStreamed });
  }
  if (!res.ok) return res;
  const streamed = args.wantsStream || (res.headers.get("content-type") ?? "").includes("text/event-stream");
  if (streamed) {
    if (!res.body) {
      return openaiError(502, "llm-relay: invalid OpenAI upstream envelope: empty stream", "upstream", "invalid_upstream_envelope", retryAfterHeader(res.headers));
    }
    const preflight = await preflightResponseStream(res.body, "openai-chat");
    if (!preflight.ok) {
      return openaiError(502, `llm-relay: invalid OpenAI upstream envelope: ${preflight.reason}`, "upstream", "invalid_upstream_envelope", retryAfterHeader(res.headers));
    }
    let response: Response | null = null;
    let recovered = false;
    const chatRefusalSignal = dialectRefusalSignal();
    const responseBody = schemas.size > 0
      ? recoverDialectInOpenAiChatStream(preflight.body, schemas, args.isDestructive, () => {
          recovered = true;
          response?.headers.set(TOOL_DIALECT_HEADER, "recovered");
        }, args.processRecoveredChat, chatRefusalSignal)
      : preflight.body;
    response = new Response(
      relayAddedUsage ? suppressRelayAddedOpenAiUsageFrames(responseBody) : responseBody,
      { status: res.status, headers: res.headers },
    );
    if (recovered) response.headers.set(TOOL_DIALECT_HEADER, "recovered");
    dialectRefusalSignals.set(response, chatRefusalSignal);
    return attachUpstreamMetadata(response, preflight.metadata);
  }

  let responseBody: unknown;
  try {
    responseBody = await res.clone().json();
  } catch (cause) {
    if (!(cause instanceof SyntaxError)) return attachPostHeaderBodyFailure(res, cause);
    return openaiError(502, "llm-relay: invalid OpenAI upstream envelope: body is not valid JSON", "upstream", "invalid_upstream_envelope", retryAfterHeader(res.headers));
  }
  const invalidReason = invalidEnvelopeReason(responseBody, "openai-chat", false);
  if (invalidReason) {
    return openaiError(502, `llm-relay: invalid OpenAI upstream envelope: ${invalidReason}`, "upstream", "invalid_upstream_envelope", retryAfterHeader(res.headers));
  }
  let recovery;
  try {
    recovery = await inspectDialectInOpenAiChat(
      responseBody as Record<string, unknown>,
      schemas,
      args.isDestructive,
      args.processRecoveredChat,
    );
  } catch (error) {
    return openaiError(
      502,
      `llm-relay: ${error instanceof Error ? error.message : String(error)}`,
      "upstream",
      "tool_call_recovery_failed",
    );
  }
  if (recovery.status === "refused-destructive") {
    // "local" keeps this out of the failover walk and off the deployment's failure budget: the
    // envelope parsed fine, the relay refused to commit what it reconstructed. Config, not
    // health — the same line the hard cap draws.
    return openaiError(
      502,
      `llm-relay: refused a ${recovery.dialect} tool call recovered from text because it names a destructive tool: ${describeRefused(recovery.refused)}`,
      "local",
      DIALECT_REFUSED_DESTRUCTIVE_CODE,
      { [TOOL_DIALECT_HEADER]: "refused-destructive" },
    );
  }
  if (recovery.status === "detected") {
    return openaiError(
      502,
      `llm-relay: backend returned an unparseable ${recovery.dialect} tool-call envelope as text`,
      "upstream",
      "tool_dialect_unparseable",
    );
  }
  const metadata: UpstreamResponseMetadata = {};
  const finalBody = recovery.status === "parsed" ? recovery.body : responseBody;
  captureReportedModel(metadata, finalBody, "openai-chat", false);
  if (recovery.status === "parsed") {
    const headers = new Headers(res.headers);
    headers.set(TOOL_DIALECT_HEADER, "recovered");
    return attachUpstreamMetadata(new Response(JSON.stringify(finalBody), {
      status: res.status,
      headers,
    }), metadata);
  }
  return attachUpstreamMetadata(res, metadata);
}

/**
 * Watch an Anthropic SSE stream for its `message_delta`'s `stop_reason`, calling `onStopReason`
 * the moment it is seen, while passing every byte through UNCHANGED.
 *
 * Why a tap and not a tee: the scan runs SYNCHRONOUSLY inside the same `transform()` call that
 * re-enqueues the chunk, so by the time any downstream reader of the returned stream (here,
 * llm-bridge's own translator) observes a given byte, this tap has already inspected it — no
 * race, and no second reader competing with the real one for backpressure. `stop_reason` always
 * arrives on `message_delta`, strictly before `message_stop`, so it is available before llm-bridge
 * ever reaches the point of emitting `response.completed` from it.
 */
function tapAnthropicStopReason(
  source: ReadableStream<Uint8Array>,
  onStopReason: (reason: string) => void,
): ReadableStream<Uint8Array> {
  const decoder = new TextDecoder();
  const frames = new BufferedSseFrames();
  let seen = false;
  return source.pipeThrough(new TransformStream<Uint8Array, Uint8Array>({
    transform(chunk, controller) {
      controller.enqueue(chunk);
      if (seen) return;
      frames.append(decoder.decode(chunk, { stream: true }));
      for (const { frame } of frames) {
        if (seen) break;
        const ev = parseSseEvent(frame);
        if (ev?.type !== "message_delta" || !isRecord(ev.data)) continue;
        const delta = ev.data.delta;
        if (isRecord(delta) && typeof delta.stop_reason === "string") {
          seen = true;
          onStopReason(delta.stop_reason);
        }
      }
    },
  }));
}

/** One OpenAI Responses SSE frame: `event: <type>\ndata: {"type":<type>,...}\n\n`. */
function responsesSseEvent(type: string, data: Record<string, unknown>): string {
  return `event: ${type}\ndata: ${JSON.stringify({ ...data, type })}\n\n`;
}

/**
 * Rewrite the Responses front's terminal `response.completed` event to `response.incomplete`
 * (`status: "incomplete"`, `incomplete_details: {reason: "max_output_tokens"}`) whenever the
 * underlying Anthropic message stopped on `max_tokens` — mirroring the `response.incomplete`
 * event this file already handles INBOUND (`RESPONSES_STREAM_HANDLERS`, above).
 *
 * llm-bridge's own Anthropic→Responses stream emitter — there is no relay-owned mirror for this
 * direction, unlike the reverse (`translateResponsesStreamToAnthropic`) — always answers
 * `"completed"` for every non-error stop reason, dropping `stop_reason` entirely. This wraps its
 * output rather than duplicating its whole translation: `stopReason` is read from the SAME
 * Anthropic stream via `tapAnthropicStopReason`, populated before this wrapper ever sees the
 * matching `response.completed` frame. Every other stop reason passes the frame through verbatim.
 */
function markResponsesIncompleteOnMaxTokens(
  source: ReadableStream<Uint8Array>,
  stopReason: { value: string | null },
): ReadableStream<Uint8Array> {
  return createSseTransformStream(source, ({ push, frames }) => ({
    processFrames: () => {
      for (const { frame, raw } of frames) {
        const ev = parseSseEvent(frame);
        if (
          stopReason.value === "max_tokens" &&
          ev?.type === "response.completed" &&
          isRecord(ev.data) &&
          isRecord(ev.data.response)
        ) {
          push(responsesSseEvent("response.incomplete", {
            ...ev.data,
            response: {
              ...ev.data.response,
              status: "incomplete",
              incomplete_details: { reason: "max_output_tokens" },
            },
          }));
          continue;
        }
        push(raw);
      }
    },
  }));
}

/**
 * Lift every `thinking` content block OUT of an Anthropic SSE stream, collecting its text.
 *
 * The Responses FRONT's streamed lane runs through llm-bridge's Anthropic→Responses emitter, and
 * that emitter has no `thinking` representation: it funnels a thinking block's deltas into the
 * SAME `output_text` item as the answer, so DeepSeek's reasoning arrives at a Codex caller fused
 * into the visible reply (`"deep thought" + "hi"` → `"deep thoughthi"`, measured 2026-09-15 against
 * llm-bridge 2.0.1). That is not a formatting wrinkle — it puts chain-of-thought in the answer.
 *
 * So the block is removed before llm-bridge sees it and re-emitted as a native `reasoning` output
 * item by `emitResponsesReasoningItem` below, which is where a Responses caller reads it (and what
 * `responses-request.ts` turns back into a leading `thinking` block on the next turn).
 *
 * ⚠ Frame-framed and index-preserving: only `content_block_start`/`delta`/`stop` frames whose
 * block is a thinking one are swallowed, and the surrounding frames keep their own indices, so
 * every other block's numbering is exactly what llm-bridge would have produced.
 */
function liftThinkingFromAnthropicStream(
  source: ReadableStream<Uint8Array>,
  onThinking: (text: string) => void,
): ReadableStream<Uint8Array> {
  const decoder = new TextDecoder();
  const frames = new BufferedSseFrames();
  // Anthropic content-block indices currently open as a thinking block.
  const thinkingBlocks = new Map<number, string>();
  return source.pipeThrough(new TransformStream<Uint8Array, Uint8Array>({
    transform(chunk, controller) {
      frames.append(decoder.decode(chunk, { stream: true }));
      for (const { frame, raw } of frames) {
        const ev = parseSseEvent(frame);
        const data = ev && isRecord(ev.data) ? ev.data : null;
        const index = data && typeof data.index === "number" ? data.index : -1;
        if (ev?.type === "content_block_start" && isRecord(data?.content_block) && data.content_block.type === "thinking") {
          const text = typeof data.content_block.thinking === "string" ? data.content_block.thinking : "";
          thinkingBlocks.set(index, text);
          continue;
        }
        if (ev?.type === "content_block_delta" && thinkingBlocks.has(index)) {
          const delta = isRecord(data?.delta) ? data.delta : {};
          if (delta.type === "thinking_delta" && typeof delta.thinking === "string") {
            thinkingBlocks.set(index, (thinkingBlocks.get(index) ?? "") + delta.thinking);
          }
          continue;
        }
        if (ev?.type === "content_block_stop" && thinkingBlocks.has(index)) {
          const text = thinkingBlocks.get(index) ?? "";
          thinkingBlocks.delete(index);
          if (text.length > 0) onThinking(text);
          continue;
        }
        controller.enqueue(new TextEncoder().encode(raw));
      }
    },
  }));
}

/**
 * Announce a `reasoning` output item at the head of a Responses stream, from text
 * `liftThinkingFromAnthropicStream` collected — the Responses-front sibling of the buffered
 * `formatOpenAiResponses` reasoning item, and emitted for the same reason: a Codex caller replays
 * it as a `reasoning` item, which `responses-request.ts` reads back as a leading `thinking` block.
 *
 * Written BEFORE the first content-bearing frame llm-bridge emits, so the item precedes the answer
 * it explains (Responses orders reasoning ahead of the message it belongs to). `response.created`
 * is the natural anchor — it is the first frame of every stream and carries no output indices yet.
 * A stream that never reaches it falls back to the first frame seen, so the item is still ahead of
 * anything with an `output_index`.
 *
 * ⚠ Nothing is emitted when no reasoning was collected, so a target that sent none produces the
 * byte-for-byte pre-existing stream.
 */
function emitResponsesReasoningItem(
  source: ReadableStream<Uint8Array>,
  thinking: { text: string },
): ReadableStream<Uint8Array> {
  let emitted = false;
  const frame = (): string => responsesSseEvent("response.output_item.done", {
    output_index: -1,
    item: {
      type: "reasoning",
      id: "rs_relay",
      status: "completed",
      summary: [{ type: "summary_text", text: thinking.text }],
    },
  });
  return createSseTransformStream(source, ({ push, frames }) => ({
    processFrames: () => {
      for (const { frame: rawFrame, raw } of frames) {
        if (!emitted && thinking.text.length > 0) {
          const ev = parseSseEvent(rawFrame);
          if (ev?.type === "response.created" || ev?.type === "response.in_progress") {
            push(raw);
            push(frame());
            emitted = true;
            continue;
          }
        }
        push(raw);
      }
    },
    // A stream that ended without a reasoning item announced still owes the caller its reasoning —
    // nothing has been sent yet at this point only if the whole stream was reasoning.
    flushHeld: () => {
      if (!emitted && thinking.text.length > 0) {
        push(frame());
        emitted = true;
      }
    },
  }));
}

async function fetchTranslatedOpenAiFront(
  attempt: ResolvedAttempt,
  args: FetchOpenAiFrontArgs,
  fetchFn: typeof fetch,
): Promise<Response> {
  const target = attempt.target;
  const protocol = args.protocol ?? "chat";
  const base = (args.reqJson ?? {}) as Record<string, unknown>;

  let anthropicBody: Record<string, unknown>;
  try {
    // The RESPONSES request direction is relay-owned (`responses-request.ts`), for the same
    // reason the Anthropic→OpenAI direction is: llm-bridge's `openaiResponsesToUniversal` models
    // only `function_call_output`, so an assistant `function_call` was flattened into an empty
    // user turn and an assistant `output_text` reached the backend as a JSON string. The CHAT
    // request direction stays llm-bridge's (`openaiToUniversal` does handle `tool_calls` and
    // `role:"tool"`), as does every response/stream direction.
    anthropicBody = protocol === "responses"
      // `reasoning` is the same resolved mode `anthropicRequestToOpenAi` reads below (via
      // `fetchOpenAiBackend`, reached through `fetchBackend` for an `openai`-kind target): a
      // Codex `reasoning` item is carried onto a `thinking` block here ONLY under "deepseek"
      // (F11), so `openai-request.ts` can carry it onward as `reasoning_content`. Every other
      // target's outbound bytes are unchanged.
      ? openaiResponsesRequestToAnthropic(base, { ...(target.reasoning !== undefined ? { reasoning: target.reasoning } : {}) })
      : translateBetweenProviders("openai", "anthropic", base as never) as Record<string, unknown>;
    if (target.model !== undefined) anthropicBody.model = target.model;
    anthropicBody.stream = args.wantsStream;
    // The Responses front carries NO `max_tokens` when the caller's `max_output_tokens` was
    // absent (`responses-request.ts`). An `openai`-kind target is fine with that — the mapper
    // ahead omits the field and the provider applies its own ceiling — but Anthropic's Messages
    // API REQUIRES it, so a passthrough target needs one resolved here, at the target.
    if (protocol === "responses" && target.kind === "anthropic" && typeof anthropicBody.max_tokens !== "number") {
      anthropicBody.max_tokens = resolveAnthropicResponsesMaxTokens(target, args.catalogLimits);
    }
  } catch (e) {
    // A shape we will not put on the wire is the caller's request being unrepresentable, not a
    // provider failure — the same clean local 400 the Messages front raises.
    if (e instanceof RequestMappingError) return openaiError(400, `llm-relay: ${e.message}`, "local");
    return openaiError(400, `llm-relay: request translation failed: ${(e as Error).message}`, "local");
  }

  const reqBuf = Buffer.from(JSON.stringify(anthropicBody), "utf8");
  const backendRes = await fetchBackend(attempt, {
    path: "/v1/messages",
    method: "POST",
    reqBuf,
    reqJson: anthropicBody,
    anthropicHeaders: args.anthropicHeaders ?? {},
    wantsStream: args.wantsStream,
    isDestructive: args.isDestructive,
    ...(args.usage ? { usage: args.usage } : {}),
    signal: args.signal,
    ...(args.onEgress ? { onEgress: args.onEgress } : {}),
  }, fetchFn);
  const metadata = upstreamResponseMetadata.get(backendRes);
  if (postHeaderBodyFailure(backendRes)) return backendRes;

  if (!backendRes.ok) {
    let raw: string;
    try {
      raw = await backendRes.text();
    } catch (cause) {
      return attachPostHeaderBodyFailure(backendRes, cause);
    }
    // Absent or unreadable ⇒ `"upstream"`, deliberately: the provider DID answer, and the relay
    // marks its own errors. `errorOrigin` is the one place the declared members are enumerated,
    // and it is now derived from the type — so a third member cannot be silently rejected here.
    const origin = errorOrigin(backendRes) ?? "upstream";
    // Same rule as the two id-rewrite counters below: rebuilding the response must not swallow the
    // announcement of a decision the relay made one Response ago. A dialect-rescue destructive
    // refusal arrives here as a 502 from `fetchBackend` carrying `refused-destructive`, and a
    // Responses/Messages-front client is entitled to the same marker the Messages front gets.
    const dialect = backendRes.headers.get(TOOL_DIALECT_HEADER);
    const headers: Record<string, string> = {
      "content-type": "application/json",
      [ERROR_ORIGIN_HEADER]: origin,
      ...(dialect ? { [TOOL_DIALECT_HEADER]: dialect } : {}),
      ...retryAfterHeader(backendRes.headers),
    };
    return new Response(anthropicErrorToOpenAi(raw, backendRes.status), { status: backendRes.status, headers });
  }

  const streamed = args.wantsStream || (backendRes.headers.get("content-type") ?? "").includes("text/event-stream");
  if (streamed) {
    if (!backendRes.body) {
      const generated = target.kind !== "anthropic";
      return openaiError(
        502,
        generated ? "llm-relay: response mapper produced an empty stream" : "llm-relay: invalid Anthropic upstream envelope: empty stream",
        generated ? "local" : "upstream",
        generated ? "relay_mapper_defect" : "invalid_upstream_envelope",
        retryAfterHeader(backendRes.headers),
      );
    }
    const preflight = await preflightResponseStream(backendRes.body, "anthropic-messages");
    if (!preflight.ok) {
      const generated = target.kind !== "anthropic";
      return openaiError(
        502,
        generated
          ? `llm-relay: response mapper produced an invalid Anthropic envelope: ${preflight.reason}`
          : `llm-relay: invalid Anthropic upstream envelope: ${preflight.reason}`,
        generated ? "local" : "upstream",
        generated ? "relay_mapper_defect" : "invalid_upstream_envelope",
        retryAfterHeader(backendRes.headers),
      );
    }
    const targetProtocol = protocol === "responses" ? "openai-responses" : "openai";
    try {
      // Responses-only: the Chat protocol already carries `finish_reason: "length"` correctly
      // (`openAiFinishReason`, the buffered path's sibling), so there is nothing to announce there.
      const stopReason: { value: string | null } = { value: null };
      // A `"deepseek"` target's reasoning must be LIFTED OUT before llm-bridge sees it: its
      // Anthropic→Responses emitter has no thinking representation and folds a thinking block's
      // deltas into the answer text, so a streamed reasoning block would reach the caller fused
      // into its reply. Every other target takes the untouched source (see
      // `liftThinkingFromAnthropicStream`).
      const carryReasoning = protocol === "responses" && target.reasoning === "deepseek";
      const lifted = { text: "" };
      const anthropicSource = protocol === "responses"
        ? tapAnthropicStopReason(
          carryReasoning
            ? liftThinkingFromAnthropicStream(preflight.body, (t) => { lifted.text += t; })
            : preflight.body,
          (r) => { stopReason.value = r; },
        )
        : preflight.body;
      let output = handleUniversalStreamRequest(anthropicSource, "anthropic", targetProtocol);
      if (protocol === "responses") output = markResponsesIncompleteOnMaxTokens(output, stopReason);
      if (carryReasoning) output = emitResponsesReasoningItem(output, lifted);
      // Same rule as the buffered rebuild below: rebuilding the response must not swallow the
      // announcement of a fix the relay applied one Response ago.
      const rewritten = backendRes.headers.get(TOOL_CALL_IDS_HEADER);
      const response = new Response(output, {
        status: backendRes.status,
        headers: {
          "content-type": "text/event-stream",
          ...(rewritten ? { [TOOL_CALL_IDS_HEADER]: rewritten } : {}),
        },
      });
      // Carry the refusal SIGNAL across the rebuild for the same reason as the header above: this
      // Response is the one the server probes, and the object it must consult was registered
      // against the inner Response one hop ago. The signal is the same live object, so a refusal
      // the wrapper marks after this line is still visible.
      const innerRefusal = dialectRefusalSignals.get(backendRes);
      if (innerRefusal) dialectRefusalSignals.set(response, innerRefusal);
      return metadata ? attachUpstreamMetadata(response, metadata) : response;
    } catch (e) {
      return openaiError(502, `llm-relay: response translation failed: ${(e as Error).message}`, "local", "relay_mapper_defect");
    }
  }

  let body: unknown;
  try {
    body = await backendRes.json();
  } catch (cause) {
    if (!(cause instanceof SyntaxError)) return attachPostHeaderBodyFailure(backendRes, cause);
    const generated = target.kind !== "anthropic";
    return openaiError(
      502,
      generated ? "llm-relay: response mapper produced non-JSON output" : "llm-relay: invalid Anthropic upstream envelope: body is not valid JSON",
      generated ? "local" : "upstream",
      generated ? "relay_mapper_defect" : "invalid_upstream_envelope",
      retryAfterHeader(backendRes.headers),
    );
  }
  const invalidReason = invalidEnvelopeReason(body, "anthropic-messages", false);
  if (invalidReason) {
    const generated = target.kind !== "anthropic";
    return openaiError(
      502,
      generated
        ? `llm-relay: response mapper produced an invalid Anthropic envelope: ${invalidReason}`
        : `llm-relay: invalid Anthropic upstream envelope: ${invalidReason}`,
      generated ? "local" : "upstream",
      generated ? "relay_mapper_defect" : "invalid_upstream_envelope",
      retryAfterHeader(backendRes.headers),
    );
  }

  try {
    // This front's TRANSLATED lane runs through `fetchBackend`, so an `openai`-kind target reached
    // from `/v1/responses` inherits the id mint. Rebuilding the body must not swallow the
    // announcement — an automatic fix is acceptable only because it is announced, and the count
    // is as true here as it was one Response ago.
    const minted = backendRes.headers.get(TOOL_USE_IDS_HEADER);
    // …and the outbound-id rewrite the same request mapper applied on the way IN.
    const rewritten = backendRes.headers.get(TOOL_CALL_IDS_HEADER);
    // A `thinking` block reaches a Responses caller as a `reasoning` item ONLY for a
    // `"deepseek"` target (the response-direction end of that seam) — the mode is the resolved
    // one from the target, never a provider identity. Every other target's rebuilt body is the
    // pre-2026-09-15 document, thinking dropped as before.
    const response = new Response(JSON.stringify(anthropicMessageToOpenAi(body as Record<string, unknown>, protocol, target.model ?? String(base.model ?? ""), target.reasoning)), {
      status: backendRes.status,
      headers: {
        "content-type": "application/json",
        ...(minted ? { [TOOL_USE_IDS_HEADER]: minted } : {}),
        ...(rewritten ? { [TOOL_CALL_IDS_HEADER]: rewritten } : {}),
      },
    });
    return metadata ? attachUpstreamMetadata(response, metadata) : response;
  } catch (e) {
    return openaiError(502, `llm-relay: response translation failed: ${(e as Error).message}`, "local", "relay_mapper_defect");
  }
}

/**
 * OpenAI-compatible FRONT: an OpenAI Chat Completions or Responses request comes in, its
 * `model` has already been resolved to a provider target by namespace/tier routing.
 *
 * The common case remains a byte-transparent OpenAI→OpenAI Chat Completions proxy. The other
 * combinations use the same Anthropic-shaped internal seam as the Messages front:
 * OpenAI request → Anthropic request → resolved backend → Anthropic response → OpenAI response.
 * That makes an Anthropic passthrough usable from Codex and OpenAI-native IDEs without changing
 * the existing Claude client path.
 */
export async function fetchOpenAiFront(
  attempt: ResolvedAttempt,
  args: FetchOpenAiFrontArgs,
  fetchFn: typeof fetch = fetch,
): Promise<Response> {
  const protocol = args.protocol ?? "chat";
  // The direct byte-transparent Chat passthrough is only valid when the TARGET actually speaks
  // Chat Completions upstream. A `wire: "responses"` target never does (that is the whole reason
  // the field exists), so a Chat-front request to one must still go through the translated path —
  // front -> Anthropic -> `fetchBackend` -> `fetchOpenAiBackend`'s `wire` dispatch -> `/responses`
  // — never a raw `/chat/completions` POST the upstream would 500 on.
  if (attempt.target.kind === "openai" && protocol === "chat" && attempt.target.wire !== "responses") {
    const invokeFetch = oneShotFetch(fetchFn, args.signal, args.onEgress);
    return fetchDirectOpenAiChat(attempt, args, invokeFetch);
  }
  return fetchTranslatedOpenAiFront(attempt, args, fetchFn);
}
