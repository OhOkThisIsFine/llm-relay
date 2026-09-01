import type { CredentialResolution } from "./authEnv.js";
import { resolveCredential, resolveCredentialExact } from "./authEnv.js";
import { makeCredentialId, type CredentialId } from "./credential-id.js";
import type {
  ProviderConfig,
  ResolvedTarget,
  CredentialSlot,
  ProviderCredentialConfig,
} from "./config-types.js";
import type { KeystoreOptions } from "./keystore.js";

export type { CredentialSlot, ProviderCredentialConfig };

export interface ResolvedCredentialSlot {
  readonly slot: CredentialSlot;
  readonly resolution: CredentialResolution;
}

/** Application-layer attempt with credential resolution performed exactly once. */
export interface ResolvedAttempt {
  readonly target: ResolvedTarget;
  readonly credentialId: CredentialId;
  readonly credential: CredentialResolution;
  /** Non-secret slot descriptor; the secret itself remains only in `credential.value`. */
  readonly slot: CredentialSlot;
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

const slotModelSets = new WeakMap<CredentialSlot, ReadonlySet<string>>();

export function slotAllowsModel(slot: CredentialSlot, model: string | undefined): boolean {
  if (slot.models === null) return true;
  if (model === undefined) return false;
  let set = slotModelSets.get(slot);
  if (!set) {
    set = new Set(slot.models);
    slotModelSets.set(slot, set);
  }
  return set.has(model);
}

export function resolveCredentialSlot(
  slot: CredentialSlot,
  env: NodeJS.ProcessEnv = process.env,
  keystoreOptions?: KeystoreOptions,
): CredentialResolution {
  return slot.resolutionMode === "declared-only"
    ? resolveCredentialExact(slot.authEnv, env, keystoreOptions)
    : resolveCredential(slot.authEnv, env, slot.provider, keystoreOptions);
}

export function snapshotProviderCredentials(
  provider: string,
  config: ProviderConfig,
  env: NodeJS.ProcessEnv = process.env,
  keystoreOptions?: KeystoreOptions,
): readonly ResolvedCredentialSlot[] {
  return Object.freeze(providerCredentialSlots(provider, config).map((slot) => Object.freeze({
    slot,
    resolution: resolveCredentialSlot(slot, env, keystoreOptions),
  })));
}

/** True when an enabled slot can make an egress attempt (or is an intentional passthrough). */
export function aggregateHasKey(
  provider: string,
  config: ProviderConfig,
  env: NodeJS.ProcessEnv = process.env,
  keystoreOptions?: KeystoreOptions,
): boolean {
  return snapshotProviderCredentials(provider, config, env, keystoreOptions).some(({ slot, resolution }) =>
    slot.enabled && (slot.models === null || slot.models.length > 0) && resolution.state !== "declared-missing",
  );
}

/** Resolve one slot into an attempt, refusing disabled, model-scoped-out, and missing slots. */
export function resolveAttemptForSlot(
  target: ResolvedTarget,
  slot: CredentialSlot,
  env: NodeJS.ProcessEnv = process.env,
  keystoreOptions?: KeystoreOptions,
): ResolvedAttempt | undefined {
  if (slot.provider !== target.provider || !slot.enabled || !slotAllowsModel(slot, target.model)) return undefined;
  const credential = resolveCredentialSlot(slot, env, keystoreOptions);
  if (credential.state === "declared-missing") return undefined;
  return Object.freeze({ target, credentialId: slot.credentialId, credential, slot });
}
