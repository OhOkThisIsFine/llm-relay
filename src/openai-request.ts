/**
 * Anthropic Messages REQUEST → OpenAI Chat Completions REQUEST.
 *
 * Why this is relay-owned. Until 2026-08-23 `fetchBackend()` handed the whole conversation to
 * llm-bridge's `translateBetweenProviders("anthropic", "openai", …)`. Its `universalToOpenAI` has
 * no case for a `tool_call` or `tool_result` universal block, so every one of them fell through to
 * `JSON.stringify(<universal block>)` and became a `{type:"text"}` part of the OUTBOUND prompt —
 * the relay's own IR envelope (`{"_original":{"provider":"anthropic","raw":…},"tool_call":…}`)
 * written into the caller's conversation, 4–24 copies of it on a realistic agentic turn. Models
 * read the notation and echoed it back as their final answer, tool results were triplicated, the
 * prompt inflated ~3.1×, and `tool_calls` were emitted with no matching `role:"tool"` messages at
 * all. Diagnosis: docs/tool-call-dialect-leak.md §"Second mechanism".
 *
 * The rule this module exists to keep: **the body the relay sends is the caller's conversation,
 * never the relay's internals.** It is a deterministic wire-shape translation on the same side of
 * the repair boundary as `anthropicMessageToOpenAi` (its response-direction mirror in
 * `backend.ts`) — no model, no inference, no invented content. Anything it cannot represent is
 * REFUSED, following `documents.ts`: a mangled prompt reads as a working one, and stringifying a
 * block we do not understand is precisely the defect above.
 *
 * Scope is deliberate: exactly what Claude Code and Codex put on this front. `thinking` /
 * `redacted_thinking` are dropped (no OpenAI representation, and vendor-private reasoning is not
 * something to forward to a different vendor); `metadata` is dropped (llm-bridge dropped it too,
 * and `metadata.user_id` is a caller identifier that has never reached these providers); the
 * request-level `thinking` budget is dropped (mapping it to `reasoning_effort` would be a guess).
 */

/**
 * A request shape this mapper will not put on the wire. The caller turns it into a clean 400,
 * exactly as `DocumentError` does — local origin, provider never asked.
 */
export class RequestMappingError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "RequestMappingError";
  }
}

export interface AnthropicToOpenAiOptions {
  /**
   * The resolved deployment's model id. Absent => NO `model` key is sent. There is deliberately
   * no fallback to the caller's `body.model`: that is an Anthropic model id naming a deployment
   * this target does not have, so forwarding it would ask the host for a model nobody selected.
   * (`config.ts` makes `model` mandatory for an `openai`-kind target, so absence is unreachable
   * in production; the pre-2026-08-23 path assigned `target.model` unconditionally and therefore
   * emitted no key at all in that case — this keeps that behaviour identical.)
   */
  model?: string | undefined;
  /** Whether THIS hop streams — a relay decision, not the caller's. Falls back to the body. */
  stream?: boolean | undefined;
}

type Rec = Record<string, unknown>;

function isRecord(v: unknown): v is Rec {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

/** Name an unexpected block type in an error without echoing an arbitrary payload back. */
function describeType(t: unknown): string {
  return typeof t === "string" && t.length > 0 ? `"${t.slice(0, 40)}"` : "(missing type)";
}

function textOf(block: Rec): string {
  return typeof block.text === "string" ? block.text : "";
}

/**
 * `system` (string or text blocks) → the leading `{role:"system"}` message.
 *
 * Blocks are joined with a blank line, not a space: they are independent documents (harness
 * preamble, project instructions, …) and llm-bridge's single space ran the last word of one into
 * the first word of the next. `cache_control` is dropped — OpenAI Chat has no equivalent, and a
 * prompt-cache hint is not content.
 */
function systemText(system: unknown): string {
  if (typeof system === "string") return system;
  if (!Array.isArray(system)) return "";
  const parts: string[] = [];
  for (const block of system) {
    if (isRecord(block) && block.type === "text") parts.push(textOf(block));
  }
  return parts.join("\n\n");
}

/** One Anthropic `tool_use` block → one OpenAI `tool_calls[]` entry. */
function toolCall(block: Rec): Rec {
  // A synthesized id would be unmatchable: the linkage to the `role:"tool"` message that answers
  // it is the id itself, so inventing one silently detaches the result from the call.
  if (typeof block.id !== "string" || block.id.length === 0) {
    throw new RequestMappingError("tool_use block without an id");
  }
  if (typeof block.name !== "string" || block.name.length === 0) {
    throw new RequestMappingError("tool_use block without a name");
  }
  const input = block.input ?? {};
  return {
    id: block.id,
    type: "function",
    function: {
      name: block.name,
      // OpenAI carries arguments as a JSON STRING; a host-supplied string is already one.
      arguments: typeof input === "string" ? input : JSON.stringify(input),
    },
  };
}

/**
 * An assistant turn → exactly one OpenAI assistant message.
 *
 * Text blocks concatenate (the same rule as the response-direction `anthropicMessageToOpenAi`),
 * `tool_use` blocks become `tool_calls`, and `content` is `null` when nothing but tool calls
 * remains — the shape OpenAI defines for a tool-calling turn.
 */
function assistantMessage(turn: Rec): Rec {
  const content = turn.content;
  if (typeof content === "string") return { role: "assistant", content };
  const texts: string[] = [];
  const toolCalls: Rec[] = [];
  for (const raw of Array.isArray(content) ? content : []) {
    if (!isRecord(raw)) throw new RequestMappingError("assistant content block is not an object");
    switch (raw.type) {
      case "text":
        texts.push(textOf(raw));
        break;
      case "tool_use":
        toolCalls.push(toolCall(raw));
        break;
      case "thinking":
      case "redacted_thinking":
        break;
      default:
        throw new RequestMappingError(`unsupported assistant content block ${describeType(raw.type)}`);
    }
  }
  const text = texts.join("");
  const message: Rec = {
    role: "assistant",
    content: text.length > 0 ? text : toolCalls.length > 0 ? null : "",
  };
  if (toolCalls.length > 0) message.tool_calls = toolCalls;
  return message;
}

/** An Anthropic `image` block → an OpenAI `image_url` part (base64 sources become data URLs). */
function imagePart(block: Rec): Rec {
  const source = isRecord(block.source) ? block.source : {};
  if (source.type === "url" && typeof source.url === "string") {
    return { type: "image_url", image_url: { url: source.url } };
  }
  if (source.type === "base64" && typeof source.data === "string" && typeof source.media_type === "string") {
    return { type: "image_url", image_url: { url: `data:${source.media_type};base64,${source.data}` } };
  }
  throw new RequestMappingError("image block needs a base64 or url source");
}

/** One `tool_result`, split into what an OpenAI tool message can carry and what it cannot. */
interface ToolResultParts {
  /** The tool message's `content`. */
  text: string;
  /** `image_url` parts, in the order the result listed them, for the FOLLOWING user message. */
  images: Rec[];
}

/**
 * Split one Anthropic `tool_result` into its tool-message text and its image parts.
 *
 * ⚠ An OpenAI `role:"tool"` message is TEXT ONLY — the Chat Completions schema gives it a
 * required string `content` and defines no image part — so a result carrying a screenshot or an
 * image file read (exactly what Claude Code's `Read` produces for an image) has no
 * representation there. Refusing it was worse than the gap: a `RequestMappingError` is a LOCAL
 * 400, which `server.ts` does not fail over, so one image killed the whole request on every
 * `openai`-kind lane.
 *
 * It is carried LOSSLESSLY instead. The text stays on the tool message; the image is emitted as
 * an `image_url` part on the `{role:"user"}` message that follows this turn's tool messages —
 * the closest faithful representation OpenAI Chat has: the content is the caller's own, it is
 * attached to the same turn, it invents nothing, and a host with no vision answers with its own
 * UPSTREAM 400, which DOES fail over to a candidate that can read it.
 *
 * A block with no representation ANYWHERE is still refused — stringifying a block we do not
 * understand is the defect this module exists to undo.
 *
 * Text blocks are joined with a newline — separate result blocks are separate records, not one
 * continuous sentence.
 */
function toolResultParts(content: unknown): ToolResultParts {
  if (content === undefined || content === null) return { text: "", images: [] };
  if (typeof content === "string") return { text: content, images: [] };
  if (!Array.isArray(content)) {
    throw new RequestMappingError("tool_result content must be text or a list of blocks");
  }
  const texts: string[] = [];
  const images: Rec[] = [];
  for (const raw of content) {
    if (!isRecord(raw)) throw new RequestMappingError("tool_result content block is not an object");
    switch (raw.type) {
      case "text":
        texts.push(textOf(raw));
        break;
      case "image":
        images.push(imagePart(raw));
        break;
      default:
        throw new RequestMappingError(
          `tool_result carries an unsupported ${describeType(raw.type)} block; an OpenAI tool message carries text and images only`,
        );
    }
  }
  return { text: texts.join("\n"), images };
}

/**
 * One Anthropic `tool_result` block → one OpenAI `{role:"tool"}` message, plus the image parts
 * that message cannot carry (see `toolResultParts`).
 *
 * `is_error` is passed through as plain text with NO relay-authored prefix. OpenAI has no error
 * flag on a tool message, and the two honest options are to drop the flag or to write words into
 * the prompt; a failing tool's own output already says it failed, so the conversation stays the
 * caller's. Recorded as a decision, not an oversight.
 *
 * An empty result yields `content: ""`. That is what the schema asks for — a tool message's
 * `content` is a required string, and the empty one is valid — and a relay-authored placeholder
 * ("(no output)") would again be words the caller never wrote. The mirror mapper's
 * `content: text || null` is the ASSISTANT shape, where OpenAI defines null; a tool message has
 * no such spelling.
 */
function toolResultMessage(block: Rec): { message: Rec; images: Rec[] } {
  if (typeof block.tool_use_id !== "string" || block.tool_use_id.length === 0) {
    throw new RequestMappingError("tool_result block without a tool_use_id");
  }
  const { text, images } = toolResultParts(block.content);
  return { message: { role: "tool", tool_call_id: block.tool_use_id, content: text }, images };
}

/**
 * A user turn → its `role:"tool"` messages (one per `tool_result`, in order) followed by at most
 * one `role:"user"` message carrying everything else.
 *
 * The tool messages lead regardless of where the blocks sat in the array: OpenAI requires every
 * `tool_call_id` from the preceding assistant turn to be answered directly, and a user message
 * wedged between them is rejected by strict providers. Relative order within each group is
 * preserved, and the turn is never merged into a neighbour.
 *
 * That trailing user message is also where a `tool_result`'s IMAGES land — an OpenAI tool
 * message cannot carry one, so the image rides on the user turn that follows it, keeping its
 * position relative to the turn's other leftover blocks (`toolResultParts`).
 */
function userMessages(turn: Rec): Rec[] {
  const content = turn.content;
  if (typeof content === "string") return [{ role: "user", content }];
  const toolMessages: Rec[] = [];
  const parts: Rec[] = [];
  for (const raw of Array.isArray(content) ? content : []) {
    if (!isRecord(raw)) throw new RequestMappingError("user content block is not an object");
    switch (raw.type) {
      case "text":
        parts.push({ type: "text", text: textOf(raw) });
        break;
      case "image":
        parts.push(imagePart(raw));
        break;
      case "tool_result": {
        const { message, images } = toolResultMessage(raw);
        toolMessages.push(message);
        // Appended HERE, not collected separately, so a result's images keep their place among
        // the turn's other leftover blocks.
        parts.push(...images);
        break;
      }
      case "thinking":
      case "redacted_thinking":
        break;
      default:
        throw new RequestMappingError(`unsupported user content block ${describeType(raw.type)}`);
    }
  }
  const out: Rec[] = [...toolMessages];
  // A text-only turn keeps the plain-string form llm-bridge produced: it is what every
  // OpenAI-compatible host accepts, and multimodal parts are the exception, not the rule.
  if (parts.length === 1 && parts[0]!.type === "text") out.push({ role: "user", content: parts[0]!.text });
  else if (parts.length > 0) out.push({ role: "user", content: parts });
  // A turn that produced nothing at all still occupies a position in the conversation.
  else if (toolMessages.length === 0) out.push({ role: "user", content: "" });
  return out;
}

/** `tools[]` → OpenAI function declarations. */
function mapTools(tools: unknown): Rec[] | null {
  if (!Array.isArray(tools) || tools.length === 0) return null;
  const out: Rec[] = [];
  for (const raw of tools) {
    if (!isRecord(raw)) throw new RequestMappingError("tool declaration is not an object");
    if (typeof raw.name !== "string" || raw.name.length === 0) {
      // Dropping it would leave the model unable to call a tool the harness granted, and the
      // failure would surface as an unexplained refusal several turns later.
      throw new RequestMappingError("tool declaration without a name");
    }
    const fn: Rec = { name: raw.name };
    if (typeof raw.description === "string" && raw.description.length > 0) fn.description = raw.description;
    // Anthropic's built-in typed tools (`bash`, `text_editor`, …) declare no schema. An empty
    // object is not valid JSON Schema for every host, so the empty OBJECT schema is used —
    // "this tool takes no declared parameters", which is what the declaration means.
    fn.parameters = isRecord(raw.input_schema) ? raw.input_schema : { type: "object", properties: {} };
    out.push({ type: "function", function: fn });
  }
  return out;
}

/**
 * `tool_choice` → the OpenAI spelling. Anthropic's `any` ("call SOME tool") is OpenAI's
 * `required`; a named tool becomes the function form. An unrecognised shape is dropped rather
 * than guessed at — the host's default is `auto`, which is what llm-bridge left it at anyway.
 */
function mapToolChoice(choice: unknown): unknown {
  if (choice === "auto" || choice === "none" || choice === "required") return choice;
  if (!isRecord(choice)) return undefined;
  switch (choice.type) {
    case "auto":
      return "auto";
    case "any":
      return "required";
    case "none":
      return "none";
    case "tool":
      return typeof choice.name === "string" && choice.name.length > 0
        ? { type: "function", function: { name: choice.name } }
        : undefined;
    default:
      return undefined;
  }
}

/** `stop_sequences` → `stop`, unchanged and uncapped: silently dropping one changes what the model may emit. */
function stopSequences(raw: unknown): string[] | null {
  if (!Array.isArray(raw)) return null;
  const out = raw.filter((s): s is string => typeof s === "string");
  return out.length > 0 ? out : null;
}

/**
 * Translate one Anthropic Messages request body into an OpenAI Chat Completions request body.
 *
 * Turn order is preserved exactly; no turn is merged or dropped. Unknown top-level fields are not
 * forwarded — this is a translation between two contracts, not a passthrough.
 *
 * @throws {RequestMappingError} for a block or declaration that cannot be represented.
 */
export function anthropicRequestToOpenAi(
  reqJson: unknown,
  opts: AnthropicToOpenAiOptions = {},
): Record<string, unknown> {
  const body = isRecord(reqJson) ? reqJson : {};
  const messages: Rec[] = [];

  const system = systemText(body.system);
  if (system.length > 0) messages.push({ role: "system", content: system });

  for (const raw of Array.isArray(body.messages) ? body.messages : []) {
    if (!isRecord(raw)) throw new RequestMappingError("message is not an object");
    if (raw.role === "assistant") messages.push(assistantMessage(raw));
    else messages.push(...userMessages(raw));
  }

  const out: Rec = { messages };
  // The relay's resolved deployment id, never the caller's — see `AnthropicToOpenAiOptions`.
  if (opts.model !== undefined) out.model = opts.model;
  const stream = opts.stream ?? (typeof body.stream === "boolean" ? body.stream : undefined);
  if (stream !== undefined) out.stream = stream;
  if (typeof body.max_tokens === "number") out.max_tokens = body.max_tokens;
  if (typeof body.temperature === "number") out.temperature = body.temperature;
  if (typeof body.top_p === "number") out.top_p = body.top_p;
  const stop = stopSequences(body.stop_sequences);
  if (stop) out.stop = stop;
  const tools = mapTools(body.tools);
  if (tools) {
    out.tools = tools;
    // `tool_choice` without `tools` is rejected by strict hosts and means nothing anyway.
    const toolChoice = mapToolChoice(body.tool_choice);
    if (toolChoice !== undefined) out.tool_choice = toolChoice;
  }
  return out;
}
