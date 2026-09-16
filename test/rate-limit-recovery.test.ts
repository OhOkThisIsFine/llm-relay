import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { CircuitBreaker, COOLDOWN_SOURCES, globalCircuitBreaker } from "../src/circuit-breaker.js";
import {
  MAX_RATE_LIMIT_REPROBES_PER_TICK,
  PingLoop,
  RATE_LIMIT_REPROBE_INTERVAL_MS,
  type RateLimitRecoveryPort,
} from "../src/ping/cadence.js";
import { createProxy } from "../src/server.js";
import { CONTROL_AUTHORIZATION_HEADER } from "../src/control-authorization.js";
import { makeCredentialId } from "../src/credential-id.js";
import type { Config, ProviderConfig } from "../src/config.js";
import type { ModelCatalog } from "../src/catalog.js";
import type { ProviderTargetIdentity } from "../src/kernel/contracts.js";

/**
 * "A probe that answers 200 ends a rate-limit cooldown early" (backlog, owner direction
 * 2026-09-10: *"The relay should be polling to see if things start working again anyway."*).
 *
 * Three layers, pinned separately: the breaker's two total tables over `CooldownSource` (which
 * cooldowns a probe may END, which the loop SPENDS a probe on); the ping loop's hook and its
 * bounded re-probe cadence, against a stub port and against the real breaker; and the
 * `createProxy` wiring, through the admitted `GET /ping` route against a real listening backend.
 * Every positive case has a negative control beside it, because a hook that ended cooldowns
 * unconditionally would pass a test that only asserts the ending.
 */

const MINUTE = 60_000;

function cell(provider: string, model: string | null = "m", extra: Partial<ProviderTargetIdentity> = {}): ProviderTargetIdentity {
  return { provider, model, kind: "openai", credentialId: makeCredentialId(provider), ...extra };
}

let seq = 0;
function isolatedProbeCache(): string {
  return join(tmpdir(), `llm-relay-rlr-${process.pid}-${seq++}`, "probe-cache.json");
}

function cfgWith(providers: Record<string, ProviderConfig>): Config {
  return {
    host: "127.0.0.1",
    port: 0,
    providers,
    routing: { default: "p/m", tiers: {} },
    mode: "detect",
    repair: { maxAttempts: 2, destructiveTools: [] },
    log: { level: "silent", file: null },
  };
}

const openai = (base = "https://api.test/v1"): ProviderConfig => ({ base, kind: "openai", authHeader: "authorization", timeoutMs: 1000 });

describe("CircuitBreaker.endRateLimitCooldown — which cooldowns a 200 probe may end", () => {
  const now = 10 * MINUTE;

  it("ends the first unexplained 429's cooldown (source default) and the escalated ones", () => {
    const cb = new CircuitBreaker();
    cb.recordOutcome(cell("p"), { ok: false, status: 429, elapsedMs: 5, at: now });
    expect(cb.getState(cell("p"))!.cooldownSource).toBe("default");
    expect(cb.isHealthy(cell("p"), now + 1)).toBe(false);
    expect(cb.endRateLimitCooldown(cell("p"), now + 1)).toBe(true);
    expect(cb.isHealthy(cell("p"), now + 1)).toBe(true);
    expect(cb.getState(cell("p"))!.cooldownSource).toBeNull();

    cb.recordOutcome(cell("p"), { ok: false, status: 429, elapsedMs: 5, at: now + 2 });
    expect(cb.getState(cell("p"))!.cooldownSource).toBe("escalation");
    expect(cb.endRateLimitCooldown(cell("p"), now + 3)).toBe(true);
    expect(cb.isHealthy(cell("p"), now + 3)).toBe(true);
  });

  it("keeps the escalation ladder's index — the next REAL 429 still escalates", () => {
    // A probe is a one-token completion; only a real success resets what real traffic taught.
    const cb = new CircuitBreaker();
    cb.recordOutcome(cell("p"), { ok: false, status: 429, elapsedMs: 5, at: now });
    cb.endRateLimitCooldown(cell("p"), now + 1);
    expect(cb.getState(cell("p"))!.unexplained429s).toBe(1);
    cb.recordOutcome(cell("p"), { ok: false, status: 429, elapsedMs: 5, at: now + 2 });
    expect(cb.getState(cell("p"))!.cooldownUntil).toBe(now + 2 + 600_000);
  });

  it("ends a 429's stated Retry-After cooldown and a loopback 429's", () => {
    const cb = new CircuitBreaker();
    cb.recordOutcome(cell("p"), { ok: false, status: 429, elapsedMs: 5, at: now, retryAfterMs: 30_000 });
    expect(cb.getState(cell("p"))!.cooldownSource).toBe("retry-after");
    expect(cb.endRateLimitCooldown(cell("p"), now + 1)).toBe(true);
    cb.recordOutcome(cell("local", "m", { base: "http://127.0.0.1:11434" }), { ok: false, status: 429, elapsedMs: 5, at: now });
    expect(cb.getState(cell("local"))!.cooldownSource).toBe("loopback");
    expect(cb.endRateLimitCooldown(cell("local"), now + 1)).toBe(true);
  });

  it("leaves a 402's cooldown alone — same sources, different status", () => {
    const cb = new CircuitBreaker();
    cb.recordOutcome(cell("p"), { ok: false, status: 402, elapsedMs: 5, at: now });
    expect(cb.getState(cell("p"))!.cooldownSource).toBe("default");
    expect(cb.endRateLimitCooldown(cell("p"), now + 1)).toBe(false);
    expect(cb.isHealthy(cell("p"), now + 1)).toBe(false);
    cb.recordOutcome(cell("q"), { ok: false, status: 402, elapsedMs: 5, at: now, retryAfterMs: 30_000 });
    expect(cb.getState(cell("q"))!.cooldownSource).toBe("retry-after");
    expect(cb.endRateLimitCooldown(cell("q"), now + 1)).toBe(false);
  });

  it("leaves a generic-failure cooldown, a slow-failure cooldown and a quota cooldown alone", () => {
    const cb = new CircuitBreaker();
    cb.recordOutcome(cell("fast"), { ok: false, status: 500, elapsedMs: 5, at: now });
    cb.recordOutcome(cell("fast"), { ok: false, status: 500, elapsedMs: 5, at: now + 1 });
    expect(cb.getState(cell("fast"))!.cooldownSource).toBe("default");
    expect(cb.endRateLimitCooldown(cell("fast"), now + 2)).toBe(false);

    cb.recordOutcome(cell("slow"), { ok: false, status: 504, elapsedMs: 120_000, at: now });
    cb.recordOutcome(cell("slow"), { ok: false, status: 504, elapsedMs: 120_000, at: now + 1 });
    expect(cb.getState(cell("slow"))!.cooldownSource).toBe("elapsed");
    expect(cb.endRateLimitCooldown(cell("slow"), now + 2)).toBe(false);

    cb.recordQuotaCooldown(cell("quota"), now + MINUTE, now);
    expect(cb.getState(cell("quota"))!.cooldownSource).toBe("quota");
    expect(cb.endRateLimitCooldown(cell("quota"), now + 1)).toBe(false);
    expect(cb.isHealthy(cell("quota"), now + 1)).toBe(false);
  });

  it("a 429 cooldown later overwritten by a different failure is no longer a rate-limit cooldown", () => {
    const cb = new CircuitBreaker();
    cb.recordOutcome(cell("p"), { ok: false, status: 429, elapsedMs: 5, at: now });
    cb.recordOutcome(cell("p"), { ok: false, status: 500, elapsedMs: 5, at: now + 1 });
    expect(cb.getState(cell("p"))!.lastStatus).toBe(500);
    expect(cb.endRateLimitCooldown(cell("p"), now + 2)).toBe(false);
  });

  it("never touches a credential fault, an unknown cell, a lapsed cooldown or a sibling cell", () => {
    const cb = new CircuitBreaker();
    cb.recordCredentialFault(cell("p"), 401, now);
    expect(cb.endRateLimitCooldown(cell("p"), now + 1)).toBe(false);
    expect(cb.hasCredentialFault(cell("p"), now + 1)).toBe(true);
    expect(cb.endRateLimitCooldown(cell("nobody"), now)).toBe(false);
    cb.recordOutcome(cell("lapsed"), { ok: false, status: 429, elapsedMs: 5, at: now });
    expect(cb.endRateLimitCooldown(cell("lapsed"), now + 200_000)).toBe(false);
    cb.recordOutcome(cell("s"), { ok: false, status: 429, elapsedMs: 5, at: now });
    expect(cb.endRateLimitCooldown({ credentialId: makeCredentialId("s", "work"), model: "m" }, now + 1)).toBe(false);
    expect(cb.endRateLimitCooldown({ credentialId: makeCredentialId("s"), model: "other" }, now + 1)).toBe(false);
    expect(cb.isHealthy(cell("s"), now + 1)).toBe(false);
  });

  it("notifies persistence when it ends a cooldown, and only then", () => {
    const cb = new CircuitBreaker();
    let notified = 0;
    cb.onStateChanged(() => { notified += 1; });
    cb.recordOutcome(cell("p"), { ok: false, status: 429, elapsedMs: 5, at: now });
    const before = notified;
    expect(cb.endRateLimitCooldown(cell("p"), now + 1)).toBe(true);
    expect(notified).toBe(before + 1);
    expect(cb.endRateLimitCooldown(cell("p"), now + 2)).toBe(false);
    expect(notified).toBe(before + 1);
  });
});

describe("CircuitBreaker.rateLimitCoolingCells — which cooldowns the loop spends a probe on", () => {
  const now = 10 * MINUTE;

  it("lists cells on the relay's OWN guessed 429 rungs, soonest lift first", () => {
    const cb = new CircuitBreaker();
    cb.recordOutcome(cell("b"), { ok: false, status: 429, elapsedMs: 5, at: now });
    cb.recordOutcome(cell("b"), { ok: false, status: 429, elapsedMs: 5, at: now + 1 }); // escalation, 10 min
    cb.recordOutcome(cell("a"), { ok: false, status: 429, elapsedMs: 5, at: now + 2 }); // default, 2 min
    const cells = cb.rateLimitCoolingCells(now + 3);
    expect(cells.map((c) => [c.provider, c.source])).toEqual([["a", "default"], ["b", "escalation"]]);
    expect(cells[0]).toMatchObject({ model: "m", credentialId: makeCredentialId("a"), cooldownUntil: now + 2 + 120_000 });
  });

  it("excludes a stated Retry-After, a loopback rung, a quota cooldown, a slow failure, a 402 and a lapsed cooldown", () => {
    const cb = new CircuitBreaker();
    cb.recordOutcome(cell("ra"), { ok: false, status: 429, elapsedMs: 5, at: now, retryAfterMs: 30_000 });
    cb.recordOutcome(cell("lo", "m", { base: "http://localhost:1" }), { ok: false, status: 429, elapsedMs: 5, at: now });
    cb.recordQuotaCooldown(cell("q"), now + MINUTE, now);
    cb.recordOutcome(cell("sl"), { ok: false, status: 504, elapsedMs: 120_000, at: now });
    cb.recordOutcome(cell("sl"), { ok: false, status: 504, elapsedMs: 120_000, at: now + 1 });
    cb.recordOutcome(cell("pay"), { ok: false, status: 402, elapsedMs: 5, at: now });
    cb.recordOutcome(cell("old"), { ok: false, status: 429, elapsedMs: 5, at: now - 10 * MINUTE });
    expect(cb.rateLimitCoolingCells(now + 1)).toEqual([]);
  });

  it("both tables are TOTAL over CooldownSource and closed with `satisfies` — no fall-through", () => {
    const src = readFileSync(join(__dirname, "..", "src", "circuit-breaker.ts"), "utf8");
    for (const table of ["PROBE_SUCCESS_ENDS_COOLDOWN", "REPROBE_TARGETS_COOLDOWN"]) {
      const m = new RegExp(`const ${table} = \\{([\\s\\S]*?)\\} as const satisfies Record<CooldownSource, boolean>;`).exec(src);
      expect(m, `${table} must be a total table`).not.toBeNull();
      for (const source of COOLDOWN_SOURCES) {
        expect(m![1], `${table} names ${source}`).toMatch(new RegExp(`"${source}":\\s*(true|false)`));
      }
    }
  });
});

describe("PingLoop — a 200 probe ends the cell's 429 cooldown through the port", () => {
  const slot = makeCredentialId("p");

  function stubPort() {
    const ended: Array<{ cell: { credentialId: string; model: string | null }; at: number }> = [];
    const port: RateLimitRecoveryPort = {
      rateLimitCoolingCells: () => [],
      endRateLimitCooldown: (c, at) => { ended.push({ cell: c, at }); return true; },
    };
    return { port, ended };
  }

  it("calls endRateLimitCooldown with the exact credential × model and the probe's timestamp", () => {
    const { port, ended } = stubPort();
    const loop = new PingLoop(cfgWith({ p: openai() }), {} as ModelCatalog, { probeCachePath: isolatedProbeCache(), rateLimitRecovery: port });
    loop.recordPing("p", "m", { code: "200", ms: 1, quotaObservations: [] }, 4242, slot);
    expect(ended).toEqual([{ cell: { credentialId: slot, model: "m" }, at: 4242 }]);
  });

  // Negative control: an unconditional hook would pass the test above and retract a live
  // cooldown every time the probe FAILED — the exact inverse of the intent.
  it("does not call the port when the probe did not answer 200", () => {
    const { port, ended } = stubPort();
    const loop = new PingLoop(cfgWith({ p: openai() }), {} as ModelCatalog, { probeCachePath: isolatedProbeCache(), rateLimitRecovery: port });
    for (const code of ["429", "500", "401", "timeout"]) {
      loop.recordPing("p", "m", { code, ms: 1, quotaObservations: [] }, 1, slot);
    }
    expect(ended).toEqual([]);
  });

  it("a throwing port never breaks the probe loop, and no port means the old behaviour", () => {
    const boom: RateLimitRecoveryPort = {
      rateLimitCoolingCells: () => { throw new Error("boom"); },
      endRateLimitCooldown: () => { throw new Error("boom"); },
    };
    const loop = new PingLoop(cfgWith({ p: openai() }), {} as ModelCatalog, { probeCachePath: isolatedProbeCache(), rateLimitRecovery: boom });
    expect(() => loop.recordPing("p", "m", { code: "200", ms: 1, quotaObservations: [] }, 1, slot)).not.toThrow();
    const bare = new PingLoop(cfgWith({ p: openai() }), {} as ModelCatalog, { probeCachePath: isolatedProbeCache() });
    expect(() => bare.recordPing("p", "m", { code: "200", ms: 1, quotaObservations: [] }, 1, slot)).not.toThrow();
  });

  it("against the REAL breaker: a 429-cooled cell is healthy again after a 200 probe, a sibling is not", () => {
    const cb = new CircuitBreaker();
    const now = 10 * MINUTE;
    cb.recordOutcome(cell("p"), { ok: false, status: 429, elapsedMs: 5, at: now });
    cb.recordOutcome(cell("p", "other"), { ok: false, status: 429, elapsedMs: 5, at: now });
    const loop = new PingLoop(cfgWith({ p: openai() }), {} as ModelCatalog, { probeCachePath: isolatedProbeCache(), rateLimitRecovery: cb });
    loop.recordPing("p", "m", { code: "200", ms: 1, quotaObservations: [] }, now + 1, slot);
    expect(cb.isHealthy(cell("p"), now + 1)).toBe(true);
    expect(cb.isHealthy(cell("p", "other"), now + 1)).toBe(false);
  });
});

describe("PingLoop.reprobeRateLimited — bounded polling of the relay's own guessed rungs", () => {
  const catalog = { list: async () => [] } as unknown as ModelCatalog;

  function loopWith(cells: Array<{ provider: string; model: string | null; credentialId: string }>, providers: Record<string, ProviderConfig>) {
    const probed: string[] = [];
    const fetchFn = (async (_url: string, init?: RequestInit) => {
      probed.push(String((JSON.parse(String(init?.body)) as { model: string }).model));
      return new Response(JSON.stringify({ choices: [] }), { status: 200 });
    }) as unknown as typeof fetch;
    const port: RateLimitRecoveryPort = {
      rateLimitCoolingCells: () => cells.map((c) => ({ ...c, cooldownUntil: Number.MAX_SAFE_INTEGER })),
      endRateLimitCooldown: () => true,
    };
    const loop = new PingLoop(cfgWith(providers), catalog, { fetchFn, probeCachePath: isolatedProbeCache(), rateLimitRecovery: port });
    return { loop, probed };
  }

  it("probes at most MAX_RATE_LIMIT_REPROBES_PER_TICK cells per tick, in the port's order", async () => {
    const cells = ["m1", "m2", "m3", "m4", "m5"].map((model) => ({ provider: "p", model, credentialId: makeCredentialId("p") }));
    const { loop, probed } = loopWith(cells, { p: openai() });
    await loop.reprobeRateLimited(MINUTE);
    expect(MAX_RATE_LIMIT_REPROBES_PER_TICK).toBe(3);
    expect(probed).toEqual(["m1", "m2", "m3"]);
    // The next tick reaches the two the budget left, and none of the three inside their interval.
    await loop.reprobeRateLimited(MINUTE + 1_000);
    expect(probed).toEqual(["m1", "m2", "m3", "m4", "m5"]);
  });

  it("re-probes one cell no more than once per RATE_LIMIT_REPROBE_INTERVAL_MS", async () => {
    const { loop, probed } = loopWith([{ provider: "p", model: "m", credentialId: makeCredentialId("p") }], { p: openai() });
    await loop.reprobeRateLimited(MINUTE);
    await loop.reprobeRateLimited(MINUTE + RATE_LIMIT_REPROBE_INTERVAL_MS - 1);
    expect(probed).toEqual(["m"]);
    await loop.reprobeRateLimited(MINUTE + RATE_LIMIT_REPROBE_INTERVAL_MS);
    expect(probed).toEqual(["m", "m"]);
  });

  it("skips a model-less cell, a non-openai provider, an unknown provider and a slot that does not resolve", async () => {
    const anthropic: ProviderConfig = { base: "https://api.anthropic.test", kind: "anthropic", authHeader: "x-api-key", timeoutMs: 1000 };
    const { loop, probed } = loopWith(
      [
        { provider: "p", model: null, credentialId: makeCredentialId("p") },
        { provider: "anth", model: "claude", credentialId: makeCredentialId("anth") },
        { provider: "ghost", model: "m", credentialId: makeCredentialId("ghost") },
        { provider: "p", model: "m", credentialId: makeCredentialId("p", "nosuchslot") },
      ],
      { p: openai(), anth: anthropic },
    );
    await loop.reprobeRateLimited(MINUTE);
    expect(probed).toEqual([]);
  });

  it("does nothing without a port, and a throwing port is contained", async () => {
    let calls = 0;
    const fetchFn = (async () => { calls += 1; return new Response("{}", { status: 200 }); }) as unknown as typeof fetch;
    const bare = new PingLoop(cfgWith({ p: openai() }), catalog, { fetchFn, probeCachePath: isolatedProbeCache() });
    await bare.reprobeRateLimited(MINUTE);
    const boom = new PingLoop(cfgWith({ p: openai() }), catalog, {
      fetchFn,
      probeCachePath: isolatedProbeCache(),
      rateLimitRecovery: { rateLimitCoolingCells: () => { throw new Error("boom"); }, endRateLimitCooldown: () => true },
    });
    await expect(boom.reprobeRateLimited(MINUTE)).resolves.toBeUndefined();
    expect(calls).toBe(0);
  });

  it("against the REAL breaker: a guessed-rung cooldown ends within one tick; a stated Retry-After is honoured", async () => {
    const cb = new CircuitBreaker();
    const now = Date.now();
    cb.recordOutcome(cell("p"), { ok: false, status: 429, elapsedMs: 5, at: now });
    cb.recordOutcome(cell("p", "stated"), { ok: false, status: 429, elapsedMs: 5, at: now, retryAfterMs: 30_000 });
    const probed: string[] = [];
    const fetchFn = (async (_url: string, init?: RequestInit) => {
      probed.push(String((JSON.parse(String(init?.body)) as { model: string }).model));
      return new Response(JSON.stringify({ choices: [] }), { status: 200 });
    }) as unknown as typeof fetch;
    const loop = new PingLoop(cfgWith({ p: openai() }), catalog, { fetchFn, probeCachePath: isolatedProbeCache(), rateLimitRecovery: cb });
    await loop.reprobeRateLimited(now + 1);
    expect(probed).toEqual(["m"]);
    expect(cb.isHealthy(cell("p"), now + 2)).toBe(true);
    // The stated figure was neither re-probed nor ended: the provider's own number stands.
    expect(cb.isHealthy(cell("p", "stated"), now + 2)).toBe(false);
  });

  it("a probe that still 429s leaves the cooldown AND the escalation ladder exactly as they were", async () => {
    const cb = new CircuitBreaker();
    const now = Date.now();
    cb.recordOutcome(cell("p"), { ok: false, status: 429, elapsedMs: 5, at: now });
    const before = { ...cb.getState(cell("p"))! };
    const fetchFn = (async () => new Response("{}", { status: 429 })) as unknown as typeof fetch;
    const loop = new PingLoop(cfgWith({ p: openai() }), catalog, { fetchFn, probeCachePath: isolatedProbeCache(), rateLimitRecovery: cb });
    await loop.reprobeRateLimited(now + 1);
    const after = cb.getState(cell("p"))!;
    expect(after.cooldownUntil).toBe(before.cooldownUntil);
    expect(after.unexplained429s).toBe(before.unexplained429s);
    expect(after.consecutiveFailures).toBe(before.consecutiveFailures);
  });
});

describe("createProxy wiring — GET /ping re-probes a 429-cooled cell and ends its cooldown", () => {
  const servers: Server[] = [];
  beforeEach(() => globalCircuitBreaker.reset());
  afterEach(async () => {
    await Promise.all(servers.splice(0).map((s) => new Promise((r) => s.close(r))));
    globalCircuitBreaker.reset();
  });

  function backend(status: number): Promise<{ server: Server; calls: () => number }> {
    let n = 0;
    return new Promise((resolve) => {
      const s = createServer((req, res) => {
        req.on("data", () => {});
        req.on("end", () => {
          n += 1;
          res.writeHead(status, { "content-type": "application/json" });
          res.end(JSON.stringify({ choices: [] }));
        });
      });
      s.listen(0, "127.0.0.1", () => { servers.push(s); resolve({ server: s, calls: () => n }); });
    });
  }

  it.each([
    { name: "a backend that answers 200 ends the cooldown", status: 200, healthyAfter: true },
    { name: "a backend that still 429s leaves it cooling", status: 429, healthyAfter: false },
  ])("$name", async ({ status, healthyAfter }) => {
    const b = await backend(status);
    const base = `http://127.0.0.1:${(b.server.address() as AddressInfo).port}`;
    const cfg = cfgWith({ p: { base, kind: "openai", authHeader: "authorization", timeoutMs: 2000 } });
    const controlToken = "rlr-control-token";
    const proxy = createProxy(cfg, {
      catalog: { list: async () => [] } as unknown as ModelCatalog,
      breaker: globalCircuitBreaker,
      controlAuthorization: { validate: (candidate) => candidate === controlToken },
    });
    servers.push(proxy);
    await new Promise<void>((resolve) => proxy.listen(0, "127.0.0.1", () => resolve()));
    const p = (proxy.address() as AddressInfo).port;

    const target = cell("p");
    globalCircuitBreaker.recordOutcome(target, { ok: false, status: 429, elapsedMs: 5, at: Date.now() });
    expect(globalCircuitBreaker.isHealthy(target)).toBe(false);

    const ping = await fetch(`http://127.0.0.1:${p}/ping`, { headers: { [CONTROL_AUTHORIZATION_HEADER]: controlToken } });
    expect(ping.status).toBe(200);
    await ping.text();
    expect(b.calls()).toBe(1);
    expect(globalCircuitBreaker.isHealthy(target)).toBe(healthyAfter);
  });
});
