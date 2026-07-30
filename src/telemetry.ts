import type { Config } from "./config.js";
import type { CircuitBreaker, CircuitState } from "./circuit-breaker.js";
import { ALL_PROVIDER_PRESETS } from "./presets.js";

export interface ProviderTelemetry {
  provider: string;
  displayName: string;
  kind: string;
  tierType: "free" | "subscription";
  signupUrl?: string | undefined;
  hasKey: boolean;
  /**
   * `true` — at least one OBSERVED deployment of this provider can take traffic now.
   * `false` — every observed deployment is cooling down, or there is no credential.
   * `null` — nothing has been observed, so health is genuinely UNKNOWN.
   *
   * ⚠ `null` must never be rendered as healthy. This field used to be a bare
   * boolean fed by `CircuitBreaker.isHealthy(<bare provider name>)`, which missed
   * every state (the breaker keys by `provider/model`) and returned `true` on a
   * miss — so every provider read healthy no matter what (OBS-dc5f56e7).
   */
  isHealthy: boolean | null;
  /**
   * Best MEASURED stability (0-100) across this provider's observed deployments,
   * or `null` when nothing has been measured. Never a default: an unmeasured
   * provider reports unknown, the same way an unpublished limit or price stays
   * `null` rather than becoming a confident-looking guess.
   *
   * The BEST rather than the mean, because routing sends a request to the
   * best-ranked live deployment (`CircuitBreaker.getHealthyTargets`), so the best
   * is what a caller of this provider would actually experience. One dead SKU in a
   * roster is not evidence against the provider.
   */
  stabilityScore: number | null;
  /** How many `provider/model` deployments the breaker holds observations for. */
  observedTargets: number;
  quotaPercent: number | null;
  lastStatus?: number | undefined;
  cooldownRemainingMs: number;
}

export interface TelemetryReport {
  timestamp: string;
  activeProvidersCount: number;
  /** Providers OBSERVED available. Excludes unknown — see `unmeasuredProvidersCount`. */
  healthyProvidersCount: number;
  /** Providers with a credential but no observations at all: health unknown, not unhealthy. */
  unmeasuredProvidersCount: number;
  freeProvidersCount: number;
  subscriptionProvidersCount: number;
  providers: ProviderTelemetry[];
  routingTiers: Record<string, string | string[]>;
}

/**
 * Every breaker key belonging to one provider.
 *
 * `CircuitBreaker.getKey()` writes `${provider}/${model}` (and the bare provider
 * name only for a model-less target), so a provider row has to AGGREGATE its
 * deployments — querying the breaker by bare provider name simply misses, which
 * is the whole of OBS-dc5f56e7. Matching on the `provider/` prefix rather than
 * `startsWith(provider)` is deliberate: a model id contains slashes of its own
 * (`nim/z-ai/glm-5.2`), and a loose prefix would let `openai/gpt-4o` count as a
 * provider named `open`.
 */
function breakerKeysFor(cb: CircuitBreaker, provider: string): string[] {
  const prefix = `${provider}/`;
  const keys: string[] = [];
  for (const key of cb.getAllStates().keys()) {
    if (key === provider || key.startsWith(prefix)) keys.push(key);
  }
  return keys;
}

/** When this deployment was last observed (0 = never). */
function lastSeen(state: CircuitState): number {
  const last = state.pings[state.pings.length - 1];
  return last ? last.timestamp : 0;
}

/** Aggregate live telemetry and health status across all configured providers. */
export function getTelemetryReport(cfg: Config, cb: CircuitBreaker, now = Date.now()): TelemetryReport {
  const providers: ProviderTelemetry[] = [];

  for (const [name, p] of Object.entries(cfg.providers)) {
    const envVar = p.authEnv;
    const hasKey = envVar ? Boolean(process.env[envVar]) : true;
    const preset = ALL_PROVIDER_PRESETS[name];

    const keys = breakerKeysFor(cb, name);
    const observedTargets = keys.filter((k) => cb.hasObservations(k)).length;
    const measured = keys
      .map((k) => cb.getMeasuredStability(k))
      .filter((s): s is number => s !== null);
    const stabilityScore = measured.length > 0 ? Math.max(...measured) : null;

    // No credential ⇒ it cannot serve, and that is knowledge, not a guess.
    // No observations ⇒ unknown. Otherwise: can any observed deployment take traffic?
    const isHealthy = !hasKey
      ? false
      : observedTargets === 0
        ? null
        : keys.some((k) => cb.isHealthy(k, now));

    // Newest observation first: quota and last status are point-in-time facts, so
    // the most recently observed deployment is the one worth reporting.
    const states = keys
      .map((k) => cb.getState(k))
      .filter((s): s is CircuitState => s !== undefined)
      .sort((a, b) => lastSeen(b) - lastSeen(a));

    // Time until this provider next has an available deployment: 0 as soon as any
    // one of them is not cooling down, because routing would pick that one.
    const cooldownRemainingMs = states.length === 0
      ? 0
      : Math.min(...states.map((s) => (s.cooldownUntil > now ? s.cooldownUntil - now : 0)));

    const quotaState = states.find((s) => s.quotaPercent !== undefined);
    const statusState = states.find((s) => s.lastStatus !== undefined);

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
      quotaPercent: quotaState?.quotaPercent ?? null,
      lastStatus: statusState?.lastStatus,
      cooldownRemainingMs,
    });
  }

  const activeProvidersCount = providers.filter((p) => p.hasKey).length;
  const healthyProvidersCount = providers.filter((p) => p.isHealthy === true).length;
  const unmeasuredProvidersCount = providers.filter((p) => p.isHealthy === null).length;
  const freeProvidersCount = providers.filter((p) => p.tierType === "free" && p.hasKey).length;
  const subscriptionProvidersCount = providers.filter((p) => p.tierType === "subscription" && p.hasKey).length;

  return {
    timestamp: new Date(now).toISOString(),
    activeProvidersCount,
    healthyProvidersCount,
    unmeasuredProvidersCount,
    freeProvidersCount,
    subscriptionProvidersCount,
    providers,
    routingTiers: cfg.routing.tiers,
  };
}
