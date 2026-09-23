# llm-relay

> **Retired 2026-09-23.** This project gets no further work, and the repository is archived. The npm
> package is deprecated. Its replacement is agent-dispatch, a private project that adopts standard
> components instead: an OpenCode worker behind an MCP bridge, with a LiteLLM proxy in front of the
> model endpoints. [HANDOFF.md](HANDOFF.md) has the detail. The text below
> describes the last release (v0.86.0) and is kept for reference only.

A local traffic router for LLM clients and coding agents. It gives one client a single place to route requests across models, providers, credentials, and agent lanes, with failover and observability built in.

Use it to:

- keep primary work on your preferred model while offloading suitable background tasks;
- spread traffic across available quotas and credentials;
- fail over when a provider or model is unavailable;
- dispatch self-contained agent work from MCP-capable hosts;
- bridge Anthropic- and OpenAI-compatible traffic;
- validate and repair malformed tool calls;
- inspect routing, usage, latency, quota, and cost information locally.

## Quick start

Requires Node.js 22 or newer.

```bash
npm install -g llm-relay
llm-relay onboard
llm-relay
```

Then follow the [quick start](docs/QUICKSTART.md) to connect your client or MCP host.

Useful checks:

```bash
llm-relay keys
llm-relay pools --probe
```

For local analytics:

```bash
llm-relay dashboard
```

## Core capabilities

- **Local routing** — runs as a loopback service on your machine.
- **Pools and failover** — routes across configured targets and reacts to availability and limits.
- **Credential handling** — supports multiple credentials and local key management.
- **Agent dispatch** — hands complete tasks to configured lanes through MCP or the CLI.
- **API compatibility** — accepts Anthropic- and OpenAI-compatible clients, including streaming traffic.
- **Tool-call repair** — validates model tool calls and attempts safe repair when they are malformed.
- **Usage visibility** — records local metadata for routing, usage, latency, quota, and cost inspection.

## Documentation

- [Quick start](docs/QUICKSTART.md) — install, configure, and connect a client.
- [Reference](docs/reference.md) — configuration, routing, commands, APIs, and caveats.
- [Project goals](docs/project-goals.md) — what llm-relay is intended to do.
- [Architecture](docs/architecture.md) — codebase overview.
- [Contributing](CONTRIBUTING.md) — development and contribution workflow.

Run `llm-relay help` for the command overview.
