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
  toolUseIdRewrites,
  upstreamReportedModel,
} from "../src/backend.js";
import type { ResolvedTarget } from "../src/config.js";
import { anthropicRequestToOpenAi } from "../src/openai-request.js";
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

  it("splits cached tokens OUT of prompt_tokens into cache_read_input_tokens", () => {
    // OpenAI's prompt_tokens INCLUDES the cached subset; Anthropic's input_tokens EXCLUDES it.
    // Passing 10 straight through would make every reader of the Anthropic shape double-count.
    const anth = openAiResponseToAnthropic({
      choices: [{ finish_reason: "stop", message: { role: "assistant", content: "ok" } }],
      usage: {
        prompt_tokens: 10,
        completion_tokens: 4,
        prompt_tokens_details: { cached_tokens: 7 },
      },
    }, "m") as any;
    expect(anth.usage).toEqual({ input_tokens: 3, output_tokens: 4, cache_read_input_tokens: 7 });
  });

  it("passes prompt_tokens through unchanged and drops the cache field when cached > prompt (malformed)", () => {
    // A negative input_tokens would be a figure nobody measured; the unmeasurable split is
    // dropped rather than guessed at.
    const anth = openAiResponseToAnthropic({
      choices: [{ finish_reason: "stop", message: { role: "assistant", content: "ok" } }],
      usage: {
        prompt_tokens: 10,
        completion_tokens: 4,
        prompt_tokens_details: { cached_tokens: 11 },
      },
    }, "m") as any;
    expect(anth.usage).toEqual({ input_tokens: 10, output_tokens: 4 });
  });

  it("treats a NEGATIVE cached_tokens as malformed too, not as a subtraction", () => {
    // Subtracting -5 would publish input_tokens ABOVE the prompt the host stated, alongside a
    // cache_read nobody measured — same malformed class as cached > prompt.
    const anth = openAiResponseToAnthropic({
      choices: [{ finish_reason: "stop", message: { role: "assistant", content: "ok" } }],
      usage: {
        prompt_tokens: 10,
        completion_tokens: 4,
        prompt_tokens_details: { cached_tokens: -5 },
      },
    }, "m") as any;
    expect(anth.usage).toEqual({ input_tokens: 10, output_tokens: 4 });
  });

  it("keeps no cache field when the upstream reported none", () => {
    const anth = openAiResponseToAnthropic({
      choices: [{ finish_reason: "stop", message: { role: "assistant", content: "ok" } }],
      usage: { prompt_tokens: 10, completion_tokens: 5 },
    }, "m") as any;
    expect(anth.usage).toEqual({ input_tokens: 10, output_tokens: 5 });
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

  it("sums cache traffic INTO prompt_tokens and reports cached_tokens for an OpenAI client", () => {
    // Anthropic's input_tokens EXCLUDES cache reads/writes; OpenAI's prompt_tokens INCLUDES
    // them. Mapping straight across would understate the prompt by exactly that amount.
    const out = anthropicMessageToOpenAi({
      ...message,
      usage: { input_tokens: 3, output_tokens: 5, cache_read_input_tokens: 7 },
    }, "chat") as any;
    expect(out.usage).toEqual({
      prompt_tokens: 10,
      completion_tokens: 5,
      total_tokens: 15,
      prompt_tokens_details: { cached_tokens: 7 },
    });
  });

  it("counts cache_creation_input_tokens into prompt_tokens too, without a cached_tokens claim", () => {
    // A cache WRITE is real billed prompt work but is not a cache READ, so it joins
    // prompt_tokens while `prompt_tokens_details` stays absent — emitting `{cached_tokens: 0}`
    // would state a measurement nobody made.
    const out = anthropicMessageToOpenAi({
      ...message,
      usage: { input_tokens: 3, output_tokens: 5, cache_creation_input_tokens: 7 },
    }, "chat") as any;
    expect(out.usage).toEqual({
      prompt_tokens: 10,
      completion_tokens: 5,
      total_tokens: 15,
    });
    expect(out.usage.prompt_tokens_details).toBeUndefined();
  });

  it("ignores a NEGATIVE cache_read_input_tokens instead of shrinking prompt_tokens", () => {
    // Folding -5 into the sum would publish a smaller prompt than input_tokens alone, plus a
    // `{cached_tokens: -5}` claim — both figures nobody measured. Treated as unreported.
    const out = anthropicMessageToOpenAi({
      ...message,
      usage: { input_tokens: 10, output_tokens: 5, cache_read_input_tokens: -5 },
    }, "chat") as any;
    expect(out.usage).toEqual({
      prompt_tokens: 10,
      completion_tokens: 5,
      total_tokens: 15,
    });
    expect(out.usage.prompt_tokens_details).toBeUndefined();
  });

  it("keeps prompt_tokens unsplit when the Anthropic backend reported no cache fields", () => {
    const out = anthropicMessageToOpenAi(message, "chat") as any;
    expect(out.usage).toEqual({
      prompt_tokens: 10,
      completion_tokens: 5,
      total_tokens: 15,
    });
    expect(out.usage.prompt_tokens_details).toBeUndefined();
  });

  it("leaves total_tokens absent when only one side of the usage is reported", () => {
    const out = anthropicMessageToOpenAi({
      ...message,
      usage: { input_tokens: 10 },
    }, "chat") as any;
    expect(out.usage).toEqual({ prompt_tokens: 10 });
    expect(out.usage.total_tokens).toBeUndefined();
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
 * The OUTBOUND request body for an openai-kind target — the half nothing asserted on before
 * 2026-08-23, which is how the tool-call IR leak shipped.
 *
 * llm-bridge's `universalToOpenAI` had no case for a tool_call/tool_result universal block and
 * fell through to `JSON.stringify(<universal block>)`, writing its own IR envelope
 * (`{"_original":{"provider":"anthropic","raw":…},"tool_call":…,"type":"tool_call"}`) into
 * `{type:"text"}` parts of the prompt. Models read the notation and echoed it back as their final
 * answer; tool results were triplicated and no `role:"tool"` message was ever produced. See
 * docs/tool-call-dialect-leak.md §"Second mechanism" and `src/openai-request.ts`.
 */
describe("fetchBackend (openai kind) — the outbound request is the caller's conversation", () => {
  const OK_JSON = JSON.stringify({
    id: "c", model: "m",
    choices: [{ index: 0, finish_reason: "stop", message: { role: "assistant", content: "ok" } }],
  });

  /** Exactly what the relay put on the wire for this Anthropic body. */
  async function outbound(reqJson: Record<string, unknown>, wantsStream = false): Promise<any> {
    let seen: any = null;
    const res = await fetchBackend(resolveAttempt(openaiTarget("https://request-shape.test")), {
      path: "/v1/messages", method: "POST",
      reqBuf: Buffer.from(JSON.stringify(reqJson)), reqJson,
      anthropicHeaders: {}, wantsStream, signal: AbortSignal.timeout(5000),
    }, async (_url, init) => {
      seen = JSON.parse(String(init?.body));
      return new Response(OK_JSON, { status: 200, headers: { "content-type": "application/json" } });
    });
    await res.text();
    return seen;
  }

  /** Every relay-authored IR envelope recoverable from the outbound text parts. */
  function leakedEnvelopes(body: any): any[] {
    const out: any[] = [];
    for (const m of body?.messages ?? []) {
      const parts = Array.isArray(m.content) ? m.content : typeof m.content === "string" ? [{ text: m.content }] : [];
      for (const p of parts) {
        if (typeof p?.text !== "string") continue;
        try {
          const parsed = JSON.parse(p.text);
          if (parsed && typeof parsed === "object" && "_original" in parsed) out.push(parsed);
        } catch { /* prose, which is the point */ }
      }
    }
    return out;
  }

  // A realistic Claude Code agentic transcript: parallel tool_use, then parallel tool_result.
  const AGENTIC = {
    model: "claude-x", max_tokens: 1024,
    messages: [
      { role: "user", content: "find and read it" },
      { role: "assistant", content: [
        { type: "text", text: "Searching now." },
        { type: "tool_use", id: "toolu_01A", name: "Grep", input: { pattern: "protocol" } },
        { type: "tool_use", id: "toolu_01B", name: "Read", input: { file_path: "src/backend.ts", limit: 120 } },
      ] },
      { role: "user", content: [
        { type: "tool_result", tool_use_id: "toolu_01A", content: "SECRET-GREP-OUTPUT" },
        { type: "tool_result", tool_use_id: "toolu_01B", content: "SECRET-FILE-BODY" },
      ] },
    ],
    tools: [{ name: "Grep", description: "g", input_schema: { type: "object", properties: { pattern: { type: "string" } } } }],
  };

  it("puts NO relay IR envelope into the prompt (the direct anti-regression)", async () => {
    const seen = await outbound(AGENTIC);
    expect(leakedEnvelopes(seen)).toEqual([]);
    expect(JSON.stringify(seen)).not.toContain("_original");
  });

  it("maps one assistant tool_use to one tool_call, with the text intact and no IR", async () => {
    const seen = await outbound({
      model: "claude-x", max_tokens: 16,
      messages: [
        { role: "user", content: "read it" },
        { role: "assistant", content: [
          { type: "text", text: "Reading." },
          { type: "tool_use", id: "toolu_1", name: "Read", input: { file_path: "a.ts" } },
        ] },
      ],
    });
    const asst = seen.messages.find((m: any) => m.role === "assistant");
    expect(asst.tool_calls).toHaveLength(1);
    expect(asst.tool_calls[0]).toEqual({
      id: "toolu_1", type: "function",
      function: { name: "Read", arguments: JSON.stringify({ file_path: "a.ts" }) },
    });
    expect(asst.content).toBe("Reading.");
    expect(leakedEnvelopes(seen)).toEqual([]);
  });

  it("maps two parallel tool_use blocks to two tool_calls, content null when no text remains", async () => {
    const seen = await outbound(AGENTIC);
    const asst = seen.messages.find((m: any) => m.role === "assistant");
    expect(asst.tool_calls.map((c: any) => c.id)).toEqual(["toolu_01A", "toolu_01B"]);
    expect(asst.content).toBe("Searching now.");

    const noText = await outbound({
      model: "claude-x", max_tokens: 16,
      messages: [
        { role: "user", content: "go" },
        { role: "assistant", content: [
          { type: "thinking", thinking: "private", signature: "s" },
          { type: "tool_use", id: "toolu_9", name: "Read", input: {} },
        ] },
      ],
    });
    const bare = noText.messages.find((m: any) => m.role === "assistant");
    expect(bare.content).toBeNull();
    expect(bare.tool_calls).toHaveLength(1);
    // Vendor-private reasoning is not representable and is never forwarded to another vendor.
    expect(JSON.stringify(noText)).not.toContain("private");
  });

  it("turns two tool_results into two role:\"tool\" messages, each body appearing ONCE", async () => {
    const seen = await outbound(AGENTIC);
    const tools = seen.messages.filter((m: any) => m.role === "tool");
    expect(tools).toEqual([
      { role: "tool", tool_call_id: "toolu_01A", content: "SECRET-GREP-OUTPUT" },
      { role: "tool", tool_call_id: "toolu_01B", content: "SECRET-FILE-BODY" },
    ]);
    // The old path triplicated each result (raw.content + metadata.content + result).
    const wire = JSON.stringify(seen);
    expect(wire.split("SECRET-FILE-BODY").length - 1).toBe(1);
    expect(wire.split("SECRET-GREP-OUTPUT").length - 1).toBe(1);
    // Every tool_call the assistant made is answered, and by the same id.
    const asst = seen.messages.find((m: any) => m.role === "assistant");
    expect(tools.map((m: any) => m.tool_call_id)).toEqual(asst.tool_calls.map((c: any) => c.id));
  });

  it("keeps a LONE tool_result clean — and now linked, which the old path lost", async () => {
    const seen = await outbound({
      model: "claude-x", max_tokens: 16,
      messages: [
        { role: "user", content: "go" },
        { role: "assistant", content: [{ type: "tool_use", id: "toolu_solo", name: "Read", input: {} }] },
        { role: "user", content: [{ type: "tool_result", tool_use_id: "toolu_solo", content: [{ type: "text", text: "r" }] }] },
      ],
    });
    // llm-bridge's one working case emitted `{role:"user", content:"r"}` — no IR, but the
    // tool_call_id linkage was gone, so the host could not tell which call this answered.
    expect(seen.messages.at(-1)).toEqual({ role: "tool", tool_call_id: "toolu_solo", content: "r" });
  });

  it("emits the tool messages FIRST when a user turn mixes results with text", async () => {
    const seen = await outbound({
      model: "claude-x", max_tokens: 16,
      messages: [
        { role: "assistant", content: [{ type: "tool_use", id: "toolu_m", name: "Read", input: {} }] },
        { role: "user", content: [
          { type: "text", text: "and also do this" },
          { type: "tool_result", tool_use_id: "toolu_m", content: "done" },
        ] },
      ],
    });
    expect(seen.messages.map((m: any) => m.role)).toEqual(["assistant", "tool", "user"]);
    expect(seen.messages.at(-1)).toEqual({ role: "user", content: "and also do this" });
  });

  it("maps system, images, tools, tool_choice and stop_sequences", async () => {
    const seen = await outbound({
      model: "claude-x", max_tokens: 256, temperature: 0.2, top_p: 0.9,
      stop_sequences: ["</done>", "STOP"],
      system: [
        { type: "text", text: "You are a relay.", cache_control: { type: "ephemeral" } },
        { type: "text", text: "Project rules." },
      ],
      messages: [{ role: "user", content: [
        { type: "text", text: "what is this?" },
        { type: "image", source: { type: "base64", media_type: "image/png", data: "AAAA" } },
      ] }],
      tools: [
        { name: "Read", description: "read a file", input_schema: { type: "object", properties: { path: { type: "string" } } } },
        { name: "bash", type: "bash_20250124" },
      ],
      tool_choice: { type: "tool", name: "Read" },
    });

    expect(seen.messages[0]).toEqual({ role: "system", content: "You are a relay.\n\nProject rules." });
    expect(seen.messages[1].content).toEqual([
      { type: "text", text: "what is this?" },
      { type: "image_url", image_url: { url: "data:image/png;base64,AAAA" } },
    ]);
    expect(seen.tools).toEqual([
      { type: "function", function: { name: "Read", description: "read a file", parameters: { type: "object", properties: { path: { type: "string" } } } } },
      // A built-in typed tool declares no schema; the empty OBJECT schema is what it means.
      { type: "function", function: { name: "bash", parameters: { type: "object", properties: {} } } },
    ]);
    expect(seen.tool_choice).toEqual({ type: "function", function: { name: "Read" } });
    expect(seen.stop).toEqual(["</done>", "STOP"]);
    expect(seen.max_tokens).toBe(256);
    expect(seen.temperature).toBe(0.2);
    expect(seen.top_p).toBe(0.9);
    // Set by the relay from the resolved deployment, not by the caller's body.
    expect(seen.model).toBe("meta/llama-3.1-70b-instruct");
  });

  it("maps Anthropic's tool_choice `any` to OpenAI's `required`, and drops it without tools", async () => {
    const any = await outbound({
      model: "claude-x", max_tokens: 16, messages: [{ role: "user", content: "hi" }],
      tools: [{ name: "Read", input_schema: { type: "object", properties: {} } }],
      tool_choice: { type: "any" },
    });
    expect(any.tool_choice).toBe("required");

    const none = await outbound({
      model: "claude-x", max_tokens: 16, messages: [{ role: "user", content: "hi" }],
      tool_choice: { type: "any" },
    });
    expect(none).not.toHaveProperty("tool_choice");
    expect(none).not.toHaveProperty("tools");
  });

  it("refuses an unrepresentable block with a clean 400 and no egress", async () => {
    let egressed = 0;
    const req = {
      model: "claude-x", max_tokens: 16,
      messages: [{ role: "user", content: [{ type: "server_tool_use", id: "srvtoolu_1", name: "web_search", input: {} }] }],
    };
    const res = await fetchBackend(resolveAttempt(openaiTarget("https://request-shape.test")), {
      path: "/v1/messages", method: "POST",
      reqBuf: Buffer.from(JSON.stringify(req)), reqJson: req,
      anthropicHeaders: {}, wantsStream: false, signal: AbortSignal.timeout(5000),
      onEgress: () => { egressed += 1; },
    }, async () => { throw new Error("must not reach the provider"); });

    expect(res.status).toBe(400);
    expect(errorOrigin(res)).toBe("local");
    expect(((await res.json()) as any).error.message).toContain("server_tool_use");
    expect(egressed).toBe(0);
  });

  /**
   * An image inside a `tool_result` — `Read` on an image file, a screenshot tool — is a shape
   * Claude Code produces routinely. Refusing it raised a LOCAL 400, which `server.ts` does not
   * fail over (`tryNext = false`), so one image killed the whole request on every openai-kind
   * lane. An OpenAI tool message is text only, so the image rides on the user message that
   * follows the turn's tool messages: lossless, ordering-legal, and a host with no vision
   * answers with its own UPSTREAM 400, which walks the pool.
   */
  it("carries a tool_result's image on the FOLLOWING user message, text on the tool message", async () => {
    const seen = await outbound({
      model: "claude-x", max_tokens: 16,
      messages: [
        { role: "assistant", content: [{ type: "tool_use", id: "toolu_img", name: "Read", input: { file_path: "a.png" } }] },
        { role: "user", content: [{
          type: "tool_result", tool_use_id: "toolu_img",
          content: [
            { type: "text", text: "Read 1 image" },
            { type: "image", source: { type: "base64", media_type: "image/png", data: "IMAGE-BYTES" } },
          ],
        }] },
      ],
    });

    // The provider WAS called: no local 400, no dead request. That is the whole fix.
    expect(seen).not.toBeNull();
    expect(seen.messages.map((m: any) => m.role)).toEqual(["assistant", "tool", "user"]);
    expect(seen.messages[1]).toEqual({ role: "tool", tool_call_id: "toolu_img", content: "Read 1 image" });
    expect(seen.messages[2]).toEqual({
      role: "user",
      content: [{ type: "image_url", image_url: { url: "data:image/png;base64,IMAGE-BYTES" } }],
    });
    // Once, and only as the image part — never stringified into a text part.
    expect(JSON.stringify(seen).split("IMAGE-BYTES").length - 1).toBe(1);
  });

  it("answers the call even when the tool_result is ONLY an image", async () => {
    const seen = await outbound({
      model: "claude-x", max_tokens: 16,
      messages: [
        { role: "assistant", content: [{ type: "tool_use", id: "toolu_shot", name: "Screenshot", input: {} }] },
        { role: "user", content: [{
          type: "tool_result", tool_use_id: "toolu_shot",
          content: [{ type: "image", source: { type: "base64", media_type: "image/png", data: "ONLY-IMAGE" } }],
        }] },
      ],
    });

    expect(seen).not.toBeNull();
    // The tool message still exists and still links — an unanswered `tool_call_id` is rejected
    // by strict hosts — and `content: ""` is what the Chat schema asks for (a required string).
    // A relay-authored placeholder would be words the caller never wrote.
    expect(seen.messages[1]).toEqual({ role: "tool", tool_call_id: "toolu_shot", content: "" });
    expect(seen.messages[2].content).toEqual([
      { type: "image_url", image_url: { url: "data:image/png;base64,ONLY-IMAGE" } },
    ]);
  });

  it("keeps a tool_result's images in place among the turn's other leftover blocks", async () => {
    const seen = await outbound({
      model: "claude-x", max_tokens: 16,
      messages: [
        { role: "assistant", content: [{ type: "tool_use", id: "toolu_mix", name: "Read", input: {} }] },
        { role: "user", content: [
          { type: "text", text: "before" },
          { type: "tool_result", tool_use_id: "toolu_mix", content: [
            { type: "image", source: { type: "base64", media_type: "image/png", data: "FROM-RESULT" } },
          ] },
          { type: "text", text: "after" },
        ] },
      ],
    });

    expect(seen.messages.at(-1).content).toEqual([
      { type: "text", text: "before" },
      { type: "image_url", image_url: { url: "data:image/png;base64,FROM-RESULT" } },
      { type: "text", text: "after" },
    ]);
  });

  /**
   * The documented DROPS. Each is a decision recorded in `src/openai-request.ts`, and without an
   * assertion a future edit reintroduces one with the suite green — reforwarding
   * `metadata.user_id` would newly send a caller identifier to third-party providers.
   */
  it("does not forward request-level metadata (the caller identifier llm-bridge never sent either)", async () => {
    const seen = await outbound({
      model: "claude-x", max_tokens: 16,
      metadata: { user_id: "USER-IDENTIFIER" },
      messages: [{ role: "user", content: "hi" }],
    });
    expect(seen).not.toHaveProperty("user");
    expect(seen).not.toHaveProperty("metadata");
    expect(JSON.stringify(seen)).not.toContain("USER-IDENTIFIER");
  });

  it("passes an is_error tool_result through as plain text, with no relay-authored prefix", async () => {
    const seen = await outbound({
      model: "claude-x", max_tokens: 16,
      messages: [
        { role: "assistant", content: [{ type: "tool_use", id: "toolu_e", name: "Bash", input: {} }] },
        { role: "user", content: [{
          type: "tool_result", tool_use_id: "toolu_e", is_error: true,
          content: [{ type: "text", text: "command not found" }],
        }] },
      ],
    });
    // OpenAI has no error flag on a tool message, and an `Error:` prefix would be words the
    // caller never wrote; the failing tool's own output already says it failed.
    expect(seen.messages[1]).toEqual({ role: "tool", tool_call_id: "toolu_e", content: "command not found" });
    expect(JSON.stringify(seen)).not.toContain("is_error");
  });

  it("drops thinking and redacted_thinking rather than refusing them", async () => {
    const seen = await outbound({
      model: "claude-x", max_tokens: 16,
      messages: [
        { role: "user", content: [
          { type: "thinking", thinking: "USER-TURN-REASONING", signature: "s" },
          { type: "text", text: "go" },
        ] },
        { role: "assistant", content: [
          { type: "thinking", thinking: "ASSISTANT-REASONING", signature: "s" },
          { type: "redacted_thinking", data: "REDACTED-BLOB" },
          { type: "text", text: "done" },
        ] },
      ],
    });
    // Dropped, NOT refused: the request still egresses and both turns survive. Vendor-private
    // reasoning is simply never forwarded to a different vendor.
    expect(seen).not.toBeNull();
    expect(seen.messages.map((m: any) => m.role)).toEqual(["user", "assistant"]);
    expect(seen.messages[0]).toEqual({ role: "user", content: "go" });
    expect(seen.messages[1]).toEqual({ role: "assistant", content: "done" });
    for (const secret of ["USER-TURN-REASONING", "ASSISTANT-REASONING", "REDACTED-BLOB"]) {
      expect(JSON.stringify(seen)).not.toContain(secret);
    }
  });

  it("sends the relay's resolved model id and never the caller's", async () => {
    const seen = await outbound({ model: "claude-opus-4-6", max_tokens: 16, messages: [{ role: "user", content: "hi" }] });
    expect(seen.model).toBe("meta/llama-3.1-70b-instruct");
    // There is no `?? body.model` fallback: with no deployment model the mapper emits NO model
    // key, exactly as the pre-2026-08-23 `openaiBody.model = target.model` assignment did.
    // Falling back would ask the host for an Anthropic model id nobody selected.
    expect(anthropicRequestToOpenAi({ model: "claude-opus-4-6", messages: [] })).not.toHaveProperty("model");
    expect(anthropicRequestToOpenAi({ model: "claude-opus-4-6", messages: [] }, { model: "m" }).model).toBe("m");
  });

  it("preserves turn order and count, and adds only the system message", async () => {
    const seen = await outbound(AGENTIC);
    // user, assistant(+2 calls), then the two tool answers — nothing merged, nothing dropped.
    expect(seen.messages.map((m: any) => m.role)).toEqual(["user", "assistant", "tool", "tool"]);
    expect(seen.messages[0]).toEqual({ role: "user", content: "find and read it" });
    expect(seen.stream).toBe(false);
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

/**
 * A weak host's REPEATED tool-call ids are the defect here, not a malformed one. Kimi-K3 on NIM
 * emits `<ToolName>:<index in this response>`, so `Read:0` recurs on every turn that reads again;
 * Claude Code's request-time conversation normalizer then DROPS the duplicate `tool_use`, empties
 * the turn to `[Tool use interrupted]`, and the headless session dies with nothing to run.
 */
describe("fetchBackend (openai kind) — tool_use ids are unique against the conversation", () => {
  const conversation = (assistantId: string) => ({
    model: "claude-x",
    stream: false,
    messages: [
      { role: "user", content: "read package.json" },
      { role: "assistant", content: [{ type: "tool_use", id: assistantId, name: "Read", input: { file: "package.json" } }] },
      { role: "user", content: [{ type: "tool_result", tool_use_id: assistantId, content: "{...}" }] },
      { role: "user", content: "now read README.md" },
    ],
    tools: [{ name: "Read", description: "r", input_schema: { type: "object", properties: { file: { type: "string" } } } }],
  });

  const openAiToolResponse = (id: string) => JSON.stringify({
    id: "cmpl_2",
    model: "moonshotai/kimi-k3",
    choices: [{
      finish_reason: "tool_calls",
      message: { role: "assistant", content: null, tool_calls: [{ id, function: { name: "Read", arguments: '{"file":"README.md"}' } }] },
    }],
  });

  it("mints a fresh id for a buffered tool call whose id the conversation already carries", async () => {
    process.env.RP_BACKEND_KEY = "sk-nim";
    try {
      const req = conversation("Read:0");
      const res = await fetchBackend(resolveAttempt(openaiTarget("https://kimi.test", "moonshotai/kimi-k3")), {
        path: "/v1/messages",
        method: "POST",
        reqBuf: Buffer.from(JSON.stringify(req)),
        reqJson: req,
        anthropicHeaders: {},
        wantsStream: false,
        signal: AbortSignal.timeout(1000),
      }, async () => new Response(openAiToolResponse("Read:0"), { headers: { "content-type": "application/json" } }));

      const body = (await res.json()) as any;
      expect(body.stop_reason).toBe("tool_use");
      expect(body.content[0]).toEqual({
        type: "tool_use", id: "Read:0_relay1", name: "Read", input: { file: "README.md" },
      });
      // Announced, like every other automatic fix on this path. A count, never an id.
      expect(res.headers.get("x-llm-relay-tool-use-ids")).toBe("1 rewritten");
      expect(toolUseIdRewrites(res)).toBe(1);
    } finally {
      delete process.env.RP_BACKEND_KEY;
    }
  });

  it("leaves an already-unique id alone and emits no header", async () => {
    process.env.RP_BACKEND_KEY = "sk-nim";
    try {
      const req = conversation("Read:0");
      const res = await fetchBackend(resolveAttempt(openaiTarget("https://kimi.test", "moonshotai/kimi-k3")), {
        path: "/v1/messages",
        method: "POST",
        reqBuf: Buffer.from(JSON.stringify(req)),
        reqJson: req,
        anthropicHeaders: {},
        wantsStream: false,
        signal: AbortSignal.timeout(1000),
      }, async () => new Response(openAiToolResponse("Read:1"), { headers: { "content-type": "application/json" } }));

      const body = (await res.json()) as any;
      expect(body.content[0].id).toBe("Read:1");
      expect(res.headers.get("x-llm-relay-tool-use-ids")).toBeNull();
      expect(toolUseIdRewrites(res)).toBeUndefined();
    } finally {
      delete process.env.RP_BACKEND_KEY;
    }
  });

  it("rewrites the streamed content_block_start id and leaves every other event byte-identical", async () => {
    process.env.RP_BACKEND_KEY = "sk-nim";
    try {
      const chunk = (delta: object, finish: string | null = null) =>
        `data: ${JSON.stringify({ id: "cmpl", model: "moonshotai/kimi-k3", choices: [{ index: 0, delta, finish_reason: finish }] })}\n\n`;
      const openAiSse = [
        chunk({ role: "assistant" }),
        chunk({ tool_calls: [{ index: 0, id: "Read:0", function: { name: "Read", arguments: "" } }] }),
        chunk({ tool_calls: [{ index: 0, function: { arguments: '{"file":"README.md"}' } }] }),
        chunk({}, "tool_calls"),
        "data: [DONE]\n\n",
      ].join("");

      const run = async (req: object) => {
        const res = await fetchBackend(resolveAttempt(openaiTarget("https://kimi.test", "moonshotai/kimi-k3")), {
          path: "/v1/messages",
          method: "POST",
          reqBuf: Buffer.from(JSON.stringify(req)),
          reqJson: req,
          anthropicHeaders: {},
          wantsStream: true,
          signal: AbortSignal.timeout(1000),
        }, async () => new Response(openAiSse, { status: 200, headers: { "content-type": "text/event-stream" } }));
        const text = await res.text();
        return { text, rewrites: toolUseIdRewrites(res) };
      };

      // Same response, two conversations: one that already used `Read:0` and one that has not.
      const collides = await run({ ...conversation("Read:0"), stream: true });
      const clean = await run({ ...conversation("Read:9"), stream: true });

      expect(clean.text).toContain('"id":"Read:0"');
      expect(clean.rewrites).toBeUndefined();
      expect(collides.text).toContain('"id":"Read:0_relay1"');
      expect(collides.text).not.toContain('"id":"Read:0"');
      expect(collides.rewrites).toBe(1);
      // Nothing but the one id differs — the SSE is otherwise the same stream.
      expect(collides.text.replace('"id":"Read:0_relay1"', '"id":"Read:0"')).toBe(clean.text);
    } finally {
      delete process.env.RP_BACKEND_KEY;
    }
  });

  it("keeps a dialect-recovered tu_recovered_* id unless the conversation already holds it", async () => {
    process.env.RP_BACKEND_KEY = "sk-nim";
    try {
      const envelope = '<tool_call>{"name":"Read","arguments":{"file":"README.md"}}</tool_call>';
      const asText = JSON.stringify({
        id: "cmpl_3", model: "m",
        choices: [{ finish_reason: "stop", message: { role: "assistant", content: envelope } }],
      });
      const call = async (req: object) => {
        const res = await fetchBackend(resolveAttempt(openaiTarget("https://kimi.test", "moonshotai/kimi-k3")), {
          path: "/v1/messages",
          method: "POST",
          reqBuf: Buffer.from(JSON.stringify(req)),
          reqJson: req,
          anthropicHeaders: {},
          wantsStream: false,
          signal: AbortSignal.timeout(1000),
        }, async () => new Response(asText, { headers: { "content-type": "application/json" } }));
        return { id: ((await res.json()) as any).content[0].id, dialect: res.headers.get("x-llm-relay-tool-dialect") };
      };

      const untouched = await call(conversation("Read:0"));
      expect(untouched.id).toBe("tu_recovered_0");
      expect(untouched.dialect).toBe("recovered");

      const colliding = await call(conversation("tu_recovered_0"));
      expect(colliding.id).toBe("tu_recovered_0_relay1");
      // Still announced as recovered: the marker survives the mint.
      expect(colliding.dialect).toBe("recovered");
    } finally {
      delete process.env.RP_BACKEND_KEY;
    }
  });

  it("leaves a native Anthropic passthrough byte-identical, header included", async () => {
    const anthropic: ResolvedTarget = {
      provider: "anthropic",
      base: "https://anthropic-backend.test",
      kind: "anthropic",
      model: "routed-model",
      authHeader: "x-api-key",
      timeoutMs: 1000,
    };
    const req = conversation("Read:0");
    const raw = JSON.stringify({
      id: "msg_1", type: "message", role: "assistant", model: "routed-model",
      content: [{ type: "tool_use", id: "Read:0", name: "Read", input: { file: "README.md" } }],
      stop_reason: "tool_use", stop_sequence: null,
    });
    const res = await fetchBackend(resolveAttempt(anthropic), {
      path: "/v1/messages",
      method: "POST",
      reqBuf: Buffer.from(JSON.stringify(req)),
      reqJson: req,
      anthropicHeaders: {},
      wantsStream: false,
      signal: AbortSignal.timeout(1000),
    }, async () => new Response(raw, { headers: { "content-type": "application/json" } }));

    // The pass is confined to the TRANSLATED seam: a vendor response is forwarded untouched.
    expect(await res.text()).toBe(raw);
    expect(res.headers.get("x-llm-relay-tool-use-ids")).toBeNull();
    expect(toolUseIdRewrites(res)).toBeUndefined();
  });

  /**
   * The OpenAI front takes its byte-exact direct branch ONLY for openai-kind + Chat. Every other
   * combination — a Codex `/v1/responses` turn on an openai-kind target, i.e. the operator's
   * codex→kimi offload lane — is translated through `fetchBackend`, so it inherits the mint. That
   * is desirable, but it must be announced there too: the front rebuilds the response, and a
   * rewrite nobody is told about is the thing the announcement rule forbids.
   */
  it("mints and announces on the front's translated lane (Responses → openai-kind)", async () => {
    process.env.RP_BACKEND_KEY = "sk-nim";
    try {
      const res = await fetchOpenAiFront(
        resolveAttempt(openaiTarget("https://kimi.test", "moonshotai/kimi-k3")),
        {
          // `function_call_output.call_id` survives the Responses→Anthropic translation as a
          // `tool_result.tool_use_id`, so the conversation's ids are visible to the taken-set.
          reqJson: {
            model: "m",
            input: [
              { role: "user", content: [{ type: "input_text", text: "read package.json" }] },
              { type: "function_call", call_id: "Read:0", name: "Read", arguments: '{"file":"package.json"}' },
              { type: "function_call_output", call_id: "Read:0", output: "{...}" },
              { role: "user", content: [{ type: "input_text", text: "now read README.md" }] },
            ],
            tools: [{ type: "function", name: "Read", parameters: { type: "object", properties: { file: { type: "string" } } } }],
          },
          wantsStream: false,
          protocol: "responses",
          signal: AbortSignal.timeout(1000),
        },
        async () => new Response(openAiToolResponse("Read:0"), { status: 200, headers: { "content-type": "application/json" } }),
      );

      expect(res.status).toBe(200);
      const body = (await res.json()) as any;
      expect(JSON.stringify(body)).toContain("Read:0_relay1");
      expect(JSON.stringify(body)).not.toContain('"Read:0"');
      // Announced on the rebuilt front response, and countable by the server for its log record.
      expect(res.headers.get("x-llm-relay-tool-use-ids")).toBe("1 rewritten");
      expect(toolUseIdRewrites(res)).toBe(1);
    } finally {
      delete process.env.RP_BACKEND_KEY;
    }
  });

  it("round-trips: the echoed id needs no reverse mapping to reach the backend", () => {
    // The client sends the minted id back in BOTH the assistant tool_use and the user
    // tool_result, and the request mapper forwards both verbatim — so the backend sees a
    // consistent pair and the relay remembers nothing between requests. By construction.
    const followUp = {
      model: "claude-x",
      messages: [
        { role: "user", content: "read README.md" },
        { role: "assistant", content: [{ type: "tool_use", id: "Read:0_relay1", name: "Read", input: { file: "README.md" } }] },
        { role: "user", content: [{ type: "tool_result", tool_use_id: "Read:0_relay1", content: "# readme" }] },
      ],
    };
    const mapped = anthropicRequestToOpenAi(followUp, { model: "moonshotai/kimi-k3" }) as any;
    expect(mapped.messages[1].tool_calls[0].id).toBe("Read:0_relay1");
    expect(mapped.messages[2]).toMatchObject({ role: "tool", tool_call_id: "Read:0_relay1" });
  });
});
