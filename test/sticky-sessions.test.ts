import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createServer, type IncomingHttpHeaders, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { createProxy } from "../src/server.js";
import { ModelCatalog } from "../src/catalog.js";
import { CircuitBreaker } from "../src/circuit-breaker.js";
import { makeCredentialId } from "../src/credential-id.js";
import { CREDENTIAL_HEADER } from "../src/backend.js";
import { STICKY_PROVENANCE_HEADER, STICKY_SESSION_HEADER } from "../src/session-pin.js";
import { resetFacts } from "../src/target-facts.js";
import { resetInterpretations } from "../src/refusal-interpretation.js";
import type { Config, ProviderConfig } from "../src/config.js";

const ANTHROPIC_OK = JSON.stringify({
  id: "msg_ok",
  type: "message",
  role: "assistant",
  model: "served-model",
  content: [{ type: "text", text: "served" }],
  stop_reason: "end_turn",
  stop_sequence: null,
  usage: { input_tokens: 1, output_tokens: 1 },
});
const OPENAI_OK = JSON.stringify({
  id: "chatcmpl_ok",
  object: "chat.completion",
  choices: [{ index: 0, message: { role: "assistant", content: "served" }, finish_reason: "stop" }],
  usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
});
const RATE_LIMIT = JSON.stringify({ type: "error", error: { type: "rate_limit_error", message: "slow down" } });

const servers: Server[] = [];
const breakerIdentity = (provider: string, model: string | null, label = "default") => ({
  provider, model, kind: "anthropic" as const, credentialId: makeCredentialId(provider, label),
});
const FLEET_ENV = {
  p1: ["STICKY_P1_DEFAULT_KEY", "STICKY_P1_WORK_KEY"],
  p2: ["STICKY_P2_DEFAULT_KEY", "STICKY_P2_WORK_KEY"],
} as const;
const FLEET_SECRETS = {
  p1: ["sticky-p1-default", "sticky-p1-work"],
  p2: ["sticky-p2-default", "sticky-p2-work"],
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
  resetFacts();
  resetInterpretations();
  previousFleetEnv = new Map();
  for (const providerName of ["p1", "p2"] as const) {
    FLEET_ENV[providerName].forEach((name, index) => {
      previousFleetEnv.set(name, process.env[name]);
      process.env[name] = FLEET_SECRETS[providerName][index];
    });
  }
});

afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => new Promise<void>((resolve) => server.close(() => resolve()))));
  resetFacts();
  resetInterpretations();
  for (const [name, value] of previousFleetEnv) {
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
  }
  previousFleetEnv.clear();
});

interface ScriptedReply {
  status?: number;
  body?: string;
  reset?: boolean;
}

function scripted(reply: (call: number, headers: IncomingHttpHeaders) => ScriptedReply): Promise<{
  server: Server;
  calls: () => number;
  header: (name: string) => string | string[] | undefined;
  headers: () => IncomingHttpHeaders[];
}> {
  let calls = 0;
  let lastHeaders: IncomingHttpHeaders = {};
  const seenHeaders: IncomingHttpHeaders[] = [];
  return new Promise((resolve) => {
    const server = createServer((req, res) => {
      lastHeaders = req.headers;
      seenHeaders.push(req.headers);
      req.on("data", () => {});
      req.on("end", () => {
        const result = reply(++calls, req.headers);
        if (result.reset) {
          req.socket.destroy();
          return;
        }
        res.writeHead(result.status ?? 200, { "content-type": "application/json" });
        res.end(result.body ?? ANTHROPIC_OK);
      });
    });
    server.listen(0, "127.0.0.1", () => resolve({
      server: track(server),
      calls: () => calls,
      header: (name) => lastHeaders[name.toLowerCase()],
      headers: () => [...seenHeaders],
    }));
  });
}

function provider(base: string, tierType?: ProviderConfig["tierType"]): ProviderConfig {
  return {
    base,
    kind: "anthropic",
    authHeader: "x-api-key",
    credentialMode: "contained",
    timeoutMs: 2000,
    ...(tierType ? { tierType } : {}),
  };
}

function openAiProvider(base: string, tierType: "free" | "mixed" | "subscription"): ProviderConfig {
  return {
    base,
    kind: "openai",
    authHeader: "authorization",
    timeoutMs: 2000,
    tierType,
  };
}

function stickyConfig(
  providers: Record<string, ProviderConfig>,
  pools: Record<string, string[]> = { sticky: ["p1/m1", "p2/m2"] },
): Config {
  return {
    host: "127.0.0.1",
    port: 0,
    providers,
    routing: {
      default: "pool/sticky",
      tiers: {},
      pools,
      benchmarkSort: false,
      sticky: true,
    },
    mode: "detect",
    repair: { maxAttempts: 2, destructiveTools: [] },
    log: { level: "silent", file: null },
  };
}

function enableTwoCredentialFleet(config: Config): Config {
  for (const providerName of ["p1", "p2"] as const) {
    const configured = config.providers[providerName];
    if (!configured) continue;
    configured.credentialMode = "contained";
    configured.credentials = [
      { label: "default", authEnv: FLEET_ENV[providerName][0] },
      { label: "work", authEnv: FLEET_ENV[providerName][1] },
    ];
  }
  return config;
}

function observedCredential(headers: IncomingHttpHeaders): string {
  return String(headers["x-api-key"] ?? "");
}

async function startProxy(config: Config, breaker = new CircuitBreaker()): Promise<{ port: number; breaker: CircuitBreaker }> {
  const server = createProxy(config, { breaker, catalog: new ModelCatalog({ cachePath: null }) });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  track(server);
  return { port: port(server), breaker };
}

function sessionHeaders(session: string, extra: Record<string, string> = {}): Record<string, string> {
  return { "content-type": "application/json", [STICKY_SESSION_HEADER]: session, ...extra };
}

function messages(
  proxyPort: number,
  options: {
    model?: string;
    headers?: Record<string, string>;
    messages?: unknown[];
  } = {},
): Promise<Response> {
  return fetch(`http://127.0.0.1:${proxyPort}/v1/messages`, {
    method: "POST",
    headers: { "content-type": "application/json", ...options.headers },
    body: JSON.stringify({
      model: options.model ?? "pool/sticky",
      max_tokens: 32,
      messages: options.messages ?? [{ role: "user", content: "hello" }],
    }),
  });
}

function chat(proxyPort: number, headers: Record<string, string>): Promise<Response> {
  return fetch(`http://127.0.0.1:${proxyPort}/v1/chat/completions`, {
    method: "POST",
    headers,
    body: JSON.stringify({
      model: "pool/sticky",
      max_tokens: 32,
      messages: [{ role: "user", content: "hello" }],
    }),
  });
}

function responses(proxyPort: number, headers: Record<string, string>): Promise<Response> {
  return fetch(`http://127.0.0.1:${proxyPort}/v1/responses`, {
    method: "POST",
    headers,
    body: JSON.stringify({
      model: "pool/sticky",
      max_output_tokens: 32,
      input: [{ role: "user", content: [{ type: "input_text", text: "hello" }] }],
    }),
  });
}

describe("sticky sessions — guarded request-path affinity", () => {
  it("is inert when routing.sticky is absent", async () => {
    const first = await scripted(() => ({}));
    const second = await scripted(() => ({}));
    const config = stickyConfig({
      p1: provider(`http://127.0.0.1:${port(first.server)}`),
      p2: provider(`http://127.0.0.1:${port(second.server)}`),
    });
    delete config.routing.sticky;
    const proxy = await startProxy(config);

    const response = await messages(proxy.port, { headers: sessionHeaders("off") });
    expect(response.headers.get(STICKY_PROVENANCE_HEADER)).toBeNull();
    expect(first.calls()).toBe(1);
    expect(second.calls()).toBe(0);
  });

  it("pins an explicit relay session and reorders only after the first successful failover", async () => {
    const first = await scripted((call) => call === 1 ? { status: 429, body: RATE_LIMIT } : {});
    const second = await scripted(() => ({}));
    const config = stickyConfig({
      p1: provider(`http://127.0.0.1:${port(first.server)}`),
      p2: provider(`http://127.0.0.1:${port(second.server)}`),
    });
    const proxy = await startProxy(config);

    const turn1 = await messages(proxy.port, { headers: sessionHeaders("session-a") });
    expect(turn1.status).toBe(200);
    expect(turn1.headers.get(STICKY_PROVENANCE_HEADER)).toBe("p2/m2 (new)");

    proxy.breaker.reset();
    const turn2 = await messages(proxy.port, { headers: sessionHeaders("session-a") });
    expect(turn2.headers.get(STICKY_PROVENANCE_HEADER)).toBe("p2/m2 (pinned, reordered)");
    expect(first.calls()).toBe(1);
    expect(second.calls()).toBe(2);
    expect(first.header(STICKY_SESSION_HEADER)).toBeUndefined();
    expect(second.header(STICKY_SESSION_HEADER)).toBeUndefined();
  });

  it("keeps a naturally first pin breadth-first across ranked credential slots", async () => {
    const sequence: string[] = [];
    const pinned = await scripted((call, headers) => {
      sequence.push(`p1:${observedCredential(headers)}`);
      return call === 2 ? { status: 401, body: RATE_LIMIT } : {};
    });
    const other = await scripted((_call, headers) => {
      sequence.push(`p2:${observedCredential(headers)}`);
      return { status: 429, body: RATE_LIMIT };
    });
    const config = enableTwoCredentialFleet(stickyConfig({
      p1: provider(`http://127.0.0.1:${port(pinned.server)}`),
      p2: provider(`http://127.0.0.1:${port(other.server)}`),
    }));
    const proxy = await startProxy(config);

    const initial = await messages(proxy.port, { headers: sessionHeaders("breadth-first") });
    await initial.text();
    expect(initial.headers.get(STICKY_PROVENANCE_HEADER)).toBe("p1/m1 (new)");
    sequence.length = 0;

    const response = await messages(proxy.port, { headers: sessionHeaders("breadth-first") });
    await response.text();
    expect(response.status).toBe(200);
    expect(response.headers.get(STICKY_PROVENANCE_HEADER)).toBe("p1/m1 (pinned, natural)");
    expect(response.headers.get(CREDENTIAL_HEADER)).toBe(makeCredentialId("p1", "default"));
    expect(sequence).toEqual([
      `p1:${FLEET_SECRETS.p1[1]}`,
      `p2:${FLEET_SECRETS.p2[0]}`,
      `p1:${FLEET_SECRETS.p1[0]}`,
    ]);
  });

  it.each(["credential-fault", "cooling"] as const)(
    "keeps a pin eligible through a live sibling when its first configured slot is %s",
    async (state) => {
      const pinned = await scripted(() => ({}));
      const other = await scripted(() => ({}));
      const config = enableTwoCredentialFleet(stickyConfig({
        p1: provider(`http://127.0.0.1:${port(pinned.server)}`),
        p2: provider(`http://127.0.0.1:${port(other.server)}`),
      }));
      const proxy = await startProxy(config);

      const initial = await messages(proxy.port, { headers: sessionHeaders(`live-sibling-${state}`) });
      await initial.text();
      const defaultIdentity = breakerIdentity("p1", "m1", "default");
      if (state === "credential-fault") proxy.breaker.recordCredentialFault(defaultIdentity, 401);
      else proxy.breaker.recordOutcome(defaultIdentity, { ok: false, status: 429, elapsedMs: 1 });

      const response = await messages(proxy.port, { headers: sessionHeaders(`live-sibling-${state}`) });
      await response.text();
      expect(response.status).toBe(200);
      expect(response.headers.get(STICKY_PROVENANCE_HEADER)).toBe("p1/m1 (pinned, natural)");
      expect(response.headers.get(CREDENTIAL_HEADER)).toBe(makeCredentialId("p1", "work"));
      expect(pinned.headers().map(observedCredential)).toEqual([
        FLEET_SECRETS.p1[0],
        FLEET_SECRETS.p1[1],
      ]);
      expect(other.calls()).toBe(0);
    },
  );

  it("falls back to the first-user-message hash across a growing conversation", async () => {
    const first = await scripted((call) => call === 1 ? { status: 429, body: RATE_LIMIT } : {});
    const second = await scripted(() => ({}));
    const proxy = await startProxy(stickyConfig({
      p1: provider(`http://127.0.0.1:${port(first.server)}`),
      p2: provider(`http://127.0.0.1:${port(second.server)}`),
    }));

    const initial = [{ role: "user", content: "Design auth" }];
    expect((await messages(proxy.port, { messages: initial })).headers.get(STICKY_PROVENANCE_HEADER)).toBe("p2/m2 (new)");
    proxy.breaker.reset();
    const next = await messages(proxy.port, { messages: [
      ...initial,
      { role: "assistant", content: "draft" },
      { role: "user", content: "continue" },
    ] });
    expect(next.headers.get(STICKY_PROVENANCE_HEADER)).toBe("p2/m2 (pinned, reordered)");
    expect(first.calls()).toBe(1);
  });

  it("isolates explicit sessions", async () => {
    const first = await scripted((call) => call === 1 ? { status: 429, body: RATE_LIMIT } : {});
    const second = await scripted(() => ({}));
    const proxy = await startProxy(stickyConfig({
      p1: provider(`http://127.0.0.1:${port(first.server)}`),
      p2: provider(`http://127.0.0.1:${port(second.server)}`),
    }));

    await messages(proxy.port, { headers: sessionHeaders("A") });
    proxy.breaker.reset();
    const other = await messages(proxy.port, { headers: sessionHeaders("B") });
    expect(other.headers.get(STICKY_PROVENANCE_HEADER)).toBe("p1/m1 (new)");
    expect(first.calls()).toBe(2);
    expect(second.calls()).toBe(1);
  });

  it("bypasses a cooling pin and rebinds to the successful live member", async () => {
    const first = await scripted((call) => call === 1 ? { status: 429, body: RATE_LIMIT } : {});
    const second = await scripted(() => ({}));
    const proxy = await startProxy(stickyConfig({
      p1: provider(`http://127.0.0.1:${port(first.server)}`),
      p2: provider(`http://127.0.0.1:${port(second.server)}`),
    }));

    await messages(proxy.port, { headers: sessionHeaders("cooling") });
    proxy.breaker.reset();
    proxy.breaker.recordOutcome(breakerIdentity("p2", "m2"), { ok: false, status: 429, elapsedMs: 1 });
    const bypassed = await messages(proxy.port, { headers: sessionHeaders("cooling") });
    expect(bypassed.headers.get(STICKY_PROVENANCE_HEADER)).toBe("p2/m2 (bypassed: cooling)");

    proxy.breaker.reset();
    const rebound = await messages(proxy.port, { headers: sessionHeaders("cooling") });
    expect(rebound.headers.get(STICKY_PROVENANCE_HEADER)).toBe("p1/m1 (pinned, natural)");
  });

  it("bypasses a credential-faulted pin", async () => {
    const first = await scripted((call) => call === 1 ? { status: 401, body: RATE_LIMIT } : {});
    const second = await scripted(() => ({}));
    const proxy = await startProxy(stickyConfig({
      p1: provider(`http://127.0.0.1:${port(first.server)}`),
      p2: provider(`http://127.0.0.1:${port(second.server)}`),
    }));

    await messages(proxy.port, { headers: sessionHeaders("credential") });
    proxy.breaker.reset();
    proxy.breaker.recordCredentialFault(breakerIdentity("p2", "m2"), 401);
    const response = await messages(proxy.port, { headers: sessionHeaders("credential") });
    expect(response.headers.get(STICKY_PROVENANCE_HEADER)).toBe("p2/m2 (bypassed: credential-fault)");
    expect(first.calls()).toBe(2);
  });

  it("never promotes a degrade-tail pin across a live in-band candidate", async () => {
    const inBand = await scripted((call) => call === 1 ? { status: 429, body: RATE_LIMIT } : {});
    const degraded = await scripted(() => ({}));
    const config = stickyConfig({
      p1: provider(`http://127.0.0.1:${port(inBand.server)}`),
      p2: provider(`http://127.0.0.1:${port(degraded.server)}`),
    });
    config.routing.poolDegraded = { sticky: ["p2/m2"] };
    const proxy = await startProxy(config);

    await messages(proxy.port, { headers: sessionHeaders("degraded") });
    proxy.breaker.reset();
    const response = await messages(proxy.port, { headers: sessionHeaders("degraded") });
    expect(response.headers.get(STICKY_PROVENANCE_HEADER)).toBe("p2/m2 (bypassed: degraded)");
    expect(inBand.calls()).toBe(2);
    expect(degraded.calls()).toBe(1);
  });

  it("lets freeOnly prune a paid pin before sticky ordering", async () => {
    const free = await scripted((call) => call === 1
      ? { status: 429, body: RATE_LIMIT }
      : { body: OPENAI_OK });
    const paid = await scripted(() => ({ body: OPENAI_OK }));
    const config = stickyConfig({
      p1: openAiProvider(`http://127.0.0.1:${port(free.server)}`, "free"),
      p2: openAiProvider(`http://127.0.0.1:${port(paid.server)}`, "mixed"),
    });
    const proxy = await startProxy(config);

    await messages(proxy.port, { headers: sessionHeaders("free-only") });
    proxy.breaker.reset();
    config.routing.offload = { claude: { enabled: true, scope: "all", freeOnly: true } };
    const response = await messages(proxy.port, { headers: sessionHeaders("free-only") });
    expect(response.headers.get(STICKY_PROVENANCE_HEADER)).toBe("p2/m2 (bypassed: not-in-pool)");
    expect(free.calls()).toBe(2);
    expect(paid.calls()).toBe(1);
  });

  it("keeps request-local transport provider skip above affinity", async () => {
    const sameProvider = await scripted((call) => call === 2 ? { reset: true } : {});
    const fallback = await scripted(() => ({}));
    const config = stickyConfig({
      p1: provider(`http://127.0.0.1:${port(sameProvider.server)}`),
      p2: provider(`http://127.0.0.1:${port(fallback.server)}`),
    }, { sticky: ["p1/m1", "p1/m3", "p2/m2"] });
    const proxy = await startProxy(config);

    await messages(proxy.port, { headers: sessionHeaders("transport") });
    const response = await messages(proxy.port, { headers: sessionHeaders("transport") });
    expect(response.status).toBe(200);
    expect(response.headers.get(STICKY_PROVENANCE_HEADER)).toBe("p1/m1 (pinned, natural)");
    expect(sameProvider.calls()).toBe(2); // p1/m3 was removed with the failed p1 host
    expect(fallback.calls()).toBe(1);
  });

  it("lets an @relay directive choose a different pool", async () => {
    const p1 = await scripted(() => ({ status: 429, body: RATE_LIMIT }));
    const p2 = await scripted(() => ({}));
    const p3 = await scripted(() => ({}));
    const p4 = await scripted(() => ({}));
    const config = stickyConfig({
      p1: provider(`http://127.0.0.1:${port(p1.server)}`),
      p2: provider(`http://127.0.0.1:${port(p2.server)}`),
      p3: provider(`http://127.0.0.1:${port(p3.server)}`),
      p4: provider(`http://127.0.0.1:${port(p4.server)}`),
    }, { sticky: ["p1/m1", "p2/m2"], other: ["p3/m3", "p4/m4"] });
    // A directive is a per-call reroute and therefore defaults to freeOnly. These contained
    // Anthropic-shape fixtures have no price metadata, so opt out explicitly for this precedence
    // test; freeOnly dominance is pinned separately above.
    config.routing.offload = { claude: { enabled: false, scope: "subagents", freeOnly: false } };
    const proxy = await startProxy(config);

    const headers = sessionHeaders("directive", { "x-claude-code-agent-id": "directive-agent" });
    await messages(proxy.port, { headers });
    const response = await messages(proxy.port, {
      headers,
      messages: [{ role: "user", content: "@relay: pool/other\nDo the work" }],
    });
    expect(response.headers.get(STICKY_PROVENANCE_HEADER)).toBe("p2/m2 (bypassed: not-in-pool)");
    expect(p3.calls()).toBe(1);
    expect(p2.calls()).toBe(1);
  });

  it("compounds the verified Claude agent id so a child cannot clobber its parent", async () => {
    const first = await scripted((call) => call === 1 ? { status: 429, body: RATE_LIMIT } : {});
    const second = await scripted(() => ({}));
    const proxy = await startProxy(stickyConfig({
      p1: provider(`http://127.0.0.1:${port(first.server)}`),
      p2: provider(`http://127.0.0.1:${port(second.server)}`),
    }));

    await messages(proxy.port, { headers: sessionHeaders("family") });
    proxy.breaker.reset();
    const child = await messages(proxy.port, {
      headers: sessionHeaders("family", { "x-claude-code-agent-id": "agent-1" }),
    });
    expect(child.headers.get(STICKY_PROVENANCE_HEADER)).toBe("p1/m1 (new)");

    const parent = await messages(proxy.port, { headers: sessionHeaders("family") });
    expect(parent.headers.get(STICKY_PROVENANCE_HEADER)).toBe("p2/m2 (pinned, reordered)");
  });

  it("does not key on the design's unverified x-session-id rung", async () => {
    const first = await scripted((call) => call === 1 ? { status: 429, body: RATE_LIMIT } : {});
    const second = await scripted(() => ({}));
    const proxy = await startProxy(stickyConfig({
      p1: provider(`http://127.0.0.1:${port(first.server)}`),
      p2: provider(`http://127.0.0.1:${port(second.server)}`),
    }));
    const deadHeader = { "content-type": "application/json", "x-session-id": "unverified" };

    await messages(proxy.port, { headers: deadHeader, messages: [{ role: "user", content: "prompt A" }] });
    proxy.breaker.reset();
    const response = await messages(proxy.port, {
      headers: deadHeader,
      messages: [{ role: "user", content: "prompt B" }],
    });
    expect(response.headers.get(STICKY_PROVENANCE_HEADER)).toBe("p1/m1 (new)");
    expect(first.calls()).toBe(2);
  });

  it("does not create no-op pins for a single-spec route", async () => {
    const first = await scripted(() => ({}));
    const second = await scripted(() => ({}));
    const proxy = await startProxy(stickyConfig({
      p1: provider(`http://127.0.0.1:${port(first.server)}`),
      p2: provider(`http://127.0.0.1:${port(second.server)}`),
    }));

    const direct = await messages(proxy.port, { model: "p1/m1", headers: sessionHeaders("single") });
    expect(direct.headers.get(STICKY_PROVENANCE_HEADER)).toBeNull();
    const pooled = await messages(proxy.port, { headers: sessionHeaders("single") });
    expect(pooled.headers.get(STICKY_PROVENANCE_HEADER)).toBe("p1/m1 (new)");
  });

  it("uses one key and provenance policy on Anthropic, Chat, and Responses fronts", async () => {
    const first = await scripted((call) => call === 1 ? { status: 429, body: RATE_LIMIT } : {});
    const second = await scripted(() => ({}));
    const proxy = await startProxy(stickyConfig({
      p1: provider(`http://127.0.0.1:${port(first.server)}`),
      p2: provider(`http://127.0.0.1:${port(second.server)}`),
    }));
    const headers = sessionHeaders("cross-front");

    expect((await messages(proxy.port, { headers })).headers.get(STICKY_PROVENANCE_HEADER)).toBe("p2/m2 (new)");
    proxy.breaker.reset();
    expect((await chat(proxy.port, headers)).headers.get(STICKY_PROVENANCE_HEADER)).toBe("p2/m2 (pinned, reordered)");
    expect((await responses(proxy.port, headers)).headers.get(STICKY_PROVENANCE_HEADER)).toBe("p2/m2 (pinned, reordered)");
    expect(first.calls()).toBe(1);
    expect(second.calls()).toBe(3);
  });
});
