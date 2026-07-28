import { describe, it, expect } from "vitest";
import { getOnboardingStatusList } from "../src/onboarding.js";

describe("onboarding", () => {
  it("getOnboardingStatusList categorizes providers correctly", () => {
    const statuses = getOnboardingStatusList();
    expect(statuses.length).toBeGreaterThanOrEqual(6);

    const nim = statuses.find((s) => s.provider === "nim");
    expect(nim).toBeDefined();
    expect(nim?.tierType).toBe("free");
    expect(nim?.authEnv).toBe("NVIDIA_API_KEY");
    expect(nim?.signupUrl).toBe("https://build.nvidia.com");

    const groq = statuses.find((s) => s.provider === "groq");
    expect(groq).toBeDefined();
    expect(groq?.signupUrl).toBe("https://console.groq.com/keys");

    const openai = statuses.find((s) => s.provider === "openai");
    expect(openai).toBeDefined();
    expect(openai?.tierType).toBe("subscription");
  });
});
