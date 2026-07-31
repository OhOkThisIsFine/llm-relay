# Adversarial Critic (Counterexample Search)

Adversarially attack the design: produce concrete counterexamples that falsify design invariants, obligations, or assessment claims. Each counterexample must name the claim it falsifies, concrete reproduction steps, and the obligation(s) it violates. Search hard for inputs, orderings, and edge states the design mishandles; an empty counterexamples array is only acceptable when you genuinely cannot falsify anything.

> Set the shell/tool working directory to `C:\Code\llm-relay` before running any commands.

## Independent Review — MANDATORY

This is an adversarial review phase: its value comes from a reviewer who is **not** the author of the design under review. You MUST dispatch this review to a fresh, independent sub-agent — one that did NOT author the upstream contract artifacts and does not see the author's reasoning. An author grading their own work systematically misses the gaps this phase exists to catch. Do NOT perform this review inline yourself.

## Required Inputs
- `C:\Code\llm-relay\.audit-tools\remediation\intake\contract\goal_spec.input.json` (goal_spec)
- `C:\Code\llm-relay\.audit-tools\remediation\intake\contract\finalized_module_contracts.input.json` (finalized_module_contracts)
- `C:\Code\llm-relay\.audit-tools\remediation\intake\contract\obligation_ledger.input.json` (obligation_ledger)
- `C:\Code\llm-relay\.audit-tools\remediation\intake\contract\contract_assessment_report.input.json` (contract_assessment_report)

## Source Inputs

- `C:\Code\llm-relay\.audit-tools\remediation\intake\remediation-brief.md`
- `C:\Code\llm-relay\.audit-tools\remediation\intake\contract\approved-findings.json`

## Your Task

Read only the artifact files listed above. Do not read unrelated source files.

Write your result to exactly:

`C:\Code\llm-relay\.audit-tools\remediation\intake\contract\counterexample.input.json`

The output must conform to this JSON schema shape:

```json
{
  "contract_version": "remediate-code-contract-pipeline/counterexample/v1alpha1",
  "goal_id": "<from goal_spec>",
  "counterexamples": [{
    "id": "CE-001",
    "claim": "<the design/assessment claim being falsified>",
    "reproduction_steps": ["<concrete step>"],
    "expected": "<what the design promises>",
    "actual": "<what actually happens under this counterexample>",
    "violated_obligation_ids": ["<obligation_id>"]
  }]
}
```

Before advancing, you can self-check the output against its contract:

`remediate-code validate-artifact --name counterexample --file C:/Code/llm-relay/.audit-tools/remediation/intake/contract/counterexample.input.json --root C:/Code/llm-relay`

A `status: "ok"` result means the structure is valid; otherwise fix the reported issues before running next-step.

**Stop after writing the output file.** Do not edit source files. Do not advance to the next pipeline step.


After writing the output file, run:

`remediate-code next-step`
