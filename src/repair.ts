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
    const result = await deps.reshaper.reshape({
      tools,
      rawAssistant: current,
      errors,
      backendModel: null,
    });
    if (result.kind === "refuse") return { outcome: "refused" };

    const check = deps.validator.validate(result.message, tools);
    if (check.valid) return { outcome: "fixed", message: result.message };
    // Feed the new errors back into the next attempt.
    errors = check.errors;
    current = result.message;
  }
  return { outcome: "failed" };
}

/** Build a destructive-tool matcher from name patterns (case-insensitive substring). */
export function destructiveMatcher(namePatterns: string[]): (name: string) => boolean {
  const lowered = namePatterns.map((p) => p.toLowerCase());
  return (name: string) => {
    const n = name.toLowerCase();
    return lowered.some((p) => n.includes(p));
  };
}
