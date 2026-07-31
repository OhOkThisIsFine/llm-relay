# Goal Normalization

Normalize the remediation objective into a bounded, unambiguous goal spec.

> Set the shell/tool working directory to `C:\Code\llm-relay` before running any commands.

## Required Inputs
_No artifact inputs required for this role._

## Source Inputs

- `C:\Code\llm-relay\.audit-tools\remediation\intake\remediation-brief.md`
- `C:\Code\llm-relay\.audit-tools\remediation\intake\contract\approved-findings.json`

## Path-A Audit Seed

This run originates from a structured audit-findings report. The seed file below contains the findings summary and affected files — your output must frame the goal and context around these findings so every subsequent pipeline node traces to an auditor finding:

- `C:\Code\llm-relay\.audit-tools\remediation\intake\contract\path_a_seed.json` (path_a_seed)

## Your Task

Read only the artifact files listed above. Do not read unrelated source files.

Write your result to exactly:

`C:\Code\llm-relay\.audit-tools\remediation\intake\contract\goal_spec.input.json`

The output must conform to this JSON schema shape:

```json
{
  "contract_version": "remediate-code-contract-pipeline/goal-spec/v1alpha1",
  "goal_id": "<stable-identifier>",
  "objective": "<single-sentence primary objective>",
  "non_goals": ["<explicit out-of-scope items>"],
  "success_criteria": ["<measurable criteria>"],
  "source_type": "conversation | document | structured_audit | mixed"
}
```

Before advancing, you can self-check the output against its contract:

`remediate-code validate-artifact --name goal_spec --file C:/Code/llm-relay/.audit-tools/remediation/intake/contract/goal_spec.input.json --root C:/Code/llm-relay`

A `status: "ok"` result means the structure is valid; otherwise fix the reported issues before running next-step.

**Stop after writing the output file.** Do not edit source files. Do not advance to the next pipeline step.


After writing the output file, run:

`remediate-code next-step`
