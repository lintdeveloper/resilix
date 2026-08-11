---
"resilix": minor
---

Telemetry, the opossum compatibility layer, and a bulkhead.

- **`resilix/otel`** — OpenTelemetry instrumentation built in rather than as a plugin.
  Counters for executions, rejections and state transitions; a latency histogram; and
  pull-based gauges for breaker state/rates and bulkhead utilisation. `@opentelemetry/api`
  is an optional peer dependency, so core stays at zero dependencies, and `otel()` without a
  meter is a no-op.
- **`resilix/compat/opossum`** — a drop-in replacement, so adoption is a one-line import
  swap. Defaults preserve opossum's behaviour exactly; resilix-only features (slow-call
  tripping, the consecutive backstop) are opt-in. Unsupported options (`cache`, `coalesce`,
  `cacheTTL`) throw rather than being silently ignored.
- **`bulkhead()`** — a fixed concurrency cap, and what `capacity` maps to in the compat layer.
- **Observers** — `observers: [...]` on a pipeline, dispatched through a swallowing wrapper so
  a failing exporter can neither influence nor break an admission decision. `Policy.metrics()`
  exposes numeric gauges for pull-based collection.
