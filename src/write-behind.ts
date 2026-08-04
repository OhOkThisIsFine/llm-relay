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
    if (this.timer) clearTimeout(this.timer);
    const remaining = Math.max(0, MAX_FLUSH_DELAY_MS - (now - this.dirtySince));
    this.timer = setTimeout(() => {
      this.clear();
      flush();
    }, Math.min(DEFAULT_FLUSH_DELAY_MS, remaining));
  }

  /** Cancel any pending timer and mark clean. Call from eager-flush paths before writing. */
  clear(): void {
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    this.dirtySince = null;
  }
}
