import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { makeCredentialId } from "../src/credential-id.js";
import {
  allFacts,
  clearFacts as clearFactsV2,
  cooldownUntil as cooldownUntilV2,
  factsFor as factsForV2,
  flushFacts,
  isCostBlocked as isCostBlockedV2,
  isCostBlockedForEverySlot,
  keyOf,
  recordFact,
  resetFacts,
  FACT_TTL_MS,
} from "../src/target-facts.js";
import {
  acceptInterpretation,
  applyResetRule,
  flushInterpretations,
  interpretRefusal,
  materializeScope as materializeScopeV2,
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

// Legacy single-slot scenarios remain useful coverage. Their former provider/model calls now
// explicitly resolve the implicit default credential; v2-specific cases below call the direct API.
const defaultCredential = (provider: string) => makeCredentialId(provider);
const factsFor = (provider: string, model: string | null | undefined, opts?: { path?: string; now?: number }) =>
  factsForV2(provider, defaultCredential(provider), model, opts);
const isCostBlocked = (provider: string, model: string | null | undefined, opts?: { path?: string; now?: number }) =>
  isCostBlockedV2(provider, defaultCredential(provider), model, opts);
const cooldownUntil = (provider: string, model: string | null | undefined, opts?: { path?: string; now?: number }) =>
  cooldownUntilV2(provider, defaultCredential(provider), model, opts);
const clearFacts = (provider: string, model: string | null | undefined, opts?: { path?: string }) =>
  clearFactsV2(provider, defaultCredential(provider), model, opts);
const materializeScope = (
  template: Parameters<typeof materializeScopeV2>[0],
  provider: string,
  model: string,
) => materializeScopeV2(template, provider, defaultCredential(provider), model);

describe("credential-scoped v2 persistence", () => {
  const personal = makeCredentialId("p", "personal");
  const work = makeCredentialId("p", "work");

  it("treats v1 persistence as zero facts rather than migrating a guessed default", () => {
    writeFileSync(path, JSON.stringify({
      version: 1,
      facts: {
        "p:p": { kind: "credential-invalid", scope: { kind: "provider", provider: "p" }, at: 1 },
        "d:p/m": { kind: "not-servable", scope: { kind: "deployment", provider: "p", model: "m" }, at: 1 },
        "g:p:m": { kind: "subscription-required", scope: { kind: "group", provider: "p", members: ["m"] }, at: 1 },
        "m:m": { kind: "not-servable", scope: { kind: "model", model: "m" }, at: 1 },
      },
    }));
    resetFacts();
    expect(factsForV2("p", personal, "m", { path, now: 2 })).toEqual([]);
    expect(cooldownUntilV2("p", personal, "m", { path, now: 2 })).toBeNull();
  });

  it("drops malformed v2 rows independently, including forged credential/provider agreement", () => {
    const valid = { kind: "credential-invalid" as const, scope: { kind: "credential" as const, provider: "p", credentialId: personal }, at: 1 };
    writeFileSync(path, JSON.stringify({
      version: 2,
      facts: {
        [keyOf(valid.kind, valid.scope)]: valid,
        "c:wrong-key": { ...valid, scope: { ...valid.scope, credentialId: work } },
        "d:p/m": { kind: "bogus", scope: { kind: "deployment", provider: "p", model: "m" }, at: 1 },
        "c:other#default": { ...valid, scope: { ...valid.scope, credentialId: makeCredentialId("other") } },
        [`a:${personal}/attempt`]: { kind: "not-servable", scope: { kind: "attempt", provider: "p", credentialId: personal, model: "attempt", extra: true }, at: 1 },
        [`g:c:${personal}/group`]: { kind: "not-servable", scope: { kind: "group", provider: "p", credentialId: personal, members: ["group"], extra: true }, at: 1 },
        "d:p/deployment": { kind: "not-servable", scope: { kind: "deployment", provider: "p", model: "deployment", credentialId: personal }, at: 1 },
        [`c:${work}`]: { kind: "credential-invalid", scope: { kind: "credential", provider: "p", credentialId: work, model: "wrong" }, at: 1 },
        "p:p": { kind: "not-servable", scope: { kind: "provider", provider: "p", credentialId: personal }, at: 1 },
        "m:m": { kind: "not-servable", scope: { kind: "model", model: "m", provider: "p", credentialId: personal }, at: 1 },
      },
    }));
    resetFacts();
    expect(factsForV2("p", personal, "m", { path, now: 2 })).toHaveLength(1);
    expect(allFacts({ path, now: 2 })).toHaveLength(1);
  });

  it("orders all six scope kinds attempt through model", () => {
    recordFact("not-servable", { kind: "model", model: "m" }, { path });
    recordFact("subscription-required", { kind: "provider", provider: "p" }, { path });
    recordFact("allowance-exhausted", { kind: "credential", provider: "p", credentialId: personal }, { path });
    recordFact("credential-invalid", { kind: "deployment", provider: "p", model: "m" }, { path });
    recordFact("rate-limited", { kind: "group", provider: "p", credentialId: personal, members: ["m"] }, { path });
    recordFact("context-limit", { kind: "attempt", provider: "p", credentialId: personal, model: "m" }, { path, value: 8_192 });
    expect(factsForV2("p", personal, "m", { path }).map((fact) => fact.scope.kind))
      .toEqual(["attempt", "group", "deployment", "credential", "provider", "model"]);
  });

  it("keeps personal and work credentials isolated and null fail-closed", () => {
    recordFact("credential-invalid", { kind: "credential", provider: "p", credentialId: personal }, { path });
    recordFact("rate-limited", { kind: "group", provider: "p", credentialId: personal, members: ["m"] }, { path });
    recordFact("not-servable", { kind: "attempt", provider: "p", credentialId: personal, model: "m" }, { path });
    expect(factsForV2("p", work, "m", { path })).toEqual([]);
    expect(factsForV2("p", null, "m", { path })).toEqual([]);
  });

  it("makes group widening explicit: credential-bound and all-credential groups differ", () => {
    recordFact("subscription-required", { kind: "group", provider: "p", credentialId: personal, members: ["bound"] }, { path });
    recordFact("subscription-required", { kind: "group", provider: "p", members: ["all"] }, { path });
    expect(isCostBlockedV2("p", personal, "bound", { path })).toBe(true);
    expect(isCostBlockedV2("p", work, "bound", { path })).toBe(false);
    expect(isCostBlockedV2("p", null, "all", { path })).toBe(true);
  });

  it("evaluates cost-blocking across all enabled credential slots (isCostBlockedForEverySlot)", () => {
    const singleSlotCfg = {
      providers: {
        p: { base: "https://p.test", kind: "openai" as const, authHeader: "authorization" as const, timeoutMs: 1000 },
      },
    };
    recordFact("subscription-required", { kind: "credential", provider: "p", credentialId: defaultCredential("p") }, { path });
    // Single implicit slot blocked -> every slot blocked
    expect(isCostBlockedForEverySlot("p", "m", singleSlotCfg, { path })).toBe(true);

    // Provider with 2 enabled slots: one blocked, one clear -> NOT blocked for every slot
    const twoSlotCfg = {
      providers: {
        p: {
          base: "https://p.test",
          kind: "openai" as const,
          authHeader: "authorization" as const,
          timeoutMs: 1000,
          credentials: [
            { label: "personal", authEnv: "KEY_P", enabled: true },
            { label: "work", authEnv: "KEY_W", enabled: true },
          ],
        },
      },
    };
    recordFact("subscription-required", { kind: "credential", provider: "p", credentialId: personal }, { path });
    expect(isCostBlockedForEverySlot("p", "bound", twoSlotCfg, { path })).toBe(false);

    // If both slots are blocked -> blocked for every slot
    recordFact("subscription-required", { kind: "credential", provider: "p", credentialId: work }, { path });
    expect(isCostBlockedForEverySlot("p", "bound", twoSlotCfg, { path })).toBe(true);

    // If one slot is blocked and the only other slot is disabled -> blocked for every slot
    const oneDisabledCfg = {
      providers: {
        p2: {
          base: "https://p.test",
          kind: "openai" as const,
          authHeader: "authorization" as const,
          timeoutMs: 1000,
          credentials: [
            { label: "personal", authEnv: "KEY_P", enabled: true },
            { label: "work", authEnv: "KEY_W", enabled: false },
          ],
        },
      },
    };
    recordFact("subscription-required", { kind: "credential", provider: "p2", credentialId: makeCredentialId("p2", "personal") }, { path });
    expect(isCostBlockedForEverySlot("p2", "bound", oneDisabledCfg, { path })).toBe(true);

    // Demotion facts (e.g. allowance-exhausted) do not cost block
    const allowanceCfg = {
      providers: {
        q: { base: "https://q.test", kind: "openai" as const, authHeader: "authorization" as const, timeoutMs: 1000 },
      },
    };
    recordFact("allowance-exhausted", { kind: "credential", provider: "q", credentialId: defaultCredential("q") }, { path });
    expect(isCostBlockedForEverySlot("q", "m", allowanceCfg, { path })).toBe(false);
  });

  it("clears conditions that cover the exact cell but never a context measurement", () => {
    recordFact("credential-invalid", { kind: "credential", provider: "p", credentialId: personal }, { path });
    recordFact("credential-invalid", { kind: "attempt", provider: "p", credentialId: personal, model: "m" }, { path });
    recordFact("context-limit", { kind: "attempt", provider: "p", credentialId: personal, model: "m" }, { path, value: 4_096 });
    expect(clearFactsV2("p", personal, "m", { path })).toEqual(["credential-invalid"]);
    expect(factsForV2("p", personal, "m", { path }).map((fact) => fact.kind)).toEqual(["context-limit"]);
  });

  it("carries all eleven kinds, five conditions plus six measurements", () => {
    // The compiler already forces a TTL per kind (Record<FactKind, number>); this pins that the
    // measurement half actually EXISTS — a silent drop back to six kinds would make the parser
    // below record into a kind the store refuses to keep.
    expect(FACT_TTL_MS).toHaveProperty("context-limit");
    expect(FACT_TTL_MS).toHaveProperty("max-output");
    expect(FACT_TTL_MS).toHaveProperty("rate-limit-rpm");
    expect(FACT_TTL_MS).toHaveProperty("rate-limit-rpd");
    expect(FACT_TTL_MS).toHaveProperty("rate-limit-tpm");
    expect(FACT_TTL_MS).toHaveProperty("rate-limit-tpd");
    expect(Object.keys(FACT_TTL_MS)).toHaveLength(11);
  });

  it("never clears, cools, or cost-blocks on a stated-ceiling measurement", () => {
    // The measurement half: a stated ceiling survives a success (a success disproves a condition,
    // never a measurement), reports no cooldown (health demotes, measurements don't), and blocks
    // no spend (a known limit is information, not an entitlement wall).
    for (const kind of ["max-output", "rate-limit-rpm", "rate-limit-rpd", "rate-limit-tpm", "rate-limit-tpd"] as const) {
      recordFact(kind, { kind: "attempt", provider: "p", credentialId: personal, model: "m" }, { path, value: 60 });
      recordFact(kind, { kind: "deployment", provider: "p", model: "m" }, { path, value: 60 });
    }
    expect(clearFactsV2("p", personal, "m", { path })).toEqual([]);
    expect(factsForV2("p", personal, "m", { path })).toHaveLength(10);
    expect(cooldownUntilV2("p", personal, "m", { path })).toBeNull();
    expect(isCostBlockedV2("p", personal, "m", { path })).toBe(false);
  });

  it("reports a breaker-clearing signal only for credential-scoped conditions", () => {
    recordFact("credential-invalid", { kind: "attempt", provider: "p", credentialId: personal, model: "m" }, { path });
    expect(clearFactsV2("p", personal, "m", { path })).toEqual([]);
    recordFact("credential-invalid", { kind: "credential", provider: "p", credentialId: personal }, { path });
    expect(clearFactsV2("p", personal, "m", { path })).toEqual(["credential-invalid"]);
  });

  it("materializes new templates with the attempt credential and explicit all widening", () => {
    expect(materializeScopeV2({ kind: "attempt" }, "p", personal, "m"))
      .toEqual({ kind: "attempt", provider: "p", credentialId: personal, model: "m" });
    expect(materializeScopeV2({ kind: "credential" }, "p", personal, "m"))
      .toEqual({ kind: "credential", provider: "p", credentialId: personal });
    expect(materializeScopeV2({ kind: "group", credential: "attempt", members: ["other"] }, "p", personal, "m"))
      .toEqual({ kind: "group", provider: "p", credentialId: personal, members: ["other", "m"] });
    expect(materializeScopeV2({ kind: "group", credential: "all", members: ["m"] }, "p", personal, "m"))
      .toEqual({ kind: "group", provider: "p", members: ["m"] });
  });

  it("requeues accepted v1 provider interpretations as nonbinding pending review", () => {
    const signature = "p|m|403|unfamiliar refusal";
    writeFileSync(interpPath, JSON.stringify({
      version: 1,
      confirmed: {
        [signature]: { class: "credential-invalid", scope: { kind: "provider" }, source: "researched", acceptedAt: 1 },
      },
      unknown: {},
      ignored: {},
    }));
    resetInterpretations();
    expect(interpretRefusal("p", "m", 403, "unfamiliar refusal", { path: interpPath })).toBeNull();
    expect(pendingRefusals({ path: interpPath }).map((entry) => entry.signature)).toEqual([signature]);
  });

  it("drops v2 unknown rows whose fields do not exactly match their storage signature", () => {
    const signature = "p|m|403|known unknown";
    writeFileSync(interpPath, JSON.stringify({
      version: 2,
      confirmed: {},
      ignored: {},
      unknown: {
        [signature]: {
          provider: "other",
          model: "m",
          status: 403,
          normalized: "known unknown",
          sample: "known unknown",
          count: 1,
          firstSeen: 1,
          lastSeen: 1,
        },
      },
    }));
    resetInterpretations();
    expect(pendingRefusals({ path: interpPath })).toEqual([]);
  });

  it("accepts only exact v1 and v2 template shapes", () => {
    const v1Deployment = "p|m|403|legacy deployment";
    const v1Extra = "p|m|403|legacy extra";
    writeFileSync(interpPath, JSON.stringify({
      version: 1,
      confirmed: {
        [v1Deployment]: { class: "not-servable", scope: { kind: "deployment" }, source: "researched", acceptedAt: 1 },
        [v1Extra]: { class: "not-servable", scope: { kind: "deployment", model: "m" }, source: "researched", acceptedAt: 1 },
      },
      unknown: {},
      ignored: {},
    }));
    resetInterpretations();
    expect(interpretRefusal("p", "m", 403, "legacy deployment", { path: interpPath })?.scope).toEqual({ kind: "deployment" });
    expect(interpretRefusal("p", "m", 403, "legacy extra", { path: interpPath })).toBeNull();

    const v2Attempt = "p|m|403|new attempt";
    const v2Extra = "p|m|403|new extra";
    writeFileSync(interpPath, JSON.stringify({
      version: 2,
      confirmed: {
        [v2Attempt]: { class: "not-servable", scope: { kind: "attempt" }, source: "researched", acceptedAt: 1 },
        [v2Extra]: { class: "not-servable", scope: { kind: "attempt", model: "m" }, source: "researched", acceptedAt: 1 },
      },
      unknown: {},
      ignored: {},
    }));
    resetInterpretations();
    expect(interpretRefusal("p", "m", 403, "new attempt", { path: interpPath })?.scope).toEqual({ kind: "attempt" });
    expect(interpretRefusal("p", "m", 403, "new extra", { path: interpPath })).toBeNull();
  });

  it("uses structured quota dimensions without widening unknown or model-bound evidence", () => {
    const structured = (quotaId: string) => JSON.stringify({
      error: { details: [{ "@type": "type.googleapis.com/google.rpc.QuotaFailure", quotaId }] },
    });
    expect(interpretRefusal("p", "m", 429, structured("GenerateRequestsPerDayPerProjectPerModel"), { path: interpPath })?.scope)
      .toEqual({ kind: "attempt" });
    expect(interpretRefusal("p", "m", 429, structured("GenerateRequestsPerDayPerProject"), { path: interpPath })?.scope)
      .toEqual({ kind: "credential" });
    expect(interpretRefusal("p", "m", 429, structured("GenerateRequestsPerMinutePerKey"), { path: interpPath }))
      .toMatchObject({ class: "rate-limited", scope: { kind: "credential" } });
    expect(interpretRefusal("p", "m", 429, structured("GenerateRequestsPerDayPerUnrecognizedDimension"), { path: interpPath })?.scope)
      .toEqual({ kind: "attempt" });
  });
});

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
    expect(v?.scope).toEqual({ kind: "credential" });
  });

  it("reads stated plan gating as a COST fact scoped to the one deployment", () => {
    for (const body of [REAL_REFUSALS.ollamaSub, REAL_REFUSALS.ollamaPlan]) {
      const v = interpretRefusal("ollama-cloud", "glm-5.2", 403, body, { path: interpPath });
      // Deployment, NOT provider: the credential works fine for that provider's other models, so
      // blocking the provider would take out members that serve.
      expect(v?.class).toBe("subscription-required");
      expect(v?.scope).toEqual({ kind: "attempt" });
    }
  });

  it("reads stated non-existence as an EXISTENCE fact, even when the message names an account", () => {
    expect(interpretRefusal("huggingface", "deepseek-ai/DeepSeek-V4", 400, REAL_REFUSALS.hfGone, { path: interpPath })?.class)
      .toBe("not-servable");
    // NIM's "Not found for account '<id>'" names an account but is about the serving function.
    const v = interpretRefusal("nim", "moonshotai/kimi-k2.6", 404, REAL_REFUSALS.nimGone, { path: interpPath });
    expect(v?.class).toBe("not-servable");
    expect(v?.scope).toEqual({ kind: "attempt" });
  });

  it("reads a STATED bad credential as a provider-wide fact", () => {
    // The measured gap this closes: a revoked key is a fact about the credential, but
    // `credentialFaultUntil` is keyed per deployment — so every model on that provider had to
    // independently discover the same 401, each on its own expiry clock.
    const v = interpretRefusal("groq", "some-model", 401, REAL_REFUSALS.badKey, { path: interpPath });
    expect(v?.class).toBe("credential-invalid");
    expect(v?.scope).toEqual({ kind: "credential" });
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
    expect(v?.scope).toEqual({ kind: "credential" });
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

  it("persists the reset's provenance (untilBasis) beside the expiry and reads it back", () => {
    // The availability ladder's reviewed-rule rung is fed from this field; dropping it at the
    // record seam is the defect packet P fixes.
    const now = 9_000_000;
    recordFact("allowance-exhausted", { kind: "provider", provider: "gemini" }, {
      path, now, retryAfterMs: 60_000, untilBasis: "reviewed-field",
    });
    const hit = factsFor("gemini", "m", { path, now: now + 1 }).find((fact) => fact.kind === "allowance-exhausted");
    expect(hit?.until).toBe(now + 60_000);
    expect(hit?.untilBasis).toBe("reviewed-field");
    expect(allFacts({ path, now: now + 1 }).find((fact) => fact.kind === "allowance-exhausted")?.untilBasis).toBe("reviewed-field");
  });

  it("ignores untilBasis when no positive retryAfterMs was given — the expiry is the default TTL", () => {
    const now = 9_000_000;
    recordFact("rate-limited", { kind: "provider", provider: "g" }, { path, now, untilBasis: "reviewed-field" });
    recordFact("rate-limited", { kind: "provider", provider: "h" }, { path, now, retryAfterMs: 0, untilBasis: "retry-after" });
    expect(factsFor("g", "m", { path, now: now + 1 })[0]?.untilBasis).toBeUndefined();
    expect(factsFor("h", "m", { path, now: now + 1 })[0]?.untilBasis).toBeUndefined();
  });

  it("loads a legacy row without untilBasis unchanged, and expires it as before", () => {
    const now = 9_000_000;
    writeFileSync(path, JSON.stringify({
      version: 2,
      facts: {
        [keyOf("allowance-exhausted", { kind: "provider", provider: "gemini" })]: {
          kind: "allowance-exhausted", scope: { kind: "provider", provider: "gemini" },
          at: now, until: now + 30_000,
        },
      },
    }));
    resetFacts();
    const live = factsFor("gemini", "m", { path, now: now + 1 });
    expect(live).toHaveLength(1);
    expect(live[0]?.until).toBe(now + 30_000);
    expect(live[0]?.untilBasis).toBeUndefined();
    expect(cooldownUntil("gemini", "m", { path, now: now + 31_000 })).toBeNull();
  });

  it("drops a malformed untilBasis on load to absent rather than failing the row", () => {
    const now = 9_000_000;
    writeFileSync(path, JSON.stringify({
      version: 2,
      facts: {
        [keyOf("allowance-exhausted", { kind: "provider", provider: "gemini" })]: {
          kind: "allowance-exhausted", scope: { kind: "provider", provider: "gemini" },
          at: now, until: now + 30_000, untilBasis: "vibes",
        },
      },
    }));
    resetFacts();
    const live = factsFor("gemini", "m", { path, now: now + 1 });
    expect(live).toHaveLength(1);
    expect(live[0]?.untilBasis).toBeUndefined();
    expect(cooldownUntil("gemini", "m", { path, now: now + 1 })).toBe(now + 30_000);
  });

  it("drops untilBasis on a row with no explicit until — a default TTL is not a stated reset", () => {
    // Only reachable through a hand-edited or foreign file, but the field's whole contract is
    // "this basis explains THIS expiry". With no `until`, `expiryOf` falls back to the kind's TTL,
    // and handing that fallback out with a basis attached would label a guess as a measurement.
    const now = 9_000_000;
    writeFileSync(path, JSON.stringify({
      version: 2,
      facts: {
        [keyOf("allowance-exhausted", { kind: "provider", provider: "gemini" })]: {
          kind: "allowance-exhausted", scope: { kind: "provider", provider: "gemini" },
          at: now, untilBasis: "reviewed-field",
        },
      },
    }));
    resetFacts();
    const live = factsFor("gemini", "m", { path, now: now + 1 });
    expect(live).toHaveLength(1);
    expect(live[0]?.until).toBe(now + FACT_TTL_MS["allowance-exhausted"]);
    expect(live[0]?.untilBasis).toBeUndefined();
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
    expect(v?.scope).toEqual({ kind: "credential" });
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
    expect(clearFacts("p", "gone", { path })).toEqual([]);
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
    const scope = materializeScope({ kind: "group", credential: "all", members: ["a"] }, "p", "b");
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

  it("stores only the normalized sample, without ids, key-shaped strings, or URLs", () => {
    const uuid = "e7592a59-d5d4-4e52-b072-905bdb4f9fbc";
    const key = "sk_live_1234567890abcdefghijklmnop";
    const url = "https://provider.test/upgrade?request=secret";
    const body = JSON.stringify({
      error: { message: `Regional policy denied request ${uuid} using ${key}; details at ${url}` },
    });

    recordUnknownRefusal("groq", "some-model", 403, body, { path: interpPath });
    flushInterpretations({ path: interpPath });
    const persisted = JSON.parse(readFileSync(interpPath, "utf8")) as {
      unknown: Record<string, { sample: string }>;
    };
    const stored = Object.values(persisted.unknown)[0]!;

    expect(stored.sample).toBe(normalizeRefusalMessage(body));
    expect(stored.sample).not.toContain(uuid);
    expect(stored.sample).not.toContain(key);
    expect(stored.sample).not.toContain(url);
    expect(stored.sample).toContain("<id>");
    expect(stored.sample).toContain("<url>");
  });

  it("keeps the seed recheck matching when it normalizes an already-redacted sample", () => {
    recordUnknownRefusal("ollama-cloud", "some-model", 403, REAL_REFUSALS.ollamaSub, { path: interpPath });

    // `recordUnknownRefusal` stores the normalized sample; `pendingRefusals` sends that stored
    // sample through the normalizer again before checking seeds. It must still bind and disappear.
    expect(pendingRefusals({ path: interpPath })).toHaveLength(0);
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
    acceptInterpretation(sig, { path: interpPath, override: { class: "subscription-required", scope: { kind: "group", credential: "attempt", members: ["pro-1", "pro-2"] } } });
    const v = interpretRefusal("p", "pro-1", 403, body, { path: interpPath });
    expect(v?.scope).toEqual({ kind: "group", credential: "attempt", members: ["pro-1", "pro-2"] });
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

describe("persist prunes expired rows without changing any answer", () => {
  const personal = makeCredentialId("p", "personal");

  it("drops expired rows on persist while keeping live rows, and factsFor is unchanged", () => {
    const now = 1_000_000;
    const longAgo = now - FACT_TTL_MS["not-servable"] - 1_000;

    // Record an expired row and a live row (deployment scope uses the helper's default credential)
    recordFact("not-servable", { kind: "deployment", provider: "p", model: "expired" }, { path, now: longAgo });
    recordFact("not-servable", { kind: "deployment", provider: "p", model: "alive" }, { path, now });

    // But factsFor filters by expiry - expired excluded, live included
    expect(factsFor("p", "expired", { path, now })).toHaveLength(0);
    expect(factsFor("p", "alive", { path, now })).toHaveLength(1);

    // Trigger persist with the test's `now`
    flushFacts({ path, now });

    // Verify the expired row is gone from the file
    const persisted = JSON.parse(readFileSync(path, "utf8"));
    const keys = Object.keys(persisted.facts);
    expect(keys.some((k) => k.includes("expired"))).toBe(false);
    expect(keys.some((k) => k.includes("alive"))).toBe(true);

    // Verify factsFor answers identically - live row still there, expired still excluded
    const afterPersist = factsFor("p", "alive", { path, now });
    expect(afterPersist).toHaveLength(1);
    expect(afterPersist[0]?.kind).toBe("not-servable");

    // Expired model still reports nothing (as it did before)
    expect(factsFor("p", "expired", { path, now })).toHaveLength(0);
  });

  it("prunes all expired kinds, not just conditions", () => {
    const now = 1_000_000;
    const longAgo = now - FACT_TTL_MS["context-limit"] - 1_000;

    // Record expired measurement and expired condition
    recordFact("context-limit", { kind: "attempt", provider: "p", credentialId: personal, model: "m1" }, { path, now: longAgo, value: 4096 });
    recordFact("credential-invalid", { kind: "credential", provider: "p", credentialId: personal }, { path, now: longAgo });

    // Live ones
    recordFact("context-limit", { kind: "attempt", provider: "p", credentialId: personal, model: "m2" }, { path, now, value: 8192 });
    recordFact("credential-invalid", { kind: "attempt", provider: "p", credentialId: personal, model: "m3" }, { path, now });

    // Trigger persist with the test's `now`
    flushFacts({ path, now });

    // Verify expired ones are pruned from file
    const persisted = JSON.parse(readFileSync(path, "utf8"));
    const keys = Object.keys(persisted.facts);
    expect(keys.filter((k) => k.includes("m1")).length).toBe(0);
    expect(keys.filter((k) => k.startsWith("credential-invalid:c:")).length).toBe(0); // expired credential

    // Live ones survive - use the V2 function directly with explicit credentialId
    expect(factsForV2("p", personal, "m2", { path, now })).toHaveLength(1);
    expect(factsForV2("p", personal, "m3", { path, now })).toHaveLength(1);
  });
});

/**
 * ⚠ Making the rename fail is the whole test, and the obvious way does not work.
 *
 * A "non-existent parent directory" is useless here: both writers call
 * `mkdirSync(join(path, ".."), { recursive: true })` before writing, so the parent is created and
 * the write succeeds. A fixture built that way passes on the UN-FIXED tree, and any temp left
 * behind would sit in the created subdirectory rather than the one the assertion lists — two
 * independent reasons it cannot observe the defect.
 *
 * Instead: make the TARGET an existing, non-empty directory. The temp writes normally and
 * `renameSync(tmp, target)` cannot replace a non-empty directory on any platform.
 */
function blockedTarget(name: string): string {
  const target = join(dir, name);
  mkdirSync(target, { recursive: true });
  writeFileSync(join(target, "occupant"), "x", "utf8");
  return target;
}

const tempsIn = (d: string) => readdirSync(d).filter((f) => f.endsWith(".tmp"));

describe("target-facts persist cleans up its temp file when the rename fails", () => {
  it("leaves no temp file behind", () => {
    const now = 1_000_000;
    recordFact("not-servable", { kind: "deployment", provider: "p", model: "m" }, { path, now });
    const blocked = blockedTarget("blocked-facts.json");

    flushFacts({ path: blocked, now });

    expect(tempsIn(dir)).toHaveLength(0);
  });

  it("still swallows the error rather than failing its caller", () => {
    const now = 1_000_000;
    recordFact("not-servable", { kind: "deployment", provider: "p", model: "m" }, { path, now });
    const blocked = blockedTarget("blocked-facts-swallow.json");

    // Best-effort by contract: a storage problem must never become a request failure.
    expect(() => flushFacts({ path: blocked, now })).not.toThrow();
  });
});

describe("refusal-interpretation persist cleans up its temp file when the rename fails", () => {
  it("leaves no temp file behind", () => {
    const now = 1_000_000;
    recordUnknownRefusal("p", "m", 403, `{"error":{"message":"test message"}}`, { path: interpPath, now });
    const blocked = blockedTarget("blocked-interpretations.json");

    flushInterpretations({ path: blocked });

    expect(tempsIn(dir)).toHaveLength(0);
  });

  it("still swallows the error rather than failing its caller", () => {
    recordUnknownRefusal("p", "m", 403, `{"error":{"message":"test message"}}`, { path: interpPath });
    const blocked = blockedTarget("blocked-interpretations-swallow.json");

    expect(() => flushInterpretations({ path: blocked })).not.toThrow();
  });
});

describe("staleness-keyed memoization and lost-update prevention", () => {
  it("external write (simulating CLI accept) is observed by next read in same process without restart", () => {
    // Simulate a running relay process that has loaded the store
    recordUnknownRefusal("p", "m", 403, `{"error":{"message":"unfamiliar message"}}`, { path: interpPath });
    const sig = pendingRefusals({ path: interpPath })[0]!.signature;

    // Simulate CLI accept writing to the file directly (bypassing the relay's in-memory store)
    const body = `{"error":{"message":"unfamiliar message"}}`;
    const confirmedEntry = {
      class: "not-servable",
      scope: { kind: "deployment" },
      source: "researched" as const,
      acceptedAt: Date.now(),
    };
    writeFileSync(interpPath, JSON.stringify({
      version: 2,
      confirmed: { [sig]: confirmedEntry },
      unknown: {},
      ignored: {},
    }));

    // Next read in the SAME process must observe the external write
    const v = interpretRefusal("p", "m", 403, body, { path: interpPath });
    expect(v?.class).toBe("not-servable");
    expect(v?.scope).toEqual({ kind: "deployment" });
    expect(v?.source).toBe("researched");
  });

  it("persist after external write does not drop externally-added confirmed row", () => {
    // Simulate running relay with some in-memory state
    recordUnknownRefusal("p", "m", 403, `{"error":{"message":"another message"}}`, { path: interpPath });
    const sig = pendingRefusals({ path: interpPath })[0]!.signature;

    // Simulate external CLI accept
    const body = `{"error":{"message":"another message"}}`;
    const confirmedEntry = {
      class: "credential-invalid",
      scope: { kind: "credential" },
      source: "researched" as const,
      acceptedAt: Date.now(),
    };
    writeFileSync(interpPath, JSON.stringify({
      version: 2,
      confirmed: { [sig]: confirmedEntry },
      unknown: {},
      ignored: {},
    }));

    // Now the relay's in-memory store has the old unknown entry. Trigger a persist
    // (e.g., via recordUnknownRefusal or another write operation)
    // This simulates the debounced writer firing after the external write
    recordUnknownRefusal("other", "m", 403, `{"error":{"message":"third message"}}`, { path: interpPath });
    flushInterpretations({ path: interpPath });

    // The external confirmed entry must survive the merge
    const v = interpretRefusal("p", "m", 403, body, { path: interpPath });
    expect(v?.class).toBe("credential-invalid");
    expect(v?.scope).toEqual({ kind: "credential" });
    expect(v?.source).toBe("researched");
  });

  it("unknown rows are unioned on merge, counts summed", () => {
    // Set up initial file with an unknown entry
    const sig = "p|m|403|shared message";
    writeFileSync(interpPath, JSON.stringify({
      version: 2,
      confirmed: {},
      unknown: {
        [sig]: {
          provider: "p",
          model: "m",
          status: 403,
          normalized: "shared message",
          sample: "shared message",
          count: 3,
          firstSeen: 1000,
          lastSeen: 2000,
        },
      },
      ignored: {},
    }));
    resetInterpretations();

    // Simulate relay adding more occurrences in memory
    recordUnknownRefusal("p", "m", 403, `{"error":{"message":"shared message"}}`, { path: interpPath });
    recordUnknownRefusal("p", "m", 403, `{"error":{"message":"shared message"}}`, { path: interpPath });
    flushInterpretations({ path: interpPath });

    // Reload and verify counts were summed
    const reloaded = pendingRefusals({ path: interpPath });
    const entry = reloaded.find((e) => e.signature === sig);
    expect(entry).toBeDefined();
    expect(entry!.count).toBe(5); // 3 (disk) + 2 (memory)
    expect(entry!.firstSeen).toBe(1000);
    expect(entry!.lastSeen).toBeGreaterThanOrEqual(2000);
  });

  it("confirmed wins over unknown for same signature (no resurrection)", () => {
    // File has a confirmed entry
    const sig = "p|m|403|confirmed wins";
    const body = `{"error":{"message":"confirmed wins"}}`;
    writeFileSync(interpPath, JSON.stringify({
      version: 2,
      confirmed: {
        [sig]: {
          class: "subscription-required",
          scope: { kind: "deployment" },
          source: "researched",
          acceptedAt: Date.now(),
        },
      },
      unknown: {},
      ignored: {},
    }));
    resetInterpretations();

    // Reload to get confirmed entry in memory
    interpretRefusal("p", "m", 403, body, { path: interpPath });

    // Now simulate an external process adding the SAME signature to unknown
    // (this simulates the race where the file is externally modified to have both)
    writeFileSync(interpPath, JSON.stringify({
      version: 2,
      confirmed: {
        [sig]: {
          class: "subscription-required",
          scope: { kind: "deployment" },
          source: "researched",
          acceptedAt: Date.now(),
        },
      },
      unknown: {
        [sig]: {
          provider: "p",
          model: "m",
          status: 403,
          normalized: "confirmed wins",
          sample: "confirmed wins",
          count: 1,
          firstSeen: Date.now(),
          lastSeen: Date.now(),
        },
      },
      ignored: {},
    }));

    // Trigger a persist from the relay side
    recordUnknownRefusal("other", "m", 403, `{"error":{"message":"unrelated"}}`, { path: interpPath });
    flushInterpretations({ path: interpPath });

    // The confirmed entry must still be there and unknown must not have resurrected it
    const v = interpretRefusal("p", "m", 403, body, { path: interpPath });
    expect(v?.class).toBe("subscription-required");
    expect(v?.source).toBe("researched");

    // And the unknown should not have the confirmed signature
    const pending = pendingRefusals({ path: interpPath });
    const hasConfirmedSig = pending.some((e) => e.signature === sig);
    expect(hasConfirmedSig).toBe(false);
  });
});
