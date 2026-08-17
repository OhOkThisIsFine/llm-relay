import type { CredentialId } from "./credential-id.js";
import { makeCredentialId } from "./credential-id.js";
import type { CredentialResolution } from "./authEnv.js";
import { resolveCredential } from "./authEnv.js";
import type { ResolvedTarget } from "./config.js";

/** Application-layer attempt with credential resolution performed exactly once. */
export interface ResolvedAttempt {
  readonly target: ResolvedTarget;
  readonly credentialId: CredentialId;
  readonly credential: CredentialResolution;
}

/** Resolve the current single-slot target into the application attempt shape. */
export function resolveAttempt(
  target: ResolvedTarget,
  env: NodeJS.ProcessEnv = process.env,
): ResolvedAttempt {
  const credentialId = makeCredentialId(target.provider);
  const credential = resolveCredential(target.authEnv, env, target.provider);
  return Object.freeze({ target, credentialId, credential });
}
