import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { homedir, tmpdir } from "node:os";
import { WriteBehindTimer } from "./write-behind.js";

/**
 * Deployment eligibility LEARNED from what a backend said when it refused to serve.
 *
 * Sibling of `context-limits.ts`, and built on the same rule: only an EXPLICITLY STATED fact is
 * recorded. A bare 403 teaches nothing (it could be a revoked key, which is the credential axis's
 * job); a 403 that says "this model requires a subscription" is the provider stating that this
 * deployment is not included in the plan we hold.
 *
 * This module is the CONSEQUENCE half only. Deciding what a given refusal message means belongs to
 * `refusal-interpretation.ts`, which answers it by deterministic lookup and queues anything it
 * cannot answer for offline research. Nothing here interprets anything; it stores verdicts and
 * reports what they imply for admission and ordering.
 *
 * Why this exists at all: `assessCost()` admits a model from a `tierType: "free"` provider with
 * unpublished prices as free on the `provider-tier` basis. That is the right default — most free
 * providers publish no prices — but it is an assumption about a ROSTER, and a roster contains
 * subscription-gated SKUs and models that have been de-listed behind the scenes. Those are only
 * ever discovered by asking. This store is where the answer goes so the next request does not have
 * to ask again.
 *
 * ⚠ **The three classes are NOT interchangeable, and the distinction is the point.**
 *
 *   not-servable          — the deployment does not exist (404/400 "does not exist", "not found
 *                           for account"). An EXISTENCE fact. Drop it from pool admission.
 *   subscription-required — it exists, but is not covered by the plan we hold (403 "requires a
 *                           subscription"). A COST fact: it refutes the `provider-tier` free
 *                           assessment for this one deployment. Drop it from FREE pool admission.
 *   allowance-exhausted   — it exists AND it is free; the free allowance is spent until it
 *                           refreshes (402 "you have depleted your monthly included credits").
 *                           A TEMPORAL fact, and emphatically NOT a cost fact.
 *
 * **Never let `allowance-exhausted` mean "paid".** A free-tier account that has spent this
 * period's credits is the single most common state of every provider this proxy fronts — it is the
 * normal condition of a working free lane, not a discovery about its price. Reclassifying it as
 * paid would evict the deployment from every free pool on a condition that clears by itself, and
 * the eviction would outlive the exhaustion. So it is deliberately unreachable from the cost path:
 * `isCostBlocked()` does not consider it, and only `cooldownUntil()` reports it — a demotion, on
 * the same footing as a 429, that expires on its own and clears the moment anything succeeds.
 */

/** What a refusal proved about a deployment. See the header — these are not ranks of one scale. */
export type EligibilityClass = "not-servable" | "subscription-required" | "allowance-exhausted";

/**
 * Whose fact it is.
 *
 * `deployment` — about this (provider, model) alone.
 * `account`    — about the credential, so every deployment on that provider shares it. Reserved
 *                for refusals that state an ACCOUNT-level condition ("you have depleted your
 *                monthly included credits" names a balance, not a model). This is what stops a
 *                pool holding six HuggingFace members from spending six round-trips to rediscover
 *                one balance — measured on this machine, `pool/xhigh`'s 15 members resolve to only
 *                four independent quota domains.
 */
export type EligibilityScope = "deployment" | "account";

interface Observation {
  class: EligibilityClass;
  scope: EligibilityScope;
  /** Epoch ms of the observation, for TTL. */
  at: number;
  /** Epoch ms this observation stops applying, when the refusal stated a reset. */
  until?: number;
}

interface EligibilityStore {
  version: 1;
  /** `<provider>/<model>`, or `<provider>/*` for an account-scoped observation. */
  observations: Record<string, Observation>;
}

/**
 * How long each class is believed without re-checking.
 *
 * All three expire, because all three are reversible: a de-listed model can come back, a plan can
 * be upgraded, and an allowance always refreshes. The spread reflects how fast each moves, and
 * `allowance-exhausted` is deliberately the SHORTEST — HuggingFace's included credits are monthly,
 * but cooling a whole provider for a month on one 402 would be catastrophic if the balance were
 * topped up an hour later. One re-probe an hour costs one request and is self-correcting; it also
 * matches the breaker's own `QUOTA_EXHAUSTED_COOLDOWN_MS`, so the two cannot disagree about when a
 * quota-exhausted target is worth trying again.
 */
export const ELIGIBILITY_TTL_MS: Record<EligibilityClass, number> = {
  "not-servable": 6 * 60 * 60 * 1000,
  "subscription-required": 24 * 60 * 60 * 1000,
  "allowance-exhausted": 60 * 60 * 1000,
};

let _store: EligibilityStore | null = null;
let _path: string | null = null;
const writer = new WriteBehindTimer();

function defaultPath(): string {
  // ⚠ Redirected under vitest for the same reason probe-cache and context-limits are: a test's
  // synthetic refusal persisted here would evict a real deployment from the user's live pools.
  if (process.env.VITEST !== undefined) {
    return join(tmpdir(), `llm-relay-test-eligibility-${process.pid}.json`);
  }
  const xdg = process.env.XDG_CONFIG_HOME;
  const baseDir = xdg && xdg.trim() ? join(xdg, "llm-relay") : join(homedir(), ".llm-relay");
  return join(baseDir, "deployment-eligibility.json");
}

function deploymentKey(provider: string, model: string): string {
  return `${provider}/${model}`;
}

function accountKey(provider: string): string {
  return `${provider}/*`;
}

function load(path: string): EligibilityStore {
  if (_store && _path === path) return _store;
  _path = path;
  try {
    const parsed = JSON.parse(readFileSync(path, "utf8")) as Partial<EligibilityStore>;
    if (parsed && typeof parsed === "object" && parsed.observations && typeof parsed.observations === "object") {
      _store = { version: 1, observations: parsed.observations as Record<string, Observation> };
      return _store;
    }
  } catch {
    // Unreadable or corrupt: start clean. Everything here is a re-learnable optimization — the
    // worst consequence of losing the file is one wasted round-trip per deployment.
  }
  _store = { version: 1, observations: {} };
  return _store;
}

function persist(path: string): void {
  if (!_store) return;
  try {
    mkdirSync(join(path, ".."), { recursive: true });
    const tmp = `${path}.${process.pid}.tmp`;
    writeFileSync(tmp, JSON.stringify(_store, null, 2) + "\n", "utf8");
    renameSync(tmp, path);
  } catch {
    // Same contract as every other store here: a full disk is a storage problem, never a request
    // failure. The observation stays in memory for this process's lifetime.
  }
}

/**
 * Record what a deployment stated about itself. A fresh observation always replaces an older one:
 * the deployment is the authority, and one that changed its answer is telling us so.
 */
export function recordEligibility(
  provider: string,
  model: string,
  observation: { class: EligibilityClass; scope: EligibilityScope },
  opts: { path?: string; now?: number; retryAfterMs?: number | null } = {},
): void {
  const path = opts.path ?? defaultPath();
  const store = load(path);
  const now = opts.now ?? Date.now();
  const key = observation.scope === "account" ? accountKey(provider) : deploymentKey(provider, model);
  const stated = typeof opts.retryAfterMs === "number" && opts.retryAfterMs > 0 ? opts.retryAfterMs : null;
  store.observations[key] = {
    class: observation.class,
    scope: observation.scope,
    at: now,
    // A vendor-stated reset beats our TTL, exactly as it does for the breaker's cooldown: the
    // provider knows when its own allowance refreshes and we are guessing.
    ...(stated !== null ? { until: now + stated } : {}),
  };
  writer.touch(() => persist(path));
}

/** The live observation covering a deployment (its own, else its provider's), or null. */
export function observedEligibility(
  provider: string,
  model: string | null | undefined,
  opts: { path?: string; now?: number } = {},
): { class: EligibilityClass; scope: EligibilityScope } | null {
  const path = opts.path ?? defaultPath();
  const store = load(path);
  const now = opts.now ?? Date.now();
  const keys = typeof model === "string" ? [deploymentKey(provider, model), accountKey(provider)] : [accountKey(provider)];
  for (const key of keys) {
    const hit = store.observations[key];
    if (!hit) continue;
    const expiry = hit.until ?? hit.at + (ELIGIBILITY_TTL_MS[hit.class] ?? 0);
    if (now >= expiry) continue;
    return { class: hit.class, scope: hit.scope };
  }
  return null;
}

/**
 * Has this deployment been PROVEN unfit for a free pool?
 *
 * ⚠ True only for `not-servable` and `subscription-required`. `allowance-exhausted` is
 * deliberately absent and must stay absent — see the file header. A spent allowance says nothing
 * about what the deployment costs, and evicting it from the pool would outlive the exhaustion that
 * caused it.
 */
export function isCostBlocked(
  provider: string,
  model: string | null | undefined,
  opts: { path?: string; now?: number } = {},
): boolean {
  const hit = observedEligibility(provider, model, opts);
  return hit !== null && hit.class !== "allowance-exhausted";
}

/**
 * When a temporarily-unavailable deployment is worth trying again, or null when nothing is cooling
 * it. Only `allowance-exhausted` produces a cooldown — the other two classes are not cooling, they
 * are excluded, and a caller that wants those wants `isCostBlocked`.
 */
export function cooldownUntil(
  provider: string,
  model: string | null | undefined,
  opts: { path?: string; now?: number } = {},
): number | null {
  const path = opts.path ?? defaultPath();
  const store = load(path);
  const now = opts.now ?? Date.now();
  const keys = typeof model === "string" ? [deploymentKey(provider, model), accountKey(provider)] : [accountKey(provider)];
  for (const key of keys) {
    const hit = store.observations[key];
    if (!hit || hit.class !== "allowance-exhausted") continue;
    const expiry = hit.until ?? hit.at + ELIGIBILITY_TTL_MS[hit.class];
    if (now < expiry) return expiry;
  }
  return null;
}

/**
 * A success clears what the deployment previously refused — including its ACCOUNT record.
 *
 * A served request is first-party proof that the credential has allowance right now, which is a
 * strictly better signal than an hour-old 402 and covers the case that matters most: credits
 * topped up, or the month rolled over, well before the TTL would have expired. Same contract as
 * the breaker clearing a credential fault on success.
 */
export function clearEligibility(provider: string, model: string | null | undefined, opts: { path?: string } = {}): void {
  const path = opts.path ?? defaultPath();
  const store = load(path);
  let changed = false;
  for (const key of typeof model === "string" ? [deploymentKey(provider, model), accountKey(provider)] : [accountKey(provider)]) {
    if (store.observations[key]) {
      delete store.observations[key];
      changed = true;
    }
  }
  if (changed) writer.touch(() => persist(path));
}

/** Every live observation, for `llm-relay eligibility`. Expired entries are omitted, not reported. */
export function allObservations(
  opts: { path?: string; now?: number } = {},
): Array<{ key: string; class: EligibilityClass; scope: EligibilityScope; at: number; until: number }> {
  const store = load(opts.path ?? defaultPath());
  const now = opts.now ?? Date.now();
  const out: Array<{ key: string; class: EligibilityClass; scope: EligibilityScope; at: number; until: number }> = [];
  for (const [key, hit] of Object.entries(store.observations)) {
    const until = hit.until ?? hit.at + (ELIGIBILITY_TTL_MS[hit.class] ?? 0);
    if (now >= until) continue;
    out.push({ key, class: hit.class, scope: hit.scope, at: hit.at, until });
  }
  return out.sort((a, b) => b.at - a.at);
}

/** Flush pending observations. Called on shutdown, like the other write-behind stores. */
export function flushEligibility(opts: { path?: string } = {}): void {
  if (!writer.dirty) return;
  writer.clear();
  persist(opts.path ?? defaultPath());
}

/** Test seam: drop the in-memory store so a suite can point at a fresh path. */
export function resetEligibility(): void {
  _store = null;
  _path = null;
  writer.clear();
}
