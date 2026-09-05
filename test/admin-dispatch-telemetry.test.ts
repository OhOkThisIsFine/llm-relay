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
import { writeFileSync, mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { loadConfig, type Config } from "../src/config.js";
import { createProxy } from "../src/server.js";
import { CONTROL_AUTHORIZATION_HEADER } from "../src/control-authorization.js";
import type { AccountingEvent, AttemptCompletedEvent, RequestCompletedEvent } from "../src/accounting.js";
import { laneStatsFor } from "../src/dispatch-lane-stats.js";

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
  fn: (base: string) => Promise<T>,
): Promise<T> {
  const proxy = createProxy(cfg, {
    controlAuthorization: { validate: (candidate) => candidate === controlToken },
    accountingRecorder: fakeRecorder(events),
  });
  await new Promise<void>((r) => proxy.listen(0, "127.0.0.1", () => r()));
  const { port } = proxy.address() as { port: number };
  try {
    return await fn(`http://127.0.0.1:${port}`);
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
      expect(await res.json()).toEqual({ recorded: true, accounting: "skipped" });
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

  it("⚠ negative control: the HTTP scoring store never sees a lane id", async () => {
    // F2: CLI wall-clock must live in the lane-stats series ONLY. If this report ever
    // reached `recordModelCall`, the lane id would surface as a model key in /telemetry.
    const cfg = cfgWithLadder();
    const events: AccountingEvent[] = [];
    await withProxy(cfg, events, async (base) => {
      const laneId = "telemetry-cli-negative-control";
      const res = await postTelemetry(base, cliReport({ jobId: "job-0006", laneId }));
      expect(res.status).toBe(200);
      expect(laneStatsFor(cfg, laneId)).toMatchObject({ calls: 1 });
      const telemetry = await (await fetch(`${base}/telemetry`)).text();
      expect(telemetry).not.toContain(laneId);
    });
  });
});
