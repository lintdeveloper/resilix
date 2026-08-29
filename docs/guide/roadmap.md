# Roadmap

resilix is **pre-release**. The public API is settling but not frozen; anything user-visible
lands with a changeset and a version bump.

## Shipped

| Version | What it added |
|---|---|
| **v0.1** | verdict classifier · circuit breaker · dual-bound rolling window · key registry · pipeline executor |
| **v0.2** | `resilix/otel` · `resilix/compat/opossum` · bulkhead · observers |
| **v0.3** | adaptive concurrency limiting · P² streaming quantiles · proportional shedding |
| **v0.4** | retry with full jitter · shared retry budgets · SRE adaptive throttler · token-bucket rate limiter |
| **v0.5** | hedging with cancellation · criticality buckets · tenant fairness |
| **v0.6** | `resilix/undici` — guard the dispatcher and every call site is covered at once |

Each of v0.3–v0.5 was built to a spec written first —
[adaptive limiter](../specs/adaptive-limiter),
[retry and throttling](../specs/retry-and-throttling),
[hedging and priority](../specs/hedging-and-priority).

## Ahead

- **More adapters.** `resilix/nest` and `resilix/hono` — the same policies behind the interface
  each ecosystem already uses, on the same optional-peer model as `resilix/otel` and
  [`resilix/undici`](./undici).
- **Inbound protection.** Everything so far guards calls you *make*. The symmetric problem —
  shedding load you *receive*, before it reaches your handlers — reuses the limiter and the
  criticality buckets but needs a different integration surface.

## Not planned

- **Distributed or shared policy state.** Cross-instance ejection belongs to the service mesh;
  a shared breaker turns one bad instance into a global outage and puts a network round-trip on
  the fail-fast path. `snapshot()` / `hydrate()` cover the serverless cold-start case, which is
  what such requests are usually actually about.
  See [ADR-002](../decisions#adr-002).
- **Response caching or call coalescing.** Out of scope, and `resilix/compat/opossum` throws on
  those options rather than accepting them silently — believing responses are cached when they
  are not is worse than a clear error.

## Background

The C4 architecture and the original version plan are in
[resilix-architecture.pdf](../resilix-architecture.pdf). It is partly historical now — the specs
above are current where the two disagree.
