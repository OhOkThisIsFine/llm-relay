/**
 * MODULE CHARTER: Per-Request Accounting Lifecycle & Price Port Bridge (accounting-state.ts)
 *
 * 1. Domain Boundary & Responsibilities:
 *    - Coordinates the per-request accounting lifecycle for all caller-visible proxy routes.
 *    - Accumulates token metrics across multiple candidate attempts, failover walks, and streaming responses.
 *    - Decouples pricing metadata and model catalog resolution from low-level storage mutation logic.
 *
 * 2. Request Accounting Lifecycle:
 *    - Initiation: `createRequestAccountingState()` establishes request identity, timing, and caller attribution.
 *    - Attempt Recording: Each backend egress records attempt start, headers arrival, streaming deltas, or premature error.
 *    - Completion: Upon stream finish or error, `commit()` resolves final token usage, prices attempts via the price port,
 *      and submits immutable `AccountingEvent` records to the registered `AccountingRecorder`.
 *
 * 3. Price Port Decoupling:
 *    - Pricing logic is encapsulated via `AccountingPricePort` functional interfaces.
 *    - Tier models and pricing rates are resolved from `tier-data.js` and `metadata.js` at runtime without locking the store.
 *    - Missing or unpriced models gracefully emit unpriced token facts without halting accounting pipelines.
 *
 * 4. Caller Attribution & Path Classification:
 *    - Routes are filtered via `isCallerVisibleAccountingPath()` to exclude health, models, and administrative endpoints.
 *    - Attributions cleanly distinguish relay-held infrastructure actions from caller-operated interactions.
 */
import type { ServerResponse } from "node:http";
import type { Config } from "./config.js";
import type { ModelCatalog } from "./catalog.js";
import { loadTierData, findTierModel, type TierModel } from "./tier-data.js";
import { resolveMetadata } from "./metadata.js";
import {
  createAccountingRequest,
  type AccountingAttempt,
  type AccountingPricePort,
  type AccountingRecorder,
  type AccountingRequest,
  type TokenFactsInput,
} from "./accounting.js";
import { createUsageAccumulator, type UsageAccumulator } from "./usage-observer.js";
import type { ResolvedAttempt } from "./resolved-attempt.js";
import type { Reshaper, ReshaperAccountingHooks } from "./reshaper.js";

export type ModelCallRecorder = (
  providerKey: string,
  modelId: string,
  callResult: { ok: boolean; latencyMs: number; completionTokens?: number },
) => void;

export type ProxyAccountingAttribution = "relay_held" | "caller_operated" | "unknown";
export type ProxyAccountingFailureKind = "timeout" | "provider_error" | "auth_error" | "rate_limit" | "aborted" | "protocol" | "unknown";

export function isCallerVisibleAccountingPath(method: string | undefined, pathname: string): boolean {
  if (method !== "POST") return false;
  return pathname === "/v1/messages"
    || pathname === "/v1/chat/completions"
    || pathname === "/chat/completions"
    || pathname === "/v1/responses"
    || pathname === "/responses";
}

export function recordEarlyTerminalAccounting(
  recorder: AccountingRecorder,
  startedAt: number,
  client: string,
): void {
  try {
    createAccountingRequest({ recorder, startedAt, client }).complete({
      outcome: "error",
      failureKind: "unknown",
      attribution: "unknown",
      endedAt: Date.now(),
    });
  } catch {
    // Accounting is observational and must never change caller traffic.
  }
}

export function serveAccountingAttribution(attempt: ResolvedAttempt): ProxyAccountingAttribution {
  if (attempt.credential.state === "declared-present") return "relay_held";
  if (attempt.credential.state === "not-declared" && attempt.target.credentialMode !== "contained") {
    return "caller_operated";
  }
  return "unknown";
}

export function repairAccountingAttribution(state: ResolvedAttempt["credential"]["state"]): ProxyAccountingAttribution {
  return state === "declared-present" ? "relay_held" : "unknown";
}

export function accountingTokens(
  usage: UsageAccumulator,
  estimatedInputTokens: number,
  includeEstimatedOutput: boolean,
): TokenFactsInput {
  const estimatedOutputTokens = includeEstimatedOutput ? usage.estimatedOutputTokens : undefined;
  const hasEstimatedOutput = typeof estimatedOutputTokens === "number"
    && Number.isSafeInteger(estimatedOutputTokens)
    && estimatedOutputTokens > 0;
  const estimated = {
    ...(estimatedInputTokens > 0
      ? { inputTokens: estimatedInputTokens, inputMethod: "relay_estimate" }
      : {}),
    ...(hasEstimatedOutput
      ? { outputTokens: estimatedOutputTokens, outputMethod: "relay_estimate" }
      : {}),
  };
  return {
    reported: {
      ...(usage.inputTokens !== undefined ? { inputTokens: usage.inputTokens } : {}),
      ...(usage.outputTokens !== undefined ? { outputTokens: usage.outputTokens } : {}),
      ...(usage.cachedInputTokens !== undefined ? { cachedInputTokens: usage.cachedInputTokens } : {}),
      ...(usage.cacheCreationInputTokens !== undefined
        ? { cacheCreationInputTokens: usage.cacheCreationInputTokens }
        : {}),
      ...(usage.cacheReadInputTokens !== undefined ? { cacheReadInputTokens: usage.cacheReadInputTokens } : {}),
    },
    ...(estimatedInputTokens > 0 || hasEstimatedOutput
      ? { estimated }
      : {}),
  };
}

export function buildAccountingPricePort(catalog: ModelCatalog, cfg: Config): AccountingPricePort {
  return (provider, model) => {
    const p = cfg.providers[provider];
    const providerLimits = p?.kind === "openai" && model
      ? catalog.cachedLimits(provider, model)
      : null;
    const data = loadTierData();
    const matched = data
      ? findTierModel<TierModel>(model, data.byNorm, data.exactByNorm)
      : null;
    const tier = matched?.match === "exact" ? matched.rec : undefined;
    const meta = resolveMetadata(model, {
      providerLimits,
      reference: tier
        ? {
          pricePromptPerToken: typeof tier.price_prompt === "number" ? tier.price_prompt : null,
          priceCompletionPerToken: typeof tier.price_completion === "number" ? tier.price_completion : null,
          from: `openrouter:${tier.norm}`,
        }
        : null,
    });
    if (meta.priceSource === null) return null;
    return {
      pricePerMillionIn: meta.pricePerMTokIn,
      pricePerMillionOut: meta.pricePerMTokOut,
      priceSource: meta.priceSource,
    };
  };
}

export class RequestAccountingState {
  private readonly request: AccountingRequest | null;
  private readonly active = new Set<AccountingAttempt>();
  private readonly committed = new Set<AccountingAttempt>();
  private readonly attemptDeployments = new Map<
    AccountingAttempt,
    { provider: string | null; model: string | null; startedAt: number }
  >();
  private responseTerminal: "finished" | "cancelled" | null = null;
  private finalized = false;
  private successfulServe = false;
  private committedServeAttribution: ProxyAccountingAttribution | null = null;
  private lastFailure: ProxyAccountingFailureKind = "unknown";
  private lastAttribution: ProxyAccountingAttribution = "unknown";

  constructor(
    recorder: AccountingRecorder,
    response: ServerResponse,
    startedAt: number,
    private readonly estimatedInputTokens: number,
    client: string,
    private readonly pricePort?: AccountingPricePort,
    private readonly onServedLatency?: (
      provider: string,
      model: string,
      ms: number,
      tokens: number | undefined,
    ) => void,
  ) {
    try {
      this.request = createAccountingRequest({ recorder, startedAt, client, pricePort });
    } catch {
      this.request = null;
    }

    response.once("finish", () => {
      if (this.responseTerminal === null) this.responseTerminal = "finished";
      this.finalizeIfReady();
    });
    response.once("close", () => {
      if (this.responseTerminal === null) {
        this.responseTerminal = response.writableFinished ? "finished" : "cancelled";
      }
      this.finalizeIfReady();
    });
  }

  startServe(attempt: ResolvedAttempt, startedAt: number): AccountingAttempt | null {
    return this.start("serve", {
      startedAt,
      attribution: serveAccountingAttribution(attempt),
      provider: attempt.target.provider,
      model: attempt.target.model ?? null,
      credentialId: attempt.credentialId,
    });
  }

  startRepair(options: {
    readonly resolvedAttempt: ResolvedAttempt | null;
    readonly credentialState: ResolvedAttempt["credential"]["state"];
    readonly provider: string | null;
    readonly model: string | null;
    readonly credentialId: string | null;
    readonly startedAt: number;
  }): AccountingAttempt | null {
    return this.start("repair", {
      startedAt: options.startedAt,
      attribution: repairAccountingAttribution(options.credentialState),
      provider: options.resolvedAttempt?.target.provider ?? options.provider,
      model: options.resolvedAttempt?.target.model ?? options.model,
      credentialId: options.resolvedAttempt?.credentialId ?? options.credentialId,
    });
  }

  markCommitted(attempt: AccountingAttempt | null, at: number): void {
    if (attempt === null) return;
    try {
      if (attempt.markCommitted({ at })) {
        this.committed.add(attempt);
        if (attempt.role === "serve") this.committedServeAttribution = attempt.attribution;
      }
    } catch {
      // safe
    }
  }

  complete(
    attempt: AccountingAttempt | null,
    outcome: "success" | "error" | "cancelled",
    failureKind: ProxyAccountingFailureKind | null,
    usage: UsageAccumulator,
    endedAt = Date.now(),
    abandonedByRelay = false,
  ): void {
    if (attempt === null) return;
    try {
      attempt.complete({
        outcome,
        failureKind,
        endedAt,
        tokens: accountingTokens(
          usage,
          attempt.role === "serve" ? this.estimatedInputTokens : 0,
          attempt.role === "repair" || this.committed.has(attempt),
        ),
        abandonedByRelay,
      });
    } catch {
      // safe
    }
    const deployment = this.attemptDeployments.get(attempt);
    this.attemptDeployments.delete(attempt);
    if (
      this.onServedLatency &&
      deployment &&
      attempt.role === "serve" &&
      outcome === "success" &&
      typeof deployment.provider === "string" &&
      typeof deployment.model === "string"
    ) {
      const elapsed = endedAt - deployment.startedAt;
      if (Number.isFinite(elapsed) && elapsed >= 0) {
        try {
          this.onServedLatency(deployment.provider, deployment.model, elapsed, usage.outputTokens);
        } catch {
          // best-effort
        }
      }
    }
    this.active.delete(attempt);
    this.committed.delete(attempt);
    this.lastAttribution = attempt.attribution;
    if (attempt.role === "serve" && outcome === "success") this.successfulServe = true;
    if (outcome !== "success" && failureKind !== null) this.lastFailure = failureKind;
    this.finalizeIfReady();
  }

  private start(
    role: "serve" | "repair",
    options: {
      readonly startedAt: number;
      readonly attribution: ProxyAccountingAttribution;
      readonly provider: string | null;
      readonly model: string | null;
      readonly credentialId: string | null;
    },
  ): AccountingAttempt | null {
    if (this.request === null || this.finalized || this.responseTerminal === "cancelled") return null;
    try {
      const attempt = this.request.startAttempt({ role, ...options });
      this.active.add(attempt);
      this.attemptDeployments.set(attempt, {
        provider: options.provider,
        model: options.model,
        startedAt: options.startedAt,
      });
      this.lastAttribution = options.attribution;
      return attempt;
    } catch {
      return null;
    }
  }

  isRequestClosed(): boolean {
    return this.responseTerminal !== null || this.finalized;
  }

  private finalizeIfReady(): void {
    if (this.finalized || this.request === null || this.responseTerminal === null) return;
    if (this.active.size > 0) {
      if (this.responseTerminal !== "finished") return;
      for (const attempt of [...this.active]) {
        this.complete(attempt, "error", "unknown", createUsageAccumulator());
      }
    }
    this.finalized = true;
    try {
      if (this.responseTerminal === "cancelled") {
        this.request.complete({
          outcome: "cancelled",
          failureKind: "aborted",
          attribution: this.committedServeAttribution ?? this.lastAttribution,
        });
      } else if (this.successfulServe) {
        this.request.complete();
      } else {
        this.request.complete({
          outcome: "error",
          failureKind: this.lastFailure,
          attribution: this.committedServeAttribution ?? this.lastAttribution,
        });
      }
    } catch {
      // safe
    }
  }
}

export function withRepairAccounting(reshaper: Reshaper, accounting: RequestAccountingState | null): Reshaper {
  if (accounting === null) return reshaper;
  const hooks: ReshaperAccountingHooks = {
    startRepairAttempt(options) {
      const attempt = accounting.startRepair(options);
      if (attempt === null) return null;
      return {
        complete(completion) {
          accounting.complete(
            attempt,
            completion.outcome,
            completion.failureKind,
            completion.usage,
            completion.endedAt,
          );
        },
      };
    },
    isRequestClosed() {
      return accounting.isRequestClosed();
    },
  };
  return {
    reshape(request) {
      return reshaper.reshape(request, hooks);
    },
  };
}
