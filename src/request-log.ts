import type { ResolvedTarget } from "./config.js";
import type { RequestAttemptLog, RequestLog } from "./log.js";

/** Build the metadata-only record shared by data-plane and admin handlers. */
export function baseLog(
  started: number,
  path: string,
  hadTools: boolean,
  streamed: boolean,
  backendStatus: number,
  validated: RequestLog["validated"],
  served: ResolvedTarget | null,
  attempts: readonly RequestAttemptLog[] = [],
): RequestLog {
  return {
    ts: new Date(started).toISOString(),
    path: logSafePath(path),
    servedProvider: served ? served.provider : null,
    servedModel: served ? served.model ?? null : null,
    attempts: [...attempts],
    hadTools,
    streamed,
    backendStatus,
    validated,
    toolUseCount: 0,
    uncheckableCount: 0,
    errorKinds: [],
    repair: "none",
    latencyMs: Date.now() - started,
  };
}

/** Keep query parameter names for diagnostics while replacing content-bearing values. */
export function logSafePath(path: string): string {
  const q = path.indexOf("?");
  if (q === -1) return path;
  const route = path.slice(0, q);
  const params = new URLSearchParams(path.slice(q + 1));
  const shape = [...params.keys()].map((key) => `${key}=<${params.get(key)?.length ?? 0}c>`).join("&");
  return shape ? `${route}?${shape}` : route;
}
