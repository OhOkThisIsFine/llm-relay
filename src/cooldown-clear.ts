import {
  type CircuitBreaker,
  type ClearedCircuitCell,
} from "./circuit-breaker.js";
import {
  CREDENTIAL_LABEL_PATTERN,
  makeCredentialId,
  parseCredentialId,
} from "./credential-id.js";
import { hasExactKeys, isRecord } from "./json-shape.js";
import {
  clearCooldownFacts,
  clearCredentialInvalidFacts,
  COOLING_FACT_KINDS,
  type ClearedCooldownFact,
  type FactKind,
} from "./target-facts.js";

export type CooldownClearKind = "credential-fault";

export interface CooldownClearTarget {
  readonly provider: string;
  readonly model?: string;
  /** Configured credential label, never key material. */
  readonly credential?: string;
  readonly kinds?: readonly CooldownClearKind[];
}

export interface CooldownCellIdentifier {
  readonly provider: string;
  readonly model: string | null;
  readonly credential: string;
}

export interface ClearedCooldownGroup<T> {
  readonly count: number;
  readonly items: T[];
}

export interface CooldownClearResult {
  readonly target: CooldownClearTarget;
  readonly cleared: {
    readonly breakerCells: ClearedCooldownGroup<CooldownCellIdentifier>;
    readonly credentialFaults: ClearedCooldownGroup<CooldownCellIdentifier>;
    readonly facts: ClearedCooldownGroup<ClearedCooldownFact>;
  };
}

export type CooldownClearTargetKey = keyof CooldownClearTarget;

type CooldownFactScope = ClearedCooldownFact["scope"];

function nonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.length > 0;
}

function credentialIdBelongsTo(provider: string, value: unknown): value is string {
  if (typeof value !== "string") return false;
  return parseCredentialId(value)?.provider === provider;
}

function targetMatches(
  value: unknown,
  expected: CooldownClearTarget,
  acceptedKeys: readonly CooldownClearTargetKey[],
): value is CooldownClearTarget {
  if (!hasExactKeys(value, acceptedKeys)) return false;
  return acceptedKeys.every((key) => {
    if (key !== "kinds") return value[key] === expected[key];
    return Array.isArray(value.kinds) && expected.kinds !== undefined &&
      value.kinds.length === expected.kinds.length &&
      value.kinds.every((kind, index) => kind === expected.kinds![index]);
  });
}

function isCooldownFactScope(value: unknown): value is CooldownFactScope {
  if (!isRecord(value)) return false;
  switch (value.kind) {
    case "attempt":
      return hasExactKeys(value, ["kind", "provider", "credentialId", "model"]) &&
        nonEmptyString(value.provider) &&
        credentialIdBelongsTo(value.provider, value.credentialId) &&
        nonEmptyString(value.model);
    case "group": {
      const keys = Object.hasOwn(value, "credentialId")
        ? ["kind", "provider", "credentialId", "members"]
        : ["kind", "provider", "members"];
      return hasExactKeys(value, keys) &&
        nonEmptyString(value.provider) &&
        Array.isArray(value.members) &&
        value.members.length > 0 &&
        value.members.every(nonEmptyString) &&
        (!Object.hasOwn(value, "credentialId") || credentialIdBelongsTo(value.provider, value.credentialId));
    }
    case "deployment":
      return hasExactKeys(value, ["kind", "provider", "model"]) &&
        nonEmptyString(value.provider) && nonEmptyString(value.model);
    case "credential":
      return hasExactKeys(value, ["kind", "provider", "credentialId"]) &&
        nonEmptyString(value.provider) && credentialIdBelongsTo(value.provider, value.credentialId);
    case "provider":
      return hasExactKeys(value, ["kind", "provider"]) && nonEmptyString(value.provider);
    case "model":
      return hasExactKeys(value, ["kind", "model"]) && nonEmptyString(value.model);
    default:
      return false;
  }
}

function scopeIsContainedByTarget(
  scope: CooldownFactScope,
  target: CooldownClearTarget,
): boolean {
  const credentialId = target.credential === undefined
    ? undefined
    : makeCredentialId(target.provider, target.credential);
  switch (scope.kind) {
    case "attempt":
      return scope.provider === target.provider &&
        (target.model === undefined || scope.model === target.model) &&
        (credentialId === undefined || scope.credentialId === credentialId);
    case "group":
      return scope.provider === target.provider &&
        (target.model === undefined || scope.members.every((member) => member === target.model)) &&
        (credentialId === undefined || scope.credentialId === credentialId);
    case "deployment":
      return scope.provider === target.provider && credentialId === undefined &&
        (target.model === undefined || scope.model === target.model);
    case "credential":
      return scope.provider === target.provider && target.model === undefined &&
        (credentialId === undefined || scope.credentialId === credentialId);
    case "provider":
      return scope.provider === target.provider && target.model === undefined && credentialId === undefined;
    case "model":
      return false;
  }
}

function isNarrowedScope(value: unknown, target: CooldownClearTarget): boolean {
  if (!isRecord(value) || typeof value.kind !== "string") return false;
  const credentialId = target.credential === undefined
    ? undefined
    : makeCredentialId(target.provider, target.credential);
  switch (value.kind) {
    case "attempt":
      return hasExactKeys(value, ["kind", "provider", "credentialId", "model"]) &&
        value.provider === target.provider && value.credentialId === credentialId &&
        typeof value.model === "string";
    case "group":
      return hasExactKeys(value, ["kind", "provider", "credentialId", "members"]) &&
        value.provider === target.provider && value.credentialId === credentialId &&
        Array.isArray(value.members) && value.members.length > 0 &&
        value.members.every(nonEmptyString);
    case "credential":
      return hasExactKeys(value, ["kind", "provider", "credentialId"]) &&
        value.provider === target.provider && value.credentialId === credentialId;
    default:
      return false;
  }
}

function isCooldownCell(
  value: unknown,
  target: CooldownClearTarget,
  narrowed: boolean,
): value is CooldownCellIdentifier {
  if (!isRecord(value) || !hasExactKeys(value, ["provider", "model", "credential"])) return false;
  if (value.provider !== target.provider || (!narrowed && !nonEmptyString(value.provider))) return false;
  if (!(value.model === null || (narrowed ? typeof value.model === "string" : nonEmptyString(value.model)))) {
    return false;
  }
  if (narrowed) {
    if (value.credential !== target.credential) return false;
  } else if (!nonEmptyString(value.credential) || !CREDENTIAL_LABEL_PATTERN.test(value.credential)) {
    return false;
  }
  return (target.model === undefined || value.model === target.model) &&
    (target.credential === undefined || value.credential === target.credential);
}

function isCooldownFact(
  value: unknown,
  target: CooldownClearTarget,
  narrowed: boolean,
): value is ClearedCooldownFact {
  if (!isRecord(value) || !hasExactKeys(value, ["kind", "scope"])) return false;
  if (narrowed) {
    return value.kind === "credential-invalid" && isNarrowedScope(value.scope, target);
  }
  return typeof value.kind === "string" &&
    COOLING_FACT_KINDS.has(value.kind as FactKind) &&
    isCooldownFactScope(value.scope) &&
    scopeIsContainedByTarget(value.scope, target);
}

function isClearedGroup<T>(
  value: unknown,
  isItem: (item: unknown) => item is T,
): value is ClearedCooldownGroup<T> {
  if (!isRecord(value) || !hasExactKeys(value, ["count", "items"]) ||
      typeof value.count !== "number" || !Number.isSafeInteger(value.count) ||
      value.count < 0 || !Array.isArray(value.items)) {
    return false;
  }
  return value.count === value.items.length && value.items.every(isItem);
}

/** Validate the cooldown-clear wire envelope under a caller-owned exact target-key policy. */
export function isCooldownClearResult(
  value: unknown,
  expectedTarget: CooldownClearTarget,
  acceptedTargetKeys: readonly CooldownClearTargetKey[],
): value is CooldownClearResult {
  if (!isRecord(value) || !hasExactKeys(value, ["target", "cleared"]) ||
      !targetMatches(value.target, expectedTarget, acceptedTargetKeys) ||
      !isRecord(value.cleared) ||
      !hasExactKeys(value.cleared, ["breakerCells", "credentialFaults", "facts"])) {
    return false;
  }
  // Derived from the semantic condition the PRODUCER uses (`target.kinds !== undefined` in
  // clearCooldowns), not from the key-policy array — one definition of "narrowed" per file.
  const narrowed = expectedTarget.kinds !== undefined;
  return isClearedGroup(
    value.cleared.breakerCells,
    narrowed
      ? (_item): _item is CooldownCellIdentifier => false
      : (item): item is CooldownCellIdentifier => isCooldownCell(item, expectedTarget, false),
  ) &&
    isClearedGroup(value.cleared.credentialFaults, (item): item is CooldownCellIdentifier =>
      isCooldownCell(item, expectedTarget, narrowed)) &&
    isClearedGroup(value.cleared.facts, (item): item is ClearedCooldownFact =>
      isCooldownFact(item, expectedTarget, narrowed));
}

function publicCell(cell: ClearedCircuitCell): CooldownCellIdentifier {
  return {
    provider: cell.provider,
    model: cell.model,
    credential: parseCredentialId(cell.credentialId)?.label ?? cell.credentialId,
  };
}

/** One mutation seam for the live breaker and process-global learned fact store. */
export function clearCooldowns(
  breaker: CircuitBreaker,
  target: CooldownClearTarget,
  opts: { factsPath?: string; now?: number } = {},
): CooldownClearResult {
  const credentialId = target.credential === undefined
    ? undefined
    : makeCredentialId(target.provider, target.credential);
  const selector = {
    provider: target.provider,
    ...(target.model === undefined ? {} : { model: target.model }),
    ...(credentialId === undefined ? {} : { credentialId }),
  };
  if (
    target.kinds !== undefined &&
    (target.kinds.length !== 1 || target.kinds[0] !== "credential-fault")
  ) {
    throw new Error(`kinds must be exactly ["credential-fault"] when provided`);
  }
  const factOpts = {
    ...(opts.factsPath === undefined ? {} : { path: opts.factsPath }),
    ...(opts.now === undefined ? {} : { now: opts.now }),
  };
  const narrowedToCredentialFault = target.kinds !== undefined;
  // Design §2.6: widening the usual "only on a disproved stated fact" rule is defensible here
  // because the operator's rotation assertion was verified against what actually resolves.
  const breakerResult = narrowedToCredentialFault
    ? {
        breakerCells: [],
        credentialFaults: breaker.clearCredentialFaultState(selector),
      }
    : breaker.clearCooldownState(selector);
  const facts = narrowedToCredentialFault
    ? clearCredentialInvalidFacts(selector, factOpts)
    : clearCooldownFacts(selector, factOpts);
  const breakerCells = breakerResult.breakerCells.map(publicCell);
  const credentialFaults = breakerResult.credentialFaults.map(publicCell);
  return {
    target: {
      provider: target.provider,
      ...(target.model === undefined ? {} : { model: target.model }),
      ...(target.credential === undefined ? {} : { credential: target.credential }),
      ...(target.kinds === undefined ? {} : { kinds: [...target.kinds] }),
    },
    cleared: {
      breakerCells: { count: breakerCells.length, items: breakerCells },
      credentialFaults: { count: credentialFaults.length, items: credentialFaults },
      facts: { count: facts.length, items: facts },
    },
  };
}
