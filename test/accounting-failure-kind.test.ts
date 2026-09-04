import { describe, expect, it } from "vitest";
import { accountingFailureForAttempt } from "../src/candidate-runner.js";
import type { AttemptFailed, OutcomeProvenance } from "../src/kernel/contracts.js";

/**
 * Pins contract review DR-003 (audit 2026-09-03): the ledger must not blame the provider for a
 * failure the RELAY authored.
 *
 * One `AttemptFailed` record is consumed by two subsystems. The breaker routes its provenance
 * through the total table `PROVENANCE_REACHES_HEALTH_PATH` and declines to charge
 * `relay-mapper-defect`; the ledger's classifier used to consult provenance in exactly one branch
 * and then fall through to an unconditional `provider_error`. The concrete case, reachable on
 * BOTH fronts: a dialect-rescue destructive refusal is relay-authored, carries `failure: "http"`
 * and `provenance: "relay-mapper-defect"`, and was recorded as the provider's error — a refusal
 * that came out of the operator's own `repair.destructiveTools` list.
 *
 * The lists below are closed against the kernel unions at compile time, so a new provenance or
 * failure member fails `npm run typecheck:test` here until it is classified.
 */
const PROVENANCES = [
  "upstream",
  "invalid-upstream-envelope",
  "deadline",
  "client-cancellation",
  "relay-mapper-defect",
] as const satisfies readonly OutcomeProvenance[];
type MissingProvenance = Exclude<OutcomeProvenance, (typeof PROVENANCES)[number]>;
const _everyProvenanceListed: MissingProvenance extends never ? true : never = true;

const FAILURES = ["http", "transport", "invalid-response", "mapping", "protocol"] as const satisfies readonly AttemptFailed["failure"][];
type MissingFailure = Exclude<AttemptFailed["failure"], (typeof FAILURES)[number]>;
const _everyFailureListed: MissingFailure extends never ? true : never = true;

const STATUSES = [null, 400, 401, 403, 429, 500, 502, 504] as const;
const PROVIDER_BLAME = new Set(["provider_error", "auth_error", "rate_limit", "timeout"]);

describe("accountingFailureForAttempt — the ledger's blame follows the breaker's", () => {
  it("never blames the provider for a relay-authored failure, whatever the status or failure", () => {
    for (const failure of FAILURES) {
      for (const status of STATUSES) {
        const kind = accountingFailureForAttempt({ failure, provenance: "relay-mapper-defect", status });
        expect(PROVIDER_BLAME.has(kind), `${failure}/${status} -> ${kind}`).toBe(false);
        expect(kind).toBe("protocol");
      }
    }
  });

  it("records the dialect-rescue destructive refusal as the relay's own protocol decision", () => {
    // Both fronts complete that refusal with failure "http" — the shape the old classifier let
    // fall through to "provider_error".
    expect(accountingFailureForAttempt({ failure: "http", provenance: "relay-mapper-defect", status: 502 })).toBe("protocol");
    expect(accountingFailureForAttempt({ failure: "mapping", provenance: "relay-mapper-defect", status: 400 })).toBe("protocol");
  });

  it("keeps every provider-side classification", () => {
    expect(accountingFailureForAttempt({ failure: "http", provenance: "upstream", status: 429 })).toBe("rate_limit");
    expect(accountingFailureForAttempt({ failure: "http", provenance: "upstream", status: 401 })).toBe("auth_error");
    expect(accountingFailureForAttempt({ failure: "http", provenance: "upstream", status: 403 })).toBe("auth_error");
    expect(accountingFailureForAttempt({ failure: "http", provenance: "upstream", status: 500 })).toBe("provider_error");
    expect(accountingFailureForAttempt({ failure: "transport", provenance: "deadline", status: 504 })).toBe("timeout");
    expect(accountingFailureForAttempt({ failure: "transport", provenance: "upstream", status: 502 })).toBe("provider_error");
    expect(accountingFailureForAttempt({ failure: "protocol", provenance: "invalid-upstream-envelope", status: 502 })).toBe("protocol");
    expect(accountingFailureForAttempt({ failure: "invalid-response", provenance: "upstream", status: null })).toBe("protocol");
  });

  it("classifies every (failure, provenance) pair — no member falls through unhandled", () => {
    const kinds = new Set(["timeout", "provider_error", "auth_error", "rate_limit", "aborted", "protocol", "unknown"]);
    for (const failure of FAILURES) {
      for (const provenance of PROVENANCES) {
        const kind = accountingFailureForAttempt({ failure, provenance, status: null });
        expect(kinds.has(kind), `${failure}/${provenance} -> ${kind}`).toBe(true);
      }
    }
  });
});
