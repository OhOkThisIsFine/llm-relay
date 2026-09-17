/**
 * Process-level safety net for late transport errors.
 *
 * The failure this guards against: undici resolves `fetch()` and the request path moves on,
 * but the underlying socket is reset LATER — by a CDN edge, a free-tier host recycling
 * connections, or a discarded failover candidate whose un-read body `discardCandidate()`
 * cancelled. undici emits that late error on a stream with no listener, Node escalates it to
 * an `uncaughtException`, and with no handler installed the whole proxy exits 1. This proxy
 * fronts every client session, so a third party closing a socket must never take it down —
 * the same reasoning as an unset `${ENV}` disabling one provider instead of aborting startup.
 *
 * Design (fork-validated in freellmapi's process-safety-net, adopted 2026-08-13 — see
 * docs/history/freellmapi-adoption-review-2026-08-13.md §1.3): swallow ONLY a closed allowlist of
 * transport error codes plus a short list of Node/undici-authored message shapes, and
 * preserve Node's default fail-fast exit(1) for everything else, so genuine bugs still crash
 * loudly. The classifier is a pure function so it is unit-testable without touching global
 * handlers.
 */

const TRANSPORT_ERROR_CODES = new Set([
  // Node socket-level codes
  "ECONNRESET",
  "ECONNREFUSED",
  "ECONNABORTED",
  "ETIMEDOUT",
  "EPIPE",
  "EAI_AGAIN",
  "ENOTFOUND",
  "EHOSTUNREACH",
  "ENETUNREACH",
  "EADDRNOTAVAIL",
  "ERR_STREAM_PREMATURE_CLOSE",
  // undici codes (the late-error culprits)
  "UND_ERR_SOCKET",
  "UND_ERR_CONNECT_TIMEOUT",
  "UND_ERR_HEADERS_TIMEOUT",
  "UND_ERR_BODY_TIMEOUT",
  "UND_ERR_ABORTED",
]);

// Matched only against Node/undici-authored error messages that ship without a usable code
// (e.g. fetch's `TypeError: fetch failed` wrapper). Provider response text never reaches an
// uncaught handler, so this is not provider-message inference.
const TRANSPORT_MESSAGE_HINTS = [
  "fetch failed",
  "other side closed",
  "socket hang up",
  "terminated",
  "premature close",
  "econnreset",
];

// undici wraps the real socket error in `err.cause`, sometimes nested. Bounded, cycle-safe.
type ChainLink = { code?: string | undefined; message?: string | undefined };
function walkErrorChain(err: unknown): ChainLink[] {
  const out: ChainLink[] = [];
  const seen = new Set<unknown>();
  let cur: unknown = err;
  for (let depth = 0; cur && typeof cur === "object" && depth < 6; depth++) {
    if (seen.has(cur)) break;
    seen.add(cur);
    const link = cur as { code?: unknown; message?: unknown; cause?: unknown };
    out.push({
      code: typeof link.code === "string" ? link.code : undefined,
      message: typeof link.message === "string" ? link.message : undefined,
    });
    cur = link.cause;
  }
  return out;
}

/** Pure: true when the error is a transport failure that should not crash the process. */
export function isTransportError(err: unknown): boolean {
  if (err == null) return false;
  const links = walkErrorChain(err);
  for (const { code } of links) {
    if (code && TRANSPORT_ERROR_CODES.has(code)) return true;
  }
  const joined = links.map((l) => l.message ?? "").join(" | ").toLowerCase();
  return TRANSPORT_MESSAGE_HINTS.some((h) => joined.includes(h));
}

export type ProcessErrorDecision = "swallow" | "fatal";

/** Pure: swallow transport errors; everything else keeps Node's fail-fast default. */
export function classifyProcessError(err: unknown): ProcessErrorDecision {
  return isTransportError(err) ? "swallow" : "fatal";
}

function describeError(err: unknown): string {
  const links = walkErrorChain(err);
  const code = links.find((l) => l.code)?.code;
  const message = links.find((l) => l.message)?.message;
  return code ? `${code} (${message ?? "no message"})` : (message ?? String(err));
}

type ProcessLike = Pick<NodeJS.Process, "on">;

export interface SafetyNetHooks {
  log?: (line: string, detail?: unknown) => void;
  exit?: (code: number) => void;
  /** Best-effort flush before a fatal exit (the write-behind caches' crash window). */
  beforeExit?: () => void;
  /** Injectable process for tests; the idempotence guard applies only to the real one. */
  proc?: ProcessLike;
}

/**
 * Decide and act on a process-level error. Returns the decision so tests can assert it:
 * `swallow` logs one line and lets the process continue; `fatal` flushes (best-effort) and
 * exits 1, preserving Node's default.
 */
export function handleProcessError(
  kind: "uncaughtException" | "unhandledRejection",
  err: unknown,
  hooks: SafetyNetHooks = {},
): ProcessErrorDecision {
  const log = hooks.log ?? ((line: string, detail?: unknown) => console.error(line, detail ?? ""));
  const decision = classifyProcessError(err);
  if (decision === "swallow") {
    log(`llm-relay: swallowed transient ${kind}: ${describeError(err)}`);
    return "swallow";
  }
  log(`llm-relay: fatal ${kind}:`, err);
  try {
    hooks.beforeExit?.();
  } catch {
    // A flush failure must not mask the original fatal error.
  }
  (hooks.exit ?? process.exit)(1);
  return "fatal";
}

let installedOnRealProcess = false;

/** Test-only: forget that the real-process handlers were installed. */
export function resetProcessSafetyNet(): void {
  installedOnRealProcess = false;
}

/**
 * Install the global handlers. Idempotent on the real process. Call at the top of the serve
 * path, before the server takes traffic — a CLI subcommand does not need (or get) it.
 */
export function installProcessSafetyNet(hooks: SafetyNetHooks = {}): void {
  const proc = hooks.proc;
  if (!proc) {
    if (installedOnRealProcess) return;
    installedOnRealProcess = true;
  }
  const target: ProcessLike = proc ?? process;
  target.on("uncaughtException", (err: unknown) =>
    handleProcessError("uncaughtException", err, hooks),
  );
  target.on("unhandledRejection", (reason: unknown) =>
    handleProcessError("unhandledRejection", reason, hooks),
  );
}
