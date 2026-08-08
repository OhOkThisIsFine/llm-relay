import { describe, it, expect, beforeEach, afterAll } from "vitest";
import { mkdtempSync, rmSync, readFileSync, existsSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  parseStatedContextLimit,
  looksLikeContextLengthError,
  recordObservedContextLimit,
  observedContextLimit,
  flushObservedContextLimits,
  resetObservedContextLimits,
  OBSERVED_LIMIT_TTL_MS,
} from "../src/context-limits.js";

const dir = mkdtempSync(join(tmpdir(), "rp-ctxlimit-"));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

let n = 0;
let path = "";
beforeEach(() => {
  path = join(dir, `limits${n++}.json`);
  resetObservedContextLimits();
});

describe("parsing a STATED ceiling out of an error body", () => {
  it.each([
    ["OpenAI", "This model's maximum context length is 8192 tokens. However, you requested 10000 tokens.", 8192],
    ["Anthropic", "prompt is too long: 250000 tokens > 200000 maximum", 200000],
    ["comma-grouped", "This model's maximum context length is 131,072 tokens", 131072],
    ["vLLM-ish", "The model's maximum context length of 32768 was exceeded", 32768],
  ])("reads the maximum from a %s-style message", (_label, body, expected) => {
    expect(parseStatedContextLimit(body)).toBe(expected);
  });

  it("captures the MAXIMUM, never the requested count", () => {
    // The requested number is always the larger one in these messages. Capturing it would persist
    // a ceiling above the real one and cause exactly the overflow this exists to prevent — the
    // single most dangerous way this parser could be wrong.
    const body = "This model's maximum context length is 8192 tokens. However, you requested 999999 tokens.";
    expect(parseStatedContextLimit(body)).toBe(8192);
  });

  it("returns null when the body proves the request was too long but states no ceiling", () => {
    // "It was too long" bounds the limit by OUR OWN estimate (chars/4), which is a guess. The
    // store's whole value is that it holds measurements, so a guess must not enter it.
    expect(looksLikeContextLengthError("Request too long for this model.")).toBe(true);
    expect(parseStatedContextLimit("Request too long for this model.")).toBeNull();
  });

  it("returns null for unrelated errors and junk", () => {
    for (const body of ["", "rate limit exceeded", "invalid api key", "{}", "internal server error"]) {
      expect(parseStatedContextLimit(body)).toBeNull();
    }
  });

  it("rejects an implausible ceiling rather than persisting a parse artifact", () => {
    expect(parseStatedContextLimit("maximum context length is 999999999999 tokens")).toBeNull();
  });

  it("does not scan an unbounded body", () => {
    const buried = "x".repeat(20000) + " maximum context length is 4096 tokens";
    expect(parseStatedContextLimit(buried)).toBeNull();
  });
});

describe("the learned-limit store", () => {
  it("records and reads back a ceiling per deployment", () => {
    recordObservedContextLimit("nim", "z-ai/glm-5.2", 131072, { path });
    expect(observedContextLimit("nim", "z-ai/glm-5.2", { path })).toBe(131072);
  });

  it("keys by (provider, model) — the same model id on two hosts is two deployments", () => {
    recordObservedContextLimit("nim", "m", 32768, { path });
    expect(observedContextLimit("openrouter", "m", { path })).toBeNull();
  });

  it("lets a fresh observation replace an older one, in both directions", () => {
    // The deployment is the authority on its own ceiling; a provider that raised or lowered it is
    // telling us so, and refusing the update would pin us to a stale number forever.
    recordObservedContextLimit("nim", "m", 8192, { path, now: 1000 });
    recordObservedContextLimit("nim", "m", 131072, { path, now: 2000 });
    expect(observedContextLimit("nim", "m", { path, now: 3000 })).toBe(131072);
    recordObservedContextLimit("nim", "m", 4096, { path, now: 4000 });
    expect(observedContextLimit("nim", "m", { path, now: 5000 })).toBe(4096);
  });

  it("expires, so a raised ceiling is not disbelieved forever", () => {
    recordObservedContextLimit("nim", "m", 8192, { path, now: 0 });
    expect(observedContextLimit("nim", "m", { path, now: OBSERVED_LIMIT_TTL_MS - 1 })).toBe(8192);
    expect(observedContextLimit("nim", "m", { path, now: OBSERVED_LIMIT_TTL_MS + 1 })).toBeNull();
  });

  it("ignores a nonsensical value instead of storing it", () => {
    for (const bad of [0, -1, Number.NaN, Number.POSITIVE_INFINITY, 1e12]) {
      recordObservedContextLimit("nim", "bad", bad, { path });
      expect(observedContextLimit("nim", "bad", { path })).toBeNull();
    }
  });

  it("survives a flush to disk and a fresh read", () => {
    recordObservedContextLimit("nim", "m", 65536, { path });
    flushObservedContextLimits({ path });
    expect(existsSync(path)).toBe(true);

    // ⚠ Asserts the ROUND TRIP, not the file's internal shape. Ceilings moved into the shared
    // `target-facts.ts` store so scope and keying live in one place, which changed the on-disk
    // layout deliberately — a test pinning `limits["nim/m"].tokens` was pinning an implementation
    // detail and would have to be rewritten by anyone who ever reorganised the storage. What must
    // hold is that a learned ceiling survives a restart.
    const onDisk = JSON.parse(readFileSync(path, "utf8")) as unknown;
    expect(JSON.stringify(onDisk)).toContain("65536");

    resetObservedContextLimits();
    expect(observedContextLimit("nim", "m", { path })).toBe(65536);
  });

  it("starts clean on a corrupt file rather than throwing", () => {
    // A learned limit is an optimization, never a correctness dependency — losing the file must
    // not fail a request.
    const bad = join(dir, "corrupt.json");
    writeFileSync(bad, "{ not json");
    resetObservedContextLimits();
    expect(observedContextLimit("nim", "m", { path: bad })).toBeNull();
  });
});

// ── The loop, closed end to end ────────────────────────────────────────────────────────────────
import { createServer, type Server } from "node:http";
import { AddressInfo } from "node:net";
import { createProxy } from "../src/server.js";
import { ModelCatalog } from "../src/catalog.js";
import { globalCircuitBreaker } from "../src/circuit-breaker.js";
import type { Config } from "../src/config.js";

const servers: Server[] = [];
afterAll(async () => {
  await Promise.all(servers.splice(0).map((s) => new Promise((r) => s.close(r))));
});

/** A backend that rejects everything with a provider-style context-length error. */
function tooLongBackend(message: string): Promise<Server> {
  return new Promise((resolve) => {
    const s = createServer((req, res) => {
      req.on("data", () => {});
      req.on("end", () => {
        res.writeHead(400, { "content-type": "application/json" });
        res.end(JSON.stringify({ error: { message, type: "invalid_request_error" } }));
      });
    });
    s.listen(0, "127.0.0.1", () => {
      servers.push(s);
      resolve(s);
    });
  });
}

const portOf = (s: Server): number => (s.address() as AddressInfo).port;

function singleCfg(base: string): Config {
  return {
    host: "127.0.0.1",
    port: 0,
    providers: { p1: { base, kind: "openai", authHeader: "authorization", timeoutMs: 5000 } },
    routing: { default: "p1/tiny-model", tiers: {}, benchmarkSort: false },
    mode: "detect",
    repair: { maxAttempts: 2, destructiveTools: [] },
    log: { level: "silent", file: null },
  } as Config;
}

function startProxy(c: Config): Promise<Server> {
  const s = createProxy(c, { catalog: new ModelCatalog({ cachePath: null }), breaker: globalCircuitBreaker });
  return new Promise((r) =>
    s.listen(0, "127.0.0.1", () => {
      servers.push(s);
      r(s);
    }),
  );
}

describe("learning a ceiling from a real backend rejection", () => {
  const MSG = "This model's maximum context length is 8192 tokens. However, you requested 40000 tokens.";

  beforeEach(() => {
    globalCircuitBreaker.reset();
    resetObservedContextLimits();
  });

  it("learns from the OpenAI front (/v1/chat/completions)", async () => {
    const backend = await tooLongBackend(MSG);
    const p = portOf(await startProxy(singleCfg(`http://127.0.0.1:${portOf(backend)}`)));

    const r = await fetch(`http://127.0.0.1:${p}/v1/chat/completions`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ model: "p1/tiny-model", messages: [{ role: "user", content: "hi" }] }),
    });
    expect(r.status).toBe(400);

    // The body is read from a clone, asynchronously — give the microtask a turn to land.
    await new Promise((res) => setTimeout(res, 50));
    expect(observedContextLimit("p1", "tiny-model")).toBe(8192);
  });

  it("learns from the Anthropic front (/v1/messages) too — one policy, both paths", async () => {
    // ⚠ This repo has already shipped a defect where the OpenAI front had no copy of a policy the
    // Anthropic path enforced. A learning loop wired into only one front would silently know
    // nothing about half the traffic, so both are asserted.
    const backend = await tooLongBackend(MSG);
    const p = portOf(await startProxy(singleCfg(`http://127.0.0.1:${portOf(backend)}`)));

    const r = await fetch(`http://127.0.0.1:${p}/v1/messages`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ model: "p1/tiny-model", max_tokens: 16, messages: [{ role: "user", content: "hi" }] }),
    });
    expect(r.status).toBe(400);

    await new Promise((res) => setTimeout(res, 50));
    expect(observedContextLimit("p1", "tiny-model")).toBe(8192);
  });

  it("learns nothing from an error that states no ceiling", async () => {
    const backend = await tooLongBackend("Request too long.");
    const p = portOf(await startProxy(singleCfg(`http://127.0.0.1:${portOf(backend)}`)));

    await fetch(`http://127.0.0.1:${p}/v1/chat/completions`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ model: "p1/tiny-model", messages: [{ role: "user", content: "hi" }] }),
    });
    await new Promise((res) => setTimeout(res, 50));
    expect(observedContextLimit("p1", "tiny-model")).toBeNull();
  });

  it("does not corrupt the response the client receives", async () => {
    // Learning reads a CLONE; the real body must reach the caller byte-for-byte.
    const backend = await tooLongBackend(MSG);
    const p = portOf(await startProxy(singleCfg(`http://127.0.0.1:${portOf(backend)}`)));

    const r = await fetch(`http://127.0.0.1:${p}/v1/chat/completions`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ model: "p1/tiny-model", messages: [{ role: "user", content: "hi" }] }),
    });
    const body = (await r.json()) as { error?: { message?: string } };
    expect(body.error?.message).toBe(MSG);
  });
});
