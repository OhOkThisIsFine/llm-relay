/**
 * A lane killed by its own server restarting is REPORTED as killed.
 *
 * Measured 2026-09-06 (C:\Code\docs\backlog.md): `job-0051` … `job-0055` were in flight when the
 * MCP child restarted. Every handle became `unknown jobId` and the counter restarted at `job-0003`
 * — **nothing announced the restart; the first symptom was `unknown jobId` on a routine poll.**
 * Roughly ninety lane-minutes were lost and nothing said what any of the five had decided.
 *
 * ⚠ The store stays IN MEMORY on purpose (a durable store would describe processes that no longer
 * exist). It is the DEATH that must be reportable, not the job: a row written while a job runs and
 * deleted when it ends leaves exactly the killed set on disk for the next process to announce.
 */
import { describe, expect, it } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { LaneJobStore } from "../src/mcp/lane-runner.js";
import { createJobJournal, nullJobJournal } from "../src/mcp/job-journal.js";
import { McpDispatchServer } from "../src/mcp/server.js";
import type { Config } from "../src/config.js";
import type { DispatchLane, DispatchView } from "../src/dispatch.js";
import { LANE_EXECUTION_SCHEMA, type LaneExecutionSnapshot } from "../src/lane-execution-broker.js";
import type { LaneExecutionClient, LaneExecutionClientResult } from "../src/mcp/lane-execution-client.js";
import type { TreeSnapshot, TreeSnapshotReader } from "../src/mcp/tree-delta.js";

function tempJournalPath(): { path: string; cleanup: () => void } {
  const dir = mkdtempSync(join(tmpdir(), "llm-relay-mcp-journal-"));
  return { path: join(dir, "mcp-jobs.json"), cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

const snap = (entries: Record<string, string>, prefix = ""): TreeSnapshot => ({
  prefix,
  entries: new Map(Object.entries(entries)),
});

const BROKER_EXECUTION_ID = "exec-00112233445566778899aabbccddeeff";

function brokerSnapshot(
  jobId: string,
  laneId: string,
  overrides: Partial<LaneExecutionSnapshot> = {},
): LaneExecutionSnapshot {
  return {
    schema: LANE_EXECUTION_SCHEMA,
    executionId: BROKER_EXECUTION_ID,
    jobId,
    laneId,
    status: "running",
    startedAt: 1_000,
    endedAt: null,
    stdoutBytes: 0,
    stderrBytes: 0,
    lastOutputAt: null,
    ...overrides,
  };
}

function brokerClient(
  fn: (action: "status" | "cancel", executionId: string) => LaneExecutionClientResult | Promise<LaneExecutionClientResult>,
): LaneExecutionClient {
  return {
    request: async (request) => {
      if (request.action === "start") throw new Error("recovery test never starts through broker");
      return fn(request.action, request.executionId);
    },
  };
}


async function killedResult(path: string, jobId: string, treeSnapshot?: TreeSnapshotReader): Promise<string> {
  const out: Array<{ id?: number; result?: { content: Array<{ text: string }> } }> = [];
  const server = new McpDispatchServer({
    config: { host: "127.0.0.1", port: 8791, routing: { default: "x" } } as unknown as Config,
    buildView: async () => {
      throw new Error("unused in dispatch_result test");
    },
    journal: createJobJournal(path),
    ...(treeSnapshot === undefined ? {} : { treeSnapshot }),
    write: (chunk) => out.push(JSON.parse(chunk) as (typeof out)[number]),
  });
  await server.ingest(
    JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method: "tools/call",
      params: { name: "dispatch_result", arguments: { jobId } },
    }) + "\n",
  );
  return out.find((message) => message.id === 1)?.result?.content[0]?.text ?? "";
}

describe("D1 broker journal ownership", () => {
  it("atomically gives a dead-owner broker row to only one replacement MCP process", () => {
    const { path, cleanup } = tempJournalPath();
    try {
      const dead = createJobJournal(path, { pid: 1001, isAlive: () => false });
      dead.note({
        jobId: "job-broker-claim",
        laneId: "lane-a",
        cwd: "C:/tree",
        startedAt: 1,
      });
      dead.noteBrokerExecution?.("job-broker-claim", {
        kind: "daemon-v1",
        executionId: BROKER_EXECUTION_ID,
      });

      const first = createJobJournal(path, {
        pid: 2001,
        isAlive: (pid) => pid === 2002,
      });
      const second = createJobJournal(path, {
        pid: 2002,
        isAlive: (pid) => pid === 2001,
      });

      expect(first.claimBrokerOrphan?.("job-broker-claim")?.owner?.pid).toBe(2001);
      expect(second.claimBrokerOrphan?.("job-broker-claim")).toBeUndefined();
    } finally {
      cleanup();
    }
  });
});

describe("D1 broker-backed MCP restart recovery", () => {
  function serverFor(
    path: string,
    client: LaneExecutionClient | undefined,
    write: (chunk: string) => void = () => {},
  ): McpDispatchServer {
    return new McpDispatchServer({
      config: { host: "127.0.0.1", port: 8791, routing: { default: "x" } } as unknown as Config,
      buildView: async () => {
        throw new Error("unused in broker recovery test");
      },
      journal: createJobJournal(path),
      ...(client === undefined ? {} : { laneExecutionClient: client }),
      write,
    });
  }

  function seed(path: string): { jobId: string; laneId: string } {
    const journal = createJobJournal(path);
    const first = new LaneJobStore(journal);
    const job = first.create("lane-a", "pool/high", "C:/tree");
    first.noteBrokerExecution(job.id, BROKER_EXECUTION_ID);
    return { jobId: job.id, laneId: job.laneId };
  }

  it("keeps a daemon execution running across MCP restart and publishes broker liveness", async () => {
    const { path, cleanup } = tempJournalPath();
    try {
      const seeded = seed(path);
      const client = brokerClient(() => ({
        ok: true,
        execution: brokerSnapshot(seeded.jobId, seeded.laneId, {
          relayInFlight: 1,
          relayLastActivityAt: 1_500,
          cpuMs: 300,
          launchNotes: ["HOME expanded from %USERPROFILE%"],
        }),
      }));
      const out: Array<{ id?: number; result?: { content?: Array<{ text?: string }> } }> = [];
      const server = serverFor(path, client, (chunk) => out.push(JSON.parse(chunk)));

      await server.ingest(
        JSON.stringify({
          jsonrpc: "2.0",
          id: 1,
          method: "tools/call",
          params: { name: "dispatch_status", arguments: { jobId: seeded.jobId } },
        }) + "\n",
      );
      const text = out.find((message) => message.id === 1)?.result?.content?.[0]?.text ?? "";
      expect(text).toContain("status: running");
      expect(text).toContain("walk-verdict: no-idle-stop");
      expect(text).toContain("relay-in-flight");
      expect(text).toContain("process tree is owned by the relay daemon");
      expect(text).not.toContain("killed");

      // Host/MCP shutdown must not cancel/clear daemon-owned work.
      server.shutdown();
      const row = createJobJournal(path).orphans().find((candidate) => candidate.jobId === seeded.jobId);
      expect(row?.brokerExecution?.executionId).toBe(BROKER_EXECUTION_ID);
    } finally {
      cleanup();
    }
  });

  it("collects the original terminal answer from the daemon after restart", async () => {
    const { path, cleanup } = tempJournalPath();
    try {
      const seeded = seed(path);
      const client = brokerClient(() => ({
        ok: true,
        execution: brokerSnapshot(seeded.jobId, seeded.laneId, {
          status: "completed",
          endedAt: 2_000,
          code: 0,
          stdout: "answer survived the MCP restart",
          stderr: "",
          timedOut: false,
          stdoutBytes: 31,
        }),
      }));
      const out: Array<{ id?: number; result?: { content?: Array<{ text?: string }> } }> = [];
      const server = serverFor(path, client, (chunk) => out.push(JSON.parse(chunk)));
      await server.ingest(
        JSON.stringify({
          jsonrpc: "2.0",
          id: 2,
          method: "tools/call",
          params: { name: "dispatch_result", arguments: { jobId: seeded.jobId } },
        }) + "\n",
      );
      const text = out.find((message) => message.id === 2)?.result?.content?.[0]?.text ?? "";
      expect(text).toContain("answer survived the MCP restart");
      expect(text).toContain("completed");
      expect(createJobJournal(path).orphans().find((row) => row.jobId === seeded.jobId)).toBeUndefined();
    } finally {
      cleanup();
    }
  });

  it("preserves the existing content-empty failure classifier on a recovered exit-0 result", async () => {
    const { path, cleanup } = tempJournalPath();
    try {
      const seeded = seed(path);
      const client = brokerClient(() => ({
        ok: true,
        execution: brokerSnapshot(seeded.jobId, seeded.laneId, {
          status: "completed",
          endedAt: 2_000,
          code: 0,
          stdout: "#",
          stderr: "",
          timedOut: false,
          stdoutBytes: 1,
        }),
      }));
      const out: Array<{ id?: number; result?: { content?: Array<{ text?: string }>; isError?: boolean } }> = [];
      const server = serverFor(path, client, (chunk) => out.push(JSON.parse(chunk)));
      await server.ingest(
        JSON.stringify({
          jsonrpc: "2.0",
          id: 20,
          method: "tools/call",
          params: { name: "dispatch_result", arguments: { jobId: seeded.jobId } },
        }) + "\n",
      );
      const result = out.find((message) => message.id === 20)?.result;
      expect(result?.content?.[0]?.text).toContain("NO output");
      expect(result?.isError).toBe(true);
    } finally {
      cleanup();
    }
  });

  it("treats broker transport failure as recovery unavailable, never as death", async () => {
    const { path, cleanup } = tempJournalPath();
    try {
      const seeded = seed(path);
      const client = brokerClient(() => ({
        ok: false,
        kind: "unavailable",
        status: null,
        message: "relay restarting",
      }));
      const out: Array<{ id?: number; result?: { content?: Array<{ text?: string }> } }> = [];
      const server = serverFor(path, client, (chunk) => out.push(JSON.parse(chunk)));
      await server.ingest(
        JSON.stringify({
          jsonrpc: "2.0",
          id: 3,
          method: "tools/call",
          params: { name: "dispatch_status", arguments: { jobId: seeded.jobId } },
        }) + "\n",
      );
      const text = out.find((message) => message.id === 3)?.result?.content?.[0]?.text ?? "";
      expect(text).toContain("status: running");
      expect(text).toContain("broker-unavailable");
      expect(text).not.toContain("status: killed");
      expect(createJobJournal(path).orphans().some((row) => row.jobId === seeded.jobId)).toBe(true);
    } finally {
      cleanup();
    }
  });

  it("only a reachable broker 404 converts the recovered execution to killed", async () => {
    const { path, cleanup } = tempJournalPath();
    try {
      const seeded = seed(path);
      const client = brokerClient(() => ({
        ok: false,
        kind: "rejected",
        status: 404,
        message: "unknown lane execution id",
      }));
      const out: Array<{ id?: number; result?: { content?: Array<{ text?: string }>; isError?: boolean } }> = [];
      const server = serverFor(path, client, (chunk) => out.push(JSON.parse(chunk)));
      await server.ingest(
        JSON.stringify({
          jsonrpc: "2.0",
          id: 4,
          method: "tools/call",
          params: { name: "dispatch_status", arguments: { jobId: seeded.jobId } },
        }) + "\n",
      );
      const result = out.find((message) => message.id === 4)?.result;
      expect(result?.content?.[0]?.text).toContain("killed");
      expect(result?.content?.[0]?.text).toContain("could no longer be recovered");
      expect(result?.content?.[0]?.text).not.toContain("process is gone");
      expect(result?.isError).toBe(true);
    } finally {
      cleanup();
    }
  });

  it("routes explicit cancellation to the daemon owner after restart", async () => {
    const { path, cleanup } = tempJournalPath();
    try {
      const seeded = seed(path);
      const actions: string[] = [];
      const client = brokerClient((action) => {
        actions.push(action);
        return {
          ok: true,
          execution: brokerSnapshot(seeded.jobId, seeded.laneId, action === "cancel"
            ? {
                status: "cancelled",
                endedAt: 2_500,
              }
            : {}),
        };
      });
      const out: Array<{ id?: number; result?: { content?: Array<{ text?: string }> } }> = [];
      const server = serverFor(path, client, (chunk) => out.push(JSON.parse(chunk)));
      await server.ingest(
        JSON.stringify({
          jsonrpc: "2.0",
          id: 5,
          method: "tools/call",
          params: { name: "dispatch_cancel", arguments: { jobId: seeded.jobId } },
        }) + "\n",
      );
      expect(out.find((message) => message.id === 5)?.result?.content?.[0]?.text).toContain("cancelled");
      // Cancellation is the first broker operation after orphan claiming: no status/liveness probe
      // may delay it with process-CPU or git IO.
      expect(actions).toEqual(["cancel"]);
    } finally {
      cleanup();
    }
  });

  it("waits for broker recovery before evaluating maxConcurrent on a fresh dispatch", async () => {
    const { path, cleanup } = tempJournalPath();
    try {
      const seeded = seed(path);
      let releaseRecovery!: () => void;
      let recoveryReleased = false;
      const actions: string[] = [];
      const client: LaneExecutionClient = {
        request: async (request) => {
          actions.push(request.action);
          if (request.action === "start") throw new Error("fresh dispatch must be skipped at the cap");
          if (!recoveryReleased) {
            await new Promise<void>((resolve) => { releaseRecovery = resolve; });
            recoveryReleased = true;
          }
          return {
            ok: true,
            execution: brokerSnapshot(seeded.jobId, seeded.laneId),
          };
        },
      };
      const lane: DispatchLane = {
        id: seeded.laneId,
        kind: "cli",
        position: 1,
        state: "ready",
        invoke: { command: "codex", args: ["exec", "{task}"] },
        maxConcurrent: 1,
      };
      const dispatchView: DispatchView = {
        tier: "medium",
        offload: false,
        client: "claude",
        host: "bypassed",
        ladder: [lane],
        order: [lane.id],
        next: lane,
        reason: "test",
        source: "daemon",
      };
      const out: Array<{ id?: number; result?: { content?: Array<{ text?: string }>; isError?: boolean } }> = [];
      const server = new McpDispatchServer({
        config: {
          host: "127.0.0.1",
          port: 8791,
          routing: { default: "x", dispatchWalk: { enabled: true, idleMs: 300_000, maxLanes: 4 } },
        } as unknown as Config,
        buildView: async () => dispatchView,
        journal: createJobJournal(path),
        laneExecutionClient: client,
        write: (chunk) => out.push(JSON.parse(chunk)),
      });

      const pending = server.ingest(
        JSON.stringify({
          jsonrpc: "2.0",
          id: 60,
          method: "tools/call",
          params: { name: "dispatch", arguments: { task: "new work" } },
        }) + "\n",
      );
      await new Promise((resolve) => setTimeout(resolve, 20));
      expect(out.find((message) => message.id === 60)).toBeUndefined();

      releaseRecovery();
      await pending;
      const result = out.find((message) => message.id === 60)?.result;
      expect(result?.content?.[0]?.text).toContain("maxConcurrent");
      expect(result?.isError).toBe(true);
      expect(actions).not.toContain("start");
    } finally {
      cleanup();
    }
  });

  it("does not block MCP initialize while a broker recovery query is still pending", async () => {
    const { path, cleanup } = tempJournalPath();
    try {
      seed(path);
      const client: LaneExecutionClient = {
        request: () => new Promise<LaneExecutionClientResult>(() => {}),
      };
      const out: Array<{ id?: number; result?: unknown }> = [];
      const server = serverFor(path, client, (chunk) => out.push(JSON.parse(chunk)));

      await Promise.race([
        server.ingest(JSON.stringify({ jsonrpc: "2.0", id: 6, method: "initialize", params: {} }) + "\n"),
        new Promise<never>((_, reject) =>
          setTimeout(() => reject(new Error("initialize waited on broker recovery")), 250),
        ),
      ]);
      expect(out.some((message) => message.id === 6 && message.result !== undefined)).toBe(true);
    } finally {
      cleanup();
    }
  });
});

describe("MCP server restart", () => {
  it("reports the jobs a previous process died holding, rather than unknown jobId", () => {
    const { path, cleanup } = tempJournalPath();
    try {
      // Process 1: two jobs start, one finishes.
      const first = new LaneJobStore(createJobJournal(path));
      const survived = first.create("lane-a", "pool/high", "C:/tree");
      const finished = first.create("lane-b", "agy", "C:/tree");
      first.complete(finished.id, { code: 0, stdout: "ok", stderr: "", timedOut: false });

      // Process 2: same journal, new in-memory store — the restart.
      const second = new LaneJobStore(createJobJournal(path));
      const killed = second.get(survived.id);

      // ⚠ RED on HEAD: the second store knew nothing, so `dispatch_status` answered
      // `unknown jobId: job-0001` for a job that HAD been running. Closing the loop matters as
      // much as the status name: the report is useless if a poll cannot reach it.
      expect(killed).toBeDefined();
      expect(killed?.status).toBe("killed");
      expect(killed?.laneId).toBe("lane-a");
      expect(killed?.error).toMatch(/restart/i);
      // The job that finished is NOT reported as killed.
      expect(second.get(finished.id)).toBeUndefined();
    } finally {
      cleanup();
    }
  });

  it("does not block MCP initialization on killed-job tree recovery", async () => {
    const { path, cleanup } = tempJournalPath();
    try {
      const first = new LaneJobStore(createJobJournal(path));
      const job = first.create("lane-a", "pool/high", "C:/tree");
      first.noteStartingTree(job.id, snap({ "pre.ts": " M" }), undefined);

      let finishTreeRead!: (value: TreeSnapshot | null) => void;
      const treeSnapshot: TreeSnapshotReader = () =>
        new Promise<TreeSnapshot | null>((resolve) => {
          finishTreeRead = resolve;
        });
      const out: Array<{ id?: number; result?: unknown }> = [];
      const server = new McpDispatchServer({
        config: { host: "127.0.0.1", port: 8791, routing: { default: "x" } } as unknown as Config,
        buildView: async () => {
          throw new Error("unused in initialize test");
        },
        journal: createJobJournal(path),
        treeSnapshot,
        write: (chunk) => out.push(JSON.parse(chunk) as (typeof out)[number]),
      });

      const initialize = server.ingest(
        JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: {} }) + "\n",
      );
      await Promise.race([
        initialize,
        new Promise<never>((_, reject) =>
          setTimeout(() => reject(new Error("initialize waited on killed-job tree recovery")), 250),
        ),
      ]);
      expect(out.some((message) => message.id === 1 && message.result !== undefined)).toBe(true);

      // Let the background enrichment finish before cleaning up the fixture.
      finishTreeRead(snap({ "pre.ts": " M", "new.ts": "??" }));
      await server.ingest(
        JSON.stringify({
          jsonrpc: "2.0",
          id: 2,
          method: "tools/call",
          params: { name: "dispatch_result", arguments: { jobId: job.id } },
        }) + "\n",
      );
    } finally {
      cleanup();
    }
  });

  it("renders a recovered tree delta for a job killed by the restart", async () => {
    const { path, cleanup } = tempJournalPath();
    try {
      const first = new LaneJobStore(createJobJournal(path));
      const job = first.create("lane-a", "pool/high", "C:/tree");
      first.noteStartingTree(job.id, snap({ "pre.ts": " M" }), ["src"]);

      const text = await killedResult(
        path,
        job.id,
        async () => snap({ "pre.ts": " M", "src/new.ts": "??", "README.md": " M" }),
      );

      expect(text).toContain("killed");
      expect(text).toContain("+ src/new.ts [??]");
      expect(text).toContain("+ README.md [ M]  OUT OF SCOPE");
      expect(text).toMatch(/measured at restart adoption time, not at the time the job was killed/);
    } finally {
      cleanup();
    }
  });

  it("adds no tree delta when a killed job has no journaled starting snapshot", async () => {
    const { path, cleanup } = tempJournalPath();
    try {
      const first = new LaneJobStore(createJobJournal(path));
      const job = first.create("lane-a", "pool/high", "C:/tree");
      const text = await killedResult(path, job.id, async () => snap({ "new.ts": "??" }));
      expect(text).toContain("killed");
      expect(text).not.toContain("tree delta");
    } finally {
      cleanup();
    }
  });

  it("stores no truncated starting snapshot when the starting tree exceeds the bound", () => {
    const { path, cleanup } = tempJournalPath();
    try {
      const first = new LaneJobStore(createJobJournal(path));
      const job = first.create("lane-a", "pool/high", "C:/tree");
      const entries: Record<string, string> = {};
      for (let i = 0; i < 501; i += 1) entries[`path-${i}.ts`] = " M";
      first.noteStartingTree(job.id, snap(entries), undefined);

      const row = createJobJournal(path).orphans().find((candidate) => candidate.jobId === job.id);
      expect(row).toBeDefined();
      expect(row?.startingTree).toBeUndefined();
    } finally {
      cleanup();
    }
  });

  it("preserves the starting snapshot when a running walk repoints the journal row", () => {
    const { path, cleanup } = tempJournalPath();
    try {
      const first = new LaneJobStore(createJobJournal(path));
      const job = first.create("lane-a", "pool/high", "C:/tree");
      first.noteStartingTree(job.id, snap({ "pre.ts": " M" }), ["src"]);
      first.setCurrentLane(job.id, "lane-b", "pool/medium");

      const row = createJobJournal(path).orphans().find((candidate) => candidate.jobId === job.id);
      expect(row?.laneId).toBe("lane-b");
      expect(row?.startingTree).toEqual({
        prefix: "",
        entries: [["pre.ts", " M"]],
        scope: ["src"],
      });
    } finally {
      cleanup();
    }
  });

  it("clears the previous attempt's broker execution when a running walk repoints the row", () => {
    const { path, cleanup } = tempJournalPath();
    try {
      const journal = createJobJournal(path);
      journal.note({
        jobId: "job-broker-reference",
        laneId: "lane-a",
        spec: "pool/high",
        cwd: "C:/tree",
        startedAt: 1,
      });
      journal.noteBrokerExecution?.("job-broker-reference", {
        kind: "daemon-v1",
        executionId: "exec-00112233445566778899aabbccddeeff",
      });
      // The execution belongs to lane A's ATTEMPT. A lane transition must clear it so a crash
      // before lane B starts cannot attach lane A's terminal process/result to lane B.
      journal.note({
        jobId: "job-broker-reference",
        laneId: "lane-b",
        spec: "pool/medium",
        cwd: "C:/tree",
        startedAt: 1,
      });

      const row = createJobJournal(path).orphans().find(
        (candidate) => candidate.jobId === "job-broker-reference",
      );
      expect(row?.laneId).toBe("lane-b");
      expect(row?.brokerExecution).toBeUndefined();
    } finally {
      cleanup();
    }
  });

  it("leaves a killed job terminal and never reaps a process it does not own", () => {
    const { path, cleanup } = tempJournalPath();
    try {
      const first = new LaneJobStore(createJobJournal(path));
      const job = first.create("lane-a", "pool/high", "C:/tree");
      const second = new LaneJobStore(createJobJournal(path));
      const killed = second.get(job.id);

      expect(killed?.endedAt).toBeTypeOf("number");
      // A restart reports a death; it does not terminate anything. The new process holds no handle
      // for those pids, and `ownedProcesses` says so rather than claiming a termination it did not
      // perform.
      expect(second.cancel(job.id)).toBe(false);
      expect(second.ownedProcesses().find((r) => r.jobId === job.id)?.terminated).toBe(false);
    } finally {
      cleanup();
    }
  });

  it("shows the killed jobs in the listing, so a caller learns WHICH jobs died", () => {
    const { path, cleanup } = tempJournalPath();
    try {
      const first = new LaneJobStore(createJobJournal(path));
      const a = first.create("lane-a", "pool/high", "C:/tree");
      const b = first.create("lane-b", "agy", "C:/tree");

      const second = new LaneJobStore(createJobJournal(path));
      const killedIds = second
        .list()
        .filter((j) => j.status === "killed")
        .map((j) => j.id)
        .sort();
      const killedLanes = second
        .list()
        .filter((j) => j.status === "killed")
        .map((j) => j.laneId)
        .sort();

      // Compared against the ids the FIRST process minted, not against literals: the job counter is
      // process-global and monotonic, so "job-0001" is not a property of a fresh store.
      expect(killedIds).toEqual([a.id, b.id].sort());
      expect(killedLanes).toEqual(["lane-a", "lane-b"]);
    } finally {
      cleanup();
    }
  });

  it("reports nothing when the process before it ended its jobs cleanly", () => {
    const { path, cleanup } = tempJournalPath();
    try {
      const first = new LaneJobStore(createJobJournal(path));
      const a = first.create("lane-a", "pool/high", "C:/tree");
      first.complete(a.id, { code: 0, stdout: "ok", stderr: "", timedOut: false });
      const b = first.create("lane-b", "pool/high", "C:/tree");
      first.fail(b.id, "boom");
      const c = first.create("lane-c", "pool/high", "C:/tree");
      first.cancel(c.id);

      const second = new LaneJobStore(createJobJournal(path));
      expect(second.list().filter((j) => j.status === "killed")).toHaveLength(0);
    } finally {
      cleanup();
    }
  });

  it("invents no deaths from a corrupt journal", () => {
    const { path, cleanup } = tempJournalPath();
    try {
      // Raw text, never `JSON.stringify`: a fixture built by the same writer under test tests itself.
      writeFileSync(path, "{ this is not json");
      expect(createJobJournal(path).orphans()).toEqual([]);
      expect(new LaneJobStore(createJobJournal(path)).list()).toHaveLength(0);

      // A well-formed file of the WRONG shape — the `lane-manifest.ts` regression, where shallow
      // validation let a malformed entry evict a healthy lane. A test asserting only "does not
      // throw" passes on that bug, so assert the count.
      writeFileSync(path, JSON.stringify({ version: 1, jobs: [{ jobId: "x" }] }));
      expect(createJobJournal(path).orphans()).toEqual([]);

      // A malformed OPTIONAL starting tree drops only that field; the valid death row survives.
      writeFileSync(
        path,
        JSON.stringify({
          version: 1,
          jobs: [{
            jobId: "job-valid",
            laneId: "lane-a",
            cwd: "C:/tree",
            startedAt: 1,
            startingTree: { prefix: 42, entries: [["a.ts", " M"]] },
          }],
        }),
      );
      const malformedTree = createJobJournal(path).orphans();
      expect(malformedTree).toHaveLength(1);
      expect(malformedTree[0]?.jobId).toBe("job-valid");
      expect(malformedTree[0]?.startingTree).toBeUndefined();

      // Malformed OPTIONAL broker metadata also drops only that field. The underlying job row
      // survives so the pre-D1 killed-job path remains available as the weaker fallback.
      writeFileSync(
        path,
        JSON.stringify({
          version: 1,
          jobs: [{
            jobId: "job-valid-broker",
            laneId: "lane-a",
            cwd: "C:/tree",
            startedAt: 1,
            brokerExecution: { kind: "daemon-v1", executionId: "not-a-valid-execution-id" },
          }],
        }),
      );
      const malformedBroker = createJobJournal(path).orphans();
      expect(malformedBroker).toHaveLength(1);
      expect(malformedBroker[0]?.jobId).toBe("job-valid-broker");
      expect(malformedBroker[0]?.brokerExecution).toBeUndefined();

      // And a version this build does not know.
      writeFileSync(path, JSON.stringify({ version: 99, jobs: [{ jobId: "x", laneId: "y", cwd: "z", startedAt: 1 }] }));
      expect(createJobJournal(path).orphans()).toEqual([]);
    } finally {
      cleanup();
    }
  });

  it("records nothing at all with the null journal — the default under vitest", () => {
    const store = new LaneJobStore(nullJobJournal);
    store.create("lane-a", "pool/high", "C:/tree");
    expect(new LaneJobStore(nullJobJournal).list()).toHaveLength(0);
  });
});
