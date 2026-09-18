import { useCallback, useEffect, useMemo, useRef, useState, type ReactElement, type ReactNode } from "react";
import {
  Bot,
  ChartLine,
  CircleDollarSign,
  Clock,
  Coins,
  Gauge,
  KeyRound,
  Layers,
  List,
  RefreshCw,
  Server,
  TriangleAlert,
  Zap,
  type LucideIcon,
} from "lucide-react";
import type { CooldownRowV1, DetailV1, DimensionRowV1, PanelCoverageV1, PanelId, QuotaRowV1, SnapshotV1, SpendTotalsV1, TokenTotalsV1, WindowId } from "../../../src/dashboard-contract.js";
import { fetchDetail, fetchSnapshot, isSessionExpired, snapshotPath, type DashboardFilters, defaultFilters } from "../api.js";
import { MetricChart } from "../charts/MetricChart.js";
import { DetailDialog } from "../components/DetailDialog.js";
import { PlatformDot } from "../components/PlatformDot.js";
import { StatusBadge } from "../components/StatusBadge.js";
import { SegmentedControl } from "../components/SegmentedControl.js";
import { BasisBadge, PanelCoverage, SpendCells, TokenCells } from "../components/ProjectionMetadata.js";
import { SummaryCards } from "../components/SummaryCards.js";
import { currencyMicrousd, duration, number, percent, relativeTime, stamp, utcBucketLabel } from "../formatters.js";
import { groupQuotaRowsByProvider, quotaHeadroom } from "../view-model.js";

const windows: readonly WindowId[] = ["1h", "24h", "7d", "30d", "today", "month", "lifetime"];
const COLLAPSE_ABOVE_ROWS = 8;
const THEME_STORAGE_KEY = "llm-relay.dashboard.theme.v1";
type Theme = "light" | "dark";

function readStoredTheme(): Theme | null {
  try {
    const value = window.localStorage.getItem(THEME_STORAGE_KEY);
    return value === "light" || value === "dark" ? value : null;
  } catch { return null; }
}

function storeTheme(value: Theme): void {
  try { window.localStorage.setItem(THEME_STORAGE_KEY, value); } catch { /* best-effort */ }
}

const PANEL_LINKS: ReadonlyArray<readonly [string, string]> = [
  ["chart-request-timeline-heading", "Requests"],
  ["chart-token-timeline-heading", "Tokens"],
  ["chart-latency-timeline-heading", "Latency"],
  ["chart-commit-timeline-heading", "Commit"],
  ["provider-heading", "Providers"],
  ["model-heading", "Models"],
  ["client-heading", "Clients"],
  ["credential-heading", "Credentials"],
  ["spend-heading", "Spend"],
  ["errors-heading", "Errors"],
  ["quotas-heading", "Quotas"],
  ["cooldowns-heading", "Cooldowns"],
];

type Availability = Readonly<{ visible: boolean; online: boolean }>;
type SnapshotLifecycle = Readonly<{ key: string; data: SnapshotV1 | null; lastGoodAt: string | null; loading: boolean; error: string | null }>;
type DetailLifecycle = Readonly<{ requestId: string | null; data: DetailV1 | null; loading: boolean; error: string | null }>;
type InFlight = { readonly controller: AbortController; readonly sequence: number };

function useAvailability(): Availability {
  const [availability, setAvailability] = useState<Availability>(() => ({ visible: document.visibilityState === "visible", online: navigator.onLine }));
  useEffect(() => {
    const update = () => setAvailability({ visible: document.visibilityState === "visible", online: navigator.onLine });
    window.addEventListener("online", update); window.addEventListener("offline", update); document.addEventListener("visibilitychange", update);
    return () => { window.removeEventListener("online", update); window.removeEventListener("offline", update); document.removeEventListener("visibilitychange", update); };
  }, []);
  return availability;
}

function isAbort(error: unknown): boolean { return error instanceof DOMException ? error.name === "AbortError" : error instanceof Error && error.name === "AbortError"; }

function Select({ label, value, values, onChange }: Readonly<{ label: string; value: string; values: readonly string[]; onChange(value: string): void }>): ReactElement {
  return <label>{label}<select value={value} onChange={(event) => onChange(event.target.value)}>{values.map((item) => <option key={item} value={item}>{item}</option>)}</select></label>;
}

export function AnalyticsDashboard({ session, onSessionExpired, onLogout, showRecentTable = false }: Readonly<{ session: string; onSessionExpired(): void; onLogout(signal: AbortSignal): Promise<void>; showRecentTable?: boolean }>): ReactElement {
  const [filters, setFilters] = useState<DashboardFilters>(defaultFilters);
  const [theme, setThemeState] = useState<Theme>(() => readStoredTheme() ?? "dark");
  const toggleTheme = () => { const next: Theme = theme === "light" ? "dark" : "light"; setThemeState(next); storeTheme(next); };
  const [loggingOut, setLoggingOut] = useState(false); const [logoutError, setLogoutError] = useState<string | null>(null);
  const detailTrigger = useRef<HTMLElement | null>(null); const detailFocusFallback = useRef<HTMLHeadingElement | null>(null); const detailWasOpen = useRef(false); const snapshotFlight = useRef<InFlight | null>(null); const detailFlight = useRef<InFlight | null>(null); const logoutFlight = useRef<AbortController | null>(null);
  const snapshotSequence = useRef(0); const detailSequence = useRef(0);
  const availability = useAvailability(); const snapshotKey = snapshotPath(filters); const readingEnabled = availability.visible && availability.online;
  const [snapshotState, setSnapshotState] = useState<SnapshotLifecycle>(() => ({ key: snapshotKey, data: null, lastGoodAt: null, loading: false, error: null }));
  const [detailState, setDetailState] = useState<DetailLifecycle>({ requestId: null, data: null, loading: false, error: null });
  const abortSnapshot = useCallback(() => { snapshotFlight.current?.controller.abort(); snapshotFlight.current = null; }, []);
  const abortDetail = useCallback(() => { detailFlight.current?.controller.abort(); detailFlight.current = null; }, []);
  const restoreDetailFocus = useCallback(() => { queueMicrotask(() => { const trigger = detailTrigger.current; if (trigger?.isConnected) trigger.focus(); else detailFocusFallback.current?.focus(); }); }, []);
  const loadSnapshot = useCallback(() => {
    if (!readingEnabled) return;
    abortSnapshot(); const sequence = ++snapshotSequence.current; const controller = new AbortController(); snapshotFlight.current = { controller, sequence };
    setSnapshotState((previous) => previous.key === snapshotKey ? { ...previous, loading: true, error: null } : { key: snapshotKey, data: null, lastGoodAt: null, loading: true, error: null });
    void fetchSnapshot(session, filters, controller.signal).then((data) => {
      if (controller.signal.aborted || sequence !== snapshotSequence.current) return;
      setSnapshotState({ key: snapshotKey, data, lastGoodAt: new Date().toISOString(), loading: false, error: null });
    }).catch((error: unknown) => {
      if (controller.signal.aborted || sequence !== snapshotSequence.current || isAbort(error)) return;
      if (isSessionExpired(error)) { onSessionExpired(); return; }
      setSnapshotState((previous) => previous.key === snapshotKey ? { ...previous, loading: false, error: "Refresh failed. Showing the last good snapshot when available." } : previous);
    }).finally(() => { if (snapshotFlight.current?.sequence === sequence) snapshotFlight.current = null; });
  }, [abortSnapshot, filters, onSessionExpired, readingEnabled, session, snapshotKey]);
  useEffect(() => { if (!readingEnabled) { abortSnapshot(); return; } loadSnapshot(); return abortSnapshot; }, [abortSnapshot, loadSnapshot, readingEnabled, snapshotKey]);
  useEffect(() => { if (!readingEnabled) return; const timer = window.setInterval(() => { if (!snapshotFlight.current) loadSnapshot(); }, 30_000); return () => window.clearInterval(timer); }, [loadSnapshot, readingEnabled]);
  useEffect(() => () => { abortSnapshot(); abortDetail(); logoutFlight.current?.abort(); }, [abortDetail, abortSnapshot]);
  useEffect(() => { abortDetail(); setDetailState({ requestId: null, data: null, loading: false, error: null }); }, [abortDetail, filters, readingEnabled]);
  useEffect(() => {
    if (detailState.data !== null) { detailWasOpen.current = true; return; }
    if (!detailWasOpen.current) return;
    detailWasOpen.current = false;
    restoreDetailFocus();
  }, [detailState.data, restoreDetailFocus]);
  const setFilter = <K extends keyof DashboardFilters>(key: K, value: DashboardFilters[K]) => setFilters((old) => ({ ...old, [key]: value }));
  const options = useMemo(() => ({ providers: snapshotState.data ? ["all", ...snapshotState.data.providers.map((row) => row.provider)] : ["all"], models: snapshotState.data ? ["all", ...snapshotState.data.models.map((row) => row.model)] : ["all"], clients: snapshotState.data ? ["all", ...snapshotState.data.clients.map((row) => row.client)] : ["all"], credentials: snapshotState.data ? ["all", ...snapshotState.data.credentials.map((row) => row.credentialId)] : ["all"] }), [snapshotState.data]);
  const openDetail = (requestId: string) => {
    if (!readingEnabled) return;
    abortDetail(); const sequence = ++detailSequence.current; const controller = new AbortController(); detailFlight.current = { controller, sequence };
    setDetailState({ requestId, data: null, loading: true, error: null });
    void fetchDetail(session, requestId, filters.includeRepair, controller.signal).then((data) => {
      if (!controller.signal.aborted && sequence === detailSequence.current) setDetailState({ requestId, data, loading: false, error: null });
    }).catch((error: unknown) => {
      if (controller.signal.aborted || sequence !== detailSequence.current || isAbort(error)) return;
      if (isSessionExpired(error)) { onSessionExpired(); return; }
      setDetailState({ requestId, data: null, loading: false, error: "Request details are unavailable." });
    }).finally(() => { if (detailFlight.current?.sequence === sequence) detailFlight.current = null; });
  };
  const requestLogout = async () => {
    abortSnapshot(); abortDetail(); logoutFlight.current?.abort(); const controller = new AbortController(); logoutFlight.current = controller;
    setLoggingOut(true); setLogoutError(null);
    try { await onLogout(controller.signal); } catch (error) { if (!controller.signal.aborted) { if (isSessionExpired(error)) onSessionExpired(); else setLogoutError("Unable to end the dashboard session."); } } finally { if (logoutFlight.current === controller) logoutFlight.current = null; setLoggingOut(false); }
  };
  const snapshot = snapshotState.key === snapshotKey ? snapshotState.data : null;
  const status = !availability.online ? (snapshot ? "Offline: showing the last good snapshot." : "Offline: no snapshot available.") : !availability.visible ? "Polling paused while this tab is hidden." : snapshotState.loading ? "Refreshing measurements…" : snapshotState.error ?? (snapshot ? "Last updated " + stamp(snapshotState.lastGoodAt) + "." : "Loading measurements…");
  return <main className={"app " + theme} data-theme={theme} aria-busy={snapshotState.loading}>
    <header>
      <div>
        <p className="eyebrow">Read-only relay analytics</p>
        <h1 ref={detailFocusFallback} tabIndex={-1}>Usage and fleet health</h1>
      </div>
      <div className="header-actions">
        <button type="button" onClick={toggleTheme}>Use {theme === "light" ? "dark" : "light"} theme</button>
        <button type="button" onClick={loadSnapshot} disabled={!readingEnabled}><RefreshCw aria-hidden="true" size={16} /> Refresh</button>
        <button type="button" onClick={() => void requestLogout()} disabled={loggingOut}>{loggingOut ? "Ending session…" : "Logout"}</button>
      </div>
    </header>
    <p className="status" role="status" aria-live="polite">{status}</p>{logoutError && <p className="status error" role="alert">{logoutError}</p>}
    {snapshot && <nav className="panel-nav" aria-label="Jump to a panel"><ul>{PANEL_LINKS.map(([id, label]) => <li key={id}><a href={`#${id}`}>{label}</a></li>)}</ul></nav>}
    <div className="range-nav">
      <span className="range-nav-label">Window:</span>
      <SegmentedControl ariaLabel="Quick time window" value={filters.window} options={windows} onValueChange={(value) => setFilter("window", value as WindowId)} />
    </div>
    <section className="filters" aria-label="Snapshot filters">
      <Select label="Window" value={filters.window} values={windows} onChange={(value) => setFilter("window", value as WindowId)} />
      <Select label="Attribution" value={filters.attribution} values={["all", "relay-held", "caller-operated"]} onChange={(value) => setFilter("attribution", value as DashboardFilters["attribution"])} />
      <label><input type="checkbox" checked={filters.includeRepair} onChange={(event) => setFilter("includeRepair", event.target.checked)} /> Include repair attempts</label>
      <Select label="Provider" value={filters.provider ?? "all"} values={options.providers} onChange={(value) => setFilter("provider", value === "all" ? undefined : value)} />
      <Select label="Model" value={filters.model ?? "all"} values={options.models} onChange={(value) => setFilter("model", value === "all" ? undefined : value)} />
      <Select label="Client" value={filters.client ?? "all"} values={options.clients} onChange={(value) => setFilter("client", value === "all" ? undefined : value)} />
      <Select label="Credential" value={filters.credentialId ?? "all"} values={options.credentials} onChange={(value) => setFilter("credentialId", value === "all" ? undefined : value)} />
      <Select label="Outcome" value={filters.outcome ?? "all"} values={["all", "success", "error", "cancelled", "unknown"]} onChange={(value) => setFilter("outcome", value === "all" ? undefined : value as DashboardFilters["outcome"])} />
      <Select label="Failure" value={filters.failureKind ?? "all"} values={["all", "timeout", "provider_error", "auth_error", "rate_limit", "aborted", "protocol", "unknown"]} onChange={(value) => setFilter("failureKind", value === "all" ? undefined : value as DashboardFilters["failureKind"])} />
    </section>
    {snapshotState.error !== null && snapshot === null && <section className="panel error" role="alert"><h2>Dashboard unavailable</h2><p>Unable to read dashboard measurements.</p></section>}
    {snapshot && <DashboardBody snapshot={snapshot} onDetail={openDetail} rememberTrigger={(target) => { detailTrigger.current = target; }} showRecentTable={showRecentTable} />}
    {detailState.loading && <p className="status" role="status">Loading request details…</p>}{detailState.error && <section className="panel error" role="alert"><h2>Request details unavailable</h2><p>{detailState.error}</p></section>}
    {detailState.data && <DetailDialog detail={detailState.data} onClose={() => { setDetailState({ requestId: null, data: null, loading: false, error: null }); }} />}
  </main>;
}

function coverageFor(snapshot: SnapshotV1, panel: PanelId): PanelCoverageV1 | undefined { return snapshot.panelCoverage.find((item) => item.panel === panel); }
function ResponsiveTable({ caption, headers, children }: Readonly<{ caption: string; headers: readonly string[]; children: ReactNode }>): ReactElement { return <div className="table-wrap"><table className="responsive-table"><caption>{caption}</caption><thead><tr>{headers.map((header) => <th scope="col" key={header}>{header}</th>)}</tr></thead><tbody>{children}</tbody></table></div>; }

function Panel({ id, title, icon: Icon, rowCount, children }: Readonly<{ id: string; title: string; icon?: LucideIcon | undefined; rowCount: number; children: ReactNode }>): ReactElement {
  return <section className="panel" aria-labelledby={id + "-heading"}><div className="panel-header"><h2 id={id + "-heading"} className="panel-title">{Icon && <Icon className="panel-icon" aria-hidden="true" />}{title} <span className="panel-count">({number(rowCount)} row{rowCount === 1 ? "" : "s"})</span></h2></div>{children}</section>;
}

function safe(value: string | null): string { return value ?? "Unavailable"; }
export function quotaRowKey(row: QuotaRowV1): string { return JSON.stringify([row.credentialId, row.provider, row.deployment, row.axis, row.period, row.limit, row.resetsAt, row.observedAt]); }
export function cooldownRowKey(row: CooldownRowV1): string { return JSON.stringify([row.credentialId, row.provider, row.deployment, row.reason, row.until, row.observedAt]); }

function DashboardBody({ snapshot, onDetail, rememberTrigger, showRecentTable = false }: Readonly<{ snapshot: SnapshotV1; onDetail(requestId: string): void; rememberTrigger(target: HTMLElement): void; showRecentTable?: boolean }>): ReactElement {
  const bucketRows = snapshot.buckets.map((bucket) => ({ id: bucket.from, label: utcBucketLabel(bucket.from, snapshot.window), requests: bucket.requests, attempts: bucket.attempts, reportedInput: bucket.tokens.reported.reportedInput.value, reportedOutput: bucket.tokens.reported.reportedOutput.value, cachedInput: bucket.tokens.reported.reportedCachedInput.value, estimatedInput: bucket.tokens.estimated.estimatedInput.value, estimatedOutput: bucket.tokens.estimated.estimatedOutput.value, avgLatency: bucket.avgLatencyMs, p95Latency: bucket.p95LatencyMs, avgCommit: bucket.avgCommitMs }));
  return <>
    <SummaryCards snapshot={snapshot} />
    <div className="analytics-grid">
      <div className="col-span-2">
        <MetricChart id="request-timeline" title="Request timeline" icon={ChartLine} rows={bucketRows} columns={[{ key: "requests", label: "Requests" }, { key: "attempts", label: "Attempts" }]} panelCoverage={coverageFor(snapshot, "request_timeline")} />
      </div>
      <div className="col-span-2">
        <MetricChart id="token-timeline" title="Token timeline" icon={Coins} rows={bucketRows} columns={[{ key: "reportedInput", label: "Reported input" }, { key: "reportedOutput", label: "Reported output" }, { key: "cachedInput", label: "Reported cached input" }, { key: "estimatedInput", label: "Estimated input" }, { key: "estimatedOutput", label: "Estimated output" }]} panelCoverage={coverageFor(snapshot, "token_timeline")} />
      </div>
      <div>
        <MetricChart id="latency-timeline" title="Latency timeline" icon={Gauge} rows={bucketRows} columns={[{ key: "avgLatency", label: "Average latency (ms)" }, { key: "p95Latency", label: "P95 latency (ms)" }]} panelCoverage={coverageFor(snapshot, "latency")} />
      </div>
      <div>
        <MetricChart id="commit-timeline" title="Commit timeline" icon={Zap} rows={bucketRows} columns={[{ key: "avgCommit", label: "Average commit (ms)" }]} panelCoverage={coverageFor(snapshot, "commit")} />
      </div>
      <div className="col-span-2">
        <DimensionPanel snapshot={snapshot} panel="provider" title="Providers" icon={Server} rows={snapshot.providers} label={(row) => (row as typeof snapshot.providers[number]).provider} />
      </div>
      <div className="col-span-2">
        <DimensionPanel snapshot={snapshot} panel="model" title="Models" icon={Layers} rows={snapshot.models} label={(row) => { const model = row as typeof snapshot.models[number]; return model.provider + " / " + model.model; }} />
      </div>
      <div>
        <DimensionPanel snapshot={snapshot} panel="client" title="Clients" icon={Bot} rows={snapshot.clients} label={(row) => (row as typeof snapshot.clients[number]).client} />
      </div>
      <div>
        <DimensionPanel snapshot={snapshot} panel="credential" title="Credentials" icon={KeyRound} rows={snapshot.credentials} label={(row) => { const credential = row as typeof snapshot.credentials[number]; return credential.provider + " / " + credential.label + " (" + credential.credentialId + ")"; }} />
      </div>
      <div>
        <SpendPanel snapshot={snapshot} />
      </div>
      <div>
        <ErrorPanel snapshot={snapshot} />
      </div>
      <div className="col-span-2">
        <QuotaPanel snapshot={snapshot} />
      </div>
      <div className="col-span-2">
        <CooldownPanel snapshot={snapshot} />
      </div>
      {showRecentTable && (
        <div className="col-span-2">
          <RecentPanel snapshot={snapshot} onDetail={onDetail} rememberTrigger={rememberTrigger} />
        </div>
      )}
    </div>
  </>;
}

function SpendPanel({ snapshot }: Readonly<{ snapshot: SnapshotV1 }>): ReactElement {
  const spend = snapshot.summary.spend;
  const rows: ReadonlyArray<readonly [string, SpendTotalsV1[keyof Omit<SpendTotalsV1, "unpricedRequests" | "partiallyPricedRequests">]]> = [["Provider-published / reported", spend.providerPublishedReported], ["Provider-published / estimated", spend.providerPublishedEstimated], ["Reference / reported", spend.referenceReported], ["Reference / estimated", spend.referenceEstimated]];
  return <Panel id="spend" title="Spend detail" icon={CircleDollarSign} rowCount={rows.length}><PanelCoverage label="Spend" value={coverageFor(snapshot, "spend")} /><ResponsiveTable caption="Spend cells are intentionally not blended" headers={["Cell", "Amount", "Price source", "Token basis", "Measurement source", "Observed"]}>{rows.map(([label, cell]) => <tr key={label}><th scope="row" data-label="Cell">{label}</th><td data-label="Amount">{currencyMicrousd(cell.amountMicrousd)}</td><td data-label="Price source">{cell.priceSource}</td><td data-label="Token basis">{cell.tokenBasis}</td><td data-label="Measurement source">{cell.source}</td><td data-label="Observed">{stamp(cell.observedAt)}</td></tr>)}<tr><th scope="row" data-label="Cell">Unpriced requests</th><td data-label="Amount" colSpan={5}>{number(spend.unpricedRequests)}</td></tr><tr><th scope="row" data-label="Cell">Partially priced requests</th><td data-label="Amount" colSpan={5}>{spend.partiallyPricedRequests > 0 ? number(spend.partiallyPricedRequests) + " — amounts above are lower bounds" : "0"}</td></tr></ResponsiveTable></Panel>;
}

function compactTokens(tokens: TokenTotalsV1 | null): string {
  if (tokens === null) return "Unavailable";
  const inTokens = tokens.reported.reportedInput.value ?? tokens.estimated.estimatedInput.value;
  const outTokens = tokens.reported.reportedOutput.value ?? tokens.estimated.estimatedOutput.value;
  if (inTokens === null && outTokens === null) return "Unavailable";
  return `${number(inTokens)} in / ${number(outTokens)} out`;
}

function compactSpend(spend: SpendTotalsV1 | null): string {
  if (spend === null) return "Unavailable";
  const amount = spend.providerPublishedReported.amountMicrousd
    ?? spend.providerPublishedEstimated.amountMicrousd
    ?? spend.referenceReported.amountMicrousd
    ?? spend.referenceEstimated.amountMicrousd;
  if (amount === null) return "Unavailable";
  return currencyMicrousd(amount) + (spend.partiallyPricedRequests > 0 ? " (lower bound)" : "");
}

function DimensionPanel({ snapshot, panel, title, icon, rows, label }: Readonly<{ snapshot: SnapshotV1; panel: "provider" | "model" | "client" | "credential"; title: string; icon?: LucideIcon | undefined; rows: readonly DimensionRowV1[]; label(row: DimensionRowV1): string }>): ReactElement {
  return <Panel id={panel} title={title} icon={icon} rowCount={rows.length}>
    <PanelCoverage label={title} value={coverageFor(snapshot, panel)} />
    <ResponsiveTable caption={title + " breakdown"} headers={["Dimension", "Requests", "Attempts", "Served", "Errors", "Cancelled", "Success", "Latency", "Commit", "Tokens", "Spend"]}>
      {rows.length === 0 ? <tr><td className="empty-row" colSpan={11}>No matching measurements.</td></tr> : rows.map((row) => {
        const prov = panel === "provider" ? (row as typeof snapshot.providers[number]).provider : panel === "model" ? (row as typeof snapshot.models[number]).provider : panel === "credential" ? (row as typeof snapshot.credentials[number]).provider : null;
        return (
          <tr key={label(row)}>
            <th scope="row" data-label="Dimension">
              <span className="inline-flex items-center">
                {prov && <PlatformDot provider={prov} />}
                {label(row)}
              </span>
            </th>
            <td data-label="Requests">{number(row.requests)}</td>
            <td data-label="Attempts">{number(row.attempts)}</td>
            <td data-label="Served">{number(row.served)}</td>
            <td data-label="Errors">{number(row.errored)}</td>
            <td data-label="Cancelled">{number(row.cancelled)}</td>
            <td data-label="Success">{percent(row.successRate)}</td>
            <td data-label="Latency">{duration(row.avgLatencyMs)}</td>
            <td data-label="Commit">{duration(row.avgCommitMs)}</td>
            <td data-label="Tokens">{compactTokens(row.tokens)}</td>
            <td data-label="Spend">{compactSpend(row.spend)}</td>
          </tr>
        );
      })}
    </ResponsiveTable>
  </Panel>;
}

function ErrorPanel({ snapshot }: Readonly<{ snapshot: SnapshotV1 }>): ReactElement {
  return <Panel id="errors" title="Normalized errors" icon={TriangleAlert} rowCount={snapshot.errors.length}>
    <PanelCoverage label="Errors" value={coverageFor(snapshot, "errors")} />
    <ResponsiveTable caption="Normalized error distribution" headers={["Failure kind", "Outcome", "Requests"]}>
      {snapshot.errors.length === 0 ? <tr><td className="empty-row" colSpan={3}>No matching measurements.</td></tr> : snapshot.errors.map((row) => (
        <tr key={row.failureKind + "-" + row.outcome}>
          <th scope="row" data-label="Failure kind"><StatusBadge value={row.failureKind} /></th>
          <td data-label="Outcome"><StatusBadge value={row.outcome} /></td>
          <td data-label="Requests">{number(row.requests)}</td>
        </tr>
      ))}
    </ResponsiveTable>
  </Panel>;
}

const QUOTA_HEADERS = ["Deployment", "Axis / period", "Remaining", "Limit", "Local used", "Headroom", "Resets", "Observed"] as const;

function QuotaRow({ row }: Readonly<{ row: QuotaRowV1 }>): ReactElement {
  return <tr key={quotaRowKey(row)}>
    <th scope="row" data-label="Deployment">
      <span className="inline-flex items-center">
        <PlatformDot provider={row.provider} />
        <strong>{row.label}</strong>
      </span>
      {row.deployment !== null && <span className="muted"> · {row.deployment}</span>}
      <small className="muted"> ({row.credentialId})</small>
    </th>
    <td data-label="Axis / period">{row.axis} / {row.period}</td>
    <td data-label="Remaining"><span className="quota-value">{number(row.remaining)}</span> <BasisBadge value={row.remainingBasis} /></td>
    <td data-label="Limit"><span className="quota-value">{number(row.limit)}</span> <BasisBadge value={row.limitBasis} /></td>
    <td data-label="Local used"><span className="quota-value">{number(row.localUsed)}</span> <BasisBadge value={row.localUsedBasis} /></td>
    <td data-label="Headroom">{percent(quotaHeadroom(row))}</td>
    <td data-label="Resets">{row.resetsAt === null ? "Unavailable" : <span className="quota-relative" title={stamp(row.resetsAt)}>{relativeTime(row.resetsAt)}</span>} {row.resetsAtBasis !== null && <BasisBadge value={row.resetsAtBasis} />}</td>
    <td data-label="Observed" title={stamp(row.observedAt)}>{row.observedAt === null ? "Unavailable" : relativeTime(row.observedAt)}</td>
  </tr>;
}

function QuotaPanel({ snapshot }: Readonly<{ snapshot: SnapshotV1 }>): ReactElement {
  const rows = snapshot.quotas;
  const groups = groupQuotaRowsByProvider(rows);
  return <Panel id="quotas" title="Quota headroom" icon={Gauge} rowCount={rows.length}><PanelCoverage label="Quotas" value={coverageFor(snapshot, "quotas")} />
    <div className="table-wrap"><table className="responsive-table quota-table"><caption>Quota measurements and derived headroom, grouped by provider</caption>
      <thead><tr>{QUOTA_HEADERS.map((header) => <th scope="col" key={header}>{header}</th>)}</tr></thead>
      {rows.length === 0
        ? <tbody><tr><td className="empty-row" colSpan={QUOTA_HEADERS.length}>No matching measurements.</td></tr></tbody>
        : groups.map(([provider, providerRows]) => <tbody key={provider}>
            <tr className="group-row"><th scope="rowgroup" colSpan={QUOTA_HEADERS.length}><span className="group-name"><PlatformDot provider={provider} />{provider}</span> <span className="muted">({providerRows.length})</span></th></tr>
            {providerRows.map((row) => <QuotaRow key={quotaRowKey(row)} row={row} />)}
          </tbody>)}
    </table></div>
  </Panel>;
}

function CooldownPanel({ snapshot }: Readonly<{ snapshot: SnapshotV1 }>): ReactElement {
  return <Panel id="cooldowns" title="Cooldowns" icon={Clock} rowCount={snapshot.cooldowns.length}>
    <PanelCoverage label="Cooldowns" value={coverageFor(snapshot, "cooldowns")} />
    <ResponsiveTable caption="Normalized cooldowns" headers={["Credential", "Provider", "Deployment", "Reason", "Until", "Observed"]}>
      {snapshot.cooldowns.length === 0 ? <tr><td className="empty-row" colSpan={6}>No matching measurements.</td></tr> : snapshot.cooldowns.map((row) => (
        <tr key={cooldownRowKey(row)}>
          <th scope="row" data-label="Credential">{row.credentialId}</th>
          <td data-label="Provider"><span className="inline-flex items-center"><PlatformDot provider={row.provider} />{row.provider}</span></td>
          <td data-label="Deployment">{safe(row.deployment)}</td>
          <td data-label="Reason"><StatusBadge value={row.reason} /></td>
          <td data-label="Until">{stamp(row.until)}</td>
          <td data-label="Observed">{stamp(row.observedAt)}</td>
        </tr>
      ))}
    </ResponsiveTable>
  </Panel>;
}

function RecentPanel({ snapshot, onDetail, rememberTrigger }: Readonly<{ snapshot: SnapshotV1; onDetail(requestId: string): void; rememberTrigger(target: HTMLElement): void }>): ReactElement {
  return <Panel id="recent" title="Recent requests" icon={List} rowCount={snapshot.recentRequests.length}>
    <PanelCoverage label="Recent requests" value={coverageFor(snapshot, "recent")} />
    <ResponsiveTable caption="Bounded recent request projection" headers={["Request", "Occurred", "Client", "Attribution", "Outcome", "Failure", "Attempts", "Latency", "Commit", "Provider", "Model", "Credential", "Tokens", "Spend", "Repair included", "Details"]}>
      {snapshot.recentRequests.length === 0 ? <tr><td className="empty-row" colSpan={16}>No matching measurements.</td></tr> : snapshot.recentRequests.map((row) => (
        <tr key={row.requestId}>
          <th scope="row" data-label="Request">{row.requestId}</th>
          <td data-label="Occurred" title={stamp(row.occurredAt)}>{relativeTime(row.occurredAt)}</td>
          <td data-label="Client">{safe(row.client)}</td>
          <td data-label="Attribution">{row.attribution}</td>
          <td data-label="Outcome"><StatusBadge value={row.outcome} /></td>
          <td data-label="Failure">{row.failureKind ? <StatusBadge value={row.failureKind} /> : "None"}</td>
          <td data-label="Attempts">{number(row.attemptCount)}</td>
          <td data-label="Latency">{duration(row.latencyMs)}</td>
          <td data-label="Commit">{duration(row.commitMs)}</td>
          <td data-label="Provider">{row.provider ? <span className="inline-flex items-center"><PlatformDot provider={row.provider} />{row.provider}</span> : "Unavailable"}</td>
          <td data-label="Model">{safe(row.model)}</td>
          <td data-label="Credential">{safe(row.credentialId)}</td>
          <td data-label="Tokens">{compactTokens(row.tokens)}</td>
          <td data-label="Spend">{compactSpend(row.spend)}</td>
          <td data-label="Repair included">{row.repairIncluded ? "Yes" : "No"}</td>
          <td data-label="Details"><button type="button" onClick={(event) => { rememberTrigger(event.currentTarget); onDetail(row.requestId); }}><span className="sr-only">View request </span>{row.requestId}</button></td>
        </tr>
      ))}
    </ResponsiveTable>
  </Panel>;
}
