import { classifyHttp } from "./classify.ts";
import { systemClock } from "./clock.ts";
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
  private readonly registry: KeyRegistry<Policy[]>;

  constructor(options: PipelineOptions<I>) {
    if (options.policies.length === 0) {
      throw new RangeError("pipeline requires at least one policy");
    }
    this.keyOf = options.key ?? (() => "default");
    this.classify = options.classify ?? classifyHttp;
    this.timeoutMs = options.timeoutMs;
    this.clock = options.clock ?? systemClock;

    const clock = this.clock;
    this.registry = new KeyRegistry<Policy[]>({
      factory: (key) => options.policies.map((make) => make({ key, clock })),
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

    const settleVerdict = (verdict: Verdict, latencyMs: number): void => {
      const obs: Observation = { verdict, latencyMs, at: this.clock.now() };
      for (let i = admitted.length - 1; i >= 0; i--) admitted[i]?.settle(obs);
    };

    return {
      ok: true,
      key,
      settleVerdict,
      settle: (outcome, latencyMs) => settleVerdict(this.classify(outcome), latencyMs),
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
    const elapsed = (): number => Math.max(0, this.clock.now() - started);

    let controller: AbortController | undefined;
    let timer: ReturnType<typeof setTimeout> | undefined;

    try {
      const ms = this.timeoutMs;
      if (ms === undefined) {
        const result = await fn({ key: gate.key, signal: undefined });
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
        Promise.resolve(fn({ key: gate.key, signal })).then(resolve, reject);
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
