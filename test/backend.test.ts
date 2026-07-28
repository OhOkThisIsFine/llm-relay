import { describe, it, expect, afterEach } from "vitest";
import { createServer, type Server } from "node:http";
import { AddressInfo } from "node:net";
import { fetchBackend, openAiResponseToAnthropic } from "../src/backend.js";
import type { ResolvedTarget } from "../src/config.js";

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
});

describe("fetchBackend (openai kind) — request translation + response mapping", () => {
  let backend: Server;
  afterEach(() => backend?.close());

  it("translates an Anthropic request to OpenAI /chat/completions and maps the response back", async () => {
    process.env.RP_BACKEND_KEY = "sk-nim";
    let seen: any = null;
    let seenAuth: string | undefined;
    backend = await new Promise<Server>((resolve) => {
      const s = createServer((req, res) => {
        seenAuth = req.headers["authorization"] as string | undefined;
        const chunks: Buffer[] = [];
        req.on("data", (c) => chunks.push(c));
        req.on("end", () => {
          seen = JSON.parse(Buffer.concat(chunks).toString());
          res.writeHead(200, { "content-type": "application/json" });
          res.end(JSON.stringify({ id: "cmpl", choices: [{ finish_reason: "tool_calls", message: { tool_calls: [{ id: "c1", function: { name: "get_weather", arguments: '{"city":"Rome"}' } }] } }] }));
        });
      });
      s.listen(0, "127.0.0.1", () => resolve(s));
    });
    const target = openaiTarget(`http://127.0.0.1:${(backend.address() as AddressInfo).port}`);
    const anthropicReq = { model: "claude-x", stream: false, messages: [{ role: "user", content: "weather in Rome?" }], tools: [{ name: "get_weather", description: "w", input_schema: { type: "object", properties: { city: { type: "string" } }, required: ["city"] } }] };

    const res = await fetchBackend(target, {
      path: "/v1/messages", method: "POST",
      reqBuf: Buffer.from(JSON.stringify(anthropicReq)), reqJson: anthropicReq,
      anthropicHeaders: {}, wantsStream: false, signal: AbortSignal.timeout(5000),
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
    delete process.env.RP_BACKEND_KEY;
  });

  it("refuses a document block it cannot convert instead of leaking base64 into the prompt", async () => {
    let hit = false;
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

    const res = await fetchBackend(target, {
      path: "/v1/messages", method: "POST",
      reqBuf: Buffer.from(JSON.stringify(anthropicReq)), reqJson: anthropicReq,
      anthropicHeaders: {}, wantsStream: false, signal: AbortSignal.timeout(5000),
    });

    expect(res.status).toBe(400);
    expect(hit).toBe(false); // never reached the provider
    const body = (await res.json()) as any;
    expect(body.error.message).toMatch(/url. source are not supported/);
    expect(JSON.stringify(body)).not.toContain(b64);
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

    const res = await fetchBackend(target, {
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

    const res = await fetchBackend(target, {
      path: "/v1/messages", method: "POST",
      reqBuf: Buffer.from(JSON.stringify(req)), reqJson: req,
      anthropicHeaders: {}, wantsStream: true, signal: AbortSignal.timeout(5000),
    });

    expect(res.status).toBe(200);
    expect(bodies.length).toBe(2);
    expect(bodies[0].stream_options).toEqual({ include_usage: true });
    expect(bodies[1].stream_options).toBeUndefined();
    expect(await res.text()).toContain("content_block_delta");
  });
});
