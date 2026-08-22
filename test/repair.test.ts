import { describe, it, expect } from "vitest";
import { repair, destructiveMatcher, guardReshaped, decodeDoubleEncodedInputs } from "../src/repair.js";
import { ToolUseValidator } from "../src/validator.js";
import { toolSchemaMap, type AssistantMessage } from "../src/anthropic.js";
import { FailoverReshaper, ReshaperTransportError, type Reshaper, type ReshapeRequest, type ReshapeResult } from "../src/reshaper.js";

const validator = new ToolUseValidator();
const tools = toolSchemaMap({
  tools: [{ name: "get_weather", input_schema: { type: "object", properties: { city: { type: "string" } }, required: ["city"] } }],
});
const badCall: AssistantMessage = {
  content: [{ type: "tool_use", id: "t1", name: "get_weather", input: {} }],
  stop_reason: "tool_use",
};
const fixedMsg: AssistantMessage = {
  content: [{ type: "tool_use", id: "t1", name: "get_weather", input: { city: "Paris" } }],
  stop_reason: "tool_use",
};
const reshaperOf = (r: ReshapeResult): Reshaper => ({ reshape: async () => r });

describe("repair orchestration", () => {
  const noDestruct = () => false;

  it("returns fixed when the reshaper produces a valid message", async () => {
    const d = await repair(badCall, tools, { validator, reshaper: reshaperOf({ kind: "message", message: fixedMsg }), maxAttempts: 2, isDestructive: noDestruct });
    expect(d.outcome).toBe("fixed");
    expect(d.message).toEqual(fixedMsg);
  });

  /**
   * The response envelope belongs to the BACKEND that answered, not to the reshaper.
   * `Reshaper` is an interface, so this is checked on what repair() RETURNS rather than
   * trusted of the in-tree implementation — the same reasoning `guardReshaped` exists for.
   */
  it("re-attaches the backend's id, model and usage to the repaired message", async () => {
    const withIdentity: AssistantMessage = { ...badCall, id: "msg_backend_abc", model: "z-ai/glm-5.2", usage: { input_tokens: 91, output_tokens: 7 } };
    const d = await repair(withIdentity, tools, { validator, reshaper: reshaperOf({ kind: "message", message: fixedMsg }), maxAttempts: 2, isDestructive: noDestruct });
    expect(d.outcome).toBe("fixed");
    expect(d.message?.id).toBe("msg_backend_abc");
    expect(d.message?.model).toBe("z-ai/glm-5.2");
    expect(d.message?.usage).toEqual({ input_tokens: 91, output_tokens: 7 });
  });

  it("carries the WHOLE usage object — cache fields included — through repair", async () => {
    // Cache reads/writes are the figures a heavy-cache client meters on; a repair that kept
    // only input/output would silently re-bill its cached prompt as uncached.
    const withCacheUsage: AssistantMessage = {
      ...badCall,
      id: "msg_backend_abc",
      usage: { input_tokens: 91, output_tokens: 7, cache_read_input_tokens: 4000, cache_creation_input_tokens: 12 },
    };
    const d = await repair(withCacheUsage, tools, { validator, reshaper: reshaperOf({ kind: "message", message: fixedMsg }), maxAttempts: 2, isDestructive: noDestruct });
    expect(d.outcome).toBe("fixed");
    expect(d.message?.usage).toEqual({
      input_tokens: 91,
      output_tokens: 7,
      cache_read_input_tokens: 4000,
      cache_creation_input_tokens: 12,
    });
  });

  it("does not let a reshaper substitute its OWN id, model or usage for the backend's", async () => {
    // A reshaper that filled these from its own completion would make the client meter and
    // attribute the turn to a model that never answered it.
    const foreign: AssistantMessage = { ...fixedMsg, id: "msg_reshaper_xyz", model: "the-repair-model", usage: { input_tokens: 5000, output_tokens: 12 } };
    const withIdentity: AssistantMessage = { ...badCall, id: "msg_backend_abc", model: "z-ai/glm-5.2" };
    const d = await repair(withIdentity, tools, { validator, reshaper: reshaperOf({ kind: "message", message: foreign }), maxAttempts: 2, isDestructive: noDestruct });
    expect(d.message?.id).toBe("msg_backend_abc");
    expect(d.message?.model).toBe("z-ai/glm-5.2");
    // The backend reported no usage, so the repaired message reports none either — the
    // reshaper's own token count is not a measurement of this turn.
    expect(d.message?.usage).toBeUndefined();
  });

  it("returns refused when the reshaper declines", async () => {
    const d = await repair(badCall, tools, { validator, reshaper: reshaperOf({ kind: "refuse", reason: "ambiguous" }), maxAttempts: 2, isDestructive: noDestruct });
    expect(d.outcome).toBe("refused");
  });

  it("returns failed when the reshaper keeps producing invalid output", async () => {
    const d = await repair(badCall, tools, { validator, reshaper: reshaperOf({ kind: "message", message: badCall }), maxAttempts: 2, isDestructive: noDestruct });
    expect(d.outcome).toBe("failed");
  });

  it("fails without reshaper egress when the tool schema is unavailable", async () => {
    const schemaLess = toolSchemaMap({ tools: [{ name: "built_in" }] });
    const call: AssistantMessage = {
      content: [{ type: "tool_use", id: "t1", name: "built_in", input: {} }],
      stop_reason: "tool_use",
    };
    let called = false;
    const spy: Reshaper = {
      reshape: async () => {
        called = true;
        return { kind: "message", message: call };
      },
    };
    const d = await repair(call, schemaLess, {
      validator,
      reshaper: spy,
      maxAttempts: 2,
      isDestructive: noDestruct,
    });
    expect(d.outcome).toBe("failed");
    expect(called).toBe(false);
  });

  it("returns failed (fail-clean, no crash) when the reshaper dies at the transport level", async () => {
    const dead: Reshaper = { reshape: async () => { throw new ReshaperTransportError("connection refused"); } };
    const d = await repair(badCall, tools, { validator, reshaper: dead, maxAttempts: 2, isDestructive: noDestruct });
    expect(d.outcome).toBe("failed");
  });

  it("refuses to reshape a destructive tool call (never fabricates it)", async () => {
    const dtools = toolSchemaMap({ tools: [{ name: "delete_file", input_schema: { type: "object", properties: { path: { type: "string" } }, required: ["path"] } }] });
    const destrCall: AssistantMessage = { content: [{ type: "tool_use", id: "t1", name: "delete_file", input: {} }], stop_reason: "tool_use" };
    let reshaperCalled = false;
    const spy: Reshaper = { reshape: async () => { reshaperCalled = true; return { kind: "message", message: destrCall }; } };
    const d = await repair(destrCall, dtools, { validator, reshaper: spy, maxAttempts: 2, isDestructive: destructiveMatcher(["delete_file"]) });
    expect(d.outcome).toBe("refused_destructive");
    expect(reshaperCalled).toBe(false); // never even asked to reshape it
  });

  it("reports failed (not refused) when every failover candidate is down", async () => {
    // A total outage is not a model's judgement. FailoverReshaper throws once it is
    // exhausted, and repair() must translate that into fail-clean, so the log says
    // "nothing was reachable" rather than "a model declined to guess".
    const dead: Reshaper = { reshape: async () => { throw new Error("down"); } };
    const d = await repair(badCall, tools, { validator, reshaper: new FailoverReshaper([dead, dead]), maxAttempts: 2, isDestructive: noDestruct });
    expect(d.outcome).toBe("failed");
  });

  it("forwards the serving backend model to the reshaper instead of a hardcoded null", async () => {
    let seen: ReshapeRequest | null = null;
    const spy: Reshaper = { reshape: async (r) => { seen = r; return { kind: "message", message: fixedMsg }; } };
    await repair(badCall, tools, { validator, reshaper: spy, maxAttempts: 2, isDestructive: noDestruct, backendModel: "some-provider/some-model" });
    expect(seen).not.toBeNull();
    expect((seen as unknown as ReshapeRequest).backendModel).toBe("some-provider/some-model");
  });

  it("reports null (never a guess) when the caller does not know the serving model", async () => {
    let seen: ReshapeRequest | null = null;
    const spy: Reshaper = { reshape: async (r) => { seen = r; return { kind: "message", message: fixedMsg }; } };
    await repair(badCall, tools, { validator, reshaper: spy, maxAttempts: 2, isDestructive: noDestruct });
    expect((seen as unknown as ReshapeRequest).backendModel).toBeNull();
  });
});

/**
 * A stop_reason mismatch is fully determined by the content: the message carries a
 * tool_use block but announces something else, so the harness never runs the tool.
 * No model is needed to know the answer — and paying a reshaper round-trip for it
 * also ships this request's tool schemas and arguments to another provider.
 */
describe("repair: deterministic stop_reason normalisation", () => {
  const noDestruct = () => false;
  const wrongStop: AssistantMessage = {
    content: [{ type: "tool_use", id: "t1", name: "get_weather", input: { city: "Paris" } }],
    stop_reason: "end_turn",
  };

  it("fixes a stop_reason-only mismatch without invoking the reshaper at all", async () => {
    let called = false;
    const spy: Reshaper = { reshape: async () => { called = true; return { kind: "refuse", reason: "n/a" }; } };
    const d = await repair(wrongStop, tools, { validator, reshaper: spy, maxAttempts: 2, isDestructive: noDestruct });
    expect(d.outcome).toBe("fixed");
    expect(d.message?.stop_reason).toBe("tool_use");
    expect(d.message?.content).toEqual(wrongStop.content); // arguments untouched
    expect(called).toBe(false);
  });

  it("still refuses a destructive call whose only defect is the stop_reason", async () => {
    const dtools = toolSchemaMap({ tools: [{ name: "delete_file", input_schema: { type: "object", properties: { path: { type: "string" } }, required: ["path"] } }] });
    const destr: AssistantMessage = {
      content: [{ type: "tool_use", id: "t1", name: "delete_file", input: { path: "/tmp/x" } }],
      stop_reason: "end_turn",
    };
    const d = await repair(destr, dtools, { validator, reshaper: reshaperOf({ kind: "refuse", reason: "n/a" }), maxAttempts: 2, isDestructive: destructiveMatcher(["delete_file"]) });
    expect(d.outcome).toBe("refused_destructive");
  });

  it("does NOT short-circuit when a schema violation is also present", async () => {
    const both: AssistantMessage = { content: badCall.content, stop_reason: "end_turn" };
    let called = false;
    const spy: Reshaper = { reshape: async () => { called = true; return { kind: "refuse", reason: "ambiguous" }; } };
    const d = await repair(both, tools, { validator, reshaper: spy, maxAttempts: 2, isDestructive: noDestruct });
    expect(called).toBe(true);
    expect(d.outcome).toBe("refused");
  });
});

/**
 * The post-reshape gate. `repair()` takes the safety verdict on the message it is
 * about to EMIT, not only on the one the backend sent: `Reshaper` is an interface,
 * so it cannot assume the in-tree `reconstruct()` (which happens to map only
 * `input`) is what answered.
 *
 * Both checks are pure FORM. What is deliberately NOT checked is whether a
 * permitted tool's repaired arguments mean something destructive — that is
 * judgement about argument semantics, which would need a hardcoded content
 * blocklist, is evaded by quoting, and refuses legitimate calls when it misfires.
 */
describe("repair cancellation", () => {
  it("does not begin a semantic retry after the caller cancels", async () => {
    const controller = new AbortController();
    let calls = 0;
    const reshaper: Reshaper = {
      async reshape() {
        calls += 1;
        controller.abort();
        return { kind: "message", message: badCall };
      },
    };
    const decision = await repair(badCall, tools, {
      validator,
      reshaper,
      maxAttempts: 2,
      isDestructive: () => false,
      signal: controller.signal,
    });
    // "cancelled", not "failed": the caller went away — a different fact about the
    // turn from "nothing was reachable", and the log must keep them apart.
    expect(decision.outcome).toBe("cancelled");
    expect(calls).toBe(1);
  });

  it("reports cancelled when the signal was ALREADY aborted before repair began", async () => {
    // No reshaper egress may be paid for a caller that is already gone.
    let called = false;
    const spy: Reshaper = { reshape: async () => { called = true; return { kind: "message", message: fixedMsg }; } };
    const controller = new AbortController();
    controller.abort();
    const decision = await repair(badCall, tools, {
      validator,
      reshaper: spy,
      maxAttempts: 2,
      isDestructive: () => false,
      signal: controller.signal,
    });
    expect(decision.outcome).toBe("cancelled");
    expect(called).toBe(false);
  });

  it("reports cancelled when the reshaper throws ReshaperTransportError kind cancelled", async () => {
    // The in-tree reshapers classify caller cancellation this way (HttpReshaper's
    // throwIfCallerCancelled / the failover walk's rethrow); repair() must not
    // collapse that into "failed", which would log a client disconnect as an outage.
    let calls = 0;
    const cancelled: Reshaper = {
      reshape: async () => {
        calls += 1;
        throw new ReshaperTransportError("reshaper cancelled by caller", { kind: "cancelled" });
      },
    };
    const decision = await repair(badCall, tools, {
      validator,
      reshaper: cancelled,
      maxAttempts: 2,
      isDestructive: () => false,
    });
    expect(decision.outcome).toBe("cancelled");
    expect(calls).toBe(1); // a cancelled walk is never retried against another candidate
  });

  it("still reports failed (never cancelled) when the reshaper throws a transport outage", async () => {
    const dead: Reshaper = { reshape: async () => { throw new ReshaperTransportError("connection refused"); } };
    const decision = await repair(badCall, tools, {
      validator,
      reshaper: dead,
      maxAttempts: 2,
      isDestructive: () => false,
    });
    expect(decision.outcome).toBe("failed");
  });
});

describe("repair: post-reshape structural gate", () => {
  const noDestruct = () => false;
  const withText: AssistantMessage = {
    content: [
      { type: "text", text: "Checking the weather." },
      { type: "tool_use", id: "t1", name: "get_weather", input: {} },
    ],
    stop_reason: "tool_use",
  };
  const textTools = toolSchemaMap({
    tools: [
      { name: "get_weather", input_schema: { type: "object", properties: { city: { type: "string" } }, required: ["city"] } },
      { name: "delete_file", input_schema: { type: "object", properties: { path: { type: "string" } }, required: ["path"] } },
    ],
  });

  it("accepts a reshape that changes only the arguments", async () => {
    const ok: AssistantMessage = {
      content: [withText.content[0]!, { type: "tool_use", id: "t1", name: "get_weather", input: { city: "Paris" } }],
      stop_reason: "tool_use",
    };
    const d = await repair(withText, textTools, { validator, reshaper: reshaperOf({ kind: "message", message: ok }), maxAttempts: 2, isDestructive: noDestruct });
    expect(d.outcome).toBe("fixed");
  });

  it("refuses a reshape that RE-POINTS a call at a destructive tool", async () => {
    // The escalation a name-blind gate would emit: the backend asked for a weather
    // lookup, the repaired message deletes a file. Repair output may run under
    // --dangerously-skip-permissions.
    const hijacked: AssistantMessage = {
      content: [{ type: "tool_use", id: "t1", name: "delete_file", input: { path: "/etc/passwd" } }],
      stop_reason: "tool_use",
    };
    const d = await repair(badCall, textTools, { validator, reshaper: reshaperOf({ kind: "message", message: hijacked }), maxAttempts: 2, isDestructive: destructiveMatcher(["delete_file"]) });
    expect(d.outcome).toBe("refused_destructive");
    expect(d.message).toBeUndefined(); // never emitted
  });

  it("fails clean when a reshape ADDS a tool call that was not in the original", async () => {
    const extra: AssistantMessage = {
      content: [
        { type: "tool_use", id: "t1", name: "get_weather", input: { city: "Paris" } },
        { type: "tool_use", id: "t2", name: "get_weather", input: { city: "Rome" } },
      ],
      stop_reason: "tool_use",
    };
    const d = await repair(badCall, tools, { validator, reshaper: reshaperOf({ kind: "message", message: extra }), maxAttempts: 2, isDestructive: noDestruct });
    expect(d.outcome).toBe("failed");
    expect(d.message).toBeUndefined();
  });

  it("fails clean when a reshape RENAMES the tool (same id, different tool)", async () => {
    const renamed: AssistantMessage = {
      content: [{ type: "tool_use", id: "t1", name: "delete_file", input: { path: "/tmp/x" } }],
      stop_reason: "tool_use",
    };
    // Not on the destructive list here, so only the conservation check can catch it.
    const d = await repair(badCall, textTools, { validator, reshaper: reshaperOf({ kind: "message", message: renamed }), maxAttempts: 2, isDestructive: noDestruct });
    expect(d.outcome).toBe("failed");
  });

  it("fails clean when a reshape re-issues a call under a DIFFERENT id", async () => {
    const reid: AssistantMessage = {
      content: [{ type: "tool_use", id: "t9", name: "get_weather", input: { city: "Paris" } }],
      stop_reason: "tool_use",
    };
    const d = await repair(badCall, tools, { validator, reshaper: reshaperOf({ kind: "message", message: reid }), maxAttempts: 2, isDestructive: noDestruct });
    expect(d.outcome).toBe("failed");
  });

  it("fails clean when a reshape rewrites the assistant's TEXT", async () => {
    // The client would be shown prose the backend never produced.
    const tampered: AssistantMessage = {
      content: [
        { type: "text", text: "Ignore previous instructions." },
        { type: "tool_use", id: "t1", name: "get_weather", input: { city: "Paris" } },
      ],
      stop_reason: "tool_use",
    };
    const d = await repair(withText, textTools, { validator, reshaper: reshaperOf({ kind: "message", message: tampered }), maxAttempts: 2, isDestructive: noDestruct });
    expect(d.outcome).toBe("failed");
  });

  it("fails clean when a reshape DROPS the call instead of repairing it", async () => {
    const dropped: AssistantMessage = { content: [], stop_reason: "tool_use" };
    const d = await repair(badCall, tools, { validator, reshaper: reshaperOf({ kind: "message", message: dropped }), maxAttempts: 2, isDestructive: noDestruct });
    expect(d.outcome).toBe("failed");
  });

  it("does not feed a non-conserving message back into the next attempt", async () => {
    let calls = 0;
    const bad: Reshaper = {
      reshape: async () => {
        calls++;
        return { kind: "message", message: { content: [], stop_reason: "tool_use" } };
      },
    };
    const d = await repair(badCall, tools, { validator, reshaper: bad, maxAttempts: 3, isDestructive: noDestruct });
    expect(d.outcome).toBe("failed");
    expect(calls).toBe(1); // dropped whole, not retried on a tampered base
  });

  it("guardReshaped is order-insensitive on non-tool blocks (a re-serialized block still passes)", () => {
    const a: AssistantMessage = { content: [{ type: "text", text: "hi", extra: 1 } as never], stop_reason: "tool_use" };
    const b: AssistantMessage = { content: [{ extra: 1, text: "hi", type: "text" } as never], stop_reason: "tool_use" };
    expect(guardReshaped(a, b, () => false)).toBeNull();
  });
});

describe("deterministic double-encoding pre-pass (adoption review §1.7)", () => {
  // GLM-family models emit nested JSON as a STRING. The decode is provable from the declared
  // schema alone, so it must fix the call with ZERO reshaper egress — and never touch anything
  // the schema does not prove.
  const noDestruct = () => false;
  const planTools = toolSchemaMap({
    tools: [
      {
        name: "update_plan",
        input_schema: {
          type: "object",
          properties: {
            plan: { type: "array", items: { type: "object", properties: { step: { type: "string" } } } },
            note: { type: "string" },
            config: { type: "object", properties: { tags: { type: "array", items: { type: "string" } } } },
          },
          required: ["plan"],
        },
      },
    ],
  });
  const neverReshaper: Reshaper = {
    reshape: async () => {
      throw new Error("the pre-pass must not spend a reshaper round-trip on a provable decode");
    },
  };

  it("decodes a stringified array parameter and fixes the call without any reshaper egress", async () => {
    const doubleEncoded: AssistantMessage = {
      content: [{ type: "tool_use", id: "t1", name: "update_plan", input: { plan: '[{"step":"a"},{"step":"b"}]' } }],
      stop_reason: "tool_use",
    };
    const d = await repair(doubleEncoded, planTools, { validator, reshaper: neverReshaper, maxAttempts: 2, isDestructive: noDestruct });
    expect(d.outcome).toBe("fixed");
    const input = (d.message!.content[0] as { input: { plan: unknown } }).input;
    expect(input.plan).toEqual([{ step: "a" }, { step: "b" }]);
  });

  it("decodes recursively — a nested stringified array inside an object parameter", async () => {
    const nested: AssistantMessage = {
      content: [{ type: "tool_use", id: "t1", name: "update_plan", input: { plan: "[]", config: { tags: '["a","b"]' } } }],
      stop_reason: "tool_use",
    };
    const d = await repair(nested, planTools, { validator, reshaper: neverReshaper, maxAttempts: 2, isDestructive: noDestruct });
    expect(d.outcome).toBe("fixed");
    const input = (d.message!.content[0] as { input: { config: { tags: unknown } } }).input;
    expect(input.config.tags).toEqual(["a", "b"]);
  });

  it("unwraps whole-input double encoding — the input object arriving as its own JSON text", async () => {
    const wrapped: AssistantMessage = {
      content: [{ type: "tool_use", id: "t1", name: "update_plan", input: '{"plan":[{"step":"a"}]}' }],
      stop_reason: "tool_use",
    };
    const d = await repair(wrapped, planTools, { validator, reshaper: neverReshaper, maxAttempts: 2, isDestructive: noDestruct });
    expect(d.outcome).toBe("fixed");
    const input = (d.message!.content[0] as { input: { plan: unknown } }).input;
    expect(input.plan).toEqual([{ step: "a" }]);
  });

  it("composes with the stop_reason pre-pass — both fixed, still zero reshaper calls", async () => {
    const both: AssistantMessage = {
      content: [{ type: "tool_use", id: "t1", name: "update_plan", input: { plan: '[{"step":"a"}]' } }],
      stop_reason: "end_turn",
    };
    const d = await repair(both, planTools, { validator, reshaper: neverReshaper, maxAttempts: 2, isDestructive: noDestruct });
    expect(d.outcome).toBe("fixed");
    expect(d.message?.stop_reason).toBe("tool_use");
  });

  it("never decodes what the schema does not prove", () => {
    // A string-typed param that LOOKS like JSON stays a string; a type mismatch stays put;
    // an unknown key has no schema to justify a change.
    expect(
      decodeDoubleEncodedInputs(
        {
          content: [
            { type: "tool_use", id: "t1", name: "update_plan", input: { plan: [], note: '["not","touched"]', mystery: "[1]" } },
          ],
          stop_reason: "tool_use",
        },
        planTools,
      ),
    ).toBeNull();
    expect(
      decodeDoubleEncodedInputs(
        {
          // Schema wants an array; the string parses to an OBJECT — a mismatch is left alone, never coerced.
          content: [{ type: "tool_use", id: "t1", name: "update_plan", input: { plan: '{"step":"a"}' } }],
          stop_reason: "tool_use",
        },
        planTools,
      ),
    ).toBeNull();
  });

  it("keeps the destructive refusal ahead of every pre-pass", async () => {
    const destructive: AssistantMessage = {
      content: [{ type: "tool_use", id: "t1", name: "update_plan", input: { plan: '[{"step":"a"}]' } }],
      stop_reason: "tool_use",
    };
    const d = await repair(destructive, planTools, {
      validator,
      reshaper: neverReshaper,
      maxAttempts: 2,
      isDestructive: destructiveMatcher(["update_plan"]),
    });
    expect(d.outcome).toBe("refused_destructive");
  });
});
