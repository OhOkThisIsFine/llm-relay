import {
  type CircuitBreaker,
  type ClearedCircuitCell,
} from "./circuit-breaker.js";
import { makeCredentialId, parseCredentialId } from "./credential-id.js";
import {
  clearCooldownFacts,
  clearCredentialInvalidFacts,
  type ClearedCooldownFact,
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
