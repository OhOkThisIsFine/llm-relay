# Evidence — 2026-08-16 review and rubric recalibration

Machine-readable audit trail behind the four narrative documents in `docs/`. Kept because the
headline numbers in those documents ("5 false claims out of 373", "55 rejections re-adjudicated")
are only worth as much as the evidence under them, and a claim without a `path:line` anchor was
discarded rather than recorded.

⚠ **These files are not shipped to npm.** `package.json` `files` lists only `dist`,
`docs/tier-data.json`, `skills`, three scripts, `README.md` and `config.example.json` — so nothing in
this directory reaches the published package.

| File | Contents |
|---|---|
| `claim-verdicts.json` | **375 verdicts** over every checkable claim extracted from the seven comparison/porting documents across both projects. `251 TRUE / 88 PARTIAL / 31 UNVERIFIABLE / 5 FALSE`. Each carries the evidence anchor and, where wrong, a correction. `batch` distinguishes the adopted/skipped/deferred set (128) from the gap/assertion set (247). |
| `readjudications.json` | **55 rejections re-adjudicated** after the owner removed three invariants and two reasoning patterns on 2026-08-16. `reasonStatus` is the load-bearing field: `VOIDED` (25) means the reason rested wholly on a removed invariant, `WEAKENED` (15) partly, `SURVIVES` (11) means an independent technical basis still holds. |
| `reconciliation.json` | The pass that checked whether the 247 late-verified claims changed any conclusion. They did not — but it caught **two chunk-verifier corrections that were themselves wrong**, both of which would have moved a conclusion had they been accepted. |

## How to read these honestly

- **`UNVERIFIABLE` is not a failure.** 31 claims rest on one-shot runtime measurements — a suite
  count, a database byte size, a token-cost ratio — that no source read can reconstruct. They are
  marked rather than guessed.
- **`PARTIAL` is usually staleness, not error.** Most of the 88 are documents that were correct on
  their own date and were pinned at a commit the code moved past. A plan that says "later" for
  something that has not happened yet is a correct plan.
- **`SURVIVES` in the re-adjudications is the important column.** The exercise that produced this
  data existed to correct rejections made on bad reasoning; it would have been trivially easy — and
  useless — to void all 55. Eleven rejections held on grounds the owner's directive never touched.

## Provenance

Produced by three multi-agent workflows on 2026-08-16, each re-deriving facts from source rather
than summarizing prior documents. Agents were instructed to default to skepticism and to treat both
projects' documentation as the thing on trial. Narrative documents:
[status-vs-freellmapi](../status-vs-freellmapi-2026-08-16.md),
[rejection-ledger](../rejection-ledger-2026-08-16.md),
[rubric-recalibration](../rubric-recalibration-2026-08-16.md),
[quota-metering-spec](../quota-metering-spec-2026-08-16.md),
[credential-fleet-design](../credential-fleet-design-2026-08-16.md),
[open-decisions](../open-decisions-2026-08-16.md).
