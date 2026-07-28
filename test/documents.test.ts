import { describe, it, expect } from "vitest";
import { DocumentError, hasDocumentBlocks, transcodeDocuments } from "../src/documents.js";

const PDF_B64 = Buffer.from("%PDF-1.4 fake").toString("base64");

function withDocument(source: Record<string, unknown>, extra: Record<string, unknown> = {}) {
  return {
    model: "claude-3-5-sonnet",
    messages: [
      { role: "user", content: [{ type: "document", source, ...extra }, { type: "text", text: "summarize" }] },
    ],
  };
}

const runner = async () => "# Heading\n\nExtracted body text.";

describe("hasDocumentBlocks", () => {
  it("detects a document block and ignores bodies without one", () => {
    expect(hasDocumentBlocks(withDocument({ type: "base64", media_type: "application/pdf", data: PDF_B64 }))).toBe(true);
    expect(hasDocumentBlocks({ messages: [{ role: "user", content: "plain string" }] })).toBe(false);
    expect(hasDocumentBlocks({ messages: [{ role: "user", content: [{ type: "text", text: "hi" }] }] })).toBe(false);
    expect(hasDocumentBlocks({})).toBe(false);
  });
});

describe("transcodeDocuments", () => {
  it("replaces a base64 PDF with a titled markdown text block and leaves siblings alone", async () => {
    const body = withDocument({ type: "base64", media_type: "application/pdf", data: PDF_B64 }, { title: "report" });
    const out = (await transcodeDocuments(body, { runner })) as any;
    expect(out.messages[0].content).toEqual([
      { type: "text", text: "<report>\n# Heading\n\nExtracted body text.\n</report>" },
      { type: "text", text: "summarize" },
    ]);
  });

  it("passes the right extension hint for the media type", async () => {
    let seen = "";
    const spy = async (_buf: Buffer, ext: string) => {
      seen = ext;
      return "text";
    };
    const docx = "application/vnd.openxmlformats-officedocument.wordprocessingml.document";
    await transcodeDocuments(withDocument({ type: "base64", media_type: docx, data: PDF_B64 }), { runner: spy });
    expect(seen).toBe(".docx");
  });

  it("returns the body untouched when there is no document block", async () => {
    const body = { messages: [{ role: "user", content: [{ type: "text", text: "hi" }] }] };
    expect(await transcodeDocuments(body, { runner })).toBe(body);
  });

  it("does not mutate the caller's body", async () => {
    const body = withDocument({ type: "base64", media_type: "application/pdf", data: PDF_B64 });
    await transcodeDocuments(body, { runner });
    expect((body.messages[0].content[0] as any).type).toBe("document");
  });

  it("preserves cache_control on the converted block", async () => {
    const body = withDocument({ type: "base64", media_type: "application/pdf", data: PDF_B64 }, { cache_control: { type: "ephemeral" } });
    const out = (await transcodeDocuments(body, { runner })) as any;
    expect(out.messages[0].content[0].cache_control).toEqual({ type: "ephemeral" });
  });

  it("passes through a text source without invoking the converter", async () => {
    const boom = async () => {
      throw new Error("converter should not run");
    };
    const out = (await transcodeDocuments(withDocument({ type: "text", data: "already text" }), { runner: boom })) as any;
    expect(out.messages[0].content[0]).toEqual({ type: "text", text: "<document>\nalready text\n</document>" });
  });

  it("refuses a url source rather than fetching it", async () => {
    await expect(transcodeDocuments(withDocument({ type: "url", url: "https://x.invalid/a.pdf" }), { runner })).rejects.toThrow(
      DocumentError,
    );
  });

  it("refuses an unsupported media type", async () => {
    await expect(
      transcodeDocuments(withDocument({ type: "base64", media_type: "application/x-msdownload", data: PDF_B64 }), { runner }),
    ).rejects.toThrow(/unsupported document media_type/);
  });

  it("refuses a document over the size cap instead of truncating it", async () => {
    const big = Buffer.alloc(2048).toString("base64");
    await expect(
      transcodeDocuments(withDocument({ type: "base64", media_type: "application/pdf", data: big }), { runner, maxBytes: 1024 }),
    ).rejects.toThrow(/over the 1024-byte limit/);
  });

  it("fails clean when the converter produces nothing", async () => {
    await expect(
      transcodeDocuments(withDocument({ type: "base64", media_type: "application/pdf", data: PDF_B64 }), { runner: async () => "  " }),
    ).rejects.toThrow(/produced no text/);
  });

  it("surfaces a missing markitdown binary as an actionable DocumentError", async () => {
    const body = withDocument({ type: "base64", media_type: "application/pdf", data: PDF_B64 });
    await expect(transcodeDocuments(body, { command: "llm-relay-no-such-binary" })).rejects.toThrow(/MarkItDown/);
  });
});
