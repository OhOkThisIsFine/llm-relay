/**
 * Observe provider-reported usage and relay-estimated model output without
 * changing the response path. In particular, this module never changes (or
 * buffers) a response chunk: it only keeps bounded parsing state alongside
 * the stream.
 */

import { estimateTokensFromCharacters } from "./metadata.js";

/**
 * Protocols the USAGE observer actually parses. Deliberately narrower than
 * `StreamCommitProtocol`: no call site observes a native OpenAI Responses body
 * (Responses front-door traffic is translated to Anthropic before it is proxied),
 * so there is no `"openai-responses"` member to re-add if one ever appears.
 */
export type UsageProtocol = "anthropic-messages" | "openai-chat";

export interface UsageAccumulator {
  /** Provider-reported prompt/input tokens. */
  inputTokens: number | undefined;
  /** Provider-reported completion/output tokens. */
  outputTokens: number | undefined;
  /** OpenAI's explicitly reported cached prompt/input tokens. */
  cachedInputTokens: number | undefined;
  /** Anthropic reports cache writes and cache reads as distinct facts. */
  cacheCreationInputTokens: number | undefined;
  cacheReadInputTokens: number | undefined;
  /** Compatibility alias consumed by existing model telemetry. */
  completionTokens: number | undefined;
  /** chars/4 estimate over model-authored content, never response framing. */
  estimatedOutputTokens: number | undefined;
}

export function createUsageAccumulator(): UsageAccumulator {
  return {
    inputTokens: undefined,
    outputTokens: undefined,
    cachedInputTokens: undefined,
    cacheCreationInputTokens: undefined,
    cacheReadInputTokens: undefined,
    completionTokens: undefined,
    estimatedOutputTokens: undefined,
  };
}

const MAX_SSE_FRAME = 16 * 1024;
const MAX_BUFFERED_JSON = 1024 * 1024;
const MAX_DECODE_SLICE = 4096;
const MAX_PENDING_ARGUMENT_CHARS = 64 * 1024;
const MAX_PENDING_TOOL_CALLS = 128;
const MAX_STREAMED_TEXT_FIELDS = 128;

function validCompletionTokens(value: unknown): value is number {
  return (
    typeof value === "number" &&
    Number.isFinite(value) &&
    Number.isSafeInteger(value) &&
    value >= 0
  );
}

function recordField(
  accumulator: UsageAccumulator,
  field: keyof UsageAccumulator,
  value: unknown,
): void {
  if (!validCompletionTokens(value)) return;
  try {
    accumulator[field] = value;
  } catch {
    // A malformed/hostile accumulator must not affect pass-through.
  }
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" ? value as Record<string, unknown> : undefined;
}

interface OutputEstimateState {
  characters: number;
  overflow: boolean;
  pendingArgumentCharacters: number;
  pendingArguments: Map<string, string>;
  streamedTexts: Map<string, StreamedTextState>;
}

interface StreamedTextState {
  disposition: "candidate" | "count" | "skip";
  heldCharacters: number;
  prefix: string;
  headerTail: string;
}

function publishOutputEstimate(
  accumulator: UsageAccumulator,
  state: OutputEstimateState,
): void {
  try {
    accumulator.estimatedOutputTokens = state.overflow
      || state.pendingArguments.size > 0
      || state.characters <= 0
      ? undefined
      : estimateTokensFromCharacters(state.characters);
  } catch {
    // A malformed/hostile accumulator must not affect pass-through.
  }
}

function isBase64DataUrl(value: string): boolean {
  if (value.length < 13 || value.slice(0, 5).toLowerCase() !== "data:") return false;
  const comma = value.indexOf(",", 5);
  return comma >= 12 && value.slice(comma - 7, comma).toLowerCase() === ";base64";
}

interface SanitizedArgumentJson {
  characters: number;
  removedBinary: boolean;
}

function sanitizedArgumentJson(value: unknown): SanitizedArgumentJson | undefined {
  let removedBinary = false;
  try {
    const json = JSON.stringify(value, (key, nestedValue: unknown) => {
      if (typeof nestedValue === "string" && (key === "data" || isBase64DataUrl(nestedValue))) {
        removedBinary = true;
        return "";
      }
      return nestedValue;
    });
    return { characters: json?.length ?? 0, removedBinary };
  } catch {
    return undefined;
  }
}

function argumentCharacters(value: unknown): number | undefined {
  if (typeof value === "string") {
    if (isBase64DataUrl(value)) return 0;
    if (value.length === 0 || value.trim().length === 0) return value.length;
    try {
      const parsed: unknown = JSON.parse(value);
      const sanitized = sanitizedArgumentJson(parsed);
      if (!sanitized) return undefined;
      return sanitized.removedBinary ? sanitized.characters : value.length;
    } catch {
      // Malformed JSON cannot be semantically inspected for escaped binary
      // fields. Unknown is safer than a knowingly inflated raw-length total.
      return undefined;
    }
  }
  return sanitizedArgumentJson(value)?.characters;
}

function recordOutputCharacters(
  accumulator: UsageAccumulator,
  state: OutputEstimateState,
  characters: number,
): void {
  if (state.overflow || characters <= 0 || !Number.isSafeInteger(characters)) return;
  const next = state.characters + characters;
  if (!Number.isSafeInteger(next)) {
    taintOutputEstimate(accumulator, state);
    return;
  }
  state.characters = next;
  publishOutputEstimate(accumulator, state);
}

function taintOutputEstimate(
  accumulator: UsageAccumulator,
  state: OutputEstimateState,
): void {
  state.overflow = true;
  state.pendingArgumentCharacters = 0;
  state.pendingArguments.clear();
  state.streamedTexts.clear();
  try {
    accumulator.estimatedOutputTokens = undefined;
  } catch {
    // A malformed/hostile accumulator must not affect pass-through.
  }
}

function recordOutputText(
  accumulator: UsageAccumulator,
  state: OutputEstimateState,
  value: unknown,
): void {
  if (typeof value !== "string" || isBase64DataUrl(value)) return;
  recordOutputCharacters(accumulator, state, value.length);
}

/**
 * A streamed logical string may be split before `data:...;base64,` becomes
 * recognizable. Count partial text immediately, but retain only enough state
 * to roll it back if later fragments prove the whole string is binary.
 */
function appendStreamedOutputText(
  accumulator: UsageAccumulator,
  state: OutputEstimateState,
  key: string,
  value: unknown,
): void {
  if (state.overflow || typeof value !== "string" || value.length === 0) return;
  let text = state.streamedTexts.get(key);
  if (!text) {
    if (state.streamedTexts.size >= MAX_STREAMED_TEXT_FIELDS) {
      taintOutputEstimate(accumulator, state);
      return;
    }
    text = {
      disposition: "candidate",
      heldCharacters: 0,
      prefix: "",
      headerTail: "",
    };
    state.streamedTexts.set(key, text);
  }
  if (text.disposition === "count") {
    recordOutputCharacters(accumulator, state, value.length);
    return;
  }
  if (text.disposition === "skip") return;

  const heldCharacters = text.heldCharacters + value.length;
  const totalCharacters = state.characters + value.length;
  if (!Number.isSafeInteger(heldCharacters) || !Number.isSafeInteger(totalCharacters)) {
    taintOutputEstimate(accumulator, state);
    return;
  }
  text.heldCharacters = heldCharacters;
  state.characters = totalCharacters;

  for (const character of value) {
    if (text.prefix.length < 5) {
      text.prefix += character;
      if (text.prefix.toLowerCase() !== "data:".slice(0, text.prefix.length)) {
        text.disposition = "count";
        text.heldCharacters = 0;
        publishOutputEstimate(accumulator, state);
        return;
      }
      continue;
    }
    if (character === ",") {
      if (text.headerTail.toLowerCase() === ";base64") {
        text.disposition = "skip";
        state.characters -= text.heldCharacters;
        text.heldCharacters = 0;
        publishOutputEstimate(accumulator, state);
      } else {
        text.disposition = "count";
        text.heldCharacters = 0;
        publishOutputEstimate(accumulator, state);
      }
      return;
    }
    text.headerTail = `${text.headerTail}${character}`.slice(-7);
  }
  publishOutputEstimate(accumulator, state);
}

function flushStreamedOutputText(
  state: OutputEstimateState,
  key: string,
): void {
  const text = state.streamedTexts.get(key);
  if (!text) return;
  state.streamedTexts.delete(key);
}

function flushStreamedOutputTextPrefix(
  state: OutputEstimateState,
  prefix: string,
): void {
  for (const key of [...state.streamedTexts.keys()]) {
    if (key.startsWith(`${prefix}:`)) flushStreamedOutputText(state, key);
  }
}

function flushAllStreamedOutputText(
  state: OutputEstimateState,
): void {
  for (const key of [...state.streamedTexts.keys()]) {
    flushStreamedOutputText(state, key);
  }
}

function recordToolArguments(
  accumulator: UsageAccumulator,
  state: OutputEstimateState,
  value: unknown,
): void {
  const characters = argumentCharacters(value);
  if (characters === undefined) {
    taintOutputEstimate(accumulator, state);
    return;
  }
  recordOutputCharacters(accumulator, state, characters);
}

function appendToolArguments(
  accumulator: UsageAccumulator,
  state: OutputEstimateState,
  key: string,
  value: unknown,
): void {
  if (state.overflow) return;
  if (typeof value !== "string") {
    recordToolArguments(accumulator, state, value);
    return;
  }
  if (value.length === 0) return;
  const prior = state.pendingArguments.get(key);
  if (prior === undefined && state.pendingArguments.size >= MAX_PENDING_TOOL_CALLS) {
    taintOutputEstimate(accumulator, state);
    return;
  }
  const nextSize = state.pendingArgumentCharacters + value.length;
  if (!Number.isSafeInteger(nextSize) || nextSize > MAX_PENDING_ARGUMENT_CHARS) {
    taintOutputEstimate(accumulator, state);
    return;
  }
  state.pendingArguments.set(key, (prior ?? "") + value);
  state.pendingArgumentCharacters = nextSize;
  // Until the complete JSON can be sanitized, a partial tool argument could be
  // base64. Hide the whole estimate rather than publish a knowingly partial total.
  publishOutputEstimate(accumulator, state);
}

function flushToolArguments(
  accumulator: UsageAccumulator,
  state: OutputEstimateState,
  key: string,
): void {
  const value = state.pendingArguments.get(key);
  if (value === undefined) return;
  state.pendingArguments.delete(key);
  state.pendingArgumentCharacters -= value.length;
  recordToolArguments(accumulator, state, value);
  publishOutputEstimate(accumulator, state);
}

function flushAllToolArguments(
  accumulator: UsageAccumulator,
  state: OutputEstimateState,
): void {
  for (const key of [...state.pendingArguments.keys()]) {
    flushToolArguments(accumulator, state, key);
  }
}

function flushToolArgumentsPrefix(
  accumulator: UsageAccumulator,
  state: OutputEstimateState,
  prefix: string,
): void {
  for (const key of [...state.pendingArguments.keys()]) {
    if (key.startsWith(`${prefix}:`)) flushToolArguments(accumulator, state, key);
  }
}

function streamArgumentKey(prefix: string, value: unknown, fallback: number | string): string {
  const index = typeof value === "number" && Number.isSafeInteger(value) && value >= 0
    ? value
    : fallback;
  return `${prefix}:${index}`;
}

function isAnthropicToolUseBlock(type: unknown): boolean {
  return type === "tool_use" || type === "server_tool_use" || type === "mcp_tool_use";
}

function inspectAnthropicOutput(
  root: Record<string, unknown>,
  accumulator: UsageAccumulator,
  state: OutputEstimateState,
): void {
  const inspectBlock = (value: unknown, includeToolArguments: boolean): void => {
    const block = asRecord(value);
    if (!block) return;
    if (block.type === "text") recordOutputText(accumulator, state, block.text);
    else if (block.type === "thinking") recordOutputText(accumulator, state, block.thinking);
    else if (includeToolArguments && isAnthropicToolUseBlock(block.type)) {
      recordToolArguments(accumulator, state, block.input);
    }
  };

  if (root.type === "message") {
    if (Array.isArray(root.content)) {
      root.content.forEach((block) => inspectBlock(block, true));
    }
    return;
  }
  const key = streamArgumentKey("anthropic", root.index, "unknown");
  if (root.type === "content_block_start") {
    // Anthropic streams seed tool-use blocks with protocol-owned `input: {}`;
    // the authored argument JSON arrives in input_json_delta frames.
    const block = asRecord(root.content_block);
    if (block?.type === "text") {
      appendStreamedOutputText(accumulator, state, `${key}:text`, block.text);
    } else if (block?.type === "thinking") {
      appendStreamedOutputText(accumulator, state, `${key}:thinking`, block.thinking);
    }
    return;
  }
  if (root.type === "content_block_stop") {
    flushToolArguments(accumulator, state, key);
    flushStreamedOutputTextPrefix(state, key);
    return;
  }
  if (root.type !== "content_block_delta") return;
  const delta = asRecord(root.delta);
  if (!delta) return;
  if (delta.type === "text_delta") {
    appendStreamedOutputText(accumulator, state, `${key}:text`, delta.text);
  } else if (delta.type === "thinking_delta") {
    appendStreamedOutputText(accumulator, state, `${key}:thinking`, delta.thinking);
  } else if (delta.type === "input_json_delta") {
    appendToolArguments(accumulator, state, key, delta.partial_json);
  }
}

function inspectOpenAiMessage(
  value: unknown,
  accumulator: UsageAccumulator,
  state: OutputEstimateState,
  streamKeyPrefix?: string,
): void {
  const message = asRecord(value);
  if (!message) return;
  if (typeof message.content === "string") {
    if (streamKeyPrefix) {
      appendStreamedOutputText(accumulator, state, `${streamKeyPrefix}:content`, message.content);
    } else {
      recordOutputText(accumulator, state, message.content);
    }
  } else if (Array.isArray(message.content)) {
    for (const [partOffset, partValue] of message.content.entries()) {
      const part = asRecord(partValue);
      if (part && (part.type === "text" || part.type === "output_text")) {
        if (streamKeyPrefix) {
          const key = streamArgumentKey(`${streamKeyPrefix}:content`, part.index, partOffset);
          appendStreamedOutputText(accumulator, state, key, part.text);
        } else {
          recordOutputText(accumulator, state, part.text);
        }
      }
    }
  }
  // Providers use these as alternate spellings. Prefer the explicit Chat field
  // so a host emitting both aliases cannot double the same reasoning text.
  const reasoningContent = typeof message.reasoning_content === "string"
    && message.reasoning_content.length > 0
    ? message.reasoning_content
    : message.reasoning;
  if (streamKeyPrefix) {
    appendStreamedOutputText(accumulator, state, `${streamKeyPrefix}:reasoning`, reasoningContent);
    appendStreamedOutputText(accumulator, state, `${streamKeyPrefix}:refusal`, message.refusal);
  } else {
    recordOutputText(accumulator, state, reasoningContent);
    recordOutputText(accumulator, state, message.refusal);
  }

  const functionCall = asRecord(message.function_call);
  const toolCalls = Array.isArray(message.tool_calls) ? message.tool_calls : [];
  if (toolCalls.length === 0 && functionCall) {
    if (streamKeyPrefix) {
      appendToolArguments(accumulator, state, `${streamKeyPrefix}:function`, functionCall.arguments);
    } else {
      recordToolArguments(accumulator, state, functionCall.arguments);
    }
  }
  for (const [callOffset, callValue] of toolCalls.entries()) {
    const call = asRecord(callValue);
    const fn = call && asRecord(call.function);
    if (!fn) continue;
    if (streamKeyPrefix) {
      const key = streamArgumentKey(streamKeyPrefix, call?.index, callOffset);
      appendToolArguments(accumulator, state, key, fn.arguments);
    } else {
      recordToolArguments(accumulator, state, fn.arguments);
    }
  }
}

function inspectOpenAiOutput(
  root: Record<string, unknown>,
  accumulator: UsageAccumulator,
  state: OutputEstimateState,
  streamed: boolean,
): void {
  if (!Array.isArray(root.choices)) return;
  for (const [choiceOffset, choiceValue] of root.choices.entries()) {
    const choice = asRecord(choiceValue);
    if (!choice) continue;
    inspectOpenAiMessage(choice.message, accumulator, state);
    const prefix = streamArgumentKey("openai", choice.index, choiceOffset);
    inspectOpenAiMessage(choice.delta, accumulator, state, streamed ? prefix : undefined);
    if (streamed && choice.finish_reason !== undefined && choice.finish_reason !== null) {
      flushToolArgumentsPrefix(accumulator, state, prefix);
      flushStreamedOutputTextPrefix(state, prefix);
    }
  }
}

function usageRecords(value: unknown, protocol: UsageProtocol): Record<string, unknown>[] {
  const root = asRecord(value);
  if (!root) return [];
  const records: Record<string, unknown>[] = [];
  const rootUsage = asRecord(root.usage);
  if (rootUsage) records.push(rootUsage);

  if (protocol === "anthropic-messages" && root.type === "message_start") {
    const message = asRecord(root.message);
    const messageUsage = message && asRecord(message.usage);
    if (messageUsage) records.push(messageUsage);
  }

  return records;
}

function inspectUsageRecord(
  usage: Record<string, unknown>,
  protocol: UsageProtocol,
  accumulator: UsageAccumulator,
): void {
  const inputName = protocol === "openai-chat" ? "prompt_tokens" : "input_tokens";
  const outputName = protocol === "openai-chat" ? "completion_tokens" : "output_tokens";
  recordField(accumulator, "inputTokens", usage[inputName]);
  recordField(accumulator, "outputTokens", usage[outputName]);
  // Keep completionTokens as a compatibility alias, while outputTokens is the
  // canonical provider-reported field. Each assignment is isolated so a
  // consumer's accessor cannot suppress the other fact.
  if (validCompletionTokens(usage[outputName])) {
    recordField(accumulator, "completionTokens", usage[outputName]);
  }

  if (protocol === "anthropic-messages") {
    recordField(accumulator, "cacheCreationInputTokens", usage.cache_creation_input_tokens);
    recordField(accumulator, "cacheReadInputTokens", usage.cache_read_input_tokens);
    return;
  }

  // openai-chat: cached tokens ride in prompt_tokens_details.
  const details = asRecord(usage.prompt_tokens_details);
  if (details) recordField(accumulator, "cachedInputTokens", details.cached_tokens);
}

function inspectJson(
  value: unknown,
  protocol: UsageProtocol,
  accumulator: UsageAccumulator,
  estimate: OutputEstimateState,
  streamed = false,
): void {
  try {
    const root = asRecord(value);
    if (root) {
      if (protocol === "anthropic-messages") inspectAnthropicOutput(root, accumulator, estimate);
      else inspectOpenAiOutput(root, accumulator, estimate, streamed);
    }
  } catch {
    taintOutputEstimate(accumulator, estimate);
  }
  try {
    for (const usage of usageRecords(value, protocol)) {
      inspectUsageRecord(usage, protocol, accumulator);
    }
  } catch {
    // An observer must never make provider bytes fail a request.
  }
}

interface SseState {
  event: string | undefined;
  data: string[];
  size: number;
  overflow: boolean;
}

function newSseState(): SseState {
  return { event: undefined, data: [], size: 0, overflow: false };
}

function inspectSseFrame(
  state: SseState,
  protocol: UsageProtocol,
  accumulator: UsageAccumulator,
  estimate: OutputEstimateState,
): void {
  if (state.overflow || state.data.length === 0) return;
  const data = state.data.join("\n");
  const trimmed = data.trim();
  if (trimmed.length === 0 || trimmed === "[DONE]") return;
  try {
    const value: unknown = JSON.parse(data);
    if (protocol === "anthropic-messages") {
      const root = asRecord(value);
      if (root) {
        try {
          inspectAnthropicOutput(root, accumulator, estimate);
        } catch {
          taintOutputEstimate(accumulator, estimate);
        }
        if (state.event === "message_start" || state.event === "message_delta" || root.type === "message_start" || root.type === "message_delta") {
          try {
            for (const usage of usageRecords(root, protocol)) {
              inspectUsageRecord(usage, protocol, accumulator);
            }
          } catch {
            // A reported-usage observer failure is isolated from pass-through.
          }
        }
      }
    } else {
      // The only non-Anthropic protocol is openai-chat: every frame is inspected.
      inspectJson(value, protocol, accumulator, estimate, true);
    }
  } catch {
    // A skipped frame might have carried content. Preserve traffic, but do not
    // leave a partial estimate looking complete.
    taintOutputEstimate(accumulator, estimate);
  }
}

function resetSse(state: SseState): void {
  state.event = undefined;
  state.data = [];
  state.size = 0;
  state.overflow = false;
}

function processSseLine(
  line: string,
  terminatorBytes: number,
  state: SseState,
  protocol: UsageProtocol,
  accumulator: UsageAccumulator,
  estimate: OutputEstimateState,
): void {
  if (line === "") {
    inspectSseFrame(state, protocol, accumulator, estimate);
    resetSse(state);
    return;
  }

  // Count all frame bytes, including fields we do not interpret.  This keeps
  // an attacker from evading the bound with a very large unknown field.
  state.size += new TextEncoder().encode(line).byteLength + terminatorBytes;
  if (state.size > MAX_SSE_FRAME) {
    state.overflow = true;
    state.data = [];
    taintOutputEstimate(accumulator, estimate);
    return;
  }
  if (state.overflow) return;

  if (line.startsWith("event:")) {
    state.event = line.slice(6).replace(/^ /, "");
  } else if (line.startsWith("data:")) {
    state.data.push(line.slice(5).replace(/^ /, ""));
  }
}

function makeSseObserver(
  protocol: UsageProtocol,
  accumulator: UsageAccumulator,
  estimate: OutputEstimateState,
): {
  push(bytes: Uint8Array): void;
  finish(): void;
} {
  const decoder = new TextDecoder();
  const utf8Validator = new TextDecoder("utf-8", { fatal: true });
  let text = "";
  let discardUntilBreak = false;
  const state = newSseState();

  const drain = (final: boolean): void => {
    if (discardUntilBreak) {
      let index = -1;
      let terminatorLength = 0;
      for (let i = 0; i < text.length; i += 1) {
        const code = text.charCodeAt(i);
        if (code === 10 || code === 13) {
          // CRLF may be split over two provider chunks.  Keep a trailing CR
          // until the LF arrives so it cannot dispatch a false blank frame.
          if (code === 13 && i === text.length - 1 && !final) break;
          index = i;
          terminatorLength = code === 13 && text.charCodeAt(i + 1) === 10 ? 2 : 1;
          break;
        }
      }
      if (index < 0) {
        // An oversized line can end in a CR whose LF arrives next chunk.
        // Retain that one byte so the frame separator remains intact.
        text = text.endsWith("\r") && !final ? "\r" : "";
        if (final) discardUntilBreak = false;
        return;
      }
      text = text.slice(index + terminatorLength);
      discardUntilBreak = false;
    }
    while (text.length > 0) {
      let index = -1;
      let terminatorLength = 0;
      for (let i = 0; i < text.length; i += 1) {
        const code = text.charCodeAt(i);
        if (code === 10 || code === 13) {
          if (code === 13 && i === text.length - 1 && !final) break;
          index = i;
          terminatorLength = code === 13 && text.charCodeAt(i + 1) === 10 ? 2 : 1;
          break;
        }
      }
      if (index < 0) {
        if (state.size + new TextEncoder().encode(text).byteLength > MAX_SSE_FRAME) {
          // Do not retain an unterminated oversized line.  The next blank
          // line will reset the poisoned frame and permit recovery.
          state.overflow = true;
          text = "";
          discardUntilBreak = true;
          taintOutputEstimate(accumulator, estimate);
        }
        break;
      }
      const line = text.slice(0, index);
      text = text.slice(index + terminatorLength);
      processSseLine(line, terminatorLength, state, protocol, accumulator, estimate);
    }
    if (final && text.length > 0) {
      if (state.size + new TextEncoder().encode(text).byteLength <= MAX_SSE_FRAME) {
        processSseLine(text, 0, state, protocol, accumulator, estimate);
      }
      else {
        state.overflow = true;
        taintOutputEstimate(accumulator, estimate);
      }
      text = "";
    }
    if (final) {
      // A final line without the customary trailing blank line is still a
      // useful terminal event in practice.
      inspectSseFrame(state, protocol, accumulator, estimate);
      resetSse(state);
    }
  };

  return {
    push(bytes) {
      try {
        // Keep decoded input bounded even when a provider hands us a very
        // large chunk. TextDecoder's streaming state safely handles a UTF-8
        // code point split between these slices.
        for (let offset = 0; offset < bytes.byteLength; offset += MAX_DECODE_SLICE) {
          const end = Math.min(offset + MAX_DECODE_SLICE, bytes.byteLength);
          const slice = bytes.subarray(offset, end);
          try {
            utf8Validator.decode(slice, { stream: true });
          } catch {
            taintOutputEstimate(accumulator, estimate);
          }
          text += decoder.decode(slice, { stream: true });
          drain(false);
        }
      } catch {
        taintOutputEstimate(accumulator, estimate);
      }
    },
    finish() {
      try {
        try {
          utf8Validator.decode();
        } catch {
          taintOutputEstimate(accumulator, estimate);
        }
        text += decoder.decode();
        drain(true);
        flushAllStreamedOutputText(estimate);
        flushAllToolArguments(accumulator, estimate);
      } catch {
        taintOutputEstimate(accumulator, estimate);
      }
    },
  };
}

function makeJsonObserver(
  protocol: UsageProtocol,
  accumulator: UsageAccumulator,
  estimate: OutputEstimateState,
): {
  push(bytes: Uint8Array): void;
  finish(): void;
} {
  const chunks: Uint8Array[] = [];
  let size = 0;
  let overflow = false;
  return {
    push(bytes) {
      if (overflow) return;
      if (bytes.byteLength === 0) return;
      if (size + bytes.byteLength > MAX_BUFFERED_JSON) {
        overflow = true;
        chunks.length = 0;
        return;
      }
      chunks.push(bytes);
      size += bytes.byteLength;
    },
    finish() {
      if (overflow) return;
      try {
        const bytes = new Uint8Array(size);
        let offset = 0;
        for (const chunk of chunks) {
          bytes.set(chunk, offset);
          offset += chunk.byteLength;
        }
        const json = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
        inspectJson(JSON.parse(json), protocol, accumulator, estimate);
      } catch {
        taintOutputEstimate(accumulator, estimate);
      }
    },
  };
}

/**
 * Return a response whose body is byte-for-byte the input body while usage is
 * observed synchronously as each chunk passes through.
 */
export function observeUsage(
  response: Response,
  protocol: UsageProtocol,
  accumulator: UsageAccumulator,
  options: { streamed?: boolean } = {},
): Response {
  if (!response.body) return response;

  const estimate: OutputEstimateState = {
    characters: 0,
    overflow: false,
    pendingArgumentCharacters: 0,
    pendingArguments: new Map(),
    streamedTexts: new Map(),
  };
  const observer = options.streamed
    ? makeSseObserver(protocol, accumulator, estimate)
    : makeJsonObserver(protocol, accumulator, estimate);
  const transform = new TransformStream<Uint8Array, Uint8Array>({
    transform(chunk, controller) {
      // Observer failures are isolated; errors from the upstream body are
      // owned by pipeThrough and therefore propagate unchanged.
      try {
        observer.push(chunk);
      } catch {
        // A user-supplied accumulator/property must never break pass-through.
      }
      controller.enqueue(chunk);
    },
    flush() {
      try {
        observer.finish();
      } catch {
        // See transform(): observation is strictly best effort.
      }
    },
  });

  let body: ReadableStream<Uint8Array>;
  try {
    body = response.body.pipeThrough(transform);
  } catch {
    return response;
  }

  try {
    return new Response(body, {
      status: response.status,
      statusText: response.statusText,
      headers: new Headers(response.headers),
    });
  } catch {
    return response;
  }
}
