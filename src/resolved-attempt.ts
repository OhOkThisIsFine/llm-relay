import type { ResolvedTarget } from "./config-types.js";
import type { ResolvedAttempt } from "./credential-fleet.js";
import { emptyCredentialSlot, implicitCredentialSlot, resolveAttemptForSlot } from "./credential-fleet.js";
import type { KeystoreOptions } from "./keystore.js";

export type { ResolvedAttempt };

/** Resolve the current single-slot target into the application attempt shape. */
export function resolveAttempt(
  target: ResolvedTarget,
  env: NodeJS.ProcessEnv = process.env,
  keystoreOptions?: KeystoreOptions,
): ResolvedAttempt {
  const emptyFleet = target.credentialSlots !== undefined && target.credentialSlots.length === 0;
  const slot = emptyFleet
    ? emptyCredentialSlot(target.provider)
    : target.credentialSlots?.[0] ?? implicitCredentialSlot(target.provider, target.authEnv);
  const attempt = resolveAttemptForSlot(target, slot, env, keystoreOptions);
  // The legacy resolver intentionally still returns a missing attempt so existing callers can
  // produce their established credential-config error before any backend egress.
  if (!attempt) {
    const credential = {
      state: "declared-missing" as const,
      value: undefined,
      envName: slot.authEnv,
      source: undefined,
    };
    return Object.freeze({ target, credentialId: slot.credentialId, credential, slot });
  }
  return attempt;
}
