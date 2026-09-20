/**
 * MCP-side client for the daemon-owned lane execution broker (D1 infrastructure).
 *
 * This module is intentionally not wired into dispatch yet. It establishes the strict transport
 * boundary Phase 3 recovery will depend on: "daemon reachable and says unknown" is different from
 * "daemon could not be reached", and malformed success payloads never become death evidence.
 */
import { randomBytes } from "node:crypto";
import type { Config } from "../config.js";
import {
  createControlAuthorization,
  resolveControlAuthorizationConfigDir,
  type FileControlAuthorization,
} from "../control-authorization.js";
import {
  parseLaneExecutionSnapshot,
  type LaneExecutionBrokerRequest,
  type LaneExecutionSnapshot,
} from "../lane-execution-broker.js";

export const LANE_EXECUTION_CLIENT_TIMEOUT_MS = 5_000;

export type LaneExecutionClientFailureKind =
  | "unavailable"
  | "rejected"
  | "invalid-response";

export type LaneExecutionClientResult =
  | { ok: true; execution: LaneExecutionSnapshot }
  | {
      ok: false;
      kind: LaneExecutionClientFailureKind;
      /** HTTP status when a daemon answered; null for transport/auth setup failure. */
      status: number | null;
      message: string;
    };

export interface LaneExecutionClient {
  request(request: LaneExecutionBrokerRequest): Promise<LaneExecutionClientResult>;
}

export interface LaneExecutionClientDeps {
  fetch?: typeof fetch;
  authorization?: Pick<FileControlAuthorization, "attach">;
  timeoutMs?: number;
}

function brokerUrl(cfg: Pick<Config, "host" | "port">): string {
  const host = cfg.host.includes(":") ? `[${cfg.host}]` : cfg.host;
  return `http://${host}:${cfg.port}/mcp/lane-execution`;
}

function boundedErrorMessage(value: unknown, fallback: string): string {
  if (
    typeof value === "object" &&
    value !== null &&
    !Array.isArray(value) &&
    typeof (value as Record<string, unknown>)["error"] === "object" &&
    (value as Record<string, unknown>)["error"] !== null &&
    typeof ((value as Record<string, unknown>)["error"] as Record<string, unknown>)["message"] === "string"
  ) {
    const message = ((value as Record<string, unknown>)["error"] as Record<string, unknown>)["message"] as string;
    if (message.length > 0 && message.length <= 500) return message;
  }
  return fallback;
}

async function readJson(response: Response): Promise<unknown> {
  try {
    return await response.json();
  } catch {
    return undefined;
  }
}

function disabledTestFetch(): typeof fetch {
  return (async () => {
    throw new Error("lane broker HTTP is disabled under vitest — inject fetch");
  }) as typeof fetch;
}

/** Opaque 128-bit broker execution id; it carries no task/lane meaning. */
export function createLaneExecutionId(entropy: Uint8Array = randomBytes(16)): string {
  const bytes = Buffer.from(entropy);
  if (bytes.length !== 16) throw new Error("lane execution id entropy must be exactly 16 bytes");
  return `exec-${bytes.toString("hex")}`;
}

export function createLaneExecutionClient(
  cfg: Pick<Config, "host" | "port" | "sourcePath">,
  deps: LaneExecutionClientDeps = {},
): LaneExecutionClient {
  const requestFetch =
    deps.fetch ?? (process.env["VITEST"] ? disabledTestFetch() : fetch);
  const timeoutMs =
    Number.isSafeInteger(deps.timeoutMs) && (deps.timeoutMs ?? 0) > 0
      ? deps.timeoutMs!
      : LANE_EXECUTION_CLIENT_TIMEOUT_MS;

  let authorization: Pick<FileControlAuthorization, "attach"> | null =
    deps.authorization ?? null;
  let authorizationUnavailable = false;
  if (authorization === null) {
    try {
      authorization = createControlAuthorization(
        resolveControlAuthorizationConfigDir(cfg.sourcePath),
      );
    } catch {
      authorizationUnavailable = true;
    }
  }

  return {
    async request(request): Promise<LaneExecutionClientResult> {
      if (authorizationUnavailable || authorization === null) {
        return {
          ok: false,
          kind: "unavailable",
          status: null,
          message: "lane execution control authorization is unavailable",
        };
      }

      let response: Response;
      try {
        response = await requestFetch(brokerUrl(cfg), {
          method: "POST",
          headers: authorization.attach({ "content-type": "application/json" }),
          body: JSON.stringify(request),
          signal: AbortSignal.timeout(timeoutMs),
        });
      } catch {
        return {
          ok: false,
          kind: "unavailable",
          status: null,
          message: "running relay lane execution broker is unavailable",
        };
      }

      const payload = await readJson(response);
      if (!response.ok) {
        return {
          ok: false,
          kind: "rejected",
          status: response.status,
          message: boundedErrorMessage(
            payload,
            `lane execution broker rejected the request (HTTP ${response.status})`,
          ),
        };
      }

      if (
        typeof payload !== "object" ||
        payload === null ||
        Array.isArray(payload) ||
        Object.keys(payload as Record<string, unknown>).length !== 1 ||
        !Object.hasOwn(payload, "execution")
      ) {
        return {
          ok: false,
          kind: "invalid-response",
          status: response.status,
          message: "running relay returned an invalid lane execution response",
        };
      }
      const execution = parseLaneExecutionSnapshot(
        (payload as Record<string, unknown>)["execution"],
      );
      if (execution === null) {
        return {
          ok: false,
          kind: "invalid-response",
          status: response.status,
          message: "running relay returned an invalid lane execution snapshot",
        };
      }
      return { ok: true, execution };
    },
  };
}
