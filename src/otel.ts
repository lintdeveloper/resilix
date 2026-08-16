/**
 * OpenTelemetry instrumentation for resilix.
 *
 * Built in, not a plugin — deliberately. Under 1% of opossum users instrument their
 * breakers (`opossum-prometheus` sits at ~7.8k downloads/week against opossum's ~1.19M),
 * which means almost nobody has data at the moment they need it. Polly v8's most-cited
 * improvement over v7 was making telemetry first-class rather than bolt-on.
 *
 * `@opentelemetry/api` is an OPTIONAL peer dependency: the core package stays at zero
 * dependencies, and this subpath is the only thing that needs it.
 *
 *   import { pipeline, breaker } from "resilix";
 *   import { otel } from "resilix/otel";
 *
 *   const api = pipeline({ policies: [breaker({ slowCallMs: 3000 })], observers: [otel()] });
 *   otel().observeGauges(api);   // registers pull-based gauges
 */
import type { Observer } from "./observer.ts";
import type { Pipeline } from "./pipeline.ts";

/**
 * The slice of `@opentelemetry/api`'s Meter that we use, declared structurally.
 *
 * Declared here rather than imported so this module type-checks with or without the OTel
 * packages installed, and so any metrics backend with the same shape can be passed in.
 */
export interface MeterLike {
  createCounter(name: string, options?: { description?: string; unit?: string }): CounterLike;
  createHistogram(name: string, options?: { description?: string; unit?: string }): HistogramLike;
  createObservableGauge(
    name: string,
    options?: { description?: string; unit?: string },
  ): ObservableGaugeLike;
  addBatchObservableCallback?(
    callback: (result: BatchObservableResultLike) => void,
    gauges: ObservableGaugeLike[],
  ): void;
}

export interface CounterLike {
  add(value: number, attributes?: Record<string, string | number>): void;
}

export interface HistogramLike {
  record(value: number, attributes?: Record<string, string | number>): void;
}

export interface ObservableGaugeLike {
  addCallback?(callback: (result: ObservableResultLike) => void): void;
}

export interface ObservableResultLike {
  observe(value: number, attributes?: Record<string, string | number>): void;
}

export interface BatchObservableResultLike {
  observe(
    gauge: ObservableGaugeLike,
    value: number,
    attributes?: Record<string, string | number>,
  ): void;
}

export interface OtelOptions {
  /**
   * A Meter from `@opentelemetry/api`, e.g. `metrics.getMeter('my-service')`.
   * Omit to get a no-op observer, which is what you want in tests.
   */
  meter?: MeterLike;
  /** Instrument name prefix. Default `resilix`. */
  prefix?: string;
  /** Extra attributes attached to every measurement, e.g. `{ service: 'checkout' }`. */
  attributes?: Record<string, string | number>;
}

export interface OtelObserver extends Observer {
  /**
   * Register pull-based gauges for a pipeline: breaker state and rates, bulkhead
   * utilisation, and (from v0.3) limiter limit / inflight / queued.
   *
   * Pull-based on purpose. The alternative — pushing a gauge on every state change —
   * puts exporter work on the control path, which ADR-010 forbids.
   */
  observeGauges(pipeline: Pick<Pipeline<never>, "metrics">): void;
}

const NOOP_COUNTER: CounterLike = { add: () => {} };
const NOOP_HISTOGRAM: HistogramLike = { record: () => {} };

/**
 * Build an observer that records resilix activity to OpenTelemetry.
 *
 * Instruments:
 *   resilix.executions          counter    {key, verdict}
 *   resilix.execution.duration  histogram  {key, verdict}   unit: ms
 *   resilix.rejections          counter    {key, reason, policy}
 *   resilix.state.transitions   counter    {key, from, to, reason}
 *   resilix.<policy>.<gauge>    gauge      {key}            via observeGauges()
 */
export function otel(options: OtelOptions = {}): OtelObserver {
  const prefix = options.prefix ?? "resilix";
  const base = options.attributes ?? {};
  const meter = options.meter;

  const executions = meter
    ? meter.createCounter(`${prefix}.executions`, {
        description: "Executions that were admitted and settled, by verdict",
      })
    : NOOP_COUNTER;

  const duration = meter
    ? meter.createHistogram(`${prefix}.execution.duration`, {
        description: "Settled execution latency",
        unit: "ms",
      })
    : NOOP_HISTOGRAM;

  const rejections = meter
    ? meter.createCounter(`${prefix}.rejections`, {
        description: "Executions refused by a policy, by reason",
      })
    : NOOP_COUNTER;

  const transitions = meter
    ? meter.createCounter(`${prefix}.state.transitions`, {
        description: "Policy state transitions, by reason",
      })
    : NOOP_COUNTER;

  return {
    onExecution: (event) => {
      const attributes = { ...base, key: event.key, verdict: event.verdict };
      executions.add(1, attributes);
      duration.record(event.latencyMs, attributes);
    },

    onRejection: (event) => {
      rejections.add(1, { ...base, key: event.key, reason: event.reason, policy: event.policy });
    },

    onStateChange: (event) => {
      transitions.add(1, {
        ...base,
        key: event.key,
        from: event.from,
        to: event.to,
        reason: event.reason ?? "unknown",
      });
    },

    observeGauges: (target) => {
      if (!meter) return;
      // One gauge per (policy, metric) pair, discovered on first collection. Attributes
      // carry the key, so cardinality is bounded by the registry's own key cap.
      const gauges = new Map<string, ObservableGaugeLike>();

      const gaugeFor = (policy: string, metric: string): ObservableGaugeLike => {
        const name = `${prefix}.${policy}.${metric}`;
        const existing = gauges.get(name);
        if (existing) return existing;
        const created = meter.createObservableGauge(name, {
          description: `resilix ${policy} ${metric}`,
        });
        gauges.set(name, created);
        return created;
      };

      // Seed the gauges from whatever exists now, then keep each one's callback reading
      // live values on every collection cycle.
      for (const row of target.metrics()) {
        for (const metric of Object.keys(row.values)) {
          const gauge = gaugeFor(row.policy, metric);
          gauge.addCallback?.((result) => {
            for (const current of target.metrics()) {
              if (current.policy !== row.policy) continue;
              const value = current.values[metric];
              if (typeof value === "number") {
                result.observe(value, { ...base, key: current.key });
              }
            }
          });
        }
      }
    },
  };
}
