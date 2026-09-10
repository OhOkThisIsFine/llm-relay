import { PassThrough } from "node:stream";
import type { IncomingMessage, ServerResponse } from "node:http";
import { describe, expect, it } from "vitest";
import { BODY_TOO_LARGE_CODE } from "../src/dashboard-routes.js";
import {
  CrawlAbortedError,
  DEFAULT_CRAWL_MIN_TOKENS,
  DEFAULT_CRAWL_MS_PER_TOKEN,
  DEFAULT_CRAWL_WINDOW_MS,
  DEFAULT_MAX_BODY_BYTES,
  bodyReadStatus,
  forwardLocalResponse,
  readBody,
  resolveCrawlSettings,
  withCrawlWatchdog,
  type CrawlProtocol,
  type CrawlWatchdogSettings,
} from "../src/stream-pipeline.js";

function fakeRequest(): PassThrough & IncomingMessage {
  return new PassThrough() as unknown as PassThrough & IncomingMessage;
}

describe("bodyReadStatus — the data plane's 413-vs-400 reads the code, never the prose", () => {
  // Contract review DR-005 (audit 2026-09-03): `server.ts` used to decide 413 with
  // `message.includes("too large")` while the dashboard route already compared the CODE. One
  // reader per meaning: a message that merely mentions size decides nothing.
  it("answers 413 only for the declared code", () => {
    expect(bodyReadStatus(Object.assign(new Error("anything at all"), { code: BODY_TOO_LARGE_CODE }))).toBe(413);
  });

  it("answers 400 for prose alone, for other errors, and for non-errors", () => {
    expect(bodyReadStatus(new Error("request body too large"))).toBe(400);
    expect(bodyReadStatus(new Error("socket hang up"))).toBe(400);
    expect(bodyReadStatus(Object.assign(new Error("x"), { code: "ECONNRESET" }))).toBe(400);
    expect(bodyReadStatus(null)).toBe(400);
    expect(bodyReadStatus("too large")).toBe(400);
  });
});

describe("readBody", () => {
  it("buffers a body that fits", async () => {
    const req = fakeRequest();
    const pending = readBody(req, 1024);
    req.write(Buffer.from("hello "));
    req.write(Buffer.from("world"));
    req.end();
    expect((await pending).toString()).toBe("hello world");
  });

  // ⚠ The rejection must carry a DECLARED `code`, not prose. `bodyReadErrorCode` in
  // `dashboard-routes.ts` compares `error.code === BODY_TOO_LARGE_CODE` to choose 413 over 500;
  // it deliberately no longer regexes the message, because that was the relay inferring its own
  // intent from text it wrote itself. A plain Error here silently downgrades every oversized
  // dashboard request to an "internal" 500.
  it("rejects an oversized body with the declared code, not a message to parse", async () => {
    const req = fakeRequest();
    const pending = readBody(req, 8);
    req.write(Buffer.from("0123456789"));
    req.end();

    const error: unknown = await pending.then(
      () => {
        throw new Error("expected readBody to reject");
      },
      (err: unknown) => err,
    );

    expect(error).toBeInstanceOf(Error);
    expect((error as { code?: unknown }).code).toBe(BODY_TOO_LARGE_CODE);
  });

  // The stream is drained rather than destroyed, so the caller can still write its explicit 413.
  it("drains the remainder after refusing an oversized body", async () => {
    const req = fakeRequest();
    const pending = readBody(req, 4);
    req.write(Buffer.from("aaaaaaaa"));

    await pending.catch(() => undefined);

    expect(req.destroyed).toBe(false);
    req.write(Buffer.from("trailing"));
    req.end();
  });

  it("propagates a stream error unchanged", async () => {
    const req = fakeRequest();
    const pending = readBody(req, 1024);
    const boom = new Error("socket reset");
    req.destroy(boom);
    await expect(pending).rejects.toThrow("socket reset");
  });

  it("defaults its ceiling when the caller states none", async () => {
    const req = fakeRequest();
    const pending = readBody(req);
    req.end(Buffer.from("small"));
    expect((await pending).toString()).toBe("small");
    expect(DEFAULT_MAX_BODY_BYTES).toBeGreaterThan(0);
  });
});

/** A ServerResponse stand-in that records whether the head was committed, and when. */
function fakeResponse() {
  const chunks: Buffer[] = [];
  const res = {
    headersSent: false,
    writableEnded: false,
    statusCode: 0,
    sentHeaders: null as Record<string, string> | null,
    writeHead(status: number, headers: Record<string, string>) {
      this.headersSent = true;
      this.statusCode = status;
      this.sentHeaders = headers;
      return this;
    },
    end(body?: Buffer) {
      if (body) chunks.push(body);
      this.writableEnded = true;
      return this;
    },
    write() {
      return true;
    },
    once() {
      return this;
    },
    body: () => Buffer.concat(chunks).toString(),
  };
  return res;
}

describe("forwardLocalResponse", () => {
  it("forwards a relay-authored refusal with its status, headers and body", async () => {
    const res = fakeResponse();
    const local = new Response("refused", {
      status: 400,
      headers: { "content-type": "application/json" },
    });

    await forwardLocalResponse(res as unknown as ServerResponse, local);

    expect(res.statusCode).toBe(400);
    expect(res.sentHeaders?.["content-type"]).toBe("application/json");
    expect(res.body()).toBe("refused");
    expect(res.writableEnded).toBe(true);
  });

  // ⚠⚠ This is the local-failure exit of both candidate loops, where the contract is to fail
  // CLEAN. While the head is unsent the caller can still answer with a proper status, so a body
  // read that rejects must throw BEFORE `writeHead`. Committing the head first and then streaming
  // leaves the client a truncated body under an already-sent status — the one outcome this path
  // exists to avoid.
  it("leaves the head UNSENT when reading the body rejects", async () => {
    const res = fakeResponse();
    const local = {
      status: 400,
      headers: new Headers({ "content-type": "application/json" }),
      arrayBuffer: () => Promise.reject(new Error("body read failed")),
    };

    await expect(
      forwardLocalResponse(res as unknown as ServerResponse, local as unknown as Response),
    ).rejects.toThrow("body read failed");

    expect(res.headersSent).toBe(false);
    expect(res.writableEnded).toBe(false);
  });

  it("does not overwrite a head another writer already committed", async () => {
    const res = fakeResponse();
    res.headersSent = true;
    res.statusCode = 200;

    await forwardLocalResponse(res as unknown as ServerResponse, new Response("late", { status: 400 }));

    expect(res.statusCode).toBe(200);
    expect(res.body()).toBe("late");
  });
});

describe("readBody default ceiling", () => {
  it("applies DEFAULT_MAX_BODY_BYTES when the caller states no ceiling", async () => {
    const req = fakeRequest();
    const pending = readBody(req);
    req.end(Buffer.from("small"));
    expect((await pending).toString()).toBe("small");
    expect(DEFAULT_MAX_BODY_BYTES).toBeGreaterThan(0);
  });
});

describe("resolveCrawlSettings", () => {
  it("defaults to enabled with the tunable defaults", () => {
    expect(resolveCrawlSettings(undefined)).toEqual({
      enabled: true,
      msPerToken: DEFAULT_CRAWL_MS_PER_TOKEN,
      windowMs: DEFAULT_CRAWL_WINDOW_MS,
      minTokens: DEFAULT_CRAWL_MIN_TOKENS,
    });
  });

  it("honours explicit values and an explicit disable", () => {
    expect(resolveCrawlSettings({ enabled: false })).toEqual({
      enabled: false,
      msPerToken: DEFAULT_CRAWL_MS_PER_TOKEN,
      windowMs: DEFAULT_CRAWL_WINDOW_MS,
      minTokens: DEFAULT_CRAWL_MIN_TOKENS,
    });
    expect(resolveCrawlSettings({ msPerToken: 500, windowMs: 10_000, minTokens: 5 })).toEqual({
      enabled: true,
      msPerToken: 500,
      windowMs: 10_000,
      minTokens: 5,
    });
  });
});

describe("withCrawlWatchdog", () => {
  const encoder = new TextEncoder();

  function anthropicFrame(chars: number): string {
    return `data: ${JSON.stringify({
      type: "content_block_delta",
      delta: { type: "text_delta", text: "a".repeat(chars) },
    })}\n\n`;
  }
  function anthropicPing(): string {
    return `data: ${JSON.stringify({ type: "ping" })}\n\n`;
  }
  function openAiChatFrame(chars: number): string {
    return `data: ${JSON.stringify({ choices: [{ delta: { content: "a".repeat(chars) } }] })}\n\n`;
  }
  function openAiResponsesFrame(chars: number): string {
    return `data: ${JSON.stringify({ type: "response.output_text.delta", delta: "a".repeat(chars) })}\n\n`;
  }

  /**
   * A ReadableStream this test drives directly, plus the controller used to enqueue chunks on
   * a schedule the test picks.
   */
  function controllableSource(): {
    stream: ReadableStream<Uint8Array>;
    controller: ReadableStreamDefaultController<Uint8Array>;
  } {
    let controller!: ReadableStreamDefaultController<Uint8Array>;
    const stream = new ReadableStream<Uint8Array>({
      start(c) {
        controller = c;
      },
    });
    return { stream, controller };
  }

  /**
   * Feed a scripted sequence of `{ at, frame }` steps through `withCrawlWatchdog` under a fake
   * clock, awaiting the corresponding output chunk after each enqueue. `transform()` in
   * `withCrawlWatchdog` is fully synchronous (no `await` inside it), and it enqueues the
   * passthrough byte chunk as its FIRST statement — so by the time our reader observes that
   * passthrough chunk, the whole of that transform() call (including any `controller.abort()`)
   * has already run to completion. That makes this harness race-free with no arbitrary waits.
   */
  async function driveCrawl(
    protocol: CrawlProtocol,
    settings: CrawlWatchdogSettings,
    script: readonly { at: number; frame: string }[],
  ): Promise<AbortController> {
    let currentTime = 0;
    const now = () => currentTime;
    const { stream: source, controller: sourceController } = controllableSource();
    const abortController = new AbortController();
    const response = new Response(source, { status: 200 });
    const wrapped = withCrawlWatchdog(response, abortController, protocol, settings, now);
    const reader = wrapped.body!.getReader();

    for (const step of script) {
      currentTime = step.at;
      sourceController.enqueue(encoder.encode(step.frame));
      await reader.read();
    }
    sourceController.close();
    await reader.read();

    return abortController;
  }

  const settings2000_2_100: CrawlWatchdogSettings = {
    enabled: true,
    windowMs: 2000,
    minTokens: 2,
    msPerToken: 100,
  };

  it("does not abort a fast stream: 60 tokens inside the first full window", async () => {
    const controller = await driveCrawl("anthropic-messages", settings2000_2_100, [
      { at: 100, frame: anthropicFrame(240) }, // 240 chars / 4 = 60 tokens, well before the window is full
      { at: 2000, frame: anthropicPing() }, // triggers the full-window check at elapsed === windowMs
    ]);
    expect(controller.signal.aborted).toBe(false);
  });

  it("aborts a crawl — one token per 1.5s — at the first full window, message pinned verbatim", async () => {
    const controller = await driveCrawl("anthropic-messages", settings2000_2_100, [
      { at: 1500, frame: anthropicFrame(4) }, // 1 token; total=1 < minTokens(2) — no full-window check yet
      { at: 3000, frame: anthropicFrame(4) }, // 1 more token; total=2 >= minTokens; elapsed=3000 >= windowMs(2000)
    ]);
    expect(controller.signal.aborted).toBe(true);
    const reason = controller.signal.reason;
    expect(reason).toBeInstanceOf(CrawlAbortedError);
    const crawl = reason as CrawlAbortedError;
    // windowStart = 3000 - 2000 = 1000; both samples (ts 1500, ts 3000) fall inside [1000, 3000],
    // so tokensInWindow = 2 and rate = windowMs / tokensInWindow = 2000 / 2 = 1000 ms/token.
    expect(crawl.rateMsPerToken).toBe(1000);
    expect(crawl.windowMs).toBe(2000);
    expect(crawl.thresholdMsPerToken).toBe(100);
    expect(crawl.message).toBe("relay aborted a crawling stream: 1000 ms/token over 2 s (threshold 100)");
  });

  it("never judges below minTokens since commit, however slow", async () => {
    const settings: CrawlWatchdogSettings = { enabled: true, windowMs: 2000, minTokens: 5, msPerToken: 100 };
    const controller = await driveCrawl("anthropic-messages", settings, [
      { at: 500, frame: anthropicFrame(4) }, // 1 token total, forever below minTokens(5)
      { at: 10_000, frame: anthropicPing() }, // elapsed is huge, but gate 1 (minTokens) still fails
    ]);
    expect(controller.signal.aborted).toBe(false);
  });

  it("gives no opinion when a full window holds zero tokens — leaves silence to the stall watchdog", async () => {
    const controller = await driveCrawl("anthropic-messages", settings2000_2_100, [
      { at: 100, frame: anthropicFrame(8) }, // 2 tokens, clears minTokens, but elapsed(100) < windowMs(2000)
      { at: 5000, frame: anthropicPing() }, // windowStart = 5000-2000 = 3000; the ts=100 sample fell out
    ]);
    expect(controller.signal.aborted).toBe(false);
  });

  // The brief's own worked example, run against the DEFAULT settings (not a custom fixture) —
  // this is the case that pins the arithmetic fix itself: under the ORIGINAL defaults
  // (windowMs 20_000, minTokens 50), spanMs could never exceed windowMs and tokensInWindow had to
  // clear minTokens BEFORE a rate was computed, so the worst case was 20_000 / 50 = 400 ms/token —
  // always under the 1000 ms/token threshold. This exact scenario could never abort under the old
  // defaults, whatever the true rate. Under the corrected defaults (windowMs 30_000, minTokens 20,
  // rate = windowMs / tokensInWindow) it aborts at the first full window.
  it("aborts the brief's own worked example — 60 tokens over 90 s, one every 1.5 s — under the DEFAULT settings", async () => {
    const settings = resolveCrawlSettings(undefined);
    const script: { at: number; frame: string }[] = [];
    for (let k = 1; k <= 60; k++) script.push({ at: k * 1500, frame: anthropicFrame(4) });
    const controller = await driveCrawl("anthropic-messages", settings, script);
    expect(controller.signal.aborted).toBe(true);
    expect(controller.signal.reason).toBeInstanceOf(CrawlAbortedError);
  });

  it("never installs the watchdog when disabled — returns the identical Response object", () => {
    const response = new Response(new ReadableStream(), { status: 200 });
    const controller = new AbortController();
    const settings: CrawlWatchdogSettings = { enabled: false, windowMs: 2000, minTokens: 2, msPerToken: 100 };
    const wrapped = withCrawlWatchdog(response, controller, "anthropic-messages", settings);
    expect(wrapped).toBe(response);
  });

  it.each([
    ["openai-chat" as const, openAiChatFrame] as const,
    ["openai-responses" as const, openAiResponsesFrame] as const,
  ])("aborts a crawl on the %s protocol the same way", async (protocol, frame) => {
    const controller = await driveCrawl(protocol, settings2000_2_100, [
      { at: 1500, frame: frame(4) },
      { at: 3000, frame: frame(4) },
    ]);
    expect(controller.signal.aborted).toBe(true);
    expect(controller.signal.reason).toBeInstanceOf(CrawlAbortedError);
  });
});
