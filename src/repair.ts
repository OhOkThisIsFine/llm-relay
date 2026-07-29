import { type AssistantMessage, isToolUseBlock, type JsonSchema } from "./anthropic.js";
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
}

/**
 * Attempt to repair an invalid tool-bearing assistant message. Safety-first:
 * if ANY tool_use in the (invalid) response targets a destructive tool, we
 * REFUSE rather than fabricate its arguments — because repair output may run
 * under --dangerously-skip-permissions. Otherwise reshape ≤ maxAttempts,
 * re-validating each attempt; a reshape that doesn't validate is never emitted.
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

  for (let attempt = 0; attempt < deps.maxAttempts; attempt++) {
    let result;
    try {
      result = await deps.reshaper.reshape({
        tools,
        rawAssistant: current,
        errors,
        backendModel: null,
      });
    } catch {
      // Transport-level failure (single reshaper down, or every failover candidate down).
      // Nothing answered — not a refusal, but nothing to retry against either: fail clean.
      return { outcome: "failed" };
    }
    if (result.kind === "refuse") return { outcome: "refused" };

    const check = deps.validator.validate(result.message, tools);
    if (check.valid) return { outcome: "fixed", message: result.message };
    // Feed the new errors back into the next attempt.
    errors = check.errors;
    current = result.message;
  }
  return { outcome: "failed" };
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
