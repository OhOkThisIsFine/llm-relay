/**
 * Measure whether a real Windows MCP lane process survives a force-kill of its MCP parent.
 *
 * This is deliberately a measurement, not a test. It exercises the built CLI and the real
 * lane-spawn boundary, starts a 60-second fake CLI lane through MCP, then runs:
 *
 *   taskkill /PID <mcp-pid> /F
 *
 * with NO /T. The output answers the three S4 questions: whether the lane is alive after the
 * parent dies, whether it finishes, and whether all 60 one-per-second writes reach disk.
 *
 * Run after `npm run build:server`:
 *   node scripts/measure-lane-orphan.mjs
 */
import { execFileSync, spawn } from "node:child_process";
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(fileURLToPath(new URL("..", import.meta.url)));
const cli = join(root, "dist", "cli.js");

function delay(ms) {
  return new Promise((resolveDelay) => setTimeout(resolveDelay, ms));
}

async function waitFor(predicate, timeoutMs, label, intervalMs = 100) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const value = predicate();
    if (value) return value;
    await delay(intervalMs);
  }
  throw new Error(`timed out waiting for ${label}`);
}

async function freePort() {
  const server = createServer();
  await new Promise((resolveListen, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolveListen);
  });
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("could not allocate an isolated port");
  const port = address.port;
  await new Promise((resolveClose, reject) => server.close((error) => error ? reject(error) : resolveClose()));
  return port;
}

function processAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function outputLines(path) {
  if (!existsSync(path)) return 0;
  return readFileSync(path, "utf8").split(/\r?\n/u).filter(Boolean).length;
}

function forceKill(pid, includeTree = false) {
  const args = ["/PID", String(pid), "/F"];
  if (includeTree) args.push("/T");
  try {
    execFileSync("taskkill", args, { stdio: "pipe", windowsHide: true });
  } catch {
    // Cleanup is best-effort; the measurement kill itself is checked by waiting for the parent.
  }
}

if (process.platform !== "win32") {
  throw new Error("measure-lane-orphan.mjs is a Windows-only measurement");
}
if (!existsSync(cli)) {
  throw new Error("dist/cli.js is missing; run npm run build:server first");
}

const dir = mkdtempSync(join(tmpdir(), "llm-relay-lane-orphan-"));
const configPath = join(dir, "config.json");
const fakeLanePath = join(dir, "fake-lane.mjs");
const outputPath = join(dir, "lane-output.txt");
const pidPath = join(dir, "lane.pid");
const port = await freePort();

const fakeLane = `
import { appendFileSync, writeFileSync } from "node:fs";
const [outputPath, pidPath] = process.argv.slice(2);
writeFileSync(pidPath, String(process.pid), "utf8");
for (let line = 1; line <= 60; line += 1) {
  await new Promise((resolve) => setTimeout(resolve, 1000));
  appendFileSync(outputPath, \`line \${line}\\n\`, "utf8");
}
`;
writeFileSync(fakeLanePath, fakeLane, "utf8");

writeFileSync(configPath, JSON.stringify({
  listen: `127.0.0.1:${port}`,
  providers: {
    measurement: {
      base: `http://127.0.0.1:${port}`,
      kind: "openai",
      credentialMode: "passthrough",
    },
  },
  routing: {
    default: "measurement/model",
    benchmarkSort: false,
    ladder: [{
      id: "fake-orphan-lane",
      kind: "cli",
      command: process.execPath,
      args: [fakeLanePath, outputPath, pidPath, "{task}"],
    }],
    mcp: {
      maxWaitMs: 1000,
      blockingWaitMs: 1000,
    },
  },
}, null, 2) + "\n", "utf8");

let mcp;
let lanePid;
let stdout = "";
let stderr = "";
const startedAt = Date.now();

try {
  mcp = spawn(process.execPath, [cli, "mcp", "--config", configPath], {
    cwd: root,
    stdio: ["pipe", "pipe", "pipe"],
    windowsHide: true,
  });
  if (!mcp.pid) throw new Error("MCP child did not expose a pid");
  mcp.stdout.setEncoding("utf8");
  mcp.stderr.setEncoding("utf8");
  mcp.stdout.on("data", (chunk) => { stdout += chunk; });
  mcp.stderr.on("data", (chunk) => { stderr += chunk; });

  const request = {
    jsonrpc: "2.0",
    id: 1,
    method: "tools/call",
    params: {
      name: "dispatch",
      arguments: {
        task: "Run until the measurement child exits.",
        lane: "fake-orphan-lane",
        waitMs: 1000,
      },
    },
  };
  mcp.stdin.write(JSON.stringify(request) + "\n");

  lanePid = await waitFor(() => {
    if (!processAlive(mcp.pid)) {
      throw new Error("MCP parent exited before the fake lane started");
    }
    if (!existsSync(pidPath)) return null;
    const parsed = Number(readFileSync(pidPath, "utf8").trim());
    return Number.isInteger(parsed) && parsed > 0 ? parsed : null;
  }, 15_000, "fake lane pid");

  await waitFor(() => outputLines(outputPath) >= 1, 10_000, "first fake-lane output line");

  // Load-bearing measurement: kill ONLY the MCP process. Do not add /T here.
  forceKill(mcp.pid, false);
  await waitFor(() => !processAlive(mcp.pid), 10_000, "MCP parent to exit");

  await delay(500);
  const laneAliveAfterMcpKill = processAlive(lanePid);

  // If the lane survived the parent, give it time to complete its intended 60-second workload.
  // If it is already dead, waiting cannot teach us anything more: the output count is final.
  if (laneAliveAfterMcpKill) {
    try {
      await waitFor(
        () => !processAlive(lanePid) || outputLines(outputPath) >= 60,
        75_000,
        "fake lane to finish or exit",
        250,
      );
    } catch {
      // A still-live lane at the measurement ceiling is itself a valid measurement result.
    }
  }

  const lines = outputLines(outputPath);
  const laneProcessExited = !processAlive(lanePid);
  const laneFinished = laneProcessExited && lines === 60;
  const result = {
    platform: process.platform,
    mcpPid: mcp.pid,
    lanePid,
    laneAliveAfterMcpKill,
    laneProcessExited,
    laneFinished,
    outputLines: lines,
    expectedLines: 60,
    elapsedMs: Date.now() - startedAt,
  };
  // A negative result is not a harness failure. S4 exists to discover which behavior Windows has.
  process.stdout.write(`LANE_ORPHAN_MEASUREMENT ${JSON.stringify(result)}\n`);
} catch (error) {
  process.stderr.write(`lane orphan measurement failed: ${error instanceof Error ? error.message : String(error)}\n`);
  if (stderr.length > 0) process.stderr.write(`MCP stderr:\n${stderr}\n`);
  if (stdout.length > 0) process.stderr.write(`MCP stdout:\n${stdout}\n`);
  throw error;
} finally {
  if (mcp?.pid && processAlive(mcp.pid)) forceKill(mcp.pid, true);
  if (lanePid && processAlive(lanePid)) forceKill(lanePid, true);
  rmSync(dir, { recursive: true, force: true });
}
