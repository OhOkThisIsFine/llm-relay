import { useCallback, useEffect, useMemo, useState, type ReactElement } from "react";
import {
  Activity,
  AlertTriangle,
  ArrowRight,
  Check,
  CheckCircle2,
  ChevronDown,
  ChevronRight,
  Code,
  Copy,
  Info,
  Key,
  Layers,
  Pin,
  PinOff,
  Play,
  RefreshCw,
  Search,
  Shield,
  X,
  Zap,
} from "lucide-react";
import { StatusBadge } from "../components/StatusBadge.js";
import { SegmentedControl } from "../components/SegmentedControl.js";

interface DispatchLane {
  readonly id: string;
  readonly position: number;
  readonly kind: "cli" | "relay";
  readonly target?: string | undefined;
  readonly spec?: string | undefined;
  readonly state: string;
  readonly capability?: string | undefined;
  readonly enabled?: boolean | undefined;
  readonly pinned?: { readonly until: string; readonly reason: string } | undefined;
  readonly stats?: {
    readonly calls?: number | undefined;
    readonly successes?: number | undefined;
    readonly failures?: number | undefined;
    readonly timeouts?: number | undefined;
    readonly avgLatencyMs?: number | undefined;
    readonly medianWallClockMs?: number | undefined;
    readonly p95WallClockMs?: number | undefined;
  } | undefined;
}

interface NextLane {
  readonly id: string;
  readonly kind: "cli" | "relay";
  readonly position?: number | undefined;
  readonly state: string;
  readonly note?: string | undefined;
  readonly spec?: string | undefined;
}

interface ProviderTelemetry {
  readonly provider: string;
  readonly displayName: string;
  readonly isHealthy: boolean | null;
  readonly cooldownRemainingMs: number;
  readonly stabilityScore?: number | null | undefined;
  readonly lastStatus?: number | undefined;
}

interface TelemetryData {
  readonly activeProvidersCount?: number | undefined;
  readonly healthyProvidersCount?: number | undefined;
  readonly providers?: readonly ProviderTelemetry[] | undefined;
  readonly config?: { readonly stale: boolean; readonly reason?: string | undefined } | undefined;
}

interface DispatchResponse {
  readonly tier?: string | null | undefined;
  readonly client?: string | undefined;
  readonly host?: string | undefined;
  readonly offload?: boolean | undefined;
  readonly order?: readonly string[] | undefined;
  readonly next?: NextLane | undefined;
  readonly reason?: string | undefined;
  readonly pin?: { readonly lane: string; readonly tier?: string | undefined } | undefined;
  readonly ladder?: readonly DispatchLane[] | undefined;
}

interface ModelItem {
  readonly id: string;
  readonly description?: string | undefined;
  readonly context_window?: number | undefined;
  readonly max_output_tokens?: number | undefined;
  readonly supports_vision?: boolean | undefined;
  readonly supports_tools?: boolean | undefined;
}

interface ModelsResponse {
  readonly data?: readonly ModelItem[] | undefined;
}

const TIERS = ["all", "low", "medium", "high", "xhigh"] as const;

function formatDuration(ms: number | undefined): string {
  if (ms === undefined || Number.isNaN(ms)) return "—";
  if (ms >= 60_000) return `${(ms / 60_000).toFixed(1)}m`;
  if (ms >= 1_000) return `${(ms / 1_000).toFixed(1)}s`;
  return `${Math.round(ms)}ms`;
}

export function RoutingLadderPage({
  onTestInPlayground,
  controlToken: externalControlToken,
  onSetControlToken,
}: Readonly<{
  onTestInPlayground?: ((target: string) => void) | undefined;
  controlToken?: string | undefined;
  onSetControlToken?: ((token: string) => void) | undefined;
}> = {}): ReactElement {
  const [tier, setTier] = useState<string>("all");
  const [sortMode, setSortMode] = useState<"resolution" | "configured">("resolution");
  const [dispatchData, setDispatchData] = useState<DispatchResponse | null>(null);
  const [modelsData, setModelsData] = useState<readonly ModelItem[]>([]);
  const [telemetry, setTelemetry] = useState<TelemetryData | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [searchModel, setSearchModel] = useState("");
  const [contextFilter, setContextFilter] = useState<number>(0);
  const [filterVision, setFilterVision] = useState(false);
  const [filterTools, setFilterTools] = useState(false);
  const [filterStream, setFilterStream] = useState(false);

  // Penalty Inspector collapsible state
  const [penaltyInspectorOpen, setPenaltyInspectorOpen] = useState(true);

  // Ping and Model inspection state
  const [pingResults, setPingResults] = useState<Record<string, { status: "testing" | "ok" | "err"; latencyMs?: number; error?: string }>>({});
  const [selectedDetailModel, setSelectedDetailModel] = useState<ModelItem | null>(null);
  const [snippetLang, setSnippetLang] = useState<"curl" | "python">("curl");
  const [copiedSnippet, setCopiedSnippet] = useState(false);
  const [clearingCooldowns, setClearingCooldowns] = useState(false);
  const [clearCooldownsNotice, setClearCooldownsNotice] = useState<string | null>(null);

  // Operator control token kept strictly in-memory during this browser session
  const [internalControlToken, setInternalControlToken] = useState<string>("");
  const controlToken = externalControlToken ?? internalControlToken;
  const setControlToken = (tok: string) => {
    setInternalControlToken(tok);
    onSetControlToken?.(tok);
  };
  const [tokenModalOpen, setTokenModalOpen] = useState(false);
  const [pendingAction, setPendingAction] = useState<{ action: "pin" | "unpin"; laneId: string } | null>(null);
  const [actionNotice, setActionNotice] = useState<string | null>(null);
  const [tokenInput, setTokenInput] = useState("");

  const pingModel = async (modelId: string) => {
    setPingResults((prev) => ({ ...prev, [modelId]: { status: "testing" } }));
    const start = performance.now();
    try {
      const res = await fetch("/v1/chat/completions", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          model: modelId,
          messages: [{ role: "user", content: "ping" }],
          max_tokens: 1,
        }),
      });
      const latencyMs = Math.round(performance.now() - start);
      if (res.ok) {
        setPingResults((prev) => ({ ...prev, [modelId]: { status: "ok", latencyMs } }));
      } else {
        const txt = await res.text().catch(() => `HTTP ${res.status}`);
        setPingResults((prev) => ({ ...prev, [modelId]: { status: "err", error: `HTTP ${res.status}`, latencyMs } }));
      }
    } catch {
      const latencyMs = Math.round(performance.now() - start);
      setPingResults((prev) => ({ ...prev, [modelId]: { status: "err", error: "Failed to connect", latencyMs } }));
    }
  };

  const handleClearCooldowns = async () => {
    setClearingCooldowns(true);
    setClearCooldownsNotice(null);
    try {
      const headers: Record<string, string> = { "Content-Type": "application/json" };
      if (controlToken) headers["x-llm-relay-control-token"] = controlToken;
      const res = await fetch("/cooldowns/clear", { method: "POST", headers });
      if (res.ok) {
        setClearCooldownsNotice("All active cooldowns and circuit breakers cleared.");
        void loadData();
      } else {
        setClearCooldownsNotice(`Failed to clear cooldowns (HTTP ${res.status}).`);
      }
    } catch {
      setClearCooldownsNotice("Failed to reach relay endpoint.");
    } finally {
      setClearingCooldowns(false);
      setTimeout(() => setClearCooldownsNotice(null), 3500);
    }
  };

  const loadData = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const dispatchUrl = tier === "all" ? "/dispatch" : `/dispatch?tier=${encodeURIComponent(tier)}`;
      const [dispRes, modRes, telRes] = await Promise.all([
        fetch(dispatchUrl, { headers: { Accept: "application/json" } }),
        fetch("/v1/models", { headers: { Accept: "application/json" } }),
        fetch("/telemetry", { headers: { Accept: "application/json" } }).catch(() => null),
      ]);
      if (dispRes.ok) {
        const dJson = (await dispRes.json()) as DispatchResponse;
        setDispatchData(dJson);
      }
      if (modRes.ok) {
        const mJson = (await modRes.json()) as ModelsResponse;
        if (Array.isArray(mJson.data)) setModelsData(mJson.data);
      }
      if (telRes && telRes.ok) {
        const tJson = (await telRes.json()) as TelemetryData;
        if (tJson && typeof tJson === "object") setTelemetry(tJson);
      }
    } catch {
      setError("Failed to load dispatch ladder or models from local relay.");
    } finally {
      setLoading(false);
    }
  }, [tier]);

  useEffect(() => {
    void loadData();
  }, [loadData]);

  // Periodic refresh of telemetry & cooldowns
  useEffect(() => {
    const timer = setInterval(() => {
      fetch("/telemetry", { headers: { Accept: "application/json" } })
        .then((res) => (res.ok ? res.json() : null))
        .then((tJson: TelemetryData | null) => {
          if (tJson) setTelemetry(tJson);
        })
        .catch(() => {});
    }, 10_000);
    return () => clearInterval(timer);
  }, []);

  const executePinAction = async (action: "pin" | "unpin", laneId: string, token: string) => {
    setActionNotice(null);
    try {
      const body: Record<string, unknown> = { [action]: laneId };
      if (tier !== "all") body.tier = tier;
      const res = await fetch("/dispatch", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "x-llm-relay-control-token": token.trim(),
        },
        body: JSON.stringify(body),
      });
      if (res.ok) {
        const pinHeader = res.headers.get("x-llm-relay-lane-pin");
        setActionNotice(pinHeader ?? `${action === "pin" ? "Pinned" : "Unpinned"} lane ${laneId}`);
        void loadData();
      } else {
        const text = await res.text();
        setError(`Failed to ${action} lane: ${text}`);
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : "Pin operation failed");
    }
  };

  const handlePinClick = (action: "pin" | "unpin", laneId: string) => {
    if (!controlToken) {
      setPendingAction({ action, laneId });
      setTokenModalOpen(true);
      return;
    }
    void executePinAction(action, laneId, controlToken);
  };

  const handleTokenSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    if (!tokenInput.trim()) return;
    setControlToken(tokenInput.trim());
    setTokenModalOpen(false);
    if (pendingAction) {
      void executePinAction(pendingAction.action, pendingAction.laneId, tokenInput.trim());
      setPendingAction(null);
    }
  };

  const filteredModels = useMemo(() => {
    let list = modelsData;
    const q = searchModel.trim().toLowerCase();
    if (q) {
      list = list.filter((m) => m.id.toLowerCase().includes(q) || (m.description ?? "").toLowerCase().includes(q));
    }
    if (contextFilter > 0) {
      list = list.filter((m) => (m.context_window ?? 0) >= contextFilter);
    }
    if (filterVision) {
      list = list.filter((m) => m.id.toLowerCase().includes("vision") || (m.description ?? "").toLowerCase().includes("vision"));
    }
    if (filterTools) {
      list = list.filter((m) => !m.id.toLowerCase().includes("no-tool") && !(m.description ?? "").toLowerCase().includes("no tool"));
    }
    return list;
  }, [modelsData, searchModel, contextFilter, filterVision, filterTools]);

  const sortedLadder = useMemo(() => {
    const raw = dispatchData?.ladder ?? [];
    if (sortMode === "configured") {
      return [...raw].sort((a, b) => a.position - b.position);
    }
    const order = dispatchData?.order ?? [];
    return [...raw].sort((a, b) => {
      const aIdx = order.indexOf(a.id);
      const bIdx = order.indexOf(b.id);
      if (aIdx !== -1 && bIdx !== -1) return aIdx - bIdx;
      if (aIdx !== -1) return -1;
      if (bIdx !== -1) return 1;
      return a.position - b.position;
    });
  }, [dispatchData, sortMode]);

  // Active cooldowns detected across providers or ladder rungs
  const activeCooldowns = useMemo(() => {
    const list: Array<{ name: string; remainingMs: number; status?: number | undefined }> = [];
    if (telemetry?.providers) {
      for (const p of telemetry.providers) {
        if (p.cooldownRemainingMs > 0) {
          list.push({
            name: p.displayName || p.provider,
            remainingMs: p.cooldownRemainingMs,
            status: p.lastStatus,
          });
        }
      }
    }
    if (dispatchData?.ladder) {
      for (const lane of dispatchData.ladder) {
        if (lane.state === "cooldown" || lane.state === "demoted") {
          if (!list.some((item) => item.name === lane.id)) {
            list.push({
              name: lane.id,
              remainingMs: 30_000,
            });
          }
        }
      }
    }
    return list;
  }, [telemetry, dispatchData]);

  const activeOrder = dispatchData?.order ?? [];
  const nextLane = dispatchData?.next;

  return (
    <div className="space-y-6" style={{ display: "flex", flexDirection: "column", gap: "1.5rem" }}>
      {/* 1. FreeLLMAPI Penalty & Cooldown Inspector */}
      <section
        style={{
          borderRadius: "0.5rem",
          border: activeCooldowns.length > 0 ? "1px solid rgba(239, 68, 68, 0.4)" : "1px solid var(--border)",
          backgroundColor: activeCooldowns.length > 0 ? "rgba(239, 68, 68, 0.05)" : "var(--card)",
          overflow: "hidden",
        }}
      >
        <button
          type="button"
          onClick={() => setPenaltyInspectorOpen((prev) => !prev)}
          style={{
            width: "100%",
            display: "flex",
            alignItems: "center",
            justifyContent: "space-between",
            padding: "0.85rem 1.25rem",
            background: "none",
            border: "none",
            color: "var(--foreground)",
            cursor: "pointer",
            textAlign: "left",
          }}
        >
          <div style={{ display: "flex", alignItems: "center", gap: "0.75rem" }}>
            <span
              style={{
                display: "inline-flex",
                alignItems: "center",
                justifyContent: "center",
                width: "2rem",
                height: "2rem",
                borderRadius: "9999px",
                backgroundColor: activeCooldowns.length > 0 ? "rgba(239, 68, 68, 0.15)" : "rgba(16, 185, 129, 0.15)",
                color: activeCooldowns.length > 0 ? "var(--danger)" : "#10b981",
              }}
            >
              {activeCooldowns.length > 0 ? <AlertTriangle size={16} /> : <CheckCircle2 size={16} />}
            </span>
            <div>
              <div style={{ fontWeight: 600, fontSize: "0.95rem" }}>
                Active Cooldowns &amp; Penalty Inspector
              </div>
              <div style={{ fontSize: "0.75rem", color: "var(--muted-foreground)" }}>
                {activeCooldowns.length > 0
                  ? `${activeCooldowns.length} provider(s) or model(s) currently held in cooldown or penalty backoff`
                  : "No active rate limits, cooldowns, or penalty demotions"}
              </div>
            </div>
          </div>

          <div style={{ display: "flex", alignItems: "center", gap: "0.75rem" }}>
            {activeCooldowns.length > 0 && (
              <span
                style={{
                  fontSize: "0.72rem",
                  padding: "0.2rem 0.5rem",
                  borderRadius: "9999px",
                  backgroundColor: "rgba(239, 68, 68, 0.2)",
                  color: "var(--danger)",
                  fontWeight: 700,
                }}
              >
                {activeCooldowns.length} in cooldown
              </span>
            )}
            <ChevronDown
              size={18}
              style={{
                color: "var(--muted-foreground)",
                transform: penaltyInspectorOpen ? "rotate(0deg)" : "rotate(-90deg)",
                transition: "transform 0.2s ease",
              }}
            />
          </div>
        </button>

        {penaltyInspectorOpen && (
          <div
            style={{
              padding: "0.85rem 1.25rem 1.25rem",
              borderTop: "1px solid var(--border)",
              display: "flex",
              flexDirection: "column",
              gap: "0.75rem",
            }}
          >
            {activeCooldowns.length === 0 ? (
              <div style={{ fontSize: "0.8125rem", color: "var(--muted-foreground)" }}>
                No active rate limits, auth errors, or circuit breaker trips recorded. Requests will proceed without penalty demotion.
              </div>
            ) : (
              <div style={{ display: "flex", flexDirection: "column", gap: "0.5rem" }}>
                {activeCooldowns.map((item, idx) => (
                  <div
                    key={idx}
                    style={{
                      display: "flex",
                      alignItems: "center",
                      justifyContent: "space-between",
                      padding: "0.5rem 0.75rem",
                      borderRadius: "0.375rem",
                      backgroundColor: "var(--surface)",
                      border: "1px solid var(--border)",
                      fontSize: "0.8125rem",
                    }}
                  >
                    <div style={{ display: "flex", alignItems: "center", gap: "0.5rem" }}>
                      <span style={{ fontFamily: "monospace", fontWeight: 700 }}>{item.name}</span>
                      {item.status && (
                        <span style={{ fontSize: "0.7rem", padding: "0.1rem 0.35rem", borderRadius: "0.2rem", backgroundColor: "rgba(239, 68, 68, 0.15)", color: "var(--danger)", fontWeight: 600 }}>
                          HTTP {item.status}
                        </span>
                      )}
                    </div>
                    <div style={{ display: "flex", alignItems: "center", gap: "0.75rem" }}>
                      <span style={{ fontSize: "0.75rem", color: "var(--danger)", fontFamily: "monospace" }}>
                        ~{Math.ceil(item.remainingMs / 1000)}s remaining
                      </span>
                    </div>
                  </div>
                ))}
              </div>
            )}

            <div style={{ display: "flex", justifyContent: "flex-end", marginTop: "0.25rem" }}>
              <button
                type="button"
                onClick={() => void handleClearCooldowns()}
                disabled={clearingCooldowns}
                style={{
                  display: "inline-flex",
                  alignItems: "center",
                  gap: "0.35rem",
                  fontSize: "0.75rem",
                  padding: "0.35rem 0.75rem",
                  borderRadius: "0.375rem",
                  border: "1px solid var(--border)",
                  background: "var(--surface)",
                  color: "var(--danger)",
                  cursor: clearingCooldowns ? "wait" : "pointer",
                  fontWeight: 600,
                }}
              >
                <RefreshCw size={12} className={clearingCooldowns ? "animate-spin" : ""} />
                {clearingCooldowns ? "Clearing Cooldowns…" : "Clear All Cooldowns Now"}
              </button>
            </div>
          </div>
        )}
      </section>

      {/* 2. Next Dispatch Target Decision Card */}
      {nextLane && (
        <div
          style={{
            padding: "1.25rem",
            borderRadius: "0.5rem",
            border: "1px solid rgba(59, 130, 246, 0.35)",
            backgroundColor: "rgba(59, 130, 246, 0.07)",
            display: "flex",
            flexDirection: "column",
            gap: "0.875rem",
          }}
        >
          <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", flexWrap: "wrap", gap: "0.75rem" }}>
            <div style={{ display: "flex", alignItems: "center", gap: "0.75rem" }}>
              <span
                style={{
                  display: "inline-flex",
                  alignItems: "center",
                  justifyContent: "center",
                  width: "2.25rem",
                  height: "2.25rem",
                  borderRadius: "9999px",
                  backgroundColor: "rgba(59, 130, 246, 0.2)",
                  color: "#3b82f6",
                }}
              >
                <Zap size={18} />
              </span>
              <div>
                <div style={{ display: "flex", alignItems: "center", gap: "0.5rem" }}>
                  <span style={{ fontSize: "0.75rem", textTransform: "uppercase", fontWeight: 700, color: "var(--muted-foreground)", letterSpacing: "0.05em" }}>
                    Next Dispatch Target
                  </span>
                  <StatusBadge value={nextLane.state} />
                  <span className="badge" style={{ textTransform: "uppercase", fontSize: "0.7rem" }}>
                    {nextLane.kind}
                  </span>
                </div>
                <div style={{ fontSize: "1.25rem", fontWeight: 700, fontFamily: "monospace", color: "var(--foreground)" }}>
                  {nextLane.id}
                  {nextLane.spec && (
                    <span style={{ fontSize: "0.875rem", fontWeight: 400, color: "var(--muted-foreground)", marginLeft: "0.5rem" }}>
                      ({nextLane.spec})
                    </span>
                  )}
                </div>
              </div>
            </div>

            <div style={{ display: "flex", alignItems: "center", gap: "0.5rem" }}>
              {onTestInPlayground && (nextLane.spec ?? nextLane.id) && (
                <button
                  type="button"
                  onClick={() => onTestInPlayground(nextLane.spec ?? nextLane.id)}
                  style={{
                    display: "inline-flex",
                    alignItems: "center",
                    gap: "0.375rem",
                    fontSize: "0.8125rem",
                    fontWeight: 600,
                    padding: "0.4rem 0.8rem",
                    borderRadius: "0.375rem",
                    border: "1px solid rgba(59, 130, 246, 0.4)",
                    backgroundColor: "rgba(59, 130, 246, 0.15)",
                    color: "#3b82f6",
                    cursor: "pointer",
                  }}
                >
                  <Play size={13} /> Test Next Lane in Playground
                </button>
              )}
            </div>
          </div>

          {dispatchData?.reason && (
            <div style={{ fontSize: "0.8125rem", color: "var(--muted-foreground)" }}>
              <strong style={{ color: "var(--foreground)" }}>Selection reason:</strong> {dispatchData.reason}
            </div>
          )}

          {activeOrder.length > 0 && (
            <div
              style={{
                display: "flex",
                alignItems: "center",
                gap: "0.5rem",
                flexWrap: "wrap",
                fontSize: "0.8125rem",
                paddingTop: "0.5rem",
                borderTop: "1px solid rgba(59, 130, 246, 0.15)",
              }}
            >
              <span style={{ fontWeight: 600, color: "var(--muted-foreground)" }}>Active resolution order:</span>
              {activeOrder.map((laneId, idx) => {
                const isCurrentNext = laneId === nextLane.id;
                return (
                  <span key={laneId} style={{ display: "inline-flex", alignItems: "center", gap: "0.35rem" }}>
                    <span
                      style={{
                        padding: "0.2rem 0.55rem",
                        borderRadius: "0.25rem",
                        fontFamily: "monospace",
                        fontSize: "0.8rem",
                        fontWeight: isCurrentNext ? 700 : 500,
                        backgroundColor: isCurrentNext ? "rgba(59, 130, 246, 0.25)" : "var(--row-hover)",
                        color: isCurrentNext ? "#3b82f6" : "var(--foreground)",
                        border: isCurrentNext ? "1px solid rgba(59, 130, 246, 0.5)" : "1px solid var(--border)",
                      }}
                    >
                      #{idx + 1} {laneId}
                    </span>
                    {idx < activeOrder.length - 1 && (
                      <ArrowRight size={12} style={{ color: "var(--muted-foreground)", opacity: 0.6 }} />
                    )}
                  </span>
                );
              })}
            </div>
          )}
        </div>
      )}

      {/* 3. Dispatch Ladder Panel */}
      <section className="panel">
        <div className="panel-header" style={{ display: "flex", justifyContent: "space-between", alignItems: "center", flexWrap: "wrap", gap: "1rem" }}>
          <div>
            <h2 className="panel-title" style={{ display: "flex", alignItems: "center", gap: "0.5rem" }}>
              <Zap size={20} style={{ color: "var(--primary)" }} />
              Live Dispatch Ladder
            </h2>
            <p className="muted" style={{ fontSize: "0.875rem", marginTop: "0.25rem" }}>
              Dynamic failover priority across peer CLIs and backend relay pools
              {telemetry && telemetry.healthyProvidersCount !== undefined && telemetry.activeProvidersCount !== undefined && (
                <span style={{ marginLeft: "0.75rem", fontWeight: 500, color: "var(--foreground)" }}>
                  &middot; {telemetry.healthyProvidersCount} of {telemetry.activeProvidersCount} providers healthy
                </span>
              )}
            </p>
          </div>
          <div style={{ display: "flex", alignItems: "center", gap: "0.75rem", flexWrap: "wrap" }}>
            <div style={{ display: "inline-flex", border: "1px solid var(--border)", borderRadius: "0.375rem", overflow: "hidden", fontSize: "0.75rem" }}>
              <button
                type="button"
                onClick={() => setSortMode("resolution")}
                style={{
                  padding: "0.3rem 0.6rem",
                  background: sortMode === "resolution" ? "var(--row-hover)" : "transparent",
                  color: sortMode === "resolution" ? "var(--accent)" : "var(--muted)",
                  border: "none",
                  fontWeight: sortMode === "resolution" ? 600 : 400,
                  cursor: "pointer",
                }}
              >
                Failover Order
              </button>
              <button
                type="button"
                onClick={() => setSortMode("configured")}
                style={{
                  padding: "0.3rem 0.6rem",
                  background: sortMode === "configured" ? "var(--row-hover)" : "transparent",
                  color: sortMode === "configured" ? "var(--accent)" : "var(--muted)",
                  border: "none",
                  borderLeft: "1px solid var(--border)",
                  fontWeight: sortMode === "configured" ? 600 : 400,
                  cursor: "pointer",
                }}
              >
                Config Order
              </button>
            </div>
            <SegmentedControl
              ariaLabel="Dispatch Tier"
              value={tier}
              options={TIERS}
              onValueChange={(val) => setTier(val)}
            />
            <button
              type="button"
              onClick={() => void loadData()}
              disabled={loading}
              className="button-secondary"
              style={{ display: "inline-flex", alignItems: "center", gap: "0.375rem" }}
            >
              <RefreshCw size={14} className={loading ? "animate-spin" : ""} /> Refresh
            </button>
          </div>
        </div>

        {clearCooldownsNotice && (
          <div style={{ margin: "0.5rem 1rem", padding: "0.6rem 0.85rem", borderRadius: "0.375rem", backgroundColor: "rgba(59, 130, 246, 0.12)", color: "var(--accent)", fontSize: "0.8125rem", display: "flex", alignItems: "center", gap: "0.5rem" }}>
            <CheckCircle2 size={16} /> {clearCooldownsNotice}
          </div>
        )}

        {actionNotice && (
          <div style={{ margin: "1rem 0", padding: "0.75rem 1rem", borderRadius: "0.375rem", backgroundColor: "rgba(34, 197, 94, 0.1)", color: "#16a34a", fontSize: "0.875rem", display: "flex", alignItems: "center", gap: "0.5rem" }}>
            <CheckCircle2 size={16} />
            {actionNotice}
          </div>
        )}

        {error && (
          <div style={{ margin: "1rem 0", padding: "0.75rem 1rem", borderRadius: "0.375rem", backgroundColor: "rgba(239, 68, 68, 0.1)", color: "#dc2626", fontSize: "0.875rem" }}>
            {error}
          </div>
        )}

        <div className="table-wrap">
          <table className="responsive-table">
            <thead>
              <tr>
                <th scope="col" style={{ width: "4rem" }}>
                  {sortMode === "resolution" ? "Order" : "Pos"}
                </th>
                <th scope="col">Lane ID</th>
                <th scope="col">Type</th>
                <th scope="col">Target / Spec</th>
                <th scope="col">Capability</th>
                <th scope="col">State</th>
                <th scope="col">History</th>
                <th scope="col" style={{ textAlign: "right" }}>Actions</th>
              </tr>
            </thead>
            <tbody>
              {sortedLadder.length === 0 ? (
                <tr>
                  <td colSpan={8} className="empty-row">
                    {loading ? "Loading dispatch rungs…" : "No dispatch rungs configured for this tier."}
                  </td>
                </tr>
              ) : (
                sortedLadder.map((lane) => {
                  const isPinned = Boolean(lane.pinned);
                  const isNext = lane.id === nextLane?.id;
                  const targetSpec = lane.spec ?? lane.target;
                  const activeIndex = activeOrder.indexOf(lane.id);

                  return (
                    <tr
                      key={lane.id}
                      style={{
                        backgroundColor: isNext ? "rgba(59, 130, 246, 0.05)" : undefined,
                      }}
                    >
                      <td data-label="Pos" style={{ fontWeight: 600 }}>
                        {sortMode === "resolution" ? (
                          activeIndex !== -1 ? (
                            <span style={{ color: isNext ? "#3b82f6" : undefined, fontWeight: 700 }}>
                              #{activeIndex + 1}
                            </span>
                          ) : (
                            <span className="muted">&mdash;</span>
                          )
                        ) : (
                          `#${lane.position}`
                        )}
                      </td>
                      <th scope="row" data-label="Lane ID">
                        <span style={{ fontFamily: "monospace", fontSize: "0.875rem", fontWeight: isNext ? 700 : 500 }}>
                          {lane.id}
                        </span>
                        {isNext && (
                          <span style={{ marginLeft: "0.5rem", fontSize: "0.7rem", color: "#3b82f6", backgroundColor: "rgba(59, 130, 246, 0.15)", padding: "0.1rem 0.35rem", borderRadius: "0.25rem", fontWeight: 700 }}>
                            NEXT
                          </span>
                        )}
                        {lane.pinned && (
                          <span style={{ marginLeft: "0.5rem", fontSize: "0.75rem", color: "#eab308", display: "inline-flex", alignItems: "center", gap: "0.25rem" }}>
                            <Pin size={12} /> Pinned
                          </span>
                        )}
                      </th>
                      <td data-label="Type">
                        <span className="badge" style={{ textTransform: "uppercase", fontSize: "0.75rem" }}>
                          {lane.kind}
                        </span>
                      </td>
                      <td data-label="Target" style={{ fontFamily: "monospace", fontSize: "0.875rem" }}>
                        {targetSpec ?? "—"}
                      </td>
                      <td data-label="Capability">
                        {lane.capability ? (
                          <StatusBadge value={lane.capability} />
                        ) : (
                          <span title="No tier limit; available to all tiers" className="muted">— (any)</span>
                        )}
                      </td>
                      <td data-label="State">
                        <StatusBadge value={lane.state} />
                      </td>
                      <td data-label="History" style={{ fontSize: "0.8125rem", whiteSpace: "nowrap" }}>
                        {lane.stats ? (
                          <span>
                            {lane.stats.calls ?? lane.stats.successes ?? 0} runs · {lane.stats.failures ?? 0} errs
                            {lane.stats.medianWallClockMs !== undefined ? (
                              <span title={`${Math.round(lane.stats.medianWallClockMs)}ms`}>
                                {" "}· {formatDuration(lane.stats.medianWallClockMs)}
                              </span>
                            ) : ""}
                          </span>
                        ) : (
                          <span className="muted">No runs</span>
                        )}
                      </td>
                      <td data-label="Actions" style={{ textAlign: "right" }}>
                        <div style={{ display: "inline-flex", alignItems: "center", gap: "0.375rem" }}>
                          {onTestInPlayground && targetSpec && (
                            <button
                              type="button"
                              onClick={() => onTestInPlayground(targetSpec)}
                              title="Test target in playground"
                              style={{
                                display: "inline-flex",
                                alignItems: "center",
                                gap: "0.25rem",
                                fontSize: "0.75rem",
                                padding: "0.25rem 0.5rem",
                                borderRadius: "0.25rem",
                                border: "1px solid var(--border)",
                                background: "transparent",
                                cursor: "pointer",
                                color: "var(--accent)",
                              }}
                            >
                              <Play size={11} /> Test
                            </button>
                          )}
                          {isPinned ? (
                            <button
                              type="button"
                              onClick={() => handlePinClick("unpin", lane.id)}
                              style={{
                                display: "inline-flex",
                                alignItems: "center",
                                gap: "0.375rem",
                                fontSize: "0.75rem",
                                padding: "0.25rem 0.5rem",
                                borderRadius: "0.25rem",
                                border: "1px solid var(--border)",
                                background: "transparent",
                                cursor: "pointer",
                              }}
                            >
                              <PinOff size={12} /> Unpin
                            </button>
                          ) : (
                            <button
                              type="button"
                              onClick={() => handlePinClick("pin", lane.id)}
                              style={{
                                display: "inline-flex",
                                alignItems: "center",
                                gap: "0.375rem",
                                fontSize: "0.75rem",
                                padding: "0.25rem 0.5rem",
                                borderRadius: "0.25rem",
                                border: "1px solid var(--border)",
                                background: "transparent",
                                cursor: "pointer",
                              }}
                            >
                              <Pin size={12} /> Pin
                            </button>
                          )}
                        </div>
                      </td>
                    </tr>
                  );
                })
              )}
            </tbody>
          </table>
        </div>
      </section>

      {/* 4. Configured Pools & Models Catalog Panel */}
      <section className="panel">
        <div className="panel-header" style={{ display: "flex", justifyContent: "space-between", alignItems: "center", flexWrap: "wrap", gap: "1rem" }}>
          <div>
            <h2 className="panel-title" style={{ display: "flex", alignItems: "center", gap: "0.5rem" }}>
              <Layers size={20} style={{ color: "var(--primary)" }} />
              Configured Pools &amp; Models
            </h2>
            <p className="muted" style={{ fontSize: "0.875rem", marginTop: "0.25rem" }}>
              All models, auto-routing aliases, and dynamic effort pools advertised by the relay ({filteredModels.length} models)
            </p>
          </div>
          <div style={{ display: "flex", alignItems: "center", gap: "0.6rem", flexWrap: "wrap" }}>
            <div style={{ display: "inline-flex", gap: "0.2rem", border: "1px solid var(--border)", borderRadius: "0.4rem", padding: "0.15rem" }}>
              {[
                { label: "Any Ctx", val: 0 },
                { label: "32K+", val: 32000 },
                { label: "128K+", val: 128000 },
                { label: "1M+", val: 1000000 },
              ].map((c) => (
                <button
                  key={c.label}
                  type="button"
                  onClick={() => setContextFilter(c.val)}
                  style={{
                    fontSize: "0.72rem",
                    padding: "0.2rem 0.45rem",
                    borderRadius: "0.25rem",
                    border: "none",
                    background: contextFilter === c.val ? "var(--accent)" : "transparent",
                    color: contextFilter === c.val ? "#fff" : "var(--muted)",
                    fontWeight: contextFilter === c.val ? 600 : 400,
                    cursor: "pointer",
                  }}
                >
                  {c.label}
                </button>
              ))}
            </div>

            <button
              type="button"
              onClick={() => setFilterVision((v) => !v)}
              style={{
                fontSize: "0.72rem",
                padding: "0.25rem 0.5rem",
                borderRadius: "0.35rem",
                border: "1px solid var(--border)",
                background: filterVision ? "rgba(59, 130, 246, 0.15)" : "transparent",
                color: filterVision ? "var(--accent)" : "var(--muted)",
                fontWeight: filterVision ? 600 : 400,
                cursor: "pointer",
              }}
            >
              Vision
            </button>

            <button
              type="button"
              onClick={() => setFilterTools((t) => !t)}
              style={{
                fontSize: "0.72rem",
                padding: "0.25rem 0.5rem",
                borderRadius: "0.35rem",
                border: "1px solid var(--border)",
                background: filterTools ? "rgba(59, 130, 246, 0.15)" : "transparent",
                color: filterTools ? "var(--accent)" : "var(--muted)",
                fontWeight: filterTools ? 600 : 400,
                cursor: "pointer",
              }}
            >
              Tools
            </button>

            <div style={{ position: "relative", minWidth: "200px" }}>
              <Search size={14} style={{ position: "absolute", left: "0.6rem", top: "50%", transform: "translateY(-50%)", color: "var(--muted-foreground)" }} />
              <input
                type="text"
                value={searchModel}
                onChange={(e) => setSearchModel(e.target.value)}
                placeholder="Search models or pools…"
                style={{
                  width: "100%",
                  padding: "0.3rem 0.5rem 0.3rem 1.85rem",
                  borderRadius: "0.35rem",
                  border: "1px solid var(--border)",
                  backgroundColor: "var(--card)",
                  color: "var(--foreground)",
                  fontSize: "0.8rem",
                }}
              />
            </div>
          </div>
        </div>

        <div className="table-wrap">
          <table className="responsive-table">
            <thead>
              <tr>
                <th scope="col">Identifier / Target</th>
                <th scope="col">Context Window</th>
                <th scope="col">Ping / Latency</th>
                <th scope="col">Capabilities</th>
                <th scope="col">Description</th>
                <th scope="col" style={{ textAlign: "right" }}>Action</th>
              </tr>
            </thead>
            <tbody>
              {filteredModels.length === 0 ? (
                <tr>
                  <td colSpan={6} className="empty-row">
                    {loading ? "Loading models catalog…" : "No matching models found in relay catalog."}
                  </td>
                </tr>
              ) : (
                filteredModels.map((model) => {
                  const ping = pingResults[model.id];
                  const hasVision = model.id.toLowerCase().includes("vision") || (model.description ?? "").toLowerCase().includes("vision");
                  const hasTools = !model.id.toLowerCase().includes("no-tool") && !(model.description ?? "").toLowerCase().includes("no tool");

                  return (
                    <tr key={model.id}>
                      <th scope="row" data-label="Identifier">
                        <span style={{ fontFamily: "monospace", fontSize: "0.875rem", fontWeight: 600, whiteSpace: "nowrap" }}>
                          {model.id}
                        </span>
                      </th>
                      <td data-label="Context Window" style={{ fontSize: "0.8125rem" }}>
                        {model.context_window ? (
                          <span className="badge" style={{ backgroundColor: "var(--row-hover)" }}>
                            {model.context_window >= 1000000
                              ? `${(model.context_window / 1000000).toFixed(0)}M`
                              : `${Math.round(model.context_window / 1000)}K`}
                          </span>
                        ) : (
                          <span className="muted">Dynamic</span>
                        )}
                      </td>
                      <td data-label="Ping / Latency" style={{ fontSize: "0.8125rem" }}>
                        {ping?.status === "testing" ? (
                          <span style={{ display: "inline-flex", alignItems: "center", gap: "0.25rem", color: "var(--muted)" }}>
                            <RefreshCw size={12} className="animate-spin" /> testing…
                          </span>
                        ) : ping?.status === "ok" ? (
                          <span style={{ color: "#10b981", fontWeight: 600, display: "inline-flex", alignItems: "center", gap: "0.25rem" }}>
                            <Check size={12} /> {ping.latencyMs}ms
                          </span>
                        ) : ping?.status === "err" ? (
                          <span style={{ color: "var(--danger)", fontSize: "0.75rem" }} title={ping.error}>
                            {ping.error ?? "Failed"}
                          </span>
                        ) : (
                          <button
                            type="button"
                            onClick={() => void pingModel(model.id)}
                            style={{
                              fontSize: "0.72rem",
                              padding: "0.15rem 0.4rem",
                              borderRadius: "0.25rem",
                              border: "1px solid var(--border)",
                              background: "transparent",
                              cursor: "pointer",
                              color: "var(--foreground)",
                            }}
                          >
                            Ping
                          </button>
                        )}
                      </td>
                      <td data-label="Capabilities" style={{ fontSize: "0.75rem" }}>
                        <div style={{ display: "flex", gap: "0.3rem", flexWrap: "wrap" }}>
                          {hasTools && (
                            <span style={{ padding: "0.1rem 0.35rem", borderRadius: "0.25rem", backgroundColor: "rgba(59, 130, 246, 0.12)", color: "#3b82f6", fontWeight: 600 }}>
                              Tools
                            </span>
                          )}
                          {hasVision && (
                            <span style={{ padding: "0.1rem 0.35rem", borderRadius: "0.25rem", backgroundColor: "rgba(16, 185, 129, 0.12)", color: "#10b981", fontWeight: 600 }}>
                              Vision
                            </span>
                          )}
                          <span style={{ padding: "0.1rem 0.35rem", borderRadius: "0.25rem", backgroundColor: "var(--row-hover)", color: "var(--muted-foreground)" }}>
                            SSE
                          </span>
                        </div>
                      </td>
                      <td data-label="Description" style={{ fontSize: "0.8125rem", color: "var(--muted)" }}>
                        {model.description || "Relay routing target"}
                      </td>
                      <td data-label="Action" style={{ textAlign: "right" }}>
                        <div style={{ display: "inline-flex", alignItems: "center", gap: "0.375rem" }}>
                          <button
                            type="button"
                            onClick={() => setSelectedDetailModel(model)}
                            style={{
                              display: "inline-flex",
                              alignItems: "center",
                              gap: "0.25rem",
                              fontSize: "0.75rem",
                              padding: "0.25rem 0.5rem",
                              borderRadius: "0.25rem",
                              border: "1px solid var(--border)",
                              background: "transparent",
                              cursor: "pointer",
                            }}
                          >
                            <Info size={11} /> Details
                          </button>
                          {onTestInPlayground && (
                            <button
                              type="button"
                              onClick={() => onTestInPlayground(model.id)}
                              style={{
                                display: "inline-flex",
                                alignItems: "center",
                                gap: "0.25rem",
                                fontSize: "0.75rem",
                                padding: "0.25rem 0.5rem",
                                borderRadius: "0.25rem",
                                border: "1px solid var(--border)",
                                background: "transparent",
                                cursor: "pointer",
                                color: "var(--accent)",
                              }}
                            >
                              <Play size={11} /> Test
                            </button>
                          )}
                        </div>
                      </td>
                    </tr>
                  );
                })
              )}
            </tbody>
          </table>
        </div>
      </section>

      {/* Model Specification Detail Dialog */}
      {selectedDetailModel && (
        <div
          role="dialog"
          aria-modal="true"
          aria-labelledby="model-detail-dialog-title"
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
            if (e.target === e.currentTarget) setSelectedDetailModel(null);
          }}
        >
          <div
            style={{
              backgroundColor: "var(--surface)",
              border: "1px solid var(--border)",
              borderRadius: "0.75rem",
              padding: "1.5rem",
              maxWidth: "36rem",
              width: "100%",
              boxShadow: "0 25px 50px -12px rgba(0, 0, 0, 0.4)",
              color: "var(--ink)",
              maxHeight: "90vh",
              overflowY: "auto",
            }}
          >
            <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: "1rem" }}>
              <div style={{ display: "flex", alignItems: "center", gap: "0.5rem" }}>
                <Layers size={20} style={{ color: "var(--accent)" }} />
                <h3 id="model-detail-dialog-title" style={{ fontSize: "1.125rem", fontWeight: 700, margin: 0, fontFamily: "monospace" }}>
                  {selectedDetailModel.id}
                </h3>
              </div>
              <button
                type="button"
                onClick={() => setSelectedDetailModel(null)}
                style={{ background: "transparent", border: "none", color: "var(--muted)", cursor: "pointer" }}
              >
                <X size={18} />
              </button>
            </div>

            <p style={{ fontSize: "0.8125rem", color: "var(--muted)", margin: "0 0 1rem" }}>
              {selectedDetailModel.description ?? "Relay capability pool or provider model target."}
            </p>

            <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: "0.75rem", background: "var(--row-hover)", padding: "0.85rem", borderRadius: "0.5rem", border: "1px solid var(--border)", marginBottom: "1.25rem", fontSize: "0.8125rem" }}>
              <div>
                <span style={{ color: "var(--muted)", display: "block", fontSize: "0.7rem", textTransform: "uppercase", fontWeight: 600 }}>Context Window</span>
                <span style={{ fontWeight: 600 }}>{selectedDetailModel.context_window ? `${selectedDetailModel.context_window.toLocaleString()} tokens` : "Dynamic / Pool"}</span>
              </div>
              <div>
                <span style={{ color: "var(--muted)", display: "block", fontSize: "0.7rem", textTransform: "uppercase", fontWeight: 600 }}>Streaming</span>
                <span style={{ fontWeight: 600, color: "#10b981" }}>Supported (SSE)</span>
              </div>
              <div>
                <span style={{ color: "var(--muted)", display: "block", fontSize: "0.7rem", textTransform: "uppercase", fontWeight: 600 }}>Tool Calling</span>
                <span style={{ fontWeight: 600 }}>{!selectedDetailModel.id.toLowerCase().includes("no-tool") ? "Supported (with Dialect Repair)" : "Disabled"}</span>
              </div>
              <div>
                <span style={{ color: "var(--muted)", display: "block", fontSize: "0.7rem", textTransform: "uppercase", fontWeight: 600 }}>Vision</span>
                <span style={{ fontWeight: 600 }}>{selectedDetailModel.id.toLowerCase().includes("vision") ? "Supported" : "Text Only"}</span>
              </div>
              <div style={{ gridColumn: "span 2" }}>
                <span style={{ color: "var(--muted)", display: "block", fontSize: "0.7rem", textTransform: "uppercase", fontWeight: 600 }}>Measured Latency</span>
                <div style={{ display: "flex", alignItems: "center", gap: "0.5rem", marginTop: "0.25rem" }}>
                  {pingResults[selectedDetailModel.id]?.status === "ok" ? (
                    <span style={{ color: "#10b981", fontWeight: 700 }}>✓ {pingResults[selectedDetailModel.id]?.latencyMs}ms round-trip</span>
                  ) : pingResults[selectedDetailModel.id]?.status === "err" ? (
                    <span style={{ color: "#ef4444" }}>✗ {pingResults[selectedDetailModel.id]?.error} ({pingResults[selectedDetailModel.id]?.latencyMs}ms)</span>
                  ) : (
                    <span style={{ color: "var(--muted)" }}>Not pinged yet</span>
                  )}
                  <button
                    type="button"
                    onClick={() => void pingModel(selectedDetailModel.id)}
                    style={{
                      fontSize: "0.72rem",
                      padding: "0.2rem 0.5rem",
                      borderRadius: "0.25rem",
                      border: "1px solid var(--border)",
                      background: "var(--surface)",
                      cursor: "pointer",
                      display: "inline-flex",
                      alignItems: "center",
                      gap: "0.25rem",
                    }}
                  >
                    <Activity size={11} /> Ping Now
                  </button>
                </div>
              </div>
            </div>

            {/* Ready-to-run Code Snippet inside Model Details */}
            <div style={{ marginBottom: "1.25rem" }}>
              <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: "0.5rem" }}>
                <span style={{ fontSize: "0.75rem", fontWeight: 600, textTransform: "uppercase", color: "var(--muted-foreground)" }}>
                  Invocation Snippet
                </span>
                <div style={{ display: "flex", gap: "0.35rem" }}>
                  <button
                    type="button"
                    onClick={() => setSnippetLang("curl")}
                    style={{
                      fontSize: "0.72rem",
                      padding: "0.15rem 0.4rem",
                      borderRadius: "0.2rem",
                      border: "1px solid var(--border)",
                      background: snippetLang === "curl" ? "var(--accent)" : "transparent",
                      color: snippetLang === "curl" ? "#fff" : "var(--foreground)",
                      cursor: "pointer",
                    }}
                  >
                    cURL
                  </button>
                  <button
                    type="button"
                    onClick={() => setSnippetLang("python")}
                    style={{
                      fontSize: "0.72rem",
                      padding: "0.15rem 0.4rem",
                      borderRadius: "0.2rem",
                      border: "1px solid var(--border)",
                      background: snippetLang === "python" ? "var(--accent)" : "transparent",
                      color: snippetLang === "python" ? "#fff" : "var(--foreground)",
                      cursor: "pointer",
                    }}
                  >
                    Python
                  </button>
                </div>
              </div>

              <div style={{ position: "relative" }}>
                <pre
                  style={{
                    margin: 0,
                    padding: "0.75rem",
                    borderRadius: "0.375rem",
                    backgroundColor: "var(--row-hover)",
                    border: "1px solid var(--border)",
                    fontFamily: "monospace",
                    fontSize: "0.75rem",
                    lineHeight: 1.4,
                    overflowX: "auto",
                  }}
                >
                  {snippetLang === "curl"
                    ? `curl http://127.0.0.1:8791/v1/chat/completions \\
  -H "Content-Type: application/json" \\
  -d '{"model": "${selectedDetailModel.id}", "messages": [{"role": "user", "content": "Hello"}]}'`
                    : `from openai import OpenAI

client = OpenAI(base_url="http://127.0.0.1:8791/v1", api_key="loopback")
res = client.chat.completions.create(
    model="${selectedDetailModel.id}",
    messages=[{"role": "user", "content": "Hello"}],
)
print(res.choices[0].message.content)`}
                </pre>
                <button
                  type="button"
                  onClick={() => {
                    const txt = snippetLang === "curl"
                      ? `curl http://127.0.0.1:8791/v1/chat/completions -H "Content-Type: application/json" -d '{"model": "${selectedDetailModel.id}", "messages": [{"role": "user", "content": "Hello"}]}'`
                      : `from openai import OpenAI\nclient = OpenAI(base_url="http://127.0.0.1:8791/v1", api_key="loopback")\nres = client.chat.completions.create(model="${selectedDetailModel.id}", messages=[{"role": "user", "content": "Hello"}])\nprint(res.choices[0].message.content)`;
                    void navigator.clipboard.writeText(txt);
                    setCopiedSnippet(true);
                    setTimeout(() => setCopiedSnippet(false), 2000);
                  }}
                  style={{
                    position: "absolute",
                    top: "0.35rem",
                    right: "0.35rem",
                    display: "inline-flex",
                    alignItems: "center",
                    gap: "0.2rem",
                    padding: "0.15rem 0.35rem",
                    borderRadius: "0.2rem",
                    border: "1px solid var(--border)",
                    background: "var(--surface)",
                    fontSize: "0.7rem",
                    cursor: "pointer",
                  }}
                >
                  {copiedSnippet ? <Check size={11} /> : <Copy size={11} />}
                  <span>{copiedSnippet ? "Copied" : "Copy"}</span>
                </button>
              </div>
            </div>

            <div style={{ display: "flex", justifyContent: "flex-end", gap: "0.5rem" }}>
              <button
                type="button"
                onClick={() => setSelectedDetailModel(null)}
                style={{ padding: "0.4rem 0.85rem", fontSize: "0.8125rem", borderRadius: "0.375rem", border: "1px solid var(--border)", background: "transparent", color: "var(--ink)", cursor: "pointer" }}
              >
                Close
              </button>
              {onTestInPlayground && (
                <button
                  type="button"
                  onClick={() => {
                    const id = selectedDetailModel.id;
                    setSelectedDetailModel(null);
                    onTestInPlayground(id);
                  }}
                  style={{
                    padding: "0.4rem 0.85rem",
                    fontSize: "0.8125rem",
                    borderRadius: "0.375rem",
                    border: "none",
                    backgroundColor: "var(--accent)",
                    color: "#ffffff",
                    cursor: "pointer",
                    display: "inline-flex",
                    alignItems: "center",
                    gap: "0.375rem",
                    fontWeight: 600,
                  }}
                >
                  <Play size={13} /> Test in Playground
                </button>
              )}
            </div>
          </div>
        </div>
      )}

      {/* Control Token Entry Dialog */}
      {tokenModalOpen && (
        <div
          role="dialog"
          aria-modal="true"
          aria-labelledby="token-dialog-title"
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
        >
          <div
            style={{
              backgroundColor: "var(--card)",
              border: "1px solid var(--border)",
              borderRadius: "0.5rem",
              padding: "1.5rem",
              maxWidth: "28rem",
              width: "100%",
              boxShadow: "0 20px 25px -5px rgba(0, 0, 0, 0.3)",
            }}
          >
            <div style={{ display: "flex", alignItems: "center", gap: "0.5rem", marginBottom: "1rem" }}>
              <Shield size={20} style={{ color: "var(--accent)" }} />
              <h3 id="token-dialog-title" style={{ fontSize: "1.125rem", fontWeight: 600, margin: 0 }}>
                Operator Control Authorization
              </h3>
            </div>
            <p className="muted" style={{ fontSize: "0.875rem", marginBottom: "1rem", lineHeight: 1.5 }}>
              Pinning or unpinning a lane writes to the relay control plane. Paste your operator control token
              from <code style={{ fontSize: "0.8rem", padding: "0.1rem 0.3rem", borderRadius: "0.2rem", backgroundColor: "var(--row-hover)" }}>~/.llm-relay/control-token</code>.
              It will be kept strictly in-memory during this browser session.
            </p>
            <form onSubmit={handleTokenSubmit}>
              <div style={{ marginBottom: "1.25rem" }}>
                <input
                  type="password"
                  value={tokenInput}
                  onChange={(e) => setTokenInput(e.target.value)}
                  placeholder="Paste control token…"
                  autoFocus
                  style={{
                    width: "100%",
                    padding: "0.5rem 0.75rem",
                    borderRadius: "0.375rem",
                    border: "1px solid var(--border)",
                    backgroundColor: "var(--input)",
                    color: "var(--foreground)",
                    fontSize: "0.875rem",
                  }}
                />
              </div>
              <div style={{ display: "flex", justifyContent: "flex-end", gap: "0.5rem" }}>
                <button
                  type="button"
                  onClick={() => {
                    setTokenModalOpen(false);
                    setPendingAction(null);
                  }}
                  className="button-secondary"
                  style={{ padding: "0.4rem 0.8rem", fontSize: "0.875rem" }}
                >
                  Cancel
                </button>
                <button
                  type="submit"
                  disabled={!tokenInput.trim()}
                  className="button-primary"
                  style={{ padding: "0.4rem 0.8rem", fontSize: "0.875rem" }}
                >
                  Authorize &amp; Proceed
                </button>
              </div>
            </form>
          </div>
        </div>
      )}
    </div>
  );
}
