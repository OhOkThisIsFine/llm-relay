---
title: "Deferred Commit Design — §1.1 Remainder"
date: 2026-08-14
status: advisory
authoring_lane: "Codex"
caveat: "This is an ADVISORY lane deliverable. File:line claims must be re-verified at implementation time."
---

# Deferred Commit Design — §1.1 Remainder

**Reference:** [docs/freellmapi-adoption-review-2026-08-13.md](freellmapi-adoption-review-2026-08-13.md) §6 Item 1
**Background:** [docs/pool-failover.md](pool-failover.md) (*"two paths, one policy empty"*)
**Source Fronts:** Anthropic front (`POST /v1/messages`) and OpenAI front (`POST /v1/chat/completions` and `POST /v1/responses`) in [src/server.ts](../src/server.ts).

No files were modified. The status banner accurately describes the remaining gap: the first-event check landed, but full header deferral remains open on both fronts ([docs/freellmapi-adoption-review-2026-08-13.md:26-35](../docs/freellmapi-adoption-review-2026-08-13.md)).

## Recommended design

Add a second, final-wire commit probe. Keep the existing structural `preflightResponseStream`; it protects the response mappers and deliberately returns after the first structurally valid event ([src/backend.ts:225-318](../src/backend.ts#L225-L318)). The new probe must run after all translation and dialect recovery, immediately inside each candidate loop, before any client `writeHead`, `write`, `end`, or stall-watchdog phase switch.

Use a tagged result:

```ts
type StreamCommitProbe =
  | { kind: "ready"; body: ReadableStream<Uint8Array> }
  | { kind: "dead"; reason: string; provenance: "upstream" | "local" }
  | { kind: "cancelled" };
```

Like the current preflight, it buffers raw chunks and returns a replay stream, preserving bytes exactly rather than reserializing SSE ([src/backend.ts:230-255](../src/backend.ts#L230-L255)). A failed probe cancels its reader and releases the candidate socket ([src/backend.ts:258-260](../src/backend.ts#L258-L260)).

### 1. Commit-point contract

The probe operates on the client-facing protocol:

| Front | Meaningful content—the first event that permits commit | Held/non-meaningful before commit |
|---|---|---|
| Anthropic `/v1/messages` | A non-whitespace `text_delta`; a non-whitespace `thinking_delta`; a substantive opaque/redacted-thinking block; or a structured `tool_use` carrying a non-empty name/id. | `message_start`, `ping`, empty text-block starts, role/usage metadata, stop events, empty deltas. These are currently accepted structurally by `invalidEnvelopeReason`, including `ping`, `message_stop`, and block stops ([src/backend.ts:202-217](../src/backend.ts#L202-L217)). |
| OpenAI Chat Completions | Non-whitespace `delta.content`, `delta.refusal`, `delta.reasoning_content`/`delta.reasoning`, or a `delta.tool_calls` entry containing an id, function name, or argument bytes. | Role-only deltas, empty choices with usage, empty deltas, finish-only frames, comments and `[DONE]`. The current structural validator explicitly accepts usage-only empty choices ([src/backend.ts:164-189](../src/backend.ts#L164-L189)). |
| OpenAI Responses | Non-whitespace output/refusal/reasoning delta; a substantive function-call item; or a completed response whose `output` contains text or a function call. | `response.created`, `response.in_progress`, empty item/content skeletons, usage-only events, and completion metadata without output. The Responses surface is selected alongside Chat at [src/server.ts:1320-1324](../src/server.ts#L1320-L1324), and translated Responses SSE is produced at [src/backend.ts:932-935](../src/backend.ts#L932-L935). |

A non-whitespace rule is necessary: otherwise whitespace before a dialect marker would commit the response and defeat invisible failover. Metadata is not content merely because it is structurally valid—the existing first slice currently commits at exactly that weaker boundary ([src/backend.ts:310-314](../src/backend.ts#L310-L314)).

Before meaningful content:

- Any Anthropic `error` event, OpenAI `{error:…}` data frame, `response.failed`, or equivalent is a retryable dead turn. This extends the existing first-event rule at [src/backend.ts:150-161](../src/backend.ts#L150-L161) across arbitrary preamble events.
- EOF, `[DONE]`, `message_stop`, or `response.completed` without output is an empty completion and a retryable 502.
- Malformed SSE/JSON is a retryable upstream 502 unless the error is tagged as a relay mapper defect.
- After meaningful content, all subsequent errors remain post-commit and must be delivered honestly without replay or failover, preserving the rule pinned at [test/pool-failover.test.ts:957-969](../test/pool-failover.test.ts#L957-L969).

Bounds:

- Hold at most **64 KiB of raw final-wire prefix**, reusing the existing `STREAM_PREFLIGHT_LIMIT` value ([src/backend.ts:133-135](../src/backend.ts#L133-L135)). If no meaningful content appears by then, cancel the candidate and fail it as `502 no meaningful content within commit probe limit`; never flush the prefix merely to escape the bound.
- On tool-bearing requests, dialect ambiguity is limited to **256 UTF-16 code units**, matching freellmapi's decision ceiling (`C:/Code/freellmapi/server/src/lib/inbound-chat.ts:373-380`; `C:/Code/freellmapi/server/src/routes/proxy.ts:2003-2010`).
- A positively detected dialect envelope also counts against the 64 KiB pre-commit cap. A larger envelope fails cleanly instead of creating unbounded capture; current dialect recovery otherwise accumulates the full envelope until termination ([src/dialect-stream.ts:164-169](../src/dialect-stream.ts#L164-L169)).

Dialect probing must be front-aware. The Anthropic translation path already applies `recoverDialectInStream` after OpenAI-to-Anthropic conversion ([src/backend.ts:457-464](../src/backend.ts#L457-L464)), and that wrapper emits a protocol error when recovery is impossible ([src/dialect-stream.ts:105-116](../src/dialect-stream.ts#L105-L116)). The final-wire probe will hold its preamble and see that error before content.

The OpenAI direct Chat path is currently deliberately byte-transparent and bypasses that recovery ([src/backend.ts:839-859](../src/backend.ts#L839-L859)), so satisfying "both fronts" requires an OpenAI-native dialect adapter:

- Hold initial text while it can be a known marker.
- Run the existing detector/recovery vocabulary, whose broad marker set intentionally recognizes truncated closing tails ([src/tool-dialects.ts:35-80](../src/tool-dialects.ts#L35-L80)).
- On valid recovery, emit native Chat `tool_calls` SSE, or feed an Anthropic `tool_use` sequence through the existing Anthropic→Responses mapper.
- On detected-but-unparseable recovery, return `dead` without committing.

Also add an OpenAI-aware tool-request detector. The current `toolSchemaMap` recognizes only Anthropic `{name,input_schema}` tools, so `hadTools` is false for ordinary OpenAI `{type:"function",function:{…}}` requests ([src/anthropic.ts:84-102](../src/anthropic.ts#L84-L102); [src/server.ts:357-358](../src/server.ts#L357-L358)).

### 2. Exact `writeHead` placement

#### Anthropic front

Current sequence:

1. Receive/classify candidate response ([src/server.ts:604-674](../src/server.ts#L604-L674)).
2. Clear the total timer and install the stall watchdog immediately on an SSE 200 ([src/server.ts:676-684](../src/server.ts#L676-L684)).
3. Enter repair or transparent handling ([src/server.ts:685-695](../src/server.ts#L685-L695)).
4. Transparent mode commits immediately at function entry ([src/server.ts:1558-1573](../src/server.ts#L1558-L1573)); repair mode commits through `ensureHead`, normally on the replayed `message_start` ([src/server.ts:1695-1713](../src/server.ts#L1695-L1713), [src/server.ts:1745](../src/server.ts#L1745)).
5. Return from the candidate loop unconditionally ([src/server.ts:696](../src/server.ts#L696)).

Proposed sequence at the [src/server.ts:676](../src/server.ts#L676) anchor:

1. Determine `streamed`.
2. For a successful stream, run the final Anthropic commit probe **while the original per-candidate timer remains armed**.
3. On `dead`, complete the attempt as `failure:"protocol"`, provenance `invalid-upstream-envelope`, logical status 502; call `pool429.recordFailover(502, null)`; then use the existing next-candidate and walk-budget checks before continuing ([src/server.ts:662-673](../src/server.ts#L662-L673), [src/server.ts:823-837](../src/server.ts#L823-L837)).
4. On `cancelled`, complete the attempt as client-cancelled and leave the loop.
5. On `ready`, replace the body with its replay stream, then perform the §1.2 phase switch currently at [src/server.ts:677-684](../src/server.ts#L677-L684).
6. Only now call `pool429.recordFinal(200)`, compute winning-candidate headers, and execute the streamed `writeHead`.
7. Pump the replay body through repair or transparent handling.

Physically centralize successful streamed `writeHead` in this ready branch. Remove the streamed use of `transparentPath`'s unconditional head at [src/server.ts:1573](../src/server.ts#L1573), and make `repairStreamingPath.ensureHead` idempotent against an already-committed response or remove it ([src/server.ts:1704-1709](../src/server.ts#L1704-L1709)). Buffered and HTTP-error paths keep their existing write timing.

#### OpenAI front

Current sequence:

1. Fetch and status-classify at [src/server.ts:1404-1468](../src/server.ts#L1404-L1468).
2. Declare the candidate terminal before reading its stream ([src/server.ts:1470-1476](../src/server.ts#L1470-L1476)).
3. Switch timers at [src/server.ts:1477-1482](../src/server.ts#L1477-L1482).
4. Build headers at [src/server.ts:1484-1498](../src/server.ts#L1484-L1498).
5. Commit a successful stream at [src/server.ts:1522](../src/server.ts#L1522), then read it.

Insert the final Chat/Responses probe at [src/server.ts:1476](../src/server.ts#L1476), before both the timer switch and header construction:

- `dead`: complete as a synthetic protocol 502, count it with `pool429.recordFailover(502,null)`, and continue under the same guards used at [src/server.ts:1453-1467](../src/server.ts#L1453-L1467).
- `cancelled`: stop without another candidate.
- `ready`: switch to the stall watchdog, build headers for this candidate, call `pool429.recordFinal(200)`, then execute the existing successful `writeHead` and replay pump at [src/server.ts:1522-1528](../src/server.ts#L1522-L1528).

If the failed probe is terminal because it is the last candidate or the walk budget forbids another start, emit a protocol-correct HTTP 502. The Anthropic envelope can use the shape currently produced by `failClosed` ([src/server.ts:2311-2317](../src/server.ts#L2311-L2317)); the OpenAI envelope should follow the normalization path used at [src/server.ts:1499-1514](../src/server.ts#L1499-L1514).

### 3. Edge interactions

- **Client disconnect pre-commit:** Both loops already attach `res.close` to the attempt controller ([src/server.ts:572-579](../src/server.ts#L572-L579), [src/server.ts:1374-1379](../src/server.ts#L1374-L1379)) and stop when `res.destroyed` ([src/server.ts:569-570](../src/server.ts#L569-L570), [src/server.ts:1368-1369](../src/server.ts#L1368-L1369)). A probe read rejected while `res.destroyed` must return `cancelled`, not `dead`: cancel the upstream reader, complete the health handle through `completeAttemptCancelled`, and never start the next candidate ([src/server.ts:1305-1318](../src/server.ts#L1305-L1318)).

- **Keepalive/heartbeat while headers are withheld:** Buffer SSE comments, Anthropic `ping`, role-only chunks, and usage frames. Do not send a downstream heartbeat: any `write` or `flushHeaders` would irrevocably commit. Endless heartbeats remain bounded by the absolute pre-commit timer and 64 KiB prefix cap; they must not extend either.

- **§1.2 timer interaction:** The current implementation disarms the total timer as soon as it sees an SSE HTTP response ([src/server.ts:676-684](../src/server.ts#L676-L684), [src/server.ts:1477-1482](../src/server.ts#L1477-L1482)). Move that switch after semantic readiness. Thus `timeoutMs` becomes connect-to-first-meaningful-content grace, while `stallTimeoutMs` begins only at commit. After commit, the current watchdog re-arms on every byte ([src/server.ts:852-874](../src/server.ts#L852-L874)). With `stallTimeoutMs:0`, retain the existing whole-stream total deadline contract ([src/server.ts:840-850](../src/server.ts#L840-L850)).

- **Repair path:** Run the outer probe before `repairPath`, so empty streams, early errors, and bad dialects never spend a reshaper call ([src/server.ts:685-690](../src/server.ts#L685-L690)). Once the probe finds a native structured `tool_use`, repair behavior remains unchanged. Do not make an unrepaired schema-invalid tool call resume the candidate walk in this slice: that remains the separate owner decision in §2.1 ([docs/freellmapi-adoption-review-2026-08-13.md:184-190](../docs/freellmapi-adoption-review-2026-08-13.md)). Valid or recovered tool-only streams may therefore commit and then use the current repair/error behavior ([src/server.ts:1799-1825](../src/server.ts#L1799-L1825)).

- **Per-candidate headers:** Compute response headers only after the winning candidate reaches `ready`. `x-llm-relay-pool-attempts` must include semantic failures as synthetic 502s and the winner as 200; its existing format counts status occurrences and served statuses ([src/server.ts:940-970](../src/server.ts#L940-L970)). A two-member walk should therefore say `2 tried, 1 served: 1x502, 1x200`.

  `x-llm-relay-degraded`, paid-status, and served-by must describe only the committed candidate, never a rejected prefix. Their current OpenAI assembly is already candidate-local ([src/server.ts:1484-1494](../src/server.ts#L1484-L1494)); Anthropic transparent assembly is at [src/server.ts:1558-1572](../src/server.ts#L1558-L1572). Centralizing streamed header construction also closes the current repair asymmetry, where `repairStreamingPath` starts only from filtered upstream headers and does not add the pool/degraded/paid fields ([src/server.ts:1695-1707](../src/server.ts#L1695-L1707)).

### 4. New failure modes and bounds

- **Higher time-to-headers:** Clients now wait through protocol preamble and initial reasoning metadata. Count real reasoning as meaningful and enforce `timeoutMs`; this mirrors freellmapi committing on reasoning deltas (`C:/Code/freellmapi/server/src/lib/inbound-chat.ts:385-390`).
- **Healthy but large preamble/tool call rejected:** The 64 KiB cap can reject an unusually large first structured call. Keep the cap fixed and emit a distinct diagnostic reason so operators can distinguish a safety bound from malformed SSE.
- **Unknown future event misclassified as empty:** Treat unknown Anthropic content-block types with substantive payload, and unknown OpenAI `*.delta` output events with a non-empty payload, as meaningful. Do not treat unknown metadata-only events as content.
- **Loss of byte transparency:** Classification must decode only for inspection and replay the original raw chunks. The current preflight's chunk replay is the model ([src/backend.ts:231-255](../src/backend.ts#L231-L255)).
- **Duplicate or reordered prefix:** The replay stream must emit each buffered chunk exactly once before resuming the same locked reader. Add byte-exact tests with multiple SSE events in one chunk and boundaries split across chunks; current parsing already handles CRLF/LF separators and fragmented reads ([src/backend.ts:281-315](../src/backend.ts#L281-L315)).
- **Misattributed health:** A semantic dead turn is a protocol/upstream failure, not a successful HTTP 200. Complete it through the existing failure lifecycle ([src/server.ts:1278-1303](../src/server.ts#L1278-L1303)). Mapper defects must remain local and terminal, consistent with the OpenAI front's existing no-repeat rule ([src/server.ts:1442-1451](../src/server.ts#L1442-L1451)).
- **Error/content in one transport chunk:** Ordering is event-based, not chunk-based. Error-before-content fails invisibly; content-before-error commits and forwards the later error.

## 5. Test plan

Use `createServer` backends and a real proxy listener, matching [test/pool-failover.test.ts:56-70](../test/pool-failover.test.ts#L56-L70), [test/mid-stream-failure.test.ts:30-46](../test/mid-stream-failure.test.ts#L30-L46), and the review's real-socket requirement ([docs/freellmapi-adoption-review-2026-08-13.md:383-392](../docs/freellmapi-adoption-review-2026-08-13.md)).

1. **Commit-probe unit tests**

   Cover Anthropic, Chat, and Responses classifiers; LF/CRLF; multi-line `data:`; UTF-8 split across chunks; exact byte replay; error-before-content versus content-before-error; empty termination; reasoning; native tool calls; 256-character dialect decision; and the 64 KiB hard limit. The existing preflight event splitter provides the fixture style ([src/backend.ts:263-315](../src/backend.ts#L263-L315)).

2. **Cross-front real-server matrix**

   For `/v1/messages`, `/v1/chat/completions`, and `/v1/responses`, candidate A returns HTTP 200 plus:

   - protocol preamble followed by an in-band error;
   - clean termination without meaningful content;
   - a tool-bearing truncated dialect envelope;
   - a valid dialect envelope;
   - meaningful content followed by an error.

   Candidate B returns valid content. Assert A and B call counts, winning status/body, absence of A bytes, breaker outcomes, and `x-llm-relay-pool-attempts`. Preserve the existing invariant that every failover test has at least two candidates ([test/pool-failover.test.ts:14-26](../test/pool-failover.test.ts#L14-L26)).

3. **Header-withholding assertion**

   Have A send upstream headers and preamble, signal the test, then pause. Race the client's `fetch()` promise against a short sentinel and assert it has not resolved—`fetch` resolves when downstream headers arrive. Release meaningful content and assert the same request then resolves with the exact buffered prefix and content.

4. **Hanging sockets**

   - **Pre-commit silence:** A writes headers and only preamble, then leaves the socket open. Its short `timeoutMs` must abort it and fail over to B.
   - **Pre-commit heartbeats:** A sends `ping`/comments every 20 ms but no payload. It must still hit the absolute pre-commit timeout; heartbeats must not activate or re-arm the stall watchdog.
   - **Pre-commit socket reset:** A writes preamble then calls `res.socket.destroy()`. B must serve invisibly.
   - **Post-commit silence/reset:** A first sends a non-empty content delta, then stalls or destroys the socket. B must not be called; the client receives the protocol-specific mid-stream error.

   Existing helpers need adjustment: `truncatingSseBackend` currently emits only `message_start` and an empty block before destroying the socket ([test/mid-stream-failure.test.ts:35-46](../test/mid-stream-failure.test.ts#L35-L46)), which becomes pre-commit under this design. Add a non-empty text delta for tests that intend to exercise post-commit failure. Likewise, `slowHealthySseBackend` currently emits only pings and `message_stop` ([test/mid-stream-failure.test.ts:254-269](../test/mid-stream-failure.test.ts#L254-L269)); it must emit real content to remain a healthy-completion fixture.

5. **Client disconnect**

   Wait until candidate A has sent preamble, then destroy the real client request/socket. Assert B is never called, A's attempt is cancelled rather than failed, and no provider cooldown/logged protocol failure appears. The existing immediate-abort test establishes the policy but does not pin the pre-commit race after upstream activity ([test/pool-failover.test.ts:342-364](../test/pool-failover.test.ts#L342-L364)).

6. **Header provenance**

   Make A fail semantically and B be in the configured degraded tail. Assert the successful response carries B's degraded/paid/served-by values and `1x502, 1x200`; assert no upstream header or cookie from A leaks. Repeat in repair mode to pin the current repair-header gap at [src/server.ts:1695-1707](../src/server.ts#L1695-L1707).
