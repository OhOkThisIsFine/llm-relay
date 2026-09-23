# HANDOFF

Entry point for any agent that finds llm-relay. Read this before `CLAUDE.md`.

## Current state — 2026-09-23: retired

**llm-relay is retired.** The owner stopped all work on it on 2026-09-22. The repository is
archived and the npm package is deprecated. Do not start work here, and do not reinstall the
package.

The replacement is **agent-dispatch**, a separate private project that adopts standard components
instead of custom ones: Claude Code, Codex and Antigravity reach an independently managed OpenCode
worker through an MCP bridge, and the worker reaches the model endpoints through a LiteLLM proxy.
Its design record, `docs/design.md` in that repository, lists what replaced each llm-relay
responsibility and what the switch removed from this machine.

The last release is **v0.86.0**. `CLAUDE.md` and `docs/` describe that release and are kept for
reference only. The adoption plan that led to the replacement is
[`docs/architecture-refactor-plan.md`](docs/architecture-refactor-plan.md). Earlier state, plans and
evidence are in [`docs/history/`](docs/history/) and in git history.

## Next

Nothing. The open items in [`docs/backlog.md`](docs/backlog.md) are closed without action.
