/**
 * The hedge trigger's decision layer.
 *
 * ⚠ This module has NO `src/` caller yet, by design — the walk integration is stage 2. So these
 * tests are the only thing holding its behaviour, and the interesting assertions are the ones
 * about NOT hedging: hedging duplicates a request onto free quota, so every bound that keeps the
 * duplicate rate down is a case where it must do nothing.
 *
 * The two rules most worth reading before changing anything here:
 *  - probe samples must never reach the per-token statistic, and request samples must never reach
 *    the absolute one (the v0.65.2 defect, in both directions);
 *  - an UNMEASURED deployment IS hedged, which is the opposite of `latency-demotion.ts`, and the
 *    asymmetry is deliberate — see the module comment.
 */
import { describe, it, expect } from "vitest";
import type { PingRecord } from "../src/ping/metrics.js";
import {
  DEFAULT_HEDGE_FLOOR_MS,
  DEFAULT_HEDGE_MARGIN,
  DEFAULT_HEDGE_MIN_SAMPLES,
  hedgeLabel,
  resolveHedgeSettings,
  shouldHedge,
  type HedgeSettings,
} from "../src/hedge-trigger.js";

const S: HedgeSettings = resolveHedgeSettings();

/** n PROBE samples at `ms` — no token count, so they can never reach the per-token statistic. */
function probes(n: number, ms: number, code = "200"): PingRecord[] {
  return Array.from({ length: n }, (_, i) => ({ ms, code, timestamp: 1000 + i }));
}

/** n REQUEST samples, each generating `tokens` output tokens in `ms`. */
function requests(n: number, ms: number, tokens: number): PingRecord[] {
  return Array.from({ length: n }, (_, i) => ({
    ms,
    code: "200",
    timestamp: 2000 + i,
    tokens,
    source: "request" as const,
  }));
}

function ask(o: Partial<{ elapsedMs: number; tokensSeen: number; pings: PingRecord[]; isFree: boolean }>, s = S) {
  return shouldHedge(
    { elapsedMs: o.elapsedMs ?? 0, tokensSeen: o.tokensSeen ?? 0, pings: o.pings ?? [], isFree: o.isFree ?? true },
    s,
  );
}

describe("hedge trigger — the containment, which matters more than the firing", () => {
  it("NEVER hedges a deployment that is not free", () => {
    // Owner decision D1. `assessCost()` treats unknown as paid, so this is the fail-safe direction:
    // a duplicate can never land on a deployment whose price we could not establish.
    expect(ask({ elapsedMs: 600_000, isFree: false })).toBeNull();
  });

  it("NEVER hedges when the operator switched it off", () => {
    expect(ask({ elapsedMs: 600_000 }, resolveHedgeSettings({ enabled: false }))).toBeNull();
  });

  it("NEVER hedges below the floor, however little is known about the deployment", () => {
    // Without a floor a fast pool would duplicate nearly every request.
    expect(ask({ elapsedMs: DEFAULT_HEDGE_FLOOR_MS })).toBeNull();
    expect(ask({ elapsedMs: DEFAULT_HEDGE_FLOOR_MS - 1 })).toBeNull();
  });

  it("NEVER hedges on a nonsense elapsed time", () => {
    expect(ask({ elapsedMs: Number.NaN })).toBeNull();
    expect(ask({ elapsedMs: -1 })).toBeNull();
    expect(ask({ elapsedMs: Number.POSITIVE_INFINITY })).toBeNull();
  });
});

describe("hedge trigger — per-token, the owner's rule", () => {
  it("gives a fast deployment MORE time as its answer grows", () => {
    // 8 request samples at 50 ms/token. At 2000 tokens seen the expected cost is 100 s, doubled by
    // the margin to 200 s — so 150 s of elapsed time is NOT slow for an answer that long.
    const pings = requests(8, 5_000, 100); // 50 ms/token
    expect(ask({ elapsedMs: 150_000, tokensSeen: 2_000, pings })).toBeNull();
    // The same deployment producing only 10 tokens in 150 s IS slow: expected 500 ms, floor 20 s.
    const d = ask({ elapsedMs: 150_000, tokensSeen: 10, pings });
    expect(d?.basis).toBe("per-token");
    expect(d?.tokensSeen).toBe(10);
  });

  it("is FINAL when it has evidence — a healthy rate is not re-judged by the absolute bar", () => {
    // The lesson v0.65.2 was built on. Probes here are slow (p90 70 s) and would demote on the
    // absolute rung, but per-token says this answer is exactly as long as it should be.
    const pings = [...requests(8, 5_000, 100), ...probes(8, 70_000)];
    expect(ask({ elapsedMs: 150_000, tokensSeen: 2_000, pings })).toBeNull();
  });

  it("does NOT use per-token below the sample floor, however slow the attempt", () => {
    // 4 request samples is under `minSamples`, so the rate is not trusted; it falls to the probe
    // rung, and with no probes to the floor.
    const d = ask({ elapsedMs: 600_000, tokensSeen: 2_000, pings: requests(DEFAULT_HEDGE_MIN_SAMPLES - 1, 5_000, 100) });
    expect(d?.basis).toBe("floor");
  });

  it("does NOT use per-token when the attempt has produced nothing yet", () => {
    // The hang this feature exists for: no tokens, so no per-token allowance can accrue.
    const d = ask({ elapsedMs: 100_000, tokensSeen: 0, pings: requests(8, 5_000, 100) });
    expect(d?.basis).not.toBe("per-token");
  });
});

describe("hedge trigger — the absolute rung reads PROBE samples only", () => {
  it("uses probe p90 when there is no per-token evidence", () => {
    // p90 of 8 identical 4000 ms probes is 4000; margin 2 gives 8000, floored to 20000.
    expect(ask({ elapsedMs: 19_999, pings: probes(8, 4_000) })).toBeNull();
    const d = ask({ elapsedMs: 25_000, pings: probes(8, 4_000) });
    expect(d?.basis).toBe("absolute");
    expect(d?.thresholdMs).toBe(DEFAULT_HEDGE_FLOOR_MS);
  });

  it("raises the bar for a deployment whose PROBES are genuinely slow", () => {
    const d = ask({ elapsedMs: 100_000, pings: probes(8, 30_000) });
    expect(d?.basis).toBe("absolute");
    expect(d?.thresholdMs).toBe(30_000 * DEFAULT_HEDGE_MARGIN);
  });

  it("NEVER lets request samples raise the absolute bar", () => {
    // The v0.65.2 defect facing the other way. Four probes at 1 s and four 90-second REQUEST
    // samples: if the requests reached this statistic the bar would be 180 s and nothing would
    // hedge. They must not, so this falls through to the floor — four probes is under the floor of
    // five — and 30 s exceeds it.
    const pings = [...probes(4, 1_000), ...requests(4, 90_000, 1)];
    const d = ask({ elapsedMs: 30_000, pings });
    expect(d?.basis).toBe("floor");
  });

  it("counts PROBE samples toward its own floor, so request samples cannot unlock it", () => {
    const pings = [...probes(4, 30_000), ...requests(10, 1_000, 1_000)];
    // Ten request samples must not make the four probes count as nine.
    const d = ask({ elapsedMs: 25_000, tokensSeen: 0, pings });
    expect(d?.basis).toBe("floor");
  });

  it("counts only MEASURABLE probes toward its floor, so one 200 among failures cannot unlock it", () => {
    // ⚠ The floor must count the same set `getP90` measures. `MEASURABLE_CODES` is a LATENCY set
    // (200/401), so four 503s carry no latency at all: they leave p90 resting on ONE sample.
    // Four failures plus one slow 200 is five records but one measurement.
    const pings = [...probes(4, 1_000, "503"), ...probes(1, 30_000)];
    const d = ask({ elapsedMs: 30_000, tokensSeen: 0, pings });
    // Counting all five reaches the absolute rung, and p90 over the single 200 sets the bar at
    // 60 s — so a 30 s hang is NOT hedged, on the strength of one probe. The floor is the honest
    // answer: one measurement is below `minSamples`, so no per-deployment statistic applies.
    expect(d?.basis).toBe("floor");
    expect(d?.thresholdMs).toBe(DEFAULT_HEDGE_FLOOR_MS);
  });
});

describe("hedge trigger — an UNMEASURED deployment is hedged, unlike demotion", () => {
  /**
   * ⚠ The opposite of `latency-demotion.ts`, deliberately. Demotion punishes, so unmeasured must
   * mean no opinion. A hedge only starts an attempt the walk was going to make anyway: the cost of
   * hedging a deployment that was about to answer is one wasted FREE request, and the cost of not
   * hedging the measured 43-times-repeated hang is 120 seconds.
   */
  it("falls back to the floor with no samples at all", () => {
    const d = ask({ elapsedMs: DEFAULT_HEDGE_FLOOR_MS + 1, pings: [] });
    expect(d?.basis).toBe("floor");
    expect(d?.thresholdMs).toBe(DEFAULT_HEDGE_FLOOR_MS);
  });

  it("covers the measured hang: no headers, no tokens, nothing known", () => {
    // `nim/deepseek-ai/deepseek-v4-flash-0731` produced nothing for 120 s, 43 times running.
    const d = ask({ elapsedMs: 120_000, tokensSeen: 0, pings: [] });
    expect(d?.basis).toBe("floor");
    expect(d?.elapsedMs).toBe(120_000);
  });
});

describe("hedge trigger — settings and label", () => {
  it("defaults to enabled, because D1 put the containment on cost rather than on a flag", () => {
    expect(resolveHedgeSettings().enabled).toBe(true);
    expect(resolveHedgeSettings({}).enabled).toBe(true);
    expect(resolveHedgeSettings({ enabled: false }).enabled).toBe(false);
  });

  it("honours operator overrides on every knob", () => {
    const s = resolveHedgeSettings({ floorMs: 1_000, margin: 10, minSamples: 2 });
    // floorMs override: 1001 ms now clears a bar the default would not have.
    expect(ask({ elapsedMs: 1_001, pings: [] }, s)?.thresholdMs).toBe(1_000);
    // minSamples override: 2 probes are now enough to reach the absolute rung at all.
    // margin override: p90 3000 x 10 = 30000, so 25000 must NOT fire and 35000 must.
    expect(ask({ elapsedMs: 25_000, pings: probes(2, 3_000) }, s)).toBeNull();
    expect(ask({ elapsedMs: 35_000, pings: probes(2, 3_000) }, s)?.thresholdMs).toBe(30_000);
  });

  it("labels metadata only — a rate, a basis and a count, never content", () => {
    const d = ask({ elapsedMs: 28_400, pings: [] })!;
    expect(hedgeLabel("nim/deepseek-ai/deepseek-v4-flash-0731", d)).toBe(
      "nim/deepseek-ai/deepseek-v4-flash-0731 (28.4s > 20.0s, floor, 0 tokens seen)",
    );
  });
});
