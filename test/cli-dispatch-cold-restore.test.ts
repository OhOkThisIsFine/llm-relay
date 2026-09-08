/**
 * The cold `llm-relay dispatch` path must restore ladder state into the config object it then
 * BUILDS THE VIEW FROM.
 *
 * ⚠ This is a source assertion, on the `test/config/routing-parser-is-a-leaf.test.ts` precedent,
 * because the property is invisible to an ordinary behavioural test: both ladder stores are keyed
 * per `Config` OBJECT through a `WeakMap`, so restoring into the wrong object fails SILENTLY — the
 * rows load, the restore reports a count, and the view simply never sees them.
 *
 * ⚠ It is not hypothetical. `runDispatch`'s fallback reloads the config from disk
 * (`loadConfigSafely()`) so a post-start edit is picked up, and the exhaustion restore above it
 * targeted the ORIGINAL `cfg` from the moment it was written. A cold dispatch therefore never
 * showed a restored cooldown whenever that reload succeeded, which is every ordinary run. It was
 * found on 2026-09-08 by running the real binary against a scratch HOME to check that a recorded
 * pin renders — it did not — and no test in the suite noticed.
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const SOURCE = readFileSync(join(process.cwd(), "src", "cli.ts"), "utf8");

describe("cold dispatch restores into the config it builds from", () => {
  it("reloads the config in the fallback path — the premise this rule exists for", () => {
    // If this line ever goes away the whole hazard goes with it, and this file should be revisited
    // rather than quietly kept passing.
    expect(SOURCE).toContain("const fallbackCfg = loadConfigSafely() ?? cfg;");
    expect(SOURCE).toContain("buildDispatch(fallbackCfg,");
  });

  it("restores EVERY ladder store into `fallbackCfg`, never the pre-reload `cfg`", () => {
    expect(SOURCE).toContain("restoreExhaustedRows(fallbackCfg, loadExhaustedRows());");
    expect(SOURCE).toContain("restoreLaneAffinityRows(fallbackCfg, loadLaneAffinityRows());");
    expect(SOURCE).toContain("restoreLaneStatsRows(fallbackCfg, loadLaneStatsRows());");
  });

  it("⚠ restores the same three on BOTH dispatch surfaces, not just one", () => {
    // Found by running the built binary: lane stats were restored on the reloading surface only,
    // so `llm-relay dispatch` reported a flat budget and "0 recorded runs" for a lane the daemon
    // knew had a full window. Two surfaces, one policy — this repository's recurring incident
    // shape, and it recurred here inside a single lap.
    for (const call of [
      "restoreExhaustedRows(cfg, loadExhaustedRows());",
      "restoreLaneAffinityRows(cfg, loadLaneAffinityRows());",
      "restoreLaneStatsRows(cfg, loadLaneStatsRows());",
    ]) {
      expect(SOURCE, call).toContain(call);
    }
  });

  it("⚠ the restores come BEFORE the view is built, or they cannot reach it", () => {
    const exhaustion = SOURCE.indexOf("restoreExhaustedRows(fallbackCfg,");
    const affinity = SOURCE.indexOf("restoreLaneAffinityRows(fallbackCfg,");
    const build = SOURCE.indexOf("buildDispatch(fallbackCfg,");
    expect(exhaustion).toBeGreaterThan(-1);
    expect(affinity).toBeGreaterThan(-1);
    expect(build).toBeGreaterThan(-1);
    expect(exhaustion).toBeLessThan(build);
    expect(affinity).toBeLessThan(build);
  });

  it("the OTHER dispatch surface uses one config throughout, so it restores into that one", () => {
    // `runDispatchCommand` never reloads, so `cfg` is correct there — the two sites differ on
    // purpose, and a reader comparing them should see why rather than assume one is a typo.
    expect(SOURCE).toContain("restoreExhaustedRows(cfg, loadExhaustedRows());");
    expect(SOURCE).toContain("restoreLaneAffinityRows(cfg, loadLaneAffinityRows());");
    expect(SOURCE).toContain("buildDispatch(cfg, {");
  });
});
