# Seam Reconciliation

Deterministically list every seam mismatch where module A's declared output differs from module B's declared input (or neighbor_need). For each mismatch, decide which side adjusts and what the agreed interface is. A seam_reconciliation_report with no mismatches (all seams already consistent) is valid.

> Set the shell/tool working directory to `C:\Code\llm-relay` before running any commands.

## Required Inputs
- `C:\Code\llm-relay\.audit-tools\remediation\intake\contract\module_decomposition.input.json` (module_decomposition)
- `C:\Code\llm-relay\.audit-tools\remediation\intake\contract\module_contracts.input.json` (module_contracts)

## Source Inputs

- `C:\Code\llm-relay\.audit-tools\remediation\intake\remediation-brief.md`
- `C:\Code\llm-relay\.audit-tools\remediation\intake\contract\approved-findings.json`

## Your Task

Read only the artifact files listed above. Do not read unrelated source files.

Write your result to exactly:

`C:\Code\llm-relay\.audit-tools\remediation\intake\contract\seam_reconciliation_report.input.json`

The output must conform to this JSON schema shape:

```json
{
  "contract_version": "remediate-code-contract-pipeline/seam-reconciliation-report/v1alpha1",
  "goal_id": "<from module_contracts>",
  "mismatches": [{
    "seam_id": "<seam-identifier>",
    "module_a": "<module-name>",
    "module_b": "<module-name>",
    "description": "<what A declares vs. what B declares — the mismatch>",
    "resolution": {
      "decision": "<which side adjusts — A | B | both>",
      "agreed_interface": "<the reconciled interface both sides must adopt>"
    }
  }]
}
```

Before advancing, you can self-check the output against its contract:

`remediate-code validate-artifact --name seam_reconciliation_report --file C:/Code/llm-relay/.audit-tools/remediation/intake/contract/seam_reconciliation_report.input.json --root C:/Code/llm-relay`

A `status: "ok"` result means the structure is valid; otherwise fix the reported issues before running next-step.

**Stop after writing the output file.** Do not edit source files. Do not advance to the next pipeline step.


After writing the output file, run:

`remediate-code next-step`
