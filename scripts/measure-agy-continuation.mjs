/**
 * Measure whether AGY can resume the exact conversation of an interrupted active headless run.
 *
 * This is deliberately a measurement harness, not a CI test. It consumes a real AGY turn and
 * requires an already-authenticated local `agy` CLI. It never uses `--continue`: the entire
 * property under test is exact-ID resume.
 *
 * The first prompt asks for a deliberately long, tool-free answer and embeds a random marker.
 * Once AGY has emitted an ACTIVE agent_response event, this script terminates that process tree.
 * A fresh process then resumes with `--conversation <captured-id>` and is asked to return the
 * marker from the interrupted turn. Success proves all three facts continuation needs:
 *
 *   1. the exact conversation id is observable before normal exit;
 *   2. that id is resumable after process termination;
 *   3. the resumed process retains the interrupted turn's conversational state.
 *
 * Run from the repository root after a server build:
 *
 *   npm run build:server
 *   node scripts/measure-agy-continuation.mjs
 *
 * The script uses the relay's built Windows npm-shim resolver so arbitrary prompt text is never
 * passed through cmd.exe or PowerShell.
 */
import { execFileSync, spawn } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { extname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { executableOnPath } from "../dist/executable-lookup.js";
import { resolveWindowsNpmShim } from "../dist/mcp/windows-npm-shim.js";

const root = resolve(fileURLToPath(new URL("..", import.meta.url)));
const requiredDist = join(root, "dist", "mcp", "windows-npm-shim.js");
const platform = process.platform;
const env = { ...process.env };
const MAX_STDERR_CHARS = 64 * 1024;

function delay(ms) {
  return new Promise((resolveDelay) => setTimeout(resolveDelay, ms));
}

function processAlive(pid) {
  if (!pid) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function waitFor(read, timeoutMs, label, childState, intervalMs = 20) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const value = read();
    if (value) return value;
    if (childState?.closed) {
      throw new Error(
        `AGY exited before ${label}: code=${childState.code} signal=${childState.signal}; stderr=${childState.stderr}`,
      );
    }
    await delay(intervalMs);
  }
  throw new Error(`timed out waiting for ${label}`);
}

function resolvedAgyInvocation(args, cwd) {
  const found = executableOnPath("agy", env, platform);
  if (!found) throw new Error("agy is not on PATH; install/authenticate Antigravity CLI first");

  if (platform !== "win32") return { command: found, args: [...args] };

  const ext = extname(found).toLowerCase();
  if (ext !== ".cmd" && ext !== ".bat" && ext !== ".ps1") {
    return { command: found, args: [...args] };
  }

  const shim = resolveWindowsNpmShim(found, args, {
    cwd,
    env,
    nodeExecutable: process.execPath,
  });
  if (!shim.ok) throw new Error(shim.error);
  return { command: shim.command, args: shim.args };
}

function spawnAgy(args, cwd) {
  const invoke = resolvedAgyInvocation(args, cwd);
  const events = [];
  const state = {
    child: null,
    events,
    stderr: "",
    stdoutTail: "",
    closed: false,
    code: null,
    signal: null,
    parseError: null,
  };
  const child = spawn(invoke.command, invoke.args, {
    cwd,
    env,
    detached: platform !== "win32",
    windowsHide: true,
    stdio: ["ignore", "pipe", "pipe"],
  });
  state.child = child;

  let stdoutBuffer = "";
  child.stdout.setEncoding("utf8");
  child.stdout.on("data", (chunk) => {
    stdoutBuffer += String(chunk);
    for (;;) {
      const newline = stdoutBuffer.indexOf("\n");
      if (newline < 0) break;
      const raw = stdoutBuffer.slice(0, newline).trim();
      stdoutBuffer = stdoutBuffer.slice(newline + 1);
      if (!raw) continue;
      state.stdoutTail = (state.stdoutTail + raw + "\n").slice(-MAX_STDERR_CHARS);
      try {
        events.push(JSON.parse(raw));
      } catch (error) {
        state.parseError = `invalid stream-json line: ${error instanceof Error ? error.message : String(error)}; line=${raw.slice(0, 1000)}`;
      }
    }
  });

  child.stderr.setEncoding("utf8");
  child.stderr.on("data", (chunk) => {
    state.stderr = (state.stderr + String(chunk)).slice(-MAX_STDERR_CHARS);
  });
  child.once("error", (error) => {
    state.stderr = (state.stderr + `\nspawn error: ${error.message}`).slice(-MAX_STDERR_CHARS);
  });
  child.once("close", (code, signal) => {
    state.closed = true;
    state.code = code;
    state.signal = signal;
    const tail = stdoutBuffer.trim();
    if (tail) {
      state.stdoutTail = (state.stdoutTail + tail).slice(-MAX_STDERR_CHARS);
      try {
        events.push(JSON.parse(tail));
      } catch (error) {
        state.parseError = `invalid final stream-json line: ${error instanceof Error ? error.message : String(error)}; line=${tail.slice(0, 1000)}`;
      }
    }
  });
  return state;
}

async function terminateTree(state) {
  const pid = state.child?.pid;
  if (!pid || !processAlive(pid)) return;

  if (platform === "win32") {
    try {
      execFileSync("taskkill", ["/PID", String(pid), "/T", "/F"], {
        stdio: "pipe",
        windowsHide: true,
      });
    } catch {
      // The process can exit between the liveness check and taskkill.
    }
  } else {
    try {
      process.kill(-pid, "SIGTERM");
    } catch {
      try {
        state.child.kill("SIGTERM");
      } catch {
        // Already gone.
      }
    }
  }

  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline && processAlive(pid)) await delay(25);

  if (processAlive(pid)) {
    if (platform === "win32") {
      try {
        execFileSync("taskkill", ["/PID", String(pid), "/T", "/F"], {
          stdio: "pipe",
          windowsHide: true,
        });
      } catch {
        // Best-effort cleanup.
      }
    } else {
      try {
        process.kill(-pid, "SIGKILL");
      } catch {
        try {
          state.child.kill("SIGKILL");
        } catch {
          // Best-effort cleanup.
        }
      }
    }
  }
}

function initEvent(state) {
  return state.events.find(
    (event) =>
      event?.event === "init" &&
      typeof event?.conversation_id === "string" &&
      event.conversation_id.length > 0,
  );
}

function activeAgentEvent(state) {
  return state.events.find(
    (event) =>
      event?.event === "step_update" &&
      event?.step_update?.step_type === "agent_response" &&
      event?.step_update?.state === "ACTIVE",
  );
}

function resultEvent(state) {
  return state.events.find(
    (event) =>
      event?.event === "result" &&
      typeof event?.result?.conversation_id === "string",
  );
}

if (!existsSync(requiredDist)) {
  throw new Error("dist/ is missing or stale; run npm run build:server before this measurement");
}

const workspace = mkdtempSync(join(tmpdir(), "llm-relay-agy-continuation-"));
const marker = `AGY_CONTINUATION_${randomBytes(12).toString("hex").toUpperCase()}`;
const firstPrompt = [
  "This is a process-continuation measurement. Do not use any tools.",
  `Remember this exact marker for the conversation: ${marker}`,
  "Do not print the marker in this turn.",
  "Now write a detailed, continuous explanation of comparison sorting algorithms of at least 1800 words.",
  "Keep writing until the explanation is complete.",
].join("\n");
const resumePrompt =
  "What exact marker beginning with AGY_CONTINUATION_ did I tell you to remember in my immediately previous message? Reply with only that marker and nothing else.";

let first;
let resumed;
const startedAt = Date.now();

try {
  first = spawnAgy(
    ["-p", firstPrompt, "--output-format", "stream-json", "--print-timeout", "5m"],
    workspace,
  );

  const init = await waitFor(
    () => initEvent(first),
    30_000,
    "fresh init event with conversation_id",
    first,
  );
  const conversationId = init.conversation_id;

  await waitFor(
    () => activeAgentEvent(first),
    120_000,
    "ACTIVE agent_response event",
    first,
  );

  if (resultEvent(first)) {
    throw new Error("fresh AGY run completed before it could be interrupted; measurement is invalid");
  }

  await terminateTree(first);
  await waitFor(
    () => first.closed || !processAlive(first.child?.pid),
    10_000,
    "interrupted AGY process to exit",
    first,
  );

  resumed = spawnAgy(
    [
      "-p",
      resumePrompt,
      "--conversation",
      conversationId,
      "--output-format",
      "stream-json",
      "--print-timeout",
      "2m",
    ],
    workspace,
  );

  const resumedInit = await waitFor(
    () => initEvent(resumed),
    30_000,
    "resumed init event",
    resumed,
  );
  const terminal = await waitFor(
    () => resultEvent(resumed),
    120_000,
    "resumed result event",
    resumed,
  );

  if (resumed.parseError) throw new Error(resumed.parseError);

  const response = typeof terminal.result.response === "string" ? terminal.result.response.trim() : "";
  const resultConversationId = terminal.result.conversation_id;
  const sameInitConversation = resumedInit.conversation_id === conversationId;
  const sameResultConversation = resultConversationId === conversationId;
  const markerRecovered = response === marker;
  const success =
    terminal.result.status === "SUCCESS" &&
    sameInitConversation &&
    sameResultConversation &&
    markerRecovered;

  const measurement = {
    platform,
    success,
    freshIdentityObservedEarly: true,
    interruptedWhileAgentResponseActive: true,
    sameInitConversation,
    sameResultConversation,
    markerRecovered,
    resumedStatus: terminal.result.status ?? null,
    conversationHash: createHash("sha256").update(conversationId).digest("hex").slice(0, 12),
    elapsedMs: Date.now() - startedAt,
  };

  process.stdout.write(`AGY_CONTINUATION_MEASUREMENT ${JSON.stringify(measurement)}\n`);

  // A negative capability result is a valid measurement, not a harness crash. The JSON line is
  // the evidence. Setup/protocol failures still throw above.
} catch (error) {
  const message = error instanceof Error ? error.message : String(error);
  process.stderr.write(`AGY continuation measurement failed: ${message}\n`);
  if (first?.stderr) process.stderr.write(`fresh stderr:\n${first.stderr}\n`);
  if (resumed?.stderr) process.stderr.write(`resumed stderr:\n${resumed.stderr}\n`);
  throw error;
} finally {
  if (first) await terminateTree(first);
  if (resumed) await terminateTree(resumed);
  rmSync(workspace, { recursive: true, force: true });
}
