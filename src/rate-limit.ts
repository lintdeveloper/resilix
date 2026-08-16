import { systemClock } from "./clock.ts";
import { ADMIT, refuse } from "./types.ts";
import type { Admission, Clock, Observation, Policy, PolicyEnv, PolicyFactory } from "./types.ts";

export interface RateLimitOptions {
  /** Sustained calls per interval. */
  limit: number;
  /** The interval those calls are spread over. Default 1_000. */
  intervalMs?: number;
  /** Burst allowance. Default `limit` — one full interval's worth. */
  burst?: number;
}

export interface RateLimitSnapshot {
  tokens: number;
  lastRefillAt: number;
}

/**
 * Token bucket.
 *
 * Deliberately the least interesting policy in resilix. It is *proactive* — you have to know
 * the right number in advance — and for overload protection a reactive limiter is strictly
 * better, which is failsafe-go's guidance too. It exists because per-tenant and per-contract
 * quotas are real, and because `bottleneck` (13M downloads/week) is not composable as a policy.
 *
 * **A rate limiter does not bound concurrency.** By Little's Law `L = λW`: hold arrival rate λ
 * fixed, let time-in-system W triple during a degradation, and concurrency L triples with it. If
 * concurrency is what you care about, use `bulkhead()` for a fixed bound or `limiter()` for one
 * that adapts. This is the single most common confusion in the space, which is why it is in the
 * doc comment and not only in the docs.
 *
 * Refills continuously rather than per-interval, so a caller cannot get 2x `limit` by straddling
 * an interval boundary — the classic fixed-window bug.
 */
export class RateLimiter implements Policy<RateLimitSnapshot> {
  readonly name = "rateLimit";

  private readonly clock: Clock;
  private readonly limit: number;
  private readonly intervalMs: number;
  private readonly capacity: number;
  private readonly refillPerMs: number;

  private tokens: number;
  private lastRefillAt: number;

  constructor(options: RateLimitOptions, env?: Partial<PolicyEnv>) {
    if (!(options.limit > 0)) throw new RangeError("rateLimit limit must be > 0");
    const intervalMs = options.intervalMs ?? 1_000;
    if (!(intervalMs > 0)) throw new RangeError("rateLimit intervalMs must be > 0");

    this.limit = options.limit;
    this.intervalMs = intervalMs;
    this.capacity = Math.max(1, options.burst ?? options.limit);
    this.refillPerMs = this.limit / this.intervalMs;
    this.clock = env?.clock ?? systemClock;
    this.tokens = this.capacity;
    this.lastRefillAt = this.clock.now();
  }

  private refill(): void {
    const now = this.clock.now();
    const elapsed = now - this.lastRefillAt;
    if (elapsed <= 0) return;
    this.tokens = Math.min(this.capacity, this.tokens + elapsed * this.refillPerMs);
    this.lastRefillAt = now;
  }

  get available(): number {
    this.refill();
    return this.tokens;
  }

  admit(): Admission {
    this.refill();
    if (this.tokens >= 1) {
      this.tokens -= 1;
      return ADMIT;
    }
    // Tell the caller when a token will exist, rather than making them poll.
    const waitMs = Math.ceil((1 - this.tokens) / this.refillPerMs);
    return refuse("rate-limited", waitMs);
  }

  /**
   * Refund the token when the call never happened.
   *
   * A token bucket bounds ARRIVALS at the upstream, so it does not care how a call turned out —
   * with one exception. If an inner policy refused the call, there was no arrival, and keeping
   * the token would silently lower the effective rate below the configured one: you would be
   * paying for calls you never made. This is ADR-007 item 2, and it was found by the
   * conformance suite on its first run rather than by anyone reading the code.
   */
  settle(obs: Observation): void {
    if (obs.verdict !== "rejected") return;
    this.refill();
    this.tokens = Math.min(this.capacity, this.tokens + 1);
  }

  metrics(): Record<string, number> {
    return { tokens: this.available, capacity: this.capacity, limit: this.limit };
  }

  snapshot(): RateLimitSnapshot {
    return { tokens: this.available, lastRefillAt: this.lastRefillAt };
  }

  hydrate(state: RateLimitSnapshot): void {
    this.tokens = Math.max(0, Math.min(this.capacity, state.tokens));
    this.lastRefillAt = this.clock.now();
  }
}

export const rateLimit = (options: RateLimitOptions): PolicyFactory => {
  new RateLimiter(options);
  return (env: PolicyEnv) => new RateLimiter(options, env);
};
