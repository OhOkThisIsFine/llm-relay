/**
 * Lane process lifecycle — OWNERSHIP, not age.
 *
 * Two measured defects, one mechanism:
 *
 * - A timed-out dispatch left the processes it started alive (2026-09-09: three
 *   `opencode-muse-spark` jobs reported `timed_out` at 1,800 s while Windows process inspection
 *   later found the original processes still running in their exact assigned worktrees).
 * - Nothing reaped a lane process after its dispatch ENDED (2026-09-06: four more `opencode`
 *   processes from finished runs still resident, ~530 MB, one holding 347 s of processor time —
 *   burning CPU hours after its job had returned, because nothing short of a process enumeration
 *   finds them).
 *
 * ⚠ The distinguishing fact is OWNERSHIP, never age: a long-running lane looks exactly like a
 * stale one from the outside, and one legitimately ran 29 minutes. So these tests assert that the
 * dispatcher terminates what IT started, and that what it started can be enumerated by job id
 * without a manual process listing.
 */
import { describe, expect, it } from "vitest";
import { LaneJobStore, type LaneSpawnHandle } from "../src/mcp/lane-runner.js";

/** A spawn handle that records every termination attempt, standing in for a real child. */
function ownedHandle(pids: number[]): LaneSpawnHandle & { terminations: () => number } {
  let terminations = 0;
  return {
    result: new Promise(() => {}),
    kill: () => {
      terminations += 1;
    },
    pids: () => pids,
    terminations: () => terminations,
  };
}

describe("lane process lifecycle", () => {
  it("terminates the tree it started when a job TIMES OUT, before reporting terminal state", () => {
    const store = new LaneJobStore();
    const job = store.create("lane-a", "pool/medium", "C:/w");
    const handle = ownedHandle([4242]);
    store.registerProcess(job.id, handle);

    store.complete(job.id, { code: null, stdout: "", stderr: "", timedOut: true });

    expect(store.get(job.id)?.status).toBe("timed_out");
    // ⚠ RED on HEAD: `complete()` dropped the kill handle without ever calling it, so the lane's
    // process tree outlived the job that reported `timed_out` — the measured survival.
    expect(handle.terminations()).toBe(1);
  });

  it("terminates the tree it started when a job FAILS", () => {
    const store = new LaneJobStore();
    const job = store.create("lane-a", "pool/medium", "C:/w");
    const handle = ownedHandle([4243]);
    store.registerProcess(job.id, handle);

    store.complete(job.id, { code: 1, stdout: "", stderr: "boom", timedOut: false });

    expect(store.get(job.id)?.status).toBe("failed");
    expect(handle.terminations()).toBe(1);
  });

  it("keeps terminating on CANCELLED — the one path that already reaped", () => {
    const store = new LaneJobStore();
    const job = store.create("lane-a", "pool/medium", "C:/w");
    const handle = ownedHandle([4244]);
    store.registerProcess(job.id, handle);

    expect(store.cancel(job.id)).toBe(true);

    expect(handle.terminations()).toBe(1);
  });

  it("reports every process it started, keyed by job id, for jobs that are terminal", () => {
    const store = new LaneJobStore();
    const running = store.create("lane-a", "pool/medium", "C:/w");
    store.registerProcess(running.id, ownedHandle([5001]));
    const done = store.create("lane-b", "pool/high", "C:/w");
    store.registerProcess(done.id, ownedHandle([5002, 5003]));
    store.complete(done.id, { code: 0, stdout: "ok", stderr: "", timedOut: false });

    const rows = store.ownedProcesses();

    // ⚠ RED on HEAD: the store kept no ownership record at all, so a stale lane could only be
    // found by enumerating every process on the machine by hand.
    expect(rows.map((r) => r.jobId)).not.toContain(running.id);
    expect(rows.find((r) => r.jobId === done.id)).toMatchObject({
      laneId: "lane-b",
      pids: [5002, 5003],
      terminated: true,
    });
  });

  it("names a survivor rather than claiming termination that did not happen", () => {
    const store = new LaneJobStore();
    const job = store.create("lane-a", "pool/medium", "C:/w");
    const handle = ownedHandle([6001]);
    store.registerProcess(job.id, handle);
    // The seam stands in for "the OS still has this pid" — a taskkill that did not take.
    store.isAlive = () => true;

    store.complete(job.id, { code: null, stdout: "", stderr: "", timedOut: true });

    const row = store.ownedProcesses().find((r) => r.jobId === job.id);
    expect(row?.survivors).toEqual([6001]);
  });
});
