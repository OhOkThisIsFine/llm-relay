import { afterEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { PingLoop } from "../src/ping/cadence.js";
import type { Config, ProviderConfig } from "../src/config.js";
import type { ModelCatalog } from "../src/catalog.js";

describe("PingLoop credential fleet rotation", () => {
  const envNames = ["PING_FLEET_ONE", "PING_FLEET_TWO"];
  afterEach(() => {
    for (const name of envNames) delete process.env[name];
  });

  it("alternates exact credentials across one-due-model ticks without extra probes", async () => {
    process.env.PING_FLEET_ONE = "one";
    process.env.PING_FLEET_TWO = "two";
    const provider: ProviderConfig = {
      base: "https://ping.test/v1",
      kind: "openai",
      authHeader: "authorization",
      timeoutMs: 1000,
      credentials: [
        { label: "one", authEnv: "PING_FLEET_ONE", models: ["m1"] },
        { label: "two", authEnv: "PING_FLEET_TWO", models: ["m2"] },
      ],
    };
    const cfg = {
      host: "127.0.0.1", port: 8791,
      providers: { p: provider },
      routing: { default: "p/m1", tiers: {} },
      mode: "detect",
      repair: { maxAttempts: 2, destructiveTools: [] },
      log: { level: "silent", file: null },
    } as unknown as Config;
    let listCall = 0;
    const catalog = {
      list: async () => [["m1"], ["m2"], ["m3"]][listCall++] ?? [],
    } as unknown as ModelCatalog;
    const authSeen: string[] = [];
    const fetchFn = (async (_url: string, init?: RequestInit) => {
      authSeen.push(new Headers(init?.headers).get("authorization") ?? "");
      return new Response(JSON.stringify({ choices: [{ message: { content: "ok" } }] }), { status: 200 });
    }) as unknown as typeof fetch;
    const cacheDir = mkdtempSync(join(tmpdir(), "relay-ping-fleet-"));
    try {
      const loop = new PingLoop(cfg, catalog, { fetchFn, probeCachePath: join(cacheDir, "probe-cache.json") });
      await loop.tickOnce("catalog");
      await loop.tickOnce("catalog");
      await loop.tickOnce("catalog");
      expect(authSeen).toEqual(["Bearer one", "Bearer two"]);
    } finally {
      rmSync(cacheDir, { recursive: true, force: true });
    }
  });
});
