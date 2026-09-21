import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { currentVersion } from "../src/self-update.js";

const mocks = vi.hoisted(() => {
  const flushes = {
    catalog: vi.fn(),
    runtimeTelemetry: vi.fn(),
    probeCache: vi.fn(),
    observedContextLimits: vi.fn(),
    facts: vi.fn(),
    interpretations: vi.fn(),
  };
  const store = { closed: false, close: vi.fn() };
  const server = {
    once: vi.fn(),
    listen: vi.fn(),
    address: vi.fn(() => ({ address: "127.0.0.1", port: 8791 })),
    close: vi.fn(),
    closeIdleConnections: vi.fn(),
  };
  return {
    flushes,
    store,
    server,
    createAccountingStore: vi.fn(() => store),
    createProxy: vi.fn(() => server),
    installProcessSafetyNet: vi.fn(),
    ModelCatalog: class {
      flushPersistence = flushes.catalog;
    },
  };
});

vi.mock("../src/accounting-store.js", () => ({
  createAccountingStore: mocks.createAccountingStore,
}));
vi.mock("../src/server.js", () => ({
  createProxy: mocks.createProxy,
}));
vi.mock("../src/process-safety-net.js", () => ({
  installProcessSafetyNet: mocks.installProcessSafetyNet,
}));
vi.mock("../src/catalog.js", () => ({
  ModelCatalog: mocks.ModelCatalog,
}));
vi.mock("../src/ping/runtime-telemetry.js", async () => {
  const actual = await vi.importActual<typeof import("../src/ping/runtime-telemetry.js")>("../src/ping/runtime-telemetry.js");
  return { ...actual, flushRuntimeTelemetry: mocks.flushes.runtimeTelemetry };
});
vi.mock("../src/ping/probe-cache.js", async () => {
  const actual = await vi.importActual<typeof import("../src/ping/probe-cache.js")>("../src/ping/probe-cache.js");
  return { ...actual, flushProbeCache: mocks.flushes.probeCache };
});
vi.mock("../src/context-limits.js", async () => {
  const actual = await vi.importActual<typeof import("../src/context-limits.js")>("../src/context-limits.js");
  return { ...actual, flushObservedContextLimits: mocks.flushes.observedContextLimits };
});
vi.mock("../src/target-facts.js", async () => {
  const actual = await vi.importActual<typeof import("../src/target-facts.js")>("../src/target-facts.js");
  return { ...actual, flushFacts: mocks.flushes.facts };
});
vi.mock("../src/refusal-interpretation.js", async () => {
  const actual = await vi.importActual<typeof import("../src/refusal-interpretation.js")>("../src/refusal-interpretation.js");
  return { ...actual, flushInterpretations: mocks.flushes.interpretations };
});

const originalArgv = process.argv;
const originalExit = process.exit;
const originalOn = process.on;

function writeConfig(): { directory: string; path: string } {
  const directory = mkdtempSync(join(tmpdir(), "llm-relay-cli-accounting-"));
  const path = join(directory, "config.json");
  writeFileSync(path, JSON.stringify({
    listen: "127.0.0.1:8791",
    providers: {
      test: {
        base: "http://127.0.0.1:1",
        kind: "openai",
        authEnv: "ACCOUNTING_CLI_TEST_KEY",
      },
    },
    routing: { default: "test/model" },
    mode: "detect",
    repair: { maxAttempts: 2, destructiveTools: [] },
    log: { level: "silent", file: null },
  }));
  return { directory, path };
}

function resetMocks(): void {
  mocks.createAccountingStore.mockClear();
  mocks.createProxy.mockClear();
  mocks.installProcessSafetyNet.mockClear();
  mocks.store.closed = false;
  mocks.store.close.mockReset();
  mocks.store.close.mockImplementation(() => {
    mocks.store.closed = true;
    return { retryable: false };
  });
  mocks.server.once.mockReset();
  mocks.server.listen.mockReset();
  mocks.server.close.mockReset();
  mocks.server.closeIdleConnections.mockReset();
  mocks.server.address.mockClear();
  for (const flush of Object.values(mocks.flushes)) flush.mockReset();
}

async function loadRunProxy(): Promise<() => unknown> {
  const importArgv = process.argv;
  process.argv = [importArgv[0] ?? "node", "vitest", ...importArgv.slice(2)];
  try {
    const module = await import("../src/cli.js");
    return module.runProxy;
  } finally {
    process.argv = importArgv;
  }
}

describe("accounting store CLI lifecycle", () => {
  // `../src/cli.js` pulls in its whole module graph (config, benchmarks/tier-data,
  // dashboard-snapshot, ...) on first import; under the full parallel suite that first
  // `import()` can alone exceed the 5s default TEST timeout (passes alone in ~0.9s).
  // Warming the module cache here charges that cost to THIS HOOK's own 20s budget
  // (set below), not to whichever `it` happens to run first — the three tests below
  // still each call `loadRunProxy()`, but resolve it from the now-warm module cache.
  beforeAll(async () => {
    await loadRunProxy();
  }, 20_000);

  afterEach(() => {
    process.argv = originalArgv;
    process.exit = originalExit;
    process.on = originalOn;
    delete process.env.ACCOUNTING_CLI_TEST_KEY;
  });

  it("constructs one store, injects it, and closes it once across close paths", async () => {
    resetMocks();
    const config = writeConfig();
    const closeListeners: Array<() => void> = [];
    const closeCallbacks: Array<() => void> = [];
    const signalHandlers = new Map<string, () => void>();
    mocks.server.once.mockImplementation((event: string, listener: () => void) => {
      if (event === "close") closeListeners.push(listener);
      return mocks.server;
    });
    mocks.server.close.mockImplementation((callback: () => void) => {
      closeCallbacks.push(callback);
      return mocks.server;
    });
    process.on = ((event: string | symbol, listener: (...args: unknown[]) => void) => {
      if (event === "SIGINT" || event === "SIGTERM") signalHandlers.set(event, listener as () => void);
      return process;
    }) as typeof process.on;
    process.exit = ((_code?: number) => undefined) as typeof process.exit;
    process.env.ACCOUNTING_CLI_TEST_KEY = "test-secret";
    process.argv = ["node", "cli.js", "--config", config.path];

    const runProxy = await loadRunProxy();
    const server = runProxy();

    expect(mocks.createAccountingStore).toHaveBeenCalledTimes(1);
    // M5 (approved 2026-08-21): production retention is 30 days; the store's own
    // default stays null (off) for library callers.
    expect(mocks.createAccountingStore).toHaveBeenCalledWith({ retentionDays: 30 });
    expect(mocks.createProxy).toHaveBeenCalledTimes(1);
    expect(mocks.createProxy).toHaveBeenCalledWith(expect.anything(), {
      catalog: expect.anything(),
      accountingRecorder: mocks.store,
      accountingReader: mocks.store,
      relayVersion: currentVersion(),
      dashboardAttributionPolicy: "include_all_labeled",
      // D2 gives the production proxy the startup-equivalent config loader and post-commit warmer.
      reloadConfig: expect.any(Function),
      onReloaded: expect.any(Function),
      // `POST /stop` (backlog item 3, 2026-09-09) reaches the SAME shutdown as a signal.
      onStop: expect.any(Function),
    });
    expect(server).toBe(mocks.server);
    expect(closeListeners).toHaveLength(1);
    expect(signalHandlers.has("SIGINT")).toBe(true);
    expect(signalHandlers.has("SIGTERM")).toBe(true);

    closeListeners[0]!();
    signalHandlers.get("SIGINT")!();
    signalHandlers.get("SIGTERM")!();
    // The third close path: the admitted stop's callback, after the signals already ran.
    // The mock is untyped, so its call tuple is `[]` to tsc; the cast names the shape asserted above.
    const [, deps] = mocks.createProxy.mock.calls[0] as unknown as [unknown, { onStop: () => void }];
    deps.onStop();
    closeCallbacks[0]?.();
    expect(mocks.store.close).toHaveBeenCalledTimes(1);
    expect(mocks.server.close).toHaveBeenCalledTimes(1);

    rmSync(config.directory, { recursive: true, force: true });
  });

  it("continues fatal flushes and retries a thrown store close at a later boundary", async () => {
    resetMocks();
    const config = writeConfig();
    const closeListeners: Array<() => void> = [];
    mocks.store.close.mockImplementation(() => {
      throw new Error("store close failed");
    });
    mocks.server.once.mockImplementation((event: string, listener: () => void) => {
      if (event === "close") closeListeners.push(listener);
      return mocks.server;
    });
    process.on = ((_event: string | symbol, _listener: (...args: unknown[]) => void) => process) as typeof process.on;
    process.exit = ((_code?: number) => undefined) as typeof process.exit;
    process.env.ACCOUNTING_CLI_TEST_KEY = "test-secret";
    process.argv = ["node", "cli.js", "--config", config.path];

    const runProxy = await loadRunProxy();
    runProxy();
    const beforeExit = mocks.installProcessSafetyNet.mock.calls[0]?.[0]?.beforeExit as (() => void) | undefined;
    expect(beforeExit).toBeDefined();
    expect(() => beforeExit!()).not.toThrow();
    expect(mocks.store.close).toHaveBeenCalledTimes(1);
    expect(mocks.flushes.catalog).toHaveBeenCalledTimes(1);
    expect(mocks.flushes.runtimeTelemetry).toHaveBeenCalledTimes(1);
    expect(mocks.flushes.probeCache).toHaveBeenCalledTimes(1);
    expect(mocks.flushes.observedContextLimits).toHaveBeenCalledTimes(1);
    expect(mocks.flushes.facts).toHaveBeenCalledTimes(1);
    expect(mocks.flushes.interpretations).toHaveBeenCalledTimes(1);
    closeListeners[0]?.();
    expect(mocks.store.close).toHaveBeenCalledTimes(2);

    rmSync(config.directory, { recursive: true, force: true });
  });

  it("retries a retryable close result and latches the terminal retry", async () => {
    resetMocks();
    const config = writeConfig();
    const closeListeners: Array<() => void> = [];
    mocks.store.close
      .mockImplementationOnce(() => ({ retryable: true }))
      .mockImplementation(() => {
        mocks.store.closed = true;
        return { retryable: false };
      });
    mocks.server.once.mockImplementation((event: string, listener: () => void) => {
      if (event === "close") closeListeners.push(listener);
      return mocks.server;
    });
    process.on = ((_event: string | symbol, _listener: (...args: unknown[]) => void) => process) as typeof process.on;
    process.exit = ((_code?: number) => undefined) as typeof process.exit;
    process.env.ACCOUNTING_CLI_TEST_KEY = "test-secret";
    process.argv = ["node", "cli.js", "--config", config.path];

    const runProxy = await loadRunProxy();
    runProxy();
    const beforeExit = mocks.installProcessSafetyNet.mock.calls[0]?.[0]?.beforeExit as (() => void) | undefined;
    expect(beforeExit).toBeDefined();
    beforeExit!();
    expect(mocks.store.close).toHaveBeenCalledTimes(1);
    expect(mocks.store.closed).toBe(false);

    closeListeners[0]?.();
    closeListeners[0]?.();
    expect(mocks.store.close).toHaveBeenCalledTimes(2);
    expect(mocks.store.closed).toBe(true);

    rmSync(config.directory, { recursive: true, force: true });
  });
});
