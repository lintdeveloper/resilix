import { systemClock } from "./clock.ts";
import { priorityOf, shouldShed } from "./priority.ts";
import { systemRandom } from "./random.ts";
import type { Random } from "./random.ts";
import { ADMIT, refuse } from "./types.ts";
import type {
  Admission,
  AdmissionRequest,
  Clock,
  Observation,
  Policy,
  PolicyEnv,
  PolicyFactory,
} from "./types.ts";

export interface ThrottlerOptions {
  /**
   * How much more the client may attempt than the upstream is accepting before it starts
   * self-regulating. Default 2 — Google SRE: "We generally prefer the 2x multiplier".
   *
   * They document a more aggressive alternative: "instead of having the client self-regulate
   * when `requests = 2 * accepts`, have it self-regulate when `requests = 1.1 * accepts`".
   */
  k?: number;
  /** Rolling window. Default 120_000 — "the last two minutes of its history". */
  windowMs?: number;
  /**
   * Ceiling on the rejection probability. Default 0.9 (failsafe-go).
   *
   * MUST stay below 1.0. At 1.0 the throttler stops sending traffic entirely, so it never
   * observes that the upstream recovered and can never reopen — the same trap that half-open
   * probes exist to avoid in a circuit breaker.
   */
  maxRejectionRate?: number;
  /**
   * Attempts required before it will throttle at all. Default 10.
   *
   * OURS. A two-minute window at 8 req/min holds ~16 samples, and rejecting on the strength of
   * two or three is noise. The breaker and limiter both needed a low-traffic floor; so does this.
   */
  minRequests?: number;
}

export interface ThrottlerSnapshot {
  requests: number;
  accepts: number;
}

const DEFAULTS = { k: 2, windowMs: 120_000, maxRejectionRate: 0.9, minRequests: 10 } as const;
const BUCKETS = 12;

/**
 * Google SRE client-side throttling.
 *
 *   reject with probability  max(0, (requests − K × accepts) / (requests + 1))
 *
 * Why this as well as a circuit breaker: a breaker is binary and stops learning while open. A
 * throttler sheds a *fraction*, so traffic keeps flowing, recovery is observed continuously, and
 * there is no cliff. It is the same argument Brooker makes against breakers (ADR-015) and the
 * same reason the v0.3 limiter sheds proportionally rather than at a hard edge.
 */
export class AdaptiveThrottler implements Policy<ThrottlerSnapshot> {
  readonly name = "throttler";

  private readonly clock: Clock;
  private readonly random: Random;
  private readonly k: number;
  private readonly windowMs: number;
  private readonly maxRejectionRate: number;
  private readonly minRequests: number;

  private readonly buckets: Array<{ at: number; requests: number; accepts: number }> = [];

  constructor(options: ThrottlerOptions = {}, env?: Partial<PolicyEnv> & { random?: Random }) {
    this.k = options.k ?? DEFAULTS.k;
    this.windowMs = options.windowMs ?? DEFAULTS.windowMs;
    this.maxRejectionRate = Math.min(0.999, options.maxRejectionRate ?? DEFAULTS.maxRejectionRate);
    this.minRequests = options.minRequests ?? DEFAULTS.minRequests;
    this.clock = env?.clock ?? systemClock;
    this.random = env?.random ?? systemRandom;
  }

  private bucket(): { at: number; requests: number; accepts: number } {
    const width = this.windowMs / BUCKETS;
    const slot = Math.floor(this.clock.now() / width);
    const last = this.buckets[this.buckets.length - 1];
    if (last && last.at === slot) return last;
    const created = { at: slot, requests: 0, accepts: 0 };
    this.buckets.push(created);
    while (this.buckets.length > 0) {
      const oldest = this.buckets[0];
      if (oldest && slot - oldest.at >= BUCKETS) this.buckets.shift();
      else break;
    }
    return created;
  }

  private totals(): { requests: number; accepts: number } {
    this.bucket();
    let requests = 0;
    let accepts = 0;
    for (const b of this.buckets) {
      requests += b.requests;
      accepts += b.accepts;
    }
    return { requests, accepts };
  }

  /** The probability a call is currently refused. Exposed so it can be graphed and asserted. */
  get rejectionRate(): number {
    const { requests, accepts } = this.totals();
    if (requests < this.minRequests) return 0;
    const raw = (requests - this.k * accepts) / (requests + 1);
    return Math.max(0, Math.min(this.maxRejectionRate, raw));
  }

  admit(request?: AdmissionRequest): Admission {
    const rate = this.rejectionRate;
    if (rate <= 0) return ADMIT;

    // Spend the shedding on the least important work first. The rejection rate doubles as the
    // pressure reading, so a throttler at 0.3 sheds bulk work and nothing else.
    if (shouldShed(rate, priorityOf(request))) return refuse("shed-by-priority");

    // Probabilistic on purpose. Deterministic shedding would make every client in a fleet
    // refuse the same requests in the same order, which is the correlation this exists to break.
    if (this.random.next() < rate) return refuse("throttled");
    return ADMIT;
  }

  /**
   * BOTH counters move here, not at admit.
   *
   * Counting a request at admit time looks harmless and is not: a call refused by any INNER
   * policy — a bulkhead, the limiter, a timeout — would be counted as a request that the
   * upstream never accepted, and the throttler would read our own shedding as upstream
   * distress. Measured with a perfectly healthy upstream behind a tight bulkhead, that drove
   * the rejection rate to its 0.9 ceiling: 60,000 requests, 2,802 accepts, and 54,103 calls
   * shed against a service that answered 200 to everything it was actually given.
   *
   * ADR-007 already says our own rejections are never upstream evidence. This is that rule
   * applied to the throttler's own accounting.
   */
  settle(obs: Observation): void {
    if (obs.verdict === "rejected") return;
    const bucket = this.bucket();
    bucket.requests++;
    // "Accepted by the backend" means the upstream did work — a 4xx counts, since the server
    // processed the request and answered. Overload, transport failure and our own deadline
    // do not.
    if (obs.verdict === "success" || obs.verdict === "answered") bucket.accepts++;
  }

  metrics(): Record<string, number> {
    const { requests, accepts } = this.totals();
    return { requests, accepts, rejectionRate: this.rejectionRate };
  }

  snapshot(): ThrottlerSnapshot {
    return this.totals();
  }

  hydrate(state: ThrottlerSnapshot): void {
    this.buckets.length = 0;
    const b = this.bucket();
    b.requests = Math.max(0, state.requests);
    b.accepts = Math.max(0, state.accepts);
  }
}

export const throttler = (options: ThrottlerOptions = {}): PolicyFactory => {
  new AdaptiveThrottler(options);
  return (env: PolicyEnv) => new AdaptiveThrottler(options, env);
};
