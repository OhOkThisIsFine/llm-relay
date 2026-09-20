/**
 * The `relay` agent definition's PROVENANCE contract, and the dispatch handle it depends on.
 *
 * Two measured failures, both about a wrapper reporting a lane answer it never got:
 *
 * - 2026-09-08: `lap_scope_review` returned an inline review while explicitly stating its dispatch
 *   only printed the ladder, then ended with `provenance: lane=free-pool spec=pool/medium
 *   elapsed=315s`. No completed MCP job or lane answer supported that provenance.
 * - 2026-09-04: four read-only surveys returned `RELAY_DISPATCH_FAILED` while `GET /telemetry`
 *   answered 200 in 3 ms — the lane outlived the wait and the wrapper gave up the handle. A direct
 *   MCP `dispatch` with `waitMs: 15000` returned `job-0001` at once and polling collected answers
 *   at 135 s and 247 s.
 *
 * ⚠ These pin the template's CLAIMS, not its wording — the `MCP_INSTRUCTIONS` precedent. Reword
 * freely; change an assertion deliberately rather than deleting it.
 */
import { describe, expect, it } from "vitest";
import {
  RELAY_AGENT_TEMPLATE,
  RELAY_DISPATCH_FAILED_TOKEN,
  RELAY_DISPATCH_UNAVAILABLE_TOKEN,
  stripRelayDispatchPrefix,
} from "../src/setup-claude.js";
import { resolveWaitMs } from "../src/mcp/server.js";
import { DEFAULT_MCP_MAX_WAIT_MS } from "../src/config-types.js";

describe("relay agent provenance", () => {
  it("permits provenance ONLY for a completed dispatch, and requires the job id in it", () => {
    // The line the wrapper must return, and the only evidence that may support it.
    expect(RELAY_AGENT_TEMPLATE).toMatch(/provenance: job=/);
    // ⚠ RED on HEAD: the template's provenance line was `lane=… spec=… elapsed=…` with no job id,
    // which is exactly the shape `lap_scope_review` fabricated — nothing in it was checkable
    // against a job the server had actually created.
    expect(RELAY_AGENT_TEMPLATE).toContain("job=");
  });

  it("reports UNAVAILABLE rather than an inline substitute when no dispatch returned a job", () => {
    // ⚠ RED on HEAD: the template had no such branch at all, so an inline review with a
    // copied-looking provenance line satisfied every rule it stated.
    expect(RELAY_AGENT_TEMPLATE).toContain(RELAY_DISPATCH_UNAVAILABLE_TOKEN);
    expect(RELAY_DISPATCH_UNAVAILABLE_TOKEN).not.toBe(RELAY_DISPATCH_FAILED_TOKEN);
  });

  it("distinguishes a lane failure from a wrapper that never reached a lane", () => {
    // Two different events calling for opposite responses: retry a different tier vs. do not
    // pretend a lane ran. One token for both is the collapse this pins against.
    expect(RELAY_DISPATCH_FAILED_TOKEN).toBe("RELAY_DISPATCH_FAILED");
    expect(RELAY_DISPATCH_UNAVAILABLE_TOKEN).toBe("RELAY_DISPATCH_UNAVAILABLE");
  });

  it("returns the jobId and lane while the lane is still running, instead of giving up", () => {
    const text = RELAY_AGENT_TEMPLATE;
    // The wrapper must not treat "still running" as a failure: it holds the handle and polls.
    expect(text).toMatch(/still running/i);
    expect(text).toMatch(/jobId/);
  });

  it("treats walk-verdict as authoritative and refuses circumstantial liveness inference", () => {
    const text = RELAY_AGENT_TEMPLATE;
    expect(text).toContain("walk-verdict");
    expect(text).toContain("keep-running");
    expect(text).toContain("no-idle-stop");
    expect(text).toContain("unavailable");
    expect(text).toMatch(/never infer liveness from elapsed time, output silence, historical duration/i);
    expect(text).toContain("activity diagnostics");
    expect(text).not.toContain("last-activity");
  });

  it("strips the caller's mode tag through one shared helper, not a prompt-only instruction", () => {
    expect(stripRelayDispatchPrefix("[answer] what is 2+2")).toEqual({ mode: "answer", task: "what is 2+2" });
    expect(stripRelayDispatchPrefix("[agent] fix the bug")).toEqual({ mode: "agent", task: "fix the bug" });
    expect(stripRelayDispatchPrefix("plain task")).toEqual({ mode: undefined, task: "plain task" });
    // A tag that is not followed by whitespace is not a tag.
    expect(stripRelayDispatchPrefix("[answer]x")).toEqual({ mode: undefined, task: "[answer]x" });
  });
});

describe("dispatch wait ceiling", () => {
  it("clamps a waitMs above the ceiling and says so, rather than losing the handle", () => {
    const clamped = resolveWaitMs(240_000, DEFAULT_MCP_MAX_WAIT_MS);
    // ⚠ RED on HEAD is the STRING member below, not this clamp: the measured `Error: Request
    // timed out` with no job id came from a call that blocked longer than the host tolerates. The
    // ceiling exists precisely so the server answers first; the wrapper must then POLL rather than
    // declare failure, which the template assertion above pins.
    expect(clamped).toEqual({ waitMs: DEFAULT_MCP_MAX_WAIT_MS, clamped: true, requested: 240_000 });
  });

  it("keeps the ceiling under the measured host tool-call failure point", () => {
    // Measured on Claude Code: a dispatch returning a handle worked at 45 s, failed at 100 s and
    // 60 s. The default must sit below the LOWEST measured failure, with the margin stated here.
    expect(DEFAULT_MCP_MAX_WAIT_MS).toBeLessThan(60_000);
  });
});
