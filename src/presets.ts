import type { ProviderConfig, ProviderTierType } from "./config.js";

export interface PresetProvider extends ProviderConfig {
  name: string;
  displayName: string;
  signupUrl?: string;
  tierType: ProviderTierType;
  recommendedModels: string[];
}

/** Providers offering free models or free-tier quota, with direct signup URLs. */
export const FREE_PROVIDER_PRESETS: Record<string, PresetProvider> = {
  nim: {
    name: "nim",
    displayName: "NVIDIA NIM (Free Credits)",
    base: "https://integrate.api.nvidia.com/v1",
    kind: "openai",
    authEnv: "NVIDIA_API_KEY",
    authHeader: "authorization",
    timeoutMs: 120000,
    tierType: "free",
    signupUrl: "https://build.nvidia.com",
    recommendedModels: [
      "z-ai/glm-5.2",
      "nvidia/nemotron-3-super-120b-a12b",
      "meta/llama-3.1-70b-instruct",
      "meta/llama-3.1-8b-instruct",
    ],
  },
  groq: {
    name: "groq",
    displayName: "Groq (Free Tier)",
    base: "https://api.groq.com/openai/v1",
    kind: "openai",
    authEnv: "GROQ_API_KEY",
    authHeader: "authorization",
    timeoutMs: 60000,
    tierType: "free",
    signupUrl: "https://console.groq.com/keys",
    recommendedModels: [
      "llama-3.3-70b-versatile",
      "llama-3.1-8b-instant",
      "mixtral-8x7b-32768",
    ],
  },
  gemini: {
    name: "gemini",
    displayName: "Google Gemini AI Studio (Free Tier)",
    base: "https://generativelanguage.googleapis.com/v1beta/openai",
    kind: "openai",
    authEnv: "GEMINI_API_KEY",
    authHeader: "authorization",
    timeoutMs: 120000,
    tierType: "free",
    signupUrl: "https://aistudio.google.com/app/apikey",
    recommendedModels: [
      "gemini-2.5-flash",
      "gemini-2.5-pro",
      "gemini-1.5-flash",
    ],
  },
  openrouter: {
    name: "openrouter",
    displayName: "OpenRouter (Free Models)",
    base: "https://openrouter.ai/api/v1",
    kind: "openai",
    authEnv: "OPENROUTER_API_KEY",
    authHeader: "authorization",
    timeoutMs: 120000,
    tierType: "mixed",
    signupUrl: "https://openrouter.ai/keys",
    recommendedModels: [
      "openrouter/free",
      "meta-llama/llama-3.3-70b-instruct",
      "qwen/qwen-2.5-coder-32b-instruct",
    ],
  },
  cerebras: {
    name: "cerebras",
    displayName: "Cerebras Inference (Free Tier)",
    base: "https://api.cerebras.ai/v1",
    kind: "openai",
    authEnv: "CEREBRAS_API_KEY",
    authHeader: "authorization",
    timeoutMs: 30000,
    tierType: "free",
    signupUrl: "https://cloud.cerebras.ai",
    recommendedModels: [
      "llama3.1-70b",
      "llama3.1-8b",
    ],
  },
  cohere: {
    name: "cohere",
    displayName: "Cohere (Free Trial)",
    base: "https://api.cohere.ai/compatibility/v1",
    kind: "openai",
    authEnv: "COHERE_API_KEY",
    authHeader: "authorization",
    timeoutMs: 60000,
    tierType: "free",
    signupUrl: "https://dashboard.cohere.com/api-keys",
    recommendedModels: [
      "command-a-03-2025",
      "command-r-plus-08-2024",
    ],
  },
  sambanova: {
    name: "sambanova",
    displayName: "SambaNova Cloud (Free Tier)",
    base: "https://api.sambanova.ai/v1",
    kind: "openai",
    authEnv: "SAMBANOVA_API_KEY",
    authHeader: "authorization",
    timeoutMs: 60000,
    tierType: "free",
    signupUrl: "https://cloud.sambanova.ai",
    recommendedModels: [
      "Meta-Llama-3.3-70B-Instruct",
      "Qwen2.5-Coder-32B-Instruct",
    ],
  },
  ollama: {
    name: "ollama",
    displayName: "Ollama (Local Inference)",
    base: "http://localhost:11434/v1",
    kind: "openai",
    authHeader: "authorization",
    timeoutMs: 120000,
    tierType: "free",
    signupUrl: "https://ollama.com",
    recommendedModels: [
      "qwen2.5-coder:32b",
      "llama3.3:70b",
      "deepseek-r1:14b",
    ],
  },
};

/** User subscription templates for pooling subscription quotas. */
export const SUBSCRIPTION_PROVIDER_PRESETS: Record<string, PresetProvider> = {
  openai: {
    name: "openai",
    displayName: "OpenAI ChatGPT / API Subscription",
    base: "https://api.openai.com/v1",
    kind: "openai",
    authEnv: "OPENAI_API_KEY",
    authHeader: "authorization",
    timeoutMs: 120000,
    tierType: "subscription",
    signupUrl: "https://platform.openai.com/api-keys",
    recommendedModels: [
      "gpt-4o",
      "gpt-4o-mini",
      "o3-mini",
    ],
  },
  anthropic: {
    name: "anthropic",
    displayName: "Anthropic Direct Subscription",
    base: "https://api.anthropic.com",
    kind: "anthropic",
    authEnv: "ANTHROPIC_API_KEY",
    authHeader: "x-api-key",
    timeoutMs: 120000,
    tierType: "subscription",
    signupUrl: "https://console.anthropic.com",
    recommendedModels: [
      "claude-3-5-sonnet-20241022",
      "claude-3-5-haiku-20241022",
    ],
  },
};

/** All available provider presets (free + subscription). */
export const ALL_PROVIDER_PRESETS: Record<string, PresetProvider> = {
  ...FREE_PROVIDER_PRESETS,
  ...SUBSCRIPTION_PROVIDER_PRESETS,
};

/** Default multi-tier routing mapping across free & subscription endpoints. */
export const DEFAULT_PRESET_ROUTING = {
  default: [
    "groq/llama-3.3-70b-versatile",
    "openrouter/openrouter/free",
    "nim/z-ai/glm-5.2",
    "gemini/gemini-2.5-flash",
    "sambanova/Meta-Llama-3.3-70B-Instruct",
    "ollama/qwen2.5-coder:32b",
  ],
  tiers: {
    opus: [
      "openai/gpt-4o",
      "nim/nvidia/nemotron-3-super-120b-a12b",
      "gemini/gemini-2.5-pro",
    ],
    sonnet: [
      "openai/gpt-4o-mini",
      "groq/llama-3.3-70b-versatile",
      "nim/z-ai/glm-5.2",
      "gemini/gemini-2.5-flash",
      "sambanova/Meta-Llama-3.3-70B-Instruct",
      "ollama/qwen2.5-coder:32b",
    ],
    haiku: [
      "groq/llama-3.1-8b-instant",
      "cerebras/llama3.1-8b",
      "nim/meta/llama-3.1-8b-instruct",
      "openrouter/openrouter/free",
      "ollama/deepseek-r1:14b",
    ],
  },
};
