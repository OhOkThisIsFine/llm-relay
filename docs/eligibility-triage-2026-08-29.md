# Eligibility triage — 2026-08-29

The refusal-interpretation queue had grown to **199 pending signatures** (~2,900 recorded
refusals), which drowned the signal channel the queue exists to be — a queue nobody can read is a
backlog. This lap triaged all 199 with the owner: every verdict below was approved explicitly
before execution, family by family. 192 signatures were accepted, 4 rejected, 4 left pending on
purpose. The queue now holds only items that still carry an open question.

## Verdicts, as approved and executed

| Family | Sigs | Verdict |
|---|---|---|
| openrouter `*:batch` 404 — "only available through the batch api" | 21 + 1 bare-form | `not-servable`, scope deployment |
| nemotron 404s (kilo/openrouter/nim) + "not a valid model id" 400 | 8 | `not-servable`, scope deployment |
| openrouter 403 — "key limit exceeded (weekly limit)" | 61 | `allowance-exhausted`, scope credential, cost-class **paid** — the executed 2026-08-28 verdict applied to sibling signatures (same message, other models; signatures key per model) |
| kilo 402 — "paid model - credits required", negative balance | 66 | `subscription-required`, scope credential, cost-class **paid** (kilo publishes prices, so `paid` resolves) |
| opencode 401 — "no payment method" | 27 | `subscription-required`, scope credential, cost-class **paid,unknown** — opencode is `tierType: "mixed"` with no published prices, so its models resolve `unknown`; a `paid`-only filter would match nothing |
| ollama-cloud 402 — "this model requires a subscription" | 7 | `subscription-required`, scope deployment (message names the model) |
| ollama-cloud 429 — "you (…) have reached your weekly usage limit" | 1 | `allowance-exhausted`, scope credential (message names the account) |
| plain 429s (nim kimi-k3 ×903, mistral ×835, nim minimax ×32, openrouter gemma ×1) | 4 | **rejected** — no number, no account, no key named; the breaker already owns plain throttling, and a plain 429 must not become a fact by design. Reject IS the durable memory: "teaches nothing" is remembered and the signature stops re-queuing. |

Recovery semantics the owner accepted with the verdicts: `not-servable` renews per 6h TTL (one
probe per model per 6h), `subscription-required` per 24h — so after credits/payment are added,
kilo/opencode return within 24h with no operator action. All conditions also clear on any success
within containment scope.

## Still pending, on purpose

1. `groq/qwen/qwen3.6-27b` 403 "access denied. please check your network settings." (×20) —
   ambiguous: neither an account statement nor a model statement; likely a network/origin gate.
2. `groq/qwen/qwen3.6-27b` 400 `max_tokens` ceiling (×13) — **learnable but homeless**: the body
   states an explicit output-token ceiling, but no store records max-output caps and an
   interpretation cannot carry a value. Left pending so the signal is not discarded; see finding 2.
3. `openrouter/meta/muse-spark-1.1` 403 18+ age confirmation (×10) — the owner confirms age
   themselves; the entry clears from relevance when the model serves.
4. `mistral/mistral-medium-3-5` 402 "check your subscription" (×2) — ambiguous against the same
   model's ×835 plain 429s; two data points do not support an account-level verdict.

## Verification

End-to-end, against the RUNNING relay (v0.56.0, no restart): after accepting the bare-form
`:batch` signature, one probe request to `openrouter/anthropic/claude-opus-5:batch` answered 404
and the next `llm-relay eligibility` showed the live fact
`openrouter/anthropic/claude-opus-5:batch  not-servable … expires in 360m`. This also confirms the
v0.56.0 stat-token store-memo fix live: a CLI accept reaches the running relay's request path.

## Findings

⚠ Finding 1 was FIXED the same day, on the owner's direction — see "Resolution of finding 1"
below. The text is kept as the diagnosis of record.

1. **One provider condition can carry TWO signatures, split by lane.** The historical pool-walk
   refusals normalize to a message that embeds the relay's own diagnostic wrapper
   (`openai backend http <n> — model "…" is not served by provider "…" (…): {provider body}`),
   while a directly addressed request normalizes to the provider's bare body. Verified live: the
   accepted wrapped `:batch` signature did not match the direct-lane refusal, which queued fresh
   and needed its own accept. Consequences: (a) a condition may need one accept per lane form;
   (b) confirmed signatures embed relay-authored prose, so a future change to that wrapper's
   wording would orphan every interpretation bound to the wrapped form. Fix direction: compute the
   signature over the provider's own body only. **Trade that blocks a casual fix:** changing the
   normalization orphans every existing confirmed signature (including this lap's 192) — it needs
   a migration or re-acceptance story, so it is an owner decision, recorded in HANDOFF §6.
2. **Stated max-output ceilings have no home.** groq's 400 names an explicit `max_tokens` maximum.
   `context-limits.ts` learns context windows, `rate-limits.ts` learns rate ceilings; nothing
   learns an output cap, and nothing could act on one (clamping the caller's `max_tokens` would
   edit the caller's request). Recorded as an observation, not proposed work.
3. **A `:batch` admission exclusion was considered and NOT built.** The fact layer already contains
   the waste to ~1 probe per model per 6h, and a hardcoded id-pattern exclusion would add provider
   knowledge to `src/` for negligible saving. Do not re-derive this.

## Resolution of finding 1 (same day, owner decision: fix and re-migrate)

The mechanism turned out narrower than the diagnosis assumed. The lookup side already unwrapped
nested payloads; the split came from `normalizeRefusalMessage` stopping after ONE extraction round
— the walk lane's body is the relay's anthropic error envelope, whose `error.message` is the
`openai backend HTTP <n>: …` wrapper, whose tail is the provider body truncated at 300 chars by
`backend.ts`. A truncated payload does not parse, so the whole wrapper became the signature.
The store also held rows from an older normalizer generation (the same ollama-cloud condition sat
in the queue in BOTH forms), so historical rows needed re-keying regardless.

The fix, both halves in `refusal-interpretation.ts`:

- `normalizeRefusalMessage` unwraps to a fixpoint: extract (JSON parse, then a deterministic
  field-regex fallback for truncated/unparseable payloads — unterminated values accepted,
  JSON escapes decoded), strip the relay's own wrapper prefix, repeat.
- `readStoreFile` re-keys every stored signature through the current normalizer at load
  (`migrateSignatures`), inside the ONE parser, so the persist-merge can never resurrect an old
  key. Confirmed collisions: later acceptance wins. Unknown rows merge counts and update their
  `normalized`/`sample`. Ignored rows keep the latest timestamp.

**Verified against a copy of the live store before release: 192 of 193 confirmed rows still bind
after migration; the 4 deliberate pending items survive un-merged.** The one inert row is the
empty-body nim nemotron 404 (×2): its old signature was pure relay wrapper prose, and an empty
provider body now normalizes to "" and deliberately learns/queues nothing — the condition stays
covered by its JSON-body sibling signature. Remaining residual: a message CUT by the 300-char cap
converges across lanes only when both extractions share the same 240-char signature prefix;
otherwise each lane keeps its own signature and each binds for the lane it was learned on
(today's `:batch` family is such a case — walk-lane accepts cover walk traffic, which is all the
real traffic).

## Fourth finding (from verifying the fix): the size ratchet caught a Tailwind scan leak

`npm run check:package` went red on a 36-byte CSS growth — exactly `.uppercase{...}`, emitted
because a source COMMENT in `src/refusal-interpretation.ts` contained the word "uppercase".
Tailwind v3 resolves relative content globs against the process CWD, and the build runs from the
repo root, so `./src/**/*.{ts,tsx}` in `dashboard/tailwind.config.cjs` scanned the SERVER source —
the config's own comment claimed the opposite boundary. The globs are now anchored to the config's
directory (`__dirname`, forward-slashed), which also dropped ~0.9 KB of dead utilities that
server-source words had been emitting all along (the SPA uses only its own classes plus
`sr-only`, whose candidate lives in dashboard TSX and survives). The size baseline was
regenerated in the same change, and the ratchet is the only reason any of this was visible.

## Mechanics (for the next triage)

- Batch execution: parse the captured `llm-relay eligibility` listing, classify per family by
  message substring, then run one `llm-relay eligibility accept <idx> --sig <digest> …` per
  signature — `--sig` is authoritative, so queue reordering during the batch is harmless. 195
  sequential CLI invocations completed in ~2 minutes with zero failures.
- `accept` works without a prior `propose` when it carries the full verdict
  (`--class`, `--scope`, `--cost-class`).
- Cost-class filters must be chosen against what `costClassOf` will actually resolve: it reads the
  SERVING provider's own cached prices (`catalog.cachedLimits`), so an unpriced model on a
  `mixed`-tier provider resolves `unknown`, and a `paid`-only filter is inert for it.
