import { describe, it, expect, beforeEach, afterEach, afterAll, vi } from "vitest";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { spawnSync } from "node:child_process";
import { createServer } from "node:http";
import {
  ARITY_EXEMPT,
  ARITY_GUARDED_COMMANDS,
  CLI_COMMAND_NAMES,
  commandArityError,
  argValue,
  hasFlag,
  splitSpec,
  getPositionalArgs,
  main,
  quoteArg,
  renderCommand,
  shellFor,
  parseRenderShell,
  SHELL_LABEL,
  classifyCommand,
  normalizeDispatchCommands,
  resolveDispatchView,
  proxyUrl,
  run,
  runDispatch,
  runCooldowns,
  runOffload,
  runStop,
  runConfigCommand,
  runPools,
  runRoutingCommand,
  runEligibility,
  formatCandidateQuota,
  formatCandidateHardCap,
  formatKeyQuota,
  commandOptionError,
  runTelemetry,
  reportMcpExhaustion,
  reportMcpTelemetry,
  runCostCommand,
  type CostCommandDependencies,
  FLAG_ALIASES,
  CLI_OPTIONS,
  ACTION_OPTIONS,
  VALUE_FLAGS,
} from "../src/cli.js";
import { loadConfig, type Config } from "../src/config.js";
import { createAccountingStore, type AccountingStore } from "../src/accounting-store.js";
import type { RequestCompletedEvent } from "../src/accounting.js";
import { assertCostReportV1 } from "../src/dashboard-contract.js";
import { ModelCatalog } from "../src/catalog.js";
import { interpretRefusal, pendingRefusals, proposeInterpretation, recordUnknownRefusal, refusalSignature, resetInterpretations, signatureDigest } from "../src/refusal-interpretation.js";

describe("cli helper utilities", () => {
  const origArgv = process.argv;

  beforeEach(() => {
    process.argv = [...origArgv];
  });

  afterEach(() => {
    process.argv = origArgv;
  });

  it("formats IPv4, hostnames, and IPv6 listener URLs", () => {
    expect(proxyUrl({ host: "127.0.0.1", port: 8791 }, "/health")).toBe("http://127.0.0.1:8791/health");
    expect(proxyUrl({ host: "localhost", port: 8791 }, "/health")).toBe("http://localhost:8791/health");
    expect(proxyUrl({ host: "::1", port: 8791 }, "/health")).toBe("http://[::1]:8791/health");
  });

  it("rejects unknown and wrong-command options without exposing values", () => {
    expect(commandOptionError(["node", "cli.js", "telemetry", "--bogus", "secret"])).toContain("unsupported option");
    expect(commandOptionError(["node", "cli.js", "pools", "--proeb"])).toContain("unsupported option");
    expect(commandOptionError(["node", "cli.js", "dispatch", "--next-command"])).toBeNull();
    expect(commandOptionError(["node", "cli.js", "cost", "--config", "secret.json"])).toContain("unsupported option");
    expect(commandOptionError(["node", "cli.js", "offload", "status", "--scope", "all"])).toContain("unsupported option");
    expect(commandOptionError(["node", "cli.js", "pools", "show", "--probe"])).toContain("unsupported option");
    expect(commandOptionError(["node", "cli.js", "pools", "list", "--probe", "--json"])).toBeNull();
    expect(commandOptionError(["node", "cli.js", "pools", "remove", "x", "--include", "free", "--effort", "low"])).toBeNull();
    expect(commandOptionError(["node", "cli.js", "telemetry", "--bogus", "secret"])).not.toContain("secret");
  });

  it("short-circuits help/version and leaves strict parsers to keys/cooldowns", () => {
    expect(commandOptionError(["node", "cli.js", "telemetry", "--bogus", "--help"])).toBeNull();
    expect(commandOptionError(["node", "cli.js", "pools", "--bogus", "--version"])).toBeNull();
    expect(commandOptionError(["node", "cli.js", "keys", "--bogus"])).toBeNull();
    expect(commandOptionError(["node", "cli.js", "cooldowns", "clear", "x", "--bogus"])).toBeNull();
    expect(commandOptionError(["node", "cli.js", "models", "-provider", "nim", "-refresh"])).toBeNull();
  });

  it("has an explicit option-policy result for every CLI command", () => {
    const exempt = new Set(["keys", "cooldowns", "help", "version"]);
    for (const command of CLI_COMMAND_NAMES) {
      if (exempt.has(command)) {
        expect(commandOptionError(["node", "cli.js", command, "--future"])).toBeNull();
      } else {
        expect(commandOptionError(["node", "cli.js", command, "--future"])).toContain("unsupported option");
      }
    }
    expect([...exempt].every((name) => CLI_COMMAND_NAMES.has(name))).toBe(true);
  });

  it("accepts short aliases -t and -x on dispatch option guard", () => {
    expect(commandOptionError(["node", "cli.js", "dispatch", "--next-command", "-t", "probe"])).toBeNull();
    expect(commandOptionError(["node", "cli.js", "dispatch", "-x", "free-pool"])).toBeNull();
  });

  it("rejects unknown short flag -q on dispatch as unsupported option", () => {
    expect(commandOptionError(["node", "cli.js", "dispatch", "-q"])).toBe("llm-relay dispatch: unsupported option");
  });

  it("accepts short flags advertised by help (-p on models and ping, -r on models)", () => {
    expect(commandOptionError(["node", "cli.js", "models", "-p", "nim"])).toBeNull();
    expect(commandOptionError(["node", "cli.js", "ping", "-p", "nim"])).toBeNull();
    expect(commandOptionError(["node", "cli.js", "models", "-r"])).toBeNull();
  });

  it("walks the alias table and asserts each short alias passes the guard for every command allowing the long flag", () => {
    let testedCount = 0;
    for (const [longFlag, shortAliases] of Object.entries(FLAG_ALIASES)) {
      for (const [command, allowed] of Object.entries(CLI_OPTIONS)) {
        if (allowed.includes(longFlag)) {
          for (const alias of shortAliases) {
            const argv = VALUE_FLAGS.has(alias)
              ? ["node", "cli.js", command, alias, "probe-val"]
              : ["node", "cli.js", command, alias];
            const err = commandOptionError(argv);
            expect(err, `expected command "${command}" to accept alias "${alias}" for "${longFlag}"`).toBeNull();
            testedCount += 1;
          }
        }
      }
      for (const [command, actions] of Object.entries(ACTION_OPTIONS)) {
        for (const [action, allowed] of Object.entries(actions)) {
          if (allowed.includes(longFlag)) {
            for (const alias of shortAliases) {
              const argv = VALUE_FLAGS.has(alias)
                ? ["node", "cli.js", command, action, alias, "probe-val"]
                : ["node", "cli.js", command, action, alias];
              const err = commandOptionError(argv);
              expect(err, `expected action "${command} ${action}" to accept alias "${alias}" for "${longFlag}"`).toBeNull();
              testedCount += 1;
            }
          }
        }
      }
    }
    expect(testedCount).toBeGreaterThan(0);
  });

  it("derives VALUE_FLAGS with identical membership to the historical snapshot", () => {
    const expectedValueFlags = [
      "--after",
      "--by",
      "--class",
      "--client",
      "--config",
      "--cost-class",
      "--credential",
      "--default",
      "--effort",
      "--env-name",
      "--exhausted",
      "--host",
      "--import",
      "--include",
      "--label",
      "--lane",
      "--listen",
      "--members",
      "--mode",
      "--out",
      "--outcome",
      "--provider",
      "--rationale",
      "--repo",
      "--reset-field",
      "--reset-ms",
      "--retry-after-ms",
      "--scope",
      "--shell",
      "--sig",
      "--task",
      "--tier",
      "--window",
      "-after",
      "-by",
      "-c",
      "-class",
      "-client",
      "-config",
      "-cost-class",
      "-credential",
      "-d",
      "-default",
      "-effort",
      "-env-name",
      "-exhausted",
      "-host",
      "-import",
      "-include",
      "-l",
      "-label",
      "-lane",
      "-listen",
      "-m",
      "-members",
      "-mode",
      "-out",
      "-outcome",
      "-p",
      "-provider",
      "-rationale",
      "-repo",
      "-reset-field",
      "-reset-ms",
      "-retry-after-ms",
      "-scope",
      "-shell",
      "-sig",
      "-t",
      "-task",
      "-tier",
      "-window",
      "-x",
    ];
    expect([...VALUE_FLAGS].sort()).toEqual(expectedValueFlags);
  });

  it("ensures every short alias present in VALUE_FLAGS also appears in FLAG_ALIASES", () => {
    const allAliases = new Set(Object.values(FLAG_ALIASES).flat());
    const shortAliasesInValueFlags = [...VALUE_FLAGS].filter((flag) => /^-[a-zA-Z0-9]$/.test(flag));
    expect(shortAliasesInValueFlags.length).toBeGreaterThan(0);
    for (const short of shortAliasesInValueFlags) {
      expect(
        allAliases.has(short),
        `short flag "${short}" in VALUE_FLAGS must be defined in FLAG_ALIASES`,
      ).toBe(true);
    }
  });

  it("prints live telemetry first and falls back on connection, status, and JSON failures", async () => {
    const cfg = { host: "127.0.0.1", port: 8791 } as Config;
    const output: string[] = [];
    const fetchMock = vi.spyOn(globalThis, "fetch");
    fetchMock.mockResolvedValueOnce(new Response('{"live":true}', {
      status: 200,
      headers: { "content-type": "application/json" },
    }));
    await runTelemetry({ loadConfig: () => cfg, write: (s) => output.push(s) });
    expect(JSON.parse(output.join("")).live).toBe(true);

    const failures = [
      ["connection", () => fetchMock.mockRejectedValueOnce(new Error("refused"))],
      ["non-2xx", () => fetchMock.mockResolvedValueOnce(new Response("unavailable", { status: 503 }))],
      ["malformed-json", () => fetchMock.mockResolvedValueOnce(new Response("{", { status: 200 }))],
    ] as const;
    for (const [failure, arrange] of failures) {
      let localCalls = 0;
      let writes = 0;
      output.length = 0;
      arrange();
      await runTelemetry({
        loadConfig: () => cfg,
        localReport: () => { localCalls++; return { fallback: failure }; },
        write: (s) => { writes++; output.push(s); },
      });
      expect(JSON.parse(output.join("")).fallback).toBe(failure);
      expect(localCalls).toBe(1);
      expect(writes).toBe(1);
    }
    fetchMock.mockRestore();
  });

  it("reports MCP exhaustion with exact dispatch payload", async () => {
    const cfg = { host: "127.0.0.1", port: 8791 } as Config;
    const calls: Array<{ path: string; init: RequestInit }> = [];
    const request = async (_cfg: Config, path: string, init: RequestInit): Promise<unknown | null> => { calls.push({ path, init }); return { ok: true }; };
    await reportMcpExhaustion(cfg, { laneId: "codex", tier: "high", outcome: "quota_exhausted", retryAfterMs: 1234 }, request);
    expect(calls[0]!.path).toBe("/dispatch");
    expect(calls[0]!.init.method).toBe("POST");
    expect(calls[0]!.init.headers).toEqual({ "content-type": "application/json" });
    expect(JSON.parse(String(calls[0]!.init.body))).toEqual({ exhausted: "codex", tier: "high", outcome: "quota_exhausted", retryAfterMs: 1234 });
    await reportMcpExhaustion(cfg, { laneId: "agy", tier: undefined, outcome: "rate_limited" }, request);
    expect(JSON.parse(String(calls[1]!.init.body))).toEqual({ exhausted: "agy", outcome: "rate_limited" });
    await expect(reportMcpExhaustion(cfg, { laneId: "x", tier: undefined, outcome: "rate_limited" }, async () => null)).rejects.toThrow("no proxy running");
  });

  it("reports MCP telemetry best-effort: POSTs /dispatch/telemetry, false (never throw) with no proxy", async () => {
    const cfg = { host: "127.0.0.1", port: 8791 } as Config;
    const calls: Array<{ path: string; init: RequestInit }> = [];
    const request = async (_cfg: Config, path: string, init: RequestInit): Promise<unknown | null> => { calls.push({ path, init }); return { ok: true }; };
    const report = {
      jobId: "job-1",
      laneId: "agy",
      kind: "cli" as const,
      wallClockMs: 123,
      exitCode: 0,
      status: "completed" as const,
      estimatedInputTokens: 10,
      estimatedOutputTokens: 20,
    };
    await expect(reportMcpTelemetry(cfg, report, request)).resolves.toBe(true);
    expect(calls[0]!.path).toBe("/dispatch/telemetry");
    expect(calls[0]!.init.method).toBe("POST");
    expect(calls[0]!.init.headers).toEqual({ "content-type": "application/json" });
    expect(JSON.parse(String(calls[0]!.init.body))).toEqual(report);
    // No proxy listening: false, not a throw — a lost telemetry row changes only a ledger.
    await expect(reportMcpTelemetry(cfg, report, async () => null)).resolves.toBe(false);
    await expect(reportMcpTelemetry(cfg, report, async () => { throw new Error("refused"); })).resolves.toBe(false);
  });

  it("normalizes AGY in structured output returned by an older live proxy", () => {
    const oldView = {
      tier: "coding",
      offload: true,
      client: "default",
      ladder: [{ id: "agy", kind: "cli" as const, position: 1, state: "ready" as const, invoke: { command: "agy", args: ["-p", "task"] } }],
      next: { id: "agy", kind: "cli" as const, position: 1, state: "ready" as const, invoke: { command: "agy", args: ["-p", "task"] } },
      order: ["agy"],
      reason: "first lane",
    };

    expect(normalizeDispatchCommands(oldView, "win32").next?.invoke?.command).toBe("agy.exe");
    expect(normalizeDispatchCommands(oldView, "linux").next?.invoke?.command).toBe("agy");
  });

  it("getPositionalArgs extracts non-flag positional arguments correctly", () => {
    expect(getPositionalArgs(["node", "cli.ts", "--config", "custom.json", "offload", "status"])).toEqual(["offload", "status"]);
    expect(getPositionalArgs(["node", "cli.ts", "-c=custom.json", "dispatch", "-t", "task", "lane1"])).toEqual(["dispatch", "lane1"]);
    expect(getPositionalArgs(["node", "cli.ts", "--refresh", "models"])).toEqual(["models"]);
    expect(getPositionalArgs(["node", "cli.ts", "--config", "custom.json"])).toEqual([]);
  });

  it("splitSpec correctly parses provider and model", () => {
    expect(splitSpec("nim/meta/llama-3")).toEqual({ provider: "nim", model: "meta/llama-3" });
    expect(splitSpec("openai")).toEqual({ provider: "openai", model: undefined });
  });

  it("argValue extracts values with double dash --flag value", () => {
    process.argv = ["node", "cli.ts", "--config", "custom.json"];
    expect(argValue("--config", "-c")).toBe("custom.json");
  });

  it("treats --import's file as a flag value, not an onboard positional", () => {
    process.argv = ["node", "cli.js", "onboard", "--import", "keys.env", "--force"];
    expect(argValue("--import")).toBe("keys.env");
    expect(getPositionalArgs()).toEqual(["onboard"]);
  });

  it("argValue extracts values with single dash -flag value", () => {
    process.argv = ["node", "cli.ts", "-config", "custom.json"];
    expect(argValue("--config", "-c")).toBe("custom.json");
  });

  it("argValue extracts values with short flag -c value", () => {
    process.argv = ["node", "cli.ts", "-c", "custom.json"];
    expect(argValue("--config", "-c")).toBe("custom.json");
  });

  it("argValue extracts values with equals syntax --flag=value and -flag=value", () => {
    process.argv = ["node", "cli.ts", "--config=foo.json"];
    expect(argValue("--config", "-c")).toBe("foo.json");

    process.argv = ["node", "cli.ts", "-config=bar.json"];
    expect(argValue("--config", "-c")).toBe("bar.json");

    process.argv = ["node", "cli.ts", "-c=baz.json"];
    expect(argValue("--config", "-c")).toBe("baz.json");
  });

  it("does not reinterpret an option value that looks like a later flag", () => {
    process.argv = [
      "node", "cli.ts", "--config=real.json", "dispatch",
      "-t", "--config=prompt.json", "--exhausted", "codex",
    ];

    expect(argValue("--task", "-t")).toBe("--config=prompt.json");
    expect(argValue("--config", "-c")).toBe("real.json");
    expect(argValue("--exhausted", "-x")).toBe("codex");
    expect(getPositionalArgs()).toEqual(["dispatch"]);
  });

  it("consumes a flag-shaped task while still parsing normal flags before and after it", () => {
    process.argv = [
      "node", "cli.ts", "--client", "claude", "dispatch",
      "-t", "--exhausted=prompt", "--config", "real.json", "--exhausted=codex",
    ];

    expect(argValue("--client")).toBe("claude");
    expect(argValue("--task", "-t")).toBe("--exhausted=prompt");
    expect(argValue("--config", "-c")).toBe("real.json");
    expect(argValue("--exhausted", "-x")).toBe("codex");
    expect(hasFlag("--exhausted", "-x")).toBe(true);
  });

  it("hasFlag returns true for double dash, single dash, short form, and equals syntax", () => {
    process.argv = ["node", "cli.ts", "--refresh"];
    expect(hasFlag("--refresh", "-r")).toBe(true);

    process.argv = ["node", "cli.ts", "-refresh"];
    expect(hasFlag("--refresh", "-r")).toBe(true);

    process.argv = ["node", "cli.ts", "-r"];
    expect(hasFlag("--refresh", "-r")).toBe(true);

    process.argv = ["node", "cli.ts", "--help=true"];
    expect(hasFlag("--help", "-h")).toBe(true);

    process.argv = ["node", "cli.ts", "-h"];
    expect(hasFlag("--help", "-h")).toBe(true);

    process.argv = ["node", "cli.ts", "--other"];
    expect(hasFlag("--refresh", "-r")).toBe(false);
  });

  it("main exits 0 and prints help when invoked with help or --help", () => {
    const stdoutSpy = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
    const exitSpy = vi.spyOn(process, "exit").mockImplementation((code) => {
      throw new Error(`exit:${code}`);
    });

    process.argv = ["node", "cli.ts", "help"];
    expect(() => main()).toThrow("exit:0");
    expect(stdoutSpy).toHaveBeenCalledWith(expect.stringContaining("llm-relay — loopback Anthropic/OpenAI proxy"));

    stdoutSpy.mockRestore();
    exitSpy.mockRestore();
  });

  it("keeps help commands and explanations in aligned columns", () => {
    const out: string[] = [];
    const stdoutSpy = vi.spyOn(process.stdout, "write").mockImplementation((chunk) => {
      out.push(String(chunk));
      return true;
    });
    const exitSpy = vi.spyOn(process, "exit").mockImplementation((code) => {
      throw new Error(`exit:${code}`);
    });

    process.argv = ["node", "cli.ts", "help"];
    expect(() => main()).toThrow("exit:0");
    const help = out.join("");

    const aligned = [
      { label: "llm-relay [options]", description: "Start proxy" },
        { label: "llm-relay setup [target]", description: "claude-desktop: MCP dispatch" },
      { label: "llm-relay dispatch [lane] [options]", description: "Choose next dispatch lane" },
    ].map(({ label, description }) => {
      const line = help.split("\n").find((candidate) => candidate.includes(label) && candidate.includes(description));
      expect(line).toBeDefined();
      return line!.indexOf(description);
    });

    expect(new Set(aligned).size).toBe(1);
    expect(help).toContain("GET|POST /dispatch");
    expect(help).toContain('POST {"exhausted":"<lane>"}');
    expect(help).toContain("llm-relay cooldowns clear <provider>[/<model>] [--credential <label>]");
    expect(help).toContain("POST /cooldowns/clear");
    expect(help).not.toContain("Commands:");
    expect(help).not.toContain("llm-relay offload on|off");
    expect(help).not.toContain("                                                   the command");

    stdoutSpy.mockRestore();
    exitSpy.mockRestore();
  });

  it("main routes subcommands correctly even when flags precede the subcommand", () => {
    const stdoutSpy = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
    const exitSpy = vi.spyOn(process, "exit").mockImplementation((code) => {
      throw new Error(`exit:${code}`);
    });

    process.argv = ["node", "cli.ts", "--config", "custom.json", "version"];
    expect(() => main()).toThrow("exit:0");
    expect(stdoutSpy).toHaveBeenCalledWith(expect.stringMatching(/\d+\.\d+\.\d+/));

    stdoutSpy.mockRestore();
    exitSpy.mockRestore();
  });

  it("main exits 0 and prints version when invoked with version or --version", () => {
    const stdoutSpy = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
    const exitSpy = vi.spyOn(process, "exit").mockImplementation((code) => {
      throw new Error(`exit:${code}`);
    });

    process.argv = ["node", "cli.ts", "--version"];
    expect(() => main()).toThrow("exit:0");
    expect(stdoutSpy).toHaveBeenCalledWith(expect.stringMatching(/\d+\.\d+\.\d+/));

    stdoutSpy.mockRestore();
    exitSpy.mockRestore();
  });
});

describe("candidate quota rendering", () => {
  it("never prints the key checker's percent without its basis and credit-limit figures", () => {
    // `llm-relay keys` has no typed observation, only a relay-computed percent over the
    // provider-stated credit limit/usage (`fetchProviderQuota`) — so it must say what it
    // is rather than print a bare number.
    expect(formatKeyQuota(80)).toBe(
      " | Quota: 80% of credit limit left (relay-derived from provider-stated limit/usage)",
    );
    expect(formatKeyQuota(null)).toBe("");
    expect(formatKeyQuota(undefined)).toBe("");
  });

  it("prints each typed axis/period with raw values, basis, age, and unknown as dash", () => {
    expect(formatCandidateQuota([], 10_000)).toBe("-");
    expect(formatCandidateQuota([
      {
        axis: "requests", period: "day", remaining: 25, limit: 100,
        resetsAt: null, observedAt: 8_000, basis: "provider-stated",
      },
      {
        axis: "tokens", period: "minute", remaining: 800, limit: 1_000,
        resetsAt: null, observedAt: 9_500, basis: "provider-stated",
      },
      { axis: "requests", period: "unknown", remaining: 4, limit: 10,
        resetsAt: null, observedAt: 10_000, basis: "provider-stated" },
    ], 10_000)).toBe(
      "requests/day 25/100 provider-stated age 2s; tokens/minute 800/1000 provider-stated age 0s; requests/- 4/10 provider-stated age 0s",
    );
  });

  /**
   * G2: the `CAPPED ...` line `llm-relay candidates` prints under a row whose operator-set hard
   * cap is REACHED. Null when it is not — an unreached cap is config detail, and that table is
   * routing state. Both provenance labels come off the wire object: `operator-declared` (this is
   * an assertion, not a measurement) and the SCOPE the usage was counted at.
   */
  it("renders a reached hard cap with its basis and scope, and nothing when there is none", () => {
    expect(formatCandidateHardCap(null, 10_000)).toBeNull();
    expect(formatCandidateHardCap({
      axis: "requests", period: "day", cap: 450, used: 450,
      basis: "operator-declared", source: "credential", scope: "credential",
      resetsAt: new Date(70_000).toISOString(), resetsAtBasis: "derived-boundary",
    }, 10_000)).toBe("CAPPED requests/day 450/450 (operator-declared, credential-scope, resets in 60s)");
    // A per-deployment cap says so, because "450 of 450" means something different at each scope.
    expect(formatCandidateHardCap({
      axis: "tokens", period: "minute", cap: 2_000_000, used: 2_400_000,
      basis: "operator-declared", source: "credential-model", scope: "deployment",
      resetsAt: new Date(10_000).toISOString(), resetsAtBasis: "derived-boundary",
    }, 10_000)).toBe("CAPPED tokens/minute 2400000/2000000 (operator-declared, deployment-scope, resets in 0s)");
  });
});

/**
 * ARC-6a02bffc / INV-CS-7 — `llm-relay dispatch` prints a command line the host is told to run
 * VERBATIM, with caller-supplied task text inside it. Nothing constrained this side before.
 *
 * `dispatch.ts` hands over `{ command, args }` and deliberately never a pre-joined string; the
 * renderer is where quoting has to happen, because it is the only layer that knows which shell.
 */
describe("dispatch command rendering — shell quoting", () => {
  // Spaces, a command separator, a pipe, a substitution, both quote characters, a glob.
  const NASTY = `fix the bug & rm -rf / ; echo $(whoami) "dq" 'sq' | tee *.log`;

  it("leaves an unambiguous token alone", () => {
    expect(quoteArg("agy", "sh")).toBe("agy");
    expect(quoteArg("-p", "sh")).toBe("-p");
    expect(quoteArg("--model", "pwsh")).toBe("--model");
    expect(quoteArg("g-flash", "pwsh")).toBe("g-flash");
    expect(quoteArg("C:\\tools\\agy.exe", "pwsh")).toBe("C:\\tools\\agy.exe");
  });

  it("quotes anything outside the allow-list, including the empty string", () => {
    expect(quoteArg("", "sh")).toBe("''");
    expect(quoteArg("", "pwsh")).toBe("''");
    expect(quoteArg("two words", "sh")).toBe("'two words'");
    expect(quoteArg("a&b", "sh")).toBe("'a&b'");
    expect(quoteArg("$(whoami)", "sh")).toBe("'$(whoami)'");
    // `@` and `%` are allow-listed in neither: PowerShell splatting, cmd.exe expansion.
    expect(quoteArg("@args", "pwsh")).toBe("'@args'");
    expect(quoteArg("%PATH%", "pwsh")).toBe("'%PATH%'");
    // Backslashes in sh mode must be quoted so sh does not strip them as escape characters.
    expect(quoteArg("C:\\tools\\agy.exe", "sh")).toBe("'C:\\tools\\agy.exe'");
  });

  it("escapes an embedded single quote the way each shell requires", () => {
    // sh: close, escape, reopen. pwsh: double it.
    expect(quoteArg("it's", "sh")).toBe("'it'\\''s'");
    expect(quoteArg("it's", "pwsh")).toBe("'it''s'");
  });

  it("neutralizes ESC so the printed line cannot rewrite the operator's terminal", () => {
    const withEsc = `safe\u001b[2Kmalicious`;
    expect(quoteArg(withEsc, "sh")).not.toContain("\u001b");
    expect(quoteArg(withEsc, "sh")).toContain("\uFFFD");
    // Tab and newline are legal inside both literal forms and a multi-line task is real.
    expect(quoteArg("a\nb\tc", "sh")).toBe("'a\nb\tc'");
  });

  it("renders the task as ONE element and never args.join(' ')", () => {
    const invoke = { command: "agy", args: ["-p", NASTY, "--model", "g-flash"] };

    for (const shell of ["sh", "pwsh"] as const) {
      const line = renderCommand(invoke, shell);
      // The forbidden result, spelled out.
      expect(line).not.toBe(`${invoke.command} ${invoke.args.join(" ")}`);
      expect(line).not.toContain(`-p ${NASTY}`);
      // The flags stay bare and readable; only the task is wrapped.
      expect(line.startsWith(`${shell === "pwsh" ? "agy.exe" : "agy"} -p '`)).toBe(true);
      expect(line.endsWith("' --model g-flash")).toBe(true);
    }
  });

  it("bypasses a same-named PowerShell function for the AGY headless CLI", () => {
    const invoke = { command: "agy", args: ["-p", "inspect"] };
    expect(renderCommand(invoke, "pwsh")).toBe("agy.exe -p inspect");
    expect(renderCommand(invoke, "sh")).toBe("agy -p inspect");
    expect(renderCommand({ command: "C:\\tools\\agy", args: ["inspect"] }, "pwsh")).toBe("C:\\tools\\agy inspect");
    expect(renderCommand({ command: "codex", args: ["exec", "inspect"] }, "pwsh")).toBe("codex exec inspect");
  });

  it("puts PowerShell's call operator in front of a command name that needed quoting", () => {
    const invoke = { command: "C:\\Program Files\\agy.exe", args: ["run"] };
    expect(renderCommand(invoke, "pwsh")).toBe("& 'C:\\Program Files\\agy.exe' run");
    // sh needs no call operator — a quoted word in command position is still a command.
    expect(renderCommand({ command: "my agent", args: ["run"] }, "sh")).toBe("'my agent' run");
  });

  it("picks the shell the host is actually going to paste into", () => {
    expect(shellFor("win32")).toBe("pwsh");
    expect(shellFor("linux")).toBe("sh");
    expect(shellFor("darwin")).toBe("sh");
  });

  it("renders nothing for a cli rung with no invoke", () => {
    expect(renderCommand(undefined, "sh")).toBe("");
  });

  it("renders env on the same runnable line — env(1) for sh, $env:/Remove-Item for pwsh", () => {
    const invoke = {
      command: "claude",
      args: ["-p", "count files"],
      // Insertion order mixed on purpose: unsets must be grouped first regardless.
      env: { ANTHROPIC_BASE_URL: "http://127.0.0.1:8791", ANTHROPIC_API_KEY: null, TOKEN: "a b'c" },
    };
    expect(renderCommand(invoke, "sh")).toBe(
      "env -u ANTHROPIC_API_KEY ANTHROPIC_BASE_URL=http://127.0.0.1:8791 'TOKEN=a b'\\''c' claude -p 'count files'",
    );
    expect(renderCommand(invoke, "pwsh")).toBe(
      "Remove-Item Env:ANTHROPIC_API_KEY -ErrorAction SilentlyContinue; " +
        "$env:ANTHROPIC_BASE_URL = 'http://127.0.0.1:8791'; $env:TOKEN = 'a b''c'; claude -p 'count files'",
    );
  });

  it("always quotes a pwsh env VALUE — bare words are commands in expression position", () => {
    // `abc` passes the shell-safe allow-list, so quoteArg would leave it bare — correct for an
    // argv element, a parse error after `$env:X =`. The assignment form must quote regardless.
    expect(renderCommand({ command: "c", args: ["a"], env: { X: "abc" } }, "pwsh")).toBe("$env:X = 'abc'; c a");
  });

  it("renders no env prefix for an absent or empty env", () => {
    expect(renderCommand({ command: "c", args: ["a"] }, "sh")).toBe("c a");
    expect(renderCommand({ command: "c", args: ["a"], env: {} }, "sh")).toBe("c a");
  });

  /** The env property proven by a real shell: the child sees the set value and NOT the unset one. */
  it("env survives a real shell — set applied, unset removed", () => {
    const dir = mkdtempSync(join(tmpdir(), "rp-env-"));
    try {
      const shell = shellFor();
      const probe = "console.log(JSON.stringify([process.env.RP_ENV_SET ?? null, process.env.RP_ENV_UNSET ?? null]))";
      const line = renderCommand(
        {
          command: process.execPath,
          args: ["-e", probe],
          env: { RP_ENV_SET: "value with 'quote", RP_ENV_UNSET: null },
        },
        shell,
      );
      const script = join(dir, shell === "pwsh" ? "run.ps1" : "run.sh");
      writeFileSync(script, line + "\n");
      const res =
        shell === "pwsh"
          ? spawnSync("pwsh", ["-NoProfile", "-NonInteractive", "-File", script], {
              encoding: "utf8",
              env: { ...process.env, RP_ENV_UNSET: "leaked" },
            })
          : spawnSync("sh", [script], { encoding: "utf8", env: { ...process.env, RP_ENV_UNSET: "leaked" } });
      expect(res.error).toBeUndefined();
      expect(res.status).toBe(0);
      expect(JSON.parse(res.stdout.trim())).toEqual(["value with 'quote", null]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("names the shell version it targets, because 5.1 and 7 disagree", () => {
    // Not cosmetic. Windows PowerShell 5.1 does not escape an embedded `"` when it builds the
    // command line for a native exe, so a correctly single-quoted argument containing one
    // arrives SPLIT. pwsh 7 is correct. A reader must be able to tell which one this is for.
    expect(SHELL_LABEL.pwsh).toContain("7+");
    expect(SHELL_LABEL.sh).toBe("sh/bash");
  });

  it("--shell overrides the platform guess and rejects anything else", () => {
    expect(parseRenderShell("sh")).toBe("sh");
    expect(parseRenderShell("bash")).toBe("sh");
    expect(parseRenderShell("PowerShell")).toBe("pwsh");
    expect(parseRenderShell(undefined)).toBeNull();

    // A typo must not silently fall back to the platform default and render for the wrong shell.
    const err = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    const exit = vi.spyOn(process, "exit").mockImplementation((() => {
      throw new Error("exit:1");
    }) as never);
    expect(() => parseRenderShell("cmd")).toThrow("exit:1");
    expect(err).toHaveBeenCalledWith(expect.stringContaining('expects "sh" or "pwsh"'));
    err.mockRestore();
    exit.mockRestore();
  });

  /**
   * The property itself, proven by a real shell rather than by string comparison: run the
   * rendered line and count what the program actually received. This is the assertion the
   * finding asks for — "survives as exactly ONE argv element" — and it is what caught the
   * PowerShell 5.1 divergence in the first place.
   */
  it("survives a real shell as exactly one argv element", () => {
    const dir = mkdtempSync(join(tmpdir(), "rp-quote-"));
    try {
      const shell = shellFor();
      const echoArgs = "console.log(JSON.stringify(process.argv.slice(1)))";
      const line = renderCommand({ command: process.execPath, args: ["-e", echoArgs, NASTY] }, shell);

      // Written to a script file rather than passed as a -c/-Command argument: that keeps the
      // test measuring OUR quoting instead of Node's own child_process argv escaping.
      const script = join(dir, shell === "pwsh" ? "run.ps1" : "run.sh");
      writeFileSync(script, line + "\n");

      // `pwsh`, not `powershell.exe` — the label says 7+ and this is the claim being checked.
      const res =
        shell === "pwsh"
          ? spawnSync("pwsh", ["-NoProfile", "-NonInteractive", "-File", script], { encoding: "utf8" })
          : spawnSync("sh", [script], { encoding: "utf8" });

      expect(res.error).toBeUndefined();
      expect(res.status).toBe(0);
      expect(JSON.parse(res.stdout.trim())).toEqual([NASTY]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  /** The same proof for the other shell, so CI (Linux) and this host each cover both renderings. */
  it("survives sh as exactly one argv element on any platform", () => {
    const sh = spawnSync("sh", ["-c", "echo ok"], { encoding: "utf8" });
    if (sh.error) return; // no POSIX shell here; the platform-native case above still ran
    const dir = mkdtempSync(join(tmpdir(), "rp-quote-sh-"));
    try {
      const echoArgs = "console.log(JSON.stringify(process.argv.slice(1)))";
      const line = renderCommand({ command: process.execPath, args: ["-e", echoArgs, NASTY] }, "sh");
      const script = join(dir, "run.sh");
      writeFileSync(script, line + "\n");
      const res = spawnSync("sh", [script], { encoding: "utf8" });
      expect(res.status).toBe(0);
      expect(JSON.parse(res.stdout.trim())).toEqual([NASTY]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

/** The renderer is only a fix if `llm-relay dispatch` actually goes through it. */
describe("llm-relay dispatch — printed ladder", () => {
  const dir = mkdtempSync(join(tmpdir(), "rp-cli-dispatch-"));
  afterAll(() => rmSync(dir, { recursive: true, force: true }));
  const origArgv = process.argv;
  afterEach(() => {
    process.argv = origArgv;
    vi.restoreAllMocks();
  });

  const CONFIG = {
    listen: "127.0.0.1:8791",
    providers: { anthropic: { base: "https://api.anthropic.com", kind: "anthropic" } },
    routing: {
      default: "anthropic",
      tiers: { opus: "anthropic", sonnet: "anthropic", haiku: "anthropic", fable: "anthropic" },
      benchmarkSort: false,
      ladder: [{ id: "agy-gemini", kind: "cli", command: "agy", args: ["-p", "{task}", "--model", "g-flash"] }],
    },
    mode: "detect",
    log: { level: "silent", file: null },
  };

  it("quotes the task in the line it tells the host to run", async () => {
    const cfgPath = join(dir, "config.json");
    writeFileSync(cfgPath, JSON.stringify(CONFIG, null, 2));

    // No proxy is contacted: a real one may well be listening on this developer's loopback,
    // and a test that reads it would report whatever that process happens to think.
    vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("no proxy in tests"));

    const task = "audit the & pipeline; report";
    process.argv = ["node", "cli.ts", "dispatch", "--config", cfgPath, "--task", task];

    const out: string[] = [];
    vi.spyOn(process.stdout, "write").mockImplementation((chunk) => {
      out.push(String(chunk));
      return true;
    });

    await runDispatch(undefined);
    const printed = out.join("");

    // Quoting agrees between sh and pwsh for a task with no single quote in it. On Windows the
    // package names the executable explicitly so a same-named PowerShell function cannot win.
    const command = process.platform === "win32" ? "agy.exe" : "agy";
    expect(printed).toContain(`run: ${command} -p '${task}' --model g-flash`);
    // The defect: the raw join put `; report` outside the quotes as its own shell command.
    expect(printed).not.toContain(`${command} -p ${task} --model g-flash`);
    expect(printed).toMatch(/quoted for (PowerShell 7\+ \(pwsh\)|sh\/bash)/);
  });

  const dispatchCfgPath = join(dir, "dispatch-test-config.json");
  writeFileSync(dispatchCfgPath, JSON.stringify({
    ...CONFIG,
    routing: {
      ...CONFIG.routing,
      ladder: [
        {
          id: "agy-gemini",
          kind: "cli",
          command: "agy",
          args: ["-p", "{task}", "--model", "g-flash"],
          enabled: true,
        },
      ],
    },
  }, null, 2));
  const dispatchConfig = loadConfig(dispatchCfgPath);

  it("does NOT put task into GET /dispatch query string, avoiding URL length caps for long tasks", async () => {
    const longTask = "a".repeat(5000);
    let capturedUrl: string | null = null;
    vi.spyOn(globalThis, "fetch").mockImplementation(async (input) => {
      capturedUrl = String(input);
      return new Response(JSON.stringify({
        tier: "medium",
        offload: false,
        client: "default",
        host: "bypassed",
        ladder: [{
          id: "agy-gemini",
          kind: "cli",
          position: 1,
          state: "ready",
          invoke: { command: "agy", args: ["-p", "{task}", "--model", "g-flash"] },
        }],
        next: {
          id: "agy-gemini",
          kind: "cli",
          position: 1,
          state: "ready",
          invoke: { command: "agy", args: ["-p", "{task}", "--model", "g-flash"] },
        },
        reason: "first ready lane",
      }), { status: 200, headers: { "content-type": "application/json" } });
    });

    const view = await resolveDispatchView({ task: longTask, cfg: dispatchConfig });
    expect(capturedUrl).not.toBeNull();
    expect(capturedUrl).not.toContain("task=");
    expect(view.source).toBe("daemon");
    expect(view.task).toBe(longTask);
    expect(view.next?.invoke?.args).toEqual(["-p", longTask, "--model", "g-flash"]);
  });

  it("marks source: 'local-fallback' when daemon is offline", async () => {
    vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("offline"));
    const view = await resolveDispatchView({ task: "hello", cfg: dispatchConfig });
    expect(view.source).toBe("local-fallback");
    expect(view.task).toBe("hello");
    expect(view.next?.invoke?.args).toEqual(["-p", "hello", "--model", "g-flash"]);
  });
});

describe("llm-relay cooldowns clear — live control mutation", () => {
  const dir = mkdtempSync(join(tmpdir(), "rp-cli-cooldowns-"));
  const originalArgv = process.argv;
  const responseBody = {
    target: { provider: "anthropic", model: "claude-sonnet", credential: "backup" },
    cleared: {
      breakerCells: {
        count: 1,
        items: [{ provider: "anthropic", model: "claude-sonnet", credential: "backup" }],
      },
      credentialFaults: { count: 0, items: [] },
      facts: {
        count: 1,
        items: [{
          kind: "rate-limited",
          scope: {
            kind: "attempt",
            provider: "anthropic",
            model: "claude-sonnet",
            credentialId: "anthropic#backup",
          },
        }],
      },
    },
  };

  const configAt = (listen: string) => ({
    listen,
    providers: { anthropic: { base: "https://api.anthropic.com", kind: "anthropic" } },
    routing: {
      default: "anthropic/claude-sonnet",
      tiers: {
        opus: "anthropic/claude-sonnet",
        sonnet: "anthropic/claude-sonnet",
        haiku: "anthropic/claude-sonnet",
        fable: "anthropic/claude-sonnet",
      },
      benchmarkSort: false,
    },
    repair: { maxAttempts: 2, destructiveTools: [] },
    mode: "detect",
    log: { level: "silent", file: null },
  });

  afterEach(() => {
    process.argv = originalArgv;
    vi.restoreAllMocks();
  });

  afterAll(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it("posts the scoped clear to a running relay with its installed control token", async () => {
    type CapturedRequest = {
      method: string | undefined;
      url: string | undefined;
      headers: Record<string, string | string[] | undefined>;
      body: string;
    };
    let completeRequest!: (request: CapturedRequest) => void;
    const requestReceived = new Promise<CapturedRequest>((resolve) => {
      completeRequest = resolve;
    });
    const server = createServer((req, res) => {
      const chunks: Buffer[] = [];
      req.on("data", (chunk: Buffer) => chunks.push(chunk));
      req.on("end", () => {
        completeRequest({
          method: req.method,
          url: req.url,
          headers: req.headers,
          body: Buffer.concat(chunks).toString("utf8"),
        });
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify(responseBody));
      });
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));

    try {
      const address = server.address();
      if (address === null || typeof address === "string") throw new Error("missing test listener");
      const configPath = join(dir, "config.json");
      writeFileSync(configPath, JSON.stringify(configAt(`127.0.0.1:${address.port}`), null, 2));
      process.argv = [
        "node", "cli.ts", "--config", configPath,
        "cooldowns", "clear", "anthropic/claude-sonnet", "--credential", "backup",
      ];
      const output: string[] = [];
      vi.spyOn(process.stdout, "write").mockImplementation((chunk) => {
        output.push(String(chunk));
        return true;
      });

      await runCooldowns("clear", "anthropic/claude-sonnet");

      const request = await requestReceived;
      expect(request.method).toBe("POST");
      expect(request.url).toBe("/cooldowns/clear");
      expect(request.headers["content-type"]).toBe("application/json");
      expect(request.headers["x-llm-relay-control-token"]).toMatch(/^[A-Za-z0-9_-]{43}$/);
      expect(JSON.parse(request.body)).toEqual({
        provider: "anthropic",
        model: "claude-sonnet",
        credential: "backup",
      });
      expect(output.join("")).toContain("Cleared cooldown state for anthropic/claude-sonnet [credential backup]");
      expect(output.join("")).toContain("breaker cells: 1");
      expect(output.join("")).toContain("cooling facts: 1");
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });

  it("exits 1 when no relay answers", async () => {
    const configPath = join(dir, "offline-config.json");
    writeFileSync(configPath, JSON.stringify(configAt("127.0.0.1:65534"), null, 2));
    process.argv = ["node", "cli.ts", "--config", configPath, "cooldowns", "clear", "anthropic"];
    vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("offline"));
    const stderr = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    vi.spyOn(process, "exit").mockImplementation((code) => {
      throw new Error(`exit:${code}`);
    });

    await expect(runCooldowns("clear", "anthropic")).rejects.toThrow("exit:1");
    expect(stderr).toHaveBeenCalledWith(expect.stringContaining("relay must be running"));
  });

  it("rejects a missing credential label instead of widening the clear", async () => {
    process.argv = ["node", "cli.ts", "cooldowns", "clear", "anthropic", "--credential"];
    const request = vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("must not fetch"));
    const stderr = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    vi.spyOn(process, "exit").mockImplementation((code) => {
      throw new Error(`exit:${code}`);
    });

    await expect(runCooldowns("clear", "anthropic")).rejects.toThrow("exit:1");
    expect(stderr).toHaveBeenCalledWith(expect.stringContaining("--credential requires a value"));
    expect(request).not.toHaveBeenCalled();
  });

  it.each([
    [
      "an unknown flag",
      ["cooldowns", "clear", "anthropic", "--credentail=backup"],
      "unknown option",
    ],
    [
      "duplicate command flags",
      ["cooldowns", "clear", "anthropic", "--credential", "backup", "--credential=primary"],
      "duplicate option",
    ],
    [
      "duplicate aliases for one global flag",
      ["--config", "one.json", "-c", "two.json", "cooldowns", "clear", "anthropic"],
      "duplicate option",
    ],
    [
      "a boolean flag with a value",
      ["cooldowns", "clear", "anthropic", "--json=true"],
      "does not take a value",
    ],
    [
      "an extra positional",
      ["cooldowns", "clear", "anthropic", "claude-sonnet"],
      "usage:",
    ],
    [
      "a missing target positional",
      ["cooldowns", "clear"],
      "usage:",
    ],
  ])("rejects %s before sending a clear request", async (_case, args, message) => {
    process.argv = ["node", "cli.ts", ...args];
    const request = vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("must not fetch"));
    const stderr = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    vi.spyOn(process, "exit").mockImplementation((code) => {
      throw new Error(`exit:${code}`);
    });

    await expect(runCooldowns(undefined, undefined)).rejects.toThrow("exit:1");
    expect(stderr).toHaveBeenCalledWith(expect.stringContaining(message));
    expect(request).not.toHaveBeenCalled();
  });

  it.each([
    ["a typoed flag and its stray value", ["--credentail", "backup", "cooldowns", "clear", "anthropic"]],
    ["a missing value for a recognized flag", ["--credential", "cooldowns", "clear", "anthropic"]],
  ])("routes %s before the command into fail-closed entrypoint parsing", (_case, args) => {
    process.argv = ["node", "cli.ts", ...args];
    const request = vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("must not fetch"));
    const stderr = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    vi.spyOn(process, "exit").mockImplementation((code) => {
      throw new Error(`exit:${code}`);
    });

    expect(() => main()).toThrow("exit:1");
    expect(stderr).toHaveBeenCalled();
    expect(request).not.toHaveBeenCalled();
  });

  it("rejects malformed clear argv before the update gate can send any request", async () => {
    process.argv = ["node", "cli.ts", "cooldowns", "clear", "anthropic", "extra"];
    const request = vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("must not fetch"));
    vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    vi.spyOn(process, "exit").mockImplementation((code) => {
      throw new Error(`exit:${code}`);
    });

    await expect(run()).rejects.toThrow("exit:1");
    expect(request).not.toHaveBeenCalled();
  });

  it.each([
    [
      "a target missing one requested optional field",
      {
        ...responseBody,
        target: { provider: "anthropic", model: "claude-sonnet" },
      },
    ],
    [
      "a same-shape target with a mismatched selector value",
      {
        ...responseBody,
        target: { provider: "anthropic", model: "claude-sonnet", credential: "primary" },
      },
    ],
    [
      "a malformed breaker cell",
      {
        ...responseBody,
        cleared: {
          ...responseBody.cleared,
          breakerCells: { count: 1, items: [null] },
        },
      },
    ],
    [
      "a fact outside the cooling-kind allow-list",
      {
        ...responseBody,
        cleared: {
          ...responseBody.cleared,
          facts: {
            count: 1,
            items: [{
              kind: "context-limit",
              scope: responseBody.cleared.facts.items[0]!.scope,
            }],
          },
        },
      },
    ],
    [
      "a malformed discriminated fact scope",
      {
        ...responseBody,
        cleared: {
          ...responseBody.cleared,
          facts: {
            count: 1,
            items: [{
              kind: "rate-limited",
              scope: {
                kind: "attempt",
                provider: "anthropic",
                model: "claude-sonnet",
              },
            }],
          },
        },
      },
    ],
    [
      "a structurally valid item outside the requested target",
      {
        ...responseBody,
        cleared: {
          ...responseBody.cleared,
          breakerCells: {
            count: 1,
            items: [{ provider: "anthropic", model: "other-model", credential: "backup" }],
          },
        },
      },
    ],
    [
      "a structurally valid fact scope outside the requested target",
      {
        ...responseBody,
        cleared: {
          ...responseBody.cleared,
          facts: {
            count: 1,
            items: [{
              kind: "rate-limited",
              scope: {
                kind: "attempt",
                provider: "anthropic",
                model: "claude-sonnet",
                credentialId: "anthropic#primary",
              },
            }],
          },
        },
      },
    ],
  ])("fails cleanly when a 2xx response contains %s", async (_case, payload) => {
    const configPath = join(dir, "invalid-response-config.json");
    writeFileSync(configPath, JSON.stringify(configAt("127.0.0.1:8791"), null, 2));
    process.argv = [
      "node", "cli.ts", "--config", configPath,
      "cooldowns", "clear", "anthropic/claude-sonnet", "--credential", "backup",
    ];
    const request = vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response(
      JSON.stringify(payload),
      { status: 200, headers: { "content-type": "application/json" } },
    ));
    const stdout = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
    const stderr = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    vi.spyOn(process, "exit").mockImplementation((code) => {
      throw new Error(`exit:${code}`);
    });

    await expect(runCooldowns("clear", "anthropic/claude-sonnet")).rejects.toThrow("exit:1");
    expect(request).toHaveBeenCalledTimes(1);
    expect(stderr).toHaveBeenCalledWith(expect.stringContaining("invalid cooldown-clear response"));
    expect(stdout).not.toHaveBeenCalled();
  });
});

describe("llm-relay stop — live control mutation", () => {
  const dir = mkdtempSync(join(tmpdir(), "rp-cli-stop-"));
  const originalArgv = process.argv;
  const configAt = (listen: string) => ({
    listen,
    providers: { anthropic: { base: "https://api.anthropic.com", kind: "anthropic" } },
    routing: { default: "anthropic", tiers: {}, benchmarkSort: false },
    repair: { maxAttempts: 2, destructiveTools: [] },
    mode: "detect",
    log: { level: "silent", file: null },
  });

  afterEach(() => {
    process.argv = originalArgv;
    vi.restoreAllMocks();
  });

  afterAll(() => rmSync(dir, { recursive: true, force: true }));

  it("prints the stopping line and exits 0 when the relay admits the stop", async () => {
    const server = createServer((req, res) => {
      res.writeHead(202, { "content-type": "application/json" });
      res.end(JSON.stringify({ stopping: true }));
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    try {
      const address = server.address();
      if (address === null || typeof address === "string") throw new Error("missing test listener");
      const configPath = join(dir, "config.json");
      writeFileSync(configPath, JSON.stringify(configAt(`127.0.0.1:${address.port}`), null, 2));
      process.argv = ["node", "cli.ts", "--config", configPath, "stop"];
      const output: string[] = [];
      vi.spyOn(process.stdout, "write").mockImplementation((chunk) => {
        output.push(String(chunk));
        return true;
      });
      vi.spyOn(process, "exit").mockImplementation((code) => {
        throw new Error(`exit:${code}`);
      });

      await expect(runStop()).rejects.toThrow("exit:0");
      expect(output.join("")).toContain(`stopping llm-relay at http://127.0.0.1:${address.port}`);
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });

  it("prints the no-relay line and exits 1 when a closed port answers nothing", async () => {
    const configPath = join(dir, "offline-config.json");
    writeFileSync(configPath, JSON.stringify(configAt("127.0.0.1:65533"), null, 2));
    process.argv = ["node", "cli.ts", "--config", configPath, "stop"];
    vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("offline"));
    const output: string[] = [];
    vi.spyOn(process.stdout, "write").mockImplementation((chunk) => {
      output.push(String(chunk));
      return true;
    });
    vi.spyOn(process, "exit").mockImplementation((code) => {
      throw new Error(`exit:${code}`);
    });

    await expect(runStop()).rejects.toThrow("exit:1");
    expect(output.join("")).toContain("no relay is listening at http://127.0.0.1:65533");
  });
});

describe("routing show — config-staleness notice", () => {
  const dir = mkdtempSync(join(tmpdir(), "rp-cli-routing-stale-"));
  const originalArgv = process.argv;
  const routingBlock = { default: "anthropic", tiers: {}, benchmarkSort: false };
  const configAt = (listen: string) => ({
    listen,
    providers: { anthropic: { base: "https://api.anthropic.com", kind: "anthropic" } },
    routing: routingBlock,
    repair: { maxAttempts: 2, destructiveTools: [] },
    mode: "detect",
    log: { level: "silent", file: null },
  });

  afterEach(() => {
    process.argv = originalArgv;
    vi.restoreAllMocks();
  });

  afterAll(() => rmSync(dir, { recursive: true, force: true }));

  it("prints the staleness notice on stderr when the running relay reports changedOnDisk, leaving stdout unchanged", async () => {
    const server = createServer((req, res) => {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ config: { path: "x", loadedAt: 1, changedOnDisk: true, diskMtime: 2 } }));
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    try {
      const address = server.address();
      if (address === null || typeof address === "string") throw new Error("missing test listener");
      const configPath = join(dir, "config.json");
      writeFileSync(configPath, JSON.stringify(configAt(`127.0.0.1:${address.port}`), null, 2));
      process.argv = ["node", "cli.ts", "--config", configPath, "routing", "show"];
      const stdout: string[] = [];
      const stderr: string[] = [];
      vi.spyOn(process.stdout, "write").mockImplementation((chunk) => {
        stdout.push(String(chunk));
        return true;
      });
      vi.spyOn(process.stderr, "write").mockImplementation((chunk) => {
        stderr.push(String(chunk));
        return true;
      });

      await runRoutingCommand();

      expect(JSON.parse(stdout.join(""))).toMatchObject(routingBlock);
      expect(stderr.join("")).toContain(
        "config changed on disk since the relay loaded it — restart required (llm-relay stop, then start)",
      );
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });

  it("prints no staleness notice when no relay is listening, and stdout is unaffected", async () => {
    const configPath = join(dir, "offline-config.json");
    writeFileSync(configPath, JSON.stringify(configAt("127.0.0.1:65533"), null, 2));
    process.argv = ["node", "cli.ts", "--config", configPath, "routing", "show"];
    vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("offline"));
    const stdout: string[] = [];
    const stderr: string[] = [];
    vi.spyOn(process.stdout, "write").mockImplementation((chunk) => {
      stdout.push(String(chunk));
      return true;
    });
    vi.spyOn(process.stderr, "write").mockImplementation((chunk) => {
      stderr.push(String(chunk));
      return true;
    });

    await runRoutingCommand();

    expect(JSON.parse(stdout.join(""))).toMatchObject(routingBlock);
    expect(stderr.join("")).not.toContain("config changed on disk");
  });
});

/**
 * The status view must render the EFFECTIVE freeOnly, not the bare optional. `freeOnlyApplies`
 * (server.ts) is `rule.freeOnly ?? rerouted`: an UNSET flag is ON for offload-rerouted traffic
 * and OFF for a directly addressed `pool/<name>` — one printed boolean would misdescribe half.
 */
describe("llm-relay offload status — effective freeOnly", () => {
  const dir = mkdtempSync(join(tmpdir(), "rp-cli-offload-"));
  afterAll(() => rmSync(dir, { recursive: true, force: true }));
  const origArgv = process.argv;
  afterEach(() => {
    process.argv = origArgv;
    vi.restoreAllMocks();
  });

  const CONFIG = {
    listen: "127.0.0.1:8791",
    providers: { anthropic: { base: "https://api.anthropic.com", kind: "anthropic" } },
    routing: {
      default: "anthropic",
      tiers: { opus: "anthropic", sonnet: "anthropic", haiku: "anthropic", fable: "anthropic" },
      benchmarkSort: false,
      offload: {
        claude: { enabled: true, scope: "subagents", freeOnly: true },
        codex: { enabled: true, scope: "all", freeOnly: false },
        openai: { enabled: true, scope: "subagents" },
        // Dead rule on purpose: its ⚠ marker and warning must survive the new column.
        "claude-desktop": { enabled: true, scope: "all" },
      },
    },
    mode: "detect",
    log: { level: "silent", file: null },
  };

  const captureStatus = async (args: string[]): Promise<string> => {
    process.argv = ["node", "cli.ts", "--config", join(dir, "config.json"), ...args];
    // No proxy is contacted: a real one may be listening on this developer's loopback, and a
    // test that reads it would report whatever that process happens to think.
    vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("no proxy in tests"));
    const out: string[] = [];
    vi.spyOn(process.stdout, "write").mockImplementation((chunk) => {
      out.push(String(chunk));
      return true;
    });
    // runOffload receives the positionals AFTER the "offload" keyword.
    const [, arg, nextArg] = args;
    await runOffload(arg, nextArg);
    return out.join("");
  };

  it("renders every declared state — explicit true, explicit false, unset — with the legend", async () => {
    const cfgPath = join(dir, "config.json");
    writeFileSync(cfgPath, JSON.stringify(CONFIG, null, 2));

    const printed = await captureStatus(["offload", "status"]);

    expect(printed).toContain("freeOnly"); // the column exists
    expect(printed).toContain("ON (explicit)"); // claude: freeOnly: true
    expect(printed).toContain("OFF (explicit)"); // codex: freeOnly: false
    expect(printed).toContain("ON (default)"); // openai: unset — NOT a bare "OFF" or "ON"
    // The legend states exactly how a directly addressed pool is governed (per freeOnlyApplies).
    expect(printed).toContain("freeOnly is the money guard");
    expect(printed).toContain("directly addressed `pool/<name>`");
    // Existing columns and the dead-client warning are intact.
    expect(printed).toContain("enabled");
    expect(printed).toContain("scope");
    expect(printed).toContain("claude-desktop ⚠");
    expect(printed).toContain("no front door produces this client name");
  });

  it("a targeted status names the effective freeOnly for that client's rule", async () => {
    const cfgPath = join(dir, "config.json");
    writeFileSync(cfgPath, JSON.stringify(CONFIG, null, 2));

    expect(await captureStatus(["offload", "claude", "status"])).toContain("freeOnly: ON (explicit)");
    expect(await captureStatus(["offload", "codex", "status"])).toContain("freeOnly: OFF (explicit)");
    expect(await captureStatus(["offload", "openai", "status"])).toContain("freeOnly: ON (default)");
  });
});

/**
 * ARC-6a02bffc-2 — a read-only subcommand must never be the moment the user's global install is
 * replaced and the process re-execed. `self-update.ts` cannot derive this (it would be an import
 * cycle), so the classification is computed here and PASSED as a runtime parameter.
 */
describe("classifyCommand — the update-check gate", () => {
  const argv = (...rest: string[]) => ["node", "cli.js", ...rest];

  it("classifies every status query read-only", () => {
    for (const sub of ["keys", "check-keys", "models", "telemetry", "candidates", "pools", "ping", "dispatch"]) {
      expect(classifyCommand(argv(sub))).toBe("read-only");
    }
    // Exhaustion is persisted locally, so reporting it is a mutation for update-check purposes.
    expect(classifyCommand(argv("dispatch", "-x", "codex"))).toBe("mutating");
    expect(classifyCommand(argv("cooldowns"))).toBe("read-only");
    expect(classifyCommand(argv("cooldowns", "clear", "anthropic"))).toBe("mutating");
  });

  it("classifies keys lifecycle mutations while keeping status and unlock read-only", () => {
    for (const subcommand of ["add", "rotate", "revoke", "remove", "disable", "enable", "export", "import"]) {
      expect(classifyCommand(argv("keys", subcommand))).toBe("mutating");
    }
    for (const subcommand of ["list", "unlock", "check"]) {
      expect(classifyCommand(argv("keys", subcommand))).toBe("read-only");
    }
    expect(classifyCommand(argv("keys"))).toBe("read-only");
  });

  it("classifies a bare proxy start mutating", () => {
    expect(classifyCommand(argv())).toBe("mutating");
    expect(classifyCommand(argv("--config", "c.json"))).toBe("mutating");
  });

  it("classifies subcommands correctly even when flags precede them", () => {
    expect(classifyCommand(argv("--config", "c.json", "offload", "status"))).toBe("read-only");
    expect(classifyCommand(argv("--config", "c.json", "offload", "on"))).toBe("read-only");
  });

  it("splits setup and offload by what the invocation actually writes", () => {
    expect(classifyCommand(argv("setup", "claude-desktop"))).toBe("mutating");
    expect(classifyCommand(argv("setup", "desktop"))).toBe("mutating");
    expect(classifyCommand(argv("setup"))).toBe("read-only");

    expect(classifyCommand(argv("offload", "on"))).toBe("read-only");
    expect(classifyCommand(argv("offload", "off"))).toBe("read-only");
    expect(classifyCommand(argv("offload", "claude", "on", "--scope", "all"))).toBe("mutating");
    expect(classifyCommand(argv("offload", "codex", "status"))).toBe("read-only");
    expect(classifyCommand(argv("offload", "status"))).toBe("read-only");
    expect(classifyCommand(argv("offload"))).toBe("read-only");

    expect(classifyCommand(argv("onboard"))).toBe("mutating");
  });

  it("classifies routing editors as mutating and their views as read-only", () => {
    expect(classifyCommand(argv("routing"))).toBe("read-only");
    expect(classifyCommand(argv("routing", "show"))).toBe("read-only");
    expect(classifyCommand(argv("routing", "tier", "opus", "pool/reasoning"))).toBe("mutating");
    expect(classifyCommand(argv("route", "sort", "off"))).toBe("mutating");
    expect(classifyCommand(argv("pools", "set", "coding", "nim/model"))).toBe("mutating");
    expect(classifyCommand(argv("pools", "--probe"))).toBe("read-only");
    expect(classifyCommand(argv("config", "get", "routing.pools"))).toBe("read-only");
    expect(classifyCommand(argv("config", "set", "routing.default", "nim/model"))).toBe("mutating");
  });

  it("treats --ping as the ping command, not as a proxy start", () => {
    expect(classifyCommand(argv("--ping"))).toBe("read-only");
    expect(classifyCommand(argv("--config", "c.json", "--ping"))).toBe("read-only");
  });

  it("falls through to read-only for a subcommand nobody has classified", () => {
    // The failure mode of an unlisted command is "no update check", never "surprise reinstall".
    expect(classifyCommand(argv("some-future-subcommand"))).toBe("read-only");
    expect(classifyCommand(argv("keys", "--json"))).toBe("read-only");
  });
});

describe("llm-relay eligibility scopes", () => {
  const originalArgv = process.argv;

  beforeEach(() => {
    resetInterpretations();
  });

  afterEach(() => {
    process.argv = originalArgv;
    vi.restoreAllMocks();
    resetInterpretations();
  });

  it("does not reuse a stale PID-only Vitest refusal store", () => {
    const body = "stale namespace regression";
    const signature = refusalSignature("provider", "model", 418, body);
    const legacyPath = join(tmpdir(), `llm-relay-test-interpretations-${process.pid}.json`);
    rmSync(legacyPath, { force: true });
    writeFileSync(legacyPath, JSON.stringify({
      version: 2,
      confirmed: { [signature]: { class: "not-servable", scope: { kind: "provider" }, source: "seed" } },
      unknown: {},
      ignored: {},
    }));
    try {
      resetInterpretations();
      recordUnknownRefusal("provider", "model", 418, body);
      expect(pendingRefusals().some((entry) => entry.signature === signature)).toBe(true);
    } finally {
      rmSync(legacyPath, { force: true });
    }
  });

  function queue(body: string): string {
    recordUnknownRefusal("provider", "model", 418, body);
    return pendingRefusals()[0]!.signature;
  }

  it("accepts every v2 scope", () => {
    for (const scope of ["attempt", "deployment", "credential", "provider", "model"]) {
      const body = `unrecognized ${scope}`;
      queue(body);
      process.argv = ["node", "cli.ts", "eligibility", "accept", "1", "--class", "not-servable", "--scope", scope];
      runEligibility("accept", "1");
      expect(interpretRefusal("provider", "model", 418, body)?.scope).toEqual({ kind: scope });
      resetInterpretations();
    }
  });

  it("defaults groups to the current credential and widens only with --all-credentials", () => {
    const first = "unrecognized default group";
    queue(first);
    process.argv = ["node", "cli.ts", "eligibility", "accept", "1", "--class", "not-servable", "--scope", "group", "--members", "a,b"];
    runEligibility("accept", "1");
    expect(interpretRefusal("provider", "model", 418, first)?.scope).toEqual({
      kind: "group", members: ["a", "b"], credential: "attempt",
    });

    resetInterpretations();
    const second = "unrecognized widened group";
    queue(second);
    process.argv = ["node", "cli.ts", "eligibility", "accept", "1", "--class", "not-servable", "--scope", "group", "--members", "a,b", "--all-credentials"];
    runEligibility("accept", "1");
    expect(interpretRefusal("provider", "model", 418, second)?.scope).toEqual({
      kind: "group", members: ["a", "b"], credential: "all",
    });
  });

  it("rejects --all-credentials outside a group", () => {
    queue("invalid widening");
    process.argv = ["node", "cli.ts", "eligibility", "accept", "1", "--class", "not-servable", "--scope", "credential", "--all-credentials"];
    const err = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    const exit = vi.spyOn(process, "exit").mockImplementation((() => { throw new Error("exit:1"); }) as never);
    expect(() => runEligibility("accept", "1")).toThrow("exit:1");
    expect(err).toHaveBeenCalledWith(expect.stringContaining("valid only with --scope group"));
    exit.mockRestore();
    err.mockRestore();
  });

  it("renders group members and explicit widening in a proposed accept command", () => {
    const signature = queue("render widened group");
    proposeInterpretation(signature, {
      class: "not-servable",
      scope: { kind: "group", members: ["a", "b"], credential: "all" },
      rationale: "stated account policy",
    });
    const out: string[] = [];
    vi.spyOn(process.stdout, "write").mockImplementation((chunk) => {
      out.push(String(chunk));
      return true;
    });
    runEligibility(undefined, undefined);
    const rendered = out.join("");
    expect(rendered).toContain("covers: a, b");
    expect(rendered).toContain("group --members a,b --all-credentials");
    expect(rendered).toContain("all credentials");
    expect(rendered).toContain("current credential slot");
    expect(rendered).toContain("all credentials for that provider");
  });

  it("prints a fully runnable accept command when proposing a widened group", () => {
    queue("propose widened group");
    process.argv = [
      "node", "cli.ts", "eligibility", "propose", "1",
      "--class", "not-servable", "--scope", "group", "--members", "a,b", "--all-credentials",
      "--reset-ms", "1000", "--rationale", "stated account policy",
    ];
    const out: string[] = [];
    vi.spyOn(process.stdout, "write").mockImplementation((chunk) => {
      out.push(String(chunk));
      return true;
    });

    runEligibility("propose", "1");
    const digest = signatureDigest(refusalSignature("provider", "model", 418, "propose widened group"));
    expect(out.join("")).toContain(
      `llm-relay eligibility accept 1 --sig ${digest} --class not-servable --scope group --members a,b --all-credentials --reset-ms 1000`,
    );

    process.argv = [
      "node", "cli.ts", "eligibility", "accept", "1", "--sig", digest,
      "--class", "not-servable", "--scope", "group", "--members", "a,b", "--all-credentials", "--reset-ms", "1000",
    ];
    runEligibility("accept", "1");
    expect(interpretRefusal("provider", "model", 418, "propose widened group")).toMatchObject({
      scope: { kind: "group", members: ["a", "b"], credential: "all" },
      reset: { kind: "fixed", ms: 1000 },
    });
  });

  it("resolves accept by --sig when the queue reorders between propose and accept", () => {
    // Two pending refusals; B is listed first (fresher), then A overtakes it on count — the
    // count-then-recency sort is exactly what moved a printed index onto a different refusal.
    recordUnknownRefusal("provider", "model", 418, "victim A", { now: 1000 });
    recordUnknownRefusal("provider", "model", 418, "target B", { now: 2000 });
    expect(pendingRefusals()[0]!.normalized).toBe("target b");
    const digestB = signatureDigest(refusalSignature("provider", "model", 418, "target B"));

    recordUnknownRefusal("provider", "model", 418, "victim A", { now: 3000 });
    expect(pendingRefusals()[0]!.normalized).toBe("victim a"); // the queue reordered

    const err = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    process.argv = ["node", "cli.ts", "eligibility", "accept", "1", "--sig", digestB, "--class", "not-servable", "--scope", "deployment"];
    runEligibility("accept", "1");
    err.mockRestore();

    // The digest, not the stale index, decided which refusal was accepted — and the verdict is
    // read back from the store FILE, not the in-memory memo.
    resetInterpretations();
    expect(interpretRefusal("provider", "model", 418, "target B")).toMatchObject({
      class: "not-servable", scope: { kind: "deployment" },
    });
    expect(interpretRefusal("provider", "model", 418, "victim A")).toBeNull();
    expect(pendingRefusals().some((p) => p.normalized === "victim a")).toBe(true);
  });

  it("refuses an unknown --sig and touches nothing", () => {
    queue("sole pending refusal");
    const err = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    const exit = vi.spyOn(process, "exit").mockImplementation((() => { throw new Error("exit:1"); }) as never);
    process.argv = ["node", "cli.ts", "eligibility", "accept", "1", "--sig", "beefbeef00", "--class", "not-servable", "--scope", "deployment"];
    expect(() => runEligibility("accept", "1")).toThrow("exit:1");
    expect(err).toHaveBeenCalledWith(expect.stringContaining("no pending refusal matches --sig beefbeef00"));
    exit.mockRestore();
    err.mockRestore();
    expect(interpretRefusal("provider", "model", 418, "sole pending refusal")).toBeNull();
    // The file outlives resetInterpretations, so assert THIS entry survives rather than a length.
    expect(pendingRefusals().some((p) => p.normalized === "sole pending refusal")).toBe(true);
  });

  it("the propose echo's commit command reproduces --sig and the cost filter", () => {
    const signature = queue("propose with cost filter");
    const digest = signatureDigest(signature);
    process.argv = [
      "node", "cli.ts", "eligibility", "propose", "1",
      "--class", "allowance-exhausted", "--scope", "credential", "--cost-class", "paid",
      "--rationale", "stated spend limit",
    ];
    const out: string[] = [];
    vi.spyOn(process.stdout, "write").mockImplementation((chunk) => {
      out.push(String(chunk));
      return true;
    });
    runEligibility("propose", "1");
    expect(out.join("")).toContain(
      `llm-relay eligibility accept 1 --sig ${digest} --class allowance-exhausted --scope credential --cost-class paid`,
    );
  });

  it("lists each pending item's digest, and the listed accept command carries --sig AND the cost filter", () => {
    const signature = queue("cost filtered proposal");
    proposeInterpretation(signature, {
      class: "allowance-exhausted",
      scope: { kind: "credential" },
      rationale: "stated spend limit",
      costClasses: ["paid"],
    });
    const out: string[] = [];
    vi.spyOn(process.stdout, "write").mockImplementation((chunk) => {
      out.push(String(chunk));
      return true;
    });
    runEligibility(undefined, undefined);
    const rendered = out.join("");
    const digest = signatureDigest(signature);
    expect(rendered).toContain(`sig ${digest}`);
    // ⚠ The cost filter must survive into the LISTED accept command: this call site dropped
    // `costClasses` from the flag's introduction (v0.52.0) until 2026-08-28, so the listing
    // printed a command WIDER than the proposal it echoed — the silent-widening hazard the
    // propose echo never had and the store-persistence fix (v0.55.2) could not see.
    expect(rendered).toContain(
      `llm-relay eligibility accept 1 --sig ${digest} --class allowance-exhausted --scope credential --cost-class paid`,
    );
  });

  it("documents group options and credential breadth in top-level help", () => {
    process.argv = ["node", "cli.ts", "help"];
    const out: string[] = [];
    vi.spyOn(process.stdout, "write").mockImplementation((chunk) => {
      out.push(String(chunk));
      return true;
    });
    vi.spyOn(process, "exit").mockImplementation((() => { throw new Error("exit:0"); }) as never);

    expect(() => main()).toThrow("exit:0");
    const help = out.join("");
    expect(help).toContain("--scope group --members <id,id,...> [--all-credentials]");
    expect(help).toContain("credential = current credential slot; provider = all credentials for that provider.");
  });
});

describe("CLI configuration editing", () => {
  const dir = mkdtempSync(join(tmpdir(), "rp-cli-config-"));
  const configPath = join(dir, "config.json");
  const baseConfig = {
    listen: "127.0.0.1:8791",
    providers: {
      test: { base: "http://127.0.0.1:1/v1", kind: "openai" },
      other: { base: "http://127.0.0.1:2/v1", kind: "openai" },
    },
    routing: {
      default: "test/base",
      tiers: {},
      benchmarkSort: false,
    },
    mode: "detect",
    log: { level: "silent", file: null },
  };
  const originalArgv = process.argv;

  beforeEach(() => {
    writeFileSync(configPath, JSON.stringify(baseConfig, null, 2));
    process.argv = ["node", "cli.ts", "--config", configPath];
  });

  afterEach(() => {
    process.argv = originalArgv;
    vi.restoreAllMocks();
  });

  afterAll(() => rmSync(dir, { recursive: true, force: true }));

  function document(): Record<string, any> {
    return JSON.parse(readFileSync(configPath, "utf8"));
  }

  it("rejects the removed global offload toggle", async () => {
    const stderrSpy = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    const exitSpy = vi.spyOn(process, "exit").mockImplementation((code) => {
      throw new Error(`exit:${code}`);
    });
    process.argv.push("offload", "on");

    await expect(runOffload("on")).rejects.toThrow("exit:1");
    expect(stderrSpy).toHaveBeenCalledWith(expect.stringContaining("expected [status] or <client> on|off|status"));
    expect(document().routing.offload).toBeUndefined();

    stderrSpy.mockRestore();
    exitSpy.mockRestore();
  });

  it("creates, edits, and deletes static and dynamic pools", async () => {
    process.argv.push("pools", "set", "coding", "test/coder", "other/coder");
    await runPools();
    expect(document().routing.pools.coding).toEqual(["test/coder", "other/coder"]);

    process.argv = ["node", "cli.ts", "--config", configPath, "pools", "add", "coding", "test/fast"];
    await runPools();
    expect(document().routing.pools.coding).toEqual(["test/coder", "other/coder", "test/fast"]);

    process.argv = ["node", "cli.ts", "--config", configPath, "pools", "set", "coding", "test/coder", "--free"];
    await runPools();
    expect(document().routing.pools.coding).toEqual({ preferred: ["test/coder"], include: "free" });

    process.argv = ["node", "cli.ts", "--config", configPath, "pools", "set", "coding", "other/coder"];
    await runPools();
    expect(document().routing.pools.coding).toEqual(["other/coder"]);

    process.argv = ["node", "cli.ts", "--config", configPath, "pools", "delete", "coding"];
    await runPools();
    expect(document().routing.pools).toEqual({});
  });

  it("materializes the discovered free tail before probing pools", async () => {
    const configured = {
      ...baseConfig,
      routing: {
        ...baseConfig.routing,
        pools: { coding: { preferred: ["test/coder"], include: "free" } },
      },
    };
    writeFileSync(configPath, JSON.stringify(configured, null, 2));

    const loaded = loadConfig(configPath);
    const catalog = new ModelCatalog({ cachePath: null });
    await catalog.list("test", loaded.providers.test!, {
      fetchFn: (async () => new Response(JSON.stringify({
        data: [{ id: "coder" }, { id: "catalog-model:free" }],
      }), { status: 200 })) as unknown as typeof fetch,
    });

    let probedMembers: string[] = [];
    const probeAll = vi.fn(async (cfg) => {
      probedMembers = [...(cfg.routing.pools?.coding ?? [])];
      return [];
    });
    vi.spyOn(process.stdout, "write").mockImplementation(() => true);
    process.argv = ["node", "cli.ts", "--config", configPath, "pools", "--probe"];

    await runPools({ catalog, probeAll: probeAll as typeof import("../src/pool-health.js").probeAllPools });

    expect(probeAll).toHaveBeenCalledOnce();
    expect(probedMembers).toEqual(["test/coder", "test/catalog-model:free"]);
  });

  it("names the probed credential on AUTH without condemning its siblings or deployment", async () => {
    writeFileSync(configPath, JSON.stringify({
      ...baseConfig,
      providers: {
        fleet: {
          base: "http://127.0.0.1:3/v1",
          kind: "openai",
          credentials: [
            { label: "first", authEnv: "CLI_FLEET_FIRST" },
            { label: "second", authEnv: "CLI_FLEET_SECOND" },
          ],
        },
      },
      routing: {
        ...baseConfig.routing,
        default: "fleet/model",
        pools: { coding: ["fleet/model"] },
      },
    }, null, 2));
    expect(loadConfig(configPath).providers.fleet!.credentials).toHaveLength(2);
    const probeAll = vi.fn(async () => [{
      pool: "coding",
      spec: "fleet/model",
      credentialId: "fleet#first",
      verdict: "auth",
      httpStatus: 401,
      detail: "HTTP 401",
    }]);
    const out: string[] = [];
    vi.spyOn(process.stdout, "write").mockImplementation((chunk) => {
      out.push(String(chunk));
      return true;
    });
    process.argv = ["node", "cli.ts", "--config", configPath, "pools", "--probe"];

    await runPools({
      catalog: new ModelCatalog({ cachePath: null }),
      probeAll: probeAll as typeof import("../src/pool-health.js").probeAllPools,
    });

    const rendered = out.join("");
    expect(probeAll).toHaveBeenCalledOnce();
    expect(rendered).toContain("credential=fleet#first");
    expect(rendered).toContain("Fix or disable credential slot fleet#first");
    expect(rendered).toContain("sibling slots and the deployment were not proven dead");
    expect(rendered).not.toMatch(/remove or replace/i);
    expect(rendered).not.toContain("CLI_FLEET_FIRST");
    expect(rendered).not.toContain("CLI_FLEET_SECOND");
  });

  it("retains deployment removal guidance for a DEAD missing-model result", async () => {
    writeFileSync(configPath, JSON.stringify({
      ...baseConfig,
      routing: {
        ...baseConfig.routing,
        pools: { coding: ["test/gone"] },
      },
    }, null, 2));
    const probeAll = vi.fn(async () => [{
      pool: "coding",
      spec: "test/gone",
      verdict: "missing",
      httpStatus: 404,
      detail: "HTTP 404 — model not servable",
    }]);
    const out: string[] = [];
    vi.spyOn(process.stdout, "write").mockImplementation((chunk) => {
      out.push(String(chunk));
      return true;
    });
    process.argv = ["node", "cli.ts", "--config", configPath, "pools", "--probe"];

    await runPools({
      catalog: new ModelCatalog({ cachePath: null }),
      probeAll: probeAll as typeof import("../src/pool-health.js").probeAllPools,
    });

    const rendered = out.join("");
    expect(rendered).toContain("1 DEAD/missing pool member(s)");
    expect(rendered).toContain("Remove or replace those deployments in routing.pools");
    expect(rendered).not.toContain("AUTH result");
  });

  it("creates and preserves evidence-aware effort policies", async () => {
    process.argv.push("pools", "set", "medium", "--free", "--effort", "medium");
    await runPools();
    expect(document().routing.pools.medium).toEqual({
      preferred: [], include: "free", effort: "medium",
    });

    process.argv = ["node", "cli.ts", "--config", configPath, "pools", "add", "medium", "test/coder"];
    await runPools();
    expect(document().routing.pools.medium).toEqual({
      preferred: ["test/coder"], include: "free", effort: "medium",
    });
  });

  it("preserves dynamic-pool exclude tombstones while editing the preferred prefix", async () => {
    writeFileSync(configPath, JSON.stringify({
      ...baseConfig,
      routing: {
        ...baseConfig.routing,
        pools: {
          medium: {
            preferred: ["test/coder"],
            include: "free",
            exclude: ["test/retired"],
          },
        },
      },
    }, null, 2));

    process.argv.push("pools", "add", "medium", "other/coder");
    await runPools();
    expect(document().routing.pools.medium).toEqual({
      preferred: ["test/coder", "other/coder"],
      include: "free",
      exclude: ["test/retired"],
    });
  });

  it("configures fallback, tiers, subagents, sorting, and arbitrary routing fields", async () => {
    process.argv.push("routing", "default", "test/strong", "other/fallback");
    await runRoutingCommand();
    expect(document().routing.default).toEqual(["test/strong", "other/fallback"]);

    process.argv = ["node", "cli.ts", "--config", configPath, "routing", "tier", "sonnet", "test/sonnet"];
    await runRoutingCommand();
    expect(document().routing.tiers.sonnet).toBe("test/sonnet");

    // The pool must exist before a subagent mapping can reference it.
    process.argv = ["node", "cli.ts", "--config", configPath, "pools", "set", "coding", "test/cheap"];
    await runPools();
    process.argv = ["node", "cli.ts", "--config", configPath, "routing", "subagent", "default", "pool/coding"];
    await runRoutingCommand();
    expect(document().routing.subagents.default).toBe("pool/coding");

    process.argv = ["node", "cli.ts", "--config", configPath, "routing", "sort", "on"];
    await runRoutingCommand();
    expect(document().routing.benchmarkSort).toBe(true);

    process.argv = ["node", "cli.ts", "--config", configPath, "config", "set", "routing.ladder", "[]"];
    await runConfigCommand();
    expect(document().routing.ladder).toEqual([]);
  });

  it("rejects edits that would make the config unloadable", async () => {
    process.argv = ["node", "cli.ts", "--config", configPath, "routing", "default", "missing/model"];
    await expect(runRoutingCommand()).rejects.toThrow(/unknown provider/);
    expect(document().routing.default).toBe("test/base");
  });
});

describe("keys subcommand router", () => {
  let directory: string;
  let configPath: string;
  const originalArgv = process.argv;

  beforeEach(() => {
    directory = mkdtempSync(join(tmpdir(), "llm-relay-cli-keys-router-"));
    configPath = join(directory, "config.json");
    writeFileSync(configPath, JSON.stringify({
      listen: "127.0.0.1:18792",
      providers: {
        passthrough: {
          base: "https://api.anthropic.com",
          kind: "anthropic",
          credentialMode: "passthrough",
        },
        keyless: {
          base: "http://127.0.0.1:11434/v1",
          kind: "openai",
          credentialMode: "contained",
        },
        declared: {
          base: "https://declared.invalid/v1",
          kind: "openai",
          authEnv: "DECLARED_API_KEY",
        },
      },
      routing: { default: "keyless/test", tiers: {} },
      mode: "detect",
      log: { level: "silent", file: null },
    }, null, 2));
  });

  afterEach(() => {
    process.argv = originalArgv;
    vi.restoreAllMocks();
    rmSync(directory, { recursive: true, force: true });
  });

  it.each([
    ["missing", [], "unknown provider"],
    ["passthrough", [], "passthrough provider"],
    ["keyless", [], "no auth declaration"],
    ["declared", ["--env-name", "GUESSED_API_KEY"], "undeclared env name"],
  ])("routes add refusal %s through the prefixed exit-1 path", async (provider, extra, reason) => {
    const stderr: string[] = [];
    const exit = vi.spyOn(process, "exit").mockImplementation((() => undefined) as never);
    vi.spyOn(process.stderr, "write").mockImplementation((chunk) => {
      stderr.push(String(chunk));
      return true;
    });
    process.argv = [
      "node", "cli.ts", "--config", configPath, "keys", "add", provider, ...extra,
    ];
    main();
    await vi.waitFor(() => expect(exit).toHaveBeenCalledWith(1));
    expect(stderr.join("")).toContain(`llm-relay keys: ${reason}`);
  });

  it("fails an unknown subcommand synchronously and names every valid subcommand", () => {
    const stderr: string[] = [];
    vi.spyOn(process.stderr, "write").mockImplementation((chunk) => {
      stderr.push(String(chunk));
      return true;
    });
    vi.spyOn(process, "exit").mockImplementation((code) => {
      throw new Error(`exit:${code}`);
    });
    process.argv = ["node", "cli.ts", "keys", "typo"];
    expect(() => main()).toThrow("exit:1");
    expect(stderr.join("")).toContain("valid subcommands: add, list, rotate, revoke, remove, disable, enable, export, import, unlock, check");
  });

  it("keeps bare keys, keys check, and check-keys on the historical status path", async () => {
    // This test pins ROUTER equivalence (three spellings, one output), not live key checking.
    // Unmocked, key-checker fetches the fixture's real hosts (api.anthropic.com, a dead local
    // port, an invalid DNS name), so the table header raced vi.waitFor's 1s budget against live
    // network latency under full-suite load — the winenv class of flake, on the network axis.
    vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("hermetic: no live key probes"));
    const stdout: string[] = [];
    vi.spyOn(process.stdout, "write").mockImplementation((chunk) => {
      stdout.push(String(chunk));
      return true;
    });

    const capture = async (command: string[]): Promise<string> => {
      stdout.length = 0;
      process.argv = ["node", "cli.ts", "--config", configPath, ...command];
      main();
      await vi.waitFor(() => expect(stdout.join("")).toContain("Validating configured provider API keys"));
      await vi.waitFor(() => expect(stdout.join("")).toContain("Credential ID"));
      return stdout.join("");
    };

    const bare = await capture(["keys"]);
    expect(await capture(["keys", "check"])).toBe(bare);
    expect(await capture(["check-keys"])).toBe(bare);
  });
});

describe("llm-relay command arity — an ignored argument is a lie", () => {
  /**
   * The gap: exact arity existed only on the mutating/custody surfaces, so the whole read-only
   * family accepted and DISCARDED whatever it did not understand. `llm-relay cost --window 1h 7d`
   * silently dropped `7d` and reported 24h; `llm-relay models nim` listed every provider. The user
   * is told nothing, which is the same failure shape as a config typo that "took effect".
   *
   * Counts INCLUDE the command token, matching `getPositionalArgs`.
   */
  it("refuses extra positionals across the whole read-only family", () => {
    for (const argv of [
      ["models", "nim"],
      ["ping", "nim"],
      ["candidates", "nim"],
      ["telemetry", "nim"],
      ["check-keys", "nim"],
      ["lanes", "codex"],
      ["dashboard", "open"],
      ["onboard", "extra"],
      // The motivating case: the flag VALUE is consumed, the stray token is not.
      ["cost", "7d"],
    ]) {
      expect(commandArityError(argv), argv.join(" ")).toMatch(/takes no arguments after the command/u);
    }

    // Commands with a legal positional are bounded one higher, not exempted.
    expect(commandArityError(["setup", "claude-desktop", "extra"])).toMatch(/at most 1 argument/u);
    expect(commandArityError(["dispatch", "codex", "extra"])).toMatch(/at most 1 argument/u);
    expect(commandArityError(["offload", "claude", "on", "extra"])).toMatch(/at most 2 arguments/u);
    expect(commandArityError(["eligibility", "accept", "1", "extra"])).toMatch(/at most 2 arguments/u);
  });

  it("leaves every legal form alone, including the ones that look wrong", () => {
    for (const argv of [
      [],                                   // bare `llm-relay` starts the proxy — the primary usage
      ["models"], ["ping"], ["telemetry"], ["candidates"], ["cost"], ["lanes"], ["dashboard"],
      ["onboard"], ["check-keys"],
      ["setup"], ["setup", "claude-desktop"],
      ["dispatch"], ["dispatch", "codex"],
      ["offload"], ["offload", "status"], ["offload", "claude", "on"],
      ["eligibility"], ["eligibility", "accept", "1"],
      ["config", "show"], ["config", "set", "a.b", "1"],
    ]) {
      expect(commandArityError(argv), argv.join(" ") || "(no args)").toBeNull();
    }
  });

  it("never bounds a VARIADIC command — multi-candidate specs are a routing feature", () => {
    // `routing default <spec> [<spec>...]` and `pools set <name> <spec> [<spec>...]` slice the
    // positional array. Any finite max here is a guaranteed false positive on real config edits.
    expect(commandArityError(["routing", "default", "a/b", "c/d", "e/f", "g/h"])).toBeNull();
    expect(commandArityError(["route", "default", "a/b", "c/d"])).toBeNull();
    expect(commandArityError(["pools", "set", "high", "a/b", "c/d", "e/f"])).toBeNull();
  });

  it("defers to the parsers that already own their arity, and to the unknown-command guard", () => {
    // `keys` and `cooldowns` run their own strict, fail-closed, secret-safe parsers ABOVE this
    // guard — `keys` deliberately never echoes argv, since a pasted credential can land there.
    // A second, laxer refusal here would be worse than none.
    expect(commandArityError(["keys", "add", "nim", "extra", "more"])).toBeNull();
    expect(commandArityError(["cooldowns", "clear", "nim", "extra"])).toBeNull();
    // `help`/`version` exit above this point, so a bound could never fire.
    expect(commandArityError(["help", "extra"])).toBeNull();
    expect(commandArityError(["version", "extra"])).toBeNull();
    // An unknown COMMAND belongs to dispatchDashboardOrProxy; two refusals for one mistake is worse.
    expect(commandArityError(["dashbaord", "x"])).toBeNull();
  });

  it("does not echo the stray token — it can be anything the user pasted", () => {
    // Unlike the unknown-COMMAND guard, which names the token because that IS the diagnostic. A
    // stray positional is unconstrained, and `check-keys` is the same command as `keys check`,
    // whose parser never echoes argv for exactly this reason.
    const secret = "sk-live-DEADBEEF";
    const message = commandArityError(["check-keys", secret]);
    expect(message).not.toBeNull();
    expect(message).not.toContain(secret);
    expect(message).not.toContain("DEADBEEF");
  });

  it("hints only where the flag actually exists", () => {
    // Verified against the code, not the help text: models/ping/candidates read
    // `argValue("--provider","-p")`, and `dispatch` takes a positional lane while `lanes` does not.
    expect(commandArityError(["models", "x"])).toContain("-p <name>");
    expect(commandArityError(["lanes", "x"])).toContain("llm-relay dispatch <lane>");
    // ⚠ check-keys hands the WHOLE config to validateProviderKeys — there is no provider filter,
    // and telemetry is provider-aggregate by design. Hinting `-p` would name a flag that does
    // nothing, which is worse than no hint.
    expect(commandArityError(["check-keys", "x"])).not.toContain("-p");
    expect(commandArityError(["telemetry", "x"])).not.toContain("-p");
  });

  it("covers every command name — a new command cannot silently miss the guard", () => {
    // The mechanical half. Same precedent as test/offload.test.ts pinning the valid client names
    // to `clientForPath`: two sets that must agree are pinned to each other, not to a hand-copy.
    const guarded = new Set(ARITY_GUARDED_COMMANDS);
    const uncovered = [...CLI_COMMAND_NAMES].filter((name) => !guarded.has(name) && !ARITY_EXEMPT.has(name));
    expect(uncovered, `add these to COMMAND_ARITY or ARITY_EXEMPT: ${uncovered.join(", ")}`).toEqual([]);
    // ... and nothing in the table is a command the dispatcher does not know.
    const unknown = ARITY_GUARDED_COMMANDS.filter((name) => !CLI_COMMAND_NAMES.has(name));
    expect(unknown, `not real commands: ${unknown.join(", ")}`).toEqual([]);
  });
});

/**
 * `llm-relay cost` states when metering stopped (backlog item 19). The command runs
 * against an injected live store in a failing writer state — its production store is
 * always read-only and reports `read_only`, which prints nothing new — and the footer
 * names the consequence so "no spend since noon" cannot be mistaken for "no traffic".
 */
describe("llm-relay cost — metering-stopped footer", () => {
  const STORE_MS = Date.parse("2026-08-20T12:00:00.000Z");
  const STORE_ISO = "2026-08-20T12:00:00.000Z";
  const CLI_NOW = "2026-08-20T12:34:56.000Z";
  const AT = "2026-08-20T12:29:56.000Z";
  const directories: string[] = [];
  let seedCounter = 0;

  function tempDir(): string {
    const directory = mkdtempSync(join(tmpdir(), "llm-relay-cost-footer-"));
    directories.push(directory);
    return directory;
  }

  afterEach(() => {
    for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true });
  });

  function requestId(): string {
    seedCounter += 1;
    return `costfooter${seedCounter.toString().padStart(8, "0")}`;
  }

  /** One committed served request, so the report is non-empty and the footer renders. */
  function seedLiveStore(directory: string): AccountingStore {
    const store = createAccountingStore({ rootDir: directory, now: () => STORE_MS });
    const id = requestId();
    store.record({
      type: "request-started",
      requestId: id,
      startedAt: AT,
      client: "claude",
      attribution: "relay_held",
      provider: null,
      model: null,
      credentialId: null,
    });
    store.record({
      type: "request-completed",
      requestId: id,
      endedAt: AT,
      outcome: "success",
      failureKind: null,
      attribution: "relay_held",
      attemptCount: 0,
      repairIncluded: false,
      winningAttemptId: null,
      commitAttemptId: null,
      latencyMs: 20,
      commitMs: 5,
      provider: "nim",
      model: "z-ai/glm-5.2",
      credentialId: "nim#primary",
      tokens: {} as RequestCompletedEvent["tokens"],
      spend: null,
      abandonedSpend: [],
    });
    expect(store.flush().status).toBe("committed");
    return store;
  }

  /** Drive `runCostCommand` against an injected store, mirroring main()'s wiring. */
  async function runCost(argv: readonly string[], store: AccountingStore): Promise<{ output: string; exitCode: number | null }> {
    const originalArgv = process.argv;
    process.argv = ["node", "cli.js", "cost", ...argv];
    let output = "";
    let exitCode: number | null = null;
    const dependencies: CostCommandDependencies = {
      write: (message) => {
        output += message;
      },
      exit: (code) => {
        exitCode = code;
        throw new Error("__exit__");
      },
      store,
      now: () => Date.parse(CLI_NOW),
    };
    try {
      await runCostCommand(dependencies);
    } catch (error) {
      if ((error as Error).message !== "__exit__") throw error;
    } finally {
      process.argv = originalArgv;
    }
    return { output, exitCode };
  }

  /** The pre-change footer, pinned byte-for-byte: a healthy store prints nothing new. */
  const HEALTHY_FOOTER =
    "Prices are each deployment's published per-(provider, model) figures, or another provider's\n" +
    "figure for the same model id (labelled reference); there is no fallback price. Cache token kinds\n" +
    "are NOT priced (no published factor), so requests carrying them count under Partial and every\n" +
    "amount is a LOWER BOUND while Partial > 0. Cells are never blended: the only single-figure total\n" +
    "is Published/reported, printed above with its basis. Repair attempts are excluded unless\n" +
    "--include-repair was given.\n" +
    "A running relay flushes its ledger to disk shortly after each request; the most recent\n" +
    "minutes may lag until then.\n";

  it("a healthy store prints the old footer exactly — no metering line", async () => {
    const store = seedLiveStore(tempDir());
    const { output, exitCode } = await runCost([], store);
    expect(exitCode).toBeNull();
    expect(output).toContain("llm-relay cost");
    expect(output).not.toContain("metering stopped");
    expect(output).not.toContain("metering is not recording");
    expect(output.slice(output.indexOf("Prices are"))).toBe(HEALTHY_FOOTER);
  });

  it("a failed flush prints the metering-stopped line with the failure time and reason", async () => {
    const directory = tempDir();
    const store = seedLiveStore(directory);
    // One more terminal, then break the writer underneath: the flush fails, serving continues.
    const id = requestId();
    store.record({
      type: "request-started",
      requestId: id,
      startedAt: AT,
      client: "claude",
      attribution: "relay_held",
      provider: null,
      model: null,
      credentialId: null,
    });
    store.record({
      type: "request-completed",
      requestId: id,
      endedAt: AT,
      outcome: "success",
      failureKind: null,
      attribution: "relay_held",
      attemptCount: 0,
      repairIncluded: false,
      winningAttemptId: null,
      commitAttemptId: null,
      latencyMs: 20,
      commitMs: 5,
      provider: "nim",
      model: "z-ai/glm-5.2",
      credentialId: "nim#primary",
      tokens: {} as RequestCompletedEvent["tokens"],
      spend: null,
      abandonedSpend: [],
    });
    rmSync(directory, { recursive: true, force: true });
    writeFileSync(directory, "a file where the usage directory was");
    expect(store.flush().status).toBe("failed");

    const { output, exitCode } = await runCost([], store);
    expect(exitCode).toBeNull();
    // The mkdir throw is Node-version-worded, so pin the stable parts: the state line
    // names the failure time and the consequence — and never the absolute store path.
    expect(output).toContain(`⚠ metering stopped at ${STORE_ISO}:`);
    expect(output).toContain("mkdir");
    expect(output).toContain("figures above exclude traffic since then");
    expect(output).not.toContain(directory);
  });

  it("a refused writer lease prints the not-recording line", async () => {
    const store = seedLiveStore(tempDir());
    const exposed = store.writerStatus as unknown as { status: string; error: string | null };
    exposed.status = "failed";
    exposed.error = "writer-busy-test-lease";
    expect(store.flush().status).toBe("failed");

    const { output, exitCode } = await runCost([], store);
    expect(exitCode).toBeNull();
    expect(output).toContain(
      `⚠ metering is not recording: writer lease refused at ${STORE_ISO} — another relay may own the store`,
    );
  });

  it("an invalid last write prints the metering-stopped line", async () => {
    const store = seedLiveStore(tempDir());
    store.close();
    expect(store.flush().status).toBe("invalid");

    const { output, exitCode } = await runCost([], store);
    expect(exitCode).toBeNull();
    expect(output).toContain(
      `⚠ metering stopped at ${STORE_ISO}: closed — figures above exclude traffic since then`,
    );
  });

  it("cost --json carries the writer block beside the report", async () => {
    const healthy = seedLiveStore(tempDir());
    const { output: healthyJson, exitCode: healthyExit } = await runCost(["--json"], healthy);
    expect(healthyExit).toBeNull();
    const healthyReport: unknown = JSON.parse(healthyJson);
    assertCostReportV1(healthyReport);
    expect(healthyReport.writer).toEqual({
      state: "writing",
      lastSuccessfulWriteAt: STORE_ISO,
      lastFailureAt: null,
      lastFailureReason: null,
    });

    const directory = tempDir();
    const failing = seedLiveStore(directory);
    rmSync(directory, { recursive: true, force: true });
    writeFileSync(directory, "a file where the usage directory was");
    // Dirty the store so the flush has something to fail on, then break it.
    const id = requestId();
    failing.record({
      type: "request-started",
      requestId: id,
      startedAt: AT,
      client: "claude",
      attribution: "relay_held",
      provider: null,
      model: null,
      credentialId: null,
    });
    failing.record({
      type: "request-completed",
      requestId: id,
      endedAt: AT,
      outcome: "success",
      failureKind: null,
      attribution: "relay_held",
      attemptCount: 0,
      repairIncluded: false,
      winningAttemptId: null,
      commitAttemptId: null,
      latencyMs: 20,
      commitMs: 5,
      provider: "nim",
      model: "z-ai/glm-5.2",
      credentialId: "nim#primary",
      tokens: {} as RequestCompletedEvent["tokens"],
      spend: null,
      abandonedSpend: [],
    });
    expect(failing.flush().status).toBe("failed");
    const { output: failingJson } = await runCost(["--json"], failing);
    const failingReport: unknown = JSON.parse(failingJson);
    assertCostReportV1(failingReport);
    expect(failingReport.writer).toBeDefined();
    expect(failingReport.writer?.state).toBe("flush_failed");
    expect(failingReport.writer?.lastFailureAt).toBe(STORE_ISO);
  });
});
