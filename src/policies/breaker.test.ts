import { beforeEach, describe, expect, it, vi } from "vitest";
import { FakeClock } from "../core/clock.ts";
import type { Verdict } from "../core/types.ts";
import { CircuitBreaker } from "./breaker.ts";
import type { BreakerOptions, StateChangeEvent } from "./breaker.ts";

const build = (options: Partial<BreakerOptions> = {}, clock = new FakeClock()) => {
  const events: StateChangeEvent[] = [];
  const b = new CircuitBreaker(
    {
      slowCallMs: 1000,
      window: { calls: 100, maxAgeMs: 300_000, minCalls: 20 },
      ...options,
      onStateChange: (e) => events.push(e),
    },
    { key: "test", clock },
  );
  return { b, clock, events };
};

/** Admit then settle, the way the executor does. Returns false if admission was refused. */
const call = (
  b: CircuitBreaker,
  clock: FakeClock,
  verdict: Verdict,
  latencyMs = 10,
  advanceMs = 1,
): boolean => {
  const admission = b.admit();
  if (!admission.ok) return false;
  clock.advance(advanceMs);
  b.settle({ verdict, latencyMs, at: clock.now() });
  return true;
};

describe("CircuitBreaker construction", () => {
  it("REQUIRES slowCallMs — a wrong default is worse than a required argument", () => {
    expect(() => new CircuitBreaker({ slowCallMs: 0 })).toThrow(/slowCallMs/);
    // @ts-expect-error deliberately omitted
    expect(() => new CircuitBreaker({})).toThrow(/slowCallMs/);
  });

  it("starts closed and admits", () => {
    const { b } = build();
    expect(b.currentState).toBe("closed");
    expect(b.admit().ok).toBe(true);
  });
});

describe("trip condition 1 — consecutive backstop", () => {
  it("opens a DEAD low-traffic upstream that the rate model can never see", () => {
    // 8 req/min against a 5-minute window with minCalls 20: the rate conditions can
    // never fire, because the window never reaches 20 samples inside the age bound.
    // Without the backstop this upstream NEVER trips and every caller eats the timeout.
    const { b, clock } = build({ consecutiveBackstop: 10 });
    for (let i = 0; i < 9; i++) {
      expect(call(b, clock, "transient", 10, 7_500)).toBe(true);
      expect(b.currentState).toBe("closed");
    }
    call(b, clock, "transient", 10, 7_500);
    expect(b.currentState).toBe("open");
  });

  it("resets the consecutive count on any healthy verdict", () => {
    const { b, clock } = build({ consecutiveBackstop: 5 });
    for (let i = 0; i < 4; i++) call(b, clock, "transient");
    call(b, clock, "success");
    for (let i = 0; i < 4; i++) call(b, clock, "transient");
    expect(b.currentState).toBe("closed");
  });

  it("can be disabled with 0", () => {
    const { b, clock } = build({ consecutiveBackstop: 0, window: { minCalls: 1000 } });
    for (let i = 0; i < 50; i++) call(b, clock, "transient");
    expect(b.currentState).toBe("closed");
  });
});

describe("trip condition 2 — failure rate", () => {
  it("does not evaluate the rate below minCalls", () => {
    const { b, clock } = build({ consecutiveBackstop: 0, window: { minCalls: 20 } });
    // alternate so the backstop cannot fire either way
    for (let i = 0; i < 19; i++) call(b, clock, i % 2 === 0 ? "transient" : "success");
    expect(b.currentState).toBe("closed");
  });

  it("opens above the threshold once minCalls is met", () => {
    const { b, clock, events } = build({
      failureRate: 0.5,
      consecutiveBackstop: 0,
      window: { minCalls: 10, calls: 100, maxAgeMs: 300_000 },
    });
    for (let i = 0; i < 10; i++) call(b, clock, i < 6 ? "transient" : "success");
    expect(b.currentState).toBe("open");
    expect(events.at(-1)?.reason).toBe("failure-rate");
    expect(events.at(-1)?.failureRate).toBeGreaterThan(0.5);
  });
});

describe("trip condition 3 — slow-call rate (the one no JS library has)", () => {
  it("opens on latency alone, with a ZERO error rate", () => {
    // The production case: p50 0.35s -> 10.4s, ~25-30x slower, no extra errors at all.
    // A failure-rate breaker sees nothing here.
    const { b, clock, events } = build({
      slowCallMs: 3_000,
      slowCallRate: 0.5,
      consecutiveBackstop: 0,
      window: { minCalls: 20, calls: 100, maxAgeMs: 300_000 },
    });

    for (let i = 0; i < 20; i++) call(b, clock, "success", 10_400);

    expect(b.currentState).toBe("open");
    expect(events.at(-1)?.reason).toBe("slow-rate");
    expect(events.at(-1)?.failureRate).toBe(0);
    expect(events.at(-1)?.slowRate).toBe(1);
  });

  it("stays closed when calls are fast", () => {
    const { b, clock } = build({ slowCallMs: 3_000, consecutiveBackstop: 0 });
    for (let i = 0; i < 60; i++) call(b, clock, "success", 350);
    expect(b.currentState).toBe("closed");
  });

  it("counts a slow 4xx as slow but not as a failure", () => {
    const { b, clock, events } = build({
      slowCallMs: 1_000,
      slowCallRate: 0.5,
      consecutiveBackstop: 0,
      window: { minCalls: 20, calls: 100, maxAgeMs: 300_000 },
    });
    for (let i = 0; i < 20; i++) call(b, clock, "answered", 5_000);
    expect(events.at(-1)?.reason).toBe("slow-rate");
    expect(events.at(-1)?.failureRate).toBe(0);
  });
});

describe("verdicts that must NEVER open the circuit", () => {
  it("stays closed at a sustained 4xx rate — this is normal, not an outage", () => {
    // A validating upstream returns a meaningful share of 4xx on a perfectly healthy day
    // (13-18% in the case behind this library). A breaker keyed on "the promise rejected"
    // trips because customers submitted bad input.
    const { b, clock } = build({ failureRate: 0.5, consecutiveBackstop: 10 });
    for (let i = 0; i < 500; i++) call(b, clock, i % 5 === 0 ? "answered" : "success");
    expect(b.currentState).toBe("closed");
  });

  it("stays closed under sustained 429s — a load signal, not a failure", () => {
    const { b, clock } = build({ failureRate: 0.5, consecutiveBackstop: 10 });
    for (let i = 0; i < 200; i++) call(b, clock, "overload");
    expect(b.currentState).toBe("closed");
  });

  it("stays closed even at a 100% 4xx rate", () => {
    const { b, clock } = build({ failureRate: 0.5, consecutiveBackstop: 10 });
    for (let i = 0; i < 200; i++) call(b, clock, "answered");
    expect(b.currentState).toBe("closed");
  });

  it("ignores `rejected` so an open breaker cannot feed on its own shedding", () => {
    const { b, clock } = build({ consecutiveBackstop: 5 });
    for (let i = 0; i < 100; i++) {
      b.settle({ verdict: "rejected", latencyMs: 0, at: clock.now() });
    }
    expect(b.currentState).toBe("closed");
  });
});

describe("open -> half-open -> closed", () => {
  const openIt = () => {
    const ctx = build({ consecutiveBackstop: 3, openForMs: 15_000 });
    for (let i = 0; i < 3; i++) call(ctx.b, ctx.clock, "transient");
    expect(ctx.b.currentState).toBe("open");
    return ctx;
  };

  it("refuses while open and reports retryAfterMs", () => {
    const { b, clock } = openIt();
    const decision = b.admit();
    expect(decision.ok).toBe(false);
    if (!decision.ok) {
      expect(decision.reason).toBe("circuit-open");
      expect(decision.retryAfterMs).toBeGreaterThan(0);
      expect(decision.retryAfterMs).toBeLessThanOrEqual(15_000);
    }
    clock.advance(14_999);
    expect(b.admit().ok).toBe(false);
  });

  it("admits a probe once openForMs elapses", () => {
    const { b, clock } = openIt();
    clock.advance(15_001);
    expect(b.admit().ok).toBe(true);
    expect(b.currentState).toBe("half-open");
  });

  it("admits EXACTLY ONE probe out of 50 concurrent attempts", () => {
    // Without this gate, half-open stampedes an upstream that is by definition fragile.
    // opossum #819 is this discussion, open since 2023.
    const { b, clock } = openIt();
    clock.advance(15_001);

    let admitted = 0;
    for (let i = 0; i < 50; i++) if (b.admit().ok) admitted++;
    expect(admitted).toBe(1);
  });

  it("closes only after successesToClose consecutive healthy probes", () => {
    const { b, clock } = build({ consecutiveBackstop: 2, openForMs: 1_000 });
    call(b, clock, "transient");
    call(b, clock, "transient");
    expect(b.currentState).toBe("open");

    clock.advance(1_001);
    for (let i = 0; i < 2; i++) {
      expect(b.admit().ok).toBe(true);
      b.settle({ verdict: "success", latencyMs: 5, at: clock.advance(1) });
      expect(b.currentState).toBe("half-open");
    }
    expect(b.admit().ok).toBe(true);
    b.settle({ verdict: "success", latencyMs: 5, at: clock.advance(1) });
    expect(b.currentState).toBe("closed");
  });

  it("re-opens immediately when a probe fails", () => {
    const { b, clock, events } = build({ consecutiveBackstop: 2, openForMs: 1_000 });
    call(b, clock, "transient");
    call(b, clock, "transient");
    clock.advance(1_001);
    expect(b.admit().ok).toBe(true);
    b.settle({ verdict: "transient", latencyMs: 5, at: clock.advance(1) });
    expect(b.currentState).toBe("open");
    expect(events.at(-1)?.reason).toBe("probe-failed");
  });

  it("self-heals if a probe is admitted and never settles", () => {
    const { b, clock } = build({ consecutiveBackstop: 2, openForMs: 1_000 });
    call(b, clock, "transient");
    call(b, clock, "transient");
    clock.advance(1_001);
    expect(b.admit().ok).toBe(true); // probe admitted, caller vanishes
    expect(b.admit().ok).toBe(false);
    clock.advance(1_001); // older than openForMs
    expect(b.admit().ok).toBe(true); // a fresh probe is allowed rather than wedging
  });

  it("releases the probe slot on `rejected` from an inner policy", () => {
    const { b, clock } = build({ consecutiveBackstop: 2, openForMs: 1_000 });
    call(b, clock, "transient");
    call(b, clock, "transient");
    clock.advance(1_001);
    expect(b.admit().ok).toBe(true);
    b.settle({ verdict: "rejected", latencyMs: 0, at: clock.now() });
    expect(b.currentState).toBe("half-open");
    expect(b.admit().ok).toBe(true); // slot was released, not leaked
  });

  it("applies openBackoff on repeated re-opens", () => {
    const { b, clock } = build({ consecutiveBackstop: 1, openForMs: 1_000, openBackoff: 2 });
    call(b, clock, "transient");
    expect(b.admit().ok).toBe(false); // open for 1_000

    clock.advance(1_001);
    expect(b.admit().ok).toBe(true);
    b.settle({ verdict: "transient", latencyMs: 1, at: clock.advance(1) }); // 2nd open -> 2_000

    clock.advance(1_500);
    expect(b.admit().ok).toBe(false);
    clock.advance(600);
    expect(b.admit().ok).toBe(true);
  });

  it("caps the backed-off duration at maxOpenForMs", () => {
    const { b, clock } = build({
      consecutiveBackstop: 1,
      openForMs: 1_000,
      openBackoff: 10,
      maxOpenForMs: 3_000,
    });
    call(b, clock, "transient");
    for (let i = 0; i < 4; i++) {
      clock.advance(3_001);
      expect(b.admit().ok).toBe(true);
      b.settle({ verdict: "transient", latencyMs: 1, at: clock.advance(1) });
    }
    clock.advance(3_001);
    expect(b.admit().ok).toBe(true);
  });
});

describe("state change events", () => {
  it("emits from/to with the trip reason and the rates it tripped on", () => {
    const { b, clock, events } = build({
      consecutiveBackstop: 0,
      failureRate: 0.5,
      window: { minCalls: 4, calls: 100, maxAgeMs: 300_000 },
    });
    for (let i = 0; i < 4; i++) call(b, clock, "transient");
    const open = events.at(-1);
    expect(open?.from).toBe("closed");
    expect(open?.to).toBe("open");
    expect(open?.reason).toBe("failure-rate");
    expect(open?.key).toBe("test");
    expect(open?.windowSize).toBe(4);
    expect(open?.openForMs).toBe(15_000);
  });

  it("does not emit for a no-op transition", () => {
    const onStateChange = vi.fn();
    const clock = new FakeClock();
    const b = new CircuitBreaker({ slowCallMs: 100, onStateChange }, { clock });
    for (let i = 0; i < 5; i++) call(b, clock, "success");
    expect(onStateChange).not.toHaveBeenCalled();
  });
});

describe("snapshot / hydrate", () => {
  let clock: FakeClock;
  beforeEach(() => {
    clock = new FakeClock(1_000);
  });

  it("carries the state and the window across a round trip", () => {
    const a = new CircuitBreaker({ slowCallMs: 100, consecutiveBackstop: 0 }, { clock });
    for (let i = 0; i < 30; i++) {
      a.admit();
      a.settle({
        verdict: i % 4 === 0 ? "transient" : "success",
        latencyMs: 50,
        at: clock.advance(1),
      });
    }
    const b = new CircuitBreaker({ slowCallMs: 100, consecutiveBackstop: 0 }, { clock });
    b.hydrate(a.snapshot());

    expect(b.currentState).toBe(a.currentState);
    expect(b.stats().windowSize).toBe(a.stats().windowSize);
    expect(b.stats().failureRate).toBeCloseTo(a.stats().failureRate);
  });

  it("carries an OPEN state, including when it may next probe", () => {
    const a = new CircuitBreaker({ slowCallMs: 100, consecutiveBackstop: 1 }, { clock });
    a.admit();
    a.settle({ verdict: "transient", latencyMs: 1, at: clock.now() });
    expect(a.currentState).toBe("open");

    const b = new CircuitBreaker({ slowCallMs: 100, consecutiveBackstop: 1 }, { clock });
    b.hydrate(a.snapshot());
    expect(b.currentState).toBe("open");
    expect(b.admit().ok).toBe(false);
    clock.advance(15_001);
    expect(b.admit().ok).toBe(true);
  });
});

describe("stats", () => {
  it("drops aged samples when read between pushes", () => {
    const clock = new FakeClock();
    const b = new CircuitBreaker(
      { slowCallMs: 100, window: { calls: 100, maxAgeMs: 1_000, minCalls: 20 } },
      { clock },
    );
    for (let i = 0; i < 10; i++) {
      b.admit();
      b.settle({ verdict: "success", latencyMs: 10, at: clock.advance(10) });
    }
    expect(b.stats().windowSize).toBe(10);
    clock.advance(5_000);
    expect(b.stats().windowSize).toBe(0);
  });
});

describe("snapshot portability across processes (ADR-005)", () => {
  const openBreaker = (clock: FakeClock) => {
    const b = new CircuitBreaker(
      { slowCallMs: 100, consecutiveBackstop: 1, openForMs: 30_000 },
      { clock },
    );
    b.admit();
    b.settle({ verdict: "transient", latencyMs: 1, at: clock.now() });
    expect(b.currentState).toBe("open");
    return b;
  };

  it("stores every time value as a RELATIVE offset, never an absolute reading", () => {
    const clock = new FakeClock(5_000);
    const b = openBreaker(clock);
    const snap = b.snapshot();

    // nextAttemptInMs is a duration, not a timestamp: it must not resemble clock.now().
    expect(snap.nextAttemptInMs).toBe(30_000);
    expect(snap.wallClockAt).toBe(clock.wallNow());
    expect(Object.keys(snap)).not.toContain("nextAttemptAt");
  });

  it("survives a clock with a COMPLETELY different origin", () => {
    // This is the real bug: performance.now() counts from process start, so process 2's
    // now() bears no relation to process 1's. A naive absolute snapshot would rehydrate
    // with an open-until time already in the past, or absurdly far in the future.
    const p1 = new FakeClock(1_000, 1_700_000_000_000);
    const snap = openBreaker(p1).snapshot();

    const p2 = new FakeClock(9_999_999, 1_700_000_000_000);
    const restored = new CircuitBreaker(
      { slowCallMs: 100, consecutiveBackstop: 1, openForMs: 30_000 },
      { clock: p2 },
    );
    restored.hydrate(snap);

    expect(restored.currentState).toBe("open");
    expect(restored.admit().ok).toBe(false);
    p2.advance(29_999);
    expect(restored.admit().ok).toBe(false);
    p2.advance(2);
    expect(restored.admit().ok).toBe(true);
  });

  it("accounts for the time a snapshot sat idle between processes", () => {
    const p1 = new FakeClock(0, 1_700_000_000_000);
    const snap = openBreaker(p1).snapshot(); // open for 30s from here

    // The snapshot sat for 20 seconds of wall time before being restored.
    const p2 = new FakeClock(500_000, 1_700_000_000_000 + 20_000);
    const restored = new CircuitBreaker(
      { slowCallMs: 100, consecutiveBackstop: 1, openForMs: 30_000 },
      { clock: p2 },
    );
    restored.hydrate(snap);

    // Only 10s of the open period should remain, not the full 30s.
    expect(restored.admit().ok).toBe(false);
    p2.advance(9_999);
    expect(restored.admit().ok).toBe(false);
    p2.advance(2);
    expect(restored.admit().ok).toBe(true);
  });

  it("opens straight to half-open when the snapshot outlived the open period", () => {
    const p1 = new FakeClock(0, 1_700_000_000_000);
    const snap = openBreaker(p1).snapshot();

    const p2 = new FakeClock(0, 1_700_000_000_000 + 600_000); // ten minutes later
    const restored = new CircuitBreaker(
      { slowCallMs: 100, consecutiveBackstop: 1, openForMs: 30_000 },
      { clock: p2 },
    );
    restored.hydrate(snap);
    expect(restored.admit().ok).toBe(true); // a probe is due immediately
  });

  it("does not resurrect window samples that aged out while idle", () => {
    const p1 = new FakeClock(0, 1_700_000_000_000);
    const a = new CircuitBreaker(
      {
        slowCallMs: 100,
        consecutiveBackstop: 0,
        window: { calls: 100, maxAgeMs: 60_000, minCalls: 20 },
      },
      { clock: p1 },
    );
    for (let i = 0; i < 10; i++) {
      a.admit();
      a.settle({ verdict: "success", latencyMs: 5, at: p1.advance(100) });
    }
    expect(a.stats().windowSize).toBe(10);
    const snap = a.snapshot();

    const p2 = new FakeClock(0, 1_700_000_000_000 + 3_600_000); // an hour later
    const restored = new CircuitBreaker(
      {
        slowCallMs: 100,
        consecutiveBackstop: 0,
        window: { calls: 100, maxAgeMs: 60_000, minCalls: 20 },
      },
      { clock: p2 },
    );
    restored.hydrate(snap);
    expect(restored.stats().windowSize).toBe(0);
  });

  it("works when the clock provides no wallNow (gap simply unaccounted)", () => {
    const monotonicOnly = { now: () => 1_000 };
    const b = new CircuitBreaker(
      { slowCallMs: 100, consecutiveBackstop: 1, openForMs: 5_000 },
      { clock: monotonicOnly },
    );
    b.admit();
    b.settle({ verdict: "transient", latencyMs: 1, at: 1_000 });
    const snap = b.snapshot();
    expect(snap.wallClockAt).toBe(0);

    const restored = new CircuitBreaker(
      { slowCallMs: 100, consecutiveBackstop: 1, openForMs: 5_000 },
      { clock: monotonicOnly },
    );
    expect(() => restored.hydrate(snap)).not.toThrow();
    expect(restored.currentState).toBe("open");
  });
});
