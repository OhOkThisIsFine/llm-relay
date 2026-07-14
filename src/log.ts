import { appendFileSync } from "node:fs";
import type { Config } from "./config.js";

/**
 * Metadata-only request log. NEVER records headers or bodies — only the shape of
 * what happened. This is the dataset that reveals which backend models trip the
 * validator (format-broken, reshapeable) vs pass cleanly.
 */
export interface RequestLog {
  ts: string;
  path: string;
  backendModel: string | null;
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

export class MetadataLogger {
  constructor(private readonly cfg: Config["log"]) {}

  write(record: RequestLog): void {
    if (this.cfg.level === "silent") return;
    const line = JSON.stringify(record);
    if (this.cfg.file) {
      try {
        appendFileSync(this.cfg.file, line + "\n");
      } catch {
        process.stderr.write(line + "\n");
      }
    } else {
      process.stdout.write(line + "\n");
    }
  }
}
