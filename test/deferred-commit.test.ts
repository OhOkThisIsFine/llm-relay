import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createServer, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createProxy } from "../src/server.js";
import { CircuitBreaker, globalCircuitBreaker } from "../src/circuit-breaker.js";
import { makeCredentialId } from "../src/credential-id.js";
import { ModelCatalog } from "../src/catalog.js";
import {
  CREDENTIAL_ATTEMPTS_HEADER,
  CREDENTIAL_HEADER,
  DEGRADED_HEADER,
  PAID_HEADER,
  POOL_ATTEMPTS_HEADER,
  SERVED_BY_HEADER,
} from "../src/backend.js";
import { resetFacts } from "../src/target-facts.js";
import { resetInterpretations } from "../src/refusal-interpretation.js";
import type { Config, ProviderConfig } from "../src/config.js";

interface StreamFront {
  name: string;
  path: "/v1/messages" | "/v1/chat/completions" | "/v1/responses";
  backendKind: "anthropic" | "openai";
  source: "anthropic" | "chat";
}

const FRONTS: StreamFront[] = [
  { name: "Anthropic Messages", path: "/v1/messages", backendKind: "anthropic", source: "anthropic" },
  { name: "OpenAI Chat Completions", path: "/v1/chat/completions", backendKind: "openai", source: "chat" },
  // An Anthropic source is intentionally translated to Responses SSE so the final-wire probe,
  // rather than the source preflight, sees response.created followed by the test payload.
  { name: "OpenAI Responses", path: "/v1/responses", backendKind: "anthropic", source: "anthropic" },
];

const TRANSLATED_FRONTS: StreamFront[] = [
  { name: "Anthropic Messages", path: "/v1/messages", backendKind: "openai", source: "chat" },
  { name: "OpenAI Responses", path: "/v1/responses", backendKind: "openai", source: "chat" },
];

const servers: Server[] = [];
const breakerIdentity = (provider: string, model: string | null, kind: StreamFront["backendKind"]) => ({
  provider,
  model,
  kind,
  credentialId: makeCredentialId(provider),
});
const tempDirs: string[] = [];
const FLEET_ENV = ["DEFERRED_DEFAULT_KEY", "DEFERRED_WORK_KEY"] as const;
const FLEET_SECRETS = ["deferred-default-secret", "deferred-work-secret"] as const;
let previousFleetEnv = new Map<string, string | undefined>();

function track(server: Server): Server {
  servers.push(server);
  return server;
}

function port(server: Server): number {
  return (server.address() as AddressInfo).port;
}

function listen(server: Server): Promise<Server> {
  return new Promise((resolve) => server.listen(0, "127.0.0.1", () => resolve(track(server))));
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

beforeEach(() => {
  globalCircuitBreaker.reset();
  resetFacts();
  resetInterpretations();
  previousFleetEnv = new Map();
  FLEET_ENV.forEach((name, index) => {
    previousFleetEnv.set(name, process.env[name]);
    process.env[name] = FLEET_SECRETS[index];
  });
});

afterEach(async () => {
  const closing = servers.splice(0);
  for (const server of closing) server.closeAllConnections();
  await Promise.all(closing.map((server) => new Promise<void>((resolve) => server.close(() => resolve()))));
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
  globalCircuitBreaker.reset();
  resetFacts();
  resetInterpretations();
  for (const [name, value] of previousFleetEnv) {
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
  }
  previousFleetEnv.clear();
});

function anthropicEvent(type: string, value: Record<string, unknown>): string {
  return `event: ${type}\ndata: ${JSON.stringify({ type, ...value })}\n\n`;
}

const ANTHROPIC_START = anthropicEvent("message_start", {
  message: { id: "m", type: "message", role: "assistant", model: "m", content: [], usage: { input_tokens: 1, output_tokens: 0 } },
});
const ANTHROPIC_BLOCK_START = anthropicEvent("content_block_start", {
  index: 0,
  content_block: { type: "text", text: "" },
});
const ANTHROPIC_STOP = anthropicEvent("message_stop", {});

function anthropicText(text: string): string {
  return anthropicEvent("content_block_delta", { index: 0, delta: { type: "text_delta", text } });
}

function anthropicError(message: string): string {
  return anthropicEvent("error", { error: { type: "overloaded_error", message } });
}

function chatData(value: unknown): string {
  return `data: ${JSON.stringify(value)}\n\n`;
}

const CHAT_START = chatData({ id: "c", choices: [{ index: 0, delta: { role: "assistant" }, finish_reason: null }] });
const CHAT_STOP = chatData({ id: "c", choices: [{ index: 0, delta: {}, finish_reason: "stop" }] }) + "data: [DONE]\n\n";

function chatText(text: string): string {
  return chatData({ id: "c", choices: [{ index: 0, delta: { content: text }, finish_reason: null }] });
}

function chatError(message: string): string {
  return chatData({ error: { message, type: "server_error" } });
}

function preamble(front: StreamFront): string {
  return front.source === "anthropic" ? ANTHROPIC_START + ANTHROPIC_BLOCK_START : CHAT_START;
}

function content(front: StreamFront, text: string): string {
  return front.source === "anthropic" ? anthropicText(text) : chatText(text);
}

function stop(front: StreamFront): string {
  return front.source === "anthropic" ? ANTHROPIC_STOP : CHAT_STOP;
}

function errorFrame(front: StreamFront, message: string): string {
  return front.source === "anthropic" ? anthropicError(message) : chatError(message);
}

function emptyCompletion(front: StreamFront): string {
  return preamble(front) + stop(front);
}

function validCompletion(front: StreamFront, text = "served-b"): string {
  return preamble(front) + content(front, text) + stop(front);
}

type BackendAction = (response: ServerResponse) => void;

function backend(
  action: BackendAction,
  extraHeaders: Record<string, string | string[]> = {},
): Promise<{ server: Server; calls: () => number }> {
  let calls = 0;
  return listen(createServer((request, response) => {
    response.on("error", () => {});
    request.on("data", () => {});
    request.on("end", () => {
      calls++;
      response.writeHead(200, { "content-type": "text/event-stream", ...extraHeaders });
      action(response);
    });
  })).then((server) => ({ server, calls: () => calls }));
}

/** A genuine provider transport failure: the HTTP response never starts. */
function resettingBackend(): Promise<{ server: Server; calls: () => number }> {
  let calls = 0;
  return listen(createServer((request) => {
    calls++;
    request.socket.destroy();
  })).then((server) => ({ server, calls: () => calls }));
}

function fixed(body: string): BackendAction {
  return (response) => response.end(body);
}

function poolConfig(
  front: StreamFront,
  bases: readonly string[],
  options: {
    timeouts?: readonly number[];
    logFile?: string | null;
    mode?: Config["mode"];
    degraded?: readonly string[];
    candidates?: readonly string[];
  } = {},
): Config {
  const providers: Record<string, ProviderConfig> = {};
  bases.forEach((base, index) => {
    providers[`p${index + 1}`] = {
      base,
      kind: front.backendKind,
      authHeader: front.backendKind === "anthropic" ? "x-api-key" : "authorization",
      timeoutMs: options.timeouts?.[index] ?? 2_000,
      ...(front.backendKind === "anthropic" ? { credentialMode: "contained" as const } : {}),
    };
  });
  return {
    host: "127.0.0.1",
    port: 0,
    providers,
    routing: {
      default: "pool/commit",
      tiers: {},
      benchmarkSort: false,
      pools: { commit: [...(options.candidates ?? bases.map((_, index) => `p${index + 1}/m${index + 1}`))] },
      ...(options.degraded ? { poolDegraded: { commit: [...options.degraded] } } : {}),
    },
    mode: options.mode ?? "detect",
    repair: { maxAttempts: 2, destructiveTools: [] },
    log: options.logFile ? { level: "metadata", file: options.logFile } : { level: "silent", file: null },
  };
}

function enableTwoCredentialFleet(config: Config): Config {
  for (const configured of Object.values(config.providers)) {
    configured.credentialMode = "contained";
    configured.credentials = [
      { label: "default", authEnv: FLEET_ENV[0] },
      { label: "work", authEnv: FLEET_ENV[1] },
    ];
  }
  return config;
}

function requestBody(front: StreamFront, withTools = false): Record<string, unknown> {
  if (front.path === "/v1/messages") {
    return {
      model: "pool/commit",
      stream: true,
      max_tokens: 64,
      messages: [{ role: "user", content: "hi" }],
      ...(withTools ? { tools: [{ name: "write_note", input_schema: { type: "object", properties: { path: { type: "string" } }, required: ["path"] } }] } : {}),
    };
  }
  if (front.path === "/v1/chat/completions") {
    return {
      model: "pool/commit",
      stream: true,
      max_tokens: 64,
      messages: [{ role: "user", content: "hi" }],
      ...(withTools ? { tools: [{ type: "function", function: { name: "write_note", parameters: { type: "object", properties: { path: { type: "string" } }, required: ["path"] } } }] } : {}),
    };
  }
  return {
    model: "pool/commit",
    stream: true,
    max_output_tokens: 64,
    input: [{ role: "user", content: [{ type: "input_text", text: "hi" }] }],
    ...(withTools ? { tools: [{ type: "function", name: "write_note", parameters: { type: "object", properties: { path: { type: "string" } }, required: ["path"] } }] } : {}),
  };
}

function post(front: StreamFront, proxyPort: number, options: { signal?: AbortSignal; tools?: boolean } = {}): Promise<Response> {
  return fetch(`http://127.0.0.1:${proxyPort}${front.path}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(requestBody(front, options.tools ?? false)),
    ...(options.signal ? { signal: options.signal } : {}),
  });
}

async function startProxy(config: Config, breaker: CircuitBreaker = globalCircuitBreaker): Promise<{ server: Server; port: number }> {
  const server = await listen(createProxy(config, {
    breaker,
    catalog: new ModelCatalog({ cachePath: null }),
  }));
  return { server, port: port(server) };
}

function makeLogFile(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  tempDirs.push(dir);
  return join(dir, "relay.jsonl");
}

function logRecords(path: string): Array<Record<string, unknown>> {
  if (!existsSync(path)) return [];
  return readFileSync(path, "utf8").split("\n").filter(Boolean).map((line) => JSON.parse(line) as Record<string, unknown>);
}

describe.each(FRONTS)("$name — deferred header commit", (front) => {
  it("fails over invisibly after protocol preamble followed by an in-band error", async () => {
    const logFile = makeLogFile("rp-commit-error-");
    const a = await backend(fixed(preamble(front) + errorFrame(front, "dead-a")));
    const b = await backend(fixed(validCompletion(front)));
    const breaker = new CircuitBreaker();
    const proxy = await startProxy(enableTwoCredentialFleet(poolConfig(front, [
      `http://127.0.0.1:${port(a.server)}`,
      `http://127.0.0.1:${port(b.server)}`,
    ], { logFile })), breaker);

    const response = await post(front, proxy.port);
    const body = await response.text();
    expect(response.status).toBe(200);
    expect(body).toContain("served-b");
    expect(body).not.toContain("dead-a");
    expect(a.calls()).toBe(1);
    expect(b.calls()).toBe(1);
    expect(response.headers.get(SERVED_BY_HEADER)).toBe("p2/m2");
    expect(response.headers.get(POOL_ATTEMPTS_HEADER)).toBe("2 tried, 1 served: 1x502, 1x200");
    expect(response.headers.get(CREDENTIAL_HEADER)).toBe(makeCredentialId("p2", "default"));
    expect(response.headers.get(CREDENTIAL_ATTEMPTS_HEADER)).toBe(
      "2 tried, 1 served: 1xprotocol",
    );
    expect(breaker.getState(breakerIdentity("p1", "m1", front.backendKind))?.lastStatus).toBe(502);
    expect(logRecords(logFile)[0]?.attempts).toEqual([
      { provider: "p1", model: "m1", status: 502, ms: expect.any(Number) },
      { provider: "p2", model: "m2", status: 200, ms: expect.any(Number) },
    ]);
  });

  it("treats clean termination without content as a retryable empty completion", async () => {
    const a = await backend(fixed(emptyCompletion(front)));
    const b = await backend(fixed(validCompletion(front)));
    const proxy = await startProxy(poolConfig(front, [
      `http://127.0.0.1:${port(a.server)}`,
      `http://127.0.0.1:${port(b.server)}`,
    ]));

    const response = await post(front, proxy.port);
    expect(response.status).toBe(200);
    expect(await response.text()).toContain("served-b");
    expect(a.calls()).toBe(1);
    expect(b.calls()).toBe(1);
    expect(response.headers.get(POOL_ATTEMPTS_HEADER)).toBe("2 tried, 1 served: 1x502, 1x200");
  });

  it("withholds downstream headers until meaningful content exists, then replays the prefix", async () => {
    let release!: () => void;
    let preambleSent!: () => void;
    const sent = new Promise<void>((resolve) => { preambleSent = resolve; });
    const released = new Promise<void>((resolve) => { release = resolve; });
    const a = await backend((response) => {
      response.write(preamble(front));
      preambleSent();
      void released.then(() => response.end(content(front, "released") + stop(front)));
    }, { "x-winner": "yes" });
    const proxy = await startProxy(poolConfig(front, [`http://127.0.0.1:${port(a.server)}`]));

    const responsePromise = post(front, proxy.port);
    await sent;
    const resolvedEarly = await Promise.race([
      responsePromise.then(() => true),
      delay(60).then(() => false),
    ]);
    expect(resolvedEarly).toBe(false); // fetch resolves as soon as downstream headers arrive

    release();
    const response = await responsePromise;
    const body = await response.text();
    if (front.path !== "/v1/responses") expect(response.headers.get("x-winner")).toBe("yes");
    expect(body).toContain("released");
    if (front.path !== "/v1/responses") {
      expect(body.startsWith(preamble(front))).toBe(true); // exact raw prefix replay on native fronts
    } else {
      expect(body).toContain("response.created");
    }
  });

  it("keeps the absolute pre-commit timeout despite periodic heartbeats and fails over", async () => {
    const a = await backend((response) => {
      response.write(preamble(front));
      const heartbeat = front.source === "anthropic" ? anthropicEvent("ping", {}) : ": heartbeat\n\n";
      const timer = setInterval(() => response.write(heartbeat), 15);
      response.on("close", () => clearInterval(timer));
    });
    const b = await backend(fixed(validCompletion(front)));
    const proxy = await startProxy(enableTwoCredentialFleet(poolConfig(front, [
      `http://127.0.0.1:${port(a.server)}`,
      `http://127.0.0.1:${port(b.server)}`,
    ], { timeouts: [100, 1_000] })));

    const started = Date.now();
    const response = await post(front, proxy.port);
    expect(response.status).toBe(200);
    expect(await response.text()).toContain("served-b");
    expect(Date.now() - started).toBeLessThan(1_000);
    expect(a.calls()).toBe(1);
    expect(b.calls()).toBe(1);
    expect(response.headers.get(CREDENTIAL_HEADER)).toBe(makeCredentialId("p2", "default"));
    expect(response.headers.get(CREDENTIAL_ATTEMPTS_HEADER)).toBe(
      "2 tried, 1 served: 1xtimeout",
    );
  });

  it("suppresses the reset provider, counts the transport start, and exposes only winner headers", async () => {
    const a = await resettingBackend();
    const b = await backend(fixed(validCompletion(front)), { "x-winner": "b" });
    const proxy = await startProxy(enableTwoCredentialFleet(poolConfig(front, [
      `http://127.0.0.1:${port(a.server)}`,
      `http://127.0.0.1:${port(b.server)}`,
    ], { candidates: ["p1/m1", "p1/m2", "p2/m3"] })));

    const response = await post(front, proxy.port);
    expect(response.status).toBe(200);
    expect(await response.text()).toContain("served-b");
    expect(a.calls()).toBe(1);
    expect(b.calls()).toBe(1);
    expect(response.headers.get("x-rejected")).toBeNull();
    if (front.path !== "/v1/responses") expect(response.headers.get("x-winner")).toBe("b");
    expect(response.headers.get(SERVED_BY_HEADER)).toBe("p2/m3");
    expect(response.headers.get(POOL_ATTEMPTS_HEADER)).toBe("2 tried, 1 served: 1x502, 1x200");
    expect(response.headers.get(CREDENTIAL_HEADER)).toBe(makeCredentialId("p2", "default"));
    expect(response.headers.get(CREDENTIAL_ATTEMPTS_HEADER)).toBe(
      "2 tried, 1 served: 1xtransport",
    );
  });

  it("never starts another candidate after a client disconnect during the provisional preamble", async () => {
    let preambleSent!: () => void;
    const sent = new Promise<void>((resolve) => { preambleSent = resolve; });
    const a = await backend((response) => {
      response.write(preamble(front));
      preambleSent();
    });
    const b = await backend(fixed(validCompletion(front)));
    const breaker = new CircuitBreaker();
    const logFile = makeLogFile("rp-commit-cancel-");
    const proxy = await startProxy(poolConfig(front, [
      `http://127.0.0.1:${port(a.server)}`,
      `http://127.0.0.1:${port(b.server)}`,
    ], { logFile }), breaker);
    const controller = new AbortController();

    const pending = post(front, proxy.port, { signal: controller.signal }).catch(() => null);
    await sent;
    controller.abort();
    await pending;
    await delay(60);

    expect(b.calls()).toBe(0);
    expect(breaker.getState(breakerIdentity("p1", "m1", front.backendKind))).toBeUndefined();
    expect(logRecords(logFile)).toEqual([]);
  });
});

describe("post-commit failure honesty", () => {
  it.each(FRONTS)("$name forwards a later error and never replays on another candidate", async (front) => {
    const a = await backend(fixed(validCompletion(front, "served-a").replace(stop(front), errorFrame(front, "late-error"))));
    const b = await backend(fixed(validCompletion(front, "served-b")));
    const proxy = await startProxy(poolConfig(front, [
      `http://127.0.0.1:${port(a.server)}`,
      `http://127.0.0.1:${port(b.server)}`,
    ]));

    const response = await post(front, proxy.port);
    const body = await response.text();
    expect(response.status).toBe(200);
    expect(body).toContain("served-a");
    expect(body).toContain("late-error");
    expect(b.calls()).toBe(0);
  });

  it.each(FRONTS)("$name does not fail over after content followed by a socket reset", async (front) => {
    const a = await backend((response) => {
      response.write(preamble(front) + content(front, "served-a"));
      setTimeout(() => response.socket?.destroy(), 15);
    });
    const b = await backend(fixed(validCompletion(front, "served-b")));
    const proxy = await startProxy(poolConfig(front, [
      `http://127.0.0.1:${port(a.server)}`,
      `http://127.0.0.1:${port(b.server)}`,
    ]));

    const response = await post(front, proxy.port);
    const body = await response.text();
    expect(response.status).toBe(200);
    expect(body).toContain("served-a");
    expect(body).toMatch(/error|failed/i);
    expect(b.calls()).toBe(0);
  });
});

describe("pre-commit silence", () => {
  it("uses timeoutMs through first meaningful content and then fails over", async () => {
    const front = FRONTS[0]!;
    const a = await backend((response) => response.write(preamble(front)));
    const b = await backend(fixed(validCompletion(front)));
    const proxy = await startProxy(poolConfig(front, [
      `http://127.0.0.1:${port(a.server)}`,
      `http://127.0.0.1:${port(b.server)}`,
    ], { timeouts: [80, 1_000] }));

    const response = await post(front, proxy.port);
    expect(response.status).toBe(200);
    expect(await response.text()).toContain("served-b");
    expect(a.calls()).toBe(1);
    expect(b.calls()).toBe(1);
  });
});

describe("translated seams before final-wire commit", () => {
  it.each(TRANSLATED_FRONTS)("$name treats an entirely stripped opening think block as an empty completion", async (front) => {
    const a = await backend(fixed(CHAT_START + chatText("<think>private reasoning</think>") + CHAT_STOP));
    const b = await backend(fixed(CHAT_START + chatText("served-b") + CHAT_STOP));
    const proxy = await startProxy(poolConfig(front, [
      `http://127.0.0.1:${port(a.server)}`,
      `http://127.0.0.1:${port(b.server)}`,
    ]));

    const response = await post(front, proxy.port);
    const body = await response.text();
    expect(response.status).toBe(200);
    expect(body).toContain("served-b");
    expect(body).not.toContain("private reasoning");
    expect(a.calls()).toBe(1);
    expect(b.calls()).toBe(1);
    expect(response.headers.get(POOL_ATTEMPTS_HEADER)).toBe("2 tried, 1 served: 1x502, 1x200");
  });

  it.each(TRANSLATED_FRONTS)("$name fails over a truncated dialect envelope before commit", async (front) => {
    const truncated = '<｜DSML｜tool_calls><｜DSML｜invoke name="write_note"><｜DSML｜parameter name="path">a.txt';
    const a = await backend(fixed(CHAT_START + chatText(truncated) + CHAT_STOP));
    const b = await backend(fixed(CHAT_START + chatText("served-b") + CHAT_STOP));
    const proxy = await startProxy(poolConfig(front, [
      `http://127.0.0.1:${port(a.server)}`,
      `http://127.0.0.1:${port(b.server)}`,
    ]));

    const response = await post(front, proxy.port, { tools: true });
    const body = await response.text();
    expect(response.status).toBe(200);
    expect(body).toContain("served-b");
    expect(body).not.toContain("DSML");
    expect(b.calls()).toBe(1);
  });

  it.each(TRANSLATED_FRONTS)("$name commits a valid recovered dialect tool call", async (front) => {
    const dialect =
      '<｜DSML｜tool_calls><｜DSML｜invoke name="write_note">' +
      '<｜DSML｜parameter name="path">a.txt</｜DSML｜parameter>' +
      '</｜DSML｜invoke></｜DSML｜tool_calls>';
    const a = await backend(fixed(CHAT_START + chatText(dialect) + CHAT_STOP));
    const b = await backend(fixed(CHAT_START + chatText("served-b") + CHAT_STOP));
    const proxy = await startProxy(poolConfig(front, [
      `http://127.0.0.1:${port(a.server)}`,
      `http://127.0.0.1:${port(b.server)}`,
    ]));

    const response = await post(front, proxy.port, { tools: true });
    const body = await response.text();
    expect(response.status).toBe(200);
    expect(body).not.toContain("DSML");
    expect(body).toMatch(/tool_use|function_call/);
    expect(b.calls()).toBe(0);
  });
});

describe("winner-only response header provenance", () => {
  it.each(["detect", "repair"] as const)("Anthropic %s mode exposes only B's headers and routing metadata", async (mode) => {
    const front = FRONTS[0]!;
    const a = await backend(
      fixed(preamble(front) + errorFrame(front, "dead-a")),
      { "x-rejected": "a", "set-cookie": "rejected=a; Path=/" },
    );
    const b = await backend(
      fixed(validCompletion(front)),
      { "x-winner": "b", "set-cookie": "winner=b; Path=/" },
    );
    const config = poolConfig(front, [
      `http://127.0.0.1:${port(a.server)}`,
      `http://127.0.0.1:${port(b.server)}`,
    ], { mode, degraded: ["p2/m2"] });
    if (mode === "repair") {
      config.reshaper = { base: "http://127.0.0.1:1", kind: "openai", model: "unused", authHeader: "authorization", timeoutMs: 100 };
    }
    const proxy = await startProxy(config);

    const response = await post(front, proxy.port, { tools: mode === "repair" });
    expect(response.status).toBe(200);
    await response.text();
    expect(response.headers.get("x-rejected")).toBeNull();
    expect(response.headers.get("x-winner")).toBe("b");
    expect(response.headers.get("set-cookie")).toContain("winner=b");
    expect(response.headers.get("set-cookie")).not.toContain("rejected=a");
    expect(response.headers.get(SERVED_BY_HEADER)).toBe("p2/m2");
    expect(response.headers.get(DEGRADED_HEADER)).toBe("p2/m2 (below commit)");
    // Anthropic-kind targets represent caller-owned subscription traffic, not catalogued API
    // pricing, so the paid marker is deliberately absent on this front.
    expect(response.headers.get(PAID_HEADER)).toBeNull();
    expect(response.headers.get(POOL_ATTEMPTS_HEADER)).toBe("2 tried, 1 served: 1x502, 1x200");
  });

  it("OpenAI Chat exposes B's paid marker and never A's upstream headers", async () => {
    const front = FRONTS[1]!;
    const a = await backend(
      fixed(preamble(front) + errorFrame(front, "dead-a")),
      { "x-rejected": "a", "set-cookie": "rejected=a; Path=/" },
    );
    const b = await backend(
      fixed(validCompletion(front)),
      { "x-winner": "b", "set-cookie": "winner=b; Path=/" },
    );
    const proxy = await startProxy(poolConfig(front, [
      `http://127.0.0.1:${port(a.server)}`,
      `http://127.0.0.1:${port(b.server)}`,
    ], { degraded: ["p2/m2"] }));

    const response = await post(front, proxy.port);
    await response.text();
    expect(response.headers.get("x-rejected")).toBeNull();
    expect(response.headers.get("x-winner")).toBe("b");
    expect(response.headers.get("set-cookie")).toContain("winner=b");
    expect(response.headers.get("set-cookie")).not.toContain("rejected=a");
    expect(response.headers.get(SERVED_BY_HEADER)).toBe("p2/m2");
    expect(response.headers.get(DEGRADED_HEADER)).toBe("p2/m2 (below commit)");
    expect(response.headers.get(PAID_HEADER)).toBe("p2/m2 (unknown, unpublished)");
    expect(response.headers.get(POOL_ATTEMPTS_HEADER)).toBe("2 tried, 1 served: 1x502, 1x200");
  });
});
