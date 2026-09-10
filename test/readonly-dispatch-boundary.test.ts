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
import { resolveReadOnlyCwd, readOnlyVerdict } from "../src/mcp/readonly-boundary.js";
import { McpDispatchServer, type DispatchViewBuilder } from "../src/mcp/server.js";
import type { LaneSpawner } from "../src/mcp/lane-runner.js";
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

const CLI_LANE: DispatchLane = {
  id: "agy",
  kind: "cli",
  position: 1,
  state: "ready",
  spec: "agy-gemini",
  invoke: { command: "agy", args: ["-p", "the task"] },
};

function dispatchView(): DispatchView {
  return {
    tier: "medium",
    offload: false,
    client: "claude",
    host: "bypassed",
    ladder: [CLI_LANE],
    order: [CLI_LANE.id],
    next: CLI_LANE,
    reason: "first ready lane",
  };
}

function countingSpawner(): LaneSpawner & { calls: number } {
  const fn = (() => {
    (fn as unknown as { calls: number }).calls += 1;
    return {
      result: Promise.resolve({ code: 0, stdout: "answer", stderr: "", timedOut: false }),
      kill: () => {},
    };
  }) as unknown as LaneSpawner & { calls: number };
  fn.calls = 0;
  return fn;
}

function serverWith(spawn: LaneSpawner, cwd: string): { server: McpDispatchServer; out: string[] } {
  const out: string[] = [];
  const buildView: DispatchViewBuilder = async () => dispatchView();
  return {
    out,
    server: new McpDispatchServer({
      config: { host: "127.0.0.1", port: 8791, routing: {} } as unknown as Config,
      buildView,
      spawn,
      cwd: () => cwd,
      write: (chunk) => out.push(chunk),
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

  it("still RUNS a read-only dispatch in a separate checkout", async () => {
    const spawn = countingSpawner();
    const { server, out } = serverWith(spawn, process.cwd());

    const result = await callDispatch(server, out, {
      task: "review this",
      mode: "agent",
      readOnly: true,
      cwd: resolve(process.cwd(), ".."),
    });

    expect(spawn.calls).toBe(1);
    expect(result.isError).toBe(false);
  });
});
