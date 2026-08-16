import { Backoff } from "./backoff.ts";
import type { BackoffOptions } from "./backoff.ts";
import type { RetryBudget } from "./budget.ts";
import { classifyHttp, retryAfterFrom } from "./classify.ts";
import { systemClock } from "./clock.ts";
import { safeObserver } from "./observer.ts";
import type { Observer } from "./observer.ts";
import { systemRandom } from "./random.ts";
import type { Random } from "./random.ts";
import { KeyRegistry } from "./registry.ts";
import type {
  Clock,
  Observation,
  Policy,
  PolicyFactory,
  RejectionReason,
  Verdict,
} from "./types.ts";

/** Thrown when a policy refuses the execution. */
export class RejectedError extends Error {
  readonly code = "RESILIX_REJECTED";
  readonly reason: RejectionReason;
  readonly key: string;
  readonly retryAfterMs: number | undefined;

  constructor(key: string, reason: RejectionReason, retryAfterMs?: number) {
    super(`resilix refused this execution (key=${key}, reason=${reason})`);
    this.name = "RejectedError";
    this.key = key;
    this.reason = reason;
    this.retryAfterMs = retryAfterMs;
  }
}

/**
 * Retry configuration.
 *
 * Retry lives on the pipeline rather than in `policies`, for the same reason `timeoutMs` does
 * (ADR-013): it must WRAP and re-invoke the call, which a synchronous admit/settle policy
 * cannot express. It is the outermost thing in the stack, so each attempt re-consults the
 * breaker, limiter and throttler.
 */
export interface RetryOptions extends BackoffOptions {
  /**
   * Total attempts including the first. Default 3 — Google SRE: "up to three attempts".
   * Set to 1 to disable retrying while keeping the rest of the pipeline.
   */
  maxAttempts?: number;
  /**
   * Shared budget bounding retries as a fraction of requests. Strongly recommended: without it
   * a degradation turns into a 3x load spike exactly when the upstream can least absorb one.
   * The SAME instance should be passed to every pipeline in the process.
   */
  budget?: RetryBudget;
  /**
   * Honour an upstream's `Retry-After` in preference to the computed backoff. Default true.
   * A provider telling you when to come back is better information than any backoff curve.
   */
  respectRetryAfter?: boolean;
}

/** Thrown when the pipeline's own deadline elapses. Classified as `timeout`. */
export class TimeoutError extends Error {
  readonly code = "ETIMEDOUT";

  constructor(ms: number, key: string) {
    super(`resilix deadline of ${ms}ms elapsed (key=${key})`);
    this.name = "TimeoutError";
  }
}

export interface ExecutionContext {
  readonly key: string;
  /** Present only when a timeout is configured. Pass it to `fetch`, undici, or a driver. */
  readonly signal: AbortSignal | undefined;
  /**
   * Declare that the *meaningful* latency of this call has just elapsed.
   *
   * By default a call's latency is its total duration, which is wrong for anything
   * streaming. A streamed LLM completion legitimately runs for 45 seconds; what actually
   * indicates health is **time to first token**. Judging it on total duration means every
   * healthy stream looks slow, and the slow-call breaker opens on a perfectly good upstream.
   *
   *   await pipeline.execute(req, async (ctx) => {
   *     const res = await fetch(url, { signal: ctx.signal });
   *     ctx.mark();                 // <- TTFB/TTFT: this is the health signal
   *     return consumeStream(res);  // may run for another 45s; not counted
   *   });
   *
   * Only the first call counts; later calls are ignored. If never called, total duration
   * is used, which is the right default for a unary request.
   */
  mark(): void;
}

export interface PipelineOptions<I> {
  /**
   * Isolation key. One policy set exists per key, so a failing host cannot open the
   * circuit for a healthy one. Defaults to a single shared `"default"` key.
   */
  key?: (input: I) => string;
  /** Outcome -> Verdict. Defaults to the HTTP classifier. */
  classify?: (outcome: unknown) => Verdict;
  /** Outermost first, innermost last. */
  policies: PolicyFactory[];
  /** Deadline enforced by the pipeline itself. Creates an AbortController lazily, per call. */
  timeoutMs?: number;
  clock?: Clock;
  /** Injected randomness, for jitter. Seeded in tests; `Math.random` by default. */
  random?: Random;
  /** Re-attempt failed calls. Absent means no retrying. */
  retry?: RetryOptions;
  registry?: { maxKeys?: number; ttlMs?: number };
  /**
   * Passive observers — metrics, logs, traces. Dispatched through a swallowing wrapper, so
   * a failing exporter can neither influence nor break an admission decision (ADR-010).
   */
  observers?: Observer[];
}

/** Handle for driving the state machines by hand, when you want to own the call. */
export interface Gate {
  readonly ok: boolean;
  readonly key: string;
  readonly reason?: RejectionReason;
  readonly retryAfterMs?: number;
  /** Report the settled outcome. Runs it through the pipeline's classifier. */
  settle(outcome: unknown, latencyMs: number): void;
  /** Report a verdict you have already determined. */
  settleVerdict(verdict: Verdict, latencyMs: number): void;
}

export class Pipeline<I = unknown> {
  private readonly keyOf: (input: I) => string;
  private readonly classify: (outcome: unknown) => Verdict;
  private readonly timeoutMs: number | undefined;
  private readonly clock: Clock;
  private readonly random: Random;
  private readonly retryOptions: RetryOptions | undefined;
  /**
   * The most recent `Retry-After` an upstream sent, in ms. Set when an `overload` outcome
   * settles and consumed by the next retry, which prefers it over the computed backoff — a
   * provider telling you when to come back is better information than any curve.
   */
  private lastRetryAfterMs: number | undefined;
  private readonly observer: Required<Observer>;
  private readonly registry: KeyRegistry<Policy[]>;

  constructor(options: PipelineOptions<I>) {
    if (options.policies.length === 0) {
      throw new RangeError("pipeline requires at least one policy");
    }
    this.keyOf = options.key ?? (() => "default");
    this.classify = options.classify ?? classifyHttp;
    this.timeoutMs = options.timeoutMs;
    this.clock = options.clock ?? systemClock;
    this.random = options.random ?? systemRandom;
    this.retryOptions = options.retry;
    this.observer = safeObserver(options.observers ?? []);

    const clock = this.clock;
    const observer = this.observer;
    const random = this.random;
    this.registry = new KeyRegistry<Policy[]>({
      factory: (key) => options.policies.map((make) => make({ key, clock, observer, random })),
      maxKeys: options.registry?.maxKeys,
      ttlMs: options.registry?.ttlMs,
      clock,
    });
  }

  /** Policies for a key, creating them on first use. Useful for tests and telemetry. */
  policiesFor(key = "default"): Policy[] {
    return this.registry.get(key);
  }

  get trackedKeys(): string[] {
    return this.registry.keys();
  }

  /**
   * Ask every policy for admission, outermost first.
   *
   * If any refuses, every policy already admitted is settled with `rejected` so it can
   * release whatever it reserved — without that observation being recorded as evidence
   * about the upstream.
   */
  gate(input: I): Gate {
    const key = this.keyOf(input);
    const policies = this.registry.get(key);
    const admitted: Policy[] = [];

    for (const policy of policies) {
      const decision = policy.admit();
      if (decision.ok) {
        admitted.push(policy);
        continue;
      }
      const at = this.clock.now();
      for (let i = admitted.length - 1; i >= 0; i--) {
        admitted[i]?.settle({ verdict: "rejected", latencyMs: 0, at });
      }
      this.observer.onRejection({
        key,
        reason: decision.reason,
        policy: policy.name,
        ...(decision.retryAfterMs === undefined ? {} : { retryAfterMs: decision.retryAfterMs }),
      });
      const gate: Gate = {
        ok: false,
        key,
        reason: decision.reason,
        ...(decision.retryAfterMs === undefined ? {} : { retryAfterMs: decision.retryAfterMs }),
        settle: () => {},
        settleVerdict: () => {},
      };
      return gate;
    }

    const settleVerdict = (verdict: Verdict, latencyMs: number, retryAfterMs?: number): void => {
      const obs: Observation = { verdict, latencyMs, at: this.clock.now() };
      // Innermost first, so an inner policy releases its slot before an outer one reads state.
      for (let i = admitted.length - 1; i >= 0; i--) admitted[i]?.settle(obs);
      this.observer.onExecution({
        key,
        verdict,
        latencyMs,
        ...(retryAfterMs === undefined ? {} : { retryAfterMs }),
      });
    };

    return {
      ok: true,
      key,
      settleVerdict,
      settle: (outcome, latencyMs) => {
        const verdict = this.classify(outcome);
        // Only parse Retry-After when the verdict says the upstream is shedding — header
        // parsing is wasted work on the overwhelmingly common healthy path.
        const retryAfterMs =
          verdict === "overload"
            ? retryAfterFrom(outcome, this.clock.wallNow?.() ?? this.clock.now())
            : undefined;
        this.lastRetryAfterMs = retryAfterMs;
        settleVerdict(verdict, latencyMs, retryAfterMs);
      },
    };
  }

  /**
   * Run `fn` through the pipeline.
   *
   * The Executor is the only component in resilix that knows about promises; every policy
   * is a synchronous state machine. That is what keeps policies allocation-free, testable
   * without promise plumbing, and drivable by hand via `gate()`.
   */
  async execute<R>(input: I, fn: (ctx: ExecutionContext) => R | Promise<R>): Promise<R> {
    if (this.retryOptions === undefined) return this.attempt(input, fn);
    return this.executeWithRetry(input, fn, this.retryOptions);
  }

  /**
   * Retry sits OUTSIDE everything else, so each attempt re-consults the breaker, limiter and
   * throttler. That ordering is deliberate: a burst of retries inside a breaker would count as
   * many separate failures, whereas outside it is the budget — not the breaker's ignorance —
   * that bounds amplification.
   */
  private async executeWithRetry<R>(
    input: I,
    fn: (ctx: ExecutionContext) => R | Promise<R>,
    options: RetryOptions,
  ): Promise<R> {
    const maxAttempts = Math.max(1, options.maxAttempts ?? 3);
    const backoff = new Backoff(options, this.random);
    options.budget?.recordRequest();

    // `timeoutMs` bounds the WHOLE sequence, not each attempt.
    //
    // Most libraries apply it per attempt, which means a caller who asked for 30ms can wait
    // maxAttempts x (30ms + backoff) and has no way to express what they actually wanted. A
    // deadline the caller cannot see is not a deadline. Retrying past it is also pointless:
    // whoever is waiting has already given up.
    const deadline = this.timeoutMs === undefined ? undefined : this.clock.now() + this.timeoutMs;

    let lastError: unknown;
    for (let attempt = 0; attempt < maxAttempts; attempt++) {
      if (attempt > 0) {
        // Spend budget BEFORE waiting. A retry that the budget will refuse should not first
        // burn the caller's deadline sleeping.
        if (options.budget && !options.budget.tryConsume()) {
          this.observer.onRejection({
            key: this.keyOf(input),
            reason: "budget-exceeded",
            policy: "retry",
          });
          break;
        }
        const upstreamAsked =
          options.respectRetryAfter !== false ? this.lastRetryAfterMs : undefined;
        const delay = upstreamAsked ?? backoff.delayFor(attempt);

        // Stop if the wait alone would outlive the deadline. This also settles the spec's open
        // question about a `Retry-After` longer than the caller's timeout: fail now rather than
        // sleep through a deadline already promised to someone.
        if (deadline !== undefined && this.clock.now() + delay >= deadline) break;
        if (delay > 0) await this.sleep(delay);
        if (deadline !== undefined && this.clock.now() >= deadline) break;
      }

      try {
        return await this.attempt(input, fn);
      } catch (error) {
        lastError = error;
        if (!this.isRetryable(error)) throw error;
      }
    }
    throw lastError;
  }

  /**
   * Whether a failure is worth another attempt. The verdict model answers this directly, which
   * is the payoff for having it: `answered` means the upstream worked and the CALLER was wrong,
   * so no number of retries will change the outcome, and `rejected` means we refused it
   * ourselves. A boolean-predicate library retries both by default.
   */
  private isRetryable(error: unknown): boolean {
    const verdict = this.classify(error);
    return verdict === "transient" || verdict === "timeout" || verdict === "overload";
  }

  private sleep(ms: number): Promise<void> {
    return new Promise((resolve) => {
      const timer = setTimeout(resolve, ms);
      (timer as unknown as { unref?: () => void }).unref?.();
    });
  }

  private async attempt<R>(input: I, fn: (ctx: ExecutionContext) => R | Promise<R>): Promise<R> {
    const gate = this.gate(input);
    if (!gate.ok)
      throw new RejectedError(gate.key, gate.reason ?? "circuit-open", gate.retryAfterMs);

    const started = this.clock.now();
    // `mark()` freezes the latency at the caller's chosen moment — time to first token for a
    // stream. Without it we would judge a 45s streamed completion as slow, which is how a
    // slow-call breaker opens on a perfectly healthy streaming upstream.
    let markedAt: number | undefined;
    const mark = (): void => {
      if (markedAt === undefined) markedAt = this.clock.now();
    };
    const elapsed = (): number => Math.max(0, (markedAt ?? this.clock.now()) - started);

    let controller: AbortController | undefined;
    let timer: ReturnType<typeof setTimeout> | undefined;

    try {
      const ms = this.timeoutMs;
      if (ms === undefined) {
        const result = await fn({ key: gate.key, signal: undefined, mark });
        gate.settle(result, elapsed());
        return result;
      }

      // AbortController is constructed HERE, never at module scope. Cloudflare Workers
      // rejects timers and async I/O in global scope, which is what makes importing
      // cockatiel's retry crash `wrangler dev` (their #105, declined upstream).
      controller = new AbortController();
      const signal = controller.signal;

      const result = await new Promise<R>((resolve, reject) => {
        const failure = new TimeoutError(ms, gate.key);
        timer = setTimeout(() => {
          controller?.abort(failure);
          reject(failure);
        }, ms);
        // `unref` where available so a pending deadline cannot hold a Node process open.
        // Absent on Workers/Deno/browsers, where the timer handle is a plain number.
        (timer as unknown as { unref?: () => void }).unref?.();
        Promise.resolve(fn({ key: gate.key, signal, mark })).then(resolve, reject);
      });

      gate.settle(result, elapsed());
      return result;
    } catch (error) {
      gate.settle(error, elapsed());
      throw error;
    } finally {
      if (timer !== undefined) clearTimeout(timer);
    }
  }

  /**
   * Pull every policy's gauges for every tracked key.
   *
   * Pull rather than push, so instrumentation does no work on the hot path: an exporter
   * calls this on its own collection interval.
   */
  metrics(): Array<{ key: string; policy: string; values: Record<string, number> }> {
    const out: Array<{ key: string; policy: string; values: Record<string, number> }> = [];
    for (const key of this.registry.keys()) {
      for (const policy of this.registry.get(key)) {
        const values = policy.metrics?.();
        if (values) out.push({ key, policy: policy.name, values });
      }
    }
    return out;
  }

  snapshot(): Record<string, unknown[]> {
    const out: Record<string, unknown[]> = {};
    for (const key of this.registry.keys()) {
      out[key] = this.registry.get(key).map((p) => p.snapshot());
    }
    return out;
  }

  hydrate(state: Record<string, unknown[]>): void {
    for (const [key, states] of Object.entries(state)) {
      const policies = this.registry.get(key);
      states.forEach((s, i) => policies[i]?.hydrate(s));
    }
  }
}

export const pipeline = <I = unknown>(options: PipelineOptions<I>): Pipeline<I> =>
  new Pipeline<I>(options);
