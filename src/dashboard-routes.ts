/**
 * Dependency-injected, platform-neutral API routes for the analytics dashboard.
 *
 * The server owns socket admission, Host parsing, capability verification, and
 * body streaming.  This module owns only the narrow endpoint policy and the
 * versioned dashboard wire contract.  Keeping the handler free of an
 * IncomingMessage/ServerResponse dependency makes its order of checks easy to
 * test and prevents a future catch-all from accidentally becoming an API.
 */
import {
  DASHBOARD_MAX_BODY_BYTES,
  DASHBOARD_MAX_QUERY_BYTES,
  DASHBOARD_MEDIA_TYPE,
  DASHBOARD_ERROR_SCHEMA,
  DASHBOARD_ERROR_MESSAGES,
  // ⚠ The CONTRACT owns this vocabulary. This module used to restate all ten codes as its own
  // local union — two definitions of one closed set, in the one place a drift is invisible: adding
  // a code to the contract left this file silently unable to name it, and dropping one here left a
  // route emitting a code the validator would reject. Import it; never re-type it.
  type DashboardErrorCode,
  isDashboardDetailV1,
  isDashboardFailureKind,
  isDashboardMediaType,
  isDashboardOutcome,
  isDashboardQueryWithinLimit,
  isDashboardRequestId,
  isDashboardSafeId,
  isDashboardSnapshotV1,
  isDashboardWindowId,
  mapDashboardQueryAttribution,
  utf8ByteLength,
  type DetailV1,
  type FailureKind,
  type Outcome,
  type SnapshotV1,
  type WindowId,
} from "./dashboard-contract.js";
import {
  DASHBOARD_SCOPE,
  DASHBOARD_SESSION_HEADER,
  type DashboardAuthFailure,
  type DashboardBootstrap,
  type DashboardBootstrapResult,
  type DashboardLogout,
  type DashboardLogoutResult,
  type DashboardSession,
  type DashboardSessionResult,
} from "./dashboard-auth.js";
import { DASHBOARD_STATIC_SECURITY_HEADERS } from "./dashboard-static.js";

export { DASHBOARD_MEDIA_TYPE } from "./dashboard-contract.js";

export const DASHBOARD_BOOTSTRAP_SCHEMA = "dashboard.bootstrap.v1" as const;
export const DASHBOARD_SESSION_SCHEMA = "dashboard.session.v1" as const;
export const DASHBOARD_BOOTSTRAP_REQUEST_SCHEMA = "dashboard.bootstrap.request.v1" as const;
export const DASHBOARD_SESSION_REQUEST_SCHEMA = "dashboard.session.request.v1" as const;
export const DASHBOARD_LOGOUT_REQUEST_SCHEMA = "dashboard.logout.request.v1" as const;

/** A server-normalized, lowercased header map. Values stay multi-valued. */
export type DashboardHeaderMap = Readonly<Record<string, readonly unknown[]>>;

export interface DashboardAdmissionDenied {
  readonly hostAuthorized: false;
}

export interface DashboardAdmissionAllowed {
  readonly hostAuthorized: true;
  readonly expectedOrigin: string;
  readonly controlAuthorized: boolean;
}

export type DashboardAdmission = DashboardAdmissionDenied | DashboardAdmissionAllowed;

export interface DashboardRouteRequest {
  readonly method: string;
  /** The raw request target, including its query string. */
  readonly target: string;
  readonly headers: DashboardHeaderMap;
  /** Host/control admission is deliberately supplied by the server boundary. */
  readonly admission: DashboardAdmission;
  /** Body buffering/streaming remains server-owned and is invoked at most once. */
  readonly readBody: (maxBytes: number) => Promise<Uint8Array>;
}

export interface DashboardSnapshotQuery {
  readonly window: WindowId;
  readonly includeRepair: boolean;
  readonly attribution?: "relay-held" | "caller-operated" | "all";
  readonly provider?: string;
  readonly model?: string;
  readonly client?: string;
  readonly credentialId?: string;
  readonly outcome?: Outcome;
  readonly failureKind?: FailureKind;
}

export interface DashboardDetailQuery {
  readonly requestId: string;
  readonly includeRepair: boolean;
}

export interface DashboardReadPort {
  readSnapshot(query: DashboardSnapshotQuery): Promise<SnapshotV1>;
  readDetail(query: DashboardDetailQuery): Promise<DetailV1 | null>;
}

/** The auth port intentionally permits synchronous or asynchronous test seams. */
export interface DashboardAuthPort {
  createBootstrap(): DashboardBootstrap | Promise<DashboardBootstrap>;
  exchangeBootstrap(candidate: string): DashboardBootstrapResult | Promise<DashboardBootstrapResult>;
  validateSession(candidate: string): DashboardSessionResult | Promise<DashboardSessionResult>;
  logout(candidate: string): DashboardLogoutResult | Promise<DashboardLogoutResult>;
}

export interface DashboardRouteDependencies {
  readonly auth: DashboardAuthPort;
  readonly read: DashboardReadPort;
}

export interface DashboardRouteHandled {
  readonly handled: true;
  readonly status: number;
  readonly headers: Readonly<Record<string, string>>;
  /** Omitted for HEAD and for a 204 response. */
  readonly body?: Uint8Array;
}

export interface DashboardRouteNotHandled {
  readonly handled: false;
}

export type DashboardRouteResponse = DashboardRouteHandled | DashboardRouteNotHandled;

type RouteKind = "bootstrap" | "session" | "logout" | "snapshot" | "detail";

interface ClassifiedTarget {
  readonly kind: RouteKind;
  readonly methodAllowed: readonly string[];
  readonly path: string;
  readonly rawQuery: string;
  readonly hasQuery: boolean;
  readonly requestId?: string;
}

interface HeaderRead {
  readonly present: boolean;
  readonly valid: boolean;
  readonly values: readonly string[];
}

interface QueryParseOk<T> {
  readonly ok: true;
  readonly query: T;
}

interface QueryParseError {
  readonly ok: false;
  readonly status: 400 | 413;
}

type QueryParseResult<T> = QueryParseOk<T> | QueryParseError;

interface BodyLengthOk {
  readonly ok: true;
  readonly length: number;
}

interface BodyLengthError {
  readonly ok: false;
  readonly status: 400 | 413;
}

type BodyLengthResult = BodyLengthOk | BodyLengthError;

const ALLOW = Object.freeze({
  bootstrap: ["POST"] as const,
  session: ["POST"] as const,
  logout: ["POST"] as const,
  snapshot: ["GET", "HEAD"] as const,
  detail: ["GET", "HEAD"] as const,
});

const CONTROL_CHARACTER_PATTERN = /[\u0000-\u001f\u007f-\u009f]/u;
const JSON_CONTENT_TYPE = "application/json";
const SAFE_TOKEN_PATTERN = /^[A-Za-z0-9_-]+$/u;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function hasExactKeys(value: unknown, keys: readonly string[]): value is Record<string, unknown> {
  if (!isRecord(value) || Object.getOwnPropertySymbols(value).length !== 0) return false;
  const own = Object.keys(value);
  return own.length === keys.length && keys.every((key) => Object.prototype.hasOwnProperty.call(value, key));
}

function readHeader(headers: DashboardHeaderMap, name: string): HeaderRead {
  if (!Object.prototype.hasOwnProperty.call(headers, name)) {
    return { present: false, valid: true, values: [] };
  }
  const raw = headers[name];
  if (!Array.isArray(raw) || raw.length === 0) return { present: true, valid: false, values: [] };
  if (!raw.every((value): value is string => typeof value === "string" && value.length > 0)) {
    return { present: true, valid: false, values: [] };
  }
  return { present: true, valid: true, values: raw };
}

function oneHeader(headers: DashboardHeaderMap, name: string): string | null | undefined {
  const read = readHeader(headers, name);
  if (!read.present) return undefined;
  if (!read.valid || read.values.length !== 1) return null;
  return read.values[0] ?? null;
}

function classifyTarget(target: unknown): ClassifiedTarget | null {
  if (typeof target !== "string" || target.length === 0) return null;
  if (CONTROL_CHARACTER_PATTERN.test(target) || target.includes("#")) return null;
  const queryIndex = target.indexOf("?");
  const path = queryIndex < 0 ? target : target.slice(0, queryIndex);
  const rawQuery = queryIndex < 0 ? "" : target.slice(queryIndex + 1);
  if (!path.startsWith("/") || path.includes("%") || path.includes("\\") || path.includes("//")) return null;

  if (path === "/dashboard/api/v1/bootstrap") {
    return { kind: "bootstrap", methodAllowed: ALLOW.bootstrap, path, rawQuery, hasQuery: queryIndex >= 0 };
  }
  if (path === "/dashboard/api/v1/session") {
    return { kind: "session", methodAllowed: ALLOW.session, path, rawQuery, hasQuery: queryIndex >= 0 };
  }
  if (path === "/dashboard/api/v1/logout") {
    return { kind: "logout", methodAllowed: ALLOW.logout, path, rawQuery, hasQuery: queryIndex >= 0 };
  }
  if (path === "/dashboard/api/v1/snapshot") {
    return { kind: "snapshot", methodAllowed: ALLOW.snapshot, path, rawQuery, hasQuery: queryIndex >= 0 };
  }

  const detailPrefix = "/dashboard/api/v1/requests/";
  if (path.startsWith(detailPrefix)) {
    const suffix = path.slice(detailPrefix.length);
    if (!isDashboardSafeId(suffix) || suffix.includes("/")) return null;
    if (!isDashboardRequestId(suffix)) return null;
    return {
      kind: "detail",
      methodAllowed: ALLOW.detail,
      path,
      rawQuery,
      hasQuery: queryIndex >= 0,
      requestId: suffix,
    };
  }
  return null;
}

function admissionIsAllowed(admission: unknown): admission is DashboardAdmissionAllowed {
  return (
    isRecord(admission) &&
    admission.hostAuthorized === true &&
    typeof admission.expectedOrigin === "string" &&
    admission.expectedOrigin.length > 0 &&
    typeof admission.controlAuthorized === "boolean"
  );
}

function originAllowed(
  headers: DashboardHeaderMap,
  expectedOrigin: string,
  required: boolean,
): boolean {
  const origin = readHeader(headers, "origin");
  if (!origin.valid) return false;
  if (!origin.present) return !required;
  return origin.values.length === 1 && origin.values[0] === expectedOrigin;
}

function fetchSiteAllowed(headers: DashboardHeaderMap, mode: "read" | "write"): boolean {
  const fetchSite = readHeader(headers, "sec-fetch-site");
  if (!fetchSite.valid) return false;
  if (!fetchSite.present) return true;
  if (fetchSite.values.length !== 1) return false;
  const value = fetchSite.values[0];
  return mode === "read" ? value === "same-origin" || value === "none" : value === "same-origin";
}

function parseBodyLength(headers: DashboardHeaderMap): BodyLengthResult {
  const value = oneHeader(headers, "content-length");
  if (value === undefined || value === null || !/^\d+$/u.test(value)) return { ok: false, status: 400 };
  const length = Number(value);
  if (!Number.isSafeInteger(length)) return { ok: false, status: 413 };
  if (length > DASHBOARD_MAX_BODY_BYTES) return { ok: false, status: 413 };
  return { ok: true, length };
}

/** Validate the raw target's UTF-8 query budget without decoding values. */
function queryLimitError(target: ClassifiedTarget): QueryParseError | null {
  if (!target.hasQuery) return null;
  const bytes = utf8ByteLength(target.rawQuery);
  if (bytes === null) return { ok: false, status: 400 };
  if (bytes > DASHBOARD_MAX_QUERY_BYTES) return { ok: false, status: 413 };
  if (!isDashboardQueryWithinLimit(target.rawQuery)) return { ok: false, status: 400 };
  return null;
}

function decodeComponent(value: string): string | null {
  try {
    return decodeURIComponent(value);
  } catch {
    return null;
  }
}

function parsePairs(rawQuery: string): Array<readonly [string, string]> | QueryParseError {
  const bytes = utf8ByteLength(rawQuery);
  if (bytes === null) return { ok: false, status: 400 };
  if (bytes > DASHBOARD_MAX_QUERY_BYTES) return { ok: false, status: 413 };
  // Keep the contract helper in the decision path so this route cannot drift
  // from the shared query limit if that limit changes independently.
  if (!isDashboardQueryWithinLimit(rawQuery)) return { ok: false, status: 400 };
  if (rawQuery.length === 0) return [];
  const pairs: Array<readonly [string, string]> = [];
  for (const part of rawQuery.split("&")) {
    const equals = part.indexOf("=");
    if (equals <= 0 || equals !== part.lastIndexOf("=")) return { ok: false, status: 400 };
    const name = part.slice(0, equals);
    const value = part.slice(equals + 1);
    if (name.length === 0 || value.length === 0 || name.includes("%")) return { ok: false, status: 400 };
    const decoded = decodeComponent(value);
    if (decoded === null || decoded.length === 0) return { ok: false, status: 400 };
    pairs.push([name, decoded]);
  }
  return pairs;
}

function queryMap(rawQuery: string, allowed: readonly string[]): Map<string, string> | QueryParseError {
  const pairs = parsePairs(rawQuery);
  if (!Array.isArray(pairs)) return pairs;
  const output = new Map<string, string>();
  for (const [name, value] of pairs) {
    if (!allowed.includes(name) || output.has(name)) return { ok: false, status: 400 };
    output.set(name, value);
  }
  return output;
}

function parseSnapshotQuery(rawQuery: string): QueryParseResult<DashboardSnapshotQuery> {
  const map = queryMap(rawQuery, ["window", "includeRepair", "attribution", "provider", "model", "client", "credentialId", "outcome", "failureKind"]);
  if (!(map instanceof Map)) return map;
  const windowValue = map.get("window");
  const includeRepairValue = map.get("includeRepair");
  if (!isDashboardWindowId(windowValue) || (includeRepairValue !== "0" && includeRepairValue !== "1")) {
    return { ok: false, status: 400 };
  }
  type MutableSnapshotQuery = { -readonly [Key in keyof DashboardSnapshotQuery]: DashboardSnapshotQuery[Key] };
  const query: MutableSnapshotQuery = {
    window: windowValue,
    includeRepair: includeRepairValue === "1",
  };
  const attribution = map.get("attribution");
  if (attribution !== undefined) {
    if (attribution !== "relay-held" && attribution !== "caller-operated" && attribution !== "all") {
      return { ok: false, status: 400 };
    }
    query.attribution = attribution;
  }
  for (const name of ["provider", "model", "client", "credentialId"] as const) {
    const value = map.get(name);
    if (value === undefined) continue;
    if (!isDashboardSafeId(value)) return { ok: false, status: 400 };
    query[name] = value;
  }
  const outcome = map.get("outcome");
  if (outcome !== undefined) {
    if (!isDashboardOutcome(outcome)) return { ok: false, status: 400 };
    query.outcome = outcome;
  }
  const failureKind = map.get("failureKind");
  if (failureKind !== undefined) {
    if (!isDashboardFailureKind(failureKind)) return { ok: false, status: 400 };
    query.failureKind = failureKind;
  }
  return { ok: true, query };
}

function parseDetailQuery(rawQuery: string, requestId: string): QueryParseResult<DashboardDetailQuery> {
  const map = queryMap(rawQuery, ["includeRepair"]);
  if (!(map instanceof Map)) return map;
  const includeRepair = map.get("includeRepair");
  if (includeRepair !== "0" && includeRepair !== "1") return { ok: false, status: 400 };
  return { ok: true, query: { requestId, includeRepair: includeRepair === "1" } };
}

function scanJsonValue(text: string, start: number, depth: number): number | null {
  if (depth > 128) return null;
  let index = start;
  while (index < text.length && /\s/u.test(text[index] ?? "")) index += 1;
  const first = text[index];
  if (first === '"') {
    return scanJsonString(text, index);
  }
  if (first === "{") {
    index += 1;
    while (index < text.length && /\s/u.test(text[index] ?? "")) index += 1;
    if (text[index] === "}") return index + 1;
    const keys = new Set<string>();
    while (index < text.length) {
      if (text[index] !== '"') return null;
      const keyEnd = scanJsonString(text, index);
      if (keyEnd === null) return null;
      let key: string;
      try {
        key = JSON.parse(text.slice(index, keyEnd)) as string;
      } catch {
        return null;
      }
      if (keys.has(key)) return null;
      keys.add(key);
      index = keyEnd;
      while (index < text.length && /\s/u.test(text[index] ?? "")) index += 1;
      if (text[index] !== ":") return null;
      const valueEnd = scanJsonValue(text, index + 1, depth + 1);
      if (valueEnd === null) return null;
      index = valueEnd;
      while (index < text.length && /\s/u.test(text[index] ?? "")) index += 1;
      if (text[index] === "}") return index + 1;
      if (text[index] !== ",") return null;
      index += 1;
      while (index < text.length && /\s/u.test(text[index] ?? "")) index += 1;
    }
    return null;
  }
  if (first === "[") {
    index += 1;
    while (index < text.length && /\s/u.test(text[index] ?? "")) index += 1;
    if (text[index] === "]") return index + 1;
    while (index < text.length) {
      const valueEnd = scanJsonValue(text, index, depth + 1);
      if (valueEnd === null) return null;
      index = valueEnd;
      while (index < text.length && /\s/u.test(text[index] ?? "")) index += 1;
      if (text[index] === "]") return index + 1;
      if (text[index] !== ",") return null;
      index += 1;
      while (index < text.length && /\s/u.test(text[index] ?? "")) index += 1;
    }
    return null;
  }
  const end = /[,\]}\s]/u.exec(text.slice(index));
  return end === null ? text.length : index + end.index;
}

function scanJsonString(text: string, start: number): number | null {
  let index = start + 1;
  while (index < text.length) {
    const character = text[index];
    if (character === "\\") {
      index += 2;
      continue;
    }
    if (character === '"') return index + 1;
    if (character !== undefined && character < " ") return null;
    index += 1;
  }
  return null;
}

function parseJsonBody(body: unknown): unknown | null {
  if (!(body instanceof Uint8Array) || body.byteLength > DASHBOARD_MAX_BODY_BYTES) return null;
  let text: string;
  try {
    text = new TextDecoder("utf-8", { fatal: true }).decode(body);
  } catch {
    return null;
  }
  if (text.charCodeAt(0) === 0xfeff || scanJsonValue(text, 0, 0) === null) return null;
  const end = scanJsonValue(text, 0, 0);
  if (end === null || text.slice(end).trim().length !== 0) return null;
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return null;
  }
}

function isBootstrapRequest(value: unknown): value is { readonly schema: typeof DASHBOARD_BOOTSTRAP_REQUEST_SCHEMA } {
  return hasExactKeys(value, ["schema"]) && value.schema === DASHBOARD_BOOTSTRAP_REQUEST_SCHEMA;
}

function isSessionRequest(
  value: unknown,
): value is { readonly schema: typeof DASHBOARD_SESSION_REQUEST_SCHEMA; readonly bootstrap: string } {
  return (
    hasExactKeys(value, ["schema", "bootstrap"]) &&
    value.schema === DASHBOARD_SESSION_REQUEST_SCHEMA &&
    typeof value.bootstrap === "string"
  );
}

function isLogoutRequest(value: unknown): value is { readonly schema: typeof DASHBOARD_LOGOUT_REQUEST_SCHEMA } {
  return hasExactKeys(value, ["schema"]) && value.schema === DASHBOARD_LOGOUT_REQUEST_SCHEMA;
}

function isoTimestamp(value: unknown): string | null {
  if (typeof value !== "number" || !Number.isFinite(value) || !Number.isSafeInteger(value)) return null;
  try {
    return new Date(value).toISOString();
  } catch {
    return null;
  }
}

function isAuthFailure(value: unknown): value is DashboardAuthFailure {
  if (!isRecord(value) || value.ok !== false) return false;
  if (value.code !== "invalid_auth" && value.code !== "replay") return false;
  return (
    value.reason === "missing" ||
    value.reason === "malformed" ||
    value.reason === "wrong" ||
    value.reason === "expired" ||
    value.reason === "consumed"
  );
}

function isBootstrapSuccess(value: unknown): value is DashboardBootstrap {
  return isRecord(value) && value.ok === true && typeof value.bootstrap === "string" && isoTimestamp(value.expiresAt) !== null;
}

function isSessionSuccess(value: unknown): value is DashboardSession {
  return (
    isRecord(value) &&
    value.ok === true &&
    typeof value.session === "string" &&
    value.scope === DASHBOARD_SCOPE &&
    isoTimestamp(value.idleExpiresAt) !== null &&
    isoTimestamp(value.absoluteExpiresAt) !== null
  );
}

function isSessionValidationSuccess(value: unknown): boolean {
  return (
    isRecord(value) &&
    value.ok === true &&
    value.scope === DASHBOARD_SCOPE &&
    isoTimestamp(value.idleExpiresAt) !== null &&
    isoTimestamp(value.absoluteExpiresAt) !== null
  );
}

function isLogoutSuccess(value: unknown): value is DashboardLogout {
  return isRecord(value) && value.ok === true && value.revoked === true;
}

function errorMessage(code: DashboardErrorCode): (typeof DASHBOARD_ERROR_MESSAGES)[number] {
  if (code === "invalid_auth" || code === "forbidden") return "Dashboard session is unavailable.";
  if (code === "not_found") return "Requested dashboard data was not found.";
  return "Request could not be completed.";
}

function jsonBytes(value: unknown): Uint8Array {
  return Buffer.from(JSON.stringify(value), "utf8");
}

function commonHeaders(length: number, contentType: boolean): Record<string, string> {
  return {
    ...DASHBOARD_STATIC_SECURITY_HEADERS,
    "Cache-Control": "no-store",
    ...(contentType ? { "Content-Type": DASHBOARD_MEDIA_TYPE } : {}),
    "Content-Length": String(length),
  };
}

function handledJson(
  status: number,
  payload: unknown,
  method: string,
  extra: Readonly<Record<string, string>> = {},
): DashboardRouteHandled {
  const body = jsonBytes(payload);
  return {
    handled: true,
    status,
    headers: { ...commonHeaders(body.byteLength, true), ...extra },
    ...(method === "HEAD" ? {} : { body }),
  };
}

function handledEmpty(status: number, extra: Readonly<Record<string, string>> = {}): DashboardRouteHandled {
  const headers = status === 204
    ? {
        ...DASHBOARD_STATIC_SECURITY_HEADERS,
        "Cache-Control": "no-store",
        ...extra,
      }
    : { ...commonHeaders(0, true), ...extra };
  return { handled: true, status, headers };
}

function errorResponse(status: number, code: DashboardErrorCode, method: string, allow?: readonly string[]): DashboardRouteHandled {
  const payload = {
    schema: DASHBOARD_ERROR_SCHEMA,
    code,
    message: errorMessage(code),
    requestId: null,
  };
  return handledJson(status, payload, method, allow ? { Allow: allow.join(", ") } : {});
}

function statusForQueryError(status: 400 | 413): DashboardErrorCode {
  return status === 413 ? "oversized" : "malformed_query";
}

/**
 * The code a body reader sets when it refused a body for exceeding the cap.
 *
 * Exported so the PRODUCER and this consumer share one definition. Until 2026-08-25 the accepted
 * set was three codes that nothing in the repo ever set, so the only live classifier was a regex
 * over the error MESSAGE — the relay sniffing prose it had written itself, one line away from
 * deciding 413-vs-500. That is the inference this codebase refuses everywhere else
 * (`rate-limits.ts` needs an explicit axis and period; `refusal-interpretation.ts` is lookup,
 * never inference), and it was wrong in both directions: any unrelated rejection whose message
 * happened to contain "exceeded" — a timeout wrapper, a RangeError — was served as `oversized`,
 * and a future reader with different wording would silently become `internal`.
 */
export const BODY_TOO_LARGE_CODE = "ERR_DASHBOARD_BODY_TOO_LARGE";

function bodyReadErrorCode(error: unknown): DashboardErrorCode {
  return isRecord(error) && error.code === BODY_TOO_LARGE_CODE ? "oversized" : "internal";
}

function isPlainJsonContentType(headers: DashboardHeaderMap): boolean {
  const value = oneHeader(headers, "content-type");
  return value === JSON_CONTENT_TYPE;
}

function noQueryAllowed(target: ClassifiedTarget): QueryParseResult<null> {
  return target.hasQuery ? { ok: false, status: 400 } : { ok: true, query: null };
}

async function validateSession(
  dependencies: DashboardRouteDependencies,
  headers: DashboardHeaderMap,
  method: string,
): Promise<{ ok: true; token: string } | { ok: false; response: DashboardRouteHandled }> {
  const token = oneHeader(headers, DASHBOARD_SESSION_HEADER.toLowerCase());
  if (token === undefined || token === null || !SAFE_TOKEN_PATTERN.test(token)) {
    return { ok: false, response: errorResponse(401, "invalid_auth", method) };
  }
  try {
    const result = await dependencies.auth.validateSession(token);
    if (isSessionValidationSuccess(result)) return { ok: true, token };
    if (isAuthFailure(result)) {
      return {
        ok: false,
        response: errorResponse(result.code === "replay" ? 409 : 401, result.code === "replay" ? "replay" : "invalid_auth", method),
      };
    }
    return { ok: false, response: errorResponse(500, "internal", method) };
  } catch {
    return { ok: false, response: errorResponse(500, "internal", method) };
  }
}

/**
 * Pure async dashboard API route handler. It returns `handled:false` for all
 * non-dashboard targets so the caller can continue routing existing endpoints.
 */
export async function handleDashboardRoute(
  request: DashboardRouteRequest,
  dependencies: DashboardRouteDependencies,
): Promise<DashboardRouteResponse> {
  const target = classifyTarget(request.target);
  if (target === null) return { handled: false };

  if (!admissionIsAllowed(request.admission)) {
    // Any admission the server did not allow — a denied host or a malformed test
    // seam value — is an admission failure here. Do not let a bad seam accidentally
    // turn into an unprotected dashboard route; both shapes fail identically closed.
    return errorResponse(403, "forbidden", request.method);
  }
  if (!target.methodAllowed.includes(request.method)) {
    return errorResponse(405, "method_not_allowed", request.method, target.methodAllowed);
  }

  const accept = readHeader(request.headers, "accept");
  if (!accept.valid || !accept.present || accept.values.length !== 1 || !isDashboardMediaType(accept.values[0])) {
    return errorResponse(406, "unsupported_version", request.method);
  }

  const isWrite = target.kind === "bootstrap" || target.kind === "session" || target.kind === "logout";
  const originRequired = target.kind === "session" || target.kind === "logout";
  if (!originAllowed(request.headers, request.admission.expectedOrigin, originRequired)) {
    return errorResponse(403, "forbidden", request.method);
  }
  if (!fetchSiteAllowed(request.headers, isWrite && target.kind !== "bootstrap" ? "write" : "read")) {
    return errorResponse(403, "forbidden", request.method);
  }

  let declaredBodyLength: number | undefined;
  if (isWrite) {
    if (!isPlainJsonContentType(request.headers)) {
      return errorResponse(415, "unsupported_content_type", request.method);
    }
    const length = parseBodyLength(request.headers);
    if (!length.ok) return errorResponse(length.status, length.status === 413 ? "oversized" : "malformed_query", request.method);
    declaredBodyLength = length.length;
  }

  const queryLimit = queryLimitError(target);
  if (queryLimit !== null) {
    return errorResponse(queryLimit.status, statusForQueryError(queryLimit.status), request.method);
  }

  if (target.kind === "bootstrap" && !request.admission.controlAuthorized) {
    return errorResponse(403, "forbidden", request.method);
  }

  if (target.kind === "snapshot") {
    const parsed = parseSnapshotQuery(target.rawQuery);
    if (!parsed.ok) return errorResponse(parsed.status, statusForQueryError(parsed.status), request.method);
    const session = await validateSession(dependencies, request.headers, request.method);
    if (!session.ok) return session.response;
    try {
      const value = await dependencies.read.readSnapshot(parsed.query);
      if (
        !isDashboardSnapshotV1(value) ||
        value.window !== parsed.query.window ||
        value.includeRepair !== parsed.query.includeRepair ||
        (parsed.query.attribution !== undefined &&
          value.attribution !== mapDashboardQueryAttribution(parsed.query.attribution))
      ) {
        return errorResponse(500, "internal", request.method);
      }
      return handledJson(200, value, request.method);
    } catch {
      return errorResponse(500, "internal", request.method);
    }
  }

  if (target.kind === "detail") {
    const parsed = parseDetailQuery(target.rawQuery, target.requestId ?? "");
    if (!parsed.ok) return errorResponse(parsed.status, statusForQueryError(parsed.status), request.method);
    const session = await validateSession(dependencies, request.headers, request.method);
    if (!session.ok) return session.response;
    try {
      const value = await dependencies.read.readDetail(parsed.query);
      if (value === null) return errorResponse(404, "not_found", request.method);
      if (
        !isDashboardDetailV1(value) ||
        value.request.requestId !== parsed.query.requestId ||
        (!parsed.query.includeRepair && value.attempts.some((attempt) => attempt.role === "repair"))
      ) {
        return errorResponse(500, "internal", request.method);
      }
      return handledJson(200, value, request.method);
    } catch {
      return errorResponse(500, "internal", request.method);
    }
  }

  const emptyQuery = noQueryAllowed(target);
  if (!emptyQuery.ok) return errorResponse(400, "malformed_query", request.method);

  if (target.kind === "logout") {
    const session = await validateSession(dependencies, request.headers, request.method);
    if (!session.ok) return session.response;
    let body: Uint8Array;
    try {
      body = await request.readBody(DASHBOARD_MAX_BODY_BYTES);
    } catch (error) {
      return errorResponse(bodyReadErrorCode(error) === "oversized" ? 413 : 500, bodyReadErrorCode(error), request.method);
    }
    if (body.byteLength > DASHBOARD_MAX_BODY_BYTES) return errorResponse(413, "oversized", request.method);
    if (declaredBodyLength !== body.byteLength) return errorResponse(400, "malformed_query", request.method);
    if (!isLogoutRequest(parseJsonBody(body))) return errorResponse(400, "malformed_query", request.method);
    try {
      const result = await dependencies.auth.logout(session.token);
      if (isLogoutSuccess(result)) return handledEmpty(204);
      if (isAuthFailure(result)) {
        return errorResponse(result.code === "replay" ? 409 : 401, result.code === "replay" ? "replay" : "invalid_auth", request.method);
      }
      return errorResponse(500, "internal", request.method);
    } catch {
      return errorResponse(500, "internal", request.method);
    }
  }

  let body: Uint8Array;
  try {
    body = await request.readBody(DASHBOARD_MAX_BODY_BYTES);
  } catch (error) {
    const code = bodyReadErrorCode(error);
    return errorResponse(code === "oversized" ? 413 : 500, code, request.method);
  }
  if (body.byteLength > DASHBOARD_MAX_BODY_BYTES) return errorResponse(413, "oversized", request.method);
  if (declaredBodyLength !== body.byteLength) return errorResponse(400, "malformed_query", request.method);
  const parsedBody = parseJsonBody(body);
  if (target.kind === "bootstrap") {
    if (!isBootstrapRequest(parsedBody)) return errorResponse(400, "malformed_query", request.method);
    try {
      const result = await dependencies.auth.createBootstrap();
      if (!isBootstrapSuccess(result)) return errorResponse(500, "internal", request.method);
      return handledJson(
        200,
        { schema: DASHBOARD_BOOTSTRAP_SCHEMA, bootstrap: result.bootstrap, expiresAt: isoTimestamp(result.expiresAt) },
        request.method,
      );
    } catch {
      return errorResponse(500, "internal", request.method);
    }
  }

  if (!isSessionRequest(parsedBody)) return errorResponse(400, "malformed_query", request.method);
  try {
    const result = await dependencies.auth.exchangeBootstrap(parsedBody.bootstrap);
    if (isSessionSuccess(result)) {
      return handledJson(
        200,
        {
          schema: DASHBOARD_SESSION_SCHEMA,
          session: result.session,
          scope: DASHBOARD_SCOPE,
          idleExpiresAt: isoTimestamp(result.idleExpiresAt),
          absoluteExpiresAt: isoTimestamp(result.absoluteExpiresAt),
        },
        request.method,
      );
    }
    if (isAuthFailure(result)) {
      return errorResponse(result.code === "replay" ? 409 : 401, result.code === "replay" ? "replay" : "invalid_auth", request.method);
    }
    return errorResponse(500, "internal", request.method);
  } catch {
    return errorResponse(500, "internal", request.method);
  }
}

/** Small object wrapper useful to production mounts and unit tests. */
export class DashboardRouteHandler {
  readonly #dependencies: DashboardRouteDependencies;

  constructor(dependencies: DashboardRouteDependencies) {
    this.#dependencies = dependencies;
  }

  handle(request: DashboardRouteRequest): Promise<DashboardRouteResponse> {
    return handleDashboardRoute(request, this.#dependencies);
  }
}

export function createDashboardRouteHandler(dependencies: DashboardRouteDependencies): DashboardRouteHandler {
  return new DashboardRouteHandler(dependencies);
}
