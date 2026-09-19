import { useEffect, useState, type ReactElement } from "react";
import { Activity, Bot, Check, CheckCircle2, Copy, ExternalLink, Sparkles, Terminal } from "lucide-react";
import { relativeTime, stamp } from "../formatters.js";

interface AgentDef {
  readonly id: string;
  readonly name: string;
  readonly category: "code" | "agent";
  readonly protocol: "Anthropic Messages" | "OpenAI Responses" | "OpenAI Chat";
  readonly configType: "Environment Variable" | "Config File" | "IDE Settings";
  readonly description: string;
  readonly configPath?: string;
  readonly command?: string;
  readonly envVars?: readonly [string, string][];
  readonly configSnippet: string;
  readonly clientKeys: readonly string[];
}

const AGENT_DEFS: readonly AgentDef[] = [
  {
    id: "claude-code",
    name: "Claude Code CLI",
    category: "code",
    protocol: "Anthropic Messages",
    configType: "Environment Variable",
    description: "Connect Claude Code to llm-relay loopback. Subagents automatically offload to free pools.",
    command: 'powershell -File C:\\Code\\llm-relay\\scripts\\claude-proxied.ps1',
    envVars: [
      ["ANTHROPIC_BASE_URL", "http://127.0.0.1:8791"],
      ["CLAUDE_CODE_MAX_CONTEXT_TOKENS", "131072"],
      ["RP_CONFIG_DIR", "C:\\Users\\ethan\\.llm-relay-claude"],
    ],
    configSnippet: `$env:ANTHROPIC_BASE_URL = "http://127.0.0.1:8791"
$env:CLAUDE_CODE_MAX_CONTEXT_TOKENS = "131072"
$env:RP_CONFIG_DIR = "$HOME\\.llm-relay-claude"
claude --model pool/medium`,
    clientKeys: ["claude-code", "claude", "anthropic"],
  },
  {
    id: "agy",
    name: "Antigravity CLI (AGY)",
    category: "agent",
    protocol: "Anthropic Messages",
    configType: "Config File",
    configPath: "~/.gemini/antigravity-cli/settings.json",
    description: "Google Antigravity autonomous coding agent with MCP dispatch and shell execution.",
    command: 'agy --add-dir . -p "your task"',
    configSnippet: `# Spawning an offload task with AGY:
agy --add-dir . -p "your task"

# Relay MCP dispatch loopback (no manual token required):
llm-relay dispatch -t "your task"`,
    clientKeys: ["agy", "antigravity", "antigravity-cli", "agy-gemini", "agy-claude-sonnet", "agy-claude-opus"],
  },
  {
    id: "codex",
    name: "OpenAI Codex CLI",
    category: "code",
    protocol: "OpenAI Responses",
    configType: "Config File",
    configPath: "~/.codex/config.toml",
    description: "Configures Codex CLI via the native OpenAI Responses wire API on loopback.",
    command: 'codex --model pool/high',
    configSnippet: `# ~/.codex/config.toml
[model_providers.llm_relay]
base_url = "http://127.0.0.1:8791/v1"
wire_api = "responses"
requires_key = false

[models.relay_auto]
provider = "llm_relay"
model = "auto"`,
    clientKeys: ["codex", "codex-cli", "openai-codex"],
  },
  {
    id: "opencode",
    name: "OpenCode",
    category: "code",
    protocol: "OpenAI Chat",
    configType: "Config File",
    configPath: "~/.config/opencode/opencode.json",
    description: "Terminal coding assistant configured as the relay-lane agent for headless subagent execution.",
    configSnippet: `{
  "provider": {
    "llm_relay": {
      "baseURL": "http://127.0.0.1:8791/v1",
      "models": [
        "auto",
        "pool/xhigh",
        "pool/high",
        "pool/medium",
        "pool/low"
      ]
    }
  }
}`,
    clientKeys: ["opencode", "opencode-ai", "relay-lane"],
  },
  {
    id: "cline",
    name: "Cline (VS Code)",
    category: "code",
    protocol: "OpenAI Chat",
    configType: "IDE Settings",
    description: "Autonomous coding agent extension for VS Code with tool-calling capabilities.",
    configSnippet: `API Provider: OpenAI Compatible
Base URL: http://127.0.0.1:8791/v1
API Key: relay-loopback
Model ID: auto (or pool/high)`,
    clientKeys: ["cline", "cline-bot"],
  },
  {
    id: "continue",
    name: "Continue.dev",
    category: "code",
    protocol: "OpenAI Chat",
    configType: "Config File",
    configPath: "~/.continue/config.json",
    description: "Open-source autopilot extension for VS Code and JetBrains IDEs.",
    configSnippet: `{
  "models": [
    {
      "title": "LLM Relay (Auto Pool)",
      "provider": "openai",
      "model": "auto",
      "apiBase": "http://127.0.0.1:8791/v1",
      "apiKey": "relay-loopback"
    }
  ]
}`,
    clientKeys: ["continue", "continue-dev"],
  },
  {
    id: "aider",
    name: "Aider",
    category: "code",
    protocol: "OpenAI Chat",
    configType: "Environment Variable",
    description: "AI pair programming in your terminal, with git worktree support.",
    command: "aider --openai-api-base http://127.0.0.1:8791/v1 --model openai/auto",
    configSnippet: `export OPENAI_API_BASE="http://127.0.0.1:8791/v1"
export OPENAI_API_KEY="relay-loopback"
aider --model openai/pool/high`,
    clientKeys: ["aider", "aider-chat"],
  },
  {
    id: "cursor",
    name: "Cursor",
    category: "code",
    protocol: "OpenAI Chat",
    configType: "IDE Settings",
    description: "AI code editor pointing at the local relay endpoint for model inference.",
    configSnippet: `Cursor Settings > Models > OpenAI API:
Base URL: http://127.0.0.1:8791/v1
API Key: relay-loopback
Override Model: pool/high`,
    clientKeys: ["cursor", "cursor-ai"],
  },
  {
    id: "roo-code",
    name: "Roo Code",
    category: "code",
    protocol: "OpenAI Chat",
    configType: "IDE Settings",
    description: "Community fork of Cline with custom modes, pointing at local relay pools.",
    configSnippet: `Provider: OpenAI Compatible
Base URL: http://127.0.0.1:8791/v1
API Key: relay-loopback
Model: auto`,
    clientKeys: ["roo", "roo-code"],
  },
  {
    id: "goose",
    name: "Goose CLI",
    category: "agent",
    protocol: "OpenAI Chat",
    configType: "Config File",
    configPath: "~/.config/goose/config.yaml",
    description: "Open source on-machine autonomous developer agent by Block.",
    configSnippet: `GOOSE_PROVIDER: openai
GOOSE_MODEL: auto
OPENAI_HOST: http://127.0.0.1:8791/v1
OPENAI_API_KEY: relay-loopback`,
    clientKeys: ["goose", "goose-agent"],
  },
];

interface ClientTraffic {
  readonly client: string;
  readonly requests: number;
  readonly lastSeenAt?: string | undefined;
}

export function AgentSetupPage(): ReactElement {
  const [copiedId, setCopiedId] = useState<string | null>(null);
  const [traffic, setTraffic] = useState<ReadonlyMap<string, ClientTraffic>>(new Map());
  const [shell, setShell] = useState<"ps" | "bash">(() => {
    return typeof navigator !== "undefined" && /win/i.test(navigator.platform || navigator.userAgent) ? "ps" : "bash";
  });

  useEffect(() => {
    // Check both /candidates and /dispatch for recent traffic / runs
    Promise.all([
      fetch("/candidates").then((res) => (res.ok ? res.json() : null)).catch(() => null),
      fetch("/dispatch").then((res) => (res.ok ? res.json() : null)).catch(() => null),
    ])
      .then(([candidatesData, dispatchData]: [any, any]) => {
        const map = new Map<string, ClientTraffic>();
        if (candidatesData?.accounting?.clients && Array.isArray(candidatesData.accounting.clients)) {
          for (const c of candidatesData.accounting.clients) {
            map.set(c.client.toLowerCase(), c);
          }
        }
        if (Array.isArray(dispatchData?.ladder)) {
          for (const lane of dispatchData.ladder) {
            if (lane.stats?.calls) {
              const laneId = String(lane.id).toLowerCase();
              const existing = map.get(laneId);
              const total = (existing?.requests ?? 0) + lane.stats.calls;
              map.set(laneId, {
                client: lane.id,
                requests: total,
                lastSeenAt: lane.stats.lastAt ? new Date(lane.stats.lastAt).toISOString() : undefined,
              });
              const prefix = laneId.split("-")[0];
              if (prefix && prefix !== laneId) {
                const prev = map.get(prefix);
                map.set(prefix, {
                  client: prefix,
                  requests: (prev?.requests ?? 0) + lane.stats.calls,
                  lastSeenAt: lane.stats.lastAt ? new Date(lane.stats.lastAt).toISOString() : undefined,
                });
              }
            }
          }
        }
        if (map.size > 0) {
          setTraffic(map);
        }
      })
      .catch(() => {});
  }, []);

  const copy = (text: string, id: string) => {
    void navigator.clipboard?.writeText(text);
    setCopiedId(id);
    setTimeout(() => setCopiedId(null), 2000);
  };

  const quickstartCmd = shell === "ps"
    ? `$env:ANTHROPIC_BASE_URL = "http://127.0.0.1:8791"; claude --model pool/medium`
    : `export ANTHROPIC_BASE_URL="http://127.0.0.1:8791" && claude --model pool/medium`;

  return (
    <div style={{ maxWidth: "1400px", margin: "0 auto", padding: "1rem" }}>
      {/* Top Header */}
      <div style={{ marginBottom: "1.5rem" }}>
        <h1 style={{ margin: "0 0 0.25rem", fontSize: "1.6rem", fontWeight: 700 }}>
          Agent Connection Hub
        </h1>
        <p style={{ margin: 0, color: "var(--muted)", fontSize: "0.9rem" }}>
          Configure developer agents and coding CLIs to offload work through <code>127.0.0.1:8791</code>.
        </p>
      </div>

      {/* Quickstart Banner */}
      <section
        style={{
          background: "var(--surface)",
          border: "1px solid var(--border)",
          borderRadius: "1rem",
          padding: "1.25rem",
          marginBottom: "1.75rem",
        }}
      >
        <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", flexWrap: "wrap", gap: "0.5rem", marginBottom: "0.4rem" }}>
          <div style={{ display: "flex", alignItems: "center", gap: "0.5rem" }}>
            <Sparkles size={18} style={{ color: "var(--accent)" }} />
            <h2 style={{ margin: 0, fontSize: "1rem", fontWeight: 600 }}>Quickstart: Local Loopback</h2>
          </div>
          <div style={{ display: "inline-flex", border: "1px solid var(--border)", borderRadius: "0.375rem", overflow: "hidden", fontSize: "0.75rem" }}>
            <button
              type="button"
              onClick={() => setShell("ps")}
              style={{
                padding: "0.2rem 0.55rem",
                background: shell === "ps" ? "var(--row-hover)" : "transparent",
                color: shell === "ps" ? "var(--accent)" : "var(--muted)",
                border: "none",
                fontWeight: shell === "ps" ? 650 : 400,
                cursor: "pointer",
              }}
            >
              PowerShell
            </button>
            <button
              type="button"
              onClick={() => setShell("bash")}
              style={{
                padding: "0.2rem 0.55rem",
                background: shell === "bash" ? "var(--row-hover)" : "transparent",
                color: shell === "bash" ? "var(--accent)" : "var(--muted)",
                border: "none",
                borderLeft: "1px solid var(--border)",
                fontWeight: shell === "bash" ? 650 : 400,
                cursor: "pointer",
              }}
            >
              Bash / POSIX
            </button>
          </div>
        </div>
        <p style={{ margin: "0 0 0.75rem", fontSize: "0.85rem", color: "var(--muted)", maxWidth: "700px" }}>
          The relay operates simultaneously on Anthropic Messages (<code>/v1/messages</code>), OpenAI Responses (<code>/v1/responses</code>), and OpenAI Chat (<code>/v1/chat/completions</code>).
        </p>

        <div
          style={{
            display: "flex",
            alignItems: "center",
            justifyContent: "space-between",
            background: "var(--row-hover)",
            padding: "0.6rem 0.85rem",
            borderRadius: "0.5rem",
            border: "1px solid var(--border)",
            fontFamily: "monospace",
            fontSize: "0.82rem",
            overflowX: "auto",
            gap: "1rem",
          }}
        >
          <code>{quickstartCmd}</code>
          <button
            type="button"
            onClick={() => copy(quickstartCmd, "quickstart")}
            style={{
              display: "inline-flex",
              alignItems: "center",
              gap: "0.3rem",
              padding: "0.25rem 0.6rem",
              fontSize: "0.75rem",
              background: "var(--surface)",
              flexShrink: 0,
            }}
          >
            {copiedId === "quickstart" ? <Check size={12} color="#10b981" /> : <Copy size={12} />}
            {copiedId === "quickstart" ? "Copied" : "Copy"}
          </button>
        </div>
      </section>

      {/* Agents Grid */}
      <h2 style={{ fontSize: "1.1rem", fontWeight: 600, marginBottom: "0.85rem" }}>
        Supported Developer Agents
      </h2>
      <div
        style={{
          display: "grid",
          gridTemplateColumns: "repeat(auto-fill, minmax(340px, 1fr))",
          gap: "1.25rem",
          marginBottom: "2rem",
        }}
      >
        {AGENT_DEFS.map((agent) => {
          const isCopied = copiedId === agent.id;
          // Check if traffic has been detected for this agent
          const matchedTraffic = agent.clientKeys.map((k) => traffic.get(k)).find(Boolean);
          const hasTraffic = Boolean(matchedTraffic && matchedTraffic.requests > 0);

          return (
            <div
              key={agent.id}
              style={{
                background: "var(--surface)",
                border: "1px solid var(--border)",
                borderRadius: "0.85rem",
                padding: "1.1rem",
                display: "flex",
                flexDirection: "column",
                justifyContent: "space-between",
                gap: "0.85rem",
              }}
            >
              <div>
                <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", marginBottom: "0.35rem" }}>
                  <div style={{ display: "flex", alignItems: "center", gap: "0.45rem" }}>
                    <Bot size={18} style={{ color: "var(--accent)" }} />
                    <span style={{ fontWeight: 650, fontSize: "1rem" }}>{agent.name}</span>
                  </div>
                  <span
                    style={{
                      fontSize: "0.7rem",
                      padding: "0.1rem 0.4rem",
                      borderRadius: "0.25rem",
                      background: "var(--row-hover)",
                      color: "var(--muted)",
                      fontWeight: 600,
                    }}
                  >
                    {agent.configType}
                  </span>
                </div>

                <div style={{ display: "flex", alignItems: "center", gap: "0.5rem", marginBottom: "0.6rem" }}>
                  <span
                    style={{
                      fontSize: "0.72rem",
                      color: "var(--muted)",
                      padding: "0.05rem 0.35rem",
                      borderRadius: "0.25rem",
                      border: "1px solid var(--border)",
                    }}
                  >
                    {agent.protocol}
                  </span>

                  {hasTraffic ? (
                    <span
                      style={{
                        display: "inline-flex",
                        alignItems: "center",
                        gap: "0.25rem",
                        fontSize: "0.7rem",
                        color: "#059669",
                        background: "rgba(16, 185, 129, 0.12)",
                        padding: "0.05rem 0.4rem",
                        borderRadius: "9999px",
                        fontWeight: 600,
                      }}
                    >
                      <CheckCircle2 size={11} /> Connected ({matchedTraffic?.requests} reqs)
                    </span>
                  ) : (
                    <span
                      style={{
                        display: "inline-flex",
                        alignItems: "center",
                        gap: "0.25rem",
                        fontSize: "0.7rem",
                        color: "var(--muted)",
                        background: "var(--row-hover)",
                        padding: "0.05rem 0.4rem",
                        borderRadius: "9999px",
                      }}
                    >
                      <Activity size={11} /> Ready to connect
                    </span>
                  )}
                </div>

                <p style={{ margin: "0 0 0.65rem", fontSize: "0.82rem", color: "var(--muted)", lineHeight: 1.4 }}>
                  {agent.description}
                </p>

                {agent.configPath && (
                  <div style={{ marginBottom: "0.5rem", fontSize: "0.75rem", color: "var(--muted)" }}>
                    Config file: <code style={{ fontFamily: "monospace", color: "var(--ink)" }}>{agent.configPath}</code>
                  </div>
                )}

                <div style={{ position: "relative" }}>
                  <pre
                    style={{
                      margin: 0,
                      padding: "0.65rem",
                      background: "var(--row-hover)",
                      border: "1px solid var(--border)",
                      borderRadius: "0.45rem",
                      fontSize: "0.75rem",
                      fontFamily: "monospace",
                      overflowX: "auto",
                      lineHeight: 1.4,
                      color: "var(--ink)",
                    }}
                  >
                    {agent.configSnippet}
                  </pre>
                </div>
              </div>

              <div
                style={{
                  borderTop: "1px solid var(--border)",
                  paddingTop: "0.65rem",
                  display: "flex",
                  justifyContent: "flex-end",
                  flexWrap: "wrap",
                  gap: "0.5rem",
                }}
              >
                {agent.command && (
                  <button
                    type="button"
                    onClick={() => copy(agent.command!, `${agent.id}-cmd`)}
                    style={{
                      display: "inline-flex",
                      alignItems: "center",
                      gap: "0.35rem",
                      fontSize: "0.78rem",
                      padding: "0.3rem 0.65rem",
                      background: "transparent",
                      borderColor: "var(--border)",
                    }}
                  >
                    {copiedId === `${agent.id}-cmd` ? <Check size={13} color="#10b981" /> : <Terminal size={13} />}
                    {copiedId === `${agent.id}-cmd` ? "Copied Command!" : "Copy Command"}
                  </button>
                )}
                <button
                  type="button"
                  onClick={() => copy(agent.configSnippet, agent.id)}
                  style={{
                    display: "inline-flex",
                    alignItems: "center",
                    gap: "0.35rem",
                    fontSize: "0.78rem",
                    padding: "0.3rem 0.65rem",
                    background: "transparent",
                    borderColor: "var(--border)",
                  }}
                >
                  {isCopied ? <Check size={13} color="#10b981" /> : <Copy size={13} />}
                  {isCopied ? "Copied Config!" : "Copy Configuration"}
                </button>
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}
