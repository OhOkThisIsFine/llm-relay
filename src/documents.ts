/**
 * Anthropic `document` content blocks -> markdown text, via MarkItDown.
 *
 * Why this exists: llm-bridge only translates text/image/tool_use/tool_result. Any
 * other block type hits its fallback and becomes `text: JSON.stringify(block)` — so
 * a PDF's ENTIRE base64 payload was being injected into the prompt. The model can't
 * read base64, and the token count scales with the encoded size, so a few-MB PDF
 * silently blows the context guardrail or burns a large paid prompt. Stringifying a
 * document is worse than refusing it.
 *
 * So for `kind: "openai"` targets we transcode documents to markdown BEFORE handing
 * the request to llm-bridge, and fail clean when we can't. Anthropic-kind targets are
 * untouched — they handle documents natively.
 *
 * MarkItDown is an external Python CLI and deliberately an OPTIONAL dependency: a Node
 * package cannot assume a Python toolchain. When it is missing, a request carrying a
 * document gets a clear error naming the install command — never a mangled prompt.
 */
import { spawn } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

/** Anthropic media types MarkItDown can convert, -> the extension hint it wants on stdin. */
const EXT_BY_MEDIA_TYPE: Record<string, string> = {
  "application/pdf": ".pdf",
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document": ".docx",
  "application/vnd.openxmlformats-officedocument.presentationml.presentation": ".pptx",
  "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet": ".xlsx",
  "text/csv": ".csv",
  "text/html": ".html",
  "application/json": ".json",
  "text/plain": ".txt",
  "text/markdown": ".md",
};

/** Decoded payload cap. A document past this is refused, not truncated — a half-document reads as a complete one. */
const DEFAULT_MAX_BYTES = 25 * 1024 * 1024;
const DEFAULT_TIMEOUT_MS = 60_000;

/** Raised for a document we will not send onward. The caller turns this into a clean 4xx/502. */
export class DocumentError extends Error {}

export interface TranscodeOptions {
  /** Override the MarkItDown executable (default `markitdown`, or $LLM_RELAY_MARKITDOWN). */
  command?: string;
  maxBytes?: number;
  timeoutMs?: number;
  /** Injected in tests. */
  runner?: (buf: Buffer, ext: string, opts: Required<Pick<TranscodeOptions, "command" | "timeoutMs">>) => Promise<string>;
}

/**
 * Run MarkItDown over a buffer and return markdown.
 *
 * Via a TEMP FILE, not stdin: MarkItDown advertises stdin, but pdfminer seeks the
 * stream to find `startxref`, and a pipe isn't seekable — every PDF piped in dies with
 * "No /Root object! - Is this really a PDF?". Passing a filename is the path that works.
 * The temp dir is removed in `finally`, including on timeout.
 */
async function runMarkItDown(buf: Buffer, ext: string, opts: { command: string; timeoutMs: number }): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "llm-relay-doc-"));
  const file = join(dir, `${randomUUID()}${ext}`);
  try {
    await writeFile(file, buf);
    return await execMarkItDown(file, opts);
  } finally {
    await rm(dir, { recursive: true, force: true }).catch(() => {});
  }
}

/** Spawn the converter over a path. Rejects with DocumentError on any non-clean exit. */
function execMarkItDown(file: string, opts: { command: string; timeoutMs: number }): Promise<string> {
  return new Promise((resolve, reject) => {
    let proc;
    try {
      proc = spawn(opts.command, [file], { stdio: ["ignore", "pipe", "pipe"] });
    } catch (e) {
      reject(new DocumentError(`markitdown could not be started: ${(e as Error).message}`));
      return;
    }

    const out: Buffer[] = [];
    const err: Buffer[] = [];
    let settled = false;
    const finish = (fn: () => void) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      fn();
    };

    const timer = setTimeout(() => {
      proc.kill();
      finish(() => reject(new DocumentError(`markitdown timed out after ${opts.timeoutMs}ms`)));
    }, opts.timeoutMs);

    proc.stdout.on("data", (d) => out.push(d));
    proc.stderr.on("data", (d) => err.push(d));
    proc.on("error", (e) => {
      const missing = (e as NodeJS.ErrnoException).code === "ENOENT";
      finish(() =>
        reject(
          new DocumentError(
            missing
              ? `document blocks require MarkItDown, which is not installed or not on PATH. Install it with \`pip install 'markitdown[all]'\`, or set LLM_RELAY_MARKITDOWN to its path.`
              : `markitdown failed to start: ${e.message}`,
          ),
        ),
      );
    });
    proc.on("close", (code) => {
      finish(() => {
        if (code === 0) resolve(Buffer.concat(out).toString("utf8"));
        else {
          // The tail of the traceback carries the actual reason; the head is Python frames.
          const stderr = Buffer.concat(err).toString("utf8").trim();
          reject(new DocumentError(`markitdown exited ${code}: ${stderr.slice(-300)}`));
        }
      });
    });
  });
}

/** Decode one document block's source to bytes + an extension hint. */
function decodeSource(block: Record<string, unknown>, maxBytes: number): { buf: Buffer; ext: string } | { text: string } {
  const source = (block.source ?? {}) as Record<string, unknown>;
  const mediaType = typeof source.media_type === "string" ? source.media_type : "";

  // `text` and `content` sources are already model-readable — pass the text through untouched.
  if (source.type === "text" && typeof source.data === "string") return { text: source.data };
  if (source.type === "content") {
    const parts = Array.isArray(source.content) ? source.content : [];
    const text = parts
      .map((p) => (p && typeof p === "object" && (p as Record<string, unknown>).type === "text" ? String((p as Record<string, unknown>).text ?? "") : ""))
      .join("\n")
      .trim();
    if (text) return { text };
    throw new DocumentError("document block with a `content` source carried no text");
  }

  if (source.type === "url") {
    // Fetching an arbitrary URL would make the proxy a request forwarder for whatever
    // the client names — an SSRF surface that a loopback proxy holding a provider key
    // should not grow. The client can inline the bytes instead.
    throw new DocumentError("document blocks with a `url` source are not supported; send `base64` instead");
  }

  if (source.type !== "base64" || typeof source.data !== "string") {
    throw new DocumentError(`unsupported document source type: ${String(source.type ?? "(missing)")}`);
  }

  const ext = EXT_BY_MEDIA_TYPE[mediaType];
  if (!ext) {
    throw new DocumentError(
      `unsupported document media_type: ${mediaType || "(missing)"} (supported: ${Object.keys(EXT_BY_MEDIA_TYPE).join(", ")})`,
    );
  }

  const buf = Buffer.from(source.data, "base64");
  if (!buf.length) throw new DocumentError("document block decoded to zero bytes");
  if (buf.length > maxBytes) {
    throw new DocumentError(`document is ${buf.length} bytes, over the ${maxBytes}-byte limit`);
  }
  return { buf, ext };
}

/**
 * The fence tag wrapping a converted document, derived from the CONTENT — never from the
 * client-supplied `title`.
 *
 * The old form was `<${title}>…</${title}>`, interpolated raw. A title is attacker-shaped
 * input on the same footing as the document bytes, so `title: "doc>\n</doc"` closed the
 * fence early and everything after it read to the model as user-authored instructions
 * rather than attachment content. Escaping the title would work only for as long as the
 * escape stays exhaustive; a delimiter the client cannot influence at all cannot be
 * escaped wrong.
 *
 * Derived (hashed), not random, because these blocks carry `cache_control`: a fresh nonce
 * per request would change the prompt prefix every turn and bust the provider cache. A
 * hash of the exact content is stable across identical requests, and the collision guard
 * below closes the one theoretical gap — content that happens to contain its own tag.
 */
function fenceTag(content: string, title: string): string {
  const digest = createHash("sha256").update(content).digest("hex");
  for (let n = 0; n < 8; n++) {
    const tag = `document-${digest.slice(n * 8, n * 8 + 12)}`;
    if (!content.includes(tag) && !title.includes(tag)) return tag;
  }
  // Unreachable in practice; a random tag is still correct, it just costs the cache hit.
  return `document-${randomUUID().replace(/-/g, "").slice(0, 12)}`;
}

/**
 * Render the client's title as an inert label. It is metadata about an attachment, not
 * markup and not instructions: anything that could read as a tag boundary or a line break
 * is flattened, and the length is capped so a title cannot become the payload.
 */
function labelTitle(raw: unknown): string {
  const s = typeof raw === "string" ? raw : "";
  // Control characters (newlines included), angle brackets and quotes only — a deny-list
  // narrow enough that a non-Latin title survives intact. It is defence in depth: the tag
  // itself is already independent of this value, so the title cannot reach the delimiter.
  const flattened = s.replace(/[\u0000-\u001f\u007f<>"]+/g, " ").replace(/\s+/g, " ").trim();
  return flattened.slice(0, 120) || "document";
}

/** True if the request carries at least one `document` content block. */
export function hasDocumentBlocks(body: unknown): boolean {
  const messages = (body as { messages?: unknown })?.messages;
  if (!Array.isArray(messages)) return false;
  return messages.some(
    (m) =>
      Array.isArray((m as { content?: unknown })?.content) &&
      (m as { content: unknown[] }).content.some((b) => (b as { type?: string })?.type === "document"),
  );
}

/**
 * Replace every `document` block with a markdown `text` block. Returns a NEW body —
 * the caller's object is not mutated. Throws `DocumentError` if any document cannot
 * be converted; there is no partial success, because a request that silently lost one
 * of its attachments looks identical to one that never had it.
 */
export async function transcodeDocuments(body: unknown, opts: TranscodeOptions = {}): Promise<unknown> {
  if (!hasDocumentBlocks(body)) return body;

  const command = opts.command ?? process.env.LLM_RELAY_MARKITDOWN ?? "markitdown";
  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const maxBytes = opts.maxBytes ?? DEFAULT_MAX_BYTES;
  const run = opts.runner ?? runMarkItDown;

  const src = body as { messages: unknown[] };
  const messages = await Promise.all(
    src.messages.map(async (msg) => {
      const content = (msg as { content?: unknown }).content;
      if (!Array.isArray(content)) return msg;
      if (!content.some((b) => (b as { type?: string })?.type === "document")) return msg;

      const blocks = await Promise.all(
        content.map(async (block) => {
          if ((block as { type?: string })?.type !== "document") return block;
          const b = block as Record<string, unknown>;
          const decoded = decodeSource(b, maxBytes);
          const text = "text" in decoded ? decoded.text : await run(decoded.buf, decoded.ext, { command, timeoutMs });
          const title = labelTitle(b.title);
          const converted = text.trim();
          if (!converted) throw new DocumentError(`markitdown produced no text for ${title}`);
          const tag = fenceTag(converted, title);
          return {
            type: "text",
            // Fenced so the model reads it as an attachment, not as instructions from the
            // user. The tag comes from `fenceTag` (content-derived) and NOT from the title:
            // the delimiter must not be something the client can choose, or it can close
            // the fence early and have the rest read as its own instructions.
            text: `<${tag} title="${title}">\n${converted}\n</${tag}>`,
            ...(b.cache_control ? { cache_control: b.cache_control } : {}),
          };
        }),
      );
      return { ...(msg as object), content: blocks };
    }),
  );

  return { ...(body as object), messages };
}
