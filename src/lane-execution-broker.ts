/**
 * Daemon-owned lane execution broker — D1 Phase 1.
 *
 * This module deliberately knows NOTHING about HTTP routing or the configured ladder. It owns the
 * lifecycle of an already-authorized lane execution handed to it by an injected launcher. The
 * admin route is responsible for admitting/validating a configured lane; the broker is responsible
 * for idempotency, cancellation, bounded retention and the execution status/result contract.
 *
 * Phase 1 is behavior-neutral for MCP dispatch: no production MCP path calls this broker yet.
 */
import { createHash } from "node:crypto";

export const LANE_EXECUTION_SCHEMA = "mcp.lane-execution.v1" as const;
export const MAX_BROKER_TERMINAL_EXECUTIONS = 100;
export const MAX_BROKER_TASK_CHARS = 4096;
export const MAX_BROKER_PATH_CHARS = 4096;
export const MAX_BROKER_ID_CHARS = 200;
export const MAX_BROKER_TIMEOUT_MS = 24 * 60 * 60 * 1000;
const MAX_RESULT_CHARS = 16 * 1024 * 1024;
const ID_PATTERN = /^[A-Za-z0-9_.:-]+$/;

export type LaneExecutionStatus =
  | "running"
  | "completed"
  | "failed"
  | "timed_out"
  | "cancelled";

export interface LaneExecutionActivity {
  stdoutBytes: number;
  stderrBytes: number;
  lastOutputAt: number | null;
  /** Cumulative CPU ms for the exact process tree the daemon owns, when available. */
  cpuMs?: number;
}

export interface LaneExecutionRunResult {
  code: number | null;
  stdout: string;
  stderr: string;
  timedOut: boolean;
}

export interface LaneExecutionLaunchHandle {
  result: Promise<LaneExecutionRunResult>;
  cancel: () => void;
  activity?: () => LaneExecutionActivity;
}

export interface LaneExecutionStartRequest {
  action: "start";
  executionId: string;
  jobId: string;
  laneId: string;
  task: string;
  cwd: string;
  timeoutMs: number;
  tier?: "low" | "medium" | "high" | "xhigh";
  readOnly?: boolean;
  callerRoot?: string;
  host?: "routed" | "bypassed" | "unknown";
  entrypoint?: string;
}

export interface LaneExecutionStatusRequest {
  action: "status";
  executionId: string;
}

export interface LaneExecutionCancelRequest {
  action: "cancel";
  executionId: string;
}

export type LaneExecutionBrokerRequest =
  | LaneExecutionStartRequest
  | LaneExecutionStatusRequest
  | LaneExecutionCancelRequest;

export interface LaneExecutionSnapshot {
  schema: typeof LANE_EXECUTION_SCHEMA;
  executionId: string;
  jobId: string;
  laneId: string;
  status: LaneExecutionStatus;
  startedAt: number;
  endedAt: number | null;
  stdoutBytes: number;
  stderrBytes: number;
  lastOutputAt: number | null;
  cpuMs?: number;
  /** Terminal-only process result. */
  code?: number | null;
  stdout?: string;
  stderr?: string;
  timedOut?: boolean;
}

export type LaneExecutionBrokerResult =
  | { ok: true; execution: LaneExecutionSnapshot }
  | { ok: false; status: 400 | 404 | 409 | 503; message: string };

export type LaneExecutionLauncher = (
  request: LaneExecutionStartRequest,
) => LaneExecutionLaunchHandle | { refusal: string };

export interface LaneExecutionBrokerPort {
  handle(request: LaneExecutionBrokerRequest): Promise<LaneExecutionBrokerResult>;
}

interface StoredExecution {
  executionId: string;
  jobId: string;
  laneId: string;
  signature: string;
  status: LaneExecutionStatus;
  startedAt: number;
  endedAt: number | null;
  handle: LaneExecutionLaunchHandle | null;
  result: LaneExecutionRunResult | null;
  cancelRequested: boolean;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function exactKeys(value: Record<string, unknown>, allowed: ReadonlySet<string>): boolean {
  return Object.keys(value).every((key) => allowed.has(key));
}

function boundedId(value: unknown): value is string {
  return (
    typeof value === "string" &&
    value.length > 0 &&
    value.length <= MAX_BROKER_ID_CHARS &&
    ID_PATTERN.test(value)
  );
}

function optionalBoundedString(value: unknown, max: number): value is string | undefined {
  return value === undefined || (typeof value === "string" && value.length <= max);
}

function parseStart(value: Record<string, unknown>): LaneExecutionStartRequest | null {
  const allowed = new Set([
    "action",
    "executionId",
    "jobId",
    "laneId",
    "task",
    "cwd",
    "timeoutMs",
    "tier",
    "readOnly",
    "callerRoot",
    "host",
    "entrypoint",
  ]);
  if (!exactKeys(value, allowed)) return null;
  if (!boundedId(value["executionId"]) || !boundedId(value["jobId"]) || !boundedId(value["laneId"])) {
    return null;
  }
  if (
    typeof value["task"] !== "string" ||
    value["task"].length === 0 ||
    value["task"].length > MAX_BROKER_TASK_CHARS
  ) {
    return null;
  }
  if (
    typeof value["cwd"] !== "string" ||
    value["cwd"].length === 0 ||
    value["cwd"].length > MAX_BROKER_PATH_CHARS
  ) {
    return null;
  }
  const timeoutMs = value["timeoutMs"];
  if (
    typeof timeoutMs !== "number" ||
    !Number.isSafeInteger(timeoutMs) ||
    timeoutMs < 1 ||
    timeoutMs > MAX_BROKER_TIMEOUT_MS
  ) {
    return null;
  }
  const tier = value["tier"];
  if (tier !== undefined && tier !== "low" && tier !== "medium" && tier !== "high" && tier !== "xhigh") {
    return null;
  }
  const readOnly = value["readOnly"];
  if (readOnly !== undefined && typeof readOnly !== "boolean") return null;
  if (!optionalBoundedString(value["callerRoot"], MAX_BROKER_PATH_CHARS)) return null;
  if (
    value["host"] !== undefined &&
    value["host"] !== "routed" &&
    value["host"] !== "bypassed" &&
    value["host"] !== "unknown"
  ) {
    return null;
  }
  if (!optionalBoundedString(value["entrypoint"], MAX_BROKER_ID_CHARS)) return null;

  return {
    action: "start",
    executionId: value["executionId"],
    jobId: value["jobId"],
    laneId: value["laneId"],
    task: value["task"],
    cwd: value["cwd"],
    timeoutMs,
    ...(tier === undefined ? {} : { tier }),
    ...(readOnly === undefined ? {} : { readOnly }),
    ...(value["callerRoot"] === undefined ? {} : { callerRoot: value["callerRoot"] }),
    ...(value["host"] === undefined ? {} : { host: value["host"] }),
    ...(value["entrypoint"] === undefined ? {} : { entrypoint: value["entrypoint"] }),
  };
}

export function parseLaneExecutionBrokerRequest(value: unknown): LaneExecutionBrokerRequest | null {
  if (!isRecord(value)) return null;
  if (value["action"] === "start") return parseStart(value);

  const allowed = new Set(["action", "executionId"]);
  if (!exactKeys(value, allowed) || !boundedId(value["executionId"])) return null;
  if (value["action"] === "status") {
    return { action: "status", executionId: value["executionId"] };
  }
  if (value["action"] === "cancel") {
    return { action: "cancel", executionId: value["executionId"] };
  }
  return null;
}

function startSignature(request: LaneExecutionStartRequest): string {
  // Fixed-order tuple: retries of the same request are idempotent without retaining task text
  // merely to compare it later.
  return createHash("sha256")
    .update(
      JSON.stringify([
        request.jobId,
        request.laneId,
        request.task,
        request.cwd,
        request.timeoutMs,
        request.tier ?? null,
        request.readOnly ?? null,
        request.callerRoot ?? null,
        request.host ?? null,
        request.entrypoint ?? null,
      ]),
      "utf8",
    )
    .digest("hex");
}

function bounded(text: string): string {
  if (text.length <= MAX_RESULT_CHARS) return text;
  const removed = text.length - MAX_RESULT_CHARS;
  return `[broker: first ${removed} characters cut; the tail follows]\n${text.slice(removed)}`;
}

function safeActivity(handle: LaneExecutionLaunchHandle | null): LaneExecutionActivity {
  if (!handle?.activity) {
    return { stdoutBytes: 0, stderrBytes: 0, lastOutputAt: null };
  }
  try {
    const value = handle.activity();
    const stdoutBytes =
      Number.isSafeInteger(value.stdoutBytes) && value.stdoutBytes >= 0 ? value.stdoutBytes : 0;
    const stderrBytes =
      Number.isSafeInteger(value.stderrBytes) && value.stderrBytes >= 0 ? value.stderrBytes : 0;
    const lastOutputAt =
      value.lastOutputAt === null ||
      (typeof value.lastOutputAt === "number" && Number.isFinite(value.lastOutputAt))
        ? value.lastOutputAt
        : null;
    const cpuMs =
      typeof value.cpuMs === "number" && Number.isFinite(value.cpuMs) && value.cpuMs >= 0
        ? value.cpuMs
        : undefined;
    return {
      stdoutBytes,
      stderrBytes,
      lastOutputAt,
      ...(cpuMs === undefined ? {} : { cpuMs }),
    };
  } catch {
    return { stdoutBytes: 0, stderrBytes: 0, lastOutputAt: null };
  }
}

function terminalStatus(result: LaneExecutionRunResult): LaneExecutionStatus {
  if (result.timedOut) return "timed_out";
  return result.code === 0 ? "completed" : "failed";
}

export class LaneExecutionBroker implements LaneExecutionBrokerPort {
  private readonly executions = new Map<string, StoredExecution>();

  constructor(
    private readonly launch: LaneExecutionLauncher,
    private readonly now: () => number = Date.now,
    private readonly maxTerminal: number = MAX_BROKER_TERMINAL_EXECUTIONS,
  ) {}

  async handle(request: LaneExecutionBrokerRequest): Promise<LaneExecutionBrokerResult> {
    switch (request.action) {
      case "start":
        return this.start(request);
      case "status":
        return this.status(request.executionId);
      case "cancel":
        return this.cancel(request.executionId);
      default: {
        const _never: never = request;
        return _never;
      }
    }
  }

  private start(request: LaneExecutionStartRequest): LaneExecutionBrokerResult {
    const signature = startSignature(request);
    const existing = this.executions.get(request.executionId);
    if (existing) {
      if (existing.signature !== signature) {
        return {
          ok: false,
          status: 409,
          message: "lane execution id already exists with a different start request",
        };
      }
      return { ok: true, execution: this.snapshot(existing) };
    }

    let handle: LaneExecutionLaunchHandle | { refusal: string };
    try {
      handle = this.launch(request);
    } catch {
      return { ok: false, status: 503, message: "lane execution launch failed" };
    }
    if ("refusal" in handle) {
      return { ok: false, status: 400, message: handle.refusal };
    }

    const stored: StoredExecution = {
      executionId: request.executionId,
      jobId: request.jobId,
      laneId: request.laneId,
      signature,
      status: "running",
      startedAt: this.now(),
      endedAt: null,
      handle,
      result: null,
      cancelRequested: false,
    };
    this.executions.set(request.executionId, stored);

    void handle.result.then(
      (result) => this.settle(stored, result),
      (error: unknown) =>
        this.settle(stored, {
          code: null,
          stdout: "",
          stderr: error instanceof Error ? error.message : "lane execution failed",
          timedOut: false,
        }),
    );

    return { ok: true, execution: this.snapshot(stored) };
  }

  private status(executionId: string): LaneExecutionBrokerResult {
    const stored = this.executions.get(executionId);
    return stored
      ? { ok: true, execution: this.snapshot(stored) }
      : { ok: false, status: 404, message: "unknown lane execution id" };
  }

  private cancel(executionId: string): LaneExecutionBrokerResult {
    const stored = this.executions.get(executionId);
    if (!stored) return { ok: false, status: 404, message: "unknown lane execution id" };
    if (stored.status === "running") {
      stored.cancelRequested = true;
      stored.status = "cancelled";
      stored.endedAt = this.now();
      try {
        stored.handle?.cancel();
      } catch {
        // Cancellation is a terminal request. The later settlement can still provide bounded
        // output, but a throwing kill callback must not turn it back into a running execution.
      }
      this.prune();
    }
    return { ok: true, execution: this.snapshot(stored) };
  }

  private settle(stored: StoredExecution, raw: LaneExecutionRunResult): void {
    const result: LaneExecutionRunResult = {
      code: typeof raw.code === "number" && Number.isFinite(raw.code) ? raw.code : raw.code === null ? null : null,
      stdout: bounded(typeof raw.stdout === "string" ? raw.stdout : ""),
      stderr: bounded(typeof raw.stderr === "string" ? raw.stderr : ""),
      timedOut: raw.timedOut === true,
    };
    stored.result = result;
    stored.handle = null;
    if (!stored.cancelRequested) {
      stored.status = terminalStatus(result);
      stored.endedAt = this.now();
    }
    this.prune();
  }

  private snapshot(stored: StoredExecution): LaneExecutionSnapshot {
    const activity = safeActivity(stored.handle);
    const result = stored.result;
    return {
      schema: LANE_EXECUTION_SCHEMA,
      executionId: stored.executionId,
      jobId: stored.jobId,
      laneId: stored.laneId,
      status: stored.status,
      startedAt: stored.startedAt,
      endedAt: stored.endedAt,
      stdoutBytes:
        result === null ? activity.stdoutBytes : Buffer.byteLength(result.stdout, "utf8"),
      stderrBytes:
        result === null ? activity.stderrBytes : Buffer.byteLength(result.stderr, "utf8"),
      lastOutputAt: activity.lastOutputAt,
      ...(activity.cpuMs === undefined ? {} : { cpuMs: activity.cpuMs }),
      ...(result === null
        ? {}
        : {
            code: result.code,
            stdout: result.stdout,
            stderr: result.stderr,
            timedOut: result.timedOut,
          }),
    };
  }

  private prune(): void {
    if (this.maxTerminal < 0) return;
    const terminal = [...this.executions.values()]
      .filter((execution) => execution.status !== "running")
      .sort((a, b) => (a.endedAt ?? Number.MAX_SAFE_INTEGER) - (b.endedAt ?? Number.MAX_SAFE_INTEGER));
    const drop = terminal.length - this.maxTerminal;
    for (let i = 0; i < drop; i += 1) this.executions.delete(terminal[i]!.executionId);
  }
}
