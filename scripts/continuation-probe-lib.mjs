/**
 * Shared process/NDJSON plumbing for manual exact-resume capability measurements.
 *
 * These helpers are deliberately outside production runtime. They reuse the relay's compiled
 * executable lookup and Windows npm-shim parser so a probe exercises the same shell-free process
 * boundary as an actual lane without teaching production continuation behavior anything yet.
 */
import { execFileSync, spawn } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { extname, join } from "node:path";
import { executableOnPath } from "../dist/executable-lookup.js";
import { resolveWindowsNpmShim } from "../dist/mcp/windows-npm-shim.js";

const MAX_DIAGNOSTIC_CHARS = 64 * 1024;

export const probePlatform = process.platform;
export const probeEnv = { ...process.env };

export function delay(ms) {
  return new Promise((resolveDelay) => setTimeout(resolveDelay, ms));
}

export function makeProbeWorkspace(prefix) {
  const shared = process.env.LLM_RELAY_CONTINUATION_PROBE_WORKSPACE;
  if (shared) {
    if (!existsSync(shared)) {
      throw new Error("LLM_RELAY_CONTINUATION_PROBE_WORKSPACE does not exist");
    }
    return { path: shared, cleanup: () => {} };
  }

  const path = mkdtempSync(join(tmpdir(), prefix));
  return {
    path,
    cleanup: () => rmSync(path, { recursive: true, force: true }),
  };
}

export function randomMarker(prefix) {
  return `${prefix}_${randomBytes(12).toString("hex").toUpperCase()}`;
}

export function hashIdentity(value) {
  return createHash("sha256").update(value).digest("hex").slice(0, 12);
}

export function processAlive(pid) {
  if (!pid) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function resolvedInvocation(binary, args, cwd, env = probeEnv, platform = probePlatform) {
  const found = executableOnPath(binary, env, platform);
  if (!found) throw new Error(`${binary} is not on PATH or is not executable`);

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

export function spawnJsonLineHarness(binary, args, cwd, options = {}) {
  const env = options.env ?? probeEnv;
  const platform = options.platform ?? probePlatform;
  const invoke = resolvedInvocation(binary, args, cwd, env, platform);
  const events = [];
  const state = {
    binary,
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
      state.stdoutTail = (state.stdoutTail + raw + "\n").slice(-MAX_DIAGNOSTIC_CHARS);
      try {
        events.push(JSON.parse(raw));
      } catch (error) {
        state.parseError =
          `invalid JSONL from ${binary}: ${error instanceof Error ? error.message : String(error)}; ` +
          `line=${raw.slice(0, 1000)}`;
      }
    }
  });

  child.stderr.setEncoding("utf8");
  child.stderr.on("data", (chunk) => {
    state.stderr = (state.stderr + String(chunk)).slice(-MAX_DIAGNOSTIC_CHARS);
  });
  child.once("error", (error) => {
    state.stderr = (state.stderr + `\nspawn error: ${error.message}`).slice(-MAX_DIAGNOSTIC_CHARS);
  });
  child.once("close", (code, signal) => {
    state.closed = true;
    state.code = code;
    state.signal = signal;
    const tail = stdoutBuffer.trim();
    if (tail) {
      state.stdoutTail = (state.stdoutTail + tail).slice(-MAX_DIAGNOSTIC_CHARS);
      try {
        events.push(JSON.parse(tail));
      } catch (error) {
        state.parseError =
          `invalid final JSONL from ${binary}: ${error instanceof Error ? error.message : String(error)}; ` +
          `line=${tail.slice(0, 1000)}`;
      }
    }
  });

  return state;
}

export async function waitForProbe(read, timeoutMs, label, childState, intervalMs = 20) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const value = read();
    if (value) return value;
    if (childState?.parseError) throw new Error(childState.parseError);
    if (childState?.closed) {
      throw new Error(
        `${childState.binary} exited before ${label}: code=${childState.code} signal=${childState.signal}; ` +
        `stderr=${childState.stderr}`,
      );
    }
    await delay(intervalMs);
  }
  throw new Error(`timed out waiting for ${label}`);
}

export async function waitForClose(childState, timeoutMs = 10_000) {
  if (childState.closed) return;
  await waitForProbe(
    () => childState.closed,
    timeoutMs,
    `${childState.binary} process to close`,
    null,
    25,
  );
}

export async function terminateProbeTree(state, options = {}) {
  const platform = options.platform ?? probePlatform;
  const pid = state?.child?.pid;
  if (!pid || !processAlive(pid)) return;

  if (platform === "win32") {
    try {
      execFileSync("taskkill", ["/PID", String(pid), "/T", "/F"], {
        stdio: "pipe",
        windowsHide: true,
      });
    } catch {
      // The process can exit between the liveness read and taskkill.
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

  if (!processAlive(pid)) return;

  if (platform === "win32") {
    try {
      execFileSync("taskkill", ["/PID", String(pid), "/T", "/F"], {
        stdio: "pipe",
        windowsHide: true,
      });
    } catch {
      // Best-effort cleanup.
    }
    return;
  }

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

export function redactProbeDiagnostics(value) {
  return String(value)
    .replace(
      /("(?:session_id|thread_id|sessionID|conversation_id)"\\s*:\\s*")[^"]+(")/g,
      "$1<redacted>$2",
    )
    .replace(
      /\\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\\b/gi,
      "<redacted-id>",
    )
    .replace(/\\bses_[A-Za-z0-9_-]+\\b/g, "ses_<redacted>");
}

export function diagnosticFailure(prefix, error, states = []) {
  const message = error instanceof Error ? error.message : String(error);
  process.stderr.write(`${prefix}: ${redactProbeDiagnostics(message)}\n`);
  for (const [label, state] of states) {
    if (!state) continue;
    if (state.stderr) {
      process.stderr.write(`${label} stderr:\n${redactProbeDiagnostics(state.stderr)}\n`);
    }
    if (state.stdoutTail) {
      process.stderr.write(`${label} stdout tail:\n${redactProbeDiagnostics(state.stdoutTail)}\n`);
    }
  }
}
