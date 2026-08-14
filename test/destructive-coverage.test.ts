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

  it("refuses the clients' real destructive tools", () => {
    // The whole point: repair output may run under --dangerously-skip-permissions.
    for (const name of [
      "Bash", "BashOutput", "Write", "Edit", "MultiEdit", "NotebookEdit",
      "shell_command", "apply_patch",
    ]) {
      expect(isDestructive(name), `${name} must be treated as destructive`).toBe(true);
    }
  });

  it("is case-insensitive on the tool name", () => {
    expect(isDestructive("bash")).toBe(true);
    expect(isDestructive("WRITE")).toBe(true);
    expect(isDestructive("mUlTiEdIt")).toBe(true);
    expect(isDestructive("SHELL_COMMAND")).toBe(true);
    expect(isDestructive("ApPlY_pAtCh")).toBe(true);
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
    expect(DEFAULT_DESTRUCTIVE).toContain("shell_command");
    expect(DEFAULT_DESTRUCTIVE).toContain("apply_patch");
    expect(DEFAULT_DESTRUCTIVE).toContain("remove");
    // "push" and "force" as bare fragments were the false-positive source.
    expect(DEFAULT_DESTRUCTIVE).not.toContain("push");
    expect(DEFAULT_DESTRUCTIVE).not.toContain("force");
  });
});

/**
 * The assertions above enumerate example names, which is exactly how the previous
 * gap survived: satisfying `Bash`/`Write`/`Edit` positively and `PushNotification`
 * negatively still left `MultiEdit`, `NotebookEdit` and `BashOutput` unasserted, and
 * a hand-written list goes stale the moment the harness ships another tool.
 *
 * These assert the POLICY instead, derived from `DEFAULT_DESTRUCTIVE` itself, so a
 * name added to the list is automatically held to the same rules. `HARNESS_MUTATING`
 * is the one list that must still be maintained by hand — it is the REQUIREMENT
 * (what the harness can destroy), not the implementation, and it is where a new
 * Claude Code write/execute tool gets recorded.
 */
describe("destructive-tool matching POLICY (not a fixed example set)", () => {
  const isDestructive = destructiveMatcher(DEFAULT_DESTRUCTIVE);
  /** Every first-party client tool that writes, deletes or executes. Update when a client adds one. */
  const CLIENT_MUTATING = [
    "Bash", "BashOutput", "Write", "Edit", "MultiEdit", "NotebookEdit",
    "shell_command", "apply_patch",
  ];
  /** Harness tools that only read or search — refusing these breaks working sessions. */
  const HARNESS_READONLY = ["Read", "Glob", "Grep", "WebFetch", "WebSearch", "TodoWrite", "Task"];
  const exactPatterns = DEFAULT_DESTRUCTIVE.filter((p) => !p.endsWith("*"));

  it("covers the WHOLE first-party client mutating set, not a sample of it", () => {
    const uncovered = CLIENT_MUTATING.filter((n) => !isDestructive(n));
    expect(uncovered, `client tools left unguarded: ${uncovered.join(", ")}`).toEqual([]);
    // And the list is the mechanism, so a name can only be covered by being on it.
    expect(CLIENT_MUTATING.every((n) => DEFAULT_DESTRUCTIVE.includes(n))).toBe(true);
  });

  it("matches EVERY configured pattern, in any case", () => {
    for (const p of exactPatterns) {
      expect(isDestructive(p), `${p} is configured but not matched`).toBe(true);
      expect(isDestructive(p.toUpperCase()), `${p} must match case-insensitively`).toBe(true);
      expect(isDestructive(p.toLowerCase())).toBe(true);
    }
  });

  it("never matches a name that merely CONTAINS a configured pattern", () => {
    // The property that makes PushNotification/ResetZoom safe, asserted for every
    // entry rather than for the two names that happened to bite us.
    const decorate = (p: string) => [`Safe${p}`, `${p}Viewer`, `my_${p}_helper`];
    for (const p of exactPatterns) {
      for (const name of decorate(p)) {
        if (DEFAULT_DESTRUCTIVE.some((d) => d.toLowerCase() === name.toLowerCase())) continue;
        expect(isDestructive(name), `${name} must not match the pattern "${p}"`).toBe(false);
      }
    }
  });

  it("permits every read-only harness tool", () => {
    const wrongly = HARNESS_READONLY.filter((n) => isDestructive(n));
    expect(wrongly, `safe tools refused: ${wrongly.join(", ")}`).toEqual([]);
  });

  it("has no implicit built-in destructive set — the config list is the only source", () => {
    // An empty `repair.destructiveTools` must refuse nothing, so coverage is always
    // traceable to config rather than to a hidden table in src/.
    const none = destructiveMatcher([]);
    for (const n of [...CLIENT_MUTATING, ...HARNESS_READONLY]) expect(none(n)).toBe(false);
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
