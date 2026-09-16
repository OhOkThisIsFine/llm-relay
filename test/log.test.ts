import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DEFAULT_LOG_MAX_BYTES, MAX_LOG_ATTEMPTS, MetadataLogger, type RequestLog } from "../src/log.js";
import { baseLog } from "../src/request-log.js";

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
  servedProvider: "nim",
  servedModel: "z-ai/glm-5.2",
  servedCredential: null,
  upstreamReportedModel: "meta-router/actual-model",
  attempts: [],
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
      "servedProvider",
      "servedModel",
      "servedCredential",
      "upstreamReportedModel",
      "attempts",
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
   * The same guard, for the OPTIONAL fields — which the assertion above cannot see, because a
   * field the fixture never sets is simply absent from the line. `Required<RequestLog>` is the
   * load-bearing part: adding an optional field to `RequestLog` fails `npm run typecheck:test`
   * here until the fixture populates it, and populating it then fails the key list below until
   * someone states it. Optionality can therefore no longer slip a new column into a log this
   * project promises carries no content.
   */
  it("emits exactly the allow-listed fields, in order, when every optional field is present", () => {
    const full: Required<RequestLog> = {
      ...record(),
      upstreamReportedModel: "meta-router/actual-model",
      toolUseIdRewrites: 2,
      toolCallIdRewrites: 3,
      thoughtSignatureSentinels: 4,
      streamStopCause: "backend_stopped_at_max_tokens",
    };
    new MetadataLogger({ level: "metadata", file }).write(full);
    const [line] = linesIn(file);
    expect(Object.keys(line!)).toEqual([
      "ts",
      "path",
      "servedProvider",
      "servedModel",
      "servedCredential",
      "upstreamReportedModel",
      "attempts",
      "hadTools",
      "streamed",
      "backendStatus",
      "validated",
      "toolUseCount",
      "uncheckableCount",
      "errorKinds",
      "streamStopCause",
      "repair",
      "toolUseIdRewrites",
      "toolCallIdRewrites",
      "thoughtSignatureSentinels",
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

  it("projects and bounds nested attempts so error text cannot enter through an allowed field", () => {
    const attempts = Array.from({ length: MAX_LOG_ATTEMPTS + 10 }, (_, index) => ({
      provider: "nim",
      model: `model-${index}`,
      status: index === 0 ? "committed" : index === 1 ? "dead-turn" : 429,
      ms: index,
      error: "private upstream error text",
      body: "private response body",
    }));
    new MetadataLogger({ level: "metadata", file }).write({ ...record(), attempts } as unknown as RequestLog);

    const raw = readFileSync(file, "utf8");
    expect(raw).not.toContain("private upstream error text");
    expect(raw).not.toContain("private response body");
    const [line] = linesIn(file);
    const logged = line!["attempts"] as Array<Record<string, unknown>>;
    expect(logged).toHaveLength(MAX_LOG_ATTEMPTS);
    expect(logged[0]).toEqual({ provider: "nim", model: "model-0", status: "committed", ms: 0 });
    expect(logged[1]).toEqual({ provider: "nim", model: "model-1", status: "dead-turn", ms: 1 });
    expect(Object.keys(logged[0]!)).toEqual(["provider", "model", "status", "ms"]);
  });

  /**
   * The record identifies the deployment that ANSWERED, and nothing else. The model the
   * client asked for used to be the only model id in the log (`backendModel`), which meant
   * every "which model trips the validator" reading was attributed to whatever the client
   * happened to name — routing resolves a tier/pool spec to a target, so the two routinely
   * differ. Its absence from the allow-list above is the assertion that matters; this pins
   * the replacement.
   */
  it("records the provider and model that SERVED the request", () => {
    new MetadataLogger({ level: "metadata", file }).write(
      record({ servedProvider: "nim", servedModel: "z-ai/glm-5.2" }),
    );
    const [line] = linesIn(file);
    expect(line!["servedProvider"]).toBe("nim");
    expect(line!["servedModel"]).toBe("z-ai/glm-5.2");
    expect(line!["upstreamReportedModel"]).toBe("meta-router/actual-model");
  });

  it("emits a shape-stable credential cell without exposing nested attempt identities", () => {
    const withNestedIdentity = {
      ...record({ servedCredential: "nim#work" }),
      attempts: [{ provider: "nim", model: "m", status: 200, ms: 1, credentialId: "nim#other" }],
    } as unknown as RequestLog;
    new MetadataLogger({ level: "metadata", file }).write(withNestedIdentity);
    const [line] = linesIn(file);
    expect(line!["servedCredential"]).toBe("nim#work");
    expect(line!["attempts"]).toEqual([{ provider: "nim", model: "m", status: 200, ms: 1 }]);
  });

  it("baseLog always supplies an explicit null credential when no backend credential is known", () => {
    const log = baseLog(0, "/health", false, false, 200, "skipped", null);
    expect(log.servedCredential).toBeNull();
  });

  it("omits upstream model provenance when no genuine mismatch was supplied", () => {
    const withoutDrift = record();
    delete withoutDrift.upstreamReportedModel;
    new MetadataLogger({ level: "metadata", file }).write(withoutDrift);
    const [line] = linesIn(file);
    expect(line).not.toHaveProperty("upstreamReportedModel");
  });

  /**
   * `null` is a claim — "nothing served this turn" (a guardrail rejection, a routing error,
   * an admin endpoint answered locally). It has to survive to the line as `null` rather than
   * being dropped, or those turns become indistinguishable from ones that never wrote a
   * served field at all.
   */
  it("emits an explicit null when nothing served the request", () => {
    new MetadataLogger({ level: "metadata", file }).write(record({ servedProvider: null, servedModel: null }));
    const [line] = linesIn(file);
    expect(line).toHaveProperty("servedProvider");
    expect(line!["servedProvider"]).toBeNull();
    expect(line!["servedModel"]).toBeNull();
    expect(line!["servedCredential"]).toBeNull();
  });

  it("writes nothing at all when the level is silent", () => {
    new MetadataLogger({ level: "silent", file }).write(record());
    expect(existsSync(file)).toBe(false);
  });

  it("rotates at the byte boundary and keeps exactly one predecessor", () => {
    const first = record({ latencyMs: 1 });
    const second = record({ latencyMs: 2 });
    const third = record({ latencyMs: 3 });
    const lineBytes = Buffer.byteLength(JSON.stringify(first) + "\n");
    const logger = new MetadataLogger({ level: "metadata", file, maxBytes: lineBytes * 2 });

    logger.write(first);
    logger.write(second); // Exactly at the cap: no rotation.
    writeFileSync(`${file}.1`, "stale predecessor\n");
    logger.write(third); // Would exceed: replace .1 and start fresh.

    expect(linesIn(`${file}.1`).map((line) => line["latencyMs"])).toEqual([1, 2]);
    expect(linesIn(file).map((line) => line["latencyMs"])).toEqual([3]);
    expect(existsSync(`${file}.2`)).toBe(false);
  });

  it("uses a bounded 50 MiB default", () => {
    expect(DEFAULT_LOG_MAX_BYTES).toBe(50 * 1024 * 1024);
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

  it("does not throw when rotation fails", () => {
    const stderr = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    const first = record({ latencyMs: 1 });
    const lineBytes = Buffer.byteLength(JSON.stringify(first) + "\n");
    const logger = new MetadataLogger({ level: "metadata", file, maxBytes: lineBytes });
    logger.write(first);
    mkdirSync(`${file}.1`); // A directory cannot be replaced as the rotated log file.

    expect(() => logger.write(record({ latencyMs: 2 }))).not.toThrow();
    expect(stderr).toHaveBeenCalledOnce();
    expect(linesIn(file).map((line) => line["latencyMs"])).toEqual([1]);
  });

  it("does not throw when the stdout sink fails", () => {
    vi.spyOn(process.stdout, "write").mockImplementation(() => {
      throw new Error("EPIPE");
    });
    expect(() => new MetadataLogger({ level: "metadata", file: null }).write(record())).not.toThrow();
  });
});

describe("tool_use id minting counter", () => {
  /**
   * A streamed response cannot carry `x-llm-relay-tool-use-ids` (headers precede the first tool
   * call), so this counter is the only place the pass is visible for stream traffic. It is on the
   * allow-list deliberately and it is a COUNT — the ids themselves never reach a log line.
   */
  it("emits the count when the relay had to mint ids, and omits the field when it did not", () => {
    const logger = new MetadataLogger({ level: "metadata", file });
    logger.write(record({ toolUseIdRewrites: 3 }));
    logger.write(record());
    const [minted, untouched] = linesIn(file);
    expect(minted!["toolUseIdRewrites"]).toBe(3);
    expect(Object.keys(untouched!)).not.toContain("toolUseIdRewrites");
  });

  /**
   * Its REQUEST-direction sibling: ids rewritten to the provider's own stated shape
   * (`compat.toolCallIds: "strict9"` — mistral's `^[a-zA-Z0-9]{9}$`). Same rule, same reason it
   * is on the allow-list: a COUNT, so the fix is announced without any id reaching a log line.
   */
  it("emits the outbound rewrite count, and omits the field when the provider states no such rule", () => {
    const logger = new MetadataLogger({ level: "metadata", file });
    logger.write(record({ toolCallIdRewrites: 2 }));
    logger.write(record());
    const [rewritten, untouched] = linesIn(file);
    expect(rewritten!["toolCallIdRewrites"]).toBe(2);
    expect(Object.keys(untouched!)).not.toContain("toolCallIdRewrites");
  });

  /**
   * The other request-direction pass: gemini's thought-signature sentinel
   * (`compat.thoughtSignature: "sentinel"`). This one has NO response header at all — it adds
   * vendor-protocol padding rather than changing the caller's data — so the log counter is the
   * ONLY surface it shows on. Still a COUNT, never a signature.
   */
  it("emits the sentinel stamp count, and omits the field when the provider states no such rule", () => {
    const logger = new MetadataLogger({ level: "metadata", file });
    logger.write(record({ thoughtSignatureSentinels: 2 }));
    logger.write(record());
    const [stamped, untouched] = linesIn(file);
    expect(stamped!["thoughtSignatureSentinels"]).toBe(2);
    expect(Object.keys(untouched!)).not.toContain("thoughtSignatureSentinels");
  });
});
