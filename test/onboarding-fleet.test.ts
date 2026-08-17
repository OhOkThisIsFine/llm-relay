import { afterEach, describe, expect, it } from "vitest";
import { getOnboardingStatusList } from "../src/onboarding.js";
import type { Config } from "../src/config.js";

describe("onboarding fleet presence", () => {
  afterEach(() => {
    delete process.env.ONBOARD_DISABLED;
    delete process.env.ONBOARD_EMPTY;
  });

  it("does not report an all-disabled or models-empty fleet as ready", () => {
    process.env.ONBOARD_DISABLED = "present-but-disabled";
    process.env.ONBOARD_EMPTY = "present-but-out-of-scope";
    const cfg = {
      host: "127.0.0.1", port: 8791,
      providers: {
        custom: {
          base: "https://custom.test/v1", kind: "openai", authHeader: "authorization", timeoutMs: 1000,
          credentials: [
            { label: "disabled", authEnv: "ONBOARD_DISABLED", enabled: false },
            { label: "empty", authEnv: "ONBOARD_EMPTY", models: [] },
          ],
        },
      },
      routing: { default: "custom/m", tiers: {} },
      mode: "detect",
      repair: { maxAttempts: 2, destructiveTools: [] },
      log: { level: "silent", file: null },
    } as unknown as Config;
    expect(getOnboardingStatusList(cfg).find((status) => status.provider === "custom")?.hasKey).toBe(false);
  });
});
