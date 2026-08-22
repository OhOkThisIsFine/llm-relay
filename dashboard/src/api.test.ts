import { afterEach, describe, expect, it, vi } from "vitest";
import { DashboardApiError, DASHBOARD_SESSION_HEADER, consumeBootstrapFragment, detailPath, exchangeBootstrap, fetchDetail, fetchSnapshot, logout, snapshotPath, type DashboardFilters } from "./api.js";
import { detail, snapshot } from "./test-fixtures.js";

const media = "application/vnd.llm-relay.dashboard+json; version=1";
const json = (value: unknown, status = 200, contentType = media) => new Response(JSON.stringify(value), { status, headers: { "Content-Type": contentType } });
const session = { schema: "dashboard.session.v1", session: "opaque-session", scope: "dashboard:read", idleExpiresAt: "2026-08-20T12:30:00.000Z", absoluteExpiresAt: "2026-08-20T20:00:00.000Z" };
afterEach(() => vi.unstubAllGlobals());

describe("dashboard browser protocol", () => {
  it("scrubs bootstrap fragments before a request", () => {
    const replace = vi.fn(); const location = { hash: "#bootstrap=opaque-value", pathname: "/dashboard/", search: "?view=one" } as Location;
    expect(consumeBootstrapFragment(location, { replaceState: replace } as unknown as History)).toBe("opaque-value");
    expect(replace).toHaveBeenCalledWith(null, "", "/dashboard/?view=one");
  });
  it("constructs every optional server filter exactly once with URL encoding", () => {
    const filters: DashboardFilters = { window: "7d", includeRepair: false, attribution: "relay-held", provider: "open ai", model: "m/a", client: "CLI & test", credentialId: "open ai#one", outcome: "error", failureKind: "timeout" };
    expect(snapshotPath(filters)).toBe("/dashboard/api/v1/snapshot?window=7d&includeRepair=0&attribution=relay-held&provider=open+ai&model=m%2Fa&client=CLI+%26+test&credentialId=open+ai%23one&outcome=error&failureKind=timeout");
    expect(detailPath("request_0000000001/unsafe", false)).toBe("/dashboard/api/v1/requests/request_0000000001%2Funsafe?includeRepair=0");
  });
  it("exchanges bootstrap with the exact request contract and accepts only a complete session", async () => {
    const fetchMock = vi.fn().mockResolvedValue(json(session)); vi.stubGlobal("fetch", fetchMock); const controller = new AbortController();
    await expect(exchangeBootstrap("fresh-bootstrap", controller.signal)).resolves.toMatchObject({ session: "opaque-session", idleExpiresAt: session.idleExpiresAt });
    expect(fetchMock).toHaveBeenCalledWith("/dashboard/api/v1/session", expect.objectContaining({ method: "POST", credentials: "omit", signal: controller.signal, headers: { Accept: media, "Content-Type": "application/json" }, body: JSON.stringify({ schema: "dashboard.session.request.v1", bootstrap: "fresh-bootstrap" }) }));
    for (const malformed of [{ ...session, scope: "other" }, { ...session, idleExpiresAt: "not-a-date" }, { ...session, session: "" }, { ...session, extra: true }, { schema: session.schema, session: session.session, scope: session.scope, idleExpiresAt: session.idleExpiresAt }]) {
      fetchMock.mockResolvedValueOnce(json(malformed)); await expect(exchangeBootstrap("fresh")).rejects.toBeInstanceOf(DashboardApiError);
    }
  });
  it("uses session headers, omit credentials, signals, and rejects wrong media or unnormalized errors", async () => {
    const fetchMock = vi.fn().mockResolvedValue(json(snapshot)); vi.stubGlobal("fetch", fetchMock); const controller = new AbortController();
    await expect(fetchSnapshot("memory-session", { window: "24h", includeRepair: true, attribution: "all" }, controller.signal)).resolves.toMatchObject({ schema: "dashboard.snapshot.v1" });
    expect(fetchMock.mock.calls[0]?.[1]).toMatchObject({ credentials: "omit", signal: controller.signal, headers: expect.objectContaining({ [DASHBOARD_SESSION_HEADER]: "memory-session" }) });
    fetchMock.mockResolvedValueOnce(json({}, 500, "application/json")); await expect(fetchSnapshot("memory-session", { window: "24h", includeRepair: true, attribution: "all" })).rejects.toMatchObject({ status: 500, message: "Dashboard request failed." });
    fetchMock.mockResolvedValueOnce(json({ nope: true }, 500)); await expect(fetchSnapshot("memory-session", { window: "24h", includeRepair: true, attribution: "all" })).rejects.toMatchObject({ status: 500, message: "Dashboard request failed." });
  });
  it("uses the repair-explicit detail request and abort signal", async () => {
    const fetchMock = vi.fn().mockResolvedValue(json(detail)); vi.stubGlobal("fetch", fetchMock); const controller = new AbortController();
    await expect(fetchDetail("memory-session", "request_0000000001", false, controller.signal)).resolves.toMatchObject({ schema: "dashboard.detail.v1" });
    expect(fetchMock).toHaveBeenCalledWith("/dashboard/api/v1/requests/request_0000000001?includeRepair=0", expect.objectContaining({ credentials: "omit", signal: controller.signal, headers: expect.objectContaining({ [DASHBOARD_SESSION_HEADER]: "memory-session" }) }));
  });
  it("posts logout with no cookies and accepts only an empty 204", async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(null, { status: 204 })); vi.stubGlobal("fetch", fetchMock); const controller = new AbortController();
    await expect(logout("memory-session", controller.signal)).resolves.toBeUndefined();
    expect(fetchMock).toHaveBeenCalledWith("/dashboard/api/v1/logout", expect.objectContaining({ method: "POST", credentials: "omit", signal: controller.signal, headers: { Accept: media, [DASHBOARD_SESSION_HEADER]: "memory-session", "Content-Type": "application/json" }, body: JSON.stringify({ schema: "dashboard.logout.request.v1" }) }));
    fetchMock.mockResolvedValueOnce({ status: 204, text: async () => "unexpected" } as Response); await expect(logout("memory-session")).rejects.toBeInstanceOf(DashboardApiError);
    fetchMock.mockResolvedValueOnce(new Response(null, { status: 200 })); await expect(logout("memory-session")).rejects.toBeInstanceOf(DashboardApiError);
  });
});
