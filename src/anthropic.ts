/**
 * Minimal Anthropic Messages API shapes — only the fields the proxy inspects.
 * The proxy is byte-transparent for everything else; these types exist to
 * validate tool_use blocks and reconstruct streamed responses, not to model the
 * whole API.
 */

/** A JSON Schema object as it appears in a tool's `input_schema`. */
export type JsonSchema = Record<string, unknown>;

export interface Tool {
  name: string;
  description?: string;
  input_schema: JsonSchema;
}

export interface TextBlock {
  type: "text";
  text: string;
}

export interface ToolUseBlock {
  type: "tool_use";
  id: string;
  name: string;
  input: unknown;
}

/** Anything we don't specifically model (thinking, redacted_thinking, …). */
export interface OpaqueBlock {
  type: string;
  [k: string]: unknown;
}

export type ContentBlock = TextBlock | ToolUseBlock | OpaqueBlock;

export type StopReason =
  | "end_turn"
  | "max_tokens"
  | "stop_sequence"
  | "tool_use"
  | string
  | null;

/**
 * The assistant message the proxy validates (from JSON body or reconstructed from SSE).
 *
 * `id` / `model` / `stop_sequence` exist only because a repaired response has to be
 * re-serialized and the backend's own identity has to survive that (DAT-27df2443): the
 * shape previously carried neither, so `emitSse` had nowhere to read an id from and fell
 * back to the constant `msg_repair` for every repaired turn — every repair looked like
 * the same message. They are all `undefined` when the source response did not carry them,
 * which is deliberately distinguishable from a captured value; nothing here invents one.
 * This is still not an SDK model — do not add a field without a finding that needs it AND
 * a consumer that actually threads it through.
 */
export interface AssistantMessage {
  /** The backend's own message id, when the response carried one. */
  id?: string | undefined;
  /** The model the backend reported serving, when the response carried one. */
  model?: string | undefined;
  content: ContentBlock[];
  stop_reason: StopReason;
  stop_sequence?: string | null | undefined;
  /**
   * Token usage as the backend reported it. An ABSENT field means "the backend did not
   * tell us", which is not the same claim as `0`; callers must not fill it with a zero.
   *
   * The two cache fields carry Anthropic's own semantics: `input_tokens` EXCLUDES cache
   * reads and cache writes — they arrive separately here because they price differently,
   * so folding them into a single prompt figure loses information the client meters on.
   * Deliberately a closed shape (no index signature): unknown usage keys stay with the
   * byte-transparent path rather than being modelled here.
   */
  usage?: {
    input_tokens?: number;
    output_tokens?: number;
    /** Tokens written TO the prompt cache this call (Anthropic reports it separately). */
    cache_creation_input_tokens?: number;
    /** Tokens served FROM the prompt cache this call (Anthropic reports it separately). */
    cache_read_input_tokens?: number;
  } | undefined;
}

export function isToolUseBlock(b: ContentBlock): b is ToolUseBlock {
  return b.type === "tool_use";
}

/**
 * Extract the tools[] map (name → JSON schema) from a parsed Anthropic, Chat, or
 * Responses request body. Value is `null` for a tool that is DECLARED but has no schema —
 * notably Anthropic's built-in/typed tools (`bash`, `text_editor`, `computer`,
 * `web_search`), which carry a `type` but no schema. Such tools are "known but
 * unvalidatable": a tool_use naming them must NOT be flagged unknown_tool, but
 * also cannot be schema-checked.
 */
export function toolSchemaMap(requestBody: unknown): Map<string, JsonSchema | null> {
  const map = new Map<string, JsonSchema | null>();
  if (
    typeof requestBody === "object" &&
    requestBody !== null &&
    Array.isArray((requestBody as { tools?: unknown }).tools)
  ) {
    for (const t of (requestBody as { tools: unknown[] }).tools) {
      if (typeof t !== "object" || t === null || Array.isArray(t)) continue;
      const tool = t as Record<string, unknown>;

      // Anthropic Messages and OpenAI Responses both put the function name on the tool itself;
      // their schema fields differ. Anthropic built-ins deliberately remain declared/null.
      if (typeof tool.name === "string") {
        const rawSchema = tool.input_schema ?? tool.parameters;
        const schema =
          typeof rawSchema === "object" && rawSchema !== null
            ? (rawSchema as JsonSchema)
            : null;
        map.set(tool.name, schema);
        continue;
      }

      // Chat Completions wraps declarations in `{ type, function: { name, parameters } }`.
      // Reading only Anthropic's shape made every direct Chat tool request look tool-free.
      if (tool.type === "function" && typeof tool.function === "object" && tool.function !== null) {
        const fn = tool.function as Record<string, unknown>;
        if (typeof fn.name !== "string") continue;
        const schema =
          typeof fn.parameters === "object" && fn.parameters !== null
            ? (fn.parameters as JsonSchema)
            : null;
        map.set(fn.name, schema);
      }
    }
  }
  return map;
}
