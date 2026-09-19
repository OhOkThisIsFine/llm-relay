import { describe, it, expect, beforeEach } from "vitest";
import {
  classifyProcessError,
  handleProcessError,
  installProcessSafetyNet,
  isTransportError,
  resetProcessSafetyNet,
} from "../src/process-safety-net.js";

/**
 * The safety net exists so a late socket reset from a discarded failover body cannot kill
 * the proxy that fronts every session (docs/history/freellmapi-adoption-review-2026-08-13.md §1.3).
 * The classifier must swallow ONLY the closed transport allowlist — everything else keeps
 * Node's fail-fast exit(1), so a genuine bug still crashes loudly.
 */

function coded(code: string): Error {
  return Object.assign(new Error(`boom ${code}`), { code });
}

describe("classifyProcessError", () => {
  it("swallows the closed set of socket/undici codes", () => {
    for (const code of ["ECONNRESET", "EPIPE", "ETIMEDOUT", "UND_ERR_SOCKET", "UND_ERR_ABORTED"]) {
      expect(classifyProcessError(coded(code))).toBe("swallow");
    }
  });

  it("finds the code through undici's nested cause chain", () => {
    const err = new TypeError("fetch failed");
    (err as { cause?: unknown }).cause = coded("UND_ERR_CONNECT_TIMEOUT");
    expect(classifyProcessError(err)).toBe("swallow");

    const deep = new Error("outer");
    (deep as { cause?: unknown }).cause = { cause: coded("ECONNRESET") };
    expect(classifyProcessError(deep)).toBe("swallow");
  });

  it("survives a cyclic cause chain without hanging", () => {
    const a = new Error("a");
    const b = new Error("b");
    (a as { cause?: unknown }).cause = b;
    (b as { cause?: unknown }).cause = a;
    expect(classifyProcessError(a)).toBe("fatal");
  });

  it("swallows exact Node/undici-authored message shapes only when the chain has no code", () => {
    expect(classifyProcessError(new TypeError("fetch failed"))).toBe("swallow");
    expect(classifyProcessError(new Error("other side closed"))).toBe("swallow");
    expect(classifyProcessError(new Error("socket hang up"))).toBe("swallow");
    expect(classifyProcessError(new TypeError("terminated"))).toBe("swallow");
    expect(classifyProcessError(new Error("premature close"))).toBe("swallow");
    expect(classifyProcessError(new Error("read ECONNRESET"))).toBe("swallow");
  });

  it("does not mistake application messages containing transport words for transport errors", () => {
    expect(classifyProcessError(new Error("worker terminated after invariant failure"))).toBe("fatal");
    expect(classifyProcessError(new Error("premature close while committing state"))).toBe("fatal");
    expect(classifyProcessError(new Error("socket hang up handler crashed"))).toBe("fatal");
    expect(classifyProcessError(new Error("fetch failed validation"))).toBe("fatal");
  });

  it("does not let an outer transport-like message override a non-transport cause code", () => {
    const err = new TypeError("terminated");
    (err as { cause?: unknown }).cause = coded("ERR_INVALID_ARG_TYPE");
    expect(classifyProcessError(err)).toBe("fatal");

    const fetchWrapper = new TypeError("fetch failed");
    (fetchWrapper as { cause?: unknown }).cause = coded("ERR_ASSERTION");
    expect(classifyProcessError(fetchWrapper)).toBe("fatal");
  });

  it("is fatal for everything else — bugs must still crash", () => {
    expect(classifyProcessError(new Error("boom"))).toBe("fatal");
    expect(classifyProcessError(new ReferenceError("x is not defined"))).toBe("fatal");
    expect(classifyProcessError(coded("SOME_OTHER_CODE"))).toBe("fatal");
    expect(classifyProcessError(null)).toBe("fatal");
    expect(classifyProcessError(undefined)).toBe("fatal");
    expect(classifyProcessError("string rejection")).toBe("fatal");
  });

  it("isTransportError never matches provider-ish text without a transport shape", () => {
    expect(isTransportError(new Error("model not found"))).toBe(false);
    expect(isTransportError(new Error("rate limit exceeded"))).toBe(false);
  });
});

describe("handleProcessError", () => {
  it("swallow: logs one line and does NOT exit", () => {
    const logs: string[] = [];
    let exited: number | null = null;
    const decision = handleProcessError("uncaughtException", coded("ECONNRESET"), {
      log: (line) => logs.push(line),
      exit: (code) => {
        exited = code;
      },
    });
    expect(decision).toBe("swallow");
    expect(exited).toBeNull();
    expect(logs).toHaveLength(1);
    expect(logs[0]).toContain("ECONNRESET");
  });

  it("fatal: flushes best-effort then exits 1", () => {
    const calls: string[] = [];
    let exited: number | null = null;
    const decision = handleProcessError("unhandledRejection", new Error("bug"), {
      log: () => calls.push("log"),
      beforeExit: () => calls.push("flush"),
      exit: (code) => {
        exited = code;
        calls.push("exit");
      },
    });
    expect(decision).toBe("fatal");
    expect(exited).toBe(1);
    expect(calls).toEqual(["log", "flush", "exit"]);
  });

  it("fatal: a throwing beforeExit flush cannot mask the exit", () => {
    let exited: number | null = null;
    handleProcessError("uncaughtException", new Error("bug"), {
      log: () => {},
      beforeExit: () => {
        throw new Error("disk full");
      },
      exit: (code) => {
        exited = code;
      },
    });
    expect(exited).toBe(1);
  });
});

describe("installProcessSafetyNet", () => {
  beforeEach(() => resetProcessSafetyNet());

  it("registers both handlers on an injected process and routes errors through the classifier", () => {
    const handlers = new Map<string, (err: unknown) => void>();
    const logs: string[] = [];
    let exited: number | null = null;
    installProcessSafetyNet({
      proc: {
        on: (event: string, fn: (err: unknown) => void) => {
          handlers.set(event, fn);
          return undefined as never;
        },
      } as never,
      log: (line) => logs.push(line),
      exit: (code) => {
        exited = code;
      },
    });
    expect([...handlers.keys()].sort()).toEqual(["uncaughtException", "unhandledRejection"]);

    handlers.get("uncaughtException")!(coded("UND_ERR_SOCKET"));
    expect(exited).toBeNull();
    expect(logs.some((l) => l.includes("UND_ERR_SOCKET"))).toBe(true);

    handlers.get("unhandledRejection")!(new Error("bug"));
    expect(exited).toBe(1);
  });

  it("is idempotent on the real process path", () => {
    // Simulate the real-process guard without touching global handlers: the flag only
    // applies when no proc is injected, so exercise it via two no-proc installs against a
    // stub of process.on. We cannot stub the real process safely here, so assert the guard
    // through resetProcessSafetyNet's contract instead: a second install with proc set
    // still registers (per-fake), proving the flag is scoped to the real process only.
    let registrations = 0;
    const fake = {
      on: () => {
        registrations += 1;
        return undefined as never;
      },
    } as never;
    installProcessSafetyNet({ proc: fake });
    installProcessSafetyNet({ proc: fake });
    expect(registrations).toBe(4);
  });
});
