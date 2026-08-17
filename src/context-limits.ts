import { factsFor, flushFacts, recordFact, resetFacts, FACT_TTL_MS } from "./target-facts.js";

/**
 * Context limits LEARNED from what a deployment actually said when it refused a request.
 *
 * The catalog can only report what a provider publishes in `/models`, and most of the free
 * providers this proxy fronts publish nothing at all. But a deployment that rejects an
 * over-length request usually states its real ceiling in the error message — a first-party fact
 * about the exact deployment that will serve the next request, and therefore *better* evidence
 * than a published catalogue figure, which can be generic or stale.
 *
 * ⚠ **Only an explicitly STATED maximum is recorded.** "We sent an estimated N tokens and it was
 * rejected" is not a limit — it is an upper bound on a number this proxy estimated at four
 * characters per token, and persisting it would put a guess into the one store whose whole value
 * is that it contains measurements. If nothing parses, nothing is learned. Same rule as
 * `resolveMetadata`: no rung may be a guess.
 */

/**
 * ⚠ **The storage moved; the PARSING is what this module is.** Ceilings now live in
 * `target-facts.ts` as a `context-limit` fact at deployment scope, so scope and keying are decided
 * in one place rather than reinvented per store. What stays here is the part that is genuinely
 * specific to what it reads: knowing which error bodies state a maximum, and extracting it without
 * ever mistaking the REQUESTED count for the ceiling.
 *
 * A context limit is a MEASUREMENT, not a condition, which is why the shared store refuses to let
 * a success clear it — a normally-sized request succeeding says nothing about the ceiling.
 */

/** Retained for callers and docs that name the ceiling's staleness window. */
export const OBSERVED_LIMIT_TTL_MS = FACT_TTL_MS["context-limit"];

/** A stated ceiling above this is a parse artifact, not a context window. */
const MAX_CREDIBLE_TOKENS = 100_000_000;

/**
 * Patterns that carry an explicitly stated ceiling. Deliberately a small, literal set rather than
 * anything clever: a loose pattern that captured the *requested* count instead of the *maximum*
 * would persist a number larger than the real ceiling and cause exactly the overflow this exists
 * to prevent. Every pattern below must capture the MAXIMUM.
 */
const STATED_LIMIT_PATTERNS: RegExp[] = [
  // OpenAI-style: "This model's maximum context length is 8192 tokens. However, you requested …"
  /maximum context length is\s+(\d[\d,_]*)\s*tokens/i,
  // Anthropic-style: "prompt is too long: 250000 tokens > 200000 maximum"
  /tokens\s*>\s*(\d[\d,_]*)\s*maximum/i,
  // Common variants seen across OpenAI-compatible servers (vLLM, TGI, NIM front-ends).
  /maximum\s+(?:input\s+|prompt\s+)?(?:context|length|tokens)\D{0,24}?(\d[\d,_]*)/i,
  /context\s+(?:window|length)\s+(?:of|is)\s+(\d[\d,_]*)/i,
  /reduce\s+(?:the\s+)?length[^.]*?(?:max(?:imum)?|limit)\D{0,16}(\d[\d,_]*)/i,
];

/**
 * Extract a stated context ceiling from an error body, or null.
 *
 * Returns null for anything it cannot read as an explicit maximum — including a body that merely
 * proves the request was too long. See the file header for why that asymmetry is deliberate.
 */
export function parseStatedContextLimit(body: string): number | null {
  if (typeof body !== "string" || body.length === 0) return null;
  // Bodies are small; this bound only stops a pathological one from driving the regex engine.
  const text = body.length > 8192 ? body.slice(0, 8192) : body;
  for (const re of STATED_LIMIT_PATTERNS) {
    const m = re.exec(text);
    if (!m?.[1]) continue;
    const n = Number(m[1].replace(/[,_]/g, ""));
    if (Number.isFinite(n) && n > 0 && n <= MAX_CREDIBLE_TOKENS) return Math.floor(n);
  }
  return null;
}

/** Does this error body describe a context-length rejection at all? */
export function looksLikeContextLengthError(body: string): boolean {
  return /context (?:length|window)|too long|maximum.*tokens|token.*limit exceeded/i.test(body);
}

/**
 * Record a ceiling a deployment stated about itself. A fresh observation always replaces an older
 * one: the deployment is the authority on its own ceiling, and a provider that raised or lowered
 * it is telling us so.
 */
export function recordObservedContextLimit(
  provider: string,
  model: string,
  tokens: number,
  opts: { path?: string; now?: number } = {},
): void {
  if (!Number.isFinite(tokens) || tokens <= 0 || tokens > MAX_CREDIBLE_TOKENS) return;
  recordFact("context-limit", { kind: "deployment", provider, model }, {
    ...(opts.path !== undefined ? { path: opts.path } : {}),
    ...(opts.now !== undefined ? { now: opts.now } : {}),
    value: Math.floor(tokens),
  });
}

/** The learned ceiling for a deployment, or null when none was observed or it has expired. */
export function observedContextLimit(
  provider: string,
  model: string,
  opts: { path?: string; now?: number } = {},
): number | null {
  // Context ceilings are deployment-scoped measurements, not credential-scoped facts.
  for (const fact of factsFor(provider, null, model, opts)) {
    if (fact.kind === "context-limit" && typeof fact.value === "number") return fact.value;
  }
  return null;
}

/** Flush pending observations. Called on shutdown, like the other write-behind stores. */
export function flushObservedContextLimits(opts: { path?: string } = {}): void {
  flushFacts(opts);
}

/** Test seam: drop the in-memory store so a suite can point at a fresh path. */
export function resetObservedContextLimits(): void {
  resetFacts();
}
