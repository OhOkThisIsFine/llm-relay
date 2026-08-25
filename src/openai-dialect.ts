import type { JsonSchema } from "./anthropic.js";
import { STREAM_PREFLIGHT_LIMIT } from "./stream-commit.js";
import { DIALECT_REFUSED_DESTRUCTIVE_CODE, describeRefused, markerStart, recoverToolCalls, scanForMarker, type DialectRefusalSignal } from "./tool-dialects.js";

/** Result of inspecting a buffered native Chat completion for leaked dialect text. */
export type OpenAiChatDialectOutcome =
  | { status: "none" }
  | { status: "parsed"; body: Record<string, unknown>; dialect: string }
  | { status: "detected"; dialect: string }
  /** A recovered call names a tool on the operator's destructive list — refused, never committed. */
  | { status: "refused-destructive"; dialect: string; refused: string[] };

type ToolSchemas = Map<string, JsonSchema | null>;

export interface RecoveredOpenAiChat {
  text: string;
  calls: Array<{ id: string; name: string; input: Record<string, unknown> }>;
}

/** Optional production seam: validate/repair reconstructed calls before any native bytes emit. */
export type RecoveredOpenAiChatProcessor = (
  recovered: RecoveredOpenAiChat,
) => Promise<RecoveredOpenAiChat>;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function recoverySchemas(schemas: ToolSchemas): Map<string, JsonSchema> {
  return new Map([...schemas].filter((entry): entry is [string, JsonSchema] => entry[1] !== null));
}

function nativeToolCalls(
  calls: RecoveredOpenAiChat["calls"],
): Array<Record<string, unknown>> {
  return calls.map((call) => ({
    id: call.id,
    type: "function",
    function: { name: call.name, arguments: JSON.stringify(call.input) },
  }));
}

function recoveredValue(
  outcome: Extract<ReturnType<typeof recoverToolCalls>, { status: "parsed" }>,
  choiceIndex: number,
): RecoveredOpenAiChat {
  return {
    text: outcome.text,
    calls: outcome.calls.map((call, index) => ({
      id: `call_recovered_${choiceIndex}_${index}`,
      name: call.name,
      input: call.input,
    })),
  };
}

/**
 * Recover leaked tool-call text in an otherwise valid, buffered OpenAI Chat completion.
 *
 * Existing native `tool_calls` always win. Recovery is parsing only: the closed marker vocabulary
 * and coercion rules remain owned by `tool-dialects.ts`, and an unparseable marker is reported to
 * the caller so it can fail the candidate cleanly.
 */
export async function inspectDialectInOpenAiChat(
  input: Record<string, unknown>,
  schemas: ToolSchemas,
  isDestructive: (name: string) => boolean,
  processRecovered?: RecoveredOpenAiChatProcessor,
): Promise<OpenAiChatDialectOutcome> {
  if (schemas.size === 0 || !Array.isArray(input.choices)) return { status: "none" };

  const typedSchemas = recoverySchemas(schemas);
  let recoveredDialect: string | null = null;
  const choices = [...input.choices];
  const pending: Array<{
    choicePosition: number;
    rawChoice: Record<string, unknown>;
    message: Record<string, unknown>;
    choiceIndex: number;
    outcome: Extract<ReturnType<typeof recoverToolCalls>, { status: "parsed" }>;
  }> = [];
  for (const [choicePosition, rawChoice] of choices.entries()) {
    if (!isRecord(rawChoice) || !isRecord(rawChoice.message)) continue;
    const message = rawChoice.message;
    if (Array.isArray(message.tool_calls) && message.tool_calls.length > 0) continue;
    if (typeof message.content !== "string" || message.content.length === 0) continue;

    const outcome = recoverToolCalls(message.content, typedSchemas, isDestructive);
    if (outcome.status === "detected") return { status: "detected", dialect: outcome.dialect };
    // Refuse the WHOLE completion, and refuse it here — before the `pending` loop spends a
    // reshaper call on any choice. Same ordering reason as the detected branch: one unusable
    // choice makes the completion unusable, so nothing downstream may run first.
    if (outcome.status === "refused-destructive") {
      return { status: "refused-destructive", dialect: outcome.dialect, refused: outcome.refused };
    }
    if (outcome.status === "none") continue;

    recoveredDialect ??= outcome.dialect;
    const choiceIndex = typeof rawChoice.index === "number" ? rawChoice.index : choicePosition;
    pending.push({ choicePosition, rawChoice, message, choiceIndex, outcome });
  }

  // Do not invoke validation/repair for one choice until every choice is known parseable. A later
  // truncated choice makes the whole completion unusable and must not spend a reshaper call first.
  for (const { choicePosition, rawChoice, message, choiceIndex, outcome } of pending) {
    const recovered = processRecovered
      ? await processRecovered(recoveredValue(outcome, choiceIndex))
      : recoveredValue(outcome, choiceIndex);
    choices[choicePosition] = {
      ...rawChoice,
      finish_reason: "tool_calls",
      message: {
        ...message,
        content: recovered.text.length > 0 ? recovered.text : null,
        tool_calls: nativeToolCalls(recovered.calls),
      },
    };
  }

  return recoveredDialect
    ? { status: "parsed", body: { ...input, choices }, dialect: recoveredDialect }
    : { status: "none" };
}

interface ParsedSseEvent {
  raw: string;
  eventName: string;
  data: Record<string, unknown> | "[DONE]" | null;
}

interface ChoiceState {
  text: string;
  emittedLen: number;
  capturing: boolean;
  envelope: string;
  finished: boolean;
  lastChunk: Record<string, unknown> | null;
  lastChoice: Record<string, unknown> | null;
}

function choiceState(): ChoiceState {
  return {
    text: "",
    emittedLen: 0,
    capturing: false,
    envelope: "",
    finished: false,
    lastChunk: null,
    lastChoice: null,
  };
}

function firstBoundary(value: string): { index: number; length: number } | null {
  const match = /\r?\n\r?\n/.exec(value);
  return match ? { index: match.index, length: match[0].length } : null;
}

function parseEvent(raw: string): ParsedSseEvent {
  const lines = raw.split(/\r?\n/);
  const eventName = lines.find((line) => line.startsWith("event:"))?.slice(6).trim() ?? "";
  const data = lines
    .filter((line) => line.startsWith("data:"))
    .map((line) => line.slice(5).replace(/^ /, ""))
    .join("\n")
    .trim();
  if (!data) return { raw, eventName, data: null };
  if (data === "[DONE]") return { raw, eventName, data: "[DONE]" };
  try {
    const parsed = JSON.parse(data) as unknown;
    return { raw, eventName, data: isRecord(parsed) ? parsed : null };
  } catch {
    return { raw, eventName, data: null };
  }
}

function encodeEvent(eventName: string, data: Record<string, unknown> | "[DONE]"): string {
  const prefix = eventName ? `event: ${eventName}\n` : "";
  return `${prefix}data: ${data === "[DONE]" ? data : JSON.stringify(data)}\n\n`;
}

function withChoices(template: Record<string, unknown>, choices: unknown[]): Record<string, unknown> {
  return { ...template, choices };
}

function withContent(choice: Record<string, unknown>, content: string): Record<string, unknown> {
  const delta = isRecord(choice.delta) ? choice.delta : {};
  return { ...choice, delta: { ...delta, content } };
}

function withoutContent(choice: Record<string, unknown>): Record<string, unknown> | null {
  if (!isRecord(choice.delta)) return choice;
  const { content: _content, ...delta } = choice.delta;
  const hasOtherDelta = Object.keys(delta).length > 0;
  const hasFinish = choice.finish_reason !== null && choice.finish_reason !== undefined;
  return hasOtherDelta || hasFinish ? { ...choice, delta } : null;
}

/**
 * `type` defaults to `upstream_error` because that is what an in-band stream failure normally is.
 * A relay-authored refusal passes its own type so the commit probe reads it as LOCAL and the walk
 * does not reroll a decision the relay already made.
 */
function errorEvent(message: string, code: string, type = "upstream_error"): string {
  return encodeEvent("", {
    error: {
      message,
      type,
      code,
    },
  });
}

function recoveredEvents(
  template: Record<string, unknown>,
  choice: Record<string, unknown>,
  recovered: RecoveredOpenAiChat,
  eventName: string,
): string[] {
  const chunks: string[] = [];
  if (recovered.text.length > 0) {
    chunks.push(encodeEvent(eventName, withChoices(template, [withContent(choice, recovered.text)])));
  }
  chunks.push(encodeEvent(eventName, withChoices(template, [{
    ...choice,
    finish_reason: null,
    delta: {
      tool_calls: nativeToolCalls(recovered.calls).map((call, index) => ({ index, ...call })),
    },
  }])));
  chunks.push(encodeEvent(eventName, withChoices(template, [{
    ...choice,
    finish_reason: "tool_calls",
    delta: {},
  }])));
  return chunks;
}

/**
 * Native OpenAI Chat streaming dialect adapter.
 *
 * Text is re-emitted only up to `scanForMarker().safeLen`, so a marker split across deltas never
 * leaks a prefix. Once a marker lands, the envelope is withheld until it can become native Chat
 * `tool_calls`; a detected-but-unparseable envelope becomes an OpenAI error frame. The outer
 * final-wire commit probe then decides whether that error is still an invisible failover or an
 * honest post-commit stream error.
 */
export function recoverDialectInOpenAiChatStream(
  upstream: ReadableStream<Uint8Array>,
  schemas: ToolSchemas,
  isDestructive: (name: string) => boolean,
  onRecovered: (dialect: string) => void = () => {},
  processRecovered?: RecoveredOpenAiChatProcessor,
  refusalSignal?: DialectRefusalSignal,
): ReadableStream<Uint8Array> {
  if (schemas.size === 0) return upstream;

  const decoder = new TextDecoder();
  const encoder = new TextEncoder();
  const typedSchemas = recoverySchemas(schemas);
  const states = new Map<number, ChoiceState>();
  let buffered = "";
  let lastEventName = "";
  let terminated = false;
  let cancelled = false;
  let sawDone = false;
  let activeReader: ReadableStreamDefaultReader<Uint8Array> | null = null;

  return new ReadableStream<Uint8Array>({
    async start(controller) {
      const reader = upstream.getReader();
      activeReader = reader;
      const push = (value: string) => controller.enqueue(encoder.encode(value));
      const stateFor = (index: number): ChoiceState => {
        let state = states.get(index);
        if (!state) {
          state = choiceState();
          states.set(index, state);
        }
        return state;
      };

      const fail = async (message: string, code: string, type?: string) => {
        if (terminated) return;
        terminated = true;
        push(type === undefined ? errorEvent(message, code) : errorEvent(message, code, type));
        await reader.cancel(message).catch(() => {});
      };

      const settleChoice = async (
        index: number,
        state: ChoiceState,
        eventName: string,
      ): Promise<string[]> => {
        if (state.finished) return [];
        state.finished = true;
        if (!state.capturing) {
          const tail = state.text.slice(state.emittedLen);
          state.emittedLen = state.text.length;
          if (!tail || !state.lastChunk || !state.lastChoice) return [];
          return [encodeEvent(eventName, withChoices(state.lastChunk, [withContent(state.lastChoice, tail)]))];
        }

        const outcome = recoverToolCalls(state.envelope, typedSchemas, isDestructive);
        if (outcome.status === "refused-destructive") {
          // Declared provenance — see `DialectRefusalSignal`. The wire code alone is forgeable.
          if (refusalSignal) refusalSignal.refused = true;
          // Headers are already flushed here, so the refusal travels as the mid-stream error event
          // — the shape the unparseable case uses, with its own code. Refused whole: the surviving
          // calls are not committed, because dropping one silently changes the model's intent.
          await fail(
            `llm-relay: refused a ${outcome.dialect} tool call recovered from text because it names a destructive tool: ${describeRefused(outcome.refused)}`,
            DIALECT_REFUSED_DESTRUCTIVE_CODE,
            DIALECT_REFUSED_DESTRUCTIVE_CODE,
          );
          return [];
        }
        if (outcome.status !== "parsed") {
          const dialect = outcome.status === "detected" ? outcome.dialect : "unknown";
          await fail(
            `llm-relay: backend returned an unparseable ${dialect} tool-call envelope as text`,
            "tool_dialect_unparseable",
          );
          return [];
        }
        let recovered = recoveredValue(outcome, index);
        try {
          if (processRecovered) recovered = await processRecovered(recovered);
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          await fail(`llm-relay: ${message}`, "tool_call_recovery_failed");
          return [];
        }
        onRecovered(outcome.dialect);
        if (!state.lastChunk || !state.lastChoice) return [];
        return recoveredEvents(state.lastChunk, state.lastChoice, recovered, eventName);
      };

      const processEvent = async (raw: string): Promise<void> => {
        if (terminated) return;
        const event = parseEvent(raw);
        lastEventName = event.eventName || lastEventName;
        if (event.data === null) {
          push(event.raw);
          return;
        }
        if (event.data === "[DONE]") {
          sawDone = true;
          for (const [index, state] of states) {
            for (const generated of await settleChoice(index, state, event.eventName)) push(generated);
            if (terminated) return;
          }
          push(event.raw);
          return;
        }
        if (isRecord(event.data.error) || !Array.isArray(event.data.choices) || event.data.choices.length === 0) {
          push(event.raw);
          return;
        }

        let modified = false;
        const outputChoices: unknown[] = [];
        const generatedBefore: string[] = [];
        const generatedAfter: string[] = [];

        for (const [position, rawChoice] of event.data.choices.entries()) {
          if (!isRecord(rawChoice)) {
            outputChoices.push(rawChoice);
            continue;
          }
          const index = typeof rawChoice.index === "number" ? rawChoice.index : position;
          const state = stateFor(index);
          state.lastChunk = event.data;
          state.lastChoice = rawChoice;
          const delta = isRecord(rawChoice.delta) ? rawChoice.delta : null;
          const content = typeof delta?.content === "string" ? delta.content : null;

          if (content !== null && !state.finished) {
            const previousLength = state.text.length;
            state.text += content;
            if (state.capturing) {
              state.envelope += content;
              modified = true;
              const residual = withoutContent(rawChoice);
              if (residual) outputChoices.push(residual);
            } else {
              const { safeLen, hit } = scanForMarker(state.text);
              if (hit) {
                const start = markerStart(state.text);
                const safe = state.text.slice(state.emittedLen, start);
                if (safe) outputChoices.push(withContent(rawChoice, safe));
                state.emittedLen = Math.max(start, 0);
                state.capturing = true;
                state.envelope = state.text.slice(state.emittedLen);
                modified = true;
              } else {
                const safe = state.text.slice(state.emittedLen, safeLen);
                const unchanged = safe === content && state.emittedLen === previousLength;
                if (safe) outputChoices.push(unchanged ? rawChoice : withContent(rawChoice, safe));
                state.emittedLen = safeLen;
                if (!unchanged) modified = true;
              }
            }
          } else if (!state.finished) {
            outputChoices.push(rawChoice);
          }

          if (state.capturing && encoder.encode(state.envelope).byteLength > STREAM_PREFLIGHT_LIMIT) {
            await fail(
              "llm-relay: tool-call envelope exceeded the commit probe limit",
              "tool_dialect_unparseable",
            );
            return;
          }

          if (rawChoice.finish_reason !== null && rawChoice.finish_reason !== undefined && !state.finished) {
            modified = true;
            const wasCapturing = state.capturing;
            const generated = await settleChoice(index, state, event.eventName);
            if (terminated) return;
            if (wasCapturing) {
              const outputIndex = outputChoices.indexOf(rawChoice);
              if (outputIndex >= 0) outputChoices.splice(outputIndex, 1);
              generatedAfter.push(...generated);
            } else {
              generatedBefore.push(...generated);
            }
          }
        }

        for (const generated of generatedBefore) push(generated);
        if (!modified) push(event.raw);
        else if (outputChoices.length > 0) push(encodeEvent(event.eventName, withChoices(event.data, outputChoices)));
        for (const generated of generatedAfter) push(generated);
      };

      try {
        while (!terminated) {
          const next = await reader.read();
          if (next.done) break;
          buffered += decoder.decode(next.value, { stream: true });
          while (true) {
            const boundary = firstBoundary(buffered);
            if (!boundary) break;
            const raw = buffered.slice(0, boundary.index + boundary.length);
            buffered = buffered.slice(boundary.index + boundary.length);
            await processEvent(raw);
            if (terminated) break;
          }
        }
        if (!terminated) {
          buffered += decoder.decode();
          if (buffered.length > 0) await processEvent(buffered);
        }
        if (!terminated) {
          let recovered = false;
          for (const [index, state] of states) {
            const wasCapturing = state.capturing && !state.finished;
            for (const generated of await settleChoice(index, state, lastEventName)) push(generated);
            recovered ||= wasCapturing;
            if (terminated) break;
          }
          if (!terminated && recovered && !sawDone) push(encodeEvent("", "[DONE]"));
        }
      } catch (error) {
        controller.error(error);
        return;
      }
      if (!cancelled) controller.close();
    },
    async cancel(reason) {
      cancelled = true;
      terminated = true;
      await activeReader?.cancel(reason).catch(() => {});
    },
  });
}
