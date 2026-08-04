import { describe, it, expect, afterAll } from "vitest";
import { writeFileSync, readFileSync, mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import {
  clientForPath,
  FRONT_DOOR_CLIENTS,
  loadConfig,
  subagentSpec,
  unroutableOffloadClient,
  type Config,
} from "../src/config.js";
import { createProxy } from "../src/server.js";
import { offloadState, setOffload } from "../src/offload.js";
import { buildCandidates } from "../src/candidates.js";
import { CircuitBreaker } from "../src/circuit-breaker.js";
import { CONTROL_AUTHORIZATION_HEADER } from "../src/control-authorization.js";
import type { ModelCatalog } from "../src/catalog.js";

const CONTROL_TOKEN = "offload-test-control-token";
const CONTROL_AUTHORIZATION = { validate: (candidate: unknown) => candidate === CONTROL_TOKEN };
const CONTROL_JSON_HEADERS = {
  "content-type": "application/json",
  [CONTROL_AUTHORIZATION_HEADER]: CONTROL_TOKEN,
};

const dir = mkdtempSync(join(tmpdir(), "rp-offload-"));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

const SUB =
  "x-anthropic-billing-header: cc_version=2.1.220.e23; cc_entrypoint=sdk-cli; cc_is_subagent=true;\nYou are a Claude agent.";

const CONFIG = {
  listen: "127.0.0.1:8791",
  providers: {
    anthropic: { base: "https://api.anthropic.com", kind: "anthropic" },
    nim: { base: "https://nim.test/v1", kind: "openai", authEnv: "NVIDIA_API_KEY" },
  },
  routing: {
    default: "anthropic",
    tiers: { opus: "anthropic", sonnet: "anthropic", haiku: "anthropic", fable: "anthropic" },
    pools: { coding: ["nim/z-ai/glm-5.2"], fast: ["nim/openai/gpt-oss-20b"] },
    subagents: { opus: "pool/coding", haiku: "pool/fast", default: "pool/coding" },
    benchmarkSort: false,
  },
  mode: "detect",
  log: { level: "silent", file: null },
};

function freshConfig(name: string, routing: Record<string, unknown> = {}): Config {
  const p = join(dir, name);
  writeFileSync(p, JSON.stringify({ ...CONFIG, routing: { ...CONFIG.routing, ...routing } }, null, 2));
  return loadConfig(p);
}

const subReq = (text: string) => ({
  system: SUB,
  messages: [{ role: "user", content: [{ type: "text", text }] }],
});

describe("offload switch", () => {
  it("reports OFF for a config that never mentions offload", () => {
    const cfg = freshConfig("a.json");
    const state = offloadState(cfg);
    expect(state.enabled).toBe(false);
    expect(state.subagents).toEqual(CONFIG.routing.subagents);
    expect(state.configPath).toBe(join(dir, "a.json"));
  });

  it("takes effect on the live config immediately — no reload", () => {
    const cfg = freshConfig("b.json");
    expect(subagentSpec(subReq("go"), "claude-opus-5", cfg)).toBeNull();

    setOffload(cfg, true);
    // Same in-memory Config object the request path holds: next request routes the new way.
    expect(subagentSpec(subReq("go"), "claude-opus-5", cfg)).toBe("pool/coding");

    setOffload(cfg, false);
    expect(subagentSpec(subReq("go"), "claude-opus-5", cfg)).toBeNull();
  });

  it("persists to the config file so the choice survives a restart", () => {
    const path = join(dir, "c.json");
    const cfg = freshConfig("c.json");
    const state = setOffload(cfg, true);

    expect(state.persisted).toBe(true);
    expect(JSON.parse(readFileSync(path, "utf8")).routing.offload).toBe(true);
    // Reloading from disk must agree — that is what "survives a restart" means.
    expect(loadConfig(path).routing.offload).toBe(true);
    expect(subagentSpec(subReq("go"), "claude-opus-5", loadConfig(path))).toBe("pool/coding");
  });

  it("rewrites ONLY routing.offload, leaving the rest of the user's file intact", () => {
    const path = join(dir, "d.json");
    const cfg = freshConfig("d.json");
    const before = JSON.parse(readFileSync(path, "utf8"));
    setOffload(cfg, true);
    const after = JSON.parse(readFileSync(path, "utf8"));

    expect(after.providers).toEqual(before.providers);
    expect(after.routing.pools).toEqual(before.routing.pools);
    expect(after.routing.subagents).toEqual(before.routing.subagents);
    expect(after.mode).toBe(before.mode);
    expect(Object.keys(after.routing)).toEqual([...Object.keys(before.routing), "offload"]);
  });

  it("still applies in memory when persistence fails, and says it did not persist", () => {
    // A Config with no sourcePath is the hand-built (test / embedded) case.
    const cfg = freshConfig("e.json");
    delete cfg.sourcePath;
    const state = setOffload(cfg, true);

    expect(state.enabled).toBe(true);
    expect(cfg.routing.offload).toBe(true);
    expect(state.persisted).toBe(false);
    expect(state.persistError).toMatch(/not loaded from a file/);
  });

  it("persists one client's enabled state and scope without changing another client", () => {
    const path = join(dir, "client.json");
    writeFileSync(path, JSON.stringify({
      ...CONFIG,
      routing: {
        ...CONFIG.routing,
        offload: {
          claude: { enabled: false, scope: "subagents" },
          codex: { enabled: false, scope: "subagents" },
        },
      },
    }, null, 2));
    const cfg = loadConfig(path);

    const state = setOffload(cfg, true, "claude", "all");
    expect(state.client).toBe("claude");
    expect(state.enabled).toBe(true);
    expect(state.scope).toBe("all");
    expect(offloadState(cfg, "codex").enabled).toBe(false);
    expect(JSON.parse(readFileSync(path, "utf8")).routing.offload).toEqual({
      claude: { enabled: true, scope: "all" },
      codex: { enabled: false, scope: "subagents" },
    });
  });
});

describe("/offload endpoint", () => {
  const servers: Server[] = [];
  afterAll(() => servers.forEach((s) => s.close()));

  const listen = async (s: Server): Promise<number> => {
    servers.push(s);
    return new Promise((resolve) => s.listen(0, "127.0.0.1", () => resolve((s.address() as AddressInfo).port)));
  };

  it("flips routing for the NEXT request, with no restart", async () => {
    // Stand-in for the Anthropic passthrough, so "offload off" is observable without network.
    const upstream = createServer((_req, res) => {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ id: "msg_1", type: "message", role: "assistant", content: [], model: "x" }));
    });
    const upPort = await listen(upstream);

    // Stand-in offload target (openai kind): hits here are the signal the subagents map applied.
    let offloadHits = 0;
    const offloadUpstream = createServer((_req, res) => {
      offloadHits++;
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({
        id: "cmpl_1",
        choices: [{ message: { role: "assistant", content: "from-offload" }, finish_reason: "stop" }],
        usage: { prompt_tokens: 1, completion_tokens: 1 },
      }));
    });
    const offloadPort = await listen(offloadUpstream);

    const path = join(dir, "endpoint.json");
    writeFileSync(
      path,
      JSON.stringify({
        listen: "127.0.0.1:8791", // the test binds port 0 explicitly; config just has to be valid
        providers: {
          anthropic: { base: `http://127.0.0.1:${upPort}`, kind: "anthropic" },
          nim: { base: `http://127.0.0.1:${offloadPort}`, kind: "openai" },
        },
        routing: {
          default: "anthropic",
          tiers: { opus: "anthropic" },
          pools: { offloaded: ["nim/test-model"] },
          subagents: { default: "pool/offloaded" },
        },
        mode: "detect",
        log: { level: "silent", file: null },
      }),
    );
    const cfg = loadConfig(path);
    const proxy = createProxy(cfg, { controlAuthorization: CONTROL_AUTHORIZATION });
    const port = await listen(proxy);

    const subagentCall = () =>
      fetch(`http://127.0.0.1:${port}/v1/messages`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          model: "claude-opus-5",
          max_tokens: 16,
          system: SUB,
          messages: [{ role: "user", content: [{ type: "text", text: "hi" }] }],
        }),
      });

    // Off (the default): the subagent goes wherever a normal request goes.
    expect((await subagentCall()).status).toBe(200);
    expect(offloadHits).toBe(0);

    const on = await fetch(`http://127.0.0.1:${port}/offload`, {
      method: "POST",
      headers: CONTROL_JSON_HEADERS,
      body: JSON.stringify({ enabled: true }),
    });
    expect(on.status).toBe(200);
    expect(((await on.json()) as { enabled: boolean }).enabled).toBe(true);

    // Same server process, same request: now routed through routing.subagents to the pool.
    const after = await subagentCall();
    expect(after.status).toBe(200);
    expect(offloadHits).toBe(1);
    expect(JSON.stringify(await after.json())).toMatch(/from-offload/);

    // …and the decision reached disk.
    expect(JSON.parse(readFileSync(path, "utf8")).routing.offload).toBe(true);

    // GET reports state without changing it.
    const get = (await (await fetch(`http://127.0.0.1:${port}/offload`)).json()) as { enabled: boolean };
    expect(get.enabled).toBe(true);
  });

  /**
   * The per-call opt-in, end-to-end. `test/config.test.ts` pins the directive's semantics at the
   * `subagentSpec` unit level; nothing pinned that the request actually LANDS on the named target,
   * which is the claim a dispatcher relies on when it believes it offloaded. Asserted from both
   * sides: the named target is hit AND the Anthropic passthrough is not, because "it offloaded"
   * and "it quietly spent primary quota" are indistinguishable from a 200 alone.
   */
  it("routes an @relay: directive to the named target with the switch OFF, and never leaks it", async () => {
    let passthroughHits = 0;
    const upstream = createServer((_req, res) => {
      passthroughHits++;
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ id: "msg_1", type: "message", role: "assistant", content: [], model: "x" }));
    });
    const upPort = await listen(upstream);

    let directedBody = "";
    const directed = createServer((req, res) => {
      const chunks: Buffer[] = [];
      req.on("data", (c: Buffer) => chunks.push(c));
      req.on("end", () => {
        directedBody = Buffer.concat(chunks).toString("utf8");
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({
          id: "cmpl_1",
          choices: [{ message: { role: "assistant", content: "from-directive" }, finish_reason: "stop" }],
          usage: { prompt_tokens: 1, completion_tokens: 1 },
        }));
      });
    });
    const directedPort = await listen(directed);

    const path = join(dir, "directive.json");
    writeFileSync(
      path,
      JSON.stringify({
        listen: "127.0.0.1:8791",
        providers: {
          anthropic: { base: `http://127.0.0.1:${upPort}`, kind: "anthropic" },
          nim: { base: `http://127.0.0.1:${directedPort}`, kind: "openai" },
        },
        // No routing.subagents at all, and offload therefore off: the directive is the ONLY
        // thing that can move this request off the passthrough.
        routing: { default: "anthropic", tiers: { opus: "anthropic" } },
        mode: "detect",
        log: { level: "silent", file: null },
      }),
    );
    const cfg = loadConfig(path);
    expect(cfg.routing.offload).toBe(false);
    const proxy = createProxy(cfg);
    const port = await listen(proxy);

    const res = await fetch(`http://127.0.0.1:${port}/v1/messages`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        model: "claude-opus-5",
        max_tokens: 16,
        system: SUB,
        messages: [{ role: "user", content: [{ type: "text", text: "@relay: nim/test-model\ntrace the callers" }] }],
      }),
    });

    expect(res.status).toBe(200);
    expect(JSON.stringify(await res.json())).toMatch(/from-directive/);
    // The dispatcher believed it offloaded — so primary quota must NOT have been spent.
    expect(passthroughHits).toBe(0);
    // …and the directive is stripped before forwarding, so the model never sees it.
    expect(directedBody).toContain("trace the callers");
    expect(directedBody).not.toContain("@relay:");
  });

  it("rejects a POST without an explicit boolean", async () => {
    const cfg = freshConfig("reject.json");
    const proxy = createProxy(cfg, { controlAuthorization: CONTROL_AUTHORIZATION });
    const port = await listen(proxy);
    const res = await fetch(`http://127.0.0.1:${port}/offload`, {
      method: "POST",
      headers: CONTROL_JSON_HEADERS,
      body: JSON.stringify({ enabled: "yes" }),
    });
    expect(res.status).toBe(400);
    expect(cfg.routing.offload).toBe(false);
  });

  it("supports targeted /offload updates with an independent scope", async () => {
    const path = join(dir, "targeted-endpoint.json");
    writeFileSync(path, JSON.stringify({
      ...CONFIG,
      routing: {
        ...CONFIG.routing,
        offload: {
          claude: { enabled: false, scope: "subagents" },
          codex: { enabled: false, scope: "subagents" },
        },
      },
    }));
    const cfg = loadConfig(path);
    const proxy = createProxy(cfg, { controlAuthorization: CONTROL_AUTHORIZATION });
    const port = await listen(proxy);

    const res = await fetch(`http://127.0.0.1:${port}/offload`, {
      method: "POST",
      headers: CONTROL_JSON_HEADERS,
      body: JSON.stringify({ client: "claude", enabled: true, scope: "all" }),
    });
    expect(res.status).toBe(200);
    expect((await res.json() as { client?: string; enabled?: boolean; scope?: string })).toMatchObject({
      client: "claude",
      enabled: true,
      scope: "all",
    });
    expect(JSON.parse(readFileSync(path, "utf8")).routing.offload.codex).toEqual({
      enabled: false,
      scope: "subagents",
    });

    const codex = await (await fetch(`http://127.0.0.1:${port}/offload?client=codex`)).json() as { enabled?: boolean };
    expect(codex.enabled).toBe(false);
  });
});

/**
 * The request path derives client names ONLY through `clientForPath` — a rule keyed anything else
 * ("claude-desktop" was the real-world case) is dead config that `offloadRule` never consults, so
 * the operator's `--scope all` silently did nothing. Same loud-failure principle as an unknown
 * pool: refuse to create such a rule, keep an already-configured one visible and togglable.
 */
describe("unroutable offload clients", () => {
  it("the valid-name set is exactly what clientForPath can produce — pinned so they cannot drift apart", () => {
    const derived = new Set([
      clientForPath("/v1/messages"),
      clientForPath("/v1/messages/count_tokens"),
      clientForPath("/v1/responses"),
      clientForPath("/responses"),
      clientForPath("/v1/chat/completions"),
      clientForPath("/chat/completions"),
      clientForPath("/anything/else"), // the fallback front door
    ]);
    expect(new Set(FRONT_DOOR_CLIENTS)).toEqual(derived);
  });

  it("every front-door name is legal, configured or not — including default", () => {
    const cfg = freshConfig("routable.json");
    for (const name of FRONT_DOOR_CLIENTS) {
      expect(unroutableOffloadClient(name, cfg)).toBeNull();
    }
  });

  it("an unknown, unconfigured name is fatal and the refusal names every valid front door", () => {
    const cfg = freshConfig("unroutable-fatal.json");
    const issue = unroutableOffloadClient("claude-desktop", cfg);
    expect(issue?.fatal).toBe(true);
    expect(issue?.message).toContain("claude-desktop");
    for (const name of FRONT_DOOR_CLIENTS) expect(issue?.message).toContain(name);
  });

  it("an already-configured unknown key stays legal but non-fatal, and status carries the warning", () => {
    const cfg = freshConfig("unroutable-warn.json", {
      offload: { "claude-desktop": { enabled: true, scope: "all" } },
    });
    const issue = unroutableOffloadClient("claude-desktop", cfg);
    expect(issue?.fatal).toBe(false);

    // State is not hidden: the rule shows exactly as configured, with the dead-rule warning on it.
    const state = offloadState(cfg, "claude-desktop");
    expect(state.enabled).toBe(true);
    expect(state.scope).toBe("all");
    expect(state.warning).toContain("no request ever consults it");
    // A routable client's targeted view stays warning-free.
    expect(offloadState(cfg, "claude").warning).toBeUndefined();
  });

  describe("POST /offload", () => {
    const servers: Server[] = [];
    afterAll(() => servers.forEach((s) => s.close()));

    const listen = async (s: Server): Promise<number> => {
      servers.push(s);
      return new Promise((resolve) => s.listen(0, "127.0.0.1", () => resolve((s.address() as AddressInfo).port)));
    };

    it("refuses (400, no write) a client no request path ever produces", async () => {
      const path = join(dir, "endpoint-unroutable.json");
      writeFileSync(path, JSON.stringify(CONFIG, null, 2));
      const cfg = loadConfig(path);
      const proxy = createProxy(cfg, { controlAuthorization: CONTROL_AUTHORIZATION });
      const port = await listen(proxy);

      const res = await fetch(`http://127.0.0.1:${port}/offload`, {
        method: "POST",
        headers: CONTROL_JSON_HEADERS,
        body: JSON.stringify({ client: "claude-desktop", enabled: true, scope: "all" }),
      });
      expect(res.status).toBe(400);
      expect(JSON.stringify(await res.json())).toContain("claude-desktop");
      // Refusal means refusal: nothing changed in memory or on disk.
      expect(cfg.routing.offload).toBe(false);
      expect(JSON.parse(readFileSync(path, "utf8")).routing.offload).toBeUndefined();
    });

    it("still toggles an already-configured dead rule OFF — state is never trapped", async () => {
      const path = join(dir, "endpoint-dead-off.json");
      writeFileSync(path, JSON.stringify({
        ...CONFIG,
        routing: {
          ...CONFIG.routing,
          offload: { "claude-desktop": { enabled: true, scope: "all" } },
        },
      }, null, 2));
      const cfg = loadConfig(path);
      const proxy = createProxy(cfg, { controlAuthorization: CONTROL_AUTHORIZATION });
      const port = await listen(proxy);

      const res = await fetch(`http://127.0.0.1:${port}/offload`, {
        method: "POST",
        headers: CONTROL_JSON_HEADERS,
        body: JSON.stringify({ client: "claude-desktop", enabled: false }),
      });
      expect(res.status).toBe(200);
      const state = (await res.json()) as { enabled: boolean; warning?: string };
      expect(state.enabled).toBe(false);
      expect(state.warning).toContain("no request ever consults it");
      expect(JSON.parse(readFileSync(path, "utf8")).routing.offload["claude-desktop"].enabled).toBe(false);
    });
  });
});

describe("candidates view", () => {
  it("hydrates a provider catalog once and uses local membership/limits for every row", async () => {
    const cfg = freshConfig("batched.json");
    let lists = 0;
    const catalog = {
      getRevision: () => 0,
      cachedModels: () => [],
      cachedLimits: () => null,
      hasCachedCatalog: () => true,
      list: async () => {
        lists++;
        return ["z-ai/glm-5.2", "openai/gpt-oss-20b"];
      },
      has: async () => { throw new Error("per-row has() must not be called"); },
      limits: async () => { throw new Error("per-row limits() must not be called"); },
    } as unknown as ModelCatalog;

    const view = await buildCandidates(cfg, { breaker: new CircuitBreaker(), catalog });
    expect(lists).toBe(1);
    expect(view.candidates.every((candidate) => candidate.listed === true)).toBe(true);
  });

  it("lists every pool member and subagent target, in config order, unranked", async () => {
    const cfg = freshConfig("f.json");
    const view = await buildCandidates(cfg, { breaker: new CircuitBreaker() });

    expect(view.candidates.map((c) => c.spec)).toEqual(["nim/z-ai/glm-5.2", "nim/openai/gpt-oss-20b"]);
    expect(view.offload_enabled).toBe(false);

    const glm = view.candidates[0]!;
    expect(glm.pools).toEqual(["coding"]);
    // pool/coding is what opus and the default tier resolve to, so both tiers land here.
    expect(glm.subagentTiers).toEqual(["opus", "default"]);
    expect(view.candidates[1]!.subagentTiers).toEqual(["haiku"]);
  });

  it("keeps raw dimensions separate and makes every derived routing component explicit", async () => {
    const cfg = freshConfig("g.json");
    const view = await buildCandidates(cfg, { breaker: new CircuitBreaker() });
    const c = view.candidates[0]!;

    // Capability, live behaviour, availability and observed traffic are distinct fields.
    expect(c).toHaveProperty("capabilityMatch");
    expect(c).toHaveProperty("health");
    expect(c).toHaveProperty("quotaPercent");
    expect(c).toHaveProperty("breaker");
    expect(c).toHaveProperty("observed");
    // Limits carry per-field provenance: a NIM row must never present another provider's
    // ceiling for the same model id as its own.
    expect(c).toHaveProperty("contextLength");
    expect(c).toHaveProperty("contextLengthSource");
    expect(c).toHaveProperty("maxOutputTokens");
    expect(c).toHaveProperty("maxOutputTokensSource");

    // Every leaderboard keeps its own field. They measure different things and disagree, so
    // collapsing them into one another would destroy the comparison the table exists for.
    expect(Object.keys(c.scores).sort()).toEqual([
      "aaAgentic", "aaCoding", "aaIntelligence",
      "aiderPassRate", "aiderWellFormed",
      "arenaRank", "arenaRating",
      "bfclIrrelevance", "bfclMultiTurn", "bfclOverall",
      "designArenaAgentsEloMean", "designArenaModelsEloMean",
    ]);

    // The ordering scalar never travels without its components, calibrated dimensions, coverage,
    // basis, and task-fit input, so an estimate cannot masquerade as direct capability evidence.
    expect(Object.keys(c.sortInputs).sort()).toEqual([
      "benchmarkTaskFit", "breakerStability", "capability", "capabilityDimensions",
      "directDimensions", "fitness", "imputedDimensions", "metadata", "operational",
      "publishedSignalCount", "rawStrength", "strength", "strengthBasis", "strengthConfidence",
      "strengthSignals",
    ]);
    expect(c).not.toHaveProperty("score");
    expect(c).not.toHaveProperty("rank");
    expect(c).not.toHaveProperty("recommendation");
  });

  it("surfaces live breaker state per target", async () => {
    const cfg = freshConfig("h.json");
    const breaker = new CircuitBreaker();
    const now = 1_000_000;
    // Mechanical migration off the deleted defaulted writers — same target, same 429, same
    // timestamp, with the elapsed time the old signature let the caller omit.
    breaker.recordOutcome("nim/z-ai/glm-5.2", { ok: false, status: 429, elapsedMs: 42, at: now });

    const view = await buildCandidates(cfg, { breaker, nowMs: now + 1000 });
    const glm = view.candidates.find((c) => c.spec === "nim/z-ai/glm-5.2")!;
    expect(glm.breaker.open).toBe(true);
    expect(glm.breaker.lastStatus).toBe(429);
    expect(glm.breaker.cooldownRemainingMs).toBeGreaterThan(0);

    const other = view.candidates.find((c) => c.spec === "nim/openai/gpt-oss-20b")!;
    expect(other.breaker.open).toBe(false);
  });

  it("filters to one provider when asked", async () => {
    const cfg = freshConfig("i.json");
    const view = await buildCandidates(cfg, { breaker: new CircuitBreaker(), provider: "nowhere" });
    expect(view.candidates).toEqual([]);
  });

  /**
   * Reference limits and prices come from the snapshot row `findTierModel` matched — and on a
   * FUZZY match that row is a similarly-named but DIFFERENT SKU. `metadataReferenceFrom` named
   * only the host ("openrouter"), so a figure borrowed from another model was indistinguishable
   * from one published for this exact id unless the reader separately correlated
   * `capabilityMatch`. The matched name travels with the attribution.
   */
  describe("reference metadata attribution", () => {
    /** A fixed two-row snapshot: `glm-5.2` matches exactly, `glm-5.2-max` is what a spec for
     *  `glm-5.2-m` (short of an exact key) falls back onto by containment. */
    const snapshot = {
      models: [],
      byNorm: [
        { norm: "glm-5.2-max", rec: { norm: "glm-5.2-max", context_length: 999_000, price_prompt: 0.000_004 } },
        { norm: "gpt-oss-20b", rec: { norm: "gpt-oss-20b", context_length: 131_072, price_prompt: 0.000_001 } },
      ],
    };

    it("names the borrowed model, not just the host, when the snapshot match was fuzzy", async () => {
      const cfg = freshConfig("j.json");
      const view = await buildCandidates(cfg, { breaker: new CircuitBreaker(), tierData: snapshot });

      const glm = view.candidates.find((c) => c.spec === "nim/z-ai/glm-5.2")!;
      expect(glm.capabilityMatch).toEqual({ name: "glm-5.2-max", match: "fuzzy" });
      // NIM publishes no limits, so the figure is a reference — and it is a DIFFERENT SKU's.
      expect(glm.contextLengthSource).toBe("reference");
      expect(glm.metadataReferenceFrom).toBe("openrouter:glm-5.2-max");
    });

    it("names only the host when the match was exact — same id, other deployment", async () => {
      const cfg = freshConfig("k.json");
      const view = await buildCandidates(cfg, { breaker: new CircuitBreaker(), tierData: snapshot });

      const oss = view.candidates.find((c) => c.spec === "nim/openai/gpt-oss-20b")!;
      expect(oss.capabilityMatch).toEqual({ name: "gpt-oss-20b", match: "exact" });
      expect(oss.metadataReferenceFrom).toBe("openrouter");
    });
  });
});

describe("freeOnly offload guard", () => {
  const servers: Server[] = [];
  afterAll(() => servers.forEach((s) => s.close()));

  const listen = async (s: Server): Promise<number> => {
    servers.push(s);
    return new Promise((resolve) => s.listen(0, "127.0.0.1", () => resolve((s.address() as AddressInfo).port)));
  };

  const OPENAI_OK = (marker: string) =>
    JSON.stringify({
      id: "cmpl_1",
      choices: [{ message: { role: "assistant", content: marker }, finish_reason: "stop" }],
      usage: { prompt_tokens: 1, completion_tokens: 1 },
    });

  const counting = async (marker: string): Promise<{ port: number; calls: () => number }> => {
    let n = 0;
    const s = createServer((_req, res) => {
      n++;
      res.writeHead(200, { "content-type": "application/json" });
      res.end(OPENAI_OK(marker));
    });
    const port = await listen(s);
    return { port, calls: () => n };
  };

  /**
   * A pool listing a paid-looking member FIRST and a free one second, benchmarkSort off so
   * config order is preserved — if the free one answers, the guard filtered, not luck.
   * "paidp" declares no tierType and the test catalog has no prices, so it assesses `unknown`
   * — which the guard must treat as paid (a guess must not spend money).
   */
  async function guardSetup(name: string, opts: { offload: unknown; pool?: string[] }) {
    const paid = await counting("from-paid");
    const free = await counting("from-free");
    const path = join(dir, name);
    writeFileSync(
      path,
      JSON.stringify({
        listen: "127.0.0.1:8791",
        providers: {
          anthropic: { base: "https://api.anthropic.com", kind: "anthropic" },
          paidp: { base: `http://127.0.0.1:${paid.port}`, kind: "openai" },
          freep: { base: `http://127.0.0.1:${free.port}`, kind: "openai", tierType: "free" },
        },
        routing: {
          default: "anthropic",
          tiers: { opus: "anthropic" },
          benchmarkSort: false,
          pools: { offloaded: opts.pool ?? ["paidp/model-x", "freep/model-y"] },
          subagents: { default: "pool/offloaded" },
          offload: opts.offload,
        },
        mode: "detect",
        log: { level: "silent", file: null },
      }),
    );
    const cfg = loadConfig(path);
    const proxy = createProxy(cfg, { controlAuthorization: CONTROL_AUTHORIZATION });
    const port = await listen(proxy);
    return { paid, free, port, cfg };
  }

  const subagentCall = (port: number, system = SUB) =>
    fetch(`http://127.0.0.1:${port}/v1/messages`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        model: "claude-opus-5",
        max_tokens: 32,
        system,
        messages: [{ role: "user", content: [{ type: "text", text: "go" }] }],
      }),
    });

  it("filters offloaded traffic to free-assessed candidates only", async () => {
    const { paid, free, port } = await guardSetup("freeonly-filter.json", {
      offload: { claude: { enabled: true, scope: "subagents", freeOnly: true } },
    });
    const resp = await subagentCall(port);
    expect(resp.status).toBe(200);
    const body = (await resp.json()) as { content: Array<{ text?: string }> };
    expect(JSON.stringify(body)).toContain("from-free");
    expect(paid.calls()).toBe(0); // never egressed to the unknown-cost member
    expect(free.calls()).toBe(1);
  });

  it("refuses loudly — clean 503, zero egress — when nothing free resolves", async () => {
    const { paid, free, port } = await guardSetup("freeonly-refuse.json", {
      offload: { claude: { enabled: true, scope: "subagents", freeOnly: true } },
      pool: ["paidp/model-x"],
    });
    const resp = await subagentCall(port);
    expect(resp.status).toBe(503);
    const body = (await resp.json()) as { error: { message: string } };
    expect(body.error.message).toContain("freeOnly");
    expect(body.error.message).toContain("paidp/model-x");
    expect(paid.calls()).toBe(0); // refusal means NO request went anywhere
    expect(free.calls()).toBe(0);
  });

  it("a per-call @relay: directive cannot outrank the owner's freeOnly flag", async () => {
    // Rule disabled: only the directive reroutes. The flag still binds — it is the owner's
    // standing "this lane never spends money", and a subagent prompt must not override it.
    const { paid, port } = await guardSetup("freeonly-directive.json", {
      offload: { claude: { enabled: false, scope: "subagents", freeOnly: true } },
    });
    const resp = await fetch(`http://127.0.0.1:${port}/v1/messages`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        model: "claude-opus-5",
        max_tokens: 32,
        system: SUB,
        messages: [{ role: "user", content: [{ type: "text", text: "@relay: paidp/model-x\ngo" }] }],
      }),
    });
    expect(resp.status).toBe(503);
    expect(paid.calls()).toBe(0);
  });

  it("without freeOnly, the same pool serves its first (unknown-cost) member — the guard is opt-in", async () => {
    const { paid, free, port } = await guardSetup("freeonly-off.json", {
      offload: { claude: { enabled: true, scope: "subagents" } },
    });
    const resp = await subagentCall(port);
    expect(resp.status).toBe(200);
    expect(paid.calls()).toBe(1);
    expect(free.calls()).toBe(0);
  });

  it("setOffload toggles do not strip freeOnly from the rule", async () => {
    const { cfg } = await guardSetup("freeonly-preserve.json", {
      offload: { claude: { enabled: true, scope: "subagents", freeOnly: true } },
    });
    setOffload(cfg, false, "claude");
    setOffload(cfg, true, "claude");
    const rules = offloadState(cfg, "claude").clients;
    expect(rules["claude"]).toEqual({ enabled: true, scope: "subagents", freeOnly: true });
  });
});
