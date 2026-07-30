import { describe, it, expect, afterEach, beforeEach } from "vitest";
import { getOnboardingStatusList } from "../src/onboarding.js";
import { loadConfig, type Config } from "../src/config.js";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

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

/**
 * `leave_me_alone`: stop nudging me about providers I have decided not to configure.
 *
 * Two properties make or break it — it must accept names that match nothing (that is the whole
 * point of storing only the negative space), and it must not remove anything from the surfaces
 * the user consults to find out what the relay actually sees.
 */
describe("leave_me_alone provider suppression", () => {
  let dir: string;
  const write = (cfg: unknown): string => {
    const p = join(dir, "config.json");
    writeFileSync(p, JSON.stringify(cfg));
    return p;
  };
  const CFG = {
    listen: "127.0.0.1:8791",
    mode: "detect",
    providers: {
      nim: { base: "https://nim.test/v1", kind: "openai", authEnv: "NVIDIA_API_KEY" },
      groq: { base: "https://groq.test/v1", kind: "openai", authEnv: "GROQ_API_KEY" },
    },
    routing: { default: "nim/m" },
  };

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "relay-lma-"));
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it("drops a suppressed provider from the onboarding nudge, keeping the rest", () => {
    const cfg = loadConfig(write({ ...CFG, leave_me_alone: ["groq"] }));
    const names = getOnboardingStatusList(cfg).map((s) => s.provider);
    expect(names).toEqual(["nim"]);
  });

  it("matches case- and whitespace-insensitively", () => {
    const cfg = loadConfig(write({ ...CFG, leave_me_alone: ["  GROQ "] }));
    expect(getOnboardingStatusList(cfg).map((s) => s.provider)).toEqual(["nim"]);
  });

  /**
   * The list is the NEGATIVE space: the providers worth suppressing are precisely the ones the
   * user never declared. Validating against the known set would reject the feature's main case.
   */
  it("accepts a name matching no known provider, without error or warning", () => {
    const cfg = loadConfig(write({ ...CFG, leave_me_alone: ["nobody-has-heard-of-this"] }));
    expect(cfg.leaveMeAlone).toEqual(["nobody-has-heard-of-this"]);
    expect(cfg.warnings ?? []).toEqual([]);
    expect(getOnboardingStatusList(cfg).map((s) => s.provider)).toEqual(["nim", "groq"]);
  });

  /** Silencing a nudge is not hiding state — the provider is still fully configured and routable. */
  it("does not remove the provider from the config the rest of the relay reads", () => {
    const cfg: Config = loadConfig(write({ ...CFG, leave_me_alone: ["groq"] }));
    expect(Object.keys(cfg.providers)).toEqual(["nim", "groq"]);
    expect(cfg.providers.groq?.authEnv).toBe("GROQ_API_KEY");
  });

  it("is absent from the config when not configured", () => {
    expect(loadConfig(write(CFG)).leaveMeAlone).toBeUndefined();
  });

  // A shape mistake has no plausible reading, and silently ignoring it leaves the user
  // being nagged with no idea why.
  it("rejects a value that is not a list of names", () => {
    expect(() => loadConfig(write({ ...CFG, leave_me_alone: "groq" }))).toThrow(/array of provider names/);
    expect(() => loadConfig(write({ ...CFG, leave_me_alone: ["groq", 7] }))).toThrow(/non-empty provider-name strings/);
    expect(() => loadConfig(write({ ...CFG, leave_me_alone: ["  "] }))).toThrow(/non-empty provider-name strings/);
  });
});
