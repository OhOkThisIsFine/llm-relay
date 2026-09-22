import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const probe = fileURLToPath(new URL("../scripts/refactor/gateway-contracts.mjs", import.meta.url));

describe("gateway comparison fixture oracles", () => {
  it("accepts complete fixtures and rejects lost tool identities, results and argument fragments", () => {
    const result = execFileSync(process.execPath, [probe, "--self-test"], {
      encoding: "utf8",
      timeout: 10_000,
      windowsHide: true,
    });
    expect(JSON.parse(result)).toEqual({ selfTest: true, assertions: 33 });
  });
});
