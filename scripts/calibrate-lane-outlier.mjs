#!/usr/bin/env node
// Calibrate `routing.dispatchWalk.outlier.outlierFactor` — the recent-versus-earlier demotion
// threshold for a `cli` dispatch lane (backlog item 9, owner question 2026-09-05; the rule lives in
// `checkLaneOutlier`, src/lane-affinity.ts).
//
// A lane is demoted when the MEDIAN of its most recent `recentCount` runs exceeds the `historyQuantile`
// (p80) of its EARLIER runs on the same (lane, tier) window by more than `outlierFactor`. This script
// reads this machine's own lane history (`~/.llm-relay/dispatch-lane-stats.json`) and fits the factor
// from it, the way `calibrate-hedge-floor.mjs` fits the hedge floor and `DEFAULT_LATENCY_MS_PER_TOKEN`
// was fit from real traffic — never picked by eye.
//
// METHOD. For every (lane, tier) window with at least `recentCount + minSamples` samples, slide a split
// across the window in time order: at each split the EARLIER half is everything before it, the RECENT
// half is the next `recentCount` samples, and the ratio is median(recent) / p80(earlier). Every ratio
// from every window is pooled, and the proposal is the pooled p95 — the point above which a lane is more
// extreme than 95% of its own-history comparisons. Nearest-rank quantiles throughout, so every figure is
// an observed sample, never an interpolation between two (a percentile reporting a duration nothing ever
// took would be a fabricated measurement).
//
// GUARDRAIL. The proposal is ACCEPTED only inside [1.5, 10.0]. Below 1.5 the machine's history is too
// steady to separate a slow week from an outlier and the factor would demote on ordinary wobble; above
// 10.0 it would catch only the catastrophic stall the walk budget already catches. Outside the band the
// script prints the built-in default and says so — the same fail-safe direction as an unmeasured latency
// or an unpublished context ceiling anywhere else in this relay.
//
// ⚠ The band's upper edge was 5.0 in the first draft and moved to 10.0 on the first REAL run
// (2026-09-09): the pooled p95 came out at 7.57, and the per-lane figures showed why — free-pool's
// healthy recent-median / history-p80 ratio reaches 4.18 at p95 with a 33x spike on record, and
// opencode-muse-spark's reaches 12.5. A factor of 2.5 would have demoted both lanes on ordinary
// wobble, the exact harm this rule must not do; 7.6 still fires on the real 13x and 33x events.
//
// ⚠ Every figure printed here is PERISHABLE and MACHINE-LOCAL: it describes one operator's rolling
// window on one date, which real traffic overwrites. Record the output beside the default with its date;
// never quote it as though a later reader could reproduce it.
//
// Usage: node scripts/calibrate-lane-outlier.mjs [--file <dispatch-lane-stats.json>]
//        [--recent 5] [--quantile 0.8] [--min-samples 5]
//
// Reads only the stats file (default: `~/.llm-relay/dispatch-lane-stats.json`, or
// `$XDG_CACHE_HOME/llm-relay/dispatch-lane-stats.json` when that variable is set — the cache-kind
// resolution `state-paths.ts` applies, without importing it). Touches neither dist/ nor src/.
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

const MIN_ACCEPTED_FACTOR = 1.5;
const MAX_ACCEPTED_FACTOR = 10.0;
// Mirrors `DEFAULT_OUTLIER_FACTOR` in src/lane-affinity.ts (7.6 — the accepted fit of 2026-09-09).
// Not imported (this script touches neither dist/ nor src/); kept in step by the two constants naming
// each other in their comments.
const FALLBACK_FACTOR = 7.6;

function defaultStatsPath() {
  const xdgCache = process.env.XDG_CACHE_HOME;
  const base = xdgCache && xdgCache.trim() !== "" ? join(xdgCache, "llm-relay") : join(homedir(), ".llm-relay");
  return join(base, "dispatch-lane-stats.json");
}

function parseArgs(argv) {
  const out = { file: null, recentCount: 5, historyQuantile: 0.8, minSamples: 5 };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--file") out.file = argv[++i] ?? null;
    else if (a === "--recent") out.recentCount = Number(argv[++i]);
    else if (a === "--quantile") out.historyQuantile = Number(argv[++i]);
    else if (a === "--min-samples") out.minSamples = Number(argv[++i]);
  }
  if (!Number.isInteger(out.recentCount) || out.recentCount < 1) throw new Error("--recent must be a positive integer");
  if (!(out.historyQuantile > 0 && out.historyQuantile < 1)) throw new Error("--quantile must be in (0, 1)");
  if (!Number.isInteger(out.minSamples) || out.minSamples < 1) throw new Error("--min-samples must be a positive integer");
  return out;
}

/** Nearest-rank quantile over a copy of `values` — always an observed sample. */
function quantile(values, q) {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const rank = Math.ceil(q * sorted.length);
  return sorted[Math.min(sorted.length, Math.max(1, rank)) - 1];
}

/** Median as the nearest-rank p50 — the same reading `medianWallClockMs` gives in the relay. */
function median(values) {
  return quantile(values, 0.5);
}

function loadRows(file) {
  if (!existsSync(file)) {
    throw new Error(`no lane stats file at ${file} — nothing to calibrate against`);
  }
  const parsed = JSON.parse(readFileSync(file, "utf8"));
  const rows = Array.isArray(parsed?.rows) ? parsed.rows : [];
  return rows
    .filter((r) => r && typeof r.laneId === "string" && Array.isArray(r.wallClockMs))
    .map((r) => ({
      laneId: r.laneId,
      tier: typeof r.tier === "string" ? r.tier : null,
      samples: r.wallClockMs.filter((v) => typeof v === "number" && Number.isFinite(v) && v >= 0),
    }));
}

/** Every recent-median / earlier-p80 ratio one window yields across its sliding splits. */
function ratiosForWindow(samples, { recentCount, historyQuantile, minSamples }) {
  const out = [];
  if (samples.length < recentCount + minSamples) return out;
  for (let k = minSamples; k + recentCount <= samples.length; k++) {
    const earlier = samples.slice(0, k);
    const recent = samples.slice(k, k + recentCount);
    if (recent.length < minSamples) continue; // the rule needs a distribution on both sides
    const history = quantile(earlier, historyQuantile);
    const recentMedian = median(recent);
    if (history === null || recentMedian === null || history <= 0) continue;
    out.push(recentMedian / history);
  }
  return out;
}

function fmt(n) {
  return n === null ? "n/a" : n.toFixed(2);
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  const file = args.file ?? defaultStatsPath();
  const rows = loadRows(file);
  const settings = { recentCount: args.recentCount, historyQuantile: args.historyQuantile, minSamples: args.minSamples };

  console.log(`calibrate-lane-outlier — ${new Date().toISOString()}`);
  console.log(`file: ${file}`);
  console.log(`rows: ${rows.length}; rule: median(recent ${settings.recentCount}) / p${Math.round(settings.historyQuantile * 100)}(earlier), both halves >= ${settings.minSamples} samples`);
  console.log("");

  const pooled = [];
  let eligible = 0;
  for (const row of rows) {
    const ratios = ratiosForWindow(row.samples, settings);
    const key = `${row.laneId}${row.tier === null ? "" : ` [${row.tier}]`}`;
    if (ratios.length === 0) {
      console.log(`  ${key}: ${row.samples.length} samples — too few for a split (needs ${settings.recentCount + settings.minSamples})`);
      continue;
    }
    eligible++;
    pooled.push(...ratios);
    console.log(
      `  ${key}: ${row.samples.length} samples, ${ratios.length} splits — ` +
        `p50 ${fmt(quantile(ratios, 0.5))}, p90 ${fmt(quantile(ratios, 0.9))}, p95 ${fmt(quantile(ratios, 0.95))}, max ${fmt(Math.max(...ratios))}`,
    );
  }
  console.log("");

  if (pooled.length === 0) {
    console.log(`no window has enough history for a fit; the built-in default ${FALLBACK_FACTOR} stands, UNCALIBRATED.`);
    return;
  }
  const p50 = quantile(pooled, 0.5);
  const p90 = quantile(pooled, 0.9);
  const p95 = quantile(pooled, 0.95);
  const max = Math.max(...pooled);
  console.log(`pooled over ${eligible} windows, ${pooled.length} ratios: p50 ${fmt(p50)}, p90 ${fmt(p90)}, p95 ${fmt(p95)}, max ${fmt(max)}`);
  console.log(`proposal (pooled p95): ${fmt(p95)}`);
  if (p95 >= MIN_ACCEPTED_FACTOR && p95 <= MAX_ACCEPTED_FACTOR) {
    console.log(`ACCEPTED: inside [${MIN_ACCEPTED_FACTOR}, ${MAX_ACCEPTED_FACTOR}] — set routing.dispatchWalk.outlier.outlierFactor to ${fmt(p95)}`);
  } else {
    console.log(
      `REJECTED: ${fmt(p95)} is outside [${MIN_ACCEPTED_FACTOR}, ${MAX_ACCEPTED_FACTOR}] — ` +
        `the built-in default ${FALLBACK_FACTOR} stands. ` +
        (p95 < MIN_ACCEPTED_FACTOR
          ? "This history is too steady to separate a slow week from an outlier; a factor this low would demote on ordinary wobble."
          : "A factor this high would never fire."),
    );
  }
  console.log("");
  console.log("⚠ perishable, machine-local figures — record them with today's date; never cite them as reproducible.");
}

try {
  main();
} catch (error) {
  console.error(`calibrate-lane-outlier: ${error instanceof Error ? error.message : String(error)}`);
  process.exit(1);
}
