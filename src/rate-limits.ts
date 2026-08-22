import { recordFact, factsFor, flushFacts, resetFacts, FACT_TTL_MS, type FactKind } from "./target-facts.js";
import type { CredentialId } from "./credential-id.js";

/**
 * Rate limits LEARNED from what a deployment STATED about itself — the sibling of
 * `context-limits.ts`, feeding the same `target-facts.ts` store.
 *
 * Spec §4 Rung 1 (docs/quota-metering-spec-2026-08-16.md): a stated rate limit is a MEASUREMENT,
 * not a condition. It lands as one of four kinds — `rate-limit-rpm|rpd|tpm|tpd`, one kind per
 * axis×period so the compiler forces a TTL decision per bucket — and unlike the five conditions
 * it is never cleared by a success, never cools, never cost-blocks. It expires on its own TTL.
 * Today it is DISPLAY-ONLY (see `/candidates`); acting on it is a separately announced decision
 * (spec open decision M2).
 *
 * ⚠ **Only an explicitly STATED limit is recorded, and only with a confidently identified axis
 * AND period.** "You sent 120 requests in the last minute" states a count, not a ceiling. "Rate
 * limit exceeded" proves throttling but states no number. Either would put a guess into the one
 * store whose whole value is that it holds measurements, so a miss learns NOTHING — the same
 * fail-safe as the context parser. Unknown stays null, never 0.
 */

/** Retained for callers and docs that name the measurement's staleness window (30 days). */
export const OBSERVED_RATE_LIMIT_TTL_MS = FACT_TTL_MS["rate-limit-rpm"];

export type RateAxis = "requests" | "tokens";
export type RatePeriod = "minute" | "day";

/** A ceiling a backend stated about itself, with the axis and period it named. */
export type StatedRateLimit = {
  axis: RateAxis;
  period: RatePeriod;
  limit: number;
  /**
   * The statement named the ACCOUNT/KEY/ORGANIZATION as its subject ("this API key allows…",
   * "your organization's rate limit of…"). Only then may the fact widen from attempt scope (this
   * credential × this model) to credential scope (every model on this key) — scope comes from
   * evidence in the wording, never from counting how many models happened to trip.
   */
  accountWording?: true;
};

/** Plausibility caps: outside these a hit is a parse artifact, not a published limit. */
const MAX_CREDIBLE_REQUESTS = 1_000_000;
const MAX_CREDIBLE_TOKENS = 100_000_000;

function credible(axis: RateAxis, n: number): boolean {
  const cap = axis === "requests" ? MAX_CREDIBLE_REQUESTS : MAX_CREDIBLE_TOKENS;
  return Number.isFinite(n) && n > 0 && n <= cap;
}

/**
 * FAMILY A — the unit phrase IS the statement, so the number beside it is the limit; no "limit"
 * wording required. Each row names its axis and period in code, so nothing is ever inferred from
 * prose. The token/request keyword lists are pairwise disjoint and the minute/day lists likewise,
 * which delivers the spec's "match day before minute, tokens before requests" intent structurally:
 * no pattern can be shadowed by another reading of the same words.
 */
const DIRECT_PATTERNS: ReadonlyArray<{ re: RegExp; axis: RateAxis; period: RatePeriod }> = [
  // "limit: 60 requests per minute" · "…exceed your organization's rate limit of 55,000 input
  // tokens per minute…" (the optional adjective is load-bearing — Anthropic's real wording).
  { re: /(\d[\d,_]*)\s*(?:requests?|calls?|messages?)\s*per[-\s]?(?:minutes?|mins?)\b/i, axis: "requests", period: "minute" },
  { re: /(\d[\d,_]*)\s*(?:requests?|calls?|messages?)\s*per[-\s]?days?\b/i, axis: "requests", period: "day" },
  { re: /(\d[\d,_]*)\s*(?:input\s+|output\s+|prompt\s+|completion\s+|text\s+)?tokens?\s*per[-\s]?(?:minutes?|mins?)\b/i, axis: "tokens", period: "minute" },
  { re: /(\d[\d,_]*)\s*(?:input\s+|output\s+|prompt\s+|completion\s+|text\s+)?tokens?\s*per[-\s]?days?\b/i, axis: "tokens", period: "day" },
  // "6000 tokens/min" · "1000 requests/day"
  { re: /(\d[\d,_]*)\s*tokens?\s*\/\s*(?:minutes?|mins?)\b/i, axis: "tokens", period: "minute" },
  { re: /(\d[\d,_]*)\s*tokens?\s*\/\s*days?\b/i, axis: "tokens", period: "day" },
  { re: /(\d[\d,_]*)\s*requests?\s*\/\s*(?:minutes?|mins?)\b/i, axis: "requests", period: "minute" },
  { re: /(\d[\d,_]*)\s*requests?\s*\/\s*days?\b/i, axis: "requests", period: "day" },
];

/**
 * FAMILY B — the acronyms. Kept TIGHT deliberately: a bare gap (`RPM\D{0,8}`) reads the next
 * number whatever it belongs to, and a 429 body routinely carries a retry seconds figure right
 * after the prose. So the number must be attached by a copula/colon or the word "limit" —
 * "TPM: 6000" · "60 RPM" · "TPM is 6000" · Groq's "(TPM): Limit 6000, Used 0, Requested 5000".
 */
const ACRONYM_AFTER: ReadonlyArray<{ re: RegExp; axis: RateAxis; period: RatePeriod }> = [
  { re: /\bRPM\b\s*(?:is|of|:|=)\s*(?:about\s+|up\s+to\s+)?(\d[\d,_]*)/i, axis: "requests", period: "minute" },
  { re: /\bRPD\b\s*(?:is|of|:|=)\s*(?:about\s+|up\s+to\s+)?(\d[\d,_]*)/i, axis: "requests", period: "day" },
  { re: /\bTPM\b\s*(?:is|of|:|=)\s*(?:about\s+|up\s+to\s+)?(\d[\d,_]*)/i, axis: "tokens", period: "minute" },
  { re: /\bTPD\b\s*(?:is|of|:|=)\s*(?:about\s+|up\s+to\s+)?(\d[\d,_]*)/i, axis: "tokens", period: "day" },
  { re: /\bRPM\b\D{0,12}?\blimits?\b\D{0,8}?(\d[\d,_]*)/i, axis: "requests", period: "minute" },
  { re: /\bRPD\b\D{0,12}?\blimits?\b\D{0,8}?(\d[\d,_]*)/i, axis: "requests", period: "day" },
  { re: /\bTPM\b\D{0,12}?\blimits?\b\D{0,8}?(\d[\d,_]*)/i, axis: "tokens", period: "minute" },
  { re: /\bTPD\b\D{0,12}?\blimits?\b\D{0,8}?(\d[\d,_]*)/i, axis: "tokens", period: "day" },
];
/** Number BEFORE the acronym: "6000 TPM" · "60 RPM". */
const ACRONYM_BEFORE: ReadonlyArray<{ re: RegExp; axis: RateAxis; period: RatePeriod }> = [
  { re: /(\d[\d,_]*)\s*RPM\b/i, axis: "requests", period: "minute" },
  { re: /(\d[\d,_]*)\s*RPD\b/i, axis: "requests", period: "day" },
  { re: /(\d[\d,_]*)\s*TPM\b/i, axis: "tokens", period: "minute" },
  { re: /(\d[\d,_]*)\s*TPD\b/i, axis: "tokens", period: "day" },
];

/**
 * Phrase FIRST, number after a short copula: "Requests per day: 10000" · "tokens per min
 * (TPM): Limit 6000". The gap may not contain a digit or a sentence boundary — a lazy gap that
 * stops at the first digit reads the attached number and nothing further.
 */
const PHRASE_FIRST: ReadonlyArray<{ re: RegExp; axis: RateAxis; period: RatePeriod }> = [
  { re: /\btokens?\s*per[-\s]?(?:minutes?|mins?)\b[^.\n\d]{0,12}?(\d[\d,_]*)/i, axis: "tokens", period: "minute" },
  { re: /\btokens?\s*per[-\s]?days?\b[^.\n\d]{0,12}?(\d[\d,_]*)/i, axis: "tokens", period: "day" },
  { re: /\b(?:requests?|messages?)\s*per[-\s]?(?:minutes?|mins?)\b[^.\n\d]{0,12}?(\d[\d,_]*)/i, axis: "requests", period: "minute" },
  { re: /\b(?:requests?|messages?)\s*per[-\s]?days?\b[^.\n\d]{0,12}?(\d[\d,_]*)/i, axis: "requests", period: "day" },
];

/**
 * FAMILY C — the anchored shape, for when the number and the unit phrase are far apart:
 * "Daily limit is 1000000" · "the cap: 40 requests every minute". An anchor hit becomes a fact
 * only if the surrounding window names EXACTLY ONE axis keyword and EXACTLY ONE period keyword;
 * zero or two of either drops the hit. That gate is what makes the loose shape safe: "rate limit
 * exceeded in 30 requests" finds no period and learns nothing, and a window straddling two
 * clauses learns nothing rather than guessing which number belongs to which phrase.
 */
const LIMIT_ANCHOR = /\b(?:limits?|max(?:imum)?|quota|allowance|cap)\b[^.\n]{0,24}?(\d[\d,_]*)/gi;
const AXIS_KEYWORDS: ReadonlyArray<{ re: RegExp; axis: RateAxis }> = [
  { re: /\btokens?\b|\bTP[MD]\b|TOKENS?_PER_/i, axis: "tokens" },
  { re: /\brequests?\b|\bRP[MD]\b|REQUESTS?_PER_/i, axis: "requests" },
];
const PERIOD_KEYWORDS: ReadonlyArray<{ re: RegExp; period: RatePeriod }> = [
  { re: /\bper[-\s]?(?:minutes?|mins?)\b|\bevery[-\s]?(?:minutes?|mins?)\b|\bminutely\b|\bTPM\b|\bRPM\b|\bTOKENS?_PER_MIN\b|\bREQUESTS?_PER_MIN\b|\b\/\s*(?:minutes?|mins?)\b/i, period: "minute" },
  { re: /\bper[-\s]?days?\b|\bevery[-\s]?days?\b|\bdaily\b|\bTPD\b|\bRPD\b|\bTOKENS?_PER_DAY\b|\bREQUESTS?_PER_DAY\b|\b\/\s*days?\b/i, period: "day" },
];
/** Wording that makes the ACCOUNT/KEY/ORGANIZATION the subject, licensing credential scope. */
const ACCOUNT_WORDING = /\b(?:(?:this|your|the|each|per)[-\s]+(?:api[-\s]+)?keys?\b|keys?\s+allows?\b|your\s+accounts?\b|(?:accounts?|organizations?|projects?)['’]?s?\s+(?:rate[-\s]+)?limits?\b|organizations?[-\s]wide\b|projects?[-\s]wide\b|applied\s+per\s+keys?\b)/i;

/**
 * Does the statement at `index` name the ACCOUNT/KEY/ORGANIZATION as its subject? Read from a
 * bounded window around the number — local evidence, not a whole-body scan, so an unrelated
 * sentence about the account cannot widen an unrelated limit.
 */
function accountSubject(text: string, index: number): boolean {
  return ACCOUNT_WORDING.test(text.slice(Math.max(0, index - 80), index + 40));
}

function uniqueAxis(text: string): RateAxis | null {
  const hits = AXIS_KEYWORDS.filter((k) => k.re.test(text));
  return hits.length === 1 ? hits[0]!.axis : null;
}
function uniquePeriod(text: string): RatePeriod | null {
  const hits = PERIOD_KEYWORDS.filter((k) => k.re.test(text));
  return hits.length === 1 ? hits[0]!.period : null;
}

function parseNumber(raw: string): number {
  return Number(raw.replace(/[,_]/g, ""));
}

/**
 * A number a USAGE VERB claims is what the client sent is a count, not a ceiling — "you used 120
 * tokens per minute" states consumption, and persisting it would store a figure that grows with
 * traffic and call it a measurement. Reads only the characters immediately before the match, so
 * "limit of 60…" is untouched while "you used 120…" is dropped. A miss here learns nothing, which
 * is the fail-safe direction.
 */
const USAGE_VERB =
  /\b(?:used|sent|made|consumed|requested|submitted|processed|handled|served|tried|issued|completed|performed|generated|burned|spent|billed|counted|logged|received)\s+$/i;

function usageCount(text: string, index: number): boolean {
  return USAGE_VERB.test(text.slice(Math.max(0, index - 32), index));
}

/**
 * Extract every stated rate ceiling from a response body, or null when none is stated.
 *
 * A body naming several ceilings (an RPM clause and a TPM clause side by side) yields EACH, one
 * per axis×period bucket; two readings of the SAME bucket collapse to the first stated. Returns
 * null — never an empty array and never a guess — when nothing qualifies.
 */
export function parseStatedRateLimit(body: string): StatedRateLimit[] | null {
  if (typeof body !== "string" || body.length === 0) return null;
  // Bodies are small; this bound only stops a pathological one from driving the regex engine.
  const text = body.length > 8192 ? body.slice(0, 8192) : body;

  const found = new Map<string, StatedRateLimit>();
  const admit = (hit: StatedRateLimit): void => {
    if (!credible(hit.axis, hit.limit)) return;
    const key = `${hit.axis}:${hit.period}`;
    if (!found.has(key)) found.set(key, hit);
  };

  for (const { re, axis, period } of [...DIRECT_PATTERNS, ...PHRASE_FIRST, ...ACRONYM_AFTER, ...ACRONYM_BEFORE]) {
    const m = re.exec(text);
    if (!m?.[1]) continue;
    if (usageCount(text, m.index)) continue; // a stated count of what was SENT is not a ceiling
    admit({
      axis,
      period,
      limit: Math.floor(parseNumber(m[1])),
      ...(accountSubject(text, m.index) ? { accountWording: true as const } : {}),
    });
  }

  LIMIT_ANCHOR.lastIndex = 0;
  for (let m = LIMIT_ANCHOR.exec(text); m !== null; m = LIMIT_ANCHOR.exec(text)) {
    // A bounded window either side of the anchor: enough to carry its unit phrase, small enough
    // that it usually cannot reach a neighbouring clause.
    const start = Math.max(0, m.index - 56);
    const window = text.slice(start, m.index + m[0].length + 20);
    const winAxis = uniqueAxis(window);
    const winPeriod = uniquePeriod(window);
    if (winAxis === null || winPeriod === null || !m[1]) continue;
    admit({
      axis: winAxis,
      period: winPeriod,
      limit: Math.floor(parseNumber(m[1])),
      ...(ACCOUNT_WORDING.test(window) ? { accountWording: true as const } : {}),
    });
  }

  return found.size === 0 ? null : [...found.values()];
}

/** Cheap pre-filter for callers that want to skip parsing on bodies that cannot state a limit. */
export function looksLikeRateLimitError(body: string): boolean {
  return /rate[-\s]?limit|too many requests|\b(?:rp[md]|tp[md])\b|quota|credits?/i.test(body);
}

// ── Mapping between axis×period and the four measurement kinds ─────────────────────────────────

const KIND_BY_BUCKET: Record<`${RateAxis}:${RatePeriod}`, FactKind> = {
  "requests:minute": "rate-limit-rpm",
  "requests:day": "rate-limit-rpd",
  "tokens:minute": "rate-limit-tpm",
  "tokens:day": "rate-limit-tpd",
};
const BUCKET_BY_KIND: ReadonlyMap<FactKind, Pick<StatedRateLimit, "axis" | "period">> = new Map([
  ["rate-limit-rpm", { axis: "requests", period: "minute" }],
  ["rate-limit-rpd", { axis: "requests", period: "day" }],
  ["rate-limit-tpm", { axis: "tokens", period: "minute" }],
  ["rate-limit-tpd", { axis: "tokens", period: "day" }],
]) satisfies Map<FactKind, Pick<StatedRateLimit, "axis" | "period">>;

/** `requests`+`day` → `rate-limit-rpd`, and so on for the four measurement kinds. */
export function rateLimitFactKind(limit: Pick<StatedRateLimit, "axis" | "period">): FactKind {
  return KIND_BY_BUCKET[`${limit.axis}:${limit.period}`];
}

/** The inverse of {@link rateLimitFactKind}; null for every kind that is not a rate measurement. */
export function rateLimitAxisOf(kind: FactKind): Pick<StatedRateLimit, "axis" | "period"> | null {
  return BUCKET_BY_KIND.get(kind) ?? null;
}

// ── Record / read ──────────────────────────────────────────────────────────────────────────────

/**
 * Record ceilings a deployment stated about itself.
 *
 * Scope follows the evidence, never a heuristic: attempt scope (this credential × this model)
 * when the credential is known, deployment scope when it is not, and credential scope (every
 * model on this key) ONLY when the statement itself named the account/key/organization as its
 * subject. It never widens by counting sibling models — that inference is exactly what produced
 * false "your key is broken" verdicts elsewhere, and it is refused here too.
 */
export function recordObservedRateLimit(
  provider: string,
  credentialId: CredentialId | null,
  model: string,
  stated: StatedRateLimit | StatedRateLimit[],
  opts: { path?: string; now?: number } = {},
): void {
  const entries = Array.isArray(stated) ? stated : [stated];
  for (const entry of entries) {
    if (!credible(entry.axis, entry.limit)) continue;
    const kind = rateLimitFactKind(entry);
    const scope = entry.accountWording === true && credentialId !== null
      ? { kind: "credential" as const, provider, credentialId }
      : credentialId !== null
        ? { kind: "attempt" as const, provider, credentialId, model }
        : { kind: "deployment" as const, provider, model };
    recordFact(kind, scope, {
      ...(opts.path !== undefined ? { path: opts.path } : {}),
      ...(opts.now !== undefined ? { now: opts.now } : {}),
      value: entry.limit,
    });
  }
}

/**
 * The learned limits covering this cell, MOST-SPECIFIC-FIRST (attempt → credential → deployment),
 * each labelled `learned`. Display-only today; a caller that wants to ACT on one must announce
 * that separately (spec M2).
 */
export function observedRateLimits(
  provider: string,
  credentialId: CredentialId | null,
  model: string,
  opts: { path?: string; now?: number } = {},
): Array<{ axis: RateAxis; period: RatePeriod; limit: number; basis: "learned"; until: number }> {
  const out: Array<{ axis: RateAxis; period: RatePeriod; limit: number; basis: "learned"; until: number }> = [];
  for (const fact of factsFor(provider, credentialId, model, opts)) {
    const mapped = rateLimitAxisOf(fact.kind);
    if (!mapped || typeof fact.value !== "number") continue;
    out.push({ ...mapped, limit: fact.value, basis: "learned", until: fact.until });
  }
  return out;
}

/** Flush pending observations. Called on shutdown, like the other write-behind stores. */
export function flushObservedRateLimits(opts: { path?: string } = {}): void {
  flushFacts(opts);
}

/** Test seam: drop the in-memory store so a suite can point at a fresh path. */
export function resetObservedRateLimits(): void {
  resetFacts();
}
