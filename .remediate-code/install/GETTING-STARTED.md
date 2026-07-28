# remediate-code bootstrap guide

The canonical product route is `/remediate-code` in conversation.

Shared repo-local assets:
- prompt asset: `.remediate-code/install/remediate-code.import.md`
- skill asset: `.remediate-code/install/SKILL.md`
- host manifest: `.remediate-code/install/manifest.json`

Host-specific quick starts:
- Codex: Use the global Codex skill installed by npm plus AGENTS fallback instructions for this repository. Repo-local Codex skill bundles are intentionally not generated.
- OpenCode: Use the global OpenCode `/remediate-code` command installed by npm plus generated project permissions.
- VS Code: Use the generated prompt file and custom agent for next-step-first VS Code integration.
- Antigravity: Uses the project-scoped .agent/skills/remediate-code/SKILL.md skill, the .gemini/commands/remediate-code.toml slash command, the planning guide, and AGENTS instructions.

## Codex

Support level: supported
Setup kind: global-skill+instructions

Use the global Codex skill installed by npm plus AGENTS fallback instructions for this repository. Repo-local Codex skill bundles are intentionally not generated.

Primary repo-local path:
- `AGENTS.md`

Supporting repo-local paths:
- `.remediate-code/install/remediate-code.import.md`

Recommended steps:
- Open this repository in Codex.
- Use the global `/remediate-code` skill installed by `npm install -g audit-tools`.
- If the global skill is unavailable, follow the AGENTS fallback instructions that point at the repo-local prompt asset.

## OpenCode

Support level: supported
Setup kind: global-command+project-permissions

Use the global OpenCode `/remediate-code` command installed by npm plus generated project permissions.

Primary repo-local path:
- `opencode.json`

Supporting repo-local paths:
- `AGENTS.md`

Recommended steps:
- Open this repository in OpenCode.
- Use the global `/remediate-code` command installed by `npm install -g audit-tools`.
- Let OpenCode load the generated `opencode.json` for project permissions; the global command drives `remediate-code next-step` directly.

## VS Code

Support level: supported
Setup kind: prompt+agent

Use the generated prompt file and custom agent for next-step-first VS Code integration.

Primary repo-local path:
- `.github/prompts/remediate-code.prompt.md`

Supporting repo-local paths:
- `.github/agents/remediator.agent.md`
- `.github/copilot-instructions.md`

Recommended steps:
- Open this repository in VS Code with Copilot.
- Invoke `/remediate-code` from the generated prompt or chat so the workflow calls `remediate-code next-step` directly.

## Antigravity

Support level: supported
Setup kind: agent-skill+gemini-command+planning-guide

Uses the project-scoped .agent/skills/remediate-code/SKILL.md skill, the .gemini/commands/remediate-code.toml slash command, the planning guide, and AGENTS instructions.

Primary repo-local path:
- `.agent/skills/remediate-code/SKILL.md`

Supporting repo-local paths:
- `.gemini/commands/remediate-code.toml`
- `.remediate-code/install/antigravity/PLANNING-MODE.md`
- `AGENTS.md`
- `.remediate-code/install/remediate-code.import.md`

Recommended steps:
- Open this repository in Antigravity.
- The remediate-code skill is automatically discovered from .agent/skills/remediate-code/SKILL.md.
- The /remediate-code slash command is also available from .gemini/commands/remediate-code.toml.
- Use `remediate-code next-step` directly.

Backend fallback:
- from the repository root, run `remediate-code` only when you intentionally need the repo-local backend wrapper
- run `remediate-code verify-install` after bootstrap when you want to smoke-test the generated launchers and host configs
- rerun `remediate-code install` to refresh every generated host surface from the shared prompt and skill assets together
