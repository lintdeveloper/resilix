import { describe, expect, it } from "vitest";
import type { Observation, Verdict } from "./types.ts";
import { RollingWindow } from "./window.ts";

const obs = (at: number, verdict: Verdict, latencyMs = 10): Observation => ({
  at,
  verdict,
  latencyMs,
});

describe("RollingWindow", () => {
  it("validates its options", () => {
    expect(() => new RollingWindow({ calls: 0, maxAgeMs: 1000, slowCallMs: 100 })).toThrow(
      RangeError,
    );
    expect(() => new RollingWindow({ calls: 10, maxAgeMs: 0, slowCallMs: 100 })).toThrow(
      RangeError,
    );
    expect(() => new RollingWindow({ calls: 10, maxAgeMs: 1000, slowCallMs: 0 })).toThrow(
      RangeError,
    );
  });

  it("is bounded by COUNT", () => {
    const w = new RollingWindow({ calls: 5, maxAgeMs: 1_000_000, slowCallMs: 100 });
    for (let i = 0; i < 50; i++) w.push(obs(i, "success"));
    expect(w.size).toBe(5);
  });

  it("is bounded by AGE", () => {
    const w = new RollingWindow({ calls: 1000, maxAgeMs: 100, slowCallMs: 50 });
    for (let i = 0; i < 10; i++) w.push(obs(i * 50, "success"));
    // Last push at t=450, so cutoff is 350. The bound is INCLUSIVE (`at >= cutoff`),
    // so 350, 400 and 450 survive.
    expect(w.size).toBe(3);
  });

  it("treats the age bound as inclusive at the boundary", () => {
    const w = new RollingWindow({ calls: 100, maxAgeMs: 100, slowCallMs: 50 });
    w.push(obs(0, "success"));
    w.push(obs(100, "success")); // exactly maxAgeMs old relative to itself's cutoff of 0
    expect(w.size).toBe(2);
    w.push(obs(101, "success")); // cutoff 1 -> the t=0 sample is now too old
    expect(w.size).toBe(2);
  });

  it("applies BOTH bounds — whichever yields fewer samples", () => {
    // The dual bound is the whole point: count-only goes stale at low traffic,
    // time-only is unbounded at high traffic.
    const w = new RollingWindow({ calls: 3, maxAgeMs: 10_000, slowCallMs: 100 });
    for (let i = 0; i < 10; i++) w.push(obs(i, "success"));
    expect(w.size).toBe(3); // count bound wins at high rate

    const slow = new RollingWindow({ calls: 100, maxAgeMs: 100, slowCallMs: 100 });
    for (let i = 0; i < 10; i++) slow.push(obs(i * 1000, "success"));
    expect(slow.size).toBe(1); // age bound wins at low rate
  });

  it("computes failureRate from transient/timeout only", () => {
    const w = new RollingWindow({ calls: 10, maxAgeMs: 1_000_000, slowCallMs: 1000 });
    w.push(obs(1, "success"));
    w.push(obs(2, "answered")); // 4xx: healthy
    w.push(obs(3, "overload")); // 429: healthy for the breaker
    w.push(obs(4, "transient"));
    w.push(obs(5, "timeout"));
    expect(w.size).toBe(5);
    expect(w.failureRate).toBeCloseTo(2 / 5);
  });

  it("computes slowRate independently of the verdict", () => {
    const w = new RollingWindow({ calls: 10, maxAgeMs: 1_000_000, slowCallMs: 1000 });
    w.push(obs(1, "success", 5_000)); // succeeded, but slow
    w.push(obs(2, "success", 10));
    w.push(obs(3, "answered", 9_000)); // a slow 4xx is still slow
    w.push(obs(4, "success", 10));
    expect(w.failureRate).toBe(0);
    expect(w.slowRate).toBeCloseTo(0.5);
  });

  it("ignores `rejected` entirely — our own shedding is not evidence", () => {
    const w = new RollingWindow({ calls: 10, maxAgeMs: 1_000_000, slowCallMs: 100 });
    w.push(obs(1, "rejected"));
    w.push(obs(2, "rejected"));
    expect(w.size).toBe(0);
    expect(w.failureRate).toBe(0);
  });

  it("reports zero rates when empty rather than NaN", () => {
    const w = new RollingWindow({ calls: 10, maxAgeMs: 1000, slowCallMs: 100 });
    expect(w.failureRate).toBe(0);
    expect(w.slowRate).toBe(0);
  });

  it("clear() resets size and both counters", () => {
    const w = new RollingWindow({ calls: 10, maxAgeMs: 1_000_000, slowCallMs: 10 });
    w.push(obs(1, "transient", 500));
    w.clear();
    expect(w.size).toBe(0);
    expect(w.failureRate).toBe(0);
    expect(w.slowRate).toBe(0);
  });

  it("round-trips through snapshot/hydrate", () => {
    const a = new RollingWindow({ calls: 8, maxAgeMs: 1_000_000, slowCallMs: 100 });
    for (let i = 0; i < 12; i++) {
      a.push(obs(i * 10, i % 3 === 0 ? "transient" : "success", i % 2 === 0 ? 500 : 10));
    }
    const b = new RollingWindow({ calls: 8, maxAgeMs: 1_000_000, slowCallMs: 100 });
    b.hydrate(a.snapshot(110), 110);
    expect(b.size).toBe(a.size);
    expect(b.failureRate).toBeCloseTo(a.failureRate);
    expect(b.slowRate).toBeCloseTo(a.slowRate);
  });

  it("snapshots sample times as AGES, not absolute clock readings", () => {
    // now() is monotonic with an arbitrary origin, so an absolute value serialised in one
    // process is meaningless in the next.
    const w = new RollingWindow({ calls: 8, maxAgeMs: 10_000, slowCallMs: 100 });
    w.push(obs(1_000, "success"));
    w.push(obs(1_500, "transient"));
    const snap = w.snapshot(2_000);
    expect(snap.ageMs).toEqual([1_000, 500]);
    expect(snap.failure).toEqual([false, true]);
  });

  it("rehydrates correctly onto a COMPLETELY different clock origin", () => {
    const a = new RollingWindow({ calls: 8, maxAgeMs: 10_000, slowCallMs: 100 });
    a.push(obs(1_000, "transient"));
    a.push(obs(1_100, "success"));
    const snap = a.snapshot(1_200);

    // Process 2's clock starts nowhere near process 1's.
    const b = new RollingWindow({ calls: 8, maxAgeMs: 10_000, slowCallMs: 100 });
    b.hydrate(snap, 9_000_000);
    expect(b.size).toBe(2);
    expect(b.failureRate).toBeCloseTo(0.5);
    // And the samples are genuinely aged, not resurrected as brand new.
    b.evictAgedAt(9_000_000 + 9_900);
    expect(b.size).toBe(1);
  });

  it("ages samples out across the gap a snapshot spent idle", () => {
    const a = new RollingWindow({ calls: 8, maxAgeMs: 5_000, slowCallMs: 100 });
    a.push(obs(1_000, "success"));
    const snap = a.snapshot(1_000);

    const fresh = new RollingWindow({ calls: 8, maxAgeMs: 5_000, slowCallMs: 100 });
    fresh.hydrate(snap, 0, 1_000);
    expect(fresh.size).toBe(1);

    // Sat idle longer than the age bound: the sample must NOT come back.
    const stale = new RollingWindow({ calls: 8, maxAgeMs: 5_000, slowCallMs: 100 });
    stale.hydrate(snap, 0, 60_000);
    expect(stale.size).toBe(0);
  });

  /**
   * The invariant that catches counter drift. The running counters exist so the rates are
   * O(1) instead of O(n); the risk is that eviction forgets to decrement. After ANY
   * sequence of pushes and evictions, the counters must equal a brute-force recount.
   */
  it("property: counters always equal a brute-force recount", () => {
    let seed = 42;
    const rnd = (): number => {
      seed = (seed * 1103515245 + 12345) & 0x7fffffff;
      return seed / 0x7fffffff;
    };

    for (let trial = 0; trial < 200; trial++) {
      const capacity = 1 + Math.floor(rnd() * 12);
      const maxAgeMs = 50 + Math.floor(rnd() * 500);
      const slowCallMs = 100;
      const w = new RollingWindow({ calls: capacity, maxAgeMs, slowCallMs });

      const pushed: Observation[] = [];
      let t = 0;
      const pushes = 5 + Math.floor(rnd() * 60);

      for (let i = 0; i < pushes; i++) {
        t += Math.floor(rnd() * 120);
        const r = rnd();
        const verdict: Verdict = r < 0.3 ? "transient" : r < 0.4 ? "timeout" : "success";
        const latencyMs = rnd() < 0.5 ? 500 : 10;
        const o = obs(t, verdict, latencyMs);
        w.push(o);
        pushed.push(o);
      }

      // Brute force: apply the same two bounds independently.
      const live = pushed.filter((o) => o.at >= t - maxAgeMs).slice(-capacity);
      const expectedFailures = live.filter(
        (o) => o.verdict === "transient" || o.verdict === "timeout",
      ).length;
      const expectedSlow = live.filter((o) => o.latencyMs > slowCallMs).length;

      expect(w.size).toBe(live.length);
      expect(w.failureRate).toBeCloseTo(live.length === 0 ? 0 : expectedFailures / live.length);
      expect(w.slowRate).toBeCloseTo(live.length === 0 ? 0 : expectedSlow / live.length);
    }
  });
});
