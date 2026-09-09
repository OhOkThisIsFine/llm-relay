/**
 * Debounced write-behind scheduling, shared by the disk-backed caches (model catalog, probe
 * cache, runtime telemetry). Each dirtying touch re-arms a short timer so bursts coalesce into
 * one write, while the first touch starts a max-age clock so a steady stream of touches cannot
 * defer the flush forever.
 */

export const DEFAULT_FLUSH_DELAY_MS = 250;
export const MAX_FLUSH_DELAY_MS = 2_000;

export class WriteBehindTimer {
  private timer: NodeJS.Timeout | null = null;
  private dirtySince: number | null = null;
  /** The flush the latest touch armed, kept so a shutdown can run it without waiting. */
  private pending: (() => void) | null = null;

  /** True when a touch has not yet been flushed (or cancelled). */
  get dirty(): boolean {
    return this.dirtySince !== null;
  }

  /**
   * Re-arm the debounce. `flush` runs after the delay, with this timer already marked clean —
   * so a flush implementation that also calls `clear()` (eager-flush paths do) stays idempotent.
   */
  touch(flush: () => void, now = Date.now()): void {
    this.dirtySince ??= now;
    this.pending = flush;
    if (this.timer) clearTimeout(this.timer);
    const remaining = Math.max(0, MAX_FLUSH_DELAY_MS - (now - this.dirtySince));
    this.timer = setTimeout(() => {
      this.clear();
      flush();
    }, Math.min(DEFAULT_FLUSH_DELAY_MS, remaining));
  }

  /**
   * Run the armed flush NOW when a touch is still unflushed; a clean timer does nothing.
   *
   * The shutdown seam. Every write-behind store trades a bounded crash window (`MAX_FLUSH_DELAY_MS`)
   * for a quiet request path, and a graceful shutdown is where that window is closed explicitly.
   * Returns true when a write ran, so a caller can count what it flushed.
   */
  flushNow(): boolean {
    const flush = this.pending;
    if (!this.dirty || flush === null) return false;
    this.clear();
    flush();
    return true;
  }

  /** Cancel any pending timer and mark clean. Call from eager-flush paths before writing. */
  clear(): void {
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    this.dirtySince = null;
    this.pending = null;
  }
}

/**
 * The timers one store has installed, so its shutdown flush can reach every one of them without
 * each installer handing back a handle.
 *
 * A per-Config store (`dispatch-exhaustion-persistence.ts`, `dispatch-lane-stats.ts`,
 * `lane-affinity.ts`) creates one timer per install and returned only a restore count, so nothing
 * could flush it at shutdown: `runProxy` flushed six sibling stores and none of these. A registry
 * per store keeps that count-returning signature — the tests pin it — and gives the shutdown path
 * one call per store.
 */
export class WriteBehindRegistry {
  private readonly timers = new Set<WriteBehindTimer>();

  /** Remember a timer; returns it so `register(new WriteBehindTimer())` reads as one expression. */
  register(timer: WriteBehindTimer): WriteBehindTimer {
    this.timers.add(timer);
    return timer;
  }

  /**
   * Flush every dirty timer. A write that throws never stops the others — persistence is
   * best-effort at every other seam in this repository and a shutdown is no place to start
   * failing. Returns how many writes ran.
   */
  flushAll(): number {
    let flushed = 0;
    for (const timer of this.timers) {
      try {
        if (timer.flushNow()) flushed += 1;
      } catch {
        /* best-effort persistence */
      }
    }
    return flushed;
  }
}
