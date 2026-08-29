import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { factsFor, cooldownUntil, flushFacts, isCostBlocked, recordFact, resetFacts } from "../src/target-facts.js";
import { makeCredentialId } from "../src/credential-id.js";

/**
 * A fact may apply to only one COST CLASS, resolved live from the catalog.
 *
 * Why this exists — the case that produced it, measured 2026-08-28. OpenRouter answers
 * `403 Key limit exceeded (weekly limit)` once per model. The message names the KEY, so it reads
 * like a credential-scoped `allowance-exhausted`. It is not: that limit is a SPEND limit, so its
 * surface is the PAID subset. On one credential inside one minute,
 * `cohere/north-mini-code:free` and `dots-studio/dots-3-note-preview:free` answered 200 while
 * `deepseek/deepseek-v4-flash-0731` answered 403. A credential-scoped fact would have demoted all
 * 398 OpenRouter deployments, 18 of them free and working.
 *
 * A `group` scope with a member list cannot express it either, because a provider moves models
 * between free, discounted and paid on its own schedule. Referencing the CLASSIFIER instead of a
 * list is the thing that cannot go stale — `assessCost()` re-reads catalog prices, which refresh
 * on a 10-minute TTL.
 */

let dir: string;
let path: string;
const cred = makeCredentialId("openrouter");

beforeEach(() => {
  resetFacts();
  dir = mkdtempSync(join(tmpdir(), "llm-relay-costclass-"));
  path = join(dir, "target-facts.json");
});
afterEach(() => {
  resetFacts();
  rmSync(dir, { recursive: true, force: true });
});

const NOW = 1_000_000;
// ⚠ A GETTER, not a captured object. `path` is assigned in `beforeEach`, so a module-level
// `const opts = { path, now: NOW }` captures `undefined` and every lookup silently reads a
// different store — the tests then fail for a reason that has nothing to do with the code.
const opts = () => ({ path, now: NOW });

function recordPaidOnlyExhaustion(): void {
  recordFact(
    "allowance-exhausted",
    { kind: "credential", provider: "openrouter", credentialId: cred },
    { ...opts(), retryAfterMs: 60 * 60 * 1000, costClasses: ["paid"] },
  );
}

describe("a cost-filtered fact applies only to the class it names", () => {
  it("does NOT cover a deployment the caller reports as free", () => {
    recordPaidOnlyExhaustion();
    // The whole point: 18 OpenRouter models answer 200 while the key's spend limit is exceeded.
    expect(factsFor("openrouter", cred, "cohere/north-mini-code:free", { ...opts(), costClass: "free" })).toEqual([]);
    expect(cooldownUntil("openrouter", cred, "cohere/north-mini-code:free", { ...opts(), costClass: "free" })).toBeNull();
  });

  it("DOES cover a deployment the caller reports as paid", () => {
    recordPaidOnlyExhaustion();
    const hits = factsFor("openrouter", cred, "deepseek/deepseek-v4-flash-0731", { ...opts(), costClass: "paid" });
    expect(hits.map((f) => f.kind)).toEqual(["allowance-exhausted"]);
    expect(cooldownUntil("openrouter", cred, "deepseek/deepseek-v4-flash-0731", { ...opts(), costClass: "paid" }))
      .toBe(NOW + 60 * 60 * 1000);
  });

  it("covers NOTHING when the caller cannot classify the deployment", () => {
    // Fail-safe, and deliberately so. A filter is a claim about a subset; a caller that cannot say
    // which subset this deployment is in has not shown the fact applies. Declining costs one walked
    // request that the breaker then learns from — demoting a healthy free deployment on an
    // unproven classification is not recoverable in the same cheap way.
    recordPaidOnlyExhaustion();
    expect(factsFor("openrouter", cred, "deepseek/deepseek-v4-flash-0731", opts())).toEqual([]);
    expect(cooldownUntil("openrouter", cred, "deepseek/deepseek-v4-flash-0731", opts())).toBeNull();
  });

  it("does not cover the third class either — a filter names exactly what it names", () => {
    recordPaidOnlyExhaustion();
    expect(factsFor("openrouter", cred, "some/unpriced-model", { ...opts(), costClass: "unknown" })).toEqual([]);
  });

  it("honours a multi-class filter", () => {
    recordFact(
      "allowance-exhausted",
      { kind: "credential", provider: "openrouter", credentialId: cred },
      { ...opts(), retryAfterMs: 1000, costClasses: ["paid", "unknown"] },
    );
    expect(factsFor("openrouter", cred, "m", { ...opts(), costClass: "paid" })).toHaveLength(1);
    expect(factsFor("openrouter", cred, "m", { ...opts(), costClass: "unknown" })).toHaveLength(1);
    expect(factsFor("openrouter", cred, "m", { ...opts(), costClass: "free" })).toEqual([]);
  });
});

describe("an UNFILTERED fact is unchanged — every existing row and caller", () => {
  it("covers every class, and covers a caller that supplies none", () => {
    // The regression that matters most: no fact written before this feature carries a filter, and
    // no caller that was not wired supplies a class. Both must behave exactly as they did.
    recordFact(
      "allowance-exhausted",
      { kind: "credential", provider: "openrouter", credentialId: cred },
      { ...opts(), retryAfterMs: 1000 },
    );
    for (const costClass of ["free", "paid", "unknown"] as const) {
      expect(factsFor("openrouter", cred, "m", { ...opts(), costClass }), costClass).toHaveLength(1);
    }
    expect(factsFor("openrouter", cred, "m", opts())).toHaveLength(1);
    expect(cooldownUntil("openrouter", cred, "m", opts())).toBe(NOW + 1000);
  });

  it("still cost-blocks an evicting condition regardless of class", () => {
    recordFact("not-servable", { kind: "deployment", provider: "openrouter", model: "gone" }, opts());
    expect(isCostBlocked("openrouter", null, "gone", opts())).toBe(true);
    expect(isCostBlocked("openrouter", null, "gone", { ...opts(), costClass: "free" })).toBe(true);
  });
});

describe("a persisted filter is validated on load", () => {
  /**
   * Build the fixture through the real writer, then patch ONLY `costClasses` on disk.
   *
   * Hand-authoring the persisted shape means guessing the key format and satisfying `isValidFact`,
   * and a fixture that fails to load looks exactly like a filter that was correctly dropped — the
   * test would pass for the wrong reason. Writing it the way the relay writes it removes that
   * whole class of doubt.
   */
  const write = (costClasses: unknown) => {
    resetFacts();
    recordFact(
      "allowance-exhausted",
      { kind: "credential", provider: "openrouter", credentialId: cred },
      { ...opts(), retryAfterMs: 10_000 },
    );
    flushFacts({ path, now: NOW });
    const doc = JSON.parse(readFileSync(path, "utf8")) as { facts: Record<string, Record<string, unknown>> };
    const keys = Object.keys(doc.facts);
    expect(keys, "the fixture must contain exactly the one fact it wrote").toHaveLength(1);
    doc.facts[keys[0]!]!["costClasses"] = costClasses;
    writeFileSync(path, JSON.stringify(doc), "utf8");
    resetFacts();
  };

  it("drops an EMPTY filter — a filter matching nothing bounds nothing while looking like it does", () => {
    // The `configured-limits` precedent: an ignored typo that reads as a ceiling is worse than a
    // loud rejection. Dropping it restores "applies to every class".
    write([]);
    expect(factsFor("openrouter", cred, "m", opts())).toHaveLength(1);
  });

  it("drops a filter containing an unrecognised class, and does not fail the load", () => {
    // Whole filter, not just the bad entry: a partially-understood filter would silently cover a
    // different subset than the reviewer accepted.
    write(["paid", "gratis"]);
    expect(factsFor("openrouter", cred, "m", opts())).toHaveLength(1);
    expect(factsFor("openrouter", cred, "m", { ...opts(), costClass: "free" })).toHaveLength(1);
  });

  it("drops a non-array filter", () => {
    write("paid");
    expect(factsFor("openrouter", cred, "m", opts())).toHaveLength(1);
  });

  it("keeps a well-formed filter across a reload", () => {
    write(["paid"]);
    expect(factsFor("openrouter", cred, "m", { ...opts(), costClass: "paid" })).toHaveLength(1);
    expect(factsFor("openrouter", cred, "m", { ...opts(), costClass: "free" })).toEqual([]);
  });
});

describe("the vocabulary has ONE definition", () => {
  it("target-facts derives its runtime set from COST_CLASSES rather than re-listing it", async () => {
    const { readFileSync } = await import("node:fs");
    const text = readFileSync(join(__dirname, "..", "src", "target-facts.ts"), "utf8");
    expect(text).toMatch(/new Set\(COST_CLASSES\)/);
    // A hand-listed copy is the drift seam this codebase closed eight times on 2026-08-28.
    expect(text).not.toMatch(/new Set\(\["free", "paid", "unknown"\]/);
  });

  it("metadata derives CostClass from the array, not the other way round", async () => {
    const { readFileSync } = await import("node:fs");
    const text = readFileSync(join(__dirname, "..", "src", "metadata.ts"), "utf8");
    expect(text).toMatch(/export type CostClass = \(typeof COST_CLASSES\)\[number\]/);
  });
});

describe("the CLI round-trip preserves the narrowing", () => {
  it("registers --cost-class as a value flag, so its value is not read as a positional", async () => {
    // ⚠ The arity guard caught this during development, exactly as its comment predicts: "a
    // value-taking flag missing from VALUE_FLAGS puts its VALUE in command position". Before the
    // flag was registered, `--cost-class paid` failed with "takes at most 2 arguments".
    const { readFileSync } = await import("node:fs");
    const text = readFileSync(join(__dirname, "..", "src", "cli.ts"), "utf8");
    expect(text).toMatch(/"--cost-class", "-cost-class",/);
  });

  it("the suggested accept command reproduces the filter, at BOTH call sites", async () => {
    // ⚠ The trap this pins: the propose output is meant to be copy-pasted. An option the proposer
    // supplied and the accept command omits is silently WIDENED at accept time — here that would
    // commit the credential-wide verdict the flag exists to prevent. Both call sites must pass the
    // filter: the STATUS listing's call once dropped it while this grep watched only the propose
    // echo. (The rendered-output pins live in test/cli.test.ts; these greps only keep the
    // argument lists visible.)
    const { readFileSync } = await import("node:fs");
    const text = readFileSync(join(__dirname, "..", "src", "cli.ts"), "utf8");
    expect(text).toMatch(/eligibilityAcceptCommand\(pending\.indexOf\(entry\) \+ 1, entry\.signature, cls, scope, reset, costFilter\)/);
    expect(text).toMatch(/eligibilityAcceptCommand\(i \+ 1, p\.signature, p\.proposed\.class, sc, p\.proposed\.reset, p\.proposed\.costClasses\)/);
    expect(text).toMatch(/--cost-class \$\{costClasses\.join\(","\)\}/);
  });

  it("carries the filter from an accepted verdict into the recorded fact", async () => {
    // Without this the reviewer's narrowing is accepted, displayed, and then dropped on the way to
    // the store — the verdict would demote everything its scope covers.
    const { readFileSync } = await import("node:fs");
    const text = readFileSync(join(__dirname, "..", "src", "server.ts"), "utf8");
    expect(text).toMatch(/costClasses: verdict\.costClasses/);
  });
});

describe("acceptInterpretation persists the cost filter (the REAL round trip)", () => {
  // ⚠ The source-text pins above passed while acceptInterpretation silently DROPPED
  // `costClasses`: the parameter type did not declare the field, a spread into `override`
  // defeats the excess-property check, and the persisted literal copied six named fields — so
  // `--cost-class paid` accepted cleanly, persisted a verdict covering EVERY class, and the
  // 2026-08-28 closeout auditor found the operator's live store entry field-less. Only an
  // accept → flush → re-read round trip can observe that, so these read the FILE back.
  const REFUSAL_BODY = JSON.stringify({ error: { message: "key limit exceeded (weekly limit). manage it using https://example.test/keys" } });

  let storeDir: string;
  let storePath: string;

  beforeEach(async () => {
    const { resetInterpretations } = await import("../src/refusal-interpretation.js");
    resetInterpretations();
    storeDir = mkdtempSync(join(tmpdir(), "llm-relay-interp-roundtrip-"));
    storePath = join(storeDir, "refusal-interpretations.json");
  });
  afterEach(async () => {
    const { resetInterpretations } = await import("../src/refusal-interpretation.js");
    resetInterpretations();
    rmSync(storeDir, { recursive: true, force: true });
  });

  it("override.costClasses survives accept -> flush -> re-read", async () => {
    const { acceptInterpretation, flushInterpretations, recordUnknownRefusal, refusalSignature } =
      await import("../src/refusal-interpretation.js");
    recordUnknownRefusal("openrouter", "anthropic/claude-fable-5", 403, REFUSAL_BODY, { path: storePath });
    const signature = refusalSignature("openrouter", "anthropic/claude-fable-5", 403, REFUSAL_BODY);
    const accepted = acceptInterpretation(signature, {
      path: storePath,
      override: { class: "allowance-exhausted", scope: { kind: "credential" }, costClasses: ["paid"] },
    });
    expect(accepted).toBe(true);
    flushInterpretations({ path: storePath });

    const persisted = JSON.parse(readFileSync(storePath, "utf8")) as {
      confirmed: Record<string, { class: string; costClasses?: string[] }>;
    };
    expect(persisted.confirmed[signature]?.class).toBe("allowance-exhausted");
    expect(persisted.confirmed[signature]?.costClasses).toEqual(["paid"]);
  });

  it("a proposed costClasses survives propose -> accept-without-override -> re-read", async () => {
    const { acceptInterpretation, flushInterpretations, proposeInterpretation, recordUnknownRefusal, refusalSignature } =
      await import("../src/refusal-interpretation.js");
    recordUnknownRefusal("openrouter", "anthropic/claude-fable-5", 403, REFUSAL_BODY, { path: storePath });
    const signature = refusalSignature("openrouter", "anthropic/claude-fable-5", 403, REFUSAL_BODY);
    const proposed = proposeInterpretation(signature, {
      class: "allowance-exhausted",
      scope: { kind: "credential" },
      rationale: "spend limit — paid surface only",
      costClasses: ["paid"],
    }, { path: storePath });
    expect(proposed).toBe(true);
    const accepted = acceptInterpretation(signature, { path: storePath });
    expect(accepted).toBe(true);
    flushInterpretations({ path: storePath });

    const persisted = JSON.parse(readFileSync(storePath, "utf8")) as {
      confirmed: Record<string, { class: string; costClasses?: string[] }>;
    };
    expect(persisted.confirmed[signature]?.costClasses).toEqual(["paid"]);
  });
});
