import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import {
  fetchOpenAiFront,
  POOL_ATTEMPTS_HEADER,
  SERVED_BY_HEADER,
  TOOL_DIALECT_HEADER,
} from "../src/backend.js";
import { createProxy } from "../src/server.js";
import { globalCircuitBreaker } from "../src/circuit-breaker.js";
import { ModelCatalog } from "../src/catalog.js";
import { resetFacts } from "../src/target-facts.js";
import { resetInterpretations } from "../src/refusal-interpretation.js";
import type { Config, ResolvedTarget } from "../src/config.js";
import { resolveAttempt } from "../src/resolved-attempt.js";

/**
 * The destructive-tool filter these fixtures pass at the dialect-rescue commit points. Refusing
 * nothing is the right default HERE: these tests cover translation and recovery, and the refusal
 * itself has its own suite (test/dialect-destructive-refusal.test.ts). It is a REQUIRED parameter
 * on `recoverToolCalls` / `fetchBackend` / `fetchOpenAiFront` so a new rescue seam cannot omit the
 * policy silently — which is exactly why it has to be spelled out here rather than defaulted.
 */
const NO_DESTRUCTIVE = (): boolean => false;

const servers: Server[] = [];

function listen(server: Server): Promise<Server> {
  return new Promise((resolve) => server.listen(0, "127.0.0.1", () => {
    servers.push(server);
    resolve(server);
  }));
}

function port(server: Server): number {
  return (server.address() as AddressInfo).port;
}

function target(base = "https://openai-backend.test"): ResolvedTarget {
  return {
    provider: "openai-test",
    base,
    kind: "openai",
    model: "served-model",
    authHeader: "authorization",
    timeoutMs: 2_000,
  };
}

function tools(): Record<string, unknown>[] {
  return [{
    type: "function",
    function: {
      name: "write_note",
      parameters: {
        type: "object",
        properties: { path: { type: "string" }, count: { type: "number" } },
        required: ["path"],
      },
    },
  }];
}

function request(stream: boolean, withTools = true): Record<string, unknown> {
  return {
    model: "pool/direct",
    stream,
    messages: [{ role: "user", content: "write it" }],
    ...(withTools ? { tools: tools() } : {}),
  };
}

function chatChunk(delta: Record<string, unknown>, finishReason: string | null = null): string {
  return `data: ${JSON.stringify({
    id: "chatcmpl_1",
    object: "chat.completion.chunk",
    model: "served-model",
    choices: [{ index: 0, delta, finish_reason: finishReason }],
  })}\n\n`;
}

const ROLE = chatChunk({ role: "assistant" });
const STOP = chatChunk({}, "stop") + "data: [DONE]\n\n";

beforeEach(() => {
  globalCircuitBreaker.reset();
  resetFacts();
  resetInterpretations();
});

afterEach(async () => {
  const closing = servers.splice(0);
  for (const server of closing) server.closeAllConnections();
  await Promise.all(closing.map((server) => new Promise<void>((resolve) => server.close(() => resolve()))));
  globalCircuitBreaker.reset();
  resetFacts();
  resetInterpretations();
});

describe("OpenAI direct passthrough dialect recovery", () => {
  it("recovers a buffered envelope into native Chat tool_calls", async () => {
    const dialect =
      '<｜DSML｜tool_calls><｜DSML｜invoke name="write_note">' +
      '<｜DSML｜parameter name="path">a.txt</｜DSML｜parameter>' +
      '<｜DSML｜parameter name="count">42</｜DSML｜parameter>' +
      '</｜DSML｜invoke></｜DSML｜tool_calls>';
    const upstream = JSON.stringify({
      id: "chatcmpl_1",
      object: "chat.completion",
      model: "served-model",
      choices: [{ index: 0, message: { role: "assistant", content: dialect }, finish_reason: "stop" }],
    });

    const response = await fetchOpenAiFront(resolveAttempt(target()), { isDestructive: NO_DESTRUCTIVE,
      reqJson: request(false),
      wantsStream: false,
      protocol: "chat",
      signal: AbortSignal.timeout(1_000),
    }, async () => new Response(upstream, {
      status: 200,
      headers: { "content-type": "application/json" },
    }));

    const body = await response.json() as any;
    expect(response.headers.get(TOOL_DIALECT_HEADER)).toBe("recovered");
    expect(body.choices[0].finish_reason).toBe("tool_calls");
    expect(body.choices[0].message.content).toBeNull();
    expect(body.choices[0].message.tool_calls[0]).toMatchObject({
      type: "function",
      function: { name: "write_note" },
    });
    expect(JSON.parse(body.choices[0].message.tool_calls[0].function.arguments)).toEqual({
      path: "a.txt",
      count: 42,
    });
  });

  it("recovers a marker split across streaming deltas and reports it", async () => {
    const upstream = [
      ROLE,
      chatChunk({ content: '<｜DSML｜tool_calls><｜DSML｜invoke name="write_' }),
      chatChunk({ content: 'note"><｜DSML｜parameter name="path">a.txt</｜DSML｜parameter>' }),
      chatChunk({ content: '</｜DSML｜invoke></｜DSML｜tool_calls>' }),
      STOP,
    ].join("");

    const response = await fetchOpenAiFront(resolveAttempt(target()), { isDestructive: NO_DESTRUCTIVE,
      reqJson: request(true),
      wantsStream: true,
      protocol: "chat",
      signal: AbortSignal.timeout(1_000),
    }, async () => new Response(upstream, {
      status: 200,
      headers: { "content-type": "text/event-stream" },
    }));
    const body = await response.text();

    expect(response.headers.get(TOOL_DIALECT_HEADER)).toBe("recovered");
    expect(body).toContain('"tool_calls"');
    expect(body).toContain('"name":"write_note"');
    expect(body).toContain('"finish_reason":"tool_calls"');
    expect(body).not.toContain("DSML");
    expect(body.match(/data: \[DONE\]/g)).toHaveLength(1);
  });

  // ⚠ This test used to be named "validates a recovered destructive call without refusing or
  // reshaping it" and asserted HTTP 200 — a test written to pin the defect it should have caught.
  // Flipped in the same commit as the source fix, per CLAUDE.md's standing rule.
  it("refuses a recovered destructive call instead of committing or reshaping it", async () => {
    let reshaperCalls = 0;
    const backend = await listen(createServer((req, res) => {
      req.resume();
      req.on("end", () => {
        res.writeHead(200, { "content-type": "text/event-stream" });
        res.end(
          ROLE +
          chatChunk({ content:
            '<｜DSML｜tool_calls><｜DSML｜invoke name="write_note">' +
            '<｜DSML｜parameter name="path">a.txt</｜DSML｜parameter>' +
            '</｜DSML｜invoke></｜DSML｜tool_calls>',
          }) +
          STOP,
        );
      });
    }));
    const reshaper = await listen(createServer((req, res) => {
      reshaperCalls++;
      req.resume();
      res.writeHead(500, { "content-type": "application/json" });
      res.end('{"error":{"message":"must not be called"}}');
    }));
    const config: Config = {
      host: "127.0.0.1",
      port: 0,
      providers: {
        p1: { base: `http://127.0.0.1:${port(backend)}`, kind: "openai", authHeader: "authorization", timeoutMs: 2_000 },
      },
      routing: { default: "p1/m1", tiers: {}, benchmarkSort: false },
      mode: "repair",
      reshaper: {
        base: `http://127.0.0.1:${port(reshaper)}`,
        kind: "openai",
        model: "repair-model",
        authHeader: "authorization",
        timeoutMs: 1_000,
      },
      repair: { maxAttempts: 2, destructiveTools: ["write_note"] },
      log: { level: "silent", file: null },
    };
    const proxy = await listen(createProxy(config, {
      breaker: globalCircuitBreaker,
      catalog: new ModelCatalog({ cachePath: null }),
    }));

    const reqBody = request(true);
    reqBody.model = "p1/m1";
    const response = await fetch(`http://127.0.0.1:${port(proxy)}/v1/chat/completions`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(reqBody),
    });
    const body = await response.text();

    // The relay reconstructed a `write_note` call out of assistant TEXT, and the operator listed
    // that tool as destructive — "refused, never fabricated". Refused whole, and never reshaped:
    // repair is not a second chance at a call the config already rejected.
    expect(response.status, body).toBe(502);
    expect(body).toContain("destructive tool: write_note");
    expect(body).not.toContain('"tool_calls"');
    expect(reshaperCalls).toBe(0);
  });

  it("runs an invalid recovered call through the existing repair path", async () => {
    let reshaperCalls = 0;
    const dialect =
      '<｜DSML｜tool_calls><｜DSML｜invoke name="write_note">' +
      '<｜DSML｜parameter name="path">a.txt</｜DSML｜parameter>' +
      '<｜DSML｜parameter name="count">not-a-number</｜DSML｜parameter>' +
      '</｜DSML｜invoke></｜DSML｜tool_calls>';
    const backend = await listen(createServer((req, res) => {
      req.resume();
      req.on("end", () => {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({
          id: "chatcmpl_1",
          model: "served-model",
          choices: [{ index: 0, message: { role: "assistant", content: dialect }, finish_reason: "stop" }],
        }));
      });
    }));
    const reshaper = await listen(createServer((req, res) => {
      reshaperCalls++;
      req.resume();
      req.on("end", () => {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({
          choices: [{ message: { content: JSON.stringify({
            inputs: { call_recovered_0_0: { path: "a.txt", count: 7 } },
          }) } }],
        }));
      });
    }));
    const config: Config = {
      host: "127.0.0.1",
      port: 0,
      providers: {
        p1: { base: `http://127.0.0.1:${port(backend)}`, kind: "openai", authHeader: "authorization", timeoutMs: 2_000 },
      },
      routing: { default: "p1/m1", tiers: {}, benchmarkSort: false },
      mode: "repair",
      reshaper: {
        base: `http://127.0.0.1:${port(reshaper)}`,
        kind: "openai",
        model: "repair-model",
        authHeader: "authorization",
        timeoutMs: 1_000,
      },
      repair: { maxAttempts: 2, destructiveTools: [] },
      log: { level: "silent", file: null },
    };
    const proxy = await listen(createProxy(config, {
      breaker: globalCircuitBreaker,
      catalog: new ModelCatalog({ cachePath: null }),
    }));
    const reqBody = request(false);
    reqBody.model = "p1/m1";

    const response = await fetch(`http://127.0.0.1:${port(proxy)}/v1/chat/completions`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(reqBody),
    });
    const body = await response.json() as any;

    expect(response.status).toBe(200);
    expect(response.headers.get(TOOL_DIALECT_HEADER)).toBe("recovered");
    expect(reshaperCalls).toBe(1);
    expect(JSON.parse(body.choices[0].message.tool_calls[0].function.arguments)).toEqual({
      path: "a.txt",
      count: 7,
    });
  });

  it("leaves prose that merely names a tool untouched", async () => {
    const upstream = JSON.stringify({
      id: "chatcmpl_1",
      object: "chat.completion",
      model: "served-model",
      choices: [{
        index: 0,
        message: { role: "assistant", content: "The write_note tool would be appropriate." },
        finish_reason: "stop",
      }],
    }, null, 2);

    const response = await fetchOpenAiFront(resolveAttempt(target()), { isDestructive: NO_DESTRUCTIVE,
      reqJson: request(false),
      wantsStream: false,
      protocol: "chat",
      signal: AbortSignal.timeout(1_000),
    }, async () => new Response(upstream, {
      status: 200,
      headers: { "content-type": "application/json" },
    }));

    expect(await response.text()).toBe(upstream);
    expect(response.headers.get(TOOL_DIALECT_HEADER)).toBeNull();
  });

  it("keeps a no-tools streaming response byte-exact", async () => {
    const upstream = ROLE.replaceAll("\n", "\r\n") +
      chatChunk({ content: "literal <tool_call> text" }).replaceAll("\n", "\r\n") +
      STOP.replaceAll("\n", "\r\n");

    const response = await fetchOpenAiFront(resolveAttempt(target()), { isDestructive: NO_DESTRUCTIVE,
      reqJson: request(true, false),
      wantsStream: true,
      protocol: "chat",
      signal: AbortSignal.timeout(1_000),
    }, async () => new Response(upstream, {
      status: 200,
      headers: { "content-type": "text/event-stream" },
    }));

    expect(await response.text()).toBe(upstream);
    expect(response.headers.get(TOOL_DIALECT_HEADER)).toBeNull();
  });

  it("fails over an unparseable streamed envelope before commit", async () => {
    let firstCalls = 0;
    let secondCalls = 0;
    const first = await listen(createServer((req, res) => {
      req.resume();
      req.on("end", () => {
        firstCalls++;
        res.writeHead(200, { "content-type": "text/event-stream" });
        res.end(ROLE + chatChunk({ content: '<｜DSML｜tool_calls><｜DSML｜invoke name="write_note">' }) + STOP);
      });
    }));
    const second = await listen(createServer((req, res) => {
      req.resume();
      req.on("end", () => {
        secondCalls++;
        res.writeHead(200, { "content-type": "text/event-stream" });
        res.end(ROLE + chatChunk({ content: "served-b" }) + STOP);
      });
    }));

    const config: Config = {
      host: "127.0.0.1",
      port: 0,
      providers: {
        p1: { base: `http://127.0.0.1:${port(first)}`, kind: "openai", authHeader: "authorization", timeoutMs: 2_000 },
        p2: { base: `http://127.0.0.1:${port(second)}`, kind: "openai", authHeader: "authorization", timeoutMs: 2_000 },
      },
      routing: {
        default: "pool/direct",
        tiers: {},
        benchmarkSort: false,
        pools: { direct: ["p1/m1", "p2/m2"] },
      },
      mode: "detect",
      repair: { maxAttempts: 2, destructiveTools: [] },
      log: { level: "silent", file: null },
    };
    const proxy = await listen(createProxy(config, {
      breaker: globalCircuitBreaker,
      catalog: new ModelCatalog({ cachePath: null }),
    }));

    const response = await fetch(`http://127.0.0.1:${port(proxy)}/v1/chat/completions`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(request(true)),
    });
    const body = await response.text();

    expect(response.status).toBe(200);
    expect(body).toContain("served-b");
    expect(body).not.toContain("DSML");
    expect(firstCalls).toBe(1);
    expect(secondCalls).toBe(1);
    expect(response.headers.get(SERVED_BY_HEADER)).toBe("p2/m2");
    expect(response.headers.get(POOL_ATTEMPTS_HEADER)).toBe("2 tried, 1 served: 1x502, 1x200");
  });

  it("surfaces an unparseable envelope after content as a mid-stream error without failover", async () => {
    let firstCalls = 0;
    let secondCalls = 0;
    const first = await listen(createServer((req, res) => {
      req.resume();
      req.on("end", () => {
        firstCalls++;
        res.writeHead(200, { "content-type": "text/event-stream" });
        res.end(
          ROLE +
          chatChunk({ content: "served-a" }) +
          chatChunk({ content: '<｜DSML｜tool_calls><｜DSML｜invoke name="write_note">' }) +
          STOP,
        );
      });
    }));
    const second = await listen(createServer((req, res) => {
      req.resume();
      req.on("end", () => {
        secondCalls++;
        res.writeHead(200, { "content-type": "text/event-stream" });
        res.end(ROLE + chatChunk({ content: "served-b" }) + STOP);
      });
    }));
    const config: Config = {
      host: "127.0.0.1",
      port: 0,
      providers: {
        p1: { base: `http://127.0.0.1:${port(first)}`, kind: "openai", authHeader: "authorization", timeoutMs: 2_000 },
        p2: { base: `http://127.0.0.1:${port(second)}`, kind: "openai", authHeader: "authorization", timeoutMs: 2_000 },
      },
      routing: {
        default: "pool/direct",
        tiers: {},
        benchmarkSort: false,
        pools: { direct: ["p1/m1", "p2/m2"] },
      },
      mode: "detect",
      repair: { maxAttempts: 2, destructiveTools: [] },
      log: { level: "silent", file: null },
    };
    const proxy = await listen(createProxy(config, {
      breaker: globalCircuitBreaker,
      catalog: new ModelCatalog({ cachePath: null }),
    }));

    const response = await fetch(`http://127.0.0.1:${port(proxy)}/v1/chat/completions`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(request(true)),
    });
    const body = await response.text();

    expect(response.status).toBe(200);
    expect(body).toContain("served-a");
    expect(body).toContain("tool_dialect_unparseable");
    expect(body).not.toContain("DSML");
    expect(firstCalls).toBe(1);
    expect(secondCalls).toBe(0);
    expect(response.headers.get(SERVED_BY_HEADER)).toBe("p1/m1");
  });
});
