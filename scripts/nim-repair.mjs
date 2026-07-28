// Live: full pipeline on NIM ALONE (no Anthropic key). A stub OpenAI backend
// emits a malformed (flattened) tool call; the compiled proxy translates it,
// the validator flags it, and a REAL NIM reshaper (OpenAI-format) fixes it —
// all inside dist/cli.js. Proves backend.kind=openai + reshaper.kind=openai.
//
// Run: npm run build && node scripts/nim-repair.mjs
import { createServer } from "node:http";
import { spawn } from "node:child_process";
import { writeFileSync, mkdtempSync, existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { once } from "node:events";

const NIM_BASE = process.env.LLM_BACKEND_BASE_URL || "https://integrate.api.nvidia.com/v1";
const RESHAPER_MODEL = "meta/llama-3.1-70b-instruct";
const freePort = () => new Promise((r) => { const s = createServer(); s.listen(0, "127.0.0.1", () => { const p = s.address().port; s.close(() => r(p)); }); });
async function readLog(p) { for (let i = 0; i < 80; i++) { if (existsSync(p)) { const t = readFileSync(p, "utf8").trim(); if (t) return t.split("\n").pop(); } await new Promise((r) => setTimeout(r, 25)); } return "(no log)"; }

// Stub OpenAI backend: returns a tool_call with FLAT args {city,unit} — a common
// weak-model failure against a schema that requires them nested under `location`.
const stub = createServer((req, res) => {
  const chunks = []; req.on("data", (c) => chunks.push(c));
  req.on("end", () => {
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({
      id: "cmpl", choices: [{ finish_reason: "tool_calls", message: {
        tool_calls: [{ id: "c1", function: { name: "get_weather", arguments: '{"city":"Paris","unit":"C"}' } }],
      } }],
    }));
  });
});
const stubPort = await new Promise((r) => stub.listen(0, "127.0.0.1", () => r(stub.address().port)));

const dir = mkdtempSync(join(tmpdir(), "rp-nimrep-"));
const cfgPath = join(dir, "config.json");
const logPath = join(dir, "log.jsonl");
const port = await freePort();
writeFileSync(cfgPath, JSON.stringify({
  listen: `127.0.0.1:${port}`,
  providers: {
    stub: { base: `http://127.0.0.1:${stubPort}`, kind: "openai" },
  },
  routing: { default: "stub/stub-weak-model" },
  reshaper: { base: NIM_BASE, kind: "openai", model: RESHAPER_MODEL, authEnv: "NVIDIA_API_KEY", authHeader: "authorization" },
  mode: "repair",
  log: { level: "metadata", file: logPath },
}));

const proc = spawn(process.execPath, ["dist/cli.js", "--config", cfgPath], { stdio: ["ignore", "pipe", "pipe"] });
for await (const c of proc.stderr) { if (/listening on/.test(c.toString())) break; }

const res = await fetch(`http://127.0.0.1:${port}/v1/messages`, {
  method: "POST", headers: { "content-type": "application/json" },
  body: JSON.stringify({
    model: "claude-x", max_tokens: 256, stream: false,
    messages: [{ role: "user", content: "weather in Paris?" }],
    tools: [{ name: "get_weather", input_schema: { type: "object", properties: { location: { type: "object", properties: { city: { type: "string" }, unit: { type: "string", enum: ["C", "F"] } }, required: ["city", "unit"] } }, required: ["location"] } }],
  }),
});
const j = await res.json();
const tu = (j.content || []).find((b) => b.type === "tool_use");

console.log(`\nFull pipeline on NIM alone (backend=stub, reshaper=real ${RESHAPER_MODEL}), mode=repair\n${"=".repeat(72)}`);
console.log("stub backend emitted (flat)  : {\"city\":\"Paris\",\"unit\":\"C\"}   (invalid: missing required 'location')");
console.log("client received (repaired)   :", tu ? JSON.stringify(tu.input) : "(none) " + JSON.stringify(j));
console.log("proxy log                    :", await readLog(logPath));

proc.kill(); await once(proc, "exit"); stub.close();
console.log("\ndone.\n");
