import { mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { hasExactKeys } from "./json-shape.js";
import { join } from "node:path";
import { homedir, tmpdir } from "node:os";
import { randomUUID } from "node:crypto";
import { WriteBehindTimer } from "./write-behind.js";
import type { CredentialId } from "./credential-id.js";
import { FACT_KINDS, type FactKind, type FactScope } from "./target-facts.js";

/**
 * What a backend's refusal MEANS — a lookup, never an inference, on the request path.
 *
 * The problem this solves: a refusal's status code does not carry its meaning. A 403 is at least
 * four different facts — a revoked key, a plan-gated model, a license-gated model, a policy
 * refusal — and only the message distinguishes them, in wording each vendor invents for itself.
 * A hand-written pattern set can only ever cover the messages its author happened to see; every
 * other refusal teaches nothing, forever, and is re-discovered on every single request.
 *
 * The shape, and the boundary it respects:
 *
 *   REQUEST PATH — deterministic lookup, and nothing else. A refusal is reduced to a SIGNATURE
 *   (provider + model + the message with its variable parts stripped) and looked up in the
 *   confirmed table. A hit applies. A miss learns NOTHING about the deployment — exactly the
 *   fail-safe that already governs `context-limits.ts` — and records the signature as unseen.
 *
 *   OUT OF BAND — judgement is allowed here and nowhere else. `llm-relay eligibility` surfaces
 *   unseen signatures with their samples; an agent researches what that message means for that
 *   provider, that model, this account; the verdict is written to the table and takes effect only
 *   once accepted.
 *
 * ⚠ **An LLM never decides a live routing decision here.** CLAUDE.md's repair boundary — "routing
 * decisions come from config and deterministic classification, never from an LLM's opinion
 * inserted into the request path" — is why the research tier is offline and why its output must be
 * accepted before it binds. The relationship is the same one `docs/tier-data.json` already has to
 * pool ranking: a model may author the data, the request path only ever reads it.
 *
 * ⚠ **Signatures are keyed per (provider, model, message).** The same provider sends different
 * wording for different models, and the same wording can mean different things for a model the
 * account has access to and one it does not. Keying on the message alone would let a verdict
 * researched for one SKU evict a sibling that works. A new model showing a known message is a
 * MISS until researched — conservative, which is the safe direction: the cost of a miss is one
 * wasted round-trip, the cost of a false hit is a working deployment evicted from every pool.
 */

/**
 * WHO a verdict applies to, expressed independently of the request that triggered it.
 *
 * An interpretation is stored against a message signature, but the fact it produces is about
 * targets — so the stored form is a TEMPLATE, materialized into a concrete `FactScope` with the
 * provider and model of whatever request hit it. That indirection is what lets one entry mean
 * "this message always states an account-level condition" without naming an account.
 *
 * ⚠ **A group carries its own membership.** There is no group registry and no prefix inference:
 * the reviewer sees the exact list of models a group verdict will cover before accepting it.
 * Inferring a family from id shape is the heuristic `authEnv.ts` refuses — a wrong match there
 * ships a credential to the wrong host, and a wrong match here evicts a working family.
 */
export type ScopeTemplate =
  | { kind: "attempt" }
  | { kind: "deployment" }
  | { kind: "credential" }
  | { kind: "provider" }
  | { kind: "model" }
  | { kind: "group"; members: string[]; credential: "attempt" | "all" };

/** Turn a stored template into the concrete scope for the request that matched it. */
export function materializeScope(
  template: ScopeTemplate,
  provider: string,
  credentialId: CredentialId,
  model: string,
): FactScope {
  switch (template.kind) {
    case "attempt":
      return { kind: "attempt", provider, credentialId, model };
    case "deployment":
      return { kind: "deployment", provider, model };
    case "credential":
      return { kind: "credential", provider, credentialId };
    case "provider":
      return { kind: "provider", provider };
    case "model":
      return { kind: "model", model };
    case "group":
      // The triggering model is always included: it demonstrably exhibits the fact, and a group
      // verdict that excluded its own evidence would be incoherent.
      return {
        kind: "group",
        provider,
        ...(template.credential === "attempt" ? { credentialId } : {}),
        members: template.members.includes(model) ? template.members : [...template.members, model],
      };
  }
}

/**
 * WHEN the condition this message describes clears — the third thing a reviewer knows and the
 * table could not previously hold.
 *
 * Without this, learning "Gemini's quota message means allowance-exhausted" left the *duration*
 * unlearnable, so the relay fell back to the kind's default TTL and re-probed on a schedule it
 * invented. The reviewer usually knows better than the default: they can see whether the message
 * carries a reset, and where.
 *
 *   field — the reset is IN this message, under a named JSON key (Google's RetryInfo puts it in
 *           `retryDelay`). Deterministic extraction from the actual response, so it stays a
 *           measurement rather than a claim. Preferred whenever the provider states it.
 *   fixed — the provider never states it, but the window is known (a daily quota, a 5-hourly
 *           grant). This IS a reviewer's assertion rather than a measurement, which is why it
 *           ranks below anything the response itself says and why any success clears it.
 *
 * ⚠ A field NAME, never a pattern. An LLM-authored regex would run on the request path against
 * attacker-influenceable text — the one place this design refuses to put judgement.
 */
export type ResetRule =
  | { kind: "field"; field: string }
  | { kind: "fixed"; ms: number };

/** A refusal interpretation, however it got here. */
export interface Interpretation {
  class: FactKind;
  scope: ScopeTemplate;
  /** How long until it clears, when the reviewer could determine that. Optional. */
  reset?: ResetRule;
  /**
   * `seed`       — shipped in this file, derived from first-party probes and reviewable in source.
   *                Binds immediately: it is deterministic code, not an opinion.
   * `researched` — proposed out of band. Does NOT bind until accepted.
   */
  source: "seed" | "researched";
  /** Epoch ms an operator (or an agent acting for one) accepted a researched verdict. */
  acceptedAt?: number;
  /** Why — free text from the research step, shown at review time. */
  rationale?: string;
}

/** A refusal whose meaning is not known, held for the offline research tier. */
export interface UnknownRefusal {
  provider: string;
  model: string | null;
  status: number;
  /** The normalized message — the signature's readable half. */
  normalized: string;
  /** One normalized sample: readable for research, with variable identifiers and URLs removed. */
  sample: string;
  count: number;
  firstSeen: number;
  lastSeen: number;
  /** A researched verdict awaiting acceptance. Present once the research tier has run. */
  proposed?: { class: FactKind; scope: ScopeTemplate; rationale: string; at: number; reset?: ResetRule };
}

interface InterpretationStore {
  version: 2;
  /** signature → interpretation. Only entries that BIND live here. */
  confirmed: Record<string, Interpretation>;
  /** signature → the unseen refusal, awaiting research or acceptance. */
  unknown: Record<string, UnknownRefusal>;
  /**
   * signature → when it was judged to mean nothing durable.
   *
   * ⚠ Rejection has to be REMEMBERED, or it does not exist. Deleting the pending entry alone left
   * the next occurrence to re-queue the same signature, forever — and routine throttling recurs
   * constantly, so the queue filled with messages already judged uninteresting and the ones worth
   * reading were buried. "This teaches the router nothing" is a real verdict and is stored like
   * any other.
   */
  ignored?: Record<string, { at: number }>;
}

/**
 * How long a rejection is honoured. Long, because "this message is noise" is a slow-moving fact —
 * but not forever, so a mistaken reject heals on its own rather than needing a file edited by hand.
 */
export const IGNORED_TTL_MS = 30 * 24 * 60 * 60 * 1000;

/**
 * The longest reset any of these providers publishes. Beyond it a value is a parse artifact or a
 * mistaken assertion, and believing it would strand a deployment far past any real window.
 */
const MAX_RESET_MS = 7 * 24 * 60 * 60 * 1000;

let _store: InterpretationStore | null = null;
let _path: string | null = null;
const writer = new WriteBehindTimer();

// Vitest workers can reuse a PID across separate runs. Keep the test store in a fresh,
// process-local namespace so a prior run can never make a new suite observe stale verdicts.
const testPath = process.env.VITEST === undefined
  ? null
  : join(tmpdir(), `llm-relay-test-interpretations-${process.pid}-${randomUUID()}.json`);
if (testPath !== null) {
  process.once("exit", () => rmSync(testPath, { force: true }));
}

/** Cap on retained unknown signatures — a misbehaving backend must not grow this without bound. */
const MAX_UNKNOWN = 200;
function defaultPath(): string {
  if (process.env.VITEST !== undefined) {
    return testPath!;
  }
  const xdg = process.env.XDG_CONFIG_HOME;
  const baseDir = xdg && xdg.trim() ? join(xdg, "llm-relay") : join(homedir(), ".llm-relay");
  return join(baseDir, "refusal-interpretations.json");
}

/**
 * Reduce a refusal message to its invariant shape.
 *
 * Everything that varies between two occurrences of the SAME refusal has to go, or the table gets
 * one entry per request: uuids and account ids (NIM names both), numbers (credit balances, token
 * counts) and urls (upgrade links carry per-request refs).
 *
 * ⚠ **The message text itself must survive.** An earlier version also replaced every quoted string
 * with a placeholder, on the theory that quoted model names are noise. Against a live pool that
 * erased the entire payload: the Anthropic front hands this the relay's own wrapper —
 * `openai backend HTTP 402: {"error":"You have depleted your monthly included credits…"}` — whose
 * message is *inside* quotes, so all 15 members of a real `pool/xhigh` normalized to
 * `openai backend http <n>: {<name>:<name>}` and nothing could ever match. Quoted model names are
 * harmless: the model is already part of the key.
 *
 * ⚠ For the same reason the JSON hunt digs through a WRAPPER. A body is not always JSON at the top
 * level — the relay's own error envelope prefixes it with prose — so a failed parse falls back to
 * the first embedded object rather than giving up.
 *
 * The result is kept as readable TEXT rather than a hash: a human or an agent has to read these to
 * research them, and a hex digest would make the store unreviewable for no benefit.
 */
export function normalizeRefusalMessage(body: string): string {
  if (typeof body !== "string") return "";
  const text = body.length > 4096 ? body.slice(0, 4096) : body;
  return (extractMessage(text) ?? text)
    .toLowerCase()
    .replace(/https?:\/\/\S+/g, "<url>")
    .replace(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/g, "<id>")
    .replace(/[0-9a-z_-]{24,}/gi, "<id>")
    .replace(/\d[\d,._]*/g, "<n>")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 240);
}

/** The human-readable message inside a body, whether it is JSON, wrapped JSON, or neither. */
function extractMessage(text: string): string | null {
  const candidates: string[] = [text];
  // A wrapper: prose, then the real payload. Take from the first brace or bracket.
  const brace = text.search(/[[{]/);
  if (brace > 0) candidates.push(text.slice(brace));
  for (const candidate of candidates) {
    try {
      const found = findMessage(JSON.parse(candidate) as unknown);
      if (found) return found;
    } catch {
      // Not parseable — try the next candidate.
    }
  }
  return null;
}

/** Depth-first hunt for the message field an OpenAI-shaped error envelope carries. */
function findMessage(v: unknown, depth = 0): string | null {
  if (depth > 6) return null;
  if (typeof v === "string") return v;
  if (Array.isArray(v)) {
    for (const x of v) {
      const found = findMessage(x, depth + 1);
      if (found) return found;
    }
    return null;
  }
  if (v && typeof v === "object") {
    const obj = v as Record<string, unknown>;
    for (const field of ["message", "detail", "error", "title"]) {
      if (typeof obj[field] === "string") return obj[field] as string;
      if (obj[field] && typeof obj[field] === "object") {
        const found = findMessage(obj[field], depth + 1);
        if (found) return found;
      }
    }
  }
  return null;
}

/**
 * A reset the refusal BODY stated, in ms — or null.
 *
 * `Retry-After` is a header, and several providers put the same fact in the body instead: Google's
 * `google.rpc.RetryInfo` carries `"retryDelay": "3600s"` inside the error details, which is the
 * only place Gemini says when a spent quota comes back. Without this the relay falls back to a
 * kind's default TTL and re-probes on a schedule it invented, which for a 5-hourly or weekly quota
 * means hours of pointless attempts.
 *
 * ⚠ Same rule as `parseStatedContextLimit`: only an EXPLICIT statement counts. Nothing is derived
 * from how long a request took, how many failed, or what a window "usually" is — a store whose
 * value is that it holds measurements must not accept a guess. If nothing parses, the kind's TTL
 * applies and the relay simply re-checks sooner than it strictly needed to, which is the safe
 * direction.
 */
export function parseStatedResetMs(body: string): number | null {
  if (typeof body !== "string" || body.length === 0) return null;
  const text = body.length > 8192 ? body.slice(0, 8192) : body;
  const patterns: Array<{ re: RegExp; scale: number }> = [
    // google.rpc.RetryInfo — "retryDelay": "27s" / "1.5s" / "3600s"
    { re: /"retry[_-]?delay"\s*:\s*"?(\d+(?:\.\d+)?)s"?/i, scale: 1000 },
    // Common JSON spellings of the Retry-After header's seconds form.
    { re: /"retry[_-]?after(?:[_-]?seconds)?"\s*:\s*"?(\d+(?:\.\d+)?)"?/i, scale: 1000 },
    // Prose, as a last resort: "try again in 45 seconds" / "retry in 5 minutes".
    { re: /(?:try|retry)\s+again\s+in\s+(\d+(?:\.\d+)?)\s*(?:seconds?|secs?|s)\b/i, scale: 1000 },
    { re: /(?:try|retry)\s+again\s+in\s+(\d+(?:\.\d+)?)\s*(?:minutes?|mins?)\b/i, scale: 60_000 },
    { re: /(?:try|retry)\s+again\s+in\s+(\d+(?:\.\d+)?)\s*(?:hours?|hrs?)\b/i, scale: 3_600_000 },
  ];
  for (const { re, scale } of patterns) {
    const m = re.exec(text);
    if (!m?.[1]) continue;
    const ms = Number(m[1]) * scale;
    // A week is the longest window any of these providers publish; beyond that it is a parse
    // artifact, and believing it would strand a deployment far past any real reset.
    if (Number.isFinite(ms) && ms > 0 && ms <= MAX_RESET_MS) return Math.round(ms);
  }
  return null;
}

/**
 * Apply a reviewed reset rule to one response body.
 *
 * Ranked below anything the response itself states — see `resolveReset` in `server.ts`. A
 * `field` rule reads THIS response, so it is still a measurement; a `fixed` rule is the reviewer's
 * knowledge of a window and is the last word before falling back to the kind's TTL.
 */
export function applyResetRule(rule: ResetRule | undefined, body: string): number | null {
  if (!rule) return null;
  if (rule.kind === "fixed") return rule.ms > 0 && rule.ms <= MAX_RESET_MS ? Math.round(rule.ms) : null;
  const raw = findField(body, rule.field);
  if (raw === null) return null;
  // Providers write durations as "3600s", "3600", or a number. Seconds is the universal unit here
  // (Retry-After, RetryInfo, every JSON spelling seen), so anything without a unit is seconds.
  const m = /(\d+(?:\.\d+)?)\s*(ms|s|m|h)?/i.exec(String(raw));
  if (!m?.[1]) return null;
  const scale = m[2]?.toLowerCase() === "ms" ? 1 : m[2]?.toLowerCase() === "m" ? 60_000 : m[2]?.toLowerCase() === "h" ? 3_600_000 : 1000;
  const ms = Number(m[1]) * scale;
  return Number.isFinite(ms) && ms > 0 && ms <= MAX_RESET_MS ? Math.round(ms) : null;
}

/** Deep lookup of a JSON key by NAME, wrapper-tolerant. Returns the first scalar found. */
function findField(body: string, field: string): string | number | null {
  const parse = (text: string): unknown => {
    try {
      return JSON.parse(text) as unknown;
    } catch {
      const brace = text.search(/[[{]/);
      if (brace <= 0) return null;
      try {
        return JSON.parse(text.slice(brace)) as unknown;
      } catch {
        return null;
      }
    }
  };
  const walk = (v: unknown, depth = 0): string | number | null => {
    if (depth > 8 || v === null || typeof v !== "object") return null;
    for (const [k, val] of Object.entries(v as Record<string, unknown>)) {
      if (k === field && (typeof val === "string" || typeof val === "number")) return val;
      const found = walk(val, depth + 1);
      if (found !== null) return found;
    }
    return null;
  };
  return walk(parse(body.length > 8192 ? body.slice(0, 8192) : body));
}

/**
 * Meaning read from a SELF-DESCRIBING error payload, rather than from prose.
 *
 * Some providers publish the fact in a structured, versioned envelope that names its own schema.
 * Google's is the one in use here: a 429 carries `google.rpc.QuotaFailure` whose `quotaId` states
 * both the window and what the limit is counted against —
 * `GenerateRequestsPerDayPerProjectPerModel-FreeTier` says, unambiguously, that this is a *daily*
 * allowance counted *per model* on the *free tier*. No wording to interpret.
 *
 * ⚠ This is NOT a per-provider switch, which this project refuses elsewhere (`catalog.ts` uses a
 * generic field-alias list; `authEnv.ts` refuses to guess). The dispatch key is the payload's own
 * `@type` URL — the message declares which schema it is speaking, and we read only schemas we
 * understand. A provider adopting `google.rpc` gets this for free; one that does not is unaffected.
 *
 * Ranked ABOVE the prose seeds and BELOW an accepted human verdict: structured evidence beats a
 * pattern guess, and an operator's explicit decision beats both.
 */
function interpretStructured(
  status: number,
  body: string,
): { class: FactKind; scope: ScopeTemplate } | null {
  if (!/google\.rpc\.QuotaFailure/.test(body)) return null;
  // The quotaId is the load-bearing field; read it without trusting the surrounding shape, because
  // a partial or wrapped body must degrade to "learned nothing" rather than throwing.
  const m = /"quotaId"\s*:\s*"([^"]{1,200})"/.exec(body);
  const quotaId = m?.[1];
  if (!quotaId) return null;

  // WINDOW → which fact this is. Per-minute/second is throughput; per-hour and longer is an
  // allowance. This is the rate-limit-vs-quota distinction read off a field instead of inferred
  // from wording, which is exactly where reading wording got it wrong before.
  const perShort = /Per(?:Second|Minute)/i.test(quotaId);
  const perLong = /Per(?:Hour|Day|Week|Month)/i.test(quotaId);
  if (!perShort && !perLong) return null;
  const kind: FactKind = perShort ? "rate-limited" : "allowance-exhausted";

  // SCOPE → what the limit is counted against. A model dimension is always attempt-local. A
  // recognized credential dimension is credential-wide; an unfamiliar dimension stays narrow.
  const scope: ScopeTemplate = /PerModel/i.test(quotaId)
    ? { kind: "attempt" }
    : /Per(?:Project|User|Client|Key)/i.test(quotaId)
      ? { kind: "credential" }
      : { kind: "attempt" };

  // A 429 is the only status this shape is published on; anything else naming QuotaFailure is not
  // something we have seen and should not be guessed at.
  return status === 429 || status === 403 ? { class: kind, scope } : null;
}

/** The lookup key. Per (provider, model, normalized message) — see the header for why all three. */
export function refusalSignature(provider: string, model: string | null | undefined, status: number, body: string): string {
  return `${provider}|${model ?? "-"}|${status}|${normalizeRefusalMessage(body)}`;
}

/**
 * Interpretations shipped with the relay, each derived from a refusal observed first-party against
 * a real account (probed 2026-08-08). These bind without review: they are deterministic code in
 * version control, and an operator who disagrees can override the entry.
 *
 * ⚠ **This list is a BOOTSTRAP, not the mechanism.** Reaching for a new seed every time an
 * unfamiliar message appears means the relay's author learned something and the relay did not —
 * and it is the reflex this two-tier design exists to replace. A researched interpretation carries
 * the same information, is reviewed the same way, and a future session inherits it without a
 * release. Add a seed only for a message shape common enough that every install should start
 * knowing it.
 *
 * ⚠ These are matched as PATTERNS against the normalized message, not as exact signatures, because
 * a seed has to cover a provider it has never been run against. That is a deliberate exception to
 * the per-model keying rule above and the only one — a seed is reviewed source, whereas a
 * researched verdict is a model's opinion and gets the conservative key.
 *
 * ⚠ **`allowance-exhausted` is not a cost verdict.** See `target-facts.ts` — it means the
 * deployment is free and currently spent, and it must never evict anything from a free pool.
 */
export const SEED_INTERPRETATIONS: Array<{
  status: (s: number) => boolean;
  pattern: RegExp;
  class: FactKind;
  scope: ScopeTemplate;
  note: string;
}> = [
  {
    // ⚠ **A quota is not a rate limit, and the two must not share a cooldown.** FIRST in this list
    // on purpose — first match wins, and the rate-limit seed below must never see quota wording.
    //
    // A rate limit is throughput (requests per minute) and resets in seconds to minutes, which is
    // why `rate-limited` carries a 2-minute TTL. A quota is an ALLOWANCE over a long window: a
    // 5-hourly or weekly grant on a free tier, or a monthly credit balance. Classifying one as the
    // other means re-probing a spent weekly quota every two minutes for days. The rate-limit
    // pattern below matched the word "quota" in 0.28.0 and did exactly that.
    //
    // Resolves to `allowance-exhausted`, the same kind HuggingFace's credit balance uses and for
    // the same reason: the deployment is still FREE, it is simply spent until the window rolls
    // over. Gemini's wording — "you exceeded your current quota, please check your plan and
    // billing details" — names the plan, not the model, so it is the project's allowance and every
    // deployment behind that key is equally spent.
    status: (s) => s === 429 || s === 403,
    pattern: /exceeded\s+your\s+current\s+quota|quota\s+exceeded[^.]{0,40}\b(?:plan|billing|project)|check\s+your\s+plan\s+and\s+billing|\b(?:daily|weekly|monthly|hourly)\s+quota\s+(?:exceeded|exhausted|reached)|out\s+of\s+quota/,
    class: "allowance-exhausted",
    scope: { kind: "credential" },
    note: "stated QUOTA exhaustion (long window); free but spent until the allowance refreshes",
  },
  {
    // HuggingFace: "You have depleted your monthly included credits. Purchase pre-paid credits…"
    // A BALANCE — the account's, so it covers every model behind that key.
    status: (s) => s === 402,
    pattern: /deplet\w*\s+your\s+(?:monthly\s+)?(?:included\s+)?credits|insufficient\s+credits|purchase\s+(?:pre-?paid\s+)?credits|out\s+of\s+credits/,
    class: "allowance-exhausted",
    scope: { kind: "credential" },
    note: "stated credit balance; free but spent until it refreshes",
  },
  {
    // Ollama Cloud: "this model requires a subscription, upgrade for access" / "requires both a
    // Pro, Max, or Team plan and extra usage". About THAT MODEL under a working credential, so it
    // must not block the provider's other models.
    status: (s) => s === 403,
    pattern: /requires?\s+(?:both\s+)?an?\s+[\w, ]*\bsubscription\b|requires?\s+(?:both\s+)?an?\s+[\w, ]*\bplan\b|upgrade\s+for\s+access/,
    class: "subscription-required",
    scope: { kind: "attempt" },
    note: "stated plan gating on one model; the credential itself is fine",
  },
  {
    // HuggingFace: "The requested model 'x' does not exist." / OpenAI-compatible model_not_found.
    // NIM: "Function '<uuid>': Not found for account '<id>'" — the serving function is gone. It
    // names an account but is a fact about the deployment, not the credential.
    status: (s) => s === 400 || s === 404,
    pattern: /not\s+found\s+for\s+account/,
    class: "not-servable",
    scope: { kind: "attempt" },
    note: "stated account-bound absence; narrow until credential/model scope is reviewed",
  },
  {
    status: (s) => s === 400 || s === 404,
    pattern: /does\s+not\s+exist|model_not_found|unknown\s+model|no\s+such\s+model/,
    class: "not-servable",
    scope: { kind: "deployment" },
    note: "stated non-existence; catalog rot",
  },
  {
    // NVIDIA NIM retires models with HTTP 410 and end-of-life wording (observed on this machine
    // 2026-08-07: deepseek-v4-pro/-flash). Status and wording must AGREE the model is gone: a bare
    // 410 stays uninterpreted and queues for research, and this wording on a non-410 status must
    // not retire a live model (an advisory notice or status-page quote MENTIONING a retirement is
    // still just text). Phrase set fork-validated in freellmapi's retirement classifier — on a 410
    // even the softer "no longer available" wording is status-agreed gone.
    status: (s) => s === 410,
    pattern:
      /end[\s-]of[\s-]life|has\s+been\s+(?:retired|decommissioned|sunset|removed|discontinued|deprecated)|no\s+longer\s+(?:available|offered|supported)|is\s+deprecated|was\s+removed/,
    class: "not-servable",
    scope: { kind: "deployment" },
    note: "stated end-of-life on a gone-shaped status; the deployment is permanently retired",
  },
  {
    // A credential the provider says is bad — "invalid api key", "authentication failed". A fact
    // about the KEY, so it covers every deployment behind it: without this, each model on that
    // provider independently discovers the same 401 and expires on its own clock.
    //
    // ⚠ Requires the message to state it. A BARE 401/403 stays on the breaker's credential axis and
    // produces no fact at all, because it is equally an entitlement wall on one model under a
    // perfectly good key — the false accusation `key-checker.ts` exists to avoid. This seed fires
    // on wording about the credential, never on the status alone.
    status: (s) => s === 401 || s === 403,
    pattern: /invalid\s+(?:api\s+)?(?:key|token|credentials?)|authentication\s+failed|incorrect\s+api\s+key|api\s+key\s+(?:not\s+valid|is\s+invalid|expired|revoked)|unauthorized:\s*invalid/,
    class: "credential-invalid",
    scope: { kind: "credential" },
    note: "stated bad credential; covers every deployment behind that key",
  },
  {
    // A 429 that names the ACCOUNT, ORGANIZATION or KEY rather than the model — every sibling
    // behind that credential is equally throttled, so discovering it once per model is the waste.
    //
    // ⚠ Narrow on purpose. An ordinary 429 is one deployment's back-pressure and must stay on the
    // breaker's per-target cooldown, which handles it well; only wording that states an
    // account-level limit belongs here. Matching plain "rate limit exceeded" would demote whole
    // providers on routine throttling — worse than the problem.
    status: (s) => s === 429,
    pattern: /(?:account|organization|organisation|project|api\s+key|workspace)[^.]{0,40}\b(?:rate\s*limit|requests?\s+per)|\brate\s*limit[^.]{0,24}\bfor\s+(?:your|this)\s+(?:account|organization|organisation|project|key)/,
    class: "rate-limited",
    scope: { kind: "credential" },
    note: "stated account-level THROTTLING; resets in seconds to minutes",
  },
];


function signatureParts(signature: string): { provider: string; model: string | null; status: number; sample: string } | null {
  const match = /^([^|]+)\|([^|]*)\|(\d{3})\|(.+)$/.exec(signature);
  if (!match || !match[1] || !match[2] || !match[3] || !match[4]) return null;
  const status = Number(match[3]);
  if (!Number.isInteger(status)) return null;
  return { provider: match[1], model: match[2] === "-" ? null : match[2], status, sample: match[4] };
}

function validTemplate(value: unknown): value is ScopeTemplate {
  if (!value || typeof value !== "object") return false;
  const scope = value as Record<string, unknown>;
  switch (scope.kind) {
    case "attempt":
    case "deployment":
    case "credential":
    case "provider":
    case "model":
      return hasExactKeys(scope, ["kind"]);
    case "group":
      return hasExactKeys(scope, ["kind", "members", "credential"])
        && Array.isArray(scope.members) && scope.members.every((member) => typeof member === "string" && member.length > 0)
        && (scope.credential === "attempt" || scope.credential === "all");
    default:
      return false;
  }
}

function validV1Template(value: unknown): boolean {
  if (!value || typeof value !== "object") return false;
  const scope = value as Record<string, unknown>;
  switch (scope.kind) {
    case "deployment":
    case "provider":
    case "model":
      return hasExactKeys(scope, ["kind"]);
    case "group":
      return hasExactKeys(scope, ["kind", "members"])
        && Array.isArray(scope.members) && scope.members.every((member) => typeof member === "string" && member.length > 0);
    default:
      return false;
  }
}

function validInterpretation(value: unknown): value is Interpretation {
  if (!value || typeof value !== "object") return false;
  const interpretation = value as Record<string, unknown>;
  return FACT_KINDS.includes(interpretation.class as FactKind)
    && validTemplate(interpretation.scope)
    && (interpretation.source === "seed" || interpretation.source === "researched")
    && (interpretation.acceptedAt === undefined || Number.isFinite(interpretation.acceptedAt));
}

function validV1Interpretation(value: unknown): value is Interpretation {
  if (!value || typeof value !== "object") return false;
  const interpretation = value as Record<string, unknown>;
  return FACT_KINDS.includes(interpretation.class as FactKind)
    && validV1Template(interpretation.scope)
    && (interpretation.source === "seed" || interpretation.source === "researched")
    && (interpretation.acceptedAt === undefined || Number.isFinite(interpretation.acceptedAt));
}

function validProposal(value: unknown): boolean {
  if (!value || typeof value !== "object") return false;
  const proposal = value as Record<string, unknown>;
  return FACT_KINDS.includes(proposal.class as FactKind)
    && validTemplate(proposal.scope)
    && typeof proposal.rationale === "string"
    && Number.isFinite(proposal.at);
}

function validIgnored(value: unknown): value is { at: number } {
  return !!value && typeof value === "object" && Number.isFinite((value as { at?: unknown }).at);
}

function validUnknown(value: unknown): value is UnknownRefusal {
  if (!value || typeof value !== "object") return false;
  const unknown = value as Record<string, unknown>;
  const parts = typeof unknown.provider === "string" && (typeof unknown.model === "string" || unknown.model === null)
    ? signatureParts(`${unknown.provider}|${unknown.model ?? "-"}|${unknown.status}|${unknown.normalized as string}`) : null;
  return typeof unknown.provider === "string" && unknown.provider.length > 0
    && (typeof unknown.model === "string" || unknown.model === null)
    && Number.isInteger(unknown.status) && typeof unknown.normalized === "string" && typeof unknown.sample === "string"
    && Number.isFinite(unknown.count) && Number.isFinite(unknown.firstSeen) && Number.isFinite(unknown.lastSeen)
    && (unknown.proposed === undefined || validProposal(unknown.proposed))
    && parts !== null;
}

function unknownMatchesSignature(signature: string, value: UnknownRefusal): boolean {
  const parts = signatureParts(signature);
  return parts !== null
    && value.provider === parts.provider
    && value.model === parts.model
    && value.status === parts.status
    && value.normalized === parts.sample;
}

function validV1Unknown(value: unknown): value is UnknownRefusal {
  if (!validUnknown({ ...(value as object), proposed: undefined })) return false;
  const proposed = (value as { proposed?: unknown }).proposed;
  if (proposed === undefined) return true;
  if (!proposed || typeof proposed !== "object") return false;
  const candidate = proposed as Record<string, unknown>;
  return FACT_KINDS.includes(candidate.class as FactKind)
    && validV1Template(candidate.scope)
    && typeof candidate.rationale === "string"
    && Number.isFinite(candidate.at);
}

function asPending(signature: string, interpretation: Interpretation): UnknownRefusal | null {
  const parts = signatureParts(signature);
  if (!parts) return null;
  const now = Number.isFinite(interpretation.acceptedAt) ? interpretation.acceptedAt! : Date.now();
  return {
    provider: parts.provider,
    model: parts.model,
    status: parts.status,
    normalized: parts.sample,
    sample: parts.sample,
    count: 1,
    firstSeen: now,
    lastSeen: now,
  };
}

function migrateV1(parsed: Record<string, unknown>): InterpretationStore {
  const confirmed: Record<string, Interpretation> = {};
  const unknown: Record<string, UnknownRefusal> = {};
  const ignored: Record<string, { at: number }> = {};
  const rawUnknown = parsed.unknown;
  if (rawUnknown && typeof rawUnknown === "object") {
    for (const [signature, entry] of Object.entries(rawUnknown)) {
      if (!validV1Unknown(entry) || !unknownMatchesSignature(signature, entry)) continue;
      const migrated = { ...entry };
      // An old provider proposal could otherwise be accepted later and silently acquire the old,
      // over-broad meaning. It must be researched again under v2's explicit scopes.
      if (migrated.proposed?.scope?.kind === "provider") delete migrated.proposed;
      else if (migrated.proposed?.scope?.kind === "group") {
        migrated.proposed = {
          ...migrated.proposed,
          scope: { ...migrated.proposed.scope, credential: "attempt" },
        };
      }
      unknown[signature] = migrated;
    }
  }
  const rawConfirmed = parsed.confirmed;
  if (rawConfirmed && typeof rawConfirmed === "object") {
    for (const [signature, entry] of Object.entries(rawConfirmed)) {
      if (!signatureParts(signature) || !validV1Interpretation(entry)) continue;
      if (entry.scope.kind === "provider") {
        // v1 provider meant “the credential”, but it did not name the credential. Requeue rather
        // than guessing a v2 scope or letting it keep binding.
        const pending = entry.acceptedAt === undefined ? null : asPending(signature, entry);
        if (pending) unknown[signature] = pending;
        continue;
      }
      confirmed[signature] = entry.scope.kind === "group"
        ? { ...entry, scope: { ...entry.scope, credential: "attempt" } }
        : entry;
    }
  }
  const rawIgnored = parsed.ignored;
  if (rawIgnored && typeof rawIgnored === "object") {
    for (const [signature, entry] of Object.entries(rawIgnored)) {
      if (signatureParts(signature) && validIgnored(entry)) ignored[signature] = entry;
    }
  }
  return { version: 2, confirmed, unknown, ignored };
}

function load(path: string): InterpretationStore {
  if (_store && _path === path) return _store;
  _path = path;
  try {
    const parsed: unknown = JSON.parse(readFileSync(path, "utf8"));
    if (parsed && typeof parsed === "object") {
      const raw = parsed as Record<string, unknown>;
      if (raw.version === 1) {
        _store = migrateV1(raw);
        return _store;
      }
      if (raw.version === 2) {
        const confirmed: Record<string, Interpretation> = {};
        const unknown: Record<string, UnknownRefusal> = {};
        const ignored: Record<string, { at: number }> = {};
        if (raw.confirmed && typeof raw.confirmed === "object") {
          for (const [signature, entry] of Object.entries(raw.confirmed)) {
            if (signatureParts(signature) && validInterpretation(entry)) confirmed[signature] = entry;
          }
        }
        if (raw.unknown && typeof raw.unknown === "object") {
          for (const [signature, entry] of Object.entries(raw.unknown)) {
            if (validUnknown(entry) && unknownMatchesSignature(signature, entry)) unknown[signature] = entry;
          }
        }
        if (raw.ignored && typeof raw.ignored === "object") {
          for (const [signature, entry] of Object.entries(raw.ignored)) {
            if (signatureParts(signature) && validIgnored(entry)) ignored[signature] = entry;
          }
        }
        _store = { version: 2, confirmed, unknown, ignored };
        return _store;
      }
    }
  } catch {
    // Corrupt or absent: start clean. Seeds live in source, so nothing binding is lost.
  }
  _store = { version: 2, confirmed: {}, unknown: {}, ignored: {} };
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
    /* storage problem, never a request failure — same contract as every other store here */
  }
}

/**
 * What this refusal means, or null when nothing confirmed covers it.
 *
 * Order: the operator-visible table first (so an override beats a seed), then the seeds. A miss
 * returns null and the caller must learn nothing — that is the whole fail-safe.
 */
export function interpretRefusal(
  provider: string,
  model: string | null | undefined,
  status: number,
  body: string,
  opts: { path?: string } = {},
): Interpretation | null {
  const store = load(opts.path ?? defaultPath());
  const hit = store.confirmed[refusalSignature(provider, model, status, body)];
  // A researched entry binds only once accepted; an unaccepted one is still sitting in review.
  if (hit && (hit.source === "seed" || hit.acceptedAt !== undefined)) return hit;

  // Structured evidence beats prose: the payload states its own schema and its own dimensions,
  // where a seed only pattern-matches wording. Below an accepted human verdict, above the seeds.
  const structured = interpretStructured(status, body);
  if (structured) {
    return {
      class: structured.class,
      scope: structured.scope,
      source: "seed",
      // The same envelope carries `google.rpc.RetryInfo`, so the reset is read from the response
      // itself rather than falling back to the kind's default TTL.
      reset: { kind: "field", field: "retryDelay" },
    };
  }

  const normalized = normalizeRefusalMessage(body);
  for (const seed of SEED_INTERPRETATIONS) {
    if (!seed.status(status)) continue;
    if (seed.pattern.test(normalized)) return { class: seed.class, scope: seed.scope, source: "seed" };
  }
  return null;
}

/**
 * Hold an uninterpretable refusal for the research tier.
 *
 * Deliberately cheap and lossy: one normalized sample per signature and a count. The queue exists to
 * tell a researcher "this message happens, here is what it looks like", not to be a log — the
 * metadata logger already covers the traffic, and it is metadata-only precisely so bodies do not
 * land on disk. Normalization runs before both the signature and the stored sample, stripping
 * variable ids, key-shaped strings and URLs while leaving the provider's readable refusal text.
 */
export function recordUnknownRefusal(
  provider: string,
  model: string | null | undefined,
  status: number,
  body: string,
  opts: { path?: string; now?: number } = {},
): void {
  const normalized = normalizeRefusalMessage(body);
  if (!normalized) return;
  const path = opts.path ?? defaultPath();
  const store = load(path);
  const sig = refusalSignature(provider, model, status, body);
  if (store.confirmed[sig]) return;
  const now = opts.now ?? Date.now();
  // Already judged to mean nothing. Re-queuing it would bury the signatures worth reading under
  // the ones a human has explicitly finished with — which is what routine throttling does.
  const ignoredAt = store.ignored?.[sig]?.at;
  if (typeof ignoredAt === "number" && now - ignoredAt < IGNORED_TTL_MS) return;
  const existing = store.unknown[sig];
  if (existing) {
    existing.count += 1;
    existing.lastSeen = now;
  } else {
    if (Object.keys(store.unknown).length >= MAX_UNKNOWN) {
      // Evict the least-recently-seen: a signature nobody has hit in a long time is the one least
      // worth researching, and an unbounded file would be its own defect.
      let oldestKey: string | null = null;
      let oldestAt = Infinity;
      for (const [k, v] of Object.entries(store.unknown)) {
        if (v.lastSeen < oldestAt) { oldestAt = v.lastSeen; oldestKey = k; }
      }
      if (oldestKey) delete store.unknown[oldestKey];
    }
    store.unknown[sig] = {
      provider,
      model: typeof model === "string" ? model : null,
      status,
      normalized,
      // The seed recheck in `pendingRefusals()` normalizes this again. The same normalizer is
      // intentionally idempotent, so redacting what lands on disk cannot break retroactive seeds.
      sample: normalized,
      count: 1,
      firstSeen: now,
      lastSeen: now,
    };
  }
  writer.touch(() => persist(path));
}

/** Unseen refusals, most-frequent first — the research tier's work list. */
export function pendingRefusals(opts: { path?: string } = {}): Array<UnknownRefusal & { signature: string }> {
  const path = opts.path ?? defaultPath();
  const store = load(path);
  // A signature queued before a seed existed for it is no longer pending — shipping a seed should
  // RETROACTIVELY clear the queue, or every release that teaches the relay something leaves behind
  // items asking a human to explain what the relay already knows.
  let resolved = false;
  for (const [signature, entry] of Object.entries(store.unknown)) {
    if (entry.model === null) continue;
    if (interpretRefusal(entry.provider, entry.model, entry.status, entry.sample, { path }) === null) continue;
    delete store.unknown[signature];
    resolved = true;
  }
  if (resolved) writer.touch(() => persist(path));
  return Object.entries(store.unknown)
    .map(([signature, v]) => ({ ...v, signature }))
    .sort((a, b) => b.count - a.count || b.lastSeen - a.lastSeen);
}

/** Attach a researched verdict to a pending signature. It does NOT bind until accepted. */
export function proposeInterpretation(
  signature: string,
  proposal: { class: FactKind; scope: ScopeTemplate; rationale: string; reset?: ResetRule },
  opts: { path?: string; now?: number } = {},
): boolean {
  const path = opts.path ?? defaultPath();
  const store = load(path);
  const pending = store.unknown[signature];
  if (!pending) return false;
  pending.proposed = { ...proposal, at: opts.now ?? Date.now() };
  writer.touch(() => persist(path));
  return true;
}

/**
 * Accept an interpretation, which is the moment it starts affecting routing.
 *
 * Separate from `propose` on purpose: this is the review gate that keeps a researched verdict —
 * a model's opinion — out of the request path until a person (or an agent acting explicitly for
 * one) has looked at it.
 */
export function acceptInterpretation(
  signature: string,
  opts: { path?: string; now?: number; override?: { class: FactKind; scope: ScopeTemplate; reset?: ResetRule } } = {},
): boolean {
  const path = opts.path ?? defaultPath();
  const store = load(path);
  const pending = store.unknown[signature];
  const verdict = opts.override ?? (pending?.proposed
    ? { class: pending.proposed.class, scope: pending.proposed.scope, reset: pending.proposed.reset }
    : null);
  if (!verdict) return false;
  // The reset travels with the verdict: accepting an interpretation commits everything known about
  // that message shape — what it means, who it covers, and when it clears — not just a label.
  const reset = verdict.reset ?? pending?.proposed?.reset;
  store.confirmed[signature] = {
    class: verdict.class,
    scope: verdict.scope,
    ...(reset ? { reset } : {}),
    source: "researched",
    acceptedAt: opts.now ?? Date.now(),
    ...(pending?.proposed?.rationale ? { rationale: pending.proposed.rationale } : {}),
  };
  delete store.unknown[signature];
  writer.touch(() => persist(path));
  return true;
}

/**
 * "This means nothing durable" — a real verdict, and therefore remembered.
 *
 * Routine throttling, a policy refusal, a transient fault: none of them should teach the router
 * anything, and none of them should keep asking. Recording the rejection is what makes the queue
 * converge instead of refilling with messages already judged uninteresting.
 */
export function rejectInterpretation(signature: string, opts: { path?: string; now?: number } = {}): boolean {
  const path = opts.path ?? defaultPath();
  const store = load(path);
  if (!store.unknown[signature]) return false;
  delete store.unknown[signature];
  store.ignored = { ...(store.ignored ?? {}), [signature]: { at: opts.now ?? Date.now() } };
  writer.touch(() => persist(path));
  return true;
}

/** Flush pending writes. Called on shutdown, like the other write-behind stores. */
export function flushInterpretations(opts: { path?: string } = {}): void {
  if (!writer.dirty) return;
  writer.clear();
  persist(opts.path ?? defaultPath());
}

/** Test seam: drop the in-memory store so a suite can point at a fresh path. */
export function resetInterpretations(): void {
  _store = null;
  _path = null;
  writer.clear();
}
