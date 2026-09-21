import { spawn, type ChildProcess } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { createJobArchive, type JobArchive } from "../src/mcp/job-archive.js";
import { createJobJournal, type JobJournal } from "../src/mcp/job-journal.js";
import { LaneJobStore, type LaneJob } from "../src/mcp/lane-runner.js";
import { transactionalUpdateJsonSync } from "../src/storage/json-store.js";

const WORKER = fileURLToPath(new URL("./fixtures/mcp-persistence-worker.ts", import.meta.url));

interface Worker {
  child: ChildProcess;
  stderr: string[];
}

function tempDir(): { dir: string; cleanup: () => void } {
  const dir = mkdtempSync(join(tmpdir(), "llm-relay-mcp-persist-"));
  return { dir, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

function spawnWorker(args: string[]): Worker {
  const child = spawn(process.execPath, ["--import", "tsx", WORKER, ...args], {
    cwd: process.cwd(),
    stdio: ["ignore", "ignore", "pipe"],
  });
  const stderr: string[] = [];
  child.stderr?.setEncoding("utf8");
  child.stderr?.on("data", (chunk) => stderr.push(String(chunk)));
  return { child, stderr };
}

function workerExited(worker: Worker): boolean {
  return worker.child.exitCode !== null || worker.child.signalCode !== null;
}

function workerFailed(worker: Worker): boolean {
  return (worker.child.exitCode !== null && worker.child.exitCode !== 0) || worker.child.signalCode !== null;
}

async function waitForFiles(paths: string[], workers: Worker[], timeoutMs = 20_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (paths.every((path) => existsSync(path))) return;
    const failed = workers.find(workerFailed);
    if (failed !== undefined) throw new Error(`worker exited early: ${failed.stderr.join("")}`);
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error(`timed out waiting for worker files; stderr: ${workers.flatMap((w) => w.stderr).join("")}`);
}

async function waitForExit(worker: Worker): Promise<void> {
  if (workerExited(worker)) return;
  await new Promise<void>((resolve, reject) => {
    worker.child.once("error", reject);
    worker.child.once("exit", () => resolve());
  });
}

function stopWorkers(workers: Worker[]): void {
  for (const worker of workers) {
    if (!workerExited(worker)) worker.child.kill();
  }
}

function terminalJob(id: string, stdout: string, endedAt: number): LaneJob {
  return {
    id,
    status: "completed",
    laneId: "lane",
    spec: undefined,
    attempts: [],
    startedAt: 1,
    endedAt,
    exitCode: 0,
    stdout,
    stderr: "",
    timedOut: false,
    cwd: "C:/tree",
    error: undefined,
  };
}

describe("cross-process MCP persistence", () => {
  it("serializes a deliberately widened multi-process read/modify/write race", async () => {
    const { dir, cleanup } = tempDir();
    const workers: Worker[] = [];
    try {
      const path = join(dir, "rows.json");
      const start = join(dir, "start");
      const ids = ["a", "b", "c", "d"];
      const ready = ids.map((id) => join(dir, `ready-${id}`));
      const done = ids.map((id) => join(dir, `done-${id}`));
      for (let i = 0; i < ids.length; i += 1) {
        workers.push(spawnWorker(["transaction", path, ids[i] as string, ready[i] as string, start, done[i] as string]));
      }

      await waitForFiles(ready, workers);
      writeFileSync(start, "go");
      await waitForFiles(done, workers);
      await Promise.all(workers.map(waitForExit));

      const stored = JSON.parse(readFileSync(path, "utf8")) as { rows: string[] };
      expect(new Set(stored.rows)).toEqual(new Set(ids));
    } finally {
      stopWorkers(workers);
      cleanup();
    }
  });

  it("preserves every distinct journal and archive row from real concurrent MCP processes", async () => {
    const { dir, cleanup } = tempDir();
    const workers: Worker[] = [];
    try {
      const journalPath = join(dir, "mcp-jobs.json");
      const archivePath = join(dir, "mcp-job-archive.json");
      const start = join(dir, "start");
      const release = join(dir, "release");
      const ids = ["job-concurrent-a", "job-concurrent-b", "job-concurrent-c", "job-concurrent-d"];
      const ready = ids.map((id) => join(dir, `ready-${id}`));
      const done = ids.map((id) => join(dir, `done-${id}`));
      for (let i = 0; i < ids.length; i += 1) {
        workers.push(
          spawnWorker([
            "mcp",
            journalPath,
            archivePath,
            ids[i] as string,
            ready[i] as string,
            start,
            done[i] as string,
            release,
          ]),
        );
      }

      await waitForFiles(ready, workers);
      writeFileSync(start, "go");
      await waitForFiles(done, workers);

      const journal = JSON.parse(readFileSync(journalPath, "utf8")) as { jobs: Array<{ jobId: string }> };
      const archive = JSON.parse(readFileSync(archivePath, "utf8")) as { jobs: Array<{ id: string }> };
      expect(new Set(journal.jobs.map((row) => row.jobId))).toEqual(new Set(ids));
      expect(new Set(archive.jobs.map((row) => row.id))).toEqual(new Set(ids));

      writeFileSync(release, "done");
      await Promise.all(workers.map(waitForExit));
    } finally {
      stopWorkers(workers);
      cleanup();
    }
  });

  it("an unrelated write preserves a foreign row even when liveness says its owner is dead", () => {
    const { dir, cleanup } = tempDir();
    try {
      const path = join(dir, "mcp-jobs.json");
      createJobJournal(path, { pid: 111_111, isAlive: () => true }).note({
        jobId: "job-foreign",
        laneId: "lane-foreign",
        cwd: "C:/tree",
        startedAt: 1,
      });

      createJobJournal(path, { pid: 222_222, isAlive: () => false }).note({
        jobId: "job-local",
        laneId: "lane-local",
        cwd: "C:/tree",
        startedAt: 2,
      });

      const stored = JSON.parse(readFileSync(path, "utf8")) as {
        jobs: Array<{ jobId: string }>;
      };
      expect(new Set(stored.jobs.map((row) => row.jobId))).toEqual(
        new Set(["job-foreign", "job-local"]),
      );
    } finally {
      cleanup();
    }
  });

  it("explicit orphan acknowledgement removes the exact adopted dead row", () => {
    const { dir, cleanup } = tempDir();
    try {
      const path = join(dir, "mcp-jobs.json");
      createJobJournal(path, { pid: 111_111, isAlive: () => false }).note({
        jobId: "job-dead",
        laneId: "lane-dead",
        cwd: "C:/tree",
        startedAt: 1,
      });
      createJobJournal(path, { pid: 333_333, isAlive: () => true }).note({
        jobId: "job-live",
        laneId: "lane-live",
        cwd: "C:/tree",
        startedAt: 2,
      });

      const replacement = createJobJournal(path, {
        pid: 222_222,
        isAlive: (pid) => pid === 333_333,
      });
      const orphan = replacement.orphans().find((row) => row.jobId === "job-dead");
      expect(orphan).toBeDefined();
      replacement.clearOrphan?.(orphan!);

      const stored = JSON.parse(readFileSync(path, "utf8")) as {
        jobs: Array<{ jobId: string }>;
      };
      expect(stored.jobs.map((row) => row.jobId)).toEqual(["job-live"]);
    } finally {
      cleanup();
    }
  });

  it("orphan acknowledgement cannot erase a same-id row republished by another owner", () => {
    const { dir, cleanup } = tempDir();
    try {
      const path = join(dir, "mcp-jobs.json");
      createJobJournal(path, { pid: 111_111, isAlive: () => false }).note({
        jobId: "job-reused",
        laneId: "lane-old",
        cwd: "C:/tree",
        startedAt: 1,
      });

      const replacement = createJobJournal(path, { pid: 222_222, isAlive: () => false });
      const orphan = replacement.orphans().find((row) => row.jobId === "job-reused");
      expect(orphan).toBeDefined();

      createJobJournal(path, { pid: 333_333, isAlive: () => true }).note({
        jobId: "job-reused",
        laneId: "lane-new",
        cwd: "C:/tree",
        startedAt: 2,
      });

      replacement.clearOrphan?.(orphan!);

      const stored = JSON.parse(readFileSync(path, "utf8")) as {
        jobs: Array<{ jobId: string; laneId: string; startedAt: number; owner?: { pid: number } }>;
      };
      expect(stored.jobs).toHaveLength(1);
      expect(stored.jobs[0]).toMatchObject({
        jobId: "job-reused",
        laneId: "lane-new",
        startedAt: 2,
        owner: { pid: 333_333 },
      });
    } finally {
      cleanup();
    }
  });

  it("waits through contention longer than the generic 5s lock budget instead of losing a journal row", async () => {
    const { dir, cleanup } = tempDir();
    const workers: Worker[] = [];
    try {
      const journalPath = join(dir, "mcp-jobs.json");
      const ready = join(dir, "ready-long-lock");
      workers.push(spawnWorker(["hold-lock-timed", journalPath, ready, "6000"]));
      await waitForFiles([ready], workers);

      const started = Date.now();
      createJobJournal(journalPath).note({
        jobId: "job-after-long-contention",
        laneId: "lane-a",
        cwd: process.cwd(),
        startedAt: 1,
      });
      const elapsed = Date.now() - started;
      await Promise.all(workers.map(waitForExit));

      expect(elapsed).toBeGreaterThanOrEqual(5_000);
      const journal = JSON.parse(readFileSync(journalPath, "utf8")) as {
        jobs: Array<{ jobId: string }>;
      };
      expect(journal.jobs.map((row) => row.jobId)).toContain("job-after-long-contention");
    } finally {
      stopWorkers(workers);
      cleanup();
    }
  }, 20_000);

  it("retries when a contended lock is released before the contender inspects it", () => {
    const { dir, cleanup } = tempDir();
    try {
      const path = join(dir, "state.json");
      const lockPath = `${path}.lock`;
      mkdirSync(lockPath);
      writeFileSync(
        join(lockPath, "owner.json"),
        JSON.stringify({
          version: 1,
          pid: process.pid,
          instance: "incumbent-test-lock",
          acquiredAt: Date.now(),
        }),
      );

      let contentions = 0;
      expect(
        transactionalUpdateJsonSync(
          path,
          () => ({ value: 1 }),
          {
            strict: true,
            lock: {
              retryMs: 1,
              timeoutMs: 500,
              onContention: () => {
                contentions += 1;
                if (contentions === 1) rmSync(lockPath, { recursive: true, force: true });
              },
            },
          },
        ),
      ).toBe(true);
      expect(contentions).toBeGreaterThanOrEqual(1);
      expect(JSON.parse(readFileSync(path, "utf8"))).toEqual({ value: 1 });
    } finally {
      cleanup();
    }
  });

  it("ignores an abandoned unpublished claim directory", () => {
    const { dir, cleanup } = tempDir();
    try {
      const path = join(dir, "state.json");
      const abandoned = `${path}.lock.dead-process.claim`;
      mkdirSync(abandoned, { recursive: true });
      writeFileSync(join(abandoned, "owner.json"), "{ incomplete");

      expect(
        transactionalUpdateJsonSync(path, () => ({ value: 1 }), {
          strict: true,
          lock: { retryMs: 10, timeoutMs: 500 },
        }),
      ).toBe(true);
      expect(JSON.parse(readFileSync(path, "utf8"))).toEqual({ value: 1 });
    } finally {
      cleanup();
    }
  });

  it("preserves an unrelated live row when a real process clear races another process update", async () => {
    const { dir, cleanup } = tempDir();
    const workers: Worker[] = [];
    try {
      const journalPath = join(dir, "mcp-jobs.json");
      const start = join(dir, "start");
      const release = join(dir, "release");
      const clearReady = join(dir, "clear-ready");
      const updateReady = join(dir, "update-ready");
      const clearDone = join(dir, "clear-done");
      const updateDone = join(dir, "update-done");

      workers.push(
        spawnWorker(["journal-clear", journalPath, "job-clear", clearReady, start, clearDone, release]),
        spawnWorker(["journal-update", journalPath, "job-keep", updateReady, start, updateDone, release]),
      );

      await waitForFiles([clearReady, updateReady], workers);
      writeFileSync(start, "go");
      await waitForFiles([clearDone, updateDone], workers);

      const stored = JSON.parse(readFileSync(journalPath, "utf8")) as {
        jobs: Array<{ jobId: string; laneId: string }>;
      };
      expect(stored.jobs.map((row) => row.jobId)).toEqual(["job-keep"]);
      expect(stored.jobs[0]?.laneId).toBe("lane-after-update");

      writeFileSync(release, "done");
      await Promise.all(workers.map(waitForExit));
    } finally {
      stopWorkers(workers);
      cleanup();
    }
  });

  it("preserves a starting-tree snapshot when another process updates the shared journal", async () => {
    const { dir, cleanup } = tempDir();
    const workers: Worker[] = [];
    try {
      const journalPath = join(dir, "mcp-jobs.json");
      const start = join(dir, "start");
      const release = join(dir, "release");
      const treeReady = join(dir, "tree-ready");
      const updateReady = join(dir, "update-ready");
      const treeDone = join(dir, "tree-done");
      const updateDone = join(dir, "update-done");

      workers.push(
        spawnWorker(["journal-tree", journalPath, "job-tree", treeReady, start, treeDone, release]),
        spawnWorker(["journal-update", journalPath, "job-other", updateReady, start, updateDone, release]),
      );

      await waitForFiles([treeReady, updateReady], workers);
      writeFileSync(start, "go");
      await waitForFiles([treeDone, updateDone], workers);

      const stored = JSON.parse(readFileSync(journalPath, "utf8")) as {
        jobs: Array<{
          jobId: string;
          laneId: string;
          startingTree?: { prefix: string; entries: [string, string][]; scope?: string[] };
        }>;
      };
      expect(new Set(stored.jobs.map((row) => row.jobId))).toEqual(new Set(["job-tree", "job-other"]));
      const treeRow = stored.jobs.find((row) => row.jobId === "job-tree");
      expect(treeRow?.startingTree).toEqual({
        prefix: "",
        entries: [["pre.ts", " M"]],
        scope: ["src"],
      });
      expect(stored.jobs.find((row) => row.jobId === "job-other")?.laneId).toBe("lane-after-update");

      writeFileSync(release, "done");
      await Promise.all(workers.map(waitForExit));
    } finally {
      stopWorkers(workers);
      cleanup();
    }
  });

  it("never steals a live lock and recovers the same lock after its owner dies", async () => {
    const { dir, cleanup } = tempDir();
    const workers: Worker[] = [];
    try {
      const path = join(dir, "state.json");
      const ready = join(dir, "locked");
      const holder = spawnWorker(["hold-lock", path, ready]);
      workers.push(holder);
      await waitForFiles([ready], workers);

      expect(() =>
        transactionalUpdateJsonSync(path, () => ({ value: 1 }), {
          strict: true,
          lock: { retryMs: 10, timeoutMs: 100 },
        }),
      ).toThrow(/Timed out acquiring file lock/);

      holder.child.kill();
      await waitForExit(holder);

      expect(
        transactionalUpdateJsonSync(path, () => ({ value: 2 }), {
          strict: true,
          lock: { retryMs: 10, timeoutMs: 2_000 },
        }),
      ).toBe(true);
      expect(JSON.parse(readFileSync(path, "utf8"))).toEqual({ value: 2 });
    } finally {
      stopWorkers(workers);
      cleanup();
    }
  });

  it("an older archive instance cannot overwrite a newer same-id row while recording another job", () => {
    const { dir, cleanup } = tempDir();
    try {
      const path = join(dir, "mcp-job-archive.json");
      createJobArchive(path).record(terminalJob("job-same", "old", 1));

      const stale = createJobArchive(path);
      stale.restore();
      createJobArchive(path).record(terminalJob("job-same", "new", 2));

      stale.record(terminalJob("job-other", "other", 3));
      expect(createJobArchive(path).lookup("job-same")?.stdout).toBe("new");
      expect(createJobArchive(path).lookup("job-other")?.stdout).toBe("other");
    } finally {
      cleanup();
    }
  });

  it("a journal clear preserves a same-id row subsequently published by another live owner", () => {
    const { dir, cleanup } = tempDir();
    try {
      const path = join(dir, "mcp-jobs.json");
      const alive = () => true;
      const first = createJobJournal(path, { pid: 111_111_111, isAlive: alive });
      const second = createJobJournal(path, { pid: 222_222_222, isAlive: alive });
      const row = { jobId: "job-shared", laneId: "first", cwd: "C:/tree", startedAt: 1 };

      first.note(row);
      second.note({ ...row, laneId: "second" });
      first.clear(row.jobId);

      const stored = JSON.parse(readFileSync(path, "utf8")) as {
        jobs: Array<{ jobId: string; laneId: string; owner?: { pid: number } }>;
      };
      expect(stored.jobs).toHaveLength(1);
      expect(stored.jobs[0]).toMatchObject({
        jobId: row.jobId,
        laneId: "second",
        owner: { pid: 222_222_222 },
      });
    } finally {
      cleanup();
    }
  });

  it("archives a killed startup orphan before acknowledging its journal row", () => {
    const calls: string[] = [];
    const orphan = {
      jobId: "job-orphan",
      laneId: "lane",
      cwd: "C:/tree",
      startedAt: 1,
    };
    const journal: JobJournal = {
      note: () => {},
      clear: () => {},
      clearOrphan: () => calls.push("clear-orphan"),
      orphans: () => [orphan],
      foreign: () => undefined,
      foreignRows: () => [],
    };
    const archive: JobArchive = {
      record: () => {
        calls.push("archive");
        return true;
      },
      restore: () => ({ jobs: [], lastSeq: 0 }),
      flush: () => {},
      lookup: () => undefined,
      all: () => [],
    };

    new LaneJobStore(journal, archive, () => "unused");
    expect(calls).toEqual(["archive", "clear-orphan"]);
  });

  it("leaves a startup orphan journaled when its killed report cannot be archived", () => {
    const calls: string[] = [];
    const orphan = {
      jobId: "job-orphan",
      laneId: "lane",
      cwd: "C:/tree",
      startedAt: 1,
    };
    const journal: JobJournal = {
      note: () => {},
      clear: () => {},
      clearOrphan: () => calls.push("clear-orphan"),
      orphans: () => [orphan],
      foreign: () => undefined,
      foreignRows: () => [],
    };
    const archive: JobArchive = {
      record: () => {
        calls.push("archive-failed");
        return false;
      },
      restore: () => ({ jobs: [], lastSeq: 0 }),
      flush: () => {},
      lookup: () => undefined,
      all: () => [],
    };

    new LaneJobStore(journal, archive, () => "unused");
    expect(calls).toEqual(["archive-failed"]);
  });

  it("archives a terminal job before clearing its running journal row", () => {
    const calls: string[] = [];
    const journal: JobJournal = {
      note: () => calls.push("note"),
      clear: () => calls.push("clear"),
      orphans: () => [],
      foreign: () => undefined,
      foreignRows: () => [],
    };
    const archive: JobArchive = {
      record: () => {
        calls.push("archive");
        return true;
      },
      restore: () => ({ jobs: [], lastSeq: 0 }),
      flush: () => {},
      lookup: () => undefined,
      all: () => [],
    };
    const store = new LaneJobStore(journal, archive, () => "job-order");
    const job = store.create("lane", undefined, "C:/tree");
    calls.length = 0;

    store.complete(job.id, { code: 0, stdout: "done", stderr: "", timedOut: false });
    expect(calls).toEqual(["archive", "clear"]);
  });

  it("keeps the running journal row when the terminal archive commit fails", () => {
    const calls: string[] = [];
    const journal: JobJournal = {
      note: () => calls.push("note"),
      clear: () => calls.push("clear"),
      orphans: () => [],
      foreign: () => undefined,
      foreignRows: () => [],
    };
    const archive: JobArchive = {
      record: () => {
        calls.push("archive-failed");
        return false;
      },
      restore: () => ({ jobs: [], lastSeq: 0 }),
      flush: () => {},
      lookup: () => undefined,
      all: () => [],
    };
    const store = new LaneJobStore(journal, archive, () => "job-retained");
    const job = store.create("lane", undefined, "C:/tree");
    calls.length = 0;

    store.complete(job.id, { code: 0, stdout: "done", stderr: "", timedOut: false });
    expect(calls).toEqual(["archive-failed"]);
  });

  it("clears a retained journal fallback after a later terminal archive retry succeeds", () => {
    const calls: string[] = [];
    let archiveAttempts = 0;
    const journal: JobJournal = {
      note: () => calls.push("note"),
      clear: () => calls.push("clear"),
      orphans: () => [],
      foreign: () => undefined,
      foreignRows: () => [],
    };
    const archive: JobArchive = {
      record: () => {
        archiveAttempts += 1;
        calls.push(`archive-${archiveAttempts}`);
        return archiveAttempts > 1;
      },
      restore: () => ({ jobs: [], lastSeq: 0 }),
      flush: () => {},
      lookup: () => undefined,
      all: () => [],
    };
    const store = new LaneJobStore(journal, archive, () => "job-retry");
    const job = store.create("lane", undefined, "C:/tree");
    calls.length = 0;

    store.complete(job.id, { code: 0, stdout: "done", stderr: "", timedOut: false });
    expect(calls).toEqual(["archive-1"]);

    store.noteTreeDelta(job.id, "tree delta: clean");
    expect(calls).toEqual(["archive-1", "archive-2", "clear"]);
  });
});
