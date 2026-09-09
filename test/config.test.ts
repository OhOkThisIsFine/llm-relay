import { describe, it, expect, afterAll, vi } from "vitest";
import { readFileSync, statSync, writeFileSync, mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  loadConfig,
  resolveTarget,
  resolveTargets,
  reshaperForTarget,
  isSubagentRequest,
  subagentSpec,
  offloadRule,
  clientForPath,
} from "../src/config.js";
import { candidateEnvNames } from "../src/authEnv.js";
import { addEntry, lock, type KeystoreOptions } from "../src/keystore.js";
import type { KeyringSpawnSync } from "../src/os-keyring.js";

// Eager (not in beforeAll) so describe-body loadConfig(write(...)) calls work at collection.
const dir = mkdtempSync(join(tmpdir(), "rp-cfg-"));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

function write(name: string, obj: unknown): string {
  const p = join(dir, name);
  writeFileSync(p, JSON.stringify(obj));
  return p;
}

// A minimal valid multi-provider config: one openai provider + a default route.
function base(extra: Record<string, unknown> = {}) {
  return {
    listen: "127.0.0.1:8791",
    providers: { nim: { base: "https://nim.test/v1", kind: "openai", authEnv: "NVIDIA_API_KEY" } },
    routing: { default: "nim/z-ai/glm-5.2" },
    ...extra,
  };
}

function saveAndClearEnv(names: string[]): Record<string, string | undefined> {
  const saved: Record<string, string | undefined> = {};
  for (const name of names) {
    saved[name] = process.env[name];
    delete process.env[name];
  }
  return saved;
}

function restoreEnv(saved: Record<string, string | undefined>): void {
  for (const [name, value] of Object.entries(saved)) {
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
  }
}

function keystoreFileStat(path: string): { mtimeMs: number; size: number; ino: number } {
  const stat = statSync(path);
  return { mtimeMs: stat.mtimeMs, size: stat.size, ino: stat.ino };
}

const geminiEnvSaved = saveAndClearEnv(candidateEnvNames("gemini", "GEMINI_API_KEY"));

describe("config keystore diagnostics and resolution scope", () => {
  it("threads one custom store/clock/filesystem seam through list, slot resolution, and status", () => {
    const envName = "CONFIG_CUSTOM_STORE_KEY";
    const saved = saveAndClearEnv(candidateEnvNames("custom", envName));
    const storePath = join(dir, "custom-warning-keystore.json");
    const passphrase = "custom warning store passphrase";
    try {
      addEntry({
        id: "custom#stored",
        provider: "custom",
        envName,
        value: "custom-store-secret",
        expiresAt: 1_000,
      }, {
        path: storePath,
        mode: "passphrase",
        passphrase,
        now: 100,
      });
      lock({ path: storePath });

      const statFile = vi.fn((candidatePath: string) => keystoreFileStat(candidatePath));
      const readFile = vi.fn((candidatePath: string) => readFileSync(candidatePath, "utf8"));
      const keystoreOptions: KeystoreOptions = {
        path: storePath,
        mode: "passphrase",
        passphrase: "wrong passphrase",
        now: 500,
        statFile,
        readFile,
      };
      const configPath = write("custom-warning-store.json", {
        listen: "127.0.0.1:8791",
        providers: {
          custom: { base: "https://custom.test/v1", kind: "openai", authEnv: envName },
        },
        routing: { default: "custom/model" },
      });

      const cfg = loadConfig(configPath, {}, keystoreOptions);
      expect((cfg.warnings ?? []).join("\n")).toMatch(
        /provider "custom" credential custody locked.*relay retries automatically/is,
      );
      // listEntries, resolveCredentialSlot, and keystoreStatus each observe this exact custom
      // path. The parsed store itself is read only once because its stat token is unchanged.
      expect(statFile).toHaveBeenCalledTimes(3);
      expect(readFile).toHaveBeenCalledTimes(1);

      const afterExpiry = loadConfig(configPath, {}, { ...keystoreOptions, now: 1_000 });
      expect((afterExpiry.warnings ?? []).some((warning) => warning.includes("credential custody")))
        .toBe(false);
    } finally {
      lock({ path: storePath });
      restoreEnv(saved);
    }
  });

  it("does not unwrap or query status when no provider is affected", () => {
    const envName = "CONFIG_STATUS_GATE_KEY";
    const saved = saveAndClearEnv(candidateEnvNames("status-gate", envName));
    const storePath = join(dir, "status-gate-keystore.json");
    const createSpawn = vi.fn<KeyringSpawnSync>(() => ({
      status: 0,
      stdout: Buffer.alloc(0),
      stderr: Buffer.alloc(0),
    }));
    try {
      addEntry({
        id: "status-gate#stored",
        provider: "status-gate",
        envName,
        value: "stored-status-gate-secret",
      }, {
        path: storePath,
        mode: "libsecret",
        platform: "linux",
        spawnSync: createSpawn,
        randomBytes: (size) => Buffer.alloc(size, 0x42),
        now: 100,
      });
      lock({ path: storePath });
      process.env[envName] = "present-in-env";

      const unwrapSpawn = vi.fn<KeyringSpawnSync>(() => {
        throw new Error("status must not unwrap an unaffected store");
      });
      const cfg = loadConfig(write("status-gate.json", {
        listen: "127.0.0.1:8791",
        providers: {
          "status-gate": {
            base: "https://status-gate.test/v1",
            kind: "openai",
            authEnv: envName,
          },
        },
        routing: { default: "status-gate/model" },
      }), {}, {
        path: storePath,
        mode: "libsecret",
        platform: "linux",
        spawnSync: unwrapSpawn,
        now: 200,
      });

      expect(unwrapSpawn).not.toHaveBeenCalled();
      expect((cfg.warnings ?? []).some((warning) => warning.includes("keystore"))).toBe(false);
    } finally {
      lock({ path: storePath });
      restoreEnv(saved);
    }
  });

  it("shares one store observation across every target in a walk and re-stats on the next walk", () => {
    const providerCount = 8;
    const envNames = Array.from({ length: providerCount }, (_, index) => `CONFIG_WALK_KEY_${index}`);
    const saved = saveAndClearEnv(envNames);
    const storePath = join(dir, "resolve-targets-walk-keystore.json");
    const passphrase = "resolve targets walk passphrase";
    try {
      const providers = Object.fromEntries(envNames.map((authEnv, index) => [
        `walk${index}`,
        { base: `https://walk${index}.test/v1`, kind: "openai", authEnv },
      ]));
      const specs = envNames.map((_authEnv, index) => `walk${index}/model`);
      const cfg = loadConfig(write("resolve-targets-walk.json", {
        listen: "127.0.0.1:8791",
        providers,
        routing: { default: specs, benchmarkSort: false },
      }));

      addEntry({
        id: `walk${providerCount - 1}#stored`,
        provider: `walk${providerCount - 1}`,
        envName: envNames[providerCount - 1]!,
        value: "walk-scoped-secret",
      }, {
        path: storePath,
        mode: "passphrase",
        passphrase,
      });
      lock({ path: storePath });

      const statFile = vi.fn((candidatePath: string) => keystoreFileStat(candidatePath));
      const readFile = vi.fn((candidatePath: string) => readFileSync(candidatePath, "utf8"));
      const keystoreOptions: KeystoreOptions = {
        path: storePath,
        mode: "passphrase",
        passphrase,
        statFile,
        readFile,
      };

      for (let request = 0; request < 3; request += 1) {
        expect(resolveTargets(null, cfg, keystoreOptions).map((target) => target.provider))
          .toEqual([`walk${providerCount - 1}`]);
      }

      expect(statFile).toHaveBeenCalledTimes(3);
      expect(readFile).toHaveBeenCalledTimes(1);
      expect(keystoreOptions.resolutionWalk).toBeUndefined();
    } finally {
      lock({ path: storePath });
      restoreEnv(saved);
    }
  });

  it("shares an unreadable verdict across every target in each request walk", () => {
    const providerCount = 8;
    const envNames = Array.from(
      { length: providerCount },
      (_, index) => `CONFIG_UNREADABLE_WALK_KEY_${index}`,
    );
    const saved = saveAndClearEnv(envNames);
    const storePath = join(dir, "resolve-targets-unreadable-walk-keystore.json");
    try {
      const providers = Object.fromEntries(envNames.map((authEnv, index) => [
        `unreadable-walk${index}`,
        { base: `https://unreadable-walk${index}.test/v1`, kind: "openai", authEnv },
      ]));
      const specs = envNames.map((_authEnv, index) => `unreadable-walk${index}/model`);
      const cfg = loadConfig(write("resolve-targets-unreadable-walk.json", {
        listen: "127.0.0.1:8791",
        providers,
        routing: { default: specs, benchmarkSort: false },
      }));
      writeFileSync(storePath, "{", "utf8");

      const statFile = vi.fn((candidatePath: string) => keystoreFileStat(candidatePath));
      const readFile = vi.fn((candidatePath: string) => readFileSync(candidatePath, "utf8"));
      const keystoreOptions: KeystoreOptions = {
        path: storePath,
        mode: "passphrase",
        passphrase: "unused for an unreadable store",
        now: 0,
        statFile,
        readFile,
      };

      for (let request = 0; request < 3; request += 1) {
        expect(resolveTargets(null, cfg, keystoreOptions).map((target) => target.provider))
          .toEqual(envNames.map((_envName, index) => `unreadable-walk${index}`));
      }

      expect(statFile).toHaveBeenCalledTimes(3);
      expect(readFile).toHaveBeenCalledTimes(1);
      expect(keystoreOptions.resolutionWalk).toBeUndefined();
    } finally {
      lock({ path: storePath });
      restoreEnv(saved);
    }
  });
});

describe("loadConfig — sticky session affinity", () => {
  it("is off by default and normalizes boolean shorthand", () => {
    expect(loadConfig(write("sticky-absent.json", base())).routing.sticky).toBeUndefined();
    expect(loadConfig(write("sticky-on.json", base({
      routing: { default: "nim/z-ai/glm-5.2", sticky: true },
    }))).routing.sticky).toEqual({ enabled: true, ttlMs: 1_800_000, maxSessions: 1000 });
    expect(loadConfig(write("sticky-off.json", base({
      routing: { default: "nim/z-ai/glm-5.2", sticky: false },
    }))).routing.sticky).toEqual({ enabled: false, ttlMs: 1_800_000, maxSessions: 1000 });
  });

  it("validates and normalizes the bounded object form", () => {
    expect(loadConfig(write("sticky-object.json", base({
      routing: {
        default: "nim/z-ai/glm-5.2",
        sticky: { enabled: true, ttlMs: 2500.9, maxSessions: 20.9 },
      },
    }))).routing.sticky).toEqual({ enabled: true, ttlMs: 2500, maxSessions: 20 });

    const invalid = [
      ["sticky-kind.json", "yes", /boolean or an object/],
      ["sticky-enabled.json", {}, /sticky.enabled must be a boolean/],
      ["sticky-ttl-low.json", { enabled: true, ttlMs: 999 }, /ttlMs must be between/],
      ["sticky-ttl-high.json", { enabled: true, ttlMs: 86_400_001 }, /ttlMs must be between/],
      ["sticky-cap-low.json", { enabled: true, maxSessions: 9 }, /maxSessions must be an integer/],
      ["sticky-cap-high.json", { enabled: true, maxSessions: 100_001 }, /maxSessions must be an integer/],
    ] as const;
    for (const [name, sticky, message] of invalid) {
      expect(() => loadConfig(write(name, base({
        routing: { default: "nim/z-ai/glm-5.2", sticky },
      })))).toThrow(message);
    }
  });
});

describe("loadConfig — credentialMode (declared vs inferred passthrough)", () => {
  const withProviders = (name: string, providers: Record<string, unknown>) =>
    loadConfig(write(name, base({ providers, routing: { default: "anthropic" } })));

  it("warns when an anthropic-kind provider forwards the caller's credential by omission", () => {
    const c = withProviders("cred-inferred.json", {
      anthropic: { base: "https://api.anthropic.com", kind: "anthropic" },
    });
    // Warn, never fail: this proxy fronts every client session, so a hardening step that
    // refuses to start would be an outage.
    expect(c.warnings?.some((w) => /forwards the CALLER's own credential/.test(w))).toBe(true);
    expect(c.providers.anthropic!.credentialMode).toBeUndefined();
  });

  it("stays silent once the intent is declared, either way", () => {
    const pass = withProviders("cred-declared.json", {
      anthropic: { base: "https://api.anthropic.com", kind: "anthropic", credentialMode: "passthrough" },
    });
    expect(pass.warnings?.some((w) => /forwards the CALLER/.test(w)) ?? false).toBe(false);
    expect(pass.providers.anthropic!.credentialMode).toBe("passthrough");

    const contained = loadConfig(write("cred-contained.json", base({
      providers: { peer: { base: "https://peer.test", kind: "anthropic", credentialMode: "contained" } },
      routing: { default: "peer" },
    })));
    expect(contained.warnings?.some((w) => /forwards the CALLER/.test(w)) ?? false).toBe(false);
    expect(contained.providers.peer!.credentialMode).toBe("contained");
  });

  it("never warns for an openai-kind keyless provider — it cannot receive inbound credentials", () => {
    // `fetchBackend`'s openai path builds a fresh header map (`buildTargetHeaders`), so nothing
    // inbound reaches it. Warning about `ollama` would be a false alarm, and a false alarm here
    // teaches the operator to ignore the true one above.
    const c = loadConfig(write("cred-ollama.json", base({
      providers: { ollama: { base: "http://localhost:11434/v1", kind: "openai" } },
      routing: { default: "ollama/qwen2.5-coder:32b" },
    })));
    expect(c.warnings?.some((w) => /forwards the CALLER/.test(w)) ?? false).toBe(false);
  });

  it("rejects a provider that claims both credentialMode passthrough and its own authEnv", () => {
    expect(() => withProviders("cred-conflict.json", {
      anthropic: { base: "https://api.anthropic.com", kind: "anthropic", credentialMode: "passthrough", authEnv: "X_KEY" },
    })).toThrow(/declare exactly one/);
  });

  it("rejects an unrecognized credentialMode instead of silently ignoring it", () => {
    expect(() => withProviders("cred-typo.json", {
      anthropic: { base: "https://api.anthropic.com", kind: "anthropic", credentialMode: "contain" },
    })).toThrow(/credentialMode must be/);
  });

  it("carries the mode onto the resolved target", () => {
    const c = withProviders("cred-resolved.json", {
      anthropic: { base: "https://api.anthropic.com", kind: "anthropic", credentialMode: "passthrough" },
    });
    expect(resolveTarget("claude-opus-5", c).credentialMode).toBe("passthrough");
  });
});

describe("loadConfig — authEnv alias resolution", () => {
  it("keeps the declared authEnv when that variable is the one set", () => {
    process.env.GEMINI_API_KEY = "declared";
    const c = loadConfig(write("env-declared.json", base({
      providers: { gemini: { base: "https://g.test/v1", kind: "openai", authEnv: "GEMINI_API_KEY" } },
      routing: { default: "gemini/gemini-2.5-flash" },
    })));
    expect(c.providers.gemini!.authEnv).toBe("GEMINI_API_KEY");
    restoreEnv(geminiEnvSaved);
  });

  it("retains the declared authEnv when an alias supplies the credential", () => {
    delete process.env.GEMINI_API_KEY;
    process.env.GOOGLEAI_API_KEY = "alias";
    const c = loadConfig(write("env-alias.json", base({
      providers: { gemini: { base: "https://g.test/v1", kind: "openai", authEnv: "GEMINI_API_KEY" } },
      routing: { default: "gemini/gemini-2.5-flash" },
    })));
    expect(c.providers.gemini!.authEnv).toBe("GEMINI_API_KEY");
    restoreEnv(geminiEnvSaved);
  });
});

describe("loadConfig — blank authEnv", () => {
  it("omits blank and whitespace authEnv while preserving passthrough", () => {
    for (const authEnv of ["", "   "]) {
      const c = loadConfig(write(`blank-auth-${authEnv.length}.json`, base({
        providers: { peer: { base: "https://peer.test", kind: "anthropic", authEnv, credentialMode: "passthrough" } },
        routing: { default: "peer" },
      })));
      expect(c.providers.peer!.authEnv).toBeUndefined();
      expect(c.providers.peer!.credentialMode).toBe("passthrough");
    }
  });
});

describe("loadConfig — listen + providers", () => {
  it("accepts 127.0.0.1 and defaults provider authHeader/timeout", () => {
    const c = loadConfig(write("a.json", base()));
    expect(c.host).toBe("127.0.0.1");
    expect(c.port).toBe(8791);
    expect(c.providers.nim!.authHeader).toBe("authorization"); // openai default
    expect(c.providers.nim!.timeoutMs).toBe(120000);
  });

  it("preserves provider tier metadata used by automatic free-model pools", () => {
    const c = loadConfig(write("provider-tier.json", base({
      providers: {
        nim: {
          base: "https://nim.test/v1",
          kind: "openai",
          tierType: "free",
          signupUrl: "https://build.nvidia.com",
        },
        openrouter: {
          base: "https://openrouter.test/v1",
          kind: "openai",
          tierType: "mixed",
        },
      },
    })));
    expect(c.providers.nim?.tierType).toBe("free");
    expect(c.providers.nim?.signupUrl).toBe("https://build.nvidia.com");
    expect(c.providers.openrouter?.tierType).toBe("mixed");
  });

  it("defaults an anthropic provider's authHeader to x-api-key", () => {
    const c = loadConfig(write("anth.json", {
      listen: "127.0.0.1:8791",
      providers: { claude: { base: "https://api.anthropic.test", kind: "anthropic" } },
      routing: { default: "claude" },
    }));
    expect(c.providers.claude!.authHeader).toBe("x-api-key");
  });

  it("accepts bracketed IPv6 loopback [::1]", () => {
    const c = loadConfig(write("b.json", base({ listen: "[::1]:8791" })));
    expect(c.host).toBe("::1");
  });

  it("rejects a non-loopback bind", () => {
    expect(() => loadConfig(write("c.json", base({ listen: "0.0.0.0:8791" })))).toThrow(/loopback/);
  });

  it("rejects an out-of-range port", () => {
    expect(() => loadConfig(write("d.json", base({ listen: "127.0.0.1:99999" })))).toThrow(/port/);
  });

  it("requires at least one provider", () => {
    expect(() => loadConfig(write("e.json", { listen: "127.0.0.1:8791", routing: { default: "x/y" } }))).toThrow(/providers/);
  });

  it("requires routing.default", () => {
    expect(() => loadConfig(write("f.json", {
      listen: "127.0.0.1:8791",
      providers: { nim: { base: "https://nim.test/v1", kind: "openai" } },
    }))).toThrow(/routing\.default/);
  });

  it("rejects a default that names an unknown provider", () => {
    expect(() => loadConfig(write("g.json", base({ routing: { default: "ghost/model" } })))).toThrow(/unknown provider "ghost"/);
  });

  it("rejects a tier that names an unknown provider", () => {
    expect(() => loadConfig(write("h.json", base({ routing: { default: "nim/m", tiers: { opus: "ghost/m" } } })))).toThrow(/unknown provider "ghost"/);
  });

  it("honors authHeader override on a provider", () => {
    const c = loadConfig(write("i.json", {
      listen: "127.0.0.1:8791",
      providers: { nim: { base: "https://nim.test/v1", kind: "openai", authHeader: "x-api-key" } },
      routing: { default: "nim/m" },
    }));
    expect(c.providers.nim!.authHeader).toBe("x-api-key");
  });

  it("rejects Infinity maxAttempts and falls back to default 2", () => {
    const c = loadConfig(write("infinity.json", base({ repair: { maxAttempts: Infinity } })));
    expect(c.repair.maxAttempts).toBe(2);
  });
});

describe("resolveTarget — namespace, tier, default routing", () => {
  const cfg = loadConfig(write("route.json", {
    listen: "127.0.0.1:8791",
    providers: {
      nim: { base: "https://nim.test/v1", kind: "openai", authEnv: "NVIDIA_API_KEY" },
      openrouter: { base: "https://or.test/api/v1", kind: "openai", authEnv: "OPENROUTER_API_KEY" },
    },
    routing: {
      default: "nim/z-ai/glm-5.2",
      tiers: { opus: "openrouter/openai/gpt-5.2-codex", haiku: "nim/openai/gpt-oss-20b" },
    },
  }));

  it("routes a namespaced model to its provider, model tail kept verbatim (nested slashes)", () => {
    const t = resolveTarget("nim/z-ai/glm-5.2", cfg);
    expect(t.provider).toBe("nim");
    expect(t.model).toBe("z-ai/glm-5.2");
    expect(t.base).toBe("https://nim.test/v1");
    expect(t.authEnv).toBe("NVIDIA_API_KEY");
  });

  it("routes a Claude tier via substring match", () => {
    const t = resolveTarget("claude-opus-4-6-thinking", cfg);
    expect(t.provider).toBe("openrouter");
    expect(t.model).toBe("openai/gpt-5.2-codex");
  });

  it("maps a haiku side-call to the configured cheap model (fixes the warmup 404)", () => {
    const t = resolveTarget("claude-3-5-haiku-20241022", cfg);
    expect(t.provider).toBe("nim");
    expect(t.model).toBe("openai/gpt-oss-20b");
  });

  it("falls back to routing.default for an unrecognized model", () => {
    const t = resolveTarget("some-random-model", cfg);
    expect(t.provider).toBe("nim");
    expect(t.model).toBe("z-ai/glm-5.2");
  });

  it("treats a non-provider namespace as unrecognized → default", () => {
    // "meta" is not a configured provider and no tier matches → default.
    const t = resolveTarget("meta/llama-3.1-70b", cfg);
    expect(t.provider).toBe("nim");
    expect(t.model).toBe("z-ai/glm-5.2");
  });

  it("treats a non-provider namespace with a tier substring as unrecognized → default", () => {
    // "unknown-provider" is not configured; even if the model contains "haiku", it falls back to default.
    const t = resolveTarget("unknown-provider/llama-haiku-70b", cfg);
    expect(t.provider).toBe("nim");
    expect(t.model).toBe("z-ai/glm-5.2");
  });

  it("routes a bare provider name (no slash) as unrecognized → default", () => {
    // "nim" has no "/", so it isn't a namespace pin — it falls through to default.
    const t = resolveTarget("nim", cfg);
    expect(t.model).toBe("z-ai/glm-5.2");
  });

  it("throws RoutingError when a namespace pins an openai provider with an empty model", () => {
    expect(() => resolveTarget("nim/", cfg)).toThrow(/needs a model/);
  });
});

describe("resolveTargets — pool/<name> ranked routing", () => {
  const poolCfg = loadConfig(write("pools.json", {
    listen: "127.0.0.1:8791",
    providers: {
      nim: { base: "https://nim.test/v1", kind: "openai", authEnv: "NVIDIA_API_KEY" },
      openrouter: { base: "https://or.test/api/v1", kind: "openai", authEnv: "OPENROUTER_API_KEY" },
      anthropic: { base: "https://api.anthropic.com", kind: "anthropic" },
    },
    routing: {
      default: "anthropic",
      tiers: { opus: "anthropic", sonnet: "anthropic", haiku: "anthropic", fable: "anthropic" },
      pools: {
        coding: ["nim/z-ai/glm-5.2", "openrouter/openai/gpt-5.2-codex", "nim/deepseek-ai/deepseek-v4-pro"],
        cheap: ["nim/openai/gpt-oss-20b"],
      },
      // Ranking is orthogonal to pool expansion; pin it off so the assertions below are about
      // membership, not about today's benchmark table.
      benchmarkSort: false,
    },
  }));

  it("expands a pool to ALL its candidates (so ranking + failover have something to walk)", () => {
    const ts = resolveTargets("pool/coding", poolCfg);
    expect(ts).toHaveLength(3);
    expect(ts.map((t) => `${t.provider}/${t.model}`)).toEqual([
      "nim/z-ai/glm-5.2",
      "openrouter/openai/gpt-5.2-codex",
      "nim/deepseek-ai/deepseek-v4-pro",
    ]);
  });

  it("supports a single-candidate pool", () => {
    const ts = resolveTargets("pool/cheap", poolCfg);
    expect(ts).toHaveLength(1);
    expect(ts[0]!.model).toBe("openai/gpt-oss-20b");
  });

  it("preserves valid dynamic-pool effort policies and rejects unknown levels", () => {
    const valid = loadConfig(write("effort-pool.json", base({
      routing: {
        default: "nim/m",
        pools: { medium: { preferred: [], include: "free", effort: "medium" } },
      },
    })));
    expect(valid.routing.poolPolicies?.medium).toEqual({
      preferred: [], include: "free", effort: "medium",
    });

    expect(() => loadConfig(write("bad-effort-pool.json", base({
      routing: {
        default: "nim/m",
        pools: { medium: { preferred: [], include: "free", effort: "turbo" } },
      },
    })))).toThrow(/effort must be low, medium, high, or xhigh/);
  });

  it("validates dynamic-pool exclude tombstones without resolving their providers", () => {
    const valid = loadConfig(write("exclude-pool.json", base({
      routing: {
        default: "nim/m",
        pools: {
          medium: {
            preferred: ["nim/keep", "gone/old-model"],
            include: "free",
            exclude: ["gone/old-model", "retired/unknown-model"],
          },
        },
      },
    })));
    expect(valid.routing.poolPolicies?.medium).toEqual({
      preferred: ["nim/keep"],
      include: "free",
      exclude: ["gone/old-model", "retired/unknown-model"],
    });
    expect(valid.routing.pools?.medium).toEqual(["nim/keep"]);

    for (const [index, exclude] of ["nim", "pool/other", ["nim/good", 42]].entries()) {
      expect(() => loadConfig(write(`bad-exclude-${index}.json`, base({
        routing: {
          default: "nim/m",
          pools: { medium: { preferred: [], include: "free", exclude } },
        },
      })))).toThrow(/exclude must be an array of "provider\/model" specs/);
    }
  });

  it("FAILS LOUDLY on an unknown pool instead of silently using routing.default", () => {
    // The whole point: a typo'd pool must not quietly succeed against a different model.
    expect(() => resolveTargets("pool/nope", poolCfg)).toThrow(/no pool "nope" configured/);
  });

  it("does not treat a tier or namespaced spec as a pool", () => {
    expect(resolveTarget("claude-opus-5", poolCfg).provider).toBe("anthropic");
    expect(resolveTarget("nim/z-ai/glm-5.2", poolCfg).model).toBe("z-ai/glm-5.2");
  });

  it("routes every Claude tier to the anthropic passthrough with no model id", () => {
    // Passthrough targets carry no model — the client's own model id is forwarded upstream.
    for (const m of ["claude-opus-5", "claude-sonnet-4-5", "claude-haiku-4-5", "claude-fable-5"]) {
      const t = resolveTarget(m, poolCfg);
      expect(t.provider).toBe("anthropic");
      expect(t.kind).toBe("anthropic");
      expect(t.model).toBeUndefined();
    }
  });

  it("rejects a pool naming an unknown provider at load time", () => {
    expect(() => loadConfig(write("badpool.json", base({
      routing: { default: "nim/m", pools: { x: ["ghost/m"] } },
    })))).toThrow(/unknown provider "ghost"/);
  });

  it("rejects an empty pool at load time", () => {
    expect(() => loadConfig(write("emptypool.json", base({
      routing: { default: "nim/m", pools: { x: [] } },
    })))).toThrow(/at least one valid spec/);
  });

  it("rejects a provider literally named \"pool\" (it would shadow pool/<name>)", () => {
    expect(() => loadConfig(write("poolprovider.json", {
      listen: "127.0.0.1:8791",
      providers: { pool: { base: "https://x.test/v1", kind: "openai", authEnv: "NVIDIA_API_KEY" } },
      routing: { default: "pool/m" },
    }))).toThrow(/reserved/);
  });

  it("expands a pool referenced from routing.tiers (pools work uniformly, not just as inbound models)", () => {
    const c = loadConfig(write("tierpool.json", {
      listen: "127.0.0.1:8791",
      providers: {
        nim: { base: "https://nim.test/v1", kind: "openai", authEnv: "NVIDIA_API_KEY" },
        anthropic: { base: "https://api.anthropic.com", kind: "anthropic" },
      },
      routing: {
        default: "anthropic",
        tiers: { haiku: "pool/cheap" },
        pools: { cheap: ["nim/openai/gpt-oss-20b"] },
        benchmarkSort: false,
      },
    }));
    const ts = resolveTargets("claude-haiku-4-5", c);
    expect(ts.map((t) => `${t.provider}/${t.model}`)).toEqual(["nim/openai/gpt-oss-20b"]);
  });

  it("rejects a tier naming an unknown pool at load time", () => {
    expect(() => loadConfig(write("tierbadpool.json", base({
      routing: { default: "nim/m", tiers: { haiku: "pool/nope" } },
    })))).toThrow(/unknown pool "nope"/);
  });

  it("rejects a subagent target naming an unknown pool at load time (not first request)", () => {
    expect(() => loadConfig(write("subbadpool.json", base({
      routing: { default: "nim/m", subagents: { opus: "pool/nope" } },
    })))).toThrow(/unknown pool "nope"/);
  });

  it("rejects a subagent target naming an unknown provider at load time", () => {
    expect(() => loadConfig(write("subbadprov.json", base({
      routing: { default: "nim/m", subagents: { opus: "ghost/m" } },
    })))).toThrow(/unknown provider "ghost"/);
  });

  it("rejects a pool member that references another pool (no recursion)", () => {
    expect(() => loadConfig(write("poolinpool.json", base({
      routing: { default: "nim/m", pools: { a: ["nim/m"], b: ["pool/a"] } },
    })))).toThrow(/cannot reference another pool/);
  });
});

describe("subagent-aware routing", () => {
  const SUB = "x-anthropic-billing-header: cc_version=2.1.220.e23; cc_entrypoint=sdk-cli; cc_is_subagent=true;\nYou are a Claude agent.";
  const MAIN = "x-anthropic-billing-header: cc_version=2.1.220.337; cc_entrypoint=sdk-cli;\nYou are a Claude agent.";

  const cfg = loadConfig(write("subagents.json", {
    listen: "127.0.0.1:8791",
    providers: {
      anthropic: { base: "https://api.anthropic.com", kind: "anthropic" },
      nim: { base: "https://nim.test/v1", kind: "openai", authEnv: "NVIDIA_API_KEY" },
    },
    routing: {
      default: "anthropic",
      tiers: { opus: "anthropic", sonnet: "anthropic", haiku: "anthropic", fable: "anthropic" },
      pools: { coding: ["nim/z-ai/glm-5.2"], fast: ["nim/openai/gpt-oss-20b"] },
      subagents: { opus: "pool/coding", haiku: "pool/fast", default: "pool/coding" },
      offload: true,
      benchmarkSort: false,
    },
  }));

  // Same routing, offload switch OFF — the shipped default.
  const cfgOff = loadConfig(write("subagents-off.json", {
    listen: "127.0.0.1:8791",
    providers: {
      anthropic: { base: "https://api.anthropic.com", kind: "anthropic" },
      nim: { base: "https://nim.test/v1", kind: "openai", authEnv: "NVIDIA_API_KEY" },
    },
    routing: {
      default: "anthropic",
      tiers: { opus: "anthropic", sonnet: "anthropic", haiku: "anthropic", fable: "anthropic" },
      pools: { coding: ["nim/z-ai/glm-5.2"], fast: ["nim/openai/gpt-oss-20b"] },
      subagents: { opus: "pool/coding", haiku: "pool/fast", default: "pool/coding" },
      benchmarkSort: false,
    },
  }));

  const msg = (...texts: string[]) => ({
    system: SUB,
    messages: [{ role: "user", content: texts.map((t) => ({ type: "text", text: t })) }],
  });

  it("detects a subagent request only when the marker is present", () => {
    expect(isSubagentRequest({ system: SUB })).toBe(true);
    expect(isSubagentRequest({ system: MAIN })).toBe(false);
    expect(isSubagentRequest({ system: [{ type: "text", text: SUB }] })).toBe(true);
    expect(isSubagentRequest({})).toBe(false);
  });

  it("detects a Claude subagent from the documented agent-id header, with no marker present", () => {
    // Two independent signals, either sufficient. The header survives
    // CLAUDE_CODE_ATTRIBUTION_HEADER=0 (which removes the marker); the marker survives middleware
    // that filters unknown request headers (which removes the header). Neither alone is safe, and
    // the shared failure mode is silent: an undetected subagent spends primary quota.
    expect(isSubagentRequest({ system: MAIN }, { "x-claude-code-agent-id": "agent_01ABC" })).toBe(true);
    expect(isSubagentRequest({}, { "X-Claude-Code-Agent-Id": "agent_01ABC" })).toBe(true);
    expect(isSubagentRequest({ system: SUB }, {})).toBe(true);
    // Presence is the signal, so an empty value is not one.
    expect(isSubagentRequest({ system: MAIN }, { "x-claude-code-agent-id": "  " })).toBe(false);
    // The parent header travels only WITH an agent id; on its own it says nothing.
    expect(isSubagentRequest({ system: MAIN }, { "x-claude-code-parent-agent-id": "agent_01ABC" })).toBe(false);
  });

  it("detects Codex child turns from explicit request metadata only", () => {
    const childHeaders = { "x-codex-turn-metadata": JSON.stringify({ request_kind: "subagent" }) };
    const mainHeaders = { "x-codex-turn-metadata": JSON.stringify({ request_kind: "turn" }) };
    expect(isSubagentRequest({}, childHeaders)).toBe(true);
    expect(isSubagentRequest({}, mainHeaders)).toBe(false);
    expect(isSubagentRequest({}, { "x-codex-turn-metadata": "not-json" })).toBe(false);
    expect(isSubagentRequest({}, { "x-codex-turn-metadata": JSON.stringify({ request_kind: "other" }) })).toBe(false);
  });

  it("routes a Codex child turn through the same subagent map", () => {
    const childHeaders = { "x-codex-turn-metadata": JSON.stringify({ request_kind: "subagent" }) };
    const mainHeaders = { "x-codex-turn-metadata": JSON.stringify({ request_kind: "turn" }) };
    expect(subagentSpec({ model: "pool/reasoning" }, "pool/reasoning", cfg, childHeaders)).toBe("pool/coding");
    expect(subagentSpec({ model: "pool/reasoning" }, "pool/reasoning", cfg, mainHeaders)).toBeNull();
  });

  it("leaves MAIN-conversation requests entirely alone (tiers stay on passthrough)", () => {
    const main = { system: MAIN, messages: [{ role: "user", content: [{ type: "text", text: "@relay: pool/coding" }] }] };
    // Even a literal directive must not reroute a human's own conversation.
    expect(subagentSpec(main, "claude-opus-5", cfg)).toBeNull();
    expect(resolveTarget("claude-opus-5", cfg).provider).toBe("anthropic");
  });

  it("offload defaults to OFF — routing.offload absent means the map is inert", () => {
    expect(cfgOff.routing.offload).toBe(false);
    // Same request that lands on pool/coding with offload on must pass straight through.
    expect(subagentSpec(msg("find the bug"), "claude-opus-5", cfgOff)).toBeNull();
    expect(subagentSpec(msg("list files"), "claude-haiku-4-5", cfgOff)).toBeNull();
    expect(subagentSpec(msg("do a thing"), "some-unknown-model", cfgOff)).toBeNull();
    expect(resolveTarget("claude-opus-5", cfgOff).provider).toBe("anthropic");
  });

  it("honours an explicit @relay directive even while offload is OFF (per-call opt-in)", () => {
    expect(subagentSpec(msg("@relay: pool/fast\nlist files"), "claude-opus-5", cfgOff)).toBe("pool/fast");
    // …and still strips it, so the off path can't leak the directive to the model either.
    const body = msg("@relay: nim/z-ai/glm-5.2\nsummarise this");
    subagentSpec(body, "claude-opus-5", cfgOff);
    expect(body.messages[0]!.content[0]!.text).toBe("summarise this");
  });

  it("maps a subagent tier to its pool", () => {
    expect(subagentSpec(msg("find the bug"), "claude-opus-5", cfg)).toBe("pool/coding");
    expect(subagentSpec(msg("list files"), "claude-haiku-4-5", cfg)).toBe("pool/fast");
  });

  it("falls back to subagents.default when no tier matches", () => {
    expect(subagentSpec(msg("do a thing"), "some-unknown-model", cfg)).toBe("pool/coding");
  });

  it("lets an explicit @relay directive beat the tier map", () => {
    expect(subagentSpec(msg("@relay: nim/z-ai/glm-5.2\nfind the bug"), "claude-haiku-4-5", cfg))
      .toBe("nim/z-ai/glm-5.2");
  });

  it("STRIPS the directive so the model never sees it", () => {
    const body = msg("@relay: pool/fast\nsummarise this");
    subagentSpec(body, "claude-opus-5", cfg);
    expect(body.messages[0]!.content[0]!.text).toBe("summarise this");
  });

  it("reads the directive ONLY from the dispatcher's prompt (last block), not injected context", () => {
    // Block 0 is Claude Code's <system-reminder> (CLAUDE.md etc). A directive there is NOT the
    // dispatcher speaking, so it must be ignored — otherwise any CLAUDE.md could reroute agents.
    const body = msg("<system-reminder>@relay: nim/z-ai/glm-5.2</system-reminder>", "do the task");
    expect(subagentSpec(body, "claude-opus-5", cfg)).toBe("pool/coding");
  });

  it("ignores a directive arriving in a later message (i.e. in a tool result / file content)", () => {
    // A file the subagent reads must never be able to redirect its own routing.
    const body = {
      system: SUB,
      messages: [
        { role: "user", content: [{ type: "text", text: "do the task" }] },
        { role: "user", content: [{ type: "text", text: "@relay: nim/z-ai/glm-5.2" }] },
      ],
    };
    expect(subagentSpec(body, "claude-opus-5", cfg)).toBe("pool/coding");
  });

  it("does nothing when routing.subagents is absent and no directive is given", () => {
    const plain = loadConfig(write("nosub.json", base({ routing: { default: "nim/m" } })));
    expect(subagentSpec(msg("hi"), "claude-opus-5", plain)).toBeNull();
  });

  it("still honours a directive when routing.subagents is absent", () => {
    const plain = loadConfig(write("nosub2.json", base({ routing: { default: "nim/m" } })));
    expect(subagentSpec(msg("@relay: nim/other\ngo"), "claude-opus-5", plain)).toBe("nim/other");
  });

  // A directive is checked per REQUEST, so it gets none of the load-time validation the
  // routing.subagents map gets. Unchecked, a typo matched no provider and no pool, fell through
  // pickSpecs to routing.default (the Anthropic passthrough) and was answered by PRIMARY quota —
  // while the dispatcher, and the response, both looked like a successful offload.
  it("FAILS LOUDLY on an @relay directive naming an unknown provider", () => {
    expect(() => subagentSpec(msg("@relay: nimm/z-ai/glm-5.2\ngo"), "claude-opus-5", cfg))
      .toThrow(/names unknown provider "nimm"/);
    // …with the switch off too: the directive is the per-call opt-in either way.
    expect(() => subagentSpec(msg("@relay: nimm/z-ai/glm-5.2\ngo"), "claude-opus-5", cfgOff))
      .toThrow(/names unknown provider "nimm"/);
  });

  it("FAILS LOUDLY on an @relay directive naming an unknown pool", () => {
    expect(() => subagentSpec(msg("@relay: pool/codeing\ngo"), "claude-opus-5", cfg))
      .toThrow(/names unknown pool "codeing"/);
  });

  it("FAILS LOUDLY on an @relay directive that omits the model id an openai provider needs", () => {
    expect(() => subagentSpec(msg("@relay: nim\ngo"), "claude-opus-5", cfg))
      .toThrow(/carries no model id/);
  });

  it("does not accept a tier-shaped @relay directive as resolvable (it would mean the passthrough)", () => {
    // `opus-coder` is a typo, not a destination — detectTier would match "opus" and land it on
    // routing.tiers.opus, i.e. primary quota. Refuse instead of quietly billing the human.
    expect(() => subagentSpec(msg("@relay: opus-coder\ngo"), "claude-haiku-4-5", cfg))
      .toThrow(/names unknown provider "opus-coder"/);
  });

  it("never resolves a bad directive to routing.default", () => {
    // The failure mode stated positively: whatever happens, it is not a silent passthrough hit.
    let spec: string | null = "unset";
    try {
      spec = subagentSpec(msg("@relay: ghost/model\ngo"), "claude-opus-5", cfg);
    } catch {
      spec = null;
    }
    expect(spec).toBeNull();
    expect(cfg.routing.default).toBe("anthropic"); // what the silent fall-through used to reach
  });

  it("still accepts a directive naming an anthropic provider with no model id (passthrough is a real target)", () => {
    expect(subagentSpec(msg("@relay: anthropic\ngo"), "claude-opus-5", cfg)).toBe("anthropic");
  });

  it("parses and strips @relay directive when message content is a plain string", () => {
    const strMsg = {
      system: SUB,
      messages: [{ role: "user", content: "@relay: pool/fast\nsummarise this" }],
    };
    expect(subagentSpec(strMsg, "claude-opus-5", cfg)).toBe("pool/fast");
    expect(strMsg.messages[0]!.content).toBe("summarise this");
  });

  it("restricts @relay directive parsing strictly to the prompt text block (last block)", () => {
    const multiMsgIgnored = {
      system: SUB,
      messages: [
        {
          role: "user",
          content: [
            { type: "text", text: "<system-reminder>injected context</system-reminder>" },
            { type: "text", text: "@relay: pool/fast" },
            { type: "text", text: "second block context without directive" },
          ],
        },
      ],
    };
    // The directive in the middle text block must be ignored because the prompt text block is the last one.
    expect(subagentSpec(multiMsgIgnored, "claude-opus-5", cfg)).toBe("pool/coding");

    const multiMsgValid = {
      system: SUB,
      messages: [
        {
          role: "user",
          content: [
            { type: "text", text: "<system-reminder>injected context</system-reminder>" },
            { type: "text", text: "earlier context" },
            { type: "text", text: "@relay: pool/fast\nfinal prompt block" },
          ],
        },
      ],
    };
    expect(subagentSpec(multiMsgValid, "claude-opus-5", cfg)).toBe("pool/fast");
  });
});

describe("client-specific offload routing", () => {
  const SUB = "x-anthropic-billing-header: cc_is_subagent=true;";
  const MAIN = "x-anthropic-billing-header: cc_entrypoint=sdk-cli;";
  const request = (system: string) => ({
    system,
    messages: [{ role: "user", content: [{ type: "text", text: "do the task" }] }],
  });

  it("parses independent client rules and identifies built-in front doors", () => {
    const cfg = loadConfig(write("client-offload.json", base({
      routing: {
        default: "nim/model",
        tiers: { opus: "nim/model" },
        pools: { coding: ["nim/model"] },
        subagents: { default: "pool/coding" },
        offload: {
          claude: { enabled: true, scope: "all" },
          codex: { enabled: false, scope: "subagents" },
        },
      },
    })));

    // ⚠ `freeOnly` stays ABSENT when unset — "unset" and "explicitly false" must remain
    // distinguishable, because unset defaults ON for offload-rerouted traffic and OFF for a
    // directly addressed pool. Materializing a value here would collapse that into one answer.
    expect(cfg.routing.offload).toEqual({
      claude: { enabled: true, scope: "all" },
      codex: { enabled: false, scope: "subagents" },
    });
    expect(offloadRule(cfg, "claude")).toEqual({ enabled: true, scope: "all" });
    expect(offloadRule(cfg, "codex")).toEqual({ enabled: false, scope: "subagents" });
    expect(clientForPath("/v1/messages")).toBe("claude");
    expect(clientForPath("/v1/responses")).toBe("codex");
    expect(clientForPath("/v1/chat/completions")).toBe("openai");
  });

  it("can reroute a Claude main conversation while leaving Codex disabled", () => {
    const cfg = loadConfig(write("client-scope.json", base({
      routing: {
        default: "nim/model",
        tiers: { opus: "nim/model" },
        pools: { coding: ["nim/model"] },
        subagents: { default: "pool/coding" },
        offload: {
          claude: { enabled: true, scope: "all" },
          codex: { enabled: false, scope: "all" },
        },
      },
    })));

    expect(subagentSpec(request(MAIN), "claude-opus-5", cfg, undefined, "claude")).toBe("pool/coding");
    expect(subagentSpec(request(SUB), "codex-model", cfg, undefined, "codex")).toBeNull();
    // A subagents-only rule leaves a main conversation on its normal route.
    cfg.routing.offload = { claude: { enabled: true, scope: "subagents" } };
    expect(subagentSpec(request(MAIN), "claude-opus-5", cfg, undefined, "claude")).toBeNull();
    expect(subagentSpec(request(SUB), "claude-opus-5", cfg, undefined, "claude")).toBe("pool/coding");
  });

  it("accepts an explicit default rule for future front doors", () => {
    const cfg = loadConfig(write("client-default.json", base({
      routing: {
        default: "nim/model",
        pools: { coding: ["nim/model"] },
        subagents: { default: "pool/coding" },
        offload: { default: { enabled: true, scope: "all" } },
      },
    })));
    expect(subagentSpec(request(MAIN), "future-model", cfg, undefined, "future-client")).toBe("pool/coding");
  });

  it("parses freeOnly on a client rule and rejects a non-boolean one", () => {
    const cfg = loadConfig(write("client-offload-freeonly.json", base({
      routing: {
        default: "nim/model",
        pools: { coding: ["nim/model"] },
        subagents: { default: "pool/coding" },
        offload: { claude: { enabled: true, scope: "subagents", freeOnly: true } },
      },
    })));
    expect(offloadRule(cfg, "claude")).toEqual({ enabled: true, scope: "subagents", freeOnly: true });
    // Absent stays absent — the guard is opt-in like offload itself.
    // Absent, not false — the default is applied at the guard (`freeOnlyApplies`), where it can
    // differ between offload-rerouted traffic (ON) and a directly addressed pool (OFF).
    expect(offloadRule(cfg, "codex").freeOnly).toBeUndefined();
    expect(() => loadConfig(write("client-offload-freeonly-bad.json", base({
      routing: { default: "nim/model", offload: { claude: { enabled: true, freeOnly: "yes" } } },
    })))).toThrow(/freeOnly must be true or false/);
  });

  it("rejects an invalid client offload scope", () => {
    expect(() => loadConfig(write("client-offload-invalid.json", base({
      routing: { default: "nim/model", offload: { claude: { enabled: true, scope: "conversation" } } },
    })))).toThrow(/scope must be "subagents" or "all"/);
  });
});

describe("reshaper: { pool } — no single pinned model", () => {
  const poolReshaperCfg = {
    listen: "127.0.0.1:8791",
    providers: {
      anthropic: { base: "https://api.anthropic.com", kind: "anthropic" },
      nim: { base: "https://nim.test/v1", kind: "openai", authEnv: "NVIDIA_API_KEY" },
    },
    routing: {
      default: "anthropic",
      tiers: { opus: "anthropic" },
      pools: { coding: ["nim/z-ai/glm-5.2", "nim/deepseek-ai/deepseek-v4-pro"], none: ["anthropic"] },
    },
    mode: "repair",
    reshaper: { pool: "coding" },
  };

  it("expands the pool into ranked reshaper candidates (so a de-listed model can't kill repair)", () => {
    const c = loadConfig(write("resh-pool.json", poolReshaperCfg));
    expect(c.reshaperCandidates).toHaveLength(2);
    expect(c.reshaperCandidates!.map((r) => r.model)).toEqual(["z-ai/glm-5.2", "deepseek-ai/deepseek-v4-pro"]);
    expect(c.reshaperCandidates![0]!.authEnv).toBe("NVIDIA_API_KEY");
    // candidates[0] is mirrored onto .reshaper so every existing single-reshaper path still works.
    expect(c.reshaper?.model).toBe("z-ai/glm-5.2");
  });

  it("satisfies repair-mode validation against an anthropic passthrough provider", () => {
    // The pinned-model form is what used to be required here; the pool form must also satisfy it.
    expect(() => loadConfig(write("resh-pool-ok.json", poolReshaperCfg))).not.toThrow();
  });

  it("defers an empty catalog-backed reshaper pool until its free tail is materialized", () => {
    const c = loadConfig(write("resh-dynamic-pool.json", {
      ...poolReshaperCfg,
      providers: {
        ...poolReshaperCfg.providers,
        nim: { ...poolReshaperCfg.providers.nim, tierType: "free" },
      },
      routing: {
        ...poolReshaperCfg.routing,
        pools: { medium: { preferred: [], include: "free", effort: "medium" } },
      },
      reshaper: { pool: "medium", timeoutMs: 45_000 },
    }));

    expect(c.reshaper).toBeUndefined();
    expect(c.reshaperCandidates).toBeUndefined();
    expect(c.reshaperPool).toEqual({ name: "medium", timeoutMs: 45_000 });
  });

  it("throws on an undefined pool name rather than silently having no reshaper", () => {
    expect(() => loadConfig(write("resh-pool-missing.json", {
      ...poolReshaperCfg, reshaper: { pool: "ghost" },
    }))).toThrow(/not defined in routing.pools/);
  });

  it("throws when the pool has no openai-kind target able to reshape", () => {
    // An anthropic passthrough has no fixed model id to send, so it cannot be a reshaper.
    expect(() => loadConfig(write("resh-pool-anth.json", {
      ...poolReshaperCfg, reshaper: { pool: "none" },
    }))).toThrow(/no openai-kind target that can reshape/);
  });

  it("still rejects repair mode + anthropic provider when no reshaper is given at all", () => {
    const { reshaper, ...noReshaper } = poolReshaperCfg;
    expect(() => loadConfig(write("resh-none.json", noReshaper))).toThrow(/requires a config.reshaper/);
  });
});

describe("ergonomics: env expansion, overrides, reshaper", () => {
  it("expands ${ENV} in provider.base", () => {
    process.env.RP_TEST_BASE = "https://nim.test/v1";
    const c = loadConfig(write("env.json", {
      listen: "127.0.0.1:8791",
      providers: { nim: { base: "${RP_TEST_BASE}", kind: "openai" } },
      routing: { default: "nim/m" },
    }));
    expect(c.providers.nim!.base).toBe("https://nim.test/v1");
    delete process.env.RP_TEST_BASE;
  });

  // An unset ${ENV} in a provider base disables THAT provider rather than aborting startup —
  // the proxy fronts every client session, so one optional provider must not be able to take
  // it down. Losing every provider is still fatal. See test/degraded-config.test.ts.
  it("disables a provider whose base references an unset var, but still refuses an empty registry", () => {
    delete process.env.RP_MISSING_VAR;
    expect(() => loadConfig(write("env2.json", {
      providers: { nim: { base: "${RP_MISSING_VAR}", kind: "openai" } },
      routing: { default: "nim/m" },
    }))).toThrow(/at least one provider/);

    const c = loadConfig(write("env3.json", {
      providers: {
        good: { base: "https://good.test/v1", kind: "openai" },
        broken: { base: "${RP_MISSING_VAR}", kind: "openai" },
      },
      routing: { default: "good/m" },
    }));
    expect(Object.keys(c.providers)).toEqual(["good"]);
    expect((c.warnings ?? []).join("\n")).toMatch(/RP_MISSING_VAR/);
  });

  it("applies CLI overrides (default/mode/listen) over the file", () => {
    const p = write("ovr.json", base({ mode: "detect" }));
    const c = loadConfig(p, { routeDefault: "nim/new-model", mode: "repair", listen: "127.0.0.1:9000" });
    expect(c.routing.default).toBe("nim/new-model");
    expect(c.port).toBe(9000);
    expect(c.mode).toBe("repair");
  });

  it("repair mode with all-openai providers needs no explicit reshaper; target reshapes on itself", () => {
    const c = loadConfig(write("syn.json", base({ mode: "repair" })));
    expect(c.reshaper).toBeUndefined();
    const rs = reshaperForTarget(resolveTarget("nim/z-ai/glm-5.2", c));
    expect(rs?.kind).toBe("openai");
    expect(rs?.base).toBe("https://nim.test/v1");
    expect(rs?.model).toBe("z-ai/glm-5.2");
    expect(rs?.authEnv).toBe("NVIDIA_API_KEY");
  });

  it("repair mode with an anthropic provider requires an explicit reshaper", () => {
    expect(() => loadConfig(write("noreshape.json", {
      listen: "127.0.0.1:8791",
      providers: { claude: { base: "https://api.anthropic.test", kind: "anthropic" } },
      routing: { default: "claude" },
      mode: "repair",
    }))).toThrow(/requires a config\.reshaper/);
  });

  it("an explicit reshaper block wins over per-target synthesis", () => {
    const c = loadConfig(write("explicit.json", base({
      mode: "repair",
      reshaper: { base: "https://cheap.test/v1", kind: "openai", model: "cheap-model" },
    })));
    expect(c.reshaper?.base).toBe("https://cheap.test/v1");
    expect(c.reshaper?.model).toBe("cheap-model");
  });

  it("resolveTargets filters active keys and sorts candidates by benchmark quality", async () => {
    const { resolveTargets } = await import("../src/config.js");
    process.env.TEST_KEY_A = "secret_a";
    delete process.env.TEST_KEY_B; // Unset key

    const c = loadConfig(write("dynroute.json", {
      listen: "127.0.0.1:8791",
      providers: {
        provA: { base: "https://a.test/v1", kind: "openai", authEnv: "TEST_KEY_A" },
        provB: { base: "https://b.test/v1", kind: "openai", authEnv: "TEST_KEY_B" },
        localOllama: { base: "http://localhost:11434/v1", kind: "openai" },
      },
      routing: {
        default: ["provB/llama-3.1-8b", "provA/qwen-2.5-coder-32b", "localOllama/qwen-2.5-coder-32b"],
      },
    }));

    const targets = resolveTargets(null, c);
    // Unset provB should be filtered out because provA and localOllama have active keys
    expect(targets.some((t) => t.provider === "provB")).toBe(false);
    expect(targets.length).toBe(2);

    delete process.env.TEST_KEY_A;
  });

  // A whitespace-only key used to be PRESENT here (`Boolean(process.env[x])`, no trim) and ABSENT
  // to server.ts's header builder (which trims). The blank-key target therefore survived the
  // active-key filter, the keep-everything fallback never ran, and the request went to a provider
  // the proxy had no usable credential for. Both sites must give the same answer.
  it("treats a whitespace-only key as ABSENT, same as the header builder does", () => {
    process.env.TEST_KEY_BLANK = "   \n";
    process.env.TEST_KEY_REAL = "secret_real";

    const c = loadConfig(write("blankkey.json", {
      listen: "127.0.0.1:8791",
      providers: {
        blankProv: { base: "https://blank.test/v1", kind: "openai", authEnv: "TEST_KEY_BLANK" },
        realProv: { base: "https://real.test/v1", kind: "openai", authEnv: "TEST_KEY_REAL" },
      },
      routing: {
        default: ["blankProv/some-model", "realProv/some-model"],
        benchmarkSort: false,
      },
    }));

    const targets = resolveTargets(null, c);
    expect(targets.map((t) => t.provider)).toEqual(["realProv"]);

    delete process.env.TEST_KEY_BLANK;
    delete process.env.TEST_KEY_REAL;
  });

  it("keeps the whole candidate list when NO candidate has a usable key (the unfiltered fallback)", () => {
    process.env.TEST_KEY_BLANK = " ";
    delete process.env.TEST_KEY_MISSING;

    const c = loadConfig(write("allblank.json", {
      listen: "127.0.0.1:8791",
      providers: {
        blankProv: { base: "https://blank.test/v1", kind: "openai", authEnv: "TEST_KEY_BLANK" },
        goneProv: { base: "https://gone.test/v1", kind: "openai", authEnv: "TEST_KEY_MISSING" },
      },
      routing: {
        default: ["blankProv/some-model", "goneProv/some-model"],
        benchmarkSort: false,
      },
    }));

    // The blank one is no longer privileged over the unset one: the filter empties, so the
    // fallback returns both in config order and the caller fails on a real credential error
    // rather than on whichever provider happened to hold a blank variable.
    expect(resolveTargets(null, c).map((t) => t.provider)).toEqual(["blankProv", "goneProv"]);

    delete process.env.TEST_KEY_BLANK;
  });
});

describe("loadConfig — walkBudgetMs", () => {
  it("accepts a non-negative number, floors it, and preserves 0 (disabled)", () => {
    expect(loadConfig(write("wb-ok.json", base({ walkBudgetMs: 30000.9 }))).walkBudgetMs).toBe(30000);
    expect(loadConfig(write("wb-zero.json", base({ walkBudgetMs: 0 }))).walkBudgetMs).toBe(0);
  });

  it("is absent when not configured — the server applies its own default", () => {
    expect(loadConfig(write("wb-absent.json", base())).walkBudgetMs).toBeUndefined();
  });

  it("rejects a negative or non-numeric value loudly", () => {
    expect(() => loadConfig(write("wb-neg.json", base({ walkBudgetMs: -1 })))).toThrow(/walkBudgetMs/);
    expect(() => loadConfig(write("wb-str.json", base({ walkBudgetMs: "45s" })))).toThrow(/walkBudgetMs/);
  });
});

describe("loadConfig — maxBodyBytes", () => {
  it("accepts a positive integer within the configured bound", () => {
    expect(loadConfig(write("body-ok.json", base({ maxBodyBytes: 36 * 1024 * 1024 }))).maxBodyBytes)
      .toBe(36 * 1024 * 1024);
  });

  it("is absent when not configured — the server applies its 36 MiB default", () => {
    expect(loadConfig(write("body-absent.json", base())).maxBodyBytes).toBeUndefined();
  });

  it.each([0, -1, 1.5, 256 * 1024 * 1024 + 1, "36MB"])(
    "rejects invalid maxBodyBytes value %j and names the field",
    (maxBodyBytes) => {
      expect(() => loadConfig(write("body-invalid.json", base({ maxBodyBytes })))).toThrow(/maxBodyBytes/);
    },
  );
});

describe("loadConfig — log.maxBytes", () => {
  it("accepts a positive integer within the configured bound", () => {
    const c = loadConfig(write("log-max-ok.json", base({
      log: { level: "metadata", file: "proxy.jsonl", maxBytes: 50 * 1024 * 1024 },
    })));
    expect(c.log.maxBytes).toBe(50 * 1024 * 1024);
  });

  it("is absent when not configured — the logger applies its 50 MiB default", () => {
    expect(loadConfig(write("log-max-absent.json", base())).log.maxBytes).toBeUndefined();
  });

  it.each([0, -1, 1.5, 1024 * 1024 * 1024 + 1, "50MB"])(
    "rejects invalid log.maxBytes value %j and names the field",
    (maxBytes) => {
      expect(() => loadConfig(write("log-max-invalid.json", base({ log: { maxBytes } }))))
        .toThrow(/log\.maxBytes/);
    },
  );
});

/**
 * Operator-asserted rate limits (spec §4 rung 3). A malformed `limits` block is a HARD error at
 * both declaration levels — unlike credentials[] slot fields, which drop with a warning — because
 * a typo silently ignored reads as an asserted ceiling while bounding nothing.
 */
describe("loadConfig — provider limits (configured rate limits)", () => {
  /** A one-provider config whose `nim` carries the given extra fields. */
  function nimProvider(extra: Record<string, unknown>) {
    return base({
      providers: {
        nim: { base: "https://nim.test/v1", kind: "openai", authEnv: "NVIDIA_API_KEY", ...extra },
      },
    });
  }

  function nimWithCredentials(credentials: Record<string, unknown>[]) {
    // authEnv and credentials[] cannot both be declared on one provider.
    return base({
      providers: {
        nim: { base: "https://nim.test/v1", kind: "openai", credentials },
      },
    });
  }

  it("accepts the block at provider level and carries it onto the provider", () => {
    const c = loadConfig(write("limits-provider.json", nimProvider({
      limits: { rpm: 40, rpd: 1000, tpm: 100000, tpd: 150000 },
    })));
    expect(c.providers.nim!.limits).toEqual({ rpm: 40, rpd: 1000, tpm: 100000, tpd: 150000 });
  });

  it("accepts the block inside credential slots", () => {
    const c = loadConfig(write("limits-credential.json", nimWithCredentials([
      { label: "a", authEnv: "NIM_A", limits: { rpd: 500 } },
      { label: "b", authEnv: "NIM_B" },
    ])));
    expect(c.providers.nim!.credentials![0]!.limits).toEqual({ rpd: 500 });
    expect(c.providers.nim!.credentials![1]!.limits).toBeUndefined();
  });

  it("accepts per-model overrides keyed by arbitrary backend model ids", () => {
    const c = loadConfig(write("limits-models.json", nimProvider({
      limits: { rpm: 40, models: { "meta/llama-3.1-8b-instruct": { rpm: 10 } } },
    })));
    expect(c.providers.nim!.limits).toEqual({
      rpm: 40,
      models: { "meta/llama-3.1-8b-instruct": { rpm: 10 } },
    });
  });

  it.each(["RPM", "rps", "tph", "requestsPerMinute"])(
    "rejects unknown axis key %s by name at provider level",
    (axis) => {
      expect(() =>
        loadConfig(write(`limits-bad-axis-${axis}.json`, nimProvider({
          limits: { rpm: 40, [axis]: 10 },
        })),
      )).toThrow(new RegExp(`limits\\.${axis}`));
    },
  );

  it("rejects an unknown axis inside a model override, naming the model path", () => {
    expect(() =>
      loadConfig(write("limits-bad-model-axis.json", nimProvider({
        limits: { rpm: 40, models: { "meta/llama-3.1-8b-instruct": { RPM: 10 } } },
      })),
    )).toThrow(/models\."meta\/llama-3.1-8b-instruct"\.RPM/);
  });

  it.each([0, -5, 1.5, Number.MAX_SAFE_INTEGER + 1, "40", null])(
    "rejects non-positive/non-integer limit value %j and names the axis",
    (value) => {
      expect(() =>
        loadConfig(write(`limits-bad-value-${String(value)}.json`, nimProvider({
          limits: { rpm: value as number },
        })),
      )).toThrow(/limits\.rpm/);
    },
  );

  it("rejects a non-object limits block", () => {
    for (const bad of [["rpm"], "fast", 42]) {
      expect(() =>
        loadConfig(write(`limits-nonobject-${String(bad)}.json`, nimProvider({ limits: bad }))),
      ).toThrow(/limits must be an object/);
    }
  });

  it("rejects a non-object models map and a non-object model entry", () => {
    expect(() =>
      loadConfig(write("limits-models-array.json", nimProvider({
        limits: { models: ["meta/llama-3.1-8b-instruct"] },
      })),
    )).toThrow(/limits\.models must be an object/);
    expect(() =>
      loadConfig(write("limits-model-entry.json", nimProvider({
        limits: { models: { "m/x": 10 } },
      })),
    )).toThrow(/models\."m\/x" must be an object/);
  });

  it("rejects a malformed slot limits block with a HARD error, not a dropped slot", () => {
    // Deliberately different from the other slot fields: dropping the slot would remove a whole
    // key (and its quota domain) from the fleet over a typo, and ignoring it would leave the
    // operator believing a ceiling is asserted when none is.
    let threw = false;
    try {
      loadConfig(write("limits-slot-bad.json", nimWithCredentials([
        { label: "a", authEnv: "NIM_A", limits: { rps: 10 } },
      ])));
    } catch {
      threw = true;
    }
    expect(threw).toBe(true);
  });

  it("rejects a malformed provider limits block even while the provider is env-disabled", () => {
    // The unset-${ENV} soft disable must not become a place for a typo to hide: parse the limits
    // block BEFORE that gate (mirroring credentials[]), so the error surfaces now instead of on
    // the restart where the env var finally appears.
    delete process.env.RP_MISSING_LIMITS_VAR;
    expect(() =>
      loadConfig(write("limits-env-disabled.json", {
        listen: "127.0.0.1:8791",
        providers: {
          nim: { base: "${RP_MISSING_LIMITS_VAR}", kind: "openai", limits: { rps: 1 } },
        },
        routing: { default: "nim/m" },
      })),
    ).toThrow(/limits\.rps is not a known rate-limit axis/);
  });

  it("is absent when not configured; {} stays legal and declares nothing", () => {
    expect(loadConfig(write("limits-absent.json", base())).providers.nim!.limits).toBeUndefined();
    expect(
      loadConfig(write("limits-empty.json", nimProvider({ limits: {} }))).providers.nim!.limits,
    ).toEqual({});
  });
});

/**
 * G2's master switch, beside its `routing.quota` siblings (`enforce`, `enforceLearned` — pinned in
 * test/quota-demotion.test.ts). Default true: an operator who wrote a `hard` block meant it, so
 * only an explicit `false` turns every refusal ceiling back into an ordinary soft limit. What the
 * switch DOES to a request is pinned in test/hard-cap.test.ts; this is the parse contract.
 */
describe("loadConfig — routing.quota.hardCaps", () => {
  function quotaCfg(quota: unknown) {
    return base({
      providers: {
        nim: {
          base: "https://nim.test/v1",
          kind: "openai",
          authEnv: "NVIDIA_API_KEY",
          limits: { hard: { rpd: 5 } },
        },
      },
      routing: { default: "nim/z-ai/glm-5.2", quota },
    });
  }

  it("is absent by default and round-trips an explicit false", () => {
    expect(loadConfig(write("hardcaps-absent.json", base())).routing.quota).toBeUndefined();
    expect(loadConfig(write("hardcaps-off.json", quotaCfg({ hardCaps: false }))).routing.quota)
      .toEqual({ hardCaps: false });
    expect(loadConfig(write("hardcaps-on.json", quotaCfg({ hardCaps: true }))).routing.quota)
      .toEqual({ hardCaps: true });
  });

  it("carries beside the other quota flags rather than replacing them", () => {
    expect(
      loadConfig(write("hardcaps-both.json", quotaCfg({ enforce: false, hardCaps: false }))).routing.quota,
    ).toEqual({ enforce: false, hardCaps: false });
  });

  it.each([["no"], [0], [null], [{}]])("rejects non-boolean hardCaps %j by name", (value) => {
    expect(() => loadConfig(write(`hardcaps-bad-${String(value)}.json`, quotaCfg({ hardCaps: value }))))
      .toThrow(/routing\.quota\.hardCaps must be a boolean/);
  });
});

/**
 * `providers.<name>.compat` — per-provider WIRE-SHAPE quirks, and the labelled base-host default
 * behind them.
 *
 * The default is a LABELLED PROVIDER FACT, which the "Provider knowledge is data, not routing
 * configuration" invariant admits only because config overrides it — so both directions are
 * pinned here, not just the convenient one.
 */
describe("loadConfig — provider compat (tool-call id shape)", () => {
  const provider = (p: Record<string, unknown>) => (name: string) =>
    loadConfig(write(name, base({ providers: { x: { kind: "openai", ...p } }, routing: { default: "x/m" } })));

  it("defaults a mistral base host to strict9 and everything else to preserve", () => {
    // mistral-common enforces ^[a-zA-Z0-9]{9}$ and answers 400 invalid_function_call otherwise.
    expect(resolveTarget("m", provider({ base: "https://api.mistral.ai/v1" })("compat-mistral.json")).toolCallIds)
      .toBe("strict9");
    // The operator's own second mistral endpoint — the rule is the vendor's, not one hostname's.
    expect(resolveTarget("m", provider({ base: "https://codestral.mistral.ai/v1" })("compat-codestral.json")).toolCallIds)
      .toBe("strict9");
    expect(resolveTarget("m", provider({ base: "https://nim.test/v1" })("compat-nim.json")).toolCallIds)
      .toBe("preserve");
    // A lookalike host is NOT mistral's: the suffix match is on a dot-bounded label.
    expect(resolveTarget("m", provider({ base: "https://notmistral.ai/v1" })("compat-lookalike.json")).toolCallIds)
      .toBe("preserve");
  });

  it("lets an explicit value win in BOTH directions", () => {
    expect(resolveTarget("m", provider({
      base: "https://api.mistral.ai/v1", compat: { toolCallIds: "preserve" },
    })("compat-off.json")).toolCallIds).toBe("preserve");
    expect(resolveTarget("m", provider({
      base: "https://nim.test/v1", compat: { toolCallIds: "strict9" },
    })("compat-on.json")).toolCallIds).toBe("strict9");
  });

  it("round-trips the declared block onto the provider", () => {
    const c = provider({ base: "https://nim.test/v1", compat: { toolCallIds: "strict9" } })("compat-roundtrip.json");
    expect(c.providers.x!.compat).toEqual({ toolCallIds: "strict9" });
    expect(provider({ base: "https://nim.test/v1" })("compat-absent.json").providers.x!.compat).toBeUndefined();
  });

  it("rejects an unknown compat KEY by name — an ignored typo reads as a declaration that took effect", () => {
    expect(() => provider({ base: "https://nim.test/v1", compat: { toolCallIDs: "strict9" } })("compat-key.json"))
      .toThrow(/config\.providers\.x\.compat\.toolCallIDs is not a known compat option/);
  });

  it("rejects an unknown compat VALUE, and a non-object block", () => {
    expect(() => provider({ base: "https://nim.test/v1", compat: { toolCallIds: "strict-9" } })("compat-value.json"))
      .toThrow(/compat\.toolCallIds must be one of: preserve, strict9/);
    expect(() => provider({ base: "https://nim.test/v1", compat: "strict9" })("compat-scalar.json"))
      .toThrow(/config\.providers\.x\.compat must be an object/);
  });
});

/**
 * `providers.<name>.compat.thoughtSignature` — the second wire-shape quirk, on the same mechanism.
 *
 * The default is again a LABELLED PROVIDER FACT: gemini 3.x on Google's Generative Language API
 * answers 400 "Function call is missing a thought_signature in functionCall parts…" to a replayed
 * tool call, so that ONE host defaults to `"sentinel"`. Config overrides it in both directions,
 * which is the condition the "Provider knowledge is data" invariant attaches.
 */
describe("loadConfig — provider compat (thought signature)", () => {
  const provider = (p: Record<string, unknown>) => (name: string) =>
    loadConfig(write(name, base({ providers: { x: { kind: "openai", ...p } }, routing: { default: "x/m" } })));

  it("defaults Google's Generative Language API to sentinel and everything else to none", () => {
    expect(resolveTarget("m", provider({
      base: "https://generativelanguage.googleapis.com/v1beta/openai",
    })("ts-gemini.json")).thoughtSignature).toBe("sentinel");
    expect(resolveTarget("m", provider({ base: "https://nim.test/v1" })("ts-nim.json")).thoughtSignature)
      .toBe("none");
    // Deliberately the ONE exact host, not `*.googleapis.com`: Vertex and every other Google
    // surface are different products with different validators.
    expect(resolveTarget("m", provider({
      base: "https://aiplatform.googleapis.com/v1",
    })("ts-vertex.json")).thoughtSignature).toBe("none");
    // …and a lookalike suffix is not it either.
    expect(resolveTarget("m", provider({
      base: "https://notgenerativelanguage.googleapis.com.evil.test/v1",
    })("ts-lookalike.json")).thoughtSignature).toBe("none");
  });

  it("lets an explicit value win in BOTH directions", () => {
    expect(resolveTarget("m", provider({
      base: "https://generativelanguage.googleapis.com/v1beta/openai",
      compat: { thoughtSignature: "none" },
    })("ts-off.json")).thoughtSignature).toBe("none");
    expect(resolveTarget("m", provider({
      base: "https://nim.test/v1", compat: { thoughtSignature: "sentinel" },
    })("ts-on.json")).thoughtSignature).toBe("sentinel");
  });

  it("round-trips the declared key, and carries beside the sibling key", () => {
    const c = provider({
      base: "https://nim.test/v1", compat: { toolCallIds: "strict9", thoughtSignature: "sentinel" },
    })("ts-roundtrip.json");
    expect(c.providers.x!.compat).toEqual({ toolCallIds: "strict9", thoughtSignature: "sentinel" });
    const t = resolveTarget("m", c);
    expect(t.toolCallIds).toBe("strict9");
    expect(t.thoughtSignature).toBe("sentinel");
  });

  it("rejects an unknown VALUE by name, and names both known keys on an unknown KEY", () => {
    expect(() => provider({
      base: "https://nim.test/v1", compat: { thoughtSignature: "skip" },
    })("ts-value.json")).toThrow(/compat\.thoughtSignature must be one of: none, sentinel/);
    expect(() => provider({
      base: "https://nim.test/v1", compat: { thoughtSignatures: "sentinel" },
    })("ts-key.json")).toThrow(
      /config\.providers\.x\.compat\.thoughtSignatures is not a known compat option \(known: toolCallIds, thoughtSignature\)/,
    );
  });
});

/**
 * `providers.<name>.wire` — which upstream endpoint an openai-kind provider speaks
 * (backlog item 11: OpenCode Zen's contributor SKUs, Muse Spark 1.3 included, answer 500 on
 * `/chat/completions` and 200 only on `/responses`; docs/muse-spark-1.3-opencode-zen-2026-09-04.md
 * rows 3, 6-8). Resolved onto `ResolvedTarget.wire` exactly like `toolCallIds`/`thoughtSignature`.
 */
describe("loadConfig — provider wire (Responses vs. Chat upstream)", () => {
  const provider = (p: Record<string, unknown>) => (name: string) =>
    loadConfig(write(name, base({ providers: { x: { kind: "openai", base: "https://nim.test/v1", ...p } }, routing: { default: "x/m" } })));

  it("defaults to absent (chat) when not declared", () => {
    const c = provider({})("wire-absent.json");
    expect(c.providers.x!.wire).toBeUndefined();
    expect(resolveTarget("m", c).wire).toBeUndefined();
  });

  it("round-trips an explicit chat and an explicit responses declaration", () => {
    expect(provider({ wire: "chat" })("wire-chat.json").providers.x!.wire).toBe("chat");
    const c = provider({ wire: "responses" })("wire-responses.json");
    expect(c.providers.x!.wire).toBe("responses");
    expect(resolveTarget("m", c).wire).toBe("responses");
  });

  it("rejects an unknown VALUE by name — an ignored typo reads as a declaration that took effect", () => {
    expect(() => provider({ wire: "response" })("wire-typo.json"))
      .toThrow(/config\.providers\.x\.wire must be one of: chat, responses/);
    expect(() => provider({ wire: 1 })("wire-number.json"))
      .toThrow(/config\.providers\.x\.wire must be one of: chat, responses/);
  });

  it("rejects wire on an anthropic-kind provider", () => {
    const cfg = write("wire-anthropic.json", base({
      providers: { x: { kind: "anthropic", base: "https://api.anthropic.com", wire: "responses" } },
      routing: { default: "x" },
    }));
    expect(() => loadConfig(cfg)).toThrow(
      /config\.providers\.x\.wire is only valid on an openai-kind provider \(this provider is anthropic-kind\)/,
    );
  });
});

describe("routing.dispatchWalk", () => {
  it("defaults ON with the standard budget when absent — the 2026-09-06 owner request", () => {
    const cfg = loadConfig(write("dw-absent.json", base()));
    expect(cfg.routing.dispatchWalk).toEqual({
      enabled: true,
      attemptMs: 90_000,
      attemptQuantile: 0.8,
      attemptMinSamples: 5,
      maxLanes: 4,
      pinMs: 15 * 60 * 1000,
      demoteMs: 15 * 60 * 1000,
    });
  });

  it("boolean `false` is a byte-for-byte revert to one lane per dispatch", () => {
    const off = loadConfig(
      write("dw-false.json", base({ routing: { default: "nim/z-ai/glm-5.2", dispatchWalk: false } })),
    );
    expect(off.routing.dispatchWalk?.enabled).toBe(false);
    // The other settings keep their defaults, so turning it back on needs no second edit.
    expect(off.routing.dispatchWalk?.attemptMs).toBe(90_000);
  });

  it("accepts a partial object, filling the rest from the defaults, and floors to integers", () => {
    const cfg = loadConfig(
      write("dw-obj.json", base({
        routing: { default: "nim/z-ai/glm-5.2", dispatchWalk: { attemptMs: 45_000.9, maxLanes: 2 } },
      })),
    );
    expect(cfg.routing.dispatchWalk).toEqual({
      enabled: true,
      attemptMs: 45_000,
      attemptQuantile: 0.8,
      attemptMinSamples: 5,
      maxLanes: 2,
      pinMs: 15 * 60 * 1000,
      demoteMs: 15 * 60 * 1000,
    });
  });

  it("⚠ rejects an unknown key by name — an ignored typo would read as a setting that took effect", () => {
    expect(() =>
      loadConfig(write("dw-unknown.json", base({
        routing: { default: "nim/z-ai/glm-5.2", dispatchWalk: { attemptms: 45_000 } },
      }))),
    ).toThrow(/dispatchWalk\.attemptms is not a recognized key/);
  });

  it("rejects an out-of-bounds budget, a bad lane count and a non-boolean enabled", () => {
    expect(() =>
      loadConfig(write("dw-lowbudget.json", base({
        routing: { default: "nim/z-ai/glm-5.2", dispatchWalk: { attemptMs: 10 } },
      }))),
      // Floor 1000 ms: a budget below that abandons every lane before a process can even start,
      // which would read to an operator as "every lane is broken".
    ).toThrow(/dispatchWalk\.attemptMs must be a number between 1000 and 3600000/);
    expect(() =>
      loadConfig(write("dw-lanes.json", base({
        routing: { default: "nim/z-ai/glm-5.2", dispatchWalk: { maxLanes: 0 } },
      }))),
    ).toThrow(/dispatchWalk\.maxLanes must be a number between 1 and 20/);
    expect(() =>
      loadConfig(write("dw-enabled.json", base({
        routing: { default: "nim/z-ai/glm-5.2", dispatchWalk: { enabled: "yes" } },
      }))),
    ).toThrow(/dispatchWalk\.enabled must be a boolean/);
  });
});

describe("routing.laneProbe", () => {
  it("defaults ON with the standard intervals when absent — the 2026-08-29 owner decision", () => {
    const cfg = loadConfig(write("lp-absent.json", base()));
    expect(cfg.routing.laneProbe).toEqual({
      enabled: true,
      quotaIntervalMs: 6 * 60 * 60 * 1000,
      catalogIntervalMs: 24 * 60 * 60 * 1000,
    });
  });

  it("boolean shorthand toggles enabled and keeps the default intervals", () => {
    const off = loadConfig(write("lp-false.json", base({ routing: { default: "nim/z-ai/glm-5.2", laneProbe: false } })));
    expect(off.routing.laneProbe?.enabled).toBe(false);
    expect(off.routing.laneProbe?.quotaIntervalMs).toBe(6 * 60 * 60 * 1000);
  });

  it("accepts bounded interval overrides and floors them to integers", () => {
    const cfg = loadConfig(
      write("lp-obj.json", base({
        routing: {
          default: "nim/z-ai/glm-5.2",
          laneProbe: { enabled: true, quotaIntervalMs: 90_000.9, catalogIntervalMs: 120_000 },
        },
      })),
    );
    expect(cfg.routing.laneProbe).toEqual({ enabled: true, quotaIntervalMs: 90_000, catalogIntervalMs: 120_000 });
  });

  it("⚠ rejects an unknown key by name — an ignored typo would read as a setting that took effect", () => {
    expect(() =>
      loadConfig(write("lp-unknown.json", base({
        routing: { default: "nim/z-ai/glm-5.2", laneProbe: { enabled: true, quotaInterval: 90_000 } },
      }))),
    ).toThrow(/laneProbe\.quotaInterval is not a recognized key/);
  });

  it("rejects an out-of-bounds interval and a missing enabled", () => {
    expect(() =>
      loadConfig(write("lp-bounds.json", base({
        routing: { default: "nim/z-ai/glm-5.2", laneProbe: { enabled: true, quotaIntervalMs: 1000 } },
      }))),
    ).toThrow(/quotaIntervalMs must be between/);
    expect(() =>
      loadConfig(write("lp-noenabled.json", base({
        routing: { default: "nim/z-ai/glm-5.2", laneProbe: { quotaIntervalMs: 90_000 } },
      }))),
    ).toThrow(/laneProbe\.enabled must be a boolean/);
  });
});

/**
 * `routing.latency` — the parse contract for the sustained-latency demotion term (owner decision
 * 2026-08-30). What the term DOES to a walk is pinned in test/latency-demotion.test.ts; this is
 * only about what the file is allowed to say.
 */
describe("loadConfig — routing.latency", () => {
  function latencyCfg(latency: unknown) {
    return base({ routing: { default: "nim/z-ai/glm-5.2", latency } });
  }

  it("defaults to an empty object, which means every default (i.e. ON)", () => {
    // Deliberately NOT undefined: the parser is total so `parseRouting` needs no extra branch,
    // and `{}` and absence are the same statement because every key is optional.
    expect(loadConfig(write("lat-absent.json", base())).routing.latency).toEqual({});
  });

  it("normalizes the boolean shorthand away, so nothing downstream decides what false means", () => {
    expect(loadConfig(write("lat-false.json", latencyCfg(false))).routing.latency).toEqual({ enabled: false });
    expect(loadConfig(write("lat-true.json", latencyCfg(true))).routing.latency).toEqual({ enabled: true });
  });

  it("round-trips both ceilings and the sample floor", () => {
    expect(
      loadConfig(write("lat-obj.json", latencyCfg({ p95Ms: 5000, msPerToken: 120, minSamples: 20 })))
        .routing.latency,
    ).toEqual({ p95Ms: 5000, msPerToken: 120, minSamples: 20 });
  });

  it("REFUSES an unknown key rather than ignoring it", () => {
    // The compat/configured-limits precedent. An operator who wrote `p95ms` (wrong case) believes
    // they lowered the ceiling; ignoring the key leaves the default in force while looking changed.
    expect(() => loadConfig(write("lat-typo.json", latencyCfg({ p95ms: 5000 })))).toThrow(
      /routing\.latency has an unknown key "p95ms"/,
    );
  });

  it("refuses a ceiling that would bound nothing or everything", () => {
    // 0 demotes every measured deployment at once; a negative or non-finite ceiling bounds nothing
    // while looking like it does — the same reason an empty cost filter is dropped at load.
    for (const bad of [0, -1, Number.NaN, Number.POSITIVE_INFINITY, "5000"]) {
      expect(() => loadConfig(write(`lat-bad-${String(bad)}.json`, latencyCfg({ p95Ms: bad })))).toThrow(
        /routing\.latency\.p95Ms must be a positive finite number/,
      );
    }
    expect(() => loadConfig(write("lat-bad-samples.json", latencyCfg({ minSamples: 0 })))).toThrow(
      /routing\.latency\.minSamples must be a positive finite number/,
    );
    expect(() => loadConfig(write("lat-bad-rate.json", latencyCfg({ msPerToken: -5 })))).toThrow(
      /routing\.latency\.msPerToken must be a positive finite number/,
    );
  });

  it("rejects a malformed block outright", () => {
    expect(() => loadConfig(write("lat-array.json", latencyCfg([])))).toThrow(
      /routing\.latency must be an object or a boolean/,
    );
    expect(() => loadConfig(write("lat-enabled.json", latencyCfg({ enabled: "yes" })))).toThrow(
      /routing\.latency\.enabled must be a boolean/,
    );
  });
});

/**
 * `routing.hedge` — the parse contract for hedged attempts (owner decisions 2026-08-30).
 *
 * Sibling of the `routing.latency` block above, and deliberately the same strictness. What hedging
 * DOES to a walk is pinned in test/hedge-wiring.test.ts; this is only about what the file may say.
 */
describe("loadConfig — routing.hedge", () => {
  function hedgeCfg(hedge: unknown) {
    return base({ routing: { default: "nim/z-ai/glm-5.2", hedge } });
  }

  it("defaults to an empty object, which means every default (i.e. ON)", () => {
    // ON by default is owner decision D1, taken against the recommendation of off-by-default. The
    // duplication it permits is bounded elsewhere — free deployments only, and an announcement.
    expect(loadConfig(write("hedge-absent.json", base())).routing.hedge).toEqual({});
  });

  it("normalizes the boolean shorthand away, so nothing downstream decides what false means", () => {
    expect(loadConfig(write("hedge-false.json", hedgeCfg(false))).routing.hedge).toEqual({ enabled: false });
    expect(loadConfig(write("hedge-true.json", hedgeCfg(true))).routing.hedge).toEqual({ enabled: true });
  });

  it("round-trips the floor, the margin and the sample floor", () => {
    expect(
      loadConfig(write("hedge-obj.json", hedgeCfg({ floorMs: 30_000, margin: 3, minSamples: 8 })))
        .routing.hedge,
    ).toEqual({ floorMs: 30_000, margin: 3, minSamples: 8 });
  });

  it("round-trips the new minFloorMs and msPerInputToken keys (owner direction 2026-09-04)", () => {
    expect(
      loadConfig(write("hedge-size.json", hedgeCfg({ minFloorMs: 5_000, msPerInputToken: 0.2 })))
        .routing.hedge,
    ).toEqual({ minFloorMs: 5_000, msPerInputToken: 0.2 });
  });

  it("still accepts the legacy floorMs key, byte for byte — an operator config written before " +
    "2026-09-04 must keep loading and keep meaning what it always meant", () => {
    expect(
      loadConfig(write("hedge-legacy-floor.json", hedgeCfg({ floorMs: 8_000 }))).routing.hedge,
    ).toEqual({ floorMs: 8_000 });
  });

  it("REFUSES an unknown key rather than ignoring it", () => {
    expect(() => loadConfig(write("hedge-typo.json", hedgeCfg({ floorms: 30_000 })))).toThrow(
      /routing\.hedge has an unknown key "floorms"/,
    );
    // The same guard covers a typo on either new key, so a misspelling of `minFloorMs` or
    // `msPerInputToken` does not silently leave the default in force.
    expect(() => loadConfig(write("hedge-typo-minfloor.json", hedgeCfg({ minfloorms: 5_000 })))).toThrow(
      /routing\.hedge has an unknown key "minfloorms"/,
    );
    expect(() => loadConfig(write("hedge-typo-msper.json", hedgeCfg({ msperinputtoken: 0.2 })))).toThrow(
      /routing\.hedge has an unknown key "msperinputtoken"/,
    );
  });

  it("refuses a floor or a per-token rate that would bound nothing", () => {
    // A 0 floor removes the one bound that stops a fast pool duplicating almost every request, and
    // a negative or non-finite value bounds nothing while looking like it does. `minFloorMs` and
    // `msPerInputToken` are validated the same way.
    for (const bad of [0, -1, Number.NaN, Number.POSITIVE_INFINITY, "20000"]) {
      expect(() => loadConfig(write(`hedge-bad-${String(bad)}.json`, hedgeCfg({ floorMs: bad })))).toThrow(
        /routing\.hedge\.floorMs must be a positive finite number/,
      );
      expect(() => loadConfig(write(`hedge-bad-minfloor-${String(bad)}.json`, hedgeCfg({ minFloorMs: bad })))).toThrow(
        /routing\.hedge\.minFloorMs must be a positive finite number/,
      );
      expect(() => loadConfig(write(`hedge-bad-msper-${String(bad)}.json`, hedgeCfg({ msPerInputToken: bad })))).toThrow(
        /routing\.hedge\.msPerInputToken must be a positive finite number/,
      );
    }
    expect(() => loadConfig(write("hedge-bad-margin.json", hedgeCfg({ margin: 0 })))).toThrow(
      /routing\.hedge\.margin must be a positive finite number/,
    );
    expect(() => loadConfig(write("hedge-bad-samples.json", hedgeCfg({ minSamples: -2 })))).toThrow(
      /routing\.hedge\.minSamples must be a positive finite number/,
    );
  });

  it("rejects a malformed block outright", () => {
    expect(() => loadConfig(write("hedge-array.json", hedgeCfg([])))).toThrow(
      /routing\.hedge must be an object or a boolean/,
    );
    expect(() => loadConfig(write("hedge-enabled.json", hedgeCfg({ enabled: "yes" })))).toThrow(
      /routing\.hedge\.enabled must be a boolean/,
    );
  });
});

/**
 * `routing.mcp.maxWaitMs` (packet P8, 2026-09-09) — the server half of the machine-wide
 * `dispatch`-loses-the-job defect: an MCP host tool call fails between 45 s and 100 s and
 * destroys the job handle above that, so `dispatch` must never block past a ceiling 5 s under
 * the lowest measured host failure. What the file is allowed to say is pinned here; what the
 * server DOES with the ceiling is pinned in test/mcp-server.test.ts.
 */
describe("loadConfig — routing.mcp.maxWaitMs", () => {
  function mcpCfg(mcp: unknown) {
    return base({ routing: { default: "nim/z-ai/glm-5.2", mcp } });
  }

  it("defaults to 40000 when the block is present but silent, and stays absent when absent", () => {
    expect(loadConfig(write("mcp-maxwait-absent.json", base())).routing.mcp).toBeUndefined();
    expect(loadConfig(write("mcp-maxwait-empty.json", mcpCfg({}))).routing.mcp).toEqual({
      maxWaitMs: 40_000,
    });
  });

  it("keeps an explicit value", () => {
    expect(
      loadConfig(write("mcp-maxwait-set.json", mcpCfg({ maxWaitMs: 10_000 }))).routing.mcp,
    ).toEqual({ maxWaitMs: 10_000 });
  });

  it("keeps allowedRoots beside the defaulted ceiling", () => {
    expect(
      loadConfig(write("mcp-maxwait-roots.json", mcpCfg({ allowedRoots: ["C:/Code"] }))).routing.mcp,
    ).toEqual({ allowedRoots: ["C:/Code"], maxWaitMs: 40_000 });
  });

  it("refuses 0, -1, 1.5 and \"40000\" by name — none of them bounds the blocking wait", () => {
    // 0/negative bounds nothing, 1.5 is not a whole millisecond, and a string is never a
    // duration even when it spells one — each must fail loudly naming the key, never load as a
    // ceiling the server then trusts.
    for (const bad of [0, -1, 1.5, "40000"]) {
      expect(
        () => loadConfig(write(`mcp-maxwait-bad-${String(bad)}.json`, mcpCfg({ maxWaitMs: bad }))),
      ).toThrow(/routing\.mcp\.maxWaitMs/);
    }
  });

  it("still refuses an unknown key under routing.mcp by name", () => {
    expect(() => loadConfig(write("mcp-maxwait-typo.json", mcpCfg({ maxwaitms: 10_000 })))).toThrow(
      /routing\.mcp\.maxwaitms is not a recognized key/,
    );
  });
});
