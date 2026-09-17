# Review of an external terms/security assessment — 2026-08-05

An external agent (Codex) reviewed llm-relay for terms compliance and credential handling and
raised three things. Verified against the source and against Anthropic's own docs. Verdicts:

| Claim | Verdict |
|---|---|
| Local gateway + subscription passthrough is contemplated by Anthropic; non-Claude routing is unsupported, not prohibited | **Accurate** |
| `buildForwardHeaders()` can forward the caller's OAuth token to Ollama | **False as stated** — but it exposes a real, narrower gap |
| Replace the `cc_is_subagent` marker with the documented `x-claude-code-agent-id` header | **Right target, wrong reason, and "replace" is the wrong verb** |

## 1. Terms posture — accurate, with the operative sentence identified

Confirmed from source, not from the reviewer's summary:

- [Other LLM gateways](https://code.claude.com/docs/en/llm-gateway) — "Setting only that variable,
  without a gateway credential, doesn't replace the subscription. Requests still route through the
  gateway, but a saved claude.ai login remains the active credential, so its usage limits and
  billing apply. Gateways that pass this traffic on to Anthropic must forward the OAuth capability
  in `anthropic-beta`." That is exactly this relay's main-conversation path, described as a
  supported configuration. The relay forwards all inbound headers minus hop-by-hop on the
  `kind: "anthropic"` path, so the OAuth capability travels.
- Same page — Anthropic "doesn't endorse, maintain, or audit third-party gateway products, and
  doesn't support routing Claude Code to non-Claude models through any gateway." Non-support, sat
  next to non-endorsement of gateways generally. Not a prohibition.
- [Legal and compliance](https://code.claude.com/docs/en/legal-and-compliance) — the operative
  sentence is about acting **for other people**: "Anthropic does not permit third-party developers
  to offer Claude.ai login or to route requests through Free, Pro, or Max plan credentials on
  behalf of their users." Also: "Advertised usage limits for Pro and Max plans assume ordinary,
  individual usage."

The reviewer's distribution analysis follows from that and is worth writing down as a standing
project invariant, because the project is shared with friends:

> **Credentials stay user-operated.** Each person logs into Claude Code themselves, on their own
> machine, against their own account. llm-relay never operates a login, never asks anyone to paste
> a Claude token into it, never centrally proxies subscription traffic, and never pools consumer
> accounts. Each person supplies their own third-party provider keys.

Everything currently in the repo satisfies this; the point of writing it down is that a "hosted
llm-relay" or a "shared relay for the group" would violate it, and both are natural-sounding next
features.

One reviewer claim is unsupported in its own citation: reverse-engineering is not mentioned on the
legal-and-compliance page (it would be in the Consumer Terms). The reviewer hedged it, and it is
not the reason to change anything — see §3.

## 2. The credential claim is false; the gap underneath it is real

The claim: `buildForwardHeaders()` infers passthrough from a missing `authEnv`, the Ollama preset
has no `authEnv`, therefore Claude's inbound OAuth header can reach Ollama.

The first half is true and the conclusion does not follow. `buildForwardHeaders()`'s output is only
ever sent to a `kind: "anthropic"` target:

- [backend.ts:262](../../src/backend.ts) — `kind === "anthropic"` sends `args.anthropicHeaders`, i.e.
  the forwarded inbound headers.
- [backend.ts:331](../../src/backend.ts) and [backend.ts:697](../../src/backend.ts) — the `openai` path
  sends `buildTargetHeaders(target)`, a **freshly constructed** map: `content-type` plus the
  provider's own key if it has one. Nothing inbound survives.

Ollama is `kind: "openai"` ([presets.ts:108](../../src/presets.ts)), so it receives no inbound
credential. Same for every other free provider. Verified against the live config: the only
`not-declared` target that forwards anything is `anthropic` → `https://api.anthropic.com`.

**The real gap:** passthrough is *inferred* from the absence of `authEnv`, and nothing binds it to
an Anthropic host. Any provider declared `kind: "anthropic"` with no `authEnv` and an arbitrary
`base` receives the caller's own OAuth token. No preset or shipped config does that today — it
takes a hand-edited (or friend-shared) config. But the codebase already ratified the principle in
[server.ts:1541](../../src/server.ts): *containment is DECLARED, not inferred from key presence*. Only
half of it was implemented. Absence still means "forward the user's credential", which is the most
consequential default in the file and the only one nobody has to opt into.

**Recommended change** (the reviewer's, minus the part that can't be done here): make passthrough
an explicit declaration — `credentialMode: "passthrough"` on the provider — and treat
`not-declared` without it as a config error, or at minimum a startup warning under the existing
degrade-don't-abort doctrine. Cost: one field in existing configs, which `onboard`/`setup` write
anyway.

Do **not** take the reviewer's second suggestion of restricting passthrough to
`https://api.anthropic.com` in `src/`. That hardcodes a provider URL into the source, which the
project's first invariant forbids, and it would break a legitimate anthropic-format upstream (a
cloud provider endpoint, a second relay). The explicit declaration gets the safety without the
provider knowledge.

## 3. The subagent marker — switch, but add rather than replace

`x-claude-code-agent-id` is real. It is documented in the
[gateway protocol reference](https://code.claude.com/docs/en/llm-gateway-protocol) as "Identifier of
the subagent that issued the request, present only on requests from an agent Claude Code spawned
inside the session", the page states gateways "may consume" these headers "for routing, attribution,
and tracing", and both `x-claude-code-agent-id` and `x-claude-code-parent-agent-id` are present as
literals in the installed 2.1.221 binary. Semantics match `isSubagentRequest` exactly.

The reviewer's *reason* is the weak part. The system-prompt marker is not an undocumented artifact
any more: the same page documents the "system prompt attribution block", and since v2.1.181 it is
stable for a conversation's lifetime. The actual fragility argument is better and is in that page
too — **`CLAUDE_CODE_ATTRIBUTION_HEADER=0` makes Claude Code omit the block entirely**, at which
point subagent detection silently returns false and every offloaded subagent falls through to
primary quota. That is the failure mode already flagged in CLAUDE.md as "safe but silent", now with
a named switch that triggers it.

**Do not replace — OR the two signals.** Reasons the header alone is not obviously safer here:

- Headroom sits in front of the relay on this machine (`:8787` → `:8791`). A header-based signal
  only works if headroom forwards unknown `x-claude-code-*` headers; the system block travels
  inside the request body and cannot be dropped by header filtering. Verify before trusting the
  header as the sole signal.
- The protocol page's own advice is to treat these as an open list that grows over releases.
- Codex-client detection (`x-codex-turn-metadata`) is unaffected either way.

Two signals, either sufficient, is strictly more robust than either alone and costs a few lines in
[config.ts:175](../../src/config.ts).

## Worth reading in the protocol reference regardless

The relay *is* a gateway, and that page is the contract. Beyond the above, three items apply:

- **Forward error bodies unmodified** — Claude Code's automatic retry matches on the upstream's
  error wording, and a gateway that wraps errors breaks recovery even with the status preserved.
  The relay already passes conforming bodies byte-exact; the synthesized
  `invalid_upstream_envelope` 502s are the exception to keep an eye on.
- **The 300-second byte watchdog** on `ANTHROPIC_BASE_URL` connections aborts a stream that goes
  silent, and upstream keep-alive pings are the only traffic during long pauses. Repair-mode
  streaming buffers from the first `tool_use` while the reshaper runs — a slow reshaper emits no
  bytes for that window.
- **Gateway model discovery** (`CLAUDE_CODE_ENABLE_GATEWAY_MODEL_DISCOVERY=1`,
  `GET /v1/models?limit=1000`, 3s timeout, redirects treated as failure, ids not starting with
  `claude`/`anthropic` ignored) would surface relay-served models in the `/model` picker. Off by
  default; the relay already serves the endpoint.

## Status

**Both adopted, same day.** `credentialMode: "passthrough" | "contained"` (§2) and the OR'd
`x-claude-code-agent-id` signal (§3) are in `src/`, with tests in `test/config.test.ts` and
`test/mid-stream-failure.test.ts`.

Not done, deliberately: the "credentials stay user-operated" invariant (§1) belongs in
[project-goals.md](../project-goals.md), which is owner-ratified and says to change it only with the
owner — so it is proposed here, not merged there. Nothing from the "protocol reference" section
was actioned either; those are observations, not defects.
