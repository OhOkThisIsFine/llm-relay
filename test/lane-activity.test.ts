/**
 * A dispatch lane's live traffic, as the relay daemon records it (`src/lane-activity.ts`,
 * 2026-09-17). The MCP server tags each lane's requests; the daemon records the tag's requests in
 * flight and its last traffic, and answers `GET /dispatch/activity?tag=`. The walk stops a lane
 * only when this, its output and its working tree all show no activity.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { createProxy } from "../src/server.js";
import { ModelCatalog } from "../src/catalog.js";
import type { Config } from "../src/config.js";
import { CONTROL_AUTHORIZATION_HEADER } from "../src/control-authorization.js";
import {
  beginLaneRequest,
  LANE_ACTIVITY_HEADER,
  laneActivityTag,
  MAX_LANE_ACTIVITY_TAGS,
  readLaneActivity,
  resetLaneActivity,
} from "../src/lane-activity.js";
import { readMcpLaneActivity } from "../src/cli.js";

const TOKEN = "lane-activity-control-token";
const TAG = "0123456789abcdef0123456789abcdef";

beforeEach(() => resetLaneActivity());

describe("lane activity records", () => {
  it("accepts only a tag from the closed alphabet", () => {
    expect(laneActivityTag(TAG)).toBe(TAG);
    expect(laneActivityTag(`  ${TAG} `)).toBe(TAG);
    expect(laneActivityTag([TAG, "other-tag-value"])).toBe(TAG);
    expect(laneActivityTag("short")).toBeNull();
    expect(laneActivityTag("has space inside it")).toBeNull();
    expect(laneActivityTag(undefined)).toBeNull();
  });

  it("counts a request in flight from its start to its end, and moves the last activity on writes", () => {
    let now = 1_000;
    const lane = beginLaneRequest(TAG, () => now);
    expect(readLaneActivity(TAG)).toEqual({ inFlight: 1, requests: 1, lastActivityAt: 1_000 });
    now = 5_000;
    lane.wrote();
    expect(readLaneActivity(TAG)?.lastActivityAt).toBe(5_000);
    now = 9_000;
    lane.ended();
    lane.ended();
    lane.wrote();
    expect(readLaneActivity(TAG)).toEqual({ inFlight: 0, requests: 1, lastActivityAt: 9_000 });
  });

  it("keeps at most MAX_LANE_ACTIVITY_TAGS records and drops the least recently active one", () => {
    const tag = (i: number): string => `tag-${String(i).padStart(8, "0")}`;
    for (let i = 0; i < MAX_LANE_ACTIVITY_TAGS; i++) beginLaneRequest(tag(i), () => i).ended();
    // Touch the oldest, so the second oldest is now the least recently active.
    beginLaneRequest(tag(0), () => 10_000_000).ended();
    beginLaneRequest("tag-overflow", () => 10_000_001).ended();
    expect(readLaneActivity(tag(0))).not.toBeNull();
    expect(readLaneActivity(tag(1))).toBeNull();
    expect(readLaneActivity("tag-overflow")).not.toBeNull();
  });
});

describe("the daemon records a tagged request and answers GET /dispatch/activity", () => {
  const servers: Server[] = [];
  afterEach(async () => {
    for (const s of servers.splice(0)) await new Promise<void>((r) => s.close(() => r()));
  });

  /** An anthropic-shaped backend that answers after `delayMs` and records the headers it saw. */
  async function backend(delayMs: number): Promise<{ port: number; seen: Array<Record<string, unknown>> }> {
    const seen: Array<Record<string, unknown>> = [];
    const s = createServer((req, res) => {
      seen.push({ ...req.headers });
      req.on("data", () => {});
      req.on("end", () => {
        setTimeout(() => {
          res.writeHead(200, { "content-type": "application/json" });
          res.end(
            JSON.stringify({
              id: "msg_1", type: "message", role: "assistant", model: "m", stop_reason: "end_turn",
              content: [{ type: "text", text: "ok" }], usage: { input_tokens: 1, output_tokens: 1 },
            }),
          );
        }, delayMs);
      });
    });
    await new Promise<void>((r) => s.listen(0, "127.0.0.1", () => r()));
    servers.push(s);
    return { port: (s.address() as AddressInfo).port, seen };
  }

  async function proxy(upstreamPort: number): Promise<{ base: string; cfg: Config }> {
    const cfg = {
      host: "127.0.0.1",
      port: 0,
      // A PASSTHROUGH target forwards the caller's headers, so it is the case that proves the tag is
      // stripped rather than merely not on an allow-list.
      providers: { up: { base: `http://127.0.0.1:${upstreamPort}`, kind: "anthropic", timeoutMs: 5000 } },
      routing: { default: "up/m", tiers: {} },
      mode: "detect",
      repair: { maxAttempts: 1, destructiveTools: [] },
      log: { level: "silent", file: null },
    } as unknown as Config;
    const s = createProxy(cfg, {
      catalog: new ModelCatalog({ cachePath: null }),
      controlAuthorization: { validate: (candidate) => candidate === TOKEN },
    });
    await new Promise<void>((r) => s.listen(0, "127.0.0.1", () => r()));
    servers.push(s);
    const port = (s.address() as AddressInfo).port;
    return { base: `http://127.0.0.1:${port}`, cfg: { ...cfg, port } as Config };
  }

  const message = (base: string): Promise<Response> =>
    fetch(`${base}/v1/messages`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-api-key": "caller", [LANE_ACTIVITY_HEADER]: TAG },
      body: JSON.stringify({ model: "up/m", max_tokens: 8, messages: [{ role: "user", content: "hi" }] }),
    });

  const activity = (base: string, tag = TAG, headers: Record<string, string> = { [CONTROL_AUTHORIZATION_HEADER]: TOKEN }) =>
    fetch(`${base}/dispatch/activity?tag=${tag}`, { headers });

  it("shows a request in flight while the backend works, and the finished request after it", async () => {
    const up = await backend(400);
    const { base } = await proxy(up.port);
    const pending = message(base);
    await new Promise((r) => setTimeout(r, 150));
    const during = (await (await activity(base)).json()) as { activity: { inFlight: number; requests: number } };
    expect(during.activity).toMatchObject({ inFlight: 1, requests: 1 });
    expect((await pending).status).toBe(200);
    await new Promise((r) => setTimeout(r, 20));
    const after = (await (await activity(base)).json()) as { tag: string; activity: { inFlight: number; requests: number; lastActivityAt: string } };
    expect(after.tag).toBe(TAG);
    expect(after.activity.inFlight).toBe(0);
    expect(after.activity.requests).toBe(1);
    expect(Number.isFinite(Date.parse(after.activity.lastActivityAt))).toBe(true);
    // The tag never leaves the relay, even to a passthrough target that receives the caller's headers.
    expect(up.seen).toHaveLength(1);
    expect(up.seen[0]?.[LANE_ACTIVITY_HEADER]).toBeUndefined();
    expect(up.seen[0]?.["x-api-key"]).toBe("caller");
  });

  it("answers activity: null for a tag it never saw", async () => {
    const up = await backend(0);
    const { base } = await proxy(up.port);
    const res = await activity(base, "ffffffffffffffffffffffffffffffff");
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ tag: "ffffffffffffffffffffffffffffffff", activity: null });
  });

  it("needs the control token, a valid tag, and GET", async () => {
    const up = await backend(0);
    const { base } = await proxy(up.port);
    expect((await activity(base, TAG, {})).status).toBe(403);
    expect((await activity(base, "bad tag")).status).toBe(400);
    const post = await fetch(`${base}/dispatch/activity?tag=${TAG}`, {
      method: "POST",
      headers: { "content-type": "application/json", [CONTROL_AUTHORIZATION_HEADER]: TOKEN },
      body: "{}",
    });
    expect(post.status).toBe(404);
  });

  it("the MCP side reads it through the CLI helper, and reads nothing as no signal", async () => {
    const up = await backend(0);
    const { base, cfg } = await proxy(up.port);
    expect((await message(base)).status).toBe(200);
    const request = async (_c: Config, path: string): Promise<unknown> => {
      const res = await fetch(`${base}${path}`, { headers: { [CONTROL_AUTHORIZATION_HEADER]: TOKEN } });
      return res.ok ? res.json() : null;
    };
    const read = await readMcpLaneActivity(cfg, TAG, request);
    expect(read?.inFlight).toBe(0);
    expect(read?.lastActivityAt).toBeGreaterThan(0);
    expect(await readMcpLaneActivity(cfg, "eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee", request)).toBeNull();
    expect(await readMcpLaneActivity(cfg, TAG, async () => null)).toBeNull();
    expect(await readMcpLaneActivity(cfg, TAG, async () => ({ activity: { inFlight: "x" } }))).toBeNull();
  });
});
