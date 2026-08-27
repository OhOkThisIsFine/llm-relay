/**
 * G2's manual per-credential HARD CAP — the operator-declared ceiling that REFUSES.
 *
 * The demotion term (`quota-demotion.test.ts`) covers everything DERIVED: it may only demote.
 * This file pins its complement — an explicit `limits.hard` block refuses before egress, and
 * only ever on a figure the operator wrote plus this relay's own ledger reading. Pinned here:
 * the pure resolver's gates (inclusive comparison, unknown-usage-means-silent, minute/day-only,
 * switch-off), the walk boundary on BOTH fronts (a capped attempt is skipped without a single
 * provider byte, announced in pool-attempts, and an all-capped walk is refused loudly), the
 * candidates surface, and config validation. Every multi-candidate scenario uses >= 2
 * candidates — with one, "fails over correctly" and "cannot fail over" are the same observation
 * (the pool-failover lesson).
 */
import { describe, it, expect, beforeEach, afterEach, afterAll } from "vitest";
import { createServer, type Server } from "node:http";
import { AddressInfo } from "node:net";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createProxy, orderByUsability, type ProxyDeps } from "../src/server.js";
import { ModelCatalog } from "../src/catalog.js";
import { CircuitBreaker, globalCircuitBreaker } from "../src/circuit-breaker.js";
import {
  HARD_CAP_HEADER,
  POOL_ATTEMPTS_HEADER,
  SERVED_BY_HEADER,
} from "../src/backend.js";
import { buildCandidates } from "../src/candidates.js";
import { createHardCapLedgerReader, evaluateHardCap, hardCapLabel } from "../src/hard-cap.js";
import { resolveConfiguredLimits } from "../src/configured-limits.js";
import { loadConfig } from "../src/config.js";
import { resetFacts } from "../src/target-facts.js";
import { resetInterpretations } from "../src/refusal-interpretation.js";
import { createAccountingRequest } from "../src/accounting.js";
import { createAccountingStore, type UsedInWindowOptions } from "../src/accounting-store.js";
import { resolveAttempt } from "../src/resolved-attempt.js";
import type { Config, ProviderConfig } from "../src/config.js";

// ── Pure resolver ────────────────────────────────────────────────────────────────────────────────

const MINUTE = 60_000;
/** One UTC day in ms — the day-window assertions use it to pin the derived boundary. */
const DAY_MS = 86_400_000;

function baseCfg(routingExtra: Record<string, unknown> = {}, providerExtra: Partial<ProviderConfig> = {}): Config {
  const mk = (base: string): ProviderConfig => ({
    base,
    kind: "openai",
    authHeader: "authorization",
    timeoutMs: 1000,
    ...providerExtra,
  });
  return {
    host: "127.0.0.1",
    port: 0,
    providers: { a: mk("http://a"), b: mk("http://b") },
    routing: {
      default: "a/m",
      tiers: {},
      benchmarkSort: false,
      ...routingExtra,
    },
    mode: "detect",
    repair: { maxAttempts: 2, destructiveTools: [] },
    log: { level: "silent", file: null },
  };
}

const t = (n: string): Parameters<typeof resolveAttempt>[0] => ({
  provider: n,
  base: `http://${n}`,
  kind: "openai",
  model: "m",
  authHeader: "authorization",
  timeoutMs: 1000,
});

/** A usedInWindow stub whose readings are period-aware, so a crossing minute lifts the cap. */
function ledger(usage: Partial<Record<"requests" | "tokens", number | null>> = {}) {
  return () => ({
    value: usage.requests !== undefined ? usage.requests : usage.tokens ?? null,
    basis: usage.requests === null ? null : ("reported" as const),
  });
}

describe("evaluateHardCap — the pure gates", () => {
  const now = Math.floor(Date.now() / MINUTE) * MINUTE + 30_000;

  it("refuses when the inclusive boundary is reached (used == cap) and admits cap-1", () => {
    // A cap of 450 admits 450 requests; the 451st is refused. Both sides of the boundary.
    const atCap = baseCfg({}, { limits: { hard: { rpd: 450 } } });
    const reached = evaluateHardCap({
      cfg: atCap,
      provider: "a",
      credentialLabel: null,
      model: "m",
      usedInWindow: ledger({ requests: 450 }),
      now,
    });
    expect(reached).not.toBeNull();
    expect(reached!.cap).toBe(450);
    expect(reached!.used).toBe(450);
    expect(reached!.axis).toBe("requests");
    expect(reached!.period).toBe("day");

    const below = evaluateHardCap({
      cfg: atCap,
      provider: "a",
      credentialLabel: null,
      model: "m",
      usedInWindow: ledger({ requests: 449 }),
      now,
    });
    expect(below).toBeNull();
  });

  it("unknown usage yields null — a guess must not refuse", () => {
    const cfg = baseCfg({}, { limits: { hard: { rpd: 1 } } });
    expect(
      evaluateHardCap({
        cfg,
        provider: "a",
        credentialLabel: null,
        model: "m",
        usedInWindow: () => ({ value: null, basis: null }),
        now,
      }),
    ).toBeNull();
    // An empty stub (nothing measured on either axis) behaves identically.
    expect(
      evaluateHardCap({
        cfg,
        provider: "a",
        credentialLabel: null,
        model: "m",
        usedInWindow: () => ({ value: null, basis: null }),
        now,
        // (same input shape the server builds when no store was handed in)
      }),
    ).toBeNull();
  });

  it("hardCaps:false turns every cap into an ordinary soft limit", () => {
    const cfg = baseCfg(
      { quota: { hardCaps: false } },
      { limits: { rpm: 40, hard: { rpd: 1 } } },
    );
    expect(
      evaluateHardCap({
        cfg,
        provider: "a",
        credentialLabel: null,
        model: "m",
        usedInWindow: ledger({ requests: 999 }),
        now,
      }),
    ).toBeNull();
  });

  it("resolves the credential ladder most-specific-first and labels each source", () => {
    const cfg: Config = {
      ...baseCfg(),
      providers: {
        a: {
          base: "http://a",
          kind: "openai",
          authHeader: "authorization",
          timeoutMs: 1000,
          limits: { rpd: 1000, hard: { rpd: 900, tpd: 5_000_000 } },
          credentials: [{ label: "s1", authEnv: "A_1", limits: { hard: { rpd: 450 } } }],
        },
        b: baseCfg().providers.b!,
      },
    };
    const slot = evaluateHardCap({
      cfg,
      provider: "a",
      credentialLabel: "s1",
      model: null,
      // Tokens far under the provider cap; requests over the SLOT cap — the narrower figure wins.
      usedInWindow: ledger({ requests: 450, tokens: 10 }),
      now,
    })!;
    expect(slot.cap).toBe(450);
    expect(slot.axis).toBe("requests");
    expect(slot.period).toBe("day");

    const resolved = resolveConfiguredLimits(cfg, "a", "s1", null)!;
    expect(resolved.hard).toEqual({ rpd: 450, tpd: 5_000_000 });
    expect(resolved.hardSource).toEqual({ rpd: "credential", tpd: "provider" });

    // A model override beats the flat blocks on that axis only.
    const both: Config = {
      ...cfg,
      providers: {
        ...cfg.providers,
        a: {
          ...cfg.providers.a!,
          limits: {
            ...cfg.providers.a!.limits!,
            hard: { rpd: 900 },
            models: { m2: { hard: { rpd: 700 } } },
          },
        },
      },
    };
    expect(resolveConfiguredLimits(both, "a", null, "m2")?.hard?.rpd).toBe(700); // model beat flat
    expect(resolveConfiguredLimits(both, "a", null, "m2")?.hardSource?.rpd).toBe("provider-model");
  });

  it("reads a PER-DEPLOYMENT cap at deployment scope and a FLAT cap at credential scope", () => {
    // The defect this pins: reading `limits.models.<id>.hard` against the credential's usage
    // across every model refuses `m` for requests spent entirely on `m2` — a false refusal on an
    // operator-declared number. Scope comes from the declaration site, never from the caller.
    const reads: Array<[string, string, string]> = [];
    const split: Parameters<typeof evaluateHardCap>[0]["usedInWindow"] = (axis, period, scope) => {
      reads.push([axis, period, scope]);
      // 9 requests on this credential this day; none of them on `m`.
      return scope === "credential"
        ? { value: 9, basis: "reported" as const }
        : { value: 0, basis: "reported" as const };
    };

    const perModel = baseCfg({}, { limits: { models: { m: { hard: { rpd: 2 } } } } });
    expect(
      evaluateHardCap({ cfg: perModel, provider: "a", credentialLabel: null, model: "m", usedInWindow: split, now }),
    ).toBeNull();
    // It never even asked the credential-wide question — the wider figure is not evidence here.
    expect(reads).toEqual([["requests", "day", "deployment"]]);

    // The SAME ledger under a flat cap does refuse: that ceiling bounds the whole credential.
    reads.length = 0;
    const flat = baseCfg({}, { limits: { hard: { rpd: 2 } } });
    const verdict = evaluateHardCap({
      cfg: flat, provider: "a", credentialLabel: null, model: "m", usedInWindow: split, now,
    })!;
    expect(reads).toEqual([["requests", "day", "credential"]]);
    expect(verdict.used).toBe(9);
    expect(verdict.scope).toBe("credential");
    expect(verdict.source).toBe("provider");
    // Provenance travels with the figure: a cap is an assertion, its reset a derived boundary.
    expect(verdict.basis).toBe("operator-declared");
    expect(verdict.resetsAtBasis).toBe("derived-boundary");
  });

  it("labels a slot-level per-model cap credential-model, and still reads it at deployment scope", () => {
    const cfg: Config = {
      ...baseCfg(),
      providers: {
        ...baseCfg().providers,
        a: {
          base: "http://a",
          kind: "openai",
          authHeader: "authorization",
          timeoutMs: 1000,
          limits: { hard: { rpd: 100 } },
          credentials: [{ label: "s1", authEnv: "A_1", limits: { models: { m: { hard: { rpd: 2 } } } } }],
        },
      },
    };
    const verdict = evaluateHardCap({
      cfg,
      provider: "a",
      credentialLabel: "s1",
      model: "m",
      // Deployment usage is over the narrow cap; credential-wide usage is under the flat one.
      usedInWindow: (_axis, _period, scope) =>
        scope === "deployment" ? { value: 5, basis: "reported" } : { value: 5, basis: "reported" },
      now,
    })!;
    expect(verdict.cap).toBe(2);
    expect(verdict.source).toBe("credential-model");
    expect(verdict.scope).toBe("deployment");
  });

  it("compares each axis against ITS OWN window — a requests reading never meets a token cap", () => {
    // rpd reached exactly; tokens wildly over tpd but that axis undeclared ⇒ no verdict from it.
    const cfg = baseCfg({}, { limits: { hard: { rpd: 5 } } });
    const v = evaluateHardCap({
      cfg,
      provider: "a",
      credentialLabel: null,
      model: "m",
      usedInWindow: (axis) =>
        axis === "requests"
          ? { value: 5, basis: "reported" as const }
          : { value: 99_999_999, basis: "estimated" as const },
      now,
    })!;
    expect(v.axis).toBe("requests");
    expect(v.used).toBe(5);
  });

  it("renders a bounded metadata-only label", () => {
    const cfg = baseCfg({}, { limits: { hard: { rpd: 450 } } });
    const v = evaluateHardCap({
      cfg, provider: "a", credentialLabel: null, model: "m", usedInWindow: ledger({ requests: 450 }), now,
    })!;
    expect(hardCapLabel("k1", "nim/glm", v)).toBe("k1/nim/glm requests/day 450/450");
    expect(hardCapLabel(null, "nim/glm", v)).toBe("-/nim/glm requests/day 450/450");
  });
});

// ── Config surface ───────────────────────────────────────────────────────────────────────────────

describe("limits.hard config parsing", () => {
  const dir = mkdtempSync(join(tmpdir(), "rp-hard-cap-"));
  afterAll(() => rmSync(dir, { recursive: true, force: true }));

  function load(name: string, providers: Record<string, unknown>, routingExtra: Record<string, unknown> = {}) {
    const p = join(dir, name);
    writeFileSync(p, JSON.stringify({
      listen: "127.0.0.1:8791",
      providers,
      routing: { default: "nim/m", ...routingExtra },
    }));
    return loadConfig(p);
  }

  it("accepts hard blocks at provider level, slot level and inside models overrides", () => {
    const cfg = load("ok.json", {
      nim: {
        base: "https://nim.test/v1",
        kind: "openai",
        limits: {
          rpm: 40,
          hard: { rpd: 900 },
          models: { "z-ai/glm-5.2": { rpm: 10, hard: { rpd: 700 } } },
        },
        credentials: [
          { label: "a", authEnv: "NIM_A", limits: { rpd: 500, hard: { rpd: 450, tpd: 2_000_000 } } },
        ],
      },
    });
    const resolved = resolveConfiguredLimits(cfg, "nim", "a", null)!;
    expect(resolved.hard).toEqual({ rpd: 450, tpd: 2_000_000 });
    expect(resolveConfiguredLimits(cfg, "nim", null, "z-ai/glm-5.2")?.hard?.rpd).toBe(700);
  });

  it("rejects month/hour spellings BY NAME rather than silently bounding nothing", () => {
    // The ledger's window read declines month, so such a cap could never fire — config load
    // refuses it instead of letting the operator believe the lane is bounded.
    expect(() => load("mpd.json", {
      nim: { base: "https://nim.test/v1", kind: "openai", limits: { hard: { mpd: 5 } } },
    })).toThrow(/not a known hard-cap axis/);
    expect(() => load("mph.json", {
      nim: { base: "https://nim.test/v1", kind: "openai", credentials: [
        { label: "a", authEnv: "NIM_A", limits: { hard: { mph: 5 } } },
      ] },
    })).toThrow(/not a known hard-cap axis/);
  });

  it("rejects non-positive and non-integer figures with the offending key named", () => {
    expect(() => load("zero.json", {
      nim: { base: "https://nim.test/v1", kind: "openai", limits: { hard: { rpd: 0 } } },
    })).toThrow(/hard\.rpd must be a positive integer/);
    expect(() => load("frac.json", {
      nim: { base: "https://nim.test/v1", kind: "openai", limits: { hard: { tpm: 1.5 } } },
    })).toThrow(/hard\.tpm must be a positive integer/);
  });

  it("rejects a nested hard inside hard and unknown keys inside model entries", () => {
    expect(() => load("nested.json", {
      nim: { base: "https://nim.test/v1", kind: "openai", limits: { hard: { hard: { rpd: 5 } } as never } },
    })).toThrow(/not a known hard-cap axis/);
    expect(() => load("modelkey.json", {
      nim: {
        base: "https://nim.test/v1", kind: "openai",
        limits: { hard: { models: { "m/x": { weekly: 5 } } } },
      },
    })).toThrow(/not a known hard-cap axis/);
  });

  // `routing.quota.hardCaps` parsing/validation lives with its siblings in test/config.test.ts
  // ("loadConfig — routing.quota.hardCaps"), beside `enforce`/`enforceLearned`; what it DOES to a
  // request is pinned below and in the end-to-end block.
});

// ── End to end: both fronts ──────────────────────────────────────────────────────────────────────

const servers: Server[] = [];
function track(s: Server): Server {
  servers.push(s);
  return s;
}
function port(s: Server): number {
  return (s.address() as AddressInfo).port;
}

/** A backend whose every response is scripted, recording how many times it was called. */
function scripted(
  reply: (n: number) => { status?: number; headers?: Record<string, string>; body: string },
): Promise<{ server: Server; calls: () => number }> {
  let n = 0;
  return new Promise((resolve) => {
    const s = createServer((req, res) => {
      req.on("data", () => {});
      req.on("end", () => {
        const out = reply(++n);
        res.writeHead(out.status ?? 200, { "content-type": "application/json", ...out.headers });
        res.end(out.body);
      });
    });
    s.listen(0, "127.0.0.1", () => resolve({ server: track(s), calls: () => n }));
  });
}

function okBody(kind: "anthropic" | "openai", model: string): string {
  return kind === "anthropic"
    ? JSON.stringify({ id: "msg", type: "message", role: "assistant", model, content: [{ type: "text", text: "ok" }], stop_reason: "end_turn", usage: { input_tokens: 1, output_tokens: 1 } })
    : JSON.stringify({ id: "cmpl", object: "chat.completion", choices: [{ message: { role: "assistant", content: "ok" }, finish_reason: "stop" }] });
}

/**
 * Two-member pool, one credential SLOT per member so a slot-scoped `hard` block can cap p1
 * alone. `benchmarkSort: false` keeps CONFIG order, so the assertions are about failover, not
 * whatever the synced snapshot ranks higher today.
 *
 * `capOn` picks the DECLARATION SITE, which is also the usage scope the cap is read at:
 * `credential` writes a flat `limits.hard`, `model` writes `limits.models.m<i>.hard`.
 */
function poolCfg(
  bases: string[],
  kind: "anthropic" | "openai",
  capEverySlot = false,
  capOn: "credential" | "model" = "credential",
): Config {
  // Both slots declare this var and it IS set — an unset authEnv would remove both candidates in
  // `resolveTargets` before the walk ever ran, which would test slot resolution, not caps.
  process.env.HARD_CAP_TEST_KEY = "unused-by-the-scripted-backends";
  const providers: Record<string, ProviderConfig> = {};
  bases.forEach((base, i) => {
    const cap = { rpd: 1 };
    providers[`p${i + 1}`] = {
      base,
      kind,
      authHeader: "authorization",
      timeoutMs: 5000,
      credentials: [{
        label: i === 0 ? "capped" : "spare",
        authEnv: "HARD_CAP_TEST_KEY",
        ...(i === 0 || capEverySlot
          ? {
              limits:
                capOn === "model"
                  ? { models: { [`m${i + 1}`]: { hard: cap } } }
                  : { hard: cap },
            }
          : {}),
      }],
    };
  });
  return {
    host: "127.0.0.1",
    port: 0,
    providers,
    routing: {
      default: "pool/coding",
      tiers: {},
      benchmarkSort: false,
      pools: { coding: bases.map((_, i) => `p${i + 1}/m${i + 1}`) },
    },
    mode: "detect",
    repair: { maxAttempts: 2, destructiveTools: [] },
    log: { level: "silent", file: null },
  };
}

async function post(p: number, kind: "anthropic" | "openai"): Promise<Response> {
  const path = kind === "anthropic" ? "/v1/messages" : "/v1/chat/completions";
  const body =
    kind === "anthropic"
      ? { model: "pool/coding", max_tokens: 20, messages: [{ role: "user", content: "hi" }] }
      : { model: "pool/coding", messages: [{ role: "user", content: "hi" }] };
  return fetch(`http://127.0.0.1:${p}${path}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

function startProxy(c: Config, deps: ProxyDeps = {}): Promise<Server> {
  const s = createProxy(c, { catalog: new ModelCatalog({ cachePath: null }), breaker: globalCircuitBreaker, ...deps });
  return new Promise((r) => s.listen(0, "127.0.0.1", () => r(track(s))));
}

beforeEach(() => {
  globalCircuitBreaker.reset();
  resetFacts();
  resetInterpretations();
});
afterEach(async () => {
  await Promise.all(servers.splice(0).map((s) => new Promise((r) => s.close(r))));
  globalCircuitBreaker.reset();
  resetFacts();
  resetInterpretations();
});
// `poolCfg` sets HARD_CAP_TEST_KEY so the slots resolve; process env is shared across the whole
// vitest worker, so put it back rather than leaking a fake key into whatever runs next.
const priorHardCapTestKey = process.env.HARD_CAP_TEST_KEY;
afterAll(() => {
  if (priorHardCapTestKey === undefined) delete process.env.HARD_CAP_TEST_KEY;
  else process.env.HARD_CAP_TEST_KEY = priorHardCapTestKey;
});

describe("G2 end to end — both fronts", () => {
  /**
   * A store-backed proxy whose ledger says each named credential spent N requests in the current
   * UTC DAY. The day window is deliberately chosen over minute: a minute boundary can cross
   * mid-test and silently un-cap a candidate halfway through an assertion.
   *
   * A value may name the MODEL those requests were spent on — the whole point of the scope tests,
   * since a per-deployment cap must not see usage that belongs to a sibling deployment.
   */
  function cappedLedger(
    perCredential: Record<string, number | { count: number; model: string }>,
  ): Pick<ProxyDeps, "accountingReader"> & { close(): void } {
    let requestSequence = 0;
    let attemptSequence = 0;
    const requestId = (): string => `request-${(++requestSequence).toString().padStart(16, "0")}`;
    const attemptId = (): string => `attempt-${(++attemptSequence).toString().padStart(12, "0")}`;
    const startedAt = new Date().toISOString();
    const events: unknown[] = [];
    const recorder = { record(event: unknown): void { events.push(event); } };
    for (const [credentialId, spec] of Object.entries(perCredential)) {
      const [provider] = credentialId.split("#");
      const n = typeof spec === "number" ? spec : spec.count;
      const model = typeof spec === "number" ? `${provider}1` : spec.model;
      for (let i = 0; i < n; i++) {
        const request = createAccountingRequest({
          recorder,
          idFactory: attemptId,
          requestId: requestId(),
          startedAt,
          client: "claude",
          attribution: "relay_held",
        });
        const attempt = request.startAttempt({
          role: "serve",
          startedAt,
          attribution: "relay_held",
          provider: provider ?? null,
          model,
          credentialId,
        });
        attempt.complete({ outcome: "success", endedAt: startedAt, latencyMs: 1 });
        request.complete({ endedAt: startedAt });
      }
    }
    // Feed the recorded events through a REAL store so the window read is the production one.
    const store = createAccountingStore({ directory: join(mkdtempSync(join(tmpdir(), "rp-hc-store-")), "usage") });
    for (const event of events) store.record(event as never);
    const dirs = [store.directory];
    return {
      accountingReader: store as unknown as NonNullable<ProxyDeps["accountingReader"]>,
      close() {
        store.close();
        for (const d of dirs) rmSync(d, { recursive: true, force: true });
      },
    };
  }

  const fronts = ["anthropic", "openai"] as const;

  it.each(fronts)(
    "credential A at its cap is skipped WITHOUT egress; B serves; the walk says 1xcapped (%s front)",
    async (kind) => {
      const a = await scripted(() => ({ body: okBody(kind, "m1") }));
      const b = await scripted(() => ({ body: okBody(kind, "m2") }));
      const ledgerStore = cappedLedger({ "p1#capped": 1 });
      const p = port(await startProxy(poolCfg([
        `http://127.0.0.1:${port(a.server)}`,
        `http://127.0.0.1:${port(b.server)}`,
      ], kind), ledgerStore));

      try {
        const first = await post(p, kind);
        expect(first.status).toBe(200);
        await first.text();
        // B served...
        expect(first.headers.get(SERVED_BY_HEADER)).toBe("p2/m2");
        // ...A was counted as tried-but-capped beside the served tally...
        expect(first.headers.get(POOL_ATTEMPTS_HEADER)).toContain("1xcapped");
        expect(first.headers.get(POOL_ATTEMPTS_HEADER)).toBe("2 tried, 1 served: 1xcapped, 1x200");
        // ...and NO provider request was sent to the capped member.
        expect(a.calls()).toBe(0);
        expect(b.calls()).toBe(1);
        // The refusal header names nobody's cap unless EVERY candidate was capped.
        expect(first.headers.get(HARD_CAP_HEADER)).toBeNull();
      } finally {
        ledgerStore.close();
      }
    },
  );

  it.each(fronts)(
    "EVERY candidate capped -> relay-synthesized 429 with retry-after, the cap header and no egress (%s front)",
    async (kind) => {
      const a = await scripted(() => ({ body: okBody(kind, "m1") }));
      const b = await scripted(() => ({ body: okBody(kind, "m2") }));
      const ledgerStore = cappedLedger({ "p1#capped": 1, "p2#spare": 1 });
      const p = port(await startProxy(poolCfg([
        `http://127.0.0.1:${port(a.server)}`,
        `http://127.0.0.1:${port(b.server)}`,
      ], kind, true), ledgerStore));

      try {
        const refused = await post(p, kind);
        expect(refused.status).toBe(429);
        // Nothing anywhere was contacted.
        expect(a.calls()).toBe(0);
        expect(b.calls()).toBe(0);

        const body = (await refused.json()) as {
          error?: { message?: string; type?: string; code?: string };
          type?: string;
        };
        if (kind === "anthropic") {
          expect(body.type).toBe("error");
          expect((body.error as { type?: string } | undefined)?.type).toBe("rate_limit_error");
        } else {
          expect(body.error?.code).toBe("llm_relay_capped");
          expect(body.error?.type).toBe("rate_limit_error");
        }
        // Names the caps, their basis, and the honest "nothing was contacted" statement.
        const message = (body.error as { message?: string } | undefined)?.message ?? "";
        expect(message).toContain("operator-declared");
        expect(message).toContain("requests/day 1/1"); // inclusive: 1 used OF 1
        expect(message).toContain("No provider was contacted");

        // Retry-after derived ONLY from the soonest UTC day boundary.
        const retryAfter = Number(refused.headers.get("retry-after"));
        const midnight = Math.ceil((Date.parse(new Date().toISOString().slice(0, 10) + "T00:00:00.000Z") + 86_400_000 - Date.now()) / 1000);
        expect(refused.headers.get("retry-after")).not.toBeNull();
        expect(retryAfter).toBeGreaterThan(0);
        expect(retryAfter).toBeLessThanOrEqual(Math.max(1, midnight));

        // The bounded cap header: label/deployment axis/period used/cap, nothing secret.
        expect(refused.headers.get(HARD_CAP_HEADER)).toBe(
          "capped/p1/m1 requests/day 1/1; spare/p2/m2 requests/day 1/1",
        );
        expect(refused.headers.get(POOL_ATTEMPTS_HEADER)).toBe("2 tried, 0 served: 2xcapped");
      } finally {
        ledgerStore.close();
      }
    },
  );

  it.each(fronts)(
    "the cap does not consume itself: usage below the cap leaves the walk untouched (%s front)",
    async (kind) => {
      const a = await scripted(() => ({ body: okBody(kind, "m1") }));
      const b = await scripted(() => ({ body: okBody(kind, "m2") }));
      const ledgerStore = cappedLedger({});
      const p = port(await startProxy(poolCfg([
        `http://127.0.0.1:${port(a.server)}`,
        `http://127.0.0.1:${port(b.server)}`,
      ], kind), ledgerStore));

      try {
        const res = await post(p, kind);
        expect(res.status).toBe(200);
        await res.text();
        expect(res.headers.get(SERVED_BY_HEADER)).toBe("p1/m1"); // config order kept
        expect(res.headers.get(POOL_ATTEMPTS_HEADER)).toBeNull(); // single-candidate-shaped walk
        expect(res.headers.get(HARD_CAP_HEADER)).toBeNull();
        expect(a.calls()).toBe(1);
        expect(b.calls()).toBe(0);
      } finally {
        ledgerStore.close();
      }
    },
  );

  it.each(fronts)(
    "UNKNOWN usage (no store handed to the server) refuses nothing anywhere (%s front)",
    async (kind) => {
      const a = await scripted(() => ({ body: okBody(kind, "m1") }));
      const b = await scripted(() => ({ body: okBody(kind, "m2") }));
      const p = port(await startProxy(poolCfg([
        `http://127.0.0.1:${port(a.server)}`,
        `http://127.0.0.1:${port(b.server)}`,
      ], kind)));

      const res = await post(p, kind);
      expect(res.status).toBe(200);
      await res.text();
      expect(res.headers.get(SERVED_BY_HEADER)).toBe("p1/m1");
      expect(a.calls()).toBe(1);
      expect(res.headers.get(HARD_CAP_HEADER)).toBeNull();
    },
  );

  it.each(fronts)(
    "a PER-DEPLOYMENT cap is not reached by usage on a sibling model (%s front)",
    async (kind) => {
      // The F1 defect, end to end: p1's cap is declared at `limits.models.m1.hard`, and every
      // request this credential spent went to a DIFFERENT model. Reading it credential-wide
      // refuses p1 on somebody else's usage; reading it at its declared scope does not.
      const a = await scripted(() => ({ body: okBody(kind, "m1") }));
      const b = await scripted(() => ({ body: okBody(kind, "m2") }));
      const ledgerStore = cappedLedger({ "p1#capped": { count: 3, model: "some-other-model" } });
      const p = port(await startProxy(poolCfg([
        `http://127.0.0.1:${port(a.server)}`,
        `http://127.0.0.1:${port(b.server)}`,
      ], kind, false, "model"), ledgerStore));

      try {
        const res = await post(p, kind);
        expect(res.status).toBe(200);
        await res.text();
        expect(res.headers.get(SERVED_BY_HEADER)).toBe("p1/m1"); // NOT capped, NOT failed over
        expect(a.calls()).toBe(1);
        expect(b.calls()).toBe(0);
        expect(res.headers.get(HARD_CAP_HEADER)).toBeNull();
      } finally {
        ledgerStore.close();
      }
    },
  );

  it.each(fronts)(
    "a PER-DEPLOYMENT cap IS reached by usage on its own model (%s front)",
    async (kind) => {
      // The other half of the same rule: identical config, usage moved onto the capped deployment.
      const a = await scripted(() => ({ body: okBody(kind, "m1") }));
      const b = await scripted(() => ({ body: okBody(kind, "m2") }));
      const ledgerStore = cappedLedger({ "p1#capped": { count: 1, model: "m1" } });
      const p = port(await startProxy(poolCfg([
        `http://127.0.0.1:${port(a.server)}`,
        `http://127.0.0.1:${port(b.server)}`,
      ], kind, false, "model"), ledgerStore));

      try {
        const res = await post(p, kind);
        expect(res.status).toBe(200);
        await res.text();
        expect(res.headers.get(SERVED_BY_HEADER)).toBe("p2/m2");
        expect(res.headers.get(POOL_ATTEMPTS_HEADER)).toBe("2 tried, 1 served: 1xcapped, 1x200");
        expect(a.calls()).toBe(0);
      } finally {
        ledgerStore.close();
      }
    },
  );

  it.each(fronts)(
    "a MIXED walk (cap + a real provider failure) serves the upstream error, never the synthesized 429 (%s front)",
    async (kind) => {
      // The load-bearing half of the all-capped rule: any real provider outcome among the failures
      // means the last upstream error is the more honest body — the same maxim the all-429 policy
      // follows. A synthesized 429 here would claim "no provider was contacted", which is false.
      const a = await scripted(() => ({ body: okBody(kind, "m1") }));
      const b = await scripted(() => ({
        status: 502,
        body: JSON.stringify({ error: { message: "upstream exploded", type: "server_error" } }),
      }));
      const ledgerStore = cappedLedger({ "p1#capped": 1 });
      const p = port(await startProxy(poolCfg([
        `http://127.0.0.1:${port(a.server)}`,
        `http://127.0.0.1:${port(b.server)}`,
      ], kind), ledgerStore));

      try {
        const res = await post(p, kind);
        expect(res.status).toBe(502);
        expect(await res.text()).toContain("upstream exploded");
        expect(a.calls()).toBe(0); // the capped member still spent nothing
        expect(b.calls()).toBe(1);
        // No relay refusal header, and no invented retry-after.
        expect(res.headers.get(HARD_CAP_HEADER)).toBeNull();
        expect(res.headers.get("retry-after")).toBeNull();
        expect(res.headers.get(POOL_ATTEMPTS_HEADER)).toBe("2 tried, 0 served: 1xcapped, 1x502");
      } finally {
        ledgerStore.close();
      }
    },
  );

  it.each(fronts)(
    "the pool-attempts breakdown reads in WALK order when a real failure precedes a cap (%s front)",
    async (kind) => {
      // `recordCapped` runs while the walk is being asked for the NEXT candidate, i.e. before the
      // preceding candidate's status is counted. A walk that went `A:429 -> B:capped` used to
      // render `1xcapped, 1x429`, reversing what happened.
      const a = await scripted(() => ({
        status: 429,
        body: JSON.stringify({ error: { message: "slow down", type: "rate_limit_error" } }),
      }));
      const b = await scripted(() => ({ body: okBody(kind, "m2") }));
      // Cap the SECOND member only; the first answers a real 429.
      const cfg = poolCfg([
        `http://127.0.0.1:${port(a.server)}`,
        `http://127.0.0.1:${port(b.server)}`,
      ], kind, true);
      delete cfg.providers.p1!.credentials![0]!.limits;
      const ledgerStore = cappedLedger({ "p2#spare": 1 });
      const p = port(await startProxy(cfg, ledgerStore));

      try {
        const res = await post(p, kind);
        expect(res.status).toBe(429); // p1's real upstream 429, not a relay refusal
        expect(await res.text()).toContain("slow down");
        expect(res.headers.get(POOL_ATTEMPTS_HEADER)).toBe("2 tried, 0 served: 1x429, 1xcapped");
        expect(res.headers.get(HARD_CAP_HEADER)).toBeNull();
        expect(a.calls()).toBe(1);
        expect(b.calls()).toBe(0);
      } finally {
        ledgerStore.close();
      }
    },
  );

  it.each(fronts)(
    "a cap never REORDERS the walk — capped members are skipped in place, not moved (%s front)",
    async (kind) => {
      // "Health demotes, never drops" governs the WALK; a cap governs one attempt. Three members,
      // the MIDDLE one capped: the walk must still run 1 -> 2 -> 3 in config order, with the
      // capped cell counted where it sits rather than promoted or demoted.
      const a = await scripted(() => ({
        status: 502,
        body: JSON.stringify({ error: { message: "a down", type: "server_error" } }),
      }));
      const b = await scripted(() => ({ body: okBody(kind, "m2") }));
      const c = await scripted(() => ({ body: okBody(kind, "m3") }));
      const cfg = poolCfg([
        `http://127.0.0.1:${port(a.server)}`,
        `http://127.0.0.1:${port(b.server)}`,
        `http://127.0.0.1:${port(c.server)}`,
      ], kind, true);
      // Only p2 carries a cap; p1 and p3 are ordinary members.
      delete cfg.providers.p1!.credentials![0]!.limits;
      delete cfg.providers.p3!.credentials![0]!.limits;
      const ledgerStore = cappedLedger({ "p2#spare": 1 });
      const p = port(await startProxy(cfg, ledgerStore));

      try {
        const res = await post(p, kind);
        expect(res.status).toBe(200);
        await res.text();
        expect(res.headers.get(SERVED_BY_HEADER)).toBe("p3/m3");
        // Config order preserved ACROSS the capped member: 1 egressed and failed, 2 was skipped
        // where it sits, 3 served. A cap that reordered would put p3's 200 before p2's skip.
        expect(res.headers.get(POOL_ATTEMPTS_HEADER)).toBe("3 tried, 1 served: 1x502, 1xcapped, 1x200");
        expect(a.calls()).toBe(1);
        expect(b.calls()).toBe(0);
        expect(c.calls()).toBe(1);
        // And the cap left no health trace: it is config, not a failure.
        const p2 = globalCircuitBreaker.getState({ provider: "p2", model: "m2", kind, credentialId: "p2#spare" });
        expect(p2?.consecutiveFailures ?? 0).toBe(0);
        expect(p2?.lastStatus ?? null).toBeNull();
      } finally {
        ledgerStore.close();
      }
    },
  );

  it.each(fronts)(
    "the capped skip is announced in the metadata log as a status-only `capped` attempt (%s front)",
    async (kind) => {
      const logDir = mkdtempSync(join(tmpdir(), "rp-hc-log-"));
      const logFile = join(logDir, "proxy.jsonl");
      const a = await scripted(() => ({ body: okBody(kind, "m1") }));
      const b = await scripted(() => ({ body: okBody(kind, "m2") }));
      const cfg = poolCfg([
        `http://127.0.0.1:${port(a.server)}`,
        `http://127.0.0.1:${port(b.server)}`,
      ], kind);
      cfg.log = { level: "metadata", file: logFile };
      const ledgerStore = cappedLedger({ "p1#capped": 1 });
      const p = port(await startProxy(cfg, ledgerStore));

      try {
        const res = await post(p, kind);
        expect(res.status).toBe(200);
        await res.text();
        const rows = readFileSync(logFile, "utf8").trim().split("\n").map((l) => JSON.parse(l) as {
          servedProvider: string | null;
          attempts: Array<{ provider: string; model: string | null; status: number | string; ms: number }>;
        });
        const row = rows.at(-1)!;
        expect(row.servedProvider).toBe("p2");
        expect(row.attempts).toEqual([
          { provider: "p1", model: "m1", status: "capped", ms: 0 },
          { provider: "p2", model: "m2", status: 200, ms: expect.any(Number) },
        ]);
      } finally {
        ledgerStore.close();
        rmSync(logDir, { recursive: true, force: true });
      }
    },
  );

  it("the x-llm-relay-capped header names at most 5 cells and counts the rest", async () => {
    // A capped attempt consumes no walk start budget, so every member of a fully capped pool
    // reaches the header. Seven members, five named, "+2 more" — bounded by COUNT, not just width.
    const backend = await scripted(() => ({ body: okBody("anthropic", "m1") }));
    const base = `http://127.0.0.1:${port(backend.server)}`;
    const cfg = poolCfg([base, base, base, base, base, base, base], "anthropic", true);
    const ledgerStore = cappedLedger({
      "p1#capped": 1, "p2#spare": 1, "p3#spare": 1, "p4#spare": 1,
      "p5#spare": 1, "p6#spare": 1, "p7#spare": 1,
    });
    const p = port(await startProxy(cfg, ledgerStore));

    try {
      const res = await post(p, "anthropic");
      expect(res.status).toBe(429);
      await res.text();
      const header = res.headers.get(HARD_CAP_HEADER)!;
      expect(header.split("; ")).toHaveLength(6); // 5 cells + the "+K more" term
      expect(header.startsWith("capped/p1/m1 requests/day 1/1; ")).toBe(true);
      expect(header.endsWith("; +2 more")).toBe(true);
      expect(res.headers.get(POOL_ATTEMPTS_HEADER)).toBe("7 tried, 0 served: 7xcapped");
      expect(backend.calls()).toBe(0);
    } finally {
      ledgerStore.close();
    }
  });

  it.each(fronts)(
    "routing.quota.hardCaps:false ignores every declared cap (%s front)",
    async (kind) => {
      const a = await scripted(() => ({ body: okBody(kind, "m1") }));
      const b = await scripted(() => ({ body: okBody(kind, "m2") }));
      const ledgerStore = cappedLedger({ "p1#capped": 3 });
      const cfg = poolCfg([
        `http://127.0.0.1:${port(a.server)}`,
        `http://127.0.0.1:${port(b.server)}`,
      ], kind);
      cfg.routing.quota = { hardCaps: false };
      const p = port(await startProxy(cfg, ledgerStore));

      try {
        const res = await post(p, kind);
        expect(res.status).toBe(200);
        await res.text();
        expect(res.headers.get(SERVED_BY_HEADER)).toBe("p1/m1"); // walked straight past its cap
        expect(res.headers.get(HARD_CAP_HEADER)).toBeNull();
        expect(a.calls()).toBe(1);
      } finally {
        ledgerStore.close();
      }
    },
  );
});

// ── Ordering and surfaces ────────────────────────────────────────────────────────────────────────

describe("ordering and /candidates surface", () => {
  beforeEach(() => {
    globalCircuitBreaker.reset();
    resetFacts();
    resetInterpretations();
  });
  afterEach(() => {
    globalCircuitBreaker.reset();
    resetFacts();
    resetInterpretations();
  });

  it("orderByUsability is not even given the config — caps cannot reach the ordering pass", () => {
    // Deliberate contrast with the demotion term, which DOES reorder. This pins the seam, not the
    // behaviour: `orderByUsability` takes attempts and a breaker, so there is nowhere for a cap to
    // enter. That a cap does not MOVE a candidate in a live walk is pinned end to end, in
    // "a cap never REORDERS the walk" above — a config this function never receives could not.
    const attempts = [t("a"), t("b")].map((target) => resolveAttempt(target));
    expect(orderByUsability(attempts, new CircuitBreaker()).map((x) => x.target.provider)).toEqual(["a", "b"]);
  });

  it("a per-model cap reads that model's usage on /candidates too — the answer enforcement gets", async () => {
    // Display and enforcement share the evaluator; that is not enough on its own, because they
    // can still ask the LEDGER different questions through it. This pins that they do not.
    const now = Date.now();
    const cfg = baseCfg({ pools: { coding: ["a/m"] } }, { limits: { models: { m: { hard: { rpd: 3 } } } } });
    // 9 requests on this credential today, every one of them on a different deployment.
    const usedInWindow = (options: UsedInWindowOptions) =>
      options.model === "m"
        ? { requests: 0, tokens: null, basis: "mixed" as const }
        : { requests: 9, tokens: null, basis: "mixed" as const };

    const view = await buildCandidates(cfg, {
      breaker: new CircuitBreaker(),
      tierData: null,
      nowMs: now,
      accounting: { usedInWindow },
    });
    const row = view.candidates.find((c) => c.provider === "a" && c.model === "m")!;
    expect(row.hardCap).toBeNull();

    // Request path and /candidates share this adapter: narrow by the scope the evaluator asks
    // for, never by a scope the caller picked.
    const ledgerReader = createHardCapLedgerReader({ usedInWindow }, "a#default", "m", now);
    const enforced = evaluateHardCap({
      cfg,
      provider: "a",
      credentialLabel: "default",
      model: "m",
      usedInWindow: ledgerReader,
      now,
    });
    expect(enforced).toBeNull();
    expect(ledgerReader("requests", "day", "credential")).toEqual({ value: 9, basis: "relay-counted" });
    expect(ledgerReader("tokens", "day", "credential")).toEqual({ value: null, basis: "mixed" });
  });

  it("/candidates shows the reached cap for its cell, resolved like enforcement resolves it", async () => {
    const now = Date.now();
    const cfg = baseCfg({ pools: { coding: ["a/m", "b/m"] } }, { limits: { hard: { rpd: 4 } } });
    const view = await buildCandidates(
      cfg,
      {
        breaker: new CircuitBreaker(),
        tierData: null,
        nowMs: now,
        accounting: {
          usedInWindow: (options) =>
            options.credentialId === "a#default"
              ? { requests: 4, tokens: null, basis: "reported" }
              : { requests: 1, tokens: null, basis: "reported" },
        },
      },
    );
    const capped = view.candidates.find((c) => c.provider === "a")!;
    expect(capped.hardCap).toMatchObject({ axis: "requests", period: "day", cap: 4, used: 4 });
    // Provenance travels with the figure, like every sibling field in this view: a machine
    // consumer must be able to tell an operator's assertion from a measurement, and a
    // credential-wide count from a per-model one.
    expect(capped.hardCap).toMatchObject({
      basis: "operator-declared",
      source: "provider",
      scope: "credential",
      resetsAtBasis: "derived-boundary",
    });
    const free = view.candidates.find((c) => c.provider === "b")!;
    expect(free.hardCap).toBeNull(); // under its cap: config detail, not routing state
    // Un-blended: no score or rank appears because a cap exists.
    const json = JSON.stringify(view);
    expect(json).not.toContain('"score"');
    expect(json).not.toContain('"rank"');
  });

  it("/candidates without a ledger reports no cap rows at all", async () => {
    const cfg = baseCfg({ pools: { coding: ["a/m"] } }, { limits: { hard: { rpd: 1 } } });
    const view = await buildCandidates(cfg, { breaker: new CircuitBreaker(), tierData: null, nowMs: Date.now() });
    for (const row of view.candidates) expect(row.hardCap).toBeNull();
  });

  it("the dashboard availability producer shows a REACHED cap as reason manual — config, not health", async () => {
    const { createAvailabilityProducer } = await import("../src/availability-snapshot.js");
    const now = Math.floor(Date.now() / DAY_MS) * DAY_MS + 3_600_000;
    const cfg = baseCfg({ pools: { coding: ["a/m"] } }, { limits: { hard: { rpd: 2 } } });
    const producer = createAvailabilityProducer({
      breaker: new CircuitBreaker(),
      config: cfg,
      accounting: {
        usedInWindow: (options) =>
          options.credentialId === "a#default" && options.period === "day"
            ? { requests: 2, tokens: null, basis: "reported" }
            : { requests: null, tokens: null, basis: null },
      },
    });
    const { cooldowns } = producer.snapshot();
    // Reason `manual`: the operator stopped this cell, nothing is sick. Until = the derived UTC
    // day boundary; observedAt stays null (config load is not an observation).
    const row = cooldowns.find((c) => c.provider === "a" && c.reason === "manual");
    expect(row).toBeDefined();
    expect(row!.credentialId).toBe("a#default");
    expect(Date.parse(row!.until!)).toBeGreaterThan(now);
    expect(row!.observedAt).toBeNull();
    expect(cooldowns.some((c) => c.provider === "b")).toBe(false); // b is not capped
  });
});
