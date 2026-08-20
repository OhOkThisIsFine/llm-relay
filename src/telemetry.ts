import type { Config, ProviderTierType } from "./config.js";
import type { CircuitBreaker, CircuitState } from "./circuit-breaker.js";
import { aggregateHasKey } from "./credential-fleet.js";
import { ALL_PROVIDER_PRESETS } from "./presets.js";
import type { ProviderTargetIdentity } from "./kernel/contracts.js";
import { getStabilityScore } from "./ping/metrics.js";

export interface ProviderTelemetry {
  provider: string;
  displayName: string;
  kind: string;
  tierType: ProviderTierType;
  signupUrl?: string | undefined;
  hasKey: boolean;
  isHealthy: boolean | null;
  stabilityScore: number | null;
  /** Unique provider/model deployments; credential cells are intentionally deduplicated. */
  observedTargets: number;
  lastStatus?: number | undefined;
  cooldownRemainingMs: number;
}

export interface TelemetryReport {
  timestamp: string;
  activeProvidersCount: number;
  healthyProvidersCount: number;
  unmeasuredProvidersCount: number;
  freeProvidersCount: number;
  mixedProvidersCount: number;
  subscriptionProvidersCount: number;
  providers: ProviderTelemetry[];
  routingTiers: Record<string, string | string[]>;
}

type StoredCircuitState = CircuitState & { readonly target: ProviderTargetIdentity };

interface DeploymentAggregate {
  readonly provider: string;
  readonly model: string | null;
  readonly states: CircuitState[];
  readonly samples: CircuitState["pings"];
  readonly stability: number | null;
  readonly confidenceSamples: number;
}

/**
 * Group cells by their stored target identity. Credential labels never enter this deployment
 * key, and no serialized breaker key is reverse-parsed. Samples are sorted because each cell's
 * bounded FIFO is independently ordered.
 */
function deploymentAggregates(cb: CircuitBreaker): DeploymentAggregate[] {
  const groups = new Map<string, { provider: string; model: string | null; states: CircuitState[] }>();
  for (const state of cb.getAllStates().values() as Iterable<StoredCircuitState>) {
    const target = state.target;
    const model = target.model ?? null;
    const key = `${target.provider}\u0000${model ?? ""}`;
    let group = groups.get(key);
    if (!group) {
      group = { provider: target.provider, model, states: [] };
      groups.set(key, group);
    }
    group.states.push(state);
  }
  return [...groups.values()].map((group) => {
    const samples = group.states
      .flatMap((state) => state.pings)
      .sort((a, b) => a.timestamp - b.timestamp);
    return {
      ...group,
      samples,
      stability: samples.length > 0 ? Math.max(0, getStabilityScore(samples)) : null,
      confidenceSamples: group.states.length > 0
        ? Math.min(...group.states.map((state) => state.pings.length))
        : 0,
    };
  });
}

function lastSeen(state: CircuitState): number {
  const last = state.pings[state.pings.length - 1];
  return last ? last.timestamp : 0;
}

/** Aggregate live telemetry and health status across all configured providers. */
export function getTelemetryReport(cfg: Config, cb: CircuitBreaker, now = Date.now()): TelemetryReport {
  const providers: ProviderTelemetry[] = [];
  const deployments = deploymentAggregates(cb);

  for (const [name, p] of Object.entries(cfg.providers)) {
    const hasKey = aggregateHasKey(name, p);
    const preset = ALL_PROVIDER_PRESETS[name];
    const providerDeployments = deployments.filter((deployment) => deployment.provider === name);
    const observedDeployments = providerDeployments.filter((deployment) => deployment.samples.length > 0);
    const observedTargets = observedDeployments.length;
    const measured = observedDeployments
      .map((deployment) => deployment.stability)
      .filter((score): score is number => score !== null);
    const stabilityScore = measured.length > 0 ? Math.max(...measured) : null;

    // A deployment is available when any credential cell for it is available. A provider is
    // unknown until at least one cell has actual observations.
    const isHealthy = !hasKey
      ? false
      : observedDeployments.length === 0
        ? null
        : observedDeployments.some((deployment) =>
            deployment.states.some((state) => cb.isHealthy(state.target, now)),
          );

    const states = providerDeployments
      .flatMap((deployment) => deployment.states)
      .sort((a, b) => lastSeen(b) - lastSeen(a));
    const cooldownRemainingMs = states.length === 0
      ? 0
      : Math.min(...states.map((state) => (state.cooldownUntil > now ? state.cooldownUntil - now : 0)));
    const statusState = states.find((state) => state.lastStatus !== undefined);

    providers.push({
      provider: name,
      displayName: preset?.displayName ?? name.toUpperCase(),
      kind: p.kind,
      tierType: p.tierType ?? preset?.tierType ?? "free",
      signupUrl: p.signupUrl ?? preset?.signupUrl,
      hasKey,
      isHealthy,
      stabilityScore,
      observedTargets,
      lastStatus: statusState?.lastStatus,
      cooldownRemainingMs,
    });
  }

  const activeProvidersCount = providers.filter((provider) => provider.hasKey).length;
  const healthyProvidersCount = providers.filter((provider) => provider.isHealthy === true).length;
  const unmeasuredProvidersCount = providers.filter((provider) => provider.isHealthy === null).length;
  const freeProvidersCount = providers.filter((provider) => provider.tierType === "free" && provider.hasKey).length;
  const mixedProvidersCount = providers.filter((provider) => provider.tierType === "mixed" && provider.hasKey).length;
  const subscriptionProvidersCount = providers.filter((provider) => provider.tierType === "subscription" && provider.hasKey).length;

  return {
    timestamp: new Date(now).toISOString(),
    activeProvidersCount,
    healthyProvidersCount,
    unmeasuredProvidersCount,
    freeProvidersCount,
    mixedProvidersCount,
    subscriptionProvidersCount,
    providers,
    routingTiers: cfg.routing.tiers,
  };
}
