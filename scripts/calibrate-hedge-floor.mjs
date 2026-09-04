#!/usr/bin/env node
// Calibrate `routing.hedge.msPerInputToken` — the size-scaled half of the hedge floor (owner
// direction 2026-09-04, see src/hedge-trigger.ts and docs/hedged-attempts-design-2026-08-30.md).
//
// The hedge floor is `max(minFloorMs, msPerInputToken x estimatedInputTokens)`, so a large prompt
// is not hedged against the time it simply takes a HEALTHY deployment to read it. This script
// reads this machine's own accounting history (`~/.llm-relay/usage/recent.json`) and fits
// `msPerInputToken` from it, the same way `DEFAULT_LATENCY_MS_PER_TOKEN` in latency-demotion.ts
// was fit from real traffic rather than picked.
//
// METHOD. Chosen: the p25 (lower quartile) of (latencyMs / inputTokens) ratios among successful
// SERVE attempts carrying >= 10,000 input tokens, across every deployment in the window.
//
// The alternative the design considered — an OLS-through-origin SLOPE restricted to "the fast
// deployments" — needs a judgement call this machine's window cannot support robustly: on a
// typical run the >=10,000-token slice holds only a handful of deployments, several with 1-2
// samples each, so hand-picking which ones count as "fast" would itself be a guess layered on top
// of a guess. The p25 rung of the large-prompt population sidesteps that: it takes the FAST TAIL of
// real large-prompt behaviour directly, without naming a deployment, and it is exactly the
// operational reading of "how long does it take a healthy deployment to read a big prompt" that the
// floor exists to protect. Large prompts are the deliberate restriction (not "any request over some
// small size") because per-request FIXED overhead — network round trip, provider queueing — masks
// the true per-token rate at small sizes; it is amortised away once a prompt is large.
//
// GUARDRAIL. `hedge-trigger.ts` accepts the fit only when it lands in [0.05, 0.5] ms/token; outside
// that band the sample is judged too thin to trust and the script falls back to 0.15 ms/token,
// stating so loudly. That is the SAME fail-safe direction as an unmeasured latency, an unpublished
// context ceiling, or any other place in this relay where "not enough evidence" degrades to a safe
// default rather than shipping a number a thin sample cannot support.
//
// Usage: node scripts/calibrate-hedge-floor.mjs [--path <recent.json>]
//
// Reads only ~/.llm-relay/usage/recent.json (or XDG_CACHE_HOME's llm-relay/usage/recent.json, or
// the file named by --path). Does not touch dist/ or src/ — this is a standalone data-analysis
// utility, the sync-tiers.mjs/tier-scoring.mjs precedent, not a runtime dependency.
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

const MIN_ACCEPTED_MS_PER_TOKEN = 0.05;
const MAX_ACCEPTED_MS_PER_TOKEN = 0.5;
const FALLBACK_MS_PER_INPUT_TOKEN = 0.15;
// Mirrors `DEFAULT_HEDGE_MIN_FLOOR_MS` in src/hedge-trigger.ts. Not imported (this script touches
// neither dist/ nor src/ — see the module comment) — kept in step by the two constants living a few
// lines apart in that file, same as this script's own report calling out the value it assumes.
const ASSUMED_MIN_FLOOR_MS = 3_000;
const BIG_PROMPT_TOKEN_FLOOR = 10_000;

/** Where `recent.json` lives, honouring XDG the way `state-paths.ts` does, without importing it. */
function defaultRecentJsonPath() {
  const xdgCache = process.env.XDG_CACHE_HOME;
  const base = xdgCache && xdgCache.trim() !== "" ? join(xdgCache, "llm-relay") : join(homedir(), ".llm-relay");
  return join(base, "usage", "recent.json");
}

function parseArgs(argv) {
  const out = { path: null };
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "--path") out.path = argv[++i] ?? null;
  }
  return out;
}

function tokenCellValue(cell) {
  return cell && typeof cell === "object" && cell.known > 0 && typeof cell.value === "number" ? cell.value : null;
}

/** Reported input tokens if known, else the estimate — the RED-test spec's own preference order. */
function inputTokensOf(attempt) {
  const reported = tokenCellValue(attempt?.tokens?.reported?.reportedInput);
  if (reported !== null) return reported;
  return tokenCellValue(attempt?.tokens?.estimated?.estimatedInput);
}

/** Successful SERVE attempts (never repair attempts) carrying a positive latency + input count. */
function collectSamples(store) {
  const samples = [];
  for (const row of store.rows ?? []) {
    for (const attempt of row.attempts ?? []) {
      if (attempt.role !== "serve" || attempt.outcome !== "success") continue;
      const latencyMs = attempt.latencyMs;
      if (typeof latencyMs !== "number" || !Number.isFinite(latencyMs) || latencyMs <= 0) continue;
      const inputTokens = inputTokensOf(attempt);
      if (inputTokens === null || inputTokens <= 0) continue;
      samples.push({
        latencyMs,
        inputTokens,
        provider: attempt.provider ?? "unknown",
        model: attempt.model ?? "unknown",
      });
    }
  }
  return samples;
}

function percentile(sortedAscending, p) {
  if (sortedAscending.length === 0) return null;
  const idx = (sortedAscending.length - 1) * p;
  const lo = Math.floor(idx);
  const hi = Math.ceil(idx);
  if (lo === hi) return sortedAscending[lo];
  return sortedAscending[lo] + (sortedAscending[hi] - sortedAscending[lo]) * (idx - lo);
}

/** OLS slope through the origin: minimises sum((latency - slope*tokens)^2). Cross-check only. */
function slopeThroughOrigin(samples) {
  let num = 0;
  let den = 0;
  for (const s of samples) {
    num += s.latencyMs * s.inputTokens;
    den += s.inputTokens * s.inputTokens;
  }
  return den === 0 ? null : num / den;
}

function floorMsFor(tokens, minFloorMs, msPerInputToken) {
  return Math.max(minFloorMs, msPerInputToken * tokens);
}

function fmtMs(n) {
  return `${Math.round(n).toLocaleString()} ms`;
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  const path = args.path ?? defaultRecentJsonPath();

  console.log("llm-relay hedge floor calibration");
  console.log("==================================");
  console.log(`Source: ${path}`);

  if (!existsSync(path)) {
    console.log("No accounting history found at that path — nothing to fit.");
    console.log(`Recommend the built-in default: ${FALLBACK_MS_PER_INPUT_TOKEN} ms/token (no data to fit against).`);
    process.exitCode = 1;
    return;
  }

  let store;
  try {
    store = JSON.parse(readFileSync(path, "utf8"));
  } catch (e) {
    console.log(`Could not parse ${path} as JSON: ${e instanceof Error ? e.message : String(e)}`);
    process.exitCode = 1;
    return;
  }

  const samples = collectSamples(store);
  console.log(`Successful SERVE attempts with a latency and an input token count: ${samples.length}`);

  const big = samples.filter((s) => s.inputTokens >= BIG_PROMPT_TOKEN_FLOOR);
  console.log(`  ...of which >= ${BIG_PROMPT_TOKEN_FLOOR.toLocaleString()} input tokens: ${big.length}`);
  console.log("");

  if (big.length === 0) {
    console.log(`No requests with >= ${BIG_PROMPT_TOKEN_FLOOR.toLocaleString()} input tokens — cannot fit.`);
    console.log(`Recommend the built-in default: ${FALLBACK_MS_PER_INPUT_TOKEN} ms/token.`);
    printFloors("Floors at the built-in default", FALLBACK_MS_PER_INPUT_TOKEN);
    return;
  }

  console.log(
    "Method: p25 (lower quartile) of (latencyMs / inputTokens) ratios among the >= " +
      `${BIG_PROMPT_TOKEN_FLOOR.toLocaleString()}-token requests, across every deployment in the window.`,
  );
  console.log(
    "Chosen over an OLS-through-origin slope restricted to \"the fast deployments\" because this " +
      "machine's window cannot support that classification robustly (see the module comment for why).",
  );
  console.log("");

  const ratios = big.map((s) => s.latencyMs / s.inputTokens).sort((a, b) => a - b);
  const p25 = percentile(ratios, 0.25);
  const p50 = percentile(ratios, 0.5);
  const p75 = percentile(ratios, 0.75);
  console.log(
    `Ratio percentiles (ms/token): p25=${p25.toFixed(4)}  p50=${p50.toFixed(4)}  p75=${p75.toFixed(4)}  (n=${big.length})`,
  );

  // Cross-check only, never shipped: an OLS-through-origin slope on the single deployment with the
  // lowest median ratio in the big-prompt slice (its own operational reading of "fast").
  const byDeployment = new Map();
  for (const s of big) {
    const key = `${s.provider}/${s.model}`;
    const arr = byDeployment.get(key) ?? [];
    arr.push(s);
    byDeployment.set(key, arr);
  }
  let fastestKey = null;
  let fastestMedian = Infinity;
  for (const [key, arr] of byDeployment) {
    const median = percentile(
      arr.map((s) => s.latencyMs / s.inputTokens).sort((a, b) => a - b),
      0.5,
    );
    if (median !== null && median < fastestMedian) {
      fastestMedian = median;
      fastestKey = key;
    }
  }
  if (fastestKey) {
    const fastestSamples = samples.filter((s) => `${s.provider}/${s.model}` === fastestKey);
    const slope = slopeThroughOrigin(fastestSamples);
    console.log(
      `Cross-check only (not used): OLS-through-origin slope on the single fastest deployment by ` +
        `median big-prompt ratio (${fastestKey}, n=${fastestSamples.length} across all sizes): ` +
        `${slope === null ? "n/a" : slope.toFixed(4)} ms/token.`,
    );
  }
  console.log("");

  const fitted = p25;
  const inRange = fitted >= MIN_ACCEPTED_MS_PER_TOKEN && fitted <= MAX_ACCEPTED_MS_PER_TOKEN;
  console.log(`Fitted msPerInputToken (p25 method): ${fitted.toFixed(4)} ms/token`);
  const shipped = inRange ? fitted : FALLBACK_MS_PER_INPUT_TOKEN;
  if (inRange) {
    console.log(`  Within the accepted [${MIN_ACCEPTED_MS_PER_TOKEN}, ${MAX_ACCEPTED_MS_PER_TOKEN}] ms/token band -> SHIPPING the fit.`);
  } else {
    console.log(
      `  OUT OF the accepted [${MIN_ACCEPTED_MS_PER_TOKEN}, ${MAX_ACCEPTED_MS_PER_TOKEN}] ms/token band -> ` +
        `REJECTED. Falling back to the built-in default of ${FALLBACK_MS_PER_INPUT_TOKEN} ms/token.`,
    );
  }
  console.log("");
  console.log(`Shipped default: msPerInputToken = ${shipped} ms/token, minFloorMs = ${ASSUMED_MIN_FLOOR_MS} ms`);
  console.log("");

  printFloors("Resulting floors, at the SHIPPED value", shipped);
  if (shipped !== fitted) {
    console.log("");
    printFloors("For reference only — floors at the raw fitted value (NOT shipped)", fitted);
  }
}

function printFloors(label, msPerInputToken) {
  console.log(`${label} (minFloorMs=${ASSUMED_MIN_FLOOR_MS}, msPerInputToken=${msPerInputToken}):`);
  for (const tokens of [1_000, 20_000, 100_000, 160_000]) {
    console.log(`  ${tokens.toLocaleString().padStart(9)} tokens -> ${fmtMs(floorMsFor(tokens, ASSUMED_MIN_FLOOR_MS, msPerInputToken))}`);
  }
}

main();
