import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  acceptInterpretation,
  flushInterpretations,
  interpretRefusal,
  normalizeRefusalMessage,
  pendingRefusals,
  recordUnknownRefusal,
  refusalSignature,
  resetInterpretations,
  statesModelDoesNotExist,
} from "../src/refusal-interpretation.js";

/**
 * The lane-split defect (2026-08-29 triage, docs/eligibility-triage-2026-08-29.md finding 1):
 * ONE provider condition produced TWO signatures depending on which lane observed it.
 *
 * A pool walk on an openai-kind target sees the relay's own synthesized error — the anthropic
 * envelope whose `error.message` is `openai backend HTTP <status>: <body.slice(0,300)>` — so a
 * long provider body arrives TRUNCATED mid-JSON, extraction fails, and the whole relay-authored
 * wrapper became the signature. The direct Chat passthrough sees the provider's raw body, which
 * parses, so the same condition normalized to the bare message. Verified live: an accepted
 * wrapped-form signature did not match the direct-lane refusal, which queued fresh and needed a
 * second accept.
 *
 * The fix is two-sided, and these tests pin both:
 * - normalizeRefusalMessage unwraps to a FIXPOINT (envelope → wrapper → provider payload),
 *   stripping the relay's own wrapper prefix and falling back to deterministic field extraction
 *   when the payload does not parse (truncation-tolerant).
 * - readStoreFile migrates every stored signature through the current normalizer, so verdicts
 *   accepted against a historical form keep binding — including the 2026-08-29 batch.
 */

// Byte-faithful to backend.ts: anthropicError(status, `openai backend HTTP ${status}${hint}: ${body.slice(0, 300)}`).
function walkLaneBody(status: number, providerBody: string, hint = ""): string {
  const message = `openai backend HTTP ${status}${hint}: ${providerBody.slice(0, 300)}`;
  return JSON.stringify({ type: "error", error: { type: "api_error", message } });
}

// Real bodies from the 2026-08-29 triage families (URLs/refs representative, shape verbatim).
const WEEKLY_LIMIT_BODY = `{"error":{"message":"Key limit exceeded (weekly limit). Manage it using https://openrouter.ai/settings/keys","code":403,"metadata":{"provider_name":"openrouter","request_id":"req_0123456789abcdef0123456789","headers":{"x-ratelimit-limit-requests":"1000","x-ratelimit-remaining-requests":"0","x-ratelimit-reset-requests":"604800"}}},"user_id":"user_2abcdefghijklmnopqrstuvwxyz"}`;
const MISTRAL_429_BODY = `{"object":"error","message":"rate limit exceeded","type":"rate_limited","param":null,"code":"3505","raw_status_code":429}`;
const BATCH_404_BODY = `{"error":{"message":"This model is only available through the batch API. Use the /api/beta/batches endpoint instead. See https://openrouter.ai/docs/batch for details and examples of how to use the batch API with this model id.","code":404,"metadata":{"provider_name":"anthropic","request_id":"req_abcdef0123456789abcd"}}}`;
const HINT_404 = ` — model "anthropic/claude-opus-5:batch" is not served by provider "openrouter" (a model can be listed in /models and still 404 here)`;

describe("normalizeRefusalMessage converges both lanes onto one signature", () => {
  it("truncated wrapped JSON (walk lane) equals the full raw body (direct lane)", () => {
    // The provider body is longer than backend.ts's 300-char cap, so the walk lane's embedded
    // JSON cannot parse — the shape that split every long-bodied family in the live queue.
    expect(WEEKLY_LIMIT_BODY.length).toBeGreaterThan(300);
    const walk = normalizeRefusalMessage(walkLaneBody(403, WEEKLY_LIMIT_BODY));
    const direct = normalizeRefusalMessage(WEEKLY_LIMIT_BODY);
    expect(walk).toBe(direct);
    expect(walk).not.toContain("openai backend http");
    expect(walk).toContain("key limit exceeded (weekly limit)");
  });

  it("complete wrapped JSON (walk lane) equals the raw body (direct lane)", () => {
    const walk = normalizeRefusalMessage(walkLaneBody(429, MISTRAL_429_BODY));
    const direct = normalizeRefusalMessage(MISTRAL_429_BODY);
    expect(walk).toBe(direct);
    expect(direct).toBe("rate limit exceeded");
  });

  it("the 404 hint variant of the wrapper is stripped too", () => {
    const walk = normalizeRefusalMessage(walkLaneBody(404, BATCH_404_BODY, HINT_404));
    const direct = normalizeRefusalMessage(BATCH_404_BODY);
    expect(walk).toBe(direct);
    expect(walk).toContain("only available through the batch api");
  });

  it("a non-JSON provider body converges through the wrapper strip alone", () => {
    const html = "<html><body>Service temporarily unavailable, retry shortly. Gateway node eu-west answered with an upstream connect error and the request was not forwarded to any model backend at this time.</body></html>";
    const walk = normalizeRefusalMessage(walkLaneBody(503, html));
    const direct = normalizeRefusalMessage(html);
    expect(walk).toBe(direct);
    expect(walk).not.toContain("openai backend http");
  });

  it("escaped quotes in a truncated value match the parse path's unescaped form", () => {
    const body = `{"error":{"message":"model \\"foo\\" not found for the account, verify the id spelling and the provider prefix before retrying this request against the catalog endpoint of the service in question today: ${"x".repeat(160)}","code":404}}`;
    expect(body.length).toBeGreaterThan(300);
    const walk = normalizeRefusalMessage(walkLaneBody(404, body));
    const direct = normalizeRefusalMessage(body);
    expect(walk).toBe(direct);
    expect(walk).toContain('model "foo" not found');
  });

  it("is idempotent on every fixture's output", () => {
    for (const input of [
      walkLaneBody(403, WEEKLY_LIMIT_BODY),
      walkLaneBody(429, MISTRAL_429_BODY),
      walkLaneBody(404, BATCH_404_BODY, HINT_404),
      WEEKLY_LIMIT_BODY,
      MISTRAL_429_BODY,
      "plain prose refusal with no structure at all",
    ]) {
      const once = normalizeRefusalMessage(input);
      expect(normalizeRefusalMessage(once)).toBe(once);
    }
  });

  it("leaves plain prose untouched apart from the standard redaction", () => {
    expect(normalizeRefusalMessage("Too Many Requests")).toBe("too many requests");
  });

  it("an empty provider body wrapped by the relay teaches nothing and queues nothing", () => {
    // The wrapper prose is relay-authored diagnosis, not a provider statement — keying a verdict
    // on it is exactly what this fix removes. One live row was keyed that way (an empty-body nim
    // 404); it stays on its old key harmlessly, and fresh empty-body refusals learn nothing.
    const wrappedEmpty = walkLaneBody(404, "", HINT_404);
    expect(normalizeRefusalMessage(wrappedEmpty)).toBe("");
    const dir = mkdtempSync(join(tmpdir(), "llm-relay-empty-"));
    try {
      const path = join(dir, "interpretations.json");
      recordUnknownRefusal("nim", "nvidia/nemotron-3-ultra-550b-a55b", 404, wrappedEmpty, { path });
      expect(pendingRefusals({ path })).toHaveLength(0);
    } finally {
      resetInterpretations();
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("stored signatures migrate through the current normalizer at load", () => {
  let dir: string;
  let path: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "llm-relay-sigmig-"));
    path = join(dir, "interpretations.json");
    resetInterpretations();
  });

  afterEach(() => {
    resetInterpretations();
    rmSync(dir, { recursive: true, force: true });
  });

  // The historical form, verbatim from the live queue: the old normalizer kept the wrapper and
  // the truncated JSON prefix. Frozen here as a string — computing it with current code would
  // test nothing.
  const OLD_WEEKLY_NORM = `openai backend http <n>: {"error":{"message":"key limit exceeded (weekly limit). manage it using <url>`;
  const OLD_WEEKLY_SIG = `openrouter|deepseek/deepseek-v4-flash-0731|403|${OLD_WEEKLY_NORM}`;

  function writeStore(store: object): void {
    writeFileSync(path, JSON.stringify(store, null, 2), "utf8");
  }

  it("a confirmed row accepted against the historical form binds against fresh bodies on BOTH lanes", () => {
    writeStore({
      version: 2,
      confirmed: {
        [OLD_WEEKLY_SIG]: { class: "allowance-exhausted", scope: { kind: "credential" }, costClasses: ["paid"], source: "researched", acceptedAt: 1000 },
      },
      unknown: {},
    });
    for (const body of [WEEKLY_LIMIT_BODY, walkLaneBody(403, WEEKLY_LIMIT_BODY)]) {
      const hit = interpretRefusal("openrouter", "deepseek/deepseek-v4-flash-0731", 403, body, { path });
      expect(hit, `no hit for ${body.slice(0, 40)}`).not.toBeNull();
      expect(hit!.class).toBe("allowance-exhausted");
      expect(hit!.costClasses).toEqual(["paid"]);
    }
  });

  it("two historical forms of one condition merge; the later acceptance wins", () => {
    const bareNorm = normalizeRefusalMessage(WEEKLY_LIMIT_BODY);
    const bareSig = `openrouter|deepseek/deepseek-v4-flash-0731|403|${bareNorm}`;
    writeStore({
      version: 2,
      confirmed: {
        [OLD_WEEKLY_SIG]: { class: "allowance-exhausted", scope: { kind: "credential" }, costClasses: ["paid"], source: "researched", acceptedAt: 2000 },
        [bareSig]: { class: "rate-limited", scope: { kind: "deployment" }, source: "researched", acceptedAt: 1000 },
      },
      unknown: {},
    });
    const hit = interpretRefusal("openrouter", "deepseek/deepseek-v4-flash-0731", 403, WEEKLY_LIMIT_BODY, { path });
    expect(hit).not.toBeNull();
    expect(hit!.class).toBe("allowance-exhausted");
  });

  it("an unknown row re-keys with its normalized sample updated, and survives a write/reload round-trip", () => {
    writeStore({
      version: 2,
      confirmed: {},
      unknown: {
        [OLD_WEEKLY_SIG]: {
          provider: "openrouter", model: "deepseek/deepseek-v4-flash-0731", status: 403,
          normalized: OLD_WEEKLY_NORM, sample: OLD_WEEKLY_NORM, count: 39, firstSeen: 1, lastSeen: 2,
        },
      },
    });
    const pending = pendingRefusals({ path });
    expect(pending).toHaveLength(1);
    expect(pending[0]!.normalized).not.toContain("openai backend http");
    expect(pending[0]!.signature).toBe(refusalSignature("openrouter", "deepseek/deepseek-v4-flash-0731", 403, WEEKLY_LIMIT_BODY));
    // A fresh occurrence lands on the SAME entry rather than forking a second one.
    recordUnknownRefusal("openrouter", "deepseek/deepseek-v4-flash-0731", 403, WEEKLY_LIMIT_BODY, { path });
    flushInterpretations({ path });
    resetInterpretations();
    const reloaded = pendingRefusals({ path });
    expect(reloaded).toHaveLength(1);
    expect(reloaded[0]!.count).toBe(40);
  });

  it("an unknown row that converges onto a confirmed signature is resolved, not resurrected", () => {
    const bareNorm = normalizeRefusalMessage(WEEKLY_LIMIT_BODY);
    const bareSig = `openrouter|deepseek/deepseek-v4-flash-0731|403|${bareNorm}`;
    writeStore({
      version: 2,
      confirmed: {
        [bareSig]: { class: "allowance-exhausted", scope: { kind: "credential" }, source: "researched", acceptedAt: 1000 },
      },
      unknown: {
        [OLD_WEEKLY_SIG]: {
          provider: "openrouter", model: "deepseek/deepseek-v4-flash-0731", status: 403,
          normalized: OLD_WEEKLY_NORM, sample: OLD_WEEKLY_NORM, count: 39, firstSeen: 1, lastSeen: 2,
        },
      },
    });
    expect(pendingRefusals({ path })).toHaveLength(0);
  });

  it("a rejection recorded against the historical form keeps suppressing fresh occurrences", () => {
    const oldMistralNorm = `openai backend http <n>: {"object":"error","message":"rate limit exceeded","type":"rate_limited","param":null,"code":"<n>","raw_status_code":<n>}`;
    const oldMistralSig = `mistral|mistral-medium-3-5|429|${oldMistralNorm}`;
    writeStore({
      version: 2,
      confirmed: {},
      unknown: {},
      ignored: { [oldMistralSig]: { at: Date.now() } },
    });
    recordUnknownRefusal("mistral", "mistral-medium-3-5", 429, MISTRAL_429_BODY, { path });
    expect(pendingRefusals({ path })).toHaveLength(0);
  });

  it("recording the walk-lane and direct-lane forms of one refusal yields ONE pending entry", () => {
    recordUnknownRefusal("openrouter", "m", 403, walkLaneBody(403, WEEKLY_LIMIT_BODY), { path });
    recordUnknownRefusal("openrouter", "m", 403, WEEKLY_LIMIT_BODY, { path });
    const pending = pendingRefusals({ path });
    expect(pending).toHaveLength(1);
    expect(pending[0]!.count).toBe(2);
  });

  it("acceptance through the public API against a migrated key persists in the migrated form", () => {
    writeStore({
      version: 2,
      confirmed: {},
      unknown: {
        [OLD_WEEKLY_SIG]: {
          provider: "openrouter", model: "deepseek/deepseek-v4-flash-0731", status: 403,
          normalized: OLD_WEEKLY_NORM, sample: OLD_WEEKLY_NORM, count: 39, firstSeen: 1, lastSeen: 2,
        },
      },
    });
    const migrated = pendingRefusals({ path })[0]!.signature;
    expect(acceptInterpretation(migrated, {
      path,
      override: { class: "allowance-exhausted", scope: { kind: "credential" }, costClasses: ["paid"] },
    })).toBe(true);
    flushInterpretations({ path });
    const onDisk = JSON.parse(readFileSync(path, "utf8")) as { confirmed: Record<string, unknown> };
    expect(Object.keys(onDisk.confirmed)).toEqual([migrated]);
  });
});

/**
 * The catalog-staleness classifier: does this refusal STATE that the requested model does not
 * exist?
 *
 * This decides only whether the relay re-fetches a provider's roster — never what the refusal
 * means for routing, which stays `interpretRefusal`'s job. It is exported and pinned separately
 * because the REQUEST path is a thin caller of it, and the boundary between "the provider said the
 * model is gone" and "the request was bad" is the whole containment of the feature: get it wrong in
 * the permissive direction and any failing request can drive a provider's `/models` endpoint.
 */
describe("statesModelDoesNotExist — the roster-staleness signal", () => {
  it("recognises the stated-absence wording family on a 404", () => {
    const bodies = [
      `{"error":{"message":"The requested model 'x' does not exist."}}`,
      `{"error":{"message":"model_not_found","type":"invalid_request_error"}}`,
      `{"error":{"message":"unknown model: x"}}`,
      `{"error":{"message":"no such model"}}`,
    ];
    for (const body of bodies) {
      expect(statesModelDoesNotExist(404, body), body).toBe(true);
    }
  });

  it("refuses every status that is not 404, whatever the wording says", () => {
    // ⚠ These bodies DO carry absence wording. A control whose message could not match anyway
    // proves nothing about the status gate — it passes with the gate removed.
    const absence = `{"error":{"message":"the requested model does not exist"}}`;
    for (const status of [400, 401, 402, 403, 410, 429, 500, 503, 200]) {
      expect(statesModelDoesNotExist(status, absence), `status ${status}`).toBe(false);
    }
  });

  it("declines a 404 that states something other than a model's absence", () => {
    // A 404 is not by itself evidence about a roster: a wrong path, a gated endpoint, a policy
    // refusal all answer 404, and none of them has contradicted our model list.
    for (const body of [
      `{"error":{"message":"the requested endpoint is not available on this plan"}}`,
      `{"error":{"message":"insufficient credits"}}`,
      `{"error":{"message":"rate limit exceeded"}}`,
      "",
    ]) {
      expect(statesModelDoesNotExist(404, body), body).toBe(false);
    }
  });

  it("reads THROUGH the relay's own wrapper, because that prose is ours", () => {
    // The walk lane hands this the relay's synthesized envelope, whose `error.message` is the
    // `openai backend HTTP <n> — model "…" is not served by provider "…" (…)` wrapper around the
    // provider's body. The wrapper NAMES the model but is written by the relay; a recogniser bound
    // to that text would fire on the relay's own diagnostic rather than the provider's statement,
    // so the normalized message — not the raw body — is what is tested.
    const wrapped = JSON.stringify({
      type: "error",
      error: {
        type: "api_error",
        message: `openai backend HTTP 404: {"error":{"message":"The requested model 'x' does not exist."}}`,
      },
    });
    expect(statesModelDoesNotExist(404, wrapped)).toBe(true);
  });
});
