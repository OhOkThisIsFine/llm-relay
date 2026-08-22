import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, renameSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  createSnapshotJournalIo,
  SNAPSHOT_IO_HARD_MAX_JOURNAL_BYTES,
  SNAPSHOT_JOURNAL_SCHEMA,
} from "../src/accounting-store-io.js";

const roots: string[] = [];

function root(): string {
  const value = mkdtempSync(join(tmpdir(), "llm-relay-snapshot-io-"));
  roots.push(value);
  return value;
}

function hooks() {
  let nonce = 0;
  return {
    now: () => 1_700_000_000_000,
    nonce: () => `nonce-${++nonce}`,
  };
}

function codedError(code: string): Error & { code: string } {
  return Object.assign(new Error(code), { code });
}

function journalText(overrides: Record<string, unknown> = {}): string {
  const data = Buffer.from("x", "utf8");
  return JSON.stringify({
    schema: SNAPSHOT_JOURNAL_SCHEMA,
    version: 1,
    transactionId: "journal_nonce",
    createdAtMs: 1,
    targets: [{
      name: "state.json",
      operation: "replace",
      bytes: data.length,
      sha256: "2d711642b726b04401627ca9fbac32f5c8530fb1903cc4db02258717921a4881",
      data: data.toString("base64"),
    }],
    ...overrides,
  });
}

afterEach(() => {
  for (const value of roots.splice(0)) rmSync(value, { recursive: true, force: true });
});

describe("bounded snapshot journal I/O", () => {
  it("writes the journal first and recovers every target-write crash prefix idempotently", () => {
    for (const failAfter of ["journal", "one", "two"] as const) {
      const directory = root();
      const deterministic = hooks();
      let targetRenames = 0;
      const crashing = createSnapshotJournalIo({
        rootDir: directory,
        targets: ["day.json", "lifetime.json"],
        hooks: {
          ...deterministic,
          afterStep: (step) => {
            if (step.step !== "after-rename") return;
            if (step.phase === "journal" && failAfter === "journal") throw new Error("crash journal");
            if (step.phase === "target") {
              targetRenames += 1;
              if ((failAfter === "one" && targetRenames === 1) || (failAfter === "two" && targetRenames === 2)) {
                throw new Error("crash target");
              }
            }
          },
        },
      });
      const failed = crashing.commit({ "day.json": "day-v2", "lifetime.json": "life-v2" });
      expect(failed.status).toBe("failed");
      expect(existsSync(join(directory, "snapshot-journal.json"))).toBe(true);

      const restarted = createSnapshotJournalIo({ rootDir: directory, targets: ["day.json", "lifetime.json"], hooks: hooks() });
      expect(restarted.recover().status).toBe("recovered");
      expect(readFileSync(join(directory, "day.json"), "utf8")).toBe("day-v2");
      expect(readFileSync(join(directory, "lifetime.json"), "utf8")).toBe("life-v2");
      expect(restarted.recover().status).toBe("none");
      expect(existsSync(join(directory, "snapshot-journal.json"))).toBe(false);
    }
  });

  it("recovers a dynamically accepted UTC-day target after restart", () => {
    const directory = root();
    const acceptTarget = (name: string): boolean => /^\d{4}-\d{2}-\d{2}\.json$/.test(name);
    let crash = true;
    const crashing = createSnapshotJournalIo({
      rootDir: directory,
      acceptTarget,
      hooks: {
        ...hooks(),
        afterStep: (step) => {
          if (crash && step.phase === "target" && step.step === "after-rename") {
            crash = false;
            throw new Error("crash");
          }
        },
      },
    });
    expect(crashing.targetNames).toEqual([]);
    expect(crashing.commit({ "2026-08-21.json": "day" }).status).toBe("failed");
    expect(existsSync(join(directory, "snapshot-journal.json"))).toBe(true);

    const restarted = createSnapshotJournalIo({ rootDir: directory, acceptTarget, hooks: hooks() });
    expect(restarted.recover().status).toBe("recovered");
    expect(readFileSync(join(directory, "2026-08-21.json"), "utf8")).toBe("day");
    expect(restarted.readText("2026-08-21.json").status).toBe("ok");
  });

  it("uses the same dynamic policy for reads and quarantine", () => {
    const directory = root();
    const io = createSnapshotJournalIo({
      rootDir: directory,
      acceptTarget: (name) => /^\d{4}-\d{2}-\d{2}\.json$/.test(name),
      hooks: hooks(),
    });
    expect(io.commit({ "2026-08-22.json": "not-json" }).status).toBe("committed");
    const corrupt = io.readJson("2026-08-22.json", (_value: unknown): _value is never => false, { quarantineCorrupt: true });
    expect(corrupt.status).toBe("corrupt");
    expect(corrupt.quarantinedPath).toContain("2026-08-22.json.corrupt-");
    expect(io.readText("2026-08-22.json").status).toBe("missing");
  });

  it("rejects unsafe, false, throwing, and canonical-alias dynamic names", () => {
    const directory = root();
    const calls: string[] = [];
    const io = createSnapshotJournalIo({
      rootDir: directory,
      targets: ["Static.json"],
      acceptTarget: (name) => {
        calls.push(name);
        if (name === "throw.json") throw new Error("predicate");
        return name === "dynamic.json" || name === "a.json" || name === "snapshot-journal.json";
      },
      hooks: hooks(),
    });
    expect(io.readText("../escape").status).toBe("invalid-target");
    expect(io.readText("false.json").status).toBe("invalid-target");
    expect(io.readText("throw.json").status).toBe("invalid-target");
    expect(io.commit({ "Static.json": "one", "static.json": "two" }).status).toBe("invalid");
    expect(io.commit({ "a.json": "one", "A.json": "two" }).status).toBe("invalid");
    expect(io.commit({ "snapshot-journal.json": "must-not-write" }).status).toBe("invalid");
    expect(calls).not.toContain("../escape");
  });

  it("atomically replaces and deletes targets, including an idempotent missing delete", () => {
    const directory = root();
    const io = createSnapshotJournalIo({ rootDir: directory, targets: ["one.json", "two.json"], hooks: hooks() });
    expect(io.commit({ "one.json": "one", "two.json": "two" }).status).toBe("committed");
    expect(io.commit({ "one.json": "updated", "two.json": null }).status).toBe("committed");
    expect(readFileSync(join(directory, "one.json"), "utf8")).toBe("updated");
    expect(existsSync(join(directory, "two.json"))).toBe(false);
    expect(io.recover().status).toBe("none");
    expect(io.commit({ "two.json": null }).status).toBe("committed");
    expect(existsSync(join(directory, "snapshot-journal.json"))).toBe(false);
  });

  it("keeps a delete journal when directory fsync fails, then recovers it", () => {
    const directory = root();
    let deleting = false;
    let failOnce = true;
    const io = createSnapshotJournalIo({
      rootDir: directory,
      targets: ["old.json"],
      hooks: {
        ...hooks(),
        beforeStep: (step) => {
          deleting = step.step === "before-delete";
        },
        beforeDirectoryFsync: () => {
          if (deleting && failOnce) {
            failOnce = false;
            throw codedError("EIO");
          }
        },
      },
    });
    expect(io.commit({ "old.json": "old" }).status).toBe("committed");
    const failed = io.commit({ "old.json": null });
    expect(failed.status).toBe("failed");
    expect(failed.retryable).toBe(true);
    expect(existsSync(join(directory, "old.json"))).toBe(false);
    expect(existsSync(join(directory, "snapshot-journal.json"))).toBe(true);

    const restarted = createSnapshotJournalIo({ rootDir: directory, targets: ["old.json"], hooks: hooks() });
    expect(restarted.recover().status).toBe("recovered");
    expect(existsSync(join(directory, "old.json"))).toBe(false);
    expect(existsSync(join(directory, "snapshot-journal.json"))).toBe(false);
  });

  it("quarantines malformed tombstone journals as lower-bound loss", () => {
    const directory = root();
    const value = JSON.parse(journalText()) as { targets: Array<Record<string, unknown>> };
    value.targets[0] = {
      ...value.targets[0],
      operation: "delete",
      bytes: 1,
      sha256: "2d711642b726b04401627ca9fbac32f5c8530fb1903cc4db02258717921a4881",
      data: "eA",
    };
    writeFileSync(join(directory, "snapshot-journal.json"), JSON.stringify(value));
    const io = createSnapshotJournalIo({ rootDir: directory, targets: ["state.json"], hooks: hooks() });
    const result = io.recover();
    expect(result.status).toBe("recovery-loss");
    expect(result.lowerBoundLoss).toBe(true);
    expect(result.quarantinedPath).toContain("snapshot-journal.json.corrupt-");
  });

  it("exposes effective limits and keeps the hard journal ceiling bounded", () => {
    const directory = root();
    const io = createSnapshotJournalIo({
      rootDir: directory,
      targets: ["state.json"],
      maxFileBytes: 1234,
      maxJournalBytes: 5678,
      maxTargets: 3,
      hooks: hooks(),
    });
    expect(io.maxFileBytes).toBe(1234);
    expect(io.maxJournalBytes).toBe(5678);
    expect(io.maxTargets).toBe(3);
    const clamped = createSnapshotJournalIo({
      rootDir: root(),
      targets: ["state.json"],
      maxJournalBytes: Number.MAX_SAFE_INTEGER,
      hooks: hooks(),
    });
    expect(clamped.maxJournalBytes).toBe(SNAPSHOT_IO_HARD_MAX_JOURNAL_BYTES);
    const fourSchemaFiles = 4 * 16 * 1024 * 1024;
    expect(clamped.maxJournalBytes!).toBeGreaterThan(Math.ceil(fourSchemaFiles * 4 / 3));
  });

  it("handles every durable journal/target prefix without a sleep-based race", () => {
    const durableSteps = ["after-temp-write", "after-file-fsync", "after-rename", "after-directory-fsync"] as const;
    const sites = [
      ...durableSteps.map((step) => ({ phase: "journal" as const, target: null, step })),
      ...durableSteps.flatMap((step) => ["alpha.json", "beta.json"].map((target) => ({ phase: "target" as const, target, step }))),
      { phase: "journal" as const, target: null, step: "before-journal-remove" as const },
    ];
    for (const site of sites) {
      const directory = root();
      const io = createSnapshotJournalIo({
        rootDir: directory,
        targets: ["alpha.json", "beta.json"],
        hooks: {
          ...hooks(),
          afterStep: (step) => {
            if (step.phase === site.phase && step.target === site.target && step.step === site.step) throw new Error("prefix");
          },
          beforeStep: (step) => {
            if (site.step === "before-journal-remove" && step.phase === site.phase && step.step === site.step) {
              throw new Error("prefix");
            }
          },
        },
      });
      const result = io.commit({ "alpha.json": "alpha", "beta.json": "beta" });
      expect(["failed", "committed"]).toContain(result.status);
      const restarted = createSnapshotJournalIo({ rootDir: directory, targets: ["alpha.json", "beta.json"], hooks: hooks() });
      const recovered = restarted.recover();
      const journalWasDurable = site.phase !== "journal" || !["after-temp-write", "after-file-fsync"].includes(site.step);
      if (!journalWasDurable) {
        expect(recovered.status).toBe("none");
        expect(existsSync(join(directory, "alpha.json"))).toBe(false);
        expect(existsSync(join(directory, "beta.json"))).toBe(false);
      } else {
        expect(["recovered", "none"]).toContain(recovered.status);
        expect(readFileSync(join(directory, "alpha.json"), "utf8")).toBe("alpha");
        expect(readFileSync(join(directory, "beta.json"), "utf8")).toBe("beta");
      }
    }
  });

  it("retries a transient target failure without depending on retained target content", () => {
    const directory = root();
    const deterministic = hooks();
    let fail = true;
    const io = createSnapshotJournalIo({
      rootDir: directory,
      targets: ["a.json", "b.json"],
      hooks: {
        ...deterministic,
        afterStep: (step) => {
          if (fail && step.phase === "target" && step.target === "a.json" && step.step === "after-rename") {
            throw new Error("temporary");
          }
        },
      },
    });
    expect(io.commit({ "a.json": "A", "b.json": "B" }).status).toBe("failed");
    fail = false;
    expect(io.recover().status).toBe("recovered");
    expect(readFileSync(join(directory, "a.json"), "utf8")).toBe("A");
    expect(readFileSync(join(directory, "b.json"), "utf8")).toBe("B");
  });

  it("quarantines corrupt and oversize journals as a lower-bound loss, then remains writable", () => {
    const directory = root();
    const io = createSnapshotJournalIo({
      rootDir: directory,
      targets: ["state.json"],
      maxJournalBytes: 1024,
      hooks: hooks(),
    });
    writeFileSync(join(directory, "snapshot-journal.json"), "not-json");
    const corrupt = io.recover();
    expect(corrupt.status).toBe("recovery-loss");
    expect(corrupt.lowerBoundLoss).toBe(true);
    expect(corrupt.quarantinedPath).toContain("snapshot-journal.json.corrupt-");
    expect(io.commit({ "state.json": "fresh" }).status).toBe("committed");

    writeFileSync(join(directory, "snapshot-journal.json"), "x".repeat(1025));
    const oversize = io.recover();
    expect(oversize.status).toBe("recovery-loss");
    expect(oversize.quarantinedPath).toContain("snapshot-journal.json.corrupt-");
    expect(io.commit({ "state.json": "newer" }).status).toBe("committed");
    expect(readFileSync(join(directory, "state.json"), "utf8")).toBe("newer");
  });

  it("bounds target reads before JSON.parse and can quarantine corrupt targets", () => {
    const directory = root();
    const io = createSnapshotJournalIo({ rootDir: directory, targets: ["state.json"], maxFileBytes: 16, hooks: hooks() });
    writeFileSync(join(directory, "state.json"), "{");
    const corrupt = io.readJson("state.json", undefined, { quarantineCorrupt: true });
    expect(corrupt.status).toBe("corrupt");
    expect(corrupt.quarantinedPath).toContain("state.json.corrupt-");
    expect(existsSync(join(directory, "state.json"))).toBe(false);

    writeFileSync(join(directory, "state.json"), "x".repeat(17));
    const oversize = io.readText("state.json", { quarantineCorrupt: true });
    expect(oversize.status).toBe("oversize");
    expect(oversize.quarantinedPath).toContain("state.json.corrupt-");
  });

  it("reads max+1 from one descriptor so growth and pathname swaps cannot smuggle data", () => {
    const growthDirectory = root();
    writeFileSync(join(growthDirectory, "state.json"), "x");
    const growing = createSnapshotJournalIo({
      rootDir: growthDirectory,
      targets: ["state.json"],
      maxFileBytes: 4,
      hooks: { ...hooks(), afterOpenRead: (path) => writeFileSync(path, "12345") },
    });
    expect(growing.readText("state.json").status).toBe("oversize");

    const swapDirectory = root();
    const state = join(swapDirectory, "state.json");
    writeFileSync(state, "old");
    const swapping = createSnapshotJournalIo({
      rootDir: swapDirectory,
      targets: ["state.json"],
      hooks: {
        ...hooks(),
        afterOpenRead: (path) => {
          renameSync(path, join(swapDirectory, "old.json"));
          writeFileSync(path, "new");
        },
      },
    });
    expect(swapping.readText("state.json").status).toBe("failed");
  });

  it("rejects traversal and unknown targets without touching a neighboring path", () => {
    const directory = root();
    const outsideDirectory = root();
    const outside = join(outsideDirectory, "outside.json");
    writeFileSync(outside, "keep");
    const io = createSnapshotJournalIo({ rootDir: directory, targets: ["inside.json"], hooks: hooks() });
    expect(io.readText("../outside.json").status).toBe("invalid-target");
    expect(io.quarantineTarget("../outside.json").status).toBe("invalid-target");
    expect(io.commit({ "../outside.json": "bad" }).status).toBe("invalid");
    expect(readFileSync(outside, "utf8")).toBe("keep");
  });

  it("requires flat journal names", () => {
    const directory = root();
    const nestedJournal = createSnapshotJournalIo({
      rootDir: directory,
      targets: ["state.json"],
      journalName: "nested/snapshot-journal.json",
      hooks: hooks(),
    });
    expect(nestedJournal.commit({ "state.json": "must-not-write" }).status).toBe("invalid");
    expect(existsSync(join(directory, "nested", "snapshot-journal.json"))).toBe(false);
  });

  it("cleans temporary files and exposes persistence ordering through deterministic hooks", () => {
    const directory = root();
    const ordered: string[] = [];
    let throwOnce = true;
    const io = createSnapshotJournalIo({
      rootDir: directory,
      targets: ["state.json"],
      hooks: {
        ...hooks(),
        afterStep: (step) => {
          ordered.push(`${step.phase}:${step.step}`);
          if (throwOnce && step.phase === "journal" && step.step === "after-file-fsync") {
            throwOnce = false;
            throw new Error("fail after fsync");
          }
        },
      },
    });
    expect(io.commit({ "state.json": "one" }).status).toBe("failed");
    expect(readdirSync(directory).filter((name) => name.startsWith("tmp-")).length).toBe(0);
    expect(io.commit({ "state.json": "two" }).status).toBe("committed");
    expect(ordered).toContain("journal:after-file-fsync");
    expect(ordered.indexOf("journal:after-rename")).toBeLessThan(ordered.indexOf("target:after-rename"));
    expect(ordered).toContain("journal:after-journal-remove");
  });

  it("caps snapshot construction and contains malformed options and callback failures", () => {
    const directory = root();
    const capped = createSnapshotJournalIo({
      rootDir: directory,
      targets: ["one.json", "two.json"],
      maxTargets: 2,
      maxFileBytes: 4,
      maxJournalBytes: 550,
      hooks: hooks(),
    });
    expect(capped.commit({ "one.json": "12345" }).status).toBe("invalid");
    expect(capped.commit({ "one.json": "1234", "two.json": "1234", "three.json": "x" }).status).toBe("invalid");
    expect(capped.commit({ "one.json": "1234" }).status).toBe("invalid");
    expect(existsSync(join(directory, "snapshot-journal.json"))).toBe(false);

    const invalid = createSnapshotJournalIo({ rootDir: "\0", targets: ["state.json"] });
    expect(() => invalid.readText("state.json")).not.toThrow();
    expect(invalid.readText("state.json").status).toBe("invalid-target");
    expect(invalid.recover().status).toBe("invalid");
    expect(invalid.commit({ "state.json": "x" }).status).toBe("invalid");

    const throwing = createSnapshotJournalIo({
      rootDir: root(),
      targets: ["state.json"],
      hooks: { ...hooks(), beforeStep: () => { throw new Error("injected"); } },
    });
    expect(() => throwing.commit({ "state.json": "x" })).not.toThrow();
    expect(throwing.commit({ "state.json": "x" }).status).toBe("failed");
  });

  it("rejects portable filesystem aliases and uses a locale-independent target order", () => {
    const aliasDirectory = root();
    const aliases = createSnapshotJournalIo({ rootDir: aliasDirectory, targets: ["A.json", "a.json"] });
    expect(aliases.commit({ "A.json": "A" }).status).toBe("invalid");
    const journalAlias = createSnapshotJournalIo({ rootDir: aliasDirectory, targets: ["Z.json"], journalName: "z.json" });
    expect(journalAlias.commit({ "Z.json": "Z" }).status).toBe("invalid");
    for (const badName of ["AUX.json", "name.", "name ", "name:stream", ".hidden.json"]) {
      const invalid = createSnapshotJournalIo({ rootDir: aliasDirectory, targets: [badName] });
      expect(invalid.commit({ [badName]: "x" }).status).toBe("invalid");
    }

    const directory = root();
    let stop = true;
    const io = createSnapshotJournalIo({
      rootDir: directory,
      targets: ["Z.json", "a.json"],
      hooks: {
        ...hooks(),
        afterStep: (step) => {
          if (stop && step.phase === "journal" && step.step === "after-rename") {
            stop = false;
            throw new Error("hold journal");
          }
        },
      },
    });
    expect(io.commit({ "a.json": "a", "Z.json": "Z" }).status).toBe("failed");
    const journal = JSON.parse(readFileSync(join(directory, "snapshot-journal.json"), "utf8")) as { targets: Array<{ name: string }> };
    expect(journal.targets.map((target) => target.name)).toEqual(["Z.json", "a.json"]);
    const restarted = createSnapshotJournalIo({ rootDir: directory, targets: ["Z.json", "a.json"], hooks: hooks() });
    expect(restarted.recover().status).toBe("recovered");
  });

  it("quarantines only proven-invalid journals and leaves transient journal reads retryable", () => {
    const invalidForms = [
      () => journalText({ unexpected: true }),
      () => journalText({ version: 2 }),
      () => {
        const value = JSON.parse(journalText()) as { targets: Array<{ data: string }> };
        value.targets[0]!.data = "eA";
        return JSON.stringify(value);
      },
      () => {
        const value = JSON.parse(journalText()) as { targets: Array<{ sha256: string }> };
        value.targets[0]!.sha256 = "0".repeat(64);
        return JSON.stringify(value);
      },
      () => {
        const value = JSON.parse(journalText()) as { targets: Array<{ name: string }> };
        value.targets[0]!.name = "STATE.json";
        return JSON.stringify(value);
      },
    ];
    for (const form of invalidForms) {
      const directory = root();
      writeFileSync(join(directory, "snapshot-journal.json"), form());
      const io = createSnapshotJournalIo({ rootDir: directory, targets: ["state.json"], hooks: hooks() });
      const result = io.recover();
      expect(result.status).toBe("recovery-loss");
      expect(result.quarantinedPath).toContain("snapshot-journal.json.corrupt-");
    }

    const directory = root();
    let stop = true;
    const interrupted = createSnapshotJournalIo({
      rootDir: directory,
      targets: ["state.json"],
      hooks: {
        ...hooks(),
        afterStep: (step) => {
          if (stop && step.phase === "journal" && step.step === "after-rename") {
            stop = false;
            throw new Error("stop");
          }
        },
      },
    });
    expect(interrupted.commit({ "state.json": "durable" }).status).toBe("failed");
    const transient = createSnapshotJournalIo({
      rootDir: directory,
      targets: ["state.json"],
      hooks: { ...hooks(), beforeRead: (path) => { if (path.endsWith("snapshot-journal.json")) throw codedError("EACCES"); } },
    });
    const failure = transient.recover();
    expect(failure.status).toBe("failed");
    expect(failure.retryable).toBe(true);
    expect(existsSync(join(directory, "snapshot-journal.json"))).toBe(true);
    expect(createSnapshotJournalIo({ rootDir: directory, targets: ["state.json"], hooks: hooks() }).recover().status).toBe("recovered");
  });

  it("rejects nested target names and refuses direct-child symlink or Windows junction escapes", () => {
    const parent = root();
    const directory = join(parent, "root");
    const outside = join(parent, "sibling");
    mkdirSync(join(directory, "nested"), { recursive: true });
    mkdirSync(outside);
    const nestedEscape = join(directory, "nested", "escape");
    symlinkSync(outside, nestedEscape, process.platform === "win32" ? "junction" : "dir");
    const nested = createSnapshotJournalIo({ rootDir: directory, targets: ["nested/escape/state.json"], hooks: hooks() });
    expect(nested.readText("nested/escape/state.json").status).toBe("invalid-target");
    expect(nested.commit({ "nested/escape/state.json": "must-not-escape" }).status).toBe("invalid");
    expect(existsSync(join(outside, "state.json"))).toBe(false);

    const directEscape = join(directory, "escape");
    symlinkSync(outside, directEscape, process.platform === "win32" ? "junction" : "dir");
    const io = createSnapshotJournalIo({ rootDir: directory, targets: ["escape"], hooks: hooks() });
    expect(io.readText("escape").status).toBe("corrupt");
    expect(io.commit({ escape: "must-not-escape" }).status).toBe("failed");
    expect(existsSync(join(outside, "state.json"))).toBe(false);

    const linkedRoot = join(parent, "linked-root");
    symlinkSync(outside, linkedRoot, process.platform === "win32" ? "junction" : "dir");
    const rootLink = createSnapshotJournalIo({ rootDir: linkedRoot, targets: ["state.json"], hooks: hooks() });
    expect(rootLink.readText("state.json").status).toBe("corrupt");
    expect(rootLink.commit({ "state.json": "must-not-escape" }).status).toBe("failed");
    expect(existsSync(join(outside, "state.json"))).toBe(false);
  });

  it("serializes same-process canonical-root writer leases without on-disk locks", () => {
    const directory = root();
    const second = createSnapshotJournalIo({ rootDir: directory, targets: ["state.json"], hooks: hooks() });
    const alias = createSnapshotJournalIo({ rootDir: join(directory, "."), targets: ["state.json"], hooks: hooks() });
    const otherDirectory = root();
    const other = createSnapshotJournalIo({ rootDir: otherDirectory, targets: ["state.json"], hooks: hooks() });
    let sameInstance: { readonly status: string } | null = null;
    let competingInstance: { readonly status: string } | null = null;
    let first: ReturnType<typeof createSnapshotJournalIo>;
    first = createSnapshotJournalIo({
      rootDir: directory,
      targets: ["state.json"],
      hooks: {
        ...hooks(),
        afterStep: (step) => {
          if (sameInstance === null && step.phase === "journal" && step.step === "after-rename") {
            sameInstance = first.commit({ "state.json": "recursive" });
            competingInstance = second.commit({ "state.json": "second" });
          }
        },
      },
    });

    expect(first.commit({ "state.json": "first" }).status).toBe("committed");
    const sameResult = sameInstance as { readonly status: string } | null;
    const competingResult = competingInstance as { readonly status: string } | null;
    expect(sameResult?.status).toBe("failed");
    expect(competingResult?.status).toBe("failed");
    expect(readFileSync(join(directory, "state.json"), "utf8")).toBe("first");
    expect(existsSync(join(directory, "snapshot-writer.lock"))).toBe(false);

    expect(first.acquireWriter().status).toBe("acquired");
    expect(second.recover().status).toBe("failed");
    expect(alias.acquireWriter().status).toBe("busy");
    expect(other.acquireWriter().status).toBe("acquired");
    expect(other.releaseWriter().status).toBe("released");
    expect(first.releaseWriter().status).toBe("released");
    expect(second.acquireWriter().status).toBe("acquired");
    expect(second.close().status).toBe("closed");
    expect(alias.commit({ "state.json": "alias" }).status).toBe("committed");

    const failureDirectory = root();
    let failOnce = true;
    const failing = createSnapshotJournalIo({
      rootDir: failureDirectory,
      targets: ["state.json"],
      hooks: {
        ...hooks(),
        afterStep: (step) => {
          if (failOnce && step.phase === "journal" && step.step === "after-rename") {
            failOnce = false;
            throw new Error("crash-style failure");
          }
        },
      },
    });
    expect(failing.commit({ "state.json": "failed" }).status).toBe("failed");
    expect(existsSync(join(failureDirectory, "snapshot-writer.lock"))).toBe(false);
    expect(createSnapshotJournalIo({ rootDir: failureDirectory, targets: ["state.json"], hooks: hooks() }).commit({ "state.json": "retry" }).status).toBe("committed");

    const quarantineDirectory = root();
    writeFileSync(join(quarantineDirectory, "state.json"), "not-json");
    const holder = createSnapshotJournalIo({ rootDir: quarantineDirectory, targets: ["state.json"], hooks: hooks() });
    const contender = createSnapshotJournalIo({ rootDir: quarantineDirectory, targets: ["state.json"], hooks: hooks() });
    expect(holder.acquireWriter().status).toBe("acquired");
    expect(contender.quarantineTarget("state.json").status).toBe("failed");
    expect(holder.releaseWriter().status).toBe("released");
    expect(contender.quarantineTarget("state.json").status).toBe("quarantined");
  });

  it("does not release or close a writer lease reentrantly during a mutation", () => {
    const directory = root();
    const contender = createSnapshotJournalIo({ rootDir: directory, targets: ["state.json"], hooks: hooks() });
    let releaseResult: { readonly status: string; readonly error: string | null } | null = null;
    let closeResult: { readonly status: string; readonly error: string | null } | null = null;
    let contenderResult: { readonly status: string; readonly error: string | null } | null = null;
    let owner: ReturnType<typeof createSnapshotJournalIo>;
    owner = createSnapshotJournalIo({
      rootDir: directory,
      targets: ["state.json"],
      hooks: {
        ...hooks(),
        afterStep: (step) => {
          if (step.phase === "journal" && step.step === "after-rename" && releaseResult === null) {
            releaseResult = owner.releaseWriter();
            closeResult = owner.close();
            contenderResult = contender.acquireWriter();
          }
        },
      },
    });

    expect(owner.commit({ "state.json": "outer" }).status).toBe("committed");
    const release = releaseResult as { readonly status: string; readonly error: string | null } | null;
    const close = closeResult as { readonly status: string; readonly error: string | null } | null;
    const during = contenderResult as { readonly status: string; readonly error: string | null } | null;
    expect(release).toEqual({ status: "failed", error: "writer-busy", retryable: true });
    expect(close).toEqual({ status: "failed", error: "writer-busy", retryable: true });
    expect(during).toEqual({ status: "busy", error: "writer-busy", retryable: true });
    expect(contender.acquireWriter().status).toBe("acquired");
    expect(contender.releaseWriter().status).toBe("released");
    expect(owner.close().status).toBe("closed");
  });


  it("keeps corrupt-journal loss explicit when quarantine directory fsync fails", () => {
    const directory = root();
    writeFileSync(join(directory, "snapshot-journal.json"), "{not-json");
    let failOnce = true;
    const io = createSnapshotJournalIo({
      rootDir: directory,
      targets: ["state.json"],
      hooks: {
        ...hooks(),
        beforeDirectoryFsync: () => {
          if (failOnce) {
            failOnce = false;
            throw codedError("EIO");
          }
        },
      },
    });

    const first = io.recover();
    expect(first.status).toBe("recovery-loss");
    expect(first.lowerBoundLoss).toBe(true);
    expect(first.retryable).toBe(true);
    expect(first.quarantinedPath).not.toBeNull();
    expect(existsSync(join(directory, "snapshot-journal.json"))).toBe(true);

    const second = io.recover();
    expect(second.status).toBe("recovery-loss");
    expect(second.lowerBoundLoss).toBe(true);
    expect(second.quarantinedPath).not.toBeNull();
    expect(io.recover().status).toBe("none");
  });


  it("propagates real directory fsync errors and only ignores unsupported Windows directory handles", () => {
    const directory = root();
    let calls = 0;
    const failing = createSnapshotJournalIo({
      rootDir: directory,
      targets: ["state.json"],
      hooks: {
        ...hooks(),
        beforeDirectoryFsync: () => {
          calls += 1;
          if (calls === 2) throw codedError("EIO");
        },
      },
    });
    expect(failing.commit({ "state.json": "state" }).status).toBe("failed");
    expect(existsSync(join(directory, "snapshot-journal.json"))).toBe(true);
    expect(createSnapshotJournalIo({ rootDir: directory, targets: ["state.json"], hooks: hooks() }).recover().status).toBe("recovered");

    const compatibility = createSnapshotJournalIo({
      rootDir: root(),
      targets: ["state.json"],
      hooks: { ...hooks(), beforeDirectoryFsync: () => { throw codedError("EPERM"); } },
    });
    const result = compatibility.commit({ "state.json": "state" });
    expect(result.status).toBe(process.platform === "win32" ? "committed" : "failed");
  });

  it("persists self-validating snapshot journal entries instead of deltas", () => {
    const directory = root();
    let stop = true;
    const io = createSnapshotJournalIo({
      rootDir: directory,
      targets: ["state.json"],
      hooks: {
        ...hooks(),
        afterStep: (step) => {
          if (stop && step.phase === "journal" && step.step === "after-rename") {
            stop = false;
            throw new Error("stop");
          }
        },
      },
    });
    expect(io.commit({ "state.json": "complete snapshot" }).status).toBe("failed");
    const journal = JSON.parse(readFileSync(join(directory, "snapshot-journal.json"), "utf8")) as {
      schema: string;
      targets: Array<{ bytes: number; sha256: string; data: string }>;
    };
    expect(journal.schema).toBe(SNAPSHOT_JOURNAL_SCHEMA);
    expect(journal.targets).toHaveLength(1);
    expect(Buffer.from(journal.targets[0]!.data, "base64").toString("utf8")).toBe("complete snapshot");
    expect(journal.targets[0]!.bytes).toBe("complete snapshot".length);
    expect(journal.targets[0]!.sha256).toHaveLength(64);
  });
});
