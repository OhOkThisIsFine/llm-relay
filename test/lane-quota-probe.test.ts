/**
 * The lane quota probe: fail-safe in BOTH directions. Only a real answer retracts a recorded
 * death; only an explicit rate/quota statement records one; everything else changes nothing.
 */
import { describe, expect, it } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  buildLaneProbeInvocation,
  classifyLaneProbeOutput,
  defaultLaneProbeSpawner,
  laneQuotaTargets,
  runLaneQuotaProbe,
  LANE_PROBE_PROMPT,
  type LaneProbeSpawnResult,
} from "../src/lane-quota-probe.js";
import { loadConfig, type Config } from "../src/config.js";
import { quoteCmdArg } from "../src/lane-probe.js";

function result(partial: Partial<LaneProbeSpawnResult>): LaneProbeSpawnResult {
  return { code: 0, stdout: "", stderr: "", timedOut: false, ...partial };
}

function ladderConfig(): Config {
  const dir = mkdtempSync(join(tmpdir(), "llm-relay-lqp-"));
  const path = join(dir, "config.json");
  writeFileSync(
    path,
    JSON.stringify({
      listen: "127.0.0.1:8791",
      providers: { anthropic: { base: "https://api.anthropic.com", kind: "anthropic", credentialMode: "passthrough" } },
      routing: {
        default: "anthropic",
        ladders: {
          low: [
            // Two rungs, one quota bucket: one probe target, not two.
            { id: "codex-sol", kind: "cli", quota: "codex", command: "codex", args: ["exec", "--model", "gpt-5.6-sol", "{task}"] },
            { id: "codex-spark", kind: "cli", quota: "codex", command: "codex", args: ["exec", "--model", "gpt-5.3-codex-spark", "{task}"] },
            // Disabled rung, own bucket: still a probe target — disabled is a dispatch choice,
            // not a statement about the balance.
            { id: "codex-terra", kind: "cli", quota: "terra", enabled: false, command: "codex", args: ["exec", "{task}"] },
            // Wrapped lane: recognition must see through the wrapper command.
            {
              id: "agy-opus",
              kind: "cli",
              quota: "agy-opus",
              command: "pwsh",
              args: ["-File", "C:\\bin\\lane-launch.ps1", "C:\\agy\\agy.exe", "-p", "{task}"],
              env: { CLAUDE_CONFIG_DIR: "C:\\probe-home", CLAUDECODE: null },
            },
            // (A rung with no {task} placeholder is unrepresentable: config load refuses it, so
            // the enumeration's placeholder filter is belt-and-braces for hand-built configs.)
            // Not a recognizable lane — skipped.
            { id: "other", kind: "cli", quota: "other", command: "some-other-cli", args: ["{task}"] },
            { id: "anthropic", kind: "relay", spec: "anthropic" },
          ],
        },
      },
    }),
  );
  const cfg = loadConfig(path);
  rmSync(dir, { recursive: true, force: true });
  return cfg;
}

describe("classifyLaneProbeOutput", () => {
  it("a real answer is alive", () => {
    expect(classifyLaneProbeOutput(result({ code: 0, stdout: "OK\n" }))).toEqual({ kind: "alive" });
  });

  it("⚠ exit 0 with EMPTY output is inconclusive — the agy discard mode is not quota evidence", () => {
    expect(classifyLaneProbeOutput(result({ code: 0, stdout: "  \n" })).kind).toBe("inconclusive");
  });

  it("⚠ a timeout is inconclusive — slowness is not quota evidence", () => {
    expect(classifyLaneProbeOutput(result({ code: null, timedOut: true, stderr: "killed" })).kind).toBe("inconclusive");
  });

  it("⚠ an unrecognized failure records NOTHING — a miss learns nothing", () => {
    const v = classifyLaneProbeOutput(result({ code: 1, stderr: "segfault in llama_context" }));
    expect(v.kind).toBe("inconclusive");
  });

  it("an explicit quota statement is quota_exhausted, and the word quota WINS over limit wording", () => {
    // The 0.28.0 lesson facing this way: "You exceeded your current quota ... rate limit" is a
    // spent allowance, not throughput back-pressure.
    const v = classifyLaneProbeOutput(
      result({ code: 1, stderr: "You exceeded your current quota. Check your plan; rate limit docs: ..." }),
    );
    expect(v.kind).toBe("exhausted");
    expect(v.kind === "exhausted" && v.outcome).toBe("quota_exhausted");
  });

  it("an explicit rate-limit statement is rate_limited", () => {
    const v = classifyLaneProbeOutput(result({ code: 1, stderr: "HTTP 429: too many requests" }));
    expect(v.kind).toBe("exhausted");
    expect(v.kind === "exhausted" && v.outcome).toBe("rate_limited");
  });

  it("carries a vendor-stated retry window, and only a recognized one", () => {
    const stated = classifyLaneProbeOutput(result({ code: 1, stderr: "usage limit reached — try again in 2 hours" }));
    expect(stated.kind === "exhausted" && stated.retryAfterMs).toBe(2 * 3_600_000);
    const unstated = classifyLaneProbeOutput(result({ code: 1, stderr: "usage limit reached, try again at dawn" }));
    expect(unstated.kind === "exhausted" && unstated.retryAfterMs).toBeNull();
  });
});

describe("laneQuotaTargets", () => {
  it("enumerates one target per bucket, disabled rungs included, unprobeable rungs skipped", () => {
    const targets = laneQuotaTargets(ladderConfig());
    expect(targets.map((t) => t.key)).toEqual(["quota:codex", "quota:terra", "quota:agy-opus"]);
    // The shared bucket kept its FIRST rung.
    expect(targets[0]!.rung.id).toBe("codex-sol");
    expect(targets[2]!.lane).toBe("agy");
  });
});

describe("buildLaneProbeInvocation", () => {
  it("substitutes {task} in args ONLY and applies env deltas in both directions", () => {
    const target = laneQuotaTargets(ladderConfig())[2]!;
    const inv = buildLaneProbeInvocation(target);
    expect(inv.command).toBe("pwsh");
    expect(inv.args).toContain(LANE_PROBE_PROMPT);
    expect(inv.args).not.toContain("{task}");
    expect(inv.env["CLAUDE_CONFIG_DIR"]).toBe("C:\\probe-home");
    // `null` unsets an inherited variable — the nested-session trap.
    expect("CLAUDECODE" in inv.env).toBe(false);
  });
});

describe("quoteCmdArg (the shell-fallback line)", () => {
  it("⚠ keeps a spaced prompt ONE token and escapes embedded quotes", () => {
    // Measured live on v0.59.1: the unquoted join handed codex the probe prompt as seven
    // arguments (`error: unexpected argument 'with' found`) and the quota probe never learned.
    expect(quoteCmdArg(LANE_PROBE_PROMPT)).toBe(`"${LANE_PROBE_PROMPT}"`);
    expect(quoteCmdArg('say "hi"')).toBe('"say \\"hi\\""');
    const line = ["exec", LANE_PROBE_PROMPT].map(quoteCmdArg).join(" ");
    expect(line).toBe(`"exec" "${LANE_PROBE_PROMPT}"`);
  });
});

describe("defaultLaneProbeSpawner", () => {
  it("⚠ refuses to spawn under vitest — a suite must never spend real lane quota", async () => {
    const out = await defaultLaneProbeSpawner("codex", ["exec", "hi"], { env: {}, timeoutMs: 1000 });
    expect(out.code).toBeNull();
    expect(out.stderr).toContain("disabled under vitest");
    // And the classifier reads that refusal as inconclusive, never as evidence.
    expect(classifyLaneProbeOutput(out).kind).toBe("inconclusive");
  });
});

describe("runLaneQuotaProbe", () => {
  it("threads the invocation through the injected spawner and classifies the result", async () => {
    const calls: Array<{ command: string; args: string[] }> = [];
    const { verdict } = await runLaneQuotaProbe(laneQuotaTargets(ladderConfig())[0]!, {
      spawn: (command, args) => {
        calls.push({ command, args });
        return Promise.resolve(result({ code: 0, stdout: "OK" }));
      },
    });
    expect(verdict).toEqual({ kind: "alive" });
    expect(calls).toHaveLength(1);
    expect(calls[0]!.command).toBe("codex");
    expect(calls[0]!.args).toEqual(["exec", "--model", "gpt-5.6-sol", LANE_PROBE_PROMPT]);
  });
});
