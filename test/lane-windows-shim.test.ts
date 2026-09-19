/**
 * Real Windows command-shim smoke test.
 *
 * The ordinary lane-runner suite injects a fake Windows process boundary, so it proves our
 * branching logic but not what Node + cmd.exe actually do with an npm-style .cmd executable.
 * This fixture launches only the local Node binary and spends no provider quota.
 */
import { describe, expect, it } from "vitest";
import { exec, execFile } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  createLaneSpawner,
  type LaneProcessApi,
} from "../src/mcp/lane-runner.js";

describe("Windows .cmd lane boundary", () => {
  it.skipIf(process.platform !== "win32")("runs a PATH-resolved .cmd shim and preserves a spaced argument", async () => {
    const dir = mkdtempSync(join(tmpdir(), "llm-relay-cmd-shim-"));
    try {
      const command = "llm-relay-test-shim";
      writeFileSync(
        join(dir, `${command}.cmd`),
        '@echo off\r\nnode -e "console.log(JSON.stringify(process.argv.slice(1)))" %*\r\n',
        "utf8",
      );

      let shellFallbacks = 0;
      const processApi: LaneProcessApi = {
        platform: "win32",
        execFile: (file, args, opts, callback) => execFile(file, args, opts, callback),
        exec: (line, opts, callback) => {
          shellFallbacks += 1;
          return exec(line, opts, callback);
        },
      };

      const env: NodeJS.ProcessEnv = {};
      for (const [name, value] of Object.entries(process.env)) {
        if (name.toUpperCase() !== "PATH") env[name] = value;
      }
      env.PATH = `${dir};${process.env.PATH ?? ""}`;
      env.PATHEXT = process.env.PATHEXT ?? ".COM;.EXE;.BAT;.CMD";

      const run = createLaneSpawner(processApi, {})(command, ["one", "two words"], {
        env,
        cwd: dir,
        timeoutMs: 5_000,
      });
      const result = await run.result;

      expect(result.code).toBe(0);
      expect(JSON.parse(result.stdout.trim())).toEqual(["one", "two words"]);
      expect(shellFallbacks).toBe(1);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
