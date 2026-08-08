import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { homedir, tmpdir } from "node:os";
import { WriteBehindTimer } from "./write-behind.js";
import type { EligibilityClass, EligibilityScope } from "./deployment-eligibility.js";

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

/** A refusal interpretation, however it got here. */
export interface Interpretation {
  class: EligibilityClass;
  scope: EligibilityScope;
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
  /** One verbatim sample, so a researcher sees what was actually said. Truncated. */
  sample: string;
  count: number;
  firstSeen: number;
  lastSeen: number;
  /** A researched verdict awaiting acceptance. Present once the research tier has run. */
  proposed?: { class: EligibilityClass; scope: EligibilityScope; rationale: string; at: number };
}

interface InterpretationStore {
  version: 1;
  /** signature → interpretation. Only entries that BIND live here. */
  confirmed: Record<string, Interpretation>;
  /** signature → the unseen refusal, awaiting research or acceptance. */
  unknown: Record<string, UnknownRefusal>;
}

let _store: InterpretationStore | null = null;
let _path: string | null = null;
const writer = new WriteBehindTimer();

/** Cap on retained unknown signatures — a misbehaving backend must not grow this without bound. */
const MAX_UNKNOWN = 200;
/** Verbatim sample cap. Enough to research from, small enough to keep the file readable. */
const SAMPLE_CHARS = 400;

function defaultPath(): string {
  if (process.env.VITEST !== undefined) {
    return join(tmpdir(), `llm-relay-test-interpretations-${process.pid}.json`);
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

/** The lookup key. Per (provider, model, normalized message) — see the header for why all three. */
export function refusalSignature(provider: string, model: string | null | undefined, status: number, body: string): string {
  return `${provider}|${model ?? "-"}|${status}|${normalizeRefusalMessage(body)}`;
}

/**
 * Interpretations shipped with the relay, each derived from a refusal observed first-party against
 * a real account (probed 2026-08-08). These bind without review: they are deterministic code in
 * version control, and an operator who disagrees can override the entry.
 *
 * ⚠ These are matched as PATTERNS against the normalized message, not as exact signatures, because
 * a seed has to cover a provider it has never been run against. That is a deliberate exception to
 * the per-model keying rule above and the only one — a seed is reviewed source, whereas a
 * researched verdict is a model's opinion and gets the conservative key.
 *
 * ⚠ **`allowance-exhausted` is not a cost verdict.** See `deployment-eligibility.ts` — it means the
 * deployment is free and currently spent, and it must never evict anything from a free pool.
 */
export const SEED_INTERPRETATIONS: Array<{
  status: (s: number) => boolean;
  pattern: RegExp;
  class: EligibilityClass;
  scope: EligibilityScope;
  note: string;
}> = [
  {
    // HuggingFace: "You have depleted your monthly included credits. Purchase pre-paid credits…"
    // A BALANCE — the account's, so it covers every model behind that key.
    status: (s) => s === 402,
    pattern: /deplet\w*\s+your\s+(?:monthly\s+)?(?:included\s+)?credits|insufficient\s+credits|purchase\s+(?:pre-?paid\s+)?credits|out\s+of\s+credits/,
    class: "allowance-exhausted",
    scope: "account",
    note: "stated credit balance; free but spent until it refreshes",
  },
  {
    // Ollama Cloud: "this model requires a subscription, upgrade for access" / "requires both a
    // Pro, Max, or Team plan and extra usage". About THAT MODEL under a working credential, so it
    // must not block the provider's other models.
    status: (s) => s === 403,
    pattern: /requires?\s+(?:both\s+)?an?\s+[\w, ]*\bsubscription\b|requires?\s+(?:both\s+)?an?\s+[\w, ]*\bplan\b|upgrade\s+for\s+access/,
    class: "subscription-required",
    scope: "deployment",
    note: "stated plan gating on one model; the credential itself is fine",
  },
  {
    // HuggingFace: "The requested model 'x' does not exist." / OpenAI-compatible model_not_found.
    // NIM: "Function '<uuid>': Not found for account '<id>'" — the serving function is gone. It
    // names an account but is a fact about the deployment, not the credential.
    status: (s) => s === 400 || s === 404,
    pattern: /does\s+not\s+exist|model_not_found|unknown\s+model|no\s+such\s+model|not\s+found\s+for\s+account/,
    class: "not-servable",
    scope: "deployment",
    note: "stated non-existence; catalog rot",
  },
];

function load(path: string): InterpretationStore {
  if (_store && _path === path) return _store;
  _path = path;
  try {
    const parsed = JSON.parse(readFileSync(path, "utf8")) as Partial<InterpretationStore>;
    if (parsed && typeof parsed === "object") {
      _store = {
        version: 1,
        confirmed: (parsed.confirmed ?? {}) as Record<string, Interpretation>,
        unknown: (parsed.unknown ?? {}) as Record<string, UnknownRefusal>,
      };
      return _store;
    }
  } catch {
    // Corrupt or absent: start clean. Seeds live in source, so nothing that BINDS is lost — only
    // researched entries, which the queue will re-surface as the refusals recur.
  }
  _store = { version: 1, confirmed: {}, unknown: {} };
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
 * Deliberately cheap and lossy: one verbatim sample per signature and a count. The queue exists to
 * tell a researcher "this message happens, here is what it looks like", not to be a log — the
 * metadata logger already covers the traffic, and it is metadata-only precisely so bodies do not
 * land on disk. This file holds error bodies, which are the provider's own text about a
 * deployment, never the user's prompt.
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
      sample: body.length > SAMPLE_CHARS ? body.slice(0, SAMPLE_CHARS) : body,
      count: 1,
      firstSeen: now,
      lastSeen: now,
    };
  }
  writer.touch(() => persist(path));
}

/** Unseen refusals, most-frequent first — the research tier's work list. */
export function pendingRefusals(opts: { path?: string } = {}): Array<UnknownRefusal & { signature: string }> {
  const store = load(opts.path ?? defaultPath());
  return Object.entries(store.unknown)
    .map(([signature, v]) => ({ ...v, signature }))
    .sort((a, b) => b.count - a.count || b.lastSeen - a.lastSeen);
}

/** Attach a researched verdict to a pending signature. It does NOT bind until accepted. */
export function proposeInterpretation(
  signature: string,
  proposal: { class: EligibilityClass; scope: EligibilityScope; rationale: string },
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
  opts: { path?: string; now?: number; override?: { class: EligibilityClass; scope: EligibilityScope } } = {},
): boolean {
  const path = opts.path ?? defaultPath();
  const store = load(path);
  const pending = store.unknown[signature];
  const verdict = opts.override ?? (pending?.proposed ? { class: pending.proposed.class, scope: pending.proposed.scope } : null);
  if (!verdict) return false;
  store.confirmed[signature] = {
    class: verdict.class,
    scope: verdict.scope,
    source: "researched",
    acceptedAt: opts.now ?? Date.now(),
    ...(pending?.proposed?.rationale ? { rationale: pending.proposed.rationale } : {}),
  };
  delete store.unknown[signature];
  writer.touch(() => persist(path));
  return true;
}

/** Drop a pending signature without accepting it — "this means nothing durable". */
export function rejectInterpretation(signature: string, opts: { path?: string } = {}): boolean {
  const path = opts.path ?? defaultPath();
  const store = load(path);
  if (!store.unknown[signature]) return false;
  delete store.unknown[signature];
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
