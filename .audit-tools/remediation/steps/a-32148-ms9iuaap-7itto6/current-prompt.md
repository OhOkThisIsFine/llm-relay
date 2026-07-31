# Conceptual Design Critique

Provide philosophy/alternatives/directions critique of the finalized module contracts.

> Set the shell/tool working directory to `C:\Code\llm-relay` before running any commands.

## Independent Review — MANDATORY

This is an adversarial review phase: its value comes from a reviewer who is **not** the author of the design under review. You MUST dispatch this review to a fresh, independent sub-agent — one that did NOT author the upstream contract artifacts and does not see the author's reasoning. An author grading their own work systematically misses the gaps this phase exists to catch. Do NOT perform this review inline yourself.

## Required Inputs
- `C:\Code\llm-relay\.audit-tools\remediation\intake\contract\goal_spec.input.json` (goal_spec)
- `C:\Code\llm-relay\.audit-tools\remediation\intake\contract\finalized_module_contracts.input.json` (finalized_module_contracts)

## Source Inputs

- `C:\Code\llm-relay\.audit-tools\remediation\intake\remediation-brief.md`
- `C:\Code\llm-relay\.audit-tools\remediation\intake\contract\approved-findings.json`

## Your Task

Read only the artifact files listed above. Do not read unrelated source files.

Write your result to exactly:

`C:\Code\llm-relay\.audit-tools\remediation\intake\contract\conceptual_design_critique.input.json`

The output must conform to this JSON schema shape:

```json
{
  "contract_version": "remediate-code-contract-pipeline/conceptual-design-critique/v1alpha1",
  "goal_id": "<from goal_spec>",
  "items": [{ "id": "<id>", "kind": "concern|alternative|suggestion", "description": "...", "severity": "blocking|advisory" }],
  "verdict": "approved | approved_with_concerns | rejected"
}
```

Before advancing, you can self-check the output against its contract:

`remediate-code validate-artifact --name conceptual_design_critique --file C:/Code/llm-relay/.audit-tools/remediation/intake/contract/conceptual_design_critique.input.json --root C:/Code/llm-relay`

A `status: "ok"` result means the structure is valid; otherwise fix the reported issues before running next-step.

**Stop after writing the output file.** Do not edit source files. Do not advance to the next pipeline step.

## Mechanically-Derived Phase Cut

This change is **not** executed as one monolithic landing. The tool derived the
following ordered, dependency-gated phase cut from the module-dependency DAG —
each phase's modules depend only on earlier phases, and the scheduler enforces the
ordering with mechanical dependencies (a later-phase module cannot dispatch until
its foundations are verified-complete, with a whole-repo green gate between phases):

- **Phase 0 — foundations** (2 module(s)): cli-tools, config-routing
- **Phase 1 — consumers-1** (1 module(s)): backend-auth
- **Phase 2 — integration** (1 module(s)): server-core

Assess the **design quality** within this phasing. Do NOT reject the work as
"over-scoped" or "too large for one change" — breadth is already handled by
construction: the phases land incrementally, green at every commit. Flag a real
design problem (a wrong boundary, a missing invariant, an unsound seam), not the
number of modules.

After writing the output file, run:

`remediate-code next-step`
