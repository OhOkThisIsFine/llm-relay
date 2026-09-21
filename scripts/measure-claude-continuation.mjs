/**
 * Measure exact-session continuation for an interrupted active Claude Code print-mode run.
 *
 * Manual measurement only. It consumes real Claude quota and requires an authenticated local CLI.
 * Exact `--resume <session-id>` is used; no "continue latest" facility is involved.
 *
 * Run:
 *   npm run build:server
 *   node scripts/measure-claude-continuation.mjs
 */
import {
  diagnosticFailure,
  hashIdentity,
  makeProbeWorkspace,
  probeEnv,
  randomMarker,
  spawnJsonLineHarness,
  terminateProbeTree,
  waitForClose,
  waitForProbe,
} from "./continuation-probe-lib.mjs";

function initEvent(state) {
  return state.events.find(
    (event) =>
      event?.type === "system" &&
      event?.subtype === "init" &&
      typeof event?.session_id === "string" &&
      event.session_id.length > 0,
  );
}

function activeOutputEvent(state) {
  return state.events.find(
    (event) =>
      event?.type === "stream_event" &&
      event?.event?.type === "content_block_delta",
  );
}

function toolEvent(state) {
  return state.events.find((event) => {
    if (
      event?.type === "stream_event" &&
      event?.event?.type === "content_block_start" &&
      event?.event?.content_block?.type === "tool_use"
    ) {
      return true;
    }
    if (event?.type !== "assistant" || !Array.isArray(event?.message?.content)) return false;
    return event.message.content.some((block) => block?.type === "tool_use");
  });
}

function resultEvent(state) {
  return state.events.find(
    (event) =>
      event?.type === "result" &&
      typeof event?.session_id === "string",
  );
}

function resultText(event) {
  return typeof event?.result === "string" ? event.result.trim() : "";
}

const workspace = makeProbeWorkspace("llm-relay-claude-continuation-");
const marker = randomMarker("CLAUDE_CONTINUATION");
const firstPrompt = [
  "This is a process-continuation measurement. Do not use any tools.",
  `Remember this exact marker for this conversation: ${marker}`,
  "Do not print the marker in this turn.",
  "Write a detailed continuous explanation of comparison sorting algorithms of at least 1800 words.",
  "Keep writing until the explanation is complete.",
].join("\n");
const resumePrompt =
  "What exact marker beginning with CLAUDE_CONTINUATION_ did I tell you to remember in my immediately previous message? Reply with only that marker and nothing else.";

const env = { ...probeEnv };
// A measurement launched from inside another Claude host must not inherit the nested-session guard.
// Keep the user's own auth/config variables intact.
delete env.CLAUDECODE;
delete env.CLAUDE_CODE_SSE_PORT;
delete env.CLAUDE_CODE_ENTRYPOINT;

let first;
let resumed;
const startedAt = Date.now();

try {
  first = spawnJsonLineHarness(
    "claude",
    [
      "--print",
      "--output-format",
      "stream-json",
      "--verbose",
      "--include-partial-messages",
      firstPrompt,
    ],
    workspace.path,
    { env },
  );

  const init = await waitForProbe(
    () => initEvent(first),
    30_000,
    "fresh system/init event with session_id",
    first,
  );
  const sessionId = init.session_id;

  await waitForProbe(
    () => activeOutputEvent(first),
    120_000,
    "active content-block delta",
    first,
  );

  if (toolEvent(first)) {
    throw new Error("Claude used a tool despite the probe's tool-free instruction; measurement is invalid");
  }
  if (resultEvent(first)) {
    throw new Error("fresh Claude run completed before it could be interrupted; measurement is invalid");
  }

  await terminateProbeTree(first);
  await waitForClose(first);

  resumed = spawnJsonLineHarness(
    "claude",
    [
      "--print",
      "--output-format",
      "stream-json",
      "--verbose",
      "--resume",
      sessionId,
      resumePrompt,
    ],
    workspace.path,
    { env },
  );

  const resumedInit = await waitForProbe(
    () => initEvent(resumed),
    30_000,
    "resumed system/init event",
    resumed,
  );
  const terminal = await waitForProbe(
    () => resultEvent(resumed),
    120_000,
    "resumed result event",
    resumed,
  );

  if (toolEvent(resumed)) {
    throw new Error("Claude used a tool during the resume check; measurement is invalid");
  }

  const markerRecovered = resultText(terminal) === marker;
  const resumedReportedSameInitId = resumedInit.session_id === sessionId;
  const resumedReportedSameResultId = terminal.session_id === sessionId;
  // Context recovery is the authoritative proof. Some Claude releases have changed whether a
  // resumed invocation reports the original id or an invocation-local id; the relay must retain
  // the ORIGINAL id as canonical either way.
  const success =
    terminal.subtype === "success" &&
    terminal.is_error !== true &&
    markerRecovered;

  const measurement = {
    harness: "claude",
    success,
    freshIdentityObservedEarly: true,
    interruptedDuringContentStream: true,
    markerRecovered,
    resumedReportedSameInitId,
    resumedReportedSameResultId,
    canonicalIdentityHash: hashIdentity(sessionId),
    resumedIdentityHash:
      typeof resumedInit.session_id === "string" ? hashIdentity(resumedInit.session_id) : null,
    resultSubtype: terminal.subtype ?? null,
    elapsedMs: Date.now() - startedAt,
  };

  process.stdout.write(`CLAUDE_CONTINUATION_MEASUREMENT ${JSON.stringify(measurement)}\n`);
} catch (error) {
  diagnosticFailure("Claude continuation measurement failed", error, [
    ["fresh", first],
    ["resumed", resumed],
  ]);
  throw error;
} finally {
  if (first) await terminateProbeTree(first);
  if (resumed) await terminateProbeTree(resumed);
  workspace.cleanup();
}
