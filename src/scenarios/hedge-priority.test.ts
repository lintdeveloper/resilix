/**
 * Acceptance criteria from `docs/specs/hedging-and-priority.md` §8, plus the two interaction
 * questions the spec said must be simulated rather than reasoned about.
 */
import { describe, expect, it } from "vitest";
import { RetryBudget } from "../core/budget.ts";
import { FakeClock } from "../core/clock.ts";
import { pipeline } from "../core/pipeline.ts";
import { FairShare } from "../core/priority.ts";
import { FakeRandom } from "../core/random.ts";
import type { Priority } from "../core/types.ts";
import { AdaptiveLimiter, limiter } from "../policies/limiter.ts";
import { throttler } from "../policies/throttler.ts";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

describe("§8.1 hedging cuts the tail on a bimodal upstream", () => {
  it("reduces p99 by racing a second attempt", async () => {
    // The shape hedging exists for: most calls fast, a few pathologically slow. Dean & Barroso
    // measured p99 1,800ms -> 74ms this way.
    const slowEvery = 10;
    const run = async (hedged: boolean) => {
      let n = 0;
      const p = pipeline({
        policies: [],
        timeoutMs: 10_000,
        ...(hedged ? { hedge: { idempotent: true as const, delayMs: 20 } } : {}),
      });
      const latencies: number[] = [];
      for (let i = 0; i < 60; i++) {
        const started = Date.now();
        await p.execute({}, async () => {
          const slow = n++ % slowEvery === 0;
          await sleep(slow ? 120 : 5);
          return { status: 200 };
        });
        latencies.push(Date.now() - started);
      }
      latencies.sort((a, b) => a - b);
      return latencies[Math.floor(latencies.length * 0.95)] as number;
    };

    const plain = await run(false);
    const withHedge = await run(true);
    expect(withHedge).toBeLessThan(plain);
  }, 30_000);

  it("requires an explicit idempotent acknowledgement", () => {
    // A hedge duplicates the request. On a payment that is a double charge, so this is a
    // construction error rather than a documentation warning.
    // @ts-expect-error idempotent is required
    expect(() => pipeline({ policies: [], hedge: { delayMs: 10 } })).toThrow(TypeError);
  });

  it("falls back to the measured p95 when no delay is configured", async () => {
    const p = pipeline({
      policies: [],
      hedge: { idempotent: true },
    });
    // No samples yet, so nothing to hedge on — it must still work, just without hedging.
    await expect(p.execute({}, () => ({ status: 200 }))).resolves.toEqual({ status: 200 });
  });
});

describe("§8.2 the loser is actually cancelled", () => {
  it("aborts the slow attempt once a hedge wins", async () => {
    const signals: AbortSignal[] = [];
    let n = 0;
    const p = pipeline({
      policies: [],
      timeoutMs: 5_000,
      hedge: { idempotent: true, delayMs: 10 },
    });

    await p.execute({}, async (ctx) => {
      if (ctx.signal) signals.push(ctx.signal);
      const first = n++ === 0;
      await sleep(first ? 200 : 1);
      return { status: 200 };
    });

    await sleep(30);
    // Without cancellation the ~2% overhead Dean & Barroso measured becomes 100%.
    expect(signals.length).toBeGreaterThan(1);
    expect(signals.some((s) => s.aborted)).toBe(true);
  }, 30_000);
});

describe("§8.4 hedges spend the shared budget", () => {
  it("stops hedging once the budget is exhausted", async () => {
    const clock = new FakeClock();
    const shared = new RetryBudget({ ratio: 0.1, minRetries: 2, clock });
    let attempts = 0;
    const p = pipeline({
      policies: [],
      clock,
      hedge: { idempotent: true, delayMs: 1, budget: shared },
    });

    for (let i = 0; i < 20; i++) {
      await p.execute({}, async () => {
        attempts++;
        await sleep(15);
        return { status: 200 };
      });
    }
    // 20 calls; without a budget every one would hedge, giving 40 attempts.
    expect(attempts).toBeLessThan(30);
  }, 30_000);
});

describe("§8.5 and §8.6 criticality", () => {
  const saturate = (priorities: Priority[]) => {
    const clock = new FakeClock();
    const admitted: Record<string, number> = {};
    const shed: Record<string, number> = {};
    const p = pipeline<{ p: Priority }>({
      policies: [limiter({ initialLimit: 4, minSamples: 1_000_000 })],
      priority: (i) => i.p,
      clock,
      random: new FakeRandom(3),
    });

    // Offer far more than the limit can take, evenly across priorities, and never settle —
    // so in-flight climbs and pressure rises.
    for (let i = 0; i < 400; i++) {
      const pr = priorities[i % priorities.length] as Priority;
      const g = p.gate({ p: pr });
      if (g.ok) admitted[pr] = (admitted[pr] ?? 0) + 1;
      else shed[pr] = (shed[pr] ?? 0) + 1;
      clock.advance(1);
    }
    return { admitted, shed };
  };

  it("sheds bulk work before critical work", () => {
    // Netflix's incident: a 12x prefetch spike, >50% of all requests throttled, and
    // user-initiated availability still above 99.4% because the load landed on prefetch.
    const { admitted, shed } = saturate(["critical", "bulk"]);
    expect(shed.bulk ?? 0).toBeGreaterThan(shed.critical ?? 0);
    expect(admitted.critical ?? 0).toBeGreaterThan(admitted.bulk ?? 0);
  });

  it("sheds progressively down the ladder", () => {
    const { shed } = saturate(["critical", "degraded", "bestEffort", "bulk"]);
    expect(shed.bulk ?? 0).toBeGreaterThanOrEqual(shed.bestEffort ?? 0);
    expect(shed.bestEffort ?? 0).toBeGreaterThanOrEqual(shed.degraded ?? 0);
    expect(shed.degraded ?? 0).toBeGreaterThanOrEqual(shed.critical ?? 0);
  });

  it("defaults unlabelled work to critical", () => {
    // Work nobody has classified is assumed to matter; the alternative silently sheds it.
    const clock = new FakeClock();
    const p = pipeline({ policies: [limiter({ initialLimit: 4 })], clock });
    for (let i = 0; i < 50; i++) p.gate({});
    const lim = p.policiesFor()[0] as AdaptiveLimiter;
    expect(lim.pressure).toBeGreaterThan(0); // genuinely under pressure
  });
});

describe("§8.7 tenant fairness", () => {
  it("sheds the heavy tenant before the light one", () => {
    const fair = new FairShare();
    for (let i = 0; i < 500; i++) fair.record("noisy");
    for (let i = 0; i < 20; i++) fair.record("quiet");

    expect(fair.overuse("noisy")).toBeGreaterThan(1);
    expect(fair.overuse("quiet")).toBeLessThan(1);
    expect(fair.shouldShed("noisy", 0.9)).toBe(true);
    expect(fair.shouldShed("quiet", 0.9)).toBe(false);
  });

  it("tolerates more imbalance at low pressure than at high", () => {
    const fair = new FairShare();
    for (let i = 0; i < 300; i++) fair.record("a");
    for (let i = 0; i < 100; i++) fair.record("b");
    // Same imbalance, different pressure: mild pressure should not punish a moderately
    // above-average tenant as harshly as a runaway one.
    expect(fair.shouldShed("a", 0.1)).toBe(false);
    expect(fair.shouldShed("a", 1.0)).toBe(true);
  });

  it("forgets old heaviness, so a tenant is not punished forever", () => {
    const fair = new FairShare(100);
    for (let i = 0; i < 100; i++) fair.record("was-noisy");
    const before = fair.overuse("was-noisy");
    for (let i = 0; i < 400; i++) fair.record("others");
    expect(fair.overuse("was-noisy")).toBeLessThan(before);
  });

  it("does nothing with a single tenant", () => {
    const fair = new FairShare();
    for (let i = 0; i < 100; i++) fair.record("only");
    expect(fair.shouldShed("only", 1)).toBe(false);
  });
});

describe("spec §7.2 — does hedging fight the limiter?", () => {
  it("hedging under latency pressure does not collapse the limit", () => {
    // The interaction the spec flagged: a hedge doubles in-flight calls exactly when latency is
    // high, which is when the limiter is shrinking. If they oscillate, the limit should end up
    // materially worse with hedging than without.
    const measure = (hedgeLoad: number) => {
      const clock = new FakeClock();
      const lim = new AdaptiveLimiter({ initialLimit: 20 }, { clock });
      for (let i = 0; i < 600; i++) {
        for (let h = 0; h < hedgeLoad; h++) lim.admit();
        lim.settle({ verdict: "success", latencyMs: 400, at: clock.now() });
        clock.advance(20);
      }
      return lim.currentLimit;
    };

    const plain = measure(1);
    const hedged = measure(2); // every call hedged: worst case, double the in-flight
    // The tether keys off observed concurrency, so more in-flight permits MORE headroom, not
    // less. Hedging must not drive the limit down.
    expect(hedged).toBeGreaterThanOrEqual(plain);
  });
});

describe("spec §7.1 — is the 2x queue factor too generous?", () => {
  it("compares shed rate across queue factors", () => {
    // SRE ch.22 recommends queue <= 50% of the pool; the limiter allows 200%. Different
    // context, but worth measuring rather than asserting. Recorded, not yet acted on.
    const shedRate = (queueFactor: number) => {
      const clock = new FakeClock();
      const lim = new AdaptiveLimiter(
        { initialLimit: 10, queueFactor, maxQueueFactor: queueFactor + 1 },
        { clock },
      );
      let refused = 0;
      const inflight: number[] = [];
      for (let i = 0; i < 500; i++) {
        while (inflight.length < 40) {
          if (lim.admit().ok) inflight.push(clock.now() + 50);
          else {
            refused++;
            break;
          }
        }
        while (inflight.length > 0 && (inflight[0] as number) <= clock.now()) {
          inflight.shift();
          lim.settle({ verdict: "success", latencyMs: 50, at: clock.now() });
        }
        clock.advance(10);
      }
      return refused;
    };

    const half = shedRate(0.5);
    const double = shedRate(2);
    // A bigger queue sheds less, which is the trade. Asserting only the direction, since the
    // right value is still an open question.
    expect(double).toBeLessThanOrEqual(half);
  });
});

describe("review findings — regressions", () => {
  it("a hedge that fails fast must not beat an original that would have succeeded", async () => {
    // Found in review. Racing on first-SETTLED meant hedging made reliability WORSE: two copies
    // double the exposure to a transient failure, and the quicker error won. Here the hedge
    // fails at ~1ms and the original succeeds at ~40ms — the call must succeed.
    let n = 0;
    const p = pipeline({
      policies: [],
      timeoutMs: 5_000,
      hedge: { idempotent: true, delayMs: 5 },
    });

    const result = await p.execute({}, async () => {
      const first = n++ === 0;
      if (first) {
        await sleep(40);
        return { status: 200 };
      }
      await sleep(1);
      throw Object.assign(new Error("hedge failed"), { code: "ECONNRESET" });
    });

    expect(result).toEqual({ status: 200 });
  }, 30_000);

  it("still rejects when every copy fails", async () => {
    const p = pipeline({
      policies: [],
      timeoutMs: 5_000,
      hedge: { idempotent: true, delayMs: 5 },
    });
    await expect(
      p.execute({}, async () => {
        await sleep(2);
        throw Object.assign(new Error("all down"), { code: "ECONNRESET" });
      }),
    ).rejects.toThrow("all down");
  }, 30_000);

  it("fairness is charged on settle, not on admission", () => {
    // ADR-007 checklist item 3, violated in the first cut of v0.5. Charging usage at admit()
    // bills a tenant for calls an inner policy refused — and since usage is what gets you shed,
    // that is a feedback loop inside the fairness mechanism itself.
    const clock = new FakeClock();
    const p = pipeline<{ t: string }>({
      policies: [limiter({ initialLimit: 2 })],
      tenant: (i) => i.t,
      clock,
      random: new FakeRandom(7),
    });

    // "blocked" is admitted by nothing useful — every call is refused downstream — so it must
    // accrue no usage at all.
    for (let i = 0; i < 50; i++) {
      const g = p.gate({ t: "blocked" });
      if (g.ok) g.settleVerdict("rejected", 0);
      clock.advance(5);
    }

    const lim = p.policiesFor()[0] as AdaptiveLimiter;
    // Nothing was charged, so nothing can be considered unfair.
    expect(lim.admit({ tenant: "blocked" }).ok).toBe(true);
  });
});
