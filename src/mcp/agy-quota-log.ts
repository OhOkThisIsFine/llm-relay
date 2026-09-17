/**
 * AGY's own statement that a lane's quota is spent, read from AGY's log.
 *
 * WHY THIS EXISTS (2026-09-10, `docs/history/dispatch-giveup-diagnosis-2026-09-10.md` §4). When an AGY
 * model's quota is spent, AGY retries the call with back-off for about ten minutes and prints
 * NOTHING to stdout while it does. The statement lives only in AGY's log:
 *
 *   Run: attempt 1 failed (RESOURCE_EXHAUSTED (code 429): Individual quota reached. Please upgrade
 *   your subscription to increase your limits. Resets in 144h10m31s.), retrying in 4s
 *
 * The dispatch walk stops an AGY lane at its budget long before AGY gives up, so the lane's own
 * output never carried the statement and the relay never recorded the death: `agy-claude-opus`
 * stayed `ready` through 34 failed runs, until one forced 604 s run let AGY finish and say so.
 *
 * ⚠ The log is SHARED by every AGY run on the machine, and AGY rewrites it on each run. So a quota
 * line is attributed to a lane only when every run header in the log names that lane's model
 * (`Print mode: starting (… model="<id>" …)`) and the file changed at or after the lane started.
 * Anything else — another model's run, a stale file, a log with no header — yields null, the weaker
 * claim: a quota death recorded against the wrong lane would park a healthy lane for days.
 *
 * ⚠ The reset is AGY's own stated duration ("Resets in 144h10m31s") — a vendor statement, which is
 * the standing that permits a cooldown at all. No statement ⇒ no report; this module never invents
 * a duration.
 *
 * Pure over its inputs apart from `readAgyLog`, the one file read, which the MCP server injects so
 * the suite never touches the operator's real AGY log.
 */
import { readFileSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

export interface AgyLogSnapshot {
  text: string;
  mtimeMs: number;
}

/** Where AGY keeps its CLI log. AGY rewrites the file on every run. */
export function defaultAgyLogPath(): string {
  return join(homedir(), ".gemini", "antigravity-cli", "cli.log");
}

/**
 * Read AGY's log, or null when it is absent or unreadable.
 *
 * ⚠ Under vitest this returns null unless a path is given — the `winenv.ts` / `os-keyring.ts`
 * discipline: a suite must never read the operator's real AGY log.
 */
export function readAgyLog(path?: string): AgyLogSnapshot | null {
  if (path === undefined && process.env["VITEST"]) return null;
  const file = path ?? defaultAgyLogPath();
  try {
    const { mtimeMs } = statSync(file);
    return { text: readFileSync(file, "utf8"), mtimeMs };
  } catch {
    return null;
  }
}

/**
 * Go's duration units, closed. This table IS the list — its keys are the union — so a unit cannot be
 * spelled in one place and forgotten in another. The pattern below is built from its keys, longest
 * first, so `10ms` never reads as ten minutes.
 */
const GO_DURATION_UNIT_MS = {
  h: 3_600_000,
  m: 60_000,
  s: 1_000,
  ms: 1,
  us: 0.001,
  "µs": 0.001,
  ns: 0.000_001,
} as const;
type GoDurationUnit = keyof typeof GO_DURATION_UNIT_MS;
const GO_DURATION_PART = new RegExp(
  `(\\d+(?:\\.\\d+)?)(${Object.keys(GO_DURATION_UNIT_MS).sort((a, b) => b.length - a.length).join("|")})`,
  "y",
);

/**
 * A Go duration (`144h10m31s`, `1m53.630865376s`, `45s`) in whole milliseconds, or null when the
 * text is not ONE complete duration. ⚠ Every character must be consumed: a trailing fragment means
 * the text is not what this parser understands, and a partial parse would report a shorter reset
 * than AGY stated.
 */
export function parseGoDurationMs(text: string): number | null {
  const s = text.trim();
  if (s.length === 0) return null;
  let total = 0;
  let pos = 0;
  while (pos < s.length) {
    GO_DURATION_PART.lastIndex = pos;
    const m = GO_DURATION_PART.exec(s);
    if (m === null) return null;
    total += Number(m[1]) * GO_DURATION_UNIT_MS[m[2] as GoDurationUnit];
    pos = GO_DURATION_PART.lastIndex;
  }
  return Number.isFinite(total) && total > 0 ? Math.round(total) : null;
}

export interface AgyQuotaStatement {
  /** `quota_exhausted` when AGY's line names a quota — the word quota wins — else `rate_limited`. */
  outcome: "quota_exhausted" | "rate_limited";
  /** AGY's own stated time until the limit resets, in milliseconds. */
  retryAfterMs: number;
  /** The matched line, bounded, for a diagnostic. Never parsed again. */
  line: string;
}

const RUN_HEADER = /Print mode: starting \([^)]*?model="([^"]+)"/g;
const LIMIT_LINE = /RESOURCE_EXHAUSTED \(code 429\): ([^\n]*?)Resets in ([0-9.hmsuµn]+)\./g;

/**
 * The limit statement in one AGY log snapshot that belongs to `model`, or null.
 *
 * Null unless ALL of these hold: the log changed at or after `startedAtMs`, it holds at least one
 * run header and EVERY run header names exactly `model`, and it holds a `RESOURCE_EXHAUSTED
 * (code 429)` line with a complete `Resets in <duration>`. The LAST such line wins, because its
 * duration is AGY's most recent statement.
 */
export function agyQuotaStatement(
  snapshot: AgyLogSnapshot | null,
  model: string,
  startedAtMs: number,
): AgyQuotaStatement | null {
  if (snapshot === null) return null;
  // A non-finite time is a read we cannot place in time, so it proves nothing about this run.
  if (!Number.isFinite(snapshot.mtimeMs) || snapshot.mtimeMs < startedAtMs) return null;
  const headers = [...snapshot.text.matchAll(RUN_HEADER)].map((m) => m[1]);
  if (headers.length === 0 || headers.some((h) => h !== model)) return null;
  let last: AgyQuotaStatement | null = null;
  for (const m of snapshot.text.matchAll(LIMIT_LINE)) {
    const retryAfterMs = parseGoDurationMs(m[2] ?? "");
    if (retryAfterMs === null) continue;
    last = {
      outcome: /quota/i.test(m[1] ?? "") ? "quota_exhausted" : "rate_limited",
      retryAfterMs,
      line: m[0].slice(0, 300),
    };
  }
  return last;
}
