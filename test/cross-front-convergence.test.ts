import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createProxy } from "../src/server.js";
import { ModelCatalog } from "../src/catalog.js";
import { globalCircuitBreaker } from "../src/circuit-breaker.js";
import { makeCredentialId } from "../src/credential-id.js";
import {
  CREDENTIAL_ATTEMPTS_HEADER,
  CREDENTIAL_HEADER,
  DEGRADED_HEADER,
  POOL_ATTEMPTS_HEADER,
} from "../src/backend.js";
import { recordFact, resetFacts } from "../src/target-facts.js";
import {
  acceptInterpretation,
  recordUnknownRefusal,
  refusalSignature,
  resetInterpretations,
  type ScopeTemplate,
} from "../src/refusal-interpretation.js";
import { materializeDynamicPools } from "../src/dynamic-pools.js";
import type { Config, ProviderConfig, ProviderTierType } from "../src/config.js";
import type { TierData, TierModel } from "../src/tier-data.js";

const breakerIdentity = (provider: string, model: string | null) => ({
  provider,
  model,
  kind: "openai" as const,
  credentialId: makeCredentialId(provider),
});

/**
 * One policy matrix, driven through every public request shape.
 *
 * The suite deliberately uses real loopback HTTP servers and at least two candidates for every
 * failover row. A one-member "failover" test cannot distinguish a working walk from no walk at
 * all — the exact blind spot that previously left the OpenAI front with an empty policy path.
 */

interface FrontDriver {
  name: string;
  post: (proxyPort: number, model?: string, signal?: AbortSignal) => Promise<Response>;
  content: (response: Response) => Promise<string>;
}

const FRONTS: FrontDriver[] = [
  {
    name: "Anthropic Messages (/v1/messages)",
    post: (proxyPort, model = "pool/convergence", signal) =>
      fetch(`http://127.0.0.1:${proxyPort}/v1/messages`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        ...(signal ? { signal } : {}),
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
    post: (proxyPort, model = "pool/convergence", signal) =>
      fetch(`http://127.0.0.1:${proxyPort}/v1/chat/completions`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        ...(signal ? { signal } : {}),
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
    post: (proxyPort, model = "pool/convergence", signal) =>
      fetch(`http://127.0.0.1:${proxyPort}/v1/responses`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        ...(signal ? { signal } : {}),
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
const tempDirs: string[] = [];
const FLEET_ENV = {
  p1: ["CONVERGENCE_P1_DEFAULT_KEY", "CONVERGENCE_P1_WORK_KEY"],
  p2: ["CONVERGENCE_P2_DEFAULT_KEY", "CONVERGENCE_P2_WORK_KEY"],
} as const;
const FLEET_SECRETS = {
  p1: ["p1-default-secret", "p1-work-secret"],
  p2: ["p2-default-secret", "p2-work-secret"],
} as const;
let previousFleetEnv = new Map<string, string | undefined>();

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
  previousFleetEnv = new Map();
  for (const provider of ["p1", "p2"] as const) {
    FLEET_ENV[provider].forEach((name, index) => {
      previousFleetEnv.set(name, process.env[name]);
      process.env[name] = FLEET_SECRETS[provider][index];
    });
  }
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
    for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
    globalCircuitBreaker.reset();
    resetFacts();
    resetInterpretations();
    for (const [name, value] of previousFleetEnv) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
    previousFleetEnv.clear();
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

interface FleetRequest {
  model: string;
  credential: string;
}

/** A credential-aware backend that records the exact model/slot cells that reached egress. */
function fleetScripted(
  reply: (request: FleetRequest, call: number) => ScriptedResponse,
): Promise<{ server: Server; seen: () => FleetRequest[] }> {
  const seen: FleetRequest[] = [];
  return new Promise((resolve) => {
    const server = createServer((request, response) => {
      const chunks: Buffer[] = [];
      request.on("data", (chunk: Buffer) => chunks.push(chunk));
      request.on("end", () => {
        const parsed = JSON.parse(Buffer.concat(chunks).toString("utf8")) as { model?: string };
        const authorization = String(request.headers.authorization ?? "");
        const entry: FleetRequest = {
          model: parsed.model ?? "",
          credential: authorization.replace(/^Bearer\s+/i, ""),
        };
        seen.push(entry);
        const out = reply(entry, seen.length);
        response.writeHead(out.status ?? 200, {
          "content-type": "application/json",
          ...out.headers,
        });
        response.end(out.body);
      });
    });
    server.listen(0, "127.0.0.1", () => resolve({ server: track(server), seen: () => [...seen] }));
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

/**
 * Yield a real 401 head, then fail while its declared body is still incomplete. Fetch has already
 * returned a Response at that point, so this is a post-header protocol failure, not a credential
 * refusal and not a provider-wide connection failure.
 */
function truncatedCredentialFailure(): Promise<{ server: Server; seen: () => FleetRequest[] }> {
  const seen: FleetRequest[] = [];
  return new Promise((resolve) => {
    const server = createServer((request, response) => {
      const chunks: Buffer[] = [];
      request.on("data", (chunk: Buffer) => chunks.push(chunk));
      request.on("end", () => {
        const parsed = JSON.parse(Buffer.concat(chunks).toString("utf8")) as { model?: string };
        const authorization = String(request.headers.authorization ?? "");
        seen.push({
          model: parsed.model ?? "",
          credential: authorization.replace(/^Bearer\s+/i, ""),
        });

        const partial = '{"error":{"message":"truncated credential refusal';
        response.on("error", () => {});
        response.writeHead(401, {
          "content-type": "application/json",
          "content-length": String(Buffer.byteLength(partial) + 128),
        });
        response.flushHeaders();
        response.write(partial, () => setImmediate(() => response.destroy()));
      });
    });
    server.listen(0, "127.0.0.1", () => resolve({
      server: track(server),
      seen: () => [...seen],
    }));
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

function openAiBody(model: string): string {
  return JSON.stringify({
    id: "cmpl_convergence",
    object: "chat.completion",
    model,
    choices: [{
      index: 0,
      message: { role: "assistant", content: "served" },
      finish_reason: "stop",
    }],
    usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
  });
}

const OK_BODY = openAiBody("served-model");

function errorBody(message: string, type = "upstream_error"): string {
  return JSON.stringify({ error: { message, type } });
}

interface PoolConfigOptions {
  candidates?: string[];
  timeoutMs?: number[];
  tierTypes?: Array<ProviderTierType | undefined>;
  logFile?: string;
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
    log: options.logFile
      ? { level: "metadata", file: options.logFile }
      : { level: "silent", file: null },
  };
}

function enableTwoCredentialFleet(config: Config): Config {
  for (const provider of ["p1", "p2"] as const) {
    const configured = config.providers[provider];
    if (!configured) continue;
    configured.credentialMode = "contained";
    configured.credentials = [
      { label: "default", authEnv: FLEET_ENV[provider][0] },
      { label: "work", authEnv: FLEET_ENV[provider][1] },
    ];
  }
  return config;
}

function acceptBodyScope(
  provider: string,
  model: string,
  status: number,
  body: string,
  scope: ScopeTemplate,
): void {
  recordUnknownRefusal(provider, model, status, body);
  expect(acceptInterpretation(refusalSignature(provider, model, status, body), {
    override: { class: "not-servable", scope },
  })).toBe(true);
}

function credentialLabel(provider: "p1" | "p2", credential: "default" | "work"): string {
  return FLEET_SECRETS[provider][credential === "default" ? 0 : 1];
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

interface ScopeWalkCase {
  name: string;
  scope: ScopeTemplate;
  candidates: string[];
  winner: { provider: "p1" | "p2"; model: string; credential: "default" | "work" };
  expectedEgress: Array<{ provider: "p1" | "p2"; model: string; credential: "default" | "work" }>;
}

const SCOPE_WALK_CASES: ScopeWalkCase[] = [
  {
    name: "attempt",
    scope: { kind: "attempt" },
    candidates: ["p1/m1", "p2/m2"],
    winner: { provider: "p1", model: "m1", credential: "work" },
    expectedEgress: [
      { provider: "p1", model: "m1", credential: "default" },
      { provider: "p2", model: "m2", credential: "default" },
      { provider: "p1", model: "m1", credential: "work" },
    ],
  },
  {
    name: "credential",
    scope: { kind: "credential" },
    candidates: ["p1/m1", "p1/m2", "p2/m3"],
    winner: { provider: "p1", model: "m2", credential: "work" },
    expectedEgress: [
      { provider: "p1", model: "m1", credential: "default" },
      { provider: "p1", model: "m2", credential: "work" },
    ],
  },
  {
    name: "provider",
    scope: { kind: "provider" },
    candidates: ["p1/m1", "p1/m2", "p2/m3"],
    winner: { provider: "p2", model: "m3", credential: "default" },
    expectedEgress: [
      { provider: "p1", model: "m1", credential: "default" },
      { provider: "p2", model: "m3", credential: "default" },
    ],
  },
  {
    name: "deployment",
    scope: { kind: "deployment" },
    candidates: ["p1/m1", "p2/m2"],
    winner: { provider: "p2", model: "m2", credential: "default" },
    expectedEgress: [
      { provider: "p1", model: "m1", credential: "default" },
      { provider: "p2", model: "m2", credential: "default" },
    ],
  },
  {
    name: "model",
    scope: { kind: "model" },
    candidates: ["p1/m1", "p2/m1", "p2/m2"],
    winner: { provider: "p2", model: "m2", credential: "default" },
    expectedEgress: [
      { provider: "p1", model: "m1", credential: "default" },
      { provider: "p2", model: "m2", credential: "default" },
    ],
  },
  {
    name: "credential-bound group",
    scope: { kind: "group", credential: "attempt", members: ["m2"] },
    candidates: ["p1/m1", "p1/m2", "p1/m3", "p2/m4"],
    winner: { provider: "p1", model: "m2", credential: "work" },
    expectedEgress: [
      { provider: "p1", model: "m1", credential: "default" },
      { provider: "p1", model: "m2", credential: "work" },
    ],
  },
];

describe.each(FRONTS)("$name — cross-front failover convergence", (front) => {
  it.each(SCOPE_WALK_CASES)(
    "an accepted $name scope suppresses only covered cells in the current credential walk",
    async (scopeCase) => {
      const scopeMarker = `scheduler scope ${scopeCase.name} refusal`;
      const refusal = errorBody(scopeMarker, "scope_fixture");
      acceptBodyScope("p1", "m1", 403, refusal, scopeCase.scope);

      const allSeen: Array<{ provider: "p1" | "p2"; request: FleetRequest }> = [];
      const makeBackend = async (provider: "p1" | "p2") => fleetScripted((request) => {
        allSeen.push({ provider, request });
        const credential = request.credential === credentialLabel(provider, "work") ? "work" : "default";
        if (provider === "p1" && request.model === "m1" && credential === "default") {
          return { status: 403, body: refusal };
        }
        if (
          provider === scopeCase.winner.provider
          && request.model === scopeCase.winner.model
          && credential === scopeCase.winner.credential
        ) {
          return { body: OK_BODY };
        }
        return { status: 429, body: errorBody("ordinary per-cell backpressure", "rate_limit_error") };
      });
      const p1 = await makeBackend("p1");
      const p2 = await makeBackend("p2");
      const config = enableTwoCredentialFleet(poolConfig([
        `http://127.0.0.1:${port(p1.server)}`,
        `http://127.0.0.1:${port(p2.server)}`,
      ], { candidates: scopeCase.candidates }));
      const proxyPort = port(await startProxy(config));

      const response = await front.post(proxyPort);
      await expectServed(front, response);
      expect(response.headers.get(CREDENTIAL_HEADER)).toBe(
        makeCredentialId(scopeCase.winner.provider, scopeCase.winner.credential),
      );
      expect(allSeen.map(({ provider, request }) => ({
        provider,
        model: request.model,
        credential: request.credential === credentialLabel(provider, "work") ? "work" : "default",
      }))).toEqual(scopeCase.expectedEgress);
    },
  );

  it("returns the current real refusal when its accepted body scope exhausts the walk", async () => {
    const marker = "scheduler terminal provider refusal";
    const refusal = errorBody(marker, "scope_fixture");
    acceptBodyScope("p1", "m1", 403, refusal, { kind: "provider" });
    const onlyProvider = await fleetScripted(() => ({ status: 403, body: refusal }));
    const config = enableTwoCredentialFleet(poolConfig([
      `http://127.0.0.1:${port(onlyProvider.server)}`,
    ], { candidates: ["p1/m1", "p1/m2"] }));
    const proxyPort = port(await startProxy(config));
    const controller = new AbortController();
    const abort = setTimeout(() => controller.abort(), 1_000);
    const started = Date.now();

    try {
      const response = await front.post(proxyPort, undefined, controller.signal);
      expect(Date.now() - started).toBeLessThan(1_000);
      expect(response.status).toBe(403);
      expect(await response.text()).toContain(marker);
      expect(onlyProvider.seen()).toHaveLength(1);
    } finally {
      clearTimeout(abort);
    }
  });

  it("returns the final 503 after each failed deployment closes without trying its sibling slot", async () => {
    const first = await scripted(() => ({ status: 503, body: errorBody("first deployment unavailable") }));
    const second = await scripted(() => ({ status: 503, body: errorBody("final deployment unavailable") }));
    const config = enableTwoCredentialFleet(poolConfig([
      `http://127.0.0.1:${port(first.server)}`,
      `http://127.0.0.1:${port(second.server)}`,
    ]));
    const proxyPort = port(await startProxy(config));

    const response = await front.post(proxyPort);
    expect(response.status).toBe(503);
    expect(await response.text()).toContain("final deployment unavailable");
    expect(first.calls()).toBe(1);
    expect(second.calls()).toBe(1);
    expect(response.headers.get(CREDENTIAL_HEADER)).toBeNull();
    expect(response.headers.get(CREDENTIAL_ATTEMPTS_HEADER)).toBe("2 tried, 0 served: 2x503");
  });

  it("reports the exact winning slot, actual starts, and failure-only credential bins", async () => {
    const sequence: string[] = [];
    const first = await fleetScripted((request) => {
      sequence.push(`p1:${request.credential}`);
      return request.credential === credentialLabel("p1", "default")
        ? { status: 401, body: errorBody("plain credential refusal") }
        : { body: OK_BODY };
    });
    const intervening = await fleetScripted((request) => {
      sequence.push(`p2:${request.credential}`);
      return { status: 503, body: errorBody("deployment unavailable") };
    });
    const config = enableTwoCredentialFleet(poolConfig([
      `http://127.0.0.1:${port(first.server)}`,
      `http://127.0.0.1:${port(intervening.server)}`,
    ]));
    const proxyPort = port(await startProxy(config));

    const response = await front.post(proxyPort);
    await expectServed(front, response);
    expect(sequence).toEqual([
      `p1:${credentialLabel("p1", "default")}`,
      `p2:${credentialLabel("p2", "default")}`,
      `p1:${credentialLabel("p1", "work")}`,
    ]);
    expect(response.headers.get(CREDENTIAL_HEADER)).toBe(makeCredentialId("p1", "work"));
    expect(response.headers.get(CREDENTIAL_ATTEMPTS_HEADER)).toBe(
      "3 tried, 1 served: 1x401, 1x503",
    );
  });

  it("closes only the deployment when an apparent credential refusal body fails after headers", async () => {
    const truncated = await truncatedCredentialFailure();
    const final = await fleetScripted(() => ({
      status: 503,
      body: errorBody("final deployment unavailable"),
    }));
    const config = enableTwoCredentialFleet(poolConfig([
      `http://127.0.0.1:${port(truncated.server)}`,
      `http://127.0.0.1:${port(final.server)}`,
    ]));
    const proxyPort = port(await startProxy(config));

    const response = await front.post(proxyPort);
    expect(response.status).toBe(503);
    expect(await response.text()).toContain("final deployment unavailable");
    expect(truncated.seen()).toEqual([
      { model: "m1", credential: credentialLabel("p1", "default") },
    ]);
    expect(final.seen()).toEqual([
      { model: "m2", credential: credentialLabel("p2", "default") },
    ]);
    expect(response.headers.get(CREDENTIAL_HEADER)).toBeNull();
    expect(response.headers.get(CREDENTIAL_ATTEMPTS_HEADER)).toBe(
      "2 tried, 0 served: 1xprotocol, 1x503",
    );
  });

  it("counts a transport start in an all-failed walk without claiming a served credential", async () => {
    const credentialFailures = await fleetScripted(() => ({
      status: 401,
      body: errorBody("plain credential refusal"),
    }));
    const transportFailure = await resetting();
    const config = enableTwoCredentialFleet(poolConfig([
      `http://127.0.0.1:${port(credentialFailures.server)}`,
      `http://127.0.0.1:${port(transportFailure.server)}`,
    ]));
    const proxyPort = port(await startProxy(config));

    const response = await front.post(proxyPort);
    expect(response.status).toBe(401);
    await response.text();
    expect(credentialFailures.seen()).toHaveLength(2);
    expect(transportFailure.calls()).toBe(1);
    expect(response.headers.get(CREDENTIAL_HEADER)).toBeNull();
    expect(response.headers.get(CREDENTIAL_ATTEMPTS_HEADER)).toBe(
      "3 tried, 0 served: 2x401, 1xtransport",
    );
  });

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
    const state = globalCircuitBreaker.getState(breakerIdentity("p1", "m1"));
    expect(state?.credentialFailures).toBe(1);
    expect(state?.lastCredentialStatus).toBe(401);
    expect(state?.consecutiveFailures).toBe(0);
    expect(state?.cooldownUntil).toBe(0);
  });

  it("429 steps to the next candidate, records the breaker, and reports the whole walk", async () => {
    const first = await scripted(() => ({ status: 429, body: errorBody("slow down", "rate_limit_error") }));
    const second = await scripted(() => ({ body: OK_BODY }));
    const logDir = mkdtempSync(join(tmpdir(), "rp-convergence-log-"));
    tempDirs.push(logDir);
    const logFile = join(logDir, "relay.jsonl");
    const config = poolConfig([
      `http://127.0.0.1:${port(first.server)}`,
      `http://127.0.0.1:${port(second.server)}`,
    ], { logFile });
    const proxyPort = port(await startProxy(config));

    const response = await front.post(proxyPort);
    expect(response.headers.get(POOL_ATTEMPTS_HEADER)).toBe("2 tried, 1 served: 1x429, 1x200");
    await expectServed(front, response);
    expect(first.calls()).toBe(1);
    expect(second.calls()).toBe(1);
    const state = globalCircuitBreaker.getState(breakerIdentity("p1", "m1"));
    expect(state?.lastStatus).toBe(429);
    expect(state?.consecutiveFailures).toBe(1);
    const remaining = (state?.cooldownUntil ?? 0) - Date.now();
    expect(remaining).toBeGreaterThan(0);
    expect(remaining).toBeLessThanOrEqual(5000);
    expect(state?.cooldownSource).toBe("loopback");

    const logged = JSON.parse(readFileSync(logFile, "utf8").trim()) as {
      servedModel: string;
      upstreamReportedModel?: string;
      attempts: Array<Record<string, unknown>>;
    };
    expect(logged.servedModel).toBe("m2");
    expect(logged.upstreamReportedModel).toBe("served-model");
    expect(logged.attempts).toEqual([
      { provider: "p1", model: "m1", status: 429, ms: expect.any(Number) },
      { provider: "p2", model: "m2", status: 200, ms: expect.any(Number) },
    ]);
    expect(Object.keys(logged.attempts[0]!)).toEqual(["provider", "model", "status", "ms"]);
    expect(JSON.stringify(logged.attempts)).not.toContain("slow down");
  });

  it("omits upstream model provenance when the reported model matches the routed target", async () => {
    const only = await scripted(() => ({ body: openAiBody("m1") }));
    const logDir = mkdtempSync(join(tmpdir(), "rp-convergence-model-match-"));
    tempDirs.push(logDir);
    const logFile = join(logDir, "relay.jsonl");
    const config = poolConfig([
      `http://127.0.0.1:${port(only.server)}`,
    ], { logFile });
    const proxyPort = port(await startProxy(config));

    await expectServed(front, await front.post(proxyPort));
    const logged = JSON.parse(readFileSync(logFile, "utf8").trim()) as Record<string, unknown>;
    expect(logged["servedModel"]).toBe("m1");
    expect(logged).not.toHaveProperty("upstreamReportedModel");
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
    const state = globalCircuitBreaker.getState(breakerIdentity("p1", "m1"));
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
    const state = globalCircuitBreaker.getState(breakerIdentity("p1", "m1"));
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
    const state = globalCircuitBreaker.getState(breakerIdentity("p1", "m1"));
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

  it("freeOnly keeps a deployment when only its default credential is attempt-blocked", async () => {
    const deploymentBlocked = await scripted(() => ({ body: OK_BODY }));
    const fleet = await scripted(() => ({ body: OK_BODY }));
    const previousDefault = process.env.CONVERGENCE_DEFAULT_KEY;
    const previousWork = process.env.CONVERGENCE_WORK_KEY;
    process.env.CONVERGENCE_DEFAULT_KEY = "default-secret";
    process.env.CONVERGENCE_WORK_KEY = "work-secret";
    try {
      const config = poolConfig(
        [
          `http://127.0.0.1:${port(deploymentBlocked.server)}`,
          `http://127.0.0.1:${port(fleet.server)}`,
        ],
        { tierTypes: ["free", "free"] },
      );
      config.providers.p2!.credentials = [
        { label: "default", authEnv: "CONVERGENCE_DEFAULT_KEY" },
        { label: "work", authEnv: "CONVERGENCE_WORK_KEY" },
      ];
      config.providers.p2!.credentialMode = "contained";
      recordFact("not-servable", {
        kind: "deployment", provider: "p1", model: "m1",
      });
      recordFact("not-servable", {
        kind: "attempt",
        provider: "p2",
        credentialId: makeCredentialId("p2", "default"),
        model: "m2",
      });
      enableFreeOnly(config);
      const proxyPort = port(await startProxy(config));

      const response = await front.post(proxyPort);
      expect(response.headers.get(CREDENTIAL_HEADER)).toBe(makeCredentialId("p2", "work"));
      await expectServed(front, response);
      expect(deploymentBlocked.calls()).toBe(0);
      expect(fleet.calls()).toBe(1);
    } finally {
      if (previousDefault === undefined) delete process.env.CONVERGENCE_DEFAULT_KEY;
      else process.env.CONVERGENCE_DEFAULT_KEY = previousDefault;
      if (previousWork === undefined) delete process.env.CONVERGENCE_WORK_KEY;
      else process.env.CONVERGENCE_WORK_KEY = previousWork;
    }
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

describe("raw upstream model provenance", () => {
  it("captures an Anthropic passthrough mismatch without replacing the routed model", async () => {
    const backend = await scripted(() => ({
      body: JSON.stringify({
        id: "msg_model_drift",
        type: "message",
        role: "assistant",
        model: "upstream-substitute",
        content: [{ type: "text", text: "served" }],
        stop_reason: "end_turn",
        usage: { input_tokens: 1, output_tokens: 1 },
      }),
    }));
    const logDir = mkdtempSync(join(tmpdir(), "rp-convergence-anthropic-model-"));
    tempDirs.push(logDir);
    const logFile = join(logDir, "relay.jsonl");
    const config = poolConfig([
      `http://127.0.0.1:${port(backend.server)}`,
    ], { candidates: ["p1/routed-model"], logFile });
    config.providers.p1!.kind = "anthropic";
    const proxyPort = port(await startProxy(config));

    const front = FRONTS[0]!;
    await expectServed(front, await front.post(proxyPort));
    const logged = JSON.parse(readFileSync(logFile, "utf8").trim()) as Record<string, unknown>;
    expect(logged["servedModel"]).toBe("routed-model");
    expect(logged["upstreamReportedModel"]).toBe("upstream-substitute");
  });
});
