import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createServer, type IncomingHttpHeaders, type Server } from "node:http";
import { AddressInfo } from "node:net";
import { createProxy, type ProxyDeps } from "../src/server.js";
import { ModelCatalog } from "../src/catalog.js";
import { globalCircuitBreaker } from "../src/circuit-breaker.js";
import { resetFacts } from "../src/target-facts.js";
import { resetInterpretations } from "../src/refusal-interpretation.js";
import type { AccountingEvent, AccountingRecorder, AttemptCompletedEvent, RequestCompletedEvent } from "../src/accounting.js";
import type { Config, ProviderConfig } from "../src/config.js";

const servers: Server[] = [];

function track(server: Server): Server {
  servers.push(server);
  return server;
}

function port(server: Server): number {
  return (server.address() as AddressInfo).port;
}

async function closeTracked(): Promise<void> {
  await Promise.all(servers.splice(0).map((server) => new Promise<void>((resolve) => server.close(() => resolve()))));
}

beforeEach(() => {
  globalCircuitBreaker.reset();
  resetFacts();
  resetInterpretations();
});

afterEach(async () => {
  await closeTracked();
  globalCircuitBreaker.reset();
  resetFacts();
  resetInterpretations();
});

interface ScriptedReply {
  readonly status?: number;
  readonly headers?: Record<string, string>;
  readonly body: string;
}

function scripted(
  reply: (call: number, headers: IncomingHttpHeaders, body: string) => ScriptedReply,
): Promise<{ readonly server: Server; readonly calls: () => number; readonly headers: () => IncomingHttpHeaders[] }> {
  let count = 0;
  const seen: IncomingHttpHeaders[] = [];
  return new Promise((resolve) => {
    const server = createServer((request, response) => {
      const chunks: Buffer[] = [];
      request.on("data", (chunk: Buffer) => chunks.push(chunk));
      request.on("end", () => {
        seen.push(request.headers);
        const out = reply(++count, request.headers, Buffer.concat(chunks).toString("utf8"));
        response.writeHead(out.status ?? 200, { "content-type": "application/json", ...out.headers });
        response.end(out.body);
      });
    });
    server.listen(0, "127.0.0.1", () => resolve({ server: track(server), calls: () => count, headers: () => seen }));
  });
}

/** Emits meaningful Anthropic SSE output, then loses the upstream connection after commit. */
function truncatingSseBackend(): Promise<{ readonly server: Server; readonly calls: () => number }> {
  let count = 0;
  return new Promise((resolve) => {
    const server = createServer((request, response) => {
      request.resume();
      request.on("end", () => {
        count += 1;
        response.writeHead(200, { "content-type": "text/event-stream" });
        response.write(
          'event: message_start\ndata: {"type":"message_start","message":{"id":"msg_partial","type":"message","role":"assistant","model":"m1","content":[],"stop_reason":null,"usage":{"input_tokens":1,"output_tokens":0}}}\n\n',
        );
        response.write('event: content_block_start\ndata: {"type":"content_block_start","index":0,"content_block":{"type":"text","text":""}}\n\n');
        response.write('event: content_block_delta\ndata: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"partial"}}\n\n');
        setTimeout(() => response.socket?.destroy(), 20);
      });
    });
    server.listen(0, "127.0.0.1", () => resolve({ server: track(server), calls: () => count }));
  });
}

/** Holds a meaningful stream open long enough for the caller to disconnect after commit. */
function heldSseBackend(): Promise<{ readonly server: Server; readonly calls: () => number }> {
  let count = 0;
  return new Promise((resolve) => {
    const server = createServer((request, response) => {
      request.resume();
      request.on("end", () => {
        count += 1;
        response.writeHead(200, { "content-type": "text/event-stream" });
        response.write(
          'event: message_start\ndata: {"type":"message_start","message":{"id":"msg_cancel","type":"message","role":"assistant","model":"m1","content":[],"stop_reason":null,"usage":{"input_tokens":1,"output_tokens":0}}}\n\n',
        );
        response.write('event: content_block_delta\ndata: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"started"}}\n\n');
        const heartbeat = setInterval(() => {
          response.write('event: ping\ndata: {"type":"ping"}\n\n');
        }, 10);
        response.once("close", () => clearInterval(heartbeat));
      });
    });
    server.listen(0, "127.0.0.1", () => resolve({ server: track(server), calls: () => count }));
  });
}

/** Accepts upstream egress but never supplies a commit-worthy stream frame. */
function heldBeforeFirstChunkBackend(): Promise<{
  readonly server: Server;
  readonly calls: () => number;
  readonly started: () => Promise<void>;
}> {
  let count = 0;
  let signalStarted: (() => void) | undefined;
  const started = new Promise<void>((resolve) => { signalStarted = resolve; });
  return new Promise((resolve) => {
    const server = createServer((request, response) => {
      request.resume();
      request.on("end", () => {
        count += 1;
        response.writeHead(200, { "content-type": "text/event-stream" });
        response.flushHeaders();
        signalStarted?.();
      });
    });
    server.listen(0, "127.0.0.1", () => resolve({
      server: track(server),
      calls: () => count,
      started: () => started,
    }));
  });
}

function startProxy(config: Config, deps: ProxyDeps = {}): Promise<Server> {
  const server = createProxy(config, {
    catalog: new ModelCatalog({ cachePath: null }),
    breaker: globalCircuitBreaker,
    ...deps,
  });
  return new Promise((resolve) => server.listen(0, "127.0.0.1", () => resolve(track(server))));
}

function poolConfig(
  bases: readonly string[],
  kind: "anthropic" | "openai",
  authEnvs: readonly string[],
): Config {
  const providers: Record<string, ProviderConfig> = {};
  bases.forEach((base, index) => {
    const authEnv = authEnvs[index];
    if (authEnv === undefined) throw new Error("each accounting test provider needs an auth environment variable");
    providers[`accounting-${index + 1}`] = {
      base,
      kind,
      authHeader: kind === "anthropic" ? "x-api-key" : "authorization",
      timeoutMs: 5_000,
      authEnv,
    };
  });
  return {
    host: "127.0.0.1",
    port: 0,
    providers,
    routing: {
      default: "pool/coding",
      tiers: {},
      benchmarkSort: false,
      pools: { coding: bases.map((_, index) => `accounting-${index + 1}/m${index + 1}`) },
    },
    mode: "detect",
    repair: { maxAttempts: 2, destructiveTools: [] },
    log: { level: "silent", file: null },
  };
}

function recorder(events: AccountingEvent[]): AccountingRecorder {
  return { record: (event) => events.push(event) };
}

function attempts(events: AccountingEvent[]): AttemptCompletedEvent[] {
  return events.filter((event): event is AttemptCompletedEvent => event.type === "attempt-completed");
}

function requestCompleted(events: AccountingEvent[]): RequestCompletedEvent {
  const event = events.find((item): item is RequestCompletedEvent => item.type === "request-completed");
  if (!event) throw new Error("accounting lifecycle did not complete");
  return event;
}

async function waitForLifecycle(events: AccountingEvent[]): Promise<void> {
  for (let turn = 0; turn < 8 && !events.some((event) => event.type === "request-completed"); turn += 1) {
    await new Promise<void>((resolve) => setTimeout(resolve, 0));
  }
}

async function frontRequest(kind: "anthropic" | "openai", proxyPort: number, prompt: string): Promise<Response> {
  if (kind === "anthropic") {
    return fetch(`http://127.0.0.1:${proxyPort}/v1/messages`, {
      method: "POST",
      headers: { "content-type": "application/json", "anthropic-version": "2023-06-01" },
      body: JSON.stringify({
        model: "pool/coding",
        max_tokens: 20,
        messages: [{ role: "user", content: prompt }],
      }),
    });
  }
  return fetch(`http://127.0.0.1:${proxyPort}/v1/chat/completions`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ model: "pool/coding", max_tokens: 20, messages: [{ role: "user", content: prompt }] }),
  });
}

function winnerBody(kind: "anthropic" | "openai"): string {
  if (kind === "anthropic") {
    return JSON.stringify({
      id: "msg_accounting",
      type: "message",
      role: "assistant",
      model: "m2",
      content: [{ type: "text", text: "served" }],
      stop_reason: "end_turn",
      usage: {
        input_tokens: 7,
        output_tokens: 3,
        cache_creation_input_tokens: 11,
        cache_read_input_tokens: 13,
      },
    });
  }
  return JSON.stringify({
    id: "chatcmpl_accounting",
    object: "chat.completion",
    choices: [{ message: { role: "assistant", content: "served" }, finish_reason: "stop" }],
    usage: { prompt_tokens: 7, completion_tokens: 3, prompt_tokens_details: { cached_tokens: 5 } },
  });
}

describe("proxy accounting lifecycle", () => {
  it.each([
    ["/v1/messages", "claude"],
    ["/v1/chat/completions", "openai"],
    ["/chat/completions", "openai"],
    ["/v1/responses", "codex"],
    ["/responses", "codex"],
  ])("records an oversized caller-visible %s request as a no-attempt protocol terminal", async (pathname, expectedClient) => {
    const backend = await scripted(() => ({ body: winnerBody("openai") }));
    const events: AccountingEvent[] = [];
    const config = poolConfig(
      [`http://127.0.0.1:${port(backend.server)}`],
      "openai",
      ["ACCOUNTING_LIFECYCLE_EARLY_TERMINAL_KEY"],
    );
    config.maxBodyBytes = 1;
    const proxy = await startProxy(config, { accountingRecorder: recorder(events) });

    const secret = "early-body-secret-must-not-be-recorded";
    const response = await fetch(`http://127.0.0.1:${port(proxy)}${pathname}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ model: "pool/coding", secret }),
    });

    expect(response.status).toBe(413);
    await expect(response.text()).resolves.toContain("request body too large");
    await waitForLifecycle(events);
    expect(backend.calls()).toBe(0);
    expect(events.map((event) => event.type)).toEqual(["request-started", "request-completed"]);
    expect(events[0]).toMatchObject({
      client: expectedClient,
      attribution: "unknown",
      provider: null,
      model: null,
      credentialId: null,
    });
    expect(requestCompleted(events)).toMatchObject({
      outcome: "error",
      // "unknown", not "protocol": the request never reached a provider, so there is
      // nothing protocol-shaped about it — the enum's protocol kind means a provider
      // answered with a malformed envelope.
      failureKind: "unknown",
      attribution: "unknown",
      attemptCount: 0,
      repairIncluded: false,
      winningAttemptId: null,
      commitAttemptId: null,
      commitMs: null,
      provider: null,
      model: null,
      credentialId: null,
    });
    expect(JSON.stringify(events)).not.toContain(secret);
    expect(JSON.stringify(events)).not.toContain("request body too large");
  });

  it.each(["/v1/messages/count_tokens", "/v1/messages-prefix-lookalike"])(
    "does not account an oversized excluded %s request",
    async (pathname) => {
      const backend = await scripted(() => ({ body: winnerBody("openai") }));
      const events: AccountingEvent[] = [];
      const config = poolConfig(
        [`http://127.0.0.1:${port(backend.server)}`],
        "openai",
        ["ACCOUNTING_LIFECYCLE_EARLY_EXCLUSION_KEY"],
      );
      config.maxBodyBytes = 1;
      const proxy = await startProxy(config, { accountingRecorder: recorder(events) });

      const response = await fetch(`http://127.0.0.1:${port(proxy)}${pathname}`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ model: "pool/coding", payload: "early-body-secret-must-not-be-recorded" }),
      });

      expect(response.status).toBe(413);
      await expect(response.text()).resolves.toContain("request body too large");
      expect(backend.calls()).toBe(0);
      expect(events).toEqual([]);
    },
  );

  it.each(["anthropic", "openai"] as const)("records failed and committed winning serve attempts for the %s front", async (kind) => {
    const keyOne = "ACCOUNTING_LIFECYCLE_KEY_ONE";
    const keyTwo = "ACCOUNTING_LIFECYCLE_KEY_TWO";
    const oldOne = process.env[keyOne];
    const oldTwo = process.env[keyTwo];
    process.env[keyOne] = "first-secret";
    process.env[keyTwo] = "winner-secret";
    try {
      const failed = await scripted(() => ({
        status: 429,
        body: JSON.stringify({ error: { type: "rate_limit_error", message: "busy" } }),
      }));
      const winner = await scripted(() => ({ body: winnerBody(kind) }));
      const events: AccountingEvent[] = [];
      const proxy = await startProxy(poolConfig([
        `http://127.0.0.1:${port(failed.server)}`,
        `http://127.0.0.1:${port(winner.server)}`,
      ], kind, [keyOne, keyTwo]), { accountingRecorder: recorder(events) });
      const prompt = "accounting lifecycle prompt";
      const response = await frontRequest(kind, port(proxy), prompt);

      expect(response.status).toBe(200);
      await response.text();
      await waitForLifecycle(events);
      expect(events[0]).toMatchObject({
        type: "request-started",
        client: kind === "anthropic" ? "claude" : "openai",
      });
      expect(failed.calls()).toBe(1);
      expect(winner.calls()).toBe(1);
      expect(events.map((event) => event.type)).toEqual([
        "request-started",
        "attempt-started",
        "attempt-completed",
        "attempt-started",
        "attempt-completed",
        "request-completed",
      ]);

      const completedAttempts = attempts(events);
      expect(completedAttempts).toHaveLength(2);
      const failedAttempt = completedAttempts[0];
      const winnerAttempt = completedAttempts[1];
      if (!failedAttempt || !winnerAttempt) throw new Error("expected both serve attempts to complete");
      expect(failedAttempt).toMatchObject({
        role: "serve",
        outcome: "error",
        failureKind: "rate_limit",
        attribution: "relay_held",
        provider: "accounting-1",
        model: "m1",
        credentialId: "accounting-1#default",
        commitMs: null,
      });
      expect(winnerAttempt).toMatchObject({
        role: "serve",
        outcome: "success",
        failureKind: null,
        attribution: "relay_held",
        provider: "accounting-2",
        model: "m2",
        credentialId: "accounting-2#default",
      });
      expect(winnerAttempt.commitMs).not.toBeNull();
      expect(winnerAttempt.tokens.reported.reportedInput.value).toBe(7);
      expect(winnerAttempt.tokens.reported.reportedOutput.value).toBe(3);
      // The shared estimator traverses message roles as well as their content.
      expect(winnerAttempt.tokens.estimated.estimatedInput.value).toBe(Math.ceil((prompt.length + "user".length) / 4));
      expect(winnerAttempt.tokens.estimated.estimatedInput.method).toBe("relay_estimate");
      expect(winnerAttempt.tokens.estimated.estimatedOutput.value).toBeNull();

      if (kind === "anthropic") {
        expect(winnerAttempt.tokens.reported.cacheCreationInputTokens.value).toBe(11);
        expect(winnerAttempt.tokens.reported.cacheReadInputTokens.value).toBe(13);
        expect(winnerAttempt.tokens.reported.reportedCachedInput.value).toBeNull();
      } else {
        expect(winnerAttempt.tokens.reported.reportedCachedInput.value).toBe(5);
        expect(winnerAttempt.tokens.reported.cacheCreationInputTokens.value).toBeNull();
        expect(winnerAttempt.tokens.reported.cacheReadInputTokens.value).toBeNull();
      }

      const completed = requestCompleted(events);
      expect(completed).toMatchObject({
        outcome: "success",
        failureKind: null,
        attribution: "relay_held",
        attemptCount: 2,
        repairIncluded: false,
        provider: "accounting-2",
        model: "m2",
        credentialId: "accounting-2#default",
      });
      expect(completed.winningAttemptId).toBe(winnerAttempt.attemptId);
      expect(completed.commitAttemptId).toBe(winnerAttempt.attemptId);
      expect(completed.commitMs).toBe(winnerAttempt.commitMs);
      expect(completed.tokens).toEqual(winnerAttempt.tokens);
    } finally {
      if (oldOne === undefined) delete process.env[keyOne];
      else process.env[keyOne] = oldOne;
      if (oldTwo === undefined) delete process.env[keyTwo];
      else process.env[keyTwo] = oldTwo;
    }
  });

  it("does not start a serve attempt when every declared credential is missing", async () => {
    const missingKey = "ACCOUNTING_LIFECYCLE_MISSING_KEY";
    const prior = process.env[missingKey];
    delete process.env[missingKey];
    try {
      const backend = await scripted(() => ({ body: winnerBody("openai") }));
      const events: AccountingEvent[] = [];
      const proxy = await startProxy(poolConfig([
        `http://127.0.0.1:${port(backend.server)}`,
      ], "openai", [missingKey]), { accountingRecorder: recorder(events) });

      const response = await frontRequest("openai", port(proxy), "missing credentials must not egress");
      expect(response.status).toBe(502);
      await response.text();
      await waitForLifecycle(events);

      expect(backend.calls()).toBe(0);
      expect(events.filter((event) => event.type === "attempt-started")).toHaveLength(0);
      expect(attempts(events)).toHaveLength(0);
      expect(requestCompleted(events)).toMatchObject({
        outcome: "error",
        failureKind: "unknown",
        attemptCount: 0,
        winningAttemptId: null,
        commitAttemptId: null,
      });
    } finally {
      if (prior === undefined) delete process.env[missingKey];
      else process.env[missingKey] = prior;
    }
  });

  it("keeps a healthy response healthy when the recorder throws and strips the dashboard session header", async () => {
    const key = "ACCOUNTING_LIFECYCLE_THROWING_RECORDER_KEY";
    const prior = process.env[key];
    process.env[key] = "server-owned-secret";
    try {
      const backend = await scripted(() => ({ body: winnerBody("openai") }));
      const proxy = await startProxy(poolConfig([
        `http://127.0.0.1:${port(backend.server)}`,
      ], "openai", [key]), {
        accountingRecorder: { record: () => { throw new Error("metrics sink unavailable"); } },
      });
      const response = await fetch(`http://127.0.0.1:${port(proxy)}/v1/chat/completions`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-llm-relay-dashboard-session": "dashboard-session-secret",
        },
        body: JSON.stringify({
          model: "pool/coding",
          messages: [{ role: "user", content: "the accounting sink may fail" }],
        }),
      });

      expect(response.status).toBe(200);
      expect(await response.json()).toMatchObject({ choices: [{ message: { content: "served" } }] });
      expect(backend.calls()).toBe(1);
      expect(backend.headers()[0]?.["x-llm-relay-dashboard-session"]).toBeUndefined();
    } finally {
      if (prior === undefined) delete process.env[key];
      else process.env[key] = prior;
    }
  });

  it("observes streamed OpenAI usage and commits the serving attempt", async () => {
    const key = "ACCOUNTING_LIFECYCLE_STREAM_KEY";
    const prior = process.env[key];
    process.env[key] = "stream-secret";
    try {
      const backend = await scripted(() => ({
        headers: { "content-type": "text/event-stream" },
        body: [
          `data: ${JSON.stringify({
            id: "chatcmpl_stream_accounting",
            choices: [{ index: 0, delta: { content: "served" }, finish_reason: null }],
          })}\n\n`,
          `data: ${JSON.stringify({
            id: "chatcmpl_stream_accounting",
            choices: [],
            usage: { prompt_tokens: 4, completion_tokens: 2, prompt_tokens_details: { cached_tokens: 1 } },
          })}\n\n`,
          "data: [DONE]\n\n",
        ].join(""),
      }));
      const events: AccountingEvent[] = [];
      const proxy = await startProxy(poolConfig([
        `http://127.0.0.1:${port(backend.server)}`,
      ], "openai", [key]), { accountingRecorder: recorder(events) });
      const response = await fetch(`http://127.0.0.1:${port(proxy)}/v1/chat/completions`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          model: "pool/coding",
          stream: true,
          messages: [{ role: "user", content: "observe my stream" }],
        }),
      });

      expect(response.status).toBe(200);
      expect(await response.text()).toContain("[DONE]");
      await waitForLifecycle(events);
      const completedAttempts = attempts(events);
      expect(completedAttempts).toHaveLength(1);
      const served = completedAttempts[0];
      if (!served) throw new Error("streaming serve attempt did not complete");
      expect(served).toMatchObject({ outcome: "success", role: "serve", commitMs: expect.any(Number) });
      expect(served.tokens.reported.reportedInput.value).toBe(4);
      expect(served.tokens.reported.reportedOutput.value).toBe(2);
      expect(served.tokens.reported.reportedCachedInput.value).toBe(1);
      expect(served.tokens.estimated.estimatedOutput.value).toBeNull();
      expect(requestCompleted(events).commitAttemptId).toBe(served.attemptId);
    } finally {
      if (prior === undefined) delete process.env[key];
      else process.env[key] = prior;
    }
  });

  it("records a real same-target repair fetch with the served credential identity", async () => {
    const key = "ACCOUNTING_LIFECYCLE_REPAIR_KEY";
    const prior = process.env[key];
    process.env[key] = "repair-secret";
    try {
      const malformed =
        '<｜DSML｜tool_calls><｜DSML｜invoke name="write_note">' +
        '<｜DSML｜parameter name="path">a.txt</｜DSML｜parameter>' +
        '<｜DSML｜parameter name="count">not-a-number</｜DSML｜parameter>' +
        '</｜DSML｜invoke></｜DSML｜tool_calls>';
      const backend = await scripted((call) => call === 1
        ? {
          body: JSON.stringify({
            id: "chatcmpl_repair_served",
            choices: [{ index: 0, message: { role: "assistant", content: malformed }, finish_reason: "stop" }],
          }),
        }
        : {
          body: JSON.stringify({
            choices: [{ message: { content: JSON.stringify({
              inputs: { call_recovered_0_0: { path: "a.txt", count: 7 } },
            }) } }],
            usage: { prompt_tokens: 17, completion_tokens: 5 },
          }),
        });
      const events: AccountingEvent[] = [];
      const config = poolConfig([`http://127.0.0.1:${port(backend.server)}`], "openai", [key]);
      config.mode = "repair";
      const proxy = await startProxy(config, { accountingRecorder: recorder(events) });
      const response = await fetch(`http://127.0.0.1:${port(proxy)}/v1/chat/completions`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          model: "pool/coding",
          messages: [{ role: "user", content: "write it" }],
          tools: [{
            type: "function",
            function: {
              name: "write_note",
              parameters: {
                type: "object",
                properties: { path: { type: "string" }, count: { type: "number" } },
                required: ["path"],
              },
            },
          }],
        }),
      });

      expect(response.status).toBe(200);
      const body = await response.json() as { choices: Array<{ message: { tool_calls?: Array<{ function: { arguments: string } }> } }> };
      expect(JSON.parse(body.choices[0]?.message.tool_calls?.[0]?.function.arguments ?? "{}")).toEqual({ path: "a.txt", count: 7 });
      await waitForLifecycle(events);
      expect(backend.calls()).toBe(2);

      const repair = attempts(events).find((event) => event.role === "repair");
      if (!repair) throw new Error("real repair fetch was not accounted");
      expect(repair).toMatchObject({
        outcome: "success",
        failureKind: null,
        attribution: "relay_held",
        provider: "accounting-1",
        model: "m1",
        credentialId: "accounting-1#default",
        commitMs: null,
      });
      expect(repair.tokens.reported.reportedInput.value).toBe(17);
      expect(repair.tokens.reported.reportedOutput.value).toBe(5);
      expect(repair.tokens.estimated.estimatedInput.value).toBeNull();
      expect(repair.tokens.estimated.estimatedOutput.value).toBeNull();
      expect(requestCompleted(events)).toMatchObject({ repairIncluded: true, outcome: "success" });
    } finally {
      if (prior === undefined) delete process.env[key];
      else process.env[key] = prior;
    }
  });

  it("attributes standalone reshapers without inventing a provider or credential identity", async () => {
    const servedKey = "ACCOUNTING_LIFECYCLE_STANDALONE_SERVED_KEY";
    const repairKey = "ACCOUNTING_LIFECYCLE_STANDALONE_REPAIR_KEY";
    const priorServed = process.env[servedKey];
    const priorRepair = process.env[repairKey];
    process.env[servedKey] = "served-secret";
    process.env[repairKey] = "standalone-repair-secret";
    try {
      const malformed = '<｜DSML｜tool_calls><｜DSML｜invoke name="write_note">'
        + '<｜DSML｜parameter name="path">a.txt</｜DSML｜parameter>'
        + '<｜DSML｜parameter name="count">not-a-number</｜DSML｜parameter>'
        + '</｜DSML｜invoke></｜DSML｜tool_calls>';
      for (const row of [
        { name: "declared standalone credential", authEnv: repairKey, attribution: "relay_held" as const },
        { name: "keyless standalone reshaper", authEnv: undefined, attribution: "unknown" as const },
      ]) {
        const served = await scripted(() => ({
          body: JSON.stringify({
            id: "chatcmpl_standalone_repair",
            choices: [{ index: 0, message: { role: "assistant", content: malformed }, finish_reason: "stop" }],
          }),
        }));
        const repairBackend = await scripted(() => ({
          body: JSON.stringify({
            choices: [{ message: { content: JSON.stringify({
              inputs: { call_recovered_0_0: { path: "a.txt", count: 7 } },
            }) } }],
          }),
        }));
        const events: AccountingEvent[] = [];
        const config = poolConfig([`http://127.0.0.1:${port(served.server)}`], "openai", [servedKey]);
        config.mode = "repair";
        config.reshaper = {
          base: `http://127.0.0.1:${port(repairBackend.server)}`,
          kind: "openai",
          model: "standalone-repair-model",
          authHeader: "authorization",
          timeoutMs: 5_000,
          ...(row.authEnv ? { authEnv: row.authEnv } : {}),
        };
        const proxy = await startProxy(config, { accountingRecorder: recorder(events) });
        const response = await fetch(`http://127.0.0.1:${port(proxy)}/v1/chat/completions`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            model: "pool/coding",
            messages: [{ role: "user", content: "write it" }],
            tools: [{
              type: "function",
              function: {
                name: "write_note",
                parameters: {
                  type: "object",
                  properties: { path: { type: "string" }, count: { type: "number" } },
                  required: ["path", "count"],
                },
              },
            }],
          }),
        });
        expect(response.status, row.name).toBe(200);
        await response.text();
        await waitForLifecycle(events);
        const repair = attempts(events).find((event) => event.role === "repair");
        if (!repair) throw new Error(`${row.name} did not record its repair fetch`);
        expect(repair, row.name).toMatchObject({
          outcome: "success",
          attribution: row.attribution,
          provider: null,
          model: "standalone-repair-model",
          credentialId: null,
        });
        expect(served.calls(), row.name).toBe(1);
        expect(repairBackend.calls(), row.name).toBe(1);
      }
    } finally {
      if (priorServed === undefined) delete process.env[servedKey];
      else process.env[servedKey] = priorServed;
      if (priorRepair === undefined) delete process.env[repairKey];
      else process.env[repairKey] = priorRepair;
    }
  });

  it("cancels an in-flight repair once when the client disconnects", async () => {
    const servedKey = "ACCOUNTING_LIFECYCLE_REPAIR_ABORT_SERVED_KEY";
    const repairKey = "ACCOUNTING_LIFECYCLE_REPAIR_ABORT_KEY";
    const priorServed = process.env[servedKey];
    const priorRepair = process.env[repairKey];
    process.env[servedKey] = "served-secret";
    process.env[repairKey] = "repair-secret";
    try {
      const malformed = '<｜DSML｜tool_calls><｜DSML｜invoke name="write_note">'
        + '<｜DSML｜parameter name="path">a.txt</｜DSML｜parameter>'
        + '<｜DSML｜parameter name="count">not-a-number</｜DSML｜parameter>'
        + '</｜DSML｜invoke></｜DSML｜tool_calls>';
      const served = await scripted(() => ({
        body: JSON.stringify({
          id: "chatcmpl_repair_abort",
          choices: [{ index: 0, message: { role: "assistant", content: malformed }, finish_reason: "stop" }],
        }),
      }));
      const repairBackend = await heldBeforeFirstChunkBackend();
      const events: AccountingEvent[] = [];
      const config = poolConfig([`http://127.0.0.1:${port(served.server)}`], "openai", [servedKey]);
      config.mode = "repair";
      config.reshaper = {
        base: `http://127.0.0.1:${port(repairBackend.server)}`,
        kind: "openai",
        model: "repair-model",
        authHeader: "authorization",
        timeoutMs: 5_000,
        authEnv: repairKey,
      };
      const proxy = await startProxy(config, { accountingRecorder: recorder(events) });
      const controller = new AbortController();
      const pending = fetch(`http://127.0.0.1:${port(proxy)}/v1/chat/completions`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        signal: controller.signal,
        body: JSON.stringify({
          model: "pool/coding",
          messages: [{ role: "user", content: "write it" }],
          tools: [{
            type: "function",
            function: {
              name: "write_note",
              parameters: {
                type: "object",
                properties: { path: { type: "string" }, count: { type: "number" } },
                required: ["path", "count"],
              },
            },
          }],
        }),
      });
      await repairBackend.started();
      controller.abort();
      await pending.catch(() => {});
      await waitForLifecycle(events);
      const repair = attempts(events).filter((event) => event.role === "repair");
      expect(repair).toHaveLength(1);
      expect(repair[0]).toMatchObject({ outcome: "cancelled", failureKind: "aborted" });
      expect(repairBackend.calls()).toBe(1);
      expect(requestCompleted(events)).toMatchObject({ outcome: "cancelled", failureKind: "aborted" });
    } finally {
      if (priorServed === undefined) delete process.env[servedKey];
      else process.env[servedKey] = priorServed;
      if (priorRepair === undefined) delete process.env[repairKey];
      else process.env[repairKey] = priorRepair;
    }
  });

  it("does not start a repair attempt or egress when the configured repair credential is missing", async () => {
    const serveKey = "ACCOUNTING_LIFECYCLE_REPAIR_SERVE_KEY";
    const missingRepairKey = "ACCOUNTING_LIFECYCLE_REPAIR_MISSING_KEY";
    const priorServe = process.env[serveKey];
    const priorRepair = process.env[missingRepairKey];
    process.env[serveKey] = "served-secret";
    delete process.env[missingRepairKey];
    try {
      const malformed =
        '<｜DSML｜tool_calls><｜DSML｜invoke name="write_note">' +
        '<｜DSML｜parameter name="path">a.txt</｜DSML｜parameter>' +
        '<｜DSML｜parameter name="count">not-a-number</｜DSML｜parameter>' +
        '</｜DSML｜invoke></｜DSML｜tool_calls>';
      const served = await scripted(() => ({
        body: JSON.stringify({
          id: "chatcmpl_missing_repair",
          choices: [{ index: 0, message: { role: "assistant", content: malformed }, finish_reason: "stop" }],
        }),
      }));
      const repairBackend = await scripted(() => ({ body: winnerBody("openai") }));
      const events: AccountingEvent[] = [];
      const config = poolConfig([`http://127.0.0.1:${port(served.server)}`], "openai", [serveKey]);
      config.mode = "repair";
      config.reshaper = {
        base: `http://127.0.0.1:${port(repairBackend.server)}`,
        kind: "openai",
        model: "repair-model",
        authHeader: "authorization",
        timeoutMs: 5_000,
        authEnv: missingRepairKey,
      };
      const proxy = await startProxy(config, { accountingRecorder: recorder(events) });
      const response = await fetch(`http://127.0.0.1:${port(proxy)}/v1/chat/completions`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          model: "pool/coding",
          messages: [{ role: "user", content: "write it" }],
          tools: [{
            type: "function",
            function: {
              name: "write_note",
              parameters: {
                type: "object",
                properties: { path: { type: "string" }, count: { type: "number" } },
                required: ["path"],
              },
            },
          }],
        }),
      });

      expect(response.status).toBeGreaterThanOrEqual(400);
      await response.text();
      await waitForLifecycle(events);
      expect(served.calls()).toBe(1);
      expect(repairBackend.calls()).toBe(0);
      expect(events.filter((event) => event.type === "attempt-started" && event.role === "repair")).toHaveLength(0);
      expect(attempts(events).filter((event) => event.role === "repair")).toHaveLength(0);
    } finally {
      if (priorServe === undefined) delete process.env[serveKey];
      else process.env[serveKey] = priorServe;
      if (priorRepair === undefined) delete process.env[missingRepairKey];
      else process.env[missingRepairKey] = priorRepair;
    }
  });

  it("records /v1/responses as a caller-visible serve lifecycle", async () => {
    const key = "ACCOUNTING_LIFECYCLE_RESPONSES_KEY";
    const prior = process.env[key];
    process.env[key] = "responses-secret";
    try {
      const backend = await scripted(() => ({ body: winnerBody("anthropic") }));
      const events: AccountingEvent[] = [];
      const proxy = await startProxy(poolConfig([
        `http://127.0.0.1:${port(backend.server)}`,
      ], "anthropic", [key]), { accountingRecorder: recorder(events) });
      const response = await fetch(`http://127.0.0.1:${port(proxy)}/v1/responses`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ model: "pool/coding", input: "responses accounting input" }),
      });

      expect(response.status).toBe(200);
      expect(await response.json()).toMatchObject({ object: "response", output_text: "served" });
      await waitForLifecycle(events);
      expect(events[0]).toMatchObject({ type: "request-started", client: "codex" });
      expect(backend.calls()).toBe(1);
      const served = attempts(events)[0];
      if (!served) throw new Error("Responses request did not record a serve attempt");
      expect(served).toMatchObject({
        role: "serve",
        outcome: "success",
        attribution: "relay_held",
        provider: "accounting-1",
        model: "m1",
        credentialId: "accounting-1#default",
      });
    expect(requestCompleted(events)).toMatchObject({
      outcome: "success",
        attemptCount: 1,
        repairIncluded: false,
        winningAttemptId: served.attemptId,
        commitAttemptId: served.attemptId,
      });
    } finally {
      if (prior === undefined) delete process.env[key];
      else process.env[key] = prior;
    }
  });

  it("labels serve attribution from credential state and containment policy", async () => {
    const key = "ACCOUNTING_LIFECYCLE_ATTRIBUTION_KEY";
    const prior = process.env[key];
    process.env[key] = "relay-held-secret";
    const cases: Array<{
      readonly name: string;
      readonly expected: "relay_held" | "caller_operated" | "unknown";
      readonly provider: (base: string) => ProviderConfig;
    }> = [
      {
        name: "declared present",
        expected: "relay_held",
        provider: (base) => ({
          base,
          kind: "anthropic",
          authHeader: "x-api-key",
          timeoutMs: 5_000,
          authEnv: key,
        }),
      },
      {
        name: "genuine passthrough",
        expected: "caller_operated",
        provider: (base) => ({
          base,
          kind: "anthropic",
          authHeader: "x-api-key",
          timeoutMs: 5_000,
          credentialMode: "passthrough",
        }),
      },
      {
        name: "contained keyless target",
        expected: "unknown",
        provider: (base) => ({
          base,
          kind: "anthropic",
          authHeader: "x-api-key",
          timeoutMs: 5_000,
          credentialMode: "contained",
        }),
      },
    ];
    try {
      for (const row of cases) {
        const backend = await scripted(() => ({ body: winnerBody("anthropic") }));
        const events: AccountingEvent[] = [];
        const config: Config = {
          host: "127.0.0.1",
          port: 0,
          providers: { "accounting-attribution": row.provider(`http://127.0.0.1:${port(backend.server)}`) },
          routing: { default: "accounting-attribution", tiers: {}, benchmarkSort: false },
          mode: "detect",
          repair: { maxAttempts: 2, destructiveTools: [] },
          log: { level: "silent", file: null },
        };
        const proxy = await startProxy(config, { accountingRecorder: recorder(events) });
        const response = await fetch(`http://127.0.0.1:${port(proxy)}/v1/messages`, {
          method: "POST",
          headers: { "content-type": "application/json", authorization: "Bearer caller-owned-token" },
          body: JSON.stringify({
            model: "accounting-attribution",
            max_tokens: 20,
            messages: [{ role: "user", content: "attribute this request" }],
          }),
        });

        expect(response.status, row.name).toBe(200);
        await response.text();
        await waitForLifecycle(events);
        expect(backend.calls(), row.name).toBe(1);
        const served = attempts(events)[0];
        if (!served) throw new Error(`${row.name} did not record its serve attempt`);
        expect(served, row.name).toMatchObject({
          attribution: row.expected,
          provider: "accounting-attribution",
          model: null,
          credentialId: "accounting-attribution#default",
        });
        expect(requestCompleted(events).attribution, row.name).toBe(row.expected);
      }
    } finally {
      if (prior === undefined) delete process.env[key];
      else process.env[key] = prior;
    }
  });

  it("keeps the first committed serve authoritative after an upstream stream fails", async () => {
    const key = "ACCOUNTING_LIFECYCLE_POST_COMMIT_KEY";
    const prior = process.env[key];
    process.env[key] = "post-commit-secret";
    try {
      const backend = await truncatingSseBackend();
      const events: AccountingEvent[] = [];
      const proxy = await startProxy(poolConfig([
        `http://127.0.0.1:${port(backend.server)}`,
      ], "anthropic", [key]), { accountingRecorder: recorder(events) });
      const response = await fetch(`http://127.0.0.1:${port(proxy)}/v1/messages`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          model: "pool/coding",
          stream: true,
          max_tokens: 20,
          messages: [{ role: "user", content: "start then fail" }],
        }),
      });

      expect(response.status).toBe(200);
      expect(await response.text()).toContain("backend stream failed mid-response");
      await waitForLifecycle(events);
      expect(backend.calls()).toBe(1);
      const served = attempts(events).find((event) => event.role === "serve");
      if (!served) throw new Error("post-commit stream did not record a serve attempt");
      expect(served).toMatchObject({
        outcome: "error",
        attribution: "relay_held",
        provider: "accounting-1",
        credentialId: "accounting-1#default",
      });
      expect(served.commitMs).not.toBeNull();
      const completed = requestCompleted(events);
      expect(completed).toMatchObject({
        outcome: "error",
        attribution: "relay_held",
        repairIncluded: false,
        winningAttemptId: served.attemptId,
        commitAttemptId: served.attemptId,
      });
      expect(completed.commitMs).toBe(served.commitMs);
      expect(events.filter((event) => event.type === "attempt-started" && event.role === "repair")).toHaveLength(0);
    } finally {
      if (prior === undefined) delete process.env[key];
      else process.env[key] = prior;
    }
  });

  it("keeps the committed serve identity when the client disconnects after its first SSE chunk", async () => {
    const key = "ACCOUNTING_LIFECYCLE_CLIENT_ABORT_KEY";
    const prior = process.env[key];
    process.env[key] = "client-abort-secret";
    try {
      const backend = await heldSseBackend();
      const events: AccountingEvent[] = [];
      const proxy = await startProxy(poolConfig([
        `http://127.0.0.1:${port(backend.server)}`,
      ], "anthropic", [key]), { accountingRecorder: recorder(events) });
      const controller = new AbortController();
      const response = await fetch(`http://127.0.0.1:${port(proxy)}/v1/messages`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        signal: controller.signal,
        body: JSON.stringify({
          model: "pool/coding",
          stream: true,
          max_tokens: 20,
          messages: [{ role: "user", content: "disconnect after commit" }],
        }),
      });
      const reader = response.body?.getReader();
      if (!reader) throw new Error("streaming response unexpectedly had no body");
      const first = await reader.read();
      expect(first.done).toBe(false);
      expect(first.value?.byteLength).toBeGreaterThan(0);
      controller.abort();
      await reader.cancel().catch(() => {});

      // Let the proxy observe the downstream socket close, but keep the wait bounded.
      await new Promise<void>((resolve) => setTimeout(resolve, 40));
      await waitForLifecycle(events);
      expect(backend.calls()).toBe(1);
      const served = attempts(events).find((event) => event.role === "serve");
      if (!served) throw new Error("client-aborted stream did not record a serve attempt");
      expect(served).toMatchObject({
        outcome: "cancelled",
        failureKind: "aborted",
        attribution: "relay_held",
        provider: "accounting-1",
        credentialId: "accounting-1#default",
      });
      expect(served.commitMs).not.toBeNull();
      expect(requestCompleted(events)).toMatchObject({
        outcome: "cancelled",
        failureKind: "aborted",
        attribution: "relay_held",
        winningAttemptId: served.attemptId,
        commitAttemptId: served.attemptId,
      });
      expect(events.filter((event) => event.type === "attempt-started" && event.role === "repair")).toHaveLength(0);
    } finally {
      if (prior === undefined) delete process.env[key];
      else process.env[key] = prior;
    }
  });

  it("does not commit or replay when the client disconnects before the first meaningful SSE chunk", async () => {
    const firstKey = "ACCOUNTING_LIFECYCLE_PRECOMMIT_FIRST_KEY";
    const secondKey = "ACCOUNTING_LIFECYCLE_PRECOMMIT_SECOND_KEY";
    const priorFirst = process.env[firstKey];
    const priorSecond = process.env[secondKey];
    process.env[firstKey] = "precommit-first-secret";
    process.env[secondKey] = "precommit-second-secret";
    try {
      const first = await heldBeforeFirstChunkBackend();
      const second = await scripted(() => ({ body: winnerBody("anthropic") }));
      const events: AccountingEvent[] = [];
      const proxy = await startProxy(poolConfig([
        `http://127.0.0.1:${port(first.server)}`,
        `http://127.0.0.1:${port(second.server)}`,
      ], "anthropic", [firstKey, secondKey]), { accountingRecorder: recorder(events) });
      const controller = new AbortController();
      const pending = fetch(`http://127.0.0.1:${port(proxy)}/v1/messages`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        signal: controller.signal,
        body: JSON.stringify({
          model: "pool/coding",
          stream: true,
          max_tokens: 20,
          messages: [{ role: "user", content: "disconnect before commit" }],
        }),
      });
      await first.started();
      controller.abort();
      await pending.catch(() => undefined);

      // The proxy learns of the client socket close asynchronously after upstream egress begins.
      await new Promise<void>((resolve) => setTimeout(resolve, 40));
      await waitForLifecycle(events);
      expect(first.calls()).toBe(1);
      expect(second.calls()).toBe(0);
      expect(events.filter((event) => event.type === "attempt-completed")).toHaveLength(1);
      expect(events.filter((event) => event.type === "request-completed")).toHaveLength(1);
      const served = attempts(events)[0];
      if (!served) throw new Error("pre-commit disconnect did not complete its serve attempt");
      expect(served).toMatchObject({
        outcome: "cancelled",
        failureKind: "aborted",
        attribution: "relay_held",
        provider: "accounting-1",
        credentialId: "accounting-1#default",
        commitMs: null,
      });
      expect(requestCompleted(events)).toMatchObject({
        outcome: "cancelled",
        failureKind: "aborted",
        attribution: "relay_held",
        winningAttemptId: null,
        commitAttemptId: null,
        commitMs: null,
      });
      expect(events.filter((event) => event.type === "attempt-started" && event.role === "repair")).toHaveLength(0);
    } finally {
      if (priorFirst === undefined) delete process.env[firstKey];
      else process.env[firstKey] = priorFirst;
      if (priorSecond === undefined) delete process.env[secondKey];
      else process.env[secondKey] = priorSecond;
    }
  });
});
