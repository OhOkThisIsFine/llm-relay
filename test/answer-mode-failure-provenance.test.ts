/**
 * A failed answer-mode job must name WHAT failed.
 *
 * Measured 2026-09-05 (C:\Code\docs\backlog.md): `dispatch(mode: "answer", tier: "high",
 * waitMs: 40000)` returned `job-0002`, which `dispatch_status` reported `failed` after 205 s with
 * `relay answered HTTP 504`. ⚠ The relay's own `/v1/messages` answered that 504, so the message
 * names the LANE as the failure and says nothing about the upstream — the caller cannot tell a
 * pool exhaustion (every pool member refused) from a relay-side timeout, which call for opposite
 * responses: wait for the pool, or fix the relay.
 *
 * ⚠ The relay already STATES the answer on its own response headers —
 * `x-llm-relay-pool-attempts` is literally the attempt timeline ("13 tried, 0 served: 4x402 …")
 * and `x-llm-relay-served-by` the spec. The fix is to read them on the failure path, which
 * reverses this module's earlier rule ("never read headers on a failure") for the FIVE relay-owned
 * announcement names only. That rule was written to keep a provider's arbitrary headers out of a
 * relay-authored message; an allow-list of headers the relay itself sets carries no such risk, and
 * the alternative is a failure the caller cannot act on.
 */
import { describe, expect, it } from "vitest";
import { McpDispatchServer, type DispatchViewBuilder } from "../src/mcp/server.js";
import type { Config } from "../src/config.js";
import type { DispatchLane, DispatchView } from "../src/dispatch.js";

const RELAY_LANE: DispatchLane = {
  id: "free-pool",
  kind: "relay",
  position: 1,
  state: "ready",
  spec: "pool/high",
};

function view(): DispatchView {
  return {
    tier: "high",
    offload: false,
    client: "claude",
    host: "bypassed",
    ladder: [RELAY_LANE],
    order: [RELAY_LANE.id],
    next: RELAY_LANE,
    reason: "first ready lane",
  };
}

/**
 * A relay answering 504 with the headers its own walk exit writes. `Response` is the REAL
 * constructor — the header allow-list under test is the thing that reads it.
 */
function failingRelay(status: number, headers: Record<string, string>, body: string): typeof fetch {
  return (async () =>
    new Response(body, { status, headers })) as unknown as typeof fetch;
}

async function runDispatch(fetchImpl: typeof fetch): Promise<string> {
  const out: string[] = [];
  const buildView: DispatchViewBuilder = async () => view();
  const server = new McpDispatchServer({
    config: { host: "127.0.0.1", port: 8791, routing: {} } as unknown as Config,
    buildView,
    spawn: () => ({
      result: Promise.resolve({ code: 0, stdout: "", stderr: "", timedOut: false }),
      kill: () => {},
    }),
    fetch: fetchImpl,
    cwd: () => process.cwd(),
    write: (chunk) => out.push(chunk),
  });
  await server.ingest(
    JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method: "tools/call",
      params: { name: "dispatch", arguments: { task: "design this", mode: "answer" } },
    }) + "\n",
  );
  const body = JSON.parse(out[0] as string) as { result: { content: Array<{ text: string }> } };
  return body.result.content[0]?.text ?? "";
}

describe("answer-mode failure provenance", () => {
  it("names the attempt timeline the relay stated, not just the status code", async () => {
    const text = await runDispatch(
      failingRelay(
        504,
        {
          "x-llm-relay-pool-attempts": "4 tried, 0 served: 3x429, 1x504",
          "x-llm-relay-served-by": "nim/deepseek-ai/deepseek-v4-flash",
        },
        "upstream timeout",
      ),
    );

    // ⚠ RED on HEAD: the message was `relay answered HTTP 504` and nothing else — the headers the
    // relay had already written were deliberately dropped.
    expect(text).toContain("relay answered HTTP 504");
    expect(text).toContain("4 tried, 0 served: 3x429, 1x504");
    expect(text).toContain("nim/deepseek-ai/deepseek-v4-flash");
  });

  it("names the model this dispatch asked the relay for", async () => {
    const text = await runDispatch(failingRelay(504, {}, "upstream timeout"));
    // Even with no relay headers at all, the spec is the relay-side fact the caller already holds.
    expect(text).toContain("pool/high");
  });

  it("still passes a successful answer through unchanged", async () => {
    const ok = (async () =>
      new Response(JSON.stringify({ content: [{ type: "text", text: "the answer" }] }), {
        status: 200,
        headers: { "content-type": "application/json", "x-llm-relay-served-by": "pool/high" },
      })) as unknown as typeof fetch;
    const text = await runDispatch(ok);
    expect(text).toContain("the answer");
    expect(text).toContain("served-by: pool/high");
  });
});
