import { describe, it, expect, afterAll } from "vitest";
import { writeFileSync, mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { loadConfig, type Config } from "../src/config.js";
import { buildDispatch, type DispatchOptions } from "../src/dispatch.js";
import { detectHostRouting, parseHostRoutingState } from "../src/host-routing.js";
import { getPositionalArgs } from "../src/cli.js";

const dir = mkdtempSync(join(tmpdir(), "rp-hostadapt-"));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

const BASE = {
  listen: "127.0.0.1:8791",
  providers: {
    // The caller's own vendor passthrough: anthropic-kind, no authEnv. A relay rung pointing here
    // is reachable from ANY host as a plain subagent, which is what the transposition must respect.
    anthropic: { base: "https://api.anthropic.com", kind: "anthropic" },
    declaredPassthrough: {
      base: "https://api.anthropic.com",
      kind: "anthropic",
      credentialMode: "passthrough",
    },
    keyedAnthropic: { base: "https://keyed.test", kind: "anthropic", authEnv: "HOST_ADAPTIVE_SINGLE_KEY" },
    fleetAnthropic: {
      base: "https://fleet.test",
      kind: "anthropic",
      credentials: [{ label: "primary", authEnv: "HOST_ADAPTIVE_FLEET_KEY" }],
    },
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
  { id: "codex", kind: "cli", command: "codex", args: ["exec", "{task}"], quota: "chatgpt" },
  { id: "pools", kind: "relay", spec: "pool/coding" },
  { id: "pinned", kind: "relay", spec: "nim/z-ai/glm-5.2" },
  { id: "anthropic", kind: "relay", spec: "anthropic" },
];

const CLI_LANE = {
  command: "claude",
  args: ["-p", "--model", "{spec}", "{task}"],
  env: { ANTHROPIC_BASE_URL: "http://127.0.0.1:8791", CLAUDECODE: null },
};

let n = 0;
function cfgWith(routing: Record<string, unknown> = {}): Config {
  const p = join(dir, `c${n++}.json`);
  writeFileSync(p, JSON.stringify({ ...BASE, routing: { ...BASE.routing, ...routing } }, null, 2));
  return loadConfig(p);
}

const lane = (cfg: Config, id: string, opts: DispatchOptions = {}) =>
  buildDispatch(cfg, opts).ladder.find((l) => l.id === id)!;

describe("detectHostRouting", () => {
  it("classifies a Claude Desktop session as bypassed, naming the destination", () => {
    const r = detectHostRouting({
      CLAUDECODE: "1",
      CLAUDE_CODE_ENTRYPOINT: "claude-desktop",
      ANTHROPIC_BASE_URL: "https://api.anthropic.com",
    } as NodeJS.ProcessEnv);
    expect(r.state).toBe("bypassed");
    expect(r.entrypoint).toBe("claude-desktop");
    expect(r.reason).toContain("api.anthropic.com");
  });

  it("classifies a loopback base URL as routed even when it is a DIFFERENT port than ours", () => {
    // headroom on :8787 fronting the relay on :8791 is the supported topology here. An equality
    // test against the relay's own port would call this bypassed and transpose lanes needlessly.
    const r = detectHostRouting({ CLAUDECODE: "1", ANTHROPIC_BASE_URL: "http://127.0.0.1:8787" } as NodeJS.ProcessEnv);
    expect(r.state).toBe("routed");
  });

  it.each(["http://localhost:8791", "http://127.9.9.9:1", "http://[::1]:8791"])("treats %s as loopback", (base) => {
    expect(detectHostRouting({ CLAUDECODE: "1", ANTHROPIC_BASE_URL: base } as NodeJS.ProcessEnv).state).toBe("routed");
  });

  it("is bypassed when a harness sets no base URL at all — unset is not routed", () => {
    const r = detectHostRouting({ CLAUDECODE: "1" } as NodeJS.ProcessEnv);
    expect(r.state).toBe("bypassed");
    expect(r.reason).toContain("no ANTHROPIC_BASE_URL");
  });

  it("reports unknown outside a Claude harness — there is no subagent mechanism to adapt to", () => {
    expect(detectHostRouting({ ANTHROPIC_BASE_URL: "https://api.anthropic.com" } as NodeJS.ProcessEnv).state).toBe("unknown");
  });

  it("decides on the base URL, NOT the entrypoint name", () => {
    // A terminal session that dropped its env line is just as bypassed as Desktop, and a renamed
    // entrypoint must not silently flip the verdict. Both directions asserted.
    expect(detectHostRouting({ CLAUDECODE: "1", CLAUDE_CODE_ENTRYPOINT: "cli" } as NodeJS.ProcessEnv).state).toBe("bypassed");
    expect(
      detectHostRouting({
        CLAUDECODE: "1",
        CLAUDE_CODE_ENTRYPOINT: "claude-desktop",
        ANTHROPIC_BASE_URL: "http://127.0.0.1:8787",
      } as NodeJS.ProcessEnv).state,
    ).toBe("routed");
  });

  it("treats a blank base URL as unset rather than as a value", () => {
    expect(detectHostRouting({ CLAUDECODE: "1", ANTHROPIC_BASE_URL: "   " } as NodeJS.ProcessEnv).state).toBe("bypassed");
  });

  it("parseHostRoutingState accepts only the three states", () => {
    expect(parseHostRoutingState("bypassed")).toBe("bypassed");
    expect(parseHostRoutingState("Routed")).toBeNull();
    expect(parseHostRoutingState(undefined)).toBeNull();
  });
});

describe("transposing relay rungs for a bypassed host", () => {
  const cfg = () => cfgWith({ ladder: LADDER, cliLane: CLI_LANE });

  it("renders a pool rung as the configured CLI command, with the spec substituted", () => {
    const l = lane(cfg(), "pools", { host: "bypassed", task: "audit src/" });
    expect(l.transposed).toBe(true);
    expect(l.invoke?.command).toBe("claude");
    expect(l.invoke?.args).toEqual(["-p", "--model", "pool/coding", "audit src/"]);
  });

  it("keeps the spec on a transposed lane — the mechanism changed, the target did not", () => {
    expect(lane(cfg(), "pools", { host: "bypassed" }).spec).toBe("pool/coding");
  });

  it("leaves {task} visible when no task was given, exactly as a cli rung does", () => {
    expect(lane(cfg(), "pools", { host: "bypassed" }).invoke?.args).toContain("{task}");
  });

  it("never lets task text reach env — env is routing, not request content", () => {
    // `{task}` in an env value is now rejected at config load (see "cliLane env placeholder
    // rules"), which is the stronger guarantee. This pins the runtime half: whatever the task
    // says, no env VALUE contains any of it, and `null` unsets survive as unsets.
    const l = lane(cfg(), "pinned", { host: "bypassed", task: "rm -rf / #SENTINEL" });
    expect(Object.values(l.invoke?.env ?? {}).join("|")).not.toContain("SENTINEL");
    expect(l.invoke?.env?.CLAUDECODE).toBeNull();
  });

  it("keeps a task containing shell metacharacters inside ONE argv element", () => {
    const l = lane(cfg(), "pools", { host: "bypassed", task: "a'; rm -rf /; echo 'b" });
    expect(l.invoke?.args).toContain("a'; rm -rf /; echo 'b");
    expect(l.invoke?.args).toHaveLength(4);
  });

  it("does NOT transpose legacy omitted-mode passthrough — a plain subagent reaches it", () => {
    const c = cfg();
    const l = lane(c, "anthropic", { host: "bypassed" });
    expect(c.providers.anthropic!.credentialMode).toBeUndefined();
    expect(l.transposed).toBeUndefined();
    expect(l.invoke).toBeUndefined();
    expect(l.unreachable).toBeUndefined();
    expect(l.spec).toBe("anthropic");
  });

  it("keeps an explicitly declared passthrough reachable without the relay", () => {
    const c = cfgWith({
      ladder: [{ id: "declared", kind: "relay", spec: "declaredPassthrough" }],
      cliLane: CLI_LANE,
    });
    const l = lane(c, "declared", { host: "bypassed" });
    expect(c.providers.declaredPassthrough!.credentialMode).toBe("passthrough");
    expect(l.transposed).toBeUndefined();
    expect(l.invoke).toBeUndefined();
    expect(l.unreachable).toBeUndefined();
  });

  it("normalizes a populated Anthropic-format fleet to contained and transposes it", () => {
    const c = cfgWith({
      ladder: [{ id: "fleet", kind: "relay", spec: "fleetAnthropic" }],
      cliLane: CLI_LANE,
    });
    const l = lane(c, "fleet", { host: "bypassed" });
    expect(c.providers.fleetAnthropic!.authEnv).toBeUndefined();
    expect(c.providers.fleetAnthropic!.credentialMode).toBe("contained");
    expect(l.transposed).toBe(true);
    expect(l.invoke?.args).toEqual(["-p", "--model", "fleetAnthropic", "{task}"]);
    expect(l.unreachable).toBeUndefined();
  });

  it("continues to transpose an Anthropic-format provider with one top-level key", () => {
    const c = cfgWith({
      ladder: [{ id: "keyed", kind: "relay", spec: "keyedAnthropic" }],
      cliLane: CLI_LANE,
    });
    const l = lane(c, "keyed", { host: "bypassed" });
    expect(c.providers.keyedAnthropic!.authEnv).toBe("HOST_ADAPTIVE_SINGLE_KEY");
    expect(l.transposed).toBe(true);
    expect(l.invoke?.args).toEqual(["-p", "--model", "keyedAnthropic", "{task}"]);
  });

  it("never sets requiresDirective on a bypassed host — the directive is inert there", () => {
    // Offload OFF is exactly when the hint would fire on a routed host, so this is the case that
    // would have advised an `@relay:` line that reaches the model as literal prompt text.
    const c = cfgWith({ ladder: LADDER, cliLane: CLI_LANE, offload: { claude: { enabled: false } } });
    for (const id of ["pools", "pinned", "anthropic"]) {
      expect(lane(c, id, { host: "bypassed", client: "claude" }).requiresDirective).toBeUndefined();
    }
  });

  it("leaves a routed host completely unchanged", () => {
    const c = cfgWith({ ladder: LADDER, cliLane: CLI_LANE, offload: { claude: { enabled: false } } });
    const l = lane(c, "pools", { host: "routed", client: "claude" });
    expect(l.transposed).toBeUndefined();
    expect(l.invoke).toBeUndefined();
    expect(l.requiresDirective).toBe(true);
  });

  it("treats an absent host verdict as unknown — pre-existing behaviour is the default", () => {
    const c = cfgWith({ ladder: LADDER, cliLane: CLI_LANE, offload: { claude: { enabled: false } } });
    const view = buildDispatch(c, { client: "claude" });
    expect(view.host).toBe("unknown");
    expect(view.ladder.find((l) => l.id === "pools")?.requiresDirective).toBe(true);
    expect(view.ladder.find((l) => l.id === "pools")?.transposed).toBeUndefined();
  });
});

describe("a bypassed host with no cliLane configured", () => {
  const cfg = () => cfgWith({ ladder: LADDER });

  it("marks the rung unreachable instead of silently offering the dead subagent path", () => {
    const l = lane(cfg(), "pools", { host: "bypassed", entrypoint: "claude-desktop" });
    expect(l.unreachable).toContain("claude-desktop");
    expect(l.unreachable).toContain("routing.cliLane");
    expect(l.invoke).toBeUndefined();
  });

  it("skips unreachable rungs when choosing next, and says how many were skipped", () => {
    // codex is exhausted, so the two unreachable relay rungs are all that stand between the walk
    // and the passthrough backstop — which must still be selected.
    const view = buildDispatch(cfg(), { host: "bypassed", after: "codex" });
    expect(view.next?.id).toBe("anthropic");
  });

  it("reports the count of unreachable lanes when nothing is left", () => {
    const c = cfgWith({ ladder: LADDER.filter((r) => r.id !== "anthropic") });
    const view = buildDispatch(c, { host: "bypassed", after: "codex" });
    expect(view.next).toBeNull();
    expect(view.reason).toContain("2 unreachable");
  });

  it("still honours an explicit lane override, and says why it is blocked", () => {
    // Second-guessing an override defeats its purpose; the host asked for THIS rung. But it must
    // learn the rung is blocked here rather than discovering it as a silent no-op at spawn time.
    const view = buildDispatch(cfg(), { host: "bypassed", lane: "pools" });
    expect(view.next?.id).toBe("pools");
    expect(view.reason).toContain("host override");
    expect(view.next?.unreachable).toBeDefined();
  });
});

describe("context window substitution", () => {
  const WINDOWED_LANE = {
    command: "claude",
    args: ["-p", "--model", "{spec}", "{task}"],
    env: { MAX_CONTEXT: "{contextWindow}", BASE: "http://127.0.0.1:8791" },
  };
  // pool/coding has one member (nim/z-ai/glm-5.2); pool/mixed has two with different windows.
  const cfg = (pools: Record<string, string[]> = {}) =>
    cfgWith({
      ladder: [
        { id: "pinned", kind: "relay", spec: "nim/z-ai/glm-5.2" },
        { id: "pool", kind: "relay", spec: "pool/mixed" },
      ],
      pools: { coding: ["nim/z-ai/glm-5.2"], mixed: ["nim/a", "nim/b"], ...pools },
      cliLane: WINDOWED_LANE,
    });

  /** Keyed by the spec's model part, mirroring how a real resolver is asked. */
  const windows =
    (map: Record<string, number>, source: "provider" | "snapshot" = "provider") =>
    (spec: string) => {
      const model = spec.slice(spec.indexOf("/") + 1);
      return map[model] !== undefined ? { tokens: map[model]!, source } : null;
    };

  it("substitutes a published window into the env value", () => {
    const l = lane(cfg(), "pinned", { host: "bypassed", publishedContextWindow: windows({ "z-ai/glm-5.2": 131072 }) });
    expect(l.invoke?.env?.MAX_CONTEXT).toBe("131072");
    expect(l.contextWindow).toBe(131072);
  });

  it("DROPS the env entry when nothing published a window, rather than setting it empty", () => {
    // An empty value reads to the child as zero or garbage; omitting leaves it on its own default,
    // which is the honest outcome when nobody stated a number.
    const l = lane(cfg(), "pinned", { host: "bypassed", publishedContextWindow: () => null });
    expect(l.invoke?.env).not.toHaveProperty("MAX_CONTEXT");
    expect(l.invoke?.env?.BASE).toBe("http://127.0.0.1:8791");
    expect(l.contextWindow).toBeUndefined();
  });

  it("uses the pool MINIMUM — failover can land on any member", () => {
    const l = lane(cfg(), "pool", { host: "bypassed", publishedContextWindow: windows({ a: 1_000_000, b: 131_072 }) });
    expect(l.contextWindow).toBe(131_072);
  });

  it("an unresolvable member does NOT veto the pool — it reports the min of what IS known", () => {
    // This deliberately reverses the original rule. One model with no published figure anywhere
    // blanked three of four real pools while 28-of-29, 38-of-41 and 44-of-49 members resolved
    // fine. A pool is a routing construct; membership says nothing about any member's window, so
    // "no data on one model" must not read as "nothing known about this pool".
    const l = lane(cfg(), "pool", { host: "bypassed", publishedContextWindow: windows({ a: 1_000_000 }) });
    expect(l.contextWindow).toBe(1_000_000);
    expect(l.contextWindowUnknownMembers).toBe(1);
    expect(l.invoke?.env?.MAX_CONTEXT).toBe("1000000");
  });

  it("still reports nothing when NO member resolves — a floor over an empty set is not a floor", () => {
    const l = lane(cfg(), "pool", { host: "bypassed", publishedContextWindow: () => null });
    expect(l.contextWindow).toBeUndefined();
    expect(l.invoke?.env).not.toHaveProperty("MAX_CONTEXT");
  });

  it("omits the unknown-member count when every member resolved", () => {
    const l = lane(cfg(), "pool", { host: "bypassed", publishedContextWindow: windows({ a: 900_000, b: 500_000 }) });
    expect(l.contextWindow).toBe(500_000);
    expect(l.contextWindowUnknownMembers).toBeUndefined();
  });

  it("prefers a LEARNED ceiling over both published sources", () => {
    // The deployment refusing an over-length request is the authority on its own ceiling; a
    // published catalogue figure can be generic or stale.
    const l = lane(cfg(), "pinned", {
      host: "bypassed",
      publishedContextWindow: () => ({ tokens: 32_768, source: "observed" as const }),
    });
    expect(l.contextWindow).toBe(32_768);
    expect(l.contextWindowSource).toBe("observed");
  });

  it("ignores a nonsensical published window rather than passing it through", () => {
    for (const bad of [0, -1, Number.NaN, Number.POSITIVE_INFINITY]) {
      const l = lane(cfg(), "pinned", { host: "bypassed", publishedContextWindow: () => ({ tokens: bad, source: "provider" as const }) });
      expect(l.contextWindow).toBeUndefined();
    }
  });

  it("carries the provenance of the member that SET the minimum, not the first member", () => {
    // A pool's binding constraint is its smallest member, so that member's provenance is what
    // describes the number being reported. Ordering must not decide it.
    const l = lane(cfg(), "pool", {
      host: "bypassed",
      publishedContextWindow: (spec) =>
        spec.endsWith("/a")
          ? { tokens: 1_000_000, source: "provider" as const }
          : { tokens: 131_072, source: "snapshot" as const },
    });
    expect(l.contextWindow).toBe(131_072);
    expect(l.contextWindowSource).toBe("snapshot");
  });

  it("resolves no window at all when no lookup is supplied", () => {
    const l = lane(cfg(), "pinned", { host: "bypassed" });
    expect(l.contextWindow).toBeUndefined();
    expect(l.invoke?.env).not.toHaveProperty("MAX_CONTEXT");
  });

  it("never substitutes into env for a null (unset) entry", () => {
    const c = cfgWith({
      ladder: [{ id: "pinned", kind: "relay", spec: "nim/z-ai/glm-5.2" }],
      cliLane: { ...WINDOWED_LANE, env: { ...WINDOWED_LANE.env, UNSET_ME: null } },
    });
    const l = lane(c, "pinned", { host: "bypassed", publishedContextWindow: windows({ "z-ai/glm-5.2": 4096 }) });
    expect(l.invoke?.env?.UNSET_ME).toBeNull();
  });

  it("substitutes into args too, not only env", () => {
    const c = cfgWith({
      ladder: [{ id: "pinned", kind: "relay", spec: "nim/z-ai/glm-5.2" }],
      cliLane: { command: "claude", args: ["--ctx", "{contextWindow}", "--model", "{spec}", "{task}"] },
    });
    const l = lane(c, "pinned", { host: "bypassed", publishedContextWindow: windows({ "z-ai/glm-5.2": 8192 }) });
    expect(l.invoke?.args).toEqual(["--ctx", "8192", "--model", "nim/z-ai/glm-5.2", "{task}"]);
  });
});

describe("cliLane env placeholder rules", () => {
  it("rejects {task} in an env value — request content must not become process configuration", () => {
    const p = join(dir, `envtask${n++}.json`);
    writeFileSync(
      p,
      JSON.stringify({
        ...BASE,
        routing: {
          ...BASE.routing,
          ladder: LADDER,
          cliLane: { command: "claude", args: ["--model", "{spec}", "{task}"], env: { PROMPT: "{task}" } },
        },
      }),
    );
    // It is never substituted, so allowing it would pass the literal string `{task}` to the child
    // while the operator believed it worked.
    expect(() => loadConfig(p)).toThrow(/\{task\}/);
  });

  it("accepts {contextWindow} in an env value", () => {
    const c = cfgWith({
      ladder: LADDER,
      cliLane: { command: "claude", args: ["--model", "{spec}", "{task}"], env: { MAX: "{contextWindow}" } },
    });
    expect(c.routing.cliLane?.env?.MAX).toBe("{contextWindow}");
  });
});

describe("--host is a value-taking flag", () => {
  it("does not leak its value into the positional lane id", () => {
    // `--host` missing from VALUE_FLAGS made `--host routed` parse as the positional lane
    // "routed", so the command reported `no lane "routed" in the ladder` and every relay rung
    // silently kept its pre-existing rendering. A value flag absent from that set fails this way
    // for every flag, so the assertion is on the parser, not on dispatch.
    expect(getPositionalArgs(["node", "cli.js", "dispatch", "--host", "routed", "-t", "task"])).toEqual(["dispatch"]);
    expect(getPositionalArgs(["node", "cli.js", "dispatch", "mylane", "--host", "bypassed"])).toEqual(["dispatch", "mylane"]);
  });
});

describe("routing.cliLane validation", () => {
  const write = (cliLane: unknown): (() => Config) => {
    const p = join(dir, `bad${n++}.json`);
    writeFileSync(p, JSON.stringify({ ...BASE, routing: { ...BASE.routing, ladder: LADDER, cliLane } }, null, 2));
    return () => loadConfig(p);
  };

  it("rejects a template with no {spec} — every rung would invoke the same model", () => {
    expect(write({ command: "claude", args: ["-p", "{task}"] })).toThrow(/\{spec\}/);
  });

  it("rejects a template with no {task} — the task would never be passed", () => {
    expect(write({ command: "claude", args: ["-p", "--model", "{spec}"] })).toThrow(/\{task\}/);
  });

  it("rejects an empty command and a non-array args", () => {
    expect(write({ command: "", args: ["{spec}", "{task}"] })).toThrow(/command/);
    expect(write({ command: "claude", args: "{spec} {task}" })).toThrow(/args/);
  });

  it("rejects an invalid environment variable name", () => {
    expect(write({ command: "claude", args: ["{spec}", "{task}"], env: { "A=B": "1" } })).toThrow(/variable name/);
  });

  it("accepts absence — no template simply means no transposition is possible", () => {
    expect(cfgWith({ ladder: LADDER }).routing.cliLane).toBeUndefined();
  });
});
