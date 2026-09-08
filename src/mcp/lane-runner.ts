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

/**
 * How long `dispatch` waits before it stops blocking and hands back a job handle instead.
 *
 * Chosen BELOW a typical MCP client tool timeout on purpose: a fast lane answers in one call, and
 * a slow one degrades to polling automatically rather than failing. That is the behaviour the
 * Tasks extension would give us natively — see `docs/mcp-dispatch-prior-art-2026-08-30.md` §3.1 for
 * why we cannot use it yet.
 */
export const DEFAULT_WAIT_MS = 60_000;

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
export type JobStatus = "running" | "completed" | "failed" | "cancelled" | "timed_out";

/**
 * The four states `LaneJobStore.complete()`/`cancel()` can put a job into — `"running"` is the
 * only non-terminal member of `JobStatus`. Exported so a rendering test can iterate every
 * terminal status the store actually knows, rather than hand-copying the list a second time.
 */
export const TERMINAL_JOB_STATUSES = ["completed", "failed", "cancelled", "timed_out"] as const satisfies readonly JobStatus[];

export type TerminalJobStatus = (typeof TERMINAL_JOB_STATUSES)[number];

/**
 * Terminal statuses worth reporting as lane telemetry: every terminal status but
 * `cancelled` — a caller cancellation is not lane evidence, so it is discarded, never
 * reported. Keyed as a `Record` over `Exclude<…, "cancelled">` so a NEW terminal status is
 * a compile error HERE, at the classifier, rather than a silent drop at the forwarder (the
 * closed-union gotcha in CLAUDE.md); the forwarder ranges over this list, never a hand copy.
 */
const REPORTABLE_JOB_STATUS_MAP: Record<Exclude<TerminalJobStatus, "cancelled">, true> = {
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
 * One lane a dispatch WALK tried, in the order it tried them.
 *
 * ⚠ Its `status` is a `DispatchLaneStatus`, IMPORTED rather than restated. Two hand-written copies
 * of one closed set is the most-repeated defect in this repository's history, and here the type
 * additionally buys a guarantee: that union has no `cancelled` member, so "a caller cancellation is
 * never reported as lane evidence" becomes a property the compiler enforces at every call site
 * rather than a runtime check somebody can forget.
 */
export interface LaneAttempt {
  laneId: string;
  spec: string | undefined;
  status: DispatchLaneStatus;
  /** Wall clock for THIS attempt, not for the walk. */
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
}

/**
 * The spawn seam. Injected so the suite can exercise every path without spending real lane quota —
 * the same discipline `lane-quota-probe.ts` applies, and the reason its default spawner refuses to
 * run under vitest.
 */
export type LaneSpawner = (
  command: string,
  args: readonly string[],
  opts: LaneSpawnOptions,
) => { result: Promise<LaneRunResult>; kill: () => void };

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

/** The small child-process surface the lane spawner needs. */
export interface LaneChildProcess {
  pid?: number | undefined;
  stdin: { end: () => void } | null | undefined;
  kill: () => boolean;
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
          return;
        }
        settle(err, stdout ?? "", stderr ?? "");
      });

      // ⚠ An async execFile leaves stdin an OPEN pipe. `agy` reads stdin, finds no EOF, and produces
      // zero bytes until the timeout kills it. Measured live; the synchronous form hid it.
      child.stdin?.end();
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

/** Monotonic per-process job ids. Readable, and stable to sort. */
let jobCounter = 0;
function nextJobId(): string {
  jobCounter += 1;
  return `job-${String(jobCounter).padStart(4, "0")}`;
}

/**
 * The job store.
 *
 * Deliberately IN MEMORY. This process is stdio-attached to one host session, so its children die
 * with it; a durable store would outlive the processes it describes and start reporting jobs whose
 * output no longer exists. `cancelAll` is wired to process exit so nothing is orphaned.
 */
export class LaneJobStore {
  private readonly jobs = new Map<string, LaneJob>();
  private readonly kills = new Map<string, () => void>();

  create(laneId: string, spec: string | undefined, cwd: string, dispatchSource?: "daemon" | "fallback"): LaneJob {
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
    };
    this.jobs.set(job.id, job);
    return job;
  }

  registerKill(id: string, kill: () => void): void {
    this.kills.set(id, kill);
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
  setCurrentLane(id: string, laneId: string, spec: string | undefined): void {
    const job = this.jobs.get(id);
    if (!job || job.status !== "running") return;
    job.laneId = laneId;
    job.spec = spec;
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
  noteWalkScope(id: string, scope: { enabled: boolean; lanesNotTried: number }): void {
    const job = this.jobs.get(id);
    if (!job) return;
    job.walkEnabled = scope.enabled;
    if (scope.lanesNotTried > 0) job.lanesNotTried = scope.lanesNotTried;
  }

  get(id: string): LaneJob | undefined {
    return this.jobs.get(id);
  }

  list(): LaneJob[] {
    return [...this.jobs.values()].sort((a, b) => b.startedAt - a.startedAt);
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
    this.kills.delete(id);
  }

  fail(id: string, error: string): void {
    const job = this.jobs.get(id);
    if (!job || job.status === "cancelled") return;
    job.status = "failed";
    job.error = error;
    job.endedAt = Date.now();
    this.kills.delete(id);
  }

  cancel(id: string): boolean {
    const job = this.jobs.get(id);
    if (!job) return false;
    if (job.status !== "running") return false;
    this.kills.get(id)?.();
    this.kills.delete(id);
    job.status = "cancelled";
    job.endedAt = Date.now();
    return true;
  }

  cancelAll(): void {
    for (const id of [...this.kills.keys()]) this.cancel(id);
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
 * 2026-09-03, docs/audit-findings-2026-09-03.md finding 1 / DR-002). Without it a literal `..`
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
