/**
 * Cross-process lock policy for the MCP journal/archive.
 *
 * These files are shared by independently launched MCP processes. Their mutations are synchronous
 * and tiny, but host/full-suite contention can legitimately keep the lock busy for longer than the
 * storage layer's generic 5 s default. A timed-out journal write is intentionally best-effort and
 * therefore becomes a silently lost job row, violating the shared-persistence property.
 *
 * Keep this policy scoped to MCP persistence rather than changing every JSON store user.
 */
export const MCP_PERSISTENCE_LOCK = Object.freeze({
  timeoutMs: 30_000,
});
