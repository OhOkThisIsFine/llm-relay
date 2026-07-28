// Trip-rate dataset: for each (model × schema-difficulty × trial), hit real NVIDIA
// NIM, run the tool call through the proxy's REAL validator, and on a failure run
// the proxy's repair() with a strong-model reshaper. Aggregates per-model TRIP RATE
// (share of tool calls that fail schema validation) and REPAIR-FIX RATE (share of
// those failures the reshaper corrects). This is the dataset that tells you which
// backend models are format-broken-but-repairable vs clean vs unusable.
//
// Run: npm run build && node scripts/nim-trip-rate.mjs
// Env: NVIDIA_API_KEY (or LLM_BACKEND_API_KEY), LLM_BACKEND_BASE_URL
// Optional: RP_MODELS="a,b,c"  RP_TRIALS=3  RP_RESHAPER="meta/llama-3.1-70b-instruct"
import { writeFileSync } from "node:fs";
import { ToolUseValidator } from "../dist/validator.js";
import { repair, destructiveMatcher } from "../dist/repair.js";
import { parseCorrectedInputs, reconstruct } from "../dist/reshaper.js";
import { toolSchemaMap } from "../dist/anthropic.js";

const KEY = process.env.NVIDIA_API_KEY || process.env.LLM_BACKEND_API_KEY;
const BASE = process.env.LLM_BACKEND_BASE_URL || "https://integrate.api.nvidia.com/v1";
if (!KEY) { console.error("Set NVIDIA_API_KEY (or LLM_BACKEND_API_KEY)."); process.exit(1); }

const TRIALS = Number(process.env.RP_TRIALS) || 3;
const RESHAPER_MODEL = process.env.RP_RESHAPER || "z-ai/glm-5.2";
// 70s was too tight: llama-3.3-70b cold-starts in ~86s and got scored `timeout`,
// which reads identically to "model is dead". Give a cold start room to finish.
const TIMEOUT_MS = Number(process.env.RP_TIMEOUT_MS) || 120000;
// Verified live on 2026-07-28. Ids are checked against /models AND an actual
// completion — several ids NIM still lists return 404 from /chat/completions,
// so listing alone is not evidence a model is usable.
const DEFAULT_MODELS = [
  "meta/llama-3.1-8b-instruct",
  "meta/llama-3.3-70b-instruct",
  "nvidia/nemotron-3-super-120b-a12b",
  "z-ai/glm-5.2",
];
const MODELS = (process.env.RP_MODELS ? process.env.RP_MODELS.split(",").map((s) => s.trim()).filter(Boolean) : DEFAULT_MODELS);

// Schemas graded by how hard weak models find them, each with a prompt whose
// natural answer should trigger a tool call.
const SCENARIOS = [
  {
    id: "flat_single",
    difficulty: "easy",
    prompt: "What's the weather in Paris? Use get_weather.",
    tool: { name: "get_weather", description: "Get current weather for a city.",
      input_schema: { type: "object", properties: { city: { type: "string" } }, required: ["city"] } },
  },
  {
    id: "enum_required",
    difficulty: "medium",
    prompt: "What's the weather in Tokyo, in Celsius? Use get_weather.",
    tool: { name: "get_weather", description: "Get current weather for a city in a unit.",
      input_schema: { type: "object", properties: { city: { type: "string" }, unit: { type: "string", enum: ["C", "F"] } }, required: ["city", "unit"] } },
  },
  {
    id: "typed_integer",
    difficulty: "medium",
    prompt: "Give me a 5 day forecast for Berlin. Use get_forecast.",
    tool: { name: "get_forecast", description: "Forecast for N days.",
      input_schema: { type: "object", properties: { city: { type: "string" }, days: { type: "integer", minimum: 1, maximum: 7 } }, required: ["city", "days"] } },
  },
  {
    id: "nested_object",
    difficulty: "hard",
    prompt: "What's the weather in Madrid in Fahrenheit? Use get_weather.",
    tool: { name: "get_weather", description: "Get current weather.",
      input_schema: { type: "object", properties: { location: { type: "object", properties: { city: { type: "string" }, unit: { type: "string", enum: ["C", "F"] } }, required: ["city", "unit"] } }, required: ["location"] } },
  },
];

const validator = new ToolUseValidator();
const isDestructive = destructiveMatcher(["rm", "delete", "push", "drop"]);

function openaiToolSpec(tool) {
  return [{ type: "function", function: { name: tool.name, description: tool.description, parameters: tool.input_schema } }];
}

async function nimChat(model, messages, { tool = null, timeoutMs = TIMEOUT_MS, temperature = 0.7 } = {}) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const body = { model, messages, temperature, max_tokens: 512 };
    if (tool) { body.tools = openaiToolSpec(tool); body.tool_choice = "auto"; }
    const res = await fetch(BASE + "/chat/completions", {
      method: "POST",
      headers: { "content-type": "application/json", authorization: "Bearer " + KEY },
      body: JSON.stringify(body),
      signal: ctrl.signal,
    });
    if (!res.ok) return { error: `HTTP ${res.status}: ${(await res.text()).slice(0, 100)}` };
    return { json: await res.json() };
  } catch (e) {
    return { error: e.name === "AbortError" ? "timeout" : e.message };
  } finally {
    clearTimeout(t);
  }
}

function toAssistant(msg) {
  const content = [];
  if (typeof msg.content === "string" && msg.content.trim()) content.push({ type: "text", text: msg.content });
  for (const tc of msg.tool_calls ?? []) {
    let input;
    try { input = JSON.parse(tc.function?.arguments ?? "{}"); } catch { input = tc.function?.arguments ?? ""; }
    content.push({ type: "tool_use", id: tc.id ?? "tu", name: tc.function?.name ?? "", input });
  }
  return { content, stop_reason: content.some((b) => b.type === "tool_use") ? "tool_use" : "end_turn" };
}

// Strong-model reshaper in the proxy's Reshaper shape (corrected-inputs contract).
function makeReshaper(schema) {
  return {
    async reshape(req) {
      const sys = `You fix the ARGUMENTS of malformed tool calls to satisfy the schema. Preserve intent; reconstruct only from what is present. Output ONLY one raw JSON object mapping each tool_use id to its corrected input: {"inputs":{"<id>":{...}}} or {"refuse":true,"reason":"..."}. Schema: ${JSON.stringify(schema)}.`;
      const user = JSON.stringify({ failing_tool_calls: req.rawAssistant.content.filter((b) => b.type === "tool_use").map((b) => ({ id: b.id, current_input: b.input })), validation_errors: req.errors.map((e) => e.message) });
      const r = await nimChat(RESHAPER_MODEL, [{ role: "system", content: sys }, { role: "user", content: user }], { temperature: 0.1 });
      if (r.error) return { kind: "refuse", reason: r.error };
      const parsed = parseCorrectedInputs(r.json.choices?.[0]?.message?.content ?? "");
      if (parsed.kind === "refuse") return { kind: "refuse", reason: parsed.reason };
      return { kind: "message", message: reconstruct(req.rawAssistant, parsed.inputs) };
    },
  };
}

// One trial → a record. verdict: valid | fail | no_tool_call | error.
async function trial(model, scenario) {
  const tools = toolSchemaMap({ tools: [scenario.tool] });
  const call = await nimChat(model, [{ role: "user", content: scenario.prompt }], { tool: scenario.tool });
  if (call.error) return { model, scenario: scenario.id, difficulty: scenario.difficulty, verdict: "error", detail: call.error };
  const assistant = toAssistant(call.json.choices?.[0]?.message ?? {});
  if (!assistant.content.some((b) => b.type === "tool_use")) {
    return { model, scenario: scenario.id, difficulty: scenario.difficulty, verdict: "no_tool_call" };
  }
  const v = validator.validate(assistant, tools);
  const rawInput = assistant.content.find((b) => b.type === "tool_use")?.input;
  if (v.valid) return { model, scenario: scenario.id, difficulty: scenario.difficulty, verdict: "valid", rawInput };
  const kinds = [...new Set(v.errors.map((e) => e.kind))];
  const dec = await repair(assistant, tools, { validator, reshaper: makeReshaper(scenario.tool.input_schema), maxAttempts: 2, isDestructive });
  return { model, scenario: scenario.id, difficulty: scenario.difficulty, verdict: "fail", errorKinds: kinds, rawInput, repair: dec.outcome };
}

// Availability pre-check: one cheap call per model (short timeout) so an
// unavailable/slow model fails ONCE here instead of wasting every trial. Records
// the reason (404/410/timeout/...) for the report.
const unavailable = {};
const liveModels = [];
console.log(`Probing availability of ${MODELS.length} models…`);
for (const model of MODELS) {
  const r = await nimChat(model, [{ role: "user", content: "ping" }], { timeoutMs: 60000, temperature: 0 });
  if (r.error) { unavailable[model] = r.error; console.log("  ✗", model.padEnd(42), r.error); }
  else { liveModels.push(model); console.log("  ✓", model); }
}

const records = [];
console.log(`\nTrip-rate dataset — ${liveModels.length} live models × ${SCENARIOS.length} scenarios × ${TRIALS} trials (reshaper=${RESHAPER_MODEL})`);
console.log("=".repeat(90));
for (const model of liveModels) {
  let line = model.padEnd(42);
  for (const scenario of SCENARIOS) {
    const marks = [];
    for (let i = 0; i < TRIALS; i++) {
      const rec = await trial(model, scenario);
      records.push(rec);
      marks.push(rec.verdict === "valid" ? "." : rec.verdict === "fail" ? (rec.repair === "fixed" ? "r" : "x") : rec.verdict === "no_tool_call" ? "n" : "E");
    }
    line += `${scenario.id.slice(0, 6)}:${marks.join("")} `;
  }
  console.log(line);
}
console.log("=".repeat(90));
console.log("legend: . valid  r fail→repaired  x fail→unrepaired  n no_tool_call  E api_error\n");

// ---- Aggregate ----
function agg(recs) {
  const attempted = recs.filter((r) => r.verdict === "valid" || r.verdict === "fail"); // produced a tool call
  const fails = recs.filter((r) => r.verdict === "fail");
  const repaired = fails.filter((r) => r.repair === "fixed");
  return {
    trials: recs.length,
    errors: recs.filter((r) => r.verdict === "error").length,
    no_tool_call: recs.filter((r) => r.verdict === "no_tool_call").length,
    tool_calls: attempted.length,
    valid: recs.filter((r) => r.verdict === "valid").length,
    fail: fails.length,
    trip_rate: attempted.length ? +(fails.length / attempted.length).toFixed(3) : null,
    repair_fix_rate: fails.length ? +(repaired.length / fails.length).toFixed(3) : null,
  };
}

const byModel = {};
for (const m of liveModels) byModel[m] = agg(records.filter((r) => r.model === m));
const byScenario = {};
for (const s of SCENARIOS) byScenario[s.id] = agg(records.filter((r) => r.scenario === s.id));

const stamp = process.env.RP_STAMP || "live-run";
const dataset = { generated: stamp, base: BASE, reshaper: RESHAPER_MODEL, trials: TRIALS, scenarios: SCENARIOS.map((s) => ({ id: s.id, difficulty: s.difficulty })), liveModels, unavailable, records, aggregates: { byModel, byScenario } };
const jsonlPath = "docs/nim-trip-rate.jsonl";
writeFileSync(jsonlPath, records.map((r) => JSON.stringify(r)).join("\n") + "\n");
writeFileSync("docs/nim-trip-rate.json", JSON.stringify(dataset, null, 2));

// Markdown report
const rows = liveModels.map((m) => {
  const a = byModel[m];
  return `| \`${m}\` | ${a.tool_calls}/${a.trials} | ${a.valid} | ${a.fail} | ${a.trip_rate ?? "—"} | ${a.repair_fix_rate ?? "—"} | ${a.no_tool_call} |`;
});
const scenRows = SCENARIOS.map((s) => {
  const a = byScenario[s.id];
  return `| \`${s.id}\` (${s.difficulty}) | ${a.tool_calls} | ${a.trip_rate ?? "—"} | ${a.repair_fix_rate ?? "—"} |`;
});
const unavailRows = Object.entries(unavailable).map(([m, why]) => `| \`${m}\` | ${why.replace(/\s+/g, " ").replace(/\|/g, "\\|").slice(0, 80)} |`);
const trippingScenarios = SCENARIOS.filter((s) => (byScenario[s.id].trip_rate ?? 0) > 0).map((s) => `\`${s.id}\``);
const md = `# NIM tool-call trip-rate dataset

Generated: ${stamp} · backend: \`${BASE}\` · reshaper: \`${RESHAPER_MODEL}\` · ${TRIALS} trials/scenario

**Trip rate** = share of *emitted tool calls* that fail deterministic schema validation (higher = more format-broken).
**Repair-fix rate** = share of those failures the reshaper corrected via the proxy's \`repair()\`. Raw records: \`${jsonlPath}\`.

**Signal (this run):** ${liveModels.length} of ${MODELS.length} candidate models were reachable on this account. ${trippingScenarios.length ? `Only ${trippingScenarios.join(", ")} tripped the validator` : "No scenario tripped the validator"}${trippingScenarios.length ? " — and every failure on a live model was repaired" : ""}.

## Per model (live)
| model | tool calls | valid | fail | trip rate | repair-fix rate | no-tool-call |
|---|---|---|---|---|---|---|
${rows.join("\n")}

## Per scenario (all live models pooled)
| scenario | tool calls | trip rate | repair-fix rate |
|---|---|---|---|
${scenRows.join("\n")}

## Unavailable on this account (excluded from rates)
${unavailRows.length ? `| model | reason |\n|---|---|\n${unavailRows.join("\n")}` : "_none — all candidates responded._"}

A \`timeout\` here means slow/cold-start, not confirmed-absent — re-probe with a larger \`RP_TRIALS\`/timeout; \`404/410\` means the id isn't served on this account.

## Reading it
- **trip rate ≈ 0** → model is a clean tool-caller on this schema; run \`detect\`, no repair needed.
- **trip rate high, repair-fix rate high** → format-broken but salvageable; \`repair\` mode makes it usable.
- **trip rate high, repair-fix rate low** → the failures are semantic (bad intent), not form — outside this proxy's remit.
- **many no-tool-call / api errors** → the model isn't a viable tool backend on this account.
`;
writeFileSync("docs/nim-trip-rate.md", md);

console.log("Per-model aggregates:");
for (const m of liveModels) {
  const a = byModel[m];
  console.log(" ", m.padEnd(42), `trip=${a.trip_rate ?? "—"} repairFix=${a.repair_fix_rate ?? "—"} (calls ${a.tool_calls}/${a.trials}, noTool ${a.no_tool_call}, err ${a.errors})`);
}
console.log(`\nWrote docs/nim-trip-rate.md, docs/nim-trip-rate.json, ${jsonlPath}`);
