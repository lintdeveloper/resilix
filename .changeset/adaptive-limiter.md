---
"resilix": minor
---

**The adaptive concurrency limiter.** The release this library exists for, and the thing nothing
else in npm has.

`limiter()` bounds in-flight calls to an upstream by inferring the right bound from observed
latency, rather than requiring you to know it in advance. Latency rises before errors do: the
production case behind resilix degraded from p50 0.35s to p50 10.4s at a completely flat error
rate, which a failure-rate breaker cannot see at all.

Built to `docs/specs/adaptive-limiter.md`, which was written first and gated the code.

- **Vegas** queue estimation by default (`queueUse = limit × (1 − baseline/recent)`), the choice
  both Netflix and Uber made for this problem. `gradient2` and `aimd` also available.
- **p90 via a P² streaming estimator** — O(1) time and constant memory, validated against exact
  quantiles on log-normal, bimodal, bursty and skewed inputs before being adopted.
- **Queueing rather than rejection**: calls execute below the limit, queue to 2× it, then shed
  *proportionally* to 3×. The zone bounds are factors, so they track the adapting limit.
- **429 and timeout short-circuit the control loop.** Waiting a full interval to react to an
  explicit overload signal would be perverse.
- **A 4xx is a latency sample but applies no pressure**, and our own rejections are ignored
  entirely.

Two mechanisms exist because the reference implementations do not transfer directly:

- The control loop is **driven by call settlement, not a timer**, because resilix has no timers
  by constitution. That creates a failure mode nothing upstream has to handle — clamp during an
  incident, traffic stops, stay clamped forever — so `staleAfterMs` bounds it.
- Growth is **tethered to observed concurrency** (`maxLimitFactor`, from failsafe-go). Without
  it the limit inflates to `maxLimit` whenever load is light, since no congestion is ever
  observed. The tether caps upward movement only and never pulls the limit down.
