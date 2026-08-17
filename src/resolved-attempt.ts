import type { CredentialId } from "./credential-id.js";
import type { CredentialResolution } from "./authEnv.js";
import type { ResolvedTarget } from "./config.js";
import type { CredentialSlot } from "./credential-fleet.js";
import { emptyCredentialSlot, implicitCredentialSlot, resolveAttemptForSlot } from "./credential-fleet.js";

/** Application-layer attempt with credential resolution performed exactly once. */
export interface ResolvedAttempt {
  readonly target: ResolvedTarget;
  readonly credentialId: CredentialId;
  readonly credential: CredentialResolution;
  /** Non-secret slot descriptor; the secret itself remains only in `credential.value`. */
  readonly slot: CredentialSlot;
}

/** Resolve the current single-slot target into the application attempt shape. */
export function resolveAttempt(
  target: ResolvedTarget,
  env: NodeJS.ProcessEnv = process.env,
): ResolvedAttempt {
  const emptyFleet = target.credentialSlots !== undefined && target.credentialSlots.length === 0;
  const slot = emptyFleet
    ? emptyCredentialSlot(target.provider)
    : target.credentialSlots?.[0] ?? implicitCredentialSlot(target.provider, target.authEnv);
  const attempt = resolveAttemptForSlot(target, slot, env);
  // The legacy resolver intentionally still returns a missing attempt so existing callers can
  // produce their established credential-config error before any backend egress.
  if (!attempt) {
    const credential = {
      state: "declared-missing" as const,
      value: undefined,
      envName: slot.authEnv,
    };
    return Object.freeze({ target, credentialId: slot.credentialId, credential, slot });
  }
  return attempt;
}
