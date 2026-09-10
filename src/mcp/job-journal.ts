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
import { atomicWriteJsonSync, safeReadJsonSync } from "../storage/json-store.js";
import { relayStatePath } from "../state-paths.js";

/** One running job, as the journal records it. */
export interface JournalRow {
  jobId: string;
  laneId: string;
  spec?: string;
  cwd: string;
  startedAt: number;
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
  /** Remove a job that reached a terminal state, or one that never started. */
  clear(jobId: string): void;
  /** Rows present at STARTUP — i.e. jobs a previous process died holding. */
  orphans(): JournalRow[];
}

/** A journal that records nothing. The default under vitest, and for an embedder that declines one. */
export const nullJobJournal: JobJournal = {
  note: () => {},
  clear: () => {},
  orphans: () => [],
};

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
export function createJobJournal(path: string = jobJournalPath()): JobJournal {
  const rows = new Map<string, JournalRow>();
  let loaded = false;
  let startupOrphans: JournalRow[] = [];

  const readOnce = (): void => {
    if (loaded) return;
    loaded = true;
    // ⚠ The option is spelled `validator`, and it was written as `validate` first — a misspelling
    // that made the guard INERT, so a wrong-version file loaded as if it had passed. `safeReadJson`
    // had no such option, so the call silently read whatever JSON was there. `test/mcp-restart-
    // report.test.ts` caught it (the corrupt-JSON case passed regardless — `JSON.parse` throws on
    // its own — and only the version-99 case distinguished); `tsc` reports it too, as TS2561.
    const parsed = safeReadJsonSync<JournalFile>(path, {
      validator: (v): v is JournalFile =>
        isRecord(v) && v["version"] === JOB_JOURNAL_VERSION && Array.isArray(v["jobs"]),
    });
    if (!parsed) return;
    startupOrphans = parsed.jobs.filter(isJournalRow);
  };

  const flush = (): void => {
    try {
      atomicWriteJsonSync(path, { version: JOB_JOURNAL_VERSION, jobs: [...rows.values()] });
    } catch {
      // Best-effort by construction: the journal only ever IMPROVES the report of a crash, so a
      // full disk must not become a dispatch failure. The property it protects is stated in
      // `describeJob` when a survivor or an orphan exists — never inferred from a write.
    }
  };

  return {
    note(row) {
      readOnce();
      rows.set(row.jobId, row);
      flush();
    },
    clear(jobId) {
      readOnce();
      if (!rows.delete(jobId)) return;
      flush();
    },
    orphans() {
      readOnce();
      // A row this process wrote for a job it still holds is not an orphan; only rows that were
      // already on disk when we arrived are, and they are read once, before any `note`.
      return startupOrphans;
    },
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function isJournalRow(value: unknown): value is JournalRow {
  if (!isRecord(value)) return false;
  return (
    typeof value["jobId"] === "string" &&
    typeof value["laneId"] === "string" &&
    typeof value["cwd"] === "string" &&
    typeof value["startedAt"] === "number" &&
    (value["spec"] === undefined || typeof value["spec"] === "string")
  );
}
