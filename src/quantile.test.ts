/**
 * `docs/specs/adaptive-limiter.md` §9.3 makes this validation a precondition of using P²:
 * "Validate against exact quantiles on bursty, skewed and bimodal distributions before
 * committing; the bounded sorted ring (n ≤ 64) is the fallback."
 *
 * So these tests are the decision, not a formality. If P² cannot hold ~5% against a realistic
 * latency distribution, the limiter uses RingQuantile instead.
 */
import { describe, expect, it } from "vitest";
import { P2Quantile, RingQuantile } from "./quantile.ts";

/** Deterministic PRNG — no Math.random, so a failure is always reproducible. */
const rng = (seed: number) => () => {
  seed = (seed * 1103515245 + 12345) & 0x7fffffff;
  return seed / 0x7fffffff;
};

const exact = (values: number[], p: number): number => {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.floor(p * sorted.length))] as number;
};

/** Relative error against the exact quantile of the same samples. */
const errorFor = (values: number[], p = 0.9): number => {
  const est = new P2Quantile(p);
  for (const v of values) est.push(v);
  const truth = exact(values, p);
  const got = est.get() as number;
  return Math.abs(got - truth) / Math.max(1, truth);
};

describe("P2Quantile — accuracy against exact quantiles", () => {
  it("uniform latencies", () => {
    const r = rng(1);
    const values = Array.from({ length: 10_000 }, () => r() * 1000);
    expect(errorFor(values)).toBeLessThan(0.05);
  });

  it("log-normal — the shape real latency actually has", () => {
    const r = rng(2);
    const values = Array.from({ length: 10_000 }, () => {
      // Box-Muller into a log-normal, which is the canonical latency distribution.
      const u1 = Math.max(1e-9, r());
      const u2 = r();
      const z = Math.sqrt(-2 * Math.log(u1)) * Math.cos(2 * Math.PI * u2);
      return Math.exp(4 + 0.8 * z);
    });
    expect(errorFor(values)).toBeLessThan(0.05);
  });

  it("bimodal — a fast cache path and a slow origin path", () => {
    const r = rng(3);
    const values = Array.from({ length: 10_000 }, () =>
      r() < 0.8 ? 20 + r() * 10 : 800 + r() * 200,
    );
    expect(errorFor(values)).toBeLessThan(0.05);
  });

  it("bursty — a healthy baseline with a degradation in the middle", () => {
    const r = rng(4);
    const values: number[] = [];
    for (let i = 0; i < 4_000; i++) values.push(30 + r() * 20);
    for (let i = 0; i < 2_000; i++) values.push(3_000 + r() * 2_000); // the incident
    for (let i = 0; i < 4_000; i++) values.push(30 + r() * 20);
    expect(errorFor(values)).toBeLessThan(0.1);
  });

  it("heavily skewed — a few enormous outliers", () => {
    const r = rng(5);
    const values = Array.from({ length: 10_000 }, (_, i) => (i % 500 === 0 ? 60_000 : r() * 50));
    expect(errorFor(values)).toBeLessThan(0.05);
  });

  it("holds across p50, p90, p95 and p99", () => {
    const r = rng(6);
    const values = Array.from({ length: 20_000 }, () => Math.exp(3 + 1.2 * r()));
    for (const p of [0.5, 0.9, 0.95, 0.99]) {
      expect(errorFor(values, p)).toBeLessThan(0.06);
    }
  });

  it("is exact for a constant stream", () => {
    const est = new P2Quantile(0.9);
    for (let i = 0; i < 1_000; i++) est.push(42);
    expect(est.get()).toBe(42);
  });

  it("keeps its markers ordered under a monotonic ramp", () => {
    // The pathological input for a naive P²: strictly increasing samples push every marker in
    // the same direction, and an unguarded parabolic step can cross a neighbour.
    const est = new P2Quantile(0.9);
    const values: number[] = [];
    for (let i = 1; i <= 5_000; i++) {
      est.push(i);
      values.push(i);
    }
    const got = est.get() as number;
    const truth = exact(values, 0.9);
    expect(got).toBeGreaterThan(0);
    expect(Math.abs(got - truth) / truth).toBeLessThan(0.05);
  });
});

describe("P2Quantile — small-sample behaviour", () => {
  it("returns undefined with no samples", () => {
    expect(new P2Quantile(0.9).get()).toBeUndefined();
  });

  it("is exact below five samples, where markers do not exist yet", () => {
    const est = new P2Quantile(0.9);
    for (const v of [50, 10, 30]) est.push(v);
    expect(est.get()).toBe(exact([50, 10, 30], 0.9));
  });

  it("reports how many samples it has seen", () => {
    const est = new P2Quantile(0.9);
    for (let i = 0; i < 7; i++) est.push(i);
    expect(est.count).toBe(7);
  });

  it("reset() clears everything", () => {
    const est = new P2Quantile(0.9);
    for (let i = 0; i < 100; i++) est.push(i);
    est.reset();
    expect(est.count).toBe(0);
    expect(est.get()).toBeUndefined();
  });

  it("rejects a quantile outside (0,1)", () => {
    expect(() => new P2Quantile(0)).toThrow(RangeError);
    expect(() => new P2Quantile(1)).toThrow(RangeError);
  });
});

describe("RingQuantile — the exact fallback", () => {
  it("is exact within its window", () => {
    const r = new RingQuantile(0.9, 64);
    const values: number[] = [];
    for (let i = 0; i < 64; i++) {
      r.push(i);
      values.push(i);
    }
    expect(r.get()).toBe(exact(values, 0.9));
  });

  it("forgets samples beyond its window", () => {
    const r = new RingQuantile(0.5, 10);
    for (let i = 0; i < 10; i++) r.push(1000);
    for (let i = 0; i < 10; i++) r.push(5);
    expect(r.get()).toBe(5);
  });

  it("tracks a level shift that P² would smear", () => {
    // The tradeoff, stated: P² weights all history, so a step change moves it slowly. The ring
    // forgets. That is the reason the limiter also resets its estimator per window.
    const ring = new RingQuantile(0.9, 64);
    const p2 = new P2Quantile(0.9);
    for (let i = 0; i < 2_000; i++) {
      ring.push(10);
      p2.push(10);
    }
    for (let i = 0; i < 64; i++) {
      ring.push(1_000);
      p2.push(1_000);
    }
    expect(ring.get()).toBe(1_000);
    expect(p2.get()).toBeLessThan(1_000);
  });
});
