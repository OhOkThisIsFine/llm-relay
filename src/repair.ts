import {
  type AssistantMessage,
  type ContentBlock,
  isToolUseBlock,
  type JsonSchema,
} from "./anthropic.js";
import { stableStringify, type ToolUseValidator } from "./validator.js";
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

  const initialValidation = deps.validator.validate(assistant, tools);
  let errors = initialValidation.errors;
  let current = assistant;

  // A reshaper cannot make an uncheckable schema checkable. Sending arguments
  // to another model here would spend a repair attempt whose output can never
  // cross the validation boundary, so fail closed without any delegate egress.
  if (initialValidation.uncheckableCount > 0) {
    return { outcome: "failed" };
  }

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
    if (check.valid) return { outcome: "fixed", message: withEnvelopeOf(assistant, result.message) };
    // Feed the new errors back into the next attempt.
    errors = check.errors;
    current = result.message;
  }
  return { outcome: "failed" };
}

/**
 * Re-attach the BACKEND's response envelope to a repaired message.
 *
 * `id`, `model`, `stop_sequence` and `usage` identify the response the client is receiving —
 * they belong to the backend that produced it, and a repair changes the tool arguments, not
 * whose answer this is. Taken unconditionally from the original for the same reason
 * `guardReshaped` re-checks the output rather than trusting the reshaper: `Reshaper` is an
 * interface, so this function cannot assume the in-tree implementation. One that dropped these
 * fields left the response to be re-serialized under a synthesized id with no token counts;
 * one that filled them from its OWN completion would report the repair model's identity and
 * token usage as the serving model's, which is worse — the client would meter and attribute
 * the turn to a model that never answered it.
 *
 * `content` and `stop_reason` are the repair's output and are kept from the candidate.
 */
function withEnvelopeOf(original: AssistantMessage, repaired: AssistantMessage): AssistantMessage {
  const out: AssistantMessage = { content: repaired.content, stop_reason: repaired.stop_reason };
  if (original.id !== undefined) out.id = original.id;
  if (original.model !== undefined) out.model = original.model;
  if (original.stop_sequence !== undefined) out.stop_sequence = original.stop_sequence;
  if (original.usage !== undefined) out.usage = original.usage;
  return out;
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
    // Non-tool blocks: check for structural equality.
    // Short-circuit on reference equality before stringifying.
    if (a === b) continue;
    // For non-objects or primitives, use direct comparison; otherwise use stable stringify.
    if (typeof a !== "object" || typeof b !== "object") {
      if (a !== b) return false;
      continue;
    }
    if (stableStringify(a) !== stableStringify(b)) return false;
  }
  return true;
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
