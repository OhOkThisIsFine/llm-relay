import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

const injected = vi.hoisted(() => ({
  stage: undefined as "mkdir" | "write" | "rename" | undefined,
  writePaths: [] as string[],
  renames: [] as Array<[string, string]>,
}));

vi.mock("node:fs", async () => {
  const actual = await vi.importActual<typeof import("node:fs")>("node:fs");
  return {
    ...actual,
    mkdirSync: (...args: unknown[]) => {
      if (injected.stage === "mkdir") throw new Error("injected mkdir failure");
      return Reflect.apply(actual.mkdirSync, actual, args);
    },
    writeFileSync: (...args: unknown[]) => {
      injected.writePaths.push(String(args[0]));
      const result = Reflect.apply(actual.writeFileSync, actual, args);
      // Throw after the write to exercise cleanup of a partially/completely created temp file.
      if (injected.stage === "write") throw new Error("injected write failure");
      return result;
    },
    renameSync: (...args: unknown[]) => {
      injected.renames.push([String(args[0]), String(args[1])]);
      if (injected.stage === "rename") throw new Error("injected rename failure");
      return Reflect.apply(actual.renameSync, actual, args);
    },
  };
});

import { loadConfig, type Config } from "../src/config.js";
import { setOffload } from "../src/offload.js";

const dir = mkdtempSync(join(tmpdir(), "rp-offload-atomic-"));

const CONFIG = {
  listen: "127.0.0.1:8791",
  providers: {
    anthropic: { base: "https://api.anthropic.com", kind: "anthropic" },
  },
  routing: {
    default: "anthropic",
    tiers: { opus: "anthropic" },
    offload: false,
  },
  mode: "detect",
  log: { level: "silent", file: null },
};

function freshConfig(name: string): { cfg: Config; path: string } {
  const path = join(dir, name);
  writeFileSync(path, JSON.stringify(CONFIG, null, 2) + "\n", "utf8");
  return { cfg: loadConfig(path), path };
}

beforeEach(() => {
  injected.stage = undefined;
  injected.writePaths = [];
  injected.renames = [];
});

afterEach(() => {
  injected.stage = undefined;
});

afterAll(() => rmSync(dir, { recursive: true, force: true }));

describe("atomic offload persistence", () => {
  it("writes beside the config, renames into place, and only then commits the live config", () => {
    const { cfg, path } = freshConfig("success.json");
    injected.writePaths = [];

    const state = setOffload(cfg, true);

    expect(state).toMatchObject({ enabled: true, persisted: true });
    expect(cfg.routing.offload).toBe(true);
    expect(JSON.parse(readFileSync(path, "utf8")).routing.offload).toBe(true);
    expect(injected.writePaths).toHaveLength(1);
    expect(injected.writePaths[0]).not.toBe(path);
    expect(dirname(injected.writePaths[0]!)).toBe(dirname(path));
    expect(injected.renames).toEqual([[injected.writePaths[0], path]]);
    expect(existsSync(injected.writePaths[0]!)).toBe(false);
  });

  it("commits the same latest offload rules to disk and live memory", () => {
    const { cfg, path } = freshConfig("latest-disk.json");
    const edited = JSON.parse(readFileSync(path, "utf8"));
    edited.routing.offload = { codex: { enabled: true, scope: "all" } };
    writeFileSync(path, JSON.stringify(edited, null, 2) + "\n", "utf8");
    injected.writePaths = [];

    const state = setOffload(cfg, true, "claude", "subagents");
    const onDisk = JSON.parse(readFileSync(path, "utf8")).routing.offload;

    expect(state.persisted).toBe(true);
    expect(cfg.routing.offload).toEqual(onDisk);
    expect(onDisk).toEqual({
      codex: { enabled: true, scope: "all" },
      claude: { enabled: true, scope: "subagents" },
    });
  });

  it.skipIf(process.platform === "win32")("updates a symlink target without replacing the symlink", () => {
    const target = join(dir, "linked-target.json");
    const link = join(dir, "linked-config.json");
    writeFileSync(target, JSON.stringify(CONFIG, null, 2) + "\n", "utf8");
    symlinkSync(target, link, "file");
    const cfg = loadConfig(link);
    injected.writePaths = [];

    const state = setOffload(cfg, true);

    expect(state.persisted).toBe(true);
    expect(lstatSync(link).isSymbolicLink()).toBe(true);
    expect(JSON.parse(readFileSync(target, "utf8")).routing.offload).toBe(true);
    expect(injected.renames[0]?.[1]).toBe(target);
  });

  it.skipIf(process.platform === "win32")("preserves exact permission bits despite the process umask", () => {
    const { cfg, path } = freshConfig("mode.json");
    chmodSync(path, 0o666);
    const previousUmask = process.umask(0o027);
    try {
      expect(setOffload(cfg, true).persisted).toBe(true);
    } finally {
      process.umask(previousUmask);
    }
    expect(statSync(path).mode & 0o777).toBe(0o666);
  });

  it.each(["mkdir", "write", "rename"] as const)(
    "leaves memory and the existing file unchanged when %s fails",
    (stage) => {
      const { cfg, path } = freshConfig(`${stage}.json`);
      const beforeRouting = structuredClone(cfg.routing);
      const beforeFile = readFileSync(path, "utf8");
      injected.writePaths = [];
      injected.stage = stage;

      const state = setOffload(cfg, true);

      expect(state).toMatchObject({
        enabled: false,
        persisted: false,
        persistError: `injected ${stage} failure`,
      });
      expect(cfg.routing).toEqual(beforeRouting);
      expect(readFileSync(path, "utf8")).toBe(beforeFile);
      for (const attemptedPath of injected.writePaths) {
        expect(dirname(attemptedPath)).toBe(dirname(path));
        expect(existsSync(attemptedPath)).toBe(false);
      }
    },
  );
});
