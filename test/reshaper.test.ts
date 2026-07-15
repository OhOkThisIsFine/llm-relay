import { describe, it, expect, afterEach } from "vitest";
import { createServer, type Server } from "node:http";
import { AddressInfo } from "node:net";
import { HttpReshaper, parseCorrectedInputs, type ReshapeRequest } from "../src/reshaper.js";
import { toolSchemaMap, type AssistantMessage } from "../src/anthropic.js";

const tools = toolSchemaMap({
  tools: [{ name: "get_weather", input_schema: { type: "object", properties: { city: { type: "string" } }, required: ["city"] } }],
});
const req: ReshapeRequest = {
  tools,
  rawAssistant: { content: [{ type: "tool_use", id: "t1", name: "get_weather", input: {} }], stop_reason: "tool_use" } as AssistantMessage,
  errors: [{ kind: "schema_violation", blockIndex: 0, tool: "get_weather", message: "missing city" }],
  backendModel: null,
};
// New reshaper contract: model returns corrected inputs keyed by tool_use id;
// the proxy reconstructs the message from req.rawAssistant.
const CORRECTED = JSON.stringify({ inputs: { t1: { city: "Paris" } } });

let server: Server;
afterEach(() => server?.close());

function startServer(handler: (path: string) => { status?: number; body: string }): Promise<string> {
  return new Promise((resolve) => {
    server = createServer((rq, res) => {
      const chunks: Buffer[] = [];
      rq.on("data", (c) => chunks.push(c));
      rq.on("end", () => {
        const out = handler(rq.url ?? "/");
        res.writeHead(out.status ?? 200, { "content-type": "application/json" });
        res.end(out.body);
      });
    });
    server.listen(0, "127.0.0.1", () => resolve(`http://127.0.0.1:${(server.address() as AddressInfo).port}`));
  });
}

describe("HttpReshaper", () => {
  it("openai kind: calls /chat/completions and parses the corrected message", async () => {
    let hitPath = "";
    const base = await startServer((path) => {
      hitPath = path;
      return { body: JSON.stringify({ choices: [{ message: { content: CORRECTED } }] }) };
    });
    process.env.RP_RESHAPER_KEY = "sk-nim";
    const r = new HttpReshaper({ base, model: "meta/llama-3.1-70b-instruct", kind: "openai", authEnv: "RP_RESHAPER_KEY", authHeader: "authorization", timeoutMs: 5000 });
    const out = await r.reshape(req);
    expect(hitPath).toBe("/chat/completions");
    expect(out.kind).toBe("message");
    if (out.kind === "message") expect(out.message.content[0]).toMatchObject({ type: "tool_use", input: { city: "Paris" } });
    delete process.env.RP_RESHAPER_KEY;
  });

  it("anthropic kind: calls /v1/messages and parses the corrected message", async () => {
    let hitPath = "";
    const base = await startServer((path) => {
      hitPath = path;
      return { body: JSON.stringify({ content: [{ type: "text", text: CORRECTED }] }) };
    });
    const r = new HttpReshaper({ base, model: "claude-haiku-4-5-20251001", kind: "anthropic", authHeader: "x-api-key", timeoutMs: 5000 });
    const out = await r.reshape(req);
    expect(hitPath).toBe("/v1/messages");
    expect(out.kind).toBe("message");
  });

  it("parses fenced/prose-wrapped JSON from a real-model-style response", () => {
    const modelOut = 'The JSON is almost valid. Here is the repaired call:\n\n```json\n' + CORRECTED + "\n```";
    const out = parseCorrectedInputs(modelOut);
    expect(out.kind).toBe("inputs");
    if (out.kind === "inputs") expect(out.inputs.t1).toEqual({ city: "Paris" });
  });

  it("refuses on a non-2xx reshaper response", async () => {
    const base = await startServer(() => ({ status: 500, body: "boom" }));
    const r = new HttpReshaper({ base, model: "m", kind: "openai", authHeader: "authorization", timeoutMs: 5000 });
    const out = await r.reshape(req);
    expect(out.kind).toBe("refuse");
  });
});
