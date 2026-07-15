import { describe, it, expect, afterEach } from "vitest";
import { createServer, type Server } from "node:http";
import { AddressInfo } from "node:net";
import { fetchBackend, openAiResponseToAnthropic } from "../src/backend.js";
import type { Config } from "../src/config.js";

function openaiKindCfg(base: string, model = "meta/llama-3.1-70b-instruct"): Config {
  return {
    host: "127.0.0.1", port: 0,
    backend: { base, kind: "openai", model, authHeader: "authorization", timeoutMs: 5000, authEnv: "RP_BACKEND_KEY" },
    mode: "detect",
    repair: { maxAttempts: 2, destructiveTools: [] },
    log: { level: "silent", file: null },
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
    const cfg = openaiKindCfg(`http://127.0.0.1:${(backend.address() as AddressInfo).port}`);
    const anthropicReq = { model: "claude-x", stream: false, messages: [{ role: "user", content: "weather in Rome?" }], tools: [{ name: "get_weather", description: "w", input_schema: { type: "object", properties: { city: { type: "string" } }, required: ["city"] } }] };

    const res = await fetchBackend(cfg, {
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
});
