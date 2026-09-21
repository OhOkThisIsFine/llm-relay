import { isDeepStrictEqual } from "node:util";
import type {
  Config,
  ProviderConfig,
  ProviderCredentialConfig,
  Routing,
} from "./config-types.js";

/**
 * D2's reload boundary is intentionally explicit. A valid config candidate either:
 * - differs only in fields this daemon can safely observe through its existing Config identity, or
 * - names one or more restart-only paths and is refused as a whole.
 *
 * The returned path list contains configuration metadata only. Values are never echoed.
 */

const PROVIDER_RELOADABLE_FIELDS = [
  "timeoutMs",
  "stallTimeoutMs",
  "firstByteTimeoutMs",
  "maxConcurrent",
  "limits",
] as const satisfies readonly (keyof ProviderConfig)[];

const PROVIDER_RESTART_FIELDS = [
  "base",
  "kind",
  "authEnv",
  "credentialMode",
  "authHeader",
  "tierType",
  "compat",
  "wire",
  "signupUrl",
] as const satisfies readonly (keyof ProviderConfig)[];

const ROUTING_RELOADABLE_FIELDS = [
  "default",
  "tiers",
  "pools",
  "poolPolicies",
  "poolDegraded",
  "subagents",
  "offload",
  "benchmarkSort",
  "quota",
  "latency",
  "probation",
  "pacing",
  "crawl",
  "laneProbe",
  "ladder",
  "ladders",
  "cliLane",
] as const satisfies readonly (keyof Routing)[];

const ROUTING_RESTART_FIELDS = [
  "sticky",
  "hedge",
  "dispatchWalk",
  "mcp",
] as const satisfies readonly (keyof Routing)[];

function equal(a: unknown, b: unknown): boolean {
  return isDeepStrictEqual(a, b);
}

function sortedUnique(paths: string[]): string[] {
  return [...new Set(paths)].sort();
}

function providerNames(cfg: Config): string[] {
  return Object.keys(cfg.providers).sort();
}

/**
 * Credential identity excludes only the nested rate-limit policy. Changing any other credential
 * field can re-bind provider-keyed probe/breaker/accounting evidence and therefore needs restart.
 */
function credentialIdentity(
  credential: ProviderCredentialConfig,
): Omit<ProviderCredentialConfig, "limits"> {
  const { limits: _limits, ...identity } = credential;
  return identity;
}

function credentialIdentityList(provider: ProviderConfig): Array<Omit<ProviderCredentialConfig, "limits">> | undefined {
  return provider.credentials?.map(credentialIdentity);
}

function noteIfChanged(
  paths: string[],
  path: string,
  before: unknown,
  after: unknown,
): void {
  if (!equal(before, after)) paths.push(path);
}

/** Paths whose candidate values cannot be applied without rebuilding startup-owned state. */
export function configReloadRestartPaths(live: Config, candidate: Config): string[] {
  const paths: string[] = [];

  noteIfChanged(paths, "host", live.host, candidate.host);
  noteIfChanged(paths, "port", live.port, candidate.port);
  noteIfChanged(paths, "log", live.log, candidate.log);
  noteIfChanged(
    paths,
    "repair.destructiveTools",
    live.repair.destructiveTools,
    candidate.repair.destructiveTools,
  );
  noteIfChanged(paths, "sourcePath", live.sourcePath, candidate.sourcePath);

  const liveProviders = providerNames(live);
  const candidateProviders = providerNames(candidate);
  if (!equal(liveProviders, candidateProviders)) {
    paths.push("providers");
  } else {
    for (const name of liveProviders) {
      const before = live.providers[name]!;
      const after = candidate.providers[name]!;
      for (const field of PROVIDER_RESTART_FIELDS) {
        noteIfChanged(paths, `providers.${name}.${field}`, before[field], after[field]);
      }
      noteIfChanged(
        paths,
        `providers.${name}.credentials`,
        credentialIdentityList(before),
        credentialIdentityList(after),
      );
    }
  }

  for (const field of ROUTING_RESTART_FIELDS) {
    noteIfChanged(paths, `routing.${field}`, live.routing[field], candidate.routing[field]);
  }

  return sortedUnique(paths);
}

/** Effective reloadable paths that changed, excluding load metadata such as mtime/warnings. */
export function configReloadChangedPaths(live: Config, candidate: Config): string[] {
  const paths: string[] = [];

  noteIfChanged(paths, "mode", live.mode, candidate.mode);
  noteIfChanged(paths, "reshaper", live.reshaper, candidate.reshaper);
  noteIfChanged(
    paths,
    "reshaperCandidates",
    live.reshaperCandidates,
    candidate.reshaperCandidates,
  );
  noteIfChanged(paths, "reshaperPool", live.reshaperPool, candidate.reshaperPool);
  noteIfChanged(paths, "repair.maxAttempts", live.repair.maxAttempts, candidate.repair.maxAttempts);
  noteIfChanged(paths, "walkBudgetMs", live.walkBudgetMs, candidate.walkBudgetMs);
  noteIfChanged(paths, "maxBodyBytes", live.maxBodyBytes, candidate.maxBodyBytes);
  noteIfChanged(paths, "leaveMeAlone", live.leaveMeAlone, candidate.leaveMeAlone);

  const liveProviders = providerNames(live);
  const candidateProviders = providerNames(candidate);
  if (equal(liveProviders, candidateProviders)) {
    for (const name of liveProviders) {
      const before = live.providers[name]!;
      const after = candidate.providers[name]!;
      for (const field of PROVIDER_RELOADABLE_FIELDS) {
        noteIfChanged(paths, `providers.${name}.${field}`, before[field], after[field]);
      }
      if (
        equal(credentialIdentityList(before), credentialIdentityList(after)) &&
        before.credentials !== undefined &&
        after.credentials !== undefined
      ) {
        for (let index = 0; index < before.credentials.length; index += 1) {
          noteIfChanged(
            paths,
            `providers.${name}.credentials[${index}].limits`,
            before.credentials[index]?.limits,
            after.credentials[index]?.limits,
          );
        }
      }
    }
  }

  for (const field of ROUTING_RELOADABLE_FIELDS) {
    noteIfChanged(paths, `routing.${field}`, live.routing[field], candidate.routing[field]);
  }

  return sortedUnique(paths);
}

function replaceProperty(
  target: object,
  key: string,
  value: unknown,
): void {
  const record = target as Record<string, unknown>;
  if (value === undefined) delete record[key];
  else record[key] = value;
}

function applyProviderPolicy(live: ProviderConfig, candidate: ProviderConfig): void {
  for (const field of PROVIDER_RELOADABLE_FIELDS) {
    replaceProperty(live, field, candidate[field]);
  }
  if (live.credentials !== undefined && candidate.credentials !== undefined) {
    for (let index = 0; index < live.credentials.length; index += 1) {
      const current = live.credentials[index];
      const next = candidate.credentials[index];
      if (current === undefined || next === undefined) continue;
      replaceProperty(current, "limits", next.limits);
    }
  }
}

function replaceSourceMtime(live: Config, candidate: Config): void {
  delete live.sourceMtimeMs;
  if (candidate.sourceMtimeMs === undefined) return;
  Object.defineProperty(live, "sourceMtimeMs", {
    value: candidate.sourceMtimeMs,
    enumerable: false,
    writable: false,
    configurable: true,
  });
}

export type ConfigReloadApplyResult =
  | { ok: true; changed: string[] }
  | { ok: false; requiresRestart: string[] };

/** Result returned by the daemon's injected reload transaction to the HTTP adapter. */
export type ConfigReloadAttemptResult =
  | { ok: true; changed: string[]; warnings: string[] }
  | { ok: false; status: 400; message: string }
  | { ok: false; status: 409; message: string; requiresRestart: string[] };

/**
 * Atomically apply a normalized candidate to the existing Config identity.
 *
 * This function performs no I/O and has no await point. All refusal checks happen before the
 * first mutation, so a restart-only difference cannot partially apply reloadable siblings.
 */
export function applyConfigReload(
  live: Config,
  candidate: Config,
): ConfigReloadApplyResult {
  const requiresRestart = configReloadRestartPaths(live, candidate);
  if (requiresRestart.length > 0) return { ok: false, requiresRestart };

  const changed = configReloadChangedPaths(live, candidate);

  live.mode = candidate.mode;
  replaceProperty(live, "reshaper", candidate.reshaper);
  replaceProperty(live, "reshaperCandidates", candidate.reshaperCandidates);
  replaceProperty(live, "reshaperPool", candidate.reshaperPool);
  live.repair.maxAttempts = candidate.repair.maxAttempts;
  replaceProperty(live, "walkBudgetMs", candidate.walkBudgetMs);
  replaceProperty(live, "maxBodyBytes", candidate.maxBodyBytes);
  replaceProperty(live, "leaveMeAlone", candidate.leaveMeAlone);

  for (const name of providerNames(live)) {
    applyProviderPolicy(live.providers[name]!, candidate.providers[name]!);
  }

  for (const field of ROUTING_RELOADABLE_FIELDS) {
    replaceProperty(live.routing, field, candidate.routing[field]);
  }

  replaceProperty(live, "warnings", candidate.warnings);
  replaceSourceMtime(live, candidate);
  return { ok: true, changed };
}
