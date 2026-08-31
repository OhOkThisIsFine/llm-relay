import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { runCostCommand, type CostCommandDependencies } from "../src/cli.js";
import {
  assertCostReportV1,
  DASHBOARD_COST_SCHEMA,
  type CostBy,
  type CostReportV1,
} from "../src/dashboard-contract.js";
import { createAccountingStore } from "../src/accounting-store.js";
import { createAccountingRequest, type AccountingPricePort, type AccountingRecorder } from "../src/accounting.js";
import type { TokenFactsInput } from "../src/accounting.js";

/**
 * `llm-relay cost` (open-decisions C1). The CLI verb is exercised against a REAL temp
 * store seeded through the accounting recorder — the same pattern as
 * test/dashboard/snapshot.test.ts — so the read-only store construction, the projector's
 * window plan and the renderer are covered end-to-end rather than mocked.
 */
describe("llm-relay cost CLI", () => {
  const directories: string[] = [];
  const NOW = "2026-08-20T12:34:56.000Z";
  // The 24h window plan floors `to` to a 15-minute boundary, so records must sit
  // STRICTLY before it: seed everything 5 minutes before the clock.
  const AT = "2026-08-20T12:29:56.000Z";
  let nextRequestId = 0;

  function tempUsageDir(): string {
    const directory = mkdtempSync(join(tmpdir(), "llm-relay-cost-cli-"));
    directories.push(directory);
    return directory;
  }

  afterEach(() => {
    for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true });
  });

  interface SeedAttempt {
    readonly role: "serve" | "repair";
    readonly provider: string;
    readonly model: string;
    readonly credentialId: string;
    readonly tokens?: TokenFactsInput;
    /** The relay abandoned this serve attempt — a hedge loser (D3). */
    readonly abandonedByRelay?: boolean;
  }

  /**
   * Seed one completed request into the temp store and flush it via close() (the same
   * durability boundary the proxy relies on at shutdown), releasing the writer lease so
   * the CLI's separate read-only store can open the same files.
   */
  function seed(
    usageDir: string,
    options: {
      readonly client?: string | null;
      /** Published-price lookup; absent ⇒ unpriced request. */
      readonly pricePort?: AccountingPricePort | undefined;
      readonly attempts: readonly SeedAttempt[];
    },
  ): void {
    const store = createAccountingStore({ rootDir: usageDir });
    const recorder: AccountingRecorder = { record: (event) => store.record(event) };
    nextRequestId += 1;
    const requestId = `cost_request_${nextRequestId.toString().padStart(8, "0")}`;
    let nextAttemptId = 0;
    const request = createAccountingRequest({
      recorder,
      idFactory: (() => {
        nextAttemptId += 1;
        return `cost_attempt_${nextRequestId.toString().padStart(6, "0")}_${nextAttemptId.toString().padStart(4, "0")}`;
      }) as () => string,
      requestId,
      startedAt: AT,
      client: options.client ?? "claude",
      attribution: "relay_held",
      ...(options.pricePort === undefined ? {} : { pricePort: options.pricePort }),
    });
    for (const plan of options.attempts) {
      const attempt = request.startAttempt({
        role: plan.role,
        startedAt: AT,
        attribution: "relay_held",
        provider: plan.provider,
        model: plan.model,
        credentialId: plan.credentialId,
      });
      // The relay marks the winning serve attempt as committed before responding;
      // without this the commit metric reads unknown and coverage degrades to partial.
      // An abandoned loser never commits — nothing of it reached the caller.
      if (plan.role === "serve" && plan.abandonedByRelay !== true) attempt.markCommitted({ commitMs: 5 });
      attempt.complete({
        outcome: plan.abandonedByRelay === true ? "cancelled" : "success",
        ...(plan.abandonedByRelay === true ? { failureKind: "aborted" as const, abandonedByRelay: true } : {}),
        endedAt: AT,
        latencyMs: 20,
        ...(plan.tokens === undefined ? {} : { tokens: plan.tokens }),
      });
    }
    request.complete({ outcome: "success", endedAt: AT, latencyMs: 20 });
    const flushed = store.close();
    if (flushed.retryable || flushed.status === "failed") throw new Error(`seed close failed: ${JSON.stringify(flushed)}`);
  }

  interface RunResult {
    readonly output: string;
    readonly exitCode: number | null;
  }

  /** Drive `runCostCommand` with argv + injected output/exit, mirroring main()'s wiring. */
  async function runCost(argv: readonly string[], usageDir: string): Promise<RunResult> {
    const originalArgv = process.argv;
    process.argv = ["node", "cli.js", "cost", ...argv];
    let output = "";
    let exitCode: number | null = null;
    const dependencies: CostCommandDependencies = {
      write: (message) => {
        output += message;
      },
      exit: (code) => {
        exitCode = code;
        // Mirror process.exit semantics: stop the command where it stands.
        throw new Error("__exit__");
      },
      usageDir,
      now: () => Date.parse(NOW),
    };
    try {
      await runCostCommand(dependencies);
    } catch (error) {
      if ((error as Error).message !== "__exit__") throw error;
    } finally {
      process.argv = originalArgv;
    }
    return { output, exitCode };
  }

  function parseJsonReport(output: string): CostReportV1 {
    const value: unknown = JSON.parse(output);
    assertCostReportV1(value);
    return value;
  }

  const PUBLISHED_PRICE: AccountingPricePort = () => ({
    pricePerMillionIn: 1,
    pricePerMillionOut: 2,
    priceSource: "provider",
  });

  it("renders a default provider roll-up with four labelled cells and the provenance footer", async () => {
    const usageDir = tempUsageDir();
    seed(usageDir, {
      pricePort: PUBLISHED_PRICE,
      attempts: [{ role: "serve", provider: "nim", model: "z-ai/glm-5.2", credentialId: "nim#primary", tokens: { reported: { inputTokens: 1000, outputTokens: 500 } } }],
    });
    const { output, exitCode } = await runCost([], usageDir);
    expect(exitCode).toBeNull();
    expect(output).toContain("llm-relay cost");
    // Default window matches the dashboard SPA's default (api.ts defaultFilters.window).
    expect(output).toContain("24h");
    expect(output).toContain("nim");
    expect(output).toContain("(published, reported)");
    // The single-figure total must name its basis.
    expect(output).toContain("TOTAL");
    // Provenance footer: cache kinds unpriced, lower-bound statement, repair exclusion.
    expect(output).toContain("LOWER BOUND");
    expect(output).toContain("--include-repair was given");
    // Lag note present because a live relay holds unflushed deltas.
    expect(output).toContain("may lag until then");
  });

  /**
   * The window NAME is not the period. `rollingPlan` floors `to` by the window's bucket, so the
   * newest partial bucket is outside every rolling window — 15 minutes for `24h`, an hour for
   * `7d`, SIX HOURS for `30d` — and until 2026-08-31 the table printed only the name, so the
   * shortfall was invisible on a spend surface. Measured against a live store that day: one
   * request at 06:23Z was reported under `1h` and reported as ZERO under `24h`, `7d` and `30d`.
   *
   * ⚠ This fixture already sits in the gap by construction: the clock is 12:34:56 and the 24h
   * window ends at 12:30:00, so the assertion below is exercising the real boundary rather than a
   * contrived one.
   */
  it("states the period it actually covers, and how far behind the clock the window ends", async () => {
    const usageDir = tempUsageDir();
    seed(usageDir, {
      pricePort: PUBLISHED_PRICE,
      attempts: [{ role: "serve", provider: "nim", model: "z-ai/glm-5.2", credentialId: "nim#primary", tokens: { reported: { inputTokens: 1000, outputTokens: 500 } } }],
    });
    const { output } = await runCost([], usageDir);
    // Both bounds, so a reader can tell what was counted without reaching for --json.
    expect(output).toContain("Covering 2026-08-19T12:30:00.000Z → 2026-08-20T12:30:00.000Z (UTC).");
    // NOW is 12:34:56 and the window ends 12:30:00, a gap of 4m56s. The figure FLOORS, so it says
    // 4 and never 5: the sentence claims how much is missing, so it must not claim more than the
    // evidence supports. Naming the figure at all is the point — "24h" alone reads as "up to now".
    expect(output).toContain("the most recent 4 minutes are not counted");
  });

  it("says nothing about a trailing gap when the window reaches the clock", async () => {
    const usageDir = tempUsageDir();
    seed(usageDir, {
      pricePort: PUBLISHED_PRICE,
      attempts: [{ role: "serve", provider: "nim", model: "z-ai/glm-5.2", credentialId: "nim#primary", tokens: { reported: { inputTokens: 1000, outputTokens: 500 } } }],
    });
    // The 1h window buckets by the MINUTE, so it ends at 12:34:00 — 56 seconds behind the clock.
    // A sub-minute gap must print NO sentence rather than "0 minutes", which would read as a
    // defect where there is none. ⚠ This case is why the figure floors: rounding turns 56 seconds
    // into "1 minute" and prints a warning about a window that is, for any practical purpose,
    // current. The first version of this change did exactly that and this test caught it.
    const { output } = await runCost(["--window", "1h"], usageDir);
    expect(output).toContain("Covering 2026-08-20T11:34:00.000Z → 2026-08-20T12:34:00.000Z (UTC).");
    expect(output).not.toContain("are not counted");
  });

  it("groups by model when --by model is given", async () => {
    const usageDir = tempUsageDir();
    // Two separate REQUESTS — a second serve attempt on the same request would be a
    // failover retry, whose spend projects only through the winner.
    seed(usageDir, {
      pricePort: PUBLISHED_PRICE,
      attempts: [{ role: "serve", provider: "nim", model: "z-ai/glm-5.2", credentialId: "nim#primary", tokens: { reported: { inputTokens: 1000, outputTokens: 500 } } }],
    });
    seed(usageDir, {
      pricePort: PUBLISHED_PRICE,
      attempts: [{ role: "serve", provider: "gemini", model: "gemini-3-flash", credentialId: "gemini#primary", tokens: { reported: { inputTokens: 2000, outputTokens: 250 } } }],
    });
    const { output, exitCode } = await runCost(["--by", "model"], usageDir);
    expect(exitCode).toBeNull();
    expect(output).toContain("Provider/model");
    expect(output).toContain("nim/z-ai/glm-5.2");
    expect(output).toContain("gemini/gemini-3-flash");
  });

  it("excludes repair spend until --include-repair, which also shows the share separately", async () => {
    const usageDir = tempUsageDir();
    seed(usageDir, {
      pricePort: PUBLISHED_PRICE,
      attempts: [
        { role: "serve", provider: "nim", model: "z-ai/glm-5.2", credentialId: "nim#primary", tokens: { reported: { inputTokens: 1000, outputTokens: 500 } } },
        { role: "repair", provider: "nim", model: "z-ai/glm-5.2", credentialId: "nim#primary", tokens: { reported: { inputTokens: 4000, outputTokens: 2000 } } },
      ],
    });
    const withoutRepair = await runCost([], usageDir);
    expect(withoutRepair.output).not.toContain("Tool-call repair share");

    const withRepair = await runCost(["--include-repair"], usageDir);
    expect(withRepair.output).toContain("Tool-call repair share");
    // Repair share shows its own attempt count.
    expect(withRepair.output).toMatch(/Tool-call repair share[\s\S]*?\n1\b/);
    // The serve-side row keeps only the winning serve attempt's priced figure.
    expect(withRepair.output).toContain("$0.0020");
  });

  it("shows the abandoned hedge as its own table, and only when one happened", async () => {
    const quiet = tempUsageDir();
    seed(quiet, {
      pricePort: PUBLISHED_PRICE,
      attempts: [{ role: "serve", provider: "nim", model: "z-ai/glm-5.2", credentialId: "nim#primary", tokens: { reported: { inputTokens: 1000, outputTokens: 500 } } }],
    });
    const withoutHedge = await runCost([], quiet);
    // An always-printed table of four "-" cells would be noise on every ordinary run.
    expect(withoutHedge.output).not.toContain("Hedged attempts the relay abandoned");

    const hedged = tempUsageDir();
    seed(hedged, {
      pricePort: PUBLISHED_PRICE,
      attempts: [
        { role: "serve", provider: "kilo", model: "z-ai/glm-5.2", credentialId: "kilo#primary", abandonedByRelay: true, tokens: { reported: { inputTokens: 1000, outputTokens: 0 } } },
        { role: "serve", provider: "nim", model: "z-ai/glm-5.2", credentialId: "nim#primary", tokens: { reported: { inputTokens: 1000, outputTokens: 500 } } },
      ],
    });
    const withHedge = await runCost([], hedged);
    expect(withHedge.output).toContain("Hedged attempts the relay abandoned");
    // It states plainly that the totals above exclude it, so the two are never read as one number.
    expect(withHedge.output).toContain("NOT included in the totals above");
  });

  it("--json emits a contract-valid dashboard.cost.v1 object", async () => {
    const usageDir = tempUsageDir();
    seed(usageDir, {
      pricePort: PUBLISHED_PRICE,
      attempts: [{ role: "serve", provider: "nim", model: "z-ai/glm-5.2", credentialId: "nim#primary", tokens: { reported: { inputTokens: 1000, outputTokens: 500 } } }],
    });
    const { output, exitCode } = await runCost(["--json"], usageDir);
    expect(exitCode).toBeNull();
    const report = parseJsonReport(output);
    expect(report.schema).toBe(DASHBOARD_COST_SCHEMA);
    expect(report.window).toBe("24h");
    expect(report.by).toBe("provider");
    expect(report.includeRepair).toBe(false);
    expect(report.total.requests).toBe(1);
    expect(report.total.spend.providerPublishedReported.amountMicrousd).toBe(2000);
    expect(report.rows).toHaveLength(1);
    expect(report.rows[0]!.key).toBe("nim");
    expect(report.recentMinutesMayLag).toBe(true);
    expect(report.repair).toBeNull();
  });

  it("--json --include-repair carries the repair share with its own cells", async () => {
    const usageDir = tempUsageDir();
    seed(usageDir, {
      pricePort: PUBLISHED_PRICE,
      attempts: [
        { role: "serve", provider: "nim", model: "z-ai/glm-5.2", credentialId: "nim#primary", tokens: { reported: { inputTokens: 1000, outputTokens: 500 } } },
        { role: "repair", provider: "nim", model: "z-ai/glm-5.2", credentialId: "nim#all", tokens: { reported: { inputTokens: 4000, outputTokens: 2000 } } },
      ],
    });
    const { output } = await runCost(["--json", "--include-repair"], usageDir);
    const report = parseJsonReport(output);
    expect(report.repair).not.toBeNull();
    expect(report.repair!.attempts).toBe(1);
    expect(report.repair!.spend.providerPublishedReported.amountMicrousd).toBe(8000);
    // The serve-side total still counts ONE request, not two.
    expect(report.total.requests).toBe(1);
    expect(report.total.pricedRequests).toBe(1);
  });

  it("prints an unpriced cell as '-', never $0", async () => {
    const usageDir = tempUsageDir();
    seed(usageDir, {
      attempts: [{ role: "serve", provider: "ollama-cloud", model: "qwen3-coder", credentialId: "ollama-cloud#free" }],
    });
    const { output } = await runCost(["--json"], usageDir);
    const report = parseJsonReport(output);
    expect(report.total.spend.providerPublishedReported.amountMicrousd).toBeNull();
    expect(report.total.spend.partiallyPricedRequests).toBe(0);
    expect(report.total.spend.unpricedRequests).toBe(1);

    const rendered = await runCost([], usageDir);
    expect(rendered.output).toContain("- (published, reported)");
    expect(rendered.output).not.toContain("$0.0000");
  });

  it("prints 'No accounting data yet' on an empty store and exits 0", async () => {
    const { output, exitCode } = await runCost([], tempUsageDir());
    expect(exitCode).toBeNull();
    expect(output).toContain("No accounting data yet");
  });

  it("reports the lifetime window as an empty store, not a broken one, when lifetime.json is absent", async () => {
    // A MISSING lifetime.json is a fresh install; only a corrupt/throwing read is
    // unavailable. This was rendered as "the local accounting store could not be read"
    // before the projector distinguished the two statuses.
    const { output, exitCode } = await runCost(["--window", "all"], tempUsageDir());
    expect(exitCode).toBeNull();
    expect(output).toContain("No accounting data yet");
    expect(output).not.toContain("could not be read");
  });

  it("reports a corrupt lifetime.json as unreadable", async () => {
    const usageDir = tempUsageDir();
    writeFileSync(join(usageDir, "lifetime.json"), "{not json");
    const { output, exitCode } = await runCost(["--window", "all"], usageDir);
    expect(exitCode).toBeNull();
    expect(output).toContain("could not be read");
    expect(output).not.toContain("No accounting data yet");
  });

  it("keeps coverage complete and prints no partial line when a request simply lacks a token kind", async () => {
    const usageDir = tempUsageDir();
    seed(usageDir, {
      pricePort: PUBLISHED_PRICE,
      // No cache token fields at all — a host that never reports them, not a loss.
      attempts: [{ role: "serve", provider: "nim", model: "z-ai/glm-5.2", credentialId: "nim#primary", tokens: { reported: { inputTokens: 1000, outputTokens: 500 } } }],
    });
    const { output: jsonOutput } = await runCost(["--json"], usageDir);
    const report = parseJsonReport(jsonOutput);
    expect(report.coverage).toBe("complete");
    const rendered = await runCost([], usageDir);
    expect(rendered.output).not.toContain("Coverage: partial");
  });

  it("prints Coverage: partial for a genuinely corrupt shard, distinct from an unmeasured token kind", async () => {
    const usageDir = tempUsageDir();
    seed(usageDir, {
      pricePort: PUBLISHED_PRICE,
      attempts: [{ role: "serve", provider: "nim", model: "z-ai/glm-5.2", credentialId: "nim#primary", tokens: { reported: { inputTokens: 1000, outputTokens: 500 } } }],
    });
    // A second day inside the default 24h window that EXISTS but cannot be parsed —
    // real data the store should hold, unlike a request that simply carried no cache
    // token kind.
    writeFileSync(join(usageDir, "2026-08-19.json"), "{not json");
    const { output: jsonOutput } = await runCost(["--json"], usageDir);
    const report = parseJsonReport(jsonOutput);
    expect(report.coverage).toBe("partial");
    const rendered = await runCost([], usageDir);
    expect(rendered.output).toContain("Coverage: partial");
    expect(rendered.output).toContain("Some data the store held is not reflected in this report");
  });

  it("rejects prototype member names as --window with the usage line, not an internal error", async () => {
    // `windowValue in COST_WINDOWS` used to be true for Object.prototype members, which
    // assigned an inherited function to windowId and died later inside
    // assertCostReportV1 with "Invalid dashboard.cost.v1 payload" instead of this usage.
    for (const name of ["toString", "constructor", "valueOf"]) {
      const { output, exitCode } = await runCost(["--window", name], tempUsageDir());
      expect(exitCode, `--window ${name}`).toBe(1);
      expect(output, `--window ${name}`).toContain("--window expects");
      expect(output, `--window ${name}`).toContain("Usage:");
    }
  });

  it("does not claim repair is included when the lifetime window cannot prove the split", async () => {
    const usageDir = tempUsageDir();
    seed(usageDir, {
      pricePort: PUBLISHED_PRICE,
      attempts: [
        { role: "serve", provider: "nim", model: "z-ai/glm-5.2", credentialId: "nim#primary", tokens: { reported: { inputTokens: 1000, outputTokens: 500 } } },
        { role: "repair", provider: "nim", model: "z-ai/glm-5.2", credentialId: "nim#all", tokens: { reported: { inputTokens: 4000, outputTokens: 2000 } } },
      ],
    });
    const all = await runCost(["--window", "all", "--include-repair"], usageDir);
    expect(all.exitCode).toBeNull();
    expect(all.output).toContain("cannot prove the serve/repair split");
    expect(all.output).toContain("day-bounded");
    // No "repair included" announcement and no share table — the report has no answer.
    expect(all.output).not.toContain("repair included");
    expect(all.output).not.toContain("Tool-call repair share");

    // A day-bounded window honours the same flag normally.
    const bounded = await runCost(["--include-repair"], usageDir);
    expect(bounded.output).toContain(", repair included");
    expect(bounded.output).toContain("Tool-call repair share");
  });

  it("rejects a malformed --window with a usage line and exit 1", async () => {
    const usageDir = tempUsageDir();
    seed(usageDir, {
      pricePort: PUBLISHED_PRICE,
      attempts: [{ role: "serve", provider: "nim", model: "z-ai/glm-5.2", credentialId: "nim#primary" }],
    });
    const { output, exitCode } = await runCost(["--window", "fortnight"], usageDir);
    expect(exitCode).toBe(1);
    expect(output).toContain("--window expects");
    expect(output).toContain("Usage:");
  });

  it("rejects a malformed --by with a usage line and exit 1", async () => {
    const usageDir = tempUsageDir();
    const { output, exitCode } = await runCost(["--by", "region"], usageDir);
    expect(exitCode).toBe(1);
    expect(output).toContain("--by expects");
    expect(output).toContain("Usage:");
  });
});
