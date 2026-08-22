import {
  DASHBOARD_MEDIA_TYPE,
  isDashboardDetailV1,
  isDashboardErrorV1,
  isDashboardSnapshotV1,
  isDashboardUtcTimestamp,
  type DetailV1,
  type FailureKind,
  type SnapshotV1,
  type WindowId,
} from "../../src/dashboard-contract.js";

export const SESSION_STORAGE_KEY = "llm-relay.dashboard.session.v1";
export const DASHBOARD_SESSION_HEADER = "X-LLM-Relay-Dashboard-Session";
const JSON_TYPE = "application/json";

export type DashboardSession = Readonly<{ session: string; idleExpiresAt: string; absoluteExpiresAt: string }>;
export type DashboardFilters = Readonly<{
  window: WindowId;
  includeRepair: boolean;
  attribution: "relay-held" | "caller-operated" | "all";
  provider?: string;
  model?: string;
  client?: string;
  credentialId?: string;
  outcome?: "success" | "error" | "cancelled" | "unknown";
  failureKind?: FailureKind;
}>;

export const defaultFilters: DashboardFilters = Object.freeze({ window: "24h", includeRepair: true, attribution: "all" });

export class DashboardApiError extends Error {
  constructor(readonly status: number, message = "Dashboard request failed.") { super(message); this.name = "DashboardApiError"; }
}

function headers(session?: string): Record<string, string> {
  return { Accept: DASHBOARD_MEDIA_TYPE, ...(session === undefined ? {} : { [DASHBOARD_SESSION_HEADER]: session }) };
}
function isDashboardMediaResponse(response: Response): boolean { return response.headers.get("content-type") === DASHBOARD_MEDIA_TYPE; }
async function responseJson(response: Response): Promise<unknown> {
  if (!isDashboardMediaResponse(response)) throw new DashboardApiError(response.status);
  try { return await response.json(); } catch { throw new DashboardApiError(response.status); }
}
async function readOrThrow(response: Response): Promise<unknown> {
  const payload = await responseJson(response);
  if (response.ok) return payload;
  // Do not render arbitrary network/provider payloads into the dashboard.
  throw new DashboardApiError(response.status, isDashboardErrorV1(payload) ? payload.message : "Dashboard request failed.");
}
function isExactSessionPayload(value: unknown): value is DashboardSession {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const record = value as Record<string, unknown>; const expected = ["schema", "session", "scope", "idleExpiresAt", "absoluteExpiresAt"];
  return Object.keys(record).length === expected.length && expected.every((key) => Object.prototype.hasOwnProperty.call(record, key))
    && record.schema === "dashboard.session.v1"
    && typeof record.session === "string" && record.session.length > 0
    && record.scope === "dashboard:read"
    && isDashboardUtcTimestamp(record.idleExpiresAt)
    && isDashboardUtcTimestamp(record.absoluteExpiresAt);
}
export function isSessionExpired(error: unknown): boolean { return error instanceof DashboardApiError && error.status === 401; }

export function snapshotPath(filters: DashboardFilters): string {
  const query = new URLSearchParams({ window: filters.window, includeRepair: filters.includeRepair ? "1" : "0", attribution: filters.attribution });
  for (const key of ["provider", "model", "client", "credentialId", "outcome", "failureKind"] as const) {
    const value = filters[key]; if (value !== undefined) query.set(key, value);
  }
  return `/dashboard/api/v1/snapshot?${query.toString()}`;
}
export function detailPath(requestId: string, includeRepair: boolean): string { return `/dashboard/api/v1/requests/${encodeURIComponent(requestId)}?includeRepair=${includeRepair ? "1" : "0"}`; }

export async function exchangeBootstrap(bootstrap: string, signal?: AbortSignal): Promise<DashboardSession> {
  const response = await fetch("/dashboard/api/v1/session", {
    method: "POST", credentials: "omit", ...(signal === undefined ? {} : { signal }),
    headers: { ...headers(), "Content-Type": JSON_TYPE }, body: JSON.stringify({ schema: "dashboard.session.request.v1", bootstrap }),
  });
  const payload = await readOrThrow(response);
  if (!isExactSessionPayload(payload)) throw new DashboardApiError(response.status);
  return payload;
}
export async function logout(session: string, signal?: AbortSignal): Promise<void> {
  const response = await fetch("/dashboard/api/v1/logout", {
    method: "POST", credentials: "omit", ...(signal === undefined ? {} : { signal }),
    headers: { ...headers(session), "Content-Type": JSON_TYPE }, body: JSON.stringify({ schema: "dashboard.logout.request.v1" }),
  });
  const body = await response.text();
  if (response.status !== 204 || body.length !== 0) throw new DashboardApiError(response.status);
}
export async function fetchSnapshot(session: string, filters: DashboardFilters, signal?: AbortSignal): Promise<SnapshotV1> {
  const payload = await readOrThrow(await fetch(snapshotPath(filters), { credentials: "omit", ...(signal === undefined ? {} : { signal }), headers: headers(session) }));
  if (!isDashboardSnapshotV1(payload)) throw new DashboardApiError(200);
  return payload;
}
export async function fetchDetail(session: string, requestId: string, includeRepair: boolean, signal?: AbortSignal): Promise<DetailV1> {
  const payload = await readOrThrow(await fetch(detailPath(requestId, includeRepair), { credentials: "omit", ...(signal === undefined ? {} : { signal }), headers: headers(session) }));
  if (!isDashboardDetailV1(payload)) throw new DashboardApiError(200);
  return payload;
}
export function consumeBootstrapFragment(location: Location, history: History): string | null {
  const fragment = new URLSearchParams(location.hash.startsWith("#") ? location.hash.slice(1) : location.hash);
  const bootstrap = fragment.get("bootstrap");
  if (bootstrap !== null || location.hash.length > 0) history.replaceState(null, "", `${location.pathname}${location.search}`);
  return bootstrap;
}
export function readStoredSession(storage: Storage = sessionStorage): string | null { return storage.getItem(SESSION_STORAGE_KEY); }
export function storeSession(session: string, storage: Storage = sessionStorage): void { storage.setItem(SESSION_STORAGE_KEY, session); }
export function clearStoredSession(storage: Storage = sessionStorage): void { storage.removeItem(SESSION_STORAGE_KEY); }
