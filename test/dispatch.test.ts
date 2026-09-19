import { describe, it, expect, afterAll } from "vitest";
import { writeFileSync, mkdtempSync, rmSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { loadConfig, type Config } from "../src/config.js";
import { createProxy } from "../src/server.js";
import { CONTROL_AUTHORIZATION_HEADER } from "../src/control-authorization.js";
import {
  buildDispatch,
  markExhausted,
  clearExhausted,
  MAX_EXHAUSTED_MS,
  normalizeCliCommand,
} from "../src/dispatch.js";
import { parseTelemetryReport, recordLaneRun } from "../src/dispatch-lane-stats.js";

/** Just enough of the `/dispatch` payload for the assertions below — `Response.json()` is
 *  `unknown`, and an untyped `any` here would let a renamed field pass silently. */
type DispatchBody = {
  next: { id: string; invoke: { command: string; args: string[] } };
  ladder: Array<{ id: string; state: string; readyAt?: string }>;
};

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

/**
 * `env` on a cli rung is what makes a `claude -p` lane declarable at all: a terminal-spawned
 * `claude` honours ANTHROPIC_BASE_URL (Claude Desktop pins its own sessions to api.anthropic.com,
 * so shelling out IS the redirect), and the nested-session variables must be unset or the child
 * inherits the parent harness's wiring. Set and unset are therefore both first-class here.
 */
describe("dispatch ladder — cli rung env", () => {
  const rungWith = (env: unknown) => ({
    id: "claude-pool",
    kind: "cli",
    command: "claude",
    args: ["-p", "--model", "pool/coding", "{task}"],
    env,
  });

  it("accepts string (set) and null (unset) values and surfaces both on invoke", () => {
    const env = { ANTHROPIC_BASE_URL: "http://127.0.0.1:8791", ANTHROPIC_API_KEY: null };
    const view = buildDispatch(cfgWith({ ladder: [rungWith(env)] }), { task: "count the files" });
    expect(view.next?.invoke?.env).toEqual(env);
  });

  it("never substitutes the task placeholder into env values", () => {
    const view = buildDispatch(cfgWith({ ladder: [rungWith({ NOTE: "around {task} here" })] }), { task: "INJECTED" });
    // The args got the task; the env value keeps its braces verbatim — it is routing, not prompt.
    expect(view.next?.invoke?.args).toContain("INJECTED");
    expect(view.next?.invoke?.env).toEqual({ NOTE: "around {task} here" });
  });

  it("omits an empty env object from the parsed rung", () => {
    const view = buildDispatch(cfgWith({ ladder: [rungWith({})] }), { task: "t" });
    expect(view.next?.invoke?.env).toBeUndefined();
  });

  it("rejects an env that is not an object", () => {
    expect(() => cfgWith({ ladder: [rungWith("ANTHROPIC_BASE_URL=x")] })).toThrow(/env must be an object/);
    expect(() => cfgWith({ ladder: [rungWith(["A=b"])] })).toThrow(/env must be an object/);
  });

  it("rejects a value that is neither string nor null", () => {
    expect(() => cfgWith({ ladder: [rungWith({ PORT: 8791 })] })).toThrow(/string \(set\) or null \(unset\)/);
  });

  it("rejects variable names containing '=', whitespace or control characters", () => {
    for (const name of ["A=B", "A B", "A\u001bB", ""]) {
      expect(() => cfgWith({ ladder: [rungWith({ [name]: "x" })] })).toThrow(/invalid variable name/);
    }
  });
});

/**
 * `DispatchLane.maxConcurrent` (backlog item "a per-lane CONCURRENCY cap on cli dispatch rungs",
 * 2026-09-09) — the config-declared cap carried onto the VIEW so a reader can see it before any
 * job has run against the rung. What the WALK does with it (the skip, the reason, the rendered
 * `in flight:` count) is pinned in test/mcp-server.test.ts; this is only about what `toLane`
 * carries onto `DispatchLane` from `LadderRung`.
 */
describe("dispatch ladder — maxConcurrent on the view", () => {
  it("carries a configured cap onto the lane", () => {
    const view = buildDispatch(cfgWith({ ladder: [{ id: "capped", kind: "cli", command: "agy", args: ["{task}"], maxConcurrent: 2 }] }));
    expect(view.next?.maxConcurrent).toBe(2);
    expect(view.ladder[0]?.maxConcurrent).toBe(2);
  });

  it("is null on the view when unconfigured — unbounded, byte for byte the pre-existing behaviour", () => {
    const view = buildDispatch(cfgWith({ ladder: [{ id: "uncapped", kind: "cli", command: "agy", args: ["{task}"] }] }));
    expect(view.next?.maxConcurrent).toBeNull();
  });

  it("is null on a relay lane, which has no such config field", () => {
    const view = buildDispatch(cfgWith({ ladder: [{ id: "r", kind: "relay", spec: "anthropic" }] }));
    expect(view.next?.maxConcurrent).toBeNull();
  });

  it("with no maxConcurrent anywhere in the ladder, every lane's rendering is byte-for-byte unchanged", () => {
    // Pins design note 3: default unbounded must not alter what an operator sees when they never
    // touch this feature. Two uncapped cli rungs plus a relay rung, none of them at any risk of a
    // skip — this is the config-load half of that guarantee; the walk half (no skip record) is
    // pinned in test/mcp-server.test.ts.
    const view = buildDispatch(cfgWith({
      ladder: [
        { id: "a", kind: "cli", command: "agy", args: ["{task}"] },
        { id: "b", kind: "cli", command: "codex", args: ["exec", "{task}"] },
        { id: "c", kind: "relay", spec: "anthropic" },
      ],
    }));
    for (const lane of view.ladder) expect(lane.maxConcurrent).toBeNull();
  });
});

describe("dispatch ladder — ordering", () => {
  it("selects tier-specific ladders and infers coding from the default subagent pool", () => {
    const ladders = {
      reasoning: [{ id: "agy", kind: "cli", command: "agy", args: ["{task}", "--model", "gemini-high"] }],
      coding: [{ id: "codex", kind: "cli", command: "codex", args: ["exec", "--model", "luna", "{task}"] }],
      fast: [{ id: "agy", kind: "cli", command: "agy", args: ["{task}", "--model", "gemini-low"] }],
    };
    const cfg = cfgWith({ ladders, subagents: { default: "pool/coding" } });

    expect(buildDispatch(cfg).tier).toBe("coding");
    expect(buildDispatch(cfg).next?.id).toBe("codex");
    expect(buildDispatch(cfg, { tier: "reasoning" }).next?.invoke?.args).toContain("gemini-high");
    expect(buildDispatch(cfg, { tier: "fast" }).next?.invoke?.args).toContain("gemini-low");
    expect(buildDispatch(cfg, { tier: "missing" }).reason).toContain("have: reasoning, coding, fast");
  });

  it("picks the first rung and renders its command with the task substituted", () => {
    const view = buildDispatch(cfgWith({ ladder: LADDER }), { task: "trace parseConfig" });
    expect(view.next?.id).toBe("agy-gemini");
    expect(view.next?.invoke).toEqual({
      command: process.platform === "win32" ? "agy.exe" : "agy",
      args: ["-p", "trace parseConfig", "--model", "g-flash"],
    });
  });

  it("names the headless AGY executable in structured Windows dispatch output", () => {
    const cfg = cfgWith({ ladder: LADDER });
    expect(buildDispatch(cfg, { task: "inspect" }, "win32").next?.invoke?.command).toBe("agy.exe");
    expect(buildDispatch(cfg, { task: "inspect" }, "linux").next?.invoke?.command).toBe("agy");
  });

  it("normalizes only a bare AGY command on Windows", () => {
    expect(normalizeCliCommand("agy", "win32")).toBe("agy.exe");
    expect(normalizeCliCommand("AGY", "win32")).toBe("AGY.exe");
    expect(normalizeCliCommand("agy.exe", "win32")).toBe("agy.exe");
    expect(normalizeCliCommand("C:\\tools\\agy", "win32")).toBe("C:\\tools\\agy");
    expect(normalizeCliCommand("./agy", "win32")).toBe("./agy");
    expect(normalizeCliCommand("codex", "win32")).toBe("codex");
    expect(normalizeCliCommand("agy", "darwin")).toBe("agy");
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
    // `maxConcurrent` joined the shape on 2026-09-09 (the per-lane concurrency cap, rendered even
    // when `null`). The retired `attemptBudget` field left with the idle-only walk. The
    // guarantee this test exists for is the two assertions BELOW — the task stays inside one argv
    // element and no field carries a pre-joined command line — so a new structured field is an
    // update, not a weakening. Keep the exact-key list: it is what would catch a convenience
    // "commandLine" string.
    expect(Object.keys(lane).sort()).toEqual(["id", "invoke", "kind", "maxConcurrent", "position", "quota", "state"]);
    expect(lane.invoke?.args).toEqual(["-p", "rm -rf /; echo $(whoami)", "--model", "g-flash"]);
    for (const value of Object.values(view)) {
      expect(typeof value === "string" ? value : "").not.toContain("rm -rf /;");
    }
  });
});

describe("dispatch ladder — endpoint", () => {
  const controlToken = "dispatch-test-control-token";
  async function withProxy<T>(cfg: Config, fn: (base: string) => Promise<T>): Promise<T> {
    const proxy = createProxy(cfg, { controlAuthorization: { validate: (candidate) => candidate === controlToken } });
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
      const first = (await (await fetch(`${base}/dispatch?task=go`)).json()) as DispatchBody;
      expect(first.next.id).toBe("agy-gemini");
      expect(first.next.invoke.command).toBe(process.platform === "win32" ? "agy.exe" : "agy");
      expect(first.next.invoke.args).toContain("go");

      const walked = (await (
        await fetch(`${base}/dispatch`, {
          method: "POST",
          headers: { "content-type": "application/json", [CONTROL_AUTHORIZATION_HEADER]: controlToken },
          body: JSON.stringify({ exhausted: "agy-gemini" }),
        })
      ).json()) as DispatchBody;
      expect(walked.next.id).toBe("agy-claude");

      const cleared = (await (
        await fetch(`${base}/dispatch`, {
          method: "POST",
          headers: { "content-type": "application/json", [CONTROL_AUTHORIZATION_HEADER]: controlToken },
          body: JSON.stringify({ clear: true }),
        })
      ).json()) as DispatchBody;
      expect(cleared.next.id).toBe("agy-gemini");
    });
  });

  it("400s on an exhaustion report for a lane that is not in the ladder", async () => {
    await withProxy(cfgWith({ ladder: LADDER }), async (base) => {
      const res = await fetch(`${base}/dispatch`, {
        method: "POST",
        headers: { "content-type": "application/json", [CONTROL_AUTHORIZATION_HEADER]: controlToken },
        body: JSON.stringify({ exhausted: "ghost" }),
      });
      expect(res.status).toBe(400);
    });
  });

  it("carries requester, mode and model from the query string into the view (2026-09-10)", async () => {
    await withProxy(cfgWith({ ladder: LADDER }), async (base) => {
      // The MCP server's own view: the Anthropic pass-through is unreachable there, with the reason.
      const mcp = (await (await fetch(`${base}/dispatch?requester=mcp`)).json()) as {
        order: string[];
        ladder: Array<{ id: string; unreachable?: string }>;
      };
      expect(mcp.ladder.find((l) => l.id === "anthropic")?.unreachable).toContain("the MCP server cannot run");
      expect(mcp.order).not.toContain("anthropic");
      // A caller-named model: one ad-hoc lane.
      const named = (await (await fetch(`${base}/dispatch?model=pool%2Fcoding&mode=answer`)).json()) as {
        order: string[];
        next: { id: string; adHoc?: boolean };
      };
      expect(named.order).toEqual(["model:pool/coding"]);
      expect(named.next.adHoc).toBe(true);
    });
  });

  // A rate limit and a spent quota reset on different clocks, so the host can now say WHICH
  // happened. The relay still never invents the signal — outcome only picks the default wait,
  // and an explicit retryAfterMs (the vendor's own number) beats it.
  it("quota_exhausted cools the lane for ~1h, not the 15m rate-limit default", async () => {
    await withProxy(cfgWith({ ladder: LADDER }), async (base) => {
      const before = Date.now();
      const walked = (await (
        await fetch(`${base}/dispatch`, {
          method: "POST",
          headers: { "content-type": "application/json", [CONTROL_AUTHORIZATION_HEADER]: controlToken },
          body: JSON.stringify({ exhausted: "agy-gemini", outcome: "quota_exhausted" }),
        })
      ).json()) as DispatchBody;
      const lane = walked.ladder.find((l) => l.id === "agy-gemini")!;
      expect(lane.state).toBe("exhausted");
      const waitMs = new Date(lane.readyAt!).getTime() - before;
      expect(waitMs).toBeGreaterThan(55 * 60 * 1000);
      expect(waitMs).toBeLessThan(65 * 60 * 1000);
    });
  });

  it("an explicit retryAfterMs beats the outcome default — the vendor knows its own reset", async () => {
    await withProxy(cfgWith({ ladder: LADDER }), async (base) => {
      const before = Date.now();
      const walked = (await (
        await fetch(`${base}/dispatch`, {
          method: "POST",
          headers: { "content-type": "application/json", [CONTROL_AUTHORIZATION_HEADER]: controlToken },
          body: JSON.stringify({ exhausted: "agy-gemini", outcome: "quota_exhausted", retryAfterMs: 120_000 }),
        })
      ).json()) as DispatchBody;
      const lane = walked.ladder.find((l) => l.id === "agy-gemini")!;
      const waitMs = new Date(lane.readyAt!).getTime() - before;
      expect(waitMs).toBeGreaterThan(60_000);
      expect(waitMs).toBeLessThan(180_000);
    });
  });

  it("400s an unknown outcome instead of guessing a cooldown for it", async () => {
    await withProxy(cfgWith({ ladder: LADDER }), async (base) => {
      const res = await fetch(`${base}/dispatch`, {
        method: "POST",
        headers: { "content-type": "application/json", [CONTROL_AUTHORIZATION_HEADER]: controlToken },
        body: JSON.stringify({ exhausted: "agy-gemini", outcome: "vibes_off" }),
      });
      expect(res.status).toBe(400);
      expect((await res.text())).toContain("rate_limited");
    });
  });
});

describe("tier-keyed time-to-answer history", () => {
  const WALK = { attemptMinSamples: 5 };

  function cfgWithTiers(): Config {
    const rung = { id: "slow", kind: "cli", command: "a", args: ["{task}"] };
    return cfgWith({ dispatchWalk: WALK, ladders: { low: [{ ...rung }], high: [{ ...rung }] } });
  }

  function recordOn(cfg: Config, tier: string | null, durationsMs: readonly number[]): void {
    durationsMs.forEach((ms, i) => {
      const parsed = parseTelemetryReport({
        jobId: `job-${tier ?? "legacy"}-${i}`, laneId: "slow", kind: "cli",
        ...(tier === null ? {} : { tier }), wallClockMs: ms, exitCode: 0, status: "completed",
        estimatedInputTokens: 1, estimatedOutputTokens: 1,
      });
      if (!parsed) throw new Error("fixture telemetry report rejected");
      recordLaneRun(cfg, parsed, 1_700_000_000_000 + i);
    });
  }

  function timeOf(cfg: Config, tier: string) {
    return buildDispatch(cfg, { tier }).ladder.find((l) => l.id === "slow")?.timeToAnswer;
  }

  it("runs recorded under low do not become high history", () => {
    const cfg = cfgWithTiers();
    recordOn(cfg, "low", [200_000, 210_000, 220_000, 230_000, 240_000, 250_000]);
    expect(timeOf(cfg, "low")).toEqual({ medianMs: 225_000, p80Ms: 240_000, samples: 6, mode: null });
    expect(timeOf(cfg, "high")).toBeUndefined();
  });

  it("below the sample floor the tier falls back to one legacy window", () => {
    const cfg = cfgWithTiers();
    recordOn(cfg, null, [300_000, 310_000, 320_000, 330_000, 340_000, 350_000]);
    recordOn(cfg, "high", [10_000, 11_000]);
    expect(timeOf(cfg, "high")).toEqual({ medianMs: 325_000, p80Ms: 340_000, samples: 6, mode: null });
  });

  it("with no legacy window, thin tier history is still reported rather than fabricated", () => {
    const cfg = cfgWithTiers();
    recordOn(cfg, "high", [600_000, 600_000]);
    expect(timeOf(cfg, "high")).toEqual({ medianMs: 600_000, p80Ms: 600_000, samples: 2, mode: null });
  });

  it("the advisory stats column stays a per-lane aggregate across tiers", () => {
    const cfg = cfgWithTiers();
    recordOn(cfg, "low", [10_000, 11_000]);
    recordOn(cfg, "high", [20_000, 21_000, 22_000]);
    const lane = buildDispatch(cfg, { tier: "low" }).ladder.find((l) => l.id === "slow");
    expect(lane?.stats).toMatchObject({ calls: 5, successes: 5 });
  });
});
