import { describe, expect, it } from "vitest";
import { compareVersions, isOutdated, isValidVersion } from "../src/self-update.js";

/**
 * Pins the two critical defects in ARC-a262deff / ARC-a262deff-2:
 *  - the semver gate was not end-anchored, so `9.9.9 & calc.exe` parsed as 9.9.9
 *    and the trailing shell metacharacters travelled into a cmd.exe command line;
 *  - prerelease ordering fell back to plain string comparison, so rc.9 > rc.10.
 *
 * These are separated from test/self-update.test.ts deliberately: that suite
 * covers the update *flow*, this one covers the input gate that makes the flow
 * safe to run at all.
 */
describe("self-update version gate (ARC-a262deff)", () => {
  it("rejects a version carrying shell metacharacters", () => {
    // The exact payload from the finding: an unanchored regex accepts this.
    expect(isValidVersion("9.9.9 & calc.exe")).toBe(false);
    expect(isValidVersion("1.2.3; rm -rf /")).toBe(false);
    expect(isValidVersion("1.2.3 | whoami")).toBe(false);
    expect(isValidVersion("1.2.3 && echo pwned")).toBe(false);
    expect(isValidVersion("1.2.3`id`")).toBe(false);
    expect(isValidVersion("1.2.3$(id)")).toBe(false);
    expect(isValidVersion("1.2.3\nnpm uninstall -g llm-relay")).toBe(false);
  });

  it("accepts only a full-string semver", () => {
    expect(isValidVersion("1.2.3")).toBe(true);
    expect(isValidVersion("v1.2.3")).toBe(true);
    expect(isValidVersion("0.10.0")).toBe(true);
    expect(isValidVersion("1.2.3-rc.1")).toBe(true);
    expect(isValidVersion("1.2.3-rc.1+build.5")).toBe(true);
    expect(isValidVersion("")).toBe(false);
    expect(isValidVersion("1.2")).toBe(false);
    expect(isValidVersion("latest")).toBe(false);
    expect(isValidVersion(undefined)).toBe(false);
    expect(isValidVersion(42)).toBe(false);
  });

  it("a rejected version can never be reported as outdated", () => {
    // isOutdated is the only gate between a version and the install subprocess.
    expect(isOutdated("0.10.0", "9.9.9 & calc.exe")).toBe(false);
  });

  it("orders prereleases by semver, not by string comparison", () => {
    // The defect: '9' > '1' lexically, so rc.9 sorted above rc.10.
    expect(compareVersions("0.9.0-rc.9", "0.9.0-rc.10")).toBe(-1);
    expect(compareVersions("0.9.0-rc.10", "0.9.0-rc.9")).toBe(1);
    expect(isOutdated("0.9.0-rc.9", "0.9.0-rc.10")).toBe(true);
  });

  it("orders prerelease identifiers per spec", () => {
    // numeric identifiers rank below alphanumeric ones
    expect(compareVersions("1.0.0-1", "1.0.0-alpha")).toBe(-1);
    // a shorter run of otherwise-equal identifiers ranks lower
    expect(compareVersions("1.0.0-alpha", "1.0.0-alpha.1")).toBe(-1);
    // a prerelease ranks below its release
    expect(compareVersions("1.0.0-rc.1", "1.0.0")).toBe(-1);
    expect(compareVersions("1.0.0", "1.0.0-rc.1")).toBe(1);
  });
});
