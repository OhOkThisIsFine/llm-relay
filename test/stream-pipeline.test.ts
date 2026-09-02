import { PassThrough } from "node:stream";
import type { IncomingMessage, ServerResponse } from "node:http";
import { describe, expect, it } from "vitest";
import { BODY_TOO_LARGE_CODE } from "../src/dashboard-routes.js";
import { DEFAULT_MAX_BODY_BYTES, forwardLocalResponse, readBody } from "../src/stream-pipeline.js";

function fakeRequest(): PassThrough & IncomingMessage {
  return new PassThrough() as unknown as PassThrough & IncomingMessage;
}

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
