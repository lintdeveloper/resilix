import { describe, expect, it, vi } from "vitest";
import { breaker } from "../policies/breaker.ts";
import type { CircuitBreaker } from "../policies/breaker.ts";
import { FakeClock } from "./clock.ts";
import { RejectedError, TimeoutError, pipeline } from "./pipeline.ts";
import { KeyRegistry } from "./registry.ts";

describe("pipeline", () => {
  it("requires at least one policy", () => {
    expect(() => pipeline({ policies: [] })).toThrow(RangeError);
  });

  it("passes a successful result straight through", async () => {
    const p = pipeline({ policies: [breaker({ slowCallMs: 100 })], clock: new FakeClock() });
    await expect(p.execute({}, () => ({ status: 200 }))).resolves.toEqual({ status: 200 });
  });

  it("rethrows the original error, not a wrapper", async () => {
    const boom = Object.assign(new Error("upstream down"), { code: "ECONNRESET" });
    const p = pipeline({ policies: [breaker({ slowCallMs: 100 })], clock: new FakeClock() });
    await expect(
      p.execute({}, () => {
        throw boom;
      }),
    ).rejects.toBe(boom);
  });

  it("throws RejectedError once the breaker is open", async () => {
    const clock = new FakeClock();
    const p = pipeline({
      policies: [breaker({ slowCallMs: 100, consecutiveBackstop: 2 })],
      clock,
    });

    for (let i = 0; i < 2; i++) {
      await expect(
        p.execute({}, () => {
          throw Object.assign(new Error("x"), { code: "ECONNRESET" });
        }),
      ).rejects.toThrow("x");
    }

    const failure = await p.execute({}, () => ({ status: 200 })).catch((e: unknown) => e);
    expect(failure).toBeInstanceOf(RejectedError);
    expect((failure as RejectedError).reason).toBe("circuit-open");
    expect((failure as RejectedError).code).toBe("RESILIX_REJECTED");
  });

  it("does not invoke the function when refused", async () => {
    const clock = new FakeClock();
    const fn = vi.fn(() => ({ status: 200 }));
    const p = pipeline({
      policies: [breaker({ slowCallMs: 100, consecutiveBackstop: 1 })],
      clock,
    });
    await p
      .execute({}, () => {
        throw Object.assign(new Error("x"), { code: "ECONNRESET" });
      })
      .catch(() => undefined);

    await p.execute({}, fn).catch(() => undefined);
    expect(fn).not.toHaveBeenCalled();
  });

  it("classifies a 4xx result as healthy, so it never opens the circuit", async () => {
    const clock = new FakeClock();
    const p = pipeline({
      policies: [breaker({ slowCallMs: 100, consecutiveBackstop: 5 })],
      clock,
    });
    for (let i = 0; i < 100; i++) {
      await p.execute({}, () => ({ status: 404 }));
    }
    const b = p.policiesFor()[0] as CircuitBreaker;
    expect(b.currentState).toBe("closed");
  });
});

describe("per-key isolation", () => {
  it("keeps a failing host from opening the circuit for a healthy one", async () => {
    const clock = new FakeClock();
    const p = pipeline<{ host: string }>({
      key: (input) => input.host,
      policies: [breaker({ slowCallMs: 100, consecutiveBackstop: 2 })],
      clock,
    });

    for (let i = 0; i < 2; i++) {
      await p
        .execute({ host: "bad.example" }, () => {
          throw Object.assign(new Error("x"), { code: "ECONNRESET" });
        })
        .catch(() => undefined);
    }

    await expect(
      p.execute({ host: "bad.example" }, () => ({ status: 200 })),
    ).rejects.toBeInstanceOf(RejectedError);

    await expect(p.execute({ host: "good.example" }, () => ({ status: 200 }))).resolves.toEqual({
      status: 200,
    });
    expect(p.trackedKeys.sort()).toEqual(["bad.example", "good.example"]);
  });
});

describe("timeout", () => {
  it("rejects with TimeoutError and aborts the signal", async () => {
    const p = pipeline({ policies: [breaker({ slowCallMs: 50 })], timeoutMs: 20 });

    let observed: AbortSignal | undefined;
    const failure = await p
      .execute({}, (ctx) => {
        observed = ctx.signal;
        return new Promise((resolve) => setTimeout(resolve, 200));
      })
      .catch((e: unknown) => e);

    expect(failure).toBeInstanceOf(TimeoutError);
    expect(observed?.aborted).toBe(true);
  });

  it("records the timeout as a breaker failure", async () => {
    const p = pipeline({
      policies: [breaker({ slowCallMs: 5, consecutiveBackstop: 2 })],
      timeoutMs: 10,
    });

    for (let i = 0; i < 2; i++) {
      await p.execute({}, () => new Promise((r) => setTimeout(r, 100))).catch(() => undefined);
    }
    const b = p.policiesFor()[0] as CircuitBreaker;
    expect(b.currentState).toBe("open");
  });

  it("leaves no signal when no timeout is configured", async () => {
    const p = pipeline({ policies: [breaker({ slowCallMs: 100 })], clock: new FakeClock() });
    let seen: AbortSignal | undefined = {} as AbortSignal;
    await p.execute({}, (ctx) => {
      seen = ctx.signal;
      return 1;
    });
    expect(seen).toBeUndefined();
  });

  it("clears the deadline once the call settles", async () => {
    // A lingering timer would keep a Node process alive; the pipeline must clear it.
    const spy = vi.spyOn(globalThis, "clearTimeout");
    const p = pipeline({ policies: [breaker({ slowCallMs: 100 })], timeoutMs: 5_000 });
    await p.execute({}, () => ({ status: 200 }));
    expect(spy).toHaveBeenCalled();
    spy.mockRestore();
  });
});

describe("gate() — driving the state machine by hand", () => {
  it("admits, then accepts a settled outcome", () => {
    const clock = new FakeClock();
    const p = pipeline({ policies: [breaker({ slowCallMs: 100, consecutiveBackstop: 2 })], clock });

    const first = p.gate({});
    expect(first.ok).toBe(true);
    first.settle({ status: 500 }, 20);

    const second = p.gate({});
    second.settle({ status: 500 }, 20);

    const third = p.gate({});
    expect(third.ok).toBe(false);
    expect(third.reason).toBe("circuit-open");
    expect(third.retryAfterMs).toBeGreaterThan(0);
  });

  it("accepts a verdict directly, bypassing the classifier", () => {
    const clock = new FakeClock();
    const p = pipeline({ policies: [breaker({ slowCallMs: 100, consecutiveBackstop: 1 })], clock });
    p.gate({}).settleVerdict("transient", 5);
    expect(p.gate({}).ok).toBe(false);
  });

  it("settling a refused gate is a harmless no-op", () => {
    const clock = new FakeClock();
    const p = pipeline({ policies: [breaker({ slowCallMs: 100, consecutiveBackstop: 1 })], clock });
    p.gate({}).settleVerdict("transient", 5);
    const refused = p.gate({});
    expect(() => refused.settle({ status: 200 }, 1)).not.toThrow();
    expect(() => refused.settleVerdict("success", 1)).not.toThrow();
  });
});

describe("snapshot / hydrate across instances", () => {
  it("carries breaker state, which is the serverless use case", async () => {
    const clock = new FakeClock();
    const a = pipeline({ policies: [breaker({ slowCallMs: 100, consecutiveBackstop: 2 })], clock });
    for (let i = 0; i < 2; i++) {
      await a
        .execute({}, () => {
          throw Object.assign(new Error("x"), { code: "ECONNRESET" });
        })
        .catch(() => undefined);
    }

    const b = pipeline({ policies: [breaker({ slowCallMs: 100, consecutiveBackstop: 2 })], clock });
    b.hydrate(a.snapshot());
    await expect(b.execute({}, () => ({ status: 200 }))).rejects.toBeInstanceOf(RejectedError);
  });
});

describe("KeyRegistry", () => {
  it("builds one value per key and reuses it", () => {
    const factory = vi.fn((key: string) => ({ key }));
    const r = new KeyRegistry({ factory, clock: new FakeClock() });
    const first = r.get("a");
    expect(r.get("a")).toBe(first);
    expect(factory).toHaveBeenCalledTimes(1);
  });

  it("expires keys after the TTL", () => {
    const clock = new FakeClock();
    const factory = vi.fn((key: string) => ({ key }));
    const r = new KeyRegistry({ factory, ttlMs: 1_000, clock });
    const first = r.get("a");
    clock.advance(1_001);
    expect(r.get("a")).not.toBe(first);
    expect(factory).toHaveBeenCalledTimes(2);
  });

  it("enforces a hard cap so tenant- or attacker-influenced keys cannot leak", () => {
    const clock = new FakeClock();
    const r = new KeyRegistry({ factory: (key: string) => ({ key }), maxKeys: 5, clock });
    for (let i = 0; i < 100; i++) r.get(`key-${i}`);
    expect(r.size).toBeLessThanOrEqual(5);
    expect(r.keys()).toContain("key-99");
  });

  it("evicts least-recently-used first", () => {
    const clock = new FakeClock();
    const r = new KeyRegistry({ factory: (key: string) => ({ key }), maxKeys: 2, clock });
    r.get("a");
    r.get("b");
    clock.advance(1);
    r.get("a"); // touch a, so b is now the LRU
    r.get("c");
    expect(r.keys()).toContain("a");
    expect(r.keys()).not.toContain("b");
  });

  it("clear() drops everything", () => {
    const r = new KeyRegistry({ factory: (key: string) => ({ key }), clock: new FakeClock() });
    r.get("a");
    r.clear();
    expect(r.size).toBe(0);
  });
});
