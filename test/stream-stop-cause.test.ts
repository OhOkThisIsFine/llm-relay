import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { probeStreamForCommit, stopCauseToken, type StreamCommitProtocol } from "../src/stream-commit.js";
import { createProxy } from "../src/server.js";
import { CircuitBreaker } from "../src/circuit-breaker.js";
import { ModelCatalog } from "../src/catalog.js";
import { resetFacts } from "../src/target-facts.js";
import { resetInterpretations } from "../src/refusal-interpretation.js";
import type { Config, ProviderConfig } from "../src/config.js";

/**
 * A pre-commit empty stream names its cause, when the backend stated one.
 *
 * The measured failure (backlog, 2026-09-10): a streamed `deepseek/deepseek-flash` request that
 * spent its whole `max_tokens` budget on reasoning and emitted no visible text answered the client
 * a flat `502 stream completed without meaningful content`. The relay held every byte it needed to
 * explain itself and recorded none of it — with `log.file` null by default and `/telemetry`
 * carrying no per-request rows, the cause was recoverable only by re-sending the request outside
 * the relay.
 *
 * These tests pin the three outcomes the property distinguishes: the backend SAID why (name it),
 * the backend said NOTHING (keep the generic message, invent nothing), and either way the reason
 * reaches the served body and the log without either carrying provider content.
 */

const encoder = new TextEncoder();

function bytes(value: string): Uint8Array {
  return encoder.encode(value);
}

function streamOf(chunks: readonly Uint8Array[]): ReadableStream<Uint8Array> {
  return new ReadableStream<Uint8Array>({
    start(controller) {
      for (const chunk of chunks) controller.enqueue(chunk);
      controller.close();
    },
  });
}

function event(value: unknown, name?: string): string {
  return `${name ? `event: ${name}\n` : ""}data: ${JSON.stringify(value)}\n\n`;
}

/** The Chat usage-only frame DeepSeek-family backends send AFTER the `finish_reason` frame. */
function chatUsageFrame(reasoningTokens: number, completionTokens: number): string {
  return event({
    choices: [],
    usage: {
      prompt_tokens: 12,
      completion_tokens: completionTokens,
      completion_tokens_details: { reasoning_tokens: reasoningTokens },
    },
  });
}

describe("probe: a stated stop reason names the cause", () => {
  /**
   * The exact reported shape, on the Chat wire: the whole budget went to reasoning, the terminal
   * frame states `length`, and a SEPARATE usage frame — arriving after it — carries the count.
   *
   * ⚠ The ordering is the load-bearing part and it is why this test is written this way. The probe
   * stops at the first non-hold verdict, so a classifier that stopped reading there would report
   * the stop reason with no token count beside it — and would have passed a test that put the usage
   * frame first.
   *
   * ⚠ The reasoning deltas are EMPTY here (`reasoning_content: null`), which is what the recorded
   * capture actually ends with — see `docs/deepseek-responses-truncation-2026-09-09.md`. A
   * non-empty `reasoning_content` delta legitimately COMMITS a stream under this module's existing
   * rules, and that behaviour is deliberately unchanged, so a fixture with reasoning prose would
   * be testing the ready path rather than this one.
   */
  it("names max_tokens and the reasoning-token count when the backend states both", async () => {
    const raw =
      event({ choices: [{ index: 0, delta: { role: "assistant" }, finish_reason: null }] }) +
      event({ choices: [{ index: 0, delta: { content: "", reasoning_content: null }, finish_reason: null }] }) +
      event({ choices: [{ index: 0, delta: {}, finish_reason: "length" }] }) +
      chatUsageFrame(900, 900) +
      "data: [DONE]\n\n";

    const result = await probeStreamForCommit(streamOf([bytes(raw)]), "openai-chat");
    expect(result).toMatchObject({
      kind: "dead",
      provenance: "upstream",
      classification: { stopReason: "max_tokens", reasoningTokens: 900 },
    });
    if (result.kind !== "dead") throw new Error("expected dead");
    // The message is the property's own example, near enough to read as the same sentence.
    expect(result.reason).toContain("the backend stopped at max_tokens");
    expect(result.reason).toContain("900 reasoning tokens");
    expect(result.reason).toContain("no text");
  });

  it("names max_tokens with no token count when the backend stated only the stop reason", async () => {
    const raw =
      event({ choices: [{ index: 0, delta: { role: "assistant" }, finish_reason: null }] }) +
      event({ choices: [{ index: 0, delta: {}, finish_reason: "length" }] }) +
      "data: [DONE]\n\n";

    const result = await probeStreamForCommit(streamOf([bytes(raw)]), "openai-chat");
    expect(result).toMatchObject({ kind: "dead", classification: { stopReason: "max_tokens", reasoningTokens: null } });
    if (result.kind !== "dead") throw new Error("expected dead");
    expect(result.reason).toContain("the backend stopped at max_tokens and no text");
    // A count nobody stated is not rendered as zero — `null` never becomes `0`.
    expect(result.reason).not.toContain("0 reasoning tokens");
  });

  it("names the Anthropic stop reason stated on message_delta", async () => {
    const raw =
      event({ type: "message_start", message: { id: "m", usage: { input_tokens: 3, output_tokens: 0 } } }, "message_start") +
      event({ type: "content_block_start", index: 0, content_block: { type: "thinking", thinking: "" } }, "content_block_start") +
      event({ type: "content_block_delta", index: 0, delta: { type: "signature_delta", signature: "sig" } }, "content_block_delta") +
      event({ type: "message_delta", delta: { stop_reason: "max_tokens" }, usage: { output_tokens: 512 } }, "message_delta") +
      event({ type: "message_stop" }, "message_stop");

    const result = await probeStreamForCommit(streamOf([bytes(raw)]), "anthropic-messages");
    expect(result).toMatchObject({ kind: "dead", classification: { stopReason: "max_tokens" } });
    if (result.kind !== "dead") throw new Error("expected dead");
    expect(result.reason).toContain("the backend stopped at max_tokens and no text");
    // Anthropic states no reasoning-token field, so no count is claimed for it. The honest answer
    // is the stop cause alone — never a nearby number relabelled as a measurement.
    expect(result.reason).not.toMatch(/\d+ reasoning tokens/);
  });

  /**
   * The second modelled cause, and it is not hypothetical: a backend that stops to call a tool
   * whose call the relay could not commit is a real empty pre-commit stream, and `tool_use` is the
   * only other member the vocabulary admits.
   *
   * ⚠ Both spellings are asserted because both occur — Chat says `tool_calls` (and some
   * OpenAI-compatible backends say `function_call`) where Anthropic says `tool_use`.
   */
  it.each(["tool_calls", "function_call"])(
    "names a Chat finish_reason of %s as a tool-call stop",
    async (finishReason) => {
      const raw =
        event({ choices: [{ index: 0, delta: { role: "assistant" }, finish_reason: null }] }) +
        event({ choices: [{ index: 0, delta: {}, finish_reason: finishReason }] }) +
        "data: [DONE]\n\n";

      const result = await probeStreamForCommit(streamOf([bytes(raw)]), "openai-chat");
      expect(result).toMatchObject({ kind: "dead", classification: { stopReason: "tool_use" } });
      if (result.kind !== "dead") throw new Error("expected dead");
      expect(result.reason).toContain("the backend stopped at a tool call");
      expect(stopCauseToken(result.classification!)).toBe("backend_stopped_at_tool_use");
    },
  );

  it("names a Responses incomplete-details reason", async () => {
    const raw = event({
      type: "response.completed",
      response: {
        status: "incomplete",
        incomplete_details: { reason: "max_output_tokens" },
        usage: { output_tokens: 700, output_tokens_details: { reasoning_tokens: 700 } },
        output: [],
      },
    }, "response.completed");

    const result = await probeStreamForCommit(streamOf([bytes(raw)]), "openai-responses");
    if (result.kind !== "dead") throw new Error(`expected dead, got ${result.kind}`);
    expect(result.reason).toContain("700 reasoning tokens");
  });
});

describe("probe: an unstated cause keeps the generic message", () => {
  /**
   * The negative control, and the one that matters most: a stream that fails for a reason the
   * backend never stated must read EXACTLY as it did before this change. A classifier that always
   * produced a cause would satisfy every positive test above.
   */
  it.each<StreamCommitProtocol>(["anthropic-messages", "openai-chat", "openai-responses"])(
    "does not fabricate a cause for %s",
    async (protocol) => {
      const raw = protocol === "openai-responses"
        ? event({ type: "response.completed", response: { status: "completed", output: [] } }, "response.completed")
        : protocol === "openai-chat"
          ? event({ choices: [{ index: 0, delta: { role: "assistant" }, finish_reason: null }] }) + "data: [DONE]\n\n"
          : event({ type: "message_stop" }, "message_stop");

      const result = await probeStreamForCommit(streamOf([bytes(raw)]), protocol);
      expect(result.kind).toBe("dead");
      if (result.kind !== "dead") throw new Error("expected dead");
      // No classification at all — the field is ABSENT, not `null`-valued, so a front that ignores
      // it and a log that allow-lists it both behave exactly as they did before.
      expect(result.classification).toBeUndefined();
      expect(result.reason).toBe("stream completed without meaningful content");
    },
  );

  it("leaves local defects, probe-limit overruns and unknown spellings unclassified", async () => {
    const notJson = await probeStreamForCommit(streamOf([bytes("data: {nope}\n\n")]), "openai-chat", {
      malformedProvenance: "local",
    });
    expect(notJson).toMatchObject({ kind: "dead", provenance: "local" });
    expect(notJson.kind === "dead" && notJson.classification).toBeUndefined();

    // A stop reason outside the closed vocabulary is DROPPED, never pressed into a nearby member.
    // `content_filter` is a real OpenAI finish_reason this relay does not model; the honest
    // outcome is the generic message, not a claim that the backend hit max_tokens.
    const unmodelled =
      event({ choices: [{ index: 0, delta: { role: "assistant" }, finish_reason: null }] }) +
      event({ choices: [{ index: 0, delta: {}, finish_reason: "content_filter" }] }) +
      "data: [DONE]\n\n";
    const result = await probeStreamForCommit(streamOf([bytes(unmodelled)]), "openai-chat");
    expect(result).toMatchObject({ kind: "dead", reason: "stream completed without meaningful content" });
    expect(result.kind === "dead" && result.classification).toBeUndefined();
  });

  it("still commits a stream that WAS meaningful, whatever its stop reason", async () => {
    const raw =
      event({ choices: [{ index: 0, delta: { role: "assistant" }, finish_reason: null }] }) +
      event({ choices: [{ index: 0, delta: { content: "the answer" }, finish_reason: null }] }) +
      event({ choices: [{ index: 0, delta: {}, finish_reason: "length" }] });

    const result = await probeStreamForCommit(streamOf([bytes(raw)]), "openai-chat");
    expect(result.kind).toBe("ready");
    expect(result).not.toHaveProperty("reason");
  });
});

describe("stopCauseToken", () => {
  it("names each stated cause, and unknown for none", () => {
    expect(stopCauseToken({ stopReason: "max_tokens", reasoningTokens: 900 })).toBe("backend_stopped_at_max_tokens");
    expect(stopCauseToken({ stopReason: "tool_use", reasoningTokens: null })).toBe("backend_stopped_at_tool_use");
    expect(stopCauseToken({ stopReason: null, reasoningTokens: 12 })).toBe("stop_reason_unknown");
    expect(stopCauseToken(undefined)).toBe("stop_reason_unknown");
  });
});

/* --------------------------------------------------------------------------------------------- */
/* End to end: the reason reaches the served error body AND the metadata log, leaking nothing.    */
/* --------------------------------------------------------------------------------------------- */

const servers: Server[] = [];
const tempDirs: string[] = [];

function track(server: Server): Server {
  servers.push(server);
  return server;
}

function listen(server: Server): Promise<Server> {
  return new Promise((resolve) => server.listen(0, "127.0.0.1", () => resolve(track(server))));
}

function port(server: Server): number {
  return (server.address() as AddressInfo).port;
}

beforeEach(() => {
  resetFacts();
  resetInterpretations();
});

afterEach(async () => {
  const closing = servers.splice(0);
  for (const server of closing) server.closeAllConnections();
  await Promise.all(closing.map((server) => new Promise<void>((resolve) => server.close(() => resolve()))));
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
  resetFacts();
  resetInterpretations();
});

function makeLogFile(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  tempDirs.push(dir);
  return join(dir, "relay.jsonl");
}

function logRecords(path: string): Array<Record<string, unknown>> {
  if (!existsSync(path)) return [];
  return readFileSync(path, "utf8").split("\n").filter(Boolean).map((line) => JSON.parse(line) as Record<string, unknown>);
}

/** A backend answering 200 with a streamed body that never contains meaningful content. */
function fixedBackend(body: string, extraHeaders: Record<string, string> = {}): Promise<Server> {
  return listen(createServer((request, response) => {
    response.on("error", () => {});
    request.on("data", () => {});
    request.on("end", () => {
      response.writeHead(200, { "content-type": "text/event-stream", "x-vendor-note": "a-header-value", ...extraHeaders });
      response.end(body);
    });
  }));
}

function config(base: string, logFile: string, kind: "anthropic" | "openai"): Config {
  const providers: Record<string, ProviderConfig> = {
    p1: {
      base,
      kind,
      authHeader: kind === "anthropic" ? "x-api-key" : "authorization",
      timeoutMs: 2_000,
      ...(kind === "anthropic" ? { credentialMode: "contained" as const } : {}),
    },
  };
  return {
    host: "127.0.0.1",
    port: 0,
    providers,
    routing: { default: "p1/m1", tiers: {}, benchmarkSort: false },
    mode: "detect",
    repair: { maxAttempts: 2, destructiveTools: [] },
    log: { level: "metadata", file: logFile },
  };
}

async function startProxy(cfg: Config): Promise<number> {
  const server = await listen(createProxy(cfg, { breaker: new CircuitBreaker(), catalog: new ModelCatalog({ cachePath: null }) }));
  return port(server);
}

describe("a dead stream reports its cause on the wire and in the log", () => {
  /**
   * The reported path, end to end: an Anthropic-front client, an openai-kind backend that burns
   * its whole budget on reasoning and sends no text.
   *
   * ⚠ What reaches the classifier here is the TRANSLATED Anthropic wire, and this test pins the
   * consequence rather than working around it. `backend.ts` drops reasoning deltas by rule when it
   * translates, and `extractAnthropicUsageFromResponses` carries only input/output/cache tokens —
   * so the reasoning COUNT does not survive translation and this path reports the stop reason
   * without one. That is the honest report of what the relay can still see, and asserting it keeps
   * a later reader from "fixing" the missing count by threading a number across a translation
   * boundary that deliberately does not carry it.
   */
  it("serves the stated max_tokens reason on the translated Anthropic front", async () => {
    const logFile = makeLogFile("rp-stop-cause-");
    const body =
      event({ choices: [{ index: 0, delta: { role: "assistant" }, finish_reason: null }] }) +
      event({ choices: [{ index: 0, delta: { content: "", reasoning_content: null }, finish_reason: null }] }) +
      event({ choices: [{ index: 0, delta: {}, finish_reason: "length" }] }) +
      chatUsageFrame(900, 900) +
      "data: [DONE]\n\n";
    const upstream = await fixedBackend(body);
    const proxyPort = await startProxy(config(`http://127.0.0.1:${port(upstream)}`, logFile, "openai"));

    const response = await fetch(`http://127.0.0.1:${proxyPort}/v1/messages`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        model: "p1/m1",
        stream: true,
        max_tokens: 64,
        messages: [{ role: "user", content: "hi" }],
      }),
    });

    expect(response.status).toBe(502);
    const served = await response.text();
    // The property's requirement, on the served body: the cause is NAMED, not merely implied.
    expect(served).toContain("the backend stopped at max_tokens and no text");

    const records = logRecords(logFile);
    expect(records).toHaveLength(1);
    const record = records[0]!;
    expect(record["streamStopCause"]).toBe("backend_stopped_at_max_tokens");
    expect(record["backendStatus"]).toBe(502);
    expect(record["streamed"]).toBe(true);

    /**
     * The metadata-only guarantee, asserted against real bytes rather than trusted.
     *
     * The backend sent a vendor header and a usage tally; the log may carry the CLASSIFICATION of
     * what happened and none of the content. These are the sharpest probes available here — a
     * "helpful" implementation that quoted the tally, or that copied the error message, would be
     * the exact leak this rule forbids.
     */
    const line = JSON.stringify(record);
    expect(line).not.toContain("a-header-value");
    expect(line).not.toContain("reasoning_content");
    expect(line).not.toContain("completion_tokens_details");
    // The classification travels as its own enum-like field, never as free text.
    expect(Object.keys(record)).not.toContain("reason");
    expect(line).not.toContain("llm-relay:");
  });

  it("keeps the generic message and an absent classification when the backend stated no cause", async () => {
    const logFile = makeLogFile("rp-stop-unknown-");
    const body =
      event({ choices: [{ index: 0, delta: { role: "assistant" }, finish_reason: null }] }) +
      "data: [DONE]\n\n";
    const upstream = await fixedBackend(body);
    const proxyPort = await startProxy(config(`http://127.0.0.1:${port(upstream)}`, logFile, "openai"));

    const response = await fetch(`http://127.0.0.1:${proxyPort}/v1/messages`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        model: "p1/m1",
        stream: true,
        max_tokens: 64,
        messages: [{ role: "user", content: "hi" }],
      }),
    });

    expect(response.status).toBe(502);
    expect(await response.text()).toContain("stream completed without meaningful content");

    const records = logRecords(logFile);
    expect(records).toHaveLength(1);
    // Absent, never a placeholder token: an unknown cause is not a classification.
    expect(records[0]).not.toHaveProperty("streamStopCause");
  });

  /**
   * The direct Chat lane — a byte passthrough, so the probe sees the backend's OWN bytes and the
   * evidence survives intact. This is the one end-to-end path where both the stop reason AND the
   * reasoning count reach the log, and it is what the Chat-wire unit test above is the fast
   * version of.
   */
  it("carries the stop reason and the reasoning count on the direct Chat lane", async () => {
    const logFile = makeLogFile("rp-stop-cause-chat-");
    const body =
      event({ choices: [{ index: 0, delta: { role: "assistant" }, finish_reason: null }] }) +
      event({ choices: [{ index: 0, delta: { content: "", reasoning_content: null }, finish_reason: null }] }) +
      event({ choices: [{ index: 0, delta: {}, finish_reason: "length" }] }) +
      chatUsageFrame(25, 25) +
      "data: [DONE]\n\n";
    const upstream = await fixedBackend(body);
    const proxyPort = await startProxy(config(`http://127.0.0.1:${port(upstream)}`, logFile, "openai"));

    const response = await fetch(`http://127.0.0.1:${proxyPort}/v1/chat/completions`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ model: "p1/m1", stream: true, max_tokens: 64, messages: [{ role: "user", content: "hi" }] }),
    });

    expect(response.status).toBe(502);
    expect(await response.text()).toContain("the backend stopped at max_tokens");
    expect(logRecords(logFile)[0]?.["streamStopCause"]).toBe("backend_stopped_at_max_tokens");
  });

  /**
   * The other front, the same classifier: a provider whose FIRST rung dies this way and whose
   * second answers must fail over — the cause is diagnostic, never a routing change.
   */
  it("fails over past a dead stream whose cause it names, and logs the cause once", async () => {
    const logFile = makeLogFile("rp-stop-cause-failover-");
    const dead =
      event({ choices: [{ index: 0, delta: { role: "assistant" }, finish_reason: null }] }) +
      event({ choices: [{ index: 0, delta: {}, finish_reason: "length" }] }) +
      "data: [DONE]\n\n";
    const good =
      event({ choices: [{ index: 0, delta: { role: "assistant" }, finish_reason: null }] }) +
      event({ choices: [{ index: 0, delta: { content: "served-b" }, finish_reason: null }] }) +
      event({ choices: [{ index: 0, delta: {}, finish_reason: "stop" }] }) +
      "data: [DONE]\n\n";
    const first = await fixedBackend(dead);
    const second = await fixedBackend(good);
    const cfg = config(`http://127.0.0.1:${port(first)}`, logFile, "openai");
    cfg.providers["p2"] = { ...cfg.providers["p1"]!, base: `http://127.0.0.1:${port(second)}` };
    cfg.routing = { default: "pool/two", tiers: {}, benchmarkSort: false, pools: { two: ["p1/m1", "p2/m2"] } };
    const proxyPort = await startProxy(cfg);

    const response = await fetch(`http://127.0.0.1:${proxyPort}/v1/chat/completions`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ model: "pool/two", stream: true, max_tokens: 64, messages: [{ role: "user", content: "hi" }] }),
    });

    // The walk reached the deployment that answered, unchanged by this feature.
    expect(response.status).toBe(200);
    expect(await response.text()).toContain("served-b");

    /**
     * One record, for the served request — and it carries NO stop cause.
     *
     * This is the negative control for the whole end-to-end wiring: the failing rung is recorded in
     * `attempts` like any other, but the dead-stream classification belongs to the REQUEST that
     * died, not to the request that succeeded past it. A front that merged it here would attach a
     * cause to a response that never had one.
     */
    const records = logRecords(logFile);
    expect(records).toHaveLength(1);
    expect(records[0]?.["backendStatus"]).toBe(200);
    expect(records[0]).not.toHaveProperty("streamStopCause");
    expect(records[0]?.["attempts"]).toHaveLength(2);
  });
});
