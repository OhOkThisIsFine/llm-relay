/**
 * Run two exact-resume measurements concurrently in the SAME working directory.
 *
 * This is the live isolation check required before a harness can be considered safe for automatic
 * continuation. Each child still captures/resumes an explicit exact ID; this parent verifies both
 * end-to-end measurements succeed and that their canonical identity hashes are distinct.
 *
 * Usage:
 *   npm run build:server
 *   node scripts/measure-continuation-isolation.mjs agy
 *   node scripts/measure-continuation-isolation.mjs claude
 *   node scripts/measure-continuation-isolation.mjs codex
 *   node scripts/measure-continuation-isolation.mjs opencode
 *
 * Expect roughly twice the quota consumption of a single probe: two fresh interrupted turns plus
 * two exact-ID resume turns run concurrently.
 */
import { spawn } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(fileURLToPath(new URL("..", import.meta.url)));
const harness = process.argv[2];
const scripts = {
  agy: "measure-agy-continuation.mjs",
  claude: "measure-claude-continuation.mjs",
  codex: "measure-codex-continuation.mjs",
  opencode: "measure-opencode-continuation.mjs",
};
const prefixes = {
  agy: "AGY_CONTINUATION_MEASUREMENT ",
  claude: "CLAUDE_CONTINUATION_MEASUREMENT ",
  codex: "CODEX_CONTINUATION_MEASUREMENT ",
  opencode: "OPENCODE_CONTINUATION_MEASUREMENT ",
};

if (typeof harness !== "string" || !Object.hasOwn(scripts, harness)) {
  throw new Error("usage: node scripts/measure-continuation-isolation.mjs <agy|claude|codex|opencode>");
}

const sharedWorkspace = mkdtempSync(join(tmpdir(), `llm-relay-${harness}-isolation-`));
const script = join(root, "scripts", scripts[harness]);
const prefix = prefixes[harness];

function runChild(label) {
  return new Promise((resolveRun) => {
    const child = spawn(process.execPath, [script], {
      cwd: root,
      env: {
        ...process.env,
        LLM_RELAY_CONTINUATION_PROBE_WORKSPACE: sharedWorkspace,
      },
      windowsHide: true,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    let spawnError = null;
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk) => { stdout += String(chunk); });
    child.stderr.on("data", (chunk) => { stderr += String(chunk); });
    child.once("error", (error) => {
      spawnError = error;
    });
    child.once("close", (code, signal) => {
      resolveRun({
        label,
        code,
        signal,
        stdout,
        stderr,
        spawnError: spawnError instanceof Error ? spawnError.message : null,
      });
    });
  });
}

function parseMeasurement(run) {
  if (run.spawnError || run.code !== 0) {
    throw new Error(
      `${run.label} probe failed: spawnError=${run.spawnError ?? "none"} code=${run.code} signal=${run.signal}; stderr=${run.stderr}`,
    );
  }
  const line = run.stdout
    .split(/\r?\n/u)
    .find((candidate) => candidate.startsWith(prefix));
  if (!line) {
    throw new Error(`${run.label} probe emitted no ${prefix.trim()} line; stdout=${run.stdout}`);
  }
  const parsed = JSON.parse(line.slice(prefix.length));
  if (parsed?.success !== true) {
    throw new Error(`${run.label} probe reported success:false: ${JSON.stringify(parsed)}`);
  }
  const identityHash = parsed.canonicalIdentityHash ?? parsed.identityHash;
  if (typeof identityHash !== "string" || identityHash.length === 0) {
    throw new Error(`${run.label} probe did not report a canonical identity hash`);
  }
  return { parsed, identityHash };
}

try {
  const [leftRun, rightRun] = await Promise.all([runChild("left"), runChild("right")]);
  const left = parseMeasurement(leftRun);
  const right = parseMeasurement(rightRun);
  const identitiesDistinct = left.identityHash !== right.identityHash;
  const success = identitiesDistinct;

  process.stdout.write(
    `CONTINUATION_ISOLATION_MEASUREMENT ${JSON.stringify({
      harness,
      success,
      sameWorkingDirectory: true,
      bothExactResumeProbesPassed: true,
      identitiesDistinct,
      identityHashes: [left.identityHash, right.identityHash].sort(),
    })}\n`,
  );
} finally {
  rmSync(sharedWorkspace, { recursive: true, force: true });
}
