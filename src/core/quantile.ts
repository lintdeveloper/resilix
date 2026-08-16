/**
 * Streaming quantile estimation.
 *
 * The adaptive limiter needs a p90 of recent latencies, per call, per key. Sorting a window on
 * every request is O(n log n) on the hot path and allocates; a full sketch (t-digest, HDR) is a
 * lot of machinery for a single fixed quantile. P² gives one quantile in O(1) time and constant
 * memory, which is exactly the shape of the requirement.
 *
 * `docs/specs/adaptive-limiter.md` §9.3 requires this to be validated against exact quantiles on
 * bursty, skewed and bimodal distributions before it is trusted — see `quantile.test.ts`. The
 * bounded sorted ring below is the fallback that validation could have forced.
 */

export interface Quantile {
  /** Record one sample. */
  push(value: number): void;
  /** Current estimate, or undefined before enough samples exist. */
  get(): number | undefined;
  readonly count: number;
  reset(): void;
}

/**
 * P² (Jain & Chlamtac, 1985): five markers tracking the min, the quantile, and the max, moved by
 * a piecewise-parabolic prediction as samples arrive. No sample is ever stored.
 */
export class P2Quantile implements Quantile {
  private readonly p: number;
  /** Marker heights — the estimated values at each marker. */
  private readonly q = [0, 0, 0, 0, 0];
  /** Marker positions — how many samples fall at or below each marker. */
  private readonly n = [0, 0, 0, 0, 0];
  /** Desired marker positions. */
  private readonly np = [0, 0, 0, 0, 0];
  /** Per-sample increment of the desired positions. */
  private readonly dn = [0, 0, 0, 0, 0];
  private seen = 0;
  /** First five samples, held only until initialisation. */
  private readonly warmup: number[] = [];

  constructor(p = 0.9) {
    if (!(p > 0 && p < 1)) throw new RangeError("quantile must be strictly between 0 and 1");
    this.p = p;
    this.dn = [0, p / 2, p, (1 + p) / 2, 1] as unknown as number[];
  }

  get count(): number {
    return this.seen;
  }

  push(value: number): void {
    this.seen++;

    if (this.seen <= 5) {
      this.warmup.push(value);
      if (this.seen === 5) {
        this.warmup.sort((a, b) => a - b);
        for (let i = 0; i < 5; i++) {
          this.q[i] = this.warmup[i] as number;
          this.n[i] = i;
          this.np[i] = 4 * (this.dn[i] as number);
        }
      }
      return;
    }

    // 1. find the cell the sample lands in, extending the outer markers if it falls beyond them
    let k: number;
    if (value < (this.q[0] as number)) {
      this.q[0] = value;
      k = 0;
    } else if (value >= (this.q[4] as number)) {
      this.q[4] = value;
      k = 3;
    } else {
      k = 0;
      for (let i = 1; i < 5; i++) {
        if (value < (this.q[i] as number)) {
          k = i - 1;
          break;
        }
      }
    }

    // 2. shift positions right of the cell, and advance every desired position
    for (let i = k + 1; i < 5; i++) this.n[i] = (this.n[i] as number) + 1;
    for (let i = 0; i < 5; i++) this.np[i] = (this.np[i] as number) + (this.dn[i] as number);

    // 3. nudge the three interior markers toward their desired positions
    for (let i = 1; i <= 3; i++) {
      const d = (this.np[i] as number) - (this.n[i] as number);
      const nPrev = this.n[i - 1] as number;
      const nCur = this.n[i] as number;
      const nNext = this.n[i + 1] as number;

      if ((d >= 1 && nNext - nCur > 1) || (d <= -1 && nPrev - nCur < -1)) {
        const step = d >= 0 ? 1 : -1;
        const parabolic = this.parabolic(i, step);
        // Use the parabolic prediction only while it keeps the markers ordered; otherwise fall
        // back to linear. This guard is the part naive implementations omit, and without it the
        // estimate can cross a neighbour and never recover.
        this.q[i] =
          (this.q[i - 1] as number) < parabolic && parabolic < (this.q[i + 1] as number)
            ? parabolic
            : this.linear(i, step);
        this.n[i] = nCur + step;
      }
    }
  }

  private parabolic(i: number, d: number): number {
    const q = this.q as number[];
    const n = this.n as number[];
    const qi = q[i] as number;
    const qPrev = q[i - 1] as number;
    const qNext = q[i + 1] as number;
    const ni = n[i] as number;
    const nPrev = n[i - 1] as number;
    const nNext = n[i + 1] as number;

    return (
      qi +
      (d / (nNext - nPrev)) *
        ((ni - nPrev + d) * ((qNext - qi) / (nNext - ni)) +
          (nNext - ni - d) * ((qi - qPrev) / (ni - nPrev)))
    );
  }

  private linear(i: number, d: number): number {
    const q = this.q as number[];
    const n = this.n as number[];
    const qi = q[i] as number;
    return qi + (d * ((q[i + d] as number) - qi)) / ((n[i + d] as number) - (n[i] as number));
  }

  get(): number | undefined {
    if (this.seen === 0) return undefined;
    // Below five samples there are no markers yet; the sorted warm-up buffer is exact anyway.
    if (this.seen < 5) {
      const sorted = [...this.warmup].sort((a, b) => a - b);
      const idx = Math.min(sorted.length - 1, Math.floor(this.p * sorted.length));
      return sorted[idx];
    }
    return this.q[2];
  }

  reset(): void {
    this.seen = 0;
    this.warmup.length = 0;
    for (let i = 0; i < 5; i++) {
      this.q[i] = 0;
      this.n[i] = 0;
      this.np[i] = 0;
    }
  }
}

/**
 * Exact quantile over a bounded ring of the most recent `size` samples.
 *
 * The fallback named in the spec. O(size) per read rather than O(1), but exact within its
 * window, and at size 64 the read is cheap enough to be defensible. Useful when P² has not yet
 * warmed up, and as the oracle the P² tests compare against.
 */
export class RingQuantile implements Quantile {
  private readonly buf: Float64Array;
  private readonly p: number;
  private idx = 0;
  private filled = 0;

  constructor(p = 0.9, size = 64) {
    if (!(p > 0 && p < 1)) throw new RangeError("quantile must be strictly between 0 and 1");
    this.p = p;
    this.buf = new Float64Array(size);
  }

  get count(): number {
    return this.filled;
  }

  push(value: number): void {
    this.buf[this.idx] = value;
    this.idx = (this.idx + 1) % this.buf.length;
    if (this.filled < this.buf.length) this.filled++;
  }

  get(): number | undefined {
    if (this.filled === 0) return undefined;
    const sorted = Array.from(this.buf.subarray(0, this.filled)).sort((a, b) => a - b);
    const rank = Math.min(sorted.length - 1, Math.floor(this.p * sorted.length));
    return sorted[rank];
  }

  reset(): void {
    this.idx = 0;
    this.filled = 0;
  }
}
