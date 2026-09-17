---
title: "Sticky Sessions with Guardrails — Architectural Design (Item 2.2)"
date: 2026-08-14
status: advisory
authoring_lane: "Gemini 3.7 Flash via AGY"
caveat: "This is an ADVISORY lane deliverable. File:line claims must be re-verified at implementation time."
---

# Sticky Sessions with Guardrails — Architectural Design (Item 2.2)

**Status:** Proposed  
**Date:** 2026-08-14  
**Target:** `C:\Code\llm-relay` (`src/server.ts`, `src/config.ts`, `src/circuit-breaker.ts`, `src/session-pin.ts`)  
**Scope:** In-memory, metadata-only session affinity for pool and tier candidate ordering across turn sequences, bounded by circuit health and credential state.

---

## 1. Session Key Derivation

Session affinity requires a deterministic, low-overhead session identifier extracted on the request path. When clients provide explicit session markers, the proxy uses them directly. In their absence, it falls back to a deterministic cryptographic hash of the first user message.

### 1.1 Inbound Header Identification Ladder

Clients connecting to `llm-relay` (`claude` CLI, Claude Desktop via wrappers, Codex CLI, OpenAI-compatible IDEs) send distinct headers depending on their client harness.

The proxy evaluates the following case-insensitive header precedence ladder:

```
┌──────────────────────────────────────────────────────────────────┐
│ 1. x-claude-code-session-id                                     │
│    (Claude Code primary session ID)                              │
├──────────────────────────────────────────────────────────────────┤
│ 2. x-session-id                                                  │
│    (Standard Anthropic SDK / generic proxy session identifier)   │
├──────────────────────────────────────────────────────────────────┤
│ 3. x-codex-turn-metadata                                         │
│    (JSON header; extract `session_id`, `thread_id`, or `conv_id`)│
├──────────────────────────────────────────────────────────────────┤
│ 4. Fallback: First User Message Hash                             │
│    (Computed over normalized prompt text)                        │
└──────────────────────────────────────────────────────────────────┘
```

#### Client Specifics:
1. **Claude Code (`claude` CLI):**
   - **Header:** `x-claude-code-session-id` (UUID format, e.g., `8a7d1e02-4b21-4d1a-9f5e-2b6c8a7d1e02`).
   - **Subagent Requests:** When Claude Code forks a subagent, it sends `x-claude-code-agent-id` alongside `x-claude-code-session-id`. To prevent a subagent's offload tier from clobbering the interactive parent session's pin, compound keys are formed:
     $$\text{key} = \text{`hdr:`} + \text{session\_id} + (\text{agent\_id ? `::` + agent\_id : `''`})$$
2. **Generic Anthropic SDK / Proxy Clients:**
   - **Header:** `x-session-id`.
   - Maps directly to `hdr:<session-id>`.
3. **Codex / OpenAI Responses Front:**
   - **Header:** `x-codex-turn-metadata` (already parsed in `src/config.ts` for subagent detection).
   - If present, parse JSON defensively and check for `session_id`, `conversation_id`, or `thread_id`.
   - If missing, fall through to message hash fallback.

---

### 1.2 First-User-Message Hash Fallback

When no session header is present, multi-turn conversations are identified by hashing the immutable first user prompt that opens the conversation history.

#### Message Traversal & Content Extraction:
1. **Locate First User Message:**
   - In `/v1/messages` (Anthropic format): find `messages.find(m => m.role === 'user')`.
   - In `/v1/chat/completions` (OpenAI format): find `messages.find(m => m.role === 'user')`.
   - In `/v1/responses` (OpenAI Responses format): inspect `input` or `messages`.
2. **Extract Prompt Text:**
   - If `content` is a `string`: use `content.trim()`.
   - If `content` is an `Array<ContentBlock>`:
     - Filter blocks where `block.type === 'text'`.
     - Skip Claude Code injected system-reminder blocks (e.g. starting with `<system-reminder>`).
     - Concatenate remaining text blocks with `\n`.
   - If no text blocks exist (e.g., pure image/document turn), return `null` (no pin created).
3. **Hash Algorithm & Format:**
   - **Algorithm:** `sha256` via `node:crypto` (`createHash('sha256')`). SHA-256 avoids legacy SHA-1 deprecation warnings and executes in $<2\,\mu\text{s}$ for typical prompts.
   - **Exact Input Bytes:** Raw UTF-8 bytes of the extracted text string (`Buffer.from(text, 'utf8')`).
   - **Truncation:** First 16 hexadecimal characters (64 bits). 64 bits yields $< 10^{-6}$ collision probability for $>10^5$ lifetime turns per single-user instance while minimizing key length.
   - **Prefix:** `msg:<hash16>` (e.g., `msg:3a9f0b12c8e4d7a1`).

#### Invariant: Zero Content Retention
> **Metadata-Only Enforcement:** The prompt text is read only in transient stack variables during key derivation and immediately discarded. The proxy never stores message text, tokens, or responses in the session map or logs—only the 16-character hex hash string is retained.

---

## 2. Data Structure, Eviction, and Lifecycle

The session store is a lightweight, bounded in-memory structure attached to the proxy server instance (`Handlers`).

### 2.1 Map Shape & Type Definitions

```ts
// src/session-pin.ts

export interface SessionPin {
  readonly targetSpec: string; // e.g., "openrouter/anthropic/claude-3.5-sonnet" or "p2/m2"
  readonly pinnedAt: number;   // Timestamp ms when pin was first created
  lastUsedAt: number;         // Timestamp ms of most recent turn match
  useCount: number;           // Number of turns served under this pin
}

export interface StickySessionManagerOptions {
  ttlMs?: number;             // Default: 30 * 60 * 1000 (30 minutes)
  maxSessions?: number;       // Default: 1000 entries
}
```

```ts
export class StickySessionManager {
  private readonly pins = new Map<string, SessionPin>();
  private readonly ttlMs: number;
  private readonly maxSessions: number;

  constructor(opts: StickySessionManagerOptions = {}) {
    this.ttlMs = opts.ttlMs ?? 30 * 60 * 1000;
    this.maxSessions = opts.maxSessions ?? 1000;
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

  private prune(now: number): void {
    if (this.pins.size <= this.maxSessions) return;

    // Phase 1: Evict expired entries
    for (const [k, v] of this.pins.entries()) {
      if (now - v.lastUsedAt > this.ttlMs) {
        this.pins.delete(k);
      }
    }

    // Phase 2: LRU capacity eviction if still over threshold
    if (this.pins.size > this.maxSessions) {
      const sorted = [...this.pins.entries()].sort(
        (a, b) => a[1].lastUsedAt - b[1].lastUsedAt,
      );
      const excess = this.pins.size - this.maxSessions;
      for (let i = 0; i < excess; i++) {
        this.pins.delete(sorted[i]![0]);
      }
    }
  }

  clear(): void {
    this.pins.clear();
  }
}
```

### 2.2 Lifecycle & Memory Bounds
- **TTL Duration:** 30 minutes of inactivity (`30 * 60 * 1000` ms). Each turn matching the key resets `lastUsedAt`.
- **Memory Footprint:** At the 1,000-session hard cap, `Map<string, SessionPin>` consumes $\approx 120\text{ KB}$ of heap, well below any GC pressure threshold.
- **Persistence Across Restart:** **NO (Ephemeral Only).**
  - *Justification:*
    1. *Architectural consistency:* `llm-relay` separates durable learned state (`~/.llm-relay/*.json`) from ephemeral operational state (in-flight attempt lifecycle, breaker leases).
    2. *Staleness risk:* After a relay restart or network change, previously pinned remote targets may be unauthenticated or cooling. Retaining stale pins across boots would trap sessions on degraded backends.
    3. *Session scope:* Client processes (e.g. `claude` CLI) rarely survive host reboot. Persisting pins would produce ghost mappings.

---

## 3. Integration Point & Health Hierarchy Guarantee

### 3.1 Candidate Ordering Flow

In `src/server.ts`, candidate resolution proceeds as follows:
1. `resolveTargets(targetCandidates, ...)` resolves pool/tier definitions into `ResolvedTarget[]` sorted by deployment fitness (benchmark score + configured preference).
2. `orderByUsability(targetCandidates, h.breaker)` categorizes candidates into three distinct tiers:
   - `live`: Breaker closed, no standing 401/403, not cooled by allowance exhaustion.
   - `faulted`: Breaker recorded standing 401/403 credential fault.
   - `cooling`: Breaker open (429, 402, consecutive 5xx/transport failures, or learned quota cooldown).

```
   ┌────────────────────────────────────────────────────────────────────────────┐
   │                        Resolved Candidates (Fitness Order)                 │
   └─────────────────────────────────────┬──────────────────────────────────────┘
                                         ▼
   ┌────────────────────────────────────────────────────────────────────────────┐
   │                  Partition via `orderByUsability()`                        │
   │   ┌──────────────────────┬──────────────────────┬──────────────────────┐   │
   │   │     Live Tier        │     Faulted Tier     │     Cooling Tier     │   │
   │   │ (Healthy / Breaker OK)│  (Standing 401/403)  │  (429 / 402 / Cooled)│   │
   │   └──────────┬───────────┴──────────────────────┴──────────────────────┘   │
   └──────────────┼─────────────────────────────────────────────────────────────┘
                  ▼
   ┌────────────────────────────────────────────────────────────────────────────┐
   │                  Sticky Pin Reordering (LIVE TIER ONLY)                    │
   │   If pinned candidate is present in Live Tier:                             │
   │     Promote to head of Live Tier; other Live candidates preserve order.    │
   │   If pinned candidate is in Faulted or Cooling:                            │
   │     PIN IGNORED. Live Tier unchanged. Breaker wins unconditionally.        │
   └──────────────┬─────────────────────────────────────────────────────────────┘
                  ▼
   ┌────────────────────────────────────────────────────────────────────────────┐
   │ Final Walk Order: [...Reordered Live, ...Faulted, ...Cooling]              │
   └────────────────────────────────────────────────────────────────────────────┘
```

### 3.2 Exact Code Integration in `src/server.ts`

Candidate reordering occurs in `server.ts` immediately after `orderByUsability()` and before the context guardrail and candidate walk loops:

```ts
// src/server.ts (around lines 472-475)

// 1. Partition by breaker and credential health
let healthyTargets = orderByUsability(targetCandidates, h.breaker);

// 2. Apply Sticky Session Pin (constrained strictly to the live band)
let stickyProvenance: string | null = null;
const sessionKey = deriveSessionKey(req, reqJson);

if (sessionKey && cfg.routing.sticky) {
  const pinnedSpec = h.stickySessions.getPin(sessionKey);
  if (pinnedSpec) {
    // Determine the boundary of the live tier
    const liveCount = countLiveTargets(targetCandidates, h.breaker);
    const liveIndex = healthyTargets.slice(0, liveCount).findIndex(
      (t) => specOfTarget(t) === pinnedSpec
    );

    if (liveIndex > 0) {
      // Pinned member is live and not already first: promote to head of live tier
      const pinnedTarget = healthyTargets[liveIndex]!;
      healthyTargets.splice(liveIndex, 1);
      healthyTargets.unshift(pinnedTarget);
      stickyProvenance = `${pinnedSpec} (pinned, reordered)`;
    } else if (liveIndex === 0) {
      stickyProvenance = `${pinnedSpec} (pinned, natural)`;
    } else {
      // Pinned member is cooling, faulted, or missing from candidates -> bypass pin
      stickyProvenance = `${pinnedSpec} (bypassed: ${getTargetHealthState(pinnedSpec, h.breaker)})`;
    }
  }
}
```

### 3.3 Structural Invariant: Stickiness Never Resurrects Degraded Candidates

Because `liveIndex` is searched strictly within `healthyTargets.slice(0, liveCount)`:
- A target that is **cooling** ($429, 402, 5\text{xx}$) or **faulted** ($401, 403$) is located at or after `liveCount`.
- Its `liveIndex` evaluates to `-1`.
- The proxy skips promotion, logs the bypass, and serves from the healthy live tier in natural fitness order.
- **Result:** Health and circuit breaker ordering strictly dominate session affinity.

### 3.4 Terminal Pin Update on Success

When candidate $i$ successfully serves the turn (status $< 400$ or valid stream completion):
```ts
if (sessionKey && cfg.routing.sticky && upstream.status < 400) {
  h.stickySessions.setPin(sessionKey, specOfTarget(target));
}
```
If a previously pinned member failed and failover walked to a healthy backup, the pin automatically rebinds to the new successful target for subsequent turns.

---

## 4. Provenance Header Specification

To satisfy transparency and logging invariants (CLAUDE.md), every request where sticky session affinity influenced routing or was evaluated must announce its state on the wire.

### 4.1 Header Name
```
x-llm-relay-sticky
```

### 4.2 Value Syntax & Semantics

The header value adheres to the standard `spec (status[, details])` pattern used by `x-llm-relay-degraded` and `x-llm-relay-paid`:

| Value Pattern | Condition | Description |
|---|---|---|
| `<spec> (pinned, reordered)` | Pinned member was promoted to index 0 of the live tier | Stickiness actively reordered candidates to preserve session affinity. |
| `<spec> (pinned, natural)` | Pinned member was already index 0 in fitness order | Stickiness matched the natural top-ranked candidate. |
| `<spec> (bypassed: cooling)` | Pinned member is in circuit breaker cooldown (429/402/5xx) | Pin ignored; healthy live candidate served instead. |
| `<spec> (bypassed: credential-fault)` | Pinned member has a standing 401/403 fault | Pin ignored; healthy live candidate served instead. |
| `<spec> (bypassed: not-in-pool)` | Pinned member is not present in the current pool/tier | Pin ignored; requested pool candidates served. |
| `<spec> (new)` | First turn of a session; pin initialized | Initial pin established for subsequent turns. |

### 4.3 Emission Points
- **Anthropic Messages (`/v1/messages`):** Set on `transparentPath`, `repairBufferedPath`, and `repairStreamingPath` via `filterResponseHeaders()`.
- **OpenAI Front (`/v1/chat/completions` & `/v1/responses`):** Attached to `headers` map in `openAiFrontPath` alongside `x-llm-relay-served-by`.

---

## 5. Config Surface & Validation

### 5.1 Config Schema Extension (`src/config.ts`)

Sticky sessions live under `config.routing.sticky`:

```ts
// src/config.ts

export interface StickyRoutingConfig {
  enabled: boolean;
  ttlMs?: number;        // Default: 1800000 (30 min)
  maxSessions?: number;  // Default: 1000
}

export type StickyConfig = boolean | StickyRoutingConfig;

export interface Routing {
  default: string | string[];
  tiers: Record<string, string | string[]>;
  pools?: Record<string, string[]>;
  poolPolicies?: Record<string, PoolPolicy>;
  poolDegraded?: Record<string, string[]>;
  subagents?: Record<string, string>;
  offload?: OffloadConfig;
  benchmarkSort?: boolean;
  sticky?: StickyConfig;  // New field
  ladder?: LadderRung[];
  ladders?: Record<string, LadderRung[]>;
  cliLane?: CliLaneTemplate;
}
```

### 5.2 Default Value Justification: `false` (Opt-In)

**Recommendation: `false` by default.**

#### Justification:
1. **Adoption Review Consensus (§2.2 & §4):** Codex specifically noted that hidden request-to-request state can inadvertently lock a session onto a lower-performing backend if capacity on a superior backend recovers mid-session.
2. **Predictability Invariant:** In `llm-relay`, routing is explicit and deterministic from configuration. Implicit hidden state across requests must be explicitly chosen by the operator.
3. **Consistency with `routing.offload`:** `routing.offload` defaults to `false` (`Offload is off by default. An absent routing.offload and legacy false are off`). `routing.sticky` follows this exact house convention.

### 5.3 Config Validation (`parseRouting` in `src/config.ts`)

Validation enforces strict boundary checks:
```ts
function parseSticky(raw: unknown): StickyRoutingConfig | undefined {
  if (raw === undefined || raw === null) return undefined;
  if (typeof raw === "boolean") {
    return { enabled: raw, ttlMs: 1800000, maxSessions: 1000 };
  }
  if (typeof raw !== "object" || Array.isArray(raw)) {
    throw new Error(`config.routing.sticky must be a boolean or an object`);
  }
  const s = raw as Record<string, unknown>;
  if (typeof s.enabled !== "boolean") {
    throw new Error(`config.routing.sticky.enabled must be a boolean`);
  }
  let ttlMs = 1800000;
  if (s.ttlMs !== undefined) {
    if (typeof s.ttlMs !== "number" || !Number.isFinite(s.ttlMs) || s.ttlMs < 1000 || s.ttlMs > 86400000) {
      throw new Error(`config.routing.sticky.ttlMs must be between 1000 and 86400000 ms (1s to 24h)`);
    }
    ttlMs = Math.floor(s.ttlMs);
  }
  let maxSessions = 1000;
  if (s.maxSessions !== undefined) {
    if (typeof s.maxSessions !== "number" || !Number.isFinite(s.maxSessions) || s.maxSessions < 10 || s.maxSessions > 100000) {
      throw new Error(`config.routing.sticky.maxSessions must be an integer between 10 and 100000`);
    }
    maxSessions = Math.floor(s.maxSessions);
  }
  return { enabled: s.enabled, ttlMs, maxSessions };
}
```

---

## 6. Interaction Matrix with Other Routing Systems

| Subsystem | Conflict Scenario | Winner | Resolution Mechanism |
|---|---|---|---|
| **`freeOnly` Guardrail** | Session pinned to paid member `A`. Client offload rule has `freeOnly: true`. | **`freeOnly`** | `freeOnly` filtering runs inside `resolveTargets` *before* candidate ordering. Target `A` is pruned before `orderByUsability` and sticky reordering ever see it. |
| **Degraded Tail (`poolDegraded`)** | Session was pinned to a member in the degrade tail. Top-band effort members are now healthy. | **Top Effort Band** | Candidate tiers are partitioned by band before stickiness. Sticky reordering only shifts candidates *within* the same effort band. Degrade tail candidates remain behind live primary-band candidates. |
| **Request-Scoped Provider Skip (Adoption 1.6)** | Pinned target `A` on provider `P` suffers a socket/connect transport error on attempt 0. | **Provider Skip** | `dropRemainingSameProvider()` strips all remaining `P/*` candidates from `healthyTargets` for the rest of that request walk. Stickiness cannot re-inject `P`. |
| **Circuit Breaker Rate Limit (429 / 402)** | Pinned target `A` is cooling due to 429 cooldown or 402 credit exhaustion. | **Circuit Breaker** | `orderByUsability` places cooling targets in the tail tier ($i \ge \text{liveCount}$). Stickiness ignores non-live targets and emits `(bypassed: cooling)`. |
| **Credential Fault (401 / 403)** | Pinned target `A` has an invalid/expired key. | **Circuit Breaker (Credential Axis)** | `orderByUsability` places faulted targets in the faulted tier. Stickiness ignores faulted targets and emits `(bypassed: credential-fault)`. |
| **Prompt `@relay:` Directive** | Request carries `@relay: pool/fast`, but prior turn pinned a member from `pool/coding`. | **`@relay:` Directive** | `@relay:` selects the target pool. If the pinned member is not in the newly selected pool, stickiness is bypassed `(bypassed: not-in-pool)`. |

---

## 7. Comprehensive Test Plan

Tests follow the house style established in `test/pool-failover.test.ts`: real `node:http` servers on ephemeral loopback ports (`127.0.0.1:0`), scripted request counts, `globalCircuitBreaker.reset()`, and explicit wire header assertions.

### 7.1 Test Matrix (`test/sticky-sessions.test.ts`)

| # | Case | Scripted Backend Setup | Request Sequence | Assertions | Guardrail Verified |
|---|---|---|---|---|---|
| 1 | **Header-Keyed Affinity Pin** | `p1` (rank 1), `p2` (rank 2). Both return 200 `OK`. | Turn 1: `x-claude-code-session-id: s1`.<br>Turn 2: same header. | Turn 1 serves `p1/m1`. Turn 2 serves `p1/m1`. `x-llm-relay-sticky: p1/m1 (pinned, natural)` on Turn 2. | Basic header affinity |
| 2 | **Live Tier Reordering** | `p1` returns 429 on Turn 1; `p2` returns 200.<br>Turn 2: `p1` cooldown expires (both live). | Turn 1: `x-session-id: s2` (fails over to `p2`).<br>Turn 2: `x-session-id: s2`. | Turn 1 serves `p2/m2`. Turn 2 calls `p2` FIRST despite `p1` having higher benchmark fitness. `x-llm-relay-sticky: p2/m2 (pinned, reordered)` on wire. | Stickiness reorders within live tier |
| 3 | **Prompt Hash Fallback** | `p1` (rank 1), `p2` (rank 2). Both return 200. No headers. | Turn 1: `messages: [{ role: 'user', content: 'Design auth' }]`.<br>Turn 2: multi-turn history starting with exact same message. | Turn 2 computes identical prompt hash and routes to `p1/m1`. `x-llm-relay-sticky: p1/m1 (pinned, natural)`. | Message hash derivation without headers |
| 4 | **Session Isolation** | `p1`, `p2` both 200. Session A pinned to `p2`. | Turn 1: Session A (`hdr: A`) pinned to `p2`.<br>Turn 2: Session B (`hdr: B`) arrives fresh. | Session B is routed to natural top candidate `p1/m1`, uninfluenced by Session A's pin. | Clean multi-session partition |
| 5 | **Breaker Cooldown Dominance** | Session pinned to `p2`. `p2` receives 429 on concurrent probe (breaker open, cooling). | Request with Session pin arrives. | `p2` is cooling $\rightarrow$ pin ignored. `p1` is called and serves. `x-llm-relay-sticky: p2/m2 (bypassed: cooling)`. | **Stickiness always loses to Breaker** |
| 6 | **Credential Fault Dominance** | Session pinned to `p1`. `p1` key revoked (401). | Request with Session pin arrives. | `p1` is faulted $\rightarrow$ demoted. `p2` is called and serves. Pin updates to `p2/m2`. `x-llm-relay-sticky: p1/m1 (bypassed: credential-fault)`. | **Credential faults outrank Stickiness** |
| 7 | **30-Minute Inactivity Expiry** | Session pinned to `p2` at $t_0$. | Virtual clock advances to $t_0 + 31\text{ min}$. Next turn arrives. | Pin has expired and is pruned. Request falls back to natural candidate `p1/m1`. | TTL expiration cleanup |
| 8 | **Memory Bound (1,000 Hard Cap)** | Script 1,000 distinct session pins into manager. | Add 1,001st session key. | Map size strictly capped at 1,000. Oldest unaccessed pin evicted via LRU. | Bounded memory footprint |
| 9 | **`freeOnly` Filter Dominance** | Session pinned to paid member `p2`. Request has `freeOnly: true`. | Turn arrives with `freeOnly: true`. | `p2` is pruned during cost assessment. Free member `p1` serves. `p2` never called. | `freeOnly` outranks Stickiness |
| 10 | **Transport Skip Dominance** | Session pinned to `p1/m1`. `p1` socket hangs/resets. | Request attempts `p1/m1` $\rightarrow$ transport error. | `dropRemainingSameProvider` drops all `p1/*`. Walk continues to `p2/m2`. No repeat hops to `p1`. | Request-local transport skip outranks pin |
| 11 | **Zero Body Retention Assertion** | Request with $500\text{ KB}$ user prompt. | Inspect `stickySessions` heap state after turn. | Map entry key contains only 16-char hex hash; no prompt text or payload stored in heap. | Metadata-only log/state invariant |
| 12 | **OpenAI & Anthropic Front Convergence** | Multi-turn chat across `/v1/messages` and `/v1/chat/completions`. | Parallel requests with identical session IDs. | Both fronts derive identical keys, reorder live tier identically, and emit `x-llm-relay-sticky`. | Cross-front policy convergence |

---

## 8. Open Implementation Notes

1. **Subagent Session Key Compounding:**  
   When Claude Code spawns a subagent, `req.headers` contains both `x-claude-code-session-id` and `x-claude-code-agent-id`. The implementation should compound these into `hdr:<session-id>::<agent-id>`. This ensures an offloaded subagent running on a fast pool does not steal or overwrite the interactive parent session's pin.
2. **Streaming Response Head Timing:**  
   On `/v1/messages` streaming, `writeHead()` occurs at first chunk arrival. The sticky provenance header must be included in `filterResponseHeaders()` before `res.writeHead()` is committed.
3. **No Dynamic Pool Mutation:**  
   Session affinity operates exclusively as an ephemeral runtime index-sort over the resolved candidate slice. It must never mutate the underlying `Config.routing.pools` or dynamic pool catalog definitions.

---

## Orchestrator amendments (binding)

These implementation-time amendments override the advisory design above:

1. **Use an evidence-based header ladder.** Accept the relay-defined, documented
   `x-llm-relay-session` header, compound it with `x-claude-code-agent-id` when present, and
   otherwise fall back to the first-user-message SHA-256 hash. Do not add the design's unverified
   `x-claude-code-session-id`, `x-session-id`, or `x-codex-turn-metadata` session rungs.
2. **A pin never crosses the degrade boundary.** It may only promote a candidate within the same
   live routing segment. When any live in-band candidate exists, a pin in a pool's degrade tail is
   bypassed with `bypassed: degraded`; breaker, credential, and transport health continue to win.
3. **Test retained-state shape, not the heap.** Replace the proposed heap inspection with an
   assertion that a hash-keyed stored entry contains only the 16-hex-character hash key, target
   spec, timestamps, and use count, with no fragment of the prompt text.
4. **Do not pin single-spec routes.** Create or update affinity only after a successful
   multi-candidate pool or multi-spec resolution; a single-spec route has no routing choice to
   preserve.

