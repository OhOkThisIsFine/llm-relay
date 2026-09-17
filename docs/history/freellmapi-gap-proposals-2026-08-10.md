# What llm-relay has that freellmapi does not — proposals for the maintainer

**Date:** 2026-08-10
**Method:** source-read of both trees, not inferred.
**freellmapi at:** `origin/main` = `ba39318` (25 commits past the `v0.6.9` tag), read together with the
local `feat/anthropic-passthrough` branch.
**llm-relay at:** `b8515fd` (archived; retired 2026-08-09).

This supersedes the parity table in
[`alternatives-review-2026-08-09.md`](alternatives-review-2026-08-09.md) §"Feature-parity audit",
which is now partly stale — see §1.

---

## 1. Rows the merged PRs already closed

Five capabilities listed as absent yesterday are present today. They should not be raised with the
maintainer.

| Yesterday's claim | Status now |
|---|---|
| No Ajv verdict on tool arguments | **Closed** by #802. `server/src/lib/tool-validate.ts` runs an Ajv-2020 verdict and fails the turn over to another model instead of emitting `input: {}`. Opt-in via `VALIDATE_TOOL_ARGUMENTS`. |
| No pool-walk census | **Closed** by #792. `X-Fallback-Detail` carries the per-hop failover trail with timings, opt-in. |
| Anthropic `document` blocks dropped silently | **Closed** by #793 — for text-shaped sources. See §4.3 for what remains. |
| No context-window advertisement (`"auto" is not a model this version recognizes`) | **Closed.** `server/src/services/model-listing.ts` computes `autoContextWindow` as the max window across available models and advertises it. |
| DB/WAL file permissions unenforced on Windows | **Closed** by #791/#795/#796. |

Everything below was re-verified against current `main` by grep and source-read.

---

## 2. Proposals, ranked

Ranked by *fit to freellmapi's own design*, not by how much llm-relay liked them. Each names where it
would live in the freellmapi tree.

### 2.1 Destructive-tool refusal on the dialect-rescue path — **strongest candidate**

**Gap.** `server/src/lib/tool-call-rescue.ts` does something unusual and valuable: when a model emits
a tool call as *prose* (Kimi/DeepSeek token style, Llama `<function=`, Qwen/Hermes `<tool_call>`, bare
or fenced JSON), it reconstructs a real `tool_calls` entry from that text. freellmapi's own tests for
this path cover `Bash`.

That means the proxy is *synthesizing* a shell invocation from unstructured model output. If the
reconstruction is subtly wrong — a truncated argument, a mis-split delimiter — the client executes
something the model did not actually ask for. There is currently no filter on that path: `grep -ri
destructive server/src` returns nothing.

**What llm-relay did.** A configured set of destructive tool names (`repair.destructiveTools`, exact
case-insensitive match, `*`-suffix for prefix opt-in). For a tool on that list the relay refuses to
fabricate or repair arguments and fails clean, rather than guessing. Source: `src/repair.ts`.

**Why it fits freellmapi.** It is additive, opt-in, and defends a mechanism freellmapi already
shipped and is (rightly) proud of. It does not constrain the common path — the list is empty by
default. It is also the only item in this document that is a *safety* argument rather than a
capability argument.

**Where it goes.** `lib/tool-call-rescue.ts`, gated by a setting alongside `VALIDATE_TOOL_ARGUMENTS`.
**Effort:** small. **Risk:** low.

### 2.2 Learned per-deployment context limits

**Gap.** freellmapi knows a model's context window from the signed catalog (`models.context_window`)
and can reject an oversized request pre-flight (`lib/guardrails.ts`,
`REQUEST_MAX_TOKENS_BUDGET`). What it does not do is *learn* that a given provider will not actually
serve the window it advertises. Free tiers do this constantly: the catalog says 128k, the endpoint
413s at 32k. `grep -ri "learnedContext\|context-limits" server/src` returns nothing.

**What llm-relay did.** Parsed the backend's own 400/413 "too long" rejection for an explicitly
stated maximum, persisted it per deployment with a 30-day TTL, and used it as the guardrail ceiling.
Critically it recorded **only explicitly-stated maxima, never an estimate** — an unparseable
rejection taught it nothing. Source: `src/context-limits.ts`.

**Why it fits freellmapi.** The shape already exists in the tree: `services/provider-quota.ts` keeps
`provider_quota_observations` and parses `Retry-After` out of upstream responses. This is the same
pattern applied to a different rejection class. It also composes with #788 (skip the whole provider)
— a learned ceiling turns a repeated 413 into a routing input instead of a retry loop.

**Where it goes.** A new observation table + `lib/guardrails.ts` consulting it before the catalog
value. **Effort:** medium. **Risk:** low, additive, degrades to today's behaviour when nothing is
learned.

### 2.3 Cost class and an opt-in free-only guard

**Gap.** The project's premise is free tiers, so historically "every provider is free by
construction" was true. It is less true now: custom OpenAI-compatible endpoints, OpenRouter's paid
catalog, and the premium catalog tier all coexist with the free pool. `services/model-discovery.ts`
extracts a price *hint* (`isFree`, `priceHintOf`) for display on discovered custom models, but
nothing consumes it as a routing constraint — a user can be failed over onto a paid model without
that being a decision they made.

**What llm-relay did.** An explicit `assessCost()` cost class per deployment (`tierType: "free"` plus
an unpublished price defaults to free), an opt-in `freeOnly` guard that returns a clean 503 rather
than silently serving a paid model, and an `x-llm-relay-paid` response header naming the deployment
*and how cost was assessed*. Source: `src/config.ts`.

**Why it fits freellmapi.** It turns an existing display hint into an enforceable guarantee, and the
header pattern matches `X-Routed-Via` / `X-Fallback-Detail`. The "how it was assessed" provenance is
the part worth copying — an unpublished price is not the same fact as a published zero.

**Where it goes.** `services/router.ts` candidate filtering + a header on the three chat fronts.
**Effort:** medium. **Risk:** low if opt-in; the guard must fail closed (503), not fall through.

### 2.4 Capability-downgrade announcement

**Gap.** `services/model-groups.ts` demotes across slug-based "match tiers" and the fallback loop
will happily serve a materially weaker model than the one requested. `X-Fallback-Detail` (#792) now
tells you *what was tried*, but nothing states *you got a downgrade*. `grep -rn degraded` finds only
unrelated hits.

**What llm-relay did.** An effort-banded pool whose weaker-band tail is only reached once every
in-band member has failed, with `x-llm-relay-degraded` set whenever the tail served — the rule being
that a capability downgrade is never silent. Source: `src/config.ts`, `src/server.ts`.

**Why it fits freellmapi.** freellmapi already has the ranking data to define bands
(`intelligence_rank`) and already has the demotion behaviour. This is a header over machinery that
exists, not new routing.

**Where it goes.** `lib/fallback-loop.ts`, set alongside the existing fallback headers.
**Effort:** small. **Risk:** low.

### 2.5 Provider interleaving within a score band

**Gap.** `orderChain` in `services/router.ts` sorts candidates by score. When one provider holds the
top several slots — normal, since a good provider's models all score well — the first few failover
attempts all hit the *same quota domain*. If that provider is rate-limited, those attempts are
wasted. #788 (skip the whole provider on 5xx/timeout) fixes this reactively, after the hops are
spent.

**What llm-relay did.** Spread the first N attempts across N distinct credential/quota domains before
returning to score order. Source: `src/pool-health.ts`.

**Why it fits freellmapi.** Proactive complement to #788, in the function that already owns ordering.
**Effort:** small–medium. **Risk:** medium — it perturbs the bandit's ordering, so it wants to be
opt-in and measured, not defaulted on. Worth raising as a question rather than a patch.

### 2.6 Learned eligibility facts from refusal interpretation

**Gap.** freellmapi's answer to "which models can this account actually serve" is the curated signed
catalog, which is the *upstream* answer to the problem and generally better. But on the free tier
that snapshot is monthly, and it cannot know account-specific state: this key's allowance is spent,
this model needs a subscription this user does not have.

**What llm-relay did.** Interpreted a provider's refusal text into one of three verdict classes
(`not-servable`, `subscription-required`, `allowance-exhausted`) with distinct scope
(deployment vs account) and consequence (exclude vs demote), TTL'd, keyed on a deterministic request
signature. Source: `src/target-facts.ts`, `src/refusal-interpretation.ts`,
`docs/pool-eligibility.md`.

**The part actually worth proposing is the hardening, not the feature.** Provider error text is
attacker-influenced input. llm-relay constrained proposals to 3 fixed classes and 2 scopes — never
free text or commands — keyed signatures per `(provider, model)` so one provider could not classify a
rival's deployment, and required a human `accept` before any verdict bound to routing. If freellmapi
ever parses upstream error bodies for routing decisions, that is the design to copy. Note it already
parses them for `Retry-After` and for stated back-off (#798), so the seam exists.

**Effort:** large. **Risk:** medium. Raise as a design conversation, not a PR.

---

## 3. Considered and *not* recommended

Listing these matters as much as the proposals — they are the ones where freellmapi's existing answer
is better.

- **LLM-based tool-argument repair (a "reshaper" model).** llm-relay sent malformed tool calls to a
  cheap model for correction. freellmapi now has deterministic double-encoding repair (#794), an Ajv
  verdict (#802), and a large pool to fail over into. Failover is cheaper, faster, and cannot
  hallucinate an argument. freellmapi's answer is the better one.
- **Locally-synced benchmark/capability ranking with provenance** (BFCL, LMArena, Aider merged into
  scalars). Duplicates the signed catalog's `intelligence_rank`/`speed_rank` with more moving parts
  and no signature.
- **Per-install capability-token control plane** (`src/control-authorization.ts`). Rigorous, but
  freellmapi's session auth on `/api/*` plus the unified key on `/v1/*` is a coherent and adequate
  model. No gap.
- **Loopback-only enforcement.** llm-relay refused to bind non-loopback by design. freellmapi is
  deliberately deployable (`HOST`/`HOST_BIND`, Desktop LAN toggle). Not a gap, a different product.
- **Dispatch ladder / peer-CLI lanes / lane discovery** (`src/dispatch.ts`, `src/lane-probe.ts`).
  These render shell commands for other vendors' CLIs. Not proxy features; out of scope.

## 4. Smaller, self-contained items

1. **Windows registry env-var recovery** (`src/winenv.ts`). A process started at logon never sees an
   env var added afterwards; re-reading the registry-backed environment lets a stale process pick up
   a freshly-added key. freellmapi's Desktop tray app has exactly this lifetime. Small, isolated,
   Windows-only. Low priority but genuinely annoying without it.
2. **Upstream error-body normalization** (`normalizeOpenAiErrorBody`, `src/backend.ts`). Pass through
   byte-exact when already `{"error":{...}}`, unwrap Gemini's `[{"error":{...}}]` array shape, and
   wrap anything else — an HTML error page, a bare string — into a synthetic OpenAI error rather than
   leaking it. Worth checking against freellmapi's `lib/error-redaction.ts`, which solves the
   adjacent but distinct problem of stripping secrets.
3. **Binary document conversion.** #793 converts `text`/`content` document sources and explicitly
   *refuses* `base64`/`url` with an actionable message — deliberately, since stringifying a base64
   PDF into the prompt burns a context window on nothing. llm-relay took the next step: convert via
   an optional external MarkItDown binary, and still refuse rather than truncate when unavailable
   (`src/documents.ts`). Natural follow-on to #793, with the optional-dependency cost that implies.

## 5. Explicitly excluded

The **Anthropic passthrough / subagent-offload lane** (`lib/anthropic-passthrough.ts`,
`lib/subagent-detect.ts`) is not proposed. It is a standing local-only decision, kept on
`feat/anthropic-passthrough` and never to be sent upstream. It appears in this document only so it is
not mistaken for an oversight.

## 6. For context — what freellmapi has that llm-relay never did

So the comparison is not read as one-directional: multi-armed bandit routing with Thompson sampling,
a signed and versioned model catalog, a multi-engine context-compression pipeline, response fusion
with judge synthesis, cooldown-probe early recovery, model auto-retirement on corroborated EOL
signals, wake-from-sleep recovery, AES-256-GCM key storage behind one unified token, per-key outbound
proxy overrides, sticky sessions with context handoff on model switch, p50/p95/TTFT analytics,
embeddings/media/transcription routing, encrypted DB backups, an MCP endpoint, five API-shape fronts
(OpenAI, Anthropic, Gemini, Ollama, Responses), a multi-language dashboard, and a Desktop tray build.

llm-relay was a single-user loopback proxy. Most of what is proposed above is the residue of that
narrower scope: it could afford to learn per-deployment facts at runtime because it only ever served
one person.
