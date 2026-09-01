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
import { quoteCmdArg } from "../lane-probe.js";
import { classifyLaneProbeOutput, type LaneProbeSpawnResult } from "../lane-quota-probe.js";
import { laneOfRung } from "../lane-manifest.js";

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

export type JobStatus = "running" | "completed" | "failed" | "cancelled";

export interface LaneJob {
  id: string;
  status: JobStatus;
  /** Ladder rung this job is running. */
  laneId: string;
  /** What the rung addresses (`pool/high`, `agy`, …), when it names one. */
  spec: string | undefined;
  startedAt: number;
  endedAt: number | undefined;
  exitCode: number | null;
  stdout: string;
  stderr: string;
  timedOut: boolean;
  cwd: string;
  /** Set only when the run failed before or during the spawn. */
  error: string | undefined;
}

/** What a completed run looks like to a caller. */
export interface LaneRunResult {
  code: number | null;
  stdout: string;
  stderr: string;
  timedOut: boolean;
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

  create(laneId: string, spec: string | undefined, cwd: string): LaneJob {
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
    };
    this.jobs.set(job.id, job);
    return job;
  }

  registerKill(id: string, kill: () => void): void {
    this.kills.set(id, kill);
  }

  get(id: string): LaneJob | undefined {
    return this.jobs.get(id);
  }

  list(): LaneJob[] {
    return [...this.jobs.values()].sort((a, b) => b.startedAt - a.startedAt);
  }

  complete(id: string, run: LaneRunResult, semanticFailure?: string): void {
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
    job.status = run.code === 0 && semanticFailure === undefined ? "completed" : "failed";
    if (semanticFailure !== undefined) job.error = semanticFailure;
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
  const normalized = normalizePath(cwd);
  const permitted = allowedRoots.some((root) => {
    const r = normalizePath(root);
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
