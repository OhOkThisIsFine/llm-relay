/**
 * Recovering tool calls a HOST failed to parse.
 *
 * A model emits tool calls in its own dialect; the serving host is supposed to parse that into the
 * OpenAI `message.tool_calls` field. NIM and OpenRouter do. Some free hosts do not, and hand back
 * the raw envelope as ordinary assistant TEXT. Before this module the consequence was silent and
 * total: no `tool_calls` ⇒ `stop_reason: end_turn` ⇒ zero `tool_use` blocks ⇒ the validator finds
 * nothing malformed and PASSES ⇒ repair never engages ⇒ the client receives markup it treats as a
 * final answer. Measured 2026-08-08: a task wrote its output correctly and then emitted
 * `</｜DSML｜parameter></｜DSML｜invoke></｜DSML｜tool_calls>` as its entire visible response.
 * See docs/tool-call-dialect-leak.md.
 *
 * ⚠ This is PARSING, not inference — the same side of the repair boundary as fixing args that
 * violate a schema. The envelope set is CLOSED (same reasoning as the effort vocabulary in
 * sync-tiers.mjs and the alias list in authEnv.ts): prose that merely mentions a tool name is not a
 * tool call, and promoting it to one would be fabricating intent, which is the one thing the repair
 * path must never do. A dialect we do not recognize yields `detected` at most, never a guess.
 */

/** JSON Schema fragment, only the parts used to coerce a stringly-typed parameter. */
interface SchemaLike {
  type?: unknown;
  properties?: Record<string, SchemaLike>;
  items?: SchemaLike;
}

export interface DialectToolCall {
  name: string;
  input: Record<string, unknown>;
}

export type DialectOutcome =
  /** No tool-call framing present. The text is just text. */
  | { status: "none" }
  /** Framing found and fully parsed. `text` is what remains after removing the envelope. */
  | { status: "parsed"; calls: DialectToolCall[]; text: string; dialect: string }
  /**
   * Framing markers present but unparseable — truncated mid-stream, or a dialect variant we do not
   * model. NEVER guessed at: the caller fails clean so failover reaches a host that parses.
   */
  | { status: "detected"; dialect: string };

/**
 * Marker substrings that mean "a tool-call envelope is present". Detection is deliberately broader
 * than parsing: a truncated envelope must still be recognized as one, because returning its
 * fragment as an answer is what made this failure read as "the job died".
 */
/**
 * ⚠ Markers deliberately omit the `<` / `</` prefix so a CLOSING tag matches too. The truncated
 * tail of a stream is mostly closing tags — one of the two measured failure bodies was exactly
 * `</｜DSML｜parameter></｜DSML｜invoke></｜DSML｜tool_calls>`, which an open-tag-only marker set
 * reports as ordinary prose. That is the single case where detection matters most, because there
 * is no call left to recover and the alternative is handing the fragment back as an answer.
 */
const DIALECT_MARKERS: ReadonlyArray<{ dialect: string; markers: readonly string[] }> = [
  { dialect: "deepseek", markers: ["｜tool▁calls▁begin｜", "｜tool▁call▁begin｜", "｜tool▁sep｜", "｜tool▁call▁end｜", "｜tool▁calls▁end｜"] },
  // The ASCII-pipe token family (Kimi-K2 and friends) is a DIFFERENT grammar from the fullwidth
  // DeepSeek form above, not a spelling variant: section wrappers, the name riding in a
  // `functions.NAME:IDX` id token, and an argument-begin separator. Observed in production on the
  // same free pool (fork-validated in freellmapi's rescue). Adoption review §1.8.
  {
    dialect: "kimi",
    markers: [
      "|tool_calls_section_begin|",
      "|tool_call_begin|",
      "|tool_call_argument_begin|",
      "|tool_call_end|",
      "|tool_calls_section_end|",
    ],
  },
  { dialect: "dsml", markers: ["｜DSML｜tool_calls", "｜DSML｜invoke", "｜DSML｜parameter"] },
  { dialect: "hermes", markers: ["<tool_call>", "</tool_call>"] },
  { dialect: "xml-invoke", markers: ["<function_calls>", "</function_calls>", "<invoke name=", "</invoke>"] },
  { dialect: "functionary", markers: ["<function="] },
];

export function detectDialect(text: string): string | null {
  for (const { dialect, markers } of DIALECT_MARKERS) {
    if (markers.some((m) => text.includes(m))) return dialect;
  }
  return null;
}

const ALL_MARKERS: readonly string[] = DIALECT_MARKERS.flatMap((d) => d.markers);
const LONGEST_MARKER = Math.max(...ALL_MARKERS.map((m) => m.length));

/**
 * How much of a partial text stream is safe to forward, and whether a marker has landed.
 *
 * The streaming-needle problem: a marker arrives split across SSE deltas, so forwarding each delta
 * as it comes would emit the first half of an envelope before we know it is one. `safeLen` is
 * everything except the longest trailing run that could still GROW into a marker, so the caller can
 * stream normally while never emitting into an envelope it is about to capture.
 *
 * ⚠ The holdback is bounded by the longest marker, so ordinary prose containing `<` streams with at
 * most that many characters of lag — it does not degrade into buffering the whole response, which
 * would trade this bug for a latency regression on every tool-bearing request.
 */
export function scanForMarker(text: string): { safeLen: number; hit: boolean } {
  if (ALL_MARKERS.some((m) => text.includes(m))) return { safeLen: text.length, hit: true };
  const start = Math.max(0, text.length - (LONGEST_MARKER - 1));
  for (let i = start; i < text.length; i++) {
    const tail = text.slice(i);
    if (ALL_MARKERS.some((m) => m.startsWith(tail))) return { safeLen: i, hit: false };
  }
  return { safeLen: text.length, hit: false };
}

/**
 * Index at which a marker begins, for splitting emitted prose from a captured envelope.
 *
 * ⚠ Backs up over the tag opener. Markers deliberately omit the `<` / `</` prefix so a CLOSING tag
 * matches, which means a `｜DSML｜tool_calls` hit points one character PAST the real start. Capturing
 * from there left the `<` behind as prose and handed `stripEnvelopes` a tag it no longer recognized,
 * so the envelope's outer wrapper survived into the recovered text.
 */
export function markerStart(text: string): number {
  let best = -1;
  for (const m of ALL_MARKERS) {
    const i = text.indexOf(m);
    if (i >= 0 && (best === -1 || i < best)) best = i;
  }
  if (best <= 0) return best;
  if (text.startsWith("</", Math.max(0, best - 2)) && best >= 2) return best - 2;
  if (text[best - 1] === "<") return best - 1;
  return best;
}

/** Coerce a stringly-typed dialect parameter using the tool's declared schema. */
function coerce(raw: string, schema: SchemaLike | undefined): unknown {
  const t = Array.isArray(schema?.type) ? schema?.type[0] : schema?.type;
  const s = raw.trim();
  switch (t) {
    case "number":
    case "integer": {
      const n = Number(s);
      return Number.isFinite(n) ? n : raw;
    }
    case "boolean":
      return s === "true" ? true : s === "false" ? false : raw;
    case "object":
    case "array":
      try { return JSON.parse(s); } catch { return raw; }
    case "string":
      return raw;
    default:
      // No declared type: keep the literal. Guessing a shape here would silently rewrite an
      // argument the model meant as text.
      return raw;
  }
}

/** `{"name": "x", "arguments": {...}}` — the JSON payload shape shared by several dialects. */
function fromJsonPayload(raw: string): DialectToolCall | null {
  let j: unknown;
  try { j = JSON.parse(raw.trim()); } catch { return null; }
  if (typeof j !== "object" || j === null) return null;
  const o = j as Record<string, unknown>;
  const name = typeof o.name === "string" ? o.name : null;
  if (!name) return null;
  const args = o.arguments ?? o.parameters ?? o.input ?? {};
  if (typeof args === "string") {
    try { return { name, input: JSON.parse(args) as Record<string, unknown> }; } catch { return null; }
  }
  if (typeof args !== "object" || args === null) return null;
  return { name, input: args as Record<string, unknown> };
}

/** `<invoke name="x"><parameter name="p">v</parameter></invoke>`, with or without DSML markers. */
function fromInvokeForm(text: string, schemas: Map<string, SchemaLike>): DialectToolCall[] {
  const calls: DialectToolCall[] = [];
  const invoke = /<(?:｜DSML｜)?invoke\s+name="([^"]+)"\s*>([\s\S]*?)<\/(?:｜DSML｜)?invoke>/g;
  for (const m of text.matchAll(invoke)) {
    const name = m[1];
    const bodyText = m[2];
    if (!name || bodyText === undefined) continue;
    const input: Record<string, unknown> = {};
    const param = /<(?:｜DSML｜)?parameter\s+name="([^"]+)"\s*>([\s\S]*?)<\/(?:｜DSML｜)?parameter>/g;
    for (const p of bodyText.matchAll(param)) {
      const key = p[1];
      const value = p[2];
      if (!key || value === undefined) continue;
      input[key] = coerce(value, schemas.get(name)?.properties?.[key]);
    }
    calls.push({ name, input });
  }
  return calls;
}

/** DeepSeek native: `…begin｜>function<｜tool▁sep｜>NAME\n```json\n{…}\n``` `. */
function fromDeepSeekForm(text: string): DialectToolCall[] {
  const calls: DialectToolCall[] = [];
  const re = /<｜tool▁sep｜>([^\n<]+)\n+(?:```(?:json)?\n)?([\s\S]*?)(?:\n?```)?\s*<｜tool▁call▁end｜>/g;
  for (const m of text.matchAll(re)) {
    const name = m[1];
    const payload = m[2];
    if (!name || payload === undefined) continue;
    let input: Record<string, unknown> = {};
    try {
      const parsed = JSON.parse(payload.trim()) as unknown;
      if (typeof parsed === "object" && parsed !== null) input = parsed as Record<string, unknown>;
    } catch { /* an unparseable body leaves `detected` to the caller */ return []; }
    calls.push({ name: name.trim(), input });
  }
  return calls;
}

/** Kimi ASCII token blocks: `<|tool_call_begin|>functions.NAME:0<|tool_call_argument_begin|>{…}<|tool_call_end|>`. */
function fromKimiTokenForm(text: string): DialectToolCall[] {
  const calls: DialectToolCall[] = [];
  const re = /<\|tool_call_begin\|>\s*([\s\S]*?)\s*<\|tool_call_argument_begin\|>\s*([\s\S]*?)\s*<\|tool_call_end\|>/g;
  for (const m of text.matchAll(re)) {
    const idToken = m[1];
    const payload = m[2];
    if (!idToken || payload === undefined) continue;
    // The function name rides in the id token as `functions.NAME:IDX`. Some models degrade it to
    // an opaque id (observed upstream: `chatcmpl-tool-<hex>`), which leaves no way to know WHICH
    // tool was meant — unparseable, so the whole recovery fails clean to `detected` rather than
    // guessing a target.
    const nameMatch = /^functions\.([A-Za-z0-9_.-]+):\d+$/.exec(idToken.trim());
    if (!nameMatch) return [];
    try {
      const parsed = JSON.parse(payload.trim()) as unknown;
      if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return [];
      calls.push({ name: nameMatch[1]!, input: parsed as Record<string, unknown> });
    } catch {
      return [];
    }
  }
  return calls;
}

/** `<tool_call>{json}</tool_call>` (Hermes/Qwen) and `<function=NAME>{json}</function>`. */
function fromTaggedJsonForms(text: string): DialectToolCall[] {
  const calls: DialectToolCall[] = [];
  for (const m of text.matchAll(/<tool_call>([\s\S]*?)<\/tool_call>/g)) {
    if (m[1] === undefined) continue;
    const c = fromJsonPayload(m[1]);
    if (c) calls.push(c);
  }
  for (const m of text.matchAll(/<function=([^>]+)>([\s\S]*?)<\/function>/g)) {
    const name = m[1];
    const payload = m[2];
    if (!name || payload === undefined) continue;
    let input: Record<string, unknown> = {};
    try {
      const parsed = JSON.parse(payload.trim()) as unknown;
      if (typeof parsed === "object" && parsed !== null) input = parsed as Record<string, unknown>;
    } catch { continue; }
    calls.push({ name: name.trim(), input });
  }
  return calls;
}

/** Everything the envelope occupied, so the surviving prose can stay a text block. */
function stripEnvelopes(text: string): string {
  return text
    .replace(/<(?:｜DSML｜)?function_calls>[\s\S]*?<\/(?:｜DSML｜)?function_calls>/g, "")
    .replace(/<｜DSML｜tool_calls>[\s\S]*?(?:<\/｜DSML｜tool_calls>|$)/g, "")
    .replace(/<(?:｜DSML｜)?invoke\s+name="[^"]*"\s*>[\s\S]*?<\/(?:｜DSML｜)?invoke>/g, "")
    .replace(/<｜tool▁calls▁begin｜>[\s\S]*?(?:<｜tool▁calls▁end｜>|$)/g, "")
    .replace(/<\|tool_calls_section_begin\|>[\s\S]*?(?:<\|tool_calls_section_end\|>|$)/g, "")
    .replace(/<\|tool_call_begin\|>[\s\S]*?(?:<\|tool_call_end\|>|$)/g, "")
    .replace(/<tool_call>[\s\S]*?<\/tool_call>/g, "")
    .replace(/<function=[^>]+>[\s\S]*?<\/function>/g, "")
    .replace(/<\/?think>/g, "")
    .trim();
}

/**
 * Recover tool calls from a text block a host failed to parse.
 *
 * `schemas` supplies declared parameter types for the dialects that carry parameters as strings;
 * without it those values stay strings and the validator reports the type error, which is the
 * correct visible failure rather than a silent coercion.
 */
export function recoverToolCalls(
  text: string,
  schemas: Map<string, SchemaLike> = new Map(),
): DialectOutcome {
  const dialect = detectDialect(text);
  if (!dialect) return { status: "none" };

  const calls = [
    ...fromInvokeForm(text, schemas),
    ...fromDeepSeekForm(text),
    ...fromKimiTokenForm(text),
    ...fromTaggedJsonForms(text),
  ].filter((c) => c.name.length > 0);

  if (calls.length === 0) return { status: "detected", dialect };
  return { status: "parsed", calls, text: stripEnvelopes(text), dialect };
}
