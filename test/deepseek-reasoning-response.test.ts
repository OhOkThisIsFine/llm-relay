import { describe, it, expect, afterEach, beforeEach } from "vitest";
import { createServer, type Server } from "node:http";
import { AddressInfo } from "node:net";
import { createProxy, type ProxyDeps } from "../src/server.js";
import { ModelCatalog } from "../src/catalog.js";
import { globalCircuitBreaker } from "../src/circuit-breaker.js";
import { resetFacts } from "../src/target-facts.js";
import { resetInterpretations } from "../src/refusal-interpretation.js";
import type { Config, ProviderConfig } from "../src/config.js";

/**
 * F11's missing other end — the RESPONSE direction of `compat.reasoning: "deepseek"`.
 *
 * `openai-request.ts` already carries a REPLAYED `thinking` block onto DeepSeek's outbound
 * `reasoning_content`, and turns thinking off for a replay that has none; that closed the HTTP 400
 * ("The `reasoning_content` in the thinking mode must be passed back to the API"). But llm-bridge's
 * response translation never reads the field on the way BACK: its `openaiToUniversal` (buffered)
 * and `parseOpenAIStream` (streamed) consult only `content`/`tool_calls`, and the string
 * `reasoning_content` does not appear anywhere in the published bundle. So a caller never held
 * DeepSeek's own reasoning, had nothing to replay next turn, and every multi-turn tool
 * conversation ran with thinking silently OFF after its first tool call.
 *
 * The property these pin, on BOTH fronts and in BOTH directions of the wire:
 *   - Anthropic front (`/v1/messages`): `reasoning_content` reaches the caller as a `thinking`
 *     content block.
 *   - Responses front (`/v1/responses`): it reaches the caller as a `reasoning` output item.
 *   - A non-`"deepseek"` openai-kind target's response is byte-for-byte what it was.
 *
 * ⚠ Every walk here uses TWO candidates, per this repo's standing rule: with one candidate,
 * "applies to the declared target" and "applies to everything" are the same observation. The
 * deepseek member is scripted to fail so one request yields both bodies.
 */

const servers: Server[] = [];
function track(s: Server): Server {
  servers.push(s);
  return s;
}

beforeEach(() => {
  globalCircuitBreaker.reset();
  resetFacts();
  resetInterpretations();
});
afterEach(async () => {
  await Promise.all(servers.splice(0).map((s) => new Promise((r) => s.close(() => r(undefined)))));
  globalCircuitBreaker.reset();
  resetFacts();
  resetInterpretations();
});

function port(s: Server): number {
  return (s.address() as AddressInfo).port;
}

/** A fake backend that scripts every reply and records the bodies it received. */
function recordingChat(
  reply: (n: number) => { status?: number; headers?: Record<string, string>; body: string },
): Promise<{ server: Server; bodies: () => Record<string, unknown>[] }> {
  const bodies: Record<string, unknown>[] = [];
  return new Promise((resolve) => {
    const s = createServer((req, res) => {
      const chunks: Buffer[] = [];
      req.on("data", (c) => chunks.push(c));
      req.on("end", () => {
        try { bodies.push(JSON.parse(Buffer.concat(chunks).toString())); } catch { bodies.push({}); }
        const out = reply(bodies.length);
        res.writeHead(out.status ?? 200, { "content-type": "application/json", ...out.headers });
        res.end(out.body);
      });
    });
    s.listen(0, "127.0.0.1", () => resolve({ server: track(s), bodies: () => bodies }));
  });
}

function startProxy(c: Config, deps: ProxyDeps = {}): Promise<Server> {
  const s = createProxy(c, { catalog: new ModelCatalog({ cachePath: null }), breaker: globalCircuitBreaker, ...deps });
  return new Promise((r) => s.listen(0, "127.0.0.1", () => r(track(s))));
}

/**
 * A 2-member pool: `p1` carries `compat.reasoning: "deepseek"` EXPLICITLY (no real
 * `api.deepseek.com` host needed — the same "explicit value wins" rule `resolveReasoningMode`
 * states), `p2` is a plain `openai`-kind provider with no `compat` at all. `benchmarkSort: false`
 * keeps config order so the walk is deterministic.
 */
function deepSeekPoolCfg(deepSeekBase: string, plainBase: string): Config {
  const providers: Record<string, ProviderConfig> = {
    p1: { base: deepSeekBase, kind: "openai", authHeader: "authorization", timeoutMs: 5000, compat: { reasoning: "deepseek" } },
    p2: { base: plainBase, kind: "openai", authHeader: "authorization", timeoutMs: 5000 },
  };
  return {
    host: "127.0.0.1",
    port: 0,
    providers,
    routing: { default: "pool/coding", tiers: {}, benchmarkSort: false, pools: { coding: ["p1/m1", "p2/m2"] } },
    mode: "detect",
    repair: { maxAttempts: 2, destructiveTools: [] },
    log: { level: "silent", file: null },
  };
}

const FAIL_429 = () => ({ status: 429, body: JSON.stringify({ error: { message: "busy" } }) });

/** A Chat completion carrying DeepSeek's reasoning beside its answer. */
const chatReasoningBody = (reasoning: string, content: string) => JSON.stringify({
  id: "cmpl_ds",
  object: "chat.completion",
  choices: [{ message: { role: "assistant", content, reasoning_content: reasoning }, finish_reason: "stop" }],
});

/** The streamed sibling: reasoning deltas first, then answer deltas, then `[DONE]`. */
const chatReasoningStream = (reasoning: string, content: string) => [
  `data: ${JSON.stringify({ id: "c", model: "m1", choices: [{ index: 0, delta: { role: "assistant", content: "", reasoning_content: reasoning }, finish_reason: null }] })}\n\n`,
  `data: ${JSON.stringify({ id: "c", model: "m1", choices: [{ index: 0, delta: { content }, finish_reason: null }] })}\n\n`,
  `data: ${JSON.stringify({ id: "c", model: "m1", choices: [{ index: 0, delta: {}, finish_reason: "stop" }] })}\n\n`,
  "data: [DONE]\n\n",
].join("");

const chatPlainBody = (content: string) => JSON.stringify({
  id: "cmpl_plain",
  object: "chat.completion",
  choices: [{ message: { role: "assistant", content }, finish_reason: "stop" }],
});

/** Parse a Responses SSE body into its events, in order. */
function parseSse(text: string): Array<{ type: string; data: Record<string, unknown> }> {
  return text
    .split(/\n\n+/)
    .map((b) => b.trim())
    .filter((b) => b.length > 0)
    .map((b) => {
      const dataLine = b.split("\n").find((l) => l.startsWith("data:"));
      return JSON.parse((dataLine ?? "data: {}").slice(5).trim()) as Record<string, unknown>;
    })
    .map((data) => ({ type: typeof data.type === "string" ? data.type : "", data }));
}

/** Types of the Anthropic content blocks a streamed answer opened, in order. */
function anthropicBlockTypes(sse: string): string[] {
  return parseSse(sse)
    .filter((e) => e.type === "content_block_start")
    .map((e) => {
      const block = e.data.content_block;
      return typeof block === "object" && block !== null && "type" in block ? String((block as { type: unknown }).type) : "";
    });
}

/** Concatenated text of a given delta type, e.g. every `thinking_delta`'s `thinking`. */
function sseDeltaText(sse: string, deltaType: string, field: string): string {
  return parseSse(sse)
    .filter((e) => e.type === "content_block_delta")
    .map((e) => (typeof e.data.delta === "object" && e.data.delta !== null ? (e.data.delta as Record<string, unknown>) : {}))
    .filter((d) => d.type === deltaType && typeof d[field] === "string")
    .map((d) => d[field] as string)
    .join("");
}

describe("DeepSeek reasoning_content reaches the caller — Anthropic front", () => {
  it("buffered: a reasoning_content answer becomes a leading thinking block, and the plain sibling is untouched", async () => {
    const deepseekMember = await recordingChat(FAIL_429);
    const plainMember = await recordingChat(() => ({ body: chatPlainBody("ok") }));
    const p = port(await startProxy(deepSeekPoolCfg(
      `http://127.0.0.1:${port(deepseekMember.server)}`,
      `http://127.0.0.1:${port(plainMember.server)}`,
    )));

    // Two requests: the first walks past a 429 to the plain member, the second to the deepseek one.
    const plainResp = await fetch(`http://127.0.0.1:${p}/v1/messages`, {
      method: "POST",
      headers: { "content-type": "application/json", "anthropic-version": "2023-06-01" },
      body: JSON.stringify({ model: "pool/coding", max_tokens: 20, messages: [{ role: "user", content: "hi" }] }),
    });
    expect(plainResp.status).toBe(200);
    const plainBody = (await plainResp.json()) as { content: Array<Record<string, unknown>> };
    // The plain member is reachable only after the deepseek one fails, so this asserts the
    // NEGATIVE control on the same walk the positive case below uses.
    expect(plainBody.content.map((b) => b.type)).toEqual(["text"]);

    // Now make the deepseek member answer instead.
    const dsWinner = await recordingChat(() => ({ body: chatReasoningBody("I should read the file first.", "done") }));
    const dsLoser = await recordingChat(FAIL_429);
    const p2 = port(await startProxy(deepSeekPoolCfg(
      `http://127.0.0.1:${port(dsWinner.server)}`,
      `http://127.0.0.1:${port(dsLoser.server)}`,
    )));
    const resp = await fetch(`http://127.0.0.1:${p2}/v1/messages`, {
      method: "POST",
      headers: { "content-type": "application/json", "anthropic-version": "2023-06-01" },
      body: JSON.stringify({ model: "pool/coding", max_tokens: 20, messages: [{ role: "user", content: "hi" }] }),
    });
    expect(resp.status).toBe(200);
    const body = (await resp.json()) as { content: Array<Record<string, unknown>> };
    // LEADING: the thinking block precedes the answer it explains.
    expect(body.content.map((b) => b.type)).toEqual(["thinking", "text"]);
    expect(body.content[0]).toEqual({ type: "thinking", thinking: "I should read the file first." });
    expect(body.content[1]).toEqual({ type: "text", text: "done" });
  });

  it("streamed: reasoning arrives as thinking_delta frames in their own block, ahead of the answer text", async () => {
    const dsWinner = await recordingChat(() => ({
      headers: { "content-type": "text/event-stream" },
      body: chatReasoningStream("thinking hard", "the answer"),
    }));
    const dsLoser = await recordingChat(FAIL_429);
    const p = port(await startProxy(deepSeekPoolCfg(
      `http://127.0.0.1:${port(dsWinner.server)}`,
      `http://127.0.0.1:${port(dsLoser.server)}`,
    )));

    const resp = await fetch(`http://127.0.0.1:${p}/v1/messages`, {
      method: "POST",
      headers: { "content-type": "application/json", "anthropic-version": "2023-06-01" },
      body: JSON.stringify({ model: "pool/coding", stream: true, max_tokens: 20, messages: [{ role: "user", content: "hi" }] }),
    });
    expect(resp.status).toBe(200);
    const sse = await resp.text();
    expect(anthropicBlockTypes(sse)).toEqual(["thinking", "text"]);
    expect(sseDeltaText(sse, "thinking_delta", "thinking")).toBe("thinking hard");
    expect(sseDeltaText(sse, "text_delta", "text")).toBe("the answer");
  });

  it("streamed: a non-deepseek sibling's Anthropic stream carries no thinking block at all", async () => {
    const dsLoser = await recordingChat(FAIL_429);
    const plainWinner = await recordingChat(() => ({
      headers: { "content-type": "text/event-stream" },
      body: chatReasoningStream("reasoning the plain target must drop", "the answer"),
    }));
    const p = port(await startProxy(deepSeekPoolCfg(
      `http://127.0.0.1:${port(dsLoser.server)}`,
      `http://127.0.0.1:${port(plainWinner.server)}`,
    )));

    const resp = await fetch(`http://127.0.0.1:${p}/v1/messages`, {
      method: "POST",
      headers: { "content-type": "application/json", "anthropic-version": "2023-06-01" },
      body: JSON.stringify({ model: "pool/coding", stream: true, max_tokens: 20, messages: [{ role: "user", content: "hi" }] }),
    });
    expect(resp.status).toBe(200);
    const sse = await resp.text();
    // Regression guard: every other provider's response bytes are unchanged.
    expect(anthropicBlockTypes(sse)).toEqual(["text"]);
    expect(sse).not.toContain("thinking_delta");
    expect(sseDeltaText(sse, "text_delta", "text")).toBe("the answer");
  });
});

describe("DeepSeek reasoning_content reaches the caller — OpenAI Responses front", () => {
  it("buffered: a reasoning_content answer becomes a leading reasoning item, and the plain sibling is untouched", async () => {
    const dsWinner = await recordingChat(() => ({ body: chatReasoningBody("checking the manifest", "done") }));
    const dsLoser = await recordingChat(FAIL_429);
    const p = port(await startProxy(deepSeekPoolCfg(
      `http://127.0.0.1:${port(dsWinner.server)}`,
      `http://127.0.0.1:${port(dsLoser.server)}`,
    )));

    const resp = await fetch(`http://127.0.0.1:${p}/v1/responses`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ model: "pool/coding", input: "hi" }),
    });
    expect(resp.status).toBe(200);
    const body = (await resp.json()) as { output: Array<Record<string, unknown>>; output_text: string };
    expect(body.output.map((i) => i.type)).toEqual(["reasoning", "message"]);
    expect(body.output[0]!.summary).toEqual([{ type: "summary_text", text: "checking the manifest" }]);
    // The reasoning item is NOT folded into the visible answer text.
    expect(body.output[1]!.content).toEqual([{ type: "output_text", text: "done", annotations: [] }]);
    expect(body.output_text).toBe("done");
  });

  it("buffered: a non-deepseek openai-kind target's Responses envelope carries no reasoning item (regression guard)", async () => {
    const dsLoser = await recordingChat(FAIL_429);
    const plainWinner = await recordingChat(() => ({ body: chatReasoningBody("must be dropped", "done") }));
    const p = port(await startProxy(deepSeekPoolCfg(
      `http://127.0.0.1:${port(dsLoser.server)}`,
      `http://127.0.0.1:${port(plainWinner.server)}`,
    )));

    const resp = await fetch(`http://127.0.0.1:${p}/v1/responses`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ model: "pool/coding", input: "hi" }),
    });
    expect(resp.status).toBe(200);
    const body = (await resp.json()) as { output: Array<Record<string, unknown>>; output_text: string };
    expect(body.output.map((i) => i.type)).toEqual(["message"]);
    expect(JSON.stringify(body)).not.toContain("must be dropped");
  });

  it("streamed: reasoning is announced as a reasoning item, never folded into the answer text", async () => {
    const dsWinner = await recordingChat(() => ({
      headers: { "content-type": "text/event-stream" },
      body: chatReasoningStream("streamed reasoning", "the answer"),
    }));
    const dsLoser = await recordingChat(FAIL_429);
    const p = port(await startProxy(deepSeekPoolCfg(
      `http://127.0.0.1:${port(dsWinner.server)}`,
      `http://127.0.0.1:${port(dsLoser.server)}`,
    )));

    const resp = await fetch(`http://127.0.0.1:${p}/v1/responses`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ model: "pool/coding", stream: true, input: "hi" }),
    });
    expect(resp.status).toBe(200);
    const sse = await resp.text();
    const reasoningItems = parseSse(sse)
      .filter((e) => e.type === "response.output_item.done")
      .map((e) => e.data.item)
      .filter((i): i is Record<string, unknown> => typeof i === "object" && i !== null && (i as Record<string, unknown>).type === "reasoning");
    expect(reasoningItems).toHaveLength(1);
    expect(reasoningItems[0]!.summary).toEqual([{ type: "summary_text", text: "streamed reasoning" }]);
    // The answer's own text is the answer, with no chain-of-thought fused into it.
    const textDeltas = parseSse(sse)
      .filter((e) => e.type === "response.output_text.delta")
      .map((e) => String(e.data.delta))
      .join("");
    expect(textDeltas).toBe("the answer");
  });

  it("streamed: a non-deepseek sibling's Responses stream carries no reasoning item at all (regression guard)", async () => {
    const dsLoser = await recordingChat(FAIL_429);
    const plainWinner = await recordingChat(() => ({
      headers: { "content-type": "text/event-stream" },
      body: chatReasoningStream("reasoning the plain target must drop", "the answer"),
    }));
    const p = port(await startProxy(deepSeekPoolCfg(
      `http://127.0.0.1:${port(dsLoser.server)}`,
      `http://127.0.0.1:${port(plainWinner.server)}`,
    )));

    const resp = await fetch(`http://127.0.0.1:${p}/v1/responses`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ model: "pool/coding", stream: true, input: "hi" }),
    });
    expect(resp.status).toBe(200);
    const sse = await resp.text();
    // Regression guard: every other provider's response bytes are unchanged — the reasoning the
    // plain target's upstream sent is dropped, never announced and never fused into the answer.
    const reasoningItems = parseSse(sse)
      .filter((e) => e.type === "response.output_item.done")
      .map((e) => e.data.item)
      .filter((i): i is Record<string, unknown> => typeof i === "object" && i !== null && (i as Record<string, unknown>).type === "reasoning");
    expect(reasoningItems).toHaveLength(0);
    expect(sse).not.toContain("reasoning the plain target must drop");
    const textDeltas = parseSse(sse)
      .filter((e) => e.type === "response.output_text.delta")
      .map((e) => String(e.data.delta))
      .join("");
    expect(textDeltas).toBe("the answer");
  });
});

describe("DeepSeek reasoning closes the multi-turn loop (F11 replay)", () => {
  it("the reasoning the caller received is what openai-request.ts replays as reasoning_content next turn", async () => {
    const dsWinner = await recordingChat((n) => ({
      body: n === 1
        ? chatReasoningBody("I must read the manifest first.", "done")
        // The SECOND request is the replay: assert what actually went out on the wire.
        : chatPlainBody("ok"),
    }));
    const dsLoser = await recordingChat(FAIL_429);
    const p = port(await startProxy(deepSeekPoolCfg(
      `http://127.0.0.1:${port(dsWinner.server)}`,
      `http://127.0.0.1:${port(dsLoser.server)}`,
    )));

    const first = await fetch(`http://127.0.0.1:${p}/v1/messages`, {
      method: "POST",
      headers: { "content-type": "application/json", "anthropic-version": "2023-06-01" },
      body: JSON.stringify({
        model: "pool/coding",
        max_tokens: 20,
        messages: [{ role: "user", content: "do it" }],
      }),
    });
    expect(first.status).toBe(200);
    const firstBody = (await first.json()) as { content: Array<Record<string, unknown>> };
    const reasoningBlock = firstBody.content.find((b) => b.type === "thinking");
    expect(reasoningBlock).toEqual({ type: "thinking", thinking: "I must read the manifest first." });

    // Replay that block exactly as Claude Code would: the thinking block the caller received, on
    // the assistant turn, alongside the tool call it explains.
    const second = await fetch(`http://127.0.0.1:${p}/v1/messages`, {
      method: "POST",
      headers: { "content-type": "application/json", "anthropic-version": "2023-06-01" },
      body: JSON.stringify({
        model: "pool/coding",
        max_tokens: 20,
        messages: [
          { role: "user", content: "do it" },
          { role: "assistant", content: [reasoningBlock, { type: "tool_use", id: "call_1", name: "do_thing", input: {} }] },
          { role: "user", content: [{ type: "tool_result", tool_use_id: "call_1", content: "done" }] },
        ],
      }),
    });
    expect(second.status).toBe(200);
    await second.text();

    const replayed = dsWinner.bodies()[1]!;
    const assistant = (replayed.messages as Array<Record<string, unknown>>).find(
      (m) => m.role === "assistant" && Array.isArray(m.tool_calls),
    );
    // THE POINT OF THIS WHOLE BACKLOG ITEM: reasoning the caller received on turn one is what
    // goes back out as `reasoning_content` on turn two, so DeepSeek's thinking mode is satisfied
    // rather than switched off. Before the response-direction seam landed this field was absent
    // and the 400 ("must be passed back to the API") was the alternative.
    expect(assistant?.reasoning_content).toBe("I must read the manifest first.");
    // ⚠ `thinking: {type:"disabled"}` IS still present, and that is rule 5 of
    // `deepSeekThinkingSpec` rather than the F11 override: this request states no thinking control
    // and routes through a STATIC pool with no effort band, so the mapper's own default is "the
    // caller did not ask to think, so do not think". The override counter is what distinguishes
    // the two, and it is 0 here.
    expect(replayed.thinking).toEqual({ type: "disabled" });
  });
});
