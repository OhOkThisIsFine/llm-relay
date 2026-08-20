import { describe, it, expect, afterEach } from "vitest";
import { createServer, type Server } from "node:http";
import { AddressInfo } from "node:net";
import {
  ERROR_ORIGIN_HEADER,
  errorOrigin,
  fetchBackend,
  fetchOpenAiFront,
  anthropicMessageToOpenAi,
  normalizeOpenAiErrorBody,
  openAiResponseToAnthropic,
  parseRetryAfterMs,
  upstreamReportedModel,
} from "../src/backend.js";
import type { ResolvedTarget } from "../src/config.js";
import { resolveAttempt } from "../src/resolved-attempt.js";
import { createUsageAccumulator } from "../src/usage-observer.js";

function openaiTarget(base: string, model = "meta/llama-3.1-70b-instruct"): ResolvedTarget {
  return {
    provider: "nim",
    base,
    kind: "openai",
    model,
    authHeader: "authorization",
    timeoutMs: 5000,
    authEnv: "RP_BACKEND_KEY",
  };
}

describe("openAiResponseToAnthropic", () => {
  it("keeps usage absent when the upstream omitted it", () => {
    const anth = openAiResponseToAnthropic({
      choices: [{ finish_reason: "stop", message: { role: "assistant", content: "ok" } }],
    }, "target") as Record<string, unknown>;
    expect(anth).not.toHaveProperty("usage");
  });

  it("maps a tool call to an Anthropic tool_use with stop_reason tool_use", () => {
    const anth = openAiResponseToAnthropic({
      id: "cmpl_1", model: "x",
      choices: [{ finish_reason: "tool_calls", message: { role: "assistant", content: null, tool_calls: [{ id: "call_1", function: { name: "get_weather", arguments: '{"city":"Paris"}' } }] } }],
      usage: { prompt_tokens: 10, completion_tokens: 5 },
    }, "target-model") as any;
    expect(anth.type).toBe("message");
    expect(anth.stop_reason).toBe("tool_use");
    expect(anth.model).toBe("target-model");
    expect(anth.content[0]).toEqual({ type: "tool_use", id: "call_1", name: "get_weather", input: { city: "Paris" } });
    expect(anth.usage).toEqual({ input_tokens: 10, output_tokens: 5 });
  });

  it("maps a plain text completion to a text block with end_turn", () => {
    const anth = openAiResponseToAnthropic({
      choices: [{ finish_reason: "stop", message: { role: "assistant", content: "hello there" } }],
    }, "m") as any;
    expect(anth.content).toEqual([{ type: "text", text: "hello there" }]);
    expect(anth.stop_reason).toBe("end_turn");
  });

  it("strips a complete message-opening think block on the translated buffered path", () => {
    const anth = openAiResponseToAnthropic({
      choices: [{
        finish_reason: "stop",
        message: { role: "assistant", content: "<think>private reasoning</think>Visible answer" },
      }],
    }, "m") as any;

    expect(anth.content).toEqual([{ type: "text", text: "Visible answer" }]);
  });

  it("strips think text before dialect detection so the following envelope recovers", () => {
    const schemas = new Map([
      ["write_note", { type: "object", properties: { path: { type: "string" } } }],
    ]);
    const anth = openAiResponseToAnthropic({
      choices: [{
        finish_reason: "stop",
        message: {
          role: "assistant",
          content: '<think>choose a path</think><tool_call>{"name":"write_note","arguments":{"path":"a.txt"}}</tool_call>',
        },
      }],
    }, "m", schemas) as any;

    expect(anth.content).toEqual([
      { type: "tool_use", id: "tu_recovered_0", name: "write_note", input: { path: "a.txt" } },
    ]);
    expect(anth.stop_reason).toBe("tool_use");
  });
});

describe("anthropicMessageToOpenAi", () => {
  const message = {
    id: "msg_1",
    model: "claude-sonnet",
    content: [
      { type: "text", text: "hello" },
      { type: "tool_use", id: "call_1", name: "get_weather", input: { city: "Paris" } },
    ],
    stop_reason: "tool_use",
    usage: { input_tokens: 10, output_tokens: 5 },
  };

  it("maps text, tool calls, stop reason and usage to Chat Completions", () => {
    const out = anthropicMessageToOpenAi(message, "chat") as any;
    expect(out.object).toBe("chat.completion");
    expect(out.choices[0].message).toEqual({
      role: "assistant",
      content: "hello",
      tool_calls: [{
        id: "call_1",
        type: "function",
        function: { name: "get_weather", arguments: '{"city":"Paris"}' },
      }],
    });
    expect(out.choices[0].finish_reason).toBe("tool_calls");
    expect(out.usage).toEqual({ prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 });
  });

  it("maps the same message to a Responses output", () => {
    const out = anthropicMessageToOpenAi(message, "responses") as any;
    expect(out.object).toBe("response");
    expect(out.output[0].content[0]).toEqual({ type: "output_text", text: "hello", annotations: [] });
    expect(out.output[1]).toMatchObject({ type: "function_call", call_id: "call_1", name: "get_weather" });
    expect(out.output_text).toBe("hello");
    expect(out.usage.total_tokens).toBe(15);
  });
});

describe("fetchBackend (openai kind) — request translation + response mapping", () => {
  let backend: Server;
  afterEach(() => backend?.close());

  it("translates an Anthropic request to OpenAI /chat/completions and maps the response back", async () => {
    process.env.RP_BACKEND_KEY = "sk-nim";
    let seen: any = null;
    let seenAuth: string | undefined;
    let fetches = 0;
    let egresses = 0;
    backend = await new Promise<Server>((resolve) => {
      const s = createServer((req, res) => {
        fetches += 1;
        seenAuth = req.headers["authorization"] as string | undefined;
        const chunks: Buffer[] = [];
        req.on("data", (c) => chunks.push(c));
        req.on("end", () => {
          seen = JSON.parse(Buffer.concat(chunks).toString());
          res.writeHead(200, { "content-type": "application/json" });
          res.end(JSON.stringify({ id: "cmpl", model: "upstream-substitute", choices: [{ finish_reason: "tool_calls", message: { tool_calls: [{ id: "c1", function: { name: "get_weather", arguments: '{"city":"Rome"}' } }] } }] }));
        });
      });
      s.listen(0, "127.0.0.1", () => resolve(s));
    });
    const target = openaiTarget(`http://127.0.0.1:${(backend.address() as AddressInfo).port}`);
    const anthropicReq = { model: "claude-x", stream: false, messages: [{ role: "user", content: "weather in Rome?" }], tools: [{ name: "get_weather", description: "w", input_schema: { type: "object", properties: { city: { type: "string" } }, required: ["city"] } }] };

    const res = await fetchBackend(resolveAttempt(target), {
      path: "/v1/messages", method: "POST",
      reqBuf: Buffer.from(JSON.stringify(anthropicReq)), reqJson: anthropicReq,
      anthropicHeaders: {}, wantsStream: false, signal: AbortSignal.timeout(5000),
      onEgress: () => { egresses += 1; },
    });
    const body = (await res.json()) as any;

    // hit the OpenAI endpoint, with the configured model + Bearer auth
    expect(seen.model).toBe("meta/llama-3.1-70b-instruct");
    expect(seenAuth).toBe("Bearer sk-nim");
    // tools translated to OpenAI function shape
    expect(seen.tools?.[0]?.function?.name).toBe("get_weather");
    // response mapped back to Anthropic tool_use
    expect(body.content[0]).toEqual({ type: "tool_use", id: "c1", name: "get_weather", input: { city: "Rome" } });
    expect(body.stop_reason).toBe("tool_use");
    expect(body.model).toBe("meta/llama-3.1-70b-instruct");
    expect(upstreamReportedModel(res)).toBe("upstream-substitute");
    expect(fetches).toBe(1);
    expect(egresses).toBe(1);
    delete process.env.RP_BACKEND_KEY;
  });

  it("strips a split opening think block from the translated streaming path", async () => {
    process.env.RP_BACKEND_KEY = "sk-nim";
    try {
      const target = openaiTarget("https://openai-backend.test");
      const req = { model: "claude-x", stream: true, messages: [{ role: "user", content: "hi" }] };
      const openAiSse = [
        `data: ${JSON.stringify({ id: "cmpl", model: "m", choices: [{ index: 0, delta: { role: "assistant" }, finish_reason: null }] })}\n\n`,
        `data: ${JSON.stringify({ id: "cmpl", model: "m", choices: [{ index: 0, delta: { content: "<think>hidden</thi" }, finish_reason: null }] })}\n\n`,
        `data: ${JSON.stringify({ id: "cmpl", model: "m", choices: [{ index: 0, delta: { content: "nk>Visible" }, finish_reason: null }] })}\n\n`,
        `data: ${JSON.stringify({ id: "cmpl", model: "m", choices: [{ index: 0, delta: {}, finish_reason: "stop" }] })}\n\n`,
        "data: [DONE]\n\n",
      ].join("");

      const res = await fetchBackend(resolveAttempt(target), {
        path: "/v1/messages",
        method: "POST",
        reqBuf: Buffer.from(JSON.stringify(req)),
        reqJson: req,
        anthropicHeaders: {},
        wantsStream: true,
        signal: AbortSignal.timeout(1000),
      }, async () => new Response(openAiSse, {
        status: 200,
        headers: { "content-type": "text/event-stream" },
      }));

      const out = await res.text();
      expect(out).toContain("Visible");
      expect(out).not.toContain("hidden");
      expect(out).not.toContain("<think>");
    } finally {
      delete process.env.RP_BACKEND_KEY;
    }
  });

  it("captures a streamed Anthropic model even when a leading ping ends preflight", async () => {
    const target: ResolvedTarget = {
      provider: "anthropic",
      base: "https://anthropic-backend.test",
      kind: "anthropic",
      model: "routed-model",
      authHeader: "x-api-key",
      timeoutMs: 1000,
    };
    const raw = [
      `event: ping\ndata: ${JSON.stringify({ type: "ping" })}\n\n`,
      `event: message_start\ndata: ${JSON.stringify({ type: "message_start", message: { id: "msg_stream", model: "upstream-substitute" } })}\n\n`,
      `event: message_stop\ndata: ${JSON.stringify({ type: "message_stop" })}\n\n`,
    ].join("");
    const res = await fetchBackend(resolveAttempt(target), {
      path: "/v1/messages",
      method: "POST",
      reqBuf: Buffer.from("{}"),
      reqJson: {},
      anthropicHeaders: {},
      wantsStream: true,
      signal: AbortSignal.timeout(1000),
    }, async () => new Response(raw, {
      status: 200,
      headers: { "content-type": "text/event-stream" },
    }));

    await res.text();
    expect(upstreamReportedModel(res)).toBe("upstream-substitute");
  });

  it("leaves literal think tags untouched on native Anthropic passthrough", async () => {
    const target: ResolvedTarget = {
      provider: "anthropic",
      base: "https://anthropic-backend.test",
      kind: "anthropic",
      authHeader: "x-api-key",
      timeoutMs: 1000,
    };
    const raw = JSON.stringify({
      id: "msg_native",
      type: "message",
      role: "assistant",
      content: [{ type: "text", text: "<think>literal native text</think>Answer" }],
      stop_reason: "end_turn",
      usage: { input_tokens: 1, output_tokens: 1 },
    });
    const res = await fetchBackend(resolveAttempt(target), {
      path: "/v1/messages",
      method: "POST",
      reqBuf: Buffer.from("{}"),
      reqJson: {},
      anthropicHeaders: {},
      wantsStream: false,
      signal: AbortSignal.timeout(1000),
    }, async () => new Response(raw, {
      status: 200,
      headers: { "content-type": "application/json" },
    }));

    expect(await res.text()).toBe(raw);
  });

  it("refuses a document block it cannot convert instead of leaking base64 into the prompt", async () => {
    let hit = false;
    let egresses = 0;
    backend = await new Promise<Server>((resolve) => {
      const s = createServer((_req, res) => {
        hit = true;
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ choices: [{ finish_reason: "stop", message: { content: "ok" } }] }));
      });
      s.listen(0, "127.0.0.1", () => resolve(s));
    });
    const target = openaiTarget(`http://127.0.0.1:${(backend.address() as AddressInfo).port}`);
    const b64 = Buffer.from("%PDF-1.4 fake").toString("base64");
    const anthropicReq = {
      model: "claude-x",
      messages: [{ role: "user", content: [{ type: "document", source: { type: "url", url: "https://x.invalid/a.pdf" } }] }],
    };

    const res = await fetchBackend(resolveAttempt(target), {
      path: "/v1/messages", method: "POST",
      reqBuf: Buffer.from(JSON.stringify(anthropicReq)), reqJson: anthropicReq,
      anthropicHeaders: {}, wantsStream: false, signal: AbortSignal.timeout(5000),
      onEgress: () => { egresses += 1; },
    });

    expect(res.status).toBe(400);
    expect(hit).toBe(false); // never reached the provider
    expect(egresses).toBe(0);
    const body = (await res.json()) as any;
    expect(body.error.message).toMatch(/url. source are not supported/);
    expect(JSON.stringify(body)).not.toContain(b64);
    // ...and it says so: the provider was never asked, so this must not be charged to it.
    expect(errorOrigin(res)).toBe("local");
  });

  it("labels a real provider failure `upstream` and a locally-synthesized one `local`", async () => {
    backend = await new Promise<Server>((resolve) => {
      const s = createServer((_req, res) => {
        res.writeHead(503, { "content-type": "application/json" });
        res.end(JSON.stringify({ error: { message: "model is loading" } }));
      });
      s.listen(0, "127.0.0.1", () => resolve(s));
    });
    const target = openaiTarget(`http://127.0.0.1:${(backend.address() as AddressInfo).port}`);
    const req = { model: "claude-x", messages: [{ role: "user", content: "hi" }] };

    const upstream = await fetchBackend(resolveAttempt(target), {
      path: "/v1/messages", method: "POST",
      reqBuf: Buffer.from(JSON.stringify(req)), reqJson: req,
      anthropicHeaders: {}, wantsStream: false, signal: AbortSignal.timeout(5000),
    });
    expect(upstream.status).toBe(503);
    expect(upstream.headers.get(ERROR_ORIGIN_HEADER)).toBe("upstream");

    // Same fetchBackend, same shape of Response, opposite meaning: without the marker a
    // caller counting failures records both as "the provider is unhealthy" and fails over
    // to a second provider that would refuse this document identically.
    const local = await fetchBackend(resolveAttempt(target), {
      path: "/v1/messages", method: "POST",
      reqBuf: Buffer.from("{}"),
      reqJson: { model: "claude-x", messages: [{ role: "user", content: [{ type: "document", source: { type: "url", url: "https://x.invalid/a.pdf" } }] }] },
      anthropicHeaders: {}, wantsStream: false, signal: AbortSignal.timeout(5000),
    });
    expect(errorOrigin(local)).toBe("local");
    expect(errorOrigin(upstream)).not.toBe(errorOrigin(local));
  });

  it("rejects a malformed buffered OpenAI 2xx as an upstream envelope failure", async () => {
    const target = openaiTarget("https://openai-backend.test");
    const req = { model: "claude-x", messages: [{ role: "user", content: "hi" }] };
    const res = await fetchBackend(resolveAttempt(target), {
      path: "/v1/messages", method: "POST",
      reqBuf: Buffer.from(JSON.stringify(req)), reqJson: req,
      anthropicHeaders: {}, wantsStream: false, signal: AbortSignal.timeout(1000),
    }, async () => new Response("{}", { status: 200, headers: { "content-type": "application/json", "retry-after": "7" } }));

    expect(res.status).toBe(502);
    expect(errorOrigin(res)).toBe("upstream");
    expect(res.headers.get("retry-after")).toBe("7");
    const body = await res.json() as any;
    expect(body.error.type).toBe("invalid_upstream_envelope");
    expect(body.error.message).toContain("missing choices array");
    expect(body.error.message.length).toBeLessThan(300);
  });

  it("rejects the equivalent malformed OpenAI SSE 2xx before stream translation", async () => {
    const target = openaiTarget("https://openai-backend.test");
    const req = { model: "claude-x", stream: true, messages: [{ role: "user", content: "hi" }] };
    const res = await fetchBackend(resolveAttempt(target), {
      path: "/v1/messages", method: "POST",
      reqBuf: Buffer.from(JSON.stringify(req)), reqJson: req,
      anthropicHeaders: {}, wantsStream: true, signal: AbortSignal.timeout(1000),
    }, async () => new Response("data: {}\n\n", { status: 200, headers: { "content-type": "text/event-stream" } }));

    expect(res.status).toBe(502);
    expect(errorOrigin(res)).toBe("upstream");
    expect((await res.json() as any).error.type).toBe("invalid_upstream_envelope");
  });

  it("rejects malformed native Anthropic buffered and streamed 2xx passthrough envelopes", async () => {
    const target: ResolvedTarget = {
      provider: "anthropic",
      base: "https://anthropic-backend.test",
      kind: "anthropic",
      authHeader: "x-api-key",
      timeoutMs: 1000,
    };
    for (const wantsStream of [false, true]) {
      const raw = wantsStream ? "event: message_start\ndata: {}\n\n" : "{}";
      const res = await fetchBackend(resolveAttempt(target), {
        path: "/v1/messages",
        method: "POST",
        reqBuf: Buffer.from("{}"),
        reqJson: {},
        anthropicHeaders: {},
        wantsStream,
        signal: AbortSignal.timeout(1000),
      }, async () => new Response(raw, {
        status: 200,
        headers: { "content-type": wantsStream ? "text/event-stream" : "application/json" },
      }));

      expect(res.status).toBe(502);
      expect(errorOrigin(res)).toBe("upstream");
      expect((await res.json() as any).error.type).toBe("invalid_upstream_envelope");
    }
  });

  it("rejects malformed direct OpenAI-front buffered and streamed 2xx envelopes", async () => {
    process.env.RP_BACKEND_KEY = "sk-nim";
    try {
      const target = openaiTarget("https://openai-backend.test");
      for (const wantsStream of [false, true]) {
        const raw = wantsStream ? "data: {}\n\n" : "{}";
        const res = await fetchOpenAiFront(resolveAttempt(target), {
          reqJson: { model: "requested", messages: [{ role: "user", content: "hi" }] },
          wantsStream,
          signal: AbortSignal.timeout(1000),
          protocol: "chat",
        }, async () => new Response(raw, {
          status: 200,
          headers: { "content-type": wantsStream ? "text/event-stream" : "application/json" },
        }));

        expect(res.status).toBe(502);
        expect(errorOrigin(res)).toBe("upstream");
        expect((await res.json() as any).error.type).toBe("invalid_upstream_envelope");
      }
    } finally {
      delete process.env.RP_BACKEND_KEY;
    }
  });

  it("translates an OpenAI front request for an Anthropic target", async () => {
    let seen: any;
    let egresses = 0;
    const anthropicKind = {
      ...openaiTarget("https://api.anthropic.test"),
      kind: "anthropic" as const,
    };
    delete anthropicKind.model;
    delete anthropicKind.authEnv;
    const res = await fetchOpenAiFront(
      resolveAttempt(anthropicKind),
      {
        reqJson: { model: "m", messages: [{ role: "user", content: "hello" }] },
        wantsStream: false,
        signal: AbortSignal.timeout(1000),
        anthropicHeaders: { "x-api-key": "sk-anthropic" },
        onEgress: () => { egresses += 1; },
      },
      async (_url, init) => {
        seen = JSON.parse(String(init?.body));
        return new Response(JSON.stringify({
          id: "msg_1",
          model: "claude-sonnet",
          content: [{ type: "text", text: "hello from Claude" }],
          stop_reason: "end_turn",
          usage: { input_tokens: 2, output_tokens: 3 },
        }), { status: 200, headers: { "content-type": "application/json" } });
      },
    );
    expect(res.status).toBe(200);
    expect(seen.max_tokens).toBe(1024);
    expect(seen.messages[0].content[0].text).toBe("hello");
    expect((await res.json() as any).choices[0].message.content).toBe("hello from Claude");
    expect(egresses).toBe(1);
  });

  it("rejects invalid Responses input before provider egress", async () => {
    const anthropicKind = {
      ...openaiTarget("https://api.anthropic.test"),
      kind: "anthropic" as const,
    };
    delete anthropicKind.model;
    delete anthropicKind.authEnv;
    let fetches = 0;
    let egresses = 0;

    const res = await fetchOpenAiFront(
      resolveAttempt(anthropicKind),
      {
        reqJson: { model: "m", input: [null] },
        wantsStream: false,
        protocol: "responses",
        signal: AbortSignal.timeout(1000),
        onEgress: () => { egresses += 1; },
      },
      async () => {
        fetches += 1;
        return new Response("{}", { status: 200 });
      },
    );

    expect(res.status).toBe(400);
    expect(errorOrigin(res)).toBe("local");
    expect(fetches).toBe(0);
    expect(egresses).toBe(0);
  });

  it("rejects malformed buffered and streamed Anthropic 2xx envelopes before translation", async () => {
    const anthropicKind = { ...openaiTarget("https://api.anthropic.test"), kind: "anthropic" as const };
    delete anthropicKind.model;
    delete anthropicKind.authEnv;
    for (const wantsStream of [false, true]) {
      const raw = wantsStream ? "event: message_start\ndata: {}\n\n" : "{}";
      const res = await fetchOpenAiFront(resolveAttempt(anthropicKind), {
        reqJson: { model: "m", messages: [{ role: "user", content: "hello" }], stream: wantsStream },
        wantsStream,
        signal: AbortSignal.timeout(1000),
      }, async () => new Response(raw, {
        status: 200,
        headers: { "content-type": wantsStream ? "text/event-stream" : "application/json" },
      }));

      expect(res.status).toBe(502);
      expect(errorOrigin(res)).toBe("upstream");
      expect((await res.json() as any).error.type).toBe("invalid_upstream_envelope");
    }
  });

  it("attributes a post-validation mapper defect to the relay", async () => {
    const anthropicKind = { ...openaiTarget("https://api.anthropic.test"), kind: "anthropic" as const };
    delete anthropicKind.model;
    delete anthropicKind.authEnv;
    const circular: Record<string, unknown> = {};
    circular.self = circular;
    const upstream = new Response('{"content":[]}', { status: 200, headers: { "content-type": "application/json" } });
    Object.defineProperty(upstream, "json", {
      value: async () => ({ content: [{ type: "tool_use", id: "call_1", name: "tool", input: circular }] }),
    });

      const res = await fetchOpenAiFront(resolveAttempt(anthropicKind), {
      reqJson: { model: "m", messages: [{ role: "user", content: "hello" }] },
      wantsStream: false,
      signal: AbortSignal.timeout(1000),
    }, async () => upstream);

    expect(res.status).toBe(502);
    expect(errorOrigin(res)).toBe("local");
    expect((await res.json() as any).error.type).toBe("relay_mapper_defect");
  });

  it("translates an Anthropic SSE response to an OpenAI Responses SSE response", async () => {
    const anthropicSse = [
      `event: message_start\ndata: ${JSON.stringify({ type: "message_start", message: { id: "msg_stream", model: "claude-sonnet", usage: { input_tokens: 2, output_tokens: 0 } } })}\n\n`,
      `event: content_block_start\ndata: ${JSON.stringify({ type: "content_block_start", index: 0, content_block: { type: "text", text: "" } })}\n\n`,
      `event: content_block_delta\ndata: ${JSON.stringify({ type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "streamed" } })}\n\n`,
      `event: content_block_stop\ndata: ${JSON.stringify({ type: "content_block_stop", index: 0 })}\n\n`,
      `event: message_delta\ndata: ${JSON.stringify({ type: "message_delta", delta: { stop_reason: "end_turn" }, usage: { output_tokens: 3 } })}\n\n`,
      `event: message_stop\ndata: ${JSON.stringify({ type: "message_stop" })}\n\n`,
    ].join("");
    const anthropicKind = {
      ...openaiTarget("https://api.anthropic.test"),
      kind: "anthropic" as const,
    };
    delete anthropicKind.model;
    delete anthropicKind.authEnv;
    const res = await fetchOpenAiFront(
      resolveAttempt(anthropicKind),
      {
        reqJson: { model: "claude", input: "hello", stream: true },
        wantsStream: true,
        protocol: "responses",
        anthropicHeaders: { "x-api-key": "sk-anthropic" },
        signal: AbortSignal.timeout(1000),
      },
      async () => new Response(anthropicSse, { status: 200, headers: { "content-type": "text/event-stream" } }),
    );
    const out = await res.text();
    expect(res.status).toBe(200);
    expect(out).toContain("response.output_text.delta");
    expect(out).toContain("streamed");
    expect(out).toContain("response.completed");
  });

  it("adapts an OpenAI-compatible SSE backend to the Responses SSE envelope", async () => {
    const openAiSse = [
      `data: ${JSON.stringify({ id: "cmpl_stream", model: "target", choices: [{ index: 0, delta: { role: "assistant", content: "streamed" }, finish_reason: null }] })}\n\n`,
      `data: ${JSON.stringify({ id: "cmpl_stream", model: "target", choices: [{ index: 0, delta: {}, finish_reason: "stop" }] })}\n\n`,
      `data: ${JSON.stringify({ id: "cmpl_stream", model: "target", choices: [], usage: { prompt_tokens: 2, completion_tokens: 3 } })}\n\n`,
      "data: [DONE]\n\n",
    ].join("");
    const target = openaiTarget("https://openai-backend.test", "target");
    const res = await fetchOpenAiFront(
      resolveAttempt(target),
      {
        reqJson: { model: "target", input: "hello", stream: true },
        wantsStream: true,
        protocol: "responses",
        signal: AbortSignal.timeout(1000),
      },
      async (_url, init) => {
        const request = JSON.parse(String(init?.body));
        expect(request.messages[0].content).toBe("hello");
        expect(request.stream_options).toEqual({ include_usage: true });
        return new Response(openAiSse, { status: 200, headers: { "content-type": "text/event-stream" } });
      },
    );
    const out = await res.text();
    expect(res.status).toBe(200);
    expect(out).toContain("response.output_text.delta");
    expect(out).toContain("response.completed");
  });

  it("asks a streaming openai backend for usage, and carries it into message_delta", async () => {
    let seen: any = null;
    backend = await new Promise<Server>((resolve) => {
      const s = createServer((req, res) => {
        const chunks: Buffer[] = [];
        req.on("data", (c) => chunks.push(c));
        req.on("end", () => {
          seen = JSON.parse(Buffer.concat(chunks).toString());
          res.writeHead(200, { "content-type": "text/event-stream" });
          res.write(`data: ${JSON.stringify({ id: "c", model: "m", choices: [{ index: 0, delta: { role: "assistant", content: "hi" } }] })}\n\n`);
          res.write(`data: ${JSON.stringify({ id: "c", model: "m", choices: [{ index: 0, delta: {}, finish_reason: "stop" }] })}\n\n`);
          res.write(`data: ${JSON.stringify({ id: "c", model: "m", choices: [], usage: { prompt_tokens: 11, completion_tokens: 7 } })}\n\n`);
          res.write("data: [DONE]\n\n");
          res.end();
        });
      });
      s.listen(0, "127.0.0.1", () => resolve(s));
    });
    const target = openaiTarget(`http://127.0.0.1:${(backend.address() as AddressInfo).port}`);
    const req = { model: "claude-x", stream: true, messages: [{ role: "user", content: "hi" }] };

    const res = await fetchBackend(resolveAttempt(target), {
      path: "/v1/messages", method: "POST",
      reqBuf: Buffer.from(JSON.stringify(req)), reqJson: req,
      anthropicHeaders: {}, wantsStream: true, signal: AbortSignal.timeout(5000),
    });
    const sse = await res.text();

    expect(seen.stream_options).toEqual({ include_usage: true });
    const delta = sse.split("\n").find((l) => l.startsWith("data:") && l.includes("message_delta"));
    expect(JSON.parse(delta!.slice(5)).usage.output_tokens).toBe(7);
  });

  it("retries without stream_options when the backend rejects it", async () => {
    const bodies: any[] = [];
    let egresses = 0;
    backend = await new Promise<Server>((resolve) => {
      const s = createServer((req, res) => {
        const chunks: Buffer[] = [];
        req.on("data", (c) => chunks.push(c));
        req.on("end", () => {
          const body = JSON.parse(Buffer.concat(chunks).toString());
          bodies.push(body);
          if (body.stream_options) {
            res.writeHead(400, { "content-type": "application/json" });
            res.end(JSON.stringify({ error: { message: "unknown field: stream_options" } }));
            return;
          }
          res.writeHead(200, { "content-type": "text/event-stream" });
          res.write(`data: ${JSON.stringify({ id: "c", model: "m", choices: [{ index: 0, delta: { role: "assistant", content: "ok" } }] })}\n\n`);
          res.write(`data: ${JSON.stringify({ id: "c", model: "m", choices: [{ index: 0, delta: {}, finish_reason: "stop" }] })}\n\n`);
          res.write("data: [DONE]\n\n");
          res.end();
        });
      });
      s.listen(0, "127.0.0.1", () => resolve(s));
    });
    const target = openaiTarget(`http://127.0.0.1:${(backend.address() as AddressInfo).port}`);
    const req = { model: "claude-x", stream: true, messages: [{ role: "user", content: "hi" }] };

    const res = await fetchBackend(resolveAttempt(target), {
      path: "/v1/messages", method: "POST",
      reqBuf: Buffer.from(JSON.stringify(req)), reqJson: req,
      anthropicHeaders: {}, wantsStream: true, signal: AbortSignal.timeout(5000),
      onEgress: () => { egresses += 1; },
    });

    expect(res.status).toBe(200);
    expect(bodies.length).toBe(2);
    expect(bodies[0].stream_options).toEqual({ include_usage: true });
    expect(bodies[1].stream_options).toBeUndefined();
    expect(egresses).toBe(1);
    expect(await res.text()).toContain("content_block_delta");
  });

  it("cancels unconsumed response body on retriable failures before retrying", async () => {
    let canceled = false;
    let callCount = 0;
    const customFetch: typeof fetch = async () => {
      callCount++;
      if (callCount === 1) {
        const stream = new ReadableStream({
          start(controller) {
            controller.enqueue(new TextEncoder().encode(JSON.stringify({ error: { message: "unknown field: stream_options" } })));
            controller.close();
          },
          cancel() {
            canceled = true;
          },
        });
        return new Response(stream, { status: 400, headers: { "content-type": "application/json" } });
      }
      return new Response(JSON.stringify({ choices: [{ finish_reason: "stop", message: { content: "ok" } }] }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    };

    const target = openaiTarget("http://127.0.0.1:9999");
    const req = { model: "claude-x", stream: true, messages: [{ role: "user", content: "hi" }] };
    const res = await fetchBackend(
      resolveAttempt(target),
      {
        path: "/v1/messages",
        method: "POST",
        reqBuf: Buffer.from(JSON.stringify(req)),
        reqJson: req,
        anthropicHeaders: {},
        wantsStream: true,
        signal: AbortSignal.timeout(5000),
      },
      customFetch,
    );

    expect(callCount).toBe(2);
    expect(canceled).toBe(true);
    expect(res.status).toBe(200);
  });
});

/**
 * The wire-shape primitives behind symptoms §3 and §4 of the 2026-07-30 report: a `Retry-After`
 * that nothing read, and error bodies that reached an OpenAI client in whatever shape the
 * provider chose.
 */
describe("parseRetryAfterMs", () => {
  const NOW = Date.parse("2026-07-30T12:00:00Z");

  it("reads delta-seconds, including the fractional form providers actually send", () => {
    expect(parseRetryAfterMs("20", NOW)).toBe(20000);
    expect(parseRetryAfterMs("20.4525", NOW)).toBe(20453); // groq's "try again in 20.4525s"
    expect(parseRetryAfterMs("0", NOW)).toBe(0);
  });

  it("reads the HTTP-date form", () => {
    expect(parseRetryAfterMs("Thu, 30 Jul 2026 12:00:30 GMT", NOW)).toBe(30000);
  });

  it("returns null — never 0 — for absent, garbage or already-past values", () => {
    // 0 would mean "retry immediately" and would silently disable the backoff this exists for.
    expect(parseRetryAfterMs(null, NOW)).toBeNull();
    expect(parseRetryAfterMs("", NOW)).toBeNull();
    expect(parseRetryAfterMs("soon", NOW)).toBeNull();
    expect(parseRetryAfterMs("-5", NOW)).toBeNull();
    expect(parseRetryAfterMs("Thu, 30 Jul 2026 11:59:30 GMT", NOW)).toBeNull(); // in the past
  });
});

describe("normalizeOpenAiErrorBody", () => {
  it("returns null for an already-conforming body, so the provider's own bytes are passed through", () => {
    const body = JSON.stringify({ error: { message: "rate limit", type: "rate_limit_error", code: "x" } });
    expect(normalizeOpenAiErrorBody(body, 429)).toBeNull();
  });

  it("unwraps gemini's array envelope to the error object itself, preserving its fields", () => {
    const body = JSON.stringify([{ error: { code: 503, message: "high demand", status: "UNAVAILABLE" } }]);
    const out = JSON.parse(normalizeOpenAiErrorBody(body, 503)!);
    expect(out.error.message).toBe("high demand");
    expect(out.error.status).toBe("UNAVAILABLE"); // the provider's own detail is not discarded
    expect(Array.isArray(out)).toBe(false);
  });

  it("wraps a non-JSON body, keeping the original text as the message", () => {
    const out = JSON.parse(normalizeOpenAiErrorBody("<html>502 Bad Gateway</html>", 502)!);
    expect(out.error.message).toContain("502 Bad Gateway");
    expect(out.error.code).toBe(502);
    expect(out.error.type).toBe("upstream_error");
  });

  it("wraps an empty body with a message that at least states the status", () => {
    const out = JSON.parse(normalizeOpenAiErrorBody("", 500)!);
    expect(out.error.message).toContain("500");
  });

  it("wraps valid JSON that is not an error envelope at all", () => {
    // A bare string or a naked object must not be handed to a client as if it were an envelope.
    expect(JSON.parse(normalizeOpenAiErrorBody(JSON.stringify({ detail: "nope" }), 400)!).error.code).toBe(400);
    expect(JSON.parse(normalizeOpenAiErrorBody(JSON.stringify("nope"), 400)!).error.message).toBe('"nope"');
  });
});

describe("direct OpenAI stream usage integration", () => {
  const streamWithUsage = [
    `data: ${JSON.stringify({ id: "c", choices: [{ index: 0, delta: { content: "ok" }, finish_reason: null }] })}\n\n`,
    `data: ${JSON.stringify({ id: "c", choices: [], usage: { prompt_tokens: 2, completion_tokens: 7 } })}\n\n`,
    "data: [DONE]\n\n",
  ].join("");

  it("observes but suppresses the relay-added usage event", async () => {
    const seen: Record<string, unknown>[] = [];
    const accumulator = createUsageAccumulator();
    const response = await fetchOpenAiFront(resolveAttempt(openaiTarget("https://backend.test", "m")), {
      reqJson: { model: "m", stream: true, messages: [{ role: "user", content: "hi" }] },
      wantsStream: true,
      usage: accumulator,
      signal: AbortSignal.timeout(1000),
    }, async (_url, init) => {
      seen.push(JSON.parse(String(init?.body)) as Record<string, unknown>);
      return new Response(streamWithUsage, { status: 200, headers: { "content-type": "text/event-stream" } });
    });
    expect(await response.text()).not.toContain("completion_tokens");
    expect(accumulator.completionTokens).toBe(7);
    expect(seen[0]?.stream_options).toEqual({ include_usage: true });
  });

  it("preserves a caller-requested usage event", async () => {
    const accumulator = createUsageAccumulator();
    const response = await fetchOpenAiFront(resolveAttempt(openaiTarget("https://backend.test", "m")), {
      reqJson: {
        model: "m",
        stream: true,
        stream_options: { include_usage: true },
        messages: [{ role: "user", content: "hi" }],
      },
      wantsStream: true,
      usage: accumulator,
      signal: AbortSignal.timeout(1000),
    }, async () => new Response(streamWithUsage, { status: 200, headers: { "content-type": "text/event-stream" } }));
    expect(await response.text()).toContain("completion_tokens");
    expect(accumulator.completionTokens).toBe(7);
  });

  it("keeps retained raw frame bytes byte-exact while suppressing only usage", async () => {
    const encoder = new TextEncoder();
    const first = encoder.encode(`data: ${JSON.stringify({ id: "c", choices: [{ index: 0, delta: { content: "ok" }, finish_reason: null }] })}\n\n`);
    const opaque = new Uint8Array([100, 97, 116, 97, 58, 32, 0xff, 10, 10]); // `data: <invalid utf-8>\n\n`
    const usage = encoder.encode(`data: ${JSON.stringify({ id: "c", choices: [], usage: { completion_tokens: 7 } })}\n\ndata: [DONE]\n\n`);
    const raw = new Uint8Array(first.byteLength + opaque.byteLength + usage.byteLength);
    raw.set(first);
    raw.set(opaque, first.byteLength);
    raw.set(usage, first.byteLength + opaque.byteLength);
    const response = await fetchOpenAiFront(resolveAttempt(openaiTarget("https://backend.test", "m")), {
      reqJson: { model: "m", stream: true, messages: [{ role: "user", content: "hi" }] },
      wantsStream: true,
      usage: createUsageAccumulator(),
      signal: AbortSignal.timeout(1000),
    }, async () => new Response(raw, { status: 200, headers: { "content-type": "text/event-stream" } }));
    const output = new Uint8Array(await response.arrayBuffer());
    const expected = new Uint8Array(first.byteLength + opaque.byteLength + encoder.encode("data: [DONE]\n\n").byteLength);
    expected.set(first);
    expected.set(opaque, first.byteLength);
    expected.set(encoder.encode("data: [DONE]\n\n"), first.byteLength + opaque.byteLength);
    expect(output).toEqual(expected);
  });

  it("retries an added usage hint once and leaves a no-usage retry unknown", async () => {
    const bodies: Record<string, unknown>[] = [];
    const accumulator = createUsageAccumulator();
    let egresses = 0;
    const response = await fetchOpenAiFront(resolveAttempt(openaiTarget("https://backend.test", "m")), {
      reqJson: { model: "m", stream: true, messages: [{ role: "user", content: "hi" }] },
      wantsStream: true,
      usage: accumulator,
      signal: AbortSignal.timeout(1000),
      onEgress: () => { egresses += 1; },
    }, async (_url, init) => {
      const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
      bodies.push(body);
      if (bodies.length === 1) return new Response(JSON.stringify({ error: { message: "unknown field" } }), { status: 422 });
      return new Response(
        `data: ${JSON.stringify({ id: "c", choices: [{ index: 0, delta: { content: "ok" }, finish_reason: null }] })}\n\ndata: [DONE]\n\n`,
        { status: 200, headers: { "content-type": "text/event-stream" } },
      );
    });
    expect(response.status).toBe(200);
    await response.text();
    expect(bodies[0]?.stream_options).toEqual({ include_usage: true });
    expect(bodies[1]?.stream_options).toBeUndefined();
    expect(accumulator.completionTokens).toBeUndefined();
    expect(egresses).toBe(1);
  });
});

describe("usage observation survives backend adapters", () => {
  const anthropicTarget: ResolvedTarget = {
    provider: "anthropic-test",
    base: "https://backend.test",
    kind: "anthropic",
    model: "claude-test",
    authHeader: "x-api-key",
    timeoutMs: 1000,
  };

  it("captures buffered Messages-front OpenAI usage before response mapping", async () => {
    const accumulator = createUsageAccumulator();
    const response = await fetchBackend(resolveAttempt(openaiTarget("https://backend.test", "m")), {
      path: "/v1/messages",
      method: "POST",
      reqBuf: Buffer.from(JSON.stringify({ model: "m", messages: [{ role: "user", content: "hi" }] })),
      reqJson: { model: "m", messages: [{ role: "user", content: "hi" }] },
      anthropicHeaders: {},
      wantsStream: false,
      usage: accumulator,
      signal: AbortSignal.timeout(1000),
    }, async () => new Response(JSON.stringify({
      choices: [{ finish_reason: "stop", message: { role: "assistant", content: "ok" } }],
      usage: { prompt_tokens: 2, completion_tokens: 4 },
    }), { headers: { "content-type": "application/json" } }));
    await response.json();
    expect(accumulator.completionTokens).toBe(4);
  });

  it("captures streamed native Anthropic usage before stream validation", async () => {
    const accumulator = createUsageAccumulator();
    const response = await fetchBackend(resolveAttempt(anthropicTarget), {
      path: "/v1/messages",
      method: "POST",
      reqBuf: Buffer.from("{}"),
      reqJson: {},
      anthropicHeaders: {},
      wantsStream: true,
      usage: accumulator,
      signal: AbortSignal.timeout(1000),
    }, async () => new Response([
      `event: message_start\ndata: ${JSON.stringify({ type: "message_start", message: { id: "m", model: "claude-test" } })}\n\n`,
      `event: message_delta\ndata: ${JSON.stringify({ type: "message_delta", usage: { output_tokens: 6 } })}\n\n`,
    ].join(""), { headers: { "content-type": "text/event-stream" } }));
    await response.text();
    expect(accumulator.completionTokens).toBe(6);
  });

  it("captures Responses-front completion usage through an Anthropic backend", async () => {
    const accumulator = createUsageAccumulator();
    const response = await fetchOpenAiFront(resolveAttempt(anthropicTarget), {
      protocol: "responses",
      reqJson: { model: "claude-test", input: "hi" },
      wantsStream: false,
      usage: accumulator,
      signal: AbortSignal.timeout(1000),
    }, async () => new Response(JSON.stringify({
      id: "m",
      type: "message",
      role: "assistant",
      model: "claude-test",
      content: [{ type: "text", text: "ok" }],
      stop_reason: "end_turn",
      usage: { input_tokens: 2, output_tokens: 8 },
    }), { headers: { "content-type": "application/json" } }));
    await response.json();
    expect(accumulator.completionTokens).toBe(8);
  });
});

describe("fetchBackend carries Retry-After onto its synthesized error", () => {
  it("does not destroy the one header that says when the provider will serve again", async () => {
    // fetchBackend builds a NEW Response for an upstream error, so the header was dropped here
    // and neither the breaker's cooldown nor the client's backoff could ever honour it.
    const backend = await new Promise<Server>((resolve) => {
      const s = createServer((req, res) => {
        req.on("data", () => {});
        req.on("end", () => {
          res.writeHead(429, { "content-type": "application/json", "retry-after": "42" });
          res.end(JSON.stringify({ error: { message: "slow down" } }));
        });
      });
      s.listen(0, "127.0.0.1", () => resolve(s));
    });
    try {
      const target = openaiTarget(`http://127.0.0.1:${(backend.address() as AddressInfo).port}`);
      const req = { model: "m", messages: [{ role: "user", content: "hi" }] };
      const res = await fetchBackend(resolveAttempt(target), {
        path: "/v1/messages", method: "POST",
        reqBuf: Buffer.from(JSON.stringify(req)), reqJson: req,
        anthropicHeaders: {}, wantsStream: false, signal: AbortSignal.timeout(5000),
      });
      expect(res.status).toBe(429);
      expect(res.headers.get("retry-after")).toBe("42");
      expect(errorOrigin(res)).toBe("upstream");
    } finally {
      backend.close();
    }
  });
});

describe("fetchBackend & fetchOpenAiFront — credential alias resolution", () => {
  let backend: Server;
  afterEach(() => backend?.close());

  it("resolves credential via environment alias in fetchBackend when declared authEnv is unset", async () => {
    const keys = ["GEMINI_API_KEY", "GOOGLEAI_API_KEY", "GOOGLE_AI_API_KEY", "GOOGLE_GENAI_API_KEY", "GOOGLE_GEMINI_API_KEY", "GOOGLE_API_KEY"];
    const saved: Record<string, string | undefined> = {};
    for (const k of keys) {
      saved[k] = process.env[k];
      delete process.env[k];
    }
    process.env.GOOGLEAI_API_KEY = "sk-googleai-alias-key";

    let seenAuth: string | undefined;
    backend = await new Promise<Server>((resolve) => {
      const s = createServer((req, res) => {
        seenAuth = req.headers["authorization"] as string | undefined;
        req.on("data", () => {});
        req.on("end", () => {
          res.writeHead(200, { "content-type": "application/json" });
          res.end(JSON.stringify({ choices: [{ finish_reason: "stop", message: { content: "ok" } }] }));
        });
      });
      s.listen(0, "127.0.0.1", () => resolve(s));
    });

    const target: ResolvedTarget = {
      provider: "gemini",
      base: `http://127.0.0.1:${(backend.address() as AddressInfo).port}`,
      kind: "openai",
      model: "gemini-2.0-flash",
      authHeader: "authorization",
      timeoutMs: 5000,
      authEnv: "GEMINI_API_KEY",
    };

    const req = { model: "gemini-2.0-flash", stream: false, messages: [{ role: "user", content: "hello" }] };
    try {
      await fetchBackend(resolveAttempt(target), {
        path: "/v1/messages",
        method: "POST",
        reqBuf: Buffer.from(JSON.stringify(req)),
        reqJson: req,
        anthropicHeaders: {},
        wantsStream: false,
        signal: AbortSignal.timeout(5000),
      });

      expect(seenAuth).toBe("Bearer sk-googleai-alias-key");
    } finally {
      for (const k of keys) {
        if (saved[k] !== undefined) process.env[k] = saved[k];
        else delete process.env[k];
      }
    }
  });

  it("resolves credential via environment alias in fetchOpenAiFront when declared authEnv is unset", async () => {
    const keys = ["GEMINI_API_KEY", "GOOGLEAI_API_KEY", "GOOGLE_AI_API_KEY", "GOOGLE_GENAI_API_KEY", "GOOGLE_GEMINI_API_KEY", "GOOGLE_API_KEY"];
    const saved: Record<string, string | undefined> = {};
    for (const k of keys) {
      saved[k] = process.env[k];
      delete process.env[k];
    }
    process.env.GOOGLEAI_API_KEY = "sk-googleai-alias-key-front";

    let seenAuth: string | undefined;
    backend = await new Promise<Server>((resolve) => {
      const s = createServer((req, res) => {
        seenAuth = req.headers["authorization"] as string | undefined;
        req.on("data", () => {});
        req.on("end", () => {
          res.writeHead(200, { "content-type": "application/json" });
          res.end(JSON.stringify({ choices: [{ finish_reason: "stop", message: { content: "ok" } }] }));
        });
      });
      s.listen(0, "127.0.0.1", () => resolve(s));
    });

    const target: ResolvedTarget = {
      provider: "gemini",
      base: `http://127.0.0.1:${(backend.address() as AddressInfo).port}`,
      kind: "openai",
      model: "gemini-2.0-flash",
      authHeader: "authorization",
      timeoutMs: 5000,
      authEnv: "GEMINI_API_KEY",
    };

    const req = { model: "gemini-2.0-flash", messages: [{ role: "user", content: "hello" }] };
    try {
      await fetchOpenAiFront(resolveAttempt(target), {
        reqJson: req,
        wantsStream: false,
        signal: AbortSignal.timeout(5000),
      });

      expect(seenAuth).toBe("Bearer sk-googleai-alias-key-front");
    } finally {
      for (const k of keys) {
        if (saved[k] !== undefined) process.env[k] = saved[k];
        else delete process.env[k];
      }
    }
  });
});
