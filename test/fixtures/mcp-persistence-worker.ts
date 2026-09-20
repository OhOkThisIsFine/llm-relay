import { existsSync, writeFileSync } from "node:fs";
import { createJobArchive } from "../../src/mcp/job-archive.js";
import { createJobJournal } from "../../src/mcp/job-journal.js";
import type { LaneJob } from "../../src/mcp/lane-runner.js";
import { withFileLockSync } from "../../src/storage/file-lock.js";
import { transactionalUpdateJsonSync } from "../../src/storage/json-store.js";

const sleeper = new Int32Array(new SharedArrayBuffer(4));
const sleepSync = (ms: number): void => {
  Atomics.wait(sleeper, 0, 0, ms);
};
const waitForFile = (path: string): void => {
  while (!existsSync(path)) sleepSync(5);
};
const arg = (index: number): string => {
  const value = process.argv[2 + index];
  if (value === undefined) throw new Error(`missing worker argument ${index}`);
  return value;
};

const mode = arg(0);

if (mode === "transaction") {
  const path = arg(1);
  const id = arg(2);
  const ready = arg(3);
  const start = arg(4);
  const done = arg(5);
  writeFileSync(ready, "ready");
  waitForFile(start);

  interface RowsFile {
    version: 1;
    rows: string[];
  }
  const isRowsFile = (value: unknown): value is RowsFile => {
    if (typeof value !== "object" || value === null) return false;
    const row = value as Record<string, unknown>;
    return row["version"] === 1 && Array.isArray(row["rows"]) && row["rows"].every((v) => typeof v === "string");
  };

  transactionalUpdateJsonSync<RowsFile>(
    path,
    (current) => {
      // Deliberately widen the read/write race. With no transaction lock, every worker reads the
      // same snapshot, sleeps, then rewrites it with only its own row.
      sleepSync(200);
      return { version: 1, rows: [...(current?.rows ?? []), id] };
    },
    { validator: isRowsFile, strict: true },
  );
  writeFileSync(done, "done");
} else if (mode === "mcp") {
  const journalPath = arg(1);
  const archivePath = arg(2);
  const id = arg(3);
  const ready = arg(4);
  const start = arg(5);
  const done = arg(6);
  const release = arg(7);
  writeFileSync(ready, "ready");
  waitForFile(start);

  const startedAt = Date.now();
  createJobJournal(journalPath).note({
    jobId: id,
    laneId: `lane-${id}`,
    cwd: process.cwd(),
    startedAt,
    // A larger row makes the old unlocked read/merge/rewrite overlap readily under real processes.
    label: "x".repeat(128 * 1024),
  });

  const archived: LaneJob = {
    id,
    status: "completed",
    laneId: `lane-${id}`,
    spec: undefined,
    attempts: [],
    startedAt,
    endedAt: startedAt + 1,
    exitCode: 0,
    stdout: "y".repeat(128 * 1024),
    stderr: "",
    timedOut: false,
    cwd: process.cwd(),
    error: undefined,
  };
  createJobArchive(archivePath).record(archived);
  writeFileSync(done, "done");

  // Keep every journal owner alive until the parent has inspected the shared file. A later writer
  // is otherwise allowed to drop a row whose owner process has already exited.
  waitForFile(release);
} else if (mode === "journal-clear") {
  const journalPath = arg(1);
  const id = arg(2);
  const ready = arg(3);
  const start = arg(4);
  const done = arg(5);
  const release = arg(6);
  const journal = createJobJournal(journalPath);
  journal.note({
    jobId: id,
    laneId: "lane-before-clear",
    cwd: process.cwd(),
    startedAt: Date.now(),
    label: "c".repeat(128 * 1024),
  });
  writeFileSync(ready, "ready");
  waitForFile(start);
  journal.clear(id);
  writeFileSync(done, "done");
  waitForFile(release);
} else if (mode === "journal-update") {
  const journalPath = arg(1);
  const id = arg(2);
  const ready = arg(3);
  const start = arg(4);
  const done = arg(5);
  const release = arg(6);
  const journal = createJobJournal(journalPath);
  const startedAt = Date.now();
  journal.note({
    jobId: id,
    laneId: "lane-before-update",
    cwd: process.cwd(),
    startedAt,
    label: "u".repeat(128 * 1024),
  });
  writeFileSync(ready, "ready");
  waitForFile(start);
  journal.note({
    jobId: id,
    laneId: "lane-after-update",
    cwd: process.cwd(),
    startedAt,
    label: "u".repeat(128 * 1024),
  });
  writeFileSync(done, "done");
  waitForFile(release);
} else if (mode === "journal-tree") {
  const journalPath = arg(1);
  const id = arg(2);
  const ready = arg(3);
  const start = arg(4);
  const done = arg(5);
  const release = arg(6);
  const journal = createJobJournal(journalPath);
  journal.note({
    jobId: id,
    laneId: "lane-tree",
    cwd: process.cwd(),
    startedAt: Date.now(),
    label: "t".repeat(128 * 1024),
  });
  writeFileSync(ready, "ready");
  waitForFile(start);
  journal.noteStartingTree?.(
    id,
    { prefix: "", entries: new Map([["pre.ts", " M"]]) },
    ["src"],
  );
  writeFileSync(done, "done");
  waitForFile(release);
} else if (mode === "hold-lock") {
  const path = arg(1);
  const ready = arg(2);
  withFileLockSync(path, () => {
    writeFileSync(ready, "ready");
    for (;;) sleepSync(1_000);
  });
} else {
  throw new Error(`unknown worker mode: ${mode}`);
}
