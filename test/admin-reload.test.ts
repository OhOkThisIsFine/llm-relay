import { afterAll, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { loadConfig, configStaleness, type Config } from "../src/config.js";
import { createProxy } from "../src/server.js";
import { ModelCatalog } from "../src/catalog.js";
import { CONTROL_AUTHORIZATION_HEADER } from "../src/control-authorization.js";

const token = "reload-test-control-token";
const dir = mkdtempSync(join(tmpdir(), "llm-relay-reload-"));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

let sequence = 0;
function pathFor(): string {
  sequence += 1;
  return join(dir, `config-${sequence}.json`);
}

function document(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    listen: "127.0.0.1:8791",
    providers: {
      p: {
        base: "https://provider.test/v1",
        kind: "openai",
        timeoutMs: 120_000,
      },
    },
    routing: { default: "p/model-a", benchmarkSort: false },
    mode: "detect",
    log: { level: "silent", file: null },
    ...overrides,
  };
}

function write(path: string, body: Record<string, unknown>): void {
  writeFileSync(path, JSON.stringify(body, null, 2) + "\n", "utf8");
}

async function withProxy<T>(
  cfg: Config,
  reloadConfig: (() => Config) | null | undefined,
  fn: (base: string) => Promise<T>,
): Promise<T> {
  const proxy = createProxy(cfg, {
    catalog: new ModelCatalog({ cachePath: null }),
    controlAuthorization: { validate: (candidate) => candidate === token },
    ...(reloadConfig === undefined ? {} : { reloadConfig }),
  });
  await new Promise<void>((resolve) => proxy.listen(0, "127.0.0.1", resolve));
  const { port } = proxy.address() as { port: number };
  try {
    return await fn(`http://127.0.0.1:${port}`);
  } finally {
    await new Promise<void>((resolve) => proxy.close(() => resolve()));
  }
}

function postReload(base: string, body: unknown = {}, authorized = true): Promise<Response> {
  return fetch(`${base}/reload`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      ...(authorized ? { [CONTROL_AUTHORIZATION_HEADER]: token } : {}),
    },
    body: JSON.stringify(body),
  });
}

async function advertisedModels(base: string): Promise<string[]> {
  const response = await fetch(`${base}/v1/models`);
  expect(response.status).toBe(200);
  const body = await response.json() as { data?: Array<{ id?: string }> };
  return (body.data ?? []).map((entry) => entry.id ?? "");
}

describe("POST /reload", () => {
  it("atomically applies reloadable provider/routing changes to the same running proxy", async () => {
    const path = pathFor();
    write(path, document());
    const cfg = loadConfig(path);
    const identity = cfg;
    const providerIdentity = cfg.providers.p;

    await withProxy(cfg, () => loadConfig(path), async (base) => {
      expect(await advertisedModels(base)).toContain("p/model-a");

      write(path, document({
        providers: {
          p: {
            base: "https://provider.test/v1",
            kind: "openai",
            timeoutMs: 30_000,
          },
        },
        routing: { default: "p/model-b", benchmarkSort: false },
      }));

      const response = await postReload(base);
      expect(response.status).toBe(200);
      const body = await response.json() as {
        reloaded?: boolean;
        changed?: string[];
        warnings?: string[];
      };
      expect(body.reloaded).toBe(true);
      expect(body.changed).toContain("providers.p.timeoutMs");
      expect(body.changed).toContain("routing.default");
      expect(body.warnings).toEqual([]);

      expect(cfg).toBe(identity);
      expect(cfg.providers.p).toBe(providerIdentity);
      expect(cfg.providers.p?.timeoutMs).toBe(30_000);
      expect(cfg.routing.default).toBe("p/model-b");
      expect(configStaleness(cfg).changedOnDisk).toBe(false);
      const models = await advertisedModels(base);
      expect(models).toContain("p/model-b");
      expect(models).not.toContain("p/model-a");
    });
  });

  it("returns 409 and applies nothing when a restart-only change accompanies a reloadable one", async () => {
    const path = pathFor();
    write(path, document());
    const cfg = loadConfig(path);

    await withProxy(cfg, () => loadConfig(path), async (base) => {
      write(path, document({
        providers: {
          p: {
            base: "https://different-provider.test/v1",
            kind: "openai",
            timeoutMs: 25_000,
          },
        },
        routing: { default: "p/model-b", benchmarkSort: false },
      }));

      const response = await postReload(base);
      expect(response.status).toBe(409);
      const body = await response.json() as {
        requiresRestart?: string[];
        error?: { message?: string };
      };
      expect(body.requiresRestart).toContain("providers.p.base");
      expect(body.error?.message).toContain("restart");
      expect(cfg.providers.p?.base).toBe("https://provider.test/v1");
      expect(cfg.providers.p?.timeoutMs).toBe(120_000);
      expect(cfg.routing.default).toBe("p/model-a");
      expect(configStaleness(cfg).changedOnDisk).toBe(true);
    });
  });

  it("returns 400 on loader/validation failure and preserves the old config", async () => {
    const path = pathFor();
    write(path, document());
    const cfg = loadConfig(path);

    await withProxy(cfg, () => {
      throw new Error("candidate parse detail must not be returned");
    }, async (base) => {
      const response = await postReload(base);
      expect(response.status).toBe(400);
      const text = await response.text();
      expect(text).toContain("failed validation");
      expect(text).not.toContain("candidate parse detail");
      expect(cfg.routing.default).toBe("p/model-a");
    });
  });

  it("requires the existing control token before invoking the loader", async () => {
    const path = pathFor();
    write(path, document());
    const cfg = loadConfig(path);
    let calls = 0;

    await withProxy(cfg, () => {
      calls += 1;
      return loadConfig(path);
    }, async (base) => {
      const response = await postReload(base, {}, false);
      expect(response.status).toBe(403);
    });
    expect(calls).toBe(0);
  });

  it("fails closed when an embed has no reload loader", async () => {
    const path = pathFor();
    write(path, document());
    const cfg = loadConfig(path);

    await withProxy(cfg, undefined, async (base) => {
      const response = await postReload(base);
      expect(response.status).toBe(503);
      expect(await response.text()).toContain("no config reload handler");
    });
  });

  it("accepts no request properties and does not let GET fall through to model routing", async () => {
    const path = pathFor();
    write(path, document());
    const cfg = loadConfig(path);
    let calls = 0;

    await withProxy(cfg, () => {
      calls += 1;
      return loadConfig(path);
    }, async (base) => {
      const unknown = await postReload(base, { path: "other.json" });
      expect(unknown.status).toBe(400);
      expect(await unknown.text()).not.toContain("other.json");

      const get = await fetch(`${base}/reload`, {
        headers: { [CONTROL_AUTHORIZATION_HEADER]: token },
      });
      expect(get.status).toBe(404);
    });
    expect(calls).toBe(0);
  });
});
