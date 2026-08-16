---
"resilix": minor
---

**v0.5 — hedging, criticality, and tenant fairness.**

Built to `docs/specs/hedging-and-priority.md`.

- **`hedge`** — races a second attempt against a slow first one and cancels the loser. The delay
  defaults to the **measured p95** for that key rather than a constant, because Dean & Barroso's
  ~2% overhead follows from hedging at a high percentile; a stale constant loses the property
  that made hedging cheap. `idempotent: true` is **required**, not documented — a hedge sends the
  same request twice, and on a payment that is a double charge.
- **Criticality** — Netflix's four buckets (`critical` / `degraded` / `bestEffort` / `bulk`),
  shed progressively as pressure rises. Their incident is the case for it: a 12× prefetch spike,
  over half of all requests throttled, and user-initiated availability still above 99.4%.
- **Tenant fairness** — relative rather than quota-based. Under pressure the tenant furthest
  above `admitted / activeTenants` is shed first, and heaviness decays so nobody is punished
  forever.

`Policy.admit()` now takes an optional `AdmissionRequest` carrying priority and tenant. Breaking
for anyone who implemented a custom policy; additive in behaviour, since a policy that ignores
the argument behaves exactly as before.
