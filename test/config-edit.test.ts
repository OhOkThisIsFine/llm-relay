import { describe, it, expect } from "vitest";
import {
  deleteConfigPath,
  parseConfigPath,
  readConfigPath,
  writeConfigPath,
  type ConfigDocument,
} from "../src/config-edit.js";

/**
 * Unit tests for the dot-path editor itself — the walking logic the CLI's `config`/`routing`
 * verbs are built on. The end-to-end behaviour (a candidate document passing `loadConfig` before
 * the file is written) is pinned in `test/cli.test.ts`, "dot paths through arrays".
 */
describe("config dot-path editing", () => {
  const document = (): ConfigDocument =>
    JSON.parse(
      JSON.stringify({
        routing: {
          ladders: {
            medium: [
              { id: "r0", note: "first" },
              { id: "r1" },
              { id: "r2" },
            ],
            empty: [],
          },
        },
        scalar: 3,
      }),
    ) as ConfigDocument;

  it("addresses an array element by a numeric segment", () => {
    const doc = document();
    writeConfigPath(doc, "routing.ladders.medium.2.note", "third");
    expect((doc.routing as never as { ladders: { medium: unknown[] } }).ladders.medium).toEqual([
      { id: "r0", note: "first" },
      { id: "r1" },
      { id: "r2", note: "third" },
    ]);
  });

  it("reads an array element and a field within it", () => {
    const doc = document();
    expect(readConfigPath(doc, "routing.ladders.medium.0.id")).toBe("r0");
    expect(readConfigPath(doc, "routing.ladders.medium.2.note")).toBeUndefined();
  });

  it("distinguishes a JSON null from a missing path", () => {
    // `null` is a real configured value and must read back as one; only a path that addresses
    // nothing is `undefined`.
    const doc = { routing: { tiers: { sonnet: null } } } as ConfigDocument;
    expect(readConfigPath(doc, "routing.tiers.sonnet")).toBeNull();
    expect(readConfigPath(doc, "routing.tiers.opus")).toBeUndefined();
  });

  it("creates a missing intermediate as an object it can keep descending through", () => {
    const doc = document();
    writeConfigPath(doc, "routing.ladders.medium.1.env.A", "x");
    writeConfigPath(doc, "routing.ladders.medium.1.env.B", "y");
    expect(readConfigPath(doc, "routing.ladders.medium.1.env")).toEqual({ A: "x", B: "y" });
  });

  it("refuses an out-of-range index, naming the index and the array length", () => {
    for (const path of ["routing.ladders.medium.3.note", "routing.ladders.medium.99"]) {
      const doc = document();
      expect(() => writeConfigPath(doc, path, "x")).toThrow(/is out of range for an array of length 3/);
      // Refused, never appended: the array is unchanged.
      expect((doc.routing as never as { ladders: { medium: unknown[] } }).ladders.medium).toHaveLength(3);
    }
  });

  it("refuses an out-of-range index in an intermediate segment too", () => {
    const doc = document();
    expect(() => writeConfigPath(doc, "routing.ladders.medium.9.note.deep", "x")).toThrow(
      /index 9 is out of range for an array of length 3/,
    );
    expect((doc.routing as never as { ladders: { medium: unknown[] } }).ladders.medium).toHaveLength(3);
  });

  it("names the empty array's own length when refusing index 0", () => {
    const doc = document();
    expect(() => writeConfigPath(doc, "routing.ladders.empty.0", "x")).toThrow(
      /index 0 is out of range for an array of length 0/,
    );
  });

  it("refuses a non-numeric segment against an array", () => {
    const doc = document();
    expect(() => writeConfigPath(doc, "routing.ladders.medium.foo", "x")).toThrow(
      /"foo" is not an index \(the value at that path is an array of length 3\)/,
    );
    // Crucially it did NOT hang a `foo` key off the array, which JSON.stringify would drop.
    expect(Object.keys((doc.routing as never as { ladders: { medium: object } }).ladders.medium)).toEqual([
      "0", "1", "2",
    ]);
  });

  it("only accepts canonical decimal indices, not index-shaped names", () => {
    // `01` and `+1` name an element but are not the spelling `String(index)` produces, so they
    // are keys rather than indices — and on an array a key is refused outright.
    for (const part of ["01", "+1", " 1", "-1", "1e0", "0x1", "1_0"]) {
      const doc = document();
      expect(() => writeConfigPath(doc, `routing.ladders.medium.${part}`, "x")).toThrow(/is not an index/);
    }
  });

  it("refuses to write through a non-object leaf", () => {
    const doc = document();
    expect(() => writeConfigPath(doc, "scalar.deeper", "x")).toThrow(/cannot write through the non-object/);
    expect(readConfigPath(doc, "scalar")).toBe(3);
  });

  it("reads a miss rather than diagnosing it, so reads stay read-only", () => {
    const doc = document();
    // The write path refuses these; the READ path must merely miss, because `config get` and
    // `config unset` both use `undefined` to mean "no value at".
    expect(readConfigPath(doc, "routing.ladders.medium.foo")).toBeUndefined();
    expect(readConfigPath(doc, "routing.ladders.medium.99")).toBeUndefined();
    expect(readConfigPath(doc, "scalar.deeper")).toBeUndefined();
  });

  it("deletes a field of an array element and reports whether it was there", () => {
    const doc = document();
    expect(deleteConfigPath(doc, "routing.ladders.medium.0.note")).toBe(true);
    expect(deleteConfigPath(doc, "routing.ladders.medium.0.note")).toBe(false);
    expect(readConfigPath(doc, "routing.ladders.medium.0.note")).toBeUndefined();
    // The element itself survives; only the named field went.
    expect((doc.routing as never as { ladders: { medium: unknown[] } }).ladders.medium[0]).toEqual({ id: "r0" });
    expect(deleteConfigPath(doc, "routing.ladders.medium.99")).toBe(false);
    expect(deleteConfigPath(doc, "routing.ladders.medium.foo")).toBe(false);
  });

  it("deleting an array ELEMENT shortens the array instead of leaving a hole", () => {
    // `delete arr[i]` keeps the length and leaves the index reading `undefined`, which the caller
    // then hands to `loadConfig()` — a spilled hole wearing a valid array's shape. The write is
    // persisted to `config.json`, so the difference survives the process.
    const doc = document();
    expect(deleteConfigPath(doc, "routing.ladders.medium.1")).toBe(true);
    const medium = (doc.routing as never as { ladders: { medium: unknown[] } }).ladders.medium;
    expect(medium.length).toBe(2);
    expect(medium).toEqual([{ id: "r0", note: "first" }, { id: "r2" }]);
    expect(Object.keys(medium)).toEqual(["0", "1"]);
  });

  it("still rejects prototype-pollution path segments, on every entry point", () => {
    for (const path of ["__proto__.polluted", "routing.constructor.prototype", "prototype.x"]) {
      expect(() => parseConfigPath(path)).toThrow(/dot-separated names/);
      const doc = document();
      // All four walkers refuse it up front rather than skipping the segment — a skipped
      // `__proto__` would silently redirect the write onto every object's prototype.
      expect(() => writeConfigPath(doc, path, "x")).toThrow(/dot-separated names/);
      expect(() => readConfigPath(doc, path)).toThrow(/dot-separated names/);
      expect(() => deleteConfigPath(doc, path)).toThrow(/dot-separated names/);
    }
    expect(({} as Record<string, unknown>).polluted).toBeUndefined();
  });
});
