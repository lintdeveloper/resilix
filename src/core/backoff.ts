import type { Random } from "./random.ts";

/**
 * Backoff strategies, with AWS's formulas verbatim from *Exponential Backoff And Jitter*:
 *
 *   none          sleep = min(cap, base * 2^attempt)
 *   full          sleep = random(0, min(cap, base * 2^attempt))
 *   equal         sleep = min(cap, base*2^n)/2 + random(0, min(cap, base*2^n)/2)
 *   decorrelated  sleep = min(cap, random(base, sleep * 3))
 *
 * Their measured result: no-jitter is the "clear loser"; equal jitter takes "much longer"; full
 * and decorrelated both give "a substantial decrease in client work and server load", with full
 * using "less work, but slightly more time".
 */
export type JitterStrategy = "full" | "equal" | "decorrelated" | "none";

export interface BackoffOptions {
  /** First-retry delay before any exponential growth. Default 100 ms. */
  baseMs?: number;
  /** Ceiling on a single delay. Default 30_000. */
  maxDelayMs?: number;
  /**
   * Default `full`.
   *
   * Chosen over `decorrelated` because it costs the upstream less work at slightly more elapsed
   * time — and a library guarding someone else's service should not spend their capacity to
   * shave its own tail.
   */
  jitter?: JitterStrategy;
}

const DEFAULTS = { baseMs: 100, maxDelayMs: 30_000, jitter: "full" as JitterStrategy };

/**
 * Computes successive delays. Stateful, because `decorrelated` is defined in terms of the
 * PREVIOUS delay rather than the attempt number — one instance per call being retried.
 */
export class Backoff {
  private readonly baseMs: number;
  private readonly maxDelayMs: number;
  private readonly jitter: JitterStrategy;
  private readonly random: Random;
  /** Only `decorrelated` needs this; it seeds from `baseMs`. */
  private previous: number;

  constructor(options: BackoffOptions, random: Random) {
    this.baseMs = options.baseMs ?? DEFAULTS.baseMs;
    this.maxDelayMs = options.maxDelayMs ?? DEFAULTS.maxDelayMs;
    this.jitter = options.jitter ?? DEFAULTS.jitter;
    this.random = random;
    this.previous = this.baseMs;
  }

  /** Delay before `attempt`, where attempt 1 is the first RETRY (the initial call is attempt 0). */
  delayFor(attempt: number): number {
    const exponential = Math.min(this.maxDelayMs, this.baseMs * 2 ** Math.max(0, attempt - 1));

    switch (this.jitter) {
      case "none":
        return exponential;

      case "full":
        return this.random.next() * exponential;

      case "equal":
        return exponential / 2 + this.random.next() * (exponential / 2);

      case "decorrelated": {
        const next = Math.min(
          this.maxDelayMs,
          this.baseMs + this.random.next() * (this.previous * 3 - this.baseMs),
        );
        this.previous = Math.max(this.baseMs, next);
        return next;
      }
    }
  }

  reset(): void {
    this.previous = this.baseMs;
  }
}
