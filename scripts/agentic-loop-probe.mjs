// Drive a full agentic STEP through a running repair-proxy (mode=repair, openai
// backend → NIM): turn 1 the model emits a tool_use, we feed a tool_result, turn 2
// it produces the final answer. This exercises exactly what the Claude harness loop
// needs to survive the Anthropic↔OpenAI translation: tool-schema translation,
// tool_use validation+repair, tool_result round-trip, and multi-turn continuation.
//
// Requires the proxy running on PROXY (default 127.0.0.1:8791). Run:
//   node dist/cli.js --config <nim-openai-repair-config> &   # then:
//   node scripts/agentic-loop-probe.mjs
const PROXY = process.env.PROXY || "http://127.0.0.1:8791";
const MAGIC = "4271";

const tools = [{
  name: "read_file",
  description: "Read a file from the working directory and return its contents.",
  input_schema: { type: "object", properties: { path: { type: "string", description: "Path to the file" } }, required: ["path"] },
}];
const system = "You are a coding assistant. Use the read_file tool to inspect files before answering. Answer concisely.";

async function post(body) {
  const t0 = Date.now();
  const res = await fetch(`${PROXY}/v1/messages`, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: "Bearer dummy", "anthropic-version": "2023-06-01" },
    body: JSON.stringify(body),
  });
  const text = await res.text();
  let json; try { json = JSON.parse(text); } catch { json = null; }
  return { status: res.status, json, text, ms: Date.now() - t0 };
}

const base = { model: "claude-3-5-sonnet", max_tokens: 512, system, tools };

console.log(`Agentic-loop probe → ${PROXY}\n${"=".repeat(70)}`);

// --- Turn 1: ask; expect a tool_use ---
const turn1 = await post({ ...base, messages: [
  { role: "user", content: `What is the magic number in README.md? Use read_file.` },
] });
console.log(`Turn 1: HTTP ${turn1.status} (${turn1.ms}ms)`);
if (!turn1.json) { console.log("  no JSON:", turn1.text.slice(0, 300)); process.exit(1); }
const toolUse = (turn1.json.content || []).find((b) => b.type === "tool_use");
const text1 = (turn1.json.content || []).filter((b) => b.type === "text").map((b) => b.text).join("");
console.log(`  stop_reason=${turn1.json.stop_reason}`);
if (text1) console.log(`  text: ${text1.slice(0, 120)}`);
if (!toolUse) { console.log("  ✗ no tool_use emitted — model returned prose; loop cannot proceed."); process.exit(2); }
console.log(`  ✓ tool_use: ${toolUse.name}(${JSON.stringify(toolUse.input)}) id=${toolUse.id}`);

// --- Turn 2: feed a tool_result; expect the final answer citing the magic number ---
const turn2 = await post({ ...base, messages: [
  { role: "user", content: `What is the magic number in README.md? Use read_file.` },
  { role: "assistant", content: turn1.json.content },
  { role: "user", content: [
    { type: "tool_result", tool_use_id: toolUse.id, content: `The file contents are: The magic number is ${MAGIC}. Now state that number to the user.` },
  ] },
] });
console.log(`\nTurn 2: HTTP ${turn2.status} (${turn2.ms}ms)`);
if (!turn2.json) { console.log("  no JSON:", turn2.text.slice(0, 300)); }
else {
  const finalText = (turn2.json.content || []).filter((b) => b.type === "text").map((b) => b.text).join("");
  const reTool = (turn2.json.content || []).find((b) => b.type === "tool_use");
  console.log(`  stop_reason=${turn2.json.stop_reason}`);
  console.log(`  content blocks: ${JSON.stringify(turn2.json.content)}`);
  if (finalText) console.log(`  final text: ${finalText.slice(0, 200)}`);
  console.log(`\n${"=".repeat(70)}`);
  if (finalText.includes(MAGIC)) {
    console.log(`✓ LOOP COMPLETED: tool_use → tool_result → final answer cites ${MAGIC}.`);
  } else if (reTool) {
    console.log(`⚠ Turn 2 emitted ANOTHER tool_use (${reTool.name} ${JSON.stringify(reTool.input)}) instead of answering.`);
    console.log(`  If it re-reads the SAME file, the tool_result likely did not survive translation → loop would never terminate.`);
  } else {
    console.log(`✗ No final answer and no re-tool. content above.`);
  }
}
