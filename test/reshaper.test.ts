import { describe, it, expect, afterEach } from "vitest";
import { createServer, type Server } from "node:http";
import { AddressInfo } from "node:net";
import { FailoverReshaper, HttpReshaper, ReshaperTransportError, parseCorrectedInputs, reconstruct, type ReshapeRequest } from "../src/reshaper.js";
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

function startServer(handler: (path: string, body: string) => { status?: number; body: string }): Promise<string> {
  return new Promise((resolve) => {
    server = createServer((rq, res) => {
      const chunks: Buffer[] = [];
      rq.on("data", (c) => chunks.push(c));
      rq.on("end", () => {
        const out = handler(rq.url ?? "/", Buffer.concat(chunks).toString("utf8"));
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

  it("THROWS a transport error on a non-2xx response (a 500 is not a judgement, so failover may advance)", async () => {
    const base = await startServer(() => ({ status: 500, body: "boom" }));
    const r = new HttpReshaper({ base, model: "m", kind: "openai", authHeader: "authorization", timeoutMs: 5000 });
    await expect(r.reshape(req)).rejects.toThrow(ReshaperTransportError);
  });

  it("throws a transport error when the endpoint is unreachable", async () => {
    // Port 1 is reserved and never has a listener on loopback.
    const r = new HttpReshaper({ base: "http://127.0.0.1:1", model: "m", kind: "openai", authHeader: "authorization", timeoutMs: 5000 });
    await expect(r.reshape(req)).rejects.toThrow(ReshaperTransportError);
  });

  it("egresses only the schemas of tools a FAILING call names, not the whole tool set", async () => {
    // A reshape ships tool schemas + call arguments to (usually) a different provider
    // than the one that served the response. It cannot be avoided — the model has to
    // see what it is correcting — so it is minimised: a Claude Code session declares
    // dozens of tools and the reshaper needs exactly the one it is fixing.
    let seen = "";
    const base = await startServer((_path, body) => {
      seen = body;
      return { body: JSON.stringify({ choices: [{ message: { content: CORRECTED } }] }) };
    });
    const many = toolSchemaMap({
      tools: [
        { name: "get_weather", input_schema: { type: "object", properties: { city: { type: "string" } } } },
        { name: "read_secrets", input_schema: { type: "object", properties: { vault_path: { type: "string" } } } },
        { name: "send_email", input_schema: { type: "object", properties: { to: { type: "string" } } } },
      ],
    });
    const r = new HttpReshaper({ base, model: "m", kind: "openai", authHeader: "authorization", timeoutMs: 5000 });
    await r.reshape({ ...req, tools: many });
    expect(seen).toContain("get_weather");
    expect(seen).not.toContain("read_secrets");
    expect(seen).not.toContain("vault_path");
    expect(seen).not.toContain("send_email");
  });
});

describe("reconstruct", () => {
  const raw: AssistantMessage = {
    content: [
      { type: "text", text: "Let me check." },
      { type: "tool_use", id: "t1", name: "get_weather", input: {} },
    ],
    stop_reason: "end_turn",
  };

  it("replaces ONLY the input, never the id, name, order or sibling blocks", () => {
    const out = reconstruct(raw, { t1: { city: "Paris" } });
    expect(out.content).toHaveLength(2);
    expect(out.content[0]).toEqual({ type: "text", text: "Let me check." });
    expect(out.content[1]).toMatchObject({ type: "tool_use", id: "t1", name: "get_weather", input: { city: "Paris" } });
  });

  it("ignores corrections keyed to an id the message does not contain", () => {
    const out = reconstruct(raw, { nope: { city: "Paris" } });
    expect(out.content[1]).toMatchObject({ id: "t1", input: {} });
  });

  it("normalises stop_reason to tool_use when the content bears a tool_use block", () => {
    // Pure form the content determines: the harness will not execute a tool
    // announced under "end_turn", and keeping the backend's wrong value made a
    // fully-repaired message fail re-validation and burn every remaining attempt.
    expect(reconstruct(raw, { t1: { city: "Paris" } }).stop_reason).toBe("tool_use");
  });

  it("leaves stop_reason alone when there is no tool_use block to justify it", () => {
    const textOnly: AssistantMessage = { content: [{ type: "text", text: "hi" }], stop_reason: "end_turn" };
    expect(reconstruct(textOnly, {}).stop_reason).toBe("end_turn");
  });
});

describe("FailoverReshaper", () => {
  const req = {
    tools: new Map(),
    rawAssistant: { role: "assistant" as const, content: [], stop_reason: "tool_use" },
    errors: [],
    backendModel: "m",
  };
  const ok = { kind: "message" as const, message: { role: "assistant" as const, content: [], stop_reason: "tool_use" } };

  it("advances past a transport failure to the next candidate", async () => {
    const dead = { reshape: async () => { throw new Error("model de-listed"); } };
    const live = { reshape: async () => ok };
    const r = new FailoverReshaper([dead, live]);
    expect((await r.reshape(req)).kind).toBe("message");
  });

  it("returns a refusal WITHOUT trying other candidates (no shopping for a compliant answer)", async () => {
    let secondCalled = false;
    const refuser = { reshape: async () => ({ kind: "refuse" as const, reason: "would have to guess" }) };
    const other = { reshape: async () => { secondCalled = true; return ok; } };
    const res = await new FailoverReshaper([refuser, other]).reshape(req);
    expect(res.kind).toBe("refuse");
    expect(secondCalled).toBe(false);
  });

  it("THROWS a transport error when every candidate fails at the transport level", async () => {
    // Rewritten: this test used to assert `kind === "refuse"` here, which PINNED the
    // defect. Nobody answered, so there is no judgement to report — labelling a total
    // outage as a model's decision is the exact confusion this class exists to prevent,
    // and it made `repair()` report `refused` (a model declined to guess) for a turn in
    // which no model was ever reached. Throwing is what `repair()` fails clean on.
    const dead = { reshape: async () => { throw new Error("down"); } };
    const r = new FailoverReshaper([dead, dead]);
    await expect(r.reshape(req)).rejects.toThrow(ReshaperTransportError);
    await expect(r.reshape(req)).rejects.toThrow(/all reshaper candidates/);
  });

  it("rejects an empty delegate list", () => {
    expect(() => new FailoverReshaper([])).toThrow(/at least one delegate/);
  });

  it("end-to-end: fails over past an HTTP-dead HttpReshaper to a live one", async () => {
    // The regression this pins: HttpReshaper used to RETURN a refusal on transport/HTTP
    // failure, so FailoverReshaper (which advances only on throws) never failed over.
    const deadBase = await startTempServer(() => ({ status: 503, body: "down" }));
    const liveBase = await startTempServer(() => ({ body: JSON.stringify({ choices: [{ message: { content: CORRECTED } }] }) }));
    try {
      const r = new FailoverReshaper([
        new HttpReshaper({ base: deadBase.base, model: "m", kind: "openai", authHeader: "authorization", timeoutMs: 5000 }),
        new HttpReshaper({ base: liveBase.base, model: "m", kind: "openai", authHeader: "authorization", timeoutMs: 5000 }),
      ]);
      const out = await r.reshape(req);
      expect(out.kind).toBe("message");
    } finally {
      deadBase.server.close();
      liveBase.server.close();
    }
  });
});

/** Like startServer but self-contained (no shared module state), for multi-server tests. */
function startTempServer(handler: () => { status?: number; body: string }): Promise<{ base: string; server: Server }> {
  return new Promise((resolve) => {
    const s = createServer((rq, res) => {
      rq.on("data", () => {});
      rq.on("end", () => {
        const out = handler();
        res.writeHead(out.status ?? 200, { "content-type": "application/json" });
        res.end(out.body);
      });
    });
    s.listen(0, "127.0.0.1", () => resolve({ base: `http://127.0.0.1:${(s.address() as AddressInfo).port}`, server: s }));
  });
}
