/**
 * The lane QUOTA probe — is a `cli` lane's balance alive right now?
 *
 * `lane-probe.ts` asks a lane's tool what it SERVES (a catalog query, no quota spent). This
 * module asks whether the lane can still ANSWER, which only a real minimal completion can prove —
 * and that spends the lane's own quota, so nothing here runs on a timer for healthy lanes: the
 * cadence (`lane-cadence.ts`) probes only buckets carrying an ACTIVE recorded death, because an
 * alive lane is re-tested by real use for free.
 *
 * Classification is fail-safe in BOTH directions, the `context-limits.ts` discipline:
 * - Only a real answer (exit 0, non-empty output) proves alive and may RETRACT a recorded death.
 * - Only an explicit rate/quota statement in the failure text may RECORD one, through the same
 *   closed `DispatchOutcome` classes a host report uses. "The word quota wins": a spent allowance
 *   is `quota_exhausted` even when the message also says "limit" — the 0.28.0 lesson, facing this
 *   direction.
 * - Everything else — timeout, empty success, unrecognized error — is `inconclusive` and changes
 *   NOTHING. A miss learns nothing.
 *
 * A probe result never touches the breaker, facts, or accounting: ladder exhaustion state
 * (`dispatch.ts` cooldown keys) is the one store this feeds, per the 2026-08-29 owner decision
 * that the relay's stores are authoritative for lane quota facts.
 */
import { execFile, exec } from "node:child_process";
import { TASK_TOKEN, MAX_EXHAUSTED_MS, type DispatchOutcome } from "./dispatch.js";
import { laneOfRung } from "./lane-manifest.js";
import type { Config, LadderRung } from "./config.js";

/** Minimal spend; the no-shell instruction is agy policy on this machine and harmless elsewhere. */
export const LANE_PROBE_PROMPT = "Reply with the single word OK. Do not run shell commands.";

/** A lane probe waits out a slow cold start; past this it is inconclusive, never evidence. */
export const LANE_QUOTA_PROBE_TIMEOUT_MS = 240_000;

export interface LaneProbeSpawnResult {
  code: number | null;
  stdout: string;
  stderr: string;
  timedOut: boolean;
}

/** Injected spawn seam so no test ever runs a real lane; see `defaultLaneProbeSpawner`. */
export type LaneProbeSpawner = (
  command: string,
  args: string[],
  opts: { env: NodeJS.ProcessEnv; timeoutMs: number },
) => Promise<LaneProbeSpawnResult>;

export type LaneQuotaVerdict =
  | { kind: "alive" }
  | { kind: "exhausted"; outcome: DispatchOutcome; retryAfterMs: number | null; evidence: string }
  | { kind: "inconclusive"; reason: string };

/** One probeable quota bucket: the cooldown key it feeds and the rung whose command tests it. */
export interface LaneQuotaTarget {
  /** `quota:<name>` / `rung:<id>` — the `dispatch.ts` cooldown key this probe would retract. */
  key: string;
  lane: string;
  command: string;
  rung: LadderRung;
}

/**
 * Every distinct probeable quota bucket the configured ladders reference, first-appearance order.
 * Disabled rungs are included on purpose: disabled is a config choice about DISPATCH, but the
 * bucket's quota state is still worth re-testing — the motivating incident was a parked lane
 * whose quota had silently reset. A rung without the `{task}` placeholder cannot carry a probe
 * prompt and is skipped.
 */
export function laneQuotaTargets(cfg: Config): LaneQuotaTarget[] {
  const out: LaneQuotaTarget[] = [];
  const seen = new Set<string>();
  const ladders = cfg.routing.ladders ?? {};
  for (const rung of [...Object.values(ladders).flat(), ...(cfg.routing.ladder ?? [])]) {
    if (rung?.kind !== "cli" || typeof rung.command !== "string") continue;
    const match = laneOfRung(rung.command, rung.args);
    if (!match) continue;
    if (!(rung.args ?? []).some((a) => a.includes(TASK_TOKEN))) continue;
    const key = rung.quota ? `quota:${rung.quota}` : `rung:${rung.id}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({ key, lane: match.lane, command: rung.command, rung });
  }
  return out;
}

/**
 * The exact invocation a probe runs: the rung's own command with `{task}` replaced by the probe
 * prompt, under the rung's declared env deltas. ⚠ `{task}` is substituted in ARGS only — env
 * values pass through verbatim, the same placeholder rule the dispatch renderer enforces
 * (request content must never become process configuration).
 */
export function buildLaneProbeInvocation(
  target: LaneQuotaTarget,
  prompt: string = LANE_PROBE_PROMPT,
): { command: string; args: string[]; env: NodeJS.ProcessEnv } {
  const args = (target.rung.args ?? []).map((a) => a.split(TASK_TOKEN).join(prompt));
  const env: NodeJS.ProcessEnv = { ...process.env };
  for (const [name, value] of Object.entries(target.rung.env ?? {})) {
    if (value === null) delete env[name];
    else env[name] = value;
  }
  return { command: target.command, args, env };
}

/**
 * Closed statement patterns. Quota patterns are tested FIRST: a message naming a spent
 * quota/allowance often also contains the word "limit", and cooling a spent allowance for a
 * rate-limit's 15 minutes is the exact confusion `refusal-interpretation.ts` records from 0.28.0.
 */
const QUOTA_PATTERNS: RegExp[] = [
  /\bquota\b/i,
  /\busage[ -]?limit/i,
  /\ballowance\b/i,
  /\bout of credits?\b/i,
  /\binsufficient credits?\b/i,
  /\bcredit balance\b/i,
];
const RATE_PATTERNS: RegExp[] = [/\btoo many requests\b/i, /\brate[ -]?limit/i, /\b429\b/];

/** Closed unit vocabulary for a stated retry window; an unknown word records nothing. */
const RETRY_UNIT_MS: Record<string, number> = {
  s: 1000, sec: 1000, secs: 1000, second: 1000, seconds: 1000,
  m: 60_000, min: 60_000, mins: 60_000, minute: 60_000, minutes: 60_000,
  h: 3_600_000, hr: 3_600_000, hrs: 3_600_000, hour: 3_600_000, hours: 3_600_000,
  d: 86_400_000, day: 86_400_000, days: 86_400_000,
};

/** "try again in 30 seconds" / "resets in 2 hours" → ms; absent or unrecognized → null. */
function statedRetryAfterMs(text: string): number | null {
  const m = /(?:try again|retry|resets?) (?:in|after) (\d+(?:\.\d+)?) ?([a-z]+)/i.exec(text);
  if (!m || m[1] === undefined || m[2] === undefined) return null;
  const value = Number(m[1]);
  if (!Number.isFinite(value) || value < 0) return null;
  const perUnit = RETRY_UNIT_MS[m[2].toLowerCase()];
  if (perUnit === undefined) return null;
  return Math.min(Math.round(value * perUnit), MAX_EXHAUSTED_MS);
}

/** The first line matching `pattern`, trimmed and bounded — evidence for the operator, never logged with task content (a probe carries none). */
function evidenceLine(text: string, pattern: RegExp): string {
  for (const line of text.split("\n")) {
    if (pattern.test(line)) return line.trim().slice(0, 200);
  }
  return text.trim().slice(0, 200);
}

export function classifyLaneProbeOutput(result: LaneProbeSpawnResult): LaneQuotaVerdict {
  if (result.timedOut) return { kind: "inconclusive", reason: "probe timed out — slowness is not quota evidence" };
  const stdout = result.stdout.trim();
  if (result.code === 0) {
    if (stdout.length > 0) return { kind: "alive" };
    // The empty-answer failure mode is real (agy discards long answers) but states nothing
    // about quota — a miss learns nothing.
    return { kind: "inconclusive", reason: "exit 0 with empty output" };
  }
  const text = `${result.stdout}\n${result.stderr}`;
  for (const pattern of QUOTA_PATTERNS) {
    if (pattern.test(text)) {
      return {
        kind: "exhausted",
        outcome: "quota_exhausted",
        retryAfterMs: statedRetryAfterMs(text),
        evidence: evidenceLine(text, pattern),
      };
    }
  }
  for (const pattern of RATE_PATTERNS) {
    if (pattern.test(text)) {
      return {
        kind: "exhausted",
        outcome: "rate_limited",
        retryAfterMs: statedRetryAfterMs(text),
        evidence: evidenceLine(text, pattern),
      };
    }
  }
  return { kind: "inconclusive", reason: `unrecognized failure (exit ${result.code ?? "none"})` };
}

/**
 * The real spawner. `windowsHide` is load-bearing for the console-less daemon (see
 * `lane-probe.ts`); the ENOENT retry-through-shell mirrors the same module's `.cmd` shim
 * fallback. It never rejects — every failure becomes a result the classifier reads.
 *
 * ⚠ Refuses to run under vitest, the `winenv.ts` guard: a suite must inject its own seam, never
 * spawn a real lane and spend real quota.
 */
export const defaultLaneProbeSpawner: LaneProbeSpawner = (command, args, opts) => {
  if (process.env.VITEST) {
    return Promise.resolve({
      code: null,
      stdout: "",
      stderr: "lane probe spawns are disabled under vitest — inject a spawner",
      timedOut: false,
    });
  }
  const execOpts = {
    encoding: "utf8" as const,
    maxBuffer: 16 * 1024 * 1024,
    timeout: opts.timeoutMs,
    windowsHide: true,
    env: opts.env,
  };
  const failureResult = (
    err: Error & { killed?: boolean | undefined; code?: unknown },
    stdout: string,
    stderr: string,
  ): LaneProbeSpawnResult => ({
    code: typeof err.code === "number" ? err.code : null,
    stdout,
    stderr: stderr ? stderr : err.message,
    timedOut: err.killed === true,
  });
  return new Promise((resolve) => {
    const child = execFile(command, args, execOpts, (err, stdout, stderr) => {
      if (!err) {
        resolve({ code: 0, stdout, stderr, timedOut: false });
        return;
      }
      if (process.platform === "win32" && err.code === "ENOENT") {
        const fallback = exec(`"${command}" ${args.join(" ")}`, execOpts, (err2, stdout2, stderr2) => {
          if (!err2) resolve({ code: 0, stdout: stdout2, stderr: stderr2, timedOut: false });
          else resolve(failureResult(err2, stdout2 ?? "", stderr2 ?? ""));
        });
        fallback.stdin?.end();
        return;
      }
      resolve(failureResult(err, stdout ?? "", stderr ?? ""));
    });
    // ⚠ Same stdin-EOF rule as `lane-probe.ts` runLaneCommand, measured on agy: an open stdin
    // pipe stalls the tool to the timeout — which the classifier correctly reads as
    // inconclusive, so the bug's symptom was "the probe never learns", not a wrong verdict.
    child.stdin?.end();
  });
};

/** Run one bucket's probe through the injected seam and classify what came back. */
export async function runLaneQuotaProbe(
  target: LaneQuotaTarget,
  opts: { spawn: LaneProbeSpawner; prompt?: string; timeoutMs?: number },
): Promise<{ verdict: LaneQuotaVerdict; raw: LaneProbeSpawnResult }> {
  const invocation = buildLaneProbeInvocation(target, opts.prompt ?? LANE_PROBE_PROMPT);
  const raw = await opts.spawn(invocation.command, invocation.args, {
    env: invocation.env,
    timeoutMs: opts.timeoutMs ?? LANE_QUOTA_PROBE_TIMEOUT_MS,
  });
  return { verdict: classifyLaneProbeOutput(raw), raw };
}
