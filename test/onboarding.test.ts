import { describe, it, expect, afterEach } from "vitest";
import { getOnboardingStatusList } from "../src/onboarding.js";

describe("onboarding", () => {
  const PROBE = "NVIDIA_API_KEY";
  const orig = process.env[PROBE];
  afterEach(() => {
    if (orig === undefined) delete process.env[PROBE];
    else process.env[PROBE] = orig;
  });

  it("uses the shared presence predicate, so a blank key is not 'Ready'", () => {
    const nimStatus = () => getOnboardingStatusList().find((s) => s.provider === "nim")!;

    process.env[PROBE] = "nvapi-real";
    expect(nimStatus().hasKey).toBe(true);

    // A whitespace-only export is ABSENT everywhere else in this codebase (`keyIsPresent`).
    // Reporting it "✅ Ready" here sends the user off to debug a live call instead of the key.
    process.env[PROBE] = "   ";
    expect(nimStatus().hasKey).toBe(false);

    delete process.env[PROBE];
    expect(nimStatus().hasKey).toBe(false);
  });

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
