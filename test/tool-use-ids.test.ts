import { describe, expect, it } from "vitest";
import {
  knownToolUseIds,
  rewriteToolUseIds,
  rewriteToolUseIdsInStream,
  uniqueToolUseId,
} from "../src/tool-use-ids.js";

function streamOf(chunks: string[]): ReadableStream<Uint8Array> {
  const enc = new TextEncoder();
  return new ReadableStream({
    start(c) {
      for (const s of chunks) c.enqueue(enc.encode(s));
      c.close();
    },
  });
}

async function collect(s: ReadableStream<Uint8Array>): Promise<string> {
  const reader = s.getReader();
  const dec = new TextDecoder();
  let out = "";
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    out += dec.decode(value, { stream: true });
  }
  return out + dec.decode();
}

const ev = (type: string, data: object) => `event: ${type}\ndata: ${JSON.stringify({ type, ...data })}\n\n`;
const toolStart = (index: number, id: string, name = "Read") =>
  ev("content_block_start", { index, content_block: { type: "tool_use", id, name, input: {} } });

describe("knownToolUseIds", () => {
  it("collects both the assistant tool_use ids and the user tool_result ids", () => {
    const req = {
      messages: [
        { role: "user", content: "read the file" },
        { role: "assistant", content: [{ type: "tool_use", id: "Read:0", name: "Read", input: {} }] },
        { role: "user", content: [{ type: "tool_result", tool_use_id: "Read:0", content: "…" }] },
        { role: "assistant", content: [{ type: "tool_use", id: "Bash:0", name: "Bash", input: {} }] },
      ],
    };
    expect([...knownToolUseIds(req)].sort()).toEqual(["Bash:0", "Read:0"]);
  });

  it("returns an empty set for a conversation with no tool traffic, and for junk", () => {
    expect(knownToolUseIds({ messages: [{ role: "user", content: "hi" }] }).size).toBe(0);
    expect(knownToolUseIds({}).size).toBe(0);
    expect(knownToolUseIds(null).size).toBe(0);
    expect(knownToolUseIds("nope").size).toBe(0);
  });
});

describe("uniqueToolUseId", () => {
  it("returns the id unchanged when nothing has claimed it", () => {
    expect(uniqueToolUseId("Read:0", new Set())).toBe("Read:0");
    expect(uniqueToolUseId("Read:0", new Set(["Bash:0"]))).toBe("Read:0");
  });

  it("mints a derived id when the conversation already carries it", () => {
    expect(uniqueToolUseId("Read:0", new Set(["Read:0"]))).toBe("Read:0_relay1");
  });

  it("skips to the next k when the replacement is itself taken", () => {
    const taken = new Set(["Read:0", "Read:0_relay1", "Read:0_relay2"]);
    expect(uniqueToolUseId("Read:0", taken)).toBe("Read:0_relay3");
  });

  it("is deterministic — no randomness in the scheme", () => {
    const taken = new Set(["Read:0"]);
    expect(uniqueToolUseId("Read:0", taken)).toBe(uniqueToolUseId("Read:0", taken));
  });

  it("keeps the minted id inside the [A-Za-z0-9_:-] character set hosts accept", () => {
    expect(uniqueToolUseId("Read:0", new Set(["Read:0"]))).toMatch(/^[A-Za-z0-9_:-]+$/);
  });

  it("does not mutate the set it was handed", () => {
    const taken = new Set(["Read:0"]);
    uniqueToolUseId("Read:0", taken);
    expect([...taken]).toEqual(["Read:0"]);
  });
});

describe("rewriteToolUseIds (buffered content)", () => {
  const block = (id: string, name = "Read") => ({ type: "tool_use", id, name, input: { file: "a" } });

  it("leaves content untouched — same array instance — when no id collides", () => {
    const content = [{ type: "text", text: "ok" }, block("Read:1")];
    const out = rewriteToolUseIds(content, new Set(["Read:0"]));
    expect(out.rewritten).toBe(0);
    expect(out.content).toBe(content);
    expect(out.map.size).toBe(0);
  });

  it("mints a fresh id for a block whose id the conversation already used", () => {
    const out = rewriteToolUseIds([block("Read:0")], new Set(["Read:0"]));
    expect(out.rewritten).toBe(1);
    expect((out.content[0] as { id: string }).id).toBe("Read:0_relay1");
    expect(out.map.get("Read:0")).toBe("Read:0_relay1");
  });

  it("diverges two identical ids inside ONE response", () => {
    // kimi emits `<ToolName>:<index in this response>`, so one turn calling Read twice can repeat.
    const out = rewriteToolUseIds([block("Read:0"), block("Read:0")], new Set());
    expect(out.rewritten).toBe(1);
    expect((out.content[0] as { id: string }).id).toBe("Read:0");
    expect((out.content[1] as { id: string }).id).toBe("Read:0_relay1");
  });

  it("steps past a replacement the conversation already holds", () => {
    const out = rewriteToolUseIds([block("Read:0")], new Set(["Read:0", "Read:0_relay1"]));
    expect((out.content[0] as { id: string }).id).toBe("Read:0_relay2");
  });

  it("never touches a non-tool_use block, and keeps name/input identical", () => {
    const text = { type: "text", text: "reading" };
    const out = rewriteToolUseIds([text, block("Read:0")], new Set(["Read:0"]));
    expect(out.content[0]).toBe(text);
    expect(out.content[1]).toMatchObject({ type: "tool_use", name: "Read", input: { file: "a" } });
  });

  it("leaves a unique host id alone even when the response also carries a colliding one", () => {
    const out = rewriteToolUseIds([block("Bash:0"), block("Read:0")], new Set(["Read:0"]));
    expect((out.content[0] as { id: string }).id).toBe("Bash:0");
    expect((out.content[1] as { id: string }).id).toBe("Read:0_relay1");
    expect(out.rewritten).toBe(1);
  });
});

describe("rewriteToolUseIdsInStream", () => {
  const OPEN = ev("message_start", { message: { id: "msg_1", model: "m", content: [] } });
  const CLOSE = ev("message_delta", { delta: { stop_reason: "tool_use" } }) + ev("message_stop", {});

  it("rewrites a colliding content_block_start id and leaves every other event byte-identical", async () => {
    const events = [
      OPEN,
      ev("content_block_start", { index: 0, content_block: { type: "text", text: "" } }),
      ev("content_block_delta", { index: 0, delta: { type: "text_delta", text: "reading tool_use now" } }),
      ev("content_block_stop", { index: 0 }),
      toolStart(1, "Read:0"),
      ev("content_block_delta", { index: 1, delta: { type: "input_json_delta", partial_json: "{\"f\":1}" } }),
      ev("content_block_stop", { index: 1 }),
      CLOSE,
    ];
    let count = 0;
    const out = await collect(rewriteToolUseIdsInStream(
      streamOf(events),
      () => new Set(["Read:0"]),
      (n) => { count = n; },
    ));

    expect(count).toBe(1);
    expect(out).toContain('"id":"Read:0_relay1"');
    expect(out).not.toContain('"id":"Read:0"');
    // Everything except the one rewritten event is unchanged, including a text delta that happens
    // to contain the literal `tool_use`.
    const untouched = [...events.slice(0, 4), ...events.slice(5)].join("");
    expect(out.replace(/event: content_block_start\ndata: .*"tool_use".*\n\n/, "")).toBe(untouched);
  });

  it("passes a stream through byte-identical when no id collides", async () => {
    const raw = [OPEN, toolStart(0, "call_abc"), CLOSE].join("");
    let called = 0;
    const out = await collect(rewriteToolUseIdsInStream(
      streamOf([raw]),
      () => new Set(["Read:0"]),
      () => { called += 1; },
    ));
    expect(out).toBe(raw);
    expect(called).toBe(0);
  });

  it("diverges two identical ids within one stream", async () => {
    const out = await collect(rewriteToolUseIdsInStream(
      streamOf([OPEN, toolStart(0, "Read:0"), toolStart(1, "Read:0"), CLOSE]),
      () => new Set(),
    ));
    expect(out).toContain('"id":"Read:0"');
    expect(out).toContain('"id":"Read:0_relay1"');
  });

  it("handles an event split across chunks and CRLF framing", async () => {
    const crlf = `event: content_block_start\r\ndata: ${JSON.stringify({
      type: "content_block_start",
      index: 0,
      content_block: { type: "tool_use", id: "Read:0", name: "Read", input: {} },
    })}\r\n\r\n`;
    const half = Math.floor(crlf.length / 2);
    const out = await collect(rewriteToolUseIdsInStream(
      streamOf([crlf.slice(0, half), crlf.slice(half)]),
      () => new Set(["Read:0"]),
    ));
    expect(out).toContain('"id":"Read:0_relay1"');
    expect(out.endsWith("\r\n\r\n")).toBe(true);
  });

  it("preserves a truncated final event verbatim", async () => {
    const tail = 'event: content_block_start\ndata: {"type":"content_block_start"';
    const out = await collect(rewriteToolUseIdsInStream(streamOf([tail]), () => new Set()));
    expect(out).toBe(tail);
  });

  it("never walks the conversation when the response carries no tool call", async () => {
    let asked = 0;
    const raw = [OPEN, ev("content_block_delta", { index: 0, delta: { type: "text_delta", text: "hi" } }), CLOSE].join("");
    const out = await collect(rewriteToolUseIdsInStream(streamOf([raw]), () => { asked += 1; return new Set(); }));
    expect(out).toBe(raw);
    expect(asked).toBe(0);
  });
});
