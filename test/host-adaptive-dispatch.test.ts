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
  env: { ANTHROPIC_BASE_URL: "http://127.0.0.1:8791", CLAUDECODE: null, TASK_LOOKALIKE: "{task}" },
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

  it("never substitutes placeholders into env values — env is routing, not task content", () => {
    const l = lane(cfg(), "pinned", { host: "bypassed", task: "rm -rf /" });
    expect(l.invoke?.env?.TASK_LOOKALIKE).toBe("{task}");
    expect(l.invoke?.env?.CLAUDECODE).toBeNull();
  });

  it("keeps a task containing shell metacharacters inside ONE argv element", () => {
    const l = lane(cfg(), "pools", { host: "bypassed", task: "a'; rm -rf /; echo 'b" });
    expect(l.invoke?.args).toContain("a'; rm -rf /; echo 'b");
    expect(l.invoke?.args).toHaveLength(4);
  });

  it("does NOT transpose the caller's own vendor passthrough — a plain subagent reaches it", () => {
    const l = lane(cfg(), "anthropic", { host: "bypassed" });
    expect(l.transposed).toBeUndefined();
    expect(l.invoke).toBeUndefined();
    expect(l.unreachable).toBeUndefined();
    expect(l.spec).toBe("anthropic");
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
