import type { ResolvedTarget } from "./config.js";

export interface CircuitState {
  consecutiveFailures: number;
  lastFailureTime: number;
  cooldownUntil: number;
  lastStatus?: number | undefined;
}

const DEFAULT_COOLDOWN_MS = 60000; // 1 minute cooldown after consecutive failures
const RATE_LIMIT_COOLDOWN_MS = 120000; // 2 minutes cooldown on 429
const MAX_FAILURES_BEFORE_TRIP = 2;

export class CircuitBreaker {
  private states = new Map<string, CircuitState>();

  private getKey(target: ResolvedTarget | string): string {
    if (typeof target === "string") return target;
    return target.model ? `${target.provider}/${target.model}` : target.provider;
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
  recordSuccess(target: ResolvedTarget | string): void {
    const key = this.getKey(target);
    this.states.delete(key);
  }

  /** Record a failure (e.g. 429 rate limit, 5xx error, timeout) for a target. */
  recordFailure(target: ResolvedTarget | string, status?: number, now = Date.now()): void {
    const key = this.getKey(target);
    const existing = this.states.get(key) ?? {
      consecutiveFailures: 0,
      lastFailureTime: now,
      cooldownUntil: 0,
    };

    existing.consecutiveFailures += 1;
    existing.lastFailureTime = now;
    existing.lastStatus = status;

    // HTTP 429 (Rate Limit) trips immediately for 2 minutes
    if (status === 429) {
      existing.cooldownUntil = now + RATE_LIMIT_COOLDOWN_MS;
    } else if (existing.consecutiveFailures >= MAX_FAILURES_BEFORE_TRIP) {
      existing.cooldownUntil = now + DEFAULT_COOLDOWN_MS;
    }

    this.states.set(key, existing);
  }

  /** Filter an array of targets to only healthy candidates. Fall back to all if all are open. */
  getHealthyTargets(targets: ResolvedTarget[], now = Date.now()): ResolvedTarget[] {
    const healthy = targets.filter((t) => this.isHealthy(t, now));
    return healthy.length > 0 ? healthy : targets; // Fallback to all if all in cooldown
  }

  /** Reset all circuit states. */
  reset(): void {
    this.states.clear();
  }
}

export const globalCircuitBreaker = new CircuitBreaker();
