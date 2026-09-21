/**
 * Measure exact-session continuation for an interrupted active OpenCode headless run.
 *
 * Manual measurement only. It may consume provider/OpenCode quota and requires a configured local
 * CLI. It uses `--session <id>` exclusively; `--continue` is intentionally forbidden.
 *
 * Run:
 *   npm run build:server
 *   node scripts/measure-opencode-continuation.mjs
 */
import {
  delay,
  diagnosticFailure,
  hashIdentity,
  makeProbeWorkspace,
  processAlive,
  randomMarker,
  spawnJsonLineHarness,
  terminateProbeTree,
  waitForClose,
  waitForProbe,
} from "./continuation-probe-lib.mjs";

function stepStart(state) {
  return state.events.find(
    (event) =>
      event?.type === "step_start" &&
      typeof event?.sessionID === "string" &&
      event.sessionID.length > 0,
  );
}

function stepFinish(state) {
  return state.events.find(
    (event) =>
      event?.type === "step_finish" &&
      typeof event?.sessionID === "string",
  );
}

function toolEvent(state) {
  return state.events.find((event) => event?.type === "tool_use");
}

function latestText(state) {
  return [...state.events].reverse().find(
    (event) =>
      event?.type === "text" &&
      typeof event?.sessionID === "string" &&
      typeof event?.part?.text === "string",
  );
}

const workspace = makeProbeWorkspace("llm-relay-opencode-continuation-");
const marker = randomMarker("OPENCODE_CONTINUATION");
const firstPrompt = [
  "This is a process-continuation measurement. Do not use tools or subagents.",
  `Remember this exact marker for this session: ${marker}`,
  "Do not print the marker in this turn.",
  "Write a detailed continuous explanation of comparison sorting algorithms of at least 1800 words.",
  "Keep writing until the explanation is complete.",
].join("\n");
const resumePrompt =
  "What exact marker beginning with OPENCODE_CONTINUATION_ did I tell you to remember in my immediately previous message? Reply with only that marker and nothing else.";

let first;
let resumed;
const startedAt = Date.now();

try {
  first = spawnJsonLineHarness(
    "opencode",
    ["run", "--format", "json", firstPrompt],
    workspace.path,
  );

  const started = await waitForProbe(
    () => stepStart(first),
    60_000,
    "fresh step_start event with sessionID",
    first,
  );
  const sessionId = started.sessionID;

  // OpenCode's JSON runner emits a first-party step_start only after the exact session has been
  // created/loaded and the prompt has begun. Keep the run active briefly, but never allow it to
  // complete before the interruption.
  await delay(1_000);
  if (toolEvent(first)) {
    throw new Error("OpenCode used a tool despite the probe's tool-free instruction; measurement is invalid");
  }
  if (stepFinish(first) || latestText(first)) {
    throw new Error("fresh OpenCode run completed before interruption; measurement is invalid");
  }
  if (!processAlive(first.child?.pid)) {
    throw new Error("fresh OpenCode process exited before interruption; measurement is invalid");
  }

  await terminateProbeTree(first);
  await waitForClose(first);

  resumed = spawnJsonLineHarness(
    "opencode",
    ["run", "--format", "json", "--session", sessionId, resumePrompt],
    workspace.path,
  );

  const resumedStart = await waitForProbe(
    () => stepStart(resumed),
    60_000,
    "resumed step_start event",
    resumed,
  );
  const text = await waitForProbe(
    () => latestText(resumed),
    180_000,
    "resumed text event",
    resumed,
  );
  await waitForProbe(
    () => stepFinish(resumed) ?? resumed.closed,
    30_000,
    "resumed step_finish/process exit",
    resumed,
  );

  if (toolEvent(resumed)) {
    throw new Error("OpenCode used a tool during the resume check; measurement is invalid");
  }

  const exactSessionRecovered = resumedStart.sessionID === sessionId && text.sessionID === sessionId;
  const markerRecovered = text.part.text.trim() === marker;
  const success =
    resumed.code !== 1 &&
    exactSessionRecovered &&
    markerRecovered;

  const measurement = {
    harness: "opencode",
    success,
    freshIdentityObservedEarly: true,
    interruptedAfterStepStart: true,
    interruptedDelayMs: 1_000,
    exactSessionRecovered,
    markerRecovered,
    exitCode: resumed.code,
    canonicalIdentityHash: hashIdentity(sessionId),
    resumedIdentityHash: hashIdentity(resumedStart.sessionID),
    elapsedMs: Date.now() - startedAt,
  };

  process.stdout.write(`OPENCODE_CONTINUATION_MEASUREMENT ${JSON.stringify(measurement)}\n`);
} catch (error) {
  diagnosticFailure("OpenCode continuation measurement failed", error, [
    ["fresh", first],
    ["resumed", resumed],
  ]);
  throw error;
} finally {
  if (first) await terminateProbeTree(first);
  if (resumed) await terminateProbeTree(resumed);
  workspace.cleanup();
}
