import { describe, expect, it } from "vitest";
import { basisLabel, relativeTime } from "./formatters.js";

describe("relativeTime", () => {
  const now = new Date("2026-08-20T12:00:00.000Z").getTime();
  it("reads Unavailable for a null or unparseable value", () => {
    expect(relativeTime(null, now)).toBe("Unavailable");
    expect(relativeTime("not-a-date", now)).toBe("Unavailable");
  });
  it("renders a future reset as a countdown, and a past one as elapsed", () => {
    expect(relativeTime("2026-08-20T12:00:30.000Z", now)).toBe("in 30s");
    expect(relativeTime("2026-08-20T12:03:00.000Z", now)).toBe("in 3m");
    expect(relativeTime("2026-08-20T15:00:00.000Z", now)).toBe("in 3h");
    expect(relativeTime("2026-08-23T12:00:00.000Z", now)).toBe("in 3d");
    expect(relativeTime("2026-08-20T11:57:00.000Z", now)).toBe("3m ago");
  });
});

describe("basisLabel", () => {
  it("reads Unavailable for null and title-cases every underscore-separated word otherwise", () => {
    expect(basisLabel(null)).toBe("Unavailable");
    expect(basisLabel("provider_stated")).toBe("Provider Stated");
    expect(basisLabel("derived_provider_stated")).toBe("Derived Provider Stated");
    expect(basisLabel("configured")).toBe("Configured");
  });
});
