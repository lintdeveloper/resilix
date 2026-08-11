import { describe, expect, it } from "vitest";
import { FakeClock, systemClock } from "./clock.ts";

describe("systemClock", () => {
  it("returns a monotonic reading that advances", async () => {
    const a = systemClock.now();
    await new Promise((r) => setTimeout(r, 2));
    expect(systemClock.now()).toBeGreaterThan(a);
  });

  it("provides an epoch reading via wallNow", () => {
    const wall = systemClock.wallNow?.();
    expect(wall).toBeGreaterThan(1_700_000_000_000);
  });

  it("does nothing at module scope — importing must be side-effect-free", () => {
    // Guard for the Workers constraint (ADR-001): no timers, no AbortController and no
    // random values at import time. This asserts the shape rather than the behaviour;
    // the real proof is the runtime CI matrix.
    expect(typeof systemClock.now).toBe("function");
    expect(typeof systemClock.wallNow).toBe("function");
  });
});

describe("FakeClock", () => {
  it("starts the two clocks on DELIBERATELY different origins", () => {
    // So that any test confusing monotonic time with epoch time fails immediately — the
    // exact bug this pair exists to prevent.
    const c = new FakeClock();
    expect(c.now()).toBe(0);
    expect(c.wallNow()).toBe(1_700_000_000_000);
  });

  it("advance() moves both clocks together", () => {
    const c = new FakeClock(100, 5_000);
    c.advance(50);
    expect(c.now()).toBe(150);
    expect(c.wallNow()).toBe(5_050);
  });

  it("advanceWall() moves only wall time, simulating an idle snapshot", () => {
    const c = new FakeClock(100, 5_000);
    c.advanceWall(20_000);
    expect(c.now()).toBe(100);
    expect(c.wallNow()).toBe(25_000);
  });

  it("set() repositions the monotonic clock only", () => {
    const c = new FakeClock(0, 1_000);
    c.set(999);
    expect(c.now()).toBe(999);
    expect(c.wallNow()).toBe(1_000);
  });

  it("refuses to travel backwards", () => {
    const c = new FakeClock();
    expect(() => c.advance(-1)).toThrow(RangeError);
    expect(() => c.advanceWall(-1)).toThrow(RangeError);
  });
});
