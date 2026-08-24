import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  candidateEnvNames,
  credentialCandidateEnvNames,
  credentialState,
  keyIsPresent,
  readCredential,
  resolveAuthEnv,
  resolveCredential,
  resolveCredentialExact,
  type CredentialResolution,
} from "../src/authEnv.js";
import { loadEnvFile } from "../src/dotenv.js";
import { addEntry, lock, type KeystoreOptions } from "../src/keystore.js";

describe("candidateEnvNames", () => {
  it("puts the declared name first, then known aliases", () => {
    const names = candidateEnvNames("gemini", "GEMINI_API_KEY");
    expect(names[0]).toBe("GEMINI_API_KEY");
    expect(names).toContain("GOOGLEAI_API_KEY");
    expect(names).toContain("GOOGLE_API_KEY");
  });

  it("derives candidates for a provider with no curated aliases", () => {
    expect(candidateEnvNames("my-host.2")).toEqual(["MY_HOST_2_API_KEY", "MY_HOST_2_KEY", "MY_HOST_2_TOKEN"]);
  });

  it("never repeats a name", () => {
    const names = candidateEnvNames("groq", "GROQ_API_KEY");
    expect(new Set(names).size).toBe(names.length);
  });

  it("exports the exact legacy declared-family then provider-derived walk", () => {
    expect(credentialCandidateEnvNames("GEMINI_API_KEY", "custom-provider")).toEqual([
      "GEMINI_API_KEY",
      "GOOGLEAI_API_KEY",
      "GOOGLE_AI_API_KEY",
      "GOOGLE_GENAI_API_KEY",
      "GOOGLE_GEMINI_API_KEY",
      "GOOGLE_API_KEY",
      "CUSTOM_PROVIDER_API_KEY",
      "CUSTOM_PROVIDER_KEY",
      "CUSTOM_PROVIDER_TOKEN",
    ]);
  });
});

describe("resolveAuthEnv", () => {
  it("prefers the declared name when it is set", () => {
    const r = resolveAuthEnv("gemini", "GEMINI_API_KEY", { GEMINI_API_KEY: "a", GOOGLEAI_API_KEY: "b" });
    expect(r.name).toBe("GEMINI_API_KEY");
    expect(r.viaAlias).toBe(false);
  });

  it("falls back to an alias when the declared name is unset", () => {
    const r = resolveAuthEnv("gemini", "GEMINI_API_KEY", { GOOGLEAI_API_KEY: "b" });
    expect(r.name).toBe("GOOGLEAI_API_KEY");
    expect(r.viaAlias).toBe(true);
  });

  it("ignores an env var that is set but blank", () => {
    const r = resolveAuthEnv("gemini", "GEMINI_API_KEY", { GEMINI_API_KEY: "   ", GOOGLEAI_API_KEY: "b" });
    expect(r.name).toBe("GOOGLEAI_API_KEY");
  });

  it("keeps the declared name when nothing is set, so diagnostics stay stable", () => {
    const r = resolveAuthEnv("gemini", "GEMINI_API_KEY", {});
    expect(r.name).toBe("GEMINI_API_KEY");
    expect(r.viaAlias).toBe(false);
  });

  it("does not borrow another provider's key", () => {
    const r = resolveAuthEnv("gemini", "GEMINI_API_KEY", { GROQ_API_KEY: "g", OPENAI_API_KEY: "o" });
    expect(r.name).toBe("GEMINI_API_KEY");
    expect(r.viaAlias).toBe(false);
  });
});

describe("credential resolution sources", () => {
  const passphrase = "packet-2-resolver-test-passphrase";
  let directory: string;

  beforeEach(() => {
    directory = mkdtempSync(join(tmpdir(), "llm-relay-auth-env-"));
    lock();
    loadEnvFile(join(directory, "provenance-reset-missing.env"));
  });

  afterEach(() => {
    lock();
    loadEnvFile(join(directory, "provenance-reset-missing.env"));
    rmSync(directory, { recursive: true, force: true });
  });

  function options(name = "keystore.json"): KeystoreOptions {
    return {
      path: join(directory, name),
      mode: "passphrase",
      passphrase,
    };
  }

  function assertAgreement(
    declared: string,
    env: NodeJS.ProcessEnv,
    provider: string | undefined,
    keystoreOptions: KeystoreOptions,
    expected: Partial<CredentialResolution>,
  ): void {
    const resolution = resolveCredential(declared, env, provider, keystoreOptions);
    expect(resolution).toMatchObject(expected);
    expect(credentialState(declared, env, provider, keystoreOptions)).toBe(resolution.state);
    expect(readCredential(declared, env, provider, keystoreOptions)).toBe(resolution.value);
    expect(keyIsPresent(resolution.value)).toBe(resolution.state === "declared-present");
  }

  it("keeps state, read, and presence aligned across env, env-file, keystore, and absence for present, blank, and whitespace values", () => {
    const store = options("matrix-keystore.json");
    addEntry({
      id: "matrix#present",
      provider: "matrix",
      envName: "MATRIX_KEYSTORE_PRESENT",
      value: " stored-present ",
    }, store);
    expect(() => addEntry({
      id: "matrix#whitespace",
      provider: "matrix",
      envName: "MATRIX_KEYSTORE_WHITESPACE",
      value: " \t ",
    }, store)).toThrow("invalid keystore entry value");
    expect(() => addEntry({
      id: "matrix#blank",
      provider: "matrix",
      envName: "MATRIX_KEYSTORE_BLANK",
      value: "",
    }, store)).toThrow("invalid keystore entry value");

    assertAgreement("MATRIX_ENV_PRESENT", { MATRIX_ENV_PRESENT: " env-present " }, undefined, store, {
      state: "declared-present", value: "env-present", source: "env",
    });
    assertAgreement("MATRIX_ENV_BLANK", { MATRIX_ENV_BLANK: "" }, undefined, store, {
      state: "declared-missing", value: undefined, source: undefined,
    });
    assertAgreement("MATRIX_ENV_WHITESPACE", { MATRIX_ENV_WHITESPACE: " \t " }, undefined, store, {
      state: "declared-missing", value: undefined, source: undefined,
    });

    const file = join(directory, "matrix.env");
    const fileNames = ["MATRIX_FILE_PRESENT", "MATRIX_FILE_BLANK", "MATRIX_FILE_WHITESPACE"];
    const saved = Object.fromEntries(fileNames.map((name) => [name, process.env[name]]));
    for (const name of fileNames) delete process.env[name];
    try {
      writeFileSync(file, [
        "MATRIX_FILE_PRESENT= file-present ",
        "MATRIX_FILE_BLANK=",
        "MATRIX_FILE_WHITESPACE='   '",
      ].join("\n"));
      loadEnvFile(file);
      assertAgreement("MATRIX_FILE_PRESENT", process.env, undefined, store, {
        state: "declared-present", value: "file-present", source: "env-file",
      });
      assertAgreement("MATRIX_FILE_BLANK", process.env, undefined, store, {
        state: "declared-missing", value: undefined, source: undefined,
      });
      assertAgreement("MATRIX_FILE_WHITESPACE", process.env, undefined, store, {
        state: "declared-missing", value: undefined, source: undefined,
      });
    } finally {
      for (const name of fileNames) {
        const value = saved[name];
        if (value === undefined) delete process.env[name];
        else process.env[name] = value;
      }
    }

    assertAgreement("MATRIX_KEYSTORE_PRESENT", {}, "not-the-entry-provider", store, {
      state: "declared-present", value: "stored-present", source: "keystore",
    });
    assertAgreement("MATRIX_KEYSTORE_WHITESPACE", {}, "matrix", store, {
      state: "declared-missing", value: undefined, source: undefined,
    });
    assertAgreement("MATRIX_KEYSTORE_BLANK", {}, "matrix", store, {
      state: "declared-missing", value: undefined, source: undefined,
    });
    assertAgreement("MATRIX_ABSENT", {}, undefined, store, {
      state: "declared-missing", value: undefined, source: undefined,
    });
  });

  it("orders env over env-file over keystore while the fill-only loader preserves a real env value", () => {
    const store = options("precedence-keystore.json");
    for (const [id, envName] of [
      ["precedence#env", "PRECEDENCE_ENV_KEY"],
      ["precedence#file", "PRECEDENCE_FILE_KEY"],
      ["precedence#stored", "PRECEDENCE_STORED_KEY"],
    ] as const) {
      addEntry({ id, provider: "precedence", envName, value: `stored:${envName}` }, store);
    }

    const names = ["PRECEDENCE_ENV_KEY", "PRECEDENCE_FILE_KEY", "PRECEDENCE_STORED_KEY"];
    const saved = Object.fromEntries(names.map((name) => [name, process.env[name]]));
    for (const name of names) delete process.env[name];
    try {
      process.env.PRECEDENCE_ENV_KEY = "real-env";
      const file = join(directory, "precedence.env");
      writeFileSync(file, "PRECEDENCE_ENV_KEY=env-file-shadowed\nPRECEDENCE_FILE_KEY=env-file\n");
      const loaded = loadEnvFile(file);
      expect(loaded.skipped).toContain("PRECEDENCE_ENV_KEY");

      expect(resolveCredential("PRECEDENCE_ENV_KEY", process.env, "precedence", store)).toMatchObject({
        value: "real-env", source: "env",
      });
      expect(resolveCredential("PRECEDENCE_FILE_KEY", process.env, "precedence", store)).toMatchObject({
        value: "env-file", source: "env-file",
      });
      expect(resolveCredential("PRECEDENCE_STORED_KEY", process.env, "precedence", store)).toMatchObject({
        value: "stored:PRECEDENCE_STORED_KEY", source: "keystore",
      });
    } finally {
      for (const name of names) {
        const value = saved[name];
        if (value === undefined) delete process.env[name];
        else process.env[name] = value;
      }
    }
  });

  it("lets blank and whitespace env values fall through to the keystore rung", () => {
    const store = options("blank-env-keystore.json");
    addEntry({
      id: "blankenv#blank",
      provider: "blankenv",
      envName: "BLANK_ENV_FALLBACK_KEY",
      value: "stored-for-blank",
    }, store);
    addEntry({
      id: "blankenv#whitespace",
      provider: "blankenv",
      envName: "WHITESPACE_ENV_FALLBACK_KEY",
      value: "stored-for-whitespace",
    }, store);

    expect(resolveCredential("BLANK_ENV_FALLBACK_KEY", { BLANK_ENV_FALLBACK_KEY: "" }, undefined, store)).toMatchObject({
      value: "stored-for-blank", source: "keystore",
    });
    expect(resolveCredential("WHITESPACE_ENV_FALLBACK_KEY", { WHITESPACE_ENV_FALLBACK_KEY: " \t" }, undefined, store)).toMatchObject({
      value: "stored-for-whitespace", source: "keystore",
    });
  });

  it("walks every env candidate before keystore, then walks keystore declared name before aliases", () => {
    const store = options("legacy-order-keystore.json");
    addEntry({
      id: "gemini#declared",
      provider: "gemini",
      envName: "GEMINI_API_KEY",
      value: "stored-declared",
    }, store);
    addEntry({
      id: "gemini#alias",
      provider: "gemini",
      envName: "GOOGLEAI_API_KEY",
      value: "stored-alias",
    }, store);

    expect(resolveCredential("GEMINI_API_KEY", { GOOGLE_API_KEY: "env-last" }, "gemini", store)).toMatchObject({
      value: "env-last", envName: "GOOGLE_API_KEY", source: "env",
    });
    expect(resolveCredential("GEMINI_API_KEY", {}, "gemini", store)).toMatchObject({
      value: "stored-declared",
      envName: "GEMINI_API_KEY",
      source: "keystore",
      provenance: { entryId: "gemini#declared", provider: "gemini" },
    });

    const whitespaceStore = options("legacy-whitespace-keystore.json");
    expect(() => addEntry({
      id: "anthropic#declared",
      provider: "anthropic",
      envName: "ANTHROPIC_API_KEY",
      value: " \t ",
    }, whitespaceStore)).toThrow("invalid keystore entry value");
    addEntry({
      id: "anthropic#alias",
      provider: "anthropic",
      envName: "ANTHROPIC_AUTH_TOKEN",
      value: "stored-alias-after-whitespace",
    }, whitespaceStore);
    expect(resolveCredential("ANTHROPIC_API_KEY", {}, "anthropic", whitespaceStore)).toMatchObject({
      value: "stored-alias-after-whitespace",
      envName: "ANTHROPIC_AUTH_TOKEN",
      source: "keystore",
    });
  });

  it("consults the store once for the complete candidate array and never for no declaration", () => {
    const store = options("batch-keystore.json");
    addEntry({
      id: "gemini#late-alias",
      provider: "gemini",
      envName: "GOOGLE_API_KEY",
      value: "stored-late-alias",
    }, store);
    const readFile = vi.fn((candidatePath: string) => readFileSync(candidatePath, "utf8"));
    const statFile = vi.fn((candidatePath: string) => {
      const { mtimeMs, size, ino } = statSync(candidatePath);
      return { mtimeMs, size, ino };
    });
    const counted: KeystoreOptions = { ...store, readFile, statFile };

    expect(resolveCredential("GEMINI_API_KEY", {}, "gemini", counted)).toMatchObject({
      state: "declared-present",
      value: "stored-late-alias",
      envName: "GOOGLE_API_KEY",
      source: "keystore",
    });
    expect(statFile).toHaveBeenCalledTimes(1);
    expect(readFile).toHaveBeenCalledTimes(1);

    expect(resolveCredential(undefined, {}, "gemini", counted)).toEqual({
      state: "not-declared",
      value: undefined,
      envName: undefined,
      source: undefined,
    });
    expect(statFile).toHaveBeenCalledTimes(1);
    expect(readFile).toHaveBeenCalledTimes(1);
  });

  it("resolveCredentialExact consults only the declared keystore name and never serves an alias", () => {
    const store = options("exact-keystore.json");
    addEntry({
      id: "gemini#alias",
      provider: "gemini",
      envName: "GOOGLEAI_API_KEY",
      value: "alias-must-not-serve-exact",
    }, store);
    addEntry({
      id: "gemini#exact",
      provider: "gemini",
      envName: "EXACT_DECLARED_KEY",
      value: "exact-declared-value",
    }, store);

    expect(resolveCredentialExact("GEMINI_API_KEY", {}, store)).toEqual({
      state: "declared-missing",
      value: undefined,
      envName: "GEMINI_API_KEY",
      source: undefined,
    });
    expect(resolveCredentialExact("EXACT_DECLARED_KEY", {}, store)).toMatchObject({
      state: "declared-present",
      value: "exact-declared-value",
      envName: "EXACT_DECLARED_KEY",
      source: "keystore",
      provenance: { entryId: "gemini#exact", provider: "gemini" },
    });
    expect(resolveCredentialExact("EXACT_DECLARED_KEY", { EXACT_DECLARED_KEY: " exact-env " }, store)).toEqual({
      state: "declared-present",
      value: "exact-env",
      envName: "EXACT_DECLARED_KEY",
      source: "env",
    });
    for (const blank of ["", " \t "]) {
      expect(resolveCredentialExact("EXACT_DECLARED_KEY", { EXACT_DECLARED_KEY: blank }, store)).toMatchObject({
        state: "declared-present",
        value: "exact-declared-value",
        envName: "EXACT_DECLARED_KEY",
        source: "keystore",
      });
    }
    expect(resolveCredential("GEMINI_API_KEY", {}, "gemini", store)).toMatchObject({
      value: "alias-must-not-serve-exact", envName: "GOOGLEAI_API_KEY", source: "keystore",
    });
  });

  it("looks up stored named values without a provider filter and reports entry identity only as provenance", () => {
    const store = options("provenance-keystore.json");
    addEntry({
      id: "origin#stored",
      provider: "origin",
      envName: "OPERATOR_AUTHORED_SHARED_NAME",
      value: "shared-named-value",
    }, store);

    const resolution = resolveCredential(
      "OPERATOR_AUTHORED_SHARED_NAME",
      {},
      "different-configured-provider",
      store,
    );
    expect(resolution).toEqual({
      state: "declared-present",
      value: "shared-named-value",
      envName: "OPERATOR_AUTHORED_SHARED_NAME",
      source: "keystore",
      provenance: { entryId: "origin#stored", provider: "origin" },
    });
  });

  it("does not mutate process.env while resolving a keystore-only value", () => {
    const store = options("no-env-mutation-keystore.json");
    addEntry({
      id: "mutation#stored",
      provider: "mutation",
      envName: "KEYSTORE_RESOLUTION_MUST_NOT_EXPORT",
      value: "contained-value",
    }, store);
    const before = { ...process.env };

    expect(resolveCredential("KEYSTORE_RESOLUTION_MUST_NOT_EXPORT", {}, "mutation", store).value)
      .toBe("contained-value");
    expect({ ...process.env }).toEqual(before);
  });
});
