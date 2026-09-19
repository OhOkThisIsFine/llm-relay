import { describe, expect, it } from "vitest";
import {
  npmPowerShellEntrypoint,
  resolveWindowsNpmShim,
} from "../src/mcp/windows-npm-shim.js";

describe("Windows npm shim resolution", () => {
  const shim = "C:\\npm\\tool.cmd";
  const ps1 = "C:\\npm\\tool.ps1";
  const entry = "C:\\npm\\node_modules\\tool\\bin\\cli.js";
  const text = [
    "$basedir=Split-Path $MyInvocation.MyCommand.Definition -Parent",
    'if (Test-Path "$basedir/node$exe") {',
    '  & "$basedir/node$exe" "$basedir/node_modules/tool/bin/cli.js" $args',
    "} else {",
    '  & "node$exe" "$basedir/node_modules/tool/bin/cli.js" $args',
    "}",
  ].join("\r\n");

  it("extracts the literal Node entrypoint and ignores the local-node placeholder", () => {
    const files = new Set([entry]);
    expect(npmPowerShellEntrypoint(
      ps1,
      text,
      (path) => files.has(path),
      () => "#!/usr/bin/env node\n",
    )).toBe(entry);
  });

  it("keeps arbitrary lane argv byte-for-byte while replacing only the executable prefix", () => {
    const files = new Set([shim, ps1, entry]);
    const dangerous = [
      "two words",
      'quote"inside',
      "& echo NO",
      "| more",
      "<in",
      ">out",
      "^caret",
      "%PATH%",
      "!bang!",
      "$(Write-Output NO)",
      "`backtick",
      "line1\nline2",
    ];
    const result = resolveWindowsNpmShim("tool", dangerous, {
      cwd: "C:\\work",
      env: { PATH: "C:\\npm", PATHEXT: ".EXE;.CMD" },
      nodeExecutable: "C:\\node\\node.exe",
      isFile: (path) => files.has(path),
      readText: (path) => path === ps1 ? text : "#!/usr/bin/env node\n",
      onPath: () => shim,
    });
    expect(result).toEqual({
      ok: true,
      command: "C:\\node\\node.exe",
      args: [entry, ...dangerous],
      shimPath: shim,
      entryPath: entry,
    });
  });

  it("fails closed when a batch file has no npm PowerShell companion", () => {
    const result = resolveWindowsNpmShim("tool.cmd", ["x"], {
      cwd: "C:\\npm",
      env: {},
      isFile: (path) => path === shim,
      readText: () => "",
    });
    expect(result).toEqual({
      ok: false,
      error: "npm PowerShell companion not found for C:\\npm\\tool.cmd",
    });
  });

  it("fails closed when the companion does not name a literal Node entrypoint", () => {
    const files = new Set([shim, ps1]);
    const result = resolveWindowsNpmShim("tool.cmd", ["x"], {
      cwd: "C:\\npm",
      env: {},
      isFile: (path) => files.has(path),
      readText: () => "& some-dynamic-command $args",
    });
    expect(result).toEqual({
      ok: false,
      error: "npm PowerShell companion has no supported Node entrypoint: C:\\npm\\tool.ps1",
    });
  });
});
