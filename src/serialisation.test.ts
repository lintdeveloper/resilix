/**
 * snapshot / hydrate / metrics / reset for every policy.
 *
 * v0.1–v0.3 grew these tests as they went; v0.4 and v0.5 shipped the same surface untested,
 * which a coverage sweep caught. It matters more than the percentage suggests: serialising and
 * rehydrating state IS the serverless story, and ADR-005 already found one bug there — absolute
 * timestamps that meant nothing in a second process.
 */
import { describe, expect, it } from "vitest";
import { Backoff } from "./backoff.ts";
import { RetryBudget } from "./budget.ts";
import { FakeClock } from "./clock.ts";
import { AdaptiveLimiter } from "./limiter.ts";
import { FairShare } from "./priority.ts";
import { P2Quantile } from "./quantile.ts";
import { FakeRandom, constantRandom } from "./random.ts";
import { RateLimiter } from "./rate-limit.ts";
import { AdaptiveThrottler } from "./throttler.ts";

describe("AdaptiveLimiter", () => {
  it("round-trips its limit and baseline", () => {
    const clock = new FakeClock();
    const a = new AdaptiveLimiter({ initialLimit: 40, minSamples: 1 }, { clock });
    for (let i = 0; i < 100; i++) {
      a.admit();
      a.settle({ verdict: "success", latencyMs: 120, at: clock.now() });
      clock.advance(50);
    }

    const b = new AdaptiveLimiter({ initialLimit: 5 }, { clock });
    b.hydrate(a.snapshot());
    expect(b.currentLimit).toBe(a.currentLimit);
    expect(b.snapshot().baselineMs).toBe(a.snapshot().baselineMs);
  });

  it("clamps a hydrated limit into its own bounds", () => {
    const l = new AdaptiveLimiter({ minLimit: 4, maxLimit: 50 });
    l.hydrate({ limit: 5_000, baselineMs: 10, inFlight: 0 });
    expect(l.currentLimit).toBe(50);
    l.hydrate({ limit: 1, baselineMs: 10, inFlight: 0 });
    expect(l.currentLimit).toBe(4);
  });

  it("treats a zero baseline as unknown rather than as zero latency", () => {
    // A literal 0ms baseline would make every gradient look catastrophic.
    const l = new AdaptiveLimiter({});
    l.hydrate({ limit: 20, baselineMs: 0, inFlight: 0 });
    expect(l.metrics().baselineMs).toBe(0);
    l.admit();
    l.settle({ verdict: "success", latencyMs: 50, at: 0 });
    expect(l.currentLimit).toBeGreaterThan(0);
  });

  it("reports the gauges an exporter reads", () => {
    const l = new AdaptiveLimiter({ initialLimit: 10 });
    l.admit();
    const m = l.metrics();
    expect(Object.keys(m).sort()).toEqual([
      "baselineMs",
      "inFlight",
      "limit",
      "recentMs",
      "utilisation",
    ]);
    expect(m.inFlight).toBe(1);
  });

  it("rejects impossible bounds at construction", () => {
    expect(() => new AdaptiveLimiter({ minLimit: 0 })).toThrow(RangeError);
    expect(() => new AdaptiveLimiter({ minLimit: 50, maxLimit: 10 })).toThrow(RangeError);
  });
});

describe("AdaptiveThrottler", () => {
  it("round-trips its accept ratio", () => {
    const clock = new FakeClock();
    const a = new AdaptiveThrottler({ minRequests: 0 }, { clock, random: constantRandom(1) });
    for (let i = 0; i < 60; i++) {
      a.admit();
      a.settle({ verdict: i < 20 ? "success" : "transient", latencyMs: 5, at: clock.now() });
    }
    const b = new AdaptiveThrottler({ minRequests: 0 }, { clock, random: constantRandom(1) });
    b.hydrate(a.snapshot());
    expect(b.snapshot()).toEqual(a.snapshot());
    expect(b.rejectionRate).toBeCloseTo(a.rejectionRate, 5);
  });

  it("refuses to hydrate negative counters", () => {
    const t = new AdaptiveThrottler();
    t.hydrate({ requests: -5, accepts: -5 });
    expect(t.snapshot()).toEqual({ requests: 0, accepts: 0 });
  });

  it("rolls its window forward rather than accumulating forever", () => {
    const clock = new FakeClock();
    const t = new AdaptiveThrottler({ windowMs: 1_000, minRequests: 0 }, { clock });
    for (let i = 0; i < 50; i++) t.settle({ verdict: "transient", latencyMs: 1, at: clock.now() });
    expect(t.snapshot().requests).toBe(50);
    clock.advance(5_000);
    expect(t.snapshot().requests).toBe(0);
  });
});

describe("RateLimiter", () => {
  it("round-trips its tokens", () => {
    const clock = new FakeClock();
    const a = new RateLimiter({ limit: 10, intervalMs: 1_000 }, { clock });
    a.admit();
    a.admit();
    const b = new RateLimiter({ limit: 10, intervalMs: 1_000 }, { clock });
    b.hydrate(a.snapshot());
    expect(b.available).toBeCloseTo(a.available, 5);
  });

  it("clamps hydrated tokens to capacity", () => {
    const r = new RateLimiter({ limit: 5, burst: 5 });
    r.hydrate({ tokens: 999, lastRefillAt: 0 });
    expect(r.available).toBeLessThanOrEqual(5);
    r.hydrate({ tokens: -10, lastRefillAt: 0 });
    expect(r.available).toBeGreaterThanOrEqual(0);
  });

  it("ignores settle entirely — a bucket bounds arrivals, not outcomes", () => {
    const clock = new FakeClock();
    const r = new RateLimiter({ limit: 2, intervalMs: 10_000, burst: 2 }, { clock });
    r.admit();
    for (let i = 0; i < 20; i++) r.settle({ verdict: "transient", latencyMs: 1, at: 0 });
    expect(r.available).toBeCloseTo(1, 5);
  });

  it("exposes tokens, capacity and limit", () => {
    const r = new RateLimiter({ limit: 7, burst: 9 });
    expect(r.metrics()).toMatchObject({ capacity: 9, limit: 7 });
  });
});

describe("RetryBudget", () => {
  it("reports its window and permits the floor at low traffic", () => {
    const clock = new FakeClock();
    const b = new RetryBudget({ ratio: 0.1, minRetries: 5, clock });
    for (let i = 0; i < 3; i++) b.recordRequest();
    // 10% of 3 is 0, so without the floor a low-traffic service could never retry at all.
    let allowed = 0;
    for (let i = 0; i < 10; i++) if (b.tryConsume()) allowed++;
    expect(allowed).toBe(5);
    expect(b.metrics().allowed).toBe(5);
  });

  it("tracks the retry rate", () => {
    const clock = new FakeClock();
    const b = new RetryBudget({ ratio: 0.5, minRetries: 0, clock });
    for (let i = 0; i < 10; i++) b.recordRequest();
    b.tryConsume();
    expect(b.retryRate).toBeCloseTo(0.1, 5);
  });

  it("rolls its window, so an old burst does not bar retries forever", () => {
    const clock = new FakeClock();
    const b = new RetryBudget({ ratio: 0.1, minRetries: 0, windowMs: 1_000, clock });
    for (let i = 0; i < 100; i++) b.recordRequest();
    while (b.tryConsume()) {
      /* drain */
    }
    expect(b.tryConsume()).toBe(false);
    clock.advance(5_000);
    expect(b.metrics().requests).toBe(0);
  });

  it("reset() clears everything", () => {
    const b = new RetryBudget({ clock: new FakeClock() });
    b.recordRequest();
    b.reset();
    expect(b.metrics().requests).toBe(0);
  });
});

describe("Backoff", () => {
  it("reset() restarts the decorrelated sequence", () => {
    const b = new Backoff({ baseMs: 100, jitter: "decorrelated" }, constantRandom(1));
    const first = b.delayFor(1);
    b.delayFor(2);
    b.delayFor(3);
    b.reset();
    expect(b.delayFor(1)).toBeCloseTo(first, 5);
  });

  it("never returns a negative delay", () => {
    const r = new FakeRandom(9);
    for (const jitter of ["none", "full", "equal", "decorrelated"] as const) {
      const b = new Backoff({ baseMs: 50, jitter }, r);
      for (let n = 1; n <= 20; n++) expect(b.delayFor(n)).toBeGreaterThanOrEqual(0);
    }
  });
});

describe("FairShare", () => {
  it("reports how many tenants it is tracking, and reset clears them", () => {
    const f = new FairShare();
    f.record("a");
    f.record("b");
    expect(f.tenantCount).toBe(2);
    f.reset();
    expect(f.tenantCount).toBe(0);
  });

  it("treats an unknown tenant as fair", () => {
    const f = new FairShare();
    f.record("a");
    f.record("b");
    expect(f.overuse("never-seen")).toBe(0);
    expect(f.shouldShed(undefined, 1)).toBe(false);
  });

  it("drops tenants that decay away, bounding the map", () => {
    const f = new FairShare(10);
    for (let i = 0; i < 50; i++) f.record(`tenant-${i}`);
    for (let i = 0; i < 200; i++) f.record("persistent");
    expect(f.tenantCount).toBeLessThan(50);
  });
});

describe("P2Quantile", () => {
  it("survives being asked for an estimate mid-warm-up repeatedly", () => {
    const q = new P2Quantile(0.9);
    for (let i = 0; i < 4; i++) {
      q.push(i);
      expect(q.get()).toBeGreaterThanOrEqual(0);
    }
  });
});
