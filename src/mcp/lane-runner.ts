/**
 * Lane execution and job state for the host-launched MCP process.
 *
 * This module centralizes process spawning because lane launches need consistent timeout, stdin,
 * Windows-shim, environment and process-tree handling. It runs in `llm-relay mcp`, not in the
 * HTTP relay daemon.
 */
import { exec, execFile, execSync, spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { existsSync, statSync } from "node:fs";
import { resolve as resolvePath } from "node:path";
import { resolveWindowsNpmShim, type WindowsNpmShimDeps, type WindowsNpmShimResolution } from "./windows-npm-shim.js";
import {
  nullJobJournal,
  type JobJournal,
  type JournalRow,
  type JournalStartingTree,
} from "./job-journal.js";
import type { LaneExecutionSnapshot } from "../lane-execution-broker.js";
import { nullJobArchive, type JobArchive } from "./job-archive.js";
import type { TreeSnapshot } from "./tree-delta.js";
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

/** `timed_out` is distinct from `failed`: the lane hit its own runtime ceiling rather than settling normally. */
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
  /** Recovered journal rows whose owning MCP process died. This is not lane-failure evidence. */
  "killed",
] as const satisfies readonly JobStatus[];

export type TerminalJobStatus = (typeof TERMINAL_JOB_STATUSES)[number];

/**
 * Terminal statuses that describe lane behavior. Caller cancellation and owner-process death are
 * excluded because neither is evidence about the lane.
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
 * A walk-only state for a rung skipped before spawn, currently because `maxConcurrent` is full.
 * It is not a `DispatchLaneStatus`: skipped lanes produce no run telemetry.
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

/** True only when the walk actually started the lane. The exhaustive switch keeps new statuses explicit. */
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

/** One lane attempt in walk order. Caller cancellation is job state, not an attempt status. */
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
 * Classify one lane attempt. `abandoned` wins over the child timeout flag because it means the walk
 * deliberately stopped the attempt before the lane's own timeout.
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

export type LaneActivityState = "starting" | "active" | "quiet" | "advancing" | "unmonitored";
export type LaneWalkVerdict = "keep-running" | "no-idle-stop";

/**
 * The walk's OWN liveness decision for the attempt running now.
 *
 * This is a published snapshot, not a second activity probe. `mcp/server.ts` computes it while
 * making the same keep/stop decision the walk already has to make, then `dispatch_status` merely
 * renders it. A status read must never call the relay-traffic, process-CPU or working-tree readers:
 * those readers carry baselines/state and consuming them from a poll could change routing.
 */
export interface LaneLiveness {
  activity: LaneActivityState;
  verdict: LaneWalkVerdict;
  /** When the walk last evaluated/published this snapshot. */
  checkedAt: number;
  /**
   * Timestamp the idle timer is anchored to. Starts at attempt launch so a new lane gets a full
   * idle window even before it emits observable activity; moves forward when real activity arrives.
   */
  idleBaselineAt: number;
  /** Newest REAL activity timestamp the walk accepted for this attempt, or null before any. */
  lastActivityAt: number | null;
  /** What established the current idle baseline: attempt-start or a first-party activity signal. */
  source: string;
  /** Idle cutoff applied to this attempt; null means the walk will not idle-stop it. */
  idleMs: number | null;
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
  /** Every lane this job tried, oldest first. One job id follows the whole walk across lanes. */
  attempts: LaneAttempt[];
  /**
   * Selectable lanes the walk's `maxLanes` bound kept it from trying. Absent when it tried
   * everything the ladder offered — see `LaneJobStore.noteWalkScope`.
   */
  lanesNotTried?: number;
  /** Whether dispatch walking was enabled; rendering uses this to avoid false exhaustion advice. */
  walkEnabled?: boolean;
  /** The caller explicitly named a lane/model, so only that one target was intended to run. */
  forcedLane?: boolean;
  /**
   * Completed-run duration context for the current lane. Diagnostic only; liveness decisions use
   * `liveness.verdict`. Absent when there is no completed-run history.
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
   * Who owns the currently-running agent process tree. Absent preserves the pre-D1/local shape for
   * embeds and answer-mode jobs. `local-fallback` is explicit because it does NOT survive MCP exit.
   */
  executionOwner?: "relay-daemon" | "local-fallback";
  /**
   * What this dispatcher started for this job, and what became of it — written once, when the job
   * reaches a terminal state. See `LaneProcessReport`.
   */
  process?: LaneProcessReport;
  /** Output byte/timestamp diagnostics for a spawned running attempt. Answer-mode HTTP calls omit it. */
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
   * The walk's authoritative liveness snapshot for the lane now running. Replaced per lane and
   * removed when the job becomes terminal; terminal attempt records already say how the lane ended.
   */
  liveness?: LaneLiveness;
}

/**
 * Output progress for the running attempt. This is diagnostic only; the walk acts on its published
 * liveness verdict, not on output silence alone.
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
 * Process-tree termination record for one job. `survivors` reports failed cleanup explicitly;
 * `terminated: false` means no OS process was registered for the job.
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
 * Structural empty-output check. It removes whitespace/Markdown scaffolding but deliberately makes
 * no semantic judgment about whether the remaining text answers the task.
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
 * Expand Windows `%NAME%` references from the same environment, case-insensitively. A value that is
 * only one unresolved reference is removed; unresolved references inside larger values are kept.
 * Notes contain variable/reference names only, never values.
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
 * Bind AGY to the dispatch working directory with `--add-dir` and a prompt prefix. Other harnesses
 * are unchanged; an existing identical `--add-dir` is not duplicated.
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

/** Process ownership needed for cleanup and survivor reporting. */
export interface OwnedProcess {
  /**
   * Terminate the process TREE this spawn started. Idempotent, and safe to call after the child has
   * already exited — the descendants are the whole reason it exists.
   */
  kill: () => void;
  /**
   * Root pids, read lazily because Windows shim fallback can replace the initially attempted child.
   * Test doubles that own no OS process may omit this.
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

/**
 * Terminate a full process tree (Windows: taskkill /T /F; POSIX: the process group created by
 * `createLaneSpawner`). The positive-pid fallback is defence for an injected/legacy child that was
 * not started as a group leader; the real POSIX spawner always owns group `pid`.
 */
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

/** Spawn options for the POSIX process-group path. */
export interface LaneSpawnProcessOptions {
  cwd: string;
  env: NodeJS.ProcessEnv;
  windowsHide: true;
  detached: true;
}

/** Child events the POSIX buffered spawn path consumes. */
export interface LaneSpawnedProcess extends LaneChildProcess {
  on(event: "error", listener: (err: Error) => void): unknown;
  on(event: "close", listener: (code: number | null, signal: NodeJS.Signals | null) => void): unknown;
}

/**
 * POSIX uses `spawn`, not `execFile`, because only spawn documents `detached: true`. That makes
 * the root a new session/process-group leader (PGID === PID), so `terminateProcessTree` can own
 * every ordinary descendant. Buffering here preserves execFile's lane result contract and cap.
 */
function spawnPosixLane(
  processApi: LaneProcessApi,
  command: string,
  args: readonly string[],
  opts: LaneSpawnOptions,
): LaneSpawnHandle {
  const spawnProcess = processApi.spawn;
  if (!spawnProcess) {
    return {
      result: Promise.resolve({
        code: null,
        stdout: "",
        stderr: "POSIX lane spawning requires the injected spawn boundary",
        timedOut: false,
      }),
      kill: () => {},
      pids: () => [],
    };
  }

  let child: LaneSpawnedProcess | undefined;
  let timedOut = false;
  let bufferExceeded: "stdout" | "stderr" | null = null;
  let timeoutTimer: ReturnType<typeof setTimeout> | undefined;
  const stdoutChunks: Buffer[] = [];
  const stderrChunks: Buffer[] = [];
  let stdoutBytes = 0;
  let stderrBytes = 0;

  const killOwned = (): void => {
    if (child?.pid) terminateProcessTree(child.pid, processApi.platform);
    child?.kill();
  };
  const clearTimer = (): void => {
    if (timeoutTimer !== undefined) clearTimeout(timeoutTimer);
    timeoutTimer = undefined;
  };
  const append = (stream: "stdout" | "stderr", chunk: string | Buffer): void => {
    const data = typeof chunk === "string" ? Buffer.from(chunk) : chunk;
    const isStdout = stream === "stdout";
    const used = isStdout ? stdoutBytes : stderrBytes;
    const remaining = Math.max(0, MAX_OUTPUT_BYTES - used);
    if (remaining > 0) {
      const kept = data.length <= remaining ? data : data.subarray(0, remaining);
      (isStdout ? stdoutChunks : stderrChunks).push(kept);
      if (isStdout) stdoutBytes += kept.length;
      else stderrBytes += kept.length;
    }
    if (data.length > remaining && bufferExceeded === null) {
      bufferExceeded = stream;
      killOwned();
    }
  };

  const result = new Promise<LaneRunResult>((resolve) => {
    let settled = false;
    const settle = (code: number | null, error?: Error): void => {
      if (settled) return;
      settled = true;
      clearTimer();
      const stdout = Buffer.concat(stdoutChunks).toString("utf8");
      let stderr = Buffer.concat(stderrChunks).toString("utf8");
      if (!stderr && error) stderr = error.message;
      if (bufferExceeded !== null) {
        const msg = `${bufferExceeded} exceeded ${MAX_OUTPUT_BYTES} byte lane output limit`;
        stderr = stderr ? `${stderr}\n${msg}` : msg;
      }
      resolve({
        code: bufferExceeded === null ? code : null,
        stdout,
        stderr,
        timedOut,
      });
    };

    try {
      child = spawnProcess(command, args as string[], {
        cwd: opts.cwd,
        env: opts.env,
        windowsHide: true,
        detached: true,
      });
    } catch (e) {
      settle(null, e as Error);
      return;
    }

    child.stdout?.on("data", (chunk) => append("stdout", chunk));
    child.stderr?.on("data", (chunk) => append("stderr", chunk));
    observeOutput(child, opts.onOutput);
    child.on("error", (err) => settle(null, err));
    child.on("close", (code) => settle(code));
    // Same stdin rule as the Windows execFile path: an agent waiting for EOF must receive it.
    child.stdin?.end();

    if (opts.timeoutMs > 0) {
      timeoutTimer = setTimeout(() => {
        timedOut = true;
        killOwned();
      }, opts.timeoutMs);
      timeoutTimer.unref?.();
    }
  });

  return {
    result,
    kill: () => {
      clearTimer();
      killOwned();
    },
    pids: () => (child?.pid === undefined ? [] : [child.pid]),
  };
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
  /** POSIX-only real spawn seam: `detached` is supported by spawn, not execFile. */
  spawn?: (
    command: string,
    args: string[],
    opts: LaneSpawnProcessOptions,
  ) => LaneSpawnedProcess;
}

/** Injectable npm-shim resolver so unit tests never inspect the host filesystem. */
export type WindowsNpmShimResolver = (
  command: string,
  args: readonly string[],
  deps: WindowsNpmShimDeps,
) => WindowsNpmShimResolution;

const nodeProcessApi: LaneProcessApi = {
  platform: process.platform,
  execFile: (command, args, opts, callback) => execFile(command, args, opts, callback),
  exec: (command, opts, callback) => exec(command, opts, callback),
  spawn: (command, args, opts) => spawn(command, args, opts),
};

/**
 * Production lane spawner. Process failures resolve as `LaneRunResult` values rather than rejecting.
 * Under vitest it refuses real spawns unless a test injects a seam.
 */
export function createLaneSpawner(
  processApi: LaneProcessApi,
  hostEnv: NodeJS.ProcessEnv = process.env,
  resolveNpmShim: WindowsNpmShimResolver = resolveWindowsNpmShim,
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

    if (processApi.platform !== "win32") return spawnPosixLane(processApi, command, args, opts);

    const execOpts: LaneExecOptions = {
      encoding: "utf8",
      maxBuffer: MAX_OUTPUT_BYTES,
      timeout: opts.timeoutMs,
      // Prevent console-subsystem children from allocating a visible console for a console-less host.
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
        // npm-installed commands are usually .cmd shims, which CreateProcess cannot execute
        // directly. Do NOT reconstruct a cmd.exe command line, and do not rely on Windows
        // PowerShell's legacy native-argument serializer: both can reinterpret task text. Resolve
        // npm's generated .ps1 metadata to its Node entrypoint, then execFile Node with the
        // ORIGINAL argv.
        if (err && processApi.platform === "win32" && err.code === "ENOENT" && !killed) {
          const resolved = resolveNpmShim(command, args, {
            env: opts.env,
            cwd: opts.cwd,
            nodeExecutable: process.execPath,
          });
          if (!resolved.ok) {
            settle(Object.assign(new Error(resolved.error), { code: "ENOENT" }), stdout ?? "", stderr ?? "");
            return;
          }
          const fallback = processApi.execFile(
            resolved.command,
            resolved.args,
            execOpts,
            (err2, stdout2, stderr2) => settle(err2, stdout2 ?? "", stderr2 ?? ""),
          );
          child = fallback;
          fallback.stdin?.end();
          observeOutput(fallback, opts.onOutput);
          return;
        }
        settle(err, stdout ?? "", stderr ?? "");
      });

      // Some harnesses wait for stdin EOF before running.
      child.stdin?.end();
      observeOutput(child, opts.onOutput);

    });

    return {
      result,
      kill: () => {
        killed = true;
        if (child?.pid) terminateProcessTree(child.pid, processApi.platform);
        child?.kill();
      },
      // The Windows shim fallback may replace `child`; report the final root process.
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
 * Newest start first. `startedAt` is the ordering fact across independent MCP processes. When two
 * rows share one millisecond, the opaque id is only a deterministic tie-break. Within one process
 * its fixed-width local suffix is monotonic; across processes a same-ms tie has no knowable order
 * without re-introducing the shared sequencer this module deliberately avoids.
 */
function newestFirst(a: Pick<RecentJob, "id" | "startedAt">, b: Pick<RecentJob, "id" | "startedAt">): number {
  return b.startedAt - a.startedAt || b.id.localeCompare(a.id);
}

/**
 * Build one process-local job-id allocator.
 *
 * The old allocator read a shared max sequence and then incremented a process-local counter. Two
 * MCP processes could both read N before either wrote N+1, so both handed out the same handle.
 *
 * New ids keep the established `job-<digits>` wire shape but replace the shared sequence with a
 * 128-bit random PROCESS instance plus a local monotonic suffix. Independent processes need no
 * coordination. The leading 9 plus fixed-width 39-digit instance guarantees every new id is
 * outside JavaScript's safe-integer range, so `jobSeqOf` can continue recognizing only legacy
 * sequential ids in old archive files.
 */
export function createJobIdFactory(entropy: Uint8Array = randomBytes(16)): () => string {
  const bytes = Buffer.from(entropy);
  if (bytes.length !== 16) throw new Error("job id entropy must be exactly 16 bytes");
  const instance = BigInt(`0x${bytes.toString("hex")}`).toString(10).padStart(39, "0");
  let local = 0n;
  return (): string => {
    local += 1n;
    return `job-9${instance}${local.toString(10).padStart(8, "0")}`;
  };
}

const defaultJobIdFactory = createJobIdFactory();

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
  /** Starting trees carried off ordinary killed rows before the journal drops them on its next write. */
  private readonly adoptedStartingTrees = new Map<string, { cwd: string; startingTree: JournalStartingTree }>();
  /** Dead-MCP rows whose actual process owner is the daemon, atomically claimed for reconciliation. */
  private readonly brokerOrphans = new Map<string, JournalRow>();
  /** Running/recovered jobs whose process tree is owned by the daemon rather than this MCP process. */
  private readonly brokerExecutions = new Map<string, string>();
  private readonly nextJobId: () => string;

  constructor(
    journal: JobJournal = nullJobJournal,
    archive: JobArchive = nullJobArchive,
    nextJobId: () => string = defaultJobIdFactory,
  ) {
    this.journal = journal;
    this.archive = archive;
    this.nextJobId = nextJobId;
    // Archive first, then orphans: a job can be in only one of the two (the journal row is cleared
    // at the same transition the archive row is written). New ids need no disk seeding.
    this.restoreArchive();
    this.adoptOrphans();
  }

  /**
   * The finished jobs a previous process archived, read back so `dispatch_status`/`dispatch_result`
   * answer for them after a restart instead of `unknown jobId`. Marked `restored` so the rendering
   * can say the report predates this process.
   */
  private restoreArchive(): void {
    const { jobs } = this.archive.restore();
    for (const row of jobs) {
      if (this.jobs.has(row.id)) continue;
      this.jobs.set(row.id, { ...row, restored: true });
    }
  }

  /** Run the archive's pending write now — the shutdown seam, called from `McpDispatchServer.shutdown`. */
  flush(): void {
    this.archive.flush();
  }

  /**
   * Adopt rows left by a dead MCP owner. Local rows become `killed`; broker-backed rows are claimed
   * for daemon reconciliation. Never terminate a pid inherited from another process.
   */
  private adoptOrphans(): void {
    for (const row of this.journal.orphans()) {
      if (this.jobs.has(row.jobId)) continue;

      // A daemon-backed execution may still be running even though the MCP owner pid is gone.
      // Claim it atomically so at most one replacement MCP process becomes its collector; never
      // infer death from the host process boundary that D1 exists to survive.
      if (row.brokerExecution !== undefined) {
        const claimed = this.journal.claimBrokerOrphan?.(row.jobId);
        if (claimed !== undefined) this.brokerOrphans.set(row.jobId, claimed);
        continue;
      }

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
      if (row.startingTree !== undefined) {
        this.adoptedStartingTrees.set(row.jobId, { cwd: row.cwd, startingTree: row.startingTree });
      }
      // Archive before acknowledging the orphan. Foreign journal rows are intentionally preserved
      // across unrelated writes, so the recovery evidence stays durable until this terminal report
      // has committed. If the archive write fails, leave the orphan in place for a later process.
      if (this.archive.record(killed)) this.journal.clearOrphan?.(row);
    }
  }

  create(
    laneId: string,
    spec: string | undefined,
    cwd: string,
    dispatchSource?: "daemon" | "fallback",
    label?: string,
  ): LaneJob {
    const job: LaneJob = {
      id: this.nextJobId(),
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
    const brokerOwned = this.brokerExecutions.has(id);
    this.brokerExecutions.delete(id);
    if (!job) {
      this.journal.clear(id);
      return;
    }
    // The attempt is over, so neither stream progress nor a running-attempt verdict describes it.
    delete job.activity;
    delete job.liveness;
    const pids = readOwnedPids(handle);
    if (brokerOwned) {
      // The daemon owns this process tree and the broker result is already terminal. Never signal
      // it from MCP or invent pid ownership here; just archive the job and clear the journal row.
      job.process = { pids: [], survivors: [], terminated: false };
      if (this.archive.record(job)) this.journal.clear(id);
      return;
    }
    if (kill === undefined) {
      // Nothing of ours ran for this job. Reported rather than omitted, so "no owned process" and
      // "we forgot to look" cannot read the same way.
      job.process = { pids, survivors: [], terminated: false };
      // Archive BEFORE clearing the running row, and clear ONLY after the archive confirms its
      // atomic write committed. If persistence is temporarily unavailable, the journal row is the
      // weaker fallback: a restart may call the job killed, but it cannot lose the handle entirely.
      if (this.archive.record(job)) this.journal.clear(id);
      return;
    }
    try {
      kill();
    } catch {
      // Fall through: the survivor check below is what reports it.
    }
    job.process = { pids, survivors: pids.filter((pid) => this.isAlive(pid)), terminated: true };
    // Archive the complete terminal/process record before clearing the running journal fallback.
    if (this.archive.record(job)) this.journal.clear(id);
  }


  /** Process reports for terminal jobs only; running jobs still own their processes intentionally. */
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
    // Same rule for attempt-scoped output/provenance/liveness: none may leak into the next rung.
    delete job.activity;
    delete job.readOnly;
    delete job.launch;
    delete job.liveness;
    // A daemon execution belongs to the attempt we just left, not to the whole walk. The journal
    // note below clears its persisted reference; the next brokered attempt writes a fresh id before
    // start. This also makes a crash between attempts degrade honestly to the local killed path.
    this.brokerExecutions.delete(id);
    delete job.executionOwner;
    // A different MCP process can answer status for this running job from the shared journal.
    // Keep the lane identity current there too; liveness itself stays process-local so the journal
    // is not rewritten every 15 seconds.
    this.journal.note({
      jobId: job.id,
      laneId: job.laneId,
      ...(job.spec === undefined ? {} : { spec: job.spec }),
      cwd: job.cwd,
      startedAt: job.startedAt,
      ...(job.label === undefined ? {} : { label: job.label }),
    });
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

  /** Persist the job-wide starting tree while the job is still running. */
  noteStartingTree(id: string, tree: TreeSnapshot, scope: readonly string[] | undefined): void {
    const job = this.jobs.get(id);
    if (!job || job.status !== "running") return;
    this.journal.noteStartingTree?.(id, tree, scope);
  }

  /**
   * Return, once, daemon-backed orphan rows this process atomically claimed. The server owns the
   * broker client, so reconciliation is asynchronous and deliberately outside this synchronous store.
   */
  takeBrokerOrphans(): JournalRow[] {
    const rows = [...this.brokerOrphans.values()].map((row) => ({ ...row }));
    this.brokerOrphans.clear();
    return rows;
  }

  /** Broker execution id for a job this process is collecting, if any. */
  brokerExecution(id: string): string | undefined {
    return this.brokerExecutions.get(id);
  }

  /** Record which execution boundary owns the current attempt. */
  noteExecutionOwner(id: string, owner: LaneJob["executionOwner"]): void {
    const job = this.jobs.get(id);
    if (job === undefined || job.status !== "running") return;
    if (owner === undefined) delete job.executionOwner;
    else job.executionOwner = owner;
  }

  /**
   * Clear an attempt-scoped daemon execution after it is definitively terminal and the walk will
   * continue. The job itself stays running; the journal row is rewritten without broker metadata.
   */
  clearBrokerExecution(id: string): void {
    const job = this.jobs.get(id);
    if (job === undefined || job.status !== "running") return;
    this.brokerExecutions.delete(id);
    if (job.executionOwner === "relay-daemon") delete job.executionOwner;
    this.journal.note({
      jobId: job.id,
      laneId: job.laneId,
      ...(job.spec === undefined ? {} : { spec: job.spec }),
      cwd: job.cwd,
      startedAt: job.startedAt,
      ...(job.label === undefined ? {} : { label: job.label }),
    });
  }

  /**
   * Bind a live job to the daemon execution that now owns its process tree, and persist the opaque
   * reference before the broker start request is sent. Used by the later ownership switchover.
   */
  noteBrokerExecution(id: string, executionId: string): void {
    const job = this.jobs.get(id);
    if (job === undefined || job.status !== "running") return;
    const execution = { kind: "daemon-v1" as const, executionId };
    this.brokerExecutions.set(id, executionId);
    this.journal.noteBrokerExecution?.(id, execution);
  }

  /**
   * Materialize a claimed broker row as a running job while the daemon is queried/retried.
   * The daemon, not this process, owns its process tree; no local kill handle is registered.
   */
  adoptBrokerRunning(row: JournalRow, snapshot?: LaneExecutionSnapshot): LaneJob | undefined {
    if (row.brokerExecution === undefined) return undefined;
    const existing = this.jobs.get(row.jobId);
    if (existing !== undefined) return existing;
    const job: LaneJob = {
      id: row.jobId,
      status: "running",
      laneId: row.laneId,
      spec: row.spec,
      startedAt: row.startedAt,
      endedAt: undefined,
      exitCode: null,
      stdout: "",
      stderr: "",
      timedOut: false,
      cwd: row.cwd,
      error: undefined,
      attempts: [],
      restored: true,
      executionOwner: "relay-daemon",
      ...(row.label === undefined ? {} : { label: row.label }),
    };
    this.jobs.set(job.id, job);
    this.brokerExecutions.set(job.id, row.brokerExecution.executionId);
    if (snapshot !== undefined) this.applyBrokerSnapshot(job.id, snapshot);
    return job;
  }

  /**
   * Apply one identity-checked daemon snapshot to an adopted broker job.
   * Returns false on mismatch/inconsistent terminal data; callers then retain the row and retry
   * rather than turn malformed transport data into a death claim.
   */
  applyBrokerSnapshot(id: string, snapshot: LaneExecutionSnapshot): boolean {
    const job = this.jobs.get(id);
    const executionId = this.brokerExecutions.get(id);
    if (
      job === undefined ||
      executionId === undefined ||
      snapshot.executionId !== executionId ||
      snapshot.jobId !== id ||
      snapshot.laneId !== job.laneId
    ) {
      return false;
    }

    if (snapshot.launchNotes !== undefined) job.launch = [...snapshot.launchNotes];
    job.activity = {
      attemptStartedAt: snapshot.startedAt,
      lastOutputAt: snapshot.lastOutputAt,
      stdoutBytes: snapshot.stdoutBytes,
      stderrBytes: snapshot.stderrBytes,
    };

    if (snapshot.status === "running") return true;

    if (snapshot.status === "completed") {
      if (snapshot.code !== 0 || snapshot.timedOut !== false || snapshot.stdout === undefined) return false;
      if (isContentEmpty(snapshot.stdout)) {
        job.status = "failed";
        job.error = EMPTY_OUTPUT_REASON;
      } else {
        job.status = "completed";
      }
    } else if (snapshot.status === "failed") {
      if (snapshot.timedOut !== false || snapshot.code === 0) return false;
      job.status = "failed";
    } else if (snapshot.status === "timed_out") {
      if (snapshot.timedOut !== true) return false;
      job.status = "timed_out";
      job.error = "the daemon-owned lane exceeded its configured timeout and was stopped before it finished";
    } else if (snapshot.status === "cancelled") {
      job.status = "cancelled";
    } else {
      const _never: never = snapshot.status;
      return _never;
    }

    if (snapshot.code !== undefined) job.exitCode = snapshot.code;
    if (snapshot.stdout !== undefined) job.stdout = snapshot.stdout;
    if (snapshot.stderr !== undefined) job.stderr = snapshot.stderr;
    if (snapshot.timedOut !== undefined) job.timedOut = snapshot.timedOut;
    job.endedAt = snapshot.endedAt ?? Date.now();
    delete job.activity;
    delete job.liveness;
    this.brokerExecutions.delete(id);

    // The daemon already owns/settled the process tree. Do NOT call reap(): that would manufacture
    // a local process report and, once the live broker path exists, could attempt the wrong owner.
    if (this.archive.record(job)) this.journal.clear(id);
    return true;
  }

  /** Definitive reachable-daemon 404: the broker no longer knows the execution. */
  markBrokerKilled(id: string, message: string): boolean {
    const job = this.jobs.get(id);
    if (job === undefined || !this.brokerExecutions.has(id) || job.status !== "running") return false;
    job.status = "killed";
    job.endedAt = Date.now();
    job.error = message;
    delete job.activity;
    delete job.liveness;
    this.brokerExecutions.delete(id);
    if (this.archive.record(job)) this.journal.clear(id);
    return true;
  }

  /**
   * Return, once, the starting trees carried by jobs adopted as killed after a restart. The server
   * owns the git reader, so the store cannot render their deltas synchronously during construction.
   */
  takeAdoptedStartingTrees(): Array<{ jobId: string; cwd: string; startingTree: JournalStartingTree }> {
    const adopted = [...this.adoptedStartingTrees].map(([jobId, value]) => ({ jobId, ...value }));
    this.adoptedStartingTrees.clear();
    return adopted;
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
    if (job.status !== "running" && this.archive.record(job)) {
      // This is also an opportunistic retry of a terminal archive write that may have failed in
      // reap(). Once the richer row commits, the running-journal fallback is no longer needed.
      this.journal.clear(id);
    }
  }

  /** Publish the walk's liveness decision for the attempt now running. Pure status data only. */
  noteLiveness(id: string, liveness: LaneLiveness): void {
    const job = this.jobs.get(id);
    if (!job || job.status !== "running") return;
    job.liveness = { ...liveness };
  }

  noteLaunch(id: string, notes: readonly string[]): void {
    const job = this.jobs.get(id);
    if (!job || job.status !== "running" || notes.length === 0) return;
    job.launch = [...notes];
  }

  /** Append every settled attempt, including the winner, so polls/final output show the walk history. */
  recordAttempt(id: string, attempt: LaneAttempt): void {
    this.jobs.get(id)?.attempts.push(attempt);
  }

  /** Record walk enablement and how many selectable lanes were left untried for terminal advice. */
  noteWalkScope(id: string, scope: { enabled: boolean; lanesNotTried: number; forced?: boolean }): void {
    const job = this.jobs.get(id);
    if (!job) return;
    job.walkEnabled = scope.enabled;
    if (scope.lanesNotTried > 0) job.lanesNotTried = scope.lanesNotTried;
    if (scope.forced === true) job.forcedLane = true;
  }

  /** Count a pre-spawn skip as untried so terminal advice cannot claim ladder exhaustion. */
  noteSkippedLane(id: string): void {
    const job = this.jobs.get(id);
    if (!job) return;
    job.lanesNotTried = (job.lanesNotTried ?? 0) + 1;
  }

  /**
   * Running jobs in this MCP store whose current lane is `laneId`. `excludeJobId` avoids counting
   * the newly-created asking job itself. The cap is intentionally per MCP process, not machine-wide.
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

  /** Find a local job or lazily restore a terminal job written by another MCP process. */
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

  /** Complete a job; an explicit timeout outranks exit-code or semantic-failure classification. */
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
    // Terminal state includes process-tree cleanup before the result is observable.
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
    // Daemon-owned jobs are cancelled through the broker client. Marking them locally first would
    // clear the durable row before the actual process owner acknowledged cancellation.
    if (this.brokerExecutions.has(id)) return false;
    job.status = "cancelled";
    job.endedAt = Date.now();
    this.reap(id);
    return true;
  }

  cancelAll(): void {
    for (const id of [...this.jobs.values()].filter((j) => j.status === "running").map((j) => j.id)) {
      // Host/MCP shutdown is exactly the boundary D1 survives. Explicit dispatch_cancel goes
      // through the daemon; shutdown must leave daemon-owned work alone.
      if (this.brokerExecutions.has(id)) continue;
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
