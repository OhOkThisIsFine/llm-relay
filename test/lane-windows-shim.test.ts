/**
 * Real Windows command-shim smoke test.
 *
 * The ordinary lane-runner suite injects a fake Windows process boundary, so it proves our
 * branching logic but not what Windows does with an npm-style .cmd/.ps1 shim pair.
 * This fixture launches only the local Node binary and spends no provider quota.
 */
import { describe, expect, it } from "vitest";
import { exec, execFile } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { resolveWindowsNpmShim } from "../src/mcp/windows-npm-shim.js";
import {
  createLaneSpawner,
  type LaneProcessApi,
} from "../src/mcp/lane-runner.js";

describe("Windows .cmd lane boundary", () => {
  it.skipIf(process.platform !== "win32")("resolves a real npm-generated vitest shim to its Node entrypoint", () => {
    const shim = join(process.cwd(), "node_modules", ".bin", "vitest.cmd");
    const resolved = resolveWindowsNpmShim(shim, ["--version"], {
      cwd: process.cwd(),
      env: process.env,
      nodeExecutable: process.execPath,
    });
    expect(resolved.ok).toBe(true);
    if (!resolved.ok) return;
    expect(resolved.command).toBe(process.execPath);
    expect(resolved.shimPath.toLowerCase()).toBe(shim.toLowerCase());
    expect(resolved.entryPath.toLowerCase()).toMatch(/[\\/]node_modules[\\/]vitest[\\/]vitest\.mjs$/);
    expect(resolved.args).toEqual([resolved.entryPath, "--version"]);
  });

  it.skipIf(process.platform !== "win32")("runs the npm PowerShell companion without reparsing adversarial args", async () => {
    const dir = mkdtempSync(join(tmpdir(), "llm-relay-cmd-shim-"));
    try {
      const command = "llm-relay-test-shim";
      // Deliberately hostile .cmd: the safe path must NEVER execute this file.
      writeFileSync(
        join(dir, `${command}.cmd`),
        "@echo off\r\necho CMD_SHOULD_NOT_RUN\r\nexit /b 99\r\n",
        "utf8",
      );
      // Npm-style companion metadata. The relay reads the literal $basedir target but NEVER
      // executes this PowerShell file; it launches target.js through Node directly.
      writeFileSync(
        join(dir, "target.js"),
        'console.log(JSON.stringify(process.argv.slice(2)))\n',
        "utf8",
      );
      writeFileSync(
        join(dir, `${command}.ps1`),
        [
          "$basedir=Split-Path $MyInvocation.MyCommand.Definition -Parent",
          'if (Test-Path "$basedir/node.exe") {',
          '  & "$basedir/node.exe" "$basedir/target.js" $args',
          "} else {",
          '  & "node.exe" "$basedir/target.js" $args',
          "}",
          "exit $LASTEXITCODE",
          "",
        ].join("\r\n"),
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

      const dangerous = [
        "one",
        "two words",
        'quote"inside',
        "& echo PWNED",
        "| more",
        "<input",
        ">output",
        "^caret",
        "%PATH%",
        "!bang!",
        "$(Write-Output PWNED)",
        "`backtick",
        "line1\nline2",
      ];
      const run = createLaneSpawner(processApi, {})(command, dangerous, {
        env,
        cwd: dir,
        timeoutMs: 5_000,
      });
      const result = await run.result;

      expect(result.code, result.stderr).toBe(0);
      expect(JSON.parse(result.stdout.trim())).toEqual(dangerous);
      expect(result.stdout).not.toContain("CMD_SHOULD_NOT_RUN");
      expect(shellFallbacks).toBe(0);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
