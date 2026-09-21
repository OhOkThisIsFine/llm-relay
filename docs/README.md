# Documentation index

Start with the row that matches what you want to do.

| You want | Read |
|---|---|
| To install and run the relay | [`QUICKSTART.md`](QUICKSTART.md) |
| Every option, endpoint and caveat | [`reference.md`](reference.md) |
| To understand the code before changing it | [`architecture.md`](architecture.md) |
| To submit a change | [`../CONTRIBUTING.md`](../CONTRIBUTING.md) |
| To know what this project is, and is not | [`project-goals.md`](project-goals.md) |
| The convictions that settle a design question | [`project-philosophy.md`](project-philosophy.md) |
| What is still open | [`backlog.md`](backlog.md) |
| What development should happen next | [`history/development-plan-2026-09-21.md`](history/development-plan-2026-09-21.md) |

## Subject documents

Each of these covers one subject in depth. Read one when you work on that subject.

| Document | Subject |
|---|---|
| [`pool-failover.md`](pool-failover.md) | how failover, health and circuit breaking behave |
| [`pool-eligibility.md`](pool-eligibility.md) | which deployments a pool may admit, and why |
| [`subagent-routing.md`](subagent-routing.md) | offload design, and the wire evidence behind it |
| [`host-adaptive-dispatch.md`](host-adaptive-dispatch.md) | how dispatch adapts to the calling host |
| [`offload-agentic-capability.md`](offload-agentic-capability.md) | what an offloaded agent lane can and cannot do |
| [`capability-sources.md`](capability-sources.md) | where capability scores come from |
| [`tool-call-dialect-leak.md`](tool-call-dialect-leak.md) | how a host leaks a tool call as plain text |
| [`delegate-gate.md`](delegate-gate.md) | the quality gate over a diff an agent lane returned |

## Data files

| File | Holds |
|---|---|
| `tier-data.json` | the synced capability snapshot. Regenerate with `npm run sync:tiers`. |
| `dashboard-bundle-inventory.json` | the published dashboard bundle inventory |
| `dashboard-package-baseline.json` | the package-size ceiling the gate checks |

## Other directories

- [`history/`](history/) — dated records: design notes, audits, plans and lap closeouts. These are
  evidence/history rather than the live user reference. Read [`history/README.md`](history/README.md)
  first.
- [`../CLAUDE.md`](../CLAUDE.md) — the full source map, written for an AI coding assistant. It
  states the reason behind each rule. Read [`architecture.md`](architecture.md) first.
