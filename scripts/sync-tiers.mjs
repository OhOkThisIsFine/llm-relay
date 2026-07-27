#!/usr/bin/env node
// Sync model capability rankings from someone-else-maintained leaderboards into a
// local snapshot (docs/tier-data.json) — never a hand-maintained table.
//
//   BFCL  (Berkeley Function-Calling Leaderboard) — TOOL-USE accuracy. This is the
//         primary signal: repair-proxy validates tool calls, so function-calling
//         skill (and Irrelevance Detection = "declines when no tool fits", the
//         malformed/hallucinated-call proxy) is what should tier a backend model.
//   Arena (LMArena / Chatbot Arena, HF parquet) — general capability, secondary.
//
// Both sources are BRITTLE (undocumented site asset / no stable model ids), so this
// snapshots + diffs: a missing expected column fails loudly rather than silently
// corrupting tiers. Output ranks by RELATIVE position, never absolute score.
//
// Usage: node scripts/sync-tiers.mjs
import { writeFileSync, readFileSync, existsSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const OUT = join(ROOT, "docs", "tier-data.json");

const BFCL_CSV = "https://gorilla.cs.berkeley.edu/data_overall.csv";
const ARENA_PARQUET =
  "https://huggingface.co/datasets/lmarena-ai/leaderboard-dataset/resolve/main/text_style_control/latest-00000-of-00001.parquet";

// Columns we depend on — a rename here should FAIL the sync, not silently drop data.
const BFCL_REQUIRED = ["Model", "Overall Acc"];
const BFCL_WANTED = ["Model", "Overall Acc", "Multi Turn Acc", "Irrelevance Detection"];

/** Strip BFCL mode suffixes ("(FC)", "(Prompt)", "(FC thinking)") + lowercase for joining. */
function normName(raw) {
  return String(raw)
    .replace(/\((?:FC|Prompt)[^)]*\)/gi, "")
    .replace(/\s+/g, " ")
    .trim()
    .toLowerCase();
}

function pctToNum(v) {
  if (v == null) return null;
  const s = String(v).replace("%", "").trim();
  if (s === "" || s.toUpperCase() === "N/A") return null;
  const n = Number(s);
  return Number.isFinite(n) ? n : null;
}

// --- minimal RFC-4180-ish CSV parser (handles quoted fields + embedded commas) ---
function parseCsv(text) {
  const rows = [];
  let row = [], field = "", inQuotes = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (inQuotes) {
      if (c === '"') {
        if (text[i + 1] === '"') { field += '"'; i++; }
        else inQuotes = false;
      } else field += c;
    } else if (c === '"') inQuotes = true;
    else if (c === ",") { row.push(field); field = ""; }
    else if (c === "\n") { row.push(field); rows.push(row); row = []; field = ""; }
    else if (c === "\r") { /* skip */ }
    else field += c;
  }
  if (field.length || row.length) { row.push(field); rows.push(row); }
  return rows.filter((r) => r.length > 1 || (r.length === 1 && r[0] !== ""));
}

async function fetchBfcl() {
  const res = await fetch(BFCL_CSV);
  if (!res.ok) throw new Error(`BFCL fetch HTTP ${res.status}`);
  const rows = parseCsv(await res.text());
  if (rows.length < 2) throw new Error("BFCL CSV had no data rows");
  const header = rows[0].map((h) => h.trim());
  const missing = BFCL_REQUIRED.filter((c) => !header.includes(c));
  if (missing.length) {
    throw new Error(`BFCL CSV schema drift — missing columns: ${missing.join(", ")}. Header was: ${header.join(" | ")}`);
  }
  const idx = Object.fromEntries(BFCL_WANTED.map((c) => [c, header.indexOf(c)]));
  const out = [];
  for (const r of rows.slice(1)) {
    const name = r[idx["Model"]];
    if (!name) continue;
    out.push({
      name: name.trim(),
      norm: normName(name),
      bfcl_overall: pctToNum(r[idx["Overall Acc"]]),
      bfcl_multi_turn: idx["Multi Turn Acc"] >= 0 ? pctToNum(r[idx["Multi Turn Acc"]]) : null,
      bfcl_irrelevance: idx["Irrelevance Detection"] >= 0 ? pctToNum(r[idx["Irrelevance Detection"]]) : null,
    });
  }
  // BFCL lists a model once per mode; keep the best Overall Acc per normalized name.
  const best = new Map();
  for (const m of out) {
    const prev = best.get(m.norm);
    if (!prev || (m.bfcl_overall ?? -1) > (prev.bfcl_overall ?? -1)) best.set(m.norm, m);
  }
  return [...best.values()];
}

async function fetchArena() {
  // Best-effort: LMArena enriches but BFCL is the load-bearing signal. Never fatal.
  const { asyncBufferFromUrl, parquetQuery } = await import("hyparquet");
  const file = await asyncBufferFromUrl({ url: ARENA_PARQUET });
  const rows = await parquetQuery({ file });
  const out = [];
  for (const r of rows) {
    if (r.category !== "overall") continue;
    if (!r.model_name) continue;
    out.push({ norm: normName(r.model_name), arena_rating: Number(r.rating) || null, arena_rank: Number(r.rank) || null });
  }
  return out;
}

/** Rank-normalize a field to [0,1] (1 = best); null-safe. */
function rankNormalize(models, field) {
  const scored = models.filter((m) => m[field] != null).sort((a, b) => b[field] - a[field]);
  const map = new Map();
  scored.forEach((m, i) => map.set(m, scored.length === 1 ? 1 : 1 - i / (scored.length - 1)));
  return map;
}

async function main() {
  const warnings = [];
  const bfcl = await fetchBfcl();
  let arena = [];
  try {
    arena = await fetchArena();
  } catch (e) {
    warnings.push(`LMArena sync skipped: ${e.message}`);
  }

  // Join arena onto bfcl by normalized name; keep arena-only entries too.
  const byNorm = new Map(bfcl.map((m) => [m.norm, { ...m }]));
  for (const a of arena) {
    const m = byNorm.get(a.norm) ?? { name: a.norm, norm: a.norm, bfcl_overall: null, bfcl_multi_turn: null, bfcl_irrelevance: null };
    m.arena_rating = a.arena_rating;
    m.arena_rank = a.arena_rank;
    byNorm.set(a.norm, m);
  }
  const models = [...byNorm.values()];

  // Composite = mean of available rank-normalized (BFCL overall, BFCL irrelevance, Arena rating).
  // Tool-use weighted 2x (this is a tool-call proxy).
  const rOverall = rankNormalize(models, "bfcl_overall");
  const rIrrel = rankNormalize(models, "bfcl_irrelevance");
  const rArena = rankNormalize(models, "arena_rating");
  for (const m of models) {
    const parts = [];
    if (rOverall.has(m)) { parts.push(rOverall.get(m) * 2); }
    if (rIrrel.has(m)) { parts.push(rIrrel.get(m)); }
    if (rArena.has(m)) { parts.push(rArena.get(m)); }
    m.composite = parts.length ? parts.reduce((a, b) => a + b, 0) / (rOverall.has(m) ? (rIrrel.has(m) ? (rArena.has(m) ? 4 : 3) : (rArena.has(m) ? 3 : 2)) : parts.length) : null;
  }
  models.sort((a, b) => (b.composite ?? -1) - (a.composite ?? -1));
  models.forEach((m, i) => { m.composite_rank = m.composite != null ? i + 1 : null; });

  if (!existsSync(dirname(OUT))) mkdirSync(dirname(OUT), { recursive: true });
  const prev = existsSync(OUT) ? JSON.parse(readFileSync(OUT, "utf8")) : null;
  const snapshot = {
    synced_at: new Date().toISOString(),
    sources: {
      bfcl: { url: BFCL_CSV, note: "tool-use / function-calling accuracy (primary signal)", model_count: bfcl.length },
      lmarena: { url: ARENA_PARQUET, note: "general capability (secondary)", model_count: arena.length },
    },
    warnings,
    composite_note: "Rank-normalized mean; BFCL overall weighted 2x (tool-call proxy). Relative only.",
    models,
  };
  writeFileSync(OUT, JSON.stringify(snapshot, null, 2) + "\n");

  // --- console report ---
  const fmt = (m, i) =>
    `${String(i + 1).padStart(2)}. ${m.name.padEnd(42).slice(0, 42)}  ` +
    `bfcl=${m.bfcl_overall != null ? String(m.bfcl_overall).padStart(5) : "   — "}  ` +
    `irrel=${m.bfcl_irrelevance != null ? String(m.bfcl_irrelevance).padStart(5) : "   — "}  ` +
    `arena=${m.arena_rating != null ? String(Math.round(m.arena_rating)).padStart(4) : "  — "}`;
  console.log(`\nSynced ${models.length} models → ${OUT}`);
  if (warnings.length) console.log(warnings.map((w) => `  ⚠ ${w}`).join("\n"));
  if (prev) console.log(`  (previous snapshot: ${prev.synced_at}, ${prev.models?.length ?? "?"} models)`);
  console.log(`\nTop 15 by composite (tool-use-weighted):`);
  console.log(models.slice(0, 15).map(fmt).join("\n"));
  const byTool = models.filter((m) => m.bfcl_overall != null).sort((a, b) => b.bfcl_overall - a.bfcl_overall);
  console.log(`\nTop 10 by BFCL tool-use accuracy (pick tier targets from here):`);
  console.log(byTool.slice(0, 10).map(fmt).join("\n"));
}

main().catch((e) => {
  console.error(`sync-tiers failed: ${e.message}`);
  process.exit(1);
});
