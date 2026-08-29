import { describe, it, expect, beforeEach, afterAll } from "vitest";
import { mkdtempSync, rmSync, readFileSync, existsSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  parseStatedContextLimit,
  looksLikeContextLengthError,
  parseStatedMaxOutput,
  looksLikeMaxOutputError,
  recordObservedContextLimit,
  observedContextLimit,
  recordObservedMaxOutput,
  observedMaxOutput,
  flushObservedContextLimits,
  resetObservedContextLimits,
  OBSERVED_LIMIT_TTL_MS,
  OBSERVED_MAX_OUTPUT_TTL_MS,
} from "../src/context-limits.js";
import { clearFacts } from "../src/target-facts.js";

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

  it("keeps deployment measurements through a credential-less condition clear", () => {
    recordObservedContextLimit("nim", "m", 131072, { path });
    clearFacts("nim", null, "m", { path });
    expect(observedContextLimit("nim", "m", { path })).toBe(131072);
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

// ── The max-output half (docs/max-output-caps-design-2026-08-29.md) ────────────────────────────

describe("parsing a STATED max_tokens ceiling out of an error body", () => {
  it.each([
    ["Groq", "`max_tokens` must be less than or equal to `8192`, the maximum value for `max_tokens` is less than the `context_window` for this model", 8192],
    ["TGI", "Input validation error: `max_new_tokens` must be <= 4096. Given: 20000", 4096],
    ["OpenAI", "max_tokens is too large: 40000. This model supports at most 16384 completion tokens, whereas you provided 40000.", 16384],
    ["Anthropic", "max_tokens: 40000 > 8192, which is the maximum allowed number of output tokens for this model", 8192],
    ["bare-comparison", "max_tokens: 100000 > 65536 maximum", 65536],
    ["restated-field", "the maximum value for `max_tokens` is 8192", 8192],
    ["comma-grouped", "`max_tokens` must be less than or equal to `32,768`", 32768],
  ])("reads the maximum from a %s-style message", (_label, body, expected) => {
    expect(parseStatedMaxOutput(body as string)).toBe(expected);
  });

  it("captures the MAXIMUM, never the requested count", () => {
    // The requested number is the larger one. Capturing it would overstate the real ceiling —
    // the single most dangerous way this parser could be wrong, same as the context half.
    const body = "max_tokens: 999999 > 8192, which is the maximum allowed number of output tokens";
    expect(parseStatedMaxOutput(body)).toBe(8192);
  });

  it("returns null when the body proves the cap was exceeded but states no ceiling", () => {
    expect(looksLikeMaxOutputError("max_tokens is too large for this model.")).toBe(true);
    expect(parseStatedMaxOutput("max_tokens is too large for this model.")).toBeNull();
  });

  it("returns null for unrelated errors, junk, and CONTEXT-ceiling messages", () => {
    // The last entry pins the separation: a context-window statement is not an output ceiling.
    for (const body of ["", "rate limit exceeded", "{}", "This model's maximum context length is 8192 tokens."]) {
      expect(parseStatedMaxOutput(body)).toBeNull();
    }
  });

  it("yields no CONTEXT limit from a max_tokens body — the two parsers stay separate", () => {
    const groq = "`max_tokens` must be less than or equal to `8192`, the maximum value for `max_tokens` is less than the `context_window` for this model";
    expect(parseStatedContextLimit(groq)).toBeNull();
  });

  it("rejects an implausible ceiling rather than persisting a parse artifact", () => {
    expect(parseStatedMaxOutput("`max_tokens` must be less than or equal to `999999999999`")).toBeNull();
  });

  it("does not scan an unbounded body", () => {
    const buried = "x".repeat(20000) + " `max_tokens` must be less than or equal to `4096`";
    expect(parseStatedMaxOutput(buried)).toBeNull();
  });
});

describe("the learned max-output store", () => {
  it("records and reads back an output ceiling per deployment", () => {
    recordObservedMaxOutput("groq", "qwen/qwen3.6-27b", 8192, { path });
    expect(observedMaxOutput("groq", "qwen/qwen3.6-27b", { path })).toBe(8192);
  });

  it("keeps the measurement through a condition clear — a success disproves no ceiling", () => {
    recordObservedMaxOutput("groq", "m", 8192, { path });
    clearFacts("groq", null, "m", { path });
    expect(observedMaxOutput("groq", "m", { path })).toBe(8192);
  });

  it("keys by (provider, model), and sits BESIDE the context ceiling on the same cell", () => {
    // The `<kind>:<scope>` store keying is what lets one deployment carry both measurements at
    // once; a scope-only key would collapse them to whichever was written last.
    recordObservedMaxOutput("groq", "m", 8192, { path });
    recordObservedContextLimit("groq", "m", 131072, { path });
    expect(observedMaxOutput("groq", "m", { path })).toBe(8192);
    expect(observedContextLimit("groq", "m", { path })).toBe(131072);
    expect(observedMaxOutput("openrouter", "m", { path })).toBeNull();
  });

  it("lets a fresh observation replace an older one, in both directions", () => {
    recordObservedMaxOutput("groq", "m", 8192, { path, now: 1000 });
    recordObservedMaxOutput("groq", "m", 16384, { path, now: 2000 });
    expect(observedMaxOutput("groq", "m", { path, now: 3000 })).toBe(16384);
    recordObservedMaxOutput("groq", "m", 4096, { path, now: 4000 });
    expect(observedMaxOutput("groq", "m", { path, now: 5000 })).toBe(4096);
  });

  it("expires, so a raised ceiling is not disbelieved forever", () => {
    recordObservedMaxOutput("groq", "m", 8192, { path, now: 0 });
    expect(observedMaxOutput("groq", "m", { path, now: OBSERVED_MAX_OUTPUT_TTL_MS - 1 })).toBe(8192);
    expect(observedMaxOutput("groq", "m", { path, now: OBSERVED_MAX_OUTPUT_TTL_MS + 1 })).toBeNull();
  });

  it("ignores a nonsensical value instead of storing it", () => {
    for (const bad of [0, -1, Number.NaN, Number.POSITIVE_INFINITY, 1e12]) {
      recordObservedMaxOutput("groq", "bad", bad, { path });
      expect(observedMaxOutput("groq", "bad", { path })).toBeNull();
    }
  });
});

describe("learning a stated max_tokens ceiling from a real backend rejection", () => {
  const GROQ_MSG = "`max_tokens` must be less than or equal to `8192`, the maximum value for `max_tokens` is less than the `context_window` for this model";

  beforeEach(() => {
    globalCircuitBreaker.reset();
    resetObservedContextLimits();
  });

  it("learns from the OpenAI front (/v1/chat/completions)", async () => {
    const backend = await tooLongBackend(GROQ_MSG);
    const p = portOf(await startProxy(singleCfg(`http://127.0.0.1:${portOf(backend)}`)));

    const r = await fetch(`http://127.0.0.1:${p}/v1/chat/completions`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ model: "p1/out-a", messages: [{ role: "user", content: "hi" }] }),
    });
    expect(r.status).toBe(400);

    await new Promise((res) => setTimeout(res, 50));
    expect(observedMaxOutput("p1", "out-a")).toBe(8192);
  });

  it("learns from the Anthropic front (/v1/messages) too — one policy, both paths", async () => {
    const backend = await tooLongBackend(GROQ_MSG);
    const p = portOf(await startProxy(singleCfg(`http://127.0.0.1:${portOf(backend)}`)));

    const r = await fetch(`http://127.0.0.1:${p}/v1/messages`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ model: "p1/out-b", max_tokens: 16, messages: [{ role: "user", content: "hi" }] }),
    });
    expect(r.status).toBe(400);

    await new Promise((res) => setTimeout(res, 50));
    expect(observedMaxOutput("p1", "out-b")).toBe(8192);
  });

  it("records an output ceiling and NO context ceiling from that body", async () => {
    // The groq message mentions `context_window` in prose; a context-limit fact from it would be
    // a number nobody stated. Entry-specific assertions on a model no other test touches.
    const backend = await tooLongBackend(GROQ_MSG);
    const p = portOf(await startProxy(singleCfg(`http://127.0.0.1:${portOf(backend)}`)));

    await fetch(`http://127.0.0.1:${p}/v1/chat/completions`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ model: "p1/out-c", messages: [{ role: "user", content: "hi" }] }),
    });
    await new Promise((res) => setTimeout(res, 50));
    expect(observedMaxOutput("p1", "out-c")).toBe(8192);
    expect(observedContextLimit("p1", "out-c")).toBeNull();
  });
});
