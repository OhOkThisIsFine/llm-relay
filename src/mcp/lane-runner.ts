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
import { exec, execFile, type ChildProcess } from "node:child_process";
import { existsSync, statSync } from "node:fs";
import { quoteCmdArg } from "../lane-probe.js";

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
export const defaultLaneSpawner: LaneSpawner = (command, args, opts) => {
  if (process.env["VITEST"]) {
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

  const execOpts = {
    encoding: "utf8" as const,
    maxBuffer: MAX_OUTPUT_BYTES,
    timeout: opts.timeoutMs,
    // ⚠ A console-subsystem child (agy.exe, codex's shim) makes Windows allocate a console when the
    // parent has none, and that console steals the desktop focus. The MCP server is launched by a
    // host that usually has no console, so this flag is not optional here.
    windowsHide: true,
    env: opts.env,
    cwd: opts.cwd,
  };

  let child: ChildProcess | undefined;
  let killed = false;

  const result = new Promise<LaneRunResult>((resolve) => {
    const settle = (
      err: (Error & { killed?: boolean | undefined; code?: unknown }) | null,
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

    child = execFile(command, args as string[], execOpts, (err, stdout, stderr) => {
      if (!err) {
        resolve({ code: 0, stdout, stderr, timedOut: false });
        return;
      }
      // An npm `.cmd` shim is not directly executable; Windows answers ENOENT. Retry through the
      // shell, quoting every token — see `quoteCmdArg`.
      if (process.platform === "win32" && (err as { code?: unknown }).code === "ENOENT" && !killed) {
        const line = `${quoteCmdArg(command)} ${args.map(quoteCmdArg).join(" ")}`;
        const fallback = exec(line, execOpts, (err2, stdout2, stderr2) => {
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
      child?.kill();
    },
  };
};

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

  complete(id: string, run: LaneRunResult): void {
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
    job.status = run.code === 0 ? "completed" : "failed";
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
