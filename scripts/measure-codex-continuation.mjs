/**
 * Measure whether an ACTIVE interrupted Codex exec turn is already durable enough for exact resume.
 *
 * Manual measurement only. It consumes real Codex quota and requires an authenticated local CLI.
 * This intentionally tests the hard-cap case: the fresh process is killed AFTER `turn.started`
 * but BEFORE `turn.completed`. A normal completed-thread resume is already documented; active-turn
 * durability is the missing property.
 *
 * Run:
 *   npm run build:server
 *   node scripts/measure-codex-continuation.mjs
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

function threadStarted(state) {
  return state.events.find(
    (event) =>
      event?.type === "thread.started" &&
      typeof event?.thread_id === "string" &&
      event.thread_id.length > 0,
  );
}

function turnStarted(state) {
  return state.events.find((event) => event?.type === "turn.started");
}

function terminalTurn(state) {
  return state.events.find(
    (event) => event?.type === "turn.completed" || event?.type === "turn.failed",
  );
}

function latestAgentMessage(state) {
  return [...state.events].reverse().find(
    (event) =>
      event?.type === "item.completed" &&
      event?.item?.type === "agent_message" &&
      typeof event?.item?.text === "string",
  );
}

const workspace = makeProbeWorkspace("llm-relay-codex-continuation-");
const marker = randomMarker("CODEX_CONTINUATION");
const firstPrompt = [
  "This is a process-continuation measurement. Do not use shell commands, file tools, web tools, or subagents.",
  `Remember this exact marker for this thread: ${marker}`,
  "Do not print the marker in this turn.",
  "Write a detailed continuous explanation of comparison sorting algorithms of at least 1800 words.",
  "Keep writing until the explanation is complete.",
].join("\n");
const resumePrompt =
  "What exact marker beginning with CODEX_CONTINUATION_ did I tell you to remember in my immediately previous message? Reply with only that marker and nothing else.";

let first;
let resumed;
const startedAt = Date.now();

try {
  first = spawnJsonLineHarness(
    "codex",
    [
      "exec",
      "--json",
      "--color",
      "never",
      "--skip-git-repo-check",
      firstPrompt,
    ],
    workspace.path,
  );

  const thread = await waitForProbe(
    () => threadStarted(first),
    30_000,
    "fresh thread.started event",
    first,
  );
  const threadId = thread.thread_id;

  await waitForProbe(
    () => turnStarted(first),
    30_000,
    "fresh turn.started event",
    first,
  );

  // Give the active request a small persistence window while keeping the measurement strictly
  // pre-terminal. If current Codex cannot durably resume even here, hard-cap continuation is not
  // safe to enable for a first-turn lane.
  await delay(2_000);
  if (terminalTurn(first)) {
    throw new Error("fresh Codex turn completed before interruption; measurement is invalid");
  }
  if (!processAlive(first.child?.pid)) {
    throw new Error("fresh Codex process exited before interruption; measurement is invalid");
  }

  await terminateProbeTree(first);
  await waitForClose(first);

  resumed = spawnJsonLineHarness(
    "codex",
    [
      "exec",
      "resume",
      threadId,
      "--json",
      "--color",
      "never",
      "--skip-git-repo-check",
      resumePrompt,
    ],
    workspace.path,
  );

  const resumedThread = await waitForProbe(
    () => threadStarted(resumed),
    30_000,
    "resumed thread.started event",
    resumed,
  );
  const terminal = await waitForProbe(
    () => terminalTurn(resumed),
    120_000,
    "resumed terminal turn event",
    resumed,
  );
  const message = latestAgentMessage(resumed);

  const exactThreadRecovered = resumedThread.thread_id === threadId;
  const markerRecovered = message?.item?.text?.trim() === marker;
  const success =
    terminal.type === "turn.completed" &&
    exactThreadRecovered &&
    markerRecovered;

  const measurement = {
    harness: "codex",
    success,
    freshIdentityObservedEarly: true,
    interruptedAfterTurnStarted: true,
    interruptedDelayMs: 2_000,
    exactThreadRecovered,
    markerRecovered,
    terminalType: terminal.type,
    canonicalIdentityHash: hashIdentity(threadId),
    resumedIdentityHash: hashIdentity(resumedThread.thread_id),
    elapsedMs: Date.now() - startedAt,
  };

  process.stdout.write(`CODEX_CONTINUATION_MEASUREMENT ${JSON.stringify(measurement)}\n`);
} catch (error) {
  diagnosticFailure("Codex continuation measurement failed", error, [
    ["fresh", first],
    ["resumed", resumed],
  ]);
  throw error;
} finally {
  if (first) await terminateProbeTree(first);
  if (resumed) await terminateProbeTree(resumed);
  workspace.cleanup();
}
