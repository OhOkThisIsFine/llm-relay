import { appendFileSync, existsSync, renameSync, rmSync, statSync } from "node:fs";
import type { Config } from "./config.js";

export const DEFAULT_LOG_MAX_BYTES = 50 * 1024 * 1024;

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
  hadTools: boolean;
  streamed: boolean;
  backendStatus: number;
  validated: "pass" | "fail" | "uncheckable" | "skipped";
  toolUseCount: number;
  uncheckableCount: number;
  errorKinds: string[];
  /** Repair outcome (repair mode only); "none" when repair did not run. */
  repair: "none" | "fixed" | "failed" | "refused" | "refused_destructive";
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
  "hadTools",
  "streamed",
  "backendStatus",
  "validated",
  "toolUseCount",
  "uncheckableCount",
  "errorKinds",
  "repair",
  "latencyMs",
] as const satisfies readonly (keyof RequestLog)[];

/** Project a record down to the allow-listed metadata fields. */
function metadataOnly(record: RequestLog): Record<string, unknown> {
  const seen = record as unknown as Record<string, unknown>;
  const out: Record<string, unknown> = {};
  for (const field of LOG_FIELDS) {
    const value = seen[field];
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
