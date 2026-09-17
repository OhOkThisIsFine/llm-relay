/**
 * The tree delta a dispatch answer carries (2026-09-17, `docs/backlog.md`): what an agent-mode lane
 * changed in its git working tree, compared by `git status` at the start and at the end of the job.
 * Report only — the relay never refuses or reverts on it.
 */
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { McpDispatchServer } from "../src/mcp/server.js";
import { parsePorcelainZ, renderTreeDelta, type TreeSnapshot, type TreeSnapshotReader } from "../src/mcp/tree-delta.js";
import type { Config } from "../src/config.js";
import type { DispatchLane, DispatchView } from "../src/dispatch.js";
import type { LaneRunResult, LaneSpawner } from "../src/mcp/lane-runner.js";

const snap = (entries: Record<string, string>, prefix = ""): TreeSnapshot => ({
  prefix,
  entries: new Map(Object.entries(entries)),
});

describe("parsePorcelainZ", () => {
  it("reads status and path, and consumes a rename's original path", () => {
    const text = " M src/a.ts\0?? new file.txt\0R  dst.ts\0src.ts\0A  b.ts\0";
    expect([...parsePorcelainZ(text)]).toEqual([
      ["src/a.ts", " M"],
      ["new file.txt", "??"],
      ["dst.ts", "R "],
      ["b.ts", "A "],
    ]);
  });
});

describe("renderTreeDelta", () => {
  it("lists paths that appeared, changed status, or became clean", () => {
    const text = renderTreeDelta(
      "C:/w",
      snap({ "a.ts": " M", "gone.ts": " M", "same.ts": " M" }),
      snap({ "a.ts": "M ", "same.ts": " M", "new.ts": "??" }),
      undefined,
    );
    expect(text).toBe(
      [
        "tree delta (C:/w): 3 paths",
        "  ~ a.ts [ M -> M ]",
        "  - gone.ts [was  M; now clean]",
        "  + new.ts [??]",
      ].join("\n"),
    );
    expect(text).not.toContain("OUT OF SCOPE");
  });

  it("says none when nothing changed", () => {
    expect(renderTreeDelta("C:/w", snap({ "a.ts": " M" }), snap({ "a.ts": " M" }), ["src"])).toBe("tree delta: none");
  });

  it("marks paths outside the scope, relative to the cwd's prefix", () => {
    const text = renderTreeDelta(
      "C:/repo/pkg",
      snap({}, "pkg/"),
      snap({ "pkg/src/a.ts": "??", "pkg/src/deep/b.ts": "??", "pkg/docs/x.md": "??", "other/y.ts": "??", "pkg/t.test.ts": "??" }, "pkg/"),
      ["src", "*.test.ts"],
    );
    expect(text).toContain("5 paths, 2 out of scope");
    expect(text).toContain("+ pkg/src/a.ts [??]\n");
    expect(text).toContain("+ pkg/src/deep/b.ts [??]\n");
    expect(text).toContain("+ pkg/t.test.ts [??]");
    expect(text).not.toContain("t.test.ts [??]  OUT OF SCOPE");
    expect(text).toContain("+ pkg/docs/x.md [??]  OUT OF SCOPE");
    expect(text).toContain("+ other/y.ts [??]  OUT OF SCOPE");
  });

  it("matches ** across directories and bounds the listing", () => {
    const after: Record<string, string> = {};
    for (let i = 0; i < 60; i++) after[`gen/${i}/out.js`] = "??";
    const text = renderTreeDelta("C:/w", snap({}), snap(after), ["gen/**/*.js"]);
    expect(text).toContain("60 paths, 0 out of scope");
    expect(text).toContain("… 10 more");
  });

  it("says unknown when the second reading failed", () => {
    expect(renderTreeDelta("C:/w", snap({}), null, undefined)).toMatch(/unknown/);
  });
});

function harness(opts: { readings: Array<TreeSnapshot | null>; laneMs?: number }) {
  const out: Array<{ id?: number; result?: { content: Array<{ text: string }> } }> = [];
  const lane: DispatchLane = {
    id: "claude-lane",
    kind: "cli",
    position: 1,
    state: "ready",
    invoke: { command: "claude", args: ["-p", "{task}"] },
  };
  const view: DispatchView = {
    tier: "medium", offload: false, client: "claude", host: "bypassed", ladder: [lane], order: [lane.id], next: lane, reason: "r",
  };
  const reads: string[] = [];
  const treeSnapshot: TreeSnapshotReader = async (cwd) => {
    reads.push(cwd);
    return opts.readings.shift() ?? null;
  };
  const spawn: LaneSpawner = () => {
    let settle: (r: LaneRunResult) => void = () => {};
    const result = new Promise<LaneRunResult>((resolve) => {
      settle = resolve;
      setTimeout(() => resolve({ code: 0, stdout: "the answer", stderr: "", timedOut: false }), opts.laneMs ?? 0);
    });
    return { result, kill: () => settle({ code: null, stdout: "", stderr: "killed", timedOut: false }) };
  };
  const server = new McpDispatchServer({
    config: { host: "127.0.0.1", port: 8791, routing: { default: "x" } } as unknown as Config,
    buildView: async () => view,
    spawn,
    treeSnapshot,
    cwd: () => process.cwd(),
    write: (chunk) => out.push(JSON.parse(chunk) as (typeof out)[number]),
  });
  let id = 0;
  const call = async (name: string, args: Record<string, unknown>): Promise<string> => {
    const reqId = ++id;
    await server.ingest(JSON.stringify({ jsonrpc: "2.0", id: reqId, method: "tools/call", params: { name, arguments: args } }) + "\n");
    return out.find((m) => m.id === reqId)?.result?.content[0]?.text ?? "";
  };
  return { call, reads };
}

describe("dispatch carries the tree delta", () => {
  it("appends the delta to a completed agent-mode answer, with the scope applied", async () => {
    const h = harness({ readings: [snap({ "keep.ts": " M" }), snap({ "keep.ts": " M", "src/new.ts": "??", "README.md": " M" })] });
    const text = await h.call("dispatch", { task: "t", scope: ["src"] });
    expect(text).toContain("the answer");
    expect(text).toContain("tree delta (");
    expect(text).toMatch(/^ {2}\+ src\/new\.ts \[\?\?\]$/m);
    expect(text).toContain("+ README.md [ M]  OUT OF SCOPE");
    expect(h.reads).toHaveLength(2);
  });

  it("states none when the lane changed nothing", async () => {
    const h = harness({ readings: [snap({}), snap({})] });
    expect(await h.call("dispatch", { task: "t" })).toMatch(/tree delta: none$/);
  });

  it("adds nothing outside a git work tree, and reads nothing in answer mode", async () => {
    const outside = harness({ readings: [null] });
    expect(await outside.call("dispatch", { task: "t" })).not.toContain("tree delta");
    const answer = harness({ readings: [snap({}), snap({})] });
    await answer.call("dispatch", { task: "t", mode: "answer" });
    expect(answer.reads).toHaveLength(0);
  });

  it("records the delta for a cancelled job, and a later dispatch_result shows it", async () => {
    const h = harness({ readings: [snap({}), snap({ "half.ts": "??" })], laneMs: 60_000 });
    const first = await h.call("dispatch", { task: "t", waitMs: 50 });
    const jobId = /jobId "(job-\d+)"/.exec(first)?.[1];
    expect(jobId).toBeDefined();
    await h.call("dispatch_cancel", { jobId });
    await new Promise((r) => setTimeout(r, 20));
    expect(await h.call("dispatch_result", { jobId })).toContain("+ half.ts [??]");
  });
});

describe("the real git reader", () => {
  it("reads nothing under vitest, so no suite appends a live checkout's status", async () => {
    const { defaultTreeSnapshot } = await import("../src/mcp/tree-delta.js");
    // Under vitest the default reader reads nothing, by design.
    expect(await defaultTreeSnapshot(process.cwd())).toBeNull();
  });

  it("parses what git itself prints for a new and a renamed file", () => {
    const dir = mkdtempSync(join(tmpdir(), "tree-delta-"));
    try {
      const git = (...args: string[]): string =>
        execFileSync("git", ["-C", dir, "-c", "user.email=t@t", "-c", "user.name=t", "-c", "core.autocrlf=false", ...args], { encoding: "utf8" });
      git("init", "-q");
      writeFileSync(join(dir, "a.txt"), "a\n");
      git("add", "a.txt");
      git("commit", "-q", "-m", "a");
      git("mv", "a.txt", "b.txt");
      writeFileSync(join(dir, "c d.txt"), "c\n");
      const entries = parsePorcelainZ(git("status", "--porcelain=v1", "-z", "--untracked-files=all"));
      expect(entries.get("b.txt")).toBe("R ");
      expect(entries.get("c d.txt")).toBe("??");
      expect(entries.has("a.txt")).toBe(false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
