import { describe, expect, it, vi } from "vitest";
import { FakeClock } from "../clock.ts";
import CircuitBreaker from "./opossum.ts";

const failing = () => Promise.reject(Object.assign(new Error("nope"), { code: "ECONNRESET" }));
const ok = (v = "ok") => Promise.resolve(v);

describe("opossum compat — the API surface", () => {
  it("fires an action and resolves", async () => {
    const b = new CircuitBreaker(ok, { clock: new FakeClock() });
    await expect(b.fire()).resolves.toBe("ok");
    expect(b.stats.fires).toBe(1);
    expect(b.stats.successes).toBe(1);
  });

  it("passes arguments through", async () => {
    const action = vi.fn((a: number, b: number) => Promise.resolve(a + b));
    const cb = new CircuitBreaker(action, { clock: new FakeClock() });
    await expect(cb.fire(2, 3)).resolves.toBe(5);
    expect(action).toHaveBeenCalledWith(2, 3);
  });

  it("exposes name and group", () => {
    const b = new CircuitBreaker(ok, { name: "lookup", group: "identity" });
    expect(b.name).toBe("lookup");
    expect(b.group).toBe("identity");
  });

  it("reports opened / closed / halfOpen / pendingClose", async () => {
    const clock = new FakeClock();
    const b = new CircuitBreaker(failing, {
      errorThresholdPercentage: 50,
      volumeThreshold: 1,
      resetTimeout: 1_000,
      clock,
    });
    expect(b.closed).toBe(true);
    expect(b.opened).toBe(false);

    await b.fire().catch(() => undefined);
    expect(b.opened).toBe(true);
    expect(b.closed).toBe(false);

    clock.advance(1_001);
    await b.fire().catch(() => undefined);
    // the probe failed, so it re-opens
    expect(b.opened).toBe(true);
  });

  it("emits the opossum event set", async () => {
    const clock = new FakeClock();
    const events: string[] = [];
    const b = new CircuitBreaker(failing, {
      errorThresholdPercentage: 50,
      volumeThreshold: 1,
      clock,
    });
    for (const e of ["fire", "failure", "open", "reject", "success", "close", "halfOpen"]) {
      b.on(e, () => events.push(e));
    }

    await b.fire().catch(() => undefined);
    expect(events).toContain("fire");
    expect(events).toContain("failure");
    expect(events).toContain("open");

    await b.fire().catch(() => undefined);
    expect(events).toContain("reject");
  });

  it("supports off() and removeAllListeners()", async () => {
    const handler = vi.fn();
    const b = new CircuitBreaker(ok, { clock: new FakeClock() });
    b.on("success", handler);
    b.off("success", handler);
    await b.fire();
    expect(handler).not.toHaveBeenCalled();

    b.on("success", handler);
    b.removeAllListeners();
    await b.fire();
    expect(handler).not.toHaveBeenCalled();
  });

  it("swallows a throwing listener", async () => {
    const b = new CircuitBreaker(ok, { clock: new FakeClock() });
    b.on("success", () => {
      throw new Error("bad listener");
    });
    await expect(b.fire()).resolves.toBe("ok");
  });
});

describe("opossum compat — errors and rejection", () => {
  it("rejects with EOPENBREAKER once open", async () => {
    const clock = new FakeClock();
    const b = new CircuitBreaker(failing, {
      errorThresholdPercentage: 50,
      volumeThreshold: 1,
      clock,
    });
    await b.fire().catch(() => undefined);

    const error = await b.fire().catch((e: unknown) => e);
    expect((error as { code: string }).code).toBe("EOPENBREAKER");
    expect((error as Error).message).toBe("Breaker is open");
    expect(b.stats.rejects).toBe(1);
  });

  it("times out with ETIMEDOUT and counts it", async () => {
    const b = new CircuitBreaker(() => new Promise((r) => setTimeout(r, 200)), { timeout: 10 });
    const error = await b.fire().catch((e: unknown) => e);
    expect((error as { code: string }).code).toBe("ETIMEDOUT");
    expect(b.stats.timeouts).toBe(1);
  });

  it("timeout: false disables the deadline", async () => {
    const b = new CircuitBreaker(() => new Promise((r) => setTimeout(() => r("slow"), 20)), {
      timeout: false,
    });
    await expect(b.fire()).resolves.toBe("slow");
  });

  it("isOurError identifies breaker-generated errors", async () => {
    const clock = new FakeClock();
    const b = new CircuitBreaker(failing, {
      errorThresholdPercentage: 50,
      volumeThreshold: 1,
      clock,
    });
    await b.fire().catch(() => undefined);
    const error = await b.fire().catch((e: unknown) => e);
    expect(CircuitBreaker.isOurError(error)).toBe(true);
    expect(CircuitBreaker.isOurError(new Error("plain"))).toBe(false);
  });
});

describe("opossum compat — fallback", () => {
  it("runs the fallback when the circuit is open", async () => {
    const clock = new FakeClock();
    const b = new CircuitBreaker(failing, {
      errorThresholdPercentage: 50,
      volumeThreshold: 1,
      clock,
    });
    b.fallback(() => "from-fallback");
    await b.fire().catch(() => undefined);
    await expect(b.fire()).resolves.toBe("from-fallback");
    expect(b.stats.fallbacks).toBeGreaterThan(0);
  });

  it("runs the fallback on a failure and emits `fallback`", async () => {
    const onFallback = vi.fn();
    const b = new CircuitBreaker(failing, { clock: new FakeClock() });
    b.fallback(() => "safe");
    b.on("fallback", onFallback);
    await expect(b.fire()).resolves.toBe("safe");
    expect(onFallback).toHaveBeenCalled();
  });

  it("receives the original arguments", async () => {
    const b = new CircuitBreaker((_a: number) => failing(), { clock: new FakeClock() });
    b.fallback((a) => `fallback:${String(a)}`);
    await expect(b.fire(7)).resolves.toBe("fallback:7");
  });
});

describe("opossum compat — option mapping", () => {
  it("errorThresholdPercentage is a PERCENTAGE, not a ratio", async () => {
    const clock = new FakeClock();
    // 60% threshold: 3 failures out of 5 (60%) must NOT open; 4 of 5 (80%) must.
    const b = new CircuitBreaker((shouldFail: boolean) => (shouldFail ? failing() : ok()), {
      errorThresholdPercentage: 60,
      volumeThreshold: 5,
      rollingCountTimeout: 60_000,
      clock,
    });

    for (const fail of [true, true, true, false, false]) {
      await b.fire(fail).catch(() => undefined);
    }
    expect(b.opened).toBe(false);

    await b.fire(true).catch(() => undefined); // 4/6 = 67% > 60%
    expect(b.opened).toBe(true);
  });

  it("volumeThreshold gates the percentage check", async () => {
    const clock = new FakeClock();
    const b = new CircuitBreaker(failing, {
      errorThresholdPercentage: 50,
      volumeThreshold: 5,
      clock,
    });
    for (let i = 0; i < 4; i++) await b.fire().catch(() => undefined);
    expect(b.opened).toBe(false);
    await b.fire().catch(() => undefined);
    expect(b.opened).toBe(true);
  });

  it("resetTimeout controls when a probe is admitted", async () => {
    const clock = new FakeClock();
    let fail = true;
    const b = new CircuitBreaker(() => (fail ? failing() : ok("recovered")), {
      errorThresholdPercentage: 50,
      volumeThreshold: 1,
      resetTimeout: 5_000,
      clock,
    });
    await b.fire().catch(() => undefined);
    clock.advance(4_999);
    await expect(b.fire()).rejects.toMatchObject({ code: "EOPENBREAKER" });

    clock.advance(2);
    fail = false;
    await expect(b.fire()).resolves.toBe("recovered");
    expect(b.closed).toBe(true); // opossum closes on the FIRST successful probe
  });

  it("errorFilter excludes an error from counting as a failure", async () => {
    const clock = new FakeClock();
    const notFound = Object.assign(new Error("not found"), { statusCode: 404 });
    const b = new CircuitBreaker(() => Promise.reject(notFound), {
      errorThresholdPercentage: 50,
      volumeThreshold: 1,
      errorFilter: (err) => (err as { statusCode?: number }).statusCode === 404,
      clock,
    });

    for (let i = 0; i < 10; i++) await b.fire().catch(() => undefined);
    expect(b.opened).toBe(false);
    expect(b.stats.failures).toBe(0);
    expect(b.stats.successes).toBe(10);
  });

  it("capacity maps to a semaphore and emits semaphoreLocked", async () => {
    const onLocked = vi.fn();
    const b = new CircuitBreaker(() => new Promise((r) => setTimeout(() => r("slow"), 50)), {
      capacity: 1,
      timeout: false,
    });
    b.on("semaphoreLocked", onLocked);

    const first = b.fire();
    const second = b.fire().catch((e: unknown) => e);
    const error = await second;
    expect((error as { code: string }).code).toBe("ESEMLOCKED");
    expect(onLocked).toHaveBeenCalled();
    expect(b.stats.semaphoreRejections).toBe(1);
    await first;
  });

  it("accepts rollingCountBuckets and ignores it", () => {
    expect(
      () => new CircuitBreaker(ok, { rollingCountBuckets: 10, clock: new FakeClock() }),
    ).not.toThrow();
  });

  it("THROWS for the unsupported options rather than silently ignoring them", () => {
    // Silently accepting `cache` would be worse than refusing: the caller would believe
    // responses were being cached when they were not.
    expect(() => new CircuitBreaker(ok, { cache: true })).toThrow(/does not support `cache`/);
    expect(() => new CircuitBreaker(ok, { coalesce: true })).toThrow(/coalesce/);
    expect(() => new CircuitBreaker(ok, { cacheTTL: 1000 })).toThrow(/cacheTTL/);
  });
});

describe("opossum compat — behaviour must NOT change on the import swap", () => {
  it("slow-call tripping is DISABLED by default", async () => {
    const clock = new FakeClock();
    // Every call is far slower than the timeout would allow, but succeeds. opossum has no
    // slow-call concept, so the circuit must stay closed.
    const b = new CircuitBreaker(
      () => {
        clock.advance(60_000);
        return ok();
      },
      { timeout: false, volumeThreshold: 1, clock },
    );
    for (let i = 0; i < 30; i++) await b.fire();
    expect(b.opened).toBe(false);
  });

  it("a 4xx still counts as a failure unless errorFilter says otherwise", async () => {
    const clock = new FakeClock();
    const b = new CircuitBreaker(
      () => Promise.reject(Object.assign(new Error("bad request"), { statusCode: 400 })),
      { errorThresholdPercentage: 50, volumeThreshold: 1, clock },
    );
    await b.fire().catch(() => undefined);
    // resilix would call this `answered`; opossum counts it. Compat preserves opossum.
    expect(b.opened).toBe(true);
  });

  it("the consecutive-failure backstop is DISABLED by default", async () => {
    const clock = new FakeClock();
    const b = new CircuitBreaker(failing, {
      errorThresholdPercentage: 99,
      volumeThreshold: 1_000_000,
      clock,
    });
    for (let i = 0; i < 50; i++) await b.fire().catch(() => undefined);
    expect(b.opened).toBe(false);
  });

  it("opt-in extensions turn the resilix behaviour back on", async () => {
    const clock = new FakeClock();
    const b = new CircuitBreaker(
      () => {
        clock.advance(9_000);
        return ok();
      },
      {
        timeout: false,
        volumeThreshold: 5,
        slowCallMs: 3_000,
        slowCallRate: 0.5,
        rollingCountTimeout: 600_000,
        clock,
      },
    );
    // Trips on the 5th settle: the window reaches volumeThreshold (5) and slowRate is
    // 1.0, which exceeds slowCallRate 0.5. A 6th call would be refused, not executed.
    for (let i = 0; i < 5; i++) await b.fire();
    expect(b.opened).toBe(true); // now it trips on slowness alone
    await expect(b.fire()).rejects.toMatchObject({ code: "EOPENBREAKER" });
  });
});

describe("opossum compat — manual control", () => {
  it("open() and close() force the state", async () => {
    const b = new CircuitBreaker(ok, { clock: new FakeClock() });
    b.open();
    expect(b.opened).toBe(true);
    await expect(b.fire()).rejects.toMatchObject({ code: "EOPENBREAKER" });

    b.close();
    expect(b.opened).toBe(false);
    await expect(b.fire()).resolves.toBe("ok");
  });

  it("disable() bypasses the breaker entirely", async () => {
    const clock = new FakeClock();
    const b = new CircuitBreaker(failing, {
      errorThresholdPercentage: 50,
      volumeThreshold: 1,
      clock,
    });
    await b.fire().catch(() => undefined);
    expect(b.opened).toBe(true);

    b.disable();
    await expect(b.fire()).rejects.toThrow("nope"); // the real error, not EOPENBREAKER
    b.enable();
    await expect(b.fire()).rejects.toMatchObject({ code: "EOPENBREAKER" });
  });

  it("exposes status.stats", async () => {
    const b = new CircuitBreaker(ok, { clock: new FakeClock() });
    await b.fire();
    expect(b.status.stats.fires).toBe(1);
  });
});
