---
"resilix": minor
---

Audit against the advertised use cases, and fix what it found.

The documented use-case table was written before the implementation was checked against it.
The audit found the headline case — LLM and inference APIs — was actively broken by the
library's own documented defaults.

- **`ctx.mark()`** — a call's latency defaults to total duration, which is wrong for anything
  streaming. A healthy 45s completion whose first token arrives in 300ms was being judged slow,
  so the slow-call breaker opened on a perfectly good upstream. `ctx.mark()` records latency at
  the caller's chosen moment (time to first token); total duration remains the default.
- **`breaker.stats().starved`** and a `resilix.breaker.starved` gauge — a window bounded by age
  holds at most `maxAgeMs / callDuration` samples, so an upstream slower than
  `maxAgeMs / minCalls` (15s at the defaults) can never reach `minCalls` and both rate
  conditions are silently inert. Previously invisible; now reportable and alertable.
- **`classifySql`** — `classifyHttp` classified a unique-violation as `transient`, so a burst of
  duplicate inserts looked like a database outage. The SQL classifier maps constraint and syntax
  errors to `answered`, pool exhaustion / deadlock / serialization failure to `overload`, and
  only genuine unavailability to `transient`. Covers SQLSTATE and Prisma's own codes.
- **`retryAfterFrom`** and `ExecutionEvent.retryAfterMs` — `parseRetryAfter` existed but nothing
  ever called it, so the documented "honours Retry-After" was false. The header is now read from
  `Response`, axios and node:http shapes on an `overload` outcome and surfaced to observers,
  ready for the v0.4 retry policy. Not parsed on the healthy path.
