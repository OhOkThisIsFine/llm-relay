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

/**
 * Build the reshaper prompt body.
 *
 * A reshape is a cross-provider egress: the failing call's ARGUMENTS and the tool
 * SCHEMAS leave for whatever provider `config.reshaper` names, which is often not
 * the provider that served the response. That is inherent — a model cannot correct
 * arguments it is not shown — so the mitigation is minimisation, not avoidance:
 * only the schemas of tools actually NAMED by a failing call are sent, instead of
 * the request's entire declared tool set (a Claude Code session declares dozens,
 * none of which the reshaper needs to fix one call). Destructive calls never get
 * here at all: `repair()` refuses them before the reshaper is asked.
 */
export function buildUserContent(req: ReshapeRequest): string {
  const failingBlocks = req.rawAssistant.content.filter(isToolUseBlock);
  const named = new Set(failingBlocks.map((b) => b.name));
  const relevant = [...req.tools.entries()].filter(([name]) => named.has(name));
  // Fall back to the full set only when nothing matched (e.g. a hallucinated tool
  // name), so the reshaper still sees the contract it is being asked to satisfy.
  const chosen = relevant.length > 0 ? relevant : [...req.tools.entries()];
  const toolList = chosen.map(([name, input_schema]) => ({ name, input_schema }));
  const failing = failingBlocks.map((b) => ({ id: b.id, name: b.name, current_input: b.input }));
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

/**
 * A transport-level reshaper failure: network error, timeout, non-2xx HTTP, unparseable
 * HTTP body. The model never rendered a judgement, so failover MAY try another candidate.
 * Distinct from a `refuse` result, which is a judgement and must never be shopped around.
 */
export class ReshaperTransportError extends Error {}

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

/**
 * Rebuild the assistant message, replacing each failing tool_use's input by id.
 *
 * Only `input` is ever taken from the reshaper — ids, names, block order and every
 * non-tool block come from `raw`, so a reshaper cannot add, drop or re-point a call.
 * `stop_reason` is normalised to "tool_use" whenever the rebuilt content bears a
 * tool_use block: that is protocol form the content fully determines (the harness
 * will not execute a tool announced under "end_turn"), and preserving the backend's
 * wrong value here made an otherwise-repaired message fail re-validation and burn
 * every remaining attempt.
 *
 * ⚠ Everything else is CARRIED OVER from `raw` — `id`, `model`, `stop_sequence`, `usage`.
 * This function returned only `{ content, stop_reason }`, so a message that went through
 * repair reached `emitSse` stripped of the backend's own identity and got a synthesized id
 * and no usage, while a message that merely passed validation kept both. Repair must not be
 * observable in the response envelope; the only field it is allowed to change is the one it
 * repaired. Absent fields stay absent — nothing here invents an id or zero-fills usage.
 */
export function reconstruct(raw: AssistantMessage, inputs: Record<string, unknown>): AssistantMessage {
  const content = raw.content.map((b) =>
    isToolUseBlock(b) && Object.prototype.hasOwnProperty.call(inputs, b.id)
      ? { ...b, input: inputs[b.id] }
      : b,
  );
  const stop_reason = content.some(isToolUseBlock) ? "tool_use" : raw.stop_reason ?? "tool_use";
  return { ...raw, content, stop_reason };
}

/** Reshaper backed by an Anthropic- or OpenAI-compatible endpoint. */
/**
 * Tries several reshapers in ranked order so repair does not depend on one model staying servable.
 *
 * Only *transport* failures advance to the next candidate. A reshaper that answers with `refuse`
 * is a real judgement — the model looked at the call and declined to guess — so it is returned
 * as-is. Retrying a refusal on another model would be shopping for a more compliant answer, which
 * is exactly how a fabricated tool call gets through.
 *
 * Exhausting every candidate THROWS `ReshaperTransportError` for the same reason: nobody answered,
 * so there is no judgement to report. Returning `refuse` there re-crossed the one line this class
 * exists to hold — it labelled a total outage as a model's decision, and `repair()` logged the
 * turn as `refused` (a model declined) rather than `failed` (nothing was reachable).
 */
export class FailoverReshaper implements Reshaper {
  constructor(private readonly delegates: Reshaper[]) {
    if (delegates.length === 0) throw new Error("FailoverReshaper needs at least one delegate");
  }

  async reshape(req: ReshapeRequest): Promise<ReshapeResult> {
    let lastError: Error | undefined;
    for (const d of this.delegates) {
      try {
        // A message OR a refusal is final — a refusal is a judgement, never shopped around.
        return await d.reshape(req);
      } catch (e) {
        // transport/HTTP failure (model de-listed, 5xx, timeout) — try the next candidate
        lastError = e as Error;
        continue;
      }
    }
    throw new ReshaperTransportError(
      `all reshaper candidates failed to respond${lastError ? ` (last: ${lastError.message})` : ""}`,
    );
  }
}

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

      // Transport-level failures THROW (ReshaperTransportError) rather than returning a
      // refusal: a refusal is a model's judgement, and FailoverReshaper advances only on
      // throws — reporting "connection refused" as `refuse` silently disabled failover.
      let res: Response;
      try {
        res = await this.fetchFn(url, {
          method: "POST",
          headers,
          body: JSON.stringify(body),
          signal: controller.signal,
        });
      } catch (e) {
        throw new ReshaperTransportError(`reshaper unreachable: ${(e as Error).message}`);
      }
      if (!res.ok) throw new ReshaperTransportError(`reshaper HTTP ${res.status}`);
      let json: Record<string, unknown>;
      try {
        json = (await res.json()) as Record<string, unknown>;
      } catch (e) {
        throw new ReshaperTransportError(`reshaper returned non-JSON: ${(e as Error).message}`);
      }
      const text = this.cfg.kind === "openai" ? openaiText(json) : anthropicText(json);
      const parsed = parseCorrectedInputs(text);
      if (parsed.kind === "refuse") return { kind: "refuse", reason: parsed.reason };
      return { kind: "message", message: reconstruct(req.rawAssistant, parsed.inputs) };
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
