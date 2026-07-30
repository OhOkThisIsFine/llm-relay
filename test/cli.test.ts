import { describe, it, expect, beforeEach, afterEach, afterAll, vi } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { spawnSync } from "node:child_process";
import {
  argValue,
  hasFlag,
  splitSpec,
  main,
  quoteArg,
  renderCommand,
  shellFor,
  parseRenderShell,
  SHELL_LABEL,
  classifyCommand,
  runDispatch,
} from "../src/cli.js";

describe("cli helper utilities", () => {
  const origArgv = process.argv;

  beforeEach(() => {
    process.argv = [...origArgv];
  });

  afterEach(() => {
    process.argv = origArgv;
  });

  it("splitSpec correctly parses provider and model", () => {
    expect(splitSpec("nim/meta/llama-3")).toEqual({ provider: "nim", model: "meta/llama-3" });
    expect(splitSpec("openai")).toEqual({ provider: "openai", model: undefined });
  });

  it("argValue extracts values with double dash --flag value", () => {
    process.argv = ["node", "cli.ts", "--config", "custom.json"];
    expect(argValue("--config", "-c")).toBe("custom.json");
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
    expect(stdoutSpy).toHaveBeenCalledWith(expect.stringContaining("llm-relay — loopback Anthropic-Messages proxy"));

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
      expect(line.startsWith("agy -p '")).toBe(true);
      expect(line.endsWith("' --model g-flash")).toBe(true);
    }
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

    // Quoting agrees between sh and pwsh for a task with no single quote in it, so this
    // assertion is exact on every platform.
    expect(printed).toContain(`agy -p '${task}' --model g-flash`);
    // The defect: the raw join put `; report` outside the quotes as its own shell command.
    expect(printed).not.toContain(`agy -p ${task} --model g-flash`);
    expect(printed).toMatch(/quoted for (PowerShell 7\+ \(pwsh\)|sh\/bash)/);
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

  it("splits setup and offload by what the invocation actually writes", () => {
    expect(classifyCommand(argv("setup", "claude-desktop"))).toBe("mutating");
    expect(classifyCommand(argv("setup", "desktop"))).toBe("mutating");
    expect(classifyCommand(argv("setup"))).toBe("read-only");

    expect(classifyCommand(argv("offload", "on"))).toBe("mutating");
    expect(classifyCommand(argv("offload", "off"))).toBe("mutating");
    expect(classifyCommand(argv("offload", "status"))).toBe("read-only");
    expect(classifyCommand(argv("offload"))).toBe("read-only");

    expect(classifyCommand(argv("onboard"))).toBe("mutating");
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
