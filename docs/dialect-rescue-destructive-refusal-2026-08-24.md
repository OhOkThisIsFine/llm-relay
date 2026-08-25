# Destructive-tool refusal at the dialect-rescue commit point

**Status: implemented 2026-08-24.** Closes the one open safety-shaped code gap carried in
HANDOFF §6 since 2026-08-22, recorded as ADOPT (high) in
[status-vs-freellmapi-2026-08-16.md](status-vs-freellmapi-2026-08-16.md) §3.1 and as
recommendation 2 in its §6 table.

## 1. The gap

`destructive` appeared in exactly five `src/` files — `cli.ts`, `config.ts`, `log.ts`, `repair.ts`,
`server.ts` — and in **none** of `tool-dialects.ts`, `openai-dialect.ts`, `dialect-stream.ts`.
So the "destructive tool calls are refused, never fabricated" invariant bound only inside
`repair()`: its pre-reshape gate (`repair.ts:52`) and `guardReshaped` (`repair.ts:323`).

A tool call **recovered from assistant prose** by the dialect-rescue path reached the client
unfiltered whenever it validated cleanly. Claude Code declares `Bash`; repair output may run under
`--dangerously-skip-permissions`. The relay's real guarantee was therefore narrower than the docs
implied: fail-clean refusal of a **malformed** destructive call, and nothing at all for a
well-formed one the relay itself reconstructed out of text.

The suite pinned the gap rather than catching it. `test/openai-dialect-passthrough.test.ts`
carried a test named *"validates a recovered destructive call without refusing or reshaping it"*,
asserting HTTP 200 for a DSML-recovered `write_note` call under
`destructiveTools: ["write_note"]`. That is the case CLAUDE.md warns about — a test written to pin
the defect it should have caught — so the test and the source fix land in the same commit.

## 2. Why rescue is different from a native tool call

A backend that emits native `tool_calls` has stated its own protocol-level intent; the relay
forwards it, and the destructive list has never governed that. Dialect rescue is the relay
**deciding that model text IS a tool call**. For an ordinary tool that promotion is protocol
repair, which is exactly what `tool-dialects.ts` exists to do. For a tool on the operator's
destructive list it is the relay authoring a destructive call the host never made — the thing the
invariant forbids.

## 3. Policy

A recovered call whose name matches `destructiveMatcher(cfg.repair.destructiveTools)` is
**refused whole**, not committed and not partially stripped.

- **Whole, never partial.** Dropping the destructive call and committing the rest would silently
  change the model's intent — the same reasoning `guardReshaped`'s structural-conservation rule
  rests on (an added, dropped or re-pointed call is a contract violation, not a repair).
- **Terminal — it never fails over, and never charges the deployment.** An unparseable envelope
  fails over on purpose (`origin: "upstream"`, 502 retriable) so the walk reaches a host that
  parses its own models' dialect. A destructive refusal is the opposite kind of event: it is a
  **config** decision, not a health signal, so it carries `origin: "local"` — which makes
  `localFailure` true at `server.ts:1537`, `tryNext` false, and the walk outcome
  `{ kind: "local" }` rather than `deployment`/`credential`. This mirrors two existing rules: a
  hard cap "never registers on the breaker — it is config, not health", and `refused_destructive`
  in the repair path "remains a fail-clean 502 and never rerolls another candidate"
  (`test/pool-failover.test.ts:1165`). Walking the pool would also re-ask N models to produce the
  same refused action and spend quota on a decision already made.
- **Announced.** Automatic behaviour on this path is always announced — the existing rule behind
  `x-llm-relay-degraded`, `x-llm-relay-tool-dialect: recovered` and `x-llm-relay-tool-call-ids`.
  Buffered refusals carry `x-llm-relay-tool-dialect: refused-destructive` and an error body typed
  `tool_dialect_refused_destructive`; on a streamed path the head is often already flushed, so the
  announcement is the mid-stream SSE `error` event carrying the same code — the shape the
  unparseable case already uses.

  ⚠ **The streamed PRE-COMMIT case needed extra work to say the same thing, and it was done**
  (2026-08-25, after the v0.46.0 release). When the envelope arrives before any meaningful content
  no head has been written, so the commit probe classifies the refusal and each front synthesizes
  its own 502 through the shared fail-closed path — which produced an anonymous `api_error` with
  neither header, while the buffered lanes announced properly. That is the asymmetry this whole
  change exists to remove, so the fix is the plumbing, not a caveat: the probe's dead verdict
  carries an optional `errorType`, set only by `errorVerdict` and only for a relay-authored
  refusal; `failClosed` takes it with `api_error` as the default, so every other caller is
  byte-identical to before; and both fronts add `x-llm-relay-tool-dialect: refused-destructive`.
  While there, both fronts now also write `x-llm-relay-error-origin` from `probe.provenance` on
  ANY dead pre-commit stream — that header's documented job is to say who produced the status, and
  this path had simply never written it.

  ⚠ **The provenance that makes the refusal terminal is DECLARED, never read off the wire.** The
  error code travels on the stream, so an upstream can emit it — on an `anthropic`-kind target the
  body is a byte passthrough and the dialect wrapper never runs at all, so every occurrence there
  is the upstream's. Classifying on the bytes let a counterparty mint `local` for itself, which
  both suppresses failover (black-holing a request a healthy sibling would have served) and exempts
  it from breaker accounting, since `relay-mapper-defect` outcomes are dropped. So
  `DialectRefusalSignal` is set only by the wrapper that pushed the event, travels to the probe in
  a `WeakMap` keyed by the `Response` rather than on the wire, and `stream-commit.ts` requires BOTH
  the signal and the code. Same rule as `credentialState()`: declared, never inferred from what the
  counterparty sent. Pinned by "does not let an upstream forge the refusal code to suppress
  failover".
- **The tool NAMES are announced, bounded; the arguments never are.** The recovered arguments are
  model-authored content and stay out of the header, the body and the log (`logs are metadata
  only`). The names are *admitted* by the operator's list but *authored* by the model — an exact
  pattern yields exactly what the operator wrote, while a prefix pattern (`git_*`) admits arbitrary
  text after the prefix. So `describeRefused()` bounds the rendering once, for all four seams (five
  names, 64 chars each, `+K more` beyond), the same reasoning as `stream-commit.ts`'s
  `boundedError`. The response HEADER value is a fixed literal and never carries a name, so no tool
  name can reach a header value.
- **No log field, deliberately.** The header and the error body carry the refusal on all four
  seams, and the metadata log records the 502 like any other. A log counter would have to be
  plumbed through `attachUpstreamMetadata` on the buffered lanes and a mutable stream counter on
  the streamed ones; doing it on only some of them would recreate the asymmetry this change exists
  to remove, and doing it on all four buys nothing the wire does not already say.

## 4. Where the policy lives

**Inside `recoverToolCalls`, as a required parameter** — one policy, one place. The repo has paid
twice for the alternative ("Two paths, two policies, one of them empty"), and there are **four**
rescue commit points, not the two the original review named:

| # | Seam | Call site |
|---|---|---|
| A | buffered, Anthropic-shaped translation | `backend.ts` `openAiResponseToAnthropic` |
| B | streamed, Anthropic-shaped translation | `dialect-stream.ts` `recoverDialectInStream` |
| C | buffered, direct OpenAI Chat passthrough | `openai-dialect.ts` `inspectDialectInOpenAiChat` |
| D | streamed, direct OpenAI Chat passthrough | `openai-dialect.ts` `recoverDialectInOpenAiChatStream` |

`recoverToolCalls` gains a third **required** parameter `isDestructive: (name: string) => boolean`
and a fourth `DialectOutcome` member `{ status: "refused-destructive"; dialect; refused: string[] }`.
Required, not optional: an optional parameter reproduces exactly the failure mode being fixed — a
new rescue seam that silently omits the policy. The matcher is threaded from the one place it is
already built (`createProxy`, `server.ts:300`) down through `fetchBackend` / `fetchOpenAiFront`,
whose args also make it required, so the compiler enumerates every call site.

This is still **parsing, not judgment**: a set-membership test on a tool name the operator
configured. No LLM opinion enters the request path, and the relay never inspects what the
arguments *mean* — the line `repair.ts` already draws ("Deliberately NOT checked: whether a
permitted tool's repaired arguments *mean* something destructive").

## 5. Consequences to expect

- A free host that leaks a `Bash`/`Write`/`Edit` call as dialect text now yields a clean 502
  (buffered) or a mid-stream `error` event (streamed) instead of a recovered tool call. The
  request is not retried against another pool member.
- With an **empty** `repair.destructiveTools`, nothing is refused — the config list stays the only
  source, exactly as `destructiveMatcher([])` already guarantees.
- A native `tool_calls` response naming a destructive tool is unaffected. So is every
  anthropic-kind passthrough, which never enters a rescue seam.
