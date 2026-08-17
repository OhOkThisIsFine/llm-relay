import { afterAll, afterEach, describe, expect, it } from "vitest";
import { createServer, type Server } from "node:http";
import { AddressInfo } from "node:net";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  buildAuthHeaders,
  candidateEnvNames,
  credentialState,
  keyIsPresent,
  readCredential,
  resolveAuthEnv,
  resolveCredential,
} from "../src/authEnv.js";
import { loadConfig, type Config, type ProviderConfig } from "../src/config.js";
import { createProxy } from "../src/server.js";
import { ModelCatalog } from "../src/catalog.js";

const tmp = mkdtempSync(join(tmpdir(), "rp-cred-containment-"));
afterAll(() => rmSync(tmp, { recursive: true, force: true }));

function write(name: string, obj: unknown): string {
  const p = join(tmp, name);
  writeFileSync(p, JSON.stringify(obj));
  return p;
}

function backupEnv(keys: string[]): Record<string, string | undefined> {
  const saved: Record<string, string | undefined> = {};
  for (const key of keys) {
    saved[key] = process.env[key];
    delete process.env[key];
  }
  return saved;
}

function restoreEnv(saved: Record<string, string | undefined>): void {
  for (const [key, value] of Object.entries(saved)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
}

function port(s: Server): number {
  return (s.address() as AddressInfo).port;
}

function startProxy(configPath: string): Promise<Server> {
  const proxy = createProxy(loadConfig(configPath), {
    catalog: new ModelCatalog({ cachePath: null }),
  });
  return new Promise((resolve) => proxy.listen(0, "127.0.0.1", () => resolve(proxy)));
}

async function mockOpenAiBackend(
  body: string = JSON.stringify({ id: "cmpl_1", object: "chat.completion", choices: [{ message: { role: "assistant", content: "ok" } }] }),
): Promise<{ server: Server; seen: () => { path?: string; auth?: string; model?: string } }> {
  let seen: { path?: string; auth?: string; model?: string } = {};
  const server = await new Promise<Server>((resolve) => {
    const s = createServer((req, res) => {
      const chunks: Buffer[] = [];
      req.on("data", (c) => chunks.push(c));
      req.on("end", () => {
        seen = {
          path: req.url ?? "",
          ...(typeof req.headers.authorization === "string" ? { auth: req.headers.authorization } : {}),
        };
        try {
          const parsed = JSON.parse(Buffer.concat(chunks).toString());
          if (typeof parsed.model === "string") seen.model = parsed.model;
        } catch {
          // keep captured headers only
        }
        res.writeHead(200, { "content-type": "application/json" });
        res.end(body);
      });
    });
    s.listen(0, "127.0.0.1", () => resolve(s));
  });
  return { server, seen: () => seen };
}

async function mockAnthropicBackend(
): Promise<{ server: Server; seen: () => { path?: string; auth?: string; inboundAuthorization?: string; model?: string } }> {
  let seen: { path?: string; auth?: string; inboundAuthorization?: string; model?: string } = {};
  const server = await new Promise<Server>((resolve) => {
    const s = createServer((req, res) => {
      const chunks: Buffer[] = [];
      req.on("data", (c) => chunks.push(c));
      req.on("end", () => {
        seen = {
          path: req.url ?? "",
          ...(typeof req.headers["x-api-key"] === "string" ? { auth: req.headers["x-api-key"] } : {}),
          ...(typeof req.headers.authorization === "string" ? { inboundAuthorization: req.headers.authorization } : {}),
        };
        try {
          const parsed = JSON.parse(Buffer.concat(chunks).toString());
          if (typeof parsed.model === "string") seen.model = parsed.model;
        } catch {
          // keep captured headers only
        }
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({
          id: "msg_1",
          type: "message",
          role: "assistant",
          model: seen.model ?? "claude-3-5-haiku-20241022",
          content: [{ type: "text", text: "ok" }],
          stop_reason: "end_turn",
        }));
      });
    });
    s.listen(0, "127.0.0.1", () => resolve(s));
  });
  return { server, seen: () => seen };
}

describe("credential containment declared, not inferred", () => {
  it("distinguishes not-declared from declared-missing", () => {
    expect(credentialState(undefined, {})).toBe("not-declared");
    expect(credentialState("SOME_KEY", {})).toBe("declared-missing");
    expect(credentialState("SOME_KEY", { SOME_KEY: "sk-live" })).toBe("declared-present");
  });

  it("resolves provider env aliases when declared variable is unset", () => {
    const env = { GOOGLE_API_KEY: "sk-google-key" };
    expect(credentialState("GEMINI_API_KEY", env, "gemini")).toBe("declared-present");
    expect(readCredential("GEMINI_API_KEY", env, "gemini")).toBe("sk-google-key");
  });

  it("treats whitespace-only key as missing, not present", () => {
    expect(keyIsPresent("   ")).toBe(false);
    expect(keyIsPresent("")).toBe(false);
    expect(keyIsPresent(undefined)).toBe(false);
    expect(keyIsPresent("\t\n")).toBe(false);
    expect(keyIsPresent(" sk-live ")).toBe(true);
    expect(credentialState("BLANK_KEY", { BLANK_KEY: "   " })).toBe("declared-missing");
  });

  it("does NOT derive state from resolveAuthEnv returning a name", () => {
    const env = { ANTHROPIC_API_KEY: "sk-ant-from-environment" };
    const resolution = resolveAuthEnv("anthropic", undefined, env);
    expect(resolution.name).toBe("ANTHROPIC_API_KEY");
    expect(resolution.viaAlias).toBe(true);

    expect(credentialState(undefined, env)).toBe("not-declared");
  });

  it("keeps alias-substitution signal available to callers", () => {
    const env = { ANTHROPIC_AUTH_TOKEN: "sk-ant-oat01-x" };
    const r = resolveAuthEnv("anthropic", "ANTHROPIC_API_KEY", env);
    expect(r.name).toBe("ANTHROPIC_AUTH_TOKEN");
    expect(r.viaAlias).toBe(true);
    expect(r.candidates).toContain("ANTHROPIC_API_KEY");
  });

  it("never scans the environment for key-shaped names", () => {
    const env = { TOTALLY_UNRELATED_API_KEY: "sk-should-not-be-found" };
    const r = resolveAuthEnv("nim", "NVIDIA_API_KEY", env);
    expect(r.name).toBe("NVIDIA_API_KEY");
    expect(r.viaAlias).toBe(false);
    expect(r.candidates).not.toContain("TOTALLY_UNRELATED_API_KEY");
  });
});

describe("resolveCredential atomics", () => {
  it("keeps undeclared ambient credentials out of resolution", () => {
    expect(resolveCredential(undefined, { AMBIENT_API_KEY: "sk-ambient" }, "ambient")).toEqual({
      state: "not-declared", value: undefined, envName: undefined,
    });
  });

  it("distinguishes missing, blank, whitespace, and trimmed direct values", () => {
    expect(resolveCredential("GEMINI_API_KEY", {}, "gemini")).toEqual({
      state: "declared-missing", value: undefined, envName: "GEMINI_API_KEY",
    });
    expect(resolveCredential("GEMINI_API_KEY", { GEMINI_API_KEY: "" }, "gemini")).toEqual({
      state: "declared-missing", value: undefined, envName: "GEMINI_API_KEY",
    });
    expect(resolveCredential("GEMINI_API_KEY", { GEMINI_API_KEY: "  \t" }, "gemini")).toEqual({
      state: "declared-missing", value: undefined, envName: "GEMINI_API_KEY",
    });
    expect(resolveCredential("GEMINI_API_KEY", { GEMINI_API_KEY: "  sk-direct  " }, "gemini")).toEqual({
      state: "declared-present", value: "sk-direct", envName: "GEMINI_API_KEY",
    });
  });

  it("returns declared-present with explicit declared env and alias metadata", () => {
    const out = resolveCredential("GEMINI_API_KEY", { GEMINI_API_KEY: "sk-declared", GOOGLEAI_API_KEY: "sk-alias" }, "gemini");
    expect(out).toEqual({
      state: "declared-present",
      envName: "GEMINI_API_KEY",
      value: "sk-declared",
    });
  });

  it("returns declared-present with provider alias fallback", () => {
    const out = resolveCredential("GEMINI_API_KEY", { GOOGLEAI_API_KEY: "sk-alias" }, "gemini");
    expect(out).toEqual({
      state: "declared-present",
      envName: "GOOGLEAI_API_KEY",
      value: "sk-alias",
    });
  });

  it("treats whitespace-only alias value as declared-missing", () => {
    const out = resolveCredential("GEMINI_API_KEY", { GOOGLEAI_API_KEY: "   " }, "gemini");
    expect(out).toEqual({
      state: "declared-missing",
      envName: "GEMINI_API_KEY",
      value: undefined,
    });
  });

  it("threads a custom configured provider name for provider-derived aliases", () => {
    expect(resolveCredential("CUSTOM_AUTH", { CUSTOM_PROVIDER_API_KEY: "  sk-derived  " }, "custom-provider")).toEqual({
      state: "declared-present",
      envName: "CUSTOM_PROVIDER_API_KEY",
      value: "sk-derived",
    });
  });
});

describe("readCredential", () => {
  it("returns the trimmed value only when credential is present", () => {
    expect(readCredential("K", { K: "  sk-live  " })).toBe("sk-live");
    expect(readCredential("K", { K: "   " })).toBeUndefined();
    expect(readCredential("K", {})).toBeUndefined();
  });

  it("returns undefined when no authEnv is declared, without consulting env", () => {
    expect(readCredential(undefined, { ANTHROPIC_API_KEY: "sk-ant-ambient" })).toBeUndefined();
  });

  it("agrees with credentialState on every input", () => {
    const cases: Array<[string | undefined, NodeJS.ProcessEnv]> = [
      [undefined, {}],
      [undefined, { K: "sk" }],
      ["K", {}],
      ["K", { K: "" }],
      ["K", { K: "  " }],
      ["K", { K: "sk" }],
    ];
    for (const [declared, env] of cases) {
      const hasValue = readCredential(declared, env) !== undefined;
      expect(hasValue).toBe(credentialState(declared, env) === "declared-present");
    }
  });
});

describe("buildAuthHeaders is the single construction site", () => {
  it("injects the credential into the DECLARED header", () => {
    expect(buildAuthHeaders("sk-live", "x-api-key")).toEqual({ "x-api-key": "sk-live" });
    expect(buildAuthHeaders("sk-live", "authorization")).toEqual({ authorization: "Bearer sk-live" });
  });

  it("builds NOTHING for absent or blank credential", () => {
    for (const header of ["x-api-key", "authorization"] as const) {
      expect(buildAuthHeaders(undefined, header)).toEqual({});
      expect(buildAuthHeaders("", header)).toEqual({});
      expect(buildAuthHeaders("   ", header)).toEqual({});
      expect(buildAuthHeaders("\t\n", header)).toEqual({});
    }
  });

  it("trims the value, so a key pasted with a trailing newline still authenticates", () => {
    expect(buildAuthHeaders(" sk-live\n", "x-api-key")).toEqual({ "x-api-key": "sk-live" });
    expect(buildAuthHeaders(" sk-live\n", "authorization")).toEqual({ authorization: "Bearer sk-live" });
  });

  it("prefixes Bearer idempotently", () => {
    expect(buildAuthHeaders("Bearer sk-live", "authorization")).toEqual({ authorization: "Bearer sk-live" });
    expect(buildAuthHeaders("  Bearer sk-live  ", "authorization")).toEqual({ authorization: "Bearer sk-live" });
    expect(buildAuthHeaders("Bearer sk-live", "x-api-key")).toEqual({ "x-api-key": "Bearer sk-live" });
  });

  it("emits exactly one credential header, never both", () => {
    expect(Object.keys(buildAuthHeaders("sk-live", "x-api-key"))).toEqual(["x-api-key"]);
    expect(Object.keys(buildAuthHeaders("sk-live", "authorization"))).toEqual(["authorization"]);
  });

  it("composes with readCredential end-to-end", () => {
    const env = { NVIDIA_API_KEY: " nvapi-xyz \n" };
    expect(buildAuthHeaders(readCredential("NVIDIA_API_KEY", env), "authorization")).toEqual({
      authorization: "Bearer nvapi-xyz",
    });
    expect(buildAuthHeaders(readCredential("MISSING_KEY", env), "authorization")).toEqual({});
  });
});

describe("public HTTP fronts resolve provider-derived aliases", () => {
  let backend: Server;
  let proxy: Server;
  afterEach(() => {
    backend?.close();
    proxy?.close();
  });

  it("routes /v1/messages using only a provider-derived alias key", async () => {
    const saved = backupEnv([...new Set([
      ...candidateEnvNames("anthropic", "ANTHROPIC_API_KEY"),
      ...candidateEnvNames("claude", "ANTHROPIC_API_KEY"),
    ])]);
    process.env.ANTHROPIC_AUTH_TOKEN = "sk-anthropic-alias";
    try {
      const mock = await mockAnthropicBackend();
      backend = mock.server;
      const provider = {
        base: `http://127.0.0.1:${port(backend)}`,
        kind: "anthropic" as const,
        authHeader: "x-api-key" as const,
        timeoutMs: 5000,
        authEnv: "ANTHROPIC_API_KEY",
      };
      const config = {
        listen: "127.0.0.1:8791",
        providers: { claude: provider },
        routing: { default: "claude", tiers: {} },
      };

      proxy = await startProxy(write("messages-anthropic.json", config));
      const p = port(proxy);
      const reqBody = {
        model: "claude-3-5-haiku-20241022",
        messages: [{ role: "user", content: "hello" }],
      };
      const response = await fetch(`http://127.0.0.1:${p}/v1/messages`, {
        method: "POST",
        headers: { "content-type": "application/json", authorization: "Bearer caller-token" },
        body: JSON.stringify(reqBody),
      });

      expect(response.status).toBe(200);
      expect(mock.seen().auth).toBe("sk-anthropic-alias");
      expect(mock.seen().inboundAuthorization).toBeUndefined();
      expect(mock.seen().path).toBe("/v1/messages");
    } finally {
      restoreEnv(saved);
    }
  });

  it("routes /v1/chat/completions using only a provider-derived alias key", async () => {
    const saved = backupEnv([...candidateEnvNames("gemini", "GEMINI_API_KEY")]);
    process.env.GOOGLEAI_API_KEY = "sk-gemini-alias";
    try {
      const mock = await mockOpenAiBackend();
      backend = mock.server;
      const provider: ProviderConfig = {
        base: `http://127.0.0.1:${port(backend)}`,
        kind: "openai",
        authHeader: "authorization",
        timeoutMs: 5000,
        authEnv: "GEMINI_API_KEY",
      };
      const config = {
        listen: "127.0.0.1:8791",
        providers: { gemini: provider },
        routing: { default: "gemini/gemini-2.0-flash", tiers: {} },
      };

      proxy = await startProxy(write("chat-gemini.json", config));
      const p = port(proxy);
      const response = await fetch(`http://127.0.0.1:${p}/v1/chat/completions`, {
        method: "POST",
        headers: { "content-type": "application/json", authorization: "Bearer caller-token" },
        body: JSON.stringify({
          model: "gemini/gemini-2.0-flash",
          messages: [{ role: "user", content: "hello" }],
        }),
      });
      expect(response.status).toBe(200);
      expect(mock.seen().auth).toBe("Bearer sk-gemini-alias");
      expect(mock.seen().model).toBe("gemini-2.0-flash");
    } finally {
      restoreEnv(saved);
    }
  });

  it("routes a configured-provider-derived API key without inbound authorization", async () => {
    const saved = backupEnv(candidateEnvNames("custom-provider", "CUSTOM_DECLARED_KEY"));
    process.env.CUSTOM_PROVIDER_API_KEY = "sk-custom-derived";
    try {
      const mock = await mockOpenAiBackend();
      backend = mock.server;
      const provider: ProviderConfig = {
        base: `http://127.0.0.1:${port(backend)}`,
        kind: "openai",
        authHeader: "authorization",
        timeoutMs: 5000,
        authEnv: "CUSTOM_DECLARED_KEY",
      };
      const config = {
        listen: "127.0.0.1:8791",
        providers: { "custom-provider": provider },
        routing: { default: "custom-provider/custom-model", tiers: {} },
      };

      proxy = await startProxy(write("chat-custom-provider.json", config));
      const response = await fetch(`http://127.0.0.1:${port(proxy)}/v1/chat/completions`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          model: "custom-provider/custom-model",
          messages: [{ role: "user", content: "hello" }],
        }),
      });

      expect(response.status).toBe(200);
      expect(mock.seen().auth).toBe("Bearer sk-custom-derived");
      expect(mock.seen().model).toBe("custom-model");
    } finally {
      restoreEnv(saved);
    }
  });
});
