/**
 * The MCP half of the 2026-09-10 dispatch fixes (`docs/history/dispatch-giveup-diagnosis-2026-09-10.md` §9):
 * F1 a working lane is never traded for lanes that cannot answer; F3 a pass-through lane never runs
 * in the MCP walk; F4 an honest last message; F5 a caller-named model; F6 the quota death AGY states
 * only in its log; F8 the usual time to answer on a poll; F9 a stale process says so; and the
 * evidence `dispatch_lanes` shows for each lane.
 *
 * ⚠ A lane that hangs here resolves ONLY when it is killed, so each walk assertion is deterministic:
 * a budget that failed to fire hangs the test instead of passing on a lucky schedule. The `Config` is
 * hand-built for the reason `test/dispatch-lane-walk.test.ts` states — the parser floors `attemptMs`
 * at 1000 ms, and a suite must not wait a second per stopped lane.
 */
import { describe, it, expect } from "vitest";
import {
  FORCED_LANE_ADVICE,
  LANE_LADDER_EXHAUSTED_ADVICE,
  McpDispatchServer,
  laneStoppedAdvice,
  type DispatchViewBuilder,
  type McpServerDeps,
} from "../src/mcp/server.js";
import type { Config, DispatchWalkSettings } from "../src/config.js";
import { mcpPassThroughReason, type DispatchLane, type DispatchView } from "../src/dispatch.js";
import type { DispatchedTelemetryReport } from "../src/dispatch-lane-stats.js";
import type { DispatchedQuotaReport, LaneRunResult, LaneSpawner } from "../src/mcp/lane-runner.js";
import type { AgyLogSnapshot } from "../src/mcp/agy-quota-log.js";

const WALK: DispatchWalkSettings = {
  enabled: true,
  idleMs: 40,
  attemptMs: 40,
  agentAttemptMs: 40,
  attemptQuantile: 0.8,
  // Far above anything recorded here, so no lane's budget comes from history.
  attemptMinSamples: 1000,
  outlier: false,
  maxLanes: 4,
  pinMs: 60_000,
  demoteMs: 60_000,
};

/** Carries the Anthropic pass-through, so the server's own pass-through test has one to find. */
function config(walk: DispatchWalkSettings | undefined = WALK): Config {
  return {
    host: "127.0.0.1",
    port: 8791,
    providers: {
      anthropic: { base: "https://api.anthropic.com", kind: "anthropic" },
      deepseek: { base: "https://api.deepseek.com/v1", kind: "openai", authEnv: "DEEPSEEK_API_KEY" },
    },
    routing: { dispatchWalk: walk },
  } as unknown as Config;
}

function cli(id: string, over: Partial<DispatchLane> = {}): DispatchLane {
  return { id, kind: "cli", position: 1, state: "ready", invoke: { command: id, args: ["{task}"] }, ...over };
}

/** A view over `lanes` in this order, positions renumbered, `next` the first. */
function view(lanes: DispatchLane[], over: Partial<DispatchView> = {}): DispatchView {
  const ladder = lanes.map((l, i) => ({ ...l, position: i + 1 }));
  return {
    tier: "medium",
    offload: false,
    client: "claude",
    host: "bypassed",
    ladder,
    order: ladder.map((l) => l.id),
    next: ladder[0] ?? null,
    reason: "first lane in the ladder",
    ...over,
  };
}

const ok = (stdout: string): LaneRunResult => ({ code: 0, stdout, stderr: "", timedOut: false });
const nonZero = (stderr: string): LaneRunResult => ({ code: 1, stdout: "", stderr, timedOut: false });

type Answer = LaneRunResult | { lateMs: number; result: LaneRunResult };

/**
 * Lanes keyed by COMMAND answer as given — at once, or `lateMs` later. Every other lane HANGS until
 * it is killed, and then resolves the way a killed child does.
 */
function laneRunner(answers: Record<string, Answer>): LaneSpawner & { started: string[]; killed: string[] } {
  const started: string[] = [];
  const killed: string[] = [];
  const fn: LaneSpawner = (command) => {
    started.push(command);
    let running = true;
    let settle: (r: LaneRunResult) => void = () => {};
    const result = new Promise<LaneRunResult>((resolve) => {
      settle = (r) => {
        running = false;
        resolve(r);
      };
    });
    const answer = answers[command];
    if (answer !== undefined && "lateMs" in answer) {
      setTimeout(() => settle(answer.result), answer.lateMs).unref?.();
    } else if (answer !== undefined) {
      settle(answer);
    }
    return {
      result,
      kill: () => {
        // A kill after the lane settled is the reaper tidying up (`LaneJobStore` reaps every job's
        // processes when it ends), not the walk stopping a lane — so only a RUNNING lane's kill counts.
        if (running) killed.push(command);
        settle({ code: null, stdout: "", stderr: "killed", timedOut: false });
      },
    };
  };
  return Object.assign(fn, { started, killed });
}

class Harness {
  readonly out: string[] = [];
  readonly server: McpDispatchServer;
  private id = 0;

  constructor(over: Partial<McpServerDeps> = {}) {
    this.server = new McpDispatchServer({
      config: config(),
      buildView: async () => view([cli("l1"), cli("l2"), cli("l3")]),
      spawn: laneRunner({ l1: ok("answer") }),
      cwd: () => process.cwd(),
      write: (chunk) => this.out.push(chunk),
      ...over,
    });
  }

  /** Send one request and WAIT for its response — `ingest` does not await handlers (v0.72.1). */
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

/** Poll until `predicate` holds — for an effect that lands after the reply. Never a fixed sleep. */
async function until(predicate: () => boolean, ms = 2_000): Promise<void> {
  const deadline = Date.now() + ms;
  while (!predicate() && Date.now() < deadline) await new Promise((r) => setTimeout(r, 5));
}

describe("F1 — a working lane is never traded for lanes that cannot answer", () => {
  it("a lane followed only by lanes on a failure streak gets NO budget: the walk waits for its late answer", async () => {
    // Measured 2026-09-10: the walk stopped free-pool at its budget to try lanes that had answered
    // 0 of 12, 0 of 34 and 0 of 21 runs. Here l1 answers after 150 ms, far past the 40 ms budget; l2
    // is on a streak of three own failures and l3 is marked failing.
    const spawn = laneRunner({ l1: { lateMs: 150, result: ok("late but real") }, l2: nonZero("no"), l3: nonZero("no") });
    const h = new Harness({
      buildView: async () =>
        view([
          cli("l1"),
          cli("l2", { recentFailures: 3 }),
          cli("l3", { recentFailures: 7, failing: { streak: 7, reason: "7 own failures in a row" } }),
        ]),
      spawn,
    });
    const { text, isError } = await h.tool("dispatch", { task: "do it" });
    expect(isError).toBe(false);
    expect(text).toContain("late but real");
    expect(spawn.started).toEqual(["l1"]);
    expect(spawn.killed).toEqual([]);
  });

  it("negative control: one reliable lane after it keeps the budget, so the walk still moves past a silent lane", async () => {
    const spawn = laneRunner({ l1: { lateMs: 150, result: ok("too late") }, l2: ok("the second lane answered") });
    const h = new Harness({
      buildView: async () => view([cli("l1"), cli("l2", { recentFailures: 2 }), cli("l3", { recentFailures: 9 })]),
      spawn,
    });
    const { text } = await h.tool("dispatch", { task: "do it" });
    expect(text).toContain("the second lane answered");
    expect(spawn.started).toEqual(["l1", "l2"]);
    expect(spawn.killed).toEqual(["l1"]);
  });
});

describe("F4 — an honest last message", () => {
  it("a lane the walk STOPPED is named, with the call that lets it finish — never 'every lane was tried'", async () => {
    // l1 hangs past its budget and is stopped; l2, the last lane, fails on its own.
    const spawn = laneRunner({ l2: nonZero("no") });
    const h = new Harness({ buildView: async () => view([cli("l1"), cli("l2")]), spawn });
    const { text, isError } = await h.tool("dispatch", { task: "do it" });
    expect(isError).toBe(true);
    expect(spawn.killed).toEqual(["l1"]);
    expect(text).toContain(laneStoppedAdvice("l1"));
    expect(text).not.toContain(LANE_LADDER_EXHAUSTED_ADVICE);
  });

  it("a NAMED lane that fails is told only that lane ran", async () => {
    // Measured 2026-09-10 on jobs 0023 and 0024: each ran one forced lane and was told to stop
    // delegating the task, as if the whole ladder had been tried.
    const seen: Array<Parameters<DispatchViewBuilder>[0]> = [];
    const h = new Harness({
      buildView: async (opts) => {
        seen.push(opts);
        return view([cli("l1")]);
      },
      spawn: laneRunner({ l1: nonZero("no") }),
    });
    const { text, isError } = await h.tool("dispatch", { task: "do it", lane: "l1" });
    expect(isError).toBe(true);
    expect(seen[0]?.lane).toBe("l1");
    expect(text).toContain(FORCED_LANE_ADVICE);
    expect(text).not.toContain(LANE_LADDER_EXHAUSTED_ADVICE);
  });

  it("negative control: when every lane ran and failed on its own, the exhausted advice stands", async () => {
    const spawn = laneRunner({ l1: nonZero("no"), l2: nonZero("no") });
    const h = new Harness({ buildView: async () => view([cli("l1"), cli("l2")]), spawn });
    const { text } = await h.tool("dispatch", { task: "do it" });
    expect(text).toContain(LANE_LADDER_EXHAUSTED_ADVICE);
  });
});

describe("F5 — a caller-named model", () => {
  const modelLane = (): DispatchLane => ({
    id: "model:deepseek/deepseek-flash",
    kind: "relay",
    position: 1,
    state: "ready",
    spec: "deepseek/deepseek-flash",
    adHoc: true,
    invoke: { command: "claude-lane", args: ["-p", "{task}", "--model", "deepseek/deepseek-flash"] },
  });

  it("reaches the view builder with the mode, runs as the one lane, and is never reported as a rung", async () => {
    const seen: Array<Parameters<DispatchViewBuilder>[0]> = [];
    const reports: DispatchedTelemetryReport[] = [];
    const spawn = laneRunner({ "claude-lane": ok("from deepseek") });
    const h = new Harness({
      buildView: async (opts) => {
        seen.push(opts);
        return view([modelLane()]);
      },
      spawn,
      reportTelemetry: (r) => {
        reports.push(r);
      },
    });
    const { text, isError } = await h.tool("dispatch", { task: "do it", model: "deepseek/deepseek-flash" });
    expect(isError).toBe(false);
    expect(text).toContain("from deepseek");
    expect(seen[0]).toMatchObject({ model: "deepseek/deepseek-flash", mode: "agent" });
    expect(spawn.started).toEqual(["claude-lane"]);
    // ⚠ `/dispatch/telemetry` knows only ladder lane ids and would refuse this one; the relay's own
    // HTTP pipeline meters its traffic anyway.
    expect(reports).toEqual([]);
  });

  it("lane and model together are refused before anything is built or spawned", async () => {
    let built = 0;
    const spawn = laneRunner({});
    const h = new Harness({
      buildView: async () => {
        built += 1;
        return view([cli("l1")]);
      },
      spawn,
    });
    const { text, isError } = await h.tool("dispatch", { task: "do it", lane: "l1", model: "deepseek/deepseek-flash" });
    expect(isError).toBe(true);
    expect(text).toContain("not both");
    expect(built).toBe(0);
    expect(spawn.started).toEqual([]);
  });

  it("a named model that fails is told only that lane ran", async () => {
    const h = new Harness({
      buildView: async () => view([modelLane()]),
      spawn: laneRunner({ "claude-lane": nonZero("HTTP 400") }),
    });
    const { text } = await h.tool("dispatch", { task: "do it", model: "deepseek/deepseek-flash" });
    expect(text).toContain(FORCED_LANE_ADVICE);
  });
});

describe("F3 — a pass-through lane never runs in the MCP walk", () => {
  // What a daemon older than `requester=mcp` hands back: the Anthropic pass-through as a READY relay
  // rung with no command and no `unreachable` verdict.
  const passThrough = (): DispatchLane => ({ id: "anthropic", kind: "relay", position: 1, state: "ready", spec: "anthropic" });

  it("an unforced walk drops it rather than failing on it in 0 s", async () => {
    const spawn = laneRunner({ l2: ok("the relay-free lane answered") });
    const h = new Harness({ buildView: async () => view([passThrough(), cli("l2")]), spawn });
    const { text, isError } = await h.tool("dispatch", { task: "do it" });
    expect(isError).toBe(false);
    expect(text).toContain("the relay-free lane answered");
    expect(spawn.started).toEqual(["l2"]);
    expect(text).not.toMatch(/\d\. anthropic/);
  });

  it("a caller who names it reads the true reason, not 'no cliLane template configured'", async () => {
    const h = new Harness({ buildView: async () => view([passThrough()]), spawn: laneRunner({}) });
    const { text, isError } = await h.tool("dispatch", { task: "do it", lane: "anthropic" });
    expect(isError).toBe(true);
    expect(text).toContain(mcpPassThroughReason("anthropic"));
    expect(text).not.toContain("no cliLane template configured");
  });
});

describe("F6 — the quota death AGY states only in its log", () => {
  const MODEL = "claude-opus-4-6-thinking";
  const agyLane = (): DispatchLane =>
    cli("agy-claude-opus", {
      invoke: { command: "pwsh", args: ["-File", "lane-launch.ps1", "agy.exe", "-p", "{task}", "--model", MODEL] },
    });
  // The two line shapes are real, from `~/.gemini/antigravity-cli/cli.log` on 2026-09-10.
  const agyLog = (model: string): AgyLogSnapshot => ({
    text: [
      `I0910 09:10:21.857489       1 printmode.go:174] Print mode: starting (promptLength=33, model="${model}", conversationID="")`,
      "I0910 09:10:28.792707     310 run.go:387] Run: attempt 1 failed (RESOURCE_EXHAUSTED (code 429): Individual quota " +
        "reached. Please upgrade your subscription to increase your limits. Resets in 144h10m26s.), retrying in 4s",
    ].join("\n"),
    mtimeMs: 2_000,
  });

  it("a lane the walk STOPPED reports the death its log states, with AGY's own reset", async () => {
    const reports: DispatchedQuotaReport[] = [];
    const h = new Harness({
      buildView: async () => view([agyLane(), cli("l2")]),
      spawn: laneRunner({ l2: ok("the fallback answered") }),
      // A clock that moves, so the AGY lane goes idle and the walk stops it; it stays below the
      // log's mtime, so the log still counts as written after the lane started.
      now: (() => {
        let t = 1_000;
        return () => (t += 10);
      })(),
      readAgyLog: () => agyLog(MODEL),
      reportExhaustion: (r) => {
        reports.push(r);
      },
    });
    const { text } = await h.tool("dispatch", { task: "do it" });
    expect(text).toContain("the fallback answered");
    await until(() => reports.length > 0);
    expect(reports).toEqual([
      { laneId: "agy-claude-opus", tier: "medium", outcome: "quota_exhausted", retryAfterMs: (144 * 3600 + 10 * 60 + 26) * 1000 },
    ]);
  });

  it("an AGY lane that ANSWERED reports nothing, whatever the log holds", async () => {
    const reports: DispatchedQuotaReport[] = [];
    const h = new Harness({
      buildView: async () => view([agyLane()]),
      spawn: laneRunner({ pwsh: ok("a real answer") }),
      now: () => 1_000,
      readAgyLog: () => agyLog(MODEL),
      reportExhaustion: (r) => {
        reports.push(r);
      },
    });
    const { text } = await h.tool("dispatch", { task: "do it" });
    expect(text).toContain("a real answer");
    expect(reports).toEqual([]);
  });

  it("a log whose run header names another model reports nothing — the log is shared by every AGY run", async () => {
    const reports: DispatchedQuotaReport[] = [];
    const h = new Harness({
      buildView: async () => view([agyLane()]),
      spawn: laneRunner({ pwsh: nonZero("exit 1") }),
      now: () => 1_000,
      readAgyLog: () => agyLog("gemini-3.8-flash-medium"),
      reportExhaustion: (r) => {
        reports.push(r);
      },
    });
    await h.tool("dispatch", { task: "do it" });
    expect(reports).toEqual([]);
  });

  it("a lane that is not AGY never reads the log", async () => {
    let reads = 0;
    const h = new Harness({
      buildView: async () => view([cli("l1")]),
      spawn: laneRunner({ l1: nonZero("no") }),
      readAgyLog: () => {
        reads += 1;
        return agyLog(MODEL);
      },
    });
    await h.tool("dispatch", { task: "do it" });
    expect(reads).toBe(0);
  });
});

describe("F8 — a poll says how long the lane usually takes", () => {
  it("dispatch_status names the running lane's usual time to answer", async () => {
    const h = new Harness({
      buildView: async () => view([cli("l1", { timeToAnswer: { medianMs: 45_000, p80Ms: 90_000, samples: 12, mode: "agent" } })]),
      spawn: laneRunner({}),
    });
    const first = await h.tool("dispatch", { task: "do it", waitMs: 20 });
    const jobId = /jobId "(job-\d+)"/.exec(first.text)?.[1];
    expect(jobId, first.text).toBeDefined();
    const status = await h.tool("dispatch_status", { jobId });
    expect(status.text).toContain("usually answers in: median 45s, p80 90s (12 runs on record, agent mode)");
    await h.tool("dispatch_cancel", { jobId });
  });
});

describe("F9 — a process older than the installed package says so", () => {
  it("every reply carries the notice when the installed version differs", async () => {
    const h = new Harness({ version: "0.80.0", installedVersion: () => "0.81.0" });
    const { text } = await h.tool("dispatch", { task: "do it" });
    expect(text).toContain("answer");
    expect(text).toContain("runs v0.80.0, but v0.81.0 is installed");
    const lanes = await h.tool("dispatch_lanes", {});
    expect(lanes.text).toContain("but v0.81.0 is installed");
  });

  it("no notice when the versions match, or when the installed one cannot be read", async () => {
    const readers: Array<() => string | null> = [
      () => "0.80.0",
      () => null,
      () => {
        throw new Error("unreadable");
      },
    ];
    for (const installedVersion of readers) {
      const h = new Harness({ version: "0.80.0", installedVersion });
      const { text } = await h.tool("dispatch", { task: "do it" });
      expect(text).not.toContain("is installed");
    }
  });
});

describe("dispatch_lanes shows each lane's own evidence", () => {
  it("renders the time to answer, the failure streak, and an ad-hoc origin", async () => {
    const h = new Harness({
      buildView: async () =>
        view([
          cli("l1", { timeToAnswer: { medianMs: 45_000, p80Ms: 90_000, samples: 12, mode: "agent" } }),
          cli("l2", {
            recentFailures: 7,
            failing: { streak: 7, reason: "7 own failures in a row; ordered behind the other lanes until it answers again" },
          }),
          cli("l3", { recentFailures: 1 }),
          { ...cli("model:deepseek/deepseek-flash"), kind: "relay", spec: "deepseek/deepseek-flash", adHoc: true },
        ]),
    });
    const { text } = await h.tool("dispatch_lanes", {});
    expect(text).toContain("usually answers in: median 45s, p80 90s (12 runs on record, agent mode)");
    expect(text).toContain("failing: 7 own failures in a row");
    expect(text).toContain("1 own failure in a row");
    expect(text).toContain("(named by model, not a ladder rung)");
  });
});

describe("a running job's status says so when no time to answer is on record (F8)", () => {
  it("states 'not known' rather than saying nothing", async () => {
    const h = new Harness({ buildView: async () => view([cli("l1")]), spawn: laneRunner({}) });
    const first = await h.tool("dispatch", { task: "do it", waitMs: 20 });
    const jobId = /jobId "(job-\d+)"/.exec(first.text)?.[1];
    expect(jobId, first.text).toBeDefined();
    const status = await h.tool("dispatch_status", { jobId });
    expect(status.text).toContain("usually answers in: not known (no completed run on record for this lane)");
    await h.tool("dispatch_cancel", { jobId });
  });
});

describe("the walk hands the reaper the pids its lane started (2026-09-10)", () => {
  it("a process still alive after the job ends is named by pid", async () => {
    // ⚠ `startLane` returned `{ result, kill }` alone until 2026-09-10 and dropped the spawn
    // handle's `pids`, so the v0.80.0 reaper had no pid to check and its "STILL RUNNING" report could
    // never fire for a lane a walk started. This test process's own pid stands in for a survivor: it
    // is certainly alive, and the reaper only calls the handle's `kill` — a no-op here — and then asks
    // whether each pid still exists.
    const spawn: LaneSpawner = () => ({ result: Promise.resolve(ok("done")), kill: () => {}, pids: () => [process.pid] });
    const h = new Harness({ buildView: async () => view([cli("l1")]), spawn });
    const { text } = await h.tool("dispatch", { task: "do it" });
    expect(text).toContain("done");
    expect(text).toContain("owned processes STILL RUNNING after job-");
    expect(text).toContain(String(process.pid));
  });
});
