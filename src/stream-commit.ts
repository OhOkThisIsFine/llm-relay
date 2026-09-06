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

function classifyEvent(
  event: string,
  protocol: StreamCommitProtocol,
  malformedProvenance: "upstream" | "local",
  signal: DialectRefusalSignal | undefined,
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
  let inspectedBytes = 0;

  const isCancelled = (): boolean => options.isCancelled?.() ?? false;

  const cancelled = async (): Promise<StreamCommitProbe> => {
    await reader.cancel("client disconnected before stream commit").catch(() => {});
    return { kind: "cancelled" };
  };

  const dead = async (
    reason: string,
    provenance: "upstream" | "local" = "upstream",
    errorType?: string,
  ): Promise<StreamCommitProbe> => {
    if (isCancelled()) return cancelled();
    await reader.cancel(reason).catch(() => {});
    return { kind: "dead", reason, provenance, ...(errorType ? { errorType } : {}) };
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

  const inspectCompleteEvents = (final = false): EventVerdict => {
    for (const { frame: event } of frames) {
      const verdict = classifyEvent(event, protocol, malformedProvenance, relayRefusal);
      if (verdict.kind !== "hold") return verdict;
    }
    if (final) {
      const event = frames.takeRemainder();
      if (event.trim().length === 0) return HOLD;
      return classifyEvent(event, protocol, malformedProvenance, relayRefusal);
    }
    return HOLD;
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
