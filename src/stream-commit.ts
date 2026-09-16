import { DIALECT_REFUSED_DESTRUCTIVE_CODE, type DialectRefusalSignal } from "./tool-dialects.js";
import { isRecord } from "./json-shape.js";
import { BufferedSseFrames, sseEventFields } from "./sse-frames.js";

/**
 * Final-wire streamed response commit probe.
 *
 * A structurally valid SSE preamble is not yet an answer.  Keep the downstream head provisional
 * until the client-facing protocol carries meaningful assistant output, then replay every byte
 * exactly as received.  Before that point, an in-band error or an empty completion is safe to
 * fail over because the client has observed nothing.
 */

export type StreamCommitProtocol = "anthropic-messages" | "openai-chat" | "openai-responses";

/**
 * The classified cause of a dead stream, when the backend STATED one.
 *
 * A pre-commit empty stream is the one failure shape the relay cannot explain from its own
 * behaviour: nothing was written to the client, the provider answered 200, and the bytes carry
 * only the trace of what happened. Measured 2026-09-10: a streamed `deepseek/deepseek-flash`
 * request that spent its whole `max_tokens` budget on reasoning and emitted no text answered the
 * client `502 stream completed without meaningful content`, and the real cause was visible only by
 * re-sending the request outside the relay and reading the raw response.
 *
 * ⚠ Every member here is a STOP REASON THE BACKEND SENT, normalized. There is deliberately no
 * `unknown` member and no default: the field is ABSENT when the backend stated nothing, because a
 * guess wearing a classification is exactly what the provenance invariant forbids and this
 * codebase's most-repeated defect class produces. A caller that finds it absent must fall back to
 * the generic message rather than filling the gap.
 */
export type StreamStopCause =
  /** The backend stopped because it hit the output ceiling — `max_tokens` / `length`. */
  | "max_tokens"
  /** The backend stopped by finishing a tool call; the relay saw no committed content. */
  | "tool_use";

/**
 * The metadata-log / wire classifier for a dead stream. A SHORT enum-like string, safe to log:
 * it says what the backend did, never anything it said.
 *
 * ⚠ `stopReason` is the `StreamStopCause` above or `null` when the backend stated none — the two
 * are different outcomes and the log must be able to tell them apart, which is why the unknown
 * case is spelled `stop_reason_unknown` rather than reusing a member.
 */
export interface StreamDeadClassification {
  stopReason: StreamStopCause | null;
  /**
   * How many REASONING tokens the backend reported for this response, when it reported a count.
   * `null` when no usage frame carried one — never 0, which would read as a measurement.
   */
  reasoningTokens: number | null;
}

export type StreamCommitProbe =
  | { kind: "ready"; body: ReadableStream<Uint8Array> }
  | {
      kind: "dead";
      reason: string;
      provenance: "upstream" | "local";
      /**
       * The relay's own error code, when this dead verdict is the relay's decision rather than an
       * upstream failure. Absent for every ordinary dead stream, so a front that ignores it keeps
       * serving exactly the generic `api_error` it always did.
       */
      errorType?: string;
      /**
       * What the BACKEND said about why it stopped, when it said anything. Absent for every dead
       * verdict whose cause the backend did not state — a local mapper defect, a probe-limit
       * overrun, a cancelled read — so a front that ignores it behaves exactly as before.
       */
      classification?: StreamDeadClassification;
    }
  | { kind: "cancelled" };

export interface StreamCommitProbeOptions {
  /** Client cancellation wins races with EOF/read failures and must never start another target. */
  isCancelled?: () => boolean;
  /** Malformed final wire produced by a response mapper is a local defect, not target health. */
  malformedProvenance?: "upstream" | "local";
  /** A rejected body read is normally transport/upstream even when parsing is mapper-local. */
  readFailureProvenance?: "upstream" | "local";
  /**
   * Set by the dialect-rescue wrapper on THIS stream when it refused a recovered destructive call.
   * Absent on every lane the relay did not wrap, which is what stops an upstream minting `local`
   * provenance for itself by echoing the code. See `DialectRefusalSignal`.
   */
  relayRefusal?: DialectRefusalSignal;
}

/**
 * The client protocol a front is answering, as far as provenance is concerned.
 *
 * Deliberately NOT `ResponseProtocol` (`backend/envelope-validator.ts`), which names the shape a
 * response mapper reads. This names the shape the CLIENT asked for, and the two front doors do not
 * offer the same set: `/v1/messages` only ever answers `anthropic-messages`, while the OpenAI front
 * answers `chat` or `responses`.
 */
export type FrontProtocol = "anthropic-messages" | "chat" | "responses";

/**
 * Did the RELAY author the bytes of this response, or did the provider?
 *
 * `upstream` means the provider produced them, so a malformed final wire is the PROVIDER's fault:
 * the outcome is retriable and the walk fails over to the next candidate. `local` means the relay
 * produced them by translating, so the outcome is TERMINAL — the same line this module draws for a
 * relay-authored refusal, and the same one `CLAUDE.md` draws when it says a hard cap "is config,
 * not health".
 *
 * ⚠ The rule is ONE rule: the relay authored the bytes unless the response was a byte passthrough,
 * and a passthrough happens exactly when the target's native protocol is the one the client asked
 * for. Until 2026-09-06 (CLONE-07) it was spelled twice, once per front, against each front's own
 * passthrough condition — `openai`-kind means translated on the Anthropic front, while on the
 * OpenAI front only `openai`-kind PLUS `chat` is a passthrough. The two spellings never disagreed:
 * a truth table over all six reachable combinations is in
 * `docs/reviews/clone-07-clone-26-evidence-2026-09-05.md`, and `test/stream-commit.test.ts` pins
 * every row. Naming it once is what stops a fifth call site inventing a seventh row, because a new
 * front or a new protocol currently has two places to get right and no compiler help.
 */
export function relayAuthoredResponse(
  targetKind: "anthropic" | "openai",
  frontProtocol: FrontProtocol,
): "upstream" | "local" {
  const passthrough =
    (targetKind === "anthropic" && frontProtocol === "anthropic-messages") ||
    (targetKind === "openai" && frontProtocol === "chat");
  return passthrough ? "upstream" : "local";
}

/** Shared by structural preflight and final-wire commit probing. */
export const STREAM_PREFLIGHT_LIMIT = 64 * 1024;

type EventVerdict =
  | { kind: "hold" }
  | { kind: "ready" }
  | { kind: "dead"; reason: string; provenance: "upstream" | "local"; errorType?: string };

const HOLD: EventVerdict = { kind: "hold" };
const READY: EventVerdict = { kind: "ready" };

/**
 * The backend's own account of how the turn ended, accumulated across every event the probe reads.
 *
 * ⚠ It is a SEPARATE channel from the per-event verdict, and it has to be. The events that state a
 * stop reason are precisely the ones that HOLD — a `message_delta` carrying `stop_reason`, a Chat
 * choice carrying `finish_reason`, a `response.completed` that committed nothing — so a classifier
 * hung off the verdict would see only the events that already ended the probe, which is the one
 * event guaranteed to be uninformative when it is absent.
 *
 * Every setter records only what the bytes SAY. Nothing here infers a stop reason from the shape of
 * a stream, from a token count, or from the protocol: a backend that states nothing leaves this
 * empty and the caller serves the generic message it always did.
 */
class StopReasonAccumulator {
  #stop: StreamStopCause | null = null;
  #reasoningTokens: number | null = null;

  /**
   * Record a stop reason stated by the backend.
   *
   * ⚠ The LAST statement wins, deliberately, and it is not a first-wins tie-break by accident: a
   * `message_delta` may report `end_turn` and be followed by a terminal frame reporting the true
   * ceiling, and the later event is the one that ends the stream. The vocabulary is closed at the
   * caller — an unrecognized spelling is dropped, never mapped onto a member it resembles.
   */
  recordStop(value: unknown): void {
    const cause = normalizeStopReason(value);
    if (cause !== null) this.#stop = cause;
  }

  /**
   * Record the REASONING-token figure a usage frame stated, where a protocol reports one.
   *
   * ⚠ Only the reasoning share is read, and it is deliberately NOT back-derived from the
   * output-token total. "The response produced eight tokens and sent no text" is an observation;
   * attributing those eight to thinking is an inference, and a count this module labels `reasoning`
   * has to mean the backend said so. Anthropic states no reasoning token field at all, so a
   * backend on that wire reports `reasoningTokens: null` and gets the stop cause without a count —
   * which is the honest answer, not a gap to fill with a nearby number.
   */
  recordUsage(value: unknown): void {
    if (!isRecord(value)) return;
    const reasoning = numericField(value, ["reasoning_tokens", "reasoningTokens", "reasoning_output_tokens"]);
    if (reasoning !== null) this.#reasoningTokens = reasoning;
  }

  /**
   * The classification, or `null` when the probe learned nothing worth reporting.
   *
   * `null` is what keeps this module's existing behaviour intact for a stream that failed for a
   * genuinely unknown reason: no stop reason and no token count means no classification, no
   * upgraded message, and the generic `stream completed without meaningful content` unchanged.
   */
  snapshot(): StreamDeadClassification | null {
    if (this.#stop === null && this.#reasoningTokens === null) return null;
    return { stopReason: this.#stop, reasoningTokens: this.#reasoningTokens };
  }
}

/**
 * The closed stop-reason vocabulary, per protocol, normalized to `StreamStopCause`.
 *
 * ⚠ Only the reasons that EXPLAIN an unexpected emptiness are admitted, and the ordinary
 * completion sentinels (`end_turn`, `stop`) are deliberately NOT among them.
 *
 * That exclusion is the whole design of this classifier and it was found by testing, not by
 * reasoning. A backend that ends a turn normally and sends no text has stated nothing the relay
 * could not already see: "the backend ended the turn without sending text" restates the generic
 * message rather than adding to it, and it would fire on the single most common empty stream there
 * is — every ordinary empty completion — rewriting a message operators and tests grep for in the
 * case where there is genuinely nothing to report. The value here is entirely in the reasons a
 * reader could NOT have guessed: the backend ran out of budget, or it stopped to call a tool and
 * the relay saw no committed content.
 *
 * A refusal is likewise not a stop this models, and `null` (the OpenAI "not finished yet"
 * sentinel) is not a statement. Every unrecognized spelling is DROPPED, never pressed into a
 * nearby member: an unmodelled `content_filter` must read as unknown, not as `max_tokens`.
 */
function normalizeStopReason(value: unknown): StreamStopCause | null {
  switch (value) {
    case "max_tokens":
    case "length":
      return "max_tokens";
    case "tool_use":
    case "tool_calls":
    case "function_call":
      return "tool_use";
    default:
      return null;
  }
}

function numericField(value: Record<string, unknown>, keys: readonly string[]): number | null {
  for (const key of keys) {
    const raw = value[key];
    if (typeof raw === "number" && Number.isFinite(raw) && raw >= 0) return raw;
  }
  return null;
}

/**
 * The served-error and metadata-log classifier for a dead stream's cause.
 *
 * A SHORT enum-like string, quoted verbatim into the error body and carried on the log's
 * `errorKinds` allow-list. It is derived from the backend's own statement and never from content,
 * which is what makes it safe to record: see `STOP_CAUSE_ERROR_KINDS`.
 */
export function stopCauseToken(classification: StreamDeadClassification | undefined): string {
  if (!classification) return "stop_reason_unknown";
  if (classification.stopReason === null) return "stop_reason_unknown";
  return STOP_CAUSE_ERROR_KINDS[classification.stopReason];
}

/**
 * The `errorKinds` spellings for each stated stop cause, as a TOTAL record.
 *
 * ⚠ Closed with `satisfies`, so a new `StreamStopCause` member is a COMPILE error here rather than
 * a cause that silently logs as something else. This is the codebase's most-repeated defect class:
 * a closed union classified by a fall-through that resolves to the STRONGER claim. Every value is a
 * fixed literal, so nothing from the wire can reach the log through this table.
 */
const STOP_CAUSE_ERROR_KINDS = {
  max_tokens: "backend_stopped_at_max_tokens",
  tool_use: "backend_stopped_at_tool_use",
} as const satisfies Record<StreamStopCause, string>;

/**
 * Name the cause in the operator- and caller-visible message, when the backend stated one.
 *
 * The generic sentence is PRESERVED as the prefix rather than replaced. It is what existing
 * operators, tests and log greps match on, and — more importantly — it remains TRUE: the stream did
 * complete without meaningful content. The cause is appended, so a reader who only needs "the
 * backend sent nothing usable" reads exactly what they read before, and a reader who needs to know
 * WHY no longer has to re-send the request outside the relay to find out.
 *
 * ⚠ The reasoning count is quoted only when the backend STATED it, and the wording distinguishes
 * "produced N reasoning tokens and no text" (measured) from "stopped at max_tokens with no text"
 * (the stop reason alone). `null` never becomes 0.
 */
export function describeStreamStopCause(classification: StreamDeadClassification): string {
  const stop = classification.stopReason;
  const tokens = classification.reasoningTokens;
  const reasoning = tokens === null
    ? ""
    : ` after ${tokens} reasoning token${tokens === 1 ? "" : "s"}`;

  if (stop === "max_tokens") {
    return `the backend stopped at max_tokens${reasoning} and no text`;
  }
  if (stop === "tool_use") {
    return `the backend stopped at a tool call${reasoning} with no text the relay could commit`;
  }
  // No modelled stop reason, but a stated reasoning count: still a measurement, and still worth
  // naming, because "it thought and then sent nothing" is the actionable half of the report.
  return tokens === null
    ? "the backend sent no text and stated no stop reason"
    : `the backend produced ${tokens} reasoning token${tokens === 1 ? "" : "s"} and no text`;
}

function nonWhitespace(value: unknown): boolean {
  return typeof value === "string" && value.trim().length > 0;
}

function substantive(value: unknown): boolean {
  if (nonWhitespace(value)) return true;
  if (typeof value === "number" || typeof value === "boolean") return true;
  if (Array.isArray(value)) return value.some(substantive);
  if (isRecord(value)) return Object.values(value).some(substantive);
  return false;
}

function substantiveFields(value: Record<string, unknown>, ignored: ReadonlySet<string>): boolean {
  return Object.entries(value).some(([key, field]) => !ignored.has(key) && substantive(field));
}

function boundedError(value: Record<string, unknown>): string {
  const error = isRecord(value.error) ? value.error : value;
  const message = typeof error.message === "string" ? error.message.trim().slice(0, 200) : "";
  return message ? `in-band error before meaningful content: ${message}` : "in-band error before meaningful content";
}

/**
 * An in-band error is the PROVIDER's by default, so it is retriable and the walk rerolls. An error
 * this relay authored is not: a dialect-rescue destructive refusal is a config decision, terminal
 * on the buffered lanes, and it must be terminal here too or the streamed pre-commit case would
 * quietly reroll the same refusal across the whole pool.
 *
 * ⚠ BOTH halves are required, and the SIGNAL is the load-bearing one. The code alone travels on
 * the wire, so an upstream can emit it — on an `anthropic`-kind target the dialect wrapper never
 * runs and every occurrence is the upstream's. Trusting the bytes let a counterparty mint `local`
 * for itself and thereby suppress failover AND escape breaker accounting. The signal is set only
 * by the wrapper that pushed the event, so it cannot be forged from the wire.
 */
function relayAuthored(value: Record<string, unknown>, signal: DialectRefusalSignal | undefined): boolean {
  if (!signal?.refused) return false;
  const error = isRecord(value.error) ? value.error : value;
  return error.type === DIALECT_REFUSED_DESTRUCTIVE_CODE || error.code === DIALECT_REFUSED_DESTRUCTIVE_CODE;
}

function errorVerdict(value: Record<string, unknown>, signal: DialectRefusalSignal | undefined): EventVerdict {
  if (!relayAuthored(value, signal)) {
    return { kind: "dead", reason: boundedError(value), provenance: "upstream" };
  }
  // The relay's own refusal, not an upstream in-band error. It keeps its own message (the
  // "in-band error before meaningful content" wrapper would misattribute it) and carries its code
  // out to the front, so a pre-commit refusal is announced like its buffered twin instead of
  // arriving as an anonymous `api_error`.
  const error = isRecord(value.error) ? value.error : value;
  const message = typeof error.message === "string" ? error.message.trim().slice(0, 200) : "";
  return {
    kind: "dead",
    reason: message || "refused a tool call recovered from text because it names a destructive tool",
    provenance: "local",
    errorType: DIALECT_REFUSED_DESTRUCTIVE_CODE,
  };
}

function anthropicBlockStartVerdict(block: Record<string, unknown>): EventVerdict {
  const blockType = typeof block.type === "string" ? block.type : "";
  if (blockType === "tool_use") {
    return nonWhitespace(block.id) || nonWhitespace(block.name) ? READY : HOLD;
  }
  if (blockType === "text") return nonWhitespace(block.text) ? READY : HOLD;
  if (blockType === "thinking") return nonWhitespace(block.thinking) ? READY : HOLD;
  // Redacted thinking and future opaque content blocks are output only when they carry an
  // actual payload; a type/index skeleton remains provisional.
  return substantiveFields(block, new Set(["type", "index"])) ? READY : HOLD;
}

function anthropicBlockDeltaVerdict(delta: Record<string, unknown>): EventVerdict {
  const deltaType = typeof delta.type === "string" ? delta.type : "";
  if (deltaType === "text_delta") return nonWhitespace(delta.text) ? READY : HOLD;
  if (deltaType === "thinking_delta") return nonWhitespace(delta.thinking) ? READY : HOLD;
  // Tool arguments follow a meaningful tool_use start. Signatures are metadata, not content.
  if (deltaType === "input_json_delta" || deltaType === "signature_delta") return HOLD;
  return substantiveFields(delta, new Set(["type", "index"])) ? READY : HOLD;
}

function anthropicVerdict(value: Record<string, unknown>, signal: DialectRefusalSignal | undefined): EventVerdict {
  const type = typeof value.type === "string" ? value.type : "";
  if (type === "error" || isRecord(value.error)) {
    return errorVerdict(value, signal);
  }

  if (type === "message_stop") {
    return { kind: "dead", reason: "stream completed without meaningful content", provenance: "upstream" };
  }

  if (type === "content_block_start") {
    return isRecord(value.content_block) ? anthropicBlockStartVerdict(value.content_block) : HOLD;
  }

  if (type === "content_block_delta") {
    return isRecord(value.delta) ? anthropicBlockDeltaVerdict(value.delta) : HOLD;
  }

  // Unknown future Anthropic content events are allowed to commit only when their content-shaped
  // payload is substantive. Metadata-only event records stay held.
  if (type.startsWith("content_block_")) {
    if (isRecord(value.content_block) && substantiveFields(value.content_block, new Set(["type", "index"]))) return READY;
    if (isRecord(value.delta) && substantiveFields(value.delta, new Set(["type", "index"]))) return READY;
  }
  return HOLD;
}

function chatToolCallMeaningful(value: unknown): boolean {
  if (!isRecord(value)) return false;
  if (nonWhitespace(value.id)) return true;
  if (!isRecord(value.function)) return false;
  return nonWhitespace(value.function.name) || nonWhitespace(value.function.arguments);
}

function openAiChatVerdict(value: Record<string, unknown>, signal: DialectRefusalSignal | undefined): EventVerdict {
  if (isRecord(value.error) || value.type === "error") {
    return errorVerdict(value, signal);
  }
  if (!Array.isArray(value.choices)) {
    return { kind: "dead", reason: "OpenAI stream event is missing choices", provenance: "upstream" };
  }
  if (value.choices.length === 0) return HOLD; // usage-only frame

  let finished = false;
  for (const rawChoice of value.choices) {
    if (!isRecord(rawChoice)) {
      return { kind: "dead", reason: "OpenAI stream choice is not an object", provenance: "upstream" };
    }
    if (rawChoice.finish_reason !== null && rawChoice.finish_reason !== undefined) finished = true;
    if (!isRecord(rawChoice.delta)) continue;
    const delta = rawChoice.delta;
    if (
      nonWhitespace(delta.content) ||
      nonWhitespace(delta.refusal) ||
      nonWhitespace(delta.reasoning_content) ||
      nonWhitespace(delta.reasoning)
    ) return READY;
    if (Array.isArray(delta.tool_calls) && delta.tool_calls.some(chatToolCallMeaningful)) return READY;
    if (substantiveFields(
      delta,
      new Set(["role", "content", "refusal", "reasoning_content", "reasoning", "tool_calls"]),
    )) return READY;
  }
  return finished
    ? { kind: "dead", reason: "stream completed without meaningful content", provenance: "upstream" }
    : HOLD;
}

function responsesItemMeaningful(value: unknown): boolean {
  if (!isRecord(value)) return false;
  const type = typeof value.type === "string" ? value.type : "";
  if (type === "function_call") {
    return nonWhitespace(value.id) || nonWhitespace(value.call_id) || nonWhitespace(value.name) || nonWhitespace(value.arguments);
  }
  if (type === "output_text" || type === "refusal" || type === "reasoning") {
    return nonWhitespace(value.text) || nonWhitespace(value.refusal) || substantive(value.content);
  }
  if (type === "message" && Array.isArray(value.content)) return value.content.some(responsesItemMeaningful);
  return substantiveFields(value, new Set(["type", "id", "status", "role", "index"]));
}

function openAiResponsesVerdict(value: Record<string, unknown>, signal: DialectRefusalSignal | undefined): EventVerdict {
  const type = typeof value.type === "string" ? value.type : "";
  if (type === "error" || type === "response.failed" || isRecord(value.error)) {
    return errorVerdict(value, signal);
  }
  if (type === "response.incomplete" || type === "response.cancelled") {
    return { kind: "dead", reason: `${type} before meaningful content`, provenance: "upstream" };
  }

  if (
    type === "response.output_text.delta" ||
    type === "response.refusal.delta" ||
    type === "response.reasoning.delta" ||
    type === "response.reasoning_text.delta"
  ) return nonWhitespace(value.delta) || nonWhitespace(value.text) ? READY : HOLD;

  if (type === "response.function_call_arguments.delta") return nonWhitespace(value.delta) ? READY : HOLD;

  if (type === "response.output_item.added" || type === "response.output_item.done") {
    return responsesItemMeaningful(value.item) ? READY : HOLD;
  }
  if (type === "response.content_part.added" || type === "response.content_part.done") {
    return responsesItemMeaningful(value.part) ? READY : HOLD;
  }

  if (type === "response.completed") {
    const response = isRecord(value.response) ? value.response : {};
    if (response.status === "failed" || response.status === "incomplete" || response.status === "cancelled") {
      return { kind: "dead", reason: "response completed unsuccessfully before meaningful content", provenance: "upstream" };
    }
    if (Array.isArray(response.output) && response.output.some(responsesItemMeaningful)) return READY;
    return { kind: "dead", reason: "stream completed without meaningful content", provenance: "upstream" };
  }

  if (type.endsWith(".delta")) {
    return substantiveFields(value, new Set(["type", "sequence_number", "output_index", "content_index", "item_id"]))
      ? READY
      : HOLD;
  }
  if (type.endsWith(".done")) {
    return nonWhitespace(value.text) || nonWhitespace(value.refusal) || responsesItemMeaningful(value.item) ? READY : HOLD;
  }
  return HOLD;
}

/**
 * Read whatever the parsed record STATES about how the turn ended, into `cause`.
 *
 * Called for EVERY parsed record, before the per-protocol verdict, and that placement is the whole
 * point: the events that state a stop reason are the ones that hold. A record whose verdict ends
 * the probe carries the cause on the verdict itself (see `EventVerdict`), so this is the silent
 * half — and it is the half that a `max_tokens`-with-reasoning-only stream depends on, because
 * every one of its frames holds until the final one.
 *
 * Reads a closed set of field names per protocol and never searches the payload for stop-shaped
 * values: a body that happens to contain the string `max_tokens` inside a tool argument is content,
 * not a statement by the backend.
 */
function observeStopCause(
  value: Record<string, unknown>,
  protocol: StreamCommitProtocol,
  cause: StopReasonAccumulator,
): void {
  const type = typeof value.type === "string" ? value.type : "";

  if (protocol === "anthropic-messages") {
    // `message_delta` is where Anthropic states the terminal stop_reason; `message_start` carries
    // the initial usage and the terminal one may carry an output-token tally.
    if (type === "message_delta") {
      cause.recordStop(value.delta && isRecord(value.delta) ? value.delta.stop_reason : undefined);
      if (isRecord(value.usage)) cause.recordUsage(value.usage);
    }
    const message = isRecord(value.message) ? value.message : undefined;
    if (message && isRecord(message.usage)) cause.recordUsage(message.usage);
    if (isRecord(value.usage)) cause.recordUsage(value.usage);
    return;
  }

  if (protocol === "openai-chat") {
    if (Array.isArray(value.choices)) {
      for (const choice of value.choices) {
        if (!isRecord(choice)) continue;
        cause.recordStop(choice.finish_reason);
        // DeepSeek and its peers report the reasoning share beside the completion count in a
        // `completion_tokens_details` object rather than flat on usage.
        if (isRecord(choice.usage)) cause.recordUsage(choice.usage);
      }
    }
    if (isRecord(value.usage)) {
      cause.recordUsage(value.usage);
      const details = value.usage.completion_tokens_details;
      if (isRecord(details)) cause.recordUsage(details);
    }
    return;
  }

  // openai-responses. The terminal status is a statement about the turn; `incomplete_details`
  // carries the reason, and the response's own usage object carries the token tally.
  if (isRecord(value.response)) {
    const response = value.response;
    const incomplete = isRecord(response.incomplete_details) ? response.incomplete_details.reason : undefined;
    cause.recordStop(incomplete);
    if (isRecord(response.usage)) {
      cause.recordUsage(response.usage);
      const details = response.usage.output_tokens_details;
      if (isRecord(details)) cause.recordUsage(details);
    }
    // No `end_turn` is recorded for a plainly-completed response: see `normalizeStopReason` for
    // why the ordinary completion sentinels are deliberately outside this vocabulary.
  }
  if (isRecord(value.usage)) cause.recordUsage(value.usage);
}

function classifyEvent(
  event: string,
  protocol: StreamCommitProtocol,
  malformedProvenance: "upstream" | "local",
  signal: DialectRefusalSignal | undefined,
  cause: StopReasonAccumulator,
): EventVerdict {
  const fields = sseEventFields(event);
  const eventName = fields.eventLines[0]?.trim() ?? "";
  const data = fields.dataLines
    .map((line) => line.replace(/^ /, ""))
    .join("\n")
    .trim();

  if (!data) return eventName === "error"
    ? { kind: "dead", reason: "in-band error before meaningful content", provenance: "upstream" }
    : HOLD;
  if (data === "[DONE]") {
    return { kind: "dead", reason: "stream completed without meaningful content", provenance: "upstream" };
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(data);
  } catch {
    return { kind: "dead", reason: "stream event before meaningful content is not valid JSON", provenance: malformedProvenance };
  }
  if (!isRecord(parsed)) {
    return { kind: "dead", reason: "stream event before meaningful content is not an object", provenance: malformedProvenance };
  }

  observeStopCause(parsed, protocol, cause);

  if (eventName === "error" && parsed.type !== "error" && !isRecord(parsed.error)) {
    return errorVerdict(parsed, signal);
  }

  switch (protocol) {
    case "anthropic-messages": return anthropicVerdict(parsed, signal);
    case "openai-chat": return openAiChatVerdict(parsed, signal);
    case "openai-responses": return openAiResponsesVerdict(parsed, signal);
  }
}

/**
 * Read through metadata-only SSE events until the final wire contains meaningful assistant output.
 * The returned stream replays the exact raw chunks and continues on the same locked reader.
 */
export async function probeStreamForCommit(
  body: ReadableStream<Uint8Array>,
  protocol: StreamCommitProtocol,
  options: StreamCommitProbeOptions = {},
): Promise<StreamCommitProbe> {
  const reader = body.getReader();
  const chunks: Uint8Array[] = [];
  const decoder = new TextDecoder();
  const malformedProvenance = options.malformedProvenance ?? "upstream";
  const readFailureProvenance = options.readFailureProvenance ?? "upstream";
  const relayRefusal = options.relayRefusal;
  const frames = new BufferedSseFrames();
  const cause = new StopReasonAccumulator();
  let inspectedBytes = 0;

  const isCancelled = (): boolean => options.isCancelled?.() ?? false;

  const cancelled = async (): Promise<StreamCommitProbe> => {
    await reader.cancel("client disconnected before stream commit").catch(() => {});
    return { kind: "cancelled" };
  };

  /**
   * Everything a dead verdict can say, assembled in ONE place.
   *
   * `reason` is upgraded with the backend's stated cause and the classification is attached, and
   * both happen here rather than at each `dead()` call site so no path can forget: the probe has
   * six ways to declare a stream dead and a seventh would otherwise be the one that stays silent.
   *
   * ⚠ The upgrade is applied to a dead verdict and NOT to the reason string of a `ready`/`cancelled`
   * probe, and `dead()` is the only constructor of the former. A local defect — a mapper that
   * emitted unparseable bytes — still carries whatever stop reason the backend stated, because the
   * two are independent facts about the same stream and a reader wants both.
   */
  const dead = async (
    reason: string,
    provenance: "upstream" | "local" = "upstream",
    errorType?: string,
  ): Promise<StreamCommitProbe> => {
    if (isCancelled()) return cancelled();
    const classification = cause.snapshot();
    const detailed = classification ? `${reason}: ${describeStreamStopCause(classification)}` : reason;
    await reader.cancel(detailed).catch(() => {});
    return {
      kind: "dead",
      reason: detailed,
      provenance,
      ...(errorType ? { errorType } : {}),
      ...(classification ? { classification } : {}),
    };
  };

  const ready = (): StreamCommitProbe => {
    let prefixIndex = 0;
    return {
      kind: "ready",
      body: new ReadableStream<Uint8Array>({
        async pull(controller) {
          if (prefixIndex < chunks.length) {
            controller.enqueue(chunks[prefixIndex++]!);
            return;
          }
          try {
            const next = await reader.read();
            if (next.done) controller.close();
            else controller.enqueue(next.value);
          } catch (error) {
            controller.error(error);
          }
        },
        async cancel(reason) {
          await reader.cancel(reason).catch(() => {});
        },
      }),
    };
  };

  /**
   * Walk the buffered frames, and — this is the load-bearing part — keep OBSERVING after a verdict
   * has been reached.
   *
   * The frames that end a stream and the frames that explain it are siblings in the same buffer and
   * arrive in either order. Measured: a Chat stream sends `finish_reason: "length"` and then a
   * separate usage-only frame carrying `completion_tokens_details.reasoning_tokens`, and an
   * Anthropic stream sends `message_stop` after the `message_delta` that stated the reason. Stopping
   * the walk at the first non-hold verdict — which is what this used to do — therefore threw away
   * the very frame the backlog entry exists to read, and the `max_tokens` case would have reported
   * its stop reason with no token count beside it.
   *
   * So the verdict is REMEMBERED and the walk continues to the end of what is already buffered; the
   * first non-hold verdict still wins, because it is what the probe returns and no later event may
   * revise it. Only the CAUSE is allowed to be enriched by the tail, and only from frames that had
   * already arrived.
   */
  const drainFrames = (): EventVerdict => {
    let verdict: EventVerdict = HOLD;
    for (const { frame: event } of frames) {
      const next = classifyEvent(event, protocol, malformedProvenance, relayRefusal, cause);
      if (verdict.kind === "hold" && next.kind !== "hold") verdict = next;
    }
    return verdict;
  };

  const inspectCompleteEvents = (final = false): EventVerdict => {
    const verdict = drainFrames();
    // A final verdict has already ended the probe; the remainder is still worth reading for the
    // cause when the terminal frame itself stated nothing.
    if (verdict.kind !== "hold") {
      if (final) drainRemainderForCause();
      return verdict;
    }
    if (final) {
      const event = frames.takeRemainder();
      if (event.trim().length === 0) return HOLD;
      return classifyEvent(event, protocol, malformedProvenance, relayRefusal, cause);
    }
    return HOLD;
  };

  /** Read the un-terminated tail for a stated cause only; it cannot change the verdict. */
  const drainRemainderForCause = (): void => {
    const event = frames.takeRemainder();
    if (event.trim().length === 0) return;
    classifyEvent(event, protocol, malformedProvenance, relayRefusal, cause);
  };

  while (inspectedBytes < STREAM_PREFLIGHT_LIMIT) {
    let next: Awaited<ReturnType<typeof reader.read>>;
    try {
      next = await reader.read();
    } catch {
      if (isCancelled()) return cancelled();
      return dead("stream failed before meaningful content", readFailureProvenance);
    }

    if (isCancelled()) return cancelled();
    if (next.done) {
      frames.append(decoder.decode());
      const verdict = inspectCompleteEvents(true);
      if (verdict.kind === "ready") return ready();
      if (verdict.kind === "dead") return dead(verdict.reason, verdict.provenance, verdict.errorType);
      return dead("stream ended before meaningful content");
    }

    chunks.push(next.value);
    const remaining = STREAM_PREFLIGHT_LIMIT - inspectedBytes;
    const inspectBytes = next.value.byteLength > remaining ? next.value.subarray(0, remaining) : next.value;
    inspectedBytes += inspectBytes.byteLength;
    frames.append(decoder.decode(inspectBytes, { stream: true }));

    const verdict = inspectCompleteEvents();
    if (verdict.kind === "ready") return isCancelled() ? cancelled() : ready();
    if (verdict.kind === "dead") return dead(verdict.reason, verdict.provenance, verdict.errorType);
    if (next.value.byteLength > inspectBytes.byteLength) {
      return dead("no meaningful content within commit probe limit");
    }
  }

  return dead("no meaningful content within commit probe limit");
}
