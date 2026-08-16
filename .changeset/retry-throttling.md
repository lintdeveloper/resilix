---
"resilix": minor
---

**v0.4 — retry with budgets, adaptive throttling, and rate limiting.**

Built to `docs/specs/retry-and-throttling.md`. All eight acceptance criteria pass, including
reproducing Google SRE's amplification numbers: unbudgeted retries multiply load ~3x, a 10%
budget holds it near 1.1x.

- **`retry`** — full jitter by default, `random(0, min(cap, base·2^n))`. AWS measured no-jitter
  as the "clear loser" and equal jitter as "much longer"; full costs the upstream less work than
  decorrelated at slightly more elapsed time, and a library guarding someone else's service
  should not spend their capacity to shave its own tail. All four strategies ship.
- **`budget`** — a *shared* object, because a per-policy cap cannot bound system-wide
  amplification. Pass one instance to every pipeline in the process.
- **`throttler`** — Google SRE client-side throttling, `max(0, (requests − K·accepts) /
  (requests + 1))` with K=2 over a two-minute window. Unlike a breaker it sheds a *fraction*, so
  traffic keeps flowing and recovery is observed continuously.
- **`rateLimit`** — a token bucket that refills continuously, so straddling an interval boundary
  cannot yield 2x the limit.

The verdict model does real work here: `answered` is never retried (the upstream worked, the
caller was wrong) and `rejected` is never retried (we refused it ourselves). A
boolean-predicate library retries both by default.

Two decisions worth knowing:

- **resilix now injects randomness**, which it deliberately never had. Full jitter and
  probabilistic throttling exist to *decorrelate* clients, so a deterministic approximation
  produces exactly the thundering herd they prevent. `Random` is injected like `Clock`: seeded in
  tests, lazy at runtime so Workers still works.
- **`timeoutMs` now bounds the whole retry sequence, not each attempt.** Most libraries bound
  each attempt, so a caller asking for 50ms can wait `maxAttempts × (50ms + backoff)`. A deadline
  the caller cannot see is not a deadline.
