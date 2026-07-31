# Implementation Planning (DAG)

Decompose the implementation into a bounded dependency DAG of tasks. Traceability is mandatory: every node must list at least one obligation id from the obligation ledger (in satisfies_obligations or verification_obligation_ids) or one judge-accepted counterexample id (in addresses_counterexamples) — untraceable nodes are rejected. Accepted and residual_risk counterexamples from the judge report must be covered by nodes or verification obligations.

> Set the shell/tool working directory to `C:\Code\llm-relay` before running any commands.

## Required Inputs
- `C:\Code\llm-relay\.audit-tools\remediation\intake\contract\goal_spec.input.json` (goal_spec)
- `C:\Code\llm-relay\.audit-tools\remediation\intake\contract\context_bundle.input.json` (context_bundle)
- `C:\Code\llm-relay\.audit-tools\remediation\intake\contract\finalized_module_contracts.input.json` (finalized_module_contracts)
- `C:\Code\llm-relay\.audit-tools\remediation\intake\contract\obligation_ledger.input.json` (obligation_ledger)
- `C:\Code\llm-relay\.audit-tools\remediation\intake\contract\contract_assessment_report.input.json` (contract_assessment_report)
- `C:\Code\llm-relay\.audit-tools\remediation\intake\contract\counterexample.input.json` (counterexample)
- `C:\Code\llm-relay\.audit-tools\remediation\intake\contract\judge_report.input.json` (judge_report)

## Source Inputs

- `C:\Code\llm-relay\.audit-tools\remediation\intake\remediation-brief.md`
- `C:\Code\llm-relay\.audit-tools\remediation\intake\contract\approved-findings.json`

## Your Task

Read only the artifact files listed above. Do not read unrelated source files.

Write your result to exactly:

`C:\Code\llm-relay\.audit-tools\remediation\intake\contract\implementation_dag.input.json`

The output must conform to this JSON schema shape:

```json
{
  "contract_version": "remediate-code-contract-pipeline/implementation-dag/v1alpha1",
  "goal_id": "<from goal_spec>",
  "nodes": [{
    "id": "<task-id>",
    "title": "<short title>",
    "description": "<bounded task description>",
    "satisfies_obligations": ["<obligation_id>"],
    "addresses_counterexamples": ["<accepted counterexample id, when applicable>"],
    "addressed_critique_items": ["<advisory conceptual-critique id this node honours, when applicable>"],
    "depends_on": ["<task-id>"],
    "verification_obligation_ids": ["<obligation_id>"],
    "targeted_commands": ["<command to verify>"],
    "status": "pending"
  }],
  "edges": [{ "from": "<id>", "to": "<id>", "kind": "dependency|verification" }]
}
```

Before advancing, you can self-check the output against its contract:

`remediate-code validate-artifact --name implementation_dag --file C:/Code/llm-relay/.audit-tools/remediation/intake/contract/implementation_dag.input.json --root C:/Code/llm-relay`

A `status: "ok"` result means the structure is valid; otherwise fix the reported issues before running next-step.

**Stop after writing the output file.** Do not edit source files. Do not advance to the next pipeline step.

## Pre-filled Skeleton — fill only the blank slots

Below is the implementation-DAG skeleton: ONE node per module (its obligations already grouped), covering every obligation and accepted counterexample. Each node's `depends_on` is already DERIVED from the finalized contracts' data-flow (a node depends on the modules whose `artifact:<name>` outputs it consumes) — keep it unless you know an ordering is wrong. Fill ONLY each node's `title`, `description`, and `targeted_commands`. You MAY further merge or split nodes and refine `depends_on`/`edges` ordering, as long as every obligation stays covered (in `satisfies_obligations` or `verification_obligation_ids`) and every accepted counterexample stays in some node's `addresses_counterexamples`.

Advisory conceptual-critique items (no obligation/counterexample of their own — give each a home in some node's `addressed_critique_items` and let it shape that node's implementation; do NOT smuggle them into test assertions):
- `CRIT-001`: Ensure unit test coverage for individual modules before proceeding to server-core integration phase.

```json
{
  "nodes": [
    {
      "id": "CP-NODE-1",
      "title": "",
      "description": "",
      "satisfies_obligations": [
        "OBL-server-core-contract",
        "OBL-server-core-inv-1",
        "OBL-server-core-fail-1"
      ],
      "addresses_counterexamples": [],
      "addressed_critique_items": [],
      "depends_on": [
        "CP-NODE-2",
        "CP-NODE-3"
      ],
      "verification_obligation_ids": [
        "OBL-server-core-contract",
        "OBL-server-core-inv-1",
        "OBL-server-core-fail-1"
      ],
      "targeted_commands": [],
      "status": "pending"
    },
    {
      "id": "CP-NODE-2",
      "title": "",
      "description": "",
      "satisfies_obligations": [
        "OBL-backend-auth-contract",
        "OBL-backend-auth-inv-1",
        "OBL-backend-auth-fail-1"
      ],
      "addresses_counterexamples": [],
      "addressed_critique_items": [],
      "depends_on": [
        "CP-NODE-3"
      ],
      "verification_obligation_ids": [
        "OBL-backend-auth-contract",
        "OBL-backend-auth-inv-1",
        "OBL-backend-auth-fail-1"
      ],
      "targeted_commands": [],
      "status": "pending"
    },
    {
      "id": "CP-NODE-3",
      "title": "",
      "description": "",
      "satisfies_obligations": [
        "OBL-config-routing-contract",
        "OBL-config-routing-inv-1",
        "OBL-config-routing-fail-1"
      ],
      "addresses_counterexamples": [],
      "addressed_critique_items": [],
      "depends_on": [],
      "verification_obligation_ids": [
        "OBL-config-routing-contract",
        "OBL-config-routing-inv-1",
        "OBL-config-routing-fail-1"
      ],
      "targeted_commands": [],
      "status": "pending"
    },
    {
      "id": "CP-NODE-4",
      "title": "",
      "description": "",
      "satisfies_obligations": [
        "OBL-cli-tools-contract",
        "OBL-cli-tools-inv-1",
        "OBL-cli-tools-fail-1"
      ],
      "addresses_counterexamples": [],
      "addressed_critique_items": [],
      "depends_on": [],
      "verification_obligation_ids": [
        "OBL-cli-tools-contract",
        "OBL-cli-tools-inv-1",
        "OBL-cli-tools-fail-1"
      ],
      "targeted_commands": [],
      "status": "pending"
    }
  ],
  "edges": []
}
```

Self-check before next-step: `remediate-code validate-artifact --name implementation_dag --file C:/Code/llm-relay/.audit-tools/remediation/intake/contract/implementation_dag.input.json`

After writing the output file, run:

`remediate-code next-step`
