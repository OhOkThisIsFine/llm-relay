# Tool-call dialect leaking to the client as text

**Reported 2026-08-08** by an agent running relay-pool dispatches. Mechanism **confirmed in source**;
fixed for the translated buffered path in 0.33.0, translated streaming in **0.34.0**, and the
OpenAI direct passthrough on main on 2026-08-14; the specific incident **not reproduced** (see
Status and Coverage).

⚠ **There are TWO mechanisms with the same symptom**, and they call for opposite fixes. The one
below is *host-dependent*: a host failed to parse its model's native dialect, and the relay
recovers it. The second — [§ Second mechanism](#second-mechanism-2026-08-23--relay-authored-notation-host-independent)
— is *relay-caused and host-independent*: the relay taught every openai-kind backend a bogus
notation by writing its own IR into the outbound prompt. Read that section first if the blob the
client received is **JSON** rather than vendor markup. ⚠ Its diagnostic tell is at the end of this
document; the "a dialect death produces almost none of the output" rule below **does not hold** for
it — those runs did 474–1571 s of real work before leaking.

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

At the time of the report there was **no dialect handling anywhere in `src/`** (grepped: no
`tool_calls_begin`, no `DSML`, no text-embedded tool-call detection). The repair layer validates
and repairs *malformed `tool_use` structure*; it has no concept of *a tool call that never became
structure at all*. So this is a real
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
  correct. Both paths use `x-llm-relay-tool-dialect: recovered`; direct recovery also feeds the
  existing validation/repair log fields rather than inventing a second dialect field.
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

## Coverage

Recovery began in `openAiResponseToAnthropic`, the **buffered, non-streaming** translation. Both
cross-path gaps are now closed:

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
2. ~~The OpenAI front's direct passthrough is not covered.~~ **Closed on main 2026-08-14.**
   `openai-dialect.ts` is gated on an actual OpenAI function declaration, uses the same closed
   marker/parser vocabulary as `tool-dialects.ts`, reconstructs buffered responses as native Chat
   `tool_calls`, and applies the bounded streaming holdback before the final-wire commit probe.
   Detected-but-unparseable pre-commit envelopes become invisible candidate failover; after content
   commits they remain an honest OpenAI SSE error. No-tools traffic bypasses the adapter and remains
   byte-exact. Recovered calls are validated and, in repair mode, use the existing reshaper path;
   valid destructive calls pass without invoking that guard, exactly like host-parsed calls.

Verified 2026-08-08 against the live relay: translated streaming tool calls through `pool/high`,
`pool/xhigh` and `openrouter/deepseek/deepseek-v4-flash-0731` all return proper `tool_use` blocks with
`stop_reason: tool_use`, no SSE error and no dialect text — i.e. the wrapper is a no-op on hosts
that parse. Recovery itself could not be verified against a live leaking host (all cost-blocked),
so it rests on unit tests built from the exact observed bytes. The 2026-08-14 direct-path closure is
covered by buffered and split-marker unit tests plus real-socket two-candidate proxy tests for
pre-commit failover and response-header timing. It is likewise **not live-verified against a leaking
public host**: every known host that could reproduce the leak remains cost-blocked.

Detection itself is already correct for the truncated case: markers deliberately omit the `<` / `</`
prefix so a tail of closing tags is recognized. A unit test pins exactly the observed 70-byte body.

---

## Second mechanism (2026-08-23) — relay-authored notation, host-independent

**Different cause, same symptom.** The section above is about a HOST that failed to parse its
model's dialect. This one is about the RELAY teaching every `openai`-kind backend a tool-call
notation that does not exist, and then being unable to recognise it coming back.

### What happened

`fetchBackend()` handed the whole Anthropic conversation to llm-bridge's
`translateBetweenProviders("anthropic", "openai", …)`. llm-bridge 2.0.1's `universalToOpenAI` has
**no case for a `tool_call` or `tool_result` universal block**, so both fell through to its generic
`JSON.stringify(content)` fallback (`node_modules/llm-bridge/dist/index.mjs:1275`) and became
`{type:"text"}` parts of the OUTBOUND prompt, carrying llm-bridge's own IR envelope:

```json
{"_original":{"provider":"anthropic","raw":{"type":"tool_use","id":"toolu_01A", … }},
 "tool_call":{"arguments":{…},"id":"toolu_01A","metadata":{"input":{…}},"name":"Grep"},
 "type":"tool_call"}
```

The model read 4–24 copies of that in its own context and reproduced the pattern as literal
assistant text; the relay forwarded it faithfully, the client rendered it as the final answer, and
the harness ran no tool. Three side effects rode along on **every** openai-kind agentic request:

- prompt inflation ~**3.1×** (a measured 6-turn transcript: 26,315 → 82,031 chars, 24 envelopes);
- every tool result **triplicated** (`raw.content` + `metadata.content` + `result`);
- `tool_calls` emitted with **no matching `role:"tool"` messages** — the OpenAI tool-result linkage
  was lost entirely, so the host had nothing tying an answer to the call it answered.

It fired deterministically on every assistant turn containing a `tool_use` and every user turn
containing ≥2 `tool_result`s — i.e. essentially every agentic turn after the first. The model's
echo is probabilistic, which is why it read as an intermittent model problem.

### The diagnostic tell

**The leaked ids are the model's own, never `toolu_*`.** Claude Code mints `toolu_…`; a serializer
preserves it byte-for-byte. The fatal samples carried `"id":"Grep:0"` (Kimi's native `NAME:IDX`
form) and RFC-4122 uuids, string-typed numerics (`"limit":"120"` — a serializer preserves JSON
types, a model writing JSON prose does not), and one sample was structurally impossible for the
serializer (`command`/`description` hoisted out of `input`, truncated mid-string, outer
`"type":"text"`). That is the proof the text is the model echoing, not the relay flushing a buffer.

Secondary tells: the client sees `stop_reason: end_turn` with a JSON blob as the answer; the run
did substantial real work first; and a following `error/protocol` — "API Error: Server error
mid-response" — is a *consequence*, not the leak. Committed text forecloses failover
(`src/stream-commit.ts`), so any later upstream break lands post-commit. One captured run leaked
with `exit=0` and no mid-stream error at all: **the leak alone destroys the run.**

### The fix

The request direction is now **relay-owned**: `src/openai-request.ts`
(`anthropicRequestToOpenAi`) is a deterministic Anthropic-Messages → OpenAI-Chat request mapper,
the mirror of the response-direction `anthropicMessageToOpenAi` already in `backend.ts`, and
`fetchBackend()` calls it instead of llm-bridge. `tool_use` becomes `tool_calls`, each
`tool_result` becomes its own `{role:"tool", tool_call_id, content}` message, and anything the
mapper cannot represent is REFUSED with a clean local 400 — the `documents.ts` precedent, because
a mangled prompt reads exactly like a working one. llm-bridge stays for the RESPONSE direction,
where it is correct and heavily covered.

Not fixed by patching llm-bridge: 2.0.1 is current and this is `universalToOpenAI`'s
documented-by-omission behaviour, so the relay would stay one dependency bump from regressing.

⚠ **And deliberately not fixed on the response side.** No JSON marker was added to
`DIALECT_MARKERS`. An arbitrary JSON object is not a closed envelope, and promoting one to a
`tool_use` would be fabricating intent — the one thing `src/tool-dialects.ts` must never do. A
contract test in `test/dialect-stream.test.ts` pins that such text reaches the client as text.

### What changed on the wire

Every `openai`-kind target now receives a different (smaller, correctly linked) request body:

- prompts shrink roughly threefold on agentic turns, and provider prompt caches miss once;
- `role:"tool"` messages appear where there were none — each carrying the caller's own function
  `name` (looked up from the `tool_use` it answers, never invented), because gemini's
  OpenAI-compatible layer folds a tool message into a `functionResponse` part whose `name` is
  required and never resolved from the preceding `tool_calls` — so a stricter host may now behave
  *differently* — better, but differently;
- **`stop` is a NEW field.** llm-bridge never sent one — `universalToOpenAI` does not read
  `provider_params.stop_sequences` — so a caller's `stop_sequences` silently did nothing and now
  binds. It is forwarded uncapped: OpenAI Chat documents a maximum of **4**, so a request carrying
  more can now be rejected by a strict host. That is an *upstream* 400, so it walks the pool (and
  per CLAUDE.md records a breaker failure on each candidate) rather than dying locally — an honest
  error, where silently dropping the 5th sequence would change what the model may emit;
- **system text blocks now join with `\n\n`, not llm-bridge's single space.** That is the largest
  and most cache-sensitive span of every request, so this is the change most likely to be visible
  as a one-off prompt-cache miss. The blocks are independent documents (harness preamble, project
  instructions) and a space ran the last word of one into the first word of the next;
- an image inside a `tool_result` is no longer sent as a stringified blob **and is not refused
  either**: an OpenAI tool message is text only, so the tool message carries the result's text and
  the image rides as an `image_url` part on the `{role:"user"}` message that follows the turn's
  tool messages. A host with no vision answers with its own upstream 400, which fails over;
- a request carrying a content block the mapper does not model (a new Anthropic block type) now
  returns a clean **400** naming the block instead of silently shipping a stringified blob.
  `kind: "anthropic"` passthrough is untouched, and so is the OpenAI front's Chat→Chat
  passthrough, which never enters this mapper.

Coverage: outbound-shape tests in `test/backend.test.ts`, a ≥2-candidate walk in
`test/pool-failover.test.ts` (the mapper runs once per candidate, so a single-candidate test would
prove nothing), and the response-side contract test above.

### The Responses-front sibling (2026-08-23)

The same class of defect, on the other front, found while auditing the fix above. `/v1/responses`
requests were handed to llm-bridge's `translateBetweenProviders("openai-responses", "anthropic", …)`,
whose `openaiResponsesToUniversal` models exactly one tool-shaped input item — `function_call_output`.
So on a Codex multi-turn tool conversation:

- a `function_call` input item (the assistant's OWN tool call) carries no `role`. It was defaulted to
  `"user"`, and its absent `content` became `[{type:"text", text: undefined}]`. **The tool call
  vanished**, leaving the `tool_result` that followed with nothing to answer: an `anthropic`-kind
  target 400s on a `tool_result` with no matching `tool_use`, and an `openai`-kind target received a
  `role:"tool"` message with no `tool_calls` before it. Every Responses tool conversation was broken
  past the first call, on both backend kinds;
- an assistant `message` whose parts are `output_text` hit `parseResponsesContent`'s fall-through and
  reached the backend as `JSON.stringify(part)` — **the assistant's own prior answer delivered as a
  JSON string**, which is the leak above in miniature;
- a `reasoning` item (Codex sends one before most turns) became a bogus user turn;
- `instructions` — Codex's system prompt — was read by nobody and dropped entirely;
- `reasoning.effort` became `thinking: {budget_tokens: 10240}`, a token budget nobody stated.

**The fix is the same shape:** `src/responses-request.ts` (`openaiResponsesRequestToAnthropic`) owns
that direction now, sharing `RequestMappingError` with `openai-request.ts`. `function_call.call_id`
becomes `tool_use.id` and `function_call_output.call_id` becomes `tool_result.tool_use_id`, so the id
this relay minted on the way out (`anthropicMessageToOpenAi` sets `call_id` = the Anthropic
`tool_use` id) survives the whole round trip and reappears as `tool_calls[].id` /
`tool_call_id` for an `openai`-kind target. Consecutive same-role items merge into one turn;
`reasoning` and `reasoning.effort` are dropped; `previous_response_id`, a `text.format`
structured-output contract and any unmodelled item type are REFUSED as a clean local 400 rather than
silently reshaping the conversation. llm-bridge keeps the CHAT request direction — `openaiToUniversal`
does handle `tool_calls` and `role:"tool"` — and every response/stream direction.

Coverage: `test/responses-request.test.ts` (the pure mapper), and on the front,
`test/openai-front.test.ts` §"Responses front — relay-owned request translation" (both backend
kinds, buffered and streamed, a ≥2-candidate failover walk, and the two zero-egress refusals).

## Third mechanism (2026-08-23) — a non-unique identifier, not a leaked envelope

A sibling of the two above, and the one they make easy to misread. Nothing is mangled here and no
notation leaks: the wire shape is correct in both directions. What is wrong is an **identifier**.

`nim/moonshotai/kimi-k3` — the relay's top free agentic target — emits OpenAI `tool_calls[].id`
values of the form `<ToolName>:<index within this response>`: `Read:0`, `Bash:0`, `Read:1`. Those
are unique inside one response and **collide across turns**: every turn that reads a file again
calls its first tool call `Read:0`. The relay forwarded the id as the Anthropic `tool_use.id`
(`openAiResponseToAnthropic`, and llm-bridge's SSE translation for streams).

Claude Code (2.1.237) runs a conversation normalizer when it **builds every API request**: it walks
the messages keeping a Set of `tool_use` ids, DROPS any `tool_use` whose id it has already seen,
substitutes the text `[Tool use interrupted]` when that empties an assistant turn, and patches the
now-orphaned `tool_result`s. Consequences, all observed on 2026-08-23:

- the model never sees its own earlier tool calls on any turn after the first repeat — its context
  is silently mangled. This is the "weak agentic loop" seen on kimi lanes: re-reading the same file
  with overlapping offsets, and `No response requested.`;
- eventually the freshly returned assistant message is itself emptied to `[Tool use interrupted]`
  and a headless `claude -p` turn ends with no tool to run. Three lanes died exactly this way, with
  ids `Bash:0, Read:0, Read:0, Read:0, …` and a final assistant content of
  `[{"type":"text","text":"[Tool use interrupted]"}]`.

### Why the fix is id minting at the seam, and not a `DIALECT_MARKERS` change

Nothing about this is a dialect. The host populated `tool_calls` properly; the relay parsed them
properly. Recovery machinery would have nothing to recover, and adding a marker for it would be the
fabricated-intent mistake §"Second mechanism" already warns about.

An identifier is **protocol form**, which is exactly what the repair boundary puts on the relay's
side of the line: the proxy fixes form, never judgment. A minted id is relay metadata of the same
kind as the `chatcmpl_relay`, `tool_call_${n}` and `tu_recovered_${i}` ids `backend.ts` already
mints. So `src/tool-use-ids.ts` gives a colliding id the smallest free `<id>_relay<k>` —
deterministic, no randomness — at the openai-kind translation seam only, buffered and streamed,
after dialect recovery and before anything that watches for the first `tool_use` (validation,
repair, and `guardReshaped`'s structural conservation check all see the ids the client will).

**No reverse mapping exists, by construction.** The client echoes whatever id it received back in
both the assistant `tool_use` and the user `tool_result` of the next request, and
`src/openai-request.ts` forwards those verbatim as `tool_calls[].id` / `tool_call_id`. The backend
therefore sees a self-consistent pair while the relay remembers nothing between requests — no
store, nothing that can go stale, nothing to reconcile after a failover to a different candidate.

Announced, because an automatic fix must be: `x-llm-relay-tool-use-ids: "<n> rewritten"` on a
buffered response, and the metadata-only `toolUseIdRewrites` counter in the log for a stream, whose
headers are written before its first tool call exists. A count, never an id.

Confined deliberately: a native Anthropic response is byte-exact passthrough and never enters the
pass, and the OpenAI front's direct Chat passthrough is left alone — a different client with no
such normalizer, and byte-exactness there is the whole point of the path.

Diagnostic tell: `[Tool use interrupted]` as the final assistant text of a headless run, with
`Read:0`-style ids repeating across turns in the transcript. Contrast the second mechanism's tell —
leaked ids that are the model's own (`Grep:0`, a uuid) rather than `toolu_*`.

Coverage: `test/tool-use-ids.test.ts` (the pure table and the SSE transform),
`test/backend.test.ts` (buffered, streamed, dialect-recovered, native passthrough, and the
round-trip that pins "no reverse map needed"), a ≥2-candidate walk in `test/pool-failover.test.ts`
(the pass runs on whichever candidate serves), and the streamed end-to-end log assertion in
`test/server.test.ts`.
