import { useState, type ReactElement } from "react";
import {
  Check,
  CheckCircle2,
  Copy,
  ExternalLink,
  Key,
  Moon,
  RefreshCw,
  Server,
  Settings,
  Shield,
  Sun,
  Trash2,
  Unlock,
  X,
  Zap,
} from "lucide-react";

export function SettingsDialog({
  open,
  onClose,
  theme,
  onToggleTheme,
  controlToken,
  onSetControlToken,
}: Readonly<{
  open: boolean;
  onClose: () => void;
  theme: "light" | "dark";
  onToggleTheme: () => void;
  controlToken: string;
  onSetControlToken: (token: string) => void;
}>): ReactElement | null {
  const [tokenInput, setTokenInput] = useState(controlToken);
  const [tokenNotice, setTokenNotice] = useState<string | null>(null);
  const [clearingCooldowns, setClearingCooldowns] = useState(false);
  const [cooldownNotice, setCooldownNotice] = useState<string | null>(null);
  const [copiedEndpoint, setCopiedEndpoint] = useState<string | null>(null);

  if (!open) return null;

  const handleSaveToken = (e: React.FormEvent) => {
    e.preventDefault();
    const val = tokenInput.trim();
    onSetControlToken(val);
    setTokenNotice(val ? "Control token saved in memory for this session." : "Control token cleared.");
    setTimeout(() => setTokenNotice(null), 2500);
  };

  const handleClearCooldowns = async () => {
    setClearingCooldowns(true);
    setCooldownNotice(null);
    try {
      const headers: Record<string, string> = { "Content-Type": "application/json" };
      if (controlToken) headers["x-llm-relay-control-token"] = controlToken;
      const res = await fetch("/cooldowns/clear", { method: "POST", headers });
      if (res.ok) {
        setCooldownNotice("Cooldowns and circuit breakers cleared.");
      } else {
        setCooldownNotice(`Failed to clear cooldowns (HTTP ${res.status}).`);
      }
    } catch {
      setCooldownNotice("Failed to reach relay endpoint.");
    } finally {
      setClearingCooldowns(false);
      setTimeout(() => setCooldownNotice(null), 3000);
    }
  };

  const copyEndpoint = (url: string, key: string) => {
    void navigator.clipboard.writeText(url);
    setCopiedEndpoint(key);
    setTimeout(() => setCopiedEndpoint(null), 2000);
  };

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-labelledby="settings-dialog-title"
      style={{
        position: "fixed",
        inset: 0,
        backgroundColor: "rgba(0, 0, 0, 0.6)",
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        zIndex: 50,
        padding: "1rem",
      }}
      onClick={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div
        style={{
          backgroundColor: "var(--surface)",
          color: "var(--ink)",
          border: "1px solid var(--border)",
          borderRadius: "0.75rem",
          maxWidth: "36rem",
          width: "100%",
          maxHeight: "90vh",
          overflowY: "auto",
          boxShadow: "0 25px 50px -12px rgba(0, 0, 0, 0.4)",
        }}
      >
        {/* Header */}
        <div
          style={{
            padding: "1rem 1.25rem",
            borderBottom: "1px solid var(--border)",
            display: "flex",
            alignItems: "center",
            justifyContent: "space-between",
          }}
        >
          <div style={{ display: "flex", alignItems: "center", gap: "0.5rem" }}>
            <Settings size={18} style={{ color: "var(--accent)" }} />
            <h2 id="settings-dialog-title" style={{ margin: 0, fontSize: "1.1rem", fontWeight: 700 }}>
              Relay Dashboard Settings
            </h2>
          </div>
          <button
            type="button"
            onClick={onClose}
            aria-label="Close settings"
            style={{
              background: "transparent",
              border: "none",
              color: "var(--muted)",
              cursor: "pointer",
              padding: "0.25rem",
              borderRadius: "0.25rem",
            }}
          >
            <X size={18} />
          </button>
        </div>

        {/* Body */}
        <div style={{ padding: "1.25rem", display: "flex", flexDirection: "column", gap: "1.25rem" }}>
          {/* Section: Server Info */}
          <section style={{ padding: "0.85rem", borderRadius: "0.5rem", background: "var(--row-hover)", border: "1px solid var(--border)" }}>
            <div style={{ display: "flex", alignItems: "center", gap: "0.5rem", marginBottom: "0.5rem" }}>
              <Server size={16} style={{ color: "var(--accent)" }} />
              <span style={{ fontWeight: 600, fontSize: "0.875rem" }}>Relay Daemon</span>
              <span style={{ marginLeft: "auto", fontSize: "0.75rem", padding: "0.15rem 0.5rem", borderRadius: "9999px", background: "#10b98120", color: "#10b981", fontWeight: 600 }}>
                ● Active on :8791
              </span>
            </div>
            <div style={{ fontSize: "0.8rem", color: "var(--muted)", display: "grid", gridTemplateColumns: "1fr 1fr", gap: "0.4rem" }}>
              <div>Loopback: <code style={{ color: "var(--ink)" }}>127.0.0.1:8791</code></div>
              <div>Mode: <span style={{ color: "var(--ink)", fontWeight: 500 }}>Loopback Control Plane</span></div>
              <div>Wire APIs: <span style={{ color: "var(--ink)" }}>OpenAI + Anthropic</span></div>
              <div>Failover: <span style={{ color: "var(--ink)" }}>Automatic Multi-Provider</span></div>
            </div>
          </section>

          {/* Section: Appearance */}
          <section>
            <h3 style={{ fontSize: "0.875rem", fontWeight: 600, margin: "0 0 0.5rem", color: "var(--ink)" }}>
              Appearance
            </h3>
            <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", padding: "0.6rem 0.85rem", borderRadius: "0.5rem", border: "1px solid var(--border)", background: "var(--surface)" }}>
              <div>
                <div style={{ fontSize: "0.85rem", fontWeight: 500 }}>Interface Theme</div>
                <div style={{ fontSize: "0.75rem", color: "var(--muted)" }}>Toggle between light and dark UI themes</div>
              </div>
              <button
                type="button"
                onClick={onToggleTheme}
                style={{
                  display: "inline-flex",
                  alignItems: "center",
                  gap: "0.4rem",
                  padding: "0.35rem 0.75rem",
                  fontSize: "0.8rem",
                  borderRadius: "0.375rem",
                  border: "1px solid var(--border)",
                  background: "var(--row-hover)",
                  color: "var(--ink)",
                  cursor: "pointer",
                }}
              >
                {theme === "dark" ? <Sun size={14} /> : <Moon size={14} />}
                {theme === "dark" ? "Light Mode" : "Dark Mode"}
              </button>
            </div>
          </section>

          {/* Section: Operator Control Token */}
          <section>
            <div style={{ display: "flex", alignItems: "center", gap: "0.4rem", marginBottom: "0.35rem" }}>
              <Shield size={16} style={{ color: controlToken ? "#10b981" : "var(--muted)" }} />
              <h3 style={{ fontSize: "0.875rem", fontWeight: 600, margin: 0, color: "var(--ink)" }}>
                Operator Control Token
              </h3>
              {controlToken && (
                <span style={{ fontSize: "0.7rem", padding: "0.1rem 0.4rem", borderRadius: "0.25rem", background: "#10b98120", color: "#10b981", fontWeight: 600 }}>
                  Unlocked
                </span>
              )}
            </div>
            <p style={{ fontSize: "0.75rem", color: "var(--muted)", margin: "0 0 0.6rem" }}>
              Required for write actions (pinning/unpinning ladder rungs and resetting circuit breakers). Token is stored strictly in memory for this session and never saved to storage.
            </p>
            <form onSubmit={handleSaveToken} style={{ display: "flex", gap: "0.5rem" }}>
              <input
                type="password"
                value={tokenInput}
                onChange={(e) => setTokenInput(e.target.value)}
                placeholder="Paste operator token from ~/.llm-relay/control-token…"
                style={{
                  flex: 1,
                  padding: "0.4rem 0.65rem",
                  fontSize: "0.8125rem",
                  borderRadius: "0.375rem",
                  border: "1px solid var(--border)",
                  backgroundColor: "var(--surface)",
                  color: "var(--ink)",
                  fontFamily: "monospace",
                }}
              />
              <button
                type="submit"
                style={{
                  padding: "0.4rem 0.85rem",
                  fontSize: "0.8125rem",
                  fontWeight: 600,
                  borderRadius: "0.375rem",
                  border: "none",
                  backgroundColor: "var(--accent)",
                  color: "#ffffff",
                  cursor: "pointer",
                }}
              >
                Save
              </button>
            </form>
            {tokenNotice && (
              <p style={{ fontSize: "0.75rem", color: "#10b981", margin: "0.35rem 0 0", fontWeight: 500 }}>
                {tokenNotice}
              </p>
            )}
          </section>

          {/* Section: Circuit Breakers & Cooldowns */}
          <section>
            <h3 style={{ fontSize: "0.875rem", fontWeight: 600, margin: "0 0 0.5rem", color: "var(--ink)" }}>
              Circuit Breakers &amp; Quota Recovery
            </h3>
            <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", padding: "0.6rem 0.85rem", borderRadius: "0.5rem", border: "1px solid var(--border)", background: "var(--surface)" }}>
              <div>
                <div style={{ fontSize: "0.85rem", fontWeight: 500 }}>Clear Active Cooldowns</div>
                <div style={{ fontSize: "0.75rem", color: "var(--muted)" }}>Reset backoff timers for all rate-limited backends</div>
              </div>
              <button
                type="button"
                onClick={() => void handleClearCooldowns()}
                disabled={clearingCooldowns}
                style={{
                  display: "inline-flex",
                  alignItems: "center",
                  gap: "0.4rem",
                  padding: "0.35rem 0.75rem",
                  fontSize: "0.8rem",
                  borderRadius: "0.375rem",
                  border: "1px solid var(--border)",
                  background: "var(--row-hover)",
                  color: "var(--danger)",
                  cursor: clearingCooldowns ? "wait" : "pointer",
                  fontWeight: 500,
                }}
              >
                <RefreshCw size={13} className={clearingCooldowns ? "animate-spin" : ""} />
                {clearingCooldowns ? "Clearing…" : "Clear Cooldowns"}
              </button>
            </div>
            {cooldownNotice && (
              <p style={{ fontSize: "0.75rem", color: "var(--accent)", margin: "0.35rem 0 0" }}>
                {cooldownNotice}
              </p>
            )}
          </section>

          {/* Section: Quick Endpoint Reference */}
          <section>
            <h3 style={{ fontSize: "0.875rem", fontWeight: 600, margin: "0 0 0.5rem", color: "var(--ink)" }}>
              API Endpoints
            </h3>
            <div style={{ display: "flex", flexDirection: "column", gap: "0.35rem", fontSize: "0.75rem", fontFamily: "monospace" }}>
              {[
                { label: "OpenAI Chat", url: "http://127.0.0.1:8791/v1/chat/completions", key: "chat" },
                { label: "Anthropic Messages", url: "http://127.0.0.1:8791/v1/messages", key: "messages" },
                { label: "Models List", url: "http://127.0.0.1:8791/v1/models", key: "models" },
                { label: "Dispatch Ladder", url: "http://127.0.0.1:8791/dispatch", key: "dispatch" },
                { label: "Telemetry & Health", url: "http://127.0.0.1:8791/telemetry", key: "telemetry" },
              ].map((ep) => (
                <div
                  key={ep.key}
                  style={{
                    display: "flex",
                    alignItems: "center",
                    justifyContent: "space-between",
                    padding: "0.35rem 0.5rem",
                    borderRadius: "0.25rem",
                    background: "var(--row-hover)",
                  }}
                >
                  <span style={{ color: "var(--muted)", width: "130px" }}>{ep.label}:</span>
                  <span style={{ color: "var(--ink)", flex: 1, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                    {ep.url}
                  </span>
                  <button
                    type="button"
                    onClick={() => copyEndpoint(ep.url, ep.key)}
                    style={{
                      background: "transparent",
                      border: "none",
                      color: copiedEndpoint === ep.key ? "#10b981" : "var(--muted)",
                      cursor: "pointer",
                      padding: "0.2rem",
                    }}
                    title="Copy URL"
                  >
                    {copiedEndpoint === ep.key ? <Check size={12} /> : <Copy size={12} />}
                  </button>
                </div>
              ))}
            </div>
          </section>
        </div>

        {/* Footer */}
        <div
          style={{
            padding: "0.75rem 1.25rem",
            borderTop: "1px solid var(--border)",
            display: "flex",
            justifyContent: "flex-end",
          }}
        >
          <button
            type="button"
            onClick={onClose}
            style={{
              padding: "0.4rem 1rem",
              fontSize: "0.8125rem",
              borderRadius: "0.375rem",
              border: "1px solid var(--border)",
              background: "var(--surface)",
              color: "var(--ink)",
              cursor: "pointer",
              fontWeight: 500,
            }}
          >
            Done
          </button>
        </div>
      </div>
    </div>
  );
}
