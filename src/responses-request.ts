import { isRecord } from "./json-shape.js";
import type { ReasoningMode } from "./config-types.js";

/**
 * OpenAI Responses REQUEST → Anthropic Messages REQUEST.
 *
 * Why this is relay-owned. Until 2026-08-23 `fetchOpenAiFront()` handed a `/v1/responses` body to
 * llm-bridge's `translateBetweenProviders("openai-responses", "anthropic", …)`. Its
 * `openaiResponsesToUniversal` models exactly one tool-shaped input item — `function_call_output`
 * — and nothing else, so on a multi-turn tool conversation:
 *
 *   - a `function_call` item (the assistant's own tool call) has no `role`, defaulted to `"user"`,
 *     and its `content` is `undefined` ⇒ the turn became `[{type:"text", text: undefined}]`. The
 *     tool call vanished, and the `tool_result` that followed had no `tool_use` to answer — an
 *     Anthropic target 400s on it, and an `openai`-kind target received a `role:"tool"` message
 *     with no `tool_calls` before it. Every Responses tool conversation was broken past the first
 *     call;
 *   - an assistant `message` whose parts are `output_text` hit `parseResponsesContent`'s
 *     fall-through and reached the backend as `JSON.stringify(part)` — the assistant's own prior
 *     answer delivered as a JSON string. Same class of leak as the request-side IR envelope
 *     v0.39.0 removed on the Chat direction (docs/tool-call-dialect-leak.md §"Second mechanism");
 *   - a `reasoning` item (Codex sends one before most turns) became a bogus user turn;
 *   - `instructions` — Codex's system prompt — was read by nobody and dropped entirely.
 *
 * The rule this module exists to keep is the same one `openai-request.ts` keeps in the other
 * direction: **the body the relay sends is the caller's conversation, never the relay's
 * internals.** Deterministic wire-shape translation on the safe side of the repair boundary — no
 * model, no inference, no invented content — and anything with no representation is REFUSED
 * (`RequestMappingError` → a clean local 400, the `documents.ts` precedent) rather than
 * stringified, because a mangled prompt reads exactly like a working one.
 *
 * Per-field decisions, all deliberate:
 *
 *   - `instructions` → the head of `system`; `system`/`developer` role items append to it in
 *     order, joined with "\n" (llm-bridge's separator for the item half).
 *   - `input` as a string → one user text turn. `input[]` items map to turns, merging CONSECUTIVE
 *     same-role items into one turn: an assistant `message` followed by its `function_call`s is
 *     one assistant turn, and consecutive `function_call_output`s are one user turn — which is
 *     what Anthropic requires (every `tool_result` in the user turn immediately after the
 *     `tool_use` turn). Within a user turn `tool_result` blocks lead, mirroring the tool-message
 *     ordering rule in `openai-request.ts` — so a user `message` the caller wrote immediately
 *     BEFORE a `function_call_output` lands after that turn's tool results. That is the one
 *     reordering this mapper performs, it is within a single turn, and the alternatives are both
 *     shapes Anthropic rejects (results not leading, or the turn split in two). Nothing is
 *     reordered ACROSS turns.
 *   - ids round-trip unchanged: `function_call.call_id` → `tool_use.id`, and
 *     `function_call_output.call_id` → `tool_result.tool_use_id`. Those ids are the ones this
 *     relay minted on the way out (`anthropicMessageToOpenAi` sets `call_id` = the Anthropic
 *     `tool_use` id), so the linkage survives the whole round trip and `openai-request.ts` can
 *     re-emit them as `tool_calls[].id` / `tool_call_id` for an `openai`-kind target.
 *   - `reasoning` items are DROPPED BY DEFAULT: a reasoning summary has no Anthropic
 *     representation without the signature the minting provider issued, and forwarding one
 *     vendor's private reasoning to another vendor is not translation. Same decision as
 *     `openai-request.ts` dropping `thinking`. Dropping is neutral for turn merging, so an
 *     assistant turn split by a `reasoning` item still merges into one.
 *     ⚠ ONE opt-in exception, since 2026-09-10 (F11,
 *     docs/deepseek-responses-truncation-2026-09-09.md): under a RESOLVED `reasoning: "deepseek"`
 *     option (the `openai-request.ts` `compat.reasoning` precedent — a decision this module is
 *     handed, never a provider name it sniffs), the item's own stated `summary` text is carried
 *     onto a LEADING `thinking` block on the current assistant turn, byte for byte and only when
 *     nonempty, so `openai-request.ts` can carry it onward as DeepSeek's `reasoning_content`.
 *     `encrypted_content` is never read — an opaque blob for a different vendor's decoder, and
 *     reading it would be exactly the fabrication this module refuses everywhere else. Every other
 *     target's outbound bytes, and this option's own default, are unchanged.
 *   - `reasoning.effort` is DROPPED. llm-bridge turned it into `thinking.budget_tokens: 10240` —
 *     a token budget nobody stated, i.e. an invented figure, which provenance forbids.
 *   - `text.format` of `json_schema`/`json_object` is REFUSED. It is a contract about the shape of
 *     the answer; Anthropic Messages has no equivalent, so dropping it returns prose to a caller
 *     that will parse it as JSON — a silent corruption, and the one thing worse than a 400.
 *   - `previous_response_id` is REFUSED: the relay holds no response state, so honouring it
 *     silently would drop the whole conversation prefix it names.
 *   - `max_output_tokens` → `max_tokens`, carried ONLY when the caller stated one. Absent is carried
 *     as absent — never llm-bridge's old flat 1024, which this relay was inventing and sending to
 *     every backend as a real ceiling (docs/deepseek-responses-truncation-2026-09-09.md: 20 of 68
 *     captured DeepSeek answers hit that exact invented cap mid-answer, and the Responses front
 *     labelled every one of them `"status":"completed"` regardless — a token-capped answer reaching
 *     a harness labelled complete). `openai-request.ts` already omits an absent `max_tokens` from
 *     the outbound Chat body, so an `openai`-kind target's own provider applies its own ceiling; an
 *     `anthropic`-kind target REQUIRES the field, so `backend.ts` resolves one AT THE TARGET — the
 *     deployment's own learned `max-output` fact (`context-limits.ts`), then the catalog's, then
 *     the named tunable default `DEFAULT_RESPONSES_MAX_TOKENS` below. Never an invented measurement.
 *   - `store`, `prompt_cache_key`, `include`, `metadata`, `user`, `truncation`, `text.verbosity`,
 *     `service_tier`, `background` and non-function tool declarations (`web_search_preview`, …)
 *     are dropped: no representation, and no effect on the conversation. That is also exactly
 *     what llm-bridge did with them (into an unread `provider_params`), so the behaviour is
 *     preserved rather than newly decided.
 *   - Any other input item type (`item_reference`, `local_shell_call`, `custom_tool_call`,
 *     `web_search_call`, `computer_call`, `image_generation_call`, …) is REFUSED, naming the type.
 *     A newer Codex build inventing an item shape must fail loudly on the first request, not
 *     quietly reshape the conversation.
 *
 * `model` is left exactly as the caller sent it: `fetchOpenAiFront` overwrites it with the
 * resolved deployment id whenever the target declares one, and there is no fallback string here —
 * llm-bridge's `String(body.model || "unknown")` would put a model id nobody named on the wire.
 */

import { RequestMappingError } from "./openai-request.js";

type Rec = Record<string, unknown>;

/**
 * The Responses front's LAST-RESORT `max_tokens` for an `anthropic`-kind target when the caller
 * stated no `max_output_tokens` and this deployment has taught the relay no ceiling of its own
 * (`context-limits.ts`'s learned `max-output` fact) and the catalog publishes none either.
 * `backend.ts`'s `resolveAnthropicResponsesMaxTokens` is the one place this constant is read —
 * an `openai`-kind target never reaches it, because `openai-request.ts` omits `max_tokens`
 * entirely when the caller stated none and the provider applies its own ceiling.
 *
 * A TUNABLE DEFAULT, never a provider figure — the provenance invariant this whole module already
 * follows. Until 2026-09-09 this module substituted llm-bridge's flat 1024 here UNCONDITIONALLY,
 * even for an `openai`-kind target's outbound Chat body, where the field is genuinely optional.
 * Measured against DeepSeek (docs/deepseek-responses-truncation-2026-09-09.md): 20 of 68 captured
 * upstream answers ended `finish_reason: "length"` at EXACTLY `completion_tokens: 1024` — the
 * relay's own invented cap, not anything the caller or the provider asked for — and every one of
 * the 44 emitted `response.completed` events still carried `"status":"completed"`, so a cap
 * landing mid tool-call-argument JSON reached the caller looking like a finished answer. 8192 is
 * 8x that figure and is still just a guess bounding an `anthropic`-kind passthrough, which
 * REQUIRES the field.
 */
export const DEFAULT_RESPONSES_MAX_TOKENS = 8192;

/** Name an unexpected type in an error without echoing an arbitrary payload back at the caller. */
function describeType(t: unknown): string {
  return typeof t === "string" && t.length > 0 ? `"${t.slice(0, 40)}"` : "(missing type)";
}

/** A base64 data URL, split into its media type and payload. `.*` with `s` so newlines survive. */
const DATA_URL = /^data:([^;,]+);base64,(.*)$/s;

/**
 * One Responses `input_image` part → an Anthropic `image` block.
 *
 * A `data:` URL becomes a base64 source (Anthropic wants the media type and payload apart); an
 * http(s) URL becomes a url source. Anything else — notably a bare `file_id`, which names a file
 * on OpenAI's servers this relay cannot read — is refused rather than forwarded as a URL the
 * backend will fail to fetch.
 */
function imageBlock(part: Rec): Rec {
  const raw = part.image_url;
  const url = typeof raw === "string" ? raw : isRecord(raw) && typeof raw.url === "string" ? raw.url : "";
  if (url.length === 0) throw new RequestMappingError("input_image without an image_url");
  const data = DATA_URL.exec(url);
  if (data) return { type: "image", source: { type: "base64", media_type: data[1], data: data[2] } };
  if (/^https?:\/\//i.test(url)) return { type: "image", source: { type: "url", url } };
  throw new RequestMappingError("input_image url must be a base64 data URL or an http(s) URL");
}

/**
 * One Responses `input_file` part → an Anthropic `document` block.
 *
 * Only a base64 **PDF** data URL is representable: Anthropic's `document` block takes a
 * `media_type` and the only one it accepts is `application/pdf`. A bare base64 payload with a
 * filename, a `file_id`, or a `file_url` is refused — guessing the media type from an extension
 * is the kind of inference this module exists to avoid, and a `file_id` names storage the relay
 * cannot read.
 */
function documentBlock(part: Rec): Rec {
  const fileData = typeof part.file_data === "string" ? part.file_data : "";
  const data = DATA_URL.exec(fileData);
  if (data && data[1] === "application/pdf") {
    return { type: "document", source: { type: "base64", media_type: "application/pdf", data: data[2] } };
  }
  throw new RequestMappingError(
    "input_file has no Anthropic representation; only a base64 application/pdf data URL in file_data is carried",
  );
}

/**
 * The parts of one message item (or of a `function_call_output` list) → Anthropic content blocks.
 *
 * `documents` is false inside a `tool_result` and on an assistant turn: Anthropic's tool_result
 * content carries text and images only, and an assistant turn is what the model already said, so
 * a document in either has nowhere to go and is refused rather than flattened. `context` names
 * which of them the caller is being told about — a refusal is zero-egress and its message is the
 * only diagnostic they get, so it must not point at a place their request does not contain.
 *
 * An EMPTY text part yields no block. Anthropic rejects an empty text block outright
 * ("text content blocks must contain non-whitespace text"), so emitting one would turn a caller's
 * harmless empty string into a 400 on every candidate.
 */
function contentBlocks(content: unknown, opts: { documents: boolean; context: string }): Rec[] {
  if (content === undefined || content === null) return [];
  if (typeof content === "string") return content.length > 0 ? [{ type: "text", text: content }] : [];
  if (!Array.isArray(content)) {
    throw new RequestMappingError(`${opts.context} content must be a string or a list of parts`);
  }
  const blocks: Rec[] = [];
  for (const raw of content) {
    if (!isRecord(raw)) throw new RequestMappingError(`${opts.context} content part is not an object`);
    switch (raw.type) {
      case "input_text":
      case "output_text":
      case "text": {
        const text = typeof raw.text === "string" ? raw.text : "";
        if (text.length > 0) blocks.push({ type: "text", text });
        break;
      }
      // What the assistant said when it declined. It is content, not a status field, and
      // dropping it would leave a hole in the conversation the model is asked to continue.
      case "refusal": {
        const text = typeof raw.refusal === "string" ? raw.refusal : "";
        if (text.length > 0) blocks.push({ type: "text", text });
        break;
      }
      case "input_image":
        blocks.push(imageBlock(raw));
        break;
      case "input_file":
        if (!opts.documents) {
          throw new RequestMappingError(`${opts.context} carries text and images only, not an input_file`);
        }
        blocks.push(documentBlock(raw));
        break;
      default:
        throw new RequestMappingError(
          `${opts.context} carries an unsupported Responses content part ${describeType(raw.type)}`,
        );
    }
  }
  return blocks;
}

/**
 * `system` / `developer` item content → the text it contributes to `system`.
 *
 * Anthropic's `system` is text, so a non-text part has no representation here and is REFUSED like
 * every other one — the same rule `contentBlocks` keeps. Silently skipping it would deliver a
 * system prompt with a hole in it, which reads exactly like a working one: the failure this
 * module exists to remove, and strictly worse than the stringification it replaced.
 */
function systemTextOf(content: unknown): string {
  if (content === undefined || content === null) return "";
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) {
    throw new RequestMappingError("a system/developer item's content must be a string or a list of parts");
  }
  const parts: string[] = [];
  for (const raw of content) {
    if (!isRecord(raw)) throw new RequestMappingError("a system/developer content part is not an object");
    if (raw.type !== "input_text" && raw.type !== "output_text" && raw.type !== "text") {
      throw new RequestMappingError(
        `a system/developer item carries an unsupported ${describeType(raw.type)} part; Anthropic system is text only`,
      );
    }
    if (typeof raw.text === "string" && raw.text.length > 0) parts.push(raw.text);
  }
  // "\n", not llm-bridge's " ": these are independent instructions, and a space runs the last
  // word of one into the first word of the next.
  return parts.join("\n");
}

/**
 * `function_call.arguments` → the `tool_use.input` object.
 *
 * Anthropic requires an OBJECT. An absent or empty string is the no-argument call every client
 * spells differently and becomes `{}`; anything else that does not parse to an object is REFUSED,
 * because wrapping a string in a synthetic key (`{"input": "…"}`) would invent a schema the tool
 * never declared and the model would read the invention back as its own prior call.
 *
 * ⚠ The invalid-JSON refusal NAMES the `call_id` and says the string was CUT — the most likely
 * cause is an output-token cap landing mid-argument (docs/deepseek-responses-truncation-2026-09-09.md),
 * and a harness replaying the same malformed call forever cannot tell that from any other
 * malformed-JSON cause without this. A harness reading the message can instead repair or drop that
 * one item and retry, rather than looping.
 */
function toolArguments(raw: unknown, name: string, callId: string): Rec {
  if (raw === undefined || raw === null) return {};
  if (isRecord(raw)) return raw;
  if (typeof raw !== "string") {
    throw new RequestMappingError(`function_call ${describeType(name)} arguments are neither a string nor an object`);
  }
  if (raw.trim().length === 0) return {};
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new RequestMappingError(
      `function_call ${describeType(name)} (call_id ${callId}) arguments are not valid JSON: the string was cut, most likely by an output-token cap; repair or drop that item and retry`,
    );
  }
  if (!isRecord(parsed)) {
    throw new RequestMappingError(`function_call ${describeType(name)} arguments are not a JSON object`);
  }
  return parsed;
}

/** A `function_call` item → the assistant `tool_use` block it is. */
function toolUseBlock(item: Rec): Rec {
  // The `call_id` IS the linkage to the `function_call_output` that answers it — and, on a turn
  // this relay served, the Anthropic `tool_use` id it minted. Synthesizing one would silently
  // detach the result from the call, so an item without one is refused.
  const id = typeof item.call_id === "string" ? item.call_id : "";
  if (id.length === 0) throw new RequestMappingError("function_call without a call_id");
  const name = typeof item.name === "string" ? item.name : "";
  if (name.length === 0) throw new RequestMappingError("function_call without a name");
  return { type: "tool_use", id, name, input: toolArguments(item.arguments, name, id) };
}

/** A `function_call_output` item → the user-side `tool_result` block it is. */
function toolResultBlock(item: Rec): Rec {
  const id = typeof item.call_id === "string" ? item.call_id : "";
  if (id.length === 0) throw new RequestMappingError("function_call_output without a call_id");
  const block: Rec = { type: "tool_result", tool_use_id: id };
  const output = item.output;
  // A tool_result's `content` is a plain string FIELD, not a text block, so "" is representable
  // where an empty `{type:"text"}` block is not — but an empty LIST is the shape Anthropic
  // rejects, the same rule `flush()` keeps for a turn. A result the caller stated nothing for, or
  // whose parts carried no block, is therefore the empty string: the tool answered with nothing.
  if (output === undefined || output === null) block.content = "";
  else if (typeof output === "string") block.content = output;
  else if (Array.isArray(output)) {
    const blocks = contentBlocks(output, { documents: false, context: "a tool result" });
    block.content = blocks.length > 0 ? blocks : "";
  } else throw new RequestMappingError("function_call_output output must be a string or a list of parts");
  return block;
}

/**
 * `tools[]` → Anthropic tool declarations.
 *
 * Only `type: "function"` has a representation. Built-in declarations (`web_search_preview`,
 * `file_search`, `computer_use_preview`, `code_interpreter`, …) are DROPPED — that is what
 * llm-bridge already did with them (into a `provider_params` block nothing reads), they are
 * hosted server-side by OpenAI rather than executed by the caller, and refusing the request
 * outright would break every Codex session that declares one it never uses. Preserved as
 * existing behaviour, flagged here so it can be revisited with evidence.
 *
 * `strict` is dropped: Anthropic has no per-tool strict-schema flag, and the schema itself is
 * carried verbatim.
 *
 * A `tools` field that is not a list is REFUSED rather than ignored: quietly emitting no tools has
 * the same consequence as dropping a nameless declaration below — the model cannot call a tool the
 * harness granted, and the failure surfaces several turns later as an unexplained refusal.
 */
function mapTools(tools: unknown): Rec[] | null {
  if (tools === undefined || tools === null) return null;
  if (!Array.isArray(tools)) throw new RequestMappingError("tools must be a list of tool declarations");
  const out: Rec[] = [];
  for (const raw of tools) {
    if (!isRecord(raw)) throw new RequestMappingError("tool declaration is not an object");
    if (raw.type !== undefined && raw.type !== "function") continue;
    const name = typeof raw.name === "string" ? raw.name : "";
    if (name.length === 0) {
      // Dropping it would leave the model unable to call a tool the harness granted, and the
      // failure would surface as an unexplained refusal several turns later.
      throw new RequestMappingError("function tool declaration without a name");
    }
    const fn: Rec = { name };
    if (typeof raw.description === "string" && raw.description.length > 0) fn.description = raw.description;
    // Anthropic requires an object schema. A declared schema is carried verbatim; only the
    // mandatory envelope key is supplied when the caller omitted it, and a missing/`null`
    // `parameters` becomes the empty object schema — "this tool takes no declared parameters",
    // which is what the declaration means.
    fn.input_schema = isRecord(raw.parameters)
      ? (raw.parameters.type === undefined ? { type: "object", ...raw.parameters } : raw.parameters)
      : { type: "object", properties: {} };
    out.push(fn);
  }
  return out.length > 0 ? out : null;
}

/**
 * `tool_choice` → the Anthropic spelling. OpenAI's `required` ("call SOME tool") is Anthropic's
 * `any`; a named function becomes the `tool` form. An unrecognised shape (`allowed_tools`, a
 * hosted-tool choice) is dropped rather than guessed at — the default is `auto`, which is where
 * llm-bridge left it anyway.
 */
function mapToolChoice(choice: unknown): Rec | undefined {
  if (choice === "auto") return { type: "auto" };
  if (choice === "required") return { type: "any" };
  if (choice === "none") return { type: "none" };
  if (!isRecord(choice)) return undefined;
  if (choice.type === "function" && typeof choice.name === "string" && choice.name.length > 0) {
    return { type: "tool", name: choice.name };
  }
  if (choice.type === "auto") return { type: "auto" };
  if (choice.type === "none") return { type: "none" };
  return undefined;
}

interface InputCollector {
  push: (next: "user" | "assistant", blocks: Rec[], first?: boolean) => void;
  addSystemText: (text: string) => void;
}

/**
 * A Responses `reasoning` item's own stated text — every `summary_text` part of `summary`, joined.
 * `encrypted_content` is never read: it is an opaque blob meant for a DIFFERENT vendor's decoder,
 * and forwarding it as `reasoning_content` would be exactly the fabrication this module refuses
 * everywhere else (F11, 2026-09-10). An item with no summary parts (summaries not requested, or
 * genuinely empty — the common case for Codex today) yields "", which the caller treats as
 * "nothing to carry", never a placeholder.
 */
function reasoningSummaryText(item: Rec): string {
  if (!Array.isArray(item.summary)) return "";
  const parts: string[] = [];
  for (const raw of item.summary) {
    if (isRecord(raw) && raw.type === "summary_text" && typeof raw.text === "string" && raw.text.length > 0) {
      parts.push(raw.text);
    }
  }
  return parts.join("\n\n");
}

function processResponsesInputItem(raw: unknown, collector: InputCollector, reasoning: ReasoningMode | undefined): void {
  if (!isRecord(raw)) throw new RequestMappingError("input item is not an object");
  const type = typeof raw.type === "string" ? raw.type : undefined;
  if (type === "function_call") {
    collector.push("assistant", [toolUseBlock(raw)]);
    return;
  }
  if (type === "function_call_output") {
    collector.push("user", [toolResultBlock(raw)], true);
    return;
  }
  if (type === "reasoning") {
    // Dropped by default, and deliberately WITHOUT flushing either way: a Codex assistant turn is
    // often message → reasoning → function_call, and flushing here would split it in two.
    // Under "deepseek" mode, carried onto a LEADING block of the current turn instead — Anthropic
    // requires a `thinking` block to precede any `tool_use` in the same assistant turn, and
    // `first: true` guarantees that regardless of arrival order. Only when there is text: never a
    // fabricated block, and every other target's outbound bytes are unchanged.
    if (reasoning === "deepseek") {
      const text = reasoningSummaryText(raw);
      if (text.length > 0) collector.push("assistant", [{ type: "thinking", thinking: text }], true);
    }
    return;
  }
  if (type !== undefined && type !== "message") {
    throw new RequestMappingError(`unsupported Responses input item ${describeType(raw.type)}`);
  }
  const itemRole = typeof raw.role === "string" ? raw.role : undefined;
  if (itemRole === undefined) {
    // Two different malformations, and the message must name the one the caller actually
    // sent: a `message` item that forgot its role, or an item with no type at all.
    throw new RequestMappingError(
      type === "message" ? "message item without a role" : "input item has neither a type nor a role",
    );
  }
  if (itemRole === "system" || itemRole === "developer") {
    const text = systemTextOf(raw.content);
    if (text.length > 0) collector.addSystemText(text);
    return;
  }
  if (itemRole !== "user" && itemRole !== "assistant") {
    throw new RequestMappingError(`unsupported Responses input role ${describeType(raw.role)}`);
  }
  collector.push(
    itemRole,
    contentBlocks(raw.content, {
      documents: itemRole === "user",
      context: itemRole === "user" ? "a user message" : "an assistant message",
    }),
  );
}

function mapResponsesOptions(body: Rec, out: Rec, systemParts: string[]): void {
  // The caller's own id, untouched: `fetchOpenAiFront` replaces it with the resolved deployment.
  if (typeof body.model === "string" && body.model.length > 0) out.model = body.model;
  if (systemParts.length > 0) out.system = systemParts.join("\n");
  const tools = mapTools(body.tools);
  if (tools) {
    out.tools = tools;
    // `tool_choice` without `tools` is rejected by Anthropic and means nothing anyway.
    const toolChoice = mapToolChoice(body.tool_choice);
    if (toolChoice) {
      // Anthropic spells the parallel-call switch on tool_choice, and only where it can apply —
      // `{type:"none"}` calls no tool, so the flag there would be a field the API rejects.
      if (body.parallel_tool_calls === false && toolChoice.type !== "none") {
        toolChoice.disable_parallel_tool_use = true;
      }
      out.tool_choice = toolChoice;
    }
  }
  if (typeof body.temperature === "number") out.temperature = body.temperature;
  if (typeof body.top_p === "number") out.top_p = body.top_p;
  if (typeof body.stream === "boolean") out.stream = body.stream;
}

export interface ResponsesToAnthropicOptions {
  /**
   * The RESOLVED reasoning-mapping mode for the target this Anthropic-shaped intermediate will
   * reach (`config.ts` `resolveReasoningMode`) — the same value `openai-request.ts`'s
   * `AnthropicToOpenAiOptions.reasoning` carries, since an `openai`-kind target's request is built
   * FROM this function's own output (see `fetchTranslatedOpenAiFront` in `backend.ts`). Absent ⇒
   * `"none"` ⇒ a Responses `reasoning` item is dropped exactly as it was before this option
   * existed — every target but a `"deepseek"` one is unaffected. Never a provider name: this
   * module is handed a decision, it does not make one (the `openai-request.ts` precedent).
   */
  reasoning?: ReasoningMode | undefined;
}

/**
 * Translate one OpenAI Responses request body into an Anthropic Messages request body.
 *
 * Turn order is preserved exactly; only CONSECUTIVE same-role items merge. Unknown top-level
 * fields are not forwarded — this is a translation between two contracts, not a passthrough.
 *
 * @throws {RequestMappingError} for an item, part or declaration that cannot be represented.
 */
export function openaiResponsesRequestToAnthropic(
  reqJson: unknown,
  opts: ResponsesToAnthropicOptions = {},
): Record<string, unknown> {
  const body = isRecord(reqJson) ? reqJson : {};

  if (typeof body.previous_response_id === "string" && body.previous_response_id.length > 0) {
    throw new RequestMappingError(
      "previous_response_id is not supported: this relay stores no responses, so the conversation prefix it names would be silently dropped",
    );
  }
  const format = isRecord(body.text) && isRecord(body.text.format) ? body.text.format : null;
  if (format && (format.type === "json_schema" || format.type === "json_object")) {
    throw new RequestMappingError(
      `text.format ${describeType(format.type)} has no Anthropic Messages equivalent; dropping it would return prose to a caller that parses JSON`,
    );
  }

  const systemParts: string[] = [];
  if (typeof body.instructions === "string" && body.instructions.length > 0) systemParts.push(body.instructions);

  const messages: Rec[] = [];
  let role: "user" | "assistant" | null = null;
  let leading: Rec[] = [];
  let trailing: Rec[] = [];

  const flush = (): void => {
    if (role !== null) {
      const content = [...leading, ...trailing];
      // A turn that produced no block says nothing; emitting it would be an empty content array,
      // which Anthropic rejects. Nothing the caller wrote is lost — there was nothing to carry.
      if (content.length > 0) messages.push({ role, content });
    }
    role = null;
    leading = [];
    trailing = [];
  };
  /** `first: true` puts the blocks at the head of the turn — where Anthropic wants tool_results. */
  const push = (next: "user" | "assistant", blocks: Rec[], first = false): void => {
    if (blocks.length === 0) return;
    if (role !== next) {
      flush();
      role = next;
    }
    if (first) leading.push(...blocks);
    else trailing.push(...blocks);
  };

  const input = body.input;
  if (typeof input === "string") {
    push("user", contentBlocks(input, { documents: true, context: "a user message" }));
  } else if (Array.isArray(input)) {
    const collector: InputCollector = {
      push,
      addSystemText: (text) => systemParts.push(text),
    };
    for (const raw of input) {
      processResponsesInputItem(raw, collector, opts.reasoning);
    }
  } else if (input !== undefined && input !== null) {
    throw new RequestMappingError("input must be a string or a list of items");
  }
  flush();

  const out: Rec = { messages };
  // Carried ONLY when the caller stated one — absent is carried as absent. See the module header
  // and `DEFAULT_RESPONSES_MAX_TOKENS` for why nothing is invented here any more.
  if (typeof body.max_output_tokens === "number") out.max_tokens = body.max_output_tokens;
  mapResponsesOptions(body, out, systemParts);
  return out;
}
