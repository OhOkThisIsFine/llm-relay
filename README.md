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
llm-relay onboard --import keys.env  # import dotenv or a FreeLLMAPI export JSON
llm-relay setup claude-desktop   # register MCP dispatch; or set up a routed claude-cli
llm-relay                  # start the proxy — leave it running
```

For agent-to-agent work, use the `llm-relay` MCP `dispatch` tool from any host. It returns the
chosen lane's answer and owns the process details. If MCP is unavailable, use
`llm-relay dispatch --next-command -t "<task>"` and follow its result. Do not create a `pool/*`
collaboration child in Codex Desktop: its ChatGPT launcher rejects that model before the relay is
contacted. A global install registers the MCP server for local Codex automatically.

Then verify:

```bash
llm-relay keys             # are the credentials good?
llm-relay pools --probe    # does every configured model actually answer?
```

With the relay still running, open its local read-only analytics in another terminal:

```bash
llm-relay dashboard
```

New here? [docs/QUICKSTART.md](docs/QUICKSTART.md) is a staged setup guide you can hand
straight to an AI assistant ("set this up for me"). It also covers keeping the relay running
at login.

## What you get

- **Credential fleets** — give one provider multiple labeled, env-backed keys; the relay walks
  slots breadth-first and keeps account faults and limits separate. [Configure fleets](docs/reference.md#provider-credential-fleets).
- **Encrypted key custody** — add, rotate, revoke, import, and encrypted-only export through an OS-keyring- or passphrase-protected keystore. [Manage keys](docs/reference.md#key-custody).
- **Pools with failover** — `model: "pool/medium"` expands to a ranked candidate list; 429s
  and outages cascade to the next member. Free-model pools update themselves from live catalogs.
- **Passthrough** — Claude traffic keeps your own credentials and reaches real Anthropic
  untouched, while `pool/*` requests go elsewhere. One proxy, both behaviours.
- **Host-independent offload** — MCP `dispatch` chooses and runs a lane from Claude, Codex,
  desktop, CLI, or another MCP host; the CLI dispatch contract is the universal fallback. Direct
  HTTP-routed clients can also opt in to rerouting marked subagents or whole conversations.
- **Tool-call repair** — malformed tool calls are corrected and re-validated; destructive
  tool calls are refused, never fabricated; unrepairable calls fail clean.
- **Both API fronts** — Anthropic `/v1/messages` plus OpenAI `/v1/chat/completions` and
  `/v1/responses`, translated in either direction, streaming included.
- **Local analytics dashboard** — `llm-relay dashboard` opens bounded request/attempt, token,
  spend, latency, provider/model/client/credential, quota, and cooldown views (spend priced only
  from published prices; `llm-relay cost` rolls it up in a terminal). Unknown or unavailable
  accounting remains explicit; the dashboard never guesses a value or starts provider probes.
- **Honest metadata** — per-deployment limits and prices with provenance, capability scores
  synced from four leaderboards, metadata-only logging, loopback-only binding.

## Learn more

- [docs/reference.md](docs/reference.md) — full reference: config, routing, pools, offload,
  repair, CLI, endpoints, and every caveat. It opens with a table of contents.
- [docs/architecture.md](docs/architecture.md) — a map of the code, for a person who wants to
  change it.
- [CONTRIBUTING.md](CONTRIBUTING.md) — how to set up, how to prove a change, and how to report a
  problem without leaking a credential.
- [docs/subagent-routing.md](docs/subagent-routing.md) — offload design and wire evidence.
- [docs/pool-failover.md](docs/pool-failover.md) — how failover and health tracking behave.
- [docs/capability-sources.md](docs/capability-sources.md) — where capability scores come from.
- [docs/project-goals.md](docs/project-goals.md) — what this project is and is not.

`llm-relay help` lists the main commands. To contribute, start at
[CONTRIBUTING.md](CONTRIBUTING.md) and [docs/architecture.md](docs/architecture.md).
[CLAUDE.md](CLAUDE.md) holds the same source map in full detail, written for an AI coding
assistant.
