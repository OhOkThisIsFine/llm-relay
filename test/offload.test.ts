import { describe, it, expect, afterAll } from "vitest";
import { writeFileSync, readFileSync, mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { loadConfig, subagentSpec, type Config } from "../src/config.js";
import { createProxy } from "../src/server.js";
import { offloadState, setOffload } from "../src/offload.js";
import { buildCandidates } from "../src/candidates.js";
import { CircuitBreaker } from "../src/circuit-breaker.js";

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

    const path = join(dir, "endpoint.json");
    writeFileSync(
      path,
      JSON.stringify({
        listen: "127.0.0.1:8791", // the test binds port 0 explicitly; config just has to be valid
        providers: { anthropic: { base: `http://127.0.0.1:${upPort}`, kind: "anthropic" } },
        routing: {
          default: "anthropic",
          tiers: { opus: "anthropic" },
          // Deliberately unresolvable: if the map is consulted at all, it is a loud 400 —
          // which is exactly the signal that offload switched on.
          subagents: { default: "pool/does-not-exist" },
        },
        mode: "detect",
        log: { level: "silent", file: null },
      }),
    );
    const cfg = loadConfig(path);
    const proxy = createProxy(cfg);
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

    const on = await fetch(`http://127.0.0.1:${port}/offload`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ enabled: true }),
    });
    expect(on.status).toBe(200);
    expect((await on.json()).enabled).toBe(true);

    // Same server process, same request: now routed through routing.subagents.
    const after = await subagentCall();
    expect(after.status).toBe(400);
    expect(JSON.stringify(await after.json())).toMatch(/does-not-exist/);

    // …and the decision reached disk.
    expect(JSON.parse(readFileSync(path, "utf8")).routing.offload).toBe(true);

    // GET reports state without changing it.
    const get = (await (await fetch(`http://127.0.0.1:${port}/offload`)).json()) as { enabled: boolean };
    expect(get.enabled).toBe(true);
  });

  it("rejects a POST without an explicit boolean", async () => {
    const cfg = freshConfig("reject.json");
    const proxy = createProxy(cfg);
    const port = await listen(proxy);
    const res = await fetch(`http://127.0.0.1:${port}/offload`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ enabled: "yes" }),
    });
    expect(res.status).toBe(400);
    expect(cfg.routing.offload).toBe(false);
  });
});

describe("candidates view", () => {
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

  it("keeps the dimensions separate — no blended score stands in for them", async () => {
    const cfg = freshConfig("g.json");
    const view = await buildCandidates(cfg, { breaker: new CircuitBreaker() });
    const c = view.candidates[0]!;

    // Capability, live behaviour, availability and observed traffic are distinct fields.
    expect(c).toHaveProperty("capability");
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

    // Exactly one scalar exists, because pool ordering needs one — and it never travels without
    // the basis and signal list that say how much to trust it.
    expect(Object.keys(c.sortInputs).sort()).toEqual([
      "breakerStability", "strength", "strengthBasis", "strengthSignals",
    ]);
    expect(c).not.toHaveProperty("score");
    expect(c).not.toHaveProperty("rank");
    expect(c).not.toHaveProperty("recommendation");
  });

  it("surfaces live breaker state per target", async () => {
    const cfg = freshConfig("h.json");
    const breaker = new CircuitBreaker();
    const now = 1_000_000;
    breaker.recordFailure("nim/z-ai/glm-5.2", 429, now);

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
});
