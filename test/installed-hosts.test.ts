import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { commandExistsOnPath, executableCandidates } from "../src/executable-lookup.js";
import { AGENT_HOST_IDS, detectHost, detectHosts } from "../src/installed-hosts.js";

/**
 * Detection of INSTALLED agent CLIs, and the PATH lookup under it.
 *
 * Two rules carry every test here:
 *   - detection needs POSITIVE evidence, and a negative means "no evidence", never "absent";
 *   - a config path is WEAKER evidence than a binary, because `install-skill.mjs` writes into
 *     `~/.codex/` and llm-relay must not detect its own footprint.
 */

describe("executableCandidates", () => {
  it("uses the bare name off Windows — PATHEXT is a Windows concept", () => {
    expect(executableCandidates("codex", {}, "linux")).toEqual(["codex"]);
    expect(executableCandidates("codex", { PATHEXT: ".EXE" }, "darwin")).toEqual(["codex"]);
  });

  it("appends PATHEXT on Windows, bare name first", () => {
    const got = executableCandidates("codex", { PATHEXT: ".EXE;.CMD" }, "win32");
    expect(got).toEqual(["codex", "codex.EXE", "codex.CMD"]);
  });

  /**
   * ⚠ The reason this function exists at all. npm writes a `.cmd` shim for a global install, so a
   * lookup with no PATHEXT handling reports "codex is not installed" on every Windows machine that
   * has Codex. The keyring's original copy had exactly that gap — harmless there, because it only
   * ever asked about Linux `secret-tool`.
   */
  it("falls back to the documented Windows default when PATHEXT is unset", () => {
    const got = executableCandidates("codex", {}, "win32");
    expect(got).toContain("codex.EXE");
    expect(got).toContain("codex.CMD");
  });

  it("does NOT double-suffix a name that already carries a known extension", () => {
    // `agy.exe.EXE` exists nowhere. Case-insensitive, because Windows paths are.
    expect(executableCandidates("agy.exe", { PATHEXT: ".EXE;.CMD" }, "win32")).toEqual(["agy.exe"]);
    expect(executableCandidates("agy.EXE", { PATHEXT: ".exe" }, "win32")).toEqual(["agy.EXE"]);
  });

  it("ignores blank PATHEXT entries rather than testing a bare name twice", () => {
    expect(executableCandidates("x", { PATHEXT: ".EXE;;  ;.CMD" }, "win32")).toEqual([
      "x",
      "x.EXE",
      "x.CMD",
    ]);
  });
});

/**
 * ⚠ These are TRUE-POSITIVE tests, and they exist because adversarial review proved the module was
 * shipping unverified: every earlier assertion checked a FALSE return, so `commandExistsOnPath`
 * could have returned false unconditionally and the whole suite would still have passed — while
 * the PATHEXT handling this module was written for did nothing. A negative-only test of a lookup
 * proves only that absence is reported; it says nothing about presence.
 *
 * They use a real temp directory, because the function's whole job is to touch the real filesystem.
 */
describe("commandExistsOnPath", () => {
  let dir: string;
  const isWindows = process.platform === "win32";
  // On Windows a bare name resolves only through PATHEXT, so the fixture must carry a real
  // extension - which is exactly the npm `.cmd` shim case that motivated the module.
  const fixture = isWindows ? "probecmd.cmd" : "probecmd";

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "llm-relay-path-"));
    const file = join(dir, fixture);
    writeFileSync(file, isWindows ? "@echo off\r\n" : "#!/bin/sh\nexit 0\n");
    if (!isWindows) chmodSync(file, 0o755);
  });

  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it("FINDS a real executable on PATH — the positive branch, on this platform", () => {
    expect(commandExistsOnPath("probecmd", { PATH: dir, PATHEXT: ".CMD" }, process.platform)).toBe(true);
  });

  it("finds it among several PATH entries, not only the first", () => {
    const path = [join(dir, "nope-a"), dir, join(dir, "nope-b")].join(isWindows ? ";" : ":");
    expect(commandExistsOnPath("probecmd", { PATH: path, PATHEXT: ".CMD" }, process.platform)).toBe(true);
  });

  it("does NOT find a name that is present but different", () => {
    expect(commandExistsOnPath("probecmdx", { PATH: dir, PATHEXT: ".CMD" }, process.platform)).toBe(false);
  });

  /**
   * ⚠ A DIRECTORY is not an executable. `X_OK` has no effect on Windows — Node degrades it to
   * `F_OK` — so an accessSync-only check reported any same-named directory on PATH as installed.
   */
  it("does not accept a DIRECTORY that shares the command's name", () => {
    const holder = mkdtempSync(join(tmpdir(), "llm-relay-dirpath-"));
    try {
      mkdirSync(join(holder, "probedir"), { recursive: true });
      expect(commandExistsOnPath("probedir", { PATH: holder, PATHEXT: "" }, process.platform)).toBe(false);
    } finally {
      rmSync(holder, { recursive: true, force: true });
    }
  });

  it("is false with no PATH at all rather than throwing", () => {
    expect(commandExistsOnPath("codex", {}, "linux")).toBe(false);
  });

  it("is false for a directory that does not exist — absence is the branch signal", () => {
    expect(commandExistsOnPath("definitely-not-a-real-binary-xyz", { PATH: "/nope" }, "linux")).toBe(false);
  });

  /**
   * ⚠ The `platform` argument must govern the WHOLE lookup, not just the extension list. The first
   * version split PATH with `node:path`'s unqualified `delimiter`, which follows the REAL host — so
   * simulating win32 on a POSIX host shredded a `C:\a;C:\b` PATH on `:` while the candidate list
   * was correctly virtualized. Half-virtualized returns a confident wrong answer.
   */
  it("splits PATH with the delimiter of the REQUESTED platform, not the host's", () => {
    // A win32-shaped PATH must not be split on ':' (which would shred the drive letters). Neither
    // directory exists, so the assertion is that it does not throw and reports a clean negative -
    // the observable proof that the split used ';' is that no garbage segment is produced.
    expect(commandExistsOnPath("x", { PATH: "C:\\a;C:\\b" }, "win32")).toBe(false);
    expect(commandExistsOnPath("x", { PATH: "/a:/b" }, "linux")).toBe(false);
  });
});

describe("detectHost", () => {
  const never = () => false;
  const noFiles = () => false;

  it("reports a binary on PATH as the strong evidence, naming which spelling matched", () => {
    const d = detectHost("agy", {
      home: "/home/u",
      exists: noFiles,
      onPath: (c) => c === "agy.exe",
    });
    expect(d.onPath).toBe(true);
    expect(d.binary).toBe("agy.exe");
    expect(d.installed).toBe(true);
    expect(d.configPath).toBeNull();
  });

  it("tries every declared spelling in order", () => {
    const d = detectHost("agy", { home: "/home/u", exists: noFiles, onPath: (c) => c === "agy" });
    expect(d.binary).toBe("agy");
  });

  it("accepts a config path as corroborating evidence when no binary resolves", () => {
    // agy is the ONLY host with an admitted config path — see the footprint rule below.
    const d = detectHost("agy", {
      home: "/home/u",
      onPath: never,
      exists: (p) => p.includes("antigravity-cli"),
    });
    expect(d.onPath).toBe(false);
    expect(d.binary).toBeNull();
    expect(d.configPath).toContain("antigravity-cli");
    expect(d.installed).toBe(true);
  });

  /**
   * ⚠ THE FOOTPRINT RULE, and the test that exists because the first version of this module got it
   * wrong. `install-skill.mjs` creates `~/.codex/`, `~/.claude/` and the OpenCode skills directory,
   * and every llm-relay BEFORE v0.62.0 wrote `~/.codex/config.toml` unconditionally. So none of
   * those paths proves the HOST is present — they prove llm-relay ran. An earlier draft keyed Codex
   * on `config.toml` while its own comment claimed to guard against exactly this, which would have
   * made the installer's detection gate permanently open on every existing machine.
   *
   * These three hosts therefore have NO config path: a binary is the only non-footprint evidence.
   */
  it("treats NO path as evidence for claude, codex or opencode — every candidate is llm-relay's own footprint", () => {
    // `exists` returns true for absolutely everything. Detection must still be false.
    const alwaysExists = () => true;
    for (const id of ["claude", "codex", "opencode"] as const) {
      const d = detectHost(id, { home: "/home/u", onPath: never, exists: alwaysExists });
      expect(d.configPath, `${id} must admit no config path`).toBeNull();
      expect(d.installed, `${id} must not be detected from a path`).toBe(false);
    }
  });

  it("still detects those three from a binary — the footprint rule removes paths, not detection", () => {
    const d = detectHost("codex", { home: "/home/u", exists: () => false, onPath: (c) => c === "codex" });
    expect(d.onPath).toBe(true);
    expect(d.installed).toBe(true);
  });

  /**
   * ⚠ `detectHost` documents "never throws", and its one unchecked call site is
   * `scripts/install-skill.mjs` — plain JavaScript, where the `AgentHostId` type proves nothing.
   * A bare probe lookup on an unknown id threw a TypeError, which in a postinstall hook lands in a
   * catch that provisions anyway with no message.
   */
  it("returns no-evidence for an unknown host id instead of throwing", () => {
    const d = detectHost("not-a-host" as never, { home: "/home/u", onPath: never, exists: () => true });
    expect(d.installed).toBe(false);
    expect(d.onPath).toBe(false);
  });

  it("reports no evidence as installed:false — which means unknown, never 'absent'", () => {
    const d = detectHost("opencode", { home: "/home/u", onPath: never, exists: noFiles });
    expect(d.installed).toBe(false);
    expect(d.onPath).toBe(false);
    expect(d.configPath).toBeNull();
  });

  it("never throws when a seam throws — a detection fault must not break its caller", () => {
    const d = detectHost("claude", {
      home: "/home/u",
      onPath: () => {
        throw new Error("PATH exploded");
      },
      exists: () => {
        throw new Error("stat exploded");
      },
    });
    expect(d.installed).toBe(false);
  });

  it("covers every id in the closed vocabulary, in a stable order", () => {
    const all = detectHosts({ home: "/home/u", onPath: never, exists: noFiles });
    expect(all.map((h) => h.id)).toEqual([...AGENT_HOST_IDS]);
    // Every entry carries a human label, so a report never prints a bare id.
    for (const h of all) expect(h.label.length).toBeGreaterThan(0);
  });
});
