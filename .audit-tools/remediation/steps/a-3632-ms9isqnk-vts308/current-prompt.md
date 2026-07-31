# Per-Module Contract Drafting — Parallel Wave (4 modules)

This phase fans out to ONE sub-agent PER MODULE. Dispatch the 4 modules below as parallel sub-agents in waves of at most **4** concurrent agents (the quota/host concurrency cap). Each sub-agent reads only its module's file scope, then writes ONLY that module's contract shard — no agent owns both sides of a seam, and no agent writes the aggregated artifact.

> Set the shell/tool working directory to `C:\Code\llm-relay` before running any commands.

## Shared Inputs (every sub-agent may read these)

- `C:\Code\llm-relay\.audit-tools\remediation\intake\contract\goal_spec.input.json` (goal_spec)
- `C:\Code\llm-relay\.audit-tools\remediation\intake\contract\context_bundle.input.json` (context_bundle)
- `C:\Code\llm-relay\.audit-tools\remediation\intake\contract\module_decomposition.input.json` (module_decomposition)

## Per-Module Assignments — one sub-agent each

For each module, dispatch one sub-agent to read its file scope from `module_decomposition` and draft its module contract, writing the result to the module's shard path:

1. **server-core** — file scope: `src/server.ts`, `src/circuit-breaker.ts`
   - Write this module's contract to exactly: `C:\Code\llm-relay\.audit-tools\remediation\intake\contract\module-waves\module_contract_drafting\server-core-07023509.json`
2. **backend-auth** — file scope: `src/backend.ts`, `src/authEnv.ts`
   - Write this module's contract to exactly: `C:\Code\llm-relay\.audit-tools\remediation\intake\contract\module-waves\module_contract_drafting\backend-auth-bac93ac0.json`
3. **config-routing** — file scope: `src/config.ts`
   - Write this module's contract to exactly: `C:\Code\llm-relay\.audit-tools\remediation\intake\contract\module-waves\module_contract_drafting\config-routing-b9129958.json`
4. **cli-tools** — file scope: `src/cli.ts`
   - Write this module's contract to exactly: `C:\Code\llm-relay\.audit-tools\remediation\intake\contract\module-waves\module_contract_drafting\cli-tools-4019eebc.json`

Each shard must be a single JSON object of this shape (the orchestrator merges all shards into the aggregated `module_contracts` artifact — do NOT write that file yourself):

```json
{
  "name": "<module-name — must equal the assigned module>",
  "inputs": ["<what this module receives>"],
  "outputs": ["<what this module produces>"],
  "invariants": ["<invariant that must hold — include a verification_obligation note>"],
  "side_effects": ["<observable side-effects with owner>"],
  "validation_boundary": "<what this module validates vs. what callers must guarantee>",
  "failure_modes": ["<ways this module can fail and how callers should handle them>"],
  "neighbor_needs": [{ "neighbor": "<module-name>", "needs": "<what this module needs>" }]
}
```

## After All Sub-Agents Finish

Once every module's shard above has been written (all 4), run:

`remediate-code next-step`

The orchestrator verifies every module shard is present, merges them into `module_contracts`, and advances. If any shard is missing, this same wave is re-emitted for the missing modules — never a partial aggregate.

**Stop after the per-module shards are written and you run next-step.** Do not edit source files. Do not write the aggregated artifact. Do not advance further.
