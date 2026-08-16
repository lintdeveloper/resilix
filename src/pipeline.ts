import { classifyHttp, retryAfterFrom } from "./classify.ts";
import { systemClock } from "./clock.ts";
import { safeObserver } from "./observer.ts";
import type { Observer } from "./observer.ts";
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
    this.observer = safeObserver(options.observers ?? []);

    const clock = this.clock;
    const observer = this.observer;
    this.registry = new KeyRegistry<Policy[]>({
      factory: (key) => options.policies.map((make) => make({ key, clock, observer })),
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
