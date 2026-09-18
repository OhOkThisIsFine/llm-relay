import { act, fireEvent, render, screen } from "@testing-library/react";
import type { ComponentProps } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AnalyticsDashboard } from "./AnalyticsDashboard.js";
import { detail, snapshot } from "../test-fixtures.js";

const media = "application/vnd.llm-relay.dashboard+json; version=1";
const json = (value: unknown, status = 200) => new Response(JSON.stringify(value), { status, headers: { "Content-Type": media } });
type Deferred<T> = { promise: Promise<T>; resolve(value: T): void; reject(error: unknown): void };
function deferred<T>(): Deferred<T> { let resolve!: (value: T) => void; let reject!: (error: unknown) => void; const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; }); return { promise, resolve, reject }; }
function renderDashboard(overrides: Partial<ComponentProps<typeof AnalyticsDashboard>> = {}) { return render(<AnalyticsDashboard session="memory-session" onSessionExpired={vi.fn()} onLogout={vi.fn().mockResolvedValue(undefined)} showRecentTable={true} {...overrides} />); }
async function flush(): Promise<void> { await act(async () => { await Promise.resolve(); await Promise.resolve(); }); }
function visible(value: "visible" | "hidden"): void { Object.defineProperty(document, "visibilityState", { configurable: true, value }); document.dispatchEvent(new Event("visibilitychange")); }
function online(value: boolean): void { Object.defineProperty(navigator, "onLine", { configurable: true, value }); window.dispatchEvent(new Event(value ? "online" : "offline")); }
afterEach(() => { vi.unstubAllGlobals(); vi.useRealTimers(); visible("visible"); online(true); });

describe("snapshot and detail lifecycle", () => {
  it("aborts superseded manual/filter/visibility reads and resumes without overlap", async () => {
    const first = deferred<Response>(); const second = deferred<Response>(); const third = deferred<Response>(); const fourth = deferred<Response>();
    const fetchMock = vi.fn().mockReturnValueOnce(first.promise).mockReturnValueOnce(second.promise).mockReturnValueOnce(third.promise).mockReturnValueOnce(fourth.promise); vi.stubGlobal("fetch", fetchMock);
    renderDashboard(); await flush(); expect(fetchMock).toHaveBeenCalledTimes(1); const firstInit = fetchMock.mock.calls[0]?.[1] as RequestInit;
    fireEvent.click(screen.getByRole("button", { name: "Refresh" })); await flush(); expect(firstInit.signal?.aborted).toBe(true); expect(fetchMock).toHaveBeenCalledTimes(2);
    second.resolve(json(snapshot)); await flush(); expect(screen.getByRole("heading", { name: "Requests" })).toBeInTheDocument();
    fireEvent.change(screen.getByLabelText("Window"), { target: { value: "7d" } }); await flush(); expect(fetchMock).toHaveBeenCalledTimes(3); const thirdInit = fetchMock.mock.calls[2]?.[1] as RequestInit;
    visible("hidden"); await flush(); expect(thirdInit.signal?.aborted).toBe(true);
    expect(screen.getByRole("status")).toHaveTextContent("Polling paused");
    visible("visible"); await flush(); expect(fetchMock).toHaveBeenCalledTimes(4); const fourthInit = fetchMock.mock.calls[3]?.[1] as RequestInit;
    online(false); await flush(); expect(fourthInit.signal?.aborted).toBe(true); expect(screen.getByRole("status")).toHaveTextContent("Offline");
  });
  it("does not overlap an unresolved poll and aborts it when the tab becomes unavailable", async () => {
    vi.useFakeTimers(); const first = deferred<Response>(); const second = deferred<Response>();
    const fetchMock = vi.fn().mockReturnValueOnce(first.promise).mockReturnValueOnce(second.promise); vi.stubGlobal("fetch", fetchMock);
    const view = renderDashboard(); await flush();
    await act(async () => { vi.advanceTimersByTime(30_000); }); await flush();
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const firstInit = fetchMock.mock.calls[0]?.[1] as RequestInit;
    visible("hidden"); await flush(); expect(firstInit.signal?.aborted).toBe(true); expect(screen.getByRole("status")).toHaveTextContent("Polling paused");
    visible("visible"); await flush(); expect(fetchMock).toHaveBeenCalledTimes(2);
    const secondInit = fetchMock.mock.calls[1]?.[1] as RequestInit;
    online(false); await flush(); expect(secondInit.signal?.aborted).toBe(true); expect(screen.getByRole("status")).toHaveTextContent("Offline");
    view.unmount();
  });
  it("polls once per 30 seconds only while visible and online, retaining last-good data on refresh failure", async () => {
    vi.useFakeTimers(); const fetchMock = vi.fn().mockResolvedValueOnce(json(snapshot)).mockRejectedValueOnce(new TypeError("network down")).mockResolvedValueOnce(json(snapshot)); vi.stubGlobal("fetch", fetchMock);
    renderDashboard(); await flush(); expect(fetchMock).toHaveBeenCalledTimes(1); expect(screen.getByRole("heading", { name: "Requests" })).toBeInTheDocument();
    await act(async () => { vi.advanceTimersByTime(29_999); }); expect(fetchMock).toHaveBeenCalledTimes(1);
    await act(async () => { vi.advanceTimersByTime(1); await Promise.resolve(); }); expect(fetchMock).toHaveBeenCalledTimes(2); await flush();
    expect(screen.getByRole("heading", { name: "Requests" })).toBeInTheDocument(); expect(screen.getByRole("status")).toHaveTextContent("Refresh failed");
    visible("hidden"); await flush(); await act(async () => { vi.advanceTimersByTime(60_000); }); expect(fetchMock).toHaveBeenCalledTimes(2);
    visible("visible"); await flush(); expect(fetchMock).toHaveBeenCalledTimes(3);
  });
  it("keeps detail responses ordered, cancels them on repair/filter changes, and exposes a generic failure", async () => {
    const firstDetail = deferred<Response>(); const secondDetail = deferred<Response>(); const thirdDetail = deferred<Response>();
    const twoRequests = { ...snapshot, recentRequests: [...snapshot.recentRequests, { ...snapshot.recentRequests[0]!, requestId: "request_0000000002" }] };
    const fetchMock = vi.fn().mockResolvedValueOnce(json(twoRequests)).mockReturnValueOnce(firstDetail.promise).mockReturnValueOnce(secondDetail.promise).mockReturnValueOnce(thirdDetail.promise); vi.stubGlobal("fetch", fetchMock);
    renderDashboard(); await flush(); const views = screen.getAllByRole("button", { name: /View request/ }); fireEvent.click(views[0]!); await flush(); const firstInit = fetchMock.mock.calls[1]?.[1] as RequestInit;
    fireEvent.click(views[1]!); await flush(); expect(firstInit.signal?.aborted).toBe(true); firstDetail.resolve(json(detail)); await flush(); expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    secondDetail.resolve(json(detail)); await flush(); expect(screen.getByRole("dialog")).toBeInTheDocument(); fireEvent.click(screen.getByRole("button", { name: "Close details" }));
    fireEvent.click(screen.getAllByRole("button", { name: /View request/ })[0]!); await flush(); const thirdInit = fetchMock.mock.calls[3]?.[1] as RequestInit; fireEvent.click(screen.getByLabelText("Include repair attempts")); await flush(); expect(thirdInit.signal?.aborted).toBe(true);
  });
  it("aborts snapshot and detail requests on unmount", async () => {
    const snapshotRead = deferred<Response>(); const snapshotFetch = vi.fn().mockReturnValueOnce(snapshotRead.promise); vi.stubGlobal("fetch", snapshotFetch);
    const snapshotView = renderDashboard(); await flush(); const snapshotInit = snapshotFetch.mock.calls[0]?.[1] as RequestInit; snapshotView.unmount();
    expect(snapshotInit.signal?.aborted).toBe(true);
    const detailRead = deferred<Response>(); const detailFetch = vi.fn().mockResolvedValueOnce(json(snapshot)).mockReturnValueOnce(detailRead.promise); vi.stubGlobal("fetch", detailFetch);
    const detailView = renderDashboard(); await flush(); fireEvent.click(screen.getByRole("button", { name: /View request/ })); await flush();
    const detailInit = detailFetch.mock.calls[1]?.[1] as RequestInit; detailView.unmount();
    expect(detailInit.signal?.aborted).toBe(true);
  });
  it("moves safely to the expired callback for snapshot and detail 401 responses", async () => {
    const expired = vi.fn(); const error = { schema: "dashboard.error.v1", code: "invalid_auth", message: "Dashboard session is unavailable.", requestId: null };
    const fetchMock = vi.fn().mockResolvedValueOnce(json(error, 401)); vi.stubGlobal("fetch", fetchMock); renderDashboard({ onSessionExpired: expired }); await flush(); expect(expired).toHaveBeenCalledOnce();
  });
  it("does not retain a detail session after a normalized 401", async () => {
    const expired = vi.fn(); const error = { schema: "dashboard.error.v1", code: "invalid_auth", message: "Dashboard session is unavailable.", requestId: null };
    const fetchMock = vi.fn().mockResolvedValueOnce(json(snapshot)).mockResolvedValueOnce(json(error, 401)); vi.stubGlobal("fetch", fetchMock); renderDashboard({ onSessionExpired: expired }); await flush(); fireEvent.click(screen.getByRole("button", { name: /View request/ })); await flush(); expect(expired).toHaveBeenCalledOnce();
  });
  it("shows safe generic detail errors and an explicit empty-attempt state", async () => {
    const emptyDetail = { ...detail, attempts: [] }; const fetchMock = vi.fn().mockResolvedValueOnce(json(snapshot)).mockRejectedValueOnce(new TypeError("private upstream failure")).mockResolvedValueOnce(json(emptyDetail)); vi.stubGlobal("fetch", fetchMock);
    renderDashboard(); await flush(); fireEvent.click(screen.getByRole("button", { name: /View request/ })); await flush(); expect(screen.getByRole("alert")).toHaveTextContent("Request details are unavailable.");
    fireEvent.click(screen.getByRole("button", { name: /View request/ })); await flush(); expect(screen.getByRole("dialog")).toHaveTextContent("No recorded attempts are available");
  });
});
