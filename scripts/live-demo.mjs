// Live end-to-end demo of the COMPILED proxy (dist/cli.js) as a real process.
// Simulates a weak model (flaky backend that emits a broken tool call) and a
// cheap reshaper (stub Anthropic endpoint that fixes it). No external creds.
//
// Run: node scripts/live-demo.mjs   (after `npm run build`)
import { createServer } from "node:http";
import { spawn } from "node:child_process";
import { writeFileSync, mkdtempSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { once } from "node:events";

const listen = (s) => new Promise((r) => s.listen(0, "127.0.0.1", () => r(s.address().port)));
const freePort = () => new Promise((r) => { const s = createServer(); s.listen(0, "127.0.0.1", () => { const p = s.address().port; s.close(() => r(p)); }); });
const readBody = (req) => new Promise((r) => { const c = []; req.on("data", (x) => c.push(x)); req.on("end", () => r(Buffer.concat(c).toString())); });

// A weak model: always returns a tool_use for get_weather with EMPTY args.
const backend = createServer(async (req, res) => {
  await readBody(req);
  res.writeHead(200, { "content-type": "application/json" });
  res.end(JSON.stringify({
    id: "msg_backend", type: "message", role: "assistant", model: "weak-model",
    stop_reason: "tool_use",
    content: [{ type: "tool_use", id: "tu_1", name: "get_weather", input: {} }], // <-- missing required "city"
  }));
});

// A cheap reshaper: returns corrected inputs per tool_use id (the reshaper contract).
const reshaper = createServer(async (req, res) => {
  await readBody(req);
  res.writeHead(200, { "content-type": "application/json" });
  res.end(JSON.stringify({
    id: "msg_reshaper", type: "message", role: "assistant", model: "reshaper",
    stop_reason: "end_turn",
    content: [{ type: "text", text: JSON.stringify({ inputs: { tu_1: { city: "Paris" } } }) }],
  }));
});

async function readLog(logPath) {
  const { readFileSync, existsSync } = await import("node:fs");
  for (let i = 0; i < 40; i++) {
    if (existsSync(logPath)) { const t = readFileSync(logPath, "utf8").trim(); if (t) return t; }
    await new Promise((r) => setTimeout(r, 25));
  }
  return "(no log written)";
}

const request = (port, mode) => fetch(`http://127.0.0.1:${port}/v1/messages`, {
  method: "POST", headers: { "content-type": "application/json" },
  body: JSON.stringify({
    model: "weak-model", stream: false, messages: [{ role: "user", content: "weather in Paris?" }],
    tools: [{ name: "get_weather", input_schema: { type: "object", properties: { city: { type: "string" } }, required: ["city"] } }],
  }),
}).then((r) => r.json());

async function startProxy(cfg) {
  const dir = mkdtempSync(join(tmpdir(), "rp-demo-"));
  const cfgPath = join(dir, "config.json");
  const logPath = join(dir, "log.jsonl");
  writeFileSync(cfgPath, JSON.stringify({ ...cfg, log: { level: "metadata", file: logPath } }));
  const proc = spawn(process.execPath, ["dist/cli.js", "--config", cfgPath], { stdio: ["ignore", "ignore", "pipe"] });
  // wait for the "listening on http://host:port" banner
  let port;
  for await (const chunk of proc.stderr) {
    const m = /listening on http:\/\/127\.0\.0\.1:(\d+)/.exec(chunk.toString());
    if (m) { port = Number(m[1]); break; }
  }
  return { proc, port, logPath };
}

const backendPort = await listen(backend);
const reshaperPort = await listen(reshaper);

console.log("\n=== 1) DETECT mode — measure the trip-rate (no change to output) ===");
{
  const { proc, port, logPath } = await startProxy({
    listen: `127.0.0.1:${await freePort()}`, backend: { base: `http://127.0.0.1:${backendPort}` }, mode: "detect",
  });
  const got = await request(port, "detect");
  console.log("client received tool input :", JSON.stringify(got.content[0].input), "  <-- still broken (detect never alters)");
  console.log("proxy log line             :", await readLog(logPath));
  proc.kill();
  await once(proc, "exit");
}

console.log("\n=== 2) REPAIR mode — reshape the broken call before the client sees it ===");
{
  const { proc, port, logPath } = await startProxy({
    listen: `127.0.0.1:${await freePort()}`,
    backend: { base: `http://127.0.0.1:${backendPort}` },
    reshaper: { base: `http://127.0.0.1:${reshaperPort}`, model: "stub-haiku" },
    mode: "repair",
  });
  const got = await request(port, "repair");
  console.log("client received tool input :", JSON.stringify(got.content[0].input), "  <-- REPAIRED");
  console.log("proxy log line             :", await readLog(logPath));
  proc.kill();
  await once(proc, "exit");
}

backend.close();
reshaper.close();
console.log("\ndone.\n");
