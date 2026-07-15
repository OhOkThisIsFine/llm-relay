import { DEFAULT_ANTHROPIC_VERSION } from "./config.js";
import { type AssistantMessage, type JsonSchema, isToolUseBlock } from "./anthropic.js";
import { type ValidationError } from "./validator.js";

export interface ReshapeRequest {
  /** The declared tools (name → schema|null) so the reshaper knows the contract. */
  tools: Map<string, JsonSchema | null>;
  /** The backend's failing assistant message. */
  rawAssistant: AssistantMessage;
  /** Why it failed validation. */
  errors: ValidationError[];
  backendModel: string | null;
}

export type ReshapeResult =
  | { kind: "message"; message: AssistantMessage }
  | { kind: "refuse"; reason: string };

export interface Reshaper {
  reshape(req: ReshapeRequest): Promise<ReshapeResult>;
}

/**
 * The reshaper only has to produce the corrected ARGUMENTS per tool-call id — NOT
 * the whole Anthropic content envelope. This drastically lowers the formatting
 * burden on weaker reshaper models (empirically far more reliable than asking
 * them to regenerate the full message), and the proxy reconstructs the message.
 */
const SYSTEM_PROMPT = `You fix the ARGUMENTS of malformed tool calls so they satisfy a given JSON schema.

RULES:
- Preserve the model's EXPRESSED intent. Reconstruct arguments ONLY from what is present in the malformed call — do NOT invent values.
- If you cannot fix a call without guessing, refuse.
- Output ONLY one raw JSON object (no prose, no markdown fences), mapping each tool_use id to its corrected "input" object:
  {"inputs": {"<tool_use_id>": { ...corrected input satisfying the schema... }}}
  or, if you must guess: {"refuse": true, "reason": "<why>"}`;

function buildUserContent(req: ReshapeRequest): string {
  const toolList = [...req.tools.entries()].map(([name, input_schema]) => ({ name, input_schema }));
  const failing = req.rawAssistant.content
    .filter(isToolUseBlock)
    .map((b) => ({ id: b.id, name: b.name, current_input: b.input }));
  return JSON.stringify(
    {
      tools: toolList,
      failing_tool_calls: failing,
      validation_errors: req.errors.map((e) => ({ tool: e.tool, message: e.message })),
    },
    null,
    2,
  );
}

export type CorrectedInputs =
  | { kind: "inputs"; inputs: Record<string, unknown> }
  | { kind: "refuse"; reason: string };

/** Parse the reshaper model's text into a per-id corrected-inputs map. */
export function parseCorrectedInputs(text: string): CorrectedInputs {
  const json = extractJson(text);
  if (typeof json !== "object" || json === null) {
    return { kind: "refuse", reason: "reshaper returned no parseable JSON" };
  }
  const obj = json as Record<string, unknown>;
  if (obj.refuse === true) {
    return { kind: "refuse", reason: typeof obj.reason === "string" ? obj.reason : "refused" };
  }
  if (typeof obj.inputs === "object" && obj.inputs !== null) {
    return { kind: "inputs", inputs: obj.inputs as Record<string, unknown> };
  }
  return { kind: "refuse", reason: "reshaper output was not a recognized shape" };
}

/** Rebuild the assistant message, replacing each failing tool_use's input by id. */
export function reconstruct(raw: AssistantMessage, inputs: Record<string, unknown>): AssistantMessage {
  const content = raw.content.map((b) =>
    isToolUseBlock(b) && Object.prototype.hasOwnProperty.call(inputs, b.id)
      ? { ...b, input: inputs[b.id] }
      : b,
  );
  return { content, stop_reason: raw.stop_reason ?? "tool_use" };
}

/** Reshaper backed by an Anthropic- or OpenAI-compatible endpoint. */
export class HttpReshaper implements Reshaper {
  constructor(
    private readonly cfg: {
      base: string;
      model: string;
      kind: "anthropic" | "openai";
      authEnv?: string;
      authHeader: "x-api-key" | "authorization";
      timeoutMs: number;
    },
    private readonly fetchFn: typeof fetch = fetch,
  ) {}

  async reshape(req: ReshapeRequest): Promise<ReshapeResult> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.cfg.timeoutMs);
    try {
      const headers: Record<string, string> = { "content-type": "application/json" };
      const key = this.cfg.authEnv ? process.env[this.cfg.authEnv]?.trim() : undefined;
      if (key) {
        if (this.cfg.authHeader === "authorization") headers["authorization"] = `Bearer ${key}`;
        else headers["x-api-key"] = key;
      }
      const userContent = buildUserContent(req);

      const { url, body } =
        this.cfg.kind === "openai"
          ? {
              url: `${this.cfg.base}/chat/completions`,
              body: {
                model: this.cfg.model,
                max_tokens: 1024,
                messages: [
                  { role: "system", content: SYSTEM_PROMPT },
                  { role: "user", content: userContent },
                ],
              },
            }
          : {
              url: `${this.cfg.base}/v1/messages`,
              body: {
                model: this.cfg.model,
                max_tokens: 1024,
                system: SYSTEM_PROMPT,
                messages: [{ role: "user", content: userContent }],
              },
            };
      if (this.cfg.kind === "anthropic") headers["anthropic-version"] = DEFAULT_ANTHROPIC_VERSION;

      const res = await this.fetchFn(url, {
        method: "POST",
        headers,
        body: JSON.stringify(body),
        signal: controller.signal,
      });
      if (!res.ok) return { kind: "refuse", reason: `reshaper HTTP ${res.status}` };
      const json = (await res.json()) as Record<string, unknown>;
      const text = this.cfg.kind === "openai" ? openaiText(json) : anthropicText(json);
      const parsed = parseCorrectedInputs(text);
      if (parsed.kind === "refuse") return { kind: "refuse", reason: parsed.reason };
      return { kind: "message", message: reconstruct(req.rawAssistant, parsed.inputs) };
    } catch (e) {
      return { kind: "refuse", reason: `reshaper error: ${(e as Error).message}` };
    } finally {
      clearTimeout(timer);
    }
  }
}

function anthropicText(json: Record<string, unknown>): string {
  const content = (json.content as Array<{ type?: string; text?: string }> | undefined) ?? [];
  return content.filter((b) => b.type === "text" && typeof b.text === "string").map((b) => b.text as string).join("");
}

function openaiText(json: Record<string, unknown>): string {
  const choices = (json.choices as Array<{ message?: { content?: unknown } }> | undefined) ?? [];
  const c = choices[0]?.message?.content;
  return typeof c === "string" ? c : "";
}

function extractJson(text: string): unknown {
  const trimmed = text.trim();
  const candidates: string[] = [];
  const fence = /```(?:json)?\s*([\s\S]*?)```/i.exec(trimmed);
  if (fence?.[1]) candidates.push(fence[1].trim());
  candidates.push(trimmed);
  const start = trimmed.indexOf("{");
  const end = trimmed.lastIndexOf("}");
  if (start !== -1 && end > start) candidates.push(trimmed.slice(start, end + 1));
  for (const c of candidates) {
    try {
      return JSON.parse(c);
    } catch {
      // try next candidate
    }
  }
  return undefined;
}
