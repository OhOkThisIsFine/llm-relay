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
    expect(localStorageSpy.getItem).not.toHaveBeenCalled(); expect(localStorageSpy.setItem).not.toHaveBeenCalled(); expect(localStorageSpy.removeItem).not.toHaveBeenCalled(); expect(document.cookie).toBe("");
  });
  it("has a pure startup resolver that never reads stale storage when bootstrap exists", () => {
    const browserStorage = storage({ [SESSION_STORAGE_KEY]: "stale-session" });
    expect(resolveLaunchSession("fresh", browserStorage)).toBeNull(); expect(browserStorage.getItem(SESSION_STORAGE_KEY)).toBeNull();
    browserStorage.setItem(SESSION_STORAGE_KEY, "existing"); expect(resolveLaunchSession(null, browserStorage)).toBe("existing");
  });
  it("shows an immediate relaunch state when neither a bootstrap nor stored session exists", () => {
    const fetchMock = vi.fn(); vi.stubGlobal("fetch", fetchMock);
    render(<DashboardApp bootstrap={null} storage={storage()} />);
    expect(screen.getByRole("heading", { name: "Dashboard relaunch required" })).toBeInTheDocument();
    expect(screen.getByRole("status")).toHaveTextContent("Relaunch the dashboard from the relay CLI");
    expect(screen.queryByText("Starting read-only dashboard session…")).not.toBeInTheDocument();
    expect(fetchMock).not.toHaveBeenCalled();
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
    render(<DashboardApp bootstrap={null} storage={browserStorage} />);
    await waitFor(() => expect(screen.getByRole("button", { name: /View request/ })).toBeInTheDocument());
    fireEvent.click(screen.getByRole("button", { name: /View request/ }));
    await waitFor(() => expect(screen.getByText("Dashboard session ended")).toBeInTheDocument());
    expect(browserStorage.getItem(SESSION_STORAGE_KEY)).toBeNull();
  });
});
