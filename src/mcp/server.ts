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
import type { DispatchLane, DispatchView } from "../dispatch.js";
import {
  DEFAULT_LANE_TIMEOUT_MS,
  DEFAULT_MAX_DEPTH,
  DEFAULT_WAIT_MS,
  DEPTH_ENV,
  LaneJobStore,
  checkCwd,
  currentDepth,
  defaultLaneSpawner,
  type LaneJob,
  type LaneSpawner,
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
  negotiateProtocolVersion,
  resultResponse,
  splitMessages,
  type JsonRpcResponse,
} from "./protocol.js";

export const MCP_SERVER_NAME = "llm-relay";

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
  "Use dispatch to hand a whole task to another agent lane and get its answer back. You never " +
  "need to know whether the lane is a model pool or a peer CLI — that is resolved here.\n\n" +
  "Reach for it on your own, without being asked. Offload a task when it is self-contained and " +
  "its result is a conclusion you can check: a broad code search, a file-by-file sweep, a " +
  "survey, a draft, a long summary, a second opinion. Keep in this session whatever needs your " +
  "own conversation context or edits you must supervise. The default lane is free capacity, so " +
  "offloading spends no subscription quota and saves this session's context.\n\n" +
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
      "lane is still running after waitMs, returns a jobId to poll with dispatch_status.",
    inputSchema: {
      type: "object",
      properties: {
        task: {
          type: "string",
          description: "The complete, self-contained task. The lane sees only this text.",
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
          description: "Absolute directory to run the lane in. Defaults to this server's working directory.",
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
  return head.join("\n");
}

function jobAnswer(job: LaneJob, now: number): string {
  const header = describeJob(job, now);
  const body = job.stdout.trim();
  if (job.status === "running") {
    return `${header}\n\nStill running. Poll dispatch_status, then call dispatch_result.`;
  }
  if (body.length === 0) {
    // ⚠ Empty output with exit 0 is a KNOWN lane failure mode (agy discards long answers), and it
    // must not read as a successful empty answer. Say so rather than returning nothing.
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
  private readonly now: () => number;
  private readonly cwd: () => string;
  private readonly maxDepth: number;
  private buffer = "";

  constructor(private readonly deps: McpServerDeps) {
    this.spawn = deps.spawn ?? defaultLaneSpawner;
    this.now = deps.now ?? Date.now;
    this.cwd = deps.cwd ?? (() => process.cwd());
    this.maxDepth = deps.maxDepth ?? DEFAULT_MAX_DEPTH;
  }

  /** Feed raw stdin bytes. Complete messages are handled; a partial tail is carried over. */
  async ingest(chunk: string): Promise<void> {
    this.buffer += chunk;
    const { lines, rest } = splitMessages(this.buffer);
    this.buffer = rest;
    for (const line of lines) await this.handleLine(line);
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
    return textResult(jobAnswer(job, this.now()), job.status === "failed");
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
    const depth = currentDepth();
    if (depth >= this.maxDepth) {
      return textResult(
        `dispatch refused: already ${depth} levels deep (max ${this.maxDepth}). ` +
          "Do the work here rather than delegating further.",
        true,
      );
    }

    const cwd = readString(args, "cwd") ?? this.cwd();
    const cwdCheck = checkCwd(cwd, this.deps.allowedRoots);
    if (!cwdCheck.ok) return textResult(`dispatch refused: ${cwdCheck.reason}`, true);

    const view = await this.deps.buildView({
      task,
      tier: readString(args, "tier"),
      lane: readString(args, "lane"),
    });
    const lane = view.next;
    if (!lane) {
      return textResult(`No lane is available. ${view.reason}`, true);
    }
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

    const timeoutMs = readNumber(args, "timeoutMs") ?? DEFAULT_LANE_TIMEOUT_MS;
    const waitMs = readNumber(args, "waitMs") ?? DEFAULT_WAIT_MS;

    let run: { result: Promise<import("./lane-runner.js").LaneRunResult>; kill: () => void };
    try {
      run = this.spawn(lane.invoke.command, lane.invoke.args, { env, cwd, timeoutMs });
    } catch (e) {
      this.jobs.fail(job.id, (e as Error).message);
      return textResult(jobAnswer(this.jobs.get(job.id) ?? job, this.now()), true);
    }
    this.jobs.registerKill(job.id, run.kill);

    const settled = run.result.then(
      (r) => {
        this.jobs.complete(job.id, r);
        return "done" as const;
      },
      (e: Error) => {
        this.jobs.fail(job.id, e.message);
        return "done" as const;
      },
    );

    // Block for waitMs, then hand back a handle. A fast lane therefore costs ONE call, and a slow
    // one degrades to polling instead of hitting the client's tool timeout.
    const raced = await Promise.race([
      settled,
      new Promise<"pending">((resolve) => {
        const t = setTimeout(() => resolve("pending"), waitMs);
        // Do not hold the event loop open on the wait timer alone.
        if (typeof t.unref === "function") t.unref();
      }),
    ]);

    const current = this.jobs.get(job.id) ?? job;
    if (raced === "pending") {
      return textResult(
        `${describeJob(current, this.now())}\n\nStill running after ${Math.round(waitMs / 1000)}s. ` +
          `Poll dispatch_status with jobId "${job.id}", then call dispatch_result.`,
      );
    }
    return textResult(jobAnswer(current, this.now()), current.status === "failed");
  }
}
