/**
 * The write-behind timer's shutdown seam.
 *
 * Every disk-backed store here trades a bounded crash window (`MAX_FLUSH_DELAY_MS`) for a quiet
 * request path. A graceful shutdown is where that window must be closed explicitly, and until
 * 2026-09-08 three per-Config stores (`dispatch-exhaustion-persistence.ts`,
 * `dispatch-lane-stats.ts`, `lane-affinity.ts`) armed timers that nothing could reach: the
 * installer returned only a restore count. `flushNow` and `WriteBehindRegistry` are that seam.
 */
import { describe, it, expect, vi, afterEach } from "vitest";
import { WriteBehindRegistry, WriteBehindTimer, DEFAULT_FLUSH_DELAY_MS } from "../src/write-behind.js";

afterEach(() => {
  vi.useRealTimers();
});

describe("WriteBehindTimer.flushNow", () => {
  it("runs the armed flush at once and leaves the timer clean, so the debounce never runs it twice", () => {
    vi.useFakeTimers();
    const timer = new WriteBehindTimer();
    const flush = vi.fn();
    timer.touch(flush, 0);
    expect(timer.dirty).toBe(true);

    expect(timer.flushNow()).toBe(true);
    expect(flush).toHaveBeenCalledTimes(1);
    expect(timer.dirty).toBe(false);

    // The debounced callback would have been the second write; a flushed timer must not fire it.
    vi.advanceTimersByTime(DEFAULT_FLUSH_DELAY_MS * 2);
    expect(flush).toHaveBeenCalledTimes(1);
  });

  it("does nothing on a clean timer — a shutdown must not write a file nothing changed", () => {
    const timer = new WriteBehindTimer();
    expect(timer.flushNow()).toBe(false);
    const flush = vi.fn();
    timer.touch(flush, 0);
    timer.clear();
    expect(timer.flushNow()).toBe(false);
    expect(flush).not.toHaveBeenCalled();
  });

  it("runs the LATEST armed flush, which is the one holding the newest state", () => {
    vi.useFakeTimers();
    const timer = new WriteBehindTimer();
    const first = vi.fn();
    const second = vi.fn();
    timer.touch(first, 0);
    timer.touch(second, 10);
    expect(timer.flushNow()).toBe(true);
    expect(first).not.toHaveBeenCalled();
    expect(second).toHaveBeenCalledTimes(1);
  });
});

describe("WriteBehindRegistry.flushAll", () => {
  it("flushes every dirty timer, counts the writes, and skips the clean ones", () => {
    vi.useFakeTimers();
    const registry = new WriteBehindRegistry();
    const dirtyA = registry.register(new WriteBehindTimer());
    const dirtyB = registry.register(new WriteBehindTimer());
    const clean = registry.register(new WriteBehindTimer());
    const a = vi.fn();
    const b = vi.fn();
    dirtyA.touch(a, 0);
    dirtyB.touch(b, 0);

    expect(registry.flushAll()).toBe(2);
    expect(a).toHaveBeenCalledTimes(1);
    expect(b).toHaveBeenCalledTimes(1);
    expect(clean.dirty).toBe(false);
    // Nothing is dirty any more, so a second shutdown pass writes nothing.
    expect(registry.flushAll()).toBe(0);
  });

  it("a flush that throws never stops the others — persistence is best-effort at shutdown too", () => {
    vi.useFakeTimers();
    const registry = new WriteBehindRegistry();
    const broken = registry.register(new WriteBehindTimer());
    const healthy = registry.register(new WriteBehindTimer());
    broken.touch(() => {
      throw new Error("disk full");
    }, 0);
    const write = vi.fn();
    healthy.touch(write, 0);

    expect(() => registry.flushAll()).not.toThrow();
    expect(write).toHaveBeenCalledTimes(1);
    // The failed flush already cleared its timer before running, so it is not retried forever.
    expect(broken.dirty).toBe(false);
  });
});
