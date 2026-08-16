import { systemClock } from "./clock.ts";
import type { Clock } from "./types.ts";

export interface BudgetOptions {
  /**
   * Retries permitted as a fraction of total requests. Default 0.1.
   *
   * Google SRE: a per-client budget at this ratio holds worst-case amplification to ~1.1x
   * instead of 3x. That published number is why the ratio-of-requests shape was chosen over
   * failsafe-go's fraction-of-concurrency — it is the one you can reason about.
   */
  ratio?: number;
  /**
   * Retries always permitted regardless of ratio, per window. Default 5 (failsafe-go's
   * `minConcurrency`, in spirit).
   *
   * Without a floor a low-traffic service can never retry at all: at 8 req/min, 10% of a
   * two-minute window is 1.6 retries. The breaker and the limiter both needed an equivalent
   * low-traffic escape hatch, and so does this.
   */
  minRetries?: number;
  /** Rolling window. Default 120_000 — the two minutes Google SRE uses. */
  windowMs?: number;
  clock?: Clock;
}

/**
 * A shared retry budget.
 *
 * Deliberately NOT a policy and NOT per-pipeline: a per-policy cap does not bound system-wide
 * amplification, which is the entire point. Construct one and pass the same instance to every
 * retry (and, later, every hedge) in the process.
 *
 * Worth stating plainly, because Brooker's simulation says so: this is not a solved problem. He
 * compares a token bucket against a retry circuit breaker and finds neither ideal — the breaker
 * "is tripping too early" with many clients, while the token bucket "doesn't deplete its bucket
 * fast enough". A budget bounds the worst case; it does not make retries free.
 */
export class RetryBudget {
  private readonly ratio: number;
  private readonly minRetries: number;
  private readonly windowMs: number;
  private readonly clock: Clock;

  /** Ring of bucketed counts, so the window rolls without storing every event. */
  private readonly buckets: Array<{ at: number; requests: number; retries: number }> = [];
  private static readonly BUCKETS = 12;

  constructor(options: BudgetOptions = {}) {
    this.ratio = options.ratio ?? 0.1;
    this.minRetries = options.minRetries ?? 5;
    this.windowMs = options.windowMs ?? 120_000;
    this.clock = options.clock ?? systemClock;
  }

  private bucketFor(now: number): { at: number; requests: number; retries: number } {
    const width = this.windowMs / RetryBudget.BUCKETS;
    const slot = Math.floor(now / width);
    const last = this.buckets[this.buckets.length - 1];
    if (last && last.at === slot) return last;

    const created = { at: slot, requests: 0, retries: 0 };
    this.buckets.push(created);
    this.evict(slot);
    return created;
  }

  private evict(currentSlot: number): void {
    while (this.buckets.length > 0) {
      const oldest = this.buckets[0];
      if (oldest && currentSlot - oldest.at >= RetryBudget.BUCKETS) this.buckets.shift();
      else break;
    }
  }

  /** Count an initial attempt. Every call must be recorded, or the ratio is meaningless. */
  recordRequest(): void {
    this.bucketFor(this.clock.now()).requests++;
  }

  private totals(): { requests: number; retries: number } {
    const width = this.windowMs / RetryBudget.BUCKETS;
    this.evict(Math.floor(this.clock.now() / width));
    let requests = 0;
    let retries = 0;
    for (const b of this.buckets) {
      requests += b.requests;
      retries += b.retries;
    }
    return { requests, retries };
  }

  /** May one more retry be spent? Consumes it if so. */
  tryConsume(): boolean {
    const { requests, retries } = this.totals();
    const allowed = Math.max(this.minRetries, Math.floor(requests * this.ratio));
    if (retries >= allowed) return false;
    this.bucketFor(this.clock.now()).retries++;
    return true;
  }

  /** Retries as a fraction of requests over the window. The number to graph. */
  get retryRate(): number {
    const { requests, retries } = this.totals();
    return requests === 0 ? 0 : retries / requests;
  }

  metrics(): Record<string, number> {
    const { requests, retries } = this.totals();
    return {
      requests,
      retries,
      retryRate: requests === 0 ? 0 : retries / requests,
      allowed: Math.max(this.minRetries, Math.floor(requests * this.ratio)),
    };
  }

  reset(): void {
    this.buckets.length = 0;
  }
}

export const budget = (options: BudgetOptions = {}): RetryBudget => new RetryBudget(options);
