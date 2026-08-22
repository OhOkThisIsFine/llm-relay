import { describe, expect, it, vi } from "vitest";
import {
  DASHBOARD_BOOTSTRAP_REQUEST_SCHEMA,
  DASHBOARD_LOGOUT_REQUEST_SCHEMA,
  DASHBOARD_MEDIA_TYPE,
  DASHBOARD_SESSION_REQUEST_SCHEMA,
  createDashboardRouteHandler,
  handleDashboardRoute,
  type DashboardAuthPort,
  type DashboardHeaderMap,
  type DashboardReadPort,
  type DashboardRouteHandled,
  type DashboardRouteRequest,
  type DashboardRouteResponse,
} from "../../src/dashboard-routes.js";
import { DASHBOARD_SCOPE, DASHBOARD_SESSION_HEADER, createDashboardAuthManager } from "../../src/dashboard-auth.js";
import {
  DASHBOARD_DETAIL_SCHEMA,
  DASHBOARD_MAX_QUERY_BYTES,
  DASHBOARD_SNAPSHOT_SCHEMA,
  type AttemptRowV1,
  type DetailV1,
  type SnapshotV1,
  type SpendTotalsV1,
  type TokenTotalsV1,
} from "../../src/dashboard-contract.js";

const ORIGIN = "http://127.0.0.1:43110";
const REQUEST_ID = "request_123456789";
const TIME = "2026-08-20T12:00:00Z";

function headers(overrides: Partial<Record<string, readonly unknown[]>> = {}): DashboardHeaderMap {
  return {
    accept: [DASHBOARD_MEDIA_TYPE],
    ...overrides,
  };
}

function bytes(value: unknown): Uint8Array {
  return new TextEncoder().encode(JSON.stringify(value));
}

function asHandled(response: DashboardRouteResponse): DashboardRouteHandled {
  if (!response.handled) throw new Error("expected dashboard route to be handled");
  return response;
}

function authHeaders(session: string, extra: Partial<Record<string, readonly unknown[]>> = {}): DashboardHeaderMap {
  return headers({
    origin: [ORIGIN],
    [DASHBOARD_SESSION_HEADER.toLowerCase()]: [session],
    ...extra,
  });
}

function admission(controlAuthorized = true) {
  return { hostAuthorized: true as const, expectedOrigin: ORIGIN, controlAuthorized };
}

function bodyHeaders(body: Uint8Array, extra: Partial<Record<string, readonly unknown[]>> = {}): DashboardHeaderMap {
  return headers({
    "content-type": ["application/json"],
    "content-length": [String(body.byteLength)],
    ...extra,
  });
}

function request(
  method: string,
  target: string,
  options: Partial<DashboardRouteRequest> & { headers?: DashboardHeaderMap } = {},
): DashboardRouteRequest {
  return {
    method,
    target,
    headers: options.headers ?? headers(),
    admission: options.admission ?? admission(),
    readBody: options.readBody ?? (async () => new Uint8Array()),
  };
}

function reportedCell(value: number | null = null): TokenTotalsV1["reported"]["reportedInput"] {
  return { value, source: "provider_reported", observedAt: TIME };
}

function estimatedCell(value: number | null = null): TokenTotalsV1["estimated"]["estimatedInput"] {
  return { value, source: "relay_estimated", observedAt: TIME, method: null };
}

function tokens(): TokenTotalsV1 {
  return {
    reported: {
      reportedInput: reportedCell(1),
      reportedOutput: reportedCell(2),
      reportedCachedInput: reportedCell(null),
    },
    estimated: {
      estimatedInput: estimatedCell(null),
      estimatedOutput: estimatedCell(null),
    },
  };
}

function spend(): SpendTotalsV1 {
  const base = { amountMicrousd: null, observedAt: TIME };
  return {
    providerPublishedReported: { ...base, priceSource: "provider_published", tokenBasis: "reported", source: "unknown" },
    providerPublishedEstimated: { ...base, priceSource: "provider_published", tokenBasis: "estimated", source: "unknown" },
    referenceReported: { ...base, priceSource: "reference", tokenBasis: "reported", source: "unknown" },
    referenceEstimated: { ...base, priceSource: "reference", tokenBasis: "estimated", source: "unknown" },
    unpricedRequests: 1,
  };
}

function summary() {
  return {
    requests: 0,
    attempts: 0,
    served: 0,
    errored: 0,
    cancelled: 0,
    successRate: null,
    tokens: tokens(),
    spend: spend(),
    avgLatencyMs: null,
    p95LatencyMs: null,
    avgCommitMs: null,
  };
}

function snapshot(): SnapshotV1 {
  return {
    schema: DASHBOARD_SNAPSHOT_SCHEMA,
    relayVersion: "test",
    window: "1h",
    includeRepair: false,
    attribution: "all",
    attributionPolicy: "unknown",
    generatedAt: TIME,
    asOf: TIME,
    from: TIME,
    to: TIME,
    retentionFrom: null,
    retentionTo: null,
    panelCoverage: [],
    summary: summary(),
    buckets: [],
    providers: [],
    models: [],
    clients: [],
    credentials: [],
    errors: [],
    quotas: [],
    cooldowns: [],
    recentRequests: [],
  };
}

function detail(): DetailV1 {
  return {
    schema: DASHBOARD_DETAIL_SCHEMA,
    request: {
      requestId: REQUEST_ID,
      occurredAt: TIME,
      client: null,
      attribution: "relay_held",
      outcome: "unknown",
      failureKind: null,
      attemptCount: 0,
      latencyMs: null,
      commitMs: null,
      provider: null,
      model: null,
      credentialId: null,
      tokens: tokens(),
      spend: spend(),
      repairIncluded: false,
    },
    attempts: [],
    panelCoverage: [],
  };
}

function repairAttempt(): AttemptRowV1 {
  return {
    attemptId: "repair_attempt_1",
    role: "repair",
    startedAt: TIME,
    endedAt: TIME,
    status: "success",
    latencyMs: null,
    commitMs: null,
    provider: null,
    model: null,
    credentialId: null,
    failureKind: null,
    tokens: null,
    spend: null,
  };
}

function readPort(overrides: Partial<DashboardReadPort> = {}): DashboardReadPort {
  return {
    readSnapshot: async () => snapshot(),
    readDetail: async () => detail(),
    ...overrides,
  };
}

function jsonBody(requestValue: unknown): { body: Uint8Array; headers: DashboardHeaderMap } {
  const body = bytes(requestValue);
  return { body, headers: bodyHeaders(body, { origin: [ORIGIN] }) };
}

function json(response: { body?: Uint8Array }): unknown {
  return JSON.parse(new TextDecoder().decode(response.body ?? new Uint8Array())) as unknown;
}

describe("dashboard API route policy", () => {
  it("does not shadow static, version, encoded, trailing, or data-plane targets", async () => {
    const auth = { validateSession: vi.fn() } as unknown as DashboardAuthPort;
    const read = readPort();
    const dependencies = { auth, read };
    for (const target of [
      "/dashboard/",
      "/dashboard/assets/main.js",
      "/dashboard/api/v1/snapshot/",
      "/dashboard/api/v2/snapshot?window=1h&includeRepair=0",
      "/dashboard/api/v1/snapshot%3Fwindow=1h",
      "/v1/messages",
      "/control",
      "/dashboard/api/v1/requests/" + REQUEST_ID + "/extra",
    ]) {
      await expect(handleDashboardRoute(request("GET", target), dependencies)).resolves.toEqual({ handled: false });
    }
    expect(auth.validateSession).not.toHaveBeenCalled();
  });

  it("rejects host, method, accept, and browser admission before body/auth work", async () => {
    const readBody = vi.fn(async () => new Uint8Array());
    const validateSession = vi.fn();
    const dependencies = { auth: { validateSession } as unknown as DashboardAuthPort, read: readPort() };
    const target = "/dashboard/api/v1/session";
    const base = request("POST", target, { readBody });
    expect(asHandled(await handleDashboardRoute({ ...base, admission: { hostAuthorized: false } }, dependencies)).status).toBe(403);
    expect(asHandled(await handleDashboardRoute({ ...base, method: "GET" }, dependencies)).status).toBe(405);
    expect(asHandled(await handleDashboardRoute({ ...base, headers: headers({ accept: ["application/json"] }) }, dependencies)).status).toBe(406);
    expect(asHandled(await handleDashboardRoute({ ...base, headers: bodyHeaders(new Uint8Array(), { origin: ["http://evil.test"] }) }, dependencies)).status).toBe(403);
    expect(readBody).not.toHaveBeenCalled();
    expect(validateSession).not.toHaveBeenCalled();
  });

  it("requires exact accept, JSON content type, and bounded declared length", async () => {
    const readBody = vi.fn(async () => new Uint8Array());
    const dependencies = { auth: {} as DashboardAuthPort, read: readPort() };
    const target = "/dashboard/api/v1/bootstrap";
    const base = request("POST", target, { admission: admission(true), readBody });
    expect(asHandled(await handleDashboardRoute({ ...base, headers: headers({ accept: [DASHBOARD_MEDIA_TYPE, DASHBOARD_MEDIA_TYPE] }) }, dependencies)).status).toBe(406);
    expect(asHandled(await handleDashboardRoute({ ...base, headers: headers({ "content-type": ["text/plain"], "content-length": ["0"] }) }, dependencies)).status).toBe(415);
    expect(asHandled(await handleDashboardRoute({ ...base, headers: headers({ "content-type": ["application/json"], "content-length": ["17000"] }) }, dependencies)).status).toBe(413);
    expect(asHandled(await handleDashboardRoute({ ...base, headers: headers({ "content-type": ["application/json"] }) }, dependencies)).status).toBe(400);
    expect(readBody).not.toHaveBeenCalled();
  });

  it("bootstraps with exact body schema and serializes an ISO expiry", async () => {
    const auth = createDashboardAuthManager({ clock: () => 1_000, randomBytes: (size) => new Uint8Array(size).fill(4) });
    const bodyValue = { schema: DASHBOARD_BOOTSTRAP_REQUEST_SCHEMA };
    const prepared = jsonBody(bodyValue);
    const readBody = vi.fn(async () => prepared.body);
    const route = createDashboardRouteHandler({ auth, read: readPort() });
    const response = asHandled(await route.handle(request("POST", "/dashboard/api/v1/bootstrap", { headers: prepared.headers, readBody })));
    expect(response).toMatchObject({ handled: true, status: 200 });
    expect(readBody).toHaveBeenCalledTimes(1);
    expect(json(response as { body?: Uint8Array })).toMatchObject({ schema: "dashboard.bootstrap.v1", expiresAt: "1970-01-01T00:01:01.000Z" });
    expect(response.headers["Content-Type"]).toBe(DASHBOARD_MEDIA_TYPE);
    expect(Number(response.headers["Content-Length"])).toBe(response.body?.byteLength);
  });

  it("exchanges a bootstrap, rejects replay, and authenticates reads", async () => {
    let counter = 1;
    const auth = createDashboardAuthManager({
      clock: () => 1_000,
      randomBytes: (size) => new Uint8Array(size).fill(counter++),
    });
    const bootBody = jsonBody({ schema: DASHBOARD_BOOTSTRAP_REQUEST_SCHEMA });
    const bootstrap = await handleDashboardRoute(
      request("POST", "/dashboard/api/v1/bootstrap", { headers: bootBody.headers, readBody: async () => bootBody.body }),
      { auth, read: readPort() },
    );
    const bootstrapToken = (json(bootstrap as { body?: Uint8Array }) as { bootstrap: string }).bootstrap;
    const sessionBody = jsonBody({ schema: DASHBOARD_SESSION_REQUEST_SCHEMA, bootstrap: bootstrapToken });
    const sessionResponse = await handleDashboardRoute(
      request("POST", "/dashboard/api/v1/session", { headers: sessionBody.headers, readBody: async () => sessionBody.body }),
      { auth, read: readPort() },
    );
    const sessionToken = (json(sessionResponse as { body?: Uint8Array }) as { session: string }).session;
    const replay = asHandled(await handleDashboardRoute(
      request("POST", "/dashboard/api/v1/session", { headers: sessionBody.headers, readBody: async () => sessionBody.body }),
      { auth, read: readPort() },
    ));
    expect(replay.status).toBe(409);
    const read = asHandled(await handleDashboardRoute(
      request("GET", "/dashboard/api/v1/snapshot?window=1h&includeRepair=0", { headers: authHeaders(sessionToken) }),
      { auth, read: readPort() },
    ));
    expect(read.status).toBe(200);
    expect((json(read as { body?: Uint8Array }) as SnapshotV1).schema).toBe(DASHBOARD_SNAPSHOT_SCHEMA);
  });

  it("applies strict query parsing and performs no read on malformed input", async () => {
    const readSnapshot = vi.fn(async () => snapshot());
    const validateSession = vi.fn(() => ({ ok: true, scope: DASHBOARD_SCOPE, idleExpiresAt: 1, absoluteExpiresAt: 2 }));
    const dependencies = { auth: { validateSession } as unknown as DashboardAuthPort, read: readPort({ readSnapshot }) };
    for (const target of [
      "/dashboard/api/v1/snapshot?includeRepair=0",
      "/dashboard/api/v1/snapshot?window=1h&window=24h&includeRepair=0",
      "/dashboard/api/v1/snapshot?window=1h&includeRepair=0&unknown=x",
      "/dashboard/api/v1/snapshot?window=1h&includeRepair=0&provider=%E0%A4%A",
      "/dashboard/api/v1/snapshot?window=1h&includeRepair=0&provider=" + "é".repeat(129),
    ]) {
      const response = asHandled(await handleDashboardRoute(request("GET", target, { headers: authHeaders("valid-token") }), dependencies));
      expect(response.status).toBe(400);
    }
    expect(readSnapshot).not.toHaveBeenCalled();
    expect(validateSession).not.toHaveBeenCalled();
  });

  it("decodes one valid percent-encoded filter exactly once before forwarding it", async () => {
    const validateSession = vi.fn(() => ({ ok: true, scope: DASHBOARD_SCOPE, idleExpiresAt: 1, absoluteExpiresAt: 2 }));
    const readSnapshot = vi.fn(async () => snapshot());
    const dependencies = { auth: { validateSession } as unknown as DashboardAuthPort, read: readPort({ readSnapshot }) };
    const response = asHandled(await handleDashboardRoute(
      request("GET", "/dashboard/api/v1/snapshot?window=1h&includeRepair=0&provider=foo%2523bar", {
        headers: authHeaders("valid-token"),
      }),
      dependencies,
    ));
    expect(response.status).toBe(200);
    expect(readSnapshot).toHaveBeenCalledWith({
      window: "1h",
      includeRepair: false,
      provider: "foo%23bar",
    });
  });

  it("validates session before buffering logout, and malformed logout never revokes", async () => {
    const validateSession = vi.fn(() => ({ ok: true, scope: DASHBOARD_SCOPE, idleExpiresAt: 1, absoluteExpiresAt: 2 }));
    const logout = vi.fn(() => ({ ok: true, revoked: true }));
    const readBody = vi.fn(async () => bytes({ schema: "dashboard.logout.request.v2" }));
    const dependencies = { auth: { validateSession, logout } as unknown as DashboardAuthPort, read: readPort() };
    const response = await handleDashboardRoute(
      request("POST", "/dashboard/api/v1/logout", {
        headers: bodyHeaders(bytes({ schema: "dashboard.logout.request.v2" }), {
          origin: [ORIGIN],
          [DASHBOARD_SESSION_HEADER.toLowerCase()]: ["valid-token"],
        }),
        readBody,
      }),
      dependencies,
    );
    expect(asHandled(response).status).toBe(400);
    expect(validateSession).toHaveBeenCalledTimes(1);
    expect(readBody).toHaveBeenCalledTimes(1);
    expect(logout).not.toHaveBeenCalled();
  });

  it("returns detail null as 404 and performs full GET/HEAD read parity", async () => {
    const validateSession = vi.fn(() => ({ ok: true, scope: DASHBOARD_SCOPE, idleExpiresAt: 1, absoluteExpiresAt: 2 }));
    const readDetail = vi.fn<() => Promise<DetailV1 | null>>(async () => detail());
    const dependencies = { auth: { validateSession } as unknown as DashboardAuthPort, read: readPort({ readDetail }) };
    const target = `/dashboard/api/v1/requests/${REQUEST_ID}?includeRepair=0`;
    const get = asHandled(await handleDashboardRoute(request("GET", target, { headers: authHeaders("valid-token") }), dependencies));
    const head = asHandled(await handleDashboardRoute(request("HEAD", target, { headers: authHeaders("valid-token") }), dependencies));
    expect(get.status).toBe(200);
    expect(head.status).toBe(get.status);
    expect(head.headers).toEqual(get.headers);
    expect(head).not.toHaveProperty("body");
    expect(readDetail).toHaveBeenCalledTimes(2);

    readDetail.mockResolvedValueOnce(null);
    const missing = asHandled(await handleDashboardRoute(request("GET", target, { headers: authHeaders("valid-token") }), dependencies));
    expect(missing.status).toBe(404);
  });

  it("normalizes thrown/schema-invalid dependencies and keeps responses redacted", async () => {
    const validateSession = vi.fn(() => ({ ok: true, scope: DASHBOARD_SCOPE, idleExpiresAt: 1, absoluteExpiresAt: 2 }));
    const readSnapshot = vi.fn(async () => ({ dependencySecret: "do-not-return" }) as unknown as SnapshotV1);
    const dependencies = { auth: { validateSession } as unknown as DashboardAuthPort, read: readPort({ readSnapshot }) };
    const response = asHandled(await handleDashboardRoute(
      request("GET", "/dashboard/api/v1/snapshot?window=1h&includeRepair=0", { headers: authHeaders("valid-token") }),
      dependencies,
    ));
    expect(response.status).toBe(500);
    const body = new TextDecoder().decode(response.body ?? new Uint8Array());
    expect(body).not.toContain("dependencySecret");
    expect(body).not.toContain("do-not-return");
    expect(response.headers["Cache-Control"]).toBe("no-store");
    expect(response.headers["Content-Security-Policy"]).toBeDefined();
    expect(response.headers["X-Frame-Options"]).toBe("DENY");
    expect(response.headers["Permissions-Policy"]).toContain("camera=()");
    expect(response.headers["Cross-Origin-Opener-Policy"]).toBe("same-origin");
    expect(response.headers["Set-Cookie"]).toBeUndefined();
    expect(response.headers["Access-Control-Allow-Origin"]).toBeUndefined();
  });

  it("logs out with a 204 that has no dashboard media body", async () => {
    const body = bytes({ schema: DASHBOARD_LOGOUT_REQUEST_SCHEMA });
    const validateSession = vi.fn(() => ({ ok: true, scope: DASHBOARD_SCOPE, idleExpiresAt: 1, absoluteExpiresAt: 2 }));
    const logout = vi.fn(() => ({ ok: true, revoked: true }));
    const dependencies = { auth: { validateSession, logout } as unknown as DashboardAuthPort, read: readPort() };
    const response = asHandled(await handleDashboardRoute(
      request("POST", "/dashboard/api/v1/logout", {
        headers: bodyHeaders(body, { origin: [ORIGIN], [DASHBOARD_SESSION_HEADER.toLowerCase()]: ["valid-token"] }),
        readBody: async () => body,
      }),
      dependencies,
    ));
    expect(response.status).toBe(204);
    expect(response.headers["Content-Security-Policy"]).toBeDefined();
    expect(response.headers["X-Frame-Options"]).toBe("DENY");
    expect(response.headers["Permissions-Policy"]).toContain("camera=()");
    expect(response.headers["Cross-Origin-Opener-Policy"]).toBe("same-origin");
    expect(response).not.toHaveProperty("body");
    expect(response.headers["Content-Type"]).toBeUndefined();
    expect(response.headers["Content-Length"]).toBeUndefined();
    expect(logout).toHaveBeenCalledWith("valid-token");
  });

  it("applies the shared 16KiB query cap to every recognized route before side effects", async () => {
    const body = bytes({ schema: DASHBOARD_BOOTSTRAP_REQUEST_SCHEMA });
    const oversizedQuery = "x".repeat(DASHBOARD_MAX_QUERY_BYTES + 1);
    const readBody = vi.fn(async () => body);
    const auth = {
      createBootstrap: vi.fn(() => ({ ok: true, bootstrap: "bootstrap", expiresAt: 1 })),
      exchangeBootstrap: vi.fn(),
      validateSession: vi.fn(),
      logout: vi.fn(),
    } as unknown as DashboardAuthPort;
    const read = {
      readSnapshot: vi.fn(async () => snapshot()),
      readDetail: vi.fn(async () => detail()),
    } as unknown as DashboardReadPort;
    const dependencies = { auth, read };

    const postCases: ReadonlyArray<readonly [string, DashboardHeaderMap, unknown]> = [
      [
        "/dashboard/api/v1/bootstrap",
        bodyHeaders(body),
        { schema: DASHBOARD_BOOTSTRAP_REQUEST_SCHEMA },
      ],
      [
        "/dashboard/api/v1/session",
        bodyHeaders(bytes({ schema: DASHBOARD_SESSION_REQUEST_SCHEMA, bootstrap: "bootstrap" }), { origin: [ORIGIN] }),
        { schema: DASHBOARD_SESSION_REQUEST_SCHEMA, bootstrap: "bootstrap" },
      ],
      [
        "/dashboard/api/v1/logout",
        bodyHeaders(bytes({ schema: DASHBOARD_LOGOUT_REQUEST_SCHEMA }), {
          origin: [ORIGIN],
          [DASHBOARD_SESSION_HEADER.toLowerCase()]: ["valid-token"],
        }),
        { schema: DASHBOARD_LOGOUT_REQUEST_SCHEMA },
      ],
    ];
    for (const [path, requestHeaders, bodyValue] of postCases) {
      const postBody = bytes(bodyValue);
      const response = asHandled(await handleDashboardRoute(
        request("POST", `${path}?${oversizedQuery}`, {
          headers: bodyHeaders(postBody, Object.fromEntries(Object.entries(requestHeaders).filter(([key]) => key !== "content-length"))),
          readBody,
        }),
        dependencies,
      ));
      expect(response.status).toBe(413);
    }

    for (const target of [
      `/dashboard/api/v1/snapshot?${oversizedQuery}`,
      `/dashboard/api/v1/requests/${REQUEST_ID}?${oversizedQuery}`,
    ]) {
      const response = asHandled(await handleDashboardRoute(
        request("GET", target, { headers: authHeaders("valid-token") }),
        dependencies,
      ));
      expect(response.status).toBe(413);
    }
    expect(readBody).not.toHaveBeenCalled();
    expect(auth.createBootstrap).not.toHaveBeenCalled();
    expect(auth.exchangeBootstrap).not.toHaveBeenCalled();
    expect(auth.validateSession).not.toHaveBeenCalled();
    expect(auth.logout).not.toHaveBeenCalled();
    expect(read.readSnapshot).not.toHaveBeenCalled();
    expect(read.readDetail).not.toHaveBeenCalled();
  });

  it("requires declared and actual body lengths to match before JSON or auth mutation", async () => {
    const body = bytes({ schema: DASHBOARD_BOOTSTRAP_REQUEST_SCHEMA });
    const readBody = vi.fn(async () => body);
    const auth = {
      createBootstrap: vi.fn(() => ({ ok: true, bootstrap: "bootstrap", expiresAt: 1 })),
      exchangeBootstrap: vi.fn(),
      validateSession: vi.fn(() => ({ ok: true, scope: DASHBOARD_SCOPE, idleExpiresAt: 1, absoluteExpiresAt: 2 })),
      logout: vi.fn(() => ({ ok: true, revoked: true })),
    } as unknown as DashboardAuthPort;
    const dependencies = { auth, read: readPort() };

    const mismatchHeaders = bodyHeaders(body, { "content-length": [String(body.byteLength + 1)] });
    const mismatch = asHandled(await handleDashboardRoute(
      request("POST", "/dashboard/api/v1/bootstrap", { headers: mismatchHeaders, readBody }),
      dependencies,
    ));
    expect(mismatch.status).toBe(400);
    expect(auth.createBootstrap).not.toHaveBeenCalled();
    expect(readBody).toHaveBeenCalledTimes(1);

    const duplicateLength = asHandled(await handleDashboardRoute(
      request("POST", "/dashboard/api/v1/bootstrap", {
        headers: bodyHeaders(body, { "content-length": [String(body.byteLength), String(body.byteLength)] }),
        readBody,
      }),
      dependencies,
    ));
    expect(duplicateLength.status).toBe(400);

    const duplicateContentType = asHandled(await handleDashboardRoute(
      request("POST", "/dashboard/api/v1/bootstrap", {
        headers: bodyHeaders(body, { "content-type": ["application/json", "application/json"] }),
        readBody,
      }),
      dependencies,
    ));
    expect(duplicateContentType.status).toBe(415);
    expect(readBody).toHaveBeenCalledTimes(1);

    const duplicateSession = asHandled(await handleDashboardRoute(
      request("GET", "/dashboard/api/v1/snapshot?window=1h&includeRepair=0", {
        headers: authHeaders("valid-token", { [DASHBOARD_SESSION_HEADER.toLowerCase()]: ["valid-token", "valid-token"] }),
      }),
      dependencies,
    ));
    expect(duplicateSession.status).toBe(401);
    expect(auth.validateSession).not.toHaveBeenCalled();
  });

  it("rejects read-port identity mismatches as redacted internal errors", async () => {
    const validateSession = vi.fn(() => ({ ok: true, scope: DASHBOARD_SCOPE, idleExpiresAt: 1, absoluteExpiresAt: 2 }));
    const mismatchedSnapshot = { ...snapshot(), window: "24h" as const };
    const readSnapshot = vi.fn<() => Promise<SnapshotV1>>(async () => mismatchedSnapshot);
    const readDetail = vi.fn<() => Promise<DetailV1 | null>>(async () => ({
      ...detail(),
      request: { ...detail().request, requestId: "request_987654321" },
    }));
    const dependencies = {
      auth: { validateSession } as unknown as DashboardAuthPort,
      read: readPort({ readSnapshot, readDetail }),
    };
    const snapshotResponse = asHandled(await handleDashboardRoute(
      request("GET", "/dashboard/api/v1/snapshot?window=1h&includeRepair=0", { headers: authHeaders("valid-token") }),
      dependencies,
    ));
    expect(snapshotResponse.status).toBe(500);

    const detailResponse = asHandled(await handleDashboardRoute(
      request("GET", `/dashboard/api/v1/requests/${REQUEST_ID}?includeRepair=0`, { headers: authHeaders("valid-token") }),
      dependencies,
    ));
    expect(detailResponse.status).toBe(500);
    expect(new TextDecoder().decode(detailResponse.body)).not.toContain("request_987654321");

    readSnapshot.mockResolvedValueOnce({ ...snapshot(), includeRepair: true });
    const includeRepairResponse = asHandled(await handleDashboardRoute(
      request("GET", "/dashboard/api/v1/snapshot?window=1h&includeRepair=0", { headers: authHeaders("valid-token") }),
      dependencies,
    ));
    expect(includeRepairResponse.status).toBe(500);

    readSnapshot.mockResolvedValueOnce({ ...snapshot(), attribution: "all" });
    const attributionResponse = asHandled(await handleDashboardRoute(
      request("GET", "/dashboard/api/v1/snapshot?window=1h&includeRepair=0&attribution=relay-held", {
        headers: authHeaders("valid-token"),
      }),
      dependencies,
    ));
    expect(attributionResponse.status).toBe(500);

    readDetail.mockResolvedValueOnce({
      ...detail(),
      request: { ...detail().request, repairIncluded: true },
      attempts: [{ ...repairAttempt(), attemptId: "serve_attempt_1", role: "serve" }],
    });
    const hiddenRepairHistory = asHandled(await handleDashboardRoute(
      request("GET", `/dashboard/api/v1/requests/${REQUEST_ID}?includeRepair=0`, { headers: authHeaders("valid-token") }),
      dependencies,
    ));
    expect(hiddenRepairHistory.status).toBe(200);

    readDetail.mockResolvedValueOnce({
      ...detail(),
      request: { ...detail().request, repairIncluded: true },
      attempts: [repairAttempt()],
    });
    const repairResponse = asHandled(await handleDashboardRoute(
      request("GET", `/dashboard/api/v1/requests/${REQUEST_ID}?includeRepair=0`, { headers: authHeaders("valid-token") }),
      dependencies,
    ));
    expect(repairResponse.status).toBe(500);

    readDetail.mockResolvedValueOnce({
      ...detail(),
      request: { ...detail().request, repairIncluded: true },
      attempts: [repairAttempt()],
    });
    const includedRepair = asHandled(await handleDashboardRoute(
      request("GET", `/dashboard/api/v1/requests/${REQUEST_ID}?includeRepair=1`, { headers: authHeaders("valid-token") }),
      dependencies,
    ));
    expect(includedRepair.status).toBe(200);
  });

  it("enforces control, Origin, and Sec-Fetch-Site admission before body/auth/read side effects", async () => {
    const bootstrapBody = bytes({ schema: DASHBOARD_BOOTSTRAP_REQUEST_SCHEMA });
    const sessionBody = bytes({ schema: DASHBOARD_SESSION_REQUEST_SCHEMA, bootstrap: "bootstrap" });
    const logoutBody = bytes({ schema: DASHBOARD_LOGOUT_REQUEST_SCHEMA });
    const readBody = vi.fn(async () => bootstrapBody);
    const auth = {
      createBootstrap: vi.fn(() => ({ ok: true, bootstrap: "bootstrap", expiresAt: 1 })),
      exchangeBootstrap: vi.fn(() => ({ ok: true, session: "session", scope: DASHBOARD_SCOPE, idleExpiresAt: 1, absoluteExpiresAt: 2 })),
      validateSession: vi.fn(() => ({ ok: true, scope: DASHBOARD_SCOPE, idleExpiresAt: 1, absoluteExpiresAt: 2 })),
      logout: vi.fn(() => ({ ok: true, revoked: true })),
    } as unknown as DashboardAuthPort;
    const read = {
      readSnapshot: vi.fn(async () => snapshot()),
      readDetail: vi.fn(async () => detail()),
    } as unknown as DashboardReadPort;
    const dependencies = { auth, read };

    const deniedBootstrap = asHandled(await handleDashboardRoute(
      request("POST", "/dashboard/api/v1/bootstrap", {
        admission: admission(false),
        headers: bodyHeaders(bootstrapBody),
        readBody,
      }),
      dependencies,
    ));
    expect(deniedBootstrap.status).toBe(403);

    const crossSiteBootstrap = asHandled(await handleDashboardRoute(
      request("POST", "/dashboard/api/v1/bootstrap", {
        headers: bodyHeaders(bootstrapBody, { "sec-fetch-site": ["cross-site"] }),
        readBody,
      }),
      dependencies,
    ));
    expect(crossSiteBootstrap.status).toBe(403);

    const missingOriginSession = asHandled(await handleDashboardRoute(
      request("POST", "/dashboard/api/v1/session", {
        headers: bodyHeaders(sessionBody),
        readBody,
      }),
      dependencies,
    ));
    expect(missingOriginSession.status).toBe(403);

    const duplicateOriginSession = asHandled(await handleDashboardRoute(
      request("POST", "/dashboard/api/v1/session", {
        headers: bodyHeaders(sessionBody, { origin: [ORIGIN, ORIGIN] }),
        readBody,
      }),
      dependencies,
    ));
    expect(duplicateOriginSession.status).toBe(403);

    const noneSession = asHandled(await handleDashboardRoute(
      request("POST", "/dashboard/api/v1/session", {
        headers: bodyHeaders(sessionBody, { origin: [ORIGIN], "sec-fetch-site": ["none"] }),
        readBody,
      }),
      dependencies,
    ));
    expect(noneSession.status).toBe(403);

    const crossSiteRead = asHandled(await handleDashboardRoute(
      request("GET", "/dashboard/api/v1/snapshot?window=1h&includeRepair=0", {
        headers: authHeaders("valid-token", { "sec-fetch-site": ["cross-site"] }),
      }),
      dependencies,
    ));
    expect(crossSiteRead.status).toBe(403);

    const noneRead = asHandled(await handleDashboardRoute(
      request("GET", "/dashboard/api/v1/snapshot?window=1h&includeRepair=0", {
        headers: authHeaders("valid-token", { "sec-fetch-site": ["none"] }),
      }),
      dependencies,
    ));
    expect(noneRead.status).toBe(200);

    const missingOriginLogout = asHandled(await handleDashboardRoute(
      request("POST", "/dashboard/api/v1/logout", {
        headers: bodyHeaders(logoutBody, { [DASHBOARD_SESSION_HEADER.toLowerCase()]: ["valid-token"] }),
        readBody,
      }),
      dependencies,
    ));
    expect(missingOriginLogout.status).toBe(403);

    expect(readBody).not.toHaveBeenCalled();
    expect(auth.createBootstrap).not.toHaveBeenCalled();
    expect(auth.exchangeBootstrap).not.toHaveBeenCalled();
    expect(auth.validateSession).toHaveBeenCalledTimes(1);
    expect(auth.logout).not.toHaveBeenCalled();
    expect(read.readSnapshot).toHaveBeenCalledTimes(1);
    expect(read.readDetail).not.toHaveBeenCalled();
  });

  it("keeps snapshot, error, and not-found HEAD responses header-identical and bodiless", async () => {
    const validateSession = vi.fn(() => ({ ok: true, scope: DASHBOARD_SCOPE, idleExpiresAt: 1, absoluteExpiresAt: 2 }));
    const readDetail = vi.fn<() => Promise<DetailV1 | null>>(async () => null);
    const dependencies = {
      auth: { validateSession } as unknown as DashboardAuthPort,
      read: readPort({ readDetail }),
    };
    const target = "/dashboard/api/v1/snapshot?window=1h&includeRepair=0";
    const get = asHandled(await handleDashboardRoute(request("GET", target, { headers: authHeaders("valid-token") }), dependencies));
    const head = asHandled(await handleDashboardRoute(request("HEAD", target, { headers: authHeaders("valid-token") }), dependencies));
    expect(head.status).toBe(get.status);
    expect(head.headers).toEqual(get.headers);
    expect(head).not.toHaveProperty("body");
    expect(Number(head.headers["Content-Length"])).toBe((get.body as Uint8Array).byteLength);

    const getError = asHandled(await handleDashboardRoute(
      request("GET", "/dashboard/api/v1/snapshot?window=1h&includeRepair=0", { headers: headers() }),
      dependencies,
    ));
    const headError = asHandled(await handleDashboardRoute(
      request("HEAD", "/dashboard/api/v1/snapshot?window=1h&includeRepair=0", { headers: headers() }),
      dependencies,
    ));
    expect(getError.status).toBe(401);
    expect(headError.headers).toEqual(getError.headers);
    expect(headError).not.toHaveProperty("body");

    const getMissing = asHandled(await handleDashboardRoute(
      request("GET", `/dashboard/api/v1/requests/${REQUEST_ID}?includeRepair=0`, { headers: authHeaders("valid-token") }),
      dependencies,
    ));
    const headMissing = asHandled(await handleDashboardRoute(
      request("HEAD", `/dashboard/api/v1/requests/${REQUEST_ID}?includeRepair=0`, { headers: authHeaders("valid-token") }),
      dependencies,
    ));
    expect(getMissing.status).toBe(404);
    expect(headMissing.headers).toEqual(getMissing.headers);
    expect(headMissing).not.toHaveProperty("body");
  });

  it("truly revokes a session so a repeated logout cannot succeed", async () => {
    const auth = createDashboardAuthManager({ clock: () => 1_000, randomBytes: (size) => new Uint8Array(size).fill(9) });
    const bootstrap = auth.createBootstrap();
    const exchanged = auth.exchangeBootstrap(bootstrap.bootstrap);
    if (!exchanged.ok) throw new Error("expected test session");
    const body = bytes({ schema: DASHBOARD_LOGOUT_REQUEST_SCHEMA });
    const dependencies = { auth, read: readPort() };
    const makeRequest = () => request("POST", "/dashboard/api/v1/logout", {
      headers: bodyHeaders(body, { origin: [ORIGIN], [DASHBOARD_SESSION_HEADER.toLowerCase()]: [exchanged.session] }),
      readBody: async () => body,
    });
    const first = asHandled(await handleDashboardRoute(makeRequest(), dependencies));
    const second = asHandled(await handleDashboardRoute(makeRequest(), dependencies));
    expect(first.status).toBe(204);
    expect(second.status).toBe(401);
  });
});
