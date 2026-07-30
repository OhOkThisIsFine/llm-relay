import { describe, it, expect, afterEach, vi } from "vitest";

/**
 * ARC-6a02bffc-2 — the wiring half of the update gate.
 *
 * `test/cli.test.ts` pins what `classifyCommand` decides and `test/self-update.test.ts` pins
 * what `shouldCheckUpdates` does with a classification. Neither proves the value actually
 * travels between them, and the gate is only real if it does: `self-update.ts` cannot import
 * the subcommand table (`cli.ts` already imports that module, so it would be a cycle), so the
 * classification must arrive as a RUNTIME PARAMETER on every call.
 *
 * Both argv used here are `version` invocations. That is deliberate — `run()` calls `main()`
 * afterwards, and every other subcommand either reaches the network or writes to the machine.
 */
const mocks = vi.hoisted(() => ({
  shouldCheckUpdates: vi.fn<(...a: unknown[]) => boolean>(() => false),
  ensureUpToDate: vi.fn(async () => {}),
}));

vi.mock("../src/self-update.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/self-update.js")>()),
  ...mocks,
}));

const { run } = await import("../src/cli.js");

describe("run() — update gate wiring", () => {
  const origArgv = process.argv;

  afterEach(() => {
    process.argv = origArgv;
    mocks.shouldCheckUpdates.mockReset().mockReturnValue(false);
    mocks.ensureUpToDate.mockReset();
    vi.restoreAllMocks();
  });

  async function runWith(...rest: string[]): Promise<void> {
    process.argv = ["node", "cli.ts", ...rest];
    vi.spyOn(process.stdout, "write").mockImplementation(() => true);
    vi.spyOn(process, "exit").mockImplementation(((code?: number) => {
      throw new Error(`exit:${code}`);
    }) as never);
    await expect(run()).rejects.toThrow("exit:0");
  }

  it("hands the classification over as the third argument", async () => {
    await runWith("version");
    expect(mocks.shouldCheckUpdates).toHaveBeenCalledWith(expect.any(Array), process.env, "read-only");
  });

  it("reports a mutating invocation as mutating", async () => {
    // A bare flag invocation is a proxy start, which is the one moment an update may land.
    await runWith("--version");
    expect(mocks.shouldCheckUpdates).toHaveBeenCalledWith(expect.any(Array), process.env, "mutating");
  });

  it("only reaches the updater when the gate says so", async () => {
    await runWith("version");
    expect(mocks.ensureUpToDate).not.toHaveBeenCalled();

    mocks.shouldCheckUpdates.mockReturnValue(true);
    await runWith("version");
    expect(mocks.ensureUpToDate).toHaveBeenCalledTimes(1);
  });
});
