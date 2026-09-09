/**
 * The dispatch ladder's ROUTING MEMORY (`src/lane-affinity.ts`) and the ordering it drives in
 * `buildDispatch`.
 *
 * Four properties are pinned here, and each one is a rule this repository has broken before in a
 * different module:
 *
 * 1. A PIN PROMOTES, it never RESURRECTS — an unavailable lane carries no pin and is not selected.
 * 2. A DEMOTION reorders, it never DROPS — a demoted lane is still selectable when nothing else is.
 * 3. Both memories LAPSE, and a lapsed row is neither served nor persisted.
 * 4. A corrupt persisted row is dropped ALONE, never taking the file or a healthy lane down with
 *    it (the `lane-manifest.ts` regression, where shallow validation let a malformed entry EVICT a
 *    healthy rung).
 */
import { describe, it, expect, afterAll } from "vitest";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { loadConfig, type Config } from "../src/config.js";
import { buildDispatch, markExhausted } from "../src/dispatch.js";
import {
  DEFAULT_DEMOTE_MS,
  DEFAULT_OUTLIER_FACTOR,
  DEFAULT_OUTLIER_HISTORY_QUANTILE,
  DEFAULT_OUTLIER_RECENT_COUNT,
  LANE_AFFINITY_DEFAULT_TTL_MS,
  LANE_AFFINITY_KINDS,
  MAX_AFFINITY_MS,
  checkLaneOutlier,
  clearLaneAffinity,
  demoteLane,
  exportLaneAffinityRows,
  flushLaneAffinityPersistence,
  installLaneAffinityPersistence,
  laneDemotion,
  lanePin,
  loadLaneAffinityRows,
  outlierDemotionReason,
  pinLane,
  recordLaneOutlier,
  restoreLaneAffinityRows,
  saveLaneAffinityRows,
  type LaneAffinityKind,
  type LaneAffinityRow,
} from "../src/lane-affinity.js";
import { DEFAULT_DISPATCH_WALK_OUTLIER } from "../src/config/routing-parser.js";

const dir = mkdtempSync(join(tmpdir(), "llm-relay-lane-affinity-"));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

/** Three ready `cli` rungs, so ordering is observable without any lane being unavailable. */
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
          { id: "first", kind: "cli", command: "a", args: ["{task}"] },
          { id: "second", kind: "cli", command: "b", args: ["{task}"] },
          { id: "third", kind: "cli", command: "c", args: ["{task}"] },
        ],
      },
    }),
  );
  return loadConfig(path);
}

describe("lane affinity store", () => {
  it("recalls a pin and a demotion, keyed by tier", () => {
    const cfg = freshConfig();
    const now = 1_700_000_000_000;
    pinLane(cfg, "medium", "second", "answered in 3s", 60_000, now);
    expect(lanePin(cfg, "medium", "second", now)?.reason).toBe("answered in 3s");
    // ⚠ A different tier is a different ladder. Without this, one cheap success would steer every
    // reasoning level.
    expect(lanePin(cfg, "xhigh", "second", now)).toBeNull();
    expect(lanePin(cfg, null, "second", now)).toBeNull();
  });

  it("lapses on its own, and a lapsed row is not exported", () => {
    const cfg = freshConfig();
    const now = 1_700_000_000_000;
    pinLane(cfg, null, "first", "answered", 60_000, now);
    expect(lanePin(cfg, null, "first", now + 59_999)).not.toBeNull();
    expect(lanePin(cfg, null, "first", now + 60_000)).toBeNull();
    expect(exportLaneAffinityRows(cfg, now + 60_000)).toEqual([]);
  });

  it("clamps a window to the ceiling, and falls to the DEFAULT for a non-finite one", () => {
    const cfg = freshConfig();
    const now = 1_700_000_000_000;
    pinLane(cfg, null, "first", "answered", MAX_AFFINITY_MS * 10, now);
    expect(lanePin(cfg, null, "first", now)?.until).toBe(now + MAX_AFFINITY_MS);
    // ⚠ A nonsense duration falls to the DEFAULT, never to the ceiling: the fallback must resolve
    // to the WEAKER claim, and six hours is the stronger one.
    demoteLane(cfg, null, "second", "no answer", Number.NaN, now);
    expect(laneDemotion(cfg, null, "second", now)?.until).toBe(now + DEFAULT_DEMOTE_MS);
  });

  it("a later write REPLACES the earlier window rather than extending it", () => {
    const cfg = freshConfig();
    const now = 1_700_000_000_000;
    pinLane(cfg, null, "first", "answered in 9s", 600_000, now);
    pinLane(cfg, null, "first", "answered in 2s", 60_000, now + 1_000);
    const pin = lanePin(cfg, null, "first", now + 1_000);
    expect(pin?.reason).toBe("answered in 2s");
    expect(pin?.until).toBe(now + 1_000 + 60_000);
  });

  it("clears both memories for one lane on one tier, and touches no other", () => {
    const cfg = freshConfig();
    const now = 1_700_000_000_000;
    demoteLane(cfg, "medium", "first", "no answer", 60_000, now);
    demoteLane(cfg, "medium", "second", "no answer", 60_000, now);
    demoteLane(cfg, "high", "first", "no answer", 60_000, now);
    clearLaneAffinity(cfg, "medium", "first");
    expect(laneDemotion(cfg, "medium", "first", now)).toBeNull();
    expect(laneDemotion(cfg, "medium", "second", now)).not.toBeNull();
    expect(laneDemotion(cfg, "high", "first", now)).not.toBeNull();
  });
});

describe("lane affinity persistence", () => {
  it("round-trips live rows and refuses to restore a lapsed one", () => {
    const path = join(dir, `affinity-${Math.random().toString(36).slice(2)}.json`);
    const now = 1_700_000_000_000;
    const rows: LaneAffinityRow[] = [
      { tier: "medium", laneId: "first", kind: "pin", until: now + 60_000, reason: "answered" },
      { tier: "medium", laneId: "second", kind: "demote", until: now - 1, reason: "stale" },
    ];
    saveLaneAffinityRows(rows, { path });
    const cfg = freshConfig();
    // ⚠ FUTURE-ONLY. A preference recorded before a restart whose window has since passed is
    // history, not routing state — restoring it would resurrect an expired opinion.
    expect(restoreLaneAffinityRows(cfg, loadLaneAffinityRows({ path }), now)).toBe(1);
    expect(lanePin(cfg, "medium", "first", now)).not.toBeNull();
    expect(laneDemotion(cfg, "medium", "second", now)).toBeNull();
  });

  it("the shutdown flush writes a memory recorded inside the write-behind window", () => {
    // Until 2026-09-08 the installer's timer lived in a closure nothing could reach, so a pin or
    // demotion learned in the last two seconds before a graceful stop died with the process.
    const path = join(dir, `affinity-flush-${Math.random().toString(36).slice(2)}.json`);
    const now = Date.now();
    const cfg = freshConfig();
    installLaneAffinityPersistence(cfg, { path });
    pinLane(cfg, "medium", "first", "answered", 60_000, now);
    // Same tick: the debounced timer has not fired, so the file does not carry the row yet.
    expect(loadLaneAffinityRows({ path })).toEqual([]);

    expect(flushLaneAffinityPersistence()).toBeGreaterThanOrEqual(1);
    expect(loadLaneAffinityRows({ path }).map((row) => [row.laneId, row.kind])).toEqual([["first", "pin"]]);
    // Nothing is dirty any more: a second shutdown pass writes nothing for this store.
    expect(flushLaneAffinityPersistence()).toBe(0);
  });

  it("⚠ CLAMPS a restored row to the ceiling — the write path is not the only entrance", () => {
    // ⚠ `clampWindow` bounded what this process RECORDS, while the restore admitted whatever the
    // file said. So a hand-edited or corrupt `lane-affinity.json` could park a lane pinned for
    // years, past the six-hour ceiling this module states as its own rule, silently — a memory
    // leaves no trace by design. The clamp CORRECTS rather than rejecting, the same direction
    // `clampWindow` takes for a nonsense duration on the write side.
    const path = join(dir, `affinity-${Math.random().toString(36).slice(2)}.json`);
    const now = 1_700_000_000_000;
    const century = now + MAX_AFFINITY_MS * 10_000;
    saveLaneAffinityRows([{ tier: null, laneId: "first", kind: "pin", until: century, reason: "forever" }], { path });
    const cfg = freshConfig();
    expect(restoreLaneAffinityRows(cfg, loadLaneAffinityRows({ path }), now)).toBe(1);
    expect(lanePin(cfg, null, "first", now)?.until).toBe(now + MAX_AFFINITY_MS);
    // And it therefore lapses on schedule instead of never.
    expect(lanePin(cfg, null, "first", now + MAX_AFFINITY_MS)).toBeNull();
  });

  it("a restored row INSIDE the ceiling keeps its own expiry untouched", () => {
    // Negative control: the clamp must not rewrite an ordinary row.
    const path = join(dir, `affinity-${Math.random().toString(36).slice(2)}.json`);
    const now = 1_700_000_000_000;
    saveLaneAffinityRows([{ tier: null, laneId: "second", kind: "demote", until: now + 60_000, reason: "ok" }], { path });
    const cfg = freshConfig();
    expect(restoreLaneAffinityRows(cfg, loadLaneAffinityRows({ path }), now)).toBe(1);
    expect(laneDemotion(cfg, null, "second", now)?.until).toBe(now + 60_000);
  });

  it("never overwrites what the live process already learned", () => {
    const path = join(dir, `affinity-${Math.random().toString(36).slice(2)}.json`);
    const now = 1_700_000_000_000;
    saveLaneAffinityRows([{ tier: null, laneId: "first", kind: "pin", until: now + 60_000, reason: "from disk" }], {
      path,
    });
    const cfg = freshConfig();
    pinLane(cfg, null, "first", "learned live", 60_000, now);
    expect(restoreLaneAffinityRows(cfg, loadLaneAffinityRows({ path }), now)).toBe(0);
    expect(lanePin(cfg, null, "first", now)?.reason).toBe("learned live");
  });

  it("drops ONE malformed row and keeps the rest", () => {
    const path = join(dir, `affinity-${Math.random().toString(36).slice(2)}.json`);
    const now = 1_700_000_000_000;
    writeFileSync(
      path,
      JSON.stringify({
        version: 1,
        rows: [
          { tier: null, laneId: "first", kind: "pin", until: now + 60_000, reason: "good" },
          { tier: null, laneId: "second", kind: "teleport", until: now + 60_000, reason: "bad kind" },
          { tier: null, laneId: "third", kind: "demote", until: "soon", reason: "bad until" },
        ],
      }),
    );
    const loaded = loadLaneAffinityRows({ path });
    expect(loaded).toHaveLength(1);
    expect(loaded[0]?.laneId).toBe("first");
  });

  it("restores NOTHING from a wrong version or an unreadable file, and never throws", () => {
    const bad = join(dir, `affinity-bad-${Math.random().toString(36).slice(2)}.json`);
    writeFileSync(bad, JSON.stringify({ version: 99, rows: [{ tier: null, laneId: "x", kind: "pin", until: 1, reason: "" }] }));
    expect(loadLaneAffinityRows({ path: bad })).toEqual([]);
    expect(loadLaneAffinityRows({ path: join(dir, "does-not-exist.json") })).toEqual([]);
  });
});

describe("buildDispatch ordering reads the routing memory", () => {
  it("orders a pinned lane FIRST, whatever its ladder position", () => {
    const cfg = freshConfig();
    pinLane(cfg, null, "third", "answered in 4s");
    const view = buildDispatch(cfg);
    expect(view.order).toEqual(["third", "first", "second"]);
    expect(view.next?.id).toBe("third");
    expect(view.reason).toContain("pinned");
    expect(view.ladder.find((l) => l.id === "third")?.pinned?.reason).toBe("answered in 4s");
  });

  it("orders a demoted lane LAST but never drops it", () => {
    const cfg = freshConfig();
    demoteLane(cfg, null, "first", "no answer within the 90s walk budget");
    const view = buildDispatch(cfg);
    expect(view.order).toEqual(["second", "third", "first"]);
    // ⚠ Still present, still selectable. Health demotes; it never drops.
    expect(view.order).toContain("first");
    expect(view.ladder.find((l) => l.id === "first")?.demoted?.reason).toContain("walk budget");
  });

  it("serves a demoted lane when EVERY ready lane is demoted", () => {
    const cfg = freshConfig();
    for (const id of ["first", "second", "third"]) demoteLane(cfg, null, id, "no answer");
    const view = buildDispatch(cfg);
    expect(view.order).toEqual(["first", "second", "third"]);
    expect(view.next?.id).toBe("first");
    expect(view.reason).toContain("every ready lane is demoted");
  });

  it("⚠ a pin PROMOTES but never RESURRECTS: an exhausted lane carries none and is not selected", () => {
    const cfg = freshConfig();
    pinLane(cfg, null, "third", "answered earlier");
    markExhausted(cfg, "third", 60_000);
    const view = buildDispatch(cfg);
    expect(view.ladder.find((l) => l.id === "third")?.state).toBe("exhausted");
    expect(view.ladder.find((l) => l.id === "third")?.pinned).toBeUndefined();
    expect(view.order).toEqual(["first", "second"]);
    expect(view.next?.id).toBe("first");
  });

  it("a lane carrying BOTH memories ranks as pinned — the pin is the more recent evidence", () => {
    const cfg = freshConfig();
    demoteLane(cfg, null, "third", "no answer");
    pinLane(cfg, null, "third", "answered on the retry");
    expect(buildDispatch(cfg).order[0]).toBe("third");
  });

  it("with no memory at all, the order is exactly the configured ladder", () => {
    const cfg = freshConfig();
    const view = buildDispatch(cfg);
    expect(view.order).toEqual(["first", "second", "third"]);
    expect(view.next?.id).toBe("first");
    expect(view.reason).toBe("first lane in the ladder");
  });

  it("puts the memory on the LANE as an ISO instant, so a renderer needs no clock of its own", () => {
    // The rendering of these two fields is covered where the renderers live
    // (`test/dispatch-lane-stats-view.test.ts`, `dispatch_lanes`). What belongs here is the SHAPE
    // the view hands them: an absolute ISO instant rather than a remaining duration, so a surface
    // printing it never has to know what time it is — the same reason `readyAt` is an instant.
    // ⚠ Recorded on the REAL clock, deliberately. `buildDispatch` reads `Date.now()`, so a memory
    // written at a synthetic past instant has already lapsed by the time the view annotates it —
    // which is correct behaviour, and it is why the expected instant is read back from the STORE
    // rather than computed from a fixture time.
    const cfg = freshConfig();
    pinLane(cfg, null, "third", "answered in 4s", 60_000);
    demoteLane(cfg, null, "first", "no answer within the 90s walk budget", 60_000);
    const pin = lanePin(cfg, null, "third");
    const demotion = laneDemotion(cfg, null, "first");
    expect(pin, "the pin must still be live").not.toBeNull();
    expect(demotion, "the demotion must still be live").not.toBeNull();

    const ladder = buildDispatch(cfg).ladder;
    expect(ladder.find((l) => l.id === "third")?.pinned).toEqual({
      until: new Date(pin!.until).toISOString(),
      reason: "answered in 4s",
    });
    expect(ladder.find((l) => l.id === "first")?.demoted).toEqual({
      until: new Date(demotion!.until).toISOString(),
      reason: "no answer within the 90s walk budget",
    });
  });

  it("⚠ a memory written in the PAST is already lapsed and never annotates the ladder", () => {
    // The negative control for the test above, and a real property: the store lapses on read, so a
    // stale row cannot reappear on a surface. Written at a 2023 instant with a one-minute window.
    const cfg = freshConfig();
    pinLane(cfg, null, "third", "answered long ago", 60_000, 1_700_000_000_000);
    expect(buildDispatch(cfg).ladder.find((l) => l.id === "third")?.pinned).toBeUndefined();
    expect(buildDispatch(cfg).order).toEqual(["first", "second", "third"]);
  });

  it("a host override wins over a pin, and `order` is that ONE lane", () => {
    const cfg = freshConfig();
    pinLane(cfg, null, "third", "answered");
    const view = buildDispatch(cfg, { lane: "second" });
    expect(view.next?.id).toBe("second");
    // ⚠ A walking caller must honour the override too. Walking past it would defeat the override
    // just as silently as ignoring it.
    expect(view.order).toEqual(["second"]);
  });
});

/**
 * The one-line `reason` the ladder view and the CLI both print is a CLAIM about the ordering code.
 * Two of its branches described behaviour `rankSelectable` does not implement (found by adversarial
 * review, 2026-09-08). These pin the corrected wording against the code that produces it.
 */
describe("the selection reason states what the ordering actually did", () => {
  it("⚠ does NOT claim recency among demoted lanes — nothing consults a timestamp", () => {
    const cfg = freshConfig();
    // Demote `second` five minutes ago, then `first` and `third` now. Under the old wording the
    // answer named `first` and called it "the least recently demoted", which is precisely
    // backwards: it is the MOST recently demoted, and it leads only because it is earlier in the
    // configured ladder. ⚠ The older row needs a window long enough to still be LIVE — `remember`
    // stores `now + ttlMs`, so a 60 s window recorded five minutes ago has already lapsed, and a
    // lapsed row is deleted on read.
    demoteLane(cfg, null, "second", "missed budget", 600_000, Date.now() - 5 * 60_000);
    demoteLane(cfg, null, "first", "missed budget", 600_000, Date.now());
    demoteLane(cfg, null, "third", "missed budget", 600_000, Date.now());
    const view = buildDispatch(cfg);
    expect(view.next?.id).toBe("first");
    expect(view.reason).not.toContain("least recently demoted");
    expect(view.reason).toContain("first among them in the ladder");
  });

  it("⚠ does NOT call a ready-but-demoted lane unavailable", () => {
    const cfg = freshConfig();
    // `first` is demoted but perfectly READY, so `second` leads. The old wording reported
    // "1 ahead of it unavailable" — reporting an available lane as unavailable.
    demoteLane(cfg, null, "first", "missed budget", 60_000);
    const view = buildDispatch(cfg);
    expect(view.next?.id).toBe("second");
    expect(view.reason).not.toContain("unavailable");
    expect(view.reason).toContain("ready but demoted");
  });

  it("still reports a genuinely unavailable lane as unavailable", () => {
    // Negative control: the correction must not blind the message to the real case.
    const cfg = freshConfig();
    markExhausted(cfg, "first", 60_000);
    const view = buildDispatch(cfg);
    expect(view.next?.id).toBe("second");
    expect(view.reason).toContain("1 ahead of it unavailable");
    expect(view.reason).not.toContain("ready but demoted");
  });
});

describe("routing.dispatchWalk: false restores the pre-walk behaviour exactly", () => {
  /** The same three-rung ladder, with the walk explicitly OFF. */
  function walkOffConfig(): Config {
    const path = join(dir, `config-off-${Math.random().toString(36).slice(2)}.json`);
    writeFileSync(
      path,
      JSON.stringify({
        listen: "127.0.0.1:8791",
        providers: {
          anthropic: { base: "https://api.anthropic.com", kind: "anthropic", credentialMode: "passthrough" },
        },
        routing: {
          default: "anthropic",
          dispatchWalk: false,
          ladder: [
            { id: "first", kind: "cli", command: "a", args: ["{task}"] },
            { id: "second", kind: "cli", command: "b", args: ["{task}"] },
            { id: "third", kind: "cli", command: "c", args: ["{task}"] },
          ],
        },
      }),
    );
    return loadConfig(path);
  }

  it("⚠ a memory restored from disk no longer reorders the ladder once the walk is off", () => {
    // ⚠⚠ `recordLaneAffinity` already declined to WRITE with the walk off, but rows written while
    // it was on are restored at startup, and `annotateAffinity` read them regardless. So the
    // documented byte-for-byte revert was not one: an operator who turned the walk off got the old
    // behaviour only after every surviving memory lapsed — up to the six-hour clamp.
    const cfg = walkOffConfig();
    pinLane(cfg, null, "third", "answered in 4s", 60_000);
    demoteLane(cfg, null, "first", "missed budget", 60_000);
    const view = buildDispatch(cfg);
    expect(view.order).toEqual(["first", "second", "third"]);
    expect(view.next?.id).toBe("first");
    expect(view.ladder.find((l) => l.id === "third")?.pinned).toBeUndefined();
    expect(view.ladder.find((l) => l.id === "first")?.demoted).toBeUndefined();
    expect(view.reason).toBe("first lane in the ladder");
  });

  it("negative control: the same memories DO reorder while the walk is on", () => {
    const cfg = freshConfig();
    pinLane(cfg, null, "third", "answered in 4s", 60_000);
    demoteLane(cfg, null, "first", "missed budget", 60_000);
    expect(buildDispatch(cfg).order).toEqual(["third", "second", "first"]);
  });
});

/**
 * The default window per memory kind is ONE total table, so a third memory kind
 * is a compile error AT THE TABLE rather than a silent drop at a loader (the
 * closed-union gotcha in CLAUDE.md — the `buildAuthHeaders` precedent).
 */
describe("the per-kind default window has one total owner", () => {
  it("covers every member of LANE_AFFINITY_KINDS with a finite positive window, and nothing else", () => {
    const table = LANE_AFFINITY_DEFAULT_TTL_MS as Record<LaneAffinityKind, number>;
    expect(new Set(Object.keys(table))).toEqual(new Set(LANE_AFFINITY_KINDS));
    for (const kind of LANE_AFFINITY_KINDS) {
      expect(table[kind]).toEqual(expect.any(Number));
      expect(Number.isFinite(table[kind])).toBe(true);
      expect(table[kind]).toBeGreaterThan(0);
    }
  });

  it("has ONE definition — the expiry clamp must not hand-roll the per-kind default", () => {
    // The `destructive-coverage` precedent: pin the single owner mechanically, so the next
    // person to add a kind cannot reintroduce the per-kind branch.
    const text = readFileSync(join(__dirname, "..", "src", "lane-affinity.ts"), "utf8");
    expect(text).toMatch(/satisfies Record<LaneAffinityKind,/);
  });
});

describe("recent-versus-earlier outlier demotion (backlog item 9)", () => {
  const SETTINGS = {
    recentCount: 5,
    historyQuantile: 0.8,
    outlierFactor: 2.5,
    minSamples: 5,
  };
  /** Twenty 100 s runs, then five 600 s runs — a lane that fell off a cliff. */
  const CLIFF = [...new Array<number>(20).fill(100_000), ...new Array<number>(5).fill(600_000)];

  it("demotes a lane whose recent median exceeds its own history p80 by the factor, naming both figures", () => {
    const hit = checkLaneOutlier(CLIFF, SETTINGS);
    expect(hit).not.toBeNull();
    expect(hit).toMatchObject({ recentMedianMs: 600_000, historyMs: 100_000 });
    const reason = outlierDemotionReason(hit!, {
      historyQuantile: SETTINGS.historyQuantile,
      outlierFactor: SETTINGS.outlierFactor,
    });
    expect(reason).toContain("600 s");
    expect(reason).toContain("100 s");
  });

  it("records the demotion through the shared entry, on the same tier and window", () => {
    const cfg = freshConfig();
    const now = 1_700_000_000_000;
    const reason = recordLaneOutlier(cfg, "medium", "second", CLIFF, { ...SETTINGS }, { minSamples: SETTINGS.minSamples, demoteMs: 60_000 }, now);
    expect(reason).not.toBeNull();
    expect(laneDemotion(cfg, "medium", "second", now)?.reason).toBe(reason);
    // Another tier is another ladder: it learned nothing about `xhigh`.
    expect(laneDemotion(cfg, "xhigh", "second", now)).toBeNull();
  });

  it("is silent when the history half is too thin — unmeasured is no opinion", () => {
    // The same five slow recent runs, but only three earlier ones: no distribution to judge by.
    const thin = [...new Array<number>(3).fill(100_000), ...new Array<number>(5).fill(600_000)];
    expect(checkLaneOutlier(thin, SETTINGS)).toBeNull();
    const cfg = freshConfig();
    expect(recordLaneOutlier(cfg, null, "first", thin, { ...SETTINGS }, { minSamples: SETTINGS.minSamples, demoteMs: 60_000 })).toBeNull();
    expect(laneDemotion(cfg, null, "first")).toBeNull();
  });

  it("`outlier: false` makes the rule inert and leaves the pin alone", () => {
    const cfg = freshConfig();
    const now = 1_700_000_000_000;
    pinLane(cfg, null, "first", "answered in 2s", 60_000, now);
    expect(recordLaneOutlier(cfg, null, "first", CLIFF, false, { minSamples: SETTINGS.minSamples, demoteMs: 60_000 }, now)).toBeNull();
    expect(laneDemotion(cfg, null, "first", now)).toBeNull();
    expect(lanePin(cfg, null, "first", now)?.reason).toBe("answered in 2s");
  });

  it("a demotion here retracts an existing pin, through the shared entry", () => {
    // The walk demotion already retracts the pin this way (`recordLaneAffinity` clears first);
    // the outlier demotion goes through the same entry, so a lane that answered and THEN slowed
    // does not keep a stale pin beside its demotion.
    const cfg = freshConfig();
    const now = 1_700_000_000_000;
    pinLane(cfg, null, "first", "answered in 2s", 60_000, now);
    recordLaneOutlier(cfg, null, "first", CLIFF, { ...SETTINGS }, { minSamples: SETTINGS.minSamples, demoteMs: 60_000 }, now);
    expect(lanePin(cfg, null, "first", now)).toBeNull();
    expect(laneDemotion(cfg, null, "first", now)).not.toBeNull();
  });

  it("a steady lane is not an outlier — the recent median sits inside its own history", () => {
    const steady = [...new Array<number>(20).fill(100_000), ...new Array<number>(5).fill(110_000)];
    expect(checkLaneOutlier(steady, SETTINGS)).toBeNull();
  });

  it("the parser default and the rule default are one number, pinned together", () => {
    // `routing-parser.ts` is a leaf (it imports `config-types.js` and `spec.js` and nothing
    // else), so the outlier defaults are hand-copied there rather than imported — and a
    // hand-copied number drifts silently. This pins the two sides together: changing one
    // without the other fails here, not in production as a halved demotion threshold.
    expect(DEFAULT_DISPATCH_WALK_OUTLIER).toEqual({
      recentCount: DEFAULT_OUTLIER_RECENT_COUNT,
      historyQuantile: DEFAULT_OUTLIER_HISTORY_QUANTILE,
      outlierFactor: DEFAULT_OUTLIER_FACTOR,
    });
  });
});
