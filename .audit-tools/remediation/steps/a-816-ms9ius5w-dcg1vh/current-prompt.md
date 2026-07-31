# Test and Validator Plan

Convert every obligation in the obligation ledger into a concrete test spec BEFORE any implementation begins. One TestSpec entry per obligation. A worker may flag a planned test inapplicable only by citing the specific obligation_id it disputes and providing a falsifiable reason that can be checked against the ledger — bare rationale is not sufficient. Do not invent obligations not present in the ledger.

> Set the shell/tool working directory to `C:\Code\llm-relay` before running any commands.

## Required Inputs
- `C:\Code\llm-relay\.audit-tools\remediation\intake\contract\goal_spec.input.json` (goal_spec)
- `C:\Code\llm-relay\.audit-tools\remediation\intake\contract\obligation_ledger.input.json` (obligation_ledger)

## Source Inputs

- `C:\Code\llm-relay\.audit-tools\remediation\intake\remediation-brief.md`
- `C:\Code\llm-relay\.audit-tools\remediation\intake\contract\approved-findings.json`

## Your Task

Read only the artifact files listed above. Do not read unrelated source files.

Write your result to exactly:

`C:\Code\llm-relay\.audit-tools\remediation\intake\contract\test_validator_plan.input.json`

The output must conform to this JSON schema shape:

```json
{
  "contract_version": "remediate-code-contract-pipeline/test-validator-plan/v1alpha1",
  "goal_id": "<from goal_spec>",
  "test_specs": [{
    "obligation_id": "<id from obligation_ledger>",
    "name": "<short test name>",
    "kind": "unit | integration | schema | invariant | e2e",
    "assertions": ["<concrete, falsifiable assertion>"],
    "inapplicable_claim": {
      "obligation_id": "<must match obligation_id above>",
      "reason": "<falsifiable reason checkable against the ledger>"
    }
  }]
}
```

Before advancing, you can self-check the output against its contract:

`remediate-code validate-artifact --name test_validator_plan --file C:/Code/llm-relay/.audit-tools/remediation/intake/contract/test_validator_plan.input.json --root C:/Code/llm-relay`

A `status: "ok"` result means the structure is valid; otherwise fix the reported issues before running next-step.

**Stop after writing the output file.** Do not edit source files. Do not advance to the next pipeline step.

## Pre-filled Skeleton — fill only the blank slots

The obligation ledger was derived deterministically. Below is the test-plan skeleton: one spec per testable obligation, with `obligation_id`, `name`, `kind`, and `scope_anchors` already filled. Fill ONLY each `assertions` array — every spec needs at least one positive (satisfied-path) assertion AND one negative (failure-path) assertion. The negative assertion MUST name one of the spec's `scope_anchors` (the touched symbol/file) and must not be an unscoped repo-wide scan, or it fails the negative-scoping gate. Do not add, remove, or rename specs. If an obligation is genuinely untestable, replace its spec body with an `inapplicable_claim` citing its `obligation_id` and a falsifiable reason.

```json
{
  "test_specs": [
    {
      "obligation_id": "OBL-server-core-inv-1",
      "name": "Mid-stream network resets or SSE truncations must report fail...",
      "kind": "invariant",
      "scope_anchors": [
        "sse"
      ],
      "assertions": []
    },
    {
      "obligation_id": "OBL-server-core-fail-1",
      "name": "Handle failure mode: Backend socket reset or timeout (caller ...",
      "kind": "unit",
      "scope_anchors": [
        "sse"
      ],
      "assertions": []
    },
    {
      "obligation_id": "OBL-backend-auth-inv-1",
      "name": "Env-var credential resolution must consistently use readCrede...",
      "kind": "invariant",
      "scope_anchors": [
        "obl-backend-auth-inv-1",
        "env-var",
        "readcredential",
        "verification_obligation",
        "authenv"
      ],
      "assertions": []
    },
    {
      "obligation_id": "OBL-backend-auth-fail-1",
      "name": "Handle failure mode: Missing or invalid credential (caller re...",
      "kind": "unit",
      "scope_anchors": [
        "obl-backend-auth-fail-1"
      ],
      "assertions": []
    },
    {
      "obligation_id": "OBL-config-routing-inv-1",
      "name": "Subagent directive parsing must strictly restrict @relay: mat...",
      "kind": "invariant",
      "scope_anchors": [
        "obl-config-routing-inv-1",
        "verification_obligation"
      ],
      "assertions": []
    },
    {
      "obligation_id": "OBL-config-routing-fail-1",
      "name": "Handle failure mode: Invalid configuration format (throws Rou...",
      "kind": "unit",
      "scope_anchors": [
        "obl-config-routing-fail-1",
        "routingerror"
      ],
      "assertions": []
    },
    {
      "obligation_id": "OBL-cli-tools-inv-1",
      "name": "SHELL_SAFE regex and positional argument parsing must correct...",
      "kind": "invariant",
      "scope_anchors": [
        "cli"
      ],
      "assertions": []
    },
    {
      "obligation_id": "OBL-cli-tools-fail-1",
      "name": "Handle failure mode: Unknown command or invalid flag options",
      "kind": "unit",
      "scope_anchors": [
        "obl-cli-tools-fail-1"
      ],
      "assertions": []
    }
  ]
}
```

Self-check before next-step: `remediate-code validate-artifact --name test_validator_plan --file C:/Code/llm-relay/.audit-tools/remediation/intake/contract/test_validator_plan.input.json`

After writing the output file, run:

`remediate-code next-step`
