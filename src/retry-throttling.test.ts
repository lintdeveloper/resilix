/**
 * The acceptance criteria from `docs/specs/retry-and-throttling.md` §10.
 *
 * Deterministic throughout: injected clock AND injected random, so every jitter draw and every
 * shed decision is reproducible.
 */
import { describe, expect, it, vi } from "vitest";
import { Backoff } from "./backoff.ts";
import { breaker } from "./breaker.ts";
import { RetryBudget } from "./budget.ts";
import { bulkhead } from "./bulkhead.ts";
import { FakeClock } from "./clock.ts";
import { limiter } from "./limiter.ts";
import { RejectedError, pipeline } from "./pipeline.ts";
import { FakeRandom, constantRandom } from "./random.ts";
import { RateLimiter, rateLimit } from "./rate-limit.ts";
import { AdaptiveThrottler, throttler } from "./throttler.ts";

const transient = () => Object.assign(new Error("down"), { code: "ECONNRESET" });

describe("§10.1 jitter", () => {
  it("full jitter draws uniformly from [0, exponential)", () => {
    // AWS: sleep = random(0, min(cap, base * 2^attempt))
    const at = (r: number, attempt: number) =>
      new Backoff({ baseMs: 100, jitter: "full" }, constantRandom(r)).delayFor(attempt);
    expect(at(0, 1)).toBe(0);
    expect(at(0.5, 1)).toBe(50); // half of 100
    expect(at(0.5, 3)).toBe(200); // half of 100*2^2
  });

  it("no jitter is the pure exponential", () => {
    const b = new Backoff({ baseMs: 100, jitter: "none" }, constantRandom(0.5));
    expect([1, 2, 3, 4].map((n) => b.delayFor(n))).toEqual([100, 200, 400, 800]);
  });

  it("equal jitter keeps half the delay fixed", () => {
    // sleep = exp/2 + random(0, exp/2) — so it can never be below half.
    const b = new Backoff({ baseMs: 100, jitter: "equal" }, constantRandom(0));
    expect(b.delayFor(3)).toBe(200); // exactly half of 400
  });

  it("decorrelated grows from the PREVIOUS delay, not the attempt number", () => {
    const b = new Backoff({ baseMs: 100, jitter: "decorrelated" }, constantRandom(1));
    const first = b.delayFor(1);
    const second = b.delayFor(2);
    expect(second).toBeGreaterThan(first);
  });

  it("every strategy respects maxDelayMs", () => {
    for (const jitter of ["none", "full", "equal", "decorrelated"] as const) {
      const b = new Backoff({ baseMs: 1_000, maxDelayMs: 5_000, jitter }, new FakeRandom(7));
      for (let n = 1; n <= 12; n++) expect(b.delayFor(n)).toBeLessThanOrEqual(5_000);
    }
  });

  it("full jitter actually decorrelates — which is the entire point", () => {
    // A fleet of clients must not retry in unison. Deterministic backoff gives one value;
    // jitter must spread them across the window.
    const delays = new Set<number>();
    const r = new FakeRandom(42);
    for (let client = 0; client < 100; client++) {
      delays.add(Math.round(new Backoff({ baseMs: 1_000, jitter: "full" }, r).delayFor(3)));
    }
    expect(delays.size).toBeGreaterThan(80);
  });
});

describe("§10.2 the SRE amplification numbers", () => {
  /** Count attempts reaching the upstream when every call fails. */
  const amplification = async (withBudget: boolean) => {
    const clock = new FakeClock();
    const shared = new RetryBudget({ ratio: 0.1, minRetries: 0, clock });
    let attempts = 0;
    const p = pipeline({
      clock,
      random: new FakeRandom(1),
      policies: [breaker({ slowCallMs: 1_000, consecutiveBackstop: 0, failureRate: 1.1 })],
      retry: {
        maxAttempts: 3,
        baseMs: 0,
        ...(withBudget ? { budget: shared } : {}),
      },
    });

    const requests = 200;
    for (let i = 0; i < requests; i++) {
      await p
        .execute({}, () => {
          attempts++;
          throw transient();
        })
        .catch(() => undefined);
      clock.advance(10);
    }
    return attempts / requests;
  };

  it("unbudgeted retries amplify roughly 3x", async () => {
    const factor = await amplification(false);
    expect(factor).toBeGreaterThan(2.8);
    expect(factor).toBeLessThanOrEqual(3);
  });

  it("a 10% budget holds amplification near 1.1x", async () => {
    // Google SRE's headline number, and the reason the budget exists at all.
    const factor = await amplification(true);
    expect(factor).toBeLessThan(1.3);
    expect(factor).toBeGreaterThan(1.0);
  });
});

describe("§10.3 throttler holds its analytic rejection rate", () => {
  const analytic = (requests: number, accepts: number, k = 2) =>
    Math.max(0, (requests - k * accepts) / (requests + 1));

  it("matches max(0, (requests − K·accepts)/(requests + 1))", () => {
    const clock = new FakeClock();
    const t = new AdaptiveThrottler({ k: 2, minRequests: 0 }, { clock, random: constantRandom(1) });

    // 100 attempts, 20 accepted.
    for (let i = 0; i < 100; i++) {
      t.admit();
      if (i < 20) t.settle({ verdict: "success", latencyMs: 1, at: clock.now() });
      else t.settle({ verdict: "transient", latencyMs: 1, at: clock.now() });
    }
    const expected = analytic(100, 20);
    expect(Math.abs(t.rejectionRate - expected)).toBeLessThan(0.05);
  });

  it("does not throttle while the upstream is accepting everything", () => {
    const clock = new FakeClock();
    const t = new AdaptiveThrottler({ minRequests: 0 }, { clock, random: constantRandom(0) });
    for (let i = 0; i < 100; i++) {
      t.admit();
      t.settle({ verdict: "success", latencyMs: 1, at: clock.now() });
    }
    expect(t.rejectionRate).toBe(0);
  });

  it("caps below 1.0 so it can still observe recovery", () => {
    // At 1.0 it would send nothing, learn nothing, and never reopen — the trap half-open
    // probes exist to avoid in a breaker.
    const clock = new FakeClock();
    const t = new AdaptiveThrottler(
      { minRequests: 0, maxRejectionRate: 0.9 },
      { clock, random: constantRandom(0.99) },
    );
    for (let i = 0; i < 500; i++) {
      t.admit();
      t.settle({ verdict: "transient", latencyMs: 1, at: clock.now() });
    }
    expect(t.rejectionRate).toBeLessThanOrEqual(0.9);
    expect(t.admit().ok).toBe(true); // 0.99 > 0.9, so this one gets through
  });

  it("counts a 4xx as an accept — the upstream did the work", () => {
    const clock = new FakeClock();
    const t = new AdaptiveThrottler({ minRequests: 0 }, { clock, random: constantRandom(0) });
    for (let i = 0; i < 100; i++) {
      t.admit();
      t.settle({ verdict: "answered", latencyMs: 1, at: clock.now() });
    }
    expect(t.rejectionRate).toBe(0);
  });

  it("stays quiet below minRequests", () => {
    const clock = new FakeClock();
    const t = new AdaptiveThrottler({ minRequests: 10 }, { clock, random: constantRandom(0) });
    for (let i = 0; i < 5; i++) {
      t.admit();
      t.settle({ verdict: "transient", latencyMs: 1, at: clock.now() });
    }
    expect(t.rejectionRate).toBe(0);
  });
});

describe("§10.4 one budget caps retries across pipelines", () => {
  it("is shared, because a per-policy cap cannot bound system-wide amplification", async () => {
    const clock = new FakeClock();
    const shared = new RetryBudget({ ratio: 0.1, minRetries: 1, clock });
    const build = () =>
      pipeline({
        clock,
        random: new FakeRandom(2),
        policies: [breaker({ slowCallMs: 1_000, consecutiveBackstop: 0, failureRate: 1.1 })],
        retry: { maxAttempts: 3, baseMs: 0, budget: shared },
      });
    const a = build();
    const b = build();
    const c = build();

    let attempts = 0;
    for (let i = 0; i < 30; i++) {
      for (const p of [a, b, c]) {
        await p
          .execute({}, () => {
            attempts++;
            throw transient();
          })
          .catch(() => undefined);
      }
      clock.advance(10);
    }

    const requests = 90;
    expect(shared.metrics().requests).toBe(requests);
    // Without sharing, each pipeline would get its own 10% and total amplification would be
    // three times higher.
    expect(attempts / requests).toBeLessThan(1.3);
  });
});

describe("§10.5 what may not be retried", () => {
  const attemptsFor = async (thrown: unknown) => {
    const clock = new FakeClock();
    let attempts = 0;
    const p = pipeline({
      clock,
      random: new FakeRandom(3),
      policies: [breaker({ slowCallMs: 1_000, consecutiveBackstop: 0, failureRate: 1.1 })],
      retry: { maxAttempts: 3, baseMs: 0 },
    });
    await p
      .execute({}, () => {
        attempts++;
        throw thrown;
      })
      .catch(() => undefined);
    return attempts;
  };

  it("never retries `answered` — the upstream worked, the caller was wrong", async () => {
    expect(await attemptsFor({ status: 404 })).toBe(1);
    expect(await attemptsFor({ status: 422 })).toBe(1);
  });

  it("retries `transient`", async () => {
    expect(await attemptsFor(transient())).toBe(3);
  });

  it("retries `overload`", async () => {
    expect(await attemptsFor({ status: 429 })).toBe(3);
  });

  it("never retries our own rejection", async () => {
    const clock = new FakeClock();
    let attempts = 0;
    const p = pipeline({
      clock,
      random: new FakeRandom(4),
      policies: [breaker({ slowCallMs: 1_000, consecutiveBackstop: 1 })],
      retry: { maxAttempts: 5, baseMs: 0 },
    });
    // Trip it first.
    await p
      .execute({}, () => {
        throw transient();
      })
      .catch(() => undefined);
    const error = await p
      .execute({}, () => {
        attempts++;
        return { status: 200 };
      })
      .catch((e: unknown) => e);

    expect(attempts).toBe(0);
    expect(error).toBeInstanceOf(RejectedError);
  });
});

describe("§10.6 a retry's delay counts against the deadline", () => {
  it("stops retrying once the backoff would outlive timeoutMs", async () => {
    // timeoutMs bounds the WHOLE sequence, not each attempt. Most libraries bound each attempt,
    // so a caller asking for 50ms can wait maxAttempts x (50ms + backoff) — a deadline the
    // caller cannot see is not a deadline.
    let attempts = 0;
    const p = pipeline({
      policies: [breaker({ slowCallMs: 50, consecutiveBackstop: 0, failureRate: 1.1 })],
      random: constantRandom(1),
      timeoutMs: 50,
      retry: { maxAttempts: 5, baseMs: 400, jitter: "none" },
    });

    const started = Date.now();
    await p
      .execute({}, () => {
        attempts++;
        throw transient();
      })
      .catch(() => undefined);
    const elapsed = Date.now() - started;

    // A 400ms backoff cannot fit inside a 50ms deadline, so there is exactly one attempt and
    // no sleeping at all.
    expect(attempts).toBe(1);
    expect(elapsed).toBeLessThan(200);
  });

  it("still retries when the backoff fits comfortably inside the deadline", async () => {
    let attempts = 0;
    const p = pipeline({
      policies: [breaker({ slowCallMs: 50, consecutiveBackstop: 0, failureRate: 1.1 })],
      random: constantRandom(1),
      timeoutMs: 5_000,
      retry: { maxAttempts: 3, baseMs: 1, jitter: "none" },
    });
    await p
      .execute({}, () => {
        attempts++;
        throw transient();
      })
      .catch(() => undefined);
    expect(attempts).toBe(3);
  });
});

describe("§10.7 shed requests stay out of the latency histogram", () => {
  it("refusals reach onRejection and never onExecution", async () => {
    // AWS: "the latency of load shedding a request should be extremely low compared with other
    // requests" — so a shed request must not pollute the duration metric at all.
    const clock = new FakeClock();
    const onExecution = vi.fn();
    const onRejection = vi.fn();
    const p = pipeline({
      clock,
      policies: [breaker({ slowCallMs: 100, consecutiveBackstop: 1 })],
      observers: [{ onExecution, onRejection }],
    });

    await p
      .execute({}, () => {
        throw transient();
      })
      .catch(() => undefined);
    onExecution.mockClear();
    await p.execute({}, () => ({ status: 200 })).catch(() => undefined);

    expect(onRejection).toHaveBeenCalled();
    expect(onExecution).not.toHaveBeenCalled();
  });
});

describe("§10.8 every refusal is distinguishable", () => {
  it("reports a distinct reason per mechanism", async () => {
    const clock = new FakeClock();
    const seen = new Set<string>();
    const observers = [{ onRejection: (e: { reason: string }) => seen.add(e.reason) }];

    const open = pipeline({
      clock,
      policies: [breaker({ slowCallMs: 100, consecutiveBackstop: 1 })],
      observers,
    });
    await open
      .execute({}, () => {
        throw transient();
      })
      .catch(() => undefined);
    await open.execute({}, () => 1).catch(() => undefined);

    const limited = pipeline({
      clock,
      policies: [rateLimit({ limit: 1, intervalMs: 60_000, burst: 1 })],
      observers,
    });
    await limited.execute({}, () => 1).catch(() => undefined);
    await limited.execute({}, () => 1).catch(() => undefined);

    expect(seen.has("circuit-open")).toBe(true);
    expect(seen.has("rate-limited")).toBe(true);
  });
});

describe("rate limiter", () => {
  it("refills continuously, so a boundary cannot yield 2x the limit", () => {
    // The classic fixed-window bug: 10 at the end of one window plus 10 at the start of the
    // next is 20 in an instant. A token bucket cannot do that.
    const clock = new FakeClock();
    const r = new RateLimiter({ limit: 10, intervalMs: 1_000, burst: 10 }, { clock });
    for (let i = 0; i < 10; i++) expect(r.admit().ok).toBe(true);
    expect(r.admit().ok).toBe(false);

    clock.advance(500);
    let granted = 0;
    for (let i = 0; i < 10; i++) if (r.admit().ok) granted++;
    expect(granted).toBe(5); // half an interval buys exactly half the limit
  });

  it("tells the caller how long to wait", () => {
    const clock = new FakeClock();
    const r = new RateLimiter({ limit: 1, intervalMs: 1_000, burst: 1 }, { clock });
    r.admit();
    const refused = r.admit();
    expect(refused.ok).toBe(false);
    if (!refused.ok) expect(refused.retryAfterMs).toBeGreaterThan(0);
  });

  it("validates its options", () => {
    expect(() => new RateLimiter({ limit: 0 })).toThrow(RangeError);
    expect(() => new RateLimiter({ limit: 5, intervalMs: 0 })).toThrow(RangeError);
  });
});

describe("FakeRandom", () => {
  it("is reproducible for a given seed", () => {
    const a = new FakeRandom(99);
    const b = new FakeRandom(99);
    expect(Array.from({ length: 20 }, () => a.next())).toEqual(
      Array.from({ length: 20 }, () => b.next()),
    );
  });

  it("stays within [0, 1) and does not degenerate", () => {
    const r = new FakeRandom(0); // a zero seed is a fixed point for xorshift if unguarded
    const values = Array.from({ length: 2_000 }, () => r.next());
    for (const v of values) {
      expect(v).toBeGreaterThanOrEqual(0);
      expect(v).toBeLessThan(1);
    }
    expect(new Set(values).size).toBeGreaterThan(1_500);
  });
});

describe("§9.4 does the throttler double-count with other shedding?", () => {
  /** Offered load far above `cap`, against an upstream that answers 200 to everything. */
  const healthyBehindACap = (cap: number, offered: number) => {
    const clock = new FakeClock();
    const p = pipeline({
      policies: [throttler({ minRequests: 10 }), bulkhead({ concurrency: cap })],
      clock,
      random: new FakeRandom(11),
    });
    const inflight: Array<{ doneAt: number; settle: () => void }> = [];
    let throttled = 0;
    for (let i = 0; i < 2_000; i++) {
      for (let j = inflight.length - 1; j >= 0; j--) {
        const c = inflight[j] as { doneAt: number; settle: () => void };
        if (c.doneAt <= clock.now()) {
          inflight.splice(j, 1);
          c.settle();
        }
      }
      for (let k = 0; k < offered; k++) {
        const g = p.gate({});
        if (!g.ok) {
          if (g.reason === "throttled") throttled++;
          continue;
        }
        inflight.push({ doneAt: clock.now() + 50, settle: () => g.settleVerdict("success", 50) });
      }
      clock.advance(10);
    }
    const t = p.policiesFor().find((x) => x.name === "throttler") as AdaptiveThrottler;
    return { throttled, rate: t.rejectionRate };
  };

  it("inner shedding must NOT be read as upstream distress", () => {
    // The bug this caught: counting a request at admit() meant every call an inner policy
    // refused looked like a request the upstream had not accepted. Against a bulkhead of 5 and
    // 20 offered per tick — with an upstream answering 200 to everything it actually received —
    // the throttler pinned itself at its 0.9 ceiling and shed 54,103 calls.
    for (const [cap, offered] of [
      [100, 2],
      [20, 10],
      [5, 20],
    ] as const) {
      const { throttled, rate } = healthyBehindACap(cap, offered);
      expect(rate).toBe(0);
      expect(throttled).toBe(0);
    }
  });

  it("still throttles when the UPSTREAM is the one failing", () => {
    // The other half: the fix must not make the throttler inert.
    const clock = new FakeClock();
    const p = pipeline({
      policies: [throttler({ minRequests: 10 })],
      clock,
      random: new FakeRandom(11),
    });
    let throttled = 0;
    for (let i = 0; i < 500; i++) {
      const g = p.gate({});
      if (!g.ok) {
        throttled++;
      } else {
        g.settleVerdict("transient", 20);
      }
      clock.advance(20);
    }
    expect(throttled).toBeGreaterThan(100);
  });

  it("throttler and limiter do not compound — the outermost decides", () => {
    // They shed on different signals (accept-ratio vs latency), and the pipeline
    // short-circuits at the first refusal, so shed rates do not add.
    const build = (policies: ReturnType<typeof throttler>[]) => {
      const clock = new FakeClock();
      const p = pipeline({ policies, clock, random: new FakeRandom(11) });
      let refused = 0;
      for (let i = 0; i < 1_000; i++) {
        const g = p.gate({});
        if (g.ok) g.settleVerdict("transient", 3_000);
        else refused++;
        clock.advance(20);
      }
      return refused / 1_000;
    };

    const throttlerOnly = build([throttler({ minRequests: 10 })]);
    const both = build([throttler({ minRequests: 10 }), limiter({ initialLimit: 20 })]);

    // Both-together must not exceed throttler-alone by any meaningful margin.
    expect(both).toBeLessThanOrEqual(throttlerOnly + 0.05);
  });
});
