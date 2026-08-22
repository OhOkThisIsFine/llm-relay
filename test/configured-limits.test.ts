import { afterAll, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { loadConfig } from "../src/config.js";
import { configuredLimitQuotaShape, resolveConfiguredLimits } from "../src/configured-limits.js";

/**
 * Pins spec §4 Rung 3 resolution semantics: per-axis precedence across the four declaration
 * sites, null when nothing is declared, and honest source labelling. Configs are built through
 * loadConfig (not hand-built literals) so the parser and the resolver are exercised together.
 */
const dir = mkdtempSync(join(tmpdir(), "relay-cfg-limits-"));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

function load(name: string, providers: Record<string, unknown>) {
  const path = join(dir, name);
  writeFileSync(path, JSON.stringify({
    listen: "127.0.0.1:8791",
    providers,
    routing: { default: "nim/model" },
  }));
  return loadConfig(path);
}

describe("resolveConfiguredLimits", () => {
  it("returns null when nothing is configured anywhere", () => {
    const cfg = load("none.json", {
      nim: { base: "https://nim.test/v1", kind: "openai", authEnv: "NIM_KEY" },
    });
    expect(resolveConfiguredLimits(cfg, "nim", null, null)).toBeNull();
    expect(resolveConfiguredLimits(cfg, "nim", null, "meta/llama-3.1-8b-instruct")).toBeNull();
    // An unknown provider has no limits to read either.
    expect(resolveConfiguredLimits(cfg, "ghost", null, null)).toBeNull();
  });

  it("resolves a slot-only declaration with no provider-level block at all", () => {
    // config.example.json ships exactly this shape, so it must resolve — the early null that
    // used to gate on the provider block would hide the slot's own hard-validated ceiling.
    const cfg = load("slot-only.json", {
      nim: {
        base: "https://nim.test/v1",
        kind: "openai",
        credentials: [{ label: "a", authEnv: "NIM_A", limits: { rpd: 500 } }],
      },
    });
    expect(resolveConfiguredLimits(cfg, "nim", "a", null)).toEqual({
      rpd: 500,
      basis: "configured",
      source: { rpd: "credential" },
    });
    // A different slot declaring nothing still resolves to null — nothing was declared for it.
    expect(resolveConfiguredLimits(cfg, "nim", "b", null)).toBeNull();
  });

  it("resolves a slot-only models override with no provider-level block at all", () => {
    const cfg = load("slot-only-models.json", {
      nim: {
        base: "https://nim.test/v1",
        kind: "openai",
        credentials: [{
          label: "a",
          authEnv: "NIM_A",
          limits: { models: { "z-ai/glm-5.2": { rpm: 12 } } },
        }],
      },
    });
    const model = "z-ai/glm-5.2";
    expect(resolveConfiguredLimits(cfg, "nim", "a", model)).toEqual({
      rpm: 12,
      basis: "configured",
      source: { rpm: "credential-model" },
    });
    // An unlisted model sees no declared axis anywhere on this provider.
    expect(resolveConfiguredLimits(cfg, "nim", "a", "other/model")).toBeNull();
  });

  it("resolves provider-level axes and labels each source \"provider\"", () => {
    const cfg = load("provider.json", {
      nim: {
        base: "https://nim.test/v1",
        kind: "openai",
        authEnv: "NIM_KEY",
        limits: { rpm: 40, rpd: 1000 },
      },
    });
    expect(resolveConfiguredLimits(cfg, "nim", null, null)).toEqual({
      rpm: 40,
      rpd: 1000,
      basis: "configured",
      source: { rpm: "provider", rpd: "provider" },
    });
  });

  it("overrides per credential and falls through for an undeclared label", () => {
    const cfg = load("credential.json", {
      nim: {
        base: "https://nim.test/v1",
        kind: "openai",
        limits: { rpm: 40, rpd: 1000 },
        credentials: [
          { label: "a", authEnv: "NIM_A", limits: { rpd: 500 } },
          { label: "b", authEnv: "NIM_B" },
        ],
      },
    });
    // Slot a: rpd narrowed, rpm inherited from the provider level.
    expect(resolveConfiguredLimits(cfg, "nim", "a", null)).toEqual({
      rpm: 40,
      rpd: 500,
      basis: "configured",
      source: { rpm: "provider", rpd: "credential" },
    });
    // Slot b declares nothing of its own: every axis stays provider-sourced.
    expect(resolveConfiguredLimits(cfg, "nim", "b", null)).toEqual({
      rpm: 40,
      rpd: 1000,
      basis: "configured",
      source: { rpm: "provider", rpd: "provider" },
    });
    // A label naming no slot narrows nothing — the relay resolves what config declares.
    expect(resolveConfiguredLimits(cfg, "nim", "nope", null)).toEqual({
      rpm: 40,
      rpd: 1000,
      basis: "configured",
      source: { rpm: "provider", rpd: "provider" },
    });
  });

  it("applies model overrides above the flat blocks, per axis independently", () => {
    const cfg = load("models.json", {
      nim: {
        base: "https://nim.test/v1",
        kind: "openai",
        limits: {
          rpm: 40, rpd: 1000, tpm: 100000, tpd: 150000,
          models: { "meta/llama-3.1-8b-instruct": { rpm: 10 } },
        },
        credentials: [
          {
            label: "a",
            authEnv: "NIM_A",
            limits: { tpm: 50000, models: { "z-ai/glm-5.2": { tpd: 90000 } } },
          },
        ],
      },
    });
    const model = "meta/llama-3.1-8b-instruct";
    // A model entry setting ONLY rpm leaves rpd/tpm/tpd inherited from above.
    expect(resolveConfiguredLimits(cfg, "nim", null, model)).toEqual({
      rpm: 10,
      rpd: 1000,
      tpm: 100000,
      tpd: 150000,
      basis: "configured",
      source: { rpm: "provider-model", rpd: "provider", tpm: "provider", tpd: "provider" },
    });
    // An unlisted model sees the flat provider block.
    expect(resolveConfiguredLimits(cfg, "nim", null, "other/model")).toEqual({
      rpm: 40,
      rpd: 1000,
      tpm: 100000,
      tpd: 150000,
      basis: "configured",
      source: { rpm: "provider", rpd: "provider", tpm: "provider", tpd: "provider" },
    });
    // Credential-level model override wins over the credential flat block on THAT axis only;
    // the sibling axis keeps its credential-flat value.
    expect(resolveConfiguredLimits(cfg, "nim", "a", "z-ai/glm-5.2")).toEqual({
      rpm: 40,
      rpd: 1000,
      tpm: 50000,
      tpd: 90000,
      basis: "configured",
      source: {
        rpm: "provider",
        rpd: "provider",
        tpm: "credential",
        tpd: "credential-model",
      },
    });
    // A credential-model override beats a provider-model override for the same axis.
    const bothModels = load("both-models.json", {
      nim: {
        base: "https://nim.test/v1",
        kind: "openai",
        limits: { rpm: 40, models: { "m/x": { rpm: 30 } } },
        credentials: [{ label: "a", authEnv: "NIM_A", limits: { models: { "m/x": { rpm: 5 } } } }],
      },
    });
    expect(resolveConfiguredLimits(bothModels, "nim", "a", "m/x")?.rpm).toBe(5);
    expect(resolveConfiguredLimits(bothModels, "nim", "a", "m/x")?.source.rpm).toBe("credential-model");
    expect(resolveConfiguredLimits(bothModels, "nim", null, "m/x")?.rpm).toBe(30);
  });

  it("freezes its result so a caller cannot mutate the resolved view", () => {
    const cfg = load("frozen.json", {
      nim: { base: "https://nim.test/v1", kind: "openai", limits: { rpm: 40 } },
    });
    const resolved = resolveConfiguredLimits(cfg, "nim", null, null);
    expect(resolved).not.toBeNull();
    expect(Object.isFrozen(resolved)).toBe(true);
  });
});

describe("configuredLimitQuotaShape", () => {
  it("maps every axis onto the quota-observation vocabulary", () => {
    expect(configuredLimitQuotaShape("rpm")).toEqual({ axis: "requests", period: "minute" });
    expect(configuredLimitQuotaShape("rpd")).toEqual({ axis: "requests", period: "day" });
    expect(configuredLimitQuotaShape("tpm")).toEqual({ axis: "tokens", period: "minute" });
    expect(configuredLimitQuotaShape("tpd")).toEqual({ axis: "tokens", period: "day" });
  });
});
