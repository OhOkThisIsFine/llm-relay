/**
 * Did a provider stream open with a usable response, and what did it say it was?
 *
 * Moved out of `backend.ts` unchanged (HOTSPOT-10). The bodies below are byte-identical to the
 * ones that lived there; only the three names `backend.ts` still calls became exports.
 *
 * Two jobs, kept together because the preflight performs both in one pass over the same bytes:
 *
 * - **Preflight.** Read up to `STREAM_PREFLIGHT_LIMIT` bytes looking for the first data event,
 *   validate it, then REPLAY every consumed byte to the consumer. A stream that opens with an
 *   in-band error is a dead turn, so failing it here is what lets the candidate walk reach a
 *   member that answers instead of spending the pool inside one member's 200.
 * - **Provenance.** Record what the upstream called itself, so a served response can be logged
 *   against the model that actually answered rather than the one that was routed to.
 *
 * ⚠ The metadata is process-local, never a wire header. It is declared here because the preflight
 * is what fills it; `backend.ts` keeps the `WeakMap` that binds it to a `Response`.
 *
 * ⚠ Nothing here imports `backend.js`, and nothing may. This module sits beneath the transport it
 * probes for, exactly like `envelope-validator.ts` beside it.
 */

import { isRecord } from "../json-shape.js";
import { STREAM_PREFLIGHT_LIMIT } from "../stream-commit.js";
import { invalidEnvelopeReason, type ResponseProtocol } from "./envelope-validator.js";

export interface UpstreamResponseMetadata {
  reportedModel?: string;
  /**
   * How many `tool_use` ids the relay had to mint for this response (`tool-use-ids.ts`). Mutable
   * after the Response exists on purpose: on a stream the pass runs while the body drains, and the
   * server reads this where it reports end-of-stream facts. A count, never an id.
   */
  toolUseIdRewrites?: number;
  /**
   * How many OUTBOUND tool-call ids the request mapper rewrote to this provider's stated shape
   * (`openai-request.ts`, `compat.toolCallIds: "strict9"`). A count, never an id. Known before
   * egress, so it is set once when the metadata is built.
   */
  toolCallIdRewrites?: number;
  /**
   * How many replayed tool calls the request mapper stamped with gemini's documented
   * thought-signature sentinel (`openai-request.ts`, `compat.thoughtSignature: "sentinel"`). A
   * count, never a signature. Known before egress, like `toolCallIdRewrites`.
   *
   * Deliberately NOT announced as a response header: this one adds vendor-protocol padding to the
   * relay's own outbound shape and changes nothing about the caller's data, so the operator sees
   * it in the log and the client is told nothing it could act on.
   */
  thoughtSignatureSentinels?: number;
}

type StreamPreflight =
  | { ok: true; body: ReadableStream<Uint8Array>; metadata: UpstreamResponseMetadata }
  | { ok: false; reason: string };

export function captureReportedModel(
  metadata: UpstreamResponseMetadata,
  value: unknown,
  protocol: ResponseProtocol,
  streamed: boolean,
): void {
  if (metadata.reportedModel !== undefined || !isRecord(value)) return;
  const envelope = protocol === "anthropic-messages" && streamed && value.type === "message_start"
    ? value.message
    : value;
  if (isRecord(envelope) && typeof envelope.model === "string") {
    metadata.reportedModel = envelope.model;
  }
}

/** Inspect the first data event before handing a provider stream to llm-bridge. */
export async function preflightResponseStream(
  body: ReadableStream<Uint8Array>,
  protocol: ResponseProtocol,
): Promise<StreamPreflight> {
  const reader = body.getReader();
  const chunks: Uint8Array[] = [];
  const decoder = new TextDecoder();
  const metadata: UpstreamResponseMetadata = {};
  let buffered = "";
  let byteLength = 0;

  const captureCompleteEvents = (final = false): void => {
    let boundary: RegExpExecArray | null;
    const separator = /\r?\n\r?\n/g;
    while ((boundary = separator.exec(buffered)) !== null) {
      const event = buffered.slice(0, boundary.index);
      buffered = buffered.slice(boundary.index + boundary[0].length);
      separator.lastIndex = 0;
      captureEventModel(event);
    }
    if (final && buffered.trim()) captureEventModel(buffered);
  };

  const replay = (): StreamPreflight => {
    let prefixIndex = 0;
    // The first valid event can be a ping. Keep observing the untouched raw
    // stream while the consumer drains it so a later message_start/chunk can
    // still supply the upstream's model before terminal logging.
    captureCompleteEvents();
    return { ok: true, metadata, body: new ReadableStream<Uint8Array>({
      async pull(controller) {
        if (prefixIndex < chunks.length) {
          controller.enqueue(chunks[prefixIndex++]!);
          return;
        }
        try {
          const more = await reader.read();
          if (more.done) {
            buffered += decoder.decode();
            captureCompleteEvents(true);
            controller.close();
          } else {
            buffered += decoder.decode(more.value, { stream: true });
            captureCompleteEvents();
            controller.enqueue(more.value);
          }
        } catch (error) {
          controller.error(error);
        }
      },
      async cancel(reasonToCancel) {
        await reader.cancel(reasonToCancel).catch(() => {});
      },
    }) };
  };

  const fail = async (reason: string): Promise<StreamPreflight> => {
    await reader.cancel().catch(() => {});
    return { ok: false, reason };
  };

  const inspectEvent = (event: string): string | null | undefined => {
    const data = event
      .split(/\r?\n/)
      .filter((line) => line.startsWith("data:"))
      .map((line) => line.slice(5).trimStart())
      .join("\n")
      .trim();
    if (!data) return undefined;
    if (data === "[DONE]") return "stream ended before a response event";
    let parsed: unknown;
    try {
      parsed = JSON.parse(data);
    } catch {
      return "data event is not valid JSON";
    }
    captureReportedModel(metadata, parsed, protocol, true);
    return invalidEnvelopeReason(parsed, protocol, true);
  };

  const captureEventModel = (event: string): void => {
    const data = event
      .split(/\r?\n/)
      .filter((line) => line.startsWith("data:"))
      .map((line) => line.slice(5).trimStart())
      .join("\n")
      .trim();
    if (!data || data === "[DONE]") return;
    try {
      captureReportedModel(metadata, JSON.parse(data), protocol, true);
    } catch {
      // Preflight owns envelope validity; this observer owns provenance only.
    }
  };

  while (byteLength <= STREAM_PREFLIGHT_LIMIT) {
    const next = await reader.read().catch(() => null);
    if (next === null) return fail("stream failed during preflight");
    if (next.done) {
      buffered += decoder.decode();
      let finalReason = buffered.trim() ? inspectEvent(buffered) : undefined;
      // A few compatible providers ignore `stream: true` and return one valid buffered
      // completion. Preserve the old adapter behaviour for that genuine envelope.
      if (finalReason === undefined && buffered.trim()) {
        try {
          const parsed = JSON.parse(buffered);
          captureReportedModel(metadata, parsed, protocol, false);
          finalReason = invalidEnvelopeReason(parsed, protocol, false);
        } catch {
          // The SSE-specific reason below remains more useful.
        }
      }
      if (finalReason === null) return replay();
      return fail(finalReason ?? "stream ended before a response event");
    }
    chunks.push(next.value);
    byteLength += next.value.byteLength;
    if (byteLength > STREAM_PREFLIGHT_LIMIT) return fail("no response event within preflight limit");
    buffered += decoder.decode(next.value, { stream: true });

    let boundary: RegExpExecArray | null;
    const separator = /\r?\n\r?\n/g;
    while ((boundary = separator.exec(buffered)) !== null) {
      const event = buffered.slice(0, boundary.index);
      buffered = buffered.slice(boundary.index + boundary[0].length);
      separator.lastIndex = 0;
      const reason = inspectEvent(event);
      if (reason === undefined) continue;
      if (reason !== null) return fail(reason);

      return replay();
    }
  }

  return fail("no response event within preflight limit");
}
