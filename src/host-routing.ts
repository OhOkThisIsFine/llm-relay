/**
 * Does the CALLING host's own LLM traffic reach this relay?
 *
 * `/dispatch` hands back an ordered ladder of lanes, and one rung kind — `relay` — assumes the
 * host can address a spec through this proxy as a subagent. That assumption is false in a Claude
 * Desktop session: the launcher pins `ANTHROPIC_BASE_URL=https://api.anthropic.com` into the
 * process environment, overriding both the User-scope variable and the `env` block of
 * `~/.claude/settings.json`. Every subagent-reroute mechanism then silently no-ops — the request
 * never arrives, so `routing.subagents` cannot fire and an `@relay:` directive reaches the real
 * Anthropic model as literal prompt text with nothing in the path to strip it.
 *
 * ⚠ **This must be evaluated in the CLI process, never in the server.** The relay cannot detect a
 * bypassing host at request time because there is no request — that is the entire problem. The
 * `llm-relay` CLI, by contrast, is a child of the session and inherits its environment. The server
 * was launched from `Startup` at logon, long before any session existed, so reading `process.env`
 * there answers a different question. The CLI computes the verdict and forwards it
 * (`GET /dispatch?host=…`); `buildDispatch` takes it as an argument and never sniffs for it.
 */

/**
 * `routed` — the host's traffic reaches a loopback proxy, so relay rungs work as written.
 * `bypassed` — it does not; anything needing the subagent-reroute path is dead for this host.
 * `unknown` — not a Claude harness at all, so there is no subagent mechanism to adapt to.
 */
export type HostRoutingState = "routed" | "bypassed" | "unknown";

export interface HostRouting {
  state: HostRoutingState;
  /** Harness name, for the MESSAGE only (`claude-desktop`). Never used to decide — see below. */
  entrypoint: string | null;
  /** Why `state` is what it is, in the operator's terms. */
  reason: string;
}

/** Values `host-routing` accepts as an explicit override (`llm-relay dispatch --host …`). */
export function parseHostRoutingState(value: string | undefined): HostRoutingState | null {
  return value === "routed" || value === "bypassed" || value === "unknown" ? value : null;
}

/**
 * Loopback check on the host component of a base URL.
 *
 * Deliberately "is it loopback", not "is it MY listen address". A proxy chain in front of this
 * relay is the normal, supported topology here — headroom on `:8787` forwarding to the relay on
 * `:8791` — so an equality test against `cfg.port` would classify a correctly routed session as
 * bypassed and transpose lanes that did not need it. Loopback is the honest question: traffic
 * aimed at this machine can reach this relay, directly or through a chain; traffic aimed at
 * `api.anthropic.com` provably cannot.
 */
function isLoopbackUrl(raw: string): boolean {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return false;
  }
  // URL keeps the brackets on an IPv6 literal; strip them before comparing.
  const host = url.hostname.replace(/^\[|\]$/g, "").toLowerCase();
  if (host === "localhost" || host === "::1" || host === "0:0:0:0:0:0:0:1") return true;
  // The whole 127.0.0.0/8 block is loopback, not just 127.0.0.1.
  return /^127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(host);
}

/** Trimmed value, or undefined when unset or blank — a blank env var is not a setting. */
function read(env: NodeJS.ProcessEnv, name: string): string | undefined {
  const value = env[name];
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

/**
 * Classify the calling host from its environment.
 *
 * The load-bearing signal is the base URL, NOT the entrypoint name. Deciding on
 * `CLAUDE_CODE_ENTRYPOINT === "claude-desktop"` would miss a terminal session that dropped its
 * env line (equally bypassed, for a different reason) and would break the moment the vendor
 * renames the entrypoint. The entrypoint is carried only so the message can say *which* host.
 */
export function detectHostRouting(env: NodeJS.ProcessEnv = process.env): HostRouting {
  const entrypoint = read(env, "CLAUDE_CODE_ENTRYPOINT") ?? null;
  const inHarness = read(env, "CLAUDECODE") !== undefined;
  const baseUrl = read(env, "ANTHROPIC_BASE_URL");
  const who = entrypoint ? `this host (${entrypoint})` : "this host";

  if (!inHarness) {
    return {
      state: "unknown",
      entrypoint,
      reason: "not running inside a Claude Code session — no subagent routing to adapt to",
    };
  }
  if (baseUrl !== undefined && isLoopbackUrl(baseUrl)) {
    return { state: "routed", entrypoint, reason: `${who} routes its traffic through a loopback proxy` };
  }
  return {
    state: "bypassed",
    entrypoint,
    reason:
      baseUrl === undefined
        ? `${who} has no ANTHROPIC_BASE_URL set — its traffic does not reach this relay`
        : `${who} sends its traffic to ${baseUrl}, not through this relay`,
  };
}
