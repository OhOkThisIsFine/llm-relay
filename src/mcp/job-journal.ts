/**
 * The running-job journal — how a lane killed by its own server restarting is REPORTED as killed.
 *
 * ⚠ WHY THIS EXISTS, and it is the worst single recorded case in the dispatch backlog
 * (C:\Code\docs\backlog.md, 2026-09-06): an overnight lap had `job-0051` through `job-0055` in
 * flight. Every handle became `unknown jobId`, the counter restarted at `job-0003`, and a process
 * check showed every lane process gone — the restart does not merely orphan the handle, it KILLS
 * the lane. All five had written nothing, so roughly ninety lane-minutes were lost with nothing to
 * salvage and no report of what any of them had decided. **Nothing announced the restart; the first
 * symptom was `unknown jobId` on a routine poll.**
 *
 * ⚠ This does NOT make the job store durable, and it must not: `LaneJobStore` is in memory on
 * purpose, because this process is stdio-attached to one host session and a durable store would
 * outlive the processes it describes and start reporting jobs whose output no longer exists. The
 * journal carries only what is needed to answer "which jobs died", and a row is deleted the moment
 * its job reaches a terminal state — so what remains at startup is exactly the set that did not.
 *
 * ⚠ Ownership boundary, same as `lane-runner.ts`: this process is launched by the HOST, never by
 * the relay daemon, so it writes its own file under the cache directory and touches no relay state.
 */
import { safeReadJsonSync, transactionalUpdateJsonSync } from "../storage/json-store.js";
import { relayStatePath } from "../state-paths.js";
import { MAX_ACTIVITY_STAT_PATHS, type TreeSnapshot } from "./tree-delta.js";

/** One running job, as the journal records it. */
export interface JournalBrokerExecution {
  kind: "daemon-v1";
  executionId: string;
}

export interface JournalRow {
  jobId: string;
  laneId: string;
  spec?: string;
  cwd: string;
  startedAt: number;
  /** The task's first line, cut short, so another process can list the job recognisably. */
  label?: string;
  /**
   * The job-wide git status captured before the first lane ran, plus the caller's scope. Optional
   * because answer-mode jobs, non-git cwd values, old rows, and trees above the bounded path limit
   * deliberately carry none.
   */
  startingTree?: JournalStartingTree;
  /**
   * D1 daemon-owned execution reference. Optional/additive so pre-broker rows remain valid.
   * The task, environment, command line and pid are deliberately NOT persisted here.
   */
  brokerExecution?: JournalBrokerExecution;
  /**
   * The process and the journal instance that own the row. Absent on a row written before
   * 2026-09-17, which is read exactly as before: an orphan.
   *
   * ⚠ Why both exist. Two hosts run their own `llm-relay mcp` process at the same time (Claude
   * Desktop and Codex Desktop, measured), and both write this one file. Before the owner was
   * recorded, the second process to start read the first one's LIVE jobs as orphans and reported
   * them killed, and every write by either process erased the other's rows. The pid says whether
   * the owner can still be running; the instance token tells two journals inside one process apart,
   * which is how the suite simulates a restart without a second process.
   */
  owner?: { pid: number; instance: string };
}

export interface JournalStartingTree {
  prefix: string;
  entries: [string, string][];
  scope?: string[];
}

export interface JournalFile {
  version: 1;
  jobs: JournalRow[];
}

export const JOB_JOURNAL_VERSION = 1;

/**
 * Where the journal lives. Cache-kind (re-fetchable: it describes live processes, and a lost row
 * costs one unreported death, never a credential or an operator's own edit), and XDG-aware through
 * the one policy in `state-paths.ts` rather than a fourteenth hand-rolled resolver.
 */
export function jobJournalPath(env: NodeJS.ProcessEnv = process.env): string {
  if (env["VITEST"]) {
    // ⚠ Guarded at the RESOLVER, the `state-paths` rule: a call-site guard is how the
    // control-token one came to be half-covered. A suite must never write the operator's real
    // journal, and must never leave a row there that a later real start would report as killed.
    return relayStatePath("cache", ["llm-relay-vitest", `mcp-jobs-${process.pid}.json`]);
  }
  return relayStatePath("cache", ["mcp-jobs.json"]);
}

/**
 * The journal seam. Injected so the suite proves the restart path without a real file, and so a
 * caller that wants no journal at all (a programmatic embed) can pass a no-op.
 */
export interface JobJournal {
  /** Record a job as running. */
  note(row: JournalRow): void;
  /** Persist the starting git status for a running agent-mode job, when it fits the bound. */
  noteStartingTree?(jobId: string, tree: TreeSnapshot, scope: readonly string[] | undefined): void;
  /** Persist the daemon-owned execution reference for a running job. D1 Phase 3 consumes it. */
  noteBrokerExecution?(jobId: string, execution: JournalBrokerExecution): void;
  /** Remove a job that reached a terminal state, or one that never started. */
  clear(jobId: string): void;
  /** Rows present at STARTUP whose owner is gone — i.e. jobs a previous process died holding. */
  orphans(): JournalRow[];
  /**
   * The row for `jobId` if ANOTHER live process owns it right now, read from disk at call time.
   * This is how one host's server answers for a job another host's server is still running.
   */
  foreign(jobId: string): JournalRow | undefined;
  /** Every row another live process owns now. */
  foreignRows(): JournalRow[];
}

/** A journal that records nothing. The default under vitest, and for an embedder that declines one. */
export const nullJobJournal: JobJournal = {
  note: () => {},
  noteStartingTree: () => {},
  noteBrokerExecution: () => {},
  clear: () => {},
  orphans: () => [],
  foreign: () => undefined,
  foreignRows: () => [],
};

/** How a journal decides who owns a row. Injected so the suite can prove both branches. */
export interface JobJournalOptions {
  /** This process's pid. */
  pid?: number;
  /** Does `pid` still name a running process? `process.kill(pid, 0)` by default. */
  isAlive?: (pid: number) => boolean;
}

function defaultIsAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return (e as NodeJS.ErrnoException).code === "EPERM";
  }
}

let instanceCounter = 0;

/**
 * The real journal: a small JSON file rewritten on every change, read ONCE at construction.
 *
 * ⚠ The read happens before any write, and the file is left in place afterwards. It is NOT deleted
 * on startup: a second host session starting while this one runs would otherwise erase the rows
 * still describing this one's live jobs. Rows are removed one at a time, by the process that owns
 * them, as their jobs end.
 *
 * Corrupt or wrong-version ⇒ no orphans, and the file is left alone. Reporting a job as killed on
 * the strength of an unparseable file would invent deaths, which is the same fail-safe direction
 * `lane-manifest.ts` takes on a corrupt manifest.
 */
export function createJobJournal(path: string = jobJournalPath(), options: JobJournalOptions = {}): JobJournal {
  const pid = options.pid ?? process.pid;
  const isAlive = options.isAlive ?? defaultIsAlive;
  instanceCounter += 1;
  const instance = `${pid}-${Date.now().toString(36)}-${instanceCounter}`;
  const rows = new Map<string, JournalRow>();
  let loaded = false;
  let startupOrphans: JournalRow[] = [];

  // ⚠ The option is spelled `validator`, and it was written as `validate` first — a misspelling
  // that made the guard INERT, so a wrong-version file loaded as if it had passed. `safeReadJson`
  // had no such option, so the call silently read whatever JSON was there. `test/mcp-restart-
  // report.test.ts` caught it (the corrupt-JSON case passed regardless — `JSON.parse` throws on
  // its own — and only the version-99 case distinguished); `tsc` reports it too, as TS2561.
  const readDisk = (): JournalRow[] | null => {
    const parsed = safeReadJsonSync<JournalFile>(path, { validator: isJournalFile });
    if (!parsed) return null;
    const valid: JournalRow[] = [];
    for (const value of parsed.jobs) {
      const row = readJournalRow(value);
      if (row !== null) valid.push(row);
    }
    return valid;
  };

  /**
   * Is the row's owner still running, other than this journal? A row with no owner predates the
   * field and is read as before. A row carrying THIS pid but another instance was written by an
   * earlier journal in this process, which no longer holds it. A dead pid is gone.
   *
   * ⚠ Stated cost: the operating system reuses pids, so a dead owner whose pid now names an
   * unrelated process reads as alive, and its jobs are reported killed only once that pid ends too.
   * The failure is a LATE report, never a false one about a live job.
   */
  const ownedElsewhere = (row: JournalRow): boolean => {
    const owner = row.owner;
    if (owner === undefined || owner.instance === instance) return false;
    if (owner.pid === pid) return false;
    return isAlive(owner.pid);
  };

  const readOnce = (): void => {
    if (loaded) return;
    loaded = true;
    const disk = readDisk();
    if (!disk) return;
    startupOrphans = disk.filter((row) => row.owner?.instance !== instance && !ownedElsewhere(row));
  };

  /**
   * Rewrite the file as: every row another live process owns, plus this journal's own rows.
   *
   * The whole read/merge/rewrite now runs under the shared JSON transaction lock. The previous
   * merge-before-write narrowed the race but could still have two processes read the same snapshot
   * and overwrite each other's new row. Lock acquisition is the mutation order; this journal's
   * rows win same-id conflicts for this mutation, and clear preserves a same-id row another live
   * owner published after us.
   */
  const persist = (): void => {
    try {
      transactionalUpdateJsonSync<JournalFile>(
        path,
        (diskFile) => {
          const merged = new Map<string, JournalRow>();
          for (const value of diskFile?.jobs ?? []) {
            const row = readJournalRow(value);
            if (row !== null && ownedElsewhere(row)) merged.set(row.jobId, row);
          }
          for (const row of rows.values()) merged.set(row.jobId, row);
          return { version: JOB_JOURNAL_VERSION, jobs: [...merged.values()] };
        },
        { validator: isJournalFile, strict: true },
      );
    } catch {
      // Best-effort by construction: the journal only ever IMPROVES the report of a crash, so a
      // full disk or unusable lock must not become a dispatch failure.
    }
  };


  return {
    note(row) {
      readOnce();
      const existing = rows.get(row.jobId);
      // note() also repoints a running walk to its next lane. The starting tree and daemon broker
      // execution are job-wide, so a lane transition must not erase either persisted fact.
      const startingTree = row.startingTree ?? existing?.startingTree;
      const brokerExecution = row.brokerExecution ?? existing?.brokerExecution;
      rows.set(row.jobId, {
        ...row,
        ...(startingTree === undefined ? {} : { startingTree }),
        ...(brokerExecution === undefined ? {} : { brokerExecution }),
        owner: { pid, instance },
      });
      persist();
    },
    noteStartingTree(jobId, tree, scope) {
      readOnce();
      const row = rows.get(jobId);
      if (row === undefined) return;
      // Never persist a truncated start: omitted pre-existing paths would be reported later as
      // false additions. Above the activity bound, absence is the weaker and honest claim.
      if (tree.entries.size > MAX_ACTIVITY_STAT_PATHS) {
        if (row.startingTree !== undefined) {
          delete row.startingTree;
          persist();
        }
        return;
      }
      row.startingTree = {
        prefix: tree.prefix,
        entries: [...tree.entries],
        ...(scope === undefined ? {} : { scope: [...scope] }),
      };
      persist();
    },
    noteBrokerExecution(jobId, execution) {
      readOnce();
      const row = rows.get(jobId);
      if (row === undefined) return;
      // The method is an internal typed seam, but keep the persisted shape canonical anyway.
      row.brokerExecution = { kind: "daemon-v1", executionId: execution.executionId };
      persist();
    },
    clear(jobId) {
      readOnce();
      if (!rows.delete(jobId)) return;
      persist();
    },
    orphans() {
      readOnce();
      // A row this process wrote for a job it still holds is not an orphan; only rows that were
      // already on disk when we arrived, and whose owner is gone, are.
      return startupOrphans;
    },
    foreign(jobId) {
      readOnce();
      if (rows.has(jobId)) return undefined;
      return (readDisk() ?? []).find((row) => row.jobId === jobId && ownedElsewhere(row));
    },
    foreignRows() {
      readOnce();
      return (readDisk() ?? []).filter((row) => !rows.has(row.jobId) && ownedElsewhere(row));
    },
  };
}

function isJournalFile(value: unknown): value is JournalFile {
  return isRecord(value) && value["version"] === JOB_JOURNAL_VERSION && Array.isArray(value["jobs"]);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function readJournalRow(value: unknown): JournalRow | null {
  if (!isRecord(value)) return null;
  if (
    typeof value["jobId"] !== "string" ||
    typeof value["laneId"] !== "string" ||
    typeof value["cwd"] !== "string" ||
    typeof value["startedAt"] !== "number" ||
    (value["spec"] !== undefined && typeof value["spec"] !== "string") ||
    (value["label"] !== undefined && typeof value["label"] !== "string") ||
    (value["owner"] !== undefined && !isOwner(value["owner"]))
  ) {
    return null;
  }

  const row: JournalRow = {
    jobId: value["jobId"],
    laneId: value["laneId"],
    cwd: value["cwd"],
    startedAt: value["startedAt"],
    ...(value["spec"] === undefined ? {} : { spec: value["spec"] }),
    ...(value["label"] === undefined ? {} : { label: value["label"] }),
    ...(value["owner"] === undefined ? {} : { owner: value["owner"] }),
  };
  const startingTree = readStartingTree(value["startingTree"]);
  if (startingTree !== undefined) row.startingTree = startingTree;
  const brokerExecution = readBrokerExecution(value["brokerExecution"]);
  if (brokerExecution !== undefined) row.brokerExecution = brokerExecution;
  return row;
}

function readBrokerExecution(value: unknown): JournalBrokerExecution | undefined {
  if (!isRecord(value)) return undefined;
  if (
    Object.keys(value).length !== 2 ||
    value["kind"] !== "daemon-v1" ||
    typeof value["executionId"] !== "string" ||
    !/^exec-[0-9a-f]{32}$/.test(value["executionId"])
  ) {
    // Optional recovery metadata must not invalidate the whole job row. Falling back to no broker
    // reference is the weaker claim and preserves the pre-D1 killed-job reporting path.
    return undefined;
  }
  return { kind: "daemon-v1", executionId: value["executionId"] };
}

function readStartingTree(value: unknown): JournalStartingTree | undefined {
  if (!isRecord(value) || typeof value["prefix"] !== "string" || !Array.isArray(value["entries"])) {
    return undefined;
  }
  if (value["entries"].length > MAX_ACTIVITY_STAT_PATHS) return undefined;
  const entries: [string, string][] = [];
  for (const pair of value["entries"]) {
    if (
      !Array.isArray(pair) ||
      pair.length !== 2 ||
      typeof pair[0] !== "string" ||
      typeof pair[1] !== "string"
    ) {
      return undefined;
    }
    entries.push([pair[0], pair[1]]);
  }
  const scopeValue = value["scope"];
  if (
    scopeValue !== undefined &&
    (!Array.isArray(scopeValue) || !scopeValue.every((item) => typeof item === "string"))
  ) {
    return undefined;
  }
  return {
    prefix: value["prefix"],
    entries,
    ...(scopeValue === undefined ? {} : { scope: [...scopeValue] as string[] }),
  };
}

function isOwner(value: unknown): value is JournalRow["owner"] {
  return (
    isRecord(value) &&
    typeof value["pid"] === "number" &&
    Number.isSafeInteger(value["pid"]) &&
    value["pid"] > 0 &&
    typeof value["instance"] === "string"
  );
}
