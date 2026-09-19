/**
 * Real POSIX ownership check.
 *
 * Unit tests pin that the lane spawner requests `detached: true`; this test proves the OS
 * consequence the reaper depends on: a group leader plus an ordinary grandchild are both gone
 * after `terminateProcessTree(rootPid)`. It launches only the local Node binary — never an agent
 * CLI and never a provider request.
 */
import { describe, expect, it } from "vitest";
import { spawn } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { terminateProcessTree } from "../src/mcp/lane-runner.js";

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return (e as NodeJS.ErrnoException).code === "EPERM";
  }
}

async function waitForFile(path: string, timeoutMs = 3_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!existsSync(path) && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  expect(existsSync(path)).toBe(true);
}

async function waitForGone(pid: number, timeoutMs = 5_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (alive(pid) && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  expect(alive(pid)).toBe(false);
}

describe("POSIX lane process-group reaping", () => {
  it.skipIf(process.platform === "win32")("kills a spawned root and its grandchild as one owned group", async () => {
    const dir = mkdtempSync(join(tmpdir(), "llm-relay-posix-group-"));
    const pidFile = join(dir, "grandchild.pid");
    let rootPid: number | undefined;
    let grandchildPid: number | undefined;
    try {
      const script = [
        'const { spawn } = require("node:child_process");',
        'const { writeFileSync } = require("node:fs");',
        'const grandchild = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { stdio: "ignore" });',
        'writeFileSync(process.argv[1], String(grandchild.pid));',
        'setInterval(() => {}, 1000);',
      ].join("");

      const child = spawn(
        process.execPath,
        ["-e", script, pidFile],
        { cwd: dir, detached: true, windowsHide: true, stdio: ["pipe", "pipe", "pipe"] },
      );
      child.stdin?.end();
      rootPid = child.pid;
      expect(rootPid).toBeTypeOf("number");

      await waitForFile(pidFile);
      grandchildPid = Number(readFileSync(pidFile, "utf8"));
      expect(Number.isSafeInteger(grandchildPid) && grandchildPid > 0).toBe(true);
      expect(alive(rootPid!)).toBe(true);
      expect(alive(grandchildPid)).toBe(true);

      terminateProcessTree(rootPid!, process.platform);
      child.kill();

      await waitForGone(rootPid!);
      await waitForGone(grandchildPid);
    } finally {
      if (rootPid !== undefined && alive(rootPid)) terminateProcessTree(rootPid, process.platform);
      if (grandchildPid !== undefined && alive(grandchildPid)) {
        try {
          process.kill(grandchildPid, "SIGKILL");
        } catch {
          // Already gone.
        }
      }
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
