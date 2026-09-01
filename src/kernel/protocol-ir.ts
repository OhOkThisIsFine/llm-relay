/**
 * Canonical protocol-neutral intermediate representation (IR) for LLM requests and responses.
 *
 * Provides a formal boundary between front-door protocols (Anthropic Messages, OpenAI Chat Completions,
 * OpenAI Responses) and backend provider wire formats.
 */

export type NormalizedRole = "system" | "user" | "assistant" | "tool";

export interface NormalizedTextBlock {
  readonly type: "text";
  readonly text: string;
}

export interface NormalizedToolUseBlock {
  readonly type: "tool_use";
  readonly id: string;
  readonly name: string;
  readonly input: Record<string, unknown>;
}

export interface NormalizedToolResultBlock {
  readonly type: "tool_result";
  readonly toolUseId: string;
  readonly content?: string | readonly NormalizedContentBlock[] | undefined;
  readonly isError?: boolean | undefined;
}

export interface NormalizedImageBlock {
  readonly type: "image";
  readonly source: {
    readonly type: "base64" | "url";
    readonly mediaType?: string | undefined;
    readonly data?: string | undefined;
    readonly url?: string | undefined;
  };
}

export interface NormalizedThinkingBlock {
  readonly type: "thinking";
  readonly thinking: string;
  readonly signature?: string | undefined;
}

export type NormalizedContentBlock =
  | NormalizedTextBlock
  | NormalizedToolUseBlock
  | NormalizedToolResultBlock
  | NormalizedImageBlock
  | NormalizedThinkingBlock;

export interface NormalizedMessage {
  readonly role: NormalizedRole;
  readonly content: readonly NormalizedContentBlock[];
}

export interface NormalizedToolSchema {
  readonly name: string;
  readonly description?: string | undefined;
  readonly inputSchema: Record<string, unknown>;
}

export interface NormalizedLlmRequest {
  readonly model?: string | undefined;
  readonly system?: readonly string[] | undefined;
  readonly messages: readonly NormalizedMessage[];
  readonly tools?: readonly NormalizedToolSchema[] | undefined;
  readonly stream?: boolean | undefined;
  readonly temperature?: number | undefined;
  readonly maxTokens?: number | undefined;
  readonly metadata?: Record<string, unknown> | undefined;
}

export interface NormalizedUsage {
  readonly inputTokens: number;
  readonly outputTokens: number;
  readonly cachedInputTokens?: number | undefined;
}

export type NormalizedStopReason =
  | "end_turn"
  | "max_tokens"
  | "stop_sequence"
  | "tool_use"
  | "error"
  | null;

export interface NormalizedLlmResponse {
  readonly id: string;
  readonly model: string;
  readonly role: "assistant";
  readonly content: readonly NormalizedContentBlock[];
  readonly stopReason: NormalizedStopReason;
  readonly usage: NormalizedUsage;
}

/**
 * Type guard for NormalizedTextBlock.
 */
export function isNormalizedTextBlock(block: NormalizedContentBlock): block is NormalizedTextBlock {
  return block.type === "text";
}

/**
 * Type guard for NormalizedToolUseBlock.
 */
export function isNormalizedToolUseBlock(block: NormalizedContentBlock): block is NormalizedToolUseBlock {
  return block.type === "tool_use";
}

/**
 * Type guard for NormalizedToolResultBlock.
 */
export function isNormalizedToolResultBlock(block: NormalizedContentBlock): block is NormalizedToolResultBlock {
  return block.type === "tool_result";
}
