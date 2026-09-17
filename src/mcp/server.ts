/**
 * The `llm-relay mcp` server — one dispatch verb, callable from any MCP host.
 *
 * WHAT PROBLEM THIS SOLVES. `llm-relay dispatch --next-command` answers "which lane" correctly and
 * then hands the caller a COMMAND to execute. Two things go wrong with that, and both are measured:
 *
 * 1. The answer's SHAPE depends on the host. A routed Claude Code session gets a `target:` spec to
 *    address as a subagent; a bypassed or headless one gets a `run:` command. The caller must
 *    branch on mechanism, which is exactly what the owner asked never to be necessary.
 * 2. Executing the command correctly is hard. `lane-runner.ts` lists five distinct measured ways
 *    to get it wrong, each of which cost a release or a wasted lane run.
 *
 * This server removes both. Every host makes the same call and receives an ANSWER, not a command.
 *
 * WHERE IT RUNS. As a stdio child of the HOST, launched as `llm-relay mcp`. It is NOT part of the
 * relay daemon, and it answers no HTTP. The daemon's rule that no HTTP turn may spawn a lane is
 * therefore untouched — this process is the host's own spawn mechanism wearing a protocol.
 *
 * SEAMS. Every environment dependency is injected (`buildView`, `spawn`, `now`, `cwd`), so the
 * suite exercises the whole surface without spawning a real lane or spending real quota. Same
 * discipline as `lane-quota-probe.ts` and `availability-snapshot.ts`.
 */
import type { Config } from "../config.js";
import { DEFAULT_MCP_MAX_WAIT_MS } from "../config-types.js";
import type { AssistantMessage, ContentBlock, ToolUseBlock } from "../anthropic.js";
import { isToolUseBlock } from "../anthropic.js";
import type { DispatchLane, DispatchView } from "../dispatch.js";
import { formatAttemptBudget, formatLaneStats, isPassThroughSpec, LANE_UNRELIABLE_STREAK, mcpPassThroughReason } from "../dispatch.js";
import { laneOfRung } from "../lane-manifest.js";
import { estimateTokensFromCharacters } from "../metadata.js";
import type { DispatchedTelemetryReport, DispatchLaneStatus, DispatchMode } from "../dispatch-lane-stats.js";
import {
  DEFAULT_LANE_TIMEOUT_MS,
  DEFAULT_MAX_DEPTH,
  DEPTH_ENV,
  EMPTY_OUTPUT_REASON,
  LaneJobStore,
  SKIPPED_LANE_STATUS,
  attemptWasTried,
  classifyDispatchedResult,
  classifyLaneAttempt,
  checkCwd,
  currentDepth,
  defaultAnswerFetch,
  defaultLaneSpawner,
  isContentEmpty,
  readRelayAnnouncements,
  relayLoopbackUrl,
  type AnswerFetch,
  type JobStatus,
  type LaneJob,
  type LaneRunResult,
  type LaneSpawnHandle,
  type LaneSpawner,
  type DispatchedQuotaReport,
  type RelayAnnouncements,
} from "./lane-runner.js";
import { readOnlyInvoke, readOnlyVerdict, type LaneInvocation } from "./readonly-boundary.js";
import { agyQuotaStatement, type AgyLogSnapshot } from "./agy-quota-log.js";
import { nullJobJournal, type JobJournal } from "./job-journal.js";
import { nullJobArchive, type JobArchive } from "./job-archive.js";
import {
  RPC_INTERNAL_ERROR,
  RPC_INVALID_PARAMS,
  RPC_METHOD_NOT_FOUND,
  RPC_PARSE_ERROR,
  encodeMessage,
  errorResponse,
  isJsonRpcNotification,
  isJsonRpcRequest,
  logStderr,
  negotiateProtocolVersion,
  resultResponse,
  splitMessages,
  type JsonRpcResponse,
} from "./protocol.js";

export const MCP_SERVER_NAME = "llm-relay";

/** `max_tokens` for an answer-mode call when the caller names none. */
export const DEFAULT_ANSWER_MAX_TOKENS = 4096;

/** How many jobs `dispatch_status` lists when it is called without a jobId. */
export const RECENT_JOBS_LISTED = 20;

/**
 * How a dispatch view is obtained. Injected rather than imported so this module never decides
 * whether to consult the running relay — the caller owns that, exactly as `buildDispatch` takes
 * the host verdict as an argument instead of sniffing for it.
 */
export type DispatchViewBuilder = (opts: {
  task: string | undefined;
  tier: string | undefined;
  lane: string | undefined;
  /**
   * How this dispatch will run its lanes, so the relay hands back budgets measured in the SAME mode
   * (`DispatchMode`). Absent from `dispatch_lanes`, which runs nothing.
   */
  mode?: DispatchMode | undefined;
  /** A routing spec to run as its own one-lane view instead of the ladder (`dispatch`'s `model`). */
  model?: string | undefined;
}) => Promise<DispatchView>;

export interface McpServerDeps {
  config: Config;
  buildView: DispatchViewBuilder;
  spawn?: LaneSpawner;
  /**
   * Answer-mode's direct-HTTP seam — a POST to THIS relay's own `/v1/messages`, reading
   * `config.host`/`.port`. Never the vendor egress fetches other modules inject; this is the one
   * call answer mode makes.
   */
  fetch?: AnswerFetch;
  now?: () => number;
  /** Default working directory for a lane when the caller names none. */
  cwd?: () => string;
  /** Operator bound on caller-supplied directories; absent ⇒ existence check only. */
  allowedRoots?: readonly string[];
  maxDepth?: number;
  /**
   * Version reported in `serverInfo`. Injected because `process.env.npm_package_version` is only
   * set when npm launched the process, and a host launches this one directly — so reading it here
   * reported "0.0.0" to every real client. Measured on the first live handshake.
   */
  version?: string;
  /** Reports positive lane quota evidence to the relay's exhaustion state. */
  reportExhaustion?: (report: DispatchedQuotaReport) => Promise<void> | void;
  /**
   * Forwards one metadata-only lane-execution report per settled agent-mode job to the
   * daemon's `POST /dispatch/telemetry`. Counts and lengths only — never the task text,
   * never the lane's output.
   */
  reportTelemetry?: (report: DispatchedTelemetryReport) => Promise<void> | void;
  /**
   * The running-job journal. Absent ⇒ `nullJobJournal`, which records nothing: a programmatic
   * embed that does not want a file gets the pre-journal behaviour exactly. `cli.ts` passes the
   * real one, so a host-launched server can report the jobs a previous instance died holding.
   */
  journal?: JobJournal;
  /**
   * The finished-job archive. Absent ⇒ `nullJobArchive`, which keeps nothing. `cli.ts` passes the
   * real one, so a job that ENDED before a restart still answers `dispatch_result` afterwards and
   * job ids continue past the highest one the previous process minted (`job-archive.ts`).
   */
  archive?: JobArchive;
  /**
   * The llm-relay version INSTALLED on disk now, read fresh on each call — or null when unknown.
   * When it differs from `version` (the code this process started with), every tool reply says so:
   * the Claude desktop app keeps one MCP process alive across sessions and releases, and on
   * 2026-09-10 two processes from before v0.78.0 were still serving old code with no sign of it.
   */
  installedVersion?: () => string | null;
  /**
   * AGY's log, read after an AGY lane ends or is stopped, so a quota death AGY stated only in its
   * log still reaches the relay (`agy-quota-log.ts`). Absent ⇒ never read.
   */
  readAgyLog?: () => AgyLogSnapshot | null;
  write: (chunk: string) => void;
}

interface ToolDefinition {
  name: string;
  title: string;
  description: string;
  inputSchema: Record<string, unknown>;
}

/**
 * The `initialize` instructions. An MCP host puts this in the model's system prompt
 * unconditionally, so it is the ONE channel here that cannot be deferred, collapsed to a bare
 * tool name, or missed because the model never went looking. The tool descriptions below say
 * WHAT each tool does; a host only reads them once the model has already decided to delegate.
 *
 * ⚠ So this text must state WHEN to delegate, not just what the tool is. It carried only the
 * "what" until 2026-08-30, and the measured consequence was that the operator had to say
 * "use llm-relay for offload" out loud — on a machine whose own CLAUDE.md already said
 * "PREFER THE MCP TOOL" in bold. Prose the model must go and find is not a trigger.
 *
 * Keep it short: every host pays for it in every session. Pinned by `test/mcp-server.test.ts`.
 */
export const MCP_INSTRUCTIONS =
  "Use dispatch from every MCP host — Claude, Codex, desktop, CLI, or otherwise — to hand a " +
  "whole task to another agent lane and get its answer back. Never choose a host-specific child " +
  "mechanism yourself; whether the lane is a model pool or a peer CLI is resolved here.\n\n" +
  "Reach for it on your own, without being asked. Offload a task when it is self-contained and " +
  "its result is a conclusion you can check: a broad code search, a file-by-file sweep, a " +
  "survey, a draft, a long summary, a second opinion. Keep in this session whatever needs your " +
  "own conversation context or edits you must supervise. The default lane is the relay's model " +
  "pool: offloading spends none of this session's subscription quota and saves its context (the " +
  "pool may spend the owner's paid provider credits, such as DeepSeek). On Windows it " +
  "centralizes hidden child creation, closes stdin so headless agents do not stall, and applies " +
  "each lane's configured timeouts. Prefer it over launching an agent alias from a shell. A " +
  "third-party CLI observed creating visible descendants must be disabled until reverified. " +
  "Do not use a pool/* native collaboration child from Codex Desktop: with a ChatGPT account, " +
  "Desktop rejects that child model before reaching the relay and ignores its custom provider. " +
  "Call dispatch instead. If this MCP server is unavailable, run `llm-relay dispatch " +
  "--next-command -t <task>` and follow its returned command or target; do not guess from the host.\n\n" +
  "Let dispatch choose the lane. If a lane is slow or silent, dispatch moves to the next one " +
  "itself and prefers the lane that answered on your next call. Follow the advice at the end of a " +
  "reply: when it says a lane was stopped while it was still working, dispatch again with that " +
  "lane named so it can finish; when it says every lane ran and failed, do the work here — " +
  "re-dispatching the same task picks the same lanes. To run one specific model instead of the " +
  "ladder (for example deepseek/deepseek-flash or pool/high), pass model.\n\n" +
  "Pass mode: \"answer\" for a question, draft, summary, or second opinion that needs no file " +
  "access — for a relay lane it posts straight to this relay's own /v1/messages with no spawned " +
  "harness, so it answers faster. Use the default agent mode when the lane must read or edit " +
  "files or run commands.\n\n" +
  "Lane output is advisory. Verify it against the source before you act on it.";

/**
 * The tool set, kept deliberately small.
 *
 * `agent-dispatch`, the closest prior art, exposes about twenty tools. That is the opposite of the
 * stated requirement ("one verb, host-adapted"), so this exposes one verb plus the job control a
 * long lane needs, plus one read for choosing a lane deliberately.
 */
const TOOLS: ToolDefinition[] = [
  {
    name: "dispatch",
    title: "Dispatch a task to another agent",
    description:
      "Hand a whole task to the best available agent lane (a relay model pool, or a peer agent CLI " +
      "such as Codex or Antigravity) and return its answer. Reach for this without being asked " +
      "whenever a task is self-contained and its result is a conclusion you can check — a broad " +
      "code search, a file-by-file sweep, a survey, a draft, a second opinion — because the " +
      "default lane spends none of this session's subscription quota and saves its context. " +
      "Pass model to run one specific model (a routing spec such as deepseek/deepseek-flash or " +
      "pool/high) as its own lane, with no walk. Otherwise it picks the lane from " +
      "the configured ladder unless you name one, and WALKS that ladder for you: a lane that does " +
      "not answer inside its budget is stopped and the next one is started, and the lane that " +
      "answers is preferred next time. Runs the lane correctly — working directory, " +
      "environment and idle timeouts are handled here, so you never build a command line. If the " +
      "lane is still running, returns a jobId to poll with dispatch_status — it blocks at most " +
      "routing.mcp.maxWaitMs first, so a slow lane degrades to polling instead of hitting the " +
      "host's tool timeout. In Codex " +
      "Desktop, use this instead of a pool/* collaboration child, which the ChatGPT launcher " +
      "rejects before the custom provider or relay is reached. Set mode to \"answer\" for a " +
      "question, draft, summary, or second opinion that needs no file access — it posts straight " +
      "to the relay with no spawned harness; keep the default agent mode when the lane must read " +
      "or edit files or run commands.",
    inputSchema: {
      type: "object",
      properties: {
        task: {
          type: "string",
          description: "The complete, self-contained task. The lane sees only this text.",
        },
        mode: {
          type: "string",
          enum: ["agent", "answer"],
          description:
            "\"agent\" (default): spawn the lane's own harness with full tool access. " +
            "\"answer\": for a relay lane (a model pool), skip the harness and POST straight to " +
            "this relay's own /v1/messages — use it for a question, draft, summary, or second " +
            "opinion that needs no file access; a cli lane (agy, codex) behaves exactly like " +
            "agent mode either way, since it has no direct-HTTP form.",
        },
        system: {
          type: "string",
          description: "Answer mode only: an optional system prompt for the direct relay call.",
        },
        schema: {
          type: "object",
          description:
            "Answer mode only: a JSON Schema. When given, the relay call forces a single " +
            "\"answer\" tool call and the result is that tool's input, JSON-stringified, instead " +
            "of free text.",
        },
        maxTokens: {
          type: "number",
          description: `Answer mode only: max_tokens for the direct relay call (default ${DEFAULT_ANSWER_MAX_TOKENS}).`,
        },
        tier: {
          type: "string",
          description: "Capability tier to select the ladder from (for example low, medium, high, xhigh).",
        },
        lane: {
          type: "string",
          description: "Force a specific ladder rung by id instead of taking the ladder's own order.",
        },
        model: {
          type: "string",
          description:
            "Run ONE specific model instead of the ladder: a routing spec such as " +
            "deepseek/deepseek-flash, openrouter/<model> or pool/high. It runs as its own lane with " +
            "no walk, in either mode. Cannot be combined with lane.",
        },
        cwd: {
          type: "string",
          description: "Agent mode only: absolute directory to run the lane in. Defaults to this server's working directory.",
        },
        waitMs: {
          type: "number",
          description:
            "How long to block before returning a jobId instead (default routing.mcp.maxWaitMs; " +
            "a larger waitMs is clamped to that ceiling and the clamp is announced in the reply).",
        },
        timeoutMs: {
          type: "number",
          description: `Hard ceiling on the lane run (default ${DEFAULT_LANE_TIMEOUT_MS}).`,
        },
        readOnly: {
          type: "boolean",
          description:
            "Declare that this dispatch must not mutate anything — a review, a survey, a second " +
            "opinion. The relay then REFUSES a working directory inside the caller's own tree, " +
            "rather than trusting the task text to say \"do not edit\": a measured read-only lane " +
            "committed and pushed the caller's in-progress files, and another silently reverted a " +
            "staged one. Pass cwd pointing at a separate checkout, or use mode \"answer\", which " +
            "spawns no harness and cannot touch the filesystem at all. It ALSO binds the lane's " +
            "TOOLS: a claude lane runs with only Read/Glob/Grep/WebFetch/WebSearch under " +
            "--permission-mode dontAsk, a codex lane runs under --sandbox read-only, and a lane " +
            "whose CLI offers no read-only binding (opencode, agy) is skipped with the reason " +
            "rather than run unbound.",
        },
      },
      required: ["task"],
      additionalProperties: false,
    },
  },
  {
    name: "dispatch_status",
    title: "Check a dispatched job",
    description:
      "Report a dispatched job. While it runs: its lane, elapsed time and output so far. Once it " +
      "has ended: its full answer, exactly as dispatch_result returns it. Wait at least a few " +
      "seconds between polls. Without jobId: list the recent jobs of every llm-relay MCP server " +
      "on this machine, so a lost jobId can be found again.",
    inputSchema: {
      type: "object",
      properties: {
        jobId: { type: "string", description: "The jobId dispatch returned. Omit it to list recent jobs." },
      },
      additionalProperties: false,
    },
  },
  {
    name: "dispatch_result",
    title: "Collect a dispatched job's answer",
    description: "Return the full output of a finished dispatched job.",
    inputSchema: {
      type: "object",
      properties: { jobId: { type: "string", description: "The jobId dispatch returned." } },
      required: ["jobId"],
      additionalProperties: false,
    },
  },
  {
    name: "dispatch_cancel",
    title: "Stop a dispatched job",
    description: "Kill a running dispatched lane and mark its job cancelled.",
    inputSchema: {
      type: "object",
      properties: { jobId: { type: "string", description: "The jobId dispatch returned." } },
      required: ["jobId"],
      additionalProperties: false,
    },
  },
  {
    name: "dispatch_lanes",
    title: "List available agent lanes",
    description:
      "Show the configured dispatch ladder — which lanes are ready, which are quota-exhausted and " +
      "when they recover. Call this only to choose a lane deliberately; plain dispatch already " +
      "picks the best ready one.",
    inputSchema: {
      type: "object",
      properties: { tier: { type: "string", description: "Ladder tier to show." } },
      additionalProperties: false,
    },
  },
];

/** MCP tool results are a content array; every answer here is one text block. */
function textResult(text: string, isError = false): Record<string, unknown> {
  return { content: [{ type: "text", text }], isError };
}

function readString(params: Record<string, unknown>, key: string): string | undefined {
  const v = params[key];
  return typeof v === "string" && v.length > 0 ? v : undefined;
}

function readNumber(params: Record<string, unknown>, key: string): number | undefined {
  const v = params[key];
  return typeof v === "number" && Number.isFinite(v) && v > 0 ? v : undefined;
}

/** Any value other than exactly `"answer"` — including absence, garbage, or `"agent"` — is agent mode. */
function readMode(params: Record<string, unknown>): "agent" | "answer" {
  return params["mode"] === "answer" ? "answer" : "agent";
}

/**
 * What one `dispatch` call may block for, decided in exactly one place.
 *
 * An MCP host tool call fails between 45 s and 100 s on this machine and destroys the job
 * handle above that, so no call may block past `routing.mcp.maxWaitMs` (the `ceiling`): absent
 * waits the full ceiling, a larger `waitMs` is clamped to it (and `awaitOrPoll` announces the
 * clamp), and a `waitMs` the server cannot honour at all — negative, zero, non-finite, or not
 * a number — is a `refusal`, the property's second branch. The union is narrowed with `in`
 * at the one call site, never an unconditional `else` resolving to a wait.
 */
export type ResolvedWaitMs = { waitMs: number; clamped: boolean; requested: number } | { refusal: string };

export function resolveWaitMs(requested: unknown, ceiling: number): ResolvedWaitMs {
  if (requested === undefined || requested === null) {
    return { waitMs: ceiling, clamped: false, requested: ceiling };
  }
  if (typeof requested !== "number" || !Number.isFinite(requested) || requested <= 0) {
    const seen = typeof requested === "string" ? JSON.stringify(requested) : String(requested);
    return {
      refusal:
        `dispatch refused: waitMs must be a positive finite number of milliseconds (got ${seen}). ` +
        `The blocking wait is bounded by routing.mcp.maxWaitMs (currently ${ceiling} ms): omit ` +
        `waitMs to wait the full ceiling, or pass a smaller one — a larger one is clamped to the ` +
        `ceiling and the clamp is announced.`,
    };
  }
  if (requested > ceiling) {
    return { waitMs: ceiling, clamped: true, requested };
  }
  return { waitMs: requested, clamped: false, requested };
}

/** A JSON Schema object for `schema`. Arrays and `null` are not schemas, so both are declined. */
function readRecord(params: Record<string, unknown>, key: string): Record<string, unknown> | undefined {
  const v = params[key];
  return typeof v === "object" && v !== null && !Array.isArray(v) ? (v as Record<string, unknown>) : undefined;
}

/**
 * `"timed_out"` and `"killed"` join `"failed"` as error results for the MCP `isError` flag — a
 * caller that only checks `isError` must not read a lane that never finished as a success.
 *
 * ⚠ A total switch closed with `const _never: never`, not an `||` chain. The union grew a member
 * this lap (`"killed"`) and the chain form would have absorbed it silently as a SUCCESS — the
 * closed-union defect CLAUDE.md records eight times, in the one function whose whole job is to keep
 * a dead lane from reading as a live answer.
 */
function isFailureStatus(status: JobStatus): boolean {
  switch (status) {
    case "completed":
      return false;
    case "failed":
    case "timed_out":
    case "killed":
      return true;
    case "running":
    case "cancelled":
      return false;
    default: {
      const _never: never = status;
      return _never;
    }
  }
}

/**
 * A lane's usual time to answer, as a running job's status and `dispatch_lanes` both print it: the
 * median and 80th percentile of its own completed runs, and the mode they ran in when known.
 */
function formatTimeToAnswer(t: {
  medianMs: number | null;
  p80Ms: number | null;
  samples: number;
  mode?: DispatchMode | null;
}): string {
  const s = (ms: number | null): string => (ms === null ? "n/a" : `${Math.round(ms / 1000)}s`);
  const inMode = t.mode ? `, ${t.mode} mode` : "";
  // "on record", not "completed": a window written before 2026-09-10 may still hold a duration of a
  // run that did not answer (`restoreLaneStatsRows` empties only a window that PROVABLY does).
  const runs = `${t.samples} run${t.samples === 1 ? "" : "s"} on record${inMode}`;
  return `usually answers in: median ${s(t.medianMs)}, p80 ${s(t.p80Ms)} (${runs})`;
}

/**
 * A RUNNING job's line about its lane's usual time to answer — or a plain statement that none is
 * known. Never silence: a caller that sees no figure cannot tell "no record" from "not reported".
 */
function runningTimeToAnswer(job: LaneJob): string | null {
  if (job.status !== "running") return null;
  return job.expected
    ? formatTimeToAnswer(job.expected)
    : "usually answers in: not known (no completed run on record for this lane)";
}

/**
 * A RUNNING spawned attempt's output so far: how long the lane has been silent, or how much it has
 * written and how long ago. Null for anything else — a finished job, or an answer-mode call, which
 * has no output stream and must not read as "silent".
 *
 * ⚠ The zero-output line says why silence alone proves nothing: `claude -p` buffers its whole
 * answer until exit. Without that, a caller reading "silent for 300 s" on the free pool would cancel
 * a healthy run — the false failure the backlog item names as worse than an honest slow status.
 */
export function describeActivity(job: LaneJob, now: number): string | null {
  if (job.status !== "running" || job.activity === undefined) return null;
  const a = job.activity;
  const s = (ms: number): string => `${Math.max(0, Math.round(ms / 1000))}s`;
  if (a.lastOutputAt === null) {
    return (
      `output: none yet — silent for ${s(now - a.attemptStartedAt)} since this lane started ` +
      "(a lane that buffers its answer until exit, such as claude -p, is silent while it works)"
    );
  }
  return (
    `output: ${a.stdoutBytes + a.stderrBytes} bytes so far (stdout ${a.stdoutBytes}, stderr ${a.stderrBytes}); ` +
    `last output ${s(now - a.lastOutputAt)} ago`
  );
}

/**
 * What `dispatch_lanes` says about a lane beyond its configuration: where an ad-hoc lane came from,
 * its usual time to answer, and its own failures in a row.
 */
function laneEvidenceBits(lane: DispatchLane): string[] {
  const bits: string[] = [];
  if (lane.adHoc) bits.push("(named by model, not a ladder rung)");
  if (lane.timeToAnswer) bits.push(formatTimeToAnswer(lane.timeToAnswer));
  if (lane.failing) bits.push(`failing: ${lane.failing.reason}`);
  else if (lane.recentFailures) bits.push(`${lane.recentFailures} own failure${lane.recentFailures === 1 ? "" : "s"} in a row`);
  return bits;
}

/**
 * Render a job for a caller.
 *
 * ⚠ The lane's own stdout is reported as the ANSWER, and the lane is NAMED beside it. This
 * repository's rule is that dispatch "never pretends a CLI answered" — a result that hid which
 * lane produced it would do exactly that, so provenance rides every response.
 */
function describeJob(job: LaneJob, now: number): string {
  const elapsed = Math.round(((job.endedAt ?? now) - job.startedAt) / 1000);
  const head = [
    `job: ${job.id}`,
    `lane: ${job.laneId}${job.spec ? ` (${job.spec})` : ""}`,
    `status: ${job.status}`,
    `elapsed: ${elapsed}s`,
  ];
  if (job.exitCode !== null) head.push(`exit: ${job.exitCode}`);
  if (job.timedOut) head.push("timed out: yes");
  if (job.error) head.push(`error: ${job.error}`);
  // Answer-mode provenance — the direct-HTTP sibling of the lane id/spec/elapsed every job
  // already carries. Absent for every agent-mode job, which never touches HTTP directly.
  if (job.relay?.servedBy) head.push(`served-by: ${job.relay.servedBy}`);
  if (job.relay?.poolAttempts) head.push(`pool-attempts: ${job.relay.poolAttempts}`);
  if (job.relay?.hedged) head.push(`hedged: ${job.relay.hedged}`);
  if (job.relay?.latencyDemoted) head.push(`latency-demoted: ${job.relay.latencyDemoted}`);
  if (job.relay?.degraded) head.push(`degraded: ${job.relay.degraded}`);
  if (job.dispatchSource === "fallback") head.push("dispatch-source: local-fallback (daemon unreachable)");
  if (job.restored === true) {
    head.push(
      "record: restored from disk — this job ended in an earlier llm-relay MCP server process or in another host's one",
    );
  }
  if (job.readOnly) head.push(`read-only: ${job.readOnly.binding}`);
  // While it runs: the lane's usual time to answer, from its own completed runs, so a caller can tell
  // a slow lane from a stuck one instead of giving up (`LaneJob.expected`).
  const usually = runningTimeToAnswer(job);
  if (usually !== null) head.push(usually);
  // And what the running attempt has produced, so a caller can see a SILENT lane for what it is
  // rather than reading `running` for nine minutes (`LaneActivity`).
  const output = describeActivity(job, now);
  if (output !== null) head.push(output);
  // ⚠ Only when there is something to say. Every ordinary job reaps cleanly, and a line on all of
  // them would be noise that trains the reader to skip the one that matters. A SURVIVOR is the case
  // `docs/backlog.md` measured — nothing short of a process enumeration finds those — so it is
  // named here with the pid, beside the job id that owned it.
  if (job.process?.survivors.length) {
    head.push(
      `owned processes STILL RUNNING after ${job.id} ended: ${job.process.survivors.join(", ")} ` +
        "(relay-started, not reaped)",
    );
  }
  // ⚠ The lanes already tried belong HERE, not only on the final answer. A poll of a running walk
  // has to say which lanes it has already spent — otherwise `dispatch_status` reports one lane
  // name and the operator cannot tell a walk on its third lane from one that never moved.
  const walked = describeAttempts(job);
  return walked ? `${head.join("\n")}\n\n${walked}` : head.join("\n");
}

/**
 * What a caller is told when the walk tried every lane it had and none of them answered.
 *
 * ⚠ **This IS the last rung of the ladder.** The owner's request ends *"until finally reaching the
 * base agent's own subagents"*, and the relay cannot start the caller's subagent — it decides
 * ORDER, the host executes, which is the standing boundary this project keeps everywhere else. So
 * the final fallback is an ANSWER, and the text carries the whole instruction: what to do now, and
 * what NOT to do. Without the second half a caller retries `dispatch` for the same task, which is
 * the loop this feature exists to end.
 *
 * Pinned by `test/dispatch-lane-walk.test.ts` on its CLAIMS rather than its wording — reword it
 * freely, but change the assertion deliberately instead of deleting it. (This said
 * `test/mcp-server.test.ts` until an independent closeout audit caught it on 2026-09-08; the
 * assertions never lived there. A citation that sends the reader to the wrong file is the exact
 * failure the repository's cite-symbols-not-line-numbers rule exists to avoid.)
 */
export const LANE_LADDER_EXHAUSTED_ADVICE =
  "Every dispatch lane has now been tried for this task and none of them answered. "
  + "Do NOT call dispatch again for this task — it would pick the same lanes. "
  + "Do the work in this session instead, with your own subagent if you have one.";

/**
 * What a caller is told when lanes REMAIN untried — the walk stopped at its own `maxLanes` bound.
 *
 * ⚠ This exists because the advice above was firing on a walk that had not exhausted anything
 * (found by adversarial review, 2026-09-06). Both of its sentences were then false: lanes remained,
 * and "it would pick the same lanes" is wrong precisely because the walk has just DEMOTED every
 * lane it tried, so the next dispatch reorders around them. Telling an autonomous caller to stop
 * delegating, on a false premise, abandons capacity that was never contacted.
 */
export const LANE_LADDER_PARTIAL_ADVICE =
  "Lanes remain untried: this dispatch stopped at its maxLanes bound. Call dispatch again to "
  + "reach them — the lanes above are now demoted, so it will pick different ones — or do the "
  + "work in this session.";

/**
 * What a caller is told when the walk STOPPED a lane at its time budget and nothing answered after.
 *
 * ⚠ The stopped lane did not fail: it was still working when the walk moved on. So "every dispatch
 * lane has now been tried" was false there, and it ended the caller's use of dispatch for a task the
 * stopped lane would have finished (`docs/dispatch-giveup-diagnosis-2026-09-10.md` §5). A NAMED lane
 * runs with no budget, so this names the call that lets it finish.
 */
export function laneStoppedAdvice(laneId: string): string {
  return (
    `The walk stopped lane "${laneId}" at its time budget while it was still working — it did not ` +
    `fail. To let it finish, call dispatch again with lane: "${laneId}" and the same tier and mode (a ` +
    "named lane runs with no budget, only its own timeout), or do the work in this session."
  );
}

/**
 * What a caller is told when it NAMED the lane or the model and that one lane did not answer. Only
 * that lane ran, so "every dispatch lane has now been tried" would be false — measured 2026-09-10 on
 * jobs 0023 and 0024, which each ran one forced lane and were told to stop delegating.
 */
export const FORCED_LANE_ADVICE =
  "Only the lane you named was tried, and it did not answer. Call dispatch without lane or model to "
  + "let the walk try the other lanes, or do the work in this session.";

/**
 * The advice that ends a reply in which no lane answered — the one place that chooses it, so a new
 * case cannot be handled in one renderer and missed in another.
 *
 * ⚠ Order matters: with the walk off, no advice at all (the documented byte-for-byte revert); a
 * forced lane next, because it ran alone on purpose; then a lane the walk stopped while it still
 * worked, because that lane is the likeliest to answer; then lanes left untried; and only when every
 * lane ran and failed on its own, the advice to stop delegating this task.
 */
function terminalAdvice(job: LaneJob): string {
  if (job.walkEnabled !== true) return "";
  if (job.forcedLane === true) return `\n\n${FORCED_LANE_ADVICE}`;
  const stopped = job.attempts.find((a) => a.status === "abandoned");
  if (stopped !== undefined) return `\n\n${laneStoppedAdvice(stopped.laneId)}`;
  if (job.lanesNotTried) return `\n\n${LANE_LADDER_PARTIAL_ADVICE}`;
  return `\n\n${LANE_LADDER_EXHAUSTED_ADVICE}`;
}

/**
 * Render the lanes a walk tried, oldest first, so both a poll and the final answer show what it
 * cost to get here.
 *
 * ⚠ Empty string for a walk that has tried nothing yet. A bare "lanes tried:" header with no lanes
 * under it reads as a walk that tried and found nothing, which is the opposite of the truth for a
 * walk still on its first lane — or for one the caller cancelled before any lane settled.
 */
function describeAttempts(job: LaneJob): string {
  if (job.attempts.length === 0 && !job.lanesNotTried) return "";
  const lines = job.attempts.map((a, i) => {
    const seconds = Math.round(a.elapsedMs / 1000);
    const why = a.reason ? ` — ${a.reason}` : "";
    return `  ${i + 1}. ${a.laneId}${a.spec ? ` (${a.spec})` : ""}: ${a.status} after ${seconds}s${why}`;
  });
  // No silent caps: a walk that stopped at its `maxLanes` bound says so, because "lanes tried"
  // with nothing after it reads as "all of them".
  const capped = job.lanesNotTried
    ? `\n  (${job.lanesNotTried} further lane${job.lanesNotTried === 1 ? "" : "s"} not tried — the walk's maxLanes bound)`
    : "";
  return `lanes tried:\n${lines.join("\n")}${capped}`;
}

function jobAnswer(job: LaneJob, now: number): string {
  const header = describeJob(job, now);
  const body = job.stdout.trim();
  // ⚠ The lanes tried are NOT rendered here — `describeJob` owns them now, so a poll and the final
  // answer show the same list rather than two nearly-identical renderings that can drift apart.
  // The terminal fallback fires only when the walk ended with NO answer from any lane. A cancelled
  // job is excluded: the caller stopped it, so the ladder was never exhausted.
  // ⚠ Three conditions, and the last two were MISSING until adversarial review found it
  // (2026-09-06). "No lane answered" is not the same claim as "every lane was tried":
  //   - with `routing.dispatchWalk: false` exactly ONE lane runs, and the pre-walk answer carried
  //     no advice at all — emitting it there breaks the documented byte-for-byte revert;
  //   - with `maxLanes` below the selectable count the walk stopped early, and the answer would
  //     then contain BOTH "N further lanes not tried" and "every lane has now been tried".
  // A caller that stops delegating on a false premise abandons capacity nothing contacted.
  const nothingAnswered =
    job.status !== "running"
    && job.status !== "cancelled"
    && job.attempts.length > 0
    && job.attempts.every((a) => a.status !== "completed");
  // `terminalAdvice` is the one place that chooses among the endings: forced, stopped, partial,
  // exhausted.
  const exhausted = nothingAnswered ? terminalAdvice(job) : "";
  if (job.status === "running") {
    return `${header}\n\nStill running. Poll dispatch_status, then call dispatch_result.`;
  }
  if (job.status === "killed") {
    // ⚠ Its own branch, NOT folded into `timed_out`. The lane did not exceed anything and it did not
    // fail: the MCP server restarted underneath it. The next action differs too — nothing is
    // collectable and nothing is on disk unless the lane wrote it early — so the header's `error:`
    // line explains the restart, and the empty-output branch below (which advises a retry) is
    // deliberately not reached.
    return `${header}\n\nThe lane was KILLED when the llm-relay MCP server restarted — it did not fail and it did not time out. Its process is gone. Re-dispatch from scratch, and check the working directory first: only files the lane wrote before the restart survive.`;
  }
  if (job.status === "timed_out") {
    // ⚠ A timed-out dispatch must never render nothing (C:\Code\docs\backlog.md — a bounded
    // design dispatch consumed its full 1,200s wait and surfaced no usable answer). The header
    // above already carries status + elapsed + the one-line reason (`error:`); this adds
    // whatever partial output the killed run actually captured, when any survived.
    const partial = isContentEmpty(body) ? "" : `\n\nPartial output before the timeout:\n\n${body}`;
    const tail = isContentEmpty(body) ? job.stderr.trim().slice(-1500) : "";
    return `${header}\n\nThe lane exceeded its timeout and was stopped before it finished.${partial}${
      tail ? `\n\nstderr tail:\n${tail}` : ""
    }${exhausted}`;
  }
  if (isContentEmpty(body)) {
    // ⚠ Exit 0 (or HTTP 200) with content-empty output is a KNOWN lane failure mode (agy discards
    // long answers; a free model sometimes answers a lone `#`), and it must not read as a
    // successful empty answer. Say so rather than returning nothing.
    const tail = job.stderr.trim().slice(-1500);
    return `${header}\n\nThe lane returned NO output. Treat this as a lane failure and retry, or pick another lane.${
      tail ? `\n\nstderr tail:\n${tail}` : ""
    }${exhausted}`;
  }
  return `${header}\n\n${body}${exhausted}`;
}

/**
 * Everything one dispatch WALK needs, snapshotted once so no stage re-reads `args`.
 *
 * `attemptMs` is `null` when the walk is turned off — never `Infinity`. Node's `setTimeout` clamps
 * a value above 2^31-1 to 1 ms and warns, so an "infinite" budget would abandon every lane
 * IMMEDIATELY, which is the exact opposite of what it would be claiming to do.
 */
interface WalkOptions {
  mode: "agent" | "answer";
  cwd: string;
  depth: number;
  /**
   * The caller declared the dispatch read-only. Every SPAWNED lane is then handed a read-only tool
   * binding (`readOnlyInvoke`) or skipped when its CLI offers none; an answer-mode relay call needs
   * neither, since it spawns nothing.
   */
  readOnly: boolean;
  /** Ladder tier the lanes came from, for quota reports and the daemon's routing memory. */
  tier: string | undefined;
  /** The lane's OWN ceiling, unchanged by this feature. */
  timeoutMs: number;
  /** The WALK's per-lane budget, or null for no budget (walk off, or the last lane). */
  attemptMs: number | null;
  system: string | undefined;
  schema: Record<string, unknown> | undefined;
  maxTokens: number | undefined;
  dispatchSource: "daemon" | "fallback";
}

/** What running one lane produced. */
interface LaneAttemptOutcome {
  run: LaneRunResult;
  relay?: RelayAnnouncements;
  semanticFailure?: string;
  /** The walk stopped this lane at its budget so it could try the next one. */
  abandoned: boolean;
  /**
   * The CALLER made an error no lane can fix — today only a working directory that does not exist
   * or sits outside the operator's declared roots. It ENDS the walk, because every remaining lane
   * would hit it identically and walking on would hide the caller's own mistake behind a lane
   * failure.
   */
  refusal?: string;
}

/** A run that produced nothing: the shape an abandoned or never-started attempt reports. */
function emptyRun(): LaneRunResult {
  return { code: null, stdout: "", stderr: "", timedOut: false };
}

/** An attempt that failed before it could produce anything, carrying why. */
function failedOutcome(message: string): LaneAttemptOutcome {
  return {
    run: { code: null, stdout: "", stderr: message, timedOut: false },
    abandoned: false,
    semanticFailure: message,
  };
}

/**
 * One line saying why an attempt ended as it did, for the `lanes tried:` list. Undefined for a
 * success — the status already says everything, and repeating it would be noise.
 *
 * ⚠ The abandoned wording names the BUDGET, not the lane's own timeout. An operator reading
 * "abandoned after 90s" against a rung configured with `--timeout 2100` must be able to tell that
 * the relay made a routing decision rather than the lane running out of its own time.
 */
function attemptReason(
  status: DispatchLaneStatus,
  outcome: LaneAttemptOutcome,
  elapsedMs: number,
  budgetMs: number | null,
): string | undefined {
  if (status === "completed") return undefined;
  if (status === "abandoned") {
    const budget = budgetMs === null ? `${Math.round(elapsedMs / 1000)}s` : `${Math.round(budgetMs / 1000)}s`;
    return `no answer within the ${budget} walk budget, so the next lane was started`;
  }
  if (outcome.semanticFailure !== undefined) return outcome.semanticFailure;
  if (status === "timed_out") return "the lane exceeded its own configured timeout";
  if (status === "failed") return "the lane failed";
  // ⚠ Total over `DispatchLaneStatus`, not a bare fall-through. The union GREW this sprint
  // (`abandoned`), which is the proof it grows; before this, a fifth member would have rendered
  // silently as "the lane failed" — the repository's most repeated defect class, an unhandled
  // member of a closed union resolving to a claim nobody checked.
  const _never: never = status;
  return String(_never);
}

/** The value a command passes for `flag`, as `--flag value` or `--flag=value`; null when absent. */
function flagValue(args: readonly string[], flag: string): string | null {
  const i = args.indexOf(flag);
  if (i >= 0 && i + 1 < args.length) return args[i + 1] ?? null;
  const joined = args.find((a) => a.startsWith(`${flag}=`));
  return joined === undefined ? null : joined.slice(flag.length + 1);
}

/** Did a spawned lane produce a usable answer? Exit 0, inside its own time, with real content. */
function laneAnswered(r: LaneRunResult): boolean {
  return r.code === 0 && !r.timedOut && !isContentEmpty(r.stdout);
}

/** Apply a rung's declared env deltas: a string sets, `null` unsets an inherited variable. */
function applyLaneEnv(base: NodeJS.ProcessEnv, deltas: Record<string, string | null> | undefined): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...base };
  for (const [name, value] of Object.entries(deltas ?? {})) {
    if (value === null) delete env[name];
    else env[name] = value;
  }
  return env;
}

/**
 * `inFlight` is THIS MCP server process's own live count for `lane.id` (`LaneJobStore.inFlight`) —
 * a caller-supplied number, never read here, because only the process that could spawn a job knows
 * what it is currently running. Rendered beside the attempt budget: `in flight: <n> of <max>` for a
 * capped rung (always, even at 0, so an operator sees the cap is configured before it ever binds),
 * and `in flight: <n>` for an uncapped one ONLY when `n > 0` — an uncapped rung with nothing running
 * renders exactly as it did before this field existed, which is the "byte-for-byte unchanged with
 * no maxConcurrent configured" guarantee made visible in the rendering, not just in the data.
 */
function laneSummary(lane: DispatchLane, inFlight: number): string {
  const bits = [`${lane.position}. ${lane.id}`, `[${lane.state}]`];
  if (lane.spec) bits.push(lane.spec);
  if (lane.readyAt) bits.push(`ready ${lane.readyAt}`);
  if (lane.notServable) bits.push(`not servable: ${lane.notServable}`);
  if (lane.unreachable) bits.push(`unreachable: ${lane.unreachable}`);
  if (lane.note) bits.push(lane.note);
  // The routing memory from previous walks, on the lane rather than only in the selection reason —
  // an operator reading `dispatch_lanes` to understand an unexpected order needs to see it here.
  if (lane.attemptBudget) bits.push(formatAttemptBudget(lane.attemptBudget));
  bits.push(...laneEvidenceBits(lane));
  if (lane.maxConcurrent !== null && lane.maxConcurrent !== undefined) {
    bits.push(`in flight: ${inFlight} of ${lane.maxConcurrent}`);
  } else if (inFlight > 0) {
    bits.push(`in flight: ${inFlight}`);
  }
  if (lane.pinned) bits.push(`pinned until ${lane.pinned.until} (${lane.pinned.reason})`);
  if (lane.demoted) bits.push(`demoted until ${lane.demoted.until} (${lane.demoted.reason})`);
  // Advisory only: a rung that never ran here carries no `stats` and renders as before.
  if (lane.stats) bits.push(formatLaneStats(lane.stats));
  return bits.join(" ");
}

export class McpDispatchServer {
  private readonly jobs: LaneJobStore;
  private readonly spawn: LaneSpawner;
  private readonly fetchImpl: AnswerFetch;
  private readonly now: () => number;
  private readonly cwd: () => string;
  private readonly maxDepth: number;
  private buffer = "";

  constructor(private readonly deps: McpServerDeps) {
    this.jobs = new LaneJobStore(deps.journal ?? nullJobJournal, deps.archive ?? nullJobArchive);
    this.spawn = deps.spawn ?? defaultLaneSpawner;
    this.fetchImpl = deps.fetch ?? defaultAnswerFetch;
    this.now = deps.now ?? Date.now;
    this.cwd = deps.cwd ?? (() => process.cwd());
    this.maxDepth = deps.maxDepth ?? DEFAULT_MAX_DEPTH;
  }

  /**
   * Feed raw stdin bytes. Complete messages are handled concurrently; a partial tail is carried
   * over. Resolves once every handler in THIS chunk has settled.
   *
   * ⚠ Deliberately not `async`: the split runs to completion before the first handler starts, so
   * two calls in flight at once cannot interleave or reorder the buffer — message order is the
   * write order whatever the caller awaits. `serve` depends on exactly that.
   */
  ingest(chunk: string): Promise<void> {
    this.buffer += chunk;
    const { lines, rest } = splitMessages(this.buffer);
    this.buffer = rest;
    return Promise.all(lines.map((line) => this.handleLine(line))).then(() => undefined);
  }

  /**
   * Serve a stream of stdin chunks until the source ends.
   *
   * ⚠ Reads every chunk the moment it arrives and NEVER awaits a handler. Until 2026-09-05
   * `cli.ts` ran `for await (chunk) { await server.ingest(chunk) }`, and `ingest` resolves only
   * when every handler in the chunk has settled — so a `tools/call` written while another was in
   * flight was not even READ until the first returned. Two requests were concurrent only when
   * they landed in the same chunk; a host that issues parallel tool calls in separate writes
   * (Claude Code does) had its second `dispatch` wait behind the first's full `waitMs`, and
   * `dispatch_status` / `dispatch_cancel` could not reach a job while a blocking `dispatch` held
   * the loop. Each handler now settles on its own promise; the per-job wait/poll policy
   * (`awaitOrPoll`) is unchanged. Responses may therefore leave out of request order, which
   * JSON-RPC permits — ids correlate.
   *
   * A rejected `ingest` (a response write failed — the host closed the pipe mid-answer; every
   * handler error is already contained inside `handleLine`) is reported on stderr and never
   * takes the loop down. Resolves after the source ends AND every handler it started has settled.
   */
  async serve(source: AsyncIterable<string>): Promise<void> {
    const inFlight = new Set<Promise<void>>();
    for await (const chunk of source) {
      const pending: Promise<void> = this.ingest(chunk).catch((e: unknown) => {
        logStderr(`ingest failed: ${e instanceof Error ? e.message : String(e)}`);
      });
      inFlight.add(pending);
      void pending.then(() => inFlight.delete(pending));
    }
    await Promise.all(inFlight);
  }

  /**
   * Kill every running child, then flush the finished-job archive. Wired to process exit so nothing
   * is orphaned and nothing the archive still owes to disk is lost on a graceful stop (a hard kill
   * is covered by the archive's eager terminal writes — `job-archive.ts`).
   */
  shutdown(): void {
    this.jobs.cancelAll();
    this.jobs.flush();
  }

  private send(message: JsonRpcResponse): void {
    this.deps.write(encodeMessage(message));
  }

  private async handleLine(line: string): Promise<void> {
    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch {
      // No id is recoverable from an unparseable line, so answer with the spec's null-id form.
      this.deps.write(
        encodeMessage({ jsonrpc: "2.0", id: 0, error: { code: RPC_PARSE_ERROR, message: "invalid JSON" } }),
      );
      return;
    }
    // ⚠ A notification carries no id and must never be answered. `notifications/initialized` is
    // the one every client sends; replying to it is a protocol violation that some clients treat
    // as fatal.
    if (isJsonRpcNotification(parsed)) return;
    if (!isJsonRpcRequest(parsed)) return;

    try {
      const result = await this.route(parsed.method, parsed.params);
      if (result === undefined) {
        this.send(errorResponse(parsed.id, RPC_METHOD_NOT_FOUND, `unknown method: ${parsed.method}`));
        return;
      }
      this.send(resultResponse(parsed.id, result));
    } catch (e) {
      // A handler must never take the connection down. Report and stay up.
      this.send(errorResponse(parsed.id, RPC_INTERNAL_ERROR, (e as Error).message));
    }
  }

  private async route(method: string, params: unknown): Promise<unknown | undefined> {
    switch (method) {
      case "initialize":
        return this.initialize(params);
      case "ping":
        return {};
      case "tools/list":
        return { tools: TOOLS };
      case "tools/call":
        return this.callTool(params);
      default:
        return undefined;
    }
  }

  private initialize(params: unknown): unknown {
    const p = (typeof params === "object" && params !== null ? params : {}) as Record<string, unknown>;
    return {
      protocolVersion: negotiateProtocolVersion(p["protocolVersion"]),
      capabilities: { tools: { listChanged: false } },
      serverInfo: { name: MCP_SERVER_NAME, version: this.deps.version ?? "unknown" },
      instructions: MCP_INSTRUCTIONS,
    };
  }

  private async callTool(params: unknown): Promise<unknown> {
    const p = (typeof params === "object" && params !== null ? params : {}) as Record<string, unknown>;
    const name = p["name"];
    const args = (typeof p["arguments"] === "object" && p["arguments"] !== null
      ? p["arguments"]
      : {}) as Record<string, unknown>;
    if (typeof name !== "string") {
      throw Object.assign(new Error("tools/call requires a tool name"), { code: RPC_INVALID_PARAMS });
    }
    return this.withVersionNotice(await this.runTool(name, args));
  }

  private async runTool(name: string, args: Record<string, unknown>): Promise<unknown> {
    switch (name) {
      case "dispatch":
        return this.toolDispatch(args);
      case "dispatch_status":
        return this.toolStatus(args);
      case "dispatch_result":
        return this.toolResult(args);
      case "dispatch_cancel":
        return this.toolCancel(args);
      case "dispatch_lanes":
        return this.toolLanes(args);
      default:
        return textResult(`unknown tool: ${name}`, true);
    }
  }

  /**
   * Append a notice to a tool reply when this process runs OLDER code than the version installed on
   * disk. The Claude desktop app keeps one MCP process alive across sessions and releases, and on
   * 2026-09-10 two processes from before v0.78.0 were still serving old code with nothing to say so.
   * Only a plain one-block text reply is touched; anything else passes through unchanged. A version
   * that cannot be read is unknown, and unknown adds nothing.
   */
  private withVersionNotice(result: unknown): unknown {
    const running = this.deps.version;
    const installed = ((): string | null => {
      try {
        return this.deps.installedVersion?.() ?? null;
      } catch {
        return null;
      }
    })();
    if (!running || !installed || running === installed) return result;
    const r = result as { content?: Array<{ type?: string; text?: string }>; isError?: boolean } | null;
    const block = r?.content?.[0];
    if (!r || !block || block.type !== "text" || typeof block.text !== "string") return result;
    const notice =
      `\n\n⚠ This llm-relay MCP server process runs v${running}, but v${installed} is installed. ` +
      "Restart the host's llm-relay MCP connection, or the host, to use the installed code.";
    return { ...r, content: [{ ...block, text: block.text + notice }, ...(r.content?.slice(1) ?? [])] };
  }

  private async toolLanes(args: Record<string, unknown>): Promise<unknown> {
    const view = await this.deps.buildView({
      task: undefined,
      tier: readString(args, "tier"),
      lane: undefined,
    });
    if (view.ladder.length === 0) {
      return textResult(
        `No dispatch ladder is configured. ${view.reason}\n\n` +
          "Add rungs under routing.ladder (or routing.ladders.<tier>) in the relay config.",
      );
    }
    const lines = view.ladder.map((l) => laneSummary(l, this.jobs.inFlight(l.id)));
    const next = view.next ? `\n\nnext: ${view.next.id} — ${view.reason}` : `\n\nnext: none — ${view.reason}`;
    return textResult(`tier: ${view.tier ?? "default"}\n\n${lines.join("\n")}${next}`);
  }

  /**
   * ⚠ A TERMINAL job's status IS its result. A native subagent hands its answer back the moment it
   * ends; a caller that polls `dispatch_status` and never thinks to call `dispatch_result` was
   * measured polling one finished job 2,023 times over 71 minutes (2026-09-16). So the first poll
   * that sees the job end already holds the answer; a running job keeps the short form.
   */
  private toolStatus(args: Record<string, unknown>): unknown {
    const jobId = readString(args, "jobId");
    if (!jobId) return textResult(this.recentJobs());
    const job = this.jobs.find(jobId);
    if (!job) return this.unknownJob(jobId);
    if (job.status === "running") return textResult(describeJob(job, this.now()));
    return textResult(jobAnswer(job, this.now()), isFailureStatus(job.status));
  }

  private toolResult(args: Record<string, unknown>): unknown {
    const jobId = readString(args, "jobId");
    if (!jobId) return textResult("dispatch_result requires jobId", true);
    const job = this.jobs.find(jobId);
    if (!job) return this.unknownJob(jobId);
    return textResult(jobAnswer(job, this.now()), isFailureStatus(job.status));
  }

  /**
   * The newest jobs this machine's llm-relay MCP servers know, one line each, newest first — the
   * list a caller reads when it lost a jobId (a host that timed a call out destroys the handle).
   */
  private recentJobs(): string {
    const now = this.now();
    const rows = this.jobs.recent(RECENT_JOBS_LISTED);
    if (rows.length === 0) return "No dispatched jobs are recorded on this machine.";
    const lines = rows.map((r) => {
      const seconds = Math.max(0, Math.round(((r.endedAt ?? now) - r.startedAt) / 1000));
      const where = r.elsewhere ? " [another MCP server process]" : "";
      const label = r.label ? ` — ${r.label}` : "";
      return `${r.id}  ${r.status}  ${seconds}s  ${r.laneId}${where}${label}`;
    });
    return `recent jobs (newest first):\n${lines.join("\n")}\n\nPass a jobId to read one.`;
  }

  /**
   * The reply for a job id this process cannot answer for. A job another host's server is still
   * running is NAMED as such — `unknown jobId` there sent callers to re-dispatch work that was in
   * progress. Not an error: the job exists, and its answer appears here once it ends.
   */
  private unknownJob(jobId: string): unknown {
    const elsewhere = this.jobs.runningElsewhere(jobId);
    if (elsewhere === undefined) return textResult(`unknown jobId: ${jobId}`, true);
    const elapsed = Math.max(0, Math.round((this.now() - elsewhere.startedAt) / 1000));
    return textResult(
      [
        `job: ${jobId}`,
        `lane: ${elsewhere.laneId}${elsewhere.spec ? ` (${elsewhere.spec})` : ""}`,
        "status: running",
        `elapsed: ${elapsed}s`,
        `record: running in another llm-relay MCP server process (pid ${elsewhere.pid})`,
      ].join("\n") +
        "\n\nThis process cannot report its progress or cancel it. Poll again: its answer appears " +
        "here once it ends.",
    );
  }

  private toolCancel(args: Record<string, unknown>): unknown {
    const jobId = readString(args, "jobId");
    if (!jobId) return textResult("dispatch_cancel requires jobId", true);
    const job = this.jobs.find(jobId);
    if (!job) return this.unknownJob(jobId);
    const cancelled = this.jobs.cancel(jobId);
    return textResult(cancelled ? `cancelled ${jobId}` : `${jobId} was already ${job.status}`);
  }

  private async toolDispatch(args: Record<string, unknown>): Promise<unknown> {
    const task = readString(args, "task");
    if (!task) return textResult("dispatch requires a non-empty task", true);

    // ⚠ Recursion bound. A dispatched lane is itself an agent that can reach this same server, so
    // without this a delegation loop is reachable and would spend quota until something died.
    // Checked before anything branches, and before the spawn/fetch it bounds — the refusal must
    // cost nothing.
    const depth = currentDepth();
    if (depth >= this.maxDepth) {
      return textResult(
        `dispatch refused: already ${depth} levels deep (max ${this.maxDepth}). ` +
          "Do the work here rather than delegating further.",
        true,
      );
    }

    const lane = readString(args, "lane");
    const model = readString(args, "model");
    // ⚠ Refused before anything is built or spawned: `lane` names a ladder rung and `model` a routing
    // spec, so honouring either one would silently ignore the other.
    if (lane !== undefined && model !== undefined) {
      return textResult(
        "dispatch takes lane or model, not both: lane names a ladder rung, model names a routing spec",
        true,
      );
    }
    const mode = readMode(args);
    const view = await this.deps.buildView({ task, tier: readString(args, "tier"), lane, mode, model });
    if (!view.next) {
      return textResult(`No lane is available. ${view.reason}`, true);
    }
    // A named lane or model runs ALONE, by design, and the terminal advice must say so rather than
    // claim the whole ladder was tried (`FORCED_LANE_ADVICE`).
    const forced = lane !== undefined || model !== undefined;

    // ⚠ `?.` on `routing`, not just on the key. `McpServerDeps.config` is a public interface and a
    // programmatic caller may hand over a partial config; a bare `.routing.dispatchWalk` throws
    // there, and a throw inside a tool handler becomes a JSON-RPC error with no lane run at all.
    // Absent settings mean the walk is off, which is the WEAKER claim and the safe fall-through.
    const declared = this.deps.config.routing?.dispatchWalk;
    const walk = declared !== undefined && declared.enabled ? declared : null;
    const { ordered, notTried } = this.walkOrder(view, walk, forced, view.next.id);

    const opts: WalkOptions = {
      mode,
      cwd: readString(args, "cwd") ?? this.cwd(),
      depth,
      readOnly: args["readOnly"] === true,
      tier: view.tier ?? undefined,
      timeoutMs: readNumber(args, "timeoutMs") ?? DEFAULT_LANE_TIMEOUT_MS,
      attemptMs: walk !== null ? walk.attemptMs : null,
      system: readString(args, "system"),
      schema: readRecord(args, "schema"),
      maxTokens: readNumber(args, "maxTokens"),
      dispatchSource: view.source === "local-fallback" ? "fallback" : "daemon",
    };

    // ⚠ The read-only boundary is checked HERE, before anything spawns. A read-only dispatch asked
    // to run in the caller's own tree is refused with zero egress, for the same reason the recursion
    // bound and the `waitMs` refusal are checked before the spawn: a refusal must cost no lane run.
    // The instruction "do not edit any file" is advice; the working directory is the mechanism.
    const readOnlyVerdictResult = readOnlyVerdict({
      readOnly: opts.readOnly,
      mode: opts.mode,
      cwd: opts.cwd,
      callerRoot: this.cwd(),
    });
    if (!readOnlyVerdictResult.ok) return textResult(readOnlyVerdictResult.refusal, true);

    const first = view.ladder.find((l) => l.id === ordered[0]) ?? view.next;
    const job = this.jobs.create(first.id, first.spec, opts.cwd, opts.dispatchSource, taskLabel(task));
    // What this dispatch was allowed to reach. Both halves gate the terminal advice below: it may
    // claim the ladder was exhausted only when a walk actually ran and nothing was left untried.
    this.jobs.noteWalkScope(job.id, { enabled: walk !== null, lanesNotTried: notTried, forced });
    // ⚠ The blocking wait is bounded by the host's tool-call ceiling, never by the caller's
    // ask alone: above ~45 s the host fails the call AND destroys the job handle. `?.` on
    // `routing` for the same partial-config reason the walk lookup states above; an absent
    // ceiling means the default.
    const ceiling = this.deps.config.routing?.mcp?.maxWaitMs ?? DEFAULT_MCP_MAX_WAIT_MS;
    const waitMs = resolveWaitMs(args["waitMs"], ceiling);
    // A `waitMs` the server cannot honour is refused BEFORE anything spawns — the refusal must
    // cost no lane run, exactly like the recursion bound above.
    if ("refusal" in waitMs) return textResult(waitMs.refusal, true);
    // ⚠ A walk must ALWAYS leave the job terminal. `runWalk` is written not to reject — every
    // failure a lane can produce is an attempt — but the worst outcome available here is a caller
    // polling a handle that can never settle, so an unexpected throw is caught and turned into a
    // terminal failure rather than trusted not to happen.
    const settled = this.runWalk(job.id, view, ordered, task, opts).catch((e: Error) => {
      this.jobs.fail(job.id, `dispatch walk failed: ${e.message}`);
      return "done" as const;
    });
    return this.awaitOrPoll(
      job.id,
      settled,
      waitMs.waitMs,
      waitMs.clamped ? { requested: waitMs.requested, ceiling } : undefined,
    );
  }

  /**
   * The lanes this dispatch will try, best first, and how many selectable lanes it leaves untried.
   *
   * `view.order` is the ONE definition of selection order (`dispatch.ts`). With the walk turned off
   * — or with a view that carries no order — this collapses to EXACTLY the pre-walk behaviour: the
   * single lane the view named as `next`, tried once, with no attempt budget.
   *
   * ⚠ The `Array.isArray` test is a VERSION SKEW guard, not defensive noise. `buildView` reaches the
   * running daemon over HTTP, and a daemon started before this field existed answers without it — an
   * MCP child upgraded ahead of a long-running daemon is the normal state on a machine that starts
   * the relay at logon and leaves it up for days. Reading `.length` off `undefined` there would throw
   * on EVERY dispatch, turning a new optional field into a total outage.
   *
   * ⚠ A second skew guard: a daemon older than `requester=mcp` still offers a pass-through rung as
   * ready, and this process can never run one (`mcpPassThroughReason`). Such a lane is dropped from an
   * UNFORCED walk here; a caller who named it still reaches it and reads why it cannot run.
   */
  private walkOrder(
    view: DispatchView,
    walk: NonNullable<Config["routing"]["dispatchWalk"]> | null,
    forced: boolean,
    nextId: string,
  ): { ordered: string[]; notTried: number } {
    const runnable = (id: string): boolean =>
      forced || !this.isPassThroughLane(view.ladder.find((l) => l.id === id));
    const order = (Array.isArray(view.order) ? view.order : []).filter(runnable);
    const ordered = walk !== null && order.length > 0 ? order.slice(0, walk.maxLanes) : [order[0] ?? nextId];
    return { ordered, notTried: Math.max(0, order.length - ordered.length) };
  }

  /** A pass-through relay lane — one this process cannot run (`walkOrder`). Never throws. */
  private isPassThroughLane(lane: DispatchLane | undefined): boolean {
    if (lane?.kind !== "relay" || lane.spec === undefined) return false;
    // A partial programmatic config (one with no `providers`) must not turn a filter into a throw.
    try {
      return isPassThroughSpec(lane.spec, this.deps.config);
    } catch {
      return false;
    }
  }

  /**
   * Try each lane in turn until one answers. THE JOB IS THE WALK.
   *
   * ⚠ That is the load-bearing choice, and it is forced by a measurement: an MCP client tool call
   * on this machine fails somewhere between 45 s and 100 s, and above that ceiling it destroys the
   * job handle as well (a filed machine-wide defect; five lanes were lost to it in one night). So
   * the walk cannot finish inside the blocking call. It continues in the background behind ONE
   * handle, `dispatch_status` reports the lane running now, and `attempts` records the rest.
   * Re-pointing the handle at each new lane instead would break polling outright.
   *
   * Never rejects: every failure a lane can produce is an ATTEMPT, and the walk decides what to do
   * with it. Only a caller error ends the walk early — see `refusal` on `LaneAttemptOutcome`.
   */
  private async runWalk(
    jobId: string,
    view: DispatchView,
    laneIds: readonly string[],
    task: string,
    opts: WalkOptions,
  ): Promise<"done"> {
    for (let i = 0; i < laneIds.length; i++) {
      // A cancellation is checked at the TOP of every iteration, so an operator who stops a walk
      // stops it — rather than watching it advance to the next lane.
      if (this.jobs.get(jobId)?.status !== "running") return "done";
      const laneId = laneIds[i];
      const lane = laneId === undefined ? undefined : view.ladder.find((l) => l.id === laneId);
      if (lane === undefined) continue;

      // ⚠ Checked BEFORE `setCurrentLane`/`runOneLane`, so nothing has been spawned for THIS
      // attempt yet and a rung can never count against its own cap.
      if (this.skipIfAtConcurrencyCap(jobId, lane)) continue;

      // ⚠ Same place, same shape: a read-only dispatch either hands the lane a bound invocation or
      // skips it before anything spawns. `bound` is undefined when the lane runs as configured.
      const readOnly = this.bindReadOnlyOrSkip(jobId, lane, opts);
      if (readOnly.skipped) continue;

      // The lane's usual time to answer rides the job, so a poll can tell a slow lane from a stuck one.
      this.jobs.setCurrentLane(jobId, lane.id, lane.spec, lane.timeToAnswer);
      if (readOnly.bound !== undefined) this.jobs.noteReadOnly(jobId, lane.id, readOnly.bound.binding);

      // ⚠ The LAST lane gets NO attempt budget. The budget exists to move on; with nowhere to move
      // to, killing a lane that is still working would throw away the only answer still coming.
      // Its own `timeoutMs` still bounds it, exactly as before this feature existed. Nor does a lane
      // with nothing reliable after it (`budgetWithheld`), for the same reason.
      const isLast = i === laneIds.length - 1;
      const noBudget = this.budgetWithheld(view, laneIds, i);
      const startedAt = this.now();
      // ⚠ The lane's OWN budget when the view carries one, and it usually does: the daemon derives
      // it from that lane's recorded history (`laneHistoryFacts` in `dispatch.ts`), because the daemon
      // is where the history lives and this child holds none. `opts.attemptMs` is the fall-back for
      // a view that carries no budget — a daemon older than this field, or the local fallback view.
      const budgetMs = lane.attemptBudget?.ms ?? opts.attemptMs;
      const outcome = await this.runOneLane(jobId, lane, task, opts, noBudget ? null : budgetMs, readOnly.bound?.invoke);
      const elapsedMs = Math.max(0, this.now() - startedAt);

      // A cancellation that landed WHILE the attempt ran discards it whole: the caller changed its
      // mind, which is not evidence about this lane. `LaneJobStore.cancel()` has already set the
      // status, and nothing further may write to the job.
      if (this.jobs.get(jobId)?.status === "cancelled") return "done";

      if (outcome.refusal !== undefined) {
        // The CALLER's error, not the lane's. Walking on would hide a bad `cwd` behind a lane
        // failure and send the operator looking in the wrong place.
        this.jobs.fail(jobId, outcome.refusal);
        return "done";
      }

      const status = classifyLaneAttempt(outcome.run, {
        abandoned: outcome.abandoned,
        semanticFailure: outcome.semanticFailure,
      });
      const reason = attemptReason(status, outcome, elapsedMs, noBudget ? null : budgetMs);
      this.jobs.recordAttempt(jobId, {
        laneId: lane.id,
        spec: lane.spec,
        status,
        elapsedMs,
        ...(reason === undefined ? {} : { reason }),
      });
      // ⚠ Forwarded for EVERY attempt and for BOTH lane kinds, which widens what the MCP child used
      // to send (agent-mode jobs only). The daemon needs these reports to record the pin and the
      // demotion, and the lane this feature exists to route around — the free pool — is a `relay`
      // lane, so without them the whole feature would be inert on its own target. Accounting is
      // unaffected: the daemon skips a ledger row for `relay`-kind rungs on its own, so no traffic
      // is double counted.
      this.forwardTelemetry(
        jobId,
        {
          taskLength: task.length,
          laneId: lane.id,
          kind: lane.kind,
          spec: lane.spec,
          tier: opts.tier,
          requestedMode: opts.mode,
          adHoc: lane.adHoc === true,
        },
        outcome.run.stdout.length,
        { status, wallClockMs: elapsedMs, exitCode: outcome.run.code },
      );

      if (status === "completed" || isLast) {
        this.jobs.complete(
          jobId,
          outcome.run,
          status === "completed" ? undefined : (outcome.semanticFailure ?? reason),
          outcome.relay,
        );
        return "done";
      }
    }
    // Reached only when the selection order named ids the ladder does not hold — a view and a
    // ladder that disagree, which a stale local fallback can produce — OR when every remaining
    // lane was SKIPPED for its maxConcurrent cap. Report it rather than returning a job that
    // silently never ran anything.
    //
    // ⚠ The message distinguishes three cases, because the first two would otherwise LIE about
    // what happened: with any TRIED attempt recorded, "no lane matched" is false and sends the
    // reader looking for a configuration fault that is not there; and with every recorded attempt
    // a SKIP, "the ladder no longer holds the remaining lanes" is false too — the ladder holds them
    // fine, they were simply all skipped. `attemptWasTried` is the one place that distinction lives,
    // and the skip REASONS are quoted rather than assumed: a skip is a concurrency cap OR a lane
    // that cannot be bound read-only, and naming the wrong one sends the reader to the wrong fix.
    const attempts = this.jobs.get(jobId)?.attempts ?? [];
    const ran = attempts.filter((a) => attemptWasTried(a.status)).length;
    const allSkipped = attempts.length > 0 && ran === 0;
    const skipReasons = [...new Set(attempts.filter((a) => !attemptWasTried(a.status)).map((a) => a.reason ?? "skipped"))];
    this.jobs.fail(
      jobId,
      allSkipped
        ? `every lane in the selection order was skipped before it ran: ${skipReasons.join("; ")}`
        : ran === 0
          ? "no lane in the dispatch ladder matched the selection order"
          : `no lane answered, and the ladder no longer holds the remaining lanes in the selection order (${ran} tried)`,
    );
    return "done";
  }

  /**
   * Does the lane at position `i` run with NO attempt budget? The last lane does — there is nowhere
   * to move to. So does a lane whose later lanes are all unlikely to answer: each is on a streak of
   * `LANE_UNRELIABLE_STREAK` own failures or more, or marked `failing`. Stopping a lane that may
   * still answer in order to reach those trades an answer for a near-certain failure — measured
   * 2026-09-10, when the walk stopped `free-pool` at 90 s to try lanes that had answered 0 of 12,
   * 0 of 34 and 0 of 21 runs (`docs/dispatch-giveup-diagnosis-2026-09-10.md` §1). A lane with no
   * record counts as reliable: unmeasured is no opinion, never a failure.
   */
  private budgetWithheld(view: DispatchView, laneIds: readonly string[], i: number): boolean {
    return !laneIds.slice(i + 1).some((id) => {
      const later = view.ladder.find((l) => l.id === id);
      return later !== undefined && later.failing === undefined && (later.recentFailures ?? 0) < LANE_UNRELIABLE_STREAK;
    });
  }

  /**
   * A `cli` rung whose configured `maxConcurrent` this MCP server process has already reached for
   * — SKIP it for this walk rather than starting a competing process. Records the skip as an
   * attempt (so the walk's own "lanes tried" rendering shows it) and grows `lanesNotTried` (so a
   * walk that skips everything reports the PARTIAL advice, never the EXHAUSTED one — a skipped
   * rung "counts as NOT TRIED", not as a lane that ran and failed). Spawns nothing, demotes
   * nothing: no telemetry is forwarded for a skip, so `lane-affinity.ts` never hears about it.
   *
   * Only `cli` rungs carry a `maxConcurrent` at all (`dispatch.ts` `toLane`) — a `relay` lane's is
   * always `null`, so this returns `false` for one without needing a `kind` check of its own.
   */
  private skipIfAtConcurrencyCap(jobId: string, lane: DispatchLane): boolean {
    if (lane.maxConcurrent === null || lane.maxConcurrent === undefined) return false;
    const inFlight = this.jobs.inFlight(lane.id, jobId);
    if (inFlight < lane.maxConcurrent) return false;
    this.jobs.recordAttempt(jobId, {
      laneId: lane.id,
      spec: lane.spec,
      status: SKIPPED_LANE_STATUS,
      elapsedMs: 0,
      reason: `lane "${lane.id}" is at its maxConcurrent (${inFlight} in flight)`,
    });
    this.jobs.noteSkippedLane(jobId);
    return true;
  }

  /**
   * For a read-only dispatch, the invocation this lane will be spawned with — its own CLI's
   * read-only tool binding (`readOnlyInvoke`) — or a SKIP when its CLI offers none. Recorded exactly
   * like a concurrency-cap skip: an attempt in the walk's own record, `lanesNotTried` grown so the
   * terminal advice is PARTIAL rather than EXHAUSTED, nothing spawned, no telemetry, no demotion —
   * a lane the relay declined to run unbound has not failed.
   *
   * Not consulted at all for an ordinary dispatch, for an answer-mode relay call (no harness, so
   * nothing to bind), or for a lane with no invocation (the existing "cannot be run from here" path
   * reports that on its own).
   */
  private bindReadOnlyOrSkip(
    jobId: string,
    lane: DispatchLane,
    opts: WalkOptions,
  ): { skipped: false; bound?: { invoke: LaneInvocation; binding: string } } | { skipped: true } {
    if (!opts.readOnly) return { skipped: false };
    if (opts.mode === "answer" && lane.kind === "relay") return { skipped: false };
    if (lane.invoke === undefined) return { skipped: false };
    const verdict = readOnlyInvoke(lane.invoke);
    if (verdict.ok) return { skipped: false, bound: { invoke: verdict.invoke, binding: verdict.binding } };
    this.jobs.recordAttempt(jobId, {
      laneId: lane.id,
      spec: lane.spec,
      status: SKIPPED_LANE_STATUS,
      elapsedMs: 0,
      reason: `lane "${lane.id}" skipped: ${verdict.reason}`,
    });
    this.jobs.noteSkippedLane(jobId);
    return { skipped: true };
  }

  /**
   * Run ONE lane, optionally bounded by an attempt budget. Returns what happened; never throws.
   *
   * With `budgetMs === null` the lane is simply awaited — its own `timeoutMs` is the only bound.
   * With a budget, the lane races a timer: if the timer wins, the lane is KILLED and reported as
   * `abandoned`.
   *
   * ⚠ It kills rather than hedges. The HTTP request path hedges — it starts a second attempt
   * beside the first — and that is deliberate there, bounded to free deployments by an owner
   * amendment. A lane hedge is a different trade: it spends two lanes' quota at once, and this
   * machine already carries a filed defect in which lane processes are never reaped and go on
   * burning processor time after their job returns. So the walk leaves nothing running behind it.
   */
  private async runOneLane(
    jobId: string,
    lane: DispatchLane,
    task: string,
    opts: WalkOptions,
    budgetMs: number | null,
    invoke?: LaneInvocation,
  ): Promise<LaneAttemptOutcome> {
    const started = this.startLane(jobId, lane, task, opts, invoke);
    if ("refusal" in started) return { run: emptyRun(), abandoned: false, refusal: started.refusal };
    // ⚠ `registerProcess`, never the bare kill callback: the handle carries the pids this
    // dispatcher STARTED, which is the only reliable signal for a reaper. Age is not — a long
    // lane and a stale one look identical from outside, and one legitimately ran 29 minutes.
    this.jobs.registerProcess(jobId, started);

    // The attempt promise is made total here, once, so neither branch below has to repeat it and
    // no rejection can escape into the walk.
    const guarded = started.result.catch(
      (e: Error): LaneAttemptOutcome => ({
        run: { code: null, stdout: "", stderr: e.message, timedOut: false },
        abandoned: false,
        semanticFailure: e.message,
      }),
    );
    if (budgetMs === null) return guarded;

    const raced = await Promise.race([
      guarded.then((o) => ({ kind: "settled" as const, outcome: o })),
      new Promise<{ kind: "budget" }>((resolve) => {
        const t = setTimeout(() => resolve({ kind: "budget" }), budgetMs);
        // Do not hold the event loop open on the budget timer alone.
        if (typeof t.unref === "function") t.unref();
      }),
    ]);
    if (raced.kind === "settled") return raced.outcome;

    // The budget passed and another lane remains. Kill this one and move on. `guarded` never
    // rejects, so the killed child's late settlement needs no further handler — it resolves into a
    // value nobody reads.
    started.kill();
    return { run: emptyRun(), abandoned: true };
  }

  /**
   * Start ONE lane and hand back its promise plus a kill handle. Two shapes, decided exactly as
   * `toolDispatch` used to decide them: a `relay` rung in answer mode is a direct HTTP call to
   * this relay's own `/v1/messages`; everything else is a spawned command.
   *
   * ⚠ A lane that cannot run HERE returns a failed OUTCOME, not a refusal, so the walk moves on.
   * Only a bad working directory is a `refusal`, because that is the caller's own error and every
   * remaining lane would hit it identically.
   */
  private startLane(
    jobId: string,
    lane: DispatchLane,
    task: string,
    opts: WalkOptions,
    /** The invocation to spawn instead of `lane.invoke` — a read-only binding of it. */
    invokeOverride?: LaneInvocation,
  ): { result: Promise<LaneAttemptOutcome>; kill: () => void; pids?: () => number[] } | { refusal: string } {
    if (opts.mode === "answer" && lane.kind === "relay") {
      // ⚠ Skips the whole cwd/invoke/spawn path on purpose: a direct HTTP call to this relay's own
      // /v1/messages needs no working directory and no harness. `lane.invoke` may still be present
      // (a bypassed or unknown host transposes every relay rung into a CLI invocation), but answer
      // mode deliberately never looks at it — that transposed command IS the slow path this mode
      // exists to skip.
      if (!lane.spec) {
        return {
          result: Promise.resolve(failedOutcome(`Lane "${lane.id}" has no relay spec to address in answer mode.`)),
          kill: () => {},
        };
      }
      const controller = new AbortController();
      // AbortSignal.timeout self-cleans and needs no manual clearTimeout; `AbortSignal.any`
      // composes it with the cancel/abandon handle without either seam knowing about the other.
      const signal = AbortSignal.any([AbortSignal.timeout(opts.timeoutMs), controller.signal]);
      const result = this.runAnswerFetch(lane.spec, task, opts, signal).then((o): LaneAttemptOutcome => {
        // ⚠ The content-empty check applies HERE too, not only on the spawned path. HTTP 200 with
        // a lone `#` is the same known lane failure as exit 0 with one, and reading it as a
        // successful empty answer would also PIN the lane that produced it.
        const semanticFailure =
          o.semanticFailure === undefined && !o.run.timedOut && isContentEmpty(o.run.stdout)
            ? EMPTY_OUTPUT_REASON
            : o.semanticFailure;
        return {
          run: o.run,
          abandoned: false,
          ...(o.relay === undefined ? {} : { relay: o.relay }),
          ...(semanticFailure === undefined ? {} : { semanticFailure }),
        };
      });
      return { result, kill: () => controller.abort() };
    }

    const cwdCheck = checkCwd(opts.cwd, this.deps.allowedRoots);
    if (!cwdCheck.ok) return { refusal: `dispatch refused: ${cwdCheck.reason}` };

    const invoke = invokeOverride ?? lane.invoke;
    if (!invoke) {
      // `buildDispatch` already excludes an unreachable rung from the selection order, so this is
      // defence rather than an expected path — report why rather than inventing a command, the
      // rule `cli.ts` already states. ⚠ A pass-through rung reaches here from a daemon older than
      // `requester=mcp`, and "no cliLane template configured" was false for it: the template exists,
      // and the rung is not transposed because it forwards the caller's own credential.
      const why =
        lane.unreachable ??
        (lane.spec !== undefined && this.isPassThroughLane(lane)
          ? mcpPassThroughReason(lane.spec)
          : `it is a relay target (${lane.spec ?? "?"}) with no cliLane template configured`);
      return {
        result: Promise.resolve(failedOutcome(`Lane "${lane.id}" cannot be run from here: ${why}.`)),
        kill: () => {},
      };
    }

    const env = applyLaneEnv(process.env, invoke.env);
    env[DEPTH_ENV] = String(opts.depth + 1);
    const startedAt = this.now();
    // From here the job's output figure describes THIS attempt: zero bytes, until the spawner's
    // observer reports the first chunk. Counts and timestamps only; the bytes stay in the run.
    this.jobs.beginAttemptActivity(jobId, startedAt);
    let run: LaneSpawnHandle;
    try {
      run = this.spawn(invoke.command, invoke.args, {
        env,
        cwd: opts.cwd,
        timeoutMs: opts.timeoutMs,
        onOutput: ({ stream, bytes }) => this.jobs.noteOutput(jobId, stream, bytes, this.now()),
      });
    } catch (e) {
      return { result: Promise.resolve(failedOutcome((e as Error).message)), kill: () => {} };
    }

    const result = run.result.then((r) => this.settleSpawnedRun(jobId, lane, invoke, opts, startedAt, r));
    // ⚠ The pids travel WITH the handle: `runOneLane` registers it, and the reaper names a survivor
    // by them. Until 2026-09-10 this returned `{ result, kill }` alone, so the v0.80.0 survivor
    // report had no pid to check for any lane a walk started.
    return { result, kill: run.kill, ...(run.pids === undefined ? {} : { pids: run.pids }) };
  }

  /**
   * Settle a spawned lane's run. A quota death the lane states — in its own output, or for an AGY
   * lane in AGY's own log — is reported to the relay; a content-empty answer is a failure.
   *
   * ⚠ It also runs for a lane the walk STOPPED: the killed child still settles here, so a death AGY
   * stated only in its log reaches the relay although the walk has moved on. The outcome itself is
   * discarded in that case — `runOneLane` already returned `abandoned`.
   */
  private async settleSpawnedRun(
    jobId: string,
    lane: DispatchLane,
    invoke: NonNullable<DispatchLane["invoke"]>,
    opts: WalkOptions,
    startedAt: number,
    r: LaneRunResult,
  ): Promise<LaneAttemptOutcome> {
    // A caller cancellation is not lane evidence, even if the child later exits with text that
    // happens to contain quota vocabulary.
    if (this.jobs.get(jobId)?.status === "cancelled") return { run: r, abandoned: false };
    const report =
      classifyDispatchedResult({ result: r, laneId: lane.id, tier: opts.tier, command: invoke.command, args: invoke.args }) ??
      (laneAnswered(r) ? undefined : this.agyLogReport(lane, invoke, opts, startedAt));
    let semanticFailure: string | undefined = report ? `lane reported ${report.outcome}` : undefined;
    let out = r;
    if (report) {
      try {
        await this.deps.reportExhaustion?.(report);
      } catch (e) {
        // Reporting is advisory, but the lane's semantic failure is not. Keep the diagnostic
        // bounded because it may originate in an injected integration.
        const detail = e instanceof Error ? e.message : String(e);
        semanticFailure = `${semanticFailure}; quota report failed: ${detail.slice(0, 500)}`;
        out = { ...r, stderr: `${r.stderr}${r.stderr ? "\n" : ""}${semanticFailure}` };
      }
    }
    // ⚠ Priority order: an established quota/timeout signal always outranks the content-empty
    // check — never override a MORE specific claim with a LESS specific one.
    if (semanticFailure === undefined && !out.timedOut && isContentEmpty(out.stdout)) {
      semanticFailure = EMPTY_OUTPUT_REASON;
    }
    return { run: out, abandoned: false, ...(semanticFailure === undefined ? {} : { semanticFailure }) };
  }

  /**
   * The quota death an AGY lane stated only in AGY's own log (`agy-quota-log.ts`). AGY retries a
   * spent quota in silence, so a lane stopped by the walk or by its own timeout printed nothing, and
   * the death reached the relay only when a run happened to last its whole length
   * (`docs/dispatch-giveup-diagnosis-2026-09-10.md` §4). Undefined unless the lane is AGY, names its
   * model, and the log is provably this run's — `agyQuotaStatement` refuses everything else.
   */
  private agyLogReport(
    lane: DispatchLane,
    invoke: NonNullable<DispatchLane["invoke"]>,
    opts: WalkOptions,
    startedAt: number,
  ): DispatchedQuotaReport | undefined {
    const read = this.deps.readAgyLog;
    if (read === undefined || laneOfRung(invoke.command, invoke.args)?.lane !== "agy") return undefined;
    const model = flagValue(invoke.args, "--model");
    if (model === null) return undefined;
    let statement: ReturnType<typeof agyQuotaStatement>;
    try {
      statement = agyQuotaStatement(read(), model, startedAt);
    } catch {
      return undefined;
    }
    if (statement === null) return undefined;
    return { laneId: lane.id, tier: opts.tier, outcome: statement.outcome, retryAfterMs: statement.retryAfterMs };
  }

  /**
   * Forward one lane-execution report per ATTEMPT, for both lane kinds: the daemon records the
   * lane's stats and routing memory from these, and skips the ledger row for a `relay` lane on its
   * own because the HTTP pipeline already accounts it. Never for a cancelled job, and never for an
   * ad-hoc lane (`DispatchLane.adHoc`), which the daemon has no rung to record against.
   *
   * Fire-and-forget by design: the reporter is never awaited on the response path, and a
   * throwing or rejecting reporter is swallowed after ONE metadata-only stderr line (lane id
   * and job id; never the task text), so forwarding can never change the dispatch result,
   * the job, or the stdio protocol.
   */
  private forwardTelemetry(
    jobId: string,
    captured: {
      taskLength: number;
      laneId: string;
      kind: DispatchLane["kind"];
      spec: string | undefined;
      tier: string | undefined;
      /** The mode the caller asked for. The mode the lane RAN in is derived below. */
      requestedMode: DispatchMode;
      /** A caller-named model's lane: not a ladder rung, so the daemon has no rung to record it on. */
      adHoc: boolean;
    },
    outputChars: number,
    attempt: { status: DispatchLaneStatus; wallClockMs: number; exitCode: number | null },
  ): void {
    if (captured.adHoc) return;
    const job = this.jobs.get(jobId);
    if (!job) return;
    // ⚠ A caller cancellation is never lane evidence. That guarantee used to come from narrowing
    // the JOB's status through `isReportableJobStatus`; with a walk the job stays `running`
    // BETWEEN lanes, so that test no longer describes the attempt being reported. The guarantee
    // moved into the TYPE instead, where it is stronger: `DispatchLaneStatus` has no `cancelled`
    // member, so no caller can pass one. This check remains for the walk's own race — a
    // cancellation landing while an attempt was in flight.
    if (job.status === "cancelled") return;
    const report: DispatchedTelemetryReport = {
      jobId: job.id,
      laneId: captured.laneId,
      kind: captured.kind,
      ...(captured.spec === undefined ? {} : { spec: captured.spec }),
      ...(captured.tier === undefined ? {} : { tier: captured.tier }),
      // The mode the lane RAN in, which keys its stats window. A `cli` lane asked for answer mode
      // spawns its harness exactly as in agent mode, so only a `relay` lane ever runs in answer mode.
      mode: captured.requestedMode === "answer" && captured.kind === "relay" ? "answer" : "agent",
      // ⚠ THIS ATTEMPT's wall clock, not the walk's. The daemon's lane statistics and its routing
      // memory are both per lane, so charging a third lane's answer with the two abandoned budgets
      // ahead of it would make every late lane look slow.
      wallClockMs: Math.max(0, attempt.wallClockMs),
      exitCode: attempt.exitCode,
      status: attempt.status,
      estimatedInputTokens: estimateTokensFromCharacters(captured.taskLength),
      estimatedOutputTokens: estimateTokensFromCharacters(outputChars),
    };
    let pending: Promise<void> | void;
    try {
      pending = this.deps.reportTelemetry?.(report);
    } catch {
      logStderr(`telemetry report failed for lane "${captured.laneId}" job "${job.id}"`);
      return;
    }
    if (pending && typeof (pending as Promise<void>).catch === "function") {
      (pending as Promise<void>).catch(() => {
        logStderr(`telemetry report failed for lane "${captured.laneId}" job "${job.id}"`);
      });
    }
  }

  /**
   * The one HTTP round trip answer mode makes. Never throws for an ordinary outcome — a non-2xx
   * response, an unparseable body, or a timeout are all represented in the returned
   * `LaneRunResult`, exactly as a spawned lane's own nonzero exit or timeout would be. Only a
   * genuine transport error (the relay is not running, DNS failure, …) propagates, for the
   * caller's `.catch()` to turn into `jobs.fail()` — the same shape a spawn that throws
   * synchronously already produces.
   */
  private async runAnswerFetch(
    spec: string,
    task: string,
    opts: { system: string | undefined; schema: Record<string, unknown> | undefined; maxTokens: number | undefined },
    signal: AbortSignal,
  ): Promise<{ run: LaneRunResult; semanticFailure?: string; relay?: RelayAnnouncements }> {
    const url = relayLoopbackUrl(this.deps.config, "/v1/messages");
    const body: Record<string, unknown> = {
      model: spec,
      max_tokens: opts.maxTokens ?? DEFAULT_ANSWER_MAX_TOKENS,
      messages: [{ role: "user", content: task }],
    };
    if (opts.system) body["system"] = opts.system;
    if (opts.schema) {
      body["tools"] = [{ name: "answer", description: "Return the answer", input_schema: opts.schema }];
      body["tool_choice"] = { type: "tool", name: "answer" };
    }

    let response: Response;
    try {
      response = await this.fetchImpl(url, {
        method: "POST",
        headers: {
          "anthropic-version": "2023-06-01",
          "content-type": "application/json",
          // Not a real credential: the relay authenticates to whichever backend with ITS OWN
          // configured credentials, never the caller's — this header only needs to be present.
          "x-api-key": "dummy",
        },
        body: JSON.stringify(body),
        signal,
      });
    } catch (e) {
      if (signal.aborted) {
        // Whether this was the timeout firing or an explicit cancel, the caller's `.then()`
        // checks job status FIRST and discards this result entirely for a real cancel — see the
        // ordering note on `LaneJobStore.cancel()`. So it is always safe to report it as a
        // timeout here.
        return { run: { code: null, stdout: "", stderr: "", timedOut: true } };
      }
      throw e;
    }

    if (!response.ok) {
      // ⚠ This READ HEADERS ON A FAILURE, which reverses the rule stated here until 2026-09-10, and
      // the reversal is deliberate rather than an oversight. The old rule — status and a bounded
      // body excerpt only — was written to keep a PROVIDER's arbitrary headers out of a
      // relay-authored message. `readRelayAnnouncements` is a closed allow-list of five names the
      // relay itself writes, so it carries none of that risk, and the measured cost of the rule was
      // a failure the caller could not act on: `relay answered HTTP 504` names the LANE as the
      // failure while the 504 came from the relay's OWN `/v1/messages`, and a pool exhaustion and a
      // relay-side timeout call for opposite responses.
      const bodyText = await response.text().catch(() => "");
      const relay = readRelayAnnouncements(response.headers);
      // The model this dispatch asked for is the one relay-side fact the caller already holds, so
      // it is named even when the relay's walk exit stated no `served-by`.
      const timeline = [
        relay.servedBy === undefined ? `asked for ${spec}` : `served-by: ${relay.servedBy}`,
        relay.poolAttempts === undefined ? undefined : `pool-attempts: ${relay.poolAttempts}`,
      ].filter((part): part is string => part !== undefined);
      return {
        run: { code: null, stdout: "", stderr: bodyText.slice(0, 300), timedOut: false },
        semanticFailure: `relay answered HTTP ${response.status} (${timeline.join("; ")})`,
        relay,
      };
    }

    const relay = readRelayAnnouncements(response.headers);
    let parsed: unknown;
    try {
      parsed = await response.json();
    } catch (e) {
      return {
        run: { code: null, stdout: "", stderr: `unparseable relay response: ${(e as Error).message}`, timedOut: false },
        semanticFailure: "relay response was not valid JSON",
        relay,
      };
    }
    const text = extractAnswerText(parsed, opts.schema !== undefined);
    return { run: { code: 0, stdout: text, stderr: "", timedOut: false }, relay };
  }

  /**
   * Block for the resolved `waitMs`, then hand back a job handle. A fast lane therefore costs
   * ONE call, and a slow one degrades to polling instead of hitting the client's tool timeout.
   * Shared by both dispatch modes so there is exactly one wait/poll/render policy — the "two
   * paths, one policy" shape this repo's own history warns against.
   *
   * When the caller's `waitMs` was clamped to the ceiling, `clamp` carries the ask and the
   * ceiling and the reply announces it on its own line — the SAME code path that renders
   * "Still running after N s", so the announcement can never drift from the wait it explains.
   * Without a clamp the text below is byte-for-byte what it always was.
   */
  private async awaitOrPoll(
    jobId: string,
    settled: Promise<"done">,
    waitMs: number,
    clamp?: { requested: number; ceiling: number },
  ): Promise<unknown> {
    const raced = await Promise.race([
      settled,
      new Promise<"pending">((resolve) => {
        const t = setTimeout(() => resolve("pending"), waitMs);
        // Do not hold the event loop open on the wait timer alone.
        if (typeof t.unref === "function") t.unref();
      }),
    ]);

    const current = this.jobs.get(jobId);
    if (!current) return textResult(`unknown jobId: ${jobId}`, true);
    if (raced === "pending") {
      const waitedS = Math.round(waitMs / 1000);
      const announcement =
        clamp === undefined
          ? ""
          : `waited ${waitedS} s (waitMs ${clamp.requested} clamped to routing.mcp.maxWaitMs ${clamp.ceiling})\n`;
      return textResult(
        `${describeJob(current, this.now())}\n\n${announcement}Still running after ${waitedS}s. ` +
          `Poll dispatch_status with jobId "${jobId}", then call dispatch_result.`,
      );
    }
    return textResult(jobAnswer(current, this.now()), isFailureStatus(current.status));
  }
}

/** The first non-empty line of a task, cut to 80 characters — enough to recognise a job in a list. */
export function taskLabel(task: string): string {
  const line = task.split(/\r?\n/).map((l) => l.trim()).find((l) => l.length > 0) ?? "";
  return line.length > 80 ? `${line.slice(0, 77)}...` : line;
}

/**
 * Answer text from a relay `/v1/messages` response body. With a `schema`, the caller forced a
 * single `answer` tool call, so the text is that tool's input, JSON-stringified; otherwise it is
 * every `text` content block concatenated, the ordinary Anthropic assistant-turn shape.
 */
function extractAnswerText(parsed: unknown, hasSchema: boolean): string {
  const message = parsed as Partial<AssistantMessage>;
  const content: ContentBlock[] = Array.isArray(message.content) ? message.content : [];
  if (hasSchema) {
    const toolUse = content.find(
      (b): b is ToolUseBlock => isToolUseBlock(b) && b.name === "answer",
    );
    return toolUse ? JSON.stringify(toolUse.input) : "";
  }
  return content
    .filter((b): b is ContentBlock & { type: "text"; text: string } => b.type === "text" && typeof (b as { text?: unknown }).text === "string")
    .map((b) => b.text)
    .join("");
}
