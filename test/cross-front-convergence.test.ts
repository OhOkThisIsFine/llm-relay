import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { createProxy } from "../src/server.js";
import { ModelCatalog } from "../src/catalog.js";
import { globalCircuitBreaker } from "../src/circuit-breaker.js";
import { DEGRADED_HEADER, POOL_ATTEMPTS_HEADER } from "../src/backend.js";
import { resetFacts } from "../src/target-facts.js";
import { resetInterpretations } from "../src/refusal-interpretation.js";
import { materializeDynamicPools } from "../src/dynamic-pools.js";
import type { Config, ProviderConfig, ProviderTierType } from "../src/config.js";
import type { TierData, TierModel } from "../src/tier-data.js";

/**
 * One policy matrix, driven through every public request shape.
 *
 * The suite deliberately uses real loopback HTTP servers and at least two candidates for every
 * failover row. A one-member "failover" test cannot distinguish a working walk from no walk at
 * all — the exact blind spot that previously left the OpenAI front with an empty policy path.
 */

interface FrontDriver {
  name: string;
  post: (proxyPort: number, model?: string) => Promise<Response>;
  content: (response: Response) => Promise<string>;
}

const FRONTS: FrontDriver[] = [
  {
    name: "Anthropic Messages (/v1/messages)",
    post: (proxyPort, model = "pool/convergence") =>
      fetch(`http://127.0.0.1:${proxyPort}/v1/messages`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          model,
          max_tokens: 32,
          messages: [{ role: "user", content: "hi" }],
        }),
      }),
    content: async (response) => {
      const body = (await response.json()) as { content?: Array<{ text?: string }> };
      return body.content?.[0]?.text ?? "";
    },
  },
  {
    name: "OpenAI Chat Completions (/v1/chat/completions)",
    post: (proxyPort, model = "pool/convergence") =>
      fetch(`http://127.0.0.1:${proxyPort}/v1/chat/completions`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          model,
          max_tokens: 32,
          messages: [{ role: "user", content: "hi" }],
        }),
      }),
    content: async (response) => {
      const body = (await response.json()) as {
        choices?: Array<{ message?: { content?: string } }>;
      };
      return body.choices?.[0]?.message?.content ?? "";
    },
  },
  {
    name: "OpenAI Responses (/v1/responses)",
    post: (proxyPort, model = "pool/convergence") =>
      fetch(`http://127.0.0.1:${proxyPort}/v1/responses`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          model,
          max_output_tokens: 32,
          input: [{ role: "user", content: [{ type: "input_text", text: "hi" }] }],
        }),
      }),
    content: async (response) => {
      const body = (await response.json()) as { output_text?: string };
      return body.output_text ?? "";
    },
  },
];

const servers: Server[] = [];

function track(server: Server): Server {
  servers.push(server);
  return server;
}

function port(server: Server): number {
  return (server.address() as AddressInfo).port;
}

beforeEach(() => {
  globalCircuitBreaker.reset();
  resetFacts();
  resetInterpretations();
});

afterEach(async () => {
  try {
    await Promise.all(
      servers.splice(0).map(
        (server) => new Promise<void>((resolve, reject) => {
          server.close((error) => error ? reject(error) : resolve());
        }),
      ),
    );
  } finally {
    globalCircuitBreaker.reset();
    resetFacts();
    resetInterpretations();
  }
});

interface ScriptedResponse {
  status?: number;
  headers?: Record<string, string>;
  body: string;
}

/** A backend whose every response is scripted, with calls counted only once the request arrived. */
function scripted(
  reply: (call: number) => ScriptedResponse,
): Promise<{ server: Server; calls: () => number }> {
  let calls = 0;
  return new Promise((resolve) => {
    const server = createServer((request, response) => {
      request.on("data", () => {});
      request.on("end", () => {
        const out = reply(++calls);
        response.writeHead(out.status ?? 200, {
          "content-type": "application/json",
          ...out.headers,
        });
        response.end(out.body);
      });
    });
    server.listen(0, "127.0.0.1", () => resolve({ server: track(server), calls: () => calls }));
  });
}

/** A backend that proves a provider-wide transport failure by resetting the socket. */
function resetting(): Promise<{ server: Server; calls: () => number }> {
  let calls = 0;
  return new Promise((resolve) => {
    const server = createServer((request) => {
      calls++;
      request.socket.destroy();
    });
    server.listen(0, "127.0.0.1", () => resolve({ server: track(server), calls: () => calls }));
  });
}

/** A backend that never answers; only the configured per-target deadline ends its attempt. */
function hanging(): Promise<{ server: Server; calls: () => number }> {
  let calls = 0;
  return new Promise((resolve) => {
    const server = createServer(() => {
      calls++;
    });
    server.listen(0, "127.0.0.1", () => resolve({ server: track(server), calls: () => calls }));
  });
}

const OK_BODY = JSON.stringify({
  id: "cmpl_convergence",
  object: "chat.completion",
  model: "served-model",
  choices: [{
    index: 0,
    message: { role: "assistant", content: "served" },
    finish_reason: "stop",
  }],
  usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
});

function errorBody(message: string, type = "upstream_error"): string {
  return JSON.stringify({ error: { message, type } });
}

interface PoolConfigOptions {
  candidates?: string[];
  timeoutMs?: number[];
  tierTypes?: Array<ProviderTierType | undefined>;
}

/** A config-order pool; no live capability snapshot can reorder a convergence fixture. */
function poolConfig(bases: string[], options: PoolConfigOptions = {}): Config {
  const providers: Record<string, ProviderConfig> = {};
  bases.forEach((base, index) => {
    const provider: ProviderConfig = {
      base,
      kind: "openai",
      authHeader: "authorization",
      timeoutMs: options.timeoutMs?.[index] ?? 5000,
    };
    const tierType = options.tierTypes?.[index];
    if (tierType !== undefined) provider.tierType = tierType;
    providers[`p${index + 1}`] = provider;
  });

  return {
    host: "127.0.0.1",
    port: 0,
    providers,
    routing: {
      default: "pool/convergence",
      tiers: {},
      benchmarkSort: false,
      pools: {
        convergence: options.candidates ?? bases.map((_, index) => `p${index + 1}/m${index + 1}`),
      },
    },
    mode: "detect",
    repair: { maxAttempts: 2, destructiveTools: [] },
    log: { level: "silent", file: null },
  };
}

function startProxy(
  config: Config,
  catalog = new ModelCatalog({ cachePath: null }),
): Promise<Server> {
  const server = createProxy(config, { catalog, breaker: globalCircuitBreaker });
  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => resolve(track(server)));
  });
}

async function expectServed(
  front: FrontDriver,
  response: Response,
): Promise<void> {
  expect(response.status).toBe(200);
  expect(await front.content(response)).toBe("served");
}

function enableFreeOnly(config: Config): void {
  config.routing.offload = {
    claude: { enabled: true, scope: "all", freeOnly: true },
    openai: { enabled: true, scope: "all", freeOnly: true },
    codex: { enabled: true, scope: "all", freeOnly: true },
  };
}

const catalogFeed = (model: string) =>
  (async () => new Response(JSON.stringify({ data: [{ id: model }] }), { status: 200 })) as unknown as typeof fetch;

/**
 * Materialize an xhigh pool with one in-band member and one measured lower-band tail member.
 * The policy is removed only after materialization so request-time refresh cannot replace the
 * injected tier fixture with docs/tier-data.json. Both `pools` and `poolDegraded` remain the real
 * materializer's output; the test never hand-builds the derived degraded map.
 */
async function materializedDegradedConfig(strongBase: string, weakBase: string): Promise<{
  config: Config;
  catalog: ModelCatalog;
}> {
  const config = poolConfig([strongBase, weakBase], {
    candidates: [],
    tierTypes: ["free", "free"],
  });
  config.routing.default = "pool/xhigh";
  config.routing.pools = { xhigh: [] };
  config.routing.poolPolicies = {
    xhigh: { preferred: [], include: "free", effort: "xhigh" },
  };

  const catalog = new ModelCatalog({ cachePath: null });
  await catalog.list("p1", config.providers.p1!, { fetchFn: catalogFeed("strong-model") });
  await catalog.list("p2", config.providers.p2!, { fetchFn: catalogFeed("weak-model") });

  const rows: TierModel[] = [
    {
      norm: "strong-model",
      strength: 0.9,
      signals: ["a", "b", "c"],
      signal_count: 3,
      published_signal_count: 3,
      effort_eligibility: ["low", "medium", "high", "xhigh"],
    },
    {
      norm: "weak-model",
      strength: 0.55,
      signals: ["a", "b", "c"],
      signal_count: 3,
      published_signal_count: 3,
      effort_eligibility: ["low"],
    },
  ];
  const tierData: TierData = {
    models: rows,
    byNorm: rows.map((record) => ({ norm: record.norm, rec: record })),
    exactByNorm: new Map(rows.map((record) => [record.norm, record])),
    revision: "cross-front-convergence-fixture",
  };

  expect(materializeDynamicPools(config, catalog, { force: true, tierData })).toBe(true);
  expect(config.routing.pools.xhigh).toEqual(["p1/strong-model", "p2/weak-model"]);
  expect(config.routing.poolDegraded?.xhigh).toEqual(["p2/weak-model"]);
  delete config.routing.poolPolicies;
  return { config, catalog };
}

describe.each(FRONTS)("$name — cross-front failover convergence", (front) => {
  it("401 credential fault steps to the next candidate without laundering it into health", async () => {
    const first = await scripted(() => ({ status: 401, body: errorBody("wrong API key", "authentication_error") }));
    const second = await scripted(() => ({ body: OK_BODY }));
    const config = poolConfig([
      `http://127.0.0.1:${port(first.server)}`,
      `http://127.0.0.1:${port(second.server)}`,
    ]);
    const proxyPort = port(await startProxy(config));

    const response = await front.post(proxyPort);
    await expectServed(front, response);
    expect(first.calls()).toBe(1);
    expect(second.calls()).toBe(1);
    const state = globalCircuitBreaker.getState("p1/m1");
    expect(state?.credentialFailures).toBe(1);
    expect(state?.lastCredentialStatus).toBe(401);
    expect(state?.consecutiveFailures).toBe(0);
    expect(state?.cooldownUntil).toBe(0);
  });

  it("429 steps to the next candidate, records the breaker, and reports the whole walk", async () => {
    const first = await scripted(() => ({ status: 429, body: errorBody("slow down", "rate_limit_error") }));
    const second = await scripted(() => ({ body: OK_BODY }));
    const config = poolConfig([
      `http://127.0.0.1:${port(first.server)}`,
      `http://127.0.0.1:${port(second.server)}`,
    ]);
    const proxyPort = port(await startProxy(config));

    const response = await front.post(proxyPort);
    expect(response.headers.get(POOL_ATTEMPTS_HEADER)).toBe("2 tried, 1 served: 1x429, 1x200");
    await expectServed(front, response);
    expect(first.calls()).toBe(1);
    expect(second.calls()).toBe(1);
    const state = globalCircuitBreaker.getState("p1/m1");
    expect(state?.lastStatus).toBe(429);
    expect(state?.consecutiveFailures).toBe(1);
    expect(state?.cooldownUntil).toBeGreaterThan(Date.now());
  });

  it("Retry-After sets the failed candidate's breaker cooldown without delaying failover", async () => {
    const first = await scripted(() => ({
      status: 429,
      headers: { "retry-after": "5" },
      body: errorBody("retry later", "rate_limit_error"),
    }));
    const second = await scripted(() => ({ body: OK_BODY }));
    const config = poolConfig([
      `http://127.0.0.1:${port(first.server)}`,
      `http://127.0.0.1:${port(second.server)}`,
    ]);
    const proxyPort = port(await startProxy(config));

    const response = await front.post(proxyPort);
    await expectServed(front, response);
    const state = globalCircuitBreaker.getState("p1/m1");
    expect(state?.lastStatus).toBe(429);
    const remaining = (state?.cooldownUntil ?? 0) - Date.now();
    expect(remaining).toBeGreaterThan(0);
    expect(remaining).toBeLessThanOrEqual(5000);
  });

  it("402 quota exhaustion steps to the next candidate and receives the extended cooldown", async () => {
    const first = await scripted(() => ({
      status: 402,
      body: errorBody("credits depleted", "insufficient_quota"),
    }));
    const second = await scripted(() => ({ body: OK_BODY }));
    const config = poolConfig([
      `http://127.0.0.1:${port(first.server)}`,
      `http://127.0.0.1:${port(second.server)}`,
    ]);
    const proxyPort = port(await startProxy(config));

    const response = await front.post(proxyPort);
    await expectServed(front, response);
    const state = globalCircuitBreaker.getState("p1/m1");
    expect(state?.lastStatus).toBe(402);
    expect(state?.consecutiveFailures).toBe(1);
    const remaining = (state?.cooldownUntil ?? 0) - Date.now();
    expect(remaining).toBeGreaterThan(120_000);
    expect(remaining).toBeLessThanOrEqual(3_600_000);
  });

  it("5xx steps to the next candidate and records the server failure", async () => {
    const first = await scripted(() => ({ status: 503, body: errorBody("temporarily unavailable") }));
    const second = await scripted(() => ({ body: OK_BODY }));
    const config = poolConfig([
      `http://127.0.0.1:${port(first.server)}`,
      `http://127.0.0.1:${port(second.server)}`,
    ]);
    const proxyPort = port(await startProxy(config));

    const response = await front.post(proxyPort);
    await expectServed(front, response);
    expect(first.calls()).toBe(1);
    expect(second.calls()).toBe(1);
    const state = globalCircuitBreaker.getState("p1/m1");
    expect(state?.lastStatus).toBe(503);
    expect(state?.consecutiveFailures).toBe(1);
  });

  it("transport reset skips the failed provider's remaining member for this walk", async () => {
    const reset = await resetting();
    const healthy = await scripted(() => ({ body: OK_BODY }));
    const config = poolConfig(
      [
        `http://127.0.0.1:${port(reset.server)}`,
        `http://127.0.0.1:${port(healthy.server)}`,
      ],
      { candidates: ["p1/m1", "p1/m2", "p2/m3"] },
    );
    const proxyPort = port(await startProxy(config));

    const response = await front.post(proxyPort);
    await expectServed(front, response);
    expect(reset.calls()).toBe(1);
    expect(healthy.calls()).toBe(1);
  });

  it("per-target timeout on a hanging candidate steps to the next candidate", async () => {
    const hang = await hanging();
    const healthy = await scripted(() => ({ body: OK_BODY }));
    const config = poolConfig(
      [
        `http://127.0.0.1:${port(hang.server)}`,
        `http://127.0.0.1:${port(healthy.server)}`,
      ],
      { timeoutMs: [150, 5000] },
    );
    const proxyPort = port(await startProxy(config));

    const response = await front.post(proxyPort);
    await expectServed(front, response);
    expect(hang.calls()).toBe(1);
    expect(healthy.calls()).toBe(1);
  });

  it("all-429 exhaustion returns the pool's earliest Retry-After", async () => {
    const first = await scripted(() => ({
      status: 429,
      headers: { "retry-after": "60" },
      body: errorBody("first limited", "rate_limit_error"),
    }));
    const second = await scripted(() => ({
      status: 429,
      headers: { "retry-after": "7" },
      body: errorBody("second limited", "rate_limit_error"),
    }));
    const config = poolConfig([
      `http://127.0.0.1:${port(first.server)}`,
      `http://127.0.0.1:${port(second.server)}`,
    ]);
    const proxyPort = port(await startProxy(config));

    const response = await front.post(proxyPort);
    expect(response.status).toBe(429);
    expect(response.headers.get("retry-after")).toBe("7");
    expect(response.headers.get(POOL_ATTEMPTS_HEADER)).toBe("2 tried, 0 served: 2x429");
    expect(first.calls()).toBe(1);
    expect(second.calls()).toBe(1);
  });

  it("wire response announces service from a dynamically materialized degraded tail", async () => {
    const strong = await scripted(() => ({ status: 503, body: errorBody("strong model unavailable") }));
    const weak = await scripted(() => ({ body: OK_BODY }));
    const { config, catalog } = await materializedDegradedConfig(
      `http://127.0.0.1:${port(strong.server)}`,
      `http://127.0.0.1:${port(weak.server)}`,
    );
    const proxyPort = port(await startProxy(config, catalog));

    const response = await front.post(proxyPort, "pool/xhigh");
    expect(response.headers.get(DEGRADED_HEADER)).toBe("p2/weak-model (below xhigh)");
    expect(response.headers.get(POOL_ATTEMPTS_HEADER)).toBe("2 tried, 1 served: 1x503, 1x200");
    await expectServed(front, response);
    expect(strong.calls()).toBe(1);
    expect(weak.calls()).toBe(1);
  });

  it("freeOnly filters an unknown-cost candidate and serves the assessed-free member", async () => {
    const paid = await scripted(() => ({ body: OK_BODY }));
    const free = await scripted(() => ({ body: OK_BODY }));
    const config = poolConfig(
      [
        `http://127.0.0.1:${port(paid.server)}`,
        `http://127.0.0.1:${port(free.server)}`,
      ],
      { tierTypes: [undefined, "free"] },
    );
    enableFreeOnly(config);
    const proxyPort = port(await startProxy(config));

    const response = await front.post(proxyPort);
    await expectServed(front, response);
    expect(paid.calls()).toBe(0);
    expect(free.calls()).toBe(1);
  });

  it("freeOnly returns 503 with zero egress when no candidate is assessed free", async () => {
    const firstPaid = await scripted(() => ({ body: OK_BODY }));
    const secondPaid = await scripted(() => ({ body: OK_BODY }));
    const config = poolConfig([
      `http://127.0.0.1:${port(firstPaid.server)}`,
      `http://127.0.0.1:${port(secondPaid.server)}`,
    ]);
    enableFreeOnly(config);
    const proxyPort = port(await startProxy(config));

    const response = await front.post(proxyPort);
    expect(response.status).toBe(503);
    expect(await response.text()).toContain("freeOnly");
    expect(firstPaid.calls()).toBe(0);
    expect(secondPaid.calls()).toBe(0);
  });
});
