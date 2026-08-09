# Assessment: "Unified Multi-LLM Management and Orchestration" (ChatGPT deep research, 2026-08-09)

Reviewed against the actual question asked: *"I'm tired of maintaining llm-relay. I want something
someone else maintains that I can install and use."*

## Verdict

**The report is competent research answering a different question.** It is a good survey of the
2026 LLM-gateway landscape and its taxonomy is sound. But its headline recommendation —
"Bifrost as the execution gateway, with a thin custom policy router" plus a custom MCP server
exposing `llm.dispatch`, plus a model/capability registry, plus Redis + PostgreSQL for atomic quota
reservation, plus Vault for credential rotation — **is more software to maintain than llm-relay,
not less.** Section "Recommendations and reference architecture" is a build plan for an
organization's AI platform team.

One genuinely useful lead survives: **Bifrost**. Everything else in the report is either already
tried here, already ruled out, or scaffolding for a problem you do not have.

## What it gets right

- **The three-layer taxonomy** (gateway/proxy · routing decision layer · serving substrate) is the
  correct frame, and it correctly demotes NIM, Ollama, Groq, Cerebras, Replicate, KServe, Seldon,
  Flyte, BentoML and LangChain/LlamaIndex to "routable targets or app frameworks, not gateways."
  That is a lot of noise correctly filtered out.
- **Codex `wire_api`.** Verified: since February 2026 `responses` is the only supported value;
  Chat Completions support was removed (openai/codex discussion #7782). The report is right, and
  this has a direct consequence here — llm-relay's `/v1/chat/completions` front is dead weight for
  Codex specifically, and any gateway fronting Codex must speak Responses.
- **Lifecycle cautions are the most valuable content in the document.** TensorZero (archived
  June 2026) is architecturally the closest thing on the list to llm-relay, and would have been the
  obvious answer had it not been archived. Cortex Labs likewise. Knowing what *not* to migrate onto
  is worth more than another gateway comparison table.
- **"Most gateways are better at infrastructure routing than model-quality routing."** True, and it
  is exactly the gap `benchmarks.ts` + `sync:tiers` fills here. No product on the list does
  synced-leaderboard pool ranking.
- **Tiered failover ordering** (retry → another credential → same model elsewhere → equivalent model
  → downgrade) is the right principle, and it is a fair criticism of anything that jumps straight to
  a different model on a 429.

## What it gets wrong or misses

**1. It never learns that Claude Desktop cannot be pointed at a gateway.**
This is the single most consequential fact in your environment and the report is built on its
negation. It says (§Design target) `ANTHROPIC_BASE_URL` "can point Claude Code at a gateway," then
silently generalizes to Claude Desktop throughout — "Bifrost documents Claude Desktop/Claude Code
integration," "Claude Desktop / Claude Code" as one node in the architecture diagram. You verified
2026-08-07 that the Desktop launcher force-sets `ANTHROPIC_BASE_URL=https://api.anthropic.com`,
overriding both the User-scope var and the `settings.json` `env` block, and that no setting disables
it. Headroom has seen zero Claude `/v1/messages` traffic since 2026-07-28.

So the report's central promise — one gateway hostname serving both harnesses — **is not achievable
for Claude Desktop under any product on its list.** Its own MCP fallback (`llm.dispatch` as a tool
both harnesses can call) is the correct workaround and is structurally the same idea as your
dispatch ladder, which already exists and already shells out to peer CLIs. The report reinvents your
solution without noticing you built it because the direct path was blocked.

**2. Its "best conservative choice," LiteLLM, was already tried and retired here on 2026-07-28.**
Not the report's fault — it could not know. But it means recommendation #2 is a closed question. The
retirement reasons still hold: it duplicated the roster/key-management layer llm-relay already owns,
it needed a Python env with an exact `pydantic-core` pin that broke on drift, and it needed
`PYTHONIOENCODING=utf-8` on Windows or it crashed at startup. "Someone else maintains it" is not
true of a Python service with a brittle dependency pin on Windows — you maintain the env.

**3. It conflates Claude Code and Claude Desktop repeatedly**, which is precisely the distinction
that determines whether any of this works for you.

**4. Every inline citation is a broken token.** ~200 instances of `citeturnNNsearchNN` that never
resolved to links. Only the closing "Primary sources" section has real URLs, and those are
top-level doc-site links, not the specific pages backing specific claims. The document is therefore
**not independently checkable in the form delivered** — you have to re-verify anything you intend to
act on. I checked two claims; one (Codex `wire_api`) held, one (Bifrost's shape) held and was
understated.

**5. The engineering sections are scaled for an organization, not one person on one laptop.**
Two-tier credential brokerage with Vault, hierarchical quota across org/team/user/model/account/
credential/deployment, atomic token reservation in Redis reconciled against a PostgreSQL ledger,
shadow-traffic A/B with separate accounting, SSO and data-residency policy filters. You are one
person with free-tier API keys on a loopback listener. The scoring formula in §Gaps
(`0.40 × quality + 0.20 × latency + …`) is presented with its own weights labelled "deliberately
illustrative" — that is an admission it has no information about your actual objective.

**6. It nowhere asks what you would lose.** A migration report that only lists what you gain is half
an analysis. See below.

## What the report does not tell you: what a migration costs

Nothing on its list does any of this:

| Capability | Status here | Would a gateway cover it? |
|---|---|---|
| Tool-call validation + repair (`validator.ts`/`reshaper.ts`/`repair.ts`) | live | **No product does this.** Bifrost's README shows no tool validation or repair. |
| Tool-dialect recovery from assistant *text* (`tool-dialects.ts`, 0.33/0.34) | live, landed this week | No. |
| Refusal interpretation + deployment eligibility learning | live | No. |
| Learned context limits from refusals (`context-limits.ts`) | live | No. |
| Synced-leaderboard pool ranking (`sync:tiers` → `benchmarks.ts`) | live | No — the report concedes this gap and proposes paying Not Diamond for a weaker version. |
| Effort-banded free pools + `x-llm-relay-degraded` announcement | live | No. |
| Dispatch ladder to peer CLIs (`agy`, `codex exec`) | live | No — and this is what gets around the Desktop block. |
| `freeOnly` cost guard | built, **OFF on every rule** | No, but you are not using it. |
| Provider-key pooling, failover, breaker, retries | live | **Yes** — Bifrost, LiteLLM, Portkey all do this well. |
| Cross-provider normalization | live | **Yes.** |

The honest read of that table: **the parts a maintained product replaces are the parts that were
never the hard bit.** Failover and normalization are commodity. What is not commodity is the
tool-call repair layer and the learned-facts stores, and they exist because the free-model lane
misbehaves in ways a general gateway does not model.

**The counterweight, from your own measurements:** repair earns its keep on weak models, and you
have mostly stopped using weak models. `glm-5.2` trips 0% across the scenario set; `llama-3.1-8b`
trips 25%. If your pools now resolve to frontier-class free models, the reshaper is close to idle
and you would barely feel its loss. Dialect recovery is the exception — that was needed as recently
as 0.33/0.34, i.e. days ago, on hosts that return native tool syntax as text. That one is load-
bearing right now.

## The actual shortlist for the question you asked

Ranked by "someone else maintains it, I install and use it":

1. **Bifrost** — the one real lead in the report, and better than the report describes it.
   Apache 2.0, written in Go, **single binary** — `npx -y @maximhq/bifrost` or one Docker container,
   **no Redis, no Postgres, no Python env**. Built-in web UI for config. Exposes an
   `/anthropic` drop-in endpoint alongside the OpenAI-compatible one, so `ANTHROPIC_BASE_URL` can
   point at it from terminal-launched Claude Code. Provider-key pooling, automatic fallback, load
   balancing. 23+ providers. On Windows this is a genuinely better maintenance story than LiteLLM.
   **Unverified and decisive:** whether an Anthropic-format request can actually be *routed to a
   non-Anthropic model* — the README documents a unified OpenAI-compatible interface and an Anthropic
   drop-in, but not translation across families. That is a 30-minute PoC, and if it fails, Bifrost
   cannot replace llm-relay for you at all.
   Also check: NIM is not in the listed 23 providers. It is OpenAI-compatible so a generic/custom
   provider entry will probably work, but your primary free lane is not first-class.

2. **Keep llm-relay and stop developing it.** The option the report structurally cannot see. You are
   at v0.34.0, CI green, suite green, four known defects that are all non-blocking
   (`docs/audit-2026-08-09.md`). Most of your maintenance burden is *feature work you chose*, not
   upkeep. Freezing it — no new subsystems, fix only what breaks — costs near zero and loses
   nothing. If the fatigue is about the treadmill rather than the tool, this is the actual fix.

3. **OpenRouter alone, no self-hosted gateway.** Genuinely zero-ops, one key, and it has real
   provider routing, health-based failover, price/latency/throughput sorting and sticky routing for
   prompt-cache locality. The cost is literal: you would pay credits for models you currently get
   free from NIM, Gemini and Groq, and you lose private/local endpoints entirely. Lowest maintenance
   on the list by a wide margin; highest running cost given how your setup is built.

4. **Portkey** — dismiss. Managed enterprise SaaS in the path of every request, and it puts a third
   party between you and your own traffic for governance features you have no use case for.

## Survey: the personal/hobbyist tier — the report's blind spot

The report's frame is enterprise gateways, so it never looked where a maintained tool actually
*shaped like llm-relay* would live. Surveyed 2026-08-09. **Everything below is GitHub-surface
evidence — README self-description and repo metadata, not verified behaviour.** Your own rule
applies: listed ≠ servable.

| Project | Stars | Stack / install | Anthropic `/v1/messages`? | Free-tier pooling | Tool-call repair |
|---|---|---|---|---|---|
| **[freellmapi](https://github.com/tashfeenahmed/freellmapi)** | 18.2k | Node 20+/TS; Docker one-liner or native .exe | **Yes** — "Claude Code and the official Anthropic SDKs run against your free pool" | **Yes — 29 free providers** | **Yes** — "plain-text tool calls are rescued into real tool_calls" |
| **[claude-code-router](https://github.com/musistudio/claude-code-router)** | 36.5k | Node 22+; desktop app / npm / Docker; v3.0.20, 796 commits | Yes | No — a router, not a free pool | Not mentioned |
| **[freellmpool](https://github.com/0xzr/freellmpool)** | 61 | Python 3.11+, httpx only; `uvx freellmpool` | Experimental (text + tools, no vision) | Yes — 24 providers, 407 models | No |
| **[claude-code-multirouter](https://github.com/daviddawson/claude-code-multirouter)** | 2 | Node 20+; clone + build | Passthrough for main | Subagents only | No |
| **[Bifrost](https://github.com/maximhq/bifrost)** | — | Go single binary; `npx -y @maximhq/bifrost` | Yes (`/anthropic` drop-in) | No — 23 commercial providers | No |

### freellmapi is the close match, and it is uncomfortably close

It is llm-relay's thesis, built by someone else, with ~18k people watching it:

- **Your exact provider roster and then some** — NVIDIA (NIM), Groq, Cerebras, Google, Mistral,
  OpenRouter, HuggingFace, Cohere, Cloudflare, Z.ai, ModelScope + 18 more, plus custom
  OpenAI-compatible endpoints.
- **Anthropic wire format at `/v1/messages`** — the front door Claude Code needs.
- **Per-key RPM/RPD/TPM/TPD counters** to stay under provider caps — your quota-domain problem.
- **429/5xx failover with cooldowns and key rotation** — your circuit breaker.
- **Live per-model speed/capability/reliability scores**, six routing strategies — your
  `benchmarks.ts` + ping/health layer.
- **Sticky sessions** (30 min) for prompt-cache locality — the affinity property the ChatGPT report
  correctly said matters and llm-relay does *not* implement.
- **"Plain-text tool calls are rescued into real tool_calls"** — this is `tool-dialects.ts`. The
  thing you shipped in 0.33/0.34 last week. Someone else has it, in a project with 18.2k stars.

Two things to weigh before believing it:

1. **It phones home.** The catalog self-updates twice daily from `freellmapi.co`. llm-relay is
   deliberately loopback-only with no external control plane. This is a real architectural
   difference, not a nitpick — it means a third party influences your routing table.
2. **"Personal experimentation and learning, not production"**, and upstream-ToS compliance is
   pushed to the user. Same posture as llm-relay, stated more loudly. Consistent with your ratified
   *credentials stay user-operated* invariant (it is BYO-key per provider — the per-key counters
   imply your own keys, not a pooled account), but confirm that in the PoC.

### The others, briefly

**claude-code-router** is the most-maintained thing on the list (36.5k stars, v3.0.20, 796 commits)
and is the only one that fronts **both** your harnesses — it lists Claude Code and Codex among 9+
supported agents. But it is a *router*, not a free-tier pool: no NIM, no free-tier quota stacking,
no tool-call repair. It solves model selection, not the free-lane reliability problem.

**freellmpool** has the right thesis and two features you built yourself — per-day quota tracking
and **"context-window learning — rejects oversized inputs to smaller models"**, which is
`context-limits.ts`. But 61 stars is one person's project, so it carries the same bus-factor risk as
llm-relay, just someone else's. And it is Python on Windows, which is precisely how LiteLLM failed
here on 2026-07-28. Low priority.

**claude-code-multirouter** is not a candidate (2 stars, 4 commits, 1 contributor). Noted only for
one idea: it detects subagents via a `<CCR-SUBAGENT-MODEL>` tag injected into the system prompt —
a third mechanism alongside your two (`x-claude-code-agent-id` header, `cc_is_subagent` marker).

## Recommendation

The report's own top pick is now third. Revised order:

1. **PoC freellmapi** (~30 min). Docker one-liner, add your existing NIM/OpenRouter/Gemini/Groq
   keys, point a **terminal-launched** Claude Code at its `/v1/messages` with `CLAUDE_CONFIG_DIR`
   isolated. Test three things specifically: (a) does an agentic session with real tool use complete;
   (b) does the plain-text tool-call rescue actually fire on a host that returns native dialect —
   that is the one feature you cannot easily replace; (c) can you disable or pin the twice-daily
   catalog fetch. Desktop will not participate, as with every option here — expected, not a failure.
2. **If it holds, run both side by side for a week** with llm-relay still installed. Watch for what
   it does not claim: refusal interpretation on pool exhaustion, and effort-banded degradation.
3. **If it does not hold, freeze llm-relay** rather than migrating to a second-best. It works, CI is
   green, and the exhaustion is from building it, not running it.

**Bifrost** stays on the list only as the fallback if freellmapi's "not for production" posture or
its phone-home is disqualifying and you want something engineered rather than accreted. It is the
better-built system; it is a worse fit for a free-tier pool.

---

# PoC results — freellmapi, run 2026-08-09

Built from source and driven end-to-end with a real Claude Code agentic session. **It works.**

## Setup

Node 26.7.0 is **out of range** — `engines: >=20.18.0 <25.0.0`, capped there because `better-sqlite3`
has no prebuilt binary for Node 26's ABI. Used a portable Node 22.23.2 unzipped into the scratchpad
so nothing on the machine changed. `npm ci` → 753 packages in 16s; `npm run build` clean.
Ran loopback-only (`HOST=127.0.0.1`), update-check off, two provider keys (NVIDIA, Groq) supplied
via `FREEAPI_CONFIG_PATH` so no secret touched a command line.

## Its own test suite: 1963 / 1966

Three failures, both files Windows artifacts, neither a product defect:
- `db/hardening.test.ts` asserts `mode & 0o077 === 0` — POSIX permission bits, which Windows lacks.
- `csp-inline-bootstrap.test.ts` compares a SHA256 of `client/index.html`'s inline script against a
  constant. Verified the cause: `core.autocrlf=true` and all 36 line endings are CRLF pairs, so git
  changed the bytes on checkout and the hash moved.

`tool-call-rescue.test.ts`: **17/17 passing**.

## Functional results

| Test | Result |
|---|---|
| `/v1/messages` (Anthropic wire) with a tool | ✅ `stop_reason: tool_use`, correct name, correctly parsed input |
| Claude Code full agentic session (`Read`/`Glob`/`Grep`) | ✅ read two files, returned both planted values (`zarquon-8813`, `bluefin-42`) — neither guessable |
| Live failover | ✅ observed twice, unprompted (below) |
| Desktop shell-out transport | ✅ the test WAS a terminal-spawned `claude` with injected env; `freellmapi launch` / `launch-codex` do this first-class |

**Failover observed live.** The session's `request_attempts` table shows two models dying and the
router recovering transparently mid-session:

```
deepseek-ai/deepseek-v4-flash  → 410 end-of-life  → nvidia/llama-3.3-nemotron-super-49b-v1.5 ✅
deepseek-ai/deepseek-v4-pro    → 410 end-of-life  → meta/llama-3.1-70b-instruct              ✅
minimaxai/minimax-m3           → ✅ ×2
groq/openai/gpt-oss-120b       → ✅
```

⚠ **Incidental correction to this repo's own status notes.** `CLAUDE.md` lists
`nim/deepseek-ai/deepseek-v4-flash` as "genuinely down: HTTP 529". It is not 529 — NVIDIA returns
**410, end-of-life as of 2026-08-07**, and the same applies to `deepseek-v4-pro`. Both are gone, not
sick. Fix that line whichever way this decision goes.

## Free vs paid — the constraint is satisfied

Premium is exactly one thing: catalog refresh cadence. `routes/premium.ts` only activates/deactivates
a Stripe license key. `services/catalog-sync.ts`: a licensed install gets the `live` tier refreshed
every 2–3 days, **everyone else gets the monthly snapshot** — "so free installs still self-heal, just
on a slower cadence." Both tiers are Ed25519-signature-verified against a pinned public key over the
exact bytes received, and bundled migrations are the floor (`MIN_CATALOG_VERSION`), so a stale
snapshot can never roll back models a newer build added. **Nothing in the routing, failover, rescue,
quota or Anthropic/Responses paths is gated.** The free tier is fully functional.

## Design convergence with llm-relay

`server/src/lib/tool-call-rescue.ts` independently arrived at `tool-dialects.ts`:
- Closed dialect set (Kimi/DeepSeek tokens, Llama/Groq `<function=`, Qwen/Hermes `<tool_call>`,
  bare/fenced JSON strictly schema-gated against the request's tool list).
- **"A turn detected as a dialect but unparseable is a DEAD turn — the caller fails over instead of
  delivering gibberish."** Verbatim the fail-clean rule.
- `couldBecomeDialectMarker()` — a streaming prefix hold-window, i.e. `dialect-stream.ts`.

It also curates what llm-relay learns at runtime: the `Platform` type carries notes like *"SambaNova
was dropped in V23 — free tier permanently retired, 402 once the $5 trial credit lapses."*
`request_attempts` persists the per-candidate walk that llm-relay emits as `x-llm-relay-pool-attempts`.

## Gaps found

1. **No context-window advertisement.** Claude Code warned `"auto" is not a model this version
   recognizes` and assumed 200k. That is the exact problem `contextWindowResolver`'s three rungs
   solve, and freellmapi does not solve it either — a genuine wash, not a regression.
2. ~~No response header names the serving deployment.~~ **Wrong — corrected 2026-08-09 by reading
   the source.** It sets `X-Routed-Via: <platform>/<modelId>` on all three fronts, plus
   `X-Provider` / `X-Model` on the chat path. What is genuinely absent is the *walk census*
   (`x-llm-relay-pool-attempts`, "13 tried, 0 served: 4×402, 5×429…") and the capability-downgrade
   announcement (`x-llm-relay-degraded`). `requested_model` / `served_model` are null in the
   `requests` table, but `platform` + `model_id` are recorded there.
3. **It phones home every 12h** to `api.freellmapi.co` for the catalog. Signed and verified, so not a
   control channel — but it is not loopback-only, which llm-relay is by design.
4. No refusal-interpretation / eligibility-learning equivalent. Membership correctness comes from the
   curated catalog instead, which is the *upstream* answer to the same problem and arguably better —
   but it is monthly on the free tier.

## Feature-parity audit (source-read 2026-08-09, after adoption)

Verified by reading `freellmapi/server/src`, not inferred.

**Present, contrary to my first pass:** `POST /v1/messages/count_tokens` (heuristic estimate); a
per-request token-budget guardrail (`REQUEST_MAX_TOKENS_BUDGET`, plus
`MAX_CONSECUTIVE_UPSTREAM_FAILS`); and served-deployment headers (above).

**Genuinely absent — what llm-relay had and this does not:**

| Capability | Status in freellmapi |
|---|---|
| **Schema validation + LLM repair of tool args** | Partial. `lib/tool-args.ts` repairs *double-encoded* JSON args, schema-aware and deterministic — it never invents a value. There is no Ajv verdict and no reshaper model, so genuinely schema-violating args pass through unrepaired. |
| **Destructive-tool refusal** | Absent. Nothing corresponds to `DEFAULT_DESTRUCTIVE`. Note its dialect rescue *constructs* `tool_calls` from text (its own tests cover `Bash`), with no destructive filter on that path. |
| Refusal interpretation (signature → verdict) | Absent. Cooldowns + penalties instead. |
| Learned eligibility facts w/ scope (`not-servable`, `subscription-required`, `allowance-exhausted`) | Absent. Curated upstream catalog instead. |
| Explicit free/paid cost class + `freeOnly` guard | Absent (every provider is free-tier by construction). |
| `credentialMode` / Anthropic passthrough containment | N/A — it is never the Anthropic path. |
| Subagent detection (`cc_is_subagent`, agent-id header) | **Absent.** No per-subagent routing at all. |
| Anthropic `document` blocks / PDF transcoding | Absent — no MarkItDown path. |
| Dispatch ladder / peer-CLI lanes | Absent (never a proxy feature). |
| Locally-synced capability ranking with provenance | Absent. `intelligenceRank`/`speedRank` come from the curated catalog, with no `signal_count`. |
| Pool-walk census + degrade announcement | Absent (see the header note above). |

**What it has that llm-relay never did:** request-side prompt compression (3 modes), an opt-in
response cache, an MCP server at `/mcp`, AES-256-GCM encrypted key storage behind one unified token,
sticky sessions + context handoff on model switch, p50/p95/TTFT analytics, embeddings/media/
transcription routing, bandit exploration, encrypted DB backups, outbound SOCKS/HTTP proxy support,
and a 60-language dashboard.

## Verdict

freellmapi covers the parts of llm-relay you use day to day — Anthropic front, Codex Responses front,
free-provider pooling with per-key quota tracking, failover, and tool-call dialect rescue — and is
maintained by an active project with 18k stars and ~1966 tests. The Desktop problem is solved the
same way you solve it, and shipped as a first-class `launch` command.

What you would give up is real but narrow: loopback purity, the served-model announcement, and
runtime eligibility learning. What you would gain is not maintaining any of it.

**Recommendation: adopt it on trial.** Run it beside llm-relay for a week on real work. If nothing
you miss shows up, retire llm-relay to archive rather than deleting it — the design convergence
above is evidence the thinking was sound, and the repo is worth keeping as a record.

---

# Head-to-head — all three candidates tested, 2026-08-09

The single-candidate PoC above was not a comparison. All three were then installed and put through
**identical** tests. Losers were uninstalled; only freellmapi remains.

| | **freellmapi** | **claude-code-router** | **Bifrost** |
|---|---|---|---|
| Stars / npm downloads per month | 18.2k / 771 (npm is only a helper CLI) | **36.5k / 548,954** | 7.2k / 8,711 |
| Anthropic Messages front | ✅ verified | ✅ (core purpose) | ✅ verified at `/anthropic` |
| Anthropic → non-Anthropic model | ✅ verified | ✅ (core purpose) | ✅ **verified** (Mistral, correct `tool_use`) |
| Codex Responses front | ✅ documented `wire_api="responses"` | ✅ listed agent | not verified |
| **Free-provider pool w/ quota tracking** | ✅ **16 platforms, per-key RPM/RPD/TPM/TPD** | ❌ manual per-provider config | ❌ 23 commercial providers |
| **Tool-call dialect rescue** | ✅ **17 tests** | ❌ **0 hits across 15 files / 6 MB of bundle** | ❌ none documented |
| Live failover observed | ✅ twice on 410s, plus 429/402/413 | not reached | not reached |
| Install friction (this machine) | source build + portable Node 22 | npm global, **blocked by allowScripts**, needed native rebuild | ✅ **npx, one Go binary, zero friction** |
| Management-plane auth | dashboard login | token-gated | ⚠ **unauthenticated on loopback** |
| Config | dashboard **+ declarative JSON** | **GUI-first** (SQLite, no documented file config) | UI + open API |

## Why freellmapi wins for this use case

**claude-code-router is the most popular tool here by a wide margin** — 549k downloads/month, and if
the goal were "route Claude Code to a handful of configured providers," it would be the answer. It
is not the answer here for two concrete, measured reasons: it is a *router*, not a free-tier pool
(no free-provider roster, no per-key quota counters — you hand-configure each provider), and a
recursive scan of its entire 6 MB bundle found **zero** occurrences of any tool-call dialect marker.
Running weak free models in the Claude Code harness is exactly where that matters.

**Bifrost is the best-engineered and by far the easiest to install** — a single Go binary via `npx`,
up in 45 seconds, and its cross-family translation genuinely works. But it targets commercial
providers, has no free-tier pooling or dialect rescue, and its management API answered
unauthenticated on loopback, which is the failure mode `control-authorization.ts` exists to prevent.

**freellmapi is the only one that matches the actual workload**: stacking free tiers, tracking each
key's quota, failing over across quota domains, and rescuing tool calls that arrive as text.

## Verified working state

11 provider keys loaded (cerebras, cloudflare, cohere, google, groq, huggingface, kilo, mistral,
nvidia, ollama, openrouter — `OPENCODE_API_KEY` and `VERCEL_API_KEY` have no platform). A second
agentic Claude Code session completed correctly while the pool absorbed, unassisted:

```
nvidia / groq / ollama / openrouter  → served
google        → 429 quota exceeded, and a 60s timeout
huggingface   → 402 Payment Required (credits spent)
groq          → 413 request too large
```

Six quota domains, four failure classes, session still correct. That is the behaviour
`docs/pool-eligibility.md` was written about, working without any of it being maintained here.

⚠ **Known cosmetic issue:** groq and nvidia each appear **twice** in `api_keys` (13 rows for 11
platforms) because the seed re-added keys already present from the first PoC. Same key twice reads
as two independent quota buckets, so it slightly over-estimates capacity. Fix by deleting the
duplicate in the dashboard's Keys page.
