/**
 * A simulated LLM provider that misbehaves the way real ones do.
 *
 * The point of the demo is the *transition*: a provider that stays healthy or
 * stays broken teaches you nothing. This one degrades gradually, starts pushing
 * back, then recovers — which is the shape resilix is built for and the shape a
 * failure-rate breaker cannot see until it is too late.
 */

export type Phase = "healthy" | "degrading" | "overloaded" | "recovering";

/**
 * Compresses the whole scenario when the run is short. CI runs this for a few
 * seconds purely to prove it does not crash; a human wants to watch it happen.
 */
export const SPEED = Number(process.env.RESILIX_EXAMPLE_SPEED ?? "1");

export interface Reply {
  status: number;
  /** Time to first token. The only latency that means anything for a stream. */
  ttfbMs: number;
  retryAfterS?: number;
}

/** Deterministic PRNG so two runs of the demo tell the same story. */
const mulberry32 = (seed: number) => {
  let state = seed | 0;
  return () => {
    state = (state + 0x6d2b79f5) | 0;
    let t = Math.imul(state ^ (state >>> 15), 1 | state);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
};

export class FakeProvider {
  private readonly rand = mulberry32(0xc0ffee);
  private inFlight = 0;

  constructor(private readonly startedAt = Date.now()) {}

  phase(now = Date.now()): Phase {
    const s = (now - this.startedAt) / 1000;
    const t = s * SPEED;
    if (t < 8) return "healthy";
    if (t < 18) return "degrading";
    if (t < 26) return "overloaded";
    return "recovering";
  }

  /**
   * Serve one request. Latency rises with concurrency once degraded — which is
   * what makes a concurrency limit the right lever rather than a rate limit.
   */
  async call(now = Date.now()): Promise<Reply> {
    const phase = this.phase(now);
    this.inFlight++;
    try {
      const queueing = Math.max(0, this.inFlight - 4);
      let ttfb: number;
      switch (phase) {
        case "healthy":
          ttfb = 90 + this.rand() * 60;
          break;
        case "degrading":
          // The incident this library came from: ~25x slower at a FLAT error rate.
          ttfb = 400 + queueing * 260 + this.rand() * 400;
          break;
        case "overloaded":
          ttfb = 700 + queueing * 300 + this.rand() * 600;
          break;
        default:
          ttfb = 140 + queueing * 40 + this.rand() * 120;
      }

      await sleep(ttfb);

      // Healthy traffic contains a lot of 4xx — bad prompts, oversized inputs.
      // A boolean "did it reject?" breaker opens on this. It must not.
      if (this.rand() < 0.15) return { status: 422, ttfbMs: ttfb };
      if (phase === "overloaded" && this.rand() < 0.45) {
        return { status: 429, ttfbMs: ttfb, retryAfterS: 2 };
      }
      if (phase !== "healthy" && this.rand() < 0.05) return { status: 500, ttfbMs: ttfb };
      return { status: 200, ttfbMs: ttfb };
    } finally {
      this.inFlight--;
    }
  }
}

export const sleep = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));
