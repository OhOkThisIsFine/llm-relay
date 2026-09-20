/**
 * The whole circuit-breaker cell must survive a relay restart — not just its cooling half.
 *
 * `circuit-breaker.ts` performs no IO, so every cooldown and the whole unexplained-429 escalation
 * ladder used to die with the process. `src/breaker-persistence.ts` originally mirrored only the
 * COOLING fields (`cooldownUntil`, `cooldownSource`, `unexplained429s`, `lastStatus`); owner
 * decision 2026-09-08 widened it so the failure counters, credential fault, the served-request ping
 * window, and quota observations all survive too, with the same semantics the running process has.
 *
 * This file exercises that widened contract under its RENAMED API: `BreakerCellRow` (was
 * `BreakerCooldownRow`), `CircuitBreaker.exportState()`/`.restoreState()` (was
 * `.exportCooldowns()`/`.restoreCooldowns()`), `CircuitBreaker.onStateChanged()` (was
 * `.onCoolingChanged()`), and `loadBreakerState()`/`saveBreakerState()`/`installBreakerPersistence()`
 * (was the `*Cooldowns()` spellings) — none of which take a `now` option any more. Every time-based
 * assertion here uses an explicit `at` timestamp on the recorded outcome instead. Note also that
 * `installBreakerPersistence()` now returns a HANDLE (`{ restored, flush() }`), not a bare number.
 *
 * ⚠ Every test here uses an explicit temp path. `getBreakerStatePath()` redirects under vitest as
 * well, but a suite that trips breakers must never be one guard away from cooling the developer's
 * own deployments.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, writeFileSync, readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { CircuitBreaker, type BreakerCellRow } from "../src/circuit-breaker.js";
import {
  CURRENT_BREAKER_STATE_VERSION,
  loadBreakerState,
  saveBreakerState,
  installBreakerPersistence,
  flushBreakerPersistence,
} from "../src/breaker-persistence.js";
import { makeCredentialId } from "../src/credential-id.js";
import type { ProviderTargetIdentity } from "../src/kernel/contracts.js";
import type { QuotaObservation } from "../src/quota-observation.js";
import { getTelemetryReport } from "../src/telemetry.js";
import { candidateEnvNames } from "../src/authEnv.js";
import type { Config, ProviderTierType } from "../src/config.js";

const HOUR = 3_600_000;

let dir: string;
let statePath: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "llm-relay-breaker-state-"));
  statePath = join(dir, "breaker-state.json");
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

function identity(provider: string, model: string | null): ProviderTargetIdentity {
  return { provider, model, kind: "openai", credentialId: makeCredentialId(provider) };
}

/** Drive the escalation ladder with N consecutive unexplained 429s, as the live case did. */
function escalate(breaker: CircuitBreaker, target: ProviderTargetIdentity, times: number, at: number): void {
  for (let i = 0; i < times; i++) {
    breaker.recordOutcome(target, { ok: false, status: 429, elapsedMs: 1, at });
  }
}

/**
 * Copied from `twoProviderCfg()`/`cfgWith()`/`provider()` in test/telemetry.test.ts, renamed here
 * so it cannot be confused with this file's own `identity()`/target-shaped helpers. Only the ping/
 * telemetry test below needs a `Config`. `getTelemetryReport`'s stability score does not actually
 * read `hasKey`, but the env dance is cheap and keeps this fixture identical in shape to the one
 * `src/telemetry.ts` is otherwise tested against.
 */
const TELEMETRY_ENV_KEYS = [...new Set([
  ...candidateEnvNames("nim", "NVIDIA_API_KEY"),
  ...candidateEnvNames("openai", "OPENAI_API_KEY"),
])];

const telemetryProvider = (authEnv: string, tierType: ProviderTierType, signupUrl?: string) => ({
  base: "https://example.invalid/v1",
  kind: "openai" as const,
  authEnv,
  authHeader: "authorization" as const,
  timeoutMs: 120000,
  tierType,
  ...(signupUrl ? { signupUrl } : {}),
});

const telemetryCfg = (providers: Config["providers"]): Config =>
  ({
    host: "127.0.0.1",
    port: 8791,
    mode: "repair",
    log: { level: "metadata", file: null },
    repair: { maxAttempts: 2, destructiveTools: [] },
    providers,
    routing: {
      default: "nim/z-ai/glm-5.2",
      tiers: { opus: "openai/gpt-4o", sonnet: "nim/z-ai/glm-5.2" },
    },
  }) as Config;

const twoProviderCfg = (): Config =>
  telemetryCfg({
    nim: telemetryProvider("NVIDIA_API_KEY", "free", "https://build.nvidia.com"),
    openai: telemetryProvider("OPENAI_API_KEY", "subscription"),
  });

const savedTelemetryEnv: Record<string, string | undefined> = {};
beforeEach(() => {
  for (const k of TELEMETRY_ENV_KEYS) {
    savedTelemetryEnv[k] = process.env[k];
    process.env[k] = "test-key";
  }
});
afterEach(() => {
  for (const k of TELEMETRY_ENV_KEYS) {
    const v = savedTelemetryEnv[k];
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
});

describe("the whole breaker cell survives a restart", () => {
  it("carries a cooldown and its escalation counter into a fresh breaker", () => {
    const now = 1_000_000_000_000;
    const target = identity("nim", "moonshotai/kimi-k3");

    const before = new CircuitBreaker();
    installBreakerPersistence(before, { path: statePath });
    // Seven consecutive unexplained 429s: the live kimi-k3 case. The ladder tops out at 24h.
    escalate(before, target, 7, now);
    const learned = before.getState(target)!;
    expect(learned.cooldownUntil).toBeGreaterThan(now + 23 * HOUR);
    expect(learned.unexplained429s).toBe(7);
    expect(learned.cooldownSource).toBe("escalation");
    // The write-behind timer is debounced, so force the flush the way a shutdown would.
    saveBreakerState(before.exportState(), { path: statePath });

    // ── restart ──────────────────────────────────────────────────────────────────────────────
    const after = new CircuitBreaker();
    const restored = installBreakerPersistence(after, { path: statePath }).restored;
    expect(restored).toBe(1);

    const carried = after.getState(target)!;
    expect(carried.cooldownUntil).toBe(learned.cooldownUntil);
    expect(carried.unexplained429s).toBe(7);
    expect(carried.cooldownSource).toBe("escalation");
    expect(after.isHealthy(target, now + HOUR)).toBe(false);
  });

  /**
   * ⚠ Every `CooldownSource` must survive the round trip — see `COOLDOWN_SOURCES` in
   * `src/circuit-breaker.ts`, which the validator derives its accepted set from rather than
   * hand-listing, precisely so a new member (like `elapsed`) cannot silently fail to load.
   */
  it("carries every cooldown source across a restart, the newest one included", () => {
    const now = 1_000_000_000_000;
    const target = identity("nim", "deepseek-ai/deepseek-v4-flash-0731");

    const before = new CircuitBreaker();
    // Two 120-second timeouts: the live hang. The second trips, and it cools for what it wasted.
    before.recordOutcome(target, { ok: false, status: 504, elapsedMs: 120_007, at: now });
    before.recordOutcome(target, { ok: false, status: 504, elapsedMs: 120_007, at: now });
    expect(before.getState(target)!.cooldownSource).toBe("elapsed");
    saveBreakerState(before.exportState(), { path: statePath });

    const after = new CircuitBreaker();
    expect(installBreakerPersistence(after, { path: statePath }).restored).toBe(1);
    const carried = after.getState(target)!;
    expect(carried.cooldownSource).toBe("elapsed");
    expect(carried.cooldownUntil).toBe(now + 120_007);
  });

  it("restores a repeated-failure escalation row with its counter and status intact", () => {
    const now = 1_000_000_000_000;
    const target = identity("nim", "flaky-500");

    const before = new CircuitBreaker();
    for (let i = 0; i < 5; i += 1) {
      before.recordOutcome(target, { ok: false, status: 500, elapsedMs: 5, at: now + i });
    }
    const learned = before.getState(target)!;
    expect(learned.cooldownSource).toBe("failure-escalation");
    expect(learned.consecutiveFailures).toBe(5);
    expect(learned.lastStatus).toBe(500);
    saveBreakerState(before.exportState(), { path: statePath });

    const after = new CircuitBreaker();
    expect(installBreakerPersistence(after, { path: statePath }).restored).toBe(1);
    const carried = after.getState(target)!;
    expect(carried.cooldownSource).toBe("failure-escalation");
    expect(carried.cooldownUntil).toBe(learned.cooldownUntil);
    expect(carried.consecutiveFailures).toBe(5);
    expect(carried.lastStatus).toBe(500);
  });

  /**
   * ⚠ The point of carrying the COUNTER, not just the expiry: once the cooldown lifts, the next
   * unexplained 429 must resume at the top of the ladder rather than restart at two minutes.
   */
  it("resumes the escalation ladder rather than restarting it after the cooldown lifts", () => {
    const now = 1_000_000_000_000;
    const target = identity("gemini", "models/gemini-3.6-flash");

    const before = new CircuitBreaker();
    escalate(before, target, 4, now);
    saveBreakerState(before.exportState(), { path: statePath });

    const after = new CircuitBreaker();
    installBreakerPersistence(after, { path: statePath });
    // The cooldown has lifted by this point; the counter has not been re-measured, only carried.
    const lifted = after.getState(target)!.cooldownUntil + 1;
    after.recordOutcome(target, { ok: false, status: 429, elapsedMs: 1, at: lifted });
    // 5th unexplained 429 -> still the top rung (24h), not the 2m first rung.
    expect(after.getState(target)!.cooldownUntil - lifted).toBe(86_400_000);
    expect(after.getState(target)!.unexplained429s).toBe(5);
  });

  /**
   * FLIPPED (owner decision 2026-09-08): a lapsed cooldown now restores AS LAPSED, carrying its
   * escalation-ladder position with it — the opposite of the old "restore only while the cooldown
   * is still in the future" rule, which reset the ladder to zero on every restart. The running
   * process never discards a lapsed cooldown's `unexplained429s` (only a FRESH 429 applies it); a
   * restart is not a success, so it must not act like one either.
   */
  it("restores a lapsed cooldown as lapsed and keeps its escalation ladder", () => {
    const now = 1_000_000_000_000;
    const target = identity("groq", "qwen/qwen3.6-27b");
    const row: BreakerCellRow = {
      provider: "groq",
      model: "qwen/qwen3.6-27b",
      kind: "openai",
      credentialId: makeCredentialId("groq"),
      cooldownUntil: now + 1000,
      cooldownSource: "escalation",
      unexplained429s: 9,
    };
    saveBreakerState([row], { path: statePath });

    const after = new CircuitBreaker();
    // Two hours later the cooldown has long lifted — but restoring it is not the same as the
    // process having earned a success, so the ladder position must still be there.
    const restored = installBreakerPersistence(after, { path: statePath }).restored;
    expect(restored).toBe(1);
    expect(after.isHealthy(target, now + 2 * HOUR)).toBe(true);
    expect(after.getState(target)!.unexplained429s).toBe(9);

    // One FRESH unexplained 429 resumes at the top rung (24h) — not the 2-minute first rung a
    // ladder that had been reset to zero would have produced.
    after.recordOutcome(target, { ok: false, status: 429, elapsedMs: 1, at: now + 2 * HOUR });
    expect(after.getState(target)!.cooldownUntil).toBe(now + 2 * HOUR + 86_400_000);
    expect(after.getState(target)!.cooldownSource).toBe("escalation");

    // Negative control: a FRESH breaker (no restored history at all) given one unexplained 429
    // cools only 2 minutes — proving the 24h result above came from the carried ladder position,
    // not from this 429 alone.
    const fresh = new CircuitBreaker();
    fresh.recordOutcome(target, { ok: false, status: 429, elapsedMs: 1, at: now });
    expect(fresh.getState(target)!.cooldownUntil).toBe(now + 120_000);
  });

  it("restores the consecutive-failure count, so a second failure trips the cell", () => {
    const now = 1_000_000_000_000;
    const target = identity("nim", "flaky-model");

    const before = new CircuitBreaker();
    before.recordOutcome(target, { ok: false, status: 500, elapsedMs: 5, at: now });
    saveBreakerState(before.exportState(), { path: statePath });

    const after = new CircuitBreaker();
    expect(installBreakerPersistence(after, { path: statePath }).restored).toBe(1);
    after.recordOutcome(target, { ok: false, status: 500, elapsedMs: 5, at: now + 1000 });
    expect(after.isHealthy(target, now + 1000)).toBe(false);

    // Negative control: ONE failure alone, with no restored history behind it, never trips
    // (`MAX_FAILURES_BEFORE_TRIP` is 2) — confirming the trip above came from the RESTORED first
    // failure, not from this second one by itself.
    const fresh = new CircuitBreaker();
    fresh.recordOutcome(target, { ok: false, status: 500, elapsedMs: 5, at: now + 1000 });
    expect(fresh.isHealthy(target, now + 1000)).toBe(true);
  });

  it("restores a credential fault with its failure count and TTL", () => {
    const now = 1_000_000_000_000;
    const target = identity("openai", "gpt-4o");

    const before = new CircuitBreaker();
    before.recordCredentialFault(target, 401, now);
    saveBreakerState(before.exportState(), { path: statePath });

    const after = new CircuitBreaker();
    expect(installBreakerPersistence(after, { path: statePath }).restored).toBe(1);
    expect(after.hasCredentialFault(target, now + 60_000)).toBe(true);
    expect(after.getState(target)!.credentialFailures).toBe(1);
    expect(after.getState(target)!.lastCredentialStatus).toBe(401);
    // The 5-minute TTL (`CREDENTIAL_FAULT_TTL_MS`) is carried too, not reset to a fresh window —
    // the fault expires on the SAME clock it would have on a process that never restarted.
    expect(after.hasCredentialFault(target, now + 6 * 60_000)).toBe(false);
    expect(after.getState(target)!.credentialFailures).toBe(1);
  });

  it("restores the served-request ping window that GET /telemetry scores stability from", () => {
    const now = 1_000_000_000_000;
    const target = identity("nim", "z-ai/glm-5.2");

    const before = new CircuitBreaker();
    before.recordOutcome(target, { ok: true, status: 200, elapsedMs: 120, at: now });
    before.recordOutcome(target, { ok: false, status: 500, elapsedMs: 80, at: now + 1 });
    before.recordOutcome(target, { ok: true, status: 200, elapsedMs: 130, at: now + 2 });
    const originalPings = before.getState(target)!.pings;
    saveBreakerState(before.exportState(), { path: statePath });

    const after = new CircuitBreaker();
    expect(installBreakerPersistence(after, { path: statePath }).restored).toBe(1);
    expect(after.getState(target)!.pings).toEqual(originalPings);

    // This window is a DIFFERENT dataset from `probe-cache.json`, and it is exactly the one that
    // used to go blank on every restart. Confirm the surface that reads it agrees.
    const report = getTelemetryReport(twoProviderCfg(), after, now + 3);
    const nimTele = report.providers.find((p) => p.provider === "nim")!;
    expect(nimTele.stabilityScore).not.toBeNull();
  });

  it("restores quota observations the provider stated in headers", () => {
    const now = 1_000_000_000_000;
    const target = identity("nim", "z-ai/glm-5.2");
    const observations: QuotaObservation[] = [{
      axis: "requests",
      period: "minute",
      limit: 60,
      remaining: 0,
      resetsAt: now + 60000,
      observedAt: now,
      basis: "provider-stated",
    }];

    const before = new CircuitBreaker();
    before.recordOutcome(target, {
      ok: true, status: 200, elapsedMs: 1, at: now, quotaObservations: observations,
    });
    saveBreakerState(before.exportState(), { path: statePath });

    const after = new CircuitBreaker();
    expect(installBreakerPersistence(after, { path: statePath }).restored).toBe(1);
    expect(after.getState(target)!.quotaObservations).toEqual(observations);
  });

  it("never overwrites a cooldown this process already learned", () => {
    const now = 1_000_000_000_000;
    const target = identity("nim", "m");
    const breaker = new CircuitBreaker();
    breaker.recordQuotaCooldown(target, now + 10 * HOUR, now);

    // `restoreState` skips a cell this process has already created — WHOLE, field by field —
    // rather than merging: the cell already exists, so the row below is discarded entirely.
    const applied = breaker.restoreState([
      {
        provider: "nim",
        model: "m",
        kind: "openai",
        credentialId: makeCredentialId("nim"),
        cooldownUntil: now + HOUR,
        cooldownSource: "escalation",
        unexplained429s: 3,
      },
    ]);
    expect(applied).toBe(0);
    expect(breaker.getState(target)!.cooldownUntil).toBe(now + 10 * HOUR);
    expect(breaker.getState(target)!.cooldownSource).toBe("quota");
  });

  it("a success retracts the persisted cooldown; the cell's row itself now remains", () => {
    const now = 1_000_000_000_000;
    const target = identity("nim", "m");
    const breaker = new CircuitBreaker();
    const handle = installBreakerPersistence(breaker, { path: statePath });
    escalate(breaker, target, 3, now);
    expect(handle.flush()).toBe(true);
    expect(loadBreakerState({ path: statePath })).toHaveLength(1);

    breaker.recordOutcome(target, { ok: true, elapsedMs: 1, at: now + 1 });
    expect(handle.flush()).toBe(true);

    // `exportState()` returns EVERY cell now, cooling or not — so the row survives (it still
    // carries the pings from the three 429s plus the success), and only the cooldown itself is
    // retracted.
    const rows = loadBreakerState({ path: statePath });
    expect(rows).toHaveLength(1);
    expect(rows[0]!.cooldownUntil).toBe(0);
    expect(rows[0]!.pings).toBeDefined();
    expect(rows[0]!.pings!.length).toBeGreaterThan(0);

    const restored = new CircuitBreaker();
    expect(installBreakerPersistence(restored, { path: statePath }).restored).toBe(1);
    expect(restored.isHealthy(target, now + 1)).toBe(true);
  });

  it("an operator cooldown clear reaches the file, so it does not come back on restart", () => {
    const now = 1_000_000_000_000;
    const target = identity("nim", "m");
    const breaker = new CircuitBreaker();
    const handle = installBreakerPersistence(breaker, { path: statePath });
    escalate(breaker, target, 3, now);
    expect(handle.flush()).toBe(true);
    expect(loadBreakerState({ path: statePath })).toHaveLength(1);

    breaker.clearCooldownState({ provider: "nim" });
    expect(handle.flush()).toBe(true);

    // The row survives (it still carries the pings from the three 429s); only the cooldown is
    // retracted, so a restart does not resurrect it.
    const rows = loadBreakerState({ path: statePath });
    expect(rows).toHaveLength(1);
    expect(rows[0]!.cooldownUntil).toBe(0);
    expect(rows[0]!.pings).toBeDefined();
    expect(rows[0]!.pings!.length).toBeGreaterThan(0);

    const restored = new CircuitBreaker();
    expect(installBreakerPersistence(restored, { path: statePath }).restored).toBe(1);
    expect(restored.isHealthy(target, now)).toBe(true);
  });
});

describe("fresh-cell defaults and ping-history bounds", () => {
  it("loads an old-format row with no new fields and restores fresh-cell defaults", () => {
    const now = 1_000_000_000_000;
    const target = identity("nim", "old-format-model");
    writeFileSync(
      statePath,
      JSON.stringify({
        version: CURRENT_BREAKER_STATE_VERSION,
        rows: [{
          provider: "nim",
          model: "old-format-model",
          kind: "openai",
          credentialId: makeCredentialId("nim"),
          cooldownUntil: now + HOUR,
          cooldownSource: "escalation",
          unexplained429s: 2,
        }],
      }),
      "utf8",
    );

    const after = new CircuitBreaker();
    expect(installBreakerPersistence(after, { path: statePath }).restored).toBe(1);
    const state = after.getState(target)!;
    expect(state.cooldownUntil).toBe(now + HOUR);
    expect(state.consecutiveFailures).toBe(0);
    expect(state.pings).toEqual([]);
    expect(state.credentialFaultUntil).toBe(0);
  });

  it("trims a restored ping history to the newest 10 (MAX_PING_HISTORY in circuit-breaker.ts)", () => {
    const now = 1_000_000_000_000;
    const target = identity("nim", "chatty-model");
    const pings = Array.from({ length: 12 }, (_, i) => ({
      ms: 100 + i,
      code: "200",
      timestamp: now + i,
    }));
    const row: BreakerCellRow = {
      provider: "nim",
      model: "chatty-model",
      kind: "openai",
      credentialId: makeCredentialId("nim"),
      cooldownUntil: 0,
      cooldownSource: null,
      unexplained429s: 0,
      pings,
    };
    saveBreakerState([row], { path: statePath });

    const after = new CircuitBreaker();
    expect(installBreakerPersistence(after, { path: statePath }).restored).toBe(1);
    const restoredPings = after.getState(target)!.pings;
    // MAX_PING_HISTORY is 10 and is not exported from circuit-breaker.ts; the literal here is
    // intentional, not a guess.
    expect(restoredPings).toHaveLength(10);
    expect(restoredPings).toEqual(pings.slice(-10));
  });
});

describe("debounced writes and explicit flush", () => {
  it("debounces writes and lets a caller force one with flush()", () => {
    const now = 1_000_000_000_000;
    const target = identity("nim", "m");
    const breaker = new CircuitBreaker();
    const handle = installBreakerPersistence(breaker, { path: statePath });
    breaker.recordOutcome(target, { ok: false, status: 500, elapsedMs: 5, at: now });

    // Same tick: the write-behind timer has not fired yet.
    expect(loadBreakerState({ path: statePath })).toEqual([]);

    expect(handle.flush()).toBe(true);
    const afterFirstFlush = readFileSync(statePath, "utf8");
    expect(loadBreakerState({ path: statePath })).toHaveLength(1);

    // A clean timer writes nothing, and the bytes on disk are unchanged.
    expect(handle.flush()).toBe(false);
    expect(readFileSync(statePath, "utf8")).toBe(afterFirstFlush);

    // A fresh outcome dirties the timer again; the module-level shutdown flush reaches it too.
    breaker.recordOutcome(target, { ok: false, status: 500, elapsedMs: 5, at: now + 1 });
    expect(flushBreakerPersistence()).toBeGreaterThanOrEqual(1);
  });

  /**
   * The credential axis has its OWN writers (`applyCredentialFault`, `clearCredentialFaults`,
   * `clearCredentialFaultState`), none of which touched the old cooling-only listener. Each must
   * dirty the file now, or a fault would reach disk only when some later outcome happened to
   * notify — the live proof relied on exactly this path for the `AUTH 401` row.
   */
  it("a credential fault and its clearing both reach the file through the change listener", () => {
    const now = 1_000_000_000_000;
    const target = identity("openai", "gpt-4o");
    const breaker = new CircuitBreaker();
    const handle = installBreakerPersistence(breaker, { path: statePath });

    breaker.recordCredentialFault(target, 401, now);
    expect(handle.flush()).toBe(true);
    expect(loadBreakerState({ path: statePath })[0]).toMatchObject({ credentialFailures: 1, lastCredentialStatus: 401 });

    breaker.clearCredentialFaults(makeCredentialId("openai"));
    expect(handle.flush()).toBe(true);
    expect(loadBreakerState({ path: statePath })[0]).toMatchObject({ credentialFailures: 0, credentialFaultUntil: 0 });

    breaker.recordCredentialFault(target, 403, now + 1);
    expect(handle.flush()).toBe(true);
    breaker.clearCredentialFaultState({ provider: "openai" });
    expect(handle.flush()).toBe(true);
    expect(loadBreakerState({ path: statePath })[0]).toMatchObject({ credentialFailures: 0 });
  });
});

describe("the loader restores nothing rather than something wrong", () => {
  /**
   * ⚠ `lane-manifest.ts` shipped a loader that validated the envelope only, so a malformed entry
   * reached logic that read `undefined` off it and EVICTED a healthy lane. A corrupt cooling file
   * must cool nothing, and a test asserting only "does not throw" would pass on that bug — assert
   * the restored count.
   */
  it.each([
    ["not JSON at all", "{{{"],
    ["a bare array", "[]"],
    ["a wrong version", JSON.stringify({ version: 999, rows: [] })],
    ["rows that are not an array", JSON.stringify({ version: CURRENT_BREAKER_STATE_VERSION, rows: {} })],
  ])("restores nothing from %s", (_label, body) => {
    writeFileSync(statePath, body, "utf8");
    const breaker = new CircuitBreaker();
    expect(installBreakerPersistence(breaker, { path: statePath }).restored).toBe(0);
  });

  it("restores nothing when the file is absent", () => {
    const breaker = new CircuitBreaker();
    expect(installBreakerPersistence(breaker, { path: join(dir, "missing.json") }).restored).toBe(0);
    expect(existsSync(join(dir, "missing.json"))).toBe(false);
  });

  it("drops one malformed row without discarding its healthy neighbours", () => {
    const now = 1_000_000_000_000;
    const good: BreakerCellRow = {
      provider: "nim",
      model: "m",
      kind: "openai",
      credentialId: makeCredentialId("nim"),
      cooldownUntil: now + HOUR,
      cooldownSource: "escalation",
      unexplained429s: 2,
    };
    writeFileSync(
      statePath,
      JSON.stringify({
        version: CURRENT_BREAKER_STATE_VERSION,
        rows: [
          good,
          // Each of these fails exactly one field check.
          { ...good, provider: "" },
          { ...good, cooldownUntil: "soon" },
          { ...good, cooldownSource: "vibes" },
          { ...good, unexplained429s: -1 },
          { ...good, unexplained429s: 1.5 },
          { ...good, model: 42 },
          "a bare string",
          null,
        ],
      }),
      "utf8",
    );
    expect(loadBreakerState({ path: statePath })).toEqual([good]);
  });

  it("drops a row whose pings field is not an array, keeping its healthy neighbour", () => {
    const now = 1_000_000_000_000;
    const good: BreakerCellRow = {
      provider: "nim",
      model: "m",
      kind: "openai",
      credentialId: makeCredentialId("nim"),
      cooldownUntil: now + HOUR,
      cooldownSource: "escalation",
      unexplained429s: 2,
    };
    writeFileSync(
      statePath,
      JSON.stringify({
        version: CURRENT_BREAKER_STATE_VERSION,
        rows: [good, { ...good, model: "malformed-pings", pings: "abc" }],
      }),
      "utf8",
    );
    expect(loadBreakerState({ path: statePath })).toEqual([good]);
  });

  it("drops a row whose ping record is missing a timestamp, keeping its healthy neighbour", () => {
    const now = 1_000_000_000_000;
    const good: BreakerCellRow = {
      provider: "nim",
      model: "m",
      kind: "openai",
      credentialId: makeCredentialId("nim"),
      cooldownUntil: now + HOUR,
      cooldownSource: "escalation",
      unexplained429s: 2,
    };
    writeFileSync(
      statePath,
      JSON.stringify({
        version: CURRENT_BREAKER_STATE_VERSION,
        rows: [good, { ...good, model: "malformed-ping-record", pings: [{ ms: 10, code: "200" }] }],
      }),
      "utf8",
    );
    expect(loadBreakerState({ path: statePath })).toEqual([good]);
  });

  it("drops a row whose quota observation names an unrecognized axis, keeping its healthy neighbour", () => {
    const now = 1_000_000_000_000;
    const good: BreakerCellRow = {
      provider: "nim",
      model: "m",
      kind: "openai",
      credentialId: makeCredentialId("nim"),
      cooldownUntil: now + HOUR,
      cooldownSource: "escalation",
      unexplained429s: 2,
    };
    writeFileSync(
      statePath,
      JSON.stringify({
        version: CURRENT_BREAKER_STATE_VERSION,
        rows: [
          good,
          {
            ...good,
            model: "malformed-quota-axis",
            quotaObservations: [{
              axis: "bogus", period: "minute", limit: 60, remaining: 0,
              resetsAt: null, observedAt: 1, basis: "provider-stated",
            }],
          },
        ],
      }),
      "utf8",
    );
    expect(loadBreakerState({ path: statePath })).toEqual([good]);
  });

  it("writes an envelope the loader accepts, atomically, leaving no temp file behind", () => {
    saveBreakerState([], { path: statePath });
    const parsed = JSON.parse(readFileSync(statePath, "utf8"));
    expect(parsed.version).toBe(CURRENT_BREAKER_STATE_VERSION);
    expect(parsed.rows).toEqual([]);
    expect(existsSync(`${statePath}.${process.pid}.tmp`)).toBe(false);
  });
});
