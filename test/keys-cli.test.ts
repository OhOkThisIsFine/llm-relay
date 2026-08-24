import {
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { loadConfig, type Config } from "../src/config.js";
import { loadEnvFile } from "../src/dotenv.js";
import {
  KEY_CUSTODY_THREAT_BOUNDARY,
  readMaskedOrPipedLine,
  runKeysAddLocal,
  runKeysDisableLocal,
  runKeysEnableLocal,
  runKeysExportLocal,
  runKeysImportLocal,
  runKeysListLocal,
  runKeysRemoveLocal,
  runKeysRevokeLocal,
  runKeysRotateLocal,
  runKeysUnlockLocal,
} from "../src/keys-cli.js";
import {
  addEntry,
  createEncryptedKeystoreExport,
  decryptEncryptedKeystoreExport,
  listEntries,
  lock,
  lookupByEnvName,
  revokeEntry,
  rotateEntry,
  setDisabled,
  type KeystoreOptions,
} from "../src/keystore.js";
import { classifyCommand, main, validateKeysCommandArgs } from "../src/cli.js";
import { matchCredentialImportName } from "../src/key-import.js";

const STORE_PASSPHRASE = "store-passphrase";
const EXPORT_PASSPHRASE = "export-passphrase";

function leaks(output: string | Buffer, secret: string): boolean {
  const text = Buffer.isBuffer(output) ? output.toString("utf8") : output;
  const needles = new Set<string>();
  for (let offset = 0; offset + 4 <= secret.length; offset += 1) {
    needles.add(secret.slice(offset, offset + 4));
  }
  needles.add(Buffer.from(secret, "utf8").toString("base64"));
  needles.add(Buffer.from(secret, "utf8").toString("hex"));
  return [...needles].some((needle) => needle.length > 0 && text.includes(needle));
}

function configDocument(): Record<string, unknown> {
  return {
    listen: "127.0.0.1:18791",
    providers: {
      nim: {
        base: "https://integrate.api.nvidia.com/v1",
        kind: "openai",
        authEnv: "NVIDIA_API_KEY",
      },
      fleet: {
        base: "https://fleet.invalid/v1",
        kind: "openai",
        credentials: [{ label: "work", authEnv: "FLEET_WORK_KEY" }],
      },
      passthrough: {
        base: "https://api.anthropic.com",
        kind: "anthropic",
        credentialMode: "passthrough",
      },
      implicitPassthrough: {
        base: "https://implicit.anthropic.invalid",
        kind: "anthropic",
      },
      keyless: {
        base: "http://127.0.0.1:11434/v1",
        kind: "openai",
        credentialMode: "contained",
      },
    },
    routing: { default: "nim/test", tiers: {} },
    mode: "detect",
    log: { level: "silent", file: null },
  };
}

describe("keys lifecycle CLI", () => {
  let directory: string;
  let configPath: string;
  let cfg: Config;
  let storePath: string;
  let store: KeystoreOptions;

  beforeEach(() => {
    directory = mkdtempSync(join(tmpdir(), "llm-relay-keys-cli-"));
    configPath = join(directory, "config.json");
    writeFileSync(configPath, JSON.stringify(configDocument(), null, 2));
    cfg = loadConfig(configPath);
    storePath = join(directory, "keystore.json");
    store = {
      path: storePath,
      mode: "passphrase",
      passphrase: STORE_PASSPHRASE,
      platform: "linux",
      commandExists: () => false,
    };
  });

  afterEach(() => {
    lock();
    vi.restoreAllMocks();
    rmSync(directory, { recursive: true, force: true });
  });

  it("keeps keys add threat-boundary output byte-for-byte with design §2.3", () => {
    const design = readFileSync(
      join(process.cwd(), "docs", "credential-fleet-design-2026-08-16.md"),
      "utf8",
    ).split(/\r?\n/u);
    const findBullet = (leadingText: string): string => {
      const bullet = design.find((line) => line.startsWith(leadingText));
      expect(bullet, `missing design bullet: ${leadingText}`).toBeDefined();
      return bullet!;
    };
    expect(KEY_CUSTODY_THREAT_BOUNDARY).toBe([
      findBullet("- **What it stops:**"),
      findBullet("- **What it does not stop:**"),
      findBullet("- **What nothing user-side stops:**"),
      findBullet("- An **admin-forced password reset**"),
    ].join("\n"));
  });

  it.each([
    ["unknown provider", "missing", undefined, undefined, "unknown provider"],
    ["passthrough provider", "passthrough", undefined, undefined, "passthrough provider"],
    ["implicit passthrough provider", "implicitPassthrough", undefined, undefined, "passthrough provider"],
    ["no auth declaration", "keyless", undefined, undefined, "no auth declaration"],
    ["undeclared env name", "nim", undefined, "GUESSED_API_KEY", "undeclared env name"],
  ])("refuses add with a distinct named reason: %s", async (_name, provider, label, envName, reason) => {
    await expect(runKeysAddLocal(cfg, provider, {
      ...(label === undefined ? {} : { label }),
      ...(envName === undefined ? {} : { envName }),
    }, {
      keystore: store,
      env: {},
      readSecret: async () => "must-not-be-read",
    })).rejects.toThrow(reason);
  });

  it("refuses labels that do not match the configured runtime credential identity", async () => {
    const readSecret = vi.fn(async () => "K7mQ2vN9xT4rC8pL5zW3");
    await expect(runKeysAddLocal(cfg, "nim", { label: "other" }, {
      keystore: store,
      env: {},
      readSecret,
    })).rejects.toThrow("credential identity mismatch");
    await expect(runKeysAddLocal(cfg, "fleet", {
      label: "other",
      envName: "FLEET_WORK_KEY",
    }, {
      keystore: store,
      env: {},
      readSecret,
    })).rejects.toThrow("credential identity mismatch");
    expect(readSecret).not.toHaveBeenCalled();
  });

  it("restores TTY state and rejects when masked input reaches EOF before a line", async () => {
    const terminal = new PassThrough() as PassThrough & {
      isTTY: boolean;
      isRaw: boolean;
      setRawMode: (mode: boolean) => typeof terminal;
    };
    terminal.isTTY = true;
    terminal.isRaw = false;
    const modes: boolean[] = [];
    terminal.setRawMode = (mode: boolean) => {
      modes.push(mode);
      terminal.isRaw = mode;
      return terminal;
    };
    const pending = readMaskedOrPipedLine(
      "Credential: ",
      terminal as unknown as NodeJS.ReadStream,
      { write: () => undefined },
    );
    terminal.end();
    await expect(pending).rejects.toThrow("secret input ended before a line was read");
    expect(modes.at(-1)).toBe(false);
  });

  it("preserves the named end-of-input refusal through readSecret", async () => {
    const terminal = new PassThrough() as PassThrough & {
      isTTY: boolean;
      isRaw: boolean;
      setRawMode: (mode: boolean) => typeof terminal;
    };
    terminal.isTTY = true;
    terminal.isRaw = false;
    terminal.setRawMode = (mode: boolean) => {
      terminal.isRaw = mode;
      return terminal;
    };

    const pending = runKeysAddLocal(cfg, "nim", {}, {
      keystore: store,
      env: {},
      stdin: terminal as unknown as NodeJS.ReadStream,
      promptOutput: { write: () => undefined },
    });
    terminal.end();

    await expect(pending).rejects.toThrow("secret input ended before a line was read");
  });

  it("adds from one piped line, round-trips, prints the exact threat boundary, and never leaks", async () => {
    const secret = "Q7vZ2mX9cB4nL8pR6tK3";
    const pipe = new PassThrough();
    pipe.end(`${secret}\r\nsecond-line-is-ignored\n`);
    const output: string[] = [];

    await runKeysAddLocal(cfg, "nim", {}, {
      keystore: store,
      env: {},
      stdin: pipe as unknown as NodeJS.ReadStream,
      write: (line) => output.push(line),
    });

    expect(lookupByEnvName("NVIDIA_API_KEY", store)).toMatchObject({
      value: secret,
      entryId: "nim#default",
    });
    const rendered = output.join("");
    expect(rendered).toContain(KEY_CUSTODY_THREAT_BOUNDARY);
    expect(leaks(rendered, secret)).toBe(false);
    expect(leaks(readFileSync(storePath), secret)).toBe(false);
  });

  it("normalizes only one injected trailing line ending and preserves other whitespace", async () => {
    const value = "R8mQ3vN7xT2kC9pL5zW4  ";
    await runKeysAddLocal(cfg, "nim", {}, {
      keystore: store,
      env: {},
      readSecret: async () => `${value}\r\n`,
      write: () => undefined,
    });
    expect(lookupByEnvName("NVIDIA_API_KEY", store)?.value).toBe(value);
  });

  it("warns when an environment variable shadows a newly stored key", async () => {
    const output: string[] = [];
    await runKeysAddLocal(cfg, "nim", {}, {
      keystore: store,
      // NIM_KEY is provider-derived read compatibility, deliberately not in the strict write gate.
      env: { NIM_KEY: "H3qP8wY2dN6rT9kC5mV7" },
      readSecret: async () => "N8fR4xL7bQ2zW6jK9pC5",
      write: (line) => output.push(line),
    });
    expect(output.join("")).toContain("stored but shadowed by $NIM_KEY from the process environment");
    expect(leaks(output.join(""), "H3qP8wY2dN6rT9kC5mV7")).toBe(false);
    expect(leaks(output.join(""), "N8fR4xL7bQ2zW6jK9pC5")).toBe(false);
  });

  it("labels a shadowed --check with the credential actually probed and threads env", async () => {
    const secret = "C8mR2vQ7xN4kT9pL5zW3";
    const shadow = "H3qP8wY2dN6rT9kC5mV7";
    const checkEnv = { NIM_KEY: shadow };
    const output: string[] = [];
    const priorShadow = process.env.NIM_KEY;
    delete process.env.NIM_KEY;
    const keyCheckFetch = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
      expect(new Headers(init?.headers).get("authorization")).toBe(`Bearer ${shadow}`);
      return new Response(JSON.stringify({ error: "rejected" }), { status: 401 });
    }) as unknown as typeof fetch;
    try {
      await runKeysAddLocal(cfg, "nim", { check: true }, {
        keystore: store,
        env: checkEnv,
        readSecret: async () => secret,
        keyCheckFetch,
        write: (line) => output.push(line),
      });
    } finally {
      if (priorShadow === undefined) delete process.env.NIM_KEY;
      else process.env.NIM_KEY = priorShadow;
    }
    expect(lookupByEnvName("NVIDIA_API_KEY", store)?.value).toBe(secret);
    expect(keyCheckFetch).toHaveBeenCalled();
    expect(output.join("")).toContain(
      "Checked $NIM_KEY from the process environment — the stored key was NOT probed: INVALID_KEY — Authentication failed (HTTP 401)",
    );
    expect(output.join("")).not.toContain("Check nim#default");
    expect(leaks(output.join(""), secret)).toBe(false);
    expect(leaks(output.join(""), shadow)).toBe(false);
  });

  it("refuses an empty secret before creating the store", async () => {
    await expect(runKeysAddLocal(cfg, "nim", {}, {
      keystore: store,
      env: {},
      readSecret: async () => "\n",
      write: () => undefined,
    })).rejects.toThrow("empty secret refused");
    expect(() => readFileSync(storePath)).toThrow();
  });

  it("refuses shadowed rotation before input, storage, or live clearing", async () => {
    addEntry({
      id: "nim#default",
      provider: "nim",
      envName: "NVIDIA_API_KEY",
      value: "old-keystore-secret",
    }, store);
    const before = readFileSync(storePath);
    const readSecret = vi.fn(async () => "replacement-secret");
    const liveFetch = vi.fn<typeof fetch>();

    await expect(runKeysRotateLocal(cfg, "nim", {
      keystore: store,
      env: { NVIDIA_API_KEY: "shadowing-secret" },
      readSecret,
      fetch: liveFetch,
    })).rejects.toThrow("shadow refusal: $NVIDIA_API_KEY from the process environment wins");
    expect(readSecret).not.toHaveBeenCalled();
    expect(liveFetch).not.toHaveBeenCalled();
    expect(readFileSync(storePath).equals(before)).toBe(true);
  });

  it("names the exact env-file that shadows a refused rotation without mutating anything", async () => {
    addEntry({
      id: "nim#default",
      provider: "nim",
      envName: "NVIDIA_API_KEY",
      value: "old-keystore-secret",
    }, store);
    const before = readFileSync(storePath);
    const envFile = join(directory, "rotation-shadow.env");
    const saved = process.env.NVIDIA_API_KEY;
    const readSecret = vi.fn(async () => "replacement-secret");
    const liveFetch = vi.fn<typeof fetch>();

    delete process.env.NVIDIA_API_KEY;
    writeFileSync(envFile, "NVIDIA_API_KEY=dotenv-shadowing-secret\n");
    loadEnvFile(envFile, process.env);
    try {
      await expect(runKeysRotateLocal(cfg, "nim", {
        keystore: store,
        env: process.env,
        envFilePath: envFile,
        readSecret,
        fetch: liveFetch,
      })).rejects.toThrow(
        `shadow refusal: $NVIDIA_API_KEY from env-file ${envFile} wins`,
      );
      expect(readSecret).not.toHaveBeenCalled();
      expect(liveFetch).not.toHaveBeenCalled();
      expect(readFileSync(storePath).equals(before)).toBe(true);
    } finally {
      delete process.env.NVIDIA_API_KEY;
      loadEnvFile(join(directory, "provenance-reset-missing.env"), process.env);
      if (saved !== undefined) process.env.NVIDIA_API_KEY = saved;
    }
  });

  it.each(["disabled", "expired"])("refuses a %s entry without input, mutation, or clearing", async (state) => {
    addEntry({
      id: "nim#default",
      provider: "nim",
      envName: "NVIDIA_API_KEY",
      value: "F2mQ8vN4xT7kR3pC9zL5",
      ...(state === "expired" ? { expiresAt: Date.now() - 1 } : {}),
    }, store);
    if (state === "disabled") setDisabled("nim#default", true, store);
    const before = readFileSync(storePath);
    const readSecret = vi.fn(async () => "G6rW2qV9mK4xN8pT3cL7");
    const liveFetch = vi.fn<typeof fetch>();
    await expect(runKeysRotateLocal(cfg, "nim#default", {
      keystore: store,
      env: {},
      readSecret,
      fetch: liveFetch,
    })).rejects.toThrow(`${state} credential refusal`);
    expect(readSecret).not.toHaveBeenCalled();
    expect(liveFetch).not.toHaveBeenCalled();
    expect(readFileSync(storePath).equals(before)).toBe(true);
  });

  it("refuses a legacy row whose stored id cannot match the runtime slot identity", async () => {
    addEntry({
      id: "nim#other",
      provider: "nim",
      envName: "NVIDIA_API_KEY",
      value: "H8mR3vQ7xN2kT9pL4zC6",
    }, store);
    const before = readFileSync(storePath);
    await expect(runKeysRotateLocal(cfg, "nim#other", {
      keystore: store,
      env: {},
      readSecret: async () => "J4qN9vT2mR8xK5pC7zL3",
    })).rejects.toThrow("credential identity mismatch");
    expect(readFileSync(storePath).equals(before)).toBe(true);
  });

  it("refuses a config-disabled runtime slot before input, mutation, or clearing", async () => {
    const variantPath = join(directory, "disabled-slot.json");
    const document = configDocument() as any;
    document.providers = {
      fleet: {
        base: "https://fleet.invalid/v1",
        kind: "openai",
        credentials: [{ label: "work", authEnv: "FLEET_WORK_KEY", enabled: false }],
      },
    };
    document.routing.default = "fleet/test";
    writeFileSync(variantPath, JSON.stringify(document));
    const variant = loadConfig(variantPath);
    const variantStore: KeystoreOptions = { ...store, path: join(directory, "disabled-slot-store.json") };
    addEntry({
      id: "fleet#work",
      provider: "fleet",
      envName: "FLEET_WORK_KEY",
      value: "S3qV8nR2xT7kC4pL9zW5",
    }, variantStore);
    const before = readFileSync(variantStore.path!);
    const readSecret = vi.fn(async () => "T7mQ2vN9xR4kC8pL5zW3");
    const liveFetch = vi.fn<typeof fetch>();
    await expect(runKeysRotateLocal(variant, "fleet#work", {
      keystore: variantStore,
      env: {},
      readSecret,
      fetch: liveFetch,
    })).rejects.toThrow("configured slot disabled refusal");
    expect(readSecret).not.toHaveBeenCalled();
    expect(liveFetch).not.toHaveBeenCalled();
    expect(readFileSync(variantStore.path!).equals(before)).toBe(true);
  });

  it("rotates then posts the exact narrowed selector to a running relay", async () => {
    addEntry({
      id: "nim#default",
      provider: "nim",
      envName: "NVIDIA_API_KEY",
      value: "old-rotate-secret",
    }, store);
    let posted: unknown;
    const fetchStub = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
      posted = JSON.parse(String(init?.body)) as unknown;
      return new Response(JSON.stringify({
        target: { provider: "nim", credential: "default", kinds: ["credential-fault"] },
        cleared: {
          breakerCells: { count: 0, items: [] },
          credentialFaults: { count: 0, items: [] },
          facts: { count: 0, items: [] },
        },
      }), { status: 200, headers: { "content-type": "application/json" } });
    }) as typeof fetch;
    const output: string[] = [];

    await runKeysRotateLocal(cfg, "nim#default", {
      keystore: store,
      env: {},
      readSecret: async () => "new-rotate-secret",
      fetch: fetchStub,
      attachControlHeaders: (_config, headers) => ({ ...headers, authorization: "Bearer test" }),
      write: (line) => output.push(line),
    });

    expect(posted).toEqual({ provider: "nim", credential: "default", kinds: ["credential-fault"] });
    expect(lookupByEnvName("NVIDIA_API_KEY", store)?.value).toBe("new-rotate-secret");
    expect(output.join("")).toContain("other cooldowns were untouched");
  });

  it("keeps a successful rotation when no relay is running and reports convergence", async () => {
    addEntry({
      id: "nim#default",
      provider: "nim",
      envName: "NVIDIA_API_KEY",
      value: "old-offline-secret",
    }, store);
    const output: string[] = [];
    await runKeysRotateLocal(cfg, "nim#default", {
      keystore: store,
      env: {},
      readSecret: async () => "new-offline-secret",
      fetch: vi.fn(async () => { throw new Error("offline"); }) as typeof fetch,
      attachControlHeaders: (_config, headers) => headers,
      write: (line) => output.push(line),
    });
    expect(lookupByEnvName("NVIDIA_API_KEY", store)?.value).toBe("new-offline-secret");
    expect(output.join("")).toContain("relay's own success or expiry");
  });

  it("states explicitly when rotation deliberately un-revokes an entry", async () => {
    addEntry({
      id: "nim#default",
      provider: "nim",
      envName: "NVIDIA_API_KEY",
      value: "D4qN8vT2mR7xK5pC9zL3",
    }, store);
    revokeEntry("nim#default", store);
    const output: string[] = [];
    await runKeysRotateLocal(cfg, "nim#default", {
      keystore: store,
      env: {},
      readSecret: async () => "E9mW3qR7vT2xN8kC5pL4",
      fetch: vi.fn(async () => { throw new Error("offline"); }) as typeof fetch,
      attachControlHeaders: (_config, headers) => headers,
      write: (line) => output.push(line),
    });
    expect(output.join("")).toContain("deliberately un-revoked nim#default");
    expect(listEntries(store)[0]).toMatchObject({ revokedAt: null });
    expect(listEntries(store)[0]?.rotatedAt).not.toBeNull();
  });

  it("rejects a malformed 200 clear response instead of claiming live state was cleared", async () => {
    addEntry({
      id: "nim#default",
      provider: "nim",
      envName: "NVIDIA_API_KEY",
      value: "old-malformed-secret",
    }, store);
    const output: string[] = [];
    await expect(runKeysRotateLocal(cfg, "nim#default", {
      keystore: store,
      env: {},
      readSecret: async () => "new-malformed-secret",
      fetch: vi.fn(async () => new Response(JSON.stringify({ ok: true }), { status: 200 })) as typeof fetch,
      attachControlHeaders: (_config, headers) => headers,
      write: (line) => output.push(line),
    })).rejects.toThrow("rotation was stored, but live credential-fault clearing failed");
    expect(output.join("")).not.toContain("Cleared live credential-fault");
    expect(output.join("")).not.toContain("No running relay");
    expect(lookupByEnvName("NVIDIA_API_KEY", store)?.value).toBe("new-malformed-secret");
  });

  it.each([
    [
      "HTTP rejection",
      () => new Response(JSON.stringify({ error: "denied" }), { status: 403 }),
      "running relay returned HTTP 403",
    ],
    [
      "broader fact scope",
      () => new Response(JSON.stringify({
        target: { provider: "nim", credential: "default", kinds: ["credential-fault"] },
        cleared: {
          breakerCells: { count: 0, items: [] },
          credentialFaults: { count: 0, items: [] },
          facts: {
            count: 1,
            items: [{ kind: "credential-invalid", scope: { kind: "provider", provider: "nim" } }],
          },
        },
      }), { status: 200 }),
      "invalid narrowed-clear response",
    ],
  ])("reports a live %s as clear failure, never as no running relay", async (_case, response, reason) => {
    addEntry({
      id: "nim#default",
      provider: "nim",
      envName: "NVIDIA_API_KEY",
      value: "M3qV8nR2xT7kC4pL9zW5",
    }, store);
    const output: string[] = [];
    await expect(runKeysRotateLocal(cfg, "nim#default", {
      keystore: store,
      env: {},
      readSecret: async () => "P7mQ2vN9xT4rC8kL5zW3",
      fetch: vi.fn(async () => response()) as typeof fetch,
      attachControlHeaders: (_config, headers) => headers,
      write: (line) => output.push(line),
    })).rejects.toThrow(reason);
    expect(output.join("")).toContain("Rotated nim#default");
    expect(output.join("")).not.toContain("No running relay");
  });

  it("revokes, disables, enables, lists, and removes while a passphrase store is locked", () => {
    const secret = "J5mT8qV2zR7nC4wP9xL6";
    addEntry({
      id: "nim#default",
      provider: "nim",
      envName: "NVIDIA_API_KEY",
      value: secret,
    }, store);
    lock({ path: storePath });
    const locked = { path: storePath, mode: "passphrase" as const, platform: "linux" as const };
    const output: string[] = [];

    runKeysRevokeLocal("nim#default", { keystore: locked, write: (line) => output.push(line) });
    runKeysDisableLocal("nim#default", { keystore: locked, write: (line) => output.push(line) });
    runKeysListLocal(cfg, { keystore: locked, env: {}, write: (line) => output.push(line) });
    expect(output.join("")).toContain("disabled,revoked");
    expect(output.join("")).toContain("Store: locked");
    expect(output.join("")).toContain("\t—\t");
    expect(leaks(output.join(""), secret)).toBe(false);
    runKeysEnableLocal("nim#default", { keystore: locked, write: (line) => output.push(line) });
    runKeysRemoveLocal("nim#default", true, { keystore: locked, write: (line) => output.push(line) });
    expect(output.join("")).toContain("journaling filesystem or SSD");
    expect(listEntries(locked)).toEqual([]);
  });

  it("lists every custody column from metadata, the winning keystore source, and the process-view note", () => {
    const originalSecret = "Q8mT2vN7xR4kC9pL5zW3";
    const rotatedSecret = "R3nV8qM2xT7kC4pL9zW5";
    const expiresAt = Date.now() + 86_400_000;
    addEntry({
      id: "nim#default",
      provider: "nim",
      envName: "NVIDIA_API_KEY",
      value: originalSecret,
      expiresAt,
    }, store);
    rotateEntry("nim#default", rotatedSecret, store);
    const entry = listEntries(store)[0]!;
    const output: string[] = [];

    runKeysListLocal(cfg, { keystore: store, env: {}, write: (line) => output.push(line) });

    const rendered = output.join("");
    expect(rendered).toContain(
      "provider\tcredential id\tsource\tfingerprint\tadded\trotated\texpiry\tstate",
    );
    expect(rendered).toContain([
      "nim",
      "nim#default",
      "keystore",
      entry.fingerprint,
      new Date(entry.addedAt).toISOString(),
      new Date(entry.rotatedAt!).toISOString(),
      new Date(expiresAt).toISOString(),
      "active",
    ].join("\t"));
    expect(rendered).toContain("Store: ok — 1 listed, 0 undecryptable, 0 dropped.");
    expect(rendered).toContain("this reflects the CLI process's view, not the running relay's");
    expect(leaks(rendered, originalSecret)).toBe(false);
    expect(leaks(rendered, rotatedSecret)).toBe(false);
  });

  it("reports listed, undecryptable, and dropped rows without double-counting", () => {
    addEntry({
      id: "nim#default",
      provider: "nim",
      envName: "NVIDIA_API_KEY",
      value: "status-secret",
    }, store);
    const document = JSON.parse(readFileSync(storePath, "utf8")) as { entries: unknown[] };
    const row = document.entries[0] as { ct: string };
    row.ct = `${row.ct[0] === "A" ? "B" : "A"}${row.ct.slice(1)}`;
    document.entries.push({ malformed: true });
    writeFileSync(storePath, JSON.stringify(document, null, 2));
    lock({ path: storePath });
    const output: string[] = [];
    runKeysListLocal(cfg, { keystore: store, env: {}, write: (line) => output.push(line) });
    expect(output.join("")).toContain("nim\tnim#default\t—");
    expect(output.join("")).toContain(
      "Store: degraded — 1 listed, 1 undecryptable, 1 dropped.",
    );
  });

  it("surfaces an unreadable store without trying to print secret-bearing rows", () => {
    writeFileSync(storePath, "not-json");
    const output: string[] = [];
    runKeysListLocal(cfg, { keystore: store, env: {}, write: (line) => output.push(line) });
    expect(output.join("")).toContain(
      "Store: unreadable — 0 listed, 0 undecryptable, 0 dropped.",
    );
    expect(output.join("")).toContain(
      "provider\tcredential id\tsource\tfingerprint\tadded\trotated\texpiry\tstate",
    );
  });

  it("refuses export when the store cannot unlock", async () => {
    addEntry({
      id: "nim#default",
      provider: "nim",
      envName: "NVIDIA_API_KEY",
      value: "export-refusal-secret",
    }, store);
    lock({ path: storePath });
    const outPath = join(directory, "refused-export.json");
    await expect(runKeysExportLocal(outPath, {
      keystore: { ...store, passphrase: "wrong-passphrase" },
      readSecret: async () => EXPORT_PASSPHRASE,
    })).rejects.toThrow("keystore unlock failed");
    expect(() => readFileSync(outPath)).toThrow();
  });

  it("shares one piped reader across export passphrase and confirmation", async () => {
    const secret = "T7mQ2vN9xR4kC8pL5zW3";
    addEntry({
      id: "nim#default",
      provider: "nim",
      envName: "NVIDIA_API_KEY",
      value: secret,
    }, store);
    const pipe = new PassThrough();
    pipe.end(`${EXPORT_PASSPHRASE}\n${EXPORT_PASSPHRASE}\n`);
    const outPath = join(directory, "piped-export.json");
    const output: string[] = [];

    await runKeysExportLocal(outPath, {
      keystore: store,
      stdin: pipe as unknown as NodeJS.ReadStream,
      write: (line) => output.push(line),
    });

    expect(decryptEncryptedKeystoreExport(
      readFileSync(outPath, "utf8"),
      EXPORT_PASSPHRASE,
    )[0]?.value).toBe(secret);
    expect(output.join("")).toContain(
      "The export passphrase is the file's entire protection off-machine; keep it separate from the export.",
    );
  });

  it("fails closed without hanging when piped export confirmation reaches end-of-input", async () => {
    const pipe = new PassThrough();
    pipe.end(`${EXPORT_PASSPHRASE}\n`);
    const outPath = join(directory, "exhausted-export.json");

    await expect(runKeysExportLocal(outPath, {
      keystore: store,
      stdin: pipe as unknown as NodeJS.ReadStream,
    })).rejects.toThrow("empty secret refused");
    expect(() => readFileSync(outPath)).toThrow();
  });

  it("maps exhausted piped export input to CLI exit 1 with the named refusal", async () => {
    const pipe = new PassThrough();
    pipe.end(`${EXPORT_PASSPHRASE}\n`);
    const outPath = join(directory, "exhausted-cli-export.json");
    const stderr: string[] = [];
    const originalArgv = process.argv;
    type ExitCode = Parameters<typeof process.exit>[0];
    let resolveExit!: (code: ExitCode) => void;
    const exited = new Promise<ExitCode>((resolve) => {
      resolveExit = resolve;
    });

    process.argv = ["node", "cli.ts", "keys", "export", "--out", outPath];
    vi.spyOn(process, "stdin", "get").mockReturnValue(
      pipe as unknown as NodeJS.ReadStream & typeof process.stdin,
    );
    vi.spyOn(process.stderr, "write").mockImplementation((chunk) => {
      stderr.push(String(chunk));
      return true;
    });
    vi.spyOn(process, "exit").mockImplementation((code) => {
      resolveExit(code);
      return undefined as never;
    });

    try {
      main();
      await expect(exited).resolves.toBe(1);
      expect(stderr.join("")).toContain("llm-relay keys: empty secret refused");
      expect(() => readFileSync(outPath)).toThrow();
    } finally {
      process.argv = originalArgv;
    }
  });

  it("refuses an export passphrase confirmation mismatch without writing", async () => {
    const outPath = join(directory, "mismatched-export.json");
    const secrets = [EXPORT_PASSPHRASE, "different-export-passphrase"];

    await expect(runKeysExportLocal(outPath, {
      keystore: store,
      readSecret: async () => secrets.shift()!,
    })).rejects.toThrow("export passphrase confirmation mismatch: export refused");
    expect(() => readFileSync(outPath)).toThrow();
  });

  it("refuses a whitespace-only export passphrase before writing", async () => {
    const outPath = join(directory, "whitespace-export.json");
    const readSecret = vi.fn(async () => " \t ");

    await expect(runKeysExportLocal(outPath, {
      keystore: store,
      readSecret,
    })).rejects.toThrow("empty secret refused");
    expect(readSecret).toHaveBeenCalledTimes(1);
    expect(() => readFileSync(outPath)).toThrow();
  });

  it("restricts a Windows export with the keystore ACL seam and exact argv", async () => {
    const ownerSid = "S-1-5-21-111-222-333-1001";
    const aclSpawnSync = vi.fn(() => ({ status: 0, stdout: "", stderr: "" }));
    const outPath = join(directory, "windows-export.json");
    addEntry({
      id: "nim#default",
      provider: "nim",
      envName: "NVIDIA_API_KEY",
      value: "windows-export-secret",
    }, store);

    await runKeysExportLocal(outPath, {
      keystore: {
        ...store,
        acl: {
          platform: "win32",
          ownerSid,
          systemRoot: "D:\\Windows",
          spawnSync: aclSpawnSync,
        },
      },
      readSecret: async () => EXPORT_PASSPHRASE,
      write: () => undefined,
    });

    expect(aclSpawnSync).toHaveBeenCalledTimes(1);
    expect(aclSpawnSync).toHaveBeenCalledWith(
      "D:\\Windows\\System32\\icacls.exe",
      [
        outPath,
        "/inheritance:r",
        "/grant:r",
        `*${ownerSid}:F`,
        "*S-1-5-18:F",
        "*S-1-5-32-544:F",
      ],
      {
        windowsHide: true,
        encoding: "utf8",
        stdio: ["ignore", "pipe", "pipe"],
      },
    );
  });

  it("round-trips an encrypted export into a fresh store without plaintext in the file", async () => {
    const originalSecret = "V9rC3xN7mQ2kL8wT5pZ4";
    const secret = "K4pT9vM2xR7nC5qL8zW3";
    const expiresAt = Date.now() + 86_400_000;
    addEntry({
      id: "nim#default",
      provider: "nim",
      envName: "NVIDIA_API_KEY",
      value: originalSecret,
      expiresAt,
    }, store);
    rotateEntry("nim#default", secret, store);
    revokeEntry("nim#default", store);
    setDisabled("nim#default", true, store);
    const sourceDescriptor = listEntries(store)[0]!;
    const exportPath = join(directory, "custody-export.json");
    await runKeysExportLocal(exportPath, {
      keystore: store,
      readSecret: async () => EXPORT_PASSPHRASE,
      write: () => undefined,
    });
    expect(leaks(readFileSync(exportPath), originalSecret)).toBe(false);
    expect(leaks(readFileSync(exportPath), secret)).toBe(false);

    const destination: KeystoreOptions = {
      path: join(directory, "destination.json"),
      mode: "passphrase",
      passphrase: "destination-passphrase",
      platform: "linux",
      commandExists: () => false,
    };
    const output: string[] = [];
    await runKeysImportLocal(cfg, exportPath, {
      keystore: destination,
      env: {},
      readSecret: async () => EXPORT_PASSPHRASE,
      write: (line) => output.push(line),
    });
    const destinationDescriptor = listEntries(destination)[0]!;
    const { fingerprint: _sourceFingerprint, ...sourceLifecycle } = sourceDescriptor;
    const { fingerprint: _destinationFingerprint, ...destinationLifecycle } = destinationDescriptor;
    expect(destinationLifecycle).toEqual(sourceLifecycle);
    const verificationEnvelope = createEncryptedKeystoreExport("verification-passphrase", destination);
    expect(decryptEncryptedKeystoreExport(
      verificationEnvelope,
      "verification-passphrase",
    )[0]?.value).toBe(secret);
    expect(output.join("")).toContain("Imported nim $NVIDIA_API_KEY");
    expect(leaks(output.join(""), secret)).toBe(false);
  });

  it.each([
    [
      "freellmapi",
      JSON.stringify({
        version: 1,
        source: "freellmapi",
        keys: [{ platform: "nim", key: "A7qM2vX9cR4nK8wP5tL3" }],
      }),
      "A7qM2vX9cR4nK8wP5tL3",
    ],
    ["dotenv", "NVIDIA_API_KEY=B6zT3pV8mC2xQ7nR4kL9\n", "B6zT3pV8mC2xQ7nR4kL9"],
  ])("imports %s plaintext into the keystore and leaves source cleanup to the operator", async (_format, body, secret) => {
    const importPath = join(directory, `${_format}.txt`);
    writeFileSync(importPath, body);
    const destination: KeystoreOptions = {
      path: join(directory, `${_format}-destination.json`),
      mode: "passphrase",
      passphrase: "plain-destination-passphrase",
      platform: "linux",
      commandExists: () => false,
    };
    const output: string[] = [];
    await runKeysImportLocal(cfg, importPath, {
      keystore: destination,
      env: {},
      write: (line) => output.push(line),
    });
    expect(lookupByEnvName("NVIDIA_API_KEY", destination)?.value).toBe(secret);
    expect(output.join("")).toContain("backups and unallocated blocks");
    expect(leaks(output.join(""), secret)).toBe(false);
  });

  it("never echoes an unrecognized plaintext import name", async () => {
    const untrustedName = "sk-proj-secret-looking-import-name";
    const secret = "D7mQ2vN9xR4kC8pL5zW3";
    const importPath = join(directory, "unrecognized-freellmapi.json");
    writeFileSync(importPath, JSON.stringify({
      version: 1,
      source: "freellmapi",
      keys: [{ platform: untrustedName, key: secret }],
    }));
    const output: string[] = [];

    await runKeysImportLocal(cfg, importPath, {
      keystore: store,
      env: {},
      write: (line) => output.push(line),
    });

    const rendered = output.join("");
    expect(rendered).toContain("Skipped an unrecognized credential name.");
    expect(rendered).not.toContain(untrustedName);
    expect(leaks(rendered, secret)).toBe(false);
  });

  it("matches only loaded declarations, including a fleet-only exact slot", () => {
    const variantPath = join(directory, "matcher-fleet.json");
    const document = configDocument() as any;
    document.providers = {
      nim: {
        base: "https://nim.invalid/v1",
        kind: "openai",
        credentials: [{ label: "only", authEnv: "NIM_FLEET_EXACT" }],
      },
      anthropic: {
        base: "https://api.anthropic.com",
        kind: "anthropic",
        credentialMode: "passthrough",
      },
      openai: {
        base: "http://127.0.0.1:11434/v1",
        kind: "openai",
        credentialMode: "contained",
      },
    };
    document.routing.default = "nim/test";
    writeFileSync(variantPath, JSON.stringify(document));
    const variant = loadConfig(variantPath);
    expect(matchCredentialImportName("NIM_FLEET_EXACT", variant)).toMatchObject({
      provider: "nim",
      envName: "NIM_FLEET_EXACT",
    });
    expect(matchCredentialImportName("NIM_KEY", variant)).toMatchObject({
      provider: "nim",
      envName: "NIM_FLEET_EXACT",
    });
    expect(matchCredentialImportName("ANTHROPIC_KEY", variant)).toBeUndefined();
    expect(matchCredentialImportName("OPENAI_KEY", variant)).toBeUndefined();
  });

  it("normalizes a curated fleet alias to the sole slot's declared authEnv and identity", async () => {
    const variantPath = join(directory, "fleet-add.json");
    const document = configDocument() as any;
    document.providers = {
      nim: {
        base: "https://nim.invalid/v1",
        kind: "openai",
        credentials: [{ label: "only", authEnv: "NIM_FLEET_EXACT" }],
      },
    };
    document.routing.default = "nim/test";
    writeFileSync(variantPath, JSON.stringify(document));
    const variant = loadConfig(variantPath);
    const destination: KeystoreOptions = {
      ...store,
      path: join(directory, "fleet-alias-store.json"),
    };
    await runKeysAddLocal(variant, "nim", { envName: "NVIDIA_NIM_API_KEY" }, {
      keystore: destination,
      env: {},
      readSecret: async () => "L8qR3vN7xT2mK9pC5zW4",
      write: () => undefined,
    });
    expect(listEntries(destination)[0]).toMatchObject({
      id: "nim#only",
      envName: "NIM_FLEET_EXACT",
    });
  });

  it("selects the configured #default slot for a bare add in a multi-slot fleet", async () => {
    const variantPath = join(directory, "fleet-default-add.json");
    const document = configDocument() as any;
    document.providers = {
      fleet: {
        base: "https://fleet.invalid/v1",
        kind: "openai",
        credentials: [
          { label: "other", authEnv: "FLEET_OTHER_KEY" },
          { label: "default", authEnv: "FLEET_DEFAULT_KEY" },
        ],
      },
    };
    document.routing.default = "fleet/test";
    writeFileSync(variantPath, JSON.stringify(document));
    const variant = loadConfig(variantPath);
    const destination: KeystoreOptions = {
      ...store,
      path: join(directory, "fleet-default-store.json"),
    };
    await runKeysAddLocal(variant, "fleet", {}, {
      keystore: destination,
      env: {},
      readSecret: async () => "W8mQ3vN7xT2kC9pL5zR4",
      write: () => undefined,
    });
    expect(listEntries(destination)[0]).toMatchObject({
      id: "fleet#default",
      envName: "FLEET_DEFAULT_KEY",
    });
  });

  it("gives exact declarations global priority and refuses ambiguous aliases", () => {
    const exactPath = join(directory, "matcher-exact.json");
    const document = configDocument() as any;
    document.providers = {
      openai: {
        base: "https://api.openai.com/v1",
        kind: "openai",
        authEnv: "OPENAI_PRIMARY",
      },
      custom: {
        base: "https://custom.invalid/v1",
        kind: "openai",
        authEnv: "OPENAI_KEY",
      },
    };
    document.routing.default = "openai/test";
    writeFileSync(exactPath, JSON.stringify(document));
    const exact = loadConfig(exactPath);
    expect(matchCredentialImportName("OPENAI_KEY", exact)).toMatchObject({
      provider: "custom",
      envName: "OPENAI_KEY",
    });

    const ambiguousPath = join(directory, "matcher-ambiguous.json");
    document.providers = {
      openai: {
        base: "https://one.invalid/v1",
        kind: "openai",
        authEnv: "OPENAI_ONE",
      },
      OpenAI: {
        base: "https://two.invalid/v1",
        kind: "openai",
        authEnv: "OPENAI_TWO",
      },
    };
    writeFileSync(ambiguousPath, JSON.stringify(document));
    const ambiguous = loadConfig(ambiguousPath);
    expect(matchCredentialImportName("OPENAI_KEY", ambiguous)).toBeUndefined();
  });

  it("verifies wrong then right unlock passphrases without memoized false rejection", async () => {
    addEntry({
      id: "nim#default",
      provider: "nim",
      envName: "NVIDIA_API_KEY",
      value: "unlock-secret",
    }, store);
    lock({ path: storePath });
    await expect(runKeysUnlockLocal({
      keystore: { path: storePath, mode: "passphrase", platform: "linux" },
      readSecret: async () => "wrong-passphrase",
    })).rejects.toThrow("keystore unlock failed");
    const output: string[] = [];
    await runKeysUnlockLocal({
      keystore: { path: storePath, mode: "passphrase", platform: "linux" },
      readSecret: async () => STORE_PASSPHRASE,
      write: (line) => output.push(line),
    });
    expect(output.join("")).toContain("Passphrase verified");
    expect(output.join("")).toContain("No cross-process KEK cache");
  });

  it("treats unlock as a no-op for a non-passphrase store without prompting", async () => {
    const osStorePath = join(directory, "os-keystore.json");
    const osStore: KeystoreOptions = {
      path: osStorePath,
      mode: "libsecret",
      platform: "linux",
      commandExists: () => true,
      spawnSync: () => ({ status: 0, stdout: Buffer.alloc(0), stderr: Buffer.alloc(0) }),
    };
    addEntry({
      id: "nim#default",
      provider: "nim",
      envName: "NVIDIA_API_KEY",
      value: "os-custody-secret",
    }, osStore);
    const readSecret = vi.fn(async () => "must-not-be-read");
    const output: string[] = [];

    await runKeysUnlockLocal({
      keystore: { path: osStorePath, platform: "linux" },
      readSecret,
      write: (line) => output.push(line),
    });

    expect(readSecret).not.toHaveBeenCalled();
    expect(output.join("")).toContain("libsecret; unlock is a no-op there");
  });

  it("pins keys command mutation classification", () => {
    const argv = (...args: string[]): string[] => ["node", "cli.ts", ...args];
    for (const subcommand of ["add", "rotate", "revoke", "remove", "disable", "enable", "export", "import"]) {
      expect(classifyCommand(argv("keys", subcommand))).toBe("mutating");
    }
    for (const subcommand of [undefined, "list", "unlock", "check"]) {
      expect(classifyCommand(argv("keys", ...(subcommand === undefined ? [] : [subcommand])))).toBe("read-only");
    }
  });

  it("keeps --label and --out values out of keys positional arguments", () => {
    expect(validateKeysCommandArgs([
      "node", "cli.ts", "keys", "add", "nim", "--label", "default",
    ])).toBeNull();
    expect(validateKeysCommandArgs([
      "node", "cli.ts", "keys", "export", "--out", join(directory, "export.json"),
    ])).toBeNull();
    expect(validateKeysCommandArgs([
      "node", "cli.ts", "keys", "export", "--out", "--check",
    ])).toBe("invalid arguments");
    expect(validateKeysCommandArgs([
      "node", "cli.ts", "keys", "typo", "--help",
    ])).toContain("valid subcommands");
  });

  it.each([
    ["extra positional", ["keys", "add", "nim", "argv-secret"]],
    ["unsupported option", ["keys", "add", "nim", "--secret=argv-secret"]],
  ])("rejects a keys add %s generically before prompting or mutation", (_case, args) => {
    const originalArgv = process.argv;
    const stderr: string[] = [];
    process.argv = ["node", "cli.ts", ...args];
    vi.spyOn(process.stderr, "write").mockImplementation((chunk) => {
      stderr.push(String(chunk));
      return true;
    });
    vi.spyOn(process, "exit").mockImplementation((code) => {
      throw new Error(`exit:${code}`);
    });
    try {
      expect(() => main()).toThrow("exit:1");
      expect(stderr.join("")).toMatch(/llm-relay keys: (invalid arguments|unsupported option)/u);
      expect(leaks(stderr.join(""), "argv-secret")).toBe(false);
      expect(() => readFileSync(storePath)).toThrow();
    } finally {
      process.argv = originalArgv;
    }
  });

  it("fails an unknown keys subcommand and names the valid set", () => {
    const originalArgv = process.argv;
    const stderr: string[] = [];
    process.argv = ["node", "cli.ts", "keys", "typo", "--help"];
    vi.spyOn(process.stderr, "write").mockImplementation((chunk) => {
      stderr.push(String(chunk));
      return true;
    });
    vi.spyOn(process, "exit").mockImplementation((code) => {
      throw new Error(`exit:${code}`);
    });
    try {
      expect(() => main()).toThrow("exit:1");
      expect(stderr.join("")).toContain("llm-relay keys: unknown subcommand");
      expect(stderr.join("")).not.toContain("typo");
      expect(stderr.join("")).toContain("add, list, rotate, revoke, remove, disable, enable, export, import, unlock, check");
    } finally {
      process.argv = originalArgv;
    }
  });
});
