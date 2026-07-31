# Module Decomposition

Decompose the goal into a set of named modules with rough responsibilities and file scope. Do not draft seam contracts yet — only identify modules and their file ownership. Before assigning a module's file_scope, verify where the named responsibility logic ACTUALLY lives in the repository — open the candidate file and confirm it implements the logic. Do NOT scope a module at a thin re-export shim / barrel (a file that only does `export * from …` / `export { x } from …`): scope it at the file where the real logic lives, or the enforcing gate (validateDecompositionFileScope) will reject a shim-only file_scope.

> Set the shell/tool working directory to `C:\Code\llm-relay` before running any commands.

## Required Inputs
- `C:\Code\llm-relay\.audit-tools\remediation\intake\contract\goal_spec.input.json` (goal_spec)
- `C:\Code\llm-relay\.audit-tools\remediation\intake\contract\context_bundle.input.json` (context_bundle)

## Source Inputs

- `C:\Code\llm-relay\.audit-tools\remediation\intake\remediation-brief.md`
- `C:\Code\llm-relay\.audit-tools\remediation\intake\contract\approved-findings.json`

## Path-A Audit Seed

This run originates from a structured audit-findings report. The seed file below contains the findings summary and affected files — your output must frame the goal and context around these findings so every subsequent pipeline node traces to an auditor finding:

- `C:\Code\llm-relay\.audit-tools\remediation\intake\contract\path_a_seed.json` (path_a_seed)

## Your Task

Read only the artifact files listed above. Do not read unrelated source files.

Write your result to exactly:

`C:\Code\llm-relay\.audit-tools\remediation\intake\contract\module_decomposition.input.json`

The output must conform to this JSON schema shape:

```json
{
  "contract_version": "remediate-code-contract-pipeline/module-decomposition/v1alpha1",
  "goal_id": "<from goal_spec>",
  "modules": [{
    "name": "<module-name>",
    "responsibilities": "<brief description of what this module does>",
    "file_scope": ["<repo-relative paths owned by this module>"]
  }]
}
```

Before advancing, you can self-check the output against its contract:

`remediate-code validate-artifact --name module_decomposition --file C:/Code/llm-relay/.audit-tools/remediation/intake/contract/module_decomposition.input.json --root C:/Code/llm-relay`

A `status: "ok"` result means the structure is valid; otherwise fix the reported issues before running next-step.

**Stop after writing the output file.** Do not edit source files. Do not advance to the next pipeline step.


After writing the output file, run:

`remediate-code next-step`
