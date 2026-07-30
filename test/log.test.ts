import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MetadataLogger, type RequestLog } from "../src/log.js";

let dir: string;
let file: string;

beforeEach(() => {
  // A temp dir, never `~/.llm-relay` — a test must not write to the real machine.
  dir = mkdtempSync(join(tmpdir(), "llm-relay-log-"));
  file = join(dir, "proxy.jsonl");
});

afterEach(() => {
  vi.restoreAllMocks();
  rmSync(dir, { recursive: true, force: true });
});

const record = (over: Partial<RequestLog> = {}): RequestLog => ({
  ts: "2026-07-29T00:00:00.000Z",
  path: "/v1/messages",
  backendModel: "claude-opus-5",
  servedProvider: "nim",
  servedModel: "z-ai/glm-5.2",
  hadTools: true,
  streamed: false,
  backendStatus: 200,
  validated: "pass",
  toolUseCount: 1,
  uncheckableCount: 0,
  errorKinds: [],
  repair: "none",
  latencyMs: 42,
  ...over,
});

const linesIn = (path: string): Record<string, unknown>[] =>
  readFileSync(path, "utf8")
    .split("\n")
    .filter((l) => l.length > 0)
    .map((l) => JSON.parse(l) as Record<string, unknown>);

describe("metadata-only logging", () => {
  /**
   * "Logs are metadata only" is one of this project's stated identities and had no
   * test pinning it. This asserts the EXACT field set, so adding a field to
   * `RequestLog` — or to the allow-list `write()` projects through — is a
   * deliberate act that shows up as a failing assertion rather than a silent new
   * column in a log this project promises carries no content.
   */
  it("emits exactly the allow-listed metadata fields, in order", () => {
    new MetadataLogger({ level: "metadata", file }).write(record());
    const [line] = linesIn(file);
    expect(Object.keys(line!)).toEqual([
      "ts",
      "path",
      "backendModel",
      "servedProvider",
      "servedModel",
      "hadTools",
      "streamed",
      "backendStatus",
      "validated",
      "toolUseCount",
      "uncheckableCount",
      "errorKinds",
      "repair",
      "latencyMs",
    ]);
  });

  /**
   * The sink PROJECTS instead of serialising what it was handed, so the invariant
   * does not depend on every present and future call site being careful. A record
   * that has picked up a header map, a body, or an error string carrying a key
   * substring cannot leak it through here.
   */
  it("drops any field that is not on the allow-list", () => {
    const leaky = {
      ...record(),
      authorization: "Bearer sk-ant-oat01-REALKEYMATERIAL",
      requestBody: { messages: [{ role: "user", content: "private source code" }] },
      responseHeaders: { "x-api-key": "nvapi-REALKEYMATERIAL" },
    } as unknown as RequestLog;

    new MetadataLogger({ level: "metadata", file }).write(leaky);

    const raw = readFileSync(file, "utf8");
    expect(raw).not.toContain("REALKEYMATERIAL");
    expect(raw).not.toContain("private source code");
    expect(raw).not.toContain("authorization");
    expect(raw).not.toContain("x-api-key");
    const [line] = linesIn(file);
    expect(line).not.toHaveProperty("authorization");
    expect(line).not.toHaveProperty("requestBody");
    expect(line).not.toHaveProperty("responseHeaders");
  });

  it("records the model that SERVED the request alongside the one the client asked for", () => {
    new MetadataLogger({ level: "metadata", file }).write(
      record({ backendModel: "claude-opus-5", servedProvider: "nim", servedModel: "z-ai/glm-5.2" }),
    );
    const [line] = linesIn(file);
    expect(line!["servedProvider"]).toBe("nim");
    expect(line!["servedModel"]).toBe("z-ai/glm-5.2");
    expect(line!["backendModel"]).toBe("claude-opus-5");
  });

  /**
   * An unmigrated call site (`server.ts`'s `baseLog()` until CP-NODE-5 lands) must
   * not publish a confident `null` that reads as "nothing served it". Absent means
   * not populated; `null` means genuinely nothing served.
   */
  it("omits the served fields entirely when a call site has not populated them", () => {
    const partial = record();
    delete (partial as Partial<RequestLog>).servedProvider;
    delete (partial as Partial<RequestLog>).servedModel;

    new MetadataLogger({ level: "metadata", file }).write(partial);
    const [line] = linesIn(file);
    expect(line).not.toHaveProperty("servedProvider");
    expect(line).not.toHaveProperty("servedModel");

    new MetadataLogger({ level: "metadata", file }).write(record({ servedProvider: null, servedModel: null }));
    const lines = linesIn(file);
    expect(lines[1]!["servedProvider"]).toBeNull();
  });

  it("writes nothing at all when the level is silent", () => {
    new MetadataLogger({ level: "silent", file }).write(record());
    expect(existsSync(file)).toBe(false);
  });

  /**
   * Reporting degradation must never itself become a failure path: a log write
   * that cannot land is a logging problem, not a request problem, and must not
   * propagate into the request handler as a 500.
   */
  it("falls back to stderr when the log file cannot be written, and does not throw", () => {
    const stderr = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    const unwritable = join(dir, "no-such-subdir", "proxy.jsonl");

    expect(() => new MetadataLogger({ level: "metadata", file: unwritable }).write(record())).not.toThrow();
    expect(stderr).toHaveBeenCalledOnce();
    expect(String(stderr.mock.calls[0]![0])).toContain("\"servedModel\":\"z-ai/glm-5.2\"");
  });

  it("does not throw even when the fallback sink also fails", () => {
    vi.spyOn(process.stderr, "write").mockImplementation(() => {
      throw new Error("EPIPE");
    });
    const unwritable = join(dir, "no-such-subdir", "proxy.jsonl");
    expect(() => new MetadataLogger({ level: "metadata", file: unwritable }).write(record())).not.toThrow();
  });

  it("does not throw when the stdout sink fails", () => {
    vi.spyOn(process.stdout, "write").mockImplementation(() => {
      throw new Error("EPIPE");
    });
    expect(() => new MetadataLogger({ level: "metadata", file: null }).write(record())).not.toThrow();
  });
});
