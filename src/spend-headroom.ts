import type { CredentialId } from "./credential-id.js";
import type { QuotaInfo } from "./ping/quota.js";
import { clearPaidAllowanceFacts, recordFact } from "./target-facts.js";

/**
 * Provider-stated PAID-SPEND headroom for one credential — asked for, never inferred.
 *
 * The problem this solves (owner decision 2026-08-28): the paid/free boundary on a spend-limited
 * key used to be LEARNED from a refusal — OpenRouter's `403 Key limit exceeded (weekly limit)`
 * had to occur, be queued, researched, and accepted before the relay knew the paid subset was
 * spent. But OpenRouter publishes the answer: `GET /api/v1/auth/key` states the key's credit
 * `limit` and `usage` first-hand. Asking beats inferring — the statement is current, carries no
 * interpretation risk, and updates in BOTH directions (bought credits un-demote on the next poll
 * with no operator action and no lucky paid success).
 *
 * WHY THIS FEEDS THE FACT STORE AND NOT THE QUOTA LADDER: spend is not a `QuotaAxis`
 * (`requests | tokens`), and the credits answer states no reset — under "the relay never invents
 * a cooldown duration", a spend bucket could never demote through `quota-demotion.ts` without a
 * fabricated expiry. The fact store is the mechanism that already handles exactly this shape:
 * `allowance-exhausted` at `credential` scope with `costClasses: ["paid"]` is the SAME fact the
 * accepted OpenRouter weekly-limit interpretation produces, demoting paid deployments while free
 * ones stay walkable, expiring on the kind's TTL, cleared by any paid success. One mechanism, no
 * second implementation — this module only changes where the evidence comes from.
 *
 * Provenance: the classifier consumes only figures the provider stated; `unknown` (no stated
 * limit, or unparseable figures) has NO effect in either direction. The retraction is narrowed to
 * paid-only-filtered rows because a paid-credit statement cannot disprove a free-tier exhaustion
 * — see `clearPaidAllowanceFacts`.
 */
export type SpendHeadroomVerdict =
  | { state: "exhausted"; limitUsd: number; usageUsd: number; remainingUsd: number }
  | { state: "headroom"; limitUsd: number; usageUsd: number; remainingUsd: number }
  | { state: "unknown" };

/**
 * Classify a credits answer. Pure — no IO, no clock.
 *
 * `limitUsd: null` means the provider states no limit (or stated nothing): unknown, no effect.
 * The comparison is inclusive (`usage >= limit`), the same convention as the G2 hard cap: a limit
 * the provider says is fully consumed admits nothing more. A zero limit with zero usage is
 * therefore `exhausted` — a key allowed to spend nothing has no paid headroom.
 */
export function classifySpendHeadroom(
  info: Pick<QuotaInfo, "limitUsd" | "usageUsd">,
): SpendHeadroomVerdict {
  const limit = info.limitUsd;
  const usage = info.usageUsd;
  if (typeof limit !== "number" || !Number.isFinite(limit)) return { state: "unknown" };
  if (typeof usage !== "number" || !Number.isFinite(usage)) return { state: "unknown" };
  const remainingUsd = limit - usage;
  return usage >= limit
    ? { state: "exhausted", limitUsd: limit, usageUsd: usage, remainingUsd }
    : { state: "headroom", limitUsd: limit, usageUsd: usage, remainingUsd };
}

/**
 * Apply a verdict to the fact store. Returns what happened, for callers that log or test.
 *
 * - `exhausted` records `allowance-exhausted` at credential scope, paid-only. No stated reset
 *   exists, so the kind's default TTL applies — the poll re-records while the condition holds,
 *   and the fact lapses on its own if polling stops. Demotes, never evicts, never cost-blocks
 *   (`allowance-exhausted` is structurally unable to reach the cost path — `target-facts.ts`).
 * - `headroom` retracts paid-only `allowance-exhausted` rows for that credential — including one
 *   an accepted refusal interpretation recorded, which the same provider's fresher statement
 *   supersedes. Unfiltered and free-filtered rows survive; the statement says nothing about them.
 * - `unknown` does nothing, in either direction.
 */
export function applySpendHeadroom(
  provider: string,
  credentialId: CredentialId,
  verdict: SpendHeadroomVerdict,
  opts: { path?: string; now?: number } = {},
): "recorded" | "cleared" | "none" {
  if (verdict.state === "exhausted") {
    recordFact("allowance-exhausted", { kind: "credential", provider, credentialId }, {
      ...opts,
      costClasses: ["paid"],
    });
    return "recorded";
  }
  if (verdict.state === "headroom") {
    clearPaidAllowanceFacts({ provider, credentialId }, opts);
    return "cleared";
  }
  return "none";
}
