import { describe, it, expect, afterAll, beforeEach } from "vitest";
import { writeFileSync, mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { loadConfig, type Config } from "../src/config.js";
import { createProxy } from "../src/server.js";
import { buildDispatch, markExhausted, clearExhausted } from "../src/dispatch.js";

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

// Cooldowns are module-level runtime state; a leak between tests would make order matter.
beforeEach(() => clearExhausted(cfgWith({ ladder: LADDER })));

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
