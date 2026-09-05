/**
 * `POST /dispatch/telemetry` — the daemon half of dispatched-lane telemetry.
 *
 * The MCP host reports what it saw (lane, kind, wall-clock, exit, terminal status, estimated
 * tokens); the daemon records lane stats for BOTH kinds and exactly ONE accounting row for
 * `cli` lanes only (owner decision D1 — a `relay` lane's traffic is already metered by the
 * HTTP pipeline, so a second row would double count). Modelled on the `dispatch ladder —
 * endpoint` suite in `test/dispatch.test.ts`: the proxy is built the same way, with the
 * control token injected — plus a FAKE accounting recorder, so every ledger claim below is
 * read off captured events, never inferred.
 */
import { describe, it, expect, afterAll } from "vitest";
import { writeFileSync, mkdtempSync, rmSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { loadConfig, type Config } from "../src/config.js";
import { createProxy } from "../src/server.js";
import { CONTROL_AUTHORIZATION_HEADER } from "../src/control-authorization.js";
import type { AccountingEvent, AttemptCompletedEvent, RequestCompletedEvent } from "../src/accounting.js";
import { laneStatsFor } from "../src/dispatch-lane-stats.js";
import { createAccountingStore } from "../src/accounting-store.js";
import { parseAccountingDayShardV1 } from "../src/accounting-store-schema.js";
import type { AccountingRecorder } from "../src/accounting.js";

const controlToken = "telemetry-test-control-token";
const CONTROL_HEADERS = {
  "content-type": "application/json",
  [CONTROL_AUTHORIZATION_HEADER]: controlToken,
};

const dir = mkdtempSync(join(tmpdir(), "rp-dispatch-telemetry-"));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

let n = 0;
function cfgWithLadder(): Config {
  const p = join(dir, `c${n++}.json`);
  writeFileSync(
    p,
    JSON.stringify({
      listen: "127.0.0.1:8791",
      providers: {
        anthropic: { base: "https://api.anthropic.com", kind: "anthropic" },
      },
      routing: {
        default: "anthropic",
        ladder: [
          { id: "telemetry-cli", kind: "cli", command: "codex", args: ["exec", "{task}"], quota: "chatgpt" },
          { id: "telemetry-relay", kind: "relay", spec: "anthropic" },
          // A second cli rung so the runtime-telemetry negative control can use a lane id no
          // other test in this file records (P1: unknown lanes now 400, so it must be a rung).
          { id: "telemetry-cli-negative", kind: "cli", command: "codex", args: ["exec", "{task}"] },
        ],
      },
      mode: "detect",
    }),
  );
  return loadConfig(p);
}

function cliReport(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    jobId: "job-0001",
    laneId: "telemetry-cli",
    kind: "cli",
    spec: "openai/gpt-5",
    wallClockMs: 12_500,
    exitCode: 0,
    status: "completed",
    estimatedInputTokens: 25,
    estimatedOutputTokens: 400,
    ...overrides,
  };
}

function fakeRecorder(events: AccountingEvent[]): { record(event: AccountingEvent): void } {
  return {
    record(event: AccountingEvent): void {
      events.push(event);
    },
  };
}

async function withProxy<T>(
  cfg: Config,
  events: AccountingEvent[],
  fn: (base: string, port: number) => Promise<T>,
): Promise<T> {
  const proxy = createProxy(cfg, {
    controlAuthorization: { validate: (candidate) => candidate === controlToken },
    accountingRecorder: fakeRecorder(events),
  });
  await new Promise<void>((r) => proxy.listen(0, "127.0.0.1", () => r()));
  const { port } = proxy.address() as { port: number };
  try {
    return await fn(`http://127.0.0.1:${port}`, port);
  } finally {
    proxy.close();
  }
}

async function postTelemetry(base: string, body: unknown, headers: Record<string, string> = CONTROL_HEADERS) {
  return fetch(`${base}/dispatch/telemetry`, {
    method: "POST",
    headers,
    body: JSON.stringify(body),
  });
}

describe("POST /dispatch/telemetry", () => {
  it("records a valid cli report: 200, lane stats, and exactly one ledger request", async () => {
    const cfg = cfgWithLadder();
    const events: AccountingEvent[] = [];
    await withProxy(cfg, events, async (base) => {
      const res = await postTelemetry(base, cliReport());
      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({ recorded: true, accounting: "recorded" });
    });
    expect(laneStatsFor(cfg, "telemetry-cli")).toMatchObject({ calls: 1, successes: 1, failures: 0, timeouts: 0 });

    const types = events.map((e) => e.type);
    expect(types).toEqual(["request-started", "attempt-started", "attempt-completed", "request-completed"]);

    const started = events[0]!;
    expect(started).toMatchObject({
      type: "request-started",
      client: "mcp-dispatch",
      attribution: "unknown",
      provider: null,
      model: "openai/gpt-5",
      credentialId: null,
    });

    const attemptStarted = events[1]!;
    expect(attemptStarted).toMatchObject({
      type: "attempt-started",
      role: "serve",
      attribution: "unknown",
      provider: null,
      model: "openai/gpt-5",
      credentialId: null,
    });

    const attemptCompleted = events[2] as AttemptCompletedEvent;
    expect(attemptCompleted).toMatchObject({
      type: "attempt-completed",
      outcome: "success",
      failureKind: null,
      attribution: "unknown",
      provider: null,
      model: "openai/gpt-5",
      credentialId: null,
    });
    const tokens = attemptCompleted.tokens;
    // The dispatch ENVELOPE, honestly labelled: estimated cells carry the figures with
    // source "relay_estimated" and method "relay_estimate"; reported cells stay null —
    // never the lane's provider consumption, which the relay cannot see (D2).
    expect(tokens.estimated?.estimatedInput).toMatchObject({
      value: 25,
      source: "relay_estimated",
      method: "relay_estimate",
    });
    expect(tokens.estimated?.estimatedOutput).toMatchObject({
      value: 400,
      source: "relay_estimated",
      method: "relay_estimate",
    });
    for (const cell of Object.values(tokens.reported)) {
      expect(cell.value).toBeNull();
    }
    expect(attemptCompleted.spend).toBeNull();

    const requestCompleted = events[3] as RequestCompletedEvent;
    expect(requestCompleted).toMatchObject({
      type: "request-completed",
      outcome: "success",
      attribution: "unknown",
    });
    expect(requestCompleted.spend).toBeNull();
  });

  it("falls back to the lane id when the report carries no spec", async () => {
    const cfg = cfgWithLadder();
    const events: AccountingEvent[] = [];
    const { spec: _dropped, ...withoutSpec } = cliReport();
    await withProxy(cfg, events, async (base) => {
      const res = await postTelemetry(base, withoutSpec);
      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({ recorded: true, accounting: "recorded" });
    });
    expect(events[0]).toMatchObject({ type: "request-started", model: "telemetry-cli" });
    expect(events[2]).toMatchObject({ type: "attempt-completed", model: "telemetry-cli" });
  });

  it("records relay-kind stats and writes NO accounting row (D1)", async () => {
    const cfg = cfgWithLadder();
    const events: AccountingEvent[] = [];
    await withProxy(cfg, events, async (base) => {
      const res = await postTelemetry(
        base,
        cliReport({ jobId: "job-0002", laneId: "telemetry-relay", kind: "relay", spec: undefined }),
      );
      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({ recorded: true, accounting: "skipped", reason: "relay-kind" });
    });
    expect(laneStatsFor(cfg, "telemetry-relay")).toMatchObject({ calls: 1, successes: 1 });
    expect(events).toEqual([]);
  });

  it("completes failed as error/unknown and timed_out as error/timeout", async () => {
    const cfg = cfgWithLadder();
    const failedEvents: AccountingEvent[] = [];
    await withProxy(cfg, failedEvents, async (base) => {
      const res = await postTelemetry(base, cliReport({ jobId: "job-0003", status: "failed", exitCode: 1 }));
      expect(res.status).toBe(200);
    });
    expect(failedEvents[2]).toMatchObject({ type: "attempt-completed", outcome: "error", failureKind: "unknown" });
    expect(failedEvents[3]).toMatchObject({ type: "request-completed", outcome: "error", failureKind: "unknown" });
    expect(laneStatsFor(cfg, "telemetry-cli")).toMatchObject({ calls: 1, failures: 1 });

    const cfg2 = cfgWithLadder();
    const timedOutEvents: AccountingEvent[] = [];
    await withProxy(cfg2, timedOutEvents, async (base) => {
      const res = await postTelemetry(
        base,
        cliReport({ jobId: "job-0004", status: "timed_out", exitCode: null, wallClockMs: 300_000 }),
      );
      expect(res.status).toBe(200);
    });
    expect(timedOutEvents[2]).toMatchObject({ type: "attempt-completed", outcome: "error", failureKind: "timeout" });
    expect(timedOutEvents[3]).toMatchObject({ type: "request-completed", outcome: "error", failureKind: "timeout" });
    expect(laneStatsFor(cfg2, "telemetry-cli")).toMatchObject({ calls: 1, failures: 1, timeouts: 1 });
  });

  it("400s a malformed body without echoing it", async () => {
    const cfg = cfgWithLadder();
    const events: AccountingEvent[] = [];
    await withProxy(cfg, events, async (base) => {
      for (const body of [
        cliReport({ kind: "agent" }),
        cliReport({ status: "cancelled" }),
        cliReport({ estimatedInputTokens: -1 }),
        cliReport({ providerKey: "openai" }),
        { jobId: "job-0005" },
        "just a string",
      ]) {
        const res = await postTelemetry(base, body);
        expect(res.status, JSON.stringify(body)).toBe(400);
        const text = await res.text();
        expect(text).not.toContain("job-0005");
        expect(text).toContain("telemetry report");
      }
    });
    expect(laneStatsFor(cfg, "telemetry-cli")).toBeUndefined();
    expect(events).toEqual([]);
  });

  it("holds the admission boundary: token, Origin, and content-type", async () => {
    const cfg = cfgWithLadder();
    const events: AccountingEvent[] = [];
    await withProxy(cfg, events, async (base) => {
      const missing = await postTelemetry(base, cliReport(), { "content-type": "application/json" });
      expect(missing.status).toBe(403);
      const wrong = await postTelemetry(base, cliReport(), {
        ...CONTROL_HEADERS,
        [CONTROL_AUTHORIZATION_HEADER]: "wrong",
      });
      expect(wrong.status).toBe(403);
      const foreign = await postTelemetry(base, cliReport(), {
        ...CONTROL_HEADERS,
        origin: "https://evil.example",
      });
      expect(foreign.status).toBe(403);
      const plain = await postTelemetry(base, cliReport(), {
        ...CONTROL_HEADERS,
        "content-type": "text/plain",
      });
      expect(plain.status).toBe(403);
    });
    expect(laneStatsFor(cfg, "telemetry-cli")).toBeUndefined();
    expect(events).toEqual([]);
  });

  it("answers GET with 404 — the route is POST-only", async () => {
    const cfg = cfgWithLadder();
    const events: AccountingEvent[] = [];
    await withProxy(cfg, events, async (base) => {
      const res = await fetch(`${base}/dispatch/telemetry`, { headers: CONTROL_HEADERS });
      expect(res.status).toBe(404);
    });
    expect(events).toEqual([]);
  });

  it("answers HEAD with 404 too — no read may slip past the guard into model routing (N6)", async () => {
    const cfg = cfgWithLadder();
    const events: AccountingEvent[] = [];
    await withProxy(cfg, events, async (base) => {
      const res = await fetch(`${base}/dispatch/telemetry`, { method: "HEAD", headers: CONTROL_HEADERS });
      expect(res.status).toBe(404);
    });
    expect(laneStatsFor(cfg, "telemetry-cli")).toBeUndefined();
    expect(events).toEqual([]);
  });

  it("400s an unknown lane and records NOTHING — stats or ledger (P1)", async () => {
    // Mirrors the `POST /dispatch` exhaustion branch: a stale MCP snapshot (renamed rung,
    // daemon not yet restarted) or a foreign token holder must not mint lane rows.
    const cfg = cfgWithLadder();
    const events: AccountingEvent[] = [];
    await withProxy(cfg, events, async (base) => {
      const res = await postTelemetry(base, cliReport({ jobId: "job-0007", laneId: "no-such-lane" }));
      expect(res.status).toBe(400);
      // Same wording shape as the exhaustion branch; read off the parsed body — the raw
      // text JSON-escapes the quotes.
      const body = (await res.json()) as { error: { message: string } };
      expect(body.error.message).toBe(`POST /dispatch/telemetry: no lane "no-such-lane" in routing.ladder`);
    });
    expect(laneStatsFor(cfg, "no-such-lane")).toBeUndefined();
    expect(events).toEqual([]);
  });

  it.each([
    ["ANTHROPIC_BASE_URL", "relay-routed claude rung"],
    ["OPENAI_BASE_URL", "relay-routed openai rung"],
  ])(
    "skips accounting for a cli rung routed back through this listener via %s (C1)",
    async (envName) => {
      const cfg = cfgWithLadder();
      const events: AccountingEvent[] = [];
      await withProxy(cfg, events, async (base) => {
        // The rung's declared env is the authority. The daemon compares against its own
        // listener from cfg (host:port) — the test proxy binds an ephemeral port, so the
        // env URL uses cfg.port, the address the daemon believes it listens on.
        const rung = cfg.routing.ladder!.find((r) => r.id === "telemetry-cli")!;
        rung.env = { [envName]: `http://127.0.0.1:${cfg.port}` };
        const res = await postTelemetry(base, cliReport({ jobId: `job-routed-${envName}` }));
        expect(res.status).toBe(200);
        expect(await res.json()).toEqual({ recorded: true, accounting: "skipped", reason: "relay-routed" });
      });
      expect(laneStatsFor(cfg, "telemetry-cli")).toMatchObject({ calls: 1, successes: 1 });
      expect(events).toEqual([]);
    },
  );

  it("records accounting when the rung's env points at ANOTHER origin", async () => {
    const cfg = cfgWithLadder();
    const events: AccountingEvent[] = [];
    await withProxy(cfg, events, async (base) => {
      // Same env name, different port: somebody else's relay, not this daemon's pipeline.
      const rung = cfg.routing.ladder!.find((r) => r.id === "telemetry-cli")!;
      rung.env = { ANTHROPIC_BASE_URL: `http://127.0.0.1:${cfg.port + 1}` };
      const res = await postTelemetry(base, cliReport({ jobId: "job-0008" }));
      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({ recorded: true, accounting: "recorded" });
    });
    expect(events.map((e) => e.type)).toEqual([
      "request-started",
      "attempt-started",
      "attempt-completed",
      "request-completed",
    ]);
  });

  it("treats the rung's kind as the authority: a mismatched report records stats only (C1)", async () => {
    // A stale MCP snapshot (rung renamed from relay to cli, daemon not yet restarted) must
    // never mint a ledger row on the report's word alone.
    const cfg = cfgWithLadder();
    const events: AccountingEvent[] = [];
    await withProxy(cfg, events, async (base) => {
      const res = await postTelemetry(
        base,
        cliReport({ jobId: "job-0009", kind: "relay", spec: undefined }),
      );
      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({ recorded: true, accounting: "skipped", reason: "kind-mismatch" });
    });
    expect(laneStatsFor(cfg, "telemetry-cli")).toMatchObject({ calls: 1, successes: 1 });
    expect(events).toEqual([]);
  });

  it("⚠ negative control: the HTTP scoring store never sees a lane id", async () => {
    // F2: CLI wall-clock must live in the lane-stats series ONLY. If this report ever
    // reached `recordModelCall`, the lane id would surface as a model key in /telemetry.
    const cfg = cfgWithLadder();
    const events: AccountingEvent[] = [];
    await withProxy(cfg, events, async (base) => {
      const laneId = "telemetry-cli-negative";
      const res = await postTelemetry(base, cliReport({ jobId: "job-0006", laneId }));
      expect(res.status).toBe(200);
      expect(laneStatsFor(cfg, laneId)).toMatchObject({ calls: 1 });
      const telemetry = await (await fetch(`${base}/telemetry`)).text();
      expect(telemetry).not.toContain(laneId);
    });
  });
});

describe("POST /dispatch/telemetry against a real AccountingStore", () => {
  it("persists cli reports through the store's schema guard: day shard carries requests:2, unpricedRequests:2", async () => {
    // Review checklist item 3: every suite above reads ledger claims off a FAKE recorder —
    // event shapes only. A row the persisted schema guard rejects would be green there while
    // silently stopping persistence. This replays two reports into a REAL store in a fresh
    // temp dir and asserts the day shard on disk parses and counts both rows.
    const cfg = cfgWithLadder();
    const usageDir = mkdtempSync(join(tmpdir(), "rp-telemetry-store-"));
    try {
      const store = createAccountingStore({ rootDir: usageDir });
      const recorder: AccountingRecorder = { record: (event) => store.record(event) };
      const proxy = createProxy(cfg, {
        controlAuthorization: { validate: (candidate) => candidate === controlToken },
        accountingRecorder: recorder,
      });
      await new Promise<void>((r) => proxy.listen(0, "127.0.0.1", () => r()));
      const { port } = proxy.address() as { port: number };
      try {
        const base = `http://127.0.0.1:${port}`;
        const completed = await postTelemetry(base, cliReport({ jobId: "job-0101" }));
        expect(completed.status).toBe(200);
        const timedOut = await postTelemetry(
          base,
          cliReport({ jobId: "job-0102", status: "timed_out", exitCode: null }),
        );
        expect(timedOut.status).toBe(200);
      } finally {
        proxy.close();
      }
      // The same durability boundary the proxy relies on at shutdown.
      const closed = store.close();
      expect(closed.retryable).toBe(false);
      expect(closed.status).toBe("committed");
      const day = new Date().toISOString().slice(0, 10);
      const parsed = parseAccountingDayShardV1(
        JSON.parse(readFileSync(join(usageDir, `${day}.json`), "utf8")),
      );
      expect(parsed.ok).toBe(true);
      if (!parsed.ok) return;
      let requests = 0;
      let unpricedRequests = 0;
      for (const cell of Object.values(parsed.value.cells)) {
        requests += cell.aggregate.requests;
        unpricedRequests += cell.aggregate.unpricedRequests;
      }
      expect(requests).toBe(2);
      expect(unpricedRequests).toBe(2);
    } finally {
      rmSync(usageDir, { recursive: true, force: true });
    }
  });
});
