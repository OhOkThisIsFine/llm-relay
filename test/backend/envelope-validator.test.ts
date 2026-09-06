import { describe, expect, it } from "vitest";
import { invalidEnvelopeReason, type ResponseProtocol } from "../../src/backend/envelope-validator.js";

/**
 * The protocol-by-streamed-by-shape table HOTSPOT-10 asks for.
 *
 * Before the move this function was private to `backend.ts`, so every one of its branches was
 * reached only through a whole fetch. That is enough to prove the transport works and not enough
 * to prove the validator does: a branch that returned the WRONG reason, or `null` where it should
 * refuse, is invisible from outside because the caller only asks "did it pass".
 *
 * ⚠ The reason strings are asserted verbatim on purpose. They are not debug text — a streamed
 * refusal reaches `stream-commit.ts`, decides whether the walk fails over, and its message is
 * carried into the served error. Loosening these to `toBeTruthy()` would let a rename pass.
 */

type Row = {
  readonly name: string;
  readonly protocol: ResponseProtocol;
  readonly streamed: boolean;
  readonly value: unknown;
  readonly expected: string | null;
};

const OPENAI: ResponseProtocol = "openai-chat";
const ANTHROPIC: ResponseProtocol = "anthropic-messages";

const ROWS: readonly Row[] = [
  // Shape gate, before either protocol is consulted.
  { name: "a non-object", protocol: OPENAI, streamed: false, value: 42, expected: "expected a JSON object" },
  { name: "null", protocol: ANTHROPIC, streamed: true, value: null, expected: "expected a JSON object" },
  { name: "an array", protocol: OPENAI, streamed: true, value: [], expected: "expected a JSON object" },

  // An in-band error opening a 2xx stream is a dead turn, and the excerpt is bounded.
  {
    name: "a streamed in-band error carrying a message",
    protocol: OPENAI,
    streamed: true,
    value: { error: { message: "rate limited" } },
    expected: "stream opened with an in-band error event: rate limited",
  },
  {
    name: "a streamed in-band error carrying no message",
    protocol: ANTHROPIC,
    streamed: true,
    value: { error: {} },
    expected: "stream opened with an in-band error event",
  },
  {
    name: "a BUFFERED error envelope, which this gate deliberately does not claim",
    protocol: OPENAI,
    streamed: false,
    value: { choices: [{ message: { content: "hi" } }], error: { message: "ignored here" } },
    expected: null,
  },

  // OpenAI Chat.
  { name: "openai chat with no choices array", protocol: OPENAI, streamed: false, value: {}, expected: "missing choices array" },
  { name: "openai chat with empty choices, buffered", protocol: OPENAI, streamed: false, value: { choices: [] }, expected: "empty choices array" },
  {
    name: "openai chat with empty choices and usage, streamed",
    protocol: OPENAI,
    streamed: true,
    value: { choices: [], usage: { prompt_tokens: 1 } },
    expected: null,
  },
  {
    name: "openai chat with empty choices and no usage, streamed",
    protocol: OPENAI,
    streamed: true,
    value: { choices: [] },
    expected: "empty choices without usage",
  },
  { name: "openai chat whose choice is not an object", protocol: OPENAI, streamed: false, value: { choices: ["x"] }, expected: "choice is not an object" },
  { name: "openai chat missing delta, streamed", protocol: OPENAI, streamed: true, value: { choices: [{}] }, expected: "choice is missing delta" },
  { name: "openai chat missing message, buffered", protocol: OPENAI, streamed: false, value: { choices: [{}] }, expected: "choice is missing message" },
  {
    name: "openai chat whose tool_calls is not an array",
    protocol: OPENAI,
    streamed: false,
    value: { choices: [{ message: { content: "", tool_calls: "nope" } }] },
    expected: "message tool_calls is not an array",
  },
  {
    name: "openai chat whose tool call has no function object",
    protocol: OPENAI,
    streamed: false,
    value: { choices: [{ message: { content: "", tool_calls: [{}] } }] },
    expected: "invalid tool call",
  },
  {
    name: "openai chat whose tool function is mistyped",
    protocol: OPENAI,
    streamed: false,
    value: { choices: [{ message: { content: "", tool_calls: [{ function: { name: 1, arguments: "{}" } }] } }] },
    expected: "invalid tool function",
  },
  {
    name: "openai chat with neither content nor tool calls",
    protocol: OPENAI,
    streamed: false,
    value: { choices: [{ message: {} }] },
    expected: "message has neither content nor tool calls",
  },
  {
    name: "openai chat with null content, which is a valid tool-call turn",
    protocol: OPENAI,
    streamed: false,
    value: { choices: [{ message: { content: null, tool_calls: [{ function: { name: "f", arguments: "{}" } }] } }] },
    expected: null,
  },
  { name: "openai chat with a plain delta, streamed", protocol: OPENAI, streamed: true, value: { choices: [{ delta: { content: "hi" } }] }, expected: null },

  // Anthropic Messages, buffered.
  { name: "anthropic buffered with no content array", protocol: ANTHROPIC, streamed: false, value: {}, expected: "missing content array" },
  { name: "anthropic buffered with an untyped block", protocol: ANTHROPIC, streamed: false, value: { content: [{}] }, expected: "invalid content block" },
  {
    name: "anthropic buffered with a text block that has no text",
    protocol: ANTHROPIC,
    streamed: false,
    value: { content: [{ type: "text" }] },
    expected: "text block is missing text",
  },
  {
    name: "anthropic buffered with a tool_use block that has no name",
    protocol: ANTHROPIC,
    streamed: false,
    value: { content: [{ type: "tool_use" }] },
    expected: "tool_use block is missing name",
  },
  { name: "anthropic buffered, well formed", protocol: ANTHROPIC, streamed: false, value: { content: [{ type: "text", text: "hi" }] }, expected: null },

  // Anthropic Messages, streamed: the event table decides.
  { name: "anthropic streamed with an unknown event type", protocol: ANTHROPIC, streamed: true, value: { type: "nope" }, expected: "missing or unknown Anthropic event type" },
  { name: "anthropic streamed with no type at all", protocol: ANTHROPIC, streamed: true, value: {}, expected: "missing or unknown Anthropic event type" },
  { name: "anthropic streamed ping, which carries no field", protocol: ANTHROPIC, streamed: true, value: { type: "ping" }, expected: null },
  { name: "anthropic streamed message_stop, which carries no field", protocol: ANTHROPIC, streamed: true, value: { type: "message_stop" }, expected: null },
  {
    name: "anthropic streamed message_start carrying its message",
    protocol: ANTHROPIC,
    streamed: true,
    value: { type: "message_start", message: { id: "m" } },
    expected: null,
  },
  {
    name: "anthropic streamed message_start missing its message",
    protocol: ANTHROPIC,
    streamed: true,
    value: { type: "message_start" },
    expected: "message_start is missing message",
  },
  {
    name: "anthropic streamed content_block_delta missing its delta",
    protocol: ANTHROPIC,
    streamed: true,
    value: { type: "content_block_delta" },
    expected: "content_block_delta is missing delta",
  },
];

describe("invalidEnvelopeReason", () => {
  it.each(ROWS.map((row) => [row.name, row] as const))("reports %s", (_name, row) => {
    expect(invalidEnvelopeReason(row.value, row.protocol, row.streamed)).toBe(row.expected);
  });

  /**
   * The table above is the coverage claim, so this asserts the claim is not hollow: every row
   * that expects a refusal must produce a DISTINCT reason where the source distinguishes one, and
   * at least one row per protocol must pass. Without it a validator that returned the same string
   * for everything would satisfy every individual row that expects that string.
   */
  it("distinguishes its refusals rather than returning one catch-all", () => {
    const refusals = ROWS.filter((row) => row.expected !== null).map((row) => row.expected);
    expect(new Set(refusals).size).toBeGreaterThan(10);
    expect(ROWS.filter((row) => row.expected === null && row.protocol === OPENAI).length).toBeGreaterThan(0);
    expect(ROWS.filter((row) => row.expected === null && row.protocol === ANTHROPIC).length).toBeGreaterThan(0);
  });
});
