import { useCallback, useEffect, useState, type ReactElement } from "react";
import {
  AlertTriangle,
  Check,
  CheckCircle2,
  Clock,
  Copy,
  ExternalLink,
  KeyRound,
  RefreshCw,
  Shield,
  Trash2,
  Unlock,
  Zap,
} from "lucide-react";
import { PlatformDot } from "../components/PlatformDot.js";
import { StatusBadge } from "../components/StatusBadge.js";
import { percent, relativeTime, stamp } from "../formatters.js";

interface ProviderPreset {
  readonly id: string;
  readonly name: string;
  readonly authEnv: string;
  readonly tierType: "free" | "credits" | "mixed" | "paid";
  readonly signupUrl: string;
  readonly models: readonly string[];
  readonly description: string;
}

const PROVIDER_PRESETS: readonly ProviderPreset[] = [
  {
    id: "gemini",
    name: "Google Gemini",
    authEnv: "GEMINI_API_KEY",
    tierType: "free",
    signupUrl: "https://aistudio.google.com/app/apikey",
    models: ["gemini-2.5-flash", "gemini-2.5-pro", "gemini-1.5-flash"],
    description: "Free rate-limited tier via Google AI Studio. Excellent speed and large 1M+ context.",
  },
  {
    id: "groq",
    name: "Groq",
    authEnv: "GROQ_API_KEY",
    tierType: "free",
    signupUrl: "https://console.groq.com/keys",
    models: ["llama-3.3-70b-versatile", "llama-3.1-8b-instant", "mixtral-8x7b-32768"],
    description: "Ultra-fast LPU inference with generous free-tier requests per minute.",
  },
  {
    id: "deepseek",
    name: "DeepSeek",
    authEnv: "DEEPSEEK_API_KEY",
    tierType: "mixed",
    signupUrl: "https://platform.deepseek.com",
    models: ["deepseek-chat", "deepseek-reasoner"],
    description: "DeepSeek V3 and R1 reasoning models with low token pricing.",
  },
  {
    id: "openrouter",
    name: "OpenRouter",
    authEnv: "OPENROUTER_API_KEY",
    tierType: "free",
    signupUrl: "https://openrouter.ai/keys",
    models: ["meta-llama/llama-3.3-70b-instruct:free", "qwen/qwen-2.5-coder-32b-instruct:free"],
    description: "Unified aggregator providing dozens of 100% free models with `:free` suffix.",
  },
  {
    id: "nim",
    name: "NVIDIA NIM",
    authEnv: "NVIDIA_API_KEY",
    tierType: "credits",
    signupUrl: "https://build.nvidia.com",
    models: ["meta/llama-3.1-70b-instruct", "nvidia/nemotron-3-super-120b-a12b"],
    description: "Free initial developer credits on NVIDIA hosted infrastructure.",
  },
  {
    id: "mistral",
    name: "Mistral / Codestral",
    authEnv: "MISTRAL_API_KEY",
    tierType: "free",
    signupUrl: "https://console.mistral.ai/api-keys",
    models: ["codestral-latest", "mistral-small-latest"],
    description: "Free Codestral tier specialized for code generation and refactoring.",
  },
  {
    id: "cerebras",
    name: "Cerebras",
    authEnv: "CEREBRAS_API_KEY",
    tierType: "free",
    signupUrl: "https://cloud.cerebras.ai",
    models: ["llama3.1-70b", "llama3.1-8b"],
    description: "Fast wafer-scale inference with free developer tier limits.",
  },
  {
    id: "cohere",
    name: "Cohere",
    authEnv: "COHERE_API_KEY",
    tierType: "free",
    signupUrl: "https://dashboard.cohere.com/api-keys",
    models: ["command-r", "command-r-plus"],
    description: "Free trial keys for Command R enterprise models.",
  },
  {
    id: "huggingface",
    name: "Hugging Face",
    authEnv: "HUGGINGFACE_API_KEY",
    tierType: "free",
    signupUrl: "https://huggingface.co/settings/tokens",
    models: ["meta-llama/Llama-3.3-70B-Instruct"],
    description: "Free serverless inference API across thousands of open community models.",
  },
  {
    id: "anthropic",
    name: "Anthropic",
    authEnv: "ANTHROPIC_API_KEY",
    tierType: "paid",
    signupUrl: "https://console.anthropic.com/settings/keys",
    models: ["claude-3-5-sonnet", "claude-3-5-haiku", "claude-3-opus"],
    description: "Primary Claude models. Used for direct fallback and benchmark comparisons.",
  },
  {
    id: "ollama",
    name: "Ollama (Local)",
    authEnv: "OLLAMA_BASE_URL",
    tierType: "free",
    signupUrl: "https://ollama.com",
    models: ["qwen2.5-coder:14b", "llama3.2:3b"],
    description: "Self-hosted loopback models running on local GPU or CPU with zero external network traffic.",
  },
  {
    id: "cloudflare",
    name: "Cloudflare Workers AI",
    authEnv: "CLOUDFLARE_API_KEY",
    tierType: "free",
    signupUrl: "https://dash.cloudflare.com",
    models: ["@cf/meta/llama-3.3-70b-instruct"],
    description: "Edge serverless AI inference with free daily neuron allocations.",
  },
];

interface ProviderTelemetryItem {
  readonly provider: string;
  readonly displayName?: string;
  readonly hasKey: boolean;
  readonly isHealthy: boolean | null;
  readonly lastStatus?: number | undefined;
  readonly cooldownRemainingMs: number;
}

interface TelemetryResponse {
  readonly activeProvidersCount?: number | undefined;
  readonly healthyProvidersCount?: number | undefined;
  readonly providers?: readonly ProviderTelemetryItem[] | undefined;
  readonly config?: { readonly stale: boolean; readonly reason?: string | undefined } | undefined;
}

interface CooldownEntry {
  readonly credentialId?: string | undefined;
  readonly provider: string;
  readonly deployment?: string | null | undefined;
  readonly reason: string;
  readonly until: string;
  readonly observedAt: string;
}

export function KeysProvidersPage(): ReactElement {
  const [telemetry, setTelemetry] = useState<TelemetryResponse | null>(null);
  const [cooldowns, setCooldowns] = useState<readonly CooldownEntry[]>([]);
  const [loading, setLoading] = useState(false);
  const [checking, setChecking] = useState(false);
  const [copiedKey, setCopiedKey] = useState<string | null>(null);
  const [clearingCooldown, setClearingCooldown] = useState(false);
  const [actionNotice, setActionNotice] = useState<string | null>(null);

  const loadData = useCallback(async () => {
    setLoading(true);
    try {
      const [telRes, snapRes] = await Promise.all([
        fetch("/telemetry", { headers: { Accept: "application/json" } }).catch(() => null),
        fetch("/candidates", { headers: { Accept: "application/json" } }).catch(() => null),
      ]);
      if (telRes && telRes.ok) {
        const telJson = (await telRes.json()) as TelemetryResponse;
        setTelemetry(telJson);

        // Derive active cooldowns from telemetry providers if present
        if (Array.isArray(telJson.providers)) {
          const list: CooldownEntry[] = [];
          for (const p of telJson.providers) {
            if (p.cooldownRemainingMs > 0) {
              list.push({
                provider: p.provider,
                reason: p.lastStatus ? `HTTP ${p.lastStatus}` : "Cooldown backoff",
                until: new Date(Date.now() + p.cooldownRemainingMs).toISOString(),
                observedAt: new Date().toISOString(),
              });
            }
          }
          if (list.length > 0) {
            setCooldowns(list);
          } else {
            setCooldowns([]);
          }
        }
      }
      if (snapRes && snapRes.ok) {
        const snapJson = (await snapRes.json()) as { cooldowns?: readonly CooldownEntry[] };
        if (Array.isArray(snapJson.cooldowns) && snapJson.cooldowns.length > 0) {
          setCooldowns(snapJson.cooldowns);
        }
      }
    } catch {
      // Best-effort read
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void loadData();
  }, [loadData]);

  const checkAllProviders = async () => {
    setChecking(true);
    setActionNotice(null);
    try {
      const res = await fetch("/ping", { headers: { Accept: "application/json" } });
      if (res.ok) {
        setActionNotice("Fleet check initiated. Refreshing provider metrics...");
        setTimeout(() => {
          void loadData();
          setActionNotice(null);
        }, 2000);
      }
    } catch {
      setActionNotice("Failed to reach relay ping endpoint.");
    } finally {
      setChecking(false);
    }
  };

  const handleCopy = (text: string, id: string) => {
    void navigator.clipboard.writeText(text);
    setCopiedKey(id);
    setTimeout(() => setCopiedKey(null), 2000);
  };

  const handleClearCooldown = async (provider: string) => {
    setClearingCooldown(true);
    setActionNotice(null);
    try {
      const res = await fetch("/cooldowns/clear", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ provider }),
      });
      if (res.ok) {
        setActionNotice(`Cooldown cleared for ${provider}`);
        void loadData();
      } else {
        const err = await res.json().catch(() => ({}));
        setActionNotice(`Clear failed: ${(err as { message?: string }).message ?? "Unknown error"}`);
      }
    } catch {
      setActionNotice(`Failed to connect to relay.`);
    } finally {
      setClearingCooldown(false);
    }
  };

  // Determine which providers are active and healthy from telemetry.providers
  const activeSet = new Set(
    (telemetry?.providers ?? [])
      .filter((p) => p.hasKey)
      .map((p) => p.provider.toLowerCase().trim())
  );
  const healthySet = new Set(
    (telemetry?.providers ?? [])
      .filter((p) => p.isHealthy === true)
      .map((p) => p.provider.toLowerCase().trim())
  );

  const configuredCount = PROVIDER_PRESETS.filter(
    (p) => activeSet.has(p.id) || activeSet.has(p.name.toLowerCase())
  ).length;

  return (
    <div style={{ maxWidth: "1400px", margin: "0 auto", padding: "1rem" }}>
      {/* Top Header */}
      <div
        style={{
          display: "flex",
          justifyContent: "space-between",
          alignItems: "flex-start",
          flexWrap: "wrap",
          gap: "1rem",
          marginBottom: "1.5rem",
        }}
      >
        <div>
          <h1 style={{ margin: "0 0 0.25rem", fontSize: "1.6rem", fontWeight: 700 }}>
            Keys &amp; Providers
          </h1>
          <p style={{ margin: 0, color: "var(--muted)", fontSize: "0.9rem" }}>
            Provider configurations, free-tier signup links, and live fleet health.
          </p>
        </div>

        <div style={{ display: "flex", gap: "0.5rem", alignItems: "center" }}>
          <button
            type="button"
            onClick={() => void loadData()}
            disabled={loading}
            style={{
              display: "inline-flex",
              alignItems: "center",
              gap: "0.4rem",
              padding: "0.45rem 0.85rem",
              fontSize: "0.85rem",
            }}
          >
            <RefreshCw size={14} className={loading ? "animate-spin" : ""} /> Refresh
          </button>
          <button
            type="button"
            onClick={() => void checkAllProviders()}
            disabled={checking}
            style={{
              display: "inline-flex",
              alignItems: "center",
              gap: "0.4rem",
              padding: "0.45rem 0.85rem",
              fontSize: "0.85rem",
              background: "var(--accent)",
              color: "#fff",
              border: "none",
              fontWeight: 600,
            }}
          >
            <Zap size={14} /> {checking ? "Checking..." : "Check All Providers"}
          </button>
        </div>
      </div>

      {actionNotice && (
        <div
          style={{
            padding: "0.6rem 1rem",
            marginBottom: "1.25rem",
            borderRadius: "0.5rem",
            background: "rgba(59, 130, 246, 0.12)",
            border: "1px solid rgba(59, 130, 246, 0.3)",
            color: "var(--accent)",
            fontSize: "0.85rem",
          }}
        >
          {actionNotice}
        </div>
      )}

      {/* Coverage summary banner */}
      <section
        style={{
          background: "var(--surface)",
          border: "1px solid var(--border)",
          borderRadius: "1rem",
          padding: "1rem 1.25rem",
          marginBottom: "1.5rem",
          display: "flex",
          justifyContent: "space-between",
          alignItems: "center",
          flexWrap: "wrap",
          gap: "1rem",
        }}
      >
        <div style={{ display: "flex", alignItems: "center", gap: "1rem" }}>
          <div
            style={{
              width: "2.5rem",
              height: "2.5rem",
              borderRadius: "0.5rem",
              background: "rgba(16, 185, 129, 0.12)",
              display: "flex",
              alignItems: "center",
              justifyContent: "center",
              color: "#10b981",
            }}
          >
            <KeyRound size={20} />
          </div>
          <div>
            <div style={{ fontWeight: 600, fontSize: "1rem" }}>
              {configuredCount} of {PROVIDER_PRESETS.length} providers configured
            </div>
            <div style={{ color: "var(--muted)", fontSize: "0.8rem", marginTop: "0.15rem" }}>
              {telemetry?.healthyProvidersCount ?? 0} providers currently responding to health checks
            </div>
          </div>
        </div>

        <div style={{ display: "flex", gap: "0.4rem", flexWrap: "wrap" }}>
          {PROVIDER_PRESETS.map((p) => {
            const isConfigured = activeSet.has(p.id) || activeSet.has(p.name.toLowerCase());
            return (
              <span
                key={p.id}
                style={{
                  display: "inline-flex",
                  alignItems: "center",
                  gap: "0.3rem",
                  padding: "0.2rem 0.5rem",
                  borderRadius: "9999px",
                  fontSize: "0.75rem",
                  background: isConfigured ? "rgba(16, 185, 129, 0.12)" : "var(--row-hover)",
                  color: isConfigured ? "#059669" : "var(--muted)",
                  border: `1px solid ${isConfigured ? "rgba(16, 185, 129, 0.25)" : "var(--border)"}`,
                }}
              >
                <PlatformDot provider={p.id} />
                {p.name}
                {isConfigured && <Check size={12} />}
              </span>
            );
          })}
        </div>
      </section>

      {/* Unified Relay Endpoint & Local API Key */}
      <section
        style={{
          background: "var(--surface)",
          border: "1px solid var(--border)",
          borderRadius: "0.85rem",
          padding: "1.25rem",
          marginBottom: "1.5rem",
          display: "flex",
          flexDirection: "column",
          gap: "0.75rem",
        }}
      >
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", flexWrap: "wrap", gap: "0.5rem" }}>
          <div>
            <h3 style={{ margin: 0, fontSize: "1rem", fontWeight: 700 }}>Unified Relay Endpoint &amp; Key</h3>
            <p className="muted" style={{ margin: "0.2rem 0 0", fontSize: "0.8rem" }}>
              Configure your developer tools, SDKs, and local agents to point directly at this relay loopback.
            </p>
          </div>
          <button
            type="button"
            onClick={() => handleCopy("http://127.0.0.1:8791/v1", "endpoint")}
            style={{
              display: "inline-flex",
              alignItems: "center",
              gap: "0.35rem",
              padding: "0.3rem 0.65rem",
              fontSize: "0.75rem",
              borderRadius: "0.375rem",
              border: "1px solid var(--border)",
              background: "var(--row-hover)",
              cursor: "pointer",
            }}
          >
            {copiedKey === "endpoint" ? <Check size={12} color="#10b981" /> : <Copy size={12} />}
            <span>{copiedKey === "endpoint" ? "Copied Endpoint" : "Copy Endpoint"}</span>
          </button>
        </div>

        <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(280px, 1fr))", gap: "0.75rem", marginTop: "0.25rem" }}>
          <div style={{ padding: "0.75rem", borderRadius: "0.5rem", backgroundColor: "var(--card)", border: "1px solid var(--border)" }}>
            <span style={{ display: "block", fontSize: "0.7rem", textTransform: "uppercase", color: "var(--muted-foreground)", fontWeight: 600 }}>
              Base URL
            </span>
            <code style={{ fontSize: "0.85rem", fontFamily: "monospace", color: "var(--foreground)", fontWeight: 600 }}>
              http://127.0.0.1:8791/v1
            </code>
          </div>
          <div style={{ padding: "0.75rem", borderRadius: "0.5rem", backgroundColor: "var(--card)", border: "1px solid var(--border)", display: "flex", justifyContent: "space-between", alignItems: "center", gap: "0.5rem" }}>
            <div>
              <span style={{ display: "block", fontSize: "0.7rem", textTransform: "uppercase", color: "var(--muted-foreground)", fontWeight: 600 }}>
                API Key / Auth Header
              </span>
              <code style={{ fontSize: "0.85rem", fontFamily: "monospace", color: "var(--muted-foreground)" }}>
                Bearer loopback <span style={{ fontSize: "0.75rem", opacity: 0.8 }}>(relay accepts any local token)</span>
              </code>
            </div>
            <button
              type="button"
              onClick={() => handleCopy("relay-loopback", "apikey")}
              style={{
                display: "inline-flex",
                alignItems: "center",
                gap: "0.3rem",
                padding: "0.25rem 0.5rem",
                fontSize: "0.72rem",
                borderRadius: "0.375rem",
                border: "1px solid var(--border)",
                background: "var(--row-hover)",
                cursor: "pointer",
                flexShrink: 0,
              }}
            >
              {copiedKey === "apikey" ? <Check size={11} color="#10b981" /> : <Copy size={11} />}
              <span>{copiedKey === "apikey" ? "Copied" : "Copy Key"}</span>
            </button>
          </div>
        </div>
      </section>

      {/* Provider Cards Grid */}
      <h2 style={{ fontSize: "1.1rem", fontWeight: 600, marginBottom: "0.75rem" }}>
        Supported Providers &amp; Free Tiers
      </h2>
      <div
        style={{
          display: "grid",
          gridTemplateColumns: "repeat(auto-fill, minmax(320px, 1fr))",
          gap: "1rem",
          marginBottom: "2rem",
        }}
      >
        {PROVIDER_PRESETS.map((provider) => {
          const isConfigured =
            activeSet.has(provider.id) || activeSet.has(provider.name.toLowerCase());
          const isHealthy =
            healthySet.has(provider.id) || healthySet.has(provider.name.toLowerCase());
          const setCmd = `llm-relay keys --set ${provider.id}`;

          return (
            <div
              key={provider.id}
              style={{
                background: "var(--surface)",
                border: "1px solid var(--border)",
                borderRadius: "0.85rem",
                padding: "1rem",
                display: "flex",
                flexDirection: "column",
                justifyContent: "space-between",
                gap: "0.75rem",
              }}
            >
              <div>
                <div
                  style={{
                    display: "flex",
                    justifyContent: "space-between",
                    alignItems: "center",
                    marginBottom: "0.5rem",
                  }}
                >
                  <div style={{ display: "flex", alignItems: "center", gap: "0.4rem" }}>
                    <PlatformDot provider={provider.id} />
                    <span style={{ fontWeight: 650, fontSize: "0.95rem" }}>{provider.name}</span>
                  </div>
                  <div style={{ display: "flex", alignItems: "center", gap: "0.35rem" }}>
                    <span
                      style={{
                        fontSize: "0.7rem",
                        padding: "0.1rem 0.4rem",
                        borderRadius: "0.25rem",
                        background: "var(--row-hover)",
                        color: "var(--muted)",
                        fontWeight: 600,
                        textTransform: "uppercase",
                      }}
                    >
                      {provider.tierType}
                    </span>
                    {isConfigured ? (
                      <span
                        style={{
                          fontSize: "0.72rem",
                          padding: "0.1rem 0.45rem",
                          borderRadius: "9999px",
                          background: isHealthy ? "rgba(16, 185, 129, 0.15)" : "rgba(245, 158, 11, 0.15)",
                          color: isHealthy ? "#059669" : "#d97706",
                          fontWeight: 600,
                          display: "inline-flex",
                          alignItems: "center",
                          gap: "0.25rem",
                        }}
                      >
                        <CheckCircle2 size={12} /> {isHealthy ? "Active & Healthy" : "Configured"}
                      </span>
                    ) : (
                      <span
                        style={{
                          fontSize: "0.72rem",
                          padding: "0.1rem 0.45rem",
                          borderRadius: "9999px",
                          background: "var(--row-hover)",
                          color: "var(--muted)",
                          border: "1px dashed var(--border)",
                        }}
                      >
                        Needs Key
                      </span>
                    )}
                  </div>
                </div>

                <p style={{ margin: "0 0 0.6rem", fontSize: "0.8rem", color: "var(--muted)", lineHeight: 1.4 }}>
                  {provider.description}
                </p>

                <div style={{ marginBottom: "0.6rem" }}>
                  <span style={{ fontSize: "0.72rem", color: "var(--muted)", display: "block", marginBottom: "0.2rem" }}>
                    Environment Variable:
                  </span>
                  <code
                    style={{
                      display: "inline-block",
                      fontSize: "0.75rem",
                      padding: "0.15rem 0.4rem",
                      borderRadius: "0.3rem",
                      background: "var(--row-hover)",
                      border: "1px solid var(--border)",
                      color: "var(--ink)",
                      fontFamily: "monospace",
                    }}
                  >
                    {provider.authEnv}
                  </code>
                </div>

                <div>
                  <span style={{ fontSize: "0.72rem", color: "var(--muted)", display: "block", marginBottom: "0.25rem" }}>
                    Popular Models:
                  </span>
                  <div style={{ display: "flex", gap: "0.3rem", flexWrap: "wrap" }}>
                    {provider.models.map((m) => (
                      <span
                        key={m}
                        style={{
                          fontSize: "0.7rem",
                          padding: "0.1rem 0.35rem",
                          borderRadius: "0.25rem",
                          background: "var(--row-hover)",
                          color: "var(--muted)",
                          fontFamily: "monospace",
                        }}
                      >
                        {m}
                      </span>
                    ))}
                  </div>
                </div>
              </div>

              <div
                style={{
                  borderTop: "1px solid var(--border)",
                  paddingTop: "0.65rem",
                  display: "flex",
                  justifyContent: "space-between",
                  alignItems: "center",
                  gap: "0.5rem",
                }}
              >
                <a
                  href={provider.signupUrl}
                  target="_blank"
                  rel="noopener noreferrer"
                  style={{
                    display: "inline-flex",
                    alignItems: "center",
                    gap: "0.3rem",
                    fontSize: "0.78rem",
                    color: "var(--accent)",
                    textDecoration: "none",
                    fontWeight: 500,
                  }}
                >
                  Get Free Key <ExternalLink size={12} />
                </a>

                <button
                  type="button"
                  onClick={() => handleCopy(setCmd, provider.id)}
                  style={{
                    display: "inline-flex",
                    alignItems: "center",
                    gap: "0.3rem",
                    fontSize: "0.75rem",
                    padding: "0.25rem 0.5rem",
                    background: "transparent",
                    borderColor: "var(--border)",
                  }}
                >
                  {copiedKey === provider.id ? <Check size={12} color="#10b981" /> : <Copy size={12} />}
                  {copiedKey === provider.id ? "Copied" : "Copy CLI Setup"}
                </button>
              </div>
            </div>
          );
        })}
      </div>

      {/* Cooldown & Circuit Breaker Section */}
      <h2 style={{ fontSize: "1.1rem", fontWeight: 600, marginBottom: "0.75rem" }}>
        Active Cooldowns &amp; Circuit Breakers
      </h2>
      <div
        style={{
          background: "var(--surface)",
          border: "1px solid var(--border)",
          borderRadius: "0.85rem",
          overflow: "hidden",
          marginBottom: "2rem",
        }}
      >
        {cooldowns.length === 0 ? (
          <div style={{ padding: "2rem", textAlign: "center", color: "var(--muted)" }}>
            <CheckCircle2 size={32} style={{ margin: "0 auto 0.5rem", color: "#10b981" }} />
            <div style={{ fontWeight: 600, color: "var(--ink)" }}>All providers healthy</div>
            <p style={{ margin: "0.25rem 0 0", fontSize: "0.85rem" }}>
              No active cooldowns or rate-limit circuit breakers currently tripped.
            </p>
          </div>
        ) : (
          <table className="responsive-table">
            <thead>
              <tr>
                <th>Provider / Deployment</th>
                <th>Credential</th>
                <th>Reason</th>
                <th>Cooling Until</th>
                <th>Observed</th>
                <th>Actions</th>
              </tr>
            </thead>
            <tbody>
              {cooldowns.map((row) => (
                <tr key={`${row.provider}-${row.reason}-${row.until}`}>
                  <td>
                    <span className="inline-flex items-center gap-1">
                      <PlatformDot provider={row.provider} />
                      <strong>{row.provider}</strong>
                    </span>
                    {row.deployment && <small className="muted"> · {row.deployment}</small>}
                  </td>
                  <td>{row.credentialId ?? "default"}</td>
                  <td>
                    <StatusBadge value={row.reason} />
                  </td>
                  <td>
                    <span title={stamp(row.until)}>{relativeTime(row.until)}</span>
                  </td>
                  <td>
                    <span title={stamp(row.observedAt)}>{relativeTime(row.observedAt)}</span>
                  </td>
                  <td>
                    <button
                      type="button"
                      onClick={() => void handleClearCooldown(row.provider)}
                      disabled={clearingCooldown}
                      style={{
                        padding: "0.25rem 0.5rem",
                        fontSize: "0.75rem",
                        display: "inline-flex",
                        alignItems: "center",
                        gap: "0.3rem",
                      }}
                    >
                      <Trash2 size={12} /> Clear Cooldown
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
    </div>
  );
}
