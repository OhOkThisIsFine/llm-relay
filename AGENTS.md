## Start here

**llm-relay is retired (2026-09-23).** The repository is archived. Do not start work here.
[HANDOFF.md](HANDOFF.md) names the replacement. `CLAUDE.md` and `docs/` describe the last
release, v0.86.0, and are kept for reference only.

<!-- audit-code:begin -->
## /audit-code
When the user enters `/audit-code`, treat it as this repository's autonomous audit workflow.
If your host does not automatically register the installed slash command file, load and follow [the repo-local audit directive](.audit-code/install/audit-code.import.md).
Normal usage should stay conversation-first and avoid manual `--root`, provider flags, or model-selection arguments.
<!-- audit-code:end -->

<!-- remediate-code:begin -->
## /remediate-code
When the user enters `/remediate-code`, treat it as this repository's autonomous remediation workflow.
If your host does not automatically register the installed slash command file, load and follow [the repo-local remediate directive](.remediate-code/install/remediate-code.import.md).
Normal usage should stay conversation-first and avoid manual `--root`, provider flags, or model-selection arguments.
<!-- remediate-code:end -->
