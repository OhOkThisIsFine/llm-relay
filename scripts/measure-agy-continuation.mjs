/**
 * Measure whether AGY can resume the exact conversation of an interrupted active headless run.
 *
 * Manual measurement only. It consumes real AGY quota and requires an authenticated local CLI.
 * It never uses `--continue`; exact-ID resume is the property under test.
 *
 * Run:
 *   npm run build:server
 *   node scripts/measure-agy-continuation.mjs
 */
import {
  diagnosticFailure,
  hashIdentity,
  makeProbeWorkspace,
  randomMarker,
  spawnJsonLineHarness,
  terminateProbeTree,
  waitForClose,
  waitForProbe,
} from "./continuation-probe-lib.mjs";

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

function toolEvent(state) {
  return state.events.find(
    (event) =>
      event?.event === "step_update" &&
      event?.step_update?.step_type === "tool",
  );
}

function resultEvent(state) {
  return state.events.find(
    (event) =>
      event?.event === "result" &&
      typeof event?.result?.conversation_id === "string",
  );
}

const workspace = makeProbeWorkspace("llm-relay-agy-continuation-");
const marker = randomMarker("AGY_CONTINUATION");
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
  first = spawnJsonLineHarness(
    "agy",
    ["-p", firstPrompt, "--output-format", "stream-json", "--print-timeout", "5m"],
    workspace.path,
  );

  const init = await waitForProbe(
    () => initEvent(first),
    30_000,
    "fresh init event with conversation_id",
    first,
  );
  const conversationId = init.conversation_id;

  await waitForProbe(
    () => activeAgentEvent(first),
    120_000,
    "ACTIVE agent_response event",
    first,
  );

  if (toolEvent(first)) {
    throw new Error("AGY used a tool despite the probe's tool-free instruction; measurement is invalid");
  }
  if (resultEvent(first)) {
    throw new Error("fresh AGY run completed before it could be interrupted; measurement is invalid");
  }

  await terminateProbeTree(first);
  await waitForClose(first);

  resumed = spawnJsonLineHarness(
    "agy",
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
    workspace.path,
  );

  const resumedInit = await waitForProbe(
    () => initEvent(resumed),
    30_000,
    "resumed init event",
    resumed,
  );
  const terminal = await waitForProbe(
    () => resultEvent(resumed),
    120_000,
    "resumed result event",
    resumed,
  );

  if (toolEvent(resumed)) {
    throw new Error("AGY used a tool during the resume check; measurement is invalid");
  }

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
    harness: "agy",
    success,
    freshIdentityObservedEarly: true,
    interruptedWhileAgentResponseActive: true,
    sameInitConversation,
    sameResultConversation,
    markerRecovered,
    resumedStatus: terminal.result.status ?? null,
    identityHash: hashIdentity(conversationId),
    elapsedMs: Date.now() - startedAt,
  };

  process.stdout.write(`AGY_CONTINUATION_MEASUREMENT ${JSON.stringify(measurement)}\n`);
} catch (error) {
  diagnosticFailure("AGY continuation measurement failed", error, [
    ["fresh", first],
    ["resumed", resumed],
  ]);
  throw error;
} finally {
  if (first) await terminateProbeTree(first);
  if (resumed) await terminateProbeTree(resumed);
  workspace.cleanup();
}
