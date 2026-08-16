---
"resilix": patch
---

Review fixes, two of them correctness bugs in v0.5.

- **Hedging took the first settled result, including a rejection.** A hedge that failed fast beat
  an original that would have succeeded, so hedging made reliability *worse* — two copies double
  the exposure to a transient failure and the quicker error wins. It now takes the first
  **success**, and only rejects when every copy has failed.
- **Tenant fairness was charged at `admit()`.** That billed a tenant for calls an inner policy
  refused, and since usage is what gets you shed, it was a feedback loop inside the fairness
  mechanism itself. `Observation` now carries `tenant` so usage is charged at `settle()`.
- The limiter's overhead assertion is gated behind `pnpm test:perf`. Measured under v8 coverage
  it reported ~2,100 ns against a 1,000 ns budget; uninstrumented the same loop is **~57 ns**. A
  wall-clock assertion under instrumentation measures the instrumentation, and it was failing CI
  for a non-problem.
- `snapshot` / `hydrate` / `metrics` / `reset` are now tested for every v0.4 and v0.5 policy —
  they had shipped untested, which is the serverless surface and where ADR-005 already found a
  bug.
