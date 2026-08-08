import { execFileSync, execSync } from "node:child_process";
import type { Config } from "./config.js";
import {
  laneOfCommand,
  loadLaneManifest,
  saveLaneManifest,
  DEFAULT_MANIFEST_PATH,
  type LaneEntry,
  type LaneManifest,
  type LaneModel,
} from "./lane-manifest.js";

/**
 * `llm-relay lanes --probe` — ask each `cli` lane's own tool what it serves.
 *
 * ⚠ This is the ONE place the relay runs a `cli` lane's command, and the boundary is worth stating
 * because CLAUDE.md says flatly that the relay never spawns one. That invariant is about the
 * REQUEST PATH: a cli lane's quota is client-bound, it runs its own tool loop, and it returns only
 * final text, so a relay that shelled out mid-request could never return the `tool_use` blocks an
 * HTTP turn owes its caller. An operator running a diagnostic is not the request path — exactly as
 * `pools --probe` sends real completions the request path would never send. Nothing here is
 * reachable from `handle()`, and the request path reads only the CACHED manifest.
 *
 * Discovery is not symmetric (docs/lane-discovery.md):
 *   codex — `codex debug models` returns JSON including per-model `supported_reasoning_levels`,
 *           so both the id and the effort argument are validated with no API call spent.
 *   agy   — `agy models` returns `id<TAB>label` and states nothing about flags, so its argument
 *           facts can only be learned from an observed rejection.
 */

export interface LaneProbeResult {
  lane: string;
  ok: boolean;
  via: string;
  modelCount: number;
  error?: string;
}

function run(command: string, args: string[]): string {
  const opts = {
    encoding: "utf8" as const,
    maxBuffer: 64 * 1024 * 1024,
    timeout: 60_000,
    stdio: ["ignore", "pipe", "pipe"] as ("ignore" | "pipe")[],
  };
  try {
    return execFileSync(command, args, opts);
  } catch (e) {
    // ⚠ On Windows an npm-installed CLI is a `.cmd` shim, which execFileSync will not resolve
    // without a shell — `codex` fails ENOENT while running fine in any terminal. Retry through the
    // shell rather than defaulting to it: shell:true re-parses the command line, so it is the
    // fallback, not the norm. Args here are fixed literals from the probers, never task content.
    if (process.platform === "win32" && (e as NodeJS.ErrnoException).code === "ENOENT") {
      // Passed as ONE command line rather than command+args: node deprecates the args form under
      // `shell: true` because it concatenates without escaping. Every token here is a fixed literal
      // from a prober above — no task content, no user input — and the path is quoted.
      return execSync(`"${command}" ${args.join(" ")}`, opts);
    }
    throw e;
  }
}

function probeCodex(command: string): LaneEntry {
  const via = `${command} debug models`;
  const raw = run(command, ["debug", "models"]);
  const parsed = JSON.parse(raw) as { models?: Array<Record<string, unknown>> };
  if (!Array.isArray(parsed.models)) {
    throw new Error(`codex catalog had no "models" array — keys: ${Object.keys(parsed).join(" | ")}`);
  }
  const models: LaneModel[] = [];
  for (const m of parsed.models) {
    const id = typeof m.slug === "string" ? m.slug : null;
    if (!id) continue;
    const levels = Array.isArray(m.supported_reasoning_levels)
      ? (m.supported_reasoning_levels as Array<Record<string, unknown>>)
          .map((r) => (typeof r.effort === "string" ? r.effort : null))
          .filter((e): e is string => e !== null)
      : [];
    models.push(levels.length > 0 ? { id, supports: { model_reasoning_effort: levels } } : { id });
  }
  if (models.length === 0) throw new Error("codex catalog parsed to zero models — schema likely changed");
  return { via, probedAt: new Date().toISOString(), models };
}

function probeAgy(command: string): LaneEntry {
  const via = `${command} models`;
  const raw = run(command, ["models"]);
  const models: LaneModel[] = [];
  for (const line of raw.split("\n")) {
    // `id<TAB>Display Name`. A header/status line ("Fetching available models...") has no tab.
    const [id] = line.split("\t");
    const trimmed = id?.trim();
    if (!trimmed || !line.includes("\t")) continue;
    models.push({ id: trimmed });
  }
  if (models.length === 0) throw new Error("agy models parsed to zero models — output format likely changed");
  // ⚠ No `supports` recorded: agy publishes nothing about flags, and inventing an empty support
  // list would read as "supports nothing" and evict every argument.
  return { via, probedAt: new Date().toISOString(), models };
}

const PROBERS: Record<string, (command: string) => LaneEntry> = {
  codex: probeCodex,
  agy: probeAgy,
};

/** Distinct `cli` commands the configured ladders actually reference. */
export function laneCommands(cfg: Config): Map<string, string> {
  const found = new Map<string, string>();
  const ladders = cfg.routing.ladders ?? {};
  const all = [...Object.values(ladders).flat(), ...(cfg.routing.ladder ?? [])];
  for (const rung of all) {
    if (rung?.kind !== "cli" || typeof rung.command !== "string") continue;
    const lane = laneOfCommand(rung.command);
    if (lane && !found.has(lane)) found.set(lane, rung.command);
  }
  return found;
}

export function probeLanes(cfg: Config, path: string = DEFAULT_MANIFEST_PATH): LaneProbeResult[] {
  const existing = loadLaneManifest(path);
  const manifest: LaneManifest = existing ?? { version: 1, lanes: {} };
  const results: LaneProbeResult[] = [];

  for (const [lane, command] of laneCommands(cfg)) {
    const prober = PROBERS[lane];
    if (!prober) {
      results.push({ lane, ok: false, via: command, modelCount: 0, error: "no prober for this lane" });
      continue;
    }
    try {
      const entry = prober(command);
      // Learned argument rejections survive a re-probe: they are existence facts about a flag,
      // and the roster reading that replaces the model list says nothing about them.
      const previous = manifest.lanes[lane]?.rejectedArgs;
      manifest.lanes[lane] = previous ? { ...entry, rejectedArgs: previous } : entry;
      results.push({ lane, ok: true, via: entry.via, modelCount: entry.models.length });
    } catch (e) {
      // A failed probe leaves any PREVIOUS entry untouched — losing a good roster because the tool
      // was momentarily unavailable would evict working rungs.
      results.push({ lane, ok: false, via: command, modelCount: 0, error: (e as Error).message });
    }
  }

  saveLaneManifest(manifest, path);
  return results;
}
