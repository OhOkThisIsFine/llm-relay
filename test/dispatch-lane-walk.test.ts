/**
 * The automatic dispatch lane WALK (`src/mcp/server.ts`, owner request 2026-09-06).
 *
 * `dispatch` used to run ONE lane and report a failure when that lane was slow; the calling agent
 * then picked the next lane by hand. It now walks the ladder past a lane that shows no activity
 * for `idleMs`, kills that lane, tries the next, and — when every lane is spent — returns an
 * instruction to do the work in the calling session instead.
 *
 * ⚠ **The slow lane here NEVER resolves on its own; it resolves only when killed.** That makes
 * every walk assertion deterministic rather than a race between two timers: if the idle stop failed to
 * fire, the test hangs and fails outright instead of passing on a lucky schedule.
 *
 * ⚠ **The `Config` is hand-built rather than loaded.** `parseDispatchWalk` floors `idleMs` at
 * 30 seconds, which is right for an operator and too slow for this suite. The server reads the
 * settings directly here; parser bounds are covered in `test/config.test.ts`.
 */
import { describe, it, expect } from "vitest";
import {
  McpDispatchServer,
  LANE_LADDER_EXHAUSTED_ADVICE,
  LANE_LADDER_PARTIAL_ADVICE,
  type McpServerDeps,
} from "../src/mcp/server.js";
import type { Config, DispatchWalkSettings } from "../src/config.js";
import type { DispatchLane, DispatchView } from "../src/dispatch.js";
import type { DispatchedTelemetryReport } from "../src/dispatch-lane-stats.js";
import type { LaneRunResult, LaneSpawner } from "../src/mcp/lane-runner.js";

const WALK: DispatchWalkSettings = {
  enabled: true,
  idleMs: 40,
  attemptMs: 40,
  // Legacy compatibility fields; the walk does not read them.
  agentAttemptMs: 40,
  attemptQuantile: 0.8,
  // Still live for history fallback/outliers; these fixtures record no history.
  attemptMinSamples: 1000,
  // The outlier rule reads recorded history these fixtures never write; off keeps the walk's
  // timing the only thing under test here.
  outlier: false,
  maxLanes: 4,
  pinMs: 60_000,
  demoteMs: 60_000,
};

function config(walk: DispatchWalkSettings | undefined = WALK): Config {
  return { host: "127.0.0.1", port: 8791, routing: { dispatchWalk: walk } } as unknown as Config;
}

function lane(over: Partial<DispatchLane> = {}): DispatchLane {
  return {
    id: "lane",
    kind: "cli",
    position: 1,
    state: "ready",
    invoke: { command: "run", args: ["{task}"] },
    ...over,
  };
}

/** A ladder of `n` ready cli rungs named `l1..ln`, with `order` matching. */
function view(ids: readonly string[], over: Partial<DispatchView> = {}): DispatchView {
  const ladder = ids.map((id, i) => lane({ id, position: i + 1, invoke: { command: id, args: ["{task}"] } }));
  return {
    tier: "medium",
    offload: false,
    client: "claude",
    host: "bypassed",
    ladder,
    order: [...ids],
    next: ladder[0] ?? null,
    reason: "first lane in the ladder",
    ...over,
  };
}

/**
 * A spawner whose lanes answer only if their id is in `answers`. Every other lane HANGS until it
 * is killed, at which point it resolves the way a killed child does.
 */
function laneRunner(answers: Record<string, LaneRunResult>): LaneSpawner & {
  started: string[];
  killed: string[];
} {
  const started: string[] = [];
  const killed: string[] = [];
  const fn: LaneSpawner = (command) => {
    started.push(command);
    const answer = answers[command];
    if (answer) return { result: Promise.resolve(answer), kill: () => {} };
    let settle: (r: LaneRunResult) => void = () => {};
    const result = new Promise<LaneRunResult>((resolve) => {
      settle = resolve;
    });
    return {
      result,
      kill: () => {
        killed.push(command);
        settle({ code: null, stdout: "", stderr: "killed", timedOut: false });
      },
    };
  };
  return Object.assign(fn, { started, killed });
}

const ok = (stdout: string): LaneRunResult => ({ code: 0, stdout, stderr: "", timedOut: false });
const nonZero = (stderr: string): LaneRunResult => ({ code: 1, stdout: "", stderr, timedOut: false });

class Harness {
  readonly out: string[] = [];
  readonly server: McpDispatchServer;
  private id = 0;

  constructor(over: Partial<McpServerDeps> = {}) {
    this.server = new McpDispatchServer({
      config: config(),
      buildView: async () => view(["l1", "l2", "l3"]),
      spawn: laneRunner({ l1: ok("answer") }),
      cwd: () => process.cwd(),
      write: (chunk) => this.out.push(chunk),
      ...over,
    });
  }

  /**
   * Send one request and WAIT for its response. `ingest` deliberately does not await handlers
   * (v0.72.1), and a walk is several awaits deep, so polling for the line is the only correct way
   * to read one — reading `out` straight after `ingest` would race the walk.
   */
  async tool(name: string, args: Record<string, unknown> = {}): Promise<{ text: string; isError: boolean }> {
    this.id += 1;
    const before = this.out.length;
    this.server.ingest(JSON.stringify({ jsonrpc: "2.0", id: this.id, method: "tools/call", params: { name, arguments: args } }) + "\n");
    const deadline = Date.now() + 5_000;
    while (this.out.length === before && Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 5));
    }
    const line = this.out[before];
    expect(line, `no response for ${name}`).toBeDefined();
    const res = JSON.parse(line as string) as Record<string, unknown>;
    const result = res["result"] as { content: { text: string }[]; isError: boolean };
    expect(result, `error response: ${line}`).toBeDefined();
    return { text: result.content[0]?.text ?? "", isError: result.isError };
  }
}

describe("dispatch lane walk", () => {
  it("walks past a lane that does not answer inside the budget and serves the next lane's answer", async () => {
    const spawn = laneRunner({ l2: ok("the second lane answered") });
    const h = new Harness({ spawn });
    const { text, isError } = await h.tool("dispatch", { task: "do it" });
    expect(isError).toBe(false);
    expect(text).toContain("the second lane answered");
    expect(spawn.started).toEqual(["l1", "l2"]);
    // ⚠ It kills what it leaves. A lane hedge would spend two lanes' quota at once, and this
    // machine already carries a filed defect in which lane processes are never reaped.
    expect(spawn.killed).toEqual(["l1"]);
  });

  it("⚠ stops an idle lane at idleMs regardless of advisory time-to-answer history", async () => {
    const spawn = laneRunner({ l2: ok("the second lane answered") });
    const withHistory = view(["l1", "l2"]);
    withHistory.ladder[0]!.timeToAnswer = { medianMs: 5_000, p80Ms: 8_000, samples: 10, mode: "agent" };
    const h = new Harness({ buildView: async () => withHistory, spawn });
    const { text, isError } = await h.tool("dispatch", { task: "do it" });
    expect(isError).toBe(false);
    expect(text).toContain("the second lane answered");
    expect(spawn.started).toEqual(["l1", "l2"]);
    expect(text).toContain("no activity for 0s (no relay traffic, output, process CPU or file change)");
  });

  it("names every lane it tried and why, so the walk is legible", async () => {
    const h = new Harness({ spawn: laneRunner({ l3: ok("third time") }) });
    const { text } = await h.tool("dispatch", { task: "do it" });
    expect(text).toContain("lanes tried:");
    expect(text).toContain("1. l1");
    expect(text).toContain("abandoned after");
    expect(text).toContain("no activity for");
    expect(text).toContain("3. l3");
    expect(text).toContain("completed after");
  });

  it("completion wins when the lane settles while an activity probe is in flight", async () => {
    let finishLane: (r: LaneRunResult) => void = () => {};
    let releaseProbe: () => void = () => {};
    let probeStarted: () => void = () => {};
    const probeHasStarted = new Promise<void>((resolve) => { probeStarted = resolve; });

    const started: string[] = [];
    const spawn: LaneSpawner = (command) => {
      started.push(command);
      if (command === "l1") {
        const result = new Promise<LaneRunResult>((resolve) => { finishLane = resolve; });
        return {
          result,
          // Terminal jobs are reaped even after successful completion, so the kill callback is not
          // evidence of abandonment. The telemetry assertion below pins the routing verdict.
          kill: () => {},
        };
      }
      return { result: Promise.resolve(ok("second lane should never run")), kill: () => {} };
    };

    const reports: DispatchedTelemetryReport[] = [];
    const readLaneActivity = async (): Promise<null> => {
      probeStarted();
      await new Promise<void>((resolve) => { releaseProbe = resolve; });
      return null;
    };

    const h = new Harness({
      config: config({ ...WALK, idleMs: 20 }),
      buildView: async () => view(["l1", "l2"]),
      spawn,
      readLaneActivity,
      reportTelemetry: (report) => { reports.push(report); },
    });

    const answer = h.tool("dispatch", { task: "do it" });
    await probeHasStarted;
    finishLane(ok("finished during the probe"));
    releaseProbe();

    const { text, isError } = await answer;
    expect(isError).toBe(false);
    expect(text).toContain("finished during the probe");
    expect(started).toEqual(["l1"]);
    expect(text).not.toContain("abandoned");
    expect(reports.map((report) => [report.laneId, report.status])).toEqual([["l1", "completed"]]);
  });

  it("⚠ the LAST lane is never idle-stopped — it is awaited, not abandoned", async () => {
    // Only l3 answers, and it answers LATE. There is nowhere left to move to, so an idle stop would
    // only throw away the sole answer still coming.
    let settle: (r: LaneRunResult) => void = () => {};
    const started: string[] = [];
    const spawn: LaneSpawner = (command) => {
      started.push(command);
      if (command === "l3") {
        setTimeout(() => settle(ok("late but real")), 150).unref?.();
        return { result: new Promise<LaneRunResult>((r) => { settle = r; }), kill: () => {} };
      }
      return { result: new Promise<LaneRunResult>(() => {}), kill: () => settleKilled(command) };
    };
    const killed: string[] = [];
    function settleKilled(command: string): void {
      killed.push(command);
    }
    const h = new Harness({ spawn: Object.assign(spawn, { started, killed }) as never });
    const { text, isError } = await h.tool("dispatch", { task: "do it" });
    expect(isError).toBe(false);
    expect(text).toContain("late but real");
    expect(started).toEqual(["l1", "l2", "l3"]);
    expect(killed).not.toContain("l3");
  });

  it("returns the terminal fallback instruction when every lane is spent", async () => {
    // ⚠ Every lane FAILS FAST here rather than hanging, and that matters: the last lane is never
    // idle-stopped, so a hanging last lane is correctly still WAITED FOR and the walk has not ended.
    // The terminal instruction is for a walk that truly finished with nothing.
    const spawn = laneRunner({ l1: nonZero("no"), l2: nonZero("no"), l3: nonZero("no") });
    const h = new Harness({ spawn });
    const { text, isError } = await h.tool("dispatch", { task: "do it" });
    expect(isError).toBe(true);
    // Pinned on the CLAIMS, not the wording — reword the constant freely, but change this
    // deliberately rather than deleting it.
    expect(text).toContain(LANE_LADDER_EXHAUSTED_ADVICE);
    expect(LANE_LADDER_EXHAUSTED_ADVICE).toContain("Do NOT call dispatch again");
    expect(LANE_LADDER_EXHAUSTED_ADVICE).toContain("own subagent");
    expect(spawn.started).toEqual(["l1", "l2", "l3"]);
  });

  it("never claims the ladder is exhausted when a lane DID answer", async () => {
    const h = new Harness({ spawn: laneRunner({ l2: ok("answered") }) });
    const { text } = await h.tool("dispatch", { task: "do it" });
    expect(text).not.toContain(LANE_LADDER_EXHAUSTED_ADVICE);
  });

  it("stops at maxLanes and says how many it did not try — no silent caps", async () => {
    const spawn = laneRunner({ l1: nonZero("no"), l2: nonZero("no") });
    const h = new Harness({
      config: config({ ...WALK, maxLanes: 2 }),
      buildView: async () => view(["l1", "l2", "l3", "l4"]),
      spawn,
    });
    const { text } = await h.tool("dispatch", { task: "do it" });
    expect(spawn.started).toEqual(["l1", "l2"]);
    expect(text).toContain("2 further lanes not tried");
    // ⚠ And it must NOT also claim the ladder was exhausted. The two statements contradicted each
    // other in one answer until adversarial review caught it (2026-09-06): "2 further lanes not
    // tried" beside "Every dispatch lane has now been tried for this task".
    expect(text).not.toContain(LANE_LADDER_EXHAUSTED_ADVICE);
    expect(text).toContain(LANE_LADDER_PARTIAL_ADVICE);
    // The partial advice must not repeat the exhausted one's stop-delegating instruction: the
    // walk just demoted every lane it tried, so a retry genuinely reaches different ones.
    expect(LANE_LADDER_PARTIAL_ADVICE).not.toContain("Do NOT call dispatch again");
  });

  it("a non-zero exit is an ordinary failed attempt: the walk moves on", async () => {
    const spawn = laneRunner({ l1: nonZero("boom"), l2: ok("recovered") });
    const h = new Harness({ spawn });
    const { text, isError } = await h.tool("dispatch", { task: "do it" });
    expect(isError).toBe(false);
    expect(text).toContain("recovered");
    expect(spawn.started).toEqual(["l1", "l2"]);
    expect(text).toContain("failed after");
  });

  it("content-empty output is a failure, so the walk moves on rather than returning nothing", async () => {
    // The measured case: a 652-second review that returned only `#`.
    const spawn = laneRunner({ l1: ok("#"), l2: ok("a real answer") });
    const h = new Harness({ spawn });
    const { text } = await h.tool("dispatch", { task: "do it" });
    expect(text).toContain("a real answer");
    expect(spawn.started).toEqual(["l1", "l2"]);
  });

  it("a bad working directory REFUSES the whole walk instead of blaming each lane in turn", async () => {
    const spawn = laneRunner({});
    const h = new Harness({ spawn, cwd: () => join_nonexistent() });
    const { text, isError } = await h.tool("dispatch", { task: "do it" });
    expect(isError).toBe(true);
    expect(text).toContain("working directory does not exist");
    // ⚠ Zero lanes started. Walking on would hide the caller's own mistake behind a lane failure
    // and send the operator looking in the wrong place.
    expect(spawn.started).toEqual([]);
  });
});

describe("dispatch lane walk — cancellation", () => {
  it("⚠ cancelling a walk STOPS it: no further lane is started", async () => {
    // ⚠ The budget is deliberately LONG here, so the walk can never advance on its own. The only
    // thing that can start a second lane is the walk continuing after the cancel — which is
    // precisely the behaviour under test. An earlier version of this test used the short default
    // budget and captured its baseline AFTER the cancel round trip, and BOTH cancellation guards
    // could then be deleted with the test still green: it proved nothing. That failure mode has a
    // name in this repository — a test that pins nothing reads exactly like one that pins the fix.
    const spawn = laneRunner({});
    const h = new Harness({ config: config({ ...WALK, attemptMs: 5_000 }), spawn });
    const first = await h.tool("dispatch", { task: "do it", waitMs: 20 });
    const jobId = /job: (job-\d+)/.exec(first.text)?.[1];
    expect(jobId, first.text).toBeDefined();
    // Exactly one lane is running, and the budget will not expire during this test.
    expect(spawn.started).toEqual(["l1"]);

    // Cancelling resolves the hanging lane through its kill handle, so the in-flight attempt
    // settles at once. Without the cancellation guards the walk would take that settlement as an
    // ordinary failed attempt and start l2.
    const cancelled = await h.tool("dispatch_cancel", { jobId });
    expect(cancelled.text).toContain("cancelled");
    await new Promise((r) => setTimeout(r, 150));
    expect(spawn.started).toEqual(["l1"]);
    expect(spawn.killed).toEqual(["l1"]);

    const status = await h.tool("dispatch_status", { jobId });
    expect(status.text).toContain("status: cancelled");
    // ⚠ And a cancelled walk must NOT claim the ladder was exhausted — the caller stopped it, so
    // nothing was proved about the remaining lanes.
    expect(status.text).not.toContain(LANE_LADDER_EXHAUSTED_ADVICE);
    // ⚠ Nor does it record the interrupted lane as a tried ATTEMPT. A cancellation is the caller
    // changing its mind, which is not evidence about the lane, so it must not enter the record any
    // more than it enters telemetry. This is the assertion that separates the two cancellation
    // guards: the post-attempt one is what keeps this record empty, and without it the walk still
    // stops but files a bogus failed attempt against a lane the operator interrupted.
    expect(status.text).not.toContain("lanes tried:");
  });

  // ⚠ MUTATION-CHECK NOTE, recorded because it nearly produced a wrong conclusion twice.
  //
  // `runWalk` has TWO cancellation guards — one at the top of each iteration, one after the
  // attempt settles — and for "no further lane is started" EITHER ALONE IS SUFFICIENT. Mutating
  // one and seeing this file green therefore proves nothing about that guard. Measured:
  //   - post-attempt guard removed  -> FAILS, on the `lanes tried:` assertion. That guard is what
  //     keeps a cancelled walk from filing a bogus failed attempt against the interrupted lane.
  //   - top-of-loop guard removed   -> passes. It covers a window this test cannot isolate: a
  //     cancel landing BETWEEN attempts, after the post-attempt check and before the next lane is
  //     started. Without it the walk would spawn one more lane on a cancelled job.
  //   - BOTH removed                -> FAILS, on the started-lane assertion.
  //
  // ⚠ The `lanes tried:` assertion only became meaningful once `describeJob` rendered the attempt
  // list. Before that it asserted against text `dispatch_status` never printed — true by
  // construction, and therefore worthless. Check what the surface actually renders before trusting
  // a `not.toContain`.
});

describe("dispatch lane walk — disabled", () => {
  it("with the walk OFF, exactly one lane runs and no budget applies", async () => {
    const spawn = laneRunner({});
    const h = new Harness({ config: config({ ...WALK, enabled: false }), spawn });
    // The single lane hangs and would be abandoned if a budget applied. It is not, so the only way
    // this test finishes is the lane's own kill path never firing — assert on what DID start.
    const pending = h.tool("dispatch", { task: "do it", waitMs: 60 });
    const { text } = await pending;
    expect(spawn.started).toEqual(["l1"]);
    expect(spawn.killed).toEqual([]);
    expect(text).toContain("Still running");
  });

  it("⚠ with the walk OFF, a failed lane claims NOTHING about the rest of the ladder", async () => {
    // The documented promise is that `dispatchWalk: false` restores the pre-walk behaviour
    // EXACTLY, and the pre-walk answer carried no terminal advice at all. Until adversarial review
    // caught it (2026-09-06), one failed lane under the documented revert told the caller "Every
    // dispatch lane has now been tried for this task… Do NOT call dispatch again" — with a dozen
    // rungs never contacted. An autonomous caller acting on that abandons free capacity.
    const spawn = laneRunner({ l1: nonZero("no") });
    const h = new Harness({
      config: config({ ...WALK, enabled: false }),
      buildView: async () => view(["l1", "l2", "l3"]),
      spawn,
    });
    const { text } = await h.tool("dispatch", { task: "do it" });
    expect(spawn.started).toEqual(["l1"]);
    expect(text).not.toContain(LANE_LADDER_EXHAUSTED_ADVICE);
    expect(text).not.toContain(LANE_LADDER_PARTIAL_ADVICE);
  });

  it("with NO dispatchWalk configured at all, behaviour is the pre-walk single lane", async () => {
    const spawn = laneRunner({ l1: ok("only lane") });
    const h = new Harness({ config: config(undefined), spawn });
    const { text, isError } = await h.tool("dispatch", { task: "do it" });
    expect(isError).toBe(false);
    expect(text).toContain("only lane");
    expect(spawn.started).toEqual(["l1"]);
  });

  it("tolerates a view with NO `order` field — a daemon older than this feature", async () => {
    const spawn = laneRunner({ l1: ok("legacy daemon") });
    const legacy = view(["l1", "l2"]);
    delete (legacy as { order?: string[] }).order;
    const h = new Harness({ spawn, buildView: async () => legacy });
    const { text, isError } = await h.tool("dispatch", { task: "do it" });
    expect(isError).toBe(false);
    expect(text).toContain("legacy daemon");
    expect(spawn.started).toEqual(["l1"]);
  });
});

describe("dispatch lane walk — telemetry", () => {
  it("forwards ONE report per attempt, each with that attempt's own status and wall clock", async () => {
    const reports: DispatchedTelemetryReport[] = [];
    const h = new Harness({
      spawn: laneRunner({ l2: ok("answered") }),
      reportTelemetry: (r) => {
        reports.push(r);
      },
    });
    await h.tool("dispatch", { task: "do it" });
    expect(reports.map((r) => [r.laneId, r.status])).toEqual([
      ["l1", "abandoned"],
      ["l2", "completed"],
    ]);
    // ⚠ Each report carries THIS attempt's wall clock, not the walk's. Charging the winner with the
    // abandoned budget ahead of it would make every late lane look slow.
    expect(reports[1]!.wallClockMs).toBeLessThan(WALK.attemptMs * 4);
    // The tier travels, because the daemon's routing memory is keyed by it.
    expect(reports.every((r) => r.tier === "medium")).toBe(true);
  });
});

/** A path that certainly does not exist, without importing node:path into the assertions above. */
function join_nonexistent(): string {
  return `${process.cwd()}/definitely-not-a-directory-${Math.random().toString(36).slice(2)}`;
}
