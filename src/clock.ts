import type { Clock } from "./types.ts";

/**
 * Default clock. Prefers `performance.now()` where it exists (monotonic, immune to
 * wall-clock adjustments) and falls back to `Date.now()`.
 *
 * Note the deliberate absence of module-scope work: nothing is read, timed, or
 * allocated at import time. Cloudflare Workers rejects asynchronous I/O, timers and
 * random values in global scope, which is what makes `import { retry } from 'cockatiel'`
 * crash `wrangler dev` (cockatiel #105, declined upstream). resilix must never
 * acquire that bug.
 */
export const systemClock: Clock = {
  now:
    typeof performance !== "undefined" && typeof performance.now === "function"
      ? () => performance.now()
      : () => Date.now(),
};

/**
 * Test clock. Every temporal assertion in this codebase is `clock.advance(ms)` —
 * there are no real timers and no `await sleep()` anywhere in the test suite.
 */
export class FakeClock implements Clock {
  private t: number;

  constructor(start = 0) {
    this.t = start;
  }

  now(): number {
    return this.t;
  }

  /** Move time forward. Returns the new value for convenience in assertions. */
  advance(ms: number): number {
    if (ms < 0) throw new RangeError("FakeClock.advance requires a non-negative duration");
    this.t += ms;
    return this.t;
  }

  set(ms: number): void {
    this.t = ms;
  }
}
