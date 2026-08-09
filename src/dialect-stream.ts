import { emitSseTail } from "./emitSse.js";
import type { AssistantMessage, ContentBlock } from "./anthropic.js";
import { markerStart, recoverToolCalls, scanForMarker } from "./tool-dialects.js";

/**
 * Dialect recovery for the STREAMING path.
 *
 * The buffered mapper (`openAiResponseToAnthropic`) recovers a tool call a host returned as text,
 * but the SSE path never reaches it — and the measured failure was a stream TAIL (70 bytes of
 * closing tags from a CLI that streams), so the buffered fix alone did not cover the incident that
 * motivated it. See docs/tool-call-dialect-leak.md.
 *
 * Shape mirrors `repairStreamingPath`: stream text through, then withhold from the first sign of an
 * envelope. Here the trigger is a dialect marker rather than a `tool_use` block, and `scanForMarker`
 * supplies the holdback so a marker split across deltas is never half-emitted.
 *
 * ⚠ Bounded holdback, not whole-response buffering. Prose containing `<` lags by at most the longest
 * marker and keeps streaming — buffering every tool-bearing request would trade this bug for a
 * latency regression on all pool traffic.
 */

type Push = (chunk: string) => void;

interface SseEvent {
  raw: string;
  type: string;
  data: Record<string, unknown> | null;
}

function parseEvent(block: string): SseEvent | null {
  if (!block.trim()) return null;
  let type = "";
  const dataLines: string[] = [];
  for (const line of block.split("\n")) {
    if (line.startsWith("event:")) type = line.slice(6).trim();
    else if (line.startsWith("data:")) dataLines.push(line.slice(5).trim());
  }
  if (dataLines.length === 0) return { raw: block, type, data: null };
  try {
    return { raw: block, type, data: JSON.parse(dataLines.join("\n")) as Record<string, unknown> };
  } catch {
    return { raw: block, type, data: null };
  }
}

/** A block index high enough that placeholders never collide with real content. */
function placeholders(count: number): ContentBlock[] {
  return Array.from({ length: count }, () => ({ type: "text", text: "" }) as ContentBlock);
}

/**
 * Wrap an Anthropic SSE stream so a tool-call envelope arriving as TEXT becomes real `tool_use`
 * blocks. `schemas` types the recovered parameters; without it they stay strings and the validator
 * reports the type error, which is the correct visible failure rather than a silent coercion.
 */
export function recoverDialectInStream(
  upstream: ReadableStream<Uint8Array>,
  schemas: Map<string, { type?: unknown; properties?: Record<string, { type?: unknown }> }>,
): ReadableStream<Uint8Array> {
  const decoder = new TextDecoder();
  const encoder = new TextEncoder();

  let buffered = "";       // incomplete SSE tail between chunks
  let blockIndex = 0;      // index of the content block currently open
  let blockText = "";      // full text seen for the open block
  let emittedLen = 0;      // how much of blockText has been forwarded
  let capturing = false;   // an envelope has landed; withhold everything after it
  let envelope = "";       // the captured envelope text
  let messageDeltaSeen: Record<string, unknown> | null = null;

  return new ReadableStream<Uint8Array>({
    async start(controller) {
      const push: Push = (s) => controller.enqueue(encoder.encode(s));
      const reader = upstream.getReader();

      const finish = () => {
        if (!capturing) {
          // Flush any holdback that never became a marker.
          if (blockText.length > emittedLen) {
            push(sseDelta(blockIndex, blockText.slice(emittedLen)));
            emittedLen = blockText.length;
          }
          return;
        }

        const out = recoverToolCalls(envelope, schemas);
        if (out.status === "parsed") {
          // Close the text block we withheld from, then emit the recovered calls as the tail.
          push(sseEvent("content_block_stop", { index: blockIndex }));
          const content: ContentBlock[] = [...placeholders(blockIndex + 1)];
          if (out.text.length > 0) content.push({ type: "text", text: out.text } as ContentBlock);
          for (const [i, c] of out.calls.entries()) {
            content.push({ type: "tool_use", id: `tu_recovered_${i}`, name: c.name, input: c.input } as ContentBlock);
          }
          const msg: AssistantMessage = {
            content,
            stop_reason: "tool_use",
            stop_sequence: null,
            ...(messageDeltaSeen?.usage ? { usage: messageDeltaSeen.usage as AssistantMessage["usage"] } : {}),
          } as AssistantMessage;
          push(emitSseTail(msg, blockIndex + 1));
          return;
        }

        // Detected but unparseable — truncated, or a variant we do not model. Fail clean MID-STREAM
        // rather than releasing the fragment: the client cannot tell a broken tool-call tail from a
        // final answer, which is precisely what made this read as "the job died". CLAUDE.md's rule
        // for an unrepairable call is a 502 or a mid-stream SSE error; the headers are long gone
        // here, so it is the error event.
        const dialect = out.status === "detected" ? out.dialect : "unknown";
        push(sseEvent("error", {
          error: {
            type: "api_error",
            message: `llm-relay: backend returned an unparseable ${dialect} tool-call envelope as text`,
          },
        }));
      };

      try {
        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          buffered += decoder.decode(value, { stream: true });

          let sep: number;
          while ((sep = buffered.indexOf("\n\n")) >= 0) {
            const block = buffered.slice(0, sep);
            buffered = buffered.slice(sep + 2);
            const ev = parseEvent(block);
            if (!ev) continue;

            if (ev.type === "content_block_start") {
              blockIndex = typeof ev.data?.index === "number" ? ev.data.index : blockIndex;
              blockText = "";
              emittedLen = 0;
              push(block + "\n\n");
              continue;
            }

            if (ev.type === "content_block_delta" && !capturing) {
              const delta = ev.data?.delta as { type?: string; text?: string } | undefined;
              if (delta?.type === "text_delta" && typeof delta.text === "string") {
                blockText += delta.text;
                const { safeLen, hit } = scanForMarker(blockText);
                if (hit) {
                  const start = markerStart(blockText);
                  // The holdback guarantees we never emitted into the envelope.
                  if (start > emittedLen) {
                    push(sseDelta(blockIndex, blockText.slice(emittedLen, start)));
                    emittedLen = start;
                  }
                  capturing = true;
                  envelope = blockText.slice(emittedLen);
                } else if (safeLen > emittedLen) {
                  push(sseDelta(blockIndex, blockText.slice(emittedLen, safeLen)));
                  emittedLen = safeLen;
                }
                continue; // never forward the original delta — we re-emit what is safe
              }
              push(block + "\n\n");
              continue;
            }

            if (ev.type === "content_block_delta" && capturing) {
              const delta = ev.data?.delta as { type?: string; text?: string } | undefined;
              if (delta?.type === "text_delta" && typeof delta.text === "string") {
                blockText += delta.text;
                envelope += delta.text;
                continue; // withheld
              }
              push(block + "\n\n");
              continue;
            }

            if (ev.type === "content_block_stop") {
              if (capturing) continue; // we close it ourselves in finish()
              if (blockText.length > emittedLen) {
                push(sseDelta(blockIndex, blockText.slice(emittedLen)));
                emittedLen = blockText.length;
              }
              push(block + "\n\n");
              continue;
            }

            if (ev.type === "message_delta") {
              messageDeltaSeen = ev.data;
              if (capturing) continue; // superseded by the tail
              push(block + "\n\n");
              continue;
            }

            if (ev.type === "message_stop") {
              finish();
              if (!capturing) push(block + "\n\n");
              continue;
            }

            push(block + "\n\n");
          }
        }
        // Stream ended without message_stop (a truncated upstream) — still settle what we hold.
        if (capturing) finish();
      } catch (e) {
        push(sseEvent("error", {
          error: { type: "api_error", message: `llm-relay: stream failed: ${(e as Error).message}` },
        }));
      } finally {
        controller.close();
      }
    },
  });
}

function sseEvent(type: string, data: object): string {
  return `event: ${type}\ndata: ${JSON.stringify({ type, ...data })}\n\n`;
}

function sseDelta(index: number, text: string): string {
  return sseEvent("content_block_delta", { index, delta: { type: "text_delta", text } });
}
