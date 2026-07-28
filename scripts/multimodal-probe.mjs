// Probe the UNVERIFIED passthrough paths: non-text content blocks (image, PDF
// document) and Anthropic MCP fields, through the proxy's Anthropic->OpenAI
// translation (llm-bridge). Open item #1 in CLAUDE.md.
//
// Needs a RUNNING proxy whose default target is a vision-capable model, e.g.
//   nim/nvidia/nemotron-nano-12b-v2-vl
//   node dist/cli.js --config <cfg> &   # then:
//   PROXY=http://127.0.0.1:8792 node scripts/multimodal-probe.mjs
//
// Each case reports PASS / FAIL / DEGRADED so an unsupported path is visible as a
// concrete failure mode (silently dropped block vs. 400 vs. wrong answer) rather
// than an unknown.
import { deflateSync } from "node:zlib";

const PROXY = process.env.PROXY || "http://127.0.0.1:8792";

// ---- fixtures -------------------------------------------------------------
const crcTable = (() => {
  const t = new Int32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c;
  }
  return t;
})();
const crc32 = (buf) => {
  let c = -1;
  for (const b of buf) c = crcTable[(c ^ b) & 0xff] ^ (c >>> 8);
  return (c ^ -1) >>> 0;
};
const chunk = (type, data) => {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, "ascii"), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body));
  return Buffer.concat([len, body, crc]);
};

/** Solid-colour PNG. The colour IS the assertion: a model that never saw the image cannot name it. */
function solidPng(size, [r, g, b]) {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 2; // truecolour
  const raw = Buffer.concat(
    Array.from({ length: size }, () =>
      Buffer.concat([Buffer.from([0]), Buffer.concat(Array.from({ length: size }, () => Buffer.from([r, g, b])))]),
    ),
  );
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk("IHDR", ihdr),
    chunk("IDAT", deflateSync(raw)),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}

/** Minimal one-page PDF with an uncompressed text stream. */
function textPdf(text) {
  const content = `BT /F1 24 Tf 72 700 Td (${text}) Tj ET`;
  const objs = [
    "<< /Type /Catalog /Pages 2 0 R >>",
    "<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
    "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents 4 0 R /Resources << /Font << /F1 5 0 R >> >> >>",
    `<< /Length ${content.length} >>\nstream\n${content}\nendstream`,
    "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>",
  ];
  let pdf = "%PDF-1.4\n";
  const offsets = [];
  objs.forEach((o, i) => {
    offsets.push(pdf.length);
    pdf += `${i + 1} 0 obj\n${o}\nendobj\n`;
  });
  const xref = pdf.length;
  pdf += `xref\n0 ${objs.length + 1}\n0000000000 65535 f \n`;
  for (const off of offsets) pdf += `${String(off).padStart(10, "0")} 00000 n \n`;
  pdf += `trailer\n<< /Size ${objs.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF`;
  return Buffer.from(pdf, "latin1");
}

// ---- transport ------------------------------------------------------------
async function post(body) {
  const t0 = Date.now();
  const res = await fetch(`${PROXY}/v1/messages`, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: "Bearer dummy", "anthropic-version": "2023-06-01" },
    body: JSON.stringify(body),
  });
  const text = await res.text();
  let json;
  try {
    json = JSON.parse(text);
  } catch {
    json = null;
  }
  return { status: res.status, json, text, ms: Date.now() - t0 };
}

const textOf = (j) =>
  ((j && j.content) || [])
    .filter((b) => b.type === "text")
    .map((b) => b.text)
    .join("");

const results = [];
function record(name, verdict, detail) {
  results.push({ name, verdict, detail });
  const mark = verdict === "PASS" ? "OK  " : verdict === "DEGRADED" ? "WARN" : "FAIL";
  console.log(`[${mark}] ${name} — ${detail}`);
}

console.log(`Multimodal / MCP passthrough probe -> ${PROXY}\n${"=".repeat(70)}`);

// ---- 1. base64 image ------------------------------------------------------
{
  const png = solidPng(48, [255, 0, 0]).toString("base64");
  const r = await post({
    model: "claude-3-5-sonnet",
    max_tokens: 64,
    messages: [
      {
        role: "user",
        content: [
          { type: "image", source: { type: "base64", media_type: "image/png", data: png } },
          { type: "text", text: "What single colour fills this image? Answer with one word." },
        ],
      },
    ],
  });
  const out = textOf(r.json).toLowerCase();
  if (r.status !== 200) record("image/base64", "FAIL", `HTTP ${r.status}: ${r.text.slice(0, 200)}`);
  else if (/red|crimson|scarlet/.test(out)) record("image/base64", "PASS", `model saw the image ("${out.trim().slice(0, 60)}")`);
  else record("image/base64", "DEGRADED", `HTTP 200 but answer does not name the colour: "${out.trim().slice(0, 80)}"`);
}

// ---- 2. url image ---------------------------------------------------------
{
  const r = await post({
    model: "claude-3-5-sonnet",
    max_tokens: 64,
    messages: [
      {
        role: "user",
        content: [
          { type: "image", source: { type: "url", url: "https://upload.wikimedia.org/wikipedia/commons/thumb/4/47/PNG_transparency_demonstration_1.png/120px-PNG_transparency_demonstration_1.png" } },
          { type: "text", text: "Describe this image in five words." },
        ],
      },
    ],
  });
  const out = textOf(r.json);
  if (r.status !== 200) record("image/url", "FAIL", `HTTP ${r.status}: ${r.text.slice(0, 200)}`);
  else if (out.trim()) record("image/url", "PASS", `HTTP 200, described: "${out.trim().slice(0, 70)}"`);
  else record("image/url", "DEGRADED", "HTTP 200 with empty text");
}

// ---- 3. pdf document ------------------------------------------------------
{
  const pdf = textPdf("MAGICPDF7788").toString("base64");
  const r = await post({
    model: "claude-3-5-sonnet",
    max_tokens: 64,
    messages: [
      {
        role: "user",
        content: [
          { type: "document", source: { type: "base64", media_type: "application/pdf", data: pdf } },
          { type: "text", text: "What token appears in this document? Reply with the token only." },
        ],
      },
    ],
  });
  const out = textOf(r.json);
  if (r.status !== 200) record("document/pdf", "FAIL", `HTTP ${r.status}: ${r.text.slice(0, 200)}`);
  else if (out.includes("MAGICPDF7788")) record("document/pdf", "PASS", "model read the PDF token");
  else record("document/pdf", "DEGRADED", `HTTP 200 but token absent: "${out.trim().slice(0, 80)}"`);
}

// ---- 4. mcp_servers passthrough ------------------------------------------
{
  const r = await post({
    model: "claude-3-5-sonnet",
    max_tokens: 64,
    mcp_servers: [{ type: "url", url: "https://example.invalid/mcp", name: "probe-mcp" }],
    messages: [{ role: "user", content: "Reply with the single word OK." }],
  });
  const out = textOf(r.json);
  if (r.status === 200 && out.trim()) record("mcp_servers field", "PASS", `ignored cleanly, HTTP 200 ("${out.trim().slice(0, 40)}")`);
  else record("mcp_servers field", "FAIL", `HTTP ${r.status}: ${r.text.slice(0, 200)}`);
}

// ---- 5. mcp_tool_use / mcp_tool_result history ----------------------------
{
  const r = await post({
    model: "claude-3-5-sonnet",
    max_tokens: 64,
    messages: [
      { role: "user", content: "Look up the value." },
      {
        role: "assistant",
        content: [{ type: "mcp_tool_use", id: "mcp_1", name: "lookup", server_name: "probe-mcp", input: { key: "answer" } }],
      },
      {
        role: "user",
        content: [{ type: "mcp_tool_result", tool_use_id: "mcp_1", is_error: false, content: [{ type: "text", text: "SEVENTEEN" }] }],
      },
      { role: "user", content: "What was the value? One word." },
    ],
  });
  const out = textOf(r.json);
  if (r.status !== 200) record("mcp_tool_use history", "FAIL", `HTTP ${r.status}: ${r.text.slice(0, 200)}`);
  else if (/seventeen/i.test(out)) record("mcp_tool_use history", "PASS", "MCP result content survived translation");
  else record("mcp_tool_use history", "DEGRADED", `HTTP 200 but value lost: "${out.trim().slice(0, 80)}"`);
}

console.log("=".repeat(70));
const fails = results.filter((r) => r.verdict === "FAIL").length;
const degraded = results.filter((r) => r.verdict === "DEGRADED").length;
console.log(`${results.length - fails - degraded} pass, ${degraded} degraded, ${fails} fail`);
process.exit(fails ? 1 : 0);
