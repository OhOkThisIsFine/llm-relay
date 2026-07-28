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

/** Lookup model metadata for a given model ID or provider/model string. */
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
