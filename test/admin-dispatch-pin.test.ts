/**
 * `POST /dispatch {"pin"|"unpin"}` — the operator's own hand on the dispatch order, and the
 * dashboard's FIRST write (backlog 2026-09-16).
 *
 * Two halves, deliberately separate. ADMISSION: the request sits on the same boundary as every
 * other mutating control route (`test/loopback-admission.test.ts` is the precedent) — exact
 * bound `Host`, exact `Origin` when one is present, `content-type: application/json`, and the
 * per-install control token. VALIDATION: the body admits only a lane that exists, on a ladder
 * that exists, that config has not parked — and refuses by NAME rather than silently recording a
 * pin nothing would read. Every claim about the ladder is read off `GET /dispatch` (or the
 * `POST`'s own view), because the property this pins is "visible on the next `GET /dispatch` with
 * no relay restart".
 */
import { describe, it, expect, afterAll } from "vitest";
import { writeFileSync, mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { request as httpRequest } from "node:http";
import { loadConfig, type Config } from "../src/config.js";
import { createProxy } from "../src/server.js";
import { CONTROL_AUTHORIZATION_HEADER } from "../src/control-authorization.js";
import { LANE_PIN_HEADER, OPERATOR_PIN_REASON } from "../src/routes/admin.js";
import {
  demoteLane,
  forgetLaneMemory,
  laneDemotion,
  lanePin,
  MAX_AFFINITY_MS,
  pinLane,
} from "../src/lane-affinity.js";

const controlToken = "pin-test-control-token";
const JSON_HEADERS = { "content-type": "application/json" };
const CONTROL_HEADERS = { ...JSON_HEADERS, [CONTROL_AUTHORIZATION_HEADER]: controlToken };

/** Just enough of the `/dispatch` payload for the assertions below. */
type DispatchBody = {
  tier: string | null;
  next: { id: string } | null;
  order: string[];
  reason: string;
  ladder: Array<{ id: string; state: string; pinned?: { until: string; reason: string }; demoted?: { until: string; reason: string } }>;
};

const dir = mkdtempSync(join(tmpdir(), "rp-dispatch-pin-"));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

const LEGACY_LADDER = [
  { id: "agy-gemini", kind: "cli", command: "agy", args: ["-p", "{task}"], quota: "agy" },
  { id: "codex", kind: "cli", command: "codex", args: ["exec", "{task}"] },
  { id: "parked", kind: "cli", command: "codex", args: ["exec", "{task}"], enabled: false },
  { id: "pools", kind: "relay", spec: "anthropic" },
];

let n = 0;
function cfgWith(routing: Record<string, unknown>): Config {
  const p = join(dir, `c${n++}.json`);
  writeFileSync(
    p,
    JSON.stringify({
      listen: "127.0.0.1:8791",
      providers: { anthropic: { base: "https://api.anthropic.com", kind: "anthropic" } },
      routing: { default: "anthropic", ...routing },
      mode: "detect",
      log: { level: "silent", file: null },
    }),
  );
  return loadConfig(p);
}

/** A legacy single ladder, walk ON (the default). */
function legacyCfg(): Config {
  return cfgWith({ ladder: LEGACY_LADDER });
}

/** Two tiered ladders sharing rung ids, walk ON. */
function tieredCfg(): Config {
  const rung = (id: string) => ({ id, kind: "cli", command: "codex", args: ["exec", "{task}"] });
  return cfgWith({ ladders: { medium: [rung("a"), rung("b")], high: [rung("a"), rung("b")] } });
}

async function withProxy<T>(cfg: Config, fn: (base: string, port: number) => Promise<T>): Promise<T> {
  const proxy = createProxy(cfg, {
    controlAuthorization: { validate: (candidate) => candidate === controlToken },
  });
  await new Promise<void>((r) => proxy.listen(0, "127.0.0.1", () => r()));
  const { port } = proxy.address() as { port: number };
  try {
    return await fn(`http://127.0.0.1:${port}`, port);
  } finally {
    await new Promise<void>((r) => proxy.close(() => r()));
  }
}

async function post(base: string, body: unknown, headers: Record<string, string> = CONTROL_HEADERS): Promise<Response> {
  return fetch(`${base}/dispatch`, { method: "POST", headers, body: JSON.stringify(body) });
}

async function view(base: string, query = ""): Promise<DispatchBody> {
  const res = await fetch(`${base}/dispatch${query}`);
  expect(res.status).toBe(200);
  return (await res.json()) as DispatchBody;
}

async function errorMessage(res: Response): Promise<string> {
  const body = (await res.json()) as { error?: { message?: string } };
  return body.error?.message ?? "";
}

describe("POST /dispatch {pin} — admission (the /offload precedent, applied to the dashboard's first write)", () => {
  it("admits a loopback, JSON, control-token POST and the pin is visible on the NEXT GET /dispatch with no restart", async () => {
    const cfg = legacyCfg();
    await withProxy(cfg, async (base) => {
      // Before: configured order, nothing pinned.
      const before = await view(base);
      expect(before.next?.id).toBe("agy-gemini");
      expect(before.ladder.every((l) => l.pinned === undefined)).toBe(true);

      const res = await post(base, { pin: "codex" });
      expect(res.status).toBe(200);
      expect(res.headers.get(LANE_PIN_HEADER)).toBe("pinned codex");
      // The POST's own view already shows it — one round-trip for the dashboard.
      const posted = (await res.json()) as DispatchBody;
      expect(posted.ladder.find((l) => l.id === "codex")?.pinned?.reason).toBe(OPERATOR_PIN_REASON);

      // And the property itself: the next tokenless read reflects it.
      const after = await view(base);
      expect(after.next?.id).toBe("codex");
      expect(after.order[0]).toBe("codex");
      expect(after.ladder.find((l) => l.id === "codex")?.pinned?.reason).toBe(OPERATOR_PIN_REASON);
      expect(after.reason).toContain("pinned");
      // Only that lane carries the memory.
      expect(after.ladder.filter((l) => l.pinned !== undefined).map((l) => l.id)).toEqual(["codex"]);
    });
    // The memory landed on the tier `buildDispatch` reads for a legacy ladder: null.
    expect(lanePin(cfg, null, "codex")?.reason).toBe(OPERATOR_PIN_REASON);
  });

  it("refuses a missing control token and a wrong one (403), recording nothing", async () => {
    const cfg = legacyCfg();
    await withProxy(cfg, async (base) => {
      const missing = await post(base, { pin: "codex" }, JSON_HEADERS);
      const wrong = await post(base, { pin: "codex" }, { ...JSON_HEADERS, [CONTROL_AUTHORIZATION_HEADER]: "wrong" });
      expect(missing.status).toBe(403);
      expect(wrong.status).toBe(403);
      expect((await view(base)).next?.id).toBe("agy-gemini");
    });
    expect(lanePin(cfg, null, "codex")).toBeNull();
  });

  it("refuses a non-loopback Host header even with a valid token (DNS rebinding)", async () => {
    const cfg = legacyCfg();
    await withProxy(cfg, async (_base, port) => {
      // fetch() rewrites Host, so this is driven over a raw socket — the loopback-admission recipe.
      const body = JSON.stringify({ pin: "codex" });
      const status = await new Promise<number>((resolve, reject) => {
        const req = httpRequest(
          {
            host: "127.0.0.1",
            port,
            path: "/dispatch",
            method: "POST",
            headers: {
              Host: "attacker.example",
              "Content-Type": "application/json",
              "Content-Length": Buffer.byteLength(body),
              [CONTROL_AUTHORIZATION_HEADER]: controlToken,
            },
          },
          (res) => {
            res.resume();
            resolve(res.statusCode ?? 0);
          },
        );
        req.on("error", reject);
        req.end(body);
      });
      expect(status).toBe(403);
    });
    expect(lanePin(cfg, null, "codex")).toBeNull();
  });

  it("refuses a text/plain POST (the CORS simple-request bypass) and one with no content-type", async () => {
    const cfg = legacyCfg();
    await withProxy(cfg, async (base) => {
      const plain = await post(base, { pin: "codex" }, { "content-type": "text/plain", [CONTROL_AUTHORIZATION_HEADER]: controlToken });
      expect(plain.status).toBe(403);
      const none = await fetch(`${base}/dispatch`, {
        method: "POST",
        headers: { [CONTROL_AUTHORIZATION_HEADER]: controlToken },
      });
      expect(none.status).toBe(403);
    });
    expect(lanePin(cfg, null, "codex")).toBeNull();
  });

  it("refuses a cross-origin POST even with a valid token, and admits the exact listener origin", async () => {
    const cfg = legacyCfg();
    await withProxy(cfg, async (base) => {
      const evil = await post(base, { pin: "codex" }, { ...CONTROL_HEADERS, origin: "https://evil.example" });
      expect(evil.status).toBe(403);
      expect(lanePin(cfg, null, "codex")).toBeNull();
      // The dashboard SPA is served from this listener, so its own Origin is exactly this one.
      const same = await post(base, { pin: "codex" }, { ...CONTROL_HEADERS, origin: base });
      expect(same.status).toBe(200);
    });
  });
});

describe("POST /dispatch {pin} — validation refuses by name, never records an inert pin", () => {
  it("refuses a lane id that is on no ladder, naming it", async () => {
    await withProxy(legacyCfg(), async (base) => {
      const res = await post(base, { pin: "nope" });
      expect(res.status).toBe(400);
      expect(await errorMessage(res)).toBe(`POST /dispatch: no lane "nope" in routing.ladder`);
    });
  });

  it("scrubs control characters and bounds the echoed lane id", async () => {
    await withProxy(legacyCfg(), async (base) => {
      const res = await post(base, { pin: "[2Jcodex-typo" });
      expect(res.status).toBe(400);
      const message = await errorMessage(res);
      expect(message).not.toContain("");
      expect(message).toContain("codex-typo");
      const long = await post(base, { pin: "x".repeat(201) });
      expect(long.status).toBe(400);
      expect(await errorMessage(long)).toContain("at most 200 characters");
    });
  });

  it("refuses a non-string, empty, or absent lane id", async () => {
    await withProxy(legacyCfg(), async (base) => {
      for (const pin of [42, "", null, { id: "codex" }]) {
        const res = await post(base, { pin });
        expect(res.status, JSON.stringify(pin)).toBe(400);
        expect(await errorMessage(res)).toContain(`"pin" must be a lane id`);
      }
    });
  });

  it("refuses a DISABLED rung by name — a pin never resurrects one", async () => {
    const cfg = legacyCfg();
    await withProxy(cfg, async (base) => {
      const res = await post(base, { pin: "parked" });
      expect(res.status).toBe(400);
      expect(await errorMessage(res)).toContain(`lane "parked" is disabled in config`);
    });
    expect(lanePin(cfg, null, "parked")).toBeNull();
  });

  it("refuses when routing.dispatchWalk is off, because the view would read no memory at all", async () => {
    const cfg = cfgWith({ ladder: LEGACY_LADDER, dispatchWalk: false });
    await withProxy(cfg, async (base) => {
      const res = await post(base, { pin: "codex" });
      expect(res.status).toBe(400);
      expect(await errorMessage(res)).toContain("routing.dispatchWalk is off");
      expect((await view(base)).next?.id).toBe("agy-gemini");
    });
    expect(lanePin(cfg, null, "codex")).toBeNull();
  });

  it("refuses an unknown body key, a pin+unpin pair, and a pin mixed with an exhaustion report", async () => {
    const cfg = legacyCfg();
    await withProxy(cfg, async (base) => {
      const unknown = await post(base, { pin: "codex", reason: "because" });
      expect(unknown.status).toBe(400);
      expect(await errorMessage(unknown)).toContain(`does not accept property "reason"`);
      const both = await post(base, { pin: "codex", unpin: "codex" });
      expect(both.status).toBe(400);
      expect(await errorMessage(both)).toContain(`"pin" and "unpin" are exclusive`);
      const mixed = await post(base, { pin: "codex", exhausted: "agy-gemini" });
      expect(mixed.status).toBe(400);
      expect(await errorMessage(mixed)).toContain(`does not accept property "exhausted"`);
      // None of the three half-applied anything.
      const after = await view(base);
      expect(after.next?.id).toBe("agy-gemini");
      expect(after.ladder.find((l) => l.id === "agy-gemini")?.state).toBe("ready");
    });
    expect(lanePin(cfg, null, "codex")).toBeNull();
  });

  it("refuses a ttlMs outside (0, MAX_AFFINITY_MS] rather than clamping it, and honours one inside", async () => {
    const cfg = legacyCfg();
    await withProxy(cfg, async (base) => {
      for (const ttlMs of [0, -1, MAX_AFFINITY_MS + 1, "60000", Number.NaN, Number.POSITIVE_INFINITY]) {
        const res = await post(base, { pin: "codex", ttlMs });
        expect(res.status, String(ttlMs)).toBe(400);
        expect(await errorMessage(res)).toContain(`at most ${MAX_AFFINITY_MS}`);
      }
      expect(lanePin(cfg, null, "codex")).toBeNull();
      const before = Date.now();
      const ok = await post(base, { pin: "codex", ttlMs: 60_000 });
      expect(ok.status).toBe(200);
      const until = new Date((await ok.json() as DispatchBody).ladder.find((l) => l.id === "codex")!.pinned!.until).getTime();
      expect(until - before).toBeGreaterThanOrEqual(59_000);
      expect(until - before).toBeLessThanOrEqual(61_000 + 1_000);
    });
  });

  it("defaults the window to routing.dispatchWalk.pinMs", async () => {
    const cfg = cfgWith({ ladder: LEGACY_LADDER, dispatchWalk: { pinMs: 120_000 } });
    await withProxy(cfg, async (base) => {
      const before = Date.now();
      const res = await post(base, { pin: "codex" });
      expect(res.status).toBe(200);
      const until = new Date((await res.json() as DispatchBody).ladder.find((l) => l.id === "codex")!.pinned!.until).getTime();
      expect(until - before).toBeGreaterThanOrEqual(119_000);
      expect(until - before).toBeLessThanOrEqual(122_000);
    });
  });
});

describe("POST /dispatch {pin} — tiers", () => {
  it("pins on the named tier only, and the tier's own GET /dispatch shows it", async () => {
    const cfg = tieredCfg();
    await withProxy(cfg, async (base) => {
      const res = await post(base, { pin: "b", tier: "high" });
      expect(res.status).toBe(200);
      const posted = (await res.json()) as DispatchBody;
      expect(posted.tier).toBe("high");
      expect(posted.next?.id).toBe("b");

      const high = await view(base, "?tier=high");
      expect(high.next?.id).toBe("b");
      expect(high.ladder.find((l) => l.id === "b")?.pinned?.reason).toBe(OPERATOR_PIN_REASON);
      // Another tier is another ladder: `medium` learned nothing.
      const medium = await view(base, "?tier=medium");
      expect(medium.next?.id).toBe("a");
      expect(medium.ladder.every((l) => l.pinned === undefined)).toBe(true);
    });
    expect(lanePin(cfg, "high", "b")).not.toBeNull();
    expect(lanePin(cfg, "medium", "b")).toBeNull();
  });

  it("with no tier named, pins on the tier a bare GET /dispatch infers — the same key both sides", async () => {
    const cfg = tieredCfg();
    await withProxy(cfg, async (base) => {
      const res = await post(base, { pin: "b" });
      expect(res.status).toBe(200);
      expect(((await res.json()) as DispatchBody).tier).toBe("medium");
      expect((await view(base)).next?.id).toBe("b");
    });
    expect(lanePin(cfg, "medium", "b")).not.toBeNull();
  });

  it("refuses an unknown tier by name, and a lane that is not on the named tier's ladder", async () => {
    const cfg = cfgWith({
      ladders: {
        medium: [{ id: "a", kind: "cli", command: "codex", args: ["exec", "{task}"] }],
        high: [{ id: "h", kind: "cli", command: "codex", args: ["exec", "{task}"] }],
      },
    });
    await withProxy(cfg, async (base) => {
      const missing = await post(base, { pin: "a", tier: "vibes" });
      expect(missing.status).toBe(400);
      expect(await errorMessage(missing)).toBe(`POST /dispatch: no ladder tier "vibes" in routing.ladders`);
      // `a` exists — on `medium`. On `high` it is nobody, and the message says which ladder was searched.
      const elsewhere = await post(base, { pin: "a", tier: "high" });
      expect(elsewhere.status).toBe(400);
      expect(await errorMessage(elsewhere)).toBe(`POST /dispatch: no lane "a" in routing.ladders.high`);
      const badTier = await post(base, { pin: "a", tier: "" });
      expect(badTier.status).toBe(400);
      expect(await errorMessage(badTier)).toContain("tier must be a non-empty string");
    });
    expect(lanePin(cfg, "high", "a")).toBeNull();
    expect(lanePin(cfg, "vibes", "a")).toBeNull();
  });

  it("refuses a tier on a legacy single-ladder config instead of silently ignoring it", async () => {
    // `selectLadder` ignores `requested` when there are no `ladders`; an exhaustion report gets
    // that silent fall-through, a pin must not — the operator said a tier that does not exist.
    const cfg = legacyCfg();
    await withProxy(cfg, async (base) => {
      const res = await post(base, { pin: "codex", tier: "medium" });
      expect(res.status).toBe(400);
      expect(await errorMessage(res)).toContain("omit tier");
    });
    expect(lanePin(cfg, null, "codex")).toBeNull();
  });
});

describe("POST /dispatch {pin|unpin} — the memory semantics it inherits from the walk", () => {
  it("a pin RETRACTS a live demotion first (retract-then-record), and reports a replaced pin", async () => {
    const cfg = legacyCfg();
    demoteLane(cfg, null, "codex", "abandoned after 90s");
    await withProxy(cfg, async (base) => {
      const first = await post(base, { pin: "codex" });
      expect(first.status).toBe(200);
      expect(first.headers.get(LANE_PIN_HEADER)).toBe("pinned codex");
      const lane = ((await first.json()) as DispatchBody).ladder.find((l) => l.id === "codex");
      expect(lane?.pinned?.reason).toBe(OPERATOR_PIN_REASON);
      expect(lane?.demoted).toBeUndefined();
      const second = await post(base, { pin: "codex" });
      expect(second.headers.get(LANE_PIN_HEADER)).toBe("pinned codex (replaced a live pin)");
    });
    expect(laneDemotion(cfg, null, "codex")).toBeNull();
  });

  it("unpin retracts ONLY the pin, leaves a walk-measured demotion standing, and is idempotent", async () => {
    const cfg = legacyCfg();
    await withProxy(cfg, async (base) => {
      expect((await post(base, { pin: "codex" })).status).toBe(200);
      // A demotion recorded AFTER the pin, as the walk would record one on a later missed budget —
      // written directly so the test controls the order; the walk's own retraction is covered in
      // the telemetry test below.
      demoteLane(cfg, null, "codex", "abandoned after 90s");
      const first = await post(base, { unpin: "codex" });
      expect(first.status).toBe(200);
      expect(first.headers.get(LANE_PIN_HEADER)).toBe("unpinned codex (replaced a live pin)");
      const lane = ((await first.json()) as DispatchBody).ladder.find((l) => l.id === "codex");
      expect(lane?.pinned).toBeUndefined();
      expect(lane?.demoted?.reason).toBe("abandoned after 90s");
      expect((await view(base)).next?.id).toBe("agy-gemini");
      const again = await post(base, { unpin: "codex" });
      expect(again.status).toBe(200);
      expect(again.headers.get(LANE_PIN_HEADER)).toBe("unpinned codex");
      // ttlMs is meaningless on an unpin and is refused rather than ignored.
      const withTtl = await post(base, { unpin: "codex", ttlMs: 1000 });
      expect(withTtl.status).toBe(400);
      expect(await errorMessage(withTtl)).toContain(`ttlMs applies to "pin" only`);
    });
    expect(lanePin(cfg, null, "codex")).toBeNull();
    expect(laneDemotion(cfg, null, "codex")?.reason).toBe("abandoned after 90s");
  });

  it("unpin validates the lane exactly like pin", async () => {
    await withProxy(legacyCfg(), async (base) => {
      const res = await post(base, { unpin: "nope" });
      expect(res.status).toBe(400);
      expect(await errorMessage(res)).toBe(`POST /dispatch: no lane "nope" in routing.ladder`);
      const parked = await post(base, { unpin: "parked" });
      expect(parked.status).toBe(400);
    });
  });

  it("the walk's next missed budget on that lane retracts the operator pin — newest evidence wins", async () => {
    const cfg = legacyCfg();
    await withProxy(cfg, async (base) => {
      expect((await post(base, { pin: "codex" })).status).toBe(200);
      expect((await view(base)).next?.id).toBe("codex");
      const report = await fetch(`${base}/dispatch/telemetry`, {
        method: "POST",
        headers: CONTROL_HEADERS,
        body: JSON.stringify({
          jobId: "job-pin-0001",
          laneId: "codex",
          kind: "cli",
          wallClockMs: 90_000,
          exitCode: null,
          status: "abandoned",
          estimatedInputTokens: 1,
          estimatedOutputTokens: 0,
        }),
      });
      expect(report.status).toBe(200);
      const after = await view(base);
      const lane = after.ladder.find((l) => l.id === "codex");
      expect(lane?.pinned).toBeUndefined();
      expect(lane?.demoted).toBeDefined();
      expect(after.next?.id).toBe("agy-gemini");
    });
  });

  it("a pin never RESURRECTS: an exhausted lane stays unselected and carries no pinned field", async () => {
    const cfg = legacyCfg();
    await withProxy(cfg, async (base) => {
      expect((await post(base, { exhausted: "codex" })).status).toBe(200);
      expect((await post(base, { pin: "codex" })).status).toBe(200);
      const after = await view(base);
      const lane = after.ladder.find((l) => l.id === "codex");
      expect(lane?.state).toBe("exhausted");
      expect(lane?.pinned).toBeUndefined();
      expect(after.next?.id).toBe("agy-gemini");
    });
    // The memory is recorded, so it applies the moment the cooldown lapses — but the VIEW reads
    // present unavailability first.
    expect(lanePin(cfg, null, "codex")).not.toBeNull();
  });

  it("GET /dispatch stays tokenless and never mutates: a ?pin= query is not a pin", async () => {
    const cfg = legacyCfg();
    await withProxy(cfg, async (base) => {
      const res = await fetch(`${base}/dispatch?pin=codex`);
      expect(res.status).toBe(200);
      expect(((await res.json()) as DispatchBody).next?.id).toBe("agy-gemini");
    });
    expect(lanePin(cfg, null, "codex")).toBeNull();
  });
});

describe("forgetLaneMemory (lane-affinity.ts)", () => {
  it("reports whether a LIVE memory of that kind existed, and deletes only that kind", () => {
    const cfg = legacyCfg();
    const now = 1_700_000_000_000;
    expect(forgetLaneMemory(cfg, "pin", null, "codex", now)).toBe(false);
    pinLane(cfg, null, "codex", "answered", 60_000, now);
    demoteLane(cfg, null, "codex", "missed", 60_000, now);
    expect(forgetLaneMemory(cfg, "pin", null, "codex", now)).toBe(true);
    expect(lanePin(cfg, null, "codex", now)).toBeNull();
    expect(laneDemotion(cfg, null, "codex", now)?.reason).toBe("missed");
    // A lapsed row is absent, whatever the map still held.
    pinLane(cfg, null, "codex", "answered", 1_000, now);
    expect(forgetLaneMemory(cfg, "pin", null, "codex", now + 5_000)).toBe(false);
    expect(lanePin(cfg, null, "codex", now + 5_000)).toBeNull();
  });
});
