/**
 * Pins the validation ORDER of `parseRouting` in `src/config/routing-parser.ts`.
 *
 * `parseRouting` validates its sub-blocks in a fixed SEQUENCE. Which error an operator
 * sees for a config holding two mistakes depends on that sequence, and no existing test
 * observes it. This test pins the sequence BEFORE the split, so that a reordering of any
 * two checks fails the suite. Every message string is copied from the source.
 *
 * A maintainer who reorders the source on purpose MUST reorder the CHECKS array in the
 * same commit. The table order IS the source order.
 */

import { describe, expect, it } from "vitest";
import { parseRouting } from "../../src/config/routing-parser.js";
import type { ProviderConfig } from "../../src/config-types.js";

function provider(): ProviderConfig {
  return { base: "http://127.0.0.1:1", kind: "openai", authHeader: "authorization", timeoutMs: 1000 };
}

function providers(): Record<string, ProviderConfig> {
  return { alive: provider() };
}

function raw(): Record<string, unknown> {
  return {
    default: ["alive/m"],
    tiers: { t: "alive/m" },
    pools: { p1: ["alive/m"], p2: ["alive/m"] }, // p1 is declared BEFORE p2 — insertion order is part of the pin
    subagents: { s: "alive/m" },
    ladder: [{ id: "r1", kind: "relay", spec: "alive/m" }],
    ladders: {
      t1: [{ id: "r1", kind: "relay", spec: "alive/m" }], // t1 BEFORE t2
      t2: [{ id: "r1", kind: "relay", spec: "alive/m" }],
    },
  };
}

/**
 * Put pool `key` into its object-policy form (if it is still the array form) and return that
 * policy object, so a row can set ONE field on it. Several rows on the same pool must be
 * combinable in one config — preferred, include, exclude and effort can all be wrong at once —
 * which is why a row merges into the existing object instead of replacing it.
 */
function policy(raw: Record<string, unknown>, key: string): Record<string, unknown> {
  const pools = raw.pools as Record<string, unknown>;
  if (!pools[key] || typeof pools[key] !== "object" || Array.isArray(pools[key])) {
    pools[key] = { preferred: ["alive/m"], include: "free" };
  }
  return pools[key] as Record<string, unknown>;
}

interface CheckRow {
  id: string;
  apply: (raw: Record<string, unknown>, providers: Record<string, ProviderConfig>) => void;
  message: string;
  conflicts: string[];
}

const CHECKS: CheckRow[] = [
  {
    id: "reserved-pool",
    apply: (raw, providers) => {
      providers.pool = provider();
    },
    message: `config.providers."pool" is reserved — it would shadow "pool/<name>" routing`,
    conflicts: [],
  },
  {
    id: "reserved-auto",
    apply: (raw, providers) => {
      providers.auto = provider();
    },
    message: `config.providers."auto" is reserved — it would shadow "auto" routing`,
    conflicts: [],
  },
  {
    id: "default-empty-array",
    apply: (raw) => {
      raw.default = [42];
    },
    message: `config.routing.default array must contain at least one valid spec string`,
    conflicts: ["default-missing", "default-unknown"],
  },
  {
    id: "default-missing",
    apply: (raw) => {
      delete raw.default;
    },
    message: `config.routing.default ("provider/model") is required`,
    conflicts: ["default-empty-array", "default-unknown"],
  },
  {
    id: "pool-p1-preferred",
    apply: (raw) => {
      const p1 = policy(raw, "p1");
      p1.preferred = "x";
    },
    message: `config.routing.pools.p1.preferred must be an array of non-empty "provider/model" specs`,
    conflicts: ["pool-p1-scalar", "pool-p1-empty", "pool-p1-nested"],
  },
  {
    id: "pool-p1-include",
    apply: (raw) => {
      const p1 = policy(raw, "p1");
      p1.include = "paid";
    },
    message: `config.routing.pools.p1.include must be "free"`,
    conflicts: ["pool-p1-scalar", "pool-p1-empty"],
  },
  {
    id: "pool-p1-exclude",
    apply: (raw) => {
      const p1 = policy(raw, "p1");
      p1.exclude = "x";
    },
    message: `config.routing.pools.p1.exclude must be an array of "provider/model" specs`,
    conflicts: ["pool-p1-scalar", "pool-p1-empty"],
  },
  {
    id: "pool-p1-effort",
    apply: (raw) => {
      const p1 = policy(raw, "p1");
      p1.effort = "ultra";
    },
    message: `config.routing.pools.p1.effort must be low, medium, high, or xhigh`,
    conflicts: ["pool-p1-scalar", "pool-p1-empty"],
  },
  {
    id: "pool-p1-scalar",
    apply: (raw) => {
      const pools = raw.pools as Record<string, unknown>;
      pools.p1 = 42;
    },
    message: `config.routing.pools.p1 must be an array of specs or {"preferred":[...],"include":"free"}`,
    conflicts: ["pool-p1-preferred", "pool-p1-include", "pool-p1-exclude", "pool-p1-effort", "pool-p1-empty", "pool-p1-nested"],
  },
  {
    id: "pool-p1-empty",
    apply: (raw) => {
      const pools = raw.pools as Record<string, unknown>;
      pools.p1 = [];
    },
    message: `config.routing.pools.p1 must contain at least one valid spec string`,
    conflicts: ["pool-p1-preferred", "pool-p1-include", "pool-p1-exclude", "pool-p1-effort", "pool-p1-scalar", "pool-p1-nested"],
  },
  {
    id: "pool-p1-nested",
    apply: (raw) => {
      const p1 = policy(raw, "p1");
      p1.preferred = ["pool/p2"];
    },
    message: `config.routing.pools.p1 member "pool/p2" — a pool cannot reference another pool`,
    conflicts: ["pool-p1-preferred", "pool-p1-scalar", "pool-p1-empty"],
  },
  {
    id: "pool-p2-preferred",
    apply: (raw) => {
      (raw.pools as Record<string, unknown>).p2 = { preferred: "x", include: "free" };
    },
    message: `config.routing.pools.p2.preferred must be an array of non-empty "provider/model" specs`,
    conflicts: ["pools-unknown"],
  },
  {
    id: "offload",
    apply: (raw) => {
      raw.offload = 42;
    },
    message: `config.routing.offload must be a boolean or an object keyed by client`,
    conflicts: [],
  },
  {
    id: "sticky",
    apply: (raw) => {
      raw.sticky = 42;
    },
    message: `config.routing.sticky must be a boolean or an object`,
    conflicts: [],
  },
  {
    id: "quota",
    apply: (raw) => {
      raw.quota = 42;
    },
    message: `config.routing.quota must be an object`,
    conflicts: [],
  },
  {
    id: "latency",
    apply: (raw) => {
      raw.latency = 42;
    },
    message: `config.routing.latency must be an object or a boolean`,
    conflicts: [],
  },
  {
    id: "hedge",
    apply: (raw) => {
      raw.hedge = 42;
    },
    message: `config.routing.hedge must be an object or a boolean`,
    conflicts: [],
  },
  {
    id: "probation",
    apply: (raw) => {
      raw.probation = 42;
    },
    message: `config.routing.probation must be an object or a boolean`,
    conflicts: [],
  },
  {
    id: "crawl",
    apply: (raw) => {
      raw.crawl = 42;
    },
    message: `config.routing.crawl must be an object or a boolean`,
    conflicts: [],
  },
  {
    id: "laneProbe",
    apply: (raw) => {
      raw.laneProbe = 42;
    },
    message: `config.routing.laneProbe must be a boolean or an object`,
    conflicts: [],
  },
  {
    id: "dispatchWalk",
    apply: (raw) => {
      raw.dispatchWalk = 42;
    },
    message: `config.routing.dispatchWalk must be a boolean or an object`,
    conflicts: [],
  },
  {
    id: "mcp",
    apply: (raw) => {
      raw.mcp = 42;
    },
    message: `config.routing.mcp must be an object`,
    conflicts: [],
  },
  {
    id: "ladder-shape",
    apply: (raw) => {
      raw.ladder = 42;
    },
    message: `config.routing.ladder must be an array of rungs`,
    conflicts: ["ladder-unknown"],
  },
  {
    id: "ladders-shape",
    apply: (raw) => {
      raw.ladders = 42;
    },
    message: `config.routing.ladders must be an object of named ladder arrays`,
    conflicts: ["ladders-t1-empty", "ladders-t2-shape", "ladders-unknown"],
  },
  {
    id: "ladders-t1-empty",
    apply: (raw) => {
      (raw.ladders as Record<string, unknown>).t1 = [];
    },
    message: `config.routing.ladders.t1 must contain at least one rung`,
    conflicts: ["ladders-shape", "ladders-unknown"],
  },
  {
    id: "ladders-t2-shape",
    apply: (raw) => {
      (raw.ladders as Record<string, unknown>).t2 = 42;
    },
    message: `config.routing.ladders.t2 must be an array of rungs`,
    conflicts: ["ladders-shape"],
  },
  {
    id: "cliLane",
    apply: (raw) => {
      raw.cliLane = 42;
    },
    message: `config.routing.cliLane must be an object`,
    conflicts: [],
  },
  {
    id: "default-unknown",
    apply: (raw) => {
      raw.default = ["nope/m"];
    },
    message: `config.routing.default "nope/m" names unknown provider "nope"`,
    conflicts: ["default-empty-array", "default-missing"],
  },
  {
    id: "tiers-unknown",
    apply: (raw) => {
      (raw.tiers as Record<string, unknown>).t = "nope/m";
    },
    message: `config.routing.tiers.t "nope/m" names unknown provider "nope"`,
    conflicts: [],
  },
  {
    id: "pools-unknown",
    apply: (raw) => {
      (raw.pools as Record<string, unknown>).p2 = ["nope/m"];
    },
    message: `config.routing.pools.p2 "nope/m" names unknown provider "nope"`,
    conflicts: ["pool-p2-preferred"],
  },
  {
    id: "subagents-unknown",
    apply: (raw) => {
      (raw.subagents as Record<string, unknown>).s = "nope/m";
    },
    message: `config.routing.subagents.s "nope/m" names unknown provider "nope"`,
    conflicts: [],
  },
  {
    id: "ladder-unknown",
    apply: (raw) => {
      raw.ladder = [{ id: "r1", kind: "relay", spec: "nope/m" }];
    },
    message: `config.routing.ladder[r1].spec "nope/m" names unknown provider "nope"`,
    conflicts: ["ladder-shape"],
  },
  {
    id: "ladders-unknown",
    apply: (raw) => {
      (raw.ladders as Record<string, unknown>).t1 = [{ id: "r1", kind: "relay", spec: "nope/m" }];
    },
    message: `config.routing.ladders.t1[r1].spec "nope/m" names unknown provider "nope"`,
    conflicts: ["ladders-shape", "ladders-t1-empty"],
  },
];

describe("parseRouting validation order", () => {
  // 1. base is valid
  it("base fixture does not throw", () => {
    const warnings: string[] = [];
    const disabled = new Set<string>();
    expect(() =>
      parseRouting(raw(), providers(), undefined, warnings, disabled),
    ).not.toThrow();
  });

  // 2. each check alone produces exactly its own message
  for (const row of CHECKS) {
    it(`check alone: ${row.id} produces its exact message`, () => {
      const r = raw();
      const p = providers();
      const warnings: string[] = [];
      const disabled = new Set<string>();
      row.apply(r, p);
      try {
        parseRouting(r, p, undefined, warnings, disabled);
        throw new Error(`expected ${row.id} to throw`);
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        expect(msg, row.id).toBe(row.message);
      }
    });
  }

  // 3. the order is the table order — every ordered pair (i, j) with i < j where
  // neither row lists the other in conflicts
  let pairCount = 0;
  for (const [i, a] of CHECKS.entries()) {
    for (const b of CHECKS.slice(i + 1)) {
      if (a.conflicts.includes(b.id) || b.conflicts.includes(a.id)) {
        continue;
      }
      pairCount++;
      it(`order: ${a.id} before ${b.id}`, () => {
        const r = raw();
        const p = providers();
        const warnings: string[] = [];
        const disabled = new Set<string>();
        a.apply(r, p);
        b.apply(r, p);
        try {
          parseRouting(r, p, undefined, warnings, disabled);
          throw new Error(`expected ${a.id} to throw before ${b.id}`);
        } catch (e) {
          const msg = e instanceof Error ? e.message : String(e);
          expect(msg, `${a.id} before ${b.id}`).toBe(a.message);
        }
      });
    }
  }

  // Assert at least 300 pairs were exercised
  it(`pair coverage: at least 300 ordered pairs exercised (actual: ${pairCount})`, () => {
    expect(pairCount).toBeGreaterThanOrEqual(300);
  });

  // 4. the degradation and warning ORDER
  it("degradation and warning order with disabledProviders", () => {
    const disabledProviders = new Set(["dead"]);
    const r: Record<string, unknown> = {
      default: ["dead/m", "alive/m"],
      tiers: { t: ["dead/m", "alive/m"] },
      pools: { p1: ["dead/m", "alive/m"] },
      subagents: { s: "dead/m" },
      ladder: [
        { id: "r1", kind: "relay", spec: "dead/m" },
        { id: "r2", kind: "relay", spec: "alive/m" },
      ],
      ladders: {
        t1: [
          { id: "r1", kind: "relay", spec: "dead/m" },
          { id: "r2", kind: "relay", spec: "alive/m" },
        ],
      },
    };
    const warnings: string[] = [];
    const p = providers();
    const routing = parseRouting(r, p, undefined, warnings, disabledProviders);

    expect(warnings).toEqual([
      `routing.pools.p1: dropped "dead/m" — provider "dead" is disabled`,
      `config.routing.tiers.t: dropped "dead/m" — provider "dead" is disabled. That routing now falls through to routing.default, which for a passthrough default means primary quota.`,
      `config.routing.subagents.s: dropped "dead/m" — provider "dead" is disabled. That routing now falls through to routing.default, which for a passthrough default means primary quota.`,
      `config.routing.default: dropped "dead/m" — provider "dead" is disabled. That routing now falls through to routing.default, which for a passthrough default means primary quota.`,
      `config.routing.ladder[r1].spec: dropped "dead/m" — provider "dead" is disabled. That routing now falls through to routing.default, which for a passthrough default means primary quota.`,
      `config.routing.ladders.t1[r1].spec: dropped "dead/m" — provider "dead" is disabled. That routing now falls through to routing.default, which for a passthrough default means primary quota.`,
    ]);

    expect(routing.default).toEqual(["alive/m"]);
    expect(routing.tiers.t).toEqual(["alive/m"]);
    expect(routing.pools?.p1).toEqual(["alive/m"]);
    expect(routing.subagents).toEqual({});
    expect(routing.ladder).toHaveLength(1);
    expect(routing.ladder?.[0]?.id).toBe("r2");
    expect(routing.ladders?.t1).toHaveLength(1);
    expect(routing.ladders?.t1?.[0]?.id).toBe("r2");
  });

  // 5. a single-spec default naming a disabled provider is fatal, and names the cause
  it("single-spec default naming a disabled provider throws with exact message", () => {
    const disabledProviders = new Set(["dead"]);
    const r = raw();
    r.default = "dead/m";
    const warnings: string[] = [];
    const p = providers();
    try {
      parseRouting(r, p, undefined, warnings, disabledProviders);
      throw new Error("expected to throw");
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      expect(msg).toBe(
        `config.routing.default "dead/m" names provider "dead", which is DISABLED because its base references an unset \${ENV} (see the warning above). Set the variable, or point routing.default somewhere else.`,
      );
    }
  });
});