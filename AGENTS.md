## Start here

**Read [HANDOFF.md](HANDOFF.md) before `CLAUDE.md` or `docs/project-goals.md`.**

Those two files currently state four rules as binding that the owner removed on 2026-08-16 — the
rewrite is outstanding. Following them as written leads back to conclusions that have been
explicitly overturned. `HANDOFF.md` lists exactly which lines are stale, what replaced them, what
still binds, and what the next task is.

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
