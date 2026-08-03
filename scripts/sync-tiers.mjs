#!/usr/bin/env node
// Sync model capability rankings from someone-else-maintained leaderboards into a
// local snapshot (docs/tier-data.json) — never a hand-maintained table.
//
// SOURCES (see docs/capability-sources.md for why these and not others):
//   OpenRouter — the spine. Its model ids are the SAME SHAPE as our routing specs
//                ("z-ai/glm-5.2"), so it joins exactly instead of fuzzily. Carries
//                Artificial Analysis intelligence/coding/AGENTIC indices, Design Arena
//                per-category Elo, context length, pricing and tool support.
//   BFCL       — Berkeley Function-Calling Leaderboard. Direct TOOL-USE accuracy; this
//                proxy validates tool calls, so it stays a first-class signal even though
//                it has not scored the newest models.
//   LMArena    — general capability, broad coverage (~430 models).
//   Aider      — polyglot edit benchmark + "percent cases well formed", which is the
//                closest published analogue of what the repair path measures.
//
// Every source is INDEPENDENTLY failable: one dead endpoint must not cost us the other
// three. Schema drift inside a source still throws loudly for that source (a renamed
// column is corruption, not absence) — it is just no longer fatal to the whole sync.
// Zero working sources IS fatal.
//
// Usage: node scripts/sync-tiers.mjs
import { writeFileSync, readFileSync, existsSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  CAPABILITY_DIMENSIONS,
  TASK_FIT_SIGNALS,
  resolveCalibration,
  scoreModels,
} from "./tier-scoring.mjs";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const OUT = join(ROOT, "docs", "tier-data.json");

const OPENROUTER_MODELS = "https://openrouter.ai/api/v1/models";
const BFCL_CSV = "https://gorilla.cs.berkeley.edu/data_overall.csv";
const ARENA_PARQUET =
  "https://huggingface.co/datasets/lmarena-ai/leaderboard-dataset/resolve/main/text_style_control/latest-00000-of-00001.parquet";
const AIDER_YML =
  "https://raw.githubusercontent.com/Aider-AI/aider/main/aider/website/_data/polyglot_leaderboard.yml";

// Columns we depend on — a rename here should FAIL the source, not silently drop data.
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

/**
 * Join key for an OpenRouter id: the segment after the vendor prefix, which is exactly what
 * `joinCapability()` in src/registry.ts extracts from a routing spec. "z-ai/glm-5.2" on both
 * sides, so the match is exact and the fuzzy contains-fallback never fires for these models.
 */
function normId(id) {
  return String(id).split("/").pop().toLowerCase().trim();
}

function pctToNum(v) {
  if (v == null) return null;
  const s = String(v).replace("%", "").trim();
  if (s === "" || s.toUpperCase() === "N/A") return null;
  const n = Number(s);
  return Number.isFinite(n) ? n : null;
}

function mean(xs) {
  const v = xs.filter((x) => Number.isFinite(x));
  return v.length ? v.reduce((a, b) => a + b, 0) / v.length : null;
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

async function fetchOpenRouter() {
  const res = await fetch(OPENROUTER_MODELS);
  if (!res.ok) throw new Error(`OpenRouter fetch HTTP ${res.status}`);
  const j = await res.json();
  if (!Array.isArray(j.data) || j.data.length === 0) throw new Error("OpenRouter returned no models");
  if (!("context_length" in j.data[0])) {
    throw new Error(`OpenRouter schema drift — no context_length. Keys: ${Object.keys(j.data[0]).join(" | ")}`);
  }

  const out = [];
  for (const m of j.data) {
    if (!m.id) continue;
    const aa = m.benchmarks?.artificial_analysis ?? {};
    const da = Array.isArray(m.benchmarks?.design_arena) ? m.benchmarks.design_arena : [];
    // Design Arena publishes one row per category (up to ~20). Storing every row would bloat the
    // snapshot ~20x, so we keep the mean per arena — named _mean so it is never mistaken for a
    // measured value — plus the category count that produced it.
    const agents = da.filter((d) => d.arena === "agents").map((d) => Number(d.elo));
    const models = da.filter((d) => d.arena === "models").map((d) => Number(d.elo));
    out.push({
      name: m.name ?? m.id,
      norm: normId(m.id),
      or_id: m.id,
      aa_intelligence: Number.isFinite(aa.intelligence_index) ? aa.intelligence_index : null,
      aa_coding: Number.isFinite(aa.coding_index) ? aa.coding_index : null,
      aa_agentic: Number.isFinite(aa.agentic_index) ? aa.agentic_index : null,
      design_arena_agents_elo_mean: mean(agents),
      design_arena_agents_categories: agents.length,
      design_arena_models_elo_mean: mean(models),
      design_arena_models_categories: models.length,
      context_length: Number.isFinite(m.context_length) ? m.context_length : null,
      price_prompt: m.pricing?.prompt != null ? Number(m.pricing.prompt) : null,
      price_completion: m.pricing?.completion != null ? Number(m.pricing.completion) : null,
      supports_tools: Array.isArray(m.supported_parameters) ? m.supported_parameters.includes("tools") : null,
    });
  }
  return out;
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
  const { asyncBufferFromUrl, parquetQuery } = await import("hyparquet");
  const file = await asyncBufferFromUrl({ url: ARENA_PARQUET });
  const rows = await parquetQuery({ file });
  if (rows.length && !("model_name" in rows[0])) {
    throw new Error(`LMArena schema drift — no model_name. Keys: ${Object.keys(rows[0]).join(" | ")}`);
  }
  const out = [];
  for (const r of rows) {
    if (r.category !== "overall") continue;
    if (!r.model_name) continue;
    out.push({ norm: normName(r.model_name), arena_rating: Number(r.rating) || null, arena_rank: Number(r.rank) || null });
  }
  return out;
}

/**
 * Aider's polyglot leaderboard is a flat YAML list — `- key: value` records with no nesting,
 * so a 3-field regex read beats taking on a YAML dependency. If it ever nests, the field count
 * drops and the schema check below fires.
 */
async function fetchAider() {
  const res = await fetch(AIDER_YML);
  if (!res.ok) throw new Error(`Aider fetch HTTP ${res.status}`);
  const text = await res.text();
  const out = [];
  let cur = null;
  for (const line of text.split("\n")) {
    const start = /^- dirname:\s*(.+)$/.exec(line);
    if (start) {
      if (cur?.norm) out.push(cur);
      cur = { dirname: start[1].trim() };
      continue;
    }
    if (!cur) continue;
    // [a-z0-9_] — the digits matter: the headline field is `pass_rate_2`.
    const kv = /^\s{2}([a-z0-9_]+):\s*(.+)$/.exec(line);
    if (!kv) continue;
    const [, k, raw] = kv;
    const v = raw.trim();
    if (k === "model") { cur.name = v; cur.norm = normName(v); }
    else if (k === "pass_rate_2") cur.aider_pass_rate = pctToNum(v);
    else if (k === "percent_cases_well_formed") cur.aider_well_formed = pctToNum(v);
  }
  if (cur?.norm) out.push(cur);
  if (out.length === 0) throw new Error("Aider YAML parsed to zero records — format likely changed");
  if (!out.some((m) => m.aider_pass_rate != null)) {
    throw new Error("Aider YAML had no pass_rate_2 values — column renamed?");
  }
  // Keep the best run per model (the file is one record per benchmark run).
  const best = new Map();
  for (const m of out) {
    const prev = best.get(m.norm);
    if (!prev || (m.aider_pass_rate ?? -1) > (prev.aider_pass_rate ?? -1)) best.set(m.norm, m);
  }
  return [...best.values()].map(({ dirname, ...rest }) => ({ ...rest, aider_run: dirname }));
}

async function main() {
  const warnings = [];
  const sources = {};

  const run = async (key, url, note, fn) => {
    try {
      const rows = await fn();
      sources[key] = { url, note, model_count: rows.length, ok: true };
      return rows;
    } catch (e) {
      warnings.push(`${key} sync FAILED: ${e.message}`);
      sources[key] = { url, note, model_count: 0, ok: false, error: e.message };
      return [];
    }
  };

  // Independent: one dead source costs only its own columns.
  const [openrouter, bfcl, arena, aider] = await Promise.all([
    run("openrouter", OPENROUTER_MODELS, "AA intelligence/coding/agentic + design arena + context/pricing; EXACT ids", fetchOpenRouter),
    run("bfcl", BFCL_CSV, "tool-use / function-calling accuracy", fetchBfcl),
    run("lmarena", ARENA_PARQUET, "general capability", fetchArena),
    run("aider", AIDER_YML, "polyglot edit benchmark + edit-format compliance", fetchAider),
  ]);

  if (openrouter.length + bfcl.length + arena.length + aider.length === 0) {
    throw new Error(`every source failed:\n  ${warnings.join("\n  ")}`);
  }

  // Merge on `norm`. OpenRouter contributes exact-id keys ("glm-5.2"); the leaderboards contribute
  // display-name keys ("glm-5.2-max"). Those stay SEPARATE rows on purpose — they are different
  // SKUs, and collapsing them is precisely the borrowed-score bug this replaces.
  const byNorm = new Map();
  const absorb = (rows, source) => {
    for (const r of rows) {
      if (!r.norm) continue;
      const m = byNorm.get(r.norm) ?? { name: r.name ?? r.norm, norm: r.norm, sources: [] };
      Object.assign(m, r);
      if (!m.sources.includes(source)) m.sources.push(source);
      byNorm.set(r.norm, m);
    }
  };
  absorb(openrouter, "openrouter");
  absorb(bfcl, "bfcl");
  absorb(arena, "lmarena");
  absorb(aider, "aider");
  const models = [...byNorm.values()];

  const prev = existsSync(OUT) ? JSON.parse(readFileSync(OUT, "utf8")) : null;
  const generatedAt = new Date().toISOString();
  const calibration = resolveCalibration(models, prev?.calibration, generatedAt);
  scoreModels(models, calibration, prev?.models ?? []);
  models.sort((a, b) => (b.strength ?? -1) - (a.strength ?? -1));
  models.forEach((m, i) => { m.strength_rank = m.strength != null ? i + 1 : null; });
  // Back-compat: consumers pinned to the old field names keep working.
  for (const m of models) { m.composite = m.strength; m.composite_rank = m.strength_rank; }

  if (!existsSync(dirname(OUT))) mkdirSync(dirname(OUT), { recursive: true });
  const snapshot = {
    synced_at: generatedAt,
    sources,
    warnings,
    calibration,
    dimensions: CAPABILITY_DIMENSIONS,
    task_fit_signals: TASK_FIT_SIGNALS,
    composite_note:
      "strength = fixed 40% agentic + 35% coding + 25% general capability. Raw measurements use " +
      "persisted calibration anchors; missing dimensions are estimated from overlap instead of " +
      "disappearing from the denominator. capability_confidence records evidence quality but does " +
      "not gate effort membership. Specialized task/behavior signals are separate and affect " +
      "deployment fitness only.",
    models,
  };
  writeFileSync(OUT, JSON.stringify(snapshot, null, 2) + "\n");

  // --- console report ---
  const fmt = (m, i) =>
    `${String(i + 1).padStart(3)}. ${(m.name ?? m.norm).padEnd(38).slice(0, 38)}  ` +
    `str=${m.strength != null ? m.strength.toFixed(3) : "  —  "} ` +
    `n=${String(m.signal_count).padStart(2)} d=${String(m.direct_dimensions.length).padStart(1)}  ` +
    `bfcl=${m.bfcl_overall != null ? String(m.bfcl_overall).padStart(5) : "   — "}  ` +
    `agentic=${m.aa_agentic != null ? String(m.aa_agentic).padStart(5) : "   — "}  ` +
    `arena=${m.arena_rating != null ? String(Math.round(m.arena_rating)).padStart(4) : "  — "}`;

  console.log(`\nSynced ${models.length} models → ${OUT}`);
  for (const [k, s] of Object.entries(sources)) {
    console.log(`  ${s.ok ? "✓" : "✗"} ${k.padEnd(11)} ${String(s.model_count).padStart(4)} models${s.ok ? "" : `  — ${s.error}`}`);
  }
  if (warnings.length) console.log(warnings.map((w) => `  ⚠ ${w}`).join("\n"));
  if (prev) console.log(`  (previous snapshot: ${prev.synced_at}, ${prev.models?.length ?? "?"} models)`);

  const multi = models.filter((m) => m.published_signal_count >= 3);
  console.log(`\nTop 15 by strength (>=3 published signals — ${multi.length} of ${models.length} qualify):`);
  console.log(multi.slice(0, 15).map(fmt).join("\n"));
}

main().catch((e) => {
  console.error(`sync-tiers failed: ${e.message}`);
  process.exit(1);
});
