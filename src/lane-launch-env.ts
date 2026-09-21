/**
 * Environment construction shared by MCP-owned and daemon-broker-owned lane launches.
 *
 * A lane inherits the launcher's ordinary user environment except credentials the relay itself
 * owns for provider traffic. Operator-authored lane env deltas may explicitly reintroduce one.
 * Keeping this policy in one neutral module prevents the D1 daemon launcher from gaining a second
 * credential-scrubbing implementation.
 */
import { credentialCandidateEnvNames } from "./authEnv.js";
import type { Config } from "./config.js";

/** Every configured environment variable that may hold a relay-owned provider credential. */
export function laneCredentialEnvNames(config: Config): string[] {
  const names = new Set<string>();
  for (const [providerName, provider] of Object.entries(config.providers ?? {})) {
    if (provider.credentials !== undefined) {
      // Explicit fleet slots deliberately do NOT alias-fallback, so scrub exactly the names those
      // slots declare and no broader heuristic set.
      for (const slot of provider.credentials) names.add(slot.authEnv);
      continue;
    }
    for (const name of credentialCandidateEnvNames(provider.authEnv, providerName)) names.add(name);
  }

  // A legacy standalone reshaper can own a credential outside providers. Provider-backed
  // reshapers are already covered above, but the explicit name is cheap and harmless to repeat.
  if (config.reshaper?.authEnv) names.add(config.reshaper.authEnv);
  for (const candidate of config.reshaperCandidates ?? []) {
    if (candidate.authEnv) names.add(candidate.authEnv);
  }
  return [...names];
}

/**
 * Build a lane's child environment.
 *
 * A spawned agent receives the ordinary launcher environment EXCEPT relay-owned provider
 * credentials. An operator may deliberately reintroduce one by naming that variable in the rung's
 * own env block with a non-null value. That exception is explicit configuration, not inheritance.
 *
 * Windows environment names are case-insensitive, so the scrub and explicit-override checks are
 * case-insensitive there too.
 */
export function buildLaneEnv(
  base: NodeJS.ProcessEnv,
  deltas: Record<string, string | null> | undefined,
  config: Config,
  platform: NodeJS.Platform = process.platform,
): NodeJS.ProcessEnv {
  const normalize = (name: string): string => platform === "win32" ? name.toUpperCase() : name;
  const credentialNames = new Set(laneCredentialEnvNames(config).map(normalize));
  const explicitlySet = new Set(
    Object.entries(deltas ?? {})
      .filter(([, value]) => value !== null)
      .map(([name]) => normalize(name)),
  );

  const env: NodeJS.ProcessEnv = {};
  for (const [name, value] of Object.entries(base)) {
    if (credentialNames.has(normalize(name)) && !explicitlySet.has(normalize(name))) continue;
    env[name] = value;
  }
  for (const [name, value] of Object.entries(deltas ?? {})) {
    if (value === null) {
      for (const existing of Object.keys(env)) {
        if (normalize(existing) === normalize(name)) delete env[existing];
      }
    } else {
      // Avoid two spellings of the same Windows variable surviving the copy.
      if (platform === "win32") {
        for (const existing of Object.keys(env)) {
          if (existing !== name && normalize(existing) === normalize(name)) delete env[existing];
        }
      }
      env[name] = value;
    }
  }
  return env;
}
