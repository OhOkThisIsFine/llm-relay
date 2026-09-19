/**
 * Running a dispatch lane, and holding the job while it runs.
 *
 * WHY THIS EXISTS — and it is the whole argument for the MCP server. `llm-relay dispatch
 * --next-command` hands the caller a COMMAND. Executing that command correctly is where every
 * measured failure on this machine lives, and the list is long enough that expecting each caller
 * to get it right is the defect:
 *
 * - Three client idle watchdogs abort a long think at ~300 s unless the lane env lifts all three
 *   (`CLAUDE_STREAM_IDLE_TIMEOUT_MS`, `CLAUDE_BYTE_STREAM_IDLE_TIMEOUT_MS`, `API_FORCE_IDLE_TIMEOUT`).
 * - An async `execFile` leaves stdin an OPEN pipe, and `agy` then waits on it until the timeout.
 * - An npm `.cmd` shim needs a shell, and the shell fallback must quote EVERY token or a spaced
 *   argument splits (`codex` saw one prompt as seven arguments).
 * - A console-subsystem child spawned from a console-less parent ALLOCATES a console and steals
 *   the desktop focus, unless `windowsHide` is set.
 * - `claude -p` buffers its whole answer until exit, so an empty log does not mean a dead lane.
 *
 * Every one of those is handled once, here. A caller supplies a task and gets an answer.
 *
 * WHERE THIS RUNS. In the `llm-relay mcp` process, which the HOST launches over stdio — never in
 * the relay daemon. The daemon's rule stands untouched: no HTTP turn causes a lane spawn. This
 * process answers no HTTP at all.
 */
import { exec, execFile, execSync } from "node:child_process";
import { existsSync, statSync } from "node:fs";
import { resolve as resolvePath } from "node:path";
import { quoteCmdArg } from "../lane-probe.js";
import { nullJobJournal, type JobJournal } from "./job-journal.js";
import { jobSeqOf, nullJobArchive, type JobArchive } from "./job-archive.js";
import { classifyLaneProbeOutput, type LaneProbeSpawnResult } from "../lane-quota-probe.js";
import { laneOfRung } from "../lane-manifest.js";
import type { DispatchLaneStatus } from "../dispatch-lane-stats.js";

/** Depth marker written into every child's environment, read back to bound recursion. */
export const DEPTH_ENV = "LLM_RELAY_DISPATCH_DEPTH";

/**
 * How deep a chain of dispatches may go. A lane is itself an agent that can reach this same
 * server, so without a bound a loop is reachable — `agent-dispatch` bounds its own at 3 and this
 * matches it. The value is a ceiling on nesting, not on concurrency.
 */
export const DEFAULT_MAX_DEPTH = 3;

/** Hard ceiling on captured lane output, so one runaway lane cannot exhaust memory. */
export const MAX_OUTPUT_BYTES = 16 * 1024 * 1024;

/** Ceiling on one lane run. agy's own `--print-timeout` convention here is 30 minutes. */
export const DEFAULT_LANE_TIMEOUT_MS = 30 * 60 * 1000;

/**
 * `"timed_out"` is its own terminal status, DISTINCT from `"failed"` (2026-09-03,
 * C:\Code\docs\backlog.md "A bounded llm-relay design dispatch can consume its full 1,200-second
 * wait and return no result"). A killed-by-timeout run used to fall into the same bucket as an
 * ordinary nonzero exit, so a caller reading `status` could not tell "the lane ran and failed"
 * from "the lane never finished" — the two call for different next actions (retry a different
 * lane vs. maybe poll a little longer next time). `complete()` sets it whenever the run result
 * says `timedOut`, ahead of the exit-code/semantic-failure check.
 */
export type JobStatus = "running" | "completed" | "failed" | "cancelled" | "timed_out" | "killed";

/**
 * The four states `LaneJobStore.complete()`/`cancel()` can put a job into — `"running"` is the
 * only non-terminal member of `JobStatus`. Exported so a rendering test can iterate every
 * terminal status the store actually knows, rather than hand-copying the list a second time.
 */
export const TERMINAL_JOB_STATUSES = [
  "completed",
  "failed",
  "cancelled",
  "timed_out",
  /**
   * ⚠ `"killed"` joined on 2026-09-10 and it is NOT a synonym for `"failed"`. A lane killed by its
   * own MCP server restarting is not a lane that failed — nothing was learned about the lane, and
   * the caller's next action is different (re-dispatch from scratch, and expect nothing on disk).
   * It is reachable ONLY from the journal, so a single-server run can never produce it.
   */
  "killed",
] as const satisfies readonly JobStatus[];

export type TerminalJobStatus = (typeof TERMINAL_JOB_STATUSES)[number];

/**
 * Terminal statuses worth reporting as lane telemetry: every terminal status but `cancelled` and
 * `killed` — a caller cancellation is not lane evidence, so it is discarded, never reported. Keyed as a `Record` over `Exclude<…, "cancelled">` so a NEW terminal status is
 * a compile error HERE, at the classifier, rather than a silent drop at the forwarder (the
 * closed-union gotcha in CLAUDE.md); the forwarder ranges over this list, never a hand copy.
 */
const REPORTABLE_JOB_STATUS_MAP: Record<Exclude<TerminalJobStatus, "cancelled" | "killed">, true> = {
  completed: true,
  failed: true,
  timed_out: true,
};
export type ReportableJobStatus = keyof typeof REPORTABLE_JOB_STATUS_MAP;
export const REPORTABLE_JOB_STATUSES = Object.freeze(
  Object.keys(REPORTABLE_JOB_STATUS_MAP) as ReportableJobStatus[],
);

/**
 * Narrowing guard over `REPORTABLE_JOB_STATUSES` — the forwarder ranges over the list
 * through this, so the statuses stay narrowed past the check (a bare `.includes` would
 * not narrow, and the report below needs the `cancelled`/`running` members gone).
 */
export function isReportableJobStatus(status: JobStatus): status is ReportableJobStatus {
  return (REPORTABLE_JOB_STATUSES as readonly JobStatus[]).includes(status);
}

/**
 * The relay's own response headers that announce what happened during an answer-mode HTTP call —
 * the direct-fetch sibling of the provenance every spawned-lane answer already carries (lane id,
 * spec, elapsed). Only these five, allow-list style: never the whole `Headers` object, and NEVER
 * read at all on a non-2xx response (a failure carries status + a bounded body excerpt, not
 * headers — see `runAnswerFetch`).
 */
export interface RelayAnnouncements {
  servedBy?: string;
  poolAttempts?: string;
  hedged?: string;
  latencyDemoted?: string;
  degraded?: string;
}

/**
 * "skipped" — a rung the walk never started at all, because it was already at its configured
 * `maxConcurrent` cap when its turn in the ladder came (backlog item "a per-lane CONCURRENCY cap
 * on cli dispatch rungs", 2026-09-09).
 *
 * ⚠ Deliberately NOT a member of `DispatchLaneStatus`. That type is what a settled RUN is reported
 * to the daemon as (`DispatchedTelemetryReport.status`, validated by `routes/admin.ts`'s pin/demote
 * and failure-kind total tables, and folded into `dispatch-lane-stats.json`'s wall-clock window by
 * `recordLaneRun`), and a skipped rung never ran — "spawn nothing … report no telemetry for it,
 * nothing ran" is the brief's whole point. Widening the REPORTED vocabulary to include a state
 * nothing ever reports would be exactly the closed-union defect CLAUDE.md warns about: a member
 * reachable only in theory, decided nowhere real.
 */
export const SKIPPED_LANE_STATUS = "skipped" as const;

/**
 * Every state one WALK ATTEMPT can end in — `LaneAttempt.status`'s own closed union, strictly wider
 * than `DispatchLaneStatus` by the one member above. The two unions describe different questions
 * (this one is "what happened to this attempt in THIS job's record"; `DispatchLaneStatus` is "what
 * does the daemon's persisted lane history say"), so they are two types on purpose rather than one
 * reused for both.
 */
export type LaneAttemptStatus = DispatchLaneStatus | typeof SKIPPED_LANE_STATUS;

/**
 * Did this attempt actually run a lane, or was it skipped before any process started? Total over
 * `LaneAttemptStatus` (`const _never: never` below), so a future member — whether added here or
 * inherited from a `DispatchLaneStatus` that grows — is a compile error at this switch rather than
 * a silent "counts as tried" default (the closed-union gotcha in CLAUDE.md). `mcp/server.ts` uses
 * it to keep a walk's terminal "N tried" message honest when every remaining lane was capped rather
 * than actually attempted — a skipped rung "counts as NOT TRIED" per the backlog item's own wording.
 */
export function attemptWasTried(status: LaneAttemptStatus): boolean {
  switch (status) {
    case "completed":
    case "failed":
    case "timed_out":
    case "abandoned":
      return true;
    case SKIPPED_LANE_STATUS:
      return false;
    default: {
      const _never: never = status;
      return _never;
    }
  }
}

/**
 * One lane a dispatch WALK tried, in the order it tried them.
 *
 * ⚠ Its `status` is a `LaneAttemptStatus`, IMPORTED rather than restated — see that type's own
 * doc comment for why it is not simply `DispatchLaneStatus`. Two hand-written copies of one closed
 * set is the most-repeated defect in this repository's history, and here the type additionally buys
 * a guarantee: that union has no `cancelled` member, so "a caller cancellation is never reported as
 * lane evidence" becomes a property the compiler enforces at every call site rather than a runtime
 * check somebody can forget.
 */
export interface LaneAttempt {
  laneId: string;
  spec: string | undefined;
  status: LaneAttemptStatus;
  /** Wall clock for THIS attempt, not for the walk. Always 0 for a `"skipped"` attempt — nothing
   *  ran, so there is no duration to report, the same rule an `"abandoned"` run's OWN duration
   *  is withheld from `dispatch-lane-stats.ts`'s persisted window for. */
  elapsedMs: number;
  /** Why the attempt ended this way, when it did not succeed. */
  reason?: string;
}

/**
 * The status one lane attempt earns. Shares its PRIORITY ORDER with `LaneJobStore.complete()`
 * below, and `test/mcp-server.test.ts` pins that the two agree — they cannot share one
 * implementation because `complete()` maps onto `JobStatus`, which describes the WALK, while this
 * maps onto `DispatchLaneStatus`, which describes one lane.
 *
 * ⚠ `abandoned` is tested FIRST, ahead of `timedOut`. A lane the walk kills at its budget usually
 * reports `timedOut` from the killed child as well, and between the two the walk's own decision is
 * the MORE SPECIFIC claim: the relay knows it stopped this lane after N seconds, whereas the
 * child's timeout flag would report it as having exhausted a ceiling it never reached.
 */
export function classifyLaneAttempt(
  run: LaneRunResult,
  // `| undefined` on both, deliberately: this repository compiles with
  // `exactOptionalPropertyTypes`, and every caller builds these from values that are genuinely
  // absent sometimes. Widening here beats making each call site spread conditionally.
  opts: { abandoned?: boolean | undefined; semanticFailure?: string | undefined } = {},
): DispatchLaneStatus {
  if (opts.abandoned === true) return "abandoned";
  if (run.timedOut) return "timed_out";
  return run.code === 0 && opts.semanticFailure === undefined ? "completed" : "failed";
}

export interface LaneJob {
  id: string;
  status: JobStatus;
  /**
   * Ladder rung this job is running NOW. A walk repoints it as it advances, so a `dispatch_status`
   * poll always names the lane currently doing the work; `attempts` holds the ones already tried.
   */
  laneId: string;
  /** What the rung addresses (`pool/high`, `agy`, …), when it names one. */
  spec: string | undefined;
  /**
   * Every lane this job tried, oldest first. Empty for a job that never advanced past its first
   * lane and is still running; one entry for an ordinary single-lane dispatch that settled.
   *
   * ⚠ The JOB is the WALK, not one lane, and this field is what makes that legible. The walk
   * cannot finish inside one blocking call — the measured client tool-call ceiling on this machine
   * is between 45 s and 100 s, and above it the call fails AND destroys the job handle — so it
   * continues in the background behind ONE handle. Re-pointing the handle at each new lane instead
   * would break polling outright.
   */
  attempts: LaneAttempt[];
  /**
   * Selectable lanes the walk's `maxLanes` bound kept it from trying. Absent when it tried
   * everything the ladder offered — see `LaneJobStore.noteWalkScope`.
   */
  lanesNotTried?: number;
  /**
   * Whether this job ran as a WALK at all, or as the single pre-walk lane
   * (`routing.dispatchWalk: false`).
   *
   * ⚠ It exists because a renderer cannot tell those apart from `attempts` alone: a walk that
   * legitimately exhausted a one-rung ladder and a walk-disabled dispatch that tried its one lane
   * produce the same record. Saying "every lane has been tried" for the second is false, and it
   * also breaks the documented promise that `dispatchWalk: false` restores the pre-walk behaviour
   * exactly — the pre-walk answer carried no such advice at all.
   */
  walkEnabled?: boolean;
  /**
   * The caller NAMED what to run — a `lane` override, or a `model` run as its own one-lane view —
   * so the walk ran exactly one lane on purpose. `jobAnswer` then says that only that lane ran:
   * "every dispatch lane has now been tried" would be false there, and it tells an autonomous
   * caller to stop delegating altogether (measured 2026-09-10 on jobs 0023 and 0024).
   */
  forcedLane?: boolean;
  /**
   * How long the lane now running usually takes to ANSWER in this dispatch's mode, from that
   * lane's own completed runs — rendered on every poll so a caller can tell a slow lane from a
   * stuck one. 23 of the 182 unanswered dispatches in the 2026-09-10 transcript sweep ended with
   * the caller simply no longer polling. Absent when the lane has no completed run on record.
   */
  expected?: { medianMs: number | null; p80Ms: number | null; samples: number };
  startedAt: number;
  endedAt: number | undefined;
  exitCode: number | null;
  stdout: string;
  stderr: string;
  timedOut: boolean;
  cwd: string;
  /** Set only when the run failed before or during the spawn. */
  error: string | undefined;
  /** Set only for an answer-mode job whose relay response reached the 2xx branch. */
  relay?: RelayAnnouncements;
  /** Set when the job's dispatch view came from a fallback rather than the live daemon. */
  dispatchSource?: "daemon" | "fallback";
  /**
   * What this dispatcher started for this job, and what became of it — written once, when the job
   * reaches a terminal state. See `LaneProcessReport`.
   */
  process?: LaneProcessReport;
  /**
   * What the lane now running has produced so far, and when it last produced anything — so a poll
   * can say how long a lane has been SILENT (`docs/backlog.md`: a Muse Spark lane logged a stream
   * error in its first second, produced nothing more, and read `running` for nine minutes with
   * nothing on the status to distinguish it from a lane still thinking). Present only while a
   * SPAWNED attempt runs; an answer-mode call has no output stream and carries none.
   */
  activity?: LaneActivity;
  /**
   * This record was read back from the archive after an MCP server restart: the job ended in a
   * previous process, and its report is exactly what that process wrote (`job-archive.ts`).
   */
  restored?: boolean;
  /** The first line of the task, cut short (`taskLabel`), so a job can be recognised in a list. */
  label?: string;
  /**
   * The read-only TOOL binding applied to the lane now running (`readonly-boundary.ts`
   * `readOnlyInvoke`). Replaced per lane, like `expected`; absent for an ordinary dispatch.
   */
  readOnly?: { laneId: string; binding: string };
  /**
   * What the launcher changed before the lane now running started (`prepareLaneLaunch`): an
   * environment value expanded or removed, or the working directory given to AGY. Names only, never
   * a value. Replaced per lane, like `readOnly`; absent when the launcher changed nothing.
   */
  launch?: string[];
  /**
   * What the job changed in its git working tree, rendered (`tree-delta.ts`): set once, when the job
   * ends, for an agent-mode job whose cwd is in a git work tree. Report only.
   */
  treeDelta?: string;
  /**
   * The newest activity the walk saw for the lane now running (relay traffic, output, owned
   * process CPU, or a file change), with its source. Replaced per lane; the walk stops a lane when this is older than
   * `routing.dispatchWalk.idleMs`.
   */
  lastActive?: { at: number; source: string };
}

/**
 * Output progress of the attempt now running. Byte counts and timestamps only — never the bytes.
 *
 * ⚠ Silence is REPORTED here, never acted on. `claude -p` — the transposed `cliLane` form every
 * `relay` rung takes in agent mode, i.e. the free pool itself — buffers its whole answer until
 * exit (module header), so "zero bytes after N seconds" is the ordinary shape of a healthy run on
 * the most-used lane. A threshold that killed on it would manufacture the false failure the backlog
 * item names as worse than a slow honest status. The figure lets the CALLER decide, which is the
 * property's second branch.
 */
export interface LaneActivity {
  /** When the running attempt was spawned. */
  attemptStartedAt: number;
  /** When the lane last wrote anything to either stream; null while it has written nothing. */
  lastOutputAt: number | null;
  stdoutBytes: number;
  stderrBytes: number;
}

/**
 * The record of one job's OWNED processes, written at the moment the job goes terminal.
 *
 * ⚠ It exists because ownership is the only reliable signal. A stale lane and a slow lane are
 * indistinguishable from the outside (`docs/backlog.md`: one legitimately ran 29 minutes), so a
 * rule based on age would eventually kill a live lane — which is why the dispatcher terminates what
 * IT started, and why what it started is enumerable by job id rather than by hand.
 *
 * `survivors` is the honest half: a termination that did not take is REPORTED, never assumed away.
 * `terminated: false` means no process was ever registered for this job (a pre-spawn failure, or an
 * answer-mode job whose direct HTTP call owns no OS process), and is distinct from `pids: []` with
 * `terminated: true` — the first says "nothing of ours ran", the second says "ours ran and is gone".
 */
export interface LaneProcessReport {
  /** Root pids this dispatcher started for the job. */
  pids: number[];
  /** Pids still alive after termination was attempted. */
  survivors: number[];
  /** Whether a termination was attempted at all. */
  terminated: boolean;
}

/** What a completed run looks like to a caller. */
export interface LaneRunResult {
  code: number | null;
  stdout: string;
  stderr: string;
  timedOut: boolean;
}

/**
 * A lane can exit 0 (agent mode) or answer HTTP 200 (answer mode) with text that is
 * syntactically nonempty but carries nothing usable — a lone `#`, a bare `---`, a block of
 * `***`. The pre-existing check caught only the LITERALLY empty string, which a scaffold-only
 * fragment slips past (C:\Code\docs\backlog.md: a 652-second review returned only `#`).
 *
 * Deliberately STRUCTURAL, not semantic: it strips whitespace, punctuation and Markdown
 * scaffolding characters and asks only whether anything ALPHANUMERIC remains — it does not judge
 * whether the content actually answers the task, which would cross this repo's own repair
 * boundary ("routing comes from config and deterministic classification, never from an LLM's
 * opinion inserted into the request path"). `isContentEmpty("Here is")` is `false`: a generic
 * lead-in with nothing after it is a real judgement call this predicate refuses to make. `"OK"`
 * and `"42"` must both read as content, and do.
 */
export function isContentEmpty(text: string): boolean {
  return text.replace(/[\s#*_\-|>`~=]/g, "").length === 0;
}

/**
 * The distinct failure reason both dispatch modes report for a content-empty result — a single
 * string constant so `describeJob`'s `error:` line and any caller-side matching agree on the
 * literal token, rather than each spelling it out separately.
 */
export const EMPTY_OUTPUT_REASON = "empty-output: the lane's output has no usable content after stripping formatting";

const ENV_REFERENCE = /%([A-Za-z_][A-Za-z0-9_()]*)%/g;
const WHOLE_ENV_REFERENCE = /^%[A-Za-z_][A-Za-z0-9_()]*%$/;

/**
 * Expand the `%NAME%` references a Windows environment value still holds (`docs/backlog.md`: a lane
 * inherited `HOME=%USERPROFILE%` literally, and a child that honours `HOME` wrote into a directory
 * named `%USERPROFILE%`). A reference expands from the SAME environment, looked up without case as
 * Windows does, in one pass. A value that is ONE unresolved reference is removed, because the literal
 * is never a usable value. An unresolved reference inside a longer value (a `PATH` entry) stays: removing
 * the whole value would lose the parts that are real. Windows only — `%` has no meaning to a POSIX
 * shell, and a POSIX value that holds one is data.
 *
 * Returns the notes `LaneJobStore.noteLaunch` records: variable and reference NAMES, never a value.
 */
export function expandEnvReferences(
  env: NodeJS.ProcessEnv,
  platform: NodeJS.Platform = process.platform,
): { env: NodeJS.ProcessEnv; notes: string[] } {
  if (platform !== "win32") return { env, notes: [] };
  const lookup = new Map<string, string>();
  for (const [name, value] of Object.entries(env)) {
    if (typeof value === "string") lookup.set(name.toUpperCase(), value);
  }
  const out: NodeJS.ProcessEnv = { ...env };
  const notes: string[] = [];
  for (const [name, value] of Object.entries(env)) {
    if (typeof value !== "string" || !value.includes("%")) continue;
    if (WHOLE_ENV_REFERENCE.test(value) && !lookup.has(value.slice(1, -1).toUpperCase())) {
      delete out[name];
      notes.push(`${name} removed (${value} does not resolve)`);
      continue;
    }
    const expanded = new Set<string>();
    const next = value.replace(ENV_REFERENCE, (token: string, ref: string) => {
      const found = lookup.get(ref.toUpperCase());
      if (found === undefined) return token;
      expanded.add(token);
      return found;
    });
    if (expanded.size === 0) continue;
    out[name] = next;
    notes.push(`${name} expanded from ${[...expanded].join(", ")}`);
  }
  return { env: out, notes };
}

type LaneInvoke = { command: string; args: string[]; env?: Record<string, string | null> };

/**
 * Give an AGY lane the caller's working directory (`docs/backlog.md`: AGY works in its own scratch
 * directory whatever `cwd` its process gets, so a lane asked to edit a worktree saw none of its
 * files). AGY reads a directory only through `--add-dir`, so the directory goes on the command line,
 * and the task text names it. Null for every other lane.
 *
 * The prompt is the argument after AGY's own `-p`; a rung with no `-p` gets `--add-dir` alone. An
 * `--add-dir` the rung already declares for the same directory is not repeated.
 */
export function agyWorkingDirInvoke<T extends LaneInvoke>(
  invoke: T,
  cwd: string,
): { invoke: T; note: string } | null {
  const rung = laneOfRung(invoke.command, invoke.args);
  if (rung?.lane !== "agy") return null;
  const args = [...invoke.args];
  const start = rung.binary === invoke.command ? 0 : args.indexOf(rung.binary) + 1;
  const prompt = args.indexOf("-p", start);
  if (prompt >= 0 && prompt + 1 < args.length) {
    args[prompt + 1] = `Work in this directory: ${cwd}\n\n${args[prompt + 1]}`;
  }
  const target = samePathKey(cwd);
  const declared = args.some(
    (a, i) =>
      (a === "--add-dir" && args[i + 1] !== undefined && samePathKey(args[i + 1] as string) === target) ||
      (a.startsWith("--add-dir=") && samePathKey(a.slice("--add-dir=".length)) === target),
  );
  if (!declared) args.push("--add-dir", cwd);
  return { invoke: { ...invoke, args }, note: `agy works in ${cwd} (--add-dir)` };
}

function samePathKey(path: string): string {
  const resolved = resolvePath(path).replace(/\\/g, "/");
  return process.platform === "win32" ? resolved.toLowerCase() : resolved;
}

export interface DispatchedQuotaReport {
  laneId: string;
  tier: string | undefined;
  outcome: "rate_limited" | "quota_exhausted";
  retryAfterMs?: number;
}

/**
 * Classify only positive quota evidence from a dispatched lane. Nonzero results use the same
 * fail-safe classifier as probes. Exit-zero AGY JSON is special-cased because AGY can encode an
 * error in its envelope; answer prose is never searched.
 */
export function classifyDispatchedResult(input: {
  result: LaneRunResult;
  laneId: string;
  tier: string | undefined;
  command: string;
  args: readonly string[];
}): DispatchedQuotaReport | undefined {
  const { result } = input;
  if (result.timedOut) return undefined;
  // A signal-terminated child has no process verdict. Its buffered output may be partial or stale,
  // so it cannot establish quota evidence even when the fragment resembles a structured envelope.
  if (result.code === null) return undefined;
  if (result.code !== null && result.code !== 0) {
    const verdict = classifyLaneProbeOutput(result as LaneProbeSpawnResult);
    if (verdict.kind !== "exhausted") return undefined;
    return {
      laneId: input.laneId,
      tier: input.tier,
      outcome: verdict.outcome,
      ...(verdict.retryAfterMs === null ? {} : { retryAfterMs: verdict.retryAfterMs }),
    };
  }
  if (laneOfRung(input.command, input.args)?.lane !== "agy") return undefined;
  let envelope: unknown;
  try {
    envelope = JSON.parse(result.stdout);
  } catch {
    return undefined;
  }
  if (!isRecord(envelope)) return undefined;
  const status = envelope["status"];
  const errorText = errorPayloadText(envelope);
  const exactSentinel = errorText.includes("Individual quota reached");
  if (status !== "SUCCESS" && !errorText) return undefined;
  // A successful envelope is trusted only for the one vendor sentinel. In particular, do not
  // treat a successful answer (or incidental metadata) mentioning quota as evidence.
  if (status === "SUCCESS" && !exactSentinel) return undefined;
  if (!exactSentinel && !errorText) return undefined;
  const verdict = classifyLaneProbeOutput({
    code: 1,
    stdout: errorText,
    stderr: "",
    timedOut: false,
  });
  if (verdict.kind !== "exhausted") return undefined;
  return {
    laneId: input.laneId,
    tier: input.tier,
    outcome: verdict.outcome,
    ...(verdict.retryAfterMs === null ? {} : { retryAfterMs: verdict.retryAfterMs }),
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

/** Read structured error fields only; deliberately excludes answer/result/content prose. */
function errorPayloadText(value: Record<string, unknown>): string {
  const parts: string[] = [];
  for (const key of ["error", "errors", "message", "statusMessage", "errorMessage"]) {
    const field = value[key];
    if (typeof field === "string") parts.push(field);
    else if (Array.isArray(field)) parts.push(...field.filter((x): x is string => typeof x === "string"));
    else if (isRecord(field)) {
      for (const nested of ["message", "error", "code", "detail"]) {
        if (typeof field[nested] === "string") parts.push(field[nested] as string);
      }
    }
  }
  return parts.join("\n");
}

export interface LaneSpawnOptions {
  env: NodeJS.ProcessEnv;
  cwd: string;
  timeoutMs: number;
  /**
   * Called for every chunk the child writes to either stream, with the chunk's SIZE — the bytes
   * themselves stay in the exec buffer that becomes `LaneRunResult`. Optional so every existing
   * caller and test double is unchanged; the store's silence figure is fed from it.
   */
  onOutput?: ((chunk: { stream: "stdout" | "stderr"; bytes: number }) => void) | undefined;
}

/**
 * The spawn seam. Injected so the suite can exercise every path without spending real lane quota —
 * the same discipline `lane-quota-probe.ts` applies, and the reason its default spawner refuses to
 * run under vitest.
 */
/**
 * What the store needs in order to REAP what a job owns and to report it: a way to stop it, and a
 * way to name what it started.
 *
 * ⚠ Narrower than a spawn handle on purpose. `startLane` wraps the spawner's promise in its own
 * outcome promise, so the value the walk registers is NOT a `LaneSpawnHandle` — typing this seam as
 * one would have forced the walk to register something other than what it actually holds.
 */
export interface OwnedProcess {
  /**
   * Terminate the process TREE this spawn started. Idempotent, and safe to call after the child has
   * already exited — the descendants are the whole reason it exists.
   */
  kill: () => void;
  /**
   * The root pids this spawn started, read LAZILY.
   *
   * ⚠ A thunk, not a number: the Windows shell fallback REPLACES the root process (an npm `.cmd`
   * shim answers ENOENT and the real child is spawned through `exec`), so the pid is only knowable
   * after the fact. Optional, so a hand-written test double that owns no OS process can omit it.
   */
  pids?: () => number[];
}

export interface LaneSpawnHandle extends OwnedProcess {
  result: Promise<LaneRunResult>;
}

export type LaneSpawner = (
  command: string,
  args: readonly string[],
  opts: LaneSpawnOptions,
) => LaneSpawnHandle;

type LaneExecError = Error & { killed?: boolean | undefined; code?: unknown };

/** Terminate a full process tree (on Windows via taskkill /T /F, on POSIX via process group / signal). */
export function terminateProcessTree(pid: number, platform: NodeJS.Platform = process.platform): void {
  if (typeof pid !== "number" || !Number.isSafeInteger(pid) || pid <= 0) return;
  if (platform === "win32") {
    try {
      execSync(`taskkill /pid ${pid} /T /F`, { windowsHide: true, stdio: "ignore" });
    } catch {
      // Process may already have terminated.
    }
  } else {
    try {
      process.kill(-pid, "SIGKILL");
    } catch {
      try {
        process.kill(pid, "SIGKILL");
      } catch {
        // Process may already have terminated.
      }
    }
  }
}

/** A readable the spawner can watch for progress; the `data` event is all it subscribes to. */
export interface LaneOutputStream {
  on: (event: "data", listener: (chunk: string | Buffer) => void) => unknown;
}

/** The small child-process surface the lane spawner needs. */
export interface LaneChildProcess {
  pid?: number | undefined;
  stdin: { end: () => void } | null | undefined;
  /**
   * Optional, so a test double that models no streams is unchanged. When present, the spawner
   * subscribes for `onOutput` ALONGSIDE `execFile`'s own buffering listener — a second `data`
   * listener never consumes what the first collects, so `LaneRunResult` is byte-identical.
   */
  stdout?: LaneOutputStream | null | undefined;
  stderr?: LaneOutputStream | null | undefined;
  kill: () => boolean;
}

/** Subscribe `onOutput` to both of a child's streams, when the child exposes them. */
function observeOutput(child: LaneChildProcess, onOutput: LaneSpawnOptions["onOutput"]): void {
  if (!onOutput) return;
  const size = (chunk: string | Buffer): number => (typeof chunk === "string" ? Buffer.byteLength(chunk) : chunk.length);
  const watch = (stream: "stdout" | "stderr"): void => {
    const s = child[stream];
    if (!s) return;
    try {
      s.on("data", (chunk) => {
        try {
          onOutput({ stream, bytes: size(chunk) });
        } catch {
          // A progress observer must never fail the lane it observes.
        }
      });
    } catch {
      // A stream that cannot be observed leaves the figure absent, never a crashed spawn.
    }
  };
  watch("stdout");
  watch("stderr");
}

/** Spawn options common to the direct and Windows shell-fallback paths. */
export interface LaneExecOptions {
  encoding: "utf8";
  maxBuffer: number;
  timeout: number;
  windowsHide: true;
  env: NodeJS.ProcessEnv;
  cwd: string;
}

export type LaneExecCallback = (
  err: LaneExecError | null,
  stdout: string,
  stderr: string,
) => void;

/** Injectable process boundary: tests prove the real spawn contract without launching a lane. */
export interface LaneProcessApi {
  platform: NodeJS.Platform;
  execFile: (
    command: string,
    args: string[],
    opts: LaneExecOptions,
    callback: LaneExecCallback,
  ) => LaneChildProcess;
  exec: (
    command: string,
    opts: LaneExecOptions,
    callback: LaneExecCallback,
  ) => LaneChildProcess;
}

const nodeProcessApi: LaneProcessApi = {
  platform: process.platform,
  execFile: (command, args, opts, callback) => execFile(command, args, opts, callback),
  exec: (command, opts, callback) => exec(command, opts, callback),
};

/**
 * The real spawner.
 *
 * ⚠ Every guard here answers a measured failure; read the module header before removing one.
 * It never rejects — a failure becomes a result the caller can report, because a lane that died
 * is information, not an exception.
 *
 * ⚠ Refuses to spawn under vitest unless the suite injects its own seam. Same rule as
 * `winenv.ts`, `os-keyring.ts` and `lane-quota-probe.ts`: a test run must never spend real quota
 * or touch the operator's live agent sessions.
 */
export function createLaneSpawner(
  processApi: LaneProcessApi,
  hostEnv: NodeJS.ProcessEnv = process.env,
): LaneSpawner {
  return (command, args, opts) => {
    if (hostEnv["VITEST"]) {
      return {
        result: Promise.resolve({
          code: null,
          stdout: "",
          stderr: "lane spawns are disabled under vitest — inject a spawner",
          timedOut: false,
        }),
        kill: () => {},
      };
    }

    const execOpts: LaneExecOptions = {
      encoding: "utf8",
      maxBuffer: MAX_OUTPUT_BYTES,
      timeout: opts.timeoutMs,
      // ⚠ A console-subsystem child (agy.exe, codex's shim) makes Windows allocate a console when the
      // parent has none, and that console steals the desktop focus. The MCP server is launched by a
      // host that usually has no console, so this flag is not optional here.
      windowsHide: true,
      env: opts.env,
      cwd: opts.cwd,
    };

    let child: LaneChildProcess | undefined;
    let killed = false;

    const result = new Promise<LaneRunResult>((resolve) => {
      const settle = (
        err: LaneExecError | null,
        stdout: string,
        stderr: string,
      ): void => {
        if (!err) {
          resolve({ code: 0, stdout, stderr, timedOut: false });
          return;
        }
        resolve({
          code: typeof err.code === "number" ? err.code : null,
          stdout,
          stderr: stderr ? stderr : err.message,
          timedOut: err.killed === true,
        });
      };

      child = processApi.execFile(command, args as string[], execOpts, (err, stdout, stderr) => {
        if (!err) {
          resolve({ code: 0, stdout, stderr, timedOut: false });
          return;
        }
        // An npm `.cmd` shim is not directly executable; Windows answers ENOENT. Retry through the
        // shell, quoting every token — see `quoteCmdArg`.
        if (processApi.platform === "win32" && err.code === "ENOENT" && !killed) {
          const line = `${quoteCmdArg(command)} ${args.map(quoteCmdArg).join(" ")}`;
          const fallback = processApi.exec(line, execOpts, (err2, stdout2, stderr2) => {
            settle(err2, stdout2 ?? "", stderr2 ?? "");
          });
          child = fallback;
          // ⚠ Same stdin rule as the direct spawn below.
          fallback.stdin?.end();
          observeOutput(fallback, opts.onOutput);
          return;
        }
        settle(err, stdout ?? "", stderr ?? "");
      });

      // ⚠ An async execFile leaves stdin an OPEN pipe. `agy` reads stdin, finds no EOF, and produces
      // zero bytes until the timeout kills it. Measured live; the synchronous form hid it.
      child.stdin?.end();
      observeOutput(child, opts.onOutput);
    });

    return {
      result,
      kill: () => {
        killed = true;
        if (child?.pid) {
          terminateProcessTree(child.pid, processApi.platform);
        }
        child?.kill();
      },
      // ⚠ Read lazily, and that is load-bearing rather than tidy: the ENOENT fallback above REPLACES
      // `child` with the shell-spawned process, so a pid captured at spawn time would name the shim
      // that never ran. Whatever root the spawn settled on is what a reaper must terminate.
      pids: () => (child?.pid === undefined ? [] : [child.pid]),
    };
  };
}

export const defaultLaneSpawner: LaneSpawner = createLaneSpawner(nodeProcessApi);

/**
 * The answer-mode HTTP seam — a direct POST to the running relay's own `/v1/messages`,
 * bypassing a spawned harness entirely for a `relay`-kind rung. Typed as `typeof fetch` (this
 * repo's established convention — `backend.ts`, `catalog.ts`, `key-checker.ts`, `reshaper.ts` all
 * inject the real global `fetch` this same way), so a test can hand it a fake built from the
 * real `Response` constructor exactly as those modules' tests already do.
 *
 * Injected for the same reason `LaneSpawner` is, and guarded the same way: this process is
 * launched by a host that may be running on a machine whose OWN `llm-relay` daemon is live on
 * its default port, so an accidentally-unmocked call here would not spend a lane's OWN quota (the
 * spawner's concern) but would reach a REAL locally-running relay and spend a REAL provider's.
 * `createAnswerFetch` copies the `LaneSpawner` guard pattern exactly: under vitest, refuse unless
 * the caller injects its own seam.
 */
export type AnswerFetch = typeof fetch;

export function createAnswerFetch(hostEnv: NodeJS.ProcessEnv = process.env): AnswerFetch {
  if (hostEnv["VITEST"]) {
    return (async () => {
      throw new Error("answer-mode HTTP calls are disabled under vitest — inject deps.fetch");
    }) as AnswerFetch;
  }
  return fetch;
}

export const defaultAnswerFetch: AnswerFetch = createAnswerFetch();

/**
 * Where this relay itself is listening, for the answer-mode HTTP call. Deliberately a tiny local
 * copy of `cli.ts`'s `proxyUrl` rather than an import of it: `cli.ts` already imports
 * `McpDispatchServer` from this module's sibling, and importing back would create the first
 * import cycle between `cli.ts` and `mcp/`, for two lines neither side is likely to drift on.
 */
export function relayLoopbackUrl(config: { host: string; port: number }, path: string): string {
  const host = config.host.includes(":") ? `[${config.host}]` : config.host;
  return `http://${host}:${config.port}${path}`;
}

/**
 * The relay's own response headers that announce what happened, read allow-list style — never
 * the whole `Headers` object — into an answer-mode job's provenance. Absent header ⇒ absent key,
 * never an empty string, so `describeJob` renders a line only when the relay actually said
 * something.
 */
const RELAY_ANNOUNCEMENT_HEADERS = {
  servedBy: "x-llm-relay-served-by",
  poolAttempts: "x-llm-relay-pool-attempts",
  hedged: "x-llm-relay-hedged",
  latencyDemoted: "x-llm-relay-latency-demoted",
  degraded: "x-llm-relay-degraded",
} as const satisfies Record<keyof RelayAnnouncements, string>;

export function readRelayAnnouncements(headers: Headers): RelayAnnouncements {
  const out: RelayAnnouncements = {};
  for (const [key, header] of Object.entries(RELAY_ANNOUNCEMENT_HEADERS) as [keyof RelayAnnouncements, string][]) {
    const value = headers.get(header);
    if (value) out[key] = value;
  }
  return out;
}

/**
 * The pids a spawn handle owns, read through the lazy thunk and bounded to sane values.
 *
 * A handle from a test double (or an answer-mode job, which owns no OS process at all) reports
 * none, and a garbage pid is dropped rather than probed — `process.kill(0, 0)` signals the whole
 * process group on POSIX, so a `0` that survived the spawn path would be the worst possible input.
 */
function readOwnedPids(handle: OwnedProcess | undefined): number[] {
  if (handle?.pids === undefined) return [];
  let raw: number[];
  try {
    raw = handle.pids();
  } catch {
    return [];
  }
  return raw.filter((pid) => Number.isSafeInteger(pid) && pid > 0);
}

/** One line of `LaneJobStore.recent`. `elsewhere` marks a job another live process runs. */
export interface RecentJob {
  id: string;
  status: JobStatus;
  laneId: string;
  startedAt: number;
  endedAt: number | undefined;
  elsewhere: boolean;
  label?: string;
}

function recentOf(job: LaneJob, elsewhere: boolean): RecentJob {
  return {
    id: job.id,
    status: job.status,
    laneId: job.laneId,
    startedAt: job.startedAt,
    endedAt: job.endedAt,
    elsewhere,
    ...(job.label === undefined ? {} : { label: job.label }),
  };
}

/**
 * Newest start first. Two jobs can start in the same millisecond, so the job number breaks the tie:
 * ids are minted in order across every process (`seedJobCounter`).
 */
function newestFirst(a: Pick<RecentJob, "id" | "startedAt">, b: Pick<RecentJob, "id" | "startedAt">): number {
  return b.startedAt - a.startedAt || (jobSeqOf(b.id) ?? 0) - (jobSeqOf(a.id) ?? 0);
}

/**
 * Monotonic job ids. Readable, and stable to sort. Process-global, and SEEDED from what a previous
 * process left on disk (`seedJobCounter`), so a restart never mints an id the previous process
 * already handed out — `job-0001` after a restart used to name a different job than the same
 * handle did before it (C:\Code\docs\backlog.md, 2026-09-11).
 */
let jobCounter = 0;
function nextJobId(): string {
  jobCounter += 1;
  return `job-${String(jobCounter).padStart(4, "0")}`;
}

/** Raise the counter to at least `seq`; never lowers it. */
export function seedJobCounter(seq: number): void {
  if (Number.isSafeInteger(seq) && seq > jobCounter) jobCounter = seq;
}

/**
 * The job store.
 *
 * IN MEMORY for what RUNS: this process is stdio-attached to one host session, so its children die
 * with it, and a durable record of a running job would describe a process that no longer exists.
 * Two things ARE durable, each in its own file: the set of jobs a restart killed (`job-journal.ts`,
 * a row per running job, cleared when it ends) and every job's FINAL record once it is terminal
 * (`job-archive.ts`, written eagerly at the terminal transition). `cancelAll` is wired to process
 * exit so nothing is orphaned.
 */
export class LaneJobStore {
  private readonly jobs = new Map<string, LaneJob>();
  private readonly kills = new Map<string, () => void>();
  private readonly owned = new Map<string, OwnedProcess>();

  /**
   * Is this pid still alive? Injected so the suite can prove the survivor path without racing a
   * real termination, and so a platform with no `process.kill(pid, 0)` has one place to change.
   *
   * ⚠ `process.kill(pid, 0)` is an EXISTENCE probe, not a signal: it throws ESRCH when the pid is
   * gone and EPERM when it exists but belongs to another user — both of which mean the process the
   * dispatcher started is no longer a usable child.
   */
  isAlive: (pid: number) => boolean = (pid: number): boolean => {
    try {
      process.kill(pid, 0);
      return true;
    } catch (e) {
      return (e as NodeJS.ErrnoException).code === "EPERM";
    }
  };

  private readonly journal: JobJournal;
  private readonly archive: JobArchive;

  constructor(journal: JobJournal = nullJobJournal, archive: JobArchive = nullJobArchive) {
    this.journal = journal;
    this.archive = archive;
    // Archive first, then orphans: a job can be in only one of the two (the journal row is cleared
    // at the same transition the archive row is written), and the counter is seeded from BOTH so a
    // fresh id can collide with neither a finished job's nor a killed one's.
    this.restoreArchive();
    this.adoptOrphans();
  }

  /**
   * The finished jobs a previous process archived, read back so `dispatch_status`/`dispatch_result`
   * answer for them after a restart instead of `unknown jobId`. Marked `restored` so the rendering
   * can say the report predates this process.
   */
  private restoreArchive(): void {
    const { jobs, lastSeq } = this.archive.restore();
    seedJobCounter(lastSeq);
    for (const row of jobs) {
      if (this.jobs.has(row.id)) continue;
      this.jobs.set(row.id, { ...row, restored: true });
      const seq = jobSeqOf(row.id);
      if (seq !== null) seedJobCounter(seq);
    }
  }

  /** Run the archive's pending write now — the shutdown seam, called from `McpDispatchServer.shutdown`. */
  flush(): void {
    this.archive.flush();
  }

  /**
   * The jobs a PREVIOUS process died holding. They are adopted as terminal `"killed"` rows rather
   * than dropped, because the measured cost of dropping them was ninety lane-minutes lost behind a
   * bare `unknown jobId: job-0051` on a routine poll (2026-09-06).
   *
   * ⚠ No process is terminated here and none could be: this process holds no handle for those pids,
   * and a pid from a previous process may already belong to something else. `process.terminated` is
   * therefore false, and `ownedProcesses()` reports the job as un-reaped rather than claiming a
   * termination that never happened.
   */
  private adoptOrphans(): void {
    for (const row of this.journal.orphans()) {
      if (this.jobs.has(row.jobId)) continue;
      const seq = jobSeqOf(row.jobId);
      if (seq !== null) seedJobCounter(seq);
      const killed: LaneJob = {
        id: row.jobId,
        status: "killed",
        laneId: row.laneId,
        spec: row.spec,
        startedAt: row.startedAt,
        endedAt: row.startedAt,
        exitCode: null,
        stdout: "",
        stderr: "",
        timedOut: false,
        cwd: row.cwd,
        error:
          `the llm-relay MCP server restarted while ${row.jobId} was running on lane "${row.laneId}", ` +
          "so the lane was killed with it. Nothing was collected from it — check the working " +
          "directory for partial files before re-dispatching.",
        attempts: [],
        process: { pids: [], survivors: [], terminated: false },
      };
      this.jobs.set(row.jobId, killed);
      // ⚠ Archived at adoption, because the journal's first write by THIS process rewrites the file
      // with only its own rows — so without this, the killed report survived exactly one restart
      // and a second one answered `unknown jobId` for it all over again.
      this.archive.record(killed);
    }
  }

  create(
    laneId: string,
    spec: string | undefined,
    cwd: string,
    dispatchSource?: "daemon" | "fallback",
    label?: string,
  ): LaneJob {
    // ⚠ Seeded from the DISK at every mint, not only at start: another host's server mints from the
    // same files, and two processes seeded once each handed out the same `job-NNNN`. The journal
    // row below is written at once, so the window left between two processes is one write.
    seedJobCounter(this.archive.lastSeqOnDisk());
    seedJobCounter(this.journal.maxSeqOnDisk());
    const job: LaneJob = {
      id: nextJobId(),
      status: "running",
      laneId,
      spec,
      startedAt: Date.now(),
      endedAt: undefined,
      exitCode: null,
      stdout: "",
      stderr: "",
      timedOut: false,
      cwd,
      error: undefined,
      attempts: [],
      ...(dispatchSource !== undefined ? { dispatchSource } : {}),
      ...(label ? { label } : {}),
    };
    this.jobs.set(job.id, job);
    const seq = jobSeqOf(job.id);
    if (seq !== null) this.archive.noteSeq(seq);
    // ⚠ Recorded BEFORE the lane runs, so a kill between here and the first attempt is still
    // reported. The row is removed by `reap()` the moment the job goes terminal, which is why what
    // survives a crash is exactly the set that was still running.
    this.journal.note({
      jobId: job.id,
      laneId: job.laneId,
      ...(job.spec === undefined ? {} : { spec: job.spec }),
      cwd: job.cwd,
      startedAt: job.startedAt,
      ...(job.label === undefined ? {} : { label: job.label }),
    });
    return job;
  }

  /**
   * Record the process-handle this dispatcher started for `id`, so the job can be REAPED when it
   * reaches a terminal state and so what it owned is reportable afterwards.
   */
  registerProcess(id: string, handle: OwnedProcess): void {
    this.kills.set(id, handle.kill);
    this.owned.set(id, handle);
  }

  /** Root pids currently owned by a still-running job, through the same handle the reaper uses. */
  runningPids(id: string): number[] {
    const job = this.jobs.get(id);
    if (!job || job.status !== "running") return [];
    return readOwnedPids(this.owned.get(id));
  }

  /**
   * Register a bare kill callback — the pre-existing seam, kept because a caller that owns no OS
   * process (an answer-mode job's direct HTTP call, or a test double) still has something to stop.
   */
  registerKill(id: string, kill: () => void): void {
    this.kills.set(id, kill);
    this.owned.set(id, { kill });
  }

  /**
   * Terminate everything this dispatcher started for `id`, and record what happened. Called from
   * EVERY terminal transition — `complete`, `fail` and `cancel` alike — because "the job ended" and
   * "the job's processes ended" were two different facts on HEAD, and only the second one is true.
   *
   * ⚠ Never throws. A termination failure is data (`survivors`), not an exception: the job is
   * already terminal, and throwing here would replace a reported outcome with a crashed handler.
   */
  private reap(id: string): void {
    const job = this.jobs.get(id);
    const handle = this.owned.get(id);
    const kill = this.kills.get(id);
    this.kills.delete(id);
    this.owned.delete(id);
    // The job is no longer running, so it is no longer something a restart could kill.
    this.journal.clear(id);
    if (!job) return;
    // The attempt is over, so "silent for N s" no longer describes anything.
    delete job.activity;
    const pids = readOwnedPids(handle);
    if (kill === undefined) {
      // Nothing of ours ran for this job. Reported rather than omitted, so "no owned process" and
      // "we forgot to look" cannot read the same way.
      job.process = { pids, survivors: [], terminated: false };
      this.archive.record(job);
      return;
    }
    try {
      kill();
    } catch {
      // Fall through: the survivor check below is what reports it.
    }
    job.process = { pids, survivors: pids.filter((pid) => this.isAlive(pid)), terminated: true };
    // ⚠ After the process report, so what is archived is the whole terminal record — and eagerly,
    // because the restart this guards against runs no shutdown handler (`job-archive.ts`).
    this.archive.record(job);
  }

  /**
   * Every process this dispatcher started for a TERMINAL job, keyed by job id — so a stale lane can
   * be found without enumerating the machine's processes by hand, which is the only way the
   * measured case was ever found (four `opencode` processes, ~530 MB, burning CPU hours after their
   * jobs had returned, appearing in no `dispatch_status` listing).
   *
   * A still-running job is deliberately absent: it owns its processes on purpose.
   */
  ownedProcesses(): Array<{ jobId: string; laneId: string; spec: string | undefined } & LaneProcessReport> {
    const rows: Array<{ jobId: string; laneId: string; spec: string | undefined } & LaneProcessReport> = [];
    for (const job of this.jobs.values()) {
      if (job.status === "running" || job.process === undefined) continue;
      rows.push({
        jobId: job.id,
        laneId: job.laneId,
        spec: job.spec,
        ...job.process,
      });
    }
    return rows;
  }

  /**
   * Point a still-RUNNING walk at the lane it has just moved to, so a `dispatch_status` poll
   * names the lane currently doing the work rather than the one already abandoned.
   *
   * ⚠ The `running` guard is what keeps a cancelled walk cancelled. `cancel()` sets the status
   * synchronously and the walk loop checks it, but the two are not atomic with respect to each
   * other; without the guard a walk that advanced in the same tick would repoint a job the
   * operator had already stopped.
   */
  setCurrentLane(
    id: string,
    laneId: string,
    spec: string | undefined,
    expected?: LaneJob["expected"],
  ): void {
    const job = this.jobs.get(id);
    if (!job || job.status !== "running") return;
    job.laneId = laneId;
    job.spec = spec;
    // Replaced, never merged: the figure describes the lane now running, so a lane with no record
    // must clear the previous lane's figure rather than inherit it.
    if (expected === undefined) delete job.expected;
    else job.expected = expected;
    // Same rule for the previous lane's output progress and read-only binding: both describe an
    // attempt that is over. `beginAttemptActivity`/`noteReadOnly` set the new lane's own.
    delete job.activity;
    delete job.readOnly;
    delete job.launch;
    delete job.lastActive;
  }

  /**
   * A spawned attempt has started for `id`: from now until it settles, `noteOutput` counts what it
   * writes and a poll can say how long it has been silent. Not called for an answer-mode HTTP call,
   * which has no output stream — its absence is what keeps the figure honest there.
   */
  beginAttemptActivity(id: string, now: number): void {
    const job = this.jobs.get(id);
    if (!job || job.status !== "running") return;
    job.activity = { attemptStartedAt: now, lastOutputAt: null, stdoutBytes: 0, stderrBytes: 0 };
  }

  /** The running attempt wrote `bytes` to `stream` at `now`. Ignored once the attempt is over. */
  noteOutput(id: string, stream: "stdout" | "stderr", bytes: number, now: number): void {
    const activity = this.jobs.get(id)?.activity;
    if (!activity || !Number.isFinite(bytes) || bytes <= 0) return;
    activity.lastOutputAt = now;
    if (stream === "stdout") activity.stdoutBytes += bytes;
    else activity.stderrBytes += bytes;
  }

  /** Record the read-only tool binding the lane now running was given, so the reply can state it. */
  noteReadOnly(id: string, laneId: string, binding: string): void {
    const job = this.jobs.get(id);
    if (!job || job.status !== "running") return;
    job.readOnly = { laneId, binding };
  }

  /** Record what the launcher changed for the lane now running, so the reply can state it. */
  /**
   * Record the job's tree delta. Accepted on a TERMINAL job too — a cancellation ends the job before
   * the second `git status` returns — and the archive row is then written again so it carries it.
   */
  noteTreeDelta(id: string, text: string): void {
    const job = this.jobs.get(id);
    if (!job) return;
    job.treeDelta = text;
    if (job.status !== "running") this.archive.record(job);
  }

  /** Record the newest activity the walk saw for the running lane. */
  noteLastActivity(id: string, at: number, source: string): void {
    const job = this.jobs.get(id);
    if (!job || job.status !== "running") return;
    job.lastActive = { at, source };
  }

  noteLaunch(id: string, notes: readonly string[]): void {
    const job = this.jobs.get(id);
    if (!job || job.status !== "running" || notes.length === 0) return;
    job.launch = [...notes];
  }

  /**
   * Append one tried lane to the walk's record. Appended for EVERY attempt, the winner included,
   * so the answer can say what it cost to get there — and so an abandoned lane leaves a trace,
   * which is the case `docs/backlog.md` says matters most ("an operator who gives up on a slow
   * lane leaves no trace").
   */
  recordAttempt(id: string, attempt: LaneAttempt): void {
    this.jobs.get(id)?.attempts.push(attempt);
  }

  /**
   * Record what this dispatch was allowed to reach: whether it ran as a WALK, and how many
   * selectable lanes its own `maxLanes` bound kept it from trying.
   *
   * ⚠ No silent caps, and no false claim of exhaustion. Both halves feed the same decision — a
   * dispatch may only tell the caller "every lane has been tried" when it actually walked and
   * nothing was left over. A walk that stopped at four of nine lanes, or a dispatch with the walk
   * turned off entirely, saying that would be false on the one surface the caller acts on. Zero is
   * not stored, so an uncapped walk renders exactly as it did before this field existed.
   */
  noteWalkScope(id: string, scope: { enabled: boolean; lanesNotTried: number; forced?: boolean }): void {
    const job = this.jobs.get(id);
    if (!job) return;
    job.walkEnabled = scope.enabled;
    if (scope.lanesNotTried > 0) job.lanesNotTried = scope.lanesNotTried;
    if (scope.forced === true) job.forcedLane = true;
  }

  /**
   * A rung the walk SKIPPED for its `maxConcurrent` cap "counts as NOT TRIED" (the backlog item's
   * own wording), so it grows the same counter `noteWalkScope`'s `maxLanes` bound uses — one caller
   * before the walk starts (a fixed bound known in advance), this one during it (a skip discovered
   * lane by lane) — so `jobAnswer` cannot tell them apart and always prefers the PARTIAL advice over
   * the EXHAUSTED one whenever anything was left untried, whichever reason left it untried.
   */
  noteSkippedLane(id: string): void {
    const job = this.jobs.get(id);
    if (!job) return;
    job.lanesNotTried = (job.lanesNotTried ?? 0) + 1;
  }

  /**
   * How many jobs THIS MCP server process currently has a spawned process running for `laneId` —
   * the job's CURRENT attempt (`job.laneId`, repointed by `setCurrentLane` as the walk advances
   * from lane to lane), never its history. A job counts only while `status === "running"`: the
   * moment an attempt settles (or the whole job ends), it stops occupying a slot.
   *
   * ⚠ `excludeJobId` matters, and omitting it is a real bug, not a cosmetic nicety: `create()` sets
   * a fresh job's `laneId` to its FIRST candidate lane at CREATION, before the walk has attempted
   * anything — so a walk asking "is my own first lane already at its cap?" would count ITSELF and
   * skip its own opening attempt, on every dispatch, the moment any `maxConcurrent` is configured.
   * Passing the asking job's own id excludes it, so this answers "how many OTHER jobs are running
   * this lane right now" — the question a skip check actually needs.
   *
   * ⚠ Per-process by construction, and that is the whole design, not a limitation to work around:
   * the daemon never spawns a lane, so the only process that ever knows a `cli` rung's process is
   * running is the one that spawned it. Two host sessions each running their own `llm-relay mcp`
   * can together exceed a rung's `maxConcurrent` — this bounds one host's own concurrency, and
   * `docs/reference.md` says so rather than implying a machine-wide guarantee this cannot make.
   */
  inFlight(laneId: string, excludeJobId?: string): number {
    let count = 0;
    for (const job of this.jobs.values()) {
      if (job.status === "running" && job.laneId === laneId && job.id !== excludeJobId) count++;
    }
    return count;
  }

  /** A job THIS store holds. The walk reads this; it never needs another process's job. */
  get(id: string): LaneJob | undefined {
    return this.jobs.get(id);
  }

  /**
   * A job for a CALLER: one this store holds, else one another `llm-relay mcp` process finished and
   * archived after this store started (kept from then on, marked `restored`), else undefined.
   *
   * ⚠ Why a caller needs more than `get`. Claude Desktop and Codex Desktop each start their own
   * server, and a session can poll through a different connection than the one that dispatched —
   * observed 2026-09-16 as `unknown jobId` for a job that had finished. The archive is shared on
   * disk, so the answer exists; it was read only once, at start.
   */
  find(id: string): LaneJob | undefined {
    const held = this.jobs.get(id);
    if (held !== undefined) return held;
    const archived = this.archive.lookup(id);
    if (archived === undefined) return undefined;
    const row: LaneJob = { ...archived, restored: true };
    this.jobs.set(id, row);
    return row;
  }

  /**
   * The newest `limit` jobs this machine knows: this store's, every finished job on disk, and every
   * job another live process is running. Newest start first.
   */
  recent(limit: number): RecentJob[] {
    const byId = new Map<string, RecentJob>();
    const add = (row: RecentJob): void => {
      if (!byId.has(row.id)) byId.set(row.id, row);
    };
    for (const job of this.jobs.values()) add(recentOf(job, false));
    for (const job of this.archive.all()) add(recentOf(job, false));
    for (const row of this.journal.foreignRows()) {
      add({
        id: row.jobId,
        status: "running",
        laneId: row.laneId,
        startedAt: row.startedAt,
        endedAt: undefined,
        elsewhere: true,
        ...(row.label === undefined ? {} : { label: row.label }),
      });
    }
    return [...byId.values()].sort(newestFirst).slice(0, Math.max(0, limit));
  }

  /**
   * The journal row for a job another LIVE `llm-relay mcp` process is running now, or undefined.
   * Nothing about it can be read here except that it runs; its answer reaches `find` once it ends.
   */
  runningElsewhere(id: string): { laneId: string; spec?: string; startedAt: number; pid: number } | undefined {
    if (this.jobs.has(id)) return undefined;
    const row = this.journal.foreign(id);
    if (row?.owner === undefined) return undefined;
    return {
      laneId: row.laneId,
      ...(row.spec === undefined ? {} : { spec: row.spec }),
      startedAt: row.startedAt,
      pid: row.owner.pid,
    };
  }

  list(): LaneJob[] {
    return [...this.jobs.values()].sort(newestFirst);
  }

  /**
   * `relay` carries an answer-mode job's captured provenance headers — absent for every
   * agent-mode job, since those never touch HTTP directly.
   *
   * ⚠ `run.timedOut` is checked BEFORE the exit-code/semantic-failure branch and wins outright:
   * a killed-by-timeout run gets `status: "timed_out"`, never `"failed"`, regardless of what
   * `semanticFailure` a caller also passed (agent-mode quota classification already refuses to
   * run on a timed-out result, so in practice this only ever arbitrates against the empty-output
   * check — and a timeout is the more informative, more specific claim of the two).
   */
  complete(id: string, run: LaneRunResult, semanticFailure?: string, relay?: RelayAnnouncements): void {
    const job = this.jobs.get(id);
    if (!job) return;
    // A cancelled job stays cancelled. The child's own exit arrives afterwards, and letting it
    // overwrite the verdict would report a cancellation as an ordinary failure.
    if (job.status === "cancelled") return;
    job.exitCode = run.code;
    job.stdout = run.stdout;
    job.stderr = run.stderr;
    job.timedOut = run.timedOut;
    job.endedAt = Date.now();
    if (relay !== undefined) job.relay = relay;
    if (run.timedOut) {
      job.status = "timed_out";
      job.error = semanticFailure ?? "the lane exceeded its configured timeout and was stopped before it finished";
    } else {
      job.status = run.code === 0 && semanticFailure === undefined ? "completed" : "failed";
      if (semanticFailure !== undefined) job.error = semanticFailure;
    }
    // ⚠ AFTER the status is set and BEFORE the caller sees it. The unmet property is that a
    // terminal state ACCOUNTS FOR process-tree termination — reporting `timed_out` while the tree
    // still runs is the measured defect (three OpenCode jobs reported `timed_out` at 1,800 s with
    // their original processes found alive in their exact assigned worktrees).
    this.reap(id);
  }

  fail(id: string, error: string): void {
    const job = this.jobs.get(id);
    if (!job || job.status === "cancelled") return;
    job.status = "failed";
    job.error = error;
    job.endedAt = Date.now();
    this.reap(id);
  }

  cancel(id: string): boolean {
    const job = this.jobs.get(id);
    if (!job) return false;
    if (job.status !== "running") return false;
    job.status = "cancelled";
    job.endedAt = Date.now();
    this.reap(id);
    return true;
  }

  cancelAll(): void {
    for (const id of [...this.jobs.values()].filter((j) => j.status === "running").map((j) => j.id)) {
      this.cancel(id);
    }
  }
}

export interface CwdCheck {
  ok: boolean;
  reason?: string;
}

/**
 * Validate a caller-supplied working directory.
 *
 * The design question the prior-art survey raised: an executing tool needs a directory, and a
 * caller-supplied filesystem path is a strictly larger version of the hazard `dispatch.ts` already
 * refuses (request content becoming process configuration).
 *
 * The answer taken here, and why: the directory must EXIST and be a directory, and when the
 * operator declares `allowedRoots` it must sit under one of them. With no `allowedRoots` declared
 * the check is existence only — the caller is already a trusted agent on the operator's own
 * machine, and refusing by default would make the tool useless for its stated purpose. The bound
 * is offered, not imposed; that is the operator's call to make in config, not this file's.
 *
 * ⚠ **The containment test resolves BOTH sides with `path.resolve` before comparing** (closed
 * 2026-09-03, docs/history/audit-findings-2026-09-03.md finding 1 / DR-002). Without it a literal `..`
 * segment in `cwd` — a raw string a caller sends verbatim, never normalized — satisfied a bare
 * `startsWith` prefix test while `existsSync`/`statSync` above had already resolved `..` at the
 * OS level against the REAL, escaped directory: `allowedRoots: ["C:/allowed"]` admitted
 * `C:/allowed/../other`. `path.resolve` collapses `..`/`.` the same way the OS already does for
 * the existence check, so the two agree; it is a no-op on an already-clean absolute path, so the
 * common case is unaffected. `normalizePath`'s trailing-separator LOOP is untouched — resolving
 * first does not remove the need for it (`path.resolve` does not fold case on win32).
 */
export function checkCwd(cwd: string, allowedRoots: readonly string[] | undefined): CwdCheck {
  if (!existsSync(cwd)) return { ok: false, reason: `working directory does not exist: ${cwd}` };
  let isDir: boolean;
  try {
    isDir = statSync(cwd).isDirectory();
  } catch {
    return { ok: false, reason: `working directory is unreadable: ${cwd}` };
  }
  if (!isDir) return { ok: false, reason: `not a directory: ${cwd}` };
  if (!allowedRoots || allowedRoots.length === 0) return { ok: true };
  const normalized = normalizePath(resolvePath(cwd));
  const permitted = allowedRoots.some((root) => {
    const r = normalizePath(resolvePath(root));
    return normalized === r || normalized.startsWith(r.endsWith("/") ? r : `${r}/`);
  });
  if (permitted) return { ok: true };
  return {
    ok: false,
    reason: `working directory is outside routing.mcp.allowedRoots: ${cwd}`,
  };
}

/**
 * Path comparison that survives Windows: separators unified, trailing separators dropped, case
 * folded on win32 only.
 *
 * ⚠ The trailing-separator trim is a LOOP, not a `/\/+$/` regex. That pattern backtracks
 * super-linearly, and this function is handed an operator-supplied path — the one input where a
 * pathological string is cheapest to supply.
 */
function normalizePath(p: string): string {
  let unified = p.split("\\").join("/");
  let end = unified.length;
  while (end > 0 && unified[end - 1] === "/") end -= 1;
  unified = unified.slice(0, end);
  return process.platform === "win32" ? unified.toLowerCase() : unified;
}

/**
 * Current dispatch depth, read from the environment this process was launched with.
 * Absent or unparseable ⇒ 0, so a hand-launched server behaves as the top of the chain.
 */
export function currentDepth(env: NodeJS.ProcessEnv = process.env): number {
  const raw = env[DEPTH_ENV];
  if (raw === undefined) return 0;
  const n = Number(raw);
  return Number.isFinite(n) && n >= 0 ? Math.floor(n) : 0;
}
