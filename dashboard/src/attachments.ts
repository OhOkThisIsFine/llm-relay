// Zero-dependency file and image attachment handling for the Playground.
// Supports image downscaling via browser Canvas to keep prompt sizes within free-tier limits,
// and UTF-8 text file inlining (.txt, .md, .json, .csv, .log).

export const MAX_IMAGE_EDGE = 1024;
export const MAX_IMAGE_BYTES = 1_200_000;
export const MAX_TOTAL_IMAGE_BYTES = 3_000_000;
export const MAX_TEXT_BYTES = 128_000;
export const MAX_ATTACHMENTS = 5;

export const IMAGE_MIME_TYPES = ["image/png", "image/jpeg", "image/webp", "image/gif"] as const;
export const TEXT_EXTENSIONS = ["txt", "md", "markdown", "csv", "tsv", "json", "log"] as const;

export const ACCEPT_ATTRIBUTE = [
  ...IMAGE_MIME_TYPES,
  ...TEXT_EXTENSIONS.map((ext) => `.${ext}`),
].join(",");

export type AttachmentKind = "image" | "text";

export interface Attachment {
  readonly id: string;
  readonly kind: AttachmentKind;
  readonly name: string;
  readonly dataUrl?: string | undefined;
  readonly text?: string | undefined;
}

export function fileExtension(name: string): string {
  const dot = name.lastIndexOf(".");
  return dot === -1 ? "" : name.slice(dot + 1).toLowerCase();
}

export function classifyFile(file: { name: string; type?: string }): AttachmentKind | null {
  const type = (file.type ?? "").toLowerCase();
  if ((IMAGE_MIME_TYPES as readonly string[]).includes(type)) return "image";
  const ext = fileExtension(file.name);
  if ((TEXT_EXTENSIONS as readonly string[]).includes(ext)) return "text";
  if (!type && ext === "") return null;
  if (type.startsWith("text/")) return "text";
  if (type === "application/json") return "text";
  return null;
}

export function fitWithin(
  width: number,
  height: number,
  maxEdge = MAX_IMAGE_EDGE,
): { width: number; height: number } {
  const longest = Math.max(width, height);
  if (longest <= maxEdge) return { width, height };
  const scale = maxEdge / longest;
  return {
    width: Math.max(1, Math.round(width * scale)),
    height: Math.max(1, Math.round(height * scale)),
  };
}

export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

export function dataUrlBytes(dataUrl: string): number {
  const comma = dataUrl.indexOf(",");
  if (comma === -1) return 0;
  const base64 = dataUrl.slice(comma + 1);
  return Math.floor((base64.length * 3) / 4);
}

export async function readTextAttachment(file: File): Promise<string> {
  if (file.size > MAX_TEXT_BYTES) {
    throw new Error(`Text file exceeds maximum size of ${formatBytes(MAX_TEXT_BYTES)}`);
  }
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result ?? ""));
    reader.onerror = () => reject(new Error(`Failed to read file ${file.name}`));
    reader.readAsText(file);
  });
}

export async function readImageAttachment(file: File): Promise<string> {
  const objectUrl = URL.createObjectURL(file);
  try {
    const img = await new Promise<HTMLImageElement>((resolve, reject) => {
      const image = new Image();
      image.onload = () => resolve(image);
      image.onerror = () => reject(new Error(`Failed to decode image ${file.name}`));
      image.src = objectUrl;
    });

    const { width, height } = fitWithin(img.naturalWidth, img.naturalHeight, MAX_IMAGE_EDGE);
    const canvas = document.createElement("canvas");
    canvas.width = width;
    canvas.height = height;

    const ctx = canvas.getContext("2d");
    if (!ctx) throw new Error("Canvas 2D context unavailable");
    ctx.drawImage(img, 0, 0, width, height);

    const format = file.type === "image/png" ? "image/png" : "image/jpeg";
    const quality = format === "image/jpeg" ? 0.85 : undefined;
    const dataUrl = canvas.toDataURL(format, quality);

    if (dataUrlBytes(dataUrl) > MAX_IMAGE_BYTES) {
      throw new Error(`Encoded image exceeds maximum size of ${formatBytes(MAX_IMAGE_BYTES)}`);
    }

    return dataUrl;
  } finally {
    URL.revokeObjectURL(objectUrl);
  }
}

export function inlineTextAttachment(name: string, text: string): string {
  const ext = fileExtension(name);
  const lang = ext === "md" || ext === "markdown" ? "markdown" : ext === "json" ? "json" : ext === "csv" ? "csv" : "text";
  return `\n\n[File: ${name}]\n\`\`\`${lang}\n${text.trimEnd()}\n\`\`\``;
}

export function composePromptWithAttachments(
  text: string,
  attachments: readonly Attachment[],
): string {
  let result = text;
  for (const att of attachments) {
    if (att.kind === "text" && att.text) {
      result += inlineTextAttachment(att.name, att.text);
    }
  }
  return result;
}

export function attachmentImages(attachments: readonly Attachment[]): readonly string[] {
  return attachments
    .filter((a): a is Attachment & { dataUrl: string } => a.kind === "image" && typeof a.dataUrl === "string")
    .map((a) => a.dataUrl);
}
