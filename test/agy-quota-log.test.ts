import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { agyQuotaStatement, parseGoDurationMs, readAgyLog } from "../src/mcp/agy-quota-log.js";

/**
 * `agy-quota-log.ts` reads AGY's own quota statement from AGY's log, because AGY retries a spent
 * quota in silence and the dispatch walk stops the lane before AGY prints anything
 * (`docs/history/dispatch-giveup-diagnosis-2026-09-10.md` §4). The lines below are the real shapes from
 * `~/.gemini/antigravity-cli/cli.log`, 2026-09-10.
 */
const MODEL = "claude-opus-4-6-thinking";
const header = (model: string): string =>
  `I0910 09:10:21.857489       1 printmode.go:174] Print mode: starting (promptLength=33, model="${model}", conversationID="")`;
const quotaLine = (resets: string): string =>
  "I0910 09:10:28.792707     310 run.go:387] Run: attempt 1 failed (RESOURCE_EXHAUSTED (code 429): " +
  `Individual quota reached. Please upgrade your subscription to increase your limits. Resets in ${resets}.), retrying in 4s`;

describe("parseGoDurationMs", () => {
  it.each([
    ["144h10m31s", (144 * 3600 + 10 * 60 + 31) * 1000],
    ["1m53.630865376s", 113_631],
    ["3m7.156070896s", 187_156],
    ["45s", 45_000],
    ["10ms", 10],
  ])("parses %s", (text, ms) => {
    expect(parseGoDurationMs(text)).toBe(ms);
  });

  it.each(["", "abc", "10", "5x", "1h2", "1h 2m", "-5s", "0s"])("refuses %j rather than guessing", (text) => {
    expect(parseGoDurationMs(text)).toBeNull();
  });
});

describe("agyQuotaStatement", () => {
  const log = [header(MODEL), quotaLine("144h10m31s"), quotaLine("144h10m26s")].join("\n");

  it("reads the LAST stated reset when the log is this lane's own run", () => {
    const statement = agyQuotaStatement({ text: log, mtimeMs: 2_000 }, MODEL, 1_000);
    expect(statement?.outcome).toBe("quota_exhausted");
    expect(statement?.retryAfterMs).toBe((144 * 3600 + 10 * 60 + 26) * 1000);
    expect(statement?.line).toContain("Resets in 144h10m26s");
  });

  it("returns null when the run header names another model — the log is shared by every AGY run", () => {
    expect(agyQuotaStatement({ text: log, mtimeMs: 2_000 }, "gemini-3.8-flash-medium", 1_000)).toBeNull();
  });

  it("returns null when the log holds runs of two models", () => {
    const mixed = [header(MODEL), header("gemini-3.8-flash-medium"), quotaLine("1h")].join("\n");
    expect(agyQuotaStatement({ text: mixed, mtimeMs: 2_000 }, MODEL, 1_000)).toBeNull();
  });

  it("returns null when the log did not change after the lane started", () => {
    expect(agyQuotaStatement({ text: log, mtimeMs: 999 }, MODEL, 1_000)).toBeNull();
  });

  it("returns null for a non-finite file time, which proves nothing about this run", () => {
    expect(agyQuotaStatement({ text: log, mtimeMs: Number.NaN }, MODEL, 1_000)).toBeNull();
  });

  it("returns null for a log with no run header", () => {
    expect(agyQuotaStatement({ text: quotaLine("1h"), mtimeMs: 2_000 }, MODEL, 1_000)).toBeNull();
  });

  it("returns null when no reset is stated, so no duration is ever invented", () => {
    const noReset =
      `${header(MODEL)}\nRun: attempt 1 failed (RESOURCE_EXHAUSTED (code 429): Individual quota reached.), retrying in 4s`;
    expect(agyQuotaStatement({ text: noReset, mtimeMs: 2_000 }, MODEL, 1_000)).toBeNull();
  });

  it("classifies a 429 that names no quota as a rate limit", () => {
    const rate =
      `${header(MODEL)}\nRun: attempt 1 failed (RESOURCE_EXHAUSTED (code 429): Too many requests. Resets in 30s.), retrying`;
    const statement = agyQuotaStatement({ text: rate, mtimeMs: 2_000 }, MODEL, 1_000);
    expect(statement?.outcome).toBe("rate_limited");
    expect(statement?.retryAfterMs).toBe(30_000);
  });

  it("returns null when there is no snapshot at all", () => {
    expect(agyQuotaStatement(null, MODEL, 1_000)).toBeNull();
  });
});

describe("readAgyLog", () => {
  it("never reads the operator's real AGY log under vitest", () => {
    expect(readAgyLog()).toBeNull();
  });

  it("reads an explicit path, with its modification time", () => {
    const dir = mkdtempSync(join(tmpdir(), "agy-log-"));
    const file = join(dir, "cli.log");
    writeFileSync(file, header(MODEL), "utf8");
    const snapshot = readAgyLog(file);
    expect(snapshot?.text).toContain(`model="${MODEL}"`);
    expect(Number.isFinite(snapshot?.mtimeMs)).toBe(true);
  });

  it("returns null for a path that does not exist", () => {
    expect(readAgyLog(join(tmpdir(), "no-such-dir-agy-log", "cli.log"))).toBeNull();
  });
});
