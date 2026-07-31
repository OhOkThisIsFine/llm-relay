# Adversarial Judge

Judge every counterexample from the critic: `accepted` (real flaw the contract must address), `out_of_scope` (outside the goal spec), `duplicate`, `invalid` (does not actually falsify the claim), or `residual_risk` (real but tolerable; recorded, not repaired). Verdict is `approved` only when no accepted counterexample demands a contract repair — then omit `repair_directive`. Otherwise verdict is `needs_repair` and `repair_directive` must name the single artifact whose regeneration addresses the accepted counterexamples.

> Set the shell/tool working directory to `C:\Code\llm-relay` before running any commands.

## Independent Review — MANDATORY

This is an adversarial review phase: its value comes from a reviewer who is **not** the author of the design under review. You MUST dispatch this review to a fresh, independent sub-agent — one that did NOT author the upstream contract artifacts and does not see the author's reasoning. An author grading their own work systematically misses the gaps this phase exists to catch. Do NOT perform this review inline yourself.

## Required Inputs
- `C:\Code\llm-relay\.audit-tools\remediation\intake\contract\goal_spec.input.json` (goal_spec)
- `C:\Code\llm-relay\.audit-tools\remediation\intake\contract\finalized_module_contracts.input.json` (finalized_module_contracts)
- `C:\Code\llm-relay\.audit-tools\remediation\intake\contract\obligation_ledger.input.json` (obligation_ledger)
- `C:\Code\llm-relay\.audit-tools\remediation\intake\contract\contract_assessment_report.input.json` (contract_assessment_report)
- `C:\Code\llm-relay\.audit-tools\remediation\intake\contract\counterexample.input.json` (counterexample)

## Source Inputs

- `C:\Code\llm-relay\.audit-tools\remediation\intake\remediation-brief.md`
- `C:\Code\llm-relay\.audit-tools\remediation\intake\contract\approved-findings.json`

## Your Task

Read only the artifact files listed above. Do not read unrelated source files.

Write your result to exactly:

`C:\Code\llm-relay\.audit-tools\remediation\intake\contract\judge_report.input.json`

The output must conform to this JSON schema shape:

```json
{
  "contract_version": "remediate-code-contract-pipeline/judge-report/v1alpha1",
  "goal_id": "<from goal_spec>",
  "verdict": "approved | needs_repair",
  "classifications": [{
    "counterexample_id": "<id from the counterexample report>",
    "classification": "accepted | out_of_scope | duplicate | invalid | residual_risk",
    "rationale": "<one-line justification>"
  }],
  "repair_directive": {
    "target": "finalized_module_contracts | obligation_ledger | contract_assessment_report",
    "instruction": "<bounded instruction for regenerating the target artifact>"
  }
}
```

Before advancing, you can self-check the output against its contract:

`remediate-code validate-artifact --name judge_report --file C:/Code/llm-relay/.audit-tools/remediation/intake/contract/judge_report.input.json --root C:/Code/llm-relay`

A `status: "ok"` result means the structure is valid; otherwise fix the reported issues before running next-step.

**Stop after writing the output file.** Do not edit source files. Do not advance to the next pipeline step.


After writing the output file, run:

`remediate-code next-step`
