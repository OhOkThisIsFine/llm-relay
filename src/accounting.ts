import { randomBytes } from "node:crypto";
import {
  ACCOUNTING_SPEND_COVERAGES,
  freezeDeep,
  isLoadableId,
  type AccountingSpendCoverage,
} from "./accounting-store-schema.js";
import {
  DASHBOARD_REQUEST_ID_PATTERN,
  isDashboardFailureKind,
  isDashboardOutcome,
  isDashboardUtcTimestamp,
  type AttemptRole,
  type Attribution,
  type FailureKind,
  type Outcome,
  type SpendPriceSource,
  type TokenBasis,
  type TokenTotalsV1,
} from "./dashboard-contract.js";

/** Explicit provenance for estimates whose method was omitted or unusable. */
export const ACCOUNTING_UNSPECIFIED_ESTIMATION_METHOD = "unspecified";

// `AccountingSpendCoverage` and its list are declared ONCE, in `accounting-store-schema.ts` (this
// file already imports that module; the reverse direction would be a cycle) and re-exported here
// for the ledger's consumers — see {@link AccountingSpend}. This file restated the union by hand
// until 2026-09-04 (audit DR-004, found by `test/one-declaration.test.ts`).
export { ACCOUNTING_SPEND_COVERAGES, type AccountingSpendCoverage };

export type AccountingRequestId = string;
export type AccountingAttemptId = string;

export interface ReportedTokenFactsInput {
  inputTokens?: number | null;
  outputTokens?: number | null;
  cachedInputTokens?: number | null;
  cacheCreationInputTokens?: number | null;
  cacheReadInputTokens?: number | null;
  /** The contract spelling is accepted as well as the observer spelling. */
  reportedInput?: number | null;
  reportedOutput?: number | null;
  reportedCachedInput?: number | null;
  observedAt?: string | null;
}

export interface EstimatedTokenFactsInput {
  inputTokens?: number | null;
  outputTokens?: number | null;
  estimatedInput?: number | null;
  estimatedOutput?: number | null;
  inputMethod?: string | null;
  outputMethod?: string | null;
  observedAt?: string | null;
}

export interface TokenFactsInput {
  reported?: ReportedTokenFactsInput | null;
  estimated?: EstimatedTokenFactsInput | null;
  /** Direct fields make it safe to pass a UsageAccumulator snapshot. */
  inputTokens?: number | null;
  outputTokens?: number | null;
  cachedInputTokens?: number | null;
  cacheCreationInputTokens?: number | null;
  cacheReadInputTokens?: number | null;
  estimatedInputTokens?: number | null;
  estimatedOutputTokens?: number | null;
  estimatedInputMethod?: string | null;
  estimatedOutputMethod?: string | null;
  observedAt?: string | null;
}

/** Token totals with the two Anthropic cache facts kept as first-class facts. */
export type AccountingTokenTotals = TokenTotalsV1 & {
  readonly reported: TokenTotalsV1["reported"] & {
    readonly cacheCreationInputTokens: TokenTotalsV1["reported"]["reportedCachedInput"];
    readonly cacheReadInputTokens: TokenTotalsV1["reported"]["reportedCachedInput"];
  };
};

/**
 * The prices an attempt was priced with, PER TOKEN exactly as published. Carried on
 * every priced spend so a reader can re-derive the amount and see whether it was this
 * deployment's own publication or a reference.
 */
export interface AccountingSpendPrices {
  /** Per-token input price, or null when that kind is unpublished. */
  readonly perMillionIn: number | null;
  /** Per-token output price, or null when that kind is unpublished. */
  readonly perMillionOut: number | null;
}

/**
 * Spend for ONE attempt, in integer micro-USD, with the provenance the provenance
 * invariant demands. `null` (no price resolved, or no token count to price) is the
 * honest "unpriced"; it is never rendered as $0 by any surface in this repo.
 *
 * Rounding: each token kind is computed in exact integer micro-USD
 * (`tokens * pricePerMillion` is not generally integral, so it is scaled by 1e6 and
 * rounded HALF-UP once), then kinds are summed as integers — floating error can
 * never accumulate across requests because only integers are ever stored or summed.
 *
 * Coverage:
 * - "full"       every priced token kind was priced; nothing unpriced rode alongside;
 * - "input_only" estimated-basis pricing with no reported usage — current spend policy
 *                intentionally prices estimated input alone; separate estimated-output
 *                metering never silently widens the amount;
 * - "partial"    at least one token kind present in the usage went unpriced (cache kinds,
 *                or one of in/out having no published price).
 *
 * Structurally identical to the store's persisted `AccountingSpendV1`; declared here
 * against the CONTRACT vocabulary so this module keeps its platform-free imports,
 * and re-declared there against the on-disk vocabulary. The lifecycle only ever emits
 * the two concrete `source` values, so the two shapes are assignment-compatible.
 */
export interface AccountingSpend {
  /** Exact integer micro-USD. A LOWER BOUND unless coverage is "full". */
  readonly amountMicrousd: number;
  readonly priceSource: SpendPriceSource;
  /** Whose token counts were priced: provider-reported or relay-estimated. */
  readonly tokenBasis: TokenBasis;
  /** Whose token counts: provider-reported or relay-estimated (never unknown here). */
  readonly source: "provider_reported" | "relay_estimated";
  readonly coverage: AccountingSpendCoverage;
  /**
   * Token kinds observed but NOT priced, per kind. null means the kind itself was not
   * reported; a number means it WAS reported and left out of the amount (cache kinds
   * are discounted by an unpublished factor, so pricing them at the base rate would
   * overstate spend).
   */
  readonly unpricedTokens: {
    readonly cacheRead: number | null;
    readonly cacheCreation: number | null;
    readonly cachedInput: number | null;
  };
  /** Per-million prices actually used, so the amount stays re-derivable. */
  readonly pricesUsed: AccountingSpendPrices;
  readonly observedAt: string;
}

/**
 * Injection point keeping THIS module free of catalog/metadata imports: the server
 * builds one from `catalog.cachedLimits()` (which never fetches — request-path safe)
 * plus `resolveMetadata()`, and hands it to `createAccountingRequest`.
 *
 * Prices are PER MILLION tokens, the shape `resolveMetadata()` resolves. That unit
 * makes the arithmetic self-documenting: dollars-per-million-tokens equals
 * micro-dollars-per-token, so `tokens x pricePerMillion` IS the micro-USD amount.
 */
export type AccountingPricePort = (
  provider: string,
  model: string,
) => {
  readonly pricePerMillionIn: number | null;
  readonly pricePerMillionOut: number | null;
  readonly priceSource: "provider" | "reference" | null;
} | null;

export interface AccountingRecorderEventBase {
  readonly requestId: AccountingRequestId;
}

export interface RequestStartedEvent extends AccountingRecorderEventBase {
  readonly type: "request-started";
  readonly startedAt: string;
  readonly client: string | null;
  readonly attribution: Attribution;
  readonly provider: string | null;
  readonly model: string | null;
  readonly credentialId: string | null;
}

export interface AttemptStartedEvent extends AccountingRecorderEventBase {
  readonly type: "attempt-started";
  readonly attemptId: AccountingAttemptId;
  readonly role: AttemptRole;
  readonly startedAt: string;
  readonly attribution: Attribution;
  readonly provider: string | null;
  readonly model: string | null;
  readonly credentialId: string | null;
}

export interface AttemptCompletedEvent extends AccountingRecorderEventBase {
  readonly type: "attempt-completed";
  readonly attemptId: AccountingAttemptId;
  readonly role: AttemptRole;
  readonly startedAt: string;
  readonly endedAt: string;
  readonly outcome: Outcome;
  readonly failureKind: FailureKind | null;
  readonly attribution: Attribution;
  readonly latencyMs: number | null;
  readonly commitMs: number | null;
  readonly provider: string | null;
  readonly model: string | null;
  readonly credentialId: string | null;
  readonly tokens: AccountingTokenTotals;
  /** Priced from published per-(provider, model) prices only; null = unpriced. */
  readonly spend: AccountingSpend | null;
}

export interface RequestCompletedEvent extends AccountingRecorderEventBase {
  readonly type: "request-completed";
  readonly endedAt: string;
  readonly outcome: Outcome;
  readonly failureKind: FailureKind | null;
  readonly attribution: Attribution;
  readonly attemptCount: number;
  readonly repairIncluded: boolean;
  readonly winningAttemptId: AccountingAttemptId | null;
  readonly commitAttemptId: AccountingAttemptId | null;
  readonly latencyMs: number | null;
  readonly commitMs: number | null;
  readonly provider: string | null;
  readonly model: string | null;
  readonly credentialId: string | null;
  /** Only the winning serve attempt is projected here; repair is separate. */
  readonly tokens: AccountingTokenTotals;
  readonly spend: AccountingSpend | null;
  /**
   * Spend on serve attempts the RELAY abandoned — a hedge loser (owner decision D3, 2026-08-30).
   *
   * ⚠ **A LIST, and never summed into `spend`.** `AccountingSpend` carries ONE `pricesUsed`, one
   * `priceSource` and one `tokenBasis`, so merging a loser's amount into the winner's record would
   * attach one deployment's prices to another's tokens — the provenance defect this project's own
   * invariant forbids. Each entry stays honest about its own deployment, and the four-cell
   * aggregate in `accounting-store.ts` is where they may legitimately be summed, because those
   * cells are keyed BY provenance.
   *
   * ⚠ Empty for every request that ran no hedge, which is almost all of them.
   */
  readonly abandonedSpend: readonly AccountingSpend[];
}

export type AccountingEvent =
  | RequestStartedEvent
  | AttemptStartedEvent
  | AttemptCompletedEvent
  | RequestCompletedEvent;

export interface AccountingRecorder {
  record(event: AccountingEvent): void;
}

/** A recorder suitable as the default when no read model is mounted. */
export const NOOP_ACCOUNTING_RECORDER: AccountingRecorder = Object.freeze({
  record: () => undefined,
});

export type AccountingClockValue = number | Date | string;
export type AccountingClock = (() => AccountingClockValue) | { now(): AccountingClockValue };
export type AccountingIdFactory = () => string;

export interface AccountingRequestOptions {
  recorder?: AccountingRecorder;
  clock?: AccountingClock;
  idFactory?: AccountingIdFactory;
  /**
   * Published-price lookup for spend. Absent ⇒ every attempt is unpriced, never
   * priced at a default. Must be synchronous and fetch-free (request path).
   */
  pricePort?: AccountingPricePort | undefined;
  requestId?: string;
  startedAt?: AccountingClockValue;
  client?: string | null;
  attribution?: Attribution;
  provider?: string | null;
  model?: string | null;
  credentialId?: string | null;
}

export interface AttemptStartOptions {
  role?: AttemptRole;
  startedAt?: AccountingClockValue;
  attribution?: Attribution;
  provider?: string | null;
  model?: string | null;
  credentialId?: string | null;
}

export interface AttemptCompletionOptions {
  outcome: Outcome;
  failureKind?: FailureKind | null;
  endedAt?: AccountingClockValue;
  latencyMs?: number | null;
  commitMs?: number | null;
  tokens?: TokenFactsInput | null;
  /**
   * The RELAY abandoned this attempt while another was in flight — today only a hedge loser.
   *
   * ⚠ It must be STATED, never inferred. At this layer a hedge loser and a client disconnect are
   * both `outcome: "cancelled"` with `failureKind: "aborted"` from one call site, so the attempts
   * map cannot tell them apart. Inferring one from "cancelled inside a successful request" would
   * be the counting-based guess this project's own fact rules forbid.
   */
  abandonedByRelay?: boolean;
}

export interface RequestCompletionOptions {
  outcome?: Outcome;
  failureKind?: FailureKind | null;
  attribution?: Attribution;
  endedAt?: AccountingClockValue;
  latencyMs?: number | null;
  commitMs?: number | null;
  winningAttemptId?: AccountingAttemptId | null;
}

export interface CommitOptions {
  at?: AccountingClockValue;
  commitMs?: number | null;
}

export interface AccountingAttempt {
  readonly requestId: AccountingRequestId;
  readonly attemptId: AccountingAttemptId;
  readonly role: AttemptRole;
  readonly startedAt: string;
  readonly attribution: Attribution;
  complete(options: AttemptCompletionOptions): AttemptCompletedEvent | undefined;
  markCommitted(options?: CommitOptions): boolean;
}

export interface AccountingRequest {
  readonly requestId: AccountingRequestId;
  readonly startedAt: string;
  startAttempt(options?: AttemptStartOptions): AccountingAttempt;
  complete(options?: RequestCompletionOptions): RequestCompletedEvent | undefined;
  markCommitted(attemptId: AccountingAttemptId, options?: CommitOptions): boolean;
  readonly completed: boolean;
}

interface AttemptState {
  readonly attemptId: AccountingAttemptId;
  readonly role: AttemptRole;
  readonly startedAt: string;
  readonly attribution: Attribution;
  readonly provider: string | null;
  readonly model: string | null;
  readonly credentialId: string | null;
  completed: AttemptCompletedEvent | undefined;
  committed: boolean;
  /** Stated by the caller at completion, never inferred. See `AttemptCompletionOptions`. */
  abandonedByRelay: boolean;
  commitMs: number | null;
}

interface InternalOptions {
  readonly recorder: AccountingRecorder;
  readonly clock: AccountingClock;
  readonly idFactory: AccountingIdFactory;
  readonly pricePort?: AccountingPricePort;
}

function now(clock: AccountingClock): AccountingClockValue {
  return typeof clock === "function" ? clock() : clock.now();
}

function timestamp(value: AccountingClockValue): string {
  if (typeof value === "string") {
    if (!isDashboardUtcTimestamp(value)) throw new TypeError("Accounting timestamp must be a canonical UTC timestamp.");
    return value;
  }
  if (value instanceof Date) return value.toISOString();
  if (typeof value === "number" && Number.isFinite(value)) return new Date(value).toISOString();
  throw new TypeError("Accounting timestamp must be an RFC3339 string, Date, or finite epoch number.");
}

function validInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

function validateOutcome(value: unknown): asserts value is Outcome {
  if (!isDashboardOutcome(value)) throw new TypeError("Invalid accounting outcome.");
}

function validateFailureKind(value: unknown): asserts value is FailureKind | null {
  if (value !== null && !isDashboardFailureKind(value)) throw new TypeError("Invalid accounting failure kind.");
}

function validateAttribution(value: unknown): asserts value is Attribution {
  if (value !== "relay_held" && value !== "caller_operated" && value !== "unknown") {
    throw new TypeError("Invalid accounting attribution.");
  }
}

function nullableInteger(value: unknown): number | null {
  return value === null || value === undefined ? null : validInteger(value) ? value : null;
}

function nullableLatency(value: unknown): number | null {
  return nullableInteger(value);
}

/**
 * Freeze an estimation method into a string the LOADER will accept.
 *
 * A structured descriptor is snapshotted through `JSON.stringify` on purpose — it is stored away
 * from later caller mutation, which `test/accounting.test.ts` pins. The admission test is
 * `isLoadableId`, not `isDashboardSafeId`: the two differ on control characters, and the loader is
 * the one that gets to refuse. Admitting what the loader rejects means quarantining a whole day
 * shard later instead of dropping one field now.
 */
function methodSnapshot(value: unknown): string | null {
  if (value === null || value === undefined) return null;
  if (typeof value === "string") return isLoadableId(value) ? value : null;
  try {
    const serialized = JSON.stringify(value);
    return isLoadableId(serialized) ? serialized : null;
  } catch {
    return null;
  }
}

function definedOr<T>(preferred: T | undefined, fallback: T | undefined): T | undefined {
  return preferred === undefined ? fallback : preferred;
}

function safeRecord(recorder: AccountingRecorder, event: AccountingEvent): void {
  try {
    recorder.record(event);
  } catch {
    // A metrics sink is never allowed to affect the request path.
  }
}

function makeId(factory: AccountingIdFactory, used: Set<string>): string {
  for (let i = 0; i < 128; i += 1) {
    const candidate = factory();
    if (typeof candidate === "string" && DASHBOARD_REQUEST_ID_PATTERN.test(candidate) && !used.has(candidate)) {
      used.add(candidate);
      return candidate;
    }
  }
  throw new Error("Accounting ID factory did not produce a unique valid ID.");
}

function randomId(): string {
  return randomBytes(24).toString("base64url");
}

function normalizeTokens(input: TokenFactsInput | null | undefined, observedAt: string): AccountingTokenTotals {
  const source = input ?? {};
  const reported: ReportedTokenFactsInput = source.reported ?? {
    inputTokens: source.inputTokens,
    outputTokens: source.outputTokens,
    cachedInputTokens: source.cachedInputTokens,
    cacheCreationInputTokens: source.cacheCreationInputTokens,
    cacheReadInputTokens: source.cacheReadInputTokens,
  } as ReportedTokenFactsInput;
  const estimated: EstimatedTokenFactsInput = source.estimated ?? {
    inputTokens: source.estimatedInputTokens,
    outputTokens: source.estimatedOutputTokens,
    inputMethod: source.estimatedInputMethod,
    outputMethod: source.estimatedOutputMethod,
  } as EstimatedTokenFactsInput;
  const reportedInput = nullableInteger(definedOr(reported.reportedInput, reported.inputTokens));
  const reportedOutput = nullableInteger(definedOr(reported.reportedOutput, reported.outputTokens));
  const reportedCached = nullableInteger(definedOr(reported.reportedCachedInput, reported.cachedInputTokens));
  const cacheCreation = nullableInteger(
    reported.cacheCreationInputTokens !== undefined ? reported.cacheCreationInputTokens : source.cacheCreationInputTokens,
  );
  const cacheRead = nullableInteger(
    reported.cacheReadInputTokens !== undefined ? reported.cacheReadInputTokens : source.cacheReadInputTokens,
  );
  // Anthropic's cache creation/read facts remain distinct from OpenAI's cached
  // input fact. They are never summed or used to populate that aggregate.
  const cached = reportedCached;
  const estimatedInput = nullableInteger(
    definedOr(estimated.estimatedInput, definedOr(estimated.inputTokens, source.estimatedInputTokens)),
  );
  const estimatedOutput = nullableInteger(
    definedOr(estimated.estimatedOutput, definedOr(estimated.outputTokens, source.estimatedOutputTokens)),
  );
  const estimatedInputMethod = methodSnapshot(definedOr(estimated.inputMethod, source.estimatedInputMethod));
  const estimatedOutputMethod = methodSnapshot(definedOr(estimated.outputMethod, source.estimatedOutputMethod));
  const reportedObserved = reported.observedAt !== undefined
    ? reported.observedAt
    : source.observedAt !== undefined
      ? source.observedAt
      : observedAt;
  const estimatedObserved = estimated.observedAt !== undefined
    ? estimated.observedAt
    : source.observedAt !== undefined
      ? source.observedAt
      : observedAt;
  for (const observed of [reportedObserved, estimatedObserved]) {
    if (observed !== null && !isDashboardUtcTimestamp(observed)) {
      throw new TypeError("Accounting observedAt must be a canonical UTC timestamp or null.");
    }
  }
  const result: AccountingTokenTotals = {
    reported: {
      reportedInput: { value: reportedInput, source: "provider_reported", observedAt: reportedInput === null ? null : reportedObserved },
      reportedOutput: { value: reportedOutput, source: "provider_reported", observedAt: reportedOutput === null ? null : reportedObserved },
      reportedCachedInput: { value: cached, source: "provider_reported", observedAt: cached === null ? null : reportedObserved },
      cacheCreationInputTokens: { value: cacheCreation, source: "provider_reported", observedAt: cacheCreation === null ? null : reportedObserved },
      cacheReadInputTokens: { value: cacheRead, source: "provider_reported", observedAt: cacheRead === null ? null : reportedObserved },
    },
    estimated: {
      estimatedInput: {
        value: estimatedInput,
        source: "relay_estimated",
        observedAt: estimatedInput === null ? null : estimatedObserved,
        method: estimatedInput === null ? null : estimatedInputMethod ?? ACCOUNTING_UNSPECIFIED_ESTIMATION_METHOD,
      },
      estimatedOutput: {
        value: estimatedOutput,
        source: "relay_estimated",
        observedAt: estimatedOutput === null ? null : estimatedObserved,
        method: estimatedOutput === null ? null : estimatedOutputMethod ?? ACCOUNTING_UNSPECIFIED_ESTIMATION_METHOD,
      },
    },
  };
  return freezeDeep(result);
}

/** Scale applied to a per-million price so half-up rounding happens on integers. */
const PRICE_SCALE = 1_000_000;
const PRICE_HALF = PRICE_SCALE / 2;

/**
 * Price ONE token kind in exact integer micro-USD from its PER-MILLION price.
 *
 * Dollars-per-million-tokens IS micro-dollars-per-token, so `tokens x pricePerMillion`
 * is already the micro-USD amount; it is rounded HALF-UP once here (the product is not
 * generally integral) and kinds are summed as integers downstream. Rounding per kind
 * rather than at the end keeps every amount re-derivable from its recorded prices and
 * never lets floating-point error accumulate across requests, because only integers
 * are stored or summed.
 *
 * The rounding itself is integer arithmetic: the price is scaled by 1e6 and, while
 * `tokens x scaledPrice` stays within a safe integer, the half-up step happens on
 * exact integers. `Math.round` on the float product cannot be trusted at the boundary
 * — a true `.5` whose representation lands just below rounds DOWN (100 x $0.145/M is
 * exactly 14.5 µ$ but floats to 14.499999999999998). The integer path holds while
 * `tokens <= (2^53 - 1 - PRICE_HALF) / (price x 1e6)` — e.g. ~3e9 tokens at $3/M,
 * ~9e6 tokens at $1000/M, far past any single request. Beyond the bound, or for a
 * price with more than six decimal digits (the scaled figure is not an integer), it
 * falls back to the float product rounded once; there the documented error is at most
 * 1 micro-USD per kind.
 */
function priceKind(tokens: number, pricePerMillion: number): number {
  const scaledPrice = pricePerMillion * PRICE_SCALE;
  if (Number.isSafeInteger(scaledPrice)) {
    const product = tokens * scaledPrice;
    if (Number.isSafeInteger(product) && product <= Number.MAX_SAFE_INTEGER - PRICE_HALF) {
      return Math.floor((product + PRICE_HALF) / PRICE_SCALE);
    }
  }
  return Math.round(tokens * pricePerMillion);
}

interface SpendComputationInput {
  readonly provider: string | null;
  readonly model: string | null;
  readonly tokens: AccountingTokenTotals;
  readonly endedAt: string;
}

/** A resolved published price pair; returning null means this deployment publishes none. */
interface ResolvedPrice {
  readonly perMillionIn: number | null;
  readonly perMillionOut: number | null;
  readonly source: SpendPriceSource;
}

function resolvePrice(port: AccountingPricePort | undefined, input: SpendComputationInput): ResolvedPrice | null {
  if (port === undefined) return null;
  const provider = input.provider;
  const model = input.model;
  if (provider === null || model === null || model.length === 0) return null;
  let resolved: ReturnType<AccountingPricePort>;
  try {
    // The port reads cached catalog state only; a failure there must stay a
    // measurement problem, never a request failure.
    resolved = port(provider, model);
  } catch {
    return null;
  }
  if (resolved === null) return null;
  const inPrice = typeof resolved.pricePerMillionIn === "number"
      && Number.isFinite(resolved.pricePerMillionIn)
      && resolved.pricePerMillionIn >= 0
    ? resolved.pricePerMillionIn
    : null;
  const outPrice = typeof resolved.pricePerMillionOut === "number"
      && Number.isFinite(resolved.pricePerMillionOut)
      && resolved.pricePerMillionOut >= 0
    ? resolved.pricePerMillionOut
    : null;
  if (inPrice === null && outPrice === null) return null;
  // The metadata layer spells provenance "provider"; the wire contract spells it
  // "provider_published". Map once here so every spend carries the contract value.
  const source: SpendPriceSource | null =
    resolved.priceSource === "provider" ? "provider_published"
    : resolved.priceSource === "reference" ? "reference"
    : null;
  if (source === null) return null;
  return { perMillionIn: inPrice, perMillionOut: outPrice, source };
}

/**
 * Compute one attempt's spend from the token facts ALREADY normalized onto it.
 *
 * Pricing rules (the provenance invariant, applied to money):
 * - Prices come only from the injected port's PUBLISHED figures — never a fallback
 *   price, never a tunable default, never a cache multiplier. Cache read/write
 *   discounts are unpublished, so cache tokens are counted as unpriced beside the
 *   amount rather than priced at the base rate.
 * - Reported and estimated counts are priced into separate cells upstream (this
 *   function picks whichever basis has evidence, reported first) and are never summed.
 * - anthropic-messages: input_tokens × in + output_tokens × out; cache_read /
 *   cache_creation are NOT part of input_tokens and ride unpriced.
 * - openai-chat: (prompt_tokens − cached_tokens) × in when a cache figure is reported,
 *   because OpenAI INCLUDES cached tokens in prompt_tokens and bills them at an
 *   unpublished discount; if cached > prompt that figure is malformed, so prompt_tokens
 *   is priced in full and no unpriced cached count is recorded.
 * - Estimated basis prices input ONLY by current spend policy; estimated output
 *   remains a separate metering fact. Coverage says "input_only".
 * - No price for either kind ⇒ null (unpriced). Unknown stays null, never 0.
 */
export function computeAccountingSpend(
  port: AccountingPricePort | undefined,
  input: SpendComputationInput,
): AccountingSpend | null {
  const price = resolvePrice(port, input);
  if (price === null) return null;
  const reported = input.tokens.reported;
  const estimated = input.tokens.estimated;
  const reportedInput = reported.reportedInput.value;
  const reportedOutput = reported.reportedOutput.value;
  const useReported = reportedInput !== null || reportedOutput !== null;

  let amount = 0;
  let partial = false;
  const unpricedTokens: {
    cacheRead: number | null;
    cacheCreation: number | null;
    cachedInput: number | null;
  } = {
    cacheRead: null,
    cacheCreation: null,
    cachedInput: null,
  };

  if (useReported) {
    const cacheRead = reported.cacheReadInputTokens.value ?? null;
    const cacheCreation = reported.cacheCreationInputTokens.value ?? null;
    const cachedInput = reported.reportedCachedInput.value ?? null;
    if (cacheRead !== null && cacheRead > 0) { unpricedTokens.cacheRead = cacheRead; partial = true; }
    if (cacheCreation !== null && cacheCreation > 0) { unpricedTokens.cacheCreation = cacheCreation; partial = true; }
    if (cachedInput !== null && cachedInput > 0) {
      // Malformed cache figure (cached > prompt) ⇒ trust prompt_tokens alone.
      if (reportedInput !== null && cachedInput <= reportedInput) {
        unpricedTokens.cachedInput = cachedInput;
        partial = true;
      }
    }
    if (reportedInput !== null) {
      if (price.perMillionIn === null) partial = true;
      else {
        const billable = cachedInput !== null && cachedInput > 0 && cachedInput <= reportedInput
          ? reportedInput - cachedInput
          : reportedInput;
        amount += priceKind(billable, price.perMillionIn);
      }
    }
    if (reportedOutput !== null) {
      if (price.perMillionOut === null) partial = true;
      else amount += priceKind(reportedOutput, price.perMillionOut);
    }
    if (amount === 0 && !partial) return null;
    return freezeDeep({
      amountMicrousd: amount,
      priceSource: price.source,
      tokenBasis: "reported",
      source: "provider_reported",
      coverage: partial ? "partial" : "full",
      unpricedTokens,
      pricesUsed: { perMillionIn: price.perMillionIn, perMillionOut: price.perMillionOut },
      observedAt: input.endedAt,
    } satisfies AccountingSpend);
  }

  // Estimated output remains a separate metering cell. Current spend policy prices
  // estimated input only and labels the narrower amount accordingly.
  const estimatedInput = estimated.estimatedInput.value;
  if (estimatedInput === null) return null;
  if (price.perMillionIn === null) return null;
  amount += priceKind(estimatedInput, price.perMillionIn);
  if (amount === 0) return null;
  return freezeDeep({
    amountMicrousd: amount,
    priceSource: price.source,
    tokenBasis: "estimated",
    source: "relay_estimated",
    coverage: "input_only",
    unpricedTokens,
    pricesUsed: { perMillionIn: price.perMillionIn, perMillionOut: price.perMillionOut },
    observedAt: input.endedAt,
  } satisfies AccountingSpend);
}

function deriveLatency(startedAt: string, endedAt: string, supplied: number | null | undefined): number | null {
  if (supplied !== undefined) return nullableLatency(supplied);
  const start = Date.parse(startedAt);
  const end = Date.parse(endedAt);
  return Number.isFinite(start) && Number.isFinite(end) && end >= start ? end - start : null;
}

function deriveCommitMs(startedAt: string, endedAt: string): number | null {
  const start = Date.parse(startedAt);
  const end = Date.parse(endedAt);
  if (!Number.isFinite(start) || !Number.isFinite(end) || end < start) return null;
  const result = end - start;
  return validInteger(result) ? result : null;
}

class AccountingRequestLifecycle implements AccountingRequest {
  readonly requestId: AccountingRequestId;
  readonly startedAt: string;
  private readonly options: InternalOptions;
  private readonly client: string | null;
  private readonly attribution: Attribution;
  private readonly provider: string | null;
  private readonly model: string | null;
  private readonly credentialId: string | null;
  private readonly attempts = new Map<string, AttemptState>();
  private readonly usedIds: Set<string>;
  private requestCompleted: RequestCompletedEvent | undefined;
  private requestCommitAttemptId: AccountingAttemptId | null = null;
  private requestCommitMs: number | null = null;

  constructor(options: AccountingRequestOptions = {}) {
    this.options = {
      recorder: options.recorder ?? NOOP_ACCOUNTING_RECORDER,
      clock: options.clock ?? (() => Date.now()),
      idFactory: options.idFactory ?? randomId,
      ...(options.pricePort === undefined ? {} : { pricePort: options.pricePort }),
    };
    this.usedIds = new Set<string>();
    this.requestId = options.requestId ?? makeId(this.options.idFactory, this.usedIds);
    if (!DASHBOARD_REQUEST_ID_PATTERN.test(this.requestId)) throw new TypeError("Invalid accounting request ID.");
    this.usedIds.add(this.requestId);
    this.startedAt = timestamp(options.startedAt ?? now(this.options.clock));
    this.client = options.client ?? null;
    this.attribution = options.attribution === undefined ? "unknown" : options.attribution;
    validateAttribution(this.attribution);
    this.provider = options.provider ?? null;
    this.model = options.model ?? null;
    this.credentialId = options.credentialId ?? null;
    const event = freezeDeep({
      type: "request-started" as const,
      requestId: this.requestId,
      startedAt: this.startedAt,
      client: this.client,
      attribution: this.attribution,
      provider: this.provider,
      model: this.model,
      credentialId: this.credentialId,
    });
    safeRecord(this.options.recorder, event);
  }

  get completed(): boolean { return this.requestCompleted !== undefined; }

  startAttempt(options: AttemptStartOptions = {}): AccountingAttempt {
    if (this.requestCompleted) throw new Error("Cannot start an attempt after request completion.");
    const role = options.role ?? "serve";
    if (role !== "serve" && role !== "repair") throw new TypeError("Invalid accounting attempt role.");
    const attribution = options.attribution === undefined ? this.attribution : options.attribution;
    validateAttribution(attribution);
    const attemptId = makeId(this.options.idFactory, this.usedIds);
    const startedAt = timestamp(options.startedAt ?? now(this.options.clock));
    const state: AttemptState = {
      attemptId,
      role,
      startedAt,
      attribution,
      abandonedByRelay: false,
      provider: options.provider ?? null,
      model: options.model ?? null,
      credentialId: options.credentialId ?? null,
      completed: undefined,
      committed: false,
      commitMs: null,
    };
    this.attempts.set(attemptId, state);
    const event = freezeDeep({
      type: "attempt-started" as const,
      requestId: this.requestId,
      attemptId,
      role,
      startedAt,
      attribution: state.attribution,
      provider: state.provider,
      model: state.model,
      credentialId: state.credentialId,
    });
    safeRecord(this.options.recorder, event);
    return {
      requestId: this.requestId,
      attemptId,
      role,
      startedAt,
      attribution: state.attribution,
      complete: (completion) => this.completeAttempt(state, completion),
      markCommitted: (commit) => this.markAttemptCommitted(state, commit),
    };
  }

  markCommitted(attemptId: AccountingAttemptId, options?: CommitOptions): boolean {
    const state = this.attempts.get(attemptId);
    if (!state) throw new Error("Unknown accounting attempt.");
    return this.markAttemptCommitted(state, options);
  }

  private markAttemptCommitted(state: AttemptState, options: CommitOptions = {}): boolean {
    if (state.completed || state.role !== "serve" || state.committed || this.requestCommitAttemptId !== null) return false;
    let commitMs: number | null;
    try {
      // Validate an explicitly supplied timestamp even when a direct latency
      // is supplied; invalid input must never be allowed into an event.
      const explicitAt = options.at === undefined ? undefined : timestamp(options.at);
      if (options.commitMs !== undefined) {
        if (!validInteger(options.commitMs)) return false;
        commitMs = options.commitMs;
      } else {
        const at = explicitAt ?? timestamp(now(this.options.clock));
        commitMs = deriveCommitMs(state.startedAt, at);
      }
    } catch {
      return false;
    }
    if (commitMs === null) return false;
    state.committed = true;
    state.commitMs = commitMs;
    this.requestCommitAttemptId = state.attemptId;
    this.requestCommitMs = commitMs;
    return true;
  }

  private completeAttempt(state: AttemptState, completion: AttemptCompletionOptions): AttemptCompletedEvent | undefined {
    if (state.completed) return state.completed;
    if (this.requestCompleted) throw new Error("Cannot complete an attempt after request completion.");
    validateOutcome(completion.outcome);
    const failureKind = completion.failureKind === undefined ? null : completion.failureKind;
    validateFailureKind(failureKind);
    if (completion.outcome === "success" && failureKind !== null) {
      throw new Error("A successful accounting attempt cannot carry a failure kind.");
    }
    const endedAt = timestamp(completion.endedAt ?? now(this.options.clock));
    const tokens = normalizeTokens(completion.tokens, endedAt);
    if (completion.commitMs !== undefined && state.role === "serve" && !state.committed && this.requestCommitAttemptId === null) {
      // A direct completion commit is equivalent to a marker supplied at the
      // end of the attempt, but invalid values never latch.
      if (validInteger(completion.commitMs)) {
        state.committed = true;
        state.commitMs = completion.commitMs;
        this.requestCommitAttemptId = state.attemptId;
        this.requestCommitMs = completion.commitMs;
      }
    }
    state.abandonedByRelay = completion.abandonedByRelay === true;
    const event = freezeDeep({
      type: "attempt-completed" as const,
      requestId: this.requestId,
      attemptId: state.attemptId,
      role: state.role,
      startedAt: state.startedAt,
      endedAt,
      outcome: completion.outcome,
      failureKind,
      attribution: state.attribution,
      latencyMs: deriveLatency(state.startedAt, endedAt, completion.latencyMs),
      commitMs: state.commitMs,
      provider: state.provider,
      model: state.model,
      credentialId: state.credentialId,
      tokens,
      // Priced like any attempt and kept on its own row (C1); request-level spend
      // projects ONLY the winning serve attempt.
      spend: computeAccountingSpend(this.options.pricePort, {
        provider: state.provider,
        model: state.model,
        tokens,
        endedAt,
      }),
    });
    state.completed = event;
    safeRecord(this.options.recorder, event);
    return event;
  }

  complete(completion: RequestCompletionOptions = {}): RequestCompletedEvent | undefined {
    if (this.requestCompleted) return this.requestCompleted;
    for (const attempt of this.attempts.values()) {
      if (!attempt.completed) throw new Error("Cannot complete request while an attempt is active.");
    }
    const endedAt = timestamp(completion.endedAt ?? now(this.options.clock));
    const successfulServes = [...this.attempts.values()].filter(
      (attempt) => attempt.role === "serve" && attempt.completed?.outcome === "success",
    );
    const hasWinningAttemptId = Object.prototype.hasOwnProperty.call(completion, "winningAttemptId");
    const hasExplicitWinner = hasWinningAttemptId
      && completion.winningAttemptId !== null
      && completion.winningAttemptId !== undefined;
    const commitWinner = this.requestCommitAttemptId === null
      ? undefined
      : this.attempts.get(this.requestCommitAttemptId);
    const explicitWinner = hasExplicitWinner ? this.attempts.get(completion.winningAttemptId as string) : undefined;
    if (hasExplicitWinner && !explicitWinner) {
      throw new Error("Winning attempt must be a completed successful serve attempt.");
    }
    if (explicitWinner && commitWinner && explicitWinner.attemptId !== commitWinner.attemptId) {
      throw new Error("Winning attempt must match the already committed serve attempt.");
    }
    if (
      explicitWinner
      && explicitWinner !== commitWinner
      && (explicitWinner.role !== "serve" || explicitWinner.completed?.outcome !== "success")
    ) {
      throw new Error("Winning attempt must be a completed successful serve attempt.");
    }
    const winner = commitWinner
      ?? explicitWinner
      ?? (hasWinningAttemptId ? undefined : successfulServes[0]);
    const explicitAttribution = completion.attribution === undefined
      ? undefined
      : completion.attribution;
    if (explicitAttribution !== undefined) validateAttribution(explicitAttribution);
    if (winner && explicitAttribution !== undefined && explicitAttribution !== winner.attribution) {
      throw new Error("Completion attribution conflicts with winning serve attribution.");
    }
    const terminalAttribution = winner?.attribution ?? explicitAttribution ?? this.attribution;
    const outcome = completion.outcome !== undefined
      ? completion.outcome
      : winner?.completed?.outcome;
    if (outcome === undefined) {
      throw new Error("Request outcome is required when no successful serve exists.");
    }
    validateOutcome(outcome);
    const suppliedFailureKind = completion.failureKind === undefined ? null : completion.failureKind;
    validateFailureKind(suppliedFailureKind);
    if (outcome === "success" && suppliedFailureKind !== null) {
      throw new Error("A successful accounting request cannot carry a failure kind.");
    }
    if (winner && outcome !== "success" && (winner !== commitWinner || winner.completed?.outcome !== outcome)) {
      throw new Error("A non-successful request cannot identify a winning serve attempt.");
    }
    if (!winner && outcome === "success") {
      throw new Error("A successful request requires a completed successful serve attempt.");
    }
    const tokens = winner?.completed?.tokens ?? normalizeTokens(null, endedAt);
    if (completion.commitMs !== undefined && winner && this.requestCommitAttemptId === null && validInteger(completion.commitMs)) {
      winner.committed = true;
      winner.commitMs = completion.commitMs;
      this.requestCommitAttemptId = winner.attemptId;
      this.requestCommitMs = completion.commitMs;
    }
    const failureKind = suppliedFailureKind;
    // Request spend projects ONLY the winning serve attempt — the same rule the
    // request token totals already follow, so a retried-elsewhere request never
    // double-counts. A request with no winning serve is unpriced, not $0.
    const spend = computeAccountingSpend(this.options.pricePort, {
      provider: winner?.provider ?? null,
      model: winner?.model ?? null,
      tokens,
      endedAt,
    });
    const event = freezeDeep({
      type: "request-completed" as const,
      requestId: this.requestId,
      endedAt,
      outcome,
      failureKind,
      attribution: terminalAttribution,
      attemptCount: this.attempts.size,
      repairIncluded: [...this.attempts.values()].some((attempt) => attempt.role === "repair"),
      winningAttemptId: winner?.attemptId ?? null,
      commitAttemptId: this.requestCommitAttemptId,
      latencyMs: deriveLatency(this.startedAt, endedAt, completion.latencyMs),
      commitMs: this.requestCommitMs,
      provider: winner?.provider ?? this.provider,
      model: winner?.model ?? this.model,
      credentialId: winner?.credentialId ?? this.credentialId,
      tokens,
      spend,
      // Each loser's OWN priced record, taken as it was computed against its OWN deployment's
      // prices. Nothing is re-priced here and nothing is merged; see the field's docblock.
      abandonedSpend: [...this.attempts.values()]
        .filter((attempt) => attempt.role === "serve" && attempt.abandonedByRelay)
        .map((attempt) => attempt.completed?.spend)
        .filter((entry): entry is AccountingSpend => entry !== undefined && entry !== null),
    });
    this.requestCompleted = event;
    safeRecord(this.options.recorder, event);
    return event;
  }
}

export function createAccountingRequest(options: AccountingRequestOptions = {}): AccountingRequest {
  return new AccountingRequestLifecycle(options);
}
