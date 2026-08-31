import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import {
  CircuitBreaker,
  type HeaderObservation,
} from "../src/circuit-breaker.js";
import { createProxy } from "../src/server.js";
import { ModelCatalog } from "../src/catalog.js";
import { makeCredentialId } from "../src/credential-id.js";
import { resetFacts } from "../src/target-facts.js";
import { resetInterpretations } from "../src/refusal-interpretation.js";
import type { Config, ProviderConfig } from "../src/config.js";
import type {
  AttemptFailed,
  AttemptHandle,
  AttemptOutcome,
  AttemptSucceeded,
  ProviderTargetIdentity,
} from "../src/kernel/contracts.js";
import type { QuotaObservation } from "../src/quota-observation.js";

const targetA: ProviderTargetIdentity = {
  provider: "provider-a",
  credentialId: "provider-a#default",
  model: "deployment-a",
  kind: "openai",
};
const targetB: ProviderTargetIdentity = {
  provider: "provider-a",
  credentialId: "provider-a#default",
  model: "deployment-b",
  kind: "openai",
};

function begin(breaker: CircuitBreaker, target = targetA): AttemptHandle {
  const result = breaker.beginAttempt(target);
  if (!result.ok) throw new Error(result.error.kind);
  return result.value;
}

function headers(
  target: ProviderTargetIdentity = targetA,
  overrides: Partial<HeaderObservation> = {},
): HeaderObservation {
  return {
    target,
    status: 200,
    elapsedMs: 7,
    observedAt: 1_007,
    ...overrides,
  };
}

function quota(
  axis: QuotaObservation["axis"],
  period: QuotaObservation["period"],
  remaining: number,
  observedAt = 1_007,
): QuotaObservation {
  return {
    axis,
    period,
    limit: 100,
    remaining,
    resetsAt: null,
    observedAt,
    basis: "provider-stated",
  };
}

function success(
  target: ProviderTargetIdentity = targetA,
  overrides: Partial<AttemptSucceeded> = {},
): AttemptSucceeded {
  return {
    target,
    terminal: "succeeded",
    provenance: "upstream",
    status: 200,
    completedAt: 1_050,
    elapsedMs: 50,
    ...overrides,
  };
}

function failure(
  target: ProviderTargetIdentity = targetA,
  overrides: Partial<AttemptFailed> = {},
): AttemptFailed {
  return {
    target,
    terminal: "failed",
    provenance: "upstream",
    failure: "http",
    status: 502,
    retryAfterMs: null,
    completedAt: 1_050,
    elapsedMs: 50,
    ...overrides,
  };
}

function stateBytes(breaker: CircuitBreaker): string {
  return JSON.stringify([...breaker.getAllStates()]);
}

function serialState(order: readonly AttemptOutcome[]): string {
  const breaker = new CircuitBreaker();
  const attempts = order.map(() => begin(breaker));
  order.forEach((outcome, index) => {
    expect(breaker.completeAttempt(attempts[index]!, outcome).ok).toBe(true);
  });
  return stateBytes(breaker);
}

function compatibilityState(order: readonly AttemptOutcome[]): string {
  const breaker = new CircuitBreaker();
  for (const outcome of order) {
    if (outcome.terminal === "cancelled") continue;
    const recorded = {
      ok: outcome.terminal === "succeeded",
      elapsedMs: outcome.elapsedMs,
      at: outcome.completedAt,
      ...(outcome.status !== null ? { status: outcome.status } : {}),
      ...(outcome.terminal === "failed" && outcome.retryAfterMs !== null
        ? { retryAfterMs: outcome.retryAfterMs }
        : {}),
    };
    breaker.recordOutcome(outcome.target, recorded);
  }
  return stateBytes(breaker);
}

describe("CircuitBreaker attempt lifecycle", () => {
  it("keeps 2xx headers provisional and commits only the terminal stream failure", () => {
    const breaker = new CircuitBreaker();
    const handle = begin(breaker);

    expect(breaker.observeHeaders(handle, headers()).ok).toBe(true);
    expect(breaker.getState(targetA)).toBeUndefined();

    expect(
      breaker.completeAttempt(
        handle,
        failure(targetA, {
          failure: "protocol",
          status: 502,
          completedAt: 1_080,
          elapsedMs: 80,
        }),
      ).ok,
    ).toBe(true);
    expect(breaker.getState(targetA)?.pings).toEqual([
      { code: "502", ms: 80, timestamp: 1_080 },
    ]);
    expect(breaker.getState(targetA)?.consecutiveFailures).toBe(1);
  });

  it("rejects duplicate completion without changing one byte of breaker state", () => {
    const breaker = new CircuitBreaker();
    const handle = begin(breaker);
    expect(breaker.completeAttempt(handle, failure()).ok).toBe(true);
    const before = stateBytes(breaker);

    const duplicate = breaker.completeAttempt(handle, success());

    expect(duplicate.ok).toBe(false);
    if (!duplicate.ok)
      expect(duplicate.error.kind).toBe("duplicate-completion");
    expect(stateBytes(breaker)).toBe(before);
  });

  it("rejects stale, foreign, and cross-target handles without breaker mutation", () => {
    const breaker = new CircuitBreaker();
    const other = new CircuitBreaker();
    const local = begin(breaker);
    const foreign = begin(other);
    const stale = {} as AttemptHandle;
    const before = stateBytes(breaker);

    const staleResult = breaker.completeAttempt(stale, failure());
    const foreignResult = breaker.completeAttempt(foreign, failure());
    const crossTargetResult = breaker.completeAttempt(local, failure(targetB));

    expect(staleResult.ok || staleResult.error.kind).toBe("stale-handle");
    expect(foreignResult.ok || foreignResult.error.kind).toBe("foreign-handle");
    expect(crossTargetResult.ok || crossTargetResult.error.kind).toBe(
      "cross-target",
    );
    expect(stateBytes(breaker)).toBe(before);

    // A rejected cross-target completion did not spend the valid local handle.
    expect(breaker.completeAttempt(local, success()).ok).toBe(true);
  });

  it("rejects duplicate and invalid header observations without health mutation", () => {
    const breaker = new CircuitBreaker();
    const other = new CircuitBreaker();
    const local = begin(breaker);
    const foreign = begin(other);
    expect(breaker.observeHeaders(local, headers()).ok).toBe(true);
    const before = stateBytes(breaker);

    const duplicate = breaker.observeHeaders(
      local,
      headers(targetA, { status: 204 }),
    );
    const stale = breaker.observeHeaders({} as AttemptHandle, headers());
    const foreignResult = breaker.observeHeaders(foreign, headers());
    const crossTarget = breaker.observeHeaders(
      begin(breaker),
      headers(targetB),
    );

    expect(duplicate.ok || duplicate.error.kind).toBe("duplicate-observation");
    expect(stale.ok || stale.error.kind).toBe("stale-handle");
    expect(foreignResult.ok || foreignResult.error.kind).toBe("foreign-handle");
    expect(crossTarget.ok || crossTarget.error.kind).toBe("cross-target");
    expect(stateBytes(breaker)).toBe(before);
  });

  it("makes handles stale on reset", () => {
    const breaker = new CircuitBreaker();
    const oldHandle = begin(breaker);
    breaker.recordOutcome(targetA, {
      ok: true,
      status: 200,
      elapsedMs: 1,
      at: 1,
    });
    breaker.reset();
    const before = stateBytes(breaker);

    const result = breaker.completeAttempt(oldHandle, failure());

    expect(result.ok || result.error.kind).toBe("stale-handle");
    expect(stateBytes(breaker)).toBe(before);
  });

  it("serializes same-target success/failure in the exact completion call order", () => {
    const failed = failure(targetA, { completedAt: 2_000, elapsedMs: 90 });
    const succeeded = success(targetA, { completedAt: 2_001, elapsedMs: 91 });

    const failureThenSuccess = serialState([failed, succeeded]);
    const successThenFailure = serialState([succeeded, failed]);

    expect(failureThenSuccess).toBe(compatibilityState([failed, succeeded]));
    expect(successThenFailure).toBe(compatibilityState([succeeded, failed]));
    expect(failureThenSuccess).not.toBe(successThenFailure);
  });

  it("does not change another deployment while same-target attempts interleave", () => {
    const breaker = new CircuitBreaker();
    breaker.recordOutcome(targetB, {
      ok: false,
      status: 503,
      elapsedMs: 13,
      at: 900,
      retryAfterMs: 30_000,
    });
    const otherBefore = JSON.stringify(breaker.getState(targetB));
    const first = begin(breaker);
    const second = begin(breaker);

    expect(breaker.completeAttempt(second, success()).ok).toBe(true);
    expect(breaker.completeAttempt(first, failure()).ok).toBe(true);

    expect(JSON.stringify(breaker.getState(targetB))).toBe(otherBefore);
  });

  it("preserves terminal latency, Retry-After, typed header quota, and bounded ping history", () => {
    const breaker = new CircuitBreaker();
    const limited = begin(breaker);
    expect(
      breaker.observeHeaders(
        limited,
        headers(targetA, {
          status: 429,
          quotaObservations: [quota("requests", "minute", 3)],
          retryAfterMs: 20_000,
        }),
      ).ok,
    ).toBe(true);
    expect(
      breaker.completeAttempt(
        limited,
        failure(targetA, {
          status: 429,
          completedAt: 10_000,
          elapsedMs: 123,
        }),
      ).ok,
    ).toBe(true);
    expect(breaker.getState(targetA)?.cooldownUntil).toBe(30_000);
    expect(breaker.getState(targetA)?.quotaObservations).toEqual([
      quota("requests", "minute", 3),
    ]);
    expect(breaker.getState(targetA)?.pings[0]).toEqual({
      code: "429",
      ms: 123,
      timestamp: 10_000,
    });

    for (let index = 0; index < 11; index++) {
      const handle = begin(breaker);
      expect(
        breaker.completeAttempt(
          handle,
          success(targetA, {
            completedAt: 11_000 + index,
            elapsedMs: 200 + index,
          }),
        ).ok,
      ).toBe(true);
    }
    expect(breaker.getState(targetA)?.pings).toHaveLength(10);
    expect(breaker.getState(targetA)?.pings[0]?.ms).toBe(201);
    expect(breaker.getState(targetA)?.pings[9]?.ms).toBe(210);
  });

  it("commits header quota independently for success and health failure", () => {
    const breaker = new CircuitBreaker();
    const cases: Array<{ status: number; outcome: AttemptOutcome; observation: QuotaObservation }> = [
      { status: 200, outcome: success(targetA), observation: quota("requests", "day", 60) },
      { status: 429, outcome: failure(targetA, { status: 429 }), observation: quota("tokens", "minute", 30) },
    ];
    for (const entry of cases) {
      const handle = begin(breaker);
      expect(breaker.observeHeaders(handle, headers(targetA, {
        status: entry.status,
        quotaObservations: [entry.observation],
      })).ok).toBe(true);
      expect(breaker.completeAttempt(handle, entry.outcome).ok).toBe(true);
    }
    expect(breaker.getState(targetA)?.quotaObservations).toEqual([
      quota("requests", "day", 60),
      quota("tokens", "minute", 30),
    ]);
  });

  it.each([401, 403])(
    "commits header quota independently for credential failure %s",
    (credentialStatus) => {
    const breaker = new CircuitBreaker();
    const handle = begin(breaker);
    const observation = quota("requests", "month", 20);
    expect(breaker.observeHeaders(handle, headers(targetA, {
      status: credentialStatus,
      quotaObservations: [observation],
    })).ok).toBe(true);
    expect(breaker.completeAttempt(handle, failure(targetA, {
      status: credentialStatus,
    })).ok).toBe(true);
    expect(breaker.getState(targetA)?.quotaObservations).toEqual([
      observation,
    ]);
    expect(breaker.getState(targetA)?.credentialFailures).toBe(1);
    },
  );

  it("commits valid quota from a relay mapper defect without provider health", () => {
    const breaker = new CircuitBreaker();
    const handle = begin(breaker);
    const observation = quota("tokens", "minute", 12);
    expect(breaker.observeHeaders(handle, headers(targetA, {
      status: 502,
      quotaObservations: [observation],
    })).ok).toBe(true);
    expect(breaker.completeAttempt(handle, failure(targetA, {
      provenance: "relay-mapper-defect",
      failure: "mapping",
      status: 502,
    })).ok).toBe(true);
    expect(breaker.getState(targetA)?.quotaObservations).toEqual([observation]);
    expect(breaker.getState(targetA)?.pings).toEqual([]);
  });

  it("snapshots quota observations before completion", () => {
    const breaker = new CircuitBreaker();
    const handle = begin(breaker);
    const observation = quota("requests", "minute", 25);
    const quotaObservations = [observation];
    expect(breaker.observeHeaders(handle, headers(targetA, {
      quotaObservations,
    })).ok).toBe(true);

    observation.remaining = 0;
    quotaObservations.push(quota("tokens", "day", 1));
    expect(breaker.completeAttempt(handle, success()).ok).toBe(true);
    expect(breaker.getState(targetA)?.quotaObservations).toEqual([
      quota("requests", "minute", 25),
    ]);
  });

  it("replaces only the matching quota axis and period on its exact credential/model cell", () => {
    const breaker = new CircuitBreaker();
    const sibling = { ...targetA, credentialId: "provider-a#work" };
    const first = begin(breaker);
    expect(breaker.observeHeaders(first, headers(targetA, {
      quotaObservations: [quota("requests", "day", 80), quota("tokens", "minute", 70)],
    })).ok).toBe(true);
    expect(breaker.completeAttempt(first, success()).ok).toBe(true);
    const replacement = begin(breaker);
    expect(breaker.observeHeaders(replacement, headers(targetA, {
      quotaObservations: [quota("requests", "day", 40, 2_000)],
    })).ok).toBe(true);
    expect(breaker.completeAttempt(replacement, success()).ok).toBe(true);
    const siblingHandle = begin(breaker, sibling);
    expect(breaker.observeHeaders(siblingHandle, headers(sibling, {
      quotaObservations: [quota("requests", "day", 5)],
    })).ok).toBe(true);
    expect(breaker.completeAttempt(siblingHandle, success(sibling)).ok).toBe(true);

    expect(breaker.getState(targetA)?.quotaObservations).toEqual([
      quota("requests", "day", 40, 2_000),
      quota("tokens", "minute", 70),
    ]);
    expect(breaker.getState(sibling)?.quotaObservations).toEqual([
      quota("requests", "day", 5),
    ]);
  });

  it("keeps credential failures separate and lets a terminal success recover them", () => {
    const breaker = new CircuitBreaker();
    const rejected = begin(breaker);
    expect(
      breaker.completeAttempt(
        rejected,
        failure(targetA, { status: 401, completedAt: 4_000 }),
      ).ok,
    ).toBe(true);
    expect(breaker.getState(targetA)).toMatchObject({
      consecutiveFailures: 0,
      credentialFailures: 1,
      lastCredentialStatus: 401,
      credentialFaultUntil: 304_000,
      pings: [],
    });

    const recovered = begin(breaker);
    expect(breaker.completeAttempt(recovered, success()).ok).toBe(true);
    expect(breaker.getState(targetA)?.credentialFailures).toBe(0);
    expect(breaker.getState(targetA)?.credentialFaultUntil).toBe(0);
  });

  it.each([413, 422])(
    "completes a client-error %s once without treating it as deployment health",
    (status) => {
      const breaker = new CircuitBreaker();
      const handle = begin(breaker);

      const completed = breaker.completeAttempt(
        handle,
        failure(targetA, { status }),
      );

      expect(completed.ok).toBe(true);
      expect(breaker.getState(targetA)).toBeUndefined();
      const duplicate = breaker.completeAttempt(
        handle,
        failure(targetA, { status }),
      );
      expect(duplicate.ok || duplicate.error.kind).toBe("duplicate-completion");
      expect(breaker.getState(targetA)).toBeUndefined();
    },
  );

  it("completes a relay mapper defect once without poisoning provider health", () => {
    const breaker = new CircuitBreaker();
    const handle = begin(breaker);
    const mapperFailure = failure(targetA, {
      provenance: "relay-mapper-defect",
      failure: "mapping",
      status: 502,
    });

    expect(breaker.completeAttempt(handle, mapperFailure).ok).toBe(true);
    expect(breaker.getState(targetA)).toBeUndefined();
    const duplicate = breaker.completeAttempt(handle, mapperFailure);
    expect(duplicate.ok || duplicate.error.kind).toBe("duplicate-completion");
    expect(breaker.getState(targetA)).toBeUndefined();
  });

  it("keys a passthrough target with a null model by credential", () => {
    const breaker = new CircuitBreaker();
    const passthrough: ProviderTargetIdentity = {
      provider: "passthrough",
      credentialId: "passthrough#default",
      model: null,
      kind: "anthropic",
    };
    const handle = begin(breaker, passthrough);
    expect(breaker.completeAttempt(handle, success(passthrough)).ok).toBe(true);

  expect(breaker.getDeploymentMeasurement(passthrough).pings).toHaveLength(1);
  expect(breaker.getState(passthrough)?.pings[0]?.code).toBe("200");
  expect(breaker.isHealthy(passthrough)).toBe(true);
  expect([...breaker.getAllStates().keys()]).toEqual(["passthrough#default"]);
});

  // Still true, and deliberately kept at `elapsedMs: 12`: a cancellation that short is BELOW the
  // evidence floor, so it invents nothing even though its cause is the one cause that can charge.
  it("accepts cancellation once without inventing a health observation", () => {
    const breaker = new CircuitBreaker();
    const handle = begin(breaker);
    const cancelled: AttemptOutcome = {
      target: targetA,
      terminal: "cancelled",
      provenance: "client-cancellation",
      cause: "client-gone-before-response",
      reason: "client disconnected",
      completedAt: 5_000,
      elapsedMs: 12,
    };

    expect(breaker.completeAttempt(handle, cancelled).ok).toBe(true);
    expect(breaker.getState(targetA)).toBeUndefined();
    const duplicate = breaker.completeAttempt(handle, cancelled);
    expect(duplicate.ok || duplicate.error.kind).toBe("duplicate-completion");
    expect(breaker.getState(targetA)).toBeUndefined();
  });

  it("counts leases credential-wide and releases exactly once on every terminal outcome", () => {
    const breaker = new CircuitBreaker();
    const sibling = { ...targetA, model: "other-model" };
    const first = begin(breaker, targetA);
    const second = begin(breaker, sibling);
    expect(breaker.inFlightCredential(targetA.credentialId)).toBe(2);
    expect(breaker.completeAttempt(first, success(targetA)).ok).toBe(true);
    expect(breaker.inFlightCredential(targetA.credentialId)).toBe(1);
    expect(breaker.completeAttempt(second, failure(sibling)).ok).toBe(true);
    expect(breaker.inFlightCredential(targetA.credentialId)).toBe(0);
    breaker.reset();
    expect(breaker.inFlightCredential(targetA.credentialId)).toBe(0);
  });
});

describe("CircuitBreaker cross-credential lifecycle", () => {
  const otherCredential: ProviderTargetIdentity = {
    ...targetA,
    credentialId: "provider-a#other",
  };

  it("rejects completion and observation under another credential on the same deployment", () => {
    const breaker = new CircuitBreaker();
    const handle = begin(breaker, targetA);
    const observation = breaker.observeHeaders(
      handle,
      headers(otherCredential),
    );
    expect(observation.ok).toBe(false);
    if (!observation.ok) expect(observation.error.kind).toBe("cross-target");
    const completion = breaker.completeAttempt(
      handle,
      failure(otherCredential),
    );
    expect(completion.ok).toBe(false);
    if (!completion.ok) expect(completion.error.kind).toBe("cross-target");
    expect(
      breaker.completeAttempt(handle, failure(targetA, { status: 401 })).ok,
    ).toBe(true);
    expect(breaker.hasCredentialFault(targetA, 1_051)).toBe(true);
    expect(breaker.hasCredentialFault(otherCredential, 1_051)).toBe(false);
  });
});

describe("front-level actual-egress attempt lifecycle", () => {
  interface Front {
    name: string;
    path: "/v1/messages" | "/v1/responses";
  }

  const fronts: Front[] = [
    { name: "Messages", path: "/v1/messages" },
    { name: "Responses", path: "/v1/responses" },
  ];
  const fleetEnv = ["LIFECYCLE_DEFAULT_KEY", "LIFECYCLE_WORK_KEY"] as const;
  const servers: Server[] = [];
  let savedEnv = new Map<string, string | undefined>();

  const bufferedCompletion = JSON.stringify({
    id: "completion",
    object: "chat.completion",
    choices: [{
      index: 0,
      message: { role: "assistant", content: "served" },
      finish_reason: "stop",
    }],
  });
  const streamedCompletion = [
    `data: ${JSON.stringify({ id: "completion", choices: [{ index: 0, delta: { role: "assistant", content: "served" }, finish_reason: null }] })}\n\n`,
    `data: ${JSON.stringify({ id: "completion", choices: [{ index: 0, delta: {}, finish_reason: "stop" }] })}\n\n`,
    "data: [DONE]\n\n",
  ].join("");

  class CountingBreaker extends CircuitBreaker {
    begins = 0;
    override beginAttempt(target: ProviderTargetIdentity) {
      this.begins += 1;
      return super.beginAttempt(target);
    }
  }

  beforeEach(() => {
    resetFacts();
    resetInterpretations();
    savedEnv = new Map();
    fleetEnv.forEach((name, index) => {
      savedEnv.set(name, process.env[name]);
      process.env[name] = index === 0 ? "lifecycle-default" : "lifecycle-work";
    });
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    const closing = servers.splice(0);
    for (const server of closing) server.closeAllConnections();
    await Promise.all(closing.map((server) => new Promise<void>((resolve) => server.close(() => resolve()))));
    resetFacts();
    resetInterpretations();
    for (const [name, value] of savedEnv) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
    savedEnv.clear();
  });

  function port(server: Server): number {
    return (server.address() as AddressInfo).port;
  }

  function listen(server: Server): Promise<Server> {
    return new Promise((resolve) => {
      server.listen(0, "127.0.0.1", () => {
        servers.push(server);
        resolve(server);
      });
    });
  }

  async function backend(
    body: string,
    contentType = "application/json",
  ): Promise<{ server: Server; calls: () => number }> {
    let calls = 0;
    const server = await listen(createServer((request, response) => {
      request.on("data", () => {});
      request.on("end", () => {
        calls += 1;
        response.writeHead(200, { "content-type": contentType });
        response.end(body);
      });
    }));
    return { server, calls: () => calls };
  }

  async function resettingBackend(): Promise<{ server: Server; calls: () => number }> {
    let calls = 0;
    const server = await listen(createServer((request) => {
      calls += 1;
      request.socket.destroy();
    }));
    return { server, calls: () => calls };
  }

  function config(bases: readonly string[]): Config {
    const providers: Record<string, ProviderConfig> = {};
    bases.forEach((base, index) => {
      providers[`p${index + 1}`] = {
        base,
        kind: "openai",
        credentialMode: "contained",
        credentials: [
          { label: "default", authEnv: fleetEnv[0] },
          { label: "work", authEnv: fleetEnv[1] },
        ],
        authHeader: "authorization",
        timeoutMs: 2_000,
      };
    });
    return {
      host: "127.0.0.1",
      port: 0,
      providers,
      routing: {
        default: "pool/lifecycle",
        tiers: {},
        benchmarkSort: false,
        pools: { lifecycle: bases.map((_, index) => `p${index + 1}/m${index + 1}`) },
      },
      mode: "detect",
      repair: { maxAttempts: 2, destructiveTools: [] },
      log: { level: "silent", file: null },
    };
  }

  async function proxyFor(bases: readonly string[], breaker: CircuitBreaker): Promise<Server> {
    return listen(createProxy(config(bases), {
      breaker,
      catalog: new ModelCatalog({ cachePath: null }),
    }));
  }

  function requestBody(front: Front, stream: boolean): Record<string, unknown> {
    if (front.path === "/v1/messages") {
      return {
        model: "pool/lifecycle",
        max_tokens: 32,
        stream,
        messages: [{ role: "user", content: "hi" }],
      };
    }
    return { model: "pool/lifecycle", input: "hi", stream };
  }

  function invalidRequestBody(front: Front): Record<string, unknown> {
    if (front.path === "/v1/messages") {
      return {
        model: "pool/lifecycle",
        messages: [{
          role: "user",
          content: [{ type: "document", source: { type: "url", url: "https://example.invalid/a.pdf" } }],
        }],
      };
    }
    return { model: "pool/lifecycle", input: [null] };
  }

  function post(front: Front, proxy: Server, body = requestBody(front, false)): Promise<Response> {
    return fetch(`http://127.0.0.1:${port(proxy)}${front.path}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });
  }

  function expectAllLeasesReleased(breaker: CircuitBreaker): void {
    for (const provider of ["p1", "p2"]) {
      expect(breaker.inFlightCredential(makeCredentialId(provider, "default"))).toBe(0);
      expect(breaker.inFlightCredential(makeCredentialId(provider, "work"))).toBe(0);
    }
  }

  it.each(fronts)("$name releases a buffered successful attempt after consumption", async (front) => {
    const first = await backend(bufferedCompletion);
    const second = await backend(bufferedCompletion);
    const breaker = new CountingBreaker();
    const proxy = await proxyFor([
      `http://127.0.0.1:${port(first.server)}`,
      `http://127.0.0.1:${port(second.server)}`,
    ], breaker);

    const response = await post(front, proxy);
    await response.text();

    expect(response.status).toBe(200);
    expect(first.calls()).toBe(1);
    expect(second.calls()).toBe(0);
    expect(breaker.begins).toBe(1);
    expectAllLeasesReleased(breaker);
  });

  it.each(fronts)("$name releases a discarded transport failure and its winner", async (front) => {
    const reset = await resettingBackend();
    const winner = await backend(bufferedCompletion);
    const breaker = new CountingBreaker();
    const proxy = await proxyFor([
      `http://127.0.0.1:${port(reset.server)}`,
      `http://127.0.0.1:${port(winner.server)}`,
    ], breaker);

    const response = await post(front, proxy);
    await response.text();

    expect(response.status).toBe(200);
    expect(reset.calls()).toBe(1);
    expect(winner.calls()).toBe(1);
    expect(breaker.begins).toBe(2);
    expectAllLeasesReleased(breaker);
  });

  it.each(fronts)("$name releases a streamed attempt only after full completion", async (front) => {
    const first = await backend(streamedCompletion, "text/event-stream");
    const second = await backend(streamedCompletion, "text/event-stream");
    const breaker = new CountingBreaker();
    const proxy = await proxyFor([
      `http://127.0.0.1:${port(first.server)}`,
      `http://127.0.0.1:${port(second.server)}`,
    ], breaker);

    const response = await post(front, proxy, requestBody(front, true));
    const body = await response.text();

    expect(response.status).toBe(200);
    expect(body).toContain("served");
    expect(first.calls()).toBe(1);
    expect(second.calls()).toBe(0);
    expect(breaker.begins).toBe(1);
    expectAllLeasesReleased(breaker);
  });

  it.each(fronts)("$name releases a post-egress relay mapper failure", async (front) => {
    const breaker = new CountingBreaker();
    const proxy = await proxyFor([
      "https://mapper-one.invalid/v1",
      "https://mapper-two.invalid/v1",
    ], breaker);
    const proxyBase = `http://127.0.0.1:${port(proxy)}`;
    const realFetch = globalThis.fetch;
    const upstreamUrls: string[] = [];
    const realResponseJson = Response.prototype.json;
    vi.spyOn(Response.prototype, "json").mockImplementation(function (this: Response) {
      if (this.headers.get("x-lifecycle-mapper-defect") === "yes") {
        let contentReads = 0;
        const message: Record<string, unknown> = {};
        Object.defineProperty(message, "content", {
          enumerable: true,
          get() {
            contentReads += 1;
            if (contentReads > 2) throw new Error("synthetic post-validation mapper failure");
            return "served";
          },
        });
        return Promise.resolve({
          id: "completion",
          choices: [{ message, finish_reason: "stop" }],
        });
      }
      return realResponseJson.call(this);
    });
    vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
      const url = typeof input === "string"
        ? input
        : input instanceof URL
          ? input.href
          : input.url;
      if (url.startsWith(proxyBase)) return realFetch(input, init);
      upstreamUrls.push(url);
      const upstream = new Response(bufferedCompletion, {
        status: 200,
        headers: {
          "content-type": "application/json",
          "x-lifecycle-mapper-defect": "yes",
        },
      });
      return upstream;
    });

    const response = await post(front, proxy);
    const body = await response.text();

    expect(response.status).toBe(502);
    expect(body).toContain("relay_mapper_defect");
    expect(upstreamUrls).toHaveLength(1);
    expect(breaker.begins).toBe(1);
    expectAllLeasesReleased(breaker);
  });

  it.each(fronts)("$name local rejection never begins an attempt", async (front) => {
    const first = await backend(bufferedCompletion);
    const second = await backend(bufferedCompletion);
    const breaker = new CountingBreaker();
    const proxy = await proxyFor([
      `http://127.0.0.1:${port(first.server)}`,
      `http://127.0.0.1:${port(second.server)}`,
    ], breaker);

    const response = await post(front, proxy, invalidRequestBody(front));
    await response.text();

    expect(response.status).toBe(400);
    expect(first.calls()).toBe(0);
    expect(second.calls()).toBe(0);
    expect(breaker.begins).toBe(0);
    expectAllLeasesReleased(breaker);
  });
});
