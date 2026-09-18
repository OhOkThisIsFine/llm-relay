import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { DashboardApp, resolveLaunchSession } from "./app.js";
import { SESSION_STORAGE_KEY } from "./api.js";
import { snapshot } from "./test-fixtures.js";

const media = "application/vnd.llm-relay.dashboard+json; version=1";
const session = { schema: "dashboard.session.v1", session: "fresh-session", scope: "dashboard:read", idleExpiresAt: "2026-08-20T12:30:00.000Z", absoluteExpiresAt: "2026-08-20T20:00:00.000Z" };
function storage(seed: Record<string, string> = {}): Storage {
  const values = new Map(Object.entries(seed));
  return { getItem: (key: string) => values.get(key) ?? null, setItem: (key: string, value: string) => void values.set(key, value), removeItem: (key: string) => void values.delete(key), clear: () => values.clear(), key: (_index: number) => null, get length() { return values.size; } } as unknown as Storage;
}
afterEach(() => vi.unstubAllGlobals());

describe("dashboard application startup", () => {
  it("gives a fresh fragment priority over stale session storage and replaces it only after exchange", async () => {
    const browserStorage = storage({ [SESSION_STORAGE_KEY]: "stale-session" });
    const localStorageSpy = { getItem: vi.fn(), setItem: vi.fn(), removeItem: vi.fn() }; vi.stubGlobal("localStorage", localStorageSpy);
    const fetchMock = vi.fn().mockResolvedValueOnce(new Response(JSON.stringify(session), { status: 200, headers: { "Content-Type": media } })).mockResolvedValueOnce(new Response(JSON.stringify(snapshot), { status: 200, headers: { "Content-Type": media } })); vi.stubGlobal("fetch", fetchMock);
    render(<DashboardApp bootstrap="fresh-bootstrap" storage={browserStorage} />);
    expect(browserStorage.getItem(SESSION_STORAGE_KEY)).toBeNull();
    await waitFor(() => expect(fetchMock).toHaveBeenCalledWith("/dashboard/api/v1/session", expect.anything()));
    expect(fetchMock.mock.calls[0]?.[1]).toMatchObject({ body: JSON.stringify({ schema: "dashboard.session.request.v1", bootstrap: "fresh-bootstrap" }) });
    await waitFor(() => expect(browserStorage.getItem(SESSION_STORAGE_KEY)).toBe("fresh-session"));
    // The session token must never reach window.localStorage or a cookie — only the injected
    // `storage` (sessionStorage in production) is a legitimate home for it. The dashboard's own
    // theme preference is a separate, unrelated key in real localStorage (per-viewer convenience,
    // not session state), so this narrows to the session key rather than banning every call.
    const usedSessionKey = (spy: Readonly<{ mock: Readonly<{ calls: readonly unknown[][] }> }>) => spy.mock.calls.some((call) => call[0] === SESSION_STORAGE_KEY);
    expect(usedSessionKey(localStorageSpy.getItem)).toBe(false); expect(usedSessionKey(localStorageSpy.setItem)).toBe(false); expect(usedSessionKey(localStorageSpy.removeItem)).toBe(false); expect(document.cookie).toBe("");
  });
  it("has a pure startup resolver that never reads stale storage when bootstrap exists", () => {
    const browserStorage = storage({ [SESSION_STORAGE_KEY]: "stale-session" });
    expect(resolveLaunchSession("fresh", browserStorage)).toBeNull(); expect(browserStorage.getItem(SESSION_STORAGE_KEY)).toBeNull();
    browserStorage.setItem(SESSION_STORAGE_KEY, "existing"); expect(resolveLaunchSession(null, browserStorage)).toBe("existing");
  });
  it("automatically acquires a read-only session when navigating directly without a bootstrap token", async () => {
    const browserStorage = storage();
    const fetchMock = vi.fn().mockResolvedValueOnce(new Response(JSON.stringify(session), { status: 200, headers: { "Content-Type": media } })).mockResolvedValueOnce(new Response(JSON.stringify(snapshot), { status: 200, headers: { "Content-Type": media } })); vi.stubGlobal("fetch", fetchMock);
    render(<DashboardApp bootstrap={null} storage={browserStorage} />);
    await waitFor(() => expect(fetchMock).toHaveBeenCalledWith("/dashboard/api/v1/session", expect.anything()));
    expect(fetchMock.mock.calls[0]?.[1]).toMatchObject({ body: JSON.stringify({ schema: "dashboard.session.request.v1" }) });
    await waitFor(() => expect(browserStorage.getItem(SESSION_STORAGE_KEY)).toBe("fresh-session"));
  });
  it("shows an unavailable failure state when session acquisition fails", async () => {
    const fetchMock = vi.fn().mockRejectedValueOnce(new Error("network error")); vi.stubGlobal("fetch", fetchMock);
    render(<DashboardApp bootstrap={null} storage={storage()} />);
    await waitFor(() => expect(screen.getByRole("heading", { name: "Dashboard session unavailable" })).toBeInTheDocument());
    expect(screen.getByRole("alert")).toHaveTextContent("Could not connect to the relay service");
  });
  it("exposes logout and clears the in-memory/storage session only after a 204", async () => {
    const browserStorage = storage({ [SESSION_STORAGE_KEY]: "existing-session" });
    const fetchMock = vi.fn().mockResolvedValueOnce(new Response(JSON.stringify(snapshot), { status: 200, headers: { "Content-Type": media } })).mockResolvedValueOnce(new Response(null, { status: 204 })); vi.stubGlobal("fetch", fetchMock);
    render(<DashboardApp bootstrap={null} storage={browserStorage} />); await waitFor(() => expect(screen.getByRole("button", { name: "Logout" })).toBeInTheDocument());
    screen.getByRole<HTMLButtonElement>("button", { name: "Logout" }).click();
    await waitFor(() => expect(screen.getByText("Dashboard session ended")).toBeInTheDocument()); expect(browserStorage.getItem(SESSION_STORAGE_KEY)).toBeNull();
  });
  it("clears storage and renders the safe ended state when a snapshot expires the session", async () => {
    const browserStorage = storage({ [SESSION_STORAGE_KEY]: "existing-session" });
    const error = { schema: "dashboard.error.v1", code: "invalid_auth", message: "Dashboard session is unavailable.", requestId: null };
    const fetchMock = vi.fn().mockResolvedValueOnce(new Response(JSON.stringify(error), { status: 401, headers: { "Content-Type": media } })); vi.stubGlobal("fetch", fetchMock);
    render(<DashboardApp bootstrap={null} storage={browserStorage} />);
    await waitFor(() => expect(screen.getByText("Dashboard session ended")).toBeInTheDocument());
    expect(browserStorage.getItem(SESSION_STORAGE_KEY)).toBeNull();
  });
  it("clears storage and renders the safe ended state when detail expires the session", async () => {
    const browserStorage = storage({ [SESSION_STORAGE_KEY]: "existing-session" });
    const error = { schema: "dashboard.error.v1", code: "invalid_auth", message: "Dashboard session is unavailable.", requestId: null };
    const fetchMock = vi.fn().mockResolvedValueOnce(new Response(JSON.stringify(snapshot), { status: 200, headers: { "Content-Type": media } })).mockResolvedValueOnce(new Response(JSON.stringify(error), { status: 401, headers: { "Content-Type": media } })); vi.stubGlobal("fetch", fetchMock);
    render(<DashboardApp bootstrap={null} storage={browserStorage} showRecentTable={true} />);
    await waitFor(() => expect(screen.getByRole("button", { name: /View request/ })).toBeInTheDocument());
    fireEvent.click(screen.getByRole("button", { name: /View request/ }));
    await waitFor(() => expect(screen.getByText("Dashboard session ended")).toBeInTheDocument());
    expect(browserStorage.getItem(SESSION_STORAGE_KEY)).toBeNull();
  });
});
