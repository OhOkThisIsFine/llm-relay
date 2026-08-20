import { afterAll, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { loadConfig, resolveTarget } from "../src/config.js";
import {
  aggregateHasKey,
  providerCredentialSlots,
  resolveAttemptForSlot,
  resolveCredentialSlot,
  slotAllowsModel,
} from "../src/credential-fleet.js";
import { resolveAttempt } from "../src/resolved-attempt.js";

const dir = mkdtempSync(join(tmpdir(), "relay-fleet-"));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

function load(name: string, providers: Record<string, unknown>, defaultRoute = "fleet/model") {
  const path = join(dir, name);
  writeFileSync(path, JSON.stringify({
    listen: "127.0.0.1:8791",
    providers,
    routing: { default: defaultRoute },
  }));
  return loadConfig(path);
}

describe("credential fleet normalization", () => {
  it("uses exact env names for explicit slots, while legacy authEnv keeps aliases", () => {
    const cfg = load("exact-vs-legacy.json", {
      fleet: {
        base: "https://fleet.test",
        kind: "openai",
        credentials: [{ label: "one", authEnv: "FLEET_ONE" }],
      },
      legacy: { base: "https://legacy.test", kind: "openai", authEnv: "GEMINI_API_KEY" },
    });
    const explicit = providerCredentialSlots("fleet", cfg.providers.fleet!)[0]!;
    expect(resolveCredentialSlot(explicit, { GOOGLEAI_API_KEY: "alias" }).state).toBe("declared-missing");
    const old = providerCredentialSlots("legacy", cfg.providers.legacy!)[0]!;
    expect(resolveCredentialSlot(old, { GOOGLEAI_API_KEY: "alias" }).value).toBe("alias");
  });

  it("keeps disabled slots visible and drops later duplicate label/env slots with warnings", () => {
    const cfg = load("duplicates.json", {
      fleet: {
        base: "https://fleet.test",
        kind: "openai",
        credentials: [
          { label: "work", authEnv: "FLEET_WORK", enabled: false },
          { label: "work", authEnv: "FLEET_TWO" },
          { label: "other", authEnv: "FLEET_WORK" },
          { label: "ok", authEnv: "FLEET_OK" },
        ],
      },
    });
    const slots = providerCredentialSlots("fleet", cfg.providers.fleet!);
    expect(slots.map((slot) => [slot.label, slot.enabled])).toEqual([["work", false], ["ok", true]]);
    expect(cfg.warnings?.filter((warning) => /duplicate/.test(warning))).toHaveLength(2);
  });

  it("normalizes every explicit fleet to contained without an Anthropic passthrough warning", () => {
    for (const [name, credentials] of [
      ["empty", []],
      ["populated", [{ label: "one", authEnv: "FLEET_ONE" }]],
    ] as const) {
      const cfg = load(`contained-${name}.json`, {
        fleet: { base: "https://fleet.test", kind: "anthropic", credentials },
      });
      expect(cfg.providers.fleet!.credentialMode).toBe("contained");
      expect(cfg.warnings?.some((warning) => /forwards the CALLER/.test(warning)) ?? false).toBe(false);
    }
  });

  it("normalizes model allow-lists while preserving null and empty semantics", () => {
    const cfg = load("models.json", {
      fleet: {
        base: "https://fleet.test",
        kind: "openai",
        credentials: [
          { label: "one", authEnv: "FLEET_ONE", models: [" m ", "m", "M"] },
          { label: "all", authEnv: "FLEET_ALL", models: null },
          { label: "none", authEnv: "FLEET_NONE", models: [] },
        ],
      },
    });
    const slots = providerCredentialSlots("fleet", cfg.providers.fleet!);
    expect(slots[0]!.models).toEqual(["m", "M"]);
    expect(slotAllowsModel(slots[0]!, "m")).toBe(true);
    expect(slotAllowsModel(slots[0]!, "M")).toBe(true);
    expect(slotAllowsModel(slots[0]!, "m ")).toBe(false);
    expect(slots[1]!.models).toBeNull();
    expect(slotAllowsModel(slots[1]!, "first-model")).toBe(true);
    expect(slotAllowsModel(slots[1]!, "second-model")).toBe(true);
    expect(slots[2]!.models).toEqual([]);
    expect(slotAllowsModel(slots[2]!, "first-model")).toBe(false);
    expect(slotAllowsModel(slots[2]!, "second-model")).toBe(false);
    expect(Object.isFrozen(slots)).toBe(true);
    expect(Object.isFrozen(slots[0]!.models)).toBe(true);
  });

  it("treats credentials:[] as an empty fleet and missing secrets as no attempts", () => {
    const cfg = load("empty.json", {
      fleet: { base: "https://fleet.test", kind: "openai", credentials: [] },
    });
    expect(providerCredentialSlots("fleet", cfg.providers.fleet!)).toEqual([]);
    expect(aggregateHasKey("fleet", cfg.providers.fleet!, {})).toBe(false);
    expect(resolveAttempt(resolveTarget("fleet/model", cfg), {}).credential.state).toBe("declared-missing");

    const missingCfg = load("missing.json", {
      fleet: {
        base: "https://fleet.test",
        kind: "openai",
        credentials: [{ label: "one", authEnv: "FLEET_ONE" }],
      },
    });
    const slot = providerCredentialSlots("fleet", missingCfg.providers.fleet!)[0]!;
    expect(resolveAttemptForSlot(resolveTarget("fleet/model", missingCfg), slot, {})).toBeUndefined();
  });

  it("rejects declaration conflicts and invalid provider names, warning for invalid slots", () => {
    expect(() => load("auth-conflict.json", {
      fleet: { base: "https://fleet.test", kind: "openai", authEnv: "FLEET", credentials: [] },
    })).toThrow(/authEnv and credentials/);
    expect(() => load("pass-conflict.json", {
      fleet: { base: "https://fleet.test", kind: "openai", credentialMode: "passthrough", credentials: [] },
    })).toThrow(/passthrough.*credentials/);
    expect(() => load("not-array.json", {
      fleet: { base: "https://fleet.test", kind: "openai", credentials: {} },
    })).toThrow(/credentials must be an array/);
    expect(() => load("bad-provider.json", {
      "bad#name": { base: "https://fleet.test", kind: "openai" },
    })).toThrow(/valid provider name/);

    const compatible = load("compatible-provider.json", {
      "custom:cloud": { base: "https://fleet.test", kind: "openai" },
    }, "custom:cloud/model");
    expect(compatible.providers["custom:cloud"]).toBeDefined();

    const cfg = load("bad-slots.json", {
      fleet: {
        base: "https://fleet.test",
        kind: "openai",
        credentials: [
          { label: "bad label", authEnv: "FLEET_OK" },
          { label: "ok", authEnv: "not-valid" },
          { label: "good", authEnv: "FLEET_GOOD" },
        ],
      },
    });
    expect(providerCredentialSlots("fleet", cfg.providers.fleet!)).toHaveLength(1);
    expect(cfg.warnings?.filter((warning) => /dropped/.test(warning))).toHaveLength(2);
  });

  it("drops only a slot whose models declaration is malformed", () => {
    const cfg = load("bad-models.json", {
      fleet: {
        base: "https://fleet.test",
        kind: "openai",
        credentials: [
          { label: "bad", authEnv: "FLEET_BAD", models: "model" },
          { label: "good", authEnv: "FLEET_GOOD", models: ["model"] },
        ],
      },
    });
    expect(providerCredentialSlots("fleet", cfg.providers.fleet!).map((slot) => slot.label)).toEqual(["good"]);
    expect(cfg.warnings?.some((warning) => /models must be an array/.test(warning))).toBe(true);
  });

  it("normalizes provider maxConcurrent, with null and omission meaning unlimited", () => {
    expect(load("max.json", {
      fleet: { base: "https://fleet.test", kind: "openai", maxConcurrent: 3 },
    }).providers.fleet!.maxConcurrent).toBe(3);
    expect(load("max-null.json", {
      fleet: { base: "https://fleet.test", kind: "openai", maxConcurrent: null },
    }).providers.fleet!.maxConcurrent).toBeNull();
    expect(load("max-omitted.json", {
      fleet: { base: "https://fleet.test", kind: "openai" },
    }).providers.fleet!.maxConcurrent).toBeUndefined();
    for (const value of [0, -1, 1.5, Number.MAX_SAFE_INTEGER + 1, "3"]) {
      expect(() => load(`max-bad-${String(value)}.json`, {
        fleet: { base: "https://fleet.test", kind: "openai", maxConcurrent: value },
      })).toThrow(/maxConcurrent/);
    }
  });
});
