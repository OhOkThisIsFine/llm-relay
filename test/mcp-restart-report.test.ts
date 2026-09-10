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

function tempJournalPath(): { path: string; cleanup: () => void } {
  const dir = mkdtempSync(join(tmpdir(), "llm-relay-mcp-journal-"));
  return { path: join(dir, "mcp-jobs.json"), cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

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
