import { describe, expect, it } from "vitest";
import {
  STATUS_VERDICT_TABLE,
  carriesEligibilityFact,
  classifyStatus,
  statusVerdict,
} from "../src/candidate-runner.js";

/**
 * Characterization test for SEM-04: `classifyStatus` and `carriesEligibilityFact` now read one
 * table instead of carrying a membership list each.
 *
 * The two functions below are the PRE-CHANGE bodies, copied verbatim. They are the specification
 * here — the point is not that the table looks right, it is that the table answers exactly what the
 * two hand-written chains answered, on every status either of them could ever see. Delete them only
 * when you intend to change routing behaviour, and say so.
 */

function classifyStatusBefore(status: number): string {
  if (status < 400) return "ok";
  if (status === 401 || status === 403) return "credential";
  if (status === 400 || status === 402 || status === 404 || status === 410 || status === 429 || status >= 500) return "retriable";
  return "client";
}

function carriesEligibilityFactBefore(status: number): boolean {
  return (
    status === 400 ||
    status === 401 ||
    status === 402 ||
    status === 403 ||
    status === 404 ||
    status === 410 ||
    status === 429
  );
}

describe("statusVerdict", () => {
  it("answers exactly what the two hand-written chains answered, for every status 0 through 999", () => {
    const drifted: string[] = [];
    for (let status = 0; status < 1000; status += 1) {
      const verdict = statusVerdict(status);
      if (verdict.outcome !== classifyStatusBefore(status)) {
        drifted.push(`${status}: outcome ${classifyStatusBefore(status)} -> ${verdict.outcome}`);
      }
      if (verdict.carriesEligibilityFact !== carriesEligibilityFactBefore(status)) {
        drifted.push(`${status}: eligibility ${carriesEligibilityFactBefore(status)} -> ${verdict.carriesEligibilityFact}`);
      }
    }
    expect(drifted, `the table disagrees with the pre-change behaviour:\n  ${drifted.join("\n  ")}`).toEqual([]);
  });

  it("keeps the two exported readers as thin views over the same verdict", () => {
    for (let status = 0; status < 1000; status += 1) {
      expect(classifyStatus(status)).toBe(statusVerdict(status).outcome);
      expect(carriesEligibilityFact(status)).toBe(statusVerdict(status).carriesEligibilityFact);
    }
  });

  it("lists exactly the seven statuses both chains enumerated, and no others", () => {
    // A row added or removed here is a ROUTING decision, never a mechanical one. If this assertion
    // fails, the change was deliberate or it was a mistake — decide which before editing the list.
    expect(Object.keys(STATUS_VERDICT_TABLE).map(Number).sort((a, b) => a - b))
      .toEqual([400, 401, 402, 403, 404, 410, 429]);
  });

  it("falls to the weaker claim for an unlisted 4xx, and to retriable for an unlisted 5xx", () => {
    // `client` means the walk does NOT fail over. That is the safe direction for a status nobody
    // has reasoned about, and it is what both chains already did.
    expect(statusVerdict(418)).toEqual({ outcome: "client", carriesEligibilityFact: false });
    expect(statusVerdict(451)).toEqual({ outcome: "client", carriesEligibilityFact: false });
    expect(statusVerdict(503)).toEqual({ outcome: "retriable", carriesEligibilityFact: false });
    expect(statusVerdict(200)).toEqual({ outcome: "ok", carriesEligibilityFact: false });
  });
});
