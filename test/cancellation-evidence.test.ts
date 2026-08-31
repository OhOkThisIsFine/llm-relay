/**
 * What a CANCELLED attempt teaches the breaker.
 *
 * Until this existed the breaker learned NOTHING from any cancellation: `applyTerminalOutcome`
 * opened with a flat `if (outcome.terminal === "cancelled") return;`, so a deployment that
 * out-waited the caller was never charged. Measured: a 65-second probe against a hanging member
 * taught it nothing at all.
 *
 * ⚠ **The negative controls are the point, and there are three of them.** The flat return could not
 * simply be deleted, because the SAME code path carries three different events:
 *   1. a caller who left while receiving an answer — says nothing about the deployment;
 *   2. a hedge loser the relay itself aborted — says something about `routing.hedge`, not about the
 *      deployment, and is a documented cost of hedging;
 *   3. a caller who left having received nothing — the case this feature exists for.
 * A version that charged all three would pass any test that only proved case 3 charges.
 *
 * ⚠ The cause is DERIVED from what the caller actually received, never read off the free-text
 * `reason`. The server half of this file is what proves that, because when a client disconnects
 * during a live hedge race the relay still retires the hedge with the fixed reason string
 * "hedge loser aborted" whatever the true cause.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { createServer, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { CircuitBreaker } from "../src/circuit-breaker.js";
import { createProxy, type ProxyDeps } from "../src/server.js";
import { ModelCatalog } from "../src/catalog.js";
import { resetFacts } from "../src/target-facts.js";
import { resetInterpretations } from "../src/refusal-interpretation.js";
import type { PingLoop } from "../src/ping/cadence.js";
import type {
  AttemptCancellationCause,
  AttemptCancelled,
  AttemptHandle,
  AttemptOutcome,
  ProviderTargetIdentity,
} from "../src/kernel/contracts.js";
import type { Config, ProviderConfig } from "../src/config.js";

const target: ProviderTargetIdentity = {
  provider: "p1",
  credentialId: "p1#default",
  model: "m1",
  kind: "openai",
};

/** Above the 60000 ms evidence floor, and the figure the measured incident actually produced. */
const LONG_MS = 65_000;

function begin(breaker: CircuitBreaker, identity = target): AttemptHandle {
  const result = breaker.beginAttempt(identity);
  if (!result.ok) throw new Error(result.error.kind);
  return result.value;
}

function cancelled(
  cause: AttemptCancellationCause,
  elapsedMs: number,
  identity = target,
): AttemptOutcome {
  return {
    target: identity,
    terminal: "cancelled",
    provenance: "client-cancellation",
    cause,
    reason: "irrelevant to policy — prose never decides",
    completedAt: 1_000_000,
    elapsedMs,
  };
}

function complete(breaker: CircuitBreaker, outcome: AttemptOutcome, identity = target): void {
  const handle = begin(breaker, identity);
  expect(breaker.completeAttempt(handle, outcome).ok).toBe(true);
}

describe("cancellation evidence — which cancellations reach provider health", () => {
  it("charges a caller who left having received nothing, once it ran long enough", () => {
    const breaker = new CircuitBreaker();
    complete(breaker, cancelled("client-gone-before-response", LONG_MS));

    const state = breaker.getState(target);
    expect(state).toBeDefined();
    expect(state?.consecutiveFailures).toBe(1);
    // Statusless, exactly as a transport failure is recorded: no provider status ever arrived.
    // That keeps it out of MEASURABLE_CODES, so an attempt of unknown true duration never enters a
    // latency statistic — it moves uptime, which is what it actually measured.
    expect(state?.pings.at(-1)?.code).toBe("500");
    expect(state?.pings.at(-1)?.ms).toBe(LONG_MS);
  });

  it("does NOT charge the same cause below the evidence floor", () => {
    const breaker = new CircuitBreaker();
    complete(breaker, cancelled("client-gone-before-response", 12));

    // No state row at all: a caller who changed their mind in 12 ms proves nothing, and inventing
    // a row would surface this deployment on four operator-facing surfaces for no reason.
    expect(breaker.getState(target)).toBeUndefined();
  });

  it("does NOT charge a caller who left while the answer was already reaching them", () => {
    const breaker = new CircuitBreaker();
    complete(breaker, cancelled("client-gone-mid-response", LONG_MS));

    expect(breaker.getState(target)).toBeUndefined();
  });

  it("does NOT charge a hedge loser the relay abandoned itself", () => {
    const breaker = new CircuitBreaker();
    complete(breaker, cancelled("relay-abandoned", LONG_MS));

    // The documented cost of hedging, kept deliberately. The relay stopped waiting; the loser might
    // have answered a millisecond later.
    expect(breaker.getState(target)).toBeUndefined();
  });

  it("does NOT charge an unusable elapsed measurement", () => {
    const breaker = new CircuitBreaker();
    complete(breaker, cancelled("client-gone-before-response", Number.NaN));

    // `NaN <= floor` is FALSE, so a comparison alone would have fallen through and charged.
    expect(breaker.getState(target)).toBeUndefined();
  });

  it("cools for the time the deployment actually wasted, not a flat default", () => {
    const breaker = new CircuitBreaker();
    complete(breaker, cancelled("client-gone-before-response", LONG_MS));
    complete(breaker, cancelled("client-gone-before-response", LONG_MS));

    const state = breaker.getState(target);
    // An admitted cancellation is above the default cooldown BY CONSTRUCTION, so the source is
    // always `elapsed` and never `default`. A cooldown shorter than the failure that earned it is
    // the v0.65.3 defect.
    expect(state?.cooldownSource).toBe("elapsed");
    expect(state?.cooldownUntil).toBe(1_000_000 + LONG_MS);
  });

  it("lets a later success clear what a cancellation charged", () => {
    const breaker = new CircuitBreaker();
    complete(breaker, cancelled("client-gone-before-response", LONG_MS));
    complete(breaker, cancelled("client-gone-before-response", LONG_MS));
    expect(breaker.getState(target)?.cooldownUntil).toBeGreaterThan(0);

    const handle = begin(breaker);
    breaker.completeAttempt(handle, {
      target,
      terminal: "succeeded",
      provenance: "upstream",
      status: 200,
      completedAt: 2_000_000,
      elapsedMs: 40,
    });

    expect(breaker.getState(target)?.cooldownUntil).toBe(0);
    expect(breaker.getState(target)?.consecutiveFailures).toBe(0);
  });

  it("routes every cause through one total table, so a new cause cannot default to charging", () => {
    const source = readFileSync(
      fileURLToPath(new URL("../src/circuit-breaker.ts", import.meta.url)),
      "utf8",
    );
    // The repo's most repeated defect is a closed union classified by a fall-through that resolves
    // to the STRONGER claim. A `satisfies` table makes a new member a compile error at the table.
    expect(source).toMatch(/satisfies Record<AttemptCancellationCause, boolean>/);
    expect(source).not.toMatch(/CANCELLATION_REACHES_HEALTH_PATH\[[^\]]+\]\s*\?\?/);
  });
});

describe("cancellation evidence — the cause is derived from what the caller received", () => {
  const servers: Server[] = [];
  const open: ServerResponse[] = [];
  const track = (s: Server): Server => (servers.push(s), s);
  const portOf = (s: Server): number => (s.address() as AddressInfo).port;

  beforeEach(() => {
    resetFacts();
    resetInterpretations();
  });
  afterEach(async () => {
    for (const r of open.splice(0)) if (!r.writableEnded) r.destroy();
    await Promise.all(servers.splice(0).map((s) => new Promise((r) => s.close(r))));
    resetFacts();
    resetInterpretations();
  });

  /** A real breaker that also records every cancelled outcome the server built. */
  function capturing(): { breaker: CircuitBreaker; seen: AttemptCancelled[] } {
    const breaker = new CircuitBreaker();
    const seen: AttemptCancelled[] = [];
    const original = breaker.completeAttempt.bind(breaker);
    breaker.completeAttempt = ((handle: AttemptHandle, outcome: AttemptOutcome) => {
      if (outcome.terminal === "cancelled") seen.push(outcome);
      return original(handle, outcome);
    }) as CircuitBreaker["completeAttempt"];
    return { breaker, seen };
  }

  function stubPingLoop(): PingLoop {
    return {
      start: () => {},
      stop: () => {},
      noteUserActivity: () => {},
      recordRequestLatency: () => {},
      getModelPings: () => [],
    } as unknown as PingLoop;
  }

  async function listen(server: Server): Promise<Server> {
    return new Promise((resolve) => server.listen(0, "127.0.0.1", () => resolve(track(server))));
  }

  /** Accepts the request, then holds the socket open forever without answering. */
  async function silentBackend(): Promise<Server> {
    return listen(createServer((request, response) => {
      request.on("data", () => {});
      request.on("end", () => {
        open.push(response);
        response.writeHead(200, { "content-type": "text/event-stream" });
        // Deliberately no body: the caller will leave having received nothing.
      });
    }));
  }

  /** Streams enough meaningful content to pass the commit probe, then holds. */
  async function committingBackend(): Promise<Server> {
    const event = (type: string, value: Record<string, unknown>): string =>
      `event: ${type}\ndata: ${JSON.stringify({ type, ...value })}\n\n`;
    return listen(createServer((request, response) => {
      request.on("data", () => {});
      request.on("end", () => {
        open.push(response);
        response.writeHead(200, { "content-type": "text/event-stream" });
        response.write(event("message_start", {
          message: { id: "m", type: "message", role: "assistant", model: "m", content: [], usage: { input_tokens: 1, output_tokens: 0 } },
        }));
        response.write(event("content_block_start", { index: 0, content_block: { type: "text", text: "" } }));
        response.write(event("content_block_delta", { index: 0, delta: { type: "text_delta", text: "hello there" } }));
        // Then it stalls. The caller has an answer in hand and leaves anyway.
      });
    }));
  }

  /**
   * ⚠ Answers OPENAI chat, because the hedge case must use an `openai`-kind provider: `costClassOf`
   * calls an anthropic-kind target PAID whatever its `tierType`, so hedging never fires on one and
   * a test built on it would silently prove nothing.
   */
  async function slowThenOkBackend(delayMs: number): Promise<{ server: Server; calls: () => number }> {
    let calls = 0;
    const body = JSON.stringify({
      id: "cmpl",
      object: "chat.completion",
      choices: [{ message: { role: "assistant", content: "ok" }, finish_reason: "stop" }],
      usage: { prompt_tokens: 1, completion_tokens: 1 },
    });
    const server = await listen(createServer((request, response) => {
      calls += 1;
      request.on("data", () => {});
      request.on("end", () => {
        const send = (): void => {
          response.writeHead(200, { "content-type": "application/json" });
          response.end(body);
        };
        if (delayMs === 0) send();
        else {
          open.push(response);
          setTimeout(send, delayMs).unref();
        }
      });
    }));
    return { server, calls: () => calls };
  }

  function config(bases: readonly string[], hedge: boolean): Config {
    const providers: Record<string, ProviderConfig> = {};
    bases.forEach((base, index) => {
      providers[`p${index + 1}`] = {
        base,
        // `openai` only for the hedge case, and deliberately: an anthropic-kind target resolves
        // PAID, and hedging is confined to FREE deployments, so it would never fire.
        kind: hedge ? "openai" : "anthropic",
        credentialMode: "contained",
        authHeader: hedge ? "authorization" : "x-api-key",
        timeoutMs: 30_000,
        ...(hedge ? { tierType: "free" } : {}),
      } as ProviderConfig;
    });
    return {
      host: "127.0.0.1",
      port: 0,
      providers,
      routing: {
        default: "pool/c",
        tiers: {},
        benchmarkSort: false,
        pools: { c: bases.map((_, index) => `p${index + 1}/m${index + 1}`) },
        hedge: (hedge ? { floorMs: 120 } : false) as never,
        latency: { enabled: false } as never,
      },
      mode: "detect",
      repair: { maxAttempts: 2, destructiveTools: [] },
      log: { level: "silent", file: null },
    } as Config;
  }

  async function proxy(c: Config, deps: ProxyDeps): Promise<Server> {
    return listen(createProxy(c, {
      catalog: new ModelCatalog({ cachePath: null }),
      pingLoop: stubPingLoop(),
      ...deps,
    }));
  }

  const body = (stream: boolean): string =>
    JSON.stringify({ model: "pool/c", max_tokens: 20, stream, messages: [{ role: "user", content: "hi" }] });

  /** The proxy notices a disconnect on its own schedule; poll rather than guess a sleep. */
  async function settled(seen: AttemptCancelled[]): Promise<void> {
    for (let i = 0; i < 200 && seen.length === 0; i += 1) {
      await new Promise((r) => setTimeout(r, 25));
    }
  }

  it("calls it before-response when the caller received nothing", async () => {
    const backend = await silentBackend();
    const { breaker, seen } = capturing();
    const p = await proxy(config([`http://127.0.0.1:${portOf(backend)}`], false), { breaker });

    const controller = new AbortController();
    const request = fetch(`http://127.0.0.1:${portOf(p)}/v1/messages`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: body(true),
      signal: controller.signal,
    });
    setTimeout(() => controller.abort(), 60).unref();
    await expect(request).rejects.toThrow();
    await settled(seen);

    expect(seen).toHaveLength(1);
    expect(seen[0]?.cause).toBe("client-gone-before-response");
  });

  it("calls it mid-response when the answer was already reaching the caller", async () => {
    const backend = await committingBackend();
    const { breaker, seen } = capturing();
    const p = await proxy(config([`http://127.0.0.1:${portOf(backend)}`], false), { breaker });

    const controller = new AbortController();
    const response = await fetch(`http://127.0.0.1:${portOf(p)}/v1/messages`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: body(true),
      signal: controller.signal,
    });
    expect(response.status).toBe(200);
    // Read until real bytes arrive, so the relay has certainly committed this attempt.
    const reader = response.body!.getReader();
    let received = 0;
    while (received === 0) {
      const chunk = await reader.read();
      if (chunk.done) break;
      received += chunk.value?.length ?? 0;
    }
    expect(received).toBeGreaterThan(0);
    controller.abort();
    await settled(seen);

    expect(seen).toHaveLength(1);
    expect(seen[0]?.cause).toBe("client-gone-mid-response");
    // And the deployment is charged nothing, however long the caller had been reading.
    expect(breaker.getState({ provider: "p1", credentialId: "p1#default", model: "m1", kind: "anthropic" }))
      .toBeUndefined();
  });

  it("calls a hedge loser relay-abandoned, not a client disconnect", async () => {
    const slow = await slowThenOkBackend(2_000);
    const fast = await slowThenOkBackend(0);
    const { breaker, seen } = capturing();
    const p = await proxy(
      config([`http://127.0.0.1:${portOf(slow.server)}`, `http://127.0.0.1:${portOf(fast.server)}`], true),
      { breaker },
    );

    const response = await fetch(`http://127.0.0.1:${portOf(p)}/v1/messages`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: body(false),
    });
    expect(response.status).toBe(200);
    await response.text();
    await settled(seen);

    // BOTH were really contacted, so this is a real race and not a relabelled failover.
    expect(slow.calls()).toBe(1);
    expect(fast.calls()).toBe(1);
    expect(seen).toHaveLength(1);
    expect(seen[0]?.cause).toBe("relay-abandoned");
  });
});
