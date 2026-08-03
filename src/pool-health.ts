/**
 * Pool liveness probing — `llm-relay pools [--probe]`.
 *
 * Nothing used to detect a dead pool member. A model can be listed in a provider's catalogue
 * and still refuse every request (de-listed behind the scenes, gated to a paid tier, or
 * routed to a function that no longer exists), so config-time validation cannot see it. The
 * observed failure mode: a pool whose top-ranked member 404'd on every call while the pool
 * looked healthy, leaving offload running on a single live model with failover that existed
 * only on paper.
 *
 * The only trustworthy signal is a real completion, so that is what `--probe` sends.
 */
import type { Config, ProviderConfig } from "./config.js";
import { splitSpec } from "./config.js";
import { buildAuthHeaders, readCredential } from "./authEnv.js";

export type MemberVerdict = "live" | "empty" | "auth" | "rate_limited" | "missing" | "error";

export interface MemberHealth {
  pool: string;
  spec: string;
  verdict: MemberVerdict;
  httpStatus?: number | undefined;
  latencyMs?: number | undefined;
  detail?: string | undefined;
}

/** Verdicts that mean "this member will never answer until someone changes something". */
export const DEAD_VERDICTS: ReadonlySet<MemberVerdict> = new Set<MemberVerdict>(["missing", "auth"]);

/**
 * Probe headers. The credential half comes from the shared builder — it obeys the DECLARED
 * `authHeader` (which `config.ts` already defaults to `x-api-key` for an anthropic-kind
 * provider) and returns nothing at all for an absent or whitespace-only key, so this site
 * cannot drift from the others. `anthropic-version` is a protocol header, not a credential,
 * so it stays here and is keyed off `kind` as before.
 */
function authHeaders(p: ProviderConfig, apiKey: string | undefined): Record<string, string> {
  return {
    "Content-Type": "application/json",
    ...(p.kind === "anthropic" ? { "anthropic-version": "2023-06-01" } : {}),
    ...buildAuthHeaders(apiKey, p.authHeader),
  };
}

/**
 * Send one real completion to a single pool member.
 *
 * `maxTokens` defaults to 400 rather than a token or two because reasoning models spend
 * their budget thinking: at a low cap they return a 200 with EMPTY content, which reads as
 * a broken model when it is only a truncated one.
 */
export async function probeMember(
  pool: string,
  spec: string,
  cfg: Config,
  fetchFn: typeof fetch = fetch,
  maxTokens = 400,
  now: () => number = Date.now,
): Promise<MemberHealth> {
  const { provider, model } = splitSpec(spec);
  const p = cfg.providers[provider];
  if (!p) {
    return { pool, spec, verdict: "missing", detail: `no provider "${provider}" configured` };
  }
  // `readCredential` treats a whitespace-only value as absent, so a key pasted as a blank
  // line is reported here as an auth problem instead of being sent as a bare `Bearer`.
  const apiKey = readCredential(p.authEnv);
  if (p.authEnv && !apiKey) {
    return { pool, spec, verdict: "auth", detail: `${p.authEnv} is not set` };
  }

  const isOpenAi = p.kind === "openai";
  const url = isOpenAi ? `${p.base}/chat/completions` : `${p.base}/v1/messages`;
  const body = JSON.stringify({
    model,
    max_tokens: maxTokens,
    messages: [{ role: "user", content: "Reply with exactly: OK" }],
  });

  const started = now();
  try {
    const r = await fetchFn(url, { method: "POST", headers: authHeaders(p, apiKey), body });
    const latencyMs = now() - started;
    if (r.status === 401 || r.status === 403) {
      return { pool, spec, verdict: "auth", httpStatus: r.status, latencyMs, detail: `HTTP ${r.status}` };
    }
    if (r.status === 429) {
      return { pool, spec, verdict: "rate_limited", httpStatus: 429, latencyMs, detail: "HTTP 429" };
    }
    if (r.status === 404 || r.status === 400) {
      return { pool, spec, verdict: "missing", httpStatus: r.status, latencyMs, detail: `HTTP ${r.status} — model not servable` };
    }
    if (!r.ok) {
      return { pool, spec, verdict: "error", httpStatus: r.status, latencyMs, detail: `HTTP ${r.status}` };
    }
    const text = await r.text();
    const content = extractContent(text);
    if (content.trim().length === 0) {
      return { pool, spec, verdict: "empty", httpStatus: r.status, latencyMs, detail: "200 but no content" };
    }
    return { pool, spec, verdict: "live", httpStatus: r.status, latencyMs };
  } catch (e) {
    return { pool, spec, verdict: "error", latencyMs: now() - started, detail: (e as Error).message };
  }
}

/** Pull assistant text out of either an OpenAI or an Anthropic shaped response. */
export function extractContent(raw: string): string {
  try {
    const j = JSON.parse(raw) as {
      choices?: { message?: { content?: unknown } }[];
      content?: { type?: string; text?: string }[];
    };
    const openai = j.choices?.[0]?.message?.content;
    if (typeof openai === "string") return openai;
    if (Array.isArray(j.content)) {
      return j.content
        .filter((b) => b?.type === "text" && typeof b.text === "string")
        .map((b) => b.text as string)
        .join("");
    }
  } catch {
    /* fall through */
  }
  return "";
}

/**
 * Probe every member of every pool. Concurrency-limited so a wide config can't fan out unbounded.
 *
 * A dynamic catalog target commonly belongs to several pools. Probe each unique provider/model
 * deployment once, then project that result back onto every pool membership. Membership reporting
 * remains complete without charging the provider for duplicate completions in the same command.
 */
export async function probeAllPools(
  cfg: Config,
  fetchFn: typeof fetch = fetch,
  concurrency = 4,
): Promise<MemberHealth[]> {
  const jobs: { pool: string; spec: string }[] = [];
  const uniqueJobs = new Map<string, { pool: string; spec: string }>();
  for (const [pool, members] of Object.entries(cfg.routing.pools ?? {})) {
    for (const spec of members) {
      const job = { pool, spec };
      jobs.push(job);
      if (!uniqueJobs.has(spec)) uniqueJobs.set(spec, job);
    }
  }

  const probes = [...uniqueJobs.values()];
  const bySpec = new Map<string, MemberHealth>();
  let next = 0;
  const workers = Array.from({ length: Math.max(1, Math.min(concurrency, probes.length)) }, async () => {
    for (;;) {
      const i = next++;
      if (i >= probes.length) return;
      const job = probes[i]!;
      bySpec.set(job.spec, await probeMember(job.pool, job.spec, cfg, fetchFn));
    }
  });
  await Promise.all(workers);
  return jobs.map((job) => ({ ...bySpec.get(job.spec)!, pool: job.pool }));
}
