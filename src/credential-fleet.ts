import type { CredentialResolution } from "./authEnv.js";
import { resolveCredential, resolveCredentialExact } from "./authEnv.js";
import { makeCredentialId, type CredentialId } from "./credential-id.js";
import type { ProviderLimitsConfig } from "./configured-limits.js";
import type { ProviderConfig, ResolvedTarget } from "./config.js";
import type { ResolvedAttempt } from "./resolved-attempt.js";

/** A normalized provider credential declaration. Secrets are never held here. */
export interface ProviderCredentialConfig {
  label: string;
  authEnv: string;
  enabled?: boolean;
  /** `null` means all models; an empty array deliberately matches no models. */
  models?: readonly string[] | null;
  /**
   * This slot's own operator-asserted rate limits, overriding the provider-level `limits` for
   * this key alone (each axis independently; see `resolveConfiguredLimits`). Keys of one account
   * share that account's ceilings, so per-key figures can differ even under one provider.
   */
  limits?: ProviderLimitsConfig;
}

/** Non-secret identity and policy for one configured credential slot. */
export interface CredentialSlot {
  readonly credentialId: CredentialId;
  readonly provider: string;
  readonly label: string;
  readonly authEnv: string | undefined;
  readonly enabled: boolean;
  readonly models: readonly string[] | null;
  readonly origin: "implicit" | "legacy-authEnv" | "credentials";
  readonly resolutionMode: "legacy-alias" | "declared-only";
  readonly configIndex: number;
}

export interface ResolvedCredentialSlot {
  readonly slot: CredentialSlot;
  readonly resolution: CredentialResolution;
}

/** The implicit one-slot view retained for old providers and hand-built targets. */
export function implicitCredentialSlot(provider: string, authEnv?: string): CredentialSlot {
  return Object.freeze({
    credentialId: makeCredentialId(provider),
    provider,
    label: "default",
    authEnv,
    enabled: true,
    models: null,
    origin: authEnv ? "legacy-authEnv" : "implicit",
    resolutionMode: "legacy-alias",
    configIndex: 0,
  });
}

/** Sentinel used only by legacy callers that still require an attempt object for an empty fleet. */
export function emptyCredentialSlot(provider: string): CredentialSlot {
  return Object.freeze({
    credentialId: makeCredentialId(provider),
    provider,
    label: "default",
    authEnv: undefined,
    enabled: false,
    models: Object.freeze([] as string[]),
    origin: "credentials" as const,
    resolutionMode: "declared-only" as const,
    configIndex: -1,
  });
}

/** Normalize a provider's already-validated configuration into stable slot descriptors. */
export function providerCredentialSlots(provider: string, config: ProviderConfig): readonly CredentialSlot[] {
  if (config.credentials !== undefined) {
    const slots = config.credentials.map((entry, configIndex) => Object.freeze({
      credentialId: makeCredentialId(provider, entry.label),
      provider,
      label: entry.label,
      authEnv: entry.authEnv,
      enabled: entry.enabled !== false,
      models: entry.models === undefined || entry.models === null ? null : Object.freeze([...entry.models]),
      origin: "credentials" as const,
      resolutionMode: "declared-only" as const,
      configIndex,
    }));
    return Object.freeze(slots);
  }
  return Object.freeze([implicitCredentialSlot(provider, config.authEnv)]);
}

export function slotAllowsModel(slot: CredentialSlot, model: string | undefined): boolean {
  if (slot.models === null) return true;
  return model !== undefined && slot.models.includes(model);
}

export function resolveCredentialSlot(
  slot: CredentialSlot,
  env: NodeJS.ProcessEnv = process.env,
): CredentialResolution {
  return slot.resolutionMode === "declared-only"
    ? resolveCredentialExact(slot.authEnv, env)
    : resolveCredential(slot.authEnv, env, slot.provider);
}

export function snapshotProviderCredentials(
  provider: string,
  config: ProviderConfig,
  env: NodeJS.ProcessEnv = process.env,
): readonly ResolvedCredentialSlot[] {
  return Object.freeze(providerCredentialSlots(provider, config).map((slot) => Object.freeze({
    slot,
    resolution: resolveCredentialSlot(slot, env),
  })));
}

/** True when an enabled slot can make an egress attempt (or is an intentional passthrough). */
export function aggregateHasKey(
  provider: string,
  config: ProviderConfig,
  env: NodeJS.ProcessEnv = process.env,
): boolean {
  return snapshotProviderCredentials(provider, config, env).some(({ slot, resolution }) =>
    slot.enabled && (slot.models === null || slot.models.length > 0) && resolution.state !== "declared-missing",
  );
}

/** Resolve one slot into an attempt, refusing disabled, model-scoped-out, and missing slots. */
export function resolveAttemptForSlot(
  target: ResolvedTarget,
  slot: CredentialSlot,
  env: NodeJS.ProcessEnv = process.env,
): ResolvedAttempt | undefined {
  if (slot.provider !== target.provider || !slot.enabled || !slotAllowsModel(slot, target.model)) return undefined;
  const credential = resolveCredentialSlot(slot, env);
  if (credential.state === "declared-missing") return undefined;
  return Object.freeze({ target, credentialId: slot.credentialId, credential, slot });
}
