import { describe, expect, it } from "vitest";
import { destructiveMatcher } from "../src/repair.js";
import { DEFAULT_DESTRUCTIVE } from "../src/config.js";

/**
 * Pins ARC-4e8f64b6: the safety invariant the whole project rests on — a
 * destructive tool call is refused, never fabricated — was enforced by
 * case-insensitive SUBSTRING matching over patterns like "rm"/"delete"/"push".
 *
 * That was wrong in both directions simultaneously. None of those fragments
 * occur in the harness's real destructive tools, so Bash/Write/Edit were never
 * caught; and "push" matches PushNotification while "reset" matches ResetZoom,
 * so safe tools were refused.
 */
describe("destructive-tool coverage (ARC-4e8f64b6)", () => {
  const isDestructive = destructiveMatcher(DEFAULT_DESTRUCTIVE);

  it("refuses the harness's real destructive tools", () => {
    // The whole point: repair output may run under --dangerously-skip-permissions.
    for (const name of ["Bash", "BashOutput", "Write", "Edit", "MultiEdit", "NotebookEdit"]) {
      expect(isDestructive(name), `${name} must be treated as destructive`).toBe(true);
    }
  });

  it("is case-insensitive on the tool name", () => {
    expect(isDestructive("bash")).toBe(true);
    expect(isDestructive("WRITE")).toBe(true);
    expect(isDestructive("mUlTiEdIt")).toBe(true);
  });

  it("does NOT refuse safe tools that merely share a fragment", () => {
    // These are the false positives substring matching produced.
    for (const name of ["PushNotification", "ResetZoom", "ForceRefresh", "Read", "Grep", "Glob", "WebSearch"]) {
      expect(isDestructive(name), `${name} must be permitted`).toBe(false);
    }
  });

  it("keeps conventional MCP-style names covered", () => {
    for (const name of ["rm", "delete", "delete_file", "remove", "overwrite", "drop", "reset", "force_push"]) {
      expect(isDestructive(name)).toBe(true);
    }
  });

  it("supports an explicit prefix form so a family is opted into deliberately", () => {
    const m = destructiveMatcher(["git_*"]);
    expect(m("git_push")).toBe(true);
    expect(m("git_reset_hard")).toBe(true);
    expect(m("gitlab_read")).toBe(false);
    // A bare `*` must not match everything.
    expect(destructiveMatcher(["*"])("Read")).toBe(false);
  });

  it("the default list is the single definition and covers both classes", () => {
    // A regression here means the four-way-inconsistent list has come back.
    expect(DEFAULT_DESTRUCTIVE).toContain("Bash");
    expect(DEFAULT_DESTRUCTIVE).toContain("Write");
    expect(DEFAULT_DESTRUCTIVE).toContain("Edit");
    expect(DEFAULT_DESTRUCTIVE).toContain("remove");
    // "push" and "force" as bare fragments were the false-positive source.
    expect(DEFAULT_DESTRUCTIVE).not.toContain("push");
    expect(DEFAULT_DESTRUCTIVE).not.toContain("force");
  });
});

describe("the destructive list has ONE definition", () => {
  it("the shipped config template equals DEFAULT_DESTRUCTIVE", async () => {
    // The four-way drift: config.ts had 8 entries including "remove" while
    // cli.ts's template, config.example.json and README.md had 7 without it, so
    // a config that OMITTED repair.destructiveTools got different coverage than
    // a freshly generated one.
    const { readFileSync } = await import("node:fs");
    const example = JSON.parse(readFileSync("config.example.json", "utf8")) as {
      repair?: { destructiveTools?: string[] };
    };
    expect(example.repair?.destructiveTools).toEqual(DEFAULT_DESTRUCTIVE);
  });

  it("cli.ts no longer hand-copies the list", async () => {
    const { readFileSync } = await import("node:fs");
    const cli = readFileSync("src/cli.ts", "utf8");
    // It must SPREAD the shared constant, not restate the names.
    expect(cli).toContain("destructiveTools: [...DEFAULT_DESTRUCTIVE]");
  });
});
