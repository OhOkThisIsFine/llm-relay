import { afterAll, describe, expect, it } from "vitest";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { loadConfig, type Config } from "../src/config.js";
import { ModelCatalog } from "../src/catalog.js";
import { createConfiguredLaneExecutionLauncher } from "../src/configured-lane-execution-launcher.js";
import { beginLaneRequest, LANE_ACTIVITY_HEADER, resetLaneActivity } from "../src/lane-activity.js";
import { DEPTH_ENV, type LaneSpawnOptions, type LaneSpawner } from "../src/mcp/lane-runner.js";
import type { LaneExecutionStartRequest } from "../src/lane-execution-broker.js";

const root = mkdtempSync(join(tmpdir(), "llm-relay-configured-broker-launcher-"));
afterAll(() => rmSync(root, { recursive: true, force: true }));

let configSeq = 0;
function cfg(
  ladder: Array<Record<string, unknown>>,
  options: { allowedRoots?: string[]; providers?: Record<string, unknown> } = {},
): Config {
  const path = join(root, `config-${configSeq++}.json`);
  writeFileSync(
    path,
    JSON.stringify({
      listen: "127.0.0.1:8791",
      providers:
        options.providers ?? {
          p: {
            base: "https://example.invalid",
            kind: "anthropic",
            authEnv: "PROVIDER_KEY",
          },
        },
      routing: {
        default: "p",
        ladder,
        ...(options.allowedRoots === undefined
          ? {}
          : { mcp: { allowedRoots: options.allowedRoots } }),
      },
      mode: "detect",
      log: { level: "silent", file: null },
    }),
  );
  return loadConfig(path);
}

function request(
  laneId: string,
  cwd: string,
  overrides: Partial<LaneExecutionStartRequest> = {},
): LaneExecutionStartRequest {
  return {
    action: "start",
    executionId: "exec-00112233445566778899aabbccddeeff",
    jobId: "job-900000000000000000000000000000000000000000000001",
    laneId,
    task: "inspect the repository",
    cwd,
    timeoutMs: 60_000,
    depth: 2,
    host: "bypassed",
    ...overrides,
  };
}

function tagFromCustomHeaders(value: string | undefined): string {
  const line = (value ?? "")
    .split(/\r?\n/)
    .find((candidate) => candidate.toLowerCase().startsWith(`${LANE_ACTIVITY_HEADER}:`));
  if (!line) throw new Error("missing lane activity header");
  return line.slice(line.indexOf(":") + 1).trim();
}

describe("createConfiguredLaneExecutionLauncher", () => {
  it("resolves the configured lane and preserves MCP launch env/depth/activity semantics", async () => {
    resetLaneActivity();
    const cwd = join(root, "launch");
    mkdirSync(cwd, { recursive: true });

    const config = cfg([
      {
        id: "codex-lane",
        kind: "cli",
        command: "codex",
        args: ["exec", "{task}"],
        env: { LANE_SETTING: "configured" },
      },
    ]);

    let now = 1_000;
    let seen:
      | {
          command: string;
          args: readonly string[];
          opts: LaneSpawnOptions;
        }
      | undefined;
    const spawn: LaneSpawner = (command, args, opts) => {
      seen = { command, args, opts };
      return {
        result: Promise.resolve({ code: 0, stdout: "done", stderr: "", timedOut: false }),
        kill: () => {},
        pids: () => [4321],
      };
    };

    const launcher = createConfiguredLaneExecutionLauncher(config, {
      catalog: new ModelCatalog({ cachePath: null }),
      spawn,
      platform: "win32",
      launcherPath: null,
      now: () => now,
      hostEnv: {
        PROVIDER_KEY: "must-not-leak",
        SAFE: "keep",
        HOME: "%USERPROFILE%",
        USERPROFILE: "C:\\Users\\runner",
        ANTHROPIC_CUSTOM_HEADERS: "x-other: preserve",
      },
      readProcessCpu: async (pids) => {
        expect(pids).toEqual([4321]);
        return 1_234;
      },
      manifest: null,
    });

    const handle = launcher(request("codex-lane", cwd));
    expect("refusal" in handle).toBe(false);
    if ("refusal" in handle) return;

    expect(seen).toBeDefined();
    expect(seen?.args).toContain("inspect the repository");
    expect(seen?.opts.env["PROVIDER_KEY"]).toBeUndefined();
    expect(seen?.opts.env["SAFE"]).toBe("keep");
    expect(seen?.opts.env["LANE_SETTING"]).toBe("configured");
    expect(seen?.opts.env["HOME"]).toBe("C:\\Users\\runner");
    expect(seen?.opts.env[DEPTH_ENV]).toBe("3");
    expect(seen?.opts.env["ANTHROPIC_CUSTOM_HEADERS"]).toContain("x-other: preserve");
    expect(handle.launchNotes).toEqual(
      expect.arrayContaining(["HOME expanded from %USERPROFILE%"]),
    );

    now = 2_000;
    seen?.opts.onOutput?.({ stream: "stdout", bytes: 7 });
    const tag = tagFromCustomHeaders(seen?.opts.env["ANTHROPIC_CUSTOM_HEADERS"]);
    const traffic = beginLaneRequest(tag, () => 2_500);

    const activity = await handle.activity?.();
    expect(activity).toEqual({
      stdoutBytes: 7,
      stderrBytes: 0,
      lastOutputAt: 2_000,
      cpuMs: 1_234,
      relayInFlight: 1,
      relayLastActivityAt: 2_500,
    });
    traffic.ended();
  });

  it("uses live configured argv rather than accepting process configuration from the request", () => {
    const cwd = join(root, "authority");
    mkdirSync(cwd, { recursive: true });
    const config = cfg([
      {
        id: "configured",
        kind: "cli",
        command: "codex",
        args: ["exec", "--configured-flag", "{task}"],
      },
    ]);
    const calls: Array<{ command: string; args: readonly string[] }> = [];
    const spawn: LaneSpawner = (command, args) => {
      calls.push({ command, args });
      return {
        result: Promise.resolve({ code: 0, stdout: "ok", stderr: "", timedOut: false }),
        kill: () => {},
      };
    };

    const launcher = createConfiguredLaneExecutionLauncher(config, {
      catalog: new ModelCatalog({ cachePath: null }),
      spawn,
      hostEnv: {},
      manifest: null,
      launcherPath: null,
    });
    const handle = launcher(request("configured", cwd, { task: "caller task" }));
    expect("refusal" in handle).toBe(false);
    expect(calls).toHaveLength(1);
    expect(calls[0]?.args).toContain("--configured-flag");
    expect(calls[0]?.args).toContain("caller task");
  });

  it("refuses an unknown/unexecutable lane before spawning", () => {
    const cwd = join(root, "unknown");
    mkdirSync(cwd, { recursive: true });
    const config = cfg([
      { id: "known", kind: "cli", command: "codex", args: ["exec", "{task}"] },
    ]);
    let spawns = 0;
    const launcher = createConfiguredLaneExecutionLauncher(config, {
      catalog: new ModelCatalog({ cachePath: null }),
      spawn: (() => {
        spawns += 1;
        throw new Error("must not spawn");
      }) as LaneSpawner,
      hostEnv: {},
      manifest: null,
      launcherPath: null,
    });

    const result = launcher(request("missing", cwd));
    expect(result).toMatchObject({ refusal: expect.stringMatching(/no lane|unavailable/i) });
    expect(spawns).toBe(0);
  });

  it("enforces allowedRoots and the read-only caller-tree boundary before spawning", () => {
    const allowed = join(root, "allowed");
    const outside = join(root, "outside");
    const protectedTree = join(allowed, "caller");
    mkdirSync(protectedTree, { recursive: true });
    mkdirSync(outside, { recursive: true });

    const config = cfg(
      [{ id: "codex", kind: "cli", command: "codex", args: ["exec", "{task}"] }],
      { allowedRoots: [allowed] },
    );
    let spawns = 0;
    const launcher = createConfiguredLaneExecutionLauncher(config, {
      catalog: new ModelCatalog({ cachePath: null }),
      spawn: (() => {
        spawns += 1;
        return {
          result: Promise.resolve({ code: 0, stdout: "ok", stderr: "", timedOut: false }),
          kill: () => {},
        };
      }) as LaneSpawner,
      hostEnv: {},
      manifest: null,
      launcherPath: null,
    });

    expect(launcher(request("codex", outside))).toMatchObject({
      refusal: expect.stringMatching(/allowedRoots|allowed root/i),
    });
    expect(
      launcher(
        request("codex", protectedTree, {
          readOnly: true,
          callerRoot: protectedTree,
        }),
      ),
    ).toMatchObject({ refusal: expect.stringMatching(/read-only|readOnly/i) });
    expect(spawns).toBe(0);
  });

  it("applies the existing read-only tool binding in a separate checkout", () => {
    const caller = join(root, "caller-tree");
    const checkout = join(root, "review-tree");
    mkdirSync(caller, { recursive: true });
    mkdirSync(checkout, { recursive: true });

    const config = cfg([
      { id: "codex", kind: "cli", command: "codex", args: ["exec", "{task}"] },
    ]);
    let args: readonly string[] = [];
    const launcher = createConfiguredLaneExecutionLauncher(config, {
      catalog: new ModelCatalog({ cachePath: null }),
      spawn: ((_command, seenArgs) => {
        args = seenArgs;
        return {
          result: Promise.resolve({ code: 0, stdout: "ok", stderr: "", timedOut: false }),
          kill: () => {},
        };
      }) as LaneSpawner,
      hostEnv: {},
      manifest: null,
      launcherPath: null,
    });

    const result = launcher(
      request("codex", checkout, { readOnly: true, callerRoot: caller }),
    );
    expect("refusal" in result).toBe(false);
    expect(args).toEqual(expect.arrayContaining(["--sandbox", "read-only"]));
    if (!("refusal" in result)) {
      expect(result.launchNotes?.join("\n")).toMatch(/read-only/i);
    }
  });

  it("keeps the existing AGY cwd correction in the daemon-owned path", () => {
    const cwd = join(root, "agy-worktree");
    mkdirSync(cwd, { recursive: true });
    const config = cfg([
      {
        id: "agy",
        kind: "cli",
        command: "agy",
        args: ["-p", "{task}", "--model", "gemini-test"],
      },
    ]);
    let args: readonly string[] = [];
    const launcher = createConfiguredLaneExecutionLauncher(config, {
      catalog: new ModelCatalog({ cachePath: null }),
      spawn: ((_command, seenArgs) => {
        args = seenArgs;
        return {
          result: Promise.resolve({ code: 0, stdout: "ok", stderr: "", timedOut: false }),
          kill: () => {},
        };
      }) as LaneSpawner,
      hostEnv: {},
      manifest: null,
      launcherPath: null,
    });

    const result = launcher(request("agy", cwd));
    expect("refusal" in result).toBe(false);
    expect(args).toEqual(expect.arrayContaining(["--add-dir", cwd]));
    const promptIndex = args.indexOf("-p");
    expect(args[promptIndex + 1]).toContain(`Work in this directory: ${cwd}`);
    if (!("refusal" in result)) {
      expect(result.launchNotes).toEqual(expect.arrayContaining([expect.stringContaining("agy works in")]));
    }
  });
});
