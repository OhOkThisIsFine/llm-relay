import { mkdtempSync, rmSync } from "node:fs";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createAccountingRequest } from "../src/accounting.js";
import { createAccountingStore, type AccountingStore } from "../src/accounting-store.js";
import { CircuitBreaker } from "../src/circuit-breaker.js";
import { clearCooldowns } from "../src/cooldown-clear.js";
import type { Config } from "../src/config.js";
import { CONTROL_AUTHORIZATION_HEADER } from "../src/control-authorization.js";
import { makeCredentialId } from "../src/credential-id.js";
import type { ProviderTargetIdentity } from "../src/kernel/contracts.js";
import type { QuotaObservation } from "../src/quota-observation.js";
import { createProxy } from "../src/server.js";
import {
  allFacts,
  factsFor,
  recordFact,
  resetFacts,
  type FactKind,
  type FactScope,
} from "../src/target-facts.js";

const NOW = 1_000_000;
const CONTROL_TOKEN = "cooldown-clear-test-capability";
const CONTROL_HEADERS = {
  "content-type": "application/json",
  [CONTROL_AUTHORIZATION_HEADER]: CONTROL_TOKEN,
};

function proxyConfig(): Config {
  return {
    listen: "127.0.0.1:0",
    mode: "detect",
    providers: {
      p: {
        base: "https://p.example.invalid/v1",
        kind: "openai",
        authHeader: "authorization",
      },
    },
    routing: { default: "p/m", tiers: {}, pools: {}, offload: false },
    repair: { maxAttempts: 2, destructiveTools: [] },
    log: { level: "silent", file: null },
  } as unknown as Config;
}

function target(
  provider: string,
  model: string,
  credential = "default",
): ProviderTargetIdentity {
  return {
    provider,
    model,
    credentialId: makeCredentialId(provider, credential),
    kind: "openai",
    base: `https://${provider}.example.invalid`,
  };
}

function fail429(
  breaker: CircuitBreaker,
  identity: ProviderTargetIdentity,
  at = NOW,
): void {
  breaker.recordOutcome(identity, {
    ok: false,
    status: 429,
    elapsedMs: 5,
    at,
  });
}

function activeFactSignatures(path: string): string[] {
  return allFacts({ path, now: NOW + 10 }).map(
    ({ kind, scope }) => `${kind}:${scopeSignature(scope)}`,
  ).sort();
}

function scopeSignature(scope: FactScope): string {
  switch (scope.kind) {
    case "attempt":
      return `attempt:${scope.provider}:${scope.credentialId}:${scope.model}`;
    case "group":
      return `group:${scope.provider}:${scope.credentialId ?? "*"}:${scope.members.join(",")}`;
    case "deployment":
      return `deployment:${scope.provider}:${scope.model}`;
    case "credential":
      return `credential:${scope.provider}:${scope.credentialId}`;
    case "provider":
      return `provider:${scope.provider}`;
    case "model":
      return `model:${scope.model}`;
  }
}

describe("operator cooldown clearing", () => {
  let dir: string;
  let factsPath: string;
  let servers: Server[];
  let accountingStores: AccountingStore[];

  beforeEach(() => {
    resetFacts();
    dir = mkdtempSync(join(tmpdir(), "llm-relay-cooldown-clear-"));
    factsPath = join(dir, "target-facts.json");
    servers = [];
    accountingStores = [];
  });

  afterEach(async () => {
    for (const server of servers) server.closeAllConnections();
    await Promise.all(servers.map(
      (server) => new Promise<void>((resolve) => server.close(() => resolve())),
    ));
    accountingStores.forEach((store) => store.close());
    // Cancel the write-behind timer before removing its per-test directory.
    resetFacts();
    rmSync(dir, { recursive: true, force: true });
  });

  async function boot(
    breaker: CircuitBreaker,
    accounting?: AccountingStore,
  ): Promise<string> {
    const server = createProxy(proxyConfig(), {
      breaker,
      controlAuthorization: {
        validate: (candidate) => candidate === CONTROL_TOKEN,
      },
      ...(accounting === undefined
        ? {}
        : { accountingRecorder: accounting, accountingReader: accounting }),
    });
    servers.push(server);
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()));
    const { port } = server.address() as AddressInfo;
    return `http://127.0.0.1:${port}`;
  }

  it.each([
    {
      selector: "model",
      misspelledKey: "modle",
      body: { provider: "p", modle: "m-breaker" },
    },
    {
      selector: "credential",
      misspelledKey: "credentail",
      body: { provider: "p", model: "m-breaker", credentail: "work" },
    },
  ])("rejects a misspelled $selector selector without mutating seeded cooling state", async ({
    misspelledKey,
    body,
  }) => {
    const at = Date.now();
    const breaker = new CircuitBreaker();
    const breakerCell = target("p", "m-breaker", "work");
    const credentialFaultCell = target("p", "m-credential", "backup");
    fail429(breaker, breakerCell, at);
    breaker.recordCredentialFault(credentialFaultCell, 401, at);
    recordFact("rate-limited", {
      kind: "attempt",
      provider: "p",
      credentialId: makeCredentialId("p", "personal"),
      model: "m-fact",
    }, { now: at, retryAfterMs: 60_000 });

    const breakerSnapshot = () => [breakerCell, credentialFaultCell].map(
      (identity) => structuredClone(breaker.getState(identity)),
    );
    const beforeBreaker = breakerSnapshot();
    const beforeFacts = structuredClone(allFacts({ now: at + 1 }));
    const url = await boot(breaker);

    const response = await fetch(`${url}/cooldowns/clear`, {
      method: "POST",
      headers: CONTROL_HEADERS,
      body: JSON.stringify(body),
    });

    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({
      error: { message: expect.stringContaining(misspelledKey) },
    });
    expect(breakerSnapshot()).toEqual(beforeBreaker);
    expect(allFacts({ now: at + 1 })).toEqual(beforeFacts);
  });

  it.each([
    { kind: "null", body: "null" },
    { kind: "array", body: "[]" },
    { kind: "string", body: '"p"' },
    { kind: "number", body: "1" },
  ])("rejects a non-object $kind request body", async ({ body }) => {
    const url = await boot(new CircuitBreaker());
    const response = await fetch(`${url}/cooldowns/clear`, {
      method: "POST",
      headers: CONTROL_HEADERS,
      body,
    });

    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({
      error: { message: "POST /cooldowns/clear body must be a JSON object" },
    });
  });

  it("retains the seeded accounting store byte-for-byte across an HTTP clear", async () => {
    const accountingAt = "2026-08-24T12:34:56.000Z";
    const accountingNow = Date.parse(accountingAt);
    const requestId = "cooldown_accounting_request_0001";
    const attemptId = "cooldown_accounting_attempt_0001";
    const credentialId = makeCredentialId("p", "work");
    const accounting = createAccountingStore({
      rootDir: join(dir, "accounting"),
      now: () => accountingNow,
    });
    accountingStores.push(accounting);
    const request = createAccountingRequest({
      recorder: accounting,
      requestId,
      idFactory: () => attemptId,
      startedAt: accountingAt,
      client: "claude",
      attribution: "relay_held",
    });
    const attempt = request.startAttempt({
      role: "serve",
      startedAt: accountingAt,
      attribution: "relay_held",
      provider: "p",
      model: "m-accounting",
      credentialId,
    });
    attempt.complete({
      outcome: "success",
      endedAt: accountingAt,
      latencyMs: 17,
      tokens: { reported: { inputTokens: 23, outputTokens: 5 } },
    });
    expect(request.complete({ outcome: "success", endedAt: accountingAt })).toBeDefined();

    const breaker = new CircuitBreaker();
    const cooling = target("p", "m-accounting", "work");
    const breakerAt = Date.now();
    fail429(breaker, cooling, breakerAt);
    expect(breaker.getState(cooling)?.cooldownUntil).toBeGreaterThan(breakerAt);
    const url = await boot(breaker, accounting);
    const accountingSnapshot = () => JSON.stringify({
      day: accounting.readDay("2026-08-24"),
      lifetime: accounting.readLifetime(),
      recent: accounting.readRecent(),
      detail: accounting.readDetail(requestId),
      window: accounting.usedInWindow({
        credentialId,
        model: "m-accounting",
        period: "day",
        now: accountingNow,
      }),
    });
    const before = accountingSnapshot();

    const response = await fetch(`${url}/cooldowns/clear`, {
      method: "POST",
      headers: CONTROL_HEADERS,
      body: JSON.stringify({ provider: "p", model: "m-accounting", credential: "work" }),
    });

    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      target: { provider: "p", model: "m-accounting", credential: "work" },
    });
    expect(breaker.getState(cooling)?.cooldownUntil).toBe(0);
    expect(accountingSnapshot()).toBe(before);
  });

  it("clears a 429 cooldown without laundering history and restarts its ladder at two minutes", () => {
    const breaker = new CircuitBreaker();
    const cooling = target("p", "m", "work");
    const live = target("q", "m");
    fail429(breaker, cooling, NOW);
    fail429(breaker, cooling, NOW + 1);

    expect(breaker.orderByUsability([cooling, live], NOW + 2)).toEqual([
      live,
      cooling,
    ]);

    const result = clearCooldowns(
      breaker,
      { provider: "p", model: "m", credential: "work" },
      { factsPath, now: NOW + 2 },
    );

    expect(result.cleared.breakerCells).toEqual({
      count: 1,
      items: [{ provider: "p", model: "m", credential: "work" }],
    });
    expect(result.cleared.credentialFaults).toEqual({ count: 0, items: [] });
    expect(result.cleared.facts).toEqual({ count: 0, items: [] });

    const state = breaker.getState(cooling)!;
    expect(state).toMatchObject({
      cooldownUntil: 0,
      cooldownSource: null,
      unexplained429s: 0,
      consecutiveFailures: 2,
      lastFailureTime: NOW + 1,
      lastStatus: 429,
    });
    expect(state.pings).toHaveLength(2);
    expect(breaker.orderByUsability([cooling, live], NOW + 2)).toEqual([
      cooling,
      live,
    ]);

    fail429(breaker, cooling, NOW + 3);
    expect(breaker.getState(cooling)).toMatchObject({
      cooldownUntil: NOW + 3 + 120_000,
      cooldownSource: "default",
      unexplained429s: 1,
      // Clearing is an operator mutation, not a fabricated successful health sample.
      consecutiveFailures: 3,
    });
  });

  it("clears Retry-After, 402, and quota-sourced cooldowns while retaining quota evidence", () => {
    const breaker = new CircuitBreaker();
    const retryAfter = target("p", "m-retry");
    const payment = target("p", "m-payment");
    const quota = target("p", "m-quota");
    const quotaCredential = makeCredentialId("p");
    const observation: QuotaObservation = {
      axis: "requests",
      period: "minute",
      limit: 60,
      remaining: 0,
      resetsAt: NOW + 600_000,
      observedAt: NOW,
      basis: "provider-stated",
    };

    breaker.recordOutcome(retryAfter, {
      ok: false,
      status: 503,
      elapsedMs: 11,
      at: NOW,
      retryAfterMs: 30_000,
    });
    breaker.recordOutcome(payment, {
      ok: false,
      status: 402,
      elapsedMs: 12,
      at: NOW,
      retryAfterMs: 45_000,
    });
    breaker.recordOutcome(quota, {
      ok: true,
      status: 200,
      elapsedMs: 13,
      at: NOW,
      quotaObservations: [observation],
    });
    breaker.recordQuotaCooldown(quota, NOW + 600_000, NOW + 1);

    recordFact(
      "allowance-exhausted",
      {
        kind: "attempt",
        provider: "p",
        credentialId: quotaCredential,
        model: "m-quota",
      },
      { path: factsPath, now: NOW },
    );
    recordFact(
      "context-limit",
      {
        kind: "attempt",
        provider: "p",
        credentialId: quotaCredential,
        model: "m-quota",
      },
      { path: factsPath, now: NOW, value: 32_768 },
    );
    recordFact(
      "rate-limit-rpm",
      { kind: "deployment", provider: "p", model: "m-quota" },
      { path: factsPath, now: NOW, value: 60 },
    );

    expect(breaker.getState(retryAfter)?.cooldownSource).toBe("retry-after");
    expect(breaker.getState(payment)?.cooldownSource).toBe("retry-after");
    expect(breaker.getState(quota)?.cooldownSource).toBe("quota");

    const result = clearCooldowns(
      breaker,
      { provider: "p" },
      { factsPath, now: NOW + 2 },
    );

    expect(result.cleared.breakerCells.count).toBe(3);
    expect(result.cleared.breakerCells.items).toEqual([
      { provider: "p", model: "m-payment", credential: "default" },
      { provider: "p", model: "m-quota", credential: "default" },
      { provider: "p", model: "m-retry", credential: "default" },
    ]);
    expect(result.cleared.facts).toEqual({
      count: 1,
      items: [{
        kind: "allowance-exhausted",
        scope: {
          kind: "attempt",
          provider: "p",
          credentialId: quotaCredential,
          model: "m-quota",
        },
      }],
    });

    for (const identity of [retryAfter, payment, quota]) {
      expect(breaker.getState(identity)).toMatchObject({
        cooldownUntil: 0,
        cooldownSource: null,
      });
      expect(breaker.getState(identity)?.pings).toHaveLength(1);
    }
    expect(breaker.getState(quota)?.quotaObservations).toEqual([observation]);
    expect(
      factsFor("p", quotaCredential, "m-quota", {
        path: factsPath,
        now: NOW + 2,
      }).map(({ kind }) => kind),
    ).toEqual(["context-limit", "rate-limit-rpm"]);
  });

  it("clears a credential fault only in the selected credential and model cell", () => {
    const breaker = new CircuitBreaker();
    const selected = target("p", "m-a", "work");
    const otherModel = target("p", "m-b", "work");
    const otherCredential = target("p", "m-a", "personal");
    for (const identity of [selected, otherModel, otherCredential]) {
      breaker.recordCredentialFault(identity, 401, NOW);
    }

    const result = clearCooldowns(
      breaker,
      { provider: "p", model: "m-a", credential: "work" },
      { factsPath, now: NOW + 1 },
    );

    expect(result.cleared.breakerCells).toEqual({ count: 0, items: [] });
    expect(result.cleared.credentialFaults).toEqual({
      count: 1,
      items: [{ provider: "p", model: "m-a", credential: "work" }],
    });
    expect(breaker.hasCredentialFault(selected, NOW + 1)).toBe(false);
    expect(breaker.getState(selected)).toMatchObject({
      credentialFailures: 0,
      credentialFaultUntil: 0,
    });
    expect(breaker.getState(selected)?.lastCredentialStatus).toBeUndefined();
    expect(breaker.hasCredentialFault(otherModel, NOW + 1)).toBe(true);
    expect(breaker.hasCredentialFault(otherCredential, NOW + 1)).toBe(true);
  });

  it("clears only cooling facts, retaining measurements and eviction facts, and is idempotent", () => {
    const breaker = new CircuitBreaker();
    const identity = target("p", "m", "work");
    const scope: FactScope = {
      kind: "attempt",
      provider: "p",
      credentialId: makeCredentialId("p", "work"),
      model: "m",
    };
    const cooling: FactKind[] = [
      "allowance-exhausted",
      "credential-invalid",
      "rate-limited",
    ];
    const retained: FactKind[] = [
      "not-servable",
      "subscription-required",
      "context-limit",
      "rate-limit-rpm",
      "rate-limit-rpd",
      "rate-limit-tpm",
      "rate-limit-tpd",
    ];
    cooling.forEach((kind) => recordFact(kind, scope, { path: factsPath, now: NOW }));
    retained.forEach((kind, index) => recordFact(kind, scope, {
      path: factsPath,
      now: NOW,
      ...(kind.startsWith("rate-limit-") || kind === "context-limit"
        ? { value: 1_000 + index }
        : {}),
    }));
    fail429(breaker, identity, NOW);

    const first = clearCooldowns(
      breaker,
      { provider: "p", model: "m", credential: "work" },
      { factsPath, now: NOW + 1 },
    );

    expect(first.cleared.facts.count).toBe(3);
    expect(first.cleared.facts.items.map(({ kind }) => kind)).toEqual(cooling);
    expect(activeFactSignatures(factsPath)).toEqual(
      retained.map((kind) => `${kind}:${scopeSignature(scope)}`).sort(),
    );

    const second = clearCooldowns(
      breaker,
      { provider: "p", model: "m", credential: "work" },
      { factsPath, now: NOW + 2 },
    );
    expect(second.cleared).toEqual({
      breakerCells: { count: 0, items: [] },
      credentialFaults: { count: 0, items: [] },
      facts: { count: 0, items: [] },
    });
  });

  it("contains a narrow clear to matching provider, deployment, and credential dimensions", () => {
    const breaker = new CircuitBreaker();
    const selected = target("p", "m-a", "work");
    const otherModel = target("p", "m-b", "work");
    const otherCredential = target("p", "m-a", "personal");
    const otherProvider = target("q", "m-a", "work");
    for (const identity of [selected, otherModel, otherCredential, otherProvider]) {
      fail429(breaker, identity, NOW);
    }

    const work = makeCredentialId("p", "work");
    const personal = makeCredentialId("p", "personal");
    const qWork = makeCredentialId("q", "work");
    recordFact("rate-limited", {
      kind: "attempt", provider: "p", credentialId: work, model: "m-a",
    }, { path: factsPath, now: NOW });
    recordFact("allowance-exhausted", {
      kind: "deployment", provider: "p", model: "m-a",
    }, { path: factsPath, now: NOW });
    recordFact("credential-invalid", {
      kind: "credential", provider: "p", credentialId: work,
    }, { path: factsPath, now: NOW });
    recordFact("allowance-exhausted", {
      kind: "provider", provider: "p",
    }, { path: factsPath, now: NOW });
    recordFact("rate-limited", {
      kind: "group", provider: "p", credentialId: work, members: ["m-a", "m-b"],
    }, { path: factsPath, now: NOW });
    recordFact("credential-invalid", {
      kind: "group", provider: "p", members: ["m-a"],
    }, { path: factsPath, now: NOW });

    recordFact("allowance-exhausted", {
      kind: "attempt", provider: "p", credentialId: work, model: "m-b",
    }, { path: factsPath, now: NOW });
    recordFact("rate-limited", {
      kind: "attempt", provider: "p", credentialId: personal, model: "m-a",
    }, { path: factsPath, now: NOW });
    recordFact("allowance-exhausted", {
      kind: "deployment", provider: "p", model: "m-b",
    }, { path: factsPath, now: NOW });
    recordFact("credential-invalid", {
      kind: "credential", provider: "p", credentialId: personal,
    }, { path: factsPath, now: NOW });
    recordFact("rate-limited", {
      kind: "attempt", provider: "q", credentialId: qWork, model: "m-a",
    }, { path: factsPath, now: NOW });
    recordFact("rate-limited", {
      kind: "model", model: "m-a",
    }, { path: factsPath, now: NOW });

    const result = clearCooldowns(
      breaker,
      { provider: "p", model: "m-a", credential: "work" },
      { factsPath, now: NOW + 1 },
    );

    expect(result.cleared.breakerCells.items).toEqual([
      { provider: "p", model: "m-a", credential: "work" },
    ]);
    expect(result.cleared.facts).toEqual({
      count: 1,
      items: [{
        kind: "rate-limited",
        scope: { kind: "attempt", provider: "p", credentialId: work, model: "m-a" },
      }],
    });
    expect(activeFactSignatures(factsPath)).toEqual([
      `allowance-exhausted:attempt:p:${work}:m-b`,
      "allowance-exhausted:deployment:p:m-a",
      "allowance-exhausted:deployment:p:m-b",
      "allowance-exhausted:provider:p",
      `credential-invalid:credential:p:${work}`,
      `credential-invalid:credential:p:${personal}`,
      "credential-invalid:group:p:*:m-a",
      "rate-limited:model:m-a",
      `rate-limited:group:p:${work}:m-a,m-b`,
      `rate-limited:attempt:p:${personal}:m-a`,
      `rate-limited:attempt:q:${qWork}:m-a`,
    ].sort());

    expect(breaker.isHealthy(selected, NOW + 1)).toBe(true);
    expect(breaker.isHealthy(otherModel, NOW + 1)).toBe(false);
    expect(breaker.isHealthy(otherCredential, NOW + 1)).toBe(false);
    expect(breaker.isHealthy(otherProvider, NOW + 1)).toBe(false);

    const deploymentClear = clearCooldowns(
      breaker,
      { provider: "p", model: "m-a" },
      { factsPath, now: NOW + 2 },
    );
    expect(deploymentClear.cleared.facts.items).toEqual([
      {
        kind: "allowance-exhausted",
        scope: { kind: "deployment", provider: "p", model: "m-a" },
      },
      {
        kind: "credential-invalid",
        scope: { kind: "group", provider: "p", members: ["m-a"] },
      },
      {
        kind: "rate-limited",
        scope: { kind: "attempt", provider: "p", credentialId: personal, model: "m-a" },
      },
    ]);
    expect(breaker.isHealthy(otherCredential, NOW + 2)).toBe(true);

    const credentialClear = clearCooldowns(
      breaker,
      { provider: "p", credential: "work" },
      { factsPath, now: NOW + 3 },
    );
    expect(credentialClear.cleared.facts.items).toEqual([
      {
        kind: "allowance-exhausted",
        scope: { kind: "attempt", provider: "p", credentialId: work, model: "m-b" },
      },
      {
        kind: "credential-invalid",
        scope: { kind: "credential", provider: "p", credentialId: work },
      },
      {
        kind: "rate-limited",
        scope: {
          kind: "group",
          provider: "p",
          credentialId: work,
          members: ["m-a", "m-b"],
        },
      },
    ]);
    expect(breaker.isHealthy(otherModel, NOW + 3)).toBe(true);

    const providerClear = clearCooldowns(
      breaker,
      { provider: "p" },
      { factsPath, now: NOW + 4 },
    );
    expect(providerClear.cleared.facts.items).toEqual([
      {
        kind: "allowance-exhausted",
        scope: { kind: "deployment", provider: "p", model: "m-b" },
      },
      {
        kind: "allowance-exhausted",
        scope: { kind: "provider", provider: "p" },
      },
      {
        kind: "credential-invalid",
        scope: { kind: "credential", provider: "p", credentialId: personal },
      },
    ]);
    expect(activeFactSignatures(factsPath)).toEqual([
      "rate-limited:model:m-a",
      `rate-limited:attempt:q:${qWork}:m-a`,
    ].sort());
    expect(breaker.isHealthy(otherProvider, NOW + 4)).toBe(false);
  });
});
