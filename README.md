# llm-relay

A loopback proxy that steers your LLM traffic across providers. Point Claude Code, Codex, or
any Anthropic/OpenAI-compatible client at `http://127.0.0.1:8791`; the relay resolves the
requested model to a real deployment, ranks candidates by benchmark and live health, fails
over on errors, and validates/repairs malformed tool calls so agent harnesses can run on
weaker (often free) models.

## Quick start

```bash
npm install -g llm-relay
llm-relay onboard          # collect free provider keys (NIM, Groq, Gemini, OpenRouter, ...)
llm-relay setup claude-desktop   # or: llm-relay setup claude-cli
llm-relay                  # start the proxy — leave it running
```

Then verify:

```bash
llm-relay keys             # are the credentials good?
llm-relay pools --probe    # does every configured model actually answer?
```

New here? [docs/QUICKSTART.md](docs/QUICKSTART.md) is a staged setup guide you can hand
straight to an AI assistant ("set this up for me"). It also covers keeping the relay running
at login.

## What you get

- **Pools with failover** — `model: "pool/medium"` expands to a ranked candidate list; 429s
  and outages cascade to the next member. Free-model pools update themselves from live catalogs.
- **Passthrough** — Claude traffic keeps your own credentials and reaches real Anthropic
  untouched, while `pool/*` requests go elsewhere. One proxy, both behaviours.
- **Opt-in offload** — route Claude/Codex subagents (or whole conversations) to free
  providers. `llm-relay candidates` compares targets; a `freeOnly` guard ensures rerouted
  traffic never spends money.
- **Tool-call repair** — malformed tool calls are corrected and re-validated; destructive
  tool calls are refused, never fabricated; unrepairable calls fail clean.
- **Both API fronts** — Anthropic `/v1/messages` plus OpenAI `/v1/chat/completions` and
  `/v1/responses`, translated in either direction, streaming included.
- **Honest metadata** — per-deployment limits and prices with provenance, capability scores
  synced from four leaderboards, metadata-only logging, loopback-only binding.

## Learn more

- [docs/reference.md](docs/reference.md) — full reference: config, routing, pools, offload,
  repair, CLI, endpoints, and every caveat.
- [docs/subagent-routing.md](docs/subagent-routing.md) — offload design and wire evidence.
- [docs/pool-failover.md](docs/pool-failover.md) — how failover and health tracking behave.
- [docs/capability-sources.md](docs/capability-sources.md) — where capability scores come from.
- [docs/project-goals.md](docs/project-goals.md) — what this project is and is not.

`llm-relay help` lists every command. [CLAUDE.md](CLAUDE.md) maps the source for contributors.
