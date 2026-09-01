/**
 * Stated Context and Max-Output Limits Subsystem.
 *
 * Charter & Invariants:
 *  - Observed vs Catalog Precedence: First-party ceilings explicitly stated in refusal error
 *    bodies take precedence over catalog/snapshot figures because they represent actual
 *    deployment-specific limits rather than generic model family estimates.
 *  - Explicit Extraction Only: Never guess or record requested token counts as ceilings. If parsing
 *    cannot extract an explicit maximum from the error body, nothing is learned.
 *  - Deployment-Scoped Persistence: Ceilings are persisted in target-facts as deployment-scoped
 *    facts (provider:model) with TTL expiration.
 *  - Asymmetric Reset Invariance: Learned limits are measurements, not temporary conditions.
 *    Subsequent successful requests do not clear or invalidate recorded context limits.
 *  - Output-Limit Display-Only: Observed max-output limits are strictly display-only metadata
 *    and never actively clamp, reject, or alter routing decisions.
 */
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
 *
 * The OUTPUT-token sibling lives here too (the `max-output` half below): a deployment that
 * rejects an over-sized `max_tokens` often states its real output ceiling in the same kind of
 * error body, under the same discipline.
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

// ── Max-output ceilings — the OUTPUT-token sibling of the context parser above ─────────────────
//
// The groq case that motivated this half: 13 requests answered 400 with "`max_tokens` must be
// less than or equal to `8192`…" and no store could hold the stated value, so the failure
// repeated on every walk that landed there. Same store, same TTL convention, same fail-safe:
// only an EXPLICITLY stated maximum is recorded, a miss learns nothing, and the fact is
// DISPLAY-ONLY — nothing clamps, refuses or routes on it
// (docs/max-output-caps-design-2026-08-29.md).

/** Retained for callers and docs that name the output ceiling's staleness window (30 days). */
export const OBSERVED_MAX_OUTPUT_TTL_MS = FACT_TTL_MS["max-output"];

/**
 * Patterns that carry an explicitly stated `max_tokens` ceiling. Every pattern must capture the
 * MAXIMUM, never the requested count — same rule as `STATED_LIMIT_PATTERNS`, for the same reason:
 * the requested number is the larger one, and persisting it would overstate the real ceiling.
 */
const STATED_MAX_OUTPUT_PATTERNS: RegExp[] = [
  // Groq: "`max_tokens` must be less than or equal to `8192`, the maximum value for `max_tokens`
  // is less than the `context_window` for this model" — the ceiling is the number after the
  // comparator, and the tail clause carries no number at all. Also TGI's "`max_new_tokens` must
  // be <= 4096".
  /max_(?:completion_|output_|new_)?tokens`?\s*must be (?:less than or equal to|<=)\s*`?(\d[\d,_]*)/i,
  // OpenAI: "max_tokens is too large: 40000. This model supports at most 16384 completion tokens."
  /supports?\s+at most\s+(\d[\d,_]*)\s+(?:completion|output)\s+tokens/i,
  // Anthropic-style: "max_tokens: 40000 > 8192, which is the maximum allowed number of output
  // tokens…" — anchored to the maximum wording, so a bare comparison never matches. Two fixed
  // terminator forms rather than one optional-comma alternation: the gap class excludes ">" and
  // each terminator starts unambiguously, which keeps the scan linear.
  /max_tokens[^.\n>]{0,24}>\s*(\d[\d,_]*)\s+maximum\b/i,
  /max_tokens[^.\n>]{0,24}>\s*(\d[\d,_]*),\s*which is the maximum/i,
  // OpenAI-compatible front-ends that restate the field: "the maximum value for max_tokens is 8192".
  /maximum value for\s+`?max_(?:completion_|output_|new_)?tokens`?\s*(?:is|:)\s*`?(\d[\d,_]*)/i,
];

/**
 * Extract a stated output-token ceiling from an error body, or null.
 *
 * Returns null for anything it cannot read as an explicit maximum — "max_tokens is too large"
 * alone proves the request overshot but states no ceiling. Same fail-safe as
 * `parseStatedContextLimit`: if nothing parses, nothing is learned.
 */
export function parseStatedMaxOutput(body: string): number | null {
  if (typeof body !== "string" || body.length === 0) return null;
  // Bodies are small; this bound only stops a pathological one from driving the regex engine.
  const text = body.length > 8192 ? body.slice(0, 8192) : body;
  for (const re of STATED_MAX_OUTPUT_PATTERNS) {
    const m = re.exec(text);
    if (!m?.[1]) continue;
    const n = Number(m[1].replace(/[,_]/g, ""));
    if (Number.isFinite(n) && n > 0 && n <= MAX_CREDIBLE_TOKENS) return Math.floor(n);
  }
  return null;
}

/** Does this error body describe a `max_tokens` / output-cap rejection at all? */
export function looksLikeMaxOutputError(body: string): boolean {
  return /max_(?:completion_|output_|new_)?tokens|(?:completion|output)\s+tokens/i.test(body);
}

/**
 * Record an output ceiling a deployment stated about itself. Deployment scope — the message names
 * the model, never the account. A fresh observation replaces an older one, same as the context
 * half: the deployment is the authority on its own ceiling.
 */
export function recordObservedMaxOutput(
  provider: string,
  model: string,
  tokens: number,
  opts: { path?: string; now?: number } = {},
): void {
  if (!Number.isFinite(tokens) || tokens <= 0 || tokens > MAX_CREDIBLE_TOKENS) return;
  recordFact("max-output", { kind: "deployment", provider, model }, {
    ...(opts.path !== undefined ? { path: opts.path } : {}),
    ...(opts.now !== undefined ? { now: opts.now } : {}),
    value: Math.floor(tokens),
  });
}

/** The learned output ceiling for a deployment, or null when none was observed or it expired. */
export function observedMaxOutput(
  provider: string,
  model: string,
  opts: { path?: string; now?: number } = {},
): number | null {
  // Output ceilings are deployment-scoped measurements, not credential-scoped facts.
  for (const fact of factsFor(provider, null, model, opts)) {
    if (fact.kind === "max-output" && typeof fact.value === "number") return fact.value;
  }
  return null;
}

/** Flush pending observations — BOTH halves; the store is shared. Called on shutdown. */
export function flushObservedContextLimits(opts: { path?: string } = {}): void {
  flushFacts(opts);
}

/** Test seam: drop the in-memory store so a suite can point at a fresh path. */
export function resetObservedContextLimits(): void {
  resetFacts();
}
