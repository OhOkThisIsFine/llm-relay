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
  SUPPRESS_ENV,
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

  it("checks on a normal start", () => {
    expect(shouldCheckUpdates(argv(), {})).toBe(true);
    expect(shouldCheckUpdates(argv("ping"), {})).toBe(true);
  });

  it("skips help and version so they stay instant and offline", () => {
    expect(shouldCheckUpdates(argv("help"), {})).toBe(false);
    expect(shouldCheckUpdates(argv("version"), {})).toBe(false);
    expect(shouldCheckUpdates(argv("--help"), {})).toBe(false);
    expect(shouldCheckUpdates(argv("-v"), {})).toBe(false);
  });

  it("skips when the re-exec marker is set, so an update can never recurse", () => {
    expect(shouldCheckUpdates(argv(), { [SUPPRESS_ENV]: "1" })).toBe(false);
  });
});

describe("readPackageJson", () => {
  it("degrades to an empty object rather than throwing on a missing or bad file", () => {
    expect(readPackageJson(join(tmpdir(), "definitely-not-here-llm-relay"))).toEqual({});
  });
});
