/**
 * Cooling state must survive a relay restart.
 *
 * `circuit-breaker.ts` performed no IO, so every cooldown and the whole unexplained-429 escalation
 * ladder died with the process. Measured on the operator's live relay before this landed:
 * `nim/moonshotai/kimi-k3` held a 19.9-hour cooldown learned from 7 consecutive unexplained 429s,
 * and `gemini/models/gemini-3.6-flash` one learned from 26 — 33 real failed requests whose lesson
 * a restart threw away.
 *
 * ⚠ Every test here uses an explicit temp path. `getBreakerStatePath()` redirects under vitest as
 * well, but a suite that trips breakers must never be one guard away from cooling the developer's
 * own deployments.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, writeFileSync, readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { CircuitBreaker, type BreakerCooldownRow } from "../src/circuit-breaker.js";
import {
  CURRENT_BREAKER_STATE_VERSION,
  loadBreakerCooldowns,
  saveBreakerCooldowns,
  installBreakerPersistence,
} from "../src/breaker-persistence.js";
import { makeCredentialId } from "../src/credential-id.js";
import type { ProviderTargetIdentity } from "../src/kernel/contracts.js";

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

describe("breaker cooling survives a restart", () => {
  it("carries a cooldown and its escalation counter into a fresh breaker", () => {
    const now = 1_000_000_000_000;
    const target = identity("nim", "moonshotai/kimi-k3");

    const before = new CircuitBreaker();
    installBreakerPersistence(before, { path: statePath, now: () => now });
    // Seven consecutive unexplained 429s: the live kimi-k3 case. The ladder tops out at 24h.
    escalate(before, target, 7, now);
    const learned = before.getState(target)!;
    expect(learned.cooldownUntil).toBeGreaterThan(now + 23 * HOUR);
    expect(learned.unexplained429s).toBe(7);
    expect(learned.cooldownSource).toBe("escalation");
    // The write-behind timer is debounced, so force the flush the way a shutdown would.
    saveBreakerCooldowns(before.exportCooldowns(now), { path: statePath });

    // ── restart ──────────────────────────────────────────────────────────────────────────────
    const after = new CircuitBreaker();
    const restored = installBreakerPersistence(after, { path: statePath, now: () => now + HOUR });
    expect(restored).toBe(1);

    const carried = after.getState(target)!;
    expect(carried.cooldownUntil).toBe(learned.cooldownUntil);
    expect(carried.unexplained429s).toBe(7);
    expect(carried.cooldownSource).toBe("escalation");
    expect(after.isHealthy(target, now + HOUR)).toBe(false);
  });

  /**
   * ⚠ Every `CooldownSource` must survive the round trip, and this one is the reason the validator
   * no longer hand-lists them.
   *
   * `isCooldownSource` used to re-state all five members literally, so adding `elapsed`
   * (2026-08-30) type-checked clean while every persisted row carrying it failed validation and was
   * dropped at load — silently, because one bad row is discarded alone by design. A restart would
   * then have forgotten exactly the long cooldowns this source exists to record. The validator now
   * derives its set from `COOLDOWN_SOURCES`, and this test fails if anyone re-hardcodes it.
   */
  it("carries every cooldown source across a restart, the newest one included", () => {
    const now = 1_000_000_000_000;
    const target = identity("nim", "deepseek-ai/deepseek-v4-flash-0731");

    const before = new CircuitBreaker();
    // Two 120-second timeouts: the live hang. The second trips, and it cools for what it wasted.
    before.recordOutcome(target, { ok: false, status: 504, elapsedMs: 120_007, at: now });
    before.recordOutcome(target, { ok: false, status: 504, elapsedMs: 120_007, at: now });
    expect(before.getState(target)!.cooldownSource).toBe("elapsed");
    saveBreakerCooldowns(before.exportCooldowns(now), { path: statePath });

    const after = new CircuitBreaker();
    expect(installBreakerPersistence(after, { path: statePath, now: () => now + 1_000 })).toBe(1);
    const carried = after.getState(target)!;
    expect(carried.cooldownSource).toBe("elapsed");
    expect(carried.cooldownUntil).toBe(now + 120_007);
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
    saveBreakerCooldowns(before.exportCooldowns(now), { path: statePath });

    const after = new CircuitBreaker();
    installBreakerPersistence(after, { path: statePath, now: () => now + HOUR });
    // The cooldown has lifted by this point; the counter has not been re-measured, only carried.
    const lifted = after.getState(target)!.cooldownUntil + 1;
    after.recordOutcome(target, { ok: false, status: 429, elapsedMs: 1, at: lifted });
    // 5th unexplained 429 -> still the top rung (24h), not the 2m first rung.
    expect(after.getState(target)!.cooldownUntil - lifted).toBe(86_400_000);
    expect(after.getState(target)!.unexplained429s).toBe(5);
  });

  it("does not restore a cooldown that lapsed while the relay was down", () => {
    const now = 1_000_000_000_000;
    const target = identity("groq", "qwen/qwen3.6-27b");
    saveBreakerCooldowns(
      [
        {
          provider: "groq",
          model: "qwen/qwen3.6-27b",
          kind: "openai",
          credentialId: makeCredentialId("groq"),
          cooldownUntil: now + 1000,
          cooldownSource: "escalation",
          unexplained429s: 9,
        },
      ],
      { path: statePath },
    );

    const after = new CircuitBreaker();
    // Two hours later the cooldown is long gone, so neither it NOR its counter comes back — a
    // resurrected `unexplained429s: 9` would send the next single 429 straight to 24 hours.
    const restored = installBreakerPersistence(after, { path: statePath, now: () => now + 2 * HOUR });
    expect(restored).toBe(0);
    expect(after.getState(target)).toBeUndefined();
    expect(after.isHealthy(target, now + 2 * HOUR)).toBe(true);
  });

  it("never overwrites a cooldown this process already learned", () => {
    const now = 1_000_000_000_000;
    const target = identity("nim", "m");
    const breaker = new CircuitBreaker();
    breaker.recordQuotaCooldown(target, now + 10 * HOUR, now);

    const applied = breaker.restoreCooldowns(
      [
        {
          provider: "nim",
          model: "m",
          kind: "openai",
          credentialId: makeCredentialId("nim"),
          cooldownUntil: now + HOUR,
          cooldownSource: "escalation",
          unexplained429s: 3,
        },
      ],
      now,
    );
    expect(applied).toBe(0);
    expect(breaker.getState(target)!.cooldownUntil).toBe(now + 10 * HOUR);
    expect(breaker.getState(target)!.cooldownSource).toBe("quota");
  });

  it("a success retracts the persisted cooldown as well as the live one", () => {
    const now = 1_000_000_000_000;
    const target = identity("nim", "m");
    const breaker = new CircuitBreaker();
    installBreakerPersistence(breaker, { path: statePath, now: () => now });
    escalate(breaker, target, 3, now);
    saveBreakerCooldowns(breaker.exportCooldowns(now), { path: statePath });
    expect(loadBreakerCooldowns({ path: statePath, now })).toHaveLength(1);

    breaker.recordOutcome(target, { ok: true, elapsedMs: 1, at: now + 1 });
    saveBreakerCooldowns(breaker.exportCooldowns(now + 1), { path: statePath });
    expect(loadBreakerCooldowns({ path: statePath, now: now + 1 })).toHaveLength(0);
  });

  it("an operator cooldown clear reaches the file, so it does not come back on restart", () => {
    const now = 1_000_000_000_000;
    const target = identity("nim", "m");
    const breaker = new CircuitBreaker();
    escalate(breaker, target, 3, now);
    saveBreakerCooldowns(breaker.exportCooldowns(now), { path: statePath });
    expect(loadBreakerCooldowns({ path: statePath, now })).toHaveLength(1);

    breaker.clearCooldownState({ provider: "nim" });
    saveBreakerCooldowns(breaker.exportCooldowns(now), { path: statePath });
    expect(loadBreakerCooldowns({ path: statePath, now })).toHaveLength(0);
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
    expect(installBreakerPersistence(breaker, { path: statePath, now: () => 1 })).toBe(0);
  });

  it("restores nothing when the file is absent", () => {
    const breaker = new CircuitBreaker();
    expect(installBreakerPersistence(breaker, { path: join(dir, "missing.json"), now: () => 1 })).toBe(0);
    expect(existsSync(join(dir, "missing.json"))).toBe(false);
  });

  it("drops one malformed row without discarding its healthy neighbours", () => {
    const now = 1_000_000_000_000;
    const good: BreakerCooldownRow = {
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
    expect(loadBreakerCooldowns({ path: statePath, now })).toEqual([good]);
  });

  it("writes an envelope the loader accepts, atomically, leaving no temp file behind", () => {
    saveBreakerCooldowns([], { path: statePath });
    const parsed = JSON.parse(readFileSync(statePath, "utf8"));
    expect(parsed.version).toBe(CURRENT_BREAKER_STATE_VERSION);
    expect(parsed.rows).toEqual([]);
    expect(existsSync(`${statePath}.${process.pid}.tmp`)).toBe(false);
  });
});
