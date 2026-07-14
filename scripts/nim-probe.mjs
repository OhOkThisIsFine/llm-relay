// Live probe: hit real NVIDIA NIM models (OpenAI format), run their tool calls
// through the proxy's REAL validator + repair orchestrator. Measures, per model,
// how often the tool call is schema-valid, and whether a strong model reshapes
// the failures. NIM is OpenAI-compatible, so this exercises the validator/repair
// logic directly (not the Anthropic HTTP proxy path).
//
// Run: npm run build && node scripts/nim-probe.mjs
import { ToolUseValidator } from "../dist/validator.js";
import { repair, destructiveMatcher } from "../dist/repair.js";
import { parseReshapeOutput } from "../dist/reshaper.js";
import { toolSchemaMap } from "../dist/anthropic.js";

const KEY = process.env.NVIDIA_API_KEY || process.env.LLM_BACKEND_API_KEY;
const BASE = process.env.LLM_BACKEND_BASE_URL; // https://integrate.api.nvidia.com/v1

// A tool with TWO required fields incl. an enum — weak models often omit `unit`
// or send an invalid enum, producing real schema violations.
const WEATHER_TOOL = {
  name: "get_weather",
  description: "Get the current weather for a city.",
  input_schema: {
    type: "object",
    properties: {
      location: {
        type: "object",
        properties: {
          city: { type: "string", description: "City name" },
          unit: { type: "string", enum: ["C", "F"], description: "Temperature unit code: C or F" },
        },
        required: ["city", "unit"],
      },
    },
    required: ["location"],
  },
};
const TOOLS = toolSchemaMap({ tools: [WEATHER_TOOL] });

const CANDIDATES = [
  "meta/llama-3.1-8b-instruct",
  "meta/llama-3.1-70b-instruct",
];
const RESHAPER_MODEL = "meta/llama-3.1-70b-instruct";
const TIMEOUT_MS = 70000;

function openaiToolSpec() {
  return [{ type: "function", function: { name: WEATHER_TOOL.name, description: WEATHER_TOOL.description, parameters: WEATHER_TOOL.input_schema } }];
}

async function nimChat(model, messages, { tools = false, timeoutMs = TIMEOUT_MS } = {}) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const body = { model, messages, temperature: 0.2, max_tokens: 512 };
    if (tools) { body.tools = openaiToolSpec(); body.tool_choice = "auto"; }
    const res = await fetch(BASE + "/chat/completions", {
      method: "POST",
      headers: { "content-type": "application/json", authorization: "Bearer " + KEY },
      body: JSON.stringify(body),
      signal: ctrl.signal,
    });
    if (!res.ok) return { error: `HTTP ${res.status}: ${(await res.text()).slice(0, 120)}` };
    return { json: await res.json() };
  } catch (e) {
    return { error: e.name === "AbortError" ? "timeout" : e.message };
  } finally {
    clearTimeout(t);
  }
}

// Convert an OpenAI chat message into an Anthropic AssistantMessage.
function toAssistant(msg) {
  const content = [];
  if (typeof msg.content === "string" && msg.content.trim()) content.push({ type: "text", text: msg.content });
  for (const tc of msg.tool_calls ?? []) {
    let input;
    try { input = JSON.parse(tc.function?.arguments ?? "{}"); } catch { input = tc.function?.arguments ?? ""; }
    content.push({ type: "tool_use", id: tc.id ?? "tu", name: tc.function?.name ?? "", input });
  }
  const hasTool = content.some((b) => b.type === "tool_use");
  return { content, stop_reason: hasTool ? "tool_use" : "end_turn" };
}

// A Reshaper (the proxy's interface) backed by a strong NIM model in OpenAI format.
const nimReshaper = {
  async reshape(req) {
    const sys = `You repair malformed tool calls into valid Anthropic tool-use JSON. Preserve the model's expressed intent; reconstruct arguments ONLY from what is present. Output ONLY one JSON object: {"content":[{"type":"tool_use","id":"<id>","name":"<tool>","input":{...}}],"stop_reason":"tool_use"} or {"refuse":true,"reason":"..."}. The input must satisfy this schema: ${JSON.stringify(WEATHER_TOOL.input_schema)}.`;
    const user = JSON.stringify({ tools: [WEATHER_TOOL], validation_errors: req.errors.map((e) => e.message), raw_assistant_message: req.rawAssistant });
    const r = await nimChat(RESHAPER_MODEL, [{ role: "system", content: sys }, { role: "user", content: user }]);
    if (r.error) return { kind: "refuse", reason: r.error };
    const text = r.json.choices?.[0]?.message?.content ?? "";
    return parseReshapeOutput(text);
  },
};

const validator = new ToolUseValidator();
const isDestructive = destructiveMatcher(["rm", "delete", "push", "drop"]);
const PROMPT = [{ role: "user", content: "What's the current weather in Paris? Use the get_weather tool. Report it in Celsius." }];

console.log(`\nNIM tool-call fidelity probe — tool requires {city, unit(enum)}\n${"=".repeat(78)}`);
const rows = [];
for (const model of CANDIDATES) {
  const call = await nimChat(model, PROMPT, { tools: true });
  if (call.error) { rows.push({ model, verdict: "ERROR", detail: call.error }); console.log(pad(model), "ERROR", call.error); continue; }
  const msg = call.json.choices?.[0]?.message ?? {};
  const assistant = toAssistant(msg);
  const hasTool = assistant.content.some((b) => b.type === "tool_use");
  if (!hasTool) { rows.push({ model, verdict: "no_tool_call" }); console.log(pad(model), "no_tool_call (returned prose instead)"); continue; }

  const v = validator.validate(assistant, TOOLS);
  if (v.valid) { rows.push({ model, verdict: "VALID" }); console.log(pad(model), "VALID  ", JSON.stringify(firstInput(assistant))); continue; }

  // Failure — attempt repair with the strong model.
  const kinds = [...new Set(v.errors.map((e) => e.kind))].join(",");
  const dec = await repair(assistant, TOOLS, { validator, reshaper: nimReshaper, maxAttempts: 2, isDestructive });
  rows.push({ model, verdict: "FAIL", kinds, repair: dec.outcome });
  console.log(pad(model), "FAIL   ", `[${kinds}] raw=${JSON.stringify(firstInput(assistant))} -> repair=${dec.outcome}${dec.message ? " " + JSON.stringify(firstInput(dec.message)) : ""}`);
}

console.log(`${"=".repeat(78)}\nSummary:`);
for (const r of rows) console.log(" ", pad(r.model), r.verdict, r.kinds ? `(${r.kinds} -> ${r.repair})` : "");

// Reshaper capability check on a REAL NIM model: inject the common "flattened
// args" failure (what weaker models emit against a nested schema) and let the
// real Llama-70B reshaper fix it through the proxy's repair() orchestrator.
console.log(`\n${"=".repeat(78)}\nReshaper capability (real NIM ${RESHAPER_MODEL}) on an injected realistic failure:`);
const flattened = { content: [{ type: "tool_use", id: "tu_x", name: "get_weather", input: { city: "Paris", unit: "C" } }], stop_reason: "tool_use" };
const before = validator.validate(flattened, TOOLS);
console.log(" broken input      :", JSON.stringify(flattened.content[0].input), `(valid=${before.valid}, ${before.errors.map((e) => e.kind).join(",")})`);
const dec = await repair(flattened, TOOLS, { validator, reshaper: nimReshaper, maxAttempts: 2, isDestructive });
console.log(" repair outcome    :", dec.outcome, dec.message ? "-> " + JSON.stringify(dec.message.content.find((b) => b.type === "tool_use").input) : "");
console.log();

function firstInput(m) { return m.content.find((b) => b.type === "tool_use")?.input; }
function pad(s) { return s.padEnd(38); }
