import { DEFAULT_ANTHROPIC_VERSION } from "./config.js";
import { type AssistantMessage, type JsonSchema, isToolUseBlock } from "./anthropic.js";
import { type ValidationError } from "./validator.js";
import { buildAuthHeaders, type CredentialResolution } from "./authEnv.js";
import { createUsageAccumulator, observeUsage, type UsageAccumulator } from "./usage-observer.js";
import {
  CredentialLru,
  CredentialWalk,
  type CredentialWalkOptions,
  type CredentialWalkOutcome,
} from "./credential-select.js";
import type { ResolvedAttempt } from "./resolved-attempt.js";

export interface ReshapeRequest {
  /** The declared tools (name → schema|null) so the reshaper knows the contract. */
  tools: Map<string, JsonSchema | null>;
  /** The backend's failing assistant message. */
  rawAssistant: AssistantMessage;
  /** Why it failed validation. */
  errors: ValidationError[];
  backendModel: string | null;
  /** Caller response lifetime; deliberately distinct from this reshaper's timeout. */
  signal?: AbortSignal;
}

export type ReshapeResult =
  | { kind: "message"; message: AssistantMessage }
  | { kind: "refuse"; reason: string };

export interface Reshaper {
  reshape(req: ReshapeRequest, hooks?: ReshaperAccountingHooks): Promise<ReshapeResult>;
}

export interface ReshaperAccountingCompletion {
  readonly outcome: "success" | "error" | "cancelled";
  readonly failureKind: "timeout" | "provider_error" | "auth_error" | "rate_limit" | "aborted" | "protocol" | "unknown" | null;
  readonly usage: UsageAccumulator;
  readonly endedAt: number;
}

export interface ReshaperAccountingAttempt {
  /**
   * MUST be called exactly once, on EVERY exit path (success, refusal, transport
   * error, cancellation). A dropped handle leaves the server-side request
   * finalizer waiting on a still-active attempt, so the request never records
   * its `request-completed` event and stalls until store eviction.
   */
  complete(completion: ReshaperAccountingCompletion): void;
}

/**
 * Server-owned request accounting can observe real repair egress without
 * making the reusable reshaper depend on server lifecycle state.
 */
export interface ReshaperAccountingHooks {
  /**
   * The returned handle is load-bearing: it must be completed exactly once on
   * every exit path, or request finalization stalls until LRU eviction. Return
   * null only when no attempt was actually started.
   */
  startRepairAttempt(options: {
    readonly resolvedAttempt: ResolvedAttempt | null;
    readonly credentialState: CredentialResolution["state"];
    readonly provider: string | null;
    readonly model: string | null;
    readonly credentialId: string | null;
    readonly startedAt: number;
  }): ReshaperAccountingAttempt | null;
  /** A closed caller response must never start a late repair egress. */
  isRequestClosed?(): boolean;
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
export class ReshaperTransportError extends Error {
  readonly outcome: CredentialWalkOutcome;

  constructor(message: string, outcome: CredentialWalkOutcome = { kind: "provider-transport" }) {
    super(message);
    this.name = "ReshaperTransportError";
    this.outcome = Object.freeze({ ...outcome });
  }
}

export type CorrectedInputs =
  | { kind: "inputs"; inputs: Record<string, unknown> }
  | { kind: "refuse"; reason: string };

type ParsedCorrectedInputs = CorrectedInputs | { kind: "invalid"; reason: string };

/** Parse the reshaper model's text into a per-id corrected-inputs map. */
export function parseCorrectedInputs(text: string): CorrectedInputs {
  const parsed = parseCorrectedInputsWire(text);
  return parsed.kind === "invalid"
    ? { kind: "refuse", reason: parsed.reason }
    : parsed;
}

function parseCorrectedInputsWire(text: string): ParsedCorrectedInputs {
  const json = extractJson(text);
  if (typeof json !== "object" || json === null) {
    return { kind: "invalid", reason: "reshaper returned no parseable JSON" };
  }
  const obj = json as Record<string, unknown>;
  if (obj.refuse === true) {
    return { kind: "refuse", reason: typeof obj.reason === "string" ? obj.reason : "refused" };
  }
  if (typeof obj.inputs === "object" && obj.inputs !== null && !Array.isArray(obj.inputs)) {
    return { kind: "inputs", inputs: obj.inputs as Record<string, unknown> };
  }
  return { kind: "invalid", reason: "reshaper output was not a recognized shape" };
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

  async reshape(req: ReshapeRequest, hooks?: ReshaperAccountingHooks): Promise<ReshapeResult> {
    if (callerCancelled(req, hooks)) throw cancelledReshaperError();
    let lastError: Error | undefined;
    for (const d of this.delegates) {
      try {
        // A message OR a refusal is final — a refusal is a judgement, never shopped around.
        return await d.reshape(req, hooks);
      } catch (e) {
        if (callerCancelled(req, hooks) || (e instanceof ReshaperTransportError && e.outcome.kind === "cancelled")) {
          throw e;
        }
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

function reshaperAccountingFailure(
  error: unknown,
  timedOut: boolean,
): Pick<ReshaperAccountingCompletion, "outcome" | "failureKind"> {
  if (error instanceof ReshaperTransportError) {
    const { status, kind } = error.outcome;
    if (kind === "cancelled") return { outcome: "cancelled", failureKind: "aborted" };
    if (status === 401 || status === 403) return { outcome: "error", failureKind: "auth_error" };
    if (status === 429) return { outcome: "error", failureKind: "rate_limit" };
    if (kind === "timeout" || timedOut) return { outcome: "error", failureKind: "timeout" };
    if (kind === "protocol") return { outcome: "error", failureKind: "protocol" };
  }
  return { outcome: "error", failureKind: timedOut ? "timeout" : "provider_error" };
}

const MAX_REPAIR_ERROR_DRAIN_BYTES = 1024 * 1024;

function declaredContentLength(headers: Headers): number | undefined {
  const value = headers.get("content-length");
  if (value === null || !/^\d+$/.test(value)) return undefined;
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) ? parsed : undefined;
}

/**
 * Error bodies are never returned to the repair caller. Drain only enough to
 * let the usage observer finish a normal provider envelope, then release the
 * transport instead of retaining an unbounded hostile response in memory.
 */
async function drainRepairErrorResponse(response: Response): Promise<void> {
  const contentLength = declaredContentLength(response.headers);
  if (contentLength !== undefined && contentLength > MAX_REPAIR_ERROR_DRAIN_BYTES) {
    await response.body?.cancel().catch(() => {});
    return;
  }

  const reader = response.body?.getReader();
  if (!reader) return;

  let read = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) return;
      read += value.byteLength;
      if (read >= MAX_REPAIR_ERROR_DRAIN_BYTES) {
        await reader.cancel().catch(() => {});
        return;
      }
    }
  } catch {
    await reader.cancel().catch(() => {});
  } finally {
    reader.releaseLock();
  }
}

function callerCancelled(req: ReshapeRequest, hooks: ReshaperAccountingHooks | undefined): boolean {
  if (req.signal?.aborted === true) return true;
  try {
    return hooks?.isRequestClosed?.() === true;
  } catch {
    // A failing accounting observer remains strictly observational.
    return false;
  }
}

function cancelledReshaperError(): ReshaperTransportError {
  return new ReshaperTransportError("reshaper cancelled by caller", { kind: "cancelled" });
}

interface HttpReshaperConfig {
  base: string;
  model: string;
  kind: "anthropic" | "openai";
  /** Retained as non-secret topology metadata; HttpReshaper never resolves either field. */
  provider?: string;
  authEnv?: string;
  authHeader: "x-api-key" | "authorization";
  timeoutMs: number;
}

export class HttpReshaper implements Reshaper {
  constructor(
    private readonly cfg: HttpReshaperConfig,
    private readonly credential: CredentialResolution,
    private readonly fetchFn: typeof fetch = fetch,
    private readonly beforeFetch?: () => void,
    private readonly resolvedAttempt: ResolvedAttempt | null = null,
  ) {}

  async reshape(req: ReshapeRequest, hooks?: ReshaperAccountingHooks): Promise<ReshapeResult> {
    const throwIfCallerCancelled = (): void => {
      if (callerCancelled(req, hooks)) throw cancelledReshaperError();
    };
    throwIfCallerCancelled();
    if (this.credential.state === "declared-missing") {
      throw new ReshaperTransportError(
        `reshaper credential ${this.credential.envName ?? "<unknown>"} is not configured`,
        { kind: "local" },
      );
    }

    const controller = new AbortController();
    let timedOut = false;
    const abortFromCaller = () => controller.abort();
    req.signal?.addEventListener("abort", abortFromCaller, { once: true });
    const timer = setTimeout(() => {
      timedOut = true;
      controller.abort();
    }, this.cfg.timeoutMs);
    const usage = createUsageAccumulator();
    let accountingAttempt: ReshaperAccountingAttempt | null = null;
    let accountingCompletion: Pick<ReshaperAccountingCompletion, "outcome" | "failureKind"> = {
      outcome: "error",
      failureKind: "unknown",
    };
    try {
      const headers: Record<string, string> = {
        "content-type": "application/json",
        ...buildAuthHeaders(this.credential.value, this.cfg.authHeader),
      };
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

      // This hook is the sole CredentialWalk start/LRU boundary. Everything above is local
      // preparation and a declared-missing credential returned before reaching it.
      const bodyText = JSON.stringify(body);
      throwIfCallerCancelled();
      this.beforeFetch?.();
      throwIfCallerCancelled();
      const egressAt = Date.now();
      throwIfCallerCancelled();
      try {
        accountingAttempt = hooks?.startRepairAttempt({
          resolvedAttempt: this.resolvedAttempt,
          credentialState: this.credential.state,
          provider: this.resolvedAttempt?.target.provider ?? null,
          model: this.resolvedAttempt?.target.model ?? this.cfg.model,
          credentialId: this.resolvedAttempt?.credentialId ?? null,
          startedAt: egressAt,
        }) ?? null;
      } catch {
        accountingAttempt = null;
      }
      throwIfCallerCancelled();
      let res: Response;
      try {
        throwIfCallerCancelled();
        res = await this.fetchFn(url, {
        method: "POST",
        headers,
        body: bodyText,
        signal: controller.signal,
      });
    } catch (e) {
      throw new ReshaperTransportError(
        `reshaper unreachable: ${(e as Error).message}`,
        { kind: callerCancelled(req, hooks) ? "cancelled" : timedOut ? "timeout" : "provider-transport" },
      );
    }
    const declaredErrorLength = !res.ok ? declaredContentLength(res.headers) : undefined;
    if (declaredErrorLength !== undefined && declaredErrorLength > MAX_REPAIR_ERROR_DRAIN_BYTES) {
      await res.body?.cancel().catch(() => {});
      throwIfCallerCancelled();
      throw new ReshaperTransportError(`reshaper HTTP ${res.status}`, { status: res.status });
    }
    res = observeUsage(
      res,
      this.cfg.kind === "openai" ? "openai-chat" : "anthropic-messages",
      usage,
    );
    if (!res.ok) {
      // Consume the bounded error response so any provider-reported usage is
      // observed before the terminal accounting event. The body was previously
      // discarded, so this does not change caller-visible repair semantics.
      await drainRepairErrorResponse(res);
      throwIfCallerCancelled();
      throw new ReshaperTransportError(`reshaper HTTP ${res.status}`, { status: res.status });
    }

    let json: Record<string, unknown>;
    try {
      json = (await res.json()) as Record<string, unknown>;
    } catch (e) {
      throw new ReshaperTransportError(
        `reshaper returned non-JSON: ${(e as Error).message}`,
        { kind: callerCancelled(req, hooks) ? "cancelled" : timedOut ? "timeout" : "protocol" },
      );
    }
      try {
        const text = this.cfg.kind === "openai" ? openaiText(json) : anthropicText(json);
        const parsed = parseCorrectedInputsWire(text);
        if (parsed.kind === "invalid") throw new Error(parsed.reason);
      // Accounted as SUCCESS deliberately: tokens were really spent on this egress.
      // "refuse" here means the repair model declined the task, not that no call
      // happened — do not "fix" this into an error outcome.
      accountingCompletion = { outcome: "success", failureKind: null };
      if (parsed.kind === "refuse") return { kind: "refuse", reason: parsed.reason };
      return { kind: "message", message: reconstruct(req.rawAssistant, parsed.inputs) };
      } catch (e) {
        throw new ReshaperTransportError(
          `reshaper returned malformed response: ${(e as Error).message}`,
          { kind: "protocol" },
        );
      }
    } catch (error) {
      accountingCompletion = reshaperAccountingFailure(error, timedOut);
      throw error;
    } finally {
      if (accountingAttempt !== null) {
        try {
          accountingAttempt.complete({ ...accountingCompletion, usage, endedAt: Date.now() });
        } catch {
          // Accounting observers must never alter repair failure handling.
        }
      }
      clearTimeout(timer);
      req.signal?.removeEventListener("abort", abortFromCaller);
    }
  }
}

/** Request-local, fleet-aware reshaper selection using the shared credential walk policy. */
export class CredentialWalkReshaper implements Reshaper {
  private readonly walk: CredentialWalk;
  private readonly lru: CredentialLru;
  /**
   * A recognized reshaper response proves this credential can egress, but only `repair()` can
   * decide whether the corrected message satisfies the caller's schema. Keep that attempt pending
   * so a semantic retry reuses it; only a later transport outcome may advance the same walk.
   */
  private pinnedAttempt: ResolvedAttempt | undefined;

  constructor(
    attempts: readonly ResolvedAttempt[],
    walkOptions: CredentialWalkOptions = {},
    private readonly fetchFn: typeof fetch = fetch,
  ) {
    this.lru = walkOptions.lru ?? new CredentialLru();
    this.walk = new CredentialWalk(attempts, { ...walkOptions, lru: this.lru });
  }

  async reshape(req: ReshapeRequest, hooks?: ReshaperAccountingHooks): Promise<ReshapeResult> {
    if (callerCancelled(req, hooks)) throw cancelledReshaperError();
    let lastError: ReshaperTransportError | undefined;

    for (let attempt = this.pinnedAttempt ?? this.walk.next(); attempt; attempt = this.walk.next()) {
      const { target } = attempt;
      if (target.model === undefined || attempt.credential.state === "declared-missing") {
        this.walk.recordRejected(attempt);
        continue;
      }

      const alreadyStarted = this.pinnedAttempt === attempt;

      const reshaper = new HttpReshaper(
        {
          base: target.base,
          model: target.model,
          kind: target.kind,
          authHeader: target.authHeader,
          timeoutMs: target.timeoutMs,
        },
        attempt.credential,
        this.fetchFn,
      () => {
        if (alreadyStarted) this.lru.touch(attempt.credentialId);
        else this.walk.recordStarted(attempt);
      },
      attempt,
    );

      try {
        // A message OR refusal is terminal. Shopping a refusal is never allowed.
        const result = await reshaper.reshape(req, hooks);
        // Do not close the walk yet: a `message` is only wire-valid here. If `repair()` rejects its
        // corrected arguments and calls us again, the same credential remains authoritative.
        this.pinnedAttempt = attempt;
        return result;
      } catch (e) {
        if (callerCancelled(req, hooks) || (e instanceof ReshaperTransportError && e.outcome.kind === "cancelled")) {
          throw e;
        }
        const error = e instanceof ReshaperTransportError
          ? e
          : new ReshaperTransportError(
            `reshaper returned malformed response: ${(e as Error).message}`,
            { kind: "protocol" },
          );
        this.walk.record(attempt, error.outcome);
        this.pinnedAttempt = undefined;
        lastError = error;
      }
    }

    throw new ReshaperTransportError(
      lastError
        ? `all reshaper candidates failed to respond (last: ${lastError.message})`
        : "all reshaper candidates failed to respond (no usable credential)",
      lastError?.outcome ?? { kind: "local" },
    );
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
