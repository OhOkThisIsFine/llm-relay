/**
 * Live traffic for a dispatched lane, as the relay daemon sees it (2026-09-17, owner decision: a
 * lane is stopped when it is IDLE, never because it passed a time budget).
 *
 * The MCP server gives every lane it starts a random TAG and sends it as the
 * `x-llm-relay-lane-activity` request header — through `ANTHROPIC_CUSTOM_HEADERS` for a spawned
 * `claude -p`, directly for an answer-mode call. Every request that carries a tag touches its
 * record here: the request start, every write to the response, and the request end. So the daemon
 * can say "this lane has a request in flight" or "its last traffic was N seconds ago" — which is
 * the one activity signal `claude -p` does not hide, because it buffers its own output until exit.
 *
 * ⚠ In memory only, in the daemon process. A restart forgets every tag, and the MCP server then
 * reads "no record", which is NO signal, never "idle": the walk still has the lane's output and
 * its working tree.
 * ⚠ The tag carries nothing: it is a random token the MCP server made, validated to a closed
 * alphabet so a caller cannot put prose into a map key. The header never leaves the relay
 * (`INTERNAL_REQUEST_HEADERS` in `candidate-runner.ts`).
 */

/** The request header that carries a lane's activity tag. */
export const LANE_ACTIVITY_HEADER = "x-llm-relay-lane-activity";

/** The tags the daemon keeps at once. The oldest record is dropped past it. */
export const MAX_LANE_ACTIVITY_TAGS = 1_000;

const TAG_PATTERN = /^[A-Za-z0-9_-]{8,64}$/;

/** What the daemon knows about one tag. */
export interface LaneTrafficRecord {
  /** Requests with this tag the daemon is serving now. */
  inFlight: number;
  /** Requests with this tag the daemon has seen. */
  requests: number;
  /** Epoch ms of the last request start, response write or request end. */
  lastActivityAt: number;
}

const records = new Map<string, LaneTrafficRecord>();

/** The tag in a header value, or null when the value is absent or not a valid tag. */
export function laneActivityTag(value: string | string[] | undefined): string | null {
  const raw = Array.isArray(value) ? value[0] : value;
  if (typeof raw !== "string") return null;
  const tag = raw.trim();
  return TAG_PATTERN.test(tag) ? tag : null;
}

function touch(tag: string, at: number, change: { inFlight?: number; request?: boolean }): void {
  let record = records.get(tag);
  if (record === undefined) {
    if (records.size >= MAX_LANE_ACTIVITY_TAGS) {
      // Maps keep insertion order, and a touched record is re-inserted below, so the first key is
      // the least recently active tag.
      const oldest = records.keys().next().value;
      if (oldest !== undefined) records.delete(oldest);
    }
    record = { inFlight: 0, requests: 0, lastActivityAt: at };
  } else {
    records.delete(tag);
  }
  record.inFlight = Math.max(0, record.inFlight + (change.inFlight ?? 0));
  if (change.request) record.requests += 1;
  record.lastActivityAt = Math.max(record.lastActivityAt, at);
  records.set(tag, record);
}

/** A request with this tag started. Returns the calls for its writes and its end. */
export function beginLaneRequest(tag: string, now: () => number = Date.now): { wrote: () => void; ended: () => void } {
  touch(tag, now(), { inFlight: 1, request: true });
  let open = true;
  return {
    wrote: () => {
      if (open) touch(tag, now(), {});
    },
    ended: () => {
      if (!open) return;
      open = false;
      touch(tag, now(), { inFlight: -1 });
    },
  };
}

/** The record for a tag, or null when the daemon has none. */
export function readLaneActivity(tag: string): LaneTrafficRecord | null {
  const record = records.get(tag);
  return record === undefined ? null : { ...record };
}

/** Test seam: forget every tag. */
export function resetLaneActivity(): void {
  records.clear();
}
