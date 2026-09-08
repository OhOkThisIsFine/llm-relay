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
import type { AssistantMessage, ContentBlock, ToolUseBlock } from "../anthropic.js";
import { isToolUseBlock } from "../anthropic.js";
import type { DispatchLane, DispatchView } from "../dispatch.js";
import { formatAttemptBudget, formatLaneStats } from "../dispatch.js";
import { estimateTokensFromCharacters } from "../metadata.js";
import type { DispatchedTelemetryReport, DispatchLaneStatus } from "../dispatch-lane-stats.js";
import {
  DEFAULT_LANE_TIMEOUT_MS,
  DEFAULT_MAX_DEPTH,
  DEFAULT_WAIT_MS,
  DEPTH_ENV,
  EMPTY_OUTPUT_REASON,
  LaneJobStore,
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
  type LaneSpawner,
  type DispatchedQuotaReport,
  type RelayAnnouncements,
} from "./lane-runner.js";
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

/**
 * How a dispatch view is obtained. Injected rather than imported so this module never decides
 * whether to consult the running relay — the caller owns that, exactly as `buildDispatch` takes
 * the host verdict as an argument instead of sniffing for it.
 */
export type DispatchViewBuilder = (opts: {
  task: string | undefined;
  tier: string | undefined;
  lane: string | undefined;
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
  "own conversation context or edits you must supervise. The default lane is free capacity, so " +
  "offloading spends no subscription quota and saves this session's context. On Windows it " +
  "centralizes hidden child creation, closes stdin so headless agents do not stall, and applies " +
  "each lane's configured timeouts. Prefer it over launching an agent alias from a shell. A " +
  "third-party CLI observed creating visible descendants must be disabled until reverified. " +
  "Do not use a pool/* native collaboration child from Codex Desktop: with a ChatGPT account, " +
  "Desktop rejects that child model before reaching the relay and ignores its custom provider. " +
  "Call dispatch instead. If this MCP server is unavailable, run `llm-relay dispatch " +
  "--next-command -t <task>` and follow its returned command or target; do not guess from the host.\n\n" +
  "Do not switch lanes by hand. If a lane is slow or silent, dispatch moves to the next one " +
  "itself and prefers the lane that answered on your next call. When it reports that every lane " +
  "was tried, do the work here — re-dispatching the same task picks the same lanes.\n\n" +
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
      "Hand a whole task to the best available agent lane (a free model pool, or a peer agent CLI " +
      "such as Codex or Antigravity) and return its answer. Reach for this without being asked " +
      "whenever a task is self-contained and its result is a conclusion you can check — a broad " +
      "code search, a file-by-file sweep, a survey, a draft, a second opinion — because the " +
      "default lane is free capacity and it saves this session's context. Picks the lane from " +
      "the configured ladder unless you name one, and WALKS that ladder for you: a lane that does " +
      "not answer inside its budget is stopped and the next one is started, and the lane that " +
      "answers is preferred next time. Runs the lane correctly — working directory, " +
      "environment and idle timeouts are handled here, so you never build a command line. If the " +
      "lane is still running after waitMs, returns a jobId to poll with dispatch_status. In Codex " +
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
        cwd: {
          type: "string",
          description: "Agent mode only: absolute directory to run the lane in. Defaults to this server's working directory.",
        },
        waitMs: {
          type: "number",
          description: `How long to block before returning a jobId instead (default ${DEFAULT_WAIT_MS}).`,
        },
        timeoutMs: {
          type: "number",
          description: `Hard ceiling on the lane run (default ${DEFAULT_LANE_TIMEOUT_MS}).`,
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
      "Report whether a dispatched lane is still running, and for how long. Poll this after " +
      "dispatch returned a jobId. Wait at least a few seconds between polls.",
    inputSchema: {
      type: "object",
      properties: { jobId: { type: "string", description: "The jobId dispatch returned." } },
      required: ["jobId"],
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

/** A JSON Schema object for `schema`. Arrays and `null` are not schemas, so both are declined. */
function readRecord(params: Record<string, unknown>, key: string): Record<string, unknown> | undefined {
  const v = params[key];
  return typeof v === "object" && v !== null && !Array.isArray(v) ? (v as Record<string, unknown>) : undefined;
}

/**
 * `"timed_out"` joins `"failed"` as an error result for the MCP `isError` flag — a caller that
 * only checks `isError` must not read a lane that never finished as a success.
 */
function isFailureStatus(status: JobStatus): boolean {
  return status === "failed" || status === "timed_out";
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
 * delegating, on a false premise, abandons free capacity that was never contacted.
 */
export const LANE_LADDER_PARTIAL_ADVICE =
  "Lanes remain untried: this dispatch stopped at its maxLanes bound. Call dispatch again to "
  + "reach them — the lanes above are now demoted, so it will pick different ones — or do the "
  + "work in this session.";

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
  // A caller that stops delegating on a false premise abandons free capacity nothing contacted.
  const nothingAnswered =
    job.status !== "running"
    && job.status !== "cancelled"
    && job.attempts.length > 0
    && job.attempts.every((a) => a.status !== "completed");
  const exhausted = !nothingAnswered
    ? ""
    : job.walkEnabled !== true
      ? ""
      : job.lanesNotTried
        ? `\n\n${LANE_LADDER_PARTIAL_ADVICE}`
        : `\n\n${LANE_LADDER_EXHAUSTED_ADVICE}`;
  if (job.status === "running") {
    return `${header}\n\nStill running. Poll dispatch_status, then call dispatch_result.`;
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
  return "the lane failed";
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

function laneSummary(lane: DispatchLane): string {
  const bits = [`${lane.position}. ${lane.id}`, `[${lane.state}]`];
  if (lane.spec) bits.push(lane.spec);
  if (lane.readyAt) bits.push(`ready ${lane.readyAt}`);
  if (lane.notServable) bits.push(`not servable: ${lane.notServable}`);
  if (lane.unreachable) bits.push(`unreachable: ${lane.unreachable}`);
  if (lane.note) bits.push(lane.note);
  // The routing memory from previous walks, on the lane rather than only in the selection reason —
  // an operator reading `dispatch_lanes` to understand an unexpected order needs to see it here.
  if (lane.attemptBudget) bits.push(formatAttemptBudget(lane.attemptBudget));
  if (lane.pinned) bits.push(`pinned until ${lane.pinned.until} (${lane.pinned.reason})`);
  if (lane.demoted) bits.push(`demoted until ${lane.demoted.until} (${lane.demoted.reason})`);
  // Advisory only: a rung that never ran here carries no `stats` and renders as before.
  if (lane.stats) bits.push(formatLaneStats(lane.stats));
  return bits.join(" ");
}

export class McpDispatchServer {
  private readonly jobs = new LaneJobStore();
  private readonly spawn: LaneSpawner;
  private readonly fetchImpl: AnswerFetch;
  private readonly now: () => number;
  private readonly cwd: () => string;
  private readonly maxDepth: number;
  private buffer = "";

  constructor(private readonly deps: McpServerDeps) {
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

  /** Kill every running child. Wired to process exit so nothing is orphaned. */
  shutdown(): void {
    this.jobs.cancelAll();
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
    const lines = view.ladder.map(laneSummary);
    const next = view.next ? `\n\nnext: ${view.next.id} — ${view.reason}` : `\n\nnext: none — ${view.reason}`;
    return textResult(`tier: ${view.tier ?? "default"}\n\n${lines.join("\n")}${next}`);
  }

  private toolStatus(args: Record<string, unknown>): unknown {
    const jobId = readString(args, "jobId");
    if (!jobId) return textResult("dispatch_status requires jobId", true);
    const job = this.jobs.get(jobId);
    if (!job) return textResult(`unknown jobId: ${jobId}`, true);
    return textResult(describeJob(job, this.now()));
  }

  private toolResult(args: Record<string, unknown>): unknown {
    const jobId = readString(args, "jobId");
    if (!jobId) return textResult("dispatch_result requires jobId", true);
    const job = this.jobs.get(jobId);
    if (!job) return textResult(`unknown jobId: ${jobId}`, true);
    return textResult(jobAnswer(job, this.now()), isFailureStatus(job.status));
  }

  private toolCancel(args: Record<string, unknown>): unknown {
    const jobId = readString(args, "jobId");
    if (!jobId) return textResult("dispatch_cancel requires jobId", true);
    const job = this.jobs.get(jobId);
    if (!job) return textResult(`unknown jobId: ${jobId}`, true);
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

    const view = await this.deps.buildView({
      task,
      tier: readString(args, "tier"),
      lane: readString(args, "lane"),
    });
    if (!view.next) {
      return textResult(`No lane is available. ${view.reason}`, true);
    }

    // ⚠ `?.` on `routing`, not just on the key. `McpServerDeps.config` is a public interface and a
    // programmatic caller may hand over a partial config; a bare `.routing.dispatchWalk` throws
    // there, and a throw inside a tool handler becomes a JSON-RPC error with no lane run at all.
    // Absent settings mean the walk is off, which is the WEAKER claim and the safe fall-through.
    const declared = this.deps.config.routing?.dispatchWalk;
    const walk = declared !== undefined && declared.enabled ? declared : null;
    // `view.order` is the ONE definition of selection order (`dispatch.ts`). With the walk turned
    // off — or with a view that carries no order — this collapses to EXACTLY the pre-walk
    // behaviour: the single lane the view named as `next`, tried once, with no attempt budget.
    //
    // ⚠ The `Array.isArray` test is a VERSION SKEW guard, not defensive noise. `buildView` reaches
    // the running daemon over HTTP, and a daemon started before this field existed answers without
    // it — an MCP child upgraded ahead of a long-running daemon is the normal state on a machine
    // that starts the relay at logon and leaves it up for days. Reading `.length` off `undefined`
    // there would throw on EVERY dispatch, turning a new optional field into a total outage.
    const order = Array.isArray(view.order) ? view.order : [];
    const ordered = walk !== null && order.length > 0 ? order.slice(0, walk.maxLanes) : [view.next.id];

    const opts: WalkOptions = {
      mode: readMode(args),
      cwd: readString(args, "cwd") ?? this.cwd(),
      depth,
      tier: view.tier ?? undefined,
      timeoutMs: readNumber(args, "timeoutMs") ?? DEFAULT_LANE_TIMEOUT_MS,
      attemptMs: walk !== null ? walk.attemptMs : null,
      system: readString(args, "system"),
      schema: readRecord(args, "schema"),
      maxTokens: readNumber(args, "maxTokens"),
      dispatchSource: view.source === "local-fallback" ? "fallback" : "daemon",
    };

    const first = view.ladder.find((l) => l.id === ordered[0]) ?? view.next;
    const job = this.jobs.create(first.id, first.spec, opts.cwd, opts.dispatchSource);
    // What this dispatch was allowed to reach. Both halves gate the terminal advice below: it may
    // claim the ladder was exhausted only when a walk actually ran and nothing was left untried.
    this.jobs.noteWalkScope(job.id, {
      enabled: walk !== null,
      lanesNotTried: Math.max(0, order.length - ordered.length),
    });
    const waitMs = readNumber(args, "waitMs") ?? DEFAULT_WAIT_MS;
    // ⚠ A walk must ALWAYS leave the job terminal. `runWalk` is written not to reject — every
    // failure a lane can produce is an attempt — but the worst outcome available here is a caller
    // polling a handle that can never settle, so an unexpected throw is caught and turned into a
    // terminal failure rather than trusted not to happen.
    const settled = this.runWalk(job.id, view, ordered, task, opts).catch((e: Error) => {
      this.jobs.fail(job.id, `dispatch walk failed: ${e.message}`);
      return "done" as const;
    });
    return this.awaitOrPoll(job.id, settled, waitMs);
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
      this.jobs.setCurrentLane(jobId, lane.id, lane.spec);

      // ⚠ The LAST lane gets NO attempt budget. The budget exists to move on; with nowhere to move
      // to, killing a lane that is still working would throw away the only answer still coming.
      // Its own `timeoutMs` still bounds it, exactly as before this feature existed.
      const isLast = i === laneIds.length - 1;
      const startedAt = this.now();
      // ⚠ The lane's OWN budget when the view carries one, and it usually does: the daemon derives
      // it from that lane's recorded history (`attemptBudget` in `dispatch.ts`), because the daemon
      // is where the history lives and this child holds none. `opts.attemptMs` is the fall-back for
      // a view that carries no budget — a daemon older than this field, or the local fallback view.
      const budgetMs = lane.attemptBudget?.ms ?? opts.attemptMs;
      const outcome = await this.runOneLane(jobId, lane, task, opts, isLast ? null : budgetMs);
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
      const reason = attemptReason(status, outcome, elapsedMs, isLast ? null : budgetMs);
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
        { taskLength: task.length, laneId: lane.id, kind: lane.kind, spec: lane.spec, tier: opts.tier },
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
    // ladder that disagree, which a stale local fallback can produce. Report it rather than
    // returning a job that silently never ran anything.
    //
    // ⚠ The message distinguishes the two cases, because the first wording would otherwise LIE
    // about a walk that did run lanes: with any attempt recorded, "no lane matched" is false and
    // would send the reader looking for a configuration fault that is not there.
    const ran = this.jobs.get(jobId)?.attempts.length ?? 0;
    this.jobs.fail(
      jobId,
      ran === 0
        ? "no lane in the dispatch ladder matched the selection order"
        : `no lane answered, and the ladder no longer holds the remaining lanes in the selection order (${ran} tried)`,
    );
    return "done";
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
  ): Promise<LaneAttemptOutcome> {
    const started = this.startLane(jobId, lane, task, opts);
    if ("refusal" in started) return { run: emptyRun(), abandoned: false, refusal: started.refusal };
    this.jobs.registerKill(jobId, started.kill);

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
  ): { result: Promise<LaneAttemptOutcome>; kill: () => void } | { refusal: string } {
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

    const invoke = lane.invoke;
    if (!invoke) {
      // `buildDispatch` already excludes an unreachable rung from the selection order, so this is
      // defence rather than an expected path — report why rather than inventing a command, the
      // rule `cli.ts` already states.
      return {
        result: Promise.resolve(
          failedOutcome(
            `Lane "${lane.id}" cannot be run from here: ${lane.unreachable ?? `it is a relay target (${lane.spec ?? "?"}) with no cliLane template configured`}.`,
          ),
        ),
        kill: () => {},
      };
    }

    const env = applyLaneEnv(process.env, invoke.env);
    env[DEPTH_ENV] = String(opts.depth + 1);
    let run: { result: Promise<LaneRunResult>; kill: () => void };
    try {
      run = this.spawn(invoke.command, invoke.args, { env, cwd: opts.cwd, timeoutMs: opts.timeoutMs });
    } catch (e) {
      return { result: Promise.resolve(failedOutcome((e as Error).message)), kill: () => {} };
    }

    const result = run.result.then(async (r): Promise<LaneAttemptOutcome> => {
      // A caller cancellation is not lane evidence, even if the child later exits with text that
      // happens to contain quota vocabulary.
      if (this.jobs.get(jobId)?.status === "cancelled") return { run: r, abandoned: false };
      const report = classifyDispatchedResult({
        result: r,
        laneId: lane.id,
        tier: opts.tier,
        command: invoke.command,
        args: invoke.args,
      });
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
    });
    return { result, kill: run.kill };
  }

  /**
   * Forward one lane-execution report after an agent-mode job reaches a terminal state.
   * Never a RELAY-kind answer-mode job (the daemon's HTTP pipeline already accounts it —
   * finding F3); a `cli`-kind rung dispatched with `mode: "answer"` spawns like agent mode
   * and IS forwarded. A cancelled job is discarded, never reported.
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
    },
    outputChars: number,
    attempt: { status: DispatchLaneStatus; wallClockMs: number; exitCode: number | null },
  ): void {
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
      // ⚠ Never read headers on a failure — status and a BOUNDED body excerpt only.
      const bodyText = await response.text().catch(() => "");
      return {
        run: { code: null, stdout: "", stderr: bodyText.slice(0, 300), timedOut: false },
        semanticFailure: `relay answered HTTP ${response.status}`,
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
   * Block for `waitMs`, then hand back a job handle. A fast lane therefore costs ONE call, and a
   * slow one degrades to polling instead of hitting the client's tool timeout. Shared by both
   * dispatch modes so there is exactly one wait/poll/render policy — the "two paths, one policy"
   * shape this repo's own history warns against.
   */
  private async awaitOrPoll(jobId: string, settled: Promise<"done">, waitMs: number): Promise<unknown> {
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
      return textResult(
        `${describeJob(current, this.now())}\n\nStill running after ${Math.round(waitMs / 1000)}s. ` +
          `Poll dispatch_status with jobId "${jobId}", then call dispatch_result.`,
      );
    }
    return textResult(jobAnswer(current, this.now()), isFailureStatus(current.status));
  }
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
