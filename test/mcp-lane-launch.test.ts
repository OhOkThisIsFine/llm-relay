/**
 * What the lane launcher corrects before a lane starts (2026-09-17, `docs/backlog.md`):
 *  - a `%NAME%` environment value is expanded from the same environment, or removed when it is one
 *    unresolved reference — a lane inherited `HOME=%USERPROFILE%` literally;
 *  - an AGY lane is given the caller's working directory through `--add-dir`, and its task names it —
 *    AGY otherwise works in its own scratch directory.
 * The reply names each correction on a `launch:` line.
 */
import { describe, expect, it } from "vitest";
import { McpDispatchServer } from "../src/mcp/server.js";
import { agyWorkingDirInvoke, expandEnvReferences } from "../src/mcp/lane-runner.js";
import type { Config } from "../src/config.js";
import type { DispatchLane, DispatchView } from "../src/dispatch.js";
import type { LaneSpawner } from "../src/mcp/lane-runner.js";

describe("expandEnvReferences", () => {
  it("expands a reference from the same environment, without case", () => {
    const { env, notes } = expandEnvReferences({ HOME: "%USERPROFILE%", userprofile: "C:\\Users\\me" }, "win32");
    expect(env["HOME"]).toBe("C:\\Users\\me");
    expect(notes).toEqual(["HOME expanded from %USERPROFILE%"]);
  });

  it("removes a value that is one unresolved reference", () => {
    const { env, notes } = expandEnvReferences({ HOME: "%NOPE_NOT_SET%" }, "win32");
    expect(env).not.toHaveProperty("HOME");
    expect(notes).toEqual(["HOME removed (%NOPE_NOT_SET% does not resolve)"]);
  });

  it("keeps an unresolved reference inside a longer value and expands the rest", () => {
    const { env } = expandEnvReferences({ PATH: "%MISSING%;%ROOT%\\bin", ROOT: "C:\\r" }, "win32");
    expect(env["PATH"]).toBe("%MISSING%;C:\\r\\bin");
  });

  it("changes nothing on a POSIX platform, and nothing without a reference", () => {
    expect(expandEnvReferences({ HOME: "%USERPROFILE%", USERPROFILE: "x" }, "linux").notes).toEqual([]);
    const plain = expandEnvReferences({ A: "100%", B: "x" }, "win32");
    expect(plain.notes).toEqual([]);
    expect(plain.env).toEqual({ A: "100%", B: "x" });
  });

  it("never puts a value in a note", () => {
    const { notes } = expandEnvReferences({ TOKEN: "%SECRET%", SECRET: "sk-do-not-print" }, "win32");
    expect(notes.join(" ")).not.toContain("sk-do-not-print");
  });
});

describe("agyWorkingDirInvoke", () => {
  const wrapped = {
    command: "pwsh",
    args: ["-File", "lane-launch.ps1", "--timeout", "2100", "C:\\agy\\agy.exe", "-p", "fix it", "--model", "m"],
  };

  it("adds --add-dir and names the directory in the prompt of a wrapped rung", () => {
    const out = agyWorkingDirInvoke(wrapped, "C:\\work\\tree");
    expect(out?.invoke.args.slice(-2)).toEqual(["--add-dir", "C:\\work\\tree"]);
    expect(out?.invoke.args[6]).toBe("Work in this directory: C:\\work\\tree\n\nfix it");
    expect(out?.invoke.args.slice(0, 6)).toEqual(wrapped.args.slice(0, 6));
    expect(wrapped.args[6]).toBe("fix it");
  });

  it("does not repeat an --add-dir the rung already declares", () => {
    const out = agyWorkingDirInvoke({ command: "agy", args: ["-p", "t", "--add-dir", "C:/Work/Tree"] }, "C:\\work\\tree");
    const count = out?.invoke.args.filter((a) => a === "--add-dir").length;
    expect(count).toBe(process.platform === "win32" ? 1 : 2);
  });

  it("returns null for a lane that is not AGY", () => {
    expect(agyWorkingDirInvoke({ command: "claude", args: ["-p", "t"] }, "C:\\w")).toBeNull();
  });
});

function harness(lane: DispatchLane) {
  const calls: Array<{ args: string[]; env: NodeJS.ProcessEnv | undefined }> = [];
  const spawn: LaneSpawner = (_command, args, opts) => {
    calls.push({ args: [...args], env: opts.env });
    return { result: Promise.resolve({ code: 0, stdout: "done", stderr: "", timedOut: false }), kill: () => {} };
  };
  const view: DispatchView = {
    tier: "medium", offload: false, client: "claude", host: "bypassed", ladder: [lane], order: [lane.id], next: lane, reason: "r",
  };
  const out: string[] = [];
  const server = new McpDispatchServer({
    config: { host: "127.0.0.1", port: 8791, routing: { default: "x" } } as unknown as Config,
    buildView: async () => view,
    spawn,
    platform: "win32",
    cwd: () => process.cwd(),
    write: (chunk) => out.push(chunk),
  });
  return { server, calls, out };
}

async function dispatchText(h: { server: McpDispatchServer; out: string[] }): Promise<string> {
  await h.server.ingest(
    JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "dispatch", arguments: { task: "do it" } } }) + "\n",
  );
  const reply = h.out.map((c) => JSON.parse(c) as { id?: number; result?: { content: Array<{ text: string }> } }).find((m) => m.id === 1);
  return reply?.result?.content[0]?.text ?? "";
}

describe("the lane launcher, end to end", () => {
  it("a lane started with HOME=%USERPROFILE% never sees the literal, and the reply names the change", async () => {
    const h = harness({
      id: "claude-lane",
      kind: "cli",
      position: 1,
      state: "ready",
      invoke: { command: "claude", args: ["-p", "{task}"], env: { HOME: "%USERPROFILE%" } },
    });
    const text = await dispatchText(h);
    const home = h.calls[0]?.env?.["HOME"];
    expect(home).not.toBe("%USERPROFILE%");
    if (home !== undefined) expect(home).not.toContain("%");
    expect(text).toMatch(/launch: HOME (expanded from %USERPROFILE%|removed)/);
  });

  it("an AGY lane gets the caller's cwd through --add-dir, and the reply says so", async () => {
    const h = harness({
      id: "agy-lane",
      kind: "cli",
      position: 1,
      state: "ready",
      invoke: { command: "agy", args: ["-p", "{task}", "--model", "m"] },
    });
    const text = await dispatchText(h);
    const args = h.calls[0]?.args ?? [];
    expect(args.slice(-2)).toEqual(["--add-dir", process.cwd()]);
    expect(args[1]).toContain(`Work in this directory: ${process.cwd()}`);
    expect(text).toContain(`launch: agy works in ${process.cwd()} (--add-dir)`);
  });

  it("an ordinary lane gets no launch line", async () => {
    const h = harness({
      id: "plain",
      kind: "cli",
      position: 1,
      state: "ready",
      invoke: { command: "claude", args: ["-p", "{task}"] },
    });
    expect(await dispatchText(h)).not.toContain("launch:");
  });
});
