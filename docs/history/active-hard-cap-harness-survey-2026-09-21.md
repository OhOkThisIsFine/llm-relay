# Active hard-cap continuation harness survey — 2026-09-21

**Purpose:** Phase 5.1 of the active hard-cap continuation plan.  
**Scope:** establish which current lane harnesses expose an exact resumable identity early enough
for a relay-owned process rollover.  
**Status:** first-party capability survey complete; live kill/resume validation still required
before any harness is marked implementation-ready.

The safety rule is unchanged: **never resume "latest".** Continuation is allowed only with an
identifier attributable to the exact process incarnation that is being rolled over.

## Matrix

| Harness | Exact resume primitive | Identity observable before normal exit? | Important caveat | Survey verdict |
|---|---|---|---|---|
| AGY | `agy -p "<continuation>" --conversation <conversation_id>` | **Yes.** `--output-format stream-json` begins with an `init` event carrying `conversation_id`. | The current relay AGY path expects ordinary text/JSON output, so continuation needs an adapter that consumes NDJSON and reconstructs the existing final stdout contract. | **Strongest first live probe.** |
| Claude Code | `claude -p --resume <session-id> "<continuation>"` | **Yes.** Claude's streaming output begins with `system/init` carrying `session_id`. | On resumed invocations, reported init IDs have had invocation-local behavior in current releases. Preserve the canonical ID captured from the original invocation; never replace it with a later resume-local ID. Mid-tool interruption also has known resume edge cases. | **Exact primitive exists; probe after AGY.** |
| Codex | `codex exec resume <thread-id> --json "<continuation>"` | **Yes.** `codex exec --json` emits `thread.started` immediately with `thread_id`. | First-party issue #18690 records that the durable rollout may not exist until the first API turn completes; killing earlier can leave the ID non-resumable. A resume must also verify that the resumed `thread.started.thread_id` equals the canonical ID, rather than treating exit 0 as proof. | **Conditional: identity early, durability later.** |
| OpenCode | `opencode run --session <sessionID> --format json "<continuation>"` | **Yes in JSON mode.** The runner creates/loads the session before its event loop and injects `sessionID` into every JSON event. | Current releases have reported resumed-session JSON hangs/missing events for some histories. The relay's example rung also uses plain `opencode run {task}`, so an adapter must opt into structured output and normalize it. | **Exact primitive exists; not first implementation.** |

## First-party evidence

### AGY

- Headless output supports `stream-json`.
- The first event is `{"event":"init","conversation_id":"..."}`.
- Exact headless resume is `--conversation <conversation_id>`; `--continue` is only the
  ambiguous latest-conversation form and must not be used by the relay.

Sources:
- https://www.agy.dev/docs/cli/headless/
- https://www.agy.dev/docs/projects/

This is the cleanest contract of the four: the canonical conversation identifier is part of the
first machine-readable event, and the exact-ID resume flag is documented for headless mode.

### Claude Code

- Exact resume is `--resume <session-id>`.
- Print mode supports `--output-format stream-json`.
- The initial `system/init` message contains `session_id`.

Sources:
- https://docs.anthropic.com/en/docs/claude-code/cli-usage
- https://docs.anthropic.com/en/docs/claude-code/sdk
- https://github.com/anthropics/claude-code/issues/58760

The issue above is load-bearing for the adapter design: a resumed invocation may emit an
invocation-local init ID. The logical attempt must keep the original canonical session ID captured
from the fresh process and ignore later IDs for resume targeting.

### Codex

- `codex exec --json` emits `thread.started` with a UUID immediately.
- The current CLI has an exact `exec resume <SESSION_ID>` path.
- First-party issue #18690 records that the local durable rollout may appear only after the first API
  turn completes; an early kill can therefore leave the immediately-reported thread ID impossible
  to resume.

Sources:
- https://github.com/openai/codex/blob/main/codex-rs/exec/src/cli.rs
- https://github.com/openai/codex/blob/main/codex-rs/exec/src/lib.rs
- https://github.com/openai/codex/issues/18690
- https://github.com/openai/codex/issues/15539

Therefore Codex needs two distinct facts:
1. `sessionId`: the canonical `thread.started.thread_id`;
2. `resumeReady`: evidence that the thread is durably resumable.

A hard cap reached before `resumeReady` remains an ordinary timeout. On resume, the first emitted
thread ID must equal the canonical ID; otherwise the adapter must fail closed instead of silently
continuing a fresh thread.

### OpenCode

- `opencode run --session <id>` continues an exact session.
- `opencode run --format json` is the scriptable event mode.
- Current runner source obtains the session before processing output and writes `sessionID` into
  every JSON event.

Sources:
- https://opencode.ai/v2/docs/cli/commands/
- https://github.com/anomalyco/opencode/blob/dev/packages/opencode/src/cli/cmd/run.ts
- https://github.com/anomalyco/opencode/issues/31482
- https://github.com/anomalyco/opencode/issues/32506

OpenCode is structurally resumable, but its current resumed JSON path has enough reported output
edge cases that it should follow a simpler harness rather than establish the continuation substrate.

## Implications for llm-relay

### Current command recognition is not the continuation registry

`src/lane-manifest.ts` deliberately recognizes only AGY and Codex because that module is a model
roster/argument-support registry. Claude and OpenCode are valid CLI lanes but are not members of that
closed set.

Do **not** widen `laneOfCommand` merely to implement continuation. Continuation needs its own
closed harness classifier/adapter registry with a different responsibility.

### Structured output is an adapter concern

All four useful identity channels are structured. The current lane result contract remains:

```ts
{ code, stdout, stderr, timedOut }
```

The continuation adapter should observe the structured stream as it arrives, capture identity and
resume-readiness facts, and still normalize the completed answer back into the current stdout
contract. Callers, renderers, quota classifiers, and telemetry should not learn four harness
protocols.

### Canonical identity is immutable

Once the first incarnation captures a canonical session/conversation/thread ID:

- store it on the logical attempt;
- never replace it with a resumed invocation's local ID;
- require resumed output to prove it reattached to the expected identity where the harness exposes
  that fact;
- never fall back to `--continue`, `--last`, a session picker, or current-directory "latest".

## Live validation protocol

Documentation/source evidence is enough to design the adapter boundary, but not enough to enable a
harness. Each candidate must pass a real interruption/resume probe on a supported host.

### AGY — first probe

1. Start a headless run with `--output-format stream-json` and a task long enough to remain active.
2. Capture the first `init.conversation_id`.
3. Wait for first-party activity after init, then terminate the owned process tree.
4. Start a new process in the same working tree with
   `--conversation <captured-id> --output-format stream-json` and a continuation prompt.
5. Assert the resumed stream uses the same conversation ID and continues prior context/work.
6. Repeat with two concurrent jobs in the same cwd and prove each resumes only its own ID.

### Claude

Same shape using initial `system/init.session_id` and exact `--resume`. Preserve the original ID
even if the resumed invocation reports another init ID.

### Codex

Capture `thread.started.thread_id`, but do not mark `resumeReady` until durable session evidence
exists. Kill both before and after that boundary: before must decline continuation; after must
resume the exact thread. Verify the resumed `thread.started` ID matches.

### OpenCode

Capture `sessionID` from JSON mode, resume with `--session`, and include a tool-using/multi-step
history because those are the histories implicated in current resumed-JSON bug reports.

## Gate to Phase 5.2

Phase 5.2 may begin when at least one harness has passed the live protocol above and is marked
**verified resumable**. AGY should be attempted first. The substrate should still model harness
support generically so Claude/Codex/OpenCode can be added independently later.
