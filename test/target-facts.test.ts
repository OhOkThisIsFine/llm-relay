import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  allFacts,
  clearFacts,
  cooldownUntil,
  factsFor,
  isCostBlocked,
  recordFact,
  resetFacts,
  FACT_TTL_MS,
} from "../src/target-facts.js";
import {
  acceptInterpretation,
  applyResetRule,
  interpretRefusal,
  materializeScope,
  normalizeRefusalMessage,
  parseStatedResetMs,
  pendingRefusals,
  proposeInterpretation,
  recordUnknownRefusal,
  refusalSignature,
  rejectInterpretation,
  resetInterpretations,
  IGNORED_TTL_MS,
} from "../src/refusal-interpretation.js";

let dir: string;
let path: string;
let interpPath: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "llm-relay-facts-"));
  path = join(dir, "facts.json");
  interpPath = join(dir, "interpretations.json");
  resetFacts();
  resetInterpretations();
});

afterEach(() => {
  resetFacts();
  resetInterpretations();
  rmSync(dir, { recursive: true, force: true });
});

/**
 * VERBATIM from probes against real accounts on 2026-08-08. These are the evidence the seeds were
 * derived from, so a vendor rewording its message breaks these tests loudly rather than silently
 * reverting the relay to learning nothing.
 */
const REAL_REFUSALS = {
  hfCredits: `{"error":"You have depleted your monthly included credits. Purchase pre-paid credits to continue using Inference Providers. Alternatively, subscribe to PRO to get 20x more included credits."}`,
  ollamaSub: `{"error":{"message":"this model requires a subscription, upgrade for access: https://ollama.com/upgrade (ref: e7592a59-d5d4-4e52-b072-905bdb4f9fbc)","type":"api_error","param":null}}`,
  ollamaPlan: `{"error":{"message":"this model requires both a Pro, Max, or Team plan and extra usage (it does not use included plan usage), upgrade for access: https://ollama.com/upgrade"}}`,
  hfGone: `{"error":{"message":"The requested model 'deepseek-ai/DeepSeek-V4' does not exist.","type":"invalid_request_error","param":"model","code":"model_not_found"}}`,
  nimGone: `{"status":404,"title":"Not Found","detail":"Function '23d4f03a-b8a6-4adb-a183-7daa083a09cc': Not found for account 'J7dEF4LVcClG8WxRebDACMbsYdF6-myJyquausWzrAs'"}`,
  badKey: `{"error":{"message":"Incorrect API key provided. You can find your API key at https://example.test/keys","type":"invalid_request_error"}}`,
};

/** Gemini's quota refusal, as it arrived through the relay's own error wrapper. */
const geminiQuotaSample = `openai backend HTTP 429: [{ "error": { "code": 429, "message": "You exceeded your current quota, please check your plan and billing details." } }]`;

describe("seeds classify the refusals measured on this machine, at the right scope", () => {
  it("reads a stated credit balance as TEMPORAL and scoped to the whole account", () => {
    const v = interpretRefusal("huggingface", "deepseek-ai/DeepSeek-V4-Pro", 402, REAL_REFUSALS.hfCredits, { path: interpPath });
    expect(v?.class).toBe("allowance-exhausted");
    expect(v?.scope).toEqual({ kind: "provider" });
  });

  it("reads stated plan gating as a COST fact scoped to the one deployment", () => {
    for (const body of [REAL_REFUSALS.ollamaSub, REAL_REFUSALS.ollamaPlan]) {
      const v = interpretRefusal("ollama-cloud", "glm-5.2", 403, body, { path: interpPath });
      // Deployment, NOT provider: the credential works fine for that provider's other models, so
      // blocking the provider would take out members that serve.
      expect(v?.class).toBe("subscription-required");
      expect(v?.scope).toEqual({ kind: "deployment" });
    }
  });

  it("reads stated non-existence as an EXISTENCE fact, even when the message names an account", () => {
    expect(interpretRefusal("huggingface", "deepseek-ai/DeepSeek-V4", 400, REAL_REFUSALS.hfGone, { path: interpPath })?.class)
      .toBe("not-servable");
    // NIM's "Not found for account '<id>'" names an account but is about the serving function.
    const v = interpretRefusal("nim", "moonshotai/kimi-k2.6", 404, REAL_REFUSALS.nimGone, { path: interpPath });
    expect(v?.class).toBe("not-servable");
    expect(v?.scope).toEqual({ kind: "deployment" });
  });

  it("reads a STATED bad credential as a provider-wide fact", () => {
    // The measured gap this closes: a revoked key is a fact about the credential, but
    // `credentialFaultUntil` is keyed per deployment — so every model on that provider had to
    // independently discover the same 401, each on its own expiry clock.
    const v = interpretRefusal("groq", "some-model", 401, REAL_REFUSALS.badKey, { path: interpPath });
    expect(v?.class).toBe("credential-invalid");
    expect(v?.scope).toEqual({ kind: "provider" });
  });

  it("learns NOTHING from a bare 401/403, which is the whole point", () => {
    // A bare 401 is equally an entitlement wall on one model under a perfectly good key — the
    // false accusation `key-checker.ts` exists to avoid. Only stated wording produces a fact.
    expect(interpretRefusal("nim", "z-ai/glm-5.2", 401, `{"error":"Unauthorized"}`, { path: interpPath })).toBeNull();
    expect(interpretRefusal("nim", "z-ai/glm-5.2", 403, `{"error":"Forbidden"}`, { path: interpPath })).toBeNull();
    expect(interpretRefusal("nim", "z-ai/glm-5.2", 400, `{"error":"bad request"}`, { path: interpPath })).toBeNull();
  });

  it("sees through the relay's OWN error wrapper", () => {
    // Measured against a live 15-member `pool/xhigh`: the Anthropic front hands the observer the
    // relay's envelope, not the backend's raw body, and an over-eager normalizer erased the
    // payload — 0 observations, 9 unknowns, from a pool the seeds describe exactly.
    const wrapped = `openai backend HTTP 402: ${REAL_REFUSALS.hfCredits}`;
    expect(normalizeRefusalMessage(wrapped)).toContain("deplet");
    expect(interpretRefusal("huggingface", "zai-org/GLM-5.2", 402, wrapped, { path: interpPath })?.class)
      .toBe("allowance-exhausted");
  });
});

describe("a quota is not a rate limit", () => {
  // VERBATIM from the live relay, 2026-08-08 — Gemini answering a pool/xhigh member.
  const geminiQuota = `[{ "error": { "code": 429, "message": "You exceeded your current quota, please check your plan and billing details. For more information on this error, head to: https://ai.google.dev/gemini-api/docs/rate-limits" } }]`;

  it("reads stated quota exhaustion as a long-window ALLOWANCE, not throttling", () => {
    // The distinction is load-bearing: `rate-limited` carries a 2-minute TTL because throughput
    // limits reset in seconds, while a quota is a 5-hourly, weekly or monthly grant. Classifying
    // one as the other re-probes a spent weekly quota every two minutes for days.
    const v = interpretRefusal("gemini", "models/gemini-3.6-flash", 429, geminiQuota, { path: interpPath });
    expect(v?.class).toBe("allowance-exhausted");
    expect(v?.scope).toEqual({ kind: "provider" });
  });

  it("reads the reset Gemini states in the body, which no header carries", () => {
    // Google puts it in `google.rpc.RetryInfo`, not in Retry-After — so without this the relay
    // falls back to the kind's 1h TTL and re-probes a spent 5-hourly or weekly quota on a schedule
    // it invented.
    const withRetryInfo = `{"error":{"code":429,"status":"RESOURCE_EXHAUSTED","details":[{"@type":"type.googleapis.com/google.rpc.RetryInfo","retryDelay":"3600s"}]}}`;
    expect(parseStatedResetMs(withRetryInfo)).toBe(3_600_000);
    expect(parseStatedResetMs(`{"error":{"message":"try again in 45 seconds"}}`)).toBe(45_000);
    expect(parseStatedResetMs(`{"error":{"message":"retry again in 5 minutes"}}`)).toBe(300_000);
  });

  it("learns no reset from a body that states none", () => {
    // Same rule as the context-limit parser: an inferred number in a store whose value is that it
    // holds measurements is worse than no number. Falling back to the TTL only re-checks early.
    expect(parseStatedResetMs(geminiQuotaSample)).toBeNull();
    expect(parseStatedResetMs(`{"status":429,"title":"Too Many Requests"}`)).toBeNull();
    // A parse artifact beyond any real window is refused rather than stranding a deployment.
    expect(parseStatedResetMs(`{"retryDelay":"999999999s"}`)).toBeNull();
  });

  it("a reviewer can teach WHERE the reset lives, not just what the message means", () => {
    // The gap this closes: `propose` could record class and scope but not duration, so learning
    // "this means allowance-exhausted" left the relay re-probing on a TTL it invented — and the
    // fix kept being a regex added to source, which is the relay's author learning, not the relay.
    const withRetryInfo = `openai backend HTTP 429: {"error":{"details":[{"@type":"type.googleapis.com/google.rpc.RetryInfo","retryDelay":"18000s"}]}}`;
    expect(applyResetRule({ kind: "field", field: "retryDelay" }, withRetryInfo)).toBe(18_000_000);
    // A field the message does not carry teaches nothing, rather than guessing.
    expect(applyResetRule({ kind: "field", field: "nope" }, withRetryInfo)).toBeNull();
  });

  it("a reviewer's asserted window is bounded and refused when implausible", () => {
    expect(applyResetRule({ kind: "fixed", ms: 5 * 60 * 60 * 1000 }, "{}")).toBe(18_000_000);
    // Beyond any real window: believing it would strand a deployment for longer than any provider
    // publishes. Same bound as the generic parser.
    expect(applyResetRule({ kind: "fixed", ms: 30 * 24 * 60 * 60 * 1000 }, "{}")).toBeNull();
  });

  it("carries the reset through propose and accept", () => {
    const body = `{"error":{"message":"a message nobody has classified","retryDelay":"600s"}}`;
    recordUnknownRefusal("p", "m", 429, body, { path: interpPath });
    const sig = pendingRefusals({ path: interpPath })[0]!.signature;
    proposeInterpretation(sig, {
      class: "allowance-exhausted",
      scope: { kind: "provider" },
      rationale: "quota; the reset is in retryDelay",
      reset: { kind: "field", field: "retryDelay" },
    }, { path: interpPath });
    acceptInterpretation(sig, { path: interpPath });

    // Accepting commits EVERYTHING known about the shape — meaning, scope and duration.
    const v = interpretRefusal("p", "m", 429, body, { path: interpPath });
    expect(v?.class).toBe("allowance-exhausted");
    expect(v?.reset).toEqual({ kind: "field", field: "retryDelay" });
    expect(applyResetRule(v!.reset, body)).toBe(600_000);
  });

  it("a stated reset overrides the kind's default TTL", () => {
    const now = 9_000_000;
    recordFact("allowance-exhausted", { kind: "provider", provider: "gemini" }, { path, now, retryAfterMs: 3_600_000 });
    expect(cooldownUntil("gemini", "m", { path, now: now + 1000 })).toBe(now + 3_600_000);
  });

  it("still treats a spent quota as FREE — it is spent, not priced", () => {
    recordFact("allowance-exhausted", { kind: "provider", provider: "gemini" }, { path });
    expect(isCostBlocked("gemini", "models/gemini-3.6-flash", { path })).toBe(false);
    expect(cooldownUntil("gemini", "models/gemini-3.6-flash", { path })).not.toBeNull();
  });

  it("does not let quota wording fall through to the rate-limit seed", () => {
    // ⚠ 0.28.0's rate-limit pattern matched the word "quota", so a message naming a project's
    // quota was cooled for two minutes. The quota seed is FIRST and the rate-limit pattern no
    // longer mentions quota; both halves of that fix are pinned here.
    const projectQuota = `{"error":{"message":"Quota exceeded for your project, check your billing plan"}}`;
    expect(interpretRefusal("gemini", "m", 429, projectQuota, { path: interpPath })?.class).toBe("allowance-exhausted");
  });
});

describe("a stated ACCOUNT-level rate limit, and only that", () => {
  it("covers every deployment behind the credential", () => {
    const body = `{"error":{"message":"Rate limit reached for your organization. Please try again later."}}`;
    const v = interpretRefusal("groq", "m", 429, body, { path: interpPath });
    expect(v?.class).toBe("rate-limited");
    expect(v?.scope).toEqual({ kind: "provider" });
  });

  it("a new seed retroactively clears anything it already queued", () => {
    // Shipping a seed must empty the queue of what it now explains, or every release that teaches
    // the relay something leaves items asking a human to explain what the relay already knows.
    const noise = `{"error":{"message":"something nobody has classified yet"}}`;
    recordUnknownRefusal("p", "m", 403, noise, { path: interpPath });
    recordUnknownRefusal("gemini", "m", 429, geminiQuotaSample, { path: interpPath });
    // Only the genuinely unexplained one survives — the Gemini quota message now matches a seed.
    const pending = pendingRefusals({ path: interpPath });
    expect(pending).toHaveLength(1);
    expect(pending[0]!.provider).toBe("p");
  });

  it("leaves an ordinary 429 to the breaker, where it belongs", () => {
    // ⚠ The narrowness IS the feature. Matching plain throttling would demote whole providers on
    // routine back-pressure — worse than the problem, and a per-target cooldown already handles it.
    for (const body of [
      `{"error":{"message":"Rate limit exceeded"}}`,
      `{"error":{"message":"TPM limit reached for this model, please slow down"}}`,
      `{"status":429,"title":"Too Many Requests"}`,
    ]) {
      expect(interpretRefusal("nim", "m", 429, body, { path: interpPath })).toBeNull();
    }
  });

  it("cools rather than blocks — a throttled account is not a paid one", () => {
    recordFact("rate-limited", { kind: "provider", provider: "groq" }, { path });
    expect(cooldownUntil("groq", "any", { path })).not.toBeNull();
    expect(isCostBlocked("groq", "any", { path })).toBe(false);
  });
});

describe("clearing reports what it disproved", () => {
  it("names provider-scoped facts so their symptoms can be cleared too", () => {
    recordFact("credential-invalid", { kind: "provider", provider: "p" }, { path });
    recordFact("not-servable", { kind: "deployment", provider: "p", model: "gone" }, { path });
    // Only the provider-scoped kinds come back: they are the ones whose per-deployment 401s on the
    // breaker are now stale evidence about a problem that no longer exists.
    expect(clearFacts("p", "gone", { path })).toEqual(["credential-invalid"]);
  });

  it("reports nothing when only deployment-scoped facts were cleared", () => {
    recordFact("subscription-required", { kind: "deployment", provider: "p", model: "m" }, { path });
    expect(clearFacts("p", "m", { path })).toEqual([]);
  });
});

describe("scope decides blast radius", () => {
  it("a provider-scoped fact covers siblings that were never tried", () => {
    recordFact("allowance-exhausted", { kind: "provider", provider: "huggingface" }, { path });
    // The point: a 15-member pool sharing four quota domains must not spend one round-trip per
    // member to rediscover one balance.
    expect(cooldownUntil("huggingface", "zai-org/GLM-5.2", { path })).not.toBeNull();
    expect(cooldownUntil("huggingface", "moonshotai/Kimi-K3", { path })).not.toBeNull();
    // ...and says nothing about anyone else.
    expect(cooldownUntil("nim", "z-ai/glm-5.2", { path })).toBeNull();
  });

  it("a deployment-scoped fact leaves its siblings alone", () => {
    recordFact("subscription-required", { kind: "deployment", provider: "ollama-cloud", model: "glm-5.2" }, { path });
    expect(isCostBlocked("ollama-cloud", "glm-5.2", { path })).toBe(true);
    expect(isCostBlocked("ollama-cloud", "some-included-model", { path })).toBe(false);
  });

  it("a group covers exactly its listed members and nobody else", () => {
    // ⚠ Membership travels WITH the fact. There is no registry and no prefix inference, so a
    // group can never quietly widen to a model the reviewer did not see.
    recordFact("subscription-required", { kind: "group", provider: "p", members: ["a-pro", "b-pro"] }, { path });
    expect(isCostBlocked("p", "a-pro", { path })).toBe(true);
    expect(isCostBlocked("p", "b-pro", { path })).toBe(true);
    expect(isCostBlocked("p", "a-lite", { path })).toBe(false);
    // A same-named model on a different provider is a different deployment.
    expect(isCostBlocked("other", "a-pro", { path })).toBe(false);
  });

  it("resolves most specific first", () => {
    recordFact("allowance-exhausted", { kind: "provider", provider: "p" }, { path });
    recordFact("not-servable", { kind: "deployment", provider: "p", model: "gone" }, { path });
    const hits = factsFor("p", "gone", { path });
    expect(hits[0]!.scope.kind).toBe("deployment");
    expect(hits.map((h) => h.kind)).toEqual(["not-servable", "allowance-exhausted"]);
  });

  it("materializes a group template so it always contains the model that proved it", () => {
    const scope = materializeScope({ kind: "group", members: ["a"] }, "p", "b");
    expect(scope).toEqual({ kind: "group", provider: "p", members: ["a", "b"] });
  });
});

describe("an exhausted allowance is never a cost verdict", () => {
  it("does not block a deployment from a free pool", () => {
    recordFact("allowance-exhausted", { kind: "provider", provider: "huggingface" }, { path });
    // THE regression this design exists to prevent. A free-tier account that has spent this
    // period's credits is the normal state of a working free lane, not a discovery about price;
    // evicting on it would outlive the exhaustion that caused it.
    expect(isCostBlocked("huggingface", "deepseek-ai/DeepSeek-V4-Pro", { path })).toBe(false);
    expect(cooldownUntil("huggingface", "deepseek-ai/DeepSeek-V4-Pro", { path })).not.toBeNull();
  });

  it("a bad credential cools but never evicts either", () => {
    // A rotation fixes it in seconds; removing pool members over a config problem would empty the
    // pool on a mistake.
    recordFact("credential-invalid", { kind: "provider", provider: "groq" }, { path });
    expect(isCostBlocked("groq", "any-model", { path })).toBe(false);
    expect(cooldownUntil("groq", "any-model", { path })).not.toBeNull();
  });

  it("blocks the two kinds that ARE about fitness, and never cools them", () => {
    recordFact("subscription-required", { kind: "deployment", provider: "ollama-cloud", model: "glm-5.2" }, { path });
    recordFact("not-servable", { kind: "deployment", provider: "nim", model: "moonshotai/kimi-k2.6" }, { path });
    expect(isCostBlocked("ollama-cloud", "glm-5.2", { path })).toBe(true);
    expect(isCostBlocked("nim", "moonshotai/kimi-k2.6", { path })).toBe(true);
    expect(cooldownUntil("ollama-cloud", "glm-5.2", { path })).toBeNull();
    expect(cooldownUntil("nim", "moonshotai/kimi-k2.6", { path })).toBeNull();
  });
});

describe("facts expire and yield to better evidence", () => {
  it("expires on its kind's TTL", () => {
    const now = 1_000_000;
    recordFact("subscription-required", { kind: "deployment", provider: "o", model: "m" }, { path, now });
    expect(isCostBlocked("o", "m", { path, now: now + 1000 })).toBe(true);
    expect(isCostBlocked("o", "m", { path, now: now + FACT_TTL_MS["subscription-required"] + 1 })).toBe(false);
  });

  it("a vendor-stated reset beats the TTL", () => {
    const now = 1_000_000;
    recordFact("allowance-exhausted", { kind: "provider", provider: "h" }, { path, now, retryAfterMs: 5000 });
    expect(cooldownUntil("h", "x", { path, now: now + 1000 })).toBe(now + 5000);
    expect(cooldownUntil("h", "x", { path, now: now + 6000 })).toBeNull();
  });

  it("a success clears the provider record, so a rotated key or top-up recovers early", () => {
    recordFact("allowance-exhausted", { kind: "provider", provider: "h" }, { path });
    expect(cooldownUntil("h", "b", { path })).not.toBeNull();
    clearFacts("h", "a", { path });
    expect(cooldownUntil("h", "b", { path })).toBeNull();
  });

  it("a success does NOT clear a group verdict the serving model is not part of", () => {
    // One member serving says nothing about the others; dropping the verdict would re-admit models
    // that are genuinely gated.
    recordFact("subscription-required", { kind: "group", provider: "p", members: ["pro-1", "pro-2"] }, { path });
    clearFacts("p", "lite-1", { path });
    expect(isCostBlocked("p", "pro-1", { path })).toBe(true);
  });

  it("reports only live facts", () => {
    const now = 2_000_000;
    recordFact("not-servable", { kind: "deployment", provider: "nim", model: "gone" }, { path, now });
    expect(allFacts({ path, now: now + 1 })).toHaveLength(1);
    expect(allFacts({ path, now: now + FACT_TTL_MS["not-servable"] + 1 })).toHaveLength(0);
  });
});

describe("signatures identify a refusal without identifying a request", () => {
  it("strips the parts that vary between two occurrences of the same refusal", () => {
    const a = normalizeRefusalMessage(REAL_REFUSALS.ollamaSub);
    const b = normalizeRefusalMessage(
      REAL_REFUSALS.ollamaSub.replace("e7592a59-d5d4-4e52-b072-905bdb4f9fbc", "11111111-2222-3333-4444-555555555555"),
    );
    expect(a).toBe(b);
    expect(a).not.toContain("e7592a59");
  });

  it("keys per (provider, model, message), so a verdict cannot leak to a sibling SKU", () => {
    expect(refusalSignature("ollama-cloud", "glm-5.2", 403, REAL_REFUSALS.ollamaSub))
      .not.toBe(refusalSignature("ollama-cloud", "kimi-k3", 403, REAL_REFUSALS.ollamaSub));
  });
});

describe("the review gate keeps researched verdicts out of the request path", () => {
  const body = `{"error":{"message":"your organization is not permitted to use this model in this region"}}`;

  it("an unrecognized refusal is queued having changed nothing", () => {
    expect(interpretRefusal("groq", "some-model", 403, body, { path: interpPath })).toBeNull();
    recordUnknownRefusal("groq", "some-model", 403, body, { path: interpPath });
    expect(pendingRefusals({ path: interpPath })).toHaveLength(1);
    // Queuing is not learning.
    expect(interpretRefusal("groq", "some-model", 403, body, { path: interpPath })).toBeNull();
  });

  it("a PROPOSED verdict does not bind; accepting it does", () => {
    recordUnknownRefusal("groq", "some-model", 403, body, { path: interpPath });
    const sig = pendingRefusals({ path: interpPath })[0]!.signature;

    proposeInterpretation(sig, { class: "not-servable", scope: { kind: "deployment" }, rationale: "region-gated" }, { path: interpPath });
    // The gate: a researched opinion is inert until committed. This is what keeps an LLM's
    // judgement out of live routing.
    expect(interpretRefusal("groq", "some-model", 403, body, { path: interpPath })).toBeNull();

    acceptInterpretation(sig, { path: interpPath });
    const v = interpretRefusal("groq", "some-model", 403, body, { path: interpPath });
    expect(v?.class).toBe("not-servable");
    expect(v?.source).toBe("researched");
    expect(pendingRefusals({ path: interpPath })).toHaveLength(0);
  });

  it("can accept a GROUP verdict, and it carries the reviewed membership", () => {
    recordUnknownRefusal("p", "pro-1", 403, body, { path: interpPath });
    const sig = pendingRefusals({ path: interpPath })[0]!.signature;
    acceptInterpretation(sig, { path: interpPath, override: { class: "subscription-required", scope: { kind: "group", members: ["pro-1", "pro-2"] } } });
    const v = interpretRefusal("p", "pro-1", 403, body, { path: interpPath });
    expect(v?.scope).toEqual({ kind: "group", members: ["pro-1", "pro-2"] });
  });

  it("rejecting means the message stays meaningless, not that it binds as harmless", () => {
    recordUnknownRefusal("groq", "some-model", 403, body, { path: interpPath });
    const sig = pendingRefusals({ path: interpPath })[0]!.signature;
    rejectInterpretation(sig, { path: interpPath });
    expect(pendingRefusals({ path: interpPath })).toHaveLength(0);
    expect(interpretRefusal("groq", "some-model", 403, body, { path: interpPath })).toBeNull();
  });

  it("REMEMBERS a rejection, so routine noise cannot refill the queue", () => {
    // Measured on the live relay: adding 429s to the observed set immediately queued NIM's
    // "too many requests" — a message already understood to be uninteresting. Without a durable
    // rejection every recurrence re-queues it, and the signatures worth reading get buried under
    // the ones a human has explicitly finished with.
    const noise = `{"status":429,"title":"Too Many Requests"}`;
    recordUnknownRefusal("nim", "m", 429, noise, { path: interpPath });
    rejectInterpretation(pendingRefusals({ path: interpPath })[0]!.signature, { path: interpPath });

    recordUnknownRefusal("nim", "m", 429, noise, { path: interpPath });
    recordUnknownRefusal("nim", "m", 429, noise, { path: interpPath });
    expect(pendingRefusals({ path: interpPath })).toHaveLength(0);
  });

  it("a rejection expires, so a mistaken one heals without editing a file", () => {
    const noise = `{"status":429,"title":"Too Many Requests"}`;
    const now = 5_000_000;
    recordUnknownRefusal("nim", "m", 429, noise, { path: interpPath, now });
    rejectInterpretation(pendingRefusals({ path: interpPath })[0]!.signature, { path: interpPath, now });
    recordUnknownRefusal("nim", "m", 429, noise, { path: interpPath, now: now + IGNORED_TTL_MS + 1 });
    expect(pendingRefusals({ path: interpPath })).toHaveLength(1);
  });

  it("counts repeats of one signature rather than growing an entry per request", () => {
    for (let i = 0; i < 5; i++) recordUnknownRefusal("groq", "m", 403, body, { path: interpPath });
    expect(pendingRefusals({ path: interpPath })[0]!.count).toBe(5);
  });
});

describe("nothing is known until something is recorded", () => {
  it("reports nothing for an untouched deployment", () => {
    expect(factsFor("nim", "z-ai/glm-5.2", { path })).toEqual([]);
    expect(isCostBlocked("nim", "z-ai/glm-5.2", { path })).toBe(false);
    expect(cooldownUntil("nim", "z-ai/glm-5.2", { path })).toBeNull();
  });
});
