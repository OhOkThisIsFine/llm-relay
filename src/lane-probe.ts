import { execFile, exec } from "node:child_process";
import type { Config } from "./config-types.js";
import {
  laneOfRung,
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
 * ⚠ The spawn boundary (amended by owner decision 2026-08-29, docs/quota-reprobe-design-2026-08-29.md):
 * the REQUEST PATH never runs a `cli` lane's command — a lane's quota is client-bound, it runs its
 * own tool loop, and it returns only final text, so a relay that shelled out mid-request could
 * never return the `tool_use` blocks an HTTP turn owes its caller. Outside the request path there
 * are exactly TWO spawn sites: this operator-invoked probe, and the background lane cadence
 * (`lane-cadence.ts`) that keeps rosters fresh and re-tests recorded quota deaths — background
 * metadata polling is the relay's job, exactly as the ping loop already does for HTTP. Nothing
 * here is reachable from `handle()`, and the request path reads only the CACHED manifest.
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

/**
 * Quote ONE argument for the Windows shell-fallback line. `args.join(" ")` is the exact defect
 * the dispatch renderer's comment warns about ("a task containing a space ... broke out"), and it
 * bit again here on 2026-08-30: the quota probe's prompt reached codex as seven separate tokens
 * (`error: unexpected argument 'with' found`). The fallback is unavoidable — Node refuses to
 * execFile a `.cmd` shim without a shell — so every token is quoted, embedded quotes escaped.
 */
export function quoteCmdArg(arg: string): string {
  return `"${arg.replace(/"/g, '\\"')}"`;
}

/**
 * Async on purpose: the background cadence runs this beside the ping loop, and a synchronous
 * spawn would block every HTTP probe for the lane command's whole runtime. `windowsHide` is
 * load-bearing, not cosmetic — the relay daemon is launched console-less at logon, and a console
 * CLI spawned from a console-less parent makes Windows ALLOCATE a console and STEAL FOCUS unless
 * the caller sets CREATE_NO_WINDOW (verified on agy, 2026-08-27; `windowsHide: true` is Node's
 * spelling of that flag).
 */
function runLaneCommand(command: string, args: string[]): Promise<string> {
  const opts = {
    encoding: "utf8" as const,
    maxBuffer: 64 * 1024 * 1024,
    timeout: 60_000,
    windowsHide: true,
  };
  return new Promise((resolve, reject) => {
    const child = execFile(command, args, opts, (err, stdout) => {
      if (!err) {
        resolve(stdout);
        return;
      }
      // ⚠ On Windows an npm-installed CLI is a `.cmd` shim, which execFile will not resolve
      // without a shell — `codex` fails ENOENT while running fine in any terminal. Retry through
      // the shell rather than defaulting to it: the shell re-parses the command line, so it is
      // the fallback, not the norm. Passed as ONE quoted command line; every token here is a
      // fixed literal from a prober below — no task content, no user input.
      if (process.platform === "win32" && (err as NodeJS.ErrnoException).code === "ENOENT") {
        const fallback = exec(`${quoteCmdArg(command)} ${args.map(quoteCmdArg).join(" ")}`, opts, (err2, stdout2) => {
          if (err2) reject(err2);
          else resolve(stdout2);
        });
        fallback.stdin?.end();
        return;
      }
      reject(err);
    });
    // ⚠ Load-bearing, measured 2026-08-30: the sync predecessor passed `stdio: ["ignore", …]`,
    // which execFile cannot express — its stdin is an OPEN pipe. `agy models` waits on stdin and
    // produced 0 bytes until the 60s timeout killed it; with EOF it answers in ~2s. Close it.
    child.stdin?.end();
  });
}

async function probeCodex(command: string): Promise<LaneEntry> {
  const via = `${command} debug models`;
  const raw = await runLaneCommand(command, ["debug", "models"]);
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

async function probeAgy(command: string): Promise<LaneEntry> {
  const via = `${command} models`;
  const raw = await runLaneCommand(command, ["models"]);
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

const PROBERS: Record<string, (command: string) => Promise<LaneEntry>> = {
  codex: probeCodex,
  agy: probeAgy,
};

/**
 * Distinct `cli` lanes the configured ladders actually reference, mapped to the lane's OWN
 * binary. Recognition sees through wrapper commands (`laneOfRung`), and the value is the matched
 * lane binary rather than `rung.command` — probing `pwsh models` would probe the wrapper, not
 * the lane. `windowsHide` above is what makes the direct binary safe to spawn console-less.
 */
export function laneCommands(cfg: Config): Map<string, string> {
  const found = new Map<string, string>();
  const ladders = cfg.routing.ladders ?? {};
  const all = [...Object.values(ladders).flat(), ...(cfg.routing.ladder ?? [])];
  for (const rung of all) {
    if (rung?.kind !== "cli" || typeof rung.command !== "string") continue;
    const match = laneOfRung(rung.command, rung.args);
    if (match && !found.has(match.lane)) found.set(match.lane, match.binary);
  }
  return found;
}

export async function probeLanes(cfg: Config, path: string = DEFAULT_MANIFEST_PATH): Promise<LaneProbeResult[]> {
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
      const entry = await prober(command);
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
