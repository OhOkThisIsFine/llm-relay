import { describe, it, expect, afterAll } from "vitest";
import { writeFileSync, mkdtempSync, rmSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { loadConfig, type Config } from "../src/config.js";
import { createProxy } from "../src/server.js";
import { buildDispatch, markExhausted, clearExhausted, MAX_EXHAUSTED_MS } from "../src/dispatch.js";

const dir = mkdtempSync(join(tmpdir(), "rp-dispatch-"));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

const BASE = {
  listen: "127.0.0.1:8791",
  providers: {
    anthropic: { base: "https://api.anthropic.com", kind: "anthropic" },
    nim: { base: "https://nim.test/v1", kind: "openai", authEnv: "NVIDIA_API_KEY" },
  },
  routing: {
    default: "anthropic",
    tiers: { opus: "anthropic", sonnet: "anthropic", haiku: "anthropic", fable: "anthropic" },
    pools: { coding: ["nim/z-ai/glm-5.2"] },
    benchmarkSort: false,
  },
  mode: "detect",
  log: { level: "silent", file: null },
};

const LADDER = [
  { id: "agy-gemini", kind: "cli", command: "agy", args: ["-p", "{task}", "--model", "g-flash"], quota: "agy-gemini" },
  { id: "agy-claude", kind: "cli", command: "agy", args: ["-p", "{task}", "--model", "c-sonnet"], quota: "agy-claude" },
  { id: "codex", kind: "cli", command: "codex", args: ["exec", "{task}"], quota: "chatgpt" },
  { id: "pools", kind: "relay", spec: "pool/coding" },
  { id: "anthropic", kind: "relay", spec: "anthropic" },
];

let n = 0;
function cfgWith(routing: Record<string, unknown> = {}): Config {
  const p = join(dir, `c${n++}.json`);
  writeFileSync(p, JSON.stringify({ ...BASE, routing: { ...BASE.routing, ...routing } }, null, 2));
  return loadConfig(p);
}

// No global cooldown reset here on purpose. Cooldowns are scoped to the Config they were reported
// against, and every test builds its own via cfgWith(), so each starts clean by construction.
// The old `beforeEach(() => clearExhausted(cfgWith(...)))` only worked because state was process-
// global and a clear-all on a throwaway config wiped every OTHER config's cooldowns too — it was
// papering over exactly the leak asserted against below.

describe("dispatch ladder — config", () => {
  it("is absent by default and expresses no opinion", () => {
    const view = buildDispatch(cfgWith());
    expect(view.ladder).toEqual([]);
    expect(view.next).toBeNull();
    expect(view.reason).toContain("no routing.ladder");
  });

  it("rejects a cli rung whose args never receive the task", () => {
    expect(() => cfgWith({ ladder: [{ id: "a", kind: "cli", command: "agy", args: ["-p", "hello"] }] })).toThrow(
      /\{task\}/,
    );
  });

  it("rejects duplicate rung ids — an override target must be unambiguous", () => {
    expect(() =>
      cfgWith({
        ladder: [
          { id: "dup", kind: "cli", command: "agy", args: ["{task}"] },
          { id: "dup", kind: "relay", spec: "anthropic" },
        ],
      }),
    ).toThrow(/already used/);
  });

  it("rejects a relay rung naming an unknown pool, at load time", () => {
    expect(() => cfgWith({ ladder: [{ id: "r", kind: "relay", spec: "pool/nope" }] })).toThrow(/unknown pool/);
  });

  it("rejects an unknown rung kind", () => {
    expect(() => cfgWith({ ladder: [{ id: "r", kind: "spawn", command: "x", args: ["{task}"] }] })).toThrow(/kind/);
  });
});

describe("dispatch ladder — ordering", () => {
  it("picks the first rung and renders its command with the task substituted", () => {
    const view = buildDispatch(cfgWith({ ladder: LADDER }), { task: "trace parseConfig" });
    expect(view.next?.id).toBe("agy-gemini");
    expect(view.next?.invoke).toEqual({ command: "agy", args: ["-p", "trace parseConfig", "--model", "g-flash"] });
  });

  it("leaves the placeholder visible when no task is given", () => {
    const view = buildDispatch(cfgWith({ ladder: LADDER }));
    expect(view.next?.invoke?.args).toContain("{task}");
  });

  it("walks past a spent rung", () => {
    const cfg = cfgWith({ ladder: LADDER });
    markExhausted(cfg, "agy-gemini");
    const view = buildDispatch(cfg);
    expect(view.next?.id).toBe("agy-claude");
    expect(view.ladder[0]?.state).toBe("exhausted");
    expect(view.ladder[0]?.readyAt).toBeTruthy();
  });

  it("keeps AGY's two credit balances independent — exhausting Gemini leaves Claude live", () => {
    const cfg = cfgWith({ ladder: LADDER });
    markExhausted(cfg, "agy-gemini");
    const view = buildDispatch(cfg);
    // Same binary, different quota bucket: the rung must NOT be cooled down with its sibling.
    expect(view.ladder.find((l) => l.id === "agy-claude")?.state).toBe("ready");
    expect(view.next?.id).toBe("agy-claude");
  });

  it("cools down every rung sharing one quota bucket", () => {
    const shared = [
      { id: "a1", kind: "cli", command: "agy", args: ["{task}"], quota: "same" },
      { id: "a2", kind: "cli", command: "agy", args: ["{task}"], quota: "same" },
      { id: "last", kind: "relay", spec: "anthropic" },
    ];
    const cfg = cfgWith({ ladder: shared });
    markExhausted(cfg, "a1");
    const view = buildDispatch(cfg);
    expect(view.ladder.find((l) => l.id === "a2")?.state).toBe("exhausted");
    expect(view.next?.id).toBe("last");
  });

  it("expires a cooldown once its TTL passes", () => {
    const cfg = cfgWith({ ladder: LADDER });
    markExhausted(cfg, "agy-gemini", 0);
    expect(buildDispatch(cfg).next?.id).toBe("agy-gemini");
  });

  it("reports the ladder exhausted rather than inventing a lane", () => {
    const cfg = cfgWith({ ladder: LADDER });
    for (const r of LADDER) markExhausted(cfg, r.id);
    const view = buildDispatch(cfg);
    expect(view.next).toBeNull();
    expect(view.reason).toMatch(/exhausted|disabled/);
  });

  it("never auto-selects a disabled rung but keeps it visible", () => {
    const cfg = cfgWith({ ladder: [{ ...LADDER[0], enabled: false }, LADDER[3], LADDER[4]] });
    const view = buildDispatch(cfg);
    expect(view.ladder[0]?.state).toBe("disabled");
    expect(view.next?.id).toBe("pools");
  });
});

describe("dispatch ladder — host control", () => {
  it("honours a host override, even for a rung that is cooling down", () => {
    const cfg = cfgWith({ ladder: LADDER });
    markExhausted(cfg, "codex");
    const view = buildDispatch(cfg, { lane: "codex" });
    expect(view.next?.id).toBe("codex");
    expect(view.reason).toContain("override");
  });

  it("names the valid lanes when an override misses", () => {
    const view = buildDispatch(cfgWith({ ladder: LADDER }), { lane: "nope" });
    expect(view.next).toBeNull();
    expect(view.reason).toContain("agy-gemini");
  });

  it("continues after a named rung with ?after=", () => {
    const view = buildDispatch(cfgWith({ ladder: LADDER }), { after: "agy-claude" });
    expect(view.next?.id).toBe("codex");
  });

  it("flags relay rungs that need an @relay: directive while offload is off", () => {
    const off = buildDispatch(cfgWith({ ladder: LADDER, offload: false }));
    expect(off.offload).toBe(false);
    expect(off.ladder.find((l) => l.id === "pools")?.requiresDirective).toBe(true);

    const on = buildDispatch(cfgWith({ ladder: LADDER, offload: true }));
    expect(on.offload).toBe(true);
    expect(on.ladder.find((l) => l.id === "pools")?.requiresDirective).toBe(false);
  });
});

describe("dispatch ladder — caller input is not trusted", () => {
  // DispatchOptions is typed, but the values arrive off a raw query string / JSON body, so the
  // types are not enforced at runtime. Nothing type-checks test/ either, hence runtime asserts.
  const bad = (v: unknown) => v as string;

  it("treats a non-string task/lane/after as absent rather than coercing it", () => {
    const cfg = cfgWith({ ladder: LADDER });
    const view = buildDispatch(cfg, { task: bad(42), lane: bad({}), after: bad(["agy-claude"]) });
    // No invented intent: no override, no walk-past, placeholder left visible.
    expect(view.next?.id).toBe("agy-gemini");
    expect(view.next?.invoke?.args).toContain("{task}");
    expect(view.reason).not.toContain("override");
  });

  it("treats a blank task as no task, keeping the placeholder visible", () => {
    const view = buildDispatch(cfgWith({ ladder: LADDER }), { task: "   " });
    // Substituting would render `agy -p '   ' --model g-flash` — a command asking for nothing.
    expect(view.next?.invoke?.args).toContain("{task}");
  });

  it("treats an empty lane/after as not supplied, not as a missed lookup", () => {
    const cfg = cfgWith({ ladder: LADDER });
    expect(buildDispatch(cfg, { lane: "" }).next?.id).toBe("agy-gemini");
    expect(buildDispatch(cfg, { after: "" }).next?.id).toBe("agy-gemini");
  });

  it("never echoes control characters from a caller-supplied lane into the reason", () => {
    // The reason is returned as JSON and printed to a terminal by `llm-relay dispatch`; an ESC
    // sequence reflected verbatim would rewrite the operator's screen.
    const view = buildDispatch(cfgWith({ ladder: LADDER }), { lane: "\u001b[31mowned\u0007" });
    expect(view.next).toBeNull();
    expect(view.reason).not.toContain("\u001b");
    expect(view.reason).not.toContain("\u0007");
    expect(view.reason).toContain("agy-gemini"); // the valid-id list still helps the caller
  });

  it("bounds the caller-supplied id echoed back in the reason", () => {
    const view = buildDispatch(cfgWith({ ladder: LADDER }), { after: "z".repeat(10_000) });
    expect(view.next).toBeNull();
    expect(view.reason.length).toBeLessThan(500);
  });

  it("clamps a non-finite ttl instead of poisoning the ladder with an unrenderable date", () => {
    // `1e999` is a legal JSON number that parses to Infinity and passes `typeof x === "number"`,
    // so it reached `new Date(Infinity).toISOString()` and threw RangeError on EVERY later read —
    // one bad exhaustion report took the whole ladder down until the process restarted.
    const cfg = cfgWith({ ladder: LADDER });
    const ttl = JSON.parse('{"ttlMs":1e999}').ttlMs as number;
    expect(ttl).toBe(Infinity);
    expect(markExhausted(cfg, "agy-gemini", ttl)).toBe(true);

    const view = buildDispatch(cfg);
    expect(view.ladder[0]?.state).toBe("exhausted");
    expect(Date.parse(view.ladder[0]?.readyAt ?? "")).not.toBeNaN();
    expect(Date.parse(view.ladder[0]?.readyAt ?? "")).toBeLessThanOrEqual(Date.now() + MAX_EXHAUSTED_MS);
    expect(view.next?.id).toBe("agy-claude");
  });

  it("clamps a NaN ttl to the default rather than a permanent cooldown", () => {
    const cfg = cfgWith({ ladder: LADDER });
    markExhausted(cfg, "agy-gemini", Number.NaN);
    const view = buildDispatch(cfg);
    expect(Date.parse(view.ladder[0]?.readyAt ?? "")).not.toBeNaN();
  });

  it("ignores an exhaustion report for a non-string id", () => {
    const cfg = cfgWith({ ladder: LADDER });
    expect(markExhausted(cfg, bad(null))).toBe(false);
    expect(buildDispatch(cfg).next?.id).toBe("agy-gemini");
  });
});

describe("dispatch ladder — state isolation", () => {
  it("scopes cooldowns to the config they were reported against", () => {
    // Two configs in one process share rung ids and quota bucket names. Process-global cooldown
    // state made exhausting a lane in one silently park the same-named lane in the other.
    const a = cfgWith({ ladder: LADDER });
    const b = cfgWith({ ladder: LADDER });
    markExhausted(a, "agy-gemini");
    expect(buildDispatch(a).next?.id).toBe("agy-claude");
    expect(buildDispatch(b).next?.id).toBe("agy-gemini");
  });

  it("clears only the caller's cooldowns, not every config's", () => {
    const a = cfgWith({ ladder: LADDER });
    const b = cfgWith({ ladder: LADDER });
    markExhausted(a, "agy-gemini");
    markExhausted(b, "agy-gemini");
    clearExhausted(b);
    expect(buildDispatch(a).next?.id).toBe("agy-claude");
    expect(buildDispatch(b).next?.id).toBe("agy-gemini");
  });
});

describe("dispatch ladder — order, never execution", () => {
  const source = readFileSync(fileURLToPath(new URL("../src/dispatch.ts", import.meta.url)), "utf8");

  it("never reaches for a process spawner", () => {
    // The relay owns the ORDER; the host executes. A CLI rung's quota is client-bound and it
    // returns only final text, so anything spawned here could never serve an HTTP turn.
    const spawners = [/node:child_process/, /\bspawn(Sync)?\s*\(/, /\bexec(File|Sync|FileSync)?\s*\(/];
    for (const spawner of spawners) {
      expect(source).not.toMatch(spawner);
    }
  });

  it("hands back the structured invoke form and never a pre-joined command string", () => {
    // A convenience "command line" field would be the carrier for exactly the unquoted-join
    // rendering defect the audit is removing — the task must stay inside one argv element.
    const view = buildDispatch(cfgWith({ ladder: LADDER }), { task: "rm -rf /; echo $(whoami)" });
    const lane = view.next!;
    expect(Object.keys(lane).sort()).toEqual(["id", "invoke", "kind", "position", "quota", "state"]);
    expect(lane.invoke?.args).toEqual(["-p", "rm -rf /; echo $(whoami)", "--model", "g-flash"]);
    for (const value of Object.values(view)) {
      expect(typeof value === "string" ? value : "").not.toContain("rm -rf /;");
    }
  });
});

describe("dispatch ladder — endpoint", () => {
  async function withProxy<T>(cfg: Config, fn: (base: string) => Promise<T>): Promise<T> {
    const proxy = createProxy(cfg);
    await new Promise<void>((r) => proxy.listen(0, "127.0.0.1", () => r()));
    const { port } = proxy.address() as { port: number };
    try {
      return await fn(`http://127.0.0.1:${port}`);
    } finally {
      proxy.close();
    }
  }

  it("serves the ladder, walks it on a POSTed exhaustion, and restores on clear", async () => {
    const cfg = cfgWith({ ladder: LADDER });
    await withProxy(cfg, async (base) => {
      const first = await (await fetch(`${base}/dispatch?task=go`)).json();
      expect(first.next.id).toBe("agy-gemini");
      expect(first.next.invoke.args).toContain("go");

      const walked = await (
        await fetch(`${base}/dispatch`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ exhausted: "agy-gemini" }),
        })
      ).json();
      expect(walked.next.id).toBe("agy-claude");

      const cleared = await (
        await fetch(`${base}/dispatch`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ clear: true }),
        })
      ).json();
      expect(cleared.next.id).toBe("agy-gemini");
    });
  });

  it("400s on an exhaustion report for a lane that is not in the ladder", async () => {
    await withProxy(cfgWith({ ladder: LADDER }), async (base) => {
      const res = await fetch(`${base}/dispatch`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ exhausted: "ghost" }),
      });
      expect(res.status).toBe(400);
    });
  });
});
