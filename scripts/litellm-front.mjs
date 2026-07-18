// Live: run the COMPILED proxy (dist/cli.js) against an Anthropic-format backend —
// typically a LiteLLM proxy (`litellm --config litellm-config.yaml`), which serves
// /v1/messages for any provider model. Sends a real Anthropic request and checks
// tool_use fidelity through the chain: client -> repair-proxy -> LiteLLM -> provider.
//
// Env: LITELLM_BASE_URL (e.g. http://127.0.0.1:4000), optional LITELLM_MODEL
// (fixed model rewrite; omit to pass the client's model through to LiteLLM
// aliases), optional LITELLM_API_KEY.
// Run: npm run build && node scripts/litellm-front.mjs
import { createServer } from "node:http";
import { spawn } from "node:child_process";
import { writeFileSync, mkdtempSync, existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { once } from "node:events";

const BASE = process.env.LITELLM_BASE_URL ?? "http://127.0.0.1:4000";
const MODEL = process.env.LITELLM_MODEL;
const freePort = () => new Promise((r) => { const s = createServer(); s.listen(0, "127.0.0.1", () => { const p = s.address().port; s.close(() => r(p)); }); });

async function readLog(p) {
  for (let i = 0; i < 80; i++) { if (existsSync(p)) { const t = readFileSync(p, "utf8").trim(); if (t) return t; } await new Promise((r) => setTimeout(r, 25)); }
  return "(no log)";
}

const dir = mkdtempSync(join(tmpdir(), "rp-litellm-"));
const cfgPath = join(dir, "config.json");
const logPath = join(dir, "log.jsonl");
const port = await freePort();
writeFileSync(cfgPath, JSON.stringify({
  listen: `127.0.0.1:${port}`,
  backend: {
    base: BASE,
    ...(MODEL ? { model: MODEL } : {}),
    ...(process.env.LITELLM_API_KEY ? { authEnv: "LITELLM_API_KEY", authHeader: "authorization" } : {}),
  },
  mode: "detect",
  log: { level: "metadata", file: logPath },
}));

const proc = spawn(process.execPath, ["dist/cli.js", "--config", cfgPath], { stdio: ["ignore", "ignore", "pipe"] });
for await (const c of proc.stderr) { if (/listening on/.test(c.toString())) break; }

const anthropicRequest = (stream) => ({
  model: "claude-sonnet-5", max_tokens: 512, stream,
  messages: [{ role: "user", content: "What's the weather in Paris? Use the get_weather tool." }],
  tools: [{ name: "get_weather", description: "Get weather for a city.", input_schema: { type: "object", properties: { city: { type: "string" }, unit: { type: "string", enum: ["celsius", "fahrenheit"] } }, required: ["city"] } }],
});
const hit = (stream) => fetch(`http://127.0.0.1:${port}/v1/messages`, {
  method: "POST", headers: { "content-type": "application/json", "anthropic-version": "2023-06-01" },
  body: JSON.stringify(anthropicRequest(stream)),
});

console.log(`\nrepair-proxy fronting ${BASE}${MODEL ? ` (model=${MODEL})` : " (model passthrough)"}, mode=detect\n${"=".repeat(70)}`);

// 1) non-streaming
{
  const res = await hit(false);
  const j = await res.json();
  const tu = (j.content || []).find((b) => b.type === "tool_use");
  console.log("NON-STREAM  status:", res.status, "| stop_reason:", j.stop_reason);
  console.log("            tool_use:", tu ? JSON.stringify({ name: tu.name, input: tu.input }) : "(none)  content=" + JSON.stringify(j.content));
  console.log("            log:", await readLog(logPath));
}

// 2) streaming — exercises LiteLLM's Anthropic SSE emission through the proxy
{
  const res = await hit(true);
  const text = await res.text();
  const events = [...text.matchAll(/event: (\w+)/g)].map((m) => m[1]);
  const hasToolDelta = /input_json_delta/.test(text);
  console.log("STREAM      status:", res.status, "| events:", [...new Set(events)].join(","), "| tool args streamed:", hasToolDelta);
  console.log("            log:", await readLog(logPath));
}

proc.kill();
await once(proc, "exit");
console.log("\ndone.\n");
