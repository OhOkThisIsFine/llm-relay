/**
 * The hedge race's concurrency, pinned away from `server.ts`.
 *
 * This is the dangerous half of hedging: "which promise won, and who gets aborted" is exactly the
 * kind of logic an end-to-end proxy test covers by accident rather than on purpose. Every timer
 * here is injected, so nothing sleeps and every ordering is deterministic.
 */
import { describe, it, expect } from "vitest";
import { raceWithHedge, type RaceEntrant, type Settled } from "../src/hedge-race.js";

/** A controllable entrant: settle it by hand, and record whether it was aborted. */
function entrant<T>(): RaceEntrant<T> & {
  resolve(v: T): void;
  reject(e: unknown): void;
  aborted: () => number;
} {
  let resolve!: (v: T) => void;
  let reject!: (e: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  let aborts = 0;
  return { promise, abort: () => { aborts += 1; }, resolve, reject, aborted: () => aborts };
}

/** A timer that fires only when the test says so. */
function manualTimer() {
  const queued: (() => void)[] = [];
  let cleared = 0;
  return {
    setTimer: (fn: () => void) => { queued.push(fn); return queued.length; },
    clearTimer: () => { cleared += 1; },
    fire: () => { const f = queued.shift(); if (f) f(); },
    cleared: () => cleared,
    pending: () => queued.length,
  };
}

const winIfOk = (s: Settled<string>): boolean => s.ok && s.value !== "fail";

/** Let every pending microtask run. One `await Promise.resolve()` is not enough for a race chain. */
const flush = (): Promise<void> => new Promise((resolve) => setImmediate(resolve));

describe("hedge race — the primary answers inside the delay", () => {
  it("returns the primary and starts NO hedge", async () => {
    const t = manualTimer();
    const primary = entrant<string>();
    let started = 0;
    const p = raceWithHedge<string>({
      primary,
      startHedge: () => { started += 1; return entrant<string>(); },
      delayMs: 1_000,
      isWin: winIfOk,
      setTimer: t.setTimer,
      clearTimer: t.clearTimer,
    });
    primary.resolve("ok");
    const r = await p;
    expect(r.winner).toBe("primary");
    expect(r.hedgeStarted).toBe(false);
    expect(started).toBe(0);
    expect(t.cleared()).toBe(1); // the delay timer must not be left armed
  });

  it("returns a FAILING primary too, without duplicating", async () => {
    // A pool member that fails FAST is the existing failover's business, not the hedge's.
    // Duplicating here would double the request rate on an unhealthy pool, when the walk was
    // already about to move on for free.
    const t = manualTimer();
    const primary = entrant<string>();
    let started = 0;
    const p = raceWithHedge<string>({
      primary,
      startHedge: () => { started += 1; return entrant<string>(); },
      delayMs: 1_000,
      isWin: winIfOk,
      setTimer: t.setTimer,
      clearTimer: t.clearTimer,
    });
    primary.reject(new Error("boom"));
    const r = await p;
    expect(r.winner).toBe("primary");
    expect(r.settled.ok).toBe(false);
    expect(started).toBe(0);
  });
});

describe("hedge race — the primary is slow", () => {
  it("starts the hedge only when the delay expires, and only then", async () => {
    const t = manualTimer();
    const primary = entrant<string>();
    let started = 0;
    const hedge = entrant<string>();
    const p = raceWithHedge<string>({
      primary,
      startHedge: () => { started += 1; return hedge; },
      delayMs: 1_000,
      isWin: winIfOk,
      setTimer: t.setTimer,
      clearTimer: t.clearTimer,
    });
    expect(started).toBe(0);
    t.fire();
    // The delay resolving does not start the hedge synchronously: the race chain has to advance
    // first. Flush the microtask queue rather than assuming a single tick is enough.
    await flush();
    expect(started).toBe(1);
    hedge.resolve("from-hedge");
    const r = await p;
    expect(r.winner).toBe("hedge");
    expect(r.settled).toEqual({ ok: true, value: "from-hedge" });
    expect(r.hedgeStarted).toBe(true);
  });

  it("ABORTS the primary when the hedge wins — this is what bounds the duplicate cost", async () => {
    const t = manualTimer();
    const primary = entrant<string>();
    const hedge = entrant<string>();
    const p = raceWithHedge<string>({
      primary, startHedge: () => hedge, delayMs: 1, isWin: winIfOk,
      setTimer: t.setTimer, clearTimer: t.clearTimer,
    });
    t.fire();
    hedge.resolve("from-hedge");
    await p;
    expect(primary.aborted()).toBe(1);
    expect(hedge.aborted()).toBe(0);
  });

  it("ABORTS the hedge when the slow primary answers first after all", async () => {
    // The case a plain timeout throws away: a member that was about to answer is still allowed to.
    const t = manualTimer();
    const primary = entrant<string>();
    const hedge = entrant<string>();
    const p = raceWithHedge<string>({
      primary, startHedge: () => hedge, delayMs: 1, isWin: winIfOk,
      setTimer: t.setTimer, clearTimer: t.clearTimer,
    });
    t.fire();
    primary.resolve("late-but-good");
    const r = await p;
    expect(r.winner).toBe("primary");
    expect(r.settled).toEqual({ ok: true, value: "late-but-good" });
    expect(hedge.aborted()).toBe(1);
  });

  it("degrades to the primary when the walk has no candidate left", async () => {
    const t = manualTimer();
    const primary = entrant<string>();
    const p = raceWithHedge<string>({
      primary, startHedge: () => undefined, delayMs: 1, isWin: winIfOk,
      setTimer: t.setTimer, clearTimer: t.clearTimer,
    });
    t.fire();
    primary.resolve("only-one");
    const r = await p;
    expect(r.winner).toBe("primary");
    expect(r.hedgeStarted).toBe(false);
    expect(primary.aborted()).toBe(0);
  });
});

describe("hedge race — a losing settlement does not end the race", () => {
  it("keeps waiting for the hedge when the primary settles WITHOUT winning", async () => {
    // The measured shape: the primary comes back 429 or times out while the hedge is still live.
    const t = manualTimer();
    const primary = entrant<string>();
    const hedge = entrant<string>();
    const p = raceWithHedge<string>({
      primary, startHedge: () => hedge, delayMs: 1, isWin: winIfOk,
      setTimer: t.setTimer, clearTimer: t.clearTimer,
    });
    t.fire();
    await flush();               // the hedge is now running
    primary.resolve("fail");
    await flush();               // and the primary's losing settlement has been SEEN first
    hedge.resolve("rescued");
    const r = await p;
    expect(r.winner).toBe("hedge");
    expect(r.settled).toEqual({ ok: true, value: "rescued" });
  });

  it("keeps waiting for the primary when the HEDGE settles without winning", async () => {
    const t = manualTimer();
    const primary = entrant<string>();
    const hedge = entrant<string>();
    const p = raceWithHedge<string>({
      primary, startHedge: () => hedge, delayMs: 1, isWin: winIfOk,
      setTimer: t.setTimer, clearTimer: t.clearTimer,
    });
    t.fire();
    await flush();               // the hedge is now running
    hedge.reject(new Error("hedge died"));
    await flush();               // and its losing settlement has been SEEN first
    primary.resolve("primary-eventually");
    const r = await p;
    expect(r.winner).toBe("primary");
    expect(r.settled).toEqual({ ok: true, value: "primary-eventually" });
  });

  it("reports the PRIMARY's settlement when NEITHER wins, whichever arrived first", async () => {
    // Preserves every existing error path: the ranked-first candidate's error is the one the walk
    // has always reported, so no existing test or header changes meaning when a hedge loses too.
    const t = manualTimer();
    const primary = entrant<string>();
    const hedge = entrant<string>();
    const p = raceWithHedge<string>({
      primary, startHedge: () => hedge, delayMs: 1, isWin: winIfOk,
      setTimer: t.setTimer, clearTimer: t.clearTimer,
    });
    t.fire();
    await flush();
    hedge.resolve("fail");       // the HEDGE settles first, and still does not get reported
    await flush();
    primary.resolve("fail");
    const r = await p;
    expect(r.winner).toBe("primary");
    expect(r.settled).toEqual({ ok: true, value: "fail" });
    expect(r.hedgeStarted).toBe(true);
  });
});

describe("hedge race — safety", () => {
  it("survives an abort that throws, because a won request must not die on cleanup", async () => {
    const t = manualTimer();
    const primary = entrant<string>();
    const hedge = entrant<string>();
    const exploding: RaceEntrant<string> = {
      promise: primary.promise,
      abort: () => { throw new Error("abort exploded"); },
    };
    const p = raceWithHedge<string>({
      primary: exploding, startHedge: () => hedge, delayMs: 1, isWin: winIfOk,
      setTimer: t.setTimer, clearTimer: t.clearTimer,
    });
    t.fire();
    hedge.resolve("won anyway");
    const r = await p;
    expect(r.winner).toBe("hedge");
    expect(r.settled).toEqual({ ok: true, value: "won anyway" });
  });

  it("never lets a rejection escape as an unhandled rejection", async () => {
    const t = manualTimer();
    const primary = entrant<string>();
    const hedge = entrant<string>();
    const p = raceWithHedge<string>({
      primary, startHedge: () => hedge, delayMs: 1, isWin: winIfOk,
      setTimer: t.setTimer, clearTimer: t.clearTimer,
    });
    t.fire();
    primary.reject(new Error("primary died"));
    hedge.reject(new Error("hedge died"));
    const r = await p;
    expect(r.settled.ok).toBe(false);
    expect(r.winner).toBe("primary");
  });

  it("treats a zero delay as an immediate check, not as unconditional duplication", async () => {
    // A misconfigured 0 must not turn every request into two.
    const t = manualTimer();
    const primary = entrant<string>();
    let started = 0;
    const p = raceWithHedge<string>({
      primary,
      startHedge: () => { started += 1; return entrant<string>(); },
      delayMs: 0,
      isWin: winIfOk,
      setTimer: t.setTimer,
      clearTimer: t.clearTimer,
    });
    primary.resolve("fast");
    const r = await p;
    expect(r.winner).toBe("primary");
    expect(started).toBe(0);
  });
});
