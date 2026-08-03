import type {
  AttemptBeginFailure,
  AttemptCompletionFailure,
  AttemptHandle,
  AttemptId,
  AttemptLease,
  AttemptLeaseView,
  AttemptLifecyclePort,
  AttemptOutcome,
  CancellationSignal,
  CompletedAttempt,
  LeaseSpentFailure,
  ProviderTargetIdentity,
  SpentAttemptLease,
  TransitionResult,
} from "./contracts.js";

export interface MonotonicClock {
  now(): number;
}

export type LeaseAcquisitionFailure =
  | { readonly kind: "cancelled"; readonly reason: string | null }
  | { readonly kind: "deadline-exceeded"; readonly deadline: number; readonly now: number }
  | { readonly kind: "budget-exhausted"; readonly capacity: number; readonly issued: number };

export interface RequestBudgetOptions {
  readonly capacity: number;
  readonly deadline: number;
  readonly clock: MonotonicClock;
  readonly cancellation: CancellationSignal;
}

export interface RequestBudgetView {
  readonly capacity: number;
  readonly deadline: number;
  readonly issued: number;
  readonly remaining: number;
  readonly cancelled: boolean;
}

class IssuedAttemptLease {
  declare readonly [attemptLeaseMarker]: true;
  #spent = false;

  constructor(
    readonly ordinal: number,
    readonly acquiredAt: number,
    readonly deadline: number,
  ) {
    Object.freeze(this);
  }

  spend(): TransitionResult<SpentAttemptLease, LeaseSpentFailure> {
    if (this.#spent) {
      return { ok: false, error: { kind: "lease-spent", ordinal: this.ordinal } };
    }
    this.#spent = true;
    return {
      ok: true,
      value: Object.freeze({
        ordinal: this.ordinal,
        acquiredAt: this.acquiredAt,
        deadline: this.deadline,
      }) as SpentAttemptLease,
    };
  }

  view(): AttemptLeaseView {
    return Object.freeze({
      ordinal: this.ordinal,
      acquiredAt: this.acquiredAt,
      deadline: this.deadline,
      spent: this.#spent,
    });
  }
}

// The marker is module-private at runtime. The exported type carries a separate
// compile-time brand, so consumers can receive leases but cannot construct them.
const attemptLeaseMarker: unique symbol = Symbol("attempt-lease-marker");

/** Immutable request limits with a monotonic, non-refundable lease ledger. */
export class RequestBudget {
  readonly capacity: number;
  readonly deadline: number;
  readonly #clock: MonotonicClock;
  readonly #cancellation: CancellationSignal;
  #issued = 0;

  constructor(options: RequestBudgetOptions) {
    if (!Number.isSafeInteger(options.capacity) || options.capacity < 0) {
      throw new RangeError("RequestBudget capacity must be a non-negative safe integer");
    }
    if (!Number.isFinite(options.deadline)) {
      throw new RangeError("RequestBudget deadline must be finite");
    }
    this.capacity = options.capacity;
    this.deadline = options.deadline;
    this.#clock = options.clock;
    this.#cancellation = options.cancellation;
    Object.freeze(this);
  }

  acquire(): TransitionResult<AttemptLease, LeaseAcquisitionFailure> {
    if (this.#cancellation.isCancelled()) {
      return {
        ok: false,
        error: { kind: "cancelled", reason: this.#cancellation.reason() ?? null },
      };
    }

    const now = this.#clock.now();
    if (now >= this.deadline) {
      return { ok: false, error: { kind: "deadline-exceeded", deadline: this.deadline, now } };
    }
    if (this.#issued >= this.capacity) {
      return {
        ok: false,
        error: { kind: "budget-exhausted", capacity: this.capacity, issued: this.#issued },
      };
    }

    const ordinal = ++this.#issued;
    return {
      ok: true,
      value: new IssuedAttemptLease(ordinal, now, this.deadline) as unknown as AttemptLease,
    };
  }

  view(): RequestBudgetView {
    return Object.freeze({
      capacity: this.capacity,
      deadline: this.deadline,
      issued: this.#issued,
      remaining: this.capacity - this.#issued,
      cancelled: this.#cancellation.isCancelled(),
    });
  }
}

const handleOwner = Symbol("attempt-handle-owner");
const handleGeneration = Symbol("attempt-handle-generation");
const handleId = Symbol("attempt-handle-id");
const handleTarget = Symbol("attempt-handle-target");

interface InternalHandle {
  readonly [handleOwner]: object;
  readonly [handleGeneration]: number;
  readonly [handleId]: AttemptId;
  readonly [handleTarget]: ProviderTargetIdentity;
}

interface AttemptRecord {
  readonly owner: object;
  readonly generation: number;
  readonly id: AttemptId;
  readonly target: ProviderTargetIdentity;
  completed: boolean;
}

// Shared only to classify a genuine handle from another request as foreign.
// Weak keys preserve request lifetime and expose no enumeration surface.
const knownHandles = new WeakMap<object, AttemptRecord>();

export interface AttemptLifecycleView {
  readonly generation: number;
  readonly issued: number;
  readonly completed: number;
  readonly open: number;
  readonly closed: boolean;
}

function sameTarget(a: ProviderTargetIdentity, b: ProviderTargetIdentity): boolean {
  return a.provider === b.provider && a.model === b.model && a.kind === b.kind;
}

/** Request-scoped owner of opaque, target-bound attempt handles. */
export class AttemptLifecycle implements AttemptLifecyclePort {
  readonly #owner = Object.freeze({});
  readonly #generation: number;
  #issued = 0;
  #completed = 0;
  #closed = false;

  constructor(generation = 1) {
    if (!Number.isSafeInteger(generation) || generation < 1) {
      throw new RangeError("AttemptLifecycle generation must be a positive safe integer");
    }
    this.#generation = generation;
    Object.freeze(this);
  }

  beginAttempt(
    target: ProviderTargetIdentity,
  ): TransitionResult<AttemptHandle, AttemptBeginFailure> {
    if (this.#closed) return { ok: false, error: { kind: "lifecycle-closed" } };

    const ordinal = ++this.#issued;
    const id = `${this.#generation}:${ordinal}` as AttemptId;
    const stableTarget = Object.freeze({ ...target });
    const handle = Object.freeze({
      [handleOwner]: this.#owner,
      [handleGeneration]: this.#generation,
      [handleId]: id,
      [handleTarget]: stableTarget,
    }) as InternalHandle;
    knownHandles.set(handle, {
      owner: this.#owner,
      generation: this.#generation,
      id,
      target: stableTarget,
      completed: false,
    });
    return { ok: true, value: handle as unknown as AttemptHandle };
  }

  completeAttempt(
    handle: AttemptHandle,
    outcome: AttemptOutcome,
  ): TransitionResult<CompletedAttempt, AttemptCompletionFailure> {
    if ((typeof handle !== "object" && typeof handle !== "function") || handle === null) {
      return { ok: false, error: { kind: "stale-handle" } };
    }
    const record = knownHandles.get(handle as object);
    if (!record) return { ok: false, error: { kind: "stale-handle" } };
    if (record.owner !== this.#owner) return { ok: false, error: { kind: "foreign-handle" } };
    if (record.generation !== this.#generation) {
      return { ok: false, error: { kind: "stale-handle" } };
    }
    if (record.completed) {
      return { ok: false, error: { kind: "duplicate-completion", id: record.id } };
    }
    if (!sameTarget(record.target, outcome.target)) {
      return {
        ok: false,
        error: { kind: "cross-target", expected: record.target, received: outcome.target },
      };
    }

    // This is the only mutation point after every rejection check has passed.
    record.completed = true;
    this.#completed++;
    return {
      ok: true,
      value: Object.freeze({ id: record.id, target: record.target, outcome }),
    };
  }

  close(): void {
    this.#closed = true;
  }

  view(): AttemptLifecycleView {
    return Object.freeze({
      generation: this.#generation,
      issued: this.#issued,
      completed: this.#completed,
      open: this.#issued - this.#completed,
      closed: this.#closed,
    });
  }
}
