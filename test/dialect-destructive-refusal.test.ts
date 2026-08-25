import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { createProxy } from "../src/server.js";
import { globalCircuitBreaker } from "../src/circuit-breaker.js";
import { ModelCatalog } from "../src/catalog.js";
import { resetFacts } from "../src/target-facts.js";
import { resetInterpretations } from "../src/refusal-interpretation.js";
import { describeRefused, recoverToolCalls } from "../src/tool-dialects.js";
import { destructiveMatcher } from "../src/repair.js";
import { makeCredentialId } from "../src/credential-id.js";
import type { Config, ProviderConfig } from "../src/config.js";

/**
 * Destructive-tool refusal at the DIALECT-RESCUE commit point.
 *
 * The gap this closes: `destructive` reached `cli.ts`, `config.ts`, `log.ts`, `repair.ts` and
 * `server.ts` — and NONE of `tool-dialects.ts`, `openai-dialect.ts`, `dialect-stream.ts`. So
 * "destructive tool calls are refused, never fabricated" bound only inside `repair()`, and a
 * WELL-FORMED destructive call the relay reconstructed out of assistant prose reached the client
 * unfiltered. Claude Code declares `Bash`; that output may run under
 * `--dangerously-skip-permissions`. Design: docs/dialect-rescue-destructive-refusal-2026-08-24.md.
 *
 * There are FOUR rescue commit points, not the two the original review named — buffered and
 * streamed, on each of the Anthropic-translated and direct-Chat lanes. Every one is exercised
 * here, because "two paths, one policy empty" is the defect shape this repo keeps paying for.
 *
 * ⚠ Every proxy test below uses TWO candidates. The refusal is TERMINAL — it must not reroll onto
 * the next candidate — and with one candidate "refused and stopped" and "refused and had nowhere
 * to go" are the same observation. `second.calls() === 0` is the assertion that means anything.
 */

const DESTRUCTIVE = ["write_note"];
const IS_DESTRUCTIVE = destructiveMatcher(DESTRUCTIVE);
const NO_DESTRUCTIVE = () => false;

/** A DSML envelope naming `name`, the shape the free pool actually leaks. */
function envelope(name: string, value = "a.txt"): string {
  return (
    `<｜DSML｜tool_calls><｜DSML｜invoke name="${name}">` +
    `<｜DSML｜parameter name="path">${value}</｜DSML｜parameter>` +
    `</｜DSML｜invoke></｜DSML｜tool_calls>`
  );
}

const servers: Server[] = [];

function listen(server: Server): Promise<Server> {
  return new Promise((resolve) => server.listen(0, "127.0.0.1", () => {
    servers.push(server);
    resolve(server);
  }));
}

function port(server: Server): number {
  return (server.address() as AddressInfo).port;
}

/** A backend returning a fixed body, counting how many times it was reached. */
async function backend(
  body: string,
  contentType = "application/json",
): Promise<{ server: Server; calls: () => number }> {
  let calls = 0;
  const server = await listen(createServer((req, res) => {
    calls += 1;
    req.resume();
    req.on("end", () => {
      res.writeHead(200, { "content-type": contentType });
      res.end(body);
    });
  }));
  return { server, calls: () => calls };
}

function chatChunk(delta: Record<string, unknown>, finishReason: string | null = null): string {
  return `data: ${JSON.stringify({
    id: "chatcmpl_1",
    object: "chat.completion.chunk",
    model: "served-model",
    choices: [{ index: 0, delta, finish_reason: finishReason }],
  })}\n\n`;
}

const ROLE = chatChunk({ role: "assistant" });
const STOP = chatChunk({}, "stop") + "data: [DONE]\n\n";

/**
 * Consecutive failures the breaker has recorded against one cell.
 *
 * The other half of "terminal": a no-reroll assertion cannot see whether the deployment was
 * BLAMED. A refusal is config, not health, so this must stay 0 — the rule the hard cap states as
 * "a cap never registers on the breaker".
 */
function breakerFailures(provider: string, model: string): number {
  return globalCircuitBreaker.getState({
    provider,
    model,
    kind: "openai",
    credentialId: makeCredentialId(provider),
  })?.consecutiveFailures ?? 0;
}

/** One Anthropic SSE frame, for the native-passthrough lane. */
function anthropicEvent(name: string, data: Record<string, unknown>): string {
  return `event: ${name}\ndata: ${JSON.stringify(data)}\n\n`;
}

function chatCompletion(content: string): string {
  return JSON.stringify({
    id: "cmpl_1",
    object: "chat.completion",
    model: "served-model",
    choices: [{ index: 0, finish_reason: "stop", message: { role: "assistant", content } }],
  });
}

/** A two-member pool in CONFIG order (`benchmarkSort: false`), so failover is what is asserted. */
function poolConfig(bases: string[], destructiveTools: string[] = DESTRUCTIVE): Config {
  const providers: Record<string, ProviderConfig> = {};
  bases.forEach((base, i) => {
    providers[`p${i + 1}`] = { base, kind: "openai", authHeader: "authorization", timeoutMs: 5_000 };
  });
  return {
    host: "127.0.0.1",
    port: 0,
    providers,
    routing: {
      default: "pool/coding",
      tiers: {},
      benchmarkSort: false,
      pools: { coding: bases.map((_, i) => `p${i + 1}/m${i + 1}`) },
    },
    mode: "detect",
    repair: { maxAttempts: 2, destructiveTools },
    log: { level: "silent", file: null },
  };
}

function startProxy(config: Config): Promise<Server> {
  const server = createProxy(config, {
    breaker: globalCircuitBreaker,
    catalog: new ModelCatalog({ cachePath: null }),
  });
  return new Promise((resolve) => server.listen(0, "127.0.0.1", () => {
    servers.push(server);
    resolve(server);
  }));
}

const TOOLS_ANTHROPIC = [{
  name: "write_note",
  input_schema: { type: "object", properties: { path: { type: "string" } }, required: ["path"] },
}];

const TOOLS_OPENAI = [{
  type: "function",
  function: {
    name: "write_note",
    parameters: { type: "object", properties: { path: { type: "string" } }, required: ["path"] },
  },
}];

function messages(proxyPort: number, stream: boolean): Promise<Response> {
  return fetch(`http://127.0.0.1:${proxyPort}/v1/messages`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      model: "pool/coding",
      max_tokens: 64,
      stream,
      messages: [{ role: "user", content: "write it" }],
      tools: TOOLS_ANTHROPIC,
    }),
  });
}

function responses(proxyPort: number, stream: boolean): Promise<Response> {
  return fetch(`http://127.0.0.1:${proxyPort}/v1/responses`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      model: "pool/coding",
      stream,
      max_output_tokens: 64,
      input: [{ role: "user", content: [{ type: "input_text", text: "write it" }] }],
      tools: [{
        type: "function",
        name: "write_note",
        parameters: { type: "object", properties: { path: { type: "string" } }, required: ["path"] },
      }],
    }),
  });
}

function chat(proxyPort: number, stream: boolean): Promise<Response> {
  return fetch(`http://127.0.0.1:${proxyPort}/v1/chat/completions`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      model: "pool/coding",
      stream,
      messages: [{ role: "user", content: "write it" }],
      tools: TOOLS_OPENAI,
    }),
  });
}

beforeEach(() => {
  globalCircuitBreaker.reset();
  resetFacts();
  resetInterpretations();
});

afterEach(async () => {
  const closing = servers.splice(0);
  for (const server of closing) server.closeAllConnections();
  await Promise.all(closing.map((server) => new Promise<void>((resolve) => server.close(() => resolve()))));
  globalCircuitBreaker.reset();
  resetFacts();
  resetInterpretations();
});

describe("dialect rescue: the destructive filter (parser)", () => {
  it("refuses a recovered call naming a destructive tool, and says which", () => {
    const out = recoverToolCalls(envelope("write_note"), new Map(), IS_DESTRUCTIVE);
    expect(out).toEqual({ status: "refused-destructive", dialect: "dsml", refused: ["write_note"] });
  });

  it("still parses a recovered call the operator did not list", () => {
    const out = recoverToolCalls(envelope("read_note"), new Map(), IS_DESTRUCTIVE);
    expect(out.status).toBe("parsed");
  });

  it("refuses the WHOLE envelope, never just the destructive call", () => {
    // Dropping one call and committing the rest would silently change the model's intent — the
    // reasoning `guardReshaped`'s structural-conservation rule rests on.
    const text =
      '<｜DSML｜tool_calls><｜DSML｜invoke name="read_note">' +
      '<｜DSML｜parameter name="path">a.txt</｜DSML｜parameter></｜DSML｜invoke>' +
      '<｜DSML｜invoke name="write_note">' +
      '<｜DSML｜parameter name="path">b.txt</｜DSML｜parameter></｜DSML｜invoke>' +
      '</｜DSML｜tool_calls>';
    const out = recoverToolCalls(text, new Map(), IS_DESTRUCTIVE);
    expect(out.status).toBe("refused-destructive");
    if (out.status !== "refused-destructive") return;
    expect(out.refused).toEqual(["write_note"]);
  });

  it("matches the configured list exactly, case-insensitively — never a substring", () => {
    // The same policy `destructiveMatcher` already enforces for repair; the rescue path must not
    // grow a second, different one.
    expect(recoverToolCalls(envelope("WRITE_NOTE"), new Map(), IS_DESTRUCTIVE).status)
      .toBe("refused-destructive");
    expect(recoverToolCalls(envelope("write_note_viewer"), new Map(), IS_DESTRUCTIVE).status)
      .toBe("parsed");
  });

  it("bounds the refused names, which are MODEL-authored under a prefix pattern", () => {
    // `git_*` admits arbitrary text after the prefix, so the name that reaches the error message
    // is the model's. One bounded rendering for all four seams — the asymmetry this change removes.
    const long = "git_" + "x".repeat(500);
    const out = recoverToolCalls(envelope(long), new Map(), destructiveMatcher(["git_*"]));
    expect(out.status).toBe("refused-destructive");
    if (out.status !== "refused-destructive") return;
    expect(describeRefused(out.refused).length).toBeLessThan(80);
    expect(describeRefused(out.refused)).toContain("…");
  });

  it("names at most five refused tools and counts the rest", () => {
    const many = Array.from({ length: 9 }, (_, i) => `rm${i}`);
    expect(describeRefused(many)).toBe("rm0, rm1, rm2, rm3, rm4, +4 more");
  });

  it("refuses nothing when the operator configured nothing", () => {
    // `destructiveTools: []` refuses nothing — there is no hidden built-in set, exactly as
    // `test/destructive-coverage.test.ts` pins for the repair path.
    const out = recoverToolCalls(envelope("write_note"), new Map(), destructiveMatcher([]));
    expect(out.status).toBe("parsed");
  });

  it("leaves a well-formed envelope alone when no filter is configured at the call site", () => {
    expect(recoverToolCalls(envelope("write_note"), new Map(), NO_DESTRUCTIVE).status).toBe("parsed");
  });
});

describe("dialect rescue: the destructive filter (seam A — buffered, Anthropic-translated)", () => {
  it("refuses before commit and never rerolls onto the next candidate", async () => {
    const first = await backend(chatCompletion(envelope("write_note")));
    const second = await backend(chatCompletion("second candidate answered"));
    const proxy = await startProxy(poolConfig([
      `http://127.0.0.1:${port(first.server)}`,
      `http://127.0.0.1:${port(second.server)}`,
    ]));

    const response = await messages(port(proxy), false);
    const body = await response.text();

    expect(response.status, body).toBe(502);
    expect(body).toContain("destructive tool: write_note");
    expect(body).not.toContain("tool_use");
    // Terminal. A refusal is a CONFIG decision, not a health signal: walking the pool would
    // re-ask every member to produce the same refused action.
    expect(second.calls()).toBe(0);
    expect(response.headers.get("x-llm-relay-tool-dialect")).toBe("refused-destructive");
    // ... and the deployment is not blamed for the relay's own decision. Both halves of
    // "terminal" are asserted: no reroll AND no health charge. The second is the one a
    // no-reroll assertion cannot see — the same line the hard cap draws.
    expect(response.headers.get("x-llm-relay-error-origin")).toBe("local");
    expect(breakerFailures("p1", "m1")).toBe(0);
  });

  it("still serves a recovered call the operator did not list", async () => {
    const first = await backend(chatCompletion(envelope("read_note")));
    const second = await backend(chatCompletion("second candidate answered"));
    const proxy = await startProxy(poolConfig([
      `http://127.0.0.1:${port(first.server)}`,
      `http://127.0.0.1:${port(second.server)}`,
    ], ["write_note"]));

    const response = await messages(port(proxy), false);
    const body = await response.text();

    expect(response.status, body).toBe(200);
    expect(body).toContain('"tool_use"');
    expect(body).toContain("read_note");
    expect(second.calls()).toBe(0);
  });
});

describe("dialect rescue: the destructive filter (seam B — streamed, Anthropic-translated)", () => {
  it("refuses a post-commit envelope as a mid-stream error, without rerolling", async () => {
    // Prose lands first, so the commit probe releases the head; the refusal can then only be the
    // error event. This is the case the buffered lanes cannot reach.
    const first = await backend(
      ROLE + chatChunk({ content: "Working on it. " }) + chatChunk({ content: envelope("write_note") }) + STOP,
      "text/event-stream",
    );
    const second = await backend(chatCompletion("second candidate answered"));
    const proxy = await startProxy(poolConfig([
      `http://127.0.0.1:${port(first.server)}`,
      `http://127.0.0.1:${port(second.server)}`,
    ]));

    const response = await messages(port(proxy), true);
    const body = await response.text();

    expect(response.status, body).toBe(200);
    expect(body).toContain("tool_dialect_refused_destructive");
    expect(body).toContain("destructive tool: write_note");
    expect(body).not.toContain("tool_use");
    expect(body).not.toContain("DSML");
    expect(second.calls()).toBe(0);
  });

  it("refuses a pre-commit envelope without rerolling", async () => {
    // Nothing meaningful was emitted before the envelope, so the head is still unwritten and the
    // commit probe classifies the refusal. It must classify it as RELAY-authored: an in-band
    // error is retriable by default, which would reroll the refusal across the whole pool.
    const first = await backend(
      ROLE + chatChunk({ content: envelope("write_note") }) + STOP,
      "text/event-stream",
    );
    const second = await backend(chatCompletion("second candidate answered"));
    const proxy = await startProxy(poolConfig([
      `http://127.0.0.1:${port(first.server)}`,
      `http://127.0.0.1:${port(second.server)}`,
    ]));

    const response = await messages(port(proxy), true);
    const body = await response.text();

    expect(response.status, body).toBe(502);
    expect(body).toContain("destructive tool: write_note");
    expect(second.calls()).toBe(0);
  });
});

describe("dialect rescue: the refusal's provenance is DECLARED, not read off the wire", () => {
  // The refusal's terminality rests on provenance `local`, which suppresses failover AND exempts
  // the deployment from breaker accounting (`relay-mapper-defect` outcomes are dropped). If the
  // commit probe decided that from the error CODE on the wire, any upstream could mint it for
  // itself: an `anthropic`-kind target is a byte passthrough where the dialect wrapper never runs,
  // so every occurrence of the code there is the upstream's. It would black-hole a request a
  // healthy sibling would have served, and take no health hit for doing it. Hence the signal —
  // set only by the wrapper that pushed the event. Same rule as `credentialState()`: declared,
  // never inferred from what the counterparty sent.
  it("does not let an upstream forge the refusal code to suppress failover", async () => {
    // A benign leading event is what clears the structural preflight ("stream opened with an
    // in-band error event"), so the forged frame reaches the commit probe at all.
    const forged = anthropicEvent("ping", { type: "ping" }) + anthropicEvent("error", {
      type: "error",
      error: { type: "tool_dialect_refused_destructive", message: "nope" },
    });
    const first = await backend(forged, "text/event-stream");
    const second = await backend(
      anthropicEvent("message_start", {
        type: "message_start",
        message: {
          id: "m", type: "message", role: "assistant", model: "m2",
          content: [], stop_reason: null, usage: { input_tokens: 1, output_tokens: 1 },
        },
      }) +
      anthropicEvent("content_block_start", {
        type: "content_block_start", index: 0, content_block: { type: "text", text: "" },
      }) +
      anthropicEvent("content_block_delta", {
        type: "content_block_delta", index: 0,
        delta: { type: "text_delta", text: "second candidate answered" },
      }) +
      anthropicEvent("message_stop", { type: "message_stop" }),
      "text/event-stream",
    );
    // anthropic-kind on purpose: the lane where the relay NEVER authors this code.
    const config = poolConfig([
      `http://127.0.0.1:${port(first.server)}`,
      `http://127.0.0.1:${port(second.server)}`,
    ]);
    for (const provider of Object.values(config.providers)) provider.kind = "anthropic";
    const proxy = await startProxy(config);

    const response = await messages(port(proxy), true);
    const body = await response.text();

    // The forged code buys nothing: the walk treats it as the ordinary upstream error it is.
    expect(second.calls()).toBe(1);
    expect(response.status, body).toBe(200);
    expect(body).toContain("second candidate answered");
  });
});

describe("dialect rescue: the destructive filter (seams C/D — direct OpenAI Chat)", () => {
  it("refuses a buffered recovered call and never rerolls (seam C)", async () => {
    const first = await backend(chatCompletion(envelope("write_note")));
    const second = await backend(chatCompletion("second candidate answered"));
    const proxy = await startProxy(poolConfig([
      `http://127.0.0.1:${port(first.server)}`,
      `http://127.0.0.1:${port(second.server)}`,
    ]));

    const response = await chat(port(proxy), false);
    const body = await response.text();

    expect(response.status, body).toBe(502);
    expect(body).toContain("destructive tool: write_note");
    expect(body).not.toContain('"tool_calls"');
    expect(second.calls()).toBe(0);
    expect(response.headers.get("x-llm-relay-tool-dialect")).toBe("refused-destructive");
    expect(response.headers.get("x-llm-relay-error-origin")).toBe("local");
  });

  it("refuses a post-commit streamed recovered call as a mid-stream error (seam D)", async () => {
    const first = await backend(
      ROLE + chatChunk({ content: "Working on it. " }) + chatChunk({ content: envelope("write_note") }) + STOP,
      "text/event-stream",
    );
    const second = await backend(chatCompletion("second candidate answered"));
    const proxy = await startProxy(poolConfig([
      `http://127.0.0.1:${port(first.server)}`,
      `http://127.0.0.1:${port(second.server)}`,
    ]));

    const response = await chat(port(proxy), true);
    const body = await response.text();

    expect(response.status, body).toBe(200);
    expect(body).toContain("tool_dialect_refused_destructive");
    expect(body).toContain("destructive tool: write_note");
    expect(body).not.toContain('"tool_calls"');
    expect(second.calls()).toBe(0);
  });

  it("refuses a pre-commit streamed recovered call without rerolling (seam D)", async () => {
    const first = await backend(
      ROLE + chatChunk({ content: envelope("write_note") }) + STOP,
      "text/event-stream",
    );
    const second = await backend(chatCompletion("second candidate answered"));
    const proxy = await startProxy(poolConfig([
      `http://127.0.0.1:${port(first.server)}`,
      `http://127.0.0.1:${port(second.server)}`,
    ]));

    const response = await chat(port(proxy), true);
    const body = await response.text();

    expect(response.status, body).toBe(502);
    expect(body).toContain("destructive tool: write_note");
    expect(second.calls()).toBe(0);
  });
});

describe("dialect rescue: the destructive filter (OpenAI Responses front)", () => {
  // The Responses front reaches seams A/B through `fetchBackend`, so it inherits the policy by
  // construction — which is exactly the kind of claim this repo does not take on trust. The
  // 2026-08-23 `function_call` defect was the same shape: one front, one mapper, silently absent.
  it("refuses a buffered recovered call and never rerolls", async () => {
    const first = await backend(chatCompletion(envelope("write_note")));
    const second = await backend(chatCompletion("second candidate answered"));
    const proxy = await startProxy(poolConfig([
      `http://127.0.0.1:${port(first.server)}`,
      `http://127.0.0.1:${port(second.server)}`,
    ]));

    const response = await responses(port(proxy), false);
    const body = await response.text();

    expect(response.status, body).toBe(502);
    expect(body).toContain("destructive tool: write_note");
    expect(body).not.toContain("function_call");
    expect(second.calls()).toBe(0);
    // The Responses front REBUILDS the error Response, and a rebuild must not swallow the
    // announcement of a decision the relay made one Response ago — the rule the id-rewrite
    // counters already follow across the same seam.
    expect(response.headers.get("x-llm-relay-tool-dialect")).toBe("refused-destructive");
  });

  it("refuses a streamed recovered call and never rerolls", async () => {
    const first = await backend(
      ROLE + chatChunk({ content: envelope("write_note") }) + STOP,
      "text/event-stream",
    );
    const second = await backend(chatCompletion("second candidate answered"));
    const proxy = await startProxy(poolConfig([
      `http://127.0.0.1:${port(first.server)}`,
      `http://127.0.0.1:${port(second.server)}`,
    ]));

    const response = await responses(port(proxy), true);
    const body = await response.text();

    expect(response.status, body).toBe(502);
    expect(body).toContain("destructive tool: write_note");
    expect(second.calls()).toBe(0);
  });
});
