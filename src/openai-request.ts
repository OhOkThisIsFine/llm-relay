import { isRecord } from "./json-shape.js";

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

import { createHash } from "node:crypto";

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
  /**
   * The RESOLVED outbound tool-call-id shape for this deployment (`config.ts`
   * `resolveToolCallIdMode`). Absent ⇒ `"preserve"` ⇒ the outbound bytes are identical to what
   * this mapper emitted before the mode existed. Never a provider name: the mapper is handed a
   * decision, it does not make one.
   */
  toolCallIds?: ToolCallIdMode | undefined;
  /**
   * Called once per run with how many ids the `"strict9"` pass rewrote (0 included). The same
   * out-param idiom `backend.ts` uses for the streamed `tool_use` mint — the count is metadata
   * about the translation, not part of the body it returns.
   */
  onToolCallIdsRewritten?: ((count: number) => void) | undefined;
  /**
   * The RESOLVED thought-signature mode for this deployment (`config.ts`
   * `resolveThoughtSignatureMode`). Absent ⇒ `"none"` ⇒ the outbound bytes are identical to what
   * this mapper emitted before the mode existed. Never a provider name, same rule as
   * `toolCallIds`.
   */
  thoughtSignature?: ThoughtSignatureMode | undefined;
  /**
   * Called once per run with how many tool calls the `"sentinel"` pass stamped (0 included). Same
   * out-param idiom as `onToolCallIdsRewritten`, and the count is metadata about the translation,
   * not part of the body it returns.
   */
  onThoughtSignatureSentinels?: ((count: number) => void) | undefined;
}

/** Mirrors `config.ts`'s `ToolCallIdMode`, restated so this module imports no config surface. */
export type ToolCallIdMode = "preserve" | "strict9";

/** Mirrors `config.ts`'s `ThoughtSignatureMode`, restated for the same reason. */
export type ThoughtSignatureMode = "none" | "sentinel";

/**
 * Google's documented opt-out token for a replayed tool call that carries no real thought
 * signature.
 *
 * FIRST-PARTY EVIDENCE (2026-08-23, `models/gemini-3.6-flash` via the OpenAI-compatible endpoint
 * at `generativelanguage.googleapis.com`): replaying an assistant `tool_calls` turn answers HTTP
 * 400 — "Function call is missing a thought_signature in functionCall parts…". Stamping this
 * string at `tool_calls[N].extra_content.google.thought_signature` was verified accepted on the
 * live endpoint the same day, for a single call and for BOTH entries of a parallel pair; the
 * model then answered correctly from the tool results. It is a RAW string and is never
 * base64-encoded — encoding it makes it an unparseable signature rather than the opt-out.
 *
 * WHY THE SENTINEL AND NOT THE REAL SIGNATURE. Echoing gemini's own signature back would need one
 * of two things this relay refuses to build:
 *
 *  - a conversation store keyed by tool-call id, holding vendor-private reasoning between turns —
 *    the reverse map `tool-use-ids.ts` deliberately does not have ("no reverse map, by
 *    construction": the client echoes what it was given and the relay remembers nothing); or
 *  - a fabricated `thinking` block smuggled back through the caller's conversation, which would
 *    poison every anthropic-kind failover candidate with content the caller never wrote.
 *
 * Meanwhile this mapper DROPS `thinking` / `redacted_thinking` cross-vendor by rule (see
 * `assistantMessage` and `userMessages` below, and the module header's "mapping it to
 * `reasoning_effort` would be a guess" precedent), so no real signature is in hand to echo in the
 * first place. The sentinel is the vendor's OWN token for exactly this state — a labelled
 * parameter quirk, not an invented measurement — and it is config-overridable
 * (`compat.thoughtSignature`), which is the condition the "Provider knowledge is data" invariant
 * attaches to any provider fact living in `src/`.
 */
const THOUGHT_SIGNATURE_SENTINEL = "skip_thought_signature_validator";

/**
 * Mistral's stated tool-call-id shape.
 *
 * First-party evidence (2026-08-23, `mistral-medium-2505`): forwarding a caller-side id verbatim
 * answers HTTP 400
 * `{"object":"error","message":"Tool call id was toolu_01AAAAAAAAAAAAAAAAAAAAAA but must be a-z, A-Z, 0-9, with a length of 9.","type":"invalid_function_call","code":"3280"}`.
 * `mistral-common` enforces it on BOTH the assistant `tool_calls[].id` and the answering tool
 * message's `tool_call_id`, and from v13 also enforces linkage (a tool message must answer an id
 * a prior assistant turn actually called) and uniqueness. Every id shape that reaches this mapper
 * violates it: `toolu_01…` (Anthropic), `Read:0` (nim kimi-k3), `Read:0_relay1` (relay-minted),
 * `call_…` (Codex via the Responses front), `tu_recovered_0` (dialect rescue).
 */
const STRICT9 = /^[a-zA-Z0-9]{9}$/;

const BASE62 = "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz";

/**
 * The hash `strict9` derives an outbound id from — SHA-256 in production, and the ONLY reason this
 * is a parameter at all is the collision policy below.
 *
 * ⚠ **TEST-ONLY SEAM, and it exists because the policy is otherwise unverifiable.** The `#k`
 * re-hash in `ToolCallIds.map` fires when two source ids land on the same 9-character base62
 * value, i.e. at odds of 62⁻⁹, so reaching that branch against real SHA-256 would take a preimage
 * — the documented behaviour ("collisions resolve deterministically by FIRST-APPEARANCE order")
 * could regress in either direction with nothing turning red. Injecting the digest lets
 * `test/tool-call-ids.test.ts` construct the collision directly. Production never passes one: the
 * default IS SHA-256, and the same test pins a real-SHA mapping so the default path stays covered.
 */
export type ToolCallIdDigest = (input: string) => Uint8Array;

const sha256Digest: ToolCallIdDigest = (input) => createHash("sha256").update(input, "utf8").digest();

/**
 * A deterministic 9-char base62 id for one source id.
 *
 * SHA-256 of the UTF-8 id (plus `#<k>` on a collision retry), one base62 character per digest
 * byte. **No randomness** — the same precedent as `tool-use-ids.ts`: a conversation only ever
 * appends, so the same source id must map to the same outbound id on the next turn, on a retry,
 * and on every candidate of a pool walk. A random id would detach a `tool_result` from the call
 * it answers the moment the conversation was replayed.
 */
function strict9(source: string, salt: number, digest: ToolCallIdDigest): string {
  const bytes = digest(salt === 0 ? source : `${source}#${salt}`);
  let out = "";
  for (let i = 0; i < 9; i++) out += BASE62[bytes[i]! % 62];
  return out;
}

/**
 * The one per-run source-id → outbound-id map, shared by `toolCall` and `toolResultMessage` so
 * both halves of a pair always land on the same value (mistral v13 checks that linkage).
 *
 * An id that already conforms is kept as-is, so a mistral-native id coming back through a later
 * turn round-trips unchanged. Collisions resolve deterministically by FIRST-APPEARANCE order:
 * the run is a single in-order walk of the conversation, so the same conversation always produces
 * the same assignment.
 *
 * ⚠ Exported ONLY so a test can hand it a colliding digest — see `ToolCallIdDigest`. Nothing
 * outside this module constructs one on the request path; `anthropicRequestToOpenAi` owns the
 * per-run instance and hands it to both halves of the pair itself.
 */
export class ToolCallIds {
  private readonly bySource = new Map<string, string>();
  private readonly taken = new Set<string>();
  private rewritten = 0;

  constructor(private readonly digest: ToolCallIdDigest = sha256Digest) {}

  map(id: string): string {
    const existing = this.bySource.get(id);
    if (existing !== undefined) return existing;
    let out: string;
    // A conforming id is kept — unless some earlier source already holds it, in which case
    // keeping it would map two different calls onto one id and break the uniqueness rule this
    // exists to satisfy. (62^-9; the branch is correctness, not a case anyone will meet.)
    if (STRICT9.test(id) && !this.taken.has(id)) out = id;
    else {
      out = strict9(id, 0, this.digest);
      for (let k = 1; this.taken.has(out); k++) out = strict9(id, k, this.digest);
    }
    this.taken.add(out);
    this.bySource.set(id, out);
    if (out !== id) this.rewritten += 1;
    return out;
  }

  count(): number {
    return this.rewritten;
  }
}

/**
 * The per-run thought-signature stamper — `null` under `"none"`, which is every provider but
 * Google's Generative Language API.
 *
 * EVERY replayed tool call is stamped, not just the first of a turn. That is the placement the
 * 2026-08-23 live check verified: the sentinel on the single call of a one-call turn was accepted,
 * and the sentinel on BOTH entries of a parallel pair was accepted too (which contradicts a public
 * report that a parallel pair rejects it — against this endpoint and model, on that date, it did
 * not). Stamping every entry is also the only placement whose correctness does not depend on which
 * entry the validator happens to inspect.
 */
class ThoughtSignatures {
  private stamped = 0;

  stamp(call: Rec): Rec {
    // A RAW string — never base64. Encoding it would make it a malformed signature instead of the
    // vendor's documented "there is no signature" token.
    call.extra_content = { google: { thought_signature: THOUGHT_SIGNATURE_SENTINEL } };
    this.stamped += 1;
    return call;
  }

  count(): number {
    return this.stamped;
  }
}

type Rec = Record<string, unknown>;

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
function toolCall(block: Rec, ids: ToolCallIds | null, sigs: ThoughtSignatures | null): Rec {
  // A synthesized id would be unmatchable: the linkage to the `role:"tool"` message that answers
  // it is the id itself, so inventing one silently detaches the result from the call.
  if (typeof block.id !== "string" || block.id.length === 0) {
    throw new RequestMappingError("tool_use block without an id");
  }
  if (typeof block.name !== "string" || block.name.length === 0) {
    throw new RequestMappingError("tool_use block without a name");
  }
  const input = block.input ?? {};
  const call: Rec = {
    // Under `"preserve"` (`ids === null`) this is the caller's own id, byte for byte.
    id: ids === null ? block.id : ids.map(block.id),
    type: "function",
    function: {
      name: block.name,
      // OpenAI carries arguments as a JSON STRING; a host-supplied string is already one.
      arguments: typeof input === "string" ? input : JSON.stringify(input),
    },
  };
  // Under `"none"` (`sigs === null`) NOTHING is added and this object is byte-identical to the one
  // this mapper emitted before the mode existed. See `THOUGHT_SIGNATURE_SENTINEL` for the 400 that
  // makes the other branch necessary and for why the vendor's opt-out token is the only honest
  // value the relay can put here.
  return sigs === null ? call : sigs.stamp(call);
}

/**
 * An assistant turn → exactly one OpenAI assistant message.
 *
 * Text blocks concatenate (the same rule as the response-direction `anthropicMessageToOpenAi`),
 * `tool_use` blocks become `tool_calls`, and `content` is `null` when nothing but tool calls
 * remains — the shape OpenAI defines for a tool-calling turn.
 */
function assistantMessage(turn: Rec, ids: ToolCallIds | null, sigs: ThoughtSignatures | null): Rec {
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
        toolCalls.push(toolCall(raw, ids, sigs));
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
function toolResultMessage(
  block: Rec,
  toolNames: ReadonlyMap<string, string> | undefined,
  ids: ToolCallIds | null,
): { message: Rec; images: Rec[] } {
  if (typeof block.tool_use_id !== "string" || block.tool_use_id.length === 0) {
    throw new RequestMappingError("tool_result block without a tool_use_id");
  }
  const { text, images } = toolResultParts(block.content);
  // The SAME map the assistant turn used, so the pair still points at itself — mistral's v13
  // validator rejects a tool message whose id no prior `tool_calls` entry carries.
  const toolCallId = ids === null ? block.tool_use_id : ids.map(block.tool_use_id);
  const message: Rec = { role: "tool", tool_call_id: toolCallId, content: text };
  // Gemini's OpenAI-compatible layer folds a tool message into a `functionResponse` part whose
  // `name` is REQUIRED and is never resolved from the preceding `tool_calls`, so a nameless tool
  // message is a 400 there ("function_response.name: name cannot be empty"). The name here is the
  // caller's OWN tool name, looked up from the assistant `tool_use` whose id this result answers
  // (the conversation is walked in order, so the call has always been seen) — re-stated where
  // another vendor needs it, not invented: an orphan result (no matching tool_use, e.g. its call
  // sat in a dropped block) carries NO `name`.
  // ⚠ Keyed by the ORIGINAL id: the name table is built from the caller's conversation, which the
  // id rewrite deliberately does not touch.
  const name = toolNames?.get(block.tool_use_id as string);
  if (name !== undefined) message.name = name;
  return { message, images };
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
function userMessages(turn: Rec, toolNames: ReadonlyMap<string, string> | undefined, ids: ToolCallIds | null): Rec[] {
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
        const { message, images } = toolResultMessage(raw, toolNames, ids);
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
  // `null` is the "preserve" mode, and it is the mode for every provider but mistral: no map is
  // built and every id reaches the wire exactly as the caller wrote it.
  const ids = opts.toolCallIds === "strict9" ? new ToolCallIds() : null;
  // Same shape, and independent of it — a provider may set both keys, and the two passes touch
  // different parts of the same `tool_calls[]` entry (its `id`, and a sibling `extra_content`).
  const sigs = opts.thoughtSignature === "sentinel" ? new ThoughtSignatures() : null;

  // Assistant `tool_use` id → name across the whole conversation, so each `role:"tool"` message
  // can restate the name of the call it answers (see `toolResultMessage` — a gemini compat-layer
  // requirement). Filled lazily on first `tool_use`; a no-tool request keeps `undefined`.
  let toolNames: Map<string, string> | undefined;
  const rememberToolNames = (turn: Rec): void => {
    if (!Array.isArray(turn.content)) return;
    for (const block of turn.content) {
      if (!isRecord(block) || block.type !== "tool_use") continue;
      if (typeof block.id === "string" && block.id.length > 0 &&
          typeof block.name === "string" && block.name.length > 0) {
        (toolNames ??= new Map()).set(block.id, block.name);
      }
    }
  };

  const system = systemText(body.system);
  if (system.length > 0) messages.push({ role: "system", content: system });

  for (const raw of Array.isArray(body.messages) ? body.messages : []) {
    if (!isRecord(raw)) throw new RequestMappingError("message is not an object");
    // Walked in order, so a `tool_result` is always emitted after its `tool_use` was recorded —
    // and id minting (`tool-use-ids.ts`) is RESPONSE-side, so the echoed pair shares one id here.
    if (raw.role === "assistant") {
      rememberToolNames(raw);
      messages.push(assistantMessage(raw, ids, sigs));
    } else messages.push(...userMessages(raw, toolNames, ids));
  }
  // Announced for the same reason every other automatic fix on this path is: a count, never an id.
  if (ids !== null) opts.onToolCallIdsRewritten?.(ids.count());
  // Counted, not headered: the sentinel is vendor-protocol padding on the relay's own outbound
  // shape and alters nothing about the caller's data, so the operator gets a log counter rather
  // than a response header. A count, same rule.
  if (sigs !== null) opts.onThoughtSignatureSentinels?.(sigs.count());

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
