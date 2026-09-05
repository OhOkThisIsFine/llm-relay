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
import { estimateTokensFromCharacters } from "../metadata.js";
import type { DispatchedTelemetryReport } from "../dispatch-lane-stats.js";
import {
  DEFAULT_LANE_TIMEOUT_MS,
  DEFAULT_MAX_DEPTH,
  DEFAULT_WAIT_MS,
  DEPTH_ENV,
  EMPTY_OUTPUT_REASON,
  LaneJobStore,
  classifyDispatchedResult,
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
      "the configured ladder unless you name one. Runs the lane correctly — working directory, " +
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
  return head.join("\n");
}

function jobAnswer(job: LaneJob, now: number): string {
  const header = describeJob(job, now);
  const body = job.stdout.trim();
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
    }`;
  }
  if (isContentEmpty(body)) {
    // ⚠ Exit 0 (or HTTP 200) with content-empty output is a KNOWN lane failure mode (agy discards
    // long answers; a free model sometimes answers a lone `#`), and it must not read as a
    // successful empty answer. Say so rather than returning nothing.
    const tail = job.stderr.trim().slice(-1500);
    return `${header}\n\nThe lane returned NO output. Treat this as a lane failure and retry, or pick another lane.${
      tail ? `\n\nstderr tail:\n${tail}` : ""
    }`;
  }
  return `${header}\n\n${body}`;
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

  /** Feed raw stdin bytes. Complete messages are handled concurrently; a partial tail is carried over. */
  async ingest(chunk: string): Promise<void> {
    this.buffer += chunk;
    const { lines, rest } = splitMessages(this.buffer);
    this.buffer = rest;
    await Promise.all(lines.map((line) => this.handleLine(line)));
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
    // Checked before either mode branches, and before the spawn/fetch it bounds — the refusal
    // must cost nothing.
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
    const lane = view.next;
    if (!lane) {
      return textResult(`No lane is available. ${view.reason}`, true);
    }

    const waitMs = readNumber(args, "waitMs") ?? DEFAULT_WAIT_MS;
    const timeoutMs = readNumber(args, "timeoutMs") ?? DEFAULT_LANE_TIMEOUT_MS;
    const mode = readMode(args);

    if (mode === "answer" && lane.kind === "relay") {
      // ⚠ Skips the whole cwd/invoke/spawn path below on purpose: a direct HTTP call to this
      // relay's own /v1/messages needs no working directory and no harness. `lane.invoke` may
      // still be present (a bypassed/unknown host transposes every relay rung into a CLI
      // invocation), but answer mode deliberately never looks at it — that transposed command IS
      // the slow path this mode exists to skip. See `dispatchAnswer`.
      return this.dispatchAnswer(lane, task, {
        system: readString(args, "system"),
        schema: readRecord(args, "schema"),
        maxTokens: readNumber(args, "maxTokens"),
        waitMs,
        timeoutMs,
      });
    }

    const cwd = readString(args, "cwd") ?? this.cwd();
    const cwdCheck = checkCwd(cwd, this.deps.allowedRoots);
    if (!cwdCheck.ok) return textResult(`dispatch refused: ${cwdCheck.reason}`, true);

    if (!lane.invoke) {
      // The view builder asks for a host with no subagent mechanism, so every usable rung comes
      // back with a command. Reaching here means the rung is genuinely unreachable as configured —
      // report why rather than inventing a command, the rule `cli.ts` already states.
      return textResult(
        `Lane "${lane.id}" cannot be run from here: ${lane.unreachable ?? `it is a relay target (${lane.spec ?? "?"}) with no cliLane template configured`}.`,
        true,
      );
    }

    const job = this.jobs.create(lane.id, lane.spec, cwd);
    const env = applyLaneEnv(process.env, lane.invoke.env);
    env[DEPTH_ENV] = String(depth + 1);

    // Telemetry capture: the task text lives only as this local, and the job never carries
    // the lane KIND, so snapshot both now — the settled handlers below only see the job.
    const telemetry = { taskLength: task.length, laneId: lane.id, kind: lane.kind, spec: lane.spec };

    let run: { result: Promise<LaneRunResult>; kill: () => void };
    try {
      run = this.spawn(lane.invoke.command, lane.invoke.args, { env, cwd, timeoutMs });
    } catch (e) {
      this.jobs.fail(job.id, (e as Error).message);
      // No run exists on the spawn-throw path, so there is no output to estimate from.
      this.forwardTelemetry(job.id, telemetry, 0);
      return textResult(jobAnswer(this.jobs.get(job.id) ?? job, this.now()), true);
    }
    this.jobs.registerKill(job.id, run.kill);

    const settled = run.result.then(
      async (r) => {
        // A caller cancellation is not lane evidence, even if the child later exits with text
        // that happens to contain quota vocabulary.
        if (this.jobs.get(job.id)?.status === "cancelled") return "done" as const;
        const report = classifyDispatchedResult({
          result: r,
          laneId: lane.id,
          tier: view.tier ?? undefined,
          command: lane.invoke!.command,
          args: lane.invoke!.args,
        });
        let semanticFailure: string | undefined = report ? `lane reported ${report.outcome}` : undefined;
        if (report) {
          if (this.jobs.get(job.id)?.status === "cancelled") return "done" as const;
          try {
            await this.deps.reportExhaustion?.(report);
          } catch (e) {
            // Reporting is advisory, but the lane's semantic failure is not. Keep the diagnostic
            // bounded because it may originate in an injected integration.
            const detail = e instanceof Error ? e.message : String(e);
            semanticFailure = `${semanticFailure}; quota report failed: ${detail.slice(0, 500)}`;
            r = { ...r, stderr: `${r.stderr}${r.stderr ? "\n" : ""}${semanticFailure}` };
          }
        }
        // ⚠ Priority order: an established quota/timeout signal always outranks the content-empty
        // check — never override a MORE specific claim with a LESS specific one. `complete()`
        // additionally treats `r.timedOut` as the outright winner regardless of what is passed
        // here, so this guard mainly keeps a genuine (non-timeout) empty answer from being
        // reported merely as "failed" with no reason.
        if (semanticFailure === undefined && !r.timedOut && isContentEmpty(r.stdout)) {
          semanticFailure = EMPTY_OUTPUT_REASON;
        }
        this.jobs.complete(job.id, r, semanticFailure);
        this.forwardTelemetry(job.id, telemetry, r.stdout.length);
        return "done" as const;
      },
      (e: Error) => {
        this.jobs.fail(job.id, e.message);
        this.forwardTelemetry(job.id, telemetry, 0);
        return "done" as const;
      },
    );

    return this.awaitOrPoll(job.id, settled, waitMs);
  }

  /**
   * Forward one lane-execution report after an agent-mode job reaches a terminal state.
   * Answer-mode jobs never reach here — the daemon's HTTP pipeline already accounts them
   * (finding F3) — and a cancelled job is discarded, never reported.
   *
   * Fire-and-forget by design: the reporter is never awaited on the response path, and a
   * throwing or rejecting reporter is swallowed after ONE metadata-only stderr line (lane id
   * and job id; never the task text), so forwarding can never change the dispatch result,
   * the job, or the stdio protocol.
   */
  private forwardTelemetry(
    jobId: string,
    captured: { taskLength: number; laneId: string; kind: DispatchLane["kind"]; spec: string | undefined },
    outputChars: number,
  ): void {
    const job = this.jobs.get(jobId);
    if (!job || job.status === "cancelled") return;
    if (job.status !== "completed" && job.status !== "failed" && job.status !== "timed_out") return;
    const report: DispatchedTelemetryReport = {
      jobId: job.id,
      laneId: captured.laneId,
      kind: captured.kind,
      ...(captured.spec === undefined ? {} : { spec: captured.spec }),
      wallClockMs: Math.max(0, (job.endedAt ?? this.now()) - job.startedAt),
      exitCode: job.exitCode,
      status: job.status,
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
   * Answer mode for a `relay`-kind rung: skip the harness, POST straight to this relay's own
   * `/v1/messages`. `lane.spec` is the rung's own pool/model spec — the relay resolves it through
   * the SAME failover walk any other client's request would get, so pool/failover/hedge behaviour
   * is unchanged; this call merely avoids spawning a `claude -p` process to make it.
   *
   * ⚠ If `spec` resolves to the plain Anthropic passthrough, the dummy `x-api-key` this call sends
   * fails there and the walk moves on to the next candidate — acceptable, since a pool answering
   * from its own passthrough member was never the fast path this mode targets.
   */
  private async dispatchAnswer(
    lane: DispatchLane,
    task: string,
    opts: {
      system: string | undefined;
      schema: Record<string, unknown> | undefined;
      maxTokens: number | undefined;
      waitMs: number;
      timeoutMs: number;
    },
  ): Promise<unknown> {
    if (!lane.spec) {
      return textResult(`Lane "${lane.id}" has no relay spec to address in answer mode.`, true);
    }
    const spec = lane.spec;
    const job = this.jobs.create(lane.id, spec, this.cwd());

    const controller = new AbortController();
    this.jobs.registerKill(job.id, () => controller.abort());
    // AbortSignal.timeout self-cleans and needs no manual clearTimeout; `AbortSignal.any` composes
    // it with the cancel handle above without either seam needing to know about the other.
    const signal = AbortSignal.any([AbortSignal.timeout(opts.timeoutMs), controller.signal]);

    const settled = this.runAnswerFetch(spec, task, opts, signal).then(
      (outcome) => {
        if (this.jobs.get(job.id)?.status === "cancelled") return "done" as const;
        let semanticFailure = outcome.semanticFailure;
        if (semanticFailure === undefined && !outcome.run.timedOut && isContentEmpty(outcome.run.stdout)) {
          semanticFailure = EMPTY_OUTPUT_REASON;
        }
        this.jobs.complete(job.id, outcome.run, semanticFailure, outcome.relay);
        return "done" as const;
      },
      (e: Error) => {
        if (this.jobs.get(job.id)?.status === "cancelled") return "done" as const;
        this.jobs.fail(job.id, e.message);
        return "done" as const;
      },
    );

    return this.awaitOrPoll(job.id, settled, opts.waitMs);
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
