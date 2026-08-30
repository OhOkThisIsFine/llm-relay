/**
 * The ladder's exhaustion state must survive a relay restart.
 *
 * `dispatch.ts` held host-reported cooldowns in memory only, while the report route accepts
 * vendor-stated cooldowns up to 30 days — exactly the rows a restart must not forget: a lane
 * recorded dead-until-a-date came back the moment the process bounced, and hosts walked back
 * into the wall. Loss is fail-open (the lane is retried, not parked), so the stakes are spend,
 * not availability — but the fix follows `breaker-persistence.ts` exactly.
 *
 * ⚠ Every test here uses an explicit temp path — same rule as the breaker suite.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  CURRENT_DISPATCH_EXHAUSTION_VERSION,
  getDispatchExhaustionPath,
  installDispatchExhaustionPersistence,
  loadExhaustedRows,
  saveExhaustedRows,
} from "../src/dispatch-exhaustion-persistence.js";
import {
  clearExhaustedKey,
  exportExhaustedRows,
  markExhausted,
  markExhaustedKey,
  restoreExhaustedRows,
} from "../src/dispatch.js";
import { loadConfig, type Config } from "../src/config.js";

const HOUR = 3_600_000;

let dir: string;
let statePath: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "llm-relay-dispatch-exh-"));
  statePath = join(dir, "dispatch-exhaustion.json");
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

/** A fresh Config per call: exhaustion state is per-Config, so this IS the "restart". */
function freshConfig(): Config {
  const path = join(dir, `config-${Math.random().toString(36).slice(2)}.json`);
  writeFileSync(
    path,
    JSON.stringify({
      listen: "127.0.0.1:8791",
      providers: { anthropic: { base: "https://api.anthropic.com", kind: "anthropic", credentialMode: "passthrough" } },
      routing: {
        default: "anthropic",
        ladder: [
          { id: "codex-sol", kind: "cli", quota: "codex-sol", command: "codex", args: ["exec", "{task}"] },
          { id: "anthropic", kind: "relay", spec: "anthropic" },
        ],
      },
    }),
  );
  return loadConfig(path);
}

describe("dispatch exhaustion persistence", () => {
  it("redirects its default path under vitest", () => {
    expect(getDispatchExhaustionPath()).toContain("llm-relay-vitest");
  });

  it("round-trips still-future rows and drops lapsed ones at load", () => {
    const now = 1_000_000_000_000;
    saveExhaustedRows(
      [
        { key: "quota:codex-sol", until: now + HOUR },
        { key: "rung:lapsed", until: now - 1 },
      ],
      { path: statePath },
    );
    const rows = loadExhaustedRows({ path: statePath, now });
    expect(rows).toEqual([{ key: "quota:codex-sol", until: now + HOUR }]);
  });

  it("⚠ restores NOTHING from a corrupt file, wrong version, or wrong envelope", () => {
    const now = 1_000_000_000_000;
    writeFileSync(statePath, "not json");
    expect(loadExhaustedRows({ path: statePath, now })).toEqual([]);
    writeFileSync(statePath, JSON.stringify({ version: 999, rows: [{ key: "x", until: now + HOUR }] }));
    expect(loadExhaustedRows({ path: statePath, now })).toEqual([]);
    writeFileSync(statePath, JSON.stringify({ version: CURRENT_DISPATCH_EXHAUSTION_VERSION, rows: "nope" }));
    expect(loadExhaustedRows({ path: statePath, now })).toEqual([]);
  });

  it("⚠ drops ONE malformed row without taking the file down", () => {
    // The lane-manifest shallow-validation regression, pinned here too: a bad row must cost
    // itself, never the healthy rows beside it.
    const now = 1_000_000_000_000;
    writeFileSync(
      statePath,
      JSON.stringify({
        version: CURRENT_DISPATCH_EXHAUSTION_VERSION,
        rows: [
          { key: "quota:good", until: now + HOUR },
          { key: 5, until: now + HOUR },
          { key: "quota:bad-until", until: "soon" },
          null,
        ],
      }),
    );
    expect(loadExhaustedRows({ path: statePath, now })).toEqual([{ key: "quota:good", until: now + HOUR }]);
  });

  it("carries a marked lane across a restart, future rows only", () => {
    // Anchored to the REAL clock: `markExhausted` stamps with Date.now() internally, so a fixed
    // fake epoch here would make the row read as decades in the future.
    const now = Date.now();
    const before = freshConfig();
    installDispatchExhaustionPersistence(before, { path: statePath, now: () => now });
    expect(markExhausted(before, "codex-sol", 2 * HOUR)).toBe(true);
    // The write-behind timer is debounced, so force the flush the way a shutdown would.
    saveExhaustedRows(exportExhaustedRows(before, now), { path: statePath });

    // ── restart ─────────────────────────────────────────────────────────────────────────────
    const after = freshConfig();
    const restored = installDispatchExhaustionPersistence(after, { path: statePath, now: () => now + HOUR });
    expect(restored).toBe(1);
    const rows = exportExhaustedRows(after, now + HOUR);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.key).toBe("quota:codex-sol");

    // Past its expiry nothing is restored — a lapsed death may never resurrect.
    const later = freshConfig();
    expect(installDispatchExhaustionPersistence(later, { path: statePath, now: () => now + 3 * HOUR })).toBe(0);
    expect(exportExhaustedRows(later, now + 3 * HOUR)).toEqual([]);
  });

  it("⚠ restore never overwrites a cooldown the live process already learned", () => {
    const now = 1_000_000_000_000;
    const cfg = freshConfig();
    markExhaustedKey(cfg, "quota:codex-sol", now + 5_000, now);
    const restored = restoreExhaustedRows(cfg, [{ key: "quota:codex-sol", until: now + HOUR }], now);
    expect(restored).toBe(0);
    expect(exportExhaustedRows(cfg, now)).toEqual([{ key: "quota:codex-sol", until: now + 5_000 }]);
  });

  it("flushes mutations through the change listener (debounced), including retraction", async () => {
    const now = Date.now();
    const cfg = freshConfig();
    installDispatchExhaustionPersistence(cfg, { path: statePath });
    markExhaustedKey(cfg, "quota:codex-sol", now + HOUR, now);
    clearExhaustedKey(cfg, "quota:codex-sol");
    // DEFAULT_FLUSH_DELAY_MS is 250ms; wait past it so the LAST state (cleared) is on disk —
    // a retraction that never reached disk would resurrect the death on the next restart.
    await new Promise((resolve) => setTimeout(resolve, 700));
    expect(loadExhaustedRows({ path: statePath, now })).toEqual([]);
  });
});
