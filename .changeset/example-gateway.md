---
"resilix": patch
---

Adds a runnable example: `pnpm example:gateway`.

A simulated LLM provider degrades from ~140ms to seconds **at a flat error rate**, starts
returning `429`s, then recovers, while ~25 requests/second flow through a full pipeline across
three tenants. It prints a per-second table so the adaptation is visible rather than described:
between 7s and 19s latency rises **23× while failures stay at 2**, and the limiter walks
concurrency from 25 down to 5 and sheds the excess before the timeouts start.

Covers policy ordering, the verdict model, per-model isolation keys, tenant fairness, criticality
shedding, a shared retry budget, `ctx.mark()` for time-to-first-token, and `RejectedError.reason`.

It is type-checked and run in CI (nine seconds at 4× speed) — an example that does not compile is
worse than no example, and it is the first code anyone reads.
