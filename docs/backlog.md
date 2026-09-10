# Backlog — llm-relay

> The work queue. Each entry states an unmet **Property** and is deleted once that property is
> met. Shipped work lives in git history and in the dated documents under `docs/`;
> [`../HANDOFF.md`](../HANDOFF.md) holds current state plus the immediate next; `CLAUDE.md` holds
> invariants and rationale. Nothing here is a status log. A machine-wide item (a global hook, a
> shared instruction file, the offload lanes themselves) belongs in `C:\Code\docs\backlog.md`,
> not here.

## Open

- **DeepSeek refuses a multi-turn tool-call replay from the relay with HTTP 400 because the relay
  drops `reasoning_content` between turns (2026-09-09, DeepSeek capture, medium).** In thinking
  mode DeepSeek requires the `reasoning_content` of the assistant turn that made a tool call to be
  replayed with that turn. `openai-request.ts` drops `thinking`/`redacted_thinking` cross-vendor
  ("no representation") and `responses-request.ts` drops Codex's `reasoning` items, so the third
  capture run in
  [`deepseek-responses-truncation-2026-09-09.md`](deepseek-responses-truncation-2026-09-09.md)
  ended at HTTP 400 after one or two tool-call turns. A representation EXISTS for this provider:
  Chat `reasoning_content` on the outbound assistant message. (The same capture's other ancillary
  finding, DeepSeek naming Codex's `exec` argument `cmd`/`command` as a bare string, is the
  model's own shape error and repair mode's business, not a relay defect.) **Property:** on a
  target whose provider declares it (a `compat` key on the `toolCallIds` precedent, defaulting from
  a labelled host fact for `api.deepseek.com`, an explicit value winning both ways), the reasoning
  the relay itself emitted for an assistant turn — a Responses `reasoning` item or an Anthropic
  `thinking` block the CALLER replays — is carried as `reasoning_content` on that outbound
  assistant message byte-for-byte and never fabricated when absent, pinned on ≥2 candidates, with
  every other provider's outbound bytes unchanged.

- **Accept or decline the 26 triaged refusals** (owner-only; triaged 2026-09-09 in
  [`eligibility-triage-2026-09-09.md`](eligibility-triage-2026-09-09.md), which carries every
  verdict pinned to its digest and the exact `accept`/`reject` commands). Nineteen accepts, six
  rejects, one deliberate pending (the groq client-side network block, never rejected by the
  `network-block.ts` rule). Two accepts evict: `nim/moonshotai/kimi-k3` (48 × "degraded function
  cannot be invoked") and seven ollama-cloud paid-plan SKUs seen once each. The dispatcher may
  `propose`; only the owner may `accept`. **Property (what remains):** the owner has run, or
  declined by name, each listed command, so `llm-relay eligibility` shows no item without a
  verdict except item 1, whose pending state is the stated verdict.

- **Route B is built; prove it live on this machine once the daemon runs the release that
  carries it** (route B shipped 2026-09-09: `wire: "responses"` on a `kind: "openai"` provider,
  `src/backend.ts`; the code half of the 2026-09-04 entry is met, tests in
  `test/backend-responses-upstream.test.ts`). The logon-started daemon keeps its old binary until
  the owner's next restart, so the live half waits. **Property (what remains):** the operator's
  `~/.llm-relay/config.json` declares `wire: "responses"` on the `opencode` provider and pins
  `opencode/muse-spark-1.3-contributor-free` as `preferred` in the effort pools (with price-suffix
  resolution landed, the pool may also admit it on its own — check `llm-relay pools`); then one
  real request through `pool/medium` on each front is served by that deployment, with a tool
  call and streaming, and `llm-relay cost` shows its `cached_tokens`. Recorded with the served-by
  header and the date.

- **Verify the Codex `relay` agent end to end in Codex Desktop** (owner-driven, 2026-09-04).
  Commit `e73d113` added `~/.codex/agents/relay.toml` via `scripts/install-skill.mjs`; standalone
  `codex exec` exposes no MCP tools, so only a live Codex Desktop session driven by the owner can
  verify it. **Property:** one Codex Desktop `relay` subagent reply carries a `provenance:` line
  (e.g. spawning `relay` with "read C:\Code\llm-relay\package.json and reply version=<field>"
  returns the version and provenance from a dispatch lane).

- **The Responses front logs a mid-stream stall as a clean `backendStatus: 200` with no
  `errorKinds`, while the Anthropic front logs the same condition as `status: "committed"` plus
  `errorKinds: ["backend_stream_failed"]`** (observed 2026-09-09 in the four-cell measurement
  above, cells 2 vs 4; not diagnosed there because it is a relay log question, not a client one).
  Two fronts, one policy, and the log disagrees about what happened. **Property:** a committed
  stream that the relay's own watchdog aborts logs the same attempt status and the same
  `errorKinds` member on both fronts, pinned by one test that drives both.

- **The dispatch walk has no per-lane CONCURRENCY cap, and `opencode-muse-spark` starves at three
  lanes** (measured 2026-09-09: six fresh packets finished in 101–998 s while one or two ran on that
  lane; three concurrent lanes each wrote nothing for 10–15 minutes and were cancelled by hand —
  the 2026-09-05 683 s no-answer probe was the same lane at the same load). Nothing in
  `dispatch.ts` or `mcp/server.ts` counts the jobs already running on a `cli` rung, so a caller
  that dispatches a third packet gets a lane that will answer none of them, and the walk budget
  (a p80 near 1400 s there) means it waits the whole ceiling before moving. **Property:** a `cli`
  rung may declare `maxConcurrent` (default unbounded, so nothing changes until an operator sets
  it); a dispatch that would exceed it skips that rung for THIS walk with a stated reason, and
  `dispatch_lanes` shows the count in flight beside the budget.
