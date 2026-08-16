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
  wallNow: () => Date.now(),
};

/**
 * Test clock. Every temporal assertion in this codebase is `clock.advance(ms)` —
 * there are no real timers and no `await sleep()` anywhere in the test suite.
 */
export class FakeClock implements Clock {
  private t: number;
  private wall: number;

  /**
   * `start` is the monotonic origin; `wallStart` is the epoch origin. They are deliberately
   * different by default, so any test that confuses the two fails immediately — which is
   * exactly the bug this pair of clocks exists to prevent.
   */
  constructor(start = 0, wallStart = 1_700_000_000_000) {
    this.t = start;
    this.wall = wallStart;
  }

  now(): number {
    return this.t;
  }

  wallNow(): number {
    return this.wall;
  }

  /** Move wall-clock time only — simulates a snapshot sitting idle between processes. */
  advanceWall(ms: number): number {
    if (ms < 0) throw new RangeError("FakeClock.advanceWall requires a non-negative duration");
    this.wall += ms;
    return this.wall;
  }

  /** Move both clocks forward. Returns the new monotonic value, for use in assertions. */
  advance(ms: number): number {
    if (ms < 0) throw new RangeError("FakeClock.advance requires a non-negative duration");
    this.t += ms;
    this.wall += ms;
    return this.t;
  }

  set(ms: number): void {
    this.t = ms;
  }
}
