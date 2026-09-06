import { describe, expect, it } from "vitest";
import { detectDialect, recoverToolCalls, scanForMarker } from "../src/tool-dialects.js";

/**
 * The destructive-tool filter these fixtures pass at the dialect-rescue commit points. Refusing
 * nothing is the right default HERE: these tests cover translation and recovery, and the refusal
 * itself has its own suite (test/dialect-destructive-refusal.test.ts). It is a REQUIRED parameter
 * on `recoverToolCalls` / `fetchBackend` / `fetchOpenAiFront` so a new rescue seam cannot omit the
 * policy silently — which is exactly why it has to be spelled out here rather than defaulted.
 */
const NO_DESTRUCTIVE = (): boolean => false;

const schemas = new Map([
  ["write_note", { type: "object", properties: { path: { type: "string" }, count: { type: "number" }, force: { type: "boolean" } } }],
]);

describe("tool-call dialect recovery", () => {
  it("recovers a DSML invoke envelope that a host returned as text", () => {
    // The measured 2026-08-08 failure: the model did the work, then emitted this as its whole
    // visible response because the host never parsed it into `tool_calls`.
    const text =
      `I'll write the note.\n` +
      `<｜DSML｜tool_calls><｜DSML｜invoke name="write_note">` +
      `<｜DSML｜parameter name="path">a.txt</｜DSML｜parameter>` +
      `<｜DSML｜parameter name="count">42</｜DSML｜parameter>` +
      `<｜DSML｜parameter name="force">true</｜DSML｜parameter>` +
      `</｜DSML｜invoke></｜DSML｜tool_calls>`;

    const out = recoverToolCalls(text, schemas, NO_DESTRUCTIVE);
    expect(out.status).toBe("parsed");
    if (out.status !== "parsed") return;
    expect(out.dialect).toBe("dsml");
    expect(out.calls).toEqual([
      { name: "write_note", input: { path: "a.txt", count: 42, force: true } },
    ]);
    // The surviving prose stays a text block; only the envelope is removed.
    expect(out.text).toBe("I'll write the note.");
  });

  it("coerces parameters using the DECLARED schema, never by guessing", () => {
    const text = `<invoke name="write_note"><parameter name="count">42</parameter></invoke>`;
    // With a schema, "42" becomes a number.
    const typed = recoverToolCalls(text, schemas, NO_DESTRUCTIVE);
    expect(typed.status === "parsed" && typed.calls[0]?.input.count).toBe(42);

    // Without one, it stays the literal the model wrote. Inventing a type here would silently
    // rewrite an argument the model may have meant as text — and the validator reporting a type
    // error is the correct visible failure.
    const untyped = recoverToolCalls(text, new Map(), NO_DESTRUCTIVE);
    expect(untyped.status === "parsed" && untyped.calls[0]?.input.count).toBe("42");
  });

  it("recovers the DeepSeek native and Hermes forms", () => {
    const deepseek =
      `<｜tool▁calls▁begin｜><｜tool▁call▁begin｜>function<｜tool▁sep｜>write_note\n` +
      "```json\n" + `{"path":"a.txt"}` + "\n```" +
      `<｜tool▁call▁end｜><｜tool▁calls▁end｜>`;
    const d = recoverToolCalls(deepseek, schemas, NO_DESTRUCTIVE);
    expect(d.status === "parsed" && d.calls).toEqual([{ name: "write_note", input: { path: "a.txt" } }]);

    const hermes = `<tool_call>{"name":"write_note","arguments":{"path":"a.txt"}}</tool_call>`;
    const h = recoverToolCalls(hermes, schemas, NO_DESTRUCTIVE);
    expect(h.status === "parsed" && h.calls).toEqual([{ name: "write_note", input: { path: "a.txt" } }]);
  });

  /**
   * CLONE-26, owner ruling 2026-09-05, option A. `fromDeepSeekForm` used to commit a call whose
   * arguments it could not honestly read: a scalar payload became an EMPTY argument object, and an
   * array was cast to a `Record` it is not. Both are the relay deciding what the model meant, which
   * is the inference this whole module refuses. Both now discard that dialect's contribution and
   * the turn fails clean to `detected`, so failover reaches a host that parses — the strictness
   * `fromKimiTokenForm` has carried all along.
   *
   * ⚠ Accepted cost, recorded so it is not rediscovered as a bug: one malformed block now discards
   * well-formed DeepSeek calls found EARLIER in the same message. That is the same whole-or-nothing
   * rule the destructive filter already follows.
   */
  const deepSeekPayload = (payload: string): string =>
    `<｜tool▁calls▁begin｜><｜tool▁call▁begin｜>function<｜tool▁sep｜>write_note\n` +
    "```json\n" + payload + "\n```" +
    `<｜tool▁call▁end｜><｜tool▁calls▁end｜>`;

  it.each([
    ["a number", "42"],
    ["a string", `"ls -la"`],
    ["a boolean", "true"],
    ["null", "null"],
    ["an array", "[1,2]"],
  ])("discards a DeepSeek payload that parses to %s", (_label, payload) => {
    const out = recoverToolCalls(deepSeekPayload(payload), schemas, NO_DESTRUCTIVE);
    expect(out.status).toBe("detected");
    expect(out.status === "detected" && out.dialect).toBe("deepseek");
  });

  /**
   * The negative control, and it is load-bearing. Without it every assertion above would also pass
   * on a parser that discarded EVERY DeepSeek payload — which would break the dialect rather than
   * tighten it. Restoring the lenient branch turns the cases above red and leaves this one green.
   */
  it("leaves a well-formed DeepSeek object payload untouched", () => {
    const out = recoverToolCalls(deepSeekPayload(`{"path":"a.txt"}`), schemas, NO_DESTRUCTIVE);
    expect(out.status === "parsed" && out.calls).toEqual([
      { name: "write_note", input: { path: "a.txt" } },
    ]);
  });

  /**
   * Owner ruling 2026-09-06. The destructive check runs BEFORE the argument check.
   *
   * ⚠ CLONE-26 (2026-09-05) made three parsers discard a call whose arguments are not a JSON
   * object. That silently moved WHEN the destructive filter fires, because the filter used to read
   * the calls a parser had COMMITTED — so discarding the payload removed the name from its view
   * entirely. A `Bash` call the relay had recognised in model TEXT stopped being refused and became
   * an ordinary unparseable envelope: still a 502, but blamed upstream, retried across the whole
   * pool, and charged against that provider's health.
   *
   * The refusal is about the relay having recognised a destructive call in TEXT at all. Whether its
   * arguments happened to parse is a separate question, and it must not gate the refusal.
   */
  const REFUSES_BASH = (name: string): boolean => name.toLowerCase() === "bash";

  const kimiPayload = (name: string, payload: string): string =>
    `<|tool_call_begin|>functions.${name}:0<|tool_call_argument_begin|>${payload}<|tool_call_end|>`;
  const functionTagPayload = (name: string, payload: string): string =>
    `<function=${name}>${payload}</function>`;

  it.each([
    ["a DeepSeek scalar payload", `<｜tool▁calls▁begin｜><｜tool▁call▁begin｜>function<｜tool▁sep｜>Bash\n` + "```json\n42\n```" + `<｜tool▁call▁end｜><｜tool▁calls▁end｜>`],
    ["a DeepSeek array payload", `<｜tool▁calls▁begin｜><｜tool▁call▁begin｜>function<｜tool▁sep｜>Bash\n` + "```json\n[1,2]\n```" + `<｜tool▁call▁end｜><｜tool▁calls▁end｜>`],
    ["an unparseable DeepSeek payload", `<｜tool▁calls▁begin｜><｜tool▁call▁begin｜>function<｜tool▁sep｜>Bash\n` + "```json\n{oops\n```" + `<｜tool▁call▁end｜><｜tool▁calls▁end｜>`],
    ["a Kimi scalar payload", kimiPayload("Bash", "42")],
    ["an unparseable Kimi payload", kimiPayload("Bash", "{oops")],
    ["an unparseable function-tag payload", functionTagPayload("Bash", "{oops")],
  ])("refuses a destructive name recognised alongside %s", (_label, text) => {
    const out = recoverToolCalls(text, schemas, REFUSES_BASH);
    expect(out.status).toBe("refused-destructive");
    expect(out.status === "refused-destructive" && out.refused).toEqual(["Bash"]);
  });

  /**
   * The two negative controls that stop this from being "refuse everything".
   *
   * The first keeps CLONE-26 intact: a NON-destructive name with a malformed payload still commits
   * nothing and still fails clean to `detected`, so failover reaches a host that parses. The second
   * is the case that always worked and must keep working.
   */
  it("still discards a non-destructive malformed payload rather than refusing it", () => {
    const out = recoverToolCalls(deepSeekPayload("42"), schemas, REFUSES_BASH);
    expect(out.status).toBe("detected");
  });

  it("still refuses a WELL-FORMED destructive call, as it always did", () => {
    const text =
      `<｜tool▁calls▁begin｜><｜tool▁call▁begin｜>function<｜tool▁sep｜>Bash\n` +
      "```json\n" + `{"command":"ls"}` + "\n```" +
      `<｜tool▁call▁end｜><｜tool▁calls▁end｜>`;
    const out = recoverToolCalls(text, schemas, REFUSES_BASH);
    expect(out.status).toBe("refused-destructive");
  });

  it("reports a TRUNCATED envelope as detected, and never guesses a call out of it", () => {
    // The other measured failure: 70 bytes, the tail of a stream. There is no call to recover
    // here — the caller must fail clean so failover reaches a host that parses, rather than
    // returning a fragment the client will treat as a final answer.
    const out = recoverToolCalls(`</｜DSML｜parameter></｜DSML｜invoke></｜DSML｜tool_calls>`, schemas, NO_DESTRUCTIVE);
    expect(out.status).toBe("detected");
    expect(out.status === "detected" && out.dialect).toBe("dsml");
  });

  it("leaves ordinary prose alone, including prose that names a tool", () => {
    // ⚠ The boundary: mentioning a tool is not calling one. Promoting this would be fabricating
    // intent, which is the one thing the repair path must never do.
    const prose = "You could use write_note to save that, or call the <b>helper</b> function.";
    expect(recoverToolCalls(prose, schemas, NO_DESTRUCTIVE)).toEqual({ status: "none" });
    expect(detectDialect(prose)).toBeNull();
  });

  it("recovers several calls from one envelope", () => {
    const text =
      `<invoke name="write_note"><parameter name="path">a.txt</parameter></invoke>` +
      `<invoke name="write_note"><parameter name="path">b.txt</parameter></invoke>`;
    const out = recoverToolCalls(text, schemas, NO_DESTRUCTIVE);
    expect(out.status === "parsed" && out.calls.map((c) => c.input.path)).toEqual(["a.txt", "b.txt"]);
  });

  it("strips a bare <think> wrapper without inventing a call", () => {
    // `<think` alone was one of the two observed failure bodies. It carries no call, so it must
    // not parse as one — but it is also not a dialect marker on its own.
    expect(recoverToolCalls("<think>reasoning</think>Done.", schemas, NO_DESTRUCTIVE)).toEqual({ status: "none" });
  });
});

describe("kimi ASCII token dialect (adoption review §1.8)", () => {
  // A different grammar from the fullwidth DeepSeek form, not a spelling variant: section
  // wrappers, the name riding in a `functions.NAME:IDX` id token, an argument-begin separator.
  it("parses a full envelope, name and args recovered, prose preserved", () => {
    const text =
      'Let me update that.\n<|tool_calls_section_begin|><|tool_call_begin|>functions.get_weather:0' +
      '<|tool_call_argument_begin|>{"city":"Paris"}<|tool_call_end|><|tool_calls_section_end|>';
    const out = recoverToolCalls(text, new Map(), NO_DESTRUCTIVE);
    expect(out.status).toBe("parsed");
    if (out.status !== "parsed") return;
    expect(out.dialect).toBe("kimi");
    expect(out.calls).toEqual([{ name: "get_weather", input: { city: "Paris" } }]);
    expect(out.text).toBe("Let me update that.");
  });

  it("parses multiple calls in one section", () => {
    const text =
      '<|tool_calls_section_begin|>' +
      '<|tool_call_begin|>functions.a:0<|tool_call_argument_begin|>{"x":1}<|tool_call_end|>' +
      '<|tool_call_begin|>functions.b:1<|tool_call_argument_begin|>{"y":2}<|tool_call_end|>' +
      '<|tool_calls_section_end|>';
    const out = recoverToolCalls(text, new Map(), NO_DESTRUCTIVE);
    expect(out.status).toBe("parsed");
    if (out.status !== "parsed") return;
    expect(out.calls.map((c) => c.name)).toEqual(["a", "b"]);
  });

  it("an opaque id token leaves no way to know WHICH tool was meant — detected, never guessed", () => {
    const text =
      '<|tool_call_begin|>chatcmpl-tool-9f3a:0<|tool_call_argument_begin|>{"city":"Paris"}<|tool_call_end|>';
    expect(recoverToolCalls(text, new Map(), NO_DESTRUCTIVE)).toEqual({ status: "detected", dialect: "kimi" });
  });

  it("a truncated envelope is detected, so the caller fails clean instead of answering with markup", () => {
    const text = '<|tool_calls_section_begin|><|tool_call_begin|>functions.get_weather:0<|tool_call_argument_begin|>{"ci';
    expect(recoverToolCalls(text, new Map(), NO_DESTRUCTIVE)).toEqual({ status: "detected", dialect: "kimi" });
  });

  it("streaming holdback covers a split ASCII marker", () => {
    const { safeLen, hit } = scanForMarker("some prose <|tool_call_beg");
    expect(hit).toBe(false);
    expect(safeLen).toBeLessThanOrEqual("some prose <".length);
  });
});
