/**
 * Resolve and launch one configured MCP agent lane inside the relay daemon.
 *
 * D1 deliberately makes this a launcher factory, not a generic process endpoint. The broker request
 * names a lane id and execution facts; this module asks the daemon's canonical dispatch-view builder
 * what that lane means NOW, applies the same MCP launch corrections, then reuses the existing
 * LaneSpawner process boundary. No command, argv, environment map or pid comes from the broker
 * request.
 *
 * This module is not installed by createProxy yet. It is the inert Phase-2 substrate that will be
 * wired only together with restart recovery semantics.
 */
import type { ModelCatalog } from "./catalog.js";
import type { Config } from "./config.js";
import type { DispatchView } from "./dispatch.js";
import { buildDaemonDispatchView } from "./daemon-dispatch-view.js";
import {
  createLaneActivityTag,
  readLaneActivity,
  withLaneActivityHeader,
} from "./lane-activity.js";
import { buildLaneEnv } from "./lane-launch-env.js";
import {
  type LaneExecutionActivity,
  type LaneExecutionLaunchHandle,
  type LaneExecutionLauncher,
  type LaneExecutionStartRequest,
} from "./lane-execution-broker.js";
import {
  DEPTH_ENV,
  agyWorkingDirInvoke,
  checkCwd,
  defaultLaneSpawner,
  expandEnvReferences,
  type LaneSpawnHandle,
  type LaneSpawner,
} from "./mcp/lane-runner.js";
import {
  defaultProcessCpuReader,
  type ProcessCpuReader,
} from "./mcp/process-cpu.js";
import {
  readOnlyInvoke,
  readOnlyVerdict,
} from "./mcp/readonly-boundary.js";

export interface ConfiguredLaneExecutionLauncherDeps {
  catalog: Pick<ModelCatalog, "cachedLimits">;
  spawn?: LaneSpawner;
  hostEnv?: NodeJS.ProcessEnv;
  platform?: NodeJS.Platform;
  now?: () => number;
  readProcessCpu?: ProcessCpuReader;
  /** Test seams for the canonical daemon view builder. */
  manifest?: Parameters<typeof buildDaemonDispatchView>[2]["manifest"];
  launcherPath?: string | null;
}

function refuse(message: string): { refusal: string } {
  return { refusal: message.slice(0, 500) };
}

/**
 * Create the daemon-side launcher used by LaneExecutionBroker.
 *
 * A start is forced to the requested configured lane, requester=mcp, mode=agent. The daemon's live
 * config and dispatch view are authority; a stale MCP process cannot supply an old command line.
 */
export function createConfiguredLaneExecutionLauncher(
  cfg: Config,
  deps: ConfiguredLaneExecutionLauncherDeps,
): LaneExecutionLauncher {
  const spawn = deps.spawn ?? defaultLaneSpawner;
  const hostEnv = deps.hostEnv ?? process.env;
  const platform = deps.platform ?? process.platform;
  const now = deps.now ?? Date.now;
  const readProcessCpu = deps.readProcessCpu ?? defaultProcessCpuReader;
  const allowedRoots = cfg.routing.mcp?.allowedRoots;

  return (request: LaneExecutionStartRequest): LaneExecutionLaunchHandle | { refusal: string } => {
    const cwdCheck = checkCwd(request.cwd, allowedRoots);
    if (!cwdCheck.ok) return refuse(`dispatch refused: ${cwdCheck.reason}`);

    if (request.readOnly === true) {
      const boundary = readOnlyVerdict({
        readOnly: true,
        mode: "agent",
        cwd: request.cwd,
        // The parser requires this for readOnly=true. Keep the runtime guard for typed embedders.
        callerRoot: request.callerRoot ?? request.cwd,
      });
      if (!boundary.ok) return refuse(boundary.refusal);
    }

    let view: DispatchView;
    try {
      view = buildDaemonDispatchView(
        cfg,
        {
          task: request.task,
          lane: request.laneId,
          ...(request.tier === undefined ? {} : { tier: request.tier }),
          requester: "mcp",
          mode: "agent",
          ...(request.host === undefined ? {} : { host: request.host }),
          ...(request.entrypoint === undefined ? {} : { entrypoint: request.entrypoint }),
        },
        {
          catalog: deps.catalog,
          ...(deps.manifest === undefined ? {} : { manifest: deps.manifest }),
          platform,
          ...(deps.launcherPath === undefined ? {} : { launcherPath: deps.launcherPath }),
        },
      );
    } catch {
      return refuse("configured lane could not be resolved");
    }

    const lane = view.next;
    if (lane === null || lane.id !== request.laneId) {
      return refuse(view.reason || `configured lane "${request.laneId}" is unavailable`);
    }
    if (lane.invoke === undefined) {
      return refuse(
        lane.unreachable ??
        `configured lane "${request.laneId}" has no executable invocation for MCP agent mode`,
      );
    }

    let declared = lane.invoke;
    let readOnlyBinding: string | undefined;
    if (request.readOnly === true) {
      const bound = readOnlyInvoke(declared);
      if (!bound.ok) return refuse(`dispatch refused: ${bound.reason}`);
      declared = bound.invoke;
      readOnlyBinding = bound.binding;
    }

    const agy = agyWorkingDirInvoke(declared, request.cwd);
    const invoke = agy?.invoke ?? declared;
    const expansion = expandEnvReferences(
      buildLaneEnv(hostEnv, invoke.env, cfg, platform),
      platform,
    );
    const env = expansion.env;
    env[DEPTH_ENV] = String(request.depth + 1);

    // Exactly the same tag/header mechanism as the existing MCP-owned launcher. The tag remains
    // daemon-local; broker status exports only the measured traffic timestamps/counts.
    const activityTag = createLaneActivityTag();
    env["ANTHROPIC_CUSTOM_HEADERS"] = withLaneActivityHeader(
      env["ANTHROPIC_CUSTOM_HEADERS"],
      activityTag,
    );

    let stdoutBytes = 0;
    let stderrBytes = 0;
    let lastOutputAt: number | null = null;
    let run: LaneSpawnHandle;
    try {
      run = spawn(invoke.command, invoke.args, {
        env,
        cwd: request.cwd,
        timeoutMs: request.timeoutMs,
        onOutput: ({ stream, bytes }) => {
          if (stream === "stdout") stdoutBytes += bytes;
          else stderrBytes += bytes;
          lastOutputAt = now();
        },
      });
    } catch {
      return refuse("configured lane process could not be started");
    }

    const launchNotes = [
      ...expansion.notes,
      ...(agy === null ? [] : [agy.note]),
      ...(readOnlyBinding === undefined ? [] : [`read-only tools: ${readOnlyBinding}`]),
    ];

    return {
      result: run.result,
      cancel: run.kill,
      launchNotes,
      activity: async (): Promise<LaneExecutionActivity> => {
        let cpuMs: number | undefined;
        if (run.pids !== undefined) {
          try {
            const measured = await readProcessCpu(run.pids());
            if (measured !== null && Number.isFinite(measured) && measured >= 0) cpuMs = measured;
          } catch {
            // No CPU signal is weaker than a failed status request.
          }
        }

        const relay = readLaneActivity(activityTag);
        return {
          stdoutBytes,
          stderrBytes,
          lastOutputAt,
          ...(cpuMs === undefined ? {} : { cpuMs }),
          ...(relay === null
            ? {}
            : {
                relayInFlight: relay.inFlight,
                relayLastActivityAt: relay.lastActivityAt,
              }),
        };
      },
    };
  };
}
