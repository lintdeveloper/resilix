import { ADMIT, refuse } from "./types.ts";
import type { Admission, Observation, Policy, PolicyEnv, PolicyFactory } from "./types.ts";

export interface BulkheadOptions {
  /** Maximum concurrent executions. */
  concurrency: number;
}

export interface BulkheadSnapshot {
  inFlight: number;
}

/**
 * A fixed concurrency cap — the ship-compartment metaphor: flooding one compartment does
 * not sink the vessel.
 *
 * This is a PROACTIVE limiter: it needs a number you have to know in advance, and it
 * cannot adapt when the upstream's real capacity changes. It is here because it is cheap,
 * predictable, and correct when you genuinely do know the limit (a connection pool size, a
 * contractual concurrency quota).
 *
 * For guarding against overload you want a REACTIVE limiter instead, because it infers
 * capacity from live latency rather than requiring you to guess it. That is `limiter()`
 * in v0.3.
 *
 * Note also, via Little's Law (L = λW), that a rate limiter is not a substitute: hold the
 * arrival rate λ fixed and let time-in-system W triple during a slowdown, and concurrency
 * L triples with it. A bulkhead bounds L directly.
 *
 * No queue in v0.1/v0.2: over the limit, admission is refused immediately. Queueing —
 * absorbing a small overshoot instead of converting it into errors — arrives with the
 * adaptive limiter, where the queue bounds scale with the adapting limit.
 */
export class Bulkhead implements Policy<BulkheadSnapshot> {
  readonly name = "bulkhead";

  private readonly limit: number;
  private inFlight = 0;

  constructor(options: BulkheadOptions, _env?: Partial<PolicyEnv>) {
    if (!Number.isInteger(options.concurrency) || options.concurrency < 1) {
      throw new RangeError("bulkhead concurrency must be a positive integer");
    }
    this.limit = options.concurrency;
  }

  get inFlightCount(): number {
    return this.inFlight;
  }

  admit(): Admission {
    if (this.inFlight >= this.limit) return refuse("bulkhead-full");
    this.inFlight++;
    return ADMIT;
  }

  /**
   * Release the slot. Note this runs for EVERY verdict including `rejected`: an inner
   * policy may have refused after we admitted, and leaking the slot would permanently
   * shrink our capacity. Releasing is bookkeeping, not evidence.
   */
  settle(_obs: Observation): void {
    this.inFlight = Math.max(0, this.inFlight - 1);
  }

  metrics(): Record<string, number> {
    return { inFlight: this.inFlight, limit: this.limit, utilisation: this.inFlight / this.limit };
  }

  snapshot(): BulkheadSnapshot {
    return { inFlight: this.inFlight };
  }

  hydrate(state: BulkheadSnapshot): void {
    this.inFlight = Math.max(0, Math.min(this.limit, state.inFlight));
  }
}

export const bulkhead = (options: BulkheadOptions): PolicyFactory => {
  new Bulkhead(options);
  return (env: PolicyEnv) => new Bulkhead(options, env);
};
