import { type BackendConfig } from "./config.js";

/**
 * Fetch the backend and return its Anthropic-shaped `Response`. The backend must
 * speak Anthropic Messages natively (typically a LiteLLM proxy, which translates
 * to any provider); this proxy does no format translation. The only body
 * manipulation is the optional fixed-model rewrite from `backend.model`.
 */
export async function fetchBackend(
  target: BackendConfig,
  args: {
    path: string;
    method: string;
    reqBuf: Buffer;
    reqJson: unknown;
    anthropicHeaders: Record<string, string>;
    signal: AbortSignal;
  },
  fetchFn: typeof fetch = fetch,
): Promise<Response> {
  const init: RequestInit = { method: args.method, headers: args.anthropicHeaders, signal: args.signal };
  if (target.model && typeof args.reqJson === "object" && args.reqJson !== null) {
    init.body = JSON.stringify({ ...(args.reqJson as Record<string, unknown>), model: target.model });
  } else if (args.reqBuf.length) {
    init.body = args.reqBuf;
  }
  return fetchFn(target.base + args.path, init);
}
