/**
 * The finished-job archive — how a job's FINAL report survives the MCP server restarting.
 *
 * ⚠ WHY THIS EXISTS (C:\Code\docs\backlog.md, 2026-09-11, re-hit 2026-09-15): the relay was
 * restarted between two sessions; `dispatch_status`/`dispatch_result` then answered `unknown jobId`
 * for `job-0140` and `job-0143`, whose lanes had FINISHED their tree work but whose final reports
 * existed only in the server's memory. The orchestrator re-ran both lanes to recover what the lost
 * reports held. And every restart renumbered from `job-0001`, so a handle from before the restart
 * could name a different job after it.
 *
 * ⚠ This is the SIBLING of `job-journal.ts`, not a widening of it, and the two hold disjoint sets:
 * the journal carries a row only while its job RUNS (so a restart can report the killed set), this
 * file carries a row only once a job is TERMINAL. Neither describes a live process after a restart —
 * a terminal job owns no process — so the reason `LaneJobStore` is in memory ("a durable store would
 * describe processes that no longer exist") does not apply to what is archived here.
 *
 * ⚠ A terminal row is written EAGERLY, not write-behind, and that is deliberate: the measured
 * restart is the host killing this process (`TerminateProcess`, no signal handler runs), so a
 * debounced write would lose exactly the report the archive exists to keep, in exactly the case it
 * exists for. A terminal transition happens once per job, so the write is rare.
 *
 * Bounded: the newest `MAX_ARCHIVED_JOBS` jobs, each stream capped at `MAX_ARCHIVED_OUTPUT_CHARS`
 * with the TAIL kept (a lane's final report is the end of its stdout) and a marker saying what was
 * cut. Corrupt / absent / wrong-version ⇒ nothing restored, and the file is left alone (the
 * `lane-manifest.ts` rule); each row is validated field by field and one bad row is dropped alone.
 */
import { atomicWriteJsonSync, safeReadJsonSync } from "../storage/json-store.js";
import { relayStatePath } from "../state-paths.js";
import type { LaneJob, LaneAttempt, LaneProcessReport, JobStatus } from "./lane-runner.js";

export const JOB_ARCHIVE_VERSION = 1;

/** How many finished jobs the archive keeps; the oldest by end time are dropped first. */
export const MAX_ARCHIVED_JOBS = 100;

/** Per-stream cap on archived output; the tail is kept, because the final report is at the end. */
export const MAX_ARCHIVED_OUTPUT_CHARS = 512 * 1024;

/** A finished job as the archive stores it — a `LaneJob` whose status is never `running`. */
export type ArchivedJob = LaneJob & { status: Exclude<JobStatus, "running">; endedAt: number };

export interface JobArchiveFile {
  version: 1;
  /** Legacy v1 field retained so pre-random-id archives remain readable. */
  lastSeq: number;
  jobs: ArchivedJob[];
}

/**
 * Where the archive lives. Cache-kind (re-derivable in the weak sense that a lost row costs one
 * lost report, never a credential or an operator's edit), XDG-aware through `state-paths.ts`.
 *
 * ⚠ Guarded at the RESOLVER, the `state-paths` rule: under vitest the default is a per-pid file
 * under the shared vitest root, so a suite never reads the operator's real archive and never leaves
 * a row a later real start would report. Same namespace shape as `jobJournalPath`.
 */
export function jobArchivePath(env: NodeJS.ProcessEnv = process.env): string {
  if (env["VITEST"]) {
    return relayStatePath("cache", ["llm-relay-vitest", `mcp-job-archive-${process.pid}.json`]);
  }
  return relayStatePath("cache", ["mcp-job-archive.json"]);
}

/** The archive seam. Injected so the suite proves the restart path against a temp file. */
export interface JobArchive {
  /** Persist a job that has reached a terminal state. Written at once. */
  record(job: LaneJob): void;
  /** What a previous process left; lastSeq is legacy v1 compatibility only. */
  restore(): { jobs: ArchivedJob[]; lastSeq: number };
  /** Run any pending debounced write now — the shutdown seam. */
  flush(): void;
  /**
   * A finished job read from disk NOW, or undefined. This is how one host's server answers for a
   * job that another host's server finished after this one started.
   */
  lookup(jobId: string): ArchivedJob | undefined;
  /** Every finished job on disk now. */
  all(): ArchivedJob[];
}

/** An archive that keeps nothing. The default for an embedder that declines one. */
export const nullJobArchive: JobArchive = {
  record: () => {},
  restore: () => ({ jobs: [], lastSeq: 0 }),
  flush: () => {},
  lookup: () => undefined,
  all: () => [],
};

/** The sequence number inside a legacy safe-integer `job-NNNN` id, or null for opaque/new ids. */
export function jobSeqOf(id: string): number | null {
  const m = /^job-(\d+)$/.exec(id);
  if (!m) return null;
  const n = Number(m[1]);
  return Number.isSafeInteger(n) && n > 0 ? n : null;
}

/**
 * The real archive: one JSON file, read ONCE at construction, rewritten on every terminal
 * transition. Rows from a previous process are kept (they are what the next reader wants), and
 * the bound is applied on every write so the file cannot grow past `MAX_ARCHIVED_JOBS`.
 */
export function createJobArchive(path: string = jobArchivePath()): JobArchive {
  const rows = new Map<string, ArchivedJob>();
  let lastSeq = 0;
  let loaded = false;

  /** The valid rows and the highest sequence on disk now; null for an absent or unusable file. */
  const readDisk = (): { rows: ArchivedJob[]; lastSeq: number } | null => {
    const parsed = safeReadJsonSync<JobArchiveFile>(path, {
      validator: (v): v is JobArchiveFile =>
        isRecord(v) && v["version"] === JOB_ARCHIVE_VERSION && Array.isArray(v["jobs"]),
    });
    if (!parsed) return null;
    let seq = typeof parsed.lastSeq === "number" && Number.isSafeInteger(parsed.lastSeq) && parsed.lastSeq > 0
      ? parsed.lastSeq
      : 0;
    const valid: ArchivedJob[] = [];
    for (const row of parsed.jobs) {
      if (!isArchivedJob(row)) continue;
      valid.push(row);
      const s = jobSeqOf(row.id);
      if (s !== null && s > seq) seq = s;
    }
    return { rows: valid, lastSeq: seq };
  };

  const readOnce = (): void => {
    if (loaded) return;
    loaded = true;
    const disk = readDisk();
    if (!disk) return;
    lastSeq = disk.lastSeq;
    for (const row of disk.rows) rows.set(row.id, row);
  };

  /**
   * ⚠ Merge before every write. Another host's `llm-relay mcp` process writes this same file, and
   * the previous version wrote only the rows this process had loaded at start, so each process
   * erased every job the other one finished. A row this process holds wins over the disk copy of
   * the same id. Not locked: two writes in one instant can still lose one row.
   */
  const write = (): void => {
    try {
      const disk = readDisk();
      if (disk) {
        for (const row of disk.rows) if (!rows.has(row.id)) rows.set(row.id, row);
        if (disk.lastSeq > lastSeq) lastSeq = disk.lastSeq;
      }
      atomicWriteJsonSync(path, { version: JOB_ARCHIVE_VERSION, lastSeq, jobs: boundedRows(rows) });
    } catch {
      // Best-effort: a full disk must not become a dispatch failure. The report still exists in
      // memory for as long as this process lives, exactly as before the archive existed.
    }
  };

  return {
    record(job) {
      readOnce();
      if (job.status === "running" || job.endedAt === undefined) return;
      rows.set(job.id, boundOutput(job as ArchivedJob));
      // ⚠ Eager, see the module header: the case this exists for is a process killed with no
      // handler, where a delayed write is a lost report.
      write();
    },
    restore() {
      readOnce();
      return { jobs: [...rows.values()], lastSeq };
    },
    flush() {
      // Terminal archive writes are eager; kept as the shutdown seam for callers and embedders.
    },
    lookup(jobId) {
      return readDisk()?.rows.find((row) => row.id === jobId);
    },
    all() {
      return readDisk()?.rows ?? [];
    },
  };
}

/** The newest `MAX_ARCHIVED_JOBS` rows, newest last, and trim the map to match. */
function boundedRows(rows: Map<string, ArchivedJob>): ArchivedJob[] {
  const sorted = [...rows.values()].sort((a, b) => a.endedAt - b.endedAt);
  const dropped = sorted.length - MAX_ARCHIVED_JOBS;
  if (dropped > 0) {
    for (const row of sorted.slice(0, dropped)) rows.delete(row.id);
    return sorted.slice(dropped);
  }
  return sorted;
}

/** Cap each captured stream at `MAX_ARCHIVED_OUTPUT_CHARS`, keeping the tail and saying what was cut. */
function boundOutput(job: ArchivedJob): ArchivedJob {
  const cut = (text: string): string => {
    if (text.length <= MAX_ARCHIVED_OUTPUT_CHARS) return text;
    const removed = text.length - MAX_ARCHIVED_OUTPUT_CHARS;
    return `[archive: first ${removed} characters cut; the tail follows]\n${text.slice(removed)}`;
  };
  // A plain copy of the enumerable fields: the store's own object must not be shared with the
  // archive, or a later in-memory mutation would silently change what "was persisted".
  return { ...job, stdout: cut(job.stdout), stderr: cut(job.stderr), attempts: job.attempts.map((a) => ({ ...a })) };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

const TERMINAL: ReadonlySet<string> = new Set(["completed", "failed", "cancelled", "timed_out", "killed"]);

function isAttempt(value: unknown): value is LaneAttempt {
  if (!isRecord(value)) return false;
  return (
    typeof value["laneId"] === "string" &&
    (value["spec"] === undefined || typeof value["spec"] === "string") &&
    typeof value["status"] === "string" &&
    typeof value["elapsedMs"] === "number" &&
    (value["reason"] === undefined || typeof value["reason"] === "string")
  );
}

function isProcessReport(value: unknown): value is LaneProcessReport {
  if (!isRecord(value)) return false;
  const nums = (v: unknown): v is number[] => Array.isArray(v) && v.every((n) => typeof n === "number");
  return nums(value["pids"]) && nums(value["survivors"]) && typeof value["terminated"] === "boolean";
}

/**
 * Field-by-field validation of one archived row. Only the fields a renderer reads are required;
 * every optional field is checked when present, and any shape mismatch drops the row ALONE.
 */
export function isArchivedJob(value: unknown): value is ArchivedJob {
  if (!isRecord(value)) return false;
  const optString = (k: string): boolean => value[k] === undefined || typeof value[k] === "string";
  const optBool = (k: string): boolean => value[k] === undefined || typeof value[k] === "boolean";
  const optStrings = (k: string): boolean => {
    const v = value[k];
    return v === undefined || (Array.isArray(v) && v.every((n) => typeof n === "string"));
  };
  return (
    typeof value["id"] === "string" &&
    typeof value["status"] === "string" &&
    TERMINAL.has(value["status"]) &&
    typeof value["laneId"] === "string" &&
    optString("spec") &&
    typeof value["startedAt"] === "number" &&
    typeof value["endedAt"] === "number" &&
    (value["exitCode"] === null || typeof value["exitCode"] === "number") &&
    typeof value["stdout"] === "string" &&
    typeof value["stderr"] === "string" &&
    typeof value["timedOut"] === "boolean" &&
    typeof value["cwd"] === "string" &&
    optString("error") &&
    Array.isArray(value["attempts"]) &&
    value["attempts"].every(isAttempt) &&
    (value["lanesNotTried"] === undefined || typeof value["lanesNotTried"] === "number") &&
    optBool("walkEnabled") &&
    optBool("forcedLane") &&
    optBool("restored") &&
    optString("label") &&
    optString("treeDelta") &&
    optStrings("launch") &&
    (value["process"] === undefined || isProcessReport(value["process"])) &&
    (value["dispatchSource"] === undefined || value["dispatchSource"] === "daemon" || value["dispatchSource"] === "fallback") &&
    (value["relay"] === undefined || isRecord(value["relay"])) &&
    (value["readOnly"] === undefined || isRecord(value["readOnly"]))
  );
}
