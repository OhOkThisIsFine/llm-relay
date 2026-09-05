import { describe, it, expect } from "vitest";
import { join } from "node:path";
import { homedir, tmpdir } from "node:os";
import { defaultEnvPath } from "../src/dotenv.js";
import { getProbeCachePath } from "../src/ping/probe-cache.js";
import { getLaneManifestPath } from "../src/lane-manifest.js";
import { getRuntimeTelemetryPath } from "../src/ping/runtime-telemetry.js";
import { defaultRelayConfigDir } from "../src/control-authorization.js";
import { claudeHookPaths } from "../src/claude-hook.js";
import { resolveConfigPath } from "../src/cli.js";
import { defaultCatalogCachePath } from "../src/catalog.js";
import { defaultUpdateCachePath } from "../src/self-update.js";
import { getDispatchExhaustionPath } from "../src/dispatch-exhaustion-persistence.js";
import { getDispatchLaneStatsPath } from "../src/dispatch-lane-stats.js";

/**
 * The persistent-storage invariant, pinned mechanically: under vitest EVERY default resolver
 * returns a path under the temp root, never the developer's real `~/.llm-relay/`.
 *
 * Why a table rather than a test per artifact: seven of thirteen writable defaults honoured this
 * rule and six did not, and nothing noticed — `.env` was the sharpest, because `loadEnvFile`
 * READS it into `process.env`, so a test run on a machine that keeps keys there imported live
 * credentials rather than merely overwriting a cache. One table is what stops the next artifact
 * being added without a guard; it is the `test/destructive-coverage.test.ts` shape.
 *
 * ⚠ Every resolver still honours an EXPLICIT path (a caller-passed `path`, `home`, `cachePath`,
 * or `--config`). The guard binds the DEFAULT only; `claudeHookPaths` is covered for both below.
 *
 * ⚠ Assert with `join`, never a `/`-separated regex: on Windows `join` yields backslashes, so a
 * forward-slash pattern silently matches nothing and reads as a passing check.
 */
const VITEST_ROOT = join(tmpdir(), "llm-relay-vitest");
const REAL_ROOT = join(homedir(), ".llm-relay");

const DEFAULT_PATHS: ReadonlyArray<readonly [name: string, resolve: () => string, expected: string]> = [
  [".env — reads live credentials into process.env", defaultEnvPath, join(VITEST_ROOT, ".env")],
  ["probe-cache.json — health data the router ranks on", getProbeCachePath, join(VITEST_ROOT, "probe-cache.json")],
  ["lane-manifest.json — what a cli lane says it serves", getLaneManifestPath, join(VITEST_ROOT, "lane-manifest.json")],
  ["runtime-telemetry.json — observed real-world quality", getRuntimeTelemetryPath, join(VITEST_ROOT, "runtime-telemetry.json")],
  ["the relay config dir — holds the control-plane token", defaultRelayConfigDir, VITEST_ROOT],
  ["config.json — resolveConfigPath CREATES it when absent", resolveConfigPath, join(VITEST_ROOT, "config.json")],
  ["models-cache.json — the /models roster", defaultCatalogCachePath, join(VITEST_ROOT, "models-cache.json")],
  ["update-check.json — suppresses or forces an upgrade prompt", defaultUpdateCachePath, join(VITEST_ROOT, "update-check.json")],
  ["dispatch-exhaustion.json — ladder cooldowns re-learnable from host reports", getDispatchExhaustionPath, join(VITEST_ROOT, "dispatch-exhaustion.json")],
  ["dispatch-lane-stats.json — advisory per-lane run counts and wall-clocks", getDispatchLaneStatsPath, join(VITEST_ROOT, "dispatch-lane-stats.json")],
];

describe("persistent storage paths redirect under VITEST (invariant)", () => {
  it.each(DEFAULT_PATHS)("%s", (_name, resolve, expected) => {
    const path = resolve();
    expect(path).toBe(expected);
    expect(path.startsWith(REAL_ROOT)).toBe(false);
  });

  it("claudeHookPaths() redirects BOTH paths, and an explicit home still wins", () => {
    const { settings, script } = claudeHookPaths();
    expect(settings).toBe(join(VITEST_ROOT, ".claude", "settings.json"));
    expect(script).toBe(join(VITEST_ROOT, "hooks", "llm-relay-agent-offload.mjs"));
    expect(settings.startsWith(join(homedir(), ".claude"))).toBe(false);

    // The guard binds the DEFAULT only — an injected home is honoured exactly as before.
    const injected = claudeHookPaths(join(VITEST_ROOT, "injected-home"));
    expect(injected.settings).toBe(join(VITEST_ROOT, "injected-home", ".claude", "settings.json"));
    expect(injected.script).toBe(join(VITEST_ROOT, "injected-home", ".llm-relay", "hooks", "llm-relay-agent-offload.mjs"));
  });

  it("every listed resolver is distinct, so a copy-paste cannot make two artifacts share one file", () => {
    const paths = DEFAULT_PATHS.map(([, resolve]) => resolve());
    expect(new Set(paths).size).toBe(paths.length);
  });
});
