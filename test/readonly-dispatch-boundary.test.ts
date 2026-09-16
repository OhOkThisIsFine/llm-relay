/**
 * Read-only dispatch must be a MECHANISM, not an instruction.
 *
 * Two recorded cases, both of which the prompt tried and failed to prevent:
 *
 * - 2026-09-04: the prompt said "do NOT edit any file"; the `claude-free-pool` lane created
 *   `scripts/extract-guards.mjs` in the caller's checkout before it timed out. Only a
 *   `git status --porcelain` afterwards caught it.
 * - 2026-09-05, worse: a `pool/medium` lane told "do not edit any file; output a unified diff"
 *   edited a spec file and later REVERTED it in both worktree and index — after the orchestrating
 *   session had staged its own edit to the same file, so a commit landed with only its ledger half.
 *   A lane in the live checkout can silently undo staged work, not just add scratch files.
 * - 2026-09-09: MCP job `job-0003` was assigned an independent READ-ONLY review and returned after
 *   1,151 s reporting a commit and push of nine of the caller's in-progress files.
 *
 * ⚠ The instruction is advice; the lane's working directory is the mechanism. These tests assert
 * the mechanism.
 */
import { describe, expect, it } from "vitest";
import { join, resolve } from "node:path";
import {
  CLAUDE_READ_ONLY_DENIED,
  CLAUDE_READ_ONLY_TOOLS,
  readOnlyInvoke,
  resolveReadOnlyCwd,
  readOnlyVerdict,
} from "../src/mcp/readonly-boundary.js";
import { McpDispatchServer, type DispatchViewBuilder } from "../src/mcp/server.js";
import type { LaneSpawner } from "../src/mcp/lane-runner.js";
import type { DispatchedTelemetryReport } from "../src/dispatch-lane-stats.js";
import type { Config } from "../src/config.js";
import type { DispatchLane, DispatchView } from "../src/dispatch.js";

const root = "C:/caller/tree";

describe("read-only dispatch boundary", () => {
  it("REFUSES a read-only agent dispatch that would default to the caller's tree", () => {
    // ⚠ RED on HEAD: there was no read-only concept at all — the lane was handed the caller's tree
    // and the only thing between it and a commit was the prompt.
    const verdict = readOnlyVerdict({ readOnly: true, mode: "agent", cwd: undefined, callerRoot: root });
    expect(verdict.ok).toBe(false);
    expect(verdict.ok === false && verdict.refusal).toMatch(/separate checkout|answer/i);
  });

  it("REFUSES a read-only agent dispatch pointed AT the caller's tree by an explicit cwd", () => {
    const verdict = readOnlyVerdict({
      readOnly: true,
      mode: "agent",
      cwd: join(root, "src"),
      callerRoot: root,
    });
    expect(verdict.ok).toBe(false);
  });

  it("allows a read-only agent dispatch in a directory outside the caller's tree", () => {
    const verdict = readOnlyVerdict({
      readOnly: true,
      mode: "agent",
      cwd: "C:/review-checkout",
      callerRoot: root,
    });
    expect(verdict.ok).toBe(true);
  });

  it("allows read-only ANSWER mode with no cwd — it has no filesystem access at all", () => {
    const verdict = readOnlyVerdict({ readOnly: true, mode: "answer", cwd: undefined, callerRoot: root });
    expect(verdict.ok).toBe(true);
  });

  it("does NOT constrain an ordinary implementation dispatch — the negative control", () => {
    // The recorded cases are about READ-ONLY dispatches. An implementation lane in the caller's
    // tree is the whole point of the tool and must keep working unchanged.
    const verdict = readOnlyVerdict({ readOnly: false, mode: "agent", cwd: undefined, callerRoot: root });
    expect(verdict.ok).toBe(true);
  });

  it("treats a sibling directory with a shared prefix as OUTSIDE, not inside", () => {
    // `C:/caller/tree-other`.startsWith("C:/caller/tree") is true and is not containment — the
    // `checkCwd` defect fixed 2026-09-03, in the direction that would wrongly permit.
    const verdict = readOnlyVerdict({
      readOnly: true,
      mode: "agent",
      cwd: "C:/caller/tree-other",
      callerRoot: root,
    });
    expect(verdict.ok).toBe(true);
  });

  it("resolves the cwd it will actually use", () => {
    // Compared through `resolve`, not against the literal: win32 `path.resolve` rewrites
    // separators, and asserting the raw string would be asserting a spelling the OS does not use.
    expect(resolveReadOnlyCwd("C:/review-checkout")).toBe(resolve("C:/review-checkout"));
    // A relative path resolves against the process's own directory, never left relative.
    expect(resolveReadOnlyCwd("relative")).toBe(join(process.cwd(), "relative"));
    expect(resolveReadOnlyCwd(undefined, "C:/fallback")).toBe(resolve("C:/fallback"));
  });
});

// ---------------------------------------------------------------------------------------------
// End to end through the tool: the refusal must cost ZERO lane runs, and the negative control
// must still spawn. A test that only checked the pure function would pass with the guard unwired.

const AGY_LANE: DispatchLane = {
  id: "agy",
  kind: "cli",
  position: 1,
  state: "ready",
  spec: "agy-gemini",
  invoke: { command: "agy", args: ["-p", "the task"] },
};

/** The shape every `relay` rung takes in agent mode on a bypassed host: the `cliLane` transposition. */
const CLAUDE_LANE: DispatchLane = {
  id: "free-pool",
  kind: "relay",
  position: 1,
  state: "ready",
  spec: "pool/medium",
  invoke: {
    command: "claude",
    args: ["-p", "the task", "--model", "pool/medium", "--permission-mode", "acceptEdits", "--allowedTools", "Bash,Read,Edit,Write"],
  },
};

function dispatchView(lanes: DispatchLane[] = [AGY_LANE]): DispatchView {
  const [first] = lanes;
  return {
    tier: "medium",
    offload: false,
    client: "claude",
    host: "bypassed",
    ladder: lanes,
    order: lanes.map((l) => l.id),
    next: first ?? null,
    reason: "first ready lane",
  };
}

function countingSpawner(): LaneSpawner & { calls: number; args: string[][] } {
  const fn = ((_command: string, args: readonly string[]) => {
    (fn as unknown as { calls: number }).calls += 1;
    (fn as unknown as { args: string[][] }).args.push([...args]);
    return {
      result: Promise.resolve({ code: 0, stdout: "answer", stderr: "", timedOut: false }),
      kill: () => {},
    };
  }) as unknown as LaneSpawner & { calls: number; args: string[][] };
  fn.calls = 0;
  fn.args = [];
  return fn;
}

function serverWith(
  spawn: LaneSpawner,
  cwd: string,
  lanes: DispatchLane[] = [AGY_LANE],
  extra: { reports?: DispatchedTelemetryReport[]; walk?: boolean } = {},
): { server: McpDispatchServer; out: string[] } {
  const out: string[] = [];
  const buildView: DispatchViewBuilder = async () => dispatchView(lanes);
  const routing = extra.walk ? { dispatchWalk: { enabled: true, attemptMs: 90_000, maxLanes: 8 } } : {};
  return {
    out,
    server: new McpDispatchServer({
      config: { host: "127.0.0.1", port: 8791, routing } as unknown as Config,
      buildView,
      spawn,
      cwd: () => cwd,
      write: (chunk) => out.push(chunk),
      ...(extra.reports ? { reportTelemetry: (r) => { extra.reports?.push(r); } } : {}),
    }),
  };
}

async function callDispatch(
  server: McpDispatchServer,
  out: string[],
  args: Record<string, unknown>,
): Promise<{ text: string; isError: boolean }> {
  await server.ingest(
    JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method: "tools/call",
      params: { name: "dispatch", arguments: args },
    }) + "\n",
  );
  const body = JSON.parse(out[0] as string) as {
    result: { content: Array<{ text: string }>; isError: boolean };
  };
  return { text: body.result.content[0]?.text ?? "", isError: body.result.isError };
}

describe("read-only dispatch boundary, end to end", () => {
  it("REFUSES a read-only dispatch into the caller's tree without spawning a lane", async () => {
    const spawn = countingSpawner();
    const callerRoot = process.cwd();
    const { server, out } = serverWith(spawn, callerRoot);

    const result = await callDispatch(server, out, { task: "review this", mode: "agent", readOnly: true });

    expect(result.isError).toBe(true);
    expect(result.text).toMatch(/declared read-only/);
    // ⚠ The whole point of checking before the spawn: the refusal must cost no lane run.
    expect(spawn.calls).toBe(0);
  });

  it("still RUNS the same dispatch when readOnly is absent — the negative control", async () => {
    const spawn = countingSpawner();
    const callerRoot = process.cwd();
    const { server, out } = serverWith(spawn, callerRoot);

    const result = await callDispatch(server, out, { task: "implement this", mode: "agent" });

    expect(result.isError).toBe(false);
    expect(spawn.calls).toBe(1);
    expect(result.text).toContain("answer");
  });

  it("still RUNS a read-only dispatch in a separate checkout — with the lane's tools BOUND", async () => {
    // ⚠ Flipped 2026-09-15: this case used to run an `agy` lane and assert one spawn. AGY has no
    // command-line tool binding the relay can verify, so a read-only dispatch now SKIPS it (below);
    // the lane that does run read-only in a separate checkout is the claude transposition.
    const spawn = countingSpawner();
    const { server, out } = serverWith(spawn, process.cwd(), [CLAUDE_LANE]);

    const result = await callDispatch(server, out, {
      task: "review this",
      mode: "agent",
      readOnly: true,
      cwd: resolve(process.cwd(), ".."),
    });

    expect(spawn.calls).toBe(1);
    expect(result.isError).toBe(false);
    // The SPAWNED command line carries the binding, not merely the reply text.
    const args = spawn.args[0] as string[];
    expect(args).toContain("dontAsk");
    expect(args).not.toContain("acceptEdits");
    expect(args).not.toContain("Bash,Read,Edit,Write");
    expect(result.text).toContain("read-only: claude --permission-mode dontAsk");
  });

  it("SKIPS a lane whose CLI offers no read-only binding, spawning nothing, and says why", async () => {
    // ⚠ RED before 2026-09-15: the agy lane spawned with its full tool set under `readOnly: true`,
    // which is the measured "three scratch edits to source files" in a separate worktree — a flag
    // that claimed protection it did not implement.
    const spawn = countingSpawner();
    const reports: DispatchedTelemetryReport[] = [];
    const { server, out } = serverWith(spawn, process.cwd(), [AGY_LANE], { reports });

    const result = await callDispatch(server, out, {
      task: "review this",
      mode: "agent",
      readOnly: true,
      cwd: resolve(process.cwd(), ".."),
    });

    expect(spawn.calls).toBe(0);
    expect(result.isError).toBe(true);
    expect(result.text).toMatch(/skipped before it ran/);
    expect(result.text).toMatch(/AGY/);
    // A skip is not lane evidence: nothing is forwarded, so nothing can demote the lane.
    expect(reports).toHaveLength(0);
  });

  it("walks PAST an unbindable lane to one it can bind, and reports the skip in lanes tried", async () => {
    const spawn = countingSpawner();
    const { server, out } = serverWith(spawn, process.cwd(), [AGY_LANE, CLAUDE_LANE], { walk: true });

    const result = await callDispatch(server, out, {
      task: "review this",
      mode: "agent",
      readOnly: true,
      cwd: resolve(process.cwd(), ".."),
    });

    expect(spawn.calls).toBe(1);
    expect(spawn.args[0]).toContain("dontAsk");
    expect(result.isError).toBe(false);
    expect(result.text).toMatch(/1\. agy.*skipped.*AGY/);
    expect(result.text).toMatch(/2\. free-pool.*completed/);
  });

  it("leaves an ordinary dispatch's command line byte-for-byte unchanged — the negative control", async () => {
    const spawn = countingSpawner();
    const { server, out } = serverWith(spawn, process.cwd(), [CLAUDE_LANE]);

    await callDispatch(server, out, { task: "implement this", mode: "agent" });

    expect(spawn.args[0]).toEqual(CLAUDE_LANE.invoke?.args);
  });
});

// ---------------------------------------------------------------------------------------------
// The TOOL half, as a pure function: what a read-only lane is handed to run.

describe("readOnlyInvoke — binding a lane's tools", () => {
  it("rewrites a claude lane to dontAsk with only the read-only tools, REPLACING the template's flags", () => {
    const verdict = readOnlyInvoke({
      command: "claude",
      args: ["-p", "task", "--model", "pool/medium", "--permission-mode", "acceptEdits", "--allowedTools", "Bash,Read,Edit,Write"],
    });
    expect(verdict.ok).toBe(true);
    if (!verdict.ok) return;
    const { args } = verdict.invoke;
    const value = (flag: string): string | undefined => args[args.indexOf(flag) + 1];
    expect(value("--permission-mode")).toBe("dontAsk");
    expect(value("--allowedTools")).toBe(CLAUDE_READ_ONLY_TOOLS.join(","));
    expect(value("--tools")).toBe(CLAUDE_READ_ONLY_TOOLS.join(","));
    expect(value("--disallowedTools")).toBe(CLAUDE_READ_ONLY_DENIED.join(","));
    // The template's own permission flags are gone, not merely followed by stricter ones — a
    // repeated flag's LAST value wins in some parsers and its FIRST in others.
    expect(args.filter((a) => a === "--permission-mode")).toHaveLength(1);
    expect(args.filter((a) => a === "--allowedTools")).toHaveLength(1);
    expect(args).not.toContain("acceptEdits");
    // Everything that is not a permission flag survives in order.
    expect(args.slice(0, 4)).toEqual(["-p", "task", "--model", "pool/medium"]);
    expect(verdict.invoke.command).toBe("claude");
  });

  it("never binds a claude lane to plan mode — a headless claude -p can never leave it", () => {
    const verdict = readOnlyInvoke({ command: "claude", args: ["-p", "t", "--permission-mode", "plan"] });
    expect(verdict.ok && verdict.invoke.args).not.toContain("plan");
  });

  it("strips --dangerously-skip-permissions and a --flag=value spelling from a claude lane", () => {
    const verdict = readOnlyInvoke({
      command: "claude",
      args: ["-p", "t", "--dangerously-skip-permissions", "--allowedTools=Bash,Write", "--tools=default"],
    });
    expect(verdict.ok).toBe(true);
    if (!verdict.ok) return;
    expect(verdict.invoke.args).not.toContain("--dangerously-skip-permissions");
    expect(verdict.invoke.args.some((a) => a.startsWith("--allowedTools="))).toBe(false);
    expect(verdict.invoke.args.some((a) => a.startsWith("--tools="))).toBe(false);
  });

  it("the read-only tool set holds no writer, and the denied set holds every first-party mutation tool", () => {
    for (const tool of CLAUDE_READ_ONLY_TOOLS) expect(CLAUDE_READ_ONLY_DENIED as readonly string[]).not.toContain(tool);
    for (const writer of ["Bash", "Edit", "Write", "MultiEdit", "NotebookEdit", "Task"]) {
      expect(CLAUDE_READ_ONLY_DENIED as readonly string[]).toContain(writer);
      expect(CLAUDE_READ_ONLY_TOOLS as readonly string[]).not.toContain(writer);
    }
  });

  it("puts a codex lane under --sandbox read-only and strips every bypass of it", () => {
    const verdict = readOnlyInvoke({
      command: "codex",
      args: ["exec", "--full-auto", "--sandbox", "workspace-write", "--model", "gpt-5.6-sol", "--dangerously-bypass-approvals-and-sandbox", "the task"],
    });
    expect(verdict.ok).toBe(true);
    if (!verdict.ok) return;
    expect(verdict.invoke.args).toEqual(["exec", "--sandbox", "read-only", "--model", "gpt-5.6-sol", "the task"]);
    expect(verdict.binding).toMatch(/--sandbox read-only/);
  });

  it("sees a codex lane through the pwsh lane-launch wrapper", () => {
    const verdict = readOnlyInvoke({
      command: "pwsh",
      args: ["-NoProfile", "-File", "C:\\u\\.llm-relay\\bin\\lane-launch.ps1", "--timeout", "2100", "C:\\bin\\codex.exe", "exec", "the task"],
    });
    expect(verdict.ok).toBe(true);
    if (!verdict.ok) return;
    expect(verdict.invoke.args.slice(-4)).toEqual(["exec", "--sandbox", "read-only", "the task"]);
  });

  it("REFUSES an opencode lane, naming the gap rather than running it unbound", () => {
    const verdict = readOnlyInvoke({
      command: "pwsh",
      args: ["-File", "lane-launch.ps1", "C:\\npm\\opencode-ai\\bin\\opencode.exe", "run", "--agent", "relay-lane", "the task"],
    });
    expect(verdict.ok).toBe(false);
    expect(!verdict.ok && verdict.reason).toMatch(/OpenCode/);
    expect(!verdict.ok && verdict.reason).toMatch(/opencode\.json/);
  });

  it("REFUSES an agy lane, and an unrecognised binary — unknown never claims protection", () => {
    const agy = readOnlyInvoke({ command: "pwsh", args: ["-File", "lane-launch.ps1", "C:\\agy\\agy.exe", "-p", "t"] });
    expect(agy.ok).toBe(false);
    expect(!agy.ok && agy.reason).toMatch(/AGY/);
    const unknown = readOnlyInvoke({ command: "some-other-agent", args: ["--do", "t"] });
    expect(unknown.ok).toBe(false);
    expect(!unknown.ok && unknown.reason).toMatch(/some-other-agent/);
  });

  it("carries the lane's env through unchanged — only the tool flags are the relay's to rewrite", () => {
    const env = { ANTHROPIC_BASE_URL: "http://127.0.0.1:8791", CLAUDECODE: null };
    const verdict = readOnlyInvoke({ command: "claude", args: ["-p", "t"], env });
    expect(verdict.ok && verdict.invoke.env).toEqual(env);
  });
});
