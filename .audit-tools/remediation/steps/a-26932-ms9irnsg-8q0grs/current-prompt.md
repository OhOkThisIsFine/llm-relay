# Context Collection

Collect the code and documentation context relevant to the goal.

> Set the shell/tool working directory to `C:\Code\llm-relay` before running any commands.

## Required Inputs
- `C:\Code\llm-relay\.audit-tools\remediation\intake\contract\goal_spec.input.json` (goal_spec)

## Source Inputs

- `C:\Code\llm-relay\.audit-tools\remediation\intake\remediation-brief.md`
- `C:\Code\llm-relay\.audit-tools\remediation\intake\contract\approved-findings.json`

## Path-A Audit Seed

This run originates from a structured audit-findings report. The seed file below contains the findings summary and affected files — your output must frame the goal and context around these findings so every subsequent pipeline node traces to an auditor finding:

- `C:\Code\llm-relay\.audit-tools\remediation\intake\contract\path_a_seed.json` (path_a_seed)

## Your Task

Read only the artifact files listed above. Do not read unrelated source files.

Write your result to exactly:

`C:\Code\llm-relay\.audit-tools\remediation\intake\contract\context_bundle.input.json`

The output must conform to this JSON schema shape:

```json
{
  "contract_version": "remediate-code-contract-pipeline/context-bundle/v1alpha1",
  "goal_id": "<from goal_spec>",
  "entries": [{ "path": "<repo-relative>", "kind": "source|test|config|doc", "relevance_reason": "..." }],
  "context_summary": "<free-text summary>"
}
```

Before advancing, you can self-check the output against its contract:

`remediate-code validate-artifact --name context_bundle --file C:/Code/llm-relay/.audit-tools/remediation/intake/contract/context_bundle.input.json --root C:/Code/llm-relay`

A `status: "ok"` result means the structure is valid; otherwise fix the reported issues before running next-step.

**Stop after writing the output file.** Do not edit source files. Do not advance to the next pipeline step.


After writing the output file, run:

`remediate-code next-step`
