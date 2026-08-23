import { afterEach, describe, expect, it } from "vitest";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer, request as httpRequest, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createProxy, dashboardExpectedOriginForAuthority } from "../src/server.js";
import { createAccountingStore, type AccountingStore } from "../src/accounting-store.js";
import type { Config } from "../src/config.js";
import { CONTROL_AUTHORIZATION_HEADER } from "../src/control-authorization.js";
import { DASHBOARD_MEDIA_TYPE } from "../src/dashboard-contract.js";

const CONTROL = "dashboard-test-control";

const EXPECTED_DASHBOARD_SECURITY_HEADERS: Readonly<Record<string, string>> = Object.freeze({
  "content-security-policy":
    "default-src 'none'; script-src 'self'; style-src 'self'; connect-src 'self'; img-src 'self' data:; font-src 'self'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'; form-action 'none'",
  "x-frame-options": "DENY",
  "permissions-policy": "accelerometer=(), camera=(), geolocation=(), gyroscope=(), microphone=(), payment=(), usb=()",
  "cross-origin-opener-policy": "same-origin",
  "referrer-policy": "no-referrer",
  "x-content-type-options": "nosniff",
  "cross-origin-resource-policy": "same-origin",
});

function expectDashboardHeaders(response: Response, cacheControl: string): void {
  // Exact equality also catches Node's comma-joined duplicate/conflicting values.
  for (const [name, value] of Object.entries(EXPECTED_DASHBOARD_SECURITY_HEADERS)) {
    expect(response.headers.get(name), name).toBe(value);
  }
  expect(response.headers.get("cache-control")).toBe(cacheControl);
}
const servers: Server[] = [];
const directories: string[] = [];
const stores: AccountingStore[] = [];

function jsonLines(file: string): Array<Record<string, unknown>> {
  return readFileSync(file, "utf8")
    .split("\n")
    .filter((line) => line.trim().length > 0)
    .map((line) => JSON.parse(line) as Record<string, unknown>);
}

function address(server: Server): string {
  return `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
}

async function listen(server: Server): Promise<Server> {
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  servers.push(server);
  return server;
}

function dashboardRoot(): string {
  const root = mkdtempSync(join(tmpdir(), "llm-relay-dashboard-server-"));
  directories.push(root);
  mkdirSync(join(root, "assets"), { recursive: true });
  mkdirSync(join(root, ".vite"), { recursive: true });
  writeFileSync(join(root, "index.html"), "<!doctype html><title>dashboard</title>");
  writeFileSync(join(root, "assets", "app-abcdefgh.js"), "console.log('dashboard');");
  writeFileSync(
    join(root, ".vite", "manifest.json"),
    JSON.stringify({ "index.html": { file: "assets/app-abcdefgh.js", isEntry: true } }),
  );
  return root;
}

function config(backendPort = 9): Config {
  return {
    host: "127.0.0.1",
    port: 0,
    mode: "detect",
    providers: {
      up: { base: `http://127.0.0.1:${backendPort}`, kind: "anthropic", authHeader: "x-api-key", timeoutMs: 5_000 },
    },
    routing: { default: "up", tiers: {}, pools: {}, offload: false },
    repair: { maxAttempts: 1, destructiveTools: [] },
    log: {},
  } as unknown as Config;
}

async function boot(backendPort?: number): Promise<string> {
  const server = await listen(createProxy(config(backendPort), {
    controlAuthorization: { validate: (token) => token === CONTROL },
    dashboardAssetRoot: dashboardRoot(),
  }));
  return address(server);
}

function bootstrapHeaders(): Record<string, string> {
  return {
    Accept: DASHBOARD_MEDIA_TYPE,
    "Content-Type": "application/json",
    [CONTROL_AUTHORIZATION_HEADER]: CONTROL,
  };
}

afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => new Promise<void>((resolve) => server.close(() => resolve()))));
  for (const store of stores.splice(0)) store.close();
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

describe("dashboard production adapter", () => {
  it("serves only the static manifest closure, with redirect and HEAD semantics", async () => {
    const url = await boot();
    const redirect = await fetch(`${url}/dashboard`, { redirect: "manual" });
    expect(redirect.status).toBe(308);
    expect(redirect.headers.get("location")).toBe("/dashboard/");

    const page = await fetch(`${url}/dashboard/`, { method: "HEAD" });
    expect(page.status).toBe(200);
    expect(await page.text()).toBe("");
    expect(page.headers.get("content-length")).toBe(String(Buffer.byteLength("<!doctype html><title>dashboard</title>")));
    expectDashboardHeaders(page, "no-store");

    const asset = await fetch(`${url}/dashboard/assets/app-abcdefgh.js`);
    expect(await asset.text()).toContain("dashboard");
    expectDashboardHeaders(asset, "public, max-age=31536000, immutable");
    const assetHead = await fetch(`${url}/dashboard/assets/app-abcdefgh.js`, { method: "HEAD" });
    expect(assetHead.status).toBe(200);
    expect(await assetHead.text()).toBe("");
    expectDashboardHeaders(assetHead, "public, max-age=31536000, immutable");
    const missingAsset = await fetch(`${url}/dashboard/assets/not-in-manifest.js`);
    expect(missingAsset.status).toBe(404);
    expectDashboardHeaders(missingAsset, "no-store");
    const unknownRoute = await fetch(`${url}/dashboard/not-a-route`);
    expect(unknownRoute.status).toBe(404);
    expectDashboardHeaders(unknownRoute, "no-store");

    const methodNotAllowed = await fetch(`${url}/dashboard/`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: "{}",
    });
    expect(methodNotAllowed.status).toBe(405);
    expectDashboardHeaders(methodNotAllowed, "no-store");
  });

  it("pins exact security headers across dashboard API/static error statuses", async () => {
    const url = await boot();
    const cases: Array<{ readonly label: string; readonly expected: number; readonly run: () => Promise<Response> }> = [
      {
        label: "400 malformed query",
        expected: 400,
        run: () => fetch(`${url}/dashboard/api/v1/snapshot?window=invalid&includeRepair=0`, {
          headers: { Accept: DASHBOARD_MEDIA_TYPE },
        }),
      },
      {
        label: "401 missing session",
        expected: 401,
        run: () => fetch(`${url}/dashboard/api/v1/snapshot?window=1h&includeRepair=0`, {
          headers: { Accept: DASHBOARD_MEDIA_TYPE },
        }),
      },
      {
        label: "403 bootstrap admission",
        expected: 403,
        run: () => fetch(`${url}/dashboard/api/v1/bootstrap`, {
          method: "POST",
          headers: { Accept: DASHBOARD_MEDIA_TYPE, "Content-Type": "application/json" },
          body: JSON.stringify({ schema: "dashboard.bootstrap.request.v1" }),
        }),
      },
      {
        label: "404 unknown API",
        expected: 404,
        run: () => fetch(`${url}/dashboard/api/v1/unknown`, { headers: { Accept: DASHBOARD_MEDIA_TYPE } }),
      },
      {
        label: "405 static method",
        expected: 405,
        run: () => fetch(`${url}/dashboard/`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: "{}",
        }),
      },
      {
        label: "405 API method",
        expected: 405,
        run: () => fetch(`${url}/dashboard/api/v1/bootstrap`, {
          headers: { Accept: DASHBOARD_MEDIA_TYPE },
        }),
      },
      {
        label: "406 unsupported version",
        expected: 406,
        run: () => fetch(`${url}/dashboard/api/v1/bootstrap`, {
          method: "POST",
          headers: {
            Accept: "text/plain",
            "Content-Type": "application/json",
            [CONTROL_AUTHORIZATION_HEADER]: CONTROL,
          },
          body: "{}",
        }),
      },
      {
        label: "413 oversized body",
        expected: 413,
        run: () => fetch(`${url}/dashboard/api/v1/bootstrap`, {
          method: "POST",
          headers: bootstrapHeaders(),
          body: "x".repeat(16 * 1024 + 1),
        }),
      },
      {
        label: "415 content type",
        expected: 415,
        run: () => fetch(`${url}/dashboard/api/v1/bootstrap`, {
          method: "POST",
          headers: { ...bootstrapHeaders(), "Content-Type": "application/json; charset=utf-8" },
          body: "{}",
        }),
      },
    ];

    for (const testCase of cases) {
      const response = await testCase.run();
      expect(response.status, testCase.label).toBe(testCase.expected);
      expectDashboardHeaders(response, "no-store");
      await response.arrayBuffer();
    }

    const bootstrapResponse = await fetch(`${url}/dashboard/api/v1/bootstrap`, {
      method: "POST", headers: bootstrapHeaders(), body: JSON.stringify({ schema: "dashboard.bootstrap.request.v1" }),
    });
    expect(bootstrapResponse.status).toBe(200);
    expectDashboardHeaders(bootstrapResponse, "no-store");
    const bootstrap = await bootstrapResponse.json() as { bootstrap: string };
    const sessionRequest = {
      method: "POST" as const,
      headers: {
        Accept: DASHBOARD_MEDIA_TYPE,
        "Content-Type": "application/json",
        Origin: url,
        "Sec-Fetch-Site": "same-origin",
      },
      body: JSON.stringify({ schema: "dashboard.session.request.v1", bootstrap: bootstrap.bootstrap }),
    };
    const sessionResponse = await fetch(`${url}/dashboard/api/v1/session`, sessionRequest);
    expect(sessionResponse.status).toBe(200);
    await sessionResponse.arrayBuffer();
    const replay = await fetch(`${url}/dashboard/api/v1/session`, sessionRequest);
    expect(replay.status).toBe(409);
    expectDashboardHeaders(replay, "no-store");
    await replay.arrayBuffer();
  });

  it("fails closed at the adapter for admission mistakes and encoded dashboard spellings without egress", async () => {
    let upstreamCalls = 0;
    const backend = await listen(createServer((request, response) => {
      upstreamCalls += 1;
      request.resume();
      response.end("unexpected");
    }));
    const url = await boot((backend.address() as AddressInfo).port);
    const port = Number(new URL(url).port);
    const bootstrapBody = JSON.stringify({ schema: "dashboard.bootstrap.request.v1" });
    const wrongHost = await new Promise<number>((resolve, reject) => {
      const request = httpRequest({ host: "127.0.0.1", port, path: "/dashboard/api/v1/bootstrap", method: "POST", headers: {
        Host: `attacker.example:${port}`, ...bootstrapHeaders(), "Content-Length": String(Buffer.byteLength(bootstrapBody)),
      } }, (response) => { response.resume(); resolve(response.statusCode ?? 0); });
      request.on("error", reject);
      request.end(bootstrapBody);
    });
    expect(wrongHost).toBe(403);
    expect((await fetch(`${url}/dashboard/api/v1/bootstrap`, {
      method: "POST", headers: { ...bootstrapHeaders(), Origin: "http://evil.example" }, body: JSON.stringify({ schema: "dashboard.bootstrap.request.v1" }),
    })).status).toBe(403);
    expect((await fetch(`${url}/dashboard/api/v1/bootstrap`, {
      method: "POST", headers: { ...bootstrapHeaders(), "Sec-Fetch-Site": "cross-site" }, body: JSON.stringify({ schema: "dashboard.bootstrap.request.v1" }),
    })).status).toBe(403);
    expect((await fetch(`${url}/dashboard/api/v1/bootstrap`, {
      method: "POST", headers: { Accept: DASHBOARD_MEDIA_TYPE, "Content-Type": "text/plain", [CONTROL_AUTHORIZATION_HEADER]: CONTROL }, body: "{}",
    })).status).toBe(403);
    expect((await fetch(`${url}/dashboard/api/v1/bootstrap`, {
      method: "POST", headers: { ...bootstrapHeaders(), Accept: "text/plain" }, body: JSON.stringify({ schema: "dashboard.bootstrap.request.v1" }),
    })).status).toBe(406);
    for (const suffix of [
      "/dashboard%2Funknown",
      "/dashboard%2funknown",
      "/%64ashboard/unknown",
      "/%64ashboard%2funknown",
      "/%64ashboard%",
      "/%64ashboard%3Ffoo",
      "/dashboard%2Efoo",
      "/dashboard%5Cfoo",
    ] as const) {
      const malformed = await fetch(`${url}${suffix}`);
      expect(malformed.status, suffix).toBe(404);
      expectDashboardHeaders(malformed, "no-store");
    }
    expect(upstreamCalls).toBe(0);
    expect(dashboardExpectedOriginForAuthority("::1", 43110)).toBe("http://[::1]:43110");
  });

  it("requires control authorization for bootstrap, then performs session, read, detail, and logout", async () => {
    const url = await boot();
    const denied = await fetch(`${url}/dashboard/api/v1/bootstrap`, {
      method: "POST",
      headers: { Accept: DASHBOARD_MEDIA_TYPE, "Content-Type": "application/json" },
      body: JSON.stringify({ schema: "dashboard.bootstrap.request.v1" }),
    });
    expect(denied.status).toBe(403);
    const bootstrapResponse = await fetch(`${url}/dashboard/api/v1/bootstrap`, {
      method: "POST", headers: bootstrapHeaders(), body: JSON.stringify({ schema: "dashboard.bootstrap.request.v1" }),
    });
    expect(bootstrapResponse.status).toBe(200);
    const bootstrap = await bootstrapResponse.json() as { bootstrap: string };

    const session = await fetch(`${url}/dashboard/api/v1/session`, {
      method: "POST",
      headers: {
        Accept: DASHBOARD_MEDIA_TYPE,
        "Content-Type": "application/json",
        Origin: url,
        "Sec-Fetch-Site": "same-origin",
      },
      body: JSON.stringify({ schema: "dashboard.session.request.v1", bootstrap: bootstrap.bootstrap }),
    });
    expect(session.status).toBe(200);
    const sessionBody = await session.json() as { session: string };
    const sessionHeaders = { Accept: DASHBOARD_MEDIA_TYPE, "X-LLM-Relay-Dashboard-Session": sessionBody.session, Origin: url };

    expect((await fetch(`${url}/dashboard/api/v1/snapshot?window=1h&includeRepair=0`, { headers: sessionHeaders })).status).toBe(200);
    expect((await fetch(`${url}/dashboard/api/v1/requests/request_123456789?includeRepair=0`, { headers: sessionHeaders })).status).toBe(404);
    const logout = await fetch(`${url}/dashboard/api/v1/logout`, {
      method: "POST",
      headers: { ...sessionHeaders, "Content-Type": "application/json", "Sec-Fetch-Site": "same-origin" },
      body: JSON.stringify({ schema: "dashboard.logout.request.v1" }),
    });
    expect(logout.status).toBe(204);
    expectDashboardHeaders(logout, "no-store");
    expect(await logout.text()).toBe("");
  });

  it("rejects an oversized dashboard write before generic buffering and never contacts an upstream", async () => {
    let upstreamCalls = 0;
    const backend = await listen(createServer((request, response) => {
      upstreamCalls += 1;
      request.resume();
      response.end("unexpected");
    }));
    const url = await boot((backend.address() as AddressInfo).port);
    const response = await fetch(`${url}/dashboard/api/v1/bootstrap`, {
      method: "POST",
      headers: bootstrapHeaders(),
      body: "x".repeat(16 * 1024 + 1),
    });
    expect(response.status).toBe(413);
    expect(upstreamCalls).toBe(0);
  });

  it("projects successful proxy accounting from the one store used for recording and reading", async () => {
    const backend = await listen(createServer((request, response) => {
      request.resume();
      response.writeHead(200, {
        "content-type": "application/json",
        "x-ratelimit-requests-limit-minute": "60",
        "x-ratelimit-requests-remaining-minute": "59",
      });
      response.end(JSON.stringify({ id: "msg_accounted", type: "message", role: "assistant", model: "m", stop_reason: "end_turn", content: [] }));
    }));
    const root = dashboardRoot();
    const store = createAccountingStore({ directory: join(root, "accounting") });
    stores.push(store);
    const proxy = await listen(createProxy(config((backend.address() as AddressInfo).port), {
      controlAuthorization: { validate: (token) => token === CONTROL },
      dashboardAssetRoot: root,
      accountingRecorder: store,
      accountingReader: store,
      dashboardRelayVersion: "production-wiring-test",
      dashboardAttributionPolicy: "include_all_labeled",
    }));
    const url = address(proxy);
    const proxied = await fetch(`${url}/v1/messages`, {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ model: "m", messages: [{ role: "user", content: "account this" }] }),
    });
    expect(proxied.status).toBe(200);
    await proxied.text();
    store.flush();
    const stored = store.readRecent();
    expect(stored.status).toBe("ok");
    if (stored.status === "ok") expect(stored.value).toHaveLength(1);

    const bootstrapResponse = await fetch(`${url}/dashboard/api/v1/bootstrap`, {
      method: "POST", headers: bootstrapHeaders(), body: JSON.stringify({ schema: "dashboard.bootstrap.request.v1" }),
    });
    const bootstrap = await bootstrapResponse.json() as { bootstrap: string };
    const sessionResponse = await fetch(`${url}/dashboard/api/v1/session`, {
      method: "POST",
      headers: { Accept: DASHBOARD_MEDIA_TYPE, "Content-Type": "application/json", Origin: url, "Sec-Fetch-Site": "same-origin" },
      body: JSON.stringify({ schema: "dashboard.session.request.v1", bootstrap: bootstrap.bootstrap }),
    });
    const session = await sessionResponse.json() as { session: string };
    const headers = { Accept: DASHBOARD_MEDIA_TYPE, Origin: url, "X-LLM-Relay-Dashboard-Session": session.session };
    const snapshotResponse = await fetch(`${url}/dashboard/api/v1/snapshot?window=lifetime&includeRepair=1`, { headers });
    expect(snapshotResponse.status).toBe(200);
    const snapshot = await snapshotResponse.json() as {
      relayVersion: string; attributionPolicy: string; summary: { requests: number; served: number }; recentRequests: Array<{ requestId: string }>;
      quotas: Array<{ provider: string; credentialId: string; limitBasis: string; remaining: number }>;
    };
    expect(snapshot.relayVersion).toBe("production-wiring-test");
    expect(snapshot.attributionPolicy).toBe("include_all_labeled");
    expect(snapshot.summary).toMatchObject({ requests: 1, served: 1 });
    expect(snapshot.recentRequests).toHaveLength(1);
    // The availability producer is server-wired: the proxied request above observed quota
    // headers on the backend response, so the Quota panel is no longer permanently empty.
    expect(snapshot.quotas.length).toBeGreaterThan(0);
    // This config routes through the anthropic default cell (model-less identity), so the
    // observation lands on a deployment-null row — still attributed to its credential.
    expect(snapshot.quotas[0]).toMatchObject({ provider: "up", credentialId: "up#default", limitBasis: "provider_stated", remaining: 59 });
    const detail = await fetch(`${url}/dashboard/api/v1/requests/${snapshot.recentRequests[0]!.requestId}?includeRepair=1`, { headers });
    expect(detail.status).toBe(200);
  });

  it("leaves proxy and control routes outside the dashboard namespace and strips dashboard sessions upstream", async () => {
    let sessionHeader: string | undefined;
    const backend = await listen(createServer((request, response) => {
      sessionHeader = request.headers["x-llm-relay-dashboard-session"] as string | undefined;
      request.resume();
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify({ id: "msg_1", type: "message", role: "assistant", model: "m", stop_reason: "end_turn", content: [] }));
    }));
    const url = await boot((backend.address() as AddressInfo).port);
    const request = await fetch(`${url}/v1/messages`, {
      method: "POST",
      headers: { "content-type": "application/json", "X-LLM-Relay-Dashboard-Session": "must-not-forward" },
      body: JSON.stringify({ model: "m", messages: [{ role: "user", content: "hello" }] }),
    });
    expect(request.status).toBe(200);
    expect(sessionHeader).toBeUndefined();
    expect((await fetch(`${url}/`)).status).not.toBe(404);
    for (const [path, body] of [
      ["/v1/chat/completions", { model: "m", messages: [{ role: "user", content: "hello" }] }],
      ["/v1/responses", { model: "m", input: "hello" }],
    ] as const) {
      expect((await fetch(`${url}${path}`, {
        method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body),
      })).status).not.toBe(404);
    }
    expect((await fetch(`${url}/telemetry`)).status).toBe(200);
    expect((await fetch(`${url}/health`, { headers: { [CONTROL_AUTHORIZATION_HEADER]: CONTROL } })).status).toBe(200);
  });

  it("writes one metadata log record per dashboard answer, carrying no token material", async () => {
    const dir = mkdtempSync(join(tmpdir(), "llm-relay-dashboard-log-"));
    directories.push(dir);
    const logFile = join(dir, "log.jsonl");
    const server = await listen(createProxy({ ...config(), log: { level: "metadata", file: logFile } }, {
      controlAuthorization: { validate: (token) => token === CONTROL },
      dashboardAssetRoot: dashboardRoot(),
    }));
    const url = address(server);

    // Static answer (200) and an unauthenticated API answer (401) — one record each.
    const page = await fetch(`${url}/dashboard/`, { method: "HEAD" });
    expect(page.status).toBe(200);
    const denied = await fetch(`${url}/dashboard/api/v1/snapshot?window=1h&includeRepair=0`, {
      headers: { Accept: DASHBOARD_MEDIA_TYPE },
    });
    expect(denied.status).toBe(401);
    await denied.arrayBuffer();

    // Mint a real session so the record can be checked against live token material.
    const bootstrapResponse = await fetch(`${url}/dashboard/api/v1/bootstrap`, {
      method: "POST", headers: bootstrapHeaders(), body: JSON.stringify({ schema: "dashboard.bootstrap.request.v1" }),
    });
    expect(bootstrapResponse.status).toBe(200);
    const bootstrap = (await bootstrapResponse.json()) as { bootstrap: string };
    const sessionResponse = await fetch(`${url}/dashboard/api/v1/session`, {
      method: "POST",
      headers: { Accept: DASHBOARD_MEDIA_TYPE, "Content-Type": "application/json", Origin: url, "Sec-Fetch-Site": "same-origin" },
      body: JSON.stringify({ schema: "dashboard.session.request.v1", bootstrap: bootstrap.bootstrap }),
    });
    expect(sessionResponse.status).toBe(200);
    const session = (await sessionResponse.json()) as { session: string };
    const snapshot = await fetch(`${url}/dashboard/api/v1/snapshot?window=1h&includeRepair=0`, {
      headers: { Accept: DASHBOARD_MEDIA_TYPE, "X-LLM-Relay-Dashboard-Session": session.session },
    });
    expect(snapshot.status).toBe(200);
    await snapshot.arrayBuffer();

    const records = jsonLines(logFile);
    expect(records.length).toBe(5);
    expect(records.map((record) => record.backendStatus)).toEqual([200, 401, 200, 200, 200]);
    for (const record of records) {
      expect(record.servedProvider).toBeNull();
      expect(record.validated).toBe("skipped");
      expect(String(record.path)).toMatch(/^\/dashboard(\/|$)/u);
    }
    // The two snapshot answers carried ?window=1h&includeRepair=0; logSafePath keeps
    // the parameter NAMES and replaces each value with its length.
    expect(String(records[1]!.path)).toContain("/snapshot?window=<2c>&includeRepair=<1c>");
    expect(String(records[4]!.path)).toContain("/snapshot?window=<2c>&includeRepair=<1c>");
    expect(JSON.stringify(records)).not.toContain("window=1h");
    const serialized = JSON.stringify(records);
    expect(serialized).not.toContain(session.session);
    expect(serialized).not.toContain(bootstrap.bootstrap);
  });
});
