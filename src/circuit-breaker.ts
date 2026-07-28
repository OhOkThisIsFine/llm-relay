import type { ResolvedTarget } from "./config.js";
import { getStabilityScore, type PingRecord } from "./ping/metrics.js";

export interface CircuitState {
  consecutiveFailures: number;
  lastFailureTime: number;
  cooldownUntil: number;
  lastStatus?: number | undefined;
  pings: PingRecord[];
  quotaPercent?: number | null | undefined;
}

const DEFAULT_COOLDOWN_MS = 60000; // 1 minute cooldown after consecutive failures
const RATE_LIMIT_COOLDOWN_MS = 120000; // 2 minutes cooldown on 429
const MAX_FAILURES_BEFORE_TRIP = 2;
const MAX_PING_HISTORY = 10;

export class CircuitBreaker {
  private states = new Map<string, CircuitState>();

  private getKey(target: ResolvedTarget | string): string {
    if (typeof target === "string") return target;
    return target.model ? `${target.provider}/${target.model}` : target.provider;
  }

  private getOrCreate(key: string, now = Date.now()): CircuitState {
    const existing = this.states.get(key);
    if (existing) return existing;
    const fresh: CircuitState = {
      consecutiveFailures: 0,
      lastFailureTime: 0,
      cooldownUntil: 0,
      pings: [],
    };
    this.states.set(key, fresh);
    return fresh;
  }

  /** Check if a target spec or ResolvedTarget is healthy to receive traffic. */
  isHealthy(target: ResolvedTarget | string, now = Date.now()): boolean {
    const key = this.getKey(target);
    const state = this.states.get(key);
    if (!state) return true;

    if (state.cooldownUntil > now) {
      return false; // Circuit open (cooling down)
    }

    return true; // Healthy or cooldown expired
  }

  /** Record a successful completion for a target, resetting its circuit. */
  recordSuccess(target: ResolvedTarget | string, ms = 500, quotaPercent?: number | null, now = Date.now()): void {
    const key = this.getKey(target);
    const state = this.getOrCreate(key, now);
    state.consecutiveFailures = 0;
    state.cooldownUntil = 0;
    state.lastStatus = 200;
    if (quotaPercent !== undefined) state.quotaPercent = quotaPercent;
    state.pings.push({ ms, code: "200", timestamp: now });
    if (state.pings.length > MAX_PING_HISTORY) state.pings.shift();
  }

  /** Record a failure (e.g. 429 rate limit, 5xx error, timeout) for a target. */
  recordFailure(target: ResolvedTarget | string, status?: number, now = Date.now(), ms = 1000): void {
    const key = this.getKey(target);
    const state = this.getOrCreate(key, now);

    state.consecutiveFailures += 1;
    state.lastFailureTime = now;
    state.lastStatus = status;
    const statusCode = status ? String(status) : "500";
    state.pings.push({ ms, code: statusCode, timestamp: now });
    if (state.pings.length > MAX_PING_HISTORY) state.pings.shift();

    // HTTP 429 (Rate Limit) trips immediately for 2 minutes
    if (status === 429) {
      state.cooldownUntil = now + RATE_LIMIT_COOLDOWN_MS;
    } else if (state.consecutiveFailures >= MAX_FAILURES_BEFORE_TRIP) {
      state.cooldownUntil = now + DEFAULT_COOLDOWN_MS;
    }
  }

  /** Get computed stability score (0–100) for a target (returns 100 if untracked). */
  getStabilityScore(target: ResolvedTarget | string): number {
    const key = this.getKey(target);
    const state = this.states.get(key);
    if (!state || state.pings.length === 0) return 100;
    const score = getStabilityScore(state.pings);
    return score >= 0 ? score : 100;
  }

  /** Get full state for a target. */
  getState(target: ResolvedTarget | string): CircuitState | undefined {
    return this.states.get(this.getKey(target));
  }

  /** Get all tracked circuit states. */
  getAllStates(): Map<string, CircuitState> {
    return this.states;
  }

  /** Filter an array of targets to healthy candidates, sorted by Stability Score (highest first). */
  getHealthyTargets(targets: ResolvedTarget[], now = Date.now()): ResolvedTarget[] {
    const healthy = targets.filter((t) => this.isHealthy(t, now));
    const candidates = healthy.length > 0 ? healthy : targets;
    return [...candidates].sort((a, b) => this.getStabilityScore(b) - this.getStabilityScore(a));
  }

  /** Reset all circuit states. */
  reset(): void {
    this.states.clear();
  }
}

export const globalCircuitBreaker = new CircuitBreaker();
