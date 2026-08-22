import { describe, expect, it } from "vitest";
import {
  createUsageAccumulator,
  observeUsage,
  type UsageProtocol,
} from "../src/usage-observer.js";

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
  await response.arrayBuffer();
  return accumulator;
}

describe("usage observer", () => {
  it("observes buffered Anthropic, Chat, and Responses JSON", async () => {
    await expect(observed('{"usage":{"output_tokens":0}}', "anthropic-messages", false)).resolves.toEqual({
      output: '{"usage":{"output_tokens":0}}',
      tokens: 0,
    });
    await expect(observed('{"usage":{"completion_tokens":12}}', "openai-chat", false)).resolves.toEqual({
      output: '{"usage":{"completion_tokens":12}}',
      tokens: 12,
    });
    await expect(observed('{"usage":{"output_tokens":27}}', "openai-responses", false)).resolves.toEqual({
      output: '{"usage":{"output_tokens":27}}',
      tokens: 27,
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
    await expect(observedAccumulator(
      '{"type":"response.completed","response":{"usage":{"input_tokens":30,"output_tokens":6,"input_tokens_details":{"cached_tokens":9}}}}',
      "openai-responses",
      false,
    )).resolves.toMatchObject({
      inputTokens: 30,
      outputTokens: 6,
      completionTokens: 6,
      cachedInputTokens: 9,
    });
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

  it("observes only Responses response.completed usage", async () => {
    const input = [
      'event: response.output_text.delta\ndata: {"type":"response.output_text.delta","delta":"hi"}\n\n',
      'event: response.completed\ndata: {"response":{"usage":{"output_tokens":11}}}\n\n',
    ].join("");
    await expect(observed(input, "openai-responses", true, 3)).resolves.toEqual({ output: input, tokens: 11 });
  });

  it("captures Responses input/output/cache details only on response.completed", async () => {
    const input = [
      'event: response.output_text.delta\ndata: {"type":"response.output_text.delta","usage":{"input_tokens":99}}\n\n',
      'event: response.completed\ndata: {"response":{"usage":{"input_tokens":14,"output_tokens":2,"input_tokens_details":{"cached_tokens":6}}}}\n\n',
    ].join("");
    await expect(observedAccumulator(input, "openai-responses", true, 3)).resolves.toMatchObject({
      inputTokens: 14,
      outputTokens: 2,
      completionTokens: 2,
      cachedInputTokens: 6,
    });
  });

  it("keeps a CR until a split LF before dispatching a Responses event", async () => {
    const input = 'event: response.completed\r\ndata: {"response":{"usage":{"output_tokens":13}}}\r\n\r\n';
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
    const observedResponse = observeUsage(response, "openai-responses", accumulator, { streamed: true });
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
    const terminal = 'data: {"choices":[],"usage":{"completion_tokens":19}}\n\n';
    await expect(observed(oversized + terminal, "openai-chat", true, 257)).resolves.toEqual({
      output: oversized + terminal,
      tokens: 19,
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
    await expect(observed(input, "openai-chat", false, 4096)).resolves.toEqual({ output: input, tokens: undefined });
  });

  it("propagates upstream stream errors and isolates a throwing accumulator setter", async () => {
    const failure = new Error("provider stream failed");
    const input = 'data: {"usage":{"completion_tokens":8}}\n\n';
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

    let stored: number | undefined;
    let setterCalls = 0;
    const accumulator = {} as ReturnType<typeof createUsageAccumulator>;
    Object.defineProperty(accumulator, "completionTokens", {
      configurable: true,
      get: () => stored,
      set: () => {
        setterCalls += 1;
        throw new Error("observer setter failed");
      },
    });
    await expect(observeUsage(new Response(bytes), "openai-chat", accumulator, { streamed: true }).text())
      .resolves.toBe(input);
    expect(setterCalls).toBe(1);
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

  it("returns the original response when it has no body", () => {
    const accumulator = createUsageAccumulator();
    const response = new Response(null, { status: 204 });
    expect(observeUsage(response, "openai-chat", accumulator)).toBe(response);
    expect(accumulator.completionTokens).toBeUndefined();
  });
});
