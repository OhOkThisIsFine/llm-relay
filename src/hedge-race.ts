/**
 * Racing a slow attempt against the candidate the walk would have tried next.
 *
 * ⚠ **This module is deliberately ignorant of HTTP, of `server.ts`, and of what it is racing.** It
 * is the concurrency, and nothing else. That isolation is the whole point: the walk lives in the
 * least forgiving code in this repo, and a subtle mistake in "which promise won and who gets
 * aborted" is not something an end-to-end proxy test reliably catches. Everything here is pinned by
 * direct unit tests with injected timers, so the dangerous part is provable on its own.
 *
 * ⚠ **THE RACE IS DECIDED AT RESPONSE RESOLUTION, not at first content**, and that bound is
 * deliberate. The measured failure this exists for —
 * `nim/deepseek-ai/deepseek-v4-flash-0731`, 43 consecutive attempts at the full 120000 ms provider
 * timeout — never resolved at all: no headers, no body, no tokens. Resolution is therefore exactly
 * the seam where it can be beaten, and racing there is a far smaller change than racing two live
 * response bodies. ⚠ The case NOT covered is "headers arrive quickly, then the body stalls": that
 * needs the per-token rung and a race between two committed streams, and it is a later stage. Say
 * so rather than implying this covers every slow shape.
 *
 * ⚠ **A loser is ABORTED, and the breaker therefore learns nothing from it** — cancellation returns
 * before the provenance table in `circuit-breaker.ts`. That is a real, stated cost: hedging HIDES
 * the slowness it routes around. It is acceptable only because v0.65.3 makes the requests that do
 * NOT hedge cool a slow deployment for as long as it wasted, so the slowness is still learned.
 */

/** One side of the race. `abort` must be idempotent and must never throw. */
export interface RaceEntrant<T> {
  readonly promise: Promise<T>;
  abort(): void;
}

/** A settled outcome, kept as data so a rejection never escapes the race itself. */
export type Settled<T> = { readonly ok: true; readonly value: T } | { readonly ok: false; readonly error: unknown };

export interface HedgeRaceResult<T> {
  /** Whose settlement the caller must now handle. */
  readonly winner: "primary" | "hedge";
  readonly settled: Settled<T>;
  /** Did a hedge actually start? False when the primary settled inside the delay. */
  readonly hedgeStarted: boolean;
  /** The loser, already aborted, or undefined when only one side ran. */
  readonly loser?: RaceEntrant<T>;
}

export interface HedgeRaceOptions<T> {
  readonly primary: RaceEntrant<T>;
  /**
   * Produce the second entrant, at the moment the delay expires — never before.
   *
   * ⚠ Called LATE on purpose. The walk's next candidate must be resolved against the state that
   * exists when the hedge is actually needed, not against a snapshot taken before the primary ran:
   * a hard cap, a quota demotion or a breaker trip may have landed in between. Returning
   * `undefined` means "no candidate left", and the race degrades to awaiting the primary.
   */
  startHedge(): RaceEntrant<T> | undefined;
  /** Milliseconds to wait for the primary before starting the hedge. */
  readonly delayMs: number;
  /**
   * Is this settlement good enough to stop the race?
   *
   * ⚠ Supplied by the caller because "won" is a policy question, not a concurrency one. The walk
   * passes "resolved with a status the walk would not fail over from", so a primary that answers
   * 429 does NOT beat a hedge that is still running — it would have been failed over anyway.
   */
  isWin(settled: Settled<T>): boolean;
  /** Injected for tests. Must behave like `setTimeout`/`clearTimeout`. */
  readonly setTimer?: (fn: () => void, ms: number) => unknown;
  readonly clearTimer?: (handle: unknown) => void;
}

/** Settle a promise into data. Nothing in this module may let a rejection escape. */
function settle<T>(p: Promise<T>): Promise<Settled<T>> {
  return p.then(
    (value) => ({ ok: true, value }) as Settled<T>,
    (error: unknown) => ({ ok: false, error }) as Settled<T>,
  );
}

/**
 * Run the race.
 *
 * The rules, in order:
 *
 * 1. **Wait `delayMs` for the primary.** If it settles in that window — win or lose — return it and
 *    start no hedge at all. A pool whose members answer promptly therefore never duplicates, which
 *    is what keeps the duplicate rate tied to actual slowness rather than to traffic.
 * 2. **Start the hedge.** If there is no candidate, await the primary and return it.
 * 3. **The first side that settles as a WIN takes it.** The loser is aborted.
 * 4. **A losing settlement does not end the race** — keep waiting for the other side. This is what
 *    makes a hedge useful against a primary that fails slowly.
 * 5. **If both settle without winning, return the PRIMARY's settlement.** It is the ranked-first
 *    candidate, so its error is the one the walk has always reported, and preserving that keeps
 *    every existing error path and test meaningful.
 *
 * ⚠ `delayMs <= 0` still runs rule 1 with a zero wait rather than skipping it, so a
 * misconfigured 0 cannot turn every request into an unconditional duplicate.
 */
export async function raceWithHedge<T>(opts: HedgeRaceOptions<T>): Promise<HedgeRaceResult<T>> {
  const setTimer = opts.setTimer ?? ((fn, ms) => setTimeout(fn, ms));
  const clearTimer = opts.clearTimer ?? ((h) => clearTimeout(h as ReturnType<typeof setTimeout>));

  const primarySettled = settle(opts.primary.promise);

  const DELAY = Symbol("hedge-delay");
  let handle: unknown;
  const delay = new Promise<typeof DELAY>((resolve) => {
    handle = setTimer(() => resolve(DELAY), Math.max(0, opts.delayMs));
  });

  const firstOrDelay = await Promise.race([primarySettled, delay]);
  if (firstOrDelay !== DELAY) {
    clearTimer(handle);
    return { winner: "primary", settled: firstOrDelay, hedgeStarted: false };
  }

  const hedgeEntrant = opts.startHedge();
  if (!hedgeEntrant) {
    return { winner: "primary", settled: await primarySettled, hedgeStarted: false };
  }

  const hedgeSettled = settle(hedgeEntrant.promise);
  const tagged: Promise<{ side: "primary" | "hedge"; settled: Settled<T> }>[] = [
    primarySettled.then((settled) => ({ side: "primary" as const, settled })),
    hedgeSettled.then((settled) => ({ side: "hedge" as const, settled })),
  ];

  const first = await Promise.race(tagged);
  if (opts.isWin(first.settled)) {
    const loser = first.side === "primary" ? hedgeEntrant : opts.primary;
    abortQuietly(loser);
    return { winner: first.side, settled: first.settled, hedgeStarted: true, loser };
  }

  // Rule 4: the first to settle did not win, so the other one is still the request's best hope.
  const other = first.side === "primary" ? await hedgeSettled : await primarySettled;
  const otherSide = first.side === "primary" ? "hedge" : "primary";
  if (opts.isWin(other)) {
    return { winner: otherSide, settled: other, hedgeStarted: true, loser: first.side === "primary" ? opts.primary : hedgeEntrant };
  }

  // Rule 5: neither won. Report the PRIMARY's settlement, whichever order they arrived in.
  const primaryFinal = await primarySettled;
  return { winner: "primary", settled: primaryFinal, hedgeStarted: true, loser: hedgeEntrant };
}

/** An abort must never take the request down with it. */
function abortQuietly<T>(entrant: RaceEntrant<T>): void {
  try {
    entrant.abort();
  } catch {
    // A failed abort leaks one in-flight request until its own timeout. That is strictly better
    // than failing a request the relay has already won.
  }
}
