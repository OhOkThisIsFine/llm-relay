/**
 * The daemon's one construction path for a dispatch view.
 *
 * Both GET /dispatch and the D1 lane-execution broker must resolve configured lanes through this
 * function. A second builder would let manifest state, context-window metadata, host transposition,
 * or Windows launcher wrapping drift between "what the daemon says to run" and "what it runs".
 */
import type { ModelCatalog } from "./catalog.js";
import type { Config } from "./config.js";
import {
  buildDispatch,
  resolveLaneLauncherPath,
  type DispatchOptions,
  type DispatchView,
} from "./dispatch.js";
import { observedContextLimit } from "./context-limits.js";
import { loadLaneManifest, type LaneManifest } from "./lane-manifest.js";
import { contextWindowResolver } from "./metadata.js";
import { snapshotContextWindow } from "./tier-data.js";

export type DaemonDispatchOptions = Omit<
  DispatchOptions,
  "manifest" | "publishedContextWindow"
>;

export interface DaemonDispatchViewDeps {
  catalog: Pick<ModelCatalog, "cachedLimits">;
  /** undefined = read the normal cached manifest; null = deliberately no manifest (tests). */
  manifest?: LaneManifest | null;
  platform?: NodeJS.Platform;
  /** undefined = resolve the installed launcher; null = deliberately no wrapper (tests). */
  launcherPath?: string | null;
}

export function buildDaemonDispatchView(
  cfg: Config,
  options: DaemonDispatchOptions,
  deps: DaemonDispatchViewDeps,
): DispatchView {
  const publishedContextWindow = contextWindowResolver(
    (provider, model) => deps.catalog.cachedLimits(provider, model)?.contextLength ?? null,
    snapshotContextWindow,
    observedContextLimit,
  );
  const view = buildDispatch(
    cfg,
    {
      ...options,
      manifest: deps.manifest === undefined ? loadLaneManifest() : deps.manifest,
      publishedContextWindow,
    },
    deps.platform ?? process.platform,
    deps.launcherPath === undefined ? resolveLaneLauncherPath() : deps.launcherPath,
  );
  view.source = "daemon";
  return view;
}
