import {
  type AssistantMessage,
  type ContentBlock,
  isToolUseBlock,
  type JsonSchema,
} from "./anthropic.js";
import { type ToolUseValidator } from "./validator.js";
import { type Reshaper } from "./reshaper.js";

export type RepairOutcome =
  | "fixed" // reshaped and now valid
  | "failed" // reshaper could not produce a valid message within maxAttempts
  | "refused" // reshaper declined (ambiguous intent)
  | "refused_destructive"; // a failing call targeted a destructive tool — not reshaped

export interface RepairDecision {
  outcome: RepairOutcome;
  message?: AssistantMessage;
}

export interface RepairDeps {
  validator: ToolUseValidator;
  reshaper: Reshaper;
  maxAttempts: number;
  isDestructive: (toolName: string) => boolean;
  /**
   * The model that actually SERVED the failing response, reported to the reshaper
   * so it can see which backend produced the malformed call. Optional because the
   * caller owns target resolution; absent ⇒ null (unknown), never a guess.
   */
  backendModel?: string | null;
}

/**
 * Attempt to repair an invalid tool-bearing assistant message. Safety-first:
 * if ANY tool_use in the (invalid) response targets a destructive tool, we
 * REFUSE rather than fabricate its arguments — because repair output may run
 * under --dangerously-skip-permissions. Otherwise reshape ≤ maxAttempts,
 * re-validating each attempt; a reshape that doesn't validate is never emitted.
 *
 * Every reshaper answer additionally passes `guardReshaped()` before it can be
 * emitted, so the safety verdict is taken on what we are about to RETURN, not
 * only on what the backend sent.
 */
export async function repair(
  assistant: AssistantMessage,
  tools: Map<string, JsonSchema | null>,
  deps: RepairDeps,
): Promise<RepairDecision> {
  const destructiveHit = assistant.content
    .filter(isToolUseBlock)
    .some((b) => deps.isDestructive(b.name));
  if (destructiveHit) {
    return { outcome: "refused_destructive" };
  }

  let errors = deps.validator.validate(assistant, tools).errors;
  let current = assistant;

  // A stop_reason mismatch is PURE protocol form: the message carries tool_use
  // blocks but announces some other stop_reason, so the harness never runs the
  // tool. Fixing it needs no model — it is fully determined by the content — so
  // do it here rather than paying a reshaper round-trip that also ships this
  // request's tool schemas and arguments to another provider.
  if (errors.length > 0 && errors.every((e) => e.kind === "stop_reason_mismatch")) {
    const normalized: AssistantMessage = { ...assistant, stop_reason: "tool_use" };
    const recheck = deps.validator.validate(normalized, tools);
    if (recheck.valid) return { outcome: "fixed", message: normalized };
    errors = recheck.errors;
    current = normalized;
  }

  for (let attempt = 0; attempt < deps.maxAttempts; attempt++) {
    let result;
    try {
      result = await deps.reshaper.reshape({
        tools,
        rawAssistant: current,
        errors,
        backendModel: deps.backendModel ?? null,
      });
    } catch {
      // Transport-level failure (single reshaper down, or every failover candidate down).
      // Nothing answered — not a refusal, but nothing to retry against either: fail clean.
      return { outcome: "failed" };
    }
    if (result.kind === "refuse") return { outcome: "refused" };

    const guard = guardReshaped(assistant, result.message, deps.isDestructive);
    if (guard !== null) return { outcome: guard };

    const check = deps.validator.validate(result.message, tools);
    if (check.valid) return { outcome: "fixed", message: result.message };
    // Feed the new errors back into the next attempt.
    errors = check.errors;
    current = result.message;
  }
  return { outcome: "failed" };
}

/**
 * The post-reshape safety gate, taken on the message we are about to emit.
 *
 * Two checks, both PURE FORM — no reading of what the arguments mean:
 *
 *  1. **Destructive names.** The pre-check only sees what the BACKEND sent. A
 *     `Reshaper` is an interface, so `repair()` cannot assume the in-tree
 *     `reconstruct()` (which happens to map only `input`) is the implementation
 *     on the other side of the call. The boundary function must check what it
 *     returns, not trust a collaborator's internals.
 *  2. **Structural conservation.** The reshaper's contract is corrected
 *     ARGUMENTS per tool_use id — nothing else. So the block count, the block
 *     order, every non-tool block, and every tool_use's (id, name) must survive
 *     unchanged. Anything else is a contract violation, not a repair: an added
 *     tool_use is a fabricated call, a renamed one is a redirected call, and a
 *     rewritten text block is content the client never saw the backend produce.
 *     A violating message is dropped whole (fail clean) and never fed back into
 *     the next attempt.
 *
 * Deliberately NOT checked: whether a permitted tool's repaired arguments *mean*
 * something destructive (`{"command":"rm -rf /"}` on an allowed shell tool).
 * Deciding that is judgement about argument semantics, which is the one thing
 * this proxy does not do — it would take a hardcoded content blocklist (breaking
 * provider/tool agnosticism), it is trivially evaded by quoting or encoding, and
 * its false positives refuse legitimate calls. The argument-level protections
 * that ARE form — the args still satisfy the tool's declared JSON Schema, and no
 * call may be added, dropped or re-pointed — are enforced here and by the
 * validator. A tool whose arguments must not be model-authored belongs in
 * `repair.destructiveTools`, where the refusal is unconditional.
 *
 * Returns the outcome to fail with, or null when the message may proceed.
 */
export function guardReshaped(
  original: AssistantMessage,
  candidate: AssistantMessage,
  isDestructive: (toolName: string) => boolean,
): "refused_destructive" | "failed" | null {
  const blocks = Array.isArray(candidate.content) ? candidate.content : [];
  if (blocks.filter(isToolUseBlock).some((b) => isDestructive(b.name))) {
    return "refused_destructive";
  }
  return conservesStructure(original, candidate) ? null : "failed";
}

/** True when `candidate` differs from `original` only in tool_use inputs (and stop_reason). */
function conservesStructure(original: AssistantMessage, candidate: AssistantMessage): boolean {
  const before: ContentBlock[] = Array.isArray(original.content) ? original.content : [];
  const after: ContentBlock[] = Array.isArray(candidate.content) ? candidate.content : [];
  if (before.length !== after.length) return false;
  for (let i = 0; i < before.length; i++) {
    const a = before[i];
    const b = after[i];
    if (a === undefined || b === undefined) return false;
    const aTool = isToolUseBlock(a);
    const bTool = isToolUseBlock(b);
    if (aTool !== bTool) return false;
    if (aTool && bTool) {
      if (a.id !== b.id || a.name !== b.name) return false;
      continue;
    }
    if (stableStringify(a) !== stableStringify(b)) return false;
  }
  return true;
}

/** Order-independent structural key, so a re-serialized block still compares equal. */
function stableStringify(v: unknown): string {
  if (v === null || typeof v !== "object") return JSON.stringify(v) ?? "undefined";
  if (Array.isArray(v)) return `[${v.map(stableStringify).join(",")}]`;
  const keys = Object.keys(v as Record<string, unknown>).sort();
  return `{${keys
    .map((k) => `${JSON.stringify(k)}:${stableStringify((v as Record<string, unknown>)[k])}`)
    .join(",")}}`;
}

/**
 * Build a destructive-tool matcher.
 *
 * Matching is EXACT on the tool name (case-insensitively), not substring.
 * Substring matching was wrong in both directions at once: none of the default
 * patterns ("rm", "delete", "remove", …) occur in the harness's actual
 * destructive tools — Bash, Write, Edit, MultiEdit, NotebookEdit, BashOutput —
 * so the check that guards "never fabricate a destructive call" did not cover
 * the tools that can actually destroy anything; meanwhile "push" matched
 * PushNotification and "reset" matched ResetZoom, refusing safe calls.
 *
 * A pattern ending in `*` is still a prefix match, so a config can opt into
 * families (`git_*`) deliberately rather than by accident.
 */
export function destructiveMatcher(namePatterns: string[]): (name: string) => boolean {
  const exact = new Set<string>();
  const prefixes: string[] = [];
  for (const p of namePatterns) {
    const low = p.toLowerCase();
    if (low.endsWith("*")) prefixes.push(low.slice(0, -1));
    else exact.add(low);
  }
  return (name: string) => {
    const n = name.toLowerCase();
    if (exact.has(n)) return true;
    return prefixes.some((p) => p.length > 0 && n.startsWith(p));
  };
}
