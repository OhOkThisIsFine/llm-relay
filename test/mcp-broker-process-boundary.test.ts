import { execFileSync, spawn, type ChildProcess } from "node:child_process";
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const WINDOWS_IT = process.platform === "win32" ? it : it.skip;
const CLI = fileURLToPath(new URL("../src/cli.ts", import.meta.url));

interface RpcProcess {
  child: ChildProcess;
  messages: Array<Record<string, unknown>>;
  stderr: string[];
}

function isolatedEnv(dir: string): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env };
  delete env["VITEST"];
  env["HOME"] = dir;
  env["USERPROFILE"] = dir;
  env["XDG_CONFIG_HOME"] = join(dir, "xdg-config");
  env["XDG_CACHE_HOME"] = join(dir, "xdg-cache");
  env["LLM_RELAY_NO_SELF_UPDATE"] = "1";
  return env;
}

function alive(pid: number | undefined): boolean {
  if (pid === undefined) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function taskkill(pid: number | undefined, tree = false): void {
  if (pid === undefined) return;
  const args = ["/PID", String(pid), "/F"];
  if (tree) args.push("/T");
  try {
    execFileSync("taskkill", args, { stdio: "ignore", windowsHide: true });
  } catch {
    // Cleanup is best-effort; assertions wait for the intended boundary explicitly.
  }
}

async function waitFor<T>(
  read: () => T | null | undefined | false,
  timeoutMs: number,
  label: string,
): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const value = read();
    if (value) return value as T;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error(`timed out waiting for ${label}`);
}

async function freePort(): Promise<number> {
  const { createServer } = await import("node:net");
  const server = createServer();
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => resolve());
  });
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("could not allocate a port");
  const port = address.port;
  await new Promise<void>((resolve, reject) =>
    server.close((error) => error ? reject(error) : resolve()),
  );
  return port;
}

function spawnCli(args: string[], env: NodeJS.ProcessEnv): RpcProcess {
  const child = spawn(process.execPath, ["--import", "tsx", CLI, ...args], {
    cwd: process.cwd(),
    env,
    stdio: ["pipe", "pipe", "pipe"],
    windowsHide: true,
  });
  const messages: Array<Record<string, unknown>> = [];
  const stderr: string[] = [];
  let stdoutBuffer = "";
  child.stdout?.setEncoding("utf8");
  child.stderr?.setEncoding("utf8");
  child.stdout?.on("data", (chunk) => {
    stdoutBuffer += String(chunk);
    for (;;) {
      const nl = stdoutBuffer.indexOf("\n");
      if (nl < 0) break;
      const line = stdoutBuffer.slice(0, nl).trim();
      stdoutBuffer = stdoutBuffer.slice(nl + 1);
      if (!line) continue;
      try {
        messages.push(JSON.parse(line) as Record<string, unknown>);
      } catch {
        // MCP stdout should be JSON-RPC only; leave malformed text for the timeout diagnostic.
      }
    }
  });
  child.stderr?.on("data", (chunk) => stderr.push(String(chunk)));
  return { child, messages, stderr };
}

async function rpc(
  proc: RpcProcess,
  id: number,
  name: string,
  args: Record<string, unknown>,
  timeoutMs = 10_000,
): Promise<{ text: string; isError: boolean }> {
  proc.child.stdin?.write(
    JSON.stringify({
      jsonrpc: "2.0",
      id,
      method: "tools/call",
      params: { name, arguments: args },
    }) + "\n",
  );
  const message = await waitFor(
    () => proc.messages.find((candidate) => candidate["id"] === id),
    timeoutMs,
    `MCP response ${id}; stderr=${proc.stderr.join("")}`,
  );
  const result = message["result"] as
    | { content?: Array<{ text?: string }>; isError?: boolean }
    | undefined;
  return {
    text: result?.content?.[0]?.text ?? "",
    isError: result?.isError === true,
  };
}

function jobIdFrom(text: string): string {
  const match = /^job: (job-[0-9]+)$/mu.exec(text);
  if (!match?.[1]) throw new Error(`dispatch reply did not contain a job id:\n${text}`);
  return match[1];
}

function lanePid(path: string): number | null {
  if (!existsSync(path)) return null;
  const pid = Number(readFileSync(path, "utf8").trim());
  return Number.isSafeInteger(pid) && pid > 0 ? pid : null;
}

async function startHarness(delayMs: number): Promise<{
  dir: string;
  env: NodeJS.ProcessEnv;
  configPath: string;
  pidPath: string;
  donePath: string;
  daemon: RpcProcess;
  cleanup: () => void;
}> {
  const dir = mkdtempSync(join(tmpdir(), "llm-relay-d1-boundary-"));
  const env = isolatedEnv(dir);
  const port = await freePort();
  const configPath = join(dir, "config.json");
  const lanePath = join(dir, "fake-lane.mjs");
  const pidPath = join(dir, "lane.pid");
  const donePath = join(dir, "lane.done");

  writeFileSync(
    lanePath,
    [
      'import { writeFileSync } from "node:fs";',
      "const [pidPath, donePath, delay] = process.argv.slice(2);",
      'writeFileSync(pidPath, String(process.pid), "utf8");',
      "await new Promise((resolve) => setTimeout(resolve, Number(delay)));",
      'writeFileSync(donePath, "done", "utf8");',
      'process.stdout.write("D1_SURVIVED_MCP_RESTART\\n");',
    ].join("\n"),
    "utf8",
  );
  writeFileSync(
    configPath,
    JSON.stringify({
      listen: `127.0.0.1:${port}`,
      providers: {
        measurement: {
          base: "http://127.0.0.1:1",
          kind: "openai",
          credentialMode: "passthrough",
        },
      },
      routing: {
        default: "measurement/model",
        benchmarkSort: false,
        ladder: [{
          id: "fake-d1-lane",
          kind: "cli",
          command: process.execPath,
          args: [lanePath, pidPath, donePath, String(delayMs), "{task}"],
        }],
        mcp: { maxWaitMs: 500, blockingWaitMs: 500 },
      },
      log: { level: "silent", file: null },
    }, null, 2) + "\n",
    "utf8",
  );

  const daemon = spawnCli(["--config", configPath], env);
  await waitFor(
    () => daemon.stderr.join("").includes("llm-relay listening on"),
    15_000,
    `daemon listen; stderr=${daemon.stderr.join("")}`,
  );

  return {
    dir,
    env,
    configPath,
    pidPath,
    donePath,
    daemon,
    cleanup: () => {
      taskkill(daemon.child.pid, true);
      rmSync(dir, { recursive: true, force: true });
    },
  };
}

describe("D1 daemon-owned process boundary", () => {
  WINDOWS_IT("survives parent-only MCP kill and returns the same answer through a replacement MCP", async () => {
    const h = await startHarness(4_000);
    let first: RpcProcess | undefined;
    let replacement: RpcProcess | undefined;
    let pid: number | undefined;
    try {
      first = spawnCli(["mcp", "--config", h.configPath], h.env);
      const dispatch = await rpc(first, 1, "dispatch", {
        task: "run through the MCP restart",
        lane: "fake-d1-lane",
        waitMs: 500,
      });
      const jobId = jobIdFrom(dispatch.text);
      expect(dispatch.text).toContain("execution-owner: relay-daemon");

      pid = await waitFor(() => lanePid(h.pidPath), 10_000, "daemon-owned lane pid");
      expect(alive(pid)).toBe(true);

      // Load-bearing boundary: kill ONLY the MCP parent, never /T.
      taskkill(first.child.pid, false);
      await waitFor(() => !alive(first?.child.pid), 10_000, "original MCP to exit");
      await new Promise((resolve) => setTimeout(resolve, 300));
      expect(alive(pid)).toBe(true);

      replacement = spawnCli(["mcp", "--config", h.configPath], h.env);
      const status = await rpc(replacement, 2, "dispatch_status", { jobId });
      expect(status.text).toContain("execution-owner: relay-daemon");
      expect(status.text).toMatch(/status: (running|completed)/);
      if (status.text.includes("status: running")) {
        expect(status.text).toContain("recovered after MCP restart");
      }

      await waitFor(() => existsSync(h.donePath), 10_000, "fake lane completion");
      const result = await rpc(replacement, 3, "dispatch_result", { jobId });
      expect(result.isError).toBe(false);
      expect(result.text).toContain("D1_SURVIVED_MCP_RESTART");
      expect(result.text).toContain("status: completed");
    } finally {
      taskkill(first?.child.pid, true);
      taskkill(replacement?.child.pid, true);
      if (pid !== undefined && alive(pid)) taskkill(pid, true);
      h.cleanup();
    }
  }, 30_000);

  WINDOWS_IT("replacement MCP cancellation terminates the daemon-owned lane tree", async () => {
    const h = await startHarness(60_000);
    let first: RpcProcess | undefined;
    let replacement: RpcProcess | undefined;
    let pid: number | undefined;
    try {
      first = spawnCli(["mcp", "--config", h.configPath], h.env);
      const dispatch = await rpc(first, 10, "dispatch", {
        task: "stay alive until cancelled",
        lane: "fake-d1-lane",
        waitMs: 500,
      });
      const jobId = jobIdFrom(dispatch.text);
      pid = await waitFor(() => lanePid(h.pidPath), 10_000, "daemon-owned lane pid");

      taskkill(first.child.pid, false);
      await waitFor(() => !alive(first?.child.pid), 10_000, "original MCP to exit");
      expect(alive(pid)).toBe(true);

      replacement = spawnCli(["mcp", "--config", h.configPath], h.env);
      const cancelled = await rpc(replacement, 11, "dispatch_cancel", { jobId });
      expect(cancelled.text).toContain("cancelled");

      await waitFor(() => !alive(pid), 10_000, "daemon-owned lane to terminate after replacement cancel");
      expect(existsSync(h.donePath)).toBe(false);
    } finally {
      taskkill(first?.child.pid, true);
      taskkill(replacement?.child.pid, true);
      if (pid !== undefined && alive(pid)) taskkill(pid, true);
      h.cleanup();
    }
  }, 30_000);
});
