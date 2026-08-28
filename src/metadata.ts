/**
 * Where a metadata value came from, in descending trustworthiness.
 *  - `provider`   the provider serving this target published it about its OWN deployment;
 *  - `reference`  another provider publishes it for the same model id. Deployments differ —
 *                 quantization, context caps, per-plan output limits — so this is indicative.
 *
 * There is deliberately no third rung. A hardcoded table used to sit here, handing out a blanket
 * 128k/4096 for anything it did not recognise; a guess presented as a limit is worse than a null,
 * because callers cannot tell it apart from a measurement.
 */
export type MetadataSource = "provider" | "reference";

export interface ResolvedMetadata {
  contextLength: number | null;
  contextLengthSource: MetadataSource | null;
  maxOutputTokens: number | null;
  maxOutputTokensSource: MetadataSource | null;
  /** Per-MILLION-token price. Provider-specific: the same model is priced differently per host,
   *  and can be free on one and metered on another, so this carries provenance like the limits do. */
  pricePerMTokIn: number | null;
  pricePerMTokOut: number | null;
  priceSource: MetadataSource | null;
  /** Which provider a `reference` value was borrowed from. */
  referenceFrom?: string;
}

const PER_MILLION = 1e6;

function toPerMillion(perToken: number | null | undefined): number | null {
  return typeof perToken === "number" ? Math.round(perToken * PER_MILLION * 1000) / 1000 : null;
}

/**
 * Resolve a target's limits and price per FIELD, each with its own provenance.
 *
 * Per-field because coverage is ragged: Groq publishes both context and max-output, Mistral only
 * context, NIM neither. Resolving the pair together would force a single label onto two values of
 * different quality. The point is that a NIM row never silently reports OpenRouter's ceiling as
 * its own — same model id, different deployment.
 */
export function resolveMetadata(
  modelId: string,
  opts: {
    providerLimits?: {
      contextLength: number | null;
      maxOutputTokens: number | null;
      pricePromptPerToken?: number | null;
      priceCompletionPerToken?: number | null;
    } | null;
    reference?: {
      contextLength?: number | null;
      maxOutputTokens?: number | null;
      pricePromptPerToken?: number | null;
      priceCompletionPerToken?: number | null;
      from?: string;
    } | null;
  } = {},
): ResolvedMetadata {
  const p = opts.providerLimits;
  const r = opts.reference;

  const pick = (
    provider: number | null | undefined,
    reference: number | null | undefined,
  ): [number | null, MetadataSource | null] => {
    if (typeof provider === "number") return [provider, "provider"];
    if (typeof reference === "number") return [reference, "reference"];
    return [null, null];
  };

  const [contextLength, contextLengthSource] = pick(p?.contextLength, r?.contextLength);
  const [maxOutputTokens, maxOutputTokensSource] = pick(p?.maxOutputTokens, r?.maxOutputTokens);

  // In/out resolve together: they come from one `pricing` object, so a split would report one
  // provider's input price beside another's output price.
  const providerPriced = typeof p?.pricePromptPerToken === "number" || typeof p?.priceCompletionPerToken === "number";
  const referencePriced = typeof r?.pricePromptPerToken === "number" || typeof r?.priceCompletionPerToken === "number";
  const priceSource: MetadataSource | null = providerPriced ? "provider" : referencePriced ? "reference" : null;
  const priced = providerPriced ? p : referencePriced ? r : null;

  return {
    contextLength,
    contextLengthSource,
    maxOutputTokens,
    maxOutputTokensSource,
    pricePerMTokIn: toPerMillion(priced?.pricePromptPerToken),
    pricePerMTokOut: toPerMillion(priced?.priceCompletionPerToken),
    priceSource,
    ...(r?.from &&
    (contextLengthSource === "reference" || maxOutputTokensSource === "reference" || priceSource === "reference")
      ? { referenceFrom: r.from }
      : {}),
  };
}

/**
 * What serving one request on a deployment costs, with the evidence class attached.
 *
 * The SINGLE definition of "free" — dynamic pool admission and the `freeOnly` offload guard
 * both resolve through it, so "a pool admits it as free" and "the guard lets offloaded traffic
 * reach it" can never disagree. `unknown` is deliberately its own class: the guard treats it as
 * paid (a guess must not spend money), and the basis field says which evidence produced the
 * verdict, same contract as every other number here.
 */
/**
 * The vocabulary, as an array first so the TYPE derives from it rather than being a second
 * hand-written list beside it. `target-facts.ts` needs the runtime set to validate a persisted
 * cost filter, and a hand-listed set is the drift seam this codebase closed eight times on
 * 2026-08-28 (see the closed-vocabulary gotcha in CLAUDE.md).
 */
export const COST_CLASSES = Object.freeze(["free", "paid", "unknown"] as const);
export type CostClass = (typeof COST_CLASSES)[number];

export interface CostAssessment {
  costClass: CostClass;
  basis: "published-price" | "free-labelled" | "provider-tier" | "unpublished";
}

export function assessCost(
  model: string | null | undefined,
  limits: { pricePromptPerToken: number | null; priceCompletionPerToken: number | null } | null,
  providerTierType?: string,
): CostAssessment {
  const inPrice = limits?.pricePromptPerToken;
  const outPrice = limits?.priceCompletionPerToken;
  // A known positive price always wins — a ":free"-suffixed id with a published price is priced.
  if ((typeof inPrice === "number" && inPrice > 0) || (typeof outPrice === "number" && outPrice > 0)) {
    return { costClass: "paid", basis: "published-price" };
  }
  if (inPrice === 0 && outPrice === 0) return { costClass: "free", basis: "published-price" };
  if (typeof model === "string" && /(?:^|[/:_-])free(?:$|[/:_-])/i.test(model)) {
    return { costClass: "free", basis: "free-labelled" };
  }
  if (providerTierType === "free") return { costClass: "free", basis: "provider-tier" };
  return { costClass: "unknown", basis: "unpublished" };
}

/** Shared chars/4 convention for relay-authored token estimates. */
export function estimateTokensFromCharacters(characters: number): number {
  return Math.ceil(characters / 4);
}

/**
 * Estimate input prompt token count from a request object.
 *
 * The ONE estimator — the context guardrail (on BOTH fronts) and the local
 * `count_tokens` answer for OpenAI backends all use it (there used to be two,
 * which disagreed: one ignored tools, the other counted base64 payloads as
 * text). ~4 chars/token over every string in the prompt-carrying fields, which
 * cover all three wire shapes the proxy fronts: `system`+`messages`+`tools`
 * (Anthropic Messages; OpenAI Chat shares `messages`+`tools`) and
 * `instructions`+`input` (OpenAI Responses) — the walker is shape-generic
 * inside each field, so the differing inner structures need no per-shape code.
 * Tool schemas and tool_use inputs genuinely consume context upstream, so they
 * count. Binary payloads are excluded — the `data` field of Anthropic base64
 * image/document sources, and base64 `data:` URLs, which is how the OpenAI
 * shapes inline the same bytes: a base64 blob's byte length says nothing about
 * its token cost, and a wildly inflated guess must not masquerade as a
 * measurement. Undercounting media is safe in both call sites — the guardrail
 * only prunes on published limits and the provider stays authoritative;
 * count_tokens is advisory bookkeeping.
 */
export function estimateRequestTokens(reqJson: unknown): number {
  if (typeof reqJson !== "object" || reqJson === null) return 0;
  let chars = 0;
  const isBase64DataUrl = (s: string) => s.startsWith("data:") && s.includes(";base64,");
  const walk = (v: unknown, key?: string): void => {
    if (typeof v === "string") {
      if (key !== "data" && !isBase64DataUrl(v)) chars += v.length;
    } else if (Array.isArray(v)) {
      for (const x of v) walk(x);
    } else if (v && typeof v === "object") {
      for (const [k, x] of Object.entries(v)) walk(x, k);
    }
  };
  const obj = reqJson as Record<string, unknown>;
  walk(obj.system);
  walk(obj.messages);
  walk(obj.tools);
  walk(obj.instructions);
  walk(obj.input);
  return estimateTokensFromCharacters(chars);
}

/** Where a context window came from, in descending order of authority. */
export type ContextWindowSource = "observed" | "provider" | "snapshot";

export interface ResolvedContextWindow {
  tokens: number;
  source: ContextWindowSource;
}

/**
 * Build the context-window lookup used to fill a `cliLane` template's `{contextWindow}`.
 *
 * Two rungs, both REAL PUBLICATIONS — there is deliberately no guessed rung, for the same reason
 * `resolveMetadata` has none and the request-path guardrail stays silent on an unknown limit:
 *
 *  1. `observed` — a ceiling THIS deployment stated when it refused an over-length request. The
 *     strongest evidence there is: a first-party fact about the exact deployment that will serve
 *     the next request, which a published catalogue figure can contradict by being generic or
 *     stale. Only an explicitly stated maximum is ever recorded — see `context-limits.ts`.
 *  2. `provider` — the serving deployment's own published `contextLength`.
 *  3. `snapshot` — `context_length` from the synced capability snapshot (`docs/tier-data.json`,
 *     OpenRouter), matched **exactly** on the spec's last segment.
 *
 * ⚠ Rung 2 exists because rung 1 is nearly empty in practice: free providers publish little
 * metadata and NIM publishes none, so 0 of 29 `pool/high` members carry a provider-published
 * window (measured 2026-08-07) while 28 of 29 carry a snapshot one. Without it the feature would
 * be correct and useless.
 *
 * ⚠ **Exact matches only.** `findTierModel` will fall back to a fuzzy match, which can borrow a
 * different SKU's row (`glm-5.2` → `glm-5.2-max`). A wrong capability score mis-ranks a pool; a
 * wrong context window tells a client it may send tokens the backend will reject. The blast radius
 * differs, so this path takes the stricter rule.
 *
 * The provider limit lookup is injected so this module keeps no catalog dependency.
 */
export function contextWindowResolver(
  providerLimit: (provider: string, model: string) => number | null,
  snapshot: (spec: string) => { tokens: number; match: "exact" | "fuzzy" } | null,
  observed?: (provider: string, model: string) => number | null,
): (spec: string) => ResolvedContextWindow | null {
  const positive = (n: unknown): n is number => typeof n === "number" && Number.isFinite(n) && n > 0;
  return (spec: string) => {
    const slash = spec.indexOf("/");
    if (slash > 0) {
      const provider = spec.slice(0, slash);
      const model = spec.slice(slash + 1);
      const learned = observed?.(provider, model) ?? null;
      if (positive(learned)) return { tokens: learned, source: "observed" };
      const own = providerLimit(provider, model);
      if (positive(own)) return { tokens: own, source: "provider" };
    }
    const hit = snapshot(spec);
    if (hit && hit.match === "exact" && positive(hit.tokens)) return { tokens: hit.tokens, source: "snapshot" };
    return null;
  };
}
