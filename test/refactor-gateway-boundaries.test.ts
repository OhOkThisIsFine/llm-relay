import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const probe = fileURLToPath(new URL("../scripts/refactor/gateway-boundaries.mjs", import.meta.url));

describe("gateway boundary fixture oracles", () => {
  it("rejects changed native data, wrong provider wires, repeated egresses and caller credentials", () => {
    const result = execFileSync(process.execPath, [probe, "--self-test"], {
      encoding: "utf8", timeout: 10_000, windowsHide: true,
    });
    expect(JSON.parse(result)).toEqual({ selfTest: true, assertions: 20 });
  });
});
