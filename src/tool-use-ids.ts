/**
 * Make a translated response's `tool_use` ids unique against the conversation that produced it.
 *
 * WHY. Some hosts mint tool-call ids that are not unique across a conversation: NIM's
 * `moonshotai/kimi-k3` emits OpenAI `tool_calls[].id` values of the form `<ToolName>:<index in
 * this response>` — `Read:0`, `Bash:0` — so the SAME id recurs on every turn that calls that tool
 * again. Claude Code normalizes the conversation while BUILDING every request: it walks the
 * messages keeping a Set of seen `tool_use` ids, DROPS any `tool_use` whose id it has already
 * seen, substitutes the text `[Tool use interrupted]` when that empties an assistant turn, and
 * patches the orphaned `tool_result`s. The model therefore never sees its own earlier calls, and
 * eventually the freshly returned assistant turn is itself emptied and a headless `claude -p` run
 * ends with nothing to execute.
 *
 * This is protocol FORM — an identifier — squarely inside the repair boundary: the relay fixes
 * form, never judgment. A minted id is relay metadata exactly like the `chatcmpl_relay`,
 * `tool_call_${n}` and `tu_recovered_${i}` ids `backend.ts` already mints. It is deterministic
 * (no randomness, so the behaviour is exactly testable) and it is announced —
 * `x-llm-relay-tool-use-ids` on the buffered path, a metadata-only counter in the log.
 *
 * NO REVERSE MAPPING EXISTS, BY CONSTRUCTION. The client echoes whatever id it received back in
 * both the assistant `tool_use` and the user `tool_result` of the next request, and
 * `openai-request.ts` forwards those verbatim as `tool_calls[].id` / `tool_call_id`. The backend
 * therefore sees a self-consistent pair without the relay remembering anything between requests —
 * which is what keeps this pure: no store, no disk, no state that could go stale.
 *
 * REPLACEMENT SCHEME: `<original>_relay<k>` with the smallest k >= 1 that is free, checked against
 * the conversation's ids AND against the replacements already minted for this response. The suffix
 * is drawn from `[A-Za-z0-9_]`, so a replacement stays inside the `[A-Za-z0-9_:-]` character set
 * hosts accept, and it keeps the original visibly intact so a transcript still reads as the host's
 * own id plus a relay marker.
 */

type Rec = Record<string, unknown>;

function isRecord(value: unknown): value is Rec {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** How deep a conversation is walked for ids. A `tool_result`'s own content is the only nesting. */
const MAX_BLOCK_DEPTH = 2;

function collectFromBlocks(blocks: unknown, into: Set<string>, depth: number): void {
  if (!Array.isArray(blocks) || depth > MAX_BLOCK_DEPTH) return;
  for (const block of blocks) {
    if (!isRecord(block)) continue;
    if (block.type === "tool_use" && typeof block.id === "string" && block.id.length > 0) {
      into.add(block.id);
    }
    if (block.type === "tool_result") {
      if (typeof block.tool_use_id === "string" && block.tool_use_id.length > 0) {
        into.add(block.tool_use_id);
      }
      // A `tool_result`'s content carries text/image blocks only, but walking it costs one
      // bounded pass and means an id can never hide from the uniqueness check.
      collectFromBlocks(block.content, into, depth + 1);
    }
  }
}

/**
 * Every `tool_use.id` and `tool_result.tool_use_id` already present in the REQUEST conversation.
 *
 * Pure: it reads the already-parsed request body the caller holds, so it adds no disk read and no
 * network call to the request path. Compute it lazily — a response with no tool call at all never
 * needs it.
 */
export function knownToolUseIds(reqJson: unknown): Set<string> {
  const out = new Set<string>();
  if (!isRecord(reqJson)) return out;
  const messages = reqJson.messages;
  if (!Array.isArray(messages)) return out;
  for (const turn of messages) {
    if (!isRecord(turn)) continue;
    collectFromBlocks(turn.content, out, 1);
  }
  return out;
}

/**
 * `id` when nothing has claimed it, else the smallest free `<id>_relay<k>`.
 *
 * Pure and deterministic — it does not record the answer. `ToolUseIdMinter` is what marks a
 * result as taken, because "is this id free?" and "claim this id" are different decisions and a
 * caller inspecting one candidate must not mutate the set.
 */
export function uniqueToolUseId(id: string, taken: ReadonlySet<string>): string {
  if (!taken.has(id)) return id;
  for (let k = 1; ; k += 1) {
    const candidate = `${id}_relay${k}`;
    if (!taken.has(candidate)) return candidate;
  }
}

/**
 * Per-RESPONSE minting state: the conversation's ids plus everything this response has emitted.
 *
 * Claiming each emitted id — the unchanged ones too — is what makes two identical ids inside ONE
 * response diverge, which is the shape kimi produces when a turn calls the same tool twice.
 */
export class ToolUseIdMinter {
  private readonly taken: Set<string>;
  private count = 0;

  constructor(taken: Iterable<string>) {
    this.taken = new Set(taken);
  }

  /** The id this response should carry for `id`, claiming it against later blocks. */
  mint(id: string): string {
    const next = uniqueToolUseId(id, this.taken);
    this.taken.add(next);
    if (next !== id) this.count += 1;
    return next;
  }

  /** How many ids this response had to change. A count, never an id. */
  get rewritten(): number {
    return this.count;
  }
}

export interface ToolUseIdRewrite {
  /** The content array with unique `tool_use` ids. The same array instance when nothing changed. */
  content: unknown[];
  /** How many blocks changed id. */
  rewritten: number;
  /** original id -> minted id, for the blocks that changed. Diagnostics only; nothing consults it. */
  map: Map<string, string>;
}

/**
 * Rewrite the `tool_use` ids of one buffered Anthropic content array.
 *
 * Non-`tool_use` blocks are returned untouched and by reference: this is an identifier fix, not a
 * re-serialization of the model's answer.
 */
export function rewriteToolUseIds(content: unknown, taken: ReadonlySet<string>): ToolUseIdRewrite {
  const blocks = Array.isArray(content) ? content : [];
  const minter = new ToolUseIdMinter(taken);
  const map = new Map<string, string>();
  const out = blocks.map((block) => {
    if (!isRecord(block) || block.type !== "tool_use" || typeof block.id !== "string") return block;
    const minted = minter.mint(block.id);
    if (minted === block.id) return block;
    map.set(block.id, minted);
    return { ...block, id: minted };
  });
  const rewritten = minter.rewritten;
  return { content: rewritten > 0 ? out : blocks, rewritten, map };
}

/** The SSE event framing shared with `think-tags.ts` — both separator spellings are legal. */
function eventSeparator(text: string): { at: number; length: number } | null {
  const lf = text.indexOf("\n\n");
  const crlf = text.indexOf("\r\n\r\n");
  if (lf < 0 && crlf < 0) return null;
  if (crlf >= 0 && (lf < 0 || crlf < lf)) return { at: crlf, length: 4 };
  return { at: lf, length: 2 };
}

/** Re-serialize one event, replacing its `data:` payload and keeping every other line in place. */
function replaceEventData(block: string, data: string): string {
  const eol = block.includes("\r\n") ? "\r\n" : "\n";
  const lines = block.split(/\r?\n/);
  const out: string[] = [];
  let emitted = false;
  for (const line of lines) {
    if (!line.startsWith("data:")) {
      out.push(line);
      continue;
    }
    // Multi-line data folds into the one line we emit at the first data line's position.
    if (emitted) continue;
    out.push(`data: ${data}`);
    emitted = true;
  }
  return out.join(eol);
}

/**
 * Wrap a translated Anthropic SSE stream so a colliding `tool_use` id is minted afresh.
 *
 * Applied AFTER dialect recovery so a recovered call is covered too, and BEFORE anything that
 * watches for the first `tool_use` — validation, repair and `guardReshaped`'s structural
 * conservation check all see the final ids, which is what makes the repaired message the same
 * message the client received.
 *
 * Every event this does not rewrite is forwarded byte-identical, including a truncated tail and an
 * event whose data is not JSON: any doubt releases the original bytes. `takenIds` is a thunk so a
 * response with no tool call never pays for walking the conversation, and `onRewrite` reports the
 * running count for the metadata-only log field (headers are long gone by then).
 */
export function rewriteToolUseIdsInStream(
  upstream: ReadableStream<Uint8Array>,
  takenIds: () => Iterable<string>,
  onRewrite?: (count: number) => void,
): ReadableStream<Uint8Array> {
  const decoder = new TextDecoder();
  const encoder = new TextEncoder();
  let buffered = "";
  let minter: ToolUseIdMinter | null = null;

  return new ReadableStream<Uint8Array>({
    async start(controller) {
      const push = (text: string) => {
        if (text.length > 0) controller.enqueue(encoder.encode(text));
      };
      const reader = upstream.getReader();

      const rewriteOne = (block: string): string | null => {
        // Cheap gate: a tool_use content_block_start always spells the type literally, so ordinary
        // text deltas cost a substring scan rather than a JSON parse.
        if (!block.includes("tool_use")) return null;
        const dataLines: string[] = [];
        for (const line of block.split(/\r?\n/)) {
          if (line.startsWith("data:")) dataLines.push(line.slice(5).trim());
        }
        if (dataLines.length === 0) return null;
        let parsed: unknown;
        try {
          parsed = JSON.parse(dataLines.join("\n"));
        } catch {
          return null;
        }
        if (!isRecord(parsed) || parsed.type !== "content_block_start") return null;
        const cb = parsed.content_block;
        if (!isRecord(cb) || cb.type !== "tool_use" || typeof cb.id !== "string") return null;
        minter ??= new ToolUseIdMinter(takenIds());
        const minted = minter.mint(cb.id);
        if (minted === cb.id) return null;
        onRewrite?.(minter.rewritten);
        return replaceEventData(block, JSON.stringify({ ...parsed, content_block: { ...cb, id: minted } }));
      };

      const processFrames = () => {
        for (;;) {
          const separator = eventSeparator(buffered);
          if (!separator) return;
          const block = buffered.slice(0, separator.at);
          const tail = buffered.slice(separator.at, separator.at + separator.length);
          buffered = buffered.slice(separator.at + separator.length);
          const rewritten = rewriteOne(block);
          push((rewritten ?? block) + tail);
        }
      };

      try {
        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          buffered += decoder.decode(value, { stream: true });
          processFrames();
        }
        buffered += decoder.decode();
        processFrames();
        // A truncated final event is outside this seam; preserve it verbatim.
        push(buffered);
      } catch (e) {
        // Release what is held before reporting: an id fix must never turn a transport failure
        // into deleted content. Same contract as `stripThinkTagsInStream`.
        buffered += decoder.decode();
        processFrames();
        push(buffered);
        const message = e instanceof Error ? e.message : String(e);
        push(`event: error\ndata: ${JSON.stringify({ type: "error", error: { type: "api_error", message: `llm-relay: stream failed: ${message}` } })}\n\n`);
      } finally {
        controller.close();
      }
    },
  });
}
