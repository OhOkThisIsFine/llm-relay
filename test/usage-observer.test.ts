import { describe, expect, it, vi } from "vitest";
import {
  createUsageAccumulator,
  observeUsage,
  type UsageProtocol,
} from "../src/usage-observer.js";
import { estimateTokensFromCharacters } from "../src/metadata.js";

function byteStream(bytes: Uint8Array, chunkSize = bytes.length): ReadableStream<Uint8Array> {
  let offset = 0;
  return new ReadableStream<Uint8Array>({
    pull(controller) {
      if (offset >= bytes.length) {
        controller.close();
        return;
      }
      const end = Math.min(offset + chunkSize, bytes.length);
      controller.enqueue(bytes.slice(offset, end));
      offset = end;
    },
  });
}

function chunkStream(chunks: readonly Uint8Array[]): ReadableStream<Uint8Array> {
  return new ReadableStream<Uint8Array>({
    start(controller) {
      for (const chunk of chunks) controller.enqueue(chunk);
      controller.close();
    },
  });
}

function concatenateBytes(chunks: readonly Uint8Array[]): Uint8Array {
  const output = new Uint8Array(chunks.reduce((total, chunk) => total + chunk.byteLength, 0));
  let offset = 0;
  for (const chunk of chunks) {
    output.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return output;
}

async function observed(
  input: string,
  protocol: UsageProtocol,
  streamed: boolean,
  chunkSize = 1,
): Promise<{ output: string; tokens: number | undefined }> {
  const bytes = new TextEncoder().encode(input);
  const accumulator = createUsageAccumulator();
  const response = observeUsage(
    new Response(byteStream(bytes, chunkSize), { headers: { "content-type": streamed ? "text/event-stream" : "application/json" } }),
    protocol,
    accumulator,
    { streamed },
  );
  const output = new Uint8Array(await response.arrayBuffer());
  return { output: new TextDecoder().decode(output), tokens: accumulator.completionTokens };
}

async function observedAccumulator(
  input: string,
  protocol: UsageProtocol,
  streamed: boolean,
  chunkSize = 1,
): Promise<ReturnType<typeof createUsageAccumulator>> {
  const bytes = new TextEncoder().encode(input);
  const accumulator = createUsageAccumulator();
  const response = observeUsage(
    new Response(byteStream(bytes, chunkSize)),
    protocol,
    accumulator,
    { streamed },
  );
  const output = new Uint8Array(await response.arrayBuffer());
  expect(output).toEqual(bytes);
  return accumulator;
}

describe("usage observer", () => {
  it("observes buffered Anthropic and Chat JSON", async () => {
    await expect(observed('{"usage":{"output_tokens":0}}', "anthropic-messages", false)).resolves.toEqual({
      output: '{"usage":{"output_tokens":0}}',
      tokens: 0,
    });
    await expect(observed('{"usage":{"completion_tokens":12}}', "openai-chat", false)).resolves.toEqual({
      output: '{"usage":{"completion_tokens":12}}',
      tokens: 12,
    });
  });

  it("preserves provider input/output/cache facts with protocol-specific names", async () => {
    await expect(observedAccumulator(
      '{"usage":{"input_tokens":12,"output_tokens":4,"cache_creation_input_tokens":3,"cache_read_input_tokens":8}}',
      "anthropic-messages",
      false,
    )).resolves.toMatchObject({
      inputTokens: 12,
      outputTokens: 4,
      completionTokens: 4,
      cacheCreationInputTokens: 3,
      cacheReadInputTokens: 8,
      // Anthropic's two cache facts are intentionally not collapsed.
      cachedInputTokens: undefined,
    });
    await expect(observedAccumulator(
      '{"usage":{"prompt_tokens":20,"completion_tokens":5,"prompt_tokens_details":{"cached_tokens":7}}}',
      "openai-chat",
      false,
    )).resolves.toMatchObject({
      inputTokens: 20,
      outputTokens: 5,
      completionTokens: 5,
      cachedInputTokens: 7,
    });
  });

  it("estimates buffered model content without counting envelopes or base64 payloads", async () => {
    const anthropicText = "visible answer";
    const anthropicThinking = "private reasoning";
    const anthropicInput = {
      query: "forecast",
      nested: { data: "A".repeat(8_000) },
      image: `DATA:image/png;BASE64,${"B".repeat(8_000)}`,
    };
    const countedInput = JSON.stringify({
      query: "forecast",
      nested: { data: "" },
      image: "",
    });
    const anthropic = JSON.stringify({
      type: "message",
      content: [
        { type: "text", text: anthropicText },
        { type: "thinking", thinking: anthropicThinking },
        { type: "tool_use", id: "toolu_1", name: "lookup", input: anthropicInput },
        { type: "redacted_thinking", data: "C".repeat(8_000) },
      ],
      padding: "wire framing is not model content".repeat(100),
    });
    await expect(observedAccumulator(anthropic, "anthropic-messages", false, 7))
      .resolves.toMatchObject({
        estimatedOutputTokens: estimateTokensFromCharacters(
          anthropicText.length + anthropicThinking.length + countedInput.length,
        ),
      });

    const chatText = "chat answer";
    const reasoning = "chat reasoning";
    const argumentsJson = '{ "city": "Paris" }';
    const chat = JSON.stringify({
      choices: [{
        message: {
          role: "assistant",
          content: chatText,
          reasoning_content: reasoning,
          tool_calls: [{ id: "call_1", type: "function", function: { name: "weather", arguments: argumentsJson } }],
        },
      }],
      system_fingerprint: "wire metadata".repeat(100),
    });
    await expect(observedAccumulator(chat, "openai-chat", false, 5)).resolves.toMatchObject({
      estimatedOutputTokens: estimateTokensFromCharacters(
        chatText.length + reasoning.length + argumentsJson.length,
      ),
    });
  });

  it.each([false, true])(
    "uses the non-empty OpenAI reasoning alias without double counting (streamed=%s)",
    async (streamed) => {
      const content = "answer";
      const fallbackReasoning = "fallback reasoning";
      const preferredReasoning = "preferred reasoning";
      const choices = [
        { index: 0, [streamed ? "delta" : "message"]: {
          content,
          reasoning_content: null,
          reasoning: fallbackReasoning,
        } },
        { index: 1, [streamed ? "delta" : "message"]: {
          reasoning_content: preferredReasoning,
          reasoning: "duplicate alias",
        } },
      ];
      const input = streamed
        ? `data: ${JSON.stringify({ choices })}\n\ndata: [DONE]\n\n`
        : JSON.stringify({ choices });

      await expect(observedAccumulator(input, "openai-chat", streamed, 3)).resolves.toMatchObject({
        estimatedOutputTokens: estimateTokensFromCharacters(
          content.length + fallbackReasoning.length + preferredReasoning.length,
        ),
      });
    },
  );

  it.each(["anthropic-messages", "openai-chat"] as const)(
    "taints the estimate when deeply nested %s tool arguments cannot be sanitized",
    async (protocol) => {
      const depth = 20_000;
      const argumentJson = '{"nested":'.repeat(depth)
        + `{"data":"${"A".repeat(100_000)}"}`
        + "}".repeat(depth);
      const input = protocol === "anthropic-messages"
        ? `{"type":"message","content":[{"type":"text","text":"keep"},{"type":"tool_use","input":${argumentJson}}]}`
        : JSON.stringify({
          choices: [{
            message: {
              content: "keep",
              tool_calls: [{ function: { arguments: argumentJson } }],
            },
          }],
        });

      await expect(observedAccumulator(input, protocol, false, 4096)).resolves.toMatchObject({
        estimatedOutputTokens: undefined,
      });
    },
  );

  it("rounds streamed text, reasoning and tool arguments once across SSE frames", async () => {
    const anthropicParts = ["a", "bc", '{"x":', "1}"];
    const anthropic = [
      `event: content_block_delta\ndata: ${JSON.stringify({ type: "content_block_delta", delta: { type: "text_delta", text: anthropicParts[0] } })}\n\n`,
      `event: content_block_delta\ndata: ${JSON.stringify({ type: "content_block_delta", delta: { type: "thinking_delta", thinking: anthropicParts[1] } })}\n\n`,
      `event: content_block_start\ndata: ${JSON.stringify({ type: "content_block_start", content_block: { type: "tool_use", id: "toolu_1", name: "lookup", input: {} } })}\n\n`,
      ...anthropicParts.slice(2).map((partial_json) =>
        `event: content_block_delta\ndata: ${JSON.stringify({ type: "content_block_delta", delta: { type: "input_json_delta", partial_json } })}\n\n`),
      `event: ping\ndata: ${JSON.stringify({ type: "ping", padding: "not content".repeat(100) })}\n\n`,
    ].join("");
    await expect(observedAccumulator(anthropic, "anthropic-messages", true, 1))
      .resolves.toMatchObject({
        estimatedOutputTokens: estimateTokensFromCharacters(
          anthropicParts.reduce((sum, part) => sum + part.length, 0),
        ),
      });

    const chatParts = ["d", "ef", '{"y":', "2}"];
    const chat = [
      `data: ${JSON.stringify({ choices: [{ delta: { content: chatParts[0], reasoning_content: chatParts[1] } }] })}\n\n`,
      ...chatParts.slice(2).map((argumentsPart) => `data: ${JSON.stringify({
        choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: argumentsPart } }] } }],
      })}\n\n`),
      "data: [DONE]\n\n",
    ].join("");
    await expect(observedAccumulator(chat, "openai-chat", true, 2)).resolves.toMatchObject({
      estimatedOutputTokens: estimateTokensFromCharacters(
        chatParts.reduce((sum, part) => sum + part.length, 0),
      ),
    });
  });

  it.each(["anthropic-messages", "openai-chat"] as const)(
    "skips a base64 tool payload split across %s SSE frames",
    async (protocol) => {
      const text = "kept";
      const argumentParts = ['{"d\\u0061', 'ta":"', "A".repeat(2_000), "B".repeat(2_000), '"}'];
      const input = protocol === "anthropic-messages"
        ? [
          `event: content_block_delta\ndata: ${JSON.stringify({ type: "content_block_delta", index: 0, delta: { type: "text_delta", text } })}\n\n`,
          ...argumentParts.map((partial_json) =>
            `event: content_block_delta\ndata: ${JSON.stringify({ type: "content_block_delta", index: 1, delta: { type: "input_json_delta", partial_json } })}\n\n`),
          `event: content_block_stop\ndata: ${JSON.stringify({ type: "content_block_stop", index: 1 })}\n\n`,
        ].join("")
        : [
          `data: ${JSON.stringify({ choices: [{ index: 0, delta: { content: text } }] })}\n\n`,
          ...argumentParts.map((argumentsPart) => `data: ${JSON.stringify({
            choices: [{ index: 0, delta: { tool_calls: [{ index: 0, function: { arguments: argumentsPart } }] } }],
          })}\n\n`),
          `data: ${JSON.stringify({ choices: [{ index: 0, delta: {}, finish_reason: "tool_calls" }] })}\n\n`,
          "data: [DONE]\n\n",
        ].join("");

      await expect(observedAccumulator(input, protocol, true, 3)).resolves.toMatchObject({
        estimatedOutputTokens: estimateTokensFromCharacters(
          text.length + JSON.stringify({ data: "" }).length,
        ),
      });
    },
  );

  it.each([
    ["buffered", false],
    ["streamed", true],
  ] as const)("counts whitespace as model text in a %s response", async (_label, streamed) => {
    // The observer counts authored text. The server's final-wire commit gate decides whether a
    // provisional serve prefix was actually forwarded and may enter accounting.
    const content = "   ";
    const input = streamed
      ? [
        `data: ${JSON.stringify({ choices: [{ index: 0, delta: { content } }] })}\n\n`,
        `data: ${JSON.stringify({ choices: [{ index: 0, delta: {}, finish_reason: "stop" }] })}\n\n`,
        "data: [DONE]\n\n",
      ].join("")
      : JSON.stringify({ choices: [{ message: { content } }] });
    await expect(observedAccumulator(input, "openai-chat", streamed)).resolves.toMatchObject({
      estimatedOutputTokens: estimateTokensFromCharacters(content.length),
    });
  });

  it("leaves estimated output unknown when no model content was present", async () => {
    await expect(observedAccumulator(
      JSON.stringify({ error: { message: "provider unavailable" }, usage: { completion_tokens: 0 } }),
      "openai-chat",
      false,
    )).resolves.toMatchObject({ estimatedOutputTokens: undefined });
  });

  it("handles byte-by-byte Anthropic SSE and ignores the message_start seed", async () => {
    const input = [
      `event: message_start\ndata: ${JSON.stringify({ type: "message_start", message: { usage: { output_tokens: 99 } } })}\n\n`,
      `event: message_delta\ndata: ${JSON.stringify({ type: "message_delta", usage: { output_tokens: 4 } })}\n\n`,
      `event: message_delta\ndata: ${JSON.stringify({ type: "message_delta", usage: { output_tokens: 0 } })}\n\n`,
    ].join("");
    await expect(observed(input, "anthropic-messages", true, 1)).resolves.toEqual({ output: input, tokens: 0 });
  });

  it("captures Anthropic message_start input/cache facts and message_delta output", async () => {
    const input = [
      `event: message_start\ndata: ${JSON.stringify({ type: "message_start", message: { usage: { input_tokens: 10, cache_creation_input_tokens: 2, cache_read_input_tokens: 5 } } })}\n\n`,
      `event: message_delta\ndata: ${JSON.stringify({ type: "message_delta", usage: { output_tokens: 0 } })}\n\n`,
    ].join("");
    await expect(observedAccumulator(input, "anthropic-messages", true, 1)).resolves.toMatchObject({
      inputTokens: 10,
      outputTokens: 0,
      completionTokens: 0,
      cacheCreationInputTokens: 2,
      cacheReadInputTokens: 5,
      cachedInputTokens: undefined,
    });
  });

  it("handles LF and CRLF Chat SSE, with the last valid cumulative value winning", async () => {
    const input = [
      'data: {"choices":[],"usage":{"completion_tokens":3}}\n\n',
      'data: {"choices":[],"usage":{"completion_tokens":0}}\r\n\r\n',
      'data: {"choices":[],"usage":{"completion_tokens":7}}\r\n\r\n',
    ].join("");
    await expect(observed(input, "openai-chat", true, 2)).resolves.toEqual({ output: input, tokens: 7 });
  });

  it("keeps OpenAI cumulative input/output/cache values independently", async () => {
    const input = [
      'data: {"choices":[],"usage":{"prompt_tokens":3,"completion_tokens":1,"prompt_tokens_details":{"cached_tokens":0}}}\n\n',
      'data: {"choices":[],"usage":{"prompt_tokens":0,"completion_tokens":0,"prompt_tokens_details":{"cached_tokens":4}}}\n\n',
    ].join("");
    await expect(observedAccumulator(input, "openai-chat", true, 2)).resolves.toMatchObject({
      inputTokens: 0,
      outputTokens: 0,
      completionTokens: 0,
      cachedInputTokens: 4,
    });
  });

  /**
   * No `"openai-responses"` protocol exists any more: no observeUsage call site ever
   * passed one (Responses front-door traffic is translated before it is proxied), so
   * the branch was dead. Removal is enforced by the type system — any call site or
   * test passing the literal now fails `typecheck:test`.
   */

  it("keeps a CR until its split LF before dispatching a Chat frame", async () => {
    // Same parser hazard the old Responses test covered, under a live protocol: a CR
    // landing on a chunk boundary must not be flushed as a premature blank line.
    const input = 'data: {"usage":{"completion_tokens":13}}\r\n\r\n';
    const bytes = new TextEncoder().encode(input);
    const split = input.indexOf("\r") + 1;
    const response = new Response(
      new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(bytes.slice(0, split));
          controller.enqueue(bytes.slice(split));
          controller.close();
        },
      }),
    );
    const accumulator = createUsageAccumulator();
    const observedResponse = observeUsage(response, "openai-chat", accumulator, { streamed: true });
    await expect(observedResponse.text()).resolves.toBe(input);
    expect(accumulator.completionTokens).toBe(13);
  });

  it("rejects malformed, negative, unsafe, and fractional values without losing zero", async () => {
    const input = [
      'data: {"usage":{"completion_tokens":2.5}}\n\n',
      'data: {"usage":{"completion_tokens":-1}}\n\n',
      'data: {"usage":{"completion_tokens":9007199254740992}}\n\n',
      'data: {"usage":{"completion_tokens":0}}\n\n',
      'data: {"usage":{"completion_tokens":"8"}}\n\n',
    ].join("");
    await expect(observed(input, "openai-chat", true, 1)).resolves.toEqual({ output: input, tokens: 0 });
  });

  it("isolates malformed fields while retaining each last valid zero", async () => {
    const input = [
      'data: {"usage":{"prompt_tokens":12,"completion_tokens":4,"prompt_tokens_details":{"cached_tokens":3}}}\n\n',
      'data: {"usage":{"prompt_tokens":-1,"completion_tokens":"bad","prompt_tokens_details":{"cached_tokens":null}}}\n\n',
      'data: {"usage":{"prompt_tokens":0,"completion_tokens":0,"prompt_tokens_details":{"cached_tokens":0}}}\n\n',
    ].join("");
    await expect(observedAccumulator(input, "openai-chat", true, 1)).resolves.toMatchObject({
      inputTokens: 0,
      outputTokens: 0,
      completionTokens: 0,
      cachedInputTokens: 0,
    });
  });

  it("recovers after an oversized SSE frame", async () => {
    const oversized = `data: {"choices":[],"padding":"${"x".repeat(20_000)}"}\n\n`;
    const terminal = 'data: {"choices":[{"delta":{"content":"later"}}],"usage":{"completion_tokens":19}}\n\n';
    await expect(observedAccumulator(oversized + terminal, "openai-chat", true, 257)).resolves.toMatchObject({
      completionTokens: 19,
      // Reported usage can recover, but skipped frame might have held content:
      // retaining only "later" would make a partial estimate look complete.
      estimatedOutputTokens: undefined,
    });
  });

  it("taints the estimate when pending tool arguments exceed the character bound", async () => {
    const initial = `data: ${JSON.stringify({ choices: [{ index: 0, delta: { content: "visible" } }] })}\n\n`;
    const fragments = Array.from({ length: 9 }, () => `data: ${JSON.stringify({
      choices: [{
        index: 0,
        delta: { tool_calls: [{ index: 0, function: { arguments: "x".repeat(8_000) } }] },
      }],
    })}\n\n`).join("");
    const terminal = `data: ${JSON.stringify({ choices: [], usage: { completion_tokens: 7 } })}\n\n`;

    await expect(observedAccumulator(initial + fragments + terminal, "openai-chat", true, 1024))
      .resolves.toMatchObject({
        completionTokens: 7,
        estimatedOutputTokens: undefined,
      });
  });

  it("taints the estimate when pending tool-call count exceeds the bound", async () => {
    const initial = `data: ${JSON.stringify({ choices: [{ index: 0, delta: { content: "visible" } }] })}\n\n`;
    const calls = Array.from({ length: 129 }, (_, index) => `data: ${JSON.stringify({
      choices: [{
        index: 0,
        delta: { tool_calls: [{ index, function: { arguments: "{" } }] },
      }],
    })}\n\n`).join("");
    const terminal = `data: ${JSON.stringify({ choices: [], usage: { completion_tokens: 8 } })}\n\n`;

    await expect(observedAccumulator(initial + calls + terminal, "openai-chat", true, 128))
      .resolves.toMatchObject({
        completionTokens: 8,
        estimatedOutputTokens: undefined,
      });
  });

  it("bounds non-ASCII SSE frames by encoded bytes and recovers", async () => {
    const oversized = `data: {"usage":{"completion_tokens":29},"padding":"${"😀".repeat(8_000)}"}\n\n`;
    const terminal = 'data: {"usage":{"completion_tokens":31}}\n\n';
    await expect(observed(oversized, "openai-chat", true, 1024)).resolves.toEqual({
      output: oversized,
      tokens: undefined,
    });
    await expect(observed(oversized + terminal, "openai-chat", true, 1024)).resolves.toEqual({
      output: oversized + terminal,
      tokens: 31,
    });
  });

  it("recovers when an oversized continuation ends in a split CR", async () => {
    const prefix = `data: {"padding":"${"x".repeat(16_500)}`;
    const continuation = `${"y".repeat(20_000)}\r`;
    const terminal = 'data: {"choices":[],"usage":{"completion_tokens":21}}\n\n';
    const chunks = [prefix, continuation, `\n\n${terminal}`].map((value) => new TextEncoder().encode(value));
    const input = new Uint8Array(chunks.reduce((total, chunk) => total + chunk.byteLength, 0));
    let offset = 0;
    for (const chunk of chunks) {
      input.set(chunk, offset);
      offset += chunk.byteLength;
    }
    const accumulator = createUsageAccumulator();
    const response = observeUsage(
      new Response(
        new ReadableStream<Uint8Array>({
          start(controller) {
            for (const chunk of chunks) controller.enqueue(chunk);
            controller.close();
          },
        }),
      ),
      "openai-chat",
      accumulator,
      { streamed: true },
    );
    const output = new Uint8Array(await response.arrayBuffer());
    expect(output).toEqual(input);
    expect(accumulator.completionTokens).toBe(21);
  });

  it("keeps buffered JSON unknown after the one MiB bound", async () => {
    const input = `{"usage":{"completion_tokens":23},"padding":"${"x".repeat(1_048_570)}"}`;
    const bytes = new TextEncoder().encode(input);
    const accumulator = createUsageAccumulator();
    const response = observeUsage(
      new Response(byteStream(bytes, 4096)),
      "openai-chat",
      accumulator,
    );
    await expect(response.text()).resolves.toBe(input);
    expect(accumulator.completionTokens).toBeUndefined();
    expect(accumulator.estimatedOutputTokens).toBeUndefined();
  });

  it("propagates upstream stream errors and isolates a throwing accumulator setter", async () => {
    const failure = new Error("provider stream failed");
    const input = `data: ${JSON.stringify({
      choices: [{ delta: { content: "ok" } }],
      usage: { completion_tokens: 8 },
    })}\n\n`;
    const bytes = new TextEncoder().encode(input);
    const failing = new Response(
      new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(bytes);
          controller.error(failure);
        },
      }),
    );
    await expect(observeUsage(failing, "openai-chat", createUsageAccumulator(), { streamed: true }).text())
      .rejects.toBe(failure);

    const partialToolInput = [
      `data: ${JSON.stringify({ choices: [{ index: 0, delta: { content: "visible" } }] })}\n\n`,
      `data: ${JSON.stringify({
        choices: [{ index: 0, delta: { tool_calls: [{ index: 0, function: { arguments: '{"data":"AAAA' } }] } }],
      })}\n\n`,
    ].join("");
    const partialAccumulator = createUsageAccumulator();
    const partialFailure = new Response(new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new TextEncoder().encode(partialToolInput));
        controller.error(failure);
      },
    }));
    await expect(observeUsage(partialFailure, "openai-chat", partialAccumulator, { streamed: true }).text())
      .rejects.toBe(failure);
    expect(partialAccumulator.estimatedOutputTokens).toBeUndefined();

    let stored: number | undefined;
    let completionSetterCalls = 0;
    let estimateSetterCalls = 0;
    const accumulator = {} as ReturnType<typeof createUsageAccumulator>;
    Object.defineProperty(accumulator, "completionTokens", {
      configurable: true,
      get: () => stored,
      set: () => {
        completionSetterCalls += 1;
        throw new Error("observer setter failed");
      },
    });
    Object.defineProperty(accumulator, "estimatedOutputTokens", {
      configurable: true,
      get: () => stored,
      set: () => {
        estimateSetterCalls += 1;
        throw new Error("observer setter failed");
      },
    });
    await expect(observeUsage(new Response(bytes), "openai-chat", accumulator, { streamed: true }).text())
      .resolves.toBe(input);
    expect(completionSetterCalls).toBe(1);
    expect(estimateSetterCalls).toBe(1);
  });

  it("passes through invalid UTF-8 as the exact input chunk", async () => {
    const chunk = new Uint8Array([0x66, 0x80, 0xff, 0xc3, 0x28]);
    const response = observeUsage(
      new Response(
        new ReadableStream<Uint8Array>({
          start(controller) {
            controller.enqueue(chunk);
            controller.close();
          },
        }),
      ),
      "openai-chat",
      createUsageAccumulator(),
      { streamed: true },
    );
    const reader = response.body!.getReader();
    const first = await reader.read();
    expect(first.value).toBe(chunk);
    expect(first.value).toEqual(new Uint8Array([0x66, 0x80, 0xff, 0xc3, 0x28]));
    await expect(reader.read()).resolves.toEqual({ done: true, value: undefined });
  });

  it("emits the first chunk before upstream closes", async () => {
    let upstream!: ReadableStreamDefaultController<Uint8Array>;
    const response = observeUsage(
      new Response(new ReadableStream<Uint8Array>({ start: (controller) => { upstream = controller; } })),
      "openai-chat",
      createUsageAccumulator(),
      { streamed: true },
    );
    const reader = response.body!.getReader();
    const chunk = new TextEncoder().encode("data: partial");
    const pending = reader.read();
    upstream.enqueue(chunk);
    const first = await pending;
    expect(first).toEqual({ done: false, value: chunk });
    upstream.close();
    await expect(reader.read()).resolves.toEqual({ done: true, value: undefined });
  });

  it("passes the exact downstream cancellation reason upstream", async () => {
    const reason = { kind: "caller-stopped" };
    let resolveCancellation!: (value: unknown) => void;
    const cancellation = new Promise<unknown>((resolve) => { resolveCancellation = resolve; });
    const response = observeUsage(
      new Response(new ReadableStream<Uint8Array>({ cancel: resolveCancellation })),
      "openai-chat",
      createUsageAccumulator(),
      { streamed: true },
    );
    await response.body!.cancel(reason);
    await expect(cancellation).resolves.toBe(reason);
  });

  it("excludes an Anthropic data URL split across logical SSE text deltas", async () => {
    const binaryParts = ["Da", "Ta:image/png;ba", "se64,", "A".repeat(2_000)];
    const visible = "visible answer";
    const reasoning = "kept reasoning";
    const input = [
      ...binaryParts.map((text) => `event: content_block_delta\ndata: ${JSON.stringify({
        type: "content_block_delta",
        index: 0,
        delta: { type: "text_delta", text },
      })}\n\n`),
      `event: content_block_stop\ndata: ${JSON.stringify({ type: "content_block_stop", index: 0 })}\n\n`,
      `event: content_block_delta\ndata: ${JSON.stringify({
        type: "content_block_delta",
        index: 1,
        delta: { type: "text_delta", text: visible },
      })}\n\n`,
      `event: content_block_stop\ndata: ${JSON.stringify({ type: "content_block_stop", index: 1 })}\n\n`,
      `event: content_block_delta\ndata: ${JSON.stringify({
        type: "content_block_delta",
        index: 2,
        delta: { type: "thinking_delta", thinking: reasoning },
      })}\n\n`,
      `event: content_block_stop\ndata: ${JSON.stringify({ type: "content_block_stop", index: 2 })}\n\n`,
    ].join("");

    await expect(observedAccumulator(input, "anthropic-messages", true, 2))
      .resolves.toMatchObject({
        estimatedOutputTokens: estimateTokensFromCharacters(visible.length + reasoning.length),
      });
  });

  it("excludes an OpenAI data URL split across logical SSE text deltas", async () => {
    const binaryParts = ["d", "ata:application/octet-stream;", "base", "64,", "B".repeat(2_000)];
    const visible = "visible answer";
    const reasoning = "kept reasoning";
    const input = [
      ...binaryParts.map((content) => `data: ${JSON.stringify({
        choices: [{ index: 0, delta: { content } }],
      })}\n\n`),
      `data: ${JSON.stringify({ choices: [{ index: 1, delta: { content: visible } }] })}\n\n`,
      `data: ${JSON.stringify({
        choices: [{ index: 2, delta: { reasoning_content: reasoning } }],
      })}\n\n`,
      `data: ${JSON.stringify({
        choices: [
          { index: 0, delta: {}, finish_reason: "stop" },
          { index: 1, delta: {}, finish_reason: "stop" },
          { index: 2, delta: {}, finish_reason: "stop" },
        ],
      })}\n\n`,
      "data: [DONE]\n\n",
    ].join("");

    await expect(observedAccumulator(input, "openai-chat", true, 3)).resolves.toMatchObject({
      estimatedOutputTokens: estimateTokensFromCharacters(visible.length + reasoning.length),
    });
  });

  it("retains an unresolved streamed data prefix when upstream fails", async () => {
    const visible = "visible";
    const unresolved = "data:";
    const input = [
      `data: ${JSON.stringify({ choices: [{ index: 0, delta: { content: visible } }] })}\n\n`,
      `data: ${JSON.stringify({ choices: [{ index: 1, delta: { content: unresolved } }] })}\n\n`,
    ].join("");
    const chunk = new TextEncoder().encode(input);
    const accumulator = createUsageAccumulator();
    const failure = new Error("provider stream failed after content");
    let upstream!: ReadableStreamDefaultController<Uint8Array>;
    const response = observeUsage(
      new Response(new ReadableStream<Uint8Array>({
        start(controller) {
          upstream = controller;
        },
      })),
      "openai-chat",
      accumulator,
      { streamed: true },
    );
    const reader = response.body!.getReader();
    const pending = reader.read();
    upstream.enqueue(chunk);
    const first = await pending;
    expect(first).toEqual({ done: false, value: chunk });
    upstream.error(failure);
    await expect(reader.read()).rejects.toBe(failure);
    expect(accumulator.estimatedOutputTokens).toBe(
      estimateTokensFromCharacters(visible.length + unresolved.length),
    );
  });

  it.each([
    ["buffered", false],
    ["streamed", true],
  ] as const)("passes through invalid UTF-8 inside %s JSON and taints its estimate", async (_label, streamed) => {
    const prefix = streamed
      ? 'data: {"choices":[{"index":0,"delta":{"content":"safe'
      : '{"choices":[{"message":{"content":"safe';
    const suffix = streamed ? ' tail"}}]}\n\n' : ' tail"}}]}';
    const chunks = [
      new TextEncoder().encode(prefix),
      new Uint8Array([0x80]),
      new TextEncoder().encode(suffix),
    ];
    const expected = concatenateBytes(chunks);
    const accumulator = createUsageAccumulator();
    const response = observeUsage(
      new Response(chunkStream(chunks)),
      "openai-chat",
      accumulator,
      { streamed },
    );

    expect(new Uint8Array(await response.arrayBuffer())).toEqual(expected);
    expect(accumulator.estimatedOutputTokens).toBeUndefined();
  });

  it("taints a streamed estimate on a dangling UTF-8 lead byte at EOF", async () => {
    const valid = new TextEncoder().encode(`data: ${JSON.stringify({
      choices: [{ index: 0, delta: { content: "visible" } }],
    })}\n\n`);
    const danglingLead = new Uint8Array([0xc3]);
    const chunks = [valid, danglingLead];
    const accumulator = createUsageAccumulator();
    const response = observeUsage(
      new Response(chunkStream(chunks)),
      "openai-chat",
      accumulator,
      { streamed: true },
    );

    expect(new Uint8Array(await response.arrayBuffer())).toEqual(concatenateBytes(chunks));
    expect(accumulator.estimatedOutputTokens).toBeUndefined();
  });

  it.each(["anthropic-messages", "openai-chat"] as const)(
    "ignores empty data events around valid %s SSE content",
    async (protocol) => {
      const first = "model";
      const second = " output";
      const input = protocol === "anthropic-messages"
        ? [
            "data:\n\n",
            `event: content_block_delta\ndata: ${JSON.stringify({
              type: "content_block_delta",
              index: 0,
              delta: { type: "text_delta", text: first },
            })}\n\n`,
            "data: \n\n",
            `event: content_block_delta\ndata: ${JSON.stringify({
              type: "content_block_delta",
              index: 0,
              delta: { type: "text_delta", text: second },
            })}\n\n`,
            `event: content_block_stop\ndata: ${JSON.stringify({
              type: "content_block_stop",
              index: 0,
            })}\n\n`,
          ].join("")
        : [
            "data:\n\n",
            `data: ${JSON.stringify({ choices: [{ index: 0, delta: { content: first } }] })}\n\n`,
            "data: \n\n",
            `data: ${JSON.stringify({ choices: [{ index: 0, delta: { content: second } }] })}\n\n`,
            `data: ${JSON.stringify({
              choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
            })}\n\n`,
            "data: [DONE]\n\n",
          ].join("");

      await expect(observedAccumulator(input, protocol, true, 1)).resolves.toMatchObject({
        estimatedOutputTokens: estimateTokensFromCharacters(first.length + second.length),
      });
    },
  );

  it("passes zero-byte chunks around buffered JSON without copying them", async () => {
    const emptyBefore = new Uint8Array(0);
    const content = "zero-safe";
    const jsonBytes = new TextEncoder().encode(JSON.stringify({
      choices: [{ message: { content } }],
    }));
    const emptyAfter = new Uint8Array(0);
    const accumulator = createUsageAccumulator();
    const response = observeUsage(
      new Response(chunkStream([emptyBefore, jsonBytes, emptyAfter])),
      "openai-chat",
      accumulator,
      { streamed: false },
    );
    const reader = response.body!.getReader();
    const setSpy = vi.spyOn(Uint8Array.prototype, "set");
    try {
      const before = await reader.read();
      expect(before).toEqual({ done: false, value: emptyBefore });
      expect(before.value).toBe(emptyBefore);
      const json = await reader.read();
      expect(json).toEqual({ done: false, value: jsonBytes });
      expect(json.value).toBe(jsonBytes);
      const after = await reader.read();
      expect(after).toEqual({ done: false, value: emptyAfter });
      expect(after.value).toBe(emptyAfter);
      await expect(reader.read()).resolves.toEqual({ done: true, value: undefined });

      expect(setSpy.mock.calls.some(([source]) => (
        source === emptyBefore || source === emptyAfter
      ))).toBe(false);
      expect(setSpy.mock.calls.filter(([source]) => source === jsonBytes)).toHaveLength(1);
    } finally {
      setSpy.mockRestore();
    }
    expect(accumulator.estimatedOutputTokens).toBe(estimateTokensFromCharacters(content.length));
  });

  it("counts only buffered Anthropic server and MCP tool input JSON", async () => {
    const serverInput = { query: "weather", max_uses: 2 };
    const mcpInput = { command: "lookup", arguments: { city: "Paris" } };
    const ignored = "provider-owned-result".repeat(500);
    const input = JSON.stringify({
      type: "message",
      content: [
        {
          type: "server_tool_use",
          id: `srvtoolu_${ignored}`,
          name: `web_search_${ignored}`,
          input: serverInput,
          result: ignored,
        },
        {
          type: "web_search_tool_result",
          tool_use_id: `srvtoolu_${ignored}`,
          content: [{ type: "web_search_result", encrypted_content: ignored }],
        },
        {
          type: "mcp_tool_use",
          id: `mcptoolu_${ignored}`,
          name: `lookup_${ignored}`,
          server_name: ignored,
          input: mcpInput,
          result: ignored,
        },
        {
          type: "mcp_tool_result",
          tool_use_id: `mcptoolu_${ignored}`,
          content: [{ type: "text", text: ignored }],
        },
      ],
    });

    await expect(observedAccumulator(input, "anthropic-messages", false, 127))
      .resolves.toMatchObject({
        estimatedOutputTokens: estimateTokensFromCharacters(
          JSON.stringify(serverInput).length + JSON.stringify(mcpInput).length,
        ),
      });
  });

  it("keeps indexed SSE input JSON distinct for Anthropic server and MCP tool use", async () => {
    const serverParts = ['{"query":"wea', 'ther"}'];
    const mcpParts = ['{"city":"Pa', 'ris"}'];
    const ignored = "framing".repeat(300);
    const input = [
      `event: content_block_start\ndata: ${JSON.stringify({
        type: "content_block_start",
        index: 3,
        content_block: {
          type: "server_tool_use",
          id: `srvtoolu_${ignored}`,
          name: `search_${ignored}`,
          input: {},
        },
      })}\n\n`,
      `event: content_block_start\ndata: ${JSON.stringify({
        type: "content_block_start",
        index: 7,
        content_block: {
          type: "mcp_tool_use",
          id: `mcptoolu_${ignored}`,
          name: `lookup_${ignored}`,
          server_name: ignored,
          input: {},
        },
      })}\n\n`,
      `event: content_block_delta\ndata: ${JSON.stringify({
        type: "content_block_delta",
        index: 3,
        delta: { type: "input_json_delta", partial_json: serverParts[0] },
      })}\n\n`,
      `event: content_block_delta\ndata: ${JSON.stringify({
        type: "content_block_delta",
        index: 7,
        delta: { type: "input_json_delta", partial_json: mcpParts[0] },
      })}\n\n`,
      `event: content_block_delta\ndata: ${JSON.stringify({
        type: "content_block_delta",
        index: 3,
        delta: { type: "input_json_delta", partial_json: serverParts[1] },
      })}\n\n`,
      `event: content_block_stop\ndata: ${JSON.stringify({ type: "content_block_stop", index: 3 })}\n\n`,
      `event: content_block_delta\ndata: ${JSON.stringify({
        type: "content_block_delta",
        index: 7,
        delta: { type: "input_json_delta", partial_json: mcpParts[1] },
      })}\n\n`,
      `event: content_block_stop\ndata: ${JSON.stringify({ type: "content_block_stop", index: 7 })}\n\n`,
    ].join("");

    await expect(observedAccumulator(input, "anthropic-messages", true, 5))
      .resolves.toMatchObject({
        estimatedOutputTokens: estimateTokensFromCharacters(
          serverParts.join("").length + mcpParts.join("").length,
        ),
      });
  });

  it("returns the original response when it has no body", () => {
    const accumulator = createUsageAccumulator();
    const response = new Response(null, { status: 204 });
    expect(observeUsage(response, "openai-chat", accumulator)).toBe(response);
    expect(accumulator.completionTokens).toBeUndefined();
  });
});
