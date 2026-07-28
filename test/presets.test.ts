import { describe, it, expect } from "vitest";
import { FREE_PROVIDER_PRESETS, SUBSCRIPTION_PROVIDER_PRESETS, DEFAULT_PRESET_ROUTING } from "../src/presets.js";

describe("presets", () => {
  it("FREE_PROVIDER_PRESETS contains 100%-free providers with signup URLs", () => {
    expect(FREE_PROVIDER_PRESETS.nim).toBeDefined();
    expect(FREE_PROVIDER_PRESETS.nim.tierType).toBe("free");
    expect(FREE_PROVIDER_PRESETS.nim.signupUrl).toBe("https://build.nvidia.com");
    expect(FREE_PROVIDER_PRESETS.nim.authEnv).toBe("NVIDIA_API_KEY");

    expect(FREE_PROVIDER_PRESETS.groq).toBeDefined();
    expect(FREE_PROVIDER_PRESETS.groq.signupUrl).toBe("https://console.groq.com/keys");

    expect(FREE_PROVIDER_PRESETS.gemini).toBeDefined();
    expect(FREE_PROVIDER_PRESETS.gemini.signupUrl).toBe("https://aistudio.google.com/app/apikey");
  });

  it("SUBSCRIPTION_PROVIDER_PRESETS contains subscription templates", () => {
    expect(SUBSCRIPTION_PROVIDER_PRESETS.openai).toBeDefined();
    expect(SUBSCRIPTION_PROVIDER_PRESETS.openai.tierType).toBe("subscription");
    expect(SUBSCRIPTION_PROVIDER_PRESETS.openai.authEnv).toBe("OPENAI_API_KEY");

    expect(SUBSCRIPTION_PROVIDER_PRESETS.anthropic).toBeDefined();
    expect(SUBSCRIPTION_PROVIDER_PRESETS.anthropic.tierType).toBe("subscription");
  });

  it("DEFAULT_PRESET_ROUTING contains tier fallback lists", () => {
    expect(Array.isArray(DEFAULT_PRESET_ROUTING.default)).toBe(true);
    expect(Array.isArray(DEFAULT_PRESET_ROUTING.tiers.opus)).toBe(true);
    expect(Array.isArray(DEFAULT_PRESET_ROUTING.tiers.sonnet)).toBe(true);
    expect(Array.isArray(DEFAULT_PRESET_ROUTING.tiers.haiku)).toBe(true);
  });
});
