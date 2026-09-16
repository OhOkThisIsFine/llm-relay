import { describe, expect, it } from "vitest";
import type { QuotaRowV1 } from "../../src/dashboard-contract.js";
import { basisTone, groupQuotaRowsByProvider } from "./view-model.js";

function row(overrides: Partial<QuotaRowV1>): QuotaRowV1 {
  return {
    credentialId: "openai#primary", label: "primary", provider: "openai", deployment: null,
    axis: "requests", period: "minute", limit: 10, remaining: 5, localUsed: null,
    resetsAt: null, observedAt: null, limitBasis: "configured", remainingBasis: "derived_configured",
    localUsedBasis: null, resetsAtBasis: null, ...overrides,
  };
}

describe("groupQuotaRowsByProvider", () => {
  it("keeps each provider's first-appearance order and each row's order within its group", () => {
    const rows = [row({ provider: "b", label: "b1" }), row({ provider: "a", label: "a1" }), row({ provider: "b", label: "b2" })];
    const groups = groupQuotaRowsByProvider(rows);
    expect(groups.map(([provider]) => provider)).toEqual(["b", "a"]);
    expect(groups[0]![1].map((entry) => entry.label)).toEqual(["b1", "b2"]);
    expect(groups[1]![1].map((entry) => entry.label)).toEqual(["a1"]);
  });
  it("returns nothing for an empty row list", () => { expect(groupQuotaRowsByProvider([])).toEqual([]); });
});

describe("basisTone", () => {
  it("classifies provider-stated and reported figures as strong", () => { expect(basisTone("provider_stated")).toBe("strong"); expect(basisTone("reported")).toBe("strong"); });
  it("classifies a derived or configured figure as derived", () => { expect(basisTone("derived_provider_stated")).toBe("derived"); expect(basisTone("derived_configured")).toBe("derived"); expect(basisTone("configured")).toBe("derived"); expect(basisTone("relay_counted")).toBe("derived"); });
  it("classifies learned/published/estimated figures as weak, and null as unknown", () => { expect(basisTone("learned")).toBe("weak"); expect(basisTone("published")).toBe("weak"); expect(basisTone("estimated")).toBe("weak"); expect(basisTone(null)).toBe("unknown"); });
});
