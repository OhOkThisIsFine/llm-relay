import { describe, it, expect } from "vitest";
import { openaiResponsesRequestToAnthropic } from "../src/responses-request.js";
import { RequestMappingError } from "../src/openai-request.js";

/**
 * The pure OpenAI-Responses → Anthropic-Messages request mapper.
 *
 * llm-bridge's `openaiResponsesToUniversal` modelled `function_call_output` and nothing else: an
 * assistant `function_call` became an empty user turn (the tool call vanished, and the
 * `tool_result` that followed had nothing to answer), an assistant `output_text` reached the
 * backend as `JSON.stringify(part)`, a `reasoning` item became a bogus user turn, and
 * `instructions` was dropped. These pin each of those, plus the two refusals that exist so a
 * silently-wrong request cannot reach a provider.
 */
describe("openaiResponsesRequestToAnthropic", () => {
  const user = (text: string) => ({ role: "user", content: [{ type: "input_text", text }] });

  it("maps a plain string input to one user turn, with the carried max_tokens default", () => {
    const out = openaiResponsesRequestToAnthropic({ model: "m", input: "hi" });
    expect(out).toEqual({
      // Mandatory downstream; llm-bridge's default is carried, not measured.
      max_tokens: 1024,
      model: "m",
      messages: [{ role: "user", content: [{ type: "text", text: "hi" }] }],
    });
  });

  it("round-trips a tool call's id unchanged, in both id vocabularies", () => {
    // `anthropicMessageToOpenAi` mints `call_id` = the Anthropic `tool_use` id, so what comes back
    // is whatever the answering backend produced. Both spellings must survive byte-identically.
    for (const id of ["call_abc", "toolu_01A09q90qw90lq917835lq9"]) {
      const out = openaiResponsesRequestToAnthropic({
        model: "m",
        input: [
          user("find it"),
          { type: "function_call", call_id: id, name: "Grep", arguments: '{"pattern":"p"}' },
          { type: "function_call_output", call_id: id, output: "3 matches" },
        ],
      });
      expect(out.messages).toEqual([
        { role: "user", content: [{ type: "text", text: "find it" }] },
        { role: "assistant", content: [{ type: "tool_use", id, name: "Grep", input: { pattern: "p" } }] },
        { role: "user", content: [{ type: "tool_result", tool_use_id: id, content: "3 matches" }] },
      ]);
    }
  });

  it("merges an assistant message, its reasoning and its function_calls into ONE assistant turn", () => {
    // Codex's real shape: message -> reasoning -> function_call -> function_call. Anthropic wants
    // one assistant turn carrying the text and every tool_use, and the dropped reasoning item must
    // not split it in two.
    const out = openaiResponsesRequestToAnthropic({
      model: "m",
      input: [
        user("go"),
        { type: "message", role: "assistant", content: [{ type: "output_text", text: "on it" }] },
        { type: "reasoning", summary: [{ type: "summary_text", text: "private" }] },
        { type: "function_call", call_id: "c1", name: "A", arguments: "{}" },
        { type: "function_call", call_id: "c2", name: "B", arguments: "{}" },
      ],
    });
    expect(out.messages).toEqual([
      { role: "user", content: [{ type: "text", text: "go" }] },
      {
        role: "assistant",
        content: [
          { type: "text", text: "on it" },
          { type: "tool_use", id: "c1", name: "A", input: {} },
          { type: "tool_use", id: "c2", name: "B", input: {} },
        ],
      },
    ]);
    expect(JSON.stringify(out)).not.toContain("private");
  });

  it("merges consecutive function_call_outputs into one user turn, tool_results first", () => {
    const out = openaiResponsesRequestToAnthropic({
      model: "m",
      input: [
        { type: "function_call", call_id: "c1", name: "A", arguments: "{}" },
        { type: "function_call", call_id: "c2", name: "B", arguments: "{}" },
        { type: "function_call_output", call_id: "c1", output: "one" },
        { type: "function_call_output", call_id: "c2", output: "two" },
        // A user aside in the same turn must land AFTER the results — Anthropic requires the
        // tool_result blocks at the head of the turn that answers the tool_use turn.
        user("and also"),
      ],
    });
    expect(out.messages).toEqual([
      {
        role: "assistant",
        content: [
          { type: "tool_use", id: "c1", name: "A", input: {} },
          { type: "tool_use", id: "c2", name: "B", input: {} },
        ],
      },
      {
        role: "user",
        content: [
          { type: "tool_result", tool_use_id: "c1", content: "one" },
          { type: "tool_result", tool_use_id: "c2", content: "two" },
          { type: "text", text: "and also" },
        ],
      },
    ]);
  });

  it("carries a function_call_output's parts as tool_result content blocks", () => {
    const out = openaiResponsesRequestToAnthropic({
      model: "m",
      input: [{
        type: "function_call_output",
        call_id: "c1",
        output: [
          { type: "input_text", text: "see below" },
          { type: "input_image", image_url: "data:image/png;base64,AAAA" },
        ],
      }],
    });
    expect((out.messages as any[])[0].content[0]).toEqual({
      type: "tool_result",
      tool_use_id: "c1",
      content: [
        { type: "text", text: "see below" },
        { type: "image", source: { type: "base64", media_type: "image/png", data: "AAAA" } },
      ],
    });
  });

  it("maps a data-URL image to a base64 source and an http image to a url source", () => {
    const out = openaiResponsesRequestToAnthropic({
      model: "m",
      input: [{
        role: "user",
        content: [
          { type: "input_image", image_url: { url: "data:image/jpeg;base64,Zm9v" } },
          { type: "input_image", image_url: "https://example.test/a.png" },
        ],
      }],
    });
    expect((out.messages as any[])[0].content).toEqual([
      { type: "image", source: { type: "base64", media_type: "image/jpeg", data: "Zm9v" } },
      { type: "image", source: { type: "url", url: "https://example.test/a.png" } },
    ]);
  });

  it("refuses an image the relay cannot resolve rather than forwarding an unfetchable reference", () => {
    expect(() => openaiResponsesRequestToAnthropic({
      model: "m",
      input: [{ role: "user", content: [{ type: "input_image", file_id: "file_123" }] }],
    })).toThrow(RequestMappingError);
  });

  it("carries a base64 PDF input_file as a document and refuses every other file shape", () => {
    const ok = openaiResponsesRequestToAnthropic({
      model: "m",
      input: [{ role: "user", content: [{ type: "input_file", filename: "a.pdf", file_data: "data:application/pdf;base64,JVBER" }] }],
    });
    expect((ok.messages as any[])[0].content).toEqual([
      { type: "document", source: { type: "base64", media_type: "application/pdf", data: "JVBER" } },
    ]);
    // A bare payload with a .pdf filename states no media type; guessing one is the inference
    // this module refuses to make.
    expect(() => openaiResponsesRequestToAnthropic({
      model: "m",
      input: [{ role: "user", content: [{ type: "input_file", filename: "a.pdf", file_data: "JVBER" }] }],
    })).toThrow(/input_file has no Anthropic representation/);
  });

  it("treats absent or empty function_call arguments as the no-argument call, and refuses the rest", () => {
    const empty = openaiResponsesRequestToAnthropic({
      model: "m",
      input: [
        { type: "function_call", call_id: "c1", name: "A" },
        { type: "function_call", call_id: "c2", name: "B", arguments: "" },
      ],
    });
    expect((empty.messages as any[])[0].content.map((b: any) => b.input)).toEqual([{}, {}]);

    // Wrapping a non-object in a synthetic key would invent a schema the tool never declared.
    expect(() => openaiResponsesRequestToAnthropic({
      model: "m",
      input: [{ type: "function_call", call_id: "c1", name: "A", arguments: "not json" }],
    })).toThrow(/not valid JSON/);
    expect(() => openaiResponsesRequestToAnthropic({
      model: "m",
      input: [{ type: "function_call", call_id: "c1", name: "A", arguments: '"a string"' }],
    })).toThrow(/not a JSON object/);
  });

  it("refuses a function_call or function_call_output with no call_id — the linkage IS the id", () => {
    expect(() => openaiResponsesRequestToAnthropic({
      model: "m", input: [{ type: "function_call", name: "A", arguments: "{}" }],
    })).toThrow(/function_call without a call_id/);
    expect(() => openaiResponsesRequestToAnthropic({
      model: "m", input: [{ type: "function_call_output", output: "x" }],
    })).toThrow(/function_call_output without a call_id/);
  });

  it("puts instructions at the head of system and appends system/developer items with \\n", () => {
    const out = openaiResponsesRequestToAnthropic({
      model: "m",
      instructions: "you are terse",
      input: [
        { role: "developer", content: [{ type: "input_text", text: "project rules" }] },
        { role: "system", content: "house style" },
        user("hi"),
      ],
    });
    expect(out.system).toBe("you are terse\nproject rules\nhouse style");
    expect(out.messages).toEqual([{ role: "user", content: [{ type: "text", text: "hi" }] }]);
  });

  it("maps tools and the whole tool_choice table", () => {
    const base = {
      model: "m",
      input: [user("hi")],
      tools: [
        { type: "function", name: "Grep", description: "g", parameters: { type: "object", properties: { p: { type: "string" } } }, strict: true },
        // A hosted tool has no Anthropic representation and is dropped, as llm-bridge did.
        { type: "web_search_preview" },
        // A declaration with no schema means "no declared parameters".
        { type: "function", name: "Bare" },
      ],
    };
    const out = openaiResponsesRequestToAnthropic(base);
    expect(out.tools).toEqual([
      { name: "Grep", description: "g", input_schema: { type: "object", properties: { p: { type: "string" } } } },
      { name: "Bare", input_schema: { type: "object", properties: {} } },
    ]);

    const choice = (tool_choice: unknown, parallel?: boolean) =>
      openaiResponsesRequestToAnthropic({
        ...base,
        tool_choice,
        ...(parallel === undefined ? {} : { parallel_tool_calls: parallel }),
      }).tool_choice;
    expect(choice("auto")).toEqual({ type: "auto" });
    // OpenAI's "required" ("call some tool") is Anthropic's "any".
    expect(choice("required")).toEqual({ type: "any" });
    expect(choice("none")).toEqual({ type: "none" });
    expect(choice({ type: "function", name: "Grep" })).toEqual({ type: "tool", name: "Grep" });
    // An unrecognised shape is dropped, not guessed at: the default is `auto` either way.
    expect(choice({ type: "allowed_tools", mode: "auto", tools: [] })).toBeUndefined();
    expect(choice("auto", false)).toEqual({ type: "auto", disable_parallel_tool_use: true });
    // `none` calls no tool, so the parallel switch there is a field the API rejects.
    expect(choice("none", false)).toEqual({ type: "none" });
    // Without tools, tool_choice means nothing and Anthropic rejects it.
    expect(openaiResponsesRequestToAnthropic({ model: "m", input: [user("hi")], tool_choice: "auto" }).tool_choice)
      .toBeUndefined();
  });

  it("refuses what it cannot represent instead of quietly dropping it, and names the caller's own shape", () => {
    // A system/developer part with no text representation used to be skipped, delivering a system
    // prompt with a hole in it — which reads exactly like a working one.
    expect(() => openaiResponsesRequestToAnthropic({
      model: "m",
      input: [
        {
          role: "developer",
          content: [
            { type: "input_text", text: "rules" },
            { type: "input_file", file_data: "data:application/pdf;base64,JVBER" },
          ],
        },
        user("hi"),
      ],
    })).toThrow(/system is text only/);
    // A malformed `tools` field used to emit no tools at all: the same consequence as dropping a
    // nameless declaration, which is refused.
    expect(() => openaiResponsesRequestToAnthropic({
      model: "m", input: [user("hi")], tools: { type: "function", name: "Grep" },
    })).toThrow(/tools must be a list/);
    // A zero-egress refusal's message is the caller's only diagnostic: an assistant turn is not a
    // tool result, and a `message` item that forgot its role does have a type.
    expect(() => openaiResponsesRequestToAnthropic({
      model: "m",
      input: [{ role: "assistant", content: [{ type: "input_file", file_data: "data:application/pdf;base64,JVBER" }] }],
    })).toThrow(/an assistant message carries text and images only/);
    expect(() => openaiResponsesRequestToAnthropic({ model: "m", input: [{ type: "message", content: "x" }] }))
      .toThrow(/message item without a role/);
  });

  it("carries a tool result that says nothing as the empty string, never an empty block list", () => {
    // `content: ""` is a plain string field, not a text block, so Anthropic accepts it where it
    // rejects an empty list — the same rule the turn flush keeps.
    const out = openaiResponsesRequestToAnthropic({
      model: "m",
      input: [
        { type: "function_call", call_id: "c1", name: "A", arguments: "{}" },
        { type: "function_call_output", call_id: "c1", output: [] },
        { type: "function_call_output", call_id: "c2" },
      ],
    });
    expect((out.messages as any[])[1].content).toEqual([
      { type: "tool_result", tool_use_id: "c1", content: "" },
      { type: "tool_result", tool_use_id: "c2", content: "" },
    ]);
  });

  it("drops reasoning.effort instead of inventing a thinking budget", () => {
    // llm-bridge turned any `reasoning` block into `thinking: {budget_tokens: 10240}` — a figure
    // nobody stated, which provenance forbids.
    const out = openaiResponsesRequestToAnthropic({
      model: "m",
      input: [user("hi")],
      reasoning: { effort: "high", summary: "auto" },
    });
    expect(out.thinking).toBeUndefined();
    expect(JSON.stringify(out)).not.toContain("10240");
  });

  it("refuses a structured-output contract it cannot honour, and ignores the plain text format", () => {
    for (const format of [{ type: "json_object" }, { type: "json_schema", name: "x", schema: {} }]) {
      expect(() => openaiResponsesRequestToAnthropic({ model: "m", input: [user("hi")], text: { format } }))
        .toThrow(/no Anthropic Messages equivalent/);
    }
    // `verbosity` and the default text format say nothing about the conversation.
    const out = openaiResponsesRequestToAnthropic({
      model: "m", input: [user("hi")], text: { format: { type: "text" }, verbosity: "low" },
    });
    expect(out.messages).toHaveLength(1);
  });

  it("refuses previous_response_id and any input item type it does not model", () => {
    expect(() => openaiResponsesRequestToAnthropic({
      model: "m", input: [user("hi")], previous_response_id: "resp_1",
    })).toThrow(/previous_response_id/);
    for (const type of ["item_reference", "web_search_call", "computer_call", "custom_tool_call", "image_generation_call"]) {
      expect(() => openaiResponsesRequestToAnthropic({ model: "m", input: [{ type }] }))
        .toThrow(new RegExp(`unsupported Responses input item "${type}"`));
    }
    // The shape a malformed body takes: `[null]` reaches the mapper as an item that is not an
    // object, and must refuse before egress (pinned end-to-end in test/backend.test.ts).
    expect(() => openaiResponsesRequestToAnthropic({ model: "m", input: [null] }))
      .toThrow(/input item is not an object/);
    expect(() => openaiResponsesRequestToAnthropic({ model: "m", input: [{ content: "x" }] }))
      .toThrow(/neither a type nor a role/);
  });

  it("passes temperature, top_p and stream through, and forwards nothing else", () => {
    const out = openaiResponsesRequestToAnthropic({
      model: "m",
      input: [user("hi")],
      max_output_tokens: 64,
      temperature: 0.2,
      top_p: 0.9,
      stream: true,
      store: false,
      prompt_cache_key: "k",
      include: ["reasoning.encrypted_content"],
      metadata: { a: "b" },
      user: "u",
      truncation: "auto",
      service_tier: "flex",
      parallel_tool_calls: false,
    });
    expect(out).toEqual({
      max_tokens: 64,
      model: "m",
      messages: [{ role: "user", content: [{ type: "text", text: "hi" }] }],
      temperature: 0.2,
      top_p: 0.9,
      stream: true,
    });
  });

  it("emits no model key when the caller named none, rather than llm-bridge's \"unknown\"", () => {
    // `fetchOpenAiFront` overwrites `model` with the resolved deployment whenever the target
    // declares one; a fabricated id would otherwise reach a passthrough target verbatim.
    const out = openaiResponsesRequestToAnthropic({ input: "hi" });
    expect(out.model).toBeUndefined();
    expect(JSON.stringify(out)).not.toContain("unknown");
  });

  it("drops an empty text part rather than emitting a block Anthropic rejects", () => {
    const out = openaiResponsesRequestToAnthropic({
      model: "m",
      input: [
        { role: "user", content: [{ type: "input_text", text: "" }] },
        user("real"),
      ],
    });
    expect(out.messages).toEqual([{ role: "user", content: [{ type: "text", text: "real" }] }]);
  });
});
