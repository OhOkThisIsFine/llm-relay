# Dispatch Implementation Work (host-subagent rolling, worktree-isolated)

Each granted node runs in its OWN git worktree (hard isolation between nodes). The
TOOL owns commit -> verify -> merge + write-scope; you only spawn a subagent per
node and call `accept-node` as each finishes.

The tool ADMITTED this set against the live budget (and any declared in-flight cap):
dispatch EXACTLY the 2 node(s) below and no more.
Their count is the whole grant — there is no separate concurrency cap. When they are
all accepted, merge and re-invoke next-step; the tool re-grants the pending remainder.

**Driver — drive the loop yourself.** The frontier is small (or only one
slot is available), so a separate dispatcher subagent is not worth its
overhead. Run the rolling loop directly: keep up to the 2 granted node(s)
node-subagents running at once and dispatch the next pending node as each
one completes.

Spawn ONE subagent for EACH granted node below. Give the subagent that node's
`prompt`, and set its working directory to the node's **worktree** path. The
subagent edits source files INSIDE that worktree and writes ONLY its result file.
Do NOT let any subagent edit the main repository tree.

Granted nodes (worktrees already created):
- `CP-BLOCK-CP-NODE-3` — prompt: `C:\Code\llm-relay\.audit-tools\remediation\runs\remediate-audit-findings-2026-07-31\implement\implement-CP-BLOCK-CP-NODE-3.md` — worktree (subagent cwd): `C:\Code\llm-relay\.audit-tools\worktrees\remediate-CP-BLOCK-CP-NODE-3-remediate-audit-findings-2026-07-31`
- `CP-BLOCK-CP-NODE-4` — prompt: `C:\Code\llm-relay\.audit-tools\remediation\runs\remediate-audit-findings-2026-07-31\implement\implement-CP-BLOCK-CP-NODE-4.md` — worktree (subagent cwd): `C:\Code\llm-relay\.audit-tools\worktrees\remediate-CP-BLOCK-CP-NODE-4-remediate-audit-findings-2026-07-31`

As EACH subagent finishes, run (substituting the finished node's block id):

`remediate-code accept-node --id "<BLOCK_ID>" --run-id remediate-audit-findings-2026-07-31`

It runs the commit -> verify -> merge lifecycle for that node and prints a JSON
directive on stdout:
- `{"directive":"wait",...}` — other granted nodes are still in flight; do not spawn more.
- `{"directive":"done",...}` — every granted node reached a terminal accept. Then run:

`remediate-code merge-implement-results --run-id remediate-audit-findings-2026-07-31`

If the directive's `accept_failed` array names any node, that node's accept FAILED and
nothing landed. Do NOT re-run `accept-node` for it (that only re-reports the failure).
If the node had COMMITTED work, it is preserved under a quarantine ref and the recovery
is to fix the named cause and re-drive it with the command below; if the node never
committed (its worker died or errored before making an edit) there is no ref, that
command answers `no_quarantine`, and the merge routes its items to triage instead. The
node's recorded diagnostic says which case it is — read it before choosing.

`remediate-code reverify-node --id "<BLOCK_ID>" --run-id remediate-audit-findings-2026-07-31`

If the directive's `accept_stray` array names any node, that node committed NOTHING:
its result claimed a resolved edit but its designated worktree held no commits, so the
edits were made somewhere the tool cannot see (a second worktree, or the main tree).
Its work is NOT recoverable — there is no quarantine ref, so `reverify-node` would
return `no_quarantine`, and its worktree has already been removed. Do not run
`reverify-node` for it and do not re-spawn a subagent for it in this step. The tool has
already recorded the node as hard-failed; run the `merge-implement-results` command
shown ABOVE as usual, which blocks its items and routes them to triage. `accept-node`
for that node exits NON-ZERO with the diagnostic on stderr — that exit code is expected,
and it still prints the directive on stdout, so read the directive and keep going.

Then run:

`remediate-code next-step`





For each subagent, pass its `prompt_path` to the agent tool directly — do not read the worker prompt file into this conversation. Each worker executes in its own context and writes only to its assigned result path.

If you need any working files while driving this dispatch (batch lists, helper scripts, notes), write them under `C:\Code\llm-relay\.audit-tools\remediation\scratch\remediate-audit-findings-2026-07-31` — never at the repository root or anywhere else in the repository's tree.
