/**
 * Tests written directly from the use cases resilix advertises.
 *
 * These exist because the documented use-case table was written before the implementation
 * was audited against it, and the audit found the headline case — LLM/inference APIs — was
 * actively broken by the library's own documented defaults. Each block below is one row of
 * that table.
 */
import { describe, expect, it, vi } from "vitest";
import { breaker } from "./breaker.ts";
import type { CircuitBreaker } from "./breaker.ts";
import { bulkhead } from "./bulkhead.ts";
import { classifySql } from "./classify-sql.ts";
import { retryAfterFrom } from "./classify.ts";
import { FakeClock } from "./clock.ts";
import { pipeline } from "./pipeline.ts";

const brk = (p: ReturnType<typeof pipeline>, key = "default") =>
  p.policiesFor(key)[0] as CircuitBreaker;

describe("use case: streaming LLM completions", () => {
  it("WITHOUT mark(), a healthy 45s stream is judged on total duration", () => {
    // Documents the trap rather than endorsing it: total duration is the wrong signal for
    // anything streaming, which is why mark() exists.
    const clock = new FakeClock();
    const p = pipeline({
      policies: [
        breaker({
          slowCallMs: 3_000,
          consecutiveBackstop: 0,
          window: { calls: 100, maxAgeMs: 3_600_000, minCalls: 20 },
        }),
      ],
      clock,
    });
    for (let i = 0; i < 20; i++) {
      p.gate({}).settle({ status: 200 }, 45_000);
    }
    expect(brk(p).currentState).toBe("open"); // false outage on perfectly healthy traffic
  });

  it("WITH mark(), latency is time-to-first-token and the stream stays healthy", async () => {
    const clock = new FakeClock();
    const p = pipeline({
      policies: [
        breaker({
          slowCallMs: 3_000,
          consecutiveBackstop: 0,
          window: { calls: 100, maxAgeMs: 3_600_000, minCalls: 20 },
        }),
      ],
      clock,
    });

    for (let i = 0; i < 30; i++) {
      await p.execute({}, (ctx) => {
        clock.advance(280); // time to first token — the actual health signal
        ctx.mark();
        clock.advance(45_000); // streaming the rest of the completion
        return { status: 200 };
      });
    }

    const b = brk(p);
    expect(b.currentState).toBe("closed");
    expect(b.stats().slowRate).toBe(0);
  });

  it("mark() still catches a stream that is slow to START", async () => {
    const clock = new FakeClock();
    const p = pipeline({
      policies: [
        breaker({
          slowCallMs: 3_000,
          consecutiveBackstop: 0,
          window: { calls: 100, maxAgeMs: 3_600_000, minCalls: 20 },
        }),
      ],
      clock,
    });

    for (let i = 0; i < 20; i++) {
      await p
        .execute({}, (ctx) => {
          clock.advance(40_000); // 40s to first token: genuinely sick
          ctx.mark();
          return { status: 200 };
        })
        .catch(() => undefined);
    }
    expect(brk(p).currentState).toBe("open");
  });

  it("only the first mark() counts", async () => {
    const clock = new FakeClock();
    const seen: number[] = [];
    const p = pipeline({
      policies: [breaker({ slowCallMs: 100_000 })],
      clock,
      observers: [{ onExecution: (e) => seen.push(e.latencyMs) }],
    });
    await p.execute({}, (ctx) => {
      clock.advance(100);
      ctx.mark();
      clock.advance(5_000);
      ctx.mark(); // ignored
      return { status: 200 };
    });
    expect(seen).toEqual([100]);
  });
});

describe("window starvation — the silently dead trip condition", () => {
  it("reports starved when slow calls stop the window reaching minCalls", () => {
    // A window bounded by age holds at most maxAgeMs/callDuration samples, so calls slower
    // than maxAgeMs/minCalls (15s at the defaults) make both rate conditions inert.
    const clock = new FakeClock();
    const p = pipeline({
      policies: [breaker({ slowCallMs: 3_000, consecutiveBackstop: 0 })],
      clock,
    });
    for (let i = 0; i < 30; i++) {
      p.gate({}).settle({ status: 200 }, 1);
      clock.advance(45_000);
    }

    const stats = brk(p).stats();
    expect(stats.windowSize).toBeLessThan(20);
    expect(stats.starved).toBe(true);
    expect(brk(p).currentState).toBe("closed");
  });

  it("is NOT starved at normal call rates", async () => {
    const clock = new FakeClock();
    const p = pipeline({ policies: [breaker({ slowCallMs: 3_000 })], clock });
    for (let i = 0; i < 30; i++) {
      await p.execute({}, () => {
        clock.advance(200);
        return { status: 200 };
      });
    }
    expect(brk(p).stats().starved).toBe(false);
  });

  it("surfaces starvation as a gauge, so it can be alerted on", () => {
    const clock = new FakeClock();
    const p = pipeline({
      policies: [breaker({ slowCallMs: 3_000, consecutiveBackstop: 0 })],
      clock,
    });
    for (let i = 0; i < 30; i++) {
      p.gate({}).settle({ status: 200 }, 1);
      clock.advance(45_000);
    }
    expect(p.metrics()[0]?.values.starved).toBe(1);
  });
});

describe("use case: 429 + Retry-After from a model provider", () => {
  it("extracts Retry-After from a fetch Response and surfaces it", async () => {
    const clock = new FakeClock();
    const events: Array<{ verdict: string; retryAfterMs?: number }> = [];
    const p = pipeline({
      policies: [breaker({ slowCallMs: 3_000 })],
      clock,
      observers: [{ onExecution: (e) => events.push(e) }],
    });

    await p.execute({}, () => ({ status: 429, headers: new Headers({ "retry-after": "30" }) }));

    expect(events[0]?.verdict).toBe("overload");
    expect(events[0]?.retryAfterMs).toBe(30_000);
  });

  it("reads it from an axios-shaped error too", () => {
    const now = 0;
    expect(
      retryAfterFrom({ response: { status: 429, headers: { "retry-after": "12" } } }, now),
    ).toBe(12_000);
  });

  it("handles a header array, as node:http produces", () => {
    expect(retryAfterFrom({ headers: { "retry-after": ["5"] } }, 0)).toBe(5_000);
  });

  it("does not parse headers on the healthy path", async () => {
    const clock = new FakeClock();
    const events: Array<{ retryAfterMs?: number }> = [];
    const p = pipeline({
      policies: [breaker({ slowCallMs: 3_000 })],
      clock,
      observers: [{ onExecution: (e) => events.push(e) }],
    });
    const get = vi.fn(() => "30");
    await p.execute({}, () => ({ status: 200, headers: { get } }));
    expect(get).not.toHaveBeenCalled();
    expect(events[0]?.retryAfterMs).toBeUndefined();
  });

  it("sustained 429s never open the circuit", async () => {
    const clock = new FakeClock();
    const p = pipeline({ policies: [breaker({ slowCallMs: 3_000 })], clock });
    for (let i = 0; i < 100; i++) {
      await p.execute({}, () => ({ status: 429 }));
    }
    expect(brk(p).currentState).toBe("closed");
  });
});

describe("use case: content-policy rejection", () => {
  it("a 400 is answered — the model worked, the prompt did not", async () => {
    const clock = new FakeClock();
    const p = pipeline({ policies: [breaker({ slowCallMs: 3_000 })], clock });
    for (let i = 0; i < 200; i++) {
      await p.execute({}, () => ({ status: 400 }));
    }
    expect(brk(p).currentState).toBe("closed");
  });
});

describe("use case: Prisma / pg connection pool", () => {
  it("classifies a unique violation as answered, not as a database outage", () => {
    // Under the HTTP classifier this was `transient`, so a burst of duplicate inserts —
    // an ordinary application condition — looked like the database falling over.
    expect(classifySql(Object.assign(new Error("dup"), { code: "23505" }))).toBe("answered");
    expect(classifySql({ code: "P2002" })).toBe("answered");
    expect(classifySql({ code: "P2025" })).toBe("answered");
    expect(classifySql({ code: "42703" })).toBe("answered"); // undefined column
  });

  it("classifies pool exhaustion as overload, not transient", () => {
    // The database is healthy; we are asking for more than we are allowed. That should shed
    // load, not open a circuit.
    expect(classifySql({ code: "P2024" })).toBe("overload");
    expect(classifySql({ code: "53300" })).toBe("overload");
    expect(classifySql({ code: "40001" })).toBe("overload"); // serialization failure
    expect(classifySql({ code: "40P01" })).toBe("overload"); // deadlock
  });

  it("classifies real unavailability as transient", () => {
    expect(classifySql({ code: "P1001" })).toBe("transient");
    expect(classifySql({ code: "08006" })).toBe("transient");
    expect(classifySql({ code: "57P01" })).toBe("transient");
    expect(classifySql(Object.assign(new Error("x"), { code: "ECONNREFUSED" }))).toBe("transient");
  });

  it("classifies statement timeouts as timeout", () => {
    expect(classifySql({ code: "57014" })).toBe("timeout");
    expect(classifySql({ code: "P1008" })).toBe("timeout");
  });

  it("treats an unlabelled thrown error as transient, and a plain value as success", () => {
    expect(classifySql(new Error("who knows"))).toBe("transient");
    expect(classifySql({ rows: [] })).toBe("success");
    expect(classifySql(undefined)).toBe("success");
  });

  it("keeps a burst of duplicate inserts from opening the circuit", async () => {
    const clock = new FakeClock();
    const p = pipeline({
      classify: classifySql,
      policies: [breaker({ slowCallMs: 1_000, consecutiveBackstop: 5 })],
      clock,
    });
    for (let i = 0; i < 50; i++) {
      await p
        .execute({}, () => {
          throw Object.assign(new Error("duplicate key"), { code: "23505" });
        })
        .catch(() => undefined);
    }
    expect(brk(p).currentState).toBe("closed");
  });

  it("bulkheads the pool so a burst cannot exhaust it", async () => {
    const clock = new FakeClock();
    const p = pipeline({
      classify: classifySql,
      policies: [bulkhead({ concurrency: 10 })],
      clock,
    });
    const release: Array<() => void> = [];
    const inflight = Array.from({ length: 10 }, () =>
      p.execute({}, () => new Promise<number>((resolve) => release.push(() => resolve(1)))),
    );
    await expect(p.execute({}, () => 2)).rejects.toThrow(/bulkhead-full/);
    for (const r of release) r();
    await Promise.all(inflight);
    await expect(p.execute({}, () => 3)).resolves.toBe(3);
  });
});

describe("use case: one tenant must not exhaust another's quota", () => {
  it("isolates per tenant, so a bad tenant cannot open the circuit for a good one", async () => {
    const clock = new FakeClock();
    const p = pipeline<{ tenant: string }>({
      key: (i) => i.tenant,
      policies: [breaker({ slowCallMs: 3_000, consecutiveBackstop: 2 })],
      clock,
    });

    for (let i = 0; i < 2; i++) {
      await p
        .execute({ tenant: "noisy" }, () => {
          throw Object.assign(new Error("x"), { code: "ECONNRESET" });
        })
        .catch(() => undefined);
    }

    await expect(p.execute({ tenant: "noisy" }, () => ({ status: 200 }))).rejects.toThrow(
      /circuit-open/,
    );
    await expect(p.execute({ tenant: "quiet" }, () => ({ status: 200 }))).resolves.toEqual({
      status: 200,
    });
  });

  it("bounds tenant-keyed state so a tenant explosion cannot leak memory", async () => {
    const clock = new FakeClock();
    const p = pipeline<{ tenant: string }>({
      key: (i) => i.tenant,
      policies: [breaker({ slowCallMs: 3_000 })],
      clock,
      registry: { maxKeys: 50 },
    });
    for (let i = 0; i < 5_000; i++) {
      await p.execute({ tenant: `t-${i}` }, () => ({ status: 200 }));
    }
    expect(p.trackedKeys.length).toBeLessThanOrEqual(50);
  });
});
