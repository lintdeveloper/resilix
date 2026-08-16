import { describe, expect, it } from "vitest";
import type { Observation, Verdict } from "../core/types.ts";
import { Bulkhead } from "./bulkhead.ts";

const settle = (b: Bulkhead, verdict: Verdict = "success"): void => {
  const obs: Observation = { verdict, latencyMs: 1, at: 0 };
  b.settle(obs);
};

describe("Bulkhead", () => {
  it("validates concurrency", () => {
    expect(() => new Bulkhead({ concurrency: 0 })).toThrow(RangeError);
    expect(() => new Bulkhead({ concurrency: -1 })).toThrow(RangeError);
    expect(() => new Bulkhead({ concurrency: 1.5 })).toThrow(RangeError);
  });

  it("admits up to the limit and refuses beyond it", () => {
    const b = new Bulkhead({ concurrency: 3 });
    expect(b.admit().ok).toBe(true);
    expect(b.admit().ok).toBe(true);
    expect(b.admit().ok).toBe(true);
    const refused = b.admit();
    expect(refused.ok).toBe(false);
    if (!refused.ok) expect(refused.reason).toBe("bulkhead-full");
  });

  it("releases a slot on settle", () => {
    const b = new Bulkhead({ concurrency: 1 });
    expect(b.admit().ok).toBe(true);
    expect(b.admit().ok).toBe(false);
    settle(b);
    expect(b.admit().ok).toBe(true);
  });

  it("releases the slot for EVERY verdict, including rejected", () => {
    // An inner policy may refuse after we admitted. Leaking the slot would permanently
    // shrink capacity, so `rejected` must still release.
    const b = new Bulkhead({ concurrency: 2 });
    b.admit();
    b.admit();
    settle(b, "rejected");
    settle(b, "transient");
    expect(b.inFlightCount).toBe(0);
    expect(b.admit().ok).toBe(true);
  });

  it("never lets the counter go negative on an unmatched settle", () => {
    const b = new Bulkhead({ concurrency: 2 });
    settle(b);
    settle(b);
    expect(b.inFlightCount).toBe(0);
    expect(b.admit().ok).toBe(true);
    expect(b.admit().ok).toBe(true);
    expect(b.admit().ok).toBe(false);
  });

  it("reports utilisation for telemetry", () => {
    const b = new Bulkhead({ concurrency: 4 });
    b.admit();
    b.admit();
    expect(b.metrics()).toEqual({ inFlight: 2, limit: 4, utilisation: 0.5 });
  });

  it("round-trips and clamps a hydrated count to the limit", () => {
    const b = new Bulkhead({ concurrency: 2 });
    b.hydrate({ inFlight: 99 });
    expect(b.inFlightCount).toBe(2);
    b.hydrate({ inFlight: -5 });
    expect(b.inFlightCount).toBe(0);
    b.admit();
    expect(b.snapshot()).toEqual({ inFlight: 1 });
  });
});
