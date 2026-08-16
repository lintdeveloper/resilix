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
  /**
   * Which tenant this call belonged to, when the pipeline was given a `tenant` accessor.
   *
   * Present so fairness can be accounted at SETTLE time. Counting usage at admit() would
   * charge a tenant for calls an inner policy refused — and since heavy usage is what gets you
   * shed, that is a positive feedback loop inside a mechanism whose entire job is fairness
   * (ADR-007, checklist item 3).
   */
  tenant?: string;
}

/**
 * Request criticality, in Netflix's four buckets (themselves inspired by Linux `tc-prio`).
 *
 * Four named levels rather than Uber's five classes x 100 granular levels: 768 priorities is a
 * scheduling system, and a scheduling system needs a queue it owns. resilix sheds at admission.
 *
 * Netflix's definitions, verbatim:
 *   critical    "Affect core functionality — These will never be shed if we are not in
 *                complete failure."
 *   degraded    "Affect user experience — These will be progressively shed as the load
 *                increases."
 *   bestEffort  "Do not affect the user — These will be responded to in a best effort fashion
 *                and may be shed progressively in normal operation."
 *   bulk        "Background work, expect these to be routinely shed."
 */
export type Priority = "critical" | "degraded" | "bestEffort" | "bulk";

/** Ordered least- to most-sheddable. Index doubles as the shed order. */
export const PRIORITIES: readonly Priority[] = ["critical", "degraded", "bestEffort", "bulk"];

/**
 * How much system pressure must exist before work at this priority is shed.
 *
 * Netflix's CPU variant sheds non-critical above 60% utilisation and critical only above 80%.
 * resilix has no CPU reading for someone else's machine, so "pressure" is the local equivalent:
 * how close a policy is to refusing everything. `critical` sits at 1 so it is shed only when a
 * policy would have refused the call regardless of priority.
 */
export const SHED_ABOVE: Readonly<Record<Priority, number>> = {
  bulk: 0.25,
  bestEffort: 0.5,
  degraded: 0.75,
  critical: 1,
};

/** What a policy is told about the call it is being asked to admit. */
export interface AdmissionRequest {
  /** Defaults to `critical` — unlabelled work is assumed to matter. */
  readonly priority?: Priority;
  /** Opaque tenant identifier, for fairness. */
  readonly tenant?: string;
}

/** Why an execution was refused. */
export type RejectionReason =
  | "circuit-open"
  | "circuit-half-open-probe-in-flight"
  | "bulkhead-full"
  | "limiter-full"
  | "throttled"
  | "rate-limited"
  | "budget-exceeded"
  | "shed-by-priority"
  | "unfair-share";

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
  /**
   * Gate. Must be side-effect-free apart from the policy's own bookkeeping.
   *
   * The argument is optional and ignorable: policies that do not shed by priority or tenant
   * simply do not read it. It exists because priority-aware shedding is meaningless if the
   * shedding policies cannot see the priority.
   */
  admit(request?: AdmissionRequest): Admission;
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
  /** Injected randomness, for policies that shed probabilistically. Seeded in tests. */
  readonly random?: RandomLike;
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

/** Structural shape of `Random`, declared here so types.ts depends on no other module. */
export interface RandomLike {
  next(): number;
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
