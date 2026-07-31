# Contract Assessment

Assess whether the design spec satisfies all invariants and obligations.

> Set the shell/tool working directory to `C:\Code\llm-relay` before running any commands.

## Required Inputs
- `C:\Code\llm-relay\.audit-tools\remediation\intake\contract\goal_spec.input.json` (goal_spec)
- `C:\Code\llm-relay\.audit-tools\remediation\intake\contract\finalized_module_contracts.input.json` (finalized_module_contracts)
- `C:\Code\llm-relay\.audit-tools\remediation\intake\contract\obligation_ledger.input.json` (obligation_ledger)

## Source Inputs

- `C:\Code\llm-relay\.audit-tools\remediation\intake\remediation-brief.md`
- `C:\Code\llm-relay\.audit-tools\remediation\intake\contract\approved-findings.json`

## Your Task

Read only the artifact files listed above. Do not read unrelated source files.

Write your result to exactly:

`C:\Code\llm-relay\.audit-tools\remediation\intake\contract\contract_assessment_report.input.json`

The output must conform to this JSON schema shape:

```json
{
  "contract_version": "remediate-code-contract-pipeline/contract-assessment-report/v1alpha1",
  "goal_id": "<from goal_spec>",
  "findings": [{ "obligation_id": "<id>", "status": "satisfied|violated|uncertain", "evidence": ["..."], "rationale": "..." }],
  "verdict": "passed | failed | partial"
}
```

Before advancing, you can self-check the output against its contract:

`remediate-code validate-artifact --name contract_assessment_report --file C:/Code/llm-relay/.audit-tools/remediation/intake/contract/contract_assessment_report.input.json --root C:/Code/llm-relay`

A `status: "ok"` result means the structure is valid; otherwise fix the reported issues before running next-step.

**Stop after writing the output file.** Do not edit source files. Do not advance to the next pipeline step.


After writing the output file, run:

`remediate-code next-step`
