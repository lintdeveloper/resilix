---
"resilix": minor
---

Initial release: the classifier, the circuit breaker, and the pipeline executor.

- **Verdict-based classification** (`classifyHttp`) — outcomes become `success` / `answered` /
  `transient` / `overload` / `timeout` / `rejected` rather than a boolean, so a `4xx` never opens a
  circuit and a `429` is a load signal without being a failure.
- **Circuit breaker** with three trip conditions: failure rate, **slow-call rate**, and a
  window-independent consecutive-failure backstop. Half-open admits a single probe by default and
  self-heals if a probe never settles.
- **Dual-bound rolling window** — bounded by both sample count and age, O(1) per call via running
  counters over preallocated typed arrays.
- **Pipeline executor** with per-key isolation, a bounded key registry (TTL + hard cap), an optional
  deadline with a lazily-created `AbortController`, and a `gate()` escape hatch for driving the state
  machines by hand.
- `snapshot()` / `hydrate()` on every policy for serverless state carry-over.
