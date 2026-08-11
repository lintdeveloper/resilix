import { describe, expect, it, vi } from "vitest";
import { breaker } from "./breaker.ts";
import { bulkhead } from "./bulkhead.ts";
import { FakeClock } from "./clock.ts";
import { otel } from "./otel.ts";
import type {
  CounterLike,
  HistogramLike,
  MeterLike,
  ObservableGaugeLike,
  ObservableResultLike,
} from "./otel.ts";
import { pipeline } from "./pipeline.ts";

interface Recorded {
  counters: Map<string, Array<{ value: number; attributes?: Record<string, string | number> }>>;
  histograms: Map<string, Array<{ value: number; attributes?: Record<string, string | number> }>>;
  gauges: Map<string, Array<(result: ObservableResultLike) => void>>;
}

const fakeMeter = (): { meter: MeterLike; recorded: Recorded } => {
  const recorded: Recorded = { counters: new Map(), histograms: new Map(), gauges: new Map() };

  const meter: MeterLike = {
    createCounter: (name): CounterLike => {
      recorded.counters.set(name, []);
      return {
        add: (value, attributes) => recorded.counters.get(name)?.push({ value, attributes }),
      };
    },
    createHistogram: (name): HistogramLike => {
      recorded.histograms.set(name, []);
      return {
        record: (value, attributes) => recorded.histograms.get(name)?.push({ value, attributes }),
      };
    },
    createObservableGauge: (name): ObservableGaugeLike => {
      recorded.gauges.set(name, []);
      return { addCallback: (cb) => recorded.gauges.get(name)?.push(cb) };
    },
  };

  return { meter, recorded };
};

/** Collect a gauge the way an OTel reader would. */
const readGauge = (
  recorded: Recorded,
  name: string,
): Array<{ value: number; attributes?: Record<string, string | number> }> => {
  const out: Array<{ value: number; attributes?: Record<string, string | number> }> = [];
  const result: ObservableResultLike = {
    observe: (value, attributes) => out.push({ value, attributes }),
  };
  for (const cb of recorded.gauges.get(name) ?? []) cb(result);
  return out;
};

describe("otel()", () => {
  it("is a safe no-op without a meter, so tests need no OTel install", async () => {
    const p = pipeline({
      policies: [breaker({ slowCallMs: 100 })],
      clock: new FakeClock(),
      observers: [otel()],
    });
    await expect(p.execute({}, () => ({ status: 200 }))).resolves.toEqual({ status: 200 });
    expect(() => otel().observeGauges(p)).not.toThrow();
  });

  it("counts executions and records latency, tagged with the verdict", async () => {
    const { meter, recorded } = fakeMeter();
    const clock = new FakeClock();
    const p = pipeline({
      policies: [breaker({ slowCallMs: 100 })],
      clock,
      observers: [otel({ meter })],
    });

    await p.execute({}, () => {
      clock.advance(42);
      return { status: 200 };
    });
    await p.execute({}, () => ({ status: 404 }));

    const executions = recorded.counters.get("resilix.executions") ?? [];
    expect(executions).toHaveLength(2);
    expect(executions[0]?.attributes).toMatchObject({ verdict: "success", key: "default" });
    expect(executions[1]?.attributes).toMatchObject({ verdict: "answered" });

    const durations = recorded.histograms.get("resilix.execution.duration") ?? [];
    expect(durations[0]?.value).toBe(42);
  });

  it("counts rejections by reason and policy", async () => {
    const { meter, recorded } = fakeMeter();
    const clock = new FakeClock();
    const p = pipeline({
      policies: [breaker({ slowCallMs: 100, consecutiveBackstop: 1 })],
      clock,
      observers: [otel({ meter })],
    });

    await p
      .execute({}, () => {
        throw Object.assign(new Error("x"), { code: "ECONNRESET" });
      })
      .catch(() => undefined);
    await p.execute({}, () => ({ status: 200 })).catch(() => undefined);

    const rejections = recorded.counters.get("resilix.rejections") ?? [];
    expect(rejections).toHaveLength(1);
    expect(rejections[0]?.attributes).toMatchObject({ reason: "circuit-open", policy: "breaker" });
  });

  it("counts state transitions with the trip reason", async () => {
    const { meter, recorded } = fakeMeter();
    const clock = new FakeClock();
    const p = pipeline({
      policies: [breaker({ slowCallMs: 100, consecutiveBackstop: 2 })],
      clock,
      observers: [otel({ meter })],
    });

    for (let i = 0; i < 2; i++) {
      await p
        .execute({}, () => {
          throw Object.assign(new Error("x"), { code: "ECONNRESET" });
        })
        .catch(() => undefined);
    }

    const transitions = recorded.counters.get("resilix.state.transitions") ?? [];
    expect(transitions).toHaveLength(1);
    expect(transitions[0]?.attributes).toMatchObject({
      from: "closed",
      to: "open",
      reason: "consecutive",
    });
  });

  it("attaches the caller's base attributes to every measurement", async () => {
    const { meter, recorded } = fakeMeter();
    const p = pipeline({
      policies: [breaker({ slowCallMs: 100 })],
      clock: new FakeClock(),
      observers: [otel({ meter, attributes: { service: "checkout" } })],
    });
    await p.execute({}, () => ({ status: 200 }));
    expect(recorded.counters.get("resilix.executions")?.[0]?.attributes).toMatchObject({
      service: "checkout",
    });
  });

  it("honours a custom prefix", async () => {
    const { meter, recorded } = fakeMeter();
    const p = pipeline({
      policies: [breaker({ slowCallMs: 100 })],
      clock: new FakeClock(),
      observers: [otel({ meter, prefix: "acme.resilience" })],
    });
    await p.execute({}, () => ({ status: 200 }));
    expect(recorded.counters.has("acme.resilience.executions")).toBe(true);
  });

  it("registers pull-based gauges that read LIVE values on each collection", async () => {
    const { meter, recorded } = fakeMeter();
    const clock = new FakeClock();
    const instrument = otel({ meter });
    const p = pipeline<{ host: string }>({
      key: (i) => i.host,
      policies: [breaker({ slowCallMs: 100, consecutiveBackstop: 1, openForMs: 5_000 })],
      clock,
      observers: [instrument],
    });

    await p.execute({ host: "a" }, () => ({ status: 200 }));
    instrument.observeGauges(p);

    expect(readGauge(recorded, "resilix.breaker.state")).toEqual([
      { value: 0, attributes: { key: "a" } },
    ]);

    // Trip host a, and add a second host. The SAME gauge callback must reflect both.
    await p
      .execute({ host: "a" }, () => {
        throw Object.assign(new Error("x"), { code: "ECONNRESET" });
      })
      .catch(() => undefined);
    await p.execute({ host: "b" }, () => ({ status: 200 }));

    const states = readGauge(recorded, "resilix.breaker.state");
    expect(states).toEqual(
      expect.arrayContaining([
        { value: 2, attributes: { key: "a" } },
        { value: 0, attributes: { key: "b" } },
      ]),
    );
  });

  it("registers gauges for each policy in the pipeline", async () => {
    const { meter, recorded } = fakeMeter();
    const instrument = otel({ meter });
    const p = pipeline({
      policies: [breaker({ slowCallMs: 100 }), bulkhead({ concurrency: 2 })],
      clock: new FakeClock(),
      observers: [instrument],
    });
    await p.execute({}, () => ({ status: 200 }));
    instrument.observeGauges(p);

    expect(recorded.gauges.has("resilix.breaker.failureRate")).toBe(true);
    expect(recorded.gauges.has("resilix.breaker.slowRate")).toBe(true);
    expect(recorded.gauges.has("resilix.bulkhead.utilisation")).toBe(true);
    expect(readGauge(recorded, "resilix.bulkhead.limit")).toEqual([
      { value: 2, attributes: { key: "default" } },
    ]);
  });

  it("a broken meter cannot break an execution", async () => {
    const meter: MeterLike = {
      createCounter: () => ({
        add: () => {
          throw new Error("collector unreachable");
        },
      }),
      createHistogram: () => ({ record: vi.fn() }),
      createObservableGauge: () => ({}),
    };
    const p = pipeline({
      policies: [breaker({ slowCallMs: 100 })],
      clock: new FakeClock(),
      observers: [otel({ meter })],
    });
    await expect(p.execute({}, () => ({ status: 200 }))).resolves.toEqual({ status: 200 });
  });
});
