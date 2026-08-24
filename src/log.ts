import { appendFileSync, existsSync, renameSync, rmSync, statSync } from "node:fs";
import type { Config } from "./config.js";

export const DEFAULT_LOG_MAX_BYTES = 50 * 1024 * 1024;
export const MAX_LOG_ATTEMPTS = 64;

export type RequestAttemptStatus =
  | number
  | "failed"
  | "cancelled"
  | "committed"
  | "dead-turn"
  /** Skipped BEFORE egress by an operator-set hard cap (G2) — no provider saw this attempt. */
  | "capped";

/** Status-only metadata for one deployment visited during a bounded candidate walk. */
export interface RequestAttemptLog {
  provider: string;
  model: string | null;
  status: RequestAttemptStatus;
  ms: number;
}

/**
 * Metadata-only request log. NEVER records headers or bodies — only the shape of
 * what happened. This is the dataset that reveals which backend models trip the
 * validator (format-broken, reshapeable) vs pass cleanly.
 */
export interface RequestLog {
  ts: string;
  path: string;
  /**
   * The provider that actually served the request (`ResolvedTarget.provider`), or
   * `null` when the request never reached a backend (guardrail rejection, routing
   * error, an admin endpoint) and so nothing served it. `null` means none — never
   * a guess.
   *
   * REQUIRED. It was optional for the length of the OBS-b5ade458 transition, where
   * an absent field meant "this call site has not been migrated yet"; every call
   * site has been migrated, so `tsc` now names any new one that forgets to say
   * which of the two it is.
   *
   * ⚠ There is deliberately no field for the model the CLIENT asked for. There was
   * one (`backendModel`), and it was the only model id in the log: routing resolves
   * a tier/pool spec to a `ResolvedTarget`, so the requested id and the serving
   * deployment routinely differ, and every "which model trips the validator"
   * conclusion drawn from this dataset was attributed to whatever the client
   * happened to name. Don't reintroduce it beside these two — a reader who has both
   * will read the wrong one.
   */
  servedProvider: string | null;
  /**
   * The backend model id that actually served the request
   * (`ResolvedTarget.model`), or `null` when nothing served it. An anthropic
   * passthrough target carries no model id of its own, and that is `null` too.
   */
  servedModel: string | null;
  /** Opaque configured credential slot that served, when known. Never a secret value. */
  servedCredential: string | null;
  /** Raw upstream model id, present only when it differs from the resolved target. */
  upstreamReportedModel?: string;
  /** Bounded, statuses-only candidate walk. Never carries error text or bodies. */
  attempts: RequestAttemptLog[];
  hadTools: boolean;
  streamed: boolean;
  backendStatus: number;
  validated: "pass" | "fail" | "uncheckable" | "skipped";
  toolUseCount: number;
  uncheckableCount: number;
  errorKinds: string[];
  /** Repair outcome (repair mode only); "none" when repair did not run. "cancelled"
   *  means the caller went away mid-repair — distinct from "failed" (nothing was
   *  reachable), because the two call for opposite responses. */
  repair: "none" | "fixed" | "failed" | "refused" | "refused_destructive" | "cancelled";
  /**
   * How many `tool_use` ids the relay had to mint because the serving host reused ones the
   * conversation already carried (`src/tool-use-ids.ts`). Absent when none were — a host that
   * mints unique ids leaves no trace here.
   *
   * ⚠ A COUNT, never an id. It is here because a streamed response cannot carry the
   * `x-llm-relay-tool-use-ids` header (headers are written before the first tool call exists),
   * so for stream traffic — which is all agentic traffic — this is the only place the pass shows.
   */
  toolUseIdRewrites?: number;
  /**
   * How many OUTBOUND tool-call ids the request mapper rewrote to the serving provider's stated
   * shape (`src/openai-request.ts`, `compat.toolCallIds: "strict9"` — mistral's
   * `^[a-zA-Z0-9]{9}$`). Absent when none were, which is every provider that states no such rule.
   *
   * ⚠ A COUNT, never an id — the same rule as `toolUseIdRewrites`.
   */
  toolCallIdRewrites?: number;
  latencyMs: number;
}

/**
 * The ONLY fields that may reach a log line, in emit order.
 *
 * `write()` projects a record through this allow-list instead of serialising the
 * object it was handed, so "logs are metadata only" is enforced at the sink
 * rather than trusted of every call site. A caller that hands over a wider
 * object — a header map, a response body, an error carrying a key substring —
 * cannot leak it through here, and a new field only starts being logged when
 * someone deliberately adds it to this list. `test/log.test.ts` pins that.
 */
const LOG_FIELDS = [
  "ts",
  "path",
  "servedProvider",
  "servedModel",
  "servedCredential",
  "upstreamReportedModel",
  "attempts",
  "hadTools",
  "streamed",
  "backendStatus",
  "validated",
  "toolUseCount",
  "uncheckableCount",
  "errorKinds",
  "repair",
  "toolUseIdRewrites",
  "toolCallIdRewrites",
  "latencyMs",
] as const satisfies readonly (keyof RequestLog)[];

const ATTEMPT_FIELDS = ["provider", "model", "status", "ms"] as const satisfies readonly (keyof RequestAttemptLog)[];

function metadataOnlyAttempts(value: unknown): RequestAttemptLog[] {
  if (!Array.isArray(value)) return [];
  const out: RequestAttemptLog[] = [];
  for (const raw of value.slice(0, MAX_LOG_ATTEMPTS)) {
    if (typeof raw !== "object" || raw === null) continue;
    const candidate = raw as Record<string, unknown>;
    const provider = candidate["provider"];
    const model = candidate["model"];
    const status = candidate["status"];
    const ms = candidate["ms"];
    const validStatus =
      (typeof status === "number" && Number.isFinite(status)) ||
      status === "failed" ||
      status === "cancelled" ||
      status === "committed" ||
      status === "dead-turn" ||
      status === "capped";
    if (
      typeof provider !== "string" ||
      (typeof model !== "string" && model !== null) ||
      !validStatus ||
      typeof ms !== "number" ||
      !Number.isFinite(ms)
    ) {
      continue;
    }
    const projected: Record<string, unknown> = {};
    for (const field of ATTEMPT_FIELDS) projected[field] = candidate[field];
    out.push(projected as unknown as RequestAttemptLog);
  }
  return out;
}

/** Project a record down to the allow-listed metadata fields. */
function metadataOnly(record: RequestLog): Record<string, unknown> {
  const seen = record as unknown as Record<string, unknown>;
  const out: Record<string, unknown> = {};
  for (const field of LOG_FIELDS) {
    const value = seen[field];
    if (field === "attempts") {
      out[field] = metadataOnlyAttempts(value);
      continue;
    }
    if (value !== undefined) out[field] = value;
  }
  return out;
}

/** Keep one predecessor when the next complete JSONL record would exceed the cap. */
function rotateIfNeeded(file: string, incomingBytes: number, maxBytes: number): void {
  if (!existsSync(file) || statSync(file).size + incomingBytes <= maxBytes) return;
  const predecessor = `${file}.1`;
  rmSync(predecessor, { force: true });
  renameSync(file, predecessor);
}

export class MetadataLogger {
  constructor(private readonly cfg: Config["log"]) {}

  write(record: RequestLog): void {
    if (this.cfg.level === "silent") return;
    // Reporting degradation must never become a failure path: a full disk, a
    // read-only log directory, or a closed stdout is a logging problem, not a
    // request problem, and must not surface to the client as a 500.
    try {
      const line = JSON.stringify(metadataOnly(record));
      if (this.cfg.file) {
        try {
          const entry = line + "\n";
          rotateIfNeeded(
            this.cfg.file,
            Buffer.byteLength(entry),
            this.cfg.maxBytes ?? DEFAULT_LOG_MAX_BYTES,
          );
          appendFileSync(this.cfg.file, entry);
        } catch {
          process.stderr.write(line + "\n");
        }
      } else {
        process.stdout.write(line + "\n");
      }
    } catch {
      // Both the sink and the fallback sink failed. There is nowhere left to
      // report to, and throwing from here would fail the request over a log line.
    }
  }
}
