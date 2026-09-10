/**
 * The MCP dispatch server: protocol conformance, the dispatch verb, the async job path, and every
 * refusal. Nothing here spawns a real lane — the spawner is injected, which is also the property
 * being asserted (a suite must never spend the operator's quota).
 */
import { describe, expect, it, vi } from "vitest";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  LANE_LADDER_EXHAUSTED_ADVICE,
  LANE_LADDER_PARTIAL_ADVICE,
  MCP_INSTRUCTIONS,
  McpDispatchServer,
  type DispatchViewBuilder,
  type McpServerDeps,
} from "../src/mcp/server.js";
import {
  DEPTH_ENV,
  LaneJobStore,
  TERMINAL_JOB_STATUSES,
  classifyDispatchedResult,
  checkCwd,
  currentDepth,
  defaultAnswerFetch,
  defaultLaneSpawner,
  isContentEmpty,
  type LaneRunResult,
  type LaneSpawner,
} from "../src/mcp/lane-runner.js";
import { createJobJournal } from "../src/mcp/job-journal.js";
import {
  SUPPORTED_PROTOCOL_VERSIONS,
  encodeMessage,
  negotiateProtocolVersion,
  splitMessages,
} from "../src/mcp/protocol.js";
import type { Config } from "../src/config.js";
import type { DispatchLane, DispatchView } from "../src/dispatch.js";

// ---------------------------------------------------------------------------------------------
// Harness

function lane(over: Partial<DispatchLane> = {}): DispatchLane {
  return {
    id: "free-pool",
    kind: "relay",
    position: 1,
    state: "ready",
    spec: "pool/medium",
    invoke: { command: "claude", args: ["-p", "the task"] },
    ...over,
  };
}

/**
 * A lane with NO runnable command. Built by deleting the key rather than assigning `undefined`,
 * because `exactOptionalPropertyTypes` distinguishes the two and only absence matches the real
 * shape a relay rung has when it could not be transposed.
 */
function laneWithoutInvoke(over: Partial<DispatchLane> = {}): DispatchLane {
  const { invoke: _invoke, ...rest } = lane(over);
  return rest;
}

function view(over: Partial<DispatchView> = {}): DispatchView {
  const next = over.next === undefined ? lane() : over.next;
  return {
    tier: "medium",
    offload: false,
    client: "claude",
    host: "bypassed",
    ladder: next ? [next] : [],
    order: next ? [next.id] : [],
    next,
    reason: "first ready lane",
    ...over,
  };
}

/** A spawner that resolves with a fixed result, and records what it was called with. */
function fakeSpawner(result: LaneRunResult, delayMs = 0): LaneSpawner & { calls: Parameters<LaneSpawner>[] } {
  const calls: Parameters<LaneSpawner>[] = [];
  const fn: LaneSpawner = (command, args, opts) => {
    calls.push([command, args, opts]);
    let settle: (r: LaneRunResult) => void = () => {};
    const promise = new Promise<LaneRunResult>((resolve) => {
      settle = resolve;
      if (delayMs === 0) resolve(result);
      else setTimeout(() => resolve(result), delayMs).unref?.();
    });
    return { result: promise, kill: () => settle({ code: null, stdout: "", stderr: "killed", timedOut: false }) };
  };
  return Object.assign(fn, { calls });
}

class Harness {
  readonly out: string[] = [];
  readonly server: McpDispatchServer;
  private id = 0;

  constructor(over: Partial<McpServerDeps> = {}) {
    const builder: DispatchViewBuilder = async () => view();
    this.server = new McpDispatchServer({
      config: { host: "127.0.0.1", port: 8791 } as Config,
      buildView: over.buildView ?? builder,
      spawn: over.spawn ?? fakeSpawner({ code: 0, stdout: "lane answer", stderr: "", timedOut: false }),
      cwd: over.cwd ?? (() => process.cwd()),
      write: (chunk) => this.out.push(chunk),
      ...over,
    });
  }

  async request(method: string, params?: unknown): Promise<Record<string, unknown>> {
    this.id += 1;
    const before = this.out.length;
    await this.server.ingest(JSON.stringify({ jsonrpc: "2.0", id: this.id, method, params }) + "\n");
    const line = this.out[before];
    expect(line, `no response for ${method}`).toBeDefined();
    return JSON.parse(line as string) as Record<string, unknown>;
  }

  async tool(name: string, args: Record<string, unknown> = {}): Promise<{ text: string; isError: boolean }> {
    const res = await this.request("tools/call", { name, arguments: args });
    const result = res["result"] as { content: { text: string }[]; isError: boolean };
    return { text: result.content[0]?.text ?? "", isError: result.isError };
  }
}

// ---------------------------------------------------------------------------------------------

describe("mcp protocol framing", () => {
  it("splits newline-delimited messages and carries a partial tail", () => {
    const { lines, rest } = splitMessages('{"a":1}\n{"b":2}\n{"c":');
    expect(lines).toEqual(['{"a":1}', '{"b":2}']);
    expect(rest).toBe('{"c":');
  });

  it("handles CRLF without leaving a stray carriage return on the JSON", () => {
    const { lines } = splitMessages('{"a":1}\r\n{"b":2}\r\n');
    expect(lines).toEqual(['{"a":1}', '{"b":2}']);
    // The whole point: each line must still parse.
    expect(() => lines.map((l) => JSON.parse(l))).not.toThrow();
  });

  it("skips blank padding lines rather than reporting a parse error", () => {
    const { lines } = splitMessages('\n\n{"a":1}\n   \n');
    expect(lines).toEqual(['{"a":1}']);
  });

  it("encodes exactly one line per message", () => {
    const encoded = encodeMessage({ jsonrpc: "2.0", id: 1, result: { text: "has\nnewline" } });
    expect(encoded.endsWith("\n")).toBe(true);
    expect(encoded.trimEnd().includes("\n")).toBe(false);
  });

  it("echoes a supported protocol revision and falls back for anything else", () => {
    for (const v of SUPPORTED_PROTOCOL_VERSIONS) expect(negotiateProtocolVersion(v)).toBe(v);
    // ⚠ Never echo a revision we do not implement — that claims a capability we lack.
    expect(negotiateProtocolVersion("1999-01-01")).toBe(SUPPORTED_PROTOCOL_VERSIONS[0]);
    expect(negotiateProtocolVersion(undefined)).toBe(SUPPORTED_PROTOCOL_VERSIONS[0]);
    expect(negotiateProtocolVersion(42)).toBe(SUPPORTED_PROTOCOL_VERSIONS[0]);
  });

  it("speaks the revision Claude Code actually asks for, and does NOT claim 2026-07-28", () => {
    // ⚠ Both halves are regressions, captured from a real handshake with Claude Code 2.1.237.
    // It sends `2025-11-25`. That was missing, so the fallback answered `2026-07-28` and the
    // client refused: "Server's protocol version is not supported: 2026-07-28".
    expect(negotiateProtocolVersion("2025-11-25")).toBe("2025-11-25");
    // `2026-07-28` adds `server/discover`, which this server does not implement. Listing a
    // revision we do not serve is what made the fallback dangerous in the first place.
    expect(SUPPORTED_PROTOCOL_VERSIONS as readonly string[]).not.toContain("2026-07-28");
  });

  it("declines server/discover with -32601 so a 2026-07-28-aware client falls back", async () => {
    // Claude Code probes `server/discover` BEFORE `initialize`. Answering "method not found" is
    // correct and the client then negotiates normally — verified live.
    const h = new Harness();
    const res = await h.request("server/discover", {});
    expect((res["error"] as { code: number }).code).toBe(-32601);
  });
});

describe("mcp server handshake", () => {
  it("answers initialize with tools capability and the injected version", async () => {
    const h = new Harness({ version: "9.9.9" });
    const res = await h.request("initialize", { protocolVersion: "2025-06-18" });
    const result = res["result"] as Record<string, unknown>;
    expect(result["protocolVersion"]).toBe("2025-06-18");
    expect(result["capabilities"]).toEqual({ tools: { listChanged: false } });
    expect(result["serverInfo"]).toEqual({ name: "llm-relay", version: "9.9.9" });
  });

  it("serves the instructions constant on the wire, never a second hand-written copy", async () => {
    const h = new Harness();
    const res = await h.request("initialize", {});
    const result = res["result"] as Record<string, unknown>;
    expect(result["instructions"]).toBe(MCP_INSTRUCTIONS);
  });

  it("states WHEN to delegate, not only what the tool is", () => {
    // ⚠ This pins CLAIMS, not prose. An MCP host puts `instructions` in the model's system prompt
    // unconditionally, so it is the one channel that cannot be deferred or missed — and until
    // 2026-08-30 it carried only the "what". The measured consequence: the operator had to say
    // "use llm-relay for offload" out loud, on a machine whose own global instructions already
    // said "PREFER THE MCP TOOL" in bold. Reword freely; if you drop one of these three claims,
    // update this test deliberately rather than deleting the assertion.
    const text = MCP_INSTRUCTIONS.toLowerCase();
    // 1. The trigger is unprompted. Without this the model waits to be told.
    expect(text).toContain("without being asked");
    // 2. Offloading is cheap, which is the reason to prefer it.
    expect(text).toContain("free capacity");
    // 3. And the answer is not authoritative, which bounds what the model may do with it.
    expect(text).toContain("advisory");
    // 4. The always-loaded instructions state why shelling out is the wrong Windows fallback,
    // while keeping the third-party descendant boundary explicit instead of promising too much.
    expect(text).toContain("hidden child creation");
    expect(text).toContain("closes stdin");
    expect(text).toContain("agent alias");
    expect(text).toContain("visible descendants");
    // 5. Every host gets the same decision rule. In particular, Codex Desktop must not try the
    // generated pool/* collaboration child that its ChatGPT launcher rejects before the custom
    // provider is contacted; the always-loaded instructions must name both the trap and the
    // working route so a model never has to rediscover it.
    expect(text).toContain("codex desktop");
    expect(text).toContain("before reaching the relay");
    expect(text).toContain("--next-command");
  });

  it("carries the unprompted trigger on the dispatch tool description too", async () => {
    // Belt and braces: a host that ignores `initialize` instructions still reads tool
    // descriptions, and that host would otherwise get the "what" with no "when".
    const h = new Harness();
    const res = await h.request("tools/list");
    const tools = (res["result"] as { tools: { name: string; description: string }[] }).tools;
    const dispatch = tools.find((t) => t.name === "dispatch");
    const description = dispatch?.description.toLowerCase() ?? "";
    expect(description).toContain("without being asked");
    expect(description).toContain("codex desktop");
    expect(description).toContain("collaboration child");
  });

  it("reports the version as unknown rather than a fake 0.0.0 when none is injected", async () => {
    const h = new Harness();
    const res = await h.request("initialize", {});
    const info = (res["result"] as Record<string, unknown>)["serverInfo"] as Record<string, string>;
    // Regression: reading `npm_package_version` here reported "0.0.0" to every real host, because
    // a host launches the binary directly and npm never sets that variable.
    expect(info["version"]).toBe("unknown");
  });

  it("NEVER answers a notification", async () => {
    // ⚠ Mutation-checked 2026-08-30, and the result is worth recording: this passes under a
    // mutation of EITHER guard alone. `isJsonRpcNotification` and `isJsonRpcRequest`'s id check
    // each stop it independently, so a single-line mutation leaves the behaviour intact and the
    // suite green. Breaking BOTH turns this test red. That is defense in depth, not an unasserted
    // test — but do not read a green single mutation here as proof the test is weak.
    const h = new Harness();
    await h.server.ingest(JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }) + "\n");
    expect(h.out).toHaveLength(0);
  });

  it("answers an unparseable line without dropping the connection", async () => {
    const h = new Harness();
    await h.server.ingest("this is not json\n");
    expect(h.out).toHaveLength(1);
    const msg = JSON.parse(h.out[0] as string) as { error: { code: number } };
    expect(msg.error.code).toBe(-32700);
    // Still alive afterwards.
    const res = await h.request("ping");
    expect(res["result"]).toEqual({});
  });

  it("reports an unknown method as -32601", async () => {
    const h = new Harness();
    const res = await h.request("no/such/method");
    expect((res["error"] as { code: number }).code).toBe(-32601);
  });

  it("lists exactly the five dispatch tools", async () => {
    const h = new Harness();
    const res = await h.request("tools/list");
    const tools = (res["result"] as { tools: { name: string }[] }).tools;
    expect(tools.map((t) => t.name)).toEqual([
      "dispatch",
      "dispatch_status",
      "dispatch_result",
      "dispatch_cancel",
      "dispatch_lanes",
    ]);
  });

  it("handles a message split across two stdin chunks", async () => {
    const h = new Harness();
    const msg = JSON.stringify({ jsonrpc: "2.0", id: 1, method: "ping" }) + "\n";
    await h.server.ingest(msg.slice(0, 10));
    expect(h.out).toHaveLength(0);
    await h.server.ingest(msg.slice(10));
    expect(h.out).toHaveLength(1);
  });
});

describe("dispatch tool", () => {
  it("runs the selected lane and returns its answer with provenance", async () => {
    const spawn = fakeSpawner({ code: 0, stdout: "the lane's answer", stderr: "", timedOut: false });
    const h = new Harness({ spawn });
    const { text, isError } = await h.tool("dispatch", { task: "do the thing" });
    expect(isError).toBe(false);
    expect(text).toContain("the lane's answer");
    // Provenance rides every answer — dispatch never pretends a CLI answered.
    expect(text).toContain("lane: free-pool (pool/medium)");
    expect(text).toContain("status: completed");
    expect(spawn.calls).toHaveLength(1);
  });

  it("names local fallback in provenance when dispatch view fell back", async () => {
    const spawn = fakeSpawner({ code: 0, stdout: "fallback answer", stderr: "", timedOut: false });
    const h = new Harness({
      spawn,
      buildView: async () => view({ source: "local-fallback" }),
    });
    const { text, isError } = await h.tool("dispatch", { task: "do something" });
    expect(isError).toBe(false);
    expect(text).toContain("dispatch-source: local-fallback (daemon unreachable)");
    expect(text).toContain("fallback answer");
  });

  it("omits fallback note in provenance when dispatch view came from live daemon", async () => {
    const spawn = fakeSpawner({ code: 0, stdout: "live answer", stderr: "", timedOut: false });
    const h = new Harness({
      spawn,
      buildView: async () => view({ source: "daemon" }),
    });
    const { text, isError } = await h.tool("dispatch", { task: "do something" });
    expect(isError).toBe(false);
    expect(text).not.toContain("dispatch-source: local-fallback");
    expect(text).toContain("live answer");
  });

  it("refuses an empty task", async () => {
    const h = new Harness();
    const { text, isError } = await h.tool("dispatch", {});
    expect(isError).toBe(true);
    expect(text).toContain("non-empty task");
  });

  it("refuses a working directory that does not exist", async () => {
    const h = new Harness();
    const { text, isError } = await h.tool("dispatch", { task: "x", cwd: join(tmpdir(), "llm-relay-absent-dir-xyz") });
    expect(isError).toBe(true);
    expect(text).toContain("does not exist");
  });

  it("refuses when no lane is available, and says why", async () => {
    const h = new Harness({
      buildView: async () => view({ next: null, ladder: [], reason: "no routing.ladder configured" }),
    });
    const { text, isError } = await h.tool("dispatch", { task: "x" });
    expect(isError).toBe(true);
    expect(text).toContain("no routing.ladder configured");
  });

  it("refuses a lane with no runnable command instead of inventing one", async () => {
    const h = new Harness({
      buildView: async () =>
        view({ next: laneWithoutInvoke({ unreachable: "no cliLane template configured" }) }),
    });
    const { text, isError } = await h.tool("dispatch", { task: "x" });
    expect(isError).toBe(true);
    expect(text).toContain("no cliLane template configured");
  });

  it("applies the rung's env deltas — a string sets, null unsets", async () => {
    process.env["LLM_RELAY_TEST_UNSET_ME"] = "present";
    const spawn = fakeSpawner({ code: 0, stdout: "ok", stderr: "", timedOut: false });
    const h = new Harness({
      spawn,
      buildView: async () =>
        view({
          next: lane({
            invoke: {
              command: "claude",
              args: ["-p"],
              env: { CLAUDE_STREAM_IDLE_TIMEOUT_MS: "1800000", LLM_RELAY_TEST_UNSET_ME: null },
            },
          }),
        }),
    });
    await h.tool("dispatch", { task: "x" });
    const env = spawn.calls[0]?.[2].env as NodeJS.ProcessEnv;
    expect(env["CLAUDE_STREAM_IDLE_TIMEOUT_MS"]).toBe("1800000");
    expect(env["LLM_RELAY_TEST_UNSET_ME"]).toBeUndefined();
    delete process.env["LLM_RELAY_TEST_UNSET_ME"];
  });

  it("stamps the recursion depth into the child environment", async () => {
    const previous = process.env[DEPTH_ENV];
    delete process.env[DEPTH_ENV];
    try {
      const spawn = fakeSpawner({ code: 0, stdout: "ok", stderr: "", timedOut: false });
      const h = new Harness({ spawn });
      await h.tool("dispatch", { task: "x" });
      expect((spawn.calls[0]?.[2].env as NodeJS.ProcessEnv)[DEPTH_ENV]).toBe("1");
    } finally {
      if (previous === undefined) delete process.env[DEPTH_ENV];
      else process.env[DEPTH_ENV] = previous;
    }
  });

  it("refuses to delegate past the depth limit, and spawns NOTHING", async () => {
    const spawn = fakeSpawner({ code: 0, stdout: "ok", stderr: "", timedOut: false });
    const previous = process.env[DEPTH_ENV];
    process.env[DEPTH_ENV] = "3";
    try {
      const h = new Harness({ spawn, maxDepth: 3 });
      const { text, isError } = await h.tool("dispatch", { task: "x" });
      expect(isError).toBe(true);
      expect(text).toContain("levels deep");
      // The refusal must be BEFORE the spawn, or the bound costs a lane run to enforce.
      expect(spawn.calls).toHaveLength(0);
    } finally {
      if (previous === undefined) delete process.env[DEPTH_ENV];
      else process.env[DEPTH_ENV] = previous;
    }
  });

  it("reports an exit-0 lane that produced NO output as a failure, never as an empty answer", async () => {
    // Measured lane failure mode: agy discards long answers and exits 0 with nothing.
    const h = new Harness({ spawn: fakeSpawner({ code: 0, stdout: "   ", stderr: "boom", timedOut: false }) });
    const { text } = await h.tool("dispatch", { task: "x" });
    expect(text).toContain("returned NO output");
    expect(text).toContain("Treat this as a lane failure");
    expect(text).toContain("boom");
  });

  it("marks a non-zero exit as an error result", async () => {
    const h = new Harness({ spawn: fakeSpawner({ code: 2, stdout: "partial", stderr: "err", timedOut: false }) });
    const { text, isError } = await h.tool("dispatch", { task: "x" });
    expect(isError).toBe(true);
    expect(text).toContain("exit: 2");
  });
});

describe("async job path", () => {
  it("hands back a job handle when the lane outlives waitMs, then serves the result", async () => {
    vi.useFakeTimers();
    try {
      const h = new Harness({ spawn: fakeSpawner({ code: 0, stdout: "slow answer", stderr: "", timedOut: false }, 5000) });
      const call = h.tool("dispatch", { task: "x", waitMs: 100 });
      await vi.advanceTimersByTimeAsync(150);
      const started = await call;
      expect(started.isError).toBe(false);
      expect(started.text).toContain("status: running");
      expect(started.text).toMatch(/jobId "job-\d+"/);

      const jobId = /job: (job-\d+)/.exec(started.text)?.[1];
      expect(jobId).toBeDefined();

      const running = await h.tool("dispatch_status", { jobId: jobId as string });
      expect(running.text).toContain("status: running");

      await vi.advanceTimersByTimeAsync(6000);
      const done = await h.tool("dispatch_result", { jobId: jobId as string });
      expect(done.text).toContain("slow answer");
      expect(done.text).toContain("status: completed");
    } finally {
      vi.useRealTimers();
    }
  });

  it("cancels a running job, and the child's own later exit does not overwrite the verdict", async () => {
    vi.useFakeTimers();
    try {
      const h = new Harness({ spawn: fakeSpawner({ code: 0, stdout: "too late", stderr: "", timedOut: false }, 5000) });
      const call = h.tool("dispatch", { task: "x", waitMs: 100 });
      await vi.advanceTimersByTimeAsync(150);
      const jobId = /job: (job-\d+)/.exec((await call).text)?.[1] as string;

      const cancelled = await h.tool("dispatch_cancel", { jobId });
      expect(cancelled.text).toContain("cancelled");

      await vi.advanceTimersByTimeAsync(6000);
      const after = await h.tool("dispatch_status", { jobId });
      // ⚠ The child settles after the cancel. A cancelled job must stay cancelled, or a deliberate
      // stop would be reported back as an ordinary lane failure.
      expect(after.text).toContain("status: cancelled");
    } finally {
      vi.useRealTimers();
    }
  });

  it("refuses an unknown jobId on every job tool", async () => {
    const h = new Harness();
    for (const tool of ["dispatch_status", "dispatch_result", "dispatch_cancel"]) {
      const { text, isError } = await h.tool(tool, { jobId: "job-9999" });
      expect(isError, tool).toBe(true);
      expect(text, tool).toContain("unknown jobId");
    }
  });

  it("requires a jobId on every job tool", async () => {
    const h = new Harness();
    for (const tool of ["dispatch_status", "dispatch_result", "dispatch_cancel"]) {
      const { isError } = await h.tool(tool, {});
      expect(isError, tool).toBe(true);
    }
  });

  it("reports semantic AGY quota failure once before result and status exposure", async () => {
    const reports: unknown[] = [];
    const h = new Harness({
      buildView: async () => view({ next: lane({ id: "agy", invoke: { command: "agy", args: ["-p", "x", "--output-format", "json"] } }) }),
      spawn: fakeSpawner({ code: 0, stdout: '{"status":"ERROR","error":"Individual quota reached"}', stderr: "raw", timedOut: false }),
      reportExhaustion: async (report) => { reports.push(report); },
    });
    const dispatched = await h.tool("dispatch", { task: "x" });
    expect(dispatched.isError).toBe(true);
    expect(dispatched.text).toContain("status: failed");
    expect(dispatched.text).toContain("Individual quota reached");
    const jobId = /job: (job-\d+)/.exec(dispatched.text)?.[1] as string;
    const result = await h.tool("dispatch_result", { jobId });
    const status = await h.tool("dispatch_status", { jobId });
    expect(result.isError).toBe(true);
    expect(status.text).toContain("status: failed");
    expect(reports).toHaveLength(1);
  });

  it("keeps semantic failure visible when the quota reporter throws, with bounded diagnostics", async () => {
    const h = new Harness({
      buildView: async () => view({ next: lane({ id: "agy", invoke: { command: "agy", args: ["-p", "x", "--output-format", "json"] } }) }),
      spawn: fakeSpawner({ code: 0, stdout: '{"status":"ERROR","error":"Individual quota reached"}', stderr: "raw", timedOut: false }),
      reportExhaustion: () => { throw new Error("x".repeat(900)); },
    });
    const result = await h.tool("dispatch", { task: "x" });
    expect(result.isError).toBe(true);
    expect(result.text).toContain("lane reported quota_exhausted");
    expect(result.text).toContain("quota report failed:");
    expect(result.text.length).toBeLessThan(1800);
  });
});

/**
 * The `dispatch` waitMs ceiling, `routing.mcp.maxWaitMs` (packet P8, 2026-09-09) — the server
 * half of the machine-wide job-handle-loss defect. An MCP host tool call fails between 45 s
 * and 100 s and destroys the job handle, so `dispatch` blocks at most the ceiling (40 s by
 * default), clamps a larger `waitMs` and announces it, and refuses a `waitMs` it cannot
 * honour at all. Uses the injected spawner and fake timers throughout; never real sleeps.
 */
describe("dispatch waitMs ceiling (routing.mcp.maxWaitMs)", () => {
  /** A lane that never settles, so the blocking wait — not the lane — decides when we hear back. */
  function neverSettlingSpawner(): LaneSpawner {
    return () => ({ result: new Promise<LaneRunResult>(() => {}), kill: () => {} });
  }

  function ceilingConfig(maxWaitMs: number): Partial<McpServerDeps> {
    return {
      config: { host: "127.0.0.1", port: 8791, routing: { mcp: { maxWaitMs } } } as unknown as Config,
    };
  }

  it("clamps a waitMs above the ceiling and announces the clamp on its own line", async () => {
    vi.useFakeTimers();
    try {
      const h = new Harness({ spawn: neverSettlingSpawner() });
      let settled = false;
      const call = h.tool("dispatch", { task: "x", waitMs: 60000 }).then((r) => {
        settled = true;
        return r;
      });
      // The ceiling answers at 40 s; the requested 60 s would still be blocking.
      await vi.advanceTimersByTimeAsync(40_000);
      expect(settled).toBe(true);
      const { text, isError } = await call;
      expect(isError).toBe(false);
      expect(text).toMatch(/jobId "job-\d+"/);
      expect(text).toContain("waited 40 s (waitMs 60000 clamped to routing.mcp.maxWaitMs 40000)");
    } finally {
      vi.useRealTimers();
    }
  });

  it("honours a waitMs at or below the ceiling exactly, byte-for-byte the old text", async () => {
    vi.useFakeTimers();
    try {
      const h = new Harness({ spawn: neverSettlingSpawner() });
      const call = h.tool("dispatch", { task: "x", waitMs: 5000 });
      await vi.advanceTimersByTimeAsync(5000);
      const { text, isError } = await call;
      expect(isError).toBe(false);
      expect(text).toContain("Still running after 5s.");
      expect(text).not.toContain("clamped");
      expect(text).not.toContain("maxWaitMs");
      const jobId = /job: (job-\d+)/.exec(text)?.[1] as string;
      expect(text).toContain(`Poll dispatch_status with jobId "${jobId}", then call dispatch_result.`);
    } finally {
      vi.useRealTimers();
    }
  });

  it("waits the ceiling — not the old 60 s default — when waitMs is absent", async () => {
    vi.useFakeTimers();
    try {
      const h = new Harness({ spawn: neverSettlingSpawner() });
      let settled = false;
      const call = h.tool("dispatch", { task: "x" }).then((r) => {
        settled = true;
        return r;
      });
      await vi.advanceTimersByTimeAsync(39_999);
      expect(settled).toBe(false);
      await vi.advanceTimersByTimeAsync(1);
      expect(settled).toBe(true);
      const { text } = await call;
      expect(text).toContain("Still running after 40s.");
      expect(text).not.toContain("clamped");
    } finally {
      vi.useRealTimers();
    }
  });

  it("refuses a waitMs the server cannot honour, naming the ceiling", async () => {
    // The lane answers at once here, so a refusal — which happens before any spawn — is the
    // only way these calls can come back as errors.
    const h = new Harness();
    for (const bad of [-1, 0]) {
      const { text, isError } = await h.tool("dispatch", { task: "x", waitMs: bad });
      expect(isError, String(bad)).toBe(true);
      expect(text, String(bad)).toContain("routing.mcp.maxWaitMs");
    }
  });

  it("a configured maxWaitMs moves the ceiling for the clamp and the default", async () => {
    vi.useFakeTimers();
    try {
      const h = new Harness({ spawn: neverSettlingSpawner(), ...ceilingConfig(10_000) });
      const clamped = h.tool("dispatch", { task: "x", waitMs: 60000 });
      await vi.advanceTimersByTimeAsync(10_000);
      expect((await clamped).text).toContain(
        "waited 10 s (waitMs 60000 clamped to routing.mcp.maxWaitMs 10000)",
      );
      let settled = false;
      const dflt = h.tool("dispatch", { task: "x" }).then((r) => {
        settled = true;
        return r;
      });
      await vi.advanceTimersByTimeAsync(9999);
      expect(settled).toBe(false);
      await vi.advanceTimersByTimeAsync(1);
      expect(settled).toBe(true);
      expect((await dflt).text).toContain("Still running after 10s.");
    } finally {
      vi.useRealTimers();
    }
  });

  it("the tool description names the ceiling's config key, not a literal", async () => {
    const h = new Harness();
    const res = await h.request("tools/list");
    const tools = (res["result"] as { tools: { name: string; description: string; inputSchema: { properties: Record<string, { description?: string }> } }[] }).tools;
    const dispatch = tools.find((t) => t.name === "dispatch");
    const waitMsDesc = dispatch?.inputSchema.properties["waitMs"]?.description ?? "";
    expect(waitMsDesc).toContain("routing.mcp.maxWaitMs");
    expect(waitMsDesc).not.toContain("40000");
    expect(dispatch?.description).toContain("routing.mcp.maxWaitMs");
  });
});

describe("dispatch_lanes", () => {
  it("renders the ladder with each lane's state", async () => {
    const h = new Harness({
      buildView: async () =>
        view({
          ladder: [
            lane({ id: "codex", state: "disabled", position: 1 }),
            lane({ id: "free-pool", state: "ready", position: 2 }),
          ],
        }),
    });
    const { text } = await h.tool("dispatch_lanes", {});
    expect(text).toContain("1. codex [disabled]");
    expect(text).toContain("2. free-pool [ready]");
    expect(text).toContain("next: free-pool");
  });

  it("says what to do when no ladder is configured", async () => {
    const h = new Harness({
      buildView: async () => view({ ladder: [], next: null, reason: "no routing.ladder configured" }),
    });
    const { text } = await h.tool("dispatch_lanes", {});
    expect(text).toContain("No dispatch ladder is configured");
    expect(text).toContain("routing.ladder");
  });
});

/**
 * A `cli` rung's per-MCP-server-process `maxConcurrent` cap (backlog item "a per-lane CONCURRENCY
 * cap on cli dispatch rungs", 2026-09-09). What the CONFIG is allowed to say is pinned in
 * test/config.test.ts; what `buildDispatch` carries onto the view is pinned in test/dispatch.test.ts;
 * this is the WALK's own behaviour — the skip, its reason, `dispatch_lanes`' `in flight:` line, and
 * the PARTIAL-vs-EXHAUSTED choice when every remaining lane is capped and busy.
 */
describe("maxConcurrent (per-lane concurrency cap)", () => {
  const WALK = {
    enabled: true,
    attemptMs: 30_000, // real-clock; large enough that this test's own timing never trips it
    attemptQuantile: 0.8,
    attemptMinSamples: 1000, // no fixture here sets attemptBudget, so this never matters either way
    maxLanes: 4,
    pinMs: 60_000,
    demoteMs: 60_000,
    outlier: false,
  };

  function walkConfig(): Config {
    return { host: "127.0.0.1", port: 8791, routing: { dispatchWalk: WALK } } as unknown as Config;
  }

  function cliLane(id: string, position: number, maxConcurrent: number | null = null): DispatchLane {
    return {
      id,
      kind: "cli",
      position,
      state: "ready",
      invoke: { command: id, args: ["{task}"] },
      maxConcurrent,
    };
  }

  /** Every command HANGS until explicitly `settle`d, except the ones named in `instant`. */
  function controllableSpawner(instant: Record<string, LaneRunResult> = {}): LaneSpawner & {
    calls: string[];
    settle: (command: string, r: LaneRunResult) => void;
  } {
    const calls: string[] = [];
    const pending: Record<string, (r: LaneRunResult) => void> = {};
    const fn: LaneSpawner = (command) => {
      calls.push(command);
      const fixed = instant[command];
      if (fixed) return { result: Promise.resolve(fixed), kill: () => {} };
      const result = new Promise<LaneRunResult>((resolve) => {
        pending[command] = resolve;
      });
      return {
        result,
        kill: () => pending[command]?.({ code: null, stdout: "", stderr: "killed", timedOut: false }),
      };
    };
    return Object.assign(fn, {
      calls,
      settle: (command: string, r: LaneRunResult) => pending[command]?.(r),
    });
  }

  /** Poll `dispatch_status` on real timers until the job leaves `notStatus`, or throw. */
  async function waitForJobStatus(
    h: Harness,
    jobId: string,
    notStatus: string,
    timeoutMs = 3000,
  ): Promise<{ text: string; isError: boolean }> {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      const r = await h.tool("dispatch_status", { jobId });
      if (!r.text.includes(`status: ${notStatus}`)) return r;
      if (Date.now() > deadline) throw new Error(`job ${jobId} still ${notStatus} after ${timeoutMs}ms`);
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
  }

  it("skips a lane already at its cap, runs the next lane, shows it on dispatch_lanes, and reuses the freed lane once its job settles", async () => {
    const laneA = cliLane("A", 1, 1);
    const laneB = cliLane("B", 2);
    const v = view({ ladder: [laneA, laneB], order: ["A", "B"], next: laneA });
    const spawn = controllableSpawner({ B: { code: 0, stdout: "B answered", stderr: "", timedOut: false } });
    const h = new Harness({ config: walkConfig(), buildView: async () => v, spawn });

    // Dispatch #1 takes lane A. A never settles on its own, so a short waitMs is the only way to
    // get a job handle back rather than waiting out the real ceiling.
    const started1 = await h.tool("dispatch", { task: "t1", waitMs: 20 });
    expect(started1.text).toContain("status: running");
    const jobId1 = /job: (job-\d+)/.exec(started1.text)?.[1];
    expect(jobId1).toBeDefined();

    // Dispatch #2: A is at its maxConcurrent (1 in flight from job 1), so it SKIPS A and runs B.
    const dispatched2 = await h.tool("dispatch", { task: "t2" });
    expect(dispatched2.isError).toBe(false);
    expect(dispatched2.text).toContain("B answered");
    expect(dispatched2.text).toContain('lane "A" is at its maxConcurrent (1 in flight)');

    // dispatch_lanes shows the live count beside the cap for A, and nothing extra for uncapped B
    // (job 2's own B attempt already settled, so B's own in-flight count is back to 0).
    const lanesView = await h.tool("dispatch_lanes", {});
    expect(lanesView.text).toContain("in flight: 1 of 1");
    expect(lanesView.text).not.toMatch(/2\. B.*in flight/);

    // Release job 1's lane A. Once it settles, a third dispatch reaches A again — the cap freed up.
    spawn.settle("A", { code: 0, stdout: "A finally answered", stderr: "", timedOut: false });
    await waitForJobStatus(h, jobId1 as string, "running");
    const result1 = await h.tool("dispatch_result", { jobId: jobId1 as string });
    expect(result1.text).toContain("A finally answered");
    expect(result1.text).toContain("status: completed");

    const started3 = await h.tool("dispatch", { task: "t3", waitMs: 20 });
    expect(started3.text).toContain("status: running");
    expect(spawn.calls.filter((c) => c === "A")).toHaveLength(2);

    // Clean up the still-hanging third attempt on A so nothing is left running past the test.
    spawn.settle("A", { code: 0, stdout: "done", stderr: "", timedOut: false });
  });

  it("every remaining lane capped and busy: PARTIAL advice, never EXHAUSTED, and no telemetry for a skip", async () => {
    const laneA = cliLane("A", 1, 1);
    const laneB = cliLane("B", 2, 1);
    const v = view({ ladder: [laneA, laneB], order: ["A", "B"], next: laneA });
    const spawn = controllableSpawner(); // both A and B hang until released — never released here
    const reports: unknown[] = [];
    const h = new Harness({
      config: walkConfig(),
      buildView: async () => v,
      spawn,
      reportTelemetry: async (r) => {
        reports.push(r);
      },
    });

    // Job 1 occupies A, job 2 occupies B — both hang, both never settle in this test.
    await h.tool("dispatch", { task: "t1", waitMs: 20 });
    await h.tool("dispatch", { task: "t2", waitMs: 20 });

    // Job 3: A is capped and busy, B is capped and busy. Both SKIP; nothing to try at all.
    const dispatched3 = await h.tool("dispatch", { task: "t3" });
    expect(dispatched3.isError).toBe(true);
    expect(dispatched3.text).toContain('lane "A" is at its maxConcurrent (1 in flight)');
    expect(dispatched3.text).toContain('lane "B" is at its maxConcurrent (1 in flight)');
    expect(dispatched3.text).toContain(LANE_LADDER_PARTIAL_ADVICE);
    expect(dispatched3.text).not.toContain(LANE_LADDER_EXHAUSTED_ADVICE);

    // Nothing ran, so nothing is reported: not job 1 or 2 (still hanging, never settled) and not
    // job 3's two skips (skipping is not running).
    expect(reports).toHaveLength(0);
  });

  it("with no maxConcurrent configured anywhere, the walk never skips and nothing new renders", async () => {
    const spawn = fakeSpawner({ code: 0, stdout: "ordinary answer", stderr: "", timedOut: false });
    const h = new Harness({ spawn });
    const dispatched = await h.tool("dispatch", { task: "t" });
    expect(dispatched.isError).toBe(false);
    expect(dispatched.text).not.toContain("maxConcurrent");
    expect(dispatched.text).not.toContain("in flight");
    const lanesView = await h.tool("dispatch_lanes", {});
    expect(lanesView.text).not.toContain("maxConcurrent");
    expect(lanesView.text).not.toContain("in flight");
  });
});

describe("checkCwd", () => {
  it("accepts any existing directory when no allowedRoots are declared", () => {
    expect(checkCwd(tmpdir(), undefined).ok).toBe(true);
    expect(checkCwd(tmpdir(), []).ok).toBe(true);
  });

  it("rejects a path that is not a directory", () => {
    const dir = mkdtempSync(join(tmpdir(), "llm-relay-mcp-cwd-"));
    try {
      expect(checkCwd(join(dir, "nope"), undefined).ok).toBe(false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("enforces allowedRoots when the operator declares them", () => {
    const root = mkdtempSync(join(tmpdir(), "llm-relay-mcp-root-"));
    const outside = mkdtempSync(join(tmpdir(), "llm-relay-mcp-other-"));
    try {
      expect(checkCwd(root, [root]).ok).toBe(true);
      const denied = checkCwd(outside, [root]);
      expect(denied.ok).toBe(false);
      expect(denied.reason).toContain("allowedRoots");
    } finally {
      rmSync(root, { recursive: true, force: true });
      rmSync(outside, { recursive: true, force: true });
    }
  });

  it("does not let a sibling directory pass as a prefix match", () => {
    // `<base>/root` must not admit `<base>/rootlike`. A plain `startsWith` with no separator check
    // would let it through, so BOTH directories are really created — otherwise the existence check
    // refuses first and this asserts nothing about containment.
    const base = mkdtempSync(join(tmpdir(), "llm-relay-mcp-prefix-"));
    const root = join(base, "root");
    const sibling = join(base, "rootlike");
    const child = join(root, "inner");
    try {
      mkdirSync(child, { recursive: true });
      mkdirSync(sibling, { recursive: true });

      // Control: the root itself and a real child are admitted, so a failure below is containment
      // and not a broken fixture.
      expect(checkCwd(root, [root]).ok).toBe(true);
      expect(checkCwd(child, [root]).ok).toBe(true);

      const denied = checkCwd(sibling, [root]);
      expect(denied.ok).toBe(false);
      expect(denied.reason).toContain("allowedRoots");
    } finally {
      rmSync(base, { recursive: true, force: true });
    }
  });

  it("treats a trailing separator on an allowed root as the same root", () => {
    const root = mkdtempSync(join(tmpdir(), "llm-relay-mcp-trail-"));
    try {
      expect(checkCwd(root, [`${root}/`]).ok).toBe(true);
      expect(checkCwd(`${root}/`, [root]).ok).toBe(true);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("resolves a `..` segment before the containment test, closing a path-traversal bypass", () => {
    // docs/audit-findings-2026-09-03.md (DR-002 / finding 1): normalizePath unified separators,
    // trimmed trailing slashes and lowercased, but never called path.resolve, so a literal `..`
    // segment in the candidate satisfied a bare `startsWith` prefix test while existsSync/statSync
    // above it had already resolved `..` at the OS level against the REAL, escaped directory.
    // Demonstrated there: allowedRoots ["C:/Code/llm-relay"], candidate
    // "C:/Code/llm-relay/../../Windows" was PERMITTED. This is the same shape with real temp dirs.
    const base = mkdtempSync(join(tmpdir(), "llm-relay-mcp-traversal-"));
    const allowed = join(base, "allowed");
    const sub = join(allowed, "sub");
    const outside = join(base, "outside");
    try {
      mkdirSync(sub, { recursive: true });
      mkdirSync(outside, { recursive: true });

      // Control: a real child of the allowed root is still admitted.
      expect(checkCwd(sub, [allowed]).ok).toBe(true);

      // `path.join` would itself collapse `..`, which would defeat the point of this test — the
      // real bypass is a RAW string a caller sends verbatim, so build it without normalizing.
      const traversal = `${allowed}/../outside`;
      expect(checkCwd(traversal, undefined).ok).toBe(true); // exists, real dir — sanity check
      const denied = checkCwd(traversal, [allowed]);
      expect(denied.ok).toBe(false);
      expect(denied.reason).toContain("allowedRoots");
    } finally {
      rmSync(base, { recursive: true, force: true });
    }
  });

  it("resolves a `..` segment in an allowed root too, not only in the candidate", () => {
    const base = mkdtempSync(join(tmpdir(), "llm-relay-mcp-traversal-root-"));
    const allowed = join(base, "allowed");
    const decoy = join(base, "decoy");
    try {
      mkdirSync(allowed, { recursive: true });
      mkdirSync(decoy, { recursive: true });
      // A root declared with a trailing `..` segment must resolve to the same real directory.
      const rootWithTraversal = `${decoy}/../allowed`;
      expect(checkCwd(allowed, [rootWithTraversal]).ok).toBe(true);
    } finally {
      rmSync(base, { recursive: true, force: true });
    }
  });
});

describe("job store", () => {
  it("keeps a cancelled job cancelled when the run settles afterwards", () => {
    const store = new LaneJobStore();
    const job = store.create("lane", "pool/medium", process.cwd());
    store.registerKill(job.id, () => {});
    expect(store.cancel(job.id)).toBe(true);
    store.complete(job.id, { code: 0, stdout: "late", stderr: "", timedOut: false });
    expect(store.get(job.id)?.status).toBe("cancelled");
    expect(store.get(job.id)?.stdout).toBe("");
  });

  it("refuses to cancel a job that already finished", () => {
    const store = new LaneJobStore();
    const job = store.create("lane", undefined, process.cwd());
    store.complete(job.id, { code: 0, stdout: "done", stderr: "", timedOut: false });
    expect(store.cancel(job.id)).toBe(false);
    expect(store.get(job.id)?.status).toBe("completed");
  });
});

describe("depth", () => {
  it("reads the depth marker, treating absent and nonsense as the top of the chain", () => {
    expect(currentDepth({})).toBe(0);
    expect(currentDepth({ [DEPTH_ENV]: "2" })).toBe(2);
    expect(currentDepth({ [DEPTH_ENV]: "not-a-number" })).toBe(0);
    expect(currentDepth({ [DEPTH_ENV]: "-5" })).toBe(0);
  });
});

describe("spawn safety", () => {
  it("the default spawner REFUSES to spawn under vitest", async () => {
    // The `winenv.ts` guard applied here: a suite must never spend real lane quota, and a test
    // asserting only "does not throw" would pass even if it did spawn.
    const { result } = defaultLaneSpawner("claude", ["-p", "x"], {
      env: process.env,
      cwd: process.cwd(),
      timeoutMs: 1000,
    });
    const r = await result;
    expect(r.code).toBeNull();
    expect(r.stderr).toContain("disabled under vitest");
  });
});

describe("dispatched quota classification", () => {
  const base = {
    laneId: "agy",
    tier: "medium" as string | undefined,
    command: "agy",
    args: ["-p", "x", "--output-format", "json"] as readonly string[],
  };

  it("recognizes AGY's exit-zero quota envelope and ignores successful answer prose", () => {
    expect(classifyDispatchedResult({
      ...base,
      result: { code: 0, stdout: '{"status":"ERROR","error":"Individual quota reached"}', stderr: "", timedOut: false },
    })?.outcome).toBe("quota_exhausted");
    expect(classifyDispatchedResult({
      ...base,
      result: { code: 0, stdout: '{"status":"SUCCESS","response":"quota is discussed here"}', stderr: "", timedOut: false },
    })).toBeUndefined();
  });

  it("uses explicit nonzero rate/quota evidence and stays inconclusive otherwise", () => {
    expect(classifyDispatchedResult({
      ...base,
      command: "codex",
      result: { code: 1, stdout: "", stderr: "429 too many requests", timedOut: false },
    })?.outcome).toBe("rate_limited");
    expect(classifyDispatchedResult({
      ...base,
      result: { code: 1, stdout: "failed", stderr: "timeout", timedOut: false },
    })).toBeUndefined();
    expect(classifyDispatchedResult({
      ...base,
      result: { code: null, stdout: '{"status":"ERROR","error":"Individual quota reached"}', stderr: "", timedOut: false },
    })).toBeUndefined();
  });
});

describe("isContentEmpty", () => {
  // C:\Code\docs\backlog.md: "llm-relay accepts content-empty lane output as a successful
  // answer" — a 652-second review returned only `#`. Structural, not semantic: it strips
  // whitespace/punctuation/Markdown scaffolding and asks only whether anything ALPHANUMERIC
  // remains. It must NOT try to judge whether the content actually answers the task — that is
  // the repair-boundary line this repo draws elsewhere ("never an LLM's opinion in the request
  // path"), so a short real answer like "OK" or "42" reads as content, and so does "Here is" even
  // though it is a generic lead-in with nothing after it — the backlog's broader property is
  // deliberately narrowed to this structural test, not a semantic one.
  it("is true for an empty string", () => {
    expect(isContentEmpty("")).toBe(true);
  });

  it("is true for whitespace only", () => {
    expect(isContentEmpty("   \n\t  \n")).toBe(true);
  });

  it("is true for a lone markdown scaffold character", () => {
    expect(isContentEmpty("#")).toBe(true);
  });

  it("is true for markdown scaffolding with no alphanumeric content", () => {
    expect(isContentEmpty("# \n\n---\n")).toBe(true);
    expect(isContentEmpty("***")).toBe(true);
    expect(isContentEmpty("> ` ~ = | _ -")).toBe(true);
  });

  it("is false for a short real answer", () => {
    expect(isContentEmpty("OK")).toBe(false);
    expect(isContentEmpty("42")).toBe(false);
  });

  it("is false for markdown-formatted real content", () => {
    expect(isContentEmpty("# Real content here")).toBe(false);
  });

  it("is false for a generic lead-in — this predicate is structural, not semantic", () => {
    // Deliberately not caught: judging whether "Here is" is a substantive continuation would be
    // exactly the task-specific semantic judgement this predicate refuses to make.
    expect(isContentEmpty("Here is")).toBe(false);
  });
});

describe("terminal job rendering never returns nothing", () => {
  it("TERMINAL_JOB_STATUSES names every non-running status — extend the test below if this grows", () => {
    // `killed` joined 2026-09-10 (a lane that died with its MCP server restarting). It is
    // reachable only through the journal, so its rendering case below is driven through one.
    expect([...TERMINAL_JOB_STATUSES].sort()).toEqual(["cancelled", "completed", "failed", "killed", "timed_out"]);
  });

  it("renders a killed-by-restart job as killed, with an error result — never as an empty answer", async () => {
    const dir = mkdtempSync(join(tmpdir(), "llm-relay-mcp-killed-"));
    try {
      const path = join(dir, "mcp-jobs.json");
      // Process 1: a job that never finished.
      const first = new LaneJobStore(createJobJournal(path));
      const gone = first.create("free-pool", "pool/high", process.cwd());
      // Process 2: the restart, with the same journal.
      const h = new Harness({ journal: createJobJournal(path) });
      const result = await h.tool("dispatch_result", { jobId: gone.id });

      expect(result.isError).toBe(true);
      expect(result.text).toContain("status: killed");
      expect(result.text).toContain("restarted");
      expect(result.text).toContain(gone.id);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("renders a non-empty structured result for every terminal status the store knows", async () => {
    // completed
    {
      const h = new Harness({ spawn: fakeSpawner({ code: 0, stdout: "a real answer", stderr: "", timedOut: false }) });
      const { text } = await h.tool("dispatch", { task: "x" });
      expect(text.length).toBeGreaterThan(0);
      expect(text).toContain("status: completed");
    }
    // failed
    {
      const h = new Harness({ spawn: fakeSpawner({ code: 1, stdout: "", stderr: "boom", timedOut: false }) });
      const { text } = await h.tool("dispatch", { task: "x" });
      expect(text.length).toBeGreaterThan(0);
      expect(text).toContain("status: failed");
    }
    // timed_out — the spawner reports exactly what a killed-by-timeout child reports today.
    {
      const h = new Harness({ spawn: fakeSpawner({ code: null, stdout: "", stderr: "", timedOut: true }) });
      const { text } = await h.tool("dispatch", { task: "x" });
      expect(text.length).toBeGreaterThan(0);
      expect(text).toContain("status: timed_out");
    }
    // cancelled
    {
      vi.useFakeTimers();
      try {
        const h = new Harness({ spawn: fakeSpawner({ code: 0, stdout: "too late", stderr: "", timedOut: false }, 5000) });
        const call = h.tool("dispatch", { task: "x", waitMs: 100 });
        await vi.advanceTimersByTimeAsync(150);
        const started = await call;
        const jobId = /job: (job-\d+)/.exec(started.text)?.[1] as string;
        await h.tool("dispatch_cancel", { jobId });
        const result = await h.tool("dispatch_result", { jobId });
        expect(result.text.length).toBeGreaterThan(0);
        expect(result.text).toContain("status: cancelled");
      } finally {
        vi.useRealTimers();
      }
    }
  });

  it("gives a timed-out job a clear one-line reason and reports it as an error result", async () => {
    const h = new Harness({ spawn: fakeSpawner({ code: null, stdout: "partial thinking...", stderr: "", timedOut: true }) });
    const { text, isError } = await h.tool("dispatch", { task: "x" });
    expect(isError).toBe(true);
    expect(text).toContain("status: timed_out");
    // Partial output, when the killed child captured any, is still surfaced.
    expect(text).toContain("partial thinking...");
  });
});

describe("answer-mode fetch seam", () => {
  it("the default answer-mode fetch REFUSES to run under vitest", async () => {
    await expect(defaultAnswerFetch("http://127.0.0.1:8791/v1/messages", { method: "POST" })).rejects.toThrow(
      /vitest/i,
    );
  });
});

describe("dispatch tool — answer mode", () => {
  interface FetchCall {
    url: string;
    init: RequestInit;
  }

  function fakeAnswerFetch(handler: (call: FetchCall) => Response): { fetch: typeof fetch; calls: FetchCall[] } {
    const calls: FetchCall[] = [];
    const fn = (async (url: unknown, init: unknown) => {
      const call = { url: String(url), init: init as RequestInit };
      calls.push(call);
      return handler(call);
    }) as unknown as typeof fetch;
    return { fetch: fn, calls };
  }

  function assistantTextResponse(text: string, headers: Record<string, string> = {}): Response {
    return new Response(
      JSON.stringify({
        id: "msg_1",
        type: "message",
        role: "assistant",
        content: [{ type: "text", text }],
        stop_reason: "end_turn",
        usage: { input_tokens: 5, output_tokens: 5 },
      }),
      { status: 200, headers: { "content-type": "application/json", ...headers } },
    );
  }

  it("POSTs straight to this relay's own /v1/messages for a relay lane, and spawns nothing", async () => {
    const spawn = fakeSpawner({ code: 0, stdout: "should never run", stderr: "", timedOut: false });
    const { fetch: fetchImpl, calls } = fakeAnswerFetch(() => assistantTextResponse("the direct answer"));
    const h = new Harness({ spawn, fetch: fetchImpl });

    const { text, isError } = await h.tool("dispatch", { task: "do the thing", mode: "answer" });

    expect(isError).toBe(false);
    expect(text).toContain("the direct answer");
    expect(text).toContain("status: completed");
    expect(spawn.calls).toHaveLength(0);
    expect(calls).toHaveLength(1);
    expect(calls[0]?.url).toBe("http://127.0.0.1:8791/v1/messages");

    const headers = calls[0]?.init.headers as Record<string, string>;
    expect(headers["anthropic-version"]).toBe("2023-06-01");
    expect(headers["content-type"]).toBe("application/json");
    expect(headers["x-api-key"]).toBeTruthy();

    const body = JSON.parse(calls[0]?.init.body as string) as Record<string, unknown>;
    expect(body["model"]).toBe("pool/medium"); // the default lane() fixture's spec
    expect(body["max_tokens"]).toBe(4096);
    expect(body["messages"]).toEqual([{ role: "user", content: "do the thing" }]);
    expect(body["system"]).toBeUndefined();
    expect(body["tools"]).toBeUndefined();
  });

  it("passes an optional system prompt through", async () => {
    const { fetch: fetchImpl, calls } = fakeAnswerFetch(() => assistantTextResponse("ok"));
    const h = new Harness({ fetch: fetchImpl });
    await h.tool("dispatch", { task: "x", mode: "answer", system: "You are terse." });
    const body = JSON.parse(calls[0]?.init.body as string) as Record<string, unknown>;
    expect(body["system"]).toBe("You are terse.");
  });

  it("with a schema, forces a single answer tool call and returns its input as JSON", async () => {
    const schema = { type: "object", properties: { ok: { type: "boolean" } } };
    const { fetch: fetchImpl, calls } = fakeAnswerFetch(
      () =>
        new Response(
          JSON.stringify({
            content: [{ type: "tool_use", id: "toolu_1", name: "answer", input: { ok: true } }],
            stop_reason: "tool_use",
          }),
          { status: 200 },
        ),
    );
    const h = new Harness({ fetch: fetchImpl });

    const { text, isError } = await h.tool("dispatch", { task: "is this ok?", mode: "answer", schema });

    expect(isError).toBe(false);
    expect(text).toContain('{"ok":true}');
    const body = JSON.parse(calls[0]?.init.body as string) as Record<string, unknown>;
    expect(body["tools"]).toEqual([{ name: "answer", description: "Return the answer", input_schema: schema }]);
    expect(body["tool_choice"]).toEqual({ type: "tool", name: "answer" });
  });

  it("respects an explicit maxTokens", async () => {
    const { fetch: fetchImpl, calls } = fakeAnswerFetch(() => assistantTextResponse("ok"));
    const h = new Harness({ fetch: fetchImpl });
    await h.tool("dispatch", { task: "x", mode: "answer", maxTokens: 128 });
    const body = JSON.parse(calls[0]?.init.body as string) as Record<string, unknown>;
    expect(body["max_tokens"]).toBe(128);
  });

  it("reports a non-2xx answer with a bounded body excerpt, the relay's announcing headers, and no foreign ones", async () => {
    // ⚠ This test was named "…never headers" and asserted an `x-llm-relay-served-by` value was
    // ABSENT from the failure. That was the rule until 2026-09-10 and it is now deliberately
    // REVERSED, not drifted: the rule was written to keep a PROVIDER's arbitrary headers out of a
    // relay-authored message, but the measured cost was a failure the caller could not act on —
    // `relay answered HTTP 504` named the LANE while the 504 came from the relay's OWN
    // /v1/messages, leaving a pool exhaustion and a relay-side timeout indistinguishable.
    // `readRelayAnnouncements` is a closed five-name allow-list of headers the RELAY writes, so it
    // carries none of the risk the old rule addressed. The foreign-header half still binds.
    const longBody = "x".repeat(500);
    const { fetch: fetchImpl } = fakeAnswerFetch(
      () =>
        new Response(longBody, {
          status: 429,
          headers: {
            "retry-after": "30",
            "x-llm-relay-served-by": "nim/z-ai/glm-5.2",
            "x-llm-relay-pool-attempts": "3 tried, 0 served: 3x429",
            "x-some-vendor-header": "foreign-value",
          },
        }),
    );
    const h = new Harness({ fetch: fetchImpl });

    const { text, isError } = await h.tool("dispatch", { task: "x", mode: "answer" });

    expect(isError).toBe(true);
    expect(text).toContain("429");
    expect(text).toContain("x".repeat(300));
    expect(text).not.toContain("x".repeat(301));
    // The relay's own announcement is now NAMED — it is the attempt timeline.
    expect(text).toContain("nim/z-ai/glm-5.2");
    expect(text).toContain("3 tried, 0 served: 3x429");
    // Still never a foreign header, and still never the status the caller must not act on.
    expect(text).not.toContain("retry-after");
    expect(text).not.toContain("foreign-value");
  });

  it("captures the relay's announcing headers into the answer's provenance", async () => {
    const { fetch: fetchImpl } = fakeAnswerFetch(() =>
      assistantTextResponse("hi", {
        "x-llm-relay-served-by": "nim/z-ai/glm-5.2",
        "x-llm-relay-pool-attempts": "2 tried, 1 served: 1x429",
        "x-llm-relay-hedged": "won after 20000ms, floor",
      }),
    );
    const h = new Harness({ fetch: fetchImpl });

    const { text } = await h.tool("dispatch", { task: "x", mode: "answer" });

    expect(text).toContain("served-by: nim/z-ai/glm-5.2");
    expect(text).toContain("pool-attempts: 2 tried, 1 served: 1x429");
    expect(text).toContain("hedged: won after 20000ms, floor");
  });

  it("treats a content-empty answer as a distinct empty-output failure, same as agent mode", async () => {
    const { fetch: fetchImpl } = fakeAnswerFetch(() => assistantTextResponse("###   ---"));
    const h = new Harness({ fetch: fetchImpl });

    const { text, isError } = await h.tool("dispatch", { task: "x", mode: "answer" });

    expect(isError).toBe(true);
    expect(text).toContain("empty-output");
  });

  it("times out an answer-mode call and renders a non-empty timed_out result", async () => {
    // No timer fake needed: AbortSignal.timeout runs on the real clock, so a tiny real timeout
    // keeps this test fast without needing to fake it.
    const fetchImpl = (async (_url: unknown, init: unknown) => {
      const signal = (init as RequestInit).signal;
      return new Promise<Response>((_resolve, reject) => {
        signal?.addEventListener("abort", () => {
          reject(Object.assign(new Error("The operation was aborted"), { name: "TimeoutError" }));
        });
      });
    }) as unknown as typeof fetch;
    const h = new Harness({ fetch: fetchImpl });

    const { text, isError } = await h.tool("dispatch", { task: "x", mode: "answer", timeoutMs: 20 });

    expect(isError).toBe(true);
    expect(text.length).toBeGreaterThan(0);
    expect(text).toContain("status: timed_out");
  });

  it("cancel = abort the fetch, and the answer-mode job stays cancelled", async () => {
    vi.useFakeTimers();
    try {
      let aborted = false;
      const fetchImpl = (async (_url: unknown, init: unknown) => {
        const signal = (init as RequestInit).signal;
        return new Promise<Response>((_resolve, reject) => {
          signal?.addEventListener("abort", () => {
            aborted = true;
            reject(new Error("aborted"));
          });
        });
      }) as unknown as typeof fetch;
      const h = new Harness({ fetch: fetchImpl });

      const call = h.tool("dispatch", { task: "x", mode: "answer", waitMs: 100 });
      await vi.advanceTimersByTimeAsync(150);
      const started = await call;
      const jobId = /job: (job-\d+)/.exec(started.text)?.[1] as string;

      const cancelled = await h.tool("dispatch_cancel", { jobId });
      expect(cancelled.text).toContain("cancelled");
      expect(aborted).toBe(true);

      await vi.advanceTimersByTimeAsync(10);
      const after = await h.tool("dispatch_status", { jobId });
      expect(after.text).toContain("status: cancelled");
    } finally {
      vi.useRealTimers();
    }
  });

  it("a network error (relay not running) fails the job with a clear message, never a throw", async () => {
    const fetchImpl = (async () => {
      throw new Error("connect ECONNREFUSED 127.0.0.1:8791");
    }) as unknown as typeof fetch;
    const h = new Harness({ fetch: fetchImpl });

    const { text, isError } = await h.tool("dispatch", { task: "x", mode: "answer" });

    expect(isError).toBe(true);
    expect(text).toContain("ECONNREFUSED");
  });

  it("a cli-kind lane in answer mode behaves exactly like agent mode: it spawns the harness", async () => {
    const spawn = fakeSpawner({ code: 0, stdout: "cli answer", stderr: "", timedOut: false });
    const h = new Harness({
      spawn,
      buildView: async () => view({ next: lane({ id: "agy", kind: "cli", invoke: { command: "agy", args: ["-p", "x"] } }) }),
    });

    const { text, isError } = await h.tool("dispatch", { task: "x", mode: "answer" });

    expect(isError).toBe(false);
    expect(text).toContain("cli answer");
    expect(spawn.calls).toHaveLength(1);
  });

  it("mode defaults to agent — existing callers are unaffected", async () => {
    const spawn = fakeSpawner({ code: 0, stdout: "agent answer", stderr: "", timedOut: false });
    const h = new Harness({ spawn });
    const { text } = await h.tool("dispatch", { task: "x" });
    expect(text).toContain("agent answer");
    expect(spawn.calls).toHaveLength(1);
  });
});

describe("dispatch/dispatch_lanes tool schema and instructions — answer mode claims", () => {
  it("states when to use answer mode vs agent mode in the initialize instructions", () => {
    const text = MCP_INSTRUCTIONS.toLowerCase();
    expect(text).toContain('mode: "answer"'.toLowerCase());
    expect(text).toContain("no file access");
    expect(text).toContain("read or edit files or run commands");
  });

  it("carries the same answer-mode guidance on the dispatch tool description too", async () => {
    const h = new Harness();
    const res = await h.request("tools/list");
    const tools = (res["result"] as { tools: { name: string; description: string }[] }).tools;
    const dispatch = tools.find((t) => t.name === "dispatch");
    const description = dispatch?.description.toLowerCase() ?? "";
    expect(description).toContain("no file access");
    expect(description).toContain("read or edit files or run commands");
  });

  it("declares mode, system, schema and maxTokens on the dispatch tool's inputSchema", async () => {
    const h = new Harness();
    const res = await h.request("tools/list");
    const tools = (res["result"] as { tools: { name: string; inputSchema: { properties: Record<string, unknown> } }[] }).tools;
    const dispatch = tools.find((t) => t.name === "dispatch");
    const props = dispatch?.inputSchema.properties ?? {};
    expect(Object.keys(props)).toEqual(
      expect.arrayContaining(["task", "mode", "system", "schema", "maxTokens", "tier", "lane", "cwd", "waitMs", "timeoutMs"]),
    );
  });
});

// ---------------------------------------------------------------------------------------------
// The stdio serve loop (2026-09-05). `cli.ts` used to `await server.ingest(chunk)` per chunk, and
// `ingest` resolves only when every handler in that chunk has settled — so a request written
// while another was in flight was not even READ until the first returned. These tests drive
// `serve` with a hand-fed source, one push per host write, exactly as a host writes.

/** A push-driven async source: one `push` is one stdin write, `end` is the host closing the pipe. */
class ChunkSource implements AsyncIterable<string> {
  private readonly queue: string[] = [];
  private waiting: ((r: IteratorResult<string>) => void) | undefined;
  private ended = false;

  push(chunk: string): void {
    const waiting = this.waiting;
    if (waiting) {
      this.waiting = undefined;
      waiting({ value: chunk, done: false });
    } else {
      this.queue.push(chunk);
    }
  }

  end(): void {
    this.ended = true;
    const waiting = this.waiting;
    if (waiting) {
      this.waiting = undefined;
      waiting({ value: undefined as unknown as string, done: true });
    }
  }

  [Symbol.asyncIterator](): AsyncIterator<string> {
    return {
      next: () =>
        new Promise<IteratorResult<string>>((resolve) => {
          const queued = this.queue.shift();
          if (queued !== undefined) resolve({ value: queued, done: false });
          else if (this.ended) resolve({ value: undefined as unknown as string, done: true });
          else this.waiting = resolve;
        }),
    };
  }
}

function frame(id: number, method: string, params?: unknown): string {
  return JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n";
}

function toolFrame(id: number, name: string, args: Record<string, unknown>): string {
  return frame(id, "tools/call", { name, arguments: args });
}

/** Every response written so far, in write order, with the tool text when the result carries one. */
function responses(lines: readonly string[]): { id: number; text: string }[] {
  return lines.map((line) => {
    const parsed = JSON.parse(line) as { id: number; result?: { content?: { text: string }[] } };
    return { id: parsed.id, text: parsed.result?.content?.[0]?.text ?? "" };
  });
}

/** A spawner whose FIRST call answers at once and whose later calls take `slowMs`. */
function firstFastThenSlow(slowMs: number): LaneSpawner {
  const result: LaneRunResult = { code: 0, stdout: "lane answer", stderr: "", timedOut: false };
  const fast = fakeSpawner(result, 0);
  const slow = fakeSpawner(result, slowMs);
  let calls = 0;
  return (command, args, opts) => (calls++ === 0 ? fast : slow)(command, args, opts);
}

describe("stdio serve loop", () => {
  it("answers a request written while an earlier dispatch still blocks on waitMs", async () => {
    vi.useFakeTimers();
    try {
      const h = new Harness({ spawn: firstFastThenSlow(5000) });
      // Job ids are monotonic per process, so a dispatch that completes at once tells us the
      // id the NEXT dispatch will get — the one we need to address while it is still blocking.
      const warmup = await h.tool("dispatch", { task: "warm-up" });
      const previous = Number(/job: job-(\d+)/.exec(warmup.text)?.[1]);
      expect(Number.isFinite(previous)).toBe(true);
      const jobId = `job-${String(previous + 1).padStart(4, "0")}`;
      const before = h.out.length;

      const source = new ChunkSource();
      const served = h.server.serve(source);

      source.push(toolFrame(10, "dispatch", { task: "slow", waitMs: 1000 }));
      await vi.advanceTimersByTimeAsync(1);
      // A SEPARATE write while the dispatch above is inside its 1000 ms wait.
      source.push(toolFrame(11, "dispatch_status", { jobId }));
      await vi.advanceTimersByTimeAsync(10);

      const early = responses(h.out.slice(before));
      expect(early.map((r) => r.id)).toEqual([11]);
      expect(early[0]?.text).toContain("status: running");

      // A cancel from a third write reaches the job and ends the blocking dispatch early: the
      // job tools work while a `dispatch` holds the loop, which is the whole point.
      source.push(toolFrame(12, "dispatch_cancel", { jobId }));
      await vi.advanceTimersByTimeAsync(10);
      const all = responses(h.out.slice(before));
      expect(all.map((r) => r.id)).toEqual([11, 12, 10]);
      expect(all.find((r) => r.id === 10)?.text).toContain("status: cancelled");

      source.end();
      await served;
    } finally {
      vi.useRealTimers();
    }
  });

  it("runs two dispatches from separate writes beside each other: the second's wait excludes the first's", async () => {
    vi.useFakeTimers();
    try {
      const h = new Harness({ spawn: fakeSpawner({ code: 0, stdout: "slow answer", stderr: "", timedOut: false }, 5000) });
      const source = new ChunkSource();
      const served = h.server.serve(source);

      source.push(toolFrame(1, "dispatch", { task: "first", waitMs: 1000 }));
      await vi.advanceTimersByTimeAsync(1);
      source.push(toolFrame(2, "dispatch", { task: "second", waitMs: 1000 }));
      await vi.advanceTimersByTimeAsync(1100);

      // Both handles are back after ONE wait. A serial loop hands the second back at ~2000 ms,
      // because it does not read the second write until the first handler returns.
      const seen = responses(h.out);
      expect(seen.map((r) => r.id).sort()).toEqual([1, 2]);
      for (const r of seen) expect(r.text).toContain("status: running");

      source.end();
      await served;
    } finally {
      vi.useRealTimers();
    }
  });

  it("resolves only after the source ends and every handler it started has settled", async () => {
    vi.useFakeTimers();
    try {
      const h = new Harness({ spawn: fakeSpawner({ code: 0, stdout: "late answer", stderr: "", timedOut: false }, 500) });
      const source = new ChunkSource();
      let settled = false;
      const served = h.server.serve(source).then(() => {
        settled = true;
      });
      source.push(toolFrame(1, "dispatch", { task: "x", waitMs: 5000 }));
      await vi.advanceTimersByTimeAsync(1);
      source.end();
      await vi.advanceTimersByTimeAsync(1);
      // The pipe is closed but the dispatch still waits on its lane: serve must not resolve yet.
      expect(settled).toBe(false);
      await vi.advanceTimersByTimeAsync(600);
      await served;
      expect(responses(h.out)[0]?.text).toContain("late answer");
    } finally {
      vi.useRealTimers();
    }
  });

  it("contains a transport failure on one response and keeps serving later writes", async () => {
    const out: string[] = [];
    const h = new Harness({
      // Every write of the FIRST request's answer fails, result and error alike — the host closed
      // the pipe mid-response. Later writes succeed.
      write: (chunk) => {
        if (chunk.includes('"id":1,')) throw new Error("EPIPE");
        out.push(chunk);
      },
    });
    const stderr = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    try {
      const source = new ChunkSource();
      const served = h.server.serve(source);
      source.push(frame(1, "ping"));
      source.push(frame(2, "ping"));
      source.end();
      await served;
      expect(responses(out).map((r) => r.id)).toEqual([2]);
      expect(stderr).toHaveBeenCalledWith(expect.stringContaining("ingest failed"));
    } finally {
      stderr.mockRestore();
    }
  });

  it("splits synchronously in ingest, so un-awaited calls keep message order across a split frame", async () => {
    const h = new Harness();
    const msg = frame(7, "ping");
    const a = h.server.ingest(msg.slice(0, 12));
    const b = h.server.ingest(msg.slice(12));
    await Promise.all([a, b]);
    expect(responses(h.out).map((r) => r.id)).toEqual([7]);
  });
});
