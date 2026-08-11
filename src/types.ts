/**
 * The classified outcome of one settled execution.
 *
 * This is resilix's core primitive. Every other library in this space reduces an
 * outcome to a boolean ("did the promise reject?"), which cannot express the two
 * cases that matter most in production:
 *
 *   - a 4xx means the upstream WORKED and the caller was wrong. Counting it as a
 *     failure means ordinary bad user input can open your circuit.
 *   - a 429 is NOT a breaker failure, but it IS a load signal. A boolean predicate
 *     forces you to choose "failure" or "invisible"; neither is correct.
 */
export type Verdict =
  /** Healthy completion. */
  | "success"
  /** 4xx — the upstream answered; the caller was wrong. Never a failure, never retried. */
  | "answered"
  /** 5xx, ECONNRESET, socket hang up, any unlabelled transport error. */
  | "transient"
  /** 429 / 503+Retry-After — the upstream is explicitly shedding. A load signal, not a failure. */
  | "overload"
  /** Our deadline elapsed, not theirs. */
  | "timeout"
  /** WE shed it. Never counts as evidence about the upstream. */
  | "rejected";

/** Verdicts that count as a circuit-breaker failure. */
export const FAILURE_VERDICTS: ReadonlySet<Verdict> = new Set<Verdict>(["transient", "timeout"]);

/** Verdicts that carry no information about upstream health and are ignored wholesale. */
export const IGNORED_VERDICTS: ReadonlySet<Verdict> = new Set<Verdict>(["rejected"]);

export const isFailureVerdict = (v: Verdict): boolean => FAILURE_VERDICTS.has(v);
export const isIgnoredVerdict = (v: Verdict): boolean => IGNORED_VERDICTS.has(v);

/** One settled execution, as every policy sees it. */
export interface Observation {
  verdict: Verdict;
  /** Always present. This is the signal a failure-rate-only breaker throws away. */
  latencyMs: number;
  /** From the injected clock — never `Date.now()` inside a policy. */
  at: number;
}

/** Why an execution was refused. */
export type RejectionReason =
  | "circuit-open"
  | "circuit-half-open-probe-in-flight"
  | "bulkhead-full"
  | "limiter-full"
  | "throttled";

/** A policy's answer to "may this execution proceed right now?". */
export type Admission =
  | { readonly ok: true }
  | { readonly ok: false; readonly reason: RejectionReason; readonly retryAfterMs?: number };

export const ADMIT: Admission = { ok: true };

export const refuse = (reason: RejectionReason, retryAfterMs?: number): Admission =>
  retryAfterMs === undefined ? { ok: false, reason } : { ok: false, reason, retryAfterMs };

/**
 * Every policy is this shape.
 *
 * Note what is absent: `execute(fn)`. Policies are synchronous state machines with
 * no async surface at all — the Executor is the only component that knows about
 * promises. That makes policies allocation-free on the hot path, trivially testable
 * without any promise plumbing, and drivable by hand from a non-promise context
 * (a stream consumer, a cron job, a queue worker).
 */
export interface Policy<S = unknown> {
  readonly name: string;
  /** Gate. Must be side-effect-free apart from the policy's own bookkeeping. */
  admit(): Admission;
  /** Feedback for an execution this policy admitted. */
  settle(obs: Observation): void;
  /** Serialisable state, for serverless hydration and for tests. */
  snapshot(): S;
  hydrate(state: S): void;
  /**
   * Numeric gauges for telemetry, if the policy has any. Read on demand — a metrics
   * backend pulls these rather than being pushed at, which keeps the hot path free of
   * instrumentation work. Values must be plain numbers so any exporter can consume them.
   */
  metrics?(): Record<string, number>;
}

/** What a policy is built with. One policy instance exists per key. */
export interface PolicyEnv {
  readonly key: string;
  readonly clock: Clock;
  /** Set by the pipeline. Already wrapped so throws cannot escape into the control path. */
  readonly observer?: PolicyObserver;
}

/**
 * A policy state transition, in the loosest form the observer surface needs.
 *
 * Deliberately widened to `string` rather than importing each policy's own state union:
 * `types.ts` must not depend on any policy module. A concrete event (the breaker's
 * `StateChangeEvent`, with its narrower `from`/`to` and extra rate fields) is assignable
 * to this.
 */
export interface PolicyStateChangeEvent {
  key: string;
  from: string;
  to: string;
  reason?: string;
}

/** The slice of the observer surface a policy is allowed to emit on. */
export interface PolicyObserver {
  onStateChange?(event: PolicyStateChangeEvent): void;
}

/** Policies are declared as factories so the registry can build one set per key. */
export type PolicyFactory = (env: PolicyEnv) => Policy;

/** Injected time source. Non-negotiable: it is what makes every temporal test deterministic. */
export interface Clock {
  /**
   * Milliseconds, monotonic. The origin is arbitrary — `performance.now()` counts from
   * process start — so this value is only ever meaningful as a delta against itself.
   * Never serialise it (see `wallNow`).
   */
  now(): number;
  /**
   * Epoch milliseconds. Used ONLY by snapshot/hydrate, to measure how long a snapshot sat
   * between processes; never on the hot path.
   *
   * This exists because `now()` has no shared origin: a timestamp from `now()` in one
   * process is meaningless in another, so a naively serialised window would rehydrate with
   * samples that look fresh — or arrive from the future.
   */
  wallNow?(): number;
}
