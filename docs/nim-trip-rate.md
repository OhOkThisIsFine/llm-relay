# NIM tool-call trip-rate dataset

Generated: live-run · backend: `https://integrate.api.nvidia.com/v1` · reshaper: `meta/llama-3.1-70b-instruct` · 3 trials/scenario

**Trip rate** = share of *emitted tool calls* that fail deterministic schema validation (higher = more format-broken).
**Repair-fix rate** = share of those failures the reshaper corrected via the proxy's `repair()`. Raw records: `docs/nim-trip-rate.jsonl`.

**Signal (this run):** 2 of 8 candidate models were reachable on this account. Only `typed_integer` tripped the validator — and every failure on a live model was repaired.

## Per model (live)
| model | tool calls | valid | fail | trip rate | repair-fix rate | no-tool-call |
|---|---|---|---|---|---|---|
| `meta/llama-3.1-8b-instruct` | 12/12 | 9 | 3 | 0.25 | 1 | 0 |
| `meta/llama-3.1-70b-instruct` | 12/12 | 9 | 3 | 0.25 | 1 | 0 |

## Per scenario (all live models pooled)
| scenario | tool calls | trip rate | repair-fix rate |
|---|---|---|---|
| `flat_single` (easy) | 6 | 0 | — |
| `enum_required` (medium) | 6 | 0 | — |
| `typed_integer` (medium) | 6 | 1 | 1 |
| `nested_object` (hard) | 6 | 0 | — |

## Unavailable on this account (excluded from rates)
| model | reason |
|---|---|
| `meta/llama-3.3-70b-instruct` | timeout |
| `mistralai/mistral-7b-instruct-v0.3` | HTTP 404: {"status":404,"title":"Not Found","detail":"Function 'cd89bd68-13e3-47 |
| `mistralai/mixtral-8x22b-instruct-v0.1` | HTTP 410: {"type":"about:blank","title":"Gone","status":410,"detail":"The model  |
| `microsoft/phi-3-medium-4k-instruct` | HTTP 404: 404 page not found |
| `google/gemma-2-9b-it` | HTTP 404: 404 page not found |
| `qwen/qwen2.5-coder-7b-instruct` | HTTP 404: 404 page not found |

A `timeout` here means slow/cold-start, not confirmed-absent — re-probe with a larger `RP_TRIALS`/timeout; `404/410` means the id isn't served on this account.

## Reading it
- **trip rate ≈ 0** → model is a clean tool-caller on this schema; run `detect`, no repair needed.
- **trip rate high, repair-fix rate high** → format-broken but salvageable; `repair` mode makes it usable.
- **trip rate high, repair-fix rate low** → the failures are semantic (bad intent), not form — outside this proxy's remit.
- **many no-tool-call / api errors** → the model isn't a viable tool backend on this account.
