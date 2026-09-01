import Ajv2020Import from "ajv/dist/2020.js";
import type { ValidateFunction } from "ajv";
import {
  type AssistantMessage,
  type ContentBlock,
  type JsonSchema,
  isToolUseBlock,
} from "./anthropic.js";

// ajv is a CJS module; under NodeNext the default import is not seen as
// constructable, so cast to its constructor type. At runtime `module.exports`
// IS the class, so `new Ajv2020(...)` works. We use the 2020-12 dialect because
// tool schemas from Pydantic-v2 / zod-to-json-schema commonly declare it; a
// draft-07-only Ajv throws on those and would force an accept-all fallback.
const Ajv2020 = Ajv2020Import as unknown as typeof import("ajv/dist/2020.js").default;
type AjvInstance = InstanceType<typeof Ajv2020>;

export interface ValidationError {
  kind:
    | "unknown_tool"
    | "input_not_object"
    | "schema_violation"
    | "schema_uncheckable"
    | "stop_reason_mismatch";
  blockIndex: number | null;
  tool: string | null;
  path?: string;
  message: string;
}

export interface ValidationResult {
  valid: boolean;
  errors: ValidationError[];
  /** tool_use blocks seen. */
  toolUseCount: number;
  /**
   * tool_use blocks that could not be schema-checked (declared tool with no
   * input_schema, or a schema Ajv could not compile). These are failures: without
   * an executable schema neither the backend call nor a proposed repair can be
   * proven valid.
   */
  uncheckableCount: number;
}

/**
 * Deterministic tool_use gate. NO LLM. Turns a silently-broken tool call (empty
 * args, wrong schema, hallucinated tool, or a tool_use without the matching
 * stop_reason) into an explicit result the caller can log (detect mode) or act
 * on (repair mode, later).
 */
export class ToolUseValidator {
  private readonly ajv: AjvInstance;
  private readonly cache = new Map<string, ValidateFunction | null>();
  private readonly schemaStringCache = new WeakMap<object, string>();

  constructor() {
    // Non-strict so vendor schemas (unknown formats/keywords) aren't rejected by
    // the validator itself. allErrors surfaces every violation.
    this.ajv = new Ajv2020({ strict: false, allErrors: true });
  }

  /** Returns a compiled validator, or null if the schema could not compile. */
  private compiledFor(name: string, schema: JsonSchema): ValidateFunction | null {
    // The parsed schema object is shared across a request's tool_use blocks
    // (toolSchemaMap guarantees it is a real object), so memoize its stable
    // string per object rather than re-serializing it on every validate call.
    let schemaStr = this.schemaStringCache.get(schema);
    if (schemaStr === undefined) {
      schemaStr = stableStringify(schema);
      this.schemaStringCache.set(schema, schemaStr);
    }
    const key = `${name}::${schemaStr}`;
    if (this.cache.has(key)) return this.cache.get(key) ?? null;
    let fn: ValidateFunction | null;
    try {
      // Strip $schema so a declared dialect Ajv2020 doesn't recognize (e.g.
      // draft-07) can't throw on meta-schema resolution; the structural keywords
      // tools use validate the same under the 2020-12 dialect.
      const { $schema: _ignored, ...rest } = schema as Record<string, unknown>;
      fn = this.ajv.compile(rest);
    } catch {
      fn = null; // uncheckable — recorded, never treated as pass
    }
    this.cache.set(key, fn);
    return fn;
  }

  private validateSingleToolBlock(
    block: Extract<ContentBlock, { type: "tool_use" }>,
    blockIndex: number,
    tools: Map<string, JsonSchema | null>,
  ): { errors: ValidationError[]; uncheckable: boolean } {
    const { name, input } = block;

    if (!tools.has(name)) {
      return {
        errors: [{
          kind: "unknown_tool",
          blockIndex,
          tool: name,
          message: `tool_use references tool "${name}" not present in request tools[]`,
        }],
        uncheckable: false,
      };
    }

    // input must be a JSON object for ANY tool, schema or not.
    if (typeof input !== "object" || input === null || Array.isArray(input)) {
      return {
        errors: [{
          kind: "input_not_object",
          blockIndex,
          tool: name,
          message: `tool_use.input is not a JSON object (got ${describe(input)})`,
        }],
        uncheckable: false,
      };
    }

    const schema = tools.get(name) ?? null;
    if (schema === null) {
      return {
        errors: [{
          kind: "schema_uncheckable",
          blockIndex,
          tool: name,
          message: `tool "${name}" has no executable input schema`,
        }],
        uncheckable: true,
      };
    }

    const validate = this.compiledFor(name, schema);
    if (validate === null) {
      return {
        errors: [{
          kind: "schema_uncheckable",
          blockIndex,
          tool: name,
          message: `tool "${name}" has an input schema that could not be compiled`,
        }],
        uncheckable: true,
      };
    }

    const errors: ValidationError[] = [];
    if (!validate(input)) {
      for (const err of validate.errors ?? []) {
        errors.push({
          kind: "schema_violation",
          blockIndex,
          tool: name,
          path: err.instancePath || "/",
          message: `${err.instancePath || "(root)"} ${err.message ?? "failed schema"}`,
        });
      }
    }

    return { errors, uncheckable: false };
  }

  validate(
    assistant: AssistantMessage,
    tools: Map<string, JsonSchema | null>,
  ): ValidationResult {
    const errors: ValidationError[] = [];
    const blocks: ContentBlock[] = Array.isArray(assistant.content)
      ? assistant.content
      : [];
    let toolUseCount = 0;
    let uncheckableCount = 0;

    blocks.forEach((block, blockIndex) => {
      if (!isToolUseBlock(block)) return;
      toolUseCount++;
      const result = this.validateSingleToolBlock(block, blockIndex, tools);
      if (result.uncheckable) uncheckableCount++;
      errors.push(...result.errors);
    });

    // stop_reason consistency: a tool_use block requires stop_reason "tool_use",
    // else the harness will not execute the tool (loop stalls).
    if (toolUseCount > 0 && assistant.stop_reason !== "tool_use") {
      errors.push({
        kind: "stop_reason_mismatch",
        blockIndex: null,
        tool: null,
        message: `response has ${toolUseCount} tool_use block(s) but stop_reason is "${assistant.stop_reason}" (expected "tool_use")`,
      });
    }

    return { valid: errors.length === 0 && uncheckableCount === 0, errors, toolUseCount, uncheckableCount };
  }
}

function describe(v: unknown): string {
  if (v === null) return "null";
  if (Array.isArray(v)) return "array";
  return typeof v;
}

/** Order-independent deterministic serialization — schema cache keys here, block comparison in repair.ts. */
export function stableStringify(v: unknown): string {
  if (v === null || typeof v !== "object") return JSON.stringify(v) ?? "undefined";
  if (Array.isArray(v)) return `[${v.map(stableStringify).join(",")}]`;
  const keys = Object.keys(v as Record<string, unknown>).sort();
  return `{${keys
    .map((k) => `${JSON.stringify(k)}:${stableStringify((v as Record<string, unknown>)[k])}`)
    .join(",")}}`;
}
