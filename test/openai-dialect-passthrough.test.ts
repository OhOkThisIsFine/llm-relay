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

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function choicesOnWire(body: string): Record<string, unknown>[] {
  const choices: Record<string, unknown>[] = [];
  for (const block of body.split(/\r?\n\r?\n/)) {
    const data = block.split(/\r?\n/)
      .filter((line) => line.startsWith("data:"))
      .map((line) => line.slice(5).trim())
      .join("\n");
    if (!data || data === "[DONE]") continue;
    const parsed = JSON.parse(data) as unknown;
    if (!isRecord(parsed) || !Array.isArray(parsed.choices)) continue;
    choices.push(...parsed.choices.filter(isRecord));
  }
  return choices;
}

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

  it("replaces a finish-bearing captured tail with one tool_calls finish", async () => {
    const dialect =
      '<｜DSML｜tool_calls><｜DSML｜invoke name="write_note">' +
      '<｜DSML｜parameter name="path">a.txt</｜DSML｜parameter>' +
      '</｜DSML｜invoke></｜DSML｜tool_calls>';
    const split = 40;
    const upstream = ROLE +
      chatChunk({ content: dialect.slice(0, split) }) +
      chatChunk({ content: dialect.slice(split) }, "stop") +
      "data: [DONE]\n\n";

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
    const choices = choicesOnWire(body);
    const toolCallsAt = choices.findIndex((choice) =>
      isRecord(choice.delta) && Array.isArray(choice.delta.tool_calls));
    const terminalAt = choices.findIndex((choice) => choice.finish_reason === "tool_calls");

    expect(choices.map((choice) => choice.finish_reason).filter((finish) => finish != null))
      .toEqual(["tool_calls"]);
    expect(toolCallsAt).toBeGreaterThan(-1);
    expect(toolCallsAt).toBeLessThan(terminalAt);
    expect(body).not.toContain('"finish_reason":"stop"');
  });

  it("keeps surrounding prose before recovered events when marker and finish share a chunk", async () => {
    const dialect =
      '<｜DSML｜tool_calls><｜DSML｜invoke name="write_note">' +
      '<｜DSML｜parameter name="path">a.txt</｜DSML｜parameter>' +
      '</｜DSML｜invoke></｜DSML｜tool_calls>';
    const upstream = ROLE +
      chatChunk({ content: `safe prefix ${dialect} trailing prose` }, "stop") +
      "data: [DONE]\n\n";

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
    const choices = choicesOnWire(body);
    const content = choices.flatMap((choice) => {
      const delta = isRecord(choice.delta) ? choice.delta : null;
      return typeof delta?.content === "string" ? [delta.content] : [];
    });

    expect(content).toEqual(["safe prefix ", "trailing prose"]);
    expect(body.indexOf('"content":"safe prefix "')).toBeLessThan(body.indexOf('"tool_calls"'));
    expect(choices.map((choice) => choice.finish_reason).filter((finish) => finish != null))
      .toEqual(["tool_calls"]);
    expect(body).not.toContain('"finish_reason":"stop"');
  });

  it("flushes a final potential marker prefix in order with one finish on the tail", async () => {
    const text = "safe text ｜DSML";
    const upstream = ROLE + chatChunk({ content: text }, "stop") + "data: [DONE]\n\n";

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
    const choices = choicesOnWire(body);
    const contentChoices = choices.filter((choice) => {
      const delta = isRecord(choice.delta) ? choice.delta : null;
      return typeof delta?.content === "string";
    });

    expect(contentChoices.map((choice) => (choice.delta as Record<string, unknown>).content))
      .toEqual(["safe text ", "｜DSML"]);
    expect(contentChoices.map((choice) => choice.finish_reason)).toEqual([null, "stop"]);
    expect(choices.map((choice) => choice.finish_reason).filter((finish) => finish != null))
      .toEqual(["stop"]);
    expect(response.headers.get(TOOL_DIALECT_HEADER)).toBeNull();
  });

  it("splices an empty finish shell and serves the withheld tail with the choice's only finish", async () => {
    // Same withheld-suffix shape as above, but the finish arrives in a SEPARATE empty-delta chunk:
    // that chunk's outgoing entry has nothing left once its finish moves to the generated tail, so
    // it is spliced out entirely — the branch the one-chunk variant never reaches.
    const upstream = ROLE +
      chatChunk({ content: "safe text ｜DSML" }) +
      chatChunk({}, "stop") +
      "data: [DONE]\n\n";

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
    const choices = choicesOnWire(body);
    const contentChoices = choices.filter((choice) => {
      const delta = isRecord(choice.delta) ? choice.delta : null;
      return typeof delta?.content === "string";
    });

    expect(contentChoices.map((choice) => (choice.delta as Record<string, unknown>).content))
      .toEqual(["safe text ", "｜DSML"]);
    expect(contentChoices.map((choice) => choice.finish_reason)).toEqual([null, "stop"]);
    expect(choices.map((choice) => choice.finish_reason).filter((finish) => finish != null))
      .toEqual(["stop"]);
    expect(response.headers.get(TOOL_DIALECT_HEADER)).toBeNull();
  });

  it("keeps per-choice slots independent when two choices share a finish-bearing chunk", async () => {
    // Slot tracking is per rawChoice: settling choice 0 (capturing) must not disturb choice 1's
    // entry in the same chunk. Choice 0's envelope is rescued with its own terminal finish; choice
    // 1's plain text keeps its upstream "stop" untouched.
    const dialect =
      '<｜DSML｜tool_calls><｜DSML｜invoke name="write_note">' +
      '<｜DSML｜parameter name="path">a.txt</｜DSML｜parameter>' +
      '</｜DSML｜invoke></｜DSML｜tool_calls>';
    const multiChunk = (choices: Record<string, unknown>[]): string =>
      `data: ${JSON.stringify({
        id: "chatcmpl_1",
        object: "chat.completion.chunk",
        model: "served-model",
        choices,
      })}\n\n`;
    const upstream =
      multiChunk([
        { index: 0, delta: { role: "assistant" }, finish_reason: null },
        { index: 1, delta: { role: "assistant" }, finish_reason: null },
      ]) +
      multiChunk([
        { index: 0, delta: { content: dialect }, finish_reason: "stop" },
        { index: 1, delta: { content: "plain answer" }, finish_reason: "stop" },
      ]) +
      "data: [DONE]\n\n";

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
    const choices = choicesOnWire(body);
    const finishesFor = (index: number): unknown[] => choices
      .filter((choice) => choice.index === index && choice.finish_reason != null)
      .map((choice) => choice.finish_reason);

    expect(finishesFor(0)).toEqual(["tool_calls"]);
    expect(finishesFor(1)).toEqual(["stop"]);
    expect(choices.some((choice) => choice.index === 0 &&
      isRecord(choice.delta) && Array.isArray(choice.delta.tool_calls))).toBe(true);
    expect(choices.some((choice) => choice.index === 1 &&
      isRecord(choice.delta) &&
      (choice.delta as Record<string, unknown>).content === "plain answer")).toBe(true);
    expect(body).toContain('"name":"write_note"');
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
