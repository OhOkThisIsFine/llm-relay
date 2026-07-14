import { DEFAULT_ANTHROPIC_VERSION } from "./config.js";
import { type AssistantMessage, type JsonSchema } from "./anthropic.js";
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

const SYSTEM_PROMPT = `You repair malformed tool calls emitted by another model so they conform to the Anthropic tool-use protocol.

RULES (critical):
- Preserve the model's EXPRESSED intent exactly. Do NOT add, remove, or change which tool or action was intended.
- Produce tool_use blocks whose "input" satisfies the given input_schema, reconstructing arguments ONLY from what is unambiguously present in the raw response.
- If the intended tool/arguments are NOT unambiguously present, or you would have to guess, do NOT guess.
- Output ONLY a single JSON object, no prose, in one of these two shapes:
  {"content":[<content blocks>],"stop_reason":"tool_use"}
  {"refuse":true,"reason":"<why>"}
- A valid tool_use block is {"type":"tool_use","id":"<id>","name":"<tool>","input":{...}}. Keep the original id when present.`;

function buildUserContent(req: ReshapeRequest): string {
  const toolList = [...req.tools.entries()].map(([name, schema]) => ({
    name,
    input_schema: schema,
  }));
  return JSON.stringify(
    {
      tools: toolList,
      validation_errors: req.errors.map((e) => ({ tool: e.tool, kind: e.kind, message: e.message })),
      raw_assistant_message: req.rawAssistant,
    },
    null,
    2,
  );
}

/** Parse the reshaper model's text output into a ReshapeResult. */
export function parseReshapeOutput(text: string): ReshapeResult {
  const json = extractJson(text);
  if (json === undefined) return { kind: "refuse", reason: "reshaper returned no parseable JSON" };
  if (typeof json === "object" && json !== null) {
    const obj = json as Record<string, unknown>;
    if (obj.refuse === true) {
      return { kind: "refuse", reason: typeof obj.reason === "string" ? obj.reason : "refused" };
    }
    if (Array.isArray(obj.content)) {
      return {
        kind: "message",
        message: {
          content: obj.content as AssistantMessage["content"],
          stop_reason: (obj.stop_reason ?? "tool_use") as AssistantMessage["stop_reason"],
        },
      };
    }
  }
  return { kind: "refuse", reason: "reshaper output was not a recognized shape" };
}

/** Reshaper backed by an Anthropic-Messages-compatible endpoint. */
export class HttpReshaper implements Reshaper {
  constructor(
    private readonly cfg: {
      base: string;
      model: string;
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
      const headers: Record<string, string> = {
        "content-type": "application/json",
        "anthropic-version": DEFAULT_ANTHROPIC_VERSION,
      };
      const key = this.cfg.authEnv ? process.env[this.cfg.authEnv]?.trim() : undefined;
      if (key) {
        if (this.cfg.authHeader === "authorization") headers["authorization"] = `Bearer ${key}`;
        else headers["x-api-key"] = key;
      }
      const res = await this.fetchFn(`${this.cfg.base}/v1/messages`, {
        method: "POST",
        headers,
        body: JSON.stringify({
          model: this.cfg.model,
          max_tokens: 4096,
          system: SYSTEM_PROMPT,
          messages: [{ role: "user", content: buildUserContent(req) }],
        }),
        signal: controller.signal,
      });
      if (!res.ok) return { kind: "refuse", reason: `reshaper HTTP ${res.status}` };
      const body = (await res.json()) as { content?: Array<{ type?: string; text?: string }> };
      const text = (body.content ?? [])
        .filter((b) => b.type === "text" && typeof b.text === "string")
        .map((b) => b.text as string)
        .join("");
      return parseReshapeOutput(text);
    } catch (e) {
      return { kind: "refuse", reason: `reshaper error: ${(e as Error).message}` };
    } finally {
      clearTimeout(timer);
    }
  }
}

function extractJson(text: string): unknown {
  const trimmed = text.trim();
  try {
    return JSON.parse(trimmed);
  } catch {
    // Tolerate fenced or prose-wrapped JSON: grab the outermost {...}.
    const start = trimmed.indexOf("{");
    const end = trimmed.lastIndexOf("}");
    if (start !== -1 && end > start) {
      try {
        return JSON.parse(trimmed.slice(start, end + 1));
      } catch {
        return undefined;
      }
    }
    return undefined;
  }
}
