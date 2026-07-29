import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, existsSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  compareVersions,
  isOutdated,
  classifyInstall,
  binNames,
  staleShimFiles,
  pruneStaleShims,
  shouldCheckUpdates,
  readPackageJson,
  installGlobalUpdate,
  PACKAGE_NAME,
  SUPPRESS_ENV,
  type GlobalInstallDeps,
} from "../src/self-update.js";

describe("compareVersions", () => {
  it("orders release triples numerically, not lexically", () => {
    expect(compareVersions("0.0.9", "0.0.10")).toBe(-1);
    expect(compareVersions("0.1.0", "0.0.99")).toBe(1);
    expect(compareVersions("1.0.0", "1.0.0")).toBe(0);
  });

  it("sorts a prerelease below its release", () => {
    expect(compareVersions("1.0.0-rc.1", "1.0.0")).toBe(-1);
    expect(compareVersions("1.0.0", "1.0.0-rc.1")).toBe(1);
    expect(compareVersions("1.0.0-alpha", "1.0.0-beta")).toBe(-1);
  });

  it("treats unparseable input as equal so a junk registry answer never triggers an update", () => {
    expect(compareVersions("garbage", "1.0.0")).toBe(0);
    expect(isOutdated("garbage", "9.9.9")).toBe(false);
  });
});

describe("classifyInstall", () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "relay-install-"));
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it("is global when the package root sits under the npm global root", () => {
    const root = join(dir, "node_modules");
    const pkg = join(root, "llm-relay");
    mkdirSync(pkg, { recursive: true });
    expect(classifyInstall(pkg, root)).toBe("global");
  });

  it("is global regardless of path separator or case", () => {
    expect(classifyInstall("C:\\Users\\x\\npm\\node_modules\\llm-relay", "C:/Users/X/npm/node_modules")).toBe("global");
  });

  it("is dev for a source checkout", () => {
    mkdirSync(join(dir, ".git"), { recursive: true });
    expect(classifyInstall(dir, join(dir, "elsewhere"))).toBe("dev");
  });

  it("is managed for anything else (npx cache, local dependency)", () => {
    expect(classifyInstall(dir, null)).toBe("managed");
    expect(classifyInstall(join(dir, "proj", "node_modules", "llm-relay"), join(dir, "global"))).toBe("managed");
  });
});

describe("binNames", () => {
  it("reads the map form", () => {
    expect(binNames({ name: "llm-relay", bin: { "llm-relay": "dist/cli.js", relay: "dist/cli.js" } })).toEqual([
      "llm-relay",
      "relay",
    ]);
  });
  it("reads the string form as the package name", () => {
    expect(binNames({ name: "llm-relay", bin: "dist/cli.js" })).toEqual(["llm-relay"]);
  });
  it("is empty when there is no bin field", () => {
    expect(binNames({ name: "llm-relay" })).toEqual([]);
  });
});

describe("staleShimFiles", () => {
  it("selects every spelling of a dropped bin and nothing else", () => {
    const present = ["llm-relay", "llm-relay.cmd", "llm-relay.ps1", "relay", "relay.cmd", "relay.ps1", "npm.cmd"];
    const files = staleShimFiles("/bin", ["llm-relay", "relay"], ["llm-relay"], present);
    expect(files.map((f) => f.replace(/\\/g, "/"))).toEqual(["/bin/relay", "/bin/relay.cmd", "/bin/relay.ps1"]);
  });

  it("keeps every bin the new version still declares", () => {
    const present = ["llm-relay", "llm-relay.cmd", "llm-relay.ps1"];
    expect(staleShimFiles("/bin", ["llm-relay"], ["llm-relay"], present)).toEqual([]);
  });

  it("never touches an unrelated binary that shares no name", () => {
    expect(staleShimFiles("/bin", ["relay"], [], ["relayctl", "relayctl.cmd"])).toEqual([]);
  });
});

describe("pruneStaleShims", () => {
  let bin: string;
  beforeEach(() => {
    bin = mkdtempSync(join(tmpdir(), "relay-bin-"));
    for (const f of ["llm-relay", "llm-relay.cmd", "relay", "relay.cmd", "relay.ps1", "unrelated.cmd"]) {
      writeFileSync(join(bin, f), "shim", "utf8");
    }
  });
  afterEach(() => rmSync(bin, { recursive: true, force: true }));

  it("deletes the dropped bin's shims and leaves the rest", () => {
    const removed = pruneStaleShims(bin, ["llm-relay", "relay"], ["llm-relay"]);
    expect(removed).toHaveLength(3);
    expect(readdirSync(bin).sort()).toEqual(["llm-relay", "llm-relay.cmd", "unrelated.cmd"]);
  });

  it("is a no-op for a missing or unknown bin dir", () => {
    expect(pruneStaleShims(null, ["relay"], [])).toEqual([]);
    expect(pruneStaleShims(join(bin, "nope"), ["relay"], [])).toEqual([]);
    expect(existsSync(join(bin, "relay"))).toBe(true);
  });
});

describe("shouldCheckUpdates", () => {
  const argv = (...rest: string[]) => ["node", "cli.js", ...rest];

  it("checks only when the CALLER classified the invocation as mutating", () => {
    expect(shouldCheckUpdates(argv(), {}, "mutating")).toBe(true);
    expect(shouldCheckUpdates(argv("ping"), {}, "mutating")).toBe(true);
  });

  it("never checks for a read-only command, whatever the argv looks like", () => {
    // ARC-6a02bffc-2: a status query must not be the moment the global install
    // is replaced and the process re-execed.
    expect(shouldCheckUpdates(argv("keys"), {}, "read-only")).toBe(false);
    expect(shouldCheckUpdates(argv("ping"), {}, "read-only")).toBe(false);
    expect(shouldCheckUpdates(argv("candidates"), {}, "read-only")).toBe(false);
    // An argv this module has never heard of gets the same answer — the
    // classification decides, not a pattern match on the arguments.
    expect(shouldCheckUpdates(argv("some-future-subcommand", "--wat"), {}, "read-only")).toBe(false);
  });

  it("defaults to NOT updating when the caller supplies no classification", () => {
    // The module refuses to guess that an invocation is a safe moment to
    // rewrite the user's global install.
    expect(shouldCheckUpdates(argv(), {})).toBe(false);
    expect(shouldCheckUpdates(argv("ping"), {})).toBe(false);
  });

  it("skips help and version so they stay instant and offline", () => {
    // argv may only ever SUPPRESS: even a mutating classification loses here.
    expect(shouldCheckUpdates(argv("help"), {}, "mutating")).toBe(false);
    expect(shouldCheckUpdates(argv("version"), {}, "mutating")).toBe(false);
    expect(shouldCheckUpdates(argv("--help"), {}, "mutating")).toBe(false);
    expect(shouldCheckUpdates(argv("-v"), {}, "mutating")).toBe(false);
  });

  it("skips when the re-exec marker is set, so an update can never recurse", () => {
    expect(shouldCheckUpdates(argv(), { [SUPPRESS_ENV]: "1" }, "mutating")).toBe(false);
  });
});

describe("installGlobalUpdate (REL-b08a9327)", () => {
  interface Harness {
    deps: GlobalInstallDeps;
    calls: string[][];
    notices: string[];
    discarded: string[];
    pruned: string[][];
  }

  /**
   * `results` answers the npm invocations in order of the FIRST matching
   * predicate; anything unmatched succeeds. Nothing here touches a real
   * install, a real registry, or the real filesystem.
   */
  function harness(fail: (args: string[]) => { ok: boolean; stderr: string } | null): Harness {
    const calls: string[][] = [];
    const notices: string[] = [];
    const discarded: string[] = [];
    const pruned: string[][] = [];
    const deps: GlobalInstallDeps = {
      run: (args) => {
        calls.push(args);
        const verdict = fail(args);
        return { ok: verdict ? verdict.ok : true, stdout: "", stderr: verdict ? verdict.stderr : "" };
      },
      stage: () => "/tmp/stage",
      staged: () => ["/tmp/stage/llm-relay-9.9.9.tgz"],
      discard: (dir) => discarded.push(dir),
      pruneShims: (previous) => pruned.push(previous),
      notify: (m) => notices.push(m),
    };
    return { deps, calls, notices, discarded, pruned };
  }

  const eexist = { ok: false, stderr: "npm error EEXIST: file already exists\nnpm error File exists: llm-relay.cmd" };

  it("installs in one npm call when nothing conflicts", () => {
    const h = harness(() => null);
    expect(installGlobalUpdate("9.9.9", "0.10.0", ["llm-relay"], h.deps)).toEqual({
      ok: true,
      stderr: "",
      missingInstall: false,
    });
    expect(h.calls).toEqual([["install", "-g", `${PACKAGE_NAME}@9.9.9`]]);
  });

  it("never uninstalls on a failure that is not an EEXIST conflict", () => {
    const h = harness((a) => (a[0] === "install" ? { ok: false, stderr: "npm error network timeout" } : null));
    const out = installGlobalUpdate("9.9.9", "0.10.0", ["llm-relay"], h.deps);
    expect(out).toEqual({ ok: false, stderr: "npm error network timeout", missingInstall: false });
    expect(h.calls.map((c) => c[0])).toEqual(["install"]);
    expect(h.pruned).toEqual([]);
  });

  it("does NOT remove the working install when the replacement cannot be fetched", () => {
    // The defect this closes: the old code uninstalled first and only then
    // discovered the reinstall could not be served.
    const h = harness((a) => {
      if (a[0] === "install" && a[1] === "-g") return eexist;
      if (a[0] === "pack") return { ok: false, stderr: "npm error 503 Service Unavailable" };
      return null;
    });
    const out = installGlobalUpdate("9.9.9", "0.10.0", ["llm-relay"], h.deps);
    expect(out.ok).toBe(false);
    expect(out.missingInstall).toBe(false);
    expect(out.stderr).toContain("503");
    expect(h.calls.map((c) => c[0])).toEqual(["install", "pack"]);
    expect(h.calls.some((c) => c[0] === "uninstall")).toBe(false);
    expect(h.discarded).toEqual(["/tmp/stage"]);
  });

  it("proves the replacement is on local disk BEFORE the uninstall, then installs from it", () => {
    let installs = 0;
    const h = harness((a) => {
      if (a[0] === "install" && a[1] === "-g") {
        installs++;
        return installs === 1 ? eexist : null;
      }
      return null;
    });
    const out = installGlobalUpdate("9.9.9", "0.10.0", ["llm-relay"], h.deps);
    expect(out).toEqual({ ok: true, stderr: "", missingInstall: false });
    expect(h.calls).toEqual([
      ["install", "-g", `${PACKAGE_NAME}@9.9.9`],
      ["pack", `${PACKAGE_NAME}@9.9.9`, "--pack-destination", "/tmp/stage"],
      ["uninstall", "-g", PACKAGE_NAME],
      ["install", "-g", "/tmp/stage/llm-relay-9.9.9.tgz"],
    ]);
    // The pack call precedes the uninstall — the ordering is the fix.
    expect(h.calls.findIndex((c) => c[0] === "pack")).toBeLessThan(h.calls.findIndex((c) => c[0] === "uninstall"));
    expect(h.pruned).toEqual([["llm-relay"]]);
    expect(h.discarded).toEqual(["/tmp/stage"]);
  });

  it("rolls the previous version back if even the local reinstall fails", () => {
    const h = harness((a) => {
      if (a[0] === "install" && a[1] === "-g") return a[2] === `${PACKAGE_NAME}@0.10.0` ? null : eexist;
      return null;
    });
    const out = installGlobalUpdate("9.9.9", "0.10.0", ["llm-relay"], h.deps);
    expect(out.ok).toBe(false);
    // The old version went back in, so the user still has a working binary.
    expect(out.missingInstall).toBe(false);
    expect(h.calls[h.calls.length - 1]).toEqual(["install", "-g", `${PACKAGE_NAME}@0.10.0`]);
  });

  it("reports missingInstall only when the rollback ALSO fails", () => {
    const h = harness((a) => (a[0] === "install" ? eexist : null));
    const out = installGlobalUpdate("9.9.9", "0.10.0", ["llm-relay"], h.deps);
    expect(out).toEqual({ ok: false, stderr: eexist.stderr, missingInstall: true });
    expect(h.calls.filter((c) => c[0] === "install")).toHaveLength(3);
  });

  it("hands npm an argv ARRAY, never a joined command string", () => {
    // Regression guard for 30e43b1: the version reaches npm as one argv
    // element, so metacharacters could never introduce a new command.
    const h = harness((a) => (a[0] === "install" && a[1] === "-g" ? eexist : null));
    installGlobalUpdate("9.9.9", "0.10.0", ["llm-relay"], h.deps);
    for (const call of h.calls) {
      expect(Array.isArray(call)).toBe(true);
      for (const arg of call) expect(arg).not.toMatch(/\s(-|npm\b)/);
    }
    expect(h.calls[0]).toEqual(["install", "-g", "llm-relay@9.9.9"]);
  });

  it("does not touch the install at all when no staging dir can be made", () => {
    const h = harness((a) => (a[0] === "install" ? eexist : null));
    const out = installGlobalUpdate("9.9.9", "0.10.0", ["llm-relay"], { ...h.deps, stage: () => "" });
    expect(out.missingInstall).toBe(false);
    expect(h.calls.map((c) => c[0])).toEqual(["install"]);
  });
});

describe("readPackageJson", () => {
  it("degrades to an empty object rather than throwing on a missing or bad file", () => {
    expect(readPackageJson(join(tmpdir(), "definitely-not-here-llm-relay"))).toEqual({});
  });
});
