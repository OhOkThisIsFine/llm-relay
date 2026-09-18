import type { ReactElement } from "react";

export const PLATFORM_COLORS: Readonly<Record<string, string>> = {
  anthropic: "#d97706",
  openai: "#10a37f",
  google: "#4285f4",
  deepseek: "#0ea5e9",
  groq: "#f55036",
  cerebras: "#8b5cf6",
  nvidia: "#76b900",
  mistral: "#f59e0b",
  openrouter: "#ec4899",
  github: "#6e7b8b",
  cohere: "#d946ef",
  cloudflare: "#f38020",
  zhipu: "#06b6d4",
  ollama: "#64748b",
  huggingface: "#ff9d00",
};

export function platformColor(provider: string | null | undefined): string {
  if (!provider) return "#94a3b8";
  const normalized = provider.toLowerCase().trim();
  return PLATFORM_COLORS[normalized] ?? "#94a3b8";
}

export function PlatformDot({ provider, className }: Readonly<{ provider: string | null | undefined; className?: string }>): ReactElement {
  const color = platformColor(provider);
  return (
    <span
      className={`platform-dot ${className ?? ""}`}
      style={{ backgroundColor: color }}
      aria-hidden="true"
    />
  );
}
