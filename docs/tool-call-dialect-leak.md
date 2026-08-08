# Tool-call dialect leaking to the client as text

**Reported 2026-08-08** by an agent running relay-pool dispatches. Mechanism **confirmed in source**;
the specific incident **not reproduced** (see Status).

## The report

Relay-pool dispatches were failing in a way first read as "long jobs die". They were not.

- Successful runs logged 1.1–3.2 KB of output.
- Failures logged **8 and 70 bytes** — the whole captured output being `<think` in one case, and a
  fragment of `</｜DSML｜parameter></｜DSML｜invoke></｜DSML｜tool_calls>` in the other.

One task (`ingest-attribution-stamp`) **wrote its shard correctly** and only then emitted the raw
envelope. The model did the work; only the final tool-call framing failed.

⚠ The tell that separates the two failure shapes, and it is a clean one: **a capacity death produces
a lot of output ending badly; a dialect death produces almost none.** Conflating them leads to
"split the job", which fixes neither.

## The mechanism (confirmed in source)

`fetchBackend()` reads tool calls from the OpenAI response's **`message.tool_calls`** field
(`backend.ts:471`). If the serving host does not parse the model's native tool-call dialect and
instead returns it as text in `content`, then in order:

1. `message.tool_calls` is absent, so `hasToolCalls` is false (`backend.ts:159`).
2. `stop_reason` resolves to `end_turn` rather than `tool_use` (`backend.ts:640`).
3. The Anthropic-shaped message carries **zero `tool_use` blocks**, so `validator.ts` reports
   `toolUseCount: 0` and **passes** — there is nothing malformed to find.
4. `repair()` therefore never engages, and the raw markup reaches the client as assistant text.

There is **no dialect handling anywhere in `src/`** (grepped: no `tool_calls_begin`, no `DSML`, no
text-embedded tool-call detection). The repair layer validates and repairs *malformed `tool_use`
structure*; it has no concept of *a tool call that never became structure at all*. So this is a real
gap, and squarely inside this project's stated competence — the relay exists so the harness can run
on models that are weaker at tool use.

⚠ **It is host-dependent, not model-dependent.** NIM and OpenRouter parse the dialect server-side
and return proper `tool_calls`. The hosts that return raw model output are the ones that leak. The
same model therefore works on one pool member and leaks on another.

## Status: not reproduced

Probed 2026-08-08 through the running relay with a real tool-bearing request:

| Target | Result |
|---|---|
| `openrouter/deepseek/deepseek-v4-flash-0731` | correct `tool_use` block |
| `pool/xhigh` (served by `models/gemini-3.5-flash`) | correct `tool_use` block |
| `pool/{high,medium,low}` (served by NIM `deepseek-v4-flash-0731`) | correct `tool_use` block |
| `huggingface/deepseek-ai/DeepSeek-V4-Flash-0731` | HTTP 402 — monthly credits depleted |
| `huggingface/deepseek-ai/DeepSeek-V3.2` | HTTP 402 — monthly credits depleted |
| `ollama-cloud/deepseek-v4-flash:0731` | HTTP 403 — subscription required |
| `opencode/deepseek-v4-flash` | HTTP 401 — no payment method |

Every free host that could exhibit the leak is currently cost-blocked, so all four pools are being
answered by NIM and Gemini, which parse correctly. **The mechanism is confirmed; which member
produced the reported bytes is not.** Do not close this on the strength of the pools being green
today — the leaking member simply is not in rotation.

## The fix, and why it is inside the repair boundary

Detecting a known vendor envelope in a text block and reconstructing it into a `tool_use` block is
**protocol form**, not judgment: a deterministic parse of a published framing, no model opinion in
the request path. That is the same side of the line as repairing args that violate a schema.

Constraints it must respect:

- **Parse, never infer.** A closed set of recognized envelopes, like the effort vocabulary in
  `sync-tiers.mjs` and the alias list in `authEnv.ts`. Prose that merely mentions a tool name is not
  a tool call, and guessing one into existence would be fabricating intent.
- **The destructive guard needs no new code, and adding one would be wrong.** ⚠ An earlier draft of
  this section said a reconstructed call must be run through `destructiveMatcher()` or it "smuggles
  a `Bash` call past the guard". That misread the guard. `DEFAULT_DESTRUCTIVE` stops the RESHAPER —
  an LLM — from inventing or rewriting a destructive call; it has never blocked a backend from
  legitimately emitting one, and a normal `Bash` tool_call passes through today. Recovery is a
  deterministic parse of what the model actually emitted, so a recovered call carries exactly the
  same authority as one the host parsed itself. Refusing recovered destructive calls would break
  every agentic task routed through a non-parsing host, which is worse than the risk. The dangerous
  case — recovered, *invalid*, and destructive — is already covered for free: recovery happens in
  `backend.ts` before validation, so such a call reaches `repair()` and hits its existing
  destructive pre-check unchanged.
- **Re-validate after reconstruction**, same as `repair()` does — a parsed envelope can still carry
  args that violate the schema.
- **Report it.** A response whose tool call was reconstructed is not the same as one that arrived
  correct; it needs a header and a log field, on the same reasoning as `x-llm-relay-degraded`.
- **Both fronts.** `/v1/messages` and the OpenAI front, in one policy — a detector wired into one
  path is the exact shape of the pool-failover incident.
- **Streaming too.** The reported bytes were the tail of a stream, so buffering-from-first-suspicion
  has to work the way `repairStreamingPath` already does.

## Open question

Should an unparseable-but-suspicious text block (`<think`, a partial envelope) **fail the request**
so failover moves to another member, rather than returning text that the client will treat as a
final answer? Arguments both ways: returning it is honest passthrough, but the client cannot tell it
from a real answer, which is what made this read as "the job died" for a whole session. Failing it
would make the member's breaker record the failure and let the pool route around a host that does
not parse — which is arguably the correct long-run behaviour.
