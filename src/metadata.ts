export interface ModelMetadata {
  contextLength?: number;
  maxOutputTokens?: number;
  supportsTools?: boolean;
  supportsThinking?: boolean;
}

const DEFAULT_METADATA_TABLE: Array<{ pattern: string | RegExp; metadata: ModelMetadata }> = [
  // Anthropic / Claude
  { pattern: "claude-3-7-sonnet", metadata: { contextLength: 200000, maxOutputTokens: 64000, supportsTools: true, supportsThinking: true } },
  { pattern: "claude-3-5-sonnet", metadata: { contextLength: 200000, maxOutputTokens: 8192, supportsTools: true, supportsThinking: false } },
  { pattern: "claude-3-5-haiku", metadata: { contextLength: 200000, maxOutputTokens: 8192, supportsTools: true, supportsThinking: false } },
  { pattern: "claude-3-opus", metadata: { contextLength: 200000, maxOutputTokens: 4096, supportsTools: true, supportsThinking: false } },

  // OpenAI
  { pattern: "gpt-4o", metadata: { contextLength: 128000, maxOutputTokens: 16384, supportsTools: true, supportsThinking: false } },
  { pattern: "gpt-4o-mini", metadata: { contextLength: 128000, maxOutputTokens: 16384, supportsTools: true, supportsThinking: false } },
  { pattern: "o3-mini", metadata: { contextLength: 200000, maxOutputTokens: 100000, supportsTools: true, supportsThinking: true } },
  { pattern: "o1", metadata: { contextLength: 200000, maxOutputTokens: 100000, supportsTools: true, supportsThinking: true } },

  // DeepSeek
  { pattern: "deepseek-r1", metadata: { contextLength: 128000, maxOutputTokens: 8192, supportsTools: true, supportsThinking: true } },
  { pattern: "deepseek-v3", metadata: { contextLength: 128000, maxOutputTokens: 8192, supportsTools: true, supportsThinking: false } },

  // Qwen
  { pattern: "qwen-2.5-coder", metadata: { contextLength: 128000, maxOutputTokens: 8192, supportsTools: true, supportsThinking: false } },
  { pattern: "qwen-2.5-72b", metadata: { contextLength: 128000, maxOutputTokens: 8192, supportsTools: true, supportsThinking: false } },

  // GLM / Llama / Mistral
  { pattern: "glm-4", metadata: { contextLength: 128000, maxOutputTokens: 4096, supportsTools: true, supportsThinking: false } },
  { pattern: "glm-5", metadata: { contextLength: 128000, maxOutputTokens: 8192, supportsTools: true, supportsThinking: false } },
  { pattern: "llama-3.3-70b", metadata: { contextLength: 128000, maxOutputTokens: 4096, supportsTools: true, supportsThinking: false } },
  { pattern: "nemotron", metadata: { contextLength: 128000, maxOutputTokens: 4096, supportsTools: true, supportsThinking: false } },
];

/**
 * Lookup model metadata for a given model ID or provider/model string.
 *
 * ⚠ Falls back to a blanket 128k/4096 GUESS for anything unmatched, so a value from here is never
 * evidence. Prefer `resolveMetadata()`, which tries the provider's own published limits first and
 * labels whatever it ends up using.
 */
export function getModelMetadata(modelId: string): ModelMetadata {
  const norm = modelId.toLowerCase();
  for (const entry of DEFAULT_METADATA_TABLE) {
    if (typeof entry.pattern === "string") {
      if (norm.includes(entry.pattern)) return entry.metadata;
    } else if (entry.pattern.test(norm)) {
      return entry.metadata;
    }
  }
  return { contextLength: 128000, maxOutputTokens: 4096, supportsTools: true };
}

/**
 * Where a metadata value came from, in descending trustworthiness.
 *  - `provider`      the provider serving this target published it about its OWN deployment;
 *  - `reference`     another provider publishes it for the same model id. Deployments differ —
 *                    quantization, context caps, per-plan output limits — so this is indicative;
 *  - `static-table`  the hardcoded table in this file, including its blanket 128k/4096 guess.
 */
export type MetadataSource = "provider" | "reference" | "static-table";

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
 * Resolve a target's limits per FIELD, each with its own provenance.
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
  const table = getModelMetadata(modelId);
  const p = opts.providerLimits;
  const r = opts.reference;

  const pick = (
    provider: number | null | undefined,
    reference: number | null | undefined,
    fromTable: number | undefined,
  ): [number | null, MetadataSource | null] => {
    if (typeof provider === "number") return [provider, "provider"];
    if (typeof reference === "number") return [reference, "reference"];
    if (typeof fromTable === "number") return [fromTable, "static-table"];
    return [null, null];
  };

  const [contextLength, contextLengthSource] = pick(p?.contextLength, r?.contextLength, table.contextLength);
  const [maxOutputTokens, maxOutputTokensSource] = pick(p?.maxOutputTokens, r?.maxOutputTokens, table.maxOutputTokens);

  // Price has no hardcoded-table rung — there has never been one, and inventing a guess for what
  // something costs would be worse than saying nothing. In/out resolve together: they come from
  // one `pricing` object, so a split would report a provider's input price beside another's output.
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

/** Estimate input prompt token count from Anthropic messages request object. */
export function estimateRequestTokens(reqJson: unknown): number {
  if (typeof reqJson !== "object" || reqJson === null) return 0;
  const obj = reqJson as Record<string, unknown>;
  let text = "";

  if (typeof obj.system === "string") {
    text += obj.system;
  } else if (Array.isArray(obj.system)) {
    for (const sys of obj.system) {
      if (typeof sys === "object" && sys !== null && "text" in sys && typeof sys.text === "string") {
        text += sys.text;
      }
    }
  }

  if (Array.isArray(obj.messages)) {
    for (const msg of obj.messages) {
      if (typeof msg === "object" && msg !== null && "content" in msg) {
        const content = (msg as { content: unknown }).content;
        if (typeof content === "string") {
          text += content;
        } else if (Array.isArray(content)) {
          for (const block of content) {
            if (typeof block === "object" && block !== null && "text" in block && typeof block.text === "string") {
              text += block.text;
            }
          }
        }
      }
    }
  }

  // Rough estimation: ~4 chars per token for English/code
  return Math.ceil(text.length / 4);
}
