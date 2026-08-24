import {
  type CircuitBreaker,
  type ClearedCircuitCell,
} from "./circuit-breaker.js";
import { makeCredentialId, parseCredentialId } from "./credential-id.js";
import {
  clearCooldownFacts,
  type ClearedCooldownFact,
} from "./target-facts.js";

export interface CooldownClearTarget {
  readonly provider: string;
  readonly model?: string;
  /** Configured credential label, never key material. */
  readonly credential?: string;
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
  const breakerResult = breaker.clearCooldownState(selector);
  const facts = clearCooldownFacts(selector, {
    ...(opts.factsPath === undefined ? {} : { path: opts.factsPath }),
    ...(opts.now === undefined ? {} : { now: opts.now }),
  });
  const breakerCells = breakerResult.breakerCells.map(publicCell);
  const credentialFaults = breakerResult.credentialFaults.map(publicCell);
  return {
    target: {
      provider: target.provider,
      ...(target.model === undefined ? {} : { model: target.model }),
      ...(target.credential === undefined ? {} : { credential: target.credential }),
    },
    cleared: {
      breakerCells: { count: breakerCells.length, items: breakerCells },
      credentialFaults: { count: credentialFaults.length, items: credentialFaults },
      facts: { count: facts.length, items: facts },
    },
  };
}
