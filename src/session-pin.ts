import { createHash } from "node:crypto";

export const STICKY_SESSION_HEADER = "x-llm-relay-session";
export const STICKY_PROVENANCE_HEADER = "x-llm-relay-sticky";
const CLAUDE_AGENT_ID_HEADER = "x-claude-code-agent-id";

export type SessionRequestHeaders = Readonly<Record<string, string | string[] | undefined>>;

export interface SessionPin {
  readonly targetSpec: string;
  readonly pinnedAt: number;
  lastUsedAt: number;
  useCount: number;
}

export interface StickySessionManagerOptions {
  ttlMs?: number;
  maxSessions?: number;
}

export const DEFAULT_STICKY_TTL_MS = 30 * 60 * 1000;
export const DEFAULT_STICKY_MAX_SESSIONS = 1000;

/** Ephemeral, metadata-only sliding-TTL session affinity. */
export class StickySessionManager {
  private readonly pins = new Map<string, SessionPin>();
  private readonly ttlMs: number;
  private readonly maxSessions: number;

  constructor(options: StickySessionManagerOptions = {}) {
    this.ttlMs = options.ttlMs ?? DEFAULT_STICKY_TTL_MS;
    this.maxSessions = options.maxSessions ?? DEFAULT_STICKY_MAX_SESSIONS;
  }

  getPin(key: string, now = Date.now()): string | null {
    const entry = this.pins.get(key);
    if (!entry) return null;
    if (now - entry.lastUsedAt > this.ttlMs) {
      this.pins.delete(key);
      return null;
    }
    entry.lastUsedAt = now;
    entry.useCount++;
    return entry.targetSpec;
  }

  setPin(key: string, targetSpec: string, now = Date.now()): void {
    if (!key || !targetSpec) return;
    this.pins.set(key, {
      targetSpec,
      pinnedAt: now,
      lastUsedAt: now,
      useCount: 1,
    });
    this.prune(now);
  }

  deletePin(key: string): void {
    this.pins.delete(key);
  }

  clear(): void {
    this.pins.clear();
  }

  private prune(now: number): void {
    if (this.pins.size <= this.maxSessions) return;

    for (const [key, entry] of this.pins) {
      if (now - entry.lastUsedAt > this.ttlMs) this.pins.delete(key);
    }
    if (this.pins.size <= this.maxSessions) return;

    const oldest = [...this.pins.entries()].sort((a, b) => a[1].lastUsedAt - b[1].lastUsedAt);
    const excess = this.pins.size - this.maxSessions;
    for (let index = 0; index < excess; index++) {
      this.pins.delete(oldest[index]![0]);
    }
  }
}

/**
 * Derive a session key without retaining request content.
 *
 * The only explicit base header is relay-owned and opt-in. No client session header is accepted
 * until this repository has evidence that the client actually emits it. Claude Code's documented
 * agent id is a qualifier only: it keeps a child from overwriting its parent's affinity.
 */
export function deriveSessionKey(headers: SessionRequestHeaders | undefined, reqJson: unknown): string | null {
  const agentId = normalizedHeader(headers, CLAUDE_AGENT_ID_HEADER);
  const explicit = normalizedHeader(headers, STICKY_SESSION_HEADER);
  if (explicit) return compound(`hdr:${explicit}`, agentId);

  const text = firstUserText(reqJson);
  if (text === null) return null;
  const hash = createHash("sha256").update(Buffer.from(text, "utf8")).digest("hex").slice(0, 16);
  return compound(`msg:${hash}`, agentId);
}

function compound(base: string, agentId: string | null): string {
  return agentId ? `${base}::${agentId}` : base;
}

function normalizedHeader(headers: SessionRequestHeaders | undefined, name: string): string | null {
  const raw = Object.entries(headers ?? {}).find(([header]) => header.toLowerCase() === name)?.[1];
  const value = Array.isArray(raw) ? raw[0] : raw;
  if (typeof value !== "string") return null;
  const normalized = value.trim();
  return normalized.length > 0 ? normalized : null;
}

function firstUserText(reqJson: unknown): string | null {
  if (typeof reqJson !== "object" || reqJson === null) return null;
  const body = reqJson as { messages?: unknown; input?: unknown };

  const messageText = firstUserMessageText(body.messages);
  if (messageText !== null) return messageText;

  if (typeof body.input === "string") return nonEmpty(body.input);
  return firstUserMessageText(body.input);
}

function firstUserMessageText(value: unknown): string | null {
  if (!Array.isArray(value)) return null;
  for (const item of value) {
    if (typeof item !== "object" || item === null || (item as { role?: unknown }).role !== "user") continue;
    return contentText((item as { content?: unknown }).content);
  }
  return null;
}

function contentText(content: unknown): string | null {
  if (typeof content === "string") return nonEmpty(content);
  if (!Array.isArray(content)) return null;

  const parts: string[] = [];
  for (const block of content) {
    if (typeof block !== "object" || block === null) continue;
    const typed = block as { type?: unknown; text?: unknown };
    // `text` is Anthropic/Chat; `input_text` is the public Responses request shape.
    if (typed.type !== "text" && typed.type !== "input_text") continue;
    if (typeof typed.text !== "string") continue;
    if (!typed.text.trim() || typed.text.trimStart().startsWith("<system-reminder>")) continue;
    parts.push(typed.text);
  }
  return parts.length > 0 ? nonEmpty(parts.join("\n")) : null;
}

function nonEmpty(text: string): string | null {
  const trimmed = text.trim();
  return trimmed.length > 0 ? trimmed : null;
}
