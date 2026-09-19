/**
 * A finished job's report survives an MCP server restart, and job ids never restart.
 *
 * Measured 2026-09-11, re-hit 2026-09-15 (C:\Code\docs\backlog.md): llm-relay was restarted
 * between sessions; `dispatch_status`/`dispatch_result` then answered `unknown jobId` for
 * `job-0140` and `job-0143`, whose lanes had finished their tree work but whose FINAL reports
 * existed only in memory. Both lanes were re-run to recover what the lost reports held. And every
 * restart renumbered from `job-0001`, so an old handle named a new job.
 *
 * ⚠ The running-job journal (`job-journal.ts`) deliberately did not cover this: it holds a row only
 * while a job RUNS. The archive is its sibling for the terminal half.
 */
import { describe, expect, it } from "vitest";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createJobIdFactory, LaneJobStore } from "../src/mcp/lane-runner.js";
import { createJobJournal } from "../src/mcp/job-journal.js";
import {
  MAX_ARCHIVED_JOBS,
  MAX_ARCHIVED_OUTPUT_CHARS,
  createJobArchive,
  isArchivedJob,
  jobArchivePath,
  jobSeqOf,
  nullJobArchive,
} from "../src/mcp/job-archive.js";
import { McpDispatchServer, type DispatchViewBuilder } from "../src/mcp/server.js";
import type { Config } from "../src/config.js";
import type { DispatchLane, DispatchView } from "../src/dispatch.js";

function tempDir(): { dir: string; cleanup: () => void } {
  const dir = mkdtempSync(join(tmpdir(), "llm-relay-mcp-archive-"));
  return { dir, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

describe("finished-job archive across a restart", () => {
  it("answers for a job that FINISHED before the restart, with its report — never unknown jobId", () => {
    const { dir, cleanup } = tempDir();
    try {
      const path = join(dir, "mcp-job-archive.json");
      const first = new LaneJobStore(undefined, createJobArchive(path));
      const done = first.create("free-pool", "pool/high", "C:/tree");
      first.recordAttempt(done.id, { laneId: "free-pool", spec: "pool/high", status: "completed", elapsedMs: 145_000 });
      first.complete(done.id, { code: 0, stdout: "the review: two findings", stderr: "", timedOut: false });
      const failed = first.create("agy", "agy-gemini", "C:/tree");
      first.fail(failed.id, "boom");

      // The restart: a new process, a new store, the same file. No flush was called — the case
      // that matters is a process killed with no handler, so the terminal write must be eager.
      const second = new LaneJobStore(undefined, createJobArchive(path));
      const restored = second.get(done.id);
      // ⚠ RED on HEAD: `unknown jobId` for a job whose lane had finished and reported.
      expect(restored).toBeDefined();
      expect(restored?.status).toBe("completed");
      expect(restored?.stdout).toBe("the review: two findings");
      expect(restored?.attempts).toEqual([{ laneId: "free-pool", spec: "pool/high", status: "completed", elapsedMs: 145_000 }]);
      expect(restored?.restored).toBe(true);
      expect(second.get(failed.id)?.status).toBe("failed");
      expect(second.get(failed.id)?.error).toBe("boom");
    } finally {
      cleanup();
    }
  });

  it("never reuses a handle across a restart, without consulting the old sequence", () => {
    const { dir, cleanup } = tempDir();
    try {
      const archivePath = join(dir, "mcp-job-archive.json");
      const journalPath = join(dir, "mcp-jobs.json");
      const firstIds = createJobIdFactory(new Uint8Array(16).fill(1));
      const secondIds = createJobIdFactory(new Uint8Array(16).fill(2));
      const first = new LaneJobStore(createJobJournal(journalPath), createJobArchive(archivePath), firstIds);
      const done = first.create("lane-a", "pool/high", "C:/tree");
      first.complete(done.id, { code: 0, stdout: "ok", stderr: "", timedOut: false });
      const stillRunning = first.create("lane-b", "agy", "C:/tree");

      // A restarted process gets a fresh 128-bit process instance. Its first local counter value is
      // the SAME as the old process's first one, yet the handles cannot collide.
      const second = new LaneJobStore(createJobJournal(journalPath), createJobArchive(archivePath), secondIds);
      const next = second.create("lane-c", "pool/low", "C:/tree");
      expect(next.id).toMatch(/^job-\d+$/);
      expect(new Set([done.id, stillRunning.id, next.id]).size).toBe(3);
      expect(second.get(done.id)?.status).toBe("completed");
      expect(second.get(stillRunning.id)?.status).toBe("killed");
      expect(second.list().map((j) => j.id)).toContain(next.id);
    } finally {
      cleanup();
    }
  });

  it("keeps legacy lastSeq readable but does not use it to allocate new ids", () => {
    const { dir, cleanup } = tempDir();
    try {
      const path = join(dir, "mcp-job-archive.json");
      writeFileSync(path, JSON.stringify({ version: 1, lastSeq: 9000, jobs: [] }));
      const ids = createJobIdFactory(new Uint8Array(16).fill(3));
      const store = new LaneJobStore(undefined, createJobArchive(path), ids);
      const id = store.create("l", undefined, "C:/w").id;
      expect(id).toMatch(/^job-\d+$/);
      expect(jobSeqOf(id)).toBeNull();
      expect(createJobArchive(path).restore().lastSeq).toBe(9000);
    } finally {
      cleanup();
    }
  });

  it("keeps a KILLED report across a SECOND restart, which the journal alone could not", () => {
    const { dir, cleanup } = tempDir();
    try {
      const archivePath = join(dir, "mcp-job-archive.json");
      const journalPath = join(dir, "mcp-jobs.json");
      const first = new LaneJobStore(createJobJournal(journalPath), createJobArchive(archivePath));
      const gone = first.create("lane-a", "pool/high", "C:/tree");

      const second = new LaneJobStore(createJobJournal(journalPath), createJobArchive(archivePath));
      expect(second.get(gone.id)?.status).toBe("killed");
      // The second process's first journal write drops the orphan row from disk...
      const own = second.create("lane-b", "pool/high", "C:/tree");
      second.complete(own.id, { code: 0, stdout: "ok", stderr: "", timedOut: false });

      // ...so on a THIRD start only the archive still knows the killed job.
      const third = new LaneJobStore(createJobJournal(journalPath), createJobArchive(archivePath));
      expect(third.get(gone.id)?.status).toBe("killed");
      expect(third.get(gone.id)?.error).toMatch(/restart/i);
    } finally {
      cleanup();
    }
  });

  it("never archives a RUNNING job — a durable record of a live process would describe a ghost", () => {
    const { dir, cleanup } = tempDir();
    try {
      const path = join(dir, "mcp-job-archive.json");
      const archive = createJobArchive(path);
      const store = new LaneJobStore(undefined, archive);
      const running = store.create("lane-a", "pool/high", "C:/tree");
      archive.record(store.get(running.id) as never);
      archive.flush();

      // With the old shared job-sequence allocator, creating a running job also dirtied the
      // archive's lastSeq field, so this file happened to exist. Opaque process-unique ids remove
      // that unrelated write: the stronger invariant is that a running job creates NO terminal
      // archive row, and the archive file may legitimately not exist until something finishes.
      expect(createJobArchive(path).restore().jobs).toEqual([]);
      // And a restart with no journal reports nothing for it — that is the journal's job.
      expect(new LaneJobStore(undefined, createJobArchive(path)).get(running.id)).toBeUndefined();
    } finally {
      cleanup();
    }
  });

  it("restores nothing from a corrupt, wrong-version or malformed file, and drops one bad row alone", () => {
    const { dir, cleanup } = tempDir();
    try {
      const path = join(dir, "mcp-job-archive.json");
      // Raw text, never `JSON.stringify` through the writer under test.
      writeFileSync(path, "{ not json");
      expect(createJobArchive(path).restore()).toEqual({ jobs: [], lastSeq: 0 });

      writeFileSync(path, JSON.stringify({ version: 99, lastSeq: 5, jobs: [] }));
      expect(createJobArchive(path).restore()).toEqual({ jobs: [], lastSeq: 0 });

      const good = {
        id: "job-0007",
        status: "completed",
        laneId: "l",
        startedAt: 1,
        endedAt: 2,
        exitCode: 0,
        stdout: "ok",
        stderr: "",
        timedOut: false,
        cwd: "C:/w",
        attempts: [],
      };
      writeFileSync(
        path,
        JSON.stringify({ version: 1, lastSeq: 7, jobs: [good, { id: "job-0008", status: "running" }, { id: "job-0009" }] }),
      );
      const { jobs, lastSeq } = createJobArchive(path).restore();
      expect(jobs.map((j) => j.id)).toEqual(["job-0007"]);
      expect(lastSeq).toBe(7);
    } finally {
      cleanup();
    }
  });

  it("bounds the archive to MAX_ARCHIVED_JOBS newest jobs and caps each stream, keeping the TAIL", () => {
    const { dir, cleanup } = tempDir();
    try {
      const path = join(dir, "mcp-job-archive.json");
      const archive = createJobArchive(path);
      const store = new LaneJobStore(undefined, archive);
      const ids: string[] = [];
      for (let i = 0; i < MAX_ARCHIVED_JOBS + 5; i++) {
        const job = store.create("l", undefined, "C:/w");
        ids.push(job.id);
        store.complete(job.id, { code: 0, stdout: `answer ${i}`, stderr: "", timedOut: false });
      }
      const huge = store.create("l", undefined, "C:/w");
      const big = "x".repeat(MAX_ARCHIVED_OUTPUT_CHARS + 10_000) + "THE-END";
      store.complete(huge.id, { code: 0, stdout: big, stderr: "", timedOut: false });

      const restored = new LaneJobStore(undefined, createJobArchive(path));
      expect(restored.list()).toHaveLength(MAX_ARCHIVED_JOBS);
      // The five OLDEST are gone; the newest, including the huge one, are kept.
      for (const old of ids.slice(0, 5)) expect(restored.get(old)).toBeUndefined();
      expect(restored.get(ids[ids.length - 1] as string)).toBeDefined();
      const kept = restored.get(huge.id)?.stdout ?? "";
      expect(kept.endsWith("THE-END")).toBe(true);
      expect(kept.startsWith("[archive: first 10007 characters cut")).toBe(true);
      expect(kept.length).toBeLessThan(big.length);
      // The in-memory record of the live process is NOT truncated — only what is persisted.
      expect(store.get(huge.id)?.stdout).toBe(big);
    } finally {
      cleanup();
    }
  });

  it("validates rows field by field", () => {
    expect(isArchivedJob({ id: "job-0001", status: "running", laneId: "l", startedAt: 1, endedAt: 2, exitCode: null, stdout: "", stderr: "", timedOut: false, cwd: "c", attempts: [] })).toBe(false);
    expect(isArchivedJob({ id: "job-0001", status: "completed", laneId: "l", startedAt: 1, endedAt: 2, exitCode: null, stdout: "", stderr: "", timedOut: false, cwd: "c", attempts: [{ laneId: 1 }] })).toBe(false);
    expect(isArchivedJob({ id: "job-0001", status: "cancelled", laneId: "l", startedAt: 1, endedAt: 2, exitCode: 1, stdout: "", stderr: "", timedOut: false, cwd: "c", attempts: [], process: { pids: [1], survivors: [], terminated: true } })).toBe(true);
  });

  it("parses only legacy safe-integer job sequences; new ids stay numeric but opaque", () => {
    expect(jobSeqOf("job-0042")).toBe(42);
    expect(jobSeqOf("job-140")).toBe(140);
    expect(jobSeqOf("job-0000")).toBeNull();
    expect(jobSeqOf("x-0001")).toBeNull();
    expect(jobSeqOf("")).toBeNull();

    const one = createJobIdFactory(new Uint8Array(16).fill(1));
    const two = createJobIdFactory(new Uint8Array(16).fill(2));
    const a1 = one();
    const a2 = one();
    const b1 = two();
    expect(a1).toMatch(/^job-\d+$/);
    expect(a2).toMatch(/^job-\d+$/);
    expect(b1).toMatch(/^job-\d+$/);
    expect(new Set([a1, a2, b1]).size).toBe(3);
    expect(a2 > a1).toBe(true);
    expect(jobSeqOf(a1)).toBeNull();
    expect(jobSeqOf(b1)).toBeNull();
  });

  it("resolves its default path under the vitest temp root, never the operator's real archive", () => {
    const path = jobArchivePath({ VITEST: "1" });
    expect(path).toContain("llm-relay-vitest");
    expect(path).toContain(`mcp-job-archive-${process.pid}.json`);
    expect(jobArchivePath({}).endsWith("mcp-job-archive.json")).toBe(true);
    expect(jobArchivePath({})).not.toContain("llm-relay-vitest");
  });
});

// ---------------------------------------------------------------------------------------------
// Through the tool: dispatch_result on a restarted server returns the archived report.

describe("dispatch_result after a restart", () => {
  it("returns the finished job's answer, marked as restored, with a non-error result", async () => {
    const { dir, cleanup } = tempDir();
    try {
      const path = join(dir, "mcp-job-archive.json");
      const first = new LaneJobStore(undefined, createJobArchive(path));
      const done = first.create("free-pool", "pool/high", process.cwd());
      first.complete(done.id, { code: 0, stdout: "two findings, both minor", stderr: "", timedOut: false });

      const out: string[] = [];
      const lane: DispatchLane = { id: "free-pool", kind: "relay", position: 1, state: "ready", spec: "pool/high" };
      const buildView: DispatchViewBuilder = async (): Promise<DispatchView> => ({
        tier: "high", offload: false, client: "claude", host: "bypassed", ladder: [lane], order: [lane.id], next: lane, reason: "r",
      });
      const server = new McpDispatchServer({
        config: { host: "127.0.0.1", port: 8791 } as Config,
        buildView,
        archive: createJobArchive(path),
        write: (chunk) => out.push(chunk),
      });
      await server.ingest(
        JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "dispatch_result", arguments: { jobId: done.id } } }) + "\n",
      );
      const body = JSON.parse(out[0] as string) as { result: { content: Array<{ text: string }>; isError: boolean } };
      expect(body.result.isError).toBe(false);
      expect(body.result.content[0]?.text).toContain("two findings, both minor");
      expect(body.result.content[0]?.text).toContain("record: restored from disk");
      expect(body.result.content[0]?.text).toContain("status: completed");
      server.shutdown();
    } finally {
      cleanup();
    }
  });
});
