import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { axe } from "vitest-axe";
import { describe, expect, it, vi } from "vitest";
import { DetailDialog } from "./components/DetailDialog.js";
import { detail, snapshot } from "./test-fixtures.js";
import { AnalyticsDashboard } from "./pages/AnalyticsDashboard.js";
import { cooldownRowKey, quotaRowKey } from "./pages/AnalyticsDashboard.js";
import { defaultFilters, snapshotPath } from "./api.js";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import postcss from "postcss";
import { utcBucketLabel } from "./formatters.js";

const media = "application/vnd.llm-relay.dashboard+json; version=1";
const response = (value: unknown) => new Response(JSON.stringify(value), { status: 200, headers: { "Content-Type": media } });
async function flush(): Promise<void> { await act(async () => { await Promise.resolve(); await Promise.resolve(); }); }
// This jsdom test environment has no real global localStorage, so theme-persistence tests inject
// their own in-memory Storage the same way app.test.tsx injects sessionStorage.
function fakeLocalStorage(seed: Record<string, string> = {}): Storage {
  const values = new Map(Object.entries(seed));
  return { getItem: (key: string) => values.get(key) ?? null, setItem: (key: string, value: string) => void values.set(key, value), removeItem: (key: string) => void values.delete(key), clear: () => values.clear(), key: (_index: number) => null, get length() { return values.size; } } as unknown as Storage;
}

describe("dashboard accessibility and truthfulness", () => {
  it("renders every safe panel with labelled coverage, controls, tables, and unblended spend", async () => {
    const quotaZero = { ...snapshot.quotas[0]!, credentialId: "openai#zero", label: "zero", remaining: 0, localUsed: 0 };
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(response({ ...snapshot, quotas: [...snapshot.quotas, quotaZero] })));
    const { container } = render(<AnalyticsDashboard session="memory-session" onSessionExpired={vi.fn()} onLogout={vi.fn().mockResolvedValue(undefined)} />);
    await waitFor(() => expect(screen.getByRole("heading", { name: "Requests" })).toBeInTheDocument());
    for (const control of ["Window", "Attribution", "Provider", "Model", "Client", "Credential", "Outcome", "Failure"]) expect(screen.getByLabelText(control)).toBeInTheDocument();
    for (const panel of ["Summary", "Request timeline", "Token timeline", "Spend", "Providers", "Models", "Clients", "Credentials", "Latency timeline", "Commit timeline", "Errors", "Recent requests", "Quotas", "Cooldowns"]) expect(screen.getByLabelText(panel + " data status")).toBeInTheDocument();
    expect(screen.getAllByText("Provider-published / reported").length).toBeGreaterThan(0); expect(screen.getAllByText("Reference / estimated").length).toBeGreaterThan(0); expect(screen.queryByText("$6.0000")).not.toBeInTheDocument();
    expect(screen.getAllByText("Unavailable").length).toBeGreaterThan(0); expect(screen.getByText("50.0%")).toBeInTheDocument(); expect(screen.getByText("0.0%")).toBeInTheDocument();
    const chartIds = screen.getAllByRole("heading", { level: 2 }).filter((heading) => heading.id.startsWith("chart-")).map((heading) => heading.id); expect(new Set(chartIds).size).toBe(chartIds.length);
    expect(container.querySelectorAll("table.responsive-table")).toHaveLength(9);
    expect((await axe(container, { rules: { "color-contrast": { enabled: false } } })).violations).toEqual([]);
  });
  it("keeps labelled table data usable at 320, 768, and 1280px; themes and reduced motion stay self-hosted", async () => {
    vi.stubGlobal("localStorage", fakeLocalStorage());
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(response(snapshot)));
    const { container } = render(<AnalyticsDashboard session="memory-session" onSessionExpired={vi.fn()} onLogout={vi.fn().mockResolvedValue(undefined)} />);
    await flush();
    for (const width of [320, 768, 1280]) { Object.defineProperty(window, "innerWidth", { configurable: true, value: width }); window.dispatchEvent(new Event("resize")); expect(container.querySelectorAll("[data-label]").length).toBeGreaterThan(20); }
    expect(container.querySelector("main")?.getAttribute("data-theme")).toBe("dark");
    fireEvent.click(screen.getByRole("button", { name: "Use light theme" })); expect(container.querySelector("main")?.getAttribute("data-theme")).toBe("light");
    expect(container.querySelectorAll("table").item(0)?.getAttribute("style")).toBeNull();
    vi.unstubAllGlobals();
  });
  it("defaults to dark with no stored preference, and honours an explicit light choice on the next mount", async () => {
    vi.stubGlobal("localStorage", fakeLocalStorage());
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(response(snapshot)));
    const first = render(<AnalyticsDashboard session="memory-session" onSessionExpired={vi.fn()} onLogout={vi.fn().mockResolvedValue(undefined)} />);
    await flush();
    expect(first.container.querySelector("main")?.getAttribute("data-theme")).toBe("dark");
    fireEvent.click(screen.getByRole("button", { name: "Use light theme" }));
    expect(first.container.querySelector("main")?.getAttribute("data-theme")).toBe("light");
    first.unmount();
    const second = render(<AnalyticsDashboard session="memory-session" onSessionExpired={vi.fn()} onLogout={vi.fn().mockResolvedValue(undefined)} />);
    await flush();
    expect(second.container.querySelector("main")?.getAttribute("data-theme")).toBe("light");
    second.unmount();
    vi.unstubAllGlobals();
  });
  it("keeps the theme toggle working when localStorage throws (a private window or blocked site data)", async () => {
    const throwing = { getItem: vi.fn(() => { throw new Error("storage blocked"); }), setItem: vi.fn(() => { throw new Error("storage blocked"); }), removeItem: vi.fn() };
    vi.stubGlobal("localStorage", throwing);
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(response(snapshot)));
    const { container } = render(<AnalyticsDashboard session="memory-session" onSessionExpired={vi.fn()} onLogout={vi.fn().mockResolvedValue(undefined)} />);
    await flush();
    expect(container.querySelector("main")?.getAttribute("data-theme")).toBe("dark");
    fireEvent.click(screen.getByRole("button", { name: "Use light theme" }));
    expect(container.querySelector("main")?.getAttribute("data-theme")).toBe("light");
    vi.unstubAllGlobals();
  });
  it("keeps dialog focus trapped and exposes bounded projection coverage without raw content", async () => {
    const close = vi.fn(); const { container } = render(<DetailDialog detail={detail} onClose={close} />);
    expect(screen.getByRole("dialog")).toHaveTextContent("Request projection"); expect(screen.getByLabelText("Detail recent data status")).toBeInTheDocument(); expect(screen.getByRole("button", { name: "Close details" })).toHaveFocus();
    fireEvent.keyDown(window, { key: "Tab", shiftKey: true }); expect(screen.getByRole("button", { name: "Close details" })).toHaveFocus();
    expect((await axe(container, { rules: { "color-contrast": { enabled: false } } })).violations).toEqual([]);
    fireEvent.keyDown(window, { key: "Escape" }); expect(close).toHaveBeenCalledOnce();
  });
});

describe("dashboard UI contracts", () => {
  it("encodes every filter control into the exact snapshot query", async () => {
    const fetchMock = vi.fn().mockImplementation(() => Promise.resolve(response(snapshot))); vi.stubGlobal("fetch", fetchMock);
    render(<AnalyticsDashboard session="memory-session" onSessionExpired={vi.fn()} onLogout={vi.fn().mockResolvedValue(undefined)} />); await waitFor(() => expect(fetchMock).toHaveBeenCalled());
    const controls: Array<[string, string, string]> = [["Window", "7d", "window"], ["Attribution", "relay-held", "attribution"], ["Provider", "openai", "provider"], ["Model", "gpt-test", "model"], ["Client", "cli", "client"], ["Credential", "openai#primary", "credentialId"], ["Outcome", "success", "outcome"], ["Failure", "unknown", "failureKind"]];
    let expected = { ...defaultFilters } as any;
    for (const [label, value, key] of controls) { await waitFor(() => expect(screen.getAllByRole("option", { name: value }).length).toBeGreaterThan(0)); fireEvent.change(screen.getByLabelText(label), { target: { value } }); expected = { ...expected, [key]: value }; await waitFor(() => expect(fetchMock.mock.calls.at(-1)?.[0]).toBe(snapshotPath(expected))); }
    fireEvent.click(screen.getByLabelText("Include repair attempts")); expected = { ...expected, includeRepair: false }; await waitFor(() => expect(fetchMock.mock.calls.at(-1)?.[0]).toBe(snapshotPath(expected)));
  });
  it("checks the shipped palette, responsive breakpoints, and reduced-motion rule", () => {
    const luminance = (hex: string) => { const rgb = hex.match(/[0-9a-f]{2}/gi)!.map((v) => parseInt(v, 16) / 255).map((v) => v <= .03928 ? v / 12.92 : ((v + .055) / 1.055) ** 2.4); return .2126 * rgb[0]! + .7152 * rgb[1]! + .0722 * rgb[2]!; };
    const contrast = (a: string, b: string) => { const x = luminance(a), y = luminance(b); return (Math.max(x, y) + .05) / (Math.min(x, y) + .05); };
    expect(contrast("#526177", "#ffffff")).toBeGreaterThanOrEqual(4.5); expect(contrast("#c1cadd", "#172033")).toBeGreaterThanOrEqual(4.5); expect(contrast("#b45309", "#ffffff")).toBeGreaterThanOrEqual(3); expect(contrast("#fbbf24", "#172033")).toBeGreaterThanOrEqual(3);
    // Resolved against this test file's own URL, so the read is independent of
    // process.cwd() and works whether vitest runs from the repo root or dashboard/.
    const css = readFileSync(join(dirname(fileURLToPath(import.meta.url)), "styles.css"), "utf8"); const root = postcss.parse(css); const media = (params: string) => { const rule = root.nodes.find((node): node is postcss.AtRule => node.type === "atrule" && node.name === "media" && node.params === params); expect(rule).toBeDefined(); return rule!; }; const rules = (params: string) => media(params).nodes?.filter((node): node is postcss.Rule => node.type === "rule") ?? []; const selectors = (params: string) => rules(params).map((rule) => rule.selector); const declaration = (params: string, selector: string, property: string, value: string) => { const rule = rules(params).find((candidate) => candidate.selector === selector); expect(rule).toBeDefined(); expect(rule!.nodes?.some((node) => node.type === "decl" && node.prop === property && node.value === value.replace(" !important", "") && (value.includes("!important") ? node.important : true))).toBe(true); };
    expect(selectors("(max-width: 767px)")).toEqual(expect.arrayContaining([".responsive-table thead", ".responsive-table tr", ".responsive-table th[scope=\"row\"], .responsive-table td"])); declaration("(max-width: 767px)", ".filters label", "min-width", "calc(50% - .4rem)"); expect(selectors("(max-width: 360px)")).toEqual(expect.arrayContaining([".summary-grid", ".filters label", ".detail-grid"])); declaration("(max-width: 360px)", ".summary-grid", "grid-template-columns", "1fr"); expect(selectors("(min-width: 768px)")).toEqual(expect.arrayContaining([".summary-grid", ".cell-list"])); declaration("(min-width: 768px)", ".summary-grid", "grid-template-columns", "repeat(4, minmax(0, 1fr))"); expect(selectors("(min-width: 1280px)")).toEqual(expect.arrayContaining([".summary-grid", ".spend-card", ".chart-panel"])); declaration("(min-width: 1280px)", ".summary-grid", "grid-template-columns", "repeat(8, minmax(0, 1fr))"); const reduced = "*, *::before, *::after"; declaration("(prefers-reduced-motion: reduce)", reduced, "scroll-behavior", "auto !important"); declaration("(prefers-reduced-motion: reduce)", reduced, "transition-duration", ".01ms !important"); declaration("(prefers-reduced-motion: reduce)", reduced, "animation-duration", ".01ms !important"); declaration("(prefers-reduced-motion: reduce)", reduced, "animation-iteration-count", "1 !important"); expect(css).not.toMatch(/table\s*\{[^}]*min-width/i); expect(css).toContain("outline: 3px solid var(--focus)");
  });
  it("renders long-window bucket labels with the year", () => { expect(utcBucketLabel("2024-01-02T03:04:00.000Z", "30d")).toContain("2024"); expect(utcBucketLabel("2024-01-02T03:04:00.000Z", "month")).toContain("2024"); });
it("keeps quota and cooldown identities distinct for pipe-containing tuples and renders all rows", async () => { const quotaA = { ...snapshot.quotas[0]!, credentialId: "cred|prov", provider: "dep", deployment: "x", label: "Quota A" }; const quotaB = { ...quotaA, credentialId: "cred", provider: "prov|dep", label: "Quota B" }; const cooldownA = { credentialId: "cool|provider", provider: "deploy", deployment: "x", reason: "rate_limit" as const, until: "2026-08-20T12:01:00.000Z", observedAt: "2026-08-20T12:00:00.000Z" }; const cooldownB = { ...cooldownA, credentialId: "cool", provider: "provider|deploy" }; const oldQuotaA = [quotaA.credentialId, quotaA.provider, quotaA.deployment].join("|"); const oldQuotaB = [quotaB.credentialId, quotaB.provider, quotaB.deployment].join("|"); const oldCooldownKey = (row: typeof cooldownA) => [row.credentialId, row.provider, row.deployment, row.reason, row.until, row.observedAt].join("|"); expect(oldQuotaA).toBe(oldQuotaB); expect(quotaRowKey(quotaA)).not.toBe(quotaRowKey(quotaB)); expect(oldCooldownKey(cooldownA)).toBe(oldCooldownKey(cooldownB)); expect(cooldownRowKey(cooldownA)).not.toBe(cooldownRowKey(cooldownB)); vi.stubGlobal("fetch", vi.fn().mockResolvedValue(response({ ...snapshot, quotas: [quotaA, quotaB], cooldowns: [cooldownA, cooldownB] }))); render(<AnalyticsDashboard session="memory-session" onSessionExpired={vi.fn()} onLogout={vi.fn().mockResolvedValue(undefined)} />); await waitFor(() => expect(screen.getByText(/Quota A/)).toBeInTheDocument()); expect(screen.getByText(/Quota B/)).toBeInTheDocument(); expect(screen.getByText("cool|provider")).toBeInTheDocument(); expect(screen.getByText("cool")).toBeInTheDocument(); });
  it("traps dialog focus in both directions and returns focus to the originating request", async () => {
    vi.stubGlobal("fetch", vi.fn().mockImplementationOnce(() => Promise.resolve(response(snapshot))).mockImplementation(() => Promise.resolve(response(detail))));
    const view = render(<AnalyticsDashboard session="memory-session" onSessionExpired={vi.fn()} onLogout={vi.fn().mockResolvedValue(undefined)} />);
    await waitFor(() => expect(screen.getByRole("button", { name: /View request/ })).toBeInTheDocument());
    const origin = screen.getByRole("button", { name: /View request/ }); fireEvent.click(origin); await waitFor(() => expect(screen.getByRole("dialog")).toBeInTheDocument());
    const close = screen.getByRole("button", { name: "Close details" }); close.focus(); fireEvent.keyDown(window, { key: "Tab" }); expect(close).toHaveFocus();
    const last = screen.getByRole("dialog").querySelectorAll<HTMLElement>("button, [href], input, select, textarea, [tabindex]:not([tabindex='-1'])"); last.item(last.length - 1)?.focus(); fireEvent.keyDown(window, { key: "Tab" }); expect(close).toHaveFocus();
    fireEvent.click(close); await waitFor(() => expect(origin).toHaveFocus()); view.unmount();
  });
  it("restores focus to a stable heading when automatic dismissal removes the trigger", async () => {
    vi.stubGlobal("fetch", vi.fn().mockImplementationOnce(() => Promise.resolve(response(snapshot))).mockImplementationOnce(() => Promise.resolve(response(detail))).mockImplementation(() => Promise.resolve(response(snapshot))));
    render(<AnalyticsDashboard session="memory-session" onSessionExpired={vi.fn()} onLogout={vi.fn().mockResolvedValue(undefined)} />);
    await waitFor(() => expect(screen.getByRole("button", { name: /View request/ })).toBeInTheDocument());
    fireEvent.click(screen.getByRole("button", { name: /View request/ }));
    await waitFor(() => expect(screen.getByRole("dialog")).toBeInTheDocument());
    fireEvent.change(screen.getByLabelText("Window"), { target: { value: "7d" } });
    await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
    await waitFor(() => expect(screen.getByRole("heading", { level: 1, name: "Usage and fleet health" })).toHaveFocus());
  });
});
