import { describe, it, expect, beforeEach, afterEach, afterAll, vi } from "vitest";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { spawnSync } from "node:child_process";
import {
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
  proxyUrl,
  runDispatch,
  runOffload,
  runConfigCommand,
  runPools,
  runRoutingCommand,
  runEligibility,
  formatCandidateQuota,
  formatKeyQuota,
} from "../src/cli.js";
import { loadConfig } from "../src/config.js";
import { ModelCatalog } from "../src/catalog.js";
import { interpretRefusal, pendingRefusals, proposeInterpretation, recordUnknownRefusal, refusalSignature, resetInterpretations } from "../src/refusal-interpretation.js";

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

  it("normalizes AGY in structured output returned by an older live proxy", () => {
    const oldView = {
      tier: "coding",
      offload: true,
      client: "default",
      ladder: [{ id: "agy", kind: "cli" as const, position: 1, state: "ready" as const, invoke: { command: "agy", args: ["-p", "task"] } }],
      next: { id: "agy", kind: "cli" as const, position: 1, state: "ready" as const, invoke: { command: "agy", args: ["-p", "task"] } },
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
      { label: "llm-relay setup [target]", description: "target: claude-cli" },
      { label: "llm-relay dispatch [lane] [options]", description: "Choose next dispatch lane" },
    ].map(({ label, description }) => {
      const line = help.split("\n").find((candidate) => candidate.includes(label) && candidate.includes(description));
      expect(line).toBeDefined();
      return line!.indexOf(description);
    });

    expect(new Set(aligned).size).toBe(1);
    expect(help).toContain("GET|POST /dispatch");
    expect(help).toContain('POST {"exhausted":"<lane>"}');
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
    // Reporting spend changes a running proxy's in-memory cooldowns, nothing on this machine.
    expect(classifyCommand(argv("dispatch", "-x", "codex"))).toBe("read-only");
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
    expect(out.join("")).toContain(
      "llm-relay eligibility accept 1 --class not-servable --scope group --members a,b --all-credentials --reset-ms 1000",
    );

    process.argv = [
      "node", "cli.ts", "eligibility", "accept", "1",
      "--class", "not-servable", "--scope", "group", "--members", "a,b", "--all-credentials", "--reset-ms", "1000",
    ];
    runEligibility("accept", "1");
    expect(interpretRefusal("provider", "model", 418, "propose widened group")).toMatchObject({
      scope: { kind: "group", members: ["a", "b"], credential: "all" },
      reset: { kind: "fixed", ms: 1000 },
    });
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
    runRoutingCommand();
    expect(document().routing.default).toEqual(["test/strong", "other/fallback"]);

    process.argv = ["node", "cli.ts", "--config", configPath, "routing", "tier", "sonnet", "test/sonnet"];
    runRoutingCommand();
    expect(document().routing.tiers.sonnet).toBe("test/sonnet");

    // The pool must exist before a subagent mapping can reference it.
    process.argv = ["node", "cli.ts", "--config", configPath, "pools", "set", "coding", "test/cheap"];
    await runPools();
    process.argv = ["node", "cli.ts", "--config", configPath, "routing", "subagent", "default", "pool/coding"];
    runRoutingCommand();
    expect(document().routing.subagents.default).toBe("pool/coding");

    process.argv = ["node", "cli.ts", "--config", configPath, "routing", "sort", "on"];
    runRoutingCommand();
    expect(document().routing.benchmarkSort).toBe(true);

    process.argv = ["node", "cli.ts", "--config", configPath, "config", "set", "routing.ladder", "[]"];
    runConfigCommand();
    expect(document().routing.ladder).toEqual([]);
  });

  it("rejects edits that would make the config unloadable", () => {
    process.argv = ["node", "cli.ts", "--config", configPath, "routing", "default", "missing/model"];
    expect(() => runRoutingCommand()).toThrow(/unknown provider/);
    expect(document().routing.default).toBe("test/base");
  });
});
