import { describe, it, expect, afterEach } from "vitest";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { readFileSync, mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createProxy, buildForwardHeaders, CredentialConfigError } from "../src/server.js";
import { CircuitBreaker, globalCircuitBreaker } from "../src/circuit-breaker.js";
import type { Config, ResolvedTarget } from "../src/config.js";

/**
 * REL-47acf940 + INV-HS-8 (CP-NODE-5).
 *
 * A mid-stream backend failure used to escape past `h.logger.write` to the
 * server's top-level catch, which — with the head already committed — could only
 * `res.end()`. The client got a truncated 200 indistinguishable from a complete
 * answer and the turn NEVER appeared in the metadata log.
 *
 * These tests own their own server handles and temp dir so nothing leaks between
 * them; `test/server.test.ts` deliberately is not extended (it overwrites shared
 * handles, so only its last backend is ever closed).
 */

const openSockets: Server[] = [];

function port(s: Server): number {
  return (s.address() as AddressInfo).port;
}

function listen(s: Server): Promise<Server> {
  openSockets.push(s);
  return new Promise((resolve) => s.listen(0, "127.0.0.1", () => resolve(s)));
}

/** A backend that emits some SSE frames and then kills the connection mid-stream. */
function truncatingSseBackend(): Promise<Server> {
  return listen(
    createServer((_req, res) => {
      res.writeHead(200, { "content-type": "text/event-stream" });
      res.write(
        'event: message_start\ndata: {"type":"message_start","message":{"id":"m","type":"message","role":"assistant","model":"m","content":[],"stop_reason":null,"usage":{"input_tokens":1,"output_tokens":1}}}\n\n',
      );
      res.write('event: content_block_start\ndata: {"type":"content_block_start","index":0,"content_block":{"type":"text","text":""}}\n\n');
      // Destroy the socket without a terminating frame: the proxy's body iteration
      // throws, which is the exact condition this test exists for.
      setTimeout(() => res.socket?.destroy(), 20);
    }),
  );
}

/** A valid stream that stays open until the client disconnects. */
function slowSseBackend(): Promise<Server> {
  return listen(
    createServer((_req, res) => {
      res.writeHead(200, { "content-type": "text/event-stream" });
      res.write(
        'event: message_start\ndata: {"type":"message_start","message":{"id":"m","type":"message","role":"assistant","model":"m","content":[],"stop_reason":null,"usage":{"input_tokens":1,"output_tokens":0}}}\n\n',
      );
      const cadence = setInterval(() => {
        res.write('event: ping\ndata: {"type":"ping"}\n\n');
      }, 10);
      res.on("close", () => clearInterval(cadence));
    }),
  );
}

function cfgFor(backendPort: number, logFile: string, mode: Config["mode"]): Config {
  return {
    host: "127.0.0.1",
    port: 0,
    providers: { up: { base: `http://127.0.0.1:${backendPort}`, kind: "anthropic", authHeader: "x-api-key", timeoutMs: 5000 } },
    routing: { default: "up", tiers: {} },
    mode,
    repair: { maxAttempts: 2, destructiveTools: [] },
    log: { level: "metadata", file: logFile },
  };
}

function logLines(file: string): Record<string, unknown>[] {
  return readFileSync(file, "utf8")
    .split("\n")
    .filter((l) => l.trim().length > 0)
    .map((l) => JSON.parse(l) as Record<string, unknown>);
}

let dir: string | null = null;

afterEach(() => {
  for (const s of openSockets.splice(0)) s.close();
  if (dir) rmSync(dir, { recursive: true, force: true });
  dir = null;
});

describe("mid-stream backend failure (REL-47acf940)", () => {
  it("detect mode: emits an SSE error frame and still writes exactly one log record", async () => {
    dir = mkdtempSync(join(tmpdir(), "rp-midstream-"));
    const logFile = join(dir, "log.jsonl");
    const backend = await truncatingSseBackend();
    const proxy = await listen(createProxy(cfgFor(port(backend), logFile, "detect"), { breaker: globalCircuitBreaker }));

    const resp = await fetch(`http://127.0.0.1:${port(proxy)}/v1/messages`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ model: "mock-model", stream: true, messages: [{ role: "user", content: "hi" }] }),
    });
    const body = await resp.text();

    // The client can TELL it broke — the defect ended the stream silently.
    expect(body).toContain("event: error");
    expect(body).toContain("backend stream failed mid-response");

    const lines = logLines(logFile);
    expect(lines).toHaveLength(1);
    expect(lines[0]!.errorKinds).toEqual(["backend_stream_failed"]);
    // OBS-b5ade458: the record names the target that actually served the turn.
    expect(lines[0]!.servedProvider).toBe("up");
    expect(lines[0]!.attempts).toEqual([
      { provider: "up", model: null, status: "committed", ms: expect.any(Number) },
    ]);
  });

  it("repair mode: the same truncation is reported and logged, not silently ended", async () => {
    dir = mkdtempSync(join(tmpdir(), "rp-midstream-repair-"));
    const logFile = join(dir, "log.jsonl");
    const backend = await truncatingSseBackend();
    const cfg = cfgFor(port(backend), logFile, "repair");
    cfg.reshaper = { base: "http://127.0.0.1:1", kind: "openai", model: "stub", authHeader: "authorization", timeoutMs: 1000 };
    const proxy = await listen(createProxy(cfg, { breaker: globalCircuitBreaker }));

    const resp = await fetch(`http://127.0.0.1:${port(proxy)}/v1/messages`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        model: "mock-model",
        stream: true,
        tools: [{ name: "get", input_schema: { type: "object", properties: {}, required: [] } }],
        messages: [{ role: "user", content: "hi" }],
      }),
    });
    const body = await resp.text();

    expect(body).toContain("event: error");
    const lines = logLines(logFile);
    expect(lines).toHaveLength(1);
    expect(lines[0]!.errorKinds).toEqual(["backend_stream_failed"]);
    expect(lines[0]!.attempts).toEqual([
      { provider: "up", model: null, status: "committed", ms: expect.any(Number) },
    ]);
  });

  it("reports mid-stream failures to circuit breaker and trips breaker on repeated failures", async () => {
    dir = mkdtempSync(join(tmpdir(), "rp-midstream-cb-"));
    const logFile = join(dir, "log.jsonl");
    const backend = await truncatingSseBackend();
    const proxy = await listen(createProxy(cfgFor(port(backend), logFile, "detect"), { breaker: globalCircuitBreaker }));
    globalCircuitBreaker.reset();

    const doReq = () =>
      fetch(`http://127.0.0.1:${port(proxy)}/v1/messages`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ model: "mock-model", stream: true, messages: [{ role: "user", content: "hi" }] }),
      }).then((r) => r.text());

    await doReq();
    expect(globalCircuitBreaker.getState("up")?.consecutiveFailures).toBe(1);

    await doReq();
    expect(globalCircuitBreaker.getState("up")?.consecutiveFailures).toBe(2);
    expect(globalCircuitBreaker.isHealthy("up")).toBe(false);
  });

  it("treats a post-header client disconnect as cancellation, not provider failure", async () => {
    dir = mkdtempSync(join(tmpdir(), "rp-midstream-cancel-"));
    const backend = await slowSseBackend();
    const breaker = new CircuitBreaker();
    const proxy = await listen(createProxy(cfgFor(port(backend), join(dir, "log.jsonl"), "detect"), { breaker }));
    const controller = new AbortController();

    const resp = await fetch(`http://127.0.0.1:${port(proxy)}/v1/messages`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ model: "mock-model", stream: true, messages: [{ role: "user", content: "hi" }] }),
      signal: controller.signal,
    });
    await resp.body?.getReader().read();
    controller.abort();
    await new Promise((resolve) => setTimeout(resolve, 40));

    expect(breaker.getState("up")).toBeUndefined();
  });
});

describe("inbound credential removal (INV-HS-8)", () => {
  const base = { provider: "p", base: "http://127.0.0.1:1", kind: "anthropic", timeoutMs: 1000 } as unknown as ResolvedTarget;

  it("declared-missing REMOVES the caller's Authorization and x-api-key, then throws", () => {
    const varName = "LLM_RELAY_TEST_MISSING_KEY";
    delete process.env[varName];
    const target = { ...base, authEnv: varName } as ResolvedTarget;

    // The throw is the loud half. The removal is the half that matters if a future
    // routing change ever makes this branch reachable again.
    expect(() =>
      buildForwardHeaders({ authorization: "Bearer sk-ant-secret", "x-api-key": "sk-ant-secret" }, target),
    ).toThrow(CredentialConfigError);

    // Prove REMOVAL rather than merely "we added nothing": run the same input through
    // the declared-PRESENT path, which shares the identical strip, and assert neither
    // inbound credential survives.
    process.env[varName] = "provider-own-key";
    try {
      const out = buildForwardHeaders({ authorization: "Bearer sk-ant-secret", "x-api-key": "sk-ant-secret" }, target);
      // Not "we added nothing" — the caller's secret appears in NO forwarded value.
      expect(Object.values(out).some((v) => v.includes("sk-ant-secret"))).toBe(false);
    } finally {
      delete process.env[varName];
    }
  });

  it("a real passthrough (no authEnv declared) still forwards the caller's own credential", () => {
    const out = buildForwardHeaders({ authorization: "Bearer sk-ant-caller" }, base);
    expect(out["authorization"]).toBe("Bearer sk-ant-caller");
  });

  it('credentialMode "contained" strips the caller\'s credential from a keyless target', () => {
    // The gap this closes: "declares no key of its own" and "may be sent the user's subscription
    // credential" were the same state, so a keyless anthropic-format backend that is not the
    // caller's own vendor received their token purely because it needed none itself.
    const target = { ...base, credentialMode: "contained" } as ResolvedTarget;
    const out = buildForwardHeaders({ authorization: "Bearer sk-ant-caller", "x-api-key": "sk-ant-caller" }, target);
    expect(Object.values(out).some((v) => v.includes("sk-ant-caller"))).toBe(false);
  });

  it('credentialMode "passthrough" forwards it, identically to the inferred case', () => {
    const target = { ...base, credentialMode: "passthrough" } as ResolvedTarget;
    const out = buildForwardHeaders({ authorization: "Bearer sk-ant-caller" }, target);
    expect(out["authorization"]).toBe("Bearer sk-ant-caller");
  });
});

describe("streamed deadline split — stall watchdog vs total deadline (adoption review §1.2)", () => {
  // One flat timeoutMs mis-served streams in both directions: a healthy long generation was
  // killed at the deadline mid-answer, while a dead stream survived until the same deadline.
  // Once a stream is being served the total deadline disarms and an inter-byte watchdog takes
  // over; stallTimeoutMs: 0 keeps the old single-deadline behavior.

  /** Sends a valid stream head then goes silent forever — dead, but the socket stays open. */
  function stallingSseBackend(): Promise<Server> {
    return listen(
      createServer((_req, res) => {
        res.writeHead(200, { "content-type": "text/event-stream" });
        res.write(
          'event: message_start\ndata: {"type":"message_start","message":{"id":"m","type":"message","role":"assistant","model":"m","content":[],"stop_reason":null,"usage":{"input_tokens":1,"output_tokens":0}}}\n\n',
        );
      }),
    );
  }

  /** A healthy SLOW stream: pings every 100ms for ~700ms, then a clean message_stop. */
  function slowHealthySseBackend(): Promise<Server> {
    return listen(
      createServer((_req, res) => {
        res.writeHead(200, { "content-type": "text/event-stream" });
        res.write(
          'event: message_start\ndata: {"type":"message_start","message":{"id":"m","type":"message","role":"assistant","model":"m","content":[],"stop_reason":null,"usage":{"input_tokens":1,"output_tokens":0}}}\n\n',
        );
        let n = 0;
        const cadence = setInterval(() => {
          n++;
          res.write('event: ping\ndata: {"type":"ping"}\n\n');
          if (n >= 6) {
            clearInterval(cadence);
            res.write('event: message_stop\ndata: {"type":"message_stop"}\n\n');
            res.end();
          }
        }, 100);
        res.on("close", () => clearInterval(cadence));
      }),
    );
  }

  function stallCfg(backendPort: number, logFile: string, timeoutMs: number, stallTimeoutMs: number): Config {
    return {
      host: "127.0.0.1",
      port: 0,
      providers: {
        up: { base: `http://127.0.0.1:${backendPort}`, kind: "anthropic", authHeader: "x-api-key", timeoutMs, stallTimeoutMs },
      },
      routing: { default: "up", tiers: {} },
      mode: "detect",
      repair: { maxAttempts: 2, destructiveTools: [] },
      log: { level: "metadata", file: logFile },
    };
  }

  const streamReq = (proxyPort: number) =>
    fetch(`http://127.0.0.1:${proxyPort}/v1/messages`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ model: "mock-model", stream: true, messages: [{ role: "user", content: "hi" }] }),
    });

  it("a silent stream is aborted by the watchdog long before the total deadline", async () => {
    dir = mkdtempSync(join(tmpdir(), "rp-stall-dead-"));
    const backend = await stallingSseBackend();
    const proxy = await listen(
      createProxy(stallCfg(port(backend), join(dir, "log.jsonl"), 30_000, 150), { breaker: globalCircuitBreaker }),
    );

    const started = Date.now();
    const body = await (await streamReq(port(proxy))).text();
    expect(Date.now() - started).toBeLessThan(10_000); // nowhere near the 30s total deadline
    expect(body).toContain("event: message_start"); // streamed prefix reached the client
    expect(body).toContain("event: error"); // …and the death was reported, not silently ended
  });

  it("a healthy slow stream OUTLIVES the total deadline — it disarms once the stream is served", async () => {
    dir = mkdtempSync(join(tmpdir(), "rp-stall-slow-"));
    const backend = await slowHealthySseBackend();
    // timeoutMs 250 < the ~700ms the stream takes: the old single deadline killed this mid-answer.
    const proxy = await listen(
      createProxy(stallCfg(port(backend), join(dir, "log.jsonl"), 250, 5_000), { breaker: globalCircuitBreaker }),
    );

    const body = await (await streamReq(port(proxy))).text();
    expect(body).toContain("event: message_stop"); // ran to completion
    expect(body).not.toContain("event: error");
  });

  it("stallTimeoutMs: 0 keeps the old single-deadline behavior", async () => {
    dir = mkdtempSync(join(tmpdir(), "rp-stall-off-"));
    const backend = await slowHealthySseBackend();
    const proxy = await listen(
      createProxy(stallCfg(port(backend), join(dir, "log.jsonl"), 250, 0), { breaker: globalCircuitBreaker }),
    );

    const body = await (await streamReq(port(proxy))).text();
    expect(body).toContain("event: error"); // the total deadline still spans the stream
    expect(body).not.toContain("event: message_stop");
  });
});
