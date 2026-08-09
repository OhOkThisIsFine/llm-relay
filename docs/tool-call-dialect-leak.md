# Tool-call dialect leaking to the client as text

**Reported 2026-08-08** by an agent running relay-pool dispatches. Mechanism **confirmed in source**; fixed for the buffered path in 0.33.0 and for **streaming in
0.34.0**; the specific incident **not reproduced** (see Status and Coverage).

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

## Resolved: an unparseable envelope fails clean

The open question — return the suspicious text, or fail the request — needed no new policy. The
repair path already answers it: **unrepairable ⇒ fail clean.** A `detected`-but-unparseable envelope
now raises `DialectUnparseableError`, served as a retriable 502, so the breaker records it against
that deployment and the pool fails over to a host that parses. Returning the fragment would hand the
client a "final answer" that is really the tail of a broken tool call — the misdiagnosis this whole
path exists to prevent.

## ⚠ Coverage: what is NOT fixed yet

Recovery is wired into `openAiResponseToAnthropic`, which is the **buffered, non-streaming**
translation. Two gaps remain, and the first is the one that matters most:

1. ~~Streaming is NOT covered.~~ **Closed in 0.34.0.** `dialect-stream.ts` wraps the translated SSE
   stream: text streams through until a marker lands, then everything after it is withheld and
   recovered at stream end. `scanForMarker` supplies a holdback bounded by the longest marker, so a
   marker split across deltas is never half-emitted and ordinary prose containing `<` keeps
   streaming — buffering every tool-bearing request would have traded this bug for a latency
   regression on all pool traffic. A truncated envelope becomes a mid-stream SSE `error`, which is
   CLAUDE.md's stated alternative to a 502 once headers are gone.
   ⚠ **`markerStart` must back up over the tag opener.** Markers omit the `<` / `</` prefix so a
   CLOSING tag matches, which means a hit points one character past the real start; capturing from
   there left the `<` behind as prose and handed `stripEnvelopes` a tag it no longer recognized, so
   the envelope's outer wrapper survived into the recovered text. A test pins it.
2. **The OpenAI front's direct passthrough is not covered.** An `openai`-kind client talking to an
   `openai`-kind backend is not translated at all, so the dialect text reaches that client intact.
   Lower priority — the harness this exists for speaks Anthropic — but it is the same "two paths,
   one policy empty" shape the pool-failover incident warns about, so it should not be left
   indefinitely.

Verified 2026-08-08 against the live relay: streaming tool calls through `pool/high`, `pool/xhigh`
and `openrouter/deepseek/deepseek-v4-flash-0731` all return proper `tool_use` blocks with
`stop_reason: tool_use`, no SSE error and no dialect text — i.e. the wrapper is a no-op on hosts
that parse. Recovery itself could not be verified against a live leaking host (all cost-blocked),
so it rests on unit tests built from the exact observed bytes.

Detection itself is already correct for the truncated case: markers deliberately omit the `<` / `</`
prefix so a tail of closing tags is recognized. A unit test pins exactly the observed 70-byte body.
