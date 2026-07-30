import { describe, it, expect, afterEach } from "vitest";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { readFileSync, mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createProxy, buildForwardHeaders, CredentialConfigError } from "../src/server.js";
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

function cfgFor(backendPort: number, logFile: string, mode: Config["mode"]): Config {
  return {
    host: "127.0.0.1",
    port: 0,
    providers: { up: { base: `http://127.0.0.1:${backendPort}`, kind: "anthropic", timeoutMs: 5000 } },
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
    const proxy = await listen(createProxy(cfgFor(port(backend), logFile, "detect")));

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
  });

  it("repair mode: the same truncation is reported and logged, not silently ended", async () => {
    dir = mkdtempSync(join(tmpdir(), "rp-midstream-repair-"));
    const logFile = join(dir, "log.jsonl");
    const backend = await truncatingSseBackend();
    const cfg = cfgFor(port(backend), logFile, "repair");
    cfg.reshaper = { base: "http://127.0.0.1:1", kind: "openai", model: "stub", timeoutMs: 1000 };
    const proxy = await listen(createProxy(cfg));

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
});
