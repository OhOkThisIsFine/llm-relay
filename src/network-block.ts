/**
 * Recognising a refusal that is about the CALLER'S NETWORK, not about the target.
 *
 * Some providers refuse a request because of where it came FROM — a VPN exit, a datacenter or
 * proxy IP, a blocked region. The wording says so, but nothing else does: the credential is
 * valid, the model is in the account's roster, the quota is untouched, and the same deployment
 * answers normally the moment the tunnel is off. Measured here 2026-08-29: `groq/qwen/qwen3.6-27b`
 * refused 20 times over 7.9 hours with `access denied. please check your network settings.`, then
 * answered HTTP 200 with a real completion once the operator's VPN was disconnected. The operator
 * had to diagnose that unaided, which is the gap this module closes.
 *
 * ⚠ **Display-only, and that is the design — not an unfinished half.** This records no fact,
 * demotes nothing, refuses nothing and never reaches the request path. Every member of the closed
 * fact vocabulary in `target-facts.ts` states something about DEPLOYMENT eligibility —
 * `not-servable`, `subscription-required`, `allowance-exhausted`, `credential-invalid`,
 * `rate-limited`. A client-side network block is none of those: the deployment is fine and the
 * credential is fine. Recording any of them would assert something this evidence does not support,
 * which is the one thing `refusal-interpretation.ts` exists to prevent. So the honest surface is
 * an advisory the operator reads, and there is no verdict to accept at all.
 *
 * ⚠ **The advice says LEAVE IT PENDING, and that is deliberate.** `reject` writes the signature
 * to the store's `ignored` set, where it "stays suppressed" — a later occurrence queues nothing.
 * So the obvious-looking tidy-up (this means nothing durable, therefore reject it) would silence
 * the next VPN episode completely, defeating the one thing this module exists to do. A permanent
 * queue entry is the price of a warning that still fires.
 *
 * ⚠ **Matching is on WORDING, deliberately not scoped to the provider that was first observed.**
 * A learned refusal interpretation is keyed per (provider, model) precisely so a verdict cannot
 * leak to a sibling SKU. The opposite applies here: the condition belongs to the operator's own
 * network, so it can strike any provider, and scoping the hint to groq would guarantee it stays
 * silent the next time a different vendor refuses the same tunnel. The trade is safe only because
 * the output is one advisory line — a false positive costs a sentence, never a routing decision.
 *
 * ⚠ **Every pattern names its own provenance, and the list is a bootstrap rather than the
 * mechanism.** Only wording this relay has actually seen refuse a request is admitted. Plausible
 * additions — Cloudflare's `error 1020`, generic `access denied` — are deliberately absent: they
 * are guesses about what a vendor means, and an advisory that misfires teaches the operator to
 * ignore it.
 */

/** Where a pattern's wording came from. A closed set, so a new rung is a compile error. */
export type NetworkBlockBasis = "first-party-observed";

export interface NetworkBlockPattern {
  /** Lower-case substring tested against the normalized refusal message. */
  readonly phrase: string;
  readonly basis: NetworkBlockBasis;
  /** Where and when this relay saw the wording, so a reader can judge it. */
  readonly provenance: string;
}

export interface NetworkBlockHint {
  readonly phrase: string;
  readonly basis: NetworkBlockBasis;
  readonly provenance: string;
  /** One line for the operator. States the likelihood, never a certainty. */
  readonly advice: string;
}

export const NETWORK_BLOCK_PATTERNS: readonly NetworkBlockPattern[] = [
  {
    phrase: "check your network settings",
    basis: "first-party-observed",
    provenance:
      "groq/qwen/qwen3.6-27b, HTTP 403 ×20 between 2026-08-28T16:36Z and 2026-08-29T00:32Z; " +
      "the operator identified a connected VPN, and the deployment returned HTTP 200 once it was off",
  },
];

const ADVICE =
  "This wording describes the CALLER'S network, not the target: a VPN, proxy or blocked egress IP. " +
  "The credential and the deployment are not implicated. Check whether a VPN is connected; if it is, " +
  "either disconnect it or exclude this provider in the VPN's split-tunnel settings. " +
  "There is no verdict to accept: no fact class describes a client-side network block. " +
  "Leave this item PENDING — `reject` suppresses the signature for good, so a later episode would " +
  "queue nothing and this warning would never appear again.";

/**
 * Does this refusal wording look like a client-side network block?
 *
 * Pure, and case-insensitive over the already-normalized message. Returns null for everything
 * else — silence is the correct answer for a message this list has no evidence about.
 */
export function classifyNetworkBlock(message: string): NetworkBlockHint | null {
  const haystack = message.toLowerCase();
  for (const pattern of NETWORK_BLOCK_PATTERNS) {
    if (haystack.includes(pattern.phrase)) {
      return { phrase: pattern.phrase, basis: pattern.basis, provenance: pattern.provenance, advice: ADVICE };
    }
  }
  return null;
}
