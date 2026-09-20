/**
 * Two hosts, two `llm-relay mcp` processes, one set of job files.
 *
 * Claude Desktop and Codex Desktop each start their own server (measured 2026-09-17: three live
 * `llm-relay mcp` processes under two hosts). Before this file, the second process to start read the
 * first one's LIVE jobs as orphans and reported them killed, each process's writes erased the other's
 * journal and archive rows, both processes minted the same `job-NNNN`, and a job the other process
 * finished stayed `unknown jobId` (observed 2026-09-16). A second process is simulated here by a
 * second journal with another pid; `isAlive` decides whether that pid still runs.
 *
 * Also: a terminal `dispatch_status` carries the answer (2026-09-16: one caller polled a finished
 * job 2,023 times over 71 minutes and never called `dispatch_result`).
 */
import { describe, expect, it, vi } from "vitest";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createJobIdFactory, LaneJobStore } from "../src/mcp/lane-runner.js";
import { createJobJournal } from "../src/mcp/job-journal.js";
import { createJobArchive } from "../src/mcp/job-archive.js";
import { McpDispatchServer, taskLabel, type DispatchViewBuilder } from "../src/mcp/server.js";
import type { Config } from "../src/config.js";
import type { DispatchLane, DispatchView } from "../src/dispatch.js";

const OTHER_PID = 999_999_001;

function tempDir(): { dir: string; cleanup: () => void } {
  const dir = mkdtempSync(join(tmpdir(), "llm-relay-mcp-multi-"));
  return { dir, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

/** Two stores over the same files: `mine` is this process, `other` a live (or dead) second process. */
function twoHosts(dir: string, otherAlive: () => boolean) {
  const journalPath = join(dir, "mcp-jobs.json");
  const archivePath = join(dir, "mcp-job-archive.json");
  const other = new LaneJobStore(
    createJobJournal(journalPath, { pid: OTHER_PID, isAlive: (pid) => pid === process.pid }),
    createJobArchive(archivePath),
  );
  const mine = (): LaneJobStore =>
    new LaneJobStore(
      createJobJournal(journalPath, { isAlive: (pid) => (pid === OTHER_PID ? otherAlive() : true) }),
      createJobArchive(archivePath),
    );
  return { other, mine, journalPath, archivePath };
}

const ok = (stdout: string) => ({ code: 0, stdout, stderr: "", timedOut: false });

describe("two llm-relay mcp processes share the job files", () => {
  it("does NOT report another live process's running job as killed", () => {
    const { dir, cleanup } = tempDir();
    try {
      const { other, mine } = twoHosts(dir, () => true);
      const live = other.create("free-pool", "pool/high", "C:/tree");
      const second = mine();
      // ⚠ RED before the owner field: the second process adopted the live job as `killed`.
      expect(second.get(live.id)).toBeUndefined();
      expect(second.runningElsewhere(live.id)).toMatchObject({ laneId: "free-pool", pid: OTHER_PID });
    } finally {
      cleanup();
    }
  });

  it("still reports the job killed once the owning process is gone", () => {
    const { dir, cleanup } = tempDir();
    try {
      const { other, mine } = twoHosts(dir, () => false);
      const died = other.create("free-pool", "pool/high", "C:/tree");
      expect(mine().get(died.id)?.status).toBe("killed");
    } finally {
      cleanup();
    }
  });

  it("keeps the other process's journal row when this process writes", () => {
    const { dir, cleanup } = tempDir();
    try {
      const { other, mine, journalPath } = twoHosts(dir, () => true);
      const live = other.create("free-pool", "pool/high", "C:/tree");
      const second = mine();
      const own = second.create("agy", undefined, "C:/tree");
      second.complete(own.id, ok("done"));
      const rows = (JSON.parse(readFileSync(journalPath, "utf8")) as { jobs: Array<{ jobId: string }> }).jobs;
      // ⚠ RED before the merge: this process's write replaced the file with its own rows only.
      expect(rows.map((r) => r.jobId)).toEqual([live.id]);
    } finally {
      cleanup();
    }
  });

  it("finds a job the other process finished AFTER this one started, and keeps both archives", () => {
    const { dir, cleanup } = tempDir();
    try {
      const { other, mine, archivePath } = twoHosts(dir, () => true);
      const second = mine();
      const theirs = other.create("free-pool", "pool/high", "C:/tree");
      const ours = second.create("agy", undefined, "C:/tree");
      other.complete(theirs.id, ok("their answer"));
      second.complete(ours.id, ok("our answer"));

      // ⚠ RED before `find`: the archive was read once, at start, so this stayed unknown.
      const found = second.find(theirs.id);
      expect(found?.stdout).toBe("their answer");
      expect(found?.restored).toBe(true);
      // ⚠ RED before the merge: the second write erased the first process's archived job.
      const ids = (JSON.parse(readFileSync(archivePath, "utf8")) as { jobs: Array<{ id: string }> }).jobs.map((j) => j.id);
      expect(ids).toEqual(expect.arrayContaining([theirs.id, ours.id]));
    } finally {
      cleanup();
    }
  });

  it("independent process allocators cannot collide at the same local counter value", () => {
    const { dir, cleanup } = tempDir();
    try {
      const journalPath = join(dir, "mcp-jobs.json");
      const archivePath = join(dir, "mcp-job-archive.json");
      const first = new LaneJobStore(
        createJobJournal(journalPath, { pid: OTHER_PID, isAlive: () => true }),
        createJobArchive(archivePath),
        createJobIdFactory(new Uint8Array(16).fill(1)),
      );
      const second = new LaneJobStore(
        createJobJournal(journalPath, { isAlive: (pid) => pid === OTHER_PID }),
        createJobArchive(archivePath),
        createJobIdFactory(new Uint8Array(16).fill(2)),
      );

      // Both factories are at local counter 1. The old read-max/increment design could collide
      // here before either process published its row; process-instance entropy makes disk timing
      // irrelevant.
      const theirs = first.create("free-pool", "pool/high", "C:/tree");
      const ours = second.create("agy", undefined, "C:/tree");
      expect(theirs.id).not.toBe(ours.id);
      expect(theirs.id).toMatch(/^job-\d+$/);
      expect(ours.id).toMatch(/^job-\d+$/);
    } finally {
      cleanup();
    }
  });
});

// ---------------------------------------------------------------------------------------------
// Through the tools.

function serverOver(dir: string, isAlive: (pid: number) => boolean): { server: McpDispatchServer; out: string[] } {
  const out: string[] = [];
  const lane: DispatchLane = { id: "free-pool", kind: "relay", position: 1, state: "ready", spec: "pool/high" };
  const buildView: DispatchViewBuilder = async (): Promise<DispatchView> => ({
    tier: "high", offload: false, client: "claude", host: "bypassed", ladder: [lane], order: [lane.id], next: lane, reason: "r",
  });
  const server = new McpDispatchServer({
    config: { host: "127.0.0.1", port: 8791 } as Config,
    buildView,
    journal: createJobJournal(join(dir, "mcp-jobs.json"), { isAlive }),
    archive: createJobArchive(join(dir, "mcp-job-archive.json")),
    write: (chunk) => out.push(chunk),
  });
  return { server, out };
}

async function call(server: McpDispatchServer, out: string[], name: string, args: Record<string, unknown>) {
  out.length = 0;
  await server.ingest(JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name, arguments: args } }) + "\n");
  return JSON.parse(out[0] as string) as { result: { content: Array<{ text: string }>; isError: boolean } };
}

describe("dispatch_status and dispatch_result across hosts", () => {
  it("names a job another live process is still running instead of answering unknown jobId", async () => {
    const { dir, cleanup } = tempDir();
    try {
      const other = new LaneJobStore(
        createJobJournal(join(dir, "mcp-jobs.json"), { pid: OTHER_PID, isAlive: () => true }),
        createJobArchive(join(dir, "mcp-job-archive.json")),
      );
      const live = other.create("free-pool", "pool/high", "C:/tree");
      // The owning walk advanced after creation. A different MCP process must not keep reporting
      // the stale first rung from the original journal row.
      other.setCurrentLane(live.id, "agy", undefined);
      const { server, out } = serverOver(dir, () => true);
      for (const tool of ["dispatch_status", "dispatch_result"]) {
        const body = await call(server, out, tool, { jobId: live.id });
        const text = body.result.content[0]?.text ?? "";
        expect(body.result.isError).toBe(false);
        expect(text).toContain("lane: agy");
        expect(text).toContain("status: running");
        expect(text).toContain("activity: unavailable");
        expect(text).toContain("walk-verdict: unavailable");
        expect(text).toContain(`another llm-relay MCP server process (pid ${OTHER_PID})`);
      }
      server.shutdown();
    } finally {
      cleanup();
    }
  });

  it("a TERMINAL dispatch_status carries the answer; a running one keeps the short form", async () => {
    const { dir, cleanup } = tempDir();
    try {
      const { server, out } = serverOver(dir, () => true);
      // A job this server's own store holds — reached through the archive the server shares.
      const writer = new LaneJobStore(undefined, createJobArchive(join(dir, "mcp-job-archive.json")));
      const done = writer.create("free-pool", "pool/high", "C:/tree");
      writer.complete(done.id, ok("the final answer, in full"));

      const status = await call(server, out, "dispatch_status", { jobId: done.id });
      // ⚠ RED before the change: status returned the header only, never the answer.
      expect(status.result.content[0]?.text).toContain("the final answer, in full");
      const result = await call(server, out, "dispatch_result", { jobId: done.id });
      expect(status.result.content[0]?.text).toBe(result.result.content[0]?.text);

      const failing = writer.create("free-pool", "pool/high", "C:/tree");
      writer.fail(failing.id, "boom");
      const failedStatus = await call(server, out, "dispatch_status", { jobId: failing.id });
      expect(failedStatus.result.isError).toBe(true);
      server.shutdown();
    } finally {
      cleanup();
    }
  });

  it("dispatch_status with no jobId lists recent jobs from every process, newest first", async () => {
    const { dir, cleanup } = tempDir();
    try {
      const other = new LaneJobStore(
        createJobJournal(join(dir, "mcp-jobs.json"), { pid: OTHER_PID, isAlive: () => true }),
        createJobArchive(join(dir, "mcp-job-archive.json")),
      );
      // Both jobs start in the same millisecond, as they did on CI (v0.83.0 publish run): the job
      // number must decide the order. RED before `newestFirst` broke the tie.
      const clock = vi.spyOn(Date, "now").mockReturnValue(1_800_000_000_000);
      const finished = other.create("free-pool", "pool/high", "C:/tree", undefined, "Summarise the backlog");
      other.complete(finished.id, ok("summary"));
      const live = other.create("agy", undefined, "C:/tree", undefined, taskLabel("\n  Review the diff\nsecond line"));
      clock.mockRestore();
      const { server, out } = serverOver(dir, () => true);

      const body = await call(server, out, "dispatch_status", {});
      const text = body.result.content[0]?.text ?? "";
      expect(body.result.isError).toBe(false);
      // ⚠ RED before the listing: a missing jobId was a schema refusal.
      expect(text).toContain(`${live.id}  running`);
      expect(text).toContain("another MCP server process");
      expect(text).toContain("Review the diff");
      expect(text).not.toContain("second line");
      expect(text).toContain(`${finished.id}  completed`);
      expect(text).toContain("Summarise the backlog");
      expect(text.indexOf(live.id)).toBeLessThan(text.indexOf(finished.id));
      server.shutdown();
    } finally {
      cleanup();
    }
  });

  it("taskLabel keeps the first non-empty line and cuts it at 80 characters", () => {
    expect(taskLabel("\n\n  first  \nsecond")).toBe("first");
    const long = taskLabel("x".repeat(200));
    expect(long).toHaveLength(80);
    expect(long.endsWith("...")).toBe(true);
    expect(taskLabel("   \n  ")).toBe("");
  });
});
