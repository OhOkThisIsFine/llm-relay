import { describe, expect, it } from "vitest";
import { BufferedSseFrames, findSseBoundary, sseEventFields } from "../src/sse-frames.js";

describe("shared SSE framing", () => {
  it("consumes a mixed CRLF/LF boundary as one separator with no stray carriage return", () => {
    const frames = new BufferedSseFrames();
    expect([...frames.append('event: first\ndata: {"n":1}\r')]).toEqual([]);

    const complete = [...frames.append('\n\nevent: second\ndata: {"n":2}\n\n')];
    expect(findSseBoundary('data: one\r\n\ndata: two')).toEqual({
      index: "data: one".length,
      separator: "\r\n\n",
    });
    expect(complete.map(({ frame, separator }) => ({ frame, separator }))).toEqual([
      { frame: 'event: first\ndata: {"n":1}', separator: "\r\n\n" },
      { frame: 'event: second\ndata: {"n":2}', separator: "\n\n" },
    ]);
    expect(complete[0]!.frame.endsWith("\r")).toBe(false);
    expect(complete[1]!.frame.startsWith("\r")).toBe(false);
    expect(sseEventFields(complete[1]!.frame)).toEqual({
      eventLines: [" second"],
      dataLines: [' {"n":2}'],
    });
  });

  it("pins the module's own contract: prefix stability, pure CRLF, remainder, resumability", () => {
    // Prefix stability is what makes chunk-spanning iteration safe: a buffer ending inside a
    // potential separator must report NO boundary, never a premature short one.
    expect(findSseBoundary("a")).toBeNull();
    expect(findSseBoundary("a\r")).toBeNull();
    expect(findSseBoundary("a\r\n")).toBeNull();
    expect(findSseBoundary("a\n\r")).toBeNull();
    expect(findSseBoundary("a\r\n\r")).toBeNull();
    // A CR-CR blank line is deliberately not a boundary — same as every predecessor family.
    expect(findSseBoundary("a\r\rb")).toBeNull();
    expect(findSseBoundary("a\r\n\r\nb")).toEqual({ index: 1, separator: "\r\n\r\n" });

    // Resumable by design: done today, more frames after the next append.
    const frames = new BufferedSseFrames();
    expect([...frames.append("a\n\nb")]).toHaveLength(1);
    expect([...frames.append("\n\nc")].map(({ frame }) => frame)).toEqual(["b"]);
    // takeRemainder releases the incomplete tail verbatim, decoder tail included.
    expect(frames.takeRemainder("d")).toBe("cd");
    expect(frames.takeRemainder()).toBe("");
  });

  it("returns every event line so both adopter policies stay expressible", () => {
    // openai-dialect/stream-commit read the FIRST event line; think-tags/dialect-stream read the
    // LAST. Collapsing eventLines to one string flips one family silently — this pins the array.
    const fields = sseEventFields("event: first\nevent: second\ndata: {}");
    expect(fields.eventLines).toEqual([" first", " second"]);
    expect(fields.dataLines).toEqual([" {}"]);
  });
});
