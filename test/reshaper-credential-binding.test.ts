import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { createServer, type IncomingMessage, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import { createProxy } from "../src/server.js";
import { ModelCatalog } from "../src/catalog.js";
import { globalCircuitBreaker } from "../src/circuit-breaker.js";
import { addEntry, lock, resolveKeystorePath } from "../src/keystore.js";
import { resetFacts } from "../src/target-facts.js";
import { resetInterpretations } from "../src/refusal-interpretation.js";
import type { Config, ProviderConfig, ReshaperConfig } from "../src/config.js";

const ENV_KEYS = [
  "RESHAPER_BIND_MESSAGES_A",
  "RESHAPER_BIND_MESSAGES_B",
  "RESHAPER_BIND_OPENAI_A",
  "RESHAPER_BIND_OPENAI_B",
  "RESHAPER_BIND_GLOBAL",
  "RESHAPER_BIND_STATIC_A1",
  "RESHAPER_BIND_STATIC_A2",
  "RESHAPER_BIND_STATIC_B1",
  "RESHAPER_BIND_STATIC_B2",
  "RESHAPER_BIND_TRANSPORT_1",
  "RESHAPER_BIND_TRANSPORT_2",
  "RESHAPER_BIND_SEMANTIC_1",
  "RESHAPER_BIND_SEMANTIC_2",
  "RESHAPER_BIND_BODY_1",
  "RESHAPER_BIND_BODY_2",
  "RESHAPER_BIND_REFUSAL_A1",
  "RESHAPER_BIND_REFUSAL_A2",
  "RESHAPER_BIND_REFUSAL_B1",
  "RESHAPER_BIND_REFUSAL_B2",
  "RESHAPER_BIND_COLLAPSED_1",
  "RESHAPER_BIND_COLLAPSED_2",
  "RESHAPER_BIND_DYNAMIC_1",
  "RESHAPER_BIND_DYNAMIC_2",
] as const;

const servers: Server[] = [];
let savedEnv: Record<string, string | undefined> = {};
let logDir: string;
let logFile: string;

beforeEach(() => {
  globalCircuitBreaker.reset();
  resetFacts();
  resetInterpretations();
  logDir = mkdtempSync(join(tmpdir(), "relay-reshaper-binding-"));
  logFile = join(logDir, "metadata.jsonl");
  savedEnv = {};
  for (const key of ENV_KEYS) {
    savedEnv[key] = process.env[key];
    delete process.env[key];
  }
});

afterEach(async () => {
  for (const key of ENV_KEYS) {
    const value = savedEnv[key];
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  const closing = servers.splice(0);
  for (const server of closing) server.closeAllConnections();
  await Promise.all(closing.map((server) => new Promise<void>((resolve) => server.close(() => resolve()))));
  rmSync(logDir, { recursive: true, force: true });
  globalCircuitBreaker.reset();
  resetFacts();
  resetInterpretations();
});

function listen(server: Server): Promise<Server> {
  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      servers.push(server);
      resolve(server);
    });
  });
}

function port(server: Server): number {
  return (server.address() as AddressInfo).port;
}

function base(server: Server): string {
  return `http://127.0.0.1:${port(server)}`;
}

function authorization(req: IncomingMessage): string | undefined {
  const value = req.headers.authorization;
  return Array.isArray(value) ? value[0] : value;
}

interface JsonReply {
  status?: number;
  body?: unknown;
  destroy?: boolean;
}

function jsonServer(
  handler: (req: IncomingMessage, body: Record<string, unknown>) => JsonReply,
): Promise<Server> {
  return listen(createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (chunk) => chunks.push(chunk));
    req.on("end", () => {
      const text = Buffer.concat(chunks).toString("utf8");
      const body = text ? JSON.parse(text) as Record<string, unknown> : {};
      const reply = handler(req, body);
      if (reply.destroy) {
        req.socket.destroy();
        return;
      }
      res.writeHead(reply.status ?? 200, { "content-type": "application/json" });
      res.end(typeof reply.body === "string" ? reply.body : JSON.stringify(reply.body ?? {}));
    });
  }));
}

function corrected(id = "t1"): Record<string, unknown> {
  return {
    choices: [{
      message: {
        content: JSON.stringify({ inputs: { [id]: { city: "Paris" } } }),
      },
    }],
  };
}

function malformedOpenAiToolCall(): Record<string, unknown> {
  return {
    id: "chatcmpl_bad",
    model: "served-model",
    choices: [{
      index: 0,
      finish_reason: "tool_calls",
      message: {
        role: "assistant",
        content: null,
        tool_calls: [{
          id: "t1",
          type: "function",
          function: { name: "get_weather", arguments: "{}" },
        }],
      },
    }],
  };
}

function malformedAnthropicToolCall(): Record<string, unknown> {
  return {
    id: "msg_bad",
    type: "message",
    role: "assistant",
    model: "main-model",
    stop_reason: "tool_use",
    content: [{ type: "tool_use", id: "t1", name: "get_weather", input: {} }],
  };
}

async function badMessagesBackend(): Promise<Server> {
  return jsonServer(() => ({ body: malformedAnthropicToolCall() }));
}

function mainProvider(server: Server): ProviderConfig {
  return {
    base: base(server),
    kind: "anthropic",
    credentialMode: "contained",
    authHeader: "x-api-key",
    timeoutMs: 2_000,
  };
}

function fleetProvider(server: Server, firstEnv: string, secondEnv: string): ProviderConfig {
  return {
    base: base(server),
    kind: "openai",
    credentials: [
      { label: "first", authEnv: firstEnv },
      { label: "second", authEnv: secondEnv },
    ],
    authHeader: "authorization",
    timeoutMs: 2_000,
  };
}

function candidate(provider: string, server: Server, model: string): ReshaperConfig {
  return {
    provider,
    base: base(server),
    model,
    kind: "openai",
    authHeader: "authorization",
    timeoutMs: 2_000,
  };
}

function repairConfig(main: Server): Config {
  return {
    host: "127.0.0.1",
    port: 0,
    providers: { main: mainProvider(main) },
    routing: { default: "main", tiers: {}, benchmarkSort: false },
    mode: "repair",
    repair: { maxAttempts: 2, destructiveTools: [] },
    log: { level: "silent", file: null },
  };
}

async function startTestProxy(cfg: Config, catalog = new ModelCatalog({ cachePath: null })): Promise<Server> {
  return listen(createProxy(cfg, { breaker: globalCircuitBreaker, catalog }));
}

const anthropicTools = [{
  name: "get_weather",
  input_schema: {
    type: "object",
    properties: { city: { type: "string" } },
    required: ["city"],
  },
}];

async function sendMessages(proxy: Server): Promise<{ response: Response; body: any }> {
  const response = await fetch(`${base(proxy)}/v1/messages`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      model: "main-model",
      messages: [{ role: "user", content: "weather?" }],
      tools: anthropicTools,
    }),
  });
  const body = await response.json();
  return { response, body };
}

function expectRepairedMessage(result: { response: Response; body: any }): void {
  expect(result.response.status).toBe(200);
  expect(result.body.content.find((block: any) => block.type === "tool_use")?.input).toEqual({ city: "Paris" });
}

function metadataLines(): Array<Record<string, unknown>> {
  return readFileSync(logFile, "utf8")
    .trim()
    .split(/\r?\n/)
    .filter(Boolean)
    .map((line) => JSON.parse(line) as Record<string, unknown>);
}

const KEYSTORE_GLOBAL_ENV = "RESHAPER_BIND_KEYSTORE_GLOBAL";
const KEYSTORE_PROVIDER_ENV = "RESHAPER_BIND_KEYSTORE_PROVIDER";
const KEYSTORE_PASSPHRASE = "reshaper binding test passphrase";

function removeWorkerDefaultKeystore(path: string): void {
  const parent = dirname(path);
  if (
    path !== resolveKeystorePath()
    || dirname(parent) !== tmpdir()
    || !basename(parent).startsWith(`llm-relay-test-keystore-${process.pid}-`)
  ) {
    throw new Error("refusing to remove a non-worker keystore path");
  }
  rmSync(parent, { recursive: true, force: true });
}

describe("reshaper credential binding", () => {
  describe("keystore-backed reshaper custody", () => {
    const envNames = [KEYSTORE_GLOBAL_ENV, KEYSTORE_PROVIDER_ENV] as const;
    const originalEnv = new Map<string, string | undefined>();
    const path = resolveKeystorePath();
    const storeOptions = {
      path,
      mode: "passphrase" as const,
      passphrase: KEYSTORE_PASSPHRASE,
    };

    beforeEach(() => {
      for (const name of envNames) {
        originalEnv.set(name, process.env[name]);
        delete process.env[name];
      }
      lock({ path });
      removeWorkerDefaultKeystore(path);
    });

    afterEach(() => {
      lock({ path });
      removeWorkerDefaultKeystore(path);
      for (const name of envNames) {
        const value = originalEnv.get(name);
        if (value === undefined) delete process.env[name];
        else process.env[name] = value;
      }
      originalEnv.clear();
    });

    it("repairs through a keystore-only standalone reshaper without mutating process.env", async () => {
      const storedValue = "standalone-keystore-test-credential";
      const main = await badMessagesBackend();
      const seen: Array<{ auth: string; model: string }> = [];
      const reshaper = await jsonServer((req, body) => {
        seen.push({
          auth: authorization(req) ?? "<none>",
          model: String(body.model),
        });
        return { body: corrected() };
      });
      addEntry({
        id: "reshaper-global#stored",
        provider: "reshaper-global",
        envName: KEYSTORE_GLOBAL_ENV,
        value: storedValue,
      }, storeOptions);

      const cfg = repairConfig(main);
      cfg.reshaper = {
        base: base(reshaper),
        model: "repair-model",
        kind: "openai",
        authEnv: KEYSTORE_GLOBAL_ENV,
        authHeader: "authorization",
        timeoutMs: 2_000,
      };
      const proxy = await startTestProxy(cfg);

      expectRepairedMessage(await sendMessages(proxy));
      expect(seen).toEqual([{
        auth: `Bearer ${storedValue}`,
        model: "repair-model",
      }]);
      expect(process.env[KEYSTORE_GLOBAL_ENV]).toBeUndefined();
    });

    it("shares one keystore-only legacy credential between serving and provider-backed reshaping in the same request", async () => {
      const storedValue = "shared-keystore-test-credential";
      const seen: Array<{ auth: string; model: string }> = [];
      const backend = await jsonServer((req, body) => {
        const model = String(body.model);
        seen.push({ auth: authorization(req) ?? "<none>", model });
        return model === "served-model"
          ? { body: malformedOpenAiToolCall() }
          : { body: corrected() };
      });
      addEntry({
        id: "stored-provenance#repair",
        provider: "stored-provenance",
        envName: KEYSTORE_PROVIDER_ENV,
        value: storedValue,
      }, storeOptions);

      const provider: ProviderConfig = {
        base: base(backend),
        kind: "openai",
        credentialMode: "contained",
        authEnv: KEYSTORE_PROVIDER_ENV,
        authHeader: "authorization",
        timeoutMs: 2_000,
      };
      const cfg: Config = {
        ...repairConfig(backend),
        providers: { work: provider },
        routing: { default: "work/served-model", tiers: {}, benchmarkSort: false },
      };
      cfg.reshaper = candidate("work", backend, "repair-model");
      const proxy = await startTestProxy(cfg);

      expectRepairedMessage(await sendMessages(proxy));
      expect(seen).toEqual([
        { auth: `Bearer ${storedValue}`, model: "served-model" },
        { auth: `Bearer ${storedValue}`, model: "repair-model" },
      ]);
      expect(process.env[KEYSTORE_PROVIDER_ENV]).toBeUndefined();
    });
  });

  it("reuses the exact Messages-front attempt credential and rotates A/A then B/B", async () => {
    process.env.RESHAPER_BIND_MESSAGES_A = "messages-a";
    process.env.RESHAPER_BIND_MESSAGES_B = "messages-b";
    const seen: string[] = [];
    const backend = await jsonServer((req, body) => {
      seen.push(authorization(req) ?? "<none>");
      return Array.isArray(body.tools)
        ? { body: malformedOpenAiToolCall() }
        : { body: corrected() };
    });
    const cfg: Config = {
      ...repairConfig(backend),
      providers: {
        work: fleetProvider(backend, "RESHAPER_BIND_MESSAGES_A", "RESHAPER_BIND_MESSAGES_B"),
      },
      routing: { default: "work/served-model", tiers: {}, benchmarkSort: false },
    };
    cfg.log = { level: "metadata", file: logFile };
    const proxy = await startTestProxy(cfg);

    expectRepairedMessage(await sendMessages(proxy));
    expectRepairedMessage(await sendMessages(proxy));
    expect(seen).toEqual([
      "Bearer messages-a",
      "Bearer messages-a",
      "Bearer messages-b",
      "Bearer messages-b",
    ]);
    const rawLog = readFileSync(logFile, "utf8");
    expect(rawLog).not.toContain("messages-a");
    expect(rawLog).not.toContain("messages-b");
    expect(metadataLines().map((line) => line["servedCredential"])).toEqual([
      "work#first",
      "work#second",
    ]);
  });

  it("reuses the exact recovered-OpenAI attempt credential and rotates A/A then B/B", async () => {
    process.env.RESHAPER_BIND_OPENAI_A = "openai-a";
    process.env.RESHAPER_BIND_OPENAI_B = "openai-b";
    const seen: string[] = [];
    const dialect =
      '<｜DSML｜tool_calls><｜DSML｜invoke name="get_weather">' +
      '</｜DSML｜invoke></｜DSML｜tool_calls>';
    const backend = await jsonServer((req, body) => {
      seen.push(authorization(req) ?? "<none>");
      if (Array.isArray(body.tools)) {
        return {
          body: {
            id: "chatcmpl_dialect",
            model: "served-model",
            choices: [{
              index: 0,
              message: { role: "assistant", content: dialect },
              finish_reason: "stop",
            }],
          },
        };
      }
      return { body: corrected("call_recovered_0_0") };
    });
    const cfg: Config = {
      ...repairConfig(backend),
      providers: {
        work: fleetProvider(backend, "RESHAPER_BIND_OPENAI_A", "RESHAPER_BIND_OPENAI_B"),
      },
      routing: { default: "work/served-model", tiers: {}, benchmarkSort: false },
    };
    const proxy = await startTestProxy(cfg);

    for (let i = 0; i < 2; i++) {
      const response = await fetch(`${base(proxy)}/v1/chat/completions`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          model: "work/served-model",
          messages: [{ role: "user", content: "weather?" }],
          tools: [{
            type: "function",
            function: {
              name: "get_weather",
              parameters: {
                type: "object",
                properties: { city: { type: "string" } },
                required: ["city"],
              },
            },
          }],
        }),
      });
      const body = await response.json() as any;
      expect(response.status).toBe(200);
      expect(JSON.parse(body.choices[0].message.tool_calls[0].function.arguments)).toEqual({ city: "Paris" });
    }
    expect(seen).toEqual([
      "Bearer openai-a",
      "Bearer openai-a",
      "Bearer openai-b",
      "Bearer openai-b",
    ]);
  });

  it("resolves a standalone global reshaper credential per request and never egresses declared-missing", async () => {
    const main = await badMessagesBackend();
    const seen: string[] = [];
    const reshaper = await jsonServer((req) => {
      seen.push(authorization(req) ?? "<none>");
      return { body: corrected() };
    });
    process.env.RESHAPER_BIND_GLOBAL = "global-first";
    const cfg = repairConfig(main);
    cfg.reshaper = {
      base: base(reshaper),
      model: "repair-model",
      kind: "openai",
      authEnv: "RESHAPER_BIND_GLOBAL",
      authHeader: "authorization",
      timeoutMs: 2_000,
    };
    const proxy = await startTestProxy(cfg);

    expectRepairedMessage(await sendMessages(proxy));
    process.env.RESHAPER_BIND_GLOBAL = "global-second";
    expectRepairedMessage(await sendMessages(proxy));
    delete process.env.RESHAPER_BIND_GLOBAL;
    const missing = await sendMessages(proxy);

    expect(missing.response.status).toBe(502);
    expect(seen).toEqual(["Bearer global-first", "Bearer global-second"]);
  });

  it("walks a static provider-backed pool breadth-first and closes only the 503 deployment", async () => {
    process.env.RESHAPER_BIND_STATIC_A1 = "static-a1";
    process.env.RESHAPER_BIND_STATIC_A2 = "static-a2";
    process.env.RESHAPER_BIND_STATIC_B1 = "static-b1";
    process.env.RESHAPER_BIND_STATIC_B2 = "static-b2";
    const events: string[] = [];
    const repairA = await jsonServer((req) => {
      const auth = authorization(req) ?? "<none>";
      events.push(`a:${auth}`);
      return auth === "Bearer static-a1"
        ? { status: 401, body: { error: { message: "credential rejected" } } }
        : { body: corrected() };
    });
    const repairB = await jsonServer((req) => {
      const auth = authorization(req) ?? "<none>";
      events.push(`b:${auth}`);
      return auth === "Bearer static-b1"
        ? { status: 503, body: { error: { message: "deployment unavailable" } } }
        : { body: corrected() };
    });
    const main = await badMessagesBackend();
    const cfg = repairConfig(main);
    cfg.providers.repairA = fleetProvider(repairA, "RESHAPER_BIND_STATIC_A1", "RESHAPER_BIND_STATIC_A2");
    cfg.providers.repairB = fleetProvider(repairB, "RESHAPER_BIND_STATIC_B1", "RESHAPER_BIND_STATIC_B2");
    cfg.reshaperCandidates = [
      candidate("repairA", repairA, "repair-a"),
      candidate("repairB", repairB, "repair-b"),
    ];
    const proxy = await startTestProxy(cfg);

    expectRepairedMessage(await sendMessages(proxy));
    expect(events).toEqual([
      "a:Bearer static-a1",
      "b:Bearer static-b1",
      "a:Bearer static-a2",
    ]);
  });

  it("keeps reached credential pinned across semantic repair retries", async () => {
    process.env.RESHAPER_BIND_SEMANTIC_1 = "semantic-one";
    process.env.RESHAPER_BIND_SEMANTIC_2 = "semantic-two";
    const events: string[] = [];
    let calls = 0;
    const reshaper = await jsonServer((req) => {
      events.push(authorization(req) ?? "<none>");
      calls++;
      return {
        body: calls === 1
          ? {
              choices: [{
                message: {
                  // Wire-valid reshaper output, but still invalid: required `city` is absent.
                  content: JSON.stringify({ inputs: { t1: {} } }),
                },
              }],
            }
          : corrected(),
      };
    });
    const main = await badMessagesBackend();
    const cfg = repairConfig(main);
    cfg.providers.repair = fleetProvider(
      reshaper,
      "RESHAPER_BIND_SEMANTIC_1",
      "RESHAPER_BIND_SEMANTIC_2",
    );
    cfg.reshaper = candidate("repair", reshaper, "repair-model");
    const proxy = await startTestProxy(cfg);

    expectRepairedMessage(await sendMessages(proxy));
    expect(events).toEqual(["Bearer semantic-one", "Bearer semantic-one"]);
  });

  it("suppresses every same-provider deployment and credential after provider transport failure", async () => {
    process.env.RESHAPER_BIND_TRANSPORT_1 = "transport-1";
    process.env.RESHAPER_BIND_TRANSPORT_2 = "transport-2";
    const events: string[] = [];
    const repair = await jsonServer((req, body) => {
      events.push(`${String(body.model)}:${authorization(req) ?? "<none>"}`);
      return { destroy: true };
    });
    const main = await badMessagesBackend();
    const cfg = repairConfig(main);
    cfg.providers.repair = fleetProvider(repair, "RESHAPER_BIND_TRANSPORT_1", "RESHAPER_BIND_TRANSPORT_2");
    cfg.reshaperCandidates = [
      candidate("repair", repair, "repair-one"),
      candidate("repair", repair, "repair-two"),
    ];
    const proxy = await startTestProxy(cfg);

    const result = await sendMessages(proxy);
    expect(result.response.status).toBe(502);
    expect(events).toEqual(["repair-one:Bearer transport-1"]);
  });

  it("scopes a post-header parse/body failure to the failed deployment", async () => {
    process.env.RESHAPER_BIND_BODY_1 = "body-one";
    process.env.RESHAPER_BIND_BODY_2 = "body-two";
    const events: string[] = [];
    const repair = await listen(createServer((req, res) => {
      const chunks: Buffer[] = [];
      req.on("data", (chunk) => chunks.push(chunk));
      req.on("end", () => {
        const body = JSON.parse(Buffer.concat(chunks).toString("utf8")) as Record<string, unknown>;
        events.push(`${String(body.model)}:${authorization(req) ?? "<none>"}`);
        // Make fetch() observe a successful response before its body reader sees transport loss.
 if (body.model === "repair-one") {
 res.writeHead(200, {
          "content-type": "application/json",
          "content-length": "512",
        });
        res.flushHeaders();
        res.write('{"choices":[{"message":{"content":"');
 setTimeout(() => res.destroy(), 5);
 return;
 }
 res.writeHead(200, { "content-type": "application/json" });
 res.end(JSON.stringify(corrected()));
      });
    }));
    const main = await badMessagesBackend();
    const cfg = repairConfig(main);
    cfg.providers.repair = fleetProvider(repair, "RESHAPER_BIND_BODY_1", "RESHAPER_BIND_BODY_2");
    cfg.reshaperCandidates = [
      candidate("repair", repair, "repair-one"),
      candidate("repair", repair, "repair-two"),
    ];
    const proxy = await startTestProxy(cfg);

    const result = await sendMessages(proxy);
 expectRepairedMessage(result);
 expect(events).toEqual(["repair-one:Bearer body-one", "repair-two:Bearer body-one"]);
  });

  it("treats an explicit model refusal as terminal across deployments and credentials", async () => {
    process.env.RESHAPER_BIND_REFUSAL_A1 = "refusal-a1";
    process.env.RESHAPER_BIND_REFUSAL_A2 = "refusal-a2";
    process.env.RESHAPER_BIND_REFUSAL_B1 = "refusal-b1";
    process.env.RESHAPER_BIND_REFUSAL_B2 = "refusal-b2";
    const events: string[] = [];
    const repairA = await jsonServer((req) => {
      events.push(`a:${authorization(req) ?? "<none>"}`);
      return {
        body: {
          choices: [{ message: { content: JSON.stringify({ refuse: true, reason: "ambiguous" }) } }],
        },
      };
    });
    const repairB = await jsonServer((req) => {
      events.push(`b:${authorization(req) ?? "<none>"}`);
      return { body: corrected() };
    });
    const main = await badMessagesBackend();
    const cfg = repairConfig(main);
    cfg.providers.repairA = fleetProvider(repairA, "RESHAPER_BIND_REFUSAL_A1", "RESHAPER_BIND_REFUSAL_A2");
    cfg.providers.repairB = fleetProvider(repairB, "RESHAPER_BIND_REFUSAL_B1", "RESHAPER_BIND_REFUSAL_B2");
    cfg.reshaperCandidates = [
      candidate("repairA", repairA, "repair-a"),
      candidate("repairB", repairB, "repair-b"),
    ];
    cfg.log = { level: "metadata", file: logFile };
    const proxy = await startTestProxy(cfg);

    const result = await sendMessages(proxy);
    expect(result.response.status).toBe(502);
    expect(events).toEqual(["a:Bearer refusal-a1"]);
    const rawLog = readFileSync(logFile, "utf8");
    for (const secret of ["refusal-a1", "refusal-a2", "refusal-b1", "refusal-b2"]) {
      expect(rawLog).not.toContain(secret);
    }
    expect(metadataLines().map((line) => line["servedCredential"])).toEqual([null]);
  });

  it("rehydrates every credential slot from the collapsed one-member static-pool representation", async () => {
    process.env.RESHAPER_BIND_COLLAPSED_1 = "collapsed-1";
    process.env.RESHAPER_BIND_COLLAPSED_2 = "collapsed-2";
    const events: string[] = [];
    const repair = await jsonServer((req) => {
      const auth = authorization(req) ?? "<none>";
      events.push(auth);
      return auth === "Bearer collapsed-1"
        ? { status: 401, body: { error: { message: "credential rejected" } } }
        : { body: corrected() };
    });
    const main = await badMessagesBackend();
    const cfg = repairConfig(main);
    cfg.providers.repair = fleetProvider(repair, "RESHAPER_BIND_COLLAPSED_1", "RESHAPER_BIND_COLLAPSED_2");
    cfg.reshaper = candidate("repair", repair, "repair-only");
    const proxy = await startTestProxy(cfg);

    expectRepairedMessage(await sendMessages(proxy));
    expect(events).toEqual(["Bearer collapsed-1", "Bearer collapsed-2"]);
  });

  it("re-expands a catalog-backed dynamic fleet at each repair decision", async () => {
    process.env.RESHAPER_BIND_DYNAMIC_1 = "dynamic-first";
    const events: Array<{ auth: string; model: string }> = [];
    const repair = await jsonServer((req, body) => {
      events.push({
        auth: authorization(req) ?? "<none>",
        model: String(body.model),
      });
      return { body: corrected() };
    });
    const main = await badMessagesBackend();
    const dynamicProvider = fleetProvider(
      repair,
      "RESHAPER_BIND_DYNAMIC_1",
      "RESHAPER_BIND_DYNAMIC_2",
    );
    dynamicProvider.tierType = "free";
    const catalog = new ModelCatalog({ cachePath: null });
    await catalog.list("dynamic", dynamicProvider, {
      fetchFn: async () => new Response(JSON.stringify({
        data: [{ id: "dynamic-one" }, { id: "dynamic-two" }],
      }), { status: 200 }),
    });
    const cfg = repairConfig(main);
    cfg.providers.dynamic = dynamicProvider;
    cfg.routing.pools = { repair: [] };
    cfg.routing.poolPolicies = { repair: { preferred: [], include: "free" } };
    cfg.reshaperPool = { name: "repair", timeoutMs: 2_000 };
    const proxy = await startTestProxy(cfg, catalog);

    expectRepairedMessage(await sendMessages(proxy));
    delete process.env.RESHAPER_BIND_DYNAMIC_1;
    process.env.RESHAPER_BIND_DYNAMIC_2 = "dynamic-second";
    expectRepairedMessage(await sendMessages(proxy));

    expect(events.map((event) => event.auth)).toEqual([
      "Bearer dynamic-first",
      "Bearer dynamic-second",
    ]);
    expect(new Set(events.map((event) => event.model))).toEqual(new Set(["dynamic-one"]));
  });
});
