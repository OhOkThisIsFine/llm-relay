# Eligibility Research & Proposals — 2026-09-03

Research report on pending refusal interpretations from the `llm-relay eligibility` queue.

Closed class vocabulary: `not-servable`, `subscription-required`, `allowance-exhausted`, `credential-invalid`, `rate-limited` (or "no verdict").  
Closed scope vocabulary: `attempt`, `group`, `deployment`, `credential`, `provider`, `model`.

---

## 1. Groq Tokens-Per-Minute 429 (`sig a568e0cbe2`)

- **Refusal Signature:** `sig a568e0cbe2` (Queue position: `[2]`; note: sibling `[5]` `sig e50c11ddc0` is identical with millisecond units)
- **Target:** `groq/qwen/qwen3.6-27b`
- **HTTP Status:** 429 Too Many Requests (Count: ×57)
- **Normalized Message:**  
  `rate limit reached for model qwen/qwen<n>-<n>b in organization <id> service tier on_demand on tokens per minute (tpm): limit <n> used <n> requested <n> please try again in <n>s. need more tokens? upgrade to dev tier today at <url>`

### (a) Provider Documentation
- **Citations:**
  - Groq Rate Limits Documentation: [https://console.groq.com/docs/rate-limits](https://console.groq.com/docs/rate-limits)
  - Groq Error Codes Documentation: [https://console.groq.com/docs/errors](https://console.groq.com/docs/errors)
- **Details:** Groq enforces multi-tiered rate limits covering Requests Per Minute (RPM), Requests Per Day (RPD), and Tokens Per Minute (TPM). TPM limits are specific to each organization (`org_...`) and model architecture. When a request's estimated token burst exceeds the organization's remaining minute allowance, Groq returns HTTP 429 with standard headers (`retry-after`, `x-ratelimit-reset-tokens`) and states the retry window in seconds or milliseconds.

### (b) Class and Scope
- **Class:** `rate-limited`  
  *Rationale:* This represents classic short-term throughput back-pressure. Under relay rules, `rate-limited` applies to throughput limits that cool down in seconds to ~2 minutes, whereas spent monthly/weekly grants are `allowance-exhausted`. The message explicitly states `tokens per minute (tpm)` and asks to retry in seconds.
- **Scope:** `attempt`  
  *Rationale:* Scoped strictly by what the message states: `for model qwen/... in organization <id>`. It identifies both the model and the organization (the credential slot). A different credential slot (another organization) has its own independent TPM quota, and other models under the same organization have their own TPM buckets. The intersection of one credential slot × one model is `attempt`.

### (c) Impact and Contradiction Check
- **Impact:** A `rate-limited` verdict only temporarily demotes the attempt during its short cooling window; it does not evict the deployment from free pools. This allows other models or credentials to serve while Groq's token bucket replenishes.

### (d) Recommended Operator Command
```bash
llm-relay eligibility propose 2 --sig a568e0cbe2 --class rate-limited --scope attempt --rationale "Groq states organization- and model-specific TPM throughput back-pressure that resets in seconds."
```

---

## 2. NVIDIA NIM Kimi-k3 400 "Degraded Function" (`sig e0160ac366`)

- **Refusal Signature:** `sig e0160ac366` (Queue position: `[3]`)
- **Target:** `nim/moonshotai/kimi-k3`
- **HTTP Status:** 400 Bad Request (Count: ×48)
- **Normalized Message:**  
  `function id '<id>': degraded function cannot be invoked`

### (a) Provider Documentation
- **Citations:**
  - NVIDIA Cloud Functions (NVCF) Documentation: [https://docs.nvidia.com/nvcf/](https://docs.nvidia.com/nvcf/)
  - NVIDIA NIM / Build API Portal: [https://build.nvidia.com/](https://build.nvidia.com/)
- **Details:** NVIDIA NIM hosted models run on NVIDIA Cloud Functions (NVCF). In NVCF's function lifecycle, a deployed function transitions through states: `ACTIVE`, `DEPLOYING`, `DEGRADING`, and `DEGRADED`. The `DEGRADED` status indicates that a function has lost all active GPU execution instances (due to node preemption, capacity reallocation, or scaling events). When in this state, the NVCF API gateway proactively rejects invocation requests with HTTP 400 (`degraded function cannot be invoked`) to prevent queue timeouts. NVCF documentation clarifies that this is a transient infrastructure status that automatically recovers to `DEGRADING` and `ACTIVE` as backend instances become available.

### (b) Class and Scope
- **Class:** **no verdict**  
  *Rationale:* None of the closed fact classes (`not-servable`, `subscription-required`, `allowance-exhausted`, `credential-invalid`, `rate-limited`) applies:
  - Not `not-servable`: The model exists and is part of the catalog; it is temporarily lacking GPU workers.
  - Not `subscription-required`: It is a free-tier preview NIM, not gated by paid plan entitlement.
  - Not `allowance-exhausted` or `rate-limited`: It is an infrastructure capacity state returning HTTP 400, not account exhaustion (402) or throughput throttling (429).
- **Scope:** N/A (states function ID).

### (c) Contradiction Check (`recent.json`)
- **Attempt Count in `recent.json`:**
  - Path: `C:\Users\<user>\.llm-relay\usage\recent.json`
  - Total attempts for `nim` + `moonshotai/kimi-k3`: **63 attempts**
  - **Successful attempts:** **35** (55.6% success rate)
  - Other outcomes: 23 error (`rate_limit`/400), 5 cancelled
- **Analysis:** `nim/moonshotai/kimi-k3` is actively serving and serves as a vital high-capability workhorse in free pools (`pool/high`, `pool/xhigh`). Proposing `not-servable` would immediately evict this deployment from all free pools for 6 hours.
- **Recommendation:** Do **not** evict. Transient instance outages must be handled by the live circuit breaker (`breaker.ts`), which cools on error spikes and re-probes without evicting. Leave this signature pending or reject it to prevent re-queuing without asserting a false fact.

### (d) Recommended Operator Command
**No command.**  
*Reason:* Proposing `not-servable` would falsely evict a primary free-pool model that actively serves (35 successful requests in `recent.json`). NVCF function degradation is a transient platform capacity issue handled by the circuit breaker, not a durable eligibility condition.

---

## 3. Groq 400 "Failed to Validate JSON" (`sig 15e155f580`)

- **Refusal Signature:** `sig 15e155f580` (Queue position: `[4]`)
- **Target:** `groq/qwen/qwen3.6-27b`
- **HTTP Status:** 400 Bad Request (Count: ×3)
- **Normalized Message:**  
  `failed to validate json. please adjust your prompt. see 'failed_generation' for more details.`

### (a) Provider Documentation
- **Citations:**
  - Groq Structured Outputs Documentation: [https://console.groq.com/docs/structured-outputs](https://console.groq.com/docs/structured-outputs)
  - Groq Error Codes Documentation: [https://console.groq.com/docs/errors](https://console.groq.com/docs/errors)
- **Details:** When callers invoke the chat completions endpoint with structured outputs (`response_format: {"type": "json_object"}` or a JSON schema), Groq validates the completion. If the model's generated text fails grammar or schema constraints, Groq returns HTTP 400 with `failed to validate json. please adjust your prompt` and embeds the invalid token sequence in the `failed_generation` field. Groq explicitly instructs the caller to modify their prompt to constrain the output format.

### (b) Class and Scope
- **Class:** **no verdict**  
  *Rationale:* This is a request-specific payload/prompt validation failure, not an infrastructure, quota, or availability condition. It teaches nothing about the deployment or credential eligibility.
- **Scope:** N/A (request-level).

### (c) Impact and Contradiction Check
- **Impact:** Proposing `not-servable` would evict `groq/qwen/qwen3.6-27b` from the pool, while proposing `rate-limited` would needlessly cool it down. Both are incorrect.

### (d) Recommended Operator Command
**No command.**  
*Reason:* "Failed to validate JSON" is an application/prompt-level validation failure for a single structured-output request; none of the closed fact classes applies, and asserting a condition would falsely evict or demote a healthy deployment.

---

## 4. Hugging Face 400 "max_completion_tokens is limited" (`sig f97a2d99b5`)

- **Refusal Signature:** `sig f97a2d99b5` (Queue position: `[6]`)
- **Target:** `huggingface/zai-org/GLM-5.2`
- **HTTP Status:** 400 Bad Request (Count: ×2)
- **Normalized Message:**  
  `payload validation: max_completion_tokens is limited to <n> for glm-<n>`

### (a) Provider Documentation
- **Citations:**
  - Hugging Face Inference Providers Documentation: [https://huggingface.co/docs/api-inference/index](https://huggingface.co/docs/api-inference/index)
  - Hugging Face Text Generation Inference (TGI) Documentation: [https://huggingface.co/docs/text-generation-inference/index](https://huggingface.co/docs/text-generation-inference/index)
- **Details:** Hugging Face Inference Providers and TGI routers employ payload validation workers (`--validation-workers`) to validate request parameters before forwarding to model workers. Hosted endpoints define a hard ceiling on output tokens (`max_completion_tokens` or `max_tokens`). When a client request passes a `max_completion_tokens` value exceeding the deployment's configured cap, TGI rejects the request with HTTP 400: `payload validation: max_completion_tokens is limited to <n> for glm-<n>`.

### (b) Class and Scope
- **Class:** **no verdict**  
  *Rationale:* The closed condition vocabulary (`not-servable`, `subscription-required`, `allowance-exhausted`, `credential-invalid`, `rate-limited`) only covers conditions that demote or evict. This refusal states a parameter measurement (an output ceiling), not an operational defect. As established in `docs/history/eligibility-triage-2026-08-29.md` Finding 2, stated max-output ceilings have no condition home; evicting the model would break legitimate requests whose `max_tokens` fall below the ceiling.
- **Scope:** N/A (`deployment` ceiling).

### (c) Impact and Contradiction Check
- **Impact:** `zai-org/GLM-5.2` is functional for requests adhering to the token ceiling. An eviction (`not-servable`) would cause unnecessary pool starvation.

### (d) Recommended Operator Command
**No command.**  
*Reason:* The message defines an output token ceiling (`max_completion_tokens`) rather than a target unavailability condition; no closed condition class fits, and eviction would discard a working deployment.

---

## Summary

| Item | Sig Digest | Provider / Model | HTTP Status | Verdict Class | Scope | Operator Action / Command |
|---|---|---|---|---|---|---|
| **1 (Queue [2])** | `a568e0cbe2` | `groq/qwen/qwen3.6-27b` | 429 | `rate-limited` | `attempt` | `llm-relay eligibility propose 2 --sig a568e0cbe2 --class rate-limited --scope attempt --rationale "Groq states organization- and model-specific TPM throughput back-pressure that resets in seconds."` |
| **2 (Queue [3])** | `e0160ac366` | `nim/moonshotai/kimi-k3` | 400 | **no verdict** | N/A | **no command** (transient NVCF capacity degradation; 35 successful serves in `recent.json`; let breaker handle) |
| **3 (Queue [4])** | `15e155f580` | `groq/qwen/qwen3.6-27b` | 400 | **no verdict** | N/A | **no command** (prompt/schema validation failure on structured outputs; not an eligibility condition) |
| **4 (Queue [6])** | `f97a2d99b5` | `huggingface/zai-org/GLM-5.2` | 400 | **no verdict** | N/A | **no command** (output token ceiling measurement; not a condition; eviction would break valid calls) |
