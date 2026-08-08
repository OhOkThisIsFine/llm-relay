import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  allObservations,
  clearEligibility,
  cooldownUntil,
  isCostBlocked,
  observedEligibility,
  recordEligibility,
  resetEligibility,
  ELIGIBILITY_TTL_MS,
} from "../src/deployment-eligibility.js";
import {
  acceptInterpretation,
  interpretRefusal,
  normalizeRefusalMessage,
  pendingRefusals,
  proposeInterpretation,
  recordUnknownRefusal,
  refusalSignature,
  rejectInterpretation,
  resetInterpretations,
} from "../src/refusal-interpretation.js";

let dir: string;
let path: string;
let interpPath: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "llm-relay-eligibility-"));
  path = join(dir, "eligibility.json");
  interpPath = join(dir, "interpretations.json");
  resetEligibility();
  resetInterpretations();
});

afterEach(() => {
  resetEligibility();
  resetInterpretations();
  rmSync(dir, { recursive: true, force: true });
});

/**
 * The bodies below are VERBATIM from probes against real accounts on 2026-08-08. They are the
 * evidence the seed interpretations were derived from, so a vendor rewording its message breaks
 * these tests loudly rather than silently reverting the relay to learning nothing.
 */
const REAL_REFUSALS = {
  hfCredits: `{"error":"You have depleted your monthly included credits. Purchase pre-paid credits to continue using Inference Providers. Alternatively, subscribe to PRO to get 20x more included credits."}`,
  ollamaSub: `{"error":{"message":"this model requires a subscription, upgrade for access: https://ollama.com/upgrade (ref: e7592a59-d5d4-4e52-b072-905bdb4f9fbc)","type":"api_error","param":null}}`,
  ollamaPlan: `{"error":{"message":"this model requires both a Pro, Max, or Team plan and extra usage (it does not use included plan usage), upgrade for access: https://ollama.com/upgrade"}}`,
  hfGone: `{"error":{"message":"The requested model 'deepseek-ai/DeepSeek-V4' does not exist.","type":"invalid_request_error","param":"model","code":"model_not_found"}}`,
  nimGone: `{"status":404,"title":"Not Found","detail":"Function '23d4f03a-b8a6-4adb-a183-7daa083a09cc': Not found for account 'J7dEF4LVcClG8WxRebDACMbsYdF6-myJyquausWzrAs'"}`,
};

describe("seed interpretations cover the refusals measured on this machine", () => {
  it("reads a stated credit balance as a TEMPORAL fact scoped to the account", () => {
    const v = interpretRefusal("huggingface", "deepseek-ai/DeepSeek-V4-Pro", 402, REAL_REFUSALS.hfCredits, { path: interpPath });
    expect(v).toEqual({ class: "allowance-exhausted", scope: "account", source: "seed" });
  });

  it("reads stated plan gating as a COST fact scoped to the one deployment", () => {
    for (const body of [REAL_REFUSALS.ollamaSub, REAL_REFUSALS.ollamaPlan]) {
      const v = interpretRefusal("ollama-cloud", "glm-5.2", 403, body, { path: interpPath });
      // Deployment, NOT account: the credential works fine for that provider's other models, so
      // blocking the provider would take out members that serve.
      expect(v).toEqual({ class: "subscription-required", scope: "deployment", source: "seed" });
    }
  });

  it("reads stated non-existence as an EXISTENCE fact, even when the message names an account", () => {
    expect(interpretRefusal("huggingface", "deepseek-ai/DeepSeek-V4", 400, REAL_REFUSALS.hfGone, { path: interpPath }))
      .toEqual({ class: "not-servable", scope: "deployment", source: "seed" });
    // NIM's "Not found for account '<id>'" names an account but is about the serving function.
    expect(interpretRefusal("nim", "moonshotai/kimi-k2.6", 404, REAL_REFUSALS.nimGone, { path: interpPath }))
      .toEqual({ class: "not-servable", scope: "deployment", source: "seed" });
  });

  it("learns NOTHING from a refusal that states no fact", () => {
    // A bare 403 is the credential axis's business, not this store's — it could be a revoked key,
    // a region block, or a policy refusal, and guessing would evict a working deployment.
    expect(interpretRefusal("nim", "z-ai/glm-5.2", 403, `{"error":"Forbidden"}`, { path: interpPath })).toBeNull();
    expect(interpretRefusal("nim", "z-ai/glm-5.2", 400, `{"error":"bad request"}`, { path: interpPath })).toBeNull();
  });
});

describe("an exhausted allowance is never a cost verdict", () => {
  it("does not block a deployment from a free pool", () => {
    recordEligibility("huggingface", "deepseek-ai/DeepSeek-V4-Pro", { class: "allowance-exhausted", scope: "account" }, { path });
    // THE regression this whole design exists to prevent. A free-tier account that has spent this
    // period's credits is the normal state of a working free lane, not a discovery about price.
    // Evicting on it would outlive the exhaustion that caused it.
    expect(isCostBlocked("huggingface", "deepseek-ai/DeepSeek-V4-Pro", { path })).toBe(false);
    // It cools instead — a demotion that expires by itself.
    expect(cooldownUntil("huggingface", "deepseek-ai/DeepSeek-V4-Pro", { path })).not.toBeNull();
  });

  it("blocks the two classes that ARE about fitness, and never cools them", () => {
    recordEligibility("ollama-cloud", "glm-5.2", { class: "subscription-required", scope: "deployment" }, { path });
    recordEligibility("nim", "moonshotai/kimi-k2.6", { class: "not-servable", scope: "deployment" }, { path });
    expect(isCostBlocked("ollama-cloud", "glm-5.2", { path })).toBe(true);
    expect(isCostBlocked("nim", "moonshotai/kimi-k2.6", { path })).toBe(true);
    // These are exclusions, not cooldowns; a caller wanting them must ask `isCostBlocked`.
    expect(cooldownUntil("ollama-cloud", "glm-5.2", { path })).toBeNull();
    expect(cooldownUntil("nim", "moonshotai/kimi-k2.6", { path })).toBeNull();
  });
});

describe("scope decides blast radius", () => {
  it("an account-scoped observation covers siblings that were never tried", () => {
    recordEligibility("huggingface", "deepseek-ai/DeepSeek-V4-Pro", { class: "allowance-exhausted", scope: "account" }, { path });
    // The point of the account scope: a 15-member pool sharing four quota domains must not spend
    // one round-trip per member to rediscover one balance.
    expect(cooldownUntil("huggingface", "zai-org/GLM-5.2", { path })).not.toBeNull();
    expect(cooldownUntil("huggingface", "moonshotai/Kimi-K3", { path })).not.toBeNull();
  });

  it("a deployment-scoped observation leaves its siblings alone", () => {
    recordEligibility("ollama-cloud", "glm-5.2", { class: "subscription-required", scope: "deployment" }, { path });
    expect(isCostBlocked("ollama-cloud", "glm-5.2", { path })).toBe(true);
    expect(isCostBlocked("ollama-cloud", "some-included-model", { path })).toBe(false);
  });
});

describe("observations expire and yield to better evidence", () => {
  it("expires on its class TTL", () => {
    const now = 1_000_000;
    recordEligibility("ollama-cloud", "glm-5.2", { class: "subscription-required", scope: "deployment" }, { path, now });
    expect(isCostBlocked("ollama-cloud", "glm-5.2", { path, now: now + 1000 })).toBe(true);
    const after = now + ELIGIBILITY_TTL_MS["subscription-required"] + 1;
    expect(isCostBlocked("ollama-cloud", "glm-5.2", { path, now: after })).toBe(false);
  });

  it("a vendor-stated reset beats the TTL", () => {
    const now = 1_000_000;
    recordEligibility("huggingface", "x", { class: "allowance-exhausted", scope: "account" }, { path, now, retryAfterMs: 5000 });
    expect(cooldownUntil("huggingface", "x", { path, now: now + 1000 })).toBe(now + 5000);
    expect(cooldownUntil("huggingface", "x", { path, now: now + 6000 })).toBeNull();
  });

  it("a success clears the account record, so a topped-up balance recovers before its TTL", () => {
    recordEligibility("huggingface", "a", { class: "allowance-exhausted", scope: "account" }, { path });
    expect(cooldownUntil("huggingface", "b", { path })).not.toBeNull();
    clearEligibility("huggingface", "a", { path });
    expect(cooldownUntil("huggingface", "b", { path })).toBeNull();
  });

  it("reports only live observations", () => {
    const now = 2_000_000;
    recordEligibility("nim", "gone", { class: "not-servable", scope: "deployment" }, { path, now });
    expect(allObservations({ path, now: now + 1 })).toHaveLength(1);
    expect(allObservations({ path, now: now + ELIGIBILITY_TTL_MS["not-servable"] + 1 })).toHaveLength(0);
  });
});

describe("signatures identify a refusal without identifying a request", () => {
  it("strips the parts that vary between two occurrences of the same refusal", () => {
    // Ollama embeds a per-request ref uuid and an upgrade url; NIM embeds a function uuid and an
    // account id. Left in, each occurrence would be its own table entry and nothing would converge.
    const a = normalizeRefusalMessage(REAL_REFUSALS.ollamaSub);
    const b = normalizeRefusalMessage(
      REAL_REFUSALS.ollamaSub.replace("e7592a59-d5d4-4e52-b072-905bdb4f9fbc", "11111111-2222-3333-4444-555555555555"),
    );
    expect(a).toBe(b);
    expect(a).not.toContain("e7592a59");
  });

  it("sees through the relay's OWN error wrapper", () => {
    // Measured against a live 15-member `pool/xhigh`: the Anthropic front hands the observer the
    // relay's envelope, not the backend's raw body. An earlier normalizer replaced every quoted
    // string with a placeholder, so all 15 members collapsed to
    // `openai backend http <n>: {<name>:<name>}` — nothing could ever match, and a pool exhaustion
    // that the seeds describe exactly produced 0 observations and 9 unknowns.
    const wrapped = `openai backend HTTP 402: ${REAL_REFUSALS.hfCredits}`;
    expect(normalizeRefusalMessage(wrapped)).toContain("deplet");
    expect(interpretRefusal("huggingface", "zai-org/GLM-5.2", 402, wrapped, { path: interpPath }))
      .toEqual({ class: "allowance-exhausted", scope: "account", source: "seed" });

    const wrappedSub = `openai backend HTTP 403: ${REAL_REFUSALS.ollamaSub}`;
    expect(interpretRefusal("ollama-cloud", "glm-5.2", 403, wrappedSub, { path: interpPath })?.class)
      .toBe("subscription-required");
  });

  it("keys per (provider, model, message), so a verdict cannot leak to a sibling SKU", () => {
    const one = refusalSignature("ollama-cloud", "glm-5.2", 403, REAL_REFUSALS.ollamaSub);
    const two = refusalSignature("ollama-cloud", "kimi-k3", 403, REAL_REFUSALS.ollamaSub);
    expect(one).not.toBe(two);
  });
});

describe("the review gate keeps researched verdicts out of the request path", () => {
  const body = `{"error":{"message":"your organization is not permitted to use this model in this region"}}`;

  it("an unrecognized refusal is queued having changed nothing", () => {
    expect(interpretRefusal("groq", "some-model", 403, body, { path: interpPath })).toBeNull();
    recordUnknownRefusal("groq", "some-model", 403, body, { path: interpPath });
    const pending = pendingRefusals({ path: interpPath });
    expect(pending).toHaveLength(1);
    expect(pending[0]!.count).toBe(1);
    // Still nothing binding — queuing is not learning.
    expect(interpretRefusal("groq", "some-model", 403, body, { path: interpPath })).toBeNull();
  });

  it("a PROPOSED verdict does not bind; accepting it does", () => {
    recordUnknownRefusal("groq", "some-model", 403, body, { path: interpPath });
    const sig = pendingRefusals({ path: interpPath })[0]!.signature;

    proposeInterpretation(sig, { class: "not-servable", scope: "deployment", rationale: "region-gated" }, { path: interpPath });
    // The gate: a researched opinion is inert until a human commits it. This is what keeps an
    // LLM's judgement out of live routing.
    expect(interpretRefusal("groq", "some-model", 403, body, { path: interpPath })).toBeNull();

    acceptInterpretation(sig, { path: interpPath });
    const v = interpretRefusal("groq", "some-model", 403, body, { path: interpPath });
    expect(v?.class).toBe("not-servable");
    expect(v?.source).toBe("researched");
    expect(pendingRefusals({ path: interpPath })).toHaveLength(0);
  });

  it("rejecting means the message stays meaningless, not that it binds as harmless", () => {
    recordUnknownRefusal("groq", "some-model", 403, body, { path: interpPath });
    const sig = pendingRefusals({ path: interpPath })[0]!.signature;
    rejectInterpretation(sig, { path: interpPath });
    expect(pendingRefusals({ path: interpPath })).toHaveLength(0);
    expect(interpretRefusal("groq", "some-model", 403, body, { path: interpPath })).toBeNull();
  });

  it("counts repeats of one signature rather than growing an entry per request", () => {
    for (let i = 0; i < 5; i++) recordUnknownRefusal("groq", "m", 403, body, { path: interpPath });
    const pending = pendingRefusals({ path: interpPath });
    expect(pending).toHaveLength(1);
    expect(pending[0]!.count).toBe(5);
  });

  it("does not queue a refusal it already understands", () => {
    recordUnknownRefusal("huggingface", "x", 402, REAL_REFUSALS.hfCredits, { path: interpPath });
    // It matches a seed, so it is not unknown — but `recordUnknownRefusal` is only reached on a
    // miss in practice. Guard the store against a caller that gets that wrong.
    expect(interpretRefusal("huggingface", "x", 402, REAL_REFUSALS.hfCredits, { path: interpPath })).not.toBeNull();
  });
});

describe("nothing is observed until something is recorded", () => {
  it("reports null for an untouched deployment", () => {
    expect(observedEligibility("nim", "z-ai/glm-5.2", { path })).toBeNull();
    expect(isCostBlocked("nim", "z-ai/glm-5.2", { path })).toBe(false);
    expect(cooldownUntil("nim", "z-ai/glm-5.2", { path })).toBeNull();
  });
});
