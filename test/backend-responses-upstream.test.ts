import { describe, it, expect, afterEach } from "vitest";
import { createServer, type Server } from "node:http";
import { AddressInfo } from "node:net";
import { createProxy } from "../src/server.js";
import { ModelCatalog } from "../src/catalog.js";
import { globalCircuitBreaker } from "../src/circuit-breaker.js";
import { resetFacts } from "../src/target-facts.js";
import { resetInterpretations } from "../src/refusal-interpretation.js";
import type { Config, ProviderConfig } from "../src/config.js";

/**
 * The `wire: "responses"` OpenAI-Responses UPSTREAM speaker (backlog item 11 — OpenCode Zen's
 * contributor SKUs, Muse Spark 1.3 included, answer HTTP 500 on `/chat/completions` and 200 only
 * on `/responses`; docs/muse-spark-1.3-opencode-zen-2026-09-04.md rows 3, 6-8, §3 route B).
 *
 * ⚠ Every walk test uses >=2 candidates: with one candidate "fails over correctly" and "cannot
 * fail over at all" are the same observation (`test/pool-failover.test.ts`'s own standing rule).
 */

const servers: Server[] = [];
function track(s: Server): Server {
  servers.push(s);
  return s;
}

afterEach(async () => {
  await Promise.all(servers.splice(0).map((s) => new Promise((r) => s.close(r))));
  globalCircuitBreaker.reset();
  resetFacts();
  resetInterpretations();
});

function port(s: Server): number {
  return (s.address() as AddressInfo).port;
}

function startProxy(c: Config): Promise<Server> {
  const s = createProxy(c, { catalog: new ModelCatalog({ cachePath: null }) });
  return new Promise((r) => s.listen(0, "127.0.0.1", () => r(track(s))));
}

/** A mock `/responses` backend, scripted per call, capturing the request body it received. */
function scriptedResponses(
  reply: (n: number, body: Record<string, unknown>) => { status?: number; headers?: Record<string, string>; body: string },
): Promise<{ server: Server; calls: () => number; bodies: () => Record<string, unknown>[] }> {
  let n = 0;
  const bodies: Record<string, unknown>[] = [];
  return new Promise((resolve) => {
    const s = createServer((req, res) => {
      const chunks: Buffer[] = [];
      req.on("data", (c) => chunks.push(c));
      req.on("end", () => {
        let parsed: Record<string, unknown> = {};
        try {
          parsed = JSON.parse(Buffer.concat(chunks).toString() || "{}");
        } catch {
          // A malformed body is still recorded as {} so a test asserting call COUNT stays correct.
        }
        bodies.push(parsed);
        const out = reply(++n, parsed);
        res.writeHead(out.status ?? 200, { "content-type": "application/json", ...out.headers });
        res.end(out.body);
      });
    });
    s.listen(0, "127.0.0.1", () => resolve({ server: track(s), calls: () => n, bodies: () => bodies }));
  });
}

/** A two-member `wire: "responses"` pool. `benchmarkSort: false` keeps CONFIG order. */
function responsesPoolCfg(bases: string[]): Config {
  const providers: Record<string, ProviderConfig> = {};
  bases.forEach((base, i) => {
    providers[`p${i + 1}`] = { base, kind: "openai", wire: "responses", authHeader: "authorization", timeoutMs: 5000 };
  });
  return {
    host: "127.0.0.1",
    port: 0,
    providers,
    routing: { default: "pool/resp", tiers: {}, benchmarkSort: false, pools: { resp: bases.map((_, i) => `p${i + 1}/m${i + 1}`) } },
    mode: "detect",
    repair: { maxAttempts: 2, destructiveTools: [] },
    log: { level: "silent", file: null },
  };
}

/** One `wire: "chat"` (the default) provider, for the byte-regression guard. */
function chatCfg(base: string): Config {
  return {
    host: "127.0.0.1",
    port: 0,
    providers: { p1: { base, kind: "openai", authHeader: "authorization", timeoutMs: 5000 } },
    routing: { default: "p1/m1", tiers: {} },
    mode: "detect",
    repair: { maxAttempts: 2, destructiveTools: [] },
    log: { level: "silent", file: null },
  };
}

function messages(p: number, body: Record<string, unknown>): Promise<Response> {
  return fetch(`http://127.0.0.1:${p}/v1/messages`, {
    method: "POST",
    headers: { "content-type": "application/json", "anthropic-version": "2023-06-01" },
    body: JSON.stringify(body),
  });
}

/** One Responses SSE frame: `event: <name>\ndata: <json>\n\n`. */
function sse(name: string, data: unknown): string {
  return `event: ${name}\ndata: ${JSON.stringify(data)}\n\n`;
}

/** Every Anthropic SSE event the client received, parsed in order. */
function parseAnthropicSse(text: string): Array<{ type: string; data: Record<string, unknown> }> {
  return text
    .split(/\n\n+/)
    .filter((block) => block.trim().length > 0)
    .map((block) => {
      const dataLine = block.split("\n").find((l) => l.startsWith("data:"));
      return JSON.parse((dataLine ?? "data: {}").slice(5).trim()) as { type: string; data: Record<string, unknown> } & Record<string, unknown>;
    })
    .map((data) => ({ type: data.type as string, data: data as unknown as Record<string, unknown> }));
}

describe("wire: \"responses\" upstream — text round trip", () => {
  it("maps a plain user turn to input_text and a buffered output_text reply back to a text block", async () => {
    const winner = await scriptedResponses(() => ({
      body: JSON.stringify({
        id: "resp_1", object: "response", status: "completed", model: "muse-spark-1.3",
        output: [{ type: "message", id: "msg_1", status: "completed", role: "assistant", content: [{ type: "output_text", text: "hello from responses", annotations: [] }] }],
        output_text: "hello from responses",
        usage: { input_tokens: 10, output_tokens: 5, total_tokens: 15 },
      }),
    }));
    const failed = await scriptedResponses(() => ({ status: 429, body: JSON.stringify({ error: { message: "busy" } }) }));
    const p = port(await startProxy(responsesPoolCfg([
      `http://127.0.0.1:${port(failed.server)}`,
      `http://127.0.0.1:${port(winner.server)}`,
    ])));

    const resp = await messages(p, { model: "pool/resp", max_tokens: 20, messages: [{ role: "user", content: "hi" }] });
    const body = (await resp.json()) as { content: Array<{ type: string; text: string }>; stop_reason: string };

    expect(resp.status).toBe(200);
    expect(body.content).toEqual([{ type: "text", text: "hello from responses" }]);
    expect(body.stop_reason).toBe("end_turn");
    expect(failed.calls()).toBe(1);
    expect(winner.calls()).toBe(1);

    const outbound = winner.bodies()[0]!;
    expect(outbound.input).toEqual([{ role: "user", content: [{ type: "input_text", text: "hi" }] }]);
    expect(outbound.stream).toBe(false);
    expect(outbound.model).toBe("m2");
  });
});

describe("wire: \"responses\" upstream — tool call round trip", () => {
  it("carries a tool declaration out flat and a native function_call back as tool_use with the id intact", async () => {
    const winner = await scriptedResponses(() => ({
      body: JSON.stringify({
        id: "resp_2", object: "response", status: "completed", model: "muse-spark-1.3",
        output: [{ type: "function_call", id: "fc_1", call_id: "call_abc123456", name: "add", arguments: JSON.stringify({ a: 1, b: 2 }), status: "completed" }],
        usage: { input_tokens: 20, output_tokens: 8 },
      }),
    }));
    const failed = await scriptedResponses(() => ({ status: 429, body: JSON.stringify({ error: { message: "busy" } }) }));
    const p = port(await startProxy(responsesPoolCfg([
      `http://127.0.0.1:${port(failed.server)}`,
      `http://127.0.0.1:${port(winner.server)}`,
    ])));

    const resp = await messages(p, {
      model: "pool/resp", max_tokens: 20,
      tools: [{ name: "add", description: "adds two numbers", input_schema: { type: "object", properties: { a: { type: "number" }, b: { type: "number" } } } }],
      messages: [{ role: "user", content: "use the add tool" }],
    });
    const body = (await resp.json()) as { content: Array<{ type: string; id: string; name: string; input: unknown }>; stop_reason: string };

    expect(resp.status).toBe(200);
    expect(body.content).toEqual([{ type: "tool_use", id: "call_abc123456", name: "add", input: { a: 1, b: 2 } }]);
    expect(body.stop_reason).toBe("tool_use");

    const outbound = winner.bodies()[0]!;
    expect(outbound.tools).toEqual([{ type: "function", name: "add", description: "adds two numbers", parameters: { type: "object", properties: { a: { type: "number" }, b: { type: "number" } } } }]);
  });

  it("answers a tool_result with a matching function_call_output carrying the SAME call_id", async () => {
    const winner = await scriptedResponses(() => ({
      body: JSON.stringify({
        id: "resp_3", object: "response", status: "completed", model: "muse-spark-1.3",
        output: [{ type: "message", id: "msg_2", status: "completed", role: "assistant", content: [{ type: "output_text", text: "the sum is 3", annotations: [] }] }],
        usage: { input_tokens: 30, output_tokens: 6 },
      }),
    }));
    const failed = await scriptedResponses(() => ({ status: 429, body: JSON.stringify({ error: { message: "busy" } }) }));
    const p = port(await startProxy(responsesPoolCfg([
      `http://127.0.0.1:${port(failed.server)}`,
      `http://127.0.0.1:${port(winner.server)}`,
    ])));

    const resp = await messages(p, {
      model: "pool/resp", max_tokens: 20,
      tools: [{ name: "add", input_schema: { type: "object", properties: {} } }],
      messages: [
        { role: "user", content: "use the add tool" },
        { role: "assistant", content: [{ type: "tool_use", id: "call_abc123456", name: "add", input: { a: 1, b: 2 } }] },
        { role: "user", content: [{ type: "tool_result", tool_use_id: "call_abc123456", content: "3" }] },
      ],
    });
    expect(resp.status).toBe(200);

    const outbound = winner.bodies()[0]!;
    const input = outbound.input as Array<Record<string, unknown>>;
    expect(input).toContainEqual({ type: "function_call", call_id: "call_abc123456", name: "add", arguments: JSON.stringify({ a: 1, b: 2 }) });
    expect(input).toContainEqual({ type: "function_call_output", call_id: "call_abc123456", output: "3" });
  });
});

describe("wire: \"responses\" upstream — streamed text and tool call", () => {
  it("translates response.output_text.delta and response.function_call_arguments.delta to client-visible Anthropic SSE", async () => {
    const streamBody = [
      sse("response.created", { type: "response.created", response: { id: "resp_4", model: "muse-spark-1.3", status: "in_progress" } }),
      sse("response.output_item.added", { type: "response.output_item.added", output_index: 0, item: { type: "message", id: "msg_3", status: "in_progress", role: "assistant", content: [] } }),
      sse("response.content_part.added", { type: "response.content_part.added", item_id: "msg_3", output_index: 0, content_index: 0, part: { type: "output_text", text: "" } }),
      sse("response.output_text.delta", { type: "response.output_text.delta", item_id: "msg_3", output_index: 0, content_index: 0, delta: "Hi" }),
      sse("response.output_text.delta", { type: "response.output_text.delta", item_id: "msg_3", output_index: 0, content_index: 0, delta: " there" }),
      sse("response.output_item.done", { type: "response.output_item.done", output_index: 0, item: { type: "message", id: "msg_3", status: "completed", role: "assistant", content: [{ type: "output_text", text: "Hi there", annotations: [] }] } }),
      sse("response.output_item.added", { type: "response.output_item.added", output_index: 1, item: { type: "function_call", id: "fc_2", call_id: "call_streamed01", name: "add", arguments: "", status: "in_progress" } }),
      sse("response.function_call_arguments.delta", { type: "response.function_call_arguments.delta", item_id: "fc_2", output_index: 1, delta: "{\"a\":" }),
      sse("response.function_call_arguments.delta", { type: "response.function_call_arguments.delta", item_id: "fc_2", output_index: 1, delta: "1}" }),
      sse("response.output_item.done", { type: "response.output_item.done", output_index: 1, item: { type: "function_call", id: "fc_2", call_id: "call_streamed01", name: "add", arguments: "{\"a\":1}", status: "completed" } }),
      sse("response.completed", { type: "response.completed", response: { id: "resp_4", model: "muse-spark-1.3", status: "completed", usage: { input_tokens: 12, output_tokens: 9 } } }),
    ].join("");
    const winner = await scriptedResponses(() => ({ headers: { "content-type": "text/event-stream" }, body: streamBody }));
    const failed = await scriptedResponses(() => ({ status: 429, body: JSON.stringify({ error: { message: "busy" } }) }));
    const p = port(await startProxy(responsesPoolCfg([
      `http://127.0.0.1:${port(failed.server)}`,
      `http://127.0.0.1:${port(winner.server)}`,
    ])));

    const resp = await messages(p, {
      model: "pool/resp", max_tokens: 20, stream: true,
      tools: [{ name: "add", input_schema: { type: "object", properties: {} } }],
      messages: [{ role: "user", content: "hi, then call add" }],
    });
    expect(resp.status).toBe(200);
    const text = await resp.text();
    const events = parseAnthropicSse(text);
    const types = events.map((e) => e.type);

    expect(types).toEqual([
      "message_start",
      "content_block_start", "content_block_delta", "content_block_delta", "content_block_stop",
      "content_block_start", "content_block_delta", "content_block_delta", "content_block_stop",
      "message_delta", "message_stop",
    ]);

    const textDeltas = events.filter((e) => e.type === "content_block_delta" && (e.data.delta as Record<string, unknown>).type === "text_delta");
    expect(textDeltas.map((e) => (e.data.delta as Record<string, unknown>).text)).toEqual(["Hi", " there"]);

    const toolStart = events.find((e) => e.type === "content_block_start" && (e.data.content_block as Record<string, unknown>).type === "tool_use")!;
    expect(toolStart.data.content_block).toEqual({ type: "tool_use", id: "call_streamed01", name: "add", input: {} });

    const jsonDeltas = events.filter((e) => e.type === "content_block_delta" && (e.data.delta as Record<string, unknown>).type === "input_json_delta");
    expect(jsonDeltas.map((e) => (e.data.delta as Record<string, unknown>).partial_json).join("")).toBe("{\"a\":1}");

    const messageDelta = events.find((e) => e.type === "message_delta")!;
    expect((messageDelta.data.delta as Record<string, unknown>).stop_reason).toBe("tool_use");
  });
});

describe("wire: \"responses\" upstream — usage", () => {
  it("splits cached_tokens out of input_tokens and carries reasoning_tokens folded into output_tokens", async () => {
    const winner = await scriptedResponses(() => ({
      body: JSON.stringify({
        id: "resp_5", object: "response", status: "completed", model: "muse-spark-1.3",
        output: [{ type: "message", id: "msg_4", status: "completed", role: "assistant", content: [{ type: "output_text", text: "OK", annotations: [] }] }],
        usage: {
          input_tokens: 100, input_tokens_details: { cached_tokens: 40 },
          output_tokens: 60, output_tokens_details: { reasoning_tokens: 20 },
          total_tokens: 160,
        },
      }),
    }));
    const failed = await scriptedResponses(() => ({ status: 429, body: JSON.stringify({ error: { message: "busy" } }) }));
    const p = port(await startProxy(responsesPoolCfg([
      `http://127.0.0.1:${port(failed.server)}`,
      `http://127.0.0.1:${port(winner.server)}`,
    ])));

    const resp = await messages(p, { model: "pool/resp", max_tokens: 20, messages: [{ role: "user", content: "hi" }] });
    const body = (await resp.json()) as { usage: { input_tokens: number; output_tokens: number; cache_read_input_tokens: number } };

    expect(resp.status).toBe(200);
    // Anthropic's input_tokens EXCLUDES cache reads (the same split `openAiPromptUsageToAnthropic`
    // performs for Chat's prompt_tokens), so 100 total - 40 cached = 60 exclusive.
    expect(body.usage.input_tokens).toBe(60);
    expect(body.usage.cache_read_input_tokens).toBe(40);
    // reasoning_tokens (20) is a SUBSET already counted inside output_tokens (the same inclusion
    // rule Chat's completion_tokens_details.reasoning_tokens would follow), so output_tokens is
    // reported whole, unchanged, never split.
    expect(body.usage.output_tokens).toBe(60);
  });
});

describe("wire: \"responses\" upstream — failure classification", () => {
  it("fails a pre-content in-band error over to the second candidate", async () => {
    const dead = await scriptedResponses(() => ({
      headers: { "content-type": "text/event-stream" },
      body: 'data: {"error":{"message":"boom"}}\n\n',
    }));
    // The client asked to STREAM (`stream: true` below), so every candidate is asked to stream
    // too — a buffered JSON body here would itself look like a malformed SSE stream to the second
    // candidate's own preflight, which is not what this test means to exercise.
    const winner = await scriptedResponses(() => ({
      headers: { "content-type": "text/event-stream" },
      body: sse("response.completed", {
        type: "response.completed",
        response: {
          id: "resp_6", model: "muse-spark-1.3", status: "completed",
          output: [{ type: "message", id: "msg_5", status: "completed", role: "assistant", content: [{ type: "output_text", text: "served", annotations: [] }] }],
          usage: { input_tokens: 5, output_tokens: 2 },
        },
      }),
    }));
    const p = port(await startProxy(responsesPoolCfg([
      `http://127.0.0.1:${port(dead.server)}`,
      `http://127.0.0.1:${port(winner.server)}`,
    ])));

    const resp = await messages(p, { model: "pool/resp", max_tokens: 20, stream: true, messages: [{ role: "user", content: "hi" }] });
    expect(resp.status).toBe(200);
    await resp.text();
    expect(dead.calls()).toBe(1);
    expect(winner.calls()).toBe(1);
  });

  it("refuses an unmodelled content block as a local 400 that reaches NEITHER candidate", async () => {
    const first = await scriptedResponses(() => ({ status: 200, body: JSON.stringify({ status: "completed", output: [] }) }));
    const second = await scriptedResponses(() => ({ status: 200, body: JSON.stringify({ status: "completed", output: [] }) }));
    const p = port(await startProxy(responsesPoolCfg([
      `http://127.0.0.1:${port(first.server)}`,
      `http://127.0.0.1:${port(second.server)}`,
    ])));

    const resp = await messages(p, {
      model: "pool/resp", max_tokens: 20,
      // `server_tool_use` has no representation in the Responses request mapper's user-turn
      // switch (it is an assistant-only Anthropic block in the real API, and never a user one) —
      // an unmodelled block, refused rather than stringified.
      messages: [{ role: "user", content: [{ type: "server_tool_use", id: "x", name: "y", input: {} }] }],
    });

    expect(resp.status).toBe(400);
    expect(first.calls()).toBe(0);
    expect(second.calls()).toBe(0);
  });
});

describe("wire: \"chat\" (the default) — unchanged by this packet", () => {
  it("still posts to /chat/completions with the pre-existing Chat body shape, byte for byte", async () => {
    const mock = await scriptedResponses(() => ({
      body: JSON.stringify({ id: "cmpl_1", object: "chat.completion", choices: [{ message: { role: "assistant", content: "hi from chat" }, finish_reason: "stop" }] }),
    }));
    const p = port(await startProxy(chatCfg(`http://127.0.0.1:${port(mock.server)}`)));

    const resp = await messages(p, { model: "p1/m1", max_tokens: 20, messages: [{ role: "user", content: "hi" }] });
    const body = (await resp.json()) as { content: Array<{ type: string; text: string }> };

    expect(resp.status).toBe(200);
    expect(body.content).toEqual([{ type: "text", text: "hi from chat" }]);
    const outbound = mock.bodies()[0]!;
    // The pre-existing Chat request shape: `messages`, never `input`; no Responses-only fields.
    expect(outbound.messages).toEqual([{ role: "user", content: "hi" }]);
    expect(outbound.input).toBeUndefined();
    expect(outbound.instructions).toBeUndefined();
    expect(outbound.max_tokens).toBe(20);
    expect(outbound.max_output_tokens).toBeUndefined();
  });
});
