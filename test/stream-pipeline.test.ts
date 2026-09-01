import { PassThrough } from "node:stream";
import type { IncomingMessage } from "node:http";
import { describe, expect, it } from "vitest";
import { BODY_TOO_LARGE_CODE } from "../src/dashboard-routes.js";
import { DEFAULT_MAX_BODY_BYTES, readBody } from "../src/stream-pipeline.js";

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
