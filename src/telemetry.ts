import type { Config } from "./config.js";
import type { CircuitBreaker } from "./circuit-breaker.js";
import { ALL_PROVIDER_PRESETS } from "./presets.js";

export interface ProviderTelemetry {
  provider: string;
  displayName: string;
  kind: string;
  tierType: "free" | "subscription";
  signupUrl?: string | undefined;
  hasKey: boolean;
  isHealthy: boolean;
  stabilityScore: number;
  quotaPercent: number | null;
  lastStatus?: number | undefined;
  cooldownRemainingMs: number;
}

export interface TelemetryReport {
  timestamp: string;
  activeProvidersCount: number;
  healthyProvidersCount: number;
  freeProvidersCount: number;
  subscriptionProvidersCount: number;
  providers: ProviderTelemetry[];
  routingTiers: Record<string, string | string[]>;
}

/** Aggregate live telemetry and health status across all configured providers. */
export function getTelemetryReport(cfg: Config, cb: CircuitBreaker, now = Date.now()): TelemetryReport {
  const providers: ProviderTelemetry[] = [];

  for (const [name, p] of Object.entries(cfg.providers)) {
    const envVar = p.authEnv;
    const hasKey = envVar ? Boolean(process.env[envVar]) : true;
    const state = cb.getState(name);
    const healthy = cb.isHealthy(name, now);
    const stabilityScore = cb.getStabilityScore(name);
    const preset = ALL_PROVIDER_PRESETS[name];

    const cooldownRemainingMs = state?.cooldownUntil && state.cooldownUntil > now
      ? state.cooldownUntil - now
      : 0;

    providers.push({
      provider: name,
      displayName: preset?.displayName ?? name.toUpperCase(),
      kind: p.kind,
      tierType: p.tierType ?? preset?.tierType ?? "free",
      signupUrl: p.signupUrl ?? preset?.signupUrl,
      hasKey,
      isHealthy: healthy && hasKey,
      stabilityScore,
      quotaPercent: state?.quotaPercent ?? null,
      lastStatus: state?.lastStatus,
      cooldownRemainingMs,
    });
  }

  const activeProvidersCount = providers.filter((p) => p.hasKey).length;
  const healthyProvidersCount = providers.filter((p) => p.isHealthy).length;
  const freeProvidersCount = providers.filter((p) => p.tierType === "free" && p.hasKey).length;
  const subscriptionProvidersCount = providers.filter((p) => p.tierType === "subscription" && p.hasKey).length;

  return {
    timestamp: new Date(now).toISOString(),
    activeProvidersCount,
    healthyProvidersCount,
    freeProvidersCount,
    subscriptionProvidersCount,
    providers,
    routingTiers: cfg.routing.tiers,
  };
}
